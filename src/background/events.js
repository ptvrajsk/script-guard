// Per-tab event ring buffer, badge counter and runtime message handling.
// The store is pure (testable); chrome.* use is confined to the adapter functions below.
import { KEYS, DEFAULT_SETTINGS, validateSettings, profileFor, hooksFor } from '../shared/schema.js';

export const MAX_EVENTS = 200;
export const MAX_PER_KIND = 40; // a flood of one kind can never evict evidence of other kinds
export const SESSION_TAB = -1; // events not attributable to a tab (e.g. downloads)
export const KINDS = new Set([
  'clipboard.write', 'clipboard.risky', 'download.auto', 'eval', 'function-ctor', 'timer-string',
  'document.write', 'websocket', 'wasm', 'file-picker', 'notification-request', 'window.open',
  'script-insert', 'worker', 'protocol-handler',
  'script.scored', 'script.patched', 'script.stale', // debugger tier (Agent C)
  'download.gate' // download gate decisions (downloads.js)
]);
const ACTIONS = new Set(['allowed', 'logged', 'blocked']);
const MAX_STR = 200;

function clip(v, depth = 0) {
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (depth > 2) return undefined;
  if (Array.isArray(v)) return v.slice(0, 20).map(x => clip(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 20)) { const c = clip(v[k], depth + 1); if (c !== undefined) out[k.slice(0, 40)] = c; }
    return out;
  }
  return undefined;
}

/** Trusted URLs of a message sender: the frame that really sent it and the tab it lives in. Never page-supplied. */
export function senderMeta(sender) {
  return {
    frameUrl: sender && typeof sender.url === 'string' ? sender.url : '',
    tabUrl: sender && sender.tab && typeof sender.tab.url === 'string' ? sender.tab.url : ''
  };
}

/**
 * Normalize an incoming event into a safe, bounded record, or null if invalid.
 * `meta` ({frameUrl, tabUrl}) comes from the sender or from trusted extension code; any frameUrl/tabUrl
 * field inside `evt` itself is page-controlled and is ignored.
 */
export function sanitizeEvent(evt, now = Date.now(), meta = {}) {
  if (!evt || typeof evt !== 'object' || typeof evt.kind !== 'string' || !KINDS.has(evt.kind)) return null;
  const detail = clip(evt.detail && typeof evt.detail === 'object' ? evt.detail : {}) || {};
  return {
    kind: evt.kind,
    detail,
    action: ACTIONS.has(evt.action) ? evt.action : 'logged',
    frameUrl: meta && typeof meta.frameUrl === 'string' ? meta.frameUrl.slice(0, 300) : '',
    tabUrl: meta && typeof meta.tabUrl === 'string' ? meta.tabUrl.slice(0, 300) : '',
    t: Number.isFinite(evt.t) ? evt.t : now,
    recv: now
  };
}

export function createStore(max = MAX_EVENTS, perKind = MAX_PER_KIND) {
  const tabs = new Map();
  return {
    record(tabId, evt, now, meta) {
      const e = sanitizeEvent(evt, now, meta);
      if (!e) return null;
      let arr = tabs.get(tabId);
      if (!arr) tabs.set(tabId, (arr = []));
      arr.push(e);
      let same = 0;
      for (const x of arr) if (x.kind === e.kind) same++;
      if (same > perKind) arr.splice(arr.findIndex(x => x.kind === e.kind), 1); // drop the oldest of this kind only
      if (arr.length > max) arr.splice(0, arr.length - max);
      return e;
    },
    get: tabId => (tabs.get(tabId) || []).slice(),
    clear: tabId => tabs.delete(tabId),
    count: tabId => (tabs.get(tabId) || []).filter(e => e.action !== 'allowed').length,
    blocked: tabId => (tabs.get(tabId) || []).filter(e => e.action === 'blocked').length,
    dump: () => Object.fromEntries(tabs),
    load(obj) { for (const [k, v] of Object.entries(obj || {})) if (Array.isArray(v)) tabs.set(Number(k), v.slice(-max)); }
  };
}

const store = createStore();
let loaded = null;
let saveTimer = null;

const hasChrome = () => typeof chrome !== 'undefined' && chrome.runtime;

function ensureLoaded() {
  if (!loaded) loaded = (async () => {
    try {
      const r = await chrome.storage.session.get('sg.events');
      store.load(r['sg.events']);
    } catch { /* storage.session unavailable: memory only */ }
  })();
  return loaded;
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await chrome.storage.session.set({ 'sg.events': store.dump() }); } catch { /* ignore */ }
  }, 500);
}
const DEFAULT_TITLE = 'Script Guard';
export const NOTICE_MIN_GAP_MS = 1000;

/** Toolbar title for a tab with n blocked events. */
export function badgeTitle(n) { return n ? `${DEFAULT_TITLE}: ${n} blocked on this tab` : DEFAULT_TITLE; }
export function badgeLabel(n) { return n ? (n > 99 ? '99+' : String(n)) : ''; }

/** Pure per-key rate limiter: allow(key, now) is true at most once per minGap ms for each key. */
export function createLimiter(minGap = NOTICE_MIN_GAP_MS) {
  const last = new Map();
  return {
    allow(key, now = Date.now()) {
      const t = last.get(key);
      if (t !== undefined && now - t < minGap) return false;
      last.set(key, now);
      return true;
    },
    reset: key => { last.delete(key); }
  };
}
const noticeLimiter = createLimiter();

async function updateBadge(tabId) {
  if (tabId < 0) return;
  try {
    const n = store.blocked(tabId);
    await chrome.action.setBadgeText({ tabId, text: badgeLabel(n) });
    if (n) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b3261e' }); // white on this red is ~6.5:1
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    }
    await chrome.action.setTitle({ tabId, title: badgeTitle(n) });
  } catch { /* tab gone */ }
}

async function notifyTab(tabId, e) {
  if (tabId < 0 || e.action !== 'blocked' || !noticeLimiter.allow(tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'sg:notice', kind: e.kind, action: 'blocked', count: store.blocked(tabId) }, { frameId: 0 });
  } catch { /* no listener in the top frame (restricted page, trusted site, still loading) */ }
}

export async function recordEvent(tabId, evt, meta = {}) {
  if (!hasChrome()) return store.record(tabId, evt, undefined, meta);
  await ensureLoaded();
  const e = store.record(tabId, evt, undefined, meta);
  if (e) { scheduleSave(); await updateBadge(tabId); await notifyTab(tabId, e); }
  return e;
}
export async function getEvents(tabId) { if (hasChrome()) await ensureLoaded(); return store.get(tabId); }
export async function clearEvents(tabId) {
  if (hasChrome()) await ensureLoaded();
  store.clear(tabId); noticeLimiter.reset(tabId); scheduleSave();
  if (hasChrome()) await updateBadge(tabId); // count is 0 now, so this clears the badge
}
/** Recent events of a kind whose frameUrl shares an origin with `origin` (any tab). */
/** frameUrl on stored events always comes from the sender (see senderMeta), never from the page payload. */
export function recentEvents(kind, sinceMs, origin, now = Date.now()) {
  const out = [];
  if (!origin || origin === 'null') return out; // no usable origin: match nothing, never everything
  for (const arr of Object.values(store.dump())) for (const e of arr) {
    if (e.kind !== kind || now - e.recv > sinceMs) continue;
    let o = ''; try { o = new URL(e.frameUrl).origin; } catch { /* ignore */ }
    if (o === origin) out.push(e);
  }
  return out;
}

export async function loadSettings() {
  try {
    const r = await chrome.storage.local.get(KEYS.settings);
    if (r[KEYS.settings]) return validateSettings(r[KEYS.settings]).value;
  } catch { /* fall through */ }
  return structuredClone(DEFAULT_SETTINGS);
}

const HANDLED = new Set(['sg:event', 'sg:getConfig', 'sg:getEvents', 'sg:clearEvents']);

/** Handler for runtime messages; returns a response object or undefined. */
export async function handleMessage(msg, sender, selfId) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return undefined;
  if (selfId && sender && sender.id && sender.id !== selfId) return undefined; // ignore other extensions
  switch (msg.type) {
    case 'sg:event': {
      const tabId = sender && sender.tab ? sender.tab.id : undefined;
      if (typeof tabId !== 'number') return { ok: false };
      const e = await recordEvent(tabId, msg, senderMeta(sender));
      return { ok: !!e };
    }
    case 'sg:getConfig': {
      const host = typeof msg.hostname === 'string' ? msg.hostname.slice(0, 253) : '';
      const settings = await loadSettings();
      const profile = profileFor(settings, host);
      return { profile, hooks: hooksFor(settings, profile) };
    }
    case 'sg:getEvents': return { events: await getEvents(Number(msg.tabId)) };
    case 'sg:clearEvents': await clearEvents(Number(msg.tabId)); return { ok: true };
    default: return undefined;
  }
}

/** Register listeners. Must be called synchronously at service-worker top level. */
export function init() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handleMessage(msg, sender, chrome.runtime.id).then(
      r => { if (r !== undefined) sendResponse(r); },
      () => sendResponse({ ok: false })
    );
    return !!(msg && HANDLED.has(msg.type)); // keep channel open for async response
  });
  chrome.tabs.onRemoved.addListener(tabId => { clearEvents(tabId); });
  // New top-level navigation: start a fresh list for that tab.
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' && info.url) clearEvents(tabId); });
}
