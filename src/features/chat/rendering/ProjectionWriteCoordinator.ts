/**
 * Per-tab projection write lease (coord protocol P1–P7). Coordinates who may
 * write the ChatState → messagesEl projection through two mutex domains: the
 * stored domain (S slot — clear-rebuild / prepend framing / the search
 * snapshot exchange, strictly FIFO among themselves) and the live domain
 * (L slot — one streaming turn). A default stored transaction needs BOTH
 * slots free (it rewrites the DOM the live turn owns); the exchange needs
 * only S (it writes lease refs and paging bookkeeping, disjoint from the
 * live page), so it may start while a live turn holds or waits for L —
 * never past a default stored waiter queued ahead of it.
 *
 * This is a UI-level shared facility: it holds no business messages and never
 * reads provider ids. Lock order is fixed — business turn lease → live
 * projection lease — and a live holder must release before queueing stored
 * work in the same execution flow; any reverse order can self-deadlock the
 * FIFO. Exchange entries do not join that deadlock cycle: they never take L
 * and never wait on the live domain. The exchange task body must also stay
 * free of awaits (structural contract, see RunStoredOptions.bypassLive) —
 * the single-slot total-order arguments against a concurrent switch or live
 * finalize depend on the critical section being atomic.
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
  /**
   * Marks the search-snapshot exchange: serialized against every other
   * stored writer through the S slot, but exempt from the live domain.
   */
  isExchange: boolean;
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
  /**
   * Routes this stored transaction through the exchange domain: it may
   * start while live turns hold or wait for the lease (its writes are
   * disjoint from the live page), while staying strictly FIFO against
   * every other stored writer.
   *
   * STRUCTURAL CONTRACT: the task body must stay synchronous — no await.
   * The safety arguments for running the exchange inside the live domain's
   * blind spot (single-threaded total order against a conversation switch
   * and a live finalize) rely on the critical section being atomic; an
   * awaited exchange silently voids them.
   */
  bypassLive?: boolean;
}

export class ProjectionWriteCoordinator {
  private queue: QueueEntry[] = [];
  /** Stored-domain mutex: default stored transactions and the exchange. */
  private activeStored: QueueEntry | null = null;
  /** Live-domain mutex: streaming turns only, never a stored entry. */
  private activeLive: QueueEntry | null = null;
  private queuedLiveCount = 0;
  private disposed = false;
  private readonly storedIntentVersions = new Map<StoredIntentDirection, number>();

  /**
   * Waits for exclusive projection-write rights for one live streaming turn.
   * Resolves null when the wait is cancelled or the coordinator is disposed —
   * callers must treat null as "do not write".
   */
  acquireLive(isCancelled?: () => boolean): Promise<ProjectionWriteLease | null> {
    return this.acquire(true, false, isCancelled);
  }

  /**
   * Runs one stored projection transaction (clear-rebuild / prepend framing).
   * The task is skipped — resolves null — when the wait is cancelled, the
   * coordinator is disposed, or (with `options.timeoutMs`) the FIFO wait
   * itself times out; a cancelled or timed-out waiter still waits out its
   * FIFO turn so successors never overtake a still-running predecessor.
   * With `options.bypassLive` the transaction is the search-snapshot
   * exchange (see RunStoredOptions for the domain rules and the no-await
   * contract on its body).
   */
  async runStored<T>(
    isCancelled: () => boolean,
    task: () => Promise<T>,
    options?: RunStoredOptions,
  ): Promise<T | null> {
    const lease = await this.acquire(false, options?.bypassLive === true, isCancelled, options?.timeoutMs);
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
   * not a synchronization primitive. Exchange entries never count: they do
   * not wait on the live domain.
   */
  hasLiveTurn(): boolean {
    return this.activeLive !== null || this.queuedLiveCount > 0;
  }

  /** Settles every queued waiter as cancelled and rejects new ones. */
  dispose(): void {
    this.disposed = true;
    this.activeStored = null;
    this.activeLive = null;
    this.drainCancelled();
  }

  private acquire(
    isLive: boolean,
    isExchange: boolean,
    isCancelled?: () => boolean,
    timeoutMs?: number,
  ): Promise<ProjectionWriteLease | null> {
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
        isExchange,
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

  private pump(): void {
    if (this.disposed) {
      this.drainCancelled();
      return;
    }
    while (this.queue.length > 0) {
      const next = this.queue[0];
      // Cancellation is re-checked at grant time: a waiter cancelled while
      // queued exits without running its task and without blocking successors.
      if (next.isCancelled()) {
        this.queue.shift();
        if (next.isLive) this.queuedLiveCount -= 1;
        next.cancel();
        continue;
      }
      if (this.canStart(next)) {
        this.queue.shift();
        this.start(next);
        continue;
      }
      // A blocked default stored head stalls the whole queue: S-domain
      // strict FIFO means nothing may overtake it. A blocked live head
      // leaves exactly one relaxation — the exchange scan below.
      if (!next.isLive) return;
      break;
    }
    this.pumpExchangePastLiveWaiters();
  }

  /**
   * The single FIFO relaxation: while the queue head is a live waiter that
   * cannot start, the first viable stored-domain waiter behind any number
   * of live waiters may still run — but only if it is the exchange (a
   * default stored waiter never overtakes the head) and only while the S
   * slot is free. Cancelled stored slots are dead: successors already pass
   * them at grant time, so the scan skips them without settling them early.
   */
  private pumpExchangePastLiveWaiters(): void {
    for (let index = 0; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      if (candidate.isLive) continue;
      if (candidate.isCancelled()) continue;
      if (!candidate.isExchange) return;
      if (this.activeStored !== null) return;
      this.queue.splice(index, 1);
      this.start(candidate);
      return;
    }
  }

  private canStart(entry: QueueEntry): boolean {
    if (entry.isLive) {
      // Live needs L plus exclusion against default stored writers (they
      // share its DOM). An active exchange does not block it: disjoint
      // write domains, and the exchange's synchronous body settles before
      // any interleaved continuation could observe a torn swap.
      return this.activeLive === null
        && (this.activeStored === null || this.activeStored.isExchange);
    }
    // Default stored writes DOM owned by the live domain → needs both
    // slots. The exchange writes only stored-domain state → needs S alone.
    return this.activeStored === null
      && (entry.isExchange || this.activeLive === null);
  }

  private start(entry: QueueEntry): void {
    if (entry.isLive) {
      this.activeLive = entry;
      this.queuedLiveCount -= 1;
    } else {
      this.activeStored = entry;
    }
    let released = false;
    entry.start({
      release: () => {
        if (released) return;
        released = true;
        if (entry.isLive) {
          if (this.activeLive !== entry) return;
          this.activeLive = null;
        } else {
          if (this.activeStored !== entry) return;
          this.activeStored = null;
        }
        this.pump();
      },
    });
  }

  private drainCancelled(): void {
    const queue = this.queue.splice(0);
    this.queuedLiveCount = 0;
    for (const entry of queue) entry.cancel();
  }
}
