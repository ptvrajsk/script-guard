import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRules, diffRules, ID, PERMISSIONS_POLICY_DENY } from '../../src/background/dnr.js';
import { DEFAULT_SETTINGS } from '../../src/shared/schema.js';

const S = over => ({ ...structuredClone(DEFAULT_SETTINGS), ...over });
const byId = (rules, id) => rules.find(r => r.id === id);
const HL = { badHosts: ['polyfill.io', 'bootcss.com'] };

test('default profile: PP catch-all, no CSP, no download block, bad hosts present', () => {
  const rules = buildRules(S({}), HL);
  const pp = byId(rules, ID.ppDefault);
  assert.equal(pp.action.responseHeaders[0].header, 'Permissions-Policy');
  assert.equal(pp.action.responseHeaders[0].operation, 'append');
  assert.deepEqual(pp.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.equal(pp.condition.requestDomains, undefined);
  assert.equal(byId(rules, ID.ppStrict), undefined);
  assert.equal(byId(rules, ID.cspStrict), undefined);
  assert.equal(byId(rules, ID.dlStrict), undefined);
  assert.equal(rules.filter(r => r.id >= ID.badHostBase).length, 2);
  assert.ok(PERMISSIONS_POLICY_DENY.includes('usb=()') && !PERMISSIONS_POLICY_DENY.includes('camera'));
  assert.ok(!PERMISSIONS_POLICY_DENY.includes('clipboard-write'));
});
test('never uses set, and CSP only as Report-Only append', () => {
  const rules = buildRules(S({ defaultProfile: 'strict' }), HL);
  for (const r of rules) for (const h of r.action.responseHeaders || []) assert.equal(h.operation, 'append');
  const csp = byId(rules, ID.cspStrict).action.responseHeaders[0];
  assert.equal(csp.header, 'Content-Security-Policy-Report-Only');
  assert.match(csp.value, /script-src 'self' https:/);
  assert.ok(byId(rules, ID.dlStrict));
});
test('site overrides use exact domain lists, excluded from catch-all', () => {
  const rules = buildRules(S({ siteProfiles: { 'bank.com': 'trusted', 'zeta.org': 'strict', 'alpha.net': 'strict' } }), HL);
  assert.deepEqual(byId(rules, ID.ppDefault).condition.excludedRequestDomains, ['alpha.net', 'bank.com', 'zeta.org']);
  assert.deepEqual(byId(rules, ID.ppStrict).condition.requestDomains, ['alpha.net', 'zeta.org']);
  assert.deepEqual(byId(rules, ID.cspStrict).condition.requestDomains, ['alpha.net', 'zeta.org']);
  assert.deepEqual(byId(rules, ID.dlStrict).condition.initiatorDomains, ['alpha.net', 'zeta.org']);
  assert.ok(!JSON.stringify(rules).includes('urlFilter'), 'no substring urlFilter matching');
});
test('trusted default profile: no header rules, bad hosts still blocked', () => {
  const rules = buildRules(S({ defaultProfile: 'trusted' }), HL);
  assert.equal(rules.filter(r => r.id < ID.badHostBase).length, 0);
  assert.equal(rules.length, 2);
});
test('trusted default with one default-profile site', () => {
  const rules = buildRules(S({ defaultProfile: 'trusted', siteProfiles: { 'x.com': 'default' } }), { badHosts: [] });
  assert.deepEqual(byId(rules, ID.ppDefault).condition.requestDomains, ['x.com']);
});
test('deterministic and stable ids', () => {
  const a = buildRules(S({ siteProfiles: { 'b.com': 'strict', 'a.com': 'strict' } }), { badHosts: ['z.io', 'a.io'] });
  const b = buildRules(S({ siteProfiles: { 'a.com': 'strict', 'b.com': 'strict' } }), { badHosts: ['a.io', 'z.io', 'a.io'] });
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map(r => r.id)).size, a.length);
  assert.equal(byId(a, 2000).condition.requestDomains[0], 'a.io');
});
test('bad hosts: allowlist, invalid and non-domain entries removed', () => {
  const s = S({ allowlists: { scriptHosts: ['bootcss.com'] } });
  const rules = buildRules(s, { badHosts: ['polyfill.io', 'BootCSS.com', 'localhost', 'evil.com/path', 'a b.com', ''] });
  const hosts = rules.filter(r => r.id >= ID.badHostBase).map(r => r.condition.requestDomains[0]);
  assert.deepEqual(hosts, ['polyfill.io']);
});
test('download block regex matches executables only, not .com hosts', () => {
  const re = new RegExp(byId(buildRules(S({ defaultProfile: 'strict' }), {}), ID.dlStrict).condition.regexFilter, 'i');
  assert.ok(re.test('https://x.org/a/setup.EXE'));
  assert.ok(re.test('https://x.org/a/setup.msi?dl=1'));
  assert.ok(!re.test('https://example.com'));
  assert.ok(!re.test('https://example.com/readme.txt'));
  assert.ok(!re.test('https://x.org/a.exe.html'));
  assert.ok(!re.test('https://exe.org/'));
});
test('rule shape is valid for DNR', () => {
  for (const r of buildRules(S({ defaultProfile: 'strict', siteProfiles: { 'a.com': 'trusted' } }), HL)) {
    assert.ok(Number.isInteger(r.id) && r.id > 0);
    for (const k of ['requestDomains', 'initiatorDomains', 'excludedRequestDomains', 'excludedInitiatorDomains']) {
      if (k in r.condition) assert.ok(r.condition[k].length > 0, `${k} must not be empty`);
    }
  }
});
test('diffRules adds, removes and replaces minimally', () => {
  const a = buildRules(S({}), HL);
  assert.deepEqual(diffRules(a, a), { removeRuleIds: [], addRules: [] });
  const b = buildRules(S({ siteProfiles: { 'x.com': 'trusted' } }), HL);
  const d = diffRules(a, b);
  assert.deepEqual(d.removeRuleIds, [ID.ppDefault]);
  assert.equal(d.addRules.length, 1);
  const none = diffRules(a, []);
  assert.equal(none.removeRuleIds.length, a.length);
  // key order must not matter
  const reordered = a.map(r => ({ condition: r.condition, action: r.action, priority: r.priority, id: r.id }));
  assert.deepEqual(diffRules(a, reordered), { removeRuleIds: [], addRules: [] });
});
