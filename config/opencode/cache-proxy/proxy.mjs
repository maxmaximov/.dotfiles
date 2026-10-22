// proxy.mjs
// opencode → this proxy → LiteLLM. Sets a 1-hour TTL on Anthropic prompt-cache markers and pings idle sessions.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { applyOneHourTtl } from './lib/ttl.mjs';
import { createSseUsageTap, createJsonCollector, usageFields } from './lib/usage.mjs';
import { SessionStore } from './lib/sessions.mjs';
import { requestHeaders, responseHeaders, requestUpstream, readAll } from './lib/upstream.mjs';
import { createJournal, short } from './lib/journal.mjs';
import { createPinger } from './lib/pinger.mjs';

export const VERSION = '1';
const SEC = 1000;

export function loadConfig(env = process.env) {
  const upstream = env.CACHE_PROXY_UPSTREAM;
  if (!upstream) throw new Error('CACHE_PROXY_UPSTREAM is required');
  if (!/^https?:\/\//.test(upstream)) throw new Error('CACHE_PROXY_UPSTREAM must start with http:// or https://');
  if (/\/v1\/?$/.test(upstream)) throw new Error('CACHE_PROXY_UPSTREAM must be the LiteLLM origin without /v1');
  let url;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error('CACHE_PROXY_UPSTREAM is not a valid URL');
  }
  if (url.username || url.password || /[?#]/.test(upstream)) {
    throw new Error('CACHE_PROXY_UPSTREAM must not contain credentials, a query or a fragment');
  }
  const num = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  const port = num('CACHE_PROXY_PORT', 18765);
  if (port < 1 || port > 65535) throw new Error('CACHE_PROXY_PORT must be between 1 and 65535');
  return {
    upstream: upstream.replace(/\/+$/, ''),
    port,
    stateDir: env.CACHE_PROXY_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'opencode-cache-proxy'),
    pingAfterMs: num('CACHE_PROXY_PING_AFTER_SEC', 3300) * SEC,
    lateAfterMs: num('CACHE_PROXY_LATE_AFTER_SEC', 3480) * SEC,
    windowMs: num('CACHE_PROXY_WINDOW_SEC', 43200) * SEC,
    dailyCap: num('CACHE_PROXY_DAILY_CAP', 200),
    pingMaxTokens: num('CACHE_PROXY_PING_MAX_TOKENS', 0),
    retryEveryMs: 60 * SEC,
    maxAttempts: 3,
    tickMs: 30 * SEC,
    pingTimeoutMs: 50 * SEC,
  };
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function apiError(message) {
  return { type: 'error', error: { type: 'api_error', message: `cache-proxy: ${message}` } };
}

// Decides what to do with an incoming request body. Only JSON POST /v1/messages bodies are touched.
function prepare(req, raw) {
  const header = req.headers['x-session-id'];
  const sessionId = typeof header === 'string' && header !== '' ? header : null;
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const ctx = { sessionId, parsed: null, ttl: null, body: raw, model: null, tracked: false, oneHour: false };
  if (req.method !== 'POST' || pathname !== '/v1/messages' || req.headers['content-encoding']) return ctx;
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return ctx;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ctx;
  const ttl = applyOneHourTtl(parsed);
  return {
    ...ctx,
    parsed,
    ttl,
    body: ttl.changed > 0 ? Buffer.from(JSON.stringify(parsed)) : raw,
    model: typeof parsed.model === 'string' ? parsed.model : null,
    tracked: sessionId !== null,
    oneHour: ttl.reason === 'rewritten' && ttl.allOneHour,
  };
}

function createTap(contentType) {
  return String(contentType || '').includes('text/event-stream') ? createSseUsageTap() : createJsonCollector();
}

export function createProxy(cfg, { now = () => Date.now(), journal = createJournal(cfg.stateDir, now) } = {}) {
  const store = new SessionStore(cfg);
  const pinger = createPinger({ cfg, store, journal, now });
  const startedAt = now();

  const status = () => {
    const t = now();
    return {
      version: VERSION,
      upstream: cfg.upstream,
      uptimeSec: Math.round((t - startedAt) / SEC),
      pingsLast24h: store.pingsLast24h(t),
      dailyCap: cfg.dailyCap,
      sessions: store.snapshot(),
    };
  };

  async function relay(req, res, ctx) {
    const headers = requestHeaders(req.headers);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const start = now();
    const entry = { kind: ctx.parsed ? 'request' : 'other', session: ctx.sessionId, model: ctx.model, ttl_set: ctx.ttl ? ctx.ttl.changed : 0 };
    let upstreamRes;
    try {
      upstreamRes = await requestUpstream(cfg.upstream, {
        method: req.method,
        path: req.url,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? null : ctx.body,
        signal: controller.signal,
      });
    } catch (err) {
      journal.write({ ...entry, status: 502, ms: now() - start, error: short(err) });
      if (!controller.signal.aborted && !res.headersSent) sendJson(res, 502, apiError(short(err)));
      return;
    }

    res.writeHead(upstreamRes.statusCode, responseHeaders(upstreamRes.headers));
    const tap = ctx.parsed && !upstreamRes.headers['content-encoding'] ? createTap(upstreamRes.headers['content-type']) : null;
    if (tap) {
      upstreamRes.on('data', (chunk) => {
        try {
          tap.push(chunk);
        } catch {
          // Usage parsing never affects the response.
        }
      });
    }
    upstreamRes.pipe(res);
    let complete = true;
    try {
      await finished(upstreamRes);
    } catch {
      complete = false;
      res.destroy();
    }
    let result = null;
    try {
      result = tap ? tap.end() : null;
    } catch {
      result = null;
    }

    if (ctx.tracked && upstreamRes.statusCode === 200) {
      store.recordReal(ctx.sessionId, {
        body: ctx.oneHour ? ctx.body.toString('utf8') : null,
        headers: ctx.oneHour ? headers : null,
        model: ctx.model,
        path: req.url,
        start,
        oneHour: ctx.oneHour,
      });
      store.setUsage(ctx.sessionId, start, result ? result.usage : null);
    }
    journal.write({ ...entry, status: upstreamRes.statusCode, ms: now() - start, ...usageFields(result), error: complete ? null : 'response interrupted' });
  }

  async function handle(req, res) {
    if (req.method === 'GET' && req.url === '/status') {
      sendJson(res, 200, status());
      return;
    }
    // A known session is busy from the moment its request arrives, so that no ping starts during the upload.
    // Unknown sessions are created only after the body shows that the request is tracked.
    const header = req.headers['x-session-id'];
    let busy = typeof header === 'string' && store.get(header) ? header : null;
    if (busy) store.beginReal(busy);
    try {
      const ctx = prepare(req, await readAll(req));
      if (ctx.tracked && busy === null) {
        busy = ctx.sessionId;
        store.beginReal(busy);
      }
      await relay(req, res, ctx);
    } finally {
      if (busy) store.endReal(busy);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        journal.write({ kind: 'other', status: 500, error: short(err) });
      } catch {
        // The journal is best effort.
      }
      if (!res.headersSent) sendJson(res, 500, apiError(short(err)));
      else res.destroy();
    });
  });

  return {
    server,
    store,
    pinger,
    status,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, '127.0.0.1', () => {
          server.off('error', reject);
          pinger.start();
          resolve(server.address().port);
        });
      });
    },
    async close() {
      pinger.stop();
      await pinger.drain();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function main() {
  const cfg = loadConfig();
  const proxy = createProxy(cfg);
  const port = await proxy.listen();
  console.log(`${new Date().toISOString()} opencode-cache-proxy ${VERSION} listening on 127.0.0.1:${port}`);
  const shutdown = (signal) => {
    console.log(`${new Date().toISOString()} ${signal}: shutting down`);
    proxy.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Node resolves symlinks for the main module: compare real paths, not argv[1] as typed.
function isMainModule() {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(`opencode-cache-proxy failed to start: ${short(err)}`);
    process.exit(1);
  });
}
