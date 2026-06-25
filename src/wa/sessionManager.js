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
const { handleMessage } = require('./handler');
const { extractText, isGroup, isIgnorable } = require('./message-utils');

const baileysLogger = pino({ level: 'silent' });

// userId -> { sock, status, qr, startedAt }
// status: 'connecting' | 'qr' | 'open' | 'closed' | 'logged_out'
const sessions = new Map();
// userId -> consecutive reconnect attempts (reset on 'open' / fresh start)
const reconnects = new Map();
const MAX_RECONNECT = 8;

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
  fs.mkdirSync(authDir(userId), { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir(userId));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    logger: baileysLogger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: true, // pull past conversations so the agent has context
    browser: ['waagent', 'Chrome', '120.0.0'],
    qrTimeout: 60_000,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });

  const entry = { sock, status: 'connecting', qr: null, startedAt: Date.now() };
  sessions.set(userId, entry);

  const send = async (jid, text) => {
    try {
      return await sock.sendMessage(jid, { text });
    } catch (err) {
      logger.error({ err: err.message, userId, jid }, 'failed to send');
      return null;
    }
  };
  const notifyOwner = async (text) => {
    const me = sock.user?.id;
    if (me) await send(me, text);
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
    if (type !== 'notify') return;
    // Reload settings per batch so config changes take effect without restart.
    let settings;
    try {
      settings = await userConfig.resolve(userId);
    } catch (err) {
      logger.error({ err: err.message, userId }, 'failed to load settings');
      return;
    }
    if (!settings) return;
    for (const msg of messages) {
      try {
        await handleMessage({ userId, settings, msg, send, notifyOwner, typing });
      } catch (err) {
        logger.error({ err: err.message, userId }, 'handler error');
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
        chatId: jid,
        role: m.key.fromMe ? 'assistant' : 'user',
        content: text,
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

module.exports = { start, stop, logout, state, hasLinkedSession, resumeAll };
