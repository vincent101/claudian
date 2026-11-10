/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "assertProjection"] }] */
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import type { Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';

const fixtureDir = join('/tmp', `claudian-g1-r3-codex-${randomUUID()}`);
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const event = (type: string, item: Record<string, unknown>) => ({ type: 'event', event: { type, item } });
const prefix = (format: string) => format === 'mixed'
  ? [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } }] : [];

function conversation(id: string, providerState: Record<string, unknown>): Conversation {
  return { id, providerId: 'codex', title: 'Synthetic', createdAt: 1, updatedAt: 1,
    sessionId: 'thread', messages: [], providerState };
}

async function load(id: string, rows: unknown[]) {
  const path = join(fixtureDir, `${id}.jsonl`);
  await writeFile(path, jsonl(rows));
  const input = conversation(id, { threadId: 'thread', sessionFilePath: path });
  const service = new CodexConversationHistoryService();
  const receipt = await service.hydrateConversationHistory(input, fixtureDir);
  return { input, receipt, service };
}

beforeAll(async () => { await mkdir(fixtureDir); });
afterAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); });

async function assertProjection(id: string, rows: unknown[], expected: string[]) {
  const result = await load(id, rows);
  expect(result.input.messages.map(message => message.content)).toEqual(expected);
  expect(result.receipt).toMatchObject({ status: 'ready', });
  return result;
}

it.each(['legacy', 'mixed'])('preserves text/reasoning updates, empty terminals and unfinished items %s', async format => {
  for (const type of ['agent_message', 'reasoning']) {
    for (const variant of ['updates', 'duplicate', 'changed', 'empty', 'late-update', 'late-empty-update', 'unfinished']) {
      const item = (text: string) => ({ id: 'same', type, text });
      const rows = [...prefix(format),
        ...(variant === 'updates' || variant === 'unfinished' ? [event('item.updated', item('partial'))] : []),
        ...(variant !== 'unfinished' ? [event('item.completed', item('first'))] : []),
        ...(['duplicate', 'changed', 'empty'].includes(variant) ? [event('item.completed', item(variant === 'duplicate' ? 'first' : variant === 'empty' ? '' : 'second'))] : []),
        ...(['late-update', 'late-empty-update'].includes(variant) ? [event('item.updated', item(variant === 'late-update' ? 'second' : ''))] : []),
      ];
      const text = variant === 'unfinished' ? 'partial' : variant === 'changed' || variant === 'late-update' ? 'second' : 'first';
      const result = await assertProjection(`life-${format}-${type}-${variant}`, rows, [type === 'reasoning' ? '' : text]);
      expect(result.input.messages[0].contentBlocks).toEqual([{ type: type === 'reasoning' ? 'thinking' : 'text', content: text }]);
    }
  }
});

it.each(['legacy', 'mixed'])('retains the last projected text through empty item updates %s', async format => {
  for (const type of ['agent_message', 'reasoning']) {
    const item = (text: string) => ({ id: 'same', type, text });
    await assertProjection(`empty-after-update-${format}-${type}`, [...prefix(format), event('item.updated', item('partial')),
      event('item.updated', item('')), event('item.completed', item(''))], [type === 'reasoning' ? '' : 'partial']);
    await assertProjection(`empty-intermediate-${format}-${type}`, [...prefix(format), event('item.updated', item('partial')),
      event('item.updated', item('')), event('item.completed', item('final'))], [type === 'reasoning' ? '' : 'final']);
    await assertProjection(`empty-first-${format}-${type}`, [...prefix(format), event('item.completed', item(''))], []);
  }
});

it.each(['legacy', 'mixed'])('preserves legacy MCP status projection when result/error fields differ %s', async format => {
  const expectedTools = [{ id: 'tool', name: 'mcp__fixture__read', input: {}, status: 'completed', result: 'Completed' }];
  for (const field of ['result', 'error']) {
    const item = { id: 'tool', type: 'mcp_tool_call', server: 'fixture', tool: 'read', status: 'completed' };
    const raw = field === 'result' ? { content: [{ type: 'text', text: 'lost' }] } : 'lost';
    const result = await assertProjection(`legacy-mcp-${format}-${field}`, [...prefix(format), event('item.started', item), event('item.completed', { ...item, [field]: raw })], ['']);
    expect(result.input.messages[0].toolCalls).toEqual(expectedTools);
  }
  const item = { id: 'tool', type: 'mcp_tool_call', server: 'fixture', tool: 'read', status: 'completed' };
  const result = await assertProjection(`legacy-mcp-${format}-known`, [...prefix(format), event('item.started', item), event('item.completed', item), event('item.completed', item)], ['']);
  expect(result.input.messages[0].toolCalls).toEqual(expectedTools);
});

it('preserves modern message, reasoning and empty-content projections', async () => {
  const samples: Array<[string, unknown, string[]]> = [
    ['missing-reasoning', { type: 'reasoning' }, []],
    ['competing-reasoning', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'first' }], content: [{ type: 'reasoning_text', text: 'lost' }] }, ['']],
    ['null-text', { type: 'message', role: 'user', content: [{ type: 'input_text', text: null }] }, []],
    ['wrong-text', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 42 }] }, []],
    ['unknown-with-text', { type: 'message', role: 'user', content: [{ type: 'future', text: 'kept' }] }, ['kept']],
    ['extra-part-field', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'kept', future: 'lost' }] }, ['kept']],
    ['mixed', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'kept' }, { type: 'input_text' }] }, ['kept']],
    ['empty-content', { type: 'message', role: 'user', content: [] }, []],
    ['empty-text', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }, []],
    ['empty-reasoning', { type: 'reasoning', summary: [], content: [] }, []],
    ['unknown-mcp-result-field', { type: 'mcp_tool_call', call_id: 'c', server: 'fixture', tool: 'read', status: 'completed', result: { content: [{ type: 'text', text: 'kept' }], structuredContent: { lost: true } } }, ['']],
  ];
  for (const [name, payload, expected] of samples) {
    await assertProjection(`slots-${name}`, [{ type: 'response_item', payload }], expected);
  }
  const call = { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'view_image', arguments: '{"path":"fixture.png"}' } };
  for (const [name, output] of [
    ['null', null,], ['nested-missing', [{ type: 'input_image' }],],
    ['nested-null', [{ type: 'input_image', image_url: null }],], ['unknown', [{ type: 'future', image_url: 'lost' }],],
    ['empty', [],], ['valid', [{ type: 'input_image', image_url: 'synthetic' }],],
  ] as const) {
    await assertProjection(`output-${name}`, [call, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output } }], ['']);
  }
});

it.each([
  ['bash-extra', 'exec_command', '{"command":"fixture","future":"lost"}',],
  ['bash-missing', 'exec_command', '{"future":"lost"}',],
  ['bash-constructor', 'exec_command', '{"command":"fixture","constructor":"lost"}',],
  ['bash-proto', 'exec_command', '{"command":"fixture","__proto__":{"lost":true}}',],
  ['bash-known', 'exec_command', '{"cmd":"fixture"}',],
  ['passthrough', 'fixture_tool', '{"nested":{"future":"retained"}}',],
] as const)('preserves normalized tool input fields: %s', async (name, tool, args) => {
  const result = await assertProjection(`input-${name}`, [{ type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: tool, arguments: args } }], ['']);
  expect(result.input.messages[0].toolCalls?.[0]).toMatchObject({
    id: 'c', name: name === 'passthrough' ? 'fixture_tool' : 'Bash',
    input: name === 'passthrough' ? { nested: { future: 'retained' } }
      : { command: name === 'bash-missing' ? '' : 'fixture' },
  });
});

it('preserves last tool output UTF-16 code units, including lone surrogates', async () => {
  const first = '\ud800';
  const second = '\ud801';
  const result = await assertProjection('utf16-output', [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'fixture_tool', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: first } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: second } },
  ], ['']);
  expect(result.input.messages[0].toolCalls?.[0].result).toBe(second);
});

it('keeps messages empty for an empty user content array', async () => {
  const rows = [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }];
  await assertProjection('empty-disposition', rows, []);
});

it('retains tool-call origin across turns and compaction', async () => {
  const call = { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: '{"command":"fixture"}' } };
  const output = (text: string) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: text } });
  const turn = (id: string) => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } });
  const complete = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } };
  const crossTurn = await assertProjection('cross-turn-output', [turn('one'), call, complete, turn('two'), output('first'), output('first')], ['']);
  expect(crossTurn.input.messages[0].toolCalls?.[0]).toMatchObject({ id: 'c', result: 'first', status: 'completed' });
  const reused = await assertProjection('cross-turn-call-reuse', [turn('one'), call, output('first'), complete, turn('two'), call, output('second')], ['', '']);
  expect(reused.input.messages.map(message => message.toolCalls?.[0]?.result)).toEqual(['first', 'second']);
  const compacted = await assertProjection('compaction-reuse', [turn('one'), call, output('first'), { type: 'compacted', payload: { replacement_history: [call.payload, output('second').payload] } }], ['']);
  expect(compacted.input.messages[0].toolCalls?.[0]?.result).toBe('second');
  const orphan = await assertProjection('orphan-output', [turn('one'), output('first')], ['']);
  expect(orphan.input.messages[0].toolCalls?.[0]).toMatchObject({ id: 'c', result: 'first' });
  const replaced = await assertProjection('terminal-conflict', [turn('one'), call, output('first'), output('')], ['']);
  expect(replaced.input.messages[0].toolCalls?.[0]?.result).toBe('');
});

it.each(['completion-mismatch', 'reused-turn-id'])('preserves messages across completion mismatch and reused turn IDs: %s', async variant => {
  const rows = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: variant === 'completion-mismatch' ? 'other' : 'one' } },
    ...(variant === 'reused-turn-id' ? [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'next' } },
    ] : []),
  ];
  await assertProjection(`turn-${variant}`, rows, variant === 'reused-turn-id' ? ['answer', 'next'] : ['answer']);
});

it('projects MCP error when both error and result are present', async () => {
  const result = await assertProjection('mcp-error-result', [{ type: 'response_item', payload: { type: 'mcp_tool_call', call_id: 'c',
    server: 'fixture', tool: 'read', status: 'failed', error: 'failure', result: { content: [{ type: 'text', text: 'lost-result' }] } } }], ['']);
  expect(result.input.messages[0].toolCalls?.[0]).toMatchObject({ name: 'mcp__fixture__read', status: 'error', result: 'failure' });
});

it('preserves call-ID based output binding when kinds differ', async () => {
  const result = await assertProjection('output-kind', [
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c', name: 'fixture_tool', input: 'fixture' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'output' } },
  ], ['']);
  expect(result.input.messages[0].toolCalls?.[0]).toMatchObject({ id: 'c', name: 'fixture_tool', result: 'output' });
});

it.each(['legacy', 'mixed'])('preserves text updates following a terminal %s', async format => {
  const { input, receipt } = await load(`review-update-${format}`, [...prefix(format),
    event('item.completed', { id: 'item', type: 'agent_message', text: 'first' }),
    event('item.updated', { id: 'item', type: 'agent_message', text: 'second' }),
  ]);
  expect(input.messages.map(message => message.content)).toEqual(['second']);
  expect(receipt).toMatchObject({ status: 'ready', });
});

it.each(['legacy', 'mixed'])('preserves legacy MCP status when result contents change %s', async format => {
  const item = (text: string) => ({ id: 'item', type: 'mcp_tool_call', server: 'fixture', tool: 'read',
    status: 'completed', result: { content: [{ type: 'text', text }] } });
  const rows = [...prefix(format),
    event('item.started', item('first')), event('item.completed', item('first')), event('item.completed', item('second')),
  ];
  const { input, receipt } = await load(`review-mcp-${format}`, rows);
  expect(input.messages).toHaveLength(1);
  expect(input.messages[0].toolCalls).toEqual([{ id: 'item', name: 'mcp__fixture__read', input: {}, status: 'completed', result: 'Completed' }]);
  expect(receipt).toMatchObject({ status: 'ready', });
});

it.each(['legacy', 'mixed'])('keeps previously projected text after an empty terminal %s', async format => {
  const { input, receipt } = await load(`review-empty-${format}`, [...prefix(format),
    event('item.completed', { id: 'item', type: 'agent_message', text: 'first' }),
    event('item.completed', { id: 'item', type: 'agent_message', text: '' }),
  ]);
  expect(input.messages.map(message => message.content)).toEqual(['first']);
  expect(receipt).toMatchObject({ status: 'ready', });
});

it.each(['equivalent', 'offset', 'status', 'action', 'order', 'multiplicity'])('retains source-prefix projections for fork variants: %s', async variant => {
  const source = join(fixtureDir, `fork-source-${variant}.jsonl`);
  const native = join(fixtureDir, `fork-native-${variant}.jsonl`);
  const prior = jsonl([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'zero' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'prior' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'zero' } },
  ]);
  const actions = ['first', 'second'];
  await writeFile(source, (variant === 'offset' ? prior : '') + web('failed', actions));
  await writeFile(native, web(variant === 'status' ? 'cancelled' : 'failed', variant === 'action' ? ['changed', 'second']
    : variant === 'order' ? ['second', 'first'] : variant === 'multiplicity' ? [...actions, 'second'] : actions));
  const input = conversation(`fork-${variant}`, { threadId: 'thread', sessionFilePath: native,
    forkSourceSessionFilePath: source, forkSource: { sessionId: 'parent', resumeAt: 'one' } });
  const service = new CodexConversationHistoryService();
  const receipt = await service.hydrateConversationHistory(input, fixtureDir);
  expect(input.messages.map(message => message.content)).toEqual([...(variant === 'offset' ? ['prior'] : []), 'question', 'answer']);
  expect(input.messages.at(-1)?.toolCalls?.map(tool => tool.input.query)).toEqual(actions);
  expect(receipt).toMatchObject({ status: 'ready', });
});

function web(status: string, actions = ['fixture']) {
  return jsonl([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'question' } },
    ...actions.map(query => ({ type: 'response_item', payload: { type: 'web_search_call', action: { type: 'search', query }, status } })),
    { type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } },
  ]);
}

it('retains source search status when the fork copy differs', async () => {
  const source = join(fixtureDir, 'review-source.jsonl');
  const native = join(fixtureDir, 'review-native.jsonl');
  await writeFile(source, web('failed'));
  await writeFile(native, web('cancelled'));
  const input = conversation('review-fork', { threadId: 'thread', sessionFilePath: native,
    forkSourceSessionFilePath: source, forkSource: { sessionId: 'parent', resumeAt: 'one' } });
  const service = new CodexConversationHistoryService();
  const receipt = await service.hydrateConversationHistory(input, fixtureDir);
  expect(input.messages.map(message => message.content)).toEqual(['question', 'answer']);
  expect(input.messages[1].toolCalls).toEqual([{ id: 'tail-ws-2', name: 'WebSearch', input: { actionType: 'search', query: 'fixture' }, status: 'error', result: 'Search complete' }]);
  expect(receipt).toMatchObject({ status: 'ready', });
});
