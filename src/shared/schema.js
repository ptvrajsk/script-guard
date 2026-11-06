// Storage schema, profiles and per-profile hook defaults. Pure, no chrome.* usage.
import { etld1, normalizeHost } from './sites.js';

export const PROFILES = ['trusted', 'default', 'strict'];
export const HOOK_MODES = ['off', 'log', 'warn', 'block'];

// Hook names (settings.hooks keys). Mapping to event kinds is in hooks.js.
export const HOOK_NAMES = [
  'clipboard', 'download', 'function', 'timer', 'documentWrite', 'websocket',
  'wasm', 'filePicker', 'notification', 'windowOpen', 'scriptInsert', 'worker', 'protocolHandler'
];

export const KEYS = { settings: 'sg.settings', rules: 'sg.rules', hostlists: 'sg.hostlists' };

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  defaultProfile: 'default',
  siteProfiles: {},
  debuggerSites: [],
  allowlists: { scriptHosts: [] },
  hooks: {}
});

function allHooks(mode) { return Object.fromEntries(HOOK_NAMES.map(n => [n, mode])); }

/** Built-in hook modes per profile. 'clipboard: block' means block risky writes only. */
export const PROFILE_HOOKS = Object.freeze({
  trusted: Object.freeze(allHooks('off')),
  default: Object.freeze({ ...allHooks('log'), clipboard: 'block', download: 'warn' }),
  strict: Object.freeze({
    ...allHooks('log'), clipboard: 'block', download: 'block',
    function: 'warn', documentWrite: 'warn', websocket: 'warn', wasm: 'warn'
  })
});

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
/** A real dotted-quad IPv4 literal: four decimal octets, each 0-255, no leading zeros. */
export function isIPv4(h) {
  if (typeof h !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every(o => Number(o) <= 255 && (o === '0' || o[0] !== '0'));
}
/** Valid hostname (letters, digits, hyphen, underscore labels) or a real IPv4 literal. Anything else is rejected. */
export function isValidHost(h) {
  if (typeof h !== 'string' || !HOST_RE.test(h)) return false;
  const last = h.slice(h.lastIndexOf('.') + 1);
  if (/^\d+$/.test(last)) return isIPv4(h); // numeric final label: must be a genuine IPv4 literal (rejects 999.999.999.999, 1.2.3)
  return true;
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate and normalize a settings object. Invalid parts are dropped from `value`
 * and described in `errors`. `ok` is true only when there are no errors.
 */
export function validateSettings(obj) {
  const errors = [];
  const value = structuredClone(DEFAULT_SETTINGS);
  if (!isObj(obj)) return { ok: false, errors: ['settings must be an object'], value };

  if (obj.version !== undefined && obj.version !== 1) errors.push(`unsupported version ${obj.version}`);

  if (obj.defaultProfile !== undefined) {
    if (PROFILES.includes(obj.defaultProfile)) value.defaultProfile = obj.defaultProfile;
    else errors.push(`defaultProfile must be one of ${PROFILES.join(', ')}`);
  }

  if (obj.siteProfiles !== undefined) {
    if (!isObj(obj.siteProfiles)) errors.push('siteProfiles must be an object');
    else for (const [k, v] of Object.entries(obj.siteProfiles)) {
      const host = normalizeHost(k);
      if (!isValidHost(host)) errors.push(`siteProfiles: invalid host "${k}"`);
      else if (!PROFILES.includes(v)) errors.push(`siteProfiles["${k}"]: invalid profile`);
      else value.siteProfiles[etld1(host)] = v;
    }
  }

  const hostArray = (arr, label) => {
    if (!Array.isArray(arr)) { errors.push(`${label} must be an array`); return []; }
    const out = [];
    for (const h of arr) {
      const n = normalizeHost(h);
      if (isValidHost(n)) { if (!out.includes(n)) out.push(n); } else errors.push(`${label}: invalid host "${String(h).slice(0, 60)}"`);
    }
    return out;
  };
  if (obj.debuggerSites !== undefined) value.debuggerSites = hostArray(obj.debuggerSites, 'debuggerSites').map(etld1);

  if (obj.allowlists !== undefined) {
    if (!isObj(obj.allowlists)) errors.push('allowlists must be an object');
    else if (obj.allowlists.scriptHosts !== undefined) value.allowlists.scriptHosts = hostArray(obj.allowlists.scriptHosts, 'allowlists.scriptHosts');
  }

  if (obj.hooks !== undefined) {
    if (!isObj(obj.hooks)) errors.push('hooks must be an object');
    else for (const [k, v] of Object.entries(obj.hooks)) {
      if (!HOOK_NAMES.includes(k)) errors.push(`hooks: unknown hook "${k}"`);
      else if (!HOOK_MODES.includes(v)) errors.push(`hooks.${k}: invalid mode`);
      else value.hooks[k] = v;
    }
  }
  return { ok: errors.length === 0, errors, value };
}

/** Profile for a hostname: exact registrable-domain match, else settings.defaultProfile. */
export function profileFor(settings, hostname) {
  const s = settings || DEFAULT_SETTINGS;
  const site = etld1(hostname);
  const p = site && s.siteProfiles && Object.hasOwn(s.siteProfiles, site) ? s.siteProfiles[site] : s.defaultProfile;
  return PROFILES.includes(p) ? p : 'default';
}

/** Effective hook modes for a profile (user overrides apply except in trusted). */
export function hooksFor(settings, profile) {
  const base = { ...(PROFILE_HOOKS[profile] || PROFILE_HOOKS.default) };
  if (profile !== 'trusted' && settings && isObj(settings.hooks)) {
    for (const [k, v] of Object.entries(settings.hooks)) if (HOOK_NAMES.includes(k) && HOOK_MODES.includes(v)) base[k] = v;
  }
  return base;
}
