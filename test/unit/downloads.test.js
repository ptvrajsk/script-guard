import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDownload as c, gateAction } from '../../src/background/downloads.js';

test('executables are high risk', () => {
  for (const f of ['setup.exe', 'a.MSI', 'x.scr', 'link.lnk', 'disk.iso', 'p.hta', 'run.js', 'a.ps1', 'x.bat', 'Setup.EXE.'])
    assert.equal(c({ filename: f }).risk, 'high', f);
});
test('double extension decoy', () => {
  const r = c({ filename: 'invoice.pdf.exe' });
  assert.equal(r.risk, 'high'); assert.match(r.reason, /double extension/);
});
test('risky MIME with benign name', () => {
  assert.equal(c({ filename: 'download', mime: 'application/x-msdownload' }).risk, 'high');
  assert.equal(c({ filename: 'a.bin', mime: 'application/x-msdos-program; charset=x' }).risk, 'high');
});
test('risky ext only in URL when filename has none', () => {
  assert.equal(c({ filename: 'dl', url: 'https://x.org/get/tool.exe?x=1' }).risk, 'high');
});
test('archives low, escalate without gesture', () => {
  assert.equal(c({ filename: 'a.zip' }).risk, 'low');
  assert.equal(c({ filename: 'a.zip', hadGesture: true }).risk, 'low');
  assert.equal(c({ filename: 'a.zip', hadGesture: false }).risk, 'high');
});
test('benign downloads', () => {
  assert.equal(c({ filename: 'report.pdf', mime: 'application/pdf' }).risk, 'none');
  assert.equal(c({ filename: 'photo.jpg', mime: 'application/octet-stream' }).risk, 'none');
  assert.equal(c({ filename: 'photo.jpg', hadGesture: false }).risk, 'none');
  assert.equal(c({}).risk, 'none');
  assert.equal(c({ filename: 'C:\\Users\\a\\notes.txt' }).risk, 'none');
  assert.equal(c({ filename: 'example.com' , url: 'https://example.com/'}).risk, 'high'); // .com is a DOS executable extension
});
test('path components do not count as extension', () => {
  assert.equal(c({ filename: 'dir.exe/readme' }).risk, 'none');
});
test('gateAction per profile', () => {
  assert.equal(gateAction('trusted', 'high'), 'allow');
  assert.equal(gateAction('default', 'high'), 'warn');
  assert.equal(gateAction('default', 'none'), 'allow');
  assert.equal(gateAction('strict', 'high'), 'block');
  assert.equal(gateAction('strict', 'low'), 'warn');
});

import { handleMessage, recentEvents, createStore, senderMeta, MAX_PER_KIND } from '../../src/background/events.js';

test('forged frameUrl/tabUrl in an event payload is ignored; sender URL is used', async () => {
  const sender = { id: 'x', url: 'https://evil.example/page', tab: { id: 7, url: 'https://evil.example/' } };
  const r = await handleMessage({ type: 'sg:event', kind: 'download.auto', frameUrl: 'https://victim.example/', tabUrl: 'https://victim.example/', detail: {} }, sender);
  assert.equal(r.ok, true);
  assert.equal(recentEvents('download.auto', 10000, 'https://victim.example').length, 0);
  const own = recentEvents('download.auto', 10000, 'https://evil.example');
  assert.equal(own.length, 1);
  assert.equal(own[0].frameUrl, 'https://evil.example/page');
  assert.equal(own[0].tabUrl, 'https://evil.example/');
  assert.equal(recentEvents('download.auto', 10000, '').length, 0); // empty origin matches nothing
});

test('per-kind cap: a flood of clipboard.write does not evict clipboard.risky', () => {
  const s = createStore();
  const meta = senderMeta({ url: 'https://a.example/', tab: { url: 'https://a.example/' } });
  for (let i = 0; i < 3; i++) s.record(1, { kind: 'clipboard.risky', action: 'blocked', detail: { i } }, i, meta);
  for (let i = 0; i < 1000; i++) s.record(1, { kind: 'clipboard.write', detail: { i } }, i, meta);
  const ev = s.get(1);
  assert.equal(ev.filter((e) => e.kind === 'clipboard.risky').length, 3);
  assert.equal(ev.filter((e) => e.kind === 'clipboard.write').length, MAX_PER_KIND);
  assert.equal(s.blocked(1), 3);
  assert.equal(ev.find((e) => e.kind === 'clipboard.write').detail.i, 1000 - MAX_PER_KIND); // newest kept
  assert.ok(ev.length <= 200);
});
