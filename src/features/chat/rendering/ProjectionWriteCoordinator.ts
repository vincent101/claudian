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
   * The task is skipped — resolves null — when the wait is cancelled or the
   * coordinator is disposed; a cancelled waiter still waits out its FIFO turn
   * so successors never overtake a still-running predecessor.
   */
  async runStored<T>(isCancelled: () => boolean, task: () => Promise<T>): Promise<T | null> {
    const lease = await this.acquire(false, isCancelled);
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

  private acquire(isLive: boolean, isCancelled?: () => boolean): Promise<ProjectionWriteLease | null> {
    return new Promise(resolve => {
      if (this.disposed || isCancelled?.()) {
        resolve(null);
        return;
      }
      this.queue.push({
        isCancelled: isCancelled ?? (() => false),
        isLive,
        start: granted => resolve(granted),
        cancel: () => resolve(null),
      });
      if (isLive) this.queuedLiveCount += 1;
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
