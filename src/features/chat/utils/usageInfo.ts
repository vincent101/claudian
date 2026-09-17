import type { ProviderChatUIConfig } from '../../../core/providers/types';
import type { UsageInfo } from '../../../core/types';

export function calculateUsagePercentage(contextTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)))
    : 0;
}

export function recalculateUsageForModel(
  usage: UsageInfo,
  model: string,
  fallbackContextWindow: number,
): UsageInfo {
  const preserveAuthoritativeWindow = usage.contextWindowIsAuthoritative === true
    && usage.contextWindow > 0
    && usage.model === model;
  const contextWindow = preserveAuthoritativeWindow ? usage.contextWindow : fallbackContextWindow;

  return {
    ...usage,
    model,
    contextWindow,
    contextWindowIsAuthoritative: preserveAuthoritativeWindow,
    percentage: calculateUsagePercentage(usage.contextTokens, contextWindow),
  };
}

export interface UsageContextWindowDeps {
  /** Provider UI config owning variant normalization and window resolution. */
  uiConfig: Pick<ProviderChatUIConfig, 'normalizeModelVariant' | 'getContextWindowSize'>;
  /** Raw settings bag; providers extract their config (incl. customContextLimits) from it. */
  settings: Record<string, unknown>;
  /**
   * The model the tab's model selector shows (hydration: the restored
   * provider-model projection; settings refresh: the provider's current
   * model). The single denominator source (2.3.2 ②, user ruling 2026-09-17):
   * "我选什么模型，显示什么模型的上下文长度才对".
   */
  selectorModel?: string;
}

/**
 * Re-derives the usage denominator through the provider preset chain for
 * every entry point where already-existing usage reaches the UI (conversation
 * hydration, settings refresh). The selector model is the only candidate
 * (2.3.2 ②, user ruling 2026-09-17): the persisted usage.model is a runtime
 * label (CLI-reported form like "claude-sonnet[1m]") and never denominates —
 * the earlier usage.model-first chain (2.3.1) could not resolve such labels
 * against configured presets and silently fell to 200k. A same-model
 * authoritative runtime window survives (recalculateUsageForModel; only
 * non-Claude providers still produce those).
 */
export function refreshUsageContextWindow(
  usage: UsageInfo,
  deps: UsageContextWindowDeps,
): UsageInfo {
  const candidate = deps.selectorModel?.trim() || '';
  if (!candidate) {
    return usage;
  }

  const normalizedModel = deps.uiConfig.normalizeModelVariant(candidate, deps.settings);
  const customLimits = deps.settings.customContextLimits as Record<string, number> | undefined;
  const fallbackWindow = deps.uiConfig.getContextWindowSize(normalizedModel, customLimits);

  return recalculateUsageForModel(usage, candidate, fallbackWindow);
}
