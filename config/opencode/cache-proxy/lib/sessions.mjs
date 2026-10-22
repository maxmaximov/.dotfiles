// lib/sessions.mjs
// In-memory session state for pings. Bodies and API keys live only here and are dropped on stop.
import { cachedForAnHour } from './usage.mjs';
import { nextPingAt } from './schedule.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;

export class SessionStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
    this.pingTimes = [];
  }

  get(id) {
    return this.sessions.get(id);
  }

  all() {
    return [...this.sessions.values()];
  }

  ensure(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id, model: null, path: null, body: null, headers: null, oneHour: false, pingable: false,
        lastReal: 0, lastTouch: 0, inFlight: 0, pingInFlight: false, attempts: 0, pings: 0, stopped: null,
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  beginReal(id) {
    this.ensure(id).inFlight += 1;
  }

  endReal(id) {
    const s = this.sessions.get(id);
    if (s && s.inFlight > 0) s.inFlight -= 1;
  }

  // A real request got HTTP 200: it becomes the session's last request.
  recordReal(id, { body, headers, model, path, start, oneHour }) {
    const s = this.ensure(id);
    // Overlapping requests: a response to a request that started before the latest recorded one is stale.
    if (start < s.lastReal) return;
    Object.assign(s, {
      body, headers, model, path, oneHour, pingable: false, lastReal: start, lastTouch: start, attempts: 0, pings: 0, stopped: null,
    });
  }

  // Usage of that request arrived: the session is pingable only if the prompt is cached for an hour.
  setUsage(id, start, usage) {
    const s = this.sessions.get(id);
    if (!s || s.lastReal !== start || s.stopped) return;
    s.pingable = s.oneHour && cachedForAnHour(usage);
  }

  // Returns a stop reason ('miss' | 'rejected') or null.
  recordPing(id, start, outcome) {
    const s = this.sessions.get(id);
    if (!s || s.stopped || s.lastReal > start) return null;
    if (outcome === 'ok') {
      s.lastTouch = start;
      s.attempts = 0;
      s.pings += 1;
      return null;
    }
    if (outcome === 'retry') {
      s.attempts += 1;
      return null;
    }
    return outcome;
  }

  stop(id, reason) {
    const s = this.sessions.get(id);
    if (s) Object.assign(s, { stopped: reason, body: null, headers: null, pingable: false });
  }

  notePingSent(now) {
    this.pingTimes.push(now);
  }

  pingsLast24h(now) {
    while (this.pingTimes.length > 0 && this.pingTimes[0] <= now - DAY_MS) this.pingTimes.shift();
    return this.pingTimes.length;
  }

  // Sessions idle for more than a day are long past their 12-hour window.
  sweep(now) {
    for (const [id, s] of this.sessions) {
      if (s.inFlight === 0 && !s.pingInFlight && now - s.lastReal > DAY_MS) this.sessions.delete(id);
    }
  }

  snapshot() {
    return this.all().map((s) => ({
      session: s.id,
      model: s.model,
      lastReal: s.lastReal ? new Date(s.lastReal).toISOString() : null,
      lastTouch: s.lastTouch ? new Date(s.lastTouch).toISOString() : null,
      nextPing: s.pingable && !s.stopped ? new Date(nextPingAt(s, this.cfg)).toISOString() : null,
      pings: s.pings,
      attempts: s.attempts,
      inFlight: s.inFlight,
      pingable: s.pingable,
      stopped: s.stopped,
    }));
  }
}
