import type { AutoTurnDiagnosticEvent } from '../../../core/runtime/types';
import type { ChatState } from '../state/ChatState';

/**
 * Lease-stall watchdog (2026-11-10 design, 建议 4). The cancel watchdog only
 * covers user cancels; a turn that never settles while nobody cancels (CLI
 * wedged, lost result) holds the exclusive lease forever and the user's queued
 * message never flows. This window is silence-based on purpose: chunks are the
 * CLI's progress evidence, while legitimately chunk-free work (a running tool
 * call, a pending permission/ask prompt) is excluded by `hasBlockingWork`.
 *
 * 10 minutes: far above any observed inter-chunk gap once a tool call is
 * accounted for (streaming turns deliver partial-message deltas continuously,
 * and a running tool / pending prompt is excluded by `hasBlockingWork`), yet
 * strictly below both runtime-side reconciliation bounds so the feature lease
 * degrades first: the subagent running TTL is 20 min
 * (`DEFAULT_SUBAGENT_STALE_MS`) and the async-subagent poll chain caps at
 * ~30 min (900 × 2 s). Waiting for either would leave the user's queue stuck
 * behind a ghost turn for twice as long.
 */
export const TURN_LEASE_STALL_MS = 10 * 60_000;
/** Poll cadence: bounds how late a stall is noticed; cheap enough per tab. */
export const TURN_LEASE_STALL_POLL_MS = 30_000;
/**
 * Absolute ceiling for evidence-backed silence (a tool call keeps reporting
 * `running`). The `hasBlockingWork` probe is trusted only up to this bound:
 * an interrupted tool whose result never lands is exactly the incident shape,
 * and without a ceiling it would suppress the watchdog forever while leaving
 * no trace. 30 min matches the async-subagent poll-chain cap (900 × 2 s) and
 * stays above any single tool call observed in practice; past it the tool
 * record itself is untrustworthy.
 */
export const TURN_LEASE_STALL_BLOCKED_MAX_MS = 30 * 60_000;

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
  /**
   * Stall-watchdog false-kill guard: true while work that legitimately emits
   * no chunks explains the silence (a tool call in flight, a pending
   * permission/ask prompt). Receives the lease's turnId so a probe can scope
   * itself to the current turn. Absent = silence is always suspicious.
   */
  hasBlockingWork?: (turnId: string) => boolean;
  recordDiagnostic?: (event: AutoTurnDiagnosticEvent) => void;
  /**
   * Side effects the wedged turn can no longer run itself, invoked
   * synchronously before the lease is dropped: cancel the runtime turn so its
   * message channel stops holding `activeTurnId`, and release the live
   * projection lease the parked generator would otherwise own forever. A
   * pumped queue message only reaches the CLI if the runtime turn is aborted.
   * Failures are isolated — the settle still happens.
   */
  onStallForceSettle?: (turn: ActiveFeatureTurn) => void;
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
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** Last observed progress (lease begin or touch). */
  private lastProgressAt = 0;
  /** Last real chunk of this lease; blocking-work polls never advance it. */
  private lastChunkAt = 0;
  /** One-shot guard for a throwing liveness probe (per lease). */
  private stallProbeErrorRecorded = false;
  /** One-shot guard for the suppressed-by-blocking-work diagnostic (per lease). */
  private stallSuppressedRecorded = false;

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
    this.armStallWatchdog();
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
    this.armStallWatchdog();
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
   * Progress evidence for the stall watchdog: every chunk of the active turn
   * (user or auto) calls this. A foreign/released turnId is ignored so a late
   * callback from an old turn can never keep a new lease alive.
   */
  touch(turnId: string): void {
    if (!this.active || this.active.turnId !== turnId) return;
    this.lastProgressAt = Date.now();
    this.lastChunkAt = Date.now();
  }

  private armStallWatchdog(): void {
    this.disarmStallWatchdog();
    this.lastProgressAt = Date.now();
    this.lastChunkAt = Date.now();
    this.stallProbeErrorRecorded = false;
    this.stallSuppressedRecorded = false;
    const timer = setInterval(() => this.checkStall(), TURN_LEASE_STALL_POLL_MS) as unknown as {
      unref?: () => void;
    };
    // A watchdog must never keep the host process alive on its own.
    timer.unref?.();
    this.stallTimer = timer as unknown as ReturnType<typeof setInterval>;
  }

  private disarmStallWatchdog(): void {
    if (this.stallTimer === null) return;
    clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  private checkStall(): void {
    const turn = this.active;
    if (!turn) {
      this.disarmStallWatchdog();
      return;
    }
    const idleMs = Date.now() - this.lastProgressAt;
    if (idleMs < TURN_LEASE_STALL_MS) return;
    // Evidence-backed silence is still bounded: a running-tool record whose
    // result was lost must not suppress the watchdog for the rest of the tab.
    const blockedMs = Date.now() - this.lastChunkAt;
    let blocking: boolean;
    try {
      blocking = this.deps.hasBlockingWork?.(turn.turnId) ?? false;
    } catch {
      // Fail safe: an unreadable liveness probe must never kill a live turn.
      blocking = true;
      // The probe-error entry is this lease's suppression evidence — do not
      // stack a second "skipped_blocking_work" entry on the same poll.
      this.stallSuppressedRecorded = true;
      if (!this.stallProbeErrorRecorded) {
        // One shot per lease: a permanently throwing probe would otherwise
        // append a diagnostic entry on every poll.
        this.stallProbeErrorRecorded = true;
        this.deps.recordDiagnostic?.({
          phase: 'lease_stall_force_settle',
          turnId: turn.turnId,
          generation: turn.generation,
          leaseKind: turn.kind,
          elapsedMs: idleMs,
          detail: 'skipped_probe_error',
        });
      }
    }
    if (blocking && blockedMs < TURN_LEASE_STALL_BLOCKED_MAX_MS) {
      if (!this.stallSuppressedRecorded) {
        this.stallSuppressedRecorded = true;
        this.deps.recordDiagnostic?.({
          phase: 'lease_stall_force_settle',
          turnId: turn.turnId,
          generation: turn.generation,
          leaseKind: turn.kind,
          elapsedMs: blockedMs,
          detail: 'skipped_blocking_work',
        });
      }
      // Legitimate chunk-free work (tool in flight / pending ask). Restart the
      // idle clock instead of accumulating silence across distinct waits.
      this.lastProgressAt = Date.now();
      return;
    }
    // A wedged turn cannot run its own cancel/finally: abort the runtime turn
    // (frees the message channel's active-turn slot) and release the live
    // projection lease first, or the pumped message only queues behind it.
    try {
      this.deps.onStallForceSettle?.(turn);
    } catch {
      // Cleanup failures must never keep the lease held.
    }
    const settled = this.finish(turn.turnId);
    if (settled && turn.kind === 'user' && this.deps.state.isStreaming) {
      this.deps.state.isStreaming = false;
    }
    this.deps.recordDiagnostic?.({
      phase: 'lease_stall_force_settle',
      turnId: turn.turnId,
      generation: turn.generation,
      leaseKind: turn.kind,
      elapsedMs: blocking ? blockedMs : idleMs,
      detail: settled
        ? (blocking ? 'settled_blocked_too_long' : 'settled')
        : 'skipped_not_held',
    });
    // finish() leaves the settled record; release consumes it so the queue is
    // pumped exactly once and a late runtime release becomes a no-op. Called
    // even when finish() lost the race: the cancel issued above may have
    // settled the lease through another path that does not pump.
    this.release(turn.turnId);
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
    this.disarmStallWatchdog();
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
   * Stop-hook deadlock backstop (2026-09-25): the CLI blocks on a Stop hook
   * and the SDK ignores interrupt() in that state, so the turn's result (and
   * with it the runtime-side release callback) never arrives. finish() the
   * active lease anyway so isStreaming drops and the queued input can flow;
   * the settled record stays so a genuine late release from the same turn
   * still pumps the queue exactly once. Idempotent: a turn that settled
   * through the normal path is a no-op here.
   *
   * Unlike finish(), a USER turn also drops isStreaming here: the generator's
   * finally — the normal owner of that flag on user turns — is exactly the
   * thing the deadlock wedged (its chunk promise never resolves).
   */
  forceSettleForDeadCancel(): boolean {
    if (!this.active) return false;
    const turn = this.active;
    const settled = this.finish(turn.turnId);
    if (settled && turn.kind === 'user' && this.deps.state.isStreaming) {
      this.deps.state.isStreaming = false;
    }
    return settled;
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
      this.disarmStallWatchdog();
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
