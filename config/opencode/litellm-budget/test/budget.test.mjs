// test/budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as budget from '../lib/budget.mjs';

test('userInfoUrl drops trailing slashes and a final /v1 but keeps a path prefix', () => {
  assert.equal(budget.userInfoUrl('http://127.0.0.1:18765/v1'), 'http://127.0.0.1:18765/user/info');
  assert.equal(budget.userInfoUrl('https://llm.example/v1/'), 'https://llm.example/user/info');
  assert.equal(budget.userInfoUrl('https://llm.example'), 'https://llm.example/user/info');
  assert.equal(budget.userInfoUrl('https://llm.example/prefix/v1'), 'https://llm.example/prefix/user/info');
  assert.equal(budget.userInfoUrl('https://llm.example/v1x'), 'https://llm.example/v1x/user/info');
});

test('userInfoUrl drops query and fragment and keeps the origin', () => {
  assert.equal(budget.userInfoUrl('https://llm.example/prefix/v1?x=1#y'), 'https://llm.example/prefix/user/info');
  assert.equal(budget.userInfoUrl('https://llm.example//evil.example/v1'), 'https://llm.example//evil.example/user/info');
});

test('userInfoUrl rejects URLs that are not http(s)', () => {
  assert.throws(() => budget.userInfoUrl('ftp://llm.example/v1'), /must be http/);
  assert.throws(() => budget.userInfoUrl('not a url'), TypeError);
});

test('resolveApiKey returns a literal key or the value of an {env:NAME} template', () => {
  assert.equal(budget.resolveApiKey(' sk-test-literal ', {}), 'sk-test-literal');
  assert.equal(budget.resolveApiKey('{env:TEST_KEY}', { TEST_KEY: 'sk-test-env' }), 'sk-test-env');
});

test('resolveApiKey returns null when there is no usable key', () => {
  for (const value of [undefined, null, 42, '', '   ', '{env:MISSING}', '{env:BLANK}']) {
    assert.equal(budget.resolveApiKey(value, { BLANK: ' ' }), null, String(value));
  }
});
