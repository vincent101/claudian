import { readFile } from 'fs/promises';
import { join } from 'path';

import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';
import { classifyLeaselessTurnStart, ClaudeTranscriptTurnMapper, extractExternalDisplayContent } from '@/providers/claude/transcript/ClaudeTranscriptTurnMapper';

const peer = {
  type: 'user' as const,
  uuid: 'peer-user-1',
  isSidechain: false,
  origin: { kind: 'peer', name: 'worker', body: '[to] host\n[msg] inspect report' },
  message: { role: 'user', content: 'transport envelope' },
};

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe('ClaudeTranscriptTurnMapper', () => {
  it('keeps the redacted production mid-turn peer separate from host assistant output', async () => {
    const content = await readFile(join(__dirname, 'fixtures', 'mid-turn-peer.jsonl'), 'utf8');
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = content.trim().split('\n').flatMap(entry => (
      mapper.mapLine(entry, false, { hostUserTurnActive: true })
    ));
    expect(events).toEqual([expect.objectContaining({
      type: 'embedded',
      event: expect.objectContaining({ transcriptUserId: 'peer-mid-turn', displayContent: 'fixture peer message' }),
    })]);
    expect(mapper.hasOpenTurn()).toBe(false);
  });

  it.each(['peer-turn.jsonl', 'controlled-no-result.jsonl'])('maps the redacted real-shape fixture %s without stdout events', async fixture => {
    const content = await readFile(join(__dirname, 'fixtures', fixture), 'utf8');
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = content.trim().split('\n').flatMap(entry => mapper.mapLine(entry));
    events.push(...mapper.settleTerminalCandidate());
    expect(events[0].type).toBe('started');
    expect(events.some(event => event.type === 'chunk' && event.event.chunk.type === 'text')).toBe(true);
    expect(events.some(event => event.type === 'chunk' && event.event.chunk.type === 'tool_use')).toBe(true);
    expect(events.at(-1)?.type).toBe('finished');
  });

  it('aggregates the redacted production thinking/text rows and keeps non-contiguous reused ids separate', async () => {
    const content = await readFile(join(__dirname, 'fixtures', 'production-auto-turn-sequence.jsonl'), 'utf8');
    const rows = content.trim().split('\n').map(entry => JSON.parse(entry) as SDKNativeMessage);
    expect(rows.filter(row => row.type === 'queue-operation')).toHaveLength(6);
    expect(rows.filter(row => row.type === 'attachment')).toHaveLength(1);
    expect(rows.filter(row => row.type === 'mode')).toHaveLength(1);
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = rows.flatMap(entry => mapper.map(entry));
    events.push(...mapper.settleTerminalCandidate());

    const turns = ['peer-a', 'notification-a', 'peer-b', 'notification-b'];
    expect(events.filter(event => event.type === 'started').map(event => event.event.turnId)).toEqual(turns);
    expect(events.filter(event => event.type === 'finished').map(event => event.event.turnId)).toEqual(turns);
    for (const turnId of turns) {
      expect(events.filter(event => event.type === 'finished' && event.event.turnId === turnId)).toHaveLength(1);
    }
    const textContents = events.flatMap(event => (
      event.type === 'chunk' && event.event.chunk.type === 'text' ? [event.event.chunk.content] : []
    ));
    expect(textContents).toEqual([
      'answer A', 'notification answer A', 'answer B', 'notification answer B',
    ]);
    expect(mapper.hasOpenTurn()).toBe(false);
  });

  it('keeps a stop-hook-block continuation in the same turn across real companion rows', async () => {
    const content = await readFile(join(__dirname, 'fixtures', 'stop-hook-continuation.jsonl'), 'utf8');
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = content.trim().split('\n').flatMap(entry => mapper.mapLine(entry));

    expect(events.filter(event => event.type === 'chunk').map(event => event.event.chunk.type)).toEqual([
      'text', 'tool_use', 'tool_result', 'text',
    ]);
    expect(events.some(event => (
      event.type === 'chunk'
      && event.event.chunk.type === 'tool_use'
      && event.event.chunk.name === 'TaskOutput'
    ))).toBe(true);
    expect(events.some(event => (
      event.type === 'chunk'
      && event.event.chunk.type === 'text'
      && event.event.chunk.content === 'continued final'
    ))).toBe(true);
    expect(events.filter(event => event.type === 'finished')).toHaveLength(0);
    expect(mapper.hasOpenTurn()).toBe(true);
    expect(mapper.hasTerminalCandidate()).toBe(true);

    events.push(...mapper.settleTerminalCandidate());
    expect(events.filter(event => event.type === 'finished')).toHaveLength(1);
    expect(mapper.hasOpenTurn()).toBe(false);
  });

  it('carries the terminal transcript offset into the finished event', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    mapper.map(peer, false, { hostUserTurnActive: false, lineOffset: 10 });
    mapper.map(
      { type: 'assistant', uuid: 'terminal', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } },
      false,
      { hostUserTurnActive: false, lineOffset: 42 },
    );

    expect(mapper.settleTerminalCandidate()).toEqual([
      expect.objectContaining({
        type: 'finished',
        event: expect.objectContaining({ terminalOffset: 42 }),
      }),
    ]);
  });

  it('settles a text-only single-row terminal exactly once', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = [
      ...mapper.map(peer),
      ...mapper.map({ type: 'assistant', uuid: 'text-only', message: { id: 'text-only-id', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }),
      ...mapper.settleTerminalCandidate(),
      ...mapper.settleTerminalCandidate(),
    ];
    expect(events.filter(event => event.type === 'finished')).toHaveLength(1);
  });

  it('keeps multiple tool-use groups in one turn before the terminal candidate', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = [
      ...mapper.map(peer),
      ...mapper.map({ type: 'assistant', uuid: 'tool-row-1', message: { id: 'tool-message-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }], stop_reason: 'tool_use' } }),
      ...mapper.map({ type: 'user', uuid: 'result-row-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'one' }] } }),
      ...mapper.map({ type: 'assistant', uuid: 'tool-row-2', message: { id: 'tool-message-2', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: {} }], stop_reason: 'tool_use' } }),
      ...mapper.map({ type: 'user', uuid: 'result-row-2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'two' }] } }),
      ...mapper.map({ type: 'assistant', uuid: 'terminal-row', message: { id: 'terminal-message', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }),
      ...mapper.settleTerminalCandidate(),
    ];
    expect(events.filter(event => event.type === 'chunk').map(event => event.event.chunk.type)).toEqual([
      'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text',
    ]);
    expect(events.filter(event => event.type === 'finished')).toHaveLength(1);
  });

  it('quiet-settles only an end_turn candidate, never an ordinary idle turn', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    mapper.map(peer);
    expect(mapper.settleTerminalCandidate()).toEqual([]);
    mapper.map({ type: 'assistant', uuid: 'terminal', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
    expect(mapper.settleTerminalCandidate()).toEqual([
      expect.objectContaining({ type: 'finished', event: expect.objectContaining({ turnId: 'peer-user-1' }) }),
    ]);
  });

  it('finishes a terminal candidate or interrupts a protocol gap before starting the next external user', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    const next = { ...peer, uuid: 'peer-user-2', origin: { ...peer.origin, msg_id: 'peer-2' } };
    mapper.map(peer);
    mapper.map({ type: 'assistant', uuid: 'terminal', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
    expect(mapper.map(next).map(event => event.type)).toEqual(['finished', 'started']);

    const gapMapper = new ClaudeTranscriptTurnMapper();
    gapMapper.map(peer);
    expect(gapMapper.map(next).map(event => event.type)).toEqual(['interrupted', 'started']);
  });

  it('classifies and sanitizes real peer origin without transport metadata', () => {
    expect(classifyLeaselessTurnStart(peer)).toEqual({
      turnId: 'peer-user-1',
      source: { kind: 'peer', label: 'worker' },
      displayContent: 'inspect report',
      showUser: true,
    });
    expect(extractExternalDisplayContent({
      ...peer,
      origin: { kind: 'peer', body: 'Another Claude session sent a message:\n<cross-session-message from="socket">\nhello\n</cross-session-message>' },
    })).toBe('hello');
  });

  it('uses transcript alone for block chunks and completes on end_turn without result', () => {
    const mapper = new ClaudeTranscriptTurnMapper(7);
    const events = [
      ...mapper.mapLine(line(peer)),
      ...mapper.mapLine(line({ type: 'assistant', uuid: 'a1', isSidechain: false, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'working' }], stop_reason: 'tool_use', usage: { input_tokens: 3 } } })),
      ...mapper.mapLine(line({ type: 'assistant', uuid: 'a2', isSidechain: false, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }], stop_reason: 'tool_use' } })),
      ...mapper.mapLine(line({ type: 'user', uuid: 'u2', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }] } })),
      ...mapper.mapLine(line({ type: 'assistant', uuid: 'a3', isSidechain: false, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } })),
      ...mapper.settleTerminalCandidate(),
    ];
    expect(events.filter(event => event.type === 'chunk').map(event => event.event.chunk.type)).toEqual([
      'text', 'usage', 'tool_use', 'tool_result', 'text',
    ]);
    expect(events.at(-1)?.type).toBe('finished');
    expect(mapper.hasOpenTurn()).toBe(false);
  });

  it('emits only an embedded bubble while a host user turn is active', () => {
    const mapper = new ClaudeTranscriptTurnMapper(4);
    const events = mapper.map(peer, false, { hostUserTurnActive: true });
    expect(events).toEqual([{
      type: 'embedded',
      event: expect.objectContaining({
        turnId: 'peer-user-1',
        generation: 4,
        displayContent: 'inspect report',
        transcriptUserId: 'peer-user-1',
      }),
    }]);
    expect(mapper.hasOpenTurn()).toBe(false);
    expect(mapper.map({ type: 'assistant', uuid: 'host-a', message: { role: 'assistant', content: 'host', stop_reason: 'end_turn' } })).toEqual([]);
  });

  it('does not report completion after a crash without end_turn', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = [
      ...mapper.mapLine(line(peer)),
      ...mapper.mapLine(line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } })),
    ];
    expect(events.some(event => event.type === 'finished')).toBe(false);
    expect(mapper.hasOpenTurn()).toBe(true);
  });

  it('fails closed for ordinary, replay, sidechain, pure notification, and missing identity users', () => {
    expect(classifyLeaselessTurnStart({ type: 'user', uuid: 'u', message: { role: 'user', content: 'human' } })).toBeNull();
    expect(classifyLeaselessTurnStart({ ...peer, isReplay: true })).toBeNull();
    expect(classifyLeaselessTurnStart({ ...peer, isSidechain: true })).toBeNull();
    expect(classifyLeaselessTurnStart({ ...peer, shouldQuery: false })).toBeNull();
    expect(classifyLeaselessTurnStart({ ...peer, uuid: undefined })).toBeNull();
  });

  it('deduplicates repeated uuid and tool identity', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    mapper.map(peer);
    const assistant = { type: 'assistant' as const, uuid: 'same', message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use' as const, id: 'tool', name: 'Read', input: {} }], stop_reason: 'tool_use' } };
    expect(mapper.map(assistant).filter(event => event.type === 'chunk')).toHaveLength(1);
    expect(mapper.map(assistant).filter(event => event.type === 'chunk')).toHaveLength(0);
  });
});
