import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type * as workerThreadsModule from 'worker_threads';

import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import {
  buildTranscriptIndex,
  clearTranscriptIndexCache,
  getTranscriptIndexCacheSize,
  materializeTranscriptPage,
  protectTranscriptIndex,
  releaseTranscriptIndex,
  resetTranscriptIndexWorkerProbe,
  setTranscriptIndexDiagnosticSink,
  type TranscriptHistoryIndex,
  type TranscriptIndexDiagnosticEvent,
} from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import { filterActiveBranch } from '@/providers/claude/history/sdkBranchFilter';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';
import * as sdkSessionPaths from '@/providers/claude/history/sdkSessionPaths';
import { HISTORY_OMISSION_MARKER } from '@/providers/claude/runtime/HistoryContextAccumulator';

let mockWorkerConstructorMode: 'real' | 'throw' | 'record' | 'probe-error' | 'build-error' = 'real';
const mockWorkerSources: string[] = [];

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
        super(...args);
        const source = String(args[0]);
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
    for await (const chunk of service.iterateFullHistory(conversation, '/vault', {
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
    expect(second).toBe(first);
    const result = await first;
    if (result.status === 'failed') throw new Error(result.error);
    expect(result.status).toBe('complete');
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['peer-a', 'peer-b']);
  });

  it('lets a superseding build succeed when the previous build is aborted mid-scan', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-supersede-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'one' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'two' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'three' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'four' } }),
      JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: 'a2', message: { content: 'five' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a3', parentUuid: 'u3', message: { content: 'six' } }),
    ];
    await writeFile(path, `${lines.join('\n')}\n`);
    const superseded = new AbortController();
    const superseding = new AbortController();
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>(resolve => { releaseProgress = resolve; });
    const first = buildTranscriptIndex(path, {
      useWorker: false,
      chunkSize: 16,
      signal: superseded.signal,
      onProgress: () => releaseProgress(),
    });
    // loadInitialHistory aborts the old controller and starts a new build for
    // the same path in the same synchronous section; pause mid-scan to pin
    // that window open.
    await progressGate;
    superseded.abort();
    const second = buildTranscriptIndex(path, {
      useWorker: false,
      chunkSize: 16,
      signal: superseding.signal,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ status: 'failed', error: 'History index build aborted' });
    expect(secondResult.status).toBe('complete');
    if (secondResult.status !== 'complete') return;
    expect(secondResult.index.turns.map(turn => turn.turnId)).toEqual(['u1', 'u2', 'u3']);
    expect(secondResult.index.entries.map(entry => entry.messageKey)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  });
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

describe('ClaudeTranscriptHistoryIndex worker fallback', () => {
  afterEach(() => {
    mockWorkerConstructorMode = 'real';
    mockWorkerSources.length = 0;
    setTranscriptIndexDiagnosticSink(null);
    resetTranscriptIndexWorkerProbe();
  });

  it('records throttled direct-build lifecycle events including stalled without terminating', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-stalled-${process.pid}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x' } })}\n`);
    let advanced = false;

    const resultPromise = buildTranscriptIndex(path, {
      useWorker: false,
      onProgress: () => {
        if (advanced) return;
        advanced = true;
        jest.advanceTimersByTime(31_000);
      },
    });
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe('complete');
    expect(events.map(event => event.phase)).toEqual(expect.arrayContaining([
      'queued', 'start', 'progress', 'stalled', 'finalize', 'complete',
    ]));
    expect(events.filter(event => event.phase === 'progress')).toHaveLength(1);
    jest.useRealTimers();
  });

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
});
