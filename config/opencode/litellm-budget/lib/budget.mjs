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

const DAY_MS = 86_400_000;

// The period ends at the reset and lasts `Nmo` calendar months or `Nd` days. Without both, LiteLLM never resets
// `spend`, so there is no period.
export function budgetPeriod({ resetAt, duration }) {
  const m = DURATION.exec(duration ?? '');
  if (typeof resetAt !== 'number' || !m) return null;
  const start = new Date(resetAt);
  if (m[2] === 'mo') start.setUTCMonth(start.getUTCMonth() - Number(m[1]));
  else start.setUTCDate(start.getUTCDate() - Number(m[1]));
  return { start: start.getTime(), end: resetAt };
}

// Percent of the limit and a forecast at the average pace of the period. Multiplying before dividing keeps round
// inputs exact: 0.29 * 100 is 28.999999999999996.
export function computeForecast({ spend, maxBudget, period, now }) {
  const limited = maxBudget !== null;
  const exhausted = limited && spend >= maxBudget;
  const result = { percent: limited ? Math.floor((spend * 100) / maxBudget) : null, exhausted, forecast: null, runsOut: null };
  if (!period || now < period.start + DAY_MS || now >= period.end) return result;
  const elapsed = now - period.start;
  result.forecast = (spend * (period.end - period.start)) / elapsed;
  if (limited && !exhausted && result.forecast > maxBudget) result.runsOut = period.start + (maxBudget * elapsed) / spend;
  return result;
}
