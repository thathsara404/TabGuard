/**
 * TabGuard – Background Service Worker
 * Tracks active tab time, enforces limits, and manages away periods.
 */

// ─── Storage Helpers ────────────────────────────────────────────────────────

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['domains', 'sessions', 'awayPeriods'], (result) => {
      resolve({
        domains: result.domains || [],
        sessions: result.sessions || {},
        awayPeriods: result.awayPeriods || {},
      });
    });
  });
}

async function saveSettings(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, resolve);
  });
}

// ─── Domain Matching ─────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function findMatchingRule(domains, hostname) {
  if (!hostname) return null;
  return domains.find((d) => {
    const rule = d.domain.replace(/^www\./, '').toLowerCase();
    const host = hostname.toLowerCase();
    return host === rule || host.endsWith('.' + rule);
  }) || null;
}

// ─── Session State (in-memory) ────────────────────────────────────────────────

// activeTabInfo: { tabId, domain, startTime }
let activeTabInfo = null;
// pendingTick: setInterval handle
let tickInterval = null;
// Set to true while triggerClosure is running so onTabRemoved does not
// write stale (over-limit) time back to storage and undo the 0-reset.
let closureInProgress = false;

function startTicking() {
  if (tickInterval) return;
  tickInterval = setInterval(onTick, 1000);
}

function stopTicking() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

// ─── Core Tick Logic ─────────────────────────────────────────────────────────

async function onTick() {
  if (!activeTabInfo) return;
  const { tabId, domain, startTime } = activeTabInfo;

  const { domains, sessions, awayPeriods } = await getSettings();

  // Check away period
  const away = awayPeriods[domain];
  if (away && Date.now() < away) {
    return; // still in away period – tab should have been blocked by content script
  }

  const rule = findMatchingRule(domains, domain);
  if (!rule || !rule.enabled) return;

  const limitMs = (rule.limitMinutes || 0) * 60 * 1000;
  if (limitMs <= 0) return;

  // Accumulate
  const elapsed = Date.now() - startTime;
  const prev = sessions[domain] || 0;
  const total = prev + elapsed;

  // Update startTime to now (so next tick only adds 1 second)
  activeTabInfo.startTime = Date.now();

  await saveSettings({ sessions: { ...sessions, [domain]: total } });

  if (total >= limitMs) {
    await triggerClosure(tabId, domain, rule);
  } else {
    // Notify popup/content of current time (optional broadcast)
    broadcastTimeUpdate(domain, total, limitMs);
  }
}

function broadcastTimeUpdate(domain, elapsed, limit) {
  chrome.runtime.sendMessage(
    { type: 'TIME_UPDATE', domain, elapsed, limit },
    () => { chrome.runtime.lastError; } // suppress errors when popup is closed
  );
}

// ─── Tab Closure ──────────────────────────────────────────────────────────────

async function triggerClosure(tabId, domain, rule) {
  stopTicking();
  activeTabInfo = null;
  closureInProgress = true;

  // Read fresh settings to avoid using stale snapshot from onTick
  const { sessions, awayPeriods } = await getSettings();

  // Set away period
  const awayMs = (rule.awayMinutes || 0) * 60 * 1000;
  const newAway = { ...awayPeriods };
  if (awayMs > 0) {
    newAway[domain] = Date.now() + awayMs;
  }

  // Reset session to 0 so the next visit starts completely fresh
  const newSessions = { ...sessions, [domain]: 0 };
  await saveSettings({ sessions: newSessions, awayPeriods: newAway });

  // Show overlay then close tab
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showClosureOverlay,
      args: [rule.message || 'Your time limit for this site has been reached.', 5],
    });
  } catch (e) {
    // If scripting fails, close immediately
    closureInProgress = false;
    chrome.tabs.remove(tabId);
    return;
  }

  // Close after 5 seconds (overlay countdown handles UI)
  setTimeout(() => {
    closureInProgress = false;
    chrome.tabs.remove(tabId, () => { chrome.runtime.lastError; });
  }, 5500);
}

// This function is injected into the page
function showClosureOverlay(message, seconds) {
  if (document.getElementById('tabguard-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'tabguard-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
    display: flex; align-items: center; justify-content: center;
    font-family: 'Segoe UI', system-ui, sans-serif;
  `;

  overlay.innerHTML = `
    <div style="
      text-align: center; color: #fff; padding: 48px 40px;
      background: rgba(255,255,255,0.05); border-radius: 24px;
      border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(20px);
      max-width: 520px; box-shadow: 0 32px 80px rgba(0,0,0,0.6);
    ">
      <div style="font-size: 64px; margin-bottom: 16px;">⏱️</div>
      <h1 style="font-size: 28px; font-weight: 700; margin: 0 0 12px; letter-spacing: -0.5px;">
        Time's Up!
      </h1>
      <p style="font-size: 16px; color: rgba(255,255,255,0.75); margin: 0 0 32px; line-height: 1.6;">
        ${message}
      </p>
      <div id="tabguard-countdown" style="
        font-size: 48px; font-weight: 800; color: #a78bfa;
        text-shadow: 0 0 30px rgba(167,139,250,0.5);
      ">${seconds}</div>
      <p style="font-size: 13px; color: rgba(255,255,255,0.4); margin: 8px 0 0;">
        Tab closing in <span id="tabguard-sec">${seconds}</span> second${seconds !== 1 ? 's' : ''}…
      </p>
    </div>
  `;

  document.body.appendChild(overlay);

  let remaining = seconds;
  const iv = setInterval(() => {
    remaining--;
    const cd = document.getElementById('tabguard-countdown');
    const sc = document.getElementById('tabguard-sec');
    if (cd) cd.textContent = remaining;
    if (sc) sc.textContent = remaining;
    if (remaining <= 0) clearInterval(iv);
  }, 1000);
}

// ─── Tab & Window Event Listeners ────────────────────────────────────────────

async function onTabActivated({ tabId, windowId }) {
  await pauseCurrentTracking();
  await resumeTrackingForTab(tabId);
}

async function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete' && tab.active) {
    await pauseCurrentTracking();
    await resumeTrackingForTab(tabId);
  }

  // Block domain if in away period
  if (changeInfo.status === 'loading' && tab.url) {
    const domain = extractDomain(tab.url);
    if (domain) {
      const { awayPeriods } = await getSettings();
      const away = awayPeriods[domain];
      if (away && Date.now() < away) {
        // Pass the exact end-timestamp so the injected page can run a live countdown
        chrome.scripting.executeScript({
          target: { tabId },
          func: showBlockedPage,
          args: [domain, away],
        }).catch(() => {});
      }
    }
  }
}

async function onTabRemoved(tabId) {
  // Guard: if a limit-triggered closure is in progress, the session has already
  // been reset to 0. Do NOT call pauseCurrentTracking() here or it will write
  // the over-limit accumulated time back and overwrite the 0-reset.
  if (closureInProgress) return;
  if (activeTabInfo && activeTabInfo.tabId === tabId) {
    await pauseCurrentTracking();
  }
}

async function onWindowFocusChanged(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await pauseCurrentTracking();
    return;
  }
  // Get active tab in focused window
  const tabs = await chrome.tabs.query({ active: true, windowId });
  if (tabs.length > 0) {
    await resumeTrackingForTab(tabs[0].id);
  }
}

// ─── Tracking Helpers ─────────────────────────────────────────────────────────

async function pauseCurrentTracking() {
  if (!activeTabInfo) return;
  stopTicking();

  const { sessions } = await getSettings();
  const elapsed = Date.now() - activeTabInfo.startTime;
  const domain = activeTabInfo.domain;
  const prev = sessions[domain] || 0;

  await saveSettings({ sessions: { ...sessions, [domain]: prev + elapsed } });
  activeTabInfo = null;
}

async function resumeTrackingForTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }

  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('moz-extension://') || tab.url.startsWith('chrome-extension://')) {
    return;
  }

  const domain = extractDomain(tab.url);
  if (!domain) return;

  const { domains, awayPeriods, sessions } = await getSettings();

  // Check away period
  const away = awayPeriods[domain];
  if (away && Date.now() < away) return;

  const rule = findMatchingRule(domains, domain);
  if (!rule || !rule.enabled || !rule.limitMinutes) return;

  // If there was a (now-expired) away period entry, it means the previous session
  // ended by hitting the limit. Clean up the stale entry and guarantee the
  // session counter is 0 so the new session starts completely fresh.
  if (away) {
    const cleanedAway = { ...awayPeriods };
    delete cleanedAway[domain];
    const cleanedSessions = { ...sessions, [domain]: 0 };
    await saveSettings({ awayPeriods: cleanedAway, sessions: cleanedSessions });
  }

  activeTabInfo = { tabId, domain, startTime: Date.now() };
  startTicking();
}

// ─── Blocked Page (injected) ─────────────────────────────────────────────────

// awayEndTimestamp: exact ms timestamp when the away period expires
function showBlockedPage(domain, awayEndTimestamp) {
  document.open();
  document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TabGuard – Away Period Active</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Segoe UI', system-ui, sans-serif; color: #fff;
    }
    .card {
      text-align: center; padding: 48px 40px; max-width: 520px; width: 100%;
      background: rgba(255,255,255,0.05); border-radius: 24px;
      border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(20px);
      box-shadow: 0 32px 80px rgba(0,0,0,0.6);
    }
    .icon { font-size: 72px; margin-bottom: 16px; display: block; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 16px; }
    .domain { color: #a78bfa; font-weight: 700; }
    .desc { color: rgba(255,255,255,0.65); line-height: 1.65; margin-bottom: 6px; font-size: 15px; }
    .countdown-wrap { margin-top: 32px; }
    .countdown-label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.35); margin-bottom: 8px; }
    .countdown {
      font-size: 56px; font-weight: 800; letter-spacing: -2px;
      color: #fbbf24;
      text-shadow: 0 0 40px rgba(251,191,36,0.45);
      font-variant-numeric: tabular-nums;
      transition: color 0.4s;
    }
    .countdown.done { color: #34d399; text-shadow: 0 0 40px rgba(52,211,153,0.45); }
    .countdown-sub { font-size: 13px; color: rgba(255,255,255,0.35); margin-top: 8px; }
    .bar-wrap { margin-top: 24px; }
    .bar-bg { height: 6px; background: rgba(255,255,255,0.08); border-radius: 100px; overflow: hidden; }
    .bar-fill {
      height: 100%; border-radius: 100px;
      background: linear-gradient(90deg, #f59e0b, #fbbf24);
      transition: width 1s linear;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">🚫</span>
    <h1>Away Period Active</h1>
    <p class="desc">You've reached your time limit for <span class="domain">${domain}</span>.</p>
    <p class="desc">TabGuard is keeping you away to help you stay productive.</p>
    <div class="countdown-wrap">
      <div class="countdown-label">Come back in</div>
      <div class="countdown" id="tg-cd">--:--</div>
      <div class="countdown-sub">remaining in your away period</div>
    </div>
    <div class="bar-wrap">
      <div class="bar-bg"><div class="bar-fill" id="tg-bar" style="width:100%"></div></div>
    </div>
  </div>
  <script>
    (function() {
      const END = ${awayEndTimestamp};
      const TOTAL = END - Date.now();
      function fmt(ms) {
        if (ms <= 0) return '00:00';
        const totalSec = Math.ceil(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const mm = String(m).padStart(2, '0');
        const ss = String(s).padStart(2, '0');
        return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
      }
      function update() {
        const rem = END - Date.now();
        const cd = document.getElementById('tg-cd');
        const bar = document.getElementById('tg-bar');
        if (!cd) return;
        if (rem <= 0) {
          cd.textContent = '00:00';
          cd.classList.add('done');
          if (bar) bar.style.width = '0%';
          clearInterval(iv);
          return;
        }
        cd.textContent = fmt(rem);
        if (bar && TOTAL > 0) bar.style.width = Math.max(0, (rem / TOTAL) * 100) + '%';
      }
      update();
      const iv = setInterval(update, 1000);
    })();
  </script>
</body>
</html>`);
  document.close();
}

// ─── Message Handler (from popup/settings) ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATUS') {
    getSettings().then(({ sessions, awayPeriods, domains }) => {
      sendResponse({ sessions, awayPeriods, domains, activeTabInfo });
    });
    return true;
  }
  if (msg.type === 'RESET_SESSION') {
    getSettings().then(({ sessions }) => {
      const newSessions = { ...sessions, [msg.domain]: 0 };
      saveSettings({ sessions: newSessions }).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
  if (msg.type === 'CLEAR_AWAY') {
    getSettings().then(({ awayPeriods }) => {
      const newAway = { ...awayPeriods };
      delete newAway[msg.domain];
      saveSettings({ awayPeriods: newAway }).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
  if (msg.type === 'SETTINGS_UPDATED') {
    // Re-evaluate current tab
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        await pauseCurrentTracking();
        await resumeTrackingForTab(tabs[0].id);
      }
    });
    sendResponse({ ok: true });
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(onTabActivated);
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.windows.onFocusChanged.addListener(onWindowFocusChanged);

// On startup, pick up current active tab
chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  if (tabs[0]) {
    await resumeTrackingForTab(tabs[0].id);
  }
});
