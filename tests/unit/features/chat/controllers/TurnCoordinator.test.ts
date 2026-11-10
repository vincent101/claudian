import {
  TURN_LEASE_STALL_MS,
  TURN_LEASE_STALL_POLL_MS,
  TurnCoordinator,
} from '@/features/chat/controllers/TurnCoordinator';
import { ChatState } from '@/features/chat/state/ChatState';

function createDeps(options: {
  conversationId?: string | null;
  processQueuedMessage?: () => void;
  hasBlockingWork?: () => boolean;
  recordDiagnostic?: (event: any) => void;
} = {}) {
  const state = new ChatState();
  const getConversationId = jest.fn((): string | null => options.conversationId ?? 'conv-1');
  const processQueuedMessage = jest.fn(options.processQueuedMessage);
  const coordinator = new TurnCoordinator({
    state,
    getConversationId,
    processQueuedMessage,
    hasBlockingWork: options.hasBlockingWork,
    recordDiagnostic: options.recordDiagnostic,
  });
  return { coordinator, state, getConversationId, processQueuedMessage };
}

describe('TurnCoordinator - feature turn lease (S2)', () => {
  describe('exclusivity', () => {
    it('rejects a user turn while another turn holds the lease', () => {
      const { coordinator } = createDeps();
      expect(coordinator.beginUserTurn('user-1', 1)).toBe(true);
      expect(coordinator.isBusy()).toBe(true);
      expect(coordinator.beginUserTurn('user-2', 2)).toBe(false);
      expect(coordinator.beginAutoTurn('auto-1', 0)).toBe(false);
    });

    it('beginAutoTurn atomically flags isStreaming', () => {
      const { coordinator, state } = createDeps();
      expect(state.isStreaming).toBe(false);
      expect(coordinator.beginAutoTurn('auto-1', 0)).toBe(true);
      expect(state.isStreaming).toBe(true);
      // A user send during the auto turn must queue, not race the lease.
      expect(coordinator.beginUserTurn('user-1', 1)).toBe(false);
    });
  });

  describe('finish (v4 §3.1 step 3)', () => {
    it('clears an auto lease and isStreaming, without pumping the queue', () => {
      const { coordinator, state, processQueuedMessage } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      expect(coordinator.finish('auto-1')).toBe(true);
      expect(coordinator.isBusy()).toBe(false);
      expect(state.isStreaming).toBe(false);
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });

    it('ignores a finish for a foreign turnId', () => {
      const { coordinator } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      expect(coordinator.finish('auto-other')).toBe(false);
      expect(coordinator.isBusy()).toBe(true);
    });

    it('clears a user lease without touching isStreaming (sendMessage owns it)', () => {
      const { coordinator, state } = createDeps();
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 3);
      coordinator.finish('user-1');
      expect(coordinator.isBusy()).toBe(false);
      expect(state.isStreaming).toBe(true);
    });
  });

  describe('release (v4 §3.1 step 7)', () => {
    it('pumps the queued message only for the released turn on the same conversation', () => {
      const { coordinator, processQueuedMessage } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      coordinator.finish('auto-1');
      coordinator.release('auto-1');
      expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    });

    it('does not pump while another turn already holds the lease', () => {
      const { coordinator, processQueuedMessage } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      coordinator.finish('auto-1');
      coordinator.beginUserTurn('user-1', 5);
      coordinator.release('auto-1');
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });

    it('does not pump when the conversation switched away under the turn', () => {
      const { coordinator, getConversationId, processQueuedMessage } = createDeps({ conversationId: 'conv-1' });
      coordinator.beginAutoTurn('auto-1', 0);
      coordinator.finish('auto-1');
      getConversationId.mockReturnValue('conv-2');
      coordinator.release('auto-1');
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });

    it('does not pump after the tab lifecycle was invalidated (destroy/switch)', () => {
      const { coordinator, processQueuedMessage } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      coordinator.invalidateLifecycle();
      coordinator.release('auto-1');
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });

    it('ignores a release for a foreign turnId', () => {
      const { coordinator, processQueuedMessage } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      coordinator.finish('auto-1');
      coordinator.release('auto-other');
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });
  });

  describe('generation validation (v4 §2.2)', () => {
    it('isCurrentTurn checks turnId and generation', () => {
      const { coordinator } = createDeps();
      coordinator.beginAutoTurn('auto-1', 4);
      expect(coordinator.isCurrentTurn('auto-1', 4)).toBe(true);
      expect(coordinator.isCurrentTurn('auto-1', 5)).toBe(false);
      expect(coordinator.isCurrentTurn('auto-2', 4)).toBe(false);
      expect(coordinator.isCurrentTurn('auto-1')).toBe(true);
    });

    it('cancelAutoTurn only clears the exact cancelled generation', () => {
      const { coordinator, state } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      // Runtime bumped the generation before firing the cancel event.
      coordinator.cancelAutoTurn('auto-1', 1);
      expect(coordinator.isBusy()).toBe(false);
      expect(state.isStreaming).toBe(false);
    });

    it('cancelAutoTurn with a stale generation writes nothing', () => {
      const { coordinator, state } = createDeps();
      coordinator.beginAutoTurn('auto-1', 2);
      coordinator.cancelAutoTurn('auto-1', 1);
      expect(coordinator.isBusy()).toBe(true);
      expect(state.isStreaming).toBe(true);
    });
  });

  describe('lifecycle invalidation (v3 §4)', () => {
    it('clears the active lease, bumps the generation and drops isStreaming for auto turns', () => {
      const { coordinator, state, processQueuedMessage } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      const cancelled = coordinator.invalidateLifecycle();
      expect(cancelled?.turnId).toBe('auto-1');
      expect(coordinator.isBusy()).toBe(false);
      expect(state.isStreaming).toBe(false);
      // Late runtime callbacks for the cancelled turn are all no-ops.
      coordinator.finish('auto-1');
      coordinator.cancelAutoTurn('auto-1', 1);
      coordinator.release('auto-1');
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });

    it('keeps user-turn isStreaming untouched (ConversationController owns reset)', () => {
      const { coordinator, state } = createDeps();
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 1);
      coordinator.invalidateLifecycle();
      expect(state.isStreaming).toBe(true);
      expect(coordinator.isBusy()).toBe(false);
    });
  });

  describe('legacy adapter projection guard', () => {
    it('projects only while an auto lease is current on the same conversation', () => {
      const { coordinator, getConversationId } = createDeps({ conversationId: 'conv-1' });
      expect(coordinator.canProjectAutoTurn()).toBe(false);
      coordinator.beginAutoTurn('auto-1', 0);
      expect(coordinator.canProjectAutoTurn()).toBe(true);
      getConversationId.mockReturnValue('conv-2');
      expect(coordinator.canProjectAutoTurn()).toBe(false);
    });

    it('never projects a user turn through the auto adapter', () => {
      const { coordinator } = createDeps();
      coordinator.beginUserTurn('user-1', 1);
      expect(coordinator.canProjectAutoTurn()).toBe(false);
    });
  });

  describe('lease-stall watchdog (2026-11-10)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('force-settles a silent user lease, drops isStreaming and pumps the queue once', () => {
      const { coordinator, state, processQueuedMessage } = createDeps();
      state.isStreaming = true;
      expect(coordinator.beginUserTurn('user-1', 1)).toBe(true);

      jest.advanceTimersByTime(TURN_LEASE_STALL_MS + TURN_LEASE_STALL_POLL_MS);

      expect(coordinator.isBusy()).toBe(false);
      expect(state.isStreaming).toBe(false);
      expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    });

    it('force-settles a silent auto lease', () => {
      const { coordinator, state, processQueuedMessage } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);

      jest.advanceTimersByTime(TURN_LEASE_STALL_MS + TURN_LEASE_STALL_POLL_MS);

      expect(coordinator.isBusy()).toBe(false);
      expect(state.isStreaming).toBe(false);
      expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    });

    it('does not fire before the stall threshold', () => {
      const { coordinator, state, processQueuedMessage } = createDeps();
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 1);

      jest.advanceTimersByTime(TURN_LEASE_STALL_MS - TURN_LEASE_STALL_POLL_MS);

      expect(coordinator.isBusy()).toBe(true);
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });

    it('chunk progress (touch) resets the idle clock', () => {
      const { coordinator, state, processQueuedMessage } = createDeps();
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 1);

      jest.advanceTimersByTime(TURN_LEASE_STALL_MS - TURN_LEASE_STALL_POLL_MS);
      coordinator.touch('user-1');
      jest.advanceTimersByTime(TURN_LEASE_STALL_MS - TURN_LEASE_STALL_POLL_MS);

      // 2 × (threshold - poll) wall time, but only threshold - poll idle.
      expect(coordinator.isBusy()).toBe(true);
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });

    it('a foreign touch never extends the current lease', () => {
      const { coordinator, state, processQueuedMessage } = createDeps();
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 1);

      jest.advanceTimersByTime(TURN_LEASE_STALL_MS - TURN_LEASE_STALL_POLL_MS);
      coordinator.touch('user-other');
      jest.advanceTimersByTime(TURN_LEASE_STALL_POLL_MS);

      expect(coordinator.isBusy()).toBe(false);
      expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    });

    it('never kills a lease that has legitimately blocking work (running tool / pending ask)', () => {
      let blocking = true;
      const probe = jest.fn(() => blocking);
      const { coordinator, state, processQueuedMessage } = createDeps({ hasBlockingWork: probe });
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 1);

      jest.advanceTimersByTime(3 * TURN_LEASE_STALL_MS);

      // The probe is scoped to the lease's turn so stale controller state from
      // an older turn cannot mask a wedged one.
      expect(probe).toHaveBeenCalledWith('user-1');

      expect(coordinator.isBusy()).toBe(true);
      expect(state.isStreaming).toBe(true);
      expect(processQueuedMessage).not.toHaveBeenCalled();

      // Work ended: the idle clock restarts from the last suppression, so a
      // full threshold of real silence is still required.
      blocking = false;
      jest.advanceTimersByTime(TURN_LEASE_STALL_MS - TURN_LEASE_STALL_POLL_MS);
      expect(coordinator.isBusy()).toBe(true);
      jest.advanceTimersByTime(TURN_LEASE_STALL_POLL_MS);
      expect(coordinator.isBusy()).toBe(false);
    });

    it('fails safe when the blocking-work probe throws (no force settle)', () => {
      const recordDiagnostic = jest.fn();
      const { coordinator, state } = createDeps({
        hasBlockingWork: () => { throw new Error('probe failed'); },
        recordDiagnostic,
      });
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 1);

      jest.advanceTimersByTime(3 * TURN_LEASE_STALL_MS);

      expect(coordinator.isBusy()).toBe(true);
      expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'lease_stall_force_settle',
        detail: 'skipped_probe_error',
      }));
      // One shot per lease: repeated polls must not stamp the same error.
      expect(recordDiagnostic).toHaveBeenCalledTimes(1);
    });

    it('records the fired settle with the idle elapsed time', () => {
      const recordDiagnostic = jest.fn();
      const { coordinator, state } = createDeps({ recordDiagnostic });
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 7);

      jest.advanceTimersByTime(TURN_LEASE_STALL_MS + TURN_LEASE_STALL_POLL_MS);

      expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'lease_stall_force_settle',
        turnId: 'user-1',
        generation: 7,
        leaseKind: 'user',
        detail: 'settled',
      }));
      expect(recordDiagnostic.mock.calls.at(-1)![0].elapsedMs).toBeGreaterThanOrEqual(TURN_LEASE_STALL_MS);
    });

    it('disarms on a normal finish (no late settle)', () => {
      const recordDiagnostic = jest.fn();
      const { coordinator, state, processQueuedMessage } = createDeps({ recordDiagnostic });
      state.isStreaming = true;
      coordinator.beginUserTurn('user-1', 1);
      coordinator.finish('user-1');

      jest.advanceTimersByTime(2 * TURN_LEASE_STALL_MS);

      expect(recordDiagnostic).not.toHaveBeenCalled();
      expect(processQueuedMessage).not.toHaveBeenCalled();
    });

    it('disarms when the lifecycle is invalidated', () => {
      const { coordinator } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      coordinator.invalidateLifecycle();

      jest.advanceTimersByTime(2 * TURN_LEASE_STALL_MS);
      expect(coordinator.isBusy()).toBe(false);
    });
  });

  describe('turn-lease hotfix', () => {
    it('pumps exactly once when the same turn is released repeatedly (fix 5)', () => {
      const { coordinator, processQueuedMessage } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      coordinator.finish('auto-1');
      coordinator.release('auto-1');
      coordinator.release('auto-1');
      coordinator.release('auto-1');
      expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    });

    it('pumps exactly once for a repeated user-turn release (fix 4 + fix 5)', () => {
      const { coordinator, processQueuedMessage } = createDeps();
      coordinator.beginUserTurn('user-1', 1);
      coordinator.finish('user-1');
      coordinator.release('user-1');
      coordinator.release('user-1');
      expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    });

    it('cancelTurnFromRuntime clears only the matching lease and keeps the settled record (fix 6)', () => {
      const { coordinator, processQueuedMessage } = createDeps();
      coordinator.beginUserTurn('user-1', 1);
      expect(coordinator.cancelTurnFromRuntime('user-1')).toBe(true);
      expect(coordinator.isBusy()).toBe(false);
      // A late release from the same turn still pumps — exactly once.
      coordinator.release('user-1');
      coordinator.release('user-1');
      expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    });

    it('cancelTurnFromRuntime ignores a foreign turnId', () => {
      const { coordinator } = createDeps();
      coordinator.beginUserTurn('user-1', 1);
      expect(coordinator.cancelTurnFromRuntime('user-other')).toBe(false);
      expect(coordinator.isBusy()).toBe(true);
    });

    it('cancelTurnFromRuntime clears an auto lease and drops isStreaming', () => {
      const { coordinator, state } = createDeps();
      coordinator.beginAutoTurn('auto-1', 0);
      expect(coordinator.cancelTurnFromRuntime('auto-1')).toBe(true);
      expect(coordinator.isBusy()).toBe(false);
      expect(state.isStreaming).toBe(false);
    });
  });
});
