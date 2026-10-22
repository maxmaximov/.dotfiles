// scripts/live-ttl-check.mjs
// Two-hour live check: a ping through the cache proxy keeps a 1-hour prompt cache alive past its TTL.
// Env: OPENCODE_JB_LITELLM_API_KEY, CACHE_PROXY_UPSTREAM (LiteLLM origin without /v1),
//      PROXY_URL (default http://127.0.0.1:18766), MODEL (default anthropic/claude-opus-5-5), CHECK_AFTER_MIN (default 110).
import crypto from 'node:crypto';
import { errorSummary } from '../lib/pinger.mjs';

const key = process.env.OPENCODE_JB_LITELLM_API_KEY;
const upstream = (process.env.CACHE_PROXY_UPSTREAM || '').replace(/\/+$/, '');
const proxyUrl = process.env.PROXY_URL || 'http://127.0.0.1:18766';
const model = process.env.MODEL || 'anthropic/claude-opus-5-5';
const checkAfterMin = Number(process.env.CHECK_AFTER_MIN || 110);
if (!key || !upstream) {
  console.error('set OPENCODE_JB_LITELLM_API_KEY and CACHE_PROXY_UPSTREAM');
  process.exit(2);
}

const nonce = crypto.randomUUID();
const session = `live-ttl-check-${nonce}`;
const prefix = (label) => [
  `${nonce} prefix ${label}`,
  ...Array.from({ length: 600 }, (_, i) => `${label} line ${i}: the quick brown fox jumps over the lazy dog.`),
].join('\n');

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function send(base, label, ttl, headers) {
  const body = {
    model,
    max_tokens: 1,
    stream: false,
    system: [{ type: 'text', text: prefix(label), cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Reply with one word: ok' }],
  };
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Like the proxy journal: the error's type and message with the key redacted, never the raw body.
  if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status} ${errorSummary(text, [key])}`);
  const u = JSON.parse(text).usage;
  const row = {
    label,
    read: u.cache_read_input_tokens ?? 0,
    write: u.cache_creation_input_tokens ?? 0,
    write5m: u.cache_creation?.ephemeral_5m_input_tokens ?? null,
    write1h: u.cache_creation?.ephemeral_1h_input_tokens ?? null,
  };
  log(JSON.stringify(row));
  return row;
}

const viaProxy = () => send(proxyUrl, 'A', null, { 'x-session-id': session, 'x-session-affinity': session });
const direct = () => send(upstream, 'B', '1h', { 'x-session-affinity': `${session}-b` });

const a0 = await viaProxy();
const b0 = await direct();
if (a0.write === 0 || b0.write === 0 || a0.write5m || b0.write5m) {
  log('FAIL: both prefixes must be written to the 1-hour cache first');
  process.exit(1);
}
log(`waiting ${checkAfterMin} minutes; keep the Mac awake, on power, lid open`);
await new Promise((resolve) => setTimeout(resolve, checkAfterMin * 60_000));

const status = await (await fetch(`${proxyUrl}/status`)).json();
const tracked = status.sessions.find((s) => s.session === session) ?? null;
log('proxy session', JSON.stringify(tracked));
const a1 = await viaProxy();
const b1 = await direct();

const checks = {
  pinged: Boolean(tracked && tracked.pings >= 1 && !tracked.stopped),
  aRead: a1.read > 0 && a1.write === 0,
  bMissed: b1.read === 0 && b1.write > 0,
};
log(JSON.stringify(checks));
const ok = Object.values(checks).every(Boolean);
log(ok ? 'PASS: the ping kept A cached; B expired' : 'FAIL');
process.exit(ok ? 0 : 1);
