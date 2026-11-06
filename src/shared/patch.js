// Patch engine: pure, no chrome.* usage.
//
// Rule: { id, name, enabled, urlPattern, resourceType?: 'Script'|'Document', expectedHash?, ops, createdAt }
// Op:   replace {find, replace, all?}  (plain string anchors only; regex is not supported: ReDoS)
//       insertBefore/insertAfter {anchor, text, all?}   (text goes directly before/after the anchor match)
//       deleteLine {anchor, all?}                       (removes the whole line(s) the anchor match touches, incl. newline)
//       blockScript {}
//
// Semantics: every op locates its match(es) in the ORIGINAL text, then all edits are applied together by
// position. Earlier ops therefore can never create, destroy or shift the anchors of later ops. Edits that
// strictly overlap an already accepted edit are skipped (reason 'overlap'). Insertions are zero-width points.
// A non-`all` op must match exactly once: 0 matches -> skipped 'no-match', >1 -> skipped 'ambiguous'.
// `stale` is true when any op was skipped (callers should treat the rule as all-or-nothing).

export const MAX_MATCHES = 10000;

// ---------- URL pattern ----------
// '*' matches any run of characters. Iterative two-pointer glob (no regex, so no backtracking blowup).
export function matchesPattern(pattern, url) {
  if (typeof pattern !== 'string' || typeof url !== 'string') return false;
  const h = url.indexOf('#');
  const u = h === -1 ? url : url.slice(0, h);
  let pi = 0, ui = 0, star = -1, mark = 0;
  while (ui < u.length) {
    if (pi < pattern.length && pattern[pi] === '*') { star = pi++; mark = ui; }
    else if (pi < pattern.length && pattern[pi] === u[ui]) { pi++; ui++; }
    else if (star !== -1) { pi = star + 1; ui = ++mark; }
    else return false;
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

export async function hashText(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- validation ----------
const OP_TYPES = ['replace', 'insertBefore', 'insertAfter', 'deleteLine', 'blockScript'];

function validateOp(op, i, errors) {
  const p = `ops[${i}]`;
  if (!op || typeof op !== 'object') { errors.push(`${p}: not an object`); return; }
  if (!OP_TYPES.includes(op.type)) { errors.push(`${p}: unknown type`); return; }
  if (op.all !== undefined && typeof op.all !== 'boolean') errors.push(`${p}.all: must be boolean`);
  switch (op.type) {
    case 'replace':
      if (typeof op.find !== 'string' || op.find === '') errors.push(`${p}.find: required non-empty string`);
      if (typeof op.replace !== 'string') errors.push(`${p}.replace: required string`);
      if (op.regex !== undefined && op.regex !== false) errors.push(`${p}.regex: regular expressions are not supported`);
      break;
    case 'insertBefore':
    case 'insertAfter':
      if (typeof op.anchor !== 'string' || op.anchor === '') errors.push(`${p}.anchor: required non-empty string`);
      if (typeof op.text !== 'string') errors.push(`${p}.text: required string`);
      break;
    case 'deleteLine':
      if (typeof op.anchor !== 'string' || op.anchor === '') errors.push(`${p}.anchor: required non-empty string`);
      break;
    default: break;
  }
}

export function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return { ok: false, errors: ['rule: not an object'] };
  if (typeof rule.id !== 'string' || !rule.id) errors.push('id: required string');
  if (typeof rule.name !== 'string') errors.push('name: required string');
  if (typeof rule.enabled !== 'boolean') errors.push('enabled: required boolean');
  if (typeof rule.urlPattern !== 'string' || !rule.urlPattern) errors.push('urlPattern: required non-empty string');
  if (rule.resourceType !== undefined && !['Script', 'Document'].includes(rule.resourceType)) errors.push("resourceType: must be 'Script' or 'Document'");
  if (rule.expectedHash !== undefined && !(typeof rule.expectedHash === 'string' && /^[0-9a-f]{64}$/.test(rule.expectedHash))) errors.push('expectedHash: must be 64 lowercase hex chars');
  if (rule.createdAt !== undefined && typeof rule.createdAt !== 'number') errors.push('createdAt: must be number');
  if (!Array.isArray(rule.ops) || rule.ops.length === 0) errors.push('ops: required non-empty array');
  else rule.ops.forEach((op, i) => validateOp(op, i, errors));
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], value: rule };
}

// ---------- apply ----------
function findString(text, needle, all) {
  const out = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push([i, i + needle.length]);
    if (out.length >= (all ? MAX_MATCHES : 2)) break;
    i = text.indexOf(needle, all ? i + needle.length : i + 1);
  }
  return out;
}

function lineBounds(text, s, e) {
  let a = text.lastIndexOf('\n', s - 1) + 1;
  let b = text.indexOf('\n', Math.max(e - 1, s));
  b = b === -1 ? text.length : b + 1;
  return [a, b];
}

export function applyRule(text, rule) {
  const result = { text, applied: [], skipped: [], stale: false, blocked: false };
  const ops = rule && Array.isArray(rule.ops) ? rule.ops : [];
  const edits = []; // {s, e, r, op}
  const accepted = [];
  const overlaps = (s, e) => accepted.some(([as, ae]) => (s < ae && e > as) || (s === e && s > as && s < ae) || (as === ae && as > s && as < e));

  ops.forEach((op, idx) => {
    const skip = (reason) => result.skipped.push({ opIndex: idx, reason });
    if (!op || typeof op !== 'object') return skip('invalid-op');
    if (op.type === 'blockScript') { result.blocked = true; result.applied.push(idx); return; }
    let matches;
    try {
      if (op.type === 'replace') {
        if (typeof op.find !== 'string' || op.find === '' || typeof op.replace !== 'string') return skip('invalid-op');
        if (op.regex) return skip('regex-not-supported');
        matches = findString(text, op.find, !!op.all);
      } else if (op.type === 'insertBefore' || op.type === 'insertAfter' || op.type === 'deleteLine') {
        if (typeof op.anchor !== 'string' || op.anchor === '') return skip('invalid-op');
        if (op.type !== 'deleteLine' && typeof op.text !== 'string') return skip('invalid-op');
        matches = findString(text, op.anchor, !!op.all);
      } else return skip('invalid-op');
    } catch { return skip('invalid-op'); }

    if (matches.length === 0) return skip('no-match');
    if (matches.length > 1 && !op.all) return skip('ambiguous');

    const mine = [];
    for (const [s, e] of matches) {
      if (op.type === 'replace') mine.push({ s, e, r: op.replace });
      else if (op.type === 'insertBefore') mine.push({ s, e: s, r: op.text });
      else if (op.type === 'insertAfter') mine.push({ s: e, e, r: op.text });
      else { const [a, b] = lineBounds(text, s, e); mine.push({ s: a, e: b, r: '' }); }
    }
    // dedupe identical ranges produced by e.g. deleteLine matching twice on one line
    const uniq = [];
    for (const x of mine) if (!uniq.some((y) => y.s === x.s && y.e === x.e)) uniq.push(x);
    if (uniq.some((x) => overlaps(x.s, x.e)) || uniq.some((x, i) => uniq.some((y, j) => j < i && x.s < y.e && x.e > y.s))) return skip('overlap');
    for (const x of uniq) { edits.push({ ...x, idx }); accepted.push([x.s, x.e]); }
    result.applied.push(idx);
  });

  if (edits.length) {
    // stable: by start, insertions at the same point keep op order
    edits.sort((a, b) => a.s - b.s || a.e - b.e || a.idx - b.idx);
    let out = '', pos = 0;
    for (const ed of edits) { out += text.slice(pos, ed.s) + ed.r; pos = ed.e; }
    out += text.slice(pos);
    result.text = out;
  }
  result.stale = result.skipped.length > 0;
  return result;
}

// ---------- diff -> ops ----------
function splitLines(t) { return t.match(/[^\n]*\n|[^\n]+$/g) || []; }

// Line-level LCS diff -> hunks [{a0,a1,b0,b1}] over line indices. Falls back to one hunk for huge inputs.
function diffLines(A, B) {
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let sa = A.length, sb = B.length;
  while (sa > p && sb > p && A[sa - 1] === B[sb - 1]) { sa--; sb--; }
  const n = sa - p, m = sb - p;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > 4_000_000) return [{ a0: p, a1: sa, b0: p, b1: sb }];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * w + j] = A[p + i] === B[p + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  const hunks = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[p + i] === B[p + j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { a0: p + i, a1: p + i, b0: p + j, b1: p + j };
    if (j < m && (i === n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { j++; cur.b1 = p + j; }
    else { i++; cur.a1 = p + i; }
  }
  flush();
  return hunks;
}

// Occurrence count (overlapping), capped at 2.
function count2(text, needle) {
  let i = text.indexOf(needle);
  if (i === -1) return 0;
  return text.indexOf(needle, i + 1) === -1 ? 1 : 2;
}

// Smallest k in [lo,hi] with pred(k) true; pred must be monotonic (false..true). Returns hi+1 if none.
function bsearch(lo, hi, pred) {
  let a = lo, b = hi + 1;
  while (a < b) { const mid = (a + b) >> 1; if (pred(mid)) b = mid; else a = mid + 1; }
  return a;
}

function uniquePrefix(text, p) {
  const k = bsearch(1, text.length - p, (k) => count2(text, text.substr(p, k)) === 1);
  return text.substr(p, k);
}
function uniqueSuffix(text) {
  const n = text.length;
  const k = bsearch(1, n, (k) => count2(text, text.slice(n - k)) === 1);
  return text.slice(n - k);
}

// Replace of original [s,e) by `r`, trimmed of common affixes and widened with symmetric context until unique.
function replaceOp(text, s, e, r) {
  const o = text.slice(s, e);
  let cp = 0;
  while (cp < o.length && cp < r.length && o[cp] === r[cp]) cp++;
  let cs = 0;
  while (cs < o.length - cp && cs < r.length - cp && o[o.length - 1 - cs] === r[r.length - 1 - cs]) cs++;
  const s2 = s + cp, e2 = e - cs, r2 = r.slice(cp, r.length - cs);
  const ctx = (k) => [Math.max(0, s2 - k), Math.min(text.length, e2 + k)];
  const ok = (k) => { const [a, b] = ctx(k); return b > a && count2(text, text.slice(a, b)) === 1; };
  const k = bsearch(0, text.length, ok);
  const [a, b] = ctx(k);
  return { type: 'replace', find: text.slice(a, b), replace: text.slice(a, s2) + r2 + text.slice(e2, b) };
}

function opsForHunks(a, hunks, AL, BL, offs) {
  const ops = [];
  for (const h of hunks) {
    const s = offs[h.a0], e = offs[h.a1];
    const r = BL.slice(h.b0, h.b1).join('');
    if (h.a0 === h.a1) { // pure insertion
      if (s < a.length) ops.push({ type: 'insertBefore', anchor: uniquePrefix(a, s), text: r });
      else ops.push({ type: 'insertAfter', anchor: uniqueSuffix(a), text: r });
    } else if (h.b0 === h.b1 && h.a1 - h.a0 === 1 && a[e - 1] === '\n') { // single whole-line deletion
      const line = a.slice(s, e - 1);
      let anchor = null;
      if (line.length) {
        const k = bsearch(1, line.length, (k) => count2(a, line.slice(0, k)) === 1);
        if (k <= line.length) anchor = line.slice(0, k);
      }
      ops.push(anchor ? { type: 'deleteLine', anchor } : replaceOp(a, s, e, ''));
    } else ops.push(replaceOp(a, s, e, r));
  }
  return ops;
}

function check(a, b, ops) {
  const res = applyRule(a, { ops });
  return !res.stale && res.text === b;
}

// Character-level Myers diff -> hunks over char offsets. Used when a line diff is too coarse (minified, single-line files).
// Returns null when the inputs are huge or differ too much, so callers keep their existing result.
function charHunks(a, b, maxD = 1500) {
  const N = a.length, M = b.length;
  if (N + M > 1_000_000) return null;
  const max = Math.min(N + M, maxD), off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a.charCodeAt(x) === b.charCodeAt(y)) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const edits = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const vv = trace[d], k = x - y;
    const pk = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1;
    const px = vv[off + pk], py = px - pk;
    while (x > px && y > py) { x--; y--; }
    if (x === px) { y--; edits.push({ ins: true, i: y }); } else { x--; edits.push({ ins: false, i: x }); }
  }
  edits.reverse();
  const hunks = [];
  let ia = 0, ib = 0, cur = null;
  for (const e of edits) {
    let a0, a1, b0, b1;
    if (e.ins) { a0 = a1 = ia + (e.i - ib); b0 = e.i; b1 = e.i + 1; } else { a0 = e.i; a1 = e.i + 1; b0 = b1 = ib + (e.i - ia); }
    if (cur && a0 - cur.a1 <= 2) { cur.a1 = a1; cur.b1 = b1; } else { if (cur) hunks.push(cur); cur = { a0, a1, b0, b1 }; }
    ia = a1; ib = b1;
  }
  if (cur) hunks.push(cur);
  return hunks;
}
function charOps(original, patched) {
  const hunks = charHunks(original, patched);
  if (!hunks || !hunks.length) return null;
  return hunks.map((h) => replaceOp(original, h.a0, h.a1, patched.slice(h.b0, h.b1)));
}
const opsSize = (ops) => JSON.stringify(ops).length;

// Produce ops that turn `original` into `patched`. Verified by applying them; falls back to a single
// wider replace, then to a whole-text replace, so the result always round-trips.
export function diffToOps(original, patched) {
  if (original === patched) return [];
  if (original === '') throw new RangeError('diffToOps: cannot anchor edits in an empty original');
  const AL = splitLines(original), BL = splitLines(patched);
  const offs = [0];
  for (const l of AL) offs.push(offs[offs.length - 1] + l.length);
  const hunks = diffLines(AL, BL);
  const best = (cands) => { // smallest candidate that reproduces `patched`
    let out = null, size = Infinity;
    for (const ops of cands) if (ops && check(original, patched, ops) && opsSize(ops) < size) { out = ops; size = opsSize(ops); }
    return out;
  };
  const lineOps = opsForHunks(original, hunks, AL, BL, offs);
  const lineOk = check(original, patched, lineOps);
  // Line diffs are coarse on minified files: if the result is large, try a character-level diff and keep the smaller.
  if (lineOk && opsSize(lineOps) <= 1500) return lineOps;
  const first = hunks[0], last = hunks[hunks.length - 1];
  const wide = opsForHunks(original, [{ a0: first.a0, a1: last.a1, b0: first.b0, b1: last.b1 }], AL, BL, offs);
  const chosen = best([lineOk ? lineOps : null, charOps(original, patched), wide]);
  if (chosen) return chosen;
  return [{ type: 'replace', find: original, replace: patched }];
}
