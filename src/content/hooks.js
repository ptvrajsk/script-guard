/*
 * Script Guard MAIN-world hooks (owner: Agent B). Classic script, no imports, no eval/new Function.
 *
 * Event kinds posted to the relay (window.postMessage, dir 'page->relay'):
 *   clipboard.write, clipboard.risky, download.auto, function-ctor, timer-string,
 *   document.write, websocket, wasm, file-picker, notification-request, window.open,
 *   script-insert, worker, protocol-handler
 * Each event: { __sg:1, dir:'page->relay', type:'event', kind, action:'allowed'|'logged'|'blocked',
 *               detail (small JSON-safe object, strings <= 200 chars), frameUrl, t }
 *
 * Hook names (keys of settings.hooks, values 'off'|'log'|'warn'|'block'):
 *   clipboard, download, function, timer, documentWrite, websocket, wasm, filePicker,
 *   notification, windowOpen, scriptInsert, worker, protocolHandler
 * 'warn' has no in-page UI: it is recorded exactly like 'log' (action 'logged') and the popup is the
 * warning surface. 'block' blocks only the risky subset (clipboard: risky text; download: no user
 * activation; window.open: no user activation) and everything for the other hooks.
 *
 * HONEST LIMITS (best effort, not a security boundary):
 *  - Hooks run first in every frame the content-script matcher reaches (top, about:blank, srcdoc,
 *    sandboxed srcdoc: proven in spike). A fresh same-origin iframe is therefore hooked too, but any
 *    frame the browser does not inject into (see test/pages/iframe-bypass.html for what we measured)
 *    exposes pristine natives.
 *  - Workers (dedicated, shared, service) are NOT hooked: a Worker can do WebSocket/WebAssembly/fetch
 *    unobserved. We only log the Worker construction.
 *  - eval is deliberately NOT hooked: replacing window.eval turns direct `eval(x)` into indirect
 *    (global-scope) evaluation, which breaks real sites. The Function constructor is hooked instead.
 *  - AsyncFunction/GeneratorFunction constructors, `import()`, `<script>` text set via innerHTML,
 *    `location.href = blobUrl` downloads, form-submit downloads and the user pressing Ctrl+C on text a
 *    page injected into the DOM are not covered.
 *  - Timing/stack/identity side channels can still reveal Proxy wrappers. toString is spoofed.
 *  - The relay->page config channel is window.postMessage, so a page can forge it. Config is therefore
 *    monotonic: it can only make a hook stricter than the built-in default, never looser, so a forged
 *    message cannot switch protection off. Trusted sites are handled by not injecting this script
 *    there (see src/background/scripts.js). A page can still forge/flood events (relay rate-limits).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- pure logic (testable in Node)
  var MAX_SCAN = 20000;      // head and tail window scanned with the full rule set
  var MAX_GLOBAL = 8000000;  // the cheap whole-text verb scan; anything longer is risky by size alone
  var SHELL = '(?:(?:ba|z|da|k)?sh|python[23]?|perl|ruby|node|php)';
  var SUDO = '(?:sudo\\s+(?:-\\S+\\s+)*)?';
  // All gaps are bounded ({0,N}) so a long run of verbs cannot make a rule quadratic.
  var RULES = [
    ['powershell', /\bpowershell(?:\.exe)?\b/i],
    ['pwsh', /\bpwsh(?:\.exe)?\b/i],
    ['mshta', /\bmshta(?:\.exe)?\b/i],
    ['encoded-command', /(?:^|\s)-(?:enc|encodedcommand|ec)\b/i],
    ['hidden-window', /(?:^|\s)-w(?:indowstyle)?\s+hidden\b/i],
    ['exec-bypass', /(?:^|\s)-(?:ep|executionpolicy)\s+bypass\b/i],
    ['cmd-c', /\bcmd(?:\.exe)?\s+\/[ck]\b/i],
    ['cmd.exe', /\bcmd\.exe\b/i],
    ['start-min', /\bstart\s+\/(?:min|b|wait)\b/i],
    ['curl-pipe-sh', new RegExp('\\bcurl\\b[^|]{0,400}\\|\\s*' + SUDO + SHELL + '\\b', 'i')],
    ['wget-pipe-sh', new RegExp('\\bwget\\b[^|]{0,400}\\|\\s*' + SUDO + SHELL + '\\b', 'i')],
    ['process-subst-curl', /<\(\s*(?:curl|wget)\b/i],
    ['sh-c-curl', /\b(?:ba|z|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/i],
    ['eval-curl', /\beval\s+["'`]?(?:\$\(|`)\s*(?:curl|wget)\b/i],
    ['curl-download-exec', /\b(?:curl|wget)\b[^\n]{0,300}?\.(?:exe|msi|bat|cmd|scr|hta|ps1|vbs|dll)\b[^\n]{0,100}?(?:&&|&|;|\|\|)/i],
    ['curl-chmod-run', /\b(?:curl|wget)\b[^\n]{0,300}?(?:&&|;)\s*(?:chmod\s+\+?[0-7]*x|\.\/\S|sudo\b|(?:ba)?sh\s)/i],
    ['base64-pipe-sh', new RegExp('\\bbase64\\s+(?:-d|-D|--decode)\\b[^|]{0,200}\\|\\s*' + SUDO + SHELL + '\\b', 'i')],
    ['frombase64string', /\bfrombase64string\b/i],
    ['iex', /\biex\s*[( ]|\binvoke-expression\b/i],
    ['irm-iex', /\b(?:irm|iwr|invoke-restmethod|invoke-webrequest)\b[^\n]*\|\s*(?:iex|invoke-expression)\b|\b(?:iex|invoke-expression)\b[^\n]*\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/i],
    ['msiexec', /\bmsiexec(?:\.exe)?\s+\/[a-z]/i],
    ['wscript', /\b[wc]script(?:\.exe)?\s+(?:\/\/|[^\n]{0,200}?\.(?:js|jse|vbs|vbe|wsf|hta)\b|[^\n]{0,200}?https?:)/i],
    ['certutil-urlcache', /\bcertutil(?:\.exe)?\b[^\n]*-urlcache/i],
    ['bitsadmin', /\bbitsadmin(?:\.exe)?\b/i],
    ['rundll32', /\brundll32(?:\.exe)?\b/i],
    ['regsvr32-remote', /\bregsvr32(?:\.exe)?\b[^\n]*\/[siu](?::|\s)[^\n]*https?:/i]
  ];
  // Cheap whole-text scan for texts longer than MAX_SCAN (padding evasion): strong verbs only, so a
  // long benign document that merely mentions curl is not flagged.
  var GLOBAL_VERBS = /\b(?:powershell|pwsh|mshta|rundll32|bitsadmin|certutil|msiexec|frombase64string|invoke-expression|regsvr32)(?:\.exe)?\b|\bcmd(?:\.exe)?\s+\/[ck]\b|\b[wc]script(?:\.exe)?\s+\/\/|\biex\s*[(]|<\(\s*(?:curl|wget)\b|\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i;
  var BASE64_BLOB = /[A-Za-z0-9+\/]{80,}={0,2}/;
  var LURE = /i am not a robot|recaptcha verification|verification id|verify you are human|press win\s*\+\s*r/i;

  function classifyClipboardText(text) {
    var reasons = [];
    if (typeof text !== 'string' || !text) return { risky: false, reasons: reasons };
    var slices = text.length > MAX_SCAN ? [text.slice(0, MAX_SCAN), text.slice(text.length - MAX_SCAN)] : [text];
    var i, k, b64 = false, lure = false;
    for (k = 0; k < slices.length; k++) {
      var s = slices[k];
      for (i = 0; i < RULES.length; i++) if (reasons.indexOf(RULES[i][0]) === -1 && RULES[i][1].test(s)) reasons.push(RULES[i][0]);
      if (BASE64_BLOB.test(s)) b64 = true;
      if (LURE.test(s)) lure = true;
    }
    if (text.length > MAX_SCAN) {
      if (text.length > MAX_GLOBAL) reasons.push('oversize');
      else if (GLOBAL_VERBS.test(text)) reasons.push('verb-in-long-text');
    }
    if (reasons.length) {
      // A long base64-ish payload only counts when a suspicious verb is already present.
      if (b64) reasons.push('base64-payload');
      if (lure) reasons.push('captcha-lure');
    }
    return { risky: reasons.length > 0, reasons: reasons };
  }

  var HOOK_NAMES = ['clipboard', 'download', 'function', 'timer', 'documentWrite', 'websocket',
    'wasm', 'filePicker', 'notification', 'windowOpen', 'scriptInsert', 'worker', 'protocolHandler'];
  var MODES = ['off', 'log', 'warn', 'block'];

  // classifyHooks({profile, hooks}) -> effective { hookName: mode } (contract left the signature open).
  function classifyHooks(cfg) {
    var profile = cfg && typeof cfg.profile === 'string' ? cfg.profile : 'default';
    var out = {};
    var i, n;
    for (i = 0; i < HOOK_NAMES.length; i++) {
      n = HOOK_NAMES[i];
      out[n] = profile === 'trusted' ? 'off' : 'log';
    }
    if (profile === 'default') { out.clipboard = 'block'; out.download = 'warn'; }
    if (profile === 'strict') {
      out.clipboard = 'block'; out.download = 'block';
      ['function', 'timer', 'documentWrite', 'websocket', 'wasm'].forEach(function (k) { out[k] = 'warn'; });
    }
    var h = cfg && cfg.hooks;
    if (h && typeof h === 'object') {
      for (i = 0; i < HOOK_NAMES.length; i++) {
        n = HOOK_NAMES[i];
        if (Object.prototype.hasOwnProperty.call(h, n) && MODES.indexOf(h[n]) !== -1) out[n] = h[n];
      }
    }
    return out;
  }

  // Monotonic merge: a config can only make a hook stricter than the current mode, never looser.
  function mergeModes(cur, incoming) {
    for (var hi = 0; hi < HOOK_NAMES.length; hi++) {
      var hn = HOOK_NAMES[hi];
      if (MODES.indexOf(incoming[hn]) > MODES.indexOf(cur[hn])) cur[hn] = incoming[hn];
    }
    return cur;
  }

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = { classifyClipboardText: classifyClipboardText, classifyHooks: classifyHooks, mergeModes: mergeModes, HOOK_NAMES: HOOK_NAMES };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof Proxy !== 'function') return;

  // ---------------------------------------------------------------- browser install
  // 1. Capture natives before anything else.
  var win = window;
  var R = Reflect;
  var rApply = R.apply, rConstruct = R.construct, rGetProto = R.getPrototypeOf;
  var getDesc = Object.getOwnPropertyDescriptor, defProp = Object.defineProperty;
  var PromiseCtor = Promise;
  var DOMEx = DOMException;
  var nativePost = win.postMessage;
  var nativeAdd = EventTarget.prototype.addEventListener;
  var nativeRemove = EventTarget.prototype.removeEventListener;
  var nativeNow = Date.now;
  var arrayFrom = Array.from;
  var nativeSlice = String.prototype.slice;
  var nativeLower = String.prototype.toLowerCase;
  var nativeToString = Function.prototype.toString;
  var wmGet = WeakMap.prototype.get, wmSet = WeakMap.prototype.set;
  var origOf = new WeakMap();

  function desc(proto, prop) { var d = proto && getDesc(proto, prop); return d; }
  function getter(proto, prop) { var d = desc(proto, prop); return d && d.get; }
  function method(proto, prop) { var d = desc(proto, prop); return d && d.value; }
  var g = {
    anchorDownload: getter(HTMLAnchorElement.prototype, 'download'),
    anchorHref: getter(HTMLAnchorElement.prototype, 'href'),
    hasAttr: method(Element.prototype, 'hasAttribute'),
    getAttr: method(Element.prototype, 'getAttribute'),
    evType: getter(Event.prototype, 'type'),
    evSource: getter(MessageEvent.prototype, 'source'),
    evData: getter(MessageEvent.prototype, 'data'),
    evClipData: typeof ClipboardEvent === 'function' ? getter(ClipboardEvent.prototype, 'clipboardData') : null,
    inputValue: getter(HTMLInputElement.prototype, 'value'),
    inputStart: getter(HTMLInputElement.prototype, 'selectionStart'),
    inputEnd: getter(HTMLInputElement.prototype, 'selectionEnd'),
    taValue: getter(HTMLTextAreaElement.prototype, 'value'),
    taStart: getter(HTMLTextAreaElement.prototype, 'selectionStart'),
    taEnd: getter(HTMLTextAreaElement.prototype, 'selectionEnd'),
    activeEl: getter(Document.prototype, 'activeElement'),
    selToString: method(Selection.prototype, 'toString'),
    getSelection: method(win, 'getSelection') || method(Window.prototype, 'getSelection'),
    navUA: getter(Navigator.prototype, 'userActivation'),
    uaActive: typeof UserActivation === 'function' ? getter(UserActivation.prototype, 'isActive') : null,
    locHref: getter(Location.prototype, 'href'),
    cbItemTypes: typeof ClipboardItem === 'function' ? getter(ClipboardItem.prototype, 'types') : null,
    cbItemGet: typeof ClipboardItem === 'function' ? method(ClipboardItem.prototype, 'getType') : null,
    blobText: method(Blob.prototype, 'text')
  };
  function call(fn, self, args) { return fn ? rApply(fn, self, args || []) : undefined; }

  function trunc(v, n) {
    n = n || 200;
    return typeof v === 'string' ? (v.length > n ? rApply(nativeSlice, v, [0, n]) : v) : '';
  }
  function frameUrl() { try { return trunc(String(call(g.locHref, win.location))); } catch (e) { return ''; } }
  function gestured() {
    try {
      var ua = call(g.navUA, navigator);
      if (!ua || !g.uaActive) return true; // API missing: do not over-block
      return !!call(g.uaActive, ua);
    } catch (e) { return true; }
  }

  // 2. State
  var modes = classifyHooks({ profile: 'default' }); // synchronous default until relay config arrives
  var counts = {};
  var CAP = 100;

  function emit(kind, action, detail) {
    try {
      counts[kind] = (counts[kind] || 0) + 1;
      if (counts[kind] > CAP) return;
      rApply(nativePost, win, [{
        __sg: 1, dir: 'page->relay', type: 'event', kind: kind, action: action,
        detail: detail || {}, frameUrl: frameUrl(), t: rApply(nativeNow, Date, [])
      }, '*']);
    } catch (e) { /* never break the page */ }
  }
  function denied(name) { return new DOMEx('Blocked by Script Guard', name || 'NotAllowedError'); }
  function rejected(e) { return PromiseCtor.reject(e); }

  // 3. Table-driven wrapper generator. All wrappers are Proxies over the native function, so
  //    name, length, prototype and property descriptors are the native ones by construction.
  //    spec: { hook, owner(), prop, type:'fn'|'ctor', pre(self,args,mode)->null|{kind,detail,block},
  //            deny(self,args)->value (may throw), run? custom handler }
  function findOwner(obj, prop) {
    while (obj) { if (getDesc(obj, prop)) return obj; obj = rGetProto(obj); }
    return null;
  }
  // Single-coercion rule: a hook that inspects an argument must coerce it ONCE, store the primitive
  // back into args and let the native receive that primitive, otherwise a page object whose
  // toString() answers differently on the second call passes the check and then smuggles a payload.
  // ToString here is the template-literal one (same as WebIDL DOMString: toString first, Symbol throws).
  var coerceErr = null;
  function coerce(args, i) {
    try { return (args[i] = '' + args[i]); } catch (e) { coerceErr = { e: e }; throw e; }
  }
  function decide(spec, self, args, mode) {
    var r = null;
    coerceErr = null;
    try { r = spec.pre(self, args, mode); } catch (e) { r = null; if (coerceErr) { var ce = coerceErr; coerceErr = null; return { go: false, thrown: ce }; } }
    if (!r) return { go: true };
    if (mode === 'block' && r.block) { emit(r.kind, 'blocked', r.detail); return { go: false }; }
    emit(r.kind, 'logged', r.detail);
    return { go: true };
  }
  function install(spec) {
    var owner = spec.owner();
    if (!owner) return;
    var holder = findOwner(owner, spec.prop);
    if (!holder) return;
    var d = getDesc(holder, spec.prop);
    if (!d || typeof d.value !== 'function' || !d.configurable) return;
    var orig = d.value;
    var handler = {
      apply: function (t, self, args) {
        var mode = modes[spec.hook];
        if (mode === 'off') return rApply(t, self, args);
        if (spec.run) return spec.run(t, self, args, mode);
        if (spec.type === 'ctor' && !spec.callable) return rApply(t, self, args); // native will throw the proper TypeError
        var v = decide(spec, self, args, mode);
        if (v.thrown) { if (spec.onCoerceFail) return spec.onCoerceFail(v.thrown.e); throw v.thrown.e; }
        return v.go ? rApply(t, self, args) : spec.deny(self, args);
      }
    };
    if (spec.type === 'ctor') {
      handler.construct = function (t, args, nt) {
        var mode = modes[spec.hook];
        var target = nt === proxy ? t : nt;
        if (mode !== 'off') {
          var v = decide(spec, null, args, mode);
          if (v.thrown) throw v.thrown.e;
          if (!v.go) return spec.deny(null, args);
        }
        return rConstruct(t, args, target);
      };
    }
    var proxy = new Proxy(orig, handler);
    rApply(wmSet, origOf, [proxy, orig]);
    defProp(holder, spec.prop, { value: proxy, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
    if (spec.alsoProtoConstructor) {
      var pd = getDesc(orig.prototype, 'constructor');
      if (pd && pd.configurable) defProp(orig.prototype, 'constructor', { value: proxy, writable: pd.writable, enumerable: pd.enumerable, configurable: true });
    }
  }

  // Function.prototype.toString patch, itself hidden (maps both proxies and itself to natives).
  (function patchToString() {
    var d = getDesc(Function.prototype, 'toString');
    if (!d || !d.configurable) return;
    var p = new Proxy(nativeToString, {
      apply: function (t, self, args) {
        var o = rApply(wmGet, origOf, [self]);
        return rApply(t, o || self, args);
      }
    });
    rApply(wmSet, origOf, [p, nativeToString]);
    defProp(Function.prototype, 'toString', { value: p, writable: d.writable, enumerable: d.enumerable, configurable: true });
  })();

  // ------------------------------------------------ helper analyses
  var NAV = Navigator.prototype;
  function isAnchor(x) { try { call(g.anchorDownload, x); return true; } catch (e) { return false; } }
  function downloadInfo(a) {
    var href = '';
    try { href = String(call(g.anchorHref, a)); } catch (e) { /* ignore */ }
    var scheme = href.indexOf(':') > 0 ? rApply(nativeSlice, href, [0, href.indexOf(':')]) : '';
    var name = '';
    try { name = String(call(g.getAttr, a, ['download'])); } catch (e) { /* ignore */ }
    return { scheme: trunc(scheme, 20), href: scheme === 'blob' || scheme === 'data' ? trunc(href, 60) : trunc(href), filename: trunc(name) };
  }
  function hasDownloadAttr(a) { try { return !!call(g.hasAttr, a, ['download']); } catch (e) { return false; } }
  function selectedText() {
    try {
      var el = call(g.activeEl, document);
      if (el) { // brand-checked native getters throw for the wrong element type (no instanceof: spoofable)
        try { var v = call(g.taValue, el); return rApply(nativeSlice, v, [call(g.taStart, el), call(g.taEnd, el)]); } catch (e1) { /* not a textarea */ }
        try { var w = call(g.inputValue, el); return rApply(nativeSlice, w, [call(g.inputStart, el), call(g.inputEnd, el)]); } catch (e2) { /* not an input */ }
      }
      var sel = call(g.getSelection, win);
      return sel ? String(call(g.selToString, sel)) : '';
    } catch (e) { return ''; }
  }
  function clipDetail(text, cls) {
    return { len: text.length, sample: trunc(text), risky: cls.risky, reasons: cls.reasons.slice(0, 8) };
  }
  function clipPre(text) {
    var cls = classifyClipboardText(text);
    return { kind: cls.risky ? 'clipboard.risky' : 'clipboard.write', detail: clipDetail(text, cls), block: cls.risky };
  }

  var currentCD = null; // DataTransfer of the copy/cut event being dispatched
  var inCopy = false; // true from the capture-phase copy/cut listener until the bubble-phase one

  // ------------------------------------------------ hook table
  var CB = typeof Clipboard === 'function' ? Clipboard.prototype : null;
  var NOT_ALLOWED = function () { return rejected(denied('NotAllowedError')); };
  var specs = [
    // --- clipboard (P0 ClickFix)
    { hook: 'clipboard', owner: function () { return CB; }, prop: 'writeText', type: 'fn',
      pre: function (s, a) { return a.length ? clipPre(coerce(a, 0)) : null; },
      deny: NOT_ALLOWED, onCoerceFail: rejected },
    { hook: 'clipboard', owner: function () { return CB; }, prop: 'write', type: 'fn',
      run: function (t, self, args, mode) {
        // Items are read asynchronously, so decide inside a promise. Resolves/rejects like the native.
        return (async function () {
          var texts = [];
          var list = []; // snapshot: the page's array-like is read exactly once, the native gets the copy
          try {
            list = rApply(arrayFrom, Array, [args[0]]); // one pass over the page's iterable
            args = [list];
            for (var q = 0; q < list.length && g.cbItemTypes; q++) {
              var types = call(g.cbItemTypes, list[q]);
              if (types && rApply(Array.prototype.indexOf, types, ['text/plain']) !== -1) {
                var blob = await call(g.cbItemGet, list[q], ['text/plain']);
                texts.push(await call(g.blobText, blob)); // blob contents are immutable: native re-read sees the same text
              }
            }
          } catch (e) { if (args[0] !== list) throw e; texts = []; }
          for (var j = 0; j < texts.length; j++) {
            var r = clipPre(texts[j]);
            if (mode === 'block' && r.block) { emit(r.kind, 'blocked', r.detail); throw denied('NotAllowedError'); }
            emit(r.kind, 'logged', r.detail);
          }
          return rApply(t, self, args);
        })();
      } },
    { hook: 'clipboard', owner: function () { return Document.prototype; }, prop: 'execCommand', type: 'fn',
      pre: function (s, a) {
        if (!a.length) return null;
        var c = rApply(nativeLower, coerce(a, 0), []);
        if (c !== 'copy' && c !== 'cut') return null;
        var text = selectedText();
        return text ? clipPre(text) : null;
      },
      deny: function () { return false; } },
    { hook: 'clipboard', owner: function () { return DataTransfer.prototype; }, prop: 'setData', type: 'fn',
      pre: function (s, a) {
        if (!currentCD || s !== currentCD || a.length < 2) return null;
        var ty = rApply(nativeLower, coerce(a, 0), []);
        var data = coerce(a, 1);
        if (ty !== 'text/plain' && ty !== 'text') return null;
        return clipPre(data);
      },
      deny: function () { return undefined; } },
    // DataTransferItemList.add(string, type) is the second way to fill the clipboard in a copy event.
    { hook: 'clipboard', owner: function () { return typeof DataTransferItemList === 'function' ? DataTransferItemList.prototype : null; }, prop: 'add', type: 'fn',
      pre: function (s, a) {
        // Blink returns a fresh DataTransferItemList wrapper per .items read, so the list cannot be tied to
        // the event's DataTransfer by identity: any string add() while a copy/cut event is dispatching counts.
        if (!inCopy || a.length < 2) return null; // 1 arg = File overload
        var ty = rApply(nativeLower, coerce(a, 1), []);
        var data = coerce(a, 0);
        if (ty !== 'text/plain' && ty !== 'text') return null;
        return clipPre(data);
      },
      deny: function () { return null; } },

    // --- downloads (P0)
    { hook: 'download', owner: function () { return HTMLAnchorElement.prototype; }, prop: 'click', type: 'fn',
      pre: function (s) { return isAnchor(s) && hasDownloadAttr(s) && !gestured() ? { kind: 'download.auto', detail: downloadInfo(s), block: true } : null; },
      deny: function () { return undefined; } },
    { hook: 'download', owner: function () { return EventTarget.prototype; }, prop: 'dispatchEvent', type: 'fn',
      pre: function (s, a) {
        var ev = a[0];
        if (!ev || typeof ev !== 'object' || call(g.evType, ev) !== 'click') return null; // cheap checks first: hot path
        if (!isAnchor(s) || !hasDownloadAttr(s) || gestured()) return null;
        return { kind: 'download.auto', detail: downloadInfo(s), block: true };
      },
      deny: function () { return false; } },

    // --- code loading
    { hook: 'function', owner: function () { return win; }, prop: 'Function', type: 'ctor', callable: true, alsoProtoConstructor: true,
      pre: function (s, a) { return { kind: 'function-ctor', detail: { argc: a.length, sample: trunc(typeof a[a.length - 1] === 'string' ? a[a.length - 1] : '') }, block: true }; },
      deny: function () { throw denied('EvalError'); } },
    { hook: 'timer', owner: function () { return win; }, prop: 'setTimeout', type: 'fn',
      pre: function (s, a) { return typeof a[0] === 'string' ? { kind: 'timer-string', detail: { api: 'setTimeout', sample: trunc(a[0]) }, block: true } : null; },
      deny: function () { return 0; } },
    { hook: 'timer', owner: function () { return win; }, prop: 'setInterval', type: 'fn',
      pre: function (s, a) { return typeof a[0] === 'string' ? { kind: 'timer-string', detail: { api: 'setInterval', sample: trunc(a[0]) }, block: true } : null; },
      deny: function () { return 0; } },
    { hook: 'documentWrite', owner: function () { return Document.prototype; }, prop: 'write', type: 'fn',
      pre: function (s, a) { for (var i = 0; i < a.length; i++) coerce(a, i); var t = a.length ? a[0] : ''; return { kind: 'document.write', detail: { api: 'write', len: t.length, sample: trunc(t) }, block: true }; },
      deny: function () { return undefined; } },
    { hook: 'documentWrite', owner: function () { return Document.prototype; }, prop: 'writeln', type: 'fn',
      pre: function (s, a) { for (var i = 0; i < a.length; i++) coerce(a, i); var t = a.length ? a[0] : ''; return { kind: 'document.write', detail: { api: 'writeln', len: t.length, sample: trunc(t) }, block: true }; },
      deny: function () { return undefined; } },
    { hook: 'scriptInsert', owner: function () { return Document.prototype; }, prop: 'createElement', type: 'fn',
      pre: function (s, a) { return typeof a[0] === 'string' && rApply(nativeLower, a[0], []) === 'script' ? { kind: 'script-insert', detail: {}, block: false } : null; },
      deny: function () { return undefined; } },

    // --- network / wasm / workers
    { hook: 'websocket', owner: function () { return win; }, prop: 'WebSocket', type: 'ctor',
      pre: function (s, a) { return { kind: 'websocket', detail: { url: trunc(typeof a[0] === 'string' ? a[0] : '[object]') }, block: true }; },
      deny: function () { throw denied('SecurityError'); } },
    { hook: 'worker', owner: function () { return win; }, prop: 'Worker', type: 'ctor',
      pre: function (s, a) { return { kind: 'worker', detail: { api: 'Worker', url: trunc(typeof a[0] === 'string' ? a[0] : '[object]') }, block: true }; },
      deny: function () { throw denied('SecurityError'); } },
    { hook: 'worker', owner: function () { return win; }, prop: 'SharedWorker', type: 'ctor',
      pre: function (s, a) { return { kind: 'worker', detail: { api: 'SharedWorker', url: trunc(typeof a[0] === 'string' ? a[0] : '[object]') }, block: true }; },
      deny: function () { throw denied('SecurityError'); } }
  ];
  ['instantiate', 'compile', 'instantiateStreaming', 'compileStreaming'].forEach(function (p) {
    specs.push({ hook: 'wasm', owner: function () { return typeof WebAssembly === 'object' ? WebAssembly : null; }, prop: p, type: 'fn',
      pre: function () { return { kind: 'wasm', detail: { api: p }, block: true }; }, deny: NOT_ALLOWED });
  });
  specs.push({ hook: 'wasm', owner: function () { return typeof WebAssembly === 'object' ? WebAssembly : null; }, prop: 'Module', type: 'ctor',
    pre: function () { return { kind: 'wasm', detail: { api: 'Module' }, block: true }; }, deny: function () { throw denied('SecurityError'); } });
  ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'].forEach(function (p) {
    specs.push({ hook: 'filePicker', owner: function () { return win; }, prop: p, type: 'fn',
      pre: function () { return { kind: 'file-picker', detail: { api: p }, block: true }; }, deny: NOT_ALLOWED });
  });
  specs.push({ hook: 'notification', owner: function () { return typeof Notification === 'function' ? Notification : null; }, prop: 'requestPermission', type: 'fn',
    pre: function () { return { kind: 'notification-request', detail: {}, block: true }; },
    deny: function () { return PromiseCtor.resolve('denied'); } });
  specs.push({ hook: 'windowOpen', owner: function () { return win; }, prop: 'open', type: 'fn',
    pre: function (s, a) { return gestured() ? null : { kind: 'window.open', detail: { url: trunc(typeof a[0] === 'string' ? a[0] : '') }, block: true }; },
    deny: function () { return null; } });
  specs.push({ hook: 'protocolHandler', owner: function () { return NAV; }, prop: 'registerProtocolHandler', type: 'fn',
    pre: function (s, a) { return { kind: 'protocol-handler', detail: { scheme: trunc(typeof a[0] === 'string' ? a[0] : '', 40), url: trunc(typeof a[1] === 'string' ? a[1] : '') }, block: true }; },
    deny: function () { return undefined; } });

  for (var si = 0; si < specs.length; si++) {
    try { install(specs[si]); } catch (e) { /* a failing hook must not stop the others */ }
  }

  // copy/cut events: remember the event's DataTransfer so setData can be recognised as clipboard-bound.
  function onCopy(e) {
    try { currentCD = call(g.evClipData, e) || null; } catch (x) { currentCD = null; }
    inCopy = !!currentCD;
  }
  function onCopyEnd() { inCopy = false; }

  // Config from the ISOLATED relay (every valid message is merged monotonically; see HONEST LIMITS about forgery).
  function onMessage(e) {
    try {
      if (call(g.evSource, e) !== win) return;
      var d = call(g.evData, e);
      if (!d || typeof d !== 'object' || d.__sg !== 1 || d.dir !== 'relay->page' || d.type !== 'config') return;
      // The channel is forgeable by the page, so a config can only tighten protection, never loosen it.
      // Loosening (the Trusted profile) is done by not injecting these scripts into that site at all.
      // Every message is merged (never "first wins"), so a forged early config cannot shadow the real one.
      mergeModes(modes, classifyHooks({ profile: d.profile, hooks: d.hooks }));
    } catch (x) { /* ignore */ }
  }
  // document.open() erases ALL listeners on the window (spec), including ours and the relay's. We can
  // re-arm our own; the relay (ISOLATED world) cannot be re-armed from here, so after a page calls
  // document.open() in a frame, events from that frame stop reaching the background (enforcement,
  // which lives in the patched natives, continues).
  function arm() {
    rApply(nativeAdd, win, ['copy', onCopy, true]);
    rApply(nativeAdd, win, ['cut', onCopy, true]);
    rApply(nativeAdd, win, ['copy', onCopyEnd, false]);
    rApply(nativeAdd, win, ['cut', onCopyEnd, false]);
    rApply(nativeAdd, win, ['message', onMessage, false]);
  }
  arm();
  install({ hook: '__always', owner: function () { return Document.prototype; }, prop: 'open', type: 'fn',
    run: function (t, self, args) { var r = rApply(t, self, args); try { arm(); } catch (e) { /* ignore */ } return r; } });
})();
