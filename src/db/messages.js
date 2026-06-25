'use strict';

const { query } = require('./pool');

const MAX_TURNS = 30; // bound history per chat to control token usage

async function appendMessage(userId, chatId, role, content) {
  await query(
    `INSERT INTO messages (user_id, chat_id, role, content)
     VALUES ($1, $2, $3, $4)`,
    [userId, chatId, role, content],
  );
}

// Return the last MAX_TURNS messages for a chat, oldest first, trimmed so the
// history never starts on an assistant turn (the Messages API wants a user turn
// first).
async function getHistory(userId, chatId) {
  const { rows } = await query(
    `SELECT role, content FROM messages
     WHERE user_id = $1 AND chat_id = $2
     ORDER BY id DESC
     LIMIT $3`,
    [userId, chatId, MAX_TURNS],
  );
  const history = rows.reverse();
  while (history.length && history[0].role !== 'user') history.shift();
  return history;
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
  getHistory,
  getLastReplyAt,
  setLastReplyAt,
};
