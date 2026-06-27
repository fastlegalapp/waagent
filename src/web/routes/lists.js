'use strict';

const express = require('express');
const lists = require('../../db/lists');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

function fail(res, err, msg) {
  logger.error({ err: err.message }, msg);
  res.status(500).json({ error: msg });
}

// All lists (with item counts).
router.get('/', async (req, res) => {
  try {
    res.json({ lists: await lists.listLists(req.userId) });
  } catch (err) {
    fail(res, err, 'Could not load lists.');
  }
});

// Create a list.
router.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the list a name.' });
  try {
    res.json({ list: await lists.createList(req.userId, name) });
  } catch (err) {
    fail(res, err, 'Could not create the list.');
  }
});

// Update list (name / instructions / reminder config).
router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
  if (typeof b.instructions === 'string') patch.instructions = b.instructions;
  if (typeof b.reminderEnabled === 'boolean') patch.reminder_enabled = b.reminderEnabled;
  if (typeof b.reminderDateField === 'string') patch.reminder_date_field = b.reminderDateField.trim();
  if (typeof b.reminderPhoneField === 'string') patch.reminder_phone_field = b.reminderPhoneField.trim();
  if (typeof b.reminderTemplate === 'string') patch.reminder_template = b.reminderTemplate;
  if (b.reminderDaysBefore != null) patch.reminder_days_before = b.reminderDaysBefore;
  try {
    const list = await lists.updateList(req.userId, req.params.id, patch);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    res.json({ list });
  } catch (err) {
    fail(res, err, 'Could not save the list.');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await lists.deleteList(req.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Could not delete the list.');
  }
});

// Items in a list.
router.get('/:id/items', async (req, res) => {
  try {
    res.json({ items: await lists.listItems(req.userId, req.params.id) });
  } catch (err) {
    fail(res, err, 'Could not load items.');
  }
});

// Add items: body { items: [ {field: value}, ... ] }. Optional replace=true clears first.
router.post('/:id/items', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ error: 'No rows to add.' });
  if (items.length > 5000) return res.status(400).json({ error: 'Too many rows at once (max 5000).' });
  try {
    if (req.body?.replace === true) await lists.clearItems(req.userId, req.params.id);
    const added = await lists.addItems(req.userId, req.params.id, items);
    res.json({ ok: true, added, items: await lists.listItems(req.userId, req.params.id) });
  } catch (err) {
    fail(res, err, 'Could not add items.');
  }
});

router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    await lists.deleteItem(req.userId, req.params.itemId);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Could not delete the item.');
  }
});

module.exports = router;
