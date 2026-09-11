import { open, stat } from 'fs/promises';

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_BATCHES_PER_TICK = 4;
const MAX_BYTES_PER_TICK = 8 * 1024 * 1024;

export interface TranscriptTailBatch {
  lines: string[];
  reset: boolean;
  bytesRead?: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

export class ClaudeTranscriptTailReader {
  private byteOffset = 0;
  private partial = Buffer.alloc(0);
  private identity: FileIdentity | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private polling = false;
  private generation = 0;
  private readChain: Promise<TranscriptTailBatch> = Promise.resolve({ lines: [], reset: false, bytesRead: 0 });

  constructor(
    readonly filePath: string,
    private readonly maxReadBytes = DEFAULT_MAX_READ_BYTES,
    private readonly pollMs = DEFAULT_POLL_MS,
    private readonly onBatchError?: (error: unknown) => void,
  ) {}

  async prime(offset?: number): Promise<void> {
    try {
      const info = await stat(this.filePath);
      this.identity = { dev: info.dev, ino: info.ino };
      this.byteOffset = offset ?? info.size;
    } catch {
      this.identity = null;
      this.byteOffset = 0;
    }
    this.partial = Buffer.alloc(0);
  }

  readAvailable(): Promise<TranscriptTailBatch> {
    const next = this.readChain.then(() => this.readAvailableUnlocked());
    this.readChain = next.catch(() => ({ lines: [], reset: false, bytesRead: 0 }));
    return next;
  }

  private async readAvailableUnlocked(): Promise<TranscriptTailBatch> {
    let info;
    try {
      info = await stat(this.filePath);
    } catch {
      return { lines: [], reset: false, bytesRead: 0 };
    }

    const identityChanged = this.identity !== null
      && (this.identity.dev !== info.dev || this.identity.ino !== info.ino);
    const reset = identityChanged || info.size < this.byteOffset;
    if (!this.identity || reset) {
      this.identity = { dev: info.dev, ino: info.ino };
      this.byteOffset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (info.size <= this.byteOffset) return { lines: [], reset, bytesRead: 0 };

    const length = Math.min(info.size - this.byteOffset, this.maxReadBytes);
    const handle = await open(this.filePath, 'r');
    let buffer: Buffer;
    let bytesRead: number;
    try {
      buffer = Buffer.allocUnsafe(length);
      ({ bytesRead } = await handle.read(buffer, 0, length, this.byteOffset));
    } finally {
      await handle.close();
    }
    if (bytesRead === 0) return { lines: [], reset, bytesRead: 0 };

    this.byteOffset += bytesRead;
    const combined = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]);
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      const line = combined.subarray(start, index).toString('utf8').replace(/\r$/, '');
      if (line.trim()) lines.push(line);
      start = index + 1;
    }
    this.partial = combined.subarray(start);
    return { lines, reset, bytesRead };
  }

  start(onBatch: (batch: TranscriptTailBatch) => void | Promise<void>): void {
    this.stop();
    this.stopped = false;
    const generation = ++this.generation;
    const schedule = (delay: number) => {
      if (this.stopped || generation !== this.generation) return;
      this.timer = setTimeout(() => { void tick(); }, delay);
    };
    const tick = async () => {
      if (this.stopped || generation !== this.generation || this.polling) return;
      this.polling = true;
      let continuation = false;
      try {
        let batches = 0;
        let bytes = 0;
        while (!this.stopped && generation === this.generation) {
          const batch = await this.readAvailable();
          batches += 1;
          bytes += batch.bytesRead ?? 0;
          if (this.stopped || generation !== this.generation) return;
          if (batch.reset || batch.lines.length > 0) {
            try {
              await onBatch(batch);
            } catch (error) {
              this.onBatchError?.(error);
              return;
            }
          }
          const info = await stat(this.filePath).catch(() => null);
          if (!info || info.size <= this.byteOffset) break;
          if (batches >= MAX_BATCHES_PER_TICK || bytes >= MAX_BYTES_PER_TICK) {
            continuation = true;
            break;
          }
        }
      } finally {
        this.polling = false;
        schedule(continuation ? 0 : this.pollMs);
      }
    };
    schedule(this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getOffset(): number {
    return this.byteOffset;
  }
}
