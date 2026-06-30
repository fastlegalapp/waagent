'use strict';

const { query } = require('./pool');

const STAGES = ['new', 'contacted', 'qualified', 'customer', 'lost'];

function normPhone(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

function view(r) {
  return {
    id: r.id,
    phone: r.phone,
    chatId: r.chat_id || '',
    name: r.name || '',
    stage: r.stage || 'new',
    source: r.source || 'whatsapp',
    notes: r.notes || '',
    value: r.value || '',
    tags: r.tags || '',
    msgCount: Number(r.msg_count) || 0,
    autoStage: r.auto_stage === true,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).getTime() : null,
    convertedAt: r.converted_at ? new Date(r.converted_at).getTime() : null,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
  };
}

// Capture (or update) a contact from an inbound WhatsApp message. New people
// become a "new" lead; repeat messengers get their counter/last-seen bumped and,
// while the stage is still auto-managed, auto-advance new → contacted.
async function recordInbound(userId, { phone, chatId, name }) {
  const p = normPhone(phone);
  if (!p || p.length < 7) return null;
  const nm = String(name || '').slice(0, 200);
  const cid = String(chatId || '').slice(0, 300);
  const { rows } = await query(
    `INSERT INTO crm_contacts (user_id, phone, chat_id, name, stage, msg_count, last_message_at)
       VALUES ($1, $2, $3, $4, 'new', 1, now())
     ON CONFLICT (user_id, phone) DO UPDATE SET
       msg_count = crm_contacts.msg_count + 1,
       last_message_at = now(),
       chat_id = CASE WHEN crm_contacts.chat_id = '' THEN EXCLUDED.chat_id ELSE crm_contacts.chat_id END,
       name = CASE WHEN crm_contacts.name = '' THEN EXCLUDED.name ELSE crm_contacts.name END,
       stage = CASE
                 WHEN crm_contacts.auto_stage AND crm_contacts.stage = 'new' THEN 'contacted'
                 ELSE crm_contacts.stage
               END,
       updated_at = now()
     RETURNING *`,
    [userId, p, cid, nm],
  );
  return rows[0] ? view(rows[0]) : null;
}

// Mark a contact (by phone) as a customer — used when they place/pay an order.
// Never downgrades someone already a customer; skips people the owner manually
// marked "lost" only if that manual decision should stand (we still convert on a
// real purchase, since paying outranks a stale "lost").
async function convertToCustomer(userId, phone, { value } = {}) {
  const p = normPhone(phone);
  if (!p || p.length < 7) return null;
  const { rows } = await query(
    `UPDATE crm_contacts
        SET stage = 'customer',
            converted_at = COALESCE(converted_at, now()),
            value = CASE WHEN $3 <> '' THEN $3 ELSE value END,
            updated_at = now()
      WHERE user_id = $1 AND phone = $2 AND stage <> 'customer'
      RETURNING *`,
    [userId, p, String(value || '').slice(0, 100)],
  );
  return rows[0] ? view(rows[0]) : null;
}

async function listContacts(userId, { stage, q, limit = 500 } = {}) {
  const params = [userId];
  let where = 'user_id = $1';
  if (stage && STAGES.includes(stage)) {
    params.push(stage);
    where += ` AND stage = $${params.length}`;
  }
  if (q && q.trim()) {
    params.push(`%${q.trim().toLowerCase()}%`);
    where += ` AND (lower(name) LIKE $${params.length} OR phone LIKE $${params.length} OR lower(tags) LIKE $${params.length})`;
  }
  params.push(Math.min(limit, 2000));
  const { rows } = await query(
    `SELECT * FROM crm_contacts WHERE ${where}
       ORDER BY last_message_at DESC NULLS LAST, created_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.map(view);
}

async function stats(userId) {
  const { rows } = await query(
    `SELECT stage, count(*)::int AS n FROM crm_contacts WHERE user_id = $1 GROUP BY stage`,
    [userId],
  );
  const out = { new: 0, contacted: 0, qualified: 0, customer: 0, lost: 0, total: 0 };
  for (const r of rows) {
    if (out[r.stage] != null) out[r.stage] = r.n;
    out.total += r.n;
  }
  return out;
}

async function getContact(userId, id) {
  const { rows } = await query(
    `SELECT * FROM crm_contacts WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ? view(rows[0]) : null;
}

const FIELDS = {
  name: (v) => String(v).slice(0, 200),
  notes: (v) => String(v).slice(0, 4000),
  value: (v) => String(v).slice(0, 100),
  tags: (v) => String(v).slice(0, 500),
};

// Update editable fields and/or the stage. Setting the stage by hand turns off
// auto-staging for that contact so the system won't move them again.
async function updateContact(userId, id, patch) {
  const sets = [];
  const values = [id, userId];
  for (const k of Object.keys(FIELDS)) {
    if (k in patch) {
      values.push(FIELDS[k](patch[k]));
      sets.push(`${k} = $${values.length}`);
    }
  }
  if (typeof patch.stage === 'string' && STAGES.includes(patch.stage)) {
    values.push(patch.stage);
    sets.push(`stage = $${values.length}`);
    sets.push('auto_stage = false');
    if (patch.stage === 'customer') sets.push('converted_at = COALESCE(converted_at, now())');
  }
  if (sets.length === 0) return getContact(userId, id);
  const { rows } = await query(
    `UPDATE crm_contacts SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING *`,
    values,
  );
  return rows[0] ? view(rows[0]) : null;
}

async function deleteContact(userId, id) {
  await query(`DELETE FROM crm_contacts WHERE id = $1 AND user_id = $2`, [id, userId]);
}

module.exports = {
  STAGES,
  normPhone,
  recordInbound,
  convertToCustomer,
  listContacts,
  stats,
  getContact,
  updateContact,
  deleteContact,
};
