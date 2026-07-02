'use strict';

const crypto = require('crypto');
const settingsDb = require('../db/settings');
const logger = require('../logger');

// Outbound webhooks: POST {event, data, ts} to the owner's URL on business
// events (new lead, new order, order paid). Fire-and-forget with a short
// timeout; a dead endpoint never affects message handling.

// Block URLs that point into private/internal networks (we make the request,
// so an arbitrary URL would let a user probe our network).
function isSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

async function fire(userId, event, data) {
  try {
    const row = await settingsDb.getRaw(userId);
    const url = row && row.webhook_url;
    if (!url || !isSafeUrl(url)) return;
    const body = JSON.stringify({ event, data, ts: Date.now() });
    const headers = { 'content-type': 'application/json', 'user-agent': 'FastLegal-Webhook/1' };
    // Sign the payload so the receiver can verify it's really us.
    if (row.webhook_secret) {
      headers['x-fastlegal-signature'] = crypto
        .createHmac('sha256', row.webhook_secret)
        .update(body)
        .digest('hex');
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn({ userId, event, status: res.status }, 'webhook non-2xx');
  } catch (err) {
    logger.warn({ userId, event, err: err.message }, 'webhook failed');
  }
}

module.exports = { fire, isSafeUrl };
