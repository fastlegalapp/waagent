'use strict';

const settingsDb = require('../db/settings');
const { decrypt } = require('../auth/crypto');

function parseList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean);
}

// FAQs are stored as a JSON string [{q,a}]. Parse defensively — bad/legacy data
// must never break settings loading.
function parseFaqs(value) {
  if (Array.isArray(value)) return value;
  try {
    const arr = JSON.parse(value || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .map((f) => ({ q: String(f?.q || '').trim(), a: String(f?.a || '').trim() }))
      .filter((f) => f.q && f.a);
  } catch (_) {
    return [];
  }
}

// Resolve a user's stored settings into the runtime config the agent + message
// handler expect. Includes the DECRYPTED Anthropic key — never send this to the
// browser; use sanitize() for that.
async function resolve(userId) {
  const row = await settingsDb.getRaw(userId);
  if (!row) return null;
  const provider = (row.provider || 'anthropic').toLowerCase();
  // The active AI backend for this user (provider + decrypted key + model).
  const ai =
    provider === 'deepseek'
      ? {
          provider,
          apiKey: decrypt(row.deepseek_api_key_enc) || '',
          model: row.deepseek_model || 'deepseek-chat',
        }
      : {
          provider: 'anthropic',
          apiKey: decrypt(row.anthropic_api_key_enc) || '',
          model: row.anthropic_model || 'claude-opus-4-8',
        };
  return {
    userId,
    owner: {
      name: row.owner_name || 'the owner',
      business: row.business_name || '',
      description: row.business_description || '',
      style: row.persona_style || 'friendly',
      custom: row.persona_custom || '',
      faqs: parseFaqs(row.faqs),
      learnedStyle: row.learned_style || '',
    },
    ai,
    reply: {
      mode: (row.reply_mode || 'off').toLowerCase(),
      allowlist: parseList(row.allowlist),
      blocklist: parseList(row.blocklist),
      ignoreGroups: row.ignore_groups !== false,
      minIntervalSeconds: Number(row.min_interval_seconds || 2),
      delayMinSeconds: Number(row.reply_delay_min_seconds ?? 2),
      delayMaxSeconds: Number(row.reply_delay_max_seconds ?? 6),
      businessHoursStart: row.business_hours_start,
      businessHoursEnd: row.business_hours_end,
      followups: {
        enabled: row.followups_enabled === true,
        hours: Number(row.followups_hours || 24),
      },
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
    personaStyle: row.persona_style || 'friendly',
    personaCustom: row.persona_custom || '',
    faqs: parseFaqs(row.faqs),
    learnedStyle: row.learned_style || '',
    learnedStyleAt: row.learned_style_at || null,
    provider: row.provider || 'anthropic',
    hasApiKey: Boolean(row.anthropic_api_key_enc),
    model: row.anthropic_model,
    hasDeepseekKey: Boolean(row.deepseek_api_key_enc),
    deepseekModel: row.deepseek_model || 'deepseek-chat',
    replyMode: row.reply_mode,
    allowlist: row.allowlist,
    blocklist: row.blocklist,
    ignoreGroups: row.ignore_groups,
    minIntervalSeconds: row.min_interval_seconds,
    replyDelayMin: row.reply_delay_min_seconds ?? 2,
    replyDelayMax: row.reply_delay_max_seconds ?? 6,
    followupsEnabled: row.followups_enabled === true,
    followupsHours: Number(row.followups_hours || 24),
    businessHoursStart: row.business_hours_start,
    businessHoursEnd: row.business_hours_end,
  };
}

module.exports = { resolve, sanitize, parseList, parseFaqs };
