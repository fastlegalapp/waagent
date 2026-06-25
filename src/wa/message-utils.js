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

// The id of the message this one is replying to (quoted), if any.
function quotedId(message) {
  const m = unwrap(message);
  return m?.extendedTextMessage?.contextInfo?.stanzaId || null;
}

// The full text of the message this one is quoting (replying to), if any.
// WhatsApp embeds the quoted message in contextInfo, so we can read it even
// across restarts when our in-memory maps are gone.
function quotedText(message) {
  const m = unwrap(message);
  const quoted = m?.extendedTextMessage?.contextInfo?.quotedMessage;
  return quoted ? extractText(quoted) : '';
}

function numberFromJid(jid) {
  return (jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

// The real mobile-number JID for a message. WhatsApp's newer "LID" addressing
// can put an internal id (e.g. "12345@lid") in remoteJid; the actual phone-
// number JID is then carried in the *Alt fields. We prefer any
// "@s.whatsapp.net" JID so messages reach the client's real mobile number
// instead of an internal id.
function phoneJid(msg) {
  const k = (msg && msg.key) || {};
  const candidates = [k.remoteJidAlt, k.participantAlt, k.remoteJid, k.participant];
  for (const c of candidates) {
    if (typeof c === 'string' && c.endsWith('@s.whatsapp.net')) return c;
  }
  return k.remoteJid || '';
}

// The client's display name as set on their own WhatsApp account.
function senderName(msg) {
  const n = (msg && msg.pushName) ? String(msg.pushName).trim() : '';
  return n || null;
}

function isGroup(jid) {
  return (jid || '').endsWith('@g.us');
}

function isIgnorable(jid) {
  return !jid || jid === 'status@broadcast';
}

module.exports = {
  extractText,
  messageType,
  quotedId,
  quotedText,
  numberFromJid,
  phoneJid,
  senderName,
  isGroup,
  isIgnorable,
};
