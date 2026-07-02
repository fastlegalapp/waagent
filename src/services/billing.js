'use strict';

const crypto = require('crypto');
const { config } = require('../config');
const { query } = require('../db/pool');
const logger = require('../logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_DAYS = { monthly: 31, yearly: 366 }; // a day's grace on each

// Billing is optional: with no Razorpay keys configured, everyone is treated
// as permanently active (self-hosted / pre-revenue mode).
function enabled() {
  return Boolean(config.razorpayKeyId && config.razorpayKeySecret);
}

// A user's billing status, derived from signup date (trial) + paid_until.
async function statusFor(userId) {
  if (!enabled()) return { enabled: false, active: true, plan: 'free', daysLeft: null };
  const { rows } = await query(
    `SELECT u.created_at, s.plan, s.paid_until
       FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  if (!rows[0]) return { enabled: true, active: false, plan: 'none', daysLeft: 0 };
  const r = rows[0];
  const now = Date.now();
  const paidUntil = r.paid_until ? new Date(r.paid_until).getTime() : 0;
  if (paidUntil > now) {
    return {
      enabled: true, active: true, plan: r.plan || 'monthly',
      paidUntil, daysLeft: Math.ceil((paidUntil - now) / DAY_MS),
    };
  }
  const trialEnds = new Date(r.created_at).getTime() + config.trialDays * DAY_MS;
  if (trialEnds > now) {
    return {
      enabled: true, active: true, plan: 'trial',
      trialEndsAt: trialEnds, daysLeft: Math.ceil((trialEnds - now) / DAY_MS),
    };
  }
  return { enabled: true, active: false, plan: 'expired', daysLeft: 0 };
}

// Fast gate for the message path. Fails OPEN on db errors so a billing hiccup
// never silences a paying user's agent.
async function isActive(userId) {
  try {
    return (await statusFor(userId)).active;
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'billing check failed — allowing');
    return true;
  }
}

function planAmountPaise(plan) {
  return plan === 'yearly' ? config.priceYearlyPaise : config.priceMonthlyPaise;
}

// Create a Razorpay order for checkout (REST, no SDK dependency).
async function createOrder(userId, plan) {
  const amount = planAmountPaise(plan);
  const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({
      amount,
      currency: 'INR',
      receipt: `${userId.slice(0, 20)}-${plan}`,
      notes: { user_id: userId, plan },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body: body.slice(0, 300) }, 'razorpay order create failed');
    throw new Error('Could not start the payment. Try again.');
  }
  const order = await res.json();
  return { orderId: order.id, amount, currency: 'INR', keyId: config.razorpayKeyId };
}

// Verify the checkout signature: HMAC-SHA256(order_id|payment_id, key_secret).
function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac('sha256', config.razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Verify a webhook payload signature (raw body + webhook secret).
function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpayWebhookSecret) return false;
  const expected = crypto
    .createHmac('sha256', config.razorpayWebhookSecret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Record a successful payment and extend access. Idempotent on payment_id, so
// the checkout callback and the webhook can both fire safely.
async function activate(userId, { plan, paymentId, orderId, amountPaise }) {
  const p = plan === 'yearly' ? 'yearly' : 'monthly';
  const ins = await query(
    `INSERT INTO billing_payments (user_id, payment_id, order_id, plan, amount_paise)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, payment_id) DO NOTHING
     RETURNING id`,
    [userId, String(paymentId), String(orderId || ''), p, amountPaise || planAmountPaise(p)],
  );
  if (ins.rows.length === 0) return statusFor(userId); // already processed
  // Extend from paid_until if still in the future (renewal), else from now.
  await query(
    `UPDATE user_settings
        SET plan = $2,
            paid_until = GREATEST(COALESCE(paid_until, now()), now()) + make_interval(days => $3),
            updated_at = now()
      WHERE user_id = $1`,
    [userId, p, PLAN_DAYS[p]],
  );
  logger.info({ userId, plan: p, paymentId }, 'subscription activated');
  return statusFor(userId);
}

module.exports = {
  enabled,
  statusFor,
  isActive,
  createOrder,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  activate,
  planAmountPaise,
};
