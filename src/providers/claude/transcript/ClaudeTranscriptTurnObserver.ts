import { open, stat } from 'fs/promises';

import type { HistoryTailStart } from '../../../core/providers/types';
import type {
  AutoTurnCancelledEvent,
  AutoTurnChunkEvent,
  AutoTurnFinishedEvent,
  AutoTurnStartedEvent,
} from '../../../core/runtime/types';
import type { ClaudeTailStartPayload } from '../history/sdkHistoryTypes';
import type { ObservedTurnStartFact } from '../runtime/ClaudeTurnReconciliationCoordinator';
import type { ClaudeTranscriptDiagnosticLog } from './ClaudeTranscriptDiagnosticLog';
import { adaptTranscriptFacts, type TranscriptTurnEvent } from './ClaudeTranscriptFactAdapter';
import { ClaudeTranscriptTailReader, type FileIdentity, type RecoveryAnchor, type RecoveryPrime, type TranscriptTailBatch } from './ClaudeTranscriptTailReader';
import { ClaudeTranscriptTurnMapper } from './ClaudeTranscriptTurnMapper';

const RECOVERY_BYTES = 4 * 1024 * 1024;
// Initial values conservatively exceed measured 1–16 ms callback ticks; calibrate from smoke-test percentiles.
const CALLBACK_CHUNK_TIMEOUT_MS = 1_000;
const QUIET_SETTLE_MS = 2_000;

export interface ClaudeTranscriptObserverCallbacks {
  started: (event: AutoTurnStartedEvent) => boolean;
  chunk: (event: AutoTurnChunkEvent) => Promise<void>;
  finished: (event: AutoTurnFinishedEvent) => Promise<void>;
  released: (turnId: string) => void;
  cancelled: (event: AutoTurnCancelledEvent) => void;
  projectEmbeddedExternal: (event: AutoTurnStartedEvent) => Promise<void>;
  /**
   * P0-1 result-late watchdog terminal signal: the transcript showed the
   * HOST user turn's terminal state (end_turn + stop-hook evidence, or a
   * manual compact_boundary) at this tick. Called with the live
   * hostUserTurnId; the runtime stamps the tick time onto the turn. The
   * optional evidence payload only rides the compact path (kind + CLI
   * version); stop_hook calls stay single-argument.
   */
  onHostTurnTerminalObserved: (turnId: string, evidence?: { kind: 'compact' | 'stop_hook'; cliVersion?: string }) => void;
  /**
   * Terminal-evidence retraction (2026-11-05 fix 1): strong continuation
   * proof arrived after a terminal fact was emitted for the live host turn.
   * The runtime un-stamps the terminal so the watchdog can re-arm on the
   * turn's NEW terminal; stale recovery attempts freeze out.
   */
  onHostTurnTerminalRetracted?: (turnId: string, reason: string) => void;
  /** Diagnostic-only CLI version from live transcript rows, including non-terminal hook-block turns. */
  onCliVersionObserved?: (version: string) => void;
}

/**
 * Read-only reconciliation bypass (turn identity, batch 1): the observer
 * forwards observed_start facts so the coordinator can match them against
 * dispatched host bindings. Verdicts flow back nowhere yet — observe mode
 * never changes observer behavior.
 */
export interface ClaudeTurnReconciliationSink {
  recordObservedStart(fact: ObservedTurnStartFact): unknown;
}

interface PendingTurn {
  started: AutoTurnStartedEvent;
  events: TranscriptTurnEvent[];
  promoted: boolean;
}

type ObserverAdmission = (batch: TranscriptTailBatch) => Promise<void> | null;

class ObserverTailReader extends ClaudeTranscriptTailReader {
  constructor(
    filePath: string,
    private readonly watcherErrorOwner: () => ((error: unknown) => void) | undefined,
  ) {
    super(filePath);
  }

  readOwned(admit: ObserverAdmission, isOwner: () => boolean) {
    return this.readWithAdmission(admit, isOwner);
  }

  primeOwned(anchor: RecoveryAnchor, isOwner: () => boolean): Promise<RecoveryPrime> {
    return this.primeFromRecovery(anchor, isOwner);
  }

  startOwned(admit: ObserverAdmission): void {
    // This internal callback also returns null when admission is refused.
    this.start(admit as (batch: TranscriptTailBatch) => Promise<void>);
  }

  protected override admitWatcherBatch(
    onBatch: (batch: TranscriptTailBatch) => void | Promise<void>,
    batch: TranscriptTailBatch,
  ): Promise<void> | null {
    try {
      const completion = onBatch(batch) as void | Promise<void> | null;
      return completion === null ? null : Promise.resolve(completion);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  protected override capturePollErrorOwner(): ((error: unknown) => void) | undefined {
    return this.watcherErrorOwner();
  }
}


/**
 * Provider-owned interpretation of the neutral tail-start shell (H/P8): the
 * Claude payload is the snapshot's source identity plus the committed
 * boundary. Anything the producer did not sign with the current
 * provider/protocol pair is a broken handoff, not a boundary to trust.
 */
function interpretTailStart(tailStart: HistoryTailStart): RecoveryAnchor {
  if (tailStart.provider !== 'claude' || tailStart.protocol !== 1) {
    throw new Error('Unsupported transcript tail-start descriptor');
  }
  const payload = tailStart.payload as ClaudeTailStartPayload | null;
  if (payload === null || typeof payload !== 'object'
    || !Number.isSafeInteger(payload.dev) || !Number.isSafeInteger(payload.ino)
    || !Number.isSafeInteger(payload.snapshotSize) || !Number.isSafeInteger(payload.committedOffset)) {
    throw new Error('Invalid transcript tail-start payload');
  }
  return { dev: payload.dev, ino: payload.ino, snapshotSize: payload.snapshotSize, offset: payload.committedOffset };
}

interface ObserverOwner {
  generation: number;
  reader: ObserverTailReader | null;
  mapper: ClaudeTranscriptTurnMapper;
  queue: PendingTurn[];
}

interface RecoveryScan {
  /** Same-handle identity of the bytes the scan actually read: the prime
   * must still resolve to this source before any recovery projection. */
  anchor: FileIdentity;
  /** Offset just past the last complete newline — the prime boundary. */
  tailOffset: number;
  /** Deferred replay admission for a scan that left the mapper with an open
   * turn; only projected after the prime verifies the source. */
  replayEvents: TranscriptTurnEvent[] | null;
}

export class ClaudeTranscriptTurnObserver {
  private reader: ObserverTailReader | null = null;
  private mapper = new ClaudeTranscriptTurnMapper();
  private generation = 0;
  private queue: PendingTurn[] = [];
  private active: PendingTurn | null = null;
  private embeddedQueue: AutoTurnStartedEvent[] = [];
  private hostUserTurnId: string | null = null;
  private hostProjection: object | null = null;
  private readonly hostUserTranscriptIds = new Set<string>();
  private lastHostUserOffset: number | null = null;
  /**
   * REAL dispatch description of the live host turn (2026-11-05 fix 3):
   * stamped by the channel at dequeue delivery, NOT by the feature layer's
   * beginUserTurnProjection (which can await projection leases long before
   * the message reaches the CLI). Compact boundary facts attribute by
   * timestamp against dispatchedAt; host-row matching is limited to the
   * dispatch's canonical UUID. Null until the dispatch lands ("unsent").
   */
  private hostDispatch: { leaseTurnId: string; canonicalUuid: string; hostTurnIds: string[]; dispatchedAt: number; isManualCompact: boolean } | null = null;
  /** The live host turn's own user row has been observed on the transcript.
   * Terminal facts may only be attributed to a turn whose row is already on
   * disk — the previous turn's trailing rows can still flush after the
   * hostUserTurnId already switched to the freshly dispatched turn. */
  private hostUserRowObserved = false;
  /** 2.5.1 残余 a: host user turn was cancelled — CLI interrupt already
   * killed the pipeline, so turns promoting after the cancel can never see
   * their result line and must be settled deterministically. */
  private hostCancelled = false;
  private consumeChain: Promise<void> = Promise.resolve();
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private readonly callbacks: ClaudeTranscriptObserverCallbacks,
    private readonly canAcquire: () => boolean,
    private readonly diagnostics?: ClaudeTranscriptDiagnosticLog,
    private readonly reconciliation?: ClaudeTurnReconciliationSink,
  ) {}

  private owner(generation = this.generation): ObserverOwner {
    return { generation, reader: this.reader, mapper: this.mapper, queue: this.queue };
  }

  private owns(owner: ObserverOwner): boolean {
    return !this.stopped && this.generation === owner.generation && this.reader === owner.reader
      && this.mapper === owner.mapper && this.queue === owner.queue;
  }

  async start(filePath: string, tailStart?: HistoryTailStart): Promise<void> {
    const previousGeneration = this.generation;
    this.stop('session_switch');
    // A cancellation callback may synchronously start a newer observer.
    if (this.generation !== previousGeneration + 1) return;
    this.stopped = false;
    this.hostCancelled = false;
    const generation = ++this.generation;
    this.mapper.reset(generation);
    const reader = new ObserverTailReader(filePath, () => {
      const errorOwner = this.owner();
      return error => {
        this.diagnostics?.record({
          phase: 'callback_error',
          generation: errorOwner.generation,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      };
    });
    this.reader = reader;
    const owner = this.owner(generation);
    // A supplied tail-start descriptor is the H/P8 handoff: the boundary was
    // observed on a specific source, and the prime re-verifies that source's
    // identity before anything projects. Without one, the recovery scan owns
    // the boundary and its source must survive the prime handshake before
    // anything projects.
    if (tailStart === undefined) {
      const scan = await this.recover(filePath, owner);
      if (!this.owns(owner)) return;
      await this.admitRecovery(reader, scan, owner);
      return;
    }
    await this.admitTailStart(reader, interpretTailStart(tailStart), owner);
  }

  /**
   * Completes the index tail-start handshake (H/P8): prime at the snapshot's
   * committed boundary, but only after the primed source proves it is still
   * the file the snapshot observed. A replaced source rejects the start
   * explicitly — the identity denial is approved correctness; retry, rebuild,
   * or auto-wait policies stay reserved and nothing here implements one. A
   * vanished source is unverifiable: no polling begins, re-establishment
   * rides the next explicit start (the recovery-handshake posture).
   */
  private async admitTailStart(reader: ObserverTailReader, anchor: RecoveryAnchor, owner: ObserverOwner): Promise<void> {
    const result = await reader.primeOwned(anchor, () => this.owns(owner));
    if (!this.owns(owner)) return;
    if (result.status === 'failed') throw result.error;
    if (result.status === 'source-changed') {
      // The denial is the correctness completion; the diagnostic makes the
      // otherwise-invisible restart-loop cause auditable.
      this.diagnostics?.record({ phase: 'prime_rejected', reason: 'source_changed', generation: owner.generation });
      throw new Error('Transcript source changed between index snapshot and observer priming');
    }
    // stale: ownership already lost; missing: the source vanished and its
    // identity is unverifiable. Both stay silent — no polling begins.
    if (result.status !== 'ready') {
      this.diagnostics?.record({
        phase: 'prime_rejected',
        reason: result.status === 'missing' ? 'missing' : 'stale',
        generation: owner.generation,
      });
      return;
    }
    reader.startOwned(batch => this.admitBatch(owner, batch));
  }

  /**
   * Completes the recovery handshake: prime at the scan's boundary, verify
   * the primed source is the one the scan read, and only then admit the
   * deferred replay and begin polling. A replacement between the scan and
   * the prime rejects the recovery — the identity denial itself is approved
   * correctness completion; what happens next (retry, rebuild, wait) is a
   * reserved policy and nothing here implements one. A source that vanished
   * mid-handshake is unverifiable: no replay is admitted and polling never
   * begins; re-establishment rides the next explicit start. A scan that
   * found the file already missing keeps the historical wait-for-file
   * posture (prime without a boundary, poll until the transcript appears).
   */
  private async admitRecovery(reader: ObserverTailReader, scan: RecoveryScan | null, owner: ObserverOwner): Promise<void> {
    if (scan === null) {
      await reader.prime(undefined);
      if (!this.owns(owner)) return;
      reader.startOwned(batch => this.admitBatch(owner, batch));
      return;
    }
    await reader.prime(scan.tailOffset);
    if (!this.owns(owner)) return;
    const identity = reader.sourceIdentity();
    if (identity === null || identity.dev !== scan.anchor.dev || identity.ino !== scan.anchor.ino) {
      if (identity === null) {
        this.diagnostics?.record({ phase: 'prime_rejected', reason: 'identity_missing', generation: owner.generation });
        return;
      }
      this.diagnostics?.record({ phase: 'prime_rejected', reason: 'source_changed', generation: owner.generation });
      throw new Error('Transcript source changed between recovery scanning and priming');
    }
    if (scan.replayEvents) {
      for (const event of scan.replayEvents) this.enqueue(event);
      await this.promote(owner);
      if (!this.owns(owner)) return;
    }
    reader.startOwned(batch => this.admitBatch(owner, batch));
  }

  stop(reason = 'observer_stopped'): void {
    const active = this.active;
    this.stopped = true;
    this.generation += 1;
    this.reader?.stop();
    this.reader = null;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.active = null;
    this.queue = [];
    this.embeddedQueue = [];
    this.hostUserTurnId = null;
    this.hostProjection = null;
    this.hostUserTranscriptIds.clear();
    this.lastHostUserOffset = null;
    this.hostUserRowObserved = false;
    this.hostDispatch = null;
    this.mapper.reset(this.generation);
    if (active) this.cancelPending(active, reason);
  }

  registerHostUserTranscriptId(transcriptUserId: string): void {
    this.hostUserTranscriptIds.add(transcriptUserId);
  }

  /**
   * The channel dequeued a host input onto the CLI transport (fix 3): the
   * REAL dispatch anchor. Feature-begin timestamps are "unsent" until this
   * lands. A descriptor whose turn ids cover the live hostUserTurnId binds
   * to it; one from a foreign turn replaces the stale anchor only when the
   * live turn switched past it.
   */
  observeDispatch(descriptor: { leaseTurnId: string; canonicalUuid: string; hostTurnIds: string[]; dispatchedAt: number; isManualCompact: boolean }): void {
    const liveTurn = this.hostUserTurnId;
    const belongsToLiveTurn = liveTurn !== null
      && (descriptor.leaseTurnId === liveTurn || descriptor.hostTurnIds.includes(liveTurn));
    if (liveTurn !== null && !belongsToLiveTurn) {
      // Dispatch of a turn that is not the live host projection (merged
      // queue members report through their canonical lease owner): keep the
      // anchor only when it belongs; a foreign dispatch is ignored.
      return;
    }
    this.hostDispatch = descriptor;
    // Host-row matching is limited to the CURRENT dispatch: its canonical
    // UUID is the only row that can land for it — a new dispatch retires
    // every row identity registered for earlier turns (residue defense).
    this.hostUserTranscriptIds.clear();
    this.hostUserTranscriptIds.add(descriptor.canonicalUuid);
  }

  /** The dispatch descriptor the observer currently anchors on (rebuild restore). */
  currentDispatch(): { leaseTurnId: string; canonicalUuid: string; hostTurnIds: string[]; dispatchedAt: number; isManualCompact: boolean } | null {
    return this.hostDispatch;
  }

  beginUserTurnProjection(turnId: string): void {
    const previousDispatch = this.hostDispatch;
    const carriesTurn = previousDispatch !== null
      && (previousDispatch.leaseTurnId === turnId || previousDispatch.hostTurnIds.includes(turnId));
    // A new host user turn is live CLI work: a previous cancel no longer
    // constrains turns that promote behind it.
    this.hostCancelled = false;
    if (!carriesTurn) {
      // The new turn is UNSENT: the previous turn's dispatch anchor no longer
      // applies. Registered row identities stay until this turn's dispatch
      // replaces them (enqueue-time registrations precede that dispatch).
      this.hostDispatch = null;
    }
    this.hostUserTurnId = turnId;
    this.hostProjection = {};
    // Reviewer #1 cross-turn residue: this turn switch is the authoritative
    // reset point for host terminal attribution. Any unconfirmed candidate
    // belongs to the previous turn (queue release required its settlement),
    // and this turn's terminal rows can only land after its own user row —
    // which has not been observed yet.
    this.mapper.clearHostTerminalCandidate();
    this.hostUserRowObserved = false;
  }

  private admitBatch(owner: ObserverOwner, batch: TranscriptTailBatch): Promise<void> | null {
    if (!this.owns(owner)) return null;
    if (!batch.reset && batch.lines.length === 0) return Promise.resolve();
    return this.enqueueConsume(owner, () => this.consumeBatch(batch, owner.generation, true, owner));
  }

  async completeUserTurnProjection(turnId: string): Promise<void> {
    if (this.hostUserTurnId !== turnId) return;
    const owner = this.owner();
    const hostProjection = this.hostProjection;
    const reader = owner.reader;
    if (!reader) return;
    // Read outside the consumer FIFO; admission only registers work on it.
    const admission = await reader.readOwned(batch => {
      if (!this.owns(owner)) return null;
      return this.enqueueTask(async () => {
        if (this.owns(owner)) await this.consumeBatch(batch, owner.generation, false, owner);
        await this.settleCapturedHost(owner, turnId, hostProjection);
      });
    }, () => this.owns(owner));
    if (!admission.accepted) {
      // A source reset can invalidate the read without invalidating its host token.
      await this.enqueueTask(() => this.settleCapturedHost(owner, turnId, hostProjection));
      return;
    }
    await admission.completion;
  }

  private async settleCapturedHost(owner: ObserverOwner, turnId: string, hostProjection: object | null): Promise<void> {
    if (this.hostUserTurnId !== turnId || this.hostProjection !== hostProjection) return;
    this.hostUserTurnId = null;
    if (!this.owns(owner)) {
      this.hostProjection = null;
      const currentOwner = this.owner();
      if (this.owns(currentOwner)) await this.promote(currentOwner);
      return;
    }
    const embedded = this.embeddedQueue.splice(0);
    for (const event of embedded) {
      if (!this.owns(owner)) return;
      await this.callbacks.projectEmbeddedExternal(event);
      if (!this.owns(owner)) return;
    }
    if (this.hostProjection === hostProjection) this.hostProjection = null;
    await this.promote(owner);
  }

  private enqueueTask(task: () => Promise<void>): Promise<void> {
    const next = this.consumeChain.then(task, task);
    this.consumeChain = next.catch(() => {});
    return next;
  }

  private enqueueConsume(owner: ObserverOwner, task: () => Promise<void>): Promise<void> {
    return this.enqueueTask(() => this.owns(owner) ? task() : Promise.resolve());
  }

  private async consumeBatch(batch: TranscriptTailBatch, generation: number, promote = true, owner = this.owner(generation)): Promise<void> {
    if (!this.owns(owner)) return;
    const startedAt = Date.now();
    this.diagnostics?.record({ phase: 'tick_start', generation, batchBytes: batch.bytesRead, batchLines: batch.lines.length });
    if (batch.reset) {
      this.mapper.reset(++this.generation);
      const nextGeneration = this.generation;
      const reader = owner.reader;
      reader?.stop();
      // Drop the replaced file's FIFO and embedded work before reentrant callbacks.
      this.queue = [];
      this.embeddedQueue = [];
      const nextOwner = this.owner(nextGeneration);
      this.abandonActiveTurn('transcript_replaced', nextOwner);
      if (!this.owns(nextOwner) || !reader) return;
      const scan = await this.recover(reader.filePath, nextOwner);
      if (!this.owns(nextOwner)) return;
      await this.admitRecovery(reader, scan, nextOwner);
      return;
    }
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    for (let index = 0; index < batch.lines.length; index += 1) {
      const line = batch.lines[index];
      const lineOffset = batch.lineOffsets?.[index];
      if (this.callbacks.onCliVersionObserved) {
        try {
          const row = JSON.parse(line) as { version?: unknown };
          if (typeof row.version === 'string') this.callbacks.onCliVersionObserved(row.version);
        } catch {
          // Version telemetry never affects mapping or ownership.
        }
      }
      if (!this.owns(owner)) return;
      this.observeHostUserRow(line, lineOffset);
      const facts = owner.mapper.mapLine(line, false, {
        hostUserTurnActive: this.hostUserTurnId !== null,
        lineOffset,
      });
      this.reportObservedStarts(facts, owner);
      if (!this.owns(owner)) return;
      this.reportHostTerminal(facts, owner);
      if (!this.owns(owner)) return;
      for (const event of adaptTranscriptFacts(facts, { hostUserTurnActive: this.hostUserTurnId !== null })) {
        this.diagnostics?.record({ phase: 'map', generation, turnIdHash: this.diagnostics.hashId(event.event.turnId) });
        this.enqueue(event);
      }
    }
    if (this.mapper.hasTerminalCandidate()) {
      this.quietTimer = setTimeout(() => {
        void this.enqueueConsume(owner, () => this.settleQuietCandidate(generation, owner));
      }, QUIET_SETTLE_MS);
    }
    if (promote) await this.promote(owner);
    if (!this.owns(owner)) return;
    await this.drainActive(owner);
    if (!this.owns(owner)) return;
    this.diagnostics?.record({ phase: 'tick_end', generation, batchBytes: batch.bytesRead, batchLines: batch.lines.length, elapsedMs: Date.now() - startedAt });
  }

  private observeHostUserRow(line: string, lineOffset?: number): void {
    if (lineOffset === undefined || this.hostUserTranscriptIds.size === 0) return;
    try {
      const message = JSON.parse(line) as { type?: string; uuid?: string };
      if (message.type !== 'user' || !message.uuid || !this.hostUserTranscriptIds.delete(message.uuid)) return;
      this.lastHostUserOffset = lineOffset;
      this.hostUserRowObserved = true;
    } catch {
      // Malformed transcript rows cannot establish causal ownership.
    }
  }

  /**
   * Read-only bypass: live (non-replay) observed_start facts feed the
   * reconciliation coordinator. Recovery replays stay out — cross-generation
   * re-binding is a batch-2 concern and must never happen silently here.
   */
  private reportObservedStarts(facts: ReturnType<ClaudeTranscriptTurnMapper['mapLine']>, owner: ObserverOwner): void {
    if (!this.reconciliation) return;
    for (const fact of facts) {
      if (!this.owns(owner)) return;
      if (fact.type !== 'observed_start' || fact.replay) continue;
      try {
        this.reconciliation.recordObservedStart({
          canonicalTurnId: fact.identity.canonicalTurnId,
          ...(fact.lineOffset !== undefined ? { lineOffset: fact.lineOffset } : {}),
          ...(fact.source ? { sourceKind: fact.source.kind } : {}),
        });
      } catch {
        // The bypass must never disturb the consume chain.
      }
    }
  }

  /**
   * P0-1 read-only bypass: host-terminal facts notify the runtime with the
   * live hostUserTurnId so the result-late watchdog can arm. Replay facts
   * stay out (recovery scans past turns, never the live host wait). Isolated
   * like the reconciliation bypass — never disturbs the consume chain.
   *
   * Attribution guards (reviewer #1): the fact only belongs to the live
   * hostUserTurnId when that turn's own user row is already observed AND the
   * terminal row lies past it in the transcript. The previous turn's
   * end_turn/stop_hook_summary can still flush after the hostUserTurnId has
   * already switched (release → queue pump dispatches the next message within
   * milliseconds); those rows precede the new user row and must never stamp
   * the new turn's transcriptTerminalSeenAt.
   */
  private reportHostTerminal(facts: ReturnType<ClaudeTranscriptTurnMapper['mapLine']>, owner: ObserverOwner): void {
    for (const fact of facts) {
      if (!this.owns(owner)) return;
      if (fact.type === 'observed_host_terminal_retracted') {
        if (fact.replay) continue;
        const hostTurnId = this.hostUserTurnId;
        if (!hostTurnId) continue;
        try {
          this.callbacks.onHostTurnTerminalRetracted?.(hostTurnId, fact.reason);
        } catch {
          // The bypass must never disturb the consume chain.
        }
        continue;
      }
      if (fact.type !== 'observed_host_terminal' || fact.replay) continue;
      const hostTurnId = this.hostUserTurnId;
      if (!hostTurnId) continue;
      if (fact.terminalSource === 'compact') {
        // Compact attribution (fix 3, five conditions): live non-replay ✓,
        // the current host matches the dispatch description, the FINAL sent
        // payload is a manual /compact, the boundary trigger is manual, and
        // the boundary row timestamp postdates the REAL dispatch. The
        // boundary lands before the host's own buffered /compact row, so the
        // stop_hook defenses (rowObserved, offset) would drop it; a
        // mismatch on any condition degrades to no stamp — never a false
        // positive. Feature-begin timestamps never stand in for dispatchedAt.
        const dispatch = this.hostDispatch;
        if (dispatch === null || !fact.rowTimestamp || fact.rowTimestamp <= dispatch.dispatchedAt) continue;
        if (!dispatch.isManualCompact) continue;
        if (dispatch.leaseTurnId !== hostTurnId && !dispatch.hostTurnIds.includes(hostTurnId)) continue;
        try {
          this.callbacks.onHostTurnTerminalObserved(hostTurnId, {
            kind: 'compact',
            ...(fact.cliVersion !== undefined ? { cliVersion: fact.cliVersion } : {}),
          });
        } catch {
          // The bypass must never disturb the consume chain.
        }
        continue;
      }
      if (!this.hostUserRowObserved) continue;
      // Offset attribution when both anchors are known (live rows). A
      // recovery-claimed row (mid-turn observer restart) has no live offset:
      // every row the live reader can still deliver sits past the replayed
      // boundary, so the observed flag alone attributes correctly there.
      if (fact.lineOffset !== undefined && this.lastHostUserOffset !== null && fact.lineOffset <= this.lastHostUserOffset) continue;
      try {
        this.callbacks.onHostTurnTerminalObserved(hostTurnId);
      } catch {
        // The bypass must never disturb the consume chain.
      }
    }
  }

  private enqueue(event: TranscriptTurnEvent): void {
    if (event.type === 'embedded') {
      if (!this.embeddedQueue.some(item => item.transcriptUserId === event.event.transcriptUserId)) {
        this.embeddedQueue.push(event.event);
      }
      return;
    }
    if (event.type === 'started') {
      const pending = { started: event.event, events: [], promoted: false };
      this.queue.push(pending);
      return;
    }
    if (event.type === 'interrupted') {
      const pending = this.active?.started.turnId === event.event.turnId
        ? this.active
        : this.queue.find(item => item.started.turnId === event.event.turnId);
      if (pending) pending.events.push(event);
      return;
    }
    const turnId = event.event.turnId;
    const pending = this.active?.started.turnId === turnId
      ? this.active
      : this.queue.find(item => item.started.turnId === turnId);
    pending?.events.push(event);
  }

  /**
   * Terminates the promoted turn without an end marker (stop, transcript
   * replaced). Flagged `interrupted` so the projection never reports the
   * turn as completed (v6 §4.3).
   */
  private cancelPending(pending: PendingTurn, reason: string): void {
    this.callbacks.cancelled({
      turnId: pending.started.turnId,
      generation: pending.started.generation + 1,
      reason,
      interrupted: true,
    });
  }

  private abandonActiveTurn(reason: string, owner: ObserverOwner): void {
    const pending = this.active;
    if (!pending || !this.owns(owner)) return;
    this.active = null;
    this.cancelPending(pending, reason);
  }

  /**
   * 2.5.1 F3 + 残余 a: user-cancel hook. The CLI's trailing result line is
   * not a reliable settlement signal after an interrupt — the SDK ignores
   * interrupt while blocked on canUseTool, and an abandoned turn may never
   * run at all (2026-09-17 18:22 ghost lease). Settle the promoted turn here
   * so the feature auto lease finishes exactly once; a late transcript result
   * for the same turn finds no pending record and is dropped. The latch also
   * covers the promote-after-cancel race: at ESC time the dead turn may still
   * sit in the FIFO (started() rejected and re-queued behind the user turn),
   * so the cancel is latched and every turn promoting later is settled in
   * promote() after draining its buffered content.
   */
  interruptActiveTurn(reason: string): void {
    this.hostCancelled = true;
    const owner = this.owner();
    if (!this.active || !this.owns(owner)) return;
    const turnId = this.active.started.turnId;
    this.abandonActiveTurn(reason, owner);
    if (this.owns(owner) && !this.active) this.callbacks.released(turnId);
  }

  private async promote(owner: ObserverOwner): Promise<void> {
    if (!this.owns(owner) || this.active || !this.canAcquire() || !this.owns(owner)) return;
    const pending = owner.queue.shift();
    if (!pending) return;
    this.active = pending;
    pending.promoted = true;
    const accepted = this.callbacks.started(pending.started);
    if (!this.owns(owner) || this.active !== pending) return;
    if (!accepted) {
      this.active = null;
      owner.queue.unshift(pending);
      return;
    }
    await this.drainActive(owner);
    // A cancelled host cannot produce the pending turn's result line.
    if (this.owns(owner) && this.active === pending && this.hostCancelled) {
      const turnId = pending.started.turnId;
      this.abandonActiveTurn('user_cancel', owner);
      if (!this.owns(owner) || this.active) return;
      this.callbacks.released(turnId);
      if (!this.owns(owner)) return;
      await this.promote(owner);
    }
  }

  private async drainActive(owner: ObserverOwner): Promise<void> {
    const pending = this.active;
    if (!pending || !this.owns(owner)) return;
    try {
      while (pending.events.length > 0 && this.owns(owner) && this.active === pending) {
        const event = pending.events.shift()!;
        if (event.type === 'chunk') {
          await this.withTimeout(this.callbacks.chunk(event.event), CALLBACK_CHUNK_TIMEOUT_MS, 'chunk_timeout');
          if (!this.owns(owner) || this.active !== pending) return;
        }
        if (event.type === 'interrupted') {
          this.active = null;
          this.callbacks.cancelled(event.event);
          if (!this.owns(owner) || this.active) return;
          this.callbacks.released(event.event.turnId);
          if (!this.owns(owner)) return;
          await this.promote(owner);
        }
        if (event.type === 'finished') {
          const terminalOffset = event.event.terminalOffset;
          await this.callbacks.finished({
            ...event.event,
            supersededByHostUser: terminalOffset !== undefined
              && this.lastHostUserOffset !== null
              && this.lastHostUserOffset > terminalOffset,
          });
          if (!this.owns(owner) || this.active !== pending) return;
          this.active = null;
          this.callbacks.released(event.event.turnId);
          if (!this.owns(owner)) return;
          await this.promote(owner);
        }
      }
    } catch (error) {
      if (this.owns(owner) && this.active === pending) {
        this.diagnostics?.record({ phase: 'callback_error', generation: pending.started.generation, turnIdHash: this.diagnostics.hashId(pending.started.turnId), errorName: error instanceof Error ? error.name : 'UnknownError' });
        this.abandonActiveTurn(error instanceof Error ? error.message : 'callback_error', owner);
        if (!this.owns(owner) || this.active) throw error;
        this.callbacks.released(pending.started.turnId);
        if (!this.owns(owner)) throw error;
        await this.promote(owner);
      }
      // Compensation does not turn an accepted consumption failure into success.
      throw error;
    }
  }

  private async settleQuietCandidate(generation: number, owner = this.owner(generation)): Promise<void> {
    if (!this.owns(owner)) return;
    // This settle may be the timer callback itself, but also a direct call
    // (tests, future callers) while the timer is still pending: drop the
    // handle instead of orphaning it — an orphaned timeout fires long after
    // the observer is done and keeps the process alive.
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    const facts = owner.mapper.settleTerminalCandidate();
    this.reportHostTerminal(facts, owner);
    if (!this.owns(owner)) return;
    for (const event of adaptTranscriptFacts(facts, { hostUserTurnActive: this.hostUserTurnId !== null })) this.enqueue(event);
    await this.promote(owner);
    if (!this.owns(owner)) return;
    await this.drainActive(owner);
  }

  private async withTimeout(promise: Promise<void>, timeoutMs: number, reason: string): Promise<void> {
    void promise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Bounded recovery scan (v6 §4.3). Returns the offset just past the last
   * complete newline the scan observed plus the same-handle identity of what
   * was read, so the caller can prime from that boundary and verify the
   * source without a second stat racing past it; null when the file could
   * not be read. Priming at the observed EOF instead would orphan the bytes
   * of a mid-write tail line (flushed without its newline yet): the writer's
   * completion bytes would then parse as a standalone line and the whole
   * line's events would be lost. Newline search stays on the Buffer so the
   * offset is a byte offset even with multi-byte content.
   */
  private async recover(filePath: string, owner: ObserverOwner): Promise<RecoveryScan | null> {
    let info;
    try {
      info = await stat(filePath);
    } catch {
      return null;
    }
    if (!this.owns(owner)) return null;
    const start = Math.max(0, info.size - RECOVERY_BYTES);
    const handle = await open(filePath, 'r');
    let buffer: Buffer;
    let anchor: FileIdentity;
    try {
      if (!this.owns(owner)) return null;
      // Same-handle anchor: the identity must describe the bytes this scan
      // actually reads. A replacement landing between the path stat and the
      // open changes what is read but never fakes a verified source, because
      // the prime later compares against this handle's identity.
      const anchorInfo = await handle.stat();
      anchor = { dev: anchorInfo.dev, ino: anchorInfo.ino };
      const allocated = Buffer.alloc(info.size - start);
      const { bytesRead } = await handle.read(allocated, 0, allocated.length, start);
      if (!this.owns(owner)) return null;
      buffer = allocated.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (!this.owns(owner)) return null;
    let textStart = start;
    if (start > 0) {
      const headNewline = buffer.indexOf(0x0a);
      if (headNewline >= 0) {
        textStart = start + headNewline + 1;
        buffer = buffer.subarray(headNewline + 1);
      }
    }
    const lastNewline = buffer.lastIndexOf(0x0a);
    const tailOffset = lastNewline >= 0 ? textStart + lastNewline + 1 : textStart;
    // Only complete lines feed the shadow scan: a tail line without its
    // newline may still be mid-write — including the whole file when no
    // newline exists at all — so it is left to the tail reader to re-read as
    // a partial buffer once the writer finishes it.
    const text = lastNewline >= 0 ? buffer.subarray(0, lastNewline).toString('utf8') : '';
    const lines = text.split('\n').filter(Boolean);
    let boundary = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]);
        if (parsed.type === 'user' && parsed.origin && parsed.shouldQuery !== false) {
          boundary = index;
          break;
        }
      } catch {
        // Ignore malformed recovery lines.
      }
    }
    if (boundary < 0 || !this.owns(owner)) return { anchor, tailOffset, replayEvents: null };
    // Replay maps onto this.mapper (reset to this generation by the caller),
    // not a throwaway instance: the tail line left unprimed belongs to the
    // replayed open turn, so when the writer finishes it the live mapper must
    // still hold that turn's context to attach its events. The synchronous
    // map block runs after the generation check, so a concurrent stop() can
    // never observe a half-mapped mapper. The projection itself stays
    // deferred: the caller admits it only after the prime verifies the
    // scanned source is still live — replaying past a replaced file would
    // project rows the new source never wrote.
    const shadow = owner.mapper;
    const facts = lines.slice(boundary).flatMap(line => shadow.mapLine(line, true));
    facts.push(...shadow.settleTerminalCandidate(true));
    // Replay context must mirror the mapper default (hostUserTurnActive =
    // false), not the live host state: transcript-replaced recovery does not
    // clear hostUserTurnId, and a live-true context would divert the replayed
    // external start into `embedded` while the mapper already opened its
    // active turn — the buffered chunks would find no pending record and the
    // turn's content would be silently dropped without ever settling.
    const events = adaptTranscriptFacts(facts, { hostUserTurnActive: false });
    return { anchor, tailOffset, replayEvents: shadow.hasOpenTurn() ? events : null };
  }
}
