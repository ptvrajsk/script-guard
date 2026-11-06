// Debugger tier: opt-in per tab. Intercepts script responses via CDP Fetch, scores them and applies
// user patch rules from sg.rules. Fails open on every error. All chrome.* use lives in
// createChromeAdapter(); createController(adapter) is pure logic and is what the unit tests drive.
//
// Adapter contract:
//   attach(tabId) -> Promise            detach(tabId) -> Promise
//   send({tabId, sessionId?}, method, params) -> Promise<result>
//   onEvent(fn(source, method, params)) onDetach(fn(tabId, reason)) onTabRemoved(fn(tabId)) onRulesChanged(fn())
//   getRules() -> Promise<Rule[]>       loadTabs() -> Promise<number[]>   saveTabs(number[]) -> Promise
//   keepAlive: { start(), stop() }      (called when pending requests go 0->n and n->0)

import { matchesPattern, applyRule, hashText, validateRule } from '../shared/patch.js';
import { scoreScript } from '../shared/scoring.js';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const BODY_TIMEOUT_MS = 20000;

const STRIP_HEADERS = /^(content-encoding|content-length|transfer-encoding)$/i;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function charsetOf(headers) {
  const ct = (headers || []).find((h) => h.name.toLowerCase() === 'content-type');
  const m = ct && /charset\s*=\s*"?([^";\s]+)/i.exec(ct.value);
  return m ? m[1].toLowerCase() : 'utf-8';
}
const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
const stripHash = (u) => { const i = u.indexOf('#'); return i === -1 ? u : u.slice(0, i); };

export function createController(adapter, { maxBodyBytes = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS } = {}) {
  const tabs = new Map();       // tabId -> { sessions: Set<sessionId|''>, pending: Set<token> }
  const inflight = new Set();   // promises, for whenIdle()
  let pendingCount = 0;
  let sink = () => {};
  let initialised = false;

  const emit = (kind, detail) => { try { sink({ kind, detail }); } catch { /* sink errors never affect page loads */ } };
  const persist = () => adapter.saveTabs([...tabs.keys()]).catch(() => {});

  function pendingDelta(d) {
    const before = pendingCount;
    pendingCount = Math.max(0, pendingCount + d);
    if (before === 0 && pendingCount > 0) adapter.keepAlive.start();
    if (before > 0 && pendingCount === 0) adapter.keepAlive.stop();
  }

  function dropTab(tabId) {
    const st = tabs.get(tabId);
    if (!st) return;
    pendingDelta(-st.pending.size); // Chrome resumes paused requests itself on detach
    tabs.delete(tabId);
    persist();
  }

  async function validRules() {
    let rules;
    try { rules = await adapter.getRules(); } catch { return []; }
    return (Array.isArray(rules) ? rules : []).filter((r) => r && r.enabled !== false && validateRule(r).ok);
  }

  function patternsFor(rules) {
    const p = [{ resourceType: 'Script', requestStage: 'Response' }];
    if (rules.some((r) => r.resourceType === 'Document')) p.push({ resourceType: 'Document', requestStage: 'Response' });
    return p;
  }

  async function enableFetch(target, rules) {
    await adapter.send(target, 'Fetch.enable', { patterns: patternsFor(rules) });
  }

  async function enableForTab(tabId) {
    if (tabs.has(tabId)) return true;
    try { await adapter.attach(tabId); } catch (e) {
      if (!/already attached/i.test(String(e && e.message))) throw e;
    }
    const st = { sessions: new Set(['']), pending: new Set() };
    tabs.set(tabId, st);
    try {
      const rules = await validRules();
      await adapter.send({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await enableFetch({ tabId }, rules);
    } catch (e) {
      tabs.delete(tabId);
      try { await adapter.detach(tabId); } catch { /* ignore */ }
      throw e;
    }
    persist();
    return true;
  }

  async function disableForTab(tabId) {
    if (!tabs.has(tabId)) return false;
    dropTab(tabId);
    try { await adapter.detach(tabId); } catch { /* already detached */ }
    return true;
  }

  const isEnabled = (tabId) => tabs.has(tabId);

  async function refreshPatterns() {
    const rules = await validRules();
    for (const [tabId, st] of tabs) {
      for (const sid of st.sessions) {
        try { await enableFetch(sid ? { tabId, sessionId: sid } : { tabId }, rules); } catch { /* session gone */ }
      }
    }
  }

  async function onAttachedToTarget(tabId, params) {
    const st = tabs.get(tabId);
    const sid = params && params.sessionId;
    if (!st || !sid) return;
    st.sessions.add(sid);
    const target = { tabId, sessionId: sid };
    try {
      const rules = await validRules();
      await adapter.send(target, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await enableFetch(target, rules);
    } catch { /* fail open: child runs unintercepted */ }
    finally {
      if (params.waitingForDebugger) { try { await adapter.send(target, 'Runtime.runIfWaitingForDebugger', {}); } catch { /* ignore */ } }
    }
  }

  async function handlePaused(source, p) {
    const tabId = source.tabId;
    const st = tabs.get(tabId);
    if (!st) return;
    const target = source.sessionId ? { tabId, sessionId: source.sessionId } : { tabId };
    const token = Symbol('req');
    st.pending.add(token);
    pendingDelta(1);
    const cont = async () => { try { await adapter.send(target, 'Fetch.continueResponse', { requestId: p.requestId }); } catch { /* request gone or detached */ } };
    try {
      await process(target, p, cont);
    } catch (e) {
      emit('script.stale', { tabId, url: safeUrl(p), error: String((e && e.message) || e), failOpen: true });
      await cont();
    } finally {
      if (st.pending.delete(token)) pendingDelta(-1);
    }
  }

  const safeUrl = (p) => stripHash((p && p.request && p.request.url) || '');

  async function process(target, p, cont) {
    const tabId = target.tabId;
    const url = safeUrl(p);
    const headers = p.responseHeaders || [];
    const status = p.responseStatusCode;
    // no body to patch: errors, redirects, empty responses
    if (p.responseErrorReason || status === undefined || (status >= 300 && status < 400) || status === 204 || status === 205 || status === 304) return cont();
    const clen = Number((headers.find((h) => h.name.toLowerCase() === 'content-length') || {}).value);
    if (clen > maxBodyBytes) { emit('script.scored', { tabId, url, skipped: 'oversize', bytes: clen }); return cont(); }

    const type = p.resourceType || 'Script';
    const rules = (await validRules()).filter((r) => (r.resourceType || 'Script') === type && matchesPattern(r.urlPattern, url));
    const wantsBlock = rules.some((r) => r.ops.some((o) => o.type === 'blockScript'));

    if (wantsBlock) {
      // blocking needs no body
      try {
        await adapter.send(target, 'Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
        emit('script.patched', { tabId, url, blocked: true, ruleIds: rules.filter((r) => r.ops.some((o) => o.type === 'blockScript')).map((r) => r.id) });
        return;
      } catch { return cont(); }
    }
    if (type !== 'Script' && rules.length === 0) return cont();

    const r = await withTimeout(adapter.send(target, 'Fetch.getResponseBody', { requestId: p.requestId }), timeoutMs);
    const rawBytes = r.base64Encoded ? b64ToBytes(r.body) : null;
    if ((rawBytes ? rawBytes.length : r.body.length) > maxBodyBytes) { emit('script.scored', { tabId, url, skipped: 'oversize' }); return cont(); }
    const charset = charsetOf(headers);
    const original = rawBytes ? new TextDecoder(charset).decode(rawBytes) : r.body; // throws on unknown charset -> fail open

    if (type === 'Script') {
      try {
        const { score, reasons } = scoreScript(original, { url, pageOrigin: (p.request && p.request.headers && (p.request.headers.Referer || p.request.headers.referer || p.request.headers.Origin)) || undefined });
        emit('script.scored', { tabId, url, score, reasons: reasons.map((x) => ({ id: x.id, weight: x.weight })), bytes: original.length });
      } catch { /* scoring is best effort */ }
    }
    if (rules.length === 0) return cont();

    let text = original;
    const appliedRules = [];
    let origHash = null;
    for (const rule of rules) {
      const res = applyRule(text, rule);
      let hashMismatch = false;
      if (rule.expectedHash) {
        origHash = origHash || await hashText(original);
        hashMismatch = origHash !== rule.expectedHash;
      }
      if (res.stale) {
        emit('script.stale', { tabId, url, ruleId: rule.id, skipped: res.skipped, hashMismatch });
        continue; // all-or-nothing per rule: a stale rule changes nothing
      }
      text = res.text;
      appliedRules.push({ id: rule.id, applied: res.applied.length, hashMismatch });
    }
    if (text === original) return cont();

    const out = (headers.filter((h) => !STRIP_HEADERS.test(h.name)).map((h) => (h.name.toLowerCase() === 'content-type' ? { name: h.name, value: h.value.replace(/;\s*charset\s*=\s*"?[^";\s]+"?/i, '') + '; charset=utf-8' } : h)));
    await adapter.send(target, 'Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: status,
      responseHeaders: out,
      body: bytesToB64(new TextEncoder().encode(text)),
    });
    emit('script.patched', { tabId, url, rules: appliedRules });
  }

  function onEvent(source, method, params) {
    if (!source || !tabs.has(source.tabId)) return;
    if (method === 'Fetch.requestPaused') {
      const pr = handlePaused(source, params);
      inflight.add(pr);
      pr.finally(() => inflight.delete(pr));
    } else if (method === 'Target.attachedToTarget') {
      const pr = onAttachedToTarget(source.tabId, params);
      inflight.add(pr);
      pr.finally(() => inflight.delete(pr));
    } else if (method === 'Target.detachedFromTarget') {
      const st = tabs.get(source.tabId);
      if (st && params && params.sessionId) st.sessions.delete(params.sessionId);
    }
  }

  async function init() {
    if (initialised) return;
    initialised = true;
    adapter.onEvent(onEvent);
    adapter.onDetach((tabId) => dropTab(tabId));
    adapter.onTabRemoved((tabId) => dropTab(tabId));
    adapter.onRulesChanged(() => { refreshPatterns().catch(() => {}); });
    // service worker restarts lose memory; re-adopt tabs that were enabled
    let saved = [];
    try { saved = await adapter.loadTabs(); } catch { /* ignore */ }
    for (const id of saved) { try { await enableForTab(id); } catch { /* tab gone or detached by user */ } }
    persist();
  }

  const whenIdle = async () => { while (inflight.size) await Promise.allSettled([...inflight]); };

  return {
    enableForTab, disableForTab, isEnabled, init, whenIdle,
    setEventSink(fn) { sink = typeof fn === 'function' ? fn : () => {}; },
    _pendingCount: () => pendingCount,
  };
}

// ---------- chrome.* adapter ----------
export function createChromeAdapter(c = globalThis.chrome) {
  let timer = null;
  return {
    attach: (tabId) => c.debugger.attach({ tabId }, '1.3'),
    detach: (tabId) => c.debugger.detach({ tabId }),
    send: (target, method, params) => c.debugger.sendCommand(target, method, params),
    onEvent: (fn) => c.debugger.onEvent.addListener(fn),
    onDetach: (fn) => c.debugger.onDetach.addListener((src, reason) => fn(src.tabId, reason)),
    onTabRemoved: (fn) => c.tabs.onRemoved.addListener(fn),
    onRulesChanged: (fn) => c.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['sg.rules']) fn(); }),
    async getRules() { const o = await c.storage.local.get('sg.rules'); return o['sg.rules'] || []; },
    async loadTabs() { const o = await c.storage.session.get('sg.dbgTabs'); return o['sg.dbgTabs'] || []; },
    saveTabs: (list) => c.storage.session.set({ 'sg.dbgTabs': list }),
    keepAlive: {
      start() { if (!timer) timer = setInterval(() => { c.runtime.getPlatformInfo(() => {}); }, 10000); },
      stop() { if (timer) { clearInterval(timer); timer = null; } },
    },
  };
}

// ---------- default singleton (lazy, so importing this module never touches chrome.*) ----------
let def = null;
const get = () => (def ||= createController(createChromeAdapter()));
export const enableForTab = (tabId) => get().enableForTab(tabId);
export const disableForTab = (tabId) => get().disableForTab(tabId);
export const isEnabled = (tabId) => (def ? def.isEnabled(tabId) : false);
export const setEventSink = (fn) => get().setEventSink(fn);
export const init = async () => (globalThis.chrome && globalThis.chrome.debugger ? get().init() : false);
