'use strict';

const { query } = require('./pool');
const logger = require('../logger');

// Append-only trail of agent/owner actions per conversation, so the owner can
// always answer "why did it do that?". Fire-and-forget — never blocks a reply.
function log(userId, { chatId, phone, action, detail } = {}) {
  query(
    `INSERT INTO audit_log (user_id, chat_id, phone, action, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      String(chatId || '').slice(0, 300),
      String(phone || '').replace(/[^0-9]/g, '').slice(0, 20),
      String(action || 'event').slice(0, 60),
      String(detail || '').slice(0, 500),
    ],
  ).catch((err) => logger.debug?.({ err: err.message }, 'audit write failed'));
}

async function recent(userId, { chatId, phone, limit = 50 } = {}) {
  const params = [userId];
  let where = 'user_id = $1';
  if (chatId) {
    params.push(chatId);
    where += ` AND chat_id = $${params.length}`;
  }
  if (phone) {
    params.push(String(phone).replace(/[^0-9]/g, ''));
    where += ` AND phone = $${params.length}`;
  }
  params.push(Math.min(limit, 200));
  const { rows } = await query(
    `SELECT chat_id, phone, action, detail, created_at
       FROM audit_log WHERE ${where}
       ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    chatId: r.chat_id,
    phone: r.phone,
    action: r.action,
    detail: r.detail,
    at: r.created_at ? new Date(r.created_at).getTime() : null,
  }));
}

// Bounded like messages: drop old entries.
async function pruneOld(days) {
  const n = Math.floor(Number(days) || 0);
  if (n <= 0) return 0;
  const { rowCount } = await query(
    `DELETE FROM audit_log WHERE created_at < now() - make_interval(days => $1)`,
    [n],
  );
  return rowCount || 0;
}

module.exports = { log, recent, pruneOld };
