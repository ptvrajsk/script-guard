// Service-worker entry. Listeners are registered synchronously at top level (MV3 requirement).
// NOTE: dynamic import() is disallowed in service workers, so debugger.js is a static import.
// It must not throw at module evaluation; the debugger tier only starts when chrome.debugger exists
// (the "debugger" permission is declared in the manifest).
import * as events from './events.js';
import * as dnr from './dnr.js';
import * as downloads from './downloads.js';
import * as scripts from './scripts.js';
import * as dbg from './debugger.js';
import * as userblocks from './userblocks.js';
import * as pagescripts from './pagescripts.js';
import { sinkTabId, shouldDetachOnNavigate, shouldAttachOnNavigate } from './routing.js';
import { KEYS, DEFAULT_SETTINGS, validateSettings } from '../shared/schema.js';

events.init();
dnr.init();
downloads.init();
scripts.init();
userblocks.init();
pagescripts.init();

// Block management (extension pages only; the handler checks the sender).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const p = userblocks.handleMessage(msg, sender, chrome.runtime.id);
  if (!p) return false;
  p.then(sendResponse);
  return true;
});

const haveDebugger = () => typeof chrome !== 'undefined' && !!chrome.debugger;

async function startDebugger() {
  if (!haveDebugger()) return false;
  await dbg.init();
  return true;
}

try {
  // Sink receives ({kind, detail, tabId?}, tabId?); events without a tab go to the session bucket.
  dbg.setEventSink((evt, tabId) => {
    return events.recordEvent(sinkTabId(evt, tabId), evt);
  });
  startDebugger().catch((e) => console.warn('[sg] debugger init failed:', e && e.message));
} catch (e) {
  console.warn('[sg] debugger tier unavailable:', e && e.message);
}

// Popup -> background: turn script rewriting on or off for a tab. Extension pages only (never content scripts).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'sg:debugger') return false;
  if (sender.id !== chrome.runtime.id || sender.tab) { sendResponse({ error: 'not allowed' }); return false; }
  (async () => {
    const tabId = Number(msg.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('bad tab');
    if (msg.query === true) { let attached = false; try { attached = haveDebugger() && dbg.isEnabled(tabId); } catch {} return { attached }; }
    if (!(await startDebugger())) throw new Error('the debugger API is not available in this browser');
    if (msg.enable === true) await dbg.enableForTab(tabId);
    else await dbg.disableForTab(tabId);
    return { ok: true };
  })().then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});

// Sites with script rewriting switched on get it re-attached when a tab navigates to them.
// Limitation: attaching happens after navigation starts, so the very first load in a fresh tab can
// miss early requests; a reload then picks them up.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'loading' || !tab.url || !haveDebugger()) return;
  try {
    const stored = (await chrome.storage.local.get(KEYS.settings))[KEYS.settings];
    const v = validateSettings(stored || DEFAULT_SETTINGS);
    const sites = v.ok ? v.value.debuggerSites : [];
    const enabled = dbg.isEnabled(tabId);
    if (shouldDetachOnNavigate({ enabled, url: tab.url, debuggerSites: sites })) { await dbg.disableForTab(tabId); return; }
    if (!shouldAttachOnNavigate({ enabled, url: tab.url, debuggerSites: sites })) return;
    await startDebugger();
    await dbg.enableForTab(tabId);
  } catch { /* not an http page, or the tab is gone */ }
});
