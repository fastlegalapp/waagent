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
    `You are the WhatsApp assistant for ${name}${owner.business ? ` of ${owner.business}` : ''}.`,
    owner.description ? `About the business: ${owner.description}` : '',
    '',
    'You reply to clients on WhatsApp on the owner\'s behalf. Write the way a',
    'helpful, professional human assistant would on a phone chat: warm, concise,',
    'and to the point. Short messages. No corporate filler, no emoji unless the',
    'client uses them first.',
    '',
    'Rules:',
    `- Speak as ${name}'s assistant, never claim to be ${name} personally.`,
    '- Only state facts you are sure of. If you do not know something specific to',
    '  this client (case details, prices, deadlines), do NOT invent it — use the',
    '  escalate_to_human tool so a person can follow up.',
    '- Never give binding legal, financial, or medical advice. Escalate anything',
    '  needing the owner\'s judgement.',
    '- If a client asks for a document, use find_document to look it up.',
    '- If a message is hostile, a wrong number, spam, or clearly needs no reply,',
    '  use the do_not_reply tool.',
    '- Keep replies under ~60 words unless the client asked something detailed.',
    '',
    'Call exactly one tool when appropriate, or write the reply text to send.',
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
    let response;
    try {
      response = await client.messages.create({
        model: settings.ai.model,
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        system: buildSystemPrompt(settings.owner),
        tools,
        messages,
      });
    } catch (err) {
      logger.error({ err: err.message, userId: settings.userId }, 'Claude request failed');
      return { action: 'escalate', reason: 'AI request failed', text: '' };
    }

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
    let resp;
    try {
      resp = await client.chat.completions.create({
        model: settings.ai.model,
        max_tokens: 1024,
        tools: openaiTools,
        tool_choice: 'auto',
        messages,
      });
    } catch (err) {
      logger.error({ err: err.message, userId: settings.userId }, 'DeepSeek request failed');
      return { action: 'escalate', reason: 'AI request failed', text: '' };
    }

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
async function decide(settings, history, incomingText) {
  if (settings.ai.provider === 'deepseek') {
    return decideDeepSeek(settings, history, incomingText);
  }
  return decideAnthropic(settings, history, incomingText);
}

module.exports = { decide };
