'use strict';

// Unwrap the common Baileys containers to get at the real message content.
function unwrap(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    message?.documentWithCaptionMessage?.message ||
    message?.editedMessage?.message ||
    message?.protocolMessage?.editedMessage ||
    message?.deviceSentMessage?.message ||
    message ||
    {}
  );
}

// Pull the human-readable text out of the many Baileys message shapes.
function extractText(message) {
  if (!message) return '';
  const m = unwrap(message);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.interactiveResponseMessage?.body?.text ||
    ''
  ).trim();
}

// The primary content type of a message (for diagnostics when there's no text).
function messageType(message) {
  const m = unwrap(message);
  const keys = Object.keys(m).filter((k) => k !== 'messageContextInfo');
  return keys[0] || 'empty';
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

module.exports = { extractText, messageType, numberFromJid, isGroup, isIgnorable };
