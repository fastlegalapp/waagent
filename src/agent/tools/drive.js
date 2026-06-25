'use strict';

const logger = require('../../logger');

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Google Drive integration (stub, per user).
//
// Wired into the agent as the `find_document` tool but inert until Drive is
// connected for a user. In the multi-tenant design each user will connect their
// own Google account (OAuth), so these functions take the user's settings.
//
// To activate later:
//   1. npm install googleapis
//   2. Add a per-user Google OAuth flow (store refresh token encrypted, like the
//      Anthropic key) and a `gdrive_folder_id` setting.
//   3. Implement findDocument / uploadDocument with drive.files.list / .create.
// ─────────────────────────────────────────────────────────────────────────────

function isEnabled(settings) {
  return Boolean(settings?.drive?.enabled);
}

async function findDocument(settings, query) {
  if (!isEnabled(settings)) {
    return {
      found: false,
      message:
        'Google Drive is not connected yet. Do not promise to send the file now — ' +
        'offer to have a human follow up instead.',
    };
  }
  logger.warn({ query }, 'drive.findDocument called but not implemented');
  return { found: false, message: 'Drive search is not implemented yet.' };
}

async function uploadDocument(settings, { filename, mimeType }) {
  if (!isEnabled(settings)) {
    return { ok: false, message: 'Google Drive is not connected yet.' };
  }
  logger.warn({ filename, mimeType }, 'drive.uploadDocument called but not implemented');
  return { ok: false, message: 'Drive upload is not implemented yet.' };
}

module.exports = { isEnabled, findDocument, uploadDocument };
