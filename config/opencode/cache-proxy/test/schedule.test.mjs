// test/schedule.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, classifyPing, nextPingAt } from '../lib/schedule.mjs';

const MIN = 60_000;
const cfg = { pingAfterMs: 55 * MIN, retryEveryMs: MIN, maxAttempts: 3, lateAfterMs: 58 * MIN, windowMs: 12 * 60 * MIN, dailyCap: 200 };
const session = (o = {}) => ({
  pingable: true, body: '{}', stopped: null, inFlight: 0, pingInFlight: false,
  lastReal: 0, lastTouch: 0, attempts: 0, pings: 0, ...o,
});

test('waits until 55 minutes after the last touch, then pings', () => {
  assert.deepEqual(decide(session(), 54 * MIN + 59_999, 0, cfg), { action: 'wait' });
  assert.deepEqual(decide(session(), 55 * MIN, 0, cfg), { action: 'ping' });
});

test('retries at +56 and +57, then stops as failed', () => {
  assert.equal(nextPingAt(session({ attempts: 1 }), cfg), 56 * MIN);
  assert.deepEqual(decide(session({ attempts: 1 }), 55.5 * MIN, 0, cfg), { action: 'wait' });
  assert.deepEqual(decide(session({ attempts: 1 }), 56 * MIN, 0, cfg), { action: 'ping' });
  assert.deepEqual(decide(session({ attempts: 2 }), 57 * MIN, 0, cfg), { action: 'ping' });
  assert.deepEqual(decide(session({ attempts: 3 }), 57.5 * MIN, 0, cfg), { action: 'stop', reason: 'failed' });
});

test('never starts later than +58 minutes', () => {
  assert.deepEqual(decide(session(), 58 * MIN, 0, cfg), { action: 'ping' });
  assert.deepEqual(decide(session(), 58 * MIN + 1, 0, cfg), { action: 'stop', reason: 'late' });
});

test('stops when the 12-hour window is over; at most 13 pings per pause', () => {
  const s = session();
  let pings = 0;
  for (;;) {
    const t = s.lastTouch + cfg.pingAfterMs;
    const d = decide(s, t, 0, cfg);
    if (d.action !== 'ping') {
      assert.deepEqual(d, { action: 'stop', reason: 'window' });
      break;
    }
    pings += 1;
    s.lastTouch = t;
  }
  assert.equal(pings, 13);
});

test('does nothing while a request or a ping is in flight, or when not pingable', () => {
  assert.deepEqual(decide(session({ inFlight: 1 }), 55 * MIN, 0, cfg), { action: 'wait' });
  assert.deepEqual(decide(session({ pingInFlight: true }), 55 * MIN, 0, cfg), { action: 'wait' });
  assert.deepEqual(decide(session({ pingable: false }), 55 * MIN, 0, cfg), { action: 'wait' });
  assert.deepEqual(decide(session({ body: null }), 55 * MIN, 0, cfg), { action: 'wait' });
  assert.deepEqual(decide(session({ stopped: 'miss' }), 55 * MIN, 0, cfg), { action: 'wait' });
});

test('respects the daily cap', () => {
  assert.deepEqual(decide(session(), 55 * MIN, 200, cfg), { action: 'wait', capped: true });
  assert.deepEqual(decide(session(), 55 * MIN, 199, cfg), { action: 'ping' });
});

test('classifyPing', () => {
  assert.equal(classifyPing({ status: 200, hit: true }), 'ok');
  assert.equal(classifyPing({ status: 200, hit: false }), 'miss');
  assert.equal(classifyPing({ status: null, hit: false }), 'retry');
  assert.equal(classifyPing({ status: 429, hit: false }), 'retry');
  assert.equal(classifyPing({ status: 529, hit: false }), 'retry');
  assert.equal(classifyPing({ status: 500, hit: false }), 'retry');
  assert.equal(classifyPing({ status: 400, hit: false }), 'rejected');
  assert.equal(classifyPing({ status: 401, hit: false }), 'rejected');
});
