// test/upstream-journal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestHeaders, responseHeaders, upstreamUrl } from '../lib/upstream.mjs';
import { createJournal, short } from '../lib/journal.mjs';

test('requestHeaders drops hop-by-hop headers and asks for identity encoding', () => {
  const out = requestHeaders({
    host: 'h', connection: 'keep-alive', 'content-length': '10', 'accept-encoding': 'gzip, br', 'transfer-encoding': 'chunked',
    'x-api-key': 'k', 'anthropic-beta': 'b', 'x-session-id': 's', 'user-agent': 'ua',
  });
  assert.deepEqual(out, { 'x-api-key': 'k', 'anthropic-beta': 'b', 'x-session-id': 's', 'user-agent': 'ua', 'accept-encoding': 'identity' });
});

test('responseHeaders keeps content headers and drops hop-by-hop ones', () => {
  assert.deepEqual(
    responseHeaders({ 'content-type': 'text/event-stream', 'retry-after': '3', connection: 'close', 'transfer-encoding': 'chunked', 'content-length': '5' }),
    { 'content-type': 'text/event-stream', 'retry-after': '3', 'content-length': '5' },
  );
});

test('upstreamUrl joins the base and the incoming path, keeping a path prefix and the query', () => {
  assert.equal(upstreamUrl('https://llm.example', '/v1/messages').href, 'https://llm.example/v1/messages');
  assert.equal(upstreamUrl('https://llm.example/', '/v1/messages?beta=true').href, 'https://llm.example/v1/messages?beta=true');
  assert.equal(upstreamUrl('https://llm.example/prefix', '/v1/messages').href, 'https://llm.example/prefix/v1/messages');
});

test('journal appends JSON lines to a monthly file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-proxy-journal-'));
  const journal = createJournal(dir, () => Date.parse('2026-10-22T10:00:00Z'));
  journal.write({ kind: 'request', status: 200 });
  journal.write({ kind: 'ping', status: 200 });
  const lines = fs.readFileSync(path.join(dir, 'requests-2026-10.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { ts: '2026-10-22T10:00:00.000Z', kind: 'request', status: 200 },
    { ts: '2026-10-22T10:00:00.000Z', kind: 'ping', status: 200 },
  ]);
});

test('short truncates errors and values to 300 characters', () => {
  assert.equal(short(new Error('boom')), 'boom');
  assert.equal(short('x'.repeat(301)), `${'x'.repeat(300)}…`);
  assert.equal(short(undefined), '');
});
