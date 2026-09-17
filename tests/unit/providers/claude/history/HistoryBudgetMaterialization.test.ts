import { existsSync, readFileSync } from 'fs';
import { appendFile, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import type { Conversation } from '@/core/types';
import { HISTORY_RESOURCE_POLICY } from '@/features/chat/history/HistoryResourcePolicy';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';

const fixtureDir = join(process.env.TMPDIR ?? '/tmp', `claudian-budget-${process.pid}`);
const sessionId = 'budget-fixture';

// Real modules everywhere; only session-path resolution is redirected into a
// temp directory so the fixture never touches ~/.claude.
jest.mock('@/providers/claude/history/sdkSessionPaths', () => {
  const actual = jest.requireActual('@/providers/claude/history/sdkSessionPaths');
  return {
    ...actual,
    getSDKSessionPath: (_vaultPath: string, id: string) => join(fixtureDir, `${id}.jsonl`),
    sdkSessionExists: (_vaultPath: string, id: string) => existsSync(join(fixtureDir, `${id}.jsonl`)),
  };
});

/**
 * Synthesizes a ~71 MB transcript with the real giant-session layout: 7 turns,
 * each a small user question + assistant text + Read tool call + ~10 MB tool
 * result + final summary text. The 1.59 GB case is explicitly out of jest.
 */
async function writeGiantFixture(): Promise<void> {
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(fixtureDir, { recursive: true });
  const path = join(fixtureDir, `${sessionId}.jsonl`);
  await writeFile(path, '');
  const giant = 10 * 1024 * 1024;
  const base = Date.parse('2026-09-15T00:00:00Z');
  for (let turn = 0; turn < 7; turn += 1) {
    const at = (offset: number): string => new Date(base + turn * 60_000 + offset).toISOString();
    const lines = [
      JSON.stringify({ type: 'user', uuid: `u${turn}`, parentUuid: turn === 0 ? null : `af${turn - 1}`, timestamp: at(0), message: { content: `Question ${turn}: analyze this dataset in detail` } }),
      JSON.stringify({ type: 'assistant', uuid: `a${turn}`, parentUuid: `u${turn}`, timestamp: at(1_000), message: { content: [{ type: 'text', text: `Working on question ${turn}, reading the source report first.` }] } }),
      JSON.stringify({ type: 'assistant', uuid: `tu${turn}`, parentUuid: `a${turn}`, timestamp: at(2_000), message: { content: [{ type: 'tool_use', id: `toolu_${turn}`, name: 'Read', input: { file_path: `/data/report-${turn}.md` } }] } }),
      JSON.stringify({ type: 'user', uuid: `tr${turn}`, parentUuid: `tu${turn}`, timestamp: at(3_000), sourceToolUseID: `toolu_${turn}`, toolUseResult: { bytesRead: giant }, message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${turn}`, content: 'x'.repeat(giant) }] } }),
      JSON.stringify({ type: 'assistant', uuid: `af${turn}`, parentUuid: `tr${turn}`, timestamp: at(4_000), message: { content: [{ type: 'text', text: `Summary of report ${turn}: the dataset is consistent with the prior quarter.` }] } }),
    ];
    for (const line of lines) await appendFile(path, `${line}\n`);
  }
}

function giantConversation(): Conversation {
  return {
    id: 'giant-conversation',
    providerId: 'claude',
    title: 'Giant',
    createdAt: 1,
    updatedAt: 1,
    sessionId,
    providerState: { providerSessionId: sessionId },
    messages: [],
  };
}

describe('HistoryBudgetMaterialization on a ~71MB giant session', () => {
  beforeAll(async () => {
    await writeGiantFixture();
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('serves a bounded readable first screen without materializing 50 turns', async () => {
    const service = new ClaudeConversationHistoryService();
    // Real vault path so the window diagnostics channel writes jsonl events.
    const lease = service.acquireHistoryIndex(giantConversation(), fixtureDir);
    await lease.ready;

    expect(lease.totalTurns).toBe(7);
    // Every turn is ~10 MB, so the fixed-50-turn path would materialize the
    // whole file; the budget window must not.
    const page = await lease.loadWindow({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: HISTORY_RESOURCE_POLICY.firstScreen,
      projectionLevel: 'summary',
    });

    expect(page.range).toEqual({ start: 6, end: 7 });
    expect(page.oversizedTurnCount).toBe(1);
    expect(page.sourceBytes).toBeLessThanOrEqual(HISTORY_RESOURCE_POLICY.firstScreen.maxSourceBytes);
    expect(page.sourceBytes).toBeLessThan(64 * 1024);
    expect(page.projectedChars).toBeLessThanOrEqual(HISTORY_RESOURCE_POLICY.firstScreen.maxProjectedChars);
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(false);

    const text = page.messages.map(message => message.content).join('\n');
    expect(text).toContain('Question 6');
    expect(text).toContain('Summary of report 6');

    const toolCalls = page.messages.flatMap(message => message.toolCalls ?? []);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('Read');
    // Skipped giant entry yields a completed tool call with an honest marker.
    expect(toolCalls[0].status).toBe('completed');
    expect(toolCalls[0].result).toContain('bytes omitted');

    lease.release();

    const diagnosticsPath = join(fixtureDir, '.claudian', 'diagnostics', 'history-window.current.jsonl');
    expect(existsSync(diagnosticsPath)).toBe(true);
    const events = readFileSync(diagnosticsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.phase === 'window_planned')).toHaveLength(1);
    const completed = events.filter(event => event.phase === 'window_complete');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    for (const event of completed) {
      expect(event.sourceBytes).toBeLessThanOrEqual(HISTORY_RESOURCE_POLICY.firstScreen.maxSourceBytes);
      expect(event.oversizedTurns).toBe(1);
    }
    expect(events.some(event => event.phase === 'lease_release')).toBe(true);
  });

  it('loads earlier windows page by page without exceeding the budget', async () => {
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(giantConversation(), '/vault');
    await lease.ready;

    const first = await lease.loadWindow({
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: HISTORY_RESOURCE_POLICY.paging,
      projectionLevel: 'summary',
    });
    const second = await lease.loadWindow({
      anchorTurn: first.range.start,
      direction: 'older',
      budget: HISTORY_RESOURCE_POLICY.paging,
      projectionLevel: 'summary',
    });

    expect(second.range).toEqual({ start: 5, end: 6 });
    expect(second.sourceBytes).toBeLessThanOrEqual(HISTORY_RESOURCE_POLICY.paging.maxSourceBytes);
    expect(second.pageKey).toBe('w:5:6');

    lease.release();
  });
});
