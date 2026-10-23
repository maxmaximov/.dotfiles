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

const RESET = '2026-11-01T00:00:00Z';
const userInfo = (fields = {}) => ({
  user_id: 'u-test',
  keys: [{ token: 'not-copied' }],
  user_info: { spend: 12.5, max_budget: 1000, budget_duration: '1mo', budget_reset_at: RESET, ...fields },
});

test('parseUserInfo keeps the four user_info fields the block needs', () => {
  assert.deepEqual(budget.parseUserInfo(userInfo()), { spend: 12.5, maxBudget: 1000, resetAt: Date.parse(RESET), duration: '1mo' });
  assert.equal(budget.parseUserInfo(userInfo({ budget_duration: '7d' })).duration, '7d');
});

test('parseUserInfo turns missing or unsupported optional fields into null', () => {
  for (const max_budget of [null, 0, -5, '1000']) {
    assert.equal(budget.parseUserInfo(userInfo({ max_budget })).maxBudget, null, String(max_budget));
  }
  for (const budget_duration of [null, '30m', '0d', '1y', 'mo']) {
    assert.equal(budget.parseUserInfo(userInfo({ budget_duration })).duration, null, String(budget_duration));
  }
  for (const budget_reset_at of [null, 'soon', 1798761600000]) {
    assert.equal(budget.parseUserInfo(userInfo({ budget_reset_at })).resetAt, null, String(budget_reset_at));
  }
});

test('parseUserInfo reads a reset time without a zone as UTC', () => {
  for (const budget_reset_at of ['2026-11-01T00:00:00', '2026-11-01T00:00:00.000000', '2026-11-01T00:00:00+00:00', '2026-11-01T01:00:00+01:00']) {
    assert.equal(budget.parseUserInfo(userInfo({ budget_reset_at })).resetAt, Date.parse(RESET), budget_reset_at);
  }
});

test('parseUserInfo rejects responses without a numeric spend', () => {
  for (const json of [null, {}, { user_info: null }, { user_info: {} }, userInfo({ spend: '12.5' }), userInfo({ spend: null })]) {
    assert.throws(() => budget.parseUserInfo(json), /user_info/, JSON.stringify(json));
  }
});

const HOUR = 3_600_000;
const at = (iso) => Date.parse(iso);
const OCTOBER = { start: at('2026-10-01T00:00:00Z'), end: at('2026-11-01T00:00:00Z') };
const MID = at('2026-10-16T00:00:00Z'); // 15 of the 31 days have passed

test('budgetPeriod goes back from the reset by calendar months or by days', () => {
  assert.deepEqual(budget.budgetPeriod({ resetAt: OCTOBER.end, duration: '1mo' }), OCTOBER);
  assert.deepEqual(budget.budgetPeriod({ resetAt: OCTOBER.end, duration: '2mo' }), { start: at('2026-09-01T00:00:00Z'), end: OCTOBER.end });
  assert.deepEqual(budget.budgetPeriod({ resetAt: at('2026-10-26T00:00:00Z'), duration: '7d' }), {
    start: at('2026-10-19T00:00:00Z'),
    end: at('2026-10-26T00:00:00Z'),
  });
});

test('budgetPeriod is null without both the reset time and a supported duration', () => {
  assert.equal(budget.budgetPeriod({ resetAt: null, duration: '1mo' }), null);
  assert.equal(budget.budgetPeriod({ resetAt: OCTOBER.end, duration: null }), null);
  assert.equal(budget.budgetPeriod({ resetAt: OCTOBER.end, duration: '30m' }), null);
});

test('computeForecast extrapolates the average pace of the period', () => {
  const forecast = (spend) => budget.computeForecast({ spend, maxBudget: 1000, period: OCTOBER, now: MID });
  assert.deepEqual(forecast(600), { percent: 60, exhausted: false, forecast: 1240, runsOut: at('2026-10-26T00:00:00Z') });
  assert.deepEqual(forecast(300), { percent: 30, exhausted: false, forecast: 620, runsOut: null });
  assert.deepEqual(forecast(0), { percent: 0, exhausted: false, forecast: 0, runsOut: null });
  assert.equal(budget.computeForecast({ spend: 290, maxBudget: 1000, period: null, now: MID }).percent, 29);
});

test('computeForecast without a limit has no percent and no run-out date', () => {
  assert.deepEqual(budget.computeForecast({ spend: 300, maxBudget: null, period: OCTOBER, now: MID }), {
    percent: null,
    exhausted: false,
    forecast: 620,
    runsOut: null,
  });
});

test('computeForecast has no run-out date once the limit is exhausted', () => {
  const result = budget.computeForecast({ spend: 1003.7, maxBudget: 1000, period: OCTOBER, now: MID });
  assert.deepEqual([result.percent, result.exhausted, result.runsOut], [100, true, null]);
});

test('computeForecast has no forecast in the first 24 hours, after the end or without a period', () => {
  const forecastAt = (now, period = OCTOBER) => budget.computeForecast({ spend: 50, maxBudget: 1000, period, now }).forecast;
  assert.equal(forecastAt(OCTOBER.start + 24 * HOUR - 1), null);
  assert.equal(forecastAt(OCTOBER.start + 24 * HOUR), 50 * 31);
  assert.equal(forecastAt(OCTOBER.end + HOUR), null);
  assert.equal(forecastAt(MID, null), null);
});
