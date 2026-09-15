import { createHash, randomBytes } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export type TranscriptDiagnosticPhase =
  | 'tick_start' | 'tick_end' | 'map'
  | 'lease_begin' | 'lease_finish' | 'lease_release'
  | 'render_start' | 'render_end' | 'render_batch' | 'render_complete'
  | 'save_start' | 'save_end' | 'save_timeout' | 'callback_error'
  | 'index_worker_fallback'
  | 'queued' | 'start' | 'progress' | 'finalize' | 'complete' | 'failed' | 'aborted' | 'stalled'
  | 'window_planned' | 'window_complete'
  | 'cache_hit' | 'cache_evict';

export interface TranscriptDiagnosticEvent {
  phase: TranscriptDiagnosticPhase;
  tabIdHash?: string;
  turnIdHash?: string;
  generation?: number;
  leaseKind?: 'user' | 'auto';
  batchBytes?: number;
  batchLines?: number;
  elapsedMs?: number;
  errorName?: string;
  buildId?: string;
  mode?: 'worker' | 'direct';
  queueMs?: number;
  bytes?: number;
  totalBytes?: number;
  entries?: number;
  turns?: number;
  turnCount?: number;
  sourceBytes?: number;
  projectedChars?: number;
  oversizedTurns?: number;
}

const SEGMENT_BYTES = 128 * 1024;
const ENTRY_BYTES = 1024;

export class ClaudeTranscriptDiagnosticLog {
  private readonly currentPath: string;
  private readonly previousPath: string;
  private readonly salt = randomBytes(16);
  private seq = 0;
  private disabled = false;
  private notified = false;

  constructor(vaultPath: string, private readonly notify: (message: string) => void = () => {}, fileBase = 'transcript-tail') {
    const directory = join(vaultPath, '.claudian', 'diagnostics');
    this.currentPath = join(directory, `${fileBase}.current.jsonl`);
    this.previousPath = join(directory, `${fileBase}.previous.jsonl`);
  }

  hashId(id: string): string {
    return createHash('sha256').update(this.salt).update(id).digest('hex').slice(0, 12);
  }

  record(event: TranscriptDiagnosticEvent): void {
    if (this.disabled) return;
    try {
      mkdirSync(dirname(this.currentPath), { recursive: true });
      const entry = this.serialize(event);
      const bytes = Buffer.byteLength(entry);
      const currentBytes = existsSync(this.currentPath) ? statSync(this.currentPath).size : 0;
      if (currentBytes + bytes > SEGMENT_BYTES) {
        rmSync(this.previousPath, { force: true });
        if (existsSync(this.currentPath)) renameSync(this.currentPath, this.previousPath);
        writeFileSync(this.currentPath, '');
      }
      appendFileSync(this.currentPath, entry);
    } catch {
      this.disabled = true;
      if (!this.notified) {
        this.notified = true;
        try { this.notify('Transcript diagnostics could not be written.'); } catch { /* diagnostic failure is isolated */ }
      }
    }
  }

  private serialize(event: TranscriptDiagnosticEvent): string {
    const clean: Record<string, unknown> = { ts: Date.now(), seq: ++this.seq, phase: event.phase };
    for (const key of ['tabIdHash', 'turnIdHash', 'generation', 'leaseKind', 'batchBytes', 'batchLines', 'elapsedMs', 'errorName', 'buildId', 'mode', 'queueMs', 'bytes', 'totalBytes', 'entries', 'turns', 'turnCount', 'sourceBytes', 'projectedChars', 'oversizedTurns'] as const) {
      const value = event[key];
      if (value !== undefined) clean[key] = typeof value === 'string' ? value.slice(0, 128) : value;
    }
    let line = `${JSON.stringify(clean)}\n`;
    if (Buffer.byteLength(line) > ENTRY_BYTES) {
      delete clean.errorName;
      line = `${JSON.stringify(clean)}\n`;
    }
    return line;
  }
}
