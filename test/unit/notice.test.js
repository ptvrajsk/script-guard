import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createLimiter, badgeTitle, badgeLabel, createStore } from '../../src/background/events.js';

const src = fs.readFileSync(new URL('../../src/content/notice.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(src, sandbox);
const { noticeText, cleanCount, TEXT, FALLBACK } = sandbox.module.exports;

test('notice text comes from the fixed map', () => {
  assert.match(noticeText('clipboard.risky'), /Don't paste it into Run, a terminal or PowerShell/);
  assert.equal(noticeText('<img src=x onerror=alert(1)>'), FALLBACK);
  assert.equal(noticeText('__proto__'), FALLBACK);
  assert.equal(noticeText('constructor'), FALLBACK);
  assert.ok(Object.values(TEXT).every(t => t.startsWith('Script Guard')));
});
test('cleanCount bounds', () => {
  assert.equal(cleanCount(3), 3);
  assert.equal(cleanCount('x'), 1);
  assert.equal(cleanCount(-5), 1);
  assert.equal(cleanCount(1e9), 9999);
});
test('limiter allows once per gap per key', () => {
  const l = createLimiter(1000);
  assert.equal(l.allow(1, 0), true);
  assert.equal(l.allow(1, 500), false);
  assert.equal(l.allow(2, 500), true);
  assert.equal(l.allow(1, 1000), true);
  l.reset(1);
  assert.equal(l.allow(1, 1001), true);
});
test('badge helpers and blocked count', () => {
  assert.equal(badgeTitle(3), 'Script Guard: 3 blocked on this tab');
  assert.equal(badgeTitle(0), 'Script Guard');
  assert.equal(badgeLabel(0), '');
  assert.equal(badgeLabel(150), '99+');
  const s = createStore();
  s.record(1, { kind: 'eval', action: 'logged' });
  s.record(1, { kind: 'clipboard.risky', action: 'blocked' });
  assert.equal(s.blocked(1), 1);
  assert.equal(s.count(1), 2);
});
