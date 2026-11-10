import {
  BINARY_PERMISSION_MODE_POLICY,
  getBinaryPermissionModeOptions,
} from '../../../core/providers/permissionModes';
import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderServiceTierToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { OPENAI_PROVIDER_ICON } from '../../../shared/icons';
import { getCodexModelOptions } from '../modelOptions';
import { applyCodexModelDefaults } from '../settings';
import {
  DEFAULT_CODEX_MODEL_SET,
  DEFAULT_CODEX_PRIMARY_MODEL,
  FAST_TIER_CODEX_DESCRIPTION,
  FAST_TIER_CODEX_MODEL,
} from '../types/models';

// Render-time factories instead of module-level constants: labels must be
// resolved through t() at call time so a locale switch is reflected without
// reloading the plugin. Effort labels are intentionally fixed English to
// match Claude's built-in reasoning levels in every locale.

function getEffortLevels(): ProviderReasoningOption[] {
  return [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
  ];
}

function getCodexPermissionModeOptions() {
  return getBinaryPermissionModeOptions({
    safe: t('chat.codex.permission.safe'),
    yolo: t('chat.codex.permission.yolo'),
  });
}

function getCodexServiceTierToggle(): ProviderServiceTierToggleConfig {
  return {
    inactiveValue: 'default',
    inactiveLabel: t('chat.codex.serviceTier.standard'),
    activeValue: 'fast',
    activeLabel: t('chat.codex.serviceTier.fast'),
    description: FAST_TIER_CODEX_DESCRIPTION,
  };
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

function looksLikeCodexModel(model: string): boolean {
  return /^gpt-/i.test(model) || /^o\d/i.test(model);
}

export const codexChatUIConfig: ProviderChatUIConfig = {
  permissionModes: BINARY_PERMISSION_MODE_POLICY,

  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    return getCodexModelOptions(settings);
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    if (this.getModelOptions(settings).some((option: ProviderUIOption) => option.value === model)) {
      return true;
    }

    return looksLikeCodexModel(model);
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(_model: string, _settings: Record<string, unknown>): ProviderReasoningOption[] {
    return getEffortLevels();
  },

  getDefaultReasoningValue(_model: string, _settings: Record<string, unknown>): string {
    return 'medium';
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    // Local fallback only: an authoritative app-server window (via
    // recalculateUsageForModel) still outranks this value for the same model.
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return DEFAULT_CODEX_MODEL_SET.has(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object') {
      return;
    }

    applyCodexModelDefaults(model, settings as Record<string, unknown>);
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    if (getCodexModelOptions(settings).some((option) => option.value === model)) {
      return model;
    }

    return DEFAULT_CODEX_PRIMARY_MODEL;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.OPENAI_MODEL && !DEFAULT_CODEX_MODEL_SET.has(envVars.OPENAI_MODEL)) {
      ids.add(envVars.OPENAI_MODEL);
    }
    return ids;
  },

  getPermissionModeOptions() {
    return getCodexPermissionModeOptions();
  },

  getPermissionTransientModeLabel(value) {
    return value === 'plan' ? t('chat.codex.permission.plan') : null;
  },

  getServiceTierToggle(settings): ProviderServiceTierToggleConfig | null {
    return settings.model === FAST_TIER_CODEX_MODEL ? getCodexServiceTierToggle() : null;
  },

  getProviderIcon() {
    return OPENAI_PROVIDER_ICON;
  },
};
