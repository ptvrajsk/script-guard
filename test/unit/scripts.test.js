import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistrations, sitePatterns, SCRIPT_IDS } from '../../src/background/scripts.js';
import { DEFAULT_SETTINGS } from '../../src/shared/schema.js';

test('guarded default injects everywhere, with both scripts in the right worlds', () => {
  const regs = buildRegistrations(DEFAULT_SETTINGS);
  assert.deepEqual(regs.map((r) => r.id), SCRIPT_IDS);
  assert.equal(regs.find((r) => r.id === 'sg-hooks').world, 'MAIN');
  assert.equal(regs.find((r) => r.id === 'sg-relay').world, 'ISOLATED');
  for (const r of regs) {
    assert.deepEqual(r.matches, ['<all_urls>']);
    assert.equal(r.excludeMatches, undefined);
    assert.equal(r.runAt, 'document_start');
    assert.equal(r.allFrames && r.matchOriginAsFallback, true);
    assert.equal('matchAboutBlank' in r, false); // not a valid scripting API property: registration throws
  }
});

test('trusted sites are excluded from injection, including subdomains', () => {
  const regs = buildRegistrations({ ...DEFAULT_SETTINGS, siteProfiles: { 'bank.com': 'trusted', 'x.org': 'strict' } });
  assert.deepEqual(regs[0].excludeMatches, sitePatterns('bank.com'));
  assert.ok(regs[0].excludeMatches.includes('*://*.bank.com/*'));
  assert.ok(!regs[0].excludeMatches.some((p) => p.includes('x.org')));
});

test('trusted default injects only on sites explicitly guarded', () => {
  assert.deepEqual(buildRegistrations({ ...DEFAULT_SETTINGS, defaultProfile: 'trusted' }), []);
  const regs = buildRegistrations({ ...DEFAULT_SETTINGS, defaultProfile: 'trusted', siteProfiles: { 'a.com': 'default', 'b.com': 'trusted' } });
  assert.deepEqual(regs[0].matches, sitePatterns('a.com'));
});

test('no substring confusion between sites', () => {
  const regs = buildRegistrations({ ...DEFAULT_SETTINGS, siteProfiles: { 'bank.com': 'trusted' } });
  // evilbank.com must not match either exclusion pattern
  for (const p of regs[0].excludeMatches) assert.ok(!/^\*:\/\/\*?\.?evilbank/.test(p));
  assert.ok(!regs[0].excludeMatches.includes('*://*bank.com/*'));
});

import { applySettings, isValidMatchPattern } from '../../src/background/scripts.js';
import { isValidHost } from '../../src/shared/schema.js';

test('invalid hosts never produce match patterns', () => {
  for (const h of ['999.999.999.999', '1.2.3', '256.1.1.1', 'a b.com', 'a/b.com', '*.com', 'x.com/..', '', 'a.b.c.9']) {
    assert.deepEqual(sitePatterns(h), [], h);
    assert.equal(isValidHost(h), false, h);
  }
  assert.deepEqual(sitePatterns('10.0.0.1'), ['*://10.0.0.1/*']); // no wildcard subdomain of an IP
  assert.ok(isValidHost('10.0.0.255') && isValidHost('localhost') && isValidHost('a-b.example.com'));
  const regs = buildRegistrations({ ...DEFAULT_SETTINGS, siteProfiles: { '999.999.999.999': 'trusted', 'bank.com': 'trusted' } });
  assert.deepEqual(regs[0].excludeMatches, sitePatterns('bank.com'));
  assert.ok(regs[0].excludeMatches.every(isValidMatchPattern));
  const only = buildRegistrations({ ...DEFAULT_SETTINGS, siteProfiles: { '999.999.999.999': 'trusted' } });
  assert.equal(only[0].excludeMatches, undefined);
});

function fakeScripting({ failFirst = false } = {}) {
  let reg = [], calls = 0;
  return {
    get reg() { return reg; },
    getRegisteredContentScripts: async () => reg.slice(),
    unregisterContentScripts: async ({ ids }) => { reg = reg.filter((r) => !ids.includes(r.id)); },
    registerContentScripts: async (list) => {
      if (failFirst && calls++ === 0) throw new Error('Invalid match pattern');
      reg = reg.concat(list);
    },
  };
}

test('applySettings registers normally', async () => {
  const sc = fakeScripting();
  const r = await applySettings(sc, { ...DEFAULT_SETTINGS, siteProfiles: { 'bank.com': 'trusted' } }, () => {});
  assert.equal(r.fallback, false);
  assert.ok(sc.reg[0].excludeMatches.length);
});

test('registration failure falls back to all_urls with no exclusions', async () => {
  const sc = fakeScripting({ failFirst: true });
  const logs = [];
  const r = await applySettings(sc, { ...DEFAULT_SETTINGS, siteProfiles: { 'bank.com': 'trusted' } }, (...a) => logs.push(a));
  assert.equal(r.fallback, true);
  assert.equal(logs.length, 1);
  assert.deepEqual(sc.reg.map((x) => x.id), SCRIPT_IDS);
  for (const x of sc.reg) { assert.deepEqual(x.matches, ['<all_urls>']); assert.equal(x.excludeMatches, undefined); }
});
