'use strict';

const express = require('express');
const stats = require('../../db/stats');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

router.get('/overview', async (req, res) => {
  try {
    res.json(await stats.overview(req.userId, req.query.days));
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'stats overview failed');
    res.status(500).json({ error: 'Could not load statistics.' });
  }
});

module.exports = router;
