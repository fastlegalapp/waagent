'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const logger = require('../logger');
const drive = require('./tools/drive');
const lists = require('../db/lists');
const settingsDb = require('../db/settings');

// Pull an image URL out of a list row's fields (an image/photo column, or any
// value that looks like an image URL).
function imageUrlOf(fields) {
  if (!fields || typeof fields !== 'object') return null;
  for (const k of Object.keys(fields)) {
    if (/^(image|images|photo|photos|pic|picture|img|thumbnail|url|link)$/i.test(k)) {
      const v = String(fields[k] || '');
      if (/^https?:\/\//i.test(v)) return v;
    }
  }
  for (const k of Object.keys(fields)) {
    const v = String(fields[k] || '');
    if (/^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(v)) return v;
  }
  return null;
}

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

// Cache one client per API key so we don't rebuild it per message.
const anthropicClients = new Map();
function anthropicClientFor(apiKey) {
  if (!anthropicClients.has(apiKey)) anthropicClients.set(apiKey, new Anthropic({ apiKey }));
  return anthropicClients.get(apiKey);
}

const deepseekClients = new Map();
function deepseekClientFor(apiKey) {
  if (!deepseekClients.has(apiKey)) {
    deepseekClients.set(apiKey, new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL }));
  }
  return deepseekClients.get(apiKey);
}

// Selectable chatting styles the owner picks in Settings.
const STYLES = {
  friendly:
    'Friendly & casual — like texting a friend. Warm, relaxed, short, contractions, the odd emoji. Most replies one short line.',
  professional:
    'Professional but warm — polite, clear and human, courteous without being stiff. Short and to the point.',
  short:
    'Very short & snappy — a few words whenever possible. Minimal, fast, no fluff.',
  detailed:
    'Helpful & thorough — still casual and human, but happy to explain properly when it helps.',
  playful:
    'Playful & upbeat — light humour, friendly energy and emojis, while staying respectful.',
  formal:
    'Formal & respectful — courteous, complete sentences, no slang or emojis.',
};
const STYLE_KEYS = Object.keys(STYLES);

function buildFaqBlock(owner) {
  const faqs = Array.isArray(owner.faqs)
    ? owner.faqs.filter((f) => f && f.q && f.a)
    : [];
  if (faqs.length === 0) return '';
  const lines = faqs.map((f) => `• ${f.q} → ${f.a}`).join('\n');
  return (
    'Known facts you can answer common questions with. When a client asks about ' +
    'one of these, use the fact but say it naturally in your own words and the ' +
    "client's language — never paste it verbatim or read out a list. If a client " +
    "asks about something not here and you don't truly know it, escalate instead " +
    'of guessing:\n' +
    lines
  );
}

// Past Q→A pairs retrieved from the owner's OTHER chats — examples of how they
// have answered similar questions before. The agent uses them as a guide.
function buildExamplesBlock(examples) {
  const ex = Array.isArray(examples) ? examples.filter((e) => e && e.question && e.answer) : [];
  if (ex.length === 0) return '';
  const clip = (s) => String(s).replace(/\s+/g, ' ').slice(0, 280);
  const lines = ex
    .map((e, i) => `${i + 1}. Someone asked: "${clip(e.question)}"\n   You answered: "${clip(e.answer)}"`)
    .join('\n');
  return (
    'How YOU have handled similar questions before, from your past chats with ' +
    'other clients. Use these as a guide for what to say and how — adapt to THIS ' +
    "client and the current conversation, never paste them verbatim, and if they " +
    "don't fit, ignore them:\n" +
    lines
  );
}

// Directory of the owner's custom data lists, so the agent knows what it can
// look up (and the per-list instructions on how to use each).
function buildListsBlock(owner) {
  const ls = Array.isArray(owner.lists) ? owner.lists : [];
  if (ls.length === 0) return '';
  const lines = ls
    .map((l) => `• ${l.name} (${l.count} entries)${l.instructions ? ` — ${l.instructions}` : ''}`)
    .join('\n');
  return (
    'You have these data lists. Use the lookup_list tool to find specific entries ' +
    '(a product, price, customer, order, due date, etc.) before answering — never ' +
    "invent items that aren't in a list. Follow each list's instructions:\n" +
    lines
  );
}

function buildSystemPrompt(owner, examples) {
  const name = owner.name || 'the owner';
  const style = STYLES[owner.style] || STYLES.friendly;
  return [
    `You are texting on WhatsApp as ${name}${owner.business ? ` (${owner.business})` : ''}.`,
    owner.description ? `What you do: ${owner.description}` : '',
    '',
    buildFaqBlock(owner),
    '',
    buildListsBlock(owner),
    '',
    buildExamplesBlock(examples),
    '',
    `Your chatting style: ${style}`,
    owner.learnedStyle
      ? `How ${name} actually writes, learned from their real past chats — match this closely: ${owner.learnedStyle}`
      : '',
    owner.custom
      ? `IMPORTANT — ${name}'s own instructions on how to chat (follow these above all): ${owner.custom}`
      : '',
    '',
    'This is an ongoing WhatsApp conversation — the chat history so far is shown',
    'below. Read it carefully and reply IN CONTEXT: remember what the client',
    'already told you (their name, what they need, prices/dates/details mentioned),',
    'pick up where you left off, and never re-ask something they have already',
    'answered or repeat yourself. If they refer to "it"/"that"/"the same", use the',
    'history to know what they mean.',
    '',
    'Always:',
    '- Sound like a real person on WhatsApp, never a bot or "assistant". Use contractions.',
    '- Mirror the other person\'s language and tone. If they write in Hindi or Hinglish,',
    '  reply naturally in Hindi/Hinglish; same for any other language.',
    '- Match your length to the conversation and your style above — usually short.',
    '- No "How can I help you today?", no formal greetings/sign-offs, no bullet lists.',
    '  Don\'t say you\'re an AI or assistant.',
    '',
    'Honesty: never invent specifics (prices, dates, details) — if unsure, escalate with',
    `a short note like "let me check and get right back to you". No binding legal,`,
    `financial, or medical advice — escalate anything needing ${name}'s real judgement.`,
    owner.hasPaymentQr
      ? 'PAYMENT: A payment QR code is on file. Whenever the client needs to pay, asks how '
        + 'to pay, or you ask them for payment, you MUST actually send it by calling the '
        + 'send_payment_qr tool (put the amount in the caption). Do NOT just say you are '
        + 'sharing the QR or describe it in text — calling the tool is the only thing that '
        + 'sends the image. After it sends, tell them to scan and pay.'
      : 'PAYMENT: No payment QR has been uploaded yet, so you cannot send one. If the client '
        + 'wants to pay, take the order and tell them the owner will share payment details.',
    'Tools: look up products/prices/customers/dues → lookup_list. Client wants to',
    'see a product → send_photo. Collecting payment / "how do I pay" → send_payment_qr.',
    'Client confirmed an order → record_order. Client says they have paid (or sends',
    'a payment screenshot that shows a SUCCESSFUL transaction) → mark_order_paid,',
    'then confirm warmly and tell them what happens next. If a screenshot looks',
    'failed, pending, edited, or the amount is wrong, do NOT mark paid — point out',
    'the issue politely or escalate. Document requests → find_document. Spam / wrong',
    'number → do_not_reply. You can both call a tool AND send a reply.',
    '',
    'Reply with just the text to send, or call exactly one tool.',
  ]
    .filter((l) => l != null && l !== '')
    .join('\n');
}

const tools = [
  {
    name: 'find_document',
    description:
      'Look up a document the client has requested (contract, invoice, form) so ' +
      'it can be sent to them. Use when the client asks for a file.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the client is asking for.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Flag this conversation for the owner. Use when unsure, the request needs ' +
      'the owner\'s judgement, or you cannot safely answer.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this needs a human.' },
        reply_to_client: {
          type: 'string',
          description: 'A short holding message to send the client now.',
        },
      },
      required: ['reason', 'reply_to_client'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_list',
    description:
      "Search the owner's data lists (products, services, customers, leads, " +
      'orders, schedules, prices, due dates, etc.) for entries matching a query. ' +
      'Use this to get REAL details before answering — a product price/availability, ' +
      "a customer's due date, etc. Returns matching rows.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look up — a product name, customer name/number, or keyword.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_photo',
    description:
      "Send the client a photo of a product/item from the owner's lists. Use when " +
      'the client asks to see a product, its photo/picture/image, or how it looks. ' +
      'Looks the item up by query and sends its image if one is on file.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Which product/item to show (name or keyword).' },
        caption: { type: 'string', description: 'A short caption to send with the photo.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_payment_qr',
    description:
      "Send the owner's payment QR code so the client can pay. Use when collecting " +
      'payment or when the client asks how to pay. Only works if the owner uploaded a QR.',
    input_schema: {
      type: 'object',
      properties: {
        caption: { type: 'string', description: 'A short caption, e.g. the amount to pay.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'record_order',
    description:
      'Record an order the client placed so the owner can fulfil it. Use once the ' +
      'client confirms what they want to buy.',
    input_schema: {
      type: 'object',
      properties: {
        items: { type: 'string', description: 'What they ordered (products and quantities).' },
        total: { type: 'string', description: 'Total amount, if known.' },
        customer: { type: 'string', description: "Client's name, if known." },
        notes: { type: 'string', description: 'Any delivery address or special instructions.' },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_order_paid',
    description:
      "Mark this client's most recent order as paid. Use ONLY when the client " +
      "clearly says they have paid / done the payment / sent the money. The owner " +
      'is notified to verify.',
    input_schema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Any payment reference the client gave (txn id, UTR, time).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'do_not_reply',
    description:
      'Send nothing. Use for spam, wrong numbers, hostile messages, or anything ' +
      'that clearly does not warrant a response.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why no reply is appropriate.' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

// OpenAI/DeepSeek function-calling format for the same tools.
const openaiTools = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

function safeParse(json) {
  try {
    return JSON.parse(json || '{}');
  } catch (_) {
    return {};
  }
}

async function runTool(name, input, settings, actions = {}) {
  if (name === 'find_document') {
    return JSON.stringify(await drive.findDocument(settings, input.query));
  }
  if (name === 'lookup_list') {
    try {
      const results = await lists.searchItems(settings.userId, input.query, 8);
      return JSON.stringify({ results });
    } catch (err) {
      return JSON.stringify({ results: [], error: 'lookup failed' });
    }
  }
  if (name === 'send_photo') {
    try {
      const matches = await lists.searchItems(settings.userId, input.query, 6);
      const hit = matches.map((m) => m.fields).find((f) => imageUrlOf(f));
      const url = hit ? imageUrlOf(hit) : null;
      if (!url) return JSON.stringify({ sent: false, reason: 'no photo on file for that item' });
      if (!actions.sendImage) return JSON.stringify({ sent: false, reason: 'cannot send right now' });
      await actions.sendImage({ url }, input.caption || '');
      return JSON.stringify({ sent: true });
    } catch (err) {
      return JSON.stringify({ sent: false, reason: 'photo send failed' });
    }
  }
  if (name === 'send_payment_qr') {
    try {
      const row = await settingsDb.getRaw(settings.userId);
      const qr = row && row.payment_qr;
      if (!qr) return JSON.stringify({ sent: false, reason: 'owner has not set a payment QR' });
      if (!actions.sendImage) return JSON.stringify({ sent: false, reason: 'cannot send right now' });
      await actions.sendImage({ base64: qr }, input.caption || 'Scan this QR to pay 🙏');
      return JSON.stringify({ sent: true });
    } catch (err) {
      return JSON.stringify({ sent: false, reason: 'qr send failed' });
    }
  }
  if (name === 'record_order') {
    try {
      const saved = await lists.recordOrder(settings.userId, {
        items: input.items,
        total: input.total,
        customer: input.customer || actions.customerNumber || '',
        notes: input.notes,
      });
      return JSON.stringify({ recorded: true, order: saved });
    } catch (err) {
      return JSON.stringify({ recorded: false, reason: 'could not record the order' });
    }
  }
  if (name === 'mark_order_paid') {
    try {
      const order = await lists.markOrderPaid(settings.userId, actions.customerNumber, input.note);
      if (!order) return JSON.stringify({ marked: false, reason: 'no open order found for this client' });
      if (actions.notifyOwner) {
        const what = order.fields && order.fields.items ? ` for: ${order.fields.items}` : '';
        await actions.notifyOwner(
          `💰 ${actions.customerNumber} says they've paid${what}. I've marked the order as PAID — please verify against your account.`,
        );
      }
      return JSON.stringify({ marked: true, order });
    } catch (err) {
      return JSON.stringify({ marked: false, reason: 'could not update the order' });
    }
  }
  return JSON.stringify({ ok: true });
}

const EXHAUSTED = {
  action: 'escalate',
  reason: 'Could not resolve the request automatically',
  text: 'Thanks for your message — let me check and get back to you shortly.',
};

// ── Anthropic (Claude) backend ───────────────────────────────────────────────
async function decideAnthropic(settings, history, incomingText, examples, actions) {
  const client = anthropicClientFor(settings.ai.apiKey);
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: incomingText },
  ];

  for (let i = 0; i < 4; i += 1) {
    const response = await client.messages.create(
      {
        model: settings.ai.model,
        // Roomy enough that adaptive thinking (which draws from max_tokens) can
        // reason and still leave space for the actual reply — 400 risked an
        // empty/truncated message once thinking ate the budget.
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        system: buildSystemPrompt(settings.owner, examples),
        tools,
        messages,
      },
      { timeout: 60_000 },
    );

    if (response.stop_reason === 'refusal') {
      return { action: 'escalate', reason: 'AI declined to respond', text: '' };
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { action: 'reply', text };
    }

    const escalate = toolUses.find((t) => t.name === 'escalate_to_human');
    if (escalate) {
      return {
        action: 'escalate',
        reason: escalate.input.reason,
        text: (escalate.input.reply_to_client || '').trim(),
      };
    }
    const skip = toolUses.find((t) => t.name === 'do_not_reply');
    if (skip) return { action: 'ignore', reason: skip.input.reason };

    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const t of toolUses) {
      const out = await runTool(t.name, t.input, settings, actions);
      toolResults.push({ type: 'tool_result', tool_use_id: t.id, content: out });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return EXHAUSTED;
}

// ── DeepSeek (OpenAI-compatible) backend ─────────────────────────────────────
async function decideDeepSeek(settings, history, incomingText, examples, actions) {
  const client = deepseekClientFor(settings.ai.apiKey);
  const messages = [
    { role: 'system', content: buildSystemPrompt(settings.owner, examples) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: incomingText },
  ];

  for (let i = 0; i < 4; i += 1) {
    const resp = await client.chat.completions.create(
      {
        model: settings.ai.model,
        max_tokens: 1024,
        tools: openaiTools,
        tool_choice: 'auto',
        messages,
      },
      { timeout: 60_000 },
    );

    const msg = resp.choices?.[0]?.message;
    if (!msg) return { action: 'escalate', reason: 'Empty AI response', text: '' };

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      return { action: 'reply', text: (msg.content || '').trim() };
    }

    const escalate = calls.find((c) => c.function?.name === 'escalate_to_human');
    if (escalate) {
      const a = safeParse(escalate.function.arguments);
      return { action: 'escalate', reason: a.reason || '', text: (a.reply_to_client || '').trim() };
    }
    const skip = calls.find((c) => c.function?.name === 'do_not_reply');
    if (skip) {
      const a = safeParse(skip.function.arguments);
      return { action: 'ignore', reason: a.reason || '' };
    }

    messages.push(msg);
    for (const c of calls) {
      const out = await runTool(c.function.name, safeParse(c.function.arguments), settings, actions);
      messages.push({ role: 'tool', tool_call_id: c.id, content: out });
    }
  }
  return EXHAUSTED;
}

/**
 * Decide how to handle one incoming client message for a given user. Routes to
 * the user's chosen AI provider.
 *
 * @param {object} settings  resolved user config — settings.ai = {provider, apiKey, model}
 * @param {Array<{role,content}>} history
 * @param {string} incomingText
 * @returns {Promise<{action:'reply'|'escalate'|'ignore', text?:string, reason?:string}>}
 */
const FRIENDLY_FALLBACK = "hey, give me a moment — I'll get right back to you 🙏";

// Last-resort reply with no tools and no thinking. Works even on models that
// don't support function calling (e.g. deepseek-reasoner) and rides out most
// transient API errors, so the client always gets a real answer.
async function plainReply(settings, history, incomingText, examples) {
  const sys = buildSystemPrompt(settings.owner, examples);
  const hist = history.map((m) => ({ role: m.role, content: m.content }));
  if (settings.ai.provider === 'deepseek') {
    const resp = await deepseekClientFor(settings.ai.apiKey).chat.completions.create(
      {
        model: settings.ai.model,
        max_tokens: 1024,
        messages: [{ role: 'system', content: sys }, ...hist, { role: 'user', content: incomingText }],
      },
      { timeout: 60_000 },
    );
    return (resp.choices?.[0]?.message?.content || '').trim();
  }
  const resp = await anthropicClientFor(settings.ai.apiKey).messages.create(
    {
      model: settings.ai.model,
      max_tokens: 1024,
      system: sys,
      messages: [...hist, { role: 'user', content: incomingText }],
    },
    { timeout: 60_000 },
  );
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// Study the owner's real past messages and produce a short style guide the
// agent follows to sound like them. Uses the owner's own API key.
async function learnStyle(settings, samples) {
  if (!settings?.ai?.apiKey) throw new Error('No API key');
  const numbered = samples
    .slice(0, 120)
    .map((s, i) => `${i + 1}. ${String(s).replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  const prompt =
    `Below are real WhatsApp messages that ${settings.owner.name} sent to their clients. ` +
    `Study how they write and produce a SHORT style guide (5-8 short lines) so an assistant can sound exactly like them.\n` +
    `Cover: language (English / Hindi / Hinglish / mix), tone, typical message length, common greetings and sign-offs, ` +
    `favourite words or phrases, emoji habits, capitalisation/punctuation quirks.\n` +
    `Write it as direct instructions ("Use…", "Keep…", "Avoid…"). Only describe what you actually see; do not invent.\n\n` +
    `Messages:\n${numbered}`;

  if (settings.ai.provider === 'deepseek') {
    const resp = await deepseekClientFor(settings.ai.apiKey).chat.completions.create(
      { model: settings.ai.model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] },
      { timeout: 60_000 },
    );
    return (resp.choices?.[0]?.message?.content || '').trim();
  }
  const resp = await anthropicClientFor(settings.ai.apiKey).messages.create(
    { model: settings.ai.model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] },
    { timeout: 60_000 },
  );
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// Compose a short, natural follow-up nudge for a client who went quiet, in the
// owner's style. No tools — just the message text (or '' to skip).
async function composeFollowup(settings, history) {
  if (!settings?.ai?.apiKey) return '';
  const instruction =
    'This client has not replied for a while. Write ONE short, friendly follow-up ' +
    'to gently check in — like a real person nudging them, casual and warm. Just the message, nothing else.';
  try {
    return (await plainReply(settings, history, instruction)) || '';
  } catch (err) {
    logger.error({ err: err.message, userId: settings.userId }, 'follow-up compose failed');
    return '';
  }
}

// The owner replied (in their self-chat) telling the agent how to answer a
// client. Rather than forwarding it verbatim, understand the owner's intent and
// compose a natural client-facing message in the owner's style and the client's
// language. Falls back to the owner's text as-is if the AI is unavailable so the
// message always gets through.
async function composeFromOwner(settings, history, ownerNote) {
  const note = (ownerNote || '').trim();
  if (!note || !settings?.ai?.apiKey) return note;
  const directive =
    '[The owner just told you privately how to answer this client. The line below ' +
    'is the owner speaking to YOU, not a message from the client. Write ONE natural ' +
    "WhatsApp message to the client that conveys what the owner means, in the client's " +
    "language and the owner's usual style. Do not add any facts, prices, dates or " +
    'promises the owner did not state, and do not mention the owner or these ' +
    'instructions. Reply with only the message to send.]\n\n' +
    `Owner: ${note}`;
  try {
    const text = await plainReply(settings, history, directive);
    return (text && text.trim()) || note;
  } catch (err) {
    logger.error({ err: err.message, userId: settings.userId }, 'owner-relay compose failed');
    return note; // fall back to sending the owner's text verbatim
  }
}

// Look at an image the client sent (e.g. a payment screenshot) and return a
// short description. Vision is Claude-only for now; returns null on other
// providers or any error, so the caller can fall back gracefully.
async function analyzeImage(settings, media) {
  if (!settings?.ai?.apiKey || !media?.base64) return null;
  if (settings.ai.provider !== 'anthropic') return null;
  const mime = /^image\/(png|jpe?g|webp|gif)$/i.test(media.mime || '') ? media.mime : 'image/jpeg';
  try {
    const resp = await anthropicClientFor(settings.ai.apiKey).messages.create(
      {
        model: settings.ai.model,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: media.base64 } },
              {
                type: 'text',
                text:
                  'Describe this image in 1-3 short sentences. If it is a payment / ' +
                  'UPI / bank transaction screenshot, state clearly: the amount, who it ' +
                  'was paid to, the status (successful / failed / pending), the reference ' +
                  'or UTR number, and the date — exactly as shown. If anything is unclear ' +
                  'or looks edited, say so.',
              },
            ],
          },
        ],
      },
      { timeout: 60_000 },
    );
    return (
      resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim() || null
    );
  } catch (err) {
    logger.error({ err: err.message, userId: settings.userId }, 'image analysis failed');
    return null;
  }
}

async function decide(settings, history, incomingText, examples, actions) {
  try {
    return settings.ai.provider === 'deepseek'
      ? await decideDeepSeek(settings, history, incomingText, examples, actions)
      : await decideAnthropic(settings, history, incomingText, examples, actions);
  } catch (err) {
    logger.error(
      { err: err.message, userId: settings.userId, provider: settings.ai.provider },
      'agent decide failed — falling back to a plain reply',
    );
    // The full tool/thinking call failed (model/tool incompatibility, transient
    // API error, timeout). Try a plain reply so the client still gets answered.
    try {
      const text = await plainReply(settings, history, incomingText, examples);
      if (text) return { action: 'reply', text };
    } catch (err2) {
      logger.error({ err: err2.message, userId: settings.userId }, 'plain reply also failed');
    }
    return { action: 'escalate', reason: 'AI unavailable', text: FRIENDLY_FALLBACK };
  }
}

// Make a tiny live call to verify the user's saved key for the active provider
// is present, decryptable, and valid. Used by the dashboard "Test key" button.
async function testKey(settings) {
  if (!settings?.ai?.apiKey) {
    return { ok: false, error: `No usable API key for provider "${settings?.ai?.provider}". If you did save one, it may not have persisted (check the database volume) or ENCRYPTION_KEY changed.` };
  }
  try {
    if (settings.ai.provider === 'deepseek') {
      await deepseekClientFor(settings.ai.apiKey).chat.completions.create({
        model: settings.ai.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } else {
      await anthropicClientFor(settings.ai.apiKey).messages.create({
        model: settings.ai.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    }
    return { ok: true, provider: settings.ai.provider, model: settings.ai.model };
  } catch (err) {
    return { ok: false, provider: settings.ai.provider, error: err.message };
  }
}

module.exports = {
  decide,
  analyzeImage,
  runTool,
  testKey,
  learnStyle,
  composeFollowup,
  composeFromOwner,
  STYLE_KEYS,
};
