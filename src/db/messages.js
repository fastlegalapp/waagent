'use strict';

const { query } = require('./pool');

const MAX_TURNS = 30; // bound history per chat to control token usage

// Append one message. `opts` may carry { waMsgId, ts }. Live messages pass the
// WhatsApp id so they dedupe against the history sync; internal rows omit it.
// Falls back to a basic insert if the newer columns/index aren't present yet
// (e.g. a migration that hasn't fully applied) so persistence never blocks a reply.
async function appendMessage(userId, chatId, role, content, opts = {}) {
  const waMsgId = opts.waMsgId || null;
  const ts = Number.isFinite(opts.ts) ? Math.floor(opts.ts) : Math.floor(Date.now() / 1000);
  const source = opts.source || null;
  try {
    await query(
      `INSERT INTO messages (user_id, chat_id, role, content, source, wa_msg_id, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, wa_msg_id) DO NOTHING`,
      [userId, chatId, role, content, source, waMsgId, ts],
    );
  } catch (err) {
    await query(
      `INSERT INTO messages (user_id, chat_id, role, content) VALUES ($1, $2, $3, $4)`,
      [userId, chatId, role, content],
    );
  }
}

// Recent messages the OWNER actually sent to clients — the gold data for
// learning how they talk.
async function getOwnerSamples(userId, limit = 120) {
  const { rows } = await query(
    `SELECT content FROM messages
     WHERE user_id = $1 AND source = 'owner' AND length(content) > 0
     ORDER BY id DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => r.content);
}

// Bulk import (history sync). rows: [{userId, chatId, role, content, waMsgId, ts}].
// Chunked to stay under Postgres' parameter limit; duplicates are ignored.
async function appendMany(rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    slice.forEach((r, j) => {
      const b = j * 7;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
      params.push(
        r.userId,
        r.chatId,
        r.role,
        r.content,
        r.source || null,
        r.waMsgId || null,
        Math.floor(r.ts) || 0,
      );
    });
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO messages (user_id, chat_id, role, content, source, wa_msg_id, ts)
       VALUES ${values.join(',')}
       ON CONFLICT (user_id, wa_msg_id) DO NOTHING`,
      params,
    );
  }
}

// Return the last MAX_TURNS messages for a chat in chronological order, trimmed
// so the history never starts on an assistant turn. Ordered by the WhatsApp
// timestamp (so imported history sorts correctly relative to live messages),
// falling back to insertion id.
async function getHistory(userId, chatId) {
  try {
    const { rows } = await query(
      `SELECT role, content FROM (
         SELECT role, content, ts, id FROM messages
         WHERE user_id = $1 AND chat_id = $2
         ORDER BY ts DESC, id DESC
         LIMIT $3
       ) recent
       ORDER BY ts ASC, id ASC`,
      [userId, chatId, MAX_TURNS],
    );
    const history = rows;
    while (history.length && history[0].role !== 'user') history.shift();
    return history;
  } catch (err) {
    // Fall back to id ordering if the ts column isn't present yet.
    const { rows } = await query(
      `SELECT role, content FROM messages
       WHERE user_id = $1 AND chat_id = $2
       ORDER BY id DESC LIMIT $3`,
      [userId, chatId, MAX_TURNS],
    );
    const history = rows.reverse();
    while (history.length && history[0].role !== 'user') history.shift();
    return history;
  }
}

async function getLastReplyAt(userId, chatId) {
  const { rows } = await query(
    `SELECT last_reply_at FROM chat_state WHERE user_id = $1 AND chat_id = $2`,
    [userId, chatId],
  );
  return rows[0] ? Number(rows[0].last_reply_at) : 0;
}

async function setLastReplyAt(userId, chatId, ts) {
  await query(
    `INSERT INTO chat_state (user_id, chat_id, last_reply_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, chat_id)
     DO UPDATE SET last_reply_at = EXCLUDED.last_reply_at`,
    [userId, chatId, ts],
  );
}

module.exports = {
  appendMessage,
  appendMany,
  getOwnerSamples,
  getHistory,
  getLastReplyAt,
  setLastReplyAt,
};
