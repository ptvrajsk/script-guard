# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - Pre-release

First public pre-release.

### Added
- Clipboard guard for fake-CAPTCHA (ClickFix) attacks, with an in-page notice and toolbar badge.
- Download guard and `Permissions-Policy` hardening, with per-site Off, Default and Strict profiles.
- Known-bad host blocking from a list bundled with the extension.
- Popup list of the scripts on a page, with one-click Block script and Block site.
- Opt-in script rewriting using text-anchored patch rules, with an importer for Chrome DevTools Local Overrides and a Rewrites panel in the popup.
- Settings: rules, blocked scripts, browser hardening checklist, extension audit, backup and restore.
- A test that fails the build if the extension gains any telemetry or unreviewed network request.

### Known limitations
- Page hooks are best-effort and do not cover workers or `javascript:` iframes.
- The browser shows its own debugging banner while script rewriting is on.
- Not yet tested on Windows, macOS or other Chromium browsers.
