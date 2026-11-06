// Script scoring: pure heuristics, no chrome.* usage. A warning signal, never an auto-blocker.
// scoreScript(text, { url, pageOrigin }) -> { score: 0-100, reasons: [{ id, weight, detail }] }

export const MAX_SCAN = 4 * 1024 * 1024; // only the first 4 MB are scanned

export function shannonEntropy(s) {
  if (!s.length) return 0;
  const freq = new Map();
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); freq.set(c, (freq.get(c) || 0) + 1); }
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

const count = (text, re) => { let n = 0; const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while (g.exec(text)) { n++; if (n > 100000) break; } return n; };

function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } }

export function scoreScript(text, { url, pageOrigin } = {}) {
  const reasons = [];
  const add = (id, weight, detail) => reasons.push({ id, weight, detail });
  if (typeof text !== 'string') text = '';
  const t = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const kb = Math.max(t.length / 1024, 1);

  // entropy: only meaningful on a decent sample; minified code sits ~5.0-5.6, packed/encoded data above 5.9
  if (t.length >= 2048) {
    const h = shannonEntropy(t.slice(0, 200000));
    if (h > 5.9) add('entropy', 15, `Shannon entropy ${h.toFixed(2)} bits/char`);
    else if (h > 5.7) add('entropy', 6, `Shannon entropy ${h.toFixed(2)} bits/char`);
  }

  // obfuscator.io signatures
  const hexIds = count(t, /\b_0x[0-9a-f]{4,6}\b/);
  if (hexIds >= 10) add('obfuscator.hexnames', Math.min(40, 20 + hexIds / 10), `${hexIds} _0x-style identifiers`);
  if (/while\s*\(\s*!!\s*\[\s*\]\s*\)/.test(t)) add('obfuscator.loop', 15, 'while(!![]) control loop');
  if (/\bparseInt\s*\(\s*_0x[0-9a-f]+\s*\(/.test(t) && /\['push'\]\s*\(\s*\w+\s*\[\s*'shift'\s*\]/.test(t)) add('obfuscator.rotation', 20, 'string-array rotation');
  if (/\[\s*(?:'[^']{1,40}'\s*,\s*){40,}/.test(t) && hexIds >= 3) add('obfuscator.stringarray', 10, 'large string array');

  // dynamic code execution density
  const evals = count(t, /\beval\s*\(/) + count(t, /\bnew\s+Function\s*\(/) + count(t, /\bFunction\s*\(\s*['"]/);
  const atobs = count(t, /\batob\s*\(/) + count(t, /\bunescape\s*\(/) + count(t, /String\s*\.\s*fromCharCode/);
  if (evals >= 1) {
    const dens = evals / kb;
    add('eval.density', Math.min(30, 8 + Math.round(dens * 40) + evals * 2), `${evals} eval/Function call(s), ${dens.toFixed(2)}/KB`);
  }
  if (atobs >= 3 && atobs / kb > 0.05) add('decode.density', Math.min(20, 5 + atobs), `${atobs} atob/unescape/fromCharCode call(s)`);
  if (evals && atobs) add('eval+decode', 15, 'decodes data and executes it');

  // blobs
  const b64 = t.match(/[A-Za-z0-9+/]{300,}={0,2}/g);
  if (b64) add('blob.base64', Math.min(25, 10 + b64.length * 3), `${b64.length} base64-like blob(s), longest ${Math.max(...b64.map((x) => x.length))} chars`);
  const hexEsc = t.match(/(?:\\x[0-9a-fA-F]{2}){40,}/g);
  if (hexEsc) add('blob.hexescape', Math.min(25, 10 + hexEsc.length * 3), `${hexEsc.length} \\x escape run(s)`);
  const hexRun = t.match(/(?<![0-9a-zA-Z])[0-9a-f]{200,}(?![0-9a-zA-Z])/g);
  if (hexRun) add('blob.hex', 10, `${hexRun.length} long hex string(s)`);

  // miners
  const miner = /stratum\+(?:tcp|ssl):\/\/|coinhive|cryptonight|coin-hive|CoinImp|webminepool|minero\.cc|\bhashrate\b|\bnonce\b[^;]{0,80}\bhashes?\b/i.exec(t);
  if (miner) add('miner', 50, `miner indicator "${miner[0].slice(0, 40)}"`);
  else if (/WebAssembly\s*\.\s*(?:instantiate|compile)/.test(t) && /new\s+Worker\s*\(/.test(t) && /navigator\s*\.\s*hardwareConcurrency/.test(t)) add('miner.wasm-workers', 25, 'WASM plus worker pool sized by hardwareConcurrency');

  // hidden iframe writers
  const hiddenFrame = /(?:document\s*\.\s*write(?:ln)?\s*\(|innerHTML\s*\+?=)\s*[^;]{0,200}<iframe[^>]{0,300}(?:width\s*=\s*["']?0|height\s*=\s*["']?0|display\s*:\s*none|visibility\s*:\s*hidden)/i.test(t)
    || /createElement\s*\(\s*['"]iframe['"]\s*\)[\s\S]{0,300}(?:width\s*=\s*['"]?0|height\s*=\s*['"]?0|display\s*=\s*['"]none|visibility\s*=\s*['"]hidden|\.style\.display\s*=\s*['"]none)/i.test(t);
  if (hiddenFrame) add('iframe.hidden', 30, 'writes a hidden iframe');

  // third-party
  const sh = url && hostOf(url), ph = pageOrigin && hostOf(pageOrigin);
  if (sh && ph && sh !== ph && !sh.endsWith('.' + ph) && !ph.endsWith('.' + sh)) add('third-party', 5, `script host ${sh} differs from page host ${ph}`);

  const score = Math.min(100, Math.round(reasons.reduce((a, r) => a + r.weight, 0)));
  return { score, reasons };
}
