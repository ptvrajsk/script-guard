import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../src/background/debugger.js';
import { hashText } from '../../src/shared/patch.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

function fake({ rules = [], bodies = {}, failOn = {} } = {}) {
  const calls = [];
  const h = {};
  const a = {
    calls, state: { rules, saved: [], ka: [] },
    async attach(tabId) { calls.push(['attach', tabId]); if (failOn.attach) throw new Error(failOn.attach); },
    async detach(tabId) { calls.push(['detach', tabId]); },
    async send(target, method, params) {
      calls.push([method, target, params]);
      if (failOn[method]) throw new Error(failOn[method]);
      if (method === 'Fetch.getResponseBody') { const b = bodies[params.requestId]; if (!b) throw new Error('no body'); return b; }
      return {};
    },
    onEvent(fn) { h.event = fn; }, onDetach(fn) { h.detach = fn; }, onTabRemoved(fn) { h.removed = fn; }, onRulesChanged(fn) { h.rules = fn; },
    async getRules() { return a.state.rules; },
    async loadTabs() { return a.state.saved; }, async saveTabs(l) { a.state.saved = l; },
    keepAlive: { start() { a.state.ka.push('start'); }, stop() { a.state.ka.push('stop'); } },
  };
  return { a, h, calls };
}
const rule = (o) => ({ id: 'r1', name: 'n', enabled: true, urlPattern: 'http://x.test/*', ops: [{ type: 'replace', find: 'ORIGINAL', replace: 'PATCHED' }], createdAt: 1, ...o });
const paused = (o = {}) => ({ requestId: 'q1', resourceType: 'Script', request: { url: 'http://x.test/a.js#h' }, responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], ...o });
const last = (calls, m) => calls.filter((c) => c[0] === m).at(-1);

async function setup(opts, copts) {
  const f = fake(opts);
  const c = createController(f.a, copts);
  const events = [];
  c.setEventSink((e) => events.push(e));
  await c.init();
  await c.enableForTab(1);
  return { ...f, c, events, fire: async (p, src = { tabId: 1 }) => { f.h.event(src, 'Fetch.requestPaused', p); await c.whenIdle(); } };
}

test('enable: attach, flat auto-attach, Fetch.enable at Response stage for scripts only by default', async () => {
  const s = await setup();
  assert.ok(s.c.isEnabled(1));
  assert.equal(last(s.calls, 'Target.setAutoAttach')[2].flatten, true);
  assert.deepEqual(last(s.calls, 'Fetch.enable')[2].patterns, [{ resourceType: 'Script', requestStage: 'Response' }]);
  assert.deepEqual(s.a.state.saved, [1]);
});

test('Document pattern added only when a Document rule exists', async () => {
  const s = await setup({ rules: [rule({ resourceType: 'Document' })] });
  assert.equal(last(s.calls, 'Fetch.enable')[2].patterns.length, 2);
});

test('enable failure detaches and leaves tab disabled', async () => {
  const s = fake({ failOn: { 'Fetch.enable': 'boom' } });
  const c = createController(s.a);
  await assert.rejects(c.enableForTab(5));
  assert.ok(!c.isEnabled(5));
  assert.ok(s.calls.some((x) => x[0] === 'detach'));
});

test('patches a plain body: rule match, hash ignored, content-type charset forced, headers stripped', async () => {
  const s = await setup({
    rules: [rule()],
    bodies: { q1: { body: "window.x='ORIGINAL';", base64Encoded: false } },
  });
  await s.fire(paused({ responseHeaders: [
    { name: 'Content-Type', value: 'text/javascript; charset=ISO-8859-1' }, { name: 'Content-Encoding', value: 'gzip' },
    { name: 'content-length', value: '99' }, { name: 'X-Keep', value: '1' }] }));
  const f = last(s.calls, 'Fetch.fulfillRequest');
  assert.ok(f, 'fulfilled');
  assert.equal(unb64(f[2].body), "window.x='PATCHED';");
  const names = f[2].responseHeaders.map((h) => h.name.toLowerCase());
  assert.ok(!names.includes('content-encoding') && !names.includes('content-length'));
  assert.ok(names.includes('x-keep'));
  assert.equal(f[2].responseHeaders.find((h) => /content-type/i.test(h.name)).value, 'text/javascript; charset=utf-8');
  assert.equal(f[2].responseCode, 200);
  assert.ok(s.events.some((e) => e.kind === 'script.patched' && e.detail.rules[0].id === 'r1'));
  assert.ok(s.events.some((e) => e.kind === 'script.scored'));
  assert.ok(!s.calls.some((x) => x[0] === 'Fetch.continueResponse'));
});

test('base64 (decoded gzip) body is patched', async () => {
  const s = await setup({ rules: [rule()], bodies: { q1: { body: b64("a='ORIGINAL é'"), base64Encoded: true } } });
  await s.fire(paused());
  assert.equal(unb64(last(s.calls, 'Fetch.fulfillRequest')[2].body), "a='PATCHED é'");
});

test('no matching rule: scores and continues without fulfilling', async () => {
  const s = await setup({ rules: [rule({ urlPattern: 'http://other/*' })], bodies: { q1: { body: 'x', base64Encoded: false } } });
  await s.fire(paused());
  assert.ok(last(s.calls, 'Fetch.continueResponse'));
  assert.ok(!last(s.calls, 'Fetch.fulfillRequest'));
  assert.ok(s.events.some((e) => e.kind === 'script.scored' && e.detail.url === 'http://x.test/a.js'));
});

test('disabled and invalid rules are ignored', async () => {
  const s = await setup({ rules: [rule({ enabled: false }), { garbage: 1 }], bodies: { q1: { body: 'ORIGINAL', base64Encoded: false } } });
  await s.fire(paused());
  assert.ok(!last(s.calls, 'Fetch.fulfillRequest'));
});

test('stale rule fails open and emits script.stale', async () => {
  const s = await setup({ rules: [rule({ ops: [{ type: 'replace', find: 'GONE', replace: 'x' }] })], bodies: { q1: { body: 'ORIGINAL', base64Encoded: false } } });
  await s.fire(paused());
  assert.ok(!last(s.calls, 'Fetch.fulfillRequest'));
  assert.ok(last(s.calls, 'Fetch.continueResponse'));
  const ev = s.events.find((e) => e.kind === 'script.stale');
  assert.equal(ev.detail.ruleId, 'r1');
});

test('partially applicable rule is all-or-nothing', async () => {
  const s = await setup({ rules: [rule({ ops: [{ type: 'replace', find: 'ORIGINAL', replace: 'P' }, { type: 'replace', find: 'GONE', replace: 'x' }] })], bodies: { q1: { body: 'ORIGINAL', base64Encoded: false } } });
  await s.fire(paused());
  assert.ok(!last(s.calls, 'Fetch.fulfillRequest'));
});

test('expectedHash: mismatch with intact anchors still applies and is flagged; match is clean', async () => {
  const body = 'ORIGINAL';
  let s = await setup({ rules: [rule({ expectedHash: 'f'.repeat(64) })], bodies: { q1: { body, base64Encoded: false } } });
  await s.fire(paused());
  assert.ok(last(s.calls, 'Fetch.fulfillRequest'));
  assert.equal(s.events.find((e) => e.kind === 'script.patched').detail.rules[0].hashMismatch, true);
  s = await setup({ rules: [rule({ expectedHash: await hashText(body) })], bodies: { q1: { body, base64Encoded: false } } });
  await s.fire(paused());
  assert.equal(s.events.find((e) => e.kind === 'script.patched').detail.rules[0].hashMismatch, false);
});

test('blockScript fails the request without reading the body', async () => {
  const s = await setup({ rules: [rule({ ops: [{ type: 'blockScript' }] })] });
  await s.fire(paused());
  const f = last(s.calls, 'Fetch.failRequest');
  assert.equal(f[2].errorReason, 'BlockedByClient');
  assert.ok(!last(s.calls, 'Fetch.getResponseBody'));
  assert.ok(s.events.some((e) => e.kind === 'script.patched' && e.detail.blocked));
});

test('blockScript failRequest error falls back to continue', async () => {
  const s = await setup({ rules: [rule({ ops: [{ type: 'blockScript' }] })], failOn: { 'Fetch.failRequest': 'x' } });
  await s.fire(paused());
  assert.ok(last(s.calls, 'Fetch.continueResponse'));
});

test('oversize: content-length header and actual body both fail open', async () => {
  const s = await setup({ rules: [rule()], bodies: { q1: { body: 'ORIGINAL' + 'x'.repeat(100), base64Encoded: false } } }, { maxBodyBytes: 50 });
  await s.fire(paused({ responseHeaders: [{ name: 'Content-Length', value: '9999' }] }));
  assert.ok(!last(s.calls, 'Fetch.getResponseBody'));
  assert.ok(last(s.calls, 'Fetch.continueResponse'));
  s.calls.length = 0;
  await s.fire(paused());
  assert.ok(last(s.calls, 'Fetch.getResponseBody'));
  assert.ok(!last(s.calls, 'Fetch.fulfillRequest'));
  assert.ok(last(s.calls, 'Fetch.continueResponse'));
});

test('fail open on getResponseBody error, bad charset, fulfill error and timeout', async () => {
  let s = await setup({ rules: [rule()] }); // no body registered -> getResponseBody throws
  await s.fire(paused());
  assert.ok(last(s.calls, 'Fetch.continueResponse'));
  assert.equal(s.c._pendingCount(), 0);

  s = await setup({ rules: [rule()], bodies: { q1: { body: b64('ORIGINAL'), base64Encoded: true } } });
  await s.fire(paused({ responseHeaders: [{ name: 'content-type', value: 'text/javascript; charset=nonsense-9' }] }));
  assert.ok(!last(s.calls, 'Fetch.fulfillRequest'));
  assert.ok(last(s.calls, 'Fetch.continueResponse'));

  s = await setup({ rules: [rule()], bodies: { q1: { body: 'ORIGINAL', base64Encoded: false } }, failOn: { 'Fetch.fulfillRequest': 'detached' } });
  await s.fire(paused());
  assert.ok(last(s.calls, 'Fetch.continueResponse'));

  const slow = fake({ rules: [rule()] });
  slow.a.send = async (t, m) => { slow.calls.push([m, t]); if (m === 'Fetch.getResponseBody') await new Promise(() => {}); return {}; };
  const c = createController(slow.a, { timeoutMs: 20 });
  await c.init(); await c.enableForTab(1);
  slow.h.event({ tabId: 1 }, 'Fetch.requestPaused', paused());
  await c.whenIdle();
  assert.ok(last(slow.calls, 'Fetch.continueResponse'));
});

test('redirects, errors and empty statuses are passed through without reading body', async () => {
  const s = await setup({ rules: [rule()] });
  for (const o of [{ responseStatusCode: 302 }, { responseStatusCode: 204 }, { responseErrorReason: 'Failed', responseStatusCode: undefined }, { responseStatusCode: undefined }]) {
    s.calls.length = 0;
    await s.fire(paused(o));
    assert.ok(!last(s.calls, 'Fetch.getResponseBody'));
    assert.ok(last(s.calls, 'Fetch.continueResponse'));
  }
});

test('multiple rules compose; a stale one is skipped without blocking the other', async () => {
  const s = await setup({
    rules: [rule({ id: 'a', ops: [{ type: 'replace', find: 'ORIGINAL', replace: 'ONE' }] }), rule({ id: 'b', ops: [{ type: 'replace', find: 'NOPE', replace: 'x' }] }), rule({ id: 'c', ops: [{ type: 'replace', find: 'ONE', replace: 'TWO' }] })],
    bodies: { q1: { body: 'ORIGINAL', base64Encoded: false } },
  });
  await s.fire(paused());
  assert.equal(unb64(last(s.calls, 'Fetch.fulfillRequest')[2].body), 'TWO');
  assert.deepEqual(s.events.filter((e) => e.kind === 'script.stale').map((e) => e.detail.ruleId), ['b']);
});

test('keep-alive spans pending requests; cleared on detach', async () => {
  const s = fake({ rules: [rule()] });
  let release;
  s.a.send = async (t, m, p) => { s.calls.push([m, t, p]); if (m === 'Fetch.getResponseBody') await new Promise((r) => { release = r; }); return m === 'Fetch.getResponseBody' ? { body: 'ORIGINAL', base64Encoded: false } : {}; };
  const c = createController(s.a);
  await c.init(); await c.enableForTab(1);
  s.h.event({ tabId: 1 }, 'Fetch.requestPaused', paused());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.a.state.ka, ['start']);
  assert.equal(c._pendingCount(), 1);
  release(); await c.whenIdle();
  assert.deepEqual(s.a.state.ka, ['start', 'stop']);

  s.h.event({ tabId: 1 }, 'Fetch.requestPaused', paused({ requestId: 'q2' }));
  await new Promise((r) => setImmediate(r));
  s.h.detach(1, 'canceled_by_user'); // e.g. DevTools opened
  assert.ok(!c.isEnabled(1));
  assert.equal(c._pendingCount(), 0);
  assert.deepEqual(s.a.state.ka.slice(-1), ['stop']);
  release(); await c.whenIdle(); // late completion must not go negative or throw
  assert.equal(c._pendingCount(), 0);
});

test('state removed on tab close; events for unknown tabs ignored', async () => {
  const s = await setup({ rules: [rule()] });
  s.h.removed(1);
  assert.ok(!s.c.isEnabled(1));
  assert.deepEqual(s.a.state.saved, []);
  s.calls.length = 0;
  await s.fire(paused());
  assert.equal(s.calls.length, 0);
});

test('disableForTab detaches; idempotent enable', async () => {
  const s = await setup();
  await s.c.enableForTab(1);
  assert.equal(s.calls.filter((x) => x[0] === 'attach').length, 1);
  assert.ok(await s.c.disableForTab(1));
  assert.ok(s.calls.some((x) => x[0] === 'detach'));
  assert.ok(!(await s.c.disableForTab(1)));
});

test('child sessions get Fetch.enable, are resumed, and requests route to their session', async () => {
  const s = await setup({ rules: [rule()], bodies: { q1: { body: 'ORIGINAL', base64Encoded: false } } });
  s.h.event({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'S1', waitingForDebugger: true, targetInfo: { type: 'iframe' } });
  await s.c.whenIdle();
  const fe = s.calls.filter((x) => x[0] === 'Fetch.enable' && x[1].sessionId === 'S1');
  assert.equal(fe.length, 1);
  assert.ok(s.calls.some((x) => x[0] === 'Runtime.runIfWaitingForDebugger' && x[1].sessionId === 'S1'));
  await s.fire(paused(), { tabId: 1, sessionId: 'S1' });
  assert.equal(last(s.calls, 'Fetch.fulfillRequest')[1].sessionId, 'S1');
});

test('child enable failure still resumes the target (fail open)', async () => {
  const s = await setup();
  const orig = s.a.send;
  s.a.send = async (t, m, p) => { if (t.sessionId && m === 'Fetch.enable') { s.calls.push([m, t, p]); throw new Error('x'); } return orig(t, m, p); };
  s.h.event({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'S2', waitingForDebugger: true, targetInfo: { type: 'worker' } });
  await s.c.whenIdle();
  assert.ok(s.calls.some((x) => x[0] === 'Runtime.runIfWaitingForDebugger' && x[1].sessionId === 'S2'));
});

test('rule changes re-send Fetch.enable patterns', async () => {
  const s = await setup();
  s.a.state.rules = [rule({ resourceType: 'Document' })];
  s.h.rules();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(last(s.calls, 'Fetch.enable')[2].patterns.length, 2);
});

test('init re-adopts persisted tabs after a service-worker restart', async () => {
  const f = fake(); f.a.state.saved = [7, 8];
  const c = createController(f.a);
  await c.init();
  assert.ok(c.isEnabled(7) && c.isEnabled(8));
});

test('sink errors never break request handling', async () => {
  const s = await setup({ rules: [rule()], bodies: { q1: { body: 'ORIGINAL', base64Encoded: false } } });
  s.c.setEventSink(() => { throw new Error('sink'); });
  await s.fire(paused());
  assert.ok(last(s.calls, 'Fetch.fulfillRequest'));
});
