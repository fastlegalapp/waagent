'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('./config');
const logger = require('./logger');
const drive = require('./tools/drive');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

function buildSystemPrompt() {
  const { name, business, description } = config.owner;
  return [
    `You are the WhatsApp assistant for ${name}${business ? ` of ${business}` : ''}.`,
    description ? `About the business: ${description}` : '',
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
    '  escalate_to_human tool so a person can follow up, and tell the client you',
    '  will have someone get back to them shortly.',
    '- Never give binding legal, financial, or medical advice. For anything that',
    '  needs the owner\'s judgement, escalate.',
    '- If a client asks for a document, use find_document to look it up.',
    '- If a message is hostile, a wrong number, spam, or clearly needs no reply,',
    '  use the do_not_reply tool.',
    '- Keep replies under ~60 words unless the client asked something detailed.',
    '',
    'You decide the outcome by calling exactly one tool when appropriate, or by',
    'simply writing the reply text to send to the client.',
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

const tools = [
  {
    name: 'find_document',
    description:
      'Look up a document the client has requested (e.g. a contract, invoice, ' +
      'form) so it can be sent to them. Use when the client asks for a file.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What the client is asking for, e.g. "tenancy agreement" or "their invoice".',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Flag this conversation for the owner to handle personally. Use when you ' +
      'are unsure, the request needs the owner\'s judgement, or the client asks ' +
      'for something you cannot safely answer.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this needs a human.' },
        reply_to_client: {
          type: 'string',
          description:
            'A short holding message to send the client now (e.g. "Let me check ' +
            'with the team and get right back to you").',
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

async function runTool(name, input) {
  if (name === 'find_document') {
    const result = await drive.findDocument(input.query);
    return JSON.stringify(result);
  }
  // escalate_to_human and do_not_reply are terminal — handled by the caller.
  return JSON.stringify({ ok: true });
}

/**
 * Decide how to handle one incoming client message.
 *
 * @param {Array<{role:'user'|'assistant', content:string}>} history
 * @param {string} incomingText
 * @returns {Promise<{action:'reply'|'escalate'|'ignore', text?:string, reason?:string}>}
 */
async function decide(history, incomingText) {
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: incomingText },
  ];

  // Agentic loop: let Claude call find_document, then produce a final outcome.
  for (let i = 0; i < 4; i += 1) {
    let response;
    try {
      response = await client.messages.create({
        model: config.anthropic.model,
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        system: buildSystemPrompt(),
        tools,
        messages,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'Claude request failed');
      return { action: 'escalate', reason: 'AI request failed', text: '' };
    }

    if (response.stop_reason === 'refusal') {
      return {
        action: 'escalate',
        reason: 'AI declined to respond to this message',
        text: '',
      };
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      // Plain text reply.
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { action: 'reply', text };
    }

    // Handle terminal tools immediately.
    const escalate = toolUses.find((t) => t.name === 'escalate_to_human');
    if (escalate) {
      return {
        action: 'escalate',
        reason: escalate.input.reason,
        text: (escalate.input.reply_to_client || '').trim(),
      };
    }
    const skip = toolUses.find((t) => t.name === 'do_not_reply');
    if (skip) {
      return { action: 'ignore', reason: skip.input.reason };
    }

    // Otherwise run the (non-terminal) tools and feed results back.
    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const t of toolUses) {
      const out = await runTool(t.name, t.input);
      toolResults.push({ type: 'tool_result', tool_use_id: t.id, content: out });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Loop exhausted without a final answer — fail safe to a human.
  return {
    action: 'escalate',
    reason: 'Could not resolve the request automatically',
    text: 'Thanks for your message — let me check and get back to you shortly.',
  };
}

module.exports = { decide };
