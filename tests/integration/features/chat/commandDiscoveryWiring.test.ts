/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */
import '@test/helpers/obsidianDom';
import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
// eslint-disable-next-line jest/no-mocks-import
import {
  getQueryCallCount,
  resetMockMessages,
  setMockSupportedCommands,
} from '@test/__mocks__/claude-agent-sdk';
import { installObsidianDom } from '@test/helpers/obsidianDom';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type { CommandDropdownSession, CommandDropdownSnapshot } from '@/core/providers/commands/ProviderCommandDiscovery';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { ClaudianView } from '@/features/chat/ClaudianView';
import {
  cleanupTabRuntime,
  createTab,
  destroyTab,
  initializeTabService,
  initializeTabUI,
  subscribeTabCommandContextChanges,
} from '@/features/chat/tabs/Tab';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type { TabData } from '@/features/chat/tabs/types';
import { type InlineEditContext,InlineEditModal } from '@/features/inline-edit/ui/InlineEditModal';
import type ClaudianPlugin from '@/main';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import { CodexSkillCatalog } from '@/providers/codex/commands/CodexSkillCatalog';
import { OpencodeCommandCatalog } from '@/providers/opencode/commands/OpencodeCommandCatalog';
import { SlashCommandDropdown } from '@/shared/components/SlashCommandDropdown';
import * as editorUtils from '@/utils/editor';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

jest.mock('fs', () => ({
  ...jest.createMockFromModule<object>('fs'),
  promises: {
    readdir: jest.fn().mockResolvedValue([]),
    access: jest.fn().mockRejectedValue(new Error('ENOENT')),
    readFile: jest.fn().mockRejectedValue(new Error('ENOENT')),
    stat: jest.fn().mockRejectedValue(new Error('ENOENT')),
    appendFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    isAlive: () => true,
    onExit: jest.fn(),
  })),
}));

type SdkCommand = { name: string; description: string; argumentHint?: string };
type MockQuery = AsyncGenerator<any> & {
  supportedCommands: jest.Mock;
  close: jest.Mock;
  interrupt: jest.Mock;
  pushStdoutMessage: (message: any) => void;
};

type MockChild = EventEmitter & {
  stdin: EventEmitter;
  stdout: EventEmitter & { destroyed: boolean };
  stderr: null;
  kill: jest.Mock;
};

const sdkMock = sdkModule as unknown as { query: jest.Mock };
const originalQuery = sdkModule.query;

interface QueryRecord {
  query: MockQuery;
  child: MockChild;
  signal: AbortSignal;
}

const records: QueryRecord[] = [];

/** Per-test hook: fires right after each mock Query is created (before any consumer reads it). */
let onQueryCreated: ((query: MockQuery) => void) | null = null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeMockChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(),
    stdout: Object.assign(new EventEmitter(), { destroyed: true }),
    stderr: null,
    kill: jest.fn(),
  });
}

function vaultFile(name: string): Record<string, string> {
  return {
    [`.claude/commands/${name}.md`]: `---\ndescription: ${name} command\n---\nBody of ${name}`,
  };
}

/** In-memory VaultFileAdapter shape: folders are inferred from file keys. */
function makeAdapter(files: Record<string, string>): VaultFileAdapter {
  const folderExists = (path: string) =>
    path in files || Object.keys(files).some(key => key.startsWith(`${path}/`));
  return {
    exists: jest.fn(async (path: string) => path in files || folderExists(path)),
    read: jest.fn(async (path: string) => {
      if (!(path in files)) throw new Error(`File not found: ${path}`);
      return files[path];
    }),
    write: jest.fn(async () => {}),
    delete: jest.fn(async () => {}),
    ensureFolder: jest.fn(async () => {}),
    rename: jest.fn(async () => {}),
    append: jest.fn(async () => {}),
    stat: jest.fn(async () => null),
    deleteFolder: jest.fn(async () => {}),
    listFiles: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : `${folder}/`;
      return Object.keys(files)
        .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .sort();
    }),
    listFolders: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : `${folder}/`;
      const folders = new Set<string>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const firstSlash = rest.indexOf('/');
        if (firstSlash >= 0) folders.add(prefix + rest.slice(0, firstSlash));
      }
      return Array.from(folders).sort();
    }),
    listFilesRecursive: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : `${folder}/`;
      return Object.keys(files).filter(key => key.startsWith(prefix)).sort();
    }),
  } as unknown as VaultFileAdapter;
}

let adapter: VaultFileAdapter;
let plugin: ClaudianPlugin;
let container: HTMLElement;
const managers: TabManager[] = [];

function makePlugin(): ClaudianPlugin {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS));
  settings.claudeCliPath = '/fixture/mock-claude';
  settings.claudeCliPaths = [];
  settings.loadUserClaudeSettings = false;
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/fixture/vault', getBasePath: () => '/fixture/vault',
          exists: async () => false, read: async () => '', write: async () => {},
          mkdir: async () => {}, list: async () => ({ files: [], folders: [] }),
        },
        getName: () => 'Fixture', on: jest.fn(), offref: jest.fn(),
        getFiles: () => [], getMarkdownFiles: () => [], getAllLoadedFiles: () => [],
      },
      workspace: {
        on: jest.fn(), offref: jest.fn(), getActiveFile: () => null,
        getActiveViewOfType: () => null, getLeavesOfType: () => [],
        revealLeaf: jest.fn(),
      },
      metadataCache: { on: jest.fn(), offref: jest.fn(), getFileCache: () => null },
    },
    settings,
    loadData: async () => ({}), saveData: async () => {},
    saveSettings: jest.fn().mockResolvedValue(undefined),
    storage: {
      getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
    },
    getActiveEnvironmentVariables: () => '',
    getResolvedProviderCliPath: () => '/fixture/mock-claude',
    getConversationSync: () => null,
    pluginManager: { getPluginsKey: jest.fn().mockReturnValue('') },
    getView: () => null,
  } as unknown as ClaudianPlugin;
}

function makeManager(): TabManager {
  const viewHost = {
    leaf: { id: 'fixture-leaf' },
    getTabManager: () => null,
    registerDomEvent: () => {},
    registerEvent: () => {},
    register: () => {},
    registerInterval: () => {},
  };
  const manager = new TabManager(plugin, container, viewHost as never, {});
  managers.push(manager);
  return manager;
}

async function publishProductionCatalog(files: Record<string, string> = vaultFile('vault-only')) {
  adapter = makeAdapter(files);
  const services = await createClaudeWorkspaceServices(plugin, adapter);
  ProviderWorkspaceRegistry.setServices('claude', services);
  return services;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    for (let j = 0; j < 25; j++) await Promise.resolve();
  }
}

function driveInput(tab: TabData, text: string): void {
  const inputEl = tab.dom.inputEl as HTMLTextAreaElement;
  inputEl.value = text;
  inputEl.selectionStart = text.length;
  inputEl.selectionEnd = text.length;
  inputEl.dispatchEvent(new window.Event('input'));
}

function typeSlash(tab: TabData): void {
  driveInput(tab, '/');
}

function dropdownElOf(tab: TabData): HTMLElement | null {
  return tab.dom.inputContainerEl.querySelector<HTMLElement>('.claudian-slash-dropdown');
}

function renderedNames(tab: TabData): string[] {
  const dropdownEl = dropdownElOf(tab);
  if (!dropdownEl) return [];
  return [...dropdownEl.querySelectorAll<HTMLElement>('.claudian-slash-name')]
    .map(el => el.textContent ?? '');
}

function dropdownConfigOf(tab: TabData): { createDiscoverySession: () => CommandDropdownSession } {
  const config = (tab.ui.slashCommandDropdown as unknown as { providerConfig: ProviderCommandDropdownConfig })
    .providerConfig;
  expect(typeof config?.createDiscoverySession).toBe('function');
  return config as { createDiscoverySession: () => CommandDropdownSession };
}

function readySnapshot(snapshot: CommandDropdownSnapshot): Extract<CommandDropdownSnapshot, { status: 'ready' }> {
  if (snapshot.status !== 'ready') {
    throw new Error(`expected a ready snapshot, got: ${JSON.stringify(snapshot.status)}`);
  }
  return snapshot;
}

function ensureTabService(tab: TabData): Promise<void> {
  return initializeTabService(tab, plugin, undefined, () => true);
}

async function warmTab(tab: TabData, commands: SdkCommand[]): Promise<void> {
  setMockSupportedCommands(commands);
  await ensureTabService(tab);
  const service = tab.service as unknown as { ensureReady(options?: { force?: boolean }): Promise<boolean> };
  expect(await service.ensureReady()).toBe(true);
}

const foreignCommand: SdkCommand = { name: 'foreign', description: 'other tab hot command', argumentHint: '' };
const hotCommand: SdkCommand = { name: 'sdk-hot', description: 'hot query command', argumentHint: '' };

beforeEach(async () => {
  installObsidianDom();
  jest.clearAllMocks();
  resetMockMessages();
  records.length = 0;
  onQueryCreated = null;
  sdkMock.query = jest.fn(((input: any) => {
    const child = makeMockChild();
    (childProcess.spawn as jest.Mock).mockReturnValueOnce(child);
    input.options.spawnClaudeCodeProcess({
      command: '/fixture/mock-claude',
      args: [],
      cwd: input.options.cwd,
      env: {},
      signal: input.options.abortController.signal,
    });
    const query = (originalQuery as any)(input) as MockQuery;
    records.push({ query, child, signal: input.options.abortController.signal });
    onQueryCreated?.(query);
    return query;
  }) as any);
  plugin = makePlugin();
  container = document.body.createDiv();
  await publishProductionCatalog();
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try { await manager.destroy(); } catch { /* per-tab teardown errors surface below */ }
  }
  ProviderWorkspaceRegistry.clear();
  resetMockMessages();
  jest.restoreAllMocks();
  document.body.replaceChildren();
});

describe('command discovery cross-entry wiring', () => {
  it('main blank shows vault builtins without owned probe or cross tab borrowing', async () => {
    const manager = makeManager();
    const tabA = await manager.createTab();
    expect(tabA).not.toBeNull();
    const tabB = await manager.createTab();
    expect(tabB).not.toBeNull();
    // The blank main tab under test must be the active one.
    await manager.switchToTab(tabA!.id);

    // Another hot tab exists with its own SDK command.
    await warmTab(tabB!, [foreignCommand]);
    expect(await tabB!.service!.getSupportedCommands()).toHaveLength(1);
    const queriesBefore = records.length;

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog('claude')!;
    const listLegacy = jest.spyOn(catalog, 'listDropdownEntries');
    const setRuntime = jest.spyOn(
      catalog as unknown as { setRuntimeCommands: (commands: unknown[]) => void },
      'setRuntimeCommands',
    );
    const getSdkCommands = jest.spyOn(
      TabManager.prototype as unknown as { getSdkCommands: () => unknown },
      'getSdkCommands',
    );

    typeSlash(tabA!);
    await settle();

    const names = renderedNames(tabA!);
    expect(names).toContain('/vault-only');
    expect(names).toContain('/clear');
    expect(names).not.toContain('/foreign');
    // Cold policy: no owned probe, no new Query, no legacy handoff, no
    // cross-tab getter, no global SDK setter.
    expect(records.length).toBe(queriesBefore);
    expect(getQueryCallCount()).toBe(queriesBefore);
    expect(listLegacy).not.toHaveBeenCalled();
    expect(setRuntime).not.toHaveBeenCalled();
    expect(getSdkCommands).not.toHaveBeenCalled();

    // Directory A→B→A: an old receipt never regains eligibility.
    const config = dropdownConfigOf(tabA!);
    const session = config.createDiscoverySession();
    const snapshot = readySnapshot(await session.read());
    expect(session.isCurrent(snapshot.receipt)).toBe(true);
    const selector = tabA!.ui.externalContextSelector!;
    selector.setExternalContexts(['/scope-a']);
    selector.setExternalContexts(['/scope-b']);
    selector.setExternalContexts(['/scope-a']);
    expect(session.isCurrent(snapshot.receipt)).toBe(false);
    session.release();

    const session2 = config.createDiscoverySession();
    const snapshot2 = readySnapshot(await session2.read());
    expect(session2.isCurrent(snapshot2.receipt)).toBe(true);
    expect(snapshot2.entries.map(entry => entry.name)).toEqual(['vault-only']);
    session2.release();

    // Runtime install commits notify command consumers synchronously.
    const notified = jest.fn();
    const unsubscribe = subscribeTabCommandContextChanges(tabA!, notified);
    const notificationsBefore = notified.mock.calls.length;
    await ensureTabService(tabA!);
    expect(notified.mock.calls.length).toBeGreaterThan(notificationsBefore);
    unsubscribe();
  });

  it('bound cold follows typed catalog policy without runtime startup', async () => {
    const manager = makeManager();
    // Branch one: runtime=null stays not-attempted and never starts a loader.
    const tabA = (await manager.createTab())!;
    typeSlash(tabA);
    await settle();
    expect(renderedNames(tabA)).toContain('/vault-only');
    expect(dropdownElOf(tabA)!.getAttribute('data-command-runtime-status')).toBe('not-attempted');
    expect(records.length).toBe(0);
    tabA.ui.slashCommandDropdown!.hide();

    // Branch two: a facade exists but no Query was started — unavailable(E0)
    // with the vault best-effort fallback, still without runtime startup.
    const tabB = (await manager.createTab())!;
    await ensureTabService(tabB);
    expect(tabB.service).not.toBeNull();
    expect(records.length).toBe(0);
    typeSlash(tabB);
    await settle();
    expect(dropdownElOf(tabB)!.getAttribute('data-command-runtime-status')).toBe('unavailable');
    expect(renderedNames(tabB)).toContain('/vault-only');
    expect(records.length).toBe(0);
    tabB.ui.slashCommandDropdown!.hide();

    // Hold the next vault scan: the read below stays pending on the flight
    // and must settle stale through the eligibility revocation alone.
    const pendingVault = deferred<string[]>();
    (adapter.listFilesRecursive as jest.Mock).mockImplementationOnce(() => pendingVault.promise);

    const config = dropdownConfigOf(tabB);
    const session = config.createDiscoverySession();
    const staleRead = session.read();
    await settle();

    const facet = (tabB.service as unknown as { getCommandDiscovery(): any }).getCommandDiscovery();
    const absence = await facet.read();
    expect(absence.status).toBe('unavailable');
    expect(facet.isCurrent(absence.eligibility)).toBe(true);

    // Same runtime installs a new Query: the absence eligibility dies first
    // and the hung read settles stale without the vault completing.
    const queriesBeforeInstall = records.length;
    setMockSupportedCommands([{ name: 'cold-sdk', description: 'cold sdk command', argumentHint: '' }]);
    const service = tabB.service as unknown as { ensureReady(options?: { force?: boolean }): Promise<boolean> };
    expect(await service.ensureReady()).toBe(true);
    expect(records.length).toBe(queriesBeforeInstall + 1);
    expect(facet.isCurrent(absence.eligibility)).toBe(false);
    expect((await staleRead).status).toBe('stale');

    // The late vault completion only settles the underlying flight; it can
    // never be published into later reads.
    pendingVault.resolve(['.claude/commands/late-vault.md']);
    await settle();

    const session2 = config.createDiscoverySession();
    // The first read can be invalidated by its own flight completion (design
    // risk 3); production retries through the invalidation listener, so the
    // mirror retry settles against the ready cache.
    let fresh = await session2.read();
    for (let attempt = 0; fresh.status === 'stale' && attempt < 3; attempt++) {
      fresh = await session2.read();
    }
    const ready = readySnapshot(fresh);
    expect(ready.entries.map(entry => entry.name)).toEqual(['cold-sdk']);
    expect(session2.isCurrent(ready.receipt)).toBe(true);

    // Runtime replacement revokes the previous ready receipt.
    expect(await service.ensureReady({ force: true })).toBe(true);
    expect(session2.isCurrent(ready.receipt)).toBe(false);

    // Runtime removal notifies and falls back to not-attempted vault reads.
    const notified = jest.fn();
    const unsubscribe = subscribeTabCommandContextChanges(tabB, notified);
    const beforeRemoval = notified.mock.calls.length;
    cleanupTabRuntime(tabB);
    expect(tabB.service).toBeNull();
    expect(notified.mock.calls.length).toBeGreaterThan(beforeRemoval);
    unsubscribe();

    const session3 = config.createDiscoverySession();
    const afterRemoval = readySnapshot(await session3.read());
    expect(afterRemoval.runtime.status).toBe('not-attempted');
    expect(afterRemoval.entries.map(entry => entry.name)).toEqual(['vault-only']);
    session3.release();
    session2.release();
    session.release();
  });

  it('registry fallback initializes and replaces an unbound catalog', async () => {
    const manager = makeManager();
    const active = (await manager.createTab())!;
    await warmTab(active, [foreignCommand]);

    // A tab outside any manager: the registry fallback owns its wiring.
    const orphan = createTab({ plugin, containerEl: document.body.createDiv() });
    initializeTabUI(orphan, plugin);
    const dropdown = orphan.ui.slashCommandDropdown!;
    expect(dropdown).toBeInstanceOf(SlashCommandDropdown);
    const setCatalogSpy = jest.spyOn(dropdown, 'setProviderCatalog');
    const resetCacheSpy = jest.spyOn(dropdown, 'resetSdkSkillsCache');

    typeSlash(orphan);
    await settle();
    const orphanNames = renderedNames(orphan);
    expect(orphanNames).toContain('/vault-only');
    expect(orphanNames).toContain('/clear');
    // An active hot tab exists, but the unbound factory never borrows it.
    expect(orphanNames).not.toContain('/foreign');
    const oldItemEl = dropdownElOf(orphan)!.querySelector<HTMLElement>('.claudian-slash-item')!;
    expect(oldItemEl).not.toBeNull();

    // Catalog replacement C1→C2 rebinds synchronously and clears old DOM.
    const services2 = await createClaudeWorkspaceServices(plugin, makeAdapter(vaultFile('vault-second')));
    ProviderWorkspaceRegistry.setServices('claude', services2);
    expect(setCatalogSpy).toHaveBeenCalledTimes(1);
    const [replacementConfig, , replacementProviderId] = setCatalogSpy.mock.calls[0];
    expect(typeof replacementConfig?.createDiscoverySession).toBe('function');
    expect(replacementProviderId).toBe('claude');
    expect(renderedNames(orphan)).toEqual([]);
    oldItemEl.click();
    expect((orphan.dom.inputEl as HTMLTextAreaElement).value).toBe('/');

    typeSlash(orphan);
    await settle();
    const secondNames = renderedNames(orphan);
    expect(secondNames).toContain('/vault-second');
    expect(secondNames).not.toContain('/vault-only');

    // An effective directory change resets the unbound menu too.
    orphan.ui.externalContextSelector!.setExternalContexts(['/scope-x']);
    expect(resetCacheSpy).toHaveBeenCalledTimes(1);

    // Clear withdraws the catalog: the fallback listener rebinds the
    // dropdown to null while keeping the provider identity, and the
    // replaced factory's receipts can no longer be consumed.
    ProviderWorkspaceRegistry.setServices('claude', undefined);
    expect(setCatalogSpy).toHaveBeenCalledTimes(2);
    const [clearedConfig, clearedEntries, clearedProviderId] = setCatalogSpy.mock.calls[1];
    expect(clearedConfig).toBeNull();
    expect(clearedEntries).toBeNull();
    expect(clearedProviderId).toBe('claude');
    expect(resetCacheSpy).toHaveBeenCalledTimes(1);
    oldItemEl.click();
    expect((orphan.dom.inputEl as HTMLTextAreaElement).value).toBe('/');
    typeSlash(orphan);
    await settle();
    // The cleared registry leaves builtins alone; the vault command is gone.
    const clearedNames = renderedNames(orphan);
    expect(clearedNames).toContain('/clear');
    expect(clearedNames).not.toContain('/vault-second');

    // Destroy unsubscribes: later registry changes never reach the dead tab.
    await destroyTab(orphan);
    ProviderWorkspaceRegistry.setServices('claude', services2);
    expect(setCatalogSpy).toHaveBeenCalledTimes(2);
  });

  it('manager blank tab rebinds the catalog when availability falls back to codex', async () => {
    // Enable the optional providers; the blank tab starts on OpenCode.
    const providerConfigs = (plugin.settings as unknown as {
      providerConfigs: Record<string, { enabled: boolean }>;
    }).providerConfigs;
    providerConfigs.opencode.enabled = true;
    providerConfigs.codex.enabled = true;

    const opencodeCatalog = new OpencodeCommandCatalog();
    ProviderWorkspaceRegistry.setServices('opencode', { commandCatalog: opencodeCatalog });
    const codexListProvider = {
      listSkills: jest.fn().mockResolvedValue([{
        name: 's3-codex-skill',
        path: '/skills/s3-codex-skill/SKILL.md',
        scope: 'user',
        enabled: true,
        description: 'codex skill',
      }]),
      invalidate: jest.fn(),
    };
    const codexCatalog = new CodexSkillCatalog({} as never, codexListProvider, null);
    ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: codexCatalog });

    const manager = makeManager();
    const tab = (await manager.createTab(null, undefined, {
      draftProviderId: 'opencode',
      draftModel: 'opencode',
    }))!;
    expect(tab.providerId).toBe('opencode');
    const dropdown = tab.ui.slashCommandDropdown!;
    const initialConfig = (dropdown as unknown as { providerConfig: ProviderCommandDropdownConfig })
      .providerConfig;
    expect(initialConfig.providerId).toBe('opencode');

    typeSlash(tab);
    await settle();
    const openCodeNames = renderedNames(tab);
    expect(openCodeNames).toContain('/clear');
    expect(openCodeNames).toContain('/resume');
    // OpenCode neither forks nor exposes a $ trigger char.
    expect(openCodeNames).not.toContain('/fork');
    dropdown.hide();
    driveInput(tab, '$');
    await settle();
    expect(dropdownElOf(tab)!.hasClass('visible')).toBe(false);

    // The revocation channel must fire before the rebind during fallback.
    const notified = jest.fn();
    const unsubscribe = subscribeTabCommandContextChanges(tab, notified);
    const setCatalogSpy = jest.spyOn(dropdown, 'setProviderCatalog');
    providerConfigs.opencode.enabled = false;

    // Real availability refresh: the production view path drives the fallback.
    const view = Object.create(ClaudianView.prototype) as unknown as {
      plugin: ClaudianPlugin;
      tabManager: TabManager;
      refreshModelSelector(): void;
    };
    view.plugin = plugin;
    view.tabManager = manager;
    view.refreshModelSelector();

    expect(tab.providerId).toBe('codex');
    expect(notified.mock.calls.length).toBeGreaterThan(0);
    // The manager rebind uses its own catalog config and the codex identity;
    // the stale OpenCode menu is withdrawn with it.
    expect(setCatalogSpy.mock.calls.length).toBeGreaterThan(0);
    const [fallbackConfig, fallbackEntries, fallbackProviderId] = setCatalogSpy.mock.calls.at(-1)!;
    expect(fallbackConfig?.providerId).toBe('codex');
    expect(typeof fallbackEntries).toBe('function');
    expect(fallbackProviderId).toBe('codex');
    expect(renderedNames(tab)).toEqual([]);
    unsubscribe();

    // The codex identity carries over the trigger chars and builtins.
    typeSlash(tab);
    await settle();
    const codexNames = renderedNames(tab);
    expect(codexNames).toContain('/clear');
    expect(codexNames).toContain('/fork');
    expect(codexNames).toContain('$s3-codex-skill');
    driveInput(tab, '$');
    await settle();
    expect(renderedNames(tab)).toContain('$s3-codex-skill');
    // $ trigger stays builtin-free (displayPrefix renders on every name).
    expect(renderedNames(tab)).not.toContain('/clear');

    // The manager subscription propagates a codex catalog replacement to
    // the rebinding tab and withdraws the rendered skills.
    const nextCodexCatalog = new CodexSkillCatalog({} as never, {
      listSkills: jest.fn().mockResolvedValue([{
        name: 's3-codex-next',
        path: '/skills/s3-codex-next/SKILL.md',
        scope: 'user',
        enabled: true,
        description: 'next codex skill',
      }]),
      invalidate: jest.fn(),
    }, null);
    const replacementCalls = setCatalogSpy.mock.calls.length;
    ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: nextCodexCatalog });
    expect(setCatalogSpy.mock.calls.length).toBe(replacementCalls + 1);
    const [replacedConfig, , replacedProviderId] = setCatalogSpy.mock.calls.at(-1)!;
    expect(replacedConfig?.providerId).toBe('codex');
    expect(replacedProviderId).toBe('codex');
    expect(renderedNames(tab)).toEqual([]);
    typeSlash(tab);
    await settle();
    expect(renderedNames(tab)).toContain('$s3-codex-next');
    expect(renderedNames(tab)).not.toContain('$s3-codex-skill');

    // Clearing the codex catalog keeps the codex builtins but drops skills.
    const beforeClear = setCatalogSpy.mock.calls.length;
    ProviderWorkspaceRegistry.setServices('codex', undefined);
    expect(setCatalogSpy.mock.calls.length).toBe(beforeClear + 1);
    const [clearedConfig, clearedEntries, clearedProviderId] = setCatalogSpy.mock.calls.at(-1)!;
    expect(clearedConfig).toBeNull();
    expect(clearedEntries).toBeNull();
    expect(clearedProviderId).toBe('codex');
    expect(renderedNames(tab)).toEqual([]);
    typeSlash(tab);
    await settle();
    const clearedNames = renderedNames(tab);
    expect(clearedNames).toContain('/clear');
    expect(clearedNames).toContain('/fork');
    expect(clearedNames).not.toContain('$s3-codex-next');
    setCatalogSpy.mockRestore();
  });

  it('inline unbound discovery rebinds and releases across catalog changes', async () => {
    const manager = makeManager();
    const active = (await manager.createTab())!;
    await warmTab(active, [foreignCommand]);

    // Real Inline entry: openAndWait drives the production input DOM. The
    // registry subscribe is wrapped only to observe the unsubscribe handle.
    const realSubscribe = ProviderWorkspaceRegistry.subscribeCommandCatalog.bind(ProviderWorkspaceRegistry);
    const unsubscribeSpy = jest.fn();
    jest.spyOn(ProviderWorkspaceRegistry, 'subscribeCommandCatalog')
      .mockImplementation((providerId, listener) => {
        const unsubscribe = realSubscribe(providerId, listener);
        return () => { unsubscribeSpy(); unsubscribe(); };
      });
    (plugin as unknown as { getView: () => unknown }).getView = () => ({
      getActiveTab: () => manager.getActiveTab(),
    });

    let widget: any = null;
    const editorView = {
      state: { doc: { line: () => ({ from: 0 }), lineAt: () => ({ from: 0 }) } },
      dispatch: (transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const candidate = effect?.value?.widget;
          if (candidate && typeof candidate.createInputDOM === 'function') {
            widget = candidate;
            widget.createInputDOM();
          }
        }
      },
      dom: { addEventListener: jest.fn(), removeEventListener: jest.fn() },
    } as any;
    jest.spyOn(editorUtils, 'getEditorView').mockReturnValue(editorView);

    const editContext: InlineEditContext = {
      mode: 'cursor',
      cursorContext: { beforeCursor: '', afterCursor: '', isInbetween: true, line: 0, column: 0 },
    };
    const modal = new InlineEditModal(
      { vault: { getFiles: () => [], getAllLoadedFiles: () => [] }, workspace: {} } as any,
      plugin,
      {} as any,
      { editor: {} } as any,
      editContext,
      'note.md',
      () => [],
    );
    const resultPromise = modal.openAndWait();
    await settle();
    expect(widget).not.toBeNull();

    const inlineInput = widget.inputEl as HTMLInputElement;
    const inlineTypeSlash = (text: string) => {
      inlineInput.value = text;
      inlineInput.selectionStart = text.length;
      inlineInput.selectionEnd = text.length;
      inlineInput.dispatchEvent(new window.Event('input'));
    };
    const inlineNames = (): string[] => [...document.body.querySelectorAll<HTMLElement>('.claudian-slash-dropdown')]
      .flatMap(el => [...el.querySelectorAll<HTMLElement>('.claudian-slash-name')].map(n => n.textContent ?? ''));

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog('claude')!;
    const listLegacy = jest.spyOn(catalog, 'listDropdownEntries');

    inlineTypeSlash('/');
    await settle();
    const names = inlineNames();
    expect(names).toContain('/vault-only');
    expect(names).toContain('/clear');
    // The active chat's hot SDK commands are never borrowed.
    expect(names).not.toContain('/foreign');
    expect(listLegacy).not.toHaveBeenCalled();

    // Registry replacement synchronously withdraws the rendered options.
    const services2 = await createClaudeWorkspaceServices(plugin, makeAdapter(vaultFile('inline-second')));
    ProviderWorkspaceRegistry.setServices('claude', services2);
    expect(inlineNames()).toEqual([]);
    inlineTypeSlash('/');
    await settle();
    expect(inlineNames()).toContain('/inline-second');
    expect(inlineNames()).not.toContain('/vault-only');

    // Clear rebinds the inline dropdown to null; builtins remain.
    ProviderWorkspaceRegistry.setServices('claude', undefined);
    inlineTypeSlash('/');
    await settle();
    const cleared = inlineNames();
    expect(cleared).toContain('/clear');
    expect(cleared).not.toContain('/inline-second');

    // cleanup() unsubscribes before destroying the dropdown: later registry
    // notifications never call back into the released UI.
    const unsubBeforeCleanup = unsubscribeSpy.mock.calls.length;
    widget.reject();
    await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
    // Only the modal's own registry handle is consumed by cleanup.
    expect(unsubscribeSpy.mock.calls.length).toBe(unsubBeforeCleanup + 1);
    const catalogCallCount = listLegacy.mock.calls.length;
    ProviderWorkspaceRegistry.setServices('claude', services2);
    expect(inlineNames()).toEqual([]);
    expect(listLegacy.mock.calls.length).toBe(catalogCallCount);
  });

  it('active Query commands retain receipts and reject old consumers', async () => {
    const manager = makeManager();
    const tab = (await manager.createTab())!;
    await warmTab(tab, [hotCommand]);
    const query = records[records.length - 1].query;

    typeSlash(tab);
    await settle();
    const hotNames = renderedNames(tab);
    expect(hotNames).toContain('/sdk-hot');
    expect(hotNames).toContain('/clear');
    // Runtime ready with raw>0: the vault is not rescanned into the list.
    expect(hotNames).not.toContain('/vault-only');
    expect(dropdownElOf(tab)!.getAttribute('data-command-runtime-status')).toBe('ready');

    // A second menu read reuses the retained receipt — one getter flight.
    driveInput(tab, '/sdk');
    await settle();
    expect(query.supportedCommands).toHaveBeenCalledTimes(1);
    expect(renderedNames(tab)).toEqual(['/sdk-hot']);

    // Mid-sentence '/': position-0 builtin policy stays out; provider only.
    driveInput(tab, 'note /');
    await settle();
    expect(renderedNames(tab)).toEqual(['/sdk-hot']);
    expect(renderedNames(tab)).not.toContain('/clear');

    // '$' is not a Claude trigger char: the menu never opens.
    driveInput(tab, '$');
    await settle();
    expect(dropdownElOf(tab)!.hasClass('visible')).toBe(false);

    // Ready-empty is preserved with the vault fallback and no extra flights.
    setMockSupportedCommands([]);
    const service = tab.service as unknown as { ensureReady(options?: { force?: boolean }): Promise<boolean> };
    expect(await service.ensureReady({ force: true })).toBe(true);
    const emptyQuery = records[records.length - 1].query;
    typeSlash(tab);
    await settle();
    expect(emptyQuery.supportedCommands).toHaveBeenCalledTimes(1);
    const emptyNames = renderedNames(tab);
    expect(emptyNames).toContain('/vault-only');
    expect(emptyNames).toContain('/clear');
    expect(dropdownElOf(tab)!.getAttribute('data-command-runtime-status')).toBe('ready');
    driveInput(tab, '/vault');
    await settle();
    expect(emptyQuery.supportedCommands).toHaveBeenCalledTimes(1);
    expect(renderedNames(tab)).toEqual(['/vault-only']);

    // A cancelled read never publishes its late result. The getter is held
    // from Query creation: the first consumer (warmup or menu read) hangs.
    setMockSupportedCommands([{ name: 'late-sdk', description: 'late', argumentHint: '' }]);
    const pendingCommands = deferred<SdkCommand[]>();
    onQueryCreated = query => {
      query.supportedCommands.mockImplementationOnce(() => pendingCommands.promise as Promise<any>);
    };
    expect(await service.ensureReady({ force: true })).toBe(true);
    const lateQuery = records[records.length - 1].query;
    typeSlash(tab);
    await settle();
    // The read is still pending: the late command is not published yet.
    expect(renderedNames(tab)).not.toContain('/late-sdk');
    tab.ui.slashCommandDropdown!.hide();
    pendingCommands.resolve([{ name: 'late-sdk', description: 'late', argumentHint: '' }]);
    await settle();
    // The late completion withdraws the hidden menu's element (source-change
    // withdrawal) and never publishes; the F1 guard keeps it closed.
    expect(tab.ui.slashCommandDropdown!.isVisible()).toBe(false);
    expect(renderedNames(tab)).not.toContain('/late-sdk');
    expect(lateQuery.close).not.toHaveBeenCalled();
    expect(lateQuery.interrupt).not.toHaveBeenCalled();

    // Two dropdowns share the same Query; hiding one never closes it for the
    // other consumer.
    const config = dropdownConfigOf(tab);
    const secondContainer = document.body.createDiv();
    const secondInput = document.createElement('input');
    secondContainer.appendChild(secondInput);
    const secondDropdown = new SlashCommandDropdown(
      secondContainer,
      secondInput,
      { onSelect: () => {}, onHide: () => {} },
      { providerConfig: { ...config } as ProviderCommandDropdownConfig },
    );
    secondInput.value = '/';
    secondInput.selectionStart = 1;
    secondInput.selectionEnd = 1;
    secondInput.dispatchEvent(new window.Event('input'));
    await settle();
    const secondNames = [...secondContainer.querySelectorAll<HTMLElement>('.claudian-slash-name')]
      .map(el => el.textContent ?? '');
    // The fresh consumer reads the shared Query's live cached state; only
    // the hidden first dropdown was denied publication.
    expect(secondNames).toContain('/late-sdk');
    expect(lateQuery.close).not.toHaveBeenCalled();
    expect(lateQuery.interrupt).not.toHaveBeenCalled();
    expect(records[records.length - 1].signal.aborted).toBe(false);
    secondDropdown.destroy();
  });
});
