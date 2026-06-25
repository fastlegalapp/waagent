'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const { config } = require('./config');
const logger = require('./logger');
const { handleMessage } = require('./handlers/message');

// Baileys is chatty; give it its own quiet logger.
const baileysLogger = pino({ level: 'silent' });

let presenceWarned = false;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(config.paths.auth);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false, // we render it ourselves below
    markOnlineOnConnect: false, // don't steal presence from your phone
    syncFullHistory: false,
  });

  // Convenience senders shared with the message handler.
  const send = async (jid, text) => {
    try {
      await sock.sendMessage(jid, { text });
    } catch (err) {
      logger.error({ err: err.message, jid }, 'failed to send message');
    }
  };
  const notifyOwner = async (text) => {
    const me = sock.user?.id;
    if (!me) return;
    // Message yourself (the linked account) so escalations land in your chat list.
    await send(me, text);
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Scan this QR code in WhatsApp → Linked devices → Link a device:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info(
        { user: sock.user?.id },
        `✅ Connected as ${config.owner.name}. Reply mode: ${config.reply.mode}.`,
      );
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (loggedOut) {
        logger.error('Logged out of WhatsApp. Delete the auth folder and re-link.');
        process.exit(1);
      } else {
        logger.warn({ code }, 'Connection closed — reconnecting...');
        setTimeout(start, 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // only fresh, real-time messages
    for (const msg of messages) {
      try {
        await handleMessage({ msg, send, notifyOwner });
      } catch (err) {
        logger.error({ err: err.message }, 'unhandled error in message handler');
      }
    }
    if (!presenceWarned) presenceWarned = true;
  });

  return sock;
}

module.exports = { start };
