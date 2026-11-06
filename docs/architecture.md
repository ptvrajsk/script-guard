# Script Guard: module contract and architecture

Measured feasibility results: [feasibility-notes.md](feasibility-notes.md).

## Rules
- Plain JavaScript ES modules, **no build step, no runtime dependencies**. Tests use `node:test` (`npm test`, Node 20 or newer).
- Background service worker is `type: module`. Content scripts are classic scripts (no imports).
- No telemetry, no remote code, no `eval`/`new Function` in extension code. See `.claude/skills/mv3-review/SKILL.md` for the review checklist; self-check against it.
- Pure logic goes in modules that import nothing from `chrome.*`, so `node --test` can load them. Wrap any `chrome.*` use behind small adapters.
- Headless Brave is `/usr/bin/brave-browser` (see `test/e2e/real.mjs` for the working launch recipe: `puppeteer-core`, `headless: true`, `pipe: true`, `enableExtensions: [path]`, args `--no-sandbox --disable-gpu --no-first-run`).

## Storage schema (`src/shared/schema.js`)
`chrome.storage.local`:
- `sg.settings`: `{ version: 1, defaultProfile: 'default', siteProfiles: { "<etld1>": 'trusted'|'default'|'strict' }, debuggerSites: ["<etld1>"], allowlists: { scriptHosts: ["host"] }, hooks: { <hookName>: 'off'|'log'|'warn'|'block' } }`
- `sg.rules`: array of override rules (schema defined in `patch.js`, see below).
- `sg.hostlists`: `{ badHosts: [...], updatedAt }`.
Exports: `DEFAULT_SETTINGS`, `PROFILES`, `validateSettings(obj) -> {ok, errors, value}`, `profileFor(settings, hostname)`.

`src/shared/sites.js`: `etld1(hostname)` (small built-in public-suffix handling for common multi-part TLDs such as co.uk, com.au; document the limitation), `isSecureContextUrl(url)`.

## Profiles (behaviour matrix)
| Feature | trusted | default | strict |
|---------|---------|---------|--------|
| MAIN-world hooks | log-only off (hooks inert) | clipboard=block-risky, download=warn, others=log | clipboard=block-risky, download=block, eval/Function/document.write/WebSocket/wasm=warn |
| Permissions-Policy denies | none | usb, hid, serial, bluetooth, midi, payment, display-capture, idle-detection, xr-spatial-tracking, local-fonts, window-management, clipboard-read | same |
| CSP | none | none | `Content-Security-Policy-Report-Only` appended, with `script-src 'self' https:; object-src 'none'; base-uri 'self'` |
| Known-bad host block rules | on | on | on |
| Download gate (risky ext/MIME) | off | warn | block |

## DNR `src/background/dnr.js`
- `buildRules(settings, hostlists) -> Rule[]` pure and deterministic with stable ids (reserve id ranges: 1-999 headers, 1000-1999 downloads, 2000+ bad hosts). Never `set` on CSP; only `append`. Per-site profile via `initiatorDomains`/`requestDomains` of registrable domains (no substring matching).
- `sync()` applies via `updateDynamicRules` (diff against existing), is called on install, startup and when `sg.settings` changes.
- `downloads.js`: `classifyDownload({filename, mime, url, hadGesture?}) -> {risk: 'none'|'low'|'high', reason}` (pure) and the `chrome.downloads.onDeterminingFilename` wiring.

## Event pipeline
1. MAIN hooks (B) -> `window.postMessage({ __sg: 1, dir: 'page->relay', type: 'event', kind, detail, frameUrl, t }, '*')`.
2. relay.js (B, ISOLATED world) validates shape, rate-limits (max 50 events/s/frame, drops the rest and counts), then `chrome.runtime.sendMessage({ type: 'sg:event', kind, detail, frameUrl, t })`.
3. On load relay.js sends `{ type: 'sg:getConfig', hostname }` and posts `{ __sg: 1, dir: 'relay->page', type: 'config', hooks: {...}, profile }` to MAIN. hooks.js uses built-in `default`-profile behaviour synchronously until config arrives (no race window), then updates.
4. Background `events.js` (A): `recordEvent(tabId, evt)`, `getEvents(tabId)`, `clearEvents(tabId)`, per-tab ring buffer (max 200), badge counter via `chrome.action.setBadgeText`. Handles runtime messages `sg:event`, `sg:getConfig` (returns `{profile, hooks}` from settings via `profileFor`), `sg:getEvents`.
5. Event `kind` values (B defines in hooks.js, documented at top of file): `clipboard.write`, `clipboard.risky`, `download.auto`, `eval`, `function-ctor`, `timer-string`, `document.write`, `websocket`, `wasm`, `file-picker`, `notification-request`, `window.open`, `script-insert`, `worker`, `protocol-handler`. `detail` is a small JSON-safe object (truncate strings to 200 chars). Each event also carries `action: 'allowed'|'logged'|'blocked'`.
6. Debugger tier events (C) use the sink `setEventSink(fn)`; shape `{ kind: 'script.scored'|'script.patched'|'script.stale', detail }`; A's `index.js` wires the sink to `recordEvent`.

## Hooks `src/content/hooks.js`
Single self-contained classic script, wrapped in an IIFE, no globals leaked (except one non-enumerable Symbol-keyed channel if essential). Table-driven wrapper generator that makes each wrapper copy `name`, `length`, property descriptors, and passes native-looking `Function.prototype.toString`; patch `Function.prototype.toString` once and hide that patch too. Capture native references before anything else. Export for tests guarded by `if (typeof module !== 'undefined')`: `classifyClipboardText(text) -> {risky, reasons}` (flags `powershell`, `pwsh`, `mshta`, `-enc`/`-encodedcommand`, `cmd /c`, `cmd.exe`, `curl ... | sh/bash`, `wget ... | sh`, `irm`/`iwr` with `iex`, `certutil -urlcache`, `bitsadmin`, `rundll32`, `regsvr32 /s /u /i:http`, base64-looking long payloads after those verbs) and `classifyHooks`. Hooks listed in the plan. Default-profile behaviour: clipboard risky writes blocked (the promise resolves/rejects as a denied permission would, never silently pretending success without the user being told via a `sg:event`), everything else logged.

## Patch engine and scoring
Rule schema (stored in `sg.rules`):
`{ id, name, enabled, urlPattern (string with * wildcards, matched against full URL without hash), expectedHash? (sha256 hex of original), ops: Op[] , createdAt }`
`Op = { type: 'replace', find, replace, all?: boolean } | { type: 'insertBefore'|'insertAfter', anchor, text, all?: boolean } | { type: 'deleteLine', anchor, all?: boolean } | { type: 'blockScript' }`
`patch.js` exports: `matchesPattern(pattern, url)`, `hashText(text) -> Promise<hex>`, `applyRule(text, rule) -> { text, applied: number[], skipped: {opIndex, reason}[], stale: boolean, blocked: boolean }` (anchors must match exactly once unless `all`; zero matches -> skipped + stale; string anchors only: regex ops are rejected by validateRule and skipped with reason 'regex-not-supported' by applyRule, to rule out ReDoS), `diffToOps(original, patched) -> Op[]` (line-level diff turning edits into replace/insertBefore/insertAfter/deleteLine ops with the minimal unique anchor), and `validateRule(rule)`.
`scoring.js` exports `scoreScript(text, { url, pageOrigin }) -> { score: 0-100, reasons: [{id, weight, detail}] }` pure, with signals listed in the plan (entropy, obfuscator.io patterns, eval/atob density, long hex/base64 blobs, miner indicators, hidden-iframe writers, third-party origin). Include a small corpus of fixture strings in the tests (benign minified library vs obfuscated stub).
`debugger.js`: `enableForTab(tabId)`, `disableForTab(tabId)`, `isEnabled(tabId)`, `setEventSink(fn)`, `init()` registering listeners once. Fetch at Response stage for `Script` resourceType (and `Document` only if a rule needs it); decode body, strip `content-encoding`/`content-length` on fulfill (confirmed by the feasibility experiments), apply matching enabled rules from `sg.rules`, score the script, fail open on any error, oversize (> 8 MB) bodies and when detach occurs; track paused requests and keep the service worker alive while any are pending; `Target.setAutoAttach` with `flatten: true` so iframes and workers are covered; remove state on `tabs.onRemoved` and `debugger.onDetach`.

## Manifest
MV3, `service_worker: src/background/index.js` with `type: module`. Permissions: `declarativeNetRequest`, `declarativeNetRequestWithHostAccess`, `storage`, `downloads`, `management`, `tabs`, `scripting`, `debugger` (Chromium rejects it as an optional permission, so it is required but only used per site). `host_permissions: ['<all_urls>']`. Content scripts: `src/content/hooks.js` (world MAIN) and `src/content/relay.js` (ISOLATED), both `document_start`, `all_frames`, `match_about_blank`, `match_origin_as_fallback`. `action` with `src/ui/popup.html`, `options_page: src/ui/options.html` (Lead creates those). CSP for extension pages left default. `web_accessible_resources` none.
