'use strict';

const users = require('../db/users');
const logger = require('../logger');

// Owner alerts for events they must act on (today: WhatsApp disconnected).
// Email goes out via Resend when RESEND_API_KEY is configured; the dashboard
// banner works regardless. Cooldown stops a flapping session from spamming.
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastAlertAt = new Map(); // `${userId}:${kind}` -> epoch ms

async function sendEmail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from = process.env.ALERT_FROM_EMAIL || 'FastLegal <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'alert email failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, 'alert email error');
    return false;
  }
}

const MESSAGES = {
  logged_out: {
    subject: '⚠️ Your WhatsApp got unlinked — your agent has stopped',
    text:
      'Your WhatsApp was logged out (unlinked from this device), so your AI agent has STOPPED '
      + 'replying to clients.\n\nOpen your dashboard → Connect → Link / Connect, and scan the QR '
      + 'again to bring it back online.',
  },
  closed: {
    subject: '⚠️ Your WhatsApp connection dropped — your agent is offline',
    text:
      'We lost the connection to your WhatsApp and automatic reconnection gave up, so your AI '
      + 'agent is OFFLINE and clients are not being answered.\n\nOpen your dashboard → Connect → '
      + 'Link / Connect to bring it back online.',
  },
};

// kind: 'logged_out' | 'closed'. Fire-and-forget; never throws.
async function disconnectAlert(userId, kind) {
  try {
    const key = `${userId}:${kind}`;
    const last = lastAlertAt.get(key) || 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    lastAlertAt.set(key, Date.now());
    if (lastAlertAt.size > 20_000) lastAlertAt.clear();

    const msg = MESSAGES[kind] || MESSAGES.closed;
    logger.warn({ userId, kind }, 'ALERT: WhatsApp session is down');
    const user = await users.findById(userId).catch(() => null);
    if (user && user.email) {
      const sent = await sendEmail(user.email, msg.subject, msg.text);
      if (sent) logger.info({ userId, to: user.email }, 'disconnect alert emailed');
    }
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'disconnect alert failed');
  }
}

module.exports = { disconnectAlert, sendEmail };
