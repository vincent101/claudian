import { existsSync, readFileSync } from 'fs';
import { appendFile, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { compareChatDisplayOrder, type Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import { materializeSDKMessages } from '@/providers/claude/history/ClaudeHistoryStore';
import { filterActiveBranch } from '@/providers/claude/history/sdkBranchFilter';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';

const fixtureDir = join(process.env.TMPDIR ?? '/tmp', `claudian-display-order-${process.pid}`);
const sessionId = 'display-order-fixture';
const oversizeSessionId = 'display-order-oversize-fixture';
const firstSegmentId = 'display-order-first-segment';
const missingSegmentId = 'display-order-missing-segment';
const thirdSegmentId = 'display-order-third-segment';
const turnCount = 6;

// Real modules everywhere; only session-path resolution is redirected into a
// temp directory so the fixture never touches ~/.claude. The point of this
// suite: displayOrder keys must come from the real materialization chain
// (index -> page read -> materializeSDKMessages), never from hand-crafted keys.
jest.mock('@/providers/claude/history/sdkSessionPaths', () => {
  const actual = jest.requireActual('@/providers/claude/history/sdkSessionPaths');
  return {
    ...actual,
    getSDKSessionPath: (_vaultPath: string, id: string) => join(fixtureDir, `${id}.jsonl`),
    sdkSessionExists: (_vaultPath: string, id: string) => existsSync(join(fixtureDir, `${id}.jsonl`)),
  };
});

/**
 * Linear 6-turn transcript (user question + assistant answer per turn), all
 * turns small enough to stay on the detail materialization path.
 */
async function writeSmallTurnsFixture(): Promise<void> {
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(fixtureDir, { recursive: true });
  const path = join(fixtureDir, `${sessionId}.jsonl`);
  await writeFile(path, '');
  const base = Date.parse('2026-09-16T00:00:00Z');
  for (let turn = 0; turn < turnCount; turn += 1) {
    const at = (offset: number): string => new Date(base + turn * 60_000 + offset).toISOString();
    const lines = [
      JSON.stringify({ type: 'user', uuid: `u${turn}`, parentUuid: turn === 0 ? null : `a${turn - 1}`, timestamp: at(0), message: { content: `Question ${turn}` } }),
      JSON.stringify({ type: 'assistant', uuid: `a${turn}`, parentUuid: `u${turn}`, timestamp: at(1_000), message: { content: [{ type: 'text', text: `Answer ${turn}` }] } }),
    ];
    for (const line of lines) await appendFile(path, `${line}\n`);
  }
}

function conversation(): Conversation {
  return {
    id: 'display-order-conversation',
    providerId: 'claude',
    title: 'Order',
    createdAt: 1,
    updatedAt: 1,
    sessionId,
    providerState: { providerSessionId: sessionId },
    messages: [],
  };
}

/**
 * Oversized-turn layout: turn 1 is a user question plus one giant tool result
 * (its placeholder is a system-injected row the projection skips, so the
 * summary turn's only assistant projection is the standalone turn marker);
 * turn 2 follows immediately.
 */
async function writeOversizeMarkerFixture(): Promise<void> {
  const giant = 600 * 1024;
  const path = join(fixtureDir, `${oversizeSessionId}.jsonl`);
  await writeFile(path, [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-09-16T00:00:00Z', message: { content: 'Question 1' } }),
    JSON.stringify({ type: 'user', uuid: 'tr1', parentUuid: 'u1', timestamp: '2026-09-16T00:00:02Z', sourceToolUseID: 'toolu_1', toolUseResult: { bytesRead: giant }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(giant) }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'tr1', timestamp: '2026-09-16T00:01:00Z', message: { content: 'Question 2' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-09-16T00:01:01Z', message: { content: [{ type: 'text', text: 'Answer 2' }] } }),
  ].join('\n') + '\n');
}

const looseBudget = {
  maxTurns: 25,
  maxSourceBytes: 8 * 1024 * 1024,
  maxProjectedChars: 2_000_000,
  timeSliceMs: 8,
};

const canonicalIds = Array.from({ length: turnCount }, (_, turn) => [`u${turn}`, `a${turn}`]).flat();

describe('HistoryDisplayOrderMaterialization with the real materialization chain', () => {
  beforeAll(async () => {
    await writeSmallTurnsFixture();
    await writeOversizeMarkerFixture();
    await writeFile(join(fixtureDir, `${firstSegmentId}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'first-u', parentUuid: null, message: { content: 'first' } })}\n`);
    await writeFile(join(fixtureDir, `${thirdSegmentId}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'third-u', parentUuid: null, message: { content: 'third' } })}\n`);
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('orders a multi-turn loadWindow page ascending without duplicate keys', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation(), fixtureDir);
    await lease.ready;
    expect(lease.totalTurns).toBe(turnCount);

    const page = await lease.loadWindow!({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: looseBudget,
      projectionLevel: 'summary',
    });
    lease.release();

    // The window loop materializes newest-first; only segment-global
    // displayOrder keys can restore the ascending transcript order. Local
    // per-turn keys would collide across turns and keep the reversed push
    // order (u5,u4,...,a5,a4,...).
    expect(page.messages.map(message => message.id)).toEqual(canonicalIds);
    const orders = page.messages.map(message => message.displayOrder!);
    for (let index = 1; index < orders.length; index += 1) {
      expect(compareChatDisplayOrder(
        { displayOrder: orders[index - 1] } as never,
        { displayOrder: orders[index] } as never,
      )).toBeLessThan(0);
    }
    expect(new Set(orders.map(order => order.join(':'))).size).toBe(orders.length);
  });

  it('merges an older loadRange page behind the newest one without interleaving', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation(), fixtureDir);
    await lease.ready;

    // Newest page first (first screen), then the older page prepend — the
    // exact merge ConversationController performs on "load earlier".
    const newestPage = await lease.loadRange(3, 6);
    const olderPage = await lease.loadRange(0, 3);
    lease.release();

    const combined = [...newestPage.messages, ...olderPage.messages].sort(compareChatDisplayOrder);
    // Page-local entry keys would collide between the two pages and
    // interleave them (u3,u0,a3,a0,...); segment-global keys must not.
    expect(combined.map(message => message.id)).toEqual(canonicalIds);
  });

  it('assigns window pages the same displayOrder keys as full-segment hydration', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation(), fixtureDir);
    await lease.ready;

    const fullWindow = await lease.loadWindow!({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: looseBudget,
      projectionLevel: 'summary',
    });
    // A differently anchored window (search locate) re-materializes the same
    // turns through a different path; keys must be identical, not just ordered.
    const aroundWindow = await lease.loadWindow!({
      anchorTurn: 3,
      direction: 'around',
      budget: looseBudget,
      projectionLevel: 'summary',
    });
    const paged = await lease.loadRange(0, 3);
    lease.release();

    // Hydration reference: readSDKSession shares a module with getSDKSessionPath
    // so the path mock cannot reach it; assemble the same chain manually with
    // the real filterActiveBranch + real materializeSDKMessages (base 0 = full
    // canonical segment), which is the key-generation part under test.
    const rawEntries = readFileSync(join(fixtureDir, `${sessionId}.jsonl`), 'utf8')
      .split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as SDKNativeMessage);
    const hydrated = await materializeSDKMessages(
      fixtureDir, sessionId, filterActiveBranch(rawEntries, undefined), rawEntries, 0,
    );
    const hydratedOrderById = new Map(hydrated.map(message => [message.id, message.displayOrder!]));

    for (const message of [...fullWindow.messages, ...aroundWindow.messages, ...paged.messages]) {
      expect(hydratedOrderById.has(message.id)).toBe(true);
      // Same id, same structural key across window/range/hydration paths —
      // this is what makes dedupe and cross-path merges sound.
      expect(message.displayOrder).toEqual(hydratedOrderById.get(message.id));
    }
    expect(fullWindow.messages).toHaveLength(canonicalIds.length);
  });

  it('preserves missing-session ordinal holes across hydration and iterator materialization', async () => {
    const source: Conversation = {
      ...conversation(), id: 'segmented', sessionId: thirdSegmentId,
      providerState: { previousProviderSessionIds: [firstSegmentId, missingSegmentId], providerSessionId: thirdSegmentId },
    };
    const service = new ClaudeConversationHistoryService();
    const hydrated = (await Promise.all([firstSegmentId, thirdSegmentId].map(async (id, presentIndex) => {
      const ordinal = presentIndex === 0 ? 0 : 2;
      const entries = readFileSync(join(fixtureDir, `${id}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as SDKNativeMessage);
      return materializeSDKMessages(fixtureDir, id, filterActiveBranch(entries, undefined), entries, ordinal);
    }))).flat();
    const iterated = [];
    for await (const page of service.iterateFullHistory(source, fixtureDir, {
      maxTurnsPerChunk: 10, maxSourceBytesPerChunk: 100_000, maxProjectedCharsPerChunk: 100_000, projectionLevel: 'detail',
    })) iterated.push(...page.messages);
    const hydrateById = new Map(hydrated.map(message => [message.id, message.displayOrder]));
    expect(iterated.map(message => message.displayOrder)).toEqual(iterated.map(message => hydrateById.get(message.id)));
    expect(iterated.find(message => message.id === 'third-u')?.displayOrder?.[0]).toBe(2);
  });

  it('keeps an oversized turn marker inside its turn when an older window is prepended', async () => {
    const pagingBudget = { ...looseBudget, maxSourceBytes: 256 * 1024 };
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex({
      ...conversation(),
      id: 'display-order-oversize-conversation',
      sessionId: oversizeSessionId,
      providerState: { providerSessionId: oversizeSessionId },
    }, fixtureDir);
    await lease.ready;
    expect(lease.totalTurns).toBe(2);

    // First screen under a budget that excludes the oversized turn, then the
    // "load earlier" window anchored at the loaded range start — the exact
    // ConversationController.loadOlderWindow sequence. The oversized turn only
    // enters through the prepended older window, so its turn marker must not
    // tie with the already-loaded next turn's opener key.
    const first = await lease.loadWindow!({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: pagingBudget,
      projectionLevel: 'summary',
    });
    expect(first.range).toEqual({ start: 1, end: 2 });
    const older = await lease.loadWindow!({
      anchorTurn: first.range.start,
      direction: 'older',
      budget: pagingBudget,
      minTurn: 0,
      projectionLevel: 'summary',
    });
    expect(older.range).toEqual({ start: 0, end: 1 });
    lease.release();

    const combined = [...first.messages, ...older.messages].sort(compareChatDisplayOrder);
    // The marker belongs to the end of turn 1 (before u2); the giant tool
    // result's placeholder is a system-injected row the projection skips, so
    // the summary turn contributes u1 plus the standalone marker. A marker key
    // tying with u2's entry slot lets the merge order float it behind u2.
    expect(combined.map(message => message.id)).toEqual([
      'u1', 'oversized-marker-u1', 'u2', 'a2',
    ]);
  });
});
