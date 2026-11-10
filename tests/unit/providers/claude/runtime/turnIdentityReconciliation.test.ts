import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import type { AppAgentManager, AppPluginManager } from '@/core/providers/types';
import type ClaudianPlugin from '@/main';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { MessageChannel } from '@/providers/claude/runtime/ClaudeMessageChannel';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  resetMockMessages: () => void;
  query: typeof sdkModule.query;
};

function makeMockPlugin(): ClaudianPlugin {
  return {
    app: { vault: { adapter: { basePath: '/mock/vault/path' } } },
    storage: {},
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
    pluginManager: { getPluginsKey: jest.fn().mockReturnValue('') },
  } as unknown as ClaudianPlugin;
}

function makeService(): ClaudianService {
  const plugin = makeMockPlugin();
  return new ClaudianService(plugin, {
    pluginManager: (plugin as unknown as { pluginManager: AppPluginManager }).pluginManager,
    agentManager: (plugin as unknown as { agentManager: AppAgentManager }).agentManager,
  });
}

async function startPersistentQuery(service: ClaudianService): Promise<MessageChannel> {
  const startSpy = jest.spyOn(service as any, 'startPersistentQuery');
  startSpy.mockImplementation(async (...args: unknown[]) => {
    const [vaultPath, cliPath] = args as [string, string];
    // Wire the real dequeue callback so the reconciliation bypass sees
    // dispatches, unlike the lease harness which drives the channel manually.
    const messageChannel = new MessageChannel(undefined, info => (service as any).handleTurnDequeued(info));
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

async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Tiny poll helper for asynchronously-settled runtime state. */
async function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return true;
}

describe('Turn identity reconciliation wiring (batch 1 observe bypass)', () => {
  let service: ClaudianService;

  beforeEach(() => {
    jest.clearAllMocks();
    sdkMock.resetMockMessages();
    service = makeService();
  });

  afterEach(() => {
    service.cleanup();
    sdkMock.resetMockMessages();
  });

  it('records reserved → dispatched → settled for a persistent send, without observer evidence', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'recon-session' },
      ...[{ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } }],
    ]);
    await startPersistentQuery(service);
    const reconciliation = (service as any).turnReconciliation;
    const reservedSpy = jest.spyOn(reconciliation, 'recordReserved');

    const turn = service.prepareTurn({ turnId: 'recon-turn-1', text: 'hello' });
    const chunks = await collectChunks(service.query(turn));

    expect(chunks.some(chunk => chunk.type === 'done')).toBe(true);
    expect(reservedSpy).toHaveBeenCalledWith('recon-turn-1', expect.any(String));
    // The mock harness has no transcript file, so the observer track cannot
    // match: the dispatch is eligible and settles host_only.
    expect(await pollUntil(() => reconciliation.getStats().eligibleHostTurns === 1)).toBe(true);
    expect(reconciliation.getStats()).toEqual(expect.objectContaining({
      eligibleHostTurns: 1,
      matchedHostTurns: 0,
      hostUnmatchedTurns: 1,
      identityConflicts: 0,
    }));
  });

  it('binds a dispatched canonical UUID that the observer track later observes', async () => {
    await startPersistentQuery(service);
    const reconciliation = (service as any).turnReconciliation;

    // The channel dequeue hook reports the canonical identity…
    (service as any).handleTurnDequeued({
      leaseTurnId: 'recon-turn-2',
      canonicalTurnId: 'uuid-recon-2',
      hostTurnIds: ['recon-turn-2'],
    });
    // …and the observer track's observed_start fact matches it.
    const verdict = reconciliation.recordObservedStart({ canonicalTurnId: 'uuid-recon-2', lineOffset: 42 });

    expect(verdict).toEqual({ kind: 'host_mirror', canonicalTurnId: 'uuid-recon-2' });
    expect(reconciliation.getStats()).toEqual(expect.objectContaining({
      eligibleHostTurns: 1,
      matchedHostTurns: 1,
      hostUnmatchedTurns: 0,
    }));
  });

  it('consults the result-echo binding when the CLI result carries turn uuids', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'echo-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
      {
        type: 'result',
        subtype: 'success',
        user_message_uuid: 'uuid-echo-1',
        user_message_uuids: ['uuid-echo-1'],
        queued_turn_count: 0,
        result_index: 0,
      },
    ], { appendResult: false });
    await startPersistentQuery(service);
    jest.spyOn(service as any, 'buildSDKUserMessage').mockReturnValue({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      session_id: 'echo-session',
      uuid: 'uuid-echo-1',
    });
    const reconcileSpy = jest.spyOn((service as any).turnReconciliation, 'recordResultEcho');

    const turn = service.prepareTurn({ turnId: 'echo-turn-1', text: 'hello' });
    const chunks = await collectChunks(service.query(turn));

    expect(chunks.some(chunk => chunk.type === 'done')).toBe(true);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledWith({
      leaseTurnId: 'echo-turn-1',
      consumedUuids: ['uuid-echo-1'],
      queuedTurnCount: 0,
      resultIndex: 0,
    });
    expect((service as any).turnReconciliation.getResultEchoStats()).toEqual({
      consulted: 1,
      bound: 1,
      mismatch: 0,
      unbound: 0,
    });
  });

  it('falls back to the existing binding heuristic when the result carries no echo (old CLI)', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'echo-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
      { type: 'result', subtype: 'success' },
    ], { appendResult: false });
    await startPersistentQuery(service);
    const reconcileSpy = jest.spyOn((service as any).turnReconciliation, 'recordResultEcho');

    const turn = service.prepareTurn({ turnId: 'echo-turn-2', text: 'hello' });
    const chunks = await collectChunks(service.query(turn));

    expect(chunks.some(chunk => chunk.type === 'done')).toBe(true);
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect((service as any).turnReconciliation.getResultEchoStats().consulted).toBe(0);
  });

  it('does not consult when the frame carries counters but no uuid echo (CLI >= 2.1.303 shape)', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'echo-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
      { type: 'result', subtype: 'success', queued_turn_count: 0, result_index: 4 },
    ], { appendResult: false });
    await startPersistentQuery(service);
    const reconcileSpy = jest.spyOn((service as any).turnReconciliation, 'recordResultEcho');

    const turn = service.prepareTurn({ turnId: 'echo-turn-4', text: 'hello' });
    const chunks = await collectChunks(service.query(turn));

    expect(chunks.some(chunk => chunk.type === 'done')).toBe(true);
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect((service as any).turnReconciliation.getResultEchoStats().consulted).toBe(0);
  });

  it('never lets a failing echo consultation break settlement', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'echo-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } },
      { type: 'result', subtype: 'success', user_message_uuid: 'uuid-echo-3' },
    ], { appendResult: false });
    await startPersistentQuery(service);
    jest.spyOn((service as any).turnReconciliation, 'recordResultEcho')
      .mockImplementation(() => { throw new Error('boom'); });

    const turn = service.prepareTurn({ turnId: 'echo-turn-3', text: 'hello' });
    const chunks = await collectChunks(service.query(turn));

    expect(chunks.some(chunk => chunk.type === 'done')).toBe(true);
  });

  it('advances the session generation on session switch and reset', async () => {
    await startPersistentQuery(service);
    const reconciliation = (service as any).turnReconciliation;
    (service as any).handleTurnDequeued({
      leaseTurnId: 'turn-old',
      canonicalTurnId: 'uuid-old',
      hostTurnIds: ['turn-old'],
    });

    service.setSessionId('another-session');
    const verdict = reconciliation.recordObservedStart({ canonicalTurnId: 'uuid-old' });

    expect(verdict).toEqual({ kind: 'external_new', canonicalTurnId: 'uuid-old' });
  });
});
