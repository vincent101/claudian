import type { TranscriptDiagnosticEvent } from '../transcript/ClaudeTranscriptDiagnosticLog';

/**
 * Turn-identity reconciliation coordinator (batch 1, observe mode).
 *
 * Owns the single place that knows how a host-dispatched turn (feature
 * turnId + canonical transcript UUID) and an observer-seen transcript user
 * row relate. Batch 1 is a read-only bypass: it records facts, computes
 * verdicts and diagnostics, and never changes settlement, promotion or
 * notifications (docs/designs/2026-09-21-claudian双轨身份绑定对账方案 §6 批1).
 *
 * Not its job: reading transcript files, transforming StreamChunks, holding
 * MessageChannel/feature/DOM leases, rendering, or provider-neutral
 * capability decisions.
 */

export type ClaudeTurnReconciliationMode = 'observe' | 'enforce_with_fallback' | 'enforce';

/** Structural subset of ClaudeTranscriptDiagnosticLog; keeps hashing salted per log instance. */
export interface ReconciliationDiagnosticsSink {
  record(event: TranscriptDiagnosticEvent): void;
  hashId(id: string): string;
}

export interface HostDispatchFact {
  /** Feature turnId that owns the channel lease for this dispatch. */
  leaseTurnId: string;
  /** Transcript UUID of the dequeued SDK user message ('' when absent). */
  canonicalTurnId: string;
  /** Lease owner first, merged aliases after. */
  hostTurnIds: string[];
}

export interface ObservedTurnStartFact {
  canonicalTurnId: string;
  lineOffset?: number;
  /** External origin kind (category only), when the row carried one. */
  sourceKind?: string;
}

export type TurnIdentityVerdict =
  | { kind: 'host_mirror'; canonicalTurnId: string }
  | { kind: 'external_new'; canonicalTurnId: string }
  | { kind: 'duplicate'; canonicalTurnId: string }
  | { kind: 'conflict'; canonicalTurnId: string };

export interface ReconciliationStats {
  eligibleHostTurns: number;
  matchedHostTurns: number;
  hostUnmatchedTurns: number;
  externalTurns: number;
  mirrorEventsDropped: number;
  identityConflicts: number;
}

/**
 * Result-frame echo fact (G1): the CLI's own account of which user uuids the
 * turn consumed. This is canonical-UUID evidence, not an order heuristic.
 */
export interface ResultEchoFact {
  /** Host turnId that owns the settling channel lease. */
  leaseTurnId: string;
  /** Consumed canonical uuids in consumption order (singular included). */
  consumedUuids: readonly string[];
  /** Echo context: pending user sends at result write time. Diagnostics only. */
  queuedTurnCount?: number;
  /** Echo context: result write index, never turn order. Diagnostics only. */
  resultIndex?: number;
}

/**
 * Read-only binding verdict. `bound` means the echo's canonical uuid is the
 * one this lease dispatched (or one of its merged aliases); `mismatch` means
 * the echo provably belongs to a different host turn (the G1 3-in-2-result
 * shape); `unbound` means the echo maps to no dispatched turn at all.
 */
export type ResultEchoVerdict =
  | { kind: 'bound'; leaseTurnId: string; canonicalTurnId: string }
  | { kind: 'mismatch'; leaseTurnId: string; echoedCanonicalTurnId: string }
  | { kind: 'unbound'; leaseTurnId: string };

export interface ResultEchoStats {
  consulted: number;
  bound: number;
  mismatch: number;
  unbound: number;
}

interface TurnRecord {
  canonicalTurnId: string;
  sessionGeneration: number;
  leaseTurnId: string;
  hostTurnIds: Set<string>;
  dispatchedAt: number;
  observed: boolean;
  hostOnlyFinalized: boolean;
}

export class ClaudeTurnReconciliationCoordinator {
  private sessionGeneration = 0;
  private readonly records = new Map<string, TurnRecord>();
  private readonly canonicalByHostTurnId = new Map<string, string>();
  private readonly stats: ReconciliationStats = {
    eligibleHostTurns: 0,
    matchedHostTurns: 0,
    hostUnmatchedTurns: 0,
    externalTurns: 0,
    mirrorEventsDropped: 0,
    identityConflicts: 0,
  };
  /** Separate from batch-1 stats: echo consultation must not perturb that denominator. */
  private readonly resultEchoStats: ResultEchoStats = {
    consulted: 0,
    bound: 0,
    mismatch: 0,
    unbound: 0,
  };

  constructor(
    private readonly mode: ClaudeTurnReconciliationMode = 'observe',
    private diagnostics: ReconciliationDiagnosticsSink | null = null,
  ) {}

  /** Late sink attachment: the runtime owns the diagnostic log's lifetime (vault path arrives lazily). */
  attachDiagnostics(diagnostics: ReconciliationDiagnosticsSink): void {
    this.diagnostics = diagnostics;
  }

  getMode(): ClaudeTurnReconciliationMode {
    return this.mode;
  }

  getStats(): ReconciliationStats {
    return { ...this.stats };
  }

  getResultEchoStats(): ResultEchoStats {
    return { ...this.resultEchoStats };
  }

  /**
   * reserved (§2.2): the factory minted a candidate UUID, but nothing proves
   * it reached disk until the channel dequeues it. Reserved candidates never
   * enter the eligible denominator.
   */
  recordReserved(hostTurnId: string, candidateTranscriptUuid: string): void {
    this.diagnostics?.record({
      phase: 'turn_identity_reserved',
      turnIdHash: this.diagnostics.hashId(candidateTranscriptUuid),
      generation: this.sessionGeneration,
      leaseKind: 'user',
    });
    // A reserved UUID with no dispatch yet cannot bind: keep it candidate-only
    // and let recordDispatched establish the mapping when the channel confirms.
    void hostTurnId;
  }

  /** dispatched (§2.2): the channel dequeued the item; the canonical UUID is now the binding key. */
  recordDispatched(fact: HostDispatchFact): void {
    if (!fact.canonicalTurnId) {
      this.diagnostics?.record({
        phase: 'turn_identity_dispatched',
        turnIdHash: this.diagnostics.hashId(fact.leaseTurnId),
        generation: this.sessionGeneration,
        leaseKind: 'user',
        reason: 'identity_missing',
        hostAliases: fact.hostTurnIds.length,
      });
      return;
    }

    const existing = this.records.get(fact.canonicalTurnId);
    if (existing) {
      const sameLease = existing.leaseTurnId === fact.leaseTurnId
        && fact.hostTurnIds.every(id => existing.hostTurnIds.has(id))
        && existing.hostTurnIds.size === fact.hostTurnIds.length;
      if (sameLease) {
        // Idempotent re-dispatch (e.g. crash-recovery replay of the same
        // message object): one eligible canonical turn, no double count.
        return;
      }
      this.recordConflict(fact.canonicalTurnId, 'canonical_rebind');
      return;
    }

    for (const hostTurnId of fact.hostTurnIds) {
      if (this.canonicalByHostTurnId.get(hostTurnId) !== undefined) {
        // Expected shape: a merged turn's crash replay re-enqueues the
        // owner-only lastSentMessage (the later writer's original UUID), so
        // an already-mapped host turn dispatches a different canonical UUID.
        // Tagged alias_remap so the promotion gate can separate it from real
        // identity corruption; batch 2 must add superseded semantics instead.
        this.recordConflict(fact.canonicalTurnId, 'alias_remap');
        return;
      }
    }

    const record: TurnRecord = {
      canonicalTurnId: fact.canonicalTurnId,
      sessionGeneration: this.sessionGeneration,
      leaseTurnId: fact.leaseTurnId,
      hostTurnIds: new Set(fact.hostTurnIds),
      dispatchedAt: Date.now(),
      observed: false,
      hostOnlyFinalized: false,
    };
    this.records.set(fact.canonicalTurnId, record);
    for (const hostTurnId of fact.hostTurnIds) {
      this.canonicalByHostTurnId.set(hostTurnId, fact.canonicalTurnId);
    }
    this.stats.eligibleHostTurns += 1;
    this.diagnostics?.record({
      phase: 'turn_identity_dispatched',
      turnIdHash: this.diagnostics.hashId(fact.canonicalTurnId),
      generation: this.sessionGeneration,
      leaseKind: 'user',
      hostAliases: fact.hostTurnIds.length,
    });
  }

  /**
   * Result-echo consultation (G1, batch-2 evidence path, still observe-safe).
   *
   * When the CLI result frame echoes the uuids the turn consumed, that
   * canonical evidence is the primary binding key — order/lease heuristics
   * are only the fallback for producers that carry no echo. This call is
   * read-only: it records a verdict and diagnostics and never mutates
   * settlement, leases or batch-1 statistics.
   */
  recordResultEcho(fact: ResultEchoFact): ResultEchoVerdict {
    this.resultEchoStats.consulted += 1;

    const leaseCanonical = this.canonicalByHostTurnId.get(fact.leaseTurnId);
    const leaseRecord = leaseCanonical === undefined ? undefined : this.records.get(leaseCanonical);

    let echoedRecord: TurnRecord | undefined;
    for (const uuid of fact.consumedUuids) {
      const record = this.records.get(uuid);
      if (!record) continue;
      if (leaseRecord !== undefined && record === leaseRecord) {
        echoedRecord = record;
        break;
      }
      if (echoedRecord === undefined) {
        echoedRecord = record;
      }
    }

    if (leaseRecord !== undefined && echoedRecord === leaseRecord) {
      this.resultEchoStats.bound += 1;
      this.recordResultEchoDiagnostic(leaseRecord.canonicalTurnId, 'bound', fact);
      return { kind: 'bound', leaseTurnId: fact.leaseTurnId, canonicalTurnId: leaseRecord.canonicalTurnId };
    }
    if (echoedRecord !== undefined) {
      this.resultEchoStats.mismatch += 1;
      this.recordResultEchoDiagnostic(echoedRecord.canonicalTurnId, 'mismatch', fact);
      return {
        kind: 'mismatch',
        leaseTurnId: fact.leaseTurnId,
        echoedCanonicalTurnId: echoedRecord.canonicalTurnId,
      };
    }
    this.resultEchoStats.unbound += 1;
    this.recordResultEchoDiagnostic(fact.leaseTurnId, 'unbound', fact);
    return { kind: 'unbound', leaseTurnId: fact.leaseTurnId };
  }

  /**
   * observed (§2.2): the transcript observer saw a user row with this UUID.
   * Returns the batch-1 verdict for the fact; observe mode keeps every
   * caller free to ignore it.
   */
  recordObservedStart(fact: ObservedTurnStartFact): TurnIdentityVerdict {
    const record = this.records.get(fact.canonicalTurnId);
    if (!record) {
      this.stats.externalTurns += 1;
      this.diagnostics?.record({
        phase: 'turn_identity_observer_only',
        turnIdHash: this.diagnostics.hashId(fact.canonicalTurnId),
        generation: this.sessionGeneration,
        ...(fact.sourceKind ? { sourceKind: fact.sourceKind } : {}),
        ...(fact.lineOffset !== undefined ? { offset: fact.lineOffset } : {}),
      });
      return { kind: 'external_new', canonicalTurnId: fact.canonicalTurnId };
    }
    if (record.observed) {
      this.diagnostics?.record({
        phase: 'turn_identity_duplicate',
        turnIdHash: this.diagnostics.hashId(fact.canonicalTurnId),
        generation: this.sessionGeneration,
      });
      return { kind: 'duplicate', canonicalTurnId: fact.canonicalTurnId };
    }

    record.observed = true;
    this.stats.matchedHostTurns += 1;
    this.diagnostics?.record({
      phase: 'turn_identity_matched',
      turnIdHash: this.diagnostics.hashId(fact.canonicalTurnId),
      generation: record.sessionGeneration,
      ...(fact.lineOffset !== undefined ? { offset: fact.lineOffset } : {}),
      elapsedMs: Date.now() - record.dispatchedAt,
    });
    return { kind: 'host_mirror', canonicalTurnId: fact.canonicalTurnId };
  }

  /**
   * The host turn reached terminal state. A still-unobserved binding is
   * finalized as host_only now (dispatch-to-settle windows dwarf the tail
   * reader poll, so an unobserved row at settle time is the unmatched
   * signal); a genuinely late observer row still reports host_mirror with a
   * large elapsedMs so offline reconciliation can see both events.
   */
  noteHostTurnSettled(hostTurnId: string): void {
    const canonicalTurnId = this.canonicalByHostTurnId.get(hostTurnId);
    if (canonicalTurnId === undefined) return;
    const record = this.records.get(canonicalTurnId);
    if (!record || record.observed || record.hostOnlyFinalized) return;

    record.hostOnlyFinalized = true;
    this.stats.hostUnmatchedTurns += 1;
    this.diagnostics?.record({
      phase: 'turn_identity_host_only',
      turnIdHash: this.diagnostics.hashId(canonicalTurnId),
      generation: record.sessionGeneration,
    });
  }

  /**
   * Session generation epoch (§2.4): switching or resetting the session
   * invalidates every live binding so late events from the old session can
   * never hit the new map. Counters stay cumulative for the reconciliation
   * window; only bindings are dropped.
   */
  advanceSessionGeneration(): void {
    this.sessionGeneration += 1;
    this.records.clear();
    this.canonicalByHostTurnId.clear();
  }

  private recordResultEchoDiagnostic(
    identity: string,
    outcome: 'bound' | 'mismatch' | 'unbound',
    fact: ResultEchoFact,
  ): void {
    this.diagnostics?.record({
      phase: 'turn_identity_result_echo',
      turnIdHash: this.diagnostics.hashId(identity),
      generation: this.sessionGeneration,
      leaseKind: 'user',
      echoOutcome: outcome,
      ...(fact.queuedTurnCount !== undefined ? { queuedTurnCount: fact.queuedTurnCount } : {}),
      ...(fact.resultIndex !== undefined ? { resultIndex: fact.resultIndex } : {}),
    });
  }

  private recordConflict(
    canonicalTurnId: string,
    reason: 'alias_remap' | 'canonical_rebind',
  ): void {
    this.stats.identityConflicts += 1;
    this.diagnostics?.record({
      phase: 'turn_identity_conflict',
      turnIdHash: this.diagnostics.hashId(canonicalTurnId),
      generation: this.sessionGeneration,
      reason,
    });
  }
}
