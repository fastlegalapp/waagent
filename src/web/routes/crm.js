'use strict';

const express = require('express');
const crm = require('../../db/crm');
const settingsDb = require('../../db/settings');
const manager = require('../../wa/sessionManager');
const mem = require('../../db/messages');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

const BROADCAST_CAP = 200;

function fail(res, err, msg) {
  logger.error({ err: err.message }, msg);
  res.status(500).json({ error: msg });
}

function jidFor(contact) {
  if (contact.chatId && /@/.test(contact.chatId)) return contact.chatId;
  const digits = String(contact.phone || '').replace(/[^0-9]/g, '');
  return digits.length >= 7 ? `${digits}@s.whatsapp.net` : null;
}

// Fill {name} / {business} placeholders. Falls back to a friendly default name.
function fillMessage(tpl, contact, business) {
  return String(tpl || '')
    .replace(/\{name\}/gi, contact.name || 'there')
    .replace(/\{business\}/gi, business || '')
    .trim();
}

// One message to one contact's WhatsApp, stored in history like any other reply.
async function sendToContact(userId, contact, body) {
  const jid = jidFor(contact);
  if (!jid) return false;
  const out = await manager.sendText(userId, jid, body);
  if (!out) return false;
  mem
    .appendMessage(userId, contact.chatId || jid, 'assistant', body, {
      waMsgId: out?.key?.id,
      ts: Math.floor(Date.now() / 1000),
      source: 'owner',
    })
    .catch(() => {});
  return true;
}

// List contacts (optionally filtered by stage / search) plus pipeline stats.
router.get('/contacts', async (req, res) => {
  try {
    const [contacts, pipeline] = await Promise.all([
      crm.listContacts(req.userId, { stage: req.query.stage, q: req.query.q }),
      crm.stats(req.userId),
    ]);
    res.json({ contacts, stats: pipeline });
  } catch (err) {
    fail(res, err, 'Could not load contacts.');
  }
});

// Update a contact (name / notes / value / tags / stage).
router.patch('/contacts/:id', async (req, res) => {
  try {
    const contact = await crm.updateContact(req.userId, req.params.id, req.body || {});
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    res.json({ contact });
  } catch (err) {
    fail(res, err, 'Could not update the contact.');
  }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    await crm.deleteContact(req.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Could not delete the contact.');
  }
});

// Send a one-off message to a single contact.
router.post('/contacts/:id/message', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message is empty.' });
  if (!manager.isOpen(req.userId)) return res.status(409).json({ error: 'WhatsApp is not connected.' });
  try {
    const contact = await crm.getContact(req.userId, req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    const row = await settingsDb.getRaw(req.userId);
    const body = fillMessage(text, contact, row && row.business_name);
    const sent = await sendToContact(req.userId, contact, body);
    if (!sent) return res.status(502).json({ error: 'Could not send the message.' });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Could not send the message.');
  }
});

// Broadcast a stage message to everyone currently in that stage (capped).
router.post('/broadcast', async (req, res) => {
  const stage = String(req.body?.stage || '');
  const text = String(req.body?.text || '').trim();
  if (!crm.STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage.' });
  if (!text) return res.status(400).json({ error: 'Message is empty.' });
  if (!manager.isOpen(req.userId)) return res.status(409).json({ error: 'WhatsApp is not connected.' });
  try {
    const row = await settingsDb.getRaw(req.userId);
    const business = row && row.business_name;
    const contacts = (await crm.listContacts(req.userId, { stage, limit: BROADCAST_CAP })).slice(0, BROADCAST_CAP);
    let sent = 0;
    for (const c of contacts) {
      const body = fillMessage(text, c, business);
      if (!body) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await sendToContact(req.userId, c, body)) sent += 1;
      } catch (_) {
        /* keep going */
      }
    }
    res.json({ ok: true, sent, total: contacts.length });
  } catch (err) {
    fail(res, err, 'Could not send the broadcast.');
  }
});

module.exports = router;
