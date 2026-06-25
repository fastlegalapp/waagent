'use strict';

const logger = require('../logger');
const mem = require('../db/messages');
const agent = require('../agent/agent');

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

function withinBusinessHours(reply) {
  const { businessHoursStart: start, businessHoursEnd: end } = reply;
  if (start == null || end == null) return true;
  const hour = new Date().getHours();
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end; // overnight window
}

function isAllowed(reply, number) {
  if (reply.blocklist.includes(number)) return false;
  if (reply.allowlist.length > 0) return reply.allowlist.includes(number);
  return true;
}

/**
 * Handle one incoming WhatsApp message for a specific user.
 *
 * @param {object} ctx
 * @param {string} ctx.userId
 * @param {object} ctx.settings    resolved user config (fetched fresh per message)
 * @param {object} ctx.msg         raw Baileys message
 * @param {function} ctx.send      async (jid, text) => void
 * @param {function} ctx.notifyOwner async (text) => void
 */
async function handleMessage({ userId, settings, msg, send, notifyOwner }) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid) return;
  if (msg.key?.fromMe) return;
  if (remoteJid === 'status@broadcast') return;

  const isGroup = remoteJid.endsWith('@g.us');
  if (isGroup && settings.reply.ignoreGroups) return;

  const text = extractText(msg.message);
  if (!text) return;

  const number = numberFromJid(msg.key.participant || remoteJid);
  const label = `${number} (${remoteJid})`;

  logger.info({ userId, from: number, text }, 'incoming');
  await mem.appendMessage(userId, remoteJid, 'user', text);

  if (settings.reply.mode === 'off') return; // logging only

  if (!settings.ai.apiKey) {
    logger.warn(
      { userId, provider: settings.ai.provider },
      'reply mode auto but no API key set for the selected provider — skipping',
    );
    return;
  }

  if (!isAllowed(settings.reply, number)) return;

  const now = Date.now();
  const last = await mem.getLastReplyAt(userId, remoteJid);
  if ((now - last) / 1000 < settings.reply.minIntervalSeconds) return;

  if (!withinBusinessHours(settings.reply)) {
    const afterHours =
      `Thanks for your message! ${settings.owner.name} is currently unavailable. ` +
      `We\'ll get back to you as soon as we\'re back.`;
    await send(remoteJid, afterHours);
    await mem.appendMessage(userId, remoteJid, 'assistant', afterHours);
    await mem.setLastReplyAt(userId, remoteJid, now);
    return;
  }

  const history = (await mem.getHistory(userId, remoteJid)).slice(0, -1);
  let outcome;
  try {
    outcome = await agent.decide(settings, history, text);
  } catch (err) {
    logger.error({ err: err.message, userId }, 'agent error');
    outcome = { action: 'escalate', reason: 'agent error', text: '' };
  }

  if (outcome.action === 'ignore') return;

  if (outcome.action === 'escalate') {
    await notifyOwner(
      `🔔 Needs you — chat with ${label}\nReason: ${outcome.reason}\nLast message: "${text}"`,
    );
    if (outcome.text) {
      await send(remoteJid, outcome.text);
      await mem.appendMessage(userId, remoteJid, 'assistant', outcome.text);
      await mem.setLastReplyAt(userId, remoteJid, now);
    }
    return;
  }

  if (outcome.text) {
    await send(remoteJid, outcome.text);
    await mem.appendMessage(userId, remoteJid, 'assistant', outcome.text);
    await mem.setLastReplyAt(userId, remoteJid, now);
    logger.info({ userId, to: number }, 'replied');
  }
}

module.exports = { handleMessage };
