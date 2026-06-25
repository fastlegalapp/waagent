'use strict';

const logger = require('../logger');
const mem = require('../db/messages');
const agent = require('../agent/agent');
const { extractText, messageType, numberFromJid, isGroup, isIgnorable } = require('./message-utils');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function handleMessage({ userId, settings, msg, send, notifyOwner, typing, note }) {
  const showTyping = typing || (async () => {});
  const mark = (status) => {
    try {
      if (note) note(status);
    } catch (_) {
      /* diagnostics are best-effort */
    }
  };
  const remoteJid = msg.key?.remoteJid;
  if (isIgnorable(remoteJid)) return;
  if (msg.key?.fromMe) return;
  if (isGroup(remoteJid) && settings.reply.ignoreGroups) return mark('group_ignored');

  // No decryptable content at all → almost always a failed decryption (common
  // when the other side is on WhatsApp Business) or a protocol/stub message.
  if (!msg.message) {
    return mark(`no_content:${msg.messageStubType ? `stub_${msg.messageStubType}` : 'decrypt_failed'}`);
  }
  const text = extractText(msg.message);
  if (!text) return mark(`no_text:${messageType(msg.message)}`);

  const number = numberFromJid(msg.key.participant || remoteJid);
  const label = `${number} (${remoteJid})`;
  const msgTs = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

  logger.info({ userId, from: number, text }, 'incoming');
  // Persistence is best-effort — a DB hiccup must never stop the agent replying.
  try {
    await mem.appendMessage(userId, remoteJid, 'user', text, {
      waMsgId: msg.key.id,
      ts: msgTs,
      source: 'client',
    });
  } catch (err) {
    logger.error({ err: err.message, userId }, 'failed to store incoming message');
  }

  // Send a reply, THEN store it (best-effort). The message goes out even if the
  // database write fails. Shows a typing indicator and a short, human-like pause
  // (scaled to message length, capped) so it doesn't feel like an instant bot.
  const reply = async (body) => {
    await showTyping(remoteJid, 'composing');
    await sleep(Math.min(700 + body.length * 25, 5000));
    const sent = await send(remoteJid, body);
    await showTyping(remoteJid, 'paused');
    try {
      await mem.appendMessage(userId, remoteJid, 'assistant', body, {
        waMsgId: sent?.key?.id,
        ts: Math.floor(Date.now() / 1000),
        source: 'bot',
      });
      await mem.setLastReplyAt(userId, remoteJid, Date.now());
    } catch (err) {
      logger.error({ err: err.message, userId }, 'failed to persist reply');
    }
  };

  if (settings.reply.mode === 'off') return mark('mode_off'); // logging only

  if (!settings.ai.apiKey) {
    logger.warn(
      { userId, provider: settings.ai.provider },
      'reply mode auto but no API key set for the selected provider — skipping',
    );
    return mark('no_api_key');
  }

  if (!isAllowed(settings.reply, number)) return mark('not_allowed');

  const now = Date.now();
  let last = 0;
  try {
    last = await mem.getLastReplyAt(userId, remoteJid);
  } catch (err) {
    logger.error({ err: err.message, userId }, 'failed to read last-reply time');
  }
  if ((now - last) / 1000 < settings.reply.minIntervalSeconds) return mark('rate_limited');

  if (!withinBusinessHours(settings.reply)) {
    await reply(
      `Thanks for your message! ${settings.owner.name} is currently unavailable. ` +
        `We\'ll get back to you as soon as we\'re back.`,
    );
    return mark('after_hours');
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

  if (outcome.action === 'ignore') return mark('ignored');

  if (outcome.action === 'escalate') {
    await notifyOwner(
      `🔔 Needs you — chat with ${label}\nReason: ${outcome.reason}\nLast message: "${text}"`,
    );
    if (outcome.text) await reply(outcome.text);
    return mark('escalated');
  }

  if (outcome.text) {
    await reply(outcome.text);
    logger.info({ userId, to: number }, 'replied');
    return mark('replied');
  }
  return mark('empty_reply');
}

module.exports = { handleMessage };
