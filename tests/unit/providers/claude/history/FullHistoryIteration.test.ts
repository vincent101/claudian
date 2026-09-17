import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { HistoryEntryTooLargeError } from '@/core/providers/types';
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

describe('iterateFullHistory real materialization', () => {
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
});
