'use strict';

const { query } = require('./pool');

// Columns a user is allowed to update via the settings API.
const UPDATABLE = new Set([
  'owner_name',
  'business_name',
  'business_description',
  'persona_style',
  'persona_custom',
  'provider',
  'anthropic_api_key_enc',
  'anthropic_model',
  'deepseek_api_key_enc',
  'deepseek_model',
  'reply_mode',
  'allowlist',
  'blocklist',
  'ignore_groups',
  'min_interval_seconds',
  'followups_enabled',
  'followups_hours',
  'business_hours_start',
  'business_hours_end',
]);

async function getRaw(userId) {
  const { rows } = await query(
    `SELECT * FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  return rows[0] || null;
}

async function update(userId, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (keys.length === 0) return getRaw(userId);

  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => patch[k]);
  const sql = `
    UPDATE user_settings
    SET ${sets.join(', ')}, updated_at = now()
    WHERE user_id = $1
    RETURNING *`;
  const { rows } = await query(sql, [userId, ...values]);
  return rows[0] || null;
}

async function setLearnedStyle(userId, learnedStyle) {
  await query(
    `UPDATE user_settings
     SET learned_style = $2, learned_style_at = now(), updated_at = now()
     WHERE user_id = $1`,
    [userId, learnedStyle],
  );
}

async function listUserIds() {
  const { rows } = await query(`SELECT user_id FROM user_settings`);
  return rows.map((r) => r.user_id);
}

module.exports = { getRaw, update, setLearnedStyle, listUserIds };
