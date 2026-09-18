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
