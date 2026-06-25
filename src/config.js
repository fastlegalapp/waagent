'use strict';

require('dotenv').config();

function parseList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean);
}

function parseHour(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

const config = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  },
  owner: {
    name: process.env.OWNER_NAME || 'the owner',
    business: process.env.BUSINESS_NAME || '',
    description: process.env.BUSINESS_DESCRIPTION || '',
  },
  reply: {
    mode: (process.env.REPLY_MODE || 'auto').toLowerCase(), // 'auto' | 'off'
    allowlist: parseList(process.env.ALLOWLIST),
    blocklist: parseList(process.env.BLOCKLIST),
    ignoreGroups: (process.env.IGNORE_GROUPS || 'true').toLowerCase() !== 'false',
    minIntervalSeconds: Number(process.env.MIN_REPLY_INTERVAL_SECONDS || 2),
    businessHoursStart: parseHour(process.env.BUSINESS_HOURS_START),
    businessHoursEnd: parseHour(process.env.BUSINESS_HOURS_END),
  },
  drive: {
    enabled: (process.env.GDRIVE_ENABLED || 'false').toLowerCase() === 'true',
    credentialsPath: process.env.GDRIVE_CREDENTIALS_PATH || './credentials.json',
    tokenPath: process.env.GDRIVE_TOKEN_PATH || './token.json',
    folderId: process.env.GDRIVE_FOLDER_ID || '',
  },
  paths: {
    auth: process.env.AUTH_DIR || './auth_info_baileys',
    data: process.env.DATA_DIR || './data',
  },
};

function validate() {
  const errors = [];
  if (!config.anthropic.apiKey) {
    errors.push('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  if (!['auto', 'off'].includes(config.reply.mode)) {
    errors.push(`REPLY_MODE must be "auto" or "off" (got "${config.reply.mode}").`);
  }
  return errors;
}

module.exports = { config, validate };
