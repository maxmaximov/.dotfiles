// lib/ttl.mjs
// Rewrites Anthropic prompt-cache markers to a 1-hour TTL. Mutates `body` in place.
// Report: { markers, changed, allOneHour, reason }, reason ∈ rewritten | already-has-ttl | no-markers | not-an-object.

function collectMarkers(body) {
  const markers = [];
  const take = (holder) => {
    if (holder && typeof holder === 'object' && holder.cache_control && typeof holder.cache_control === 'object') {
      markers.push(holder.cache_control);
    }
  };
  const takeBlocks = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      take(block);
      if (block && block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) take(inner);
      }
    }
  };
  take(body);
  takeBlocks(body.system);
  takeBlocks(body.tools);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) takeBlocks(message && message.content);
  }
  return markers;
}

export function applyOneHourTtl(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { markers: 0, changed: 0, allOneHour: false, reason: 'not-an-object' };
  }
  const markers = collectMarkers(body);
  if (markers.length === 0) {
    return { markers: 0, changed: 0, allOneHour: false, reason: 'no-markers' };
  }
  if (markers.some((m) => m.ttl !== undefined)) {
    return {
      markers: markers.length,
      changed: 0,
      allOneHour: markers.every((m) => m.ttl === '1h'),
      reason: 'already-has-ttl',
    };
  }
  let changed = 0;
  for (const marker of markers) {
    if (marker.type === 'ephemeral') {
      marker.ttl = '1h';
      changed += 1;
    }
  }
  return { markers: markers.length, changed, allOneHour: changed === markers.length, reason: 'rewritten' };
}
