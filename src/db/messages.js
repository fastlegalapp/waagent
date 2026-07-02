'use strict';

const { query } = require('./pool');

const MAX_TURNS = 60; // recent messages per chat sent to the agent as context

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

// Cross-chat recall: find past client questions (in OTHER chats) similar to
// `queryText` and the reply that followed each — i.e. "how did the owner answer
// a similar question before". Uses Postgres full-text search ('simple' config,
// language-agnostic). Returns [{question, answer}] best-match first; [] if there
// are no matches or full-text search isn't available.
async function findSimilarAnswered(userId, queryText, excludeChatId, limit = 3) {
  // Tokenise to word/number lexemes (unicode-aware, so Hindi/Hinglish works) and
  // build an OR tsquery — we want messages that share SOME words (similar), not
  // ones that contain every word. Ranking by ts_rank surfaces the best overlap.
  const terms = String(queryText || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu);
  if (!terms || terms.length === 0) return [];
  const tsq = Array.from(new Set(terms)).join(' | ');
  try {
    const { rows } = await query(
      `SELECT m.content AS question, reply.content AS answer
         FROM messages m
         JOIN LATERAL (
           SELECT nxt.content FROM messages nxt
            WHERE nxt.user_id = m.user_id AND nxt.chat_id = m.chat_id
              AND nxt.role = 'assistant' AND nxt.id > m.id AND length(nxt.content) > 0
            ORDER BY nxt.id ASC LIMIT 1
         ) reply ON true
        WHERE m.user_id = $1
          AND m.role = 'user'
          AND (m.source IS NULL OR m.source = 'client')
          AND m.chat_id <> $3
          AND length(m.content) > 0
          AND to_tsvector('simple', m.content) @@ to_tsquery('simple', $2)
        ORDER BY ts_rank(to_tsvector('simple', m.content), to_tsquery('simple', $2)) DESC
        LIMIT $4`,
      [userId, tsq, excludeChatId || '', limit * 4],
    );
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const question = (r.question || '').trim();
      const answer = (r.answer || '').trim();
      if (!question || !answer || question === answer) continue;
      const k = answer.toLowerCase();
      if (seen.has(k)) continue; // drop duplicate answers
      seen.add(k);
      out.push({ question, answer });
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    return []; // older Postgres / missing function → silently skip recall
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

// Client just messaged → record it and reset the follow-up flag for a new round.
async function setClientActivity(userId, chatId, ts) {
  await query(
    `INSERT INTO chat_state (user_id, chat_id, last_client_at, followup_done)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (user_id, chat_id)
     DO UPDATE SET last_client_at = EXCLUDED.last_client_at, followup_done = false`,
    [userId, chatId, ts],
  );
}

async function markFollowupDone(userId, chatId) {
  await query(
    `UPDATE chat_state SET followup_done = true WHERE user_id = $1 AND chat_id = $2`,
    [userId, chatId],
  );
}

// Chats where we replied last, the client has been silent past the cutoff, and
// no follow-up has been sent yet.
async function getFollowupCandidates(userId, beforeMs) {
  const { rows } = await query(
    `SELECT chat_id FROM chat_state
     WHERE user_id = $1
       AND followup_done = false
       AND last_reply_at > last_client_at
       AND last_reply_at > 0
       AND last_reply_at < $2`,
    [userId, beforeMs],
  );
  return rows.map((r) => r.chat_id);
}

// ── Inbox ────────────────────────────────────────────────────────────────────

// Conversation list: one row per chat, newest first, with a preview of the last
// message and the contact's CRM name when we have one.
async function listChats(userId, limit = 60) {
  const { rows } = await query(
    `SELECT m.chat_id,
            max(m.id) AS last_id,
            count(*)::int AS message_count,
            max(m.created_at) AS last_at,
            (array_agg(m.content ORDER BY m.id DESC))[1] AS last_content,
            (array_agg(m.role    ORDER BY m.id DESC))[1] AS last_role,
            (array_agg(m.source  ORDER BY m.id DESC))[1] AS last_source,
            max(c.name) AS crm_name,
            max(c.stage) AS crm_stage
       FROM messages m
       LEFT JOIN crm_contacts c ON c.user_id = m.user_id AND c.chat_id = m.chat_id
      WHERE m.user_id = $1
      GROUP BY m.chat_id
      ORDER BY max(m.id) DESC
      LIMIT $2`,
    [userId, Math.min(limit, 200)],
  );
  return rows.map((r) => ({
    chatId: r.chat_id,
    name: r.crm_name || '',
    stage: r.crm_stage || '',
    messageCount: r.message_count,
    lastAt: r.last_at ? new Date(r.last_at).getTime() : null,
    lastContent: (r.last_content || '').slice(0, 120),
    lastRole: r.last_role,
    lastSource: r.last_source,
  }));
}

// Full thread for one chat (chronological, most recent `limit`).
async function getThread(userId, chatId, limit = 150) {
  const { rows } = await query(
    `SELECT role, content, source, ts, created_at FROM (
       SELECT * FROM messages
        WHERE user_id = $1 AND chat_id = $2
        ORDER BY id DESC LIMIT $3
     ) recent ORDER BY id ASC`,
    [userId, chatId, Math.min(limit, 500)],
  );
  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    source: r.source,
    at: r.created_at ? new Date(r.created_at).getTime() : null,
  }));
}

// Delete messages older than `days` so the table stays bounded over time.
// Uses created_at (server insert time), which is always present and monotonic,
// rather than the WhatsApp ts (which can be 0 for some imported rows). Returns
// the number of rows removed.
async function pruneOld(days) {
  const n = Math.floor(Number(days) || 0);
  if (n <= 0) return 0;
  const { rowCount } = await query(
    `DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`,
    [n],
  );
  return rowCount || 0;
}

module.exports = {
  appendMessage,
  appendMany,
  listChats,
  getThread,
  pruneOld,
  getOwnerSamples,
  getHistory,
  findSimilarAnswered,
  getLastReplyAt,
  setLastReplyAt,
  setClientActivity,
  markFollowupDone,
  getFollowupCandidates,
};
