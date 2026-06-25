'use strict';

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = {};
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// ── Auth view ────────────────────────────────────────────────────────────────
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  $('tabLogin').classList.toggle('active', mode === 'login');
  $('tabSignup').classList.toggle('active', mode === 'signup');
  $('authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('authHint').textContent =
    mode === 'login' ? 'Welcome back.' : 'Use at least 8 characters.';
  $('password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('authError').textContent = '';
}

$('tabLogin').onclick = () => setAuthMode('login');
$('tabSignup').onclick = () => setAuthMode('signup');

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  const email = $('email').value.trim();
  const password = $('password').value;
  try {
    await api(`/api/auth/${authMode === 'login' ? 'login' : 'signup'}`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    await boot();
  } catch (err) {
    $('authError').textContent = err.message;
  }
};

$('logoutBtn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  stopPolling();
  showAuth();
};

function showAuth() {
  $('appView').classList.add('hidden');
  $('userbar').classList.add('hidden');
  $('authView').classList.remove('hidden');
  setAuthMode('login');
}

function showApp(user) {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userbar').classList.remove('hidden');
  $('userEmail').textContent = user.email;
}

// ── Settings ─────────────────────────────────────────────────────────────────
function applyProviderVisibility() {
  const p = $('provider').value;
  $('anthropicBox').classList.toggle('hidden', p !== 'anthropic');
  $('deepseekBox').classList.toggle('hidden', p !== 'deepseek');
}

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
  $('replyMode').value = s.replyMode || 'off';
  $('ignoreGroups').checked = s.ignoreGroups !== false;
  $('allowlist').value = s.allowlist || '';
  $('blocklist').value = s.blocklist || '';
  $('minIntervalSeconds').value = s.minIntervalSeconds ?? 2;
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
    provider: $('provider').value,
    model: $('model').value,
    deepseekModel: $('deepseekModel').value,
    replyMode: $('replyMode').value,
    ignoreGroups: $('ignoreGroups').checked,
    allowlist: $('allowlist').value,
    blocklist: $('blocklist').value,
    minIntervalSeconds: intOrNull($('minIntervalSeconds').value) ?? 2,
    businessHoursStart: intOrNull($('businessHoursStart').value),
    businessHoursEnd: intOrNull($('businessHoursEnd').value),
  };
  // Only send a key if the user typed one (per provider).
  const key = $('apiKey').value.trim();
  if (key) payload.apiKey = key;
  const dsKey = $('deepseekApiKey').value.trim();
  if (dsKey) payload.deepseekApiKey = dsKey;

  try {
    const { settings } = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    fillSettings(settings);
    $('settingsOk').textContent = 'Saved.';
    setTimeout(() => ($('settingsOk').textContent = ''), 2500);
  } catch (err) {
    $('settingsError').textContent = err.message;
  }
};

$('provider').onchange = applyProviderVisibility;

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
  rate_limited: ['bad', 'Skipped: too soon after the previous reply (min interval)'],
  after_hours: ['good', 'Outside business hours — sent the holding message'],
  group_ignored: ['bad', 'Group chat — ignored (by setting)'],
  no_text: ['bad', 'Last message had no text (sticker/media without caption)'],
  ignored: ['bad', 'Agent chose not to reply (spam / not worth it)'],
  escalated: ['good', 'Escalated to you'],
  empty_reply: ['bad', 'Agent produced an empty reply'],
  settings_load_failed: ['bad', 'Could not load your settings (database issue?)'],
  handler_error: ['bad', 'Internal error handling the message (check logs)'],
};

function row(label, cls, value) {
  return `<div class="row-item"><span>${label}</span><span class="${cls}">${value}</span></div>`;
}

function renderDiag(d) {
  const wa = d.wa || {};
  const a = d.activity || {};
  const s = d.settings || {};
  const k = d.keyTest || {};
  const waOk = wa.status === 'open';
  const modeOk = s.replyMode === 'auto';
  const [rcls, rtxt] = RESULT_TEXT[a.lastResult] || ['', a.lastResult || 'no messages processed yet'];
  const html = [
    row('WhatsApp connection', waOk ? 'good' : 'bad', waOk ? 'connected' : wa.status || 'idle'),
    row('Reply mode', modeOk ? 'good' : 'bad', s.replyMode || '—'),
    row(
      'API key',
      k.ok ? 'good' : 'bad',
      k.ok ? `working (${k.provider}/${k.model})` : `❌ ${k.error || 'not working'}`,
    ),
    row('Last message received', a.lastIncomingAt ? 'good' : 'bad', ago(a.lastIncomingAt)),
    row('Last reply sent', 'muted', ago(a.lastSentAt)),
    row('Last outcome', rcls, rtxt),
  ].join('');
  $('diag').innerHTML = html;
  $('diag').classList.remove('hidden');
}

$('diagBtn').onclick = async () => {
  $('diag').classList.remove('hidden');
  $('diag').textContent = 'Running…';
  try {
    renderDiag(await api('/api/wa/diagnostics'));
  } catch (e) {
    $('diag').textContent = `Error: ${e.message}`;
  }
};

$('testKeyBtn').onclick = async () => {
  const out = $('testKeyResult');
  out.textContent = 'Testing…';
  try {
    const r = await api('/api/settings/test', { method: 'POST' });
    out.textContent = r.ok
      ? `✅ Working (${r.provider} / ${r.model})`
      : `❌ ${r.error || 'Failed'}`;
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  }
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
  try {
    const st = await api('/api/wa/status');
    renderWaState(st);
  } catch (_) {
    /* ignore transient errors */
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshWa, 2000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

$('waStartBtn').onclick = async () => {
  renderWaState(await api('/api/wa/start', { method: 'POST' }));
  startPolling();
};
$('waStopBtn').onclick = async () => {
  renderWaState(await api('/api/wa/stop', { method: 'POST' }));
};
$('waLogoutBtn').onclick = async () => {
  if (!confirm('Unlink WhatsApp? You will need to scan the QR again to reconnect.')) return;
  renderWaState(await api('/api/wa/logout', { method: 'POST' }));
};

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const { user } = await api('/api/auth/me');
    showApp(user);
    await loadSettings();
    await refreshWa();
    startPolling();
  } catch (_) {
    showAuth();
  }
}

boot();
