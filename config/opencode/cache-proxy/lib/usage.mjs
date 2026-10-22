// lib/usage.mjs
// Usage extraction from Anthropic Messages API responses (SSE stream or JSON body).

export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    write5m: cc ? (cc.ephemeral_5m_input_tokens ?? 0) : null,
    write1h: cc ? (cc.ephemeral_1h_input_tokens ?? 0) : null,
    output: u.output_tokens ?? 0,
  };
}

export function parseUsageFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !data.usage) return null;
  return { id: data.id ?? null, model: data.model ?? null, stopReason: data.stop_reason ?? null, usage: normalizeUsage(data.usage) };
}

export function createSseUsageTap() {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let sawStart = false;
  let id = null;
  let model = null;
  let stopReason = null;
  let raw = null;

  const dispatch = () => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event && event.type === 'message_start' && event.message) {
      sawStart = true;
      id = event.message.id ?? null;
      model = event.message.model ?? null;
      raw = { ...(event.message.usage ?? {}) };
    } else if (event && event.type === 'message_delta') {
      if (event.usage && raw) {
        for (const [key, value] of Object.entries(event.usage)) {
          if (value !== null && value !== undefined) raw[key] = value;
        }
      }
      if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
    }
  };

  const consumeLines = () => {
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') dispatch();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      newline = buffer.indexOf('\n');
    }
  };

  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      consumeLines();
    },
    end() {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        buffer += '\n';
        consumeLines();
      }
      dispatch();
      if (!sawStart) return null;
      return { id, model, stopReason, usage: normalizeUsage(raw) };
    },
  };
}

export function createJsonCollector(limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limitBytes) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    },
    end() {
      return overflow ? null : parseUsageFromJson(Buffer.concat(chunks).toString('utf8'));
    },
  };
}

// The prompt is cached with a 1-hour TTL only: nothing was written with 5 minutes, and something is cached.
export function cachedForAnHour(u) {
  if (!u) return false;
  const no5m = u.write5m === 0 || (u.write5m === null && u.cacheWrite === 0);
  return no5m && u.cacheRead + (u.write1h ?? 0) > 0;
}

// A ping hit: it read the cache and wrote nothing.
export function pingHit(u) {
  return Boolean(u) && u.cacheRead > 0 && u.cacheWrite === 0;
}

export function usageFields(result) {
  const u = result ? result.usage : null;
  return {
    input: u ? u.input : null,
    cache_read: u ? u.cacheRead : null,
    write_5m: u ? u.write5m : null,
    write_1h: u ? u.write1h : null,
    output: u ? u.output : null,
    msg_id: result ? result.id : null,
    stop_reason: result ? result.stopReason : null,
  };
}
