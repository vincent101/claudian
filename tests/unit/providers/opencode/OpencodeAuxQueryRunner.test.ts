import '@/providers';

import { AcpClientConnection, AcpJsonRpcTransport, AcpSubprocess } from '@/providers/acp';
import { OpencodeAuxQueryRunner } from '@/providers/opencode/runtime/OpencodeAuxQueryRunner';
import { prepareOpencodeLaunchArtifacts } from '@/providers/opencode/runtime/OpencodeLaunchArtifacts';

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  return {
    ...actual,
    AcpClientConnection: jest.fn(),
    AcpJsonRpcTransport: jest.fn(),
    AcpSubprocess: jest.fn(),
  };
});

jest.mock('@/providers/opencode/runtime/OpencodeLaunchArtifacts', () => {
  const actual = jest.requireActual('@/providers/opencode/runtime/OpencodeLaunchArtifacts');
  return {
    ...actual,
    prepareOpencodeLaunchArtifacts: jest.fn(),
  };
});

const MockAcpClientConnection = AcpClientConnection as jest.MockedClass<typeof AcpClientConnection>;
const MockAcpJsonRpcTransport = AcpJsonRpcTransport as jest.MockedClass<typeof AcpJsonRpcTransport>;
const MockAcpSubprocess = AcpSubprocess as jest.MockedClass<typeof AcpSubprocess>;
const mockPrepareOpencodeLaunchArtifacts = prepareOpencodeLaunchArtifacts as jest.MockedFunction<typeof prepareOpencodeLaunchArtifacts>;

const MOCK_LAUNCH_ARTIFACTS = {
  configPath: '/tmp/claudian-opencode-aux/config.json',
  configContent: '{"default_agent":"claudian-aux-passive"}\n',
  databasePath: null,
  launchKey: 'launch-key',
  systemPromptPath: '/tmp/claudian-opencode-aux/system.md',
};

type LaunchArtifacts = Awaited<ReturnType<typeof prepareOpencodeLaunchArtifacts>>;

interface MockTriplet {
  connection: {
    cancel: jest.Mock;
    dispose: jest.Mock;
    initialize: jest.Mock;
    newSession: jest.Mock;
    onSessionNotification: jest.Mock;
    prompt: jest.Mock;
    setConfigOption: jest.Mock;
  };
  process: {
    getStderrSnapshot: jest.Mock;
    isAlive: jest.Mock;
    onClose: jest.Mock;
    shutdown: jest.Mock;
    start: jest.Mock;
    stdin: Record<string, never>;
    stdout: Record<string, never>;
  };
  transport: {
    dispose: jest.Mock;
    start: jest.Mock;
  };
}

function createMockTriplet(params: { sessionId: string; replyText: string }): MockTriplet {
  const notificationListeners: Array<(notification: any) => void> = [];
  const connection = {
    cancel: jest.fn(),
    dispose: jest.fn(),
    initialize: jest.fn().mockResolvedValue({}),
    newSession: jest.fn().mockResolvedValue({ sessionId: params.sessionId }),
    onSessionNotification: jest.fn((listener: (notification: any) => void) => {
      notificationListeners.push(listener);
      return () => {
        const index = notificationListeners.indexOf(listener);
        if (index !== -1) {
          notificationListeners.splice(index, 1);
        }
      };
    }),
    prompt: jest.fn().mockImplementation(async () => {
      for (const listener of [...notificationListeners]) {
        await listener({
          sessionId: params.sessionId,
          update: {
            content: { text: params.replyText, type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
      }
      return { stopReason: 'end_turn' };
    }),
    setConfigOption: jest.fn().mockResolvedValue({ configOptions: [] }),
  };
  const process = {
    getStderrSnapshot: jest.fn().mockReturnValue(''),
    isAlive: jest.fn().mockReturnValue(true),
    onClose: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
    start: jest.fn(),
    stdin: {},
    stdout: {},
  };
  const transport = {
    dispose: jest.fn(),
    start: jest.fn(),
  };
  return { connection, process, transport };
}

const flushTicks = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};


function createMockPlugin(settings: Record<string, unknown> = {}) {
  return {
    settings: {
      model: 'opencode:openai/gpt-5',
      providerConfigs: {
        opencode: {
          enabled: true,
        },
      },
      settingsProvider: 'opencode',
      ...settings,
    },
    manifest: { version: '0.0.0-test' },
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/opencode'),
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/claudian-test-vault',
        },
      },
    },
  } as any;
}

describe('OpencodeAuxQueryRunner', () => {
  let mockConnection: {
    cancel: jest.Mock;
    dispose: jest.Mock;
    initialize: jest.Mock;
    newSession: jest.Mock;
    onSessionNotification: jest.Mock;
    prompt: jest.Mock;
    setConfigOption: jest.Mock;
  };
  let mockProcess: {
    getStderrSnapshot: jest.Mock;
    isAlive: jest.Mock;
    onClose: jest.Mock;
    shutdown: jest.Mock;
    start: jest.Mock;
    stdin: Record<string, never>;
    stdout: Record<string, never>;
  };
  let mockTransport: {
    dispose: jest.Mock;
    start: jest.Mock;
  };
  let sessionNotificationListener: ((notification: any) => void | Promise<void>) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionNotificationListener = null;

    mockConnection = {
      cancel: jest.fn(),
      dispose: jest.fn(),
      initialize: jest.fn().mockResolvedValue({}),
      newSession: jest.fn().mockResolvedValue({ sessionId: 'session-1' }),
      onSessionNotification: jest.fn((listener) => {
        sessionNotificationListener = listener;
        return jest.fn();
      }),
      prompt: jest.fn().mockImplementation(async () => {
        await sessionNotificationListener?.({
          sessionId: 'session-1',
          update: {
            content: { text: 'Fix title', type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        await sessionNotificationListener?.({
          sessionId: 'session-1',
          update: {
            content: { text: ' now', type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        return { stopReason: 'end_turn' };
      }),
      setConfigOption: jest.fn().mockResolvedValue({ configOptions: [] }),
    };
    mockProcess = {
      getStderrSnapshot: jest.fn().mockReturnValue(''),
      isAlive: jest.fn().mockReturnValue(true),
      onClose: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
      start: jest.fn(),
      stdin: {},
      stdout: {},
    };
    mockTransport = {
      dispose: jest.fn(),
      start: jest.fn(),
    };

    MockAcpClientConnection.mockImplementation(() => mockConnection as any);
    MockAcpJsonRpcTransport.mockImplementation(() => mockTransport as any);
    MockAcpSubprocess.mockImplementation(() => mockProcess as any);
    mockPrepareOpencodeLaunchArtifacts.mockResolvedValue(MOCK_LAUNCH_ARTIFACTS);
  });

  it('launches an auxiliary ACP session and streams assistant text', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });
    const onTextChunk = jest.fn();

    await expect(runner.query({
      onTextChunk,
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(mockPrepareOpencodeLaunchArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      artifactsSubdir: 'opencode/aux/title-gen',
      defaultAgentId: 'claudian-aux-passive',
      managedAgents: [expect.objectContaining({ id: 'claudian-aux-passive' })],
      systemPromptKey: 'Use this custom system prompt.',
      systemPromptText: 'Use this custom system prompt.',
    }));
    expect(mockConnection.newSession).toHaveBeenCalledWith({
      cwd: '/tmp/claudian-test-vault',
      mcpServers: [],
    });
    expect(mockConnection.setConfigOption).toHaveBeenCalledWith({
      configId: 'mode',
      sessionId: 'session-1',
      type: 'select',
      value: 'claudian-aux-passive',
    });
    expect(mockConnection.setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'session-1',
      type: 'select',
      value: 'openai/gpt-5',
    });
    expect(onTextChunk).toHaveBeenNthCalledWith(1, 'Fix title');
    expect(onTextChunk).toHaveBeenNthCalledWith(2, 'Fix title now');
  });

  it('falls back to opencode from PATH when no CLI path is configured', async () => {
    const plugin = createMockPlugin();
    plugin.getResolvedProviderCliPath.mockReturnValue(null);
    const runner = new OpencodeAuxQueryRunner(plugin, {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });

    await expect(runner.query({
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(MockAcpSubprocess).toHaveBeenCalledWith(expect.objectContaining({
      command: 'opencode',
    }));
  });

  it('uses an explicit encoded OpenCode model override from the active chat tab', async () => {
    mockConnection.newSession.mockResolvedValue({
      models: {
        availableModels: [
          { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
          { id: 'openai/gpt-5.4', name: 'GPT-5.4' },
        ],
        currentModelId: 'openai/gpt-4.1',
      },
      sessionId: 'session-1',
    });

    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'title-gen',
    });

    await expect(runner.query({
      model: 'opencode:openai/gpt-5.4',
      systemPrompt: 'Use this custom system prompt.',
    }, 'Generate a title')).resolves.toBe('Fix title now');

    expect(mockConnection.setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'session-1',
      type: 'select',
      value: 'openai/gpt-5.4',
    });
    expect(mockConnection.setConfigOption).toHaveBeenCalledWith({
      configId: 'mode',
      sessionId: 'session-1',
      type: 'select',
      value: 'claudian-aux-passive',
    });
  });

  it('rejects permission prompts even for the read-only aux profile', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'readonly',
      artifactPurpose: 'inline',
      allowReadTextFile: true,
    });

    await expect((runner as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'read',
        rawInput: { path: 'note.md' },
        title: 'read',
        toolCallId: 'tool-1',
      },
    })).resolves.toEqual({
      outcome: {
        optionId: 'reject-now',
        outcome: 'selected',
      },
    });

    await expect((runner as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'edit',
        rawInput: { path: 'note.md' },
        title: 'edit',
        toolCallId: 'tool-2',
      },
    })).resolves.toEqual({
      outcome: {
        optionId: 'reject-now',
        outcome: 'selected',
      },
    });
  });

  it('rejects all permissions in deny-all mode', async () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'passive',
      artifactPurpose: 'instructions',
    });

    await expect((runner as any).handlePermissionRequest({
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow-now' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject-now' },
      ],
      sessionId: 'session-1',
      toolCall: {
        kind: 'read',
        rawInput: { path: 'note.md' },
        title: 'read',
        toolCallId: 'tool-1',
      },
    })).resolves.toEqual({
      outcome: {
        optionId: 'reject-now',
        outcome: 'selected',
      },
    });
  });

  it('rejects aux reads outside the workspace root', () => {
    const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
      agentProfile: 'readonly',
      artifactPurpose: 'inline',
      allowReadTextFile: true,
    });

    (runner as any).sessionCwds.set('session-1', '/tmp/claudian-test-vault');

    expect(() => (runner as any).resolveSessionPath('session-1', '/tmp/outside.md')).toThrow(
      'OpenCode aux read access is limited to the current workspace.',
    );
    expect((runner as any).resolveSessionPath('session-1', '/tmp/claudian-test-vault/notes/today.md')).toBe(
      '/tmp/claudian-test-vault/notes/today.md',
    );
  });

  describe('reset and cancellation lifecycle', () => {
    const installTriplet = (triplet: MockTriplet) => {
      MockAcpSubprocess.mockImplementationOnce(() => triplet.process as any);
      MockAcpJsonRpcTransport.mockImplementationOnce(() => triplet.transport as any);
      MockAcpClientConnection.mockImplementationOnce(() => triplet.connection as any);
    };

    it('drops a query whose materials resolve after reset, without touching the replacement', async () => {
      const tripletB = createMockTriplet({ sessionId: 'session-B', replyText: 'B text' });
      installTriplet(tripletB);

      let resolveMaterialsA!: (value: LaunchArtifacts) => void;
      const materialsA = new Promise<LaunchArtifacts>((resolve) => {
        resolveMaterialsA = resolve;
      });
      mockPrepareOpencodeLaunchArtifacts.mockImplementationOnce(() => materialsA);

      const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
        agentProfile: 'passive',
        artifactPurpose: 'inline',
      });
      const controllerA = new AbortController();
      const queryA = runner.query({ abortController: controllerA, systemPrompt: 'S' }, 'A');
      await flushTicks();

      runner.reset();

      const resultB = await runner.query({ systemPrompt: 'S' }, 'B');
      expect(resultB).toBe('B text');

      resolveMaterialsA(MOCK_LAUNCH_ARTIFACTS);
      await expect(queryA).rejects.toThrow();

      expect(MockAcpSubprocess).toHaveBeenCalledTimes(1);
      expect(tripletB.connection.prompt).toHaveBeenCalledTimes(1);
      expect(tripletB.process.shutdown).not.toHaveBeenCalled();
      expect(tripletB.transport.dispose).not.toHaveBeenCalled();
      expect(tripletB.connection.dispose).not.toHaveBeenCalled();
    });

    it('reclaims its own startup candidate when initialize completes after reset', async () => {
      const tripletA = createMockTriplet({ sessionId: 'session-A', replyText: 'A text' });
      const tripletB = createMockTriplet({ sessionId: 'session-B', replyText: 'B text' });
      installTriplet(tripletA);
      installTriplet(tripletB);

      let resolveInitializeA!: (value: Record<string, never>) => void;
      const initializeA = new Promise<Record<string, never>>((resolve) => {
        resolveInitializeA = resolve;
      });
      tripletA.connection.initialize.mockImplementationOnce(() => initializeA);

      const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
        agentProfile: 'passive',
        artifactPurpose: 'inline',
      });
      const queryA = runner.query({ systemPrompt: 'S' }, 'A');
      await flushTicks();

      runner.reset();
      expect(tripletA.process.shutdown).toHaveBeenCalledTimes(1);
      expect(tripletA.transport.dispose).toHaveBeenCalledTimes(1);
      expect(tripletA.connection.dispose).toHaveBeenCalledTimes(1);

      const resultB = await runner.query({ systemPrompt: 'S' }, 'B');
      expect(resultB).toBe('B text');

      resolveInitializeA({});
      await expect(queryA).rejects.toThrow();

      expect(tripletB.connection.prompt).toHaveBeenCalledTimes(1);
      expect(tripletB.connection.newSession).toHaveBeenCalledTimes(1);
      expect(tripletB.process.shutdown).not.toHaveBeenCalled();
      expect(tripletB.transport.dispose).not.toHaveBeenCalled();
    });

    it('drops a newSession completion that arrives after reset', async () => {
      const tripletA = createMockTriplet({ sessionId: 'session-A', replyText: 'A text' });
      const tripletB = createMockTriplet({ sessionId: 'session-B', replyText: 'B text' });
      installTriplet(tripletA);
      installTriplet(tripletB);

      let resolveNewSessionA!: (value: { sessionId: string }) => void;
      const newSessionA = new Promise<{ sessionId: string }>((resolve) => {
        resolveNewSessionA = resolve;
      });
      tripletA.connection.newSession.mockImplementationOnce(() => newSessionA);

      const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
        agentProfile: 'passive',
        artifactPurpose: 'inline',
      });
      const queryA = runner.query({ systemPrompt: 'S' }, 'A');
      await flushTicks();

      runner.reset();
      const resultB = await runner.query({ systemPrompt: 'S' }, 'B');
      expect(resultB).toBe('B text');

      resolveNewSessionA({ sessionId: 'session-A' });
      await expect(queryA).rejects.toThrow();

      expect(tripletB.connection.prompt).toHaveBeenCalledTimes(1);
      expect(tripletB.connection.setConfigOption).not.toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-A' }),
      );
      expect(tripletB.process.shutdown).not.toHaveBeenCalled();
      expect(tripletB.transport.dispose).not.toHaveBeenCalled();
      expect(tripletB.connection.dispose).not.toHaveBeenCalled();
    });

    it('does not spawn after cancellation during the materials await', async () => {
      let resolveMaterials!: (value: LaunchArtifacts) => void;
      const materials = new Promise<LaunchArtifacts>((resolve) => {
        resolveMaterials = resolve;
      });
      mockPrepareOpencodeLaunchArtifacts.mockImplementationOnce(() => materials);

      const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
        agentProfile: 'passive',
        artifactPurpose: 'inline',
      });
      const controller = new AbortController();
      const queryPromise = runner.query({ abortController: controller, systemPrompt: 'S' }, 'A');
      await flushTicks();

      controller.abort();
      resolveMaterials(MOCK_LAUNCH_ARTIFACTS);

      await expect(queryPromise).rejects.toThrow('Cancelled');
      expect(MockAcpSubprocess).not.toHaveBeenCalled();
      expect(MockAcpJsonRpcTransport).not.toHaveBeenCalled();
      expect(MockAcpClientConnection).not.toHaveBeenCalled();
    });

    it('reclaims the startup candidate when cancelled during initialize', async () => {
      const tripletA = createMockTriplet({ sessionId: 'session-A', replyText: 'A text' });
      installTriplet(tripletA);

      let resolveInitialize!: (value: Record<string, never>) => void;
      const initializeGate = new Promise<Record<string, never>>((resolve) => {
        resolveInitialize = resolve;
      });
      tripletA.connection.initialize.mockImplementationOnce(() => initializeGate);

      const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
        agentProfile: 'passive',
        artifactPurpose: 'inline',
      });
      const controller = new AbortController();
      const queryPromise = runner.query({ abortController: controller, systemPrompt: 'S' }, 'A');
      await flushTicks();

      controller.abort();
      resolveInitialize({});

      await expect(queryPromise).rejects.toThrow('Cancelled');
      expect(tripletA.process.shutdown).toHaveBeenCalledTimes(1);
      expect(tripletA.transport.dispose).toHaveBeenCalledTimes(1);
      expect(tripletA.connection.dispose).toHaveBeenCalledTimes(1);
      expect(tripletA.connection.newSession).not.toHaveBeenCalled();
    });

    it('reuses the aux session across sequential queries', async () => {
      const runner = new OpencodeAuxQueryRunner(createMockPlugin(), {
        agentProfile: 'passive',
        artifactPurpose: 'title-gen',
      });

      const first = await runner.query({ systemPrompt: 'S' }, 'first');
      const second = await runner.query({ systemPrompt: 'S' }, 'second');

      expect(first).toBe('Fix title now');
      expect(second).toBe('Fix title now');
      expect(mockConnection.newSession).toHaveBeenCalledTimes(1);
    });
  });
});
