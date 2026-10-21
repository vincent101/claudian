import { ProjectionWriteCoordinator } from '@/features/chat/rendering/ProjectionWriteCoordinator';

describe('ProjectionWriteCoordinator', () => {
  it('serializes stored transactions FIFO', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const order: string[] = [];

    const first = coordinator.runStored(() => false, async () => {
      order.push('stored-1:start');
      await Promise.resolve();
      order.push('stored-1:end');
    });
    const second = coordinator.runStored(() => false, async () => {
      order.push('stored-2:start');
      await Promise.resolve();
      order.push('stored-2:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['stored-1:start']);
    await Promise.all([first, second]);
    expect(order).toEqual(['stored-1:start', 'stored-1:end', 'stored-2:start', 'stored-2:end']);
  });

  it('holds stored back while a live lease is held and runs it exactly once after release', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const live = await coordinator.acquireLive();
    expect(live).not.toBeNull();

    let storedRuns = 0;
    const stored = coordinator.runStored(() => false, async () => {
      storedRuns += 1;
    });

    await Promise.resolve();
    await Promise.resolve();
    // P1: the stored transaction must not interleave with the live turn.
    expect(storedRuns).toBe(0);

    live!.release();
    await stored;
    expect(storedRuns).toBe(1);

    // Idempotent release: a second release call must not re-run or block.
    live!.release();
    await Promise.resolve();
    expect(storedRuns).toBe(1);
  });

  it('grants a queued live lease only after the stored transaction finishes', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    let storedDone = false;
    let liveGranted = false;

    const stored = coordinator.runStored(() => false, async () => {
      await Promise.resolve();
      storedDone = true;
    });
    const livePromise = coordinator.acquireLive();
    void livePromise.then(() => { liveGranted = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(liveGranted).toBe(false);

    await stored;
    const live = await livePromise;
    expect(storedDone).toBe(true);
    expect(live).not.toBeNull();
    live!.release();
  });

  it('keeps FIFO order across mixed stored and live waiters', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const order: string[] = [];

    const stored = coordinator.runStored(() => false, async () => {
      order.push('stored');
    });
    const livePromise = coordinator.acquireLive().then(lease => {
      order.push('live');
      lease?.release();
      return lease;
    });

    await Promise.all([stored, livePromise]);
    expect(order).toEqual(['stored', 'live']);
  });

  it('skips the task of a cancelled stored waiter without blocking successors', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const live = await coordinator.acquireLive();
    let cancelled = false;
    let successorRuns = 0;

    const cancelledStored = coordinator.runStored(() => cancelled, async () => {
      throw new Error('cancelled task must not run');
    });
    const successor = coordinator.runStored(() => false, async () => {
      successorRuns += 1;
    });

    cancelled = true;
    live!.release();

    await expect(cancelledStored).resolves.toBeNull();
    await successor;
    expect(successorRuns).toBe(1);
  });

  it('resolves a cancelled live waiter with null', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const live = await coordinator.acquireLive();
    let cancelled = false;

    const queuedLive = coordinator.acquireLive(() => cancelled);
    // Cancellation lands while the waiter is still queued behind the live lease.
    cancelled = true;
    live!.release();

    // The queued waiter reaches the front, sees cancellation, resolves null
    // and must not block later waiters.
    const later = coordinator.runStored(() => false, async () => 'later');
    await expect(queuedLive).resolves.toBeNull();
    await expect(later).resolves.toBe('later');
  });

  it('settles every queued waiter as cancelled on dispose', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const live = await coordinator.acquireLive();

    const queuedStored = coordinator.runStored(() => false, async () => {
      throw new Error('disposed task must not run');
    });
    const queuedLive = coordinator.acquireLive();

    coordinator.dispose();

    await expect(queuedStored).resolves.toBeNull();
    await expect(queuedLive).resolves.toBeNull();

    // New acquisitions after dispose resolve null immediately.
    await expect(coordinator.acquireLive()).resolves.toBeNull();
    await expect(coordinator.runStored(() => false, async () => 'x')).resolves.toBeNull();

    // Releasing the previously held lease after dispose stays a no-op.
    live!.release();
  });

  it('keeps only the latest queued window intent for each direction', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const live = await coordinator.acquireLive();
    const runs: string[] = [];

    const first = coordinator.runLatestStoredIntent('older', () => false, async () => { runs.push('first'); });
    const second = coordinator.runLatestStoredIntent('older', () => false, async () => { runs.push('second'); });
    const opposite = coordinator.runLatestStoredIntent('newer', () => false, async () => { runs.push('newer'); });

    live!.release();
    await Promise.all([first, second, opposite]);
    expect(runs).toEqual(['second', 'newer']);
  });

  it('does not grant a live lease while an earlier live lease is still held', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const first = await coordinator.acquireLive();
    let secondGranted = false;
    const secondPromise = coordinator.acquireLive();
    void secondPromise.then(() => { secondGranted = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondGranted).toBe(false);

    first!.release();
    const second = await secondPromise;
    expect(second).not.toBeNull();
    second!.release();
  });

  describe('runStored wait timeout (exits the wait, never the queue order)', () => {
    afterEach(() => { jest.useRealTimers(); });

    it('resolves null when the FIFO wait times out, and the timed-out slot is skipped at grant without reordering successors', async () => {
      jest.useFakeTimers();
      const coordinator = new ProjectionWriteCoordinator();
      const live = await coordinator.acquireLive();
      let timedOutRuns = 0;
      let successorRuns = 0;

      const timedOut = coordinator.runStored(() => false, async () => {
        timedOutRuns += 1;
      }, { timeoutMs: 5_000 });
      const successor = coordinator.runStored(() => false, async () => {
        successorRuns += 1;
      });

      await jest.advanceTimersByTimeAsync(5_000);
      // The caller is unblocked immediately even though the holder never
      // released: pump cannot run while the live lease is held.
      await expect(timedOut).resolves.toBeNull();
      expect(timedOutRuns).toBe(0);

      // The timed-out entry keeps its queue slot and is skipped at grant
      // time; the successor runs after it in the original FIFO order.
      live!.release();
      await successor;
      expect(successorRuns).toBe(1);
      expect(timedOutRuns).toBe(0);
    });

    it('runs the task to completion when the grant lands before the timer', async () => {
      jest.useFakeTimers();
      const coordinator = new ProjectionWriteCoordinator();
      const live = await coordinator.acquireLive();
      let ran = false;

      const stored = coordinator.runStored(() => false, async () => {
        ran = true;
        await Promise.resolve();
        return 'done';
      }, { timeoutMs: 60_000 });
      live!.release();

      // The timeout only covers the wait: a granted task body is never
      // interrupted, and the settled promise is not overwritten late.
      await expect(stored).resolves.toBe('done');
      expect(ran).toBe(true);
      await jest.advanceTimersByTimeAsync(60_000);
      await expect(stored).resolves.toBe('done');
    });

    it('resolves null when queue-time cancellation and the wait timeout coexist', async () => {
      jest.useFakeTimers();
      const coordinator = new ProjectionWriteCoordinator();
      const live = await coordinator.acquireLive();
      let cancelled = false;

      const stored = coordinator.runStored(() => cancelled, async () => {
        throw new Error('cancelled task must not run');
      }, { timeoutMs: 5_000 });

      cancelled = true;
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(stored).resolves.toBeNull();

      // A cancelled slot must still not block successors once released.
      const later = coordinator.runStored(() => false, async () => 'later');
      live!.release();
      await expect(later).resolves.toBe('later');
    });

    it('clears the wait timer when dispose settles a pending timed waiter', async () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
      const coordinator = new ProjectionWriteCoordinator();
      const live = await coordinator.acquireLive();

      const stored = coordinator.runStored(() => false, async () => {
        throw new Error('disposed task must not run');
      }, { timeoutMs: 60_000 });

      coordinator.dispose();
      await expect(stored).resolves.toBeNull();
      expect(clearSpy).toHaveBeenCalled();
      // No timer survives dispose: advancing past the timeout stays inert.
      await jest.advanceTimersByTimeAsync(60_000);

      clearSpy.mockRestore();
      live!.release();
    });
  });

  describe('bypassLive exchange domain (two-slot: stored S / live L)', () => {
    it('grants a bypassLive exchange while a live turn holds the lease, without disturbing it', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      const live = await coordinator.acquireLive();
      const order: string[] = [];

      const exchange = coordinator.runStored(() => false, async () => {
        order.push('exchange');
      }, { bypassLive: true });
      await exchange;
      expect(order).toEqual(['exchange']);

      // The live turn was never preempted: default stored work still waits
      // for the live domain exactly as before.
      let defaultRuns = 0;
      const stored = coordinator.runStored(() => false, async () => {
        defaultRuns += 1;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(defaultRuns).toBe(0);

      live!.release();
      await stored;
      expect(defaultRuns).toBe(1);
    });

    it('does not let an exchange overtake a default stored waiter queued ahead of it behind a live turn', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      const live = await coordinator.acquireLive();
      const order: string[] = [];

      const defaultStored = coordinator.runStored(() => false, async () => {
        order.push('default');
      });
      const exchange = coordinator.runStored(() => false, async () => {
        order.push('exchange');
      }, { bypassLive: true });

      await Promise.resolve();
      await Promise.resolve();
      // The S domain stays strictly FIFO: the exchange does not skip the
      // viable default waiter even though the S slot itself is free.
      expect(order).toEqual([]);

      live!.release();
      await Promise.all([defaultStored, exchange]);
      expect(order).toEqual(['default', 'exchange']);
    });

    it('degenerates to the single-slot behavior when no live turn is involved', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      const order: string[] = [];

      const first = coordinator.runStored(() => false, async () => {
        order.push('first');
      });
      const exchange = coordinator.runStored(() => false, async () => {
        order.push('exchange');
      }, { bypassLive: true });
      const second = coordinator.runStored(() => false, async () => {
        order.push('second');
      });

      await Promise.all([first, exchange, second]);
      // Without live turns the S slot is the old single active slot: the
      // bypassLive marker changes nothing about grant order or exclusivity.
      expect(order).toEqual(['first', 'exchange', 'second']);
    });

    it('holds default stored work behind an active exchange, and grants a live lease beside it (disjoint domains)', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      let releaseExchange!: () => void;
      const gate = new Promise<void>(resolve => { releaseExchange = resolve; });

      const exchange = coordinator.runStored(() => false, () => gate, { bypassLive: true });
      await Promise.resolve();

      // The exchange holds only S: a live lease at the queue head acquires
      // immediately in parallel — disjoint write domains, no mutual exclusion.
      const live = await coordinator.acquireLive();

      let defaultRuns = 0;
      const stored = coordinator.runStored(() => false, async () => {
        defaultRuns += 1;
      });
      await Promise.resolve();
      await Promise.resolve();
      // Queued behind BOTH holders: S (exchange) and L (live).
      expect(defaultRuns).toBe(0);

      releaseExchange();
      await exchange;
      await Promise.resolve();
      await Promise.resolve();
      // S is free again but L is still held: default stored keeps waiting.
      expect(defaultRuns).toBe(0);

      live!.release();
      await stored;
      expect(defaultRuns).toBe(1);
    });

    it('lets an exchange start past queued live waiters and dead (cancelled) stored slots, never past a viable default', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      const live = await coordinator.acquireLive();
      const order: string[] = [];

      // Queued live waiter (blocked by the active live) plus a cancelled
      // default stored slot ahead of the exchange: both are skippable — the
      // live waiter by the domain split, the dead slot because successors
      // already pass cancelled entries at grant time.
      const queuedLive = coordinator.acquireLive();
      const cancelled = coordinator.runStored(() => true, async () => {
        throw new Error('cancelled task must not run');
      });
      const exchange = coordinator.runStored(() => false, async () => {
        order.push('exchange');
      }, { bypassLive: true });

      await exchange;
      expect(order).toEqual(['exchange']);

      live!.release();
      await expect(cancelled).resolves.toBeNull();
      const secondLive = await queuedLive;
      secondLive!.release();
    });

    it('clears both slots on dispose and settles queued waiters without leaking timers', async () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
      const coordinator = new ProjectionWriteCoordinator();

      // Both domains are held simultaneously: live owns L, the exchange owns S.
      const live = await coordinator.acquireLive();
      const exchange = coordinator.runStored(() => false, () => new Promise(() => {}), { bypassLive: true });
      await Promise.resolve();
      const queued = coordinator.runStored(() => false, async () => {
        throw new Error('disposed task must not run');
      }, { timeoutMs: 60_000 });
      const queuedLive = coordinator.acquireLive();

      coordinator.dispose();
      await expect(queued).resolves.toBeNull();
      await expect(queuedLive).resolves.toBeNull();
      expect(clearSpy).toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(60_000);

      await expect(coordinator.acquireLive()).resolves.toBeNull();
      await expect(coordinator.runStored(() => false, async () => 'x')).resolves.toBeNull();
      // Releasing the previously held leases after dispose stays a no-op.
      live!.release();
      void exchange;

      clearSpy.mockRestore();
      jest.useRealTimers();
    });
  });

  it('reports hasLiveTurn only while a live turn holds or waits for the lease', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    expect(coordinator.hasLiveTurn()).toBe(false);

    const stored = coordinator.runStored(() => false, async () => {
      // A stored transaction alone must not read as a live turn.
      expect(coordinator.hasLiveTurn()).toBe(false);
    });
    await stored;
    expect(coordinator.hasLiveTurn()).toBe(false);

    // Live waiter queued behind the stored transaction still defers stored work.
    let releaseStored!: () => void;
    const gate = new Promise<void>(resolve => { releaseStored = resolve; });
    const stored2 = coordinator.runStored(() => false, () => gate);
    const livePromise = coordinator.acquireLive();
    await Promise.resolve();
    expect(coordinator.hasLiveTurn()).toBe(true);

    releaseStored();
    await stored2;
    const live = await livePromise;
    expect(coordinator.hasLiveTurn()).toBe(true);

    live!.release();
    await Promise.resolve();
    expect(coordinator.hasLiveTurn()).toBe(false);
  });
});
