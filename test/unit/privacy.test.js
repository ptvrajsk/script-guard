// Guards the "no telemetry" promise. Fails if extension code gains a network path or a remote-code hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p, out) : /\.(js|html)$/.test(p) && out.push(p);
  }
  return out;
}
const files = walk(join(root, 'src'));
const read = (p) => readFileSync(p, 'utf8');

test('no beacon, XHR, EventSource, or remote script/import in extension code', () => {
  const banned = [/sendBeacon/, /XMLHttpRequest/, /new\s+EventSource/, /importScripts\s*\(/, /<script[^>]+src=["']https?:/i, /import\s*\(\s*["']https?:/, /from\s+["']https?:/];
  for (const f of files) for (const re of banned) assert.ok(!re.test(read(f)), `${f} matches ${re}`);
});

test('fetch is only used for bundled data or the user-triggered importer', () => {
  const allowed = { 'src/background/dnr.js': 1, 'src/ui/options.js': 1 };
  for (const f of files) {
    const n = (read(f).match(/\bfetch\s*\(/g) || []).length;
    const rel = f.slice(root.length);
    assert.ok(n <= (allowed[rel] || 0), `${rel} has ${n} fetch() calls; review for telemetry`);
  }
  assert.match(read(join(root, 'src/background/dnr.js')), /fetch\(chrome\.runtime\.getURL\(/);
});

test('manifest has no externally_connectable, update_url, or web-accessible resources', () => {
  const m = JSON.parse(read(join(root, 'manifest.json')));
  for (const k of ['externally_connectable', 'update_url', 'web_accessible_resources']) assert.equal(m[k], undefined, k);
});
