// lib/budget.mjs
// Pure helpers for the LiteLLM budget block in the opencode sidebar: no opencode API, no network.
// Times are Unix milliseconds.

// `<base>/user/info`, where base is the provider baseURL without trailing slashes and a final `/v1`.
// Query and fragment are dropped; the origin stays the same.
export function userInfoUrl(baseURL) {
  const base = new URL(baseURL);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`baseURL must be http(s), got ${base.protocol}`);
  }
  const prefix = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return new URL(`${base.origin}${prefix}/user/info`).href;
}

// opencode substitutes `{env:NAME}` when it loads the config; a raw template is resolved here as well.
export function resolveApiKey(apiKey, env) {
  if (typeof apiKey !== 'string') return null;
  const template = /^\{env:([^}]+)\}$/.exec(apiKey.trim());
  const key = template ? env[template[1]] : apiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}
