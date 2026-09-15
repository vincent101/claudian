import { resolveClaudeModelSelection } from '@/providers/claude/modelOptions';
import {
  DEFAULT_CLAUDE_MODEL_PRESETS,
  getClaudeProviderSettings,
} from '@/providers/claude/settings';
import { ModelPresetSettings } from '@/providers/claude/ui/ModelPresetSettings';

jest.mock('@/i18n/i18n', () => ({
  t: (key: string) => key,
}));

interface ListenerMap {
  [event: string]: Array<(event?: unknown) => void>;
}

interface MockElement {
  cls: string;
  value: string;
  text: string;
  style: Record<string, string>;
  children: MockElement[];
  parent: MockElement | null;
  _listeners: ListenerMap;
  appendChild: (child: MockElement) => MockElement;
  removeChild: (child: MockElement) => MockElement;
  addEventListener: (event: string, handler: (event?: unknown) => void) => void;
  createDiv: (options: { cls: string }) => MockElement;
  createEl: (tag: string, options: Record<string, unknown>) => MockElement;
  setText: (text: string) => void;
  trigger: (event: string, payload?: unknown) => void;
}

function createMockElement(cls = ''): MockElement {
  const element: MockElement = {
    cls,
    value: '',
    text: '',
    style: {},
    children: [],
    parent: null,
    _listeners: {},
    appendChild(child: MockElement) {
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
    removeChild(child: MockElement) {
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

interface Harness {
  container: MockElement;
  settingsBag: Record<string, unknown>;
  saveSettings: jest.Mock;
  refreshModelSelectors: jest.Mock;
  onModelOptionsChanged: jest.Mock;
  rows: () => MockElement[];
  editor: ModelPresetSettings;
}

function createHarness(initialSettings: Record<string, unknown> = {}): Harness {
  const settingsBag: Record<string, unknown> = {
    settingsProvider: 'claude',
    model: 'fable',
    titleGenerationModel: '',
    providerConfigs: {
      claude: {
        modelPresets: DEFAULT_CLAUDE_MODEL_PRESETS.map(preset => ({ ...preset })),
        lastModel: 'haiku',
      },
    },
    ...initialSettings,
  };
  const container = createMockElement('container');
  const saveSettings = jest.fn().mockResolvedValue(undefined);
  const refreshModelSelectors = jest.fn();
  // Mirrors ClaudeSettingsTab's reconcileActiveClaudeModelSelection closure.
  const onModelOptionsChanged = jest.fn(() => {
    const currentModel = typeof settingsBag.model === 'string' ? settingsBag.model : '';
    const nextModel = resolveClaudeModelSelection(settingsBag, currentModel);
    if (nextModel && nextModel !== currentModel) {
      settingsBag.model = nextModel;
    }
  });

  const editor = new ModelPresetSettings(container as unknown as HTMLElement, {
    getSettings: () => settingsBag,
    saveSettings,
    refreshModelSelectors,
    onModelOptionsChanged,
  });

  const list = container.children.find(child => child.cls === 'claudian-model-preset-list');
  return {
    container,
    settingsBag,
    saveSettings,
    refreshModelSelectors,
    onModelOptionsChanged,
    rows: () => (list?.children ?? []).filter(child => child.cls === 'claudian-model-preset-row'),
    editor,
  };
}

function rowInputs(row: MockElement): { label: MockElement; model: MockElement; window: MockElement } {
  const label = row.children.find(child => child.cls === 'claudian-model-preset-label');
  const model = row.children.find(child => child.cls === 'claudian-model-preset-model');
  const window = row.children.find(child => child.cls === 'claudian-model-preset-window');
  if (!label || !model || !window) {
    throw new Error('preset row inputs not found');
  }
  return { label, model, window };
}

function rowButton(row: MockElement, cls: string): MockElement {
  const button = row.children.find(child => child.cls === cls);
  if (!button) {
    throw new Error(`button not found: ${cls}`);
  }
  return button;
}

describe('ModelPresetSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders one row per configured preset with editable values', () => {
    const harness = createHarness();
    const rows = harness.rows();
    expect(rows).toHaveLength(4);

    const { label, model, window } = rowInputs(rows[3]);
    expect(label.value).toBe('Fable');
    expect(model.value).toBe('fable');
    expect(window.value).toBe('1m');
  });

  it('does not save when nothing changed and blur fires', async () => {
    const harness = createHarness();
    const { label } = rowInputs(harness.rows()[0]);
    label.trigger('blur');
    await flushAsync();

    expect(harness.saveSettings).not.toHaveBeenCalled();
    expect(harness.refreshModelSelectors).not.toHaveBeenCalled();
  });

  it('commits the whole array on blur, renames the active model, and refreshes selectors', async () => {
    const harness = createHarness();
    const fableRow = harness.rows()[3];
    const { model } = rowInputs(fableRow);
    model.value = 'claude-fable-5';
    model.trigger('blur');
    await flushAsync();

    const presets = getClaudeProviderSettings(harness.settingsBag).modelPresets;
    expect(presets.map(p => p.model)).toContain('claude-fable-5');
    expect(harness.settingsBag.model).toBe('claude-fable-5');
    expect(harness.saveSettings).toHaveBeenCalledTimes(1);
    expect(harness.refreshModelSelectors).toHaveBeenCalledTimes(1);
    expect(harness.onModelOptionsChanged).toHaveBeenCalledTimes(1);
    // Preset windows project into customContextLimits for existing readers.
    expect((harness.settingsBag.customContextLimits as Record<string, number>)['fable']).toBeUndefined();
  });

  it('renames the title model and last model along with the preset', async () => {
    const harness = createHarness({ titleGenerationModel: 'fable' });
    (harness.settingsBag.providerConfigs as Record<string, { lastModel: string }>).claude.lastModel = 'fable';
    const { model } = rowInputs(harness.rows()[3]);
    model.value = 'claude-fable-5';
    model.trigger('blur');
    await flushAsync();

    expect(harness.settingsBag.titleGenerationModel).toBe('claude-fable-5');
    expect(getClaudeProviderSettings(harness.settingsBag).lastModel).toBe('claude-fable-5');
  });

  it('blocks the commit on invalid rows without saving', async () => {
    const harness = createHarness();
    const { model } = rowInputs(harness.rows()[0]);
    model.value = '  ';
    model.trigger('blur');
    await flushAsync();

    expect(harness.saveSettings).not.toHaveBeenCalled();
    expect(harness.refreshModelSelectors).not.toHaveBeenCalled();
    const errorEl = harness.rows()[0].children.find(child => child.cls === 'claudian-model-preset-error');
    expect(errorEl?.style.display).toBe('block');
    expect(errorEl?.text).toBe('settings.modelPresets.validation.emptyModel');
  });

  it('blocks the commit on duplicate model ids', async () => {
    const harness = createHarness();
    const { model } = rowInputs(harness.rows()[1]);
    model.value = 'haiku';
    model.trigger('blur');
    await flushAsync();

    expect(harness.saveSettings).not.toHaveBeenCalled();
    const errorEl = harness.rows()[1].children.find(child => child.cls === 'claudian-model-preset-error');
    expect(errorEl?.text).toBe('settings.modelPresets.validation.duplicateModel');
  });

  it('falls back the active model when its preset row is removed', async () => {
    const harness = createHarness({ model: 'opus' });
    const remove = rowButton(harness.rows()[2], 'claudian-model-preset-remove');
    remove.trigger('click');
    await flushAsync();

    const presets = getClaudeProviderSettings(harness.settingsBag).modelPresets;
    expect(presets.map(p => p.model)).not.toContain('opus');
    // resolveClaudeModelSelection falls back to lastModel (haiku).
    expect(harness.settingsBag.model).toBe('haiku');
    expect(harness.saveSettings).toHaveBeenCalled();
  });

  it('keeps at least one row', async () => {
    const harness = createHarness({
      providerConfigs: {
        claude: { modelPresets: [{ label: 'Only', model: 'only-model' }] },
      },
    });
    const rows = harness.rows();
    expect(rows).toHaveLength(1);
    rowButton(rows[0], 'claudian-model-preset-remove').trigger('click');
    await flushAsync();

    expect(harness.rows()).toHaveLength(1);
    expect(harness.saveSettings).not.toHaveBeenCalled();
  });

  it('reorders rows without losing values', async () => {
    const harness = createHarness();
    const rows = harness.rows();
    rowButton(rows[3], 'claudian-model-preset-move-up').trigger('click');
    await flushAsync();

    const reordered = harness.rows();
    expect(rowInputs(reordered[2]).model.value).toBe('fable');
    expect(rowInputs(reordered[3]).model.value).toBe('opus');
    // Reorder alone does not dirty the commit state.
    expect(harness.saveSettings).not.toHaveBeenCalled();
  });

  it('restores the default four presets from the reset button', async () => {
    const harness = createHarness({
      providerConfigs: {
        claude: { modelPresets: [{ label: 'Only', model: 'only-model' }] },
      },
      model: 'only-model',
    });
    const reset = harness.container.children
      .flatMap(child => child.children)
      .find(child => child.cls === 'claudian-model-preset-reset');
    reset?.trigger('click');
    await flushAsync();

    const presets = getClaudeProviderSettings(harness.settingsBag).modelPresets;
    expect(presets).toEqual(DEFAULT_CLAUDE_MODEL_PRESETS.map(preset => ({ ...preset })));
    // Removed active model falls back through the normal selection rules.
    expect(harness.saveSettings).toHaveBeenCalled();
  });

  it('parses the context window input into preset windows', async () => {
    const harness = createHarness();
    const { window } = rowInputs(harness.rows()[1]);
    window.value = '500k';
    window.trigger('blur');
    await flushAsync();

    const presets = getClaudeProviderSettings(harness.settingsBag).modelPresets;
    expect(presets.find(p => p.model === 'sonnet')?.contextWindow).toBe(500_000);
    expect((harness.settingsBag.customContextLimits as Record<string, number>)['sonnet']).toBe(500_000);
  });
});
