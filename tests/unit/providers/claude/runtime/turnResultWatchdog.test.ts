import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { Notice } from 'obsidian';
import { tmpdir } from 'os';
import { join } from 'path';

import type { McpServerManager } from '@/core/mcp/McpServerManager';
import type ClaudianPlugin from '@/main';
import * as sdkSessionPaths from '@/providers/claude/history/sdkSessionPaths';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { MessageChannel } from '@/providers/claude/runtime/ClaudeMessageChannel';
import { ClaudeTranscriptDiagnosticLog } from '@/providers/claude/transcript/ClaudeTranscriptDiagnosticLog';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  resetMockMessages: () => void;
  query: typeof sdkModule.query;
  getQueryCallCount: () => number;
  getLastResponse: () => (AsyncGenerator<any> & { interrupt: jest.Mock; stopTask: jest.Mock; close: jest.Mock; pushLateMessage: (message: any) => void; pushStdoutMessage: (message: any) => void }) | null;
};

const RESULT_WATCHDOG_MS = 120_000;
const RESULT_WATCHDOG_GRACE_MS = 15_000;
const STOP_TASK_GRACE_MS = 15_000;
const STOP_TASK_TURN_SILENCE_MS = 30 * 60_000;
const STOP_TASK_AGENT_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const realSetImmediate = setImmediate;

function makeMockPlugin(): ClaudianPlugin {
  const storageMock = {
    addDenyRule: jest.fn().mockResolvedValue(undefined),
    addAllowRule: jest.fn().mockResolvedValue(undefined),
    getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
  };
  return {
    app: {
      vault: { adapter: { basePath: '/mock/vault/path' } },
    },
    storage: storageMock,
    settings: {
      model: 'claude-3-5-sonnet',
      permissionMode: 'ask' as const,
      thinkingBudget: 0,
      mediaFolder: 'claudian-media',
      systemPrompt: '',
      loadUserClaudeSettings: false,
      claudeCliPath: '/usr/local/bin/claude',
      claudeCliPaths: [],
      enableAutoTitleGeneration: true,
      titleGenerationModel: 'claude-3-5-haiku',
    },
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/claude'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    pluginManager: {
      getPluginsKey: jest.fn().mockReturnValue(''),
    },
  } as unknown as ClaudianPlugin;
}

function makeService(): ClaudianService {
  const mcpManager = {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getActiveServers: jest.fn().mockReturnValue({}),
    getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    extractMentions: jest.fn().mockReturnValue(new Set<string>()),
    transformMentions: jest.fn().mockImplementation((text: string) => text),
  } as unknown as McpServerManager;
  return new ClaudianService(makeMockPlugin(), mcpManager);
}

/**
 * REALITY GATE (2026-11-05 spec §4): start via the production
 * startPersistentQuery — single-flight gate, real MessageChannel, real
 * query-scope, real response consumer. Only the SDK transport (agentQuery)
 * and the process-exit event injection stay mocked.
 */
async function startPersistentQuery(service: ClaudianService): Promise<MessageChannel> {
  await service.ensureReady();
  // Process-event simulation: Query.close() terminates the CLI subprocess,
  // so the spawn exit notification fires (the retirement rebuild waits on it).
  const scope = (service as any).currentQueryScope;
  const gen = (service as any).persistentQuery;
  if (scope && gen) {
    gen.close.mockImplementation(() => {
      (service as any).notifyQueryProcessExit(scope.epoch);
    });
  }
  return (service as any).messageChannel as MessageChannel;
}

/** The 2026-10-31 stall shape: end_turn + stop_hook_summary on the transcript
 * while the SDK stream stays silent (no result message ever yielded). The
 * host user row must land first — terminal attribution anchors on it
 * (reviewer #1). */
function hostUserRowLine(uuid: string): string {
  return JSON.stringify({ type: 'user', uuid, isSidechain: false, message: { role: 'user', content: 'hello' } }) + '\n';
}

function hostTerminalRows(): string {
  return [
    JSON.stringify({ type: 'assistant', uuid: 'host-a1', isSidechain: false, message: { id: 'host-m1', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }),
    JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', version: '2.1.227' }),
  ].join('\n') + '\n';
}

async function readDiagnosticPhases(diagDir: string): Promise<Array<Record<string, unknown>>> {
  const file = join(diagDir, '.claudian', 'diagnostics', 'transcript-tail.current.jsonl');
  try {
    const content = await readFile(file, 'utf8');
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('ClaudianService - P0-1 result-late watchdog', () => {
  let dir: string;
  let transcriptFile: string;
  let diagDir: string;
  let service: ClaudianService;
  let fixtureActive: boolean;
  let releaseOwnedTasks: Array<() => void>;
  let replacedChannels: MessageChannel[];
  let ownedConsumers: Promise<void>[];

  beforeEach(async () => {
    fixtureActive = true;
    releaseOwnedTasks = [];
    replacedChannels = [];
    ownedConsumers = [];
    jest.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'claudian-watchdog-'));
    transcriptFile = join(dir, 'session.jsonl');
    diagDir = join(dir, 'diag-vault');
    await writeFile(transcriptFile, '');
    sdkMock.resetMockMessages();
    jest.clearAllMocks();
    service = makeService();
    // Inject the diagnostic log before the observer restart so `??=` keeps it
    // and all settlement diagnostics land in the temp vault.
    (service as any).transcriptDiagnosticLog = new ClaudeTranscriptDiagnosticLog(diagDir);
    // Observer start (restartTranscriptObserver) requires the auto-turn trio.
    service.setOnAutoTurnStarted(() => true);
    service.setOnAutoTurnChunk(async () => {});
    service.setOnAutoTurnFinished(async () => {});
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(transcriptFile);
  });

  afterEach(async () => {
    fixtureActive = false;
    const runtime = service as any;
    const observer = runtime.transcriptObserver;
    const reader = observer?.reader;
    const retirement = runtime.queryRetirementChain as Promise<void> | null;
    const startup = runtime.persistentQueryStart as Promise<void> | null;
    retainReplacedQuery(service);
    try {
      for (const release of releaseOwnedTasks) release();
      service.cleanup();
      for (const channel of replacedChannels) channel.close();
      if (retirement) await jest.advanceTimersByTimeAsync(15_000);
      await Promise.allSettled([retirement, startup].filter((task): task is Promise<void> => task !== null));
      retainReplacedQuery(service);
      const lateObserver = runtime.transcriptObserver;
      const lateReader = lateObserver?.reader;
      service.cleanup();
      for (const channel of replacedChannels) channel.close();
      await runtime.transcriptObserverRestartChain;
      await Promise.all([reader?.ioChain, observer?.consumeChain, lateReader?.ioChain, lateObserver?.consumeChain]);
      await jest.runAllTimersAsync();
      await Promise.allSettled(ownedConsumers);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
      sdkMock.resetMockMessages();
      await rm(dir, { recursive: true, force: true });
    }
  });

  function retainReplacedQuery(target: ClaudianService): void {
    const channel = (target as any).messageChannel as MessageChannel | null;
    const consumer = (target as any).responseConsumerPromise as Promise<void> | null;
    if (channel) replacedChannels.push(channel);
    if (consumer) ownedConsumers.push(consumer);
  }

  async function awaitObserverStart(target: ClaudianService = service): Promise<any> {
    await (target as any).transcriptObserverRestartChain;
    const observer = (target as any).transcriptObserver;
    expect(observer?.reader).toBeTruthy();
    expect(observer.stopped).toBe(false);
    expect(observer.reader.stopped).toBe(false);
    return observer;
  }

  async function awaitScheduledPoll(target: ClaudianService, observer: any): Promise<{ callAt: number }> {
    const reader = observer.reader;
    const clock = (setTimeout as unknown as { clock?: { timers?: Map<number, { callAt: number }> } }).clock;
    if (!clock?.timers) throw new Error('Fake timer state is unavailable');
    // The reader only schedules its next poll after real I/O and onBatch finish.
    while (fixtureActive && (target as any).transcriptObserver === observer && !reader.stopped
      && !clock.timers.has(Number(reader.timer))) {
      await new Promise<void>(resolve => { realSetImmediate(resolve); });
    }
    if (!fixtureActive || (target as any).transcriptObserver !== observer || reader.stopped) {
      throw new Error('Transcript observer stopped before its poll completed');
    }
    const timer = clock.timers.get(Number(reader.timer));
    if (!timer) throw new Error('Transcript poll timer is unavailable');
    return timer;
  }

  async function driveObserverTick(target: ClaudianService = service): Promise<void> {
    const observer = await awaitObserverStart(target);
    const reader = observer.reader;
    const targetOffset = (await stat(transcriptFile)).size;
    const timer = await awaitScheduledPoll(target, observer);
    if (reader.getOffset() < targetOffset) {
      await jest.advanceTimersByTimeAsync(Math.max(0, timer.callAt - Date.now()));
      await awaitScheduledPoll(target, observer);
    }
    expect(reader.getOffset()).toBe(targetOffset);
    await observer.consumeChain;
    const phases = await readDiagnosticPhases(diagDir);
    expect(phases.some(entry => entry.phase === 'tick_end' && entry.generation === observer.generation)).toBe(true);
    expect(phases.some(entry => entry.phase === 'callback_error')).toBe(false);
  }

  it('T1: transcript terminal + silent SDK stream force-settles, releases and pumps the queue', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
    ], { appendResult: false });
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-t1', text: 'hello' });
    const gen = service.query(turn);
    const first = await gen.next();
    expect(first.value).toEqual(expect.objectContaining({ type: 'text', content: 'model reply' }));

    // Host turn projection begins after the observer exists (restored-session flow).
    service.beginUserTurnProjection('turn-t1');
    await awaitObserverStart();

    // The dispatched message's user row lands on the transcript (the
    // generator registered it only if the observer already existed; the
    // observer is created asynchronously after session_init, so register
    // explicitly here). Terminal attribution anchors on this row.
    const t1Uuid = (service as any).lastSentMessage.uuid as string;
    (service as any).transcriptObserver.registerHostUserTranscriptId(t1Uuid);
    await appendFile(transcriptFile, hostUserRowLine(t1Uuid));
    await driveObserverTick();

    // The consumer keeps pulling (production: StreamController's for-await),
    // so the generator parks on the watchdog-raced chunk wait.
    let t1Settled = false;
    const t1SettledNext = gen.next().then(value => {
      t1Settled = true;
      return value;
    });
    await flushMicrotasks();

    // A second message queues behind the stuck lease (orphan queued message).
    const queuedTurn = service.prepareTurn({ turnId: 'turn-q1', text: 'queued hello' });
    const queuedGen = service.query(queuedTurn);
    let queuedResolved = false;
    const queuedNext = queuedGen.next().then(value => {
      queuedResolved = true;
      return value;
    });
    await flushMicrotasks();
    const channel = (service as any).messageChannel as MessageChannel;
    expect(channel.getQueueLength()).toBe(1);

    // Transcript records end_turn + stop_hook while the SDK stream stays silent.
    await appendFile(transcriptFile, hostTerminalRows());
    await driveObserverTick();
    const stuckTurn = (service as any).runtimeTurns.get('turn-t1');
    expect(stuckTurn.transcriptTerminalSeenAt).not.toBeNull();

    // The queued turn must settle with a real result once the queue pumps.
    sdkMock.setMockMessages([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'queued reply' }] } },
      { type: 'result', subtype: 'success', result: 'ok' },
    ], { appendResult: false });

    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
    const query = sdkMock.getLastResponse();
    expect(query?.interrupt).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
    await flushMicrotasks();

    // Settled, released, queue pumped: no orphan stays behind.
    expect(t1Settled).toBe(true);
    const t1Done = await t1SettledNext;
    expect(t1Done.value).toEqual({ type: 'done' });
    expect((service as any).runtimeTurns.has('turn-t1')).toBe(false);
    // The queue was extracted off the old channel and restored onto the
    // REBUILT one — the pump happens there (query_retire/query_rebuilt).
    expect(channel.getQueueLength()).toBe(0);
    const rebuiltChannel = (service as any).messageChannel as MessageChannel;
    expect(rebuiltChannel).not.toBe(channel);
    expect(rebuiltChannel.getQueueLength()).toBe(0);
    expect(rebuiltChannel.getActiveTurnId()).toBe('turn-q1');
    const queuedFirst = await queuedNext;
    expect(queuedResolved).toBe(true);
    expect(queuedFirst.value).toEqual(expect.objectContaining({ type: 'text', content: 'queued reply' }));
    // Production handshake (InputController finally) completes the barrier settle.
    await service.completeUserTurnProjection('turn-q1');
    const queuedDone = await queuedGen.next();
    expect(queuedDone.value).toEqual({ type: 'done' });

    const phases = await readDiagnosticPhases(diagDir);
    expect(phases.filter(entry => entry.phase === 'settle_watchdog_fire')).toHaveLength(1);
    expect(phases.find(entry => entry.phase === 'settle_watchdog_fire')).toMatchObject({ evidenceKind: 'stop_hook', cliVersion: '2.1.227' });
    // Only the queued turn settles via its real result; the stalled turn's
    // settlement came from the watchdog, never from a result message.
    expect(phases.filter(entry => entry.phase === 'settle_result')).toHaveLength(1);
  });

  it('T4: a long turn without transcript terminal evidence never triggers the watchdog', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    ], { appendResult: false });
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-t4', text: 'run a blocking TaskOutput' });
    const gen = service.query(turn);
    await gen.next();
    service.beginUserTurnProjection('turn-t4');
    await awaitObserverStart();
    let settled = false;
    void gen.next().then(() => { settled = true; });
    await flushMicrotasks();

    // No transcript terminal rows: a 10-minute blocking tool call.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await flushMicrotasks();

    expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
    expect((service as any).runtimeTurns.has('turn-t4')).toBe(true);
    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + RESULT_WATCHDOG_GRACE_MS);
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
    const phases = await readDiagnosticPhases(diagDir);
    expect(phases.some(entry => entry.phase === 'settle_watchdog_fire')).toBe(false);
  });

  it('T5b: terminal seen but result arriving within the window settles normally, watchdog stays silent', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
    ], { appendResult: false });
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-t5b', text: 'hello' });
    const gen = service.query(turn);
    const first = await gen.next();
    expect(first.value).toEqual(expect.objectContaining({ type: 'text' }));
    service.beginUserTurnProjection('turn-t5b');
    await awaitObserverStart();
    const t5bUuid = (service as any).lastSentMessage.uuid as string;
    (service as any).transcriptObserver.registerHostUserTranscriptId(t5bUuid);
    await appendFile(transcriptFile, hostUserRowLine(t5bUuid));
    await driveObserverTick();
    let settled = false;
    const settledNext = gen.next().then(value => {
      settled = true;
      return value;
    });
    await flushMicrotasks();

    await appendFile(transcriptFile, hostTerminalRows());
    await driveObserverTick();
    expect((service as any).runtimeTurns.get('turn-t5b').transcriptTerminalSeenAt).not.toBeNull();

    // The late-but-in-window result arrives through the message routing seam
    // (same seam the existing trailing-result regression tests use).
    const routed = (service as any).routeMessage({ type: 'result', subtype: 'success', result: 'ok' });
    await flushMicrotasks();
    expect(settled).toBe(true);
    const settledValue = await settledNext;
    expect(settledValue.value).toEqual({ type: 'done' });
    // Production handshake completes the barrier settlement.
    await service.completeUserTurnProjection('turn-t5b');
    await routed;
    expect((service as any).runtimeTurns.has('turn-t5b')).toBe(false);

    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + RESULT_WATCHDOG_GRACE_MS);
    await flushMicrotasks();
    expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
    const phases = await readDiagnosticPhases(diagDir);
    expect(phases.some(entry => entry.phase === 'settle_watchdog_fire')).toBe(false);
    expect(phases.some(entry => entry.phase === 'settle_result')).toBe(true);
  });

  it('T5: a result arriving after the watchdog settlement is dropped lease-less', async () => {
    const startedAutoTurns: string[] = [];
    service.setOnAutoTurnStarted(event => {
      startedAutoTurns.push(event.turnId);
      return true;
    });
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
    ], { appendResult: false });
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-t5', text: 'hello' });
    const gen = service.query(turn);
    await gen.next();
    service.beginUserTurnProjection('turn-t5');
    await awaitObserverStart();
    const t5Uuid = (service as any).lastSentMessage.uuid as string;
    (service as any).transcriptObserver.registerHostUserTranscriptId(t5Uuid);
    await appendFile(transcriptFile, hostUserRowLine(t5Uuid));
    await driveObserverTick();
    let settled = false;
    const settledNext = gen.next().then(value => {
      settled = true;
      return value;
    });
    await flushMicrotasks();

    await appendFile(transcriptFile, hostTerminalRows());
    await driveObserverTick();
    expect((service as any).runtimeTurns.get('turn-t5').transcriptTerminalSeenAt).not.toBeNull();

    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
    await flushMicrotasks();
    expect(settled).toBe(true);
    const settledValue = await settledNext;
    expect(settledValue.value).toEqual({ type: 'done' });
    expect((service as any).runtimeTurns.size).toBe(0);

    // The CLI finally yields its result long after the force settlement: no
    // lease exists, so it is dropped without creating a ghost auto turn.
    await (service as any).routeMessage({ type: 'result', subtype: 'success', result: 'late' });
    await flushMicrotasks();
    expect(startedAutoTurns).toHaveLength(0);
    expect((service as any).runtimeTurns.size).toBe(0);
    expect(((service as any).messageChannel as MessageChannel).getActiveTurnId()).toBeNull();
  });

  it('records settle_result when the SDK result message settles the turn', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'normal reply' }] } },
      { type: 'result', subtype: 'success', result: 'ok' },
    ]);
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-normal', text: 'hello' });
    const chunks: any[] = [];
    for await (const chunk of service.query(turn)) {
      chunks.push(chunk);
    }
    expect(chunks.at(-1)).toEqual({ type: 'done' });

    const phases = await readDiagnosticPhases(diagDir);
    expect(phases.some(entry => entry.phase === 'settle_result')).toBe(true);
    expect(phases.some(entry => entry.phase === 'settle_watchdog_fire')).toBe(false);
  });

  it('runPhase bypass: session_state_changed messages land as run_phase diagnostics', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'system', subtype: 'session_state_changed', state: 'running', uuid: 'ssc-1', session_id: 'watch-session' },
      { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: 'ssc-2', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
      { type: 'result', subtype: 'success', result: 'ok' },
    ]);
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-runphase', text: 'hello' });
    const chunks: any[] = [];
    for await (const chunk of service.query(turn)) {
      chunks.push(chunk);
    }
    expect(chunks.at(-1)).toEqual({ type: 'done' });

    const phases = await readDiagnosticPhases(diagDir);
    const runPhases = phases.filter(entry => entry.phase === 'run_phase');
    expect(runPhases.map(entry => entry.detail)).toEqual(['running', 'idle']);
    expect(runPhases.every(entry => typeof entry.ts === 'number')).toBe(true);
  });

  it("T7: the previous turn's terminal residue never arms the next turn's watchdog (reviewer #1 cross-turn residue)", async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
    ], { appendResult: false });
    await startPersistentQuery(service);

    // Turn A parks on the watchdog-raced chunk wait.
    const turnA = service.prepareTurn({ turnId: 'turn-t7a', text: 'hello' });
    const genA = service.query(turnA);
    await genA.next();
    service.beginUserTurnProjection('turn-t7a');
    await awaitObserverStart();
    const t7aUuid = (service as any).lastSentMessage.uuid as string;
    (service as any).transcriptObserver.registerHostUserTranscriptId(t7aUuid);
    await appendFile(transcriptFile, hostUserRowLine(t7aUuid));
    await driveObserverTick();
    void genA.next();
    await flushMicrotasks();

    // Turn A's end_turn lands but is not yet confirmed (candidate armed).
    await appendFile(transcriptFile, hostTerminalRows().split('\n')[0] + '\n');
    await driveObserverTick();
    expect((service as any).runtimeTurns.get('turn-t7a').transcriptTerminalSeenAt).toBeNull();

    // Turn A settles and releases; the queue pumps within milliseconds and
    // the freshly dispatched turn switches the hostUserTurnId BEFORE the
    // residue flushes. Turn B starts its own (blocking) wait.
    const turnB = service.prepareTurn({ turnId: 'turn-t7b', text: 'run a blocking TaskOutput' });
    const genB = service.query(turnB);
    void genB.next();
    await flushMicrotasks();
    service.beginUserTurnProjection('turn-t7b');
    const t7bUuid = (service as any).lastSentMessage.uuid as string;

    // The residue (stop_hook_summary A) physically precedes turn B's user row.
    await appendFile(transcriptFile, `${JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' })}\n${hostUserRowLine(t7bUuid)}`);
    await driveObserverTick();

    // Neither turn may carry terminal evidence: the residue belongs to the
    // already-replaced turn, and turn B has no terminal rows of its own.
    expect((service as any).runtimeTurns.get('turn-t7b').transcriptTerminalSeenAt).toBeNull();
    expect((service as any).runtimeTurns.get('turn-t7a').transcriptTerminalSeenAt).toBeNull();

    // Turn B blocks for a long while with no chunk and no terminal evidence:
    // the watchdog must never fire (the pre-fix bug fired at +120s).
    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
    expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
    await flushMicrotasks();
    expect((service as any).runtimeTurns.has('turn-t7b')).toBe(true);
    const phases = await readDiagnosticPhases(diagDir);
    expect(phases.some(entry => entry.phase === 'settle_watchdog_fire')).toBe(false);
  });

  it('T8: a stamp 60s into the wait fires at 180s total (remaining-window re-arm), not 240s (reviewer #2)', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
    ], { appendResult: false });
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-t8', text: 'hello' });
    const gen = service.query(turn);
    await gen.next();
    service.beginUserTurnProjection('turn-t8');
    await awaitObserverStart();
    const t8Uuid = (service as any).lastSentMessage.uuid as string;
    (service as any).transcriptObserver.registerHostUserTranscriptId(t8Uuid);
    await appendFile(transcriptFile, hostUserRowLine(t8Uuid));
    await driveObserverTick();
    let settled = false;
    const settledNext = gen.next().then(value => {
      settled = true;
      return value;
    });
    await flushMicrotasks();

    // The terminal stamps the turn 60s into the parked wait.
    await jest.advanceTimersByTimeAsync(60_000);
    await appendFile(transcriptFile, hostTerminalRows());
    await driveObserverTick();
    expect((service as any).runtimeTurns.get('turn-t8').transcriptTerminalSeenAt).not.toBeNull();

    // Wait start + 120s: only 60s since the stamp — must stay silent.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();

    // Wait start + 180s = stamp + 120s: the watchdog fires exactly now.
    await jest.advanceTimersByTimeAsync(60_000 - 1);
    expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(sdkMock.getLastResponse()?.interrupt).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
    await flushMicrotasks();
    expect(settled).toBe(true);
    const settledValue = await settledNext;
    expect(settledValue.value).toEqual({ type: 'done' });
    const phases = await readDiagnosticPhases(diagDir);
    expect(phases.filter(entry => entry.phase === 'settle_watchdog_fire')).toHaveLength(1);
  });

  it('T1c: manual compact boundary evidence arms the watchdog and force-settles the hung compact turn (d8912b5b row order)', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
    ], { appendResult: false });
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-t1c', text: '/compact' });
    const gen = service.query(turn);
    const first = await gen.next();
    expect(first.value).toEqual(expect.objectContaining({ type: 'text', content: 'model reply' }));

    service.beginUserTurnProjection('turn-t1c');
    await awaitObserverStart();
    const t1cUuid = (service as any).lastSentMessage.uuid as string;
    (service as any).transcriptObserver.registerHostUserTranscriptId(t1cUuid);

    let settled = false;
    const settledNext = gen.next().then(value => {
      settled = true;
      return value;
    });
    await flushMicrotasks();

    // A second message queues behind the hung lease (the d8912b5b user messages).
    const queuedTurn = service.prepareTurn({ turnId: 'turn-t1c-q', text: 'queued hello' });
    const queuedGen = service.query(queuedTurn);
    let queuedResolved = false;
    const queuedNext = queuedGen.next().then(value => {
      queuedResolved = true;
      return value;
    });
    await flushMicrotasks();

    // #1 measured compact-turn row order: the boundary flushes BEFORE the
    // buffered /compact host row (its UUID is known but the row is absent) —
    // attribution must work off the boundary timestamp alone.
    const boundaryTs = new Date(Date.now() + 137_000).toISOString();
    const compactRows = [
      JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', isSidechain: false }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: false, timestamp: boundaryTs, compactMetadata: { trigger: 'manual', durationMs: 137011, postTokens: 12340 }, version: '2.1.227' }),
      JSON.stringify({ type: 'user', uuid: 't1c-continuation', isSidechain: false, shouldQuery: false, message: { role: 'user', content: 'Conversation compacted' } }),
      JSON.stringify({ type: 'user', uuid: 't1c-caveat', isSidechain: false, isMeta: true, userType: 'external', message: { role: 'user', content: 'caveat' } }),
      JSON.stringify({ type: 'user', uuid: t1cUuid, isSidechain: false, message: { role: 'user', content: '/compact' } }),
      JSON.stringify({ type: 'user', uuid: 't1c-stdout', isSidechain: false, isMeta: true, message: { role: 'user', content: 'Compacted Tip: You have access to Opus 1M.' } }),
    ].join('\n') + '\n';
    await appendFile(transcriptFile, compactRows);
    await driveObserverTick();
    expect((service as any).runtimeTurns.get('turn-t1c').transcriptTerminalSeenAt).not.toBeNull();

    sdkMock.setMockMessages([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'queued reply' }] } },
      { type: 'result', subtype: 'success', result: 'ok' },
    ], { appendResult: false });

    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
    const query = sdkMock.getLastResponse();
    expect(query?.interrupt).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
    await flushMicrotasks();

    expect(settled).toBe(true);
    const settledValue = await settledNext;
    expect(settledValue.value).toEqual({ type: 'done' });
    expect((service as any).runtimeTurns.has('turn-t1c')).toBe(false);
    expect(((service as any).messageChannel as MessageChannel).getActiveTurnId()).toBe('turn-t1c-q');
    const queuedFirst = await queuedNext;
    expect(queuedResolved).toBe(true);
    expect(queuedFirst.value).toEqual(expect.objectContaining({ type: 'text', content: 'queued reply' }));
    await service.completeUserTurnProjection('turn-t1c-q');
    const queuedDone = await queuedGen.next();
    expect(queuedDone.value).toEqual({ type: 'done' });

    const phases = await readDiagnosticPhases(diagDir);
    const fire = phases.filter(entry => entry.phase === 'settle_watchdog_fire');
    expect(fire).toHaveLength(1);
    expect(fire[0].evidenceKind).toBe('compact');
    expect(fire[0].cliVersion).toBe('2.1.227');
    expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'result_watchdog')).toBe(true);
  });

  it('a compact command with zero SDK chunks recovers from the actual delayed boundary timestamp', async () => {
    service.setSessionId('watch-session');
    await (service as any).transcriptObserverRestartChain;
    sdkMock.setMockMessages([{ type: 'system', subtype: 'init', session_id: 'watch-session' }], { appendResult: false });
    await startPersistentQuery(service);
    service.beginUserTurnProjection('turn-compact-no-chunk');
    const gen = service.query(service.prepareTurn({ turnId: 'turn-compact-no-chunk', text: '/compact' }));
    const done = gen.next();
    await flushMicrotasks();
    const turn = (service as any).runtimeTurns.get('turn-compact-no-chunk');
    expect(turn.lastChunkAt).toBeNull();
    expect(turn.phase).toBe('collecting');

    await jest.advanceTimersByTimeAsync(137_000);
    await appendFile(transcriptFile, `${JSON.stringify({
      type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now()).toISOString(),
      compactMetadata: { trigger: 'manual', durationMs: 137000 }, version: '2.1.227',
    })}\n`);
    await driveObserverTick();
    expect(turn.transcriptTerminalSeenAt).not.toBeNull();
    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
    expect(sdkMock.getLastResponse()?.interrupt).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
    expect((await done).value).toEqual({ type: 'done' });
    expect((service as any).runtimeTurns.has('turn-compact-no-chunk')).toBe(false);
  });

  it('T4c: auto compact (mid-turn compaction, turn keeps running) never arms the watchdog', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'watch-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    ], { appendResult: false });
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'turn-t4c', text: 'long analysis' });
    const gen = service.query(turn);
    await gen.next();
    service.beginUserTurnProjection('turn-t4c');
    await awaitObserverStart();
    const t4cUuid = (service as any).lastSentMessage.uuid as string;
    (service as any).transcriptObserver.registerHostUserTranscriptId(t4cUuid);
    await appendFile(transcriptFile, hostUserRowLine(t4cUuid));
    await driveObserverTick();

    let settled = false;
    void gen.next().then(() => { settled = true; });
    await flushMicrotasks();

    // Auto compaction fires mid-turn; the boundary row is NOT terminal evidence.
    await appendFile(transcriptFile, JSON.stringify({
      type: 'system', subtype: 'compact_boundary', isSidechain: false,
      timestamp: new Date(Date.now() + 5_000).toISOString(),
      compactMetadata: { trigger: 'auto' }, version: '2.1.227',
    }) + '\n');
    await driveObserverTick();
    expect((service as any).runtimeTurns.get('turn-t4c').transcriptTerminalSeenAt).toBeNull();

    await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + RESULT_WATCHDOG_GRACE_MS);
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
    const phases = await readDiagnosticPhases(diagDir);
    expect(phases.some(entry => entry.phase === 'settle_watchdog_fire')).toBe(false);
  });

  async function armTerminalEvidence(target: ClaudianService, turnId: string): Promise<void> {
    target.beginUserTurnProjection(turnId);
    const observer = await awaitObserverStart(target);
    const uuid = (target as any).lastSentMessage.uuid as string;
    expect(observer.currentDispatch()).toEqual(expect.objectContaining({ leaseTurnId: turnId, canonicalUuid: uuid }));
    observer.registerHostUserTranscriptId(uuid);
    await appendFile(transcriptFile, hostUserRowLine(uuid) + hostTerminalRows());
    await driveObserverTick(target);
    expect(observer.hostUserRowObserved).toBe(true);
    expect((target as any).runtimeTurns.get(turnId).transcriptTerminalSeenAt).not.toBeNull();
  }

  describe('query boundary isolation (2026-11-05 fix 2: old results must never settle new-query turns)', () => {
    /** Installs a replacement query incarnation without the force-close side
     * effects (the terminal state after a retirement/rebuild: new channel,
     * new scope, old scope still holding its own state). */
    function installReplacementQuery(service: ClaudianService): MessageChannel {
      retainReplacedQuery(service);
      const messageChannel = new MessageChannel(() => {}, (info) => (service as any).handleTurnDequeued(info));
      (service as any).messageChannel = messageChannel;
      (service as any).persistentQuery = sdkMock.query({ prompt: messageChannel, options: {} as any });
      (service as any).startResponseConsumer();
      return messageChannel;
    }

    it('a result routed through an old scope never settles the turn leased by the new query', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turnA = service.prepareTurn({ turnId: 'turn-scope-a', text: 'hello' });
      const genA = service.query(turnA);
      await genA.next();
      const oldScope = (service as any).currentQueryScope;
      expect(oldScope).not.toBeNull();

      // New query incarnation replaces the slot; a fresh turn takes its lease.
      installReplacementQuery(service);
      const turnB = service.prepareTurn({ turnId: 'turn-scope-b', text: 'queued hello' });
      const genB = service.query(turnB);
      await genB.next();
      await flushMicrotasks();
      const channelB = (service as any).messageChannel as MessageChannel;
      expect(channelB.getActiveTurnId()).toBe('turn-scope-b');

      // The old consumer's late result arrives through the OLD scope.
      await (service as any).routeMessage({ type: 'result', subtype: 'success', result: 'stale' }, oldScope);
      await flushMicrotasks();

      expect((service as any).runtimeTurns.get('turn-scope-b').phase).toBe('collecting');
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'settle_result')).toBe(false);
      expect(phases.some(entry => entry.phase === 'query_scope_stale')).toBe(true);
      await service.completeUserTurnProjection('turn-scope-b');
    });

    it.each(['result', 'reject'] as const)('a retired consumer drops its late %s while the rebuilt next lease settles only on its own result', async (lateKind) => {
      const delivered: unknown[] = [];
      let deliverOldResult!: () => void;
      const bufferedStdout = new Promise<void>(resolve => {
        deliverOldResult = resolve;
        releaseOwnedTasks.push(resolve);
      });
      const transportSpy = jest.spyOn(sdkMock, 'query');
      const createTransport = transportSpy.getMockImplementation()!;
      transportSpy.mockImplementationOnce((args) => {
        const transport = createTransport(args);
        const next = transport.next.bind(transport);
        jest.spyOn(transport, 'next').mockImplementation(async (...input) => {
          const item = await next(...input);
          if (!item.done && item.value.type === 'result') {
            await bufferedStdout;
            if (lateKind === 'reject') throw new Error('late retired transport rejection');
          }
          if (!item.done) delivered.push(item.value);
          return item;
        });
        return transport;
      });
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'old reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const oldQuery = sdkMock.getLastResponse()!;
      const oldScope = (service as any).currentQueryScope;
      const oldTurn = service.prepareTurn({ turnId: 'turn-real-old', text: 'old input' });
      const oldGenerator = service.query(oldTurn);
      await oldGenerator.next();
      await armTerminalEvidence(service, oldTurn.turnId);
      const oldDone = oldGenerator.next();

      const nextTurn = service.prepareTurn({ turnId: 'turn-real-next', text: 'next input' });
      const nextGenerator = service.query(nextTurn);
      const nextFirst = nextGenerator.next();
      await flushMicrotasks();
      const oldConsumer = (service as any).responseConsumerPromise as Promise<void>;
      ownedConsumers.push(oldConsumer);
      // Only SDK transport timing is mocked: old stdout stays buffered until
      // the next query has really dispatched. Production retirement closes
      // the channel and confirms exit through the injected process event.
      oldQuery.pushLateMessage({ type: 'result', subtype: 'success', result: 'old pipe residue' });
      sdkMock.setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'next reply' }] } },
      ], { appendResult: false });
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect((await oldDone).value).toEqual({ type: 'done' });
      expect((await nextFirst).value).toEqual(expect.objectContaining({ type: 'text', content: 'next reply' }));
      const nextQuery = sdkMock.getLastResponse()!;
      const nextChannel = (service as any).messageChannel as MessageChannel;
      expect(nextQuery).not.toBe(oldQuery);
      expect(oldScope.retired).toBe(true);
      expect(nextChannel.getActiveTurnId()).toBe(nextTurn.turnId);
      const liveTurn = (service as any).runtimeTurns.get(nextTurn.turnId);
      const handler = [...liveTurn.waiters][0] as { onDone: () => void };
      const onDone = jest.spyOn(handler, 'onDone');
      deliverOldResult();
      await oldConsumer;
      expect(nextChannel.getActiveTurnId()).toBe(nextTurn.turnId);
      expect(onDone).not.toHaveBeenCalled();
      expect(sdkMock.getQueryCallCount()).toBe(2);
      expect((service as any).persistentQuery).toBe(nextQuery);
      expect((service as any).responseConsumerRunning).toBe(true);
      expect((service as any).lastSentTurnId).toBe(nextTurn.turnId);
      expect(delivered.filter((message: any) => message.type === 'result')).toHaveLength(lateKind === 'result' ? 1 : 0);
      expect((await readDiagnosticPhases(diagDir)).filter(entry => entry.phase === 'settle_result')).toHaveLength(0);
      nextQuery.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'next own result' });
      await flushMicrotasks();
      await service.completeUserTurnProjection(nextTurn.turnId);
      expect((await nextGenerator.next()).value).toEqual({ type: 'done' });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(nextChannel.getActiveTurnId()).toBeNull();
      expect((await readDiagnosticPhases(diagDir)).filter(entry => entry.phase === 'settle_result')).toHaveLength(1);
    });

    it('a runtime handoff resuming after a retirement never escalates on the replacement lease', async () => {
      // The projection barrier parks the runtime handoff across the feature
      // await; a retirement + new dispatch may land inside that window.
      service.setOnAutoTurnStarted(() => {});
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'old reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const oldChannel = (service as any).messageChannel as MessageChannel;

      const turnA = service.prepareTurn({ turnId: 'turn-handoff-a', text: 'hello' });
      const genA = service.query(turnA);
      await genA.next();
      const genADone = genA.next();

      // The real result settles the feature side but parks the runtime
      // handoff on the feature projection barrier.
      sdkMock.getLastResponse()!.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'ok' });
      await flushMicrotasks();
      expect((await genADone).value).toEqual({ type: 'done' });
      // The lease is still held — the handoff is parked mid-settle.
      expect(oldChannel.getActiveTurnId()).toBe('turn-handoff-a');

      // A retirement rebuilds the query during the parked handoff; the
      // parked turn is the retirement's own exempt settle.
      await service.retireAndRebuildQuery('test handoff retire', 'turn-handoff-a');
      await flushMicrotasks();
      expect(sdkMock.getQueryCallCount()).toBe(2);

      // A new turn dispatches on the replacement channel and takes the lease.
      sdkMock.setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'next reply' }] } },
      ], { appendResult: false });
      const turnC = service.prepareTurn({ turnId: 'turn-handoff-c', text: 'next' });
      const genC = service.query(turnC);
      const cFirst = genC.next();
      await flushMicrotasks();
      const newChannel = (service as any).messageChannel as MessageChannel;
      expect(newChannel).not.toBe(oldChannel);
      expect((await cFirst).value).toEqual(expect.objectContaining({ type: 'text', content: 'next reply' }));
      expect(newChannel.getActiveTurnId()).toBe('turn-handoff-c');
      const cDone = genC.next();
      let cSettled = false;
      void cDone.then(() => { cSettled = true; });
      await flushMicrotasks();

      // The parked handoff resumes: it must neither release nor escalate a
      // lease mismatch into cancelling the replacement's live turn.
      await service.completeUserTurnProjection('turn-handoff-a');
      await flushMicrotasks();
      expect(cSettled).toBe(false);
      expect(newChannel.getActiveTurnId()).toBe('turn-handoff-c');
      expect((service as any).runtimeTurns.has('turn-handoff-c')).toBe(true);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.detail === 'complete_turn_mismatch')).toBe(false);
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.turnId === 'turn-handoff-c')).toBe(false);

      // The new turn settles only on its own result — and its own handoff
      // (same-scope) still releases the lease normally.
      sdkMock.getLastResponse()!.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'ok' });
      await flushMicrotasks();
      expect((await cDone).value).toEqual({ type: 'done' });
      await service.completeUserTurnProjection('turn-handoff-c');
      expect(newChannel.getActiveTurnId()).toBeNull();
    });

    it('a late result already in the old CLI pipe is dropped by the old consumer loop once the scope is replaced', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turnA = service.prepareTurn({ turnId: 'turn-pipe-a', text: 'hello' });
      const genA = service.query(turnA);
      await genA.next();
      const oldScope = (service as any).currentQueryScope;

      // The old CLI already wrote its result line before the retirement
      // reached it (buffered trailing output draining after close).
      const oldQuery = sdkMock.getLastResponse()!;
      oldQuery.pushLateMessage({ type: 'result', subtype: 'success', result: 'pipe residue' });

      installReplacementQuery(service);
      const turnB = service.prepareTurn({ turnId: 'turn-pipe-b', text: 'queued hello' });
      const genB = service.query(turnB);
      await genB.next();
      await flushMicrotasks();

      // Retire the old channel: its prompt iterable ends, the old generator
      // drains the buffered result, and the old consumer loop must drop it.
      (oldScope.channel as MessageChannel).close();
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
        await Promise.resolve();
      }

      expect((service as any).runtimeTurns.get('turn-pipe-b').phase).toBe('collecting');
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'settle_result')).toBe(false);
      await service.completeUserTurnProjection('turn-pipe-b');
    });

    it("an old turn's cancellation never escalates onto the new channel's lease holder", async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turnA = service.prepareTurn({ turnId: 'turn-esc-a', text: 'hello' });
      const genA = service.query(turnA);
      await genA.next();
      const turnAObserved = (service as any).runtimeTurns.get('turn-esc-a');

      installReplacementQuery(service);
      const turnB = service.prepareTurn({ turnId: 'turn-esc-b', text: 'queued hello' });
      const genB = service.query(turnB);
      await genB.next();
      await flushMicrotasks();
      const channelB = (service as any).messageChannel as MessageChannel;
      expect(channelB.getActiveTurnId()).toBe('turn-esc-b');

      // Cancelling the OLD turn (still holding old-scope state) must not run
      // the mismatch path against the new channel's lease holder.
      expect(turnAObserved.queryEpoch).not.toBe((service as any).currentQueryScope.epoch);
      (service as any).cancelTurn('turn-esc-a', 'test_scope_isolation');

      expect(channelB.getActiveTurnId()).toBe('turn-esc-b');
      expect((service as any).runtimeTurns.has('turn-esc-b')).toBe(true);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'query_close' && String(entry.detail).includes('lease protocol error'))).toBe(false);
    });

    it("an old query's stdin error never closes the scope that replaced it", async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const oldQuery = sdkMock.getLastResponse()!;
      installReplacementQuery(service);
      expect((service as any).currentQueryScope.query).not.toBe(oldQuery);

      const closeSpy = jest.spyOn(service, 'closePersistentQuery');
      let errorHandler: (error: NodeJS.ErrnoException) => void = () => {};
      const stdinMock = {
        on: jest.fn((event: string, handler: any) => { if (event === 'error') errorHandler = handler; }),
        once: jest.fn(),
        removeListener: jest.fn(),
      };
      (oldQuery as any).transport = { processStdin: stdinMock };
      (service as any).attachPersistentQueryStdinErrorHandler(oldQuery as any);

      errorHandler({ code: 'ECONNRESET', message: 'Connection reset' } as NodeJS.ErrnoException);
      expect(closeSpy).not.toHaveBeenCalled();
      expect((service as any).currentQueryScope).not.toBeNull();
      closeSpy.mockRestore();
    });
  });

  describe('query retirement rebuild (2026-11-05 fix 2: retire the old query, never reuse it)', () => {
    it('rebuild restores the unsent queue exactly once, with zero replay of the dispatched input', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      const oldGen = (await startPersistentQuery(service), sdkMock.getLastResponse()!);

      const turn = service.prepareTurn({ turnId: 'turn-rebuild-a', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-rebuild-a');
      const settledNext = gen.next();
      await flushMicrotasks();

      const queuedTurn = service.prepareTurn({ turnId: 'turn-rebuild-q', text: 'queued hello' });
      const queuedGen = service.query(queuedTurn);
      let queuedResolved = false;
      const queuedNext = queuedGen.next().then(value => {
        queuedResolved = true;
        return value;
      });
      await flushMicrotasks();

      sdkMock.setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'queued reply' }] } },
        { type: 'result', subtype: 'success', result: 'ok' },
      ], { appendResult: false });

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();

      expect((await settledNext).value).toEqual({ type: 'done' });
      expect(oldGen.close).toHaveBeenCalledTimes(1);
      // Exactly one OLD query and one REBUILT query — the dispatched input
      // never replays, the queued input dispatches exactly once.
      expect(sdkMock.getQueryCallCount()).toBe(2);
      const rebuiltChannel = (service as any).messageChannel as MessageChannel;
      expect(rebuiltChannel.getActiveTurnId()).toBe('turn-rebuild-q');
      const queuedFirst = await queuedNext;
      expect(queuedResolved).toBe(true);
      expect(queuedFirst.value).toEqual(expect.objectContaining({ type: 'text', content: 'queued reply' }));
      await service.completeUserTurnProjection('turn-rebuild-q');
      const queuedDone = await queuedGen.next();
      expect(queuedDone.value).toEqual({ type: 'done' });

      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'query_retire')).toBe(true);
      expect(phases.some(entry => entry.phase === 'query_exit_confirmed')).toBe(true);
      expect(phases.some(entry => entry.phase === 'query_rebuilt' && String(entry.detail).includes('restored=1'))).toBe(true);
      // One result settlement only: the queued turn's own result. The old
      // query never yielded one, and the dispatched turn settled by cancel.
      expect(phases.filter(entry => entry.phase === 'settle_result')).toHaveLength(1);
    });

    it('no real process exit within 15s: unsent turns settle with an explicit error and no second CLI starts', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const oldGen = sdkMock.getLastResponse()!;
      // Process-event simulation: the CLI process never reports exit.
      oldGen.close.mockImplementation(() => {});

      const turn = service.prepareTurn({ turnId: 'turn-exit-timeout', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-exit-timeout');
      const settledNext = gen.next();
      await flushMicrotasks();

      const queuedTurn = service.prepareTurn({ turnId: 'turn-exit-timeout-q', text: 'queued hello' });
      const queuedGen = service.query(queuedTurn);
      const queuedNext = queuedGen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect((await settledNext).value).toEqual({ type: 'done' });

      // The 15s exit-confirmation window expires with no real exit.
      await jest.advanceTimersByTimeAsync(15_000 + 1_000);
      await flushMicrotasks();

      const queuedSettled = await queuedNext;
      expect(queuedSettled.value).toEqual(expect.objectContaining({ type: 'error' }));
      expect((queuedSettled.value as { content?: string }).content).toContain('did not exit');
      expect(sdkMock.getQueryCallCount()).toBe(1);
      expect((service as any).persistentQuery).toBeNull();
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'query_exit_confirmed' && String(entry.detail).includes('timeout'))).toBe(true);
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'query_exit_timeout')).toBe(true);
      expect(phases.some(entry => entry.phase === 'query_rebuilt')).toBe(false);
    });

    it('rebuild failure settles the unsent turns with an explicit error and keeps the send prohibition', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      // Fail only the SDK transport creation; the production retirement and
      // startup methods must execute, including their failure prohibition.
      jest.spyOn(sdkMock, 'query').mockImplementationOnce(() => {
        throw new Error('rebuild failed: CLI unavailable');
      });

      const turn = service.prepareTurn({ turnId: 'turn-rebuild-fail', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-rebuild-fail');
      const settledNext = gen.next();
      await flushMicrotasks();

      const queuedTurn = service.prepareTurn({ turnId: 'turn-rebuild-fail-q', text: 'queued hello' });
      const queuedGen = service.query(queuedTurn);
      const queuedNext = queuedGen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect((await settledNext).value).toEqual({ type: 'done' });

      const queuedSettled = await queuedNext;
      expect(queuedSettled.value).toEqual(expect.objectContaining({ type: 'error', content: 'rebuild failed: CLI unavailable' }));
      expect((service as any).persistentQuery).toBeNull();
      expect((service as any).queryStartProhibited).toBe('query_rebuild_failed');
      await expect(service.ensureReady()).rejects.toThrow('query_rebuild_failed');
      for (const forceColdStart of [false, true]) {
        const blocked = service.query('blocked after rebuild', undefined, undefined, { forceColdStart });
        expect((await blocked.next()).value).toEqual(expect.objectContaining({ type: 'error' }));
        await blocked.return(undefined);
      }
      expect(sdkMock.getQueryCallCount()).toBe(1);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'query_rebuild_failed')).toBe(true);
    });

    it('concurrent ensureReady during a rebuild never starts a second query', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const oldScope = (service as any).currentQueryScope;
      const oldQuery = sdkMock.getLastResponse()!;
      // Delay only the process exit event. The real retirement/start gate
      // stays pending until THIS old process reports exit.
      oldQuery.close.mockImplementation(() => {});

      const turn = service.prepareTurn({ turnId: 'turn-gate', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-gate');
      const settledNext = gen.next();
      await flushMicrotasks();

      // No stopTask candidates: retirement starts after the interrupt grace,
      // so stop before the separate 15s process-exit timeout elapses.
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();

      // The rebuild chain is parked on its gate; two concurrent ensureReady
      // calls must not start a second query around it.
      expect((service as any).persistentQuery).toBeNull();
      const ready1 = service.ensureReady();
      const ready2 = service.ensureReady();
      (service as any).notifyQueryProcessExit(oldScope.epoch);
      await Promise.all([ready1, ready2]);
      await flushMicrotasks();

      expect((await settledNext).value).toEqual({ type: 'done' });
      expect(sdkMock.getQueryCallCount()).toBe(2);
      expect((service as any).persistentQuery).not.toBeNull();
    });

    it('a channel-reported lease holder nobody settles is force-settled by the retirement, not left hanging', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-anomaly', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      const pendingNext = gen.next();
      await flushMicrotasks();
      // The turn is dispatched (holds the lease) and awaiting its result.
      expect((service as any).messageChannel.getActiveTurnId()).toBe('turn-anomaly');

      // Protocol-anomaly stand-in: the retirement caller's exempt id is NOT
      // the channel-reported lease holder, so close()'s returned id has no
      // other settler — the retirement's fallback must settle it.
      await service.retireAndRebuildQuery('test anomaly retire', 'some-unrelated-turn');
      await flushMicrotasks();

      expect((await pendingNext).value).toEqual({ type: 'done' });
      expect((service as any).runtimeTurns.has('turn-anomaly')).toBe(false);
      // The rebuild itself still completes: one replacement CLI, no prohibition.
      expect(sdkMock.getQueryCallCount()).toBe(2);
      expect((service as any).queryStartProhibited).toBeNull();
      expect((service as any).persistentQuery).not.toBeNull();
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'persistent_query_retired')).toBe(true);
      await gen.return(undefined);
    });

    it('a user-turn handoff resuming after a retirement never escalates on the replacement channel', async () => {
      // The projection barrier is what parks the settle on an await — arm it
      // through the production lifecycle callback.
      service.setOnAutoTurnStarted(() => {});
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-handoff', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await flushMicrotasks();

      // The old turn's real result arrives — settleTurnAtResult parks on the
      // feature barrier BEFORE its runtime handoff releases the lease.
      sdkMock.getLastResponse()!.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'ok' });
      await flushMicrotasks();
      expect((service as any).runtimeTurns.has('turn-handoff')).toBe(true);

      // While the handoff is parked, the query retires and rebuilds; the old
      // turn is the lease holder the retirement must NOT pre-settle.
      await service.retireAndRebuildQuery('test handoff retire', 'turn-handoff');
      await flushMicrotasks();

      // A new dispatch takes the replacement channel's lease.
      const turnNew = service.prepareTurn({ turnId: 'turn-new', text: 'next' });
      const genNew = service.query(turnNew);
      await genNew.next();
      await flushMicrotasks();
      expect((service as any).messageChannel.getActiveTurnId()).toBe('turn-new');
      expect((service as any).runtimeTurns.has('turn-new')).toBe(true);

      // Resuming the parked handoff must not release — or escalate a lease
      // mismatch by cancelling — the new turn on the replacement channel.
      await service.completeUserTurnProjection('turn-handoff');
      await flushMicrotasks();
      expect((service as any).messageChannel.getActiveTurnId()).toBe('turn-new');
      expect((service as any).runtimeTurns.has('turn-handoff')).toBe(false);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'complete_turn_mismatch')).toBe(false);

      // The new turn settles only on its own result (its own barrier completes
      // the handoff and releases the lease).
      sdkMock.getLastResponse()!.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'new ok' });
      const settledNew = await genNew.next();
      expect(settledNew.value).toEqual({ type: 'done' });
      await service.completeUserTurnProjection('turn-new');
      await flushMicrotasks();
      expect((service as any).messageChannel.getActiveTurnId()).toBeNull();
      await gen.return(undefined);
    });
  });

  describe('start single-flight and send prohibition (2026-11-05 spec 2.4 wiring)', () => {
    it('concurrent ensureReady calls join the same start flight — one channel, one agentQuery call', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      const ready1 = service.ensureReady();
      const ready2 = service.ensureReady();
      await Promise.all([ready1, ready2]);
      await flushMicrotasks();

      expect(sdkMock.getQueryCallCount()).toBe(1);
      expect((service as any).persistentQuery).not.toBeNull();
      expect((service as any).persistentQueryStart).toBeNull();
    });

    it('a close landing mid-start orphans the flight — no channel revival, no query spawn', async () => {
      // The production options await yields naturally. Close synchronously
      // before that microtask resumes; no startup/options method is mocked.
      const startPromise = service.ensureReady();
      const channelInFlight = (service as any).messageChannel as MessageChannel;
      expect(channelInFlight).not.toBeNull();
      expect((service as any).persistentQueryStart).not.toBeNull();

      // An explicit close tears the half-built slot down while the flight
      // is parked in its options await.
      (service as any).closePersistentQuery('test concurrent close');
      await startPromise;

      // The flight orphans: no query spawn, no channel left in the slot.
      expect(sdkMock.getQueryCallCount()).toBe(0);
      expect((service as any).persistentQuery).toBeNull();
      expect((service as any).messageChannel).toBeNull();
      expect((service as any).persistentQueryStart).toBeNull();
    });

    it('exit-timeout prohibition blocks every query path with an explicit error until an explicit close clears it', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const oldGen = sdkMock.getLastResponse()!;
      // Process-event simulation: the CLI process never reports exit.
      oldGen.close.mockImplementation(() => {});

      const turn = service.prepareTurn({ turnId: 'turn-proh', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-proh');
      const settledNext = gen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      // The old generator may await the production deferred-restart barrier,
      // which joins retirement. Advance the exit timer before awaiting it.
      // Explicit cold-start must join retirement too, not start a second CLI
      // while the old process is still awaiting exit confirmation.
      const cold = service.query('cold during retirement', undefined, undefined, { forceColdStart: true });
      let coldSettled = false;
      const coldNext = cold.next().then(value => { coldSettled = true; return value; });
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
      expect(coldSettled).toBe(false);
      expect(sdkMock.getQueryCallCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(15_000 + 1_000);
      await flushMicrotasks();
      expect((await settledNext).value).toEqual({ type: 'done' });
      expect((await coldNext).value).toEqual(expect.objectContaining({ type: 'error' }));
      await cold.return(undefined);

      // The prohibition is armed with its reason.
      expect((service as any).queryStartProhibited).toBe('query_exit_timeout');
      expect(sdkMock.getQueryCallCount()).toBe(1);

      // A new query gets the explicit error — no persistent start, no
      // cold-start fallback spawning a second CLI.
      const blockedTurn = service.prepareTurn({ turnId: 'turn-proh-b', text: 'blocked' });
      const blockedGen = service.query(blockedTurn);
      const blockedFirst = await blockedGen.next();
      expect(blockedFirst.value).toEqual(expect.objectContaining({ type: 'error' }));
      expect((blockedFirst.value as { content?: string }).content).toContain('blocked after a failed query recovery');
      expect(sdkMock.getQueryCallCount()).toBe(1);

      // An explicit recovery entry (session reset) clears the prohibition;
      // the next start succeeds.
      service.resetSession();
      expect((service as any).queryStartProhibited).toBeNull();
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session-2' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'revived reply' }] } },
      ], { appendResult: false });
      const revivedTurn = service.prepareTurn({ turnId: 'turn-proh-r', text: 'revived' });
      const revivedGen = service.query(revivedTurn);
      const revivedFirst = await revivedGen.next();
      expect(revivedFirst.value).not.toEqual(expect.objectContaining({ type: 'error' }));
      expect(sdkMock.getQueryCallCount()).toBe(2);
    });

    it('a forced ensureReady cannot clear the send prohibition — no second CLI over the orphan', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      // Fail only the SDK transport creation; the production retirement and
      // startup methods must execute, arming the prohibition for real.
      jest.spyOn(sdkMock, 'query').mockImplementationOnce(() => {
        throw new Error('rebuild failed: CLI unavailable');
      });

      const turn = service.prepareTurn({ turnId: 'turn-force-block', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-force-block');
      const settledNext = gen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS + STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect((await settledNext).value).toEqual({ type: 'done' });
      expect((service as any).queryStartProhibited).toBe('query_rebuild_failed');

      // A forced restart closes first — that close must not lift the
      // prohibition and start a second CLI over the possibly-live orphan.
      await expect(service.ensureReady({ force: true })).rejects.toThrow('blocked after a failed query recovery');
      expect((service as any).queryStartProhibited).toBe('query_rebuild_failed');
      expect(sdkMock.getQueryCallCount()).toBe(1);

      // Internal (non-explicit) closes must not lift it either: a zombie
      // stdin error from the orphan cannot revive starts.
      (service as any).closePersistentQuery('zombie stdin error');
      expect((service as any).queryStartProhibited).toBe('query_rebuild_failed');

      // The explicit recovery entry (reset) lifts it.
      service.resetSession();
      expect((service as any).queryStartProhibited).toBeNull();
    });
  });

  describe('B-(a) stopTask before interrupt (armed watchdog path)', () => {
    function stubRunningAgents(service: ClaudianService, agents: Array<{ agentId: string; startedAt: number }>): void {
      service.setSubagentHookProvider(() => ({ hasRunning: agents.length > 0, runningAgents: agents }));
    }

    it('TB1: stopTask to all running background agents (no age floor) then a result inside the window settles with no interrupt', async () => {
      stubRunningAgents(service, [
        { agentId: 'ag-fresh', startedAt: Date.now() },
        { agentId: 'ag-old', startedAt: Date.now() - 3 * STOP_TASK_AGENT_MIN_AGE_MS },
      ]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-tb1', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-tb1');
      let settled = false;
      const settledNext = gen.next().then(value => {
        settled = true;
        return value;
      });
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      const query = sdkMock.getLastResponse();
      expect(query?.stopTask).toHaveBeenCalledTimes(2);
      expect(query?.stopTask).toHaveBeenCalledWith('ag-fresh');
      expect(query?.stopTask).toHaveBeenCalledWith('ag-old');
      expect(query?.interrupt).not.toHaveBeenCalled();

      // The result flows inside the stop-task observation window.
      sdkMock.getLastResponse()!.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'ok' });
      await flushMicrotasks();
      expect(settled).toBe(true);

      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS);
      await flushMicrotasks();
      const settledValue = await settledNext;
      expect(settledValue.value).toEqual({ type: 'done' });

      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.filter(entry => entry.phase === 'stop_task_sent')).toHaveLength(2);
      const outcomes = phases.filter(entry => entry.phase === 'stop_task_outcome');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].outcome).toBe('settled_by_result');
      expect(phases.some(entry => entry.phase === 'settle_result')).toBe(true);
      expect(phases.some(entry => entry.phase === 'interrupt_sent')).toBe(false);
      expect(phases.some(entry => entry.phase === 'turn_cancel')).toBe(false);
      await service.completeUserTurnProjection('turn-tb1');
    });

    it('TB2: stopTask without effect escalates to interrupt then force-settle and pumps the queue', async () => {
      stubRunningAgents(service, [{ agentId: 'ag-stuck', startedAt: Date.now() - STOP_TASK_AGENT_MIN_AGE_MS }]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-tb2', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-tb2');
      let settled = false;
      const settledNext = gen.next().then(value => {
        settled = true;
        return value;
      });
      await flushMicrotasks();

      const queuedTurn = service.prepareTurn({ turnId: 'turn-tb2-q', text: 'queued hello' });
      const queuedGen = service.query(queuedTurn);
      let queuedResolved = false;
      const queuedNext = queuedGen.next().then(value => {
        queuedResolved = true;
        return value;
      });
      await flushMicrotasks();

      sdkMock.setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'queued reply' }] } },
        { type: 'result', subtype: 'success', result: 'ok' },
      ], { appendResult: false });

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);
      // No result during the stop-task window.
      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS);
      expect(sdkMock.getLastResponse()?.interrupt).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect(settled).toBe(true);
      const settledValue = await settledNext;
      expect(settledValue.value).toEqual({ type: 'done' });
      const queuedFirst = await queuedNext;
      expect(queuedResolved).toBe(true);
      expect(queuedFirst.value).toEqual(expect.objectContaining({ type: 'text', content: 'queued reply' }));
      await service.completeUserTurnProjection('turn-tb2-q');
      const queuedDone = await queuedGen.next();
      expect(queuedDone.value).toEqual({ type: 'done' });

      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'stop_task_sent')).toBe(true);
      expect(phases.some(entry => entry.phase === 'stop_task_outcome' && entry.outcome === 'settled_by_result')).toBe(false);
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'result_watchdog')).toBe(true);
    });

    it('TB6: a stopTask rejection (StopTaskError shape) is benign — outcome=error, chain still escalates to cancel', async () => {
      stubRunningAgents(service, [{ agentId: 'ag-refused', startedAt: Date.now() - STOP_TASK_AGENT_MIN_AGE_MS }]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-tb6', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-tb6');
      let settled = false;
      const settledNext = gen.next().then(value => {
        settled = true;
        return value;
      });
      await flushMicrotasks();

      const query = sdkMock.getLastResponse();
      query?.stopTask.mockRejectedValueOnce(new Error('stop_task_refused: No task found with ID'));
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS);
      await flushMicrotasks();
      expect(query?.interrupt).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect(settled).toBe(true);
      const settledValue = await settledNext;
      expect(settledValue.value).toEqual({ type: 'done' });

      const phases = await readDiagnosticPhases(diagDir);
      const outcomes = phases.filter(entry => entry.phase === 'stop_task_outcome');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].outcome).toBe('error');
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'result_watchdog')).toBe(true);
    });

    it('cancel during the stopTask observation window never reports settled_by_result or sends a late interrupt', async () => {
      stubRunningAgents(service, [{ agentId: 'cancel-agent', startedAt: Date.now() }]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const gen = service.query(service.prepareTurn({ turnId: 'turn-window-cancel', text: 'hello' }));
      await gen.next();
      await armTerminalEvidence(service, 'turn-window-cancel');
      const done = gen.next();
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);
      (service as any).cancelTurn('turn-window-cancel', 'test_cancel');
      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS);
      expect((await done).value).toEqual({ type: 'done' });
      expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'stop_task_outcome' && entry.outcome === 'settled_by_result')).toBe(false);
    });

    it('concurrently sends every stopTask even if the first control request never resolves, then falls back on time', async () => {
      stubRunningAgents(service, [
        { agentId: 'blocked-control', startedAt: Date.now() },
        { agentId: 'refused-control', startedAt: Date.now() },
        { agentId: 'normal-control', startedAt: Date.now() },
      ]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const gen = service.query(service.prepareTurn({ turnId: 'turn-concurrent', text: 'hello' }));
      await gen.next();
      await armTerminalEvidence(service, 'turn-concurrent');
      const done = gen.next();
      await flushMicrotasks();
      const query = sdkMock.getLastResponse()!;
      query.stopTask.mockImplementation((agentId: string) => {
        if (agentId === 'blocked-control') return new Promise<void>(resolve => { releaseOwnedTasks.push(resolve); });
        if (agentId === 'refused-control') return Promise.reject(new Error('stop_task_refused'));
        return Promise.resolve();
      });
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      expect(query.stopTask.mock.calls.map(call => call[0])).toEqual(['blocked-control', 'refused-control', 'normal-control']);
      expect(query.interrupt).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS);
      expect(query.interrupt).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
      expect((await done).value).toEqual({ type: 'done' });
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.filter(entry => entry.phase === 'stop_task_sent')).toHaveLength(3);
      expect(phases.some(entry => entry.phase === 'stop_task_outcome' && entry.outcome === 'error' && entry.cliVersion === '2.1.227')).toBe(true);
      expect(phases.filter(entry => entry.phase === 'stop_task_sent').every(entry => typeof entry.agentIdHash === 'string')).toBe(true);
    });

    it('defect 1: stdout chunks in BOTH observation windows leave interrupt at 15s and retirement at 30s', async () => {
      stubRunningAgents(service, [{ agentId: 'ag-chunk-burst', startedAt: Date.now() }]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      const gen = service.query(service.prepareTurn({ turnId: 'turn-chunk-burst', text: 'hello' }));
      await gen.next();
      await armTerminalEvidence(service, 'turn-chunk-burst');
      const delivered: unknown[] = [];
      const consume = (async () => {
        for await (const chunk of gen) delivered.push(chunk);
      })();
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      const query = sdkMock.getLastResponse()!;
      expect(query.stopTask).toHaveBeenCalledTimes(1);

      // Production consumer receives stdout at fire+5/+10 and +20/+25;
      // chunks wake the generator but never reset the recovery deadlines.
      for (const elapsed of [5, 10, 15, 20, 25, 30]) {
        await jest.advanceTimersByTimeAsync(5_000);
        if ([5, 10, 20, 25].includes(elapsed)) {
          query.pushStdoutMessage({ type: 'assistant', message: { id: `tail-${elapsed}`, content: [{ type: 'text', text: `tail at ${elapsed}s` }] } });
          for (let i = 0; i < 40; i += 1) await Promise.resolve();
        }
        expect(query.stopTask).toHaveBeenCalledTimes(1);
        expect(query.interrupt).toHaveBeenCalledTimes(elapsed < 15 ? 0 : 1);
        expect(query.close).toHaveBeenCalledTimes(elapsed < 30 ? 0 : 1);
      }
      await consume;
      expect(delivered.filter(chunk => (chunk as { type?: string }).type === 'text')).toHaveLength(4);
      expect(delivered).toContainEqual({ type: 'done' });
      expect(sdkMock.getQueryCallCount()).toBe(2);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.filter(entry => entry.phase === 'settle_watchdog_fire')).toHaveLength(1);
      expect(phases.filter(entry => entry.phase === 'stop_task_sent')).toHaveLength(1);
      expect(phases.filter(entry => entry.phase === 'query_retire')).toHaveLength(1);
    });

    it('defect 1: a real result 7s into the observation window ends the attempt — the next queued turn runs with no interrupt, no cancel', async () => {
      stubRunningAgents(service, [{ agentId: 'ag-early-result', startedAt: Date.now() }]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-early', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-early');
      const settledNext = gen.next();
      await flushMicrotasks();

      const queuedTurn = service.prepareTurn({ turnId: 'turn-early-q', text: 'queued hello' });
      const queuedGen = service.query(queuedTurn);
      let queuedResolved = false;
      const queuedNext = queuedGen.next().then(value => {
        queuedResolved = true;
        return value;
      });
      await flushMicrotasks();

      sdkMock.setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'queued reply' }] } },
        { type: 'result', subtype: 'success', result: 'ok' },
      ], { appendResult: false });

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(7_000);
      sdkMock.getLastResponse()!.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'ok' });
      await flushMicrotasks();
      expect((await settledNext).value).toEqual({ type: 'done' });
      await service.completeUserTurnProjection('turn-early');

      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      const query = sdkMock.getLastResponse()!;
      expect(query.interrupt).not.toHaveBeenCalled();

      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'stop_task_outcome' && entry.outcome === 'settled_by_result')).toBe(true);
      expect(phases.some(entry => entry.phase === 'turn_cancel')).toBe(false);

      // The next turn runs on its own result — the queue pumped normally.
      expect(queuedResolved).toBe(true);
      const queuedFirst = await queuedNext;
      expect(queuedFirst.value).toEqual(expect.objectContaining({ type: 'text', content: 'queued reply' }));
      await service.completeUserTurnProjection('turn-early-q');
      const queuedDone = await queuedGen.next();
      expect(queuedDone.value).toEqual({ type: 'done' });
    });

    it('defect 1: a terminal-evidence retraction (Stop-hook continuation proof) freezes the live attempt out', async () => {
      stubRunningAgents(service, [{ agentId: 'ag-retract', startedAt: Date.now() }]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-retract', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      service.beginUserTurnProjection('turn-retract');
      await awaitObserverStart();
      const uuid = (service as any).lastSentMessage.uuid as string;
      (service as any).transcriptObserver.registerHostUserTranscriptId(uuid);
      await appendFile(transcriptFile, hostUserRowLine(uuid));
      await driveObserverTick();
      void gen.next();
      await flushMicrotasks();

      await appendFile(transcriptFile, hostTerminalRows());
      await driveObserverTick();
      const observed = (service as any).runtimeTurns.get('turn-retract');
      expect(observed.transcriptTerminalSeenAt).not.toBeNull();

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);

      // The Stop hook BLOCKS the turn's end: continuation proof retracts the
      // stamped terminal and freezes the live attempt via the revision bump.
      await appendFile(transcriptFile, JSON.stringify({ type: 'user', isMeta: true, userType: 'external', message: { role: 'user', content: 'Stop hook feedback: Background subagent still running' } }) + '\n');
      await driveObserverTick();
      expect(observed.transcriptTerminalSeenAt).toBeNull();
      expect(observed.evidenceRevision).toBe(1);

      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
      expect((service as any).runtimeTurns.has('turn-retract')).toBe(true);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.filter(entry => entry.phase === 'settle_watchdog_fire')).toHaveLength(1);
      expect(phases.some(entry => entry.phase === 'host_terminal_retracted')).toBe(true);
    });

    it('defect 4: a late stopTask rejection reports the frozen attempt identity, never the mutated turn state', async () => {
      stubRunningAgents(service, [{ agentId: 'ag-frozen', startedAt: Date.now() }]);
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-frozen', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-frozen');
      const done = gen.next();
      await flushMicrotasks();

      const query = sdkMock.getLastResponse()!;
      let rejectStop!: (error: Error) => void;
      query.stopTask.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
        rejectStop = reject;
        releaseOwnedTasks.push(resolve);
      }));

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      const attemptEpoch = (service as any).currentQueryScope.epoch;
      // Mutate the live identity AFTER the send: generation bump and a CLI
      // version flip (a later transcript row carrying a different version).
      const observedTurn = (service as any).runtimeTurns.get('turn-frozen');
      observedTurn.generation += 1;
      (service as any).transcriptCliVersion = '2.1.311';

      rejectStop(new Error('stop_task_refused'));
      await flushMicrotasks();

      const phases = await readDiagnosticPhases(diagDir);
      const outcome = phases.find(entry => entry.phase === 'stop_task_outcome' && entry.outcome === 'error');
      expect(outcome).toBeDefined();
      expect(outcome!.generation).toBe(0);
      expect(outcome!.cliVersion).toBe('2.1.227');
      expect(outcome!.queryEpoch).toBe(attemptEpoch);
      expect(typeof outcome!.attemptId).toBe('number');

      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect((await done).value).toEqual({ type: 'done' });
    });

    it('probe→watchdog: agents the silent probe already stopped are never re-stopped by the armed recovery', async () => {
      service.setSubagentHookProvider(() => ({
        hasRunning: true,
        runningAgents: [{ agentId: 'ag-probe-then-fire', startedAt: Date.now() - 3 * STOP_TASK_AGENT_MIN_AGE_MS }],
      }));
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-probe-fire', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      service.beginUserTurnProjection('turn-probe-fire');
      await awaitObserverStart();
      void gen.next();
      await flushMicrotasks();

      // Silent probe fires first (no terminal evidence).
      await jest.advanceTimersByTimeAsync(STOP_TASK_TURN_SILENCE_MS + RESULT_WATCHDOG_MS);
      await flushMicrotasks();
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);

      // The turn's real terminal lands later; the armed watchdog fires at
      // +120s — the already-stopped agent id must be filtered out.
      const uuid = (service as any).lastSentMessage.uuid as string;
      (service as any).transcriptObserver.registerHostUserTranscriptId(uuid);
      await appendFile(transcriptFile, hostUserRowLine(uuid) + hostTerminalRows());
      await driveObserverTick();
      expect((service as any).runtimeTurns.get('turn-probe-fire').transcriptTerminalSeenAt).not.toBeNull();
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      await flushMicrotasks();

      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'settle_watchdog_fire')).toBe(true);
      expect(phases.some(entry => entry.phase === 'stop_task_outcome' && entry.outcome === 'no_candidates')).toBe(true);
    });

    it('TB7: no candidates at fire time skips the stopTask window — the interrupt chain stays exactly the current shape', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-tb7', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-tb7');
      let settled = false;
      const settledNext = gen.next().then(value => {
        settled = true;
        return value;
      });
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      const query = sdkMock.getLastResponse();
      expect(query?.stopTask).not.toHaveBeenCalled();
      expect(query?.interrupt).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_GRACE_MS);
      await flushMicrotasks();
      expect(settled).toBe(true);
      const settledValue = await settledNext;
      expect(settledValue.value).toEqual({ type: 'done' });

      const phases = await readDiagnosticPhases(diagDir);
      const outcomes = phases.filter(entry => entry.phase === 'stop_task_outcome');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].outcome).toBe('no_candidates');
      expect(phases.filter(entry => entry.phase === 'stop_task_sent')).toHaveLength(0);
    });
  });

  describe('B-(b) silent-turn stopTask probe (hook-block shape, no terminal evidence)', () => {
    it('TB4: silent turn + stale running background agent probes once with stopTask only — never interrupt, never cancel', async () => {
      service.setSubagentHookProvider(() => ({
        hasRunning: true,
        runningAgents: [{ agentId: 'ag-zombie', startedAt: Date.now() - 3 * STOP_TASK_AGENT_MIN_AGE_MS }],
      }));
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-tb4', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      service.beginUserTurnProjection('turn-tb4');
      await awaitObserverStart();
      let settled = false;
      void gen.next().then(() => { settled = true; });
      await flushMicrotasks();
      await appendFile(transcriptFile, `${JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', version: '2.1.311' })}\n`);
      await driveObserverTick();

      // No terminal evidence, no chunks for 32 minutes, agent age > 2h.
      await jest.advanceTimersByTimeAsync(STOP_TASK_TURN_SILENCE_MS + RESULT_WATCHDOG_MS);
      await flushMicrotasks();

      const query = sdkMock.getLastResponse();
      expect(query?.stopTask).toHaveBeenCalledTimes(1);
      expect(query?.stopTask).toHaveBeenCalledWith('ag-zombie');
      expect(query?.interrupt).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect((service as any).runtimeTurns.has('turn-tb4')).toBe(true);

      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.filter(entry => entry.phase === 'stop_task_sent')).toHaveLength(1);
      expect(phases.some(entry => entry.phase === 'stop_task_outcome' && entry.cliVersion === '2.1.311')).toBe(true);
      expect(phases.some(entry => entry.phase === 'interrupt_sent')).toBe(false);
      expect(phases.some(entry => entry.phase === 'turn_cancel')).toBe(false);
      expect(phases.some(entry => entry.phase === 'settle_watchdog_fire')).toBe(false);
    });

    it('TB5: the turn-level latch never probes a second time on later ticks', async () => {
      service.setSubagentHookProvider(() => ({
        hasRunning: true,
        runningAgents: [{ agentId: 'ag-zombie-2', startedAt: Date.now() - 3 * STOP_TASK_AGENT_MIN_AGE_MS }],
      }));
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-tb5', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      service.beginUserTurnProjection('turn-tb5');
      await awaitObserverStart();
      void gen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(STOP_TASK_TURN_SILENCE_MS + RESULT_WATCHDOG_MS);
      await flushMicrotasks();
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);

      // Another hour of silence: the latch holds.
      await jest.advanceTimersByTimeAsync(STOP_TASK_TURN_SILENCE_MS + RESULT_WATCHDOG_MS);
      await flushMicrotasks();
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);
      expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
      expect((service as any).runtimeTurns.has('turn-tb5')).toBe(true);
    });

    it('TB3 red line: a 48-minute sync blocking Agent (never in runningAgents) plus 31 minutes of silence probes nothing', async () => {
      // The sync blocking agent is structurally absent from the async map —
      // only async (run_in_background) agents are ever stopTask candidates.
      service.setSubagentHookProvider(() => ({ hasRunning: false, runningAgents: [] }));
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-tb3', text: 'run a blocking Agent' });
      const gen = service.query(turn);
      await gen.next();
      service.beginUserTurnProjection('turn-tb3');
      await awaitObserverStart();
      let settled = false;
      void gen.next().then(() => { settled = true; });
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(48 * 60_000 + 60_000);
      await flushMicrotasks();

      expect(sdkMock.getLastResponse()?.stopTask).not.toHaveBeenCalled();
      expect(sdkMock.getLastResponse()?.interrupt).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect((service as any).runtimeTurns.has('turn-tb3')).toBe(true);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'stop_task_sent')).toBe(false);
      expect(phases.some(entry => entry.phase === 'stop_task_outcome')).toBe(false);
    });

    it('H2 guard: a pending canUseTool approval wait suppresses the probe (the turn is parked on user input, not CLI-dead)', async () => {
      service.setSubagentHookProvider(() => ({
        hasRunning: true,
        runningAgents: [{ agentId: 'ag-approval-guard', startedAt: Date.now() - 3 * STOP_TASK_AGENT_MIN_AGE_MS }],
      }));
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);
      let resolveApproval!: (decision: 'allow') => void;
      service.setApprovalCallback(() => new Promise(resolve => {
        resolveApproval = resolve;
        releaseOwnedTasks.push(() => resolve('allow'));
      }));
      const approvalWait = (service as any).createApprovalCallback()('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'guard-tool' });

      const turn = service.prepareTurn({ turnId: 'turn-approval-guard', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      service.beginUserTurnProjection('turn-approval-guard');
      await awaitObserverStart();
      void gen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(STOP_TASK_TURN_SILENCE_MS + RESULT_WATCHDOG_MS);
      await flushMicrotasks();

      expect(sdkMock.getLastResponse()?.stopTask).not.toHaveBeenCalled();
      expect((service as any).runtimeTurns.has('turn-approval-guard')).toBe(true);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'stop_task_sent')).toBe(false);
      resolveApproval('allow');
      await approvalWait;
      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledWith('ag-approval-guard');
    });

    it('a fresh running background agent (age < 2h) is not a probe candidate', async () => {
      service.setSubagentHookProvider(() => ({
        hasRunning: true,
        runningAgents: [{ agentId: 'ag-young', startedAt: Date.now() }],
      }));
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-young-agent', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      service.beginUserTurnProjection('turn-young-agent');
      await awaitObserverStart();
      void gen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(STOP_TASK_TURN_SILENCE_MS + RESULT_WATCHDOG_MS);
      await flushMicrotasks();

      expect(sdkMock.getLastResponse()?.stopTask).not.toHaveBeenCalled();
      expect((service as any).runtimeTurns.has('turn-young-agent')).toBe(true);
    });
  });

  describe('plain user-cancel boundary isolation (2026-11-05 spec 2.4: a cancelled lease is not a CLI boundary end)', () => {
    /** Standard shape: one dispatched turn holding the lease, one queued behind it. */
    async function setupCancelledTurnWithQueue(): Promise<void> {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turnA = service.prepareTurn({ turnId: 'turn-can-a', text: 'hello' });
      const genA = service.query(turnA);
      await genA.next();
      await flushMicrotasks();

      const queuedTurn = service.prepareTurn({ turnId: 'turn-can-q', text: 'queued hello' });
      void service.query(queuedTurn).next();
      await flushMicrotasks();
    }

    async function drainMicrotasks(): Promise<void> {
      for (let i = 0; i < 30; i += 1) {
        await Promise.resolve();
        await Promise.resolve();
      }
    }

    it('late chunks never release the tombstone; the real result dissolves it and pumps the queue', async () => {
      await setupCancelledTurnWithQueue();
      const channel = (service as any).messageChannel as MessageChannel;
      expect(channel.getActiveTurnId()).toBe('turn-can-a');
      expect(channel.getQueueLength()).toBe(1);

      service.cancel();
      await service.completeUserTurnProjection('turn-can-a');
      await flushMicrotasks();

      // The tombstone owns the lease: the queued input must not dispatch.
      expect(channel.getActiveTurnId()).toBe('turn-can-a');
      expect((service as any).cancelBoundaryTombstone?.turnId).toBe('turn-can-a');
      expect(channel.getQueuedTurnIds()).toContain('turn-can-q');

      // The cancelled CLI turn keeps streaming — that is evidence it is
      // STILL running, so the lease must hold (defect-2 shape guard).
      const query = sdkMock.getLastResponse()!;
      query.pushStdoutMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'still running' }] } });
      await drainMicrotasks();
      expect(channel.getActiveTurnId()).toBe('turn-can-a');
      expect(channel.getQueuedTurnIds()).toContain('turn-can-q');

      // The REAL result proves the CLI turn ended: tombstone dissolves, the
      // result settles nothing, the queue pumps exactly once.
      query.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'over' });
      await drainMicrotasks();
      expect((service as any).cancelBoundaryTombstone).toBeNull();
      expect(channel.getActiveTurnId()).toBe('turn-can-q');
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'cancel_boundary_result_arrived')).toBe(true);
      // The late result must never settle the cancelled turn (it is gone) nor
      // pre-settle the queued turn now holding the lease.
      expect(phases.some(entry => entry.phase === 'settle_result')).toBe(false);
      expect((service as any).runtimeTurns.has('turn-can-q')).toBe(true);
    });

    it('15s without a result only prompts — the lease stays held until the real result pumps the queue', async () => {
      await setupCancelledTurnWithQueue();

      service.cancel();
      await service.completeUserTurnProjection('turn-can-a');
      await flushMicrotasks();

      const channel = (service as any).messageChannel as MessageChannel;
      expect((service as any).cancelBoundaryTombstone?.turnId).toBe('turn-can-a');

      const noticeCallsBefore = (Notice as jest.Mock).mock.calls.length;

      await jest.advanceTimersByTimeAsync(15_000);
      await drainMicrotasks();

      // Timeout correction (2.4): the notice fires, but the tombstone stays
      // armed and the queued input must NOT dispatch on the timeout — only
      // the real result releases the lease.
      expect((service as any).cancelBoundaryTombstone?.turnId).toBe('turn-can-a');
      expect(channel.getActiveTurnId()).toBe('turn-can-a');
      expect(channel.getQueuedTurnIds()).toContain('turn-can-q');
      const noticeCallsAfter = (Notice as jest.Mock).mock.calls.length;
      expect(noticeCallsAfter).toBeGreaterThan(noticeCallsBefore);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'turn_cancel' && entry.detail === 'cancel_boundary_timeout')).toBe(true);
      // The query was never closed by a plain cancel.
      expect(phases.some(entry => entry.phase === 'query_close')).toBe(false);

      // The real result (however late) is the only pump: tombstone dissolves
      // and the queued turn finally dispatches.
      const query = sdkMock.getLastResponse()!;
      query.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'over' });
      await drainMicrotasks();
      expect((service as any).cancelBoundaryTombstone).toBeNull();
      expect(channel.getActiveTurnId()).toBe('turn-can-q');
    });

    it('a result arriving before the handoff skips the tombstone window entirely', async () => {
      await setupCancelledTurnWithQueue();

      service.cancel();
      await flushMicrotasks();
      // The turn is cancelled but its projection handoff has NOT landed. The
      // real result arrives now (cancelled-phase gate records it).
      const query = sdkMock.getLastResponse()!;
      query.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'over' });
      await drainMicrotasks();
      const turnA = (service as any).runtimeTurns.get('turn-can-a');
      expect(turnA?.sawTerminalResult).toBe(true);

      await service.completeUserTurnProjection('turn-can-a');
      await drainMicrotasks();

      // Handoff: the CLI turn provably ended — no 15s window, direct release.
      expect((service as any).cancelBoundaryTombstone).toBeNull();
      const channel = (service as any).messageChannel as MessageChannel;
      expect(channel.getActiveTurnId()).toBe('turn-can-q');
    });

    it("an old-scope turn's cancel handoff never tombstones the replacement channel", async () => {
      await startPersistentQuery(service);
      const turnA = service.prepareTurn({ turnId: 'turn-can-old', text: 'hello' });
      const genA = service.query(turnA);
      await genA.next();
      const oldScope = (service as any).currentQueryScope;

      // Replace the query incarnation; a fresh turn takes the new lease.
      const channelB = (() => {
        retainReplacedQuery(service);
        const messageChannel = new MessageChannel(() => {}, (info) => (service as any).handleTurnDequeued(info));
        (service as any).messageChannel = messageChannel;
        (service as any).persistentQuery = sdkMock.query({ prompt: messageChannel, options: {} as any });
        (service as any).startResponseConsumer();
        return messageChannel;
      })();
      const turnB = service.prepareTurn({ turnId: 'turn-can-new', text: 'queued hello' });
      const genB = service.query(turnB);
      await genB.next();
      await flushMicrotasks();
      expect(channelB.getActiveTurnId()).toBe('turn-can-new');
      expect((service as any).runtimeTurns.get('turn-can-old').queryEpoch).not.toBe(
        (service as any).currentQueryScope.epoch,
      );

      // Plain-cancel the OLD turn after its scope is gone: the handoff must
      // not plant a tombstone on the replacement channel.
      (service as any).cancelTurn('turn-can-old', 'user_cancel');
      await service.completeUserTurnProjection('turn-can-old');
      await flushMicrotasks();

      expect((service as any).cancelBoundaryTombstone).toBeNull();
      expect(channelB.getActiveTurnId()).toBe('turn-can-new');
      expect((service as any).runtimeTurns.has('turn-can-new')).toBe(true);
      void oldScope;
      void genB;
    });
  });

  describe('observer rebuild anchor restore (2026-11-05 fix 3: a late observer init must not stamp "now")', () => {
    it('a rebuild after dispatch restores the REAL dispatchedAt and the live host projection — terminal rows still arm the watchdog', async () => {
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-anch-a', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await flushMicrotasks();
      service.beginUserTurnProjection('turn-anch-a');
      await awaitObserverStart();
      const descriptor = (service as any).currentDispatchDescriptor;
      expect(descriptor?.leaseTurnId).toBe('turn-anch-a');
      const realDispatchedAt = descriptor.dispatchedAt as number;
      void gen.next();

      // Ten seconds pass, then the observer is rebuilt (late init / re-init
      // shape): the restore must anchor on the REAL dispatch clock, never on
      // the rebuild moment.
      await jest.advanceTimersByTimeAsync(10_000);
      // Mirror the real rebuild teardown: the old reader must be stopped
      // (releasing its fs watch handles) before the slot is replaced, or the
      // worker leaks the handle and jest cannot exit.
      (service as any).transcriptObserver?.stop('test_rebuild');
      (service as any).transcriptObserver = null;
      (service as any).transcriptObserverTarget = null;
      (service as any).restartTranscriptObserver('watch-session');
      // observer.start awaits real fs I/O (recover/prime); awaiting the chain
      // promise suspends the test while libuv completes the reads.
      await (service as any).transcriptObserverRestartChain;
      for (let i = 0; i < 50; i += 1) await Promise.resolve();

      const observer = (service as any).transcriptObserver;
      expect(observer).not.toBeNull();
      expect(observer.currentDispatch()).toMatchObject({
        leaseTurnId: 'turn-anch-a',
        canonicalUuid: descriptor.canonicalTurnId,
        dispatchedAt: realDispatchedAt,
      });

      // The live host projection carried over the rebuild: the host row and
      // terminal rows landing afterwards still arm the watchdog on the live
      // turn (attribution requires the projection, not just the anchor).
      const uuid = descriptor.canonicalTurnId as string;
      await appendFile(transcriptFile, hostUserRowLine(uuid) + hostTerminalRows());
      await driveObserverTick();
      const turnObserved = (service as any).runtimeTurns.get('turn-anch-a');
      expect(turnObserved?.transcriptTerminalSeenAt).not.toBeNull();
    });
  });

  describe('matrix completion (2026-11-05 spec §3): close-in-window teardown and cross-scope late reject', () => {
    it('closePersistentQuery inside the stop window tears the attempt down — no late interrupt is ever sent', async () => {
      service.setSubagentHookProvider(() => ({
        hasRunning: true,
        runningAgents: [{ agentId: 'ag-close', startedAt: Date.now() - STOP_TASK_AGENT_MIN_AGE_MS }],
      }));
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-close-a', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-close-a');
      void gen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      const query = sdkMock.getLastResponse()!;
      expect(query.stopTask).toHaveBeenCalledTimes(1);

      // External close (reload / session switch) lands INSIDE the 15s stop
      // window: the attempt dies with the turn, the chain never continues.
      service.closePersistentQuery('test close in window');

      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS + 60_000);
      await flushMicrotasks();

      expect(query.interrupt).not.toHaveBeenCalled();
      expect(query.stopTask).toHaveBeenCalledTimes(1);
      const phases = await readDiagnosticPhases(diagDir);
      expect(phases.some(entry => entry.phase === 'interrupt_sent')).toBe(false);
    });

    it('a stopTask promise rejecting after the scope was replaced records the frozen identity and touches nothing on the new scope', async () => {
      service.setSubagentHookProvider(() => ({
        hasRunning: true,
        runningAgents: [{ agentId: 'ag-latereject', startedAt: Date.now() - STOP_TASK_AGENT_MIN_AGE_MS }],
      }));
      sdkMock.setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'watch-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'model reply' }] } },
      ], { appendResult: false });
      await startPersistentQuery(service);

      const turn = service.prepareTurn({ turnId: 'turn-lr-a', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      await armTerminalEvidence(service, 'turn-lr-a');
      void gen.next();
      await flushMicrotasks();

      // Hold the stopTask control request pending so its rejection can be
      // delivered after the query incarnation is replaced.
      let rejectStop!: (error: Error) => void;
      sdkMock.getLastResponse()!.stopTask.mockImplementationOnce(
        () => new Promise<void>((resolve, reject) => {
          rejectStop = reject;
          releaseOwnedTasks.push(resolve);
        }),
      );

      await jest.advanceTimersByTimeAsync(RESULT_WATCHDOG_MS);
      const oldEpoch = (service as any).currentQueryScope?.epoch as number;
      expect(sdkMock.getLastResponse()?.stopTask).toHaveBeenCalledTimes(1);

      // Queue the next input, then let the real bounded attempt retire and
      // rebuild the scope while the OLD stopTask request remains pending.
      const turnB = service.prepareTurn({ turnId: 'turn-lr-b', text: 'queued hello' });
      const genB = service.query(turnB);
      const nextFirst = genB.next();
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(STOP_TASK_GRACE_MS + RESULT_WATCHDOG_GRACE_MS);
      expect((await nextFirst).value).toEqual(expect.objectContaining({ type: 'text' }));
      const messageChannel = (service as any).messageChannel as MessageChannel;
      expect(messageChannel.getActiveTurnId()).toBe('turn-lr-b');

      // The OLD control request rejects now: the diagnostic carries the
      // frozen attempt identity (old epoch), and nothing on the new scope
      // moves — no close, no cancel, no interrupt of turn-lr-b.
      rejectStop(new Error('StopTaskError: agent not found'));
      await flushMicrotasks();
      for (let i = 0; i < 30; i += 1) await Promise.resolve();

      expect((service as any).runtimeTurns.get('turn-lr-b')?.phase).toBe('collecting');
      expect(messageChannel.getActiveTurnId()).toBe('turn-lr-b');
      const phases = await readDiagnosticPhases(diagDir);
      const rejectOutcome = phases.find(entry => entry.phase === 'stop_task_outcome' && entry.outcome === 'error');
      expect(rejectOutcome).toMatchObject({ queryEpoch: oldEpoch });
      expect(phases.some(entry => entry.phase === 'query_close')).toBe(false);
      const nextQuery = sdkMock.getLastResponse()!;
      expect(nextQuery.interrupt).not.toHaveBeenCalled();
      nextQuery.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'next own result' });
      await flushMicrotasks();
      await service.completeUserTurnProjection('turn-lr-b');
      expect((await genB.next()).value).toEqual({ type: 'done' });
    });
  });
});
