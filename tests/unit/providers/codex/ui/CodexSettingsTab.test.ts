import * as fs from 'fs';

import { DEFAULT_CODEX_PROVIDER_SETTINGS } from '@/providers/codex/settings';
import { codexSettingsTabRenderer } from '@/providers/codex/ui/CodexSettingsTab';

const mockGetHostnameKey = jest.fn(() => 'host-a');
const mockRenderEnvironmentSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);
const mockBroadcastToAllTabs = jest.fn().mockResolvedValue(undefined);

jest.mock('fs');
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    reconcileTitleGenerationModelSelection: jest.fn((settings: Record<string, unknown>) => {
      const titleGenerationModel = settings.titleGenerationModel;
      const codexPresets = (
        settings.providerConfigs as { codex?: { modelPresets?: Array<{ model: string }> } } | undefined
      )?.codex?.modelPresets ?? [];
      if (
        titleGenerationModel === 'my-custom-model'
        && !codexPresets.some(preset => preset.model === 'my-custom-model')
      ) {
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
    public infoEl = createMockElement();
    public settingEl = { style: {} };

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
  }

  return {
    Setting: MockSetting,
  };
});

jest.mock('@/features/settings/ui/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));

jest.mock('@/providers/codex/app/CodexWorkspaceServices', () => ({
  getCodexWorkspaceServices: jest.fn(() => ({
    commandCatalog: null,
    subagentStorage: {},
    refreshAgentMentions: jest.fn(),
  })),
}));

jest.mock('@/providers/codex/ui/CodexSkillSettings', () => ({
  CodexSkillSettings: jest.fn(),
}));

jest.mock('@/providers/codex/ui/CodexSubagentSettings', () => ({
  CodexSubagentSettings: jest.fn(),
}));

jest.mock('@/i18n/i18n', () => ({
  t: (key: string) => key,
}));

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
}));

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

const createdSettings: Array<{
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  textAreaComponents: MockTextAreaComponent[];
  dropdownComponents: MockDropdownComponent[];
  toggleComponents: MockToggleComponent[];
  infoEl: PresetMockElement;
}> = [];

interface MockInputEl {
  rows: number;
  cols: number;
  value: string;
  style: Record<string, string>;
  addClass: jest.Mock;
  addEventListener: jest.Mock;
}

function createInputEl(): MockInputEl & { _listeners: Map<string, Array<() => void>> } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    rows: 0,
    cols: 0,
    value: '',
    style: {},
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

function createElement(): any {
  const element: any = {
    value: '',
    style: {},
    appendText: jest.fn(),
    createEl: jest.fn(() => createElement()),
    createDiv: jest.fn(() => createElement()),
    createSpan: jest.fn(() => createElement()),
    setText: jest.fn(),
    empty: jest.fn(),
  };

  return element;
}

function createContainer(): any {
  return {
    createDiv: jest.fn(() => createElement()),
    createEl: jest.fn(() => createElement()),
  };
}

interface PresetListenerMap {
  [event: string]: Array<(event?: unknown) => void>;
}

interface PresetMockElement {
  cls: string;
  value: string;
  text: string;
  style: Record<string, string>;
  children: PresetMockElement[];
  parent: PresetMockElement | null;
  _listeners: PresetListenerMap;
  appendChild: (child: PresetMockElement) => PresetMockElement;
  removeChild: (child: PresetMockElement) => PresetMockElement;
  addEventListener: (event: string, handler: (event?: unknown) => void) => void;
  createDiv: (options: { cls: string }) => PresetMockElement;
  createEl: (tag: string, options: Record<string, unknown>) => PresetMockElement;
  setText: (text: string) => void;
  trigger: (event: string, payload?: unknown) => void;
}

/** DOM-shaped mock for the preset editor rendered into Setting.infoEl. */
function createMockElement(cls = ''): PresetMockElement {
  const element: PresetMockElement = {
    cls,
    value: '',
    text: '',
    style: {},
    children: [],
    parent: null,
    _listeners: {},
    appendChild(child: PresetMockElement) {
      if (child.parent && child.parent !== element) {
        const index = child.parent.children.indexOf(child);
        if (index >= 0) child.parent.children.splice(index, 1);
      }
      child.parent = element;
      const existing = element.children.indexOf(child);
      if (existing >= 0) element.children.splice(existing, 1);
      element.children.push(child);
      return element;
    },
    removeChild(child: PresetMockElement) {
      const index = element.children.indexOf(child);
      if (index >= 0) element.children.splice(index, 1);
      child.parent = null;
      return element;
    },
    addEventListener(event: string, handler: (event?: unknown) => void) {
      element._listeners[event] = element._listeners[event] ?? [];
      element._listeners[event].push(handler);
    },
    createDiv(options: { cls: string }) {
      const child = createMockElement(options.cls);
      element.appendChild(child);
      return child;
    },
    createEl(tag: string, options: Record<string, unknown>) {
      const child = createMockElement(String(options.cls ?? ''));
      child.value = typeof options.value === 'string' ? options.value : '';
      child.text = typeof options.text === 'string' ? options.text : '';
      element.appendChild(child);
      return child;
    },
    setText(text: string) {
      element.text = text;
    },
    trigger(event: string, payload?: unknown) {
      for (const handler of element._listeners[event] ?? []) {
        handler(payload);
      }
    },
  };
  return element;
}

function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function presetEditorInfo(_plugin: any): PresetMockElement {
  const setting = createdSettings.find(candidate => candidate.name === 'settings.codex.modelPresets.name');
  if (!setting) {
    throw new Error('preset editor setting not found');
  }
  return setting.infoEl;
}

function presetRows(infoEl: PresetMockElement): PresetMockElement[] {
  const list = infoEl.children.find(child => child.cls === 'claudian-model-preset-list');
  return (list?.children ?? []).filter(child => child.cls === 'claudian-model-preset-row');
}

function rowInput(row: PresetMockElement, cls: string): PresetMockElement {
  const input = row.children.find(child => child.cls === cls);
  if (!input) {
    throw new Error(`preset row input not found: ${cls}`);
  }
  return input;
}

function rowButton(row: PresetMockElement, cls: string): PresetMockElement {
  const button = row.children.find(child => child.cls === cls);
  if (!button) {
    throw new Error(`preset row button not found: ${cls}`);
  }
  return button;
}

function createPlugin(overrides: Record<string, unknown> = {}): any {
  return {
    settings: {
      settingsProvider: 'codex',
      model: 'my-custom-model',
      titleGenerationModel: '',
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled: true,
          modelPresets: [
            { label: 'GPT-5.4 Mini', model: 'gpt-5.4-mini' },
            { label: 'GPT-5.5', model: 'gpt-5.5' },
            { label: 'My Custom', model: 'my-custom-model' },
          ],
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
    getView: jest.fn(() => ({
      getTabManager: jest.fn(() => ({
        broadcastToAllTabs: mockBroadcastToAllTabs,
      })),
    })),
    app: {
      vault: {
        adapter: {
          basePath: 'C:\\vault',
        },
      },
    },
  };
}

function createContext(plugin: any) {
  return {
    plugin,
    renderHiddenProviderCommandSetting: jest.fn(),
    refreshModelSelectors: jest.fn(),
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

function findOptionalSetting(name: string) {
  return createdSettings.find(candidate => candidate.name === name);
}

describe('CodexSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
  const originalPlatform = process.platform;

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  beforeEach(() => {
    createdSettings.length = 0;
    jest.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
  });

  it('renders installation method and WSL distro override controls on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const plugin = createPlugin();

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(findSetting('settings.codex.installation.name').dropdownComponents).toHaveLength(1);
    expect(findSetting('settings.codex.wslDistro.name').textComponents).toHaveLength(1);
  });

  it('hides Windows-only installation controls on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(findOptionalSetting('settings.codex.installation.name')).toBeUndefined();
    expect(findOptionalSetting('settings.codex.wslDistro.name')).toBeUndefined();
  });

  it('uses host-native CLI path behavior on non-Windows even when WSL is saved', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin({
      providerConfigs: {
        codex: {
          enabled: true,
          safeMode: 'workspace-write',
          cliPath: '',
          cliPathsByHost: {},
          reasoningSummary: 'detailed',
          environmentVariables: '',
          environmentHash: '',
          installationMethod: 'wsl',
          installationMethodsByHost: {
            'host-a': 'wsl',
          },
          wslDistroOverride: 'Ubuntu',
          wslDistroOverridesByHost: {
            'host-a': 'Ubuntu',
          },
        },
      },
    });

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const cliPathSetting = findSetting('settings.codex.cliPath.name');
    expect(cliPathSetting.desc).toBe('settings.codex.cliPath.descUnix');
    expect(cliPathSetting.textComponents[0].placeholder).toBe('/usr/local/bin/codex');

    await cliPathSetting.textComponents[0].onChangeCallback?.('codex');

    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBeUndefined();
    expect(mockSaveSettings).toHaveBeenCalledTimes(0);
    expect(mockBroadcastToAllTabs).toHaveBeenCalledTimes(0);
  });

  it('accepts a Linux-side CLI command when installation method is WSL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const plugin = createPlugin();

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const installationMethodSetting = findSetting('settings.codex.installation.name');
    await installationMethodSetting.dropdownComponents[0].onChangeCallback?.('wsl');

    const cliPathSetting = findSetting('settings.codex.cliPath.name');
    await cliPathSetting.textComponents[0].onChangeCallback?.('codex');

    expect(plugin.settings.providerConfigs.codex.installationMethodsByHost).toEqual({
      'host-a': 'wsl',
    });
    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBe('codex');
    expect(mockSaveSettings).toHaveBeenCalled();
    expect(mockBroadcastToAllTabs).toHaveBeenCalled();
  });

  it('rejects a Windows-native CLI path when installation method is WSL', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const plugin = createPlugin({
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled: true,
          cliPathsByHost: {
            'host-a': 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe',
          },
        },
      },
    });

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    const installationMethodSetting = findSetting('settings.codex.installation.name');
    await installationMethodSetting.dropdownComponents[0].onChangeCallback?.('wsl');

    const cliPathSetting = findSetting('settings.codex.cliPath.name');
    await cliPathSetting.textComponents[0].onChangeCallback?.('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe');

    expect(plugin.settings.providerConfigs.codex.installationMethodsByHost).toEqual({
      'host-a': 'wsl',
    });
    expect(plugin.settings.providerConfigs.codex.cliPathsByHost['host-a']).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.exe',
    );
    expect(mockBroadcastToAllTabs).toHaveBeenCalledTimes(0);
  });

  it('renders the preset editor in place of the retired custom models textarea', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();

    codexSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(findSetting('settings.codex.modelPresets.name')).toBeDefined();
    expect(findOptionalSetting('settings.codex.customModels.name')).toBeUndefined();
    expect(presetRows(presetEditorInfo(plugin))).toHaveLength(3);
  });

  it('does not commit the preset list while a row is mid-edit', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();
    const context = createContext(plugin);

    codexSettingsTabRenderer.render(createContainer(), context);

    const customRow = presetRows(presetEditorInfo(plugin))[2];
    rowInput(customRow, 'claudian-model-preset-model').value = 'different-custom-model';

    expect(plugin.settings.providerConfigs.codex.modelPresets.map((p: { model: string }) => p.model))
      .toEqual(['gpt-5.4-mini', 'gpt-5.5', 'my-custom-model']);
    expect(plugin.settings.model).toBe('my-custom-model');
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(context.refreshModelSelectors).not.toHaveBeenCalled();
  });

  it('renames the active, title, and saved codex models along with the preset', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin({
      titleGenerationModel: 'my-custom-model',
      savedProviderModel: { claude: 'haiku', codex: 'my-custom-model' },
    });
    const context = createContext(plugin);

    codexSettingsTabRenderer.render(createContainer(), context);

    const customRow = presetRows(presetEditorInfo(plugin))[2];
    const modelInput = rowInput(customRow, 'claudian-model-preset-model');
    modelInput.value = 'renamed-model';
    modelInput.trigger('blur');
    await flushAsync();

    expect(plugin.settings.providerConfigs.codex.modelPresets.map((p: { model: string }) => p.model))
      .toEqual(['gpt-5.4-mini', 'gpt-5.5', 'renamed-model']);
    expect(plugin.settings.model).toBe('renamed-model');
    expect(plugin.settings.titleGenerationModel).toBe('renamed-model');
    expect(plugin.settings.savedProviderModel).toEqual({ claude: 'haiku', codex: 'renamed-model' });
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it('falls the removed active model back to the first preset and clears stale title models', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin({
      titleGenerationModel: 'my-custom-model',
    });
    const context = createContext(plugin);

    codexSettingsTabRenderer.render(createContainer(), context);

    const customRow = presetRows(presetEditorInfo(plugin))[2];
    rowButton(customRow, 'claudian-model-preset-remove').trigger('click');
    await flushAsync();

    expect(plugin.settings.providerConfigs.codex.modelPresets.map((p: { model: string }) => p.model))
      .toEqual(['gpt-5.4-mini', 'gpt-5.5']);
    expect(plugin.settings.model).toBe('gpt-5.4-mini');
    expect(plugin.settings.titleGenerationModel).toBe('');
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(1);
  });

  it('reconciles an inactive Codex saved model when its preset row is removed', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin({
      settingsProvider: 'claude',
      model: 'haiku',
      savedProviderModel: {
        claude: 'haiku',
        codex: 'my-custom-model',
      },
    });
    const context = createContext(plugin);

    codexSettingsTabRenderer.render(createContainer(), context);

    const customRow = presetRows(presetEditorInfo(plugin))[2];
    rowButton(customRow, 'claudian-model-preset-remove').trigger('click');
    await flushAsync();

    expect(plugin.settings.model).toBe('haiku');
    expect(plugin.settings.savedProviderModel).toEqual({
      claude: 'haiku',
      codex: 'gpt-5.4-mini',
    });
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps at least one preset row', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin({
      providerConfigs: {
        codex: {
          ...DEFAULT_CODEX_PROVIDER_SETTINGS,
          enabled: true,
          modelPresets: [{ label: 'Only', model: 'only-model' }],
        },
      },
    });
    const context = createContext(plugin);

    codexSettingsTabRenderer.render(createContainer(), context);

    const infoEl = presetEditorInfo(plugin);
    expect(presetRows(infoEl)).toHaveLength(1);
    rowButton(presetRows(infoEl)[0], 'claudian-model-preset-remove').trigger('click');
    await flushAsync();

    expect(presetRows(presetEditorInfo(plugin))).toHaveLength(1);
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });

  it('saves arrow-only ordering through the Codex binding and restores it on reopen', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const original = plugin.settings.providerConfigs.codex.modelPresets.map((p: object) => ({ ...p }));
    codexSettingsTabRenderer.render(createContainer(), context);

    rowButton(presetRows(presetEditorInfo(plugin))[2], 'claudian-model-preset-move-up').trigger('click');
    await flushAsync();

    expect(plugin.settings.providerConfigs.codex.modelPresets)
      .toEqual([original[0], original[2], original[1]]);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(1);
    expect(plugin.settings.model).toBe('my-custom-model');

    createdSettings.length = 0;
    codexSettingsTabRenderer.render(createContainer(), context);
    expect(presetRows(presetEditorInfo(plugin)).map(row => rowInput(row, 'claudian-model-preset-model').value))
      .toEqual(['gpt-5.4-mini', 'my-custom-model', 'gpt-5.5']);

    rowButton(presetRows(presetEditorInfo(plugin))[1], 'claudian-model-preset-move-down').trigger('click');
    await flushAsync();
    expect(plugin.settings.providerConfigs.codex.modelPresets).toEqual(original);
    expect(mockSaveSettings).toHaveBeenCalledTimes(2);
  });

  it('saves the final moved order after a preceding input blur with an in-flight save', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const saves: Array<Array<{ model: string }>> = [];
    let finishFirst!: () => void;
    mockSaveSettings
      .mockImplementationOnce(() => {
        saves.push(plugin.settings.providerConfigs.codex.modelPresets.map((p: object) => ({ ...p })));
        return new Promise<void>(resolve => { finishFirst = resolve; });
      })
      .mockImplementationOnce(async () => {
        saves.push(plugin.settings.providerConfigs.codex.modelPresets.map((p: object) => ({ ...p })));
      });
    codexSettingsTabRenderer.render(createContainer(), context);
    const row = presetRows(presetEditorInfo(plugin))[2];
    const input = rowInput(row, 'claudian-model-preset-label');
    input.value = 'Edited Custom';
    input.trigger('blur');
    rowButton(row, 'claudian-model-preset-move-up').trigger('click');
    await flushAsync();
    finishFirst();
    await flushAsync();

    expect(saves.map(presets => presets.map(p => p.model)))
      .toEqual([
        ['gpt-5.4-mini', 'gpt-5.5', 'my-custom-model'],
        ['gpt-5.4-mini', 'my-custom-model', 'gpt-5.5'],
      ]);
    expect(plugin.settings.providerConfigs.codex.modelPresets[1].label).toBe('Edited Custom');
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(2);
  });

  it('does not save boundary arrow clicks', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    codexSettingsTabRenderer.render(createContainer(), context);
    const rows = presetRows(presetEditorInfo(plugin));
    rowButton(rows[0], 'claudian-model-preset-move-up').trigger('click');
    rowButton(rows[2], 'claudian-model-preset-move-down').trigger('click');
    await flushAsync();
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(context.refreshModelSelectors).not.toHaveBeenCalled();
  });

  it('restores the two factory presets from the reset button', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const plugin = createPlugin();
    const context = createContext(plugin);

    codexSettingsTabRenderer.render(createContainer(), context);

    const reset = presetEditorInfo(plugin).children
      .flatMap(child => child.children)
      .find(child => child.cls === 'claudian-model-preset-reset');
    reset?.trigger('click');
    await flushAsync();

    expect(plugin.settings.providerConfigs.codex.modelPresets).toEqual([
      { label: 'GPT-5.4 Mini', model: 'gpt-5.4-mini' },
      { label: 'GPT-5.5', model: 'gpt-5.5' },
    ]);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });
});
