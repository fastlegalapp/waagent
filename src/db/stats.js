'use strict';

const { query } = require('./pool');

// Parse "650", "Rs 1,200", "₹99.50" → numeric, else NULL (SQL-side helper).
const NUM = `NULLIF(regexp_replace(COALESCE(fields->>'total',''), '[^0-9.]', '', 'g'), '')::numeric`;

// Owners are Indian small businesses — bucket hours in IST so "busiest hours"
// matches the owner's clock, not the server's.
const TZ = 'Asia/Kolkata';

// One round-trip per block, all best-effort: a failed block returns zeros
// rather than breaking the whole overview.
async function overview(userId, days = 7) {
  const d = Math.max(1, Math.min(90, Number(days) || 7));
  const [msgs, daily, hours, crm, orders] = await Promise.all([
    messageCounts(userId, d).catch(() => null),
    dailySeries(userId, 14).catch(() => []),
    busiestHours(userId, 30).catch(() => []),
    crmCounts(userId, d).catch(() => null),
    orderStats(userId, d).catch(() => null),
  ]);
  return {
    days: d,
    messages: msgs || { received: 0, sent: 0, chats: 0, escalated: 0 },
    daily,
    hours,
    crm: crm || { total: 0, customers: 0, newLeads: 0, conversion: 0 },
    orders: orders || { count: 0, paid: 0, revenue: 0, revenueAll: 0, open: 0 },
  };
}

async function messageCounts(userId, days) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE role = 'user'      AND source = 'client') ::int AS received,
       count(*) FILTER (WHERE role = 'assistant' AND source = 'bot')    ::int AS sent,
       count(DISTINCT chat_id) FILTER (WHERE role = 'user' AND source = 'client') ::int AS chats
     FROM messages
     WHERE user_id = $1 AND created_at > now() - make_interval(days => $2)`,
    [userId, days],
  );
  const r = rows[0] || {};
  return { received: r.received || 0, sent: r.sent || 0, chats: r.chats || 0 };
}

// Received/sent per day for the last N days (gaps filled with zeros).
async function dailySeries(userId, days) {
  const { rows } = await query(
    `WITH span AS (
       SELECT generate_series(
         (now() AT TIME ZONE '${TZ}')::date - ($2::int - 1),
         (now() AT TIME ZONE '${TZ}')::date, '1 day')::date AS day)
     SELECT span.day::text AS day,
            COALESCE(count(m.id) FILTER (WHERE m.role = 'user'      AND m.source = 'client'), 0)::int AS received,
            COALESCE(count(m.id) FILTER (WHERE m.role = 'assistant' AND m.source = 'bot'),    0)::int AS sent
       FROM span
       LEFT JOIN messages m
         ON m.user_id = $1 AND (m.created_at AT TIME ZONE '${TZ}')::date = span.day
      GROUP BY span.day ORDER BY span.day`,
    [userId, days],
  );
  return rows;
}

// Client messages per IST hour-of-day over the last N days.
async function busiestHours(userId, days) {
  const { rows } = await query(
    `SELECT extract(hour FROM (created_at AT TIME ZONE '${TZ}'))::int AS hour, count(*)::int AS n
       FROM messages
      WHERE user_id = $1 AND role = 'user' AND source = 'client'
        AND created_at > now() - make_interval(days => $2)
      GROUP BY 1 ORDER BY 1`,
    [userId, days],
  );
  const byHour = new Array(24).fill(0);
  for (const r of rows) byHour[r.hour] = r.n;
  return byHour;
}

async function crmCounts(userId, days) {
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE stage = 'customer')::int AS customers,
            count(*) FILTER (WHERE created_at > now() - make_interval(days => $2))::int AS new_leads
       FROM crm_contacts WHERE user_id = $1`,
    [userId, days],
  );
  const r = rows[0] || {};
  const total = r.total || 0;
  return {
    total,
    customers: r.customers || 0,
    newLeads: r.new_leads || 0,
    conversion: total ? Math.round(((r.customers || 0) / total) * 100) : 0,
  };
}

// Orders live in the auto-created "Orders" data list.
async function orderStats(userId, days) {
  const { rows } = await query(
    `SELECT
       count(*)::int AS count,
       count(*) FILTER (WHERE i.created_at > now() - make_interval(days => $2))::int AS recent,
       count(*) FILTER (WHERE i.fields->>'status' = 'paid')::int AS paid,
       count(*) FILTER (WHERE COALESCE(i.fields->>'status','new') NOT IN ('paid','delivered','cancelled'))::int AS open,
       COALESCE(sum(${NUM}) FILTER (WHERE i.fields->>'status' = 'paid'), 0) AS revenue_all,
       COALESCE(sum(${NUM}) FILTER (WHERE i.fields->>'status' = 'paid'
                 AND i.created_at > now() - make_interval(days => $2)), 0) AS revenue
     FROM data_items i JOIN data_lists l ON l.id = i.list_id
     WHERE i.user_id = $1 AND lower(l.name) = 'orders'`,
    [userId, days],
  );
  const r = rows[0] || {};
  return {
    count: r.count || 0,
    recent: r.recent || 0,
    paid: r.paid || 0,
    open: r.open || 0,
    revenue: Number(r.revenue) || 0,
    revenueAll: Number(r.revenue_all) || 0,
  };
}

module.exports = { overview };
