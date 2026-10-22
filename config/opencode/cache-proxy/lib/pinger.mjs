// lib/pinger.mjs
// Replays a session's last request with max_tokens 0 to keep its 1-hour prompt cache alive.
import { decide, classifyPing } from './schedule.mjs';
import { parseUsageFromJson, pingHit, usageFields } from './usage.mjs';
import { requestUpstream, readAll } from './upstream.mjs';
import { short } from './journal.mjs';

export const PING_UA = 'opencode-cache-proxy-ping/1';

const KEY_LIKE = /\b(sk-|Bearer\s+)[^\s"',;]+/gi;

// Credential values of a session's request, to keep them out of the journal.
function credentials(headers) {
  return ['x-api-key', 'authorization'].flatMap((name) => {
    const value = headers?.[name];
    return typeof value === 'string' ? [value, value.replace(/^Bearer\s+/i, '')] : [];
  });
}

// The journal gets an upstream error's type and message, never the raw body: it could echo request
// text or credentials. The session's credentials and key-like tokens are redacted.
export function errorSummary(text, secrets = []) {
  let error;
  try {
    error = JSON.parse(text)?.error;
  } catch {
    // Not JSON: only the size is kept.
  }
  if (!error || typeof error !== 'object') return `unparsed error body, ${Buffer.byteLength(text)} bytes`;
  let summary = [error.type, error.message].filter((v) => typeof v === 'string' && v !== '').join(': ');
  for (const secret of secrets) {
    if (secret) summary = summary.split(secret).join('[redacted]');
  }
  return short(summary.replace(KEY_LIKE, '$1[redacted]')) || 'error without type or message';
}

// Spread keeps key order; only max_tokens and stream change.
export function makePingBody(body, maxTokens) {
  return JSON.stringify({ ...JSON.parse(body), max_tokens: maxTokens, stream: false });
}

export function pingHeaders(headers) {
  const ua = headers['user-agent'];
  return { ...headers, 'user-agent': ua ? `${ua} ${PING_UA}` : PING_UA };
}

export function createPinger({ cfg, store, journal, now = () => Date.now() }) {
  const pending = new Set();
  let capWarned = false;
  let timer = null;

  function stopSession(s, reason) {
    store.stop(s.id, reason);
    journal.write({ kind: 'stop', session: s.id, model: s.model, reason, ping_n: s.pings });
  }

  async function ping(s) {
    const start = now();
    // The journal record describes the ping that was sent, even if a real request replaces the session meanwhile.
    const { model, pings } = s;
    s.pingInFlight = true;
    store.notePingSent(start);
    let status = null;
    let result = null;
    let error = null;
    try {
      // Snapshot: a real request may replace the session's headers while the ping is in flight.
      const headers = pingHeaders(s.headers);
      const res = await requestUpstream(cfg.upstream, {
        method: 'POST',
        path: s.path,
        headers,
        body: makePingBody(s.body, cfg.pingMaxTokens),
        signal: AbortSignal.timeout(cfg.pingTimeoutMs),
      });
      const text = (await readAll(res)).toString('utf8');
      status = res.statusCode;
      if (status === 200) result = parseUsageFromJson(text);
      else error = errorSummary(text, credentials(headers));
    } catch (err) {
      error = short(err);
    } finally {
      s.pingInFlight = false;
    }
    const outcome = classifyPing({ status, hit: pingHit(result ? result.usage : null) });
    const stopReason = store.recordPing(s.id, start, outcome);
    journal.write({
      kind: 'ping', session: s.id, model, status, ms: now() - start, ...usageFields(result), ping_n: outcome === 'ok' ? pings + 1 : pings, reason: outcome, error,
    });
    if (stopReason) stopSession(s, stopReason);
  }

  function tick() {
    const t = now();
    store.sweep(t);
    let capped = false;
    for (const s of store.all()) {
      const d = decide(s, t, store.pingsLast24h(t), cfg);
      if (d.action === 'ping') {
        const p = ping(s).catch(() => {});
        pending.add(p);
        p.finally(() => pending.delete(p));
      } else if (d.action === 'stop') {
        stopSession(s, d.reason);
      } else if (d.capped) {
        capped = true;
      }
    }
    if (store.pingsLast24h(t) < cfg.dailyCap) capWarned = false;
    if (capped && !capWarned) {
      capWarned = true;
      journal.write({ kind: 'warn', reason: 'daily-cap', ping_n: store.pingsLast24h(t) });
    }
  }

  return {
    tick,
    async drain() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    start() {
      if (cfg.tickMs > 0 && !timer) {
        timer = setInterval(() => {
          try {
            tick();
          } catch (err) {
            console.error('cache-proxy tick failed:', short(err));
          }
        }, cfg.tickMs);
        timer.unref();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
