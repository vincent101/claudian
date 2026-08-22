import {
  createStopSubagentHook,
  type StopHookCircuitBreaker,
  type SubagentHookState,
} from '@/providers/claude/hooks/SubagentHooks';

describe('SubagentHooks', () => {
  describe('createStopSubagentHook', () => {
    const createHookInput = () => ({
      hook_event_name: 'Stop' as const,
      session_id: 'test-session',
      transcript_path: '/tmp/transcript',
      cwd: '/vault',
      stop_hook_active: true,
    });

    const opts = { signal: new AbortController().signal };

    it('allows stop when no running subagents', async () => {
      const state: SubagentHookState = {
        hasRunning: false,
      };

      const hook = createStopSubagentHook(() => state);
      const result = await hook.hooks[0](createHookInput(), undefined, opts);

      expect(result).toEqual({});
    });

    it('blocks stop when subagents are still running', async () => {
      const state: SubagentHookState = {
        hasRunning: true,
      };

      const hook = createStopSubagentHook(() => state);
      const result = await hook.hooks[0](createHookInput(), undefined, opts);

      expect(result).toEqual({
        decision: 'block',
        reason: expect.stringContaining('still running'),
      });
      expect((result as any).reason).toContain('TaskOutput');
    });

    it('resolves state dynamically at execution time', async () => {
      let running = true;
      const getState = (): SubagentHookState => ({
        hasRunning: running,
      });

      const hook = createStopSubagentHook(getState);

      const result1 = await hook.hooks[0](createHookInput(), undefined, opts);
      expect((result1 as any).decision).toBe('block');

      running = false;
      const result2 = await hook.hooks[0](createHookInput(), undefined, opts);
      expect(result2).toEqual({});
    });

    it('fails open when reading subagent state throws (fix 1)', async () => {
      const hook = createStopSubagentHook(() => {
        throw new Error('tab already torn down');
      });

      const result = await hook.hooks[0](createHookInput(), undefined, opts);

      expect(result).toEqual({});
    });

    it('allows stop after the breaker trips on too many consecutive blocks (fix 1)', async () => {
      const state: SubagentHookState = { hasRunning: true };
      let blocks = 0;
      const breaker: StopHookCircuitBreaker = {
        registerBlock: () => {
          blocks += 1;
          return blocks > 3;
        },
        reset: () => {},
      };

      const hook = createStopSubagentHook(() => state, breaker);

      // First three blocks pass through as blocks
      for (let i = 0; i < 3; i++) {
        const result = await hook.hooks[0](createHookInput(), undefined, opts);
        expect((result as any).decision).toBe('block');
      }

      // Fourth attempt: breaker trips -> allow
      const tripped = await hook.hooks[0](createHookInput(), undefined, opts);
      expect(tripped).toEqual({});
      expect(blocks).toBe(4);
    });

    it('resets the breaker when the hook allows (fix 1)', async () => {
      let running = true;
      const resets: number[] = [];
      const breaker: StopHookCircuitBreaker = {
        registerBlock: () => false,
        reset: () => {
          resets.push(1);
        },
      };

      const hook = createStopSubagentHook(() => ({ hasRunning: running }), breaker);

      await hook.hooks[0](createHookInput(), undefined, opts); // block
      running = false;
      await hook.hooks[0](createHookInput(), undefined, opts); // allow -> reset

      expect(resets.length).toBe(1);
    });

    it('resets the breaker when the state provider throws (fix 1 fail-open)', async () => {
      const resets: number[] = [];
      const breaker: StopHookCircuitBreaker = {
        registerBlock: () => false,
        reset: () => {
          resets.push(1);
        },
      };

      const hook = createStopSubagentHook(() => {
        throw new Error('provider gone');
      }, breaker);

      await hook.hooks[0](createHookInput(), undefined, opts);

      expect(resets.length).toBe(1);
    });

    it('has no matcher (applies to all stop events)', () => {
      const hook = createStopSubagentHook(
        () => ({ hasRunning: false })
      );
      expect(hook.matcher).toBeUndefined();
    });
  });
});
