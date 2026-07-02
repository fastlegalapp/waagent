'use strict';

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch (_) { body = {}; }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ── Language (English / Hindi) ───────────────────────────────────────────────
// Lightweight chrome translation: nav, headings and primary actions. Field-level
// labels stay in English (the Hinglish convention most Indian SaaS follows).
const I18N = {
  hi: {
    nav_overview: '📊 सारांश',
    nav_inbox: '💬 इनबॉक्स',
    nav_connect: '📱 कनेक्ट करें',
    nav_persona: '🗣️ बात करने का तरीका',
    nav_faqs: '📋 तुरंत जवाब',
    nav_lists: '📦 लिस्ट',
    nav_crm: '👥 CRM और लीड्स',
    nav_orders: '🧾 ऑर्डर',
    nav_payments: '💳 पेमेंट',
    nav_ai: '🔑 AI प्रोवाइडर',
    nav_billing: '💼 बिलिंग',
    nav_replies: '⚙️ जवाब और फॉलो-अप',
    sign_out: 'साइन आउट',
    h_overview: 'सारांश',
    h_inbox: 'इनबॉक्स',
    h_connect: 'आपका WhatsApp',
    h_lists: 'डेटा लिस्ट',
    h_crm: 'CRM और लीड्स',
    h_orders: 'ऑर्डर',
    h_billing: 'बिलिंग',
    h_payments: 'पेमेंट QR',
    h_persona: 'बात करने का तरीका',
    h_faqs: 'तुरंत जवाब',
    h_ai: 'AI प्रोवाइडर',
    h_replies: 'जवाब और फॉलो-अप',
    btn_connect: 'लिंक / कनेक्ट करें',
    btn_save: 'सेटिंग्स सेव करें',
  },
};
let currentLang = localStorage.getItem('lang') === 'hi' ? 'hi' : 'en';
const I18N_DEFAULTS = {}; // filled from the DOM's English text on first apply

function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (!(key in I18N_DEFAULTS)) I18N_DEFAULTS[key] = el.textContent;
    el.textContent = (currentLang === 'hi' && I18N.hi[key]) || I18N_DEFAULTS[key];
  });
  const t = $('langToggle');
  if (t) t.textContent = currentLang === 'hi' ? 'View in English' : 'हिंदी में देखें';
}
document.addEventListener('DOMContentLoaded', applyLang);
applyLang();
$('langToggle').onclick = () => {
  currentLang = currentLang === 'hi' ? 'en' : 'hi';
  localStorage.setItem('lang', currentLang);
  applyLang();
};

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
const STANDALONE_PANELS = ['overview', 'inbox', 'connect', 'lists', 'crm', 'orders', 'payments', 'billing'];
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
  if (name === 'overview') loadOverview();
  if (name === 'inbox') loadInbox();
  if (name !== 'inbox') closeThread();
  if (name === 'lists') loadLists();
  if (name === 'crm') loadCrm();
  if (name === 'orders') loadOrders();
  if (name === 'payments') loadPaymentQr();
  if (name === 'billing') loadBilling();
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
  subscription_expired: ['bad', 'Subscription expired — renew in Billing to resume auto-replies'],
  not_allowed: ['bad', 'Sender is blocked or not in your allowlist'],
  rate_limited: ['bad', 'Skipped: too soon after the previous reply'],
  paused: ['bad', 'Agent is paused for this chat (you took over) — resume it from the Inbox'],
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
  const head = '<tr>' + cols.map((c) => `<th>${esc(c)}</th>`).join('') + '<th>photo</th><th></th></tr>';
  const rows = items
    .map(
      (it) =>
        '<tr>' +
        cols.map((c) => `<td>${esc(it.fields[c] ?? '')}</td>`).join('') +
        `<td class="item-photo-cell">
           <button class="ghost small" data-photo="${it.id}" title="${it.hasPhoto ? 'Replace the photo' : 'Add a photo — sent when a customer asks to see this item'}">${it.hasPhoto ? '🖼️' : '📷+'}</button>
           ${it.hasPhoto ? `<button class="faq-del" data-photodel="${it.id}" title="Remove photo">✕</button>` : ''}
         </td>` +
        `<td><button class="faq-del" data-del="${it.id}">✕</button></td></tr>`,
    )
    .join('');
  cont.innerHTML = `<table class="data-table">${head}${rows}</table>`;
  cont.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => deleteItem(b.dataset.del); });
  cont.querySelectorAll('[data-photo]').forEach((b) => { b.onclick = () => pickItemPhoto(b.dataset.photo); });
  cont.querySelectorAll('[data-photodel]').forEach((b) => {
    b.onclick = async () => {
      await api(`/api/lists/${currentListId}/items/${b.dataset.photodel}/photo`, { method: 'PUT', body: JSON.stringify({ photo: '' }) });
      loadItems();
    };
  });
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

// Ready-made list templates. Each has a name, columns to pre-fill the add-row
// form, agent instructions, optional reminder defaults, and — for the
// business-type presets — a few sample `rows` that are inserted automatically
// so the user starts with a working catalogue they can edit or replace.
const PRODUCT_INSTRUCTIONS =
  'This is our product catalogue with prices. Quote from here, answer questions, take orders, '
  + 'and if a customer asks for a photo share the value in the "image" column.';

const BUSINESS_TEMPLATES = [
  {
    key: 'grocery', label: '🛒 Grocery store', name: 'Grocery Products',
    columns: ['name', 'unit', 'price', 'image'],
    instructions: PRODUCT_INSTRUCTIONS,
    rows: [
      { name: 'Aashirvaad Atta', unit: '5 kg', price: '265' },
      { name: 'Toor Dal', unit: '1 kg', price: '160' },
      { name: 'Basmati Rice', unit: '5 kg', price: '480' },
      { name: 'Fortune Sunflower Oil', unit: '1 L', price: '140' },
      { name: 'Sugar', unit: '1 kg', price: '45' },
      { name: 'Tata Salt', unit: '1 kg', price: '28' },
      { name: 'Amul Milk', unit: '500 ml', price: '34' },
      { name: 'Red Label Tea', unit: '250 g', price: '140' },
      { name: 'Maggi Noodles', unit: '4 pack', price: '60' },
      { name: 'Britannia Bread', unit: '400 g', price: '45' },
    ],
  },
  {
    key: 'vegfruit', label: '🥦 Vegetable & fruit', name: 'Vegetables & Fruits',
    columns: ['name', 'unit', 'price'],
    instructions: PRODUCT_INSTRUCTIONS + ' Prices may change daily — update them each morning.',
    rows: [
      { name: 'Tomato', unit: '1 kg', price: '40' },
      { name: 'Onion', unit: '1 kg', price: '35' },
      { name: 'Potato', unit: '1 kg', price: '30' },
      { name: 'Banana', unit: '1 dozen', price: '50' },
      { name: 'Apple', unit: '1 kg', price: '160' },
      { name: 'Lady Finger', unit: '500 g', price: '25' },
      { name: 'Spinach', unit: '1 bunch', price: '20' },
    ],
  },
  {
    key: 'restaurant', label: '🍽️ Restaurant / café', name: 'Menu',
    columns: ['item', 'category', 'price', 'description'],
    instructions:
      'This is our food menu. Answer questions about dishes, suggest items, and take orders. '
      + 'Mention if something is spicy or a bestseller when relevant.',
    rows: [
      { item: 'Masala Dosa', category: 'South Indian', price: '90', description: 'Crispy dosa with potato filling' },
      { item: 'Paneer Butter Masala', category: 'Main Course', price: '220', description: 'Creamy tomato gravy' },
      { item: 'Veg Biryani', category: 'Rice', price: '180', description: 'Served with raita' },
      { item: 'Butter Naan', category: 'Breads', price: '40', description: '' },
      { item: 'Masala Chai', category: 'Beverages', price: '20', description: '' },
      { item: 'Gulab Jamun', category: 'Dessert', price: '60', description: '2 pieces' },
    ],
  },
  {
    key: 'bakery', label: '🧁 Bakery', name: 'Bakery Products',
    columns: ['name', 'price', 'description', 'image'],
    instructions: PRODUCT_INSTRUCTIONS + ' Cakes may need a day\'s notice — mention that for custom orders.',
    rows: [
      { name: 'Chocolate Truffle Cake', price: '650', description: '500 g' },
      { name: 'Black Forest Cake', price: '600', description: '500 g' },
      { name: 'Vanilla Pastry', price: '50', description: 'per piece' },
      { name: 'Veg Puff', price: '30', description: '' },
      { name: 'Brown Bread', price: '45', description: '' },
      { name: 'Cookies (Assorted)', price: '250', description: '500 g box' },
    ],
  },
  {
    key: 'pharmacy', label: '💊 Medical store / pharmacy', name: 'Medical Store Stock',
    columns: ['name', 'pack', 'price'],
    instructions:
      'Our medicine and healthcare stock. Help with availability and prices, and take orders for home '
      + 'delivery. NEVER give medical advice, dosage or suggest medicines for symptoms — for any '
      + 'prescription medicine, ask the customer to share the doctor\'s prescription, and for health '
      + 'concerns advise them to consult a doctor.',
    chatExtra:
      'IMPORTANT: This is a medical store. Do NOT diagnose, recommend medicines for symptoms, or give '
      + 'dosage advice. For prescription medicines, ask for a photo of the doctor\'s prescription. For '
      + 'any health problem, politely advise consulting a doctor.',
    rows: [
      { name: 'Paracetamol 500mg', pack: '10 tablets', price: '25' },
      { name: 'Dolo 650', pack: '15 tablets', price: '32' },
      { name: 'Digene Gel', pack: '200 ml', price: '120' },
      { name: 'Dettol Antiseptic', pack: '100 ml', price: '60' },
      { name: 'Hand Sanitizer', pack: '200 ml', price: '90' },
      { name: 'Surgical Mask', pack: '50 pcs', price: '150' },
      { name: 'Glucometer Strips', pack: '25 strips', price: '550' },
      { name: 'Vitamin C Tablets', pack: '20 tablets', price: '110' },
    ],
  },
  {
    key: 'salon', label: '💇 Salon & spa', name: 'Salon Services',
    columns: ['service', 'price', 'duration'],
    instructions:
      'These are our salon/spa services and prices. Explain what each includes, quote prices, and help the customer book a slot.',
    rows: [
      { service: 'Haircut (Men)', price: '150', duration: '30 min' },
      { service: 'Haircut (Women)', price: '350', duration: '45 min' },
      { service: 'Hair Spa', price: '800', duration: '60 min' },
      { service: 'Facial', price: '700', duration: '45 min' },
      { service: 'Threading', price: '50', duration: '10 min' },
      { service: 'Manicure', price: '400', duration: '40 min' },
    ],
  },
  {
    key: 'boutique', label: '👗 Clothing / boutique', name: 'Clothing Catalogue',
    columns: ['name', 'size', 'price', 'image'],
    instructions: PRODUCT_INSTRUCTIONS + ' Ask the customer for size and colour preference before confirming an order.',
    rows: [
      { name: 'Cotton Kurti', size: 'M / L / XL', price: '699' },
      { name: 'Anarkali Suit', size: 'Free Size', price: '1499' },
      { name: 'Denim Jeans', size: '28-36', price: '999' },
      { name: 'Silk Saree', size: 'Free Size', price: '2499' },
      { name: 'Men\'s Formal Shirt', size: 'M / L / XL', price: '799' },
    ],
  },
  {
    key: 'mobile', label: '📱 Mobile / electronics', name: 'Electronics Catalogue',
    columns: ['name', 'price', 'warranty', 'image'],
    instructions: PRODUCT_INSTRUCTIONS + ' Mention warranty and available colours/variants when asked.',
    rows: [
      { name: 'Smartphone Charger (Type-C)', price: '299', warranty: '6 months' },
      { name: 'Bluetooth Earbuds', price: '1299', warranty: '1 year' },
      { name: 'Power Bank 10000mAh', price: '999', warranty: '1 year' },
      { name: 'Tempered Glass', price: '149', warranty: '' },
      { name: 'Phone Back Cover', price: '199', warranty: '' },
    ],
  },
  {
    key: 'hardware', label: '🔧 Hardware store', name: 'Hardware Stock',
    columns: ['name', 'unit', 'price'],
    instructions: PRODUCT_INSTRUCTIONS,
    rows: [
      { name: 'PVC Pipe 1 inch', unit: 'per ft', price: '35' },
      { name: 'Wall Paint (White)', unit: '1 L', price: '320' },
      { name: 'Cement Bag', unit: '50 kg', price: '400' },
      { name: 'Screws (Box)', unit: '100 pcs', price: '120' },
      { name: 'Door Hinge', unit: 'pair', price: '90' },
    ],
  },
];

const SERVICE_INSTRUCTIONS =
  'These are the services/packages we offer with pricing. Explain what each includes, quote prices, '
  + 'and help the customer book — ask for their preferred date and time, then confirm the booking.';

const MEDICAL_CHAT_EXTRA =
  'IMPORTANT: This is a healthcare service. Do NOT diagnose, prescribe medicines, or give dosage/'
  + 'treatment advice over chat. Help with information, fees and appointments only; for any medical '
  + 'concern, ask the patient to book a consultation with the doctor.';

const SERVICE_TEMPLATES = [
  {
    key: 'ayurveda', label: '🌿 Ayurveda doctor / clinic', name: 'Ayurveda Treatments', kind: 'service',
    columns: ['treatment', 'price', 'duration'],
    instructions:
      'Our Ayurvedic consultations and therapies. Share what each includes and its price, and help the '
      + 'patient book an appointment. NEVER diagnose or recommend medicines/remedies over chat — for any '
      + 'health concern, ask them to book a consultation with the doctor.',
    chatExtra: MEDICAL_CHAT_EXTRA,
    rows: [
      { treatment: 'Doctor Consultation', price: '500', duration: '30 min' },
      { treatment: 'Panchakarma (per session)', price: '2500', duration: '90 min' },
      { treatment: 'Abhyanga Full Body Massage', price: '1500', duration: '60 min' },
      { treatment: 'Shirodhara', price: '1800', duration: '45 min' },
      { treatment: 'Nasya Therapy', price: '800', duration: '30 min' },
      { treatment: 'Kati Basti (back pain)', price: '1200', duration: '45 min' },
    ],
    reminder: {
      enabled: true, dateField: 'date', phoneField: 'phone', daysBefore: 1,
      template: 'Hi {name}, this is a reminder of your appointment at our Ayurveda clinic on {date}. Please come 10 minutes early.',
    },
  },
  {
    key: 'hospital', label: '🏥 Hospital / clinic', name: 'Hospital Services', kind: 'service',
    columns: ['service', 'department', 'price'],
    instructions:
      'Our hospital/clinic services, departments and charges. Help patients with information, OPD timings, '
      + 'fees and appointment booking. NEVER diagnose, prescribe, or give medical advice over chat — for '
      + 'symptoms or emergencies, ask them to book an appointment or visit immediately / call emergency.',
    chatExtra: MEDICAL_CHAT_EXTRA + ' For emergencies, tell them to come to the hospital immediately or call the emergency number.',
    rows: [
      { service: 'General OPD Consultation', department: 'General Medicine', price: '300' },
      { service: 'Specialist Consultation', department: 'Cardiology', price: '800' },
      { service: 'Complete Blood Count (CBC)', department: 'Lab', price: '350' },
      { service: 'X-Ray (single)', department: 'Radiology', price: '500' },
      { service: 'ECG', department: 'Cardiology', price: '400' },
      { service: 'Full Body Health Checkup', department: 'Preventive', price: '2500' },
    ],
    reminder: {
      enabled: true, dateField: 'date', phoneField: 'phone', daysBefore: 1,
      template: 'Hi {name}, reminder of your appointment at our hospital on {date}. Please bring your previous reports.',
    },
  },
  {
    key: 'tuition', label: '📚 Tuition / coaching', name: 'Courses', kind: 'service',
    columns: ['course', 'fee', 'schedule', 'duration'],
    instructions:
      'These are the courses/batches we offer. Share fees and timings, answer parents\' questions, '
      + 'and help them enrol or book a demo class.',
    rows: [
      { course: 'Class 10 Maths', fee: '1500/month', schedule: 'Mon-Fri 5pm', duration: '1 hr' },
      { course: 'Class 12 Physics', fee: '2000/month', schedule: 'Mon-Wed-Fri 7pm', duration: '1.5 hr' },
      { course: 'Spoken English', fee: '3000', schedule: 'Sat-Sun 11am', duration: '2 months' },
      { course: 'JEE Foundation', fee: '5000/month', schedule: 'Daily 6pm', duration: '2 hr' },
    ],
  },
  {
    key: 'gym', label: '🏋️ Gym / fitness', name: 'Membership Plans', kind: 'service',
    columns: ['plan', 'price', 'duration', 'includes'],
    instructions:
      'These are our membership plans. Explain what each includes, quote prices, and help the customer '
      + 'join or book a free trial session.',
    rows: [
      { plan: 'Monthly', price: '1500', duration: '1 month', includes: 'Gym + cardio' },
      { plan: 'Quarterly', price: '4000', duration: '3 months', includes: 'Gym + cardio + 1 PT session' },
      { plan: 'Annual', price: '12000', duration: '12 months', includes: 'All access + diet plan' },
      { plan: 'Personal Training', price: '6000', duration: '1 month', includes: 'Daily 1-on-1' },
    ],
  },
  {
    key: 'homeservices', label: '🧹 Home services', name: 'Home Services', kind: 'service',
    columns: ['service', 'price', 'duration'],
    instructions:
      'Home services like cleaning, plumbing, electrical and pest control. Quote prices, and help the '
      + 'customer book a visit — ask for their address and preferred time slot.',
    rows: [
      { service: 'Full Home Deep Cleaning', price: '2499', duration: '4-5 hr' },
      { service: 'Bathroom Cleaning', price: '499', duration: '1 hr' },
      { service: 'Plumbing Visit', price: '299', duration: 'on inspection' },
      { service: 'Electrician Visit', price: '299', duration: 'on inspection' },
      { service: 'Pest Control', price: '1499', duration: '2 hr' },
    ],
  },
  {
    key: 'carservice', label: '🚗 Car / bike service', name: 'Vehicle Services', kind: 'service',
    columns: ['service', 'price', 'duration'],
    instructions:
      'Vehicle servicing and repairs. Quote prices, explain what each service covers, and help the '
      + 'customer book a slot or pickup.',
    rows: [
      { service: 'Bike General Service', price: '499', duration: '2 hr' },
      { service: 'Car General Service', price: '2999', duration: '4 hr' },
      { service: 'Oil Change', price: '799', duration: '30 min' },
      { service: 'Wheel Alignment', price: '499', duration: '45 min' },
      { service: 'Car Wash & Polish', price: '699', duration: '1 hr' },
    ],
  },
  {
    key: 'photography', label: '📸 Photography', name: 'Photography Packages', kind: 'service',
    columns: ['package', 'price', 'includes'],
    instructions:
      'Photography/videography packages. Explain what each includes, quote prices, check the event date '
      + 'availability, and help the customer book.',
    rows: [
      { package: 'Pre-Wedding Shoot', price: '15000', includes: '3 hr shoot + 50 edited photos' },
      { package: 'Wedding (1 day)', price: '40000', includes: 'Photo + video + album' },
      { package: 'Birthday/Event', price: '8000', includes: '2 hr + 30 edited photos' },
      { package: 'Product Shoot', price: '5000', includes: 'Up to 20 products' },
    ],
  },
  {
    key: 'travel', label: '✈️ Travel agency', name: 'Travel Packages', kind: 'service',
    columns: ['package', 'price', 'duration', 'includes'],
    instructions:
      'Holiday and travel packages. Share details and prices, answer questions, and help the customer '
      + 'book — ask for travel dates and number of people.',
    rows: [
      { package: 'Goa 3N/4D', price: '12000', duration: '4 days', includes: 'Hotel + breakfast + sightseeing' },
      { package: 'Manali 4N/5D', price: '15000', duration: '5 days', includes: 'Hotel + cab + meals' },
      { package: 'Kerala 5N/6D', price: '22000', duration: '6 days', includes: 'Houseboat + hotel + transfers' },
      { package: 'Dubai 4N/5D', price: '55000', duration: '5 days', includes: 'Flights + hotel + visa' },
    ],
  },
  {
    key: 'realestate', label: '🏠 Real estate', name: 'Property Listings', kind: 'service',
    columns: ['property', 'location', 'price', 'type'],
    instructions:
      'Property listings for sale/rent. Share details, answer questions, and capture the buyer\'s '
      + 'requirement (budget, location, BHK), then offer to schedule a site visit.',
    rows: [
      { property: '2 BHK Flat', location: 'Whitefield', price: '65 Lakh', type: 'Sale' },
      { property: '3 BHK Villa', location: 'Sarjapur', price: '1.2 Cr', type: 'Sale' },
      { property: '1 BHK Apartment', location: 'HSR Layout', price: '18000/month', type: 'Rent' },
      { property: 'Commercial Office', location: 'MG Road', price: '85000/month', type: 'Rent' },
    ],
  },
  {
    key: 'laundry', label: '🧺 Laundry / dry clean', name: 'Laundry Price List', kind: 'service',
    columns: ['item', 'service', 'price'],
    instructions:
      'Laundry and dry-cleaning rates. Quote per-item prices, and help the customer schedule a pickup — '
      + 'ask for their address and preferred pickup time.',
    rows: [
      { item: 'Shirt', service: 'Wash & Iron', price: '30' },
      { item: 'Trouser', service: 'Wash & Iron', price: '35' },
      { item: 'Suit (2 pc)', service: 'Dry Clean', price: '250' },
      { item: 'Saree', service: 'Dry Clean', price: '150' },
      { item: 'Bedsheet', service: 'Wash & Iron', price: '60' },
    ],
  },
];

const GENERIC_TEMPLATES = [
  {
    key: 'products', label: '🛍️ Products (blank)', name: 'Products',
    columns: ['name', 'price', 'description', 'image'],
    instructions: PRODUCT_INSTRUCTIONS,
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

// The business name without the leading emoji (e.g. "🛒 Grocery store" → "Grocery store").
function bizLabel(t) {
  return t.label.replace(/^[^A-Za-z0-9]+/, '').replace(/\s*\(blank\)$/i, '').trim();
}

// Build a ready-to-use "how to chat" instruction + business description for a
// template, based on whether it sells products or offers services. This is what
// gets written into the Persona settings so the agent knows how to converse.
function chatSetupFor(t) {
  const label = bizLabel(t);
  const businessDescription = `We are a ${label} business. We help customers over WhatsApp.`;
  const common =
    ' Greet new people warmly and by name when you know it. Keep replies short, polite and in the '
    + 'customer\'s language (Hindi/English/Hinglish — match how they write). Answer only from our '
    + 'list/FAQ details; if you are unsure or it needs the owner, say you\'ll check and hand over.';
  let personaCustom = t.kind === 'service'
    ? `You are the assistant for our ${label}. Understand what service the customer needs, explain `
      + 'what it includes, quote the price from our list, and help them book — ask for their preferred '
      + 'date/time (and address if we visit them), then confirm the booking details back to them.'
      + common
    : `You are the assistant for our ${label}. Help customers find products, answer price and `
      + 'availability questions from our list, suggest items, and take orders — ask for quantity and '
      + 'whether they want pickup or delivery, then confirm the order summary and total before finalising.'
      + common;
  // Extra business-specific guidance (e.g. medical safety disclaimers).
  if (t.chatExtra) personaCustom += ' ' + t.chatExtra;
  return { businessDescription, personaCustom };
}

// Write the template's chat instructions into Persona settings. If the user has
// already written their own business description / instructions, ask before
// replacing them so we never silently overwrite their work.
async function applyChatSetup(t) {
  if (!t.kind) return false; // generic/abstract templates carry no chat guide
  let current = {};
  try { ({ settings: current } = await api('/api/settings')); } catch (_) { current = {}; }
  const hasOwn = (current.businessDescription || '').trim() || (current.personaCustom || '').trim();
  if (hasOwn && !confirm('Set up chat instructions for this business? This will replace your current Persona description and custom instructions.')) {
    return false;
  }
  const { businessDescription, personaCustom } = chatSetupFor(t);
  const payload = { businessDescription, personaCustom };
  if (!(current.personaStyle || '').trim()) payload.personaStyle = 'friendly';
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    try { await loadSettings(); } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

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
  // Insert the sample rows (if any) so the list arrives pre-populated.
  if (Array.isArray(t.rows) && t.rows.length) {
    try { await api(`/api/lists/${list.id}/items`, { method: 'POST', body: JSON.stringify({ items: t.rows }) }); } catch (_) {}
  }
  // Auto-configure how the agent should chat for this kind of business.
  const chatSet = await applyChatSetup(t);
  await selectList(list.id);
  // If there were no sample rows, still seed the add-row form with the columns.
  if ((!t.rows || !t.rows.length) && Array.isArray(t.columns) && t.columns.length) {
    currentColumns = t.columns.slice();
    renderRowForm();
  }
  if (chatSet) {
    $('rowResult').textContent = '✅ List created and chat instructions set up (see Persona). Edit anything you like.';
    setTimeout(() => ($('rowResult').textContent = ''), 6000);
  }
}

function templateChip(t) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'template-chip';
  b.textContent = t.label;
  const sample = t.rows && t.rows.length ? ` — includes ${t.rows.length} sample rows` : '';
  const chat = t.kind ? '; also sets up how the agent chats' : '';
  b.title = (t.instructions || t.name) + sample + chat + (t.kind ? '. You can edit everything.' : '');
  b.onclick = () => createFromTemplate(t);
  return b;
}

function renderTemplateChips() {
  const cont = $('templateChips');
  if (!cont) return;
  cont.innerHTML = '';
  // Shops (product catalogues) — mark as product businesses for chat setup.
  BUSINESS_TEMPLATES.forEach((t) => { t.kind = t.kind || 'product'; cont.appendChild(templateChip(t)); });
  // Service businesses.
  SERVICE_TEMPLATES.forEach((t) => cont.appendChild(templateChip(t)));
  const sep = document.createElement('span');
  sep.className = 'template-sep';
  sep.textContent = 'or';
  cont.appendChild(sep);
  GENERIC_TEMPLATES.forEach((t) => cont.appendChild(templateChip(t)));
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
// Photo upload for a list row: file picker → data URL → PUT. Same size/type
// rules as the payment QR.
function pickItemPhoto(itemId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { $('csvResult').textContent = 'Use a PNG, JPG or WebP image.'; return; }
    if (file.size > 1300000) { $('csvResult').textContent = 'Photo too large (max ~1.3MB).'; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api(`/api/lists/${currentListId}/items/${itemId}/photo`, {
          method: 'PUT',
          body: JSON.stringify({ photo: reader.result }),
        });
        $('csvResult').textContent = 'Photo saved.';
        setTimeout(() => ($('csvResult').textContent = ''), 2000);
        loadItems();
      } catch (e) {
        $('csvResult').textContent = e.message;
      }
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function deleteItem(itemId) {
  await api(`/api/lists/${currentListId}/items/${itemId}`, { method: 'DELETE' });
  await loadItems();
  loadLists();
}

// ── Overview / analytics ─────────────────────────────────────────────────────
const INR = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

function ovTile(label, value, sub) {
  return `<div class="ov-tile"><span class="ov-n">${value}</span>
    <span class="ov-l">${label}</span>${sub ? `<span class="ov-s">${sub}</span>` : ''}</div>`;
}

// Grouped column chart (received/sent per day). Pure divs — heights are % of
// the max; every bar has a hover tooltip; values live in the table view below.
function renderDaily(days) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.received, d.sent)));
  const cols = days.map((d) => {
    const dt = new Date(d.day + 'T00:00:00');
    const lbl = `${dt.getDate()}/${dt.getMonth() + 1}`;
    const h = (v) => Math.round((v / max) * 100);
    return `<div class="col" title="${lbl} — received ${d.received}, replied ${d.sent}">
      <div class="bars">
        <i class="bar b-recv" style="height:${h(d.received)}%"></i>
        <i class="bar b-sent" style="height:${h(d.sent)}%"></i>
      </div><span class="xl">${lbl}</span></div>`;
  });
  $('ovDaily').innerHTML = cols.join('');
  $('ovDailyTable').innerHTML = `<table class="data-table"><tr><th>Day</th><th>Received</th><th>Replied</th></tr>${
    days.map((d) => `<tr><td>${d.day}</td><td>${d.received}</td><td>${d.sent}</td></tr>`).join('')}</table>`;
}

function renderHours(byHour) {
  const max = Math.max(1, ...byHour);
  $('ovHours').innerHTML = byHour.map((n, h) => {
    const pct = Math.round((n / max) * 100);
    return `<div class="col" title="${h}:00–${h}:59 — ${n} message${n === 1 ? '' : 's'}">
      <div class="bars"><i class="bar b-sent" style="height:${pct}%"></i></div>
      ${h % 3 === 0 ? `<span class="xl">${h}</span>` : '<span class="xl"></span>'}</div>`;
  }).join('');
  $('ovHoursTable').innerHTML = `<table class="data-table"><tr><th>Hour (IST)</th><th>Messages</th></tr>${
    byHour.map((n, h) => `<tr><td>${h}:00</td><td>${n}</td></tr>`).join('')}</table>`;
}

async function loadOverview() {
  $('ovMsg').textContent = '';
  let d;
  try {
    d = await api(`/api/stats/overview?days=${$('ovDays').value}`);
  } catch (e) {
    $('ovMsg').textContent = e.message;
    return;
  }
  $('ovTiles').innerHTML = [
    ovTile('Messages received', d.messages.received, `${d.messages.chats} chat(s)`),
    ovTile('Replies sent', d.messages.sent),
    ovTile('New leads', d.crm.newLeads, `${d.crm.total} contacts total`),
    ovTile('Customers', d.crm.customers, `${d.crm.conversion}% conversion`),
    ovTile('Orders', d.orders.recent, `${d.orders.open} open`),
    ovTile('Revenue collected', INR(d.orders.revenue), `${INR(d.orders.revenueAll)} all-time`),
  ].join('');
  renderDaily(d.daily || []);
  renderHours(d.hours || []);
}
$('ovDays').onchange = () => loadOverview();

// ── CRM & Leads ──────────────────────────────────────────────────────────────
const CRM_STAGES = [
  { key: 'new', label: 'New leads', emoji: '🆕' },
  { key: 'contacted', label: 'Contacted', emoji: '💬' },
  { key: 'qualified', label: 'Qualified', emoji: '⭐' },
  { key: 'customer', label: 'Customers', emoji: '✅' },
  { key: 'lost', label: 'Lost', emoji: '✖️' },
];
const DEFAULT_CRM_TEMPLATES = {
  new: 'Hi {name}! Thanks for reaching out to {business}. How can we help you today?',
  contacted: 'Hi {name}, following up from {business} — did you have any questions? Happy to help.',
  qualified: 'Hi {name}, would you like to go ahead? I can help you place the order or book a slot.',
  customer: 'Thank you for choosing {business}, {name}! 🙏 We appreciate your business — reach out anytime.',
  lost: "Hi {name}, we'd love to have you back at {business}. Reply and I'll share something special.",
};
const crmState = { filter: '', templates: {} };

function stageLabel(key) {
  const s = CRM_STAGES.find((x) => x.key === key);
  return s ? `${s.emoji} ${s.label}` : key;
}
function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function renderCrmPipeline(stats) {
  const cont = $('crmPipeline');
  cont.innerHTML = '';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'pipe-card' + (crmState.filter === '' ? ' active' : '');
  all.innerHTML = `<span class="pipe-n">${stats.total || 0}</span><span class="pipe-l">All contacts</span>`;
  all.onclick = () => { crmState.filter = ''; loadCrm(); };
  cont.appendChild(all);
  CRM_STAGES.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pipe-card' + (crmState.filter === s.key ? ' active' : '');
    b.innerHTML = `<span class="pipe-n">${stats[s.key] || 0}</span><span class="pipe-l">${s.emoji} ${s.label}</span>`;
    b.onclick = () => { crmState.filter = s.key; loadCrm(); };
    cont.appendChild(b);
  });
}

function renderCrmTable(contacts) {
  const cont = $('crmTable');
  if (!contacts.length) {
    cont.innerHTML = '<p class="muted small">No contacts here yet. Leads appear automatically as people message your WhatsApp.</p>';
    return;
  }
  const opts = (sel) => CRM_STAGES.map((s) => `<option value="${s.key}"${s.key === sel ? ' selected' : ''}>${s.label}</option>`).join('');
  const rows = contacts.map((c) => `
    <tr data-id="${c.id}">
      <td><input class="crm-name" value="${esc(c.name)}" placeholder="Name" /></td>
      <td class="crm-phone">+${esc(c.phone)}</td>
      <td><select class="crm-stage">${opts(c.stage)}</select></td>
      <td><input class="crm-value" value="${esc(c.value)}" placeholder="—" /></td>
      <td class="muted small">${timeAgo(c.lastMessageAt)}</td>
      <td class="crm-actions">
        <button class="ghost small" data-act="save">Save</button>
        <button class="ghost small" data-act="msg">Message</button>
        <button class="faq-del" data-act="del" title="Delete">✕</button>
      </td>
    </tr>`).join('');
  cont.innerHTML = `<table class="data-table crm-data"><tr>
      <th>Name</th><th>Number</th><th>Stage</th><th>Value</th><th>Last seen</th><th></th></tr>${rows}</table>`;
  cont.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('.crm-stage').onchange = (e) => crmPatch(id, { stage: e.target.value }, true);
    tr.querySelector('[data-act="save"]').onclick = () => crmPatch(id, {
      name: tr.querySelector('.crm-name').value,
      value: tr.querySelector('.crm-value').value,
    });
    tr.querySelector('[data-act="msg"]').onclick = () => crmMessage(id);
    tr.querySelector('[data-act="del"]').onclick = () => crmDelete(id);
  });
}

function renderCrmTemplates() {
  const cont = $('crmTemplateRows');
  cont.innerHTML = '';
  CRM_STAGES.forEach((s) => {
    const val = crmState.templates[s.key] ?? DEFAULT_CRM_TEMPLATES[s.key] ?? '';
    const wrap = document.createElement('div');
    wrap.className = 'crm-tpl';
    wrap.innerHTML = `
      <div class="crm-tpl-head"><strong>${s.emoji} ${s.label}</strong>
        <button type="button" class="ghost small" data-bcast="${s.key}">Send to all in “${s.label}”</button></div>
      <textarea data-tpl="${s.key}" rows="2">${esc(val)}</textarea>`;
    wrap.querySelector('[data-bcast]').onclick = () => crmBroadcast(s.key, wrap.querySelector('textarea').value);
    cont.appendChild(wrap);
  });
}

async function loadCrm() {
  // Toggles + templates come from the settings record.
  try {
    const { settings } = await api('/api/settings');
    $('crmEnabled').checked = settings.crmEnabled !== false;
    $('crmAutoConvert').checked = settings.crmAutoConvert !== false;
    crmState.templates = settings.crmTemplates && typeof settings.crmTemplates === 'object' ? settings.crmTemplates : {};
  } catch (_) {}
  renderCrmTemplates();
  const qs = new URLSearchParams();
  if (crmState.filter) qs.set('stage', crmState.filter);
  if (crmState.search) qs.set('q', crmState.search);
  try {
    const { contacts, stats } = await api(`/api/crm/contacts?${qs.toString()}`);
    renderCrmPipeline(stats);
    renderCrmTable(contacts);
  } catch (e) {
    $('crmTable').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function crmPatch(id, patch, reload) {
  try {
    await api(`/api/crm/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    $('crmMsg').textContent = 'Saved.';
    setTimeout(() => ($('crmMsg').textContent = ''), 1500);
    if (reload) loadCrm();
  } catch (e) {
    $('crmMsg').textContent = e.message;
  }
}
async function crmDelete(id) {
  if (!confirm('Delete this contact?')) return;
  try { await api(`/api/crm/contacts/${id}`, { method: 'DELETE' }); loadCrm(); }
  catch (e) { $('crmMsg').textContent = e.message; }
}
async function crmMessage(id) {
  const text = prompt('Message to send (use {name} and {business}):');
  if (!text || !text.trim()) return;
  try {
    await api(`/api/crm/contacts/${id}/message`, { method: 'POST', body: JSON.stringify({ text }) });
    $('crmMsg').textContent = 'Message sent.';
    setTimeout(() => ($('crmMsg').textContent = ''), 2500);
  } catch (e) {
    $('crmMsg').textContent = e.message;
  }
}
async function crmBroadcast(stage, text) {
  if (!text || !text.trim()) { $('crmMsg').textContent = 'Write a message first.'; return; }
  if (!confirm(`Send this message to everyone in “${stageLabel(stage)}”?`)) return;
  $('crmMsg').textContent = 'Sending…';
  try {
    const r = await api('/api/crm/broadcast', { method: 'POST', body: JSON.stringify({ stage, text }) });
    $('crmMsg').textContent = `Sent to ${r.sent} of ${r.total} contact(s).`;
    setTimeout(() => ($('crmMsg').textContent = ''), 4000);
  } catch (e) {
    $('crmMsg').textContent = e.message;
  }
}

function saveCrmToggle() {
  api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ crmEnabled: $('crmEnabled').checked, crmAutoConvert: $('crmAutoConvert').checked }),
  }).catch(() => {});
}
$('crmEnabled').onchange = saveCrmToggle;
$('crmAutoConvert').onchange = saveCrmToggle;
$('crmRefresh').onclick = () => loadCrm();
$('crmSearch').oninput = (e) => {
  crmState.search = e.target.value;
  clearTimeout($('crmSearch')._t);
  $('crmSearch')._t = setTimeout(loadCrm, 350);
};
$('crmSaveTemplates').onclick = async () => {
  const templates = {};
  document.querySelectorAll('#crmTemplateRows [data-tpl]').forEach((t) => { templates[t.dataset.tpl] = t.value; });
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ crmTemplates: templates }) });
    crmState.templates = templates;
    $('crmTemplateMsg').textContent = 'Saved.';
    setTimeout(() => ($('crmTemplateMsg').textContent = ''), 2000);
  } catch (e) {
    $('crmTemplateMsg').textContent = e.message;
  }
};

// ── Orders ───────────────────────────────────────────────────────────────────
const ORDER_STATUS_COLORS = {
  new: '', confirmed: 'st-blue', paid: 'st-gold', ready: 'st-blue', delivered: 'st-green', cancelled: 'st-red',
};

async function loadOrders() {
  let data;
  try { data = await api('/api/orders'); }
  catch (e) { $('ordersTable').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const { orders, statuses } = data;
  if (!orders.length) {
    $('ordersTable').innerHTML = '<p class="muted small">No orders yet — they appear here when the agent takes one.</p>';
    return;
  }
  const opts = (sel) => statuses.map((s) => `<option value="${s}"${s === sel ? ' selected' : ''}>${s}</option>`).join('');
  const rows = orders.map((o) => {
    const f = o.fields;
    const st = String(f.status || 'new');
    return `<tr data-id="${o.id}">
      <td class="crm-phone">${esc(f.customer || '—')}</td>
      <td class="ord-items" title="${esc(f.items || '')}">${esc(f.items || '')}</td>
      <td>${esc(f.total || '—')}</td>
      <td><select class="ord-status ${ORDER_STATUS_COLORS[st] || ''}">${opts(st)}</select></td>
      <td class="muted small">${o.createdAt ? timeAgo(o.createdAt) : (f.created_at || '')}</td>
    </tr>`;
  }).join('');
  $('ordersTable').innerHTML = `<table class="data-table"><tr>
    <th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Placed</th></tr>${rows}</table>`;
  $('ordersTable').querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.querySelector('.ord-status').onchange = async (e) => {
      const status = e.target.value;
      try {
        const r = await api(`/api/orders/${tr.dataset.id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status, notify: $('ordNotify').checked }),
        });
        $('ordersMsg').textContent = r.notified ? `Updated — client notified (${status}).` : `Updated to ${status}.`;
        setTimeout(() => ($('ordersMsg').textContent = ''), 3000);
        loadOrders();
      } catch (err) {
        $('ordersMsg').textContent = err.message;
      }
    };
  });
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
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    $('qrMsg').textContent = 'Please choose a PNG, JPG or WebP image.';
    $('qrFile').value = '';
    return;
  }
  // base64 inflates ~33%; keep the raw file well under the server's limit so it
  // is never silently rejected.
  if (file.size > 1300000) {
    $('qrMsg').textContent = 'Image too large (max ~1.3MB). Try a smaller screenshot.';
    $('qrFile').value = '';
    return;
  }
  $('qrMsg').textContent = 'Uploading…';
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
  reader.onerror = () => { $('qrMsg').textContent = 'Could not read that file.'; };
  reader.readAsDataURL(file);
  $('qrFile').value = '';
};
$('qrRemoveBtn').onclick = async () => {
  if (!confirm('Remove the payment QR?')) return;
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ paymentQr: '' }) });
  loadPaymentQr();
};

// ── Inbox ────────────────────────────────────────────────────────────────────
const inboxState = { chatId: null, timer: null };

function chatDisplayName(c) {
  if (c.name) return c.name;
  const m = String(c.chatId).match(/^(\d{7,15})@/);
  return m ? `+${m[1]}` : c.chatId;
}

function renderChatList(chats) {
  const cont = $('chatList');
  if (!chats.length) {
    cont.innerHTML = '<p class="muted small">No conversations yet — they appear as soon as someone messages your WhatsApp.</p>';
    return;
  }
  cont.innerHTML = chats.map((c) => {
    const who = String(c.lastRole) === 'user' ? '' : (c.lastSource === 'owner' ? 'You: ' : 'Agent: ');
    return `<button type="button" class="chat-item${c.chatId === inboxState.chatId ? ' active' : ''}" data-chat="${esc(c.chatId)}" data-name="${esc(chatDisplayName(c))}">
      <span class="chat-name">${esc(chatDisplayName(c))}${c.stage ? ` <i class="chat-stage">${esc(c.stage)}</i>` : ''}</span>
      <span class="chat-prev">${esc(who + c.lastContent)}</span>
      <span class="chat-time">${timeAgo(c.lastAt)}</span>
    </button>`;
  }).join('');
  cont.querySelectorAll('[data-chat]').forEach((b) => {
    b.onclick = () => openThread(b.dataset.chat, b.dataset.name);
  });
}

async function loadInbox() {
  try {
    const { chats } = await api('/api/inbox/chats');
    renderChatList(chats);
  } catch (e) {
    $('inboxMsg').textContent = e.message;
  }
}

function renderThread(messages) {
  const cont = $('threadMsgs');
  const nearBottom = cont.scrollHeight - cont.scrollTop - cont.clientHeight < 60;
  cont.innerHTML = messages.map((m) => {
    const mine = m.role === 'assistant';
    const tag = mine ? (m.source === 'owner' ? 'You' : 'Agent') : '';
    return `<div class="msg ${mine ? 'msg-out' : 'msg-in'}">
      ${tag ? `<span class="msg-tag">${tag}</span>` : ''}
      <span class="msg-body">${esc(m.content)}</span>
      <span class="msg-time">${m.at ? new Date(m.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
    </div>`;
  }).join('');
  if (nearBottom || !cont.dataset.scrolled) cont.scrollTop = cont.scrollHeight;
  cont.dataset.scrolled = '1';
}

function renderPauseState(pausedUntil) {
  const paused = pausedUntil && pausedUntil > Date.now();
  $('pauseState').classList.toggle('hidden', !paused);
  if (paused) {
    const mins = Math.round((pausedUntil - Date.now()) / 60000);
    $('pauseState').textContent = `⏸ Agent paused (${mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h'} left)`;
  }
  $('pauseSelect').value = '';
}

async function refreshThread() {
  if (!inboxState.chatId) return;
  try {
    const { messages, pausedUntil } = await api(`/api/inbox/thread?chatId=${encodeURIComponent(inboxState.chatId)}`);
    renderThread(messages);
    renderPauseState(pausedUntil);
  } catch (_) {}
}

$('pauseSelect').onchange = async () => {
  const v = $('pauseSelect').value;
  if (v === '' || !inboxState.chatId) return;
  try {
    const { pausedUntil } = await api('/api/inbox/pause', {
      method: 'POST',
      body: JSON.stringify({ chatId: inboxState.chatId, minutes: parseInt(v, 10) }),
    });
    renderPauseState(pausedUntil);
  } catch (e) {
    $('inboxMsg').textContent = e.message;
  }
};

function openThread(chatId, name) {
  inboxState.chatId = chatId;
  $('threadName').textContent = name;
  $('threadSub').textContent = chatId.replace(/@.*$/, '');
  $('threadPane').classList.remove('hidden');
  document.querySelector('.inbox').classList.add('thread-open');
  delete $('threadMsgs').dataset.scrolled;
  refreshThread();
  loadInbox(); // re-highlight
  clearInterval(inboxState.timer);
  inboxState.timer = setInterval(refreshThread, 4000);
}

function closeThread() {
  inboxState.chatId = null;
  clearInterval(inboxState.timer);
  inboxState.timer = null;
  $('threadPane')?.classList.add('hidden');
  document.querySelector('.inbox')?.classList.remove('thread-open');
}
$('threadBack').onclick = () => { closeThread(); loadInbox(); };

$('threadForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('threadInput').value.trim();
  if (!text || !inboxState.chatId) return;
  $('threadInput').value = '';
  try {
    await api('/api/inbox/send', { method: 'POST', body: JSON.stringify({ chatId: inboxState.chatId, text }) });
    await refreshThread();
  } catch (err) {
    $('inboxMsg').textContent = err.message;
    setTimeout(() => ($('inboxMsg').textContent = ''), 4000);
  }
};

// ── Billing (Razorpay) ───────────────────────────────────────────────────────
function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the payment window.'));
    document.head.appendChild(s);
  });
}

function billStatusHtml(st) {
  const until = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (!st.enabled) return '<p class="ok">✅ Free plan — billing is not enabled on this server.</p>';
  if (st.plan === 'trial') return `<p>🎁 <strong>Free trial</strong> — ${st.daysLeft} day(s) left (ends ${until(st.trialEndsAt)}). Subscribe to keep the agent running after that.</p>`;
  if (st.active) return `<p class="ok">✅ <strong>${st.plan === 'yearly' ? 'Yearly' : 'Monthly'} plan active</strong> — renews/expires ${until(st.paidUntil)} (${st.daysLeft} day(s) left).</p>`;
  return '<p class="error">⚠️ <strong>Subscription expired.</strong> The agent has stopped auto-replying — subscribe below to switch it back on.</p>';
}

async function loadBilling() {
  $('billMsg').textContent = '';
  let st;
  try { st = await api('/api/billing/status'); }
  catch (e) { $('billStatus').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  $('billStatus').innerHTML = billStatusHtml(st);
  $('billPlans').classList.toggle('hidden', !st.enabled);
  if (st.enabled) {
    $('billPriceMonthly').textContent = INR(st.prices.monthly / 100) + ' / month';
    $('billPriceYearly').textContent = INR(st.prices.yearly / 100) + ' / year';
  }
}

async function subscribe(plan) {
  $('billMsg').textContent = 'Opening payment…';
  try {
    await loadRazorpayScript();
    const order = await api('/api/billing/order', { method: 'POST', body: JSON.stringify({ plan }) });
    const rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: 'FastLegal',
      description: plan === 'yearly' ? 'Yearly subscription' : 'Monthly subscription',
      theme: { color: '#ffd23f' },
      handler: async (resp) => {
        try {
          await api('/api/billing/verify', {
            method: 'POST',
            body: JSON.stringify({
              plan,
              orderId: resp.razorpay_order_id,
              paymentId: resp.razorpay_payment_id,
              signature: resp.razorpay_signature,
            }),
          });
          $('billMsg').textContent = '✅ Payment successful — plan activated!';
          loadBilling();
        } catch (e) {
          $('billMsg').textContent = e.message;
        }
      },
    });
    rzp.on('payment.failed', () => { $('billMsg').textContent = 'Payment failed or was cancelled.'; });
    rzp.open();
    $('billMsg').textContent = '';
  } catch (e) {
    $('billMsg').textContent = e.message;
  }
}
document.querySelectorAll('#billPlans [data-plan]').forEach((b) => {
  b.onclick = () => subscribe(b.dataset.plan);
});

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
