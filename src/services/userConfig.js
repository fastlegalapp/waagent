'use strict';

const settingsDb = require('../db/settings');
const { decrypt } = require('../auth/crypto');

function parseList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean);
}

// Resolve a user's stored settings into the runtime config the agent + message
// handler expect. Includes the DECRYPTED Anthropic key — never send this to the
// browser; use sanitize() for that.
async function resolve(userId) {
  const row = await settingsDb.getRaw(userId);
  if (!row) return null;
  return {
    userId,
    owner: {
      name: row.owner_name || 'the owner',
      business: row.business_name || '',
      description: row.business_description || '',
    },
    anthropic: {
      apiKey: decrypt(row.anthropic_api_key_enc) || '',
      model: row.anthropic_model || 'claude-opus-4-8',
    },
    reply: {
      mode: (row.reply_mode || 'off').toLowerCase(),
      allowlist: parseList(row.allowlist),
      blocklist: parseList(row.blocklist),
      ignoreGroups: row.ignore_groups !== false,
      minIntervalSeconds: Number(row.min_interval_seconds || 2),
      businessHoursStart: row.business_hours_start,
      businessHoursEnd: row.business_hours_end,
    },
  };
}

// A browser-safe view of settings: no decrypted key, just whether one is set.
async function sanitize(userId) {
  const row = await settingsDb.getRaw(userId);
  if (!row) return null;
  return {
    ownerName: row.owner_name,
    businessName: row.business_name,
    businessDescription: row.business_description,
    hasApiKey: Boolean(row.anthropic_api_key_enc),
    model: row.anthropic_model,
    replyMode: row.reply_mode,
    allowlist: row.allowlist,
    blocklist: row.blocklist,
    ignoreGroups: row.ignore_groups,
    minIntervalSeconds: row.min_interval_seconds,
    businessHoursStart: row.business_hours_start,
    businessHoursEnd: row.business_hours_end,
  };
}

module.exports = { resolve, sanitize, parseList };
