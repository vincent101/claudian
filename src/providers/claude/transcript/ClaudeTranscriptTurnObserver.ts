import { open, stat } from 'fs/promises';

import type {
  AutoTurnCancelledEvent,
  AutoTurnChunkEvent,
  AutoTurnFinishedEvent,
  AutoTurnStartedEvent,
} from '../../../core/runtime/types';
import type { ObservedTurnStartFact } from '../runtime/ClaudeTurnReconciliationCoordinator';
import type { ClaudeTranscriptDiagnosticLog } from './ClaudeTranscriptDiagnosticLog';
import { adaptTranscriptFacts, type TranscriptTurnEvent } from './ClaudeTranscriptFactAdapter';
import { ClaudeTranscriptTailReader, type TranscriptTailBatch } from './ClaudeTranscriptTailReader';
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

export class ClaudeTranscriptTurnObserver {
  private reader: ClaudeTranscriptTailReader | null = null;
  private mapper = new ClaudeTranscriptTurnMapper();
  private generation = 0;
  private queue: PendingTurn[] = [];
  private active: PendingTurn | null = null;
  private embeddedQueue: AutoTurnStartedEvent[] = [];
  private hostUserTurnId: string | null = null;
  private readonly hostUserTranscriptIds = new Set<string>();
  private lastHostUserOffset: number | null = null;
  /** Wall clock of the live host turn's dispatch (beginUserTurnProjection) —
   * compact boundary facts attribute by timestamp against this anchor, not by
   * line offset (the boundary physically precedes the buffered /compact row). */
  private hostUserTurnDispatchedAt: number | null = null;
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

  async start(filePath: string, fromOffset?: number): Promise<void> {
    this.stop('session_switch');
    this.stopped = false;
    this.hostCancelled = false;
    const generation = ++this.generation;
    this.mapper.reset(generation);
    this.reader = new ClaudeTranscriptTailReader(filePath, undefined, undefined, error => {
      this.diagnostics?.record({
        phase: 'callback_error',
        generation: this.generation,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    const recoverEof = fromOffset === undefined
      ? await this.recover(filePath, generation)
      : fromOffset;
    if (this.stopped || generation !== this.generation || !this.reader) return;
    // A supplied boundary is the index snapshot EOF; otherwise retain the
    // recovery scan's last-complete-newline offset so neither path races a
    // second stat.
    await this.reader.prime(recoverEof ?? undefined);
    this.reader.start(batch => this.enqueueConsume(() => this.consumeBatch(batch, generation)));
  }

  stop(reason = 'observer_stopped'): void {
    this.stopped = true;
    this.generation += 1;
    this.reader?.stop();
    this.reader = null;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.abandonActiveTurn(reason);
    this.queue = [];
    this.embeddedQueue = [];
    this.hostUserTurnId = null;
    this.hostUserTranscriptIds.clear();
    this.lastHostUserOffset = null;
    this.hostUserRowObserved = false;
    this.hostUserTurnDispatchedAt = null;
    this.mapper.reset(this.generation);
  }

  registerHostUserTranscriptId(transcriptUserId: string): void {
    this.hostUserTranscriptIds.add(transcriptUserId);
  }

  beginUserTurnProjection(turnId: string): void {
    this.hostUserTurnId = turnId;
    this.hostUserTurnDispatchedAt = Date.now();
    // A new host user turn is live CLI work: a previous cancel no longer
    // constrains turns that promote behind it.
    this.hostCancelled = false;
    // Reviewer #1 cross-turn residue: this turn switch is the authoritative
    // reset point for host terminal attribution. Any unconfirmed candidate
    // belongs to the previous turn (queue release required its settlement),
    // and this turn's terminal rows can only land after its own user row —
    // which has not been observed yet.
    this.mapper.clearHostTerminalCandidate();
    this.hostUserRowObserved = false;
  }

  async completeUserTurnProjection(turnId: string): Promise<void> {
    if (this.hostUserTurnId !== turnId) return;
    await this.enqueueConsume(async () => {
      if (this.hostUserTurnId !== turnId) return;
      const batch = await this.reader?.readAvailable();
      if (batch) await this.consumeBatch(batch, this.generation, false);
      if (this.hostUserTurnId !== turnId) return;
      this.hostUserTurnId = null;
      const embedded = this.embeddedQueue.splice(0);
      for (const event of embedded) await this.callbacks.projectEmbeddedExternal(event);
      await this.promote();
    });
  }

  private enqueueConsume(task: () => Promise<void>): Promise<void> {
    const next = this.consumeChain.then(task, task);
    this.consumeChain = next.catch(() => {});
    return next;
  }

  private async consumeBatch(batch: TranscriptTailBatch, generation: number, promote = true): Promise<void> {
    if (generation !== this.generation || this.stopped) return;
    const startedAt = Date.now();
    this.diagnostics?.record({ phase: 'tick_start', generation, batchBytes: batch.bytesRead, batchLines: batch.lines.length });
    if (batch.reset) {
      this.mapper.reset(++this.generation);
      const nextGeneration = this.generation;
      this.reader?.stop();
      // The replaced file's pending turns can never see their end marker:
      // drop the whole FIFO (v6 §4.3) instead of promoting stale turns onto
      // the new file's projection.
      this.abandonActiveTurn('transcript_replaced');
      this.queue = [];
      if (this.reader) {
        const recoverEof = await this.recover(this.reader.filePath, nextGeneration);
        await this.reader.prime(recoverEof ?? undefined);
        this.reader.start(next => this.enqueueConsume(() => this.consumeBatch(next, nextGeneration)));
      }
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
      this.observeHostUserRow(line, lineOffset);
      const facts = this.mapper.mapLine(line, false, {
        hostUserTurnActive: this.hostUserTurnId !== null,
        lineOffset,
      });
      this.reportObservedStarts(facts);
      this.reportHostTerminal(facts);
      for (const event of adaptTranscriptFacts(facts, { hostUserTurnActive: this.hostUserTurnId !== null })) {
        this.diagnostics?.record({ phase: 'map', generation, turnIdHash: this.diagnostics.hashId(event.event.turnId) });
        this.enqueue(event);
      }
    }
    if (this.mapper.hasTerminalCandidate()) {
      this.quietTimer = setTimeout(() => {
        void this.enqueueConsume(() => this.settleQuietCandidate(generation));
      }, QUIET_SETTLE_MS);
    }
    if (promote) await this.promote();
    await this.drainActive();
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
  private reportObservedStarts(facts: ReturnType<ClaudeTranscriptTurnMapper['mapLine']>): void {
    if (!this.reconciliation) return;
    for (const fact of facts) {
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
  private reportHostTerminal(facts: ReturnType<ClaudeTranscriptTurnMapper['mapLine']>): void {
    for (const fact of facts) {
      if (fact.type !== 'observed_host_terminal' || fact.replay) continue;
      const hostTurnId = this.hostUserTurnId;
      if (!hostTurnId) continue;
      if (fact.terminalSource === 'compact') {
        // Compact attribution (2026-11-04 d8912b5b): the boundary row lands
        // BEFORE the host's own buffered /compact row, so both stop_hook
        // defenses (rowObserved, offset) would drop the live boundary. The
        // boundary belongs to the live host turn iff its creation timestamp
        // postdates the dispatch: manual compact can only produce a boundary
        // during the turn that is compacting, while the previous turn's
        // residue carries a timestamp that predates the new dispatch. A
        // mismatch (CLI row-order drift) degrades to no stamp — never a
        // false positive.
        if (fact.rowTimestamp === undefined) continue;
        if (this.hostUserTurnDispatchedAt === null || fact.rowTimestamp <= this.hostUserTurnDispatchedAt) continue;
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
  private abandonActiveTurn(reason: string): void {
    if (!this.active) return;
    this.callbacks.cancelled({
      turnId: this.active.started.turnId,
      generation: this.active.started.generation + 1,
      reason,
      interrupted: true,
    });
    this.active = null;
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
    if (!this.active) return;
    const turnId = this.active.started.turnId;
    this.abandonActiveTurn(reason);
    this.callbacks.released(turnId);
  }

  private async promote(): Promise<void> {
    if (this.active || !this.canAcquire()) return;
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;
    pending.promoted = true;
    if (!this.callbacks.started(pending.started)) {
      this.active = null;
      this.queue.unshift(pending);
      return;
    }
    await this.drainActive();
    // 残余 a (promote-after-cancel): the latch means the host turn was
    // cancelled and the CLI pipeline is dead — this turn will never see its
    // result line. Its buffered content was just drained (kept in the
    // projection); settle it now and keep promoting so the whole FIFO closes
    // turn by turn instead of stranding the feature lease (18:22 ghost).
    if (this.active === pending && this.hostCancelled) {
      const turnId = pending.started.turnId;
      this.abandonActiveTurn('user_cancel');
      this.callbacks.released(turnId);
      await this.promote();
    }
  }

  private async drainActive(): Promise<void> {
    const pending = this.active;
    if (!pending) return;
    try {
      while (pending.events.length > 0 && this.active === pending) {
        const event = pending.events.shift()!;
        if (event.type === 'chunk') {
          await this.withTimeout(this.callbacks.chunk(event.event), CALLBACK_CHUNK_TIMEOUT_MS, 'chunk_timeout');
        }
        if (event.type === 'interrupted') {
          this.callbacks.cancelled(event.event);
          this.active = null;
          this.callbacks.released(event.event.turnId);
          await this.promote();
        }
        if (event.type === 'finished') {
          const terminalOffset = event.event.terminalOffset;
          await this.callbacks.finished({
            ...event.event,
            supersededByHostUser: terminalOffset !== undefined
              && this.lastHostUserOffset !== null
              && this.lastHostUserOffset > terminalOffset,
          });
          this.active = null;
          this.callbacks.released(event.event.turnId);
          await this.promote();
        }
      }
    } catch (error) {
      if (this.active === pending) {
        this.diagnostics?.record({ phase: 'callback_error', generation: pending.started.generation, turnIdHash: this.diagnostics.hashId(pending.started.turnId), errorName: error instanceof Error ? error.name : 'UnknownError' });
        this.callbacks.cancelled({
          turnId: pending.started.turnId,
          generation: pending.started.generation + 1,
          reason: error instanceof Error ? error.message : 'callback_error',
          interrupted: true,
        });
        this.active = null;
        this.callbacks.released(pending.started.turnId);
        await this.promote();
      }
    }
  }

  private async settleQuietCandidate(generation: number): Promise<void> {
    if (generation !== this.generation || this.stopped) return;
    // This settle may be the timer callback itself, but also a direct call
    // (tests, future callers) while the timer is still pending: drop the
    // handle instead of orphaning it — an orphaned timeout fires long after
    // the observer is done and keeps the process alive.
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    const facts = this.mapper.settleTerminalCandidate();
    this.reportHostTerminal(facts);
    for (const event of adaptTranscriptFacts(facts, { hostUserTurnActive: this.hostUserTurnId !== null })) this.enqueue(event);
    await this.promote();
    await this.drainActive();
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
   * complete newline the scan observed, so the caller can prime the tail
   * reader from it without a second stat racing past it; null when the file
   * could not be read. Priming at the observed EOF instead would orphan the
   * bytes of a mid-write tail line (flushed without its newline yet): the
   * writer's completion bytes would then parse as a standalone line and the
   * whole line's events would be lost. Newline search stays on the Buffer so
   * the offset is a byte offset even with multi-byte content.
   */
  private async recover(filePath: string, generation: number): Promise<number | null> {
    let info;
    try {
      info = await stat(filePath);
    } catch {
      return null;
    }
    const start = Math.max(0, info.size - RECOVERY_BYTES);
    const handle = await open(filePath, 'r');
    let buffer: Buffer;
    try {
      const allocated = Buffer.alloc(info.size - start);
      const { bytesRead } = await handle.read(allocated, 0, allocated.length, start);
      buffer = allocated.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
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
    // newline may still be mid-write, so it is left to the tail reader to
    // re-read as a partial buffer once the writer finishes it.
    const text = (lastNewline >= 0 ? buffer.subarray(0, lastNewline) : buffer).toString('utf8');
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
    if (boundary < 0 || generation !== this.generation) return tailOffset;
    // Replay maps onto this.mapper (reset to this generation by the caller),
    // not a throwaway instance: the tail line left unprimed belongs to the
    // replayed open turn, so when the writer finishes it the live mapper must
    // still hold that turn's context to attach its events. The synchronous
    // map block runs after the generation check, so a concurrent stop() can
    // never observe a half-mapped mapper.
    const shadow = this.mapper;
    const facts = lines.slice(boundary).flatMap(line => shadow.mapLine(line, true));
    facts.push(...shadow.settleTerminalCandidate(true));
    // Replay context must mirror the mapper default (hostUserTurnActive =
    // false), not the live host state: transcript-replaced recovery does not
    // clear hostUserTurnId, and a live-true context would divert the replayed
    // external start into `embedded` while the mapper already opened its
    // active turn — the buffered chunks would find no pending record and the
    // turn's content would be silently dropped without ever settling.
    const events = adaptTranscriptFacts(facts, { hostUserTurnActive: false });
    if (shadow.hasOpenTurn()) {
      for (const event of events) this.enqueue(event);
      await this.promote();
    }
    return tailOffset;
  }
}
