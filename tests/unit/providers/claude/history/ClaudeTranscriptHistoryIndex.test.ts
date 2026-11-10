import type * as fsPromisesModule from 'fs/promises';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type * as workerThreadsModule from 'worker_threads';

import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import {
  buildTranscriptIndex,
  builtIndexCacheKey,
  clearTranscriptIndexCache,
  getTranscriptIndexCacheSize,
  materializeTranscriptEntries,
  materializeTranscriptPage,
  materializeTranscriptToolAssociations,
  protectTranscriptIndex,
  releaseTranscriptIndex,
  resetTranscriptIndexWorkerProbe,
  setTranscriptIndexDiagnosticSink,
  type TranscriptHistoryIndex,
  type TranscriptIndexDiagnosticEvent,
  transcriptIndexResultIdentity,
} from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import { filterActiveBranch } from '@/providers/claude/history/sdkBranchFilter';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';
import * as sdkSessionPaths from '@/providers/claude/history/sdkSessionPaths';
import { HISTORY_OMISSION_MARKER } from '@/providers/claude/runtime/HistoryContextAccumulator';

const fsPromises = jest.requireActual<typeof fsPromisesModule>('fs/promises');

let mockWorkerConstructorMode: 'real' | 'throw' | 'record' | 'probe-error' | 'build-error' = 'real';
const mockWorkerSources: string[] = [];
let mockWorkerStartGate: Promise<void> | null = null;
let mockWorkerObserver: ((worker: workerThreadsModule.Worker) => void) | null = null;

jest.mock('worker_threads', () => {
  const actual = jest.requireActual<typeof workerThreadsModule>('worker_threads');
  const ActualWorker = actual.Worker;
  return {
    ...actual,
    Worker: class extends ActualWorker {
      constructor(...args: ConstructorParameters<typeof ActualWorker>) {
        if (mockWorkerConstructorMode === 'throw') {
          throw new TypeError("Failed to construct 'Worker': The V8 platform used by this instance of Node does not support creating Workers");
        }
        const source = String(args[0]);
        const startGate = source.includes('postMessage("ready")') ? null : mockWorkerStartGate;
        if (startGate) args = [`require('worker_threads').parentPort.once('message', () => {\n${source}\n});`, args[1]];
        super(...args);
        mockWorkerObserver?.(this);
        if (startGate) void startGate.then(() => { this.postMessage('start'); });
        if (mockWorkerConstructorMode === 'record') mockWorkerSources.push(source);
        if (mockWorkerConstructorMode === 'probe-error' && source.includes('postMessage("ready")')) {
          queueMicrotask(() => this.emit('error', new Error('probe failed')));
        }
        if (mockWorkerConstructorMode === 'build-error' && !source.includes('postMessage("ready")')) {
          queueMicrotask(() => this.emit('error', new Error('build failed')));
        }
      }
    },
  };
});

const fixtures = join(__dirname, '..', 'transcript', 'fixtures');
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realNow = Date.now.bind(Date);
let poisonedTestFile: string | undefined;
let scopeSequence = 0;

function describeReason(reason: unknown, withStack = false): string {
  try {
    return withStack && reason instanceof Error ? String(reason.stack ?? reason.message) : String(reason);
  } catch {
    return '[unprintable reason]';
  }
}

beforeEach(() => {
  if (poisonedTestFile) throw new Error(`Previous cleanup did not finish: ${poisonedTestFile}`);
});

class CoordinationScope {
  private readonly deadline = realNow() + 2200;
  private readonly sentinelPath = join(process.env.TMPDIR ?? '/tmp', `claudian-queue-sentinel-${process.pid}-${++scopeSequence}.jsonl`);
  private readonly tracked = new Map<Promise<unknown>, {
    label: string; status: 'pending' | 'fulfilled' | 'rejected'; reason?: unknown; allowedReason?: { reason: unknown };
  }>();
  private readonly workers = new Map<workerThreadsModule.Worker, Promise<void>>();
  private workerSequence = 0;
  private readonly handles = new Set<Awaited<ReturnType<typeof fsPromises.open>>>();
  private readonly releases: Array<() => void> = [];
  private readonly controllers: AbortController[] = [];
  private readonly cleanupHooks: Array<() => void> = [];
  private readonly restorers: Array<() => void> = [];
  private phase = 'setup';
  private state = 'not started';
  closing = false;

  constructor(private readonly label: string) {
    mockWorkerObserver = worker => {
      const label = `worker ${++this.workerSequence} termination`;
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        try { return this.track(label, terminate()); }
        catch (reason) { return this.track(label, Promise.reject(reason)); }
      };
      const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
      this.workers.set(worker, exited);
      void exited.then(() => this.workers.delete(worker));
      if (this.closing) void worker.terminate();
    };
  }

  gate(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.releases.push(release);
    return { promise, release };
  }

  controller(): AbortController {
    const controller = new AbortController();
    this.controllers.push(controller);
    return controller;
  }

  release(fn: () => void): void { this.cleanupHooks.push(fn); }
  restore(fn: () => void): void { this.restorers.push(fn); }
  update(state: string): void { this.state = state; }

  track<T>(label: string, promise: Promise<T>, allowedReason?: { reason: unknown }): Promise<T> {
    if (this.tracked.has(promise)) return promise;
    const record: { label: string; status: 'pending' | 'fulfilled' | 'rejected'; reason?: unknown; allowedReason?: { reason: unknown } } = {
      label, status: 'pending', allowedReason,
    };
    this.tracked.set(promise, record);
    void promise.then(() => { record.status = 'fulfilled'; }, reason => { record.status = 'rejected'; record.reason = reason; });
    return promise;
  }

  private pending(): Promise<unknown>[] {
    return [...this.tracked].filter(([, record]) => record.status === 'pending').map(([promise]) => promise);
  }

  handle(handle: Awaited<ReturnType<typeof fsPromises.open>>): typeof handle {
    this.handles.add(handle);
    const close = handle.close.bind(handle);
    handle.close = () => this.track('file close', (async () => {
      await close();
      this.handles.delete(handle);
    })());
    return handle;
  }

  private details(): string {
    const pending = [...this.tracked.values()].filter(record => record.status === 'pending').map(record => record.label);
    return `${this.label}; phase=${this.phase}; state=${this.state}; pending=${pending.join(',') || 'none'}; workers=${this.workers.size}; handles=${this.handles.size}`;
  }

  private async until<T>(promise: Promise<T>, deadline: number, name: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error(`${name}: ${this.details()}`)), Math.max(0, deadline - realNow()));
    });
    try { return await Promise.race([promise, timeout]); }
    finally { if (timer) realClearTimeout(timer); }
  }

  async wait<T>(phase: string, promise: Promise<T>): Promise<T> {
    this.phase = phase;
    return this.until(promise, this.deadline, 'GateTimeout');
  }

  async finish(): Promise<void> {
    this.closing = true;
    const errors: Array<{ label: string; reason: unknown }> = [];
    const attempt = (label: string, fn: () => void) => {
      try { fn(); } catch (reason) { errors.push({ label, reason }); }
    };
    const deadline = realNow() + 1800;
    try {
      this.releases.forEach((release, index) => attempt(`gate ${index} release`, release));
      this.controllers.forEach((controller, index) => attempt(`controller ${index} abort`, () => controller.abort()));
      this.cleanupHooks.forEach((release, index) => attempt(`owned resource ${index} release`, release));
      const drain = async () => {
        for (const worker of this.workers.keys()) void worker.terminate();
        while (this.pending().length || this.workers.size) {
          await Promise.allSettled([...this.pending(), ...this.workers.values()]);
        }
        // The failing scan proves direct-queue progress without occupying an LRU slot.
        let wroteSentinel = false;
        try {
          await writeFile(this.sentinelPath, `${JSON.stringify({ type: 'user', uuid: 'sentinel', message: { content: 'sentinel' } })}\n`);
          wroteSentinel = true;
        } catch (reason) { errors.push({ label: 'sentinel write', reason }); }
        if (wroteSentinel) {
          try {
            let finalized = false;
            const sentinel = await buildTranscriptIndex(this.sentinelPath, {
              useWorker: false, forceNewSnapshot: true, maxLineBytes: 1, resumeAtMessageId: 'sentinel',
              onFinalize: () => { finalized = true; },
            });
            if (!finalized || sentinel.status !== 'failed' || sentinel.error !== 'Transcript resume anchor falls inside an oversized line') {
              throw new Error(`Unexpected sentinel result: finalized=${finalized}, result=${JSON.stringify(sentinel)}`);
            }
          } catch (reason) { errors.push({ label: 'sentinel verification', reason }); }
        }
        try { await fsPromises.unlink(this.sentinelPath); }
        catch (reason) { errors.push({ label: 'sentinel unlink', reason }); }
        while (this.pending().length || this.workers.size) {
          await Promise.allSettled([...this.pending(), ...this.workers.values()]);
        }
      };
      await this.until(drain(), deadline, 'CleanupTimeout');
    } catch (reason) {
      errors.push({ label: 'drain', reason });
    } finally {
      this.restorers.reverse().forEach((restore, index) => attempt(`restore ${index}`, restore));
      mockWorkerObserver = null;
      mockWorkerStartGate = null;
      mockWorkerConstructorMode = 'real';
      attempt('diagnostic sink restore', () => setTranscriptIndexDiagnosticSink(null));
      attempt('worker probe reset', () => resetTranscriptIndexWorkerProbe());
      attempt('real timers restore', () => jest.useRealTimers());
    }
    for (const record of this.tracked.values()) {
      if (record.status === 'rejected' && (!record.allowedReason || record.reason !== record.allowedReason.reason)) {
        errors.push({ label: record.label, reason: record.reason });
      }
    }
    if (this.pending().length || this.workers.size) errors.push({ label: 'unfinished resources', reason: new Error(this.details()) });
    if (this.handles.size) errors.push({ label: 'file handles', reason: new Error(`${this.handles.size} still open`) });
    if (errors.length) {
      poisonedTestFile = 'Cleanup failure';
      const message = errors.map(({ label, reason }) => `${label}: ${describeReason(reason)}`).join('; ');
      poisonedTestFile = message;
      throw new AggregateError(errors.map(({ reason }) => reason), `Cleanup failure: ${message}`);
    }
  }
}

async function coordinated(label: string, run: (scope: CoordinationScope) => Promise<void>): Promise<void> {
  const scope = new CoordinationScope(label);
  let failure: unknown;
  let hasFailure = false;
  try { await run(scope); } catch (error) { hasFailure = true; failure = error; }
  try { await scope.finish(); } catch (cleanup) {
    if (hasFailure) {
      throw new AggregateError([failure, cleanup], `First failure: ${describeReason(failure, true)}\nCleanup failure: ${describeReason(cleanup)}`, { cause: cleanup });
    }
    throw cleanup;
  }
  if (hasFailure) throw failure;
}

async function fixture(name: string): Promise<{ path: string; rows: SDKNativeMessage[] }> {
  const path = join(fixtures, name);
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { path, rows };
}

describe('ClaudeTranscriptHistoryIndex', () => {
  it.each(['production-auto-turn-sequence.jsonl', 'stop-hook-continuation.jsonl'])(
    'matches canonical branch ordering for %s',
    async name => {
      const { path, rows } = await fixture(name);
      const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 37 });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;
      expect(result.index.entries.map(entry => entry.messageKey)).toEqual(
        filterActiveBranch(rows).map((row, index) => row.uuid ?? `line:${index}`),
      );
    },
  );

  it('opens visible real and external turns but not notification turns', async () => {
    const { path } = await fixture('production-auto-turn-sequence.jsonl');
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 41 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['peer-a', 'peer-b']);
    expect(result.index.entries.find(entry => entry.messageKey === 'notification-a')?.turnId).toBe('peer-a');
  });

  it('builds searchable visible text without thinking, tool payloads, attachments, or system injection', async () => {
    const { path } = await fixture('production-auto-turn-sequence.jsonl');
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 41 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const texts = result.index.searchCorpus.map(item =>
      result.index.searchText.slice(item.textOffset, item.textOffset + item.textLength)
    );
    expect(texts).toEqual([
      'fixture A',
      'answer A\n\nnotification answer A',
      'fixture B',
      'answer B\n\nnotification answer B',
    ]);
    const corpus = texts.join('\n');
    expect(corpus).not.toContain('thinking A');
    expect(corpus).not.toContain('queue item');
    expect(corpus).not.toContain('fixture notification');
  });

  it('excludes persisted recovery injections from every indexed projection', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-rebuilt-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'real question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'real answer' } }),
      JSON.stringify({ type: 'user', uuid: 'recovery', parentUuid: 'a1', message: { content: 'User: old question\n\nAssistant: injected recovery secret\n\nUser: next question' } }),
      JSON.stringify({ type: 'user', uuid: 'recovery-omitted', parentUuid: 'recovery', message: { content: `${HISTORY_OMISSION_MARKER}\n\nUser: q1\n\nAssistant: omitted recovery secret\n\nUser: next question` } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'recovery-omitted', message: { content: 'next answer' } }),
    ];
    await writeFile(path, `${lines.join('\n')}\n`);

    const result = await buildTranscriptIndex(path, { useWorker: false });

    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1', 'a2']);
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['u1']);
    expect(result.index.searchText).not.toContain('injected recovery secret');
    expect(result.index.searchText).not.toContain('omitted recovery secret');
  });

  it('excludes omission-marker-prefixed recovery injections through the full history path', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-omitted-recovery-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'real question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'real answer' } }),
      JSON.stringify({ type: 'user', uuid: 'recovery', parentUuid: 'a1', message: { content: `${HISTORY_OMISSION_MARKER}\n\nUser: q1\n\nAssistant: omitted recovery secret` } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'recovery', message: { content: 'next answer' } }),
    ];
    await writeFile(path, `${lines.join('\n')}\n`);

    const service = new ClaudeConversationHistoryService();
    const conversation: Conversation = {
      id: 'omitted-recovery', providerId: 'claude', title: 'Fixture', createdAt: 1, updatedAt: 1,
      sessionId: 'omitted-recovery', providerState: { providerSessionId: 'omitted-recovery' }, messages: [],
    };
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(path);
    jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);

    const chunks = [];
    for await (const chunk of service.iterateFullHistory(conversation, process.env.TEST_VAULT ?? process.env.TMPDIR ?? '/tmp', {
      maxTurnsPerChunk: 10, maxSourceBytesPerChunk: 100_000, maxProjectedCharsPerChunk: 100_000, projectionLevel: 'detail',
    })) chunks.push(chunk);
    const contents = chunks.flatMap(chunk => chunk.messages).map(message => message.content).join('\n');
    expect(contents).toContain('real question');
    expect(contents).toContain('next answer');
    expect(contents).not.toContain('omitted recovery secret');
  });

  it('uses materialization projection keys across merged assistants and compact boundaries', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-projection-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'first' } }),
      JSON.stringify({ type: 'assistant', uuid: 'synthetic', parentUuid: 'a1', message: { model: '<synthetic>', content: 'skip' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'synthetic', message: { content: 'needle' } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: 'a2', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', uuid: 'a3', parentUuid: 'compact', message: { content: 'after compact' } }),
    ];
    await writeFile(path, `${lines.join('\n')}\n`);

    const result = await buildTranscriptIndex(path, { useWorker: false });

    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.searchCorpus.map(item => item.projectionKey)).toEqual(['u1', 'a1', 'a3']);
    expect(result.index.searchText).toContain('first\n\nneedle');
  });

  it('stamps each corpus item with its canonical entry index for structural ordering', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-corpus-order-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'first' } }),
      JSON.stringify({ type: 'assistant', uuid: 'synthetic', parentUuid: 'a1', message: { model: '<synthetic>', content: 'skip' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'synthetic', message: { content: 'needle' } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: 'a2', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', uuid: 'a3', parentUuid: 'compact', message: { content: 'after compact' } }),
    ];
    await writeFile(path, `${lines.join('\n')}\n`);

    const result = await buildTranscriptIndex(path, { useWorker: false });

    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    // Corpus items carry the canonical entry index of their first contributing
    // row (skipped rows occupy their index; merged assistants keep the first
    // row's position) so search results order structurally, never by
    // projectionKey string comparison.
    expect(result.index.searchCorpus.map(item => [item.projectionKey, item.entryIndex])).toEqual([
      ['u1', 0],
      ['a1', 1],
      ['a3', 5],
    ]);
  });

  it('indexes an external meta row and materializes byte-exact pages across chunks', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-index-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'world' } }),
      JSON.stringify({ type: 'user', uuid: 'p1', parentUuid: 'a1', isMeta: true, origin: { kind: 'peer', body: '[msg] peer' }, message: { content: 'envelope' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'p1', message: { content: 'done' } }),
    ];
    await writeFile(path, `${lines.join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 11 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['u1', 'p1']);
    await expect(materializeTranscriptPage(result.index, 1, 1)).resolves.toEqual([
      expect.objectContaining({ uuid: 'p1' }),
      expect.objectContaining({ uuid: 'a2' }),
    ]);
  });

  it('aggregates per-turn source bytes at finalize without reading content', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-turn-bytes-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'one' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'first' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'second question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'later' } }),
    ];
    await writeFile(path, `${lines.join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['u1', 'u2']);
    expect(result.index.turns[0].sourceBytes).toBe(
      Buffer.byteLength(lines[0]) + Buffer.byteLength(lines[1]),
    );
    expect(result.index.turns[1].sourceBytes).toBe(
      Buffer.byteLength(lines[2]) + Buffer.byteLength(lines[3]),
    );
  });

  it('pins snapshot size and ignores an appended half-line', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-snapshot-${process.pid}.jsonl`);
    await writeFile(path, '{"type":"user","uuid":"u1","message":{"content":"one"}}\n{"type":"assistant"');
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 9 });
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1']);
    expect(result.error).toMatch(/incomplete/i);
  });

  it('records cache hit and eviction diagnostic events', async () => {
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    clearTranscriptIndexCache();
    const paths: string[] = [];
    try {
      for (let index = 0; index < 9; index += 1) {
        const path = join(process.env.TMPDIR ?? '/tmp', `claudian-cache-diag-${process.pid}-${index}.jsonl`);
        paths.push(path);
        await writeFile(path, `${JSON.stringify({ type: 'user', uuid: `u${index}`, message: { content: 'x' } })}\n`);
        await buildTranscriptIndex(path, { useWorker: false });
      }
      // Rebuild the newest snapshot: served from the completed cache.
      await buildTranscriptIndex(paths[2], { useWorker: false });
      expect(events.filter(event => event.phase === 'cache_evict').length).toBeGreaterThan(0);
      expect(events.filter(event => event.phase === 'cache_hit')).toHaveLength(1);
    } finally {
      setTranscriptIndexDiagnosticSink(null);
    }
  });

  it('keeps a released completed index as an idle cache hit', async () => {
    clearTranscriptIndexCache();
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-idle-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x' } })}\n`);
    const first = await buildTranscriptIndex(path, { useWorker: false });
    expect(first.status).toBe('complete');
    if (first.status !== 'complete') return;
    // A released lease must not wipe the completed cache; the same snapshot
    // rebuild resolves without a second scan (the index object is shared).
    const second = await buildTranscriptIndex(path, { useWorker: false });
    expect(second.status).toBe('complete');
    if (second.status !== 'complete') return;
    expect(second.index).toBe(first.index);
  });

  it('marks completed-cache results as fromCache and rescans changed transcripts', async () => {
    clearTranscriptIndexCache();
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-from-cache-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x' } })}\n`);
    const first = await buildTranscriptIndex(path, { useWorker: false });
    expect(first.status).toBe('complete');
    if (first.status !== 'complete') return;
    expect(first.fromCache).toBeUndefined();
    const second = await buildTranscriptIndex(path, { useWorker: false });
    expect(second.status).toBe('complete');
    if (second.status !== 'complete') return;
    // Same snapshot: served from the completed cache and marked so callers
    // can tell "nothing new" from a real rescan; the index object is shared.
    expect(second.fromCache).toBe(true);
    expect(second.index).toBe(first.index);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'y' } })}\n`);
    const third = await buildTranscriptIndex(path, { useWorker: false });
    expect(third.status).toBe('complete');
    if (third.status !== 'complete') return;
    expect(third.fromCache).toBeUndefined();
  });

  it('keeps at most eight unprotected completed indexes', async () => {
    clearTranscriptIndexCache();
    for (let index = 0; index < 9; index += 1) {
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-lru-${process.pid}-${index}.jsonl`);
      await writeFile(path, `${JSON.stringify({ type: 'user', uuid: `u${index}`, message: { content: 'x' } })}\n`);
      await buildTranscriptIndex(path, { useWorker: false });
    }
    expect(getTranscriptIndexCacheSize()).toBeLessThanOrEqual(8);
  });

  it('never evicts protected indexes and shrinks immediately after release', async () => {
    clearTranscriptIndexCache();
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    const paths: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const path = join(process.env.TMPDIR ?? '/tmp', `claudian-protected-lru-${process.pid}-${index}.jsonl`);
        paths.push(path);
        protectTranscriptIndex(path);
        await writeFile(path, `${JSON.stringify({ type: 'user', uuid: `p${index}`, message: { content: 'x' } })}\n`);
        await buildTranscriptIndex(path, { useWorker: false });
      }
      expect(getTranscriptIndexCacheSize()).toBe(10);
      expect(events.some(event => event.phase === 'cache_overcommit')).toBe(true);
      for (const path of paths) {
        const result = await buildTranscriptIndex(path, { useWorker: false });
        expect(result.status).toBe('complete');
      }
    } finally {
      for (const path of paths) releaseTranscriptIndex(path);
      setTranscriptIndexDiagnosticSink(null);
    }
    expect(getTranscriptIndexCacheSize()).toBeLessThanOrEqual(8);
  });

  it('deduplicates concurrent worker builds for the same snapshot', async () => {
    const { path } = await fixture('production-auto-turn-sequence.jsonl');
    const first = buildTranscriptIndex(path, { useWorker: false });
    const second = buildTranscriptIndex(path, { useWorker: false });
    const [result, other] = await Promise.all([first, second]);
    if (result.status === 'failed' || other.status === 'failed') throw new Error('shared build failed');
    expect(other.index).toBe(result.index);
    expect(result.status).toBe('complete');
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['peer-a', 'peer-b']);
  });

  it('lets a superseding build succeed when the previous build is aborted mid-scan', async () => coordinated('superseding direct build', async scope => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-supersede-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'one' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'two' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'three' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'four' } }),
      JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: 'a2', message: { content: 'five' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a3', parentUuid: 'u3', message: { content: 'six' } }),
    ];
    await scope.wait('write snapshot', scope.track('write', writeFile(path, `${lines.join('\n')}\n`)));
    const superseded = scope.controller(), superseding = scope.controller();
    const progress = scope.gate();
    const first = scope.track('first subscription', buildTranscriptIndex(path, {
      useWorker: false, chunkSize: 16, signal: superseded.signal, onProgress: progress.release,
    }));
    // Abort and replace the old subscriber after the scan has started.
    await scope.wait('first progress', progress.promise);
    superseded.abort();
    const second = scope.track('second subscription', buildTranscriptIndex(path, {
      useWorker: false, chunkSize: 16, signal: superseding.signal,
    }));
    const [firstResult, secondResult] = await scope.wait('results', Promise.all([first, second]));
    expect(firstResult).toEqual({ status: 'failed', error: 'History index build aborted' });
    expect(secondResult.status).toBe('complete');
    if (secondResult.status !== 'complete') return;
    expect(secondResult.index.turns.map(turn => turn.turnId)).toEqual(['u1', 'u2', 'u3']);
    expect(secondResult.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  }));
});

describe('ClaudeTranscriptHistoryIndex materialization source identity', () => {
  const invalidated = 'Transcript index invalidated by replacement or truncation';
  const rows = [
    JSON.stringify({ type: 'user', uuid: 'u-old', message: { content: 'question' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-old', parentUuid: 'u-old', message: { content: [
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
    ] } }),
    JSON.stringify({ type: 'user', uuid: 't-old', parentUuid: 'a-old', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
    ] } }),
  ];
  const source = `${rows.join('\n')}\n`;

  async function indexed(name: string): Promise<{ path: string; index: TranscriptHistoryIndex }> {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-i1-${name}-${process.pid}.jsonl`);
    await writeFile(path, source);
    const result = await buildTranscriptIndex(path, { useWorker: false, forceNewSnapshot: true });
    if (result.status !== 'complete') throw new Error(result.error);
    return { path, index: result.index };
  }

  it.each((['equal', 'longer', 'shorter'] as const).flatMap(size =>
    (['page', 'entries', 'associations'] as const).map(entrypoint => [size, entrypoint] as const)))
  ('rejects a %s replacement before open through %s', async (size, entrypoint) => {
    const { path, index } = await indexed(`${size}-${entrypoint}`);
    const replacementPath = `${path}.replacement`;
    const replacement = source.replace(/old/g, 'new');
    const replacementContent = size === 'equal' ? replacement : size === 'longer'
      ? replacement + ' '.repeat(40) : replacement.slice(0, -1);
    await writeFile(replacementPath, replacementContent);
    const originalInfo = await fsPromises.stat(path), replacementInfo = await fsPromises.stat(replacementPath);
    expect([originalInfo.dev, originalInfo.ino]).toEqual([index.dev, index.ino]);
    expect([replacementInfo.dev, replacementInfo.ino]).not.toEqual([index.dev, index.ino]);
    expect(Math.sign(replacementInfo.size - index.snapshotSize)).toBe(size === 'equal' ? 0 : size === 'longer' ? 1 : -1);
    const open = fsPromises.open;
    let swapped = false, closed = 0;
    const spy = jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (args[0] === path && !swapped) {
        swapped = true;
        await fsPromises.rename(replacementPath, path);
      }
      const handle = await open(...args);
      if (args[0] === path) {
        const close = handle.close.bind(handle);
        handle.close = async () => { closed += 1; await close(); };
      }
      return handle;
    });
    try {
      const result = entrypoint === 'page' ? materializeTranscriptPage(index, 0, 1)
        : entrypoint === 'entries' ? materializeTranscriptEntries(index, index.entries)
          : materializeTranscriptToolAssociations(index, [{ type: 'assistant', uuid: 'caller', message: {
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
          } }]);
      await expect(result).rejects.toThrow(invalidated);
      expect(swapped).toBe(true);
      expect(closed).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('rejects same-inode truncation before open even when indexed rows remain readable', async () => {
    const { path, index } = await indexed('truncate');
    const open = fsPromises.open;
    let truncated = false, closed = 0;
    const spy = jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (args[0] === path && !truncated) {
        truncated = true;
        await fsPromises.truncate(path, index.snapshotSize - 1);
      }
      const handle = await open(...args);
      if (args[0] === path) {
        const close = handle.close.bind(handle);
        handle.close = async () => { closed += 1; await close(); };
      }
      return handle;
    });
    try {
      await expect(materializeTranscriptEntries(index, index.entries)).rejects.toThrow(invalidated);
      const info = await fsPromises.stat(path);
      expect([info.dev, info.ino, info.size]).toEqual([index.dev, index.ino, index.snapshotSize - 1]);
      expect(truncated).toBe(true);
      expect(closed).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('permits append on the indexed inode and closes the materialization handle', async () => {
    const { path, index } = await indexed('append');
    const open = fsPromises.open;
    let closed = 0;
    const spy = jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (args[0] === path) await fsPromises.appendFile(path, `${JSON.stringify({ type: 'user', uuid: 'later', message: { content: 'later' } })}\n`);
      const handle = await open(...args);
      if (args[0] === path) {
        const close = handle.close.bind(handle);
        handle.close = async () => { closed += 1; await close(); };
      }
      return handle;
    });
    try {
      const messages = await materializeTranscriptPage(index, 0, 1);
      expect(messages.map(message => message.uuid)).toEqual(['u-old', 'a-old']);
      const appendedInfo = await fsPromises.stat(path);
      expect([appendedInfo.dev, appendedInfo.ino]).toEqual([index.dev, index.ino]);
      expect(appendedInfo.size).toBeGreaterThan(index.snapshotSize);
      expect(closed).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('rejects a short second read without returning the already read row and closes the handle', async () => {
    const { path, index } = await indexed('short-read');
    const open = fsPromises.open;
    let closed = 0, reads = 0;
    const spy = jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path) {
        const close = handle.close.bind(handle), read = handle.read.bind(handle);
        handle.close = async () => { closed += 1; await close(); };
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          reads += 1;
          return reads === 2 ? { bytesRead: 0, buffer } : read(buffer, offset, length, position);
        }) as typeof handle.read;
      }
      return handle;
    });
    try {
      await expect(materializeTranscriptPage(index, 0, 1)).rejects.toThrow(`Short transcript read at offset ${index.entries[1].offset}`);
      expect(reads).toBe(2);
      expect(closed).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('closes the handle when its stat fails', async () => {
    const { path, index } = await indexed('stat-failure');
    const open = fsPromises.open;
    const failure = new Error('synthetic handle stat failure');
    let closed = 0;
    const spy = jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path) {
        const close = handle.close.bind(handle);
        handle.close = async () => { closed += 1; await close(); };
        handle.stat = (async () => { throw failure; }) as typeof handle.stat;
      }
      return handle;
    });
    try {
      await expect(materializeTranscriptPage(index, 0, 1)).rejects.toBe(failure);
      expect(closed).toBe(1);
    } finally { spy.mockRestore(); }
  });
});

describe('ClaudeTranscriptHistoryIndex shared build subscriptions', () => {
  beforeEach(() => clearTranscriptIndexCache());

  it('cancels the first of two subscribers without cancelling the second real reader', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-subscriptions-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'shared question' } })}\n`);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = buildTranscriptIndex(path, { useWorker: false, signal: firstController.signal });
    const second = buildTranscriptIndex(path, { useWorker: false, signal: secondController.signal });
    firstController.abort();
    const [cancelled, result] = await Promise.all([first, second]);
    expect(cancelled).toEqual({ status: 'failed', error: 'History index build aborted' });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error(result.error);
    expect((await materializeTranscriptPage(result.index, 0, 1)).map(row => row.message?.content))
      .toEqual(['shared question']);
  });

  it.each([false, true])('keeps one physical build and independently reports progress after cancellation (worker=%s)', async useWorker => {
    resetTranscriptIndexWorkerProbe();
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-mid-subscription-${useWorker}-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'shared worker question' } })}\n`);
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    const controller = new AbortController();
    const secondProgress = jest.fn();
    const secondFinalize = jest.fn();
    let third: Promise<Awaited<ReturnType<typeof buildTranscriptIndex>>> | undefined;
    const first = buildTranscriptIndex(path, {
      useWorker, chunkSize: 16, signal: controller.signal,
      onProgress: () => {
        controller.abort();
        third = buildTranscriptIndex(path, { useWorker, chunkSize: 16 });
      },
    });
    const second = buildTranscriptIndex(path, { useWorker, chunkSize: 16, onProgress: secondProgress, onFinalize: secondFinalize });
    try {
      const [cancelled, result] = await Promise.all([first, second]);
      expect(cancelled.status).toBe('failed');
      expect(result.status).toBe('complete');
      if (result.status === 'failed') throw new Error(result.error);
      const thirdResult = await third!;
      expect(thirdResult.status).toBe('complete');
      if (thirdResult.status === 'failed') throw new Error(thirdResult.error);
      expect(thirdResult.index).toBe(result.index);
      expect(secondProgress).toHaveBeenCalled();
      expect(secondFinalize).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.phase === 'queued')).toHaveLength(1);
      expect(events.filter(event => event.phase === 'start').map(event => event.mode)).toEqual([useWorker ? 'worker' : 'direct']);
      expect((await materializeTranscriptPage(result.index, 0, 1))[0].message?.content).toBe('shared worker question');
    } finally { setTranscriptIndexDiagnosticSink(null); resetTranscriptIndexWorkerProbe(); }
  });

  it.each([false, true])('aborts only after the last cross-request subscriber exits and accepts a new subscriber (worker=%s)', async useWorker => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-last-subscription-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'last subscriber question' } })}\n`);
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    const firstController = new AbortController();
    const secondController = new AbortController();
    let progressed!: () => void;
    const progress = new Promise<void>(resolve => { progressed = resolve; });
    const first = buildTranscriptIndex(path, { useWorker, chunkSize: 16, signal: firstController.signal });
    const second = buildTranscriptIndex(path, { useWorker, chunkSize: 17, signal: secondController.signal, onProgress: progressed });
    try {
      await progress;
      firstController.abort();
      await expect(first).resolves.toMatchObject({ status: 'failed' });
      expect(events.some(event => event.phase === 'aborted')).toBe(false);
      secondController.abort();
      await expect(second).resolves.toMatchObject({ status: 'failed' });
      const fresh = await buildTranscriptIndex(path, { useWorker, chunkSize: 17 });
      expect(fresh.status).toBe('complete');
      if (fresh.status === 'failed') throw new Error(fresh.error);
      expect(fresh.fromCache).toBeUndefined();
      expect(events.filter(event => event.phase === 'queued')).toHaveLength(2);
      expect(events.filter(event => event.phase === 'aborted')).toHaveLength(1);
      expect((await materializeTranscriptPage(fresh.index, 0, 1))[0].message?.content).toBe('last subscriber question');
    } finally { firstController.abort(); secondController.abort(); setTranscriptIndexDiagnosticSink(null); }
  });

  it.each([
    [false, false, 'onProgress'], [false, true, 'onProgress'],
    [true, false, 'onProgress'], [true, true, 'onProgress'],
    [false, false, 'onFinalize'], [false, true, 'onFinalize'],
    [true, false, 'onFinalize'], [true, true, 'onFinalize'],
    [false, false, 'onLineSkipped'], [false, true, 'onLineSkipped'],
    [true, false, 'onLineSkipped'], [true, true, 'onLineSkipped'],
  ] as const)('second subscriber callback isolation (worker=%s, crossRequest=%s, callback=%s)', async (useWorker, crossRequest, callback) => {
    resetTranscriptIndexWorkerProbe();
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-callback-${useWorker}-${crossRequest}-${callback}-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'callback question' } })}\nmalformed row\n`);
    const reason = new Error(`synthetic ${callback} failure`);
    const throwingCallback = jest.fn(() => { throw reason; });
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    const first = buildTranscriptIndex(path, { useWorker, chunkSize: 16 });
    const second = buildTranscriptIndex(path, { useWorker, chunkSize: crossRequest ? 17 : 16, [callback]: throwingCallback });
    try {
      const [good, failed] = await Promise.all([first, second]);
      expect(good.status).toBe('complete');
      expect(failed).toEqual({ status: 'failed', error: reason.message });
      expect(throwingCallback).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.phase === 'queued')).toHaveLength(1);
      if (good.status === 'failed') throw new Error(good.error);
      expect((await materializeTranscriptPage(good.index, 0, 1))[0].message?.content).toBe('callback question');
      const cached = await buildTranscriptIndex(path, { useWorker, forceNewSnapshot: true });
      expect(cached.status).toBe('complete');
      if (cached.status === 'failed') throw new Error(cached.error);
      expect(cached.index).toBe(good.index);
      expect(cached.fromCache).toBe(true);
    } finally { setTranscriptIndexDiagnosticSink(null); resetTranscriptIndexWorkerProbe(); }
  });

  it.each([false, true])('cleans up a last failing callback and accepts a replacement flight (worker=%s)', async useWorker => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-last-callback-${useWorker}-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'replacement question' } })}\n`);
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    try {
      const failed = await buildTranscriptIndex(path, { useWorker, chunkSize: 16, onProgress: () => { throw new Error('last callback failed'); } });
      expect(failed).toEqual({ status: 'failed', error: 'last callback failed' });
      const replacement = await buildTranscriptIndex(path, { useWorker, chunkSize: 17 });
      expect(replacement.status).toBe('complete');
      if (replacement.status === 'failed') throw new Error(replacement.error);
      expect(replacement.fromCache).toBeUndefined();
      expect(events.filter(event => event.phase === 'queued')).toHaveLength(2);
      expect((await materializeTranscriptPage(replacement.index, 0, 1))[0].message?.content).toBe('replacement question');
      clearTranscriptIndexCache();
      expect(getTranscriptIndexCacheSize()).toBe(0);
    } finally { setTranscriptIndexDiagnosticSink(null); }
  });

  it.each([false, true])('registers the actual scanned snapshot after stat-open append (worker=%s)', async useWorker => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-actual-snapshot-${useWorker}-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'first question' } })}\n`);
    const stat = fsPromises.stat;
    let appended = false;
    const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
      const info = await stat(...args);
      if (args[0] === path && !appended) {
        appended = true;
        await fsPromises.appendFile(path, `${JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: 'second question' } })}\n`);
      }
      return info;
    });
    let first: Awaited<ReturnType<typeof buildTranscriptIndex>>;
    try { first = await buildTranscriptIndex(path, { useWorker }); }
    finally { statSpy.mockRestore(); }
    const same = await buildTranscriptIndex(path, { useWorker, forceNewSnapshot: true });
    expect(first.status).toBe('complete');
    expect(same.status).toBe('complete');
    if (first.status === 'failed' || same.status === 'failed') throw new Error('actual snapshot failed');
    expect(first.index.turns.map(turn => turn.turnId)).toEqual(['u1', 'u2']);
    expect(same.index).toBe(first.index);
    expect(same.fromCache).toBe(true);
    expect(getTranscriptIndexCacheSize()).toBe(1);
    expect(first.index.committedSize).toBe(first.index.snapshotSize);
  });

  it.each([
    ['cache', undefined], ['flight', undefined], ['cache', 'a1'], ['flight', 'a1'],
  ] as const)('reconciles an actual-key %s without duplicating its index instance (anchor=%s)', async (ownerKind, resumeAtMessageId) => {
    await coordinated(`actual owner=${ownerKind}, anchor=${resumeAtMessageId}`, async scope => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-actual-owner-${ownerKind}-${resumeAtMessageId ?? 'plain'}-${process.pid}.jsonl`);
    const base = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'first question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'first answer' } }),
    ].join('\n') + '\n';
    const tail = [
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'second question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'second answer' } }),
    ].join('\n') + '\n';
    await scope.wait('write snapshot', scope.track('write', writeFile(path, base)));
    const observed = scope.gate(), observation = scope.gate(), closing = scope.gate(), closeGate = scope.gate();
    const workerComplete = scope.gate();
    setTranscriptIndexDiagnosticSink(event => {
      if (event.phase === 'complete' && event.mode === 'worker') workerComplete.release();
    });
    const stat = fsPromises.stat;
    const open = fsPromises.open;
    let intercept = true;
    const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementation((...args) => scope.track('stat', (async () => {
      const info = await stat(...args);
      if (args[0] === path && intercept) {
        intercept = false;
        await fsPromises.appendFile(path, tail);
        observed.release();
        await observation.promise;
      }
      return info;
    })()));
    scope.restore(() => statSpy.mockRestore());
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementation((...args) => scope.track('open', (async () => {
      const opened = await open(...args);
      if (args[0] !== path) return opened;
      const handle = scope.handle(opened);
      if (ownerKind === 'flight') {
        const close = handle.close.bind(handle);
        handle.close = async () => { closing.release(); await closeGate.promise; await close(); };
      }
      return handle;
    })()));
    scope.restore(() => openSpy.mockRestore());
    const finalized = jest.fn();
    const original = scope.track('original subscription', buildTranscriptIndex(path, {
      useWorker: true, resumeAtMessageId, onFinalize: finalized, signal: scope.controller().signal,
    }));
    await scope.wait('original observed stat', observed.promise);
    const canonical = scope.track('canonical subscription', buildTranscriptIndex(path, {
      useWorker: false, resumeAtMessageId, forceNewSnapshot: true, signal: scope.controller().signal,
    }));
    if (ownerKind === 'cache') await scope.wait('canonical cache', canonical);
    else await scope.wait('canonical before close', closing.promise);
    observation.release();
    if (ownerKind === 'flight') {
      await scope.wait('worker complete', workerComplete.promise);
      await scope.wait('reconciliation turn', new Promise<void>(resolve => setImmediate(resolve)));
      closeGate.release();
    }
    const [first, owner] = await scope.wait('results', Promise.all([original, canonical]));
      if (first.status === 'failed' || owner.status === 'failed') throw new Error('actual owner failed');
      expect(first.index).toBe(owner.index);
      expect(finalized).toHaveBeenCalledTimes(1);
      expect(first.index.turns.map(turn => turn.turnId)).toEqual(resumeAtMessageId ? ['u1'] : ['u1', 'u2']);
      expect(first.index.committedSize).toBe(Buffer.byteLength(base + tail));
      const cached = await scope.wait('cached index', scope.track('cached subscription', buildTranscriptIndex(path, {
        useWorker: true, resumeAtMessageId, forceNewSnapshot: true, signal: scope.controller().signal,
      })));
      if (cached.status === 'failed') throw new Error(cached.error);
      expect(cached.index).toBe(owner.index);
      expect(cached.fromCache).toBe(true);
      expect(getTranscriptIndexCacheSize()).toBe(1);
    });
    clearTranscriptIndexCache();
    expect(getTranscriptIndexCacheSize()).toBe(0);
  });

  it.each([
    [false, 'complete', 'advance', 'index'], [true, 'complete', 'advance', 'index'],
    [false, 'partial', 'advance', 'index'], [true, 'partial', 'advance', 'index'],
    [false, 'complete', 'fail', 'index'], [true, 'complete', 'fail', 'index'],
    [false, 'partial', 'fail', 'index'], [true, 'partial', 'fail', 'index'],
    [false, 'complete', 'advance', 'lease'], [true, 'complete', 'advance', 'lease'],
    [false, 'partial', 'advance', 'lease'], [true, 'partial', 'advance', 'lease'],
    [false, 'complete', 'fail', 'lease'], [true, 'complete', 'fail', 'lease'],
    [false, 'partial', 'fail', 'lease'], [true, 'partial', 'fail', 'lease'],
  ] as const)('keeps proven snapshot when predicted owner changes or fails (worker=%s, snapshot=%s, owner=%s, consumer=%s)', async (useWorker, snapshotKind, ownerKind, consumer) => {
    await coordinated(`worker=${useWorker}, snapshot=${snapshotKind}, owner=${ownerKind}, consumer=${consumer}`, async scope => {
    resetTranscriptIndexWorkerProbe();
    if (!useWorker && consumer === 'lease') mockWorkerConstructorMode = 'throw';
    const vaultPath = process.env.TMPDIR ?? '/tmp';
    const path = join(vaultPath, `claudian-proven-${useWorker}-${snapshotKind}-${ownerKind}-${consumer}-${process.pid}.jsonl`);
    const row = (uuid: string, parentUuid: string | null) => `${JSON.stringify({ type: 'user', uuid, parentUuid,
      message: { content: `${uuid}-${'x'.repeat(1024)}` } })}\n`;
    const firstRow = row('u1', null);
    const secondRow = row('u2', 'u1');
    const thirdRow = row('u3', 'u2');
    const scannedSource = firstRow + secondRow + (snapshotKind === 'partial' ? thirdRow.slice(0, -1) : '');
    await scope.wait('write initial snapshot', scope.track('write', writeFile(path, firstRow)));
    const registered = scope.gate(), physicalComplete = scope.gate(), opening = scope.gate();
    const openGate = scope.gate(), statObserved = scope.gate(), statGate = scope.gate();
    const stat = fsPromises.stat;
    const open = fsPromises.open;
    let firstStat = true;
    let directAOpened = false;
    let ownerOpenIntercepted = false;
    const expectedOwnerOpenFailure = new Error('synthetic predicted-owner open failure');
    const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementation((...args) => scope.track('stat', (async () => {
      const info = await stat(...args);
      if (args[0] === path && firstStat) {
        firstStat = false;
        await fsPromises.appendFile(path, scannedSource.slice(firstRow.length));
        if (useWorker) { statObserved.release(); await statGate.promise; }
      }
      return info;
    })()));
    scope.restore(() => statSpy.mockRestore());
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementation((...args) => {
      const expectedOwnerOpen = ownerKind === 'fail' && args[0] === path && (useWorker || directAOpened) && !ownerOpenIntercepted;
      return scope.track('open', (async () => {
        if (args[0] !== path) return open(...args);
        if (!useWorker && !directAOpened) {
          directAOpened = true;
          const handle = scope.handle(await open(...args));
          const close = handle.close.bind(handle);
          handle.close = async () => { await registered.promise; await close(); };
          return handle;
        }
        if (!ownerOpenIntercepted) {
          ownerOpenIntercepted = true;
          opening.release();
          await openGate.promise;
          if (ownerKind === 'fail') throw expectedOwnerOpenFailure;
        }
        return scope.handle(await open(...args));
      })(), expectedOwnerOpen ? { reason: expectedOwnerOpenFailure } : undefined);
    });
    scope.restore(() => openSpy.mockRestore());
    const service = new ClaudeConversationHistoryService();
    const conversation: Conversation = { id: `proven-${useWorker}-${snapshotKind}-${ownerKind}`, providerId: 'claude',
      title: 'Synthetic', createdAt: 1, updatedAt: 1, sessionId: 'proven', messages: [] };
    if (consumer === 'lease') {
      const pathSpy = jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(path);
      scope.restore(() => pathSpy.mockRestore());
      const existsSpy = jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);
      scope.restore(() => existsSpy.mockRestore());
    }
    const ownerController = scope.controller(), originalController = scope.controller();
    let owner: Promise<Awaited<ReturnType<typeof buildTranscriptIndex>>> | undefined;
    const startOwner = () => {
      if (owner || scope.closing) return;
      scope.update('owner started');
      owner = scope.track('owner subscription', buildTranscriptIndex(path, {
        useWorker: false, chunkSize: 17, forceNewSnapshot: true, signal: ownerController.signal,
      }));
    };
    let lease: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    let fresh: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    scope.release(() => { lease?.release(); fresh?.release(); });
    let rejectFallback!: (error: Error) => void;
    const unexpectedFallback = new Promise<never>((_, reject) => { rejectFallback = reject; });
    void unexpectedFallback.catch(() => undefined);
    const wait = <T>(phase: string, promise: Promise<T>) => scope.wait(phase, Promise.race([promise, unexpectedFallback]));
    const onDiagnostic = (event: TranscriptIndexDiagnosticEvent) => {
      if (event.phase === 'index_worker_fallback' && useWorker && !scope.closing) {
        scope.update('unexpected worker fallback');
        openGate.release(); statGate.release();
        rejectFallback(new Error('Unexpected worker fallback'));
      }
      if (owner && event.phase === 'queued' && event.mode === 'direct') { scope.update('owner registered direct'); registered.release(); }
      if (event.phase === 'complete' && event.mode === (useWorker ? 'worker' : 'direct')) {
        scope.update(`original complete ${event.mode}`); physicalComplete.release();
      }
    };
    let original: Promise<Awaited<ReturnType<typeof buildTranscriptIndex>> | void>;
    if (consumer === 'lease') {
      lease = service.acquireHistoryIndex(conversation, vaultPath, event => { if (event.phase === 'indexing') startOwner(); });
      original = scope.track('original lease', lease.ready);
    } else original = scope.track('original subscription', buildTranscriptIndex(path, {
      useWorker, chunkSize: 16, onProgress: startOwner, signal: originalController.signal,
    }));
    // The service installs its own sink synchronously during acquisition.
    setTranscriptIndexDiagnosticSink(onDiagnostic);
    let resolved = false;
    void original.then(() => { resolved = true; }, () => { resolved = true; });
    if (useWorker) {
      await wait('original observed old stat', statObserved.promise);
      startOwner();
      await wait('owner before open', opening.promise);
      statGate.release();
    }
    await wait('original physical completion', physicalComplete.promise);
    await wait('owner before open', opening.promise);
    await wait('reconciliation turn', new Promise<void>(resolve => setImmediate(resolve)));
      expect(resolved).toBe(false);
      if (ownerKind === 'advance') await wait('advance snapshot', scope.track('append', fsPromises.appendFile(path, snapshotKind === 'partial' ? '\n' : thirdRow)));
      openGate.release();
      const ownerResult = await wait('owner result', owner!);
      expect(ownerResult.status).toBe(ownerKind === 'advance' ? 'complete' : 'failed');
      const result = await wait('original result', original);
      let observed: unknown;
      if (consumer === 'index') {
        if (!result || result.status === 'failed') throw new Error('proven scan was lost');
        const messages = await wait('materialize fixed page', scope.track('materialize', materializeTranscriptPage(result.index, 0, 2)));
        const refreshed = await wait('refresh index', scope.track('refresh', buildTranscriptIndex(path, {
          useWorker, forceNewSnapshot: true, signal: scope.controller().signal,
        })));
        if (refreshed.status === 'failed') throw new Error(refreshed.error);
        observed = {
          status: result.status, turns: result.index.turns.map(turn => turn.turnId),
          snapshotSize: result.index.snapshotSize, committedSize: result.index.committedSize,
          messageIds: messages.map(message => message.uuid),
          refreshedTurns: refreshed.index.turns.length, fromCache: refreshed.fromCache,
          sharesFixedIndex: refreshed.index === result.index, stillFixedTurns: result.index.turns.length,
        };
      } else {
        const page = await wait('materialize fixed lease', scope.track('lease page', lease!.loadWindow({ anchorTurn: 0, direction: 'newer',
          budget: { maxTurns: 5, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 0 }, projectionLevel: 'detail' })));
        const fixedTotal = lease!.totalTurns;
        fresh = service.acquireHistoryIndex(conversation, vaultPath, undefined, true);
        await wait('fresh lease', scope.track('fresh lease', fresh.ready));
        observed = {
          fixedTotal, messageIds: page.messages.map(message => message.id), committedSize: page.snapshotOffset,
          refreshedTurns: fresh.totalTurns, acquireOutcome: fresh.acquireOutcome, stillFixedTurns: lease!.totalTurns,
        };
      }
      expect(observed).toEqual(consumer === 'index' ? {
        status: snapshotKind === 'partial' ? 'partial' : 'complete', turns: ['u1', 'u2'],
        snapshotSize: Buffer.byteLength(scannedSource), committedSize: Buffer.byteLength(firstRow + secondRow),
        messageIds: ['u1', 'u2'], refreshedTurns: ownerKind === 'advance' ? 3 : 2, fromCache: true,
        sharesFixedIndex: ownerKind === 'fail', stillFixedTurns: 2,
      } : {
        fixedTotal: 2, messageIds: ['u1', 'u2'], committedSize: Buffer.byteLength(firstRow + secondRow),
        refreshedTurns: ownerKind === 'advance' ? 3 : 2, acquireOutcome: 'cache_hit', stillFixedTurns: 2,
      });
    });
    clearTranscriptIndexCache();
    expect(getTranscriptIndexCacheSize()).toBe(0);
  });

  it.each(['waiter', 'owner', 'first-of-two-waiters', 'new-actual-owner'] as const)(
    'preserves owner independence and exact pins during proven snapshot coordination (%s)', async cancelKind => {
      await coordinated(`cancellation=${cancelKind}, expected=worker`, async scope => {
      resetTranscriptIndexWorkerProbe();
      const pins: TranscriptHistoryIndex[] = [];
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-proof-cancel-${cancelKind}-${process.pid}.jsonl`);
      const row = (uuid: string, parentUuid: string | null) => `${JSON.stringify({ type: 'user', uuid, parentUuid, message: { content: uuid } })}\n`;
      const firstRow = row('u1', null), secondRow = row('u2', 'u1'), thirdRow = row('u3', 'u2');
      const physicalComplete = scope.gate(), opening = scope.gate(), openGate = scope.gate();
      const newOwnerRegistered = scope.gate(), oldOwnerComplete = scope.gate(), newOwnerGate = scope.gate();
      const statObserved = scope.gate(), statGate = scope.gate();
      const retain = (index: TranscriptHistoryIndex) => {
        if (scope.closing) return;
        protectTranscriptIndex(index); pins.push(index);
      };
      scope.release(() => pins.forEach(releaseTranscriptIndex));
      for (let index = 0; index < 8; index += 1) {
        const pinPath = `${path}.pin-${index}.jsonl`;
        await scope.wait('write pin', scope.track('pin write', writeFile(pinPath, row(`pin-${index}`, null))));
        const result = await scope.wait('build pin', scope.track('pin build', buildTranscriptIndex(pinPath, {
          useWorker: false, signal: scope.controller().signal,
        })));
        if (result.status === 'failed') throw new Error(result.error);
        retain(result.index);
      }
      await scope.wait('write original', scope.track('original write', writeFile(path, firstRow)));
      const stat = fsPromises.stat, open = fsPromises.open;
      let firstStat = true, ownerOpenIntercepted = false;
      const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementation((...args) => scope.track('stat', (async () => {
        const info = await stat(...args);
        if (args[0] === path && firstStat) {
          firstStat = false; await fsPromises.appendFile(path, secondRow); statObserved.release(); await statGate.promise;
        }
        return info;
      })()));
      scope.restore(() => statSpy.mockRestore());
      const openSpy = jest.spyOn(fsPromises, 'open').mockImplementation((...args) => scope.track('open', (async () => {
        if (args[0] === path && !ownerOpenIntercepted) {
          ownerOpenIntercepted = true; opening.release(); await openGate.promise;
        }
        const handle = await open(...args);
        return args[0] === path ? scope.handle(handle) : handle;
      })()));
      scope.restore(() => openSpy.mockRestore());
      const waiterController = scope.controller(), ownerController = scope.controller();
      let second: Promise<Awaited<ReturnType<typeof buildTranscriptIndex>>> | undefined;
      let owner: Promise<Awaited<ReturnType<typeof buildTranscriptIndex>>> | undefined;
      let newOwner: Promise<Awaited<ReturnType<typeof buildTranscriptIndex>>> | undefined;
      let newOwnerSettled = false;
      const events: TranscriptIndexDiagnosticEvent[] = [];
      let rejectFallback!: (error: Error) => void;
      const unexpectedFallback = new Promise<never>((_, reject) => { rejectFallback = reject; });
      void unexpectedFallback.catch(() => undefined);
      const wait = <T>(phase: string, promise: Promise<T>) => scope.wait(phase, Promise.race([promise, unexpectedFallback]));
      const startOwner = () => {
        if (!owner && !scope.closing) owner = scope.track('owner subscription', buildTranscriptIndex(path, {
          useWorker: false, chunkSize: 17, forceNewSnapshot: true, signal: ownerController.signal, onIndex: retain,
        }));
      };
      setTranscriptIndexDiagnosticSink(event => {
        events.push(event);
        if (event.phase === 'index_worker_fallback' && !scope.closing) {
          scope.update('unexpected worker fallback');
          openGate.release(); statGate.release(); newOwnerGate.release();
          rejectFallback(new Error('Unexpected worker fallback'));
        }
        if (owner && event.phase === 'queued' && event.mode === 'direct') scope.update('owner registered direct');
        if (event.phase === 'complete' && event.mode === 'worker' && !newOwner) physicalComplete.release();
        if (newOwner && event.phase === 'queued' && event.mode === 'worker') { scope.update('new worker owner registered'); newOwnerRegistered.release(); }
        if (newOwner && event.phase === 'complete' && event.mode === 'direct') oldOwnerComplete.release();
      });
      const original = scope.track('original subscription', buildTranscriptIndex(path, { useWorker: true, chunkSize: 16,
        signal: waiterController.signal, onProgress: startOwner, onIndex: retain }));
      if (cancelKind === 'first-of-two-waiters') second = scope.track('second subscription', buildTranscriptIndex(path, {
        useWorker: true, chunkSize: 16, onIndex: retain, signal: scope.controller().signal,
      }));
      await wait('original observed old stat', statObserved.promise);
      startOwner();
      await wait('owner before open', opening.promise);
      statGate.release();
      await wait('original worker complete', physicalComplete.promise);
      await wait('reconciliation turn', new Promise<void>(resolve => setImmediate(resolve)));
      if (cancelKind === 'waiter' || cancelKind === 'first-of-two-waiters') waiterController.abort();
      if (cancelKind === 'owner') ownerController.abort();
      await wait('advance snapshot', scope.track('append', fsPromises.appendFile(path, thirdRow)));
      if (cancelKind === 'new-actual-owner') {
        mockWorkerStartGate = newOwnerGate.promise;
        newOwner = scope.track('new owner subscription', buildTranscriptIndex(path, {
          useWorker: true, chunkSize: 19, forceNewSnapshot: true, onIndex: retain, signal: scope.controller().signal,
        }));
        void newOwner.then(() => { newOwnerSettled = true; }, () => { newOwnerSettled = true; });
        await wait('new owner registered', newOwnerRegistered.promise);
      }
      openGate.release();
      if (newOwner) {
        await wait('old owner physical complete', oldOwnerComplete.promise);
        await wait('candidate reconciliation turn', new Promise<void>(resolve => setImmediate(resolve)));
      }
      expect(newOwnerSettled).toBe(false);
      newOwnerGate.release();
      const [a, b, remaining, current] = await wait('all results', Promise.all([original, owner!, second, newOwner]));
        const summary = (value: Awaited<ReturnType<typeof buildTranscriptIndex>> | undefined) => ({
          status: value?.status ?? null,
          turns: value && value.status !== 'failed' ? value.index.turns.map(turn => turn.turnId) : null,
        });
        const currentIndex = current && current.status !== 'failed' ? current.index : undefined;
        const ownerIndex = b.status !== 'failed' ? b.index : undefined;
        const originalIndex = a.status !== 'failed' ? a.index : undefined;
        const waiterCancelled = cancelKind === 'waiter' || cancelKind === 'first-of-two-waiters';
        expect({ original: summary(a), owner: summary(b), remaining: summary(remaining), current: summary(current),
          sharesActualOwner: currentIndex ? ownerIndex === currentIndex : null,
          distinctFixedSnapshot: currentIndex ? originalIndex !== currentIndex : null,
        }).toEqual({
          original: { status: waiterCancelled ? 'failed' : 'complete', turns: waiterCancelled ? null : ['u1', 'u2'] },
          owner: { status: cancelKind === 'owner' ? 'failed' : 'complete', turns: cancelKind === 'owner' ? null : ['u1', 'u2', 'u3'] },
          remaining: { status: second ? 'complete' : null, turns: second ? ['u1', 'u2'] : null },
          current: { status: newOwner ? 'complete' : null, turns: newOwner ? ['u1', 'u2', 'u3'] : null },
          sharesActualOwner: newOwner ? true : null, distinctFixedSnapshot: newOwner ? true : null,
        });
        expect(events.filter(event => event.phase === 'queued')).toHaveLength(newOwner ? 3 : 2);
        clearTranscriptIndexCache();
        expect(getTranscriptIndexCacheSize()).toBe(cancelKind === 'first-of-two-waiters' || newOwner ? 10 : 9);
      });
      clearTranscriptIndexCache(); expect(getTranscriptIndexCacheSize()).toBe(0);
    },
  );

  it.each([[false, false], [false, true], [true, false], [true, true]] as const)(
    'requires a decision on semantic maxLineBytes identity (worker=%s, concurrent=%s)', async (useWorker, concurrent) => {
      resetTranscriptIndexWorkerProbe();
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-cap-identity-${useWorker}-${concurrent}-${process.pid}.jsonl`);
      await writeFile(path, [
        JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'short' } }),
        JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: 'x'.repeat(512) } }),
      ].join('\n') + '\n');
      const original = buildTranscriptIndex(path, { useWorker, maxLineBytes: 4096 });
      const limited = concurrent
        ? buildTranscriptIndex(path, { useWorker, maxLineBytes: 100 })
        : original.then(() => buildTranscriptIndex(path, { useWorker, maxLineBytes: 100, forceNewSnapshot: true }));
      const [full, capped] = await Promise.all([original, limited]);
      if (full.status === 'failed' || capped.status === 'failed') throw new Error('semantic policy probe failed');
      expect({ fullOpaque: full.index.entries.filter(entry => entry.oversized).map(entry => entry.messageKey),
        cappedOpaque: capped.index.entries.filter(entry => entry.oversized).map(entry => entry.messageKey),
      }).toEqual({ fullOpaque: [], cappedOpaque: ['u2'] });
    },
  );

  it.each([[false, false], [false, true], [true, false], [true, true]] as const)(
    'keeps reverse cap variants separate (worker=%s, concurrent=%s)', async (useWorker, concurrent) => {
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-reverse-cap-${useWorker}-${concurrent}-${process.pid}.jsonl`);
      await writeFile(path, [
        JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'short' } }),
        JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: 'x'.repeat(512) } }),
      ].join('\n') + '\n');
      const limited = buildTranscriptIndex(path, { useWorker, maxLineBytes: 100 });
      const full = concurrent ? buildTranscriptIndex(path, { useWorker, maxLineBytes: 4096 })
        : limited.then(() => buildTranscriptIndex(path, { useWorker, maxLineBytes: 4096, forceNewSnapshot: true }));
      const [capped, original] = await Promise.all([limited, full]);
      if (capped.status === 'failed' || original.status === 'failed') throw new Error('cap variant failed');
      expect({ cappedOpaque: capped.index.entries.filter(entry => entry.oversized).map(entry => entry.messageKey),
        fullOpaque: original.index.entries.filter(entry => entry.oversized).map(entry => entry.messageKey),
      }).toEqual({ cappedOpaque: ['u2'], fullOpaque: [] });
    },
  );

  it.each([['maxLineBytes', false], ['maxLineBytes', true], ['chunkSize', false], ['chunkSize', true]] as const)(
    'rejects invalid %s before cold/hot lookup (hot=%s)', async (parameter, hot) => {
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-invalid-${parameter}-${hot}-${process.pid}.jsonl`);
      await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'valid source' } })}\n`);
      if (hot) await buildTranscriptIndex(path, { useWorker: false });
      const events: TranscriptIndexDiagnosticEvent[] = [];
      setTranscriptIndexDiagnosticSink(event => events.push(event));
      const onIndex = jest.fn();
      try {
        for (const value of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, '100', true]) {
          const result = await buildTranscriptIndex(path, { useWorker: false, [parameter]: value, onIndex } as any);
          expect(result).toEqual({ status: 'failed', error: `Invalid history index ${parameter}: expected a positive finite safe integer` });
        }
        expect(onIndex).not.toHaveBeenCalled();
        expect(events).toEqual([]);
      } finally { setTranscriptIndexDiagnosticSink(null); }
    },
  );

  it.each([false, true])('carries a readonly frozen projection variant (worker=%s)', async useWorker => {
    resetTranscriptIndexWorkerProbe();
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-projection-proof-${useWorker}-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'projection identity' } })}\n`);
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    try {
      const options = { useWorker, maxLineBytes: 4096, resumeAtMessageId: '' };
      const pending = buildTranscriptIndex(path, options);
      options.maxLineBytes = 100; options.resumeAtMessageId = 'u1';
      const result = await pending;
      if (result.status === 'failed') throw new Error(result.error);
      const descriptor = Object.getOwnPropertyDescriptor(result.index, 'projectionVariantKey');
      expect({ value: descriptor?.value, writable: descriptor?.writable, configurable: descriptor?.configurable })
        .toEqual({ value: JSON.stringify([null, 4096]), writable: false, configurable: false });
      expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
      expect(events.filter(event => event.phase === 'complete').map(event => event.mode)).toEqual([useWorker ? 'worker' : 'direct']);
    } finally { setTranscriptIndexDiagnosticSink(null); resetTranscriptIndexWorkerProbe(); }
  });

  it.each([false, true])('normalizes defaults, plain resume and execution hints without replaying cache progress (worker=%s)', async useWorker => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-normalized-${useWorker}-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'normalization' } })}\n`);
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    const onIndex = jest.fn(), onProgress = jest.fn(), onFinalize = jest.fn(), onLineSkipped = jest.fn();
    try {
      const first = buildTranscriptIndex(path, { useWorker });
      const equivalent = buildTranscriptIndex(path, { useWorker, chunkSize: 1024 * 1024, maxLineBytes: 16 * 1024 * 1024, resumeAtMessageId: '' });
      const [a, b] = await Promise.all([first, equivalent]);
      if (a.status === 'failed' || b.status === 'failed') throw new Error('default normalization failed');
      expect(b.index).toBe(a.index);
      const hinted = await buildTranscriptIndex(path, { useWorker: !useWorker, chunkSize: 7,
        forceNewSnapshot: true, onIndex, onProgress, onFinalize, onLineSkipped });
      if (hinted.status === 'failed') throw new Error(hinted.error);
      expect(hinted.index).toBe(a.index); expect(hinted.fromCache).toBe(true);
      expect(onIndex).toHaveBeenCalledTimes(1);
      expect(onProgress).not.toHaveBeenCalled(); expect(onFinalize).not.toHaveBeenCalled(); expect(onLineSkipped).not.toHaveBeenCalled();
      expect(events.filter(event => event.phase === 'queued')).toHaveLength(1);
      expect(a.index.projectionVariantKey).toBe(JSON.stringify([null, 16 * 1024 * 1024]));
    } finally { setTranscriptIndexDiagnosticSink(null); }
  });

  it.each([false, true])('keeps exact resume spelling and rejects a capped opaque anchor (worker=%s)', async useWorker => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-anchor-policy-${useWorker}-${process.pid}.jsonl`);
    await writeFile(path, [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'short' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'x'.repeat(512) } }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'next' } }),
      JSON.stringify({ type: 'assistant', uuid: 'A1', parentUuid: 'u2', message: { content: 'upper' } }),
    ].join('\n') + '\n');
    const lower = await buildTranscriptIndex(path, { useWorker, maxLineBytes: 4096, resumeAtMessageId: 'a1' });
    const capped = await buildTranscriptIndex(path, { useWorker, maxLineBytes: 100, resumeAtMessageId: 'a1' });
    const upper = await buildTranscriptIndex(path, { useWorker, maxLineBytes: 4096, resumeAtMessageId: 'A1' });
    const spaced = await buildTranscriptIndex(path, { useWorker, maxLineBytes: 4096, resumeAtMessageId: ' a1 ' });
    if (lower.status === 'failed' || upper.status === 'failed' || spaced.status === 'failed') throw new Error('resume variant failed');
    expect(capped.status).toBe('failed');
    expect(lower.index.turns.map(turn => turn.turnId)).toEqual(['u1']);
    expect(upper.index.turns.map(turn => turn.turnId)).toEqual(['u1', 'u2']);
    expect([lower.index.projectionVariantKey, upper.index.projectionVariantKey, spaced.index.projectionVariantKey])
      .toEqual(['a1', 'A1', ' a1 '].map(anchor => JSON.stringify([anchor, 4096])));
  });

  it.each([false, true])('accepts safe upper numeric bounds and prioritizes pre-abort over invalid options (worker=%s)', async useWorker => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-numeric-bound-${useWorker}-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'small bounded source' } })}\n`);
    const result = await buildTranscriptIndex(path, { useWorker, maxLineBytes: Number.MAX_SAFE_INTEGER, chunkSize: Number.MAX_SAFE_INTEGER });
    expect(result.status).toBe('complete');
    const controller = new AbortController(); controller.abort();
    const onIndex = jest.fn();
    await expect(buildTranscriptIndex(path, { useWorker, maxLineBytes: 0, chunkSize: NaN, signal: controller.signal, onIndex }))
      .resolves.toEqual({ status: 'failed', error: 'History index build aborted' });
    expect(onIndex).not.toHaveBeenCalled();
  });

  it.each([false, true].flatMap(useWorker => [1, 7, 128].flatMap(chunkSize => [99, 100, 101].map(bytes => [useWorker, chunkSize, bytes] as const))))(
    'keeps byte caps exact across chunks, CRLF and UTF8 (worker=%s, chunk=%s, bytes=%s)', async (useWorker, chunkSize, bytes) => {
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-byte-cap-${useWorker}-${chunkSize}-${bytes}-${process.pid}.jsonl`);
      const text = '你🙂';
      const row = (content: string) => JSON.stringify({ type: 'user', uuid: 'u1', message: { content } });
      const content = text + 'x'.repeat(bytes - 1 - Buffer.byteLength(row(text)));
      const line = row(content) + '\r';
      await writeFile(path, line + '\n');
      const events: TranscriptIndexDiagnosticEvent[] = [];
      setTranscriptIndexDiagnosticSink(event => events.push(event));
      try {
        const result = await buildTranscriptIndex(path, { useWorker, chunkSize, maxLineBytes: 100 });
        if (result.status === 'failed') throw new Error(result.error);
        const materialized = await materializeTranscriptPage(result.index, 0, 1);
        expect({ status: result.status, length: result.index.entries[0].length, opaque: result.index.entries[0].oversized === true,
          content: materialized[0]?.message?.content ?? null, committed: result.index.committedSize })
          .toEqual({ status: 'complete', length: bytes, opaque: bytes > 100, content: bytes > 100 ? null : content, committed: bytes + 1 });
        expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
      } finally { setTranscriptIndexDiagnosticSink(null); }
    },
  );

  it.each([false, true])('heals a capped partial row only after its LF closes the source snapshot (worker=%s)', async useWorker => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-cap-partial-${useWorker}-${process.pid}.jsonl`);
    const prefix = `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'first' } })}\n`;
    const tail = JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: 'x'.repeat(512) } });
    await writeFile(path, prefix + tail);
    const partial = await buildTranscriptIndex(path, { useWorker, chunkSize: 7, maxLineBytes: 100 });
    await fsPromises.appendFile(path, '\n');
    const complete = await buildTranscriptIndex(path, { useWorker, chunkSize: 7, maxLineBytes: 100, forceNewSnapshot: true });
    if (partial.status === 'failed' || complete.status === 'failed') throw new Error('capped partial failed');
    expect({ oldStatus: partial.status, oldCommitted: partial.index.committedSize, newStatus: complete.status,
      newCommitted: complete.index.committedSize, opaque: complete.index.entries.filter(entry => entry.oversized).map(entry => entry.messageKey) })
      .toEqual({ oldStatus: 'partial', oldCommitted: Buffer.byteLength(prefix), newStatus: 'complete',
        newCommitted: Buffer.byteLength(prefix + tail + '\n'), opaque: ['u2'] });
  });

  it('encodes S/P/C from result-owned metadata without an outer projection label', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-result-identity-${process.pid}.jsonl`);
    const prefix = `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'short' } })}\n`;
    await writeFile(path, prefix + JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: 'x'.repeat(512) } }) + '\n');
    const full = await buildTranscriptIndex(path, { useWorker: false, maxLineBytes: 4096 });
    const capped = await buildTranscriptIndex(path, { useWorker: false, maxLineBytes: 100 });
    if (full.status === 'failed' || capped.status === 'failed') throw new Error('identity source failed');
    expect(builtIndexCacheKey(full.index)).not.toBe(builtIndexCacheKey(capped.index));
    const [snapshot, projection] = JSON.parse(builtIndexCacheKey(full.index));
    expect(JSON.parse(snapshot)).toEqual([path, full.index.dev, full.index.ino, full.index.snapshotSize, full.index.mtimeMs, full.index.ctimeMs]);
    expect(JSON.parse(projection)).toEqual([null, 4096]);
    expect(transcriptIndexResultIdentity(full)).not.toBe(transcriptIndexResultIdentity(capped));
    // Mechanical codec checks only: today's reader emits one fixed partial
    // error message, so distinct partial errors have no production trigger.
    const partial = { status: 'partial' as const, index: full.index, error: 'reason "one"\n' };
    const otherError = { ...partial, error: 'reason two' };
    const otherCoverage = { ...partial, index: { ...full.index, committedSize: Buffer.byteLength(prefix) } };
    expect(transcriptIndexResultIdentity(partial)).not.toBe(transcriptIndexResultIdentity(otherError));
    expect(transcriptIndexResultIdentity(partial)).not.toBe(transcriptIndexResultIdentity(otherCoverage));
    expect(transcriptIndexResultIdentity(partial)).not.toBe(transcriptIndexResultIdentity(full));
  });

  it.each([false, true])('rekeys a partial actual snapshot without losing committedSize (worker=%s)', async useWorker => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-actual-partial-${useWorker}-${process.pid}.jsonl`);
    const prefix = `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'committed question' } })}\n`;
    await writeFile(path, prefix);
    const stat = fsPromises.stat;
    let calls = 0;
    const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
      const info = await stat(...args);
      if (args[0] === path) {
        calls += 1;
        if (calls === 1) await fsPromises.appendFile(path, '{"type":"user","uuid":"u2"');
      }
      return info;
    });
    try {
      const first = await buildTranscriptIndex(path, { useWorker });
      const same = await buildTranscriptIndex(path, { useWorker, forceNewSnapshot: true });
      expect(first.status).toBe('partial');
      expect(same.status).toBe('partial');
      if (first.status === 'failed' || same.status === 'failed') throw new Error('partial failed');
      expect(same.index).toBe(first.index);
      expect(same.fromCache).toBe(true);
      expect(first.index.committedSize).toBe(Buffer.byteLength(prefix));
      expect(first.index.snapshotSize).toBeGreaterThan(first.index.committedSize);
      expect(calls).toBe(2);
    } finally { statSpy.mockRestore(); }
  });

  it('does not let a late old flight delete the same-key replacement physical build', async () => coordinated('same-key replacement', async scope => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-flight-cas-${process.pid}.jsonl`);
    await scope.wait('write snapshot', scope.track('write', writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'CAS question' } })}\n`)));
    const oldClose = scope.gate(), freshClose = scope.gate(), oldClosing = scope.gate(), freshClosing = scope.gate();
    const queued = scope.gate(), progress = scope.gate(), statObserved = scope.gate();
    const open = fsPromises.open;
    let opens = 0;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementation((...args) => scope.track('open', (async () => {
      const opened = await open(...args);
      if (args[0] !== path) return opened;
      const handle = scope.handle(opened);
      const ordinal = ++opens;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (ordinal === 1) { oldClosing.release(); await oldClose.promise; }
        if (ordinal === 2) { freshClosing.release(); await freshClose.promise; }
        await close();
      };
      return handle;
    })()));
    scope.restore(() => openSpy.mockRestore());
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => {
      events.push(event);
      if (events.filter(item => item.phase === 'queued').length === 2) queued.release();
    });
    const controller = scope.controller();
    const old = scope.track('old subscription', buildTranscriptIndex(path, {
      useWorker: false, chunkSize: 16, signal: controller.signal, onProgress: progress.release,
    }));
    await scope.wait('old progress', progress.promise);
    controller.abort();
    await scope.wait('old before close', oldClosing.promise);
    // Different request options still share the exact same physical snapshot.
    const fresh = scope.track('fresh subscription', buildTranscriptIndex(path, {
      useWorker: false, chunkSize: 17, signal: scope.controller().signal,
    }));
    await scope.wait('replacement queued', queued.promise);
    oldClose.release();
    await scope.wait('old subscription', old);
    await scope.wait('fresh before close', freshClosing.promise);
    const stat = fsPromises.stat;
    const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementation((...args) => scope.track('stat', (async () => {
      const info = await stat(...args);
      statObserved.release();
      return info;
    })()));
    scope.restore(() => statSpy.mockRestore());
    const third = scope.track('third subscription', buildTranscriptIndex(path, {
      useWorker: false, chunkSize: 19, signal: scope.controller().signal,
    }));
    await scope.wait('third observed stat', statObserved.promise);
    await scope.wait('third registration turn', new Promise<void>(resolve => setImmediate(resolve)));
    statSpy.mockRestore();
    freshClose.release();
    const [freshResult, thirdResult] = await scope.wait('results', Promise.all([fresh, third]));
    expect(events.filter(event => event.phase === 'queued')).toHaveLength(2);
    expect(freshResult.status).toBe('complete');
    expect(thirdResult.status).toBe('complete');
    if (freshResult.status === 'failed' || thirdResult.status === 'failed') throw new Error('replacement failed');
    expect(thirdResult.index).toBe(freshResult.index);
    expect((await scope.wait('materialize', scope.track('materialize', materializeTranscriptPage(thirdResult.index, 0, 1))))[0].message?.content).toBe('CAS question');
  }));
});

describe('ClaudeTranscriptHistoryIndex oversized line degradation', () => {
  const oversizedRow = JSON.stringify({
    type: 'user',
    uuid: 'tr1',
    parentUuid: 'tu0',
    timestamp: '2026-01-01T00:00:00Z',
    sourceToolUseID: 'toolu_1',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `SECRET ${'x'.repeat(200)}` }] },
  });
  const userRow = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'question' } });
  const answerRow = JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'tr1', message: { content: 'answer' } });

  async function writeOversizedFixture(path: string): Promise<void> {
    await writeFile(path, `${[userRow, oversizedRow, answerRow].join('\n')}\n`);
  }

  it.each([7, 64, 512])(
    'replaces an oversized line with an opaque entry and parses the following line (chunkSize %d)',
    async chunkSize => {
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-oversized-${process.pid}-${chunkSize}.jsonl`);
      await writeOversizedFixture(path);
      const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize, maxLineBytes: 100 });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;
      const [first, opaque, last] = result.index.entries;
      expect(result.index.entries).toHaveLength(3);
      expect(first).toMatchObject({ messageKey: 'u1', offset: 0, length: Buffer.byteLength(userRow) });
      expect(opaque).toMatchObject({
        oversized: true,
        offset: Buffer.byteLength(userRow) + 1,
        length: Buffer.byteLength(oversizedRow),
        type: 'user',
        uuid: 'tr1',
        parentUuid: 'tu0',
        timestamp: '2026-01-01T00:00:00Z',
        sourceToolUseID: 'toolu_1',
        toolResultIds: ['toolu_1'],
        realUser: false,
        displayable: false,
        isMeta: false,
      });
      // The opaque row is never a real user: it neither opens a turn nor
      // enters the search corpus.
      expect(result.index.turns.map(turn => turn.turnId)).toEqual(['u1']);
      expect(opaque.turnId).toBe('u1');
      expect(result.index.searchCorpus.map(item => item.projectionKey)).toEqual(['u1', 'a2']);
      expect(result.index.searchText).not.toContain('SECRET');
      expect(last).toMatchObject({
        messageKey: 'a2',
        offset: Buffer.byteLength(userRow) + 1 + Buffer.byteLength(oversizedRow) + 1,
        length: Buffer.byteLength(answerRow),
      });
    },
  );

  it('falls back to an unknown opaque entry when the oversized prefix yields no reliable facts', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-oversized-unknown-${process.pid}.jsonl`);
    await writeFile(path, `${userRow}\n${'x'.repeat(150)}\n${answerRow}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 13, maxLineBytes: 100 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const opaque = result.index.entries[1];
    expect(opaque).toMatchObject({
      oversized: true,
      type: 'unknown',
      messageKey: 'line:1',
      length: 150,
      realUser: false,
    });
    expect(opaque.uuid).toBeUndefined();
    expect(opaque.toolResultIds).toEqual([]);
    // The line after the unusable oversized row still parses at its exact offset.
    expect(result.index.entries[2]).toMatchObject({ messageKey: 'a2', offset: Buffer.byteLength(userRow) + 1 + 151 });
  });

  it('returns partial with committedSize at the oversized line start when EOF never closes it', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-oversized-eof-${process.pid}.jsonl`);
    await writeFile(path, `${userRow}\n${'x'.repeat(150)}`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 13, maxLineBytes: 100 });
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1']);
    expect(result.index.committedSize).toBe(Buffer.byteLength(userRow) + 1);
    expect(result.index.snapshotSize).toBe(Buffer.byteLength(userRow) + 1 + 150);
    expect(result.error).toMatch(/incomplete/i);
  });

  it('keeps committedSize after the last newline for a plain trailing half-line', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-halfline-${process.pid}.jsonl`);
    await writeFile(path, `${userRow}\n${answerRow}\n{"type":"user","uuid":"u3","par`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 9 });
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    const committed = Buffer.byteLength(userRow) + 1 + Buffer.byteLength(answerRow) + 1;
    expect(result.index.committedSize).toBe(committed);
    expect(result.index.snapshotSize).toBeGreaterThan(committed);
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a2']);
  });

  it('records line_skipped diagnostics with separated reasons and no content', async () => {
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    try {
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-lineskip-${process.pid}.jsonl`);
      const malformed = '{"type":"user","uuid":"broken" oops}';
      await writeFile(path, `${userRow}\n${oversizedRow}\n${malformed}\n${answerRow}\n`);
      const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 16, maxLineBytes: 100 });
      expect(result.status).toBe('complete');
      const skipped = events.filter(event => event.phase === 'line_skipped');
      expect(skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: 'oversized',
          offset: Buffer.byteLength(userRow) + 1,
          bytes: Buffer.byteLength(oversizedRow),
          mode: 'direct',
          buildId: expect.any(String),
        }),
        expect.objectContaining({ reason: 'malformed' }),
      ]));
      expect(JSON.stringify(events)).not.toContain('SECRET');
    } finally {
      setTranscriptIndexDiagnosticSink(null);
    }
  });

  it('refuses a resume anchor that falls inside an oversized line', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-anchor-opaque-${process.pid}.jsonl`);
    await writeOversizedFixture(path);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 13, maxLineBytes: 100, resumeAtMessageId: 'tr1' });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toMatch(/oversized/i);
  });

  it('refuses a resume anchor when an oversized line without reliable uuid breaks ancestry verification', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-anchor-unverified-${process.pid}.jsonl`);
    await writeFile(path, `${userRow}\n${'x'.repeat(150)}\n${answerRow}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 13, maxLineBytes: 100, resumeAtMessageId: 'u1' });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toMatch(/oversized/i);
  });

  it('still honors a resume anchor when the oversized line on the ancestry has reliable facts', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-anchor-resolved-${process.pid}.jsonl`);
    // A contiguous chain u1 -> oversized tr1 -> a2 -> u3 so the resume walk
    // must pass through the opaque row to reach the anchor.
    const chainedOversized = JSON.stringify({
      type: 'user', uuid: 'tr1', parentUuid: 'u1', sourceToolUseID: 'toolu_1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(200) }] },
    });
    const answer = JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'tr1', message: { content: 'answer' } });
    const later = JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: 'a2', message: { content: 'later' } });
    await writeFile(path, `${[userRow, chainedOversized, answer, later].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 13, maxLineBytes: 100, resumeAtMessageId: 'a2' });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    // Truncation lands on the requested anchor, not on the opaque row or the tail.
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'tr1', 'a2']);
  });
});

describe('ClaudeTranscriptHistoryIndex resume cache identity', () => {
  // The completed/in-flight cache identity must include the resume projection
  // variant: finalizeIndex applies anchor truncation and the oversized-ancestry
  // fail-close only on the resume path, so a plain entry of the same snapshot
  // must never serve a fork's resume build, and a truncated resume entry must
  // never serve a later plain build.
  const forkLines = [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'question' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'answer' } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'after checkpoint' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'later answer' } }),
  ];

  beforeEach(() => {
    clearTranscriptIndexCache();
  });

  async function writeForkTranscript(name: string): Promise<string> {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-resume-cache-${name}-${process.pid}.jsonl`);
    await writeFile(path, `${forkLines.join('\n')}\n`);
    return path;
  }

  it('rebuilds a resume build instead of reusing the plain completed entry of the same snapshot', async () => {
    const path = await writeForkTranscript('plain-first');
    const plain = await buildTranscriptIndex(path, { useWorker: false });
    expect(plain.status).toBe('complete');
    if (plain.status !== 'complete') return;
    expect(plain.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1', 'u2', 'a2']);

    const resume = await buildTranscriptIndex(path, { useWorker: false, resumeAtMessageId: 'a1' });
    expect(resume.status).toBe('complete');
    if (resume.status !== 'complete') return;
    expect(resume.fromCache).toBeUndefined();
    expect(resume.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1']);
  });

  it('does not serve a truncated resume entry to a later plain build', async () => {
    const path = await writeForkTranscript('resume-first');
    const resume = await buildTranscriptIndex(path, { useWorker: false, resumeAtMessageId: 'a1' });
    expect(resume.status).toBe('complete');
    if (resume.status !== 'complete') return;
    expect(resume.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1']);

    const plain = await buildTranscriptIndex(path, { useWorker: false });
    expect(plain.status).toBe('complete');
    if (plain.status !== 'complete') return;
    expect(plain.fromCache).toBeUndefined();
    expect(plain.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('serves the same snapshot and same resume anchor from the completed cache', async () => {
    const path = await writeForkTranscript('resume-hit');
    const first = await buildTranscriptIndex(path, { useWorker: false, resumeAtMessageId: 'a1' });
    expect(first.status).toBe('complete');
    if (first.status !== 'complete') return;
    const second = await buildTranscriptIndex(path, { useWorker: false, resumeAtMessageId: 'a1' });
    expect(second.status).toBe('complete');
    if (second.status !== 'complete') return;
    expect(second.fromCache).toBe(true);
    expect(second.index).toBe(first.index);
  });

  it('does not share an in-flight build between plain and resume variants of the same snapshot', async () => {
    const path = await writeForkTranscript('concurrent');
    const plain = buildTranscriptIndex(path, { useWorker: false });
    const resume = buildTranscriptIndex(path, { useWorker: false, resumeAtMessageId: 'a1' });
    expect(resume).not.toBe(plain);
    const [plainResult, resumeResult] = await Promise.all([plain, resume]);
    expect(plainResult.status).toBe('complete');
    if (plainResult.status !== 'complete') return;
    expect(plainResult.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(resumeResult.status).toBe('complete');
    if (resumeResult.status !== 'complete') return;
    expect(resumeResult.index).not.toBe(plainResult.index);
    expect(resumeResult.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1']);
  });
});

describe('ClaudeTranscriptHistoryIndex oversized identity recovery (dual bounded scans)', () => {
  const KIB = 1024;
  const userRow = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'question' } });
  const answerRow = JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'tr1', message: { content: 'answer' } });

  // CC row order: identity prefixes first, the message payload mid-row, uuid/
  // timestamp after the message, then the long structural tail (toolUseResult,
  // cwd, sessionId, version). A giant message.content hides the trailing
  // identity from the 256 KiB prefix scan; only the tail scan can recover it.
  function messageHugeRow(content: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      parentUuid: 'u1',
      isSidechain: false,
      promptId: 'p1',
      type: 'user',
      message: { role: 'user', content },
      uuid: 'tr1',
      timestamp: '2026-01-01T00:00:00Z',
      toolUseResult: 'tail-result',
      cwd: '/vault',
      sessionId: 's1',
      version: '1.0.0',
      ...extra,
    });
  }

  function tempPath(name: string): string {
    return join(process.env.TMPDIR ?? '/tmp', `claudian-dual-${name}-${process.pid}.jsonl`);
  }

  it('recovers uuid/timestamp from the tail window when a huge message.content hides them from the prefix scan', async () => {
    const path = tempPath('message-huge');
    const huge = messageHugeRow(`SECRET-PAYLOAD ${'x'.repeat(600 * KIB)}`);
    await writeFile(path, `${[userRow, huge, answerRow].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const opaque = result.index.entries[1];
    expect(opaque).toMatchObject({
      oversized: true,
      type: 'user',
      uuid: 'tr1',
      parentUuid: 'u1',
      timestamp: '2026-01-01T00:00:00Z',
      messageKey: 'tr1',
    });
    // With uuid/parentUuid restored the ancestry chain is whole, so the
    // branch filter keeps the history before the oversized row instead of
    // silently dropping it.
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'tr1', 'a2']);
    expect(result.index.searchText).not.toContain('SECRET-PAYLOAD');
  });

  it('honors a resume anchor through a suffix-recovered oversized row (fork/rewind hydration shape)', async () => {
    const path = tempPath('resume-suffix');
    const huge = messageHugeRow('resume payload '.repeat(40 * KIB));
    await writeFile(path, `${[userRow, huge, answerRow].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100, resumeAtMessageId: 'a2' });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    // The resume walk must pass through the opaque row via the tail-recovered
    // uuid/parentUuid and land on the requested anchor with history intact.
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'tr1', 'a2']);
  });

  it('keeps identity unresolved when giant fields occlude both windows and refuses resume explicitly', async () => {
    const path = tempPath('both-occluded');
    const row = messageHugeRow('x'.repeat(400 * KIB), { toolUseResult: 'y'.repeat(400 * KIB) });
    await writeFile(path, `${[userRow, row, answerRow].join('\n')}\n`);
    const plain = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    expect(plain.status).toBe('complete');
    if (plain.status !== 'complete') return;
    const opaque = plain.index.entries[1];
    expect(opaque.oversized).toBe(true);
    expect(opaque.uuid).toBeUndefined();
    // The prefix still proves the row-start identity fields it can see.
    expect(opaque.parentUuid).toBe('u1');
    expect(opaque.type).toBe('user');
    // Session-level fail-close: an unverifiable ancestry must fail the resume
    // build explicitly instead of silently guessing a branch — including when
    // the plain entry for the same snapshot already sits in the completed
    // cache, which is exactly the fork-after-source-hydration shape.
    const resume = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100, resumeAtMessageId: 'a2' });
    expect(resume.status).toBe('failed');
    if (resume.status !== 'failed') return;
    expect(resume.error).toMatch(/oversized/i);
  });

  it('drops a conflicting duplicate uuid to unknown instead of guessing', async () => {
    const path = tempPath('conflict');
    // Duplicate top-level uuid never round-trips JSON.stringify; build the
    // row by hand so the prefix and tail windows see different values.
    const row = `{"type":"user","uuid":"prefix-id","message":{"content":"${'x'.repeat(600 * KIB)}"},"uuid":"suffix-id","timestamp":"2026-01-01T00:00:00Z"}`;
    await writeFile(path, `${[userRow, row, answerRow].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const opaque = result.index.entries[1];
    expect(opaque.oversized).toBe(true);
    expect(opaque.uuid).toBeUndefined();
    expect(opaque.messageKey).toBe('line:1');
    // Non-conflicting fields keep their proven values.
    expect(opaque.type).toBe('user');
    expect(opaque.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('never mistakes keys inside string content for identity fields', async () => {
    const path = tempPath('fake-key');
    const content = `${'x'.repeat(600 * KIB)} before "uuid":"fake-inside" after`;
    const row = messageHugeRow(content);
    await writeFile(path, `${[userRow, row, answerRow].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const opaque = result.index.entries[1];
    expect(opaque.uuid).toBe('tr1');
    expect(opaque.uuid).not.toBe('fake-inside');
  });

  it('leaves identity unknown when the tail window is cut inside a giant string holding fake keys', async () => {
    const path = tempPath('fake-tail');
    const row = messageHugeRow('z'.repeat(400 * KIB), { toolUseResult: `fake "uuid":"fake-tail" head ${'y'.repeat(400 * KIB)}` });
    await writeFile(path, `${[userRow, row, answerRow].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const opaque = result.index.entries[1];
    expect(opaque.oversized).toBe(true);
    // The tail scan fails inside the giant toolUseResult string; the fake key
    // it contains must never surface as a recovered identity.
    expect(opaque.uuid).toBeUndefined();
    expect(opaque.parentUuid).toBe('u1');
  });

  it('uses a single forward scan over the merged coverage when the bounded windows overlap', async () => {
    const path = tempPath('overlap');
    const row = messageHugeRow('w'.repeat(280 * KIB));
    await writeFile(path, `${[userRow, row, answerRow].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const opaque = result.index.entries[1];
    expect(opaque.uuid).toBe('tr1');
    expect(opaque.parentUuid).toBe('u1');
  });

  it('handles multi-byte content and escaped quotes/backslashes around the tail window', async () => {
    const path = tempPath('utf8-escape');
    const content = `开头 ${'多字节🎉尾部'.repeat(32 * KIB)} quote:\\" backslash:\\\\ end`;
    const row = messageHugeRow(content);
    await writeFile(path, `${[userRow, row, answerRow].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const opaque = result.index.entries[1];
    expect(opaque.uuid).toBe('tr1');
    expect(opaque.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(opaque.type).toBe('user');
    expect(opaque.parentUuid).toBe('u1');
  });

  it('still recovers a giant toolUseResult row through the prefix window alone', async () => {
    const path = tempPath('toolresult-huge');
    const row = messageHugeRow('normal body', { toolUseResult: 'r'.repeat(600 * KIB) });
    await writeFile(path, `${[userRow, row, answerRow].join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    const opaque = result.index.entries[1];
    expect(opaque).toMatchObject({
      oversized: true,
      type: 'user',
      uuid: 'tr1',
      parentUuid: 'u1',
      timestamp: '2026-01-01T00:00:00Z',
    });
  });

  it('reports identity recovery provenance in line_skipped diagnostics without leaking values', async () => {
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    try {
      const messageHugePath = tempPath('diag-message');
      await writeFile(messageHugePath, `${[userRow, messageHugeRow(`SECRET ${'x'.repeat(600 * KIB)}`), answerRow].join('\n')}\n`);
      const suffixResult = await buildTranscriptIndex(messageHugePath, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
      expect(suffixResult.status).toBe('complete');

      const occludedPath = tempPath('diag-occluded');
      await writeFile(occludedPath, `${[userRow, messageHugeRow('x'.repeat(400 * KIB), { toolUseResult: 'y'.repeat(400 * KIB) }), answerRow].join('\n')}\n`);
      const unresolvedResult = await buildTranscriptIndex(occludedPath, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
      expect(unresolvedResult.status).toBe('complete');

      const conflictPath = tempPath('diag-conflict');
      const conflictRow = `{"type":"user","uuid":"prefix-id","message":{"content":"${'x'.repeat(600 * KIB)}"},"uuid":"suffix-id","timestamp":"2026-01-01T00:00:00Z"}`;
      await writeFile(conflictPath, `${[userRow, conflictRow, answerRow].join('\n')}\n`);
      const conflictResult = await buildTranscriptIndex(conflictPath, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
      expect(conflictResult.status).toBe('complete');

      const toolResultPath = tempPath('diag-toolresult');
      await writeFile(toolResultPath, `${[userRow, messageHugeRow('normal', { toolUseResult: 'r'.repeat(600 * KIB) }), answerRow].join('\n')}\n`);
      const prefixResult = await buildTranscriptIndex(toolResultPath, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
      expect(prefixResult.status).toBe('complete');

      const skipped = events.filter(event => event.phase === 'line_skipped');
      expect(skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'oversized', identityRecovery: 'suffix', recoveredIdentityFields: ['uuid', 'parentUuid', 'type', 'timestamp'] }),
        expect.objectContaining({ reason: 'oversized', identityRecovery: 'unresolved' }),
        expect.objectContaining({ reason: 'oversized', identityRecovery: 'conflict' }),
        expect.objectContaining({ reason: 'oversized', identityRecovery: 'prefix' }),
      ]));
      // Diagnostics carry provenance enums and field names only — never
      // identity values or line content.
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain('tr1');
      expect(serialized).not.toContain('SECRET');
      expect(serialized).not.toContain('prefix-id');
      expect(serialized).not.toContain('suffix-id');
    } finally {
      setTranscriptIndexDiagnosticSink(null);
    }
  });

  it('does not report line_skipped for an oversized line still open at EOF, then reports it exactly once after it closes', async () => {
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    try {
      const path = tempPath('eof-discard');
      const fullRow = messageHugeRow('e'.repeat(400 * KIB));
      // First snapshot: EOF arrives while the oversized line is still open —
      // no opaque entry exists yet, so no line_skipped may be reported.
      await writeFile(path, `${userRow}\n${fullRow.slice(0, 300 * KIB)}`);
      const first = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
      expect(first.status).toBe('partial');
      expect(events.filter(event => event.phase === 'line_skipped')).toHaveLength(0);

      // The writer closes the line; the rebuild reports it exactly once.
      await writeFile(path, `${userRow}\n${fullRow}\n${answerRow}\n`);
      const second = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
      expect(second.status).toBe('complete');
      if (second.status !== 'complete') return;
      const oversizedEvents = events.filter(event => event.phase === 'line_skipped');
      expect(oversizedEvents).toHaveLength(1);
      expect(oversizedEvents[0]).toMatchObject({ reason: 'oversized', identityRecovery: expect.any(String) });
      expect(second.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'tr1', 'a2']);
    } finally {
      setTranscriptIndexDiagnosticSink(null);
    }
  });
});

describe('partial snapshot handling through the history service', () => {
  const budget = {
    maxTurns: 25,
    maxSourceBytes: 8 * 1024 * 1024,
    maxProjectedChars: 2_000_000,
    timeSliceMs: 8,
  };
  const fixtureDir = join(process.env.TMPDIR ?? '/tmp', `claudian-partial-${process.pid}`);

  function conversationFor(sessionId: string, extra: Record<string, unknown> = {}): Conversation {
    return {
      id: `partial-${sessionId}`, providerId: 'claude', title: 'Partial', createdAt: 1, updatedAt: 1,
      sessionId, providerState: { providerSessionId: sessionId, ...extra }, messages: [],
    };
  }

  beforeEach(async () => {
    await (await import('fs/promises')).rm(fixtureDir, { recursive: true, force: true });
    await (await import('fs/promises')).mkdir(fixtureDir, { recursive: true });
  });

  afterAll(async () => {
    await (await import('fs/promises')).rm(fixtureDir, { recursive: true, force: true });
  });

  it('opens the committed prefix of a session whose last line is still being written', async () => {
    const firstLine = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'first question' } });
    const path = join(fixtureDir, 'half-written.jsonl');
    await writeFile(path, `${firstLine}\n{"type":"user","uuid":"u2","par`);
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(path);
    jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);

    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversationFor('half-written'), fixtureDir);
    // A partial snapshot must open, not fail: everything before the last
    // complete newline is a valid conversation prefix.
    await expect(lease.ready).resolves.toBeUndefined();
    expect(lease.totalTurns).toBe(1);

    const page = await lease.loadWindow({ anchorTurn: 1, direction: 'older', budget, projectionLevel: 'detail' });
    expect(page.messages.map(message => message.content)).toEqual(['first question']);
    // The tail handoff point is the committed boundary, not the stat-time
    // EOF: an observer starting at EOF would read the half line's tail as a
    // standalone JSON line forever.
    expect(page.snapshotOffset).toBe(Buffer.byteLength(firstLine) + 1);
    const stat = await (await import('fs/promises')).stat(path);
    expect(page.snapshotOffset).toBeLessThan(stat.size);
    // Search only ever covers the committed prefix.
    await expect(lease.search('first')).resolves.toHaveLength(1);
    await expect(lease.search('par')).resolves.toHaveLength(0);
    lease.release();
  });

  it('incorporates the completed tail line after a refresh', async () => {
    const firstLine = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'first question' } });
    const path = join(fixtureDir, 'completing.jsonl');
    await writeFile(path, `${firstLine}\n{"type":"user","uuid":"u2","par`);
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(path);
    jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);

    const service = new ClaudeConversationHistoryService();
    const conversation = conversationFor('completing');
    const first = service.acquireHistoryIndex(conversation, fixtureDir);
    await first.ready;
    const firstOffset = (await first.loadWindow({ anchorTurn: 1, direction: 'older', budget, projectionLevel: 'detail' })).snapshotOffset;
    first.release();

    // The writer finishes the half line and closes it.
    await (await import('fs/promises')).appendFile(path, 'entUuid":null,"message":{"content":"second question"}}\n');

    const second = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
    await second.ready;
    expect(second.totalTurns).toBe(2);
    const page = await second.loadWindow({ anchorTurn: 2, direction: 'older', budget, projectionLevel: 'detail' });
    expect(page.messages.map(message => message.content)).toEqual(['first question', 'second question']);
    // The committed boundary advanced past the line the first snapshot had
    // parked on — an observer resumed at the old boundary reads it whole.
    expect(page.snapshotOffset!).toBeGreaterThan(firstOffset!);
    const stat = await (await import('fs/promises')).stat(path);
    expect(page.snapshotOffset).toBe(stat.size);
    await expect(second.search('second')).resolves.toHaveLength(1);
    second.release();
  });

  it('marks current-segment partials as transient and older-segment partials as stale', async () => {
    const currentLine = JSON.stringify({ type: 'user', uuid: 'c1', parentUuid: null, message: { content: 'current question' } });
    const prevLine = JSON.stringify({ type: 'user', uuid: 'p1', parentUuid: null, message: { content: 'previous question' } });
    const prevPath = join(fixtureDir, 'prev-half.jsonl');
    const currentPath = join(fixtureDir, 'current-half.jsonl');
    await writeFile(prevPath, `${prevLine}\n{"type":"user","uuid":"p2","par`);
    await writeFile(currentPath, `${currentLine}\n{"type":"user","uuid":"c2","par`);
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockImplementation((_vault, id) =>
      id === 'prev-half' ? prevPath : currentPath);
    jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);

    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(
      conversationFor('current-half', { previousProviderSessionIds: ['prev-half'] }),
      fixtureDir,
    );
    await expect(lease.ready).resolves.toBeUndefined();
    expect(lease.totalTurns).toBe(2);
    lease.release();

    const diagnosticsPath = join(fixtureDir, '.claudian', 'diagnostics', 'history-window.current.jsonl');
    const { readFile: readDiagnostics } = await import('fs/promises');
    const events = (await readDiagnostics(diagnosticsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(event => event.phase === 'partial_snapshot')).toBe(true);
    expect(events.some(event => event.phase === 'stale_partial_segment')).toBe(true);
  });

  it('opens a session with a line above the default 16 MiB cap and degrades it visibly', async () => {
    const giant = 17 * 1024 * 1024;
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'giant question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'tu1', parentUuid: 'u1', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.md' } }] } }),
      JSON.stringify({
        type: 'user', uuid: 'tr1', parentUuid: 'tu1', sourceToolUseID: 'toolu_1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(giant) }] },
      }),
      JSON.stringify({ type: 'assistant', uuid: 'af1', parentUuid: 'tr1', message: { content: 'final summary' } }),
    ];
    const path = join(fixtureDir, 'giant-line.jsonl');
    await writeFile(path, `${lines.join('\n')}\n`);
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(path);
    jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);

    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversationFor('giant-line'), fixtureDir);
    // The exact real-machine failure: a 16.87 MB toolUseResult row used to
    // throw and permanently block this conversation.
    await expect(lease.ready).resolves.toBeUndefined();
    expect(lease.totalTurns).toBe(1);

    const page = await lease.loadWindow({ anchorTurn: 1, direction: 'older', budget, projectionLevel: 'summary' });
    const text = page.messages.map(message => message.content).join('\n');
    expect(text).toContain('giant question');
    expect(text).toContain('final summary');
    // The opaque row surfaces a visible omission marker...
    expect(text).toContain('bytes omitted');
    // ...and its reliably extracted tool id completes the paired tool call
    // with an honest omission result instead of leaving it running.
    const toolCalls = page.messages.flatMap(message => message.toolCalls ?? []);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].status).toBe('completed');
    expect(toolCalls[0].result).toContain('bytes omitted');
    // Omission markers never leak into the search index.
    const fresh = await buildTranscriptIndex(path, { useWorker: false });
    expect(fresh.status).toBe('complete');
    if (fresh.status !== 'complete') return;
    expect(fresh.index.searchText).not.toContain('omitted');
    expect(fresh.index.searchText).toContain('giant question');
    lease.release();
  });

  it('does not fake tool completion when the giant line has no reliable ids', async () => {
    const giant = 17 * 1024 * 1024;
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'giant question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'tu1', parentUuid: 'u1', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.md' } }] } }),
      'x'.repeat(giant),
      JSON.stringify({ type: 'assistant', uuid: 'af1', parentUuid: 'tu1', message: { content: 'final summary' } }),
    ];
    const path = join(fixtureDir, 'giant-garbage.jsonl');
    await writeFile(path, `${lines.join('\n')}\n`);
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(path);
    jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);

    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversationFor('giant-garbage'), fixtureDir);
    await expect(lease.ready).resolves.toBeUndefined();
    const page = await lease.loadWindow({ anchorTurn: 1, direction: 'older', budget, projectionLevel: 'summary' });
    const toolCalls = page.messages.flatMap(message => message.toolCalls ?? []);
    expect(toolCalls).toHaveLength(1);
    // No reliable tool id was extracted, so no synthetic completion: the
    // omission marker still shows, the tool call stays honestly unfinished.
    expect(toolCalls[0].result).toBeUndefined();
    expect(toolCalls[0].status).not.toBe('completed');
    expect(page.messages.map(message => message.content).join('\n')).toContain('bytes omitted');
    lease.release();
  });
});

describe('fork resume through the history service', () => {
  const budget = {
    maxTurns: 25,
    maxSourceBytes: 8 * 1024 * 1024,
    maxProjectedChars: 2_000_000,
    timeSliceMs: 8,
  };
  const fixtureDir = join(process.env.TMPDIR ?? '/tmp', `claudian-fork-resume-${process.pid}`);

  beforeEach(async () => {
    clearTranscriptIndexCache();
    await (await import('fs/promises')).rm(fixtureDir, { recursive: true, force: true });
    await (await import('fs/promises')).mkdir(fixtureDir, { recursive: true });
  });

  afterAll(async () => {
    await (await import('fs/promises')).rm(fixtureDir, { recursive: true, force: true });
  });

  it('truncates a fork conversation at its checkpoint after the source already hydrated plainly', async () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'answer' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'after checkpoint' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'later answer' } }),
    ];
    const path = join(fixtureDir, 'fork-source.jsonl');
    await writeFile(path, `${lines.join('\n')}\n`);
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(path);
    jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);

    const service = new ClaudeConversationHistoryService();
    const source: Conversation = {
      id: 'fork-source', providerId: 'claude', title: 'Source', createdAt: 1, updatedAt: 1,
      sessionId: 'source-session', providerState: { providerSessionId: 'source-session' }, messages: [],
    };
    // The source conversation hydrates plainly first; its completed cache entry
    // stays protected by the active lease — exactly the shape of a real fork
    // created while the source tab is open.
    const sourceLease = service.acquireHistoryIndex(source, fixtureDir);
    await sourceLease.ready;
    expect(sourceLease.totalTurns).toBe(2);

    const fork: Conversation = {
      id: 'fork-child', providerId: 'claude', title: 'Fork', createdAt: 2, updatedAt: 2,
      sessionId: null,
      providerState: { forkSource: { sessionId: 'source-session', resumeAt: 'a1' } }, messages: [],
    };
    const forkLease = service.acquireHistoryIndex(fork, fixtureDir);
    await forkLease.ready;
    expect(forkLease.totalTurns).toBe(1);
    const page = await forkLease.loadWindow({ anchorTurn: 1, direction: 'older', budget, projectionLevel: 'detail' });
    expect(page.messages.map(message => message.content)).toEqual(['question', 'answer']);

    sourceLease.release();
    forkLease.release();
  });
});

describe('ClaudeTranscriptHistoryIndex worker fallback', () => {
  afterEach(() => {
    jest.useRealTimers();
    mockWorkerConstructorMode = 'real';
    mockWorkerSources.length = 0;
    setTranscriptIndexDiagnosticSink(null);
    resetTranscriptIndexWorkerProbe();
  });

  it('records throttled direct-build lifecycle events including stalled without terminating', async () => coordinated('stalled direct build', async scope => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-stalled-${process.pid}.jsonl`);
    await scope.wait('write snapshot', scope.track('write', writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x' } })}\n`)));
    let advanced = false;

    const resultPromise = scope.track('direct subscription', buildTranscriptIndex(path, {
      useWorker: false, signal: scope.controller().signal,
      onProgress: () => {
        if (advanced) return;
        advanced = true;
        jest.advanceTimersByTime(31_000);
      },
    }));
    await scope.wait('run fake timers', scope.track('fake timers', jest.runAllTimersAsync()));
    const result = await scope.wait('direct result', resultPromise);

    expect(result.status).toBe('complete');
    expect(events.map(event => event.phase)).toEqual(expect.arrayContaining([
      'queued', 'start', 'progress', 'stalled', 'finalize', 'complete',
    ]));
    expect(events.filter(event => event.phase === 'progress')).toHaveLength(1);
  }));

  it('records failed and aborted terminal events', async () => {
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    // Oversized lines no longer fail builds; the resume-anchor refusal is the
    // explicit failure path that keeps a 'failed' event observable.
    const failedPath = join(process.env.TMPDIR ?? '/tmp', `claudian-failed-${process.pid}.jsonl`);
    const row = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x'.repeat(100) } });
    await writeFile(failedPath, `${row}\n`);
    await buildTranscriptIndex(failedPath, { useWorker: false, maxLineBytes: 10, resumeAtMessageId: 'u1' });

    const abortedPath = join(process.env.TMPDIR ?? '/tmp', `claudian-aborted-${process.pid}.jsonl`);
    await writeFile(abortedPath, `${JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'x' } })}\n`);
    const controller = new AbortController();
    controller.abort();
    await buildTranscriptIndex(abortedPath, { useWorker: false, signal: controller.signal });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'failed', mode: 'direct' }),
      expect.objectContaining({ phase: 'aborted', mode: 'direct' }),
    ]));
  });

  it('falls back to the main-thread path and records one fallback event when the worker constructor throws', async () => {
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    mockWorkerConstructorMode = 'throw';
    const first = join(process.env.TMPDIR ?? '/tmp', `claudian-fallback-${process.pid}-1.jsonl`);
    await writeFile(first, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x' } })}\n`);
    const result = await buildTranscriptIndex(first, {});
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1']);
    expect(events).toEqual(expect.arrayContaining([
      { phase: 'index_worker_fallback', errorName: 'TypeError' },
      expect.objectContaining({ phase: 'queued', mode: 'direct', buildId: expect.any(String) }),
      expect.objectContaining({ phase: 'start', mode: 'direct', buildId: expect.any(String) }),
      expect.objectContaining({ phase: 'complete', mode: 'direct', entries: 1, turns: 1 }),
    ]));

    const second = join(process.env.TMPDIR ?? '/tmp', `claudian-fallback-${process.pid}-2.jsonl`);
    await writeFile(second, `${JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'y' } })}\n`);
    const again = await buildTranscriptIndex(second, {});
    expect(again.status).toBe('complete');
    expect(events.filter(event => event.phase === 'index_worker_fallback')).toHaveLength(1);
    expect(mockWorkerSources).toHaveLength(0);
  });

  it('treats a probe error as unavailable and falls back to the main thread', async () => {
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    mockWorkerConstructorMode = 'probe-error';
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-probe-error-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x' } })}\n`);

    const result = await buildTranscriptIndex(path, {});

    expect(result.status).toBe('complete');
    expect(events).toEqual(expect.arrayContaining([
      { phase: 'index_worker_fallback', errorName: 'Error' },
      expect.objectContaining({ phase: 'queued', mode: 'direct' }),
      expect.objectContaining({ phase: 'complete', mode: 'direct' }),
    ]));
  });

  it('falls back once when the build worker errors after a successful probe', async () => {
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    mockWorkerConstructorMode = 'build-error';
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-build-error-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x' } })}\n`);

    const result = await buildTranscriptIndex(path, {});

    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1']);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'index_worker_fallback' }),
      expect.objectContaining({ phase: 'complete', mode: 'direct' }),
    ]));
  });

  it('builds in a worker when the constructor probe succeeds', async () => {
    mockWorkerConstructorMode = 'record';
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-worker-probe-${process.pid}.jsonl`);
    await writeFile(path, [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'world' } }),
    ].join('\n') + '\n');
    const result = await buildTranscriptIndex(path, {});
    expect(result).toEqual(expect.objectContaining({ status: 'complete' }));
    if (result.status !== 'complete') return;
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['u1']);
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1']);
    expect(mockWorkerSources).toEqual([
      'require("worker_threads").parentPort.postMessage("ready")',
      expect.any(String),
    ]);
  });

  it('produces identical oversized-degradation output through the worker and direct paths', async () => {
    mockWorkerConstructorMode = 'record';
    const oversized = JSON.stringify({
      type: 'user', uuid: 'tr1', parentUuid: 'tu0', sourceToolUseID: 'toolu_1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(300) }] },
    });
    const small = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'question' } });
    const tail = JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'tr1', message: { content: 'answer' } });
    const directPath = join(process.env.TMPDIR ?? '/tmp', `claudian-parity-direct-${process.pid}.jsonl`);
    const workerPath = join(process.env.TMPDIR ?? '/tmp', `claudian-parity-worker-${process.pid}.jsonl`);
    const content = `${[small, oversized, tail].join('\n')}\n`;
    await writeFile(directPath, content);
    await writeFile(workerPath, content);

    const direct = await buildTranscriptIndex(directPath, { useWorker: false, chunkSize: 17, maxLineBytes: 100 });
    const viaWorker = await buildTranscriptIndex(workerPath, { chunkSize: 17, maxLineBytes: 100 });
    expect(direct.status).toBe('complete');
    expect(viaWorker.status).toBe('complete');
    if (direct.status !== 'complete' || viaWorker.status !== 'complete') return;

    // Volatile identity/timing fields are the only allowed divergence.
    const stable = (index: TranscriptHistoryIndex): object => {
      const { entries, turns, searchCorpus, searchText, skippedLines, committedSize, snapshotSize, projectionDescriptors } = index;
      return { entries, turns, searchCorpus, searchText, skippedLines, committedSize, snapshotSize, projectionDescriptors };
    };
    expect(stable(viaWorker.index)).toEqual(stable(direct.index));
    expect(viaWorker.index.entries.some(entry => entry.oversized)).toBe(true);
    // New helpers must be injected into the eval source explicitly; a missing
    // injection silently diverges the worker path from direct.
    const buildSource = mockWorkerSources[1] ?? '';
    for (const helper of ['parseOversizedLineFacts', 'extractOversizedLineFacts', 'appendOversizedEntry', 'onLineSkipped']) {
      expect(buildSource).toContain(helper);
    }
  });

  it('produces identical suffix-recovery output through the worker and direct paths', async () => {
    mockWorkerConstructorMode = 'record';
    // CC row order with a giant message.content: the prefix scan cannot see
    // uuid/timestamp, so both paths must agree on the tail-window recovery.
    const huge = JSON.stringify({
      parentUuid: 'u1', isSidechain: false, promptId: 'p1', type: 'user',
      message: { role: 'user', content: `PARITY ${'x'.repeat(600 * 1024)}` },
      uuid: 'tr1', timestamp: '2026-01-01T00:00:00Z',
      toolUseResult: 'tail-result', cwd: '/vault', sessionId: 's1', version: '1.0.0',
    });
    const small = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'question' } });
    const tail = JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'tr1', message: { content: 'answer' } });
    const directPath = join(process.env.TMPDIR ?? '/tmp', `claudian-parity-suffix-direct-${process.pid}.jsonl`);
    const workerPath = join(process.env.TMPDIR ?? '/tmp', `claudian-parity-suffix-worker-${process.pid}.jsonl`);
    const content = `${[small, huge, tail].join('\n')}\n`;
    await writeFile(directPath, content);
    await writeFile(workerPath, content);

    const direct = await buildTranscriptIndex(directPath, { useWorker: false, chunkSize: 64, maxLineBytes: 100 });
    const viaWorker = await buildTranscriptIndex(workerPath, { chunkSize: 64, maxLineBytes: 100 });
    expect(direct.status).toBe('complete');
    expect(viaWorker.status).toBe('complete');
    if (direct.status !== 'complete' || viaWorker.status !== 'complete') return;

    const stable = (index: TranscriptHistoryIndex): object => {
      const { entries, turns, searchCorpus, searchText, skippedLines, committedSize, snapshotSize, projectionDescriptors } = index;
      return { entries, turns, searchCorpus, searchText, skippedLines, committedSize, snapshotSize, projectionDescriptors };
    };
    expect(stable(viaWorker.index)).toEqual(stable(direct.index));
    const opaque = viaWorker.index.entries[1];
    expect(opaque.oversized).toBe(true);
    expect(opaque.uuid).toBe('tr1');
    expect(opaque.parentUuid).toBe('u1');
    // The suffix scanner and merger must exist in the eval source; a missing
    // injection would silently drop tail recovery in the worker path only.
    const buildSource = mockWorkerSources[1] ?? '';
    for (const helper of ['OVERSIZED_FACTS_TAIL_READ_BYTES', 'parseOversizedLineFactsSuffix', 'mergeOversizedLineFacts', 'listOversizedIdentityFields']) {
      expect(buildSource).toContain(helper);
    }
  });
});
