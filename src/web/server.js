'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { config } = require('../config');
const logger = require('../logger');

const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const waRoutes = require('./routes/wa');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  // API
  app.use('/api/auth', authRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/wa', waRoutes);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

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
    const server = app.listen(config.port, () => {
      logger.info(`Web server listening on http://localhost:${config.port}`);
      resolve(server);
    });
  });
}

module.exports = { createApp, listen };
