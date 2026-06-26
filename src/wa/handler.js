'use strict';

const logger = require('../logger');
const mem = require('../db/messages');
const agent = require('../agent/agent');
const {
  extractText,
  messageType,
  numberFromJid,
  numberInList,
  phoneJid,
  senderName,
  isGroup,
  isIgnorable,
} = require('./message-utils');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory per-chat last-reply time. Closes the race where two messages that
// arrive close together (as separate upsert events, before the DB write lands)
// both clear the interval gate. We reserve the slot synchronously the moment a
// message passes the gate, so a second message arriving while we're still
// thinking/typing is throttled immediately.
const lastReplyAt = new Map(); // `${userId}:${chatId}` -> epoch ms
const LAST_REPLY_MAX = 50_000; // bound memory across many users/chats
function noteReplyAt(userId, chatId, ms) {
  const key = `${userId}:${chatId}`;
  // Re-insert so the key moves to the most-recent end (Map keeps insertion order).
  lastReplyAt.delete(key);
  lastReplyAt.set(key, ms);
  if (lastReplyAt.size > LAST_REPLY_MAX) {
    lastReplyAt.delete(lastReplyAt.keys().next().value); // evict oldest
  }
}

function withinBusinessHours(reply) {
  const { businessHoursStart: start, businessHoursEnd: end } = reply;
  if (start == null || end == null) return true;
  const hour = new Date().getHours();
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end; // overnight window
}

function isAllowed(reply, number) {
  if (numberInList(reply.blocklist, number)) return false;
  if (reply.allowlist.length > 0) return numberInList(reply.allowlist, number);
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

  // Resolve the client's real mobile-number JID (handles WhatsApp "LID"
  // addressing) so replies and the allow/block list use the phone number, not
  // an internal id.
  const clientJid = phoneJid(msg) || remoteJid;
  const number = numberFromJid(msg.key.participant || clientJid);
  const clientName = senderName(msg);
  const msgTs = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

  // Canonical key for stored history / chat-state / rate-limiting. For 1:1 chats
  // we key by the phone-number JID so a conversation isn't split between a LID
  // (`...@lid`) and the phone JID — the owner-relay also stores under the phone
  // JID, so both now land in the same thread the agent reads next turn. Groups
  // keep the group JID. We still SEND to the live remoteJid.
  const chatKey = isGroup(remoteJid) ? remoteJid : clientJid;

  logger.info({ userId, from: number, text }, 'incoming');
  // Persistence is best-effort — a DB hiccup must never stop the agent replying.
  try {
    await mem.appendMessage(userId, chatKey, 'user', text, {
      waMsgId: msg.key.id,
      ts: msgTs,
      source: 'client',
    });
  } catch (err) {
    logger.error({ err: err.message, userId }, 'failed to store incoming message');
  }
  // Mark client activity (resets the follow-up flag for this chat).
  mem.setClientActivity(userId, chatKey, msgTs * 1000).catch(() => {});

  // Send a reply, THEN store it (best-effort). The message goes out even if the
  // database write fails. Shows a typing indicator and a short, human-like pause
  // (scaled to message length, capped) so it doesn't feel like an instant bot.
  const reply = async (body) => {
    // Human-like gap: a brief "reading" pause, then the typing indicator, then
    // the message — total time is a random value in the owner's configured
    // [min, max] range (so replies aren't instant and don't feel robotic).
    const lo = Math.max(0, Number(settings.reply.delayMinSeconds) || 0);
    const hi = Math.max(lo, Number(settings.reply.delayMaxSeconds) || 0);
    const totalMs = (lo === hi ? lo : lo + Math.random() * (hi - lo)) * 1000;
    if (totalMs > 0) {
      const readMs = Math.min(totalMs * 0.35, 2000); // pause "reading" before typing
      await sleep(readMs);
      await showTyping(remoteJid, 'composing');
      await sleep(totalMs - readMs);
    } else {
      await showTyping(remoteJid, 'composing');
    }
    const sent = await send(remoteJid, body);
    await showTyping(remoteJid, 'paused');
    noteReplyAt(userId, chatKey, Date.now());
    try {
      await mem.appendMessage(userId, chatKey, 'assistant', body, {
        waMsgId: sent?.key?.id,
        ts: Math.floor(Date.now() / 1000),
        source: 'bot',
      });
      await mem.setLastReplyAt(userId, chatKey, Date.now());
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
  const minInterval = Number(settings.reply.minIntervalSeconds) || 0;
  // Synchronous in-memory gate FIRST, with no await between the check and the
  // reservation — this is what actually closes the race between two messages
  // that arrive close together (each as its own upsert event).
  const memLast = lastReplyAt.get(`${userId}:${chatKey}`) || 0;
  if (minInterval > 0 && (now - memLast) / 1000 < minInterval) return mark('rate_limited');
  noteReplyAt(userId, chatKey, now); // reserve the slot before any await
  // Also honour the persisted last-reply time (survives restarts) as a lower
  // bound; safe to check after reserving.
  let dbLast = 0;
  try {
    dbLast = await mem.getLastReplyAt(userId, chatKey);
  } catch (err) {
    logger.error({ err: err.message, userId }, 'failed to read last-reply time');
  }
  if (minInterval > 0 && (now - dbLast) / 1000 < minInterval) return mark('rate_limited');

  if (!withinBusinessHours(settings.reply)) {
    await reply(
      `Thanks for your message! ${settings.owner.name} is currently unavailable. ` +
        `We\'ll get back to you as soon as we\'re back.`,
    );
    return mark('after_hours');
  }

  let history = [];
  try {
    history = (await mem.getHistory(userId, chatKey)).slice(0, -1);
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
    const who = clientName ? `${clientName}\n📱 +${number}` : `📱 +${number}`;
    await notifyOwner(
      `🔔 Needs you — ${who}\n` +
        `Reason: ${outcome.reason}\n` +
        `Their message: "${text}"\n\n` +
        `↩️ Reply to THIS message to answer them` +
        ` (or send "${number}: your reply").`,
      clientJid,
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
