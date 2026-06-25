'use strict';

const { Pool } = require('pg');
const { config } = require('../config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Many managed Postgres providers require SSL. Enable via ?sslmode=require in
  // the connection string, or PGSSLMODE=require. We accept self-signed there.
  ssl:
    /sslmode=require/.test(config.databaseUrl) ||
    process.env.PGSSLMODE === 'require'
      ? { rejectUnauthorized: false }
      : undefined,
});

function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
