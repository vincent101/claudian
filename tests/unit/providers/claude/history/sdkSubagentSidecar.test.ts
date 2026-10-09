import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { TOOL_RESULT_PROJECTION_CHARS } from '@/core/tools/toolResultProjection';
import {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
} from '@/providers/claude/history/sdkSessionPaths';
import {
  loadSubagentFinalResult,
  loadSubagentToolCalls,
} from '@/providers/claude/history/sdkSubagentSidecar';

const fixtureRoot = join(process.env.TMPDIR ?? '/tmp', `claudian-sidecar-clamp-${process.pid}`);
const vaultPath = '/vault/clamp-test';

// Only session-path resolution is redirected into a temp directory; the
// sidecar parsing and clamping run against the real implementation.
jest.mock('@/providers/claude/history/sdkSessionPaths', () => {
  const actual = jest.requireActual('@/providers/claude/history/sdkSessionPaths');
  return {
    ...actual,
    getSDKProjectsPath: () => fixtureRoot,
  };
});

function sidecarPath(sessionId: string, agentId: string): string {
  return join(
    getSDKProjectsPath(),
    encodeVaultPathForSDK(vaultPath),
    sessionId,
    'subagents',
    `agent-${agentId}.jsonl`,
  );
}

function writeSidecar(sessionId: string, agentId: string, lines: unknown[]): void {
  const path = sidecarPath(sessionId, agentId);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}

describe('sdkSubagentSidecar source clamping (render-pipeline sub-item 3)', () => {
  beforeAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(fixtureRoot, { recursive: true });

    const originalChars = TOOL_RESULT_PROJECTION_CHARS + 5_000;
    const huge = 'q'.repeat(originalChars);

    // Session 1: tool_result above the projection budget.
    writeSidecar('sess-clamp', 'agent-big', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x.md' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: huge, is_error: false },
          ],
        },
      },
    ]);

    // Session 2: sub-threshold tool result stays intact.
    writeSidecar('sess-clamp', 'agent-small', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x.md' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'tiny result', is_error: false },
          ],
        },
      },
    ]);

    // Session 3: final result above the budget (assistant text block wins).
    writeSidecar('sess-clamp', 'agent-final', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'w'.repeat(TOOL_RESULT_PROJECTION_CHARS + 7_000) }],
        },
      },
    ]);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('loadSubagentToolCalls clamps oversized nested tool results at the source', async () => {
    const toolCalls = await loadSubagentToolCalls(vaultPath, 'sess-clamp', 'agent-big');

    expect(toolCalls).toHaveLength(1);
    const toolCall = toolCalls[0];
    expect(toolCall.result!.length).toBeLessThanOrEqual(TOOL_RESULT_PROJECTION_CHARS + 64);
    expect(toolCall.result!.startsWith('q'.repeat(100))).toBe(true);
    expect(toolCall.resultTruncated).toEqual({ originalChars: TOOL_RESULT_PROJECTION_CHARS + 5_000 });
  });

  it('loadSubagentToolCalls leaves sub-threshold results untouched', async () => {
    const toolCalls = await loadSubagentToolCalls(vaultPath, 'sess-clamp', 'agent-small');

    expect(toolCalls[0].result).toBe('tiny result');
    expect(toolCalls[0].resultTruncated).toBeUndefined();
  });

  it('loadSubagentFinalResult clamps oversized final results after extraction', async () => {
    const finalResult = await loadSubagentFinalResult(vaultPath, 'sess-clamp', 'agent-final');

    expect(finalResult!.length).toBeLessThanOrEqual(TOOL_RESULT_PROJECTION_CHARS + 64);
    expect(finalResult!.startsWith('w'.repeat(100))).toBe(true);
    expect(finalResult!.endsWith(`字符]`)).toBe(true);
  });
});
