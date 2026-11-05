import { readFile } from 'fs/promises';
import { join } from 'path';

import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';
import { adaptTranscriptFacts, type TranscriptTurnEvent } from '@/providers/claude/transcript/ClaudeTranscriptFactAdapter';
import {
  classifyLeaselessTurnStart,
  ClaudeTranscriptTurnMapper,
  extractExternalDisplayContent,
  type TranscriptMapContext,
  type TranscriptTurnFact,
} from '@/providers/claude/transcript/ClaudeTranscriptTurnMapper';

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

/** Legacy-shape view over mapper facts: what the observer consumed before batch 1. */
function mapEvents(
  mapper: ClaudeTranscriptTurnMapper,
  message: SDKNativeMessage,
  replay = false,
  context?: TranscriptMapContext,
): TranscriptTurnEvent[] {
  const effectiveContext = context ?? { hostUserTurnActive: false };
  return adaptTranscriptFacts(mapper.map(message, replay, effectiveContext), {
    hostUserTurnActive: effectiveContext.hostUserTurnActive,
  });
}

function mapLineEvents(
  mapper: ClaudeTranscriptTurnMapper,
  rawLine: string,
  replay = false,
  context?: TranscriptMapContext,
): TranscriptTurnEvent[] {
  const effectiveContext = context ?? { hostUserTurnActive: false };
  return adaptTranscriptFacts(mapper.mapLine(rawLine, replay, effectiveContext), {
    hostUserTurnActive: effectiveContext.hostUserTurnActive,
  });
}

function settleEvents(mapper: ClaudeTranscriptTurnMapper, replay = false): TranscriptTurnEvent[] {
  return adaptTranscriptFacts(mapper.settleTerminalCandidate(replay), { hostUserTurnActive: false });
}

describe('ClaudeTranscriptTurnMapper', () => {
  it('keeps the redacted production mid-turn peer separate from host assistant output', async () => {
    const content = await readFile(join(__dirname, 'fixtures', 'mid-turn-peer.jsonl'), 'utf8');
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = content.trim().split('\n').flatMap(entry => (
      mapLineEvents(mapper, entry, false, { hostUserTurnActive: true })
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
    const events = content.trim().split('\n').flatMap(entry => mapLineEvents(mapper, entry));
    events.push(...settleEvents(mapper));
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
    const events = rows.flatMap(entry => mapEvents(mapper, entry));
    events.push(...settleEvents(mapper));

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
    const events = content.trim().split('\n').flatMap(entry => mapLineEvents(mapper, entry));

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

    events.push(...settleEvents(mapper));
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

    expect(settleEvents(mapper)).toEqual([
      expect.objectContaining({
        type: 'finished',
        event: expect.objectContaining({ terminalOffset: 42 }),
      }),
    ]);
  });

  it('settles a text-only single-row terminal exactly once', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = [
      ...mapEvents(mapper, peer),
      ...mapEvents(mapper, { type: 'assistant', uuid: 'text-only', message: { id: 'text-only-id', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }),
      ...settleEvents(mapper),
      ...settleEvents(mapper),
    ];
    expect(events.filter(event => event.type === 'finished')).toHaveLength(1);
  });

  it('keeps multiple tool-use groups in one turn before the terminal candidate', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = [
      ...mapEvents(mapper, peer),
      ...mapEvents(mapper, { type: 'assistant', uuid: 'tool-row-1', message: { id: 'tool-message-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }], stop_reason: 'tool_use' } }),
      ...mapEvents(mapper, { type: 'user', uuid: 'result-row-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'one' }] } }),
      ...mapEvents(mapper, { type: 'assistant', uuid: 'tool-row-2', message: { id: 'tool-message-2', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: {} }], stop_reason: 'tool_use' } }),
      ...mapEvents(mapper, { type: 'user', uuid: 'result-row-2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'two' }] } }),
      ...mapEvents(mapper, { type: 'assistant', uuid: 'terminal-row', message: { id: 'terminal-message', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }),
      ...settleEvents(mapper),
    ];
    expect(events.filter(event => event.type === 'chunk').map(event => event.event.chunk.type)).toEqual([
      'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text',
    ]);
    expect(events.filter(event => event.type === 'finished')).toHaveLength(1);
  });

  it('quiet-settles only an end_turn candidate, never an ordinary idle turn', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    mapper.map(peer);
    expect(settleEvents(mapper)).toEqual([]);
    mapper.map({ type: 'assistant', uuid: 'terminal', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
    expect(settleEvents(mapper)).toEqual([
      expect.objectContaining({ type: 'finished', event: expect.objectContaining({ turnId: 'peer-user-1' }) }),
    ]);
  });

  it('finishes a terminal candidate or interrupts a protocol gap before starting the next external user', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    const next = { ...peer, uuid: 'peer-user-2', origin: { ...peer.origin, msg_id: 'peer-2' } };
    mapper.map(peer);
    mapper.map({ type: 'assistant', uuid: 'terminal', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
    expect(mapEvents(mapper, next).map(event => event.type)).toEqual(['finished', 'started']);

    const gapMapper = new ClaudeTranscriptTurnMapper();
    gapMapper.map(peer);
    expect(mapEvents(gapMapper, next).map(event => event.type)).toEqual(['interrupted', 'started']);
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
      ...mapLineEvents(mapper, line(peer)),
      ...mapLineEvents(mapper, line({ type: 'assistant', uuid: 'a1', isSidechain: false, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'working' }], stop_reason: 'tool_use', usage: { input_tokens: 3 } } })),
      ...mapLineEvents(mapper, line({ type: 'assistant', uuid: 'a2', isSidechain: false, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }], stop_reason: 'tool_use' } })),
      ...mapLineEvents(mapper, line({ type: 'user', uuid: 'u2', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }] } })),
      ...mapLineEvents(mapper, line({ type: 'assistant', uuid: 'a3', isSidechain: false, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } })),
      ...settleEvents(mapper),
    ];
    expect(events.filter(event => event.type === 'chunk').map(event => event.event.chunk.type)).toEqual([
      'text', 'usage', 'tool_use', 'tool_result', 'text',
    ]);
    expect(events.at(-1)?.type).toBe('finished');
    expect(mapper.hasOpenTurn()).toBe(false);
  });

  it('emits only an embedded bubble while a host user turn is active', () => {
    const mapper = new ClaudeTranscriptTurnMapper(4);
    const events = mapEvents(mapper, peer, false, { hostUserTurnActive: true });
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
    expect(mapEvents(mapper, { type: 'assistant', uuid: 'host-a', message: { role: 'assistant', content: 'host', stop_reason: 'end_turn' } })).toEqual([]);
  });

  it('does not report completion after a crash without end_turn', () => {
    const mapper = new ClaudeTranscriptTurnMapper();
    const events = [
      ...mapLineEvents(mapper, line(peer)),
      ...mapLineEvents(mapper, line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } })),
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
    expect(mapEvents(mapper, assistant).filter(event => event.type === 'chunk')).toHaveLength(1);
    expect(mapEvents(mapper, assistant).filter(event => event.type === 'chunk')).toHaveLength(0);
  });

  // ============================================
  // Transcript facts (turn identity, batch 1 §3.1)
  // ============================================
  describe('transcript facts', () => {
    it('emits observed_start for a host-dispatched user row without opening a turn', () => {
      const mapper = new ClaudeTranscriptTurnMapper(3);
      const facts = mapper.map(
        { type: 'user', uuid: 'host-uuid-1', message: { role: 'user', content: 'host prompt' } },
        false,
        { hostUserTurnActive: false, lineOffset: 77 },
      );
      expect(facts).toEqual([{
        type: 'observed_start',
        identity: { canonicalTurnId: 'host-uuid-1', transcriptUserId: 'host-uuid-1', generation: 3 },
        showUser: false,
        lineOffset: 77,
        replay: false,
      }]);
      expect(mapper.hasOpenTurn()).toBe(false);
    });

    it('keeps emitting the host-row start fact while an external turn stays open', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(peer);
      const facts = mapper.map(
        { type: 'user', uuid: 'host-uuid-2', message: { role: 'user', content: 'follow-up' } },
        false,
        { hostUserTurnActive: false, lineOffset: 90 },
      );
      expect(facts.filter(fact => fact.type === 'observed_start' && fact.identity.canonicalTurnId === 'host-uuid-2')).toHaveLength(1);
      expect(mapper.hasOpenTurn()).toBe(true);
    });

    it('does not emit start facts for tool-result rows, meta rows, or replay rows', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      const toolResultRow = mapper.map({ type: 'user', uuid: 'tr-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
      const metaRow = mapper.map({ type: 'user', uuid: 'meta-1', isMeta: true, userType: 'external', message: { role: 'user', content: 'Stop hook feedback: block' } });
      const replayRow = mapper.map({ type: 'user', uuid: 'rep-1', isReplay: true, message: { role: 'user', content: 'replayed' } });
      expect(toolResultRow).toEqual([]);
      expect(metaRow).toEqual([]);
      expect(replayRow).toEqual([]);
    });

    it('records terminal evidence level on observed_terminal facts', () => {
      const quietMapper = new ClaudeTranscriptTurnMapper();
      quietMapper.map(peer);
      quietMapper.map({ type: 'assistant', uuid: 't1', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
      expect(quietMapper.settleTerminalCandidate()[0]).toEqual(expect.objectContaining({ type: 'observed_terminal', terminalKind: 'end_turn_quiet' }));

      const nextUserMapper = new ClaudeTranscriptTurnMapper();
      nextUserMapper.map(peer);
      nextUserMapper.map({ type: 'assistant', uuid: 't2', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
      const next = { ...peer, uuid: 'peer-user-9' };
      const nextUserFacts = nextUserMapper.map(next);
      expect(nextUserFacts[0]).toEqual(expect.objectContaining({ type: 'observed_terminal', terminalKind: 'next_user' }));

      const nextAssistantMapper = new ClaudeTranscriptTurnMapper();
      nextAssistantMapper.map(peer);
      nextAssistantMapper.map({ type: 'assistant', uuid: 't3', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
      const nextAssistantFacts = nextAssistantMapper.map({ type: 'assistant', uuid: 'a9', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'more' }], stop_reason: 'tool_use' } });
      expect(nextAssistantFacts[0]).toEqual(expect.objectContaining({ type: 'observed_terminal', terminalKind: 'next_assistant' }));
    });

    it('carries protocol-gap interruptions as observed_interrupted with the legacy next generation', () => {
      const mapper = new ClaudeTranscriptTurnMapper(5);
      mapper.map(peer);
      const next = { ...peer, uuid: 'peer-user-3' };
      const facts = mapper.map(next);
      expect(facts[0]).toEqual({
        type: 'observed_interrupted',
        identity: { canonicalTurnId: 'peer-user-1', transcriptUserId: 'peer-user-1', generation: 5 },
        reason: 'protocol_gap',
        nextGeneration: 6,
        replay: false,
      });
    });

    it('drops host-row start facts in the legacy adapter while external starts still project', () => {
      const hostFacts: TranscriptTurnFact[] = [{
        type: 'observed_start',
        identity: { canonicalTurnId: 'host-uuid-1', transcriptUserId: 'host-uuid-1', generation: 1 },
        showUser: false,
        replay: false,
      }];
      expect(adaptTranscriptFacts(hostFacts, { hostUserTurnActive: false })).toEqual([]);

      const externalFacts: TranscriptTurnFact[] = [{
        type: 'observed_start',
        identity: { canonicalTurnId: 'peer-uuid-1', transcriptUserId: 'peer-uuid-1', generation: 1 },
        source: { kind: 'peer' },
        showUser: true,
        displayContent: 'hi',
        replay: false,
      }];
      expect(adaptTranscriptFacts(externalFacts, { hostUserTurnActive: false })[0]?.type).toBe('started');
      expect(adaptTranscriptFacts(externalFacts, { hostUserTurnActive: true })[0]?.type).toBe('embedded');
    });
  });

  describe('host user turn terminal evidence (P0-1 result-late watchdog)', () => {
    const hostContext: TranscriptMapContext = { hostUserTurnActive: true };

    function hostUserRow(): SDKNativeMessage {
      return { type: 'user', uuid: 'host-uuid-1', isSidechain: false, message: { role: 'user', content: 'hello' } };
    }

    function hostEndTurn(): SDKNativeMessage {
      return { type: 'assistant', uuid: 'host-a1', isSidechain: false, message: { id: 'host-m1', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } };
    }

    function stopHookSummary(): SDKNativeMessage {
      return { type: 'system', subtype: 'stop_hook_summary', isSidechain: false };
    }

    function stopHookFeedback(): SDKNativeMessage {
      return { type: 'user', isMeta: true, userType: 'external', isSidechain: false, message: { role: 'user', content: 'Stop hook feedback: Background subagent still running' } };
    }

    it('emits observed_host_terminal when end_turn is confirmed by stop_hook_summary', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(hostUserRow(), false, hostContext);
      const candidateFacts = mapper.map(hostEndTurn(), false, hostContext);
      expect(candidateFacts.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
      expect(mapper.hasTerminalCandidate()).toBe(true);

      const terminalFacts = mapper.map(stopHookSummary(), false, hostContext);
      expect(terminalFacts).toContainEqual(expect.objectContaining({ type: 'observed_host_terminal', replay: false }));
      expect(mapper.hasTerminalCandidate()).toBe(false);
    });

    it('retracts the candidate on stop-hook block feedback, so a later summary emits nothing', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(hostUserRow(), false, hostContext);
      mapper.map(hostEndTurn(), false, hostContext);
      mapper.map(stopHookFeedback(), false, hostContext);
      expect(mapper.hasTerminalCandidate()).toBe(false);

      const facts = mapper.map(stopHookSummary(), false, hostContext);
      expect(facts.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
    });

    it('quiet-settles a pending host candidate without stop_hook_summary (no Stop hooks configured)', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(hostUserRow(), false, hostContext);
      mapper.map(hostEndTurn(), false, hostContext);
      expect(mapper.hasTerminalCandidate()).toBe(true);

      const facts = mapper.settleTerminalCandidate();
      expect(facts).toContainEqual(expect.objectContaining({ type: 'observed_host_terminal', replay: false }));
      expect(mapper.hasTerminalCandidate()).toBe(false);
    });

    it('clears the candidate when a newer host user row starts the next turn', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(hostUserRow(), false, hostContext);
      mapper.map(hostEndTurn(), false, hostContext);
      const nextTurnFacts = mapper.map({ ...hostUserRow(), uuid: 'host-uuid-2' }, false, hostContext);
      expect(nextTurnFacts.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
      expect(mapper.hasTerminalCandidate()).toBe(false);
    });

    it('emits no host terminal fact without an active host user turn', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(hostUserRow(), false, { hostUserTurnActive: false });
      mapper.map(hostEndTurn(), false, { hostUserTurnActive: false });
      const facts = mapper.map(stopHookSummary(), false, { hostUserTurnActive: false });
      expect(facts.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
      expect(mapper.hasTerminalCandidate()).toBe(false);
    });

    it('never claims host terminal evidence for an open external turn rows', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      // Task-notification starts keep showUser:false, so they open a mapper
      // turn even while a host user turn is active.
      mapper.map({ type: 'user', uuid: 'notif-1', isSidechain: false, origin: { kind: 'task-notification' }, message: { role: 'user', content: 'task done' } }, false, hostContext);
      mapper.map(hostEndTurn(), false, hostContext);
      const facts = mapper.settleTerminalCandidate();
      expect(facts.some(fact => fact.type === 'observed_terminal')).toBe(true);
      expect(facts.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
    });

    it('never claims an embedded external turn terminal as host evidence', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(hostUserRow(), false, hostContext);
      // Embedded peer turn (showUser start diverted while the host is active).
      mapper.map({ ...peer, uuid: 'peer-embedded' }, false, hostContext);
      mapper.map(hostEndTurn(), false, hostContext);
      const embeddedSummary = mapper.map(stopHookSummary(), false, hostContext);
      expect(embeddedSummary.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
      expect(mapper.hasTerminalCandidate()).toBe(false);

      // Emission is back with the host: its own terminal still fires.
      const hostFacts = [...mapper.map(hostEndTurn(), false, hostContext), ...mapper.map(stopHookSummary(), false, hostContext)];
      expect(hostFacts).toContainEqual(expect.objectContaining({ type: 'observed_host_terminal', replay: false }));
    });

    it('the legacy adapter drops observed_host_terminal facts without events', () => {
      const facts: TranscriptTurnFact[] = [{ type: 'observed_host_terminal', replay: false }];
      expect(adaptTranscriptFacts(facts, { hostUserTurnActive: true })).toEqual([]);
    });

    it('clearHostTerminalCandidate retires an unconfirmed candidate so a later summary stays silent (reviewer #1)', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(hostUserRow(), false, hostContext);
      mapper.map(hostEndTurn(), false, hostContext);
      expect(mapper.hasTerminalCandidate()).toBe(true);

      // The host turn switch (fresh dispatch) retires the residue.
      mapper.clearHostTerminalCandidate();
      expect(mapper.hasTerminalCandidate()).toBe(false);

      const summaryFacts = mapper.map(stopHookSummary(), false, hostContext);
      const quietFacts = mapper.settleTerminalCandidate();
      expect(summaryFacts.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
      expect(quietFacts.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
    });

    it('quiet-settled host terminal facts carry the arming end_turn offset', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      mapper.map(hostUserRow(), false, { ...hostContext, lineOffset: 0 });
      mapper.map(hostEndTurn(), false, { ...hostContext, lineOffset: 120 });

      const facts = mapper.settleTerminalCandidate();
      expect(facts).toContainEqual(expect.objectContaining({ type: 'observed_host_terminal', lineOffset: 120, replay: false }));
    });
  });

  describe('compact boundary terminal evidence (2026-11-04 d8912b5b: compact turns never write end_turn)', () => {
    const hostContext: TranscriptMapContext = { hostUserTurnActive: true };
    const boundaryTs = '2026-11-04T11:46:03.171Z';

    function compactBoundary(options?: { trigger?: string; timestamp?: string; version?: string }): SDKNativeMessage {
      return {
        type: 'system',
        subtype: 'compact_boundary',
        isSidechain: false,
        timestamp: options?.timestamp ?? boundaryTs,
        compactMetadata: { trigger: options?.trigger ?? 'manual', durationMs: 137011 },
        version: options?.version ?? '2.1.227',
      } as unknown as SDKNativeMessage;
    }

    it('emits the host terminal fact immediately for a manual boundary (arm+confirm in one row)', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      const facts = mapper.map(compactBoundary(), false, hostContext);
      expect(facts).toContainEqual(expect.objectContaining({
        type: 'observed_host_terminal',
        terminalSource: 'compact',
        rowTimestamp: Date.parse(boundaryTs),
        cliVersion: '2.1.227',
        replay: false,
      }));
      // Immediate emission: no candidate state survives (later continuation
      // rows cannot destroy the evidence the way they would a candidate).
      expect(mapper.hasTerminalCandidate()).toBe(false);
    });

    it('auto compact (mid-turn compaction, the turn keeps running) emits no fact', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      const facts = mapper.map(compactBoundary({ trigger: 'auto' }), false, hostContext);
      expect(facts.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
      expect(mapper.hasTerminalCandidate()).toBe(false);
    });

    it('a boundary with a missing or unparseable timestamp emits no fact (fail-safe: degrade to current behavior)', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      expect(mapper.map(compactBoundary({ timestamp: 'not-a-timestamp' }), false, hostContext))
        .toEqual([]);
      const missing = compactBoundary() as unknown as Record<string, unknown>;
      delete missing.timestamp;
      expect(mapper.map(missing as unknown as SDKNativeMessage, false, hostContext))
        .toEqual([]);
    });

    it('emits nothing without a live host turn, while an external turn is open, or behind an embedded external emission', () => {
      const noHost = new ClaudeTranscriptTurnMapper();
      expect(noHost.map(compactBoundary(), false, { hostUserTurnActive: false }).some(fact => fact.type === 'observed_host_terminal'))
        .toBe(false);

      const openExternal = new ClaudeTranscriptTurnMapper();
      openExternal.map({ type: 'user', uuid: 'notif-open', isSidechain: false, origin: { kind: 'task-notification' }, message: { role: 'user', content: 'task' } }, false, hostContext);
      expect(openExternal.map(compactBoundary(), false, hostContext).some(fact => fact.type === 'observed_host_terminal'))
        .toBe(false);

      const embedded = new ClaudeTranscriptTurnMapper();
      embedded.map({ ...peer, uuid: 'peer-embedded-compact' }, false, hostContext);
      expect(embedded.map(compactBoundary(), false, hostContext).some(fact => fact.type === 'observed_host_terminal'))
        .toBe(false);
    });

    it('the buffered /compact host row landing after the boundary cannot retroactively retract the emitted fact', () => {
      const mapper = new ClaudeTranscriptTurnMapper();
      const facts = mapper.map(compactBoundary(), false, hostContext);
      expect(facts).toHaveLength(1);

      // The CLI buffers the /compact command line and flushes it after
      // compaction completes: the host-row reset branch runs after emission.
      const later = mapper.map({ type: 'user', uuid: 'compact-cmd-row', isSidechain: false, message: { role: 'user', content: '/compact' } }, false, hostContext);
      expect(later.some(fact => fact.type === 'observed_host_terminal')).toBe(false);
      expect(facts).toHaveLength(1);
    });
  });
});
