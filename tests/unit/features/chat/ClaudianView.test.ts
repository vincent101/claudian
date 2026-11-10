import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { UsageInfo } from '@/core/types';
import { ClaudianView } from '@/features/chat/ClaudianView';
import type { MarkdownRenderSummary } from '@/features/chat/history/HistoryDiagnostics';
import { MarkdownRenderDiagnostics } from '@/features/chat/rendering/MarkdownRenderDiagnostics';
import { t } from '@/i18n/i18n';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { InputModal } from '@/shared/modals/InputModal';

jest.mock('@/features/chat/tabs/Tab', () => ({
  closeHistorySearchForTab: jest.fn(),
  openHistorySearchForTab: jest.fn(),
  updatePlanModeUI: jest.fn(),
  onProviderAvailabilityChanged: jest.fn(),
  getTabProviderId: jest.fn().mockReturnValue('claude'),
}));

jest.mock('@/features/chat/tabs/TabManager', () => ({ TabManager: jest.fn() }));
jest.mock('@/features/chat/tabs/TabBar', () => ({ TabBar: jest.fn() }));
// InputModal's own behavior is covered by its unit suite; here it is the seam
// that hands the confirmed value back to handleTabRename.
jest.mock('@/shared/modals/InputModal', () => ({ InputModal: jest.fn() }));

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    getProviderSettingsSnapshot: (...args: unknown[]) => mockGetProviderSettingsSnapshot(...args),
  },
}));

const mockGetProviderSettingsSnapshot = jest.fn();

// Only the seams refreshModelSelector touches are registered; the real
// claudeChatUIConfig keeps the preset-chain behavior under test.
ProviderRegistry.register('claude', {
  chatUIConfig: claudeChatUIConfig,
  capabilities: { supportsPlanMode: false },
} as never);

function createUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    model: 'sonnet',
    inputTokens: 400_000,
    cacheCreationInputTokens: 30_000,
    cacheReadInputTokens: 20_000,
    contextWindow: 200_000,
    contextWindowIsAuthoritative: false,
    contextTokens: 450_000,
    percentage: 100,
    ...overrides,
  };
}

function createView(tabs: unknown[]): { view: ClaudianView; primeProviderRuntime: jest.Mock } {
  const primeProviderRuntime = jest.fn();
  const view = Object.create(ClaudianView.prototype) as ClaudianView;
  (view as unknown as Record<string, unknown>).plugin = {
    settings: { providerConfigs: { claude: {} } },
  };
  (view as unknown as Record<string, unknown>).tabManager = {
    getAllTabs: () => tabs,
    primeProviderRuntime,
  };
  return { view, primeProviderRuntime };
}

function createTab(usage: UsageInfo | null): unknown {
  return {
    state: { usage },
    ui: {},
    dom: { inputWrapper: { toggleClass: jest.fn() } },
  };
}

describe('ClaudianView.refreshModelSelector usage refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The provider's current (global) model is the selector model every tab
    // re-denominates by (2.3.2 ②): the persisted usage.model is a runtime
    // label, never a denominator source.
    mockGetProviderSettingsSnapshot.mockReturnValue({
      model: 'haiku',
      permissionMode: 'normal',
      customContextLimits: { 'sonnet': 1_000_000 },
    });
  });

  it('re-denominates a tab by the selector model after preset windows change', () => {
    mockGetProviderSettingsSnapshot.mockReturnValue({
      model: 'sonnet',
      permissionMode: 'normal',
      customContextLimits: { 'sonnet': 1_000_000 },
    });
    // CLI-reported label form: must resolve through the selector anyway.
    const usage = createUsage({ model: 'claude-sonnet[1m]' });
    const tab = createTab(usage);
    const { view } = createView([tab]);

    view.refreshModelSelector();

    const refreshed = (tab as { state: { usage: UsageInfo } }).state.usage;
    expect(refreshed.model).toBe('sonnet');
    expect(refreshed.contextWindow).toBe(1_000_000);
    expect(refreshed.percentage).toBe(45);
  });

  it('re-labels and re-denominates when the selector model differs from the usage label', () => {
    // User ruling 2026-09-17: 我选什么模型，显示什么模型的上下文长度才对.
    const usage = createUsage({ model: 'sonnet' });
    const tab = createTab(usage);
    const { view } = createView([tab]);

    view.refreshModelSelector();

    const refreshed = (tab as { state: { usage: UsageInfo } }).state.usage;
    expect(refreshed.model).toBe('haiku');
    expect(refreshed.contextWindow).toBe(200_000);
    expect(refreshed.percentage).toBe(100);
  });

  it('denominates by the provider current model when a tab usage carries no model', () => {
    const usage = createUsage({ model: undefined });
    const tab = createTab(usage);
    const { view } = createView([tab]);

    view.refreshModelSelector();

    const refreshed = (tab as { state: { usage: UsageInfo } }).state.usage;
    expect(refreshed.model).toBe('haiku');
    expect(refreshed.contextWindow).toBe(200_000);
  });
});

describe('ClaudianView markdown diagnostics lifecycle', () => {
  it('cleans up the captured manager and tab bar when persistence fails', async () => {
    const failure = new Error('tab persistence failed');
    const manager = {
      beginClose: jest.fn(),
      stopMarkdownDiagnostics: jest.fn(),
      getAllTabs: () => [],
      getActiveTab: () => null,
      getPersistedState: () => ({ openTabs: [] }),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    const tabBar = { destroy: jest.fn() };
    const view = Object.create(ClaudianView.prototype) as ClaudianView;
    const raw = view as unknown as Record<string, unknown>;
    raw.plugin = {
      app: { vault: { offref: jest.fn() } },
      persistTabManagerState: jest.fn().mockRejectedValue(failure),
    };
    raw.tabManager = manager;
    raw.tabBar = tabBar;
    raw.pendingTabBarUpdate = null;
    raw.pendingPersist = null;
    raw.eventRefs = [];

    await expect(view.onClose()).rejects.toBe(failure);
    expect(manager.destroy).toHaveBeenCalledTimes(1);
    expect(tabBar.destroy).toHaveBeenCalledTimes(1);
    expect(manager.beginClose).toHaveBeenCalledTimes(1);
  });

  it('retires synchronously and shares concurrent close work', async () => {
    let releasePersistence!: () => void;
    const persistence = new Promise<void>(resolve => { releasePersistence = resolve; });
    const manager = {
      beginClose: jest.fn(),
      stopMarkdownDiagnostics: jest.fn(),
      getAllTabs: () => [],
      getActiveTab: () => null,
      getPersistedState: jest.fn(() => ({ openTabs: [] })),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
    const tabBar = { destroy: jest.fn() };
    const persistTabManagerState = jest.fn(() => persistence);
    const view = Object.create(ClaudianView.prototype) as ClaudianView;
    const raw = view as unknown as Record<string, unknown>;
    raw.plugin = { app: { vault: { offref: jest.fn() } }, persistTabManagerState };
    raw.tabManager = manager;
    raw.tabBar = tabBar;
    raw.pendingTabBarUpdate = null;
    raw.pendingPersist = null;
    raw.eventRefs = [];

    const first = view.onClose();
    const second = view.onClose();
    try {
      expect(manager.beginClose).toHaveBeenCalledTimes(1);
      expect(persistTabManagerState).toHaveBeenCalledTimes(1);
      expect(manager.destroy).not.toHaveBeenCalled();
      releasePersistence();
      await Promise.all([first, second]);
      expect(manager.destroy).toHaveBeenCalledTimes(1);
      expect(tabBar.destroy).toHaveBeenCalledTimes(1);
    } finally {
      releasePersistence();
      await Promise.allSettled([first, second]);
    }
  });

  it('cleans the captured tab bar when manager destruction rejects', async () => {
    const failure = new Error('manager cleanup failed');
    const manager = {
      beginClose: jest.fn(),
      stopMarkdownDiagnostics: jest.fn(),
      getAllTabs: () => [],
      getActiveTab: () => null,
      getPersistedState: () => ({ openTabs: [] }),
      destroy: jest.fn().mockRejectedValue(failure),
    };
    const tabBar = { destroy: jest.fn() };
    const view = Object.create(ClaudianView.prototype) as ClaudianView;
    const raw = view as unknown as Record<string, unknown>;
    raw.plugin = {
      app: { vault: { offref: jest.fn() } },
      persistTabManagerState: jest.fn().mockResolvedValue(undefined),
    };
    raw.tabManager = manager;
    raw.tabBar = tabBar;
    raw.pendingTabBarUpdate = null;
    raw.pendingPersist = null;
    raw.eventRefs = [];

    await expect(view.onClose()).rejects.toBe(failure);
    expect(tabBar.destroy).toHaveBeenCalledTimes(1);
    expect(raw.tabManager).toBeNull();
    expect(raw.tabBar).toBeNull();
  });

  it('flushes only its own collectors before persistence and ignores late completions', async () => {
    const order: string[] = [];
    const events: MarkdownRenderSummary[] = [];
    const createCollector = (id: string) => new MarkdownRenderDiagnostics(id, event => {
      events.push(event);
      if (event.flushScope === 'window') order.push(id);
    });
    const first = createCollector('aaaaaaaaaaaa');
    const second = createCollector('bbbbbbbbbbbb');
    const otherView = createCollector('cccccccccccc');
    const element = { isConnected: true, ownerDocument: { visibilityState: 'visible' } } as unknown as HTMLElement;
    const token = first.start(element, 1);
    second.start(element, 2);
    const otherToken = otherView.start(element, 3);
    const view = Object.create(ClaudianView.prototype) as ClaudianView;
    const raw = view as unknown as Record<string, unknown>;
    raw.plugin = {
      app: { vault: { offref: jest.fn() } },
      persistTabManagerState: jest.fn(async () => { order.push('persist'); }),
    };
    raw.tabManager = {
      beginClose: jest.fn(),
      stopMarkdownDiagnostics: jest.fn(() => { order.push('stop'); }),
      getAllTabs: () => [first, second].map(collector => ({
        markdownRenderDiagnostics: { collector, dispose: () => collector.dispose() },
      })),
      getActiveTab: () => null,
      getPersistedState: () => ({ openTabs: [] }),
      destroy: jest.fn(async () => { order.push('destroy'); }),
    };
    raw.pendingTabBarUpdate = null;
    raw.pendingPersist = null;
    raw.eventRefs = [];
    raw.tabBar = null;

    try {
      await view.onClose();
      expect(order).toEqual(['stop', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'persist', 'destroy']);
      expect(events.filter(event => event.flushScope === 'window')).toEqual(expect.arrayContaining([
        expect.objectContaining({ collectorIdHash: 'aaaaaaaaaaaa', flushReason: 'dispose', abandonedCalls: 1 }),
        expect.objectContaining({ collectorIdHash: 'bbbbbbbbbbbb', flushReason: 'dispose', abandonedCalls: 1 }),
      ]));
      const count = events.length;
      first.end(token, true);
      await view.onClose();
      expect(events).toHaveLength(count);
      otherView.end(otherToken, true);
      otherView.dispose();
      expect(events.find(event => event.collectorIdHash === 'cccccccccccc' && event.flushScope === 'window'))
        .toMatchObject({ successCalls: 1, abandonedCalls: 0 });
    } finally {
      first.dispose();
      second.dispose();
      otherView.dispose();
    }
  });
});

describe('ClaudianView tab rename wiring', () => {
  const open = jest.fn();
  let plugin: {
    getConversationSync: jest.Mock;
    renameConversationManually: jest.Mock;
  };
  let view: ClaudianView;
  let updateTabBar: jest.Mock;
  let updateHistoryDropdown: jest.Mock;
  let tabBarCallbacks: { onTabRename: (tabId: string) => void; onNewTab: () => Promise<void> };

  function submittedModalOptions(): { value: string; onSubmit: (raw: string) => Promise<void> } {
    const calls = (InputModal as unknown as jest.Mock).mock.calls;
    return calls[calls.length - 1][1];
  }

  const originalDocument = (globalThis as { document?: unknown }).document;

  afterAll(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Node test env: buildNavRowContent only needs element factories.
    (globalThis as { document?: unknown }).document = {
      createDocumentFragment: () => createMockEl(),
      createElement: (tag: string) => createMockEl(tag),
    };
    (InputModal as unknown as jest.Mock).mockImplementation(() => ({ open }));
    plugin = {
      getConversationSync: jest.fn().mockReturnValue({ id: 'conv-1', title: 'Old title' }),
      renameConversationManually: jest.fn().mockResolvedValue(undefined),
    };
    updateTabBar = jest.fn();
    updateHistoryDropdown = jest.fn();

    view = Object.create(ClaudianView.prototype) as ClaudianView;
    const raw = view as unknown as Record<string, unknown>;
    raw.app = {};
    raw.plugin = plugin;
    const tabs: Record<string, unknown> = {
      'tab-bound': { id: 'tab-bound', conversationId: 'conv-1' },
      'tab-empty': { id: 'tab-empty', conversationId: null },
    };
    raw.tabManager = {
      isOpen: jest.fn().mockReturnValue(true),
      getTab: (tabId: string) => tabs[tabId],
    };
    raw.updateTabBar = updateTabBar;
    raw.updateHistoryDropdown = updateHistoryDropdown;

    // Production wiring: the callbacks ClaudianView hands to TabBar.
    const { TabBar } = jest.requireMock('@/features/chat/tabs/TabBar') as { TabBar: jest.Mock };
    TabBar.mockClear();
    (view as unknown as { buildNavRowContent: () => void }).buildNavRowContent();
    tabBarCallbacks = TabBar.mock.calls[0][1];
  });

  it('opens the modal prefilled with the current conversation title', () => {
    tabBarCallbacks.onTabRename('tab-bound');

    expect(InputModal).toHaveBeenCalledTimes(1);
    expect(submittedModalOptions().value).toBe('Old title');
    expect(plugin.getConversationSync).toHaveBeenCalledWith('conv-1');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not open a modal for an unbound tab or an unknown tab', () => {
    tabBarCallbacks.onTabRename('tab-empty');
    tabBarCallbacks.onTabRename('tab-missing');

    expect(InputModal).not.toHaveBeenCalled();
  });

  it('renames through the manual-rename method, then refreshes tab bar and history dropdown', async () => {
    const order: string[] = [];
    plugin.renameConversationManually.mockImplementation(async () => { order.push('rename'); });
    updateTabBar.mockImplementation(() => { order.push('tabBar'); });
    updateHistoryDropdown.mockImplementation(() => { order.push('history'); });

    tabBarCallbacks.onTabRename('tab-bound');
    await submittedModalOptions().onSubmit('New title');

    expect(plugin.renameConversationManually).toHaveBeenCalledTimes(1);
    expect(plugin.renameConversationManually).toHaveBeenCalledWith('conv-1', 'New title');
    expect(order).toEqual(['rename', 'tabBar', 'history']);
    expect(Notice).not.toHaveBeenCalled();
  });

  it('does not publish a completed old rename into a replacement manager', async () => {
    let resolveRename!: () => void;
    plugin.renameConversationManually.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolveRename = resolve;
    }));
    tabBarCallbacks.onTabRename('tab-bound');
    const submitted = submittedModalOptions().onSubmit('New title');
    (view as unknown as Record<string, unknown>).tabManager = {
      getTab: () => null,
    };
    resolveRename();
    await submitted;

    expect(plugin.renameConversationManually).toHaveBeenCalledWith('conv-1', 'New title');
    expect(updateTabBar).not.toHaveBeenCalled();
    expect(updateHistoryDropdown).not.toHaveBeenCalled();
  });

  it('does not route callbacks from an old tab bar into a reopened manager', async () => {
    const createTab = jest.fn().mockResolvedValue({ id: 'replacement-tab' });
    const raw = view as unknown as Record<string, unknown>;
    raw.tabManager = {
      isOpen: () => true,
      getTab: () => ({ id: 'tab-bound', conversationId: 'conv-1' }),
      createTab,
    };
    raw.assemblyGeneration = {};
    raw.updateTabBarVisibility = jest.fn();

    tabBarCallbacks.onTabRename('tab-bound');
    await tabBarCallbacks.onNewTab();

    expect(InputModal).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('does not start a rename submitted after its original manager retires', async () => {
    tabBarCallbacks.onTabRename('tab-bound');
    const { onSubmit } = submittedModalOptions();
    const manager = (view as unknown as { tabManager: { isOpen: jest.Mock } }).tabManager;
    manager.isOpen.mockReturnValue(false);

    await onSubmit('New title');

    expect(plugin.renameConversationManually).not.toHaveBeenCalled();
    expect(updateTabBar).not.toHaveBeenCalled();
    expect(updateHistoryDropdown).not.toHaveBeenCalled();
  });

  it('trims the confirmed value before renaming', async () => {
    tabBarCallbacks.onTabRename('tab-bound');
    await submittedModalOptions().onSubmit('  Padded  ');

    expect(plugin.renameConversationManually).toHaveBeenCalledWith('conv-1', 'Padded');
  });

  it('ignores blank and unchanged titles without writing', async () => {
    tabBarCallbacks.onTabRename('tab-bound');
    const { onSubmit } = submittedModalOptions();

    await onSubmit('   ');
    await onSubmit('');
    await onSubmit('Old title');
    await onSubmit('  Old title ');

    expect(plugin.renameConversationManually).not.toHaveBeenCalled();
    expect(updateTabBar).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
  });

  it('shows a failure notice and skips refresh when the manual rename rejects', async () => {
    plugin.renameConversationManually.mockRejectedValue(new Error('disk full'));

    tabBarCallbacks.onTabRename('tab-bound');
    await submittedModalOptions().onSubmit('New title');

    expect(Notice).toHaveBeenCalledWith(t('chat.tabs.renameTitleFailed'));
    expect(updateTabBar).not.toHaveBeenCalled();
    expect(updateHistoryDropdown).not.toHaveBeenCalled();
  });
});

describe('ClaudianView Escape and Shift+Tab permission arbitration', () => {
  function createScopeView(activeTab: unknown) {
    const view = Object.create(ClaudianView.prototype) as unknown as Record<string, unknown>;
    view.plugin = {
      app: {
        scope: {},
        vault: { on: jest.fn() },
        workspace: { on: jest.fn() },
      },
      settings: { providerConfigs: { claude: {} }, permissionMode: 'acceptEdits' },
      registerDomEvent: jest.fn(),
      registerEvent: jest.fn(),
      // Component base: registerDomEvent lives on the view itself in the app.
    };
    (view as { registerDomEvent: unknown }).registerDomEvent = jest.fn();
    (view as { registerEvent: unknown }).registerEvent = jest.fn();
    (view as { app: unknown }).app = (view.plugin as { app: unknown }).app;
    view.containerEl = createMockEl();
    view.tabManager = { getActiveTab: () => activeTab };
    view.eventRefs = [];
    view.assemblyGeneration = {};
    view.tabManager = {
      getActiveTab: () => activeTab,
      getAllTabs: () => [activeTab],
    };
    view.isCurrentManager = () => true;
    (view as { wireEventHandlers: () => void }).wireEventHandlers();
    return view;
  }

  function mockTabWithMenu(open: boolean, streaming: boolean) {
    const closeMenu = jest.fn().mockReturnValue(open);
    const cancelStreaming = jest.fn();
    return {
      state: { isStreaming: streaming },
      ui: { permissionToggle: { isMenuOpen: () => open, closeMenu } },
      controllers: { inputController: { cancelStreaming } },
      dom: { inputWrapper: { toggleClass: jest.fn() } },
    };
  }

  it('closes an open permission menu on the first view-scope Escape without cancelling streaming', () => {
    const tab = mockTabWithMenu(true, true);
    const view = createScopeView(tab);
    const scope = view.scope as unknown as { invoke: (keyId: string) => unknown };

    const result = scope.invoke(':Escape');

    expect(result).toBe(false);
    expect((tab.ui.permissionToggle as { closeMenu: jest.Mock }).closeMenu).toHaveBeenCalledTimes(1);
    expect((tab.controllers.inputController as { cancelStreaming: jest.Mock }).cancelStreaming)
      .not.toHaveBeenCalled();
  });

  it('resumes the streaming-cancel behavior when no menu is open', () => {
    const tab = mockTabWithMenu(false, true);
    const view = createScopeView(tab);
    const scope = view.scope as unknown as { invoke: (keyId: string) => unknown };

    scope.invoke(':Escape');

    expect((tab.controllers.inputController as { cancelStreaming: jest.Mock }).cancelStreaming)
      .toHaveBeenCalledTimes(1);
  });

  it('Shift+Tab out of plan restores through the provider fail-closed fallback', () => {
    const updatePlanModeUI = jest.requireMock('@/features/chat/tabs/Tab').updatePlanModeUI as jest.Mock;
    const capabilitiesSpy = jest
      .spyOn(ProviderRegistry, 'getCapabilities')
      .mockReturnValue({ supportsPlanMode: true } as never);
    try {
      const tab = {
        state: { prePlanPermissionMode: null },
        ui: {},
        dom: { inputWrapper: { toggleClass: jest.fn() } },
      };
      const view = createScopeView(tab);
      const registerDomEvent = (view as { registerDomEvent: jest.Mock }).registerDomEvent;
      const shiftTabCall = registerDomEvent.mock.calls.find(
        ([, event]: [unknown, string]) => event === 'keydown',
      );
      expect(shiftTabCall).toBeDefined();

      // current permissionMode is plan (snapshot mock below) → Shift+Tab exits.
      mockGetProviderSettingsSnapshot.mockReturnValue({ permissionMode: 'plan' });
      const shiftTabEvent = { key: 'Tab', shiftKey: true, isComposing: false, preventDefault: jest.fn() };
      (shiftTabCall![2] as (e: unknown) => void)(shiftTabEvent);

      expect(shiftTabEvent.preventDefault).toHaveBeenCalled();
      expect(updatePlanModeUI).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        // Provider fallback for Claude is manual, never yolo/auto.
        'manual',
      );
    } finally {
      capabilitiesSpy.mockRestore();
    }
  });
});

describe('ClaudianView retired asynchronous callbacks', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('does not report a closing cancellation as a tab limit', async () => {
    let release!: (value: null) => void;
    let active = true;
    const manager = {
      isOpen: () => active,
      createTab: jest.fn(() => new Promise<null>(resolve => { release = resolve; })),
    };
    const view = Object.create(ClaudianView.prototype) as ClaudianView;
    const raw = view as unknown as Record<string, unknown>;
    raw.plugin = { settings: { maxTabs: 3 } };
    raw.tabManager = manager;
    raw.assemblyGeneration = {};
    raw.updateTabBarVisibility = jest.fn();

    const creating = view.createNewTab();
    active = false;
    release(null);
    await creating;

    expect(Notice).not.toHaveBeenCalled();
    expect(raw.updateTabBarVisibility).not.toHaveBeenCalled();
  });

  it('does not refresh a replacement view after the original tab close', async () => {
    let release!: () => void;
    const manager = {
      isOpen: () => true,
      getTab: () => ({ state: { isStreaming: false } }),
      closeTab: jest.fn(() => new Promise<void>(resolve => { release = resolve; })),
    };
    const view = Object.create(ClaudianView.prototype) as ClaudianView;
    const raw = view as unknown as Record<string, unknown>;
    raw.tabManager = manager;
    raw.assemblyGeneration = {};
    raw.updateTabBarVisibility = jest.fn();
    const closing = (view as unknown as { handleTabClose: (id: string) => Promise<void> })
      .handleTabClose('tab-1');
    raw.tabManager = { isOpen: () => true };
    raw.assemblyGeneration = {};
    release();
    await closing;

    expect(raw.updateTabBarVisibility).not.toHaveBeenCalled();
  });

  it('does not route an old history menu callback into a reopened manager', async () => {
    const renderHistoryDropdown = jest.fn((_container: unknown, _options: unknown) => {});
    const controller = { renderHistoryDropdown };
    const manager = {
      isOpen: () => true,
      getActiveTab: () => ({ controllers: { conversationController: controller } }),
    };
    const view = Object.create(ClaudianView.prototype) as ClaudianView;
    const raw = view as unknown as Record<string, unknown>;
    raw.tabManager = manager;
    raw.assemblyGeneration = {};
    raw.historyDropdown = createMockEl();
    raw.historyDropdownOwner = null;
    (view as unknown as { updateHistoryDropdown: () => void }).updateHistoryDropdown();
    const callbacks = renderHistoryDropdown.mock.calls[0][1] as {
      onSelectConversation: (id: string) => Promise<void>;
    };
    const openConversation = jest.fn().mockResolvedValue(undefined);
    raw.tabManager = { isOpen: () => true, openConversation };
    raw.assemblyGeneration = {};
    raw.hideHistoryDropdown = jest.fn();

    await callbacks.onSelectConversation('conv-1');

    expect(openConversation).not.toHaveBeenCalled();
    expect(raw.hideHistoryDropdown).not.toHaveBeenCalled();
  });

  it('does not repaint a replacement tab bar from an old animation frame', () => {
    let frame!: FrameRequestCallback;
    const originalRequestFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = jest.fn(callback => { frame = callback; return 1; });
    try {
      const oldManager = { isOpen: () => true, getTabBarItems: jest.fn(() => []) };
      const oldTabBar = { update: jest.fn() };
      const newManager = { isOpen: () => true, getTabBarItems: jest.fn(() => []) };
      const newTabBar = { update: jest.fn() };
      const view = Object.create(ClaudianView.prototype) as ClaudianView;
      const raw = view as unknown as Record<string, unknown>;
      raw.tabManager = oldManager;
      raw.tabBar = oldTabBar;
      raw.assemblyGeneration = {};
      raw.pendingTabBarUpdate = null;
      raw.updateTabBarVisibility = jest.fn();
      (view as unknown as { updateTabBar: () => void }).updateTabBar();
      raw.tabManager = newManager;
      raw.tabBar = newTabBar;
      raw.assemblyGeneration = {};
      raw.pendingTabBarUpdate = 2;

      frame(0);

      expect(newManager.getTabBarItems).not.toHaveBeenCalled();
      expect(newTabBar.update).not.toHaveBeenCalled();
      expect(raw.pendingTabBarUpdate).toBe(2);
    } finally {
      globalThis.requestAnimationFrame = originalRequestFrame;
    }
  });

  it('does not persist a replacement manager from an old debounce callback', () => {
    jest.useFakeTimers();
    try {
      const persistTabManagerState = jest.fn().mockResolvedValue(undefined);
      const oldManager = { isOpen: () => true, getPersistedState: jest.fn(() => ({ openTabs: [] })) };
      const newManager = { isOpen: () => true, getPersistedState: jest.fn(() => ({ openTabs: [] })) };
      const view = Object.create(ClaudianView.prototype) as ClaudianView;
      const raw = view as unknown as Record<string, unknown>;
      raw.plugin = { persistTabManagerState };
      raw.pendingPersist = null;
      raw.tabManager = oldManager;
      raw.assemblyGeneration = {};
      (view as unknown as { persistTabState: () => void }).persistTabState();
      raw.tabManager = newManager;
      raw.assemblyGeneration = {};

      jest.advanceTimersByTime(300);

      expect(oldManager.getPersistedState).not.toHaveBeenCalled();
      expect(newManager.getPersistedState).not.toHaveBeenCalled();
      expect(persistTabManagerState).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['openHistoryConversation', 'openHistoryConversationInNewTab'] as const)(
    'does not hide a replacement view history dropdown after %s', async method => {
      let release!: () => void;
      const manager = {
        isOpen: () => true,
        openConversation: jest.fn(() => new Promise<void>(resolve => { release = resolve; })),
      };
      const view = Object.create(ClaudianView.prototype) as ClaudianView;
      const raw = view as unknown as Record<string, unknown>;
      raw.tabManager = manager;
      raw.assemblyGeneration = {};
      raw.hideHistoryDropdown = jest.fn();
      const opening = (view as unknown as Record<string, (id: string) => Promise<void>>)[method]('conv-1');
      raw.tabManager = { isOpen: () => true };
      raw.assemblyGeneration = {};
      release();
      await opening;

      expect(raw.hideHistoryDropdown).not.toHaveBeenCalled();
    },
  );
});
