import { DEFAULT_SETTINGS, validateSettings } from '../shared/schema.js';
import { etld1 } from '../shared/sites.js';
import { PROFILE_INFO } from './labels.js';
import { applyRule, validateRule, hashText, diffToOps, matchesPattern } from '../shared/patch.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

async function loadSettings() {
  const { 'sg.settings': raw } = await chrome.storage.local.get('sg.settings');
  const v = validateSettings(raw || DEFAULT_SETTINGS);
  return v.ok ? v.value : structuredClone(DEFAULT_SETTINGS);
}
const saveSettings = (s) => chrome.storage.local.set({ 'sg.settings': s });
async function loadRules() {
  const { 'sg.rules': r } = await chrome.storage.local.get('sg.rules');
  return Array.isArray(r) ? r : [];
}
const saveRules = (r) => chrome.storage.local.set({ 'sg.rules': r });

/* ---------- site profiles ---------- */
async function renderSites() {
  const s = await loadSettings();
  $('defaultProfile').value = s.defaultProfile;
  const rows = $('siteRows');
  rows.textContent = '';
  const sites = Object.keys(s.siteProfiles).sort();
  if (!sites.length) rows.append(el('tr', {}, el('td', { colSpan: 4, className: 'empty', textContent: 'No per-site settings yet.' })));
  for (const site of sites) {
    const sel = el('select');
    for (const p of ['trusted', 'default', 'strict']) sel.append(el('option', { value: p, textContent: PROFILE_INFO[p].short }));
    sel.value = s.siteProfiles[site];
    sel.addEventListener('change', async () => { const c = await loadSettings(); c.siteProfiles[site] = sel.value; await saveSettings(c); });
    const dbg = el('span', { className: s.debuggerSites.includes(site) ? 'pill allowed' : 'muted', textContent: s.debuggerSites.includes(site) ? 'On' : 'Off', title: 'Switch this from the toolbar popup on that site.' });
    const del = el('button', { className: 'danger quiet', textContent: 'Remove' });
    del.addEventListener('click', async () => {
      const c = await loadSettings(); delete c.siteProfiles[site]; c.debuggerSites = c.debuggerSites.filter((x) => x !== site);
      await saveSettings(c); renderSites();
    });
    rows.append(el('tr', {}, el('td', { textContent: site }), el('td', {}, sel), el('td', {}, dbg), el('td', {}, del)));
  }
}
$('defaultProfile').addEventListener('change', async (e) => { const c = await loadSettings(); c.defaultProfile = e.target.value; await saveSettings(c); });
$('addSite').addEventListener('click', async () => {
  const raw = $('newSite').value.trim().toLowerCase();
  let host;
  try { host = new URL(raw.includes('://') ? raw : 'https://' + raw).hostname; } catch { host = ''; }
  if (!host || !host.includes('.')) { $('siteMsg').textContent = 'Enter a site such as example.com.'; return; }
  const c = await loadSettings();
  c.siteProfiles[etld1(host)] = $('newSiteProfile').value;
  await saveSettings(c);
  $('newSite').value = ''; $('siteMsg').textContent = ''; renderSites();
});

/* ---------- rules ---------- */
async function renderRules() {
  const rules = await loadRules();
  const rows = $('ruleRows');
  rows.textContent = '';
  if (!rules.length) rows.append(el('tr', {}, el('td', { colSpan: 5, className: 'empty', textContent: 'No rules yet. Add one below, or import your DevTools overrides.' })));
  for (const r of rules) {
    const on = el('input', { type: 'checkbox', checked: !!r.enabled });
    on.addEventListener('change', async () => { const all = await loadRules(); const t = all.find((x) => x.id === r.id); if (t) { t.enabled = on.checked; await saveRules(all); } });
    const edit = el('button', { textContent: 'Edit' });
    edit.addEventListener('click', () => { $('ruleJson').value = JSON.stringify(r, null, 2); $('ruleJson').scrollIntoView(); });
    const del = el('button', { className: 'danger', textContent: 'Delete' });
    del.addEventListener('click', async () => { await saveRules((await loadRules()).filter((x) => x.id !== r.id)); renderRules(); });
    rows.append(el('tr', {},
      el('td', {}, on), el('td', { textContent: r.name || '(unnamed)' }),
      el('td', {}, el('code', { textContent: r.urlPattern })),
      el('td', { textContent: String((r.ops || []).length) }),
      el('td', {}, edit, ' ', del)));
  }
}
function parseRuleInput() {
  let obj;
  try { obj = JSON.parse($('ruleJson').value); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
  obj.id = obj.id || crypto.randomUUID();
  obj.enabled = obj.enabled !== false;
  obj.createdAt = obj.createdAt || Date.now();
  const v = validateRule(obj);
  if (v && v.ok === false) return { error: (v.errors || []).join('; ') || 'Invalid rule' };
  return { rule: obj };
}
$('saveRule').addEventListener('click', async () => {
  const { rule, error } = parseRuleInput();
  if (error) { $('ruleMsg').textContent = error; return; }
  const all = await loadRules();
  const i = all.findIndex((x) => x.id === rule.id);
  if (i >= 0) all[i] = rule; else all.push(rule);
  await saveRules(all);
  $('ruleMsg').textContent = 'Saved.'; $('ruleJson').value = ''; renderRules();
});
async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_FETCH_BYTES) throw new Error('File is larger than 8 MB');
  const text = await res.text();
  if (text.length > MAX_FETCH_BYTES) throw new Error('File is larger than 8 MB');
  return text;
}
$('testRule').addEventListener('click', async () => {
  const { rule, error } = parseRuleInput();
  const out = $('ruleOut');
  if (error) { $('ruleMsg').textContent = error; return; }
  const url = $('testUrl').value.trim() || (rule.urlPattern.includes('*') ? '' : rule.urlPattern);
  if (!/^https?:\/\//.test(url)) { $('ruleMsg').textContent = 'Enter an http(s) URL to test against.'; return; }
  try {
    if (!matchesPattern(rule.urlPattern, url)) $('ruleMsg').textContent = 'Note: this URL does not match the rule pattern.';
    else $('ruleMsg').textContent = '';
    const text = await fetchText(url);
    const r = applyRule(text, rule);
    const hash = await hashText(text);
    out.hidden = false;
    out.textContent = [
      `original sha256: ${hash}`,
      rule.expectedHash ? `expected hash ${rule.expectedHash === hash ? 'matches' : 'DIFFERS'}` : 'no expected hash stored',
      `ops applied: [${r.applied.join(', ')}]  skipped: ${JSON.stringify(r.skipped)}  stale: ${r.stale}  blocked: ${r.blocked}`,
      `size: ${text.length} -> ${r.text.length} chars`,
    ].join('\n');
  } catch (e) { $('ruleMsg').textContent = 'Test failed: ' + (e.message || e); }
});

/* ---------- import from DevTools overrides ---------- */
async function* walk(dirHandle, prefix = '') {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'directory') yield* walk(handle, prefix + name + '/');
    else if (name !== '.headers') yield { path: prefix + name, handle };
  }
}
// Brave disables showDirectoryPicker by default, so fall back to <input webkitdirectory>.
function entriesFromFiles(files) {
  return [...files].filter((f) => f.name !== '.headers').map((f) => {
    const parts = (f.webkitRelativePath || f.name).split('/');
    const root = parts[0], rest = parts.slice(1);
    // If you picked a site folder (marimo.io/) rather than the Overrides root, the chooser hides its name, so put it back.
    const hostBelow = rest.length > 1 && rest[0].includes('.');
    const path = (!hostBelow && root.includes('.') ? [root, ...rest] : rest).join('/') || f.name;
    return { path, handle: { getFile: async () => f } };
  });
}
$('pickDir').addEventListener('click', async () => {
  $('importList').textContent = ''; $('importMsg').textContent = '';
  if (typeof window.showDirectoryPicker === 'function') {
    try { return await runImport(walk(await window.showDirectoryPicker({ mode: 'read' }))); }
    catch (e) { if (e && e.name === 'AbortError') return; /* otherwise fall through to the fallback */ }
  }
  $('dirInput').click();
});
$('dirInput').addEventListener('change', async (e) => {
  $('importList').textContent = ''; $('importMsg').textContent = '';
  const files = e.target.files;
  if (!files || !files.length) { $('importMsg').textContent = 'No folder chosen.'; return; }
  try { await runImport(entriesFromFiles(files)); }
  catch (err) { $('importMsg').textContent = 'Import failed: ' + (err && err.message || err); }
  e.target.value = '';
});
async function runImport(source) {
  const list = $('importList');
  let n = 0;
  for await (const { path, handle } of source) {
    if (++n > 200) { $('importMsg').textContent = 'Stopped after 200 files.'; break; }
    const card = el('div', { className: 'card' });
    const urlInput = el('input', { type: 'text', value: 'https://' + path, spellcheck: false });
    urlInput.setAttribute('aria-label', 'Live script URL for ' + path);
    urlInput.style.width = '100%';
    const retry = el('button', { textContent: 'Check again' });
    const result = el('div', {});
    card.append(el('div', { className: 'muted small', textContent: 'File: ' + path }), urlInput, retry, result);
    list.append(card);
    const run = async () => {
      result.textContent = '';
      const url = urlInput.value.trim();
      try {
        if (!/^https?:\/\//.test(url)) throw new Error('Enter the full http(s) URL of the live script.');
        const file = await handle.getFile();
        if (file.size > MAX_FETCH_BYTES) throw new Error('override file is larger than 8 MB');
        const patched = await file.text();
        const original = await fetchText(url);
        if (original === patched) { result.append(el('div', { className: 'muted', textContent: 'Identical to the live script. Nothing to import.' })); return; }
        const ops = diffToOps(original, patched);
        const rule = { id: crypto.randomUUID(), name: 'Imported: ' + path, enabled: true, urlPattern: url.split('#')[0].split('?')[0], expectedHash: await hashText(original), ops, createdAt: Date.now() };
        const check = applyRule(original, rule);
        const ok = check.text === patched && !check.stale;
        result.append(
          el('div', { className: 'muted', textContent: `${ops.length} op(s). Round-trip check: ${ok ? 'reproduces your override exactly' : 'DOES NOT reproduce your override, review before saving'}` }),
          el('pre', { textContent: JSON.stringify(ops, null, 2).slice(0, 4000) }),
        );
        const save = el('button', { className: 'primary', textContent: 'Save as rule', disabled: !ok });
        save.addEventListener('click', async () => { const all = await loadRules(); all.push(rule); await saveRules(all); save.disabled = true; save.textContent = 'Saved'; renderRules(); });
        result.append(save);
      } catch (e) {
        const m = String(e.message || e);
        result.append(el('div', { className: 'muted', textContent: 'Skipped: ' + m + (/404|410/.test(m) ? '. That URL is not live. Edit it above to the script\u2019s real address (copy it from DevTools Network) and press Check again.' : '') }));
      }
    };
    retry.addEventListener('click', run);
    await run();
  }
  if (!n) $('importMsg').textContent = 'No files found in that folder.';
}

/* ---------- extension audit ---------- */
const BROAD = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*'];
$('runAudit').addEventListener('click', async () => {
  const list = (await chrome.management.getAll()).filter((x) => x.type === 'extension' && x.enabled && x.id !== chrome.runtime.id);
  const rows = $('auditRows'); rows.textContent = '';
  const scored = list.map((x) => {
    const hosts = x.hostPermissions || [];
    const flags = [];
    if (hosts.some((h) => BROAD.includes(h))) flags.push('reads and changes all sites');
    for (const p of ['debugger', 'cookies', 'webRequestBlocking', 'nativeMessaging', 'history', 'management', 'proxy']) if ((x.permissions || []).includes(p)) flags.push(p);
    if (x.installType && x.installType !== 'normal') flags.push('installed as ' + x.installType);
    return { x, flags };
  }).sort((a, b) => b.flags.length - a.flags.length);
  for (const { x, flags } of scored) rows.append(el('tr', {}, el('td', { textContent: x.name }), el('td', { textContent: flags.join(', ') || 'limited' }), el('td', { textContent: x.version })));
  $('auditTable').hidden = false;
});

/* ---------- backup ---------- */
$('export').addEventListener('click', async () => {
  const data = { app: 'script-guard', version: 1, settings: await loadSettings(), rules: await loadRules() };
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'script-guard-backup.json' });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('importFile').addEventListener('click', () => $('importInput').click());
$('importInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'script-guard') throw new Error('not a Script Guard backup');
    const v = validateSettings(data.settings);
    if (!v.ok) throw new Error('settings invalid: ' + v.errors.join('; '));
    const rules = Array.isArray(data.rules) ? data.rules : [];
    for (const r of rules) { const rv = validateRule(r); if (rv && rv.ok === false) throw new Error('a rule is invalid'); }
    // A backup is untrusted input: never let it switch protection off or turn on script rewriting.
    const settings = structuredClone(v.value);
    for (const k of Object.keys(settings.siteProfiles)) if (settings.siteProfiles[k] === 'trusted') settings.siteProfiles[k] = 'default';
    settings.debuggerSites = [];
    await saveSettings(settings);
    // Imported rules arrive disabled so nothing runs until you review them.
    await saveRules(rules.map((r) => ({ ...r, enabled: false })));
    $('backupMsg').textContent = `Imported ${Object.keys(settings.siteProfiles).length} sites. Sites marked Off were set to Default and script rewriting was turned off. Review them under Sites. ${rules.length} rule(s) were imported disabled.`;
    renderSites(); renderRules();
  } catch (err) { $('backupMsg').textContent = 'Import failed: ' + (err.message || err); }
  e.target.value = '';
});

/* ---------- blocked scripts ---------- */
async function renderBlocks() {
  let blocks = [];
  try { const r = await chrome.runtime.sendMessage({ type: 'sg:getBlocks' }); blocks = (r && r.blocks) || []; } catch { /* worker asleep or gone */ }
  const rows = $('blockRows');
  rows.textContent = '';
  if (!blocks.length) rows.append(el('tr', {}, el('td', { colSpan: 4, className: 'empty', textContent: 'Nothing is blocked. Block a script from the toolbar popup while you are on a page.' })));
  for (const b of blocks) {
    const del = el('button', { className: 'danger quiet', textContent: 'Remove', title: 'Remove block for ' + b.value });
    del.setAttribute('aria-label', 'Remove block for ' + b.value);
    del.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'sg:unblock', id: b.id });
      renderBlocks();
    });
    const when = b.createdAt ? new Date(b.createdAt).toLocaleDateString() : '';
    rows.append(el('tr', {}, el('td', { textContent: b.kind === 'host' ? 'Whole host' : 'One script' }), el('td', { className: 'mono', textContent: b.value, style: 'overflow-wrap:anywhere' }), el('td', { className: 'muted', textContent: when }), el('td', {}, del)));
  }
}
$('newBlockKind').addEventListener('change', (e) => { $('newBlock').placeholder = e.target.value === 'host' ? 'ads.example.net' : 'https://ads.example.net/loader.js'; });
$('addBlock').addEventListener('click', async () => {
  const msg = $('blockMsg');
  msg.classList.remove('error');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'sg:block', kind: $('newBlockKind').value, value: $('newBlock').value });
    if (!r || r.error) { msg.textContent = (r && r.error) || 'Couldn’t add this block.'; msg.classList.add('error'); return; }
    $('newBlock').value = '';
    msg.textContent = 'Added. Reload any open pages to apply it.';
    renderBlocks();
  } catch (err) { msg.textContent = 'Couldn’t add this block: ' + (err.message || err); msg.classList.add('error'); }
});
$('newBlock').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addBlock').click(); });
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['sg.blocks']) renderBlocks(); });

/* ---------- sidebar navigation (one section at a time) ---------- */
function showSection() {
  const id = (location.hash || '#sites').slice(1);
  const known = [...document.querySelectorAll('.content section')].some((s) => s.dataset.sec === id);
  const active = known ? id : 'sites';
  for (const s of document.querySelectorAll('.content section')) s.hidden = s.dataset.sec !== active;
  for (const a of document.querySelectorAll('.side a')) {
    if (a.dataset.sec === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', showSection);
showSection();

renderSites();
renderRules();
renderBlocks();
