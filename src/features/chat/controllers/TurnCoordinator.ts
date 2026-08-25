import type { ChatState } from '../state/ChatState';

/**
 * Feature-layer turn being arbitrated. `generation` is the feature
 * streamGeneration for user turns and the runtime turn generation for auto
 * turns; `conversationId`/`lifecycleGeneration` pin the lease to the
 * conversation and tab lifecycle it started under (v4 §2.2).
 */
export interface ActiveFeatureTurn {
  turnId: string;
  kind: 'user' | 'auto';
  generation: number;
  conversationId: string | null;
  lifecycleGeneration: number;
}

/** Record of the most recently settled lease, used to validate release signals. */
interface SettledTurnRecord {
  turnId: string;
  conversationId: string | null;
  lifecycleGeneration: number;
}

export interface TurnCoordinatorDeps {
  state: ChatState;
  getConversationId: () => string | null;
  /** v4 §3.1 step 7: called only when the released turn is still current. */
  processQueuedMessage: () => void;
}

/**
 * Single feature-layer exclusive turn lease (v3 §3 / v4 §3). Both user sends
 * (InputController.sendMessage) and runtime auto turns (onAutoTurnStarted)
 * must hold this lease from start until projection finishes; while it is
 * held, user input may only enter the existing queuedMessage UI queue — no
 * user/assistant message, no handler registration, no currentContentEl
 * writes.
 */
export class TurnCoordinator {
  private deps: TurnCoordinatorDeps;
  private active: ActiveFeatureTurn | null = null;
  private settled: SettledTurnRecord | null = null;
  private lifecycleGeneration = 0;

  constructor(deps: TurnCoordinatorDeps) {
    this.deps = deps;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  getActiveTurn(): ActiveFeatureTurn | null {
    return this.active;
  }

  /**
   * User turn: must be taken before the user/assistant DOM pair is created.
   * Returns false when another turn holds the lease — the caller already
   * queued the message in that case (sendMessage checks isBusy() first).
   */
  beginUserTurn(turnId: string, streamGeneration: number): boolean {
    if (this.active) {
      return false;
    }
    this.active = {
      turnId,
      kind: 'user',
      generation: streamGeneration,
      conversationId: this.deps.getConversationId(),
      lifecycleGeneration: this.lifecycleGeneration,
    };
    return true;
  }

  /**
   * Auto turn (v3 §3): synchronous on lease begin, atomically flags
   * isStreaming so user sends queue instead of racing the projection.
   */
  beginAutoTurn(turnId: string, runtimeGeneration: number): boolean {
    if (this.active) {
      return false;
    }
    this.active = {
      turnId,
      kind: 'auto',
      generation: runtimeGeneration,
      conversationId: this.deps.getConversationId(),
      lifecycleGeneration: this.lifecycleGeneration,
    };
    this.deps.state.isStreaming = true;
    return true;
  }

  /** v4 §2.2 callback validation: turnId + generation (+ lease presence). */
  isCurrentTurn(turnId: string, generation?: number): boolean {
    if (!this.active || this.active.turnId !== turnId) {
      return false;
    }
    if (generation !== undefined && this.active.generation !== generation) {
      return false;
    }
    return true;
  }

  /**
   * v4 §3.1 step 3 (finishFeatureTurn): clears the lease and, for auto turns,
   * drops isStreaming. Never calls processQueuedMessage — release does that.
   */
  finish(turnId: string): boolean {
    if (!this.active || this.active.turnId !== turnId) {
      return false;
    }
    const turn = this.active;
    this.active = null;
    this.settled = {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      lifecycleGeneration: turn.lifecycleGeneration,
    };
    if (turn.kind === 'auto' && this.deps.state.isStreaming) {
      this.deps.state.isStreaming = false;
    }
    return true;
  }

  /**
   * v4 §3.1 step 7 (onTurnReleased): the released turn must be the last
   * settled one, under the same conversation and lifecycle generation —
   * otherwise a switched conversation or a torn-down tab must not see the
   * stale queued message fire.
   */
  release(turnId: string): void {
    if (this.active) {
      // A new turn already owns the lease; it will release the queue itself.
      return;
    }
    const record = this.settled;
    if (!record || record.turnId !== turnId) {
      return;
    }
    if (record.lifecycleGeneration !== this.lifecycleGeneration) {
      return;
    }
    if (record.conversationId !== this.deps.getConversationId()) {
      return;
    }
    // Consume the settled record before pumping: a second release for the
    // same turn (runtime callback + generator finally, or a replayed
    // callback) must not pump the queue twice.
    this.settled = null;
    this.deps.processQueuedMessage();
  }

  /**
   * Runtime-side compensation (unregistered dequeue): the runtime no longer
   * knows this turn, so its feature lease can never be released through the
   * normal generator finally. Clear only this turn's lease — the settled
   * record stays so a late release from the same turn still pumps the queue
   * exactly once.
   */
  cancelTurnFromRuntime(turnId: string): boolean {
    if (!this.active || this.active.turnId !== turnId) {
      return false;
    }
    return this.finish(turnId);
  }

  /**
   * v3 §4.2: cancel an auto turn — clears only the lease this turn created,
   * never writes new state. The runtime bumps the turn generation before
   * firing the cancel event, so the cancelled generation is the lease's
   * generation + 1; any other generation is a stale event.
   */
  cancelAutoTurn(turnId: string, generation: number): void {
    if (!this.active || this.active.turnId !== turnId) {
      return;
    }
    if (this.active.generation + 1 !== generation) {
      return;
    }
    this.finish(turnId);
  }

  /**
   * Legacy-adapter projection guard (S2): the buffered auto chunks may only
   * be rendered while the auto lease is current and the conversation has not
   * switched away under it.
   */
  canProjectAutoTurn(): boolean {
    const turn = this.active;
    if (!turn || turn.kind !== 'auto') {
      return false;
    }
    return turn.conversationId === this.deps.getConversationId();
  }

  /**
   * Lifecycle cancellation (createNew(force)/switchTo/destroyTab): bumps the
   * lifecycle generation so every in-flight callback for the old lease fails
   * isCurrentTurn/release, and clears the lease without writing new state.
   */
  invalidateLifecycle(): ActiveFeatureTurn | null {
    this.lifecycleGeneration += 1;
    const cancelled = this.active;
    if (cancelled) {
      this.active = null;
      this.settled = {
        turnId: cancelled.turnId,
        conversationId: cancelled.conversationId,
        lifecycleGeneration: cancelled.lifecycleGeneration,
      };
      if (cancelled.kind === 'auto' && this.deps.state.isStreaming) {
        this.deps.state.isStreaming = false;
      }
    }
    return cancelled;
  }
}
