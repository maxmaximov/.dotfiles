// test/ttl.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOneHourTtl } from '../lib/ttl.mjs';

const body = () => ({
  model: 'm',
  system: [
    { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'b' },
  ],
  tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: 'plain string content' },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'r', cache_control: { type: 'ephemeral' } }] },
        { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
      ],
    },
  ],
});

test('sets ttl 1h on every marker in system, tools, messages and nested tool_result', () => {
  const b = body();
  const report = applyOneHourTtl(b);
  assert.deepEqual(report, { markers: 4, changed: 4, allOneHour: true, reason: 'rewritten' });
  assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(b.system[1].cache_control, undefined);
  assert.deepEqual(b.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(b.messages[1].content[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(b.messages[1].content[1].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('handles a top-level cache_control (automatic caching)', () => {
  const b = { model: 'm', cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: 'hi' }] };
  assert.deepEqual(applyOneHourTtl(b), { markers: 1, changed: 1, allOneHour: true, reason: 'rewritten' });
  assert.deepEqual(b.cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('leaves the body untouched when any marker already has a ttl', () => {
  const b = body();
  b.messages[1].content[1].cache_control.ttl = '5m';
  const before = JSON.stringify(b);
  assert.deepEqual(applyOneHourTtl(b), { markers: 4, changed: 0, allOneHour: false, reason: 'already-has-ttl' });
  assert.equal(JSON.stringify(b), before);
});

test('reports allOneHour when every marker already has ttl 1h', () => {
  const b = { model: 'm', system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [] };
  assert.deepEqual(applyOneHourTtl(b), { markers: 1, changed: 0, allOneHour: true, reason: 'already-has-ttl' });
});

test('no markers, string system, or not an object', () => {
  assert.deepEqual(applyOneHourTtl({ model: 'm', system: 'text', messages: [{ role: 'user', content: 'x' }] }),
    { markers: 0, changed: 0, allOneHour: false, reason: 'no-markers' });
  assert.deepEqual(applyOneHourTtl(null), { markers: 0, changed: 0, allOneHour: false, reason: 'not-an-object' });
  assert.deepEqual(applyOneHourTtl([1]), { markers: 0, changed: 0, allOneHour: false, reason: 'not-an-object' });
});
