'use strict';

const { config } = require('../config');
const logger = require('../logger');
const memory = require('../store/memory');
const agent = require('../agent');

// Pull the human-readable text out of the many Baileys message shapes.
function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  ).trim();
}

function numberFromJid(jid) {
  return (jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function withinBusinessHours() {
  const { businessHoursStart: start, businessHoursEnd: end } = config.reply;
  if (start === null || end === null) return true; // always-on
  const hour = new Date().getHours();
  if (start <= end) return hour >= start && hour < end;
  // overnight window, e.g. 22 -> 6
  return hour >= start || hour < end;
}

function isAllowed(number) {
  if (config.reply.blocklist.includes(number)) return false;
  if (config.reply.allowlist.length > 0) {
    return config.reply.allowlist.includes(number);
  }
  return true;
}

/**
 * Handle a single incoming WhatsApp message.
 *
 * @param {object} ctx
 * @param {object} ctx.msg        raw Baileys message
 * @param {function} ctx.send     async (jid, text) => void
 * @param {function} ctx.notifyOwner async (text) => void
 */
async function handleMessage({ msg, send, notifyOwner }) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid) return;
  if (msg.key?.fromMe) return; // never react to our own messages
  if (remoteJid === 'status@broadcast') return;

  const isGroup = remoteJid.endsWith('@g.us');
  if (isGroup && config.reply.ignoreGroups) return;

  const text = extractText(msg.message);
  if (!text) return; // ignore stickers/reactions/empty payloads for now

  const number = numberFromJid(msg.key.participant || remoteJid);
  const label = `${number} (${remoteJid})`;

  logger.info({ from: number, text }, 'incoming');

  // Always record what the client said, even if we don't reply — keeps context.
  memory.appendMessage(remoteJid, 'user', text);

  if (config.reply.mode === 'off') {
    logger.info({ from: number }, 'REPLY_MODE=off — logging only');
    return;
  }

  if (!isAllowed(number)) {
    logger.info({ from: number }, 'not allowed (allow/blocklist) — skipping');
    return;
  }

  // Loop / spam guard: don't fire faster than the configured interval per chat.
  const now = Date.now();
  const since = (now - memory.getLastReplyAt(remoteJid)) / 1000;
  if (since < config.reply.minIntervalSeconds) {
    logger.info({ from: number, since }, 'within min reply interval — skipping');
    return;
  }

  // After-hours: send a holding message rather than a full reply.
  if (!withinBusinessHours()) {
    const afterHours =
      `Thanks for your message! ${config.owner.name} is currently unavailable. ` +
      `We\'ll get back to you as soon as we\'re back.`;
    await send(remoteJid, afterHours);
    memory.appendMessage(remoteJid, 'assistant', afterHours);
    memory.setLastReplyAt(remoteJid, now);
    return;
  }

  const history = memory.getHistory(remoteJid).slice(0, -1); // exclude the just-added turn
  let outcome;
  try {
    outcome = await agent.decide(history, text);
  } catch (err) {
    logger.error({ err: err.message, from: number }, 'agent error');
    outcome = { action: 'escalate', reason: 'agent error', text: '' };
  }

  if (outcome.action === 'ignore') {
    logger.info({ from: number, reason: outcome.reason }, 'agent chose not to reply');
    return;
  }

  if (outcome.action === 'escalate') {
    logger.warn({ from: number, reason: outcome.reason }, 'escalating to owner');
    await notifyOwner(
      `🔔 Needs you — chat with ${label}\nReason: ${outcome.reason}\nLast message: "${text}"`,
    );
    if (outcome.text) {
      await send(remoteJid, outcome.text);
      memory.appendMessage(remoteJid, 'assistant', outcome.text);
      memory.setLastReplyAt(remoteJid, now);
    }
    return;
  }

  // action === 'reply'
  if (outcome.text) {
    await send(remoteJid, outcome.text);
    memory.appendMessage(remoteJid, 'assistant', outcome.text);
    memory.setLastReplyAt(remoteJid, now);
    logger.info({ to: number, text: outcome.text }, 'replied');
  }
}

module.exports = { handleMessage };
