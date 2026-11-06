// E2E for the content scripts. Usage: node test/e2e/run.mjs   (E2E_REAL=1 to load the repo root as the extension)
//
// By default a stub extension is assembled in a temp dir: the real src/content/{hooks,relay}.js plus a
// stub background that answers sg:getConfig (by hostname: 127.0.0.1 = default, localhost = strict,
// trusted.localhost = trusted) and records every sg:event. With E2E_REAL=1 (needs ./manifest.json) the
// repo root is loaded instead; assertions then use only the page-side recorder, so background-dependent
// checks (relay delivery, iframe probes, per-hostname profiles) are skipped.
//
// Clipboard in headless: permissions clipboard-read/-write/-sanitized-write are granted per origin via
// the browser context (overridePermissions) and the page is brought to front so readText() works. Page
// scripts trigger writes from a real click (page.click) so user activation exists. If read-back fails the
// test reports "unverified" rather than passing silently.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = path.join(ROOT, 'test/pages');
const REAL = process.env.E2E_REAL === '1';
const EXE = process.env.BRAVE || '/usr/bin/brave-browser';

// ---- extension
let EXT = ROOT;
if (REAL) {
  if (!fs.existsSync(path.join(ROOT, 'manifest.json'))) { console.error('E2E_REAL=1 but no manifest.json'); process.exit(2); }
} else {
  EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-e2e-ext-'));
  fs.mkdirSync(path.join(EXT, 'src/content'), { recursive: true });
  for (const f of ['hooks.js', 'relay.js']) fs.copyFileSync(path.join(ROOT, 'src/content', f), path.join(EXT, 'src/content', f));
  const common = { matches: ['<all_urls>'], run_at: 'document_start', all_frames: true, match_about_blank: true, match_origin_as_fallback: true };
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'sg-e2e-stub', version: '0.0.1',
    host_permissions: ['<all_urls>'], background: { service_worker: 'bg.js' },
    content_scripts: [{ ...common, js: ['src/content/hooks.js'], world: 'MAIN', exclude_matches: ['*://trusted.localhost/*'] }, { ...common, js: ['src/content/relay.js'], world: 'ISOLATED', exclude_matches: ['*://trusted.localhost/*'] }]
  }));
  fs.writeFileSync(path.join(EXT, 'bg.js'), `
self.events = [];
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (m && m.type === 'sg:getConfig') {
    const h = m.hostname;
    respond(h === 'localhost' ? { profile: 'strict', hooks: {} } : h === 'trusted.localhost' ? { profile: 'trusted', hooks: {} } : { profile: 'default', hooks: {} });
  } else if (m && m.type === 'sg:event') {
    self.events.push({ ...m, tabUrl: sender.tab && sender.tab.url, frameId: sender.frameId }); respond({});
  }
  return false;
});`);
}

// ---- server
const srv = http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname) || 'index.html';
  const f = path.join(PAGES, name);
  if (!f.startsWith(PAGES) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, r));
const port = srv.address().port;
const D = `http://127.0.0.1:${port}`, S = `http://localhost:${port}`, T = `http://trusted.localhost:${port}`;

// ---- browser
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, pipe: true, enableExtensions: [EXT], args: ['--no-sandbox', '--disable-gpu', '--no-first-run'] });
const ctx = browser.defaultBrowserContext();
for (const o of [D, S, T]) await ctx.overridePermissions(o, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']).catch(() => {});
let sw = null;
if (!REAL) { const t = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 10000 }); sw = await t.worker(); }
const bgEvents = async () => (sw ? await sw.evaluate(() => self.events) : null);
try { const c = await browser.target().createCDPSession(); await c.send('Browser.setDownloadBehavior', { behavior: 'deny' }); } catch {}

const results = [];
function check(name, ok, info = '') { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); }
const note = (s) => console.log('NOTE  ' + s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function open(url) {
  const pg = await browser.newPage();
  await pg.evaluateOnNewDocument(() => {
    window.__sgEvents = [];
    window.addEventListener('message', e => { const d = e.data; if (d && d.__sg === 1 && d.dir === 'page->relay') window.__sgEvents.push({ kind: d.kind, action: d.action, detail: d.detail }); }, true);
  });
  await pg.goto(url, { waitUntil: 'load' });
  await sleep(600); // let the relay's async config reach the hooks
  return pg;
}
const evs = (pg) => pg.evaluate(() => window.__sgEvents);
async function clickAndWait(pg) { await pg.click('#go'); await pg.waitForFunction('window.__done === true', { timeout: 8000 }); return pg.evaluate(() => window.__result); }

try {
  // 1. ClickFix, default profile: all three write paths blocked, clipboard untouched.
  {
    const pg = await open(`${D}/clickfix.html`); const r = await clickAndWait(pg); const e = await evs(pg);
    check('clickfix: writeText rejected NotAllowedError', r.writeText === 'rejected:NotAllowedError', r.writeText);
    check('clickfix: execCommand(copy) of selected payload returns false', r.execCommand === false, String(r.execCommand));
    if (String(r.clipboard).startsWith('readfail')) note('clipboard read-back unavailable: ' + r.clipboard + ' (leak check unverified)');
    else check('clickfix: clipboard still holds sentinel (nothing leaked)', r.clipboard === 'sentinel' && !r.leaked, JSON.stringify(r.clipboard));
    const blocked = e.filter(x => x.kind === 'clipboard.risky' && x.action === 'blocked').length;
    check('clickfix: 3 blocked clipboard.risky events (writeText, execCommand, setData)', blocked === 3, 'blocked=' + blocked);
    check('clickfix: event detail carries reasons', e.some(x => x.detail && x.detail.reasons && x.detail.reasons.includes('mshta')));
    await pg.close();
  }
  // 2. ClickFix, trusted site: the scripts are not injected at all (exclude_matches here, excludeMatches in src/background/scripts.js).
  if (!REAL) {
    const pg = await open(`${T}/clickfix.html`); const r = await clickAndWait(pg); const e = await evs(pg);
    if (String(r.clipboard).startsWith('readfail')) note('trusted: read-back unavailable');
    else check('trusted: payload is written (hooks not injected)', r.leaked === true && r.writeText === 'ok', JSON.stringify(r.clipboard));
    check('trusted: no events at all (nothing injected)', !e || e.length === 0, 'n=' + (e && e.length));
    await pg.close();
  }
  // 3. Benign clipboard page must not be blocked.
  {
    const pg = await open(`${D}/benign-clipboard.html`); const r = await clickAndWait(pg); const e = await evs(pg);
    check('benign: writeText ok', r.writeText === 'ok', r.writeText);
    check('benign: execCommand(copy) true', r.execCommand === true && r.copyEvent === true);
    if (!String(r.clipboard).startsWith('readfail')) check('benign: copy-handler text reached clipboard', r.clipboard === 'from copy handler', JSON.stringify(r.clipboard));
    check('benign: no risky/blocked events', !e.some(x => x.kind === 'clipboard.risky' || x.action === 'blocked'));
    check('benign: clipboard.write logged', e.some(x => x.kind === 'clipboard.write'));
    await pg.close();
  }
  // 4. Forced downloads. Default: warn only. The page runs at load (before config) and again at 1s.
  {
    const pg = await open(`${D}/download.html`); await sleep(1800); // plain sleep: puppeteer evaluate/waitForFunction grant user activation, which would hide the auto-click
    const r0 = await pg.evaluate(() => window.__result);
    check('download(default): auto-clicks logged, not blocked', r0.autoClick && r0.autoDispatch && r0.lateClick && r0.lateDispatch, JSON.stringify(r0));
    let e = await evs(pg);
    check('download(default): 4 download.auto events, all logged', e.filter(x => x.kind === 'download.auto' && x.action === 'logged').length === 4);
    const before = e.filter(x => x.kind === 'download.auto').length;
    await pg.click('#go'); await sleep(200); e = await evs(pg);
    check('download: click inside a user gesture is not flagged', (await pg.evaluate(() => window.__result.gestureClick)) && e.filter(x => x.kind === 'download.auto').length === before);
    await pg.close();
  }
  if (!REAL) { // strict via hostname profile; config arrives after load, so exercise the post-config path
    const pg = await open(`${S}/download.html`); await sleep(1800); // plain sleep: puppeteer evaluate/waitForFunction grant user activation, which would hide the auto-click
    const r = await pg.evaluate(() => window.__result); const e = await evs(pg);
    check('download(strict, after config): late auto-clicks blocked (no click event fired)', !r.lateClick && !r.lateDispatch && r.autoClick, JSON.stringify(r));
    check('download(strict): 2 blocked + 2 early logged events', e.filter(x => x.action === 'blocked').length === 2 && e.filter(x => x.action === 'logged').length === 2);
    note('strict at load time is only default-level: scripts that run before the async sg:getConfig reply are not blocked');
    await pg.close();
  }
  // 5. eval / document.write loader: runs, is logged, and wrappers look native.
  {
    const pg = await open(`${D}/loader.html`); await pg.waitForFunction('window.__done === true'); const r = await pg.evaluate(() => window.__result); const e = await evs(pg);
    check('loader: payloads still execute (log-only)', r.func === 12 && r.ctorViaProto === 7 && r.timerString === 'ran' && r.docWrite === 'ran', JSON.stringify(r));
    for (const k of ['function-ctor', 'timer-string', 'document.write']) check(`loader: ${k} event`, e.some(x => x.kind === k));
    const s = await pg.evaluate(() => {
      const ts = Function.prototype.toString;
      return { evalStr: ts.call(Function), tsStr: ts.call(ts), name: Function.name, len: Function.length, fnStr: ts.call(Function), ctorSame: (function () {}).constructor === Function, wsStr: ts.call(WebSocket) };
    });
    check('stealth: toString of wrappers is native-looking', /\{ \[native code\] \}$/.test(s.evalStr) && /function Function\(\)/.test(s.evalStr) && /native code/.test(s.tsStr) && /native code/.test(s.fnStr) && /native code/.test(s.wsStr), JSON.stringify(s));
    check('stealth: name/length/identity preserved', s.name === 'Function' && s.len === 1 && s.ctorSame);
    await pg.close();
  }
  // 6. Fresh-iframe native grab.
  {
    const pg = await open(`${D}/iframe-bypass.html`); await sleep(500);
    const probes = (await bgEvents())?.filter(x => x.kind === 'function-ctor').map(x => x.detail.sample) ?? null;
    if (probes) {
      const seen = (p) => probes.some(s => s.includes('probe:' + p));
      for (const v of ['blank-from-parent', 'srcdoc', 'sandbox-srcdoc']) check(`iframe-bypass: hooks present in ${v}`, seen(v));
      for (const v of ['data-url', 'blob-url', 'js-url']) note(`iframe ${v}: ${seen(v) ? 'hooked' : 'NOT HOOKED (pristine natives reachable)'}`);
    } else note('iframe probes need the stub background (skipped with E2E_REAL)');
    const r = await clickAndWait(pg);
    check('iframe-bypass: setData still blocked after document.open() (listeners re-armed)', r.afterOpenStored === '', JSON.stringify(r.afterOpenStored));
    if (String(r.clipboard).startsWith('readfail')) note('iframe clipboard read-back unavailable');
    else check('iframe-bypass: ClickFix write from fresh iframe blocked', r.iframeWrite === 'rejected:NotAllowedError' && !r.leaked, JSON.stringify(r));
    await pg.close();
  }
  // 6b. TOCTOU: objects whose toString()/iterator differ on the second read must not smuggle a payload.
  {
    const pg = await open(`${D}/toctou.html`); const r = await clickAndWait(pg); const e = await evs(pg);
    const rb = (v) => String(v).startsWith('readfail');
    check('toctou: writeText(flipping object) did not put the payload on the clipboard', !/mshta/.test(String(r.afterWriteText)) && (rb(r.afterWriteText) || r.writeText !== 'ok' || r.afterWriteText === 'hello'), JSON.stringify([r.writeText, r.afterWriteText]));
    check('toctou: clipboard.write(flipping iterable) did not put the payload on the clipboard', !/mshta/.test(String(r.afterWrite)), JSON.stringify([r.write, r.afterWrite]));
    check('toctou: setData(flipping data) did not store the payload', !/mshta/.test(String(r.setDataStored)) && !/mshta/.test(String(r.afterSetData)), JSON.stringify([r.setDataStored, r.afterSetData]));
    check('toctou: DataTransferItemList.add(payload) blocked inside copy event', r.addResult === null && !/mshta/.test(String(r.addStored)) && !/mshta/.test(String(r.afterAdd)), JSON.stringify([r.addResult, r.addStored, r.afterAdd]));
    check('toctou: items.add block recorded as clipboard.risky event', e.filter(x => x.kind === 'clipboard.risky' && x.action === 'blocked').length >= 1);
    await pg.close();
  }
  // 6c. Forged looser config before the real one, plus direct event flood to the relay.
  if (!REAL) {
    const before = (await bgEvents()).length;
    const pg = await open(`${S}/forged-config.html`); await sleep(1800);
    const r = await pg.evaluate(() => window.__result);
    check('forged config: strict profile still applies after forged default/off configs', r.late === false, JSON.stringify(r));
    const mine = (await bgEvents()).slice(before).filter(x => x.kind === 'worker');
    check('relay: flood of 40 forged events capped at 20 per kind', mine.length === 20, 'n=' + mine.length);
    check('relay: page-chosen frameUrl is not forwarded', mine.every(x => !('frameUrl' in x)));
    check('relay: forged oversized detail is clamped', mine.every(x => JSON.stringify(x.detail).length <= 1200));
    await pg.close();
  }
  // 7. Relay delivery to the background (stub only).
  if (!REAL) {
    const all = await bgEvents();
    check('relay: events reached the service worker with valid shape', all.length > 10 && all.every(x => x.type === 'sg:event' && typeof x.t === 'number'), 'n=' + all.length);
    check('relay: clipboard.risky blocked events reached background', all.some(x => x.kind === 'clipboard.risky' && x.action === 'blocked'));
  }
} catch (e) {
  check('e2e run completed without exception', false, e.stack);
} finally {
  await browser.close(); srv.close();
  if (!REAL) fs.rmSync(EXT, { recursive: true, force: true });
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
