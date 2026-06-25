'use strict';

const { validate, config } = require('./config');
const logger = require('./logger');
const { migrate } = require('./db/migrate');
const { listen } = require('./web/server');
const users = require('./db/users');
const manager = require('./wa/sessionManager');

// Postgres (especially under Coolify/Compose) may come up a moment after the
// app. Retry the connection/migration instead of crash-looping.
async function waitForDbAndMigrate(retries = 15, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await migrate();
      return;
    } catch (err) {
      logger.warn(
        { attempt, retries, err: err.message },
        'database not ready, retrying...',
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Database not reachable after multiple attempts');
}

async function main() {
  const errors = validate();
  if (errors.length) {
    for (const e of errors) logger.error(e);
    logger.error('Fix the above in your .env, then restart. See .env.example.');
    process.exit(1);
  }

  logger.info({ env: config.env, port: config.port }, 'Starting waagent...');

  await waitForDbAndMigrate();
  await listen();

  // Resume WhatsApp sessions for users who had already linked a device, so a
  // server restart reconnects them without re-scanning the QR.
  try {
    const ids = await users.listIds();
    await manager.resumeAll(ids);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to resume sessions on boot');
  }
}

process.on('unhandledRejection', (err) => {
  logger.error({ err: err?.message || err }, 'unhandledRejection');
});

main().catch((err) => {
  logger.error({ err: err.message }, 'fatal startup error');
  process.exit(1);
});
