# Feasibility notes: Phase 0 experiment results (Brave 156.1.98.63, Chromium 156, Linux, headless, isolated profile)

These were measured with throwaway experiments (not included in this repository), using Puppeteer to drive headless Brave.

| # | Question | Result |
|---|----------|--------|
| 1 | Brave accepts `--load-extension`? | YES (headless). |
| 1 | Puppeteer `enableExtensions` + `pipe: true` launches Brave with the extension? | YES. MV3 service worker found as a target. |
| 2 | DNR `append` of response `Content-Security-Policy` on a page with no CSP | WORKS. Inline script blocked; baseline page ran it. |
| 2 | DNR `append` CSP on a page that already sends its own CSP | WORKS. Intersection enforced (inline blocked). |
| 2 | DNR `append` of `Permissions-Policy` | WORKS. `usb`/`camera` true on baseline, false with the rule. |
| 2 | Rules survive browser restart; behaviour with Shields toggled | NOT TESTED. Headless isolated profile only, Shields at default. |
| 3 | MAIN-world hook runs before page code: top frame, dynamic `about:blank` iframe, `srcdoc` iframe, sandboxed (`allow-scripts`) `srcdoc` iframe | YES in all four. Manifest used `all_frames`, `match_about_blank`, `match_origin_as_fallback`. |
| 3 | Trusted Types interaction; `toString` spoofing quality | NOT TESTED. |
| 4 | Debugger `Fetch` response-stage patching of script bodies | WORKS: small, gzip (strip `content-encoding`/`content-length`), chunked (waits for full body, ~900 ms in test), 6 MB (~260 ms). |
| 4 | `fulfillRequest` honours header overrides | YES (`x-patched` visible to page `fetch`). |
| 4 | Debugger works while another CDP client holds the tab | YES. A second client's `Fetch.enable` returned no error. Interplay of two interceptors NOT TESTED. |
| 4 | DevTools-open detach, SW keep-alive over long pauses, iframe/worker `setAutoAttach`, infobar | NOT TESTED (headless). |
| 5 | DNR redirect to a `data:` URL | FAILS: `net::ERR_UNSAFE_REDIRECT`. |
| 5 | DNR redirect to a packaged extension file (`extensionPath`) | WORKS, needs `web_accessible_resources`. |
| 5 | Service-worker `fetch` handler generating the redirect target at runtime | FAILS: page received the static placeholder file. |
| 5 | `showDirectoryPicker` on Overrides folder from options page | NOT TESTED (needs user gesture and a display). |

## Consequences for the plan
- DNR `append` is confirmed for CSP and Permissions-Policy, so the DNR layer can ship as designed.
- Hooks can rely on `document_start` MAIN-world injection in all frame types tested.
- Whole-file overrides cannot be generated at runtime through DNR. Body patching is therefore the debugger tier. Any no-infobar alternative for ad scripts is limited to block rules or MAIN-world defusers, or to a build step that packages the patched file into the extension.
- Debugger tier is viable and fast enough, including large and gzip bodies.
