import { open, stat } from 'fs/promises';

import type {
  AutoTurnCancelledEvent,
  AutoTurnChunkEvent,
  AutoTurnFinishedEvent,
  AutoTurnStartedEvent,
} from '../../../core/runtime/types';
import type { ClaudeTranscriptDiagnosticLog } from './ClaudeTranscriptDiagnosticLog';
import { ClaudeTranscriptTailReader, type TranscriptTailBatch } from './ClaudeTranscriptTailReader';
import { ClaudeTranscriptTurnMapper, type TranscriptTurnEvent } from './ClaudeTranscriptTurnMapper';

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
  private consumeChain: Promise<void> = Promise.resolve();
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private readonly callbacks: ClaudeTranscriptObserverCallbacks,
    private readonly canAcquire: () => boolean,
    private readonly diagnostics?: ClaudeTranscriptDiagnosticLog,
  ) {}

  async start(filePath: string, fromOffset?: number): Promise<void> {
    this.stop('session_switch');
    this.stopped = false;
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
    // recovery scan's observed EOF so neither path races a second stat.
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
    this.mapper.reset(this.generation);
  }

  beginUserTurnProjection(turnId: string): void {
    this.hostUserTurnId = turnId;
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
    for (const line of batch.lines) {
      for (const event of this.mapper.mapLine(line, false, { hostUserTurnActive: this.hostUserTurnId !== null })) {
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
   * 2.5.1 F3: user-cancel hook. The CLI's trailing result line is not a
   * reliable settlement signal after an interrupt — the SDK ignores interrupt
   * while blocked on canUseTool, and an abandoned turn may never run at all
   * (2026-09-17 18:22 ghost lease). Terminate the promoted turn here so the
   * feature auto lease finishes exactly once; a late transcript result for the
   * same turn finds no pending record and is dropped. Mirrors the drainActive
   * interrupted shape: cancelled first, then the release pump.
   */
  interruptActiveTurn(reason: string): void {
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
          await this.callbacks.finished(event.event);
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
    this.quietTimer = null;
    for (const event of this.mapper.settleTerminalCandidate()) this.enqueue(event);
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
   * Bounded recovery scan (v6 §4.3). Returns the EOF offset the scan observed,
   * so the caller can prime the tail reader from it without a second stat
   * racing past it; null when the file could not be read.
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
    let text: string;
    try {
      const buffer = Buffer.alloc(info.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
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
    if (boundary < 0 || generation !== this.generation) return info.size;
    const shadow = new ClaudeTranscriptTurnMapper(generation);
    const events = lines.slice(boundary).flatMap(line => shadow.mapLine(line, true));
    events.push(...shadow.settleTerminalCandidate(true));
    if (shadow.hasOpenTurn()) {
      for (const event of events) this.enqueue(event);
      await this.promote();
    }
    return info.size;
  }
}
