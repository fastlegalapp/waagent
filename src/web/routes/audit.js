'use strict';

const express = require('express');
const audit = require('../../db/audit');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    res.json({
      events: await audit.recent(req.userId, {
        chatId: req.query.chatId ? String(req.query.chatId) : undefined,
        phone: req.query.phone ? String(req.query.phone) : undefined,
        limit: parseInt(req.query.limit, 10) || 50,
      }),
    });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'audit list failed');
    res.status(500).json({ error: 'Could not load activity.' });
  }
});

module.exports = router;
