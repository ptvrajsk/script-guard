// Per-tab list of the scripts a page loaded, reported by src/content/collector.js from every frame.
// Kept in chrome.storage.session so it survives service-worker restarts. Everything a page sends is
// untrusted: it is re-validated and bounded here. Pure helpers first, chrome.* adapters at the bottom.
import { etld1, normalizeHost } from '../shared/sites.js';
import { matchingBlocks, loadBlocks, isExtensionPage } from './userblocks.js';

export const MAX_SCRIPTS = 300;      // distinct script URLs kept per tab
export const MAX_FRAMES = 50;        // frames whose inline counts are remembered per tab
export const MAX_STR = 500;
const PREFIX = 'sg.ps.';

/** Validate and bound one script URL from a page. Returns the URL string or ''. */
export function cleanUrl(u) {
  if (typeof u !== 'string' || u.length > MAX_STR) return '';
  let p;
  try { p = new URL(u); } catch { return ''; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return '';
  p.hash = '';
  return p.href.length > MAX_STR ? '' : p.href;
}

/** Turn an untrusted 'sg:scripts' message into a safe record, or null. */
export function sanitizeReport(msg) {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.scripts)) return null;
  const scripts = [];
  for (const s of msg.scripts.slice(0, MAX_SCRIPTS)) {
    if (!s || typeof s !== 'object') continue;
    const url = cleanUrl(s.url);
    if (url) scripts.push({ url, async: s.async === true, defer: s.defer === true });
  }
  const inline = Number.isFinite(msg.inline) ? Math.max(0, Math.min(10000, Math.floor(msg.inline))) : 0;
  return { frameUrl: typeof msg.frameUrl === 'string' ? msg.frameUrl.slice(0, MAX_STR) : '', scripts, inline };
}

export const emptyStore = () => ({ scripts: [], inline: {} });

/**
 * Merge one frame's report into a tab store (pure; returns a new store).
 * Scripts are de-duplicated by URL, flags are OR-ed, and the list stops growing at `cap`.
 * Inline counts are remembered per frame (latest report wins) and summed on read.
 */
export function mergeReport(store, report, frameId = 0, cap = MAX_SCRIPTS) {
  const base = store && Array.isArray(store.scripts) ? store : emptyStore();
  const scripts = base.scripts.map((s) => ({ ...s }));
  const index = new Map(scripts.map((s, i) => [s.url, i]));
  for (const s of report.scripts) {
    const i = index.get(s.url);
    if (i !== undefined) {
      scripts[i].async = scripts[i].async || s.async;
      scripts[i].defer = scripts[i].defer || s.defer;
    } else if (scripts.length < cap) {
      index.set(s.url, scripts.length);
      scripts.push({ url: s.url, async: s.async, defer: s.defer });
    }
  }
  const inline = { ...(base.inline || {}) };
  const key = String(frameId);
  if (key in inline || Object.keys(inline).length < MAX_FRAMES) inline[key] = report.inline;
  return { scripts, inline };
}

/** True when the script's registrable domain differs from the page's. */
export function isThirdParty(scriptHost, topHost) {
  const a = etld1(scriptHost), b = etld1(topHost);
  return !!a && !!b && a !== b;
}

/** Split a URL into display parts. */
export function describe(url) {
  const u = new URL(url);
  return { host: normalizeHost(u.hostname), path: (u.pathname + u.search) || '/' };
}

/**
 * Pure: store + top-level URL + blocks -> the view the popup shows.
 * Third-party scripts come first; order within each group is the order they were reported.
 */
export function buildView(store, topUrl, blocks) {
  let topHost = '';
  try { topHost = normalizeHost(new URL(topUrl).hostname); } catch { /* unknown top page */ }
  const rows = ((store && store.scripts) || []).map((s) => {
    const { host, path } = describe(s.url);
    const matching = matchingBlocks(s.url, blocks);
    return { url: s.url, host, path, thirdParty: isThirdParty(host, topHost), blocked: matching.length > 0, blockIds: matching.map((b) => b.id) };
  });
  const scripts = [...rows.filter((r) => r.thirdParty), ...rows.filter((r) => !r.thirdParty)];
  const inline = Object.values((store && store.inline) || {}).reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
  return { scripts, inline };
}

/** Sender checks. Content scripts have sender.tab and a web-page url; extension pages have our own origin. */
export const fromContentScript = (sender, extId) => !!(sender && sender.tab && Number.isInteger(sender.tab.id) && sender.id === extId && !isExtensionPage(sender, extId));
export const fromExtensionPage = isExtensionPage;

/* ---------- chrome.* adapters ---------- */
const keyFor = (tabId) => PREFIX + tabId;
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

export function recordReport(tabId, frameId, msg) {
  const report = sanitizeReport(msg);
  if (!report) return Promise.resolve();
  return serial(async () => {
    const key = keyFor(tabId);
    const cur = (await chrome.storage.session.get(key))[key];
    await chrome.storage.session.set({ [key]: mergeReport(cur, report, frameId) });
  });
}
export const clearTab = (tabId) => serial(() => chrome.storage.session.remove(keyFor(tabId)));

export async function getScripts(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return { scripts: [], inline: 0 };
  const key = keyFor(tabId);
  const [stored, blocks] = await Promise.all([chrome.storage.session.get(key), loadBlocks()]);
  let topUrl = '';
  try { topUrl = (await chrome.tabs.get(tabId)).url || ''; } catch { /* tab gone */ }
  return buildView(stored[key], topUrl, blocks);
}

export function handleMessage(msg, sender, extId) {
  if (!msg || (msg.type !== 'sg:scripts' && msg.type !== 'sg:getScripts')) return null;
  if (msg.type === 'sg:scripts') {
    if (!fromContentScript(sender, extId)) return Promise.resolve({ error: 'not allowed' });
    return recordReport(sender.tab.id, Number.isInteger(sender.frameId) ? sender.frameId : 0, msg).then(() => ({ ok: true }), () => ({ ok: false }));
  }
  if (!fromExtensionPage(sender, extId)) return Promise.resolve({ error: 'not allowed' });
  return getScripts(Number(msg.tabId)).catch(() => ({ scripts: [], inline: 0 }));
}

export function init() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const p = handleMessage(msg, sender, chrome.runtime.id);
    if (!p) return false;
    p.then(sendResponse);
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => { clearTab(tabId).catch(() => {}); });
  // A new top-level load (including a reload) starts a fresh list; the collector reports again as the page loads.
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') clearTab(tabId).catch(() => {}); });
}
