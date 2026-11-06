// Reports which scripts this frame loaded (ISOLATED world, all frames). Sends URLs only, never script text.
// Everything here is a hint for the popup list; the background re-validates all of it.
(function () {
  'use strict';
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
  var MAX_ENTRIES = 300, MAX_STR = 500, DEBOUNCE_MS = 500, MAX_SENDS = 12;
  var seen = new Map();   // url -> {url, async, defer}
  var inline = 0, sends = 0, timer = 0, dirty = false;

  function clean(u) {
    if (typeof u !== 'string' || u.length > MAX_STR) return '';
    try {
      var p = new URL(u);
      if (p.protocol !== 'http:' && p.protocol !== 'https:') return '';
      p.hash = '';
      return p.href.length > MAX_STR ? '' : p.href;
    } catch (e) { return ''; }
  }
  function add(url, isAsync, isDefer) {
    var u = clean(url);
    if (!u) return;
    var cur = seen.get(u);
    if (cur) {
      if ((isAsync && !cur.async) || (isDefer && !cur.defer)) { cur.async = cur.async || !!isAsync; cur.defer = cur.defer || !!isDefer; dirty = true; }
      return;
    }
    if (seen.size >= MAX_ENTRIES) return;
    seen.set(u, { url: u, async: !!isAsync, defer: !!isDefer });
    dirty = true;
  }
  function scan() {
    try {
      var list = document.scripts, n = 0;
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var src = s.getAttribute('src');
        if (src) add(s.src, s.async, s.defer); else if (!s.type || /javascript|ecmascript|module/i.test(s.type)) n++;
      }
      if (n !== inline) { inline = n; dirty = true; }
    } catch (e) { /* page may have clobbered document.scripts */ }
    try {
      var res = performance.getEntriesByType('resource');
      for (var j = 0; j < res.length; j++) if (res[j].initiatorType === 'script') add(res[j].name, false, false);
    } catch (e) { /* ignore */ }
  }
  function flush() {
    timer = 0;
    scan();
    if (!dirty || sends >= MAX_SENDS) return;
    dirty = false; sends++;
    try {
      var p = chrome.runtime.sendMessage({ type: 'sg:scripts', frameUrl: String(location.href).slice(0, MAX_STR), scripts: Array.from(seen.values()), inline: inline });
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* extension reloaded or context invalidated */ }
  }
  function schedule() { if (!timer && sends < MAX_SENDS) timer = setTimeout(flush, DEBOUNCE_MS); }

  try {
    new PerformanceObserver(function (list) {
      var any = false, es = list.getEntries();
      for (var i = 0; i < es.length; i++) if (es[i].initiatorType === 'script') { add(es[i].name, false, false); any = true; }
      if (any) schedule();
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { /* unsupported */ }
  try {
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }
  document.addEventListener('DOMContentLoaded', schedule, { once: true });
  addEventListener('load', schedule, { once: true });
  schedule();
})();
