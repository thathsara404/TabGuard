/**
 * TabGuard – Popup Logic
 */
'use strict';

const CIRCUMFERENCE = 2 * Math.PI * 52; // 326.7

let currentDomain = null;
let refreshInterval = null;

async function getStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['domains', 'sessions', 'awayPeriods'], (r) => {
      resolve({
        domains: r.domains || [],
        sessions: r.sessions || {},
        awayPeriods: r.awayPeriods || {},
      });
    });
  });
}

async function init() {
  // Get current tab domain
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      currentDomain = url.hostname.replace(/^www\./, '').toLowerCase();
    } catch { currentDomain = null; }
  }

  await refresh();
  refreshInterval = setInterval(refresh, 1500);
}

async function refresh() {
  const { domains, sessions, awayPeriods } = await getStorage();
  const now = Date.now();

  // Domain display
  const domainEl = document.getElementById('tabDomain');
  domainEl.textContent = currentDomain || '—';

  if (!currentDomain) {
    setNoRule('No domain detected');
    renderPreview(domains, sessions, awayPeriods);
    return;
  }

  const rule = domains.find((d) => {
    const r = d.domain.toLowerCase();
    return currentDomain === r || currentDomain.endsWith('.' + r);
  });

  // Check away period
  const awayEnd = awayPeriods[currentDomain] || (rule ? awayPeriods[rule.domain] : null);
  const isAway = awayEnd && awayEnd > now;

  const awayAlert = document.getElementById('awayAlert');
  if (isAway) {
    awayAlert.classList.remove('hidden');
    const mins = Math.ceil((awayEnd - now) / 60000);
    const secs = Math.ceil((awayEnd - now) / 1000);
    document.getElementById('awayTime').textContent =
      secs < 120 ? `Blocked for ${secs}s` : `Blocked for ~${mins}m`;
  } else {
    awayAlert.classList.add('hidden');
  }

  if (!rule) {
    document.getElementById('timerSection').style.opacity = '0.3';
    document.getElementById('noRule').classList.remove('hidden');
    document.getElementById('tabStatus').textContent = 'Not tracked';
    resetRing(0);
    renderPreview(domains, sessions, awayPeriods);
    return;
  }

  document.getElementById('noRule').classList.add('hidden');
  document.getElementById('timerSection').style.opacity = '1';
  document.getElementById('tabStatus').textContent = rule.enabled ? '✅ Tracking active' : '⏸ Tracking paused';

  const sessionMs = sessions[rule.domain] || 0;
  const limitMs = rule.limitMinutes * 60 * 1000;
  const remaining = Math.max(0, limitMs - sessionMs);
  const pct = limitMs > 0 ? Math.min(1, sessionMs / limitMs) : 0;

  document.getElementById('timerTime').textContent = formatMs(sessionMs);
  document.getElementById('metaLimit').textContent = `${rule.limitMinutes}m`;
  document.getElementById('metaRemain').textContent = formatMs(remaining);
  document.getElementById('timerLabel').textContent = 'used';

  updateRing(pct);
  renderPreview(domains, sessions, awayPeriods);
}

function setNoRule(msg) {
  document.getElementById('tabStatus').textContent = msg;
  document.getElementById('timerSection').style.opacity = '0.3';
  document.getElementById('noRule').classList.add('hidden');
  document.getElementById('awayAlert').classList.add('hidden');
  resetRing(0);
}

function updateRing(pct) {
  const fill = document.getElementById('ringFill');
  const offset = CIRCUMFERENCE * (1 - pct);
  fill.style.strokeDashoffset = offset;

  if (pct >= 0.9) {
    fill.style.stroke = '#f87171';
    fill.style.filter = 'drop-shadow(0 0 6px #f87171)';
  } else if (pct >= 0.7) {
    fill.style.stroke = '#fbbf24';
    fill.style.filter = 'drop-shadow(0 0 6px #fbbf24)';
  } else {
    fill.style.stroke = '#a78bfa';
    fill.style.filter = 'drop-shadow(0 0 6px rgba(167,139,250,0.8))';
  }
}

function resetRing(pct) {
  const fill = document.getElementById('ringFill');
  fill.style.strokeDashoffset = CIRCUMFERENCE;
  document.getElementById('timerTime').textContent = '0:00';
  document.getElementById('metaLimit').textContent = '—';
  document.getElementById('metaRemain').textContent = '—';
}

function renderPreview(domains, sessions, awayPeriods) {
  const list = document.getElementById('previewList');
  const now = Date.now();

  if (domains.length === 0) {
    list.innerHTML = '<div class="preview-empty">No rules configured</div>';
    return;
  }

  list.innerHTML = domains.map((rule) => {
    const sessionMs = sessions[rule.domain] || 0;
    const limitMs = rule.limitMinutes * 60 * 1000;
    const pct = limitMs > 0 ? Math.min(1, sessionMs / limitMs) : 0;
    const isAway = awayPeriods[rule.domain] && awayPeriods[rule.domain] > now;
    const color = isAway ? '#fbbf24' : pct >= 0.9 ? '#f87171' : pct >= 0.7 ? '#fbbf24' : rule.enabled ? '#34d399' : '#555';
    return `
      <div class="preview-item">
        <span class="preview-dot" style="background:${color};box-shadow:0 0 4px ${color}"></span>
        <span class="preview-name">${escapeHtml(rule.domain)}</span>
        <span class="preview-time">${formatMs(sessionMs)}/${rule.limitMinutes}m</span>
      </div>`;
  }).join('');
}

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Events ───────────────────────────────────────────────────────────────────
document.getElementById('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
document.getElementById('addRuleBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!currentDomain) return;
  const { domains, sessions, awayPeriods } = await getStorage();
  const rule = domains.find((d) => currentDomain === d.domain || currentDomain.endsWith('.' + d.domain));
  if (!rule) return;
  const newSessions = { ...sessions, [rule.domain]: 0 };
  chrome.storage.local.set({ sessions: newSessions }, () => refresh());
});

document.getElementById('clearAway').addEventListener('click', async () => {
  if (!currentDomain) return;
  const { awayPeriods } = await getStorage();
  const newAway = { ...awayPeriods };
  // Find and delete matching away entry
  Object.keys(newAway).forEach((k) => {
    if (currentDomain === k || currentDomain.endsWith('.' + k)) delete newAway[k];
  });
  chrome.storage.local.set({ awayPeriods: newAway }, () => refresh());
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
