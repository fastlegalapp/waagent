'use strict';

// Pull the human-readable text out of the many Baileys message shapes.
function extractText(message) {
  if (!message) return '';
  // Unwrap common containers (ephemeral / view-once / edited).
  const m =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.editedMessage?.message ||
    message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

function numberFromJid(jid) {
  return (jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function isGroup(jid) {
  return (jid || '').endsWith('@g.us');
}

function isIgnorable(jid) {
  return !jid || jid === 'status@broadcast';
}

module.exports = { extractText, numberFromJid, isGroup, isIgnorable };
