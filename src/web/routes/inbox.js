'use strict';

const express = require('express');
const mem = require('../../db/messages');
const manager = require('../../wa/sessionManager');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

router.get('/chats', async (req, res) => {
  try {
    res.json({ chats: await mem.listChats(req.userId) });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'inbox chats failed');
    res.status(500).json({ error: 'Could not load conversations.' });
  }
});

router.get('/thread', async (req, res) => {
  const chatId = String(req.query.chatId || '');
  if (!chatId) return res.status(400).json({ error: 'chatId required.' });
  try {
    res.json({ messages: await mem.getThread(req.userId, chatId) });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'inbox thread failed');
    res.status(500).json({ error: 'Could not load the conversation.' });
  }
});

// Owner sends a message from the dashboard. Stored as source 'owner' so the
// agent's style learner treats it as the owner's own words.
router.post('/send', async (req, res) => {
  const chatId = String(req.body?.chatId || '');
  const text = String(req.body?.text || '').trim();
  if (!chatId || !text) return res.status(400).json({ error: 'Message is empty.' });
  if (!manager.isOpen(req.userId)) return res.status(409).json({ error: 'WhatsApp is not connected.' });
  try {
    const out = await manager.sendText(req.userId, chatId, text);
    if (!out) return res.status(502).json({ error: 'Could not send the message.' });
    await mem.appendMessage(req.userId, chatId, 'assistant', text, {
      waMsgId: out?.key?.id,
      ts: Math.floor(Date.now() / 1000),
      source: 'owner',
    });
    // Counts as "we replied" for follow-up logic.
    mem.setLastReplyAt(req.userId, chatId, Date.now()).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'inbox send failed');
    res.status(500).json({ error: 'Could not send the message.' });
  }
});

module.exports = router;
