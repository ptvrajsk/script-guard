import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesPattern, hashText, applyRule, diffToOps, validateRule } from '../../src/shared/patch.js';

const rule = (ops, extra = {}) => ({ id: 'r', name: 'n', enabled: true, urlPattern: '*', ops, createdAt: 1, ...extra });

test('matchesPattern', () => {
  assert.ok(matchesPattern('https://a.com/x.js', 'https://a.com/x.js#frag'));
  assert.ok(matchesPattern('https://*.a.com/*.js', 'https://cdn.a.com/lib/x.js'));
  assert.ok(matchesPattern('*', 'anything'));
  assert.ok(!matchesPattern('https://a.com/x.js', 'https://a.com/x.jsx'));
  assert.ok(!matchesPattern('https://a.com/*', 'https://evil.com/https://a.com/x'));
  assert.ok(matchesPattern('**a**', 'zzazz'));
  assert.ok(!matchesPattern('*a*a*a*a*a*b', 'a'.repeat(5000))); // no catastrophic backtracking
});

test('hashText is sha256 hex', async () => {
  assert.equal(await hashText('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('replace exactly once; zero and multiple matches are skipped + stale', () => {
  let r = applyRule('a b c', rule([{ type: 'replace', find: 'b', replace: 'X' }]));
  assert.equal(r.text, 'a X c'); assert.deepEqual(r.applied, [0]); assert.equal(r.stale, false);
  r = applyRule('a b c', rule([{ type: 'replace', find: 'zz', replace: 'X' }]));
  assert.equal(r.text, 'a b c'); assert.equal(r.stale, true); assert.equal(r.skipped[0].reason, 'no-match');
  r = applyRule('b b', rule([{ type: 'replace', find: 'b', replace: 'X' }]));
  assert.equal(r.text, 'b b'); assert.equal(r.skipped[0].reason, 'ambiguous');
  r = applyRule('b b', rule([{ type: 'replace', find: 'b', replace: 'X', all: true }]));
  assert.equal(r.text, 'X X');
});

test('overlapping anchors count as ambiguous', () => {
  assert.equal(applyRule('aaa', rule([{ type: 'replace', find: 'aa', replace: 'X' }])).skipped[0].reason, 'ambiguous');
});

test('regex ops are refused (no user regex support, no ReDoS)', () => {
  const r = applyRule('id=12', rule([{ type: 'replace', find: 'id=(\\d+)', replace: 'n', regex: true }]));
  assert.equal(r.skipped[0].reason, 'regex-not-supported');
  assert.equal(r.text, 'id=12');
  assert.equal(r.stale, true);
  const t = Date.now();
  applyRule('a'.repeat(41) + '!', rule([{ type: 'replace', find: '(a|aa)+$', replace: 'x', regex: true }]));
  assert.ok(Date.now() - t < 500);
  assert.ok(!validateRule(rule([{ type: 'replace', find: 'a', replace: 'x', regex: true }])).ok);
  assert.ok(validateRule(rule([{ type: 'replace', find: 'a', replace: 'x', regex: false }])).ok);
  assert.ok(diffToOps('a\nb\nc\n', 'a\nB\nc\n').every((o) => !o.regex));
});

test('insertBefore / insertAfter / deleteLine', () => {
  const t = 'one\ntwo\nthree\n';
  assert.equal(applyRule(t, rule([{ type: 'insertBefore', anchor: 'two', text: 'X\n' }])).text, 'one\nX\ntwo\nthree\n');
  assert.equal(applyRule(t, rule([{ type: 'insertAfter', anchor: 'two\n', text: 'X\n' }])).text, 'one\ntwo\nX\nthree\n');
  assert.equal(applyRule(t, rule([{ type: 'deleteLine', anchor: 'tw' }])).text, 'one\nthree\n');
  assert.equal(applyRule('a\nb', rule([{ type: 'deleteLine', anchor: 'a' }])).text, 'b');
});

test('ops are evaluated against the original text, order independent', () => {
  // the first op inserts text containing the second op's anchor; the second must still match once
  const t = 'A\nB\n';
  const r = applyRule(t, rule([
    { type: 'insertBefore', anchor: 'A', text: 'B\n' },
    { type: 'replace', find: 'B', replace: 'C' },
  ]));
  assert.equal(r.text, 'B\nA\nC\n'); assert.equal(r.stale, false);
});

test('overlapping edits: later one skipped', () => {
  const r = applyRule('abcdef', rule([
    { type: 'replace', find: 'bcd', replace: 'X' },
    { type: 'replace', find: 'cde', replace: 'Y' },
  ]));
  assert.equal(r.text, 'aXef'); assert.equal(r.skipped[0].reason, 'overlap'); assert.equal(r.stale, true);
});

test('blockScript', () => {
  const r = applyRule('x', rule([{ type: 'blockScript' }]));
  assert.equal(r.blocked, true); assert.equal(r.text, 'x');
});

test('validateRule', () => {
  assert.ok(validateRule(rule([{ type: 'blockScript' }])).ok);
  assert.ok(!validateRule(rule([])).ok);
  assert.ok(!validateRule(rule([{ type: 'replace', find: '', replace: 'x' }])).ok);
  assert.ok(!validateRule(rule([{ type: 'nope' }])).ok);
  assert.ok(!validateRule(rule([{ type: 'replace', find: '(a+)+', replace: 'x', regex: true }])).ok);
  assert.ok(!validateRule(rule([{ type: 'blockScript' }], { expectedHash: 'xyz' })).ok);
  assert.ok(!validateRule(rule([{ type: 'blockScript' }], { resourceType: 'Image' })).ok);
  assert.ok(!validateRule(null).ok);
});

// ---------- diffToOps ----------
function roundTrip(a, b) {
  const ops = diffToOps(a, b);
  const r = applyRule(a, rule(ops.length ? ops : [{ type: 'blockScript' }]));
  assert.equal(r.stale, false, `stale for ${JSON.stringify([a, b])} ops ${JSON.stringify(ops)}`);
  assert.equal(r.text, b, `mismatch for ${JSON.stringify([a, b])} ops ${JSON.stringify(ops)}`);
  return ops;
}

test('diffToOps: minimal unique anchors', () => {
  const a = 'var a = 1;\nvar b = 2;\nvar c = 3;\n';
  let ops = roundTrip(a, 'var a = 1;\nvar b = 20;\nvar c = 3;\n');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, 'replace');
  assert.ok(ops[0].find.length <= 6, ops[0].find);
  ops = roundTrip(a, 'var a = 1;\nvar c = 3;\n');
  assert.deepEqual(ops, [{ type: 'deleteLine', anchor: 'var b' }]);
  ops = roundTrip(a, 'var a = 1;\nlog();\nvar b = 2;\nvar c = 3;\n');
  assert.deepEqual(ops, [{ type: 'insertBefore', anchor: 'var b', text: 'log();\n' }]);
  ops = roundTrip(a, a + 'end();\n');
  assert.equal(ops[0].type, 'insertAfter');
  assert.deepEqual(diffToOps(a, a), []);
});

test('diffToOps: duplicate lines and blank lines get disambiguating context', () => {
  roundTrip('x\n\n\nx\n\n', 'x\n\n\nx\ny\n\n');
  roundTrip('a\na\na\n', 'a\nb\na\na\n');
  roundTrip('a\na\na\n', 'a\na\n');
  roundTrip('\n\n\n', '\n\n');
  roundTrip('foo(1);foo(1);', 'foo(1);foo(2);');
  roundTrip('abc', 'abcd');
  roundTrip('abc', 'xabc');
  roundTrip('a\r\nb\r\n', 'a\r\nc\r\n');
  roundTrip('a\nb', 'a\nb\n');
  roundTrip('a\nb\n', 'a\nb');
  roundTrip('abc', '');
  roundTrip('héllo\nwörld ✓\n', 'héllo\nwörld ✗\n');
  assert.throws(() => diffToOps('', 'x'));
});

// deterministic PRNG
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

test('diffToOps round-trip property (generated cases)', () => {
  const R = rng(12345);
  const vocab = ['a', 'b', 'x', ' ', '\n', '\n', '\r\n', ';', 'foo', 'bar();', 'é', '\n\n', 'var x = 1;\n', 'if(a){\n', '}\n'];
  const gen = (n) => { let s = ''; for (let i = 0; i < n; i++) s += vocab[Math.floor(R() * vocab.length)]; return s; };
  const mutate = (s) => {
    const k = 1 + Math.floor(R() * 4);
    for (let i = 0; i < k; i++) {
      const p = Math.floor(R() * (s.length + 1)), q = Math.min(s.length, p + Math.floor(R() * 6));
      const mode = Math.floor(R() * 3);
      const ins = gen(Math.floor(R() * 3));
      s = mode === 0 ? s.slice(0, p) + ins + s.slice(p) : mode === 1 ? s.slice(0, p) + s.slice(q) : s.slice(0, p) + ins + s.slice(q);
    }
    return s;
  };
  let cases = 0;
  for (let i = 0; i < 3000; i++) {
    const a = gen(1 + Math.floor(R() * 40));
    const b = R() < 0.1 ? gen(Math.floor(R() * 40)) : mutate(a);
    if (a === '') continue;
    roundTrip(a, b);
    cases++;
  }
  assert.ok(cases > 2500);
});

test('diffToOps on a larger realistic script', () => {
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(`function f${i % 50}(x){return x+${i % 7};}`);
  const a = lines.join('\n') + '\n';
  const b2 = lines.slice();
  b2[100] = 'function f0(x){return x*2;}'; b2.splice(250, 1); b2.splice(400, 0, 'track();');
  roundTrip(a, b2.join('\n') + '\n');
});

// ---------- minified single-line scripts: edits must stay small ----------
test('diffToOps: minified one-line file with a line added at the top and a trailing newline stays small', () => {
  const min = '"use strict";(()=>{var e=(e,t)=>()=>(e&&(t=e(e=0)),t);function n(e){let t=location.href;return t+e}' + 'function f(a){return a*2+n(a)}'.repeat(400) + '})();';
  const patched = 'var added=1;\n' + min + '\n';
  const ops = diffToOps(min, patched);
  assert.ok(JSON.stringify(ops).length < 600, 'ops should be small, got ' + JSON.stringify(ops).length);
  assert.equal(applyRule(min, { ops }).text, patched);
});

test('diffToOps: two distant edits in a minified file give two small ops', () => {
  const body = Array.from({ length: 500 }, (_, i) => `function f${i}(a){return a+${i}}`).join('');
  const min = '(()=>{' + body + '})();';
  const patched = min.replace('function f10(a){return a+10}', 'function f10(a){return a+11}').replace('function f400(a){return a+400}', 'function f400(a){return a+401}');
  const ops = diffToOps(min, patched);
  assert.ok(JSON.stringify(ops).length < 800, 'got ' + JSON.stringify(ops).length);
  assert.equal(applyRule(min, { ops }).text, patched);
});
