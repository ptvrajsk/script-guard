// Builds dist/script-guard-<version>.zip containing only what the extension needs at runtime.
// Usage: node tools/package.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['manifest.json', 'LICENSE', 'src', 'data', 'icons'];
const BLOCKED = /(^|\/)(\.env|\.git|node_modules|test|docs|tools|spike|\.claude)(\/|$)|\.(pem|key|log|map)$|(^|\/)id_(rsa|ed25519|ecdsa)/;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`Version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);

function walk(p, out = []) {
  const abs = path.join(ROOT, p);
  if (fs.statSync(abs).isDirectory()) for (const f of fs.readdirSync(abs).sort()) walk(path.posix.join(p, f), out);
  else out.push(p);
  return out;
}
const files = INCLUDE.flatMap((p) => { if (!fs.existsSync(path.join(ROOT, p))) throw new Error('missing ' + p); return walk(p); });
const bad = files.filter((f) => BLOCKED.test(f));
if (bad.length) throw new Error('refusing to package: ' + bad.join(', '));

const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `script-guard-${manifest.version}.zip`);
fs.rmSync(out, { force: true });
// -X drops extra file attributes; fixed order keeps the listing stable.
execFileSync('zip', ['-X', '-q', out, ...files], { cwd: ROOT });
const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
console.log(`${path.relative(ROOT, out)}  ${files.length} files  ${(fs.statSync(out).size / 1024).toFixed(0)} KB\nsha256 ${sha}`);
