import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { consumeHistoryText } from '@/core/providers/consumeHistoryText';
import { HistoryEntryTooLargeError, type HistoryIndexLease } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';

const fixtureDir = join(process.env.TMPDIR ?? '/tmp', `claudian-full-history-${process.pid}`);

jest.mock('@/providers/claude/history/sdkSessionPaths', () => {
  const actual = jest.requireActual('@/providers/claude/history/sdkSessionPaths');
  return {
    ...actual,
    getSDKSessionPath: (_vaultPath: string, id: string) => join(fixtureDir, `${id}.jsonl`),
    sdkSessionExists: (_vaultPath: string, id: string) => existsSync(join(fixtureDir, `${id}.jsonl`)),
  };
});

function conversation(sessionId = 'many'): Conversation {
  return { id: `conversation-${sessionId}`, providerId: 'claude', title: 'Fixture', createdAt: 1, updatedAt: 1,
    sessionId, providerState: { providerSessionId: sessionId }, messages: [] };
}

async function writeFixture(sessionId: string, turns: number, contentSize = 8): Promise<void> {
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 0; i < turns; i += 1) {
    lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, parentUuid: parent, timestamp: `${i}`,
      message: { content: `question-${i}-${'x'.repeat(contentSize)}` } }));
    lines.push(JSON.stringify({ type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, timestamp: `${i}.1`,
      message: { content: [{ type: 'text', text: `answer-${i}` }] } }));
    parent = `a${i}`;
  }
  await writeFile(join(fixtureDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

beforeAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); await mkdir(fixtureDir, { recursive: true }); });
afterAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); });

function trackReleases(service: ClaudeConversationHistoryService) {
  const acquired: HistoryIndexLease[] = [];
  const trace = { acquired, releases: 0 };
  const acquire = service.acquireHistoryIndex.bind(service);
  jest.spyOn(service, 'acquireHistoryIndex').mockImplementation((...args) => {
    const lease = acquire(...args);
    acquired.push(lease);
    const release = lease.release;
    lease.release = () => { trace.releases += 1; release(); };
    return lease;
  });
  return trace;
}

const iterationBudget = {
  maxTurnsPerChunk: 1, maxSourceBytesPerChunk: 10_000, maxProjectedCharsPerChunk: 10_000,
  projectionLevel: 'detail' as const,
};

describe('iterateFullHistory real materialization', () => {
  it('keeps a one-turn cursor fixed after a two-turn force refresh and reports done correctly', async () => {
    await writeFixture('fixed-cursor', 1);
    const service = new ClaudeConversationHistoryService();
    const source = conversation('fixed-cursor');
    const old = service.acquireHistoryIndex(source, fixtureDir);
    await old.ready;
    const iterable = service.iterateFullHistory(source, fixtureDir, {
      maxTurnsPerChunk: 10, maxSourceBytesPerChunk: 10_000, maxProjectedCharsPerChunk: 10_000, projectionLevel: 'detail',
    });
    // Preserve the committed prefix and append a real second turn.
    await writeFixture('fixed-cursor', 2);
    const fresh = service.acquireHistoryIndex(source, fixtureDir, undefined, true);
    try {
      await fresh.ready;
      const chunks = [];
      for await (const chunk of iterable) chunks.push(chunk);
      expect({ oldTotal: old.totalTurns, freshTotal: fresh.totalTurns,
        ranges: chunks.map(chunk => chunk.range), done: chunks.map(chunk => chunk.done) })
        .toEqual({ oldTotal: 1, freshTotal: 2, ranges: [{ start: 0, end: 1 }], done: [true] });
      expect(chunks.flatMap(chunk => chunk.messages).filter(message => message.role === 'user').map(message => message.content))
        .toEqual([`question-0-${'x'.repeat(8)}`]);
    } finally { old.release(); fresh.release(); }
  });

  it('keeps an unconsumed cursor on its captured source when the same id changes sessions', async () => {
    await writeFixture('source-old', 1); await writeFixture('source-new', 2);
    const service = new ClaudeConversationHistoryService();
    const source = conversation('source-old');
    const iterable = service.iterateFullHistory(source, fixtureDir, iterationBudget);
    source.providerState = { providerSessionId: 'source-new' };
    source.sessionId = 'source-new';
    const fresh = service.acquireHistoryIndex(source, fixtureDir);
    try {
      await fresh.ready;
      const chunks = [];
      for await (const chunk of iterable) chunks.push(chunk);
      expect({ ranges: chunks.map(chunk => chunk.range), done: chunks.map(chunk => chunk.done), currentTotal: fresh.totalTurns })
        .toEqual({ ranges: [{ start: 0, end: 1 }], done: [true], currentTotal: 2 });
      expect(chunks.flatMap(chunk => chunk.messages).filter(message => message.role === 'user').map(message => message.content))
        .toEqual([`question-0-${'x'.repeat(8)}`]);
    } finally { fresh.release(); }
  });

  it('bounds chunks and yields 1000 turns oldest-first without gaps or duplicates', async () => {
    await writeFixture('many', 1000);
    const service = new ClaudeConversationHistoryService();
    const chunks = [];
    for await (const chunk of service.iterateFullHistory(conversation(), fixtureDir, {
      maxTurnsPerChunk: 37, maxSourceBytesPerChunk: 32_000, maxProjectedCharsPerChunk: 8_000, projectionLevel: 'detail',
    })) chunks.push(chunk);
    expect(chunks.every(chunk => chunk.range.end - chunk.range.start <= 37 && chunk.sourceBytes <= 32_000)).toBe(true);
    expect(chunks[0].range.start).toBe(0);
    expect(chunks.at(-1)?.range.end).toBe(1000);
    expect(chunks.flatMap(chunk => chunk.messages).filter(message => message.role === 'user').map(message => message.content))
      .toEqual(Array.from({ length: 1000 }, (_, i) => `question-${i}-${'x'.repeat(8)}`));
  });

  it('releases its lease exactly once when the consumer returns early', async () => {
    await writeFixture('abort', 4);
    const service = new ClaudeConversationHistoryService();
    const original = service.acquireHistoryIndex.bind(service);
    let releases = 0;
    jest.spyOn(service, 'acquireHistoryIndex').mockImplementation((...args) => {
      const lease = original(...args); const release = lease.release;
      lease.release = () => { releases += 1; release(); };
      return lease;
    });
    for await (const chunk of service.iterateFullHistory(conversation('abort'), fixtureDir, {
      maxTurnsPerChunk: 1, maxSourceBytesPerChunk: 10_000, maxProjectedCharsPerChunk: 10_000, projectionLevel: 'detail',
    })) { void chunk; break; }
    expect(releases).toBe(1);
  });

  it('releases exactly once on normal exhaustion and remains closed', async () => {
    await writeFixture('exhaustion', 2);
    const service = new ClaudeConversationHistoryService();
    const trace = trackReleases(service);
    const iterable = service.iterateFullHistory(conversation('exhaustion'), fixtureDir, iterationBudget);
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    expect(chunks.map(chunk => chunk.done)).toEqual([false, true]);
    expect(trace.releases).toBe(1);
    await iterable[Symbol.asyncIterator]().return?.();
    expect(trace.releases).toBe(1);
  });

  it('closes an unstarted cursor and releases its eagerly acquired lease exactly once', async () => {
    await writeFixture('unstarted-close', 2);
    const service = new ClaudeConversationHistoryService();
    const trace = trackReleases(service);
    const iterable = service.iterateFullHistory(conversation('unstarted-close'), fixtureDir, iterationBudget);
    const cursor = iterable[Symbol.asyncIterator]();
    await cursor.return?.();
    await cursor.return?.();
    await expect(cursor.next()).resolves.toMatchObject({ done: true });
    expect(trace.acquired).toHaveLength(1);
    expect(trace.releases).toBe(1);
  });

  it.each([false, true])('releases an unstarted cursor on cancellation (alreadyAborted=%s)', async alreadyAborted => {
    await writeFixture(`unstarted-cancel-${alreadyAborted}`, 2);
    const service = new ClaudeConversationHistoryService();
    const trace = trackReleases(service);
    const controller = new AbortController();
    const reason = new Error('unstarted cancellation');
    if (alreadyAborted) controller.abort(reason);
    const iterable = service.iterateFullHistory(conversation(`unstarted-cancel-${alreadyAborted}`), fixtureDir,
      { ...iterationBudget, signal: controller.signal });
    if (!alreadyAborted) controller.abort(reason);
    expect(trace.releases).toBe(1);
    const cursor = iterable[Symbol.asyncIterator]();
    await expect(cursor.next()).rejects.toBe(reason);
    await cursor.return?.();
    expect(trace.releases).toBe(1);
  });

  it('cancels a pending first next without losing the caller reason or releasing twice', async () => {
    await writeFixture('pending-cancel', 2);
    const service = new ClaudeConversationHistoryService();
    const trace = trackReleases(service);
    const controller = new AbortController();
    const reason = new Error('pending cancellation');
    const cursor = service.iterateFullHistory(conversation('pending-cancel'), fixtureDir,
      { ...iterationBudget, signal: controller.signal })[Symbol.asyncIterator]();
    const pending = cursor.next();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await cursor.return?.();
    expect(trace.releases).toBe(1);
  });

  it('releases a yielded cursor on cancellation even if the consumer never requests another chunk', async () => {
    await writeFixture('paused-cancel', 2);
    const service = new ClaudeConversationHistoryService();
    const trace = trackReleases(service);
    const controller = new AbortController();
    const cursor = service.iterateFullHistory(conversation('paused-cancel'), fixtureDir,
      { ...iterationBudget, signal: controller.signal })[Symbol.asyncIterator]();
    const first = await cursor.next();
    expect(first.value.range).toEqual({ start: 0, end: 1 });
    controller.abort(new Error('paused cancellation'));
    expect(trace.releases).toBe(1);
    await cursor.return?.();
    expect(trace.releases).toBe(1);
  });

  it('preserves a writer failure and closes the real for-await cursor exactly once', async () => {
    await writeFixture('writer-failure', 2);
    const service = new ClaudeConversationHistoryService();
    const trace = trackReleases(service);
    const reason = new Error('synthetic writer failure');
    const abort = jest.fn();
    const writer = { write: jest.fn(async () => { throw reason; }), abort };
    await expect(consumeHistoryText(service.iterateFullHistory(conversation('writer-failure'), fixtureDir, iterationBudget), writer))
      .rejects.toBe(reason);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(reason);
    expect(trace.releases).toBe(1);
  });

  it('rejects an oversized single turn instead of summarizing it', async () => {
    await writeFixture('huge', 1, 20_000);
    const service = new ClaudeConversationHistoryService();
    const consume = async () => {
      for await (const chunk of service.iterateFullHistory(conversation('huge'), fixtureDir, {
        maxTurnsPerChunk: 2, maxSourceBytesPerChunk: 1_000, maxProjectedCharsPerChunk: 1_000, projectionLevel: 'detail',
      })) { void chunk; }
    };
    await expect(consume()).rejects.toBeInstanceOf(HistoryEntryTooLargeError);
  });

  it('propagates the abort reason instead of mislabeling it transcript_unavailable', async () => {
    await writeFixture('abortreason', 3);
    const service = new ClaudeConversationHistoryService();
    const controller = new AbortController();
    const reason = new Error('consumer cancelled');
    const consume = async () => {
      for await (const chunk of service.iterateFullHistory(conversation('abortreason'), fixtureDir, {
        maxTurnsPerChunk: 1, maxSourceBytesPerChunk: 10_000, maxProjectedCharsPerChunk: 10_000, projectionLevel: 'detail',
        signal: controller.signal,
      })) {
        void chunk;
        controller.abort(reason);
      }
    };
    // An abort is a consumer-side cancellation, not a source failure — the
    // reason must reach the caller as-is so cancel paths can be told apart
    // from a genuinely missing transcript.
    await expect(consume()).rejects.toBe(reason);
  });
});
