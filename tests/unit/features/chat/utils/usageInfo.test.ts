import type { UsageInfo } from '@/core/types';
import { calculateUsagePercentage, recalculateUsageForModel, refreshUsageContextWindow } from '@/features/chat/utils/usageInfo';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { DEFAULT_CODEX_PRIMARY_MODEL } from '@/providers/codex/types/models';

function createClaudeSettings(
  presets: Array<{ label: string; model: string; contextWindow?: number }>,
  customContextLimits: Record<string, number>,
): Record<string, unknown> {
  return {
    providerConfigs: { claude: { modelPresets: presets } },
    customContextLimits,
  };
}

function createClaudeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
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

describe('usageInfo', () => {
  describe('calculateUsagePercentage', () => {
    it('rounds to the nearest integer and clamps to 0-100', () => {
      expect(calculateUsagePercentage(13623, 100000)).toBe(14);
      expect(calculateUsagePercentage(500000, 200000)).toBe(100);
      expect(calculateUsagePercentage(500, 0)).toBe(0);
    });
  });

  describe('recalculateUsageForModel', () => {
    it('preserves an authoritative context window for the same model', () => {
      const usage = {
        model: DEFAULT_CODEX_PRIMARY_MODEL,
        inputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 258400,
        contextWindowIsAuthoritative: true,
        contextTokens: 129200,
        percentage: 50,
      };

      expect(recalculateUsageForModel(usage, DEFAULT_CODEX_PRIMARY_MODEL, 200000)).toEqual({
        ...usage,
        model: DEFAULT_CODEX_PRIMARY_MODEL,
        contextWindow: 258400,
        contextWindowIsAuthoritative: true,
        percentage: 50,
      });
    });

    it('falls back to the UI context window when the model changes', () => {
      const usage = {
        model: DEFAULT_CODEX_PRIMARY_MODEL,
        inputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 258400,
        contextWindowIsAuthoritative: true,
        contextTokens: 100000,
        percentage: 39,
      };

      expect(recalculateUsageForModel(usage, 'gpt-5.4-mini', 200000)).toEqual({
        ...usage,
        model: 'gpt-5.4-mini',
        contextWindow: 200000,
        contextWindowIsAuthoritative: false,
        percentage: 50,
      });
    });
  });

  describe('refreshUsageContextWindow', () => {
    const presets = [
      { label: 'Haiku', model: 'haiku' },
      { label: 'Sonnet', model: 'sonnet' },
      { label: 'Opus', model: 'opus' },
    ];

    it('denominates from the selector model only: a prefixed usage.model never participates (2.3.2 ②)', () => {
      // User ruling 2026-09-17: the denominator follows the model selector's
      // preset configuration. The persisted usage.model ("claude-sonnet[1m]",
      // the CLI-reported form) is a label, not a denominator source.
      const usage = createClaudeUsage({ model: 'claude-sonnet[1m]' });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
        selectorModel: 'sonnet[1m]',
      });

      expect(refreshed.contextWindow).toBe(1_000_000);
      expect(refreshed.model).toBe('sonnet[1m]');
      expect(refreshed.percentage).toBe(45);
    });

    it('follows the selector model when it differs from the usage label', () => {
      // 「我选什么模型，显示什么模型的上下文长度才对」: the selector wins over
      // whatever model the persisted usage recorded.
      const usage = createClaudeUsage({ model: 'opus' });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 500_000 }),
        selectorModel: 'sonnet',
      });

      expect(refreshed.model).toBe('sonnet');
      expect(refreshed.contextWindow).toBe(500_000);
    });

    it('remaps the selector model variant onto the offered preset', () => {
      // Presets only offer the 1M variant: the selector's family variant is
      // remapped so the configured window resolves.
      const usage = createClaudeUsage();
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(
          [{ label: 'Sonnet 1M', model: 'sonnet[1m]' }],
          { 'sonnet[1m]': 700_000 },
        ),
        selectorModel: 'sonnet',
      });

      expect(refreshed.contextWindow).toBe(700_000);
    });

    it('drops a stale authoritative window when the selector model differs from the usage model', () => {
      // An authoritative window is only valid for the model that produced it;
      // the runtime window must not survive the model change (Codex still
      // produces authoritative windows; Claude no longer does — 2.3.2 ②).
      const usage = createClaudeUsage({
        model: 'other-model',
        contextWindow: 800_000,
        contextWindowIsAuthoritative: true,
      });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
        selectorModel: 'sonnet',
      });

      expect(refreshed.model).toBe('sonnet');
      expect(refreshed.contextWindow).toBe(1_000_000);
      expect(refreshed.contextWindowIsAuthoritative).toBe(false);
    });

    it('falls back to the provider settings model when no selector model is given', () => {
      // 3.0.2 hotfix: an empty selector model must not silently preserve a
      // stale stored denominator — re-derive from the provider's current
      // settings model instead.
      const usage = createClaudeUsage();
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: {
          ...createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
          model: 'sonnet',
        },
      });

      expect(refreshed.model).toBe('sonnet');
      expect(refreshed.contextWindow).toBe(1_000_000);
      expect(refreshed.percentage).toBe(45);
    });

    it('falls back to the first offered preset when the settings model is absent', () => {
      const usage = createClaudeUsage();
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, {}),
      });

      expect(refreshed.model).toBe('haiku');
      expect(refreshed.contextWindow).toBe(200_000);
      expect(refreshed.percentage).toBe(100);
    });

    it('ignores a settings model the provider does not own', () => {
      // A raw settings bag may carry another provider's model: the fallback
      // must not denominate a Claude usage from it.
      const usage = createClaudeUsage();
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: {
          ...createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
          model: 'gpt-5.4',
        },
      });

      expect(refreshed.model).toBe('haiku');
      expect(refreshed.contextWindow).toBe(200_000);
    });

    it('returns the usage unchanged when no model resolves at all', () => {
      // A provider that offers no models and has no settings model: nothing
      // to denominate from, so the stored snapshot survives. (Claude's
      // settings layer always migrates to default presets, so this contract
      // needs a stub config.)
      const usage = createClaudeUsage({ model: undefined });
      const emptyUiConfig = {
        normalizeModelVariant: (model: string) => model,
        getContextWindowSize: () => 200_000,
        ownsModel: () => false,
        getModelOptions: () => [],
      };
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: emptyUiConfig,
        settings: {},
      });

      expect(refreshed).toBe(usage);
    });

    it('falls back to the conservative standard window for unconfigured models', () => {
      const usage = createClaudeUsage();
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, {}),
        selectorModel: 'sonnet[1m]',
      });

      expect(refreshed.contextWindow).toBe(200_000);
    });
  });
});
