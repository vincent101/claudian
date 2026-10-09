import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { TOOL_RESULT_PROJECTION_CHARS } from '@/core/tools/toolResultProjection';
import type { ChatMessage } from '@/core/types';
import { materializeSDKMessages } from '@/providers/claude/history/ClaudeHistoryStore';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';
import {
  encodeVaultPathForSDK,
  getSDKProjectsPath,
} from '@/providers/claude/history/sdkSessionPaths';

const fixtureRoot = join(process.env.TMPDIR ?? '/tmp', `claudian-store-clamp-${process.pid}`);
const vaultPath = '/vault/store-clamp';
const sessionId = 'sess-store';

// Session-path resolution and the subagent sidecar root are redirected into a
// temp directory; the materialization chain itself runs unmocked.
jest.mock('@/providers/claude/history/sdkSessionPaths', () => {
  const actual = jest.requireActual('@/providers/claude/history/sdkSessionPaths');
  return {
    ...actual,
    getSDKSessionPath: (_vaultPath: string, id: string) => join(fixtureRoot, `${id}.jsonl`),
    sdkSessionExists: (_vaultPath: string, id: string) => false,
    getSDKProjectsPath: () => fixtureRoot,
  };
});

function writeSidecar(agentId: string, lines: unknown[]): void {
  const path = join(
    getSDKProjectsPath(),
    encodeVaultPathForSDK(vaultPath),
    sessionId,
    'subagents',
    `agent-${agentId}.jsonl`,
  );
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}

const OVER_BUDGET = TOOL_RESULT_PROJECTION_CHARS + 40_000;

function findToolCall(messages: ChatMessage[], toolId: string) {
  for (const msg of messages) {
    const toolCall = msg.toolCalls?.find(tc => tc.id === toolId);
    if (toolCall) return toolCall;
  }
  return undefined;
}

describe('materializeSDKMessages projection clamping (render-pipeline sub-item 3)', () => {
  beforeAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(fixtureRoot, { recursive: true });

    // Sidecar for the async subagent fixture: one nested tool result above
    // the projection budget.
    writeSidecar('agent-async', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_in', name: 'Read', input: { file_path: '/x.md' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_in', content: 'n'.repeat(OVER_BUDGET), is_error: false },
          ],
        },
      },
    ]);
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  async function materialize(entries: SDKNativeMessage[]): Promise<ChatMessage[]> {
    const serialized = entries.map(entry => JSON.parse(JSON.stringify(entry)) as SDKNativeMessage);
    const messages = await materializeSDKMessages(vaultPath, sessionId, serialized);
    // Same-input invariance: materialization must never mutate its input —
    // the index/search corpus is derived from these entries independently.
    for (let i = 0; i < serialized.length; i += 1) {
      expect(JSON.stringify(serialized[i])).toBe(JSON.stringify(entries[i]));
    }
    return messages;
  }

  it('clamps oversized tool results in the materialized projection with metadata', async () => {
    const messages = await materialize([
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-10-09T00:00:00Z',
        message: { content: 'Question 1' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-10-09T00:00:01Z',
        message: {
          content: [
            { type: 'text', text: 'Working' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/vault/x.md' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'tr1',
        parentUuid: 'a1',
        timestamp: '2026-10-09T00:00:02Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'r'.repeat(OVER_BUDGET), is_error: false },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'tr1',
        timestamp: '2026-10-09T00:01:00Z',
        message: { content: 'Question 2' },
      },
    ]);

    const toolCall = findToolCall(messages, 'toolu_1');
    expect(toolCall).toBeDefined();
    expect(toolCall!.result!.length).toBeLessThanOrEqual(TOOL_RESULT_PROJECTION_CHARS + 64);
    expect(toolCall!.result!.startsWith('r'.repeat(100))).toBe(true);
    expect(toolCall!.resultTruncated).toEqual({ originalChars: OVER_BUDGET });
  });

  it('clamps the async subagent write-back (toolCall.result and subagent.result)', async () => {
    const messages = await materialize([
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-10-09T00:00:00Z',
        message: { content: 'Question 1' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-10-09T00:00:01Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'task-1',
              name: 'Task',
              input: { description: 'Bg work', prompt: 'Do things', run_in_background: true },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'tr1',
        parentUuid: 'a1',
        timestamp: '2026-10-09T00:00:02Z',
        toolUseResult: { agentId: 'agent-async' },
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'task-1', content: 'Task launched', is_error: false },
          ],
        },
      },
      {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-10-09T00:02:00Z',
        content: `<task-notification><task-id>agent-async</task-id><status>completed</status><result>${'f'.repeat(OVER_BUDGET)}</result></task-notification>`,
      },
    ]);

    const taskToolCall = findToolCall(messages, 'task-1');
    expect(taskToolCall).toBeDefined();
    expect(taskToolCall!.subagent).toBeDefined();
    expect(taskToolCall!.subagent!.result!.length).toBeLessThanOrEqual(TOOL_RESULT_PROJECTION_CHARS + 64);
    expect(taskToolCall!.result).toBe(taskToolCall!.subagent!.result);
    expect(taskToolCall!.resultTruncated).toEqual({ originalChars: OVER_BUDGET });
  });

  it('history sidecar injection delivers already-clamped nested tool results', async () => {
    const messages = await materialize([
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-10-09T00:00:00Z',
        message: { content: 'Question 1' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-10-09T00:00:01Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'task-1',
              name: 'Task',
              input: { description: 'Bg work', prompt: 'Do things', run_in_background: true },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'tr1',
        parentUuid: 'a1',
        timestamp: '2026-10-09T00:00:02Z',
        toolUseResult: { agentId: 'agent-async' },
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'task-1', content: 'Task launched', is_error: false },
          ],
        },
      },
    ]);

    const taskToolCall = findToolCall(messages, 'task-1');
    const nested = taskToolCall!.subagent!.toolCalls;
    expect(nested).toHaveLength(1);
    expect(nested[0].result!.length).toBeLessThanOrEqual(TOOL_RESULT_PROJECTION_CHARS + 64);
    expect(nested[0].resultTruncated).toEqual({ originalChars: OVER_BUDGET });
  });

  it('never touches user message content (rewind/fork exact content)', async () => {
    const bigUserContent = 'u'.repeat(TOOL_RESULT_PROJECTION_CHARS + 25_000);
    const messages = await materialize([
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-10-09T00:00:00Z',
        message: { content: bigUserContent },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-10-09T00:00:01Z',
        message: {
          content: [
            { type: 'text', text: 'Answer' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/vault/x.md' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'tr1',
        parentUuid: 'a1',
        timestamp: '2026-10-09T00:00:02Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'r'.repeat(OVER_BUDGET), is_error: false },
          ],
        },
      },
    ]);

    const userMsg = messages.find(m => m.id === 'u1');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe(bigUserContent);
  });
});
