'use strict';

const { query } = require('./pool');

// ── Lists ────────────────────────────────────────────────────────────────────

async function listLists(userId) {
  const { rows } = await query(
    `SELECT l.*, COALESCE(c.n, 0) AS item_count
       FROM data_lists l
       LEFT JOIN (SELECT list_id, count(*) AS n FROM data_items GROUP BY list_id) c
         ON c.list_id = l.id
      WHERE l.user_id = $1
      ORDER BY l.created_at ASC`,
    [userId],
  );
  return rows.map(viewList);
}

async function getList(userId, listId) {
  const { rows } = await query(
    `SELECT * FROM data_lists WHERE id = $1 AND user_id = $2`,
    [listId, userId],
  );
  return rows[0] ? viewList(rows[0]) : null;
}

async function createList(userId, name) {
  const { rows } = await query(
    `INSERT INTO data_lists (user_id, name) VALUES ($1, $2) RETURNING *`,
    [userId, String(name || 'Untitled list').slice(0, 200)],
  );
  return viewList(rows[0]);
}

const LIST_FIELDS = {
  name: (v) => String(v).slice(0, 200),
  instructions: (v) => String(v).slice(0, 4000),
  reminder_enabled: (v) => v === true,
  reminder_date_field: (v) => String(v).slice(0, 120),
  reminder_phone_field: (v) => String(v).slice(0, 120),
  reminder_template: (v) => String(v).slice(0, 2000),
  reminder_days_before: (v) => Math.max(0, Math.min(365, parseInt(v, 10) || 0)),
};

async function updateList(userId, listId, patch) {
  const keys = Object.keys(patch).filter((k) => k in LIST_FIELDS);
  if (keys.length === 0) return getList(userId, listId);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  const values = keys.map((k) => LIST_FIELDS[k](patch[k]));
  const { rows } = await query(
    `UPDATE data_lists SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING *`,
    [listId, userId, ...values],
  );
  return rows[0] ? viewList(rows[0]) : null;
}

async function deleteList(userId, listId) {
  await query(`DELETE FROM data_lists WHERE id = $1 AND user_id = $2`, [listId, userId]);
}

// ── Items ────────────────────────────────────────────────────────────────────

async function listItems(userId, listId, limit = 500) {
  const { rows } = await query(
    `SELECT id, fields, created_at FROM data_items
      WHERE list_id = $1 AND user_id = $2
      ORDER BY created_at ASC LIMIT $3`,
    [listId, userId, Math.min(limit, 2000)],
  );
  return rows.map((r) => ({ id: r.id, fields: r.fields || {} }));
}

// rows: array of plain objects {field: value}. Returns count inserted.
async function addItems(userId, listId, items) {
  const owns = await getList(userId, listId);
  if (!owns) return 0;
  let n = 0;
  for (const fields of items) {
    if (!fields || typeof fields !== 'object') continue;
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO data_items (list_id, user_id, fields) VALUES ($1, $2, $3)`,
      [listId, userId, JSON.stringify(fields)],
    );
    n += 1;
  }
  return n;
}

async function deleteItem(userId, itemId) {
  await query(`DELETE FROM data_items WHERE id = $1 AND user_id = $2`, [itemId, userId]);
}

async function clearItems(userId, listId) {
  await query(`DELETE FROM data_items WHERE list_id = $1 AND user_id = $2`, [listId, userId]);
}

// ── Agent helpers ────────────────────────────────────────────────────────────

// Compact directory of the user's lists (names + instructions + counts) to put
// in the agent's system prompt so it knows what it can look up.
async function getDirectory(userId) {
  const { rows } = await query(
    `SELECT l.name, l.instructions, COALESCE(c.n, 0) AS item_count
       FROM data_lists l
       LEFT JOIN (SELECT list_id, count(*) AS n FROM data_items GROUP BY list_id) c
         ON c.list_id = l.id
      WHERE l.user_id = $1
      ORDER BY l.created_at ASC`,
    [userId],
  );
  return rows.map((r) => ({
    name: r.name,
    instructions: r.instructions || '',
    count: Number(r.item_count) || 0,
  }));
}

// Search items across all of a user's lists by keyword overlap (full-text,
// language-agnostic). Returns [{list, fields}] for the agent's lookup_list tool.
async function searchItems(userId, queryText, limit = 8) {
  const terms = String(queryText || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu);
  if (!terms || terms.length === 0) return [];
  const tsq = Array.from(new Set(terms)).join(' | ');
  try {
    const { rows } = await query(
      `SELECT l.name AS list, i.fields
         FROM data_items i JOIN data_lists l ON l.id = i.list_id
        WHERE i.user_id = $1
          AND to_tsvector('simple', i.fields::text) @@ to_tsquery('simple', $2)
        ORDER BY ts_rank(to_tsvector('simple', i.fields::text), to_tsquery('simple', $2)) DESC
        LIMIT $3`,
      [userId, tsq, Math.min(limit, 25)],
    );
    return rows.map((r) => ({ list: r.list, fields: r.fields || {} }));
  } catch (_) {
    return [];
  }
}

// ── Reminders ────────────────────────────────────────────────────────────────

// Lists with reminders enabled and a configured date+phone field.
async function remindableLists(userId) {
  const { rows } = await query(
    `SELECT * FROM data_lists
      WHERE user_id = $1 AND reminder_enabled = true
        AND length(reminder_date_field) > 0 AND length(reminder_phone_field) > 0`,
    [userId],
  );
  return rows.map(viewList);
}

// Items in a list that haven't been reminded in the last `cooldownHours`.
async function itemsForReminder(userId, listId, cooldownHours = 20) {
  const { rows } = await query(
    `SELECT id, fields, last_reminded_at FROM data_items
      WHERE list_id = $1 AND user_id = $2
        AND (last_reminded_at IS NULL OR last_reminded_at < now() - make_interval(hours => $3))`,
    [listId, userId, cooldownHours],
  );
  return rows.map((r) => ({ id: r.id, fields: r.fields || {} }));
}

async function markReminded(itemId) {
  await query(`UPDATE data_items SET last_reminded_at = now() WHERE id = $1`, [itemId]);
}

// Record an order the agent captured into the user's "Orders" list (created on
// first use), so it shows up in the dashboard like any other list.
async function recordOrder(userId, order) {
  let { rows } = await query(
    `SELECT id FROM data_lists WHERE user_id = $1 AND lower(name) = 'orders' LIMIT 1`,
    [userId],
  );
  let listId = rows[0] && rows[0].id;
  if (!listId) {
    const created = await createList(userId, 'Orders');
    listId = created.id;
    await updateList(userId, listId, {
      instructions: 'Orders the agent has captured. Each row is one order.',
    });
  }
  const now = new Date();
  const fields = {
    customer: String(order.customer || '').slice(0, 200),
    items: String(order.items || '').slice(0, 2000),
    total: String(order.total || '').slice(0, 100),
    notes: String(order.notes || '').slice(0, 1000),
    status: 'new',
    created_at: `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`,
  };
  await addItems(userId, listId, [fields]);
  return fields;
}

// Loose phone match (country-code optional), mirrors message-utils.
function loosePhoneMatch(a, b) {
  const x = String(a || '').replace(/[^0-9]/g, '');
  const y = String(b || '').replace(/[^0-9]/g, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const min = Math.min(x.length, y.length);
  return min >= 8 && (x.endsWith(y) || y.endsWith(x));
}

// Mark a client's most recent un-paid order (in the "Orders" list) as paid.
// Returns the updated order, or null if there's no open order for them.
async function markOrderPaid(userId, customerNumber, note) {
  const all = await listLists(userId);
  const ordersList = all.find((l) => l.name && l.name.toLowerCase() === 'orders');
  if (!ordersList) return null;
  const items = await listItems(userId, ordersList.id, 2000);
  const match = [...items].reverse().find((it) => {
    const f = it.fields || {};
    return (
      String(f.status || '').toLowerCase() !== 'paid' &&
      loosePhoneMatch(f.customer, customerNumber)
    );
  });
  if (!match) return null;
  const now = new Date();
  const patch = {
    status: 'paid',
    paid_at: `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`,
  };
  if (note) patch.payment_note = String(note).slice(0, 500);
  await query(
    `UPDATE data_items SET fields = fields || $2::jsonb WHERE id = $1 AND user_id = $3`,
    [match.id, JSON.stringify(patch), userId],
  );
  return { id: match.id, fields: { ...match.fields, ...patch } };
}

function viewList(r) {
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions || '',
    reminderEnabled: r.reminder_enabled === true,
    reminderDateField: r.reminder_date_field || '',
    reminderPhoneField: r.reminder_phone_field || '',
    reminderTemplate: r.reminder_template || '',
    reminderDaysBefore: Number(r.reminder_days_before) || 0,
    itemCount: r.item_count != null ? Number(r.item_count) : undefined,
  };
}

module.exports = {
  listLists,
  getList,
  createList,
  updateList,
  deleteList,
  listItems,
  addItems,
  deleteItem,
  clearItems,
  getDirectory,
  searchItems,
  recordOrder,
  markOrderPaid,
  remindableLists,
  itemsForReminder,
  markReminded,
};
