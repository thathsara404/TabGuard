/**
 * TabGuard – Settings Page Logic
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let allDomains = [];
let allSessions = {};
let allAwayPeriods = {};
let editingDomain = null;
let sessionRefreshInterval = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  renderAll();
  bindEvents();

  // Live refresh every 2s
  sessionRefreshInterval = setInterval(async () => {
    await loadData();
    renderStats();
    renderSessionList();
    updateDomainProgressBars();
  }, 2000);
});

// ─── Data Loading ─────────────────────────────────────────────────────────────
async function loadData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['domains', 'sessions', 'awayPeriods'], (result) => {
      allDomains = result.domains || [];
      allSessions = result.sessions || {};
      allAwayPeriods = result.awayPeriods || {};
      resolve();
    });
  });
}

async function saveData() {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { domains: allDomains, sessions: allSessions, awayPeriods: allAwayPeriods },
      resolve
    );
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderAll() {
  renderStats();
  renderDomainList();
  renderSessionList();
}

function renderStats() {
  document.getElementById('statDomains').textContent = allDomains.length;
  document.getElementById('statActive').textContent = allDomains.filter((d) => d.enabled).length;
  const now = Date.now();
  document.getElementById('statBlocked').textContent = Object.values(allAwayPeriods).filter((t) => t > now).length;
}

function renderDomainList() {
  const list = document.getElementById('domainList');
  const empty = document.getElementById('emptyState');

  // Remove existing items (keep emptyState)
  Array.from(list.children).forEach((c) => { if (c !== empty) c.remove(); });

  if (allDomains.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  allDomains.forEach((rule) => {
    const item = buildDomainItem(rule);
    list.appendChild(item);
  });
}

function buildDomainItem(rule) {
  const now = Date.now();
  const awayEnd = allAwayPeriods[rule.domain];
  const isAway = awayEnd && awayEnd > now;
  const sessionMs = allSessions[rule.domain] || 0;
  const limitMs = rule.limitMinutes * 60 * 1000;
  const pct = limitMs > 0 ? Math.min(100, (sessionMs / limitMs) * 100) : 0;

  // Away period progress: percentage of time elapsed through the away period
  const totalAwayMs = (rule.awayMinutes || 0) * 60 * 1000;
  const awayRemainMs = isAway ? Math.max(0, awayEnd - now) : 0;
  const awayElapsedMs = isAway && totalAwayMs > 0 ? Math.max(0, totalAwayMs - awayRemainMs) : 0;
  const awayPct = isAway && totalAwayMs > 0 ? Math.min(100, (awayElapsedMs / totalAwayMs) * 100) : 0;

  const div = document.createElement('div');
  div.className = `domain-item${!rule.enabled ? ' disabled' : ''}${isAway ? ' away-period' : ''}`;
  div.dataset.domain = rule.domain;

  const sessionColor = pct >= 90
    ? 'linear-gradient(90deg,#ef4444,#f87171)'
    : pct >= 70 ? 'linear-gradient(90deg,#f59e0b,#fbbf24)' : '';

  div.innerHTML = `
    <div class="domain-toggle">
      <label class="toggle" title="${rule.enabled ? 'Disable' : 'Enable'} tracking">
        <input type="checkbox" class="toggle-input" ${rule.enabled ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="domain-info">
      <div class="domain-name">🌐 ${escapeHtml(rule.domain)}</div>
      <div class="domain-meta">
        <span class="domain-badge">⏰ ${rule.limitMinutes}m limit</span>
        ${rule.awayMinutes > 0 ? `<span class="domain-badge away">🚫 ${rule.awayMinutes}m away</span>` : ''}
      </div>
    </div>
    <div class="domain-progress-wrap">
      <!-- Session progress -->
      <div class="progress-row">
        <span class="progress-row-label">Session</span>
        <span class="progress-row-value" data-role="session-val">${formatMs(sessionMs)} / ${rule.limitMinutes}m</span>
      </div>
      <div class="progress-bar" title="${Math.round(pct)}% of limit used">
        <div class="progress-fill" data-role="session-fill" style="width:${pct}%;${sessionColor ? 'background:' + sessionColor : ''}"></div>
      </div>
      <!-- Away period progress (only when rule has away minutes configured) -->
      ${rule.awayMinutes > 0 ? `
      <div class="progress-row" style="margin-top:6px">
        <span class="progress-row-label away-label">Away</span>
        <span class="progress-row-value away-val" data-role="away-val">${isAway ? formatMs(awayRemainMs) + ' left' : 'Inactive'}</span>
      </div>
      <div class="progress-bar" title="${isAway ? Math.round(awayPct) + '% of away period elapsed' : 'No active away period'}">
        <div class="progress-fill away-fill" data-role="away-fill" style="width:${awayPct}%"></div>
      </div>
      ` : ''}
    </div>
    <div class="domain-actions">
      ${isAway ? `<button class="icon-btn" data-action="clearaway" title="Clear away period">🔓</button>` : ''}
      <button class="icon-btn" data-action="reset" title="Reset session time">🔄</button>
      <button class="icon-btn" data-action="edit" title="Edit rule">✏️</button>
      <button class="icon-btn danger" data-action="delete" title="Delete rule">🗑</button>
    </div>
  `;

  // Toggle
  div.querySelector('.toggle-input').addEventListener('change', (e) => {
    const d = allDomains.find((x) => x.domain === rule.domain);
    if (d) {
      d.enabled = e.target.checked;
      saveData().then(() => notifyBackground());
      div.classList.toggle('disabled', !d.enabled);
    }
  });

  // Actions
  div.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'delete') deleteDomain(rule.domain);
      if (action === 'edit') openEditModal(rule.domain);
      if (action === 'reset') resetSession(rule.domain);
      if (action === 'clearaway') clearAway(rule.domain);
    });
  });

  return div;
}

function updateDomainProgressBars() {
  const now = Date.now();
  allDomains.forEach((rule) => {
    const item = document.querySelector(`[data-domain="${rule.domain}"]`);
    if (!item) return;

    // ── Session bar ──
    const sessionMs = allSessions[rule.domain] || 0;
    const limitMs = rule.limitMinutes * 60 * 1000;
    const pct = limitMs > 0 ? Math.min(100, (sessionMs / limitMs) * 100) : 0;

    const sessionFill = item.querySelector('[data-role="session-fill"]');
    if (sessionFill) {
      sessionFill.style.width = `${pct}%`;
      if (pct >= 90) sessionFill.style.background = 'linear-gradient(90deg,#ef4444,#f87171)';
      else if (pct >= 70) sessionFill.style.background = 'linear-gradient(90deg,#f59e0b,#fbbf24)';
      else sessionFill.style.background = '';
    }
    const sessionVal = item.querySelector('[data-role="session-val"]');
    if (sessionVal) sessionVal.textContent = `${formatMs(sessionMs)} / ${rule.limitMinutes}m`;

    // ── Away bar ──
    const awayEnd = allAwayPeriods[rule.domain];
    const isAway = awayEnd && awayEnd > now;
    const totalAwayMs = (rule.awayMinutes || 0) * 60 * 1000;
    const awayRemainMs = isAway ? Math.max(0, awayEnd - now) : 0;
    const awayElapsedMs = isAway && totalAwayMs > 0 ? Math.max(0, totalAwayMs - awayRemainMs) : 0;
    const awayPct = isAway && totalAwayMs > 0 ? Math.min(100, (awayElapsedMs / totalAwayMs) * 100) : 0;

    const awayFill = item.querySelector('[data-role="away-fill"]');
    if (awayFill) awayFill.style.width = `${awayPct}%`;

    const awayVal = item.querySelector('[data-role="away-val"]');
    if (awayVal) awayVal.textContent = isAway ? `${formatMs(awayRemainMs)} left` : 'Inactive';
  });
}

function renderSessionList() {
  const list = document.getElementById('sessionList');
  list.innerHTML = '';

  const now = Date.now();
  const hasSomething = allDomains.some(
    (d) => (allSessions[d.domain] || 0) > 0 || (allAwayPeriods[d.domain] && allAwayPeriods[d.domain] > now)
  );

  if (!hasSomething) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📈</span>
        <p>No active sessions tracked yet.</p>
      </div>`;
    return;
  }

  allDomains.forEach((rule) => {
    const sessionMs = allSessions[rule.domain] || 0;
    const awayEnd = allAwayPeriods[rule.domain];
    const isAway = awayEnd && awayEnd > now;

    if (sessionMs === 0 && !isAway) return;

    const item = document.createElement('div');
    item.className = 'session-item';
    const awayRemain = isAway ? Math.ceil((awayEnd - now) / 60000) : 0;

    item.innerHTML = `
      <div class="session-domain">🌐 ${escapeHtml(rule.domain)}</div>
      <div class="session-time">⏱ ${formatMs(sessionMs)} / ${rule.limitMinutes}m</div>
      ${isAway ? `<div class="session-away">🚫 Away: ${awayRemain}m</div>` : ''}
      <div class="session-actions">
        ${isAway ? `<button class="icon-btn" data-action="clearaway" data-domain="${rule.domain}" title="Clear away period">🔓</button>` : ''}
        <button class="icon-btn" data-action="reset" data-domain="${rule.domain}" title="Reset session">🔄</button>
      </div>
    `;

    item.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'reset') resetSession(btn.dataset.domain);
        if (btn.dataset.action === 'clearaway') clearAway(btn.dataset.domain);
      });
    });

    list.appendChild(item);
  });
}

// ─── Add Domain ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('addDomainBtn').addEventListener('click', addDomain);
  document.getElementById('domainInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addDomain();
  });
});

async function addDomain() {
  const domain = normalizeDomain(document.getElementById('domainInput').value.trim());
  const limit = parseInt(document.getElementById('limitInput').value, 10);
  const away = parseInt(document.getElementById('awayInput').value, 10) || 0;
  const message = document.getElementById('messageInput').value.trim() ||
    'Your time limit for this site has been reached. Time to take a break!';

  const err = document.getElementById('formError');

  if (!domain) { showError(err, '⚠️ Please enter a valid domain.'); return; }
  if (!limit || limit < 1) { showError(err, '⚠️ Please enter a valid time limit (minimum 1 minute).'); return; }
  if (allDomains.find((d) => d.domain === domain)) { showError(err, `⚠️ "${domain}" already has a rule.`); return; }

  err.classList.add('hidden');

  allDomains.push({ domain, limitMinutes: limit, awayMinutes: away, message, enabled: true, createdAt: Date.now() });
  await saveData();
  await notifyBackground();

  // Clear form
  document.getElementById('domainInput').value = '';
  document.getElementById('limitInput').value = '';
  document.getElementById('awayInput').value = '';
  document.getElementById('messageInput').value = '';

  renderAll();
  showToast(`✅ Rule added for ${domain}`);
}

// ─── Delete ───────────────────────────────────────────────────────────────────
async function deleteDomain(domain) {
  if (!confirm(`Remove rule for "${domain}"?`)) return;
  allDomains = allDomains.filter((d) => d.domain !== domain);
  delete allSessions[domain];
  delete allAwayPeriods[domain];
  await saveData();
  await notifyBackground();
  renderAll();
  showToast(`🗑 Rule removed for ${domain}`);
}

// ─── Reset Session ────────────────────────────────────────────────────────────
async function resetSession(domain) {
  allSessions[domain] = 0;
  await saveData();
  renderAll();
  showToast(`🔄 Session reset for ${domain}`);
}

// ─── Clear Away Period ────────────────────────────────────────────────────────
async function clearAway(domain) {
  delete allAwayPeriods[domain];
  await saveData();
  renderAll();
  showToast(`🔓 Away period cleared for ${domain}`);
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────
function openEditModal(domain) {
  const rule = allDomains.find((d) => d.domain === domain);
  if (!rule) return;
  editingDomain = domain;
  document.getElementById('editDomain').value = rule.domain;
  document.getElementById('editLimit').value = rule.limitMinutes;
  document.getElementById('editAway').value = rule.awayMinutes || 0;
  document.getElementById('editMessage').value = rule.message || '';
  document.getElementById('editModal').classList.remove('hidden');
}

function closeEditModal() {
  editingDomain = null;
  document.getElementById('editModal').classList.add('hidden');
}

async function saveEdit() {
  const rule = allDomains.find((d) => d.domain === editingDomain);
  if (!rule) return;

  const limit = parseInt(document.getElementById('editLimit').value, 10);
  const away = parseInt(document.getElementById('editAway').value, 10) || 0;
  const message = document.getElementById('editMessage').value.trim();

  if (!limit || limit < 1) { showToast('⚠️ Invalid time limit'); return; }

  rule.limitMinutes = limit;
  rule.awayMinutes = away;
  rule.message = message;

  await saveData();
  await notifyBackground();
  closeEditModal();
  renderAll();
  showToast(`✅ Rule updated for ${editingDomain}`);
}

// ─── Clear All ────────────────────────────────────────────────────────────────
async function clearAll() {
  if (!confirm('Remove ALL domain rules? This cannot be undone.')) return;
  allDomains = [];
  allSessions = {};
  allAwayPeriods = {};
  await saveData();
  await notifyBackground();
  renderAll();
  showToast('🗑 All rules cleared');
}

// ─── Import / Export ─────────────────────────────────────────────────────────
function exportSettings() {
  const data = JSON.stringify({ domains: allDomains, sessions: allSessions, awayPeriods: allAwayPeriods }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tabguard-settings.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importSettings() {
  document.getElementById('importFile').click();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data.domains)) throw new Error('Invalid format');
      allDomains = data.domains;
      allSessions = data.sessions || {};
      allAwayPeriods = data.awayPeriods || {};
      await saveData();
      renderAll();
      showToast('📥 Settings imported successfully');
    } catch {
      showToast('❌ Invalid settings file');
    }
    e.target.value = '';
  });
});

// ─── Bind Events ─────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('clearAllBtn').addEventListener('click', clearAll);
  document.getElementById('exportBtn').addEventListener('click', exportSettings);
  document.getElementById('importBtn').addEventListener('click', importSettings);
  document.getElementById('modalClose').addEventListener('click', closeEditModal);
  document.getElementById('modalCancel').addEventListener('click', closeEditModal);
  document.getElementById('modalSave').addEventListener('click', saveEdit);
  document.getElementById('editModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('editModal')) closeEditModal();
  });
}

// ─── Notify Background ────────────────────────────────────────────────────────
function notifyBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' }, () => {
      chrome.runtime.lastError; // suppress
      resolve();
    });
  });
}

// ─── Look Away Reminder Settings ─────────────────────────────────────────────

async function loadLookAwaySettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['lookAway'], (r) => {
      resolve(r.lookAway || { enabled: false, intervalMinutes: 20, durationSeconds: 20 });
    });
  });
}

async function saveLookAwaySettings() {
  const enabled  = document.getElementById('lookAwayEnabled').checked;
  const interval = parseInt(document.getElementById('lookAwayInterval').value, 10) || 20;
  const duration = parseInt(document.getElementById('lookAwayDuration').value, 10) || 20;

  if (interval < 5)  { showToast('⚠️ Minimum interval is 5 minutes');  return; }
  if (duration < 10) { showToast('⚠️ Minimum duration is 10 seconds'); return; }

  const cfg = { enabled, intervalMinutes: interval, durationSeconds: duration };
  await new Promise((resolve) => chrome.storage.local.set({ lookAway: cfg }, resolve));

  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'LOOKAWAY_UPDATED' }, () => {
      chrome.runtime.lastError;
      resolve();
    });
  });

  updateLaStatus(cfg);
  showToast(enabled ? `✅ Look-away reminder set every ${interval}m` : '⏸ Look-away reminder disabled');
}

function updateLaStatus(cfg) {
  const el = document.getElementById('laStatus');
  if (!el) return;
  if (cfg.enabled) {
    el.textContent = `🟢 Active — every ${cfg.intervalMinutes}m for ${cfg.durationSeconds}s`;
    el.style.color = 'var(--success)';
  } else {
    el.textContent = '⚫ Disabled';
    el.style.color = 'var(--text-dim)';
  }
}

function applyLookAwayToggleUi(enabled) {
  const body = document.getElementById('lookAwayBody');
  if (body) body.style.opacity = enabled ? '1' : '0.5';
}

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await loadLookAwaySettings();
  document.getElementById('lookAwayEnabled').checked = cfg.enabled;
  document.getElementById('lookAwayInterval').value  = cfg.intervalMinutes;
  document.getElementById('lookAwayDuration').value  = cfg.durationSeconds;
  updateLaStatus(cfg);
  applyLookAwayToggleUi(cfg.enabled);

  document.getElementById('lookAwayEnabled').addEventListener('change', (e) => {
    applyLookAwayToggleUi(e.target.checked);
  });

  document.getElementById('saveLookAway').addEventListener('click', saveLookAwaySettings);

  document.getElementById('previewLookAway').addEventListener('click', () => {
    const dur = parseInt(document.getElementById('lookAwayDuration').value, 10) || 20;
    chrome.runtime.sendMessage({ type: 'PREVIEW_LOOKAWAY', durationSeconds: dur }, () => {
      chrome.runtime.lastError;
    });
    showToast('👁 Previewing reminder on current tab…');
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeDomain(input) {
  try {
    if (!input.includes('://')) input = 'https://' + input;
    const u = new URL(input);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return input.replace(/^www\./, '').toLowerCase();
  }
}

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}
