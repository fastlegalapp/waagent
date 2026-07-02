'use strict';

const { query } = require('../db/pool');
const logger = require('../logger');

// Anti-ban governor for BULK sends (broadcasts, reminders, follow-ups).
// WhatsApp bans numbers that blast messages like a bot, and a banned number is
// catastrophic for the owner — so bulk traffic is paced and capped:
//   - spacing: one bulk message every ~4-7s per account (randomized)
//   - daily cap with warm-up: young accounts get a small allowance that grows
// Organic 1:1 replies are NOT throttled here (they're already humanized by the
// reply-delay/gather logic and follow the client's own pace).

const MIN_GAP_MS = 4000;
const GAP_JITTER_MS = 3000;

// Daily bulk-send allowance by account age (days since signup).
function dailyCapFor(ageDays) {
  const override = Number(process.env.BULK_DAILY_CAP || 0);
  if (override > 0) return override;
  if (ageDays < 7) return 100;
  if (ageDays < 30) return 250;
  return 500;
}

const state = new Map(); // userId -> { lastSentAt, day, sentToday, ageDays, ageAt }
function st(userId) {
  let s = state.get(userId);
  if (!s) {
    s = { lastSentAt: 0, day: '', sentToday: 0, ageDays: null, ageAt: 0 };
    state.set(userId, s);
    if (state.size > 20_000) state.clear();
  }
  return s;
}

async function ageDaysFor(userId) {
  const s = st(userId);
  if (s.ageDays != null && Date.now() - s.ageAt < 6 * 3600 * 1000) return s.ageDays;
  try {
    const { rows } = await query(`SELECT created_at FROM users WHERE id = $1`, [userId]);
    const created = rows[0] ? new Date(rows[0].created_at).getTime() : Date.now();
    s.ageDays = Math.floor((Date.now() - created) / 86400000);
  } catch (_) {
    s.ageDays = 30; // unknown → assume mature rather than blocking
  }
  s.ageAt = Date.now();
  return s.ageDays;
}

// Claim one bulk-send slot. Returns { ok } or { ok:false, reason, cap }.
async function take(userId) {
  const s = st(userId);
  const today = new Date().toISOString().slice(0, 10);
  if (s.day !== today) {
    s.day = today;
    s.sentToday = 0;
  }
  const cap = dailyCapFor(await ageDaysFor(userId));
  if (s.sentToday >= cap) {
    return { ok: false, cap, reason: `daily bulk-message limit reached (${cap}/day — grows as your account matures)` };
  }
  s.sentToday += 1;
  return { ok: true, cap, remaining: cap - s.sentToday };
}

// Wait until this account may send its next bulk message (randomized spacing).
async function gate(userId) {
  const s = st(userId);
  const gap = MIN_GAP_MS + Math.random() * GAP_JITTER_MS;
  const wait = Math.max(0, s.lastSentAt + gap - Date.now());
  // Reserve the slot BEFORE sleeping so concurrent bulk jobs space out too.
  s.lastSentAt = Date.now() + wait;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function bulkStats(userId) {
  const s = st(userId);
  return { sentToday: s.sentToday, day: s.day };
}

module.exports = { take, gate, dailyCapFor, bulkStats };
