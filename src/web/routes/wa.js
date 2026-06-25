'use strict';

const express = require('express');
const manager = require('../../wa/sessionManager');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

// Begin linking / connecting this user's WhatsApp. Returns initial state; the
// browser then polls GET /status to pick up the QR and the 'open' transition.
router.post('/start', async (req, res) => {
  try {
    const st = await manager.start(req.userId);
    res.json(st);
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'wa start failed');
    res.status(500).json({ error: 'Could not start WhatsApp session.' });
  }
});

// Disconnect but keep the link so it can resume later.
router.post('/stop', async (req, res) => {
  res.json(await manager.stop(req.userId));
});

// Fully unlink and delete the stored session.
router.post('/logout', async (req, res) => {
  res.json(await manager.logout(req.userId));
});

router.get('/status', (req, res) => {
  res.json(manager.state(req.userId));
});

module.exports = router;
