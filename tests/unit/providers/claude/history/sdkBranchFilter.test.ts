import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type * as workerThreads from 'worker_threads';

import {
  buildTranscriptIndex,
  clearTranscriptIndexCache,
  resetTranscriptIndexWorkerProbe,
  setTranscriptIndexDiagnosticSink,
  type TranscriptIndexDiagnosticEvent,
} from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import { type BranchFilterEntry, filterActiveBranchEntries } from '@/providers/claude/history/sdkBranchFilter';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';

const mockWorkerSources: string[] = [];
jest.mock('worker_threads', () => {
  const actual = jest.requireActual<typeof workerThreads>('worker_threads');
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        mockWorkerSources.push(String(args[0]));
      }
    },
  };
});

const fixtureDir = join('/tmp', `claudian-g1-branch-${randomUUID()}`);
const rows: Array<BranchFilterEntry & { message?: SDKNativeMessage['message'] }> = [
  { type: 'user', uuid: 'u0', parentUuid: null, message: { content: 'root' } },
  { type: 'assistant', uuid: 'a0', parentUuid: 'u0', message: { content: 'reply' } },
  { type: 'user', uuid: 'old-u', parentUuid: 'a0', message: { content: 'old' } },
  { type: 'assistant', uuid: 'old-a', parentUuid: 'old-u', message: { content: 'old reply' } },
  { type: 'progress', uuid: 'p0', parentUuid: 'a0' },
  { type: 'user', uuid: 'new-u', parentUuid: 'p0', message: { content: 'new' } },
  { type: 'assistant', uuid: 'new-a', parentUuid: 'new-u', message: { content: 'new reply' } },
];

beforeAll(async () => { await mkdir(fixtureDir); });
afterAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); });
afterEach(() => { clearTranscriptIndexCache(); setTranscriptIndexDiagnosticSink(null); });

it.each(['user', 'assistant'])('R2 case 1: known %s type without message is not a structure proof', type => {
  const sample = [{ type, uuid: 'u', parentUuid: null }];
  expect(filterActiveBranchEntries(sample, undefined, entry => entry.type === 'user')).toEqual(sample);
});

it('G1 regression: unidentifiable fallback remains loadable without being branch-certified', async () => {
  const path = join(fixtureDir, 'unidentified.jsonl');
  await writeFile(path, JSON.stringify({ type: 'user', message: { content: 'kept' } }) + '\n');
  const result = await buildTranscriptIndex(path, { useWorker: false });
  expect(result.status).toBe('complete');
  if (result.status === 'failed') throw new Error('normal fallback failed');
  expect(result.index.entries).toHaveLength(1);
  expect(result.index.turns).toHaveLength(1);
});

it.each([
  ['unrecognized', '{}\n', false],
  ['metadata', JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }) + '\n', true],
  ['empty', '', true],
] as const)('G1 fix 1: preserves %s evidence through direct and real worker without fallback', async (name, content, complete) => {
  resetTranscriptIndexWorkerProbe();
  const events: TranscriptIndexDiagnosticEvent[] = [];
  setTranscriptIndexDiagnosticSink(event => events.push(event));
  const directPath = join(fixtureDir, `fix1-direct-${name}.jsonl`);
  const workerPath = join(fixtureDir, `fix1-worker-${name}.jsonl`);
  await writeFile(directPath, content);
  await writeFile(workerPath, content);
  const direct = await buildTranscriptIndex(directPath, { useWorker: false });
  const worker = await buildTranscriptIndex(workerPath);
  if (direct.status === 'failed' || worker.status === 'failed') throw new Error('normal build failed');
  expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
  expect(events.filter(event => event.phase === 'complete' && event.mode === 'worker')).toHaveLength(1);
  expect(worker.index.entries).toEqual(direct.index.entries);
  expect(worker.index.turns).toEqual([]);
  expect(await buildTranscriptIndex(workerPath)).toMatchObject({ fromCache: true });
});

it.each(['disconnected', 'conflicting-uuid', 'identical-uuid', 'linear'] as const)(
  'G1 fix 2: preserves %s canonical output through direct/real worker/cache', async variant => {
    const base = rows.slice(0, 2);
    const sample = variant === 'disconnected' ? [...base, ...base.map(row => ({ ...row,
      uuid: `other-${row.uuid}`, parentUuid: row.parentUuid ? `other-${row.parentUuid}` : null }))]
      : variant === 'linear' ? [...base, ...rows.slice(5).map((row, i) => ({ ...row, parentUuid: i === 0 ? 'a0' : row.parentUuid }))]
        : [...base, ...base.map((row, i) => variant === 'conflicting-uuid' && i === 0
          ? { ...row, message: { content: 'different' } } : row)];
    const content = sample.map(row => JSON.stringify(row)).join('\n') + '\n';
    const canonical = variant === 'identical-uuid' || variant === 'conflicting-uuid' ? ['u0', 'a0'] : sample.map(row => row.uuid);
    resetTranscriptIndexWorkerProbe();
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    for (const useWorker of [false, true]) {
      const path = join(fixtureDir, `fix2-${variant}-${useWorker}.jsonl`);
      await writeFile(path, content);
      const result = await buildTranscriptIndex(path, { useWorker });
      if (result.status === 'failed') throw new Error('normal build failed');
      expect(result.index.entries.map(entry => entry.uuid)).toEqual(canonical);
      expect(await buildTranscriptIndex(path, { useWorker })).toMatchObject({ fromCache: true });
    }
    expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
    expect(events.filter(event => event.phase === 'complete' && event.mode === 'worker')).toHaveLength(1);
  });

it.each([undefined, 'old-a'] as const)(
  'G1 fix 3 regression: transports only terminal progress aliases through direct/real worker/cache (anchor=%s)', async anchor => {
    const sample = [
      ...rows.slice(0, 4),
      { ...rows[5], parentUuid: 'old-a' }, rows[6],
      { type: 'progress', uuid: 'root-progress', parentUuid: null },
      { type: 'progress', uuid: 'early-progress', parentUuid: 'a0' },
      { type: 'progress', uuid: 'terminal-progress', parentUuid: 'new-a' },
      { type: 'progress', uuid: 'terminal-alias', parentUuid: 'terminal-progress' },
    ];
    const content = sample.map(row => JSON.stringify(row)).join('\n') + '\n';
    resetTranscriptIndexWorkerProbe();
    const events: TranscriptIndexDiagnosticEvent[] = [];
    setTranscriptIndexDiagnosticSink(event => events.push(event));
    for (const useWorker of [false, true]) {
      const path = join(fixtureDir, `fix3-${anchor ?? 'plain'}-${useWorker}.jsonl`);
      await writeFile(path, content);
      const result = await buildTranscriptIndex(path, { useWorker, resumeAtMessageId: anchor });
      if (result.status === 'failed') throw new Error('normal build failed');
      expect(result.index.entries.map(entry => entry.uuid)).toEqual(anchor
        ? ['u0', 'a0', 'old-u', 'old-a'] : ['u0', 'a0', 'old-u', 'old-a', 'new-u', 'new-a']);
      expect(await buildTranscriptIndex(path, { useWorker, resumeAtMessageId: anchor }))
        .toMatchObject({ fromCache: true });
    }
    expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
    expect(events.filter(event => event.phase === 'complete' && event.mode === 'worker')).toHaveLength(1);
  });

it.each([
  [undefined, true], ['new-a', true], ['a0', true], ['absent', false], ['old-a', false],
] as const)('G1 preserves canonical output and evidence through direct/worker/cache for anchor=%s', async (anchor, complete) => {
  resetTranscriptIndexWorkerProbe();
  const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const directPath = join(fixtureDir, `direct-${anchor ?? 'plain'}.jsonl`);
  const workerPath = join(fixtureDir, `worker-${anchor ?? 'plain'}.jsonl`);
  await writeFile(directPath, content);
  await writeFile(workerPath, content);
  mockWorkerSources.length = 0;
  const events: TranscriptIndexDiagnosticEvent[] = [];
  setTranscriptIndexDiagnosticSink(event => events.push(event));
  {
    const direct = await buildTranscriptIndex(directPath, { useWorker: false, resumeAtMessageId: anchor });
    const first = buildTranscriptIndex(workerPath, { resumeAtMessageId: anchor });
    const sameRequest = buildTranscriptIndex(workerPath, { resumeAtMessageId: anchor });
    // A different request configuration must join the same snapshot's in-flight build.
    const inFlight = buildTranscriptIndex(workerPath, { resumeAtMessageId: anchor, chunkSize: 37 });
    const [viaWorker, joined, sameResult] = await Promise.all([first, inFlight, sameRequest]);
    expect(direct.status).toBe('complete');
    expect(viaWorker.status).toBe('complete');
    if (direct.status === 'failed' || viaWorker.status === 'failed' || joined.status === 'failed' || sameResult.status === 'failed') {
      throw new Error('normal index build failed');
    }
    expect(joined.index).toBe(viaWorker.index);
    expect(sameResult.index).toBe(viaWorker.index);
    const canonical = filterActiveBranchEntries(rows, anchor, entry => entry.type === 'user').map(row => row.uuid);
    expect(direct.index.entries.map(entry => entry.uuid)).toEqual(canonical);
    expect(viaWorker.index.entries.map(entry => entry.uuid)).toEqual(canonical);
    expect(mockWorkerSources.filter(source => source.includes('const finalizeIndex'))).toHaveLength(1);
    expect(events.filter(event => event.phase === 'complete' && event.mode === 'worker')).toHaveLength(1);
    expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
    const cached = await buildTranscriptIndex(workerPath, { resumeAtMessageId: anchor });
    expect(cached).toMatchObject({ fromCache: true });
    if (cached.status === 'failed') throw new Error('completed cache failed');
    expect(cached.index).toBe(viaWorker.index);
  }
});
