// User-chosen blocks for scripts and hosts, stored in chrome.storage.local under 'sg.blocks'.
// Pure logic (validation, rule building, matching) is separate from the chrome.* adapters at the bottom.
// DNR ids: blocks use USER_RULE_ID_BASE (100000) and up. dnr.js owns everything below that and ignores
// ids at or above it, so the two syncs never delete each other's rules. (Known-bad hosts can reach
// id 21999, so the 5000-range originally suggested would collide.)
import { isValidHost } from '../shared/schema.js';
import { normalizeHost } from '../shared/sites.js';
import { USER_RULE_ID_BASE, diffRules } from './dnr.js';

export const BLOCKS_KEY = 'sg.blocks';
export const MAX_BLOCKS = 500;
export const MAX_URL_LEN = 500;
// Everything except main_frame: a block must never be able to stop a page itself from loading.
export const BLOCK_TYPES = ['script', 'sub_frame', 'xmlhttprequest', 'image', 'ping', 'other', 'websocket', 'stylesheet', 'font', 'media'];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Escape text for use inside an RE2 regular expression. */
export function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Canonical form of an http(s) URL for blocking: no fragment. Returns '' if not usable. */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LEN * 2) return '';
  let u;
  try { u = new URL(raw.trim()); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.username || u.password) return '';
  u.hash = '';
  const s = u.href;
  return s.length > MAX_URL_LEN ? '' : s;
}

/** A hostname we are willing to block: a dotted name, an IPv4 address, or localhost. */
export function isBlockableHost(h) {
  if (!isValidHost(h)) return false;
  if (h === 'localhost') return true;
  if (IPV4.test(h)) return h.split('.').every((n) => Number(n) <= 255);
  return h.includes('.') && !/^\d+$/.test(h.split('.').pop());
}

/**
 * Validate a requested block. ctx: { extId, topUrl? }.
 * Returns { ok: true, kind, value } or { ok: false, error }.
 */
export function validateBlock(input, ctx = {}) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Nothing to block.' };
  const kind = input.kind;
  if (kind !== 'url' && kind !== 'host') return { ok: false, error: 'Choose a script address or a host.' };
  if (typeof input.value !== 'string' || !input.value.trim()) return { ok: false, error: 'Enter an address.' };
  const raw = input.value.trim();
  if (/^(chrome-extension|moz-extension|chrome|brave|about|data|blob|file|javascript):/i.test(raw)) {
    return { ok: false, error: 'Only http and https addresses can be blocked.' };
  }
  let topHost = '';
  let topHref = '';
  try { const t = new URL(ctx.topUrl); topHost = normalizeHost(t.hostname); topHref = normalizeUrl(t.href); } catch { /* no tab context */ }

  let value;
  if (kind === 'url') {
    value = normalizeUrl(raw);
    if (!value) return { ok: false, error: 'Enter a full http or https address.' };
    if (ctx.extId && new URL(value).hostname === ctx.extId) return { ok: false, error: 'That is Script Guard itself.' };
    if (topHref && value === topHref) return { ok: false, error: 'That is the page you are on. Blocking it would break the site.' };
  } else {
    let h;
    try { h = normalizeHost(new URL(raw.includes('://') ? raw : 'https://' + raw).hostname); } catch { h = ''; }
    if (!h) return { ok: false, error: 'Enter a host such as ads.example.com.' };
    if (ctx.extId && h === String(ctx.extId).toLowerCase()) return { ok: false, error: 'That is Script Guard itself.' };
    if (!isBlockableHost(h)) return { ok: false, error: 'Enter a host such as ads.example.com.' };
    value = h;
  }
  // A host block covers subdomains, so blocking the site you are on (or a parent of it) would break it.
  if (kind === 'host' && topHost && (topHost === value || topHost.endsWith('.' + value))) {
    return { ok: false, error: 'That is the site you are on. Blocking it would break the page.' };
  }
  return { ok: true, kind, value };
}

/** Add a block to a list (pure). Returns { blocks, added, error? }; duplicates are ignored. */
export function addBlock(blocks, v, now = Date.now(), id = null) {
  const list = Array.isArray(blocks) ? blocks : [];
  const dupe = list.find((b) => b.kind === v.kind && b.value === v.value);
  if (dupe) return { blocks: list, added: dupe, duplicate: true };
  if (list.length >= MAX_BLOCKS) return { blocks: list, error: `You can have at most ${MAX_BLOCKS} blocks.` };
  const block = { id: id || `b${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, kind: v.kind, value: v.value, createdAt: now };
  return { blocks: [...list, block], added: block };
}

/** Drop malformed entries from stored data. */
export function sanitizeBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const b of raw) {
    if (!b || typeof b !== 'object' || typeof b.id !== 'string' || typeof b.value !== 'string') continue;
    const v = validateBlock({ kind: b.kind, value: b.value });
    if (!v.ok || v.value !== b.value) continue;
    const key = b.kind + '|' + b.value;
    if (seen.has(key) || seen.has('id|' + b.id)) continue;
    seen.add(key); seen.add('id|' + b.id);
    out.push({ id: b.id.slice(0, 40), kind: b.kind, value: b.value, createdAt: Number.isFinite(b.createdAt) ? b.createdAt : 0 });
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}

/** The DNR condition for one exact-URL block. */
export function urlCondition(url) {
  const hasQuery = url.includes('?');
  const base = { isUrlFilterCaseSensitive: true, resourceTypes: BLOCK_TYPES };
  // `*`, `^` and `|` cannot be escaped in a urlFilter, so URLs containing them use an escaped regexFilter.
  if (/[*^|]/.test(url)) {
    return { ...base, regexFilter: '^' + escapeRegex(url) + (hasQuery ? '$' : '(\\?[^#]*)?$') };
  }
  // With a query string: exact match. Without: that URL, plus the same path with any cache-busting query
  // (`^` matches the end of the URL or a separator such as `?`).
  return { ...base, urlFilter: '|' + url + (hasQuery ? '|' : '^') };
}

/** Pure: blocks -> DNR rules with ids from USER_RULE_ID_BASE upward. */
export function buildBlockRules(blocks) {
  return sanitizeBlocks(blocks).map((b, i) => ({
    id: USER_RULE_ID_BASE + i,
    priority: 3,
    action: { type: 'block' },
    condition: b.kind === 'host'
      ? { requestDomains: [b.value], resourceTypes: BLOCK_TYPES }
      : urlCondition(b.value),
  }));
}

/** The blocks a script URL matches. Pure; mirrors the DNR rules for display. */
export function matchingBlocks(url, blocks) {
  const norm = normalizeUrl(url);
  if (!norm) return [];
  const host = normalizeHost(new URL(norm).hostname);
  const noQuery = norm.split('?')[0];
  return (blocks || []).filter((b) => (b.kind === 'host'
    ? host === b.value || host.endsWith('.' + b.value)
    : norm === b.value || (!b.value.includes('?') && noQuery === b.value)));
}
export const isBlockedUrl = (url, blocks) => matchingBlocks(url, blocks).length > 0;

/**
 * True only for pages of this extension (popup, or the options page, which may live in a tab).
 * A content script has sender.id === our id too, but its sender.url is the web page's address.
 */
export function isExtensionPage(sender, extId) {
  return !!(sender && extId && sender.id === extId && typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${extId}/`));
}

/* ---------- chrome.* adapters ---------- */
export async function loadBlocks() {
  try { return sanitizeBlocks((await chrome.storage.local.get(BLOCKS_KEY))[BLOCKS_KEY]); } catch { return []; }
}

let chain = Promise.resolve();
/** Apply stored blocks to DNR. Only touches ids >= USER_RULE_ID_BASE. Serialised. */
export function sync() {
  const run = async () => {
    const desired = buildBlockRules(await loadBlocks());
    const existing = (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.id >= USER_RULE_ID_BASE);
    const diff = diffRules(existing, desired);
    if (diff.removeRuleIds.length || diff.addRules.length) await chrome.declarativeNetRequest.updateDynamicRules(diff);
    return { total: desired.length };
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

async function topUrlFor(tabId) {
  if (!Number.isInteger(tabId)) return '';
  try { return (await chrome.tabs.get(tabId)).url || ''; } catch { return ''; }
}

/** Handle a message from an extension page. Returns a promise of the response, or null if not ours. */
export function handleMessage(msg, sender, extId) {
  if (!msg || typeof msg.type !== 'string' || !['sg:block', 'sg:unblock', 'sg:getBlocks'].includes(msg.type)) return null;
  if (!isExtensionPage(sender, extId)) return Promise.resolve({ error: 'not allowed' });
  return (async () => {
    const blocks = await loadBlocks();
    if (msg.type === 'sg:getBlocks') return { blocks };
    if (msg.type === 'sg:unblock') {
      const next = blocks.filter((b) => b.id !== msg.id);
      if (next.length !== blocks.length) await chrome.storage.local.set({ [BLOCKS_KEY]: next }); // storage listener syncs
      await sync();
      return { ok: true, blocks: next };
    }
    const v = validateBlock(msg, { extId, topUrl: await topUrlFor(msg.tabId) });
    if (!v.ok) return { error: v.error };
    const r = addBlock(blocks, v);
    if (r.error) return { error: r.error };
    if (!r.duplicate) await chrome.storage.local.set({ [BLOCKS_KEY]: r.blocks });
    await sync(); // apply before replying so a reload straight afterwards is already covered
    return { ok: true, block: r.added, blocks: r.blocks };
  })().catch((e) => ({ error: String((e && e.message) || e) }));
}

/** Register listeners. Call synchronously at service-worker top level. */
export function init() {
  const run = () => sync().catch((e) => console.error('[sg] block sync failed', e));
  chrome.runtime.onInstalled.addListener(run);
  chrome.runtime.onStartup.addListener(run);
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch[BLOCKS_KEY]) run(); });
  run();
}
