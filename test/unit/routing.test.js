import test from 'node:test';
import assert from 'node:assert/strict';
import { sinkTabId, shouldDetachOnNavigate, shouldAttachOnNavigate } from '../../src/background/routing.js';

test('sinkTabId reads detail.tabId from debugger events', () => {
  assert.equal(sinkTabId({ kind: 'script.scored', detail: { tabId: 12 } }), 12);
  assert.equal(sinkTabId({ kind: 'x', detail: { tabId: 12 } }, 3), 3);
  assert.equal(sinkTabId({ kind: 'x', tabId: 5, detail: {} }), 5);
  assert.equal(sinkTabId({ kind: 'x', detail: { tabId: 'no' } }), -1);
  assert.equal(sinkTabId({ kind: 'x', detail: { tabId: -4 } }), -1);
  assert.equal(sinkTabId(null), -1);
});

test('debugger detaches when an enabled tab navigates to an unlisted site', () => {
  const debuggerSites = ['a.com'];
  assert.equal(shouldDetachOnNavigate({ enabled: true, url: 'https://evil.com/', debuggerSites }), true);
  assert.equal(shouldDetachOnNavigate({ enabled: true, url: 'https://www.a.com/x', debuggerSites }), false);
  assert.equal(shouldDetachOnNavigate({ enabled: false, url: 'https://evil.com/', debuggerSites }), false);
  assert.equal(shouldDetachOnNavigate({ enabled: true, url: 'https://evil.com/', debuggerSites: [] }), true);
  assert.equal(shouldDetachOnNavigate({ enabled: true, url: 'about:blank', debuggerSites }), true);
  // shared hosting: listing a.github.io does not cover b.github.io
  assert.equal(shouldDetachOnNavigate({ enabled: true, url: 'https://b.github.io/', debuggerSites: ['a.github.io'] }), true);
  assert.equal(shouldAttachOnNavigate({ enabled: false, url: 'https://b.github.io/', debuggerSites: ['a.github.io'] }), false);
  assert.equal(shouldAttachOnNavigate({ enabled: false, url: 'https://a.github.io/', debuggerSites: ['a.github.io'] }), true);
  assert.equal(shouldAttachOnNavigate({ enabled: true, url: 'https://a.github.io/', debuggerSites: ['a.github.io'] }), false);
});
