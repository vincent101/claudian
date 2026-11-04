import {
  applyCodexModelDefaults,
  DEFAULT_CODEX_PROVIDER_SETTINGS,
  getCodexProviderSettings,
  getEffectiveCodexReasoningSummary,
  migrateCodexModelPresets,
  updateCodexProviderSettings,
} from '@/providers/codex/settings';
import { CODEX_SPARK_MODEL } from '@/providers/codex/types/models';

const mockGetHostnameKey = jest.fn(() => 'host-a');

jest.mock('@/utils/env', () => ({
  getHostnameKey: () => mockGetHostnameKey(),
}));

describe('codex settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults installationMethod to native-windows and leaves wslDistroOverride empty', () => {
    const settings = getCodexProviderSettings({});

    expect(settings.modelPresets).toEqual([
      { label: 'GPT-5.4 Mini', model: 'gpt-5.4-mini' },
      { label: 'GPT-5.5', model: 'gpt-5.5' },
    ]);
    expect(settings.installationMethod).toBe('native-windows');
    expect(settings.wslDistroOverride).toBe('');
    expect(settings.installationMethod).toBe(DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod);
    expect(settings.wslDistroOverride).toBe(DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride);
  });

  it('normalizes invalid installationMethod and wslDistroOverride values', () => {
    const settings = getCodexProviderSettings({
      providerConfigs: {
        codex: {
          installationMethod: 'auto',
          wslDistroOverride: 123,
        },
      },
    });

    expect(settings.installationMethod).toBe('native-windows');
    expect(settings.wslDistroOverride).toBe('');
  });

  it('does not inherit another host installation method once host-scoped values exist', () => {
    const settings = getCodexProviderSettings({
      providerConfigs: {
        codex: {
          installationMethodsByHost: {
            'host-b': 'wsl',
          },
          wslDistroOverridesByHost: {
            'host-b': 'Ubuntu',
          },
          installationMethod: 'wsl',
          wslDistroOverride: 'Ubuntu',
        },
      },
    });

    expect(settings.installationMethod).toBe('native-windows');
    expect(settings.wslDistroOverride).toBe('');
  });

  it('round-trips installationMethod and trims wslDistroOverride on update for the current host', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {},
      },
    };

    const next = updateCodexProviderSettings(settingsBag, {
      installationMethod: 'wsl',
      wslDistroOverride: '  Ubuntu-24.04  ',
    });

    expect(next.installationMethod).toBe('wsl');
    expect(next.wslDistroOverride).toBe('Ubuntu-24.04');
    expect(getCodexProviderSettings(settingsBag)).toMatchObject({
      installationMethod: 'wsl',
      wslDistroOverride: 'Ubuntu-24.04',
      installationMethodsByHost: {
        'host-a': 'wsl',
      },
      wslDistroOverridesByHost: {
        'host-a': 'Ubuntu-24.04',
      },
    });
  });

  it('preserves another host installation settings when updating the current host', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          installationMethodsByHost: {
            'host-b': 'wsl',
          },
          wslDistroOverridesByHost: {
            'host-b': 'Debian',
          },
        },
      },
    };

    const next = updateCodexProviderSettings(settingsBag, {
      installationMethod: 'native-windows',
      wslDistroOverride: '  ',
    });

    expect(next.installationMethodsByHost).toEqual({
      'host-b': 'wsl',
      'host-a': 'native-windows',
    });
    expect(next.wslDistroOverridesByHost).toEqual({
      'host-b': 'Debian',
    });
  });

  it('forces reasoning summary off for GPT-5.3 Codex Spark', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          reasoningSummary: 'detailed',
        },
      },
    };

    expect(getEffectiveCodexReasoningSummary(settingsBag, CODEX_SPARK_MODEL)).toBe('none');
    expect(getEffectiveCodexReasoningSummary(settingsBag, 'gpt-5.5')).toBe('detailed');
  });

  it('sets reasoning summary off when applying GPT-5.3 Codex Spark model defaults', () => {
    const settingsBag: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          reasoningSummary: 'detailed',
        },
      },
    };

    applyCodexModelDefaults(CODEX_SPARK_MODEL, settingsBag);

    expect(getCodexProviderSettings(settingsBag).reasoningSummary).toBe('none');
  });

  describe('codex model presets', () => {
    it('migrates the legacy customModels textarea into presets without loss', () => {
      const settings = getCodexProviderSettings({
        providerConfigs: {
          codex: {
            customModels: 'claude-opus\nclaude-sonnet\nclaude-haiku',
          },
        },
      });

      expect(settings.modelPresets).toEqual([
        { label: 'GPT-5.4 Mini', model: 'gpt-5.4-mini' },
        { label: 'GPT-5.5', model: 'gpt-5.5' },
        { label: 'claude-opus', model: 'claude-opus' },
        { label: 'claude-sonnet', model: 'claude-sonnet' },
        { label: 'claude-haiku', model: 'claude-haiku' },
      ]);
    });

    it('migrateCodexModelPresets is idempotent and dedupes legacy lines', () => {
      const config = { customModels: 'gpt-5.5\n  \nclaude-opus\nclaude-opus\n' };
      const first = migrateCodexModelPresets(config, {});
      const second = migrateCodexModelPresets(config, {});

      expect(first).toEqual([
        { label: 'GPT-5.4 Mini', model: 'gpt-5.4-mini' },
        { label: 'GPT-5.5', model: 'gpt-5.5' },
        { label: 'claude-opus', model: 'claude-opus' },
      ]);
      expect(second).toEqual(first);
    });

    it('imports legacy customContextLimits into the migrated presets', () => {
      const settings = getCodexProviderSettings({
        customContextLimits: { 'claude-opus': 1_000_000 },
        providerConfigs: {
          codex: { customModels: 'claude-opus' },
        },
      });

      expect(settings.modelPresets.find(p => p.model === 'claude-opus')?.contextWindow)
        .toBe(1_000_000);
    });

    it('normalizes stored presets: drops invalid rows, dedupes, falls back to migration', () => {
      const settings = getCodexProviderSettings({
        providerConfigs: {
          codex: {
            modelPresets: [
              { label: 'Kept', model: 'kept-model' },
              { label: '', model: 'no-label' },
              { label: 'Dup', model: 'kept-model' },
              'garbage',
            ],
          },
        },
      });

      expect(settings.modelPresets).toEqual([{ label: 'Kept', model: 'kept-model' }]);

      // All rows invalid -> no usable presets -> migration seeds the factory two.
      expect(getCodexProviderSettings({
        providerConfigs: {
          codex: { modelPresets: [{ label: '', model: '' }] },
        },
      }).modelPresets).toEqual([
        { label: 'GPT-5.4 Mini', model: 'gpt-5.4-mini' },
        { label: 'GPT-5.5', model: 'gpt-5.5' },
      ]);
    });

    it('updateCodexProviderSettings drops customModels and projects preset windows', () => {
      const settingsBag: Record<string, unknown> = {
        customContextLimits: { 'old-model': 128_000 },
        providerConfigs: {
          codex: { customModels: 'old-model' },
        },
      };

      const next = updateCodexProviderSettings(settingsBag, {
        modelPresets: [
          { label: 'Opus', model: 'claude-opus', contextWindow: 1_000_000 },
          { label: 'Mini', model: 'gpt-5.4-mini' },
        ],
      });

      expect(next.modelPresets).toHaveLength(2);
      const codexConfig = (settingsBag.providerConfigs as Record<string, Record<string, unknown>>).codex;
      expect(codexConfig).not.toHaveProperty('customModels');
      expect(codexConfig.modelPresets).toHaveLength(2);
      expect(codexConfig.modelPresets).toEqual([
        { label: 'Opus', model: 'claude-opus', contextWindow: 1_000_000 },
        { label: 'Mini', model: 'gpt-5.4-mini' },
      ]);
      // Foreign keys stay untouched; preset windows project into the shared map.
      expect(settingsBag.customContextLimits).toEqual({
        'old-model': 128_000,
        'claude-opus': 1_000_000,
      });
    });

    it('removes the context limit entry when a preset loses its window', () => {
      const settingsBag: Record<string, unknown> = {
        customContextLimits: { 'claude-opus': 1_000_000 },
        providerConfigs: {
          codex: { modelPresets: [{ label: 'Opus', model: 'claude-opus', contextWindow: 1_000_000 }] },
        },
      };

      updateCodexProviderSettings(settingsBag, {
        modelPresets: [{ label: 'Opus', model: 'claude-opus' }],
      });

      expect(settingsBag.customContextLimits).toEqual({});
    });
  });
});

