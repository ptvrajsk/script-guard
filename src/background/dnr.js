// Declarative Net Request rule builder (pure) and applier.
// Id ranges: 1-999 response headers, 1000-1999 download navigation blocks, 2000+ known-bad hosts.
import { KEYS, DEFAULT_SETTINGS, validateSettings, isValidHost } from '../shared/schema.js';
import { normalizeHost } from '../shared/sites.js';
import { DNR_BLOCK_EXTS } from './downloads.js';

export const PERMISSIONS_POLICY_DENY = [
  'usb', 'hid', 'serial', 'midi', 'payment', 'display-capture', 'idle-detection',
  'xr-spatial-tracking', 'local-fonts', 'window-management'
].map(f => `${f}=()`).join(', ');
export const STRICT_CSP_REPORT_ONLY = "script-src 'self' https:; object-src 'none'; base-uri 'self'";
export const ID = { ppDefault: 1, ppStrict: 2, cspStrict: 3, dlStrict: 1000, badHostBase: 2000 };
export const MAX_BAD_HOSTS = 20000; // ids 2000..21999
// Rules at or above this id belong to userblocks.js. sync() must neither diff against nor remove them.
export const USER_RULE_ID_BASE = 100000;

/**
 * Scope a rule to one profile. Returns a condition fragment, or null when no site can have this profile.
 * If the profile is the global default, the rule is catch-all minus sites that override it;
 * otherwise it targets only the registrable domains explicitly set to this profile.
 * Domains match the domain and its subdomains (never substrings).
 */
function scope(settings, profile, key) {
  const entries = Object.entries(settings.siteProfiles || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (settings.defaultProfile === profile) {
    const others = entries.filter(([, p]) => p !== profile).map(([d]) => d);
    return others.length ? { ['excluded' + key[0].toUpperCase() + key.slice(1)]: others } : {};
  }
  const mine = entries.filter(([, p]) => p === profile).map(([d]) => d);
  return mine.length ? { [key]: mine } : null;
}

function headerRule(id, profile, settings, header, value) {
  const sc = scope(settings, profile, 'requestDomains');
  if (!sc) return null;
  return {
    id, priority: 1,
    action: { type: 'modifyHeaders', responseHeaders: [{ header, operation: 'append', value }] },
    condition: { ...sc, resourceTypes: ['main_frame', 'sub_frame'] }
  };
}

export function buildRules(settings, hostlists) {
  const s = settings || DEFAULT_SETTINGS;
  const rules = [];
  const push = r => { if (r) rules.push(r); };

  push(headerRule(ID.ppDefault, 'default', s, 'Permissions-Policy', PERMISSIONS_POLICY_DENY));
  push(headerRule(ID.ppStrict, 'strict', s, 'Permissions-Policy', PERMISSIONS_POLICY_DENY));
  push(headerRule(ID.cspStrict, 'strict', s, 'Content-Security-Policy-Report-Only', STRICT_CSP_REPORT_ONLY));

  // Strict: block navigations/frames pointing straight at executable files, scoped by the initiating site.
  const dl = scope(s, 'strict', 'initiatorDomains');
  if (dl) {
    rules.push({
      id: ID.dlStrict, priority: 1,
      action: { type: 'block' },
      condition: {
        ...dl,
        regexFilter: `^https?://[^/]+/[^?#]*\\.(${DNR_BLOCK_EXTS.join('|')})([?#]|$)`,
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame', 'sub_frame']
      }
    });
  }

  const allow = new Set(((s.allowlists && s.allowlists.scriptHosts) || []).map(normalizeHost));
  const bad = [...new Set(((hostlists && hostlists.badHosts) || []).map(normalizeHost))]
    .filter(h => isValidHost(h) && h.includes('.') && !allow.has(h))
    .sort().slice(0, MAX_BAD_HOSTS);
  bad.forEach((host, i) => rules.push({
    id: ID.badHostBase + i, priority: 2,
    action: { type: 'block' },
    condition: { requestDomains: [host] } // all resource types except main_frame
  }));
  return rules;
}

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** Compute the minimal update between existing and desired rule sets. Pure. */
export function diffRules(existing, desired) {
  const have = new Map(existing.map(r => [r.id, canon(r)]));
  const want = new Map(desired.map(r => [r.id, canon(r)]));
  const removeRuleIds = existing.filter(r => !want.has(r.id) || want.get(r.id) !== have.get(r.id)).map(r => r.id);
  const addRules = desired.filter(r => !have.has(r.id) || have.get(r.id) !== want.get(r.id));
  return { removeRuleIds, addRules };
}

async function loadBundledHostlist() {
  try {
    const res = await fetch(chrome.runtime.getURL('data/badhosts.json'));
    const j = await res.json();
    return Array.isArray(j.badHosts) ? j : { badHosts: [] };
  } catch { return { badHosts: [] }; }
}

export async function loadHostlists() {
  const bundled = await loadBundledHostlist();
  let stored = {};
  try { stored = (await chrome.storage.local.get(KEYS.hostlists))[KEYS.hostlists] || {}; } catch { /* ignore */ }
  const extra = Array.isArray(stored.badHosts) ? stored.badHosts.filter(h => typeof h === 'string') : [];
  return { badHosts: [...new Set([...bundled.badHosts, ...extra])], updatedAt: stored.updatedAt || bundled.updatedAt };
}

let chain = Promise.resolve();
/** Apply desired rules via updateDynamicRules. Serialized; safe to call repeatedly. */
export function sync() {
  const run = async () => {
    let settings = DEFAULT_SETTINGS;
    try {
      const r = await chrome.storage.local.get(KEYS.settings);
      if (r[KEYS.settings]) settings = validateSettings(r[KEYS.settings]).value;
    } catch { /* defaults */ }
    const desired = buildRules(settings, await loadHostlists());
    const existing = (await chrome.declarativeNetRequest.getDynamicRules()).filter(r => r.id < USER_RULE_ID_BASE);
    const diff = diffRules(existing, desired);
    if (diff.removeRuleIds.length || diff.addRules.length) await chrome.declarativeNetRequest.updateDynamicRules(diff);
    return { added: diff.addRules.length, removed: diff.removeRuleIds.length, total: desired.length };
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** Register listeners and apply rules. Must be called synchronously at service-worker top level. */
export function init() {
  chrome.runtime.onInstalled.addListener(async () => {
    try {
      const cur = (await chrome.storage.local.get([KEYS.settings, KEYS.hostlists]));
      const seed = {};
      if (!cur[KEYS.settings]) seed[KEYS.settings] = structuredClone(DEFAULT_SETTINGS);
      if (!cur[KEYS.hostlists]) { const b = await loadBundledHostlist(); seed[KEYS.hostlists] = { badHosts: [], updatedAt: b.updatedAt }; }
      if (Object.keys(seed).length) await chrome.storage.local.set(seed);
    } catch { /* ignore */ }
    sync().catch(e => console.error('[sg] dnr sync failed', e));
  });
  chrome.runtime.onStartup.addListener(() => { sync().catch(e => console.error('[sg] dnr sync failed', e)); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[KEYS.settings] || changes[KEYS.hostlists])) sync().catch(e => console.error('[sg] dnr sync failed', e));
  });
  // Idempotent: re-applies on every worker start (covers dropped rules).
  sync().catch(e => console.error('[sg] dnr sync failed', e));
}
