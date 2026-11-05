import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
  getLastResponse: () => (AsyncGenerator<any> & { interrupt: jest.Mock; stopTask: jest.Mock }) | null;
};

const RESULT_WATCHDOG_MS = 120_000;
const RESULT_WATCHDOG_GRACE_MS = 15_000;
const STOP_TASK_GRACE_MS = 15_000;
const STOP_TASK_TURN_SILENCE_MS = 30 * 60_000;
const STOP_TASK_AGENT_MIN_AGE_MS = 2 * 60 * 60 * 1000;

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

/** Real MessageChannel + mock SDK query, mirroring turnLeaseRelease.test.ts. */
async function startPersistentQuery(service: ClaudianService): Promise<MessageChannel> {
  const startSpy = jest.spyOn(service as any, 'startPersistentQuery');
  startSpy.mockImplementation(async (...args: unknown[]) => {
    const [vaultPath, cliPath] = args as [string, string];
    const messageChannel = new MessageChannel(() => {}, info => (service as any).handleTurnDequeued(info));
    (service as any).messageChannel = messageChannel;
    (service as any).persistentQuery = sdkMock.query({
      prompt: messageChannel,
      options: { cwd: vaultPath, pathToClaudeCodeExecutable: cliPath } as any,
    });
    (service as any).currentConfig = (service as any).buildPersistentQueryConfig(vaultPath, cliPath, []);
    (service as any).startResponseConsumer();
  });
  await service.ensureReady();
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
  let sessionPathSpy: jest.SpyInstance;

  beforeEach(async () => {
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
    sessionPathSpy = jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(transcriptFile);
  });

  afterEach(async () => {
    jest.useRealTimers();
    sessionPathSpy.mockRestore();
    service.cleanup();
    sdkMock.resetMockMessages();
    await rm(dir, { recursive: true, force: true });
  });

  async function driveObserverTick(): Promise<void> {
    const observer = (service as any).transcriptObserver;
    const reader = observer.reader;
    const batch = await reader.readAvailable();
    await observer.consumeBatch(batch, observer.generation);
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
    await flushMicrotasks();

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
    expect(channel.getQueueLength()).toBe(0);
    expect(channel.getActiveTurnId()).toBe('turn-q1');
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
    await flushMicrotasks();
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
    await flushMicrotasks();
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
    await flushMicrotasks();
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
    await flushMicrotasks();
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
    await flushMicrotasks();
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
    await flushMicrotasks();
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
    await flushMicrotasks();
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

  describe('B-(a) stopTask before interrupt (armed watchdog path)', () => {
    function stubRunningAgents(service: ClaudianService, agents: Array<{ agentId: string; startedAt: number }>): void {
      service.setSubagentHookProvider(() => ({ hasRunning: agents.length > 0, runningAgents: agents }));
    }

    async function armTerminalEvidence(service: ClaudianService, turnId: string): Promise<void> {
      service.beginUserTurnProjection(turnId);
      await flushMicrotasks();
      const uuid = (service as any).lastSentMessage.uuid as string;
      (service as any).transcriptObserver.registerHostUserTranscriptId(uuid);
      await appendFile(transcriptFile, hostUserRowLine(uuid) + hostTerminalRows());
      await driveObserverTick();
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
      const routedResult = (service as any).routeMessage({ type: 'result', subtype: 'success', result: 'ok' });
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
      await routedResult;
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
        if (agentId === 'blocked-control') return new Promise<void>(() => {});
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
      await flushMicrotasks();
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
      await flushMicrotasks();
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
      await flushMicrotasks();
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
      service.setApprovalCallback(() => new Promise(resolve => { resolveApproval = resolve; }));
      const approvalWait = (service as any).createApprovalCallback()('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'guard-tool' });

      const turn = service.prepareTurn({ turnId: 'turn-approval-guard', text: 'hello' });
      const gen = service.query(turn);
      await gen.next();
      service.beginUserTurnProjection('turn-approval-guard');
      await flushMicrotasks();
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
      await flushMicrotasks();
      void gen.next();
      await flushMicrotasks();

      await jest.advanceTimersByTimeAsync(STOP_TASK_TURN_SILENCE_MS + RESULT_WATCHDOG_MS);
      await flushMicrotasks();

      expect(sdkMock.getLastResponse()?.stopTask).not.toHaveBeenCalled();
      expect((service as any).runtimeTurns.has('turn-young-agent')).toBe(true);
    });
  });
});
