/*
 * Script Guard in-page notice (ISOLATED world, classic script).
 * Shows one small dismissible toast in the TOP frame when the background reports a blocked event.
 * Trust model: triggered ONLY by chrome.runtime.onMessage from this extension's background
 * (sender.id check). Never listens to window.postMessage (the page can forge it). Text comes from a
 * fixed map keyed by event kind; no page-supplied string is ever displayed. The UI lives in a closed
 * shadow root with `all: initial`, so page CSS cannot hide or restyle it.
 * The host element carries data-sg-state / data-sg-count so tests can observe it (closed roots are
 * not reachable from puppeteer); those attributes contain only fixed tokens and a number.
 */
(function () {
  'use strict';

  var TEXT = {
    'clipboard.risky': "Script Guard blocked a command this page tried to copy to your clipboard. Don't paste it into Run, a terminal or PowerShell.",
    'clipboard.write': 'Script Guard blocked this page from writing to your clipboard.',
    'download.auto': 'Script Guard blocked a download this page started on its own.',
    'download.gate': 'Script Guard blocked a risky download.',
    'window.open': 'Script Guard blocked a pop-up from this page.',
    'notification-request': 'Script Guard blocked this page from asking to show notifications.',
    'file-picker': 'Script Guard blocked this page from asking to access your files.'
  };
  var FALLBACK = 'Script Guard blocked something this page tried to do. Open the Script Guard icon for details.';
  var MIN_GAP_MS = 4000;
  var AUTO_HIDE_MS = 8000;

  function noticeText(kind) {
    return Object.prototype.hasOwnProperty.call(TEXT, kind) ? TEXT[kind] : FALLBACK;
  }
  function cleanCount(n) {
    n = Number(n);
    return isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 9999) : 1;
  }

  if (typeof module !== 'undefined') module.exports = { TEXT: TEXT, FALLBACK: FALLBACK, noticeText: noticeText, cleanCount: cleanCount, MIN_GAP_MS: MIN_GAP_MS, AUTO_HIDE_MS: AUTO_HIDE_MS };
  if (typeof window === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
  if (window !== window.top) return;

  var CSS = [
    ':host{all:initial}',
    '.t{all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;box-sizing:border-box;max-width:min(380px,calc(100vw - 32px));display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:10px;border:1px solid #8c1d18;background:#fff;color:#1b1b1f;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.28);animation:in .18s ease-out}',
    '.t *{all:unset;box-sizing:border-box}',
    '.m{display:block;flex:1}',
    '.h{display:block;font-weight:700;margin-bottom:2px}',
    '.x{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;border-radius:6px;font-size:18px;line-height:1;color:inherit}',
    '.x:hover{background:rgba(0,0,0,.1)}',
    '.x:focus-visible{outline:2px solid #1a56db;outline-offset:2px}',
    '@keyframes in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}',
    '@media (prefers-color-scheme:dark){.t{background:#26262b;color:#f2f2f5;border-color:#ff8a80}.x:hover{background:rgba(255,255,255,.15)}.x:focus-visible{outline-color:#8ab4ff}}',
    '@media (prefers-reduced-motion:reduce){.t{animation:none}}'
  ].join('');

  var host = null, root = null, box = null, msgEl = null, cntEl = null;
  var hideTimer = null, queueTimer = null, lastShown = 0, pending = null;

  function setState(s, n) {
    if (!host) return;
    host.setAttribute('data-sg-state', s);
    host.setAttribute('data-sg-count', String(n || 0));
  }

  function dismiss() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (box) { box.remove(); box = null; }
    setState('hidden', 0);
  }

  function ensureHost() {
    if (!host) {
      host = document.createElement('script-guard-notice');
      host.style.cssText = 'all:initial;display:block';
      root = host.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = CSS;
      root.appendChild(st);
    }
    if (!host.isConnected) (document.documentElement || document).appendChild(host);
  }

  function render(m) {
    ensureHost();
    if (!box) {
      box = document.createElement('div');
      box.className = 't';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      var body = document.createElement('span'); body.className = 'm';
      var h = document.createElement('span'); h.className = 'h';
      cntEl = h;
      msgEl = document.createElement('span');
      body.appendChild(h); body.appendChild(msgEl);
      var x = document.createElement('button');
      x.className = 'x'; x.type = 'button'; x.setAttribute('aria-label', 'Dismiss Script Guard notice'); x.textContent = '×';
      x.addEventListener('click', dismiss);
      box.addEventListener('keydown', function (e) { if (e.key === 'Escape') { dismiss(); } });
      box.appendChild(body); box.appendChild(x);
      root.appendChild(box);
    }
    var n = cleanCount(m.count);
    cntEl.textContent = n > 1 ? 'Script Guard blocked ' + n + ' things' : 'Script Guard';
    msgEl.textContent = noticeText(m.kind);
    setState('shown', n);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(dismiss, AUTO_HIDE_MS);
  }

  function show(m) {
    if (box) { render(m); return; } // already visible: update in place (coalesce)
    var wait = lastShown + MIN_GAP_MS - Date.now();
    if (wait > 0) { // too soon after the previous toast: keep only the latest and show it later
      pending = m;
      if (!queueTimer) queueTimer = setTimeout(function () { queueTimer = null; var p = pending; pending = null; if (p) show(p); }, wait);
      return;
    }
    lastShown = Date.now();
    render(m);
  }

  chrome.runtime.onMessage.addListener(function (msg, sender) {
    if (!sender || sender.id !== chrome.runtime.id || sender.tab) return; // background only
    if (!msg || typeof msg !== 'object' || msg.type !== 'sg:notice' || msg.action !== 'blocked') return;
    if (typeof msg.kind !== 'string') return;
    show({ kind: msg.kind, count: msg.count });
  });
})();
