import { createMockEl } from '@test/helpers/mockElement';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { UsageInfo } from '@/core/types';
import { ClaudianView } from '@/features/chat/ClaudianView';
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

describe('ClaudianView tab rename wiring', () => {
  const open = jest.fn();
  let plugin: {
    getConversationSync: jest.Mock;
    renameConversationManually: jest.Mock;
  };
  let view: ClaudianView;
  let updateTabBar: jest.Mock;
  let updateHistoryDropdown: jest.Mock;
  let tabBarCallbacks: { onTabRename: (tabId: string) => void };

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
    raw.tabManager = {
      getTab: (tabId: string) => ({
        'tab-bound': { id: 'tab-bound', conversationId: 'conv-1' },
        'tab-empty': { id: 'tab-empty', conversationId: null },
      } as Record<string, unknown>)[tabId],
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

