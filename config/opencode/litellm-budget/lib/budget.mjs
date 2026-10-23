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

const DURATION = /^([1-9]\d*)(mo|d)$/;

// LiteLLM keeps times in UTC, so a time without a zone is read as UTC rather than local time.
function parseTime(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value}Z` : value);
  return Number.isFinite(ms) ? ms : null;
}

// The four `user_info` fields the block needs; unknown or unsupported ones become null.
export function parseUserInfo(json) {
  const info = json?.user_info;
  if (!info || typeof info !== 'object') throw new Error('response has no user_info');
  if (!Number.isFinite(info.spend)) throw new Error('user_info.spend is not a number');
  return {
    spend: info.spend,
    maxBudget: Number.isFinite(info.max_budget) && info.max_budget > 0 ? info.max_budget : null,
    resetAt: parseTime(info.budget_reset_at),
    duration: typeof info.budget_duration === 'string' && DURATION.test(info.budget_duration) ? info.budget_duration : null,
  };
}
