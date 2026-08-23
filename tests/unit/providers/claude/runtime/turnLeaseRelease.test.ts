import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import type { McpServerManager } from '@/core/mcp/McpServerManager';
import { TurnCoordinator } from '@/features/chat/controllers/TurnCoordinator';
import { ChatState } from '@/features/chat/state/ChatState';
import type ClaudianPlugin from '@/main';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { MessageChannel } from '@/providers/claude/runtime/ClaudeMessageChannel';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  resetMockMessages: () => void;
  query: typeof sdkModule.query;
  getQueryCallCount: () => number;
};

const LOOPS = 20;

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
 * Starts a real persistent query (real MessageChannel + mock SDK query),
 * mirroring the harness pattern in ClaudianService.test.ts. Extra options
 * (e.g. PreToolUse hooks) are forwarded into the mock SDK options.
 */
async function startPersistentQuery(
  service: ClaudianService,
  extraOptions: Record<string, unknown> = {},
): Promise<MessageChannel> {
  const startSpy = jest.spyOn(service as any, 'startPersistentQuery');
  startSpy.mockImplementation(async (...args: unknown[]) => {
    const [vaultPath, cliPath] = args as [string, string];
    const messageChannel = new MessageChannel();
    (service as any).messageChannel = messageChannel;
    (service as any).persistentQuery = sdkMock.query({
      prompt: messageChannel,
      options: { cwd: vaultPath, pathToClaudeCodeExecutable: cliPath, ...extraOptions } as any,
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

function runtimeLeasesEmpty(service: ClaudianService): boolean {
  const channel = (service as any).messageChannel as MessageChannel | null;
  const activeTurnId = channel?.getActiveTurnId() ?? null;
  const turnCount = (service as any).runtimeTurns.size as number;
  return activeTurnId === null && turnCount === 0;
}

/** Settle is asynchronous relative to the generator's done chunk: poll briefly. */
async function waitForRuntimeLeasesEmpty(service: ClaudianService, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!runtimeLeasesEmpty(service)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `runtime leases not empty after ${timeoutMs}ms: activeTurnId=${((service as any).messageChannel as MessageChannel | null)?.getActiveTurnId() ?? null}, runtimeTurns=${(service as any).runtimeTurns.size}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function mockAssistantMessages(text: string): any[] {
  return [
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
  ];
}

describe('ClaudianService - turn-lease hotfix (fix 6 + stress loops)', () => {
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

  it('clears both layer leases on an unregistered dequeue (fix 6)', async () => {
    await startPersistentQuery(service);

    const coordinator = new TurnCoordinator({
      state: new ChatState(),
      getConversationId: () => 'conv-1',
      processQueuedMessage: jest.fn(),
    });
    service.setOnUnregisteredTurnDequeued(turnId => coordinator.cancelTurnFromRuntime(turnId));

    // A queued message dequeues for a turn the runtime no longer knows: the
    // channel lease was signed, the registry entry is gone, but the feature
    // layer still holds the lease for the same turnId.
    const channel = (service as any).messageChannel as MessageChannel;
    expect(channel.beginExternalTurn('ghost-turn').ok).toBe(true);
    expect(coordinator.beginUserTurn('ghost-turn', 1)).toBe(true);

    (service as any).handleTurnDequeued('ghost-turn');

    expect(channel.getActiveTurnId()).toBeNull();
    expect(coordinator.isBusy()).toBe(false);
  });

  it('unregistered dequeue without a feature lease leaves everything idle', async () => {
    await startPersistentQuery(service);
    const notified: string[] = [];
    service.setOnUnregisteredTurnDequeued(turnId => notified.push(turnId));

    (service as any).handleTurnDequeued('ghost-alone');

    expect(notified).toEqual(['ghost-alone']);
    expect(((service as any).messageChannel as MessageChannel).getActiveTurnId()).toBeNull();
    expect((service as any).runtimeTurns.size).toBe(0);
  });

  describe('stress loops (each scenario × 20)', () => {
    it('new-session first turn: leases empty after every send', async () => {
      for (let i = 0; i < LOOPS; i++) {
        const svc = makeService();
        sdkMock.setMockMessages([
          { type: 'system', subtype: 'init', session_id: `fresh-${i}` },
          ...mockAssistantMessages(`first reply ${i}`),
        ]);
        await startPersistentQuery(svc);

        const turn = svc.prepareTurn({ turnId: `first-turn-${i}`, text: 'hello' });
        const chunks = await collectChunks(svc.query(turn));
        expect(chunks.some(c => c.type === 'done')).toBe(true);
        await waitForRuntimeLeasesEmpty(svc);

        svc.cleanup();
      }
    }, 20000);

    it('ten consecutive turns on one session: leases empty after every turn', async () => {
      for (let loop = 0; loop < LOOPS; loop++) {
        const svc = makeService();
        sdkMock.setMockMessages(mockAssistantMessages(`reply ${loop}`));
        await startPersistentQuery(svc);

        for (let i = 0; i < 10; i++) {
          const turn = svc.prepareTurn({ turnId: `turn-${loop}-${i}`, text: `message ${i}` });
          const chunks = await collectChunks(svc.query(turn));
          expect(chunks.some(c => c.type === 'done')).toBe(true);
          await waitForRuntimeLeasesEmpty(svc);
        }

        svc.cleanup();
      }
    }, 60000);

    it('tool block then allow: leases empty after every block→allow cycle', async () => {
      for (let i = 0; i < LOOPS; i++) {
        const svc = makeService();
        // Block the first tool call, allow the second — the block→allow
        // sequence the SDK mock harness can drive (PreToolUse hook path).
        let blockedOnce = false;
        const blockFirstTool = async () => {
          if (blockedOnce) return { continue: true };
          blockedOnce = true;
          return { continue: false, hookSpecificOutput: { permissionDecisionReason: 'blocked once' } };
        };
        sdkMock.setMockMessages([
          { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-blocked-${i}`, name: 'Bash', input: { command: 'ls' } }] } },
          { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-allowed-${i}`, name: 'Bash', input: { command: 'pwd' } }] } },
        ]);
        await startPersistentQuery(svc, {
          hooks: { PreToolUse: [{ hooks: [blockFirstTool as any] }] },
        });

        const turn = svc.prepareTurn({ turnId: `block-allow-${i}`, text: 'run tools' });
        const chunks = await collectChunks(svc.query(turn));
        expect(chunks.some(c => c.type === 'done')).toBe(true);
        // First tool call blocked (notice chunk), second allowed — both tool
        // uses projected, then the turn settled.
        expect(chunks.filter(c => c.type === 'tool_use')).toHaveLength(2);
        expect(chunks.some(c => c.type === 'notice')).toBe(true);
        await waitForRuntimeLeasesEmpty(svc);

        svc.cleanup();
      }
    }, 20000);

    it('resume on an existing session: leases empty after every resumed turn', async () => {
      for (let i = 0; i < LOOPS; i++) {
        const svc = makeService();
        svc.setSessionId(`resume-session-${i}`);
        sdkMock.setMockMessages([
          { type: 'system', subtype: 'init', session_id: `resume-session-${i}` },
          ...mockAssistantMessages(`resumed reply ${i}`),
        ]);
        await startPersistentQuery(svc);

        const history = [
          { id: `u-${i}`, role: 'user' as const, content: 'earlier question', timestamp: 1 },
          { id: `a-${i}`, role: 'assistant' as const, content: 'earlier answer', timestamp: 2 },
        ];
        const turn = svc.prepareTurn({ turnId: `resume-turn-${i}`, text: 'continue' });
        const chunks = await collectChunks(svc.query(turn, history));
        expect(chunks.some(c => c.type === 'done')).toBe(true);
        await waitForRuntimeLeasesEmpty(svc);

        svc.cleanup();
      }
    }, 20000);

    it('deferred restart executes after settle and leaves leases empty', async () => {
      for (let i = 0; i < LOOPS; i++) {
        const svc = makeService();
        sdkMock.setMockMessages(mockAssistantMessages(`deferred reply ${i}`));
        await startPersistentQuery(svc);

        // A config restart was deferred while a turn was mid-flight.
        (svc as any).deferredRestartPaths = ['/extra/context'];
        const queryCallsBefore = sdkMock.getQueryCallCount();

        const turn = svc.prepareTurn({ turnId: `deferred-turn-${i}`, text: 'hello' });
        const chunks = await collectChunks(svc.query(turn));
        expect(chunks.some(c => c.type === 'done')).toBe(true);
        await waitForRuntimeLeasesEmpty(svc);

        // The deferred restart ran (a fresh persistent query spawned) and
        // its deferred path was consumed.
        expect(sdkMock.getQueryCallCount()).toBe(queryCallsBefore + 1);
        expect((svc as any).deferredRestartPaths).toBeNull();

        svc.cleanup();
      }
    }, 20000);
  });
});
