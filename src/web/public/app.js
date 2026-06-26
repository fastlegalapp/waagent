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
function showPanel(name) {
  document.querySelectorAll('.side-nav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.nav === name),
  );
  const onConnect = name === 'connect';
  document.querySelector('[data-panel="connect"]').classList.toggle('hidden', !onConnect);
  $('settingsForm').classList.toggle('hidden', onConnect);
  document.querySelectorAll('#settingsForm [data-panel]').forEach((p) =>
    p.classList.toggle('hidden', p.dataset.panel !== name),
  );
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
