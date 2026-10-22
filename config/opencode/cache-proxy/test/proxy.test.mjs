// test/proxy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../proxy.mjs';
import {
  KEY, MIN, clock, testConfig, startUpstream, startProxy, waitFor, usage, sse, streamOf, jsonOf,
  opencodeBody, opencodeHeaders, readJournal, journalText,
} from './helpers.mjs';

const post = (proxy, body, { path = '/v1/messages', headers = opencodeHeaders(), signal } = {}) =>
  fetch(`${proxy.url}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), signal });

const streamReply = (u) => (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(streamOf(u));
};

test('streams the response byte for byte and sets ttl 1h on every marker', async () => {
  const payload = streamOf(usage({ write1h: 900 }));
  const upstream = await startUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-litellm-call-id': 'call-1' });
    for (const part of payload.match(/[\s\S]{1,7}/g)) {
      res.write(part);
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.end();
  });
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg);
  const res = await post(proxy, opencodeBody());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-litellm-call-id'), 'call-1');
  assert.equal(await res.text(), payload);
  await waitFor(() => readJournal(cfg.stateDir).length === 1);

  const [seen] = upstream.requests;
  const sent = JSON.parse(seen.body);
  const expected = opencodeBody();
  expected.system[0].cache_control.ttl = '1h';
  expected.messages[0].content[0].cache_control.ttl = '1h';
  assert.deepEqual(sent, expected);
  assert.equal(seen.headers['x-api-key'], KEY);
  assert.equal(seen.headers['anthropic-beta'], opencodeHeaders()['anthropic-beta']);
  assert.equal(seen.headers['accept-encoding'], 'identity');

  const [row] = readJournal(cfg.stateDir);
  assert.deepEqual(
    [row.kind, row.session, row.model, row.status, row.ttl_set, row.write_1h, row.write_5m, row.msg_id, row.error],
    ['request', 'ses_test', 'claude-test', 200, 2, 900, 0, 'msg_real', null],
  );
  assert.equal(proxy.store.get('ses_test').pingable, true);
  assert.equal(journalText(cfg.stateDir).includes(KEY), false);
  await proxy.close();
  await upstream.close();
});

test('passes errors through unchanged and does not make the session pingable', async () => {
  const error = '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}';
  const upstream = await startUpstream((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
    res.end(error);
  });
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg);
  const res = await post(proxy, opencodeBody());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '7');
  assert.equal(await res.text(), error);
  await waitFor(() => readJournal(cfg.stateDir).length === 1);
  const s = proxy.store.get('ses_test');
  assert.deepEqual([s.pingable, s.body, s.inFlight], [false, null, 0]);
  await proxy.close();
  await upstream.close();
});

test('a body with an existing ttl is forwarded as is and its session is not pinged', async () => {
  const upstream = await startUpstream(streamReply(usage({ write1h: 900 })));
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg);
  const body = opencodeBody();
  body.system[0].cache_control.ttl = '1h';
  const raw = JSON.stringify(body);
  await (await post(proxy, raw)).text();
  await waitFor(() => readJournal(cfg.stateDir).length === 1);
  assert.equal(upstream.requests[0].body, raw);
  const s = proxy.store.get('ses_test');
  assert.deepEqual([s.pingable, s.body, s.headers], [false, null, null]);
  assert.equal(readJournal(cfg.stateDir)[0].ttl_set, 0);
  await proxy.close();
  await upstream.close();
});

test('other paths, non-JSON bodies and requests without a session are not tracked', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"input_tokens":5}');
  });
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg);
  const raw = JSON.stringify(opencodeBody());
  await (await post(proxy, raw, { path: '/v1/messages/count_tokens' })).text();
  await (await post(proxy, 'not json')).text();
  const noSession = opencodeHeaders();
  delete noSession['x-session-id'];
  await (await post(proxy, opencodeBody(), { headers: noSession })).text();
  await waitFor(() => readJournal(cfg.stateDir).length === 3);

  assert.equal(upstream.requests[0].url, '/v1/messages/count_tokens');
  assert.equal(upstream.requests[0].body, raw);
  assert.equal(upstream.requests[1].body, 'not json');
  assert.equal(JSON.parse(upstream.requests[2].body).system[0].cache_control.ttl, '1h');
  assert.deepEqual(readJournal(cfg.stateDir).map((r) => r.kind), ['other', 'other', 'request']);
  assert.equal(proxy.store.all().length, 0);
  await proxy.close();
  await upstream.close();
});

test('answers 502 in the Anthropic error format when the upstream is down', async () => {
  const upstream = await startUpstream(() => {});
  await upstream.close();
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg);
  const res = await post(proxy, opencodeBody());
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.deepEqual([body.type, body.error.type], ['error', 'api_error']);
  assert.match(body.error.message, /^cache-proxy: /);
  assert.equal(proxy.store.get('ses_test').inFlight, 0);
  await proxy.close();
});

test('a client disconnect aborts the upstream request', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse([{ type: 'message_start', message: { id: 'msg_cut', model: 'claude-test', usage: usage({ write1h: 900 }) } }]));
  });
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg);
  const controller = new AbortController();
  const res = await post(proxy, opencodeBody(), { signal: controller.signal });
  await res.body.getReader().read();
  controller.abort();
  await waitFor(() => upstream.requests[0].closedEarly && readJournal(cfg.stateDir).length === 1);
  const [row] = readJournal(cfg.stateDir);
  assert.deepEqual([row.status, row.write_1h, row.error], [200, 900, 'response interrupted']);
  const s = proxy.store.get('ses_test');
  assert.deepEqual([s.inFlight, s.pingable], [0, true]);
  await proxy.close();
  await upstream.close();
});

test('GET /status lists sessions without bodies or keys', async () => {
  const upstream = await startUpstream(streamReply(usage({ write1h: 900 })));
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg);
  await (await post(proxy, opencodeBody())).text();
  await waitFor(() => readJournal(cfg.stateDir).length === 1);
  const res = await fetch(`${proxy.url}/status`);
  const text = await res.text();
  const status = JSON.parse(text);
  assert.deepEqual([status.version, status.pingsLast24h, status.dailyCap], ['1', 0, 200]);
  assert.deepEqual([status.sessions[0].session, status.sessions[0].pingable], ['ses_test', true]);
  assert.notEqual(status.sessions[0].nextPing, null);
  assert.equal(text.includes(KEY) || text.includes('system prompt'), false);
  await proxy.close();
  await upstream.close();
});

test('a real request through the proxy is pinged 55 minutes later with the same body and headers', async () => {
  const upstream = await startUpstream((req, res, record) => {
    if (JSON.parse(record.body).stream) return streamReply(usage({ write1h: 900 }))(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jsonOf(usage({ read: 900 })));
  });
  const c = clock();
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg, { now: c.now });
  await (await post(proxy, opencodeBody())).text();
  await waitFor(() => readJournal(cfg.stateDir).length === 1);
  c.advance(55 * MIN);
  proxy.pinger.tick();
  await proxy.pinger.drain();

  assert.equal(upstream.requests.length, 2);
  const [real, ping] = upstream.requests;
  assert.deepEqual(JSON.parse(ping.body), { ...JSON.parse(real.body), max_tokens: 0, stream: false });
  for (const name of ['x-api-key', 'anthropic-beta', 'anthropic-version', 'x-session-id', 'x-session-affinity']) {
    assert.equal(ping.headers[name], real.headers[name], name);
  }
  assert.deepEqual(readJournal(cfg.stateDir).map((r) => [r.kind, r.reason ?? null]), [['request', null], ['ping', 'ok']]);
  assert.equal(journalText(cfg.stateDir).includes(KEY), false);
  await proxy.close();
  await upstream.close();
});

test('a known session is busy while its next request is still uploading', async () => {
  const upstream = await startUpstream((req, res, record) => {
    if (JSON.parse(record.body).stream) return streamReply(usage({ write1h: 900 }))(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jsonOf(usage({ read: 900 })));
  });
  const c = clock();
  const cfg = testConfig(upstream.origin);
  const proxy = await startProxy(cfg, { now: c.now });
  let req;
  try {
    await (await post(proxy, opencodeBody())).text();
    await waitFor(() => readJournal(cfg.stateDir).length === 1);

    // The next request of the same session: headers and part of the body arrive, the rest comes later.
    const raw = Buffer.from(JSON.stringify(opencodeBody()));
    req = http.request(`${proxy.url}/v1/messages`, { method: 'POST', headers: { ...opencodeHeaders(), 'content-length': raw.length } });
    const response = new Promise((resolve, reject) => req.on('response', resolve).on('error', reject));
    req.write(raw.subarray(0, 100));
    await waitFor(() => proxy.store.get('ses_test').inFlight === 1);
    c.advance(55 * MIN);
    proxy.pinger.tick();
    await proxy.pinger.drain();
    assert.equal(upstream.requests.length, 1);

    req.end(raw.subarray(100));
    (await response).resume();
    await waitFor(() => readJournal(cfg.stateDir).length === 2);
    assert.equal(proxy.store.get('ses_test').inFlight, 0);
  } finally {
    // An open upload would keep the test process alive if an assertion failed.
    req?.destroy();
    await proxy.close();
    await upstream.close();
  }
});

test('loadConfig: defaults and validation', () => {
  const cfg = loadConfig({ CACHE_PROXY_UPSTREAM: 'https://llm.example/' });
  assert.match(cfg.stateDir, /\.local\/state\/opencode-cache-proxy$/);
  assert.deepEqual({ ...cfg, stateDir: null }, {
    upstream: 'https://llm.example', port: 18765, stateDir: null,
    pingAfterMs: 3_300_000, lateAfterMs: 3_480_000, windowMs: 43_200_000, dailyCap: 200, pingMaxTokens: 0,
    retryEveryMs: 60_000, maxAttempts: 3, tickMs: 30_000, pingTimeoutMs: 50_000,
  });
  assert.equal(loadConfig({ CACHE_PROXY_UPSTREAM: 'https://x.example', CACHE_PROXY_PING_AFTER_SEC: '60' }).pingAfterMs, 60_000);
  assert.throws(() => loadConfig({}), /CACHE_PROXY_UPSTREAM is required/);
  assert.throws(() => loadConfig({ CACHE_PROXY_UPSTREAM: 'llm.example' }), /http/);
  assert.throws(() => loadConfig({ CACHE_PROXY_UPSTREAM: 'https://llm.example/v1' }), /without \/v1/);
  assert.throws(() => loadConfig({ CACHE_PROXY_UPSTREAM: 'http://' }), /not a valid URL/);
  assert.throws(() => loadConfig({ CACHE_PROXY_UPSTREAM: 'https://user:pw@llm.example' }), /credentials, a query or a fragment/);
  assert.throws(() => loadConfig({ CACHE_PROXY_UPSTREAM: 'https://llm.example/v1?x=1' }), /credentials, a query or a fragment/);
  assert.throws(() => loadConfig({ CACHE_PROXY_UPSTREAM: 'https://x.example', CACHE_PROXY_PORT: '70000' }), /between 1 and 65535/);
  assert.throws(() => loadConfig({ CACHE_PROXY_UPSTREAM: 'https://x.example', CACHE_PROXY_PORT: '0' }), /between 1 and 65535/);
  assert.throws(() => loadConfig({ CACHE_PROXY_UPSTREAM: 'https://x.example', CACHE_PROXY_DAILY_CAP: '-1' }), /CACHE_PROXY_DAILY_CAP/);
});
