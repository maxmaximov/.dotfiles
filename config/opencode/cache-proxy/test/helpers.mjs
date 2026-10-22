// test/helpers.mjs
// Shared test utilities. Importing this file has no side effects (node --test runs every file in test/).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEY = 'sk-test-secret-key';
export const MIN = 60_000;

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cache-proxy-test-'));
}

// Production timings, no background timer (tickMs: 0), short ping timeout.
export function testConfig(upstream, overrides = {}) {
  return {
    upstream, port: 0, stateDir: tmpDir(),
    pingAfterMs: 55 * MIN, retryEveryMs: MIN, maxAttempts: 3, lateAfterMs: 58 * MIN, windowMs: 12 * 60 * MIN,
    dailyCap: 200, pingMaxTokens: 0, tickMs: 0, pingTimeoutMs: 2000,
    ...overrides,
  };
}

// Polls `check` every 10 ms of real time.
export async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function clock(start = Date.parse('2026-10-22T10:00:00Z')) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

// Fake LiteLLM: records every request; `handler(req, res, record)` writes the response.
export async function startUpstream(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const record = { method: req.method, url: req.url, headers: req.headers, body: '', closedEarly: false };
    requests.push(record);
    res.on('close', () => { if (!res.writableEnded) record.closedEarly = true; });
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      record.body = Buffer.concat(chunks).toString('utf8');
      await handler(req, res, record);
    } catch {
      res.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

// Raw Anthropic usage object.
export function usage({ read = 0, write5m = 0, write1h = 0, output = 0 } = {}) {
  return {
    input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: write5m + write1h,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h }, output_tokens: output,
  };
}

export function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

// A streamed /v1/messages response with the given usage.
export function streamOf(u, id = 'msg_real') {
  return sse([
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-test', content: [], usage: { ...u, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: u.output_tokens } },
    { type: 'message_stop' },
  ]);
}

// A non-streamed response, as a ping gets it.
export function jsonOf(u, id = 'msg_ping') {
  return JSON.stringify({ id, type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: 'max_tokens', usage: u });
}

// Shaped like an opencode request: markers without ttl, thinking, effort, tools.
export function opencodeBody() {
  return {
    model: 'claude-test', max_tokens: 32000, stream: true,
    thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, tool_choice: { type: 'auto' },
    system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'pong?', cache_control: { type: 'ephemeral' } }] }],
  };
}

export function opencodeHeaders(sessionId = 'ses_test') {
  return {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'thinking-binding-controls-2026-08-01,structured-outputs-2025-11-13',
    'x-api-key': KEY,
    'x-session-id': sessionId,
    'x-session-affinity': sessionId,
    'user-agent': 'opencode/1.18.31 test',
  };
}

export function readJournal(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

export function journalText(dir) {
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
}

// Starts proxy.mjs (Task 7). Imported lazily so that this file has no dependency on it at load time.
export async function startProxy(cfg, deps) {
  const { createProxy } = await import('../proxy.mjs');
  const proxy = createProxy(cfg, deps);
  const port = await proxy.listen();
  return { ...proxy, url: `http://127.0.0.1:${port}` };
}
