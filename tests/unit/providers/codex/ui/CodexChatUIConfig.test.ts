import { recalculateUsageForModel } from '@/features/chat/utils/usageInfo';
import { setLocale } from '@/i18n/i18n';
import { resolveCodexModelSelection } from '@/providers/codex/modelOptions';
import { CODEX_SPARK_MODEL, DEFAULT_CODEX_PRIMARY_MODEL } from '@/providers/codex/types/models';
import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';

describe('CodexChatUIConfig', () => {
  describe('getModelOptions', () => {
    it('should return default models when no env vars', () => {
      const options = codexChatUIConfig.getModelOptions({});
      expect(options).toHaveLength(2);
      expect(options.map(o => o.value)).toContain(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(options.map(o => o.value)).toContain('gpt-5.4-mini');
    });

    it('appends settings-defined custom models after the built-in options', () => {
      const options = codexChatUIConfig.getModelOptions({
        providerConfigs: {
          codex: {
            customModels: 'gpt-5.6-preview\nmy-custom-model\nmy-custom-model',
          },
        },
      });

      expect(options).toEqual([
        {
          value: 'gpt-5.4-mini',
          label: 'GPT-5.4 Mini',
          description: 'Fast',
        },
        {
          value: DEFAULT_CODEX_PRIMARY_MODEL,
          label: 'GPT-5.5',
          description: 'Latest',
        },
        {
          value: 'gpt-5.6-preview',
          label: 'GPT-5.6 Preview',
          description: 'Custom model',
        },
        {
          value: 'my-custom-model',
          label: 'my-custom-model',
          description: 'Custom model',
        },
      ]);
    });

    it('should prepend custom model from OPENAI_MODEL env var', () => {
      const options = codexChatUIConfig.getModelOptions({
        environmentVariables: 'OPENAI_MODEL=my-custom-model',
      });
      expect(options[0].value).toBe('my-custom-model');
      expect(options[0].description).toBe('Custom (env)');
      expect(options.length).toBe(3);
    });

    it('deduplicates env and settings-defined custom models', () => {
      const options = codexChatUIConfig.getModelOptions({
        providerConfigs: {
          codex: {
            customModels: 'my-custom-model\nsecond-custom-model',
            environmentVariables: 'OPENAI_MODEL=my-custom-model',
          },
        },
      });

      // The env model is covered by the migrated presets, so it keeps its
      // preset position instead of being prepended.
      expect(options.map(option => option.value)).toEqual([
        'gpt-5.4-mini',
        DEFAULT_CODEX_PRIMARY_MODEL,
        'my-custom-model',
        'second-custom-model',
      ]);
    });

    it('should not duplicate when OPENAI_MODEL matches a default model', () => {
      const options = codexChatUIConfig.getModelOptions({
        environmentVariables: `OPENAI_MODEL=${DEFAULT_CODEX_PRIMARY_MODEL}`,
      });
      expect(options.length).toBe(2);
    });

    it('maps stored presets directly, keeping their labels', () => {
      const options = codexChatUIConfig.getModelOptions({
        providerConfigs: {
          codex: {
            modelPresets: [
              { label: 'Fast custom', model: 'gpt-5.6-preview' },
              { label: 'Opus', model: 'claude-opus' },
            ],
          },
        },
      });

      expect(options).toEqual([
        { value: 'gpt-5.6-preview', label: 'Fast custom', description: 'Custom model' },
        { value: 'claude-opus', label: 'Opus', description: 'Custom model' },
      ]);
    });

    it('shows only the user rows when both factory presets are deleted', () => {
      const options = codexChatUIConfig.getModelOptions({
        providerConfigs: {
          codex: {
            modelPresets: [
              { label: 'claude-opus', model: 'claude-opus' },
              { label: 'claude-sonnet', model: 'claude-sonnet' },
            ],
          },
        },
      });

      expect(options.map(option => option.value)).toEqual(['claude-opus', 'claude-sonnet']);
    });

    it('uses the built-in description for factory model presets', () => {
      const options = codexChatUIConfig.getModelOptions({
        providerConfigs: {
          codex: {
            modelPresets: [
              { label: 'GPT-5.4 Mini', model: 'gpt-5.4-mini' },
              { label: 'GPT-5.5', model: 'gpt-5.5' },
            ],
          },
        },
      });

      expect(options.map(option => option.description)).toEqual(['Fast', 'Latest']);
    });

    it('adds a Custom (env) option when OPENAI_MODEL names a deleted factory preset', () => {
      const options = codexChatUIConfig.getModelOptions({
        environmentVariables: `OPENAI_MODEL=${DEFAULT_CODEX_PRIMARY_MODEL}`,
        providerConfigs: {
          codex: {
            modelPresets: [{ label: 'Mini', model: 'gpt-5.4-mini' }],
          },
        },
      });

      // resolve locks onto the env value even though its preset was deleted,
      // so the dropdown must still be able to point at it.
      expect(options.map(option => option.value)).toEqual([
        DEFAULT_CODEX_PRIMARY_MODEL,
        'gpt-5.4-mini',
      ]);
      expect(options[0].description).toBe('Custom (env)');
    });
  });

  describe('resolveCodexModelSelection', () => {
    it('locks onto OPENAI_MODEL whenever it is set', () => {
      const settings = {
        environmentVariables: 'OPENAI_MODEL=env-model',
        providerConfigs: {
          codex: {
            modelPresets: [{ label: 'Preset', model: 'preset-model' }],
          },
        },
      };

      expect(resolveCodexModelSelection(settings, 'preset-model')).toBe('env-model');
    });

    it('keeps the current model while it stays in the options', () => {
      const settings = {
        providerConfigs: {
          codex: {
            modelPresets: [
              { label: 'A', model: 'a-model' },
              { label: 'B', model: 'b-model' },
            ],
          },
        },
      };

      expect(resolveCodexModelSelection(settings, 'b-model')).toBe('b-model');
    });

    it('falls back to the first preset when the current model is removed', () => {
      const settings = {
        providerConfigs: {
          codex: {
            modelPresets: [
              { label: 'A', model: 'a-model' },
              { label: 'B', model: 'b-model' },
            ],
          },
        },
      };

      expect(resolveCodexModelSelection(settings, 'removed-model')).toBe('a-model');
    });

    it('seeds the factory presets when the stored list is empty', () => {
      const settings = {
        providerConfigs: {
          codex: {
            modelPresets: [],
          },
        },
      };

      expect(resolveCodexModelSelection(settings, 'removed-model')).toBe('gpt-5.4-mini');
    });
  });

  describe('isAdaptiveReasoningModel', () => {
    it('should return true for all models', () => {
      expect(codexChatUIConfig.isAdaptiveReasoningModel(DEFAULT_CODEX_PRIMARY_MODEL, {})).toBe(true);
      expect(codexChatUIConfig.isAdaptiveReasoningModel('unknown-model', {})).toBe(true);
    });
  });

  describe('getReasoningOptions', () => {
    it('should return effort levels', () => {
      const options = codexChatUIConfig.getReasoningOptions(DEFAULT_CODEX_PRIMARY_MODEL, {});
      expect(options).toHaveLength(4);
      expect(options.map(o => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
    });
  });

  describe('getDefaultReasoningValue', () => {
    it('should return medium for all models', () => {
      expect(codexChatUIConfig.getDefaultReasoningValue(DEFAULT_CODEX_PRIMARY_MODEL, {})).toBe('medium');
    });
  });

  describe('getContextWindowSize', () => {
    it('should return 200000 for all models without custom limits', () => {
      expect(codexChatUIConfig.getContextWindowSize(DEFAULT_CODEX_PRIMARY_MODEL)).toBe(200_000);
      expect(codexChatUIConfig.getContextWindowSize('my-custom-model', {})).toBe(200_000);
      expect(codexChatUIConfig.getContextWindowSize('my-custom-model', undefined)).toBe(200_000);
    });

    it('applies the provider-scoped custom limit when no authoritative window exists', () => {
      expect(
        codexChatUIConfig.getContextWindowSize('my-custom-model', { 'my-custom-model': 256_000 }),
      ).toBe(256_000);
      // Limits for other models must not leak into this model's denominator.
      expect(
        codexChatUIConfig.getContextWindowSize('my-custom-model', { 'other-model': 128_000 }),
      ).toBe(200_000);
    });
  });

  describe('context window denominator with authoritative runtime windows', () => {
    it('keeps the authoritative window when the model is unchanged', () => {
      // App-server reports 200000 as authoritative for gpt-5.5; a stale custom
      // limit of 256000 for the same model must not override it.
      const usage = recalculateUsageForModel(
        {
          inputTokens: 10_000,
          contextTokens: 10_000,
          contextWindow: 200_000,
          contextWindowIsAuthoritative: true,
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          percentage: 5,
        },
        DEFAULT_CODEX_PRIMARY_MODEL,
        codexChatUIConfig.getContextWindowSize(
          DEFAULT_CODEX_PRIMARY_MODEL,
          { [DEFAULT_CODEX_PRIMARY_MODEL]: 256_000 },
        ),
      );

      expect(usage.contextWindow).toBe(200_000);
      expect(usage.contextWindowIsAuthoritative).toBe(true);
    });

    it('falls back to the custom limit for the newly selected model', () => {
      const usage = recalculateUsageForModel(
        {
          inputTokens: 10_000,
          contextTokens: 10_000,
          contextWindow: 200_000,
          contextWindowIsAuthoritative: true,
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          percentage: 5,
        },
        'my-custom-model',
        codexChatUIConfig.getContextWindowSize(
          'my-custom-model',
          { 'my-custom-model': 128_000 },
        ),
      );

      expect(usage.contextWindow).toBe(128_000);
      expect(usage.contextWindowIsAuthoritative).toBe(false);
      expect(usage.percentage).toBe(8);
    });

    it('falls back to the 200k default when the new model has no custom limit', () => {
      const usage = recalculateUsageForModel(
        {
          inputTokens: 10_000,
          contextTokens: 10_000,
          contextWindow: 200_000,
          contextWindowIsAuthoritative: true,
          model: DEFAULT_CODEX_PRIMARY_MODEL,
          percentage: 5,
        },
        'another-model',
        codexChatUIConfig.getContextWindowSize('another-model', { 'my-custom-model': 128_000 }),
      );

      expect(usage.contextWindow).toBe(200_000);
      expect(usage.contextWindowIsAuthoritative).toBe(false);
    });
  });

  describe('applyModelDefaults', () => {
    it('sets reasoning summary off for GPT-5.3 Codex Spark', () => {
      const settings: Record<string, unknown> = {
        providerConfigs: {
          codex: {
            reasoningSummary: 'detailed',
          },
        },
      };

      codexChatUIConfig.applyModelDefaults(CODEX_SPARK_MODEL, settings);

      expect(settings).toMatchObject({
        providerConfigs: {
          codex: {
            reasoningSummary: 'none',
          },
        },
      });
    });

    it('leaves reasoning summary unchanged for other Codex models', () => {
      const settings: Record<string, unknown> = {
        providerConfigs: {
          codex: {
            reasoningSummary: 'detailed',
          },
        },
      };

      codexChatUIConfig.applyModelDefaults(DEFAULT_CODEX_PRIMARY_MODEL, settings);

      expect(settings).toMatchObject({
        providerConfigs: {
          codex: {
            reasoningSummary: 'detailed',
          },
        },
      });
    });
  });

  describe('isDefaultModel', () => {
    it('should return true for built-in models', () => {
      expect(codexChatUIConfig.isDefaultModel(DEFAULT_CODEX_PRIMARY_MODEL)).toBe(true);
      expect(codexChatUIConfig.isDefaultModel('gpt-5.4-mini')).toBe(true);
    });

    it('should return false for custom models', () => {
      expect(codexChatUIConfig.isDefaultModel('my-custom-model')).toBe(false);
    });
  });

  describe('normalizeModelVariant', () => {
    it('falls back unavailable Codex models to the current primary model', () => {
      expect(codexChatUIConfig.normalizeModelVariant('gpt-5.4', {})).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
    });

    it('keeps visible models as-is', () => {
      expect(codexChatUIConfig.normalizeModelVariant(DEFAULT_CODEX_PRIMARY_MODEL, {})).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(codexChatUIConfig.normalizeModelVariant('custom', {
        environmentVariables: 'OPENAI_MODEL=custom',
      })).toBe('custom');
      expect(codexChatUIConfig.normalizeModelVariant('settings-custom', {
        providerConfigs: {
          codex: {
            customModels: 'settings-custom',
          },
        },
      })).toBe('settings-custom');
    });
  });

  describe('getCustomModelIds', () => {
    it('should return custom model from env', () => {
      const ids = codexChatUIConfig.getCustomModelIds({ OPENAI_MODEL: 'my-model' });
      expect(ids.has('my-model')).toBe(true);
    });

    it('should not include default models', () => {
      const ids = codexChatUIConfig.getCustomModelIds({ OPENAI_MODEL: DEFAULT_CODEX_PRIMARY_MODEL });
      expect(ids.size).toBe(0);
    });

    it('should return empty set when no OPENAI_MODEL', () => {
      const ids = codexChatUIConfig.getCustomModelIds({});
      expect(ids.size).toBe(0);
    });
  });

  describe('getPermissionModeOptions', () => {
    it('should return the two-option Safe/YOLO menu with YOLO marked as bypassing', () => {
      const options = codexChatUIConfig.getPermissionModeOptions!({});
      expect(options).toEqual([
        { value: 'normal', label: 'Safe' },
        { value: 'yolo', label: 'YOLO', bypassesApprovals: true },
      ]);
    });

    it('exposes the shared binary policy accepting plan only as a transient', () => {
      expect(codexChatUIConfig.permissionModes).toEqual({
        values: ['normal', 'yolo'],
        defaultValue: 'normal',
        fallbackValue: 'normal',
        transientValues: ['plan'],
      });
      expect(codexChatUIConfig.getPermissionTransientModeLabel?.('plan')).toBe('Plan');
      expect(codexChatUIConfig.getPermissionTransientModeLabel?.('weird')).toBeNull();
    });

    it('resolves labels at call time so a locale switch is reflected immediately', () => {
      try {
        expect(setLocale('zh-CN')).toBe(true);
        expect(codexChatUIConfig.getReasoningOptions(DEFAULT_CODEX_PRIMARY_MODEL, {})[0].label).toBe('低');
        expect(codexChatUIConfig.getPermissionModeOptions!({})?.[0].label).toBe('安全');
      } finally {
        setLocale('en');
      }
    });
  });
});
