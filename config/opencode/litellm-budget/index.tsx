// index.tsx
// LiteLLM budget block in the opencode session sidebar. This file is the glue: provider settings, the request, kv,
// the event, the timer, the log and the rendering. The logic is in lib/budget.mjs.
import type { TuiPlugin, TuiPluginApi } from '@opencode-ai/plugin/tui';
import { createSignal, For } from 'solid-js';
import { budgetLines, parseUserInfo, resolveApiKey, userInfoUrl } from './lib/budget.mjs';

const KV_KEY = 'litellm-budget.last';
const MIN_GAP_MS = 5 * 60_000;
const TIMER_MS = 15 * 60_000;
const TIMEOUT_MS = 10_000;
const COLOR = { title: 'text', muted: 'textMuted', warning: 'warning', error: 'error' } as const;

async function fetchUserInfo(api: TuiPluginApi, providerID: string) {
  const { data: config } = await api.client.config.get();
  if (!config) throw new Error('cannot read the opencode config');
  const options = config.provider?.[providerID]?.options;
  if (!options?.baseURL) throw new Error(`provider ${providerID} has no baseURL`);
  const key = resolveApiKey(options.apiKey, process.env);
  if (!key) throw new Error(`provider ${providerID} has no API key`);
  const res = await fetch(userInfoUrl(options.baseURL), {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.any([api.lifecycle.signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return parseUserInfo(await res.json());
}

const tui: TuiPlugin = async (api, options) => {
  const providerID = typeof options?.provider === 'string' ? options.provider : 'jb_litellm_anthropic';
  const [error, setError] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let busy = false;
  let lastAttempt = -Infinity;

  // At most one request at a time and one attempt per MIN_GAP_MS, whatever triggers it.
  async function refresh() {
    if (busy || Date.now() - lastAttempt < MIN_GAP_MS || api.lifecycle.signal.aborted) return;
    busy = true;
    lastAttempt = Date.now();
    try {
      const info = await fetchUserInfo(api, providerID);
      api.kv.set(KV_KEY, { info, fetchedAt: Date.now() });
      setError(false);
    } catch (err) {
      if (api.lifecycle.signal.aborted) return;
      setError(true);
      const message = `litellm-budget: refresh failed: ${err instanceof Error ? err.message : String(err)}`;
      api.client.app.log({ service: 'litellm-budget', level: 'warn', message }).catch(() => {});
    } finally {
      busy = false;
      setNow(Date.now());
    }
  }

  const timer = setInterval(refresh, TIMER_MS);
  api.lifecycle.onDispose(() => clearInterval(timer));
  api.event.on('session.idle', () => void refresh());
  void refresh();

  api.slots.register({
    order: 150, // after Context (100), before MCP (200)
    slots: {
      sidebar_content() {
        const theme = () => api.theme.current;
        // kv.get reads a Solid store, so the block follows kv loading and every kv.set.
        const lines = () => budgetLines({ last: api.kv.get(KV_KEY, null), error: error(), now: now(), timeZone: undefined });
        return (
          <box>
            <For each={lines()}>
              {(line) =>
                line.tone === 'title' ? (
                  <text fg={theme().text}>
                    <b>{line.text}</b>
                  </text>
                ) : (
                  <text fg={theme()[COLOR[line.tone]]}>{line.text}</text>
                )
              }
            </For>
          </box>
        );
      },
    },
  });
};

export default { id: 'litellm-budget', tui };
