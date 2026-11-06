/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */
import '@test/helpers/obsidianDom';
import '@/providers';

// eslint-disable-next-line jest/no-mocks-import
import { resetMockMessages } from '@test/__mocks__/claude-agent-sdk';
import { installObsidianDom } from '@test/helpers/obsidianDom';
import * as fs from 'fs';
import { Notice } from 'obsidian';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { createTab, initializeTabService, initializeTabUI } from '@/features/chat/tabs/Tab';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type { TabData } from '@/features/chat/tabs/types';
import type ClaudianPlugin from '@/main';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';

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

/** Mirrors the user's real settings: claude and codex presets share IDs and labels. */
function userShapeSettings(): Record<string, unknown> {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS));
  settings.model = 'claude-opus';
  settings.maxTabs = 10;
  settings.settingsProvider = 'claude';
  settings.savedProviderModel = { claude: 'claude-opus', codex: 'claude-haiku' };
  (settings.providerConfigs as Record<string, Record<string, unknown>>).claude.modelPresets = [
    { label: 'Haiku', model: 'claude-haiku', contextWindow: 1000000 },
    { label: 'Sonnet', model: 'claude-sonnet', contextWindow: 1000000 },
    { label: 'Opus', model: 'claude-opus', contextWindow: 1000000 },
    { label: 'Fable', model: 'claude-fable', contextWindow: 1000000 },
  ];
  (settings.providerConfigs as Record<string, Record<string, unknown>>).claude.loadUserSettings = false;
  (settings.providerConfigs as Record<string, Record<string, unknown>>).codex.enabled = true;
  (settings.providerConfigs as Record<string, Record<string, unknown>>).codex.modelPresets = [
    { label: 'Opus', model: 'claude-opus', contextWindow: 1000000 },
    { label: 'Sonnet', model: 'claude-sonnet', contextWindow: 1000000 },
    { label: 'Haiku', model: 'claude-haiku', contextWindow: 1000000 },
    { label: 'Fable', model: 'claude-fable', contextWindow: 1000000 },
  ];
  return settings;
}

const conversation = {
  id: 'user-conversation',
  providerId: 'claude' as const,
  title: 'User Session',
  messages: [],
  sessionId: 'user-session',
  createdAt: 0,
  updatedAt: 0,
  hasHistory: true,
  messageCount: 3,
};

/** Mirrors the user's persisted tab-manager state: 6 claude tabs + 1 codex tab. */
const userTabState = {
  openTabs: [
    { tabId: 'u1', conversationId: 'user-conversation' },
    { tabId: 'u2', conversationId: 'user-conversation-2' },
    { tabId: 'u3', conversationId: 'user-conversation-3' },
    { tabId: 'u4', conversationId: 'user-conversation-4' },
    { tabId: 'u5', conversationId: 'user-conversation-5' },
    { tabId: 'u6', conversationId: 'user-conversation-6' },
    { tabId: 'u7', conversationId: 'user-codex-conversation' },
  ],
  activeTabId: 'u5',
};

const multiConversations = [
  conversation,
  { ...conversation, id: 'user-conversation-2', sessionId: 'user-session-2' },
  { ...conversation, id: 'user-conversation-3', sessionId: 'user-session-3' },
  { ...conversation, id: 'user-conversation-4', sessionId: 'user-session-4' },
  { ...conversation, id: 'user-conversation-5', sessionId: 'user-session-5' },
  { ...conversation, id: 'user-conversation-6', sessionId: 'user-session-6' },
  {
    ...conversation,
    id: 'user-codex-conversation',
    providerId: 'codex' as const,
    sessionId: null,
    providerState: { threadId: 'codex-thread' },
  },
];

function pluginFixture(): ClaudianPlugin {
  const adapter = {
    basePath: '/fixture/vault', getBasePath: () => '/fixture/vault',
    exists: async () => false, read: async () => '', write: async () => {},
    mkdir: async () => {}, list: async () => ({ files: [], folders: [] }),
  };
  return {
    settings: userShapeSettings(),
    app: {
      vault: {
        adapter, getName: () => 'Fixture', on: jest.fn(), offref: jest.fn(),
        getFiles: () => [], getMarkdownFiles: () => [], getAllLoadedFiles: () => [],
      },
      workspace: {
        on: jest.fn(), offref: jest.fn(), getActiveFile: () => null,
        getActiveViewOfType: () => null, getLeavesOfType: () => [],
        revealLeaf: jest.fn(),
      },
      metadataCache: { on: jest.fn(), offref: jest.fn(), getFileCache: () => null },
    },
    loadData: async () => ({}), saveData: async () => {}, saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: () => '', getResolvedProviderCliPath: () => '/fixture/cli',
    getConversationSync: () => conversation,
    getConversationById: async () => conversation,
    updateConversation: async () => {},
    switchConversation: async () => conversation,
  } as unknown as ClaudianPlugin;
}

function mockViewHost(): Record<string, unknown> {
  return {
    leaf: { id: 'fixture-leaf' },
    getTabManager: () => null,
    registerDomEvent: () => {},
    registerEvent: () => {},
    register: () => {},
    registerInterval: () => {},
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    for (let j = 0; j < 20; j++) await Promise.resolve();
  }
}

const CLAUDE_ORDER = ['Fable', 'Opus', 'Sonnet', 'Haiku'];
const CODEX_ORDER = ['Fable', 'Haiku', 'Sonnet', 'Opus'];

function optionLabels(tab: TabData): string[] {
  return [...tab.dom.contentEl.querySelectorAll<HTMLElement>('.claudian-model-option')]
    .map(el => el.textContent ?? '');
}

/** Mixed-list residue: in the user's same-label shape the mixed dropdown carries
 *  both providers' entries, and the first same-label entry is the codex one. */
function countMixedEntries(tab: TabData): number {
  return optionLabels(tab).length;
}

function clickOption(tab: TabData, label: string, occurrence = 1): HTMLElement | null {
  const matches = [...tab.dom.contentEl.querySelectorAll<HTMLElement>('.claudian-model-option')]
    .filter(el => el.textContent === label);
  const option = matches[occurrence - 1];
  if (!option) return null;
  option.click();
  return option;
}

function guardFired(): boolean {
  return (Notice as jest.Mock).mock.calls
    .some(call => typeof call[0] === 'string' && call[0].includes('Cannot switch provider'));
}

let plugin: ClaudianPlugin;
let container: HTMLElement;
const tabs: TabData[] = [];

beforeEach(async () => {
  installObsidianDom();
  jest.clearAllMocks();
  resetMockMessages();
  (fs.existsSync as jest.Mock).mockReturnValue(false);
  (fs.readdirSync as jest.Mock).mockReturnValue([]);
  (fs.promises.readdir as jest.Mock).mockResolvedValue([]);
  (fs.promises.access as jest.Mock).mockRejectedValue(new Error('ENOENT'));
  plugin = pluginFixture();
  ProviderWorkspaceRegistry.setServices('claude', await createClaudeWorkspaceServices(plugin, new VaultFileAdapter(plugin.app)));
  container = document.body.createDiv();
});

afterEach(() => {
  for (const tab of tabs.splice(0)) {
    tab.service?.cleanup();
    tab.dom.eventCleanups.forEach(cleanup => cleanup());
    tab.dom.contentEl.remove();
  }
  container.remove();
  ProviderWorkspaceRegistry.clear();
});

describe('restored bound tab dropdown keeps its provider identity', () => {
  it('offers only the bound provider options after a real restore, and a same-provider click never trips the guard', async () => {
    const manager = new TabManager(
      plugin,
      container,
      mockViewHost() as never,
      {},
    );
    await manager.restoreState({
      openTabs: [{ tabId: 'restored-tab', conversationId: 'user-conversation' }],
      activeTabId: 'restored-tab',
    });
    await settle();

    const tab = manager.getActiveTab() as TabData;
    expect(tab).not.toBeNull();
    expect(tab.lifecycleState).not.toBe('blank');

    const options = [...tab.dom.contentEl.querySelectorAll<HTMLElement>('.claudian-model-option')];
    expect(options.map(el => el.textContent)).toEqual(CLAUDE_ORDER);
    // renderOptions() reverses the provider preset order; a codex-scoped list
    // in the user's shape would show ['Fable', 'Haiku', 'Sonnet', 'Opus'].
    expect(options.map(el => el.textContent)).not.toEqual(CODEX_ORDER);

    (Notice as jest.Mock).mockClear();
    clickOption(tab, 'Sonnet');
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(guardFired()).toBe(false);
    expect((plugin.settings as { savedProviderModel: Record<string, string> }).savedProviderModel.claude)
      .toBe('claude-sonnet');

    await manager.destroy();
    await settle();
  });

  it('keeps every restored tab dropdown scoped across switches, clicks, and conversation rebinds', async () => {
    const conversationsById = new Map(multiConversations.map(conv => [conv.id, conv]));
    plugin.getConversationSync = ((id: string) => conversationsById.get(id) ?? null) as never;
    plugin.getConversationById = (async (id: string) => conversationsById.get(id) ?? null) as never;
    plugin.updateConversation = (async () => {}) as never;
    plugin.switchConversation = (async (id: string) => conversationsById.get(id) ?? null) as never;

    const manager = new TabManager(plugin, container, mockViewHost() as never, {});
    await manager.restoreState(userTabState as never);
    await settle();

    let violations = 0;
    const checkAllDropdowns = (tag: string): void => {
      for (const tab of manager.getAllTabs()) {
        if (!tab.conversationId || tab.lifecycleState === 'blank') continue;
        const conv = conversationsById.get(tab.conversationId);
        if (!conv) continue;
        const labels = optionLabels(tab);
        const expected = conv.providerId === 'codex' ? CODEX_ORDER : CLAUDE_ORDER;
        if (JSON.stringify(labels) !== JSON.stringify(expected)) {
          violations++;
          throw new Error(`Dropdown scope violation at ${tag} on tab ${tab.id}: ${JSON.stringify(labels)}`);
        }
      }
    };

    checkAllDropdowns('post-restore');

    for (const tabId of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']) {
      await manager.switchToTab(tabId);
      await settle();
      checkAllDropdowns(`after-switch-${tabId}`);
    }

    for (const tabId of ['u1', 'u5', 'u7']) {
      clickOption(manager.getTab(tabId) as TabData, 'Sonnet');
      await settle();
      if (guardFired()) violations++;
      clickOption(manager.getTab(tabId) as TabData, 'Opus');
      await settle();
      if (guardFired()) violations++;
      checkAllDropdowns(`after-clicks-${tabId}`);
    }

    // New session on u5, then rebind it to a claude and a codex conversation.
    await manager.switchToTab('u5');
    await settle();
    await manager.createNewConversation();
    await settle();
    checkAllDropdowns('after-createNew');

    const u5 = manager.getTab('u5') as TabData;
    await u5.controllers.conversationController!.switchTo('user-conversation-4');
    await settle();
    checkAllDropdowns('after-switchTo-conv4');

    await u5.controllers.conversationController!.switchTo('user-codex-conversation');
    await settle();
    checkAllDropdowns('after-switchTo-codex');

    await u5.controllers.conversationController!.switchTo('user-conversation');
    await settle();
    checkAllDropdowns('after-switchTo-claude');
    clickOption(u5, 'Sonnet');
    await settle();
    if (guardFired()) violations++;

    expect(violations).toBe(0);

    await manager.destroy();
    await settle();
  });

  it('leaves only the bound provider options after initializeTabService binds a blank tab (mixed-list residue)', async () => {
    // A blank tab renders the mixed picker: claude and codex share preset IDs
    // and labels, so the mixed list carries two identically-labeled entries
    // per tier — visually indistinguishable except for the group/icon.
    const blank = createTab({ plugin, containerEl: container });
    tabs.push(blank);
    initializeTabUI(blank, plugin);
    expect(blank.lifecycleState).toBe('blank');
    expect(countMixedEntries(blank)).toBe(8);

    // Production binding seam: hydrateTab calls initializeTabService directly,
    // without the ensureServiceInitialized wrapper that re-renders afterwards.
    await initializeTabService(blank, plugin);
    expect(blank.lifecycleState).toBe('bound_active');
    expect(blank.providerId).toBe('claude');

    // After any blank->bound transition the dropdown must only ever show the
    // bound provider's own options. The mixed list surviving the binding is
    // exactly the false-positive trap: clicking "Sonnet" hits the codex-group
    // entry (identical label) and trips the bound-session guard.
    expect(optionLabels(blank)).toEqual(CLAUDE_ORDER);

    (Notice as jest.Mock).mockClear();
    clickOption(blank, 'Sonnet');
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(guardFired()).toBe(false);
    expect((plugin.settings as { savedProviderModel: Record<string, string> }).savedProviderModel.claude)
      .toBe('claude-sonnet');
  });

  it('re-renders the dropdown to the bound provider options when the guard fires (self-heal)', async () => {
    // Simulate whatever left a stale mixed list on a bound tab (the reported
    // real-world trigger was not reproducible end-to-end): bind the tab, then
    // restore a blank-period mixed dropdown on it.
    const tab = createTab({
      plugin,
      containerEl: container,
      conversation,
      tabId: 'stale-bound-tab',
    });
    tabs.push(tab);
    initializeTabUI(tab, plugin);
    expect(optionLabels(tab)).toEqual(CLAUDE_ORDER);

    // Force the stale mixed list the guard must heal.
    (tab as { lifecycleState: string }).lifecycleState = 'blank';
    tab.ui.modelSelector?.renderOptions();
    (tab as { lifecycleState: string }).lifecycleState = 'bound_cold';
    expect(countMixedEntries(tab)).toBe(8);

    (Notice as jest.Mock).mockClear();
    // The mixed list carries two identically-labeled "Sonnet" entries; the
    // codex-group one is the cross-provider click the guard must reject.
    clickOption(tab, 'Sonnet', 2);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // The guard rejects the cross-provider click AND heals the list: the
    // codex-group entries must be gone, so the next same-label click works.
    expect(guardFired()).toBe(true);
    expect(optionLabels(tab)).toEqual(CLAUDE_ORDER);

    (Notice as jest.Mock).mockClear();
    clickOption(tab, 'Sonnet');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(guardFired()).toBe(false);
    expect((plugin.settings as { savedProviderModel: Record<string, string> }).savedProviderModel.claude)
      .toBe('claude-sonnet');
  });
});
