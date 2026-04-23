/**
 * ScreenZen – Background for Firefox (MV2)
 * Uses the same logic as background.js but adapted for Firefox's event page model.
 * Firefox doesn't support chrome.scripting in MV2 the same way; 
 * we use browser.tabs.executeScript instead.
 */

// Polyfill chrome -> browser namespace where needed
const _browser = typeof browser !== 'undefined' ? browser : chrome;

// ─── Storage Helpers ────────────────────────────────────────────────────────

async function getSettings() {
  const result = await _browser.storage.local.get(['domains', 'sessions', 'awayPeriods']);
  return {
    domains: result.domains || [],
    sessions: result.sessions || {},
    awayPeriods: result.awayPeriods || {},
  };
}

async function saveSettings(data) {
  await _browser.storage.local.set(data);
}

// ─── Domain Matching ─────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function findMatchingRule(domains, hostname) {
  if (!hostname) return null;
  return domains.find((d) => {
    const rule = d.domain.replace(/^www\./, '').toLowerCase();
    const host = hostname.toLowerCase();
    return host === rule || host.endsWith('.' + rule);
  }) || null;
}

// ─── In-memory state ───────────────────────────────────────────────────
let activeTabInfo = null;
let tickInterval = null;
// Guard: true while triggerClosure is running so onTabRemoved cannot
// overwrite the 0-reset with stale over-limit time.
let closureInProgress = false;

function startTicking() {
  if (tickInterval) return;
  tickInterval = setInterval(onTick, 1000);
}

function stopTicking() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────
async function onTick() {
  if (!activeTabInfo) return;
  const { tabId, domain, startTime } = activeTabInfo;
  const { domains, sessions, awayPeriods } = await getSettings();

  const away = awayPeriods[domain];
  if (away && Date.now() < away) return;

  const rule = findMatchingRule(domains, domain);
  if (!rule || !rule.enabled) return;

  const limitMs = rule.limitMinutes * 60 * 1000;
  if (limitMs <= 0) return;

  const elapsed = Date.now() - startTime;
  const total = (sessions[domain] || 0) + elapsed;
  activeTabInfo.startTime = Date.now();

  await saveSettings({ sessions: { ...sessions, [domain]: total } });

  if (total >= limitMs) {
    await triggerClosure(tabId, domain, rule);
  }
}

// ─── Closure ──────────────────────────────────────────────────────────────────
async function triggerClosure(tabId, domain, rule) {
  stopTicking();
  activeTabInfo = null;
  closureInProgress = true;

  // Read fresh settings – avoids using the stale snapshot from onTick
  const { sessions, awayPeriods } = await getSettings();

  const awayMs = (rule.awayMinutes || 0) * 60 * 1000;
  const newAway = { ...awayPeriods };
  if (awayMs > 0) newAway[domain] = Date.now() + awayMs;

  // Reset session to 0 so the next visit starts completely fresh
  await saveSettings({ sessions: { ...sessions, [domain]: 0 }, awayPeriods: newAway });

  const msg = rule.message || 'Your time limit for this site has been reached.';

  try {
    await _browser.tabs.executeScript(tabId, {
      code: `
        if (!document.getElementById('tabguard-overlay')) {
          const o = document.createElement('div');
          o.id = 'tabguard-overlay';
          o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);display:flex;align-items:center;justify-content:center;font-family:Segoe UI,system-ui,sans-serif';
          o.innerHTML = '<div style="text-align:center;color:#fff;padding:48px 40px;background:rgba(255,255,255,.05);border-radius:24px;border:1px solid rgba(255,255,255,.12);max-width:520px;box-shadow:0 32px 80px rgba(0,0,0,.6)"><div style="font-size:64px;margin-bottom:16px">⏱️</div><h1 style="font-size:28px;font-weight:700;margin:0 0 12px">Time\'s Up!</h1><p style="font-size:16px;color:rgba(255,255,255,.75);margin:0 0 32px;line-height:1.6">${msg.replace(/'/g, "\\'")}</p><div id="tabguard-cd" style="font-size:48px;font-weight:800;color:#a78bfa">5</div><p style="font-size:13px;color:rgba(255,255,255,.4);margin:8px 0 0">Tab closing in <span id="tabguard-s">5</span> seconds…</p></div>';
          document.body.appendChild(o);
          let r=5;
          const iv=setInterval(()=>{r--;const c=document.getElementById('tabguard-cd');const s=document.getElementById('tabguard-s');if(c)c.textContent=r;if(s)s.textContent=r;if(r<=0)clearInterval(iv);},1000);
        }
      `,
    });
  } catch (e) { /* ignore */ }

  setTimeout(() => {
    closureInProgress = false;
    _browser.tabs.remove(tabId).catch(() => {});
  }, 5500);
}

// ─── Tab Listeners ────────────────────────────────────────────────────────────
async function pauseCurrentTracking() {
  if (!activeTabInfo) return;
  stopTicking();
  const { sessions } = await getSettings();
  const elapsed = Date.now() - activeTabInfo.startTime;
  const domain = activeTabInfo.domain;
  await saveSettings({ sessions: { ...sessions, [domain]: (sessions[domain] || 0) + elapsed } });
  activeTabInfo = null;
}

async function resumeTrackingForTab(tabId) {
  let tab;
  try { tab = await _browser.tabs.get(tabId); } catch { return; }
  if (!tab.url || /^(about|moz-extension|chrome-extension|chrome):/.test(tab.url)) return;

  const domain = extractDomain(tab.url);
  if (!domain) return;

  const { domains, awayPeriods, sessions } = await getSettings();
  const away = awayPeriods[domain];
  if (away && Date.now() < away) return;

  const rule = findMatchingRule(domains, domain);
  if (!rule || !rule.enabled || !rule.limitMinutes) return;

  // If there was a (now-expired) away period entry, clean it up and guarantee
  // a 0 session so the new session starts completely fresh.
  if (away) {
    const cleanedAway = { ...awayPeriods };
    delete cleanedAway[domain];
    const cleanedSessions = { ...sessions, [domain]: 0 };
    await saveSettings({ awayPeriods: cleanedAway, sessions: cleanedSessions });
  }

  activeTabInfo = { tabId, domain, startTime: Date.now() };
  startTicking();
}

_browser.tabs.onActivated.addListener(async ({ tabId }) => {
  await pauseCurrentTracking();
  await resumeTrackingForTab(tabId);
});

_browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    await pauseCurrentTracking();
    await resumeTrackingForTab(tabId);
  }
  if (changeInfo.status === 'loading' && tab.url) {
    const domain = extractDomain(tab.url);
    if (domain) {
      const { awayPeriods } = await getSettings();
      const away = awayPeriods[domain];
      if (away && Date.now() < away) {
        _browser.tabs.executeScript(tabId, {
          code: `
            document.open();
            document.write('<html><head><title>ScreenZen \u2013 Away Period Active</title><style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);display:flex;align-items:center;justify-content:center;font-family:Segoe UI,system-ui,sans-serif;color:#fff}.card{text-align:center;padding:48px 40px;max-width:520px;width:100%;background:rgba(255,255,255,.05);border-radius:24px;border:1px solid rgba(255,255,255,.12);box-shadow:0 32px 80px rgba(0,0,0,.6)}.icon{font-size:72px;margin-bottom:16px;display:block}h1{font-size:28px;font-weight:700;margin-bottom:16px}.domain{color:#a78bfa;font-weight:700}.desc{color:rgba(255,255,255,.65);line-height:1.65;margin-bottom:6px;font-size:15px}.cw{margin-top:32px}.cl{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.35);margin-bottom:8px}.cd{font-size:56px;font-weight:800;letter-spacing:-2px;color:#fbbf24;text-shadow:0 0 40px rgba(251,191,36,.45);font-variant-numeric:tabular-nums}.cd.done{color:#34d399}.cs{font-size:13px;color:rgba(255,255,255,.35);margin-top:8px}.bw{margin-top:24px}.bb{height:6px;background:rgba(255,255,255,.08);border-radius:100px;overflow:hidden}.bf{height:100%;border-radius:100px;background:linear-gradient(90deg,#f59e0b,#fbbf24);transition:width 1s linear}</style></head><body><div class=card><span class=icon>&#x1F6AB;</span><h1>Away Period Active</h1><p class=desc>You have reached your time limit for <span class=domain>${domain}</span>.</p><p class=desc>ScreenZen is keeping you away to help you stay productive.</p><div class=cw><div class=cl>Come back in</div><div class=cd id=tg-cd>--:--</div><div class=cs>remaining in your away period</div></div><div class=bw><div class=bb><div class=bf id=tg-bar style=width:100%></div></div></div></div></body></html>');
            document.close();

            (function(){
              const E=${away};
              const T=E-Date.now();
              function f(ms){
                if(ms<=0)return"00:00";
                const ts=Math.ceil(ms/1000);
                const h=Math.floor(ts/3600);
                const m=Math.floor((ts%3600)/60);
                const s=ts%60;
                const mm=String(m).padStart(2,"0");
                const ss=String(s).padStart(2,"0");
                return h>0?h+":"+mm+":"+ss:mm+":"+ss;
              }
              function u(){
                const r=E-Date.now();
                const c=document.getElementById("tg-cd");
                const b=document.getElementById("tg-bar");
                if(!c)return;
                if(r<=0){
                  c.textContent="00:00";
                  c.classList.add("done");
                  if(b)b.style.width="0%";
                  clearInterval(iv);
                  return;
                }
                c.textContent=f(r);
                if(b&&T>0)b.style.width=Math.max(0,(r/T)*100)+"%";
              }
              u();
              const iv=setInterval(u,1000);
            })();
          `,
        }).catch(() => {});
      }
    }
  }
});

_browser.tabs.onRemoved.addListener(async (tabId) => {
  // Guard: closure in progress already reset the session to 0; skip to avoid overwrite.
  if (closureInProgress) return;
  if (activeTabInfo && activeTabInfo.tabId === tabId) await pauseCurrentTracking();
});

_browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === _browser.windows.WINDOW_ID_NONE) {
    await pauseCurrentTracking();
    return;
  }
  const tabs = await _browser.tabs.query({ active: true, windowId });
  if (tabs.length > 0) await resumeTrackingForTab(tabs[0].id);
});

_browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATUS') {
    getSettings().then((d) => sendResponse(d));
    return true;
  }
  if (msg.type === 'SETTINGS_UPDATED') {
    _browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      if (tabs[0]) { await pauseCurrentTracking(); await resumeTrackingForTab(tabs[0].id); }
    });
    sendResponse({ ok: true });
  }
});

// Init
_browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
  if (tabs[0]) await resumeTrackingForTab(tabs[0].id);
});
