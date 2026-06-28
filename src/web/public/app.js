'use strict';

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch (_) { body = {}; }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ── View switching ───────────────────────────────────────────────────────────
function closeNav() {
  document.body.classList.remove('nav-open');
  $('navToggle')?.setAttribute('aria-expanded', 'false');
}
function show(view) {
  $('landingView').classList.toggle('hidden', view !== 'landing');
  $('authShell').classList.toggle('hidden', view !== 'auth');
  $('appView').classList.toggle('hidden', view !== 'app');
  closeNav();
}

// ── Auth ─────────────────────────────────────────────────────────────────────
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('tabLogin').classList.toggle('active', mode === 'login');
  $('tabSignup').classList.toggle('active', mode === 'signup');
  $('authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('authHint').textContent = mode === 'login' ? 'Welcome back.' : 'Use at least 8 characters.';
  $('password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('authError').textContent = '';
}
$('tabLogin').onclick = () => setAuthMode('login');
$('tabSignup').onclick = () => setAuthMode('signup');
$('backHome').onclick = () => show('landing');
document.querySelectorAll('[data-auth]').forEach((b) => {
  b.onclick = () => { show('auth'); setAuthMode(b.dataset.auth); };
});

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  try {
    await api(`/api/auth/${authMode === 'login' ? 'login' : 'signup'}`, {
      method: 'POST',
      body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }),
    });
    await boot();
  } catch (err) {
    $('authError').textContent = err.message;
  }
};

$('logoutBtn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  stopPolling();
  show('landing');
};

// ── Sidebar nav ──────────────────────────────────────────────────────────────
// Standalone panels live directly under .content; the rest live in #settingsForm.
const STANDALONE_PANELS = ['connect', 'lists', 'payments'];
function showPanel(name) {
  document.querySelectorAll('.side-nav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.nav === name),
  );
  const standalone = STANDALONE_PANELS.includes(name);
  document.querySelectorAll('.content > section[data-panel]').forEach((p) =>
    p.classList.toggle('hidden', p.dataset.panel !== name),
  );
  $('settingsForm').classList.toggle('hidden', standalone);
  document.querySelectorAll('#settingsForm [data-panel]').forEach((p) =>
    p.classList.toggle('hidden', p.dataset.panel !== name),
  );
  if (name === 'lists') loadLists();
  if (name === 'payments') loadPaymentQr();
}
document.querySelectorAll('.side-nav button').forEach((b) => {
  b.onclick = () => { showPanel(b.dataset.nav); closeNav(); };
});

// Mobile drawer toggle.
$('navToggle').onclick = () => {
  const open = document.body.classList.toggle('nav-open');
  $('navToggle').setAttribute('aria-expanded', String(open));
};
$('scrim').onclick = closeNav;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNav();
});

// ── Quick Answers (FAQs) ─────────────────────────────────────────────────────
function addFaqRow(q = '', a = '') {
  const list = $('faqList');
  const wrap = document.createElement('div');
  wrap.className = 'faq-row';
  const qIn = document.createElement('input');
  qIn.type = 'text'; qIn.className = 'faq-q'; qIn.placeholder = 'Question (e.g. Office address?)';
  qIn.value = q;
  const aIn = document.createElement('textarea');
  aIn.className = 'faq-a'; aIn.rows = 2; aIn.placeholder = 'Short answer / basic facts';
  aIn.value = a;
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'faq-del'; del.title = 'Remove'; del.textContent = '✕';
  del.onclick = () => wrap.remove();
  wrap.append(qIn, aIn, del);
  list.appendChild(wrap);
  return qIn;
}
function fillFaqs(faqs) {
  const list = $('faqList');
  list.innerHTML = '';
  (Array.isArray(faqs) ? faqs : []).forEach((f) => addFaqRow(f.q || '', f.a || ''));
}
function collectFaqs() {
  return Array.from(document.querySelectorAll('#faqList .faq-row'))
    .map((r) => ({
      q: r.querySelector('.faq-q').value.trim(),
      a: r.querySelector('.faq-a').value.trim(),
    }))
    .filter((f) => f.q && f.a);
}
$('addFaqBtn').onclick = () => addFaqRow().focus();
document.querySelectorAll('.faq-preset').forEach((b) => {
  b.onclick = () => addFaqRow(b.dataset.q, '').nextSibling.focus();
});

// ── Settings ─────────────────────────────────────────────────────────────────
function applyProviderVisibility() {
  const p = $('provider').value;
  $('anthropicBox').classList.toggle('hidden', p !== 'anthropic');
  $('deepseekBox').classList.toggle('hidden', p !== 'deepseek');
}
$('provider').onchange = applyProviderVisibility;

function fillSettings(s) {
  $('provider').value = s.provider || 'anthropic';
  $('model').value = s.model || 'claude-opus-4-8';
  $('deepseekModel').value = s.deepseekModel || 'deepseek-chat';
  $('deepseekApiKey').value = '';
  $('deepseekKeyHint').textContent = s.hasDeepseekKey
    ? 'A DeepSeek key is set (encrypted). Leave blank to keep it.'
    : 'No DeepSeek key set yet. Get one at platform.deepseek.com.';
  applyProviderVisibility();
  $('ownerName').value = s.ownerName || '';
  $('businessName').value = s.businessName || '';
  $('businessDescription').value = s.businessDescription || '';
  $('personaStyle').value = s.personaStyle || 'friendly';
  $('personaCustom').value = s.personaCustom || '';
  fillFaqs(s.faqs);
  $('learnStyleStatus').textContent = s.learnedStyle
    ? `✅ Learned your style${s.learnedStyleAt ? ` (updated ${new Date(s.learnedStyleAt).toLocaleString()})` : ''}. It re-learns daily.`
    : 'Not learned yet — link WhatsApp (imports your history), then click the button.';
  $('replyMode').value = s.replyMode || 'off';
  $('ignoreGroups').checked = s.ignoreGroups !== false;
  $('allowlist').value = s.allowlist || '';
  $('blocklist').value = s.blocklist || '';
  $('minIntervalSeconds').value = s.minIntervalSeconds ?? 2;
  $('replyDelayMin').value = s.replyDelayMin ?? 2;
  $('replyDelayMax').value = s.replyDelayMax ?? 6;
  $('followupsEnabled').checked = s.followupsEnabled === true;
  $('followupsHours').value = s.followupsHours ?? 24;
  $('businessHoursStart').value = s.businessHoursStart ?? '';
  $('businessHoursEnd').value = s.businessHoursEnd ?? '';
  $('apiKey').value = '';
  $('apiKeyHint').textContent = s.hasApiKey
    ? 'A key is set (encrypted). Leave blank to keep it.'
    : 'No key set yet — paste your Anthropic API key to enable replies.';
}

async function loadSettings() {
  const { settings } = await api('/api/settings');
  fillSettings(settings);
}

function intOrNull(v) {
  if (v === '' || v == null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

$('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  $('settingsError').textContent = '';
  $('settingsOk').textContent = '';
  const payload = {
    ownerName: $('ownerName').value,
    businessName: $('businessName').value,
    businessDescription: $('businessDescription').value,
    personaStyle: $('personaStyle').value,
    personaCustom: $('personaCustom').value,
    faqs: collectFaqs(),
    provider: $('provider').value,
    model: $('model').value,
    deepseekModel: $('deepseekModel').value,
    replyMode: $('replyMode').value,
    ignoreGroups: $('ignoreGroups').checked,
    allowlist: $('allowlist').value,
    blocklist: $('blocklist').value,
    minIntervalSeconds: intOrNull($('minIntervalSeconds').value) ?? 2,
    replyDelayMin: intOrNull($('replyDelayMin').value) ?? 2,
    replyDelayMax: intOrNull($('replyDelayMax').value) ?? 6,
    followupsEnabled: $('followupsEnabled').checked,
    followupsHours: intOrNull($('followupsHours').value) ?? 24,
    businessHoursStart: intOrNull($('businessHoursStart').value),
    businessHoursEnd: intOrNull($('businessHoursEnd').value),
  };
  const key = $('apiKey').value.trim();
  if (key) payload.apiKey = key;
  const dsKey = $('deepseekApiKey').value.trim();
  if (dsKey) payload.deepseekApiKey = dsKey;

  try {
    const { settings } = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    fillSettings(settings);
    $('settingsOk').textContent = 'Saved.';
    setTimeout(() => ($('settingsOk').textContent = ''), 2500);
  } catch (err) {
    $('settingsError').textContent = err.message;
  }
};

$('testKeyBtn').onclick = async () => {
  const out = $('testKeyResult');
  out.textContent = 'Testing…';
  try {
    const r = await api('/api/settings/test', { method: 'POST' });
    out.textContent = r.ok ? `✅ Working (${r.provider} / ${r.model})` : `❌ ${r.error || 'Failed'}`;
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  }
};

$('learnStyleBtn').onclick = async () => {
  const out = $('learnStyleResult');
  out.textContent = 'Learning from your past chats…';
  try {
    const r = await api('/api/settings/learn-style', { method: 'POST' });
    if (r.ok) { out.textContent = `✅ Learned from ${r.samples} of your messages`; await loadSettings(); }
    else out.textContent = `❌ ${r.error || 'Could not learn'}`;
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  }
};

// ── Diagnostics ──────────────────────────────────────────────────────────────
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
const RESULT_TEXT = {
  replied: ['good', 'Replied to the last message'],
  mode_off: ['bad', 'Reply mode is OFF — set it to Auto and save'],
  no_api_key: ['bad', 'No API key for the selected provider — add it / fix the provider'],
  not_allowed: ['bad', 'Sender is blocked or not in your allowlist'],
  rate_limited: ['bad', 'Skipped: too soon after the previous reply'],
  after_hours: ['good', 'Outside business hours — sent the holding message'],
  group_ignored: ['bad', 'Group chat — ignored (by setting)'],
  ignored: ['bad', 'Agent chose not to reply (spam / not worth it)'],
  escalated: ['good', 'Escalated to you'],
  empty_reply: ['bad', 'Agent produced an empty reply'],
  settings_load_failed: ['bad', 'Could not load your settings (database issue?)'],
  handler_error: ['bad', 'Internal error handling the message (check logs)'],
};
function resolveResult(r) {
  if (!r) return ['', 'no messages processed yet'];
  if (RESULT_TEXT[r]) return RESULT_TEXT[r];
  if (r.startsWith('no_text:')) return ['bad', `Message had no readable text (type: ${r.slice(8)})`];
  if (r.startsWith('no_content:stub_2')) return ['bad', 'WhatsApp could NOT decrypt the message (CIPHERTEXT). Broken session — typical of a WhatsApp Business contact. Use a normal WhatsApp number.'];
  if (r.startsWith('no_content:decrypt_failed')) return ['bad', 'Message could NOT be decrypted (common with WhatsApp Business). Re-link, or use a normal WhatsApp number.'];
  if (r.startsWith('no_content:')) return ['bad', `No message content (${r.slice(11)})`];
  return ['', r];
}
function row(label, cls, value) {
  return `<div class="row-item"><span>${label}</span><span class="${cls}">${value}</span></div>`;
}
function renderDiag(d) {
  const wa = d.wa || {}, a = d.activity || {}, s = d.settings || {}, k = d.keyTest || {};
  const waOk = wa.status === 'open', modeOk = s.replyMode === 'auto';
  const [rcls, rtxt] = resolveResult(a.lastResult);
  $('diag').innerHTML = [
    row('WhatsApp connection', waOk ? 'good' : 'bad', waOk ? 'connected' : wa.status || 'idle'),
    row('Reply mode', modeOk ? 'good' : 'bad', s.replyMode || '—'),
    row('API key', k.ok ? 'good' : 'bad', k.ok ? `working (${k.provider}/${k.model})` : `❌ ${k.error || 'not working'}`),
    row('Last message received', a.lastIncomingAt ? 'good' : 'bad', ago(a.lastIncomingAt)),
    row('Last reply sent', 'muted', ago(a.lastSentAt)),
    row('Last outcome', rcls, rtxt),
  ].join('');
  $('diag').classList.remove('hidden');
}
$('diagBtn').onclick = async () => {
  $('diag').classList.remove('hidden');
  $('diag').textContent = 'Running…';
  try { renderDiag(await api('/api/wa/diagnostics')); }
  catch (e) { $('diag').textContent = `Error: ${e.message}`; }
};

// ── Data Lists ───────────────────────────────────────────────────────────────
let currentListId = null;
let currentColumns = []; // known column names for the selected list (drives the add-row form)
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim()).filter(Boolean);
  return lines
    .slice(1)
    .map((line) => {
      const vals = line.split(',').map((v) => v.trim());
      const obj = {};
      headers.forEach((h, i) => { if (vals[i] !== undefined && vals[i] !== '') obj[h] = vals[i]; });
      return obj;
    })
    .filter((o) => Object.keys(o).length);
}

function renderItems(items) {
  const cont = $('itemsTable');
  $('itemCount').textContent = items.length ? `(${items.length})` : '';
  const cols = [];
  items.forEach((it) => Object.keys(it.fields).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  // Remember the columns so the add-row form can show one field per column.
  currentColumns = cols;
  renderRowForm();
  if (!items.length) {
    cont.innerHTML = '<p class="muted small">No rows yet — add one below, or paste a CSV.</p>';
    return;
  }
  const head = '<tr>' + cols.map((c) => `<th>${esc(c)}</th>`).join('') + '<th></th></tr>';
  const rows = items
    .map(
      (it) =>
        '<tr>' +
        cols.map((c) => `<td>${esc(it.fields[c] ?? '')}</td>`).join('') +
        `<td><button class="faq-del" data-del="${it.id}">✕</button></td></tr>`,
    )
    .join('');
  cont.innerHTML = `<table class="data-table">${head}${rows}</table>`;
  cont.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => deleteItem(b.dataset.del); });
}

// Build a "name: [value]" field row for the add-row form. `name` is the column;
// when it's a known column the name is shown as a fixed label, otherwise it's an
// editable input so the user can introduce a brand-new column on the fly.
function addRowField(name = '', { known = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'row-field';
  if (known) {
    const lbl = document.createElement('span');
    lbl.className = 'row-field-name';
    lbl.textContent = name;
    lbl.title = name;
    wrap.dataset.name = name;
    wrap.appendChild(lbl);
  } else {
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.className = 'row-field-key';
    nameIn.placeholder = 'column'; nameIn.value = name;
    wrap.appendChild(nameIn);
  }
  const valIn = document.createElement('input');
  valIn.type = 'text'; valIn.className = 'row-field-val'; valIn.placeholder = 'value';
  wrap.appendChild(valIn);
  if (!known) {
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'faq-del'; del.title = 'Remove column'; del.textContent = '✕';
    del.onclick = () => wrap.remove();
    wrap.appendChild(del);
  }
  $('rowFields').appendChild(wrap);
  return wrap;
}

// Render one field per known column. For a brand-new list with no columns yet,
// seed a couple of blank editable fields so the user can define columns inline.
function renderRowForm() {
  const cont = $('rowFields');
  if (!cont) return;
  cont.innerHTML = '';
  if (currentColumns.length) {
    currentColumns.forEach((c) => addRowField(c, { known: true }));
  } else {
    addRowField('', { known: false });
    addRowField('', { known: false });
  }
}

function collectRow() {
  const obj = {};
  document.querySelectorAll('#rowFields .row-field').forEach((w) => {
    const name = (w.dataset.name ?? w.querySelector('.row-field-key')?.value ?? '').trim();
    const val = (w.querySelector('.row-field-val')?.value ?? '').trim();
    if (name && val) obj[name] = val;
  });
  return obj;
}

async function loadLists() {
  let lists = [];
  try { ({ lists } = await api('/api/lists')); } catch (_) { lists = []; }
  const chips = $('listChips');
  chips.innerHTML = '';
  lists.forEach((l) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'list-chip' + (l.id === currentListId ? ' active' : '');
    b.textContent = `${l.name} · ${l.itemCount ?? 0}`;
    b.onclick = () => selectList(l.id);
    chips.appendChild(b);
  });
  if (currentListId && !lists.find((l) => l.id === currentListId)) {
    currentListId = null;
    $('listEditor').classList.add('hidden');
  }
  return lists;
}

async function selectList(id) {
  const lists = await loadLists();
  const l = lists.find((x) => x.id === id);
  if (!l) return;
  currentListId = id;
  $('listName').value = l.name;
  $('listInstructions').value = l.instructions || '';
  $('remEnabled').checked = l.reminderEnabled === true;
  $('remDate').value = l.reminderDateField || '';
  $('remPhone').value = l.reminderPhoneField || '';
  $('remDays').value = l.reminderDaysBefore ?? 0;
  $('remTemplate').value = l.reminderTemplate || '';
  $('listEditor').classList.remove('hidden');
  $('csvInput').value = '';
  $('csvResult').textContent = '';
  $('rowResult').textContent = '';
  $('listSaved').textContent = '';
  currentColumns = [];
  renderRowForm();
  try { renderItems((await api(`/api/lists/${id}/items`)).items); } catch (_) {}
  // re-highlight the active chip
  document.querySelectorAll('#listChips .list-chip').forEach((c) =>
    c.classList.toggle('active', c.textContent.startsWith(`${l.name} ·`)),
  );
}

async function loadItems() {
  if (!currentListId) return;
  try { renderItems((await api(`/api/lists/${currentListId}/items`)).items); } catch (_) {}
}

// Ready-made list templates: a name, the columns to pre-fill the add-row form,
// instructions for the agent, and (optionally) reminder defaults. Picking one
// creates the list pre-configured so the user only has to add rows.
const LIST_TEMPLATES = [
  {
    key: 'products', label: '🛍️ Products', name: 'Products',
    columns: ['name', 'price', 'description', 'image'],
    instructions:
      'These are our products and prices. Quote from here, answer questions, take orders, '
      + 'and if a customer asks for a photo share the value in the "image" column.',
  },
  {
    key: 'services', label: '🧰 Services', name: 'Services',
    columns: ['service', 'price', 'duration', 'description'],
    instructions:
      'These are the services we offer with pricing. Explain what each includes, quote prices, '
      + 'and help the customer book or take the next step.',
  },
  {
    key: 'pricelist', label: '🏷️ Price list', name: 'Price List',
    columns: ['item', 'unit', 'price'],
    instructions: 'Our rate card. Answer "how much for X" questions using these prices.',
  },
  {
    key: 'leads', label: '🎯 Leads', name: 'Leads',
    columns: ['name', 'phone', 'interest', 'status', 'notes'],
    instructions:
      'These are leads/prospects. If a message comes from one of these numbers, greet them by '
      + 'name, remember their interest, and gently move them towards a sale.',
  },
  {
    key: 'customers', label: '👥 Customers', name: 'Customers',
    columns: ['name', 'phone', 'email', 'notes'],
    instructions: 'Our customers. Greet them by name and use their notes for context.',
  },
  {
    key: 'faq', label: '❓ FAQ', name: 'FAQs',
    columns: ['question', 'answer'],
    instructions: 'Common questions and the exact answers to give. Match the closest question and reply with its answer.',
  },
  {
    key: 'emi', label: '🏦 EMI / Loan customers', name: 'EMI Customers',
    columns: ['name', 'phone', 'amount', 'due_date'],
    instructions: 'Loan/EMI customers and their due dates. Use this to answer balance and due-date questions.',
    reminder: {
      enabled: true, dateField: 'due_date', phoneField: 'phone', daysBefore: 3,
      template: 'Hi {name}, your EMI of Rs {amount} is due on {due_date}. Please pay on time to avoid late charges.',
    },
  },
  {
    key: 'gst', label: '📊 GST / Tax clients', name: 'GST Clients',
    columns: ['name', 'phone', 'gstin', 'due_date'],
    instructions: 'Tax/GST filing clients and their filing due dates.',
    reminder: {
      enabled: true, dateField: 'due_date', phoneField: 'phone', daysBefore: 3,
      template: 'Hi {name}, your GST filing is due on {due_date}. Please share your data so we can file on time.',
    },
  },
  {
    key: 'appointments', label: '📅 Appointments', name: 'Appointments',
    columns: ['name', 'phone', 'date', 'notes'],
    instructions: 'Booked appointments. Confirm timings and remind people before their slot.',
    reminder: {
      enabled: true, dateField: 'date', phoneField: 'phone', daysBefore: 1,
      template: 'Hi {name}, this is a reminder of your appointment on {date}. See you then!',
    },
  },
];

async function createFromTemplate(t) {
  const { list } = await api('/api/lists', { method: 'POST', body: JSON.stringify({ name: t.name }) });
  // Apply instructions + reminder config.
  const patch = { name: t.name, instructions: t.instructions || '' };
  if (t.reminder) {
    patch.reminderEnabled = true;
    patch.reminderDateField = t.reminder.dateField;
    patch.reminderPhoneField = t.reminder.phoneField;
    patch.reminderDaysBefore = t.reminder.daysBefore;
    patch.reminderTemplate = t.reminder.template;
  }
  try { await api(`/api/lists/${list.id}`, { method: 'PUT', body: JSON.stringify(patch) }); } catch (_) {}
  await selectList(list.id);
  // The list has no rows yet, so seed the add-row form with the template's columns.
  if (Array.isArray(t.columns) && t.columns.length) {
    currentColumns = t.columns.slice();
    renderRowForm();
  }
}

function renderTemplateChips() {
  const cont = $('templateChips');
  if (!cont) return;
  cont.innerHTML = '';
  LIST_TEMPLATES.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'template-chip';
    b.textContent = t.label;
    b.title = t.instructions || t.name;
    b.onclick = () => createFromTemplate(t);
    cont.appendChild(b);
  });
}
renderTemplateChips();

$('newListBtn').onclick = async () => {
  const name = prompt('List name (e.g. Products, EMI Customers, Leads)');
  if (!name || !name.trim()) return;
  const { list } = await api('/api/lists', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
  await selectList(list.id);
};
$('saveListBtn').onclick = async () => {
  if (!currentListId) return;
  const payload = {
    name: $('listName').value.trim(),
    instructions: $('listInstructions').value,
    reminderEnabled: $('remEnabled').checked,
    reminderDateField: $('remDate').value.trim(),
    reminderPhoneField: $('remPhone').value.trim(),
    reminderDaysBefore: parseInt($('remDays').value, 10) || 0,
    reminderTemplate: $('remTemplate').value,
  };
  try {
    await api(`/api/lists/${currentListId}`, { method: 'PUT', body: JSON.stringify(payload) });
    $('listSaved').textContent = 'Saved.';
    setTimeout(() => ($('listSaved').textContent = ''), 2000);
    loadLists();
  } catch (e) {
    $('listSaved').textContent = e.message;
  }
};
$('deleteListBtn').onclick = async () => {
  if (!currentListId || !confirm('Delete this list and all its rows?')) return;
  await api(`/api/lists/${currentListId}`, { method: 'DELETE' });
  currentListId = null;
  $('listEditor').classList.add('hidden');
  loadLists();
};
$('addFieldBtn').onclick = () => { addRowField('', { known: false }).querySelector('.row-field-key').focus(); };
$('addRowBtn').onclick = async () => {
  if (!currentListId) return;
  const row = collectRow();
  if (!Object.keys(row).length) { $('rowResult').textContent = 'Fill in at least one column and value.'; return; }
  try {
    await api(`/api/lists/${currentListId}/items`, {
      method: 'POST',
      body: JSON.stringify({ items: [row] }),
    });
    $('rowResult').textContent = 'Added.';
    setTimeout(() => ($('rowResult').textContent = ''), 1800);
    await loadItems(); // re-renders the form with any new columns
    loadLists();
  } catch (e) {
    $('rowResult').textContent = e.message;
  }
};
$('addRowsBtn').onclick = async () => {
  if (!currentListId) return;
  const items = parseCsv($('csvInput').value);
  if (!items.length) { $('csvResult').textContent = 'Nothing to add — check the format (first line = column names).'; return; }
  try {
    const { added } = await api(`/api/lists/${currentListId}/items`, {
      method: 'POST',
      body: JSON.stringify({ items, replace: $('csvReplace').checked }),
    });
    $('csvResult').textContent = `Added ${added} row(s).`;
    $('csvInput').value = '';
    $('csvReplace').checked = false;
    await loadItems();
    loadLists();
  } catch (e) {
    $('csvResult').textContent = e.message;
  }
};
async function deleteItem(itemId) {
  await api(`/api/lists/${currentListId}/items/${itemId}`, { method: 'DELETE' });
  await loadItems();
  loadLists();
}

// ── Payment QR ───────────────────────────────────────────────────────────────
async function loadPaymentQr() {
  let qr = null;
  try { ({ qr } = await api('/api/settings/payment-qr')); } catch (_) {}
  const img = $('qrPreview');
  if (qr) {
    img.src = qr;
    img.classList.remove('hidden');
    $('qrNone').classList.add('hidden');
    $('qrRemoveBtn').classList.remove('hidden');
  } else {
    img.classList.add('hidden');
    $('qrNone').classList.remove('hidden');
    $('qrRemoveBtn').classList.add('hidden');
  }
}
$('qrFile').onchange = () => {
  const file = $('qrFile').files[0];
  if (!file) return;
  if (file.size > 1200000) { $('qrMsg').textContent = 'Image too large (max ~1MB).'; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ paymentQr: reader.result }) });
      $('qrMsg').textContent = 'Saved.';
      setTimeout(() => ($('qrMsg').textContent = ''), 2000);
      loadPaymentQr();
    } catch (e) {
      $('qrMsg').textContent = e.message;
    }
  };
  reader.readAsDataURL(file);
  $('qrFile').value = '';
};
$('qrRemoveBtn').onclick = async () => {
  if (!confirm('Remove the payment QR?')) return;
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ paymentQr: '' }) });
  loadPaymentQr();
};

// ── WhatsApp linking ─────────────────────────────────────────────────────────
let pollTimer = null;
function renderWaState(st) {
  const badge = $('waStatus');
  badge.textContent = st.status;
  badge.className = 'badge ' + st.status;
  const showQr = st.status === 'qr' && st.qr;
  $('qrWrap').classList.toggle('hidden', !showQr);
  if (showQr) $('qrImg').src = st.qr;
}
async function refreshWa() {
  try { renderWaState(await api('/api/wa/status')); } catch (_) {}
}
function startPolling() { if (!pollTimer) pollTimer = setInterval(refreshWa, 2000); }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

$('waStartBtn').onclick = async () => { renderWaState(await api('/api/wa/start', { method: 'POST' })); startPolling(); };
$('waStopBtn').onclick = async () => { renderWaState(await api('/api/wa/stop', { method: 'POST' })); };
$('waLogoutBtn').onclick = async () => {
  if (!confirm('Unlink WhatsApp? You will need to scan the QR again.')) return;
  renderWaState(await api('/api/wa/logout', { method: 'POST' }));
};

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const { user } = await api('/api/auth/me');
    $('userEmail').textContent = user.email;
    show('app');
    showPanel('connect');
    await loadSettings();
    await refreshWa();
    startPolling();
  } catch (_) {
    show('landing');
  }
}

boot();
