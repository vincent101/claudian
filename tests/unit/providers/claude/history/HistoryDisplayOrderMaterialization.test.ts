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
const toolResultSessionId = 'display-order-tool-result-fixture';
const asymmetricSessionId = 'display-order-asymmetric-fixture';
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

/**
 * Interrupted-turn layout: turn 0's assistant group is a text entry plus a
 * trailing tool_use, followed by its tool_result row — a system-injected row
 * the projection skips, so it sits OUTSIDE the assistant descriptor's entry
 * range. The descriptor slice [a0, a1] and the tool-association slice
 * [a1, tr0] therefore hold different entries at equal cardinality.
 */
async function writeToolResultFixture(): Promise<void> {
  await writeFile(join(fixtureDir, `${toolResultSessionId}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'u0', parentUuid: null, timestamp: '2026-09-16T00:00:00Z', message: { content: 'Question 0' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a0', parentUuid: 'u0', timestamp: '2026-09-16T00:00:01Z', message: { content: [{ type: 'text', text: 'Working on it' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'a0', timestamp: '2026-09-16T00:00:02Z', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/vault/notes.md' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'tr0', parentUuid: 'a1', timestamp: '2026-09-16T00:00:03Z', toolUseResult: { file: '/vault/notes.md' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'tool result payload' }] } }),
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: 'tr0', timestamp: '2026-09-16T00:01:00Z', message: { content: 'Question 1' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u1', timestamp: '2026-09-16T00:01:01Z', message: { content: [{ type: 'text', text: 'Answer 1' }] } }),
  ].join('\n') + '\n');
}

/**
 * Asymmetric 7-turn transcript around anchor turn 2: two large older turns
 * (520 projected chars each), one medium anchor (120), four small newer turns
 * (50 each). Older and newer sides differ in both size and turn count, so
 * window-shrink assertions can tell "drop the endpoint farther from the
 * anchor" apart from degenerate "always sacrifice the older side" behavior.
 */
async function writeAsymmetricTurnsFixture(): Promise<void> {
  const path = join(fixtureDir, `${asymmetricSessionId}.jsonl`);
  await writeFile(path, '');
  const base = Date.parse('2026-09-16T00:00:00Z');
  // [userChars, assistantChars] -> projected = userChars + 2 * assistantChars.
  const sizes: Array<[number, number]> = [
    [400, 60], [400, 60], [60, 30], [20, 15], [20, 15], [20, 15], [20, 15],
  ];
  for (let turn = 0; turn < sizes.length; turn += 1) {
    const at = (offset: number): string => new Date(base + turn * 60_000 + offset).toISOString();
    const lines = [
      JSON.stringify({ type: 'user', uuid: `u${turn}`, parentUuid: turn === 0 ? null : `a${turn - 1}`, timestamp: at(0), message: { content: 'o'.repeat(sizes[turn][0]) } }),
      JSON.stringify({ type: 'assistant', uuid: `a${turn}`, parentUuid: `u${turn}`, timestamp: at(1_000), message: { content: [{ type: 'text', text: 'x'.repeat(sizes[turn][1]) }] } }),
    ];
    for (const line of lines) await appendFile(path, `${line}\n`);
  }
}

const canonicalIds = Array.from({ length: turnCount }, (_, turn) => [`u${turn}`, `a${turn}`]).flat();

describe('HistoryDisplayOrderMaterialization with the real materialization chain', () => {
  beforeAll(async () => {
    await writeSmallTurnsFixture();
    await writeOversizeMarkerFixture();
    await writeToolResultFixture();
    await writeAsymmetricTurnsFixture();
    await writeFile(join(fixtureDir, `${firstSegmentId}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'first-u', parentUuid: null, message: { content: 'first' } })}\n`);
    await writeFile(join(fixtureDir, `${thirdSegmentId}.jsonl`), `${JSON.stringify({ type: 'user', uuid: 'third-u', parentUuid: null, message: { content: 'third' } })}\n`);
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('loads one exact projection by descriptor without materializing its whole turn', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation(), fixtureDir);
    await lease.ready;

    const detail = await lease.loadMessageDetail('u3', { maxSourceBytes: 16 * 1024 * 1024 });
    expect(detail).toMatchObject({
      status: 'exact',
      message: { id: 'u3', content: 'Question 3', projectionLevel: 'detail', historyTurnOrdinal: 3 },
    });
    await expect(lease.loadMessageDetail('missing', { maxSourceBytes: 16 * 1024 * 1024 }))
      .resolves.toEqual({ status: 'not_found' });
    await expect(lease.loadMessageDetail('u3', { maxSourceBytes: 1 }))
      .resolves.toEqual({ status: 'too_large' });
    lease.release();
  });

  it('materializes descriptor-external tool results in message detail', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex({
      ...conversation(),
      id: 'display-order-tool-result-conversation',
      sessionId: toolResultSessionId,
      providerState: { providerSessionId: toolResultSessionId },
    }, fixtureDir);
    await lease.ready;
    expect(lease.totalTurns).toBe(2);

    // Window-path sanity: the turn slice contains the tool_result row, so the
    // tool association is complete there.
    const page = await lease.loadWindow({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: looseBudget,
      projectionLevel: 'detail',
    });
    const completedCall = { id: 'toolu_1', status: 'completed', result: 'tool result payload' };
    expect(page.messages.find(message => message.id === 'a0')?.toolCalls)
      .toEqual([expect.objectContaining(completedCall)]);

    // Detail path: the assistant descriptor covers only the text + tool_use
    // entries while the tool_result row lies outside it. Equal cardinality of
    // the descriptor and association slices must not make the detail loader
    // reuse the native slice as associations — the tool call would lose its
    // result and fall back to a permanent "running" status.
    const detail = await lease.loadMessageDetail('a0', { maxSourceBytes: 16 * 1024 * 1024 });
    lease.release();

    expect(detail).toMatchObject({
      status: 'exact',
      message: {
        id: 'a0',
        toolCalls: [expect.objectContaining(completedCall)],
      },
    });
  });

  it('orders a multi-turn loadWindow page ascending without duplicate keys', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation(), fixtureDir);
    await lease.ready;
    expect(lease.totalTurns).toBe(turnCount);

    const page = await lease.loadWindow({
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

  it('merges an older window behind the newest one without interleaving', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation(), fixtureDir);
    await lease.ready;

    // Newest page first (first screen), then the older page prepend — the
    // exact merge ConversationController performs on "load earlier".
    const newestPage = await lease.loadWindow({
      anchorTurn: 6, direction: 'older', budget: { ...looseBudget, maxTurns: 3 }, projectionLevel: 'detail',
    });
    const olderPage = await lease.loadWindow({
      anchorTurn: 3, direction: 'older', budget: { ...looseBudget, maxTurns: 3 }, projectionLevel: 'detail',
    });
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

    const fullWindow = await lease.loadWindow({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: looseBudget,
      projectionLevel: 'summary',
    });
    // A differently anchored window (search locate) re-materializes the same
    // turns through a different path; keys must be identical, not just ordered.
    const aroundWindow = await lease.loadWindow({
      anchorTurn: 3,
      direction: 'around',
      budget: looseBudget,
      projectionLevel: 'summary',
    });
    const paged = await lease.loadWindow({
      anchorTurn: 3, direction: 'older', budget: { ...looseBudget, maxTurns: 3 }, projectionLevel: 'detail',
    });
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

  it('shrinks an asymmetric around window from the farthest endpoint on both sides', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex({
      ...conversation(),
      id: 'display-order-asymmetric-conversation',
      sessionId: asymmetricSessionId,
      providerState: { providerSessionId: asymmetricSessionId },
    }, fixtureDir);
    await lease.ready;
    expect(lease.totalTurns).toBe(7);

    // Anchor turn 2. Distances: [2, 1, 0, 1, 2, 3, 4]; projected chars:
    // [520, 520, 120, 50, 50, 50, 50], total 1360. A near-total budget must
    // drop only the two farthest turns (t6, t5 — both newer) while keeping the
    // nearer older turn t0; an older-side sacrifice would drop t0 first.
    const distant = await lease.loadWindow({
      anchorTurn: 2,
      direction: 'around',
      budget: { ...looseBudget, maxProjectedChars: 1300 },
      projectionLevel: 'summary',
    });
    expect(distant.range).toEqual({ start: 0, end: 5 });
    expect(distant.messages.map(message => message.id))
      .toEqual(['u0', 'a0', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']);
    expect(distant.projectedChars).toBeLessThanOrEqual(1300);

    // Tighter budget: the distance-2 endpoints (t0 older, t4 newer) both go
    // before the distance-1 neighbors (t1, t3), so both sides are trimmed
    // far-to-near while the anchor survives.
    const near = await lease.loadWindow({
      anchorTurn: 2,
      direction: 'around',
      budget: { ...looseBudget, maxProjectedChars: 730 },
      projectionLevel: 'summary',
    });
    lease.release();

    expect(near.range).toEqual({ start: 1, end: 4 });
    expect(near.messages.map(message => message.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    expect(near.messages.some(message => message.id === 'u2')).toBe(true);
    expect(near.projectedChars).toBeLessThanOrEqual(730);
  });

  it('assigns message detail the same displayOrder keys as the window path', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex({
      ...conversation(),
      id: 'display-order-detail-equality-conversation',
      sessionId: toolResultSessionId,
      providerState: { providerSessionId: toolResultSessionId },
    }, fixtureDir);
    await lease.ready;

    const page = await lease.loadWindow({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: looseBudget,
      projectionLevel: 'detail',
    });
    const windowOrderById = new Map(page.messages.map(message => [message.id, message.displayOrder!]));
    // The skipped tool_result row projects nowhere; both paths expose exactly
    // the four real projections of the fixture.
    expect([...windowOrderById.keys()].sort()).toEqual(['a0', 'a2', 'u0', 'u1']);

    for (const [id, windowOrder] of windowOrderById) {
      const detail = await lease.loadMessageDetail(id, { maxSourceBytes: 16 * 1024 * 1024 });
      expect(detail.status).toBe('exact');
      if (detail.status !== 'exact') continue;
      // Detail materialization slices a different entry range (descriptor
      // base vs turn base, e.g. a0: [a0, a1] at base 1 vs [u0..tr0] at base
      // 0); the segment-global key must still match field by field.
      expect(detail.message.displayOrder).toEqual(windowOrder);
    }
    lease.release();
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
    const first = await lease.loadWindow({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: pagingBudget,
      projectionLevel: 'summary',
    });
    expect(first.range).toEqual({ start: 1, end: 2 });
    const older = await lease.loadWindow({
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
