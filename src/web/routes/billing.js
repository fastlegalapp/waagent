'use strict';

const express = require('express');
const billing = require('../../services/billing');
const { config } = require('../../config');
const { requireAuth } = require('../../auth/session');
const logger = require('../../logger');

const router = express.Router();

// Razorpay webhook — no session auth (Razorpay calls it); verified by HMAC over
// the raw body. Configure the same secret in the Razorpay dashboard.
router.post('/webhook', async (req, res) => {
  try {
    const sig = req.headers['x-razorpay-signature'];
    if (!req.rawBody || !billing.verifyWebhookSignature(req.rawBody, sig)) {
      return res.status(400).json({ error: 'Bad signature.' });
    }
    const event = req.body || {};
    if (event.event === 'payment.captured') {
      const p = event.payload?.payment?.entity || {};
      const userId = p.notes?.user_id;
      const plan = p.notes?.plan === 'yearly' ? 'yearly' : 'monthly';
      if (userId) {
        await billing.activate(userId, {
          plan,
          paymentId: p.id,
          orderId: p.order_id,
          amountPaise: p.amount,
        });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'billing webhook failed');
    res.status(500).json({ error: 'webhook error' });
  }
});

router.use(requireAuth);

router.get('/status', async (req, res) => {
  try {
    const status = await billing.statusFor(req.userId);
    res.json({
      ...status,
      prices: {
        monthly: config.priceMonthlyPaise,
        yearly: config.priceYearlyPaise,
      },
      trialDays: config.trialDays,
    });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'billing status failed');
    res.status(500).json({ error: 'Could not load billing status.' });
  }
});

// Create a checkout order for the Razorpay popup.
router.post('/order', async (req, res) => {
  if (!billing.enabled()) return res.status(400).json({ error: 'Billing is not configured.' });
  const plan = req.body?.plan === 'yearly' ? 'yearly' : 'monthly';
  try {
    res.json({ ...(await billing.createOrder(req.userId, plan)), plan });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Checkout success callback: verify the signature, then activate.
router.post('/verify', async (req, res) => {
  const { orderId, paymentId, signature, plan } = req.body || {};
  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({ error: 'Missing payment details.' });
  }
  if (!billing.verifyCheckoutSignature({ orderId, paymentId, signature })) {
    return res.status(400).json({ error: 'Payment verification failed.' });
  }
  try {
    const status = await billing.activate(req.userId, { plan, paymentId, orderId });
    res.json({ ok: true, status });
  } catch (err) {
    logger.error({ err: err.message, userId: req.userId }, 'billing activate failed');
    res.status(500).json({ error: 'Could not activate the subscription.' });
  }
});

module.exports = router;
