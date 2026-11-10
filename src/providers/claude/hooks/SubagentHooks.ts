import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import type { SubagentRuntimeState } from '../../../core/runtime/types';

export type SubagentHookState = SubagentRuntimeState;

/**
 * Single-source snapshot taken on every Stop event (2026-11-10 hardening):
 * the hook always allows the stop, but records what the StreamController's
 * SubagentManager believed at that instant. A cross-instance read (the
 * engine-line false negative in the incident) shows up as an idle snapshot
 * while the recovery probe still lists live agents.
 */
export interface SubagentHookEvaluation {
  hasRunning: boolean;
  runningAgentIds: string[];
}

export interface SubagentHookOptions {
  /** Diagnostic sink; failures are isolated (the hook still allows the stop). */
  onEvaluate?: (evaluation: SubagentHookEvaluation) => void;
  /** Provider failures are reported here instead of console noise. */
  onProviderError?: (error: unknown) => void;
}

export function createStopSubagentHook(
  getState: () => SubagentHookState,
  options: SubagentHookOptions = {},
): HookCallbackMatcher {
  return {
    hooks: [
      async () => {
        let evaluation: SubagentHookEvaluation | null = null;
        try {
          const state = getState();
          // Order matters: the lazy getter owns the existing stale cleanup, so
          // the running snapshot must be read after it (otherwise ids the
          // cleanup just orphaned would still be reported running).
          const hasRunning = state.hasRunning;
          evaluation = {
            hasRunning,
            runningAgentIds: (state.runningAgents ?? []).map(agent => agent.agentId),
          };
        } catch (error) {
          try {
            options.onProviderError?.(error);
          } catch {
            // Diagnostic failures never affect the stop decision.
          }
        }
        if (evaluation) {
          try {
            options.onEvaluate?.(evaluation);
          } catch {
            // Diagnostic failures never affect the stop decision.
          }
        }
        return {};
      },
    ],
  };
}
