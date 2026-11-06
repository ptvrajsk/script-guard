import { DEFAULT_SETTINGS, validateSettings } from '../shared/schema.js';
import { etld1 } from '../shared/sites.js';
import { kindLabel, actionLabel, PROFILE_INFO } from './labels.js';

const $ = (id) => document.getElementById(id);
let tab = null;
let site = '';
let settings = null;
let rewritten = 0;

async function loadSettings() {
  const { 'sg.settings': raw } = await chrome.storage.local.get('sg.settings');
  const v = validateSettings(raw || DEFAULT_SETTINGS);
  return v.ok ? v.value : structuredClone(DEFAULT_SETTINGS);
}
const saveSettings = (s) => chrome.storage.local.set({ 'sg.settings': s });

function renderState(profile, blocked) {
  const info = PROFILE_INFO[profile];
  $('shield').dataset.state = profile;
  const strong = document.createElement('strong');
  strong.textContent = info.state;
  $('state').textContent = '';
  $('state').append(strong, blocked ? ` · ${blocked} blocked on this tab` : '', rewritten ? ` · ${rewritten} script${rewritten === 1 ? '' : 's'} rewritten` : '');
  $('profileHelp').textContent = info.help;
}

function renderEvents(events) {
  const list = $('events');
  list.textContent = '';
  const blocked = events.filter((e) => e.action === 'blocked').length;
  const noted = events.length - blocked;
  $('summary').textContent = events.length ? `${blocked} blocked, ${noted} noted` : '';
  if (!events.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'Nothing has happened on this tab yet. Reload it to start recording.';
    list.append(li);
    return blocked;
  }
  for (const e of events.slice().reverse()) {
    const li = document.createElement('li');
    const line = document.createElement('div');
    line.className = 'line';
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = kindLabel(e.kind);
    const pill = document.createElement('span');
    pill.className = 'pill ' + (e.action || 'logged');
    pill.textContent = actionLabel(e.action);
    line.append(what, pill);
    li.append(line);
    const d = e.detail && typeof e.detail === 'object' ? Object.values(e.detail).find((v) => typeof v === 'string') : '';
    if (d) {
      const p = document.createElement('div');
      p.className = 'detail';
      p.textContent = d.slice(0, 140);
      li.append(p);
    }
    list.append(li);
  }
  return blocked;
}

async function getEvents(tabId) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'sg:getEvents', tabId });
    return Array.isArray(r) ? r : (r && r.events) || [];
  } catch { return []; }
}

function setUnsupported() {
  $('site').textContent = 'This page can’t be protected';
  $('state').textContent = 'Script Guard only works on http and https pages.';
  $('shield').dataset.state = 'unsupported';
  $('segWrap').hidden = true; $('profileHelp').hidden = true;
  for (const b of document.querySelectorAll('.block')) b.hidden = true;
}

/* ---------- scripts on this page ---------- */
const VISIBLE_ROWS = 50;
let scriptData = { scripts: [], inline: 0 };
let showAll = false;

async function fetchScripts() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'sg:getScripts', tabId: tab.id });
    return r && Array.isArray(r.scripts) ? r : { scripts: [], inline: 0 };
  } catch { return { scripts: [], inline: 0 }; }
}

function scriptButton(label, aria, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.addEventListener('click', onClick);
  return b;
}

function setScriptsMsg(text, isError) {
  $('scriptsMsg').textContent = text || '';
  $('scriptsMsg').classList.toggle('error', !!isError);
}

async function changeBlock(message, okText) {
  setScriptsMsg('');
  try {
    const r = await chrome.runtime.sendMessage(message);
    if (!r || r.error) { setScriptsMsg(r && r.error ? r.error : 'Couldn’t change this.', true); return; }
    setScriptsMsg(okText);
    $('reloadBar').hidden = false;
    // Reflect the change straight away without waiting for a reload.
    scriptData = await fetchScripts();
    renderScripts();
  } catch (err) { setScriptsMsg('Couldn’t change this: ' + (err && err.message || err), true); }
}

function renderScripts() {
  const list = $('scripts');
  list.textContent = '';
  const all = scriptData.scripts;
  const third = all.filter((s) => s.thirdParty).length;
  $('scriptsCount').textContent = all.length ? `${all.length} total, ${third} third-party` : '';
  $('scriptsNote').textContent = scriptData.inline ? `Plus ${scriptData.inline} inline script${scriptData.inline === 1 ? '' : 's'} written into the page (not listed).` : '';
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'No scripts reported yet. Reload the tab.';
    list.append(li);
    $('showAll').hidden = true;
    return;
  }
  const rows = showAll ? all : all.slice(0, VISIBLE_ROWS);
  for (const s of rows) {
    const li = document.createElement('li');
    if (s.blocked) li.className = 'is-blocked';
    const head = document.createElement('div');
    head.className = 'head';
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = s.host;
    head.append(host);
    if (s.thirdParty) { const p = document.createElement('span'); p.className = 'pill third'; p.textContent = 'Third-party'; head.append(p); }
    if (s.blocked) { const p = document.createElement('span'); p.className = 'pill blocked'; p.textContent = 'Blocked'; head.append(p); }
    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = s.path;
    path.title = s.url;
    const acts = document.createElement('div');
    acts.className = 'acts';
    if (s.blocked) {
      acts.append(scriptButton('Unblock', `Unblock ${s.host}${s.path}`, async () => {
        for (const id of s.blockIds || []) await changeBlock({ type: 'sg:unblock', id }, 'Unblocked.');
      }));
    } else {
      acts.append(
        scriptButton('Block script', `Block this script from ${s.host}`, () => changeBlock({ type: 'sg:block', kind: 'url', value: s.url, tabId: tab.id }, 'Script blocked.')),
        scriptButton('Block site', `Block everything from ${s.host}`, () => changeBlock({ type: 'sg:block', kind: 'host', value: s.host, tabId: tab.id }, `Blocked everything from ${s.host}.`))
      );
    }
    li.append(head, path, acts);
    list.append(li);
  }
  const hidden = all.length - rows.length;
  $('showAll').hidden = hidden <= 0;
  $('showAll').textContent = `Show all ${all.length}`;
}


/* ---------- rewrite status: proof that your rules are applying ---------- */
async function queryAttached() {
  try { const r = await chrome.runtime.sendMessage({ type: 'sg:debugger', tabId: tab.id, query: true }); return !!(r && r.attached); }
  catch { return false; }
}
async function renderRewrite(events) {
  const box = $('rewrite');
  const on = $('dbg').checked;
  box.hidden = !on;
  if (!on) { rewritten = 0; return; }
  const patched = events.filter((e) => e.kind === 'script.patched' && e.detail && !e.detail.blocked);
  const blockedByRule = events.filter((e) => e.kind === 'script.patched' && e.detail && e.detail.blocked);
  const stale = events.filter((e) => e.kind === 'script.stale');
  rewritten = patched.length + blockedByRule.length;
  const attached = await queryAttached();
  const count = $('rewriteCount');
  const list = $('rewriteList');
  list.textContent = '';
  const urlOf = (e) => { try { const u = new URL(e.detail.url); return u.host + u.pathname; } catch { return String(e.detail && e.detail.url || '').slice(0, 120); } };
  const add = (text, note, cls) => { const li = document.createElement('li'); if (cls) li.className = cls; li.textContent = text; if (note) { const n = document.createElement('span'); n.textContent = ' ' + note; li.append(n); } list.append(li); };
  const seen = new Set();
  for (const e of patched) {
    const u = urlOf(e); if (seen.has('p' + u)) continue; seen.add('p' + u);
    const rules = Array.isArray(e.detail.rules) ? e.detail.rules : [];
    const ops = rules.reduce((n, r) => n + (Number(r && r.applied) || 0), 0);
    add(u, `rewritten (${ops} change${ops === 1 ? '' : 's'})`);
  }
  for (const e of blockedByRule) { const u = urlOf(e); if (!seen.has('b' + u)) { seen.add('b' + u); add(u, 'removed by your rule'); } }
  for (const e of stale) { const u = urlOf(e); if (!seen.has('s' + u)) { seen.add('s' + u); add(u, 'rule no longer matches, original ran', 'stale'); } }
  if (rewritten) { count.textContent = `${rewritten} rewritten`; count.className = 'pill ok'; }
  else if (stale.length) { count.textContent = 'rule stale'; count.className = 'pill warn'; }
  else { count.textContent = attached ? 'watching' : 'not attached'; count.className = 'pill'; }
  $('rewriteSummary').textContent = rewritten
    ? 'These scripts were changed by your rules before the page ran them.'
    : stale.length ? 'A rule\u2019s text no longer appears in the live script, so the original ran unchanged. Re-import it.'
    : attached ? 'Attached to this tab. Nothing has been rewritten yet. Reload so scripts load while attached, and check a rule exists for the script\u2019s URL under Settings \u2192 Script rules.'
    : 'Not attached to this tab. Reload it to start.';
}

async function main() {
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = null;
  try { url = new URL(tab.url); } catch {}
  if (!url || !/^https?:$/.test(url.protocol)) { setUnsupported(); $('events').textContent = ''; return; }

  site = etld1(url.hostname);
  $('site').textContent = site;
  $('site').title = url.hostname;
  settings = await loadSettings();
  const current = settings.siteProfiles[site] || settings.defaultProfile;
  document.querySelector(`input[name="profile"][value="${current}"]`).checked = true;
  $('showAll').addEventListener('click', () => { showAll = true; renderScripts(); });
  fetchScripts().then((d) => { scriptData = d; renderScripts(); });
  const events = await getEvents(tab.id);
  renderState(current, renderEvents(events));

  for (const r of document.querySelectorAll('input[name="profile"]')) {
    r.addEventListener('change', async () => {
      settings = await loadSettings();
      settings.siteProfiles[site] = r.value;
      await saveSettings(settings);
      renderState(r.value, events.filter((e) => e.action === 'blocked').length);
      $('reloadBar').hidden = false;
    });
  }
  $('reload').addEventListener('click', () => { chrome.tabs.reload(tab.id); window.close(); });
  $('clear').addEventListener('click', async () => {
    try { await chrome.runtime.sendMessage({ type: 'sg:clearEvents', tabId: tab.id }); } catch {}
    events.length = 0;
    renderEvents([]);
    renderState(settings.siteProfiles[site] || settings.defaultProfile, 0);
  });

  // Rewriting scripts uses the debugger. Chromium does not allow it as an optional permission, so it is declared up front
  // but only attaches to a tab on a site you switch this on for.
  $('dbg').checked = settings.debuggerSites.includes(site);
  await renderRewrite(events);
  renderState(current, events.filter((e) => e.action === 'blocked').length);
  $('dbg').addEventListener('change', async (e) => {
    const on = e.target.checked;
    $('dbgStatus').textContent = '';
    try {
      settings = await loadSettings();
      const set = new Set(settings.debuggerSites);
      if (on) set.add(site); else set.delete(site);
      settings.debuggerSites = [...set];
      await saveSettings(settings);
      const r = await chrome.runtime.sendMessage({ type: 'sg:debugger', tabId: tab.id, enable: on });
      if (r && r.error) { e.target.checked = !on; $('dbgStatus').textContent = 'Couldn’t change this: ' + r.error; return; }
      $('dbgStatus').textContent = on ? 'On. Reload the tab to rewrite its scripts.' : 'Off.';
      await renderRewrite(events);
      if (on) $('reloadBar').hidden = false;
    } catch (err) {
      e.target.checked = !on;
      $('dbgStatus').textContent = 'Couldn’t change this: ' + (err && err.message || err);
    }
  });
}
main();
