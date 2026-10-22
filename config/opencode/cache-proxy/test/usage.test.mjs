// test/usage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSseUsageTap, createJsonCollector, parseUsageFromJson, normalizeUsage, cachedForAnHour, pingHit, usageFields,
} from '../lib/usage.mjs';

const SSE = [
  'event: message_start\n',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":3,"cache_creation_input_tokens":1000,"cache_read_input_tokens":20,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1000},"output_tokens":1}}}\n\n',
  ': comment line\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"привет"}}\n\n',
  'event: message_delta\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n\n',
].join('');

const EXPECTED = {
  id: 'msg_1', model: 'claude-test', stopReason: 'end_turn',
  usage: { input: 3, cacheRead: 20, cacheWrite: 1000, write5m: 0, write1h: 1000, output: 7 },
};

test('SSE tap extracts usage regardless of how bytes are split', () => {
  const bytes = Buffer.from(SSE, 'utf8');
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const tap = createSseUsageTap();
    tap.push(bytes.subarray(0, cut));
    tap.push(bytes.subarray(cut));
    assert.deepEqual(tap.end(), EXPECTED, `cut at ${cut}`);
  }
});

test('SSE tap handles CRLF and byte-by-byte input', () => {
  const tap = createSseUsageTap();
  for (const byte of Buffer.from(SSE.replaceAll('\n', '\r\n'), 'utf8')) tap.push(Buffer.from([byte]));
  assert.deepEqual(tap.end(), EXPECTED);
});

test('SSE tap returns null without message_start and ignores garbage', () => {
  const tap = createSseUsageTap();
  tap.push('data: not json\n\ndata: {"type":"ping"}\n\n');
  assert.equal(tap.end(), null);
});

test('JSON response and collector', () => {
  const json = JSON.stringify({
    id: 'msg_2', model: 'claude-test', stop_reason: 'max_tokens', content: [],
    usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, output_tokens: 0 },
  });
  const expected = {
    id: 'msg_2', model: 'claude-test', stopReason: 'max_tokens',
    usage: { input: 2, cacheRead: 900, cacheWrite: 0, write5m: null, write1h: null, output: 0 },
  };
  assert.deepEqual(parseUsageFromJson(json), expected);
  const collector = createJsonCollector();
  collector.push(Buffer.from(json.slice(0, 10)));
  collector.push(Buffer.from(json.slice(10)));
  assert.deepEqual(collector.end(), expected);
  assert.equal(parseUsageFromJson('{"type":"error"}'), null);
  assert.equal(parseUsageFromJson('<html>'), null);
  const tiny = createJsonCollector(5);
  tiny.push(Buffer.from(json));
  assert.equal(tiny.end(), null);
});

test('cachedForAnHour: no 5-minute writes and something cached', () => {
  const u = (o) => ({ input: 0, cacheRead: 0, cacheWrite: 0, write5m: 0, write1h: 0, output: 0, ...o });
  assert.equal(cachedForAnHour(u({ cacheWrite: 100, write1h: 100 })), true);
  assert.equal(cachedForAnHour(u({ cacheRead: 100 })), true);
  assert.equal(cachedForAnHour(u({ cacheWrite: 100, write5m: 100 })), false);
  assert.equal(cachedForAnHour(u({})), false);
  assert.equal(cachedForAnHour(u({ cacheRead: 100, write5m: null, write1h: null })), true);
  assert.equal(cachedForAnHour(u({ cacheWrite: 100, write5m: null, write1h: null })), false);
  // cache_creation without the 5-minute field: unknown, so it counts only when nothing was written.
  assert.equal(cachedForAnHour(normalizeUsage({
    cache_read_input_tokens: 20, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100 },
  })), false);
  assert.equal(cachedForAnHour(normalizeUsage({ cache_read_input_tokens: 20, cache_creation_input_tokens: 0, cache_creation: {} })), true);
  assert.equal(cachedForAnHour(null), false);
});

test('pingHit: read something, wrote nothing', () => {
  assert.equal(pingHit(normalizeUsage({ cache_read_input_tokens: 10, cache_creation_input_tokens: 0 })), true);
  assert.equal(pingHit(normalizeUsage({ cache_read_input_tokens: 10, cache_creation_input_tokens: 5 })), false);
  assert.equal(pingHit(normalizeUsage({ cache_read_input_tokens: 0 })), false);
  assert.equal(pingHit(null), false);
});

test('usageFields flattens a result for the journal', () => {
  assert.deepEqual(usageFields(EXPECTED), {
    input: 3, cache_read: 20, write_5m: 0, write_1h: 1000, output: 7, msg_id: 'msg_1', stop_reason: 'end_turn',
  });
  assert.deepEqual(usageFields(null), {
    input: null, cache_read: null, write_5m: null, write_1h: null, output: null, msg_id: null, stop_reason: null,
  });
});
