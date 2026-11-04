import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getCodexProviderSettings } from './settings';
import {
  DEFAULT_CODEX_MODELS,
  DEFAULT_CODEX_PRIMARY_MODEL,
  formatCodexModelLabel,
} from './types/models';

const BUILT_IN_CODEX_MODEL_DESCRIPTIONS = new Map(
  DEFAULT_CODEX_MODELS.map(model => [model.value, model.description]),
);

function createCustomCodexModelOption(modelId: string, description: string): ProviderUIOption {
  return {
    value: modelId,
    label: formatCodexModelLabel(modelId),
    description,
  };
}

function getConfiguredEnvModel(settings: Record<string, unknown>): string | null {
  const modelId = getRuntimeEnvironmentVariables(settings, 'codex').OPENAI_MODEL?.trim();
  return modelId ? modelId : null;
}

/**
 * Env additions stay compatible with the presets, never a replacement — but
 * OPENAI_MODEL joins the list only when the presets do not already cover it:
 * resolve locks onto the env value regardless, so the dropdown must be able to
 * point at it even when the matching factory preset was deleted.
 */
export function getConfiguredEnvCustomModel(
  settings: Record<string, unknown>,
  presetModels: ReadonlySet<string>,
): string | null {
  const modelId = getConfiguredEnvModel(settings);
  return modelId && !presetModels.has(modelId) ? modelId : null;
}

export function getCodexModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
  const codexSettings = getCodexProviderSettings(settings);
  const models: ProviderUIOption[] = codexSettings.modelPresets.map(preset => ({
    value: preset.model,
    label: preset.label,
    description: BUILT_IN_CODEX_MODEL_DESCRIPTIONS.get(preset.model) ?? 'Custom model',
  }));

  const presetModels = new Set(models.map(model => model.value));
  const envModel = getConfiguredEnvCustomModel(settings, presetModels);
  if (envModel) {
    models.unshift(createCustomCodexModelOption(envModel, 'Custom (env)'));
  }

  return models;
}

export function resolveCodexModelSelection(
  settings: Record<string, unknown>,
  currentModel: string,
): string | null {
  const envModel = getConfiguredEnvModel(settings);
  if (envModel) {
    return envModel;
  }

  const modelOptions = getCodexModelOptions(settings);
  if (currentModel && modelOptions.some(option => option.value === currentModel)) {
    return currentModel;
  }

  return modelOptions[0]?.value ?? DEFAULT_CODEX_PRIMARY_MODEL;
}
