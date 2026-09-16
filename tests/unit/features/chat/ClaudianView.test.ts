import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { UsageInfo } from '@/core/types';
import { ClaudianView } from '@/features/chat/ClaudianView';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';

jest.mock('@/features/chat/tabs/Tab', () => ({
  closeHistorySearchForTab: jest.fn(),
  openHistorySearchForTab: jest.fn(),
  updatePlanModeUI: jest.fn(),
  onProviderAvailabilityChanged: jest.fn(),
  getTabProviderId: jest.fn().mockReturnValue('claude'),
}));

jest.mock('@/features/chat/tabs/TabManager', () => ({ TabManager: jest.fn() }));
jest.mock('@/features/chat/tabs/TabBar', () => ({ TabBar: jest.fn() }));

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
    // The provider's current (global) model differs from the historical tab's
    // usage.model on purpose: the refresh must re-denominate by each tab's
    // own recorded model, not re-label everything with the current one.
    mockGetProviderSettingsSnapshot.mockReturnValue({
      model: 'haiku',
      permissionMode: 'normal',
      customContextLimits: { 'sonnet': 1_000_000 },
    });
  });

  it('refreshes a historical tab by its own usage.model after preset windows change', () => {
    const usage = createUsage();
    const tab = createTab(usage);
    const { view } = createView([tab]);

    view.refreshModelSelector();

    const refreshed = (tab as { state: { usage: UsageInfo } }).state.usage;
    expect(refreshed.model).toBe('sonnet');
    expect(refreshed.contextWindow).toBe(1_000_000);
    expect(refreshed.percentage).toBe(45);
  });

  it('keeps an authoritative same-model runtime window through the refresh', () => {
    const usage = createUsage({
      contextWindow: 800_000,
      contextWindowIsAuthoritative: true,
      percentage: 57,
    });
    const tab = createTab(usage);
    const { view } = createView([tab]);

    view.refreshModelSelector();

    const refreshed = (tab as { state: { usage: UsageInfo } }).state.usage;
    expect(refreshed.contextWindow).toBe(800_000);
    expect(refreshed.contextWindowIsAuthoritative).toBe(true);
  });

  it('falls back to the provider current model when a tab usage carries no model', () => {
    const usage = createUsage({ model: undefined });
    const tab = createTab(usage);
    const { view } = createView([tab]);

    view.refreshModelSelector();

    const refreshed = (tab as { state: { usage: UsageInfo } }).state.usage;
    expect(refreshed.model).toBe('haiku');
    expect(refreshed.contextWindow).toBe(200_000);
  });
});
