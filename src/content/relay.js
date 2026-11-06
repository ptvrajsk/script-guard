/*
 * Script Guard relay (ISOLATED world, owner: Agent B). Classic script.
 * - Forwards validated hook events from the page (window.postMessage) to the service worker.
 * - Fetches config (sg:getConfig) and posts it to the MAIN-world hooks.
 * The page can forge messages on this channel, so everything is treated as untrusted data:
 * shape-checked, kind/action whitelisted, size-capped, rate-limited (50 events/s/frame), and never
 * used as HTML, code or extension API arguments beyond the fixed sg:event message. The page-chosen
 * frameUrl is never forwarded (the background uses sender.url). Caps: 20 events per kind and 200 total
 * per page load per frame.
 */
(function () {
  'use strict';
  var KINDS = ['clipboard.write', 'clipboard.risky', 'download.auto', 'eval', 'function-ctor', 'timer-string',
    'document.write', 'websocket', 'wasm', 'file-picker', 'notification-request', 'window.open',
    'script-insert', 'worker', 'protocol-handler'];
  var ACTIONS = ['allowed', 'logged', 'blocked'];
  var MAX_PER_SEC = 50;
  var MAX_DETAIL = 1200;
  var MAX_PER_KIND = 20;   // per page load (this frame): one kind cannot flood the background's ring buffer
  var MAX_TOTAL = 200;     // per page load (this frame); beyond the caps events are only counted
  var windowStart = 0, inWindow = 0, dropped = 0, total = 0;
  var perKind = Object.create(null);

  function str(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }

  // Copy detail into a fresh plain object: primitives and one level of small arrays only.
  function cleanDetail(d) {
    var out = {};
    if (!d || typeof d !== 'object') return out;
    var n = 0;
    for (var k in d) {
      if (!Object.prototype.hasOwnProperty.call(d, k) || ++n > 8) continue;
      var v = d[k];
      if (typeof v === 'string') out[k.slice(0, 24)] = v.slice(0, 120);
      else if (typeof v === 'number' && isFinite(v)) out[k.slice(0, 24)] = v;
      else if (typeof v === 'boolean') out[k.slice(0, 24)] = v;
      else if (Array.isArray(v)) out[k.slice(0, 24)] = v.slice(0, 4).map(function (x) { return str(x, 40); });
    }
    if (JSON.stringify(out).length > MAX_DETAIL) return {};
    return out;
  }

  function allow() {
    var now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; inWindow = 0; }
    if (inWindow >= MAX_PER_SEC) { dropped++; return false; }
    inWindow++;
    return true;
  }

  function send(msg) {
    try {
      var p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(function () { /* worker asleep or context invalidated */ });
    } catch (e) { /* extension context invalidated */ }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || typeof d !== 'object' || d.__sg !== 1 || d.dir !== 'page->relay' || d.type !== 'event') return;
    if (typeof d.kind !== 'string' || KINDS.indexOf(d.kind) === -1) return;
    if (typeof d.t !== 'number' || !isFinite(d.t)) return;
    if (!allow()) return;
    // Hard caps (the page can post here directly, bypassing the hooks' own counters): count only.
    perKind[d.kind] = (perKind[d.kind] || 0) + 1;
    if (perKind[d.kind] > MAX_PER_KIND || ++total > MAX_TOTAL) { dropped++; return; }
    var msg = {
      type: 'sg:event', kind: d.kind,
      action: ACTIONS.indexOf(d.action) === -1 ? 'logged' : d.action,
      detail: cleanDetail(d.detail), t: d.t
    };
    if (dropped) { msg.dropped = dropped; dropped = 0; }
    send(msg);
  }, false);

  function hostname() {
    var h = location.hostname;
    if (h) return h;
    try { return window.parent.location.hostname || ''; } catch (e) { return ''; } // about:blank/srcdoc inherit
  }

  try {
    var p = chrome.runtime.sendMessage({ type: 'sg:getConfig', hostname: hostname() });
    if (p && typeof p.then === 'function') {
      p.then(function (cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        window.postMessage({ __sg: 1, dir: 'relay->page', type: 'config', hooks: cfg.hooks || {}, profile: str(cfg.profile, 20) || 'default' }, '*');
      }).catch(function () { /* keep hooks' built-in defaults */ });
    }
  } catch (e) { /* keep defaults */ }
})();
