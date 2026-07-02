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

// The imageMessage node, if this message is (or wraps) an image.
function imageNode(message) {
  const m = unwrap(message);
  return m && m.imageMessage ? m.imageMessage : null;
}

// Voice notes / audio messages (ptt = push-to-talk voice note).
function audioNode(message) {
  const m = unwrap(message);
  return m && m.audioMessage ? m.audioMessage : null;
}

function numberFromJid(jid) {
  return (jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

// Loose phone-number match: equal, or one is a suffix of the other. This lets a
// user enter a number with OR without the country code (e.g. "9876543210" still
// matches the stored "919876543210"). Requires >= 8 shared trailing digits so
// short fragments can't accidentally match many numbers.
function numbersMatch(a, b) {
  const x = (a || '').replace(/[^0-9]/g, '');
  const y = (b || '').replace(/[^0-9]/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const min = Math.min(x.length, y.length);
  return min >= 8 && (x.endsWith(y) || y.endsWith(x));
}

// True if `number` matches any entry in `list` (using the loose match above).
function numberInList(list, number) {
  return Array.isArray(list) && list.some((n) => numbersMatch(n, number));
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
  imageNode,
  audioNode,
  quotedId,
  quotedText,
  numberFromJid,
  numbersMatch,
  numberInList,
  phoneJid,
  senderName,
  isGroup,
  isIgnorable,
};
