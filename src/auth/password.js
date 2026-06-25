'use strict';

const bcrypt = require('bcryptjs');

const ROUNDS = 12;

async function hash(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

async function verify(plain, hashed) {
  if (!hashed) return false;
  return bcrypt.compare(plain, hashed);
}

module.exports = { hash, verify };
