'use strict';

const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const { config } = require('../config');
const logger = require('../logger');
const userConfig = require('../services/userConfig');
const mem = require('../db/messages');
const agent = require('../agent/agent');
const { handleMessage } = require('./handler');
const {
  extractText,
  quotedId,
  quotedText,
  numberFromJid,
  phoneJid,
  isGroup,
  isIgnorable,
} = require('./message-utils');

// Canonical memory key for a message, matching handler.js: 1:1 chats key by the
// phone-number JID (so LID and phone JIDs don't split a conversation), groups
// keep the group JID.
function memKey(m) {
  const jid = m?.key?.remoteJid;
  if (!jid || isGroup(jid)) return jid;
  return phoneJid(m) || jid;
}

// Pull a phone number (10–15 digits) out of free text — used to read the client
// number back out of an escalation note the owner quote-replied to.
function phoneInText(text) {
  const runs = (text || '').match(/\d[\d\s-]{8,}\d/g) || [];
  for (const run of runs) {
    const digits = run.replace(/[^0-9]/g, '');
    if (digits.length >= 10 && digits.length <= 15) return digits;
  }
  return null;
}

// Marker that identifies one of our escalation notes when it appears as the
// quoted message in the owner's reply. Keep in sync with handler.js's note.
const ESCALATION_MARK = /needs you|🔔/i;

const baileysLogger = pino({ level: 'silent' });

// userId -> { sock, status, qr, startedAt }
// status: 'connecting' | 'qr' | 'open' | 'closed' | 'logged_out'
const sessions = new Map();
// userId -> consecutive reconnect attempts (reset on 'open' / fresh start)
const reconnects = new Map();
const MAX_RECONNECT = 8;

// userId -> Map(messageId -> message content). Lets us answer WhatsApp "retry
// receipts" via getMessage(); without this, replies the recipient fails to
// decrypt get stuck showing "Waiting for this message." Survives reconnects.
const msgCaches = new Map();
const MSG_CACHE_MAX = 3000;
function msgCacheFor(userId) {
  let m = msgCaches.get(userId);
  if (!m) {
    m = new Map();
    msgCaches.set(userId, m);
  }
  return m;
}
function cacheMsg(userId, id, message) {
  if (!id || !message) return;
  const m = msgCacheFor(userId);
  m.set(id, message);
  if (m.size > MSG_CACHE_MAX) m.delete(m.keys().next().value); // drop oldest
}

// userId -> recent activity, for the dashboard diagnostics panel.
const activity = new Map();
function act(userId) {
  let a = activity.get(userId);
  if (!a) {
    a = { lastIncomingAt: null, lastSentAt: null, lastResult: null, lastResultAt: null };
    activity.set(userId, a);
  }
  return a;
}
function getActivity(userId) {
  return activity.get(userId) || { lastIncomingAt: null, lastSentAt: null, lastResult: null, lastResultAt: null };
}

// True if the user's WhatsApp is connected and ready to send.
function isOpen(userId) {
  return sessions.get(userId)?.status === 'open';
}

// Send text via a user's live socket (used by the follow-up job). Returns the
// sent message or null.
async function sendText(userId, jid, text) {
  const s = sessions.get(userId);
  if (!s || s.status !== 'open' || !s.send) return null;
  return s.send(jid, text);
}

// Track ids of messages WE sent, so the owner's own outgoing messages (which
// also arrive as fromMe) can be told apart and learned from.
const botSentIds = new Map();
const BOT_IDS_MAX = 5000;
function markBotSent(userId, id) {
  if (!id) return;
  let s = botSentIds.get(userId);
  if (!s) {
    s = new Set();
    botSentIds.set(userId, s);
  }
  s.add(id);
  if (s.size > BOT_IDS_MAX) s.delete(s.values().next().value);
}
function isBotSent(userId, id) {
  return botSentIds.get(userId)?.has(id) || false;
}

// userId -> Map(escalationMsgId -> clientJid). When the agent escalates it sends
// a note to the owner's OWN WhatsApp (self-chat). This remembers which client
// each note was about, so when the owner quote-replies to that note we relay
// their answer to the right client.
const escMaps = new Map();
const ESC_MAX = 500;
function escMapFor(userId) {
  let m = escMaps.get(userId);
  if (!m) {
    m = new Map();
    escMaps.set(userId, m);
  }
  return m;
}
// userId -> { jid, at } — the most recent escalation, so a plain (un-quoted)
// reply in the self-chat still reaches the client it was just about.
const lastEscalated = new Map();
const RELAY_WINDOW_MS = 60 * 60 * 1000; // 1h
function rememberEscalation(userId, msgId, clientJid) {
  if (!clientJid) return;
  if (msgId) {
    const m = escMapFor(userId);
    m.set(msgId, clientJid);
    if (m.size > ESC_MAX) m.delete(m.keys().next().value);
  }
  lastEscalated.set(userId, { jid: clientJid, at: Date.now() });
}

// Minimal CacheStore for Baileys' msgRetryCounterCache (tracks decryption-retry
// counts so retry receipts are handled and resent correctly).
function makeCache() {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    set: (k, v) => { m.set(k, v); },
    del: (k) => { m.delete(k); },
    flushAll: () => { m.clear(); },
  };
}

function authDir(userId) {
  return path.join(config.authRoot, userId);
}

function state(userId) {
  const s = sessions.get(userId);
  return s ? { status: s.status, qr: s.qr || null } : { status: 'idle', qr: null };
}

function hasLinkedSession(userId) {
  // creds.json exists once the device has been linked at least once.
  return fs.existsSync(path.join(authDir(userId), 'creds.json'));
}

function reasonName(code) {
  const names = Object.entries(DisconnectReason).find(([, v]) => v === code);
  return names ? names[0] : 'unknown';
}

// Always creates a fresh socket. Used both for the first connect and for
// reconnects (notably the 515 "restartRequired" that WhatsApp sends right after
// a successful QR scan — login only completes once a NEW socket is opened).
async function connect(userId) {
  // Never run two sockets for one user — a duplicate connection on the same auth
  // corrupts the encryption session ("Waiting for this message").
  const prev = sessions.get(userId);
  if (prev?.sock) {
    try {
      prev.sock.end(undefined);
    } catch (_) {
      /* ignore */
    }
  }

  fs.mkdirSync(authDir(userId), { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir(userId));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    logger: baileysLogger,
    printQRInTerminal: false,
    markOnlineOnConnect: true, // stay online so retry receipts are serviced promptly
    syncFullHistory: true, // pull past conversations so the agent has context
    browser: ['waagent', 'Chrome', '120.0.0'],
    qrTimeout: 60_000,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    // Track decryption-retry counts and serve retry receipts so messages the
    // recipient couldn't decrypt are re-sent instead of getting stuck on
    // "Waiting for this message."
    msgRetryCounterCache: makeCache(),
    getMessage: async (key) => msgCacheFor(userId).get(key?.id) || undefined,
  });

  const entry = { sock, status: 'connecting', qr: null, startedAt: Date.now(), send: null };
  sessions.set(userId, entry);

  const send = async (jid, text) => {
    try {
      const sent = await sock.sendMessage(jid, { text });
      // Cache so we can re-serve it if the recipient asks for a retry, and mark
      // it as bot-sent so the echo isn't mistaken for the owner's own message.
      if (sent?.key?.id) {
        cacheMsg(userId, sent.key.id, sent.message);
        markBotSent(userId, sent.key.id);
      }
      act(userId).lastSentAt = Date.now();
      return sent;
    } catch (err) {
      logger.error({ err: err.message, userId, jid }, 'failed to send');
      return null;
    }
  };
  entry.send = send;
  const ownNumber = () => numberFromJid(sock.user?.id);
  const selfJid = () => `${ownNumber()}@s.whatsapp.net`;
  const isSelfChat = (jid) => {
    const own = ownNumber();
    return !!own && numberFromJid(jid) === own;
  };
  // Escalations go to the owner's OWN WhatsApp (the "message to yourself" chat),
  // tagged so a quote-reply can be routed back to the right client.
  const notifyOwner = async (text, clientJid) => {
    if (!ownNumber()) return;
    const sent = await send(selfJid(), text);
    if (clientJid) rememberEscalation(userId, sent?.key?.id, clientJid);
  };

  // The owner typed something in their own self-chat. If it's a reply to an
  // escalation (quote-reply), or carries an explicit "<number>: message" prefix,
  // or there's a recent escalation, relay it verbatim to that client.
  const handleOwnerSelf = async (m) => {
    const text = extractText(m.message);
    if (!text) return;
    let target = null;
    let body = text;
    let via = null;

    // 1) Quote-reply to an escalation note. Prefer the in-memory map, but also
    //    read the client number straight out of the quoted note's text so this
    //    keeps working after a restart wiped the map.
    const qid = quotedId(m.message);
    const qText = quotedText(m.message);
    const mapped = qid && escMapFor(userId).get(qid);
    if (mapped) {
      target = mapped;
      via = 'quote';
    } else if (qText) {
      const num = phoneInText(qText);
      if (num) {
        target = `${num}@s.whatsapp.net`;
        via = 'quote-note';
      }
    }

    // 2) Explicit "<number>: message" prefix (e.g. "919876543210: ok done").
    if (!target) {
      const match = text.match(/^\s*\+?(\d[\d\s-]{6,})\s*[:\-]\s*([\s\S]+)$/);
      if (match) {
        target = `${match[1].replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        body = match[2].trim();
        via = 'prefix';
      }
    }

    // 3) Otherwise fall back to the most recent escalation, if it's recent.
    if (!target) {
      const le = lastEscalated.get(userId);
      if (le && Date.now() - le.at < RELAY_WINDOW_MS) {
        target = le.jid;
        via = 'recent';
      }
    }

    if (!target || !body) {
      // A quote-reply we couldn't route is worth surfacing; a plain self-note is not.
      if (qid || qText) {
        logger.warn(
          { userId, hadQuote: !!qText, quotedSample: (qText || '').slice(0, 60) },
          'owner-relay: could not resolve target for quoted reply',
        );
      }
      return;
    }
    // Understand the owner's note and compose a natural client-facing message in
    // their style/language, instead of forwarding it verbatim. Uses the client's
    // recent history for context; falls back to the owner's text if AI is off.
    let outgoing = body;
    try {
      const settings = await userConfig.resolve(userId);
      let history = [];
      try {
        history = (await mem.getHistory(userId, target)).slice(-20);
      } catch (_) {
        /* history is best-effort */
      }
      outgoing = (await agent.composeFromOwner(settings, history, body)) || body;
    } catch (err) {
      logger.error({ err: err.message, userId }, 'owner-relay: compose failed, sending verbatim');
    }

    logger.info({ userId, to: numberFromJid(target), via }, 'owner-relay: forwarding to client');
    const sent = await send(target, outgoing);
    if (!sent) {
      await send(selfJid(), '⚠️ Could not send — try again.');
      return;
    }
    // Keep talking to whoever the owner just answered: plain self-notes that
    // follow continue to this client (until a newer escalation or prefix).
    rememberEscalation(userId, null, target);
    mem
      .appendMessage(userId, target, 'assistant', outgoing, {
        waMsgId: sent.key?.id,
        ts: Math.floor(Date.now() / 1000),
        source: 'owner',
      })
      .catch(() => {});
    mem.setLastReplyAt(userId, target, Date.now()).catch(() => {});
    // Show the owner what actually went out, so they can see how it was phrased.
    await send(selfJid(), `✓ Sent to +${numberFromJid(target)}:\n${outgoing}`);
  };
  // Show the "typing…" indicator to the client, so replies feel human.
  const typing = async (jid, presence) => {
    try {
      await sock.sendPresenceUpdate(presence, jid);
    } catch (_) {
      /* presence is best-effort */
    }
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        entry.qr = await QRCode.toDataURL(qr);
        entry.status = 'qr';
        logger.info({ userId }, 'QR ready — waiting for scan');
      } catch (err) {
        logger.error({ err: err.message, userId }, 'failed to render QR');
      }
    }

    if (connection === 'open') {
      entry.status = 'open';
      entry.qr = null;
      reconnects.set(userId, 0);
      // Mark available so WhatsApp delivers retry receipts and we can resend
      // messages the recipient couldn't decrypt.
      sock.sendPresenceUpdate('available').catch(() => {});
      logger.info({ userId, waUser: sock.user?.id }, 'WhatsApp connected ✅');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      // Clean up the dead socket's listeners before deciding what to do next.
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('creds.update');
      } catch (_) {
        /* ignore */
      }

      if (loggedOut) {
        entry.status = 'logged_out';
        sessions.delete(userId);
        reconnects.delete(userId);
        try {
          fs.rmSync(authDir(userId), { recursive: true, force: true });
        } catch (_) {
          /* ignore */
        }
        logger.warn({ userId }, 'WhatsApp logged out — link removed');
        return;
      }

      const attempts = (reconnects.get(userId) || 0) + 1;
      reconnects.set(userId, attempts);

      if (attempts > MAX_RECONNECT) {
        entry.status = 'closed';
        logger.error(
          { userId, code, reason: reasonName(code), attempts },
          'giving up reconnecting — click Connect to retry',
        );
        return;
      }

      // restartRequired (the normal post-scan step) reconnects fast; back off a
      // little for other transient errors.
      const restartRequired = code === DisconnectReason.restartRequired;
      const delay = restartRequired ? 500 : Math.min(attempts * 1500, 10_000);
      entry.status = 'connecting';
      logger.warn(
        { userId, code, reason: reasonName(code), attempts, delay },
        'connection closed — reconnecting',
      );
      // Reconnect by creating a NEW socket (bypasses the public start() guard).
      setTimeout(() => connect(userId).catch((err) => {
        logger.error({ err: err.message, userId }, 'reconnect failed');
      }), delay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Cache every message we see (for retry receipts), capture the owner's own
    // outgoing replies for style-learning, and — crucially — route the owner's
    // self-chat replies for relay. The relay must run for BOTH real-time
    // ('notify') and synced/own-device ('append') batches, because a reply the
    // owner sends from their phone can arrive as either.
    for (const m of messages) {
      const jid = m?.key?.remoteJid;
      if (m?.key?.id && m.message) cacheMsg(userId, m.key.id, m.message);
      if (!jid || jid === 'status@broadcast' || isGroup(jid)) continue;

      // Relay an owner's reply back to the client. We trigger this when EITHER
      // the message is in the owner's self-chat, OR it quote-replies to one of
      // our escalation notes — detected by the note's text, which WhatsApp
      // embeds in the reply. The note path is robust even if self-chat JID
      // detection fails or the process was restarted.
      if (m.key.fromMe && !isBotSent(userId, m.key.id)) {
        const qText = quotedText(m.message);
        const repliesToEscalation = ESCALATION_MARK.test(qText);
        if (repliesToEscalation || isSelfChat(jid)) {
          logger.info(
            { userId, chat: numberFromJid(jid), self: isSelfChat(jid), repliesToEscalation },
            'owner-relay: handling owner reply',
          );
          handleOwnerSelf(m).catch((err) =>
            logger.error({ err: err.message, userId }, 'owner-relay failed'),
          );
          continue;
        }
      }

      // Everything below is only meaningful for fresh real-time batches.
      if (type !== 'notify') continue;
      if (m.key.fromMe) {
        if (isBotSent(userId, m.key.id)) continue; // our own outgoing — skip
        const t = extractText(m.message);
        if (t) {
          mem
            .appendMessage(userId, memKey(m), 'assistant', t, {
              waMsgId: m.key.id,
              ts: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000),
              source: 'owner',
            })
            .catch(() => {});
        }
      } else {
        act(userId).lastIncomingAt = Date.now();
      }
    }
    // Only auto-reply to fresh inbound batches; skip synced history ('append').
    if (type !== 'notify') return;
    // Reload settings per batch so config changes take effect without restart.
    let settings;
    try {
      settings = await userConfig.resolve(userId);
    } catch (err) {
      logger.error({ err: err.message, userId }, 'failed to load settings');
      act(userId).lastResult = 'settings_load_failed';
      act(userId).lastResultAt = Date.now();
      return;
    }
    if (!settings) return;
    const note = (status) => {
      const a = act(userId);
      a.lastResult = status;
      a.lastResultAt = Date.now();
    };
    for (const msg of messages) {
      try {
        await handleMessage({ userId, settings, msg, send, notifyOwner, typing, note });
      } catch (err) {
        logger.error({ err: err.message, userId }, 'handler error');
        note('handler_error');
      }
    }
  });

  // Past conversations sent by WhatsApp shortly after linking (and progressively
  // afterwards). Import 1:1 text messages so the agent has real context. May
  // fire several times; duplicates are ignored at the DB layer.
  sock.ev.on('messaging-history.set', async ({ messages: hist }) => {
    if (!Array.isArray(hist) || hist.length === 0) return;
    const rows = [];
    for (const m of hist) {
      const jid = m.key?.remoteJid;
      if (isIgnorable(jid) || isGroup(jid)) continue; // 1:1 chats only
      const text = extractText(m.message);
      if (!text) continue;
      rows.push({
        userId,
        chatId: phoneJid(m) || jid,
        role: m.key.fromMe ? 'assistant' : 'user',
        content: text,
        source: m.key.fromMe ? 'owner' : 'client',
        waMsgId: m.key.id,
        ts: Number(m.messageTimestamp) || 0,
      });
    }
    if (rows.length === 0) return;
    try {
      await mem.appendMany(rows);
      logger.info({ userId, imported: rows.length }, 'imported WhatsApp history');
    } catch (err) {
      logger.error({ err: err.message, userId }, 'failed to import history');
    }
  });

  return state(userId);
}

// Public entry point. Guards against double-starting an already-active session
// (e.g. repeated clicks of "Connect"); reconnects use connect() directly.
async function start(userId) {
  const existing = sessions.get(userId);
  if (existing && ['connecting', 'qr', 'open'].includes(existing.status)) {
    return state(userId);
  }
  reconnects.set(userId, 0);
  return connect(userId);
}

// Disconnect but keep the link (creds on disk) so it can resume.
async function stop(userId) {
  const s = sessions.get(userId);
  if (s?.sock) {
    try {
      s.sock.end(undefined);
    } catch (_) {
      /* ignore */
    }
  }
  sessions.delete(userId);
  reconnects.delete(userId);
  return { status: 'closed', qr: null };
}

// Fully unlink: disconnect and delete the stored session.
async function logout(userId) {
  await stop(userId);
  msgCaches.delete(userId);
  try {
    fs.rmSync(authDir(userId), { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  return { status: 'idle', qr: null };
}

// On boot, resume sessions for users who had previously linked a device.
async function resumeAll(userIds) {
  for (const userId of userIds) {
    if (hasLinkedSession(userId)) {
      try {
        await start(userId);
        logger.info({ userId }, 'resumed WhatsApp session');
      } catch (err) {
        logger.error({ err: err.message, userId }, 'failed to resume session');
      }
    }
  }
}

module.exports = {
  start,
  stop,
  logout,
  state,
  getActivity,
  isOpen,
  sendText,
  hasLinkedSession,
  resumeAll,
};
