/**
 * Per-tab projection write lease (coord protocol P1–P7). Coordinates who may
 * write the ChatState → messagesEl projection: one stored transaction
 * (clear-rebuild or prepend framing) or one live streaming turn at a time,
 * FIFO across both kinds.
 *
 * This is a UI-level shared facility: it holds no business messages and never
 * reads provider ids. Lock order is fixed — business turn lease → live
 * projection lease — and a live holder must release before queueing stored
 * work; any reverse order can self-deadlock the FIFO.
 */
export type StoredIntentDirection = 'older' | 'newer';

export interface StoredIntentDiagnostic {
  direction: StoredIntentDirection;
  outcome: 'committed' | 'cancelled' | 'superseded';
}

export interface ProjectionWriteLease {
  /** Idempotent: releasing twice is a no-op. */
  release(): void;
}

interface QueueEntry {
  isCancelled: () => boolean;
  /** Whether the waiter is a live streaming turn (vs a stored transaction). */
  isLive: boolean;
  /** Grants the lease to the waiter. */
  start: (lease: ProjectionWriteLease) => void;
  /** Cancels the wait without running any task. */
  cancel: () => void;
}

export interface RunStoredOptions {
  /**
   * Cap on the FIFO wait only (enqueue → grant). A granted task body is
   * never interrupted: the timeout resolves the caller's wait with null
   * while the queue slot stays put — pump skips it at grant time through
   * the existing cancellation check, so successors never overtake a
   * still-running predecessor. Exiting the wait is not preempting the
   * queue: the timed-out waiter neither releases nor steals any lease.
   */
  timeoutMs?: number;
}

export class ProjectionWriteCoordinator {
  private queue: QueueEntry[] = [];
  private active = false;
  private activeIsLive = false;
  private queuedLiveCount = 0;
  private disposed = false;
  private readonly storedIntentVersions = new Map<StoredIntentDirection, number>();

  /**
   * Waits for exclusive projection-write rights for one live streaming turn.
   * Resolves null when the wait is cancelled or the coordinator is disposed —
   * callers must treat null as "do not write".
   */
  acquireLive(isCancelled?: () => boolean): Promise<ProjectionWriteLease | null> {
    return this.acquire(true, isCancelled);
  }

  /**
   * Runs one stored projection transaction (clear-rebuild / prepend framing).
   * The task is skipped — resolves null — when the wait is cancelled, the
   * coordinator is disposed, or (with `options.timeoutMs`) the FIFO wait
   * itself times out; a cancelled or timed-out waiter still waits out its
   * FIFO turn so successors never overtake a still-running predecessor.
   */
  async runStored<T>(
    isCancelled: () => boolean,
    task: () => Promise<T>,
    options?: RunStoredOptions,
  ): Promise<T | null> {
    const lease = await this.acquire(false, isCancelled, options?.timeoutMs);
    if (!lease) return null;
    try {
      return await task();
    } finally {
      lease.release();
    }
  }

  /**
   * Window intents are replaceable while queued behind a live turn. This is
   * deliberately layered on runStored so the P1-P7 FIFO/lease semantics stay
   * unchanged; only stale same-direction work self-cancels at grant time.
   */
  runLatestStoredIntent<T>(
    direction: StoredIntentDirection,
    isCancelled: () => boolean,
    task: () => Promise<T>,
    onDiagnostic?: (event: StoredIntentDiagnostic) => void,
  ): Promise<T | null> {
    const version = (this.storedIntentVersions.get(direction) ?? 0) + 1;
    this.storedIntentVersions.set(direction, version);
    const cancelled = (): boolean => isCancelled() || this.storedIntentVersions.get(direction) !== version;
    return this.runStored(cancelled, async () => {
      if (cancelled()) {
        onDiagnostic?.({ direction, outcome: 'superseded' });
        return null as T | null;
      }
      const result = await task();
      onDiagnostic?.({ direction, outcome: 'committed' });
      return result;
    }).then(result => {
      if (result === null && isCancelled()) onDiagnostic?.({ direction, outcome: 'cancelled' });
      return result;
    });
  }

  /**
   * Whether a live streaming turn holds the lease or is queued ahead of a
   * stored transaction queued right now — i.e. stored work would wait for
   * the turn to finish. UX signal (e.g. the deferred search-locate notice),
   * not a synchronization primitive.
   */
  hasLiveTurn(): boolean {
    return this.activeIsLive || this.queuedLiveCount > 0;
  }

  /** Settles every queued waiter as cancelled and rejects new ones. */
  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.activeIsLive = false;
    this.drainCancelled();
  }

  private acquire(isLive: boolean, isCancelled?: () => boolean, timeoutMs?: number): Promise<ProjectionWriteLease | null> {
    return new Promise(resolve => {
      if (this.disposed || isCancelled?.()) {
        resolve(null);
        return;
      }
      // Single-threaded settled-flag race: the grant path (start) and the
      // timer callback can never interleave, and resolve is idempotent —
      // whichever fires first wins, the other becomes a no-op.
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const clearTimer = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      this.queue.push({
        isCancelled: timeoutMs === undefined
          ? (isCancelled ?? (() => false))
          : () => (isCancelled?.() ?? false) || timedOut,
        isLive,
        start: granted => {
          clearTimer();
          resolve(granted);
        },
        cancel: () => {
          clearTimer();
          resolve(null);
        },
      });
      if (isLive) this.queuedLiveCount += 1;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timer = null;
          timedOut = true;
          // Resolve immediately to unblock the caller: pump will not run
          // before the current holder releases, so the latch alone would
          // leave the caller waiting exactly as long as the pathological
          // holder it is escaping. The queue slot stays for grant-time skip.
          resolve(null);
        }, timeoutMs);
      }
      this.pump();
    });
  }

  private releaseActive(): void {
    this.active = false;
    this.activeIsLive = false;
    this.pump();
  }

  private pump(): void {
    if (this.disposed) {
      this.drainCancelled();
      return;
    }
    while (!this.active && this.queue.length > 0) {
      const next = this.queue.shift()!;
      // Cancellation is re-checked at grant time: a waiter cancelled while
      // queued exits without running its task and without blocking successors.
      if (next.isCancelled()) {
        if (next.isLive) this.queuedLiveCount -= 1;
        next.cancel();
        continue;
      }
      this.active = true;
      this.activeIsLive = next.isLive;
      if (next.isLive) this.queuedLiveCount -= 1;
      let released = false;
      next.start({
        release: () => {
          if (released) return;
          released = true;
          if (this.active) this.releaseActive();
        },
      });
      return;
    }
  }

  private drainCancelled(): void {
    const queue = this.queue.splice(0);
    this.queuedLiveCount = 0;
    for (const entry of queue) entry.cancel();
  }
}
