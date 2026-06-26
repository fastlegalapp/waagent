'use strict';

require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  // PostgreSQL connection string, e.g.
  // postgres://user:pass@localhost:5432/waagent
  databaseUrl: process.env.DATABASE_URL || '',

  // Secret for signing login (JWT) cookies. Any long random string.
  sessionSecret: process.env.SESSION_SECRET || '',

  // Secret used to encrypt each user's Anthropic API key at rest.
  // Any long random string; changing it makes stored keys undecryptable.
  encryptionKey: process.env.ENCRYPTION_KEY || '',

  // Where per-user WhatsApp link sessions are stored on disk.
  authRoot: process.env.AUTH_ROOT || './auth',

  // Default Claude model offered to new users.
  defaultModel: process.env.DEFAULT_MODEL || 'claude-opus-4-8',

  // Set true behind HTTPS so the login cookie is marked Secure.
  cookieSecure: (process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true',

  // Delete stored chat messages older than this many days, so the table
  // doesn't grow forever. 0 (or negative) disables pruning.
  messageRetentionDays: Number(process.env.MESSAGE_RETENTION_DAYS || 90),
};

function validate() {
  const errors = [];
  if (!config.databaseUrl) errors.push('DATABASE_URL is not set.');
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    errors.push('SESSION_SECRET is missing or too short (use 16+ characters).');
  }
  if (!config.encryptionKey || config.encryptionKey.length < 16) {
    errors.push('ENCRYPTION_KEY is missing or too short (use 16+ characters).');
  }
  return errors;
}

module.exports = { config, validate };
