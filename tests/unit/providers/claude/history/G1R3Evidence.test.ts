/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "loadFixture"] }] */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import type { HistoryIndexLease } from '@/core/providers/types';
import type { ChatMessage, Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as historyIndex from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';

const fixtureDir = join('/tmp', `claudian-g1-r3-claude-${randomUUID()}`);
jest.mock('@/providers/claude/history/sdkSessionPaths', () => ({
  ...jest.requireActual('@/providers/claude/history/sdkSessionPaths'),
  getSDKSessionPath: (_vault: string, id: string) => join(fixtureDir, `${id}.jsonl`),
  sdkSessionExists: (_vault: string, id: string) => existsSync(join(fixtureDir, `${id}.jsonl`)),
}));

beforeAll(async () => { await mkdir(fixtureDir); });
afterAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); });
afterEach(() => { historyIndex.clearTranscriptIndexCache(); historyIndex.setTranscriptIndexDiagnosticSink(null); });

async function loadFixture(id: string, rows: unknown[], complete: boolean, useWorker = false, check?: (messages: ChatMessage[], lease: HistoryIndexLease) => void | Promise<void>) {
  await writeFile(join(fixtureDir, `${id}.jsonl`), rows.length ? rows.map(row => JSON.stringify(row)).join('\n') + '\n' : '');
  const input: Conversation = { id, providerId: 'claude', title: 'Synthetic', createdAt: 1, updatedAt: 1,
    sessionId: id, providerState: { providerSessionId: id }, messages: [] };
  const original = historyIndex.buildTranscriptIndex;
  const build = jest.spyOn(historyIndex, 'buildTranscriptIndex').mockImplementation((path, options) => original(path, { ...options, useWorker }));
  const events: historyIndex.TranscriptIndexDiagnosticEvent[] = [];
  historyIndex.resetTranscriptIndexWorkerProbe();
  const service = new ClaudeConversationHistoryService();
  const lease = service.acquireHistoryIndex(input, fixtureDir);
  historyIndex.setTranscriptIndexDiagnosticSink(event => events.push(event));
  try {
    await lease.ready;
    const page = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
      budget: { maxTurns: 50, maxSourceBytes: 1_000_000, maxProjectedChars: 1_000_000, timeSliceMs: 8 } });
    await check?.(page.messages, lease);
    expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
    expect(events.filter(event => event.phase === 'complete' && event.mode === (useWorker ? 'worker' : 'direct'))).toHaveLength(1);
    return page.messages;
  } finally { lease.release(); build.mockRestore(); }
}

const toolRows = (contents: unknown[]) => [
  { type: 'user', uuid: 'u', parentUuid: null, message: { content: 'question' } },
  { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
  ...contents.map((content, i) => ({ type: 'user', uuid: `r${i}`, parentUuid: i === 0 ? 'a' : `r${i - 1}`,
    sourceToolUseID: 'tool', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content }] } })),
];

it.each([false, true])('R3 semantic slots and actual result Map coverage (worker=%s)', async useWorker => {
  const cases: Array<[string, unknown, boolean]> = [
    ['missing', [{ type: 'text' }], false], ['null', [{ type: 'text', text: null }], false],
    ['wrong', [{ type: 'text', text: 7 }], false], ['unknown', [{ type: 'future', text: 'lost' }], false],
    ['mixed', [{ type: 'text', text: 'kept' }, { type: 'text' }], false],
    ['nested', [{ type: 'tool_result', tool_use_id: 'inner', content: [{ type: 'text' }] }], false],
    ['empty-text', [{ type: 'text', text: '' }], true], ['empty-array', [], true], ['empty-string', '', true],
  ];
  for (const [name, content, complete] of cases) {
    const messages = await loadFixture(`slots-${name}-${useWorker}`, toolRows([content]), complete, useWorker);
    expect(messages.map(message => message.content)).toEqual(['question', '']);
  }
  for (const conflict of [false, true]) {
    const messages = await loadFixture(`map-${conflict}-${useWorker}`, toolRows(['first', conflict ? 'second' : 'first']), !conflict, useWorker);
    expect(messages[1].toolCalls?.[0].result).toBe(conflict ? 'second' : 'first');
  }
});

it.each([
  ['empty-user', [{ type: 'user', uuid: 'u', parentUuid: null, message: { content: [] } }], true],
  ['metadata', [{ type: 'queue-operation', operation: 'enqueue' }], true],
  ['unknown-system', [{ type: 'system', subtype: 'future-semantic', content: 'lost' }], false],
  ['unknown-queue', [{ type: 'queue-operation', operation: 'future-operation', content: 'lost' }], false],
] as const)('R3 known type is not semantic proof: %s', async (name, rows, complete) => {
  await loadFixture(name, [...rows], complete);
});

it.each(['patch', 'answers'].flatMap(kind => ['single', 'duplicate', 'conflict', 'unknown-field'].flatMap(variant =>
  [false, true].map(worker => [kind, variant, worker] as const))))(
  'R3 structured result Map: %s / %s / worker=%s', async (kind, variant, worker) => {
    const result = (text: string) => kind === 'patch' ? {
      filePath: 'semantic-only.fixture', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', `+${text}`] }],
    } : { answers: { q: text } };
    const first = result('first');
    const values = variant === 'single' ? [first] : [first,
      variant === 'conflict' ? result('second') : variant === 'unknown-field' ? { ...first, futureSemantic: 'lost' } : first];
    const rows = [
      { type: 'user', uuid: 'u', parentUuid: null, message: { content: 'question' } },
      { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { content: [{ type: 'tool_use', id: 'tool',
        name: kind === 'patch' ? 'Edit' : 'AskUserQuestion', input: { file_path: 'semantic-only.fixture', old_string: 'old', new_string: 'input' } }] } },
      ...values.map((toolUseResult, i) => ({ type: 'user', uuid: `r${i}`, parentUuid: i === 0 ? 'a' : `r${i - 1}`,
        sourceToolUseID: 'tool', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }] } })),
    ];
    const last = variant === 'conflict' ? 'second' : 'first';
    await loadFixture(`structured-${kind}-${variant}-${worker}`, rows, variant === 'single' || variant === 'duplicate', worker, messages => {
      expect(messages.map(message => message.content)).toEqual(['question', '']);
      const observed = kind === 'patch' ? messages[1].toolCalls?.[0].diffData?.diffLines.at(-1)?.text
        : messages[1].toolCalls?.[0].resolvedAnswers;
      expect(observed).toEqual(kind === 'patch' ? last : { q: last });
    });
  },
);

it.each(([
  ['valid', 'user-uuid', true],
  ['number', 123, false],
  ['boolean', true, false],
  ['object', { id: 'user' }, false],
  ['array', ['user'], false],
  ['zero', 0, false],
  ['false', false, false],
  ['null', null, false],
] as const).flatMap(([name, uuid, complete]) => [false, true].map(worker => [name, uuid, complete, worker] as const)))(
  'R3 UUID evidence preserves the pre-G1 user projection: %s / uuid=%s / complete=%s / worker=%s',
  async (name, uuid, complete, worker) => {
    await loadFixture(`uuid-${name}-${worker}`, [
      { type: 'user', uuid, parentUuid: null, message: { content: 'question' } },
    ], complete, worker, async (messages, lease) => {
      expect(messages.map(message => message.content)).toEqual(['question']);
      expect(messages[0].id).toEqual(uuid ?? 'skipped');
      const checksDetail = name === 'valid' || name === 'number';
      const exactDetail = expect.objectContaining({ status: 'exact', message: expect.objectContaining({ id: uuid, content: 'question' }) });
      const detail = checksDetail ? await lease.loadMessageDetail(messages[0].id, { maxSourceBytes: 100_000 }) : undefined;
      expect(detail).toEqual(checksDetail ? exactDetail : undefined);
    });
  },
);

it('R3 evidence hashing cannot change the compatible projection of an invalid tool id', async () => {
  const rows = [
    { type: 'user', uuid: 'u', parentUuid: null, message: { content: 'question' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { content: [{ type: 'tool_use', id: 42, name: 'Read', input: {} }] } },
  ];
  const messages = await loadFixture('invalid-tool-id', rows, false);
  expect(messages.map(message => message.content)).toEqual(['question', '']);
  expect(messages[1].toolCalls?.[0]).toMatchObject({ id: 42, name: 'Read', status: 'running' });
});

it('review RED: nested tool result missing text keeps canonical fallback but is incomplete', async () => {
  const id = 'nested';
  const rows = [
    { type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content: 'question' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
    { type: 'user', uuid: 'r', parentUuid: 'a', sourceToolUseID: 'tool', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'text' }] }] } },
  ];
  await writeFile(join(fixtureDir, `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const input: Conversation = { id, providerId: 'claude', title: 'Synthetic', createdAt: 1, updatedAt: 1,
    sessionId: id, providerState: { providerSessionId: id }, messages: [] };
  const service = new ClaudeConversationHistoryService();
  const lease = service.acquireHistoryIndex(input, fixtureDir);
  try {
    await lease.ready;
    const page = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
      budget: { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 8 } });
    expect(lease.totalTurns).toBe(1);
    expect(page.messages.map(message => message.content)).toEqual(['question', '']);
    expect(page.messages[1].toolCalls).toEqual([{ id: 'tool', name: 'Read', input: {}, status: 'completed', result: '[{"type":"text"}]', isExpanded: false }]);
  } finally { lease.release(); }
});
