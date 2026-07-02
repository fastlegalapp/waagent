'use strict';

const express = require('express');
const crm = require('../../db/crm');
const lists = require('../../db/lists');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function sendCsv(res, filename, csv) {
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename="${filename}"`);
  // BOM so Excel opens UTF-8 (names in Hindi etc.) correctly.
  res.send('\ufeff' + csv);
}

router.get('/crm.csv', async (req, res) => {
  try {
    const contacts = await crm.listContacts(req.userId, { limit: 2000 });
    const rows = contacts.map((c) => ({
      name: c.name,
      phone: c.phone,
      stage: c.stage,
      value: c.value,
      tags: c.tags,
      notes: c.notes,
      messages: c.msgCount,
      last_message: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : '',
      became_customer: c.convertedAt ? new Date(c.convertedAt).toISOString() : '',
    }));
    sendCsv(res, 'contacts.csv', toCsv(
      ['name', 'phone', 'stage', 'value', 'tags', 'notes', 'messages', 'last_message', 'became_customer'],
      rows,
    ));
  } catch (err) {
    logger.error({ err: err.message }, 'crm export failed');
    res.status(500).json({ error: 'Export failed.' });
  }
});

router.get('/orders.csv', async (req, res) => {
  try {
    const orders = await lists.listOrders(req.userId, 1000);
    const cols = ['customer', 'items', 'total', 'status', 'paid_at', 'payment_note', 'notes', 'created_at'];
    const rows = orders.map((o) => ({ ...o.fields, created_at: o.fields.created_at || (o.createdAt ? new Date(o.createdAt).toISOString() : '') }));
    sendCsv(res, 'orders.csv', toCsv(cols, rows));
  } catch (err) {
    logger.error({ err: err.message }, 'orders export failed');
    res.status(500).json({ error: 'Export failed.' });
  }
});

router.get('/lists/:id.csv', async (req, res) => {
  try {
    const list = await lists.getList(req.userId, req.params.id);
    if (!list) return res.status(404).json({ error: 'List not found.' });
    const items = await lists.listItems(req.userId, req.params.id, 2000);
    const cols = [];
    items.forEach((it) => Object.keys(it.fields).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
    sendCsv(res, `${list.name.replace(/[^\w-]+/g, '_').slice(0, 60) || 'list'}.csv`,
      toCsv(cols, items.map((it) => it.fields)));
  } catch (err) {
    logger.error({ err: err.message }, 'list export failed');
    res.status(500).json({ error: 'Export failed.' });
  }
});

module.exports = router;
