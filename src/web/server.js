'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { config } = require('../config');
const logger = require('../logger');

const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const listsRoutes = require('./routes/lists');
const crmRoutes = require('./routes/crm');
const statsRoutes = require('./routes/stats');
const billingRoutes = require('./routes/billing');
const inboxRoutes = require('./routes/inbox');
const waRoutes = require('./routes/wa');
const ready = require('../ready');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // We run behind a reverse proxy (Coolify/agent panel); trust one hop so
  // req.ip reflects the real client for rate limiting and the Secure cookie.
  app.set('trust proxy', 1);
  // Capture the raw body so the Razorpay webhook signature can be verified.
  app.use(express.json({
    limit: '2mb', // room for an uploaded payment-QR data URL
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));
  app.use(cookieParser());

  // API
  app.use('/api/auth', authRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/lists', listsRoutes);
  app.use('/api/crm', crmRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/inbox', inboxRoutes);
  app.use('/api/wa', waRoutes);

  // Always 200 once the process is up, so the panel's proxy has a live upstream
  // (no 502) even while the database is still connecting.
  app.get('/api/health', (req, res) =>
    res.json({ ok: true, db: ready.db ? 'ready' : 'connecting' }),
  );

  // Static dashboard (login + app). The SPA-ish frontend handles routing.
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  // Fallback to the app shell for any non-API GET.
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err: err.message }, 'unhandled request error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function listen() {
  const app = createApp();
  return new Promise((resolve) => {
    // Bind 0.0.0.0 explicitly so the container is reachable from the panel's
    // reverse proxy (not just localhost).
    const server = app.listen(config.port, '0.0.0.0', () => {
      logger.info(`Web server listening on 0.0.0.0:${config.port}`);
      resolve(server);
    });
  });
}

module.exports = { createApp, listen };
