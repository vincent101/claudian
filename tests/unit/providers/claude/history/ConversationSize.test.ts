import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import {  link, mkdir, rm, type stat as FsStat, writeFile } from 'fs/promises';
import { join } from 'path';

import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as historyIndex from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';

const fixtureDir = join('/tmp', `claudian-size-claude-${randomUUID()}`);

jest.mock('@/providers/claude/history/sdkSessionPaths', () => {
  const actual = jest.requireActual('@/providers/claude/history/sdkSessionPaths');
  return {
    ...actual,
    getSDKSessionPath: (_vaultPath: string, id: string) => join(fixtureDir, `${id}.jsonl`),
    sdkSessionExists: (_vaultPath: string, id: string) => existsSync(join(fixtureDir, `${id}.jsonl`)),
  };
});

function conversation(sessionId: string, providerState: Record<string, unknown> = {}): Conversation {
  return {
    id: `conv-${sessionId}`, providerId: 'claude', title: 'Controlled fixture',
    createdAt: 1, updatedAt: 1, sessionId, messages: [],
    providerState: { providerSessionId: sessionId, ...providerState },
  };
}

function turns(count: number): string {
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(JSON.stringify({
      type: 'user', uuid: `u${i}`, parentUuid: i === 0 ? null : `a${i - 1}`,
      message: { content: `question ${i}` },
    }));
    rows.push(JSON.stringify({
      type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`,
      message: { content: [{ type: 'text', text: `answer ${i}` }] },
    }));
  }
  return rows.join('\n') + '\n';
}

type SizeResult = {
  conversationId: string;
  revision: number;
  files: { status: string; bytes?: number; fileCount?: number; reason?: string };
};

async function readSize(service: ClaudeConversationHistoryService, input: Conversation, revision = 1): Promise<SizeResult> {
  return (await service.readConversationSize({
    id: input.id, providerId: input.providerId, source: service.captureConversationSizeSource(input),
  }, fixtureDir, { revision })).snapshot;
}

beforeAll(async () => {
  await mkdir(fixtureDir);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('Claude history projection compatibility', () => {
  it.each([false, true])('preserves known-type malformed-row fallback (worker=%s)', async useWorker => {
    const samples: Array<[string, unknown[], string[], number, boolean]> = [
      ['missing-user-message', [{ type: 'user', uuid: 'u', parentUuid: null }], [], 1, false],
      ['missing-assistant-message', [{ type: 'user', uuid: 'u', parentUuid: null, message: { content: 'question' } },
        { type: 'assistant', uuid: 'a', parentUuid: 'u' }], ['question'], 1, false],
      ['valid', [{ type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'question' }] } },
        { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought' }, { type: 'text', text: 'answer' }] } }], ['question', 'answer'], 1, true],
      ['empty', [], [], 0, true],
      ['metadata', [{ type: 'queue-operation', operation: 'enqueue' }], [], 0, true],
    ];
    historyIndex.clearTranscriptIndexCache();
    historyIndex.resetTranscriptIndexWorkerProbe();
    const original = historyIndex.buildTranscriptIndex;
    const build = jest.spyOn(historyIndex, 'buildTranscriptIndex').mockImplementation((path, options) => original(path, { ...options, useWorker }));
    try {
      for (const [name, rows, expected, count, ] of samples) {
        const id = `r2-shape-${name}-${useWorker}`;
        await writeFile(join(fixtureDir, `${id}.jsonl`), rows.length ? rows.map(row => JSON.stringify(row)).join('\n') + '\n' : '');
        const input = conversation(id);
        const service = new ClaudeConversationHistoryService();
        const events: historyIndex.TranscriptIndexDiagnosticEvent[] = [];
        const lease = service.acquireHistoryIndex(input, fixtureDir);
        historyIndex.setTranscriptIndexDiagnosticSink(event => events.push(event));
        try {
          await lease.ready;
          const page = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
            budget: { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 8 } });
          expect(page.messages.map(message => message.content)).toEqual(expected);
          expect(lease.totalTurns).toBe(count);
          expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
          expect(events.filter(event => event.phase === 'complete' && event.mode === (useWorker ? 'worker' : 'direct'))).toHaveLength(1);
        } finally { lease.release(); }
      }
    } finally { build.mockRestore(); historyIndex.setTranscriptIndexDiagnosticSink(null); }
  });
  it.each([false, true])('preserves cross-segment message ordering through worker and completed cache (worker=%s)', async useWorker => {
    historyIndex.clearTranscriptIndexCache();
    historyIndex.resetTranscriptIndexWorkerProbe();
    const original = historyIndex.buildTranscriptIndex;
    const build = jest.spyOn(historyIndex, 'buildTranscriptIndex').mockImplementation((path, options) => original(path, { ...options, useWorker }));
    try {
      for (const conflict of [true, false]) {
        const priorId = `r2-global-prior-${useWorker}-${conflict}`;
        const nextId = `r2-global-next-${useWorker}-${conflict}`;
        const next = [
          { type: 'user', uuid: conflict ? 'u0' : 'u1', parentUuid: 'a0', message: { content: 'next question' } },
          { type: 'assistant', uuid: 'a1', parentUuid: conflict ? 'u0' : 'u1', message: { content: [{ type: 'text', text: 'next answer' }] } },
        ];
        await writeFile(join(fixtureDir, `${priorId}.jsonl`), turns(1));
        await writeFile(join(fixtureDir, `${nextId}.jsonl`), next.map(row => JSON.stringify(row)).join('\n') + '\n');
        const input = conversation(nextId, { previousProviderSessionIds: [priorId] });
        const service = new ClaudeConversationHistoryService();
        for (const cached of [false, true]) {
          const events: historyIndex.TranscriptIndexDiagnosticEvent[] = [];
          const lease = service.acquireHistoryIndex(input, fixtureDir, undefined, true);
          historyIndex.setTranscriptIndexDiagnosticSink(event => events.push(event));
          try {
            await lease.ready;
            const page = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
              budget: { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 8 } });
            expect(page.messages.map(message => message.content)).toEqual(conflict
              ? ['question 0', 'answer 0', 'next answer'] : ['question 0', 'answer 0', 'next question', 'next answer']);
            expect(lease.totalTurns).toBe(2);
            expect(lease.acquireOutcome).toBe(cached ? 'cache_hit' : 'rebuilt');
            expect(events.filter(event => event.phase === 'complete' && event.mode === (useWorker ? 'worker' : 'direct'))).toHaveLength(cached ? 0 : 2);

            expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
          } finally { lease.release(); }
        }
      }
    } finally { build.mockRestore(); historyIndex.setTranscriptIndexDiagnosticSink(null); }
  });

  it.each([
    ['unrecognized', '{}\n'],
    ['metadata', JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }) + '\n'],
    ['empty', ''],
  ] as const)('preserves %s record fallback with empty pagination', async (name, content) => {
    const id = `fix1-${name}`;
    await writeFile(join(fixtureDir, `${id}.jsonl`), content);
    const input = conversation(id);
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(input, fixtureDir);
    try {
      await lease.ready;
      expect(lease.totalTurns).toBe(0);
      const page = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
        budget: { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 8 } });
      expect(page.messages).toEqual([]);
    } finally { lease.release(); }
  });

  it.each(['disconnected', 'conflicting-uuid', 'identical-uuid', 'linear'] as const)(
    'preserves ancestry and duplicate identity selection (%s)', async variant => {
      const first = turns(1);
      const content = variant === 'disconnected'
        ? first + first.replaceAll('u0', 'other-u').replaceAll('a0', 'other-a')
        : variant === 'linear' ? turns(2)
          : first + (variant === 'conflicting-uuid' ? first.replace('question 0', 'different question') : first);
      const id = `fix2-${variant}`;
      await writeFile(join(fixtureDir, `${id}.jsonl`), content);
      const input = conversation(id);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(input, fixtureDir);
      try {
        await lease.ready;
        const expected = variant === 'disconnected' ? ['question 0', 'answer 0', 'question 0', 'answer 0']
          : variant === 'linear' ? ['question 0', 'answer 0', 'question 1', 'answer 1'] : ['question 0', 'answer 0'];
        expect(lease.totalTurns).toBe(expected.length / 2);
        const page = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
          budget: { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 8 } });
        expect(page.messages.map(message => message.content)).toEqual(expected);
      } finally { lease.release(); }
    });

  it.each(['absent', 'old'])('keeps active-branch fallback for the %s resume anchor', async variant => {
    const rows = variant === 'old' ? [
      { type: 'user', uuid: 'u0', parentUuid: null, message: { content: 'root' } },
      { type: 'assistant', uuid: 'a0', parentUuid: 'u0', message: { content: 'root reply' } },
      { type: 'user', uuid: 'old-u', parentUuid: 'a0', message: { content: 'old question' } },
      { type: 'assistant', uuid: 'old-a', parentUuid: 'old-u', message: { content: 'old answer' } },
      { type: 'user', uuid: 'new-u', parentUuid: 'a0', message: { content: 'new question' } },
      { type: 'assistant', uuid: 'new-a', parentUuid: 'new-u', message: { content: 'new answer' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n' : turns(2);
    const id = `anchor-${variant}`;
    await writeFile(join(fixtureDir, `${id}.jsonl`), rows);
    const input = conversation(id);
    input.resumeAtMessageId = variant === 'old' ? 'old-a' : 'absent';
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(input, fixtureDir);
    try {
      await lease.ready;
      expect(lease.totalTurns).toBe(2);
      const page = await lease.loadWindow({
        anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
        budget: { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 8 },
      });
      expect(page.messages.map(message => message.content)).toEqual(variant === 'old'
        ? ['root', 'root reply', 'new question', 'new answer']
        : ['question 0', 'answer 0', 'question 1', 'answer 1']);
      expect(page.range).toEqual({ start: 0, end: 2 });
      expect(page.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(variant === 'old'
        ? ['root', 'new question'] : ['question 0', 'question 1']);
    } finally { lease.release(); }
  });

  it.each(['unrelated-progress', 'earlier-parent', 'earlier-progress', 'terminal-parent', 'terminal-progress', 'disconnected-root'] as const)(
    'preserves cross-segment projections for the %s boundary', async variant => {
      const priorId = `fix3-prior-${variant}`;
      const nextId = `fix3-next-${variant}`;
      const count = variant === 'unrelated-progress' ? 1 : 3;
      const alias = variant.includes('progress');
      const terminal = variant.startsWith('terminal');
      const prior = turns(count) + (alias ? JSON.stringify({ type: 'progress', uuid: 'p',
        parentUuid: variant === 'unrelated-progress' ? null : terminal ? 'a2' : 'a0' }) + '\n' : '');
      const parentUuid = alias ? 'p' : variant === 'disconnected-root' ? null : terminal ? 'a2' : 'a0';
      const next = [
        { type: 'user', uuid: 'next-u', parentUuid, message: { content: 'next question' } },
        { type: 'assistant', uuid: 'next-a', parentUuid: 'next-u', message: { content: 'next answer' } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n';
      await writeFile(join(fixtureDir, `${priorId}.jsonl`), prior);
      await writeFile(join(fixtureDir, `${nextId}.jsonl`), next);
      const input = conversation(nextId, { previousProviderSessionIds: [priorId] });
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(input, fixtureDir);
      try {
        await lease.ready;
        expect(lease.totalTurns).toBe(count + 1);
        const page = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
          budget: { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 8 } });
        expect(page.messages.map(message => message.content)).toEqual([
          ...Array.from({ length: count }, (_, i) => [`question ${i}`, `answer ${i}`]).flat(), 'next question', 'next answer',
        ]);
      } finally { lease.release(); }
    });

  it('shares a fixed index projection across leases and anchor changes', async () => {
    await writeFile(join(fixtureDir, 'prior.jsonl'), turns(1));
    const next = [
      { type: 'user', uuid: 'next-u', parentUuid: 'a0', message: { content: 'next question' } },
      { type: 'assistant', uuid: 'next-a', parentUuid: 'next-u', message: { content: 'next answer' } },
    ];
    await writeFile(join(fixtureDir, 'next.jsonl'), next.map(row => JSON.stringify(row)).join('\n') + '\n');
    const input = conversation('next', { previousProviderSessionIds: ['prior'] });
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(input, fixtureDir);
    const same = service.acquireHistoryIndex(input, fixtureDir);
    try {
      expect(lease).not.toHaveProperty('sizeRead', expect.anything());
      await Promise.all([lease.ready, same.ready]);
      expect(lease.totalTurns).toBe(2);
      expect(same.totalTurns).toBe(2);
      input.resumeAtMessageId = 'changed-after-ready';
      const page = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
        budget: { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 8 } });
      expect(page.range).toEqual({ start: 0, end: 2 });
      expect(page.messages.map(message => message.content)).toEqual(['question 0', 'answer 0', 'next question', 'next answer']);
    } finally { same.release(); lease.release(); }
    const dangling = conversation('next');
    const bad = service.acquireHistoryIndex(dangling, fixtureDir);
    try {
      await bad.ready;
      expect(bad.totalTurns).toBe(1);
    } finally { bad.release(); }
  });

  it('preserves cross-segment projections through a progress parent alias', async () => {
    await writeFile(join(fixtureDir, 'progress-prior.jsonl'), turns(1) + JSON.stringify({ type: 'progress', uuid: 'boundary-progress', parentUuid: 'a0' }) + '\n');
    const next = [
      { type: 'user', uuid: 'alias-u', parentUuid: 'boundary-progress', message: { content: 'next' } },
      { type: 'assistant', uuid: 'alias-a', parentUuid: 'alias-u', message: { content: 'reply' } },
    ];
    await writeFile(join(fixtureDir, 'progress-next.jsonl'), next.map(row => JSON.stringify(row)).join('\n') + '\n');
    const input = conversation('progress-next', { previousProviderSessionIds: ['progress-prior'] });
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(input, fixtureDir);
    try {
      await lease.ready;
      expect(lease.totalTurns).toBe(2);
    } finally { lease.release(); }
  });

  it.each([undefined, 'absent'])('keeps empty history pageable with anchor=%s', async anchor => {
    const id = anchor ? 'empty-anchor' : 'empty-proof';
    await writeFile(join(fixtureDir, `${id}.jsonl`), '');
    const input = conversation(id);
    input.resumeAtMessageId = anchor;
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(input, fixtureDir);
    try {
      await lease.ready;
      expect(lease.totalTurns).toBe(0);
    } finally { lease.release(); }
  });
});

describe('current-file size alongside bounded history indexes', () => {
  it('reads current-file bytes without building history, alongside a 50-turn page', async () => {
    const content = turns(300);
    await writeFile(join(fixtureDir, 'large.jsonl'), content);
    const input = conversation('large');
    const service = new ClaudeConversationHistoryService();
    const acquire = jest.spyOn(service, 'acquireHistoryIndex');

    const cold = await readSize(service, input);
    expect(cold.files).toEqual({ status: 'known', bytes: Buffer.byteLength(content), });
    expect(acquire).not.toHaveBeenCalled();

    const lease = service.acquireHistoryIndex(input, fixtureDir);
    await lease.ready;
    const page = await lease.loadWindow({
      anchorTurn: lease.totalTurns, direction: 'older', projectionLevel: 'summary',
      budget: { maxTurns: 50, maxSourceBytes: 8_000_000, maxProjectedChars: 2_000_000, timeSliceMs: 8 },
    });
    expect(page.range).toEqual({ start: 250, end: 300 });
    acquire.mockClear();
    await readSize(service, input);
    expect(acquire).not.toHaveBeenCalled();
    lease.release();
  });

  it('reads current-file bytes independently of missing chain segments, partial tails and malformed lines', async () => {
    await writeFile(join(fixtureDir, 'chain.jsonl'), turns(1));
    await writeFile(join(fixtureDir, 'partial.jsonl'), turns(1) + '{"type":"user"');
    await writeFile(join(fixtureDir, 'skipped.jsonl'), turns(1) + '{not json}\n');
    const snapshots: SizeResult[] = [];
    for (const input of [
      conversation('chain', { previousProviderSessionIds: ['absent-segment'] }),
      conversation('partial'),
      conversation('skipped'),
    ]) {
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(input, fixtureDir);
      await lease.ready;
      const snapshot = await readSize(service, input);
      snapshots.push(snapshot);
      lease.release();
    }
    expect(snapshots[0].files.status).toBe('known');
    expect(snapshots.slice(1).map(snapshot => snapshot.files.status)).toEqual(['known', 'known']);
  });

  it('stats current-file UTF-8 bytes when a parent path is hard-linked', async () => {
    await writeFile(join(fixtureDir, 'chinese.jsonl'), '汉字');
    await link(join(fixtureDir, 'chinese.jsonl'), join(fixtureDir, 'same-inode.jsonl'));
    const input = conversation('chinese', { previousProviderSessionIds: ['same-inode'] });
    const service = new ClaudeConversationHistoryService();
    const snapshot = await readSize(service, input);
    expect(snapshot.files).toEqual({ status: 'known', bytes: 6, });
    await service.readConversationSize({ id: input.id, providerId: input.providerId,
      source: service.captureConversationSizeSource(input),
    }, fixtureDir, { revision: 1 });
    await service.readConversationSize({ id: input.id, providerId: input.providerId,
      source: service.captureConversationSizeSource(conversation('chinese')),
    }, fixtureDir, { revision: 1 });
  });

  it('distinguishes a real empty file from a missing current file', async () => {
    await writeFile(join(fixtureDir, 'empty.jsonl'), '');
    const service = new ClaudeConversationHistoryService();
    expect((await readSize(service, conversation('empty'))).files)
      .toEqual({ status: 'known', bytes: 0, });
    expect((await readSize(service, conversation('not-present'))).files).toEqual({ status: 'unknown', reason: 'unavailable' });
  });

  it('reports stat permission failures as unknown rather than zero', async () => {
    const fsPromises = jest.requireActual<{ stat: typeof FsStat }>('fs/promises');
    const stat = jest.spyOn(fsPromises, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    try {
      const snapshot = await readSize(new ClaudeConversationHistoryService(), conversation('restricted'));
      expect(snapshot.files).toEqual({ status: 'unknown', reason: 'unavailable' });
    } finally {
      stat.mockRestore();
    }
  });
});
