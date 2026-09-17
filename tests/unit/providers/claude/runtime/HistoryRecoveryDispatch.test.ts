import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import type { McpServerManager } from '@/core/mcp/McpServerManager';
import type { ChatMessage } from '@/core/types';
import type ClaudianPlugin from '@/main';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { MessageChannel } from '@/providers/claude/runtime/ClaudeMessageChannel';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  resetMockMessages: () => void;
  query: typeof sdkModule.query;
};

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

async function startPersistentQuery(service: ClaudianService): Promise<void> {
  const startSpy = jest.spyOn(service as any, 'startPersistentQuery');
  startSpy.mockImplementation(async (...args: unknown[]) => {
    const [vaultPath, cliPath] = args as [string, string];
    const messageChannel = new MessageChannel();
    (service as any).messageChannel = messageChannel;
    (service as any).persistentQuery = sdkMock.query({
      prompt: messageChannel,
      options: { cwd: vaultPath, pathToClaudeCodeExecutable: cliPath } as any,
    });
    (service as any).currentConfig = (service as any).buildPersistentQueryConfig(vaultPath, cliPath, []);
    (service as any).startResponseConsumer();
  });
  await service.ensureReady();
}

async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

function assistantMessage(text: string): any {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

/** Arms the recovery state machine to `pending` via a non-fork session jump. */
async function armPendingRecovery(service: ClaudianService): Promise<void> {
  service.setSessionId('old-session');
  await (service as any).routeMessage({ type: 'system', subtype: 'init', session_id: 'new-session' });
  expect((service as any).sessionManager.needsHistoryRebuild()).toBe(true);
}

function recoveryHistory(): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'earlier question', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'earlier answer', timestamp: 2 },
  ];
}

describe('ClaudianService - history recovery dispatch lifecycle', () => {
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

  it('confirms recovery to idle when the dispatched turn completes with a matching success result', async () => {
    await armPendingRecovery(service);
    sdkMock.setMockMessages([
      assistantMessage('restored reply'),
      { type: 'result', subtype: 'success', session_id: 'new-session' },
    ]);
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'recovery-ok', text: 'continue' });
    const chunks = await collectChunks(service.query(turn, recoveryHistory()));

    expect(chunks.some(c => c.type === 'done')).toBe(true);
    expect((service as any).sessionManager.getHistoryRecoveryState().status).toBe('idle');
  });

  it('returns to pending (attempts+1) when a recovery turn is cancelled, then re-injects and confirms to idle', async () => {
    await armPendingRecovery(service);
    // No trailing result: the turn must stay in flight until we cancel it.
    sdkMock.setMockMessages([assistantMessage('partial reply')], { appendResult: false });
    await startPersistentQuery(service);

    const turn = service.prepareTurn({ turnId: 'recovery-cancel-1', text: 'continue' });
    const gen = service.query(turn, recoveryHistory());
    const first = await gen.next();
    expect(first.value?.type).toBe('text');
    expect((service as any).sessionManager.getHistoryRecoveryState().status).toBe('awaiting_result');

    // User cancels the in-flight recovery turn.
    service.cancel();
    await collectChunks(gen);

    // v3 §2.1: a cancelled dispatch can never be confirmed (its trailing
    // result is dropped by the cancelled-phase gate), so it must fail back to
    // pending while the attempt budget lasts — not stick in awaiting_result.
    const afterCancel = (service as any).sessionManager.getHistoryRecoveryState();
    expect(afterCancel.status).toBe('pending');
    expect(afterCancel.attempts).toBe(1);

    // The recovery stays usable: the next turn re-injects and a matching
    // success result confirms the recovery.
    sdkMock.setMockMessages([
      assistantMessage('restored reply'),
      { type: 'result', subtype: 'success', session_id: 'new-session' },
    ]);
    const secondTurn = service.prepareTurn({ turnId: 'recovery-cancel-2', text: 'next' });
    const chunks = await collectChunks(service.query(secondTurn, recoveryHistory()));

    expect(chunks.some(c => c.type === 'done')).toBe(true);
    expect((service as any).sessionManager.getHistoryRecoveryState().status).toBe('idle');
  });

  it('trips after the recovery attempt budget is exhausted by cancellations', async () => {
    await armPendingRecovery(service);
    sdkMock.setMockMessages([assistantMessage('partial reply')], { appendResult: false });
    await startPersistentQuery(service);

    for (let i = 1; i <= 2; i++) {
      const turn = service.prepareTurn({ turnId: `recovery-trip-${i}`, text: 'hi' });
      const gen = service.query(turn, recoveryHistory());
      await gen.next();
      service.cancel();
      await collectChunks(gen);
    }

    expect((service as any).sessionManager.getHistoryRecoveryState().status).toBe('tripped');
  });

  it('fails the recovery dispatch when a cold-start recovery turn is aborted mid-stream', async () => {
    await armPendingRecovery(service);
    sdkMock.setMockMessages([assistantMessage('partial reply')], { appendResult: false });

    const turn = service.prepareTurn({ turnId: 'recovery-cold-abort', text: 'continue' });
    const gen = service.query(turn, recoveryHistory(), { forceColdStart: true });

    // The first next() runs synchronously up to the SDK await: the dispatch
    // is armed (awaiting_result) and the runtime abortController is wired.
    const pending = gen.next();
    expect((service as any).sessionManager.getHistoryRecoveryState().status).toBe('awaiting_result');
    (service as any).abortController.abort();

    // The loop sees the aborted signal on the first SDK message and breaks
    // out normally — no catch, no result — so the dispatch must fail there.
    await pending;
    await collectChunks(gen);

    expect((service as any).sessionManager.getHistoryRecoveryState().status).toBe('pending');
  });
});
