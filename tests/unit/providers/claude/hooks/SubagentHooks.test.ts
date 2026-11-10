import { tmpdir } from 'os';
import { join } from 'path';

import {
  createStopSubagentHook,
  type SubagentHookState,
} from '@/providers/claude/hooks/SubagentHooks';

describe('SubagentHooks', () => {
  describe('createStopSubagentHook', () => {
    const createHookInput = () => ({
      hook_event_name: 'Stop' as const,
      session_id: 'test-session',
      transcript_path: join(tmpdir(), 'transcript'),
      cwd: tmpdir(),
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

    it('allows stop with a running subagent (Stop minimal fix red case)', async () => {
      const hook = createStopSubagentHook(() => ({ hasRunning: true }));
      const input = { ...createHookInput(), cwd: process.env.TMPDIR!, transcript_path: `${process.env.TMPDIR!}/transcript` };

      expect(await hook.hooks[0](input, undefined, opts)).toEqual({});
    });

    it('reads the provider and live lazy getter exactly once per execution', async () => {
      let running = true;
      const getter = jest.fn(() => running);
      const getState = jest.fn(() => ({ get hasRunning() { return getter(); } }));
      const hook = createStopSubagentHook(getState);

      expect(getState).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
      expect(await hook.hooks[0](createHookInput(), undefined, opts)).toEqual({});
      expect(getState).toHaveBeenCalledTimes(1);
      expect(getter).toHaveBeenCalledTimes(1);
      expect(getter.mock.results[0].value).toBe(true);

      running = false;
      expect(await hook.hooks[0](createHookInput(), undefined, opts)).toEqual({});
      expect(getState).toHaveBeenCalledTimes(2);
      expect(getter).toHaveBeenCalledTimes(2);
      expect(getter.mock.results[1].value).toBe(false);
    });

    it('resolves state dynamically at execution time', async () => {
      let running = true;
      const getState = (): SubagentHookState => ({
        hasRunning: running,
      });

      const hook = createStopSubagentHook(getState);

      const result1 = await hook.hooks[0](createHookInput(), undefined, opts);
      expect(result1).toEqual({});

      running = false;
      const result2 = await hook.hooks[0](createHookInput(), undefined, opts);
      expect(result2).toEqual({});
    });

    it.each(['provider', 'getter'])('reports %s failures to the diagnostic sink and fails open', async (source) => {
      const error = new Error(`${source} failed`);
      const onProviderError = jest.fn();
      const onEvaluate = jest.fn();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const hook = createStopSubagentHook(() => {
        if (source === 'provider') throw error;
        return { get hasRunning(): boolean { throw error; } };
      }, { onProviderError, onEvaluate });
      try {
        expect(await hook.hooks[0](createHookInput(), undefined, opts)).toEqual({});
        expect(onProviderError).toHaveBeenCalledWith(error);
        expect(onEvaluate).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('emits the single-source evaluation (hasRunning + running agent ids) for the Stop diagnostic', async () => {
      const onEvaluate = jest.fn();
      const hook = createStopSubagentHook(
        () => ({
          hasRunning: true,
          runningAgents: [
            { agentId: 'agent-a', startedAt: 1 },
            { agentId: 'agent-b', startedAt: 2 },
          ],
        }),
        { onEvaluate },
      );

      expect(await hook.hooks[0](createHookInput(), undefined, opts)).toEqual({});
      expect(onEvaluate).toHaveBeenCalledWith({
        hasRunning: true,
        runningAgentIds: ['agent-a', 'agent-b'],
      });
    });

    it('reads hasRunning before the running snapshot so stale cleanup is reflected', async () => {
      const onEvaluate = jest.fn();
      let running = [{ agentId: 'stale-agent', startedAt: 0 }];
      const hook = createStopSubagentHook(
        () => ({
          get hasRunning() {
            // Lazy getter owns the stale cleanup; the snapshot must follow it.
            running = [];
            return false;
          },
          get runningAgents() {
            return running;
          },
        }),
        { onEvaluate },
      );

      await hook.hooks[0](createHookInput(), undefined, opts);

      expect(onEvaluate).toHaveBeenCalledWith({ hasRunning: false, runningAgentIds: [] });
    });

    it('never blocks the stop when the diagnostic sink throws', async () => {
      const hook = createStopSubagentHook(
        () => ({ hasRunning: true }),
        { onEvaluate: () => { throw new Error('sink failed'); } },
      );

      expect(await hook.hooks[0](createHookInput(), undefined, opts)).toEqual({});
    });

    it('still allows on repeated calls with stop_hook_active set', async () => {
      const getState = jest.fn(() => ({ hasRunning: true }));
      const hook = createStopSubagentHook(getState);
      const input = { ...createHookInput(), stop_hook_active: true };

      for (let i = 0; i < 4; i++) {
        expect(await hook.hooks[0](input, undefined, opts)).toEqual({});
      }
      expect(getState).toHaveBeenCalledTimes(4);
    });

    it('has no matcher (applies to all stop events)', () => {
      const hook = createStopSubagentHook(
        () => ({ hasRunning: false })
      );
      expect(hook.matcher).toBeUndefined();
    });
  });
});
