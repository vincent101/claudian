/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */
import '@test/helpers/obsidianDom';
import '@/providers';

// eslint-disable-next-line jest/no-mocks-import
import { getLastOptions, resetMockMessages, setMockMessages } from '@test/__mocks__/claude-agent-sdk';
import { installObsidianDom } from '@test/helpers/obsidianDom';
import * as fs from 'fs';
import { Notice } from 'obsidian';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SharedStorageService } from '@/app/storage/SharedStorageService';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  createTab,
  getTabProviderId,
  initializeTabControllers,
  initializeTabService,
  initializeTabUI,
  onProviderAvailabilityChanged,
} from '@/features/chat/tabs/Tab';
import type { TabData } from '@/features/chat/tabs/types';
import type ClaudianPlugin from '@/main';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { CodexChatRuntime } from '@/providers/codex/runtime/CodexChatRuntime';

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

const mockRpcCalls: Array<{ method: string; params: any }> = [];
const mockNotificationHandlers = new Map<string, (params: any) => void>();
jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    isAlive: () => true,
    onExit: jest.fn(),
  })),
}));
jest.mock('@/providers/codex/runtime/CodexRpcTransport', () => ({
  CodexRpcTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn(), notify: jest.fn(), dispose: jest.fn(), onServerRequest: jest.fn(),
    onNotification: (method: string, handler: (params: any) => void) => mockNotificationHandlers.set(method, handler),
    request: async (method: string, params: any) => {
      mockRpcCalls.push({ method, params });
      if (method === 'initialize') return {
        platformOs: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix', codexHome: '/fixture/codex',
      };
      if (method === 'thread/start') return { thread: { id: 'fixture-thread' } };
      if (method === 'turn/start') {
        queueMicrotask(() => mockNotificationHandlers.get('turn/completed')?.({
          threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' },
        }));
        return { turn: { id: 'fixture-turn' } };
      }
      return {};
    },
  })),
}));

function pluginFixture(): ClaudianPlugin {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS));
  settings.model = 'shared-a';
  settings.settingsProvider = 'claude';
  settings.providerConfigs.claude.modelPresets = [
    { label: 'Claude A', model: 'shared-a' }, { label: 'Claude B', model: 'shared-b' },
    { label: 'Claude Only', model: 'claude-only' },
  ];
  settings.providerConfigs.claude.loadUserSettings = false;
  settings.providerConfigs.codex.enabled = true;
  settings.providerConfigs.codex.modelPresets = [
    { label: 'Codex A', model: 'shared-a' }, { label: 'Codex B', model: 'shared-b' },
  ];
  settings.savedProviderModel = { claude: 'shared-a', codex: 'shared-a' };
  const adapter = {
    basePath: '/fixture/vault', getBasePath: () => '/fixture/vault',
    exists: async () => false, read: async () => '', write: async () => {},
    mkdir: async () => {}, list: async () => ({ files: [], folders: [] }),
  };
  return {
    settings,
    app: {
      vault: {
        adapter, getName: () => 'Fixture', on: jest.fn(), offref: jest.fn(),
        getFiles: () => [], getMarkdownFiles: () => [], getAllLoadedFiles: () => [],
      },
      workspace: { on: jest.fn(), offref: jest.fn(), getActiveFile: () => null },
      metadataCache: { on: jest.fn(), offref: jest.fn(), getFileCache: () => null },
    },
    loadData: async () => ({}), saveData: async () => {}, saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: () => '', getResolvedProviderCliPath: () => '/fixture/cli',
    getConversationSync: () => null, getConversationById: async () => null,
  } as unknown as ClaudianPlugin;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function clickModel(tab: TabData, label: string): void {
  const option = [...tab.dom.contentEl.querySelectorAll<HTMLElement>('.claudian-model-option')]
    .find(el => el.textContent === label);
  if (!option) throw new Error(`Missing model option ${label}`);
  option.click();
}

const tabs: TabData[] = [];
let plugin: ClaudianPlugin;
beforeEach(async () => {
  installObsidianDom();
  jest.clearAllMocks();
  resetMockMessages();
  mockRpcCalls.length = 0;
  mockNotificationHandlers.clear();
  (fs.existsSync as jest.Mock).mockReturnValue(false);
  (fs.readdirSync as jest.Mock).mockReturnValue([]);
  (fs.promises.readdir as jest.Mock).mockResolvedValue([]);
  (fs.promises.access as jest.Mock).mockRejectedValue(new Error('ENOENT'));
  plugin = pluginFixture();
  ProviderWorkspaceRegistry.setServices('claude', await createClaudeWorkspaceServices(plugin, new VaultFileAdapter(plugin.app)));
});
afterEach(() => {
  for (const tab of tabs.splice(0)) {
    tab.service?.cleanup();
    tab.dom.eventCleanups.forEach(cleanup => cleanup());
    tab.dom.contentEl.remove();
  }
  ProviderWorkspaceRegistry.clear();
});

function blankTab(): TabData {
  const tab = createTab({ plugin, containerEl: document.body });
  tabs.push(tab);
  initializeTabUI(tab, plugin);
  return tab;
}

function boundClaudeTab(): TabData {
  const conversation = {
    id: 'fixture-conversation',
    providerId: 'claude' as const,
    title: 'Fixture',
    messages: [],
    sessionId: 'fixture-session',
    createdAt: 0,
    updatedAt: 0,
  };
  plugin.getConversationSync = () => conversation;
  const tab = createTab({ plugin, containerEl: document.body, conversation });
  tabs.push(tab);
  initializeTabUI(tab, plugin);
  return tab;
}

function boundCodexTab(): TabData {
  const conversation = {
    id: 'fixture-codex-conversation',
    providerId: 'codex' as const,
    title: 'Fixture Codex',
    messages: [],
    sessionId: null,
    createdAt: 0,
    updatedAt: 0,
  };
  plugin.getConversationSync = () => conversation;
  const tab = createTab({ plugin, containerEl: document.body, conversation });
  tabs.push(tab);
  initializeTabUI(tab, plugin);
  return tab;
}

async function sendTurn(tab: TabData): Promise<void> {
  const runtime = tab.service!;
  setMockMessages([]);
  const turn = runtime.prepareTurn({ text: 'hello', turnId: 'fixture-turn' });
  for await (const chunk of runtime.query(turn, [])) { void chunk; /* Consume real runtime output. */ }
}

describe('provider/model identity across the real selector and runtime', () => {
  it('labels the mixed list with provider groups, icons, and exactly one selected pair', () => {
    const tab = blankTab();
    const contentEl = tab.dom.contentEl;

    // Group headers carry the owning provider's display name for both sides.
    const groups = [...contentEl.querySelectorAll<HTMLElement>('.claudian-model-group')]
      .map(el => el.textContent);
    expect(groups).toEqual(expect.arrayContaining(['Claude', 'Codex']));
    expect(groups).toHaveLength(2);

    // Every option carries its provider icon — identity travels with the
    // option, not with the label text.
    const options = [...contentEl.querySelectorAll<HTMLElement>('.claudian-model-option')];
    expect(options.length).toBeGreaterThanOrEqual(5);
    for (const option of options) {
      expect(option.querySelector('.claudian-model-provider-icon')).not.toBeNull();
    }

    // Both providers expose 'shared-a'/'shared-b'; only one complete pair is selected.
    const selected = contentEl.querySelectorAll('.claudian-model-option.selected');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe('Claude A');
  });

  it.each(['claude', 'codex'])('blank %s selection reaches its real runtime and external transport', async providerId => {
    const tab = blankTab();
    clickModel(tab, providerId === 'claude' ? 'Codex B' : 'Claude B');
    await flush();
    clickModel(tab, providerId === 'claude' ? 'Claude B' : 'Codex B');
    await flush();
    expect(getTabProviderId(tab, plugin)).toBe(providerId);
    expect(ProviderSettingsCoordinator.getProviderSettingsSnapshot(plugin.settings as unknown as Record<string, unknown>, providerId).model)
      .toBe('shared-b');
    await initializeTabService(tab, plugin);
    const runtime = tab.service!;
    expect(runtime).toBeInstanceOf(providerId === 'claude' ? ClaudianService : CodexChatRuntime);
    await sendTurn(tab);
    const claudeModel = getLastOptions()?.model;
    const codexThreadModel = mockRpcCalls.find(call => call.method === 'thread/start')?.params.model;
    const codexTurnModel = mockRpcCalls.find(call => call.method === 'turn/start')?.params.model;
    expect(providerId === 'claude' ? claudeModel : codexThreadModel).toBe('shared-b');
    expect(providerId === 'claude' ? claudeModel : codexTurnModel).toBe('shared-b');
    expect(Notice).not.toHaveBeenCalled();
  });
});

describe('bound tab model switches', () => {
  it('re-denominates a bound claude tab within its provider and reaches the SDK', async () => {
    const tab = boundClaudeTab();
    expect(tab.lifecycleState).toBe('bound_cold');

    clickModel(tab, 'Claude B');
    await flush();
    expect(plugin.settings.savedProviderModel.claude).toBe('shared-b');

    await initializeTabService(tab, plugin);
    await sendTurn(tab);
    expect(getLastOptions()?.model).toBe('shared-b');
  });

  it('never offers cross-provider options on a bound claude tab, even for the same model ID', () => {
    const tab = boundClaudeTab();

    const labels = [...tab.dom.contentEl.querySelectorAll<HTMLElement>('.claudian-model-option')]
      .map(el => el.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Claude A', 'Claude B', 'Claude Only']));
    expect(labels.some(label => label === 'Codex A' || label === 'Codex B')).toBe(false);
    expect(tab.providerId).toBe('claude');
  });

  it('keeps the active runtime instance when switching within the provider', async () => {
    const tab = boundClaudeTab();
    await initializeTabService(tab, plugin);
    const runtime = tab.service;
    expect(runtime).toBeInstanceOf(ClaudianService);

    clickModel(tab, 'Claude B');
    await flush();

    expect(tab.service).toBe(runtime);
    expect(tab.lifecycleState).toBe('bound_active');
  });

  it('re-denominates a bound codex tab within its provider and reaches the RPC transport', async () => {
    const tab = boundCodexTab();
    expect(tab.lifecycleState).toBe('bound_cold');
    expect(tab.providerId).toBe('codex');

    clickModel(tab, 'Codex B');
    await flush();
    expect(plugin.settings.savedProviderModel.codex).toBe('shared-b');

    await initializeTabService(tab, plugin);
    expect(tab.service).toBeInstanceOf(CodexChatRuntime);
    mockRpcCalls.length = 0;
    await sendTurn(tab);
    expect(mockRpcCalls.find(call => call.method === 'thread/start')?.params.model).toBe('shared-b');
    expect(mockRpcCalls.find(call => call.method === 'turn/start')?.params.model).toBe('shared-b');
  });

  it('never offers cross-provider options on a bound codex tab, even for the same model ID', () => {
    const tab = boundCodexTab();

    const labels = [...tab.dom.contentEl.querySelectorAll<HTMLElement>('.claudian-model-option')]
      .map(el => el.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Codex A', 'Codex B']));
    expect(labels.some(label => label === 'Claude A' || label === 'Claude B' || label === 'Claude Only')).toBe(false);
    expect(tab.providerId).toBe('codex');
  });

  it('keeps the active codex runtime instance when switching within the provider', async () => {
    const tab = boundCodexTab();
    await initializeTabService(tab, plugin);
    const runtime = tab.service;
    expect(runtime).toBeInstanceOf(CodexChatRuntime);

    clickModel(tab, 'Codex B');
    await flush();

    expect(tab.service).toBe(runtime);
    expect(tab.lifecycleState).toBe('bound_active');
  });
});

describe('draft persistence across save and restore', () => {
  it('round-trips an explicit codex draft pair through storage and sends it', async () => {
    const tab = blankTab();
    clickModel(tab, 'Codex B');
    await flush();
    expect(tab.draftProviderId).toBe('codex');
    expect(tab.draftModel).toBe('shared-b');

    let storedData: Record<string, unknown> = {};
    plugin.loadData = async () => storedData;
    plugin.saveData = async (data: Record<string, unknown>) => { storedData = data; };

    const storage = new SharedStorageService(plugin);
    await storage.setTabManagerState({
      openTabs: [{ tabId: 'draft-tab', conversationId: null, draftModel: tab.draftModel, draftProviderId: 'codex' }],
      activeTabId: 'draft-tab',
    });
    const restoredState = await storage.getTabManagerState();
    expect(restoredState?.openTabs[0]).toMatchObject({ draftModel: 'shared-b', draftProviderId: 'codex' });

    // Fresh plugin instance simulates a reload; the restore path feeds the
    // persisted pair straight into createTab, exactly like TabManager.
    plugin = pluginFixture();
    ProviderWorkspaceRegistry.setServices('claude', await createClaudeWorkspaceServices(plugin, new VaultFileAdapter(plugin.app)));
    const restored = createTab({
      plugin,
      containerEl: document.body,
      tabId: 'draft-tab',
      draftModel: restoredState?.openTabs[0].draftModel,
      draftProviderId: restoredState?.openTabs[0].draftProviderId,
    });
    tabs.push(restored);
    expect(getTabProviderId(restored, plugin)).toBe('codex');

    await initializeTabService(restored, plugin);
    expect(restored.service).toBeInstanceOf(CodexChatRuntime);
    await sendTurn(restored);
    expect(mockRpcCalls.find(call => call.method === 'thread/start')?.params.model).toBe('shared-b');
  });

  it('fills the unique legacy draft provider without guessing the ambiguous one', () => {
    const uniqueTab = createTab({ plugin, containerEl: document.body, tabId: 'legacy-unique', draftModel: 'claude-only' });
    tabs.push(uniqueTab);
    expect(uniqueTab.lifecycleState).toBe('blank');
    expect(uniqueTab.draftProviderId).toBe('claude');
    expect(uniqueTab.draftModel).toBe('claude-only');

    (Notice as jest.Mock).mockClear();
    const ambiguousTab = createTab({ plugin, containerEl: document.body, tabId: 'legacy-ambiguous', draftModel: 'shared-a' });
    tabs.push(ambiguousTab);
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('has been reset'));
    expect(ambiguousTab.draftProviderId).toBe('claude');
    expect(ambiguousTab.draftModel).toBe('shared-a');
  });
});

describe('inline edit under a shared top-level model ID', () => {
  it('routes the claude inline edit auxiliary transport through its own projection', async () => {
    // Codex owns the top-level projection, but both providers share 'shared-a'.
    plugin.settings.settingsProvider = 'codex';
    plugin.settings.savedProviderModel = { claude: 'claude-only', codex: 'shared-a' };
    plugin.settings.model = 'shared-a';

    const service = ProviderRegistry.createInlineEditService(plugin, 'claude');
    const result = await service.editText({
      mode: 'selection',
      instruction: 'polish',
      notePath: 'note.md',
      selectedText: 'raw text',
    });
    expect(result.success).toBe(true);
    expect(getLastOptions()?.model).toBe('claude-only');
  });
});

describe('new session reset keeps a complete pair without re-guessing', () => {
  it('returns a sent codex tab to blank with the inherited codex pair and re-sends it', async () => {
    const tab = blankTab();
    clickModel(tab, 'Codex B');
    await flush();
    await initializeTabService(tab, plugin);
    mockRpcCalls.length = 0;
    await sendTurn(tab);
    expect(mockRpcCalls.find(call => call.method === 'thread/start')?.params.model).toBe('shared-b');

    // Real controller stack: ConversationController.createNew() drives the
    // Tab onNewConversation reset through the production wiring. The component
    // is the only Obsidian-host stand-in here.
    initializeTabControllers(tab, plugin, {
      registerDomEvent: () => {},
      registerEvent: () => {},
      register: () => {},
      registerInterval: () => {},
    } as never);
    await tab.controllers.conversationController!.createNew();

    expect(tab.lifecycleState).toBe('blank');
    expect(tab.conversationId).toBeNull();
    expect(tab.service).toBeNull();
    expect(tab.draftProviderId).toBe('codex');
    expect(tab.draftModel).toBe('shared-b');
    expect(getTabProviderId(tab, plugin)).toBe('codex');

    mockRpcCalls.length = 0;
    await initializeTabService(tab, plugin);
    expect(tab.service).toBeInstanceOf(CodexChatRuntime);
    await sendTurn(tab);
    expect(mockRpcCalls.find(call => call.method === 'thread/start')?.params.model).toBe('shared-b');
    expect(Notice).not.toHaveBeenCalledWith(expect.stringContaining('has been reset'));
  });
});

describe('provider availability fallback', () => {
  it('falls back to a complete claude pair when codex is disabled, without cross-provider guessing', async () => {
    const tab = blankTab();
    clickModel(tab, 'Codex B');
    await flush();
    expect(tab.draftProviderId).toBe('codex');
    expect(tab.draftModel).toBe('shared-b');

    (Notice as jest.Mock).mockClear();
    (plugin.settings as { providerConfigs: Record<string, Record<string, unknown>> }).providerConfigs.codex.enabled = false;
    onProviderAvailabilityChanged(tab, plugin);

    expect(tab.providerId).toBe('claude');
    expect(tab.draftProviderId).toBe('claude');
    expect(tab.draftModel).toBe('shared-a');
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('has been reset'));

    // The fallback pair is complete: first send starts a claude runtime with
    // the fallback model.
    await initializeTabService(tab, plugin);
    expect(tab.service).toBeInstanceOf(ClaudianService);
    await sendTurn(tab);
    expect(getLastOptions()?.model).toBe('shared-a');
  });

  it('resets to a complete same-provider pair when the drafted preset disappears', () => {
    // A codex-only draft model keeps the scenario unambiguous by ID.
    (plugin.settings as { providerConfigs: Record<string, Record<string, unknown>> })
      .providerConfigs.codex.modelPresets = [
        { label: 'Codex A', model: 'shared-a' },
        { label: 'Codex B', model: 'shared-b' },
        { label: 'Codex Only', model: 'codex-only' },
      ];
    const tab = createTab({
      plugin,
      containerEl: document.body,
      tabId: 'preset-removed',
      draftModel: 'codex-only',
      draftProviderId: 'codex',
    });
    tabs.push(tab);
    expect(tab.draftModel).toBe('codex-only');
    expect(tab.draftProviderId).toBe('codex');

    (Notice as jest.Mock).mockClear();
    (plugin.settings as { providerConfigs: Record<string, Record<string, unknown>> })
      .providerConfigs.codex.modelPresets = [
        { label: 'Codex A', model: 'shared-a' },
        { label: 'Codex B', model: 'shared-b' },
      ];
    onProviderAvailabilityChanged(tab, plugin);

    // Fallback follows the existing rule (first enabled provider) and stays a
    // complete codex pair — never a claude option picked by same-ID guessing.
    expect(tab.providerId).toBe('codex');
    expect(tab.draftProviderId).toBe('codex');
    expect(tab.draftModel).toBe('shared-a');
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining('has been reset'));
  });
});

describe('effort settings isolation on a blank codex tab', () => {
  it('saves codex effort without touching the claude-owned top-level projection', async () => {
    const tab = blankTab();
    clickModel(tab, 'Codex B');
    await flush();

    const effortGears = [...tab.dom.contentEl.querySelectorAll<HTMLElement>('.claudian-thinking-effort .claudian-thinking-gear')];
    const lowGear = effortGears.find(gear => gear.textContent === 'Low');
    expect(lowGear).toBeDefined();
    lowGear!.click();
    await flush();

    expect(getTabProviderId(tab, plugin)).toBe('codex');
    expect(plugin.settings.savedProviderEffort.codex).toBe('low');
    // Top-level projection still belongs to the settings provider (claude).
    expect(plugin.settings.effortLevel).toBe('high');
    expect(plugin.settings.savedProviderEffort.claude).toBeUndefined();

    mockRpcCalls.length = 0;
    await initializeTabService(tab, plugin);
    await sendTurn(tab);
    expect(mockRpcCalls.find(call => call.method === 'turn/start')?.params.model).toBe('shared-b');
  });
});

describe('provider-native env model override stays inside the codex runtime', () => {
  it('selects an env-declared codex model and sends it through the codex transport', async () => {
    (plugin.settings as { providerConfigs: Record<string, Record<string, unknown>> })
      .providerConfigs.codex.environmentVariables = 'OPENAI_MODEL=env-codex-model';

    const tab = blankTab();
    clickModel(tab, 'env-codex-model');
    await flush();
    expect(tab.draftProviderId).toBe('codex');
    expect(tab.draftModel).toBe('env-codex-model');

    await initializeTabService(tab, plugin);
    expect(tab.service).toBeInstanceOf(CodexChatRuntime);
    mockRpcCalls.length = 0;
    await sendTurn(tab);
    expect(mockRpcCalls.find(call => call.method === 'thread/start')?.params.model).toBe('env-codex-model');
    expect(mockRpcCalls.find(call => call.method === 'turn/start')?.params.model).toBe('env-codex-model');
  });
});
