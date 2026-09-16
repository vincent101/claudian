import {
  DEFAULT_CLAUDE_MODEL_PRESETS,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
  validateClaudeModelPresetDrafts,
} from '@/providers/claude/settings';
import { getContextWindowSize } from '@/providers/claude/types/models';

describe('Claude model presets', () => {
  describe('DEFAULT_CLAUDE_MODEL_PRESETS', () => {
    it('ships Haiku/Sonnet/Opus/Fable with fable defaulting to a 1M window', () => {
      expect(DEFAULT_CLAUDE_MODEL_PRESETS).toEqual([
        { label: 'Haiku', model: 'haiku' },
        { label: 'Sonnet', model: 'sonnet' },
        { label: 'Opus', model: 'opus' },
        { label: 'Fable', model: 'fable', contextWindow: 1_000_000 },
      ]);
    });
  });

  describe('getClaudeProviderSettings', () => {
    it('defaults to the built-in four presets on a fresh install', () => {
      const settings = getClaudeProviderSettings({});
      expect(settings.modelPresets).toEqual([...DEFAULT_CLAUDE_MODEL_PRESETS]);
    });

    it('returns stored presets unchanged when already migrated', () => {
      const presets = [
        { label: 'Fast', model: 'haiku' },
        { label: 'Deep', model: 'fable', contextWindow: 2_000_000 },
      ];
      const settings = getClaudeProviderSettings({
        providerConfigs: { claude: { modelPresets: presets } },
      });
      expect(settings.modelPresets).toEqual(presets);
    });

    it('normalizes stored presets: trims fields and drops invalid rows', () => {
      const settings = getClaudeProviderSettings({
        providerConfigs: {
          claude: {
            modelPresets: [
              { label: '  Haiku  ', model: ' haiku ' },
              { label: '', model: '' },
              { label: 'No window', model: 'custom', contextWindow: 'huge' },
              'not-an-object',
            ],
          },
        },
      });
      expect(settings.modelPresets).toEqual([
        { label: 'Haiku', model: 'haiku' },
        { label: 'No window', model: 'custom' },
      ]);
    });

    it('keeps the first row when stored presets repeat a model id', () => {
      const settings = getClaudeProviderSettings({
        providerConfigs: {
          claude: {
            modelPresets: [
              { label: 'First', model: 'custom-x' },
              { label: 'Second', model: 'custom-x' },
            ],
          },
        },
      });
      expect(settings.modelPresets).toEqual([{ label: 'First', model: 'custom-x' }]);
    });

    it('falls back to defaults when every stored preset row is invalid', () => {
      const settings = getClaudeProviderSettings({
        providerConfigs: { claude: { modelPresets: [{ label: '', model: '' }] } },
      });
      expect(settings.modelPresets).toEqual([...DEFAULT_CLAUDE_MODEL_PRESETS]);
    });
  });

  describe('legacy migration', () => {
    it('migrates plain sonnet/opus toggles into the four default presets', () => {
      const settings = getClaudeProviderSettings({
        providerConfigs: {
          claude: { enableSonnet1M: false, enableOpus1M: false, customModels: '' },
        },
      });
      expect(settings.modelPresets.map(p => p.model)).toEqual([
        'haiku', 'sonnet', 'opus', 'fable',
      ]);
    });

    it('swaps in the 1M variants selected by the legacy toggles', () => {
      const settings = getClaudeProviderSettings({
        providerConfigs: {
          claude: { enableSonnet1M: true, enableOpus1M: true, customModels: '' },
        },
      });
      expect(settings.modelPresets.map(p => p.model)).toEqual([
        'haiku', 'sonnet[1m]', 'opus[1m]', 'fable',
      ]);
      expect(settings.modelPresets.map(p => p.label)).toEqual([
        'Haiku', 'Sonnet 1M', 'Opus 1M', 'Fable',
      ]);
    });

    it('supports mixed toggles and reads top-level legacy fields', () => {
      const settings = getClaudeProviderSettings({
        enableOpus1M: true,
        providerConfigs: { claude: { enableSonnet1M: false } },
      });
      expect(settings.modelPresets.map(p => p.model)).toEqual([
        'haiku', 'sonnet', 'opus[1m]', 'fable',
      ]);
    });

    it('appends custom model lines as presets with formatted labels, deduplicated and order-preserving', () => {
      const settings = getClaudeProviderSettings({
        providerConfigs: {
          claude: {
            customModels: 'claude-opus-4-6\n  \nclaude-opus-4-6\nvendor/my-model\nsonnet',
          },
        },
      });
      expect(settings.modelPresets.map(p => p.model)).toEqual([
        'haiku', 'sonnet', 'opus', 'fable', 'claude-opus-4-6', 'vendor/my-model',
      ]);
      expect(settings.modelPresets[4]).toEqual({ label: 'Opus 4.6', model: 'claude-opus-4-6' });
    });

    it('imports legacy customContextLimits into matching preset windows', () => {
      const settings = getClaudeProviderSettings({
        providerConfigs: {
          claude: { customModels: 'claude-opus-4-6\nvendor/my-model' },
        },
        customContextLimits: {
          'claude-opus-4-6': 500_000,
          'fable': 800_000,
          'unrelated-model': 300_000,
        },
      });
      const byModel = new Map(settings.modelPresets.map(p => [p.model, p]));
      expect(byModel.get('claude-opus-4-6')?.contextWindow).toBe(500_000);
      expect(byModel.get('fable')?.contextWindow).toBe(800_000);
      expect(byModel.get('vendor/my-model')?.contextWindow).toBeUndefined();
    });

    it('ignores invalid legacy context limit values', () => {
      const settings = getClaudeProviderSettings({
        customContextLimits: { 'fable': -5, 'sonnet': Number.NaN },
      });
      const byModel = new Map(settings.modelPresets.map(p => [p.model, p]));
      expect(byModel.get('fable')?.contextWindow).toBe(1_000_000);
      expect(byModel.get('sonnet')?.contextWindow).toBeUndefined();
    });

    it('is idempotent: preset output survives a second read', () => {
      const bag: Record<string, unknown> = {
        providerConfigs: {
          claude: { enableSonnet1M: true, customModels: 'claude-opus-4-6' },
        },
        customContextLimits: { 'claude-opus-4-6': 500_000 },
      };
      const first = getClaudeProviderSettings(bag);
      updateClaudeProviderSettings(bag, first);
      const second = getClaudeProviderSettings(bag);
      expect(second.modelPresets).toEqual(first.modelPresets);
      const claudeConfig = (bag.providerConfigs as Record<string, unknown>).claude as Record<string, unknown>;
      expect(claudeConfig).not.toHaveProperty('customModels');
      expect(claudeConfig).not.toHaveProperty('enableSonnet1M');
      expect(claudeConfig).not.toHaveProperty('enableOpus1M');
    });
  });

  describe('updateClaudeProviderSettings preset projection', () => {
    it('keeps factory out-of-box windows non-regressed after rule removal (storage.load chain)', () => {
      // storage.load() merges defaults then runs updateClaudeProviderSettings
      // with the resolved presets, so the factory fable 1M window reaches
      // customContextLimits before any user interaction. With the [1m]/fable
      // hard-coded rules gone, that projection is what keeps fable at 1M.
      const bag: Record<string, unknown> = {};
      updateClaudeProviderSettings(bag, getClaudeProviderSettings(bag));
      const limits = bag.customContextLimits as Record<string, number>;
      expect(getContextWindowSize('haiku', limits)).toBe(200_000);
      expect(getContextWindowSize('sonnet', limits)).toBe(200_000);
      expect(getContextWindowSize('opus', limits)).toBe(200_000);
      expect(getContextWindowSize('fable', limits)).toBe(1_000_000);
    });

    it('projects preset windows into customContextLimits for existing readers', () => {
      const bag: Record<string, unknown> = {
        providerConfigs: { claude: {} },
        customContextLimits: { 'env-model': 300_000 },
      };
      updateClaudeProviderSettings(bag, {
        modelPresets: [
          { label: 'Sonnet', model: 'sonnet', contextWindow: 500_000 },
          { label: 'Opus', model: 'opus' },
        ],
      });
      expect(bag.customContextLimits).toEqual({
        'env-model': 300_000,
        'sonnet': 500_000,
      });
    });

    it('removes the projection entry when a preset window is cleared', () => {
      const bag: Record<string, unknown> = {
        providerConfigs: { claude: {} },
        customContextLimits: { 'sonnet': 500_000, 'env-model': 300_000 },
      };
      updateClaudeProviderSettings(bag, {
        modelPresets: [{ label: 'Sonnet', model: 'sonnet' }],
      });
      expect(bag.customContextLimits).toEqual({ 'env-model': 300_000 });
    });

    it('does not touch customContextLimits when presets are not part of the update', () => {
      const bag: Record<string, unknown> = {
        providerConfigs: { claude: {} },
        customContextLimits: { 'sonnet': 500_000 },
      };
      updateClaudeProviderSettings(bag, { loadUserSettings: false });
      expect(bag.customContextLimits).toEqual({ 'sonnet': 500_000 });
    });
  });

  describe('validateClaudeModelPresetDrafts', () => {
    it('accepts valid drafts', () => {
      const errors = validateClaudeModelPresetDrafts([
        { label: 'Haiku', model: 'haiku', contextWindow: '' },
        { label: 'Fable', model: 'fable', contextWindow: '1m' },
      ]);
      expect(errors).toEqual([null, null]);
    });

    it('flags empty labels and models', () => {
      const errors = validateClaudeModelPresetDrafts([
        { label: '', model: 'haiku', contextWindow: '' },
        { label: 'Opus', model: '  ', contextWindow: '' },
      ]);
      expect(errors[0]).toBe('settings.modelPresets.validation.emptyLabel');
      expect(errors[1]).toBe('settings.modelPresets.validation.emptyModel');
    });

    it('flags duplicate model ids case-sensitively on the later row', () => {
      const errors = validateClaudeModelPresetDrafts([
        { label: 'A', model: 'custom', contextWindow: '' },
        { label: 'B', model: 'custom', contextWindow: '' },
        { label: 'C', model: 'CUSTOM', contextWindow: '' },
      ]);
      expect(errors).toEqual([null, 'settings.modelPresets.validation.duplicateModel', null]);
    });

    it('flags malformed context windows', () => {
      const errors = validateClaudeModelPresetDrafts([
        { label: 'A', model: 'a', contextWindow: 'huge' },
        { label: 'B', model: 'b', contextWindow: '0' },
      ]);
      expect(errors[0]).toBe('settings.modelPresets.validation.invalidWindow');
      expect(errors[1]).toBe('settings.modelPresets.validation.invalidWindow');
    });
  });
});
