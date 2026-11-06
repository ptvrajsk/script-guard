import test from 'node:test';
import assert from 'node:assert/strict';
import { etld1, isSecureContextUrl, hostnameOf } from '../../src/shared/sites.js';

test('etld1 basic', () => {
  assert.equal(etld1('www.example.com'), 'example.com');
  assert.equal(etld1('a.b.c.example.org'), 'example.org');
  assert.equal(etld1('example.com'), 'example.com');
  assert.equal(etld1('EXAMPLE.com.'), 'example.com');
});
test('etld1 multi-part suffixes', () => {
  assert.equal(etld1('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(etld1('shop.example.com.au'), 'example.com.au');
  assert.equal(etld1('co.uk'), 'co.uk');
});
test('etld1 ip, localhost, empty', () => {
  assert.equal(etld1('127.0.0.1'), '127.0.0.1');
  assert.equal(etld1('[::1]'), '::1');
  assert.equal(etld1('localhost'), 'localhost');
  assert.equal(etld1(''), '');
  assert.equal(etld1(undefined), '');
});
test('etld1 no substring confusion', () => {
  assert.notEqual(etld1('evil-example.com'), etld1('example.com'));
  assert.equal(etld1('example.com.evil.net'), 'evil.net');
});
test('isSecureContextUrl', () => {
  assert.equal(isSecureContextUrl('https://a.com/x'), true);
  assert.equal(isSecureContextUrl('http://a.com/'), false);
  assert.equal(isSecureContextUrl('http://localhost:3000/'), true);
  assert.equal(isSecureContextUrl('http://127.0.0.1:8080/'), true);
  assert.equal(isSecureContextUrl('http://foo.localhost/'), true);
  assert.equal(isSecureContextUrl('http://localhost.evil.com/'), false);
  assert.equal(isSecureContextUrl('data:text/html,hi'), false);
  assert.equal(isSecureContextUrl('not a url'), false);
});
test('hostnameOf', () => {
  assert.equal(hostnameOf('https://A.com:8080/x'), 'a.com');
  assert.equal(hostnameOf('nope'), '');
});
test('etld1 treats shared hosting suffixes as public suffixes', () => {
  assert.equal(etld1('evil.github.io'), 'evil.github.io');
  assert.equal(etld1('www.evil.github.io'), 'evil.github.io');
  assert.equal(etld1('github.io'), 'github.io');
  assert.notEqual(etld1('a.github.io'), etld1('b.github.io'));
  assert.equal(etld1('x.y.vercel.app'), 'y.vercel.app');
  assert.equal(etld1('foo.s3.amazonaws.com'), 's3.amazonaws.com');
  assert.equal(etld1('a.pages.dev'), 'a.pages.dev');
  assert.equal(etld1('app.up.railway.app'), 'app.up.railway.app');
  assert.equal(etld1('www.github.com'), 'github.com');
  assert.equal(etld1('www.bbc.co.uk'), 'bbc.co.uk');
});
