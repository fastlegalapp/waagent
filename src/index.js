'use strict';

const { validate, config } = require('./config');
const logger = require('./logger');
const { start } = require('./whatsapp');

async function main() {
  const errors = validate();
  if (errors.length) {
    for (const e of errors) logger.error(e);
    process.exit(1);
  }

  logger.info(
    {
      model: config.anthropic.model,
      replyMode: config.reply.mode,
      allowlist: config.reply.allowlist.length || 'any',
      driveEnabled: config.drive.enabled,
    },
    'Starting waagent...',
  );

  await start();
}

process.on('unhandledRejection', (err) => {
  logger.error({ err: err?.message || err }, 'unhandledRejection');
});

main().catch((err) => {
  logger.error({ err: err.message }, 'fatal startup error');
  process.exit(1);
});
