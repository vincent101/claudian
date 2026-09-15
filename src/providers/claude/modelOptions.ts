import { getRuntimeEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { ProviderUIOption } from '../../core/providers/types';
import { getModelsFromEnvironment } from './env/claudeModelEnv';
import { getClaudeProviderSettings } from './settings';
import { DEFAULT_CLAUDE_MODELS } from './types/models';

const BUILT_IN_MODEL_DESCRIPTIONS = new Map(
  DEFAULT_CLAUDE_MODELS.map(model => [model.value, model.description]),
);

export function getClaudeModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
  const claudeSettings = getClaudeProviderSettings(settings);
  const models: ProviderUIOption[] = claudeSettings.modelPresets.map(preset => ({
    value: preset.model,
    label: preset.label,
    description: BUILT_IN_MODEL_DESCRIPTIONS.get(preset.model) ?? 'Custom model',
  }));

  // Environment models are compatible additions, never a replacement: presets
  // stay selectable even when the runtime env maps model env keys.
  const envModels = getModelsFromEnvironment(
    getRuntimeEnvironmentVariables(settings, 'claude'),
  );
  const seenValues = new Set(models.map(model => model.value));
  for (const envModel of envModels) {
    if (seenValues.has(envModel.value)) {
      continue;
    }

    seenValues.add(envModel.value);
    models.push(envModel);
  }

  return models;
}

export function resolveClaudeModelSelection(
  settings: Record<string, unknown>,
  currentModel: string,
): string | null {
  const modelOptions = getClaudeModelOptions(settings);
  if (currentModel && modelOptions.some(option => option.value === currentModel)) {
    return currentModel;
  }

  const lastModel = getClaudeProviderSettings(settings).lastModel;
  if (lastModel && modelOptions.some(option => option.value === lastModel)) {
    return lastModel;
  }

  return modelOptions[0]?.value ?? null;
}
