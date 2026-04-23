/**
 * ScreenZen – Background Service Worker
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
  <title>ScreenZen – Away Period Active</title>
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
    <p class="desc">ScreenZen is keeping you away to help you stay productive.</p>
    <div class="countdown-wrap">
      <div class="countdown-label">Come back in</div>
      <div class="countdown" id="tg-cd">--:--</div>
      <div class="countdown-sub">remaining in your away period</div>
    </div>
    <div class="bar-wrap">
      <div class="bar-bg"><div class="bar-fill" id="tg-bar" style="width:100%"></div></div>
    </div>
  </div>
</body>
</html>`);
  document.close();

  // Run the countdown logic immediately in the injected context
  const END = awayEndTimestamp;
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

// ─── Look Away Reminder ───────────────────────────────────────────────────────

const ALARM_NAME = 'tabguard-lookaway';

async function getLookAwayConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['lookAway'], (r) => {
      resolve(r.lookAway || { enabled: false, intervalMinutes: 20, durationSeconds: 20 });
    });
  });
}

// Find the best content tab to inject into:
// 1. An active tab in any window that is a real web page
// 2. Fall back to the most recently accessed non-extension tab
async function findBestContentTab() {
  const BLOCKED = ['chrome://', 'about:', 'chrome-extension://', 'moz-extension://', 'edge://'];
  const isContent = (url) => url && !BLOCKED.some((p) => url.startsWith(p));

  // First: check all currently active tabs across all windows
  const activeTabs = await chrome.tabs.query({ active: true });
  const activeContent = activeTabs.find((t) => isContent(t.url));
  if (activeContent) return activeContent;

  // Fallback: most recently accessed non-extension tab in any window
  const allTabs = await chrome.tabs.query({});
  const contentTabs = allTabs.filter((t) => isContent(t.url));
  if (contentTabs.length === 0) return null;
  // Sort by lastAccessed descending (most recent first)
  contentTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return contentTabs[0];
}

async function initLookAwayAlarm(force = false) {
  const cfg = await getLookAwayConfig();
  if (!cfg.enabled || cfg.intervalMinutes <= 0) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  if (!force) {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (existing) return;
  }
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: cfg.intervalMinutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const cfg = await getLookAwayConfig();
  if (!cfg.enabled) return;

  const tab = await findBestContentTab();
  if (!tab) return;

  const exIdx = Math.floor(Math.random() * 5);
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: showLookAwayOverlay,
    args: [cfg.durationSeconds, exIdx],
  }).catch(() => {});
});

// Injected into the active tab
function showLookAwayOverlay(durationSec, exIdx) {
  if (document.getElementById('tg-lookaway')) return;

  const EX = [
    { icon: '🏔️', color: '#a78bfa', title: '20-20-20 Rule',      sub: 'Look at something ~6 metres (20 ft) away',      steps: ['Find a distant object across the room or outside', 'Relax your gaze and focus on it softly', 'Keep looking without straining for the full time', 'Blink naturally while you look'],            anim: 'far' },
    { icon: '👁️', color: '#34d399', title: 'Intentional Blinking', sub: 'Refresh your tear film and reduce dryness',     steps: ['Blink rapidly 10–15 times in a row', 'Close eyes gently and hold for 5 seconds', 'Squeeze eyes shut briefly then fully relax', 'Repeat 3 full cycles'],                          anim: 'blink' },
    { icon: '🔄', color: '#60a5fa', title: 'Eye Rolling',           sub: 'Release tension in your eye muscles',           steps: ['Close your eyes halfway and relax', 'Roll them slowly clockwise 5 full circles', 'Then counter-clockwise 5 full circles', 'Close eyes and rest for a moment'],             anim: 'roll' },
    { icon: '✋', color: '#f472b6', title: 'Palming',               sub: 'Soothe optic nerves with warmth & darkness',    steps: ['Rub your palms together vigorously for warmth', 'Cup warm palms gently over closed eyes', 'Sit in complete darkness — no pressure on eyes', 'Breathe slowly and let your mind rest'], anim: 'palm' },
    { icon: '🎯', color: '#fbbf24', title: 'Focus Shifting',        sub: 'Exercise your ciliary (focusing) muscles',      steps: ['Hold your thumb about 10 cm from your nose', 'Focus on your thumb for 3 full seconds', 'Shift focus to a far object for 3 seconds', 'Repeat the near-far cycle 10 times'],          anim: 'focus' },
  ];

  const ex = EX[exIdx % EX.length];
  const CIRC = 2 * Math.PI * 40; // 251.3

  const eyeAnimations = {
    far:   `@keyframes tg-iris-far{0%,100%{transform:translate(0,0)}50%{transform:translate(8px,-3px)}}`,
    blink: `@keyframes tg-blink{0%,80%,100%{transform:scaleY(1)}85%,95%{transform:scaleY(0.06)}}`,
    roll:  `@keyframes tg-roll{0%{transform:translate(0,-12px)}25%{transform:translate(12px,0)}50%{transform:translate(0,12px)}75%{transform:translate(-12px,0)}100%{transform:translate(0,-12px)}}`,
    palm:  `@keyframes tg-palm{0%,100%{opacity:0.4;transform:scale(1)}50%{opacity:1;transform:scale(1.08)}}`,
    focus: `@keyframes tg-near{0%,100%{opacity:1;r:8}50%{opacity:0.3;r:14}}`,
  };

  const irisAnim = {
    far:   'tg-iris-far 3s ease-in-out infinite',
    blink: 'none',
    roll:  'tg-roll 2.5s linear infinite',
    palm:  'none',
    focus: 'none',
  };
  const eyeAnim = {
    far:   'none',
    blink: 'tg-blink 2.5s ease-in-out infinite',
    roll:  'none',
    palm:  'tg-palm 2s ease-in-out infinite',
    focus: 'none',
  };

  const overlay = document.createElement('div');
  overlay.id = 'tg-lookaway';
  overlay.innerHTML = `
<style>
#tg-lookaway{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI',system-ui,sans-serif;animation:tg-la-in .4s cubic-bezier(.4,0,.2,1)}
@keyframes tg-la-in{from{opacity:0;backdrop-filter:blur(0)}to{opacity:1;backdrop-filter:blur(14px)}}
@keyframes tg-la-out{to{opacity:0}}
.tg-la-bg{position:absolute;inset:0;background:rgba(10,8,30,.72);backdrop-filter:blur(14px)}
.tg-la-card{position:relative;z-index:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.13);border-radius:28px;padding:36px 40px 32px;max-width:480px;width:calc(100vw - 48px);text-align:center;box-shadow:0 40px 100px rgba(0,0,0,.7);animation:tg-la-card-in .45s cubic-bezier(.34,1.56,.64,1)}
@keyframes tg-la-card-in{from{transform:translateY(24px) scale(.95);opacity:0}to{transform:none;opacity:1}}
.tg-la-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${ex.color};background:${ex.color}22;border:1px solid ${ex.color}44;border-radius:100px;padding:4px 12px;margin-bottom:18px}
.tg-la-eye-wrap{width:140px;height:84px;margin:0 auto 20px;position:relative;display:flex;align-items:center;justify-content:center}
.tg-la-eye-svg{width:140px;height:84px;overflow:visible;transform-origin:center;animation:${eyeAnim[ex.anim]}}
.tg-la-iris{animation:${irisAnim[ex.anim]};transform-origin:center}
.tg-la-title{font-size:22px;font-weight:800;color:#f1f0ff;margin:0 0 6px;letter-spacing:-.4px}
.tg-la-sub{font-size:14px;color:rgba(241,240,255,.6);margin:0 0 22px}
.tg-la-steps{text-align:left;display:flex;flex-direction:column;gap:8px;margin-bottom:28px}
.tg-la-step{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:rgba(241,240,255,.8);line-height:1.5}
.tg-la-step span{flex-shrink:0;width:20px;height:20px;border-radius:50%;background:${ex.color}33;border:1px solid ${ex.color}66;color:${ex.color};font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
.tg-la-cd-wrap{position:relative;width:90px;height:90px;margin:0 auto 16px}
.tg-la-ring{width:90px;height:90px;transform:rotate(-90deg)}
.tg-la-ring-bg{fill:none;stroke:rgba(255,255,255,.08);stroke-width:6}
.tg-la-ring-fill{fill:none;stroke:${ex.color};stroke-width:6;stroke-linecap:round;stroke-dasharray:${CIRC.toFixed(1)};stroke-dashoffset:0;transition:stroke-dashoffset 1s linear;filter:drop-shadow(0 0 6px ${ex.color})}
.tg-la-time{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#f1f0ff;letter-spacing:-1px}
.tg-la-cd-label{font-size:12px;color:rgba(241,240,255,.4);margin-bottom:20px}
.tg-la-skip{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:rgba(241,240,255,.5);font-size:13px;font-weight:500;padding:8px 20px;cursor:pointer;font-family:inherit;transition:all .2s}
.tg-la-skip:hover{background:rgba(255,255,255,.12);color:#f1f0ff}
${eyeAnimations[ex.anim]}
</style>
<div class="tg-la-bg"></div>
<div class="tg-la-card">
  <div class="tg-la-badge">👁 Eye Break — Look Away</div>
  <div class="tg-la-eye-wrap">
    <svg class="tg-la-eye-svg" viewBox="-20 -20 140 84">
      <defs>
        <radialGradient id="tg-iris-g" cx="40%" cy="35%">
          <stop offset="0%" stop-color="#c4b5fd"/>
          <stop offset="100%" stop-color="${ex.color}"/>
        </radialGradient>
        <clipPath id="tg-eye-clip">
          <path d="M5,22 Q50,-4 95,22 Q50,48 5,22 Z"/>
        </clipPath>
      </defs>
      <!-- White of eye -->
      <path d="M5,22 Q50,-4 95,22 Q50,48 5,22 Z" fill="rgba(255,255,255,0.95)"/>
      <!-- Iris + pupil group (animated) -->
      <g clip-path="url(#tg-eye-clip)">
        <g class="tg-la-iris">
          <circle cx="50" cy="22" r="17" fill="url(#tg-iris-g)"/>
          <circle cx="50" cy="22" r="9"  fill="#0d0d1a"/>
          <circle cx="55" cy="17" r="3.5" fill="rgba(255,255,255,0.65)"/>
        </g>
      </g>
      <!-- Eyelid line top -->
      <path d="M5,22 Q50,-4 95,22" fill="none" stroke="rgba(0,0,0,0.15)" stroke-width="1.5"/>
    </svg>
  </div>
  <h2 class="tg-la-title">${ex.icon} ${ex.title}</h2>
  <p class="tg-la-sub">${ex.sub}</p>
  <div class="tg-la-steps">
    ${ex.steps.map((s, i) => `<div class="tg-la-step"><span>${i + 1}</span>${s}</div>`).join('')}
  </div>
  <div class="tg-la-cd-wrap">
    <svg class="tg-la-ring" viewBox="0 0 90 90">
      <circle class="tg-la-ring-bg"   cx="45" cy="45" r="40"/>
      <circle class="tg-la-ring-fill" id="tg-la-rf" cx="45" cy="45" r="40"/>
    </svg>
    <div class="tg-la-time" id="tg-la-time">${durationSec}</div>
  </div>
  <div class="tg-la-cd-label">seconds remaining</div>
  <button class="tg-la-skip" id="tg-la-skip">Skip this reminder</button>
</div>`;

  document.body.appendChild(overlay);

  let rem = durationSec;
  const C = 2 * Math.PI * 40;
  const rf = document.getElementById('tg-la-rf');
  const te = document.getElementById('tg-la-time');

  function dismiss() {
    clearInterval(iv);
    overlay.style.animation = 'tg-la-out .35s ease forwards';
    setTimeout(() => overlay.remove(), 370);
  }

  const iv = setInterval(() => {
    rem--;
    if (te) te.textContent = rem;
    if (rf) rf.style.strokeDashoffset = C * (1 - rem / durationSec);
    if (rem <= 0) dismiss();
  }, 1000);

  document.getElementById('tg-la-skip').addEventListener('click', dismiss);
}

// Re-init alarm when look-away settings change
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'LOOKAWAY_UPDATED') {
    initLookAwayAlarm(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'PREVIEW_LOOKAWAY') {
    findBestContentTab().then((tab) => {
      if (!tab) return;
      const exIdx = Math.floor(Math.random() * 5);
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showLookAwayOverlay,
        args: [msg.durationSeconds || 20, exIdx],
      }).catch(() => {});
    });
    sendResponse({ ok: true });
  }
});

// ─── Stand Up & Move Alarm ────────────────────────────────────────────────────

const STANDUP_ALARM = 'tabguard-standup';

async function getStandUpConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['standUp'], (r) => {
      resolve(r.standUp || { enabled: false, intervalMinutes: 60, durationSeconds: 30 });
    });
  });
}

async function initStandUpAlarm(force = false) {
  const cfg = await getStandUpConfig();
  if (!cfg.enabled || cfg.intervalMinutes <= 0) {
    await chrome.alarms.clear(STANDUP_ALARM);
    return;
  }
  if (!force) {
    const existing = await chrome.alarms.get(STANDUP_ALARM);
    if (existing) return;
  }
  await chrome.alarms.clear(STANDUP_ALARM);
  chrome.alarms.create(STANDUP_ALARM, { periodInMinutes: cfg.intervalMinutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== STANDUP_ALARM) return;
  const cfg = await getStandUpConfig();
  if (!cfg.enabled) return;
  const tab = await findBestContentTab();
  if (!tab) return;
  const exIdx = Math.floor(Math.random() * 5);
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: showStandUpOverlay,
    args: [cfg.durationSeconds, exIdx],
  }).catch(() => {});
});

function showStandUpOverlay(durationSec, exIdx) {
  if (document.getElementById('tg-standup')) return;
  const EX = [
    { icon: '🧘', color: '#f472b6', title: 'Desk Stretch',    sub: 'Release neck & shoulder tension',        steps: ['Roll neck slowly in full circles (5×)', 'Shrug shoulders to ears, hold 3s, release', 'Reach both arms overhead and stretch tall', 'Shake out arms and loosen your hands'] },
    { icon: '💪', color: '#a78bfa', title: 'Micro Workout',   sub: 'Get blood flowing without leaving your desk', steps: ['10 chair squats (stand fully, sit back)', '10 calf raises standing on tiptoes', '10 desk push-ups (hands on desk edge)', 'March in place for 30 seconds'] },
    { icon: '🚶', color: '#34d399', title: 'Walk Break',      sub: 'Step away and reset your focus',         steps: ['Stand up slowly and take a deep breath', 'Walk to another room or around the office', 'Take the long route to get a glass of water', 'Return feeling refreshed and focused'] },
    { icon: '🤸', color: '#fbbf24', title: 'Full Body Stretch', sub: 'Open your chest and lengthen your spine', steps: ['Stand and reach both arms toward the sky', 'Gently bend side-to-side (5× each side)', 'Clasp hands behind back and open chest', 'Touch toes gently — hold for 10 seconds'] },
    { icon: '👐', color: '#60a5fa', title: 'Hand & Wrist Care', sub: 'Essential for keyboard & mouse users',  steps: ['Extend arms and open/close fists (15×)', 'Press palms together, prayer pose, hold 10s', 'Bend wrists back gently, hold 5 seconds', 'Shake hands loosely to release tension'] },
  ];
  const ex = EX[exIdx % EX.length];
  const C = 2 * Math.PI * 40;
  const ol = document.createElement('div');
  ol.id = 'tg-standup';
  ol.innerHTML = `<style>
#tg-standup{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI',system-ui,sans-serif;animation:tgsu-in .4s ease}
@keyframes tgsu-in{from{opacity:0}to{opacity:1}}
@keyframes tgsu-out{to{opacity:0}}
.tgsu-bg{position:absolute;inset:0;background:rgba(10,4,24,.75);backdrop-filter:blur(14px)}
.tgsu-card{position:relative;z-index:1;background:rgba(255,255,255,.05);border:1px solid ${ex.color}33;border-radius:28px;padding:36px 40px 32px;max-width:460px;width:calc(100vw - 48px);text-align:center;box-shadow:0 40px 100px rgba(0,0,0,.7);animation:tgsu-card-in .45s cubic-bezier(.34,1.56,.64,1)}
@keyframes tgsu-card-in{from{transform:translateY(24px) scale(.95);opacity:0}to{transform:none;opacity:1}}
.tgsu-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${ex.color};background:${ex.color}22;border:1px solid ${ex.color}44;border-radius:100px;padding:4px 12px;margin-bottom:16px}
.tgsu-icon{font-size:64px;margin-bottom:12px;display:block;animation:tgsu-bounce 1.8s ease-in-out infinite}
@keyframes tgsu-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.tgsu-title{font-size:22px;font-weight:800;color:#f1f0ff;margin:0 0 6px}
.tgsu-sub{font-size:14px;color:rgba(241,240,255,.55);margin:0 0 22px}
.tgsu-steps{text-align:left;display:flex;flex-direction:column;gap:8px;margin-bottom:28px}
.tgsu-step{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:rgba(241,240,255,.8);line-height:1.5}
.tgsu-step span{flex-shrink:0;width:20px;height:20px;border-radius:50%;background:${ex.color}33;border:1px solid ${ex.color}66;color:${ex.color};font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
.tgsu-cw{position:relative;width:90px;height:90px;margin:0 auto 10px}
.tgsu-ring{width:90px;height:90px;transform:rotate(-90deg)}
.tgsu-rbg{fill:none;stroke:rgba(255,255,255,.08);stroke-width:6}
.tgsu-rf{fill:none;stroke:${ex.color};stroke-width:6;stroke-linecap:round;stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:0;transition:stroke-dashoffset 1s linear;filter:drop-shadow(0 0 6px ${ex.color})}
.tgsu-time{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#f1f0ff}
.tgsu-lbl{font-size:12px;color:rgba(241,240,255,.35);margin-bottom:18px}
.tgsu-skip{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:rgba(241,240,255,.5);font-size:13px;font-weight:500;padding:8px 20px;cursor:pointer;font-family:inherit;transition:all .2s}
.tgsu-skip:hover{background:rgba(255,255,255,.12);color:#f1f0ff}
</style>
<div class="tgsu-bg"></div>
<div class="tgsu-card">
  <div class="tgsu-badge">🧘 Movement Break</div>
  <span class="tgsu-icon">${ex.icon}</span>
  <h2 class="tgsu-title">${ex.title}</h2>
  <p class="tgsu-sub">${ex.sub}</p>
  <div class="tgsu-steps">${ex.steps.map((s,i)=>`<div class="tgsu-step"><span>${i+1}</span>${s}</div>`).join('')}</div>
  <div class="tgsu-cw">
    <svg class="tgsu-ring" viewBox="0 0 90 90"><circle class="tgsu-rbg" cx="45" cy="45" r="40"/><circle class="tgsu-rf" id="tgsu-rf" cx="45" cy="45" r="40"/></svg>
    <div class="tgsu-time" id="tgsu-t">${durationSec}</div>
  </div>
  <div class="tgsu-lbl">seconds</div>
  <button class="tgsu-skip" id="tgsu-skip">Skip</button>
</div>`;
  document.body.appendChild(ol);
  let rem = durationSec;
  const rf = document.getElementById('tgsu-rf');
  const te = document.getElementById('tgsu-t');
  const dismiss = () => { clearInterval(iv); ol.style.animation = 'tgsu-out .35s ease forwards'; setTimeout(() => ol.remove(), 370); };
  const iv = setInterval(() => { rem--; if(te) te.textContent=rem; if(rf) rf.style.strokeDashoffset=C*(1-rem/durationSec); if(rem<=0) dismiss(); }, 1000);
  document.getElementById('tgsu-skip').addEventListener('click', dismiss);
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'STANDUP_UPDATED') { initStandUpAlarm(true).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'PREVIEW_STANDUP') {
    findBestContentTab().then((tab) => {
      if (!tab) return;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showStandUpOverlay, args: [msg.durationSeconds || 30, Math.floor(Math.random() * 5)] }).catch(() => {});
    });
    sendResponse({ ok: true });
  }
});

// ─── Drink Water Alarm ────────────────────────────────────────────────────────

const WATER_ALARM = 'tabguard-water';

async function getWaterConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['water'], (r) => {
      resolve(r.water || { enabled: false, intervalMinutes: 45, durationSeconds: 15 });
    });
  });
}

async function initWaterAlarm(force = false) {
  const cfg = await getWaterConfig();
  if (!cfg.enabled || cfg.intervalMinutes <= 0) {
    await chrome.alarms.clear(WATER_ALARM);
    return;
  }
  if (!force) {
    const existing = await chrome.alarms.get(WATER_ALARM);
    if (existing) return;
  }
  await chrome.alarms.clear(WATER_ALARM);
  chrome.alarms.create(WATER_ALARM, { periodInMinutes: cfg.intervalMinutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATER_ALARM) return;
  const cfg = await getWaterConfig();
  if (!cfg.enabled) return;
  const tab = await findBestContentTab();
  if (!tab) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showWaterOverlay, args: [cfg.durationSeconds] }).catch(() => {});
});

function showWaterOverlay(durationSec) {
  if (document.getElementById('tg-water')) return;
  const TIPS = [
    'Even mild dehydration reduces focus and increases fatigue.',
    'Your brain is ~75% water — keep it hydrated for peak performance.',
    'Aim for 8 glasses (2 litres) of water per day.',
    'Herbal tea, coconut water or fruit-infused water all count!',
    'A glass of water now can prevent afternoon energy slumps.',
  ];
  const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
  const C = 2 * Math.PI * 40;
  const ol = document.createElement('div');
  ol.id = 'tg-water';
  ol.innerHTML = `<style>
#tg-water{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:'Segoe UI',system-ui,sans-serif;animation:tgw-in .4s ease}
@keyframes tgw-in{from{opacity:0}to{opacity:1}}
@keyframes tgw-out{to{opacity:0}}
.tgw-bg{position:absolute;inset:0;background:rgba(2,8,30,.78);backdrop-filter:blur(14px)}
.tgw-card{position:relative;z-index:1;background:rgba(255,255,255,.05);border:1px solid #60a5fa33;border-radius:28px;padding:36px 40px 32px;max-width:420px;width:calc(100vw - 48px);text-align:center;box-shadow:0 40px 100px rgba(0,0,0,.7);animation:tgw-card-in .45s cubic-bezier(.34,1.56,.64,1)}
@keyframes tgw-card-in{from{transform:translateY(24px) scale(.95);opacity:0}to{transform:none;opacity:1}}
.tgw-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#60a5fa;background:#60a5fa22;border:1px solid #60a5fa44;border-radius:100px;padding:4px 12px;margin-bottom:16px}
.tgw-drop{font-size:72px;margin-bottom:10px;display:block;animation:tgw-drop 2s ease-in-out infinite}
@keyframes tgw-drop{0%,100%{transform:scale(1) translateY(0)}40%{transform:scale(1.1) translateY(-6px)}60%{transform:scale(.95) translateY(2px)}}
.tgw-fill{width:60px;height:80px;margin:0 auto 20px;position:relative;border-radius:4px 4px 10px 10px;background:rgba(255,255,255,.06);border:2px solid #60a5fa44;overflow:hidden}
.tgw-water{position:absolute;bottom:0;left:0;right:0;height:60%;background:linear-gradient(180deg,#60a5fa99,#2563eb);animation:tgw-wave 2s ease-in-out infinite}
@keyframes tgw-wave{0%,100%{height:55%}50%{height:65%}}
.tgw-title{font-size:22px;font-weight:800;color:#f1f0ff;margin:0 0 8px}
.tgw-tip{font-size:13px;color:rgba(241,240,255,.6);margin:0 0 24px;line-height:1.6;font-style:italic}
.tgw-cta{font-size:15px;font-weight:700;color:#60a5fa;background:#60a5fa18;border:1px solid #60a5fa44;border-radius:12px;padding:12px 24px;margin-bottom:24px;display:block}
.tgw-cw{position:relative;width:80px;height:80px;margin:0 auto 8px}
.tgw-ring{width:80px;height:80px;transform:rotate(-90deg)}
.tgw-rbg{fill:none;stroke:rgba(255,255,255,.08);stroke-width:6}
.tgw-rf{fill:none;stroke:#60a5fa;stroke-width:6;stroke-linecap:round;stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:0;transition:stroke-dashoffset 1s linear;filter:drop-shadow(0 0 6px #60a5fa)}
.tgw-time{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#f1f0ff}
.tgw-lbl{font-size:12px;color:rgba(241,240,255,.35);margin-bottom:16px}
.tgw-skip{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:rgba(241,240,255,.5);font-size:13px;font-weight:500;padding:8px 20px;cursor:pointer;font-family:inherit;transition:all .2s}
.tgw-skip:hover{background:rgba(255,255,255,.12);color:#f1f0ff}
</style>
<div class="tgw-bg"></div>
<div class="tgw-card">
  <div class="tgw-badge">💧 Hydration Break</div>
  <div class="tgw-fill"><div class="tgw-water"></div></div>
  <h2 class="tgw-title">Time to Drink Water!</h2>
  <p class="tgw-tip">"${tip}"</p>
  <span class="tgw-cta">🥤 Grab a glass of water now</span>
  <div class="tgw-cw">
    <svg class="tgw-ring" viewBox="0 0 80 80"><circle class="tgw-rbg" cx="40" cy="40" r="34"/><circle class="tgw-rf" id="tgw-rf" cx="40" cy="40" r="34"/></svg>
    <div class="tgw-time" id="tgw-t">${durationSec}</div>
  </div>
  <div class="tgw-lbl">seconds</div>
  <button class="tgw-skip" id="tgw-skip">Skip</button>
</div>`;
  document.body.appendChild(ol);
  let rem = durationSec;
  const rf = document.getElementById('tgw-rf');
  const te = document.getElementById('tgw-t');
  const dismiss = () => { clearInterval(iv); ol.style.animation = 'tgw-out .35s ease forwards'; setTimeout(() => ol.remove(), 370); };
  const iv = setInterval(() => { rem--; if(te) te.textContent=rem; if(rf) rf.style.strokeDashoffset=C*(1-rem/durationSec); if(rem<=0) dismiss(); }, 1000);
  document.getElementById('tgw-skip').addEventListener('click', dismiss);
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'WATER_UPDATED') { initWaterAlarm(true).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'PREVIEW_WATER') {
    findBestContentTab().then((tab) => {
      if (!tab) return;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showWaterOverlay, args: [msg.durationSeconds || 15] }).catch(() => {});
    });
    sendResponse({ ok: true });
  }
});

// Boot all wellness alarms
initLookAwayAlarm();
initStandUpAlarm();
initWaterAlarm();


