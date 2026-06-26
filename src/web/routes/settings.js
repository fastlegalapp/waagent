'use strict';

const express = require('express');
const settingsDb = require('../../db/settings');
const userConfig = require('../../services/userConfig');
const agent = require('../../agent/agent');
const styleLearner = require('../../services/styleLearner');

const STYLE_KEYS = agent.STYLE_KEYS;
const { encrypt } = require('../../auth/crypto');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

// Verify the saved key for the active provider actually works (present,
// decryptable, valid). Great for diagnosing "my key didn't persist".
router.post('/test', async (req, res) => {
  try {
    const resolved = await userConfig.resolve(req.userId);
    if (!resolved) return res.status(404).json({ ok: false, error: 'No settings found.' });
    const result = await agent.testKey(resolved);
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'key test failed');
    res.status(500).json({ ok: false, error: 'Could not run the test.' });
  }
});

router.get('/', async (req, res) => {
  const view = await userConfig.sanitize(req.userId);
  if (!view) return res.status(404).json({ error: 'No settings found.' });
  res.json({ settings: view });
});

// Learn how the owner talks from their real past messages, now.
router.post('/learn-style', async (req, res) => {
  try {
    const result = await styleLearner.learnForUser(req.userId);
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'learn-style failed');
    res.status(500).json({ ok: false, error: 'Could not learn the style.' });
  }
});

router.put('/', async (req, res) => {
  const b = req.body || {};
  const patch = {};

  if (typeof b.ownerName === 'string') patch.owner_name = b.ownerName.slice(0, 200);
  if (typeof b.businessName === 'string') patch.business_name = b.businessName.slice(0, 200);
  if (typeof b.businessDescription === 'string') {
    patch.business_description = b.businessDescription.slice(0, 2000);
  }
  if (typeof b.personaStyle === 'string' && STYLE_KEYS.includes(b.personaStyle)) {
    patch.persona_style = b.personaStyle;
  }
  if (typeof b.personaCustom === 'string') {
    patch.persona_custom = b.personaCustom.slice(0, 2000);
  }
  // FAQs: array of {q,a}. Trim, cap sizes, drop blanks, limit count.
  if (Array.isArray(b.faqs)) {
    const faqs = b.faqs
      .slice(0, 40)
      .map((f) => ({
        q: String(f?.q || '').trim().slice(0, 200),
        a: String(f?.a || '').trim().slice(0, 1000),
      }))
      .filter((f) => f.q && f.a);
    patch.faqs = JSON.stringify(faqs);
  }
  if (typeof b.model === 'string' && b.model) patch.anthropic_model = b.model.slice(0, 100);

  if (b.provider === 'anthropic' || b.provider === 'deepseek') patch.provider = b.provider;
  if (typeof b.deepseekModel === 'string' && b.deepseekModel) {
    patch.deepseek_model = b.deepseekModel.slice(0, 100);
  }

  if (b.replyMode === 'auto' || b.replyMode === 'off') patch.reply_mode = b.replyMode;
  if (typeof b.allowlist === 'string') patch.allowlist = b.allowlist.slice(0, 2000);
  if (typeof b.blocklist === 'string') patch.blocklist = b.blocklist.slice(0, 2000);
  if (typeof b.ignoreGroups === 'boolean') patch.ignore_groups = b.ignoreGroups;
  if (Number.isInteger(b.minIntervalSeconds)) {
    patch.min_interval_seconds = Math.max(0, Math.min(3600, b.minIntervalSeconds));
  }
  // Reply delay range (human-like pause before replying). Clamp 0–120s and
  // keep max >= min so the range is always valid.
  if (Number.isInteger(b.replyDelayMin)) {
    patch.reply_delay_min_seconds = Math.max(0, Math.min(120, b.replyDelayMin));
  }
  if (Number.isInteger(b.replyDelayMax)) {
    patch.reply_delay_max_seconds = Math.max(0, Math.min(120, b.replyDelayMax));
  }
  if (patch.reply_delay_min_seconds != null || patch.reply_delay_max_seconds != null) {
    const lo = patch.reply_delay_min_seconds;
    const hi = patch.reply_delay_max_seconds;
    if (lo != null && hi != null && hi < lo) patch.reply_delay_max_seconds = lo;
  }
  if (typeof b.followupsEnabled === 'boolean') patch.followups_enabled = b.followupsEnabled;
  if (Number.isInteger(b.followupsHours)) {
    patch.followups_hours = Math.max(1, Math.min(720, b.followupsHours));
  }
  // Business hours: accept integer 0-23 or null to clear.
  if (b.businessHoursStart === null || Number.isInteger(b.businessHoursStart)) {
    patch.business_hours_start =
      b.businessHoursStart === null ? null : Math.max(0, Math.min(23, b.businessHoursStart));
  }
  if (b.businessHoursEnd === null || Number.isInteger(b.businessHoursEnd)) {
    patch.business_hours_end =
      b.businessHoursEnd === null ? null : Math.max(0, Math.min(23, b.businessHoursEnd));
  }

  // API keys: only update if provided. Empty string clears.
  if (typeof b.apiKey === 'string') {
    patch.anthropic_api_key_enc = b.apiKey.trim() ? encrypt(b.apiKey.trim()) : null;
  }
  if (typeof b.deepseekApiKey === 'string') {
    patch.deepseek_api_key_enc = b.deepseekApiKey.trim() ? encrypt(b.deepseekApiKey.trim()) : null;
  }

  try {
    await settingsDb.update(req.userId, patch);
    const view = await userConfig.sanitize(req.userId);
    res.json({ ok: true, settings: view });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'settings update failed');
    res.status(500).json({ error: 'Could not save settings.' });
  }
});

module.exports = router;
