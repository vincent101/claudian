import { createMockEl } from '@test/helpers/mockElement';

import type { UsageInfo } from '@/core/types';
import {
  ContextUsageMeter,
  createInputToolbar,
  McpServerSelector,
  ModelSelector,
  ModeSelector,
  PermissionToggle,
  ServiceTierToggle,
  ThinkingBudgetSelector,
} from '@/features/chat/ui/InputToolbar';
import {
  DEFAULT_CODEX_PRIMARY_MODEL,
  DEFAULT_CODEX_PRIMARY_MODEL_LABEL,
} from '@/providers/codex/types/models';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

function makeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow: 200000,
    contextTokens: 0,
    percentage: 0,
    ...overrides,
  };
}

const DEFAULT_MODELS = [
  { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'sonnet[1m]', label: 'Sonnet 1M', description: 'Balanced performance (1M context window)' },
  { value: 'opus', label: 'Opus', description: 'Most capable' },
  { value: 'opus[1m]', label: 'Opus 1M', description: 'Most capable (1M context window)' },
];

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

const BUDGET_OPTIONS = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
  { value: 'xhigh', label: 'Ultra', tokens: 32000 },
];

const DEFAULT_MODEL_VALUES = new Set(DEFAULT_MODELS.map(m => m.value));

function filterVisibleModels(
  models: typeof DEFAULT_MODELS,
  enableOpus1M: boolean,
  enableSonnet1M: boolean,
) {
  return models.filter((model) => {
    if (model.value === 'opus' || model.value === 'opus[1m]') {
      return enableOpus1M ? model.value === 'opus[1m]' : model.value === 'opus';
    }
    if (model.value === 'sonnet' || model.value === 'sonnet[1m]') {
      return enableSonnet1M ? model.value === 'sonnet[1m]' : model.value === 'sonnet';
    }
    return true;
  });
}

function createMockUIConfig() {
  return {
    getModelOptions: jest.fn().mockImplementation((settings: {
      enableOpus1M?: boolean;
      enableSonnet1M?: boolean;
      environmentVariables?: string;
    }) => {
      // Mimic real behavior: env-based custom models bypass 1M filtering
      if (settings.environmentVariables) {
        const match = settings.environmentVariables.match(/ANTHROPIC_MODEL=(\S+)/);
        if (match) {
          const value = match[1];
          const label = value.includes('/')
            ? value.split('/').pop() || value
            : value.replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase());
          return [{ value, label }];
        }
      }
      return filterVisibleModels(
        DEFAULT_MODELS,
        settings.enableOpus1M ?? false,
        settings.enableSonnet1M ?? false,
      );
    }),
    isAdaptiveReasoningModel: jest.fn().mockImplementation((model: string) => {
      if (DEFAULT_MODEL_VALUES.has(model)) return true;
      return /claude-(haiku|sonnet|opus)-/.test(model);
    }),
    getReasoningOptions: jest.fn().mockImplementation((model: string) => {
      if (DEFAULT_MODEL_VALUES.has(model) || /claude-(haiku|sonnet|opus)-/.test(model)) {
        return EFFORT_OPTIONS;
      }
      return BUDGET_OPTIONS;
    }),
    getDefaultReasoningValue: jest.fn().mockReturnValue('high'),
    getContextWindowSize: jest.fn().mockReturnValue(200000),
    isDefaultModel: jest.fn().mockImplementation((model: string) =>
      DEFAULT_MODELS.some(m => m.value === model)
    ),
    applyModelDefaults: jest.fn(),
    normalizeModelVariant: jest.fn((model: string) => model),
    permissionModes: {
      values: ['auto', 'manual', 'acceptEdits', 'yolo'],
      defaultValue: 'auto',
      fallbackValue: 'manual',
      transientValues: ['plan'],
    },
    getPermissionModeOptions: jest.fn().mockReturnValue([
      { value: 'auto', label: 'Auto', description: 'Auto desc' },
      { value: 'manual', label: 'Manual', description: 'Manual desc' },
      { value: 'acceptEdits', label: 'Accept edits', description: 'Accept edits desc' },
      { value: 'yolo', label: 'YOLO', description: 'YOLO desc', bypassesApprovals: true },
    ]),
    getPermissionTransientModeLabel: jest.fn().mockImplementation((value: string) => (
      value === 'plan' ? 'Plan' : null
    )),
    getServiceTierToggle: jest.fn().mockImplementation((settings: Record<string, unknown>) =>
      settings.model === DEFAULT_CODEX_PRIMARY_MODEL
        ? {
          inactiveValue: 'default',
          inactiveLabel: 'Standard',
          activeValue: 'fast',
          activeLabel: 'Fast',
          description: '1.5x speed, 2x credits',
        }
        : null
    ),
    getModeSelector: jest.fn().mockImplementation((settings: Record<string, unknown>) => ({
      activeValue: 'build',
      label: 'Mode',
      options: [
        { value: 'build', label: 'Build', description: 'Default editing agent' },
        { value: 'plan', label: 'Plan', description: 'Planning-first agent' },
      ],
      value: typeof settings.selectedMode === 'string' && settings.selectedMode
        ? settings.selectedMode
        : 'build',
    })),
  };
}

function createMockCallbacks(overrides: Record<string, any> = {}) {
  // Hoisted mocks break the self-referential initializer cycle (TS7022/TS7024).
  const getSettings = jest.fn().mockReturnValue({
    model: 'sonnet',
    thinkingBudget: 'low',
    effortLevel: 'high',
    serviceTier: 'default',
    permissionMode: 'normal',
    selectedMode: 'build',
    enableOpus1M: false,
    enableSonnet1M: false,
  });
  const getEnvironmentVariables = jest.fn().mockReturnValue('');
  const getUIConfig = jest.fn().mockReturnValue(createMockUIConfig());
  const callbacks = {
    getModelSelection: jest.fn(() => ({ providerId: 'claude', modelId: getSettings().model })),
    getModelOptions: jest.fn(() => getUIConfig().getModelOptions({
      ...getSettings(), environmentVariables: getEnvironmentVariables(),
    }).map((option: any) => ({ ...option, providerId: 'claude' }))),
    onModelChange: jest.fn().mockResolvedValue(undefined),
    onModeChange: jest.fn().mockResolvedValue(undefined),
    onThinkingBudgetChange: jest.fn().mockResolvedValue(undefined),
    onEffortLevelChange: jest.fn().mockResolvedValue(undefined),
    onServiceTierChange: jest.fn().mockResolvedValue(undefined),
    onPermissionModeChange: jest.fn().mockResolvedValue(undefined),
    getSettings,
    getEnvironmentVariables,
    getUIConfig,
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsRewind: true,
      supportsFork: true,
      supportsProviderCommands: true,
      reasoningControl: 'effort',
    }),
    ...overrides,
  };
  return callbacks;
}

describe('ModelSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ModelSelector;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    selector = new ModelSelector(parentEl, callbacks);
  });

  it('should create a container with model-selector class', () => {
    const container = parentEl.querySelector('.claudian-model-selector');
    expect(container).not.toBeNull();
  });

  it('should display current model label', () => {
    // Default model is 'sonnet' which maps to 'Sonnet'
    const btn = parentEl.querySelector('.claudian-model-btn');
    expect(btn).not.toBeNull();
    const label = btn?.querySelector('.claudian-model-label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('Sonnet');
  });

  it('should display first model when current model not found', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'nonexistent',
      thinkingBudget: 'low',
      serviceTier: 'default',
      permissionMode: 'normal',
      enableOpus1M: false,
      enableSonnet1M: false,
    });
    selector.updateDisplay();
    const label = parentEl.querySelector('.claudian-model-label');
    expect(label?.textContent).toBe('Haiku');
  });

  it('should render model options in reverse order', () => {
    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    expect(dropdown).not.toBeNull();
    // DEFAULT_CLAUDE_MODELS is [haiku, sonnet, opus] -> reversed is [opus, sonnet, haiku]
    const options = dropdown?.children || [];
    expect(options.length).toBe(3);
    // Text is in child span, check first child's textContent
    expect(options[0]?.children[0]?.textContent).toBe('Opus');
    expect(options[1]?.children[0]?.textContent).toBe('Sonnet');
    expect(options[2]?.children[0]?.textContent).toBe('Haiku');
  });

  it('should mark current model as selected', () => {
    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    const options = dropdown?.children || [];
    // Sonnet is current (index 1 in reversed order)
    const sonnetOption = options.find((o: any) => o.children[0]?.textContent === 'Sonnet');
    expect(sonnetOption?.hasClass('selected')).toBe(true);
  });

  it('should call onModelChange when option clicked', async () => {
    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    const options = dropdown?.children || [];
    const opusOption = options.find((o: any) => o.children[0]?.textContent === 'Opus');

    await opusOption?.dispatchEvent('click', { stopPropagation: () => {} });
    expect(callbacks.onModelChange).toHaveBeenCalledWith({ providerId: 'claude', modelId: 'opus' });
  });

  it('should always show brand color on model button', () => {
    const btn = parentEl.querySelector('.claudian-model-btn');
    expect(btn).toBeTruthy();
    expect(btn?.hasClass('ready')).toBe(false);
  });

  it('should use custom models from environment variables', () => {
    callbacks.getEnvironmentVariables.mockReturnValue(
      'CLAUDE_CODE_USE_BEDROCK=1\nANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-20250514-v1:0'
    );
    callbacks.getSettings.mockReturnValue({
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      thinkingBudget: 'low',
      permissionMode: 'normal',
      enableOpus1M: false,
      enableSonnet1M: false,
    });
    selector.renderOptions();
    selector.updateDisplay();
    // Custom models should be available in dropdown
    const label = parentEl.querySelector('.claudian-model-label');
    expect(label?.textContent).toBeDefined();
  });

  it('should not filter custom env models when 1M toggles are enabled', () => {
    callbacks.getEnvironmentVariables.mockReturnValue(
      'ANTHROPIC_MODEL=opus'
    );
    callbacks.getSettings.mockReturnValue({
      model: 'opus',
      thinkingBudget: 'low',
      permissionMode: 'normal',
      enableOpus1M: true,
      enableSonnet1M: true,
    });

    selector.renderOptions();
    selector.updateDisplay();

    const label = parentEl.querySelector('.claudian-model-label');
    expect(label?.textContent).toBe('Opus');
  });

  it('should render group separators when models have group field', () => {
    const groupedModels = [
      { value: 'opus', label: 'Opus', group: 'Claude' },
      { value: 'sonnet', label: 'Sonnet', group: 'Claude' },
      { value: DEFAULT_CODEX_PRIMARY_MODEL, label: DEFAULT_CODEX_PRIMARY_MODEL_LABEL, group: 'Codex' },
    ];
    const uiConfig = createMockUIConfig();
    uiConfig.getModelOptions.mockReturnValue(groupedModels);
    callbacks.getUIConfig.mockReturnValue(uiConfig);
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      effortLevel: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
    });

    selector.renderOptions();

    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    const children = dropdown?.children || [];
    // Reversed: [Codex group, built-in Codex model, Claude group, Sonnet, Opus]
    const groups = children.filter((c: any) => c.hasClass('claudian-model-group'));
    expect(groups.length).toBe(2);
    expect(groups[0]?.textContent).toBe('Codex');
    expect(groups[1]?.textContent).toBe('Claude');
  });

  it('should not render group separators when models have no group field', () => {
    selector.renderOptions();

    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    const children = dropdown?.children || [];
    const groups = children.filter((c: any) => c.hasClass('claudian-model-group'));
    expect(groups.length).toBe(0);
  });

  it('should show 1M variants instead of standard variants when enabled', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'opus[1m]',
      thinkingBudget: 'medium',
      serviceTier: 'default',
      permissionMode: 'normal',
      enableOpus1M: true,
      enableSonnet1M: true,
    });

    selector.renderOptions();
    selector.updateDisplay();

    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    const options = dropdown?.children || [];
    expect(options.find((o: any) => o.children[0]?.textContent === 'Opus 1M')).toBeDefined();
    expect(options.find((o: any) => o.children[0]?.textContent === 'Sonnet 1M')).toBeDefined();
    expect(options.find((o: any) => o.children[0]?.textContent === 'Opus')).toBeUndefined();
    expect(options.find((o: any) => o.children[0]?.textContent === 'Sonnet')).toBeUndefined();
    expect(parentEl.querySelector('.claudian-model-label')?.textContent).toBe('Opus 1M');
  });
});

describe('ModeSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ModeSelector;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    selector = new ModeSelector(parentEl, callbacks);
  });

  it('should create a container with mode-selector class', () => {
    const container = parentEl.querySelector('.claudian-mode-selector');
    expect(container).not.toBeNull();
  });

  it('should display the current mode label', () => {
    const label = parentEl.querySelector('.claudian-mode-label');
    expect(label?.textContent).toBe('Build');
  });

  it('should call onModeChange when the toggle is clicked', async () => {
    const toggle = parentEl.querySelector('.claudian-toggle-switch');
    await toggle?.dispatchEvent('click');

    expect(callbacks.onModeChange).toHaveBeenCalledWith('plan');
  });

  it('should show the active style when the configured active mode is selected', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      effortLevel: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
      selectedMode: 'build',
      enableOpus1M: false,
      enableSonnet1M: false,
    });

    const parentEl2 = createMockEl();
    new ModeSelector(parentEl2, callbacks);

    const label = parentEl2.querySelector('.claudian-mode-label');
    const toggle = parentEl2.querySelector('.claudian-toggle-switch');
    expect(label?.textContent).toBe('Build');
    expect(label?.hasClass('active')).toBe(true);
    expect(toggle?.hasClass('active')).toBe(true);
  });

  it('should show the inactive style when the configured inactive mode is selected', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      effortLevel: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
      selectedMode: 'plan',
      enableOpus1M: false,
      enableSonnet1M: false,
    });

    const parentEl2 = createMockEl();
    new ModeSelector(parentEl2, callbacks);

    const label = parentEl2.querySelector('.claudian-mode-label');
    const toggle = parentEl2.querySelector('.claudian-toggle-switch');
    expect(label?.textContent).toBe('Plan');
    expect(label?.hasClass('active')).toBe(false);
    expect(toggle?.hasClass('active')).toBe(false);
  });

  it('should hide when the provider exposes no mode selector', () => {
    const uiConfig = createMockUIConfig();
    uiConfig.getModeSelector.mockReturnValue(null);
    callbacks.getUIConfig.mockReturnValue(uiConfig);

    selector.updateDisplay();

    const container = parentEl.querySelector('.claudian-mode-selector');
    expect(container?.style?.display).toBe('none');
  });
});

describe('ThinkingBudgetSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ThinkingBudgetSelector;

  describe('adaptive mode (Claude models)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      parentEl = createMockEl();
      callbacks = createMockCallbacks();
      selector = new ThinkingBudgetSelector(parentEl, callbacks);
    });

    it('should create a container with thinking-selector class', () => {
      const container = parentEl.querySelector('.claudian-thinking-selector');
      expect(container).not.toBeNull();
    });

    it('should show effort selector for Claude models', () => {
      const effort = parentEl.querySelector('.claudian-thinking-effort');
      expect(effort).not.toBeNull();
      expect(effort?.style?.display).not.toBe('none');
    });

    it('should hide budget selector for Claude models', () => {
      const budget = parentEl.querySelector('.claudian-thinking-budget');
      expect(budget?.style?.display).toBe('none');
    });

    it('should display current effort level for Claude models', () => {
      const current = parentEl.querySelector('.claudian-thinking-current');
      expect(current?.textContent).toBe('High');
    });
  });

  describe('legacy mode (custom models)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      parentEl = createMockEl();
      callbacks = createMockCallbacks({
        getSettings: jest.fn().mockReturnValue({
          model: 'custom-model',
          thinkingBudget: 'low',
          effortLevel: 'high',
          serviceTier: 'default',
          permissionMode: 'normal',
          enableOpus1M: false,
          enableSonnet1M: false,
        }),
      });
      selector = new ThinkingBudgetSelector(parentEl, callbacks);
    });

    it('should hide effort selector for custom models', () => {
      const effort = parentEl.querySelector('.claudian-thinking-effort');
      expect(effort?.style?.display).toBe('none');
    });

    it('should show budget selector for custom models', () => {
      const budget = parentEl.querySelector('.claudian-thinking-budget');
      expect(budget?.style?.display).not.toBe('none');
    });

    it('should display current budget label', () => {
      const current = parentEl.querySelector('.claudian-thinking-current');
      expect(current?.textContent).toBe('Low');
    });

    it('should display Off when budget is off', () => {
      callbacks.getSettings.mockReturnValue({
        model: 'custom-model',
        thinkingBudget: 'off',
        serviceTier: 'default',
        permissionMode: 'normal',
        enableOpus1M: false,
        enableSonnet1M: false,
      });
      selector.updateDisplay();
      const current = parentEl.querySelector('.claudian-thinking-current');
      expect(current?.textContent).toBe('Off');
    });

    it('should render budget options in reverse order', () => {
      const options = parentEl.querySelector('.claudian-thinking-options');
      expect(options).not.toBeNull();
      // THINKING_BUDGETS reversed: [xhigh, high, medium, low, off]
      const gears = options?.children || [];
      expect(gears.length).toBe(5);
      expect(gears[0]?.textContent).toBe('Ultra');
      expect(gears[4]?.textContent).toBe('Off');
    });

    it('should mark current budget as selected', () => {
      const options = parentEl.querySelector('.claudian-thinking-options');
      const gears = options?.children || [];
      const lowGear = gears.find((g: any) => g.textContent === 'Low');
      expect(lowGear?.hasClass('selected')).toBe(true);
    });

    it('should call onThinkingBudgetChange when gear clicked', async () => {
      const options = parentEl.querySelector('.claudian-thinking-options');
      const gears = options?.children || [];
      const highGear = gears.find((g: any) => g.textContent === 'High');

      await highGear?.dispatchEvent('click', { stopPropagation: () => {} });
      expect(callbacks.onThinkingBudgetChange).toHaveBeenCalledWith('high');
    });

    it('should set title with token count for non-off budgets', () => {
      const options = parentEl.querySelector('.claudian-thinking-options');
      const gears = options?.children || [];
      const highGear = gears.find((g: any) => g.textContent === 'High');
      expect(highGear?.getAttribute('title')).toContain('16,000 tokens');
    });

    it('should set title as Disabled for off budget', () => {
      const options = parentEl.querySelector('.claudian-thinking-options');
      const gears = options?.children || [];
      const offGear = gears.find((g: any) => g.textContent === 'Off');
      expect(offGear?.getAttribute('title')).toBe('Disabled');
    });
  });
});

describe('PermissionToggle', () => {
  let callbacks: ReturnType<typeof createMockCallbacks>;

  function mockSettings(permissionMode: string) {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      effortLevel: 'high',
      serviceTier: 'default',
      permissionMode,
      enableOpus1M: false,
      enableSonnet1M: false,
    });
  }

  function renderToggle() {
    const el = createMockEl();
    const toggle = new PermissionToggle(el, callbacks);
    return { el, toggle };
  }

  function findButton(el: any) {
    return el.querySelector('.claudian-permission-button');
  }

  function findMenu(el: any) {
    return el.querySelector('.claudian-permission-menu');
  }

  function findItems(el: any) {
    return (findMenu(el)?.children ?? []) as any[];
  }

  function findLabel(el: any) {
    return el.querySelector('.claudian-permission-label');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    callbacks = createMockCallbacks();
    mockSettings('auto');
  });

  it('renders a real button with permission-menu aria', () => {
    const { el } = renderToggle();

    const button = findButton(el);
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-haspopup')).toBe('menu');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe('Permission mode: Auto');
    expect(findMenu(el)).not.toBeNull();
  });

  it('shows the current mode label from the provider options', () => {
    mockSettings('acceptEdits');
    const { el } = renderToggle();

    expect(findLabel(el)?.textContent).toBe('Accept edits');
    expect(findButton(el)?.getAttribute('aria-label')).toBe('Permission mode: Accept edits');
  });

  it('lists the four modes with descriptions and marks only the current one', () => {
    mockSettings('manual');
    const { el } = renderToggle();

    const items = findItems(el);
    expect(items.length).toBe(4);
    expect(items.map((item: any) => item.getAttribute('role'))).toEqual([
      'menuitemradio', 'menuitemradio', 'menuitemradio', 'menuitemradio',
    ]);
    expect(items.map((item: any) => item.getAttribute('aria-checked')))
      .toEqual(['false', 'true', 'false', 'false']);
    const labelOf = (item: any) => item.querySelector('.claudian-permission-option-label')?.textContent;
    const descOf = (item: any) => item.querySelector('.claudian-permission-option-desc')?.textContent;
    expect(items.map(labelOf)).toEqual(['Auto', 'Manual', 'Accept edits', 'YOLO']);
    expect(items.map(descOf)).toEqual(['Auto desc', 'Manual desc', 'Accept edits desc', 'YOLO desc']);
    // Only the selected item carries a check icon span.
    expect(items.filter((item: any) => item.querySelector('.claudian-permission-check')).length)
      .toBe(1);
  });

  it('flags only bypassing modes with the shield-alert warning', () => {
    const { el } = renderToggle();
    expect(findButton(el)?.hasClass('claudian-permission-warning')).toBe(false);

    mockSettings('yolo');
    const rendered = renderToggle();
    expect(findButton(rendered.el)?.hasClass('claudian-permission-warning')).toBe(true);
    expect(findLabel(rendered.el)?.textContent).toBe('YOLO');
  });

  it('opens the menu on button click and closes it on a second click', () => {
    const { el, toggle } = renderToggle();
    const button = findButton(el);

    button?.dispatchEvent('click');
    expect(toggle.isMenuOpen()).toBe(true);
    expect(button?.getAttribute('aria-expanded')).toBe('true');

    button?.dispatchEvent('click');
    expect(toggle.isMenuOpen()).toBe(false);
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  it('commits a different mode through onPermissionModeChange', async () => {
    mockSettings('auto');
    const { el } = renderToggle();
    findButton(el)?.dispatchEvent('click');

    const items = findItems(el);
    const yolo = items.find((item: any) => item.querySelector('.claudian-permission-option-label')?.textContent === 'YOLO');
    await yolo?.dispatchEvent('click', { stopPropagation: jest.fn() });

    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('yolo');
  });

  it('never commits a same-value selection', async () => {
    mockSettings('yolo');
    const { el, toggle } = renderToggle();
    findButton(el)?.dispatchEvent('click');

    const items = findItems(el);
    const yolo = items.find((item: any) => item.querySelector('.claudian-permission-option-label')?.textContent === 'YOLO');
    await yolo?.dispatchEvent('click', { stopPropagation: jest.fn() });

    expect(callbacks.onPermissionModeChange).not.toHaveBeenCalled();
    expect(toggle.isMenuOpen()).toBe(false);
  });

  it('shows plan as a read-only state without a fifth menu option', () => {
    mockSettings('plan');
    const { el } = renderToggle();

    expect(findLabel(el)?.textContent).toBe('Plan');
    expect(findLabel(el)?.hasClass('plan-active')).toBe(true);
    const items = findItems(el);
    expect(items.length).toBe(4);
    expect(items.every((item: any) => item.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('exits plan when a durable mode is explicitly selected', async () => {
    mockSettings('plan');
    const { el } = renderToggle();
    findButton(el)?.dispatchEvent('click');

    const items = findItems(el);
    const manual = items.find((item: any) => item.querySelector('.claudian-permission-option-label')?.textContent === 'Manual');
    await manual?.dispatchEvent('click', { stopPropagation: jest.fn() });

    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('manual');
  });

  it('renders an unknown mode as unavailable instead of falling back to options[0]', () => {
    mockSettings('mystery');
    const { el } = renderToggle();

    expect(findLabel(el)?.textContent).toBe('Unavailable');
    const items = findItems(el);
    expect(items.every((item: any) => item.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('supports keyboard open, navigate, and select', async () => {
    mockSettings('auto');
    const { el, toggle } = renderToggle();
    const button = findButton(el);

    // The handler lives on the toggle container; real DOM events bubble from
    // the focused button/item, the mock dispatches at the listener element.
    const container = el.querySelector('.claudian-permission-toggle');
    const downEvent = { type: 'keydown', key: 'ArrowDown', target: button, preventDefault: jest.fn() };
    container?.dispatchEvent(downEvent);
    expect(toggle.isMenuOpen()).toBe(true);

    // Arrow down to 'Accept edits' (index 2), then activate it with Enter.
    container?.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault: jest.fn() });
    container?.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault: jest.fn() });
    const enterEvent = { type: 'keydown', key: 'Enter', preventDefault: jest.fn() };
    container?.dispatchEvent(enterEvent);

    await Promise.resolve();
    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
  });

  it('consumes Escape while the menu is open and closes it', () => {
    const { el, toggle } = renderToggle();
    findButton(el)?.dispatchEvent('click');

    const escapeEvent = { type: 'keydown', key: 'Escape', preventDefault: jest.fn() };
    const consumed = toggle.handleKeydown(escapeEvent as unknown as KeyboardEvent);

    expect(consumed).toBe(true);
    expect(toggle.isMenuOpen()).toBe(false);
    expect(escapeEvent.preventDefault).toHaveBeenCalled();
  });

  it('does not consume Escape when the menu is closed', () => {
    const { toggle } = renderToggle();

    const consumed = toggle.handleKeydown({ key: 'Escape' } as unknown as KeyboardEvent);
    expect(consumed).toBe(false);
  });

  it('closes on an outside document click and removes the listener', () => {
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const docMock = {
      addEventListener: jest.fn((event: string, handler: (e: any) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(handler);
      }),
      removeEventListener: jest.fn((event: string, handler: (e: any) => void) => {
        listeners[event] = (listeners[event] ?? []).filter(h => h !== handler);
      }),
    };
    const originalDocument = (global as any).document;
    (global as any).document = docMock;

    try {
      const { el, toggle } = renderToggle();
      findButton(el)?.dispatchEvent('click');
      expect(toggle.isMenuOpen()).toBe(true);
      expect(docMock.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));

      // Outside click closes the menu.
      listeners.click[0]({ target: createMockEl() });
      expect(toggle.isMenuOpen()).toBe(false);

      // The listener is detached once closed.
      toggle.destroy();
      expect(listeners.click.length).toBe(0);
      expect(docMock.removeEventListener).toHaveBeenCalled();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('destroys idempotently and clears the DOM', () => {
    const { el, toggle } = renderToggle();
    findButton(el)?.dispatchEvent('click');

    toggle.destroy();
    toggle.destroy();

    expect(el.querySelector('.claudian-permission-button')).toBeNull();
    expect(el.querySelector('.claudian-permission-menu')).toBeNull();
    expect(toggle.isMenuOpen()).toBe(false);
  });

  it('hides the control when the provider exposes no permission options', () => {
    callbacks.getUIConfig.mockReturnValue({
      ...createMockUIConfig(),
      getPermissionModeOptions: jest.fn().mockReturnValue(null),
    });
    const { el, toggle } = renderToggle();

    const container = el.querySelector('.claudian-permission-toggle');
    expect(container?.style.display).toBe('none');
    expect(toggle.isMenuOpen()).toBe(false);
  });

  it('hides the control when visibility is disabled explicitly and closes an open menu', () => {
    const { el, toggle } = renderToggle();
    findButton(el)?.dispatchEvent('click');

    toggle.setVisible(false);

    const container = el.querySelector('.claudian-permission-toggle');
    expect(container?.style.display).toBe('none');
    expect(toggle.isMenuOpen()).toBe(false);
  });

  it('drives a two-option provider through the same menu path', () => {
    callbacks.getUIConfig.mockReturnValue({
      ...createMockUIConfig(),
      permissionModes: {
        values: ['normal', 'yolo'],
        defaultValue: 'normal',
        fallbackValue: 'normal',
        transientValues: ['plan'],
      },
      getPermissionModeOptions: jest.fn().mockReturnValue([
        { value: 'normal', label: 'Safe' },
        { value: 'yolo', label: 'YOLO', bypassesApprovals: true },
      ]),
      getPermissionTransientModeLabel: jest.fn().mockImplementation((value: string) => (
        value === 'plan' ? 'Plan' : null
      )),
    });
    mockSettings('normal');
    const { el } = renderToggle();

    const items = findItems(el);
    expect(items.length).toBe(2);
    expect(findLabel(el)?.textContent).toBe('Safe');
    expect(items.map((item: any) =>
      item.querySelector('.claudian-permission-option-label')?.textContent)).toEqual(['Safe', 'YOLO']);
  });
});

describe('ServiceTierToggle', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    const uiConfig = createMockUIConfig();
    uiConfig.getServiceTierToggle.mockReturnValue({
      inactiveValue: 'default',
      inactiveLabel: 'Standard',
      activeValue: 'fast',
      activeLabel: 'Fast',
      description: '1.5x speed, 2x credits',
    });
    callbacks = createMockCallbacks({
      getUIConfig: jest.fn().mockReturnValue(uiConfig),
      getSettings: jest.fn().mockReturnValue({
        model: DEFAULT_CODEX_PRIMARY_MODEL,
        thinkingBudget: 'off',
        effortLevel: 'medium',
        serviceTier: 'default',
        permissionMode: 'normal',
      }),
    });
    new ServiceTierToggle(parentEl, callbacks);
  });

  it('shows the control when the provider exposes service tier options', () => {
    const container = parentEl.querySelector('.claudian-service-tier-toggle');
    expect(container).not.toBeNull();
    expect(container?.style.display).toBe('');
  });

  it('renders the icon button in the inactive state when fast mode is off', () => {
    const button = parentEl.querySelector('.claudian-service-tier-button');
    const icon = parentEl.querySelector('.claudian-service-tier-icon');
    const container = parentEl.querySelector('.claudian-service-tier-toggle');
    expect(button?.hasClass('active')).toBe(false);
    expect(icon).not.toBeNull();
    expect(container?.getAttribute('title')).toBe('Toggle on/off fast mode');
  });

  it('renders the icon button in the active state when fast mode is on', () => {
    callbacks.getSettings.mockReturnValue({
      model: DEFAULT_CODEX_PRIMARY_MODEL,
      thinkingBudget: 'off',
      effortLevel: 'medium',
      serviceTier: 'fast',
      permissionMode: 'normal',
    });
    const parentEl2 = createMockEl();
    new ServiceTierToggle(parentEl2, callbacks);

    const button = parentEl2.querySelector('.claudian-service-tier-button');
    const container = parentEl2.querySelector('.claudian-service-tier-toggle');
    expect(button?.hasClass('active')).toBe(true);
    expect(container?.getAttribute('title')).toBe('Toggle on/off fast mode');
  });

  it('toggles from Standard to Fast on click', async () => {
    const button = parentEl.querySelector('.claudian-service-tier-button');
    await button?.dispatchEvent('click');
    expect(callbacks.onServiceTierChange).toHaveBeenCalledWith('fast');
  });

  it('toggles from Fast to Standard on click', async () => {
    callbacks.getSettings.mockReturnValue({
      model: DEFAULT_CODEX_PRIMARY_MODEL,
      thinkingBudget: 'off',
      effortLevel: 'medium',
      serviceTier: 'fast',
      permissionMode: 'normal',
    });
    const parentEl2 = createMockEl();
    new ServiceTierToggle(parentEl2, callbacks);

    const button = parentEl2.querySelector('.claudian-service-tier-button');
    await button?.dispatchEvent('click');
    expect(callbacks.onServiceTierChange).toHaveBeenCalledWith('default');
  });

  it('hides the control when the provider exposes no service tier UI', () => {
    callbacks.getUIConfig.mockReturnValue({
      ...createMockUIConfig(),
      getServiceTierToggle: jest.fn().mockReturnValue(null),
    });
    const parentEl2 = createMockEl();
    new ServiceTierToggle(parentEl2, callbacks);

    const container = parentEl2.querySelector('.claudian-service-tier-toggle');
    expect(container?.style.display).toBe('none');
  });
});

describe('McpServerSelector', () => {
  let parentEl: any;
  let selector: McpServerSelector;

  function createMockMcpManager(servers: { name: string; enabled: boolean; contextSaving?: boolean }[] = []) {
    return {
      getServers: jest.fn().mockReturnValue(
        servers.map(s => ({
          name: s.name,
          enabled: s.enabled,
          contextSaving: s.contextSaving ?? false,
        }))
      ),
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    selector = new McpServerSelector(parentEl);
  });

  it('should create container with mcp-selector class', () => {
    const container = parentEl.querySelector('.claudian-mcp-selector');
    expect(container).not.toBeNull();
  });

  it('should return empty set of enabled servers initially', () => {
    expect(selector.getEnabledServers().size).toBe(0);
  });

  it('should hide container when no servers configured', () => {
    selector.setMcpManager(createMockMcpManager([]));
    const container = parentEl.querySelector('.claudian-mcp-selector');
    expect(container?.style.display).toBe('none');
  });

  it('should show container when servers are configured', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'test', enabled: true }]));
    const container = parentEl.querySelector('.claudian-mcp-selector');
    expect(container?.style.display).toBe('');
  });

  it('should show empty message when all servers are disabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'test', enabled: false }]));
    const empty = parentEl.querySelector('.claudian-mcp-selector-empty');
    expect(empty?.textContent).toBe('All MCP servers disabled');
  });

  it('should show no servers message when no servers configured', () => {
    selector.setMcpManager(createMockMcpManager([]));
    const empty = parentEl.querySelector('.claudian-mcp-selector-empty');
    expect(empty?.textContent).toBe('No MCP servers configured');
  });

  it('should add mentioned servers', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.addMentionedServers(new Set(['server1']));
    expect(selector.getEnabledServers().has('server1')).toBe(true);
  });

  it('should not re-render when adding already enabled servers', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.addMentionedServers(new Set(['server1']));
    const enabledBefore = selector.getEnabledServers();

    selector.addMentionedServers(new Set(['server1']));
    expect(selector.getEnabledServers()).toEqual(enabledBefore);
  });

  it('should clear all enabled servers', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.addMentionedServers(new Set(['server1', 'server2']));
    expect(selector.getEnabledServers().size).toBe(2);

    selector.clearEnabled();
    expect(selector.getEnabledServers().size).toBe(0);
  });

  it('should set enabled servers from array', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    expect(selector.getEnabledServers().size).toBe(2);
  });

  it('should prune enabled servers that no longer exist in manager', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);

    // Now update manager to only have server1
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    expect(selector.getEnabledServers().has('server1')).toBe(true);
    expect(selector.getEnabledServers().has('server2')).toBe(false);
  });

  it('should invoke onChange callback when pruning removes servers', () => {
    const onChange = jest.fn();
    selector.setOnChange(onChange);

    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    onChange.mockClear();

    // Prune by removing server2
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    expect(onChange).toHaveBeenCalled();
  });

  it('should show badge when more than 1 server enabled', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    selector.updateDisplay();

    const badge = parentEl.querySelector('.claudian-mcp-selector-badge');
    expect(badge?.hasClass('visible')).toBe(true);
    expect(badge?.textContent).toBe('2');
  });

  it('should not show badge when only 1 server enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.setEnabledServers(['server1']);
    selector.updateDisplay();

    const badge = parentEl.querySelector('.claudian-mcp-selector-badge');
    expect(badge?.hasClass('visible')).toBe(false);
  });

  it('should add active class to icon when servers are enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.setEnabledServers(['server1']);
    selector.updateDisplay();

    const icon = parentEl.querySelector('.claudian-mcp-selector-icon');
    expect(icon?.hasClass('active')).toBe(true);
  });

  it('should remove active class from icon when no servers enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.clearEnabled();
    selector.updateDisplay();

    const icon = parentEl.querySelector('.claudian-mcp-selector-icon');
    expect(icon?.hasClass('active')).toBe(false);
  });

  it('should handle null mcpManager', () => {
    selector.setMcpManager(null);
    expect(selector.getEnabledServers().size).toBe(0);
  });
});

describe('ContextUsageMeter', () => {
  let parentEl: any;
  let meter: ContextUsageMeter;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    meter = new ContextUsageMeter(parentEl);
  });

  it('should create a container with context-meter class', () => {
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container).not.toBeNull();
  });

  it('should be hidden initially', () => {
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.style.display).toBe('none');
  });

  it('should remain hidden when update called with null', () => {
    meter.update(null);
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.style.display).toBe('none');
  });

  it('should remain hidden when contextTokens is 0', () => {
    meter.update(makeUsage({ contextTokens: 0, contextWindow: 200000, percentage: 0 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.style.display).toBe('none');
  });

  it('should become visible when contextTokens > 0', () => {
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.style.display).toBe('flex');
  });

  it('should display percentage', () => {
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const percent = parentEl.querySelector('.claudian-context-meter-percent');
    expect(percent?.textContent).toBe('25%');
  });

  it('should add warning class when usage > 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.hasClass('warning')).toBe(true);
  });

  it('should remove warning class when usage drops below 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.hasClass('warning')).toBe(false);
  });

  it('should set tooltip with formatted token counts', () => {
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('50k / 200k');
  });

  it('should format small token counts without k suffix', () => {
    meter.update(makeUsage({ contextTokens: 500, contextWindow: 200000, percentage: 0 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('500 / 200k');
  });

  it('should add compact reminder to tooltip when usage > 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('170k / 200k (Approaching limit, run `/compact` to continue)');
  });

  it('should not add compact reminder to tooltip when usage ≤ 80%', () => {
    meter.update(makeUsage({ contextTokens: 160000, contextWindow: 200000, percentage: 80 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('160k / 200k');
  });
});

describe('McpServerSelector - toggle and badges', () => {
  let parentEl: any;
  let selector: McpServerSelector;

  function createMockMcpManager(servers: { name: string; enabled: boolean; contextSaving?: boolean }[] = []) {
    return {
      getServers: jest.fn().mockReturnValue(
        servers.map(s => ({
          name: s.name,
          enabled: s.enabled,
          contextSaving: s.contextSaving ?? false,
        }))
      ),
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    selector = new McpServerSelector(parentEl);
  });

  it('should render context-saving badge for servers with contextSaving', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true, contextSaving: true },
    ]));

    const csBadge = parentEl.querySelector('.claudian-mcp-selector-cs-badge');
    expect(csBadge).not.toBeNull();
    expect(csBadge?.textContent).toBe('@');
  });

  it('should not render context-saving badge for servers without contextSaving', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true, contextSaving: false },
    ]));

    const csBadge = parentEl.querySelector('.claudian-mcp-selector-cs-badge');
    expect(csBadge).toBeNull();
  });

  it('should toggle server on mousedown and update display', () => {
    const onChange = jest.fn();
    selector.setOnChange(onChange);

    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
    ]));

    // Find the server item and trigger mousedown
    const item = parentEl.querySelector('.claudian-mcp-selector-item');
    expect(item).not.toBeNull();

    // Simulate mousedown to enable
    const mousedownHandlers = item._eventListeners?.get('mousedown');
    expect(mousedownHandlers).toBeDefined();
    mousedownHandlers![0]({ preventDefault: jest.fn(), stopPropagation: jest.fn() });

    expect(selector.getEnabledServers().has('server1')).toBe(true);
    expect(onChange).toHaveBeenCalled();

    // Toggle again to disable
    onChange.mockClear();
    mousedownHandlers![0]({ preventDefault: jest.fn(), stopPropagation: jest.fn() });

    expect(selector.getEnabledServers().has('server1')).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('should re-render dropdown on mouseenter', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
    ]));

    // Get container and trigger mouseenter
    const container = parentEl.querySelector('.claudian-mcp-selector');
    const mouseenterHandlers = container?._eventListeners?.get('mouseenter');
    expect(mouseenterHandlers).toBeDefined();

    // Should not throw
    expect(() => mouseenterHandlers![0]()).not.toThrow();
  });
});

describe('createInputToolbar', () => {
  it('should return all toolbar components', () => {
    const parentEl = createMockEl();
    const callbacks = createMockCallbacks();
    const toolbar = createInputToolbar(parentEl, callbacks);

    expect(toolbar.modelSelector).toBeInstanceOf(ModelSelector);
    expect(toolbar.modeSelector).toBeInstanceOf(ModeSelector);
    expect(toolbar.thinkingBudgetSelector).toBeInstanceOf(ThinkingBudgetSelector);
    expect(toolbar.contextUsageMeter).toBeInstanceOf(ContextUsageMeter);
    expect(toolbar.mcpServerSelector).toBeInstanceOf(McpServerSelector);
    expect(toolbar.permissionToggle).toBeInstanceOf(PermissionToggle);
    expect(toolbar.serviceTierToggle).toBeInstanceOf(ServiceTierToggle);
  });

  it('should place the mode selector after the permission toggle in toolbar order', () => {
    const parentEl = createMockEl();
    const callbacks = createMockCallbacks();

    createInputToolbar(parentEl, callbacks);

    const permissionIndex = parentEl.children.findIndex((child: any) => child.hasClass('claudian-permission-toggle'));
    const modeIndex = parentEl.children.findIndex((child: any) => child.hasClass('claudian-mode-selector'));
    expect(permissionIndex).toBeGreaterThanOrEqual(0);
    expect(modeIndex).toBeGreaterThan(permissionIndex);
    expect(modeIndex).toBe(parentEl.children.length - 1);
  });
});
