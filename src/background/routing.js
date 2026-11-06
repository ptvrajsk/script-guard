// Small pure decisions used by index.js (kept chrome-free so node --test can load them).
import { etld1, hostnameOf } from '../shared/sites.js';

const SESSION_TAB = -1; // same value as events.SESSION_TAB
const isTabId = (n) => Number.isInteger(n) && n >= 0;

/** Which tab bucket a debugger-tier event belongs to: explicit arg, then detail.tabId, then evt.tabId, else the session bucket. */
export function sinkTabId(evt, tabId) {
  if (isTabId(tabId)) return tabId;
  if (evt && typeof evt === 'object') {
    if (evt.detail && typeof evt.detail === 'object' && isTabId(evt.detail.tabId)) return evt.detail.tabId;
    if (isTabId(evt.tabId)) return evt.tabId;
  }
  return SESSION_TAB;
}

/** True when script rewriting is on for a tab that just navigated to a site that is not in debuggerSites. */
export function shouldDetachOnNavigate({ enabled, url, debuggerSites }) {
  if (!enabled) return false;
  const host = hostnameOf(url);
  if (!host) return true; // not a normal web page any more
  return !(Array.isArray(debuggerSites) && debuggerSites.includes(etld1(host)));
}

/** True when a navigation should attach the debugger: the site is listed and the tab is not already attached. */
export function shouldAttachOnNavigate({ enabled, url, debuggerSites }) {
  if (enabled) return false;
  const host = hostnameOf(url);
  return !!host && Array.isArray(debuggerSites) && debuggerSites.includes(etld1(host));
}
