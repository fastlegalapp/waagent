'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const logger = require('../logger');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);

  // Create the history-dedupe index separately so any issue here can never roll
  // back the column additions above. Non-fatal — the app degrades gracefully
  // (it just loses history dedupe) if this can't be created.
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS messages_user_wamsg_uniq
         ON messages (user_id, wa_msg_id)`,
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'could not create messages_user_wamsg_uniq index');
  }

  // Full-text index over message content, for cross-chat "how did I answer a
  // similar question before" retrieval. Non-fatal — retrieval just runs slower
  // (or its query no-ops) if this can't be created.
  try {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS messages_content_fts_idx
         ON messages USING gin (to_tsvector('simple', content))`,
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'could not create messages_content_fts_idx index');
  }

  // Full-text index over list item fields, for the agent's lookup_list tool.
  try {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS data_items_fts_idx
         ON data_items USING gin (to_tsvector('simple', fields::text))`,
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'could not create data_items_fts_idx index');
  }

  logger.info('Database schema is up to date.');
}

// Allow running directly: `npm run migrate`
if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: err.message }, 'migration failed');
      process.exit(1);
    });
}

module.exports = { migrate };
