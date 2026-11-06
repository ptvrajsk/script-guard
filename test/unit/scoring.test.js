import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreScript, shannonEntropy } from '../../src/shared/scoring.js';

// Benign: a minified-library-like body (realistic shapes, lots of short identifiers and punctuation).
const benign = (() => {
  const parts = [];
  for (let i = 0; i < 120; i++) {
    parts.push(`function n${i}(t,e){var r=t.length,o=[];for(var a=0;a<r;a++){e(t[a],a)&&o.push(t[a])}return o}`);
    parts.push(`n${i}.prototype.get=function(t){return this._d[t]||void 0};var s${i}={version:"3.${i}.1",on:function(t,e){(this._h[t]=this._h[t]||[]).push(e)}};`);
  }
  return '/*! lib v3 | MIT */(function(g){"use strict";' + parts.join('') + 'g.lib=s0})(window);';
})();

const obfuscated = (() => {
  const names = Array.from({ length: 40 }, (_, i) => `_0x${(0x1a2b + i * 37).toString(16)}`);
  const arr = Array.from({ length: 60 }, (_, i) => `'${Buffer.from('payload' + i).toString('base64')}'`);
  return `var _0x5f3a=[${arr.join(',')}];(function(_0x1111,_0x2222){var _0x3333=function(_0x4444){while(--_0x4444){_0x1111['push'](_0x1111['shift']());}};` +
    `while(!![]){try{var _0x5555=parseInt(_0x4aa2(0x1))/0x1+parseInt(_0x4aa2(0x2))/0x2;if(_0x5555===_0x2222)break;else _0x1111['push'](_0x1111['shift']());}catch(_0x6666){_0x1111['push'](_0x1111['shift']());}}}(_0x5f3a,0x1b3));` +
    names.map((n) => `var ${n}=function(){return eval(atob('${Buffer.from('x'.repeat(40)).toString('base64')}'))};`).join('') +
    `eval(atob('${'QUJD'.repeat(120)}'));`;
})();

test('benign minified library scores low', () => {
  const r = scoreScript(benign, { url: 'https://cdn.example.com/lib.js', pageOrigin: 'https://example.com' });
  assert.ok(r.score < 25, JSON.stringify(r));
});

test('obfuscator.io style stub scores high with specific reasons', () => {
  const r = scoreScript(obfuscated, { url: 'https://evil.test/a.js', pageOrigin: 'https://example.com' });
  const ids = r.reasons.map((x) => x.id);
  assert.ok(r.score >= 60, JSON.stringify(r));
  for (const id of ['obfuscator.hexnames', 'obfuscator.loop', 'eval.density', 'blob.base64', 'third-party']) assert.ok(ids.includes(id), id);
  assert.ok(r.score <= 100);
});

test('miner indicator', () => {
  const r = scoreScript('var s="stratum+tcp://pool.example:3333";new CoinHive.Anonymous("k").start();', {});
  assert.ok(r.reasons.some((x) => x.id === 'miner'));
  assert.ok(r.score >= 50);
});

test('wasm worker pool miner shape', () => {
  const r = scoreScript('const n=navigator.hardwareConcurrency;for(let i=0;i<n;i++){new Worker("w.js")}WebAssembly.instantiate(buf)', {});
  assert.ok(r.reasons.some((x) => x.id === 'miner.wasm-workers'));
});

test('hidden iframe writer', () => {
  const r = scoreScript(`document.write('<iframe src="http://x.test/" width="0" height="0"></iframe>')`, {});
  assert.ok(r.reasons.some((x) => x.id === 'iframe.hidden'));
  const r2 = scoreScript(`var f=document.createElement('iframe');f.style.display='none';document.body.appendChild(f)`, {});
  assert.ok(r2.reasons.some((x) => x.id === 'iframe.hidden'));
});

test('third-party only when hosts are unrelated', () => {
  const t = 'var a=1;';
  assert.ok(!scoreScript(t, { url: 'https://static.example.com/a.js', pageOrigin: 'https://example.com' }).reasons.some((x) => x.id === 'third-party'));
  assert.ok(!scoreScript(t, { url: 'https://example.com/a.js', pageOrigin: 'https://example.com' }).reasons.length);
  assert.ok(scoreScript(t, { url: 'https://other.org/a.js', pageOrigin: 'https://example.com' }).reasons.some((x) => x.id === 'third-party'));
  assert.equal(scoreScript(t, { url: 'garbage' }).score, 0);
});

test('blobs: base64 and \\x escapes', () => {
  assert.ok(scoreScript('var d="' + 'A1b2'.repeat(100) + '";', {}).reasons.some((x) => x.id === 'blob.base64'));
  assert.ok(scoreScript('var d="' + '\\x41'.repeat(60) + '";', {}).reasons.some((x) => x.id === 'blob.hexescape'));
});

test('robustness: empty, non-string, huge', () => {
  assert.equal(scoreScript('', {}).score, 0);
  assert.equal(scoreScript(undefined).score, 0);
  const t0 = Date.now();
  scoreScript('a'.repeat(6 * 1024 * 1024), {});
  assert.ok(Date.now() - t0 < 5000);
});

test('entropy helper', () => {
  assert.equal(shannonEntropy(''), 0);
  assert.equal(shannonEntropy('aaaa'), 0);
  assert.ok(Math.abs(shannonEntropy('abab') - 1) < 1e-9);
});
