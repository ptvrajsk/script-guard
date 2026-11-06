import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, PROFILES, HOOK_NAMES, PROFILE_HOOKS, validateSettings, profileFor, hooksFor } from '../../src/shared/schema.js';

test('defaults validate cleanly', () => {
  const r = validateSettings(DEFAULT_SETTINGS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, DEFAULT_SETTINGS);
  assert.deepEqual(PROFILES, ['trusted', 'default', 'strict']);
});
test('non-object rejected, value falls back to defaults', () => {
  const r = validateSettings('x');
  assert.equal(r.ok, false);
  assert.deepEqual(r.value, DEFAULT_SETTINGS);
});
test('invalid parts dropped with errors', () => {
  const r = validateSettings({
    defaultProfile: 'paranoid',
    siteProfiles: { 'www.bank.com': 'trusted', 'bad host!': 'strict', 'x.com': 'nope' },
    hooks: { clipboard: 'block', nonsense: 'log', function: 'explode' },
    allowlists: { scriptHosts: ['cdn.ok.com', '..'] }
  });
  assert.equal(r.ok, false);
  assert.equal(r.value.defaultProfile, 'default');
  assert.deepEqual(r.value.siteProfiles, { 'bank.com': 'trusted' }); // normalized to etld1
  assert.deepEqual(r.value.hooks, { clipboard: 'block' });
  assert.deepEqual(r.value.allowlists.scriptHosts, ['cdn.ok.com']);
  assert.equal(r.errors.length, 6);
});
test('does not mutate or alias DEFAULT_SETTINGS', () => {
  const r = validateSettings({});
  r.value.siteProfiles.x = 'strict';
  assert.deepEqual(DEFAULT_SETTINGS.siteProfiles, {});
});
test('profileFor uses registrable domain, not substrings', () => {
  const s = { ...DEFAULT_SETTINGS, siteProfiles: { 'example.com': 'strict', 'bbc.co.uk': 'trusted' } };
  assert.equal(profileFor(s, 'www.example.com'), 'strict');
  assert.equal(profileFor(s, 'example.com'), 'strict');
  assert.equal(profileFor(s, 'evil-example.com'), 'default');
  assert.equal(profileFor(s, 'example.com.evil.net'), 'default');
  assert.equal(profileFor(s, 'news.bbc.co.uk'), 'trusted');
  assert.equal(profileFor(s, ''), 'default');
  assert.equal(profileFor(undefined, 'a.com'), 'default');
});
test('profileFor ignores prototype keys', () => {
  assert.equal(profileFor(DEFAULT_SETTINGS, 'constructor'), 'default');
});
test('hooksFor per profile', () => {
  assert.ok(Object.values(hooksFor(DEFAULT_SETTINGS, 'trusted')).every(m => m === 'off'));
  const d = hooksFor(DEFAULT_SETTINGS, 'default');
  assert.equal(d.clipboard, 'block'); assert.equal(d.download, 'warn'); assert.equal(d.function, 'log');
  const st = hooksFor(DEFAULT_SETTINGS, 'strict');
  assert.equal(st.download, 'block'); assert.equal(st.function, 'warn'); assert.equal(st.worker, 'log');
  for (const p of PROFILES) assert.deepEqual(Object.keys(PROFILE_HOOKS[p]).sort(), [...HOOK_NAMES].sort());
});
test('hook overrides apply except in trusted', () => {
  const s = { ...DEFAULT_SETTINGS, hooks: { function: 'block' } };
  assert.equal(hooksFor(s, 'default').function, 'block');
  assert.equal(hooksFor(s, 'trusted').function, 'off');
});
