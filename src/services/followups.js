'use strict';

const mem = require('../db/messages');
const settingsDb = require('../db/settings');
const userConfig = require('../services/userConfig');
const agent = require('../agent/agent');
const manager = require('../wa/sessionManager');
const logger = require('../logger');

const MAX_PER_RUN = 20; // safety cap per user per run

// For one user: find quiet chats past the cutoff and send a single, natural
// follow-up in the owner's style.
async function runForUser(userId) {
  const settings = await userConfig.resolve(userId);
  if (!settings) return;
  if (!settings.reply.followups.enabled) return;
  if (!settings.ai.apiKey) return;
  if (!manager.isOpen(userId)) return; // only when their WhatsApp is connected

  const cutoff = Date.now() - settings.reply.followups.hours * 3600 * 1000;
  let chats = [];
  try {
    chats = await mem.getFollowupCandidates(userId, cutoff);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'follow-up candidate query failed');
    return;
  }

  let sent = 0;
  for (const chatId of chats) {
    if (sent >= MAX_PER_RUN) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      const history = await mem.getHistory(userId, chatId);
      if (!history.length) {
        await mem.markFollowupDone(userId, chatId);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const text = await agent.composeFollowup(settings, history);
      if (!text) {
        await mem.markFollowupDone(userId, chatId); // don't retry endlessly
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const out = await manager.sendText(userId, chatId, text);
      // eslint-disable-next-line no-await-in-loop
      await mem.markFollowupDone(userId, chatId);
      if (out) {
        // eslint-disable-next-line no-await-in-loop
        await mem.appendMessage(userId, chatId, 'assistant', text, {
          waMsgId: out?.key?.id,
          ts: Math.floor(Date.now() / 1000),
          source: 'bot',
        });
        sent += 1;
      }
    } catch (err) {
      logger.warn({ userId, chatId, err: err.message }, 'follow-up send failed');
    }
  }
  if (sent) logger.info({ userId, sent }, 'sent follow-ups');
}

async function runForAll() {
  let ids = [];
  try {
    ids = await settingsDb.listUserIds();
  } catch (err) {
    logger.warn({ err: err.message }, 'follow-ups: could not list users');
    return;
  }
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runForUser(id);
    } catch (err) {
      logger.warn({ userId: id, err: err.message }, 'follow-up run failed');
    }
  }
}

module.exports = { runForUser, runForAll };
