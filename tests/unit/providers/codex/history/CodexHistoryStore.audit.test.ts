import { parseCodexSessionTurns } from '@/providers/codex/history/CodexHistoryStore';

const response = (payload: unknown) => ({ type: 'response_item', payload });
const event = (payload: unknown) => ({ type: 'event_msg', payload });
const legacy = (item: unknown) => ({ type: 'event', event: { type: 'item.completed', item } });
const message = (text: unknown = 'valid') => response({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const contents = (content: string) => parseCodexSessionTurns(content).flatMap(turn => turn.messages).map(msg => msg.content);

const damaged: Array<[string, unknown, string[]]> = [
  ['event attachment not represented', event({ type: 'user_message', message: '', images: ['fixture.png'] }), []],
  ['MCP nontext result not represented', response({ type: 'mcp_tool_call', call_id: 'mcp', server: 'fixture', tool: 'read', status: 'completed', result: { content: [{ type: 'image', data: 'fixture' }] } }), ['']],
  ['unknown web search action', response({ type: 'web_search_call', action: { type: 'future-action', query: 'fixture' } }), ['']],
  ['missing input_text text', response({ type: 'message', role: 'user', content: [{ type: 'input_text' }] }), []],
  ['non-string output_text', response({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 42 }] }), []],
  ['unknown role', response({ type: 'message', role: 'future-role', content: [{ type: 'input_text', text: 'lost' }] }), []],
  ['missing content', response({ type: 'message', role: 'user' }), []],
  ['unsupported attachment', response({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'fixture' }] }), []],
  ['unknown part carrying text', response({ type: 'message', role: 'user', content: [{ type: 'future-part', text: 'kept' }] }), ['kept']],
  ['damaged reasoning summary', response({ type: 'reasoning', summary: [{ type: 'summary_text' }] }), []],
  ['unsupported reasoning part', response({ type: 'reasoning', content: [{ type: 'future-reasoning', text: 'kept' }] }), ['']],
  ['missing tool identity', response({ type: 'function_call', name: 'exec_command', arguments: '{}' }), []],
  ['damaged tool output', response({ type: 'function_call_output', call_id: 'tool', output: { text: 'lost' } }), ['']],
  ['unknown payload', response({ type: 'future-message', text: 'lost' }), []],
  ['missing event text', event({ type: 'user_message' }), []],
  ['non-string agent event', event({ type: 'agent_message', message: 42 }), []],
  ['damaged event reasoning', event({ type: 'agent_reasoning', text: 42 }), []],
  ['unknown event semantics', event({ type: 'future-event', message: 'lost' }), []],
  ['legacy missing message text', legacy({ id: 'item', type: 'agent_message' }), []],
  ['legacy missing reasoning text', legacy({ id: 'item', type: 'reasoning' }), []],
  ['legacy unknown semantic item', legacy({ id: 'item', type: 'future-item', text: 'lost' }), []],
  ['compacted bad replacement', { type: 'compacted', payload: { replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text' }] }] } }, []],
  ['unknown top-level record', { type: 'future-record', payload: { message: 'lost' } }, []],
];

it.each(['legacy', 'mixed'])('R2 case 5: audits actual terminal text/reasoning/tool replacement in %s', format => {
  for (const type of ['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call']) {
    for (const conflict of [true, false]) {
      // Type-owned fixtures: unrelated fields from other item types must not
      // certify an accidental union shape or mask which terminal slot changed.
      const item = (last: boolean) => {
        const value = last && conflict ? 'second' : 'first';
        if (type === 'agent_message' || type === 'reasoning') return { id: 'call', type, text: value };
        if (type === 'command_execution') return { id: 'call', type, command: 'fixture', aggregated_output: value, exit_code: 0 };
        if (type === 'file_change') return { id: 'call', type, changes: [{ path: value, kind: 'update' }], status: 'completed' };
        return { id: 'call', type, server: 'fixture', tool: 'read', status: last && conflict ? 'failed' : 'completed' };
      };
      const rows = [
        ...(format === 'mixed' ? [event({ type: 'task_started', turn_id: 'one' })] : []),
        { type: 'event', event: { type: 'item.started', item: item(false) } }, legacy(item(false)), legacy(item(true)),
      ];
      const parsed = parseCodexSessionTurns(jsonl(...rows));
      expect(parsed.flatMap(turn => turn.messages)).toHaveLength(1);
    }
  }
});

it.each([
  [jsonl(legacy({ id: 'one', type: 'agent_message', text: 'first' }), legacy({ id: 'two', type: 'agent_message', text: 'last' })), ['last']],
  [jsonl(event({ type: 'task_started', turn_id: 'one' }), response({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] }), legacy({ id: 'two', type: 'agent_message', text: 'last' })), ['last']],
  [jsonl(legacy({ id: 'tool', type: 'command_execution', aggregated_output: 'lost', exit_code: 0 })), []],
])('G1 audits an unproved legacy/mixed merge or dropped tool completion (%#)', (content, expected) => {
  const parsed = parseCodexSessionTurns(content as string);
  expect(parsed.flatMap(turn => turn.messages).map(msg => msg.content)).toEqual(expected);
});

it.each([
  [response({ type: 'mcp_tool_call', call_id: 'one', server: 'fixture', tool: 'read', status: 'running' }), response({ type: 'mcp_tool_call', call_id: 'one', server: 'fixture', tool: 'read', status: 'completed', result: { content: [{ type: 'text', text: 'lost' }] } })],
  [response({ type: 'web_search_call', call_id: 'one', action: { type: 'search', query: 'first' } }), response({ type: 'web_search_call', call_id: 'one', action: { type: 'search', query: 'lost' } })],
  [response({ type: 'function_call', call_id: 'one', name: 'exec_command', arguments: '{"command":"first"}' }), response({ type: 'function_call', call_id: 'one', name: 'exec_command', arguments: '{"command":"last"}' })],
])('G1 audits actual conflicting tool-identity merge exits (%#)', (first, last) => {
  const parsed = parseCodexSessionTurns(jsonl(event({ type: 'task_started', turn_id: 'turn' }), first, last));
  const messages = parsed.flatMap(turn => turn.messages);
  expect(messages).toHaveLength(1);
  expect(messages[0].toolCalls).toHaveLength(1);
});

it.each(['conflict', 'identical', 'single-final', 'array-conflict', 'array-identical'] as const)(
  'G1 fix 6: audits output replacement even when normalization hides differences (%s)', variant => {
    const array = variant.startsWith('array');
    const first = array ? [{ type: 'input_image', image_url: 'first' }] : 'first';
    const last = variant.includes('conflict') ? array ? [{ type: 'input_image', image_url: 'second' }] : 'second' : first;
    const call = response({ type: 'function_call', call_id: 'one', name: array ? 'view_image' : 'exec_command',
      arguments: array ? '{"path":"fixture.png"}' : '{"command":"fixture"}' });
    const output = response({ type: 'function_call_output', call_id: 'one', output: first });
    const rows = [event({ type: 'task_started', turn_id: 'turn' }), call, output];
    if (variant !== 'single-final') rows.push(response({ type: 'function_call_output', call_id: 'one', output: last }));
    const parsed = parseCodexSessionTurns(jsonl(...rows));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].messages).toHaveLength(1);
    expect(parsed[0].messages[0].toolCalls?.[0]).toMatchObject({ result: array ? 'fixture.png' : last, status: 'completed' });
  });

it.each([
  response({ type: 'function_call', call_id: 'one', name: 'exec_command', arguments: '{"command":"fixture"}' }),
  response({ type: 'mcp_tool_call', call_id: 'one', server: 'fixture', tool: 'read', status: 'completed', result: { content: [{ type: 'text', text: 'retained' }] } }),
  response({ type: 'web_search_call', call_id: 'one', action: { type: 'search', query: 'fixture' }, status: 'completed' }),
])('G1 regression: identical tool identity/value repeats are proved omissions (%#)', row => {
  const parsed = parseCodexSessionTurns(jsonl(event({ type: 'task_started', turn_id: 'turn' }), row, row));
  expect(parsed.flatMap(turn => turn.messages)).toHaveLength(1);
  expect(parsed[0].messages[0].toolCalls).toHaveLength(1);
});

it('G1 regression: updates to the same legacy item remain a lawful replacement', () => {
  const content = jsonl({ type: 'event', event: { type: 'item.updated', item: { id: 'one', type: 'agent_message', text: 'partial' } } }, legacy({ id: 'one', type: 'agent_message', text: 'final' }));
  expect(contents(content)).toEqual(['final']);
});

it.each(damaged)('G1 audits %s at its real normal parser exit without changing messages', (_name, row, expected) => {
  const content = jsonl(row);
  expect(contents(content)).toEqual(expected);
});

it.each(damaged.filter(([name]) => !name.startsWith('compacted')))('G1 does not certify a partial mixed count after %s', (_name, row) => {
  const parsed = parseCodexSessionTurns(jsonl(message(), row));
  expect(parsed.flatMap(turn => turn.messages).some(msg => msg.content === 'valid')).toBe(true);
});

it.each([
  ['', []],
  [jsonl(response({ type: 'message', role: 'user', content: [] })), []],
  [jsonl(message('')), []],
  [jsonl(message('  ')), []],
  [jsonl(event({ type: 'user_message', message: '' }), event({ type: 'agent_message', message: ' ' })), []],
  [jsonl(response({ type: 'reasoning', summary: [], content: [] })), []],
  [jsonl(response({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] })), ['']],
  [jsonl(response({ type: 'function_call', call_id: 'tool', name: 'view_image', arguments: '{"path":"fixture.png"}' }), response({ type: 'function_call_output', call_id: 'tool', output: [{ type: 'input_image', image_url: 'fixture' }] })), ['']],
  [jsonl(event({ type: 'context_compacted' })), ['']],
  [jsonl(message('old'), { type: 'compacted', payload: { replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'replacement' }] }] } }, event({ type: 'context_compacted' })), ['replacement', '']],
  [jsonl(message('# AGENTS.md instructions\nfixture'), event({ type: 'token_count' })), []],
])('G1 regression: legal empty, reasoning, tool, or compaction output remains complete (%#)', (content, expected) => {
  const parsed = parseCodexSessionTurns(content as string);
  expect(parsed.flatMap(turn => turn.messages).map(msg => msg.content)).toEqual(expected);
});
