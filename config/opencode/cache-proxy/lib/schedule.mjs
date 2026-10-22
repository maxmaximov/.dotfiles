// lib/schedule.mjs
// Pure ping scheduling rules. Times are epoch milliseconds.

const WAIT = Object.freeze({ action: 'wait' });

export function nextPingAt(s, cfg) {
  return s.lastTouch + cfg.pingAfterMs + s.attempts * cfg.retryEveryMs;
}

export function decide(s, now, pingsLast24h, cfg) {
  if (s.stopped || !s.pingable || !s.body) return { ...WAIT };
  if (s.inFlight > 0 || s.pingInFlight) return { ...WAIT };
  if (s.attempts >= cfg.maxAttempts) return { action: 'stop', reason: 'failed' };
  if (now < nextPingAt(s, cfg)) return { ...WAIT };
  if (now > s.lastReal + cfg.windowMs) return { action: 'stop', reason: 'window' };
  if (now > s.lastTouch + cfg.lateAfterMs) return { action: 'stop', reason: 'late' };
  if (pingsLast24h >= cfg.dailyCap) return { action: 'wait', capped: true };
  return { action: 'ping' };
}

// status: HTTP status, or null for a network error / timeout. hit: the ping read the cache and wrote nothing.
export function classifyPing({ status, hit }) {
  if (status === null || status === undefined) return 'retry';
  if (status === 429 || status >= 500) return 'retry';
  if (status === 200) return hit ? 'ok' : 'miss';
  return 'rejected';
}
