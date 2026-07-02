'use strict';

const express = require('express');
const lists = require('../../db/lists');
const settingsDb = require('../../db/settings');
const manager = require('../../wa/sessionManager');
const mem = require('../../db/messages');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();
router.use(requireAuth);

// What we tell the client at each step (kept warm and short; {items}/{business}
// are filled in).
const STATUS_MESSAGES = {
  confirmed: '✅ Your order is confirmed{business}: {items}. We\'ll update you once it\'s ready!',
  ready: '📦 Good news — your order ({items}) is ready! It\'s packed and on its way / ready for pickup.',
  delivered: '🎉 Your order has been delivered. Thank you for shopping with us{business}! 🙏',
  cancelled: 'Your order ({items}) has been cancelled. If this is a mistake, just reply here.',
};

function fillStatusMessage(status, order, businessName) {
  const tpl = STATUS_MESSAGES[status];
  if (!tpl) return null;
  const items = String(order.fields.items || 'your items').slice(0, 200);
  const business = businessName ? ` at ${businessName}` : '';
  return tpl.replace('{items}', items).replace('{business}', business);
}

router.get('/', async (req, res) => {
  try {
    res.json({ orders: await lists.listOrders(req.userId), statuses: lists.ORDER_STATUSES });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'orders list failed');
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

// Update status; optionally notify the client on WhatsApp.
router.post('/:itemId/status', async (req, res) => {
  const status = String(req.body?.status || '');
  const notify = req.body?.notify !== false;
  if (!lists.ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  try {
    const order = await lists.setOrderStatus(req.userId, req.params.itemId, status);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    let notified = false;
    const digits = String(order.fields.customer || '').replace(/[^0-9]/g, '');
    if (notify && digits.length >= 7 && manager.isOpen(req.userId)) {
      try {
        const row = await settingsDb.getRaw(req.userId);
        const body = fillStatusMessage(status, order, row && row.business_name);
        if (body) {
          const jid = `${digits}@s.whatsapp.net`;
          const out = await manager.sendText(req.userId, jid, body);
          if (out) {
            notified = true;
            mem.appendMessage(req.userId, jid, 'assistant', body, {
              waMsgId: out?.key?.id,
              ts: Math.floor(Date.now() / 1000),
              source: 'bot',
            }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, userId: req.userId }, 'order status notify failed');
      }
    }
    res.json({ ok: true, order, notified });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'order status update failed');
    res.status(500).json({ error: 'Could not update the order.' });
  }
});

module.exports = router;
