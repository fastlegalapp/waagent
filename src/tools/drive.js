'use strict';

const { config } = require('../config');
const logger = require('../logger');

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Google Drive integration (stub).
//
// This is wired into the agent as two tools (`find_document`, `upload_document`)
// but is intentionally inert until you (a) set GDRIVE_ENABLED=true in .env and
// (b) implement the functions below with the `googleapis` package.
//
// To activate later:
//   1. npm install googleapis
//   2. Create an OAuth client in Google Cloud Console, download credentials.json
//   3. Run a one-time `node scripts/gdrive-auth.js` to mint token.json
//   4. Implement findDocument / uploadDocument below using drive.files.list /
//      drive.files.get (alt: 'media') / drive.files.create.
//
// Until then the agent is told (via its tools) that document delivery is not yet
// available, so it will tell the client "I'll have <owner> send that across"
// rather than promising something it can't do.
// ─────────────────────────────────────────────────────────────────────────────

function isEnabled() {
  return config.drive.enabled;
}

/**
 * Search the configured Drive folder for a document matching `query`.
 * @returns {Promise<{found: boolean, message: string, files?: Array}>}
 */
async function findDocument(query) {
  if (!isEnabled()) {
    return {
      found: false,
      message:
        'Google Drive is not connected yet. Do not promise to send the file now — ' +
        'offer to have a human follow up instead.',
    };
  }
  // TODO(phase 2): implement with googleapis drive.files.list
  logger.warn({ query }, 'drive.findDocument called but not implemented');
  return { found: false, message: 'Drive search is not implemented yet.' };
}

/**
 * Upload a buffer to the configured Drive folder.
 * @returns {Promise<{ok: boolean, message: string, fileId?: string}>}
 */
async function uploadDocument({ filename, mimeType, buffer }) {
  if (!isEnabled()) {
    return {
      ok: false,
      message:
        'Google Drive is not connected yet. The file was received but cannot be ' +
        'uploaded — tell the client it has been passed to a human to file.',
    };
  }
  // TODO(phase 2): implement with googleapis drive.files.create
  logger.warn({ filename, mimeType }, 'drive.uploadDocument called but not implemented');
  return { ok: false, message: 'Drive upload is not implemented yet.' };
}

module.exports = { isEnabled, findDocument, uploadDocument };
