// test/pinger.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePingBody, pingHeaders, createPinger, errorSummary, PING_UA } from '../lib/pinger.mjs';
import { SessionStore } from '../lib/sessions.mjs';
import { createJournal } from '../lib/journal.mjs';
import {
  KEY, MIN, clock, testConfig, startUpstream, usage, jsonOf, opencodeBody, opencodeHeaders, readJournal, journalText,
} from './helpers.mjs';

const hit = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(jsonOf(usage({ read: 900 })));
};

// A pingable session whose last real request started at the current fake time.
async function setup(handler, overrides = {}) {
  const upstream = await startUpstream(handler);
  const cfg = testConfig(upstream.origin, overrides);
  const c = clock();
  const store = new SessionStore(cfg);
  const pinger = createPinger({ cfg, store, journal: createJournal(cfg.stateDir, c.now), now: c.now });
  const addSession = (id = 'ses_test') => {
    store.recordReal(id, {
      body: JSON.stringify(opencodeBody()), headers: opencodeHeaders(id), model: 'claude-test', path: '/v1/messages', start: c.t, oneHour: true,
    });
    store.setUsage(id, c.t, { input: 3, cacheRead: 0, cacheWrite: 900, write5m: 0, write1h: 900, output: 5 });
  };
  const run = async (ms) => {
    c.advance(ms);
    pinger.tick();
    await pinger.drain();
  };
  const journal = (kind) => readJournal(cfg.stateDir).filter((r) => r.kind === kind);
  return { upstream, cfg, c, store, pinger, addSession, run, journal, close: () => upstream.close() };
}

test('makePingBody changes only max_tokens and stream', () => {
  const body = opencodeBody();
  assert.deepEqual(JSON.parse(makePingBody(JSON.stringify(body), 0)), { ...body, max_tokens: 0, stream: false });
});

test('pingHeaders marks user-agent and keeps everything else', () => {
  const headers = opencodeHeaders('s');
  assert.deepEqual(pingHeaders(headers), { ...headers, 'user-agent': `opencode/1.18.31 test ${PING_UA}` });
  assert.equal(pingHeaders({})['user-agent'], PING_UA);
});

test('errorSummary keeps the type and message of an upstream error and redacts credentials', () => {
  assert.equal(
    errorSummary('{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be at least 1"}}'),
    'invalid_request_error: max_tokens: must be at least 1',
  );
  assert.equal(
    errorSummary('{"error":{"message":"Invalid key sk-abc123def, Bearer tok_456 and k-secret-value-789","type":"auth_error"}}', ['k-secret-value-789']),
    'auth_error: Invalid key sk-[redacted], Bearer [redacted] and [redacted]',
  );
  assert.equal(errorSummary('{"error":{"type":"auth_error","message":"bad key abc123"}}', ['abc123', '']), 'auth_error: bad key [redacted]');
  assert.equal(errorSummary('<html>502 Bad Gateway</html>'), 'unparsed error body, 28 bytes');
  assert.equal(errorSummary('{"error":{}}'), 'error without type or message');
});

test('pings 55 minutes after the last request with the same headers, then again 55 minutes later', async () => {
  const t = await setup(hit);
  t.addSession();
  await t.run(55 * MIN - 1);
  assert.equal(t.upstream.requests.length, 0);
  await t.run(1);
  assert.equal(t.upstream.requests.length, 1);
  const [ping] = t.upstream.requests;
  assert.equal(ping.url, '/v1/messages');
  assert.deepEqual(JSON.parse(ping.body), { ...opencodeBody(), max_tokens: 0, stream: false });
  for (const name of ['x-api-key', 'anthropic-beta', 'anthropic-version', 'x-session-id', 'x-session-affinity']) {
    assert.equal(ping.headers[name], opencodeHeaders()[name], name);
  }
  assert.equal(ping.headers['user-agent'], `opencode/1.18.31 test ${PING_UA}`);
  const s = t.store.get('ses_test');
  assert.deepEqual([s.lastTouch, s.pings, s.stopped], [t.c.t, 1, null]);
  await t.run(55 * MIN - 1);
  assert.equal(t.upstream.requests.length, 1);
  await t.run(1);
  assert.equal(t.upstream.requests.length, 2);
  assert.deepEqual(t.journal('ping').map((r) => [r.status, r.cache_read, r.output, r.ping_n, r.reason]), [
    [200, 900, 0, 1, 'ok'], [200, 900, 0, 2, 'ok'],
  ]);
  assert.equal(journalText(t.cfg.stateDir).includes(KEY), false);
  await t.close();
});

test('a ping that writes the cache is a miss: pings stop, body and key are dropped', async () => {
  const t = await setup((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jsonOf(usage({ write1h: 900 })));
  });
  t.addSession();
  await t.run(55 * MIN);
  const s = t.store.get('ses_test');
  assert.deepEqual([s.stopped, s.body, s.headers], ['miss', null, null]);
  await t.run(55 * MIN);
  assert.equal(t.upstream.requests.length, 1);
  assert.deepEqual(t.journal('stop').map((r) => r.reason), ['miss']);
  await t.close();
});

test('a 4xx other than 429 stops as rejected and journals the error without credentials', async () => {
  const t = await setup((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `bad key ${req.headers['x-api-key']}` } }));
  });
  t.addSession();
  await t.run(55 * MIN);
  assert.equal(t.store.get('ses_test').stopped, 'rejected');
  assert.equal(t.journal('ping')[0].error, 'invalid_request_error: bad key [redacted]');
  assert.equal(journalText(t.cfg.stateDir).includes(KEY), false);
  await t.close();
});

test('429 and 5xx are retried at +56 and +57 minutes; a success resets attempts', async () => {
  let n = 0;
  const t = await setup((req, res) => {
    n += 1;
    if (n > 2) return hit(req, res);
    res.writeHead(n === 1 ? 429 : 529, { 'content-type': 'application/json' });
    res.end('{"type":"error"}');
  });
  t.addSession();
  await t.run(55 * MIN);
  await t.run(MIN / 2);
  assert.equal(t.upstream.requests.length, 1);
  await t.run(MIN / 2);
  await t.run(MIN);
  assert.equal(t.upstream.requests.length, 3);
  const s = t.store.get('ses_test');
  assert.deepEqual([s.attempts, s.pings, s.stopped, s.lastTouch], [0, 1, null, t.c.t]);
  assert.deepEqual(t.journal('ping').map((r) => r.reason), ['retry', 'retry', 'ok']);
  await t.close();
});

test('network errors are retried; three failed attempts stop as failed', async () => {
  const t = await setup((req, res) => res.destroy());
  t.addSession();
  await t.run(55 * MIN);
  await t.run(MIN);
  await t.run(MIN);
  assert.equal(t.upstream.requests.length, 3);
  assert.equal(t.store.get('ses_test').stopped, null);
  await t.run(MIN / 2);
  assert.equal(t.store.get('ses_test').stopped, 'failed');
  await t.close();
});

test('a ping that times out counts as a failed attempt', async () => {
  const t = await setup(() => {}, { pingTimeoutMs: 200 });
  t.addSession();
  await t.run(55 * MIN);
  const s = t.store.get('ses_test');
  assert.deepEqual([s.attempts, s.pingInFlight, s.stopped], [1, false, null]);
  assert.equal(t.journal('ping')[0].status, null);
  await t.close();
});

test('after sleeping past +58 minutes the session stops as late without a request', async () => {
  const t = await setup(hit);
  t.addSession();
  await t.run(59 * MIN);
  assert.equal(t.upstream.requests.length, 0);
  assert.equal(t.store.get('ses_test').stopped, 'late');
  await t.close();
});

test('the 12-hour window allows 13 pings', async () => {
  const t = await setup(hit);
  t.addSession();
  for (let i = 0; i < 14; i += 1) await t.run(55 * MIN);
  assert.equal(t.upstream.requests.length, 13);
  assert.equal(t.store.get('ses_test').stopped, 'window');
  await t.close();
});

test('the daily cap holds pings across sessions and warns once', async () => {
  const t = await setup(hit, { dailyCap: 1 });
  t.addSession('a');
  t.addSession('b');
  await t.run(55 * MIN);
  await t.run(0);
  assert.equal(t.upstream.requests.length, 1);
  assert.deepEqual(t.journal('warn').map((r) => r.reason), ['daily-cap']);
  await t.close();
});

test('no ping while a real request is in flight; a failed request keeps the old schedule', async () => {
  const t = await setup(hit);
  t.addSession();
  t.store.beginReal('ses_test');
  await t.run(55 * MIN);
  assert.equal(t.upstream.requests.length, 0);
  t.store.endReal('ses_test');
  await t.run(0);
  assert.equal(t.upstream.requests.length, 1);
  await t.close();
});
