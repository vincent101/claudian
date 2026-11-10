import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { Notice } from 'obsidian';

import type { AppAgentManager, AppPluginManager } from '@/core/providers/types';
import type ClaudianPlugin from '@/main';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { MessageChannel } from '@/providers/claude/runtime/ClaudeMessageChannel';
import { createResponseHandler, createRuntimeTurn } from '@/providers/claude/runtime/types';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  resetMockMessages: () => void;
  query: typeof sdkModule.query;
  getLastResponse: () => (AsyncGenerator<any> & { interrupt: jest.Mock }) | null;
};

const INTERRUPT_ACK_WATCHDOG_MS = 5_000;

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
  return (service as any).messageChannel as MessageChannel;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/** Live leased user turn holding the channel lease, mirroring the existing
 * cancel-settlement harness in ClaudianService.test.ts. */
function installLiveUserTurn(service: ClaudianService, turnId: string): { onDone: jest.Mock } {
  const channel = (service as any).messageChannel as MessageChannel;
  const turn = createRuntimeTurn({ id: turnId, kind: 'user', phase: 'collecting' });
  const onDone = jest.fn();
  const handler = createResponseHandler({
    id: `handler-${turnId}`,
    onChunk: jest.fn(),
    onDone,
    onError: jest.fn(),
  });
  turn.waiters.add(handler);
  (service as any).runtimeTurns.set(turnId, turn);
  channel.beginExternalTurn(turnId);
  return { onDone };
}

describe('ClaudianService - P0-3 interrupt acknowledgement escalation', () => {
  let service: ClaudianService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    sdkMock.resetMockMessages();
    service = makeService();
    // The projection-barrier path keeps the runtime turn alive behind the
    // feature acknowledgement — the shape an unacknowledged interrupt leaves.
    service.setOnAutoTurnStarted(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
    service.cleanup();
    sdkMock.resetMockMessages();
  });

  it('T2: an unacknowledged interrupt re-interrupts after 5s and surfaces a notice', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'ack-session' },
    ], { appendResult: false });
    await startPersistentQuery(service);
    installLiveUserTurn(service, 'user-t2');

    service.cancel();
    const query = sdkMock.getLastResponse();
    expect(query?.interrupt).toHaveBeenCalledTimes(1);
    // The turn stays registered behind the pending projection acknowledgement.
    expect((service as any).runtimeTurns.has('user-t2')).toBe(true);

    await jest.advanceTimersByTimeAsync(INTERRUPT_ACK_WATCHDOG_MS);

    expect(query?.interrupt).toHaveBeenCalledTimes(2);
    expect(Notice).toHaveBeenCalledWith(expect.any(String));
    expect((service as any).runtimeTurns.has('user-t2')).toBe(true);
  });

  it('no escalation when the projection acknowledgement clears the turn within the window', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'ack-session' },
    ], { appendResult: false });
    await startPersistentQuery(service);
    installLiveUserTurn(service, 'user-ack');

    service.cancel();
    await service.completeUserTurnProjection('user-ack');
    expect((service as any).runtimeTurns.has('user-ack')).toBe(false);

    await jest.advanceTimersByTimeAsync(INTERRUPT_ACK_WATCHDOG_MS);

    const query = sdkMock.getLastResponse();
    expect(query?.interrupt).toHaveBeenCalledTimes(1);
    expect(Notice).not.toHaveBeenCalled();
  });

  it('no escalation when the CLI responds (trailing result) but the feature projection lags past the window (reviewer #3)', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'ack-session' },
    ], { appendResult: false });
    await startPersistentQuery(service);
    installLiveUserTurn(service, 'user-ack-lag');

    service.cancel();
    const query = sdkMock.getLastResponse();
    expect(query?.interrupt).toHaveBeenCalledTimes(1);

    // The CLI acknowledges the interrupt by flushing its trailing result.
    // The cancelled-phase gate drops it, but the routing evidence proves
    // the CLI responded — Esc worked, only the feature close-out is slow.
    await (service as any).routeMessage({ type: 'result', subtype: 'error_during_execution', is_error: true });
    await flushMicrotasks();

    await jest.advanceTimersByTimeAsync(INTERRUPT_ACK_WATCHDOG_MS);

    expect(query?.interrupt).toHaveBeenCalledTimes(1);
    expect(Notice).not.toHaveBeenCalled();
    // The turn is still registered behind the pending projection
    // acknowledgement — exactly the shape the old criterion misjudged.
    expect((service as any).runtimeTurns.has('user-ack-lag')).toBe(true);
  });

  it('no escalation when post-interrupt chunks arrive but the projection lags', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'ack-session' },
    ], { appendResult: false });
    await startPersistentQuery(service);
    installLiveUserTurn(service, 'user-chunk-lag');

    service.cancel();
    const query = sdkMock.getLastResponse();

    // A trailing assistant chunk flushes after the interrupt.
    await (service as any).routeMessage({
      type: 'assistant',
      uuid: 'post-interrupt-a1',
      message: { id: 'post-interrupt-m1', role: 'assistant', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    });
    await flushMicrotasks();

    await jest.advanceTimersByTimeAsync(INTERRUPT_ACK_WATCHDOG_MS);

    expect(query?.interrupt).toHaveBeenCalledTimes(1);
    expect(Notice).not.toHaveBeenCalled();
    expect((service as any).runtimeTurns.has('user-chunk-lag')).toBe(true);
  });

  it('no escalation without a live persistent query', async () => {
    sdkMock.setMockMessages([
      { type: 'system', subtype: 'init', session_id: 'ack-session' },
    ], { appendResult: false });
    await startPersistentQuery(service);
    installLiveUserTurn(service, 'user-noquery');
    (service as any).persistentQuery = null;

    service.cancel();

    await jest.advanceTimersByTimeAsync(INTERRUPT_ACK_WATCHDOG_MS);
    expect(Notice).not.toHaveBeenCalled();
  });
});
