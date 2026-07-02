'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('../config');
const team = require('../db/team');

const COOKIE = 'waagent_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Team-membership lookups are cached briefly so every API call doesn't hit the
// database. Bounded; entries expire after a minute (role changes apply fast).
const MEMBER_TTL_MS = 60 * 1000;
const memberCache = new Map(); // email -> { at, membership }
async function cachedMembership(email) {
  const hit = memberCache.get(email);
  if (hit && Date.now() - hit.at < MEMBER_TTL_MS) return hit.membership;
  const membership = await team.membershipFor(email).catch(() => null);
  memberCache.set(email, { at: Date.now(), membership });
  if (memberCache.size > 10_000) memberCache.clear();
  return membership;
}

function issue(res, user) {
  const token = jwt.sign({ sub: user.id, email: user.email }, config.sessionSecret, {
    expiresIn: '7d',
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: MAX_AGE_MS,
  });
}

function clear(res) {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
  });
}

// Paths a non-owner may still write to (their own session).
const MEMBER_WRITE_OK = /^\/api\/auth\//;
// Workspace areas only the owner may touch at all.
const OWNER_ONLY = /^\/api\/(team|billing(?!\/status))/;

// Express middleware: require a valid session. Sets:
//   req.actorId / req.userEmail — the signed-in account
//   req.userId                  — the WORKSPACE the request operates on
//   req.role                    — 'owner' | 'operator' | 'viewer'
// Team members act on their owner's workspace with role-based limits:
// viewers are read-only; operators can't manage team/billing/settings.
async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  let payload;
  try {
    payload = jwt.verify(token, config.sessionSecret);
  } catch (err) {
    return res.status(401).json({ error: 'Session expired' });
  }
  req.actorId = payload.sub;
  req.userId = payload.sub;
  req.userEmail = payload.email;
  req.role = 'owner';
  try {
    const membership = await cachedMembership(String(payload.email || '').toLowerCase());
    if (membership) {
      req.userId = membership.ownerId;
      req.role = membership.role === 'viewer' ? 'viewer' : 'operator';
    }
  } catch (_) {
    /* membership lookup is best-effort; default to own workspace */
  }
  if (req.role !== 'owner') {
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const path = req.baseUrl + (req.path === '/' ? '' : req.path);
    if (OWNER_ONLY.test(path)) {
      return res.status(403).json({ error: 'Only the workspace owner can do this.' });
    }
    if (req.role === 'viewer' && writing && !MEMBER_WRITE_OK.test(path)) {
      return res.status(403).json({ error: 'Your access is view-only.' });
    }
    if (req.role === 'operator' && writing && /^\/api\/settings/.test(path)) {
      return res.status(403).json({ error: 'Only the workspace owner can change settings.' });
    }
  }
  next();
}

module.exports = { issue, clear, requireAuth, COOKIE };
