// End-to-end test of the debugger tier in headless Brave.
// Uses a temporary extension (copy of src/shared + src/background/debugger.js, plus a stub background that
// exposes the controller) because the real manifest lists `debugger` as an optional permission, which
// cannot be granted without a user gesture.
// Run: node test/e2e/debugger.mjs   (needs puppeteer-core; set BRAVE=/path/to/brave to override)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-dbg-e2e-'));
fs.mkdirSync(path.join(extDir, 'src/background'), { recursive: true });
fs.cpSync(path.join(root, 'src/shared'), path.join(extDir, 'src/shared'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/background/debugger.js'), path.join(extDir, 'src/background/debugger.js'));
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'sg-debugger-e2e', version: '0.0.1',
  permissions: ['debugger', 'storage', 'tabs'], host_permissions: ['<all_urls>'],
  background: { service_worker: 'bg.js', type: 'module' },
}));
fs.writeFileSync(path.join(extDir, 'bg.js'), `
import * as dbg from './src/background/debugger.js';
self.sgEvents = [];
dbg.setEventSink((e) => self.sgEvents.push(e));
dbg.init();
self.sg = dbg;
`);

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const js = (b, h = {}) => { res.writeHead(200, { 'content-type': 'text/javascript', ...h }); res.end(b); };
  switch (u.pathname) {
    case '/page.html': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<body>p</body>');
    case '/static.html': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<body><script src="/app.js"></script></body>');
    case '/app.js': return js("window.__r = 'ORIGINAL';\nwindow.__line2 = 'keep';\n");
    case '/gz.js': return js(zlib.gzipSync("window.__gz = 'ORIGINAL';"), { 'content-encoding': 'gzip' });
    case '/stale.js': return js("window.__s = 'ORIGINAL';");
    case '/blocked.js': return js("window.__b = 'ran';");
    default: res.writeHead(404); return res.end('nf');
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const results = [];
const check = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, e.message]); } };
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.BRAVE || '/usr/bin/brave-browser', headless: true, pipe: true,
    enableExtensions: [extDir], args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
  });
  const swT = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'), { timeout: 10000 });
  const sw = await swT.worker();
  await new Promise((r) => setTimeout(r, 800));
  const pg = await browser.newPage();
  await pg.goto(base + '/page.html');
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '/*' }))[0].id, base);

  const mkRule = (id, file, ops) => ({ id, name: id, enabled: true, urlPattern: `${base}/${file}`, ops, createdAt: 1 });
  const setRules = (rules) => sw.evaluate((r) => chrome.storage.local.set({ 'sg.rules': r }), rules);
  const load = (p) => pg.evaluate((u) => new Promise((r) => { const s = document.createElement('script'); s.src = u; s.onload = () => r('loaded'); s.onerror = () => r('error'); document.head.appendChild(s); }), base + p);
  const events = () => sw.evaluate(() => self.sgEvents);

  await setRules([
    mkRule('patch', 'app.js', [{ type: 'replace', find: 'ORIGINAL', replace: 'PATCHED' }]),
    mkRule('gz', 'gz.js', [{ type: 'replace', find: 'ORIGINAL', replace: 'PATCHED-GZ' }]),
    mkRule('stale', 'stale.js', [{ type: 'replace', find: 'MISSING-ANCHOR', replace: 'x' }]),
    mkRule('block', 'blocked.js', [{ type: 'blockScript' }]),
  ]);

  // before enabling: nothing is touched
  assert.equal(await load('/app.js'), 'loaded');
  const before = await pg.evaluate(() => window.__r);
  check('disabled tab runs original', () => assert.equal(before, 'ORIGINAL'));

  await sw.evaluate((id) => self.sg.enableForTab(id), tabId);
  assert.equal(await sw.evaluate((id) => self.sg.isEnabled(id), tabId), true);

  await pg.evaluate(() => { delete window.__r; });
  await pg.evaluate(() => { delete window.__r; });
  await load('/app.js');
  const patched = await pg.evaluate(() => [window.__r, window.__line2]);
  check('patched body runs', () => assert.deepEqual(patched, ['PATCHED', 'keep']));

  await load('/gz.js');
  const gz = await pg.evaluate(() => window.__gz);
  check('gzip body is patched', () => assert.equal(gz, 'PATCHED-GZ'));

  const st = await load('/stale.js');
  const stale = await pg.evaluate(() => window.__s);
  check('stale rule fails open (original runs)', () => { assert.equal(st, 'loaded'); assert.equal(stale, 'ORIGINAL'); });

  const bl = await load('/blocked.js');
  const blocked = await pg.evaluate(() => window.__b);
  check('blockScript stops the script', () => { assert.equal(bl, 'error'); assert.equal(blocked, undefined); });

  // a real navigation with a static <script src>
  await pg.goto(base + '/static.html');
  const nav = await pg.evaluate(() => window.__r);
  check('static script tag on a fresh navigation is patched', () => assert.equal(nav, 'PATCHED'));

  const ev = await events();
  check('script.scored emitted', () => assert.ok(ev.some((e) => e.kind === 'script.scored' && e.detail.url === base + '/app.js' && typeof e.detail.score === 'number')));
  check('script.patched emitted', () => assert.ok(ev.some((e) => e.kind === 'script.patched' && !e.detail.blocked)));
  check('script.stale emitted', () => assert.ok(ev.some((e) => e.kind === 'script.stale' && e.detail.ruleId === 'stale')));
  check('blocked patched event emitted', () => assert.ok(ev.some((e) => e.kind === 'script.patched' && e.detail.blocked)));

  // rule edited live: takes effect without re-enabling
  await setRules([mkRule('patch2', 'app.js', [{ type: 'replace', find: 'ORIGINAL', replace: 'LIVE' }])]);
  await new Promise((r) => setTimeout(r, 300));
  await pg.evaluate(() => { delete window.__r; });
  await load('/app.js');
  const live = await pg.evaluate(() => window.__r);
  check('rule change applies live', () => assert.equal(live, 'LIVE'));

  await sw.evaluate((id) => self.sg.disableForTab(id), tabId);
  await pg.evaluate(() => { delete window.__r; });
  await load('/app.js');
  const off = await pg.evaluate(() => window.__r);
  check('after disable the original runs', () => assert.equal(off, 'ORIGINAL'));
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.close();
  fs.rmSync(extDir, { recursive: true, force: true });
}

let failed = 0;
for (const r of results) { console.log(r[0] === 'ok' ? 'ok   ' : 'FAIL ', r[1], r[2] || ''); if (r[0] !== 'ok') failed++; }
process.exit(failed ? 1 : 0);
