// index.tsx
// Temporary block from Task 1 of the plan: proves that opencode loads the plugin and draws it in sidebar_content.
// Task 6 replaces this file.
import type { TuiPlugin } from '@opencode-ai/plugin/tui';

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150, // after Context (100), before MCP (200)
    slots: {
      sidebar_content() {
        const theme = () => api.theme.current;
        return (
          <box>
            <text fg={theme().text}>
              <b>LiteLLM budget</b>
            </text>
            <text fg={theme().textMuted}>no data yet</text>
          </box>
        );
      },
    },
  });
};

export default { id: 'litellm-budget', tui };
