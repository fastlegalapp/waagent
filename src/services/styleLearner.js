'use strict';

const mem = require('../db/messages');
const settingsDb = require('../db/settings');
const userConfig = require('./userConfig');
const agent = require('../agent/agent');
const logger = require('../logger');

// Need at least this many of the owner's own messages before learning a style.
const MIN_SAMPLES = 8;

async function learnForUser(userId) {
  const settings = await userConfig.resolve(userId);
  if (!settings) return { ok: false, error: 'No settings found.' };
  if (!settings.ai.apiKey) {
    return { ok: false, error: 'No API key set for the selected provider.' };
  }
  const samples = await mem.getOwnerSamples(userId, 120);
  if (samples.length < MIN_SAMPLES) {
    return {
      ok: false,
      samples: samples.length,
      error:
        `Not enough of your own messages yet (have ${samples.length}, need ${MIN_SAMPLES}). ` +
        `Re-link WhatsApp to import more history, or reply to a few clients yourself — it learns from those.`,
    };
  }
  const style = await agent.learnStyle(settings, samples);
  if (!style) return { ok: false, error: 'Could not generate a style summary.' };
  await settingsDb.setLearnedStyle(userId, style);
  logger.info({ userId, samples: samples.length }, 'learned owner style');
  return { ok: true, samples: samples.length, style };
}

// Re-learn for everyone (daily job) so the agent matures as more chats arrive.
async function learnForAll() {
  let ids = [];
  try {
    ids = await settingsDb.listUserIds();
  } catch (err) {
    logger.warn({ err: err.message }, 'style-learn: could not list users');
    return;
  }
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await learnForUser(id);
    } catch (err) {
      logger.warn({ userId: id, err: err.message }, 'auto style-learn failed');
    }
  }
}

module.exports = { learnForUser, learnForAll, MIN_SAMPLES };
