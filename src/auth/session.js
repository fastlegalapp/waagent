'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('../config');

const COOKIE = 'waagent_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

// Express middleware: require a valid session, set req.userId / req.userEmail.
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, config.sessionSecret);
    req.userId = payload.sub;
    req.userEmail = payload.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired' });
  }
}

module.exports = { issue, clear, requireAuth, COOKIE };
