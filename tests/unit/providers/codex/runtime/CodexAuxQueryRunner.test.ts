import '@/providers';

const mockTransportRequest = jest.fn();
const mockTransportNotify = jest.fn();
const mockTransportOnNotification = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportStart = jest.fn();
const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockProcessOnExit = jest.fn();
const mockProcessOffExit = jest.fn();

const mockResolveLaunchSpec = jest.fn();

jest.mock('@/providers/codex/runtime/CodexRpcTransport', () => ({
  CodexRpcTransport: jest.fn().mockImplementation(() => ({
    request: mockTransportRequest,
    notify: mockTransportNotify,
    onNotification: mockTransportOnNotification,
    dispose: mockTransportDispose,
    start: mockTransportStart,
  })),
}));

jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => ({
    start: mockProcessStart,
    shutdown: mockProcessShutdown,
    onExit: mockProcessOnExit,
    offExit: mockProcessOffExit,
  })),
}));

jest.mock('@/providers/codex/runtime/codexAppServerSupport', () => ({
  initializeCodexAppServerTransport: jest.fn().mockImplementation(async (transport: { notify: (method: string) => void }) => {
    transport.notify('initialized');
    return {
      userAgent: 'test/0.1',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    };
  }),
  resolveCodexAppServerLaunchSpec: (...args: unknown[]) => mockResolveLaunchSpec(...args),
}));

import { PassThrough } from 'node:stream';

import { QueryBackedInlineEditService } from '@/core/auxiliary/QueryBackedInlineEditService';
import { CodexAppServerProcess as MockedProcessClass } from '@/providers/codex/runtime/CodexAppServerProcess';
import { CodexAuxQueryRunner } from '@/providers/codex/runtime/CodexAuxQueryRunner';
import type { CodexRpcTransport as RealCodexRpcTransport } from '@/providers/codex/runtime/CodexRpcTransport';
import { CodexRpcTransport } from '@/providers/codex/runtime/CodexRpcTransport';

// The transport is mocked at the class level for the legacy test below; pull
// the real class in so the reset-semantics check exercises actual dispose
// behavior (dispose rejects in-flight requests and drops late responses).
const { CodexRpcTransport: ActualCodexRpcTransport } = jest.requireActual(
  '@/providers/codex/runtime/CodexRpcTransport',
) as { CodexRpcTransport: typeof RealCodexRpcTransport };

interface FakeProcess {
  start: jest.Mock;
  shutdown: jest.Mock;
  onExit: jest.Mock;
  offExit: jest.Mock;
  stdin: PassThrough;
  stdout: PassThrough;
  requests: string[];
}

function createFakeProcess(): FakeProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: string[] = [];
  const exitCallbacks: Array<(code: number | null, signal: string | null) => void> = [];
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) requests.push(line);
    }
  });
  const fake: FakeProcess = {
    start: jest.fn(),
    shutdown: jest.fn(async () => {
      for (const cb of [...exitCallbacks]) cb(0, null);
    }),
    onExit: jest.fn((cb: (code: number | null, signal: string | null) => void) => {
      exitCallbacks.push(cb);
    }),
    offExit: jest.fn((cb: (code: number | null, signal: string | null) => void) => {
      const idx = exitCallbacks.indexOf(cb);
      if (idx !== -1) exitCallbacks.splice(idx, 1);
    }),
    stdin,
    stdout,
    requests,
  };
  return fake;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitForRequest(proc: FakeProcess, method: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (proc.requests.some((line) => line.includes(`"method":"${method}"`))) {
      return;
    }
    await flush();
  }
  throw new Error(`Expected request was not sent: ${method}`);
}

async function respond(proc: FakeProcess, id: number, result: unknown): Promise<void> {
  proc.stdout.write(`${JSON.stringify({ id, jsonrpc: '2.0', result })}\n`);
  await flush();
  await flush();
}

function notify(proc: FakeProcess, method: string, params: unknown): void {
  proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function requestLines(proc: FakeProcess, method: string): Record<string, any>[] {
  return proc.requests
    .map((line) => JSON.parse(line))
    .filter((message) => message.method === method);
}

describe('CodexAuxQueryRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveLaunchSpec.mockReturnValue({
      target: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
      command: 'wsl.exe',
      args: ['--distribution', 'Ubuntu', '--cd', '/mnt/c/repo', 'codex', 'app-server', '--listen', 'stdio://'],
      spawnCwd: 'C:\\repo',
      targetCwd: '/mnt/c/repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      pathMapper: {
        target: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
        toTargetPath: jest.fn(),
        toHostPath: jest.fn(),
        mapTargetPathList: jest.fn(),
        canRepresentHostPath: jest.fn(),
      },
    });

    let turnCompletedHandler: ((params: unknown) => void) | undefined;
    let deltaHandler: ((params: unknown) => void) | undefined;
    mockTransportOnNotification.mockImplementation((method: string, handler: (params: unknown) => void) => {
      if (method === 'item/agentMessage/delta') {
        deltaHandler = handler;
      }
      if (method === 'turn/completed') {
        turnCompletedHandler = handler;
      }
    });

    mockTransportRequest.mockImplementation(async (method: string) => {
      switch (method) {
        case 'initialize':
          return {
            userAgent: 'test/0.1',
            codexHome: '/home/user/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
          };
        case 'thread/start':
          return { thread: { id: 'thread-1' } };
        case 'turn/start':
          setTimeout(() => {
            deltaHandler?.({ delta: 'Hello from Codex' });
            turnCompletedHandler?.({ turn: { status: 'completed', error: null } });
          }, 0);
          return { turn: { id: 'turn-1' } };
        default:
          return {};
      }
    });
  });

  it('drops late pre-reset completions instead of using the replacement resources', async () => {
    const procA = createFakeProcess();
    const procB = createFakeProcess();
    jest.mocked(MockedProcessClass)
      .mockImplementationOnce(() => procA as any)
      .mockImplementationOnce(() => procB as any);
    jest.mocked(CodexRpcTransport)
      .mockImplementationOnce(() => new ActualCodexRpcTransport(procA as any))
      .mockImplementationOnce(() => new ActualCodexRpcTransport(procB as any));

    const plugin = {
      settings: {},
      getActiveEnvironmentVariables: jest.fn(),
      app: { vault: { adapter: { basePath: 'C:\\repo' } } },
    } as any;
    const service = new QueryBackedInlineEditService(new CodexAuxQueryRunner(plugin));
    const request = {
      mode: 'selection' as const,
      selectedText: 'text',
      instruction: 'edit',
      notePath: 'note.md',
    };
    const initializeResult = {
      userAgent: 'test/0.1',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    };

    const editA = service.editText(request);
    await waitForRequest(procA, 'initialize');
    await respond(procA, 1, initializeResult);
    await waitForRequest(procA, 'thread/start');
    // Leave query A suspended at thread/start: the response never arrives yet.

    const editB = service.editText(request);
    await waitForRequest(procB, 'initialize');
    await respond(procB, 1, initializeResult);
    await waitForRequest(procB, 'thread/start');
    await respond(procB, 2, { thread: { id: 'thread-B' } });
    await waitForRequest(procB, 'turn/start');
    await respond(procB, 3, { turn: { id: 'turn-B' } });
    notify(procB, 'item/agentMessage/delta', { delta: '<replacement>B-fixed</replacement>' });
    notify(procB, 'turn/completed', { turn: { status: 'completed', error: null } });
    await flush();
    await flush();

    // The pre-reset thread/start response arrives only now, after reset()
    // disposed transport A. The real transport must drop it (no pending entry).
    procA.stdout.write(`${JSON.stringify({ id: 2, jsonrpc: '2.0', result: { thread: { id: 'thread-A' } } })}\n`);
    await flush();
    await flush();

    const resultA = await editA;
    expect(resultA.success).toBe(false);

    const resultB = await editB;
    expect(resultB).toEqual(expect.objectContaining({ success: true, editedText: 'B-fixed' }));

    const turnStarts = requestLines(procB, 'turn/start');
    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0].params.threadId).toBe('thread-B');
    expect(requestLines(procB, 'thread/start')).toHaveLength(1);
  });

  it('uses the launch spec target cwd for auxiliary thread/start calls', async () => {
    const plugin = {
      settings: {},
      getActiveEnvironmentVariables: jest.fn(),
      app: {
        vault: {
          adapter: { basePath: 'C:\\repo' },
        },
      },
    } as any;

    const runner = new CodexAuxQueryRunner(plugin);
    const result = await runner.query({ systemPrompt: 'You are concise.' }, 'Summarize this');

    expect(result).toBe('Hello from Codex');
    expect(MockedProcessClass).toHaveBeenCalledWith(expect.objectContaining({
      command: 'wsl.exe',
      targetCwd: '/mnt/c/repo',
    }));
    expect(mockTransportRequest).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        cwd: '/mnt/c/repo',
      }),
    );
  });
});
