import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import type { SubagentRuntimeState } from '../../../core/runtime/types';

export type SubagentHookState = SubagentRuntimeState;

export function createStopSubagentHook(
  getState: () => SubagentHookState,
): HookCallbackMatcher {
  return {
    hooks: [
      async () => {
        try {
          // Reading the lazy getter retains the existing stale-state cleanup.
          void getState().hasRunning;
        } catch (error) {
          console.warn('[Claudian] Stop hook state provider failed; failing open', error);
        }
        return {};
      },
    ],
  };
}
