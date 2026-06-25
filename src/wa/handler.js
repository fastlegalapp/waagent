'use strict';

const logger = require('../logger');
const mem = require('../db/messages');
const agent = require('../agent/agent');
const { extractText, numberFromJid, isGroup, isIgnorable } = require('./message-utils');

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
  if (isIgnorable(remoteJid)) return;
  if (msg.key?.fromMe) return;
  if (isGroup(remoteJid) && settings.reply.ignoreGroups) return;

  const text = extractText(msg.message);
  if (!text) return;

  const number = numberFromJid(msg.key.participant || remoteJid);
  const label = `${number} (${remoteJid})`;
  const msgTs = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

  logger.info({ userId, from: number, text }, 'incoming');
  // Persistence is best-effort — a DB hiccup must never stop the agent replying.
  try {
    await mem.appendMessage(userId, remoteJid, 'user', text, {
      waMsgId: msg.key.id,
      ts: msgTs,
    });
  } catch (err) {
    logger.error({ err: err.message, userId }, 'failed to store incoming message');
  }

  // Send a reply, THEN store it (best-effort). The message goes out even if the
  // database write fails.
  const reply = async (body) => {
    const sent = await send(remoteJid, body);
    try {
      await mem.appendMessage(userId, remoteJid, 'assistant', body, {
        waMsgId: sent?.key?.id,
        ts: Math.floor(Date.now() / 1000),
      });
      await mem.setLastReplyAt(userId, remoteJid, Date.now());
    } catch (err) {
      logger.error({ err: err.message, userId }, 'failed to persist reply');
    }
  };

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
  let last = 0;
  try {
    last = await mem.getLastReplyAt(userId, remoteJid);
  } catch (err) {
    logger.error({ err: err.message, userId }, 'failed to read last-reply time');
  }
  if ((now - last) / 1000 < settings.reply.minIntervalSeconds) return;

  if (!withinBusinessHours(settings.reply)) {
    await reply(
      `Thanks for your message! ${settings.owner.name} is currently unavailable. ` +
        `We\'ll get back to you as soon as we\'re back.`,
    );
    return;
  }

  let history = [];
  try {
    history = (await mem.getHistory(userId, remoteJid)).slice(0, -1);
  } catch (err) {
    logger.error({ err: err.message, userId }, 'failed to read history');
  }
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
    if (outcome.text) await reply(outcome.text);
    return;
  }

  if (outcome.text) {
    await reply(outcome.text);
    logger.info({ userId, to: number }, 'replied');
  }
}

module.exports = { handleMessage };
