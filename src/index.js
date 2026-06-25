'use strict';

const { validate, config } = require('./config');
const logger = require('./logger');
const { migrate } = require('./db/migrate');
const { listen } = require('./web/server');
const users = require('./db/users');
const manager = require('./wa/sessionManager');
const styleLearner = require('./services/styleLearner');
const ready = require('./ready');

const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connect + migrate in the background, retrying forever so a slow or
// temporarily-unreachable Postgres (common on first deploy) self-heals instead
// of crash-looping the container. The HTTP server is already up by now, so the
// panel's proxy has a live upstream (no 502) the whole time.
async function migrateThenResume() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await migrate();
      ready.db = true;
      logger.info('Database ready.');
      break;
    } catch (err) {
      logger.warn({ attempt, err: err.message }, 'database not ready, retrying in 5s');
      await sleep(5000);
    }
  }

  // Resume WhatsApp sessions for users who had already linked a device.
  try {
    const ids = await users.listIds();
    await manager.resumeAll(ids);
  } catch (err) {
    logger.error({ err: err.message }, 'failed to resume sessions');
  }

  // Re-learn each owner's chatting style daily so the agent matures over time.
  setInterval(() => {
    styleLearner.learnForAll().catch((err) =>
      logger.warn({ err: err.message }, 'daily style-learn failed'),
    );
  }, DAY_MS).unref?.();
}

async function main() {
  // Surface the configuration state in the logs immediately — the usual cause
  // of a failed deploy is a missing secret or DATABASE_URL.
  logger.info(
    {
      env: config.env,
      port: config.port,
      authRoot: config.authRoot,
      databaseUrl: config.databaseUrl ? 'set' : 'MISSING',
      sessionSecret: config.sessionSecret ? 'set' : 'MISSING',
      encryptionKey: config.encryptionKey ? 'set' : 'MISSING',
    },
    'Starting waagent...',
  );

  const errors = validate();
  if (errors.length) {
    for (const e of errors) logger.error(e);
    logger.error('Cannot start until the configuration above is fixed. See .env.example.');
    process.exit(1);
  }

  // Open the port FIRST so the container is immediately reachable, then bring up
  // the database in the background.
  await listen();
  migrateThenResume();
}

process.on('unhandledRejection', (err) => {
  logger.error({ err: err?.message || err }, 'unhandledRejection');
});

main().catch((err) => {
  logger.error({ err: err.message }, 'fatal startup error');
  process.exit(1);
});
