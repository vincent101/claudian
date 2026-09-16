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

    it('re-derives a non-authoritative stored window from the usage.model preset', () => {
      const usage = createClaudeUsage();
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
      });

      expect(refreshed).toEqual({
        ...usage,
        contextWindow: 1_000_000,
        contextWindowIsAuthoritative: false,
        percentage: 45,
      });
    });

    it('matches a configured preset through a [1m] alias usage.model (control: non-fallback value)', () => {
      const usage = createClaudeUsage({ model: 'sonnet[1m]' });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
      });

      expect(refreshed.contextWindow).toBe(1_000_000);
      expect(refreshed.model).toBe('sonnet[1m]');
    });

    it('normalizes casing of the stored usage.model before preset lookup', () => {
      const usage = createClaudeUsage({ model: 'Sonnet' });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 500_000 }),
      });

      expect(refreshed.contextWindow).toBe(500_000);
    });

    it('remaps the usage.model variant onto the offered preset without rewriting the stored label', () => {
      // Presets only offer the 1M variant: the family variant must be remapped
      // so the configured window resolves, but the persisted usage.model keeps
      // recording what the runtime actually reported.
      const usage = createClaudeUsage({ model: 'sonnet' });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(
          [{ label: 'Sonnet 1M', model: 'sonnet[1m]' }],
          { 'sonnet[1m]': 700_000 },
        ),
      });

      expect(refreshed.contextWindow).toBe(700_000);
      expect(refreshed.model).toBe('sonnet');
    });

    it('keeps an authoritative same-model runtime window untouched', () => {
      const usage = createClaudeUsage({
        contextWindow: 800_000,
        contextWindowIsAuthoritative: true,
        percentage: 57,
      });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
      });

      expect(refreshed.contextWindow).toBe(800_000);
      expect(refreshed.contextWindowIsAuthoritative).toBe(true);
    });

    it('drops a stale authoritative window when the stored model differs from the candidate', () => {
      // An authoritative window is only valid for the model that produced it;
      // when the candidate model comes from the caller (no stored model), the
      // runtime window must not survive the model change.
      const usage = createClaudeUsage({
        model: undefined,
        contextWindow: 800_000,
        contextWindowIsAuthoritative: true,
      });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
        fallbackModel: 'sonnet',
      });

      expect(refreshed.model).toBe('sonnet');
      expect(refreshed.contextWindow).toBe(1_000_000);
      expect(refreshed.contextWindowIsAuthoritative).toBe(false);
    });

    it('falls back to the caller-provided current model when usage carries none', () => {
      const usage = createClaudeUsage({ model: undefined });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, { 'sonnet': 1_000_000 }),
        fallbackModel: 'sonnet',
      });

      expect(refreshed.model).toBe('sonnet');
      expect(refreshed.contextWindow).toBe(1_000_000);
      expect(refreshed.percentage).toBe(45);
    });

    it('returns the usage unchanged when no candidate model exists', () => {
      const usage = createClaudeUsage({ model: undefined });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, {}),
      });

      expect(refreshed).toBe(usage);
    });

    it('falls back to the conservative standard window for unconfigured models', () => {
      const usage = createClaudeUsage({ model: 'sonnet[1m]' });
      const refreshed = refreshUsageContextWindow(usage, {
        uiConfig: claudeChatUIConfig,
        settings: createClaudeSettings(presets, {}),
      });

      expect(refreshed.contextWindow).toBe(200_000);
    });
  });
});
