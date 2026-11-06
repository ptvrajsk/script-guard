// Integration test against the REAL extension (repo root) in headless Brave.
// Usage: node test/e2e/real.mjs [--shots <dir>]   (screenshots of popup/options if --shots is given)
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = path.join(ROOT, 'test/pages');
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const EXE = process.env.BRAVE || '/usr/bin/brave-browser';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const note = (m) => console.log('NOTE  ' + m);

const srv = http.createServer((req, res) => {
  const f = path.join(PAGES, path.basename(new URL(req.url, 'http://x').pathname));
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(f)); }
  else if (req.url.startsWith('/polyfill-test')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<body>ok</body>'); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const A = `http://127.0.0.1:${port}`;          // guarded (default profile)
const T = `http://trusted.localhost:${port}`;   // set to Trusted below

const browser = await puppeteer.launch({
  executablePath: EXE, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`],
});
try {
  const swT = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('src/background/index.js'), { timeout: 15000 });
  check('service worker starts', true);
  const sw = await swT.worker();
  const extId = new URL(swT.url()).host;
  const errors = [];
  const sess = await swT.createCDPSession();
  await sess.send('Runtime.enable');
  sess.on('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  sess.on('Runtime.consoleAPICalled', (e) => { if (e.type === 'error') errors.push(e.args.map((a) => a.value || a.description).join(' ')); });

  // Give install handlers time, then inspect state.
  await sleep(1500);
  const state = await sw.evaluate(async () => ({
    dnr: (await chrome.declarativeNetRequest.getDynamicRules()).length,
    scripts: (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort(),
    settings: !!(await chrome.storage.local.get('sg.settings'))['sg.settings'],
  }));
  check('dynamic DNR rules present', state.dnr > 0, 'n=' + state.dnr);
  check('all content scripts registered', state.scripts.join() === 'sg-collector,sg-hooks,sg-notice,sg-relay', state.scripts.join());
  check('default settings seeded', state.settings);

  // Mark trusted.localhost as Trusted; scripts must re-register with an exclusion.
  await sw.evaluate(async () => {
    const s = (await chrome.storage.local.get('sg.settings'))['sg.settings'];
    s.siteProfiles['trusted.localhost'] = 'trusted';
    await chrome.storage.local.set({ 'sg.settings': s });
  });
  await sleep(800);
  const reg = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['sg-hooks'] }))[0]);
  check('trusted site is excluded from injection', (reg.excludeMatches || []).includes('*://*.trusted.localhost/*'), JSON.stringify(reg.excludeMatches));

  // ===== BEGIN shared-suffix and bad-host regression e2e =====
  {
    const setSites = async (sites) => {
      await sw.evaluate(async (x) => {
        const s = (await chrome.storage.local.get('sg.settings'))['sg.settings'];
        s.siteProfiles = x;
        await chrome.storage.local.set({ 'sg.settings': s });
      }, sites);
      await sleep(800);
      return sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).filter((r) => r.id.startsWith('sg-')));
    };
    let regs = await setSites({ 'trusted.localhost': 'trusted', 'a.github.io': 'trusted' });
    const ex = (regs.find((r) => r.id === 'sg-hooks') || {}).excludeMatches || [];
    check('trusting a.github.io excludes only that tenant', ex.includes('*://a.github.io/*') && !ex.some((p) => p.includes('*.github.io') || p.includes('//github.io') || p.includes('b.github.io')), JSON.stringify(ex));
    regs = await setSites({ 'trusted.localhost': 'trusted', '999.999.999.999': 'trusted' });
    check('bad host in settings never leaves pages unguarded', regs.length === 4 && regs.every((r) => r.matches.includes('<all_urls>')), regs.map((r) => r.id).join());
    regs = await setSites({ 'trusted.localhost': 'trusted' });
    check('valid settings restored', regs.length === 4 && (regs[0].excludeMatches || []).includes('*://*.trusted.localhost/*'));
  }
  // ===== END shared-suffix and bad-host regression e2e =====

  const extPage = await browser.newPage();
  await extPage.goto(`chrome-extension://${extId}/src/ui/options.html`, { waitUntil: 'load' });
  const tabIdFor = (u) => sw.evaluate(async (x) => (await chrome.tabs.query({ url: x + '/*' }))[0].id, u);
  const eventsFor = async (u) => {
    const id = await tabIdFor(u);
    const r = await extPage.evaluate((i) => chrome.runtime.sendMessage({ type: 'sg:getEvents', tabId: i }), id);
    return Array.isArray(r) ? r : (r && r.events) || [];
  };

  async function open(url) {
    const pg = await browser.newPage();
    await pg.evaluateOnNewDocument(() => { window.__t0 = 1; });
    await pg.goto(url, { waitUntil: 'load' });
    await pg.bringToFront();
    return pg;
  }
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(A, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await ctx.overridePermissions(T, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);

  // ClickFix on a guarded site: blocked, and the event reaches the background.
  {
    const pg = await open(`${A}/clickfix.html`);
    await pg.click('#go').catch(() => {});
    await pg.waitForFunction('window.__done === true', { timeout: 8000 }).catch(() => {});
    const r = await pg.evaluate(() => window.__result || {});
    check('guarded: ClickFix clipboard write is blocked', r.leaked === false || r.leaked === undefined && String(r.writeText).includes('NotAllowed'), JSON.stringify(r).slice(0, 160));
    await sleep(500);
    const list = await eventsFor(A);
    check('guarded: blocked clipboard.risky event recorded for the tab', list.some((e) => e.kind === 'clipboard.risky' && e.action === 'blocked'), 'n=' + list.length);
    await pg.close();
  }
  // Same page on the trusted site: not injected, so the write goes through.
  {
    const pg = await open(`${T}/clickfix.html`);
    await pg.click('#go').catch(() => {});
    await pg.waitForFunction('window.__done === true', { timeout: 8000 }).catch(() => {});
    const r = await pg.evaluate(() => window.__result || {});
    check('trusted: nothing injected, write goes through', r.leaked === true, JSON.stringify(r).slice(0, 160));
    await pg.close();
  }
  // Hooks reach about:blank, srcdoc and sandboxed srcdoc frames through the dynamic registration.
  {
    const pg = await open(`${A}/iframe-bypass.html`);
    await sleep(700);
    const samples = ((await eventsFor(A)).filter((e) => e.kind === 'function-ctor')).map((e) => JSON.stringify(e.detail));
    for (const v of ['blank-from-parent', 'srcdoc', 'sandbox-srcdoc']) check(`hooks active in ${v} frame`, samples.some((s) => s.includes('probe:' + v)));
    await pg.close();
  }
  // Permissions-Policy is applied by DNR on guarded pages.
  {
    const pg = await open(`${A}/polyfill-test`);
    const pp = await pg.evaluate(() => { const fp = document.featurePolicy; return { usb: fp.allowsFeature('usb'), hid: fp.allowsFeature('hid'), camera: fp.allowsFeature('camera') }; });
    check('guarded: Permissions-Policy denies usb and hid', pp.usb === false && pp.hid === false, JSON.stringify(pp));
    await pg.close();
  }
  // Popup: opens in a tab with a stubbed active-tab lookup (a popup can't be opened headlessly).
  async function renderPopup(tabUrl, name) {
    const pg = await browser.newPage();
    await pg.setViewport({ width: 380, height: 620, deviceScaleFactor: 2 });
    await pg.evaluateOnNewDocument((u) => {
      const q = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (o) => (o && o.active ? [{ id: 9999, url: u }] : q(o));
    }, tabUrl);
    await pg.goto(`chrome-extension://${extId}/src/ui/popup.html`, { waitUntil: 'load' });
    await sleep(500);
    const text = await pg.evaluate(() => document.body.innerText);
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, name) });
    return { pg, text };
  }
  {
    const { pg, text } = await renderPopup('https://news.example.com/article', 'popup-default.png');
    check('popup shows the site and its state', /example\.com/.test(text) && /Guarded/.test(text), text.replace(/\s+/g, ' ').slice(0, 120));
    await pg.click('input[value="strict"]');
    await sleep(300);
    const prof = await sw.evaluate(async () => (await chrome.storage.local.get('sg.settings'))['sg.settings'].siteProfiles['example.com']);
    check('popup: choosing Strict saves the site profile', prof === 'strict', String(prof));
    if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'popup-strict.png') });
    await pg.close();
  }
  {
    const { pg, text } = await renderPopup('chrome://settings', 'popup-unsupported.png');
    check('popup: unsupported page explains itself', /can.t be protected/.test(text), text.replace(/\s+/g, ' ').slice(0, 100));
    await pg.close();
  }
  // ===== BEGIN scripts panel e2e (collector, popup list, user blocks) =====
  {
    const sp = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      const h = { 'cache-control': 'no-store' };
      if (p === '/ad.js') { res.writeHead(200, { ...h, 'content-type': 'text/javascript' }); res.end('window.__adRan = (window.__adRan || 0) + 1;'); }
      else if (p === '/page.html') {
        res.writeHead(200, { ...h, 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Scripts page</title><body>hello<script>window.__inlineRan = 1;</script><script src="/own.js"></script><script src="http://localhost:${spPort}/ad.js" async></script>`);
      } else if (p === '/own.js') { res.writeHead(200, { ...h, 'content-type': 'text/javascript' }); res.end('window.__ownRan = 1;'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((r) => sp.listen(0, '127.0.0.1', r));
    var spPort = sp.address().port;
    const PAGE = `http://127.0.0.1:${spPort}/page.html`;
    const pg = await browser.newPage();
    await pg.goto(PAGE, { waitUntil: 'load' });
    await sleep(1500); // collector debounce
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u })).map((t) => t.id)[0], PAGE);
    const ran = () => pg.evaluate(() => ({ ad: window.__adRan || 0, own: window.__ownRan || 0 }));
    check('scripts: third-party script runs before any block', (await ran()).ad === 1);

    const view = await extPage.evaluate((i) => chrome.runtime.sendMessage({ type: 'sg:getScripts', tabId: i }), tabId);
    const adRow = view.scripts.find((s) => s.url.endsWith('/ad.js'));
    check('scripts: collector reported both scripts, third-party first', view.scripts.length === 2 && view.scripts[0].url.endsWith('/ad.js') && adRow.thirdParty && !view.scripts[1].thirdParty, JSON.stringify(view.scripts.map((s) => [s.host, s.thirdParty])));
    check('scripts: inline script counted', view.inline === 1, String(view.inline));
    // (content-script senders are rejected by sender checks, covered in unit tests)

    async function popupFor(name) {
      const p = await browser.newPage();
      await p.setViewport({ width: 380, height: 620, deviceScaleFactor: 2 });
      await p.evaluateOnNewDocument((id, u) => {
        const q = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (o) => (o && o.active ? [{ id, url: u }] : q(o));
      }, tabId, PAGE);
      await p.goto(`chrome-extension://${extId}/src/ui/popup.html`, { waitUntil: 'load' });
      await sleep(600);
      if (SHOTS && name) await p.screenshot({ path: path.join(SHOTS, name) });
      return p;
    }
    let pop = await popupFor('popup-scripts.png');
    const rows = await pop.evaluate(() => [...document.querySelectorAll('#scripts li')].map((li) => li.innerText.replace(/\s+/g, ' ')));
    check('popup: lists the third-party script first with a Third-party pill', rows.length === 2 && /localhost/.test(rows[0]) && /Third-party/.test(rows[0]) && !/Third-party/.test(rows[1]), JSON.stringify(rows));
    const h = await pop.evaluate(() => document.body.getBoundingClientRect().height);
    check('popup: stays under 600 px tall with scripts listed', h <= 600, 'h=' + h);

    await pop.click('#scripts li:first-child button[aria-label^="Block everything"]');
    await sleep(600);
    check('popup: reload bar shown after blocking', await pop.evaluate(() => !document.getElementById('reloadBar').hidden));
    check('popup: row now says Blocked with an Unblock button', await pop.evaluate(() => /Blocked/.test(document.querySelector('#scripts li').innerText) && /Unblock/.test(document.querySelector('#scripts li').innerText)));
    if (SHOTS) await pop.screenshot({ path: path.join(SHOTS, 'popup-scripts-blocked.png') });
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get('sg.blocks'))['sg.blocks']);
    check('blocks: host block stored', stored && stored.length === 1 && stored[0].kind === 'host' && stored[0].value === 'localhost', JSON.stringify(stored));
    const dyn = await sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.id >= 100000).length);
    check('blocks: DNR rule installed', dyn === 1, 'n=' + dyn);
    // dnr.js's own sync must leave the block rule alone.
    await sw.evaluate(async () => { const s = (await chrome.storage.local.get('sg.settings'))['sg.settings']; s.siteProfiles['sync-probe.test'] = 'strict'; await chrome.storage.local.set({ 'sg.settings': s }); });
    await sleep(800);
    const dyn2 = await sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.id >= 100000).length);
    check('blocks: survive a settings-driven DNR sync', dyn2 === 1, 'n=' + dyn2);
    await sw.evaluate(async () => { const s = (await chrome.storage.local.get('sg.settings'))['sg.settings']; delete s.siteProfiles['sync-probe.test']; await chrome.storage.local.set({ 'sg.settings': s }); });

    await pg.reload({ waitUntil: 'load' });
    await sleep(1500);
    const r2 = await ran();
    check('blocks: blocked script no longer runs after reload, own script still does', r2.ad === 0 && r2.own === 1, JSON.stringify(r2));
    await pop.close();

    // Options lists the block; refusing the page's own site.
    const opt = await browser.newPage();
    await opt.setViewport({ width: 1100, height: 700, deviceScaleFactor: 1 });
    await opt.goto(`chrome-extension://${extId}/src/ui/options.html#blocks`, { waitUntil: 'load' });
    await sleep(400);
    check('options: Blocked scripts lists the block', await opt.evaluate(() => /localhost/.test(document.getElementById('blockRows').innerText)));
    if (SHOTS) await opt.screenshot({ path: path.join(SHOTS, 'options-blocks-list.png') });
    const refused = await extPage.evaluate((i) => chrome.runtime.sendMessage({ type: 'sg:block', kind: 'host', value: '127.0.0.1', tabId: i }), tabId);
    check('blocks: blocking the tab\'s own site is refused', !!refused.error, JSON.stringify(refused));
    const fromPage = await pg.evaluate(() => new Promise((res) => { try { chrome.runtime.sendMessage('x', {}, () => res('replied')); setTimeout(() => res('none'), 300); } catch { res('none'); } }));
    check('blocks: web pages cannot reach the block API', fromPage === 'none', fromPage);

    // Unblock from the popup, reload, script runs again.
    pop = await popupFor(null);
    await pop.click('#scripts li:first-child button');
    await sleep(600);
    const left = await sw.evaluate(async () => ((await chrome.storage.local.get('sg.blocks'))['sg.blocks'] || []).length);
    check('popup: Unblock removes the block', left === 0, 'n=' + left);
    await pg.reload({ waitUntil: 'load' });
    await sleep(800);
    check('blocks: script runs again after unblock', (await ran()).ad === 1);
    await pop.close();
    await opt.close();
    await pg.close();
    sp.close();
  }
  // ===== END scripts panel e2e =====
  // Options page: every section renders and the nav switches sections.
  {
    const pg = await browser.newPage();
    await pg.setViewport({ width: 1100, height: 760, deviceScaleFactor: 1 });
    const pageErrors = [];
    pg.on('pageerror', (e) => pageErrors.push(e.message));
    for (const sec of ['sites', 'rules', 'blocks', 'import', 'hardening', 'extensions', 'backup']) {
      await pg.goto(`chrome-extension://${extId}/src/ui/options.html#${sec}`, { waitUntil: 'load' });
      await sleep(250);
      const visible = await pg.evaluate(() => [...document.querySelectorAll('.content section')].filter((s) => !s.hidden).map((s) => s.dataset.sec));
      check(`options: #${sec} shows only its section`, visible.length === 1 && visible[0] === sec, visible.join());
      if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, `options-${sec}.png`) });
    }
    check('options: no script errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));
    await pg.close();
  }
  // --- notice agent: in-page toast + toolbar badge for a blocked ClickFix attempt ---
  // The toast lives in a CLOSED shadow root, which puppeteer cannot pierce, so we assert on the host
  // element's data-sg-state / data-sg-count attributes (fixed tokens + a number, set by notice.js)
  // and on the accessibility tree (role=status text is exposed through closed roots).
  {
    const pg = await open(`${A}/clickfix.html`);
    await pg.click('#go').catch(() => {});
    await pg.waitForFunction('window.__done === true', { timeout: 8000 }).catch(() => {});
    await pg.waitForFunction(() => document.querySelector('script-guard-notice')?.getAttribute('data-sg-state') === 'shown', { timeout: 5000 }).catch(() => {});
    const hostState = await pg.evaluate(() => { const h = document.querySelector('script-guard-notice'); return h ? { s: h.getAttribute('data-sg-state'), c: h.getAttribute('data-sg-count') } : null; });
    check('notice: toast host is shown in the top frame', hostState && hostState.s === 'shown' && Number(hostState.c) >= 1, JSON.stringify(hostState));
    const ax = JSON.stringify(await pg.accessibility.snapshot({ interestingOnly: false }).catch(() => null));
    check('notice: toast text is in the accessibility tree', /Script Guard blocked a command/.test(ax));
    const tid = await tabIdFor(A);
    const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tid);
    const title = await sw.evaluate((id) => chrome.action.getTitle({ tabId: id }), tid);
    check('notice: toolbar badge counts blocked events', Number.parseInt(badge, 10) >= 1, `badge=${badge} title=${title}`);
    check('notice: toolbar title mentions blocked count', /Script Guard: \d+ blocked on this tab/.test(title), title);
    await pg.close();
  }
  check('service worker logged no errors', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  fail++;
  console.log('FAIL  harness error: ' + (e && e.stack || e));
} finally {
  await browser.close().catch(() => {});
  srv.close();
}
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
