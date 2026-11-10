import * as fs from 'fs';
// The module-level `jest.mock('fs')` swaps fs for the automock; the cutover
// notice test needs the REAL fs for its temp-dir fixtures, restored via
// requireActual inside that test.
import type * as os from 'os';
import type * as path from 'path';

import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from '@/providers/claude/settings';
import { claudeSettingsTabRenderer } from '@/providers/claude/ui/ClaudeSettingsTab';

const mockRenderEnvironmentSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);

jest.mock('fs');
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    reconcileTitleGenerationModelSelection: jest.fn((settings: Record<string, unknown>) => {
      const titleGenerationModel = settings.titleGenerationModel;
      const customModels = (
        settings.providerConfigs as { claude?: { customModels?: string } } | undefined
      )?.claude?.customModels ?? '';
      if (titleGenerationModel === 'claude-opus-4-6' && customModels !== 'claude-opus-4-6') {
        settings.titleGenerationModel = '';
        return true;
      }
      return false;
    }),
  },
}));

jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public textComponents: MockTextComponent[] = [];
    public textAreaComponents: MockTextAreaComponent[] = [];
    public dropdownComponents: MockDropdownComponent[] = [];
    public toggleComponents: MockToggleComponent[] = [];
    public buttonComponents: MockButtonComponent[] = [];
    public infoEl = createInfoElement();

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(name: string) {
      this.name = name;
      return this;
    }

    setDesc(desc: string) {
      this.desc = desc;
      return this;
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    addText(callback: (text: MockTextComponent) => void) {
      const component = createTextComponent();
      this.textComponents.push(component);
      callback(component);
      return this;
    }

    addTextArea(callback: (text: MockTextAreaComponent) => void) {
      const component = createTextAreaComponent();
      this.textAreaComponents.push(component);
      callback(component);
      return this;
    }

    addDropdown(callback: (dropdown: MockDropdownComponent) => void) {
      const component = createDropdownComponent();
      this.dropdownComponents.push(component);
      callback(component);
      return this;
    }

    addToggle(callback: (toggle: MockToggleComponent) => void) {
      const component = createToggleComponent();
      this.toggleComponents.push(component);
      callback(component);
      return this;
    }

    addButton(callback: (button: MockButtonComponent) => void) {
      const component = createButtonComponent();
      this.buttonComponents.push(component);
      callback(component);
      return this;
    }
  }

  return {
    Setting: MockSetting,
    Modal: class MockModal {
      app: any;
      modalEl: any;
      contentEl: any;

      constructor(app: any) {
        this.app = app;
        this.modalEl = { addClass: jest.fn() };
        this.contentEl = {
          createDiv: jest.fn().mockReturnValue({ createEl: jest.fn(), createDiv: jest.fn() }),
          createEl: jest.fn().mockReturnValue({ setAttribute: jest.fn() }),
          empty: jest.fn(),
        };
      }

      setTitle = jest.fn();
      open = jest.fn();
      close = jest.fn();
      onOpen(): void {}
      onClose(): void {}
    },
    Notice: class MockNotice {
      constructor(public message: string) {}
    },
  };
});

jest.mock('@/features/settings/ui/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));

jest.mock('@/providers/claude/app/ClaudeWorkspaceServices', () => ({
  getClaudeWorkspaceServices: jest.fn(() => ({
    cliResolver: {
      reset: jest.fn(),
    },
    commandCatalog: {},
    agentManager: {},
    agentStorage: {},
    pluginManager: {},
  })),
}));

jest.mock('@/providers/claude/ui/AgentSettings', () => ({
  AgentSettings: jest.fn(),
}));

jest.mock('@/providers/claude/ui/PluginSettingsManager', () => ({
  PluginSettingsManager: jest.fn(),
}));

jest.mock('@/providers/claude/ui/SlashCommandSettings', () => ({
  SlashCommandSettings: jest.fn(),
}));

jest.mock('@/i18n/i18n', () => ({
  t: (key: string) => key,
}));

jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: () => 'host-a',
  };
});

interface MockInputEl {
  rows: number;
  cols: number;
  value: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  addClass: jest.Mock;
  addEventListener: jest.Mock;
}

interface MockTextComponent {
  value: string;
  placeholder: string;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  setPlaceholder: jest.MockedFunction<(value: string) => MockTextComponent>;
  setValue: jest.MockedFunction<(value: string) => MockTextComponent>;
  onChange: jest.MockedFunction<(callback: (value: string) => Promise<void> | void) => MockTextComponent>;
  inputEl: MockInputEl;
}

interface MockTextAreaComponent extends MockTextComponent {
  trigger: (event: string) => Promise<void>;
}

interface MockDropdownComponent {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  addOption: jest.MockedFunction<(value: string, label: string) => MockDropdownComponent>;
  setValue: jest.MockedFunction<(value: string) => MockDropdownComponent>;
  onChange: jest.MockedFunction<(callback: (value: string) => Promise<void> | void) => MockDropdownComponent>;
}

interface MockToggleComponent {
  value: boolean;
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: jest.MockedFunction<(value: boolean) => MockToggleComponent>;
  onChange: jest.MockedFunction<(callback: (value: boolean) => Promise<void> | void) => MockToggleComponent>;
}

interface MockButtonComponent {
  buttonText: string;
  cta: boolean;
  onClickCallback: (() => void) | null;
  setButtonText: jest.MockedFunction<(text: string) => MockButtonComponent>;
  setCta: jest.MockedFunction<() => MockButtonComponent>;
  onClick: jest.MockedFunction<(callback: () => void) => MockButtonComponent>;
}

const createdSettings: Array<{
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  textAreaComponents: MockTextAreaComponent[];
  dropdownComponents: MockDropdownComponent[];
  toggleComponents: MockToggleComponent[];
  buttonComponents: MockButtonComponent[];
}> = [];

function createInputEl(): MockInputEl & { _listeners: Map<string, Array<() => void>> } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    rows: 0,
    cols: 0,
    value: '',
    style: {},
    dataset: {},
    addClass: jest.fn(),
    addEventListener: jest.fn((event: string, handler: () => void) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    }),
    _listeners: listeners,
  };
}

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.value = '';
  component.placeholder = '';
  component.onChangeCallback = null;
  component.inputEl = createInputEl();
  component.setPlaceholder = jest.fn((value: string) => {
    component.placeholder = value;
    return component;
  });
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    component.inputEl.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createTextAreaComponent(): MockTextAreaComponent {
  const component = createTextComponent() as MockTextAreaComponent;
  component.trigger = async (event: string) => {
    const handlers = (component.inputEl as ReturnType<typeof createInputEl>)._listeners.get(event) ?? [];
    for (const handler of handlers) {
      handler();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return component;
}

function createDropdownComponent(): MockDropdownComponent {
  const component = {} as MockDropdownComponent;
  component.value = '';
  component.options = [];
  component.onChangeCallback = null;
  component.addOption = jest.fn((value: string, label: string) => {
    component.options.push({ value, label });
    return component;
  });
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createToggleComponent(): MockToggleComponent {
  const component = {} as MockToggleComponent;
  component.value = false;
  component.onChangeCallback = null;
  component.setValue = jest.fn((value: boolean) => {
    component.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: boolean) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createButtonComponent(): MockButtonComponent {
  const component = {} as MockButtonComponent;
  component.buttonText = '';
  component.cta = false;
  component.onClickCallback = null;
  component.setButtonText = jest.fn((text: string) => {
    component.buttonText = text;
    return component;
  });
  component.setCta = jest.fn(() => {
    component.cta = true;
    return component;
  });
  component.onClick = jest.fn((callback: () => void) => {
    component.onClickCallback = callback;
    return component;
  });

  return component;
}

function createElement(): any {
  const listeners: Record<string, Array<() => void>> = {};
  const element: any = {
    value: '',
    style: {},
    dataset: {},
    appendText: jest.fn(),
    createEl: jest.fn(() => createElement()),
    createDiv: jest.fn(() => createElement()),
    createSpan: jest.fn(() => createElement()),
    setText: jest.fn(),
    empty: jest.fn(),
    addEventListener: jest.fn((event: string, handler: () => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    }),
  };

  return element;
}

/** Minimal infoEl for the preset editor: counts created rows/inputs. */
function createInfoElement(): any {
  const element = createElement();
  element.children = [];
  element.appendChild = jest.fn((child: any) => {
    element.children.push(child);
    return element;
  });
  return element;
}

function createContainer(): any {
  return {
    createDiv: jest.fn(() => createElement()),
    createEl: jest.fn(() => createElement()),
  };
}

function createPlugin(overrides: Record<string, unknown> = {}): any {
  return {
    settings: {
      settingsProvider: 'claude',
      model: 'claude-opus-4-6',
      titleGenerationModel: '',
      providerConfigs: {
        claude: {
          ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
          customModels: 'claude-opus-4-6',
          lastModel: 'sonnet',
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
    normalizeModelVariantSettings: jest.fn(() => false),
    getView: jest.fn(() => ({
      getTabManager: jest.fn(() => ({
        broadcastToAllTabs: jest.fn().mockResolvedValue(undefined),
      })),
    })),
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault',
        },
      },
    },
    // Cutover notice resolution surface (vault + CLI + legacy metadata).
    getResolvedProviderCliPath: jest.fn().mockReturnValue(null),
    hasLoadedLegacyMcpMetadata: jest.fn().mockReturnValue(false),
    conversations: [],
  };
}

function createContext(plugin: any) {
  return {
    plugin,
    refreshModelSelectors: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
    renderCustomContextLimits: jest.fn(),
  };
}

function findSetting(name: string) {
  const setting = createdSettings.find(candidate => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

describe('ClaudeSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    jest.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
  });

  it('uses the current npm package wrapper path as the CLI placeholder', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const cliPathSetting = findSetting('settings.cliPath.name (host-a)');
    const cliPathInput = cliPathSetting.textComponents[0];

    expect(cliPathInput.placeholder).toContain('cli-wrapper.cjs');
    expect(cliPathInput.placeholder).not.toContain('cli.js');
  });

  it('renders the model preset editor in place of the retired toggles and textarea', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const presetsSetting = createdSettings.find(
      candidate => candidate.name === 'settings.modelPresets.name',
    );
    expect(presetsSetting).toBeDefined();
    // The legacy controls are gone.
    expect(createdSettings.find(candidate => candidate.name === 'settings.enableOpus1M.name')).toBeUndefined();
    expect(createdSettings.find(candidate => candidate.name === 'settings.enableSonnet1M.name')).toBeUndefined();
    expect(createdSettings.find(candidate => candidate.name === 'settings.customModels.name')).toBeUndefined();
  });

  it('renders the Configuration heading without a safe-mode dropdown', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    claudeSettingsTabRenderer.render(createContainer(), context);

    const headings = createdSettings.filter(setting => setting.heading).map(setting => setting.name);
    expect(headings).toContain('settings.claude.configuration');
    expect(createdSettings.map(setting => setting.name)).not.toContain('settings.claudeSafeMode.name');
    const allDropdowns = createdSettings.flatMap(setting => setting.dropdownComponents);
    expect(allDropdowns.length).toBe(0);
  });

  describe('native MCP cutover notice', () => {
    it('renders no management CRUD anywhere (only native pointer/cutover notice)', () => {
      const plugin = createPlugin();
      const context = createContext(plugin);

      claudeSettingsTabRenderer.render(createContainer(), context);

      const names = createdSettings.map(setting => setting.name);
      expect(names).not.toContain('settings.mcpServers.name');
    });

    /**
     * Real fs for fixtures (the module-level fs mock never touches disk):
     * the cutover admission probe stats the legacy file with real I/O, so
     * the async notice only settles after a real event-loop round.
     */
    function makeTrackedContainer(): { container: any; created: any[] } {
      const created: any[] = [];
      const createTrackedDiv = (opts: { cls?: string } | undefined): any => {
        const element = createElement();
        if (opts?.cls) element._cls = opts.cls;
        created.push(element);
        // Nested divs keep cls tracking so the notice subtree is observable.
        element.createDiv = jest.fn((nestedOpts: { cls?: string } | undefined) =>
          createTrackedDiv(nestedOpts));
        return element;
      };
      const container = createContainer();
      container.createDiv = jest.fn((opts: { cls?: string } | undefined) => createTrackedDiv(opts));
      return { container, created };
    }

    async function settleAsyncRender(): Promise<void> {
      for (let i = 0; i < 50; i++) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }

    it('shows the review-required notice with the confirm entry for a legacy workspace', async () => {
      const realFs = jest.requireActual('fs') as typeof fs;
      const realOs = jest.requireActual('os') as typeof os;
      const realPath = jest.requireActual('path') as typeof path;
      const vaultRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudian-tab-cutover-'));
      try {
        realFs.mkdirSync(realPath.join(vaultRoot, '.claude'), { recursive: true });
        realFs.writeFileSync(realPath.join(vaultRoot, '.claude', 'mcp.json'), '{}', 'utf8');

        const plugin = createPlugin();
        plugin.app.vault.adapter.basePath = vaultRoot;
        plugin.getResolvedProviderCliPath = jest.fn().mockReturnValue('/mock/claude');

        const { container, created } = makeTrackedContainer();

        claudeSettingsTabRenderer.render(container, createContext(plugin));
        await settleAsyncRender();

        const clsList = created.map(el => el._cls).filter(Boolean);
        expect(clsList).toContain('claudian-mcp-cutover-container');
        expect(clsList).toContain('claudian-mcp-cutover-notice');

        // Exactly one action entry: the explicit confirm button. No CRUD,
        // no import/test/manage controls anywhere in the tab.
        const buttons = createdSettings.flatMap(setting => setting.buttonComponents);
        expect(buttons.length).toBe(1);
        expect(buttons[0].buttonText).toBe('Review native MCP configuration');
        expect(buttons[0].cta).toBe(true);
        expect(buttons[0].onClickCallback).toBeInstanceOf(Function);
      } finally {
        realFs.rmSync(vaultRoot, { recursive: true, force: true });
      }
    });

    it('renders the neutral native-management pointer without any action entry for a clean workspace', async () => {
      const realFs = jest.requireActual('fs') as typeof fs;
      const realOs = jest.requireActual('os') as typeof os;
      const realPath = jest.requireActual('path') as typeof path;
      const vaultRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudian-tab-cutover-'));
      try {
        const plugin = createPlugin();
        plugin.app.vault.adapter.basePath = vaultRoot;
        plugin.getResolvedProviderCliPath = jest.fn().mockReturnValue('/mock/claude');

        const { container, created } = makeTrackedContainer();

        claudeSettingsTabRenderer.render(container, createContext(plugin));
        await settleAsyncRender();

        const clsList = created.map(el => el._cls).filter(Boolean);
        expect(clsList).toContain('claudian-mcp-cutover-container');
        expect(clsList).toContain('claudian-mcp-settings-desc');
        expect(clsList).not.toContain('claudian-mcp-cutover-notice');
        // Fresh install: no confirmation entry is offered anywhere.
        expect(createdSettings.flatMap(setting => setting.buttonComponents).length).toBe(0);
      } finally {
        realFs.rmSync(vaultRoot, { recursive: true, force: true });
      }
    });
  });
});
