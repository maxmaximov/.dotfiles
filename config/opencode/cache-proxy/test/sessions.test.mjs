// test/sessions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, DAY_MS } from '../lib/sessions.mjs';

const MIN = 60_000;
const cfg = { pingAfterMs: 55 * MIN, retryEveryMs: MIN };
const real = (o = {}) => ({
  body: '{"model":"m"}', headers: { 'x-api-key': 'k' }, model: 'm', path: '/v1/messages', start: 1000, oneHour: true, ...o,
});
const hour = { input: 1, cacheRead: 0, cacheWrite: 500, write5m: 0, write1h: 500, output: 3 };
const fiveMin = { ...hour, write5m: 500, write1h: 0 };

test('a 200 request with 1h-only usage makes the session pingable', () => {
  const store = new SessionStore(cfg);
  store.beginReal('s1');
  store.recordReal('s1', real());
  assert.equal(store.get('s1').pingable, false);
  store.setUsage('s1', 1000, hour);
  store.endReal('s1');
  const s = store.get('s1');
  assert.deepEqual([s.pingable, s.inFlight, s.lastReal, s.lastTouch], [true, 0, 1000, 1000]);
});

test('not pingable with 5-minute writes, without usage, or without 1h markers', () => {
  const store = new SessionStore(cfg);
  store.recordReal('a', real());
  store.setUsage('a', 1000, fiveMin);
  store.recordReal('b', real());
  store.setUsage('b', 1000, null);
  store.recordReal('c', real({ oneHour: false }));
  store.setUsage('c', 1000, hour);
  assert.deepEqual(['a', 'b', 'c'].map((id) => store.get(id).pingable), [false, false, false]);
});

test('usage of an older request does not override a newer one', () => {
  const store = new SessionStore(cfg);
  store.recordReal('s', real({ start: 1000 }));
  store.recordReal('s', real({ start: 2000 }));
  store.setUsage('s', 1000, hour);
  assert.equal(store.get('s').pingable, false);
  store.setUsage('s', 2000, hour);
  assert.equal(store.get('s').pingable, true);
});

test('ping outcomes: ok moves lastTouch, retry counts attempts, miss and rejected ask to stop', () => {
  const store = new SessionStore(cfg);
  store.recordReal('s', real());
  store.setUsage('s', 1000, hour);
  assert.equal(store.recordPing('s', 5000, 'retry'), null);
  assert.equal(store.get('s').attempts, 1);
  assert.equal(store.recordPing('s', 6000, 'ok'), null);
  const s = store.get('s');
  assert.deepEqual([s.lastTouch, s.attempts, s.pings], [6000, 0, 1]);
  assert.equal(store.recordPing('s', 7000, 'miss'), 'miss');
  assert.equal(store.recordPing('s', 7000, 'rejected'), 'rejected');
});

test('a ping that started before a newer real request is ignored', () => {
  const store = new SessionStore(cfg);
  store.recordReal('s', real({ start: 1000 }));
  store.setUsage('s', 1000, hour);
  store.recordReal('s', real({ start: 9000 }));
  assert.equal(store.recordPing('s', 5000, 'miss'), null);
  assert.equal(store.get('s').lastTouch, 9000);
});

test('stop drops body and headers; a new real request restarts the session', () => {
  const store = new SessionStore(cfg);
  store.recordReal('s', real());
  store.setUsage('s', 1000, hour);
  store.stop('s', 'late');
  const s = store.get('s');
  assert.deepEqual([s.stopped, s.body, s.headers, s.pingable], ['late', null, null, false]);
  store.recordReal('s', real({ start: 2000 }));
  assert.deepEqual([s.stopped, s.body], [null, '{"model":"m"}']);
});

test('rolling 24-hour ping counter', () => {
  const store = new SessionStore(cfg);
  store.notePingSent(0);
  store.notePingSent(1000);
  assert.equal(store.pingsLast24h(DAY_MS - 1), 2);
  assert.equal(store.pingsLast24h(DAY_MS), 1);
  assert.equal(store.pingsLast24h(DAY_MS + 1000), 0);
});

test('sweep forgets sessions idle for more than a day, keeps busy ones', () => {
  const store = new SessionStore(cfg);
  store.recordReal('old', real({ start: 0 }));
  store.recordReal('new', real({ start: DAY_MS }));
  store.beginReal('busy');
  store.sweep(DAY_MS + 1);
  assert.deepEqual(store.all().map((s) => s.id).sort(), ['busy', 'new']);
});

test('snapshot has the next ping time and no bodies or headers', () => {
  const store = new SessionStore(cfg);
  const t0 = Date.parse('2026-10-22T10:00:00Z');
  store.recordReal('s', real({ start: t0 }));
  store.setUsage('s', t0, hour);
  const [row] = store.snapshot();
  assert.equal(row.session, 's');
  assert.equal(row.nextPing, '2026-10-22T10:55:00.000Z');
  assert.equal('body' in row || 'headers' in row, false);
  assert.equal(JSON.stringify(row).includes('"k"'), false);
});
