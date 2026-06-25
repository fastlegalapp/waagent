'use strict';

const { validate, config } = require('./config');
const logger = require('./logger');
const { migrate } = require('./db/migrate');
const { listen } = require('./web/server');
const users = require('./db/users');
const manager = require('./wa/sessionManager');

async function main() {
  const errors = validate();
  if (errors.length) {
    for (const e of errors) logger.error(e);
    logger.error('Fix the above in your .env, then restart. See .env.example.');
    process.exit(1);
  }

  logger.info({ env: config.env, port: config.port }, 'Starting waagent...');

  await migrate();
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
