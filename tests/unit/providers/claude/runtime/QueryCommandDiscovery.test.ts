import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'os';
import { clearTimeout as clearNativeTimeout, setTimeout as setNativeTimeout } from 'timers';

import type { McpServerManager } from '@/core/mcp/McpServerManager';
import type { CommandDropdownSession, CommandDropdownSnapshot } from '@/core/providers/commands/ProviderCommandDiscovery';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SlashCommand, StreamChunk } from '@/core/types';
import * as TabUI from '@/features/chat/tabs/Tab';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type ClaudianPlugin from '@/main';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { SkillStorage } from '@/providers/claude/storage/SkillStorage';
import { SlashCommandStorage } from '@/providers/claude/storage/SlashCommandStorage';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

type SdkCommand = { name: string; description: string; argumentHint: string };
type MockQuery = AsyncGenerator<any> & {
  close: jest.Mock;
  interrupt: jest.Mock;
  supportedCommands: jest.Mock;
  pushStdoutMessage: (message: any) => void;
};

type MockChild = EventEmitter & {
  stdin: EventEmitter;
  stdout: EventEmitter & { destroyed: boolean };
  stderr: null;
  kill: jest.Mock;
};

type QueryRecord = {
  query: MockQuery;
  child: MockChild;
  signal: AbortSignal;
  holdEof: boolean;
  eofObserved: Promise<void>;
  releaseEof: () => void;
};

const sdkMock = sdkModule as unknown as {
  resetMockMessages: () => void;
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  getQueryCallCount: () => number;
};
const originalQuery = sdkModule.query;
const oldCommand: SdkCommand = { name: 'old', description: 'Old query', argumentHint: '' };
const newCommand: SdkCommand = { name: 'new', description: 'New query', argumentHint: '<arg>' };

function mapped(command: SdkCommand): SlashCommand {
  return {
    id: `sdk:${command.name}`,
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    content: '',
    source: 'sdk',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function withDeadline<T>(promise: Promise<T>, label: string, ms = 1_000): Promise<T> {
  let timer!: ReturnType<typeof setNativeTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setNativeTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearNativeTimeout(timer));
}

async function runWithCleanup(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  let bodyFailed = false;
  let bodyError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  try { await body(); } catch (error) { bodyFailed = true; bodyError = error; }
  try { await cleanup(); } catch (error) { cleanupFailed = true; cleanupError = error; }
  if (bodyFailed && cleanupFailed) {
    let cleanupDetail: string;
    try { cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError); }
    catch { cleanupDetail = '<unprintable cleanup error>'; }
    throw new AggregateError([bodyError, cleanupError], `Body and cleanup failed: ${cleanupDetail}`, { cause: bodyError });
  }
  if (bodyFailed) throw bodyError;
  if (cleanupFailed) throw cleanupError;
}

function fixtureVaultPath(): string {
  return process.env.TEST_VAULT || os.tmpdir();
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 24; i += 1) await Promise.resolve();
}

async function collect(generator: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

function makeMockChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(),
    stdout: Object.assign(new EventEmitter(), { destroyed: true }),
    stderr: null,
    kill: jest.fn(),
  });
}

function makePlugin(): ClaudianPlugin {
  return {
    app: { vault: { adapter: { basePath: fixtureVaultPath() } } },
    storage: {
      addDenyRule: jest.fn(),
      addAllowRule: jest.fn(),
      getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
    },
    settings: {
      model: 'claude-3-5-sonnet',
      permissionMode: 'ask',
      thinkingBudget: 0,
      mediaFolder: 'claudian-media',
      systemPrompt: '',
      loadUserClaudeSettings: false,
      claudeCliPath: '/nonexistent/mock-claude',
      claudeCliPaths: [],
      enableAutoTitleGeneration: true,
      titleGenerationModel: 'claude-3-5-haiku',
    },
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/nonexistent/mock-claude'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    pluginManager: { getPluginsKey: jest.fn().mockReturnValue('') },
  } as unknown as ClaudianPlugin;
}

function makeMcpManager(): McpServerManager {
  return {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getActiveServers: jest.fn().mockReturnValue({}),
    getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    extractMentions: jest.fn().mockReturnValue(new Set()),
    transformMentions: jest.fn((value: string) => value),
  } as unknown as McpServerManager;
}

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'mock-session',
  permissionMode: 'default',
};

describe('Query command discovery', () => {
  let service: ClaudianService;
  let records: QueryRecord[];

  beforeEach(() => {
    jest.clearAllMocks();
    sdkMock.resetMockMessages();
    records = [];
    service = new ClaudianService(makePlugin(), makeMcpManager());
    jest.spyOn(sdkModule, 'query').mockImplementation(((input: any) => {
      const child = makeMockChild();
      (childProcess.spawn as jest.Mock).mockReturnValueOnce(child);
      input.options.spawnClaudeCodeProcess({
        command: '/nonexistent/mock-claude',
        args: [],
        cwd: input.options.cwd,
        env: {},
        signal: input.options.abortController.signal,
      });
      const query = (originalQuery as any)(input) as MockQuery;
      const originalIterator = query[Symbol.asyncIterator].bind(query);
      const eofObserved = deferred<void>();
      const eofGate = deferred<void>();
      const record: QueryRecord = {
        query,
        child,
        signal: input.options.abortController.signal,
        holdEof: false,
        eofObserved: eofObserved.promise,
        releaseEof: () => eofGate.resolve(),
      };
      query[Symbol.asyncIterator] = () => {
        const iterator = originalIterator();
        return {
          next: async () => {
            const result = await iterator.next();
            if (result.done && record.holdEof) {
              eofObserved.resolve();
              await eofGate.promise;
            }
            return result;
          },
          return: () => iterator.return(undefined),
          throw: (error: unknown) => iterator.throw(error),
          [Symbol.asyncDispose]: async () => { await iterator.return(undefined); },
          [Symbol.asyncIterator]() { return this; },
        };
      };
      records.push(record);
      return query;
    }) as any);
  });

  afterEach(() => {
    for (const record of records) record.releaseEof();
    jest.useRealTimers();
    service.cleanup();
    jest.restoreAllMocks();
    sdkMock.resetMockMessages();
  });

  async function start(): Promise<QueryRecord> {
    expect(await service.ensureReady()).toBe(true);
    expect(service.isReady()).toBe(true);
    return records[records.length - 1];
  }

  function read(signal?: AbortSignal): Promise<SlashCommand[]> {
    return (service.getSupportedCommands as (signal?: AbortSignal) => Promise<SlashCommand[]>).call(service, signal);
  }

  function triggerInit(kind: 'leased' | 'lease-less', record: QueryRecord): Promise<StreamChunk[]> | null {
    if (kind === 'lease-less') {
      record.query.pushStdoutMessage(initMessage);
      return null;
    }
    sdkMock.setMockMessages([
      initMessage,
      { type: 'assistant', message: { content: [{ type: 'text', text: 'leased response' }] } },
      { type: 'result', subtype: 'success', result: 'ok' },
    ], { appendResult: false });
    return collect(service.query(service.prepareTurn({ turnId: 'leased-turn', text: 'hello' })));
  }

  async function endNormally(record: QueryRecord): Promise<void> {
    const done = record.query.return(undefined);
    record.query.pushStdoutMessage({ type: 'system', subtype: 'unused' });
    await done;
    await flushMicrotasks();
  }

  describe('P1 revoked Query menu refresh', () => {
    it('uses the temporary directory for the fixture when TEST_VAULT is unset', async () => {
      const previousVault = process.env.TEST_VAULT;
      delete process.env.TEST_VAULT;
      try {
        const plugin = makePlugin();
        service.cleanup();
        service = new ClaudianService(plugin, makeMcpManager());
        await withDeadline(start(), 'temporary fixture startup');
        expect((plugin.app.vault.adapter as unknown as { basePath: string }).basePath).toBe(os.tmpdir());
        expect(childProcess.spawn).toHaveBeenLastCalledWith(
          '/nonexistent/mock-claude', [], expect.objectContaining({ cwd: os.tmpdir() }),
        );
      } finally {
        if (previousVault === undefined) delete process.env.TEST_VAULT;
        else process.env.TEST_VAULT = previousVault;
      }
    });

    it('retains the original failure when cleanup also times out', async () => {
      const original = new Error('original body failure');
      const error = await runWithCleanup(
        async () => { throw original; },
        async () => { await withDeadline(new Promise<void>(() => {}), 'controlled cleanup', 10); },
      ).catch(reason => reason);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.message).toContain('Timed out: controlled cleanup');
      expect(error.cause).toBe(original);
      expect(error.errors[0]).toBe(original);
      expect(error.errors[1]).toEqual(new Error('Timed out: controlled cleanup'));
    });

    it.each([
      ['EOF', 'after-init'],
      ['exit', 'after-init'],
      ['EOF', 'before-getter'],
      ['exit', 'before-getter'],
    ] as const)('%s: concurrent menu reads resolve vault-only with no owned probe (%s)', async (end, timing) => {
      const previousServices = ProviderWorkspaceRegistry.getServices('claude');
      const plugin = makePlugin();
      // One vault command anchors the read: vault-only is observable as
      // ['vault-only'] instead of an ambiguous empty list.
      const vaultFiles: Record<string, string> = {
        '.claude/commands/vault-only.md': '---\ndescription: vault only command\n---\nBody of vault-only',
      };
      const adapter = {
        listFilesRecursive: async (folder: string) =>
          Object.keys(vaultFiles).filter(path => path.startsWith(`${folder}/`)),
        listFolders: async () => [],
        read: async (filePath: string) => {
          if (!(filePath in vaultFiles)) throw new Error(`File not found: ${filePath}`);
          return vaultFiles[filePath];
        },
        exists: async (filePath: string) => filePath in vaultFiles,
      } as unknown as VaultFileAdapter;
      // The legacy probe slot stays wired on the real catalog: typed routing
      // must leave it dormant, never invoke it to refill the menu.
      let probeFlight: Promise<SlashCommand[]> | undefined;
      const catalog = new ClaudeCommandCatalog(
        new SlashCommandStorage(adapter), new SkillStorage(adapter), () => {
          probeFlight = probeRuntimeCommands(plugin);
          return probeFlight;
        },
      );
      let configFactory!: () => {
        config: { createDiscoverySession: () => CommandDropdownSession };
        getEntries: () => Promise<any[]>;
      };
      let menuReads: Promise<any[]>[] = [];
      const record = await withDeadline(start(), 'chat startup');
      const initStarted = deferred<void>();
      if (timing === 'after-init') {
        record.query.supportedCommands.mockImplementation(() => {
          initStarted.resolve();
          return Promise.resolve([oldCommand]);
        });
      }

      const tab = {
        id: 'menu-tab', providerId: 'claude', lifecycleState: 'blank',
        conversationId: null, service, serviceInitialized: true,
        state: { messages: [], isStreaming: false },
        controllers: { conversationController: { initializeWelcome: jest.fn() } },
        dom: { eventCleanups: [] as Array<() => void> },
        ui: { externalContextSelector: null, slashCommandDropdown: null },
      };
      jest.spyOn(TabUI, 'createTab').mockReturnValue(tab as any);
      jest.spyOn(TabUI, 'initializeTabUI').mockImplementation((_tab, _plugin, options) => {
        configFactory = options!.getProviderCatalogConfig as typeof configFactory;
      });
      jest.spyOn(TabUI, 'initializeTabControllers').mockImplementation(() => {});
      jest.spyOn(TabUI, 'wireTabInputEvents').mockImplementation(() => {});
      jest.spyOn(TabUI, 'activateTab').mockImplementation(() => {});
      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog });

      await runWithCleanup(async () => {
        const manager = new TabManager(plugin, {} as HTMLElement, { getTabManager: () => null } as any);
        await withDeadline(manager.createTab(), 'tab startup');
        const menu = configFactory();

        if (timing === 'after-init') {
          record.query.pushStdoutMessage(initMessage);
          await withDeadline(initStarted.promise, 'init discovery');
        }
        // before-getter skips both reads: an unobserved live cell would start
        // the getter flight on its first read.
        const initSnapshot = timing === 'after-init'
          ? await withDeadline(service.getSupportedCommands(), 'init snapshot')
          : null;
        const initialMenu = timing === 'after-init'
          ? (await withDeadline(menu.getEntries(), 'initial menu')).map(entry => entry.name)
          : null;
        expect(initSnapshot).toEqual(timing === 'after-init' ? [mapped(oldCommand)] : null);
        expect(initialMenu).toEqual(timing === 'after-init' ? ['old'] : null);

        const consumer = (service as unknown as { responseConsumerPromise: Promise<void> }).responseConsumerPromise;
        if (end === 'EOF') {
          const done = record.query.return(undefined);
          record.query.pushStdoutMessage({ type: 'system', subtype: 'unused' });
          await withDeadline(Promise.all([done, consumer]), 'consumer EOF');
        } else {
          // Process exit revokes the scope's command cell synchronously
          // (customSpawn onExit → notifyQueryProcessExit); the mock SDK's
          // iterator outlives the child, so the consumer loop is deliberately
          // not awaited here.
          record.child.emit('exit', 0);
        }

        // Two concurrent menu reads after the Query ended: both vault-only.
        const getCommandsSpy = jest.spyOn(manager, 'getSdkCommands');
        const catalogSpy = jest.spyOn(catalog, 'listDropdownEntries');
        menuReads = [menu.getEntries(), menu.getEntries()];
        const entries = await withDeadline(Promise.all(menuReads), 'menu completion');
        expect(entries.map(list => list.map(entry => entry.name))).toEqual([['vault-only'], ['vault-only']]);
        expect(entries.flatMap(list => list.map(entry => entry.name))).not.toContain('old');

        // Probe policy: the wired probe slot never fires and no second Query
        // is ever created, no matter how the first one ended.
        expect(probeFlight).toBeUndefined();
        expect(records).toHaveLength(1);
        expect(sdkMock.getQueryCallCount()).toBe(1);
        // Typed routing: the legacy array handoff is never entered.
        expect(getCommandsSpy).not.toHaveBeenCalled();
        expect(catalogSpy).not.toHaveBeenCalled();

        const session = menu.config.createDiscoverySession();
        const snapshot: CommandDropdownSnapshot = await withDeadline(
          session.read(),
          'typed session snapshot',
        ).finally(() => {
          session.release();
        });
        expect(snapshot.status).toBe('ready');
        expect(snapshot.runtime).toMatchObject({ status: 'unavailable', reason: 'no-readable-query' });
        expect(snapshot.fallbackReason).toBe('runtime-unavailable');
        expect(snapshot.rawCount).toEqual({ runtime: null, probe: null, vault: 1 });
        expect(snapshot.probe).toEqual({ status: 'not-attempted' });
        expect(snapshot.entries.map(entry => entry.name)).toEqual(['vault-only']);

        // Pure P1 cell assertions: the ended Query is never re-read, restarted,
        // or torn down by menu refreshes.
        expect(record.query.supportedCommands).toHaveBeenCalledTimes(timing === 'after-init' ? 1 : 0);
        expect(await withDeadline(service.getSupportedCommands(), 'post-end array shell')).toEqual([]);
        expect(records).toHaveLength(1);
        expect(sdkMock.getQueryCallCount()).toBe(1);
        expect(record.query.close).not.toHaveBeenCalled();
        expect(record.query.interrupt).not.toHaveBeenCalled();
        expect(record.signal.aborted).toBe(false);
        expect(record.child.kill).not.toHaveBeenCalled();
      }, async () => {
        ProviderWorkspaceRegistry.setServices('claude', previousServices ?? undefined);
        await withDeadline(Promise.allSettled(menuReads), 'menu read cleanup');
      });
    });
  });

  it('does not start a query when commands are unavailable', async () => {
    expect(await read()).toEqual([]);
    expect(sdkMock.getQueryCallCount()).toBe(0);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['nonempty', [oldCommand]],
    ['empty', []],
  ] as const)('caches a successful %s snapshot for the same Query', async (_label, commands) => {
    const record = await start();
    record.query.supportedCommands.mockResolvedValue([...commands]);

    const first = await read();
    const second = await read();

    expect(first).toEqual(commands.map(mapped));
    expect(second).toEqual(commands.map(mapped));
    expect(first).not.toBe(second);
    expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);
  });

  it('returns independent arrays and entries without sharing SDK objects', async () => {
    const record = await start();
    const sdkEntry = { ...oldCommand };
    record.query.supportedCommands.mockResolvedValue([sdkEntry]);

    const first = await read();
    first[0].name = 'caller-changed';
    first.push(mapped(newCommand));
    sdkEntry.description = 'sdk-changed';
    const second = await read();

    expect(second).toEqual([mapped(oldCommand)]);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);
  });

  it('retries a failed getter only on a later explicit read', async () => {
    const record = await start();
    record.query.supportedCommands
      .mockRejectedValueOnce(new Error('mock initialization failed'))
      .mockResolvedValueOnce([newCommand]);

    expect(await read()).toEqual([]);
    await flushMicrotasks();
    expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);
    expect(await read()).toEqual([mapped(newCommand)]);
    expect(record.query.supportedCommands).toHaveBeenCalledTimes(2);
  });

  it('does not turn repeated init events after failure into automatic retry', async () => {
    const record = await start();
    record.query.supportedCommands
      .mockRejectedValueOnce(new Error('mock initialization failed'))
      .mockResolvedValueOnce([newCommand]);
    const firstInit = deferred<void>();
    const secondInit = deferred<void>();
    let seen = 0;
    service.setPermissionModeSyncCallback(() => {
      seen += 1;
      (seen === 1 ? firstInit : secondInit).resolve();
    });

    record.query.pushStdoutMessage(initMessage);
    await firstInit.promise;
    await flushMicrotasks();
    record.query.pushStdoutMessage(initMessage);
    await secondInit.promise;
    await flushMicrotasks();
    const callsBeforeRead = record.query.supportedCommands.mock.calls.length;
    const result = await read();

    expect(callsBeforeRead).toBe(1);
    expect(result).toEqual([mapped(newCommand)]);
    expect(record.query.supportedCommands).toHaveBeenCalledTimes(2);
  });

  it('shares one SDK flight between concurrent public reads', async () => {
    const record = await start();
    const pending = deferred<SdkCommand[]>();
    record.query.supportedCommands.mockReturnValue(pending.promise);
    const first = read();
    const second = read();
    await flushMicrotasks();
    const callsWhilePending = record.query.supportedCommands.mock.calls.length;
    pending.resolve([oldCommand]);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(callsWhilePending).toBe(1);
    expect(firstResult).toEqual([mapped(oldCommand)]);
    expect(secondResult).toEqual([mapped(oldCommand)]);
    expect(firstResult).not.toBe(secondResult);
    expect(firstResult[0]).not.toBe(secondResult[0]);
  });

  it.each(['lease-less', 'leased'] as const)(
    '%s init and a public read share the original Query flight',
    async kind => {
      const record = await start();
      const pending = deferred<SdkCommand[]>();
      const initObserved = deferred<void>();
      record.query.supportedCommands.mockReturnValue(pending.promise);
      service.setPermissionModeSyncCallback(() => initObserved.resolve());

      const publicRead = read();
      await flushMicrotasks();
      const turn = triggerInit(kind, record);
      await initObserved.promise;
      await flushMicrotasks();
      const callsWhilePending = record.query.supportedCommands.mock.calls.length;
      pending.resolve([]);
      const result = await publicRead;
      const chunks = turn ? await turn : [];
      const cached = await read();

      expect(callsWhilePending).toBe(1);
      expect(result).toEqual([]);
      expect(cached).toEqual([]);
      expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);
      expect(chunks.some(chunk => chunk.type === 'text' && chunk.content === 'leased response')).toBe(kind === 'leased');
    },
  );

  it('joins an init-started flight from a later public read', async () => {
    const record = await start();
    const started = deferred<void>();
    const pending = deferred<SdkCommand[]>();
    record.query.supportedCommands.mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    record.query.pushStdoutMessage(initMessage);
    await started.promise;
    const publicRead = read();
    await flushMicrotasks();
    const callsWhilePending = record.query.supportedCommands.mock.calls.length;
    pending.resolve([oldCommand]);

    expect(await publicRead).toEqual([mapped(oldCommand)]);
    expect(callsWhilePending).toBe(1);
  });

  it.each([
    ['lease-less', []],
    ['lease-less', [oldCommand]],
    ['leased', []],
    ['leased', [oldCommand]],
  ] as const)('%s init does not refetch an already ready snapshot %#', async (kind, commands) => {
    const record = await start();
    record.query.supportedCommands.mockResolvedValue([...commands]);
    expect(await read()).toEqual(commands.map(mapped));
    const initObserved = deferred<void>();
    service.setPermissionModeSyncCallback(() => initObserved.resolve());
    const turn = triggerInit(kind, record);
    await initObserved.promise;
    if (turn) await turn;
    await flushMicrotasks();

    expect(await read()).toEqual(commands.map(mapped));
    expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);
  });

  it.each(['lease-less', 'leased'] as const)(
    '%s init keeps its original scope across a synchronous close and rebuild',
    async kind => {
      const oldRecord = await start();
      const oldPending = deferred<SdkCommand[]>();
      oldRecord.query.supportedCommands.mockReturnValue(oldPending.promise);
      const oldRead = read();
      let oldBeforeResolution: SlashCommand[] | undefined;
      void oldRead.then(result => { oldBeforeResolution = result; });
      await flushMicrotasks();
      const initObserved = deferred<void>();
      let restart!: Promise<boolean>;
      service.setPermissionModeSyncCallback(() => {
        restart = service.ensureReady({ force: true });
        initObserved.resolve();
      });
      const turn = triggerInit(kind, oldRecord);
      await initObserved.promise;
      await restart;
      await flushMicrotasks();
      const staleBeforeResolution = oldBeforeResolution;
      const newRecord = records[1];
      const newCallsBeforeRead = newRecord.query.supportedCommands.mock.calls.length;
      newRecord.query.supportedCommands.mockResolvedValue([newCommand]);
      const fresh = await read();
      oldPending.resolve([oldCommand]);
      const stale = await oldRead;
      if (turn) await turn;

      expect(staleBeforeResolution).toEqual([]);
      expect(stale).toEqual([]);
      expect(newCallsBeforeRead).toBe(0);
      expect(fresh).toEqual([mapped(newCommand)]);
      expect(await read()).toEqual([mapped(newCommand)]);
      expect(newRecord.query.supportedCommands).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'revokes Q1 promptly and ignores its late %s while Q2 is pending',
    async completion => {
      const oldRecord = await start();
      const oldPending = deferred<SdkCommand[]>();
      oldRecord.query.supportedCommands.mockReturnValue(oldPending.promise);
      const oldRead = read();
      let observedOld: SlashCommand[] | undefined;
      void oldRead.then(result => { observedOld = result; });
      await flushMicrotasks();
      await service.ensureReady({ force: true });
      await flushMicrotasks();
      const staleBeforeCompletion = observedOld;
      const newRecord = records[1];
      const newPending = deferred<SdkCommand[]>();
      newRecord.query.supportedCommands.mockReturnValue(newPending.promise);
      const firstNewRead = read();
      await flushMicrotasks();
      if (completion === 'resolve') oldPending.resolve([oldCommand]);
      else oldPending.reject(new Error('late mock failure'));
      await flushMicrotasks();
      const secondNewRead = read();
      await flushMicrotasks();
      const newCallsWhilePending = newRecord.query.supportedCommands.mock.calls.length;
      newPending.resolve([newCommand]);
      const [stale, firstFresh, secondFresh] = await Promise.all([oldRead, firstNewRead, secondNewRead]);
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(staleBeforeCompletion).toEqual([]);
      expect(stale).toEqual([]);
      expect(firstFresh).toEqual([mapped(newCommand)]);
      expect(secondFresh).toEqual([mapped(newCommand)]);
      expect(newCallsWhilePending).toBe(1);
      expect(await read()).toEqual([mapped(newCommand)]);
      expect(newRecord.query.supportedCommands).toHaveBeenCalledTimes(1);
    },
  );

  it('does not return a ready Q2 snapshot to the older Q1 caller', async () => {
    const oldRecord = await start();
    const pending = deferred<SdkCommand[]>();
    oldRecord.query.supportedCommands.mockReturnValue(pending.promise);
    const staleRead = read();
    await flushMicrotasks();
    await service.ensureReady({ force: true });
    const newRecord = records[1];
    newRecord.query.supportedCommands.mockResolvedValue([newCommand]);
    expect(await read()).toEqual([mapped(newCommand)]);
    pending.resolve([oldCommand]);

    expect(await staleRead).toEqual([]);
    expect(await read()).toEqual([mapped(newCommand)]);
    expect(newRecord.query.supportedCommands).toHaveBeenCalledTimes(1);
  });

  it('revokes before watchdog retirement and rebuilds only after the fake child exits', async () => {
    const oldRecord = await start();
    oldRecord.query.supportedCommands.mockResolvedValue([oldCommand]);
    expect(await read()).toEqual([mapped(oldCommand)]);

    const retiring = service.retireAndRebuildQuery('test-watchdog');
    const during = await read();
    const callsBeforeExit = sdkMock.getQueryCallCount();
    oldRecord.child.emit('exit', 0);
    await retiring;
    const newRecord = records[1];
    newRecord.query.supportedCommands.mockResolvedValue([newCommand]);
    const after = await read();

    expect(during).toEqual([]);
    expect(callsBeforeExit).toBe(1);
    expect(oldRecord.query.close).toHaveBeenCalledTimes(1);
    expect(oldRecord.signal.aborted).toBe(true);
    expect(sdkMock.getQueryCallCount()).toBe(2);
    expect(newRecord.signal.aborted).toBe(false);
    expect(after).toEqual([mapped(newCommand)]);
    expect(newRecord.query.supportedCommands).toHaveBeenCalledTimes(1);
  });

  it('preserves the start prohibition when watchdog retirement cannot confirm exit', async () => {
    jest.useFakeTimers();
    const record = await start();
    record.query.supportedCommands.mockResolvedValue([oldCommand]);
    await read();
    const retiring = service.retireAndRebuildQuery('test-timeout');
    const during = await read();
    await jest.advanceTimersByTimeAsync(15_000);
    await retiring;
    const unavailable = await read();
    const blocked = service.ensureReady();
    await expect(blocked).rejects.toThrow('start is blocked');
    const callsWhileBlocked = sdkMock.getQueryCallCount();
    service.resetSession();
    expect(await service.ensureReady()).toBe(true);

    expect(during).toEqual([]);
    expect(unavailable).toEqual([]);
    expect(callsWhileBlocked).toBe(1);
    expect(record.query.close).toHaveBeenCalledTimes(1);
    expect(sdkMock.getQueryCallCount()).toBe(2);
  });

  it('revokes ready commands on a normal child exit without a retirement waiter', async () => {
    const record = await start();
    record.query.supportedCommands.mockResolvedValue([oldCommand]);
    expect(await read()).toEqual([mapped(oldCommand)]);

    record.child.emit('exit', 0);

    expect(await read()).toEqual([]);
    expect(await read()).toEqual([]);
    expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);
    expect(record.query.close).not.toHaveBeenCalled();
    expect(record.signal.aborted).toBe(false);
  });

  it('ends a pending reader on normal child exit and observes a late rejection', async () => {
    const record = await start();
    const pending = deferred<SdkCommand[]>();
    record.query.supportedCommands.mockReturnValue(pending.promise);
    const request = read();
    let observed: SlashCommand[] | undefined;
    void request.then(result => { observed = result; });
    await flushMicrotasks();
    record.child.emit('exit', 0);
    await flushMicrotasks();
    const beforeRejection = observed;
    pending.reject(new Error('late mock exit rejection'));
    const result = await request;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(beforeRejection).toEqual([]);
    expect(result).toEqual([]);
    expect(await read()).toEqual([]);
    expect(record.query.close).not.toHaveBeenCalled();
    expect(record.signal.aborted).toBe(false);
  });

  it('revokes commands on natural consumer EOF without closing or aborting the Query', async () => {
    const record = await start();
    record.query.supportedCommands.mockResolvedValue([oldCommand]);
    expect(await read()).toEqual([mapped(oldCommand)]);

    await endNormally(record);

    expect(await read()).toEqual([]);
    expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);
    expect(record.query.close).not.toHaveBeenCalled();
    expect(record.signal.aborted).toBe(false);
  });

  it('ends a permanently pending reader when the consumer reaches EOF', async () => {
    const record = await start();
    const pending = deferred<SdkCommand[]>();
    record.query.supportedCommands.mockReturnValue(pending.promise);
    const request = read();
    let observed: SlashCommand[] | undefined;
    void request.then(result => { observed = result; });
    await flushMicrotasks();
    await endNormally(record);
    const beforeResolution = observed;
    pending.resolve([oldCommand]);
    const result = await request;

    expect(beforeResolution).toEqual([]);
    expect(result).toEqual([]);
    expect(await read()).toEqual([]);
    expect(record.query.close).not.toHaveBeenCalled();
  });

  it('does not let the old consumer finally revoke a pending new Query', async () => {
    const oldRecord = await start();
    oldRecord.holdEof = true;
    await service.ensureReady({ force: true });
    await oldRecord.eofObserved;
    const newRecord = records[1];
    const pending = deferred<SdkCommand[]>();
    newRecord.query.supportedCommands.mockReturnValue(pending.promise);
    const freshRead = read();
    await flushMicrotasks();
    oldRecord.releaseEof();
    await flushMicrotasks();
    pending.resolve([newCommand]);

    expect(await freshRead).toEqual([mapped(newCommand)]);
    expect(await read()).toEqual([mapped(newCommand)]);
    expect(newRecord.query.supportedCommands).toHaveBeenCalledTimes(1);
    expect(newRecord.query.close).not.toHaveBeenCalled();
  });

  it('does not let a late old child exit revoke a ready new Query', async () => {
    const oldRecord = await start();
    await service.ensureReady({ force: true });
    const newRecord = records[1];
    newRecord.query.supportedCommands.mockResolvedValue([newCommand]);
    expect(await read()).toEqual([mapped(newCommand)]);

    oldRecord.child.emit('exit', 0);

    expect(await read()).toEqual([mapped(newCommand)]);
    expect(newRecord.query.supportedCommands).toHaveBeenCalledTimes(1);
    expect(newRecord.signal.aborted).toBe(false);
  });

  it('cancels only one caller without closing or aborting the borrowed Query', async () => {
    const record = await start();
    const pending = deferred<SdkCommand[]>();
    record.query.supportedCommands.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const cancelled = read(controller.signal);
    const remaining = read();
    let observed: SlashCommand[] | undefined;
    void cancelled.then(result => { observed = result; });
    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    const beforeResolution = observed;
    const callsWhilePending = record.query.supportedCommands.mock.calls.length;
    pending.resolve([oldCommand]);
    const [cancelledResult, remainingResult] = await Promise.all([cancelled, remaining]);

    expect(beforeResolution).toEqual([]);
    expect(cancelledResult).toEqual([]);
    expect(remainingResult).toEqual([mapped(oldCommand)]);
    expect(callsWhilePending).toBe(1);
    expect(record.query.close).not.toHaveBeenCalled();
    expect(record.query.interrupt).not.toHaveBeenCalled();
    expect(record.signal.aborted).toBe(false);
    expect(record.child.kill).not.toHaveBeenCalled();
  });

  it('does not invoke the getter for a caller already cancelled', async () => {
    const record = await start();
    const controller = new AbortController();
    controller.abort();

    expect(await read(controller.signal)).toEqual([]);
    expect(record.query.supportedCommands).not.toHaveBeenCalled();
    expect(record.query.close).not.toHaveBeenCalled();
    expect(record.signal.aborted).toBe(false);
  });

  describe('public typed facet', () => {
    it('invalidates unavailable eligibility when the same runtime installs a Query', async () => {
      const facet = service.getCommandDiscovery();
      const before = await withDeadline(facet.read(), 'absence read');
      expect(before.status).toBe('unavailable');
      expect(before.eligibility.revision).toBe(0);
      expect(facet.isCurrent(before.eligibility)).toBe(true);
      expect(sdkMock.getQueryCallCount()).toBe(0);
      expect(childProcess.spawn).not.toHaveBeenCalled();

      const invalidated: number[] = [];
      const unsubscribe = facet.subscribe(() => invalidated.push(invalidated.length));
      const record = await withDeadline(start(), 'chat startup');
      // The install event advanced the eligibility synchronously — no flush needed.
      expect(invalidated.length).toBeGreaterThan(0);
      expect(facet.isCurrent(before.eligibility)).toBe(false);

      record.query.supportedCommands.mockResolvedValue([oldCommand]);
      const ready = await withDeadline(facet.read(), 'ready read');
      expect(ready.status).toBe('ready');
      if (ready.status !== 'ready') throw new Error(`unreachable: ${ready.status}`);
      expect(ready.entries).toEqual([mapped(oldCommand)]);
      expect(facet.isCurrent(ready.eligibility)).toBe(true);
      expect(ready.eligibility).not.toBe(before.eligibility);
      unsubscribe();
    });

    it('reads the original Query and preserves ready empty with one getter flight', async () => {
      const record = await start();
      const pending = deferred<SdkCommand[]>();
      record.query.supportedCommands.mockReturnValue(pending.promise);
      const facet = service.getCommandDiscovery();

      const first = facet.read();
      const second = facet.read();
      await flushMicrotasks();
      const initObserved = deferred<void>();
      service.setPermissionModeSyncCallback(() => initObserved.resolve());
      triggerInit('lease-less', record);
      await initObserved.promise;
      await flushMicrotasks();
      const callsWhilePending = record.query.supportedCommands.mock.calls.length;
      pending.resolve([]);

      const [firstResult, secondResult] = await withDeadline(Promise.all([first, second]), 'typed reads');
      expect(callsWhilePending).toBe(1);
      expect(firstResult.status).toBe('ready');
      expect(secondResult.status).toBe('ready');
      if (firstResult.status !== 'ready' || secondResult.status !== 'ready') {
        throw new Error(`unreachable: ${firstResult.status}/${secondResult.status}`);
      }
      expect(firstResult.entries).toEqual([]);
      expect(secondResult.entries).toEqual([]);
      expect(firstResult.receipt.sourceKind).toBe('initialize-response');
      expect(firstResult.receipt.coverage).toBe('initialize-observed');
      expect(firstResult.receipt.scope.kind).toBe('actual-query');
      expect(firstResult.receipt.sourceRevision).toBe(secondResult.receipt.sourceRevision);
      expect(firstResult.receipt.sourceToken).toBe(secondResult.receipt.sourceToken);
      expect(firstResult.receipt.sourceToken).not.toBe(record.query);
      expect(firstResult.eligibility).toBe(secondResult.eligibility);
      expect(facet.isCurrent(firstResult.eligibility)).toBe(true);

      const shellFirst = await read();
      const shellSecond = await read();
      expect(shellFirst).toEqual([]);
      expect(shellSecond).toEqual([]);
      expect(shellFirst).not.toBe(shellSecond);
      expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);
    });

    it('does not retry a failed typed read unless explicitly requested', async () => {
      const record = await start();
      record.query.supportedCommands
        .mockRejectedValueOnce(new Error('mock getter failed'))
        .mockResolvedValueOnce([oldCommand]);
      const facet = service.getCommandDiscovery();

      const first = await withDeadline(facet.read(), 'first typed read');
      expect(first.status).toBe('failed');
      if (first.status !== 'failed') throw new Error(`unreachable: ${first.status}`);
      expect(first.code).toBe('query-command-read-failed');
      expect(facet.isCurrent(first.eligibility)).toBe(true);
      await flushMicrotasks();
      expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);

      const passive = await withDeadline(facet.read(), 'default typed re-read');
      const explicitNo = await withDeadline(facet.read(undefined, { retryFailed: false }), 'explicit no-retry');
      expect(passive.status).toBe('failed');
      expect(explicitNo.status).toBe('failed');
      expect(passive.eligibility).toBe(first.eligibility);
      expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);

      const explicitRetry = await withDeadline(facet.read(undefined, { retryFailed: true }), 'explicit retry');
      expect(explicitRetry.status).toBe('ready');
      if (explicitRetry.status !== 'ready') throw new Error(`unreachable: ${explicitRetry.status}`);
      expect(explicitRetry.entries).toEqual([mapped(oldCommand)]);
      // Getter completion advances the source revision, never the eligibility.
      expect(explicitRetry.eligibility).toBe(first.eligibility);
      expect(facet.isCurrent(explicitRetry.eligibility)).toBe(true);
      expect(record.query.supportedCommands).toHaveBeenCalledTimes(2);
    });

    it.each([['retire'], ['exit'], ['eof']] as const)(
      'revokes typed receipts on retire exit and EOF while caller cancellation stays isolated %#',
      async (end) => {
        const record = await start();
        const pending = deferred<SdkCommand[]>();
        record.query.supportedCommands.mockReturnValue(pending.promise);
        const facet = service.getCommandDiscovery();
        const invalidated: number[] = [];
        const unsubscribe = facet.subscribe(() => invalidated.push(invalidated.length));

        const inflight = facet.read();
        await flushMicrotasks();
        expect(record.query.supportedCommands).toHaveBeenCalledTimes(1);

        let rebuild: Promise<unknown>;
        if (end === 'retire') {
          const retiring = service.retireAndRebuildQuery('test-typed-facet');
          record.child.emit('exit', 0);
          rebuild = retiring;
        } else if (end === 'exit') {
          record.child.emit('exit', 0);
          rebuild = service.ensureReady({ force: true });
        } else {
          await endNormally(record);
          rebuild = service.ensureReady({ force: true });
        }
        // The revocation and its listener notification happened
        // synchronously with the retire/exit trigger (no await has run in
        // those branches); EOF landed within the consumer finally before
        // endNormally returned.
        expect(invalidated.length).toBeGreaterThan(0);
        await withDeadline(rebuild, 'rebuild');
        expect(records).toHaveLength(2);

        const stale = await withDeadline(inflight, 'stale typed read');
        expect(stale.status).toBe('stale');
        expect(facet.isCurrent(stale.eligibility)).toBe(false);

        const newRecord = records[1];
        const newPending = deferred<SdkCommand[]>();
        newRecord.query.supportedCommands.mockReturnValue(newPending.promise);
        const controller = new AbortController();
        const cancelledRead = facet.read(controller.signal);
        const remainingRead = facet.read();
        await flushMicrotasks();
        expect(newRecord.query.supportedCommands).toHaveBeenCalledTimes(1);
        controller.abort();
        const cancelled = await withDeadline(cancelledRead, 'cancelled typed read');
        expect(cancelled.status).toBe('cancelled');
        // Caller cancellation never advances the shared eligibility.
        expect(facet.isCurrent(cancelled.eligibility)).toBe(true);
        newPending.resolve([newCommand]);
        const remaining = await withDeadline(remainingRead, 'remaining typed read');
        expect(remaining.status).toBe('ready');
        if (remaining.status !== 'ready') throw new Error(`unreachable: ${remaining.status}`);
        expect(remaining.entries).toEqual([mapped(newCommand)]);
        expect(remaining.eligibility).toBe(cancelled.eligibility);
        expect(facet.isCurrent(remaining.eligibility)).toBe(true);
        expect(newRecord.query.close).not.toHaveBeenCalled();
        expect(newRecord.signal.aborted).toBe(false);

        // Late old-scope events must never revoke the new Query.
        record.child.emit('exit', 0);
        await flushMicrotasks();
        expect(facet.isCurrent(remaining.eligibility)).toBe(true);
        const cached = await withDeadline(facet.read(), 'cached read');
        expect(cached.status).toBe('ready');
        if (cached.status !== 'ready') throw new Error(`unreachable: ${cached.status}`);
        expect(cached.entries).toEqual([mapped(newCommand)]);
        expect(newRecord.query.supportedCommands).toHaveBeenCalledTimes(1);

        // A plain runtime.cancel() is an interrupt, not a command revocation.
        service.cancel();
        expect(facet.isCurrent(remaining.eligibility)).toBe(true);
        const afterCancel = await withDeadline(facet.read(), 'read after plain cancel');
        expect(afterCancel.status).toBe('ready');
        if (afterCancel.status !== 'ready') throw new Error(`unreachable: ${afterCancel.status}`);
        expect(afterCancel.entries).toEqual([mapped(newCommand)]);
        expect(newRecord.query.close).not.toHaveBeenCalled();

        unsubscribe();
        pending.resolve([]);
      },
    );

    it('captures applied Query scope before later directory settings change', async () => {
      const facet = service.getCommandDiscovery();
      await withDeadline(service.ensureReady({ externalContextPaths: ['/scope-A'] }), 'start with A');
      const recordA = records[records.length - 1];
      recordA.query.supportedCommands.mockResolvedValue([oldCommand]);
      const readA = await withDeadline(facet.read(), 'A read');
      expect(readA.status).toBe('ready');
      if (readA.status !== 'ready') throw new Error(`unreachable: ${readA.status}`);
      const scopeA = readA.receipt.scope;
      expect(scopeA.kind).toBe('actual-query');
      expect(scopeA.cwd).toBe(fixtureVaultPath());
      expect(scopeA.additionalDirectories).toEqual(['/scope-A']);
      expect(scopeA.settingSources).toEqual(['project', 'local']);
      expect(scopeA.unknown).toEqual([]);

      // The selector mutates the pending directory list without a restart —
      // the original Query keeps the scope it was created with.
      (service as unknown as { currentExternalContextPaths: string[] })
        .currentExternalContextPaths = ['/scope-B'];
      const stillA = await withDeadline(facet.read(), 'still A');
      expect(stillA.status).toBe('ready');
      if (stillA.status !== 'ready') throw new Error(`unreachable: ${stillA.status}`);
      expect(stillA.receipt.scope.additionalDirectories).toEqual(['/scope-A']);
      expect(stillA.receipt.sourceToken).toBe(readA.receipt.sourceToken);

      await withDeadline(service.ensureReady({ force: true }), 'restart with B');
      const recordB = records[records.length - 1];
      recordB.query.supportedCommands.mockResolvedValue([newCommand]);
      const readB = await withDeadline(facet.read(), 'B read');
      expect(readB.status).toBe('ready');
      if (readB.status !== 'ready') throw new Error(`unreachable: ${readB.status}`);
      expect(readB.receipt.scope.additionalDirectories).toEqual(['/scope-B']);
      expect(readB.receipt.scope.unknown).toEqual([]);
      expect(readB.receipt.sourceToken).not.toBe(readA.receipt.sourceToken);
      expect(recordB.query.supportedCommands).toHaveBeenCalledTimes(1);

      // A new Query without applied directories reports the dim unknown —
      // never fabricated from the mutable config.
      await withDeadline(service.ensureReady({ force: true, externalContextPaths: [] }), 'restart without dirs');
      const recordC = records[records.length - 1];
      recordC.query.supportedCommands.mockResolvedValue([oldCommand]);
      const readC = await withDeadline(facet.read(), 'no-dirs read');
      expect(readC.status).toBe('ready');
      if (readC.status !== 'ready') throw new Error(`unreachable: ${readC.status}`);
      expect(readC.receipt.scope.additionalDirectories).toBeUndefined();
      expect(readC.receipt.scope.unknown).toEqual(['additionalDirectories']);
    });
  });
});
