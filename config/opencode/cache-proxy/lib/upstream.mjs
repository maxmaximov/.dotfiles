// lib/upstream.mjs
// Raw HTTP forwarding (node:http/https, no automatic decompression), header filtering, body reading.
import http from 'node:http';
import https from 'node:https';

const REQUEST_DROP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length', 'accept-encoding',
]);
const RESPONSE_DROP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

// Headers named in `Connection` are hop-by-hop too (RFC 9110, section 7.6.1).
function connectionNamed(headers) {
  const named = new Set();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'connection' || value === undefined) continue;
    for (const token of String(value).split(',')) {
      if (token.trim()) named.add(token.trim().toLowerCase());
    }
  }
  return named;
}

export function requestHeaders(incoming) {
  const named = connectionNamed(incoming);
  const out = {};
  for (const [key, value] of Object.entries(incoming)) {
    const name = key.toLowerCase();
    if (!REQUEST_DROP.has(name) && !named.has(name) && value !== undefined) out[name] = value;
  }
  out['accept-encoding'] = 'identity';
  return out;
}

export function responseHeaders(incoming) {
  const named = connectionNamed(incoming);
  const out = {};
  for (const [key, value] of Object.entries(incoming)) {
    const name = key.toLowerCase();
    if (!RESPONSE_DROP.has(name) && !named.has(name) && value !== undefined) out[key] = value;
  }
  return out;
}

// `base` is the LiteLLM origin, optionally with a path prefix; `path` is the incoming path with query.
export function upstreamUrl(base, path) {
  return new URL(base.replace(/\/+$/, '') + path);
}

// Resolves with the upstream IncomingMessage as soon as response headers arrive.
// `signal` aborts the request and the response body.
export function requestUpstream(base, { method, path, headers, body, signal }) {
  const url = upstreamUrl(base, path);
  const transport = url.protocol === 'https:' ? https : http;
  const finalHeaders = { ...headers };
  if (body !== undefined && body !== null) finalHeaders['content-length'] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method, headers: finalHeaders, signal }, resolve);
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

// Async iteration rejects on a premature close, so a cut connection never hangs.
export async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
