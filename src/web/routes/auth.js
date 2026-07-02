'use strict';

const express = require('express');
const users = require('../../db/users');
const password = require('../../auth/password');
const session = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple in-memory fixed-window rate limiter to blunt credential-stuffing and
// signup abuse. Keyed by client IP; bounded so it can't grow without limit.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 20;
const RL_MAX_KEYS = 10_000;
const attempts = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + WINDOW_MS };
    if (attempts.size > RL_MAX_KEYS) attempts.clear(); // crude bound; resets all windows
    attempts.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count > MAX_ATTEMPTS) {
    const retry = Math.ceil((rec.resetAt - now) / 1000);
    res.set('Retry-After', String(retry));
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  return next();
}

router.post('/signup', rateLimit, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const pw = String(req.body?.password || '');

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const existing = await users.findByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

    const hash = await password.hash(pw);
    const user = await users.createUser(email, hash);
    session.issue(res, user);
    return res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    logger.error({ err: err.message }, 'signup failed');
    return res.status(500).json({ error: 'Could not create account.' });
  }
});

router.post('/login', rateLimit, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const pw = String(req.body?.password || '');
  try {
    const user = await users.findByEmail(email);
    const ok = user && (await password.verify(pw, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

    session.issue(res, user);
    return res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    logger.error({ err: err.message }, 'login failed');
    return res.status(500).json({ error: 'Could not sign in.' });
  }
});

router.post('/logout', (req, res) => {
  session.clear(res);
  res.json({ ok: true });
});

router.get('/me', session.requireAuth, async (req, res) => {
  const user = await users.findById(req.actorId || req.userId);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: { id: user.id, email: user.email }, role: req.role || 'owner' });
});

module.exports = router;
