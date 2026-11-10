import { open, stat } from 'fs/promises';

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_BATCHES_PER_TICK = 4;
const MAX_BYTES_PER_TICK = 8 * 1024 * 1024;

export interface TranscriptTailBatch {
  lines: string[];
  lineOffsets?: number[];
  reset: boolean;
  bytesRead?: number;
}

export interface FileIdentity {
  dev: number;
  ino: number;
}

interface TailCandidate {
  batch: TranscriptTailBatch;
  identity: FileIdentity | null;
  byteOffset: number;
  partial: Buffer;
}

type TailAdmission =
  | { accepted: false }
  | { accepted: true; batch: TranscriptTailBatch; completion: Promise<void> };

/**
 * Identity credentials a boundary handoff must carry (H/P8): the source the
 * boundary was observed on, so the prime can reject a replacement instead of
 * reading a new file at the old offset.
 */
export interface RecoveryAnchor extends FileIdentity {
  snapshotSize: number;
  offset: number;
}

export type RecoveryPrime =
  | { status: 'ready' | 'missing' | 'stale' | 'source-changed' }
  | { status: 'failed'; error: unknown };

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'ENOENT';
}

function emptyBatch(): TranscriptTailBatch {
  return { lines: [], reset: false, bytesRead: 0 };
}

export class ClaudeTranscriptTailReader {
  private byteOffset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private identity: FileIdentity | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;
  private ioGeneration = 0;
  private ioChain: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly maxReadBytes = DEFAULT_MAX_READ_BYTES,
    private readonly pollMs = DEFAULT_POLL_MS,
    private readonly onBatchError?: (error: unknown) => void,
  ) {
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
      throw new RangeError('maxReadBytes must be a positive safe integer');
    }
  }

  private enqueueIO<T>(task: () => Promise<T>): Promise<T> {
    const next = this.ioChain.then(task, task);
    this.ioChain = next.then(() => {}, () => {});
    return next;
  }

  private async withOpenFile<T>(task: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
    const handle = await open(this.filePath, 'r');
    let result!: T;
    let failed = false;
    let taskError: unknown;
    try {
      result = await task(handle);
    } catch (error) {
      failed = true;
      taskError = error;
    }
    let closeFailed = false;
    let closeError: unknown;
    try {
      await handle.close();
    } catch (error) {
      closeFailed = true;
      closeError = error;
    }
    if (closeFailed) {
      if (failed) {
        throw new AggregateError([taskError, closeError], 'transcript IO and close failed; cleanup is unconfirmed');
      }
      throw closeError;
    }
    if (failed) throw taskError;
    return result;
  }

  prime(offset?: number): Promise<void> {
    const generation = this.ioGeneration;
    return this.enqueueIO(async () => {
      if (generation !== this.ioGeneration) return;
      let identity: FileIdentity | null;
      let byteOffset: number;
      try {
        await stat(this.filePath);
        const info = await this.withOpenFile(handle => handle.stat());
        identity = { dev: info.dev, ino: info.ino };
        byteOffset = offset ?? info.size;
      } catch (error) {
        if (!isMissing(error)) throw error;
        identity = null;
        byteOffset = 0;
      }
      if (generation !== this.ioGeneration) return;
      this.identity = identity;
      this.byteOffset = byteOffset;
      this.partial = Buffer.alloc(0);
    });
  }

  /**
   * Identity-anchored prime (H/P8 tail-start handoff): positions the cursor at
   * a caller-supplied committed boundary only when the live file is still the
   * source the boundary was observed on. A replacement (same path, new
   * dev/ino) or a shrink below the observed snapshot rejects with
   * source-changed — the credentials never transfer onto the new bytes.
   */
  protected primeFromRecovery(anchor: RecoveryAnchor, isOwner: () => boolean): Promise<RecoveryPrime> {
    const generation = this.ioGeneration;
    return this.enqueueIO(async () => {
      if (generation !== this.ioGeneration || !isOwner()) return { status: 'stale' };
      if (!Number.isSafeInteger(anchor.offset) || anchor.offset < 0 || anchor.offset > anchor.snapshotSize) {
        return { status: 'failed', error: new RangeError('invalid recovery boundary') };
      }
      let info;
      try {
        info = await this.withOpenFile(handle => handle.stat());
      } catch (error) {
        if (isMissing(error)) return { status: 'missing' };
        return { status: 'failed', error };
      }
      if (generation !== this.ioGeneration || !isOwner()) return { status: 'stale' };
      if (info.dev !== anchor.dev || info.ino !== anchor.ino || info.size < anchor.snapshotSize) {
        return { status: 'source-changed' };
      }
      this.identity = { dev: info.dev, ino: info.ino };
      this.byteOffset = anchor.offset;
      this.partial = Buffer.alloc(0);
      return { status: 'ready' };
    });
  }

  readAvailable(): Promise<TranscriptTailBatch> {
    return this.readWithAdmission(() => Promise.resolve(), () => true)
      .then(result => result.accepted ? result.batch : emptyBatch());
  }

  protected readWithAdmission(
    accept: (batch: TranscriptTailBatch) => Promise<void> | null,
    isOwner: () => boolean,
    maxBytes = this.maxReadBytes,
  ): Promise<TailAdmission> {
    const generation = this.ioGeneration;
    return this.enqueueIO(async () => {
      if (generation !== this.ioGeneration || !isOwner()) return { accepted: false };
      const candidate = await this.readCandidate(generation, maxBytes);
      if (!candidate || generation !== this.ioGeneration || !isOwner()) return { accepted: false };
      const completion = accept(candidate.batch);
      if (completion === null) return { accepted: false };
      this.identity = candidate.identity;
      this.byteOffset = candidate.byteOffset;
      this.partial = candidate.partial;
      return { accepted: true, batch: candidate.batch, completion };
    });
  }

  protected admitWatcherBatch(
    onBatch: (batch: TranscriptTailBatch) => void | Promise<void>,
    batch: TranscriptTailBatch,
  ): Promise<void> | null {
    if (!batch.reset && batch.lines.length === 0) return Promise.resolve();
    try {
      return Promise.resolve(onBatch(batch));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async readCandidate(generation: number, maxBytes: number): Promise<TailCandidate | null> {
    if (generation !== this.ioGeneration) return null;
    try {
      await stat(this.filePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { batch: emptyBatch(), identity: this.identity, byteOffset: this.byteOffset, partial: this.partial };
    }
    if (generation !== this.ioGeneration) return null;

    const candidate = await this.withOpenFile(async handle => {
      if (generation !== this.ioGeneration) return null;
      const info = await handle.stat();
      if (generation !== this.ioGeneration) return null;
      let identity = this.identity;
      let byteOffset = this.byteOffset;
      let partial = this.partial;
      const identityChanged = identity !== null
        && (identity.dev !== info.dev || identity.ino !== info.ino);
      const reset = identityChanged || info.size < byteOffset;
      if (!identity || reset) {
        identity = { dev: info.dev, ino: info.ino };
        byteOffset = 0;
        partial = Buffer.alloc(0);
      }
      if (info.size <= byteOffset) {
        return { batch: { lines: [], reset, bytesRead: 0 }, identity, byteOffset, partial };
      }

      const length = Math.min(info.size - byteOffset, this.maxReadBytes, maxBytes);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, byteOffset);
      if (generation !== this.ioGeneration) return null;
      if (bytesRead === 0) {
        return { batch: { lines: [], reset, bytesRead: 0 }, identity, byteOffset, partial };
      }

      const partialStart = byteOffset - partial.length;
      const combined = Buffer.concat([partial, buffer.subarray(0, bytesRead)]);
      const lines: string[] = [];
      const lineOffsets: number[] = [];
      let start = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(start, index).toString('utf8').replace(/\r$/, '');
        if (line.trim()) {
          lines.push(line);
          lineOffsets.push(partialStart + start);
        }
        start = index + 1;
      }
      return {
        batch: { lines, lineOffsets, reset, bytesRead },
        identity,
        byteOffset: byteOffset + bytesRead,
        partial: combined.subarray(start),
      };
    });
    return generation === this.ioGeneration ? candidate : null;
  }

  private lastPollFailure: { generation: number; error: unknown } | null = null;

  protected capturePollErrorOwner(): ((error: unknown) => void) | undefined {
    return this.onBatchError;
  }

  private reportPollFailure(error: unknown, generation: number, owner?: (error: unknown) => void): void {
    if (generation === this.generation) this.lastPollFailure = { generation, error };
    try {
      owner?.(error);
    } catch (reportError) {
      if (generation === this.generation) {
        this.lastPollFailure = {
          generation,
          error: new AggregateError([error, reportError], 'transcript failure reporting failed'),
        };
      }
    }
  }

  start(onBatch: (batch: TranscriptTailBatch) => void | Promise<void>): void {
    this.stop();
    this.stopped = false;
    const generation = ++this.generation;
    const errorOwner = this.capturePollErrorOwner();
    let polling = false;
    const isWatcher = () => !this.stopped && generation === this.generation;
    const schedule = (delay: number) => {
      if (!isWatcher()) return;
      this.timer = setTimeout(() => { void tick(); }, delay);
    };
    const tick = async () => {
      if (!isWatcher() || polling) return;
      polling = true;
      let continuation = false;
      try {
        let batches = 0;
        let bytes = 0;
        while (isWatcher()) {
          const result = await this.readWithAdmission(
            batch => this.admitWatcherBatch(onBatch, batch),
            isWatcher,
            MAX_BYTES_PER_TICK - bytes,
          );
          if (!result.accepted) return;
          batches += 1;
          bytes += result.batch.bytesRead ?? 0;
          try {
            await result.completion;
          } catch (error) {
            this.reportPollFailure(error, generation, errorOwner);
            return;
          }
          if (!isWatcher()) return;
          let info;
          try {
            info = await stat(this.filePath);
          } catch (error) {
            if (isMissing(error)) break;
            throw error;
          }
          if (!isWatcher()) return;
          if (info.size <= this.byteOffset) break;
          if (batches >= MAX_BATCHES_PER_TICK || bytes >= MAX_BYTES_PER_TICK) {
            continuation = true;
            break;
          }
        }
      } catch (error) {
        this.reportPollFailure(error, generation, errorOwner);
      } finally {
        polling = false;
        schedule(continuation ? 0 : this.pollMs);
      }
    };
    schedule(this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.ioGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getOffset(): number {
    return this.byteOffset;
  }

  /**
   * Identity of the source the last prime/read confirmed; null while the
   * source is missing (prime saw ENOENT). Recovery callers pair this with
   * the same-handle anchor captured during the scan to detect a replacement
   * that landed between scanning and priming.
   */
  sourceIdentity(): FileIdentity | null {
    return this.identity;
  }
}
