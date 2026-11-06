import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, sanitizeReport, mergeReport, emptyStore, isThirdParty, buildView, fromContentScript, fromExtensionPage, MAX_SCRIPTS, MAX_FRAMES } from '../../src/background/pagescripts.js';

const EXT = 'extid';
const rep = (urls, inline = 0) => ({ frameUrl: 'https://a.com/', inline, scripts: urls.map((url) => ({ url, async: false, defer: false })) });

test('cleanUrl accepts only bounded http(s) urls and drops fragments', () => {
  assert.equal(cleanUrl('https://a.com/x.js#h'), 'https://a.com/x.js');
  for (const u of ['javascript:1', 'data:text/javascript,1', 'chrome-extension://x/a.js', 'blob:https://a.com/1', 'nope', 5, null, 'https://a.com/' + 'x'.repeat(500)]) assert.equal(cleanUrl(u), '', String(u));
});

test('sanitizeReport treats input as untrusted', () => {
  assert.equal(sanitizeReport(null), null);
  assert.equal(sanitizeReport({ scripts: 'x' }), null);
  const r = sanitizeReport({ frameUrl: 'f'.repeat(900), inline: -4, scripts: [null, 7, { url: 'ftp://a/b' }, { url: 'https://a.com/a.js', async: 'yes', defer: true }] });
  assert.equal(r.frameUrl.length, 500);
  assert.equal(r.inline, 0);
  assert.deepEqual(r.scripts, [{ url: 'https://a.com/a.js', async: false, defer: true }]);
  assert.equal(sanitizeReport({ scripts: [], inline: 1e9 }).inline, 10000);
  assert.equal(sanitizeReport({ scripts: Array.from({ length: 1000 }, (_, i) => ({ url: `https://a.com/${i}.js` })) }).scripts.length, MAX_SCRIPTS);
});

test('mergeReport dedupes across frames, ORs flags, sums inline per frame', () => {
  let s = mergeReport(emptyStore(), { ...rep(['https://a.com/1.js']), inline: 2 }, 0);
  s = mergeReport(s, { scripts: [{ url: 'https://a.com/1.js', async: true, defer: false }, { url: 'https://b.com/2.js', async: false, defer: false }], inline: 3 }, 7);
  assert.equal(s.scripts.length, 2);
  assert.equal(s.scripts[0].async, true);
  s = mergeReport(s, { ...rep([]), inline: 5 }, 0); // later report for frame 0 replaces its count
  assert.equal(buildView(s, 'https://a.com/', []).inline, 8);
});

test('mergeReport does not mutate its input and caps entries and frames', () => {
  const a = mergeReport(emptyStore(), rep(['https://a.com/1.js']), 0);
  const snap = JSON.stringify(a);
  mergeReport(a, rep(['https://a.com/2.js']), 1);
  assert.equal(JSON.stringify(a), snap);
  let s = emptyStore();
  s = mergeReport(s, rep(Array.from({ length: 10 }, (_, i) => `https://a.com/${i}.js`)), 0, 4);
  assert.equal(s.scripts.length, 4);
  s = mergeReport(s, rep(['https://a.com/0.js']), 0, 4); // existing entries still merge at the cap
  assert.equal(s.scripts.length, 4);
  for (let f = 0; f < MAX_FRAMES + 20; f++) s = mergeReport(s, rep([], 1), f);
  assert.equal(Object.keys(s.inline).length, MAX_FRAMES);
});

test('isThirdParty compares registrable domains', () => {
  assert.equal(isThirdParty('cdn.example.com', 'www.example.com'), false);
  assert.equal(isThirdParty('example.com', 'news.example.com'), false);
  assert.equal(isThirdParty('ads.other.net', 'news.example.com'), true);
  assert.equal(isThirdParty('a.co.uk', 'b.co.uk'), true);
  assert.equal(isThirdParty('x.a.co.uk', 'a.co.uk'), false);
  assert.equal(isThirdParty('notexample.com', 'example.com'), true);
  assert.equal(isThirdParty('localhost', '127.0.0.1'), true);
  assert.equal(isThirdParty('a.com', ''), false);
});

test('buildView orders third-party first and marks blocked', () => {
  const s = mergeReport(emptyStore(), rep(['https://www.example.com/app.js', 'https://ads.evil.net/t.js?x=1', 'https://cdn.example.com/lib.js', 'https://stats.other.org/s.js']), 0);
  const v = buildView(s, 'https://www.example.com/page', [{ id: 'b', kind: 'host', value: 'evil.net', createdAt: 0 }]);
  assert.deepEqual(v.scripts.map((x) => x.host), ['ads.evil.net', 'stats.other.org', 'www.example.com', 'cdn.example.com']);
  assert.deepEqual(v.scripts.map((x) => x.thirdParty), [true, true, false, false]);
  assert.deepEqual(v.scripts.map((x) => x.blocked), [true, false, false, false]);
  assert.equal(v.scripts[0].path, '/t.js?x=1');
});

test('sender checks keep content scripts and extension pages apart', () => {
  const web = { tab: { id: 1 }, id: EXT, url: 'https://a.com/' };
  const popup = { id: EXT, url: `chrome-extension://${EXT}/src/ui/popup.html` };
  const optionsTab = { tab: { id: 4 }, id: EXT, url: `chrome-extension://${EXT}/src/ui/options.html` };
  assert.equal(fromContentScript(web, EXT), true);
  assert.equal(fromContentScript(popup, EXT), false);
  assert.equal(fromContentScript(optionsTab, EXT), false);
  assert.equal(fromContentScript({ ...web, id: 'other' }, EXT), false);
  assert.equal(fromExtensionPage(popup, EXT), true);
  assert.equal(fromExtensionPage(optionsTab, EXT), true); // options can open in a tab
  assert.equal(fromExtensionPage(web, EXT), false);      // content script: same id, web url
  assert.equal(fromExtensionPage({ id: EXT, url: 'chrome-extension://evil/x.html' }, EXT), false);
  assert.equal(fromExtensionPage({ id: 'other', url: `chrome-extension://${EXT}/a` }, EXT), false);
});
