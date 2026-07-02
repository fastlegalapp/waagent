'use strict';

const express = require('express');
const team = require('../../db/team');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);
// requireAuth already blocks non-owners from /api/team entirely.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', async (req, res) => {
  try {
    res.json({ members: await team.listMembers(req.userId) });
  } catch (err) {
    logger.error({ err: err.message }, 'team list failed');
    res.status(500).json({ error: 'Could not load the team.' });
  }
});

router.post('/', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = String(req.body?.role || 'operator');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (email === String(req.userEmail || '').toLowerCase()) {
    return res.status(400).json({ error: "That's your own email — you're already the owner." });
  }
  try {
    await team.addMember(req.userId, email, role);
    res.json({ ok: true, members: await team.listMembers(req.userId) });
  } catch (err) {
    logger.error({ err: err.message }, 'team add failed');
    res.status(500).json({ error: 'Could not add the member.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await team.removeMember(req.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'team remove failed');
    res.status(500).json({ error: 'Could not remove the member.' });
  }
});

module.exports = router;
