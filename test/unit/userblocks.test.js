import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlockRules, validateBlock, addBlock, sanitizeBlocks, isBlockedUrl, escapeRegex, BLOCK_TYPES, MAX_BLOCKS } from '../../src/background/userblocks.js';
import { USER_RULE_ID_BASE, buildRules } from '../../src/background/dnr.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const blk = (kind, value, id = 'x' + value) => ({ id, kind, value, createdAt: 1 });

test('host blocks use requestDomains and never block main_frame', () => {
  const [r] = buildBlockRules([blk('host', 'ads.example.net')]);
  assert.equal(r.id, USER_RULE_ID_BASE);
  assert.deepEqual(r.condition.requestDomains, ['ads.example.net']);
  assert.equal(r.action.type, 'block');
  assert.ok(!r.condition.resourceTypes.includes('main_frame'));
  assert.deepEqual(r.condition.resourceTypes, BLOCK_TYPES);
});

test('url blocks: exact match with query, optional query without', () => {
  const [a, b] = buildBlockRules([blk('url', 'https://x.io/a.js?v=1'), blk('url', 'https://x.io/b.js')]);
  assert.equal(a.condition.urlFilter, '|https://x.io/a.js?v=1|');
  assert.equal(b.condition.urlFilter, '|https://x.io/b.js^');
  assert.equal(a.condition.isUrlFilterCaseSensitive, true);
  assert.equal(b.id, USER_RULE_ID_BASE + 1);
});

test('urls with filter metacharacters fall back to an escaped regex', () => {
  const [r] = buildBlockRules([blk('url', 'https://x.io/a.js?q=1|2*3')]);
  assert.equal(r.condition.urlFilter, undefined);
  const re = new RegExp(r.condition.regexFilter);
  assert.ok(re.test('https://x.io/a.js?q=1|2*3'));
  assert.ok(!re.test('https://x.io/a.js?q=1|2*3&more'));
  assert.ok(!re.test('https://x.io/aXjs?q=1|2*3'));
  assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c');
});

test('rule ids stay clear of dnr.js ranges', () => {
  const bad = buildRules(undefined, { badHosts: Array.from({ length: 50 }, (_, i) => `h${i}.example.com`) });
  assert.ok(Math.max(...bad.map((r) => r.id)) < USER_RULE_ID_BASE);
  assert.ok(USER_RULE_ID_BASE > 2000 + 20000 - 1);
});

test('malformed stored blocks are dropped', () => {
  const out = buildBlockRules([blk('host', 'not a host'), blk('host', 'a.example.com'), blk('host', 'a.example.com', 'dupe'), { id: 1 }, null, blk('url', 'ftp://x.io/a.js'), blk('foo', 'x.io')]);
  assert.equal(out.length, 1);
  assert.equal(sanitizeBlocks('nope').length, 0);
});

test('validateBlock refuses garbage, the extension and the top-level site', () => {
  const top = 'https://news.example.com/story';
  assert.equal(validateBlock({ kind: 'host', value: 'ads.tracker.net' }, { extId: EXT }).value, 'ads.tracker.net');
  assert.equal(validateBlock({ kind: 'host', value: 'https://Ads.Tracker.net/x.js' }).value, 'ads.tracker.net');
  assert.equal(validateBlock({ kind: 'host', value: 'localhost' }).ok, true);
  assert.equal(validateBlock({ kind: 'host', value: '127.0.0.1' }).ok, true);
  for (const v of ['', 'nodot', 'a b.com', '999.1.1.1', '*.com', EXT]) {
    assert.equal(validateBlock({ kind: 'host', value: v }, { extId: EXT }).ok, false, v);
  }
  assert.equal(validateBlock({ kind: 'host', value: 'chrome-extension://' + EXT + '/a.js' }, { extId: EXT }).ok, false);
  assert.equal(validateBlock({ kind: 'url', value: `chrome-extension://${EXT}/a.js` }, { extId: EXT }).ok, false);
  assert.equal(validateBlock({ kind: 'url', value: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateBlock({ kind: 'url', value: 'https://x.io/a.js#frag' }).value, 'https://x.io/a.js');
  assert.equal(validateBlock({ kind: 'url', value: 'https://x.io/' + 'a'.repeat(600) }).ok, false);
  assert.equal(validateBlock({ kind: 'bogus', value: 'x.io' }).ok, false);
  // top-level site
  assert.equal(validateBlock({ kind: 'host', value: 'news.example.com' }, { topUrl: top }).ok, false);
  assert.equal(validateBlock({ kind: 'host', value: 'example.com' }, { topUrl: top }).ok, false);
  assert.equal(validateBlock({ kind: 'url', value: top }, { topUrl: top }).ok, false);
  assert.equal(validateBlock({ kind: 'host', value: 'cdn.example.com' }, { topUrl: top }).ok, true);
  assert.equal(validateBlock({ kind: 'host', value: 'notexample.com' }, { topUrl: top }).ok, true);
  assert.equal(validateBlock({ kind: 'url', value: 'https://news.example.com/app.js' }, { topUrl: top }).ok, true);
});

test('addBlock dedupes and caps', () => {
  const v = { kind: 'host', value: 'a.example.com' };
  const r1 = addBlock([], v, 5, 'id1');
  assert.equal(r1.blocks.length, 1);
  const r2 = addBlock(r1.blocks, v, 6, 'id2');
  assert.equal(r2.duplicate, true);
  assert.equal(r2.blocks.length, 1);
  const full = Array.from({ length: MAX_BLOCKS }, (_, i) => blk('host', `h${i}.example.com`, 'i' + i));
  assert.ok(addBlock(full, v).error);
});

test('isBlockedUrl mirrors the rules', () => {
  const blocks = [blk('host', 'ads.net'), blk('url', 'https://x.io/a.js'), blk('url', 'https://x.io/b.js?v=1')];
  assert.ok(isBlockedUrl('https://ads.net/x.js', blocks));
  assert.ok(isBlockedUrl('https://sub.ads.net/x.js', blocks));
  assert.ok(!isBlockedUrl('https://notads.net/x.js', blocks));
  assert.ok(isBlockedUrl('https://x.io/a.js?cb=9', blocks));
  assert.ok(!isBlockedUrl('https://x.io/b.js', blocks));
  assert.ok(isBlockedUrl('https://x.io/b.js?v=1#h', blocks));
  assert.ok(!isBlockedUrl('garbage', blocks));
});
