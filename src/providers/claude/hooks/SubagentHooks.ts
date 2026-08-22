import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import type { SubagentRuntimeState } from '../../../core/runtime/types';

export type SubagentHookState = SubagentRuntimeState;

const STOP_BLOCK_REASON = 'Background subagents are still running. Use `TaskOutput task_id="..." block=true` to wait for their results before ending your turn.';

/**
 * Circuit breaker state for the Stop hook (fix 1: 熔断).
 * The hook itself is a stateless closure — the owning runtime holds the counter
 * and exposes it through this interface.
 */
export interface StopHookCircuitBreaker {
  /**
   * Registers a block decision. Returns true when the breaker has tripped
   * (consecutive blocks exceeded the limit) — the caller must allow instead.
   */
  registerBlock(): boolean;
  /** Resets the consecutive-block counter (on allow, or on a new user turn). */
  reset(): void;
}

export function createStopSubagentHook(
  getState: () => SubagentHookState,
  breaker?: StopHookCircuitBreaker
): HookCallbackMatcher {
  return {
    hooks: [
      async () => {
        let hasRunning: boolean;
        try {
          hasRunning = getState().hasRunning;
        } catch (error) {
          // Fix 1 (fail-open): provider failed — allow the stop instead of
          // blocking forever on unreadable state.
          console.warn('[Claudian] Stop hook state provider failed; failing open', error);
          breaker?.reset();
          return {};
        }

        if (hasRunning) {
          // Fix 1 (熔断): too many consecutive blocks — allow and let the
          // breaker notify the user, otherwise a stale bookkeeping entry
          // deadlocks the session in a self-sustaining block loop.
          if (breaker?.registerBlock()) {
            return {};
          }
          return { decision: 'block' as const, reason: STOP_BLOCK_REASON };
        }

        breaker?.reset();
        return {};
      },
    ],
  };
}
