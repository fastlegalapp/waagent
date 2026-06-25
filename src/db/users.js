'use strict';

const { query } = require('./pool');
const { config } = require('../config');

async function createUser(email, passwordHash) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, created_at`,
    [email.toLowerCase(), passwordHash],
  );
  const user = rows[0];
  // Create the default settings row for this user.
  await query(
    `INSERT INTO user_settings (user_id, anthropic_model)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, config.defaultModel],
  );
  return user;
}

async function findByEmail(email) {
  const { rows } = await query(
    `SELECT id, email, password_hash, created_at FROM users WHERE email = $1`,
    [email.toLowerCase()],
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await query(
    `SELECT id, email, created_at FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function listIds() {
  const { rows } = await query(`SELECT id FROM users`);
  return rows.map((r) => r.id);
}

module.exports = { createUser, findByEmail, findById, listIds };
