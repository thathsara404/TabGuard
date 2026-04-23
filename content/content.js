/**
 * ScreenZen Content Script
 * Injected into every page. Monitors URL and communicates with background.
 * Minimal footprint – only acts when a domain rule applies.
 */

(function () {
  'use strict';

  // Prevent double injection
  if (window.__tabguardInjected) return;
  window.__tabguardInjected = true;

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TIME_UPDATE') {
      // Could trigger in-page subtle indicator if desired
    }
  });
})();
