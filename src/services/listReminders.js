'use strict';

const lists = require('../db/lists');
const settingsDb = require('../db/settings');
const throttle = require('./throttle');
const audit = require('../db/audit');
const manager = require('../wa/sessionManager');
const mem = require('../db/messages');
const logger = require('../logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 200; // safety cap per user per run
const COOLDOWN_HOURS = 20; // don't remind the same item more than ~once a day

// Find the actual object key matching a configured field name, case-insensitively.
function matchKey(fields, name) {
  if (!name) return null;
  const target = String(name).trim().toLowerCase();
  return Object.keys(fields).find((k) => k.toLowerCase() === target) || null;
}

// Parse a due date from a field value. Handles ISO (YYYY-MM-DD) and the common
// Indian DD/MM/YYYY or DD-MM-YYYY forms.
function parseDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const dt = new Date(y, mo - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// Replace {field} placeholders in the template with the row's values.
function fillTemplate(tpl, fields) {
  if (!tpl) return '';
  return tpl
    .replace(/\{([^}]+)\}/g, (_, key) => {
      const k = matchKey(fields, key);
      return k != null ? String(fields[k] ?? '') : '';
    })
    .trim();
}

function jidFromPhone(v) {
  const digits = String(v || '').replace(/[^0-9]/g, '');
  return digits.length >= 7 ? `${digits}@s.whatsapp.net` : null;
}

function defaultMessage(list, daysUntil) {
  if (daysUntil < 0) return `Reminder from ${list.name}: this is now overdue. Please take action.`;
  if (daysUntil === 0) return `Reminder from ${list.name}: this is due today.`;
  return `Reminder from ${list.name}: due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}.`;
}

async function runForUser(userId) {
  if (!manager.isOpen(userId)) return; // only when WhatsApp is connected
  let remindable = [];
  try {
    remindable = await lists.remindableLists(userId);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'reminder: list query failed');
    return;
  }
  if (remindable.length === 0) return;

  const now = Date.now();
  let sent = 0;
  for (const list of remindable) {
    if (sent >= MAX_PER_RUN) break;
    let items = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      items = await lists.itemsForReminder(userId, list.id, COOLDOWN_HOURS);
    } catch (_) {
      continue;
    }
    for (const item of items) {
      if (sent >= MAX_PER_RUN) break;
      const due = parseDate(item.fields[matchKey(item.fields, list.reminderDateField)]);
      if (!due) continue;
      const daysUntil = Math.ceil((due.getTime() - now) / DAY_MS);
      if (daysUntil > list.reminderDaysBefore) continue; // not yet within the reminder window
      if (daysUntil < -365) continue; // too old to keep nagging
      const jid = jidFromPhone(item.fields[matchKey(item.fields, list.reminderPhoneField)]);
      if (!jid) continue;
      const body = fillTemplate(list.reminderTemplate, item.fields) || defaultMessage(list, daysUntil);
      // Anti-ban: daily bulk cap + paced sends.
      // eslint-disable-next-line no-await-in-loop
      const slot = await throttle.take(userId);
      if (!slot.ok) {
        logger.warn({ userId, reason: slot.reason }, 'reminders stopped by bulk cap');
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await throttle.gate(userId);
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await manager.sendText(userId, jid, body);
        // eslint-disable-next-line no-await-in-loop
        await lists.markReminded(item.id);
        if (out) {
          audit.log(userId, { chatId: jid, phone: jid.split('@')[0], action: 'reminder_sent', detail: `${list.name}: ${body.slice(0, 150)}` });
          mem
            .appendMessage(userId, jid, 'assistant', body, {
              waMsgId: out?.key?.id,
              ts: Math.floor(now / 1000),
              source: 'bot',
            })
            .catch(() => {});
          sent += 1;
        }
      } catch (err) {
        logger.warn({ userId, err: err.message }, 'reminder send failed');
      }
    }
  }
  if (sent) logger.info({ userId, sent }, 'sent list reminders');
}

async function runForAll() {
  let ids = [];
  try {
    ids = await settingsDb.listUserIds();
  } catch (err) {
    logger.warn({ err: err.message }, 'reminders: could not list users');
    return;
  }
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runForUser(id);
    } catch (err) {
      logger.warn({ userId: id, err: err.message }, 'reminder run failed');
    }
  }
}

module.exports = { runForUser, runForAll, parseDate, fillTemplate };
