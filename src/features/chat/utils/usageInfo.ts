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
  /** Current/draft model used only when the usage carries no model of its own. */
  fallbackModel?: string;
}

/**
 * Re-derives the usage denominator through the provider preset chain for
 * every entry point where already-existing usage reaches the UI (conversation
 * hydration, settings refresh). Persisted usage snapshots may carry a locally
 * fallback window that was never authoritative, and settings may have changed
 * since the snapshot was written, so the denominator is recomputed from the
 * candidate model — the usage's own recorded model first, the caller's
 * current model otherwise. A same-model authoritative runtime window survives
 * (recalculateUsageForModel); the stored model label is never rewritten by
 * variant normalization so later re-derivations stay stable.
 */
export function refreshUsageContextWindow(
  usage: UsageInfo,
  deps: UsageContextWindowDeps,
): UsageInfo {
  const candidate = usage.model?.trim() || deps.fallbackModel?.trim() || '';
  if (!candidate) {
    return usage;
  }

  const normalizedModel = deps.uiConfig.normalizeModelVariant(candidate, deps.settings);
  const customLimits = deps.settings.customContextLimits as Record<string, number> | undefined;
  const fallbackWindow = deps.uiConfig.getContextWindowSize(normalizedModel, customLimits);

  return recalculateUsageForModel(usage, candidate, fallbackWindow);
}
