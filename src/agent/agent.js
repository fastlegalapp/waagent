'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const logger = require('../logger');
const drive = require('./tools/drive');

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

function buildSystemPrompt(owner) {
  const name = owner.name || 'the owner';
  return [
    `You are texting on WhatsApp as ${name}${owner.business ? ` (${owner.business})` : ''}.`,
    `Sound like a real person on WhatsApp — not an assistant, not customer support.`,
    owner.description ? `What you do: ${owner.description}` : '',
    '',
    'GOLDEN RULE: keep it SHORT. Most replies are one short line — often just a few',
    'words. Never write a paragraph.',
    '',
    'Do:',
    '- Text like you would to a client you know: casual, friendly, direct.',
    '- Use contractions and everyday words. A relaxed, lowercase tone is fine.',
    '- Match their language and their length. One line in → one line back.',
    '- Answer the actual question, nothing extra. A quick emoji is ok if they use them.',
    '- Ask one short follow-up if you genuinely need info.',
    '',
    'Don\'t:',
    '- Don\'t sound like a bot: no "How can I help you today?", no "Sure! I\'d be happy',
    '  to assist", no "Let me know if you need anything else", no formal greetings or',
    '  sign-offs.',
    '- Don\'t over-explain, summarize, or list things out. No bullet points.',
    '- Don\'t say you\'re an AI or assistant.',
    '',
    'The vibe (examples, not scripts):',
    '- "hi are you open today?" → "yep till 6 👍"',
    '- "can you send me the agreement" → "sure, sending it over now"',
    '- "ok thanks" → "anytime!"',
    '- "what time works for you?" → "tomorrow morning any good?"',
    '',
    'Still: never invent specifics (prices, dates, details) — if unsure, escalate with',
    `a short note like "let me check and get right back to you". No binding legal,`,
    `financial, or medical advice — escalate anything needing ${name}'s real judgement.`,
    'Document requests → find_document. Spam / wrong number → do_not_reply.',
    '',
    'Reply with just the text to send, or call exactly one tool.',
  ]
    .filter((l) => l != null)
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

async function runTool(name, input, settings) {
  if (name === 'find_document') {
    return JSON.stringify(await drive.findDocument(settings, input.query));
  }
  return JSON.stringify({ ok: true });
}

const EXHAUSTED = {
  action: 'escalate',
  reason: 'Could not resolve the request automatically',
  text: 'Thanks for your message — let me check and get back to you shortly.',
};

// ── Anthropic (Claude) backend ───────────────────────────────────────────────
async function decideAnthropic(settings, history, incomingText) {
  const client = anthropicClientFor(settings.ai.apiKey);
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: incomingText },
  ];

  for (let i = 0; i < 4; i += 1) {
    const response = await client.messages.create(
      {
        model: settings.ai.model,
        max_tokens: 400,
        thinking: { type: 'adaptive' },
        system: buildSystemPrompt(settings.owner),
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
      const out = await runTool(t.name, t.input, settings);
      toolResults.push({ type: 'tool_result', tool_use_id: t.id, content: out });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return EXHAUSTED;
}

// ── DeepSeek (OpenAI-compatible) backend ─────────────────────────────────────
async function decideDeepSeek(settings, history, incomingText) {
  const client = deepseekClientFor(settings.ai.apiKey);
  const messages = [
    { role: 'system', content: buildSystemPrompt(settings.owner) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: incomingText },
  ];

  for (let i = 0; i < 4; i += 1) {
    const resp = await client.chat.completions.create(
      {
        model: settings.ai.model,
        max_tokens: 400,
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
      const out = await runTool(c.function.name, safeParse(c.function.arguments), settings);
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
async function plainReply(settings, history, incomingText) {
  const sys = buildSystemPrompt(settings.owner);
  const hist = history.map((m) => ({ role: m.role, content: m.content }));
  if (settings.ai.provider === 'deepseek') {
    const resp = await deepseekClientFor(settings.ai.apiKey).chat.completions.create(
      {
        model: settings.ai.model,
        max_tokens: 400,
        messages: [{ role: 'system', content: sys }, ...hist, { role: 'user', content: incomingText }],
      },
      { timeout: 60_000 },
    );
    return (resp.choices?.[0]?.message?.content || '').trim();
  }
  const resp = await anthropicClientFor(settings.ai.apiKey).messages.create(
    {
      model: settings.ai.model,
      max_tokens: 400,
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

async function decide(settings, history, incomingText) {
  try {
    return settings.ai.provider === 'deepseek'
      ? await decideDeepSeek(settings, history, incomingText)
      : await decideAnthropic(settings, history, incomingText);
  } catch (err) {
    logger.error(
      { err: err.message, userId: settings.userId, provider: settings.ai.provider },
      'agent decide failed — falling back to a plain reply',
    );
    // The full tool/thinking call failed (model/tool incompatibility, transient
    // API error, timeout). Try a plain reply so the client still gets answered.
    try {
      const text = await plainReply(settings, history, incomingText);
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

module.exports = { decide, testKey };
