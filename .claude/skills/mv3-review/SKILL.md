---
name: mv3-review
description: Review Script Guard changes for MV3 permission creep, unsafe CSP/header rules, hook-injection hazards and patch-engine safety. Use after editing manifest.json, DNR rules, MAIN-world hooks, the debugger tier or the override/patch importer.
---

# MV3 review checklist (Script Guard)

Run through this when the diff touches `manifest.json`, `src/background/*`, `src/content/*` or rule/patch storage. Report findings as file:line with a concrete failure scenario. Skip items the diff doesn't touch.

## 1. Permissions and manifest
- Every permission has a stated reason in the diff or README. Flag additions of `<all_urls>` beyond what the plan requires, `cookies`, `history`, `tabs` (use `activeTab`), `webRequest` (we use DNR), `nativeMessaging`.
- `debugger` must stay in `optional_permissions`, requested at runtime per site, never in `permissions`.
- No remote code: no `eval`, `new Function`, remote `<script src>`, or `importScripts` of non-bundled URLs in extension pages. `content_security_policy.extension_pages` must not loosen `script-src 'self'`.
- `web_accessible_resources` is minimal, with explicit `matches`. Anything exposed there can be probed by pages.

## 2. DNR rules
- Never `set` on `Content-Security-Policy`. It replaces the site's policy. Only `append`, and only if the Phase 0 spike confirmed it works.
- Check rule counts against limits: 30k dynamic (5k unsafe), 5k session, 1k regex.
- Rule IDs are stable and rules are re-applied on startup.
- Allowlists use `requestDomains`/`initiatorDomains` by registrable domain. Flag substring or suffix matching that `evil-example.com` would satisfy.
- Block rules for downloads can't brick legitimate flows: check the Trusted profile bypasses them.

## 3. MAIN-world hooks
- Hooks install at `document_start`, before page code, in every frame, including `about:blank` and `srcdoc` (`match_origin_as_fallback`).
- Wrappers preserve `name`, `length`, descriptors and `toString`, and `Function.prototype.toString` itself is patched and hidden.
- Hook code never trusts page-controlled values: it captures native references first and doesn't read `window.<anything>` the page could replace.
- The MAIN-to-ISOLATED channel carries data only, with no callbacks. The relay validates message shape and origin and never forwards page strings into `innerHTML`, extension APIs or `eval`.
- No hook can be turned against the user: a page must not be able to spoof "allowed" events or flood the service worker (rate-limit).

## 4. Debugger tier and patch engine
- Attach only to tabs the user opted in. Detach on tab close, profile change and DevTools-open (`onDetach`).
- Fail open: any exception, timeout, oversized or streamed body means the original response is passed through unchanged.
- Patch ops are applied to the response text only, and anchors must match exactly once (or `all` explicitly). Zero matches means skip and mark the rule stale.
- A patch must never inject content derived from the page or network. Replacement text comes only from saved rules.
- Content-length, encoding and charset are handled when fulfilling. Check that gzip/br bodies are decoded before patching.

## 5. Storage and imports
- Rules live in `chrome.storage.local` only. Nothing is auto-imported from the network without a diff preview.
- Overrides-folder importer reads files only, never writes into the folder, and keeps the directory handle in IndexedDB only.
- Regexes from saved rules are bounded (no catastrophic backtracking on multi-MB scripts). Prefer string anchors.

## 6. Privacy
- No telemetry and no network calls except explicitly user-triggered list updates and fetching originals for the importer.
- Logs and the event list don't persist page URLs beyond the session unless the user opts in.

## Output
List only real problems, most severe first, each with: file:line, one-sentence defect, and the scenario where it goes wrong. If the diff is clean, say so.
