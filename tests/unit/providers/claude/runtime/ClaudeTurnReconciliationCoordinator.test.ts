import {
  ClaudeTurnReconciliationCoordinator,
  type ReconciliationDiagnosticsSink,
} from '@/providers/claude/runtime/ClaudeTurnReconciliationCoordinator';
import type { TranscriptDiagnosticEvent } from '@/providers/claude/transcript/ClaudeTranscriptDiagnosticLog';

class MemorySink implements ReconciliationDiagnosticsSink {
  readonly events: TranscriptDiagnosticEvent[] = [];
  private counter = 0;

  hashId(id: string): string {
    this.counter += 1;
    // Irreversible like the real salted sha256 sink: the raw id must never
    // be recoverable from diagnostics.
    return `hash-${this.counter.toString(36).padStart(4, '0')}-${id.length}`;
  }

  record(event: TranscriptDiagnosticEvent): void {
    this.events.push(event);
  }

  phases(): string[] {
    return this.events.map(event => event.phase);
  }
}

describe('ClaudeTurnReconciliationCoordinator (batch 1: observe-only bypass)', () => {
  it('defaults to observe mode', () => {
    expect(new ClaudeTurnReconciliationCoordinator().getMode()).toBe('observe');
  });

  it('binds a dispatched host turn and returns host_mirror when the observer sees the same UUID', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator();
    coordinator.recordReserved('turn-1', 'uuid-1');
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    const verdict = coordinator.recordObservedStart({ canonicalTurnId: 'uuid-1', lineOffset: 128 });

    expect(verdict).toEqual({ kind: 'host_mirror', canonicalTurnId: 'uuid-1' });
    expect(coordinator.getStats()).toEqual({
      eligibleHostTurns: 1,
      matchedHostTurns: 1,
      hostUnmatchedTurns: 0,
      externalTurns: 0,
      mirrorEventsDropped: 0,
      identityConflicts: 0,
    });
  });

  it('reports external_new with an observer_only diagnostic for unknown UUIDs', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    const verdict = coordinator.recordObservedStart({ canonicalTurnId: 'peer-uuid', sourceKind: 'peer' });

    expect(verdict).toEqual({ kind: 'external_new', canonicalTurnId: 'peer-uuid' });
    expect(coordinator.getStats().externalTurns).toBe(1);
    expect(sink.phases()).toEqual(
      expect.arrayContaining(['turn_identity_dispatched', 'turn_identity_observer_only']),
    );
    expect(sink.events.find(event => event.phase === 'turn_identity_observer_only')).toEqual(
      expect.objectContaining({ sourceKind: 'peer' }),
    );
  });

  it('deduplicates a repeated observed start as duplicate, not a second match', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    expect(coordinator.recordObservedStart({ canonicalTurnId: 'uuid-1' })).toEqual({ kind: 'host_mirror', canonicalTurnId: 'uuid-1' });
    expect(coordinator.recordObservedStart({ canonicalTurnId: 'uuid-1' })).toEqual({ kind: 'duplicate', canonicalTurnId: 'uuid-1' });

    expect(coordinator.getStats().matchedHostTurns).toBe(1);
    expect(coordinator.getStats().externalTurns).toBe(0);
    expect(sink.phases().filter(phase => phase === 'turn_identity_duplicate')).toHaveLength(1);
  });

  it('finalizes host_only when a dispatched turn settles without ever being observed', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordReserved('turn-1', 'uuid-1');
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    coordinator.noteHostTurnSettled('turn-1');

    expect(coordinator.getStats()).toEqual(expect.objectContaining({
      eligibleHostTurns: 1,
      matchedHostTurns: 0,
      hostUnmatchedTurns: 1,
    }));
    expect(sink.phases()).toContain('turn_identity_host_only');
  });

  it('does not finalize host_only for a settled turn the observer already matched', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });
    coordinator.recordObservedStart({ canonicalTurnId: 'uuid-1' });

    coordinator.noteHostTurnSettled('turn-1');

    expect(coordinator.getStats().hostUnmatchedTurns).toBe(0);
    expect(sink.phases()).not.toContain('turn_identity_host_only');
  });

  it('still matches a late observation after host_only finalized, keeping both diagnostics visible', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });
    coordinator.noteHostTurnSettled('turn-1');

    const verdict = coordinator.recordObservedStart({ canonicalTurnId: 'uuid-1' });

    expect(verdict).toEqual({ kind: 'host_mirror', canonicalTurnId: 'uuid-1' });
    expect(sink.phases()).toEqual(expect.arrayContaining(['turn_identity_host_only', 'turn_identity_matched']));
  });

  it('flags a conflict when one host turn dispatches two different canonical UUIDs', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-2', hostTurnIds: ['turn-1'] });

    expect(coordinator.getStats().identityConflicts).toBe(1);
    expect(sink.phases()).toContain('turn_identity_conflict');
    // An already-mapped host turn dispatching a different canonical UUID is
    // an alias remap, not identity corruption.
    expect(sink.events.find(event => event.phase === 'turn_identity_conflict')).toEqual(
      expect.objectContaining({ reason: 'alias_remap' }),
    );
  });

  it('flags a conflict when a canonical UUID lands on an incompatible lease group', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1', 'turn-2'] });

    coordinator.recordDispatched({ leaseTurnId: 'turn-9', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-9'] });

    expect(coordinator.getStats().identityConflicts).toBe(1);
    // An already-bound canonical UUID dispatching under a different lease
    // group is a canonical rebind.
    expect(sink.events.find(event => event.phase === 'turn_identity_conflict')).toEqual(
      expect.objectContaining({ reason: 'canonical_rebind' }),
    );
  });

  it('tags merged-turn crash-replay remaps so the promotion gate can exclude them', () => {
    // Crash recovery replays the owner-only lastSentMessage. When that
    // message was a merged turn's later writer, the replay dispatches a
    // fresh canonical UUID under a host turn already mapped to the merged
    // item's canonical UUID — an expected alias remap that must not read as
    // identity corruption in the batch-1 promotion gate.
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-a', canonicalTurnId: 'uuid-a', hostTurnIds: ['turn-a', 'turn-b'] });

    coordinator.recordDispatched({ leaseTurnId: 'turn-b', canonicalTurnId: 'uuid-b', hostTurnIds: ['turn-b'] });

    expect(coordinator.getStats().identityConflicts).toBe(1);
    expect(sink.events.find(event => event.phase === 'turn_identity_conflict')).toEqual(
      expect.objectContaining({ reason: 'alias_remap' }),
    );
  });

  it('treats a repeated dispatch of the identical canonical identity as idempotent', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1', 'turn-2'] });

    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1', 'turn-2'] });

    expect(coordinator.getStats()).toEqual(expect.objectContaining({ eligibleHostTurns: 1, identityConflicts: 0 }));
  });

  it('merges text-merge aliases onto one eligible canonical turn', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());
    coordinator.recordReserved('turn-1', 'uuid-a');
    coordinator.recordReserved('turn-2', 'uuid-b');
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-a', hostTurnIds: ['turn-1', 'turn-2'] });

    coordinator.recordObservedStart({ canonicalTurnId: 'uuid-a' });

    expect(coordinator.getStats()).toEqual(expect.objectContaining({
      eligibleHostTurns: 1,
      matchedHostTurns: 1,
    }));
  });

  it('invalidates every binding on session-generation advance', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });
    coordinator.noteHostTurnSettled('turn-1');

    coordinator.advanceSessionGeneration();
    const verdict = coordinator.recordObservedStart({ canonicalTurnId: 'uuid-1' });

    // Late observer event from the previous generation must not re-bind.
    expect(verdict).toEqual({ kind: 'external_new', canonicalTurnId: 'uuid-1' });
    // Counters stay cumulative across the reconciliation window; only the
    // live bindings were invalidated.
    expect(coordinator.getStats()).toEqual(expect.objectContaining({ eligibleHostTurns: 1, matchedHostTurns: 0, externalTurns: 1 }));
  });

  it('never counts a dropped (never-dispatched) reservation as eligible', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());
    coordinator.recordReserved('turn-dropped', 'uuid-dropped');

    expect(coordinator.getStats().eligibleHostTurns).toBe(0);
  });

  it('records diagnostics with hashed identities only, never raw UUIDs', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-raw-secret', hostTurnIds: ['turn-1', 'turn-2'] });

    coordinator.recordObservedStart({ canonicalTurnId: 'uuid-raw-secret', lineOffset: 512 });

    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain('uuid-raw-secret');
    expect(sink.events.find(event => event.phase === 'turn_identity_dispatched')).toEqual(
      expect.objectContaining({ hostAliases: 2, leaseKind: 'user' }),
    );
    expect(sink.events.find(event => event.phase === 'turn_identity_matched')).toEqual(
      expect.objectContaining({ offset: 512 }),
    );
  });

  it('reports identity_missing when a dispatch carries no canonical UUID', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);

    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: '', hostTurnIds: ['turn-1'] });

    expect(coordinator.getStats().eligibleHostTurns).toBe(0);
    expect(sink.events.find(event => event.phase === 'turn_identity_dispatched')).toEqual(
      expect.objectContaining({ reason: 'identity_missing' }),
    );
  });

  it('settles by any host alias, not only the lease owner', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1', 'turn-2'] });

    coordinator.noteHostTurnSettled('turn-2');

    expect(coordinator.getStats().hostUnmatchedTurns).toBe(1);
  });

  it('ignores settles for unknown turns (cancelled before dispatch)', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());

    coordinator.noteHostTurnSettled('never-dispatched');

    expect(coordinator.getStats().hostUnmatchedTurns).toBe(0);
  });
});

describe('ClaudeTurnReconciliationCoordinator result-echo consultation (G1)', () => {
  it('binds the settling lease when the echo consumed its canonical UUID', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    const verdict = coordinator.recordResultEcho({
      leaseTurnId: 'turn-1',
      consumedUuids: ['uuid-1'],
      queuedTurnCount: 0,
      resultIndex: 0,
    });

    expect(verdict).toEqual({ kind: 'bound', leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1' });
    expect(coordinator.getResultEchoStats()).toEqual({ consulted: 1, bound: 1, mismatch: 0, unbound: 0 });
    expect(sink.events.find(event => event.phase === 'turn_identity_result_echo')).toEqual(
      expect.objectContaining({ echoOutcome: 'bound', queuedTurnCount: 0, resultIndex: 0 }),
    );
  });

  it('binds a merged turn through any host alias, not only the lease owner', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1', 'turn-2'] });

    const verdict = coordinator.recordResultEcho({ leaseTurnId: 'turn-2', consumedUuids: ['uuid-1'] });

    expect(verdict).toEqual({ kind: 'bound', leaseTurnId: 'turn-2', canonicalTurnId: 'uuid-1' });
  });

  it('reports mismatch when the echo belongs to a different host turn (the G1 3-in-2-result shape)', () => {
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });
    coordinator.recordDispatched({ leaseTurnId: 'turn-2', canonicalTurnId: 'uuid-2', hostTurnIds: ['turn-2'] });

    const verdict = coordinator.recordResultEcho({ leaseTurnId: 'turn-1', consumedUuids: ['uuid-2'] });

    expect(verdict).toEqual({ kind: 'mismatch', leaseTurnId: 'turn-1', echoedCanonicalTurnId: 'uuid-2' });
    expect(coordinator.getResultEchoStats()).toEqual({ consulted: 1, bound: 0, mismatch: 1, unbound: 0 });
    // The echoed canonical UUID (never the raw string) keys the diagnostic.
    expect(sink.events.find(event => event.phase === 'turn_identity_result_echo')).toEqual(
      expect.objectContaining({ echoOutcome: 'mismatch' }),
    );
    expect(JSON.stringify(sink.events)).not.toContain('uuid-2');
  });

  it('reports unbound when the echo maps to no dispatched turn', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    const verdict = coordinator.recordResultEcho({ leaseTurnId: 'turn-1', consumedUuids: ['uuid-unknown'] });

    expect(verdict).toEqual({ kind: 'unbound', leaseTurnId: 'turn-1' });
    expect(coordinator.getResultEchoStats()).toEqual({ consulted: 1, bound: 0, mismatch: 0, unbound: 1 });
  });

  it('keeps a canonical_rebind replay unbound instead of reporting a false mismatch', () => {
    // canonical_rebind reachable shape: the same canonical UUID dispatches
    // under a new lease, recordDispatched refuses to map that lease, and the
    // replay's result echoes the canonical UUID. The new lease is simply
    // unregistered — never evidence that the result belongs elsewhere.
    const sink = new MemorySink();
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', sink);
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });
    coordinator.recordDispatched({ leaseTurnId: 'turn-replay', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-replay'] });

    const verdict = coordinator.recordResultEcho({ leaseTurnId: 'turn-replay', consumedUuids: ['uuid-1'] });

    expect(verdict).toEqual({ kind: 'unbound', leaseTurnId: 'turn-replay' });
    expect(coordinator.getResultEchoStats()).toEqual({ consulted: 1, bound: 0, mismatch: 0, unbound: 1 });
    expect(sink.events.find(event => event.phase === 'turn_identity_result_echo')).toEqual(
      expect.objectContaining({ echoOutcome: 'unbound' }),
    );
  });

  it('reports unbound for a lease with no binding and for an empty echo', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());

    expect(coordinator.recordResultEcho({ leaseTurnId: 'turn-auto', consumedUuids: [] }))
      .toEqual({ kind: 'unbound', leaseTurnId: 'turn-auto' });
    expect(coordinator.getResultEchoStats()).toEqual({ consulted: 1, bound: 0, mismatch: 0, unbound: 1 });
  });

  it('keeps batch-1 stats untouched by echo consultation', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    coordinator.recordResultEcho({ leaseTurnId: 'turn-1', consumedUuids: ['uuid-1'] });

    expect(coordinator.getStats()).toEqual({
      eligibleHostTurns: 1,
      matchedHostTurns: 0,
      hostUnmatchedTurns: 0,
      externalTurns: 0,
      mirrorEventsDropped: 0,
      identityConflicts: 0,
    });
  });

  it('drops echo bindings with the session generation, never re-binding a stale echo', () => {
    const coordinator = new ClaudeTurnReconciliationCoordinator('observe', new MemorySink());
    coordinator.recordDispatched({ leaseTurnId: 'turn-1', canonicalTurnId: 'uuid-1', hostTurnIds: ['turn-1'] });

    coordinator.advanceSessionGeneration();

    expect(coordinator.recordResultEcho({ leaseTurnId: 'turn-1', consumedUuids: ['uuid-1'] }))
      .toEqual({ kind: 'unbound', leaseTurnId: 'turn-1' });
  });
});
