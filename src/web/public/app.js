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
