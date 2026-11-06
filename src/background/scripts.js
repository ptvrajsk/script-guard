// Note: the scripting API has no matchAboutBlank; matchOriginAsFallback is what covers about:blank/srcdoc frames.
// Registers the page hooks and relay as dynamic content scripts so Trusted sites can be excluded
// from injection entirely. (A page can forge the relay->page config message, so "off" must never be
// something the page can be talked into: if the scripts are not injected, there is nothing to switch off.)
import { KEYS, DEFAULT_SETTINGS, validateSettings, isValidHost, isIPv4 } from '../shared/schema.js';

export const SCRIPT_IDS = ['sg-hooks', 'sg-relay', 'sg-notice', 'sg-collector'];

const FILES = {
  'sg-hooks': { js: ['src/content/hooks.js'], world: 'MAIN' },
  'sg-relay': { js: ['src/content/relay.js'], world: 'ISOLATED' },
  'sg-notice': { js: ['src/content/notice.js'], world: 'ISOLATED' },
  'sg-collector': { js: ['src/content/collector.js'], world: 'ISOLATED' },
};

/** True for the only pattern shapes this module generates, with a strictly valid host. */
export function isValidMatchPattern(p) {
  if (p === '<all_urls>') return true;
  const m = typeof p === 'string' ? /^\*:\/\/(\*\.)?([^/*]+)\/\*$/.exec(p) : null;
  if (!m) return false;
  const host = m[2];
  if (!isValidHost(host) || host.includes('_')) return false;
  if (isIPv4(host) && m[1]) return false; // no wildcard subdomains of an IP literal
  return true;
}

/** Match patterns covering a registrable domain and all its subdomains. Empty for an invalid host. */
export function sitePatterns(site) {
  const out = typeof site === 'string' && isValidHost(site) ? (isIPv4(site) ? [`*://${site}/*`] : [`*://${site}/*`, `*://*.${site}/*`]) : [];
  return out.filter(isValidMatchPattern);
}

/**
 * Pure: settings -> array of registerContentScripts entries (empty if nothing should be injected).
 * - default profile is guarded: inject everywhere except Trusted sites.
 * - default profile is Trusted: inject only on sites explicitly set to default/strict.
 */
export function buildRegistrations(settings) {
  const sites = (settings && settings.siteProfiles) || {};
  const trusted = Object.keys(sites).filter((s) => sites[s] === 'trusted');
  const guarded = Object.keys(sites).filter((s) => sites[s] !== 'trusted');
  let matches;
  let excludeMatches = [];
  if (settings && settings.defaultProfile === 'trusted') {
    matches = [...new Set(guarded.flatMap(sitePatterns))];
  } else {
    matches = ['<all_urls>'];
    excludeMatches = [...new Set(trusted.flatMap(sitePatterns))];
  }
  if (!matches.length) return [];
  return SCRIPT_IDS.map((id) => ({
    id,
    ...FILES[id],
    matches,
    ...(excludeMatches.length ? { excludeMatches } : {}),
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  }));
}

function fullRegistrations() {
  return SCRIPT_IDS.map((id) => ({
    id, ...FILES[id], matches: ['<all_urls>'], runAt: 'document_start', allFrames: true,
    matchOriginAsFallback: true, persistAcrossSessions: true,
  }));
}

/**
 * Replace the registered scripts with the ones for `settings`. Patterns are validated before anything is
 * touched. If registration fails for any reason, fall back to <all_urls> with NO exclusions (fail safe:
 * more protection, never none).
 */
export async function applySettings(scripting, settings, log = console.warn) {
  const regs = buildRegistrations(settings);
  const existing = await scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
  if (existing.length) await scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  try {
    if (regs.length) await scripting.registerContentScripts(regs);
  } catch (e) {
    log('[sg] registering content scripts failed, falling back to all sites with no exclusions:', e && e.message);
    try {
      const partial = await scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
      if (partial.length) await scripting.unregisterContentScripts({ ids: partial.map((s) => s.id) });
    } catch { /* ignore */ }
    await scripting.registerContentScripts(fullRegistrations());
    return { fallback: true };
  }
  return { fallback: false };
}

let chain = Promise.resolve();

/** Re-register scripts to match current settings. Calls are serialised. */
export function sync() {
  chain = chain.then(async () => {
    const stored = (await chrome.storage.local.get(KEYS.settings))[KEYS.settings];
    const v = validateSettings(stored || DEFAULT_SETTINGS);
    await applySettings(chrome.scripting, v.ok ? v.value : DEFAULT_SETTINGS);
  }).catch((e) => console.warn('[sg] content script sync failed:', e && e.message));
  return chain;
}

export function init() {
  chrome.runtime.onInstalled.addListener(() => { sync(); });
  chrome.runtime.onStartup.addListener(() => { sync(); });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch[KEYS.settings]) sync(); });
}
