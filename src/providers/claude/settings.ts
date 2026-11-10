import {
  importLegacyContextLimits,
  type ModelPreset,
  type ModelPresetDraft,
  normalizeModelPresets,
  parseLegacyCustomModelIds,
  projectModelPresetsToContextLimits,
} from '../../core/providers/modelPresets';
import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import { formatCustomModelLabel } from './modelLabels';
import type { NativeMcpCutoverRecord } from './types/nativeMcpCutover';

// Preset mechanics live in the provider-neutral core module; the Claude-named
// re-exports keep existing imports stable.
export {
  modelPresetDraftsToPresets as claudeModelPresetDraftsToPresets,
  normalizeModelPresets as normalizeClaudeModelPresets,
  validateModelPresetDrafts as validateClaudeModelPresetDrafts,
} from '../../core/providers/modelPresets';

export type ClaudeSettingSource = 'user' | 'project' | 'local';

export type ClaudeModelPreset = ModelPreset;
export type ClaudeModelPresetDraft = ModelPresetDraft;

export const DEFAULT_CLAUDE_MODEL_PRESETS: readonly ClaudeModelPreset[] = Object.freeze([
  { label: 'Haiku', model: 'haiku' },
  { label: 'Sonnet', model: 'sonnet' },
  { label: 'Opus', model: 'opus' },
  { label: 'Fable', model: 'fable', contextWindow: 1_000_000 },
]);

export interface ClaudeProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  loadUserSettings: boolean;
  enableChrome: boolean;
  enableBangBash: boolean;
  modelPresets: ClaudeModelPreset[];
  lastModel: string;
  environmentVariables: string;
  environmentHash: string;
  /**
   * Provider-owned, non-secret record of the user's one-shot confirmation
   * for provider-native MCP management (design 2026-11-09). Must survive
   * load/save normalization untouched.
   */
  nativeMcpCutover?: NativeMcpCutoverRecord;
}

export const DEFAULT_CLAUDE_PROVIDER_SETTINGS: Readonly<ClaudeProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  loadUserSettings: true,
  enableChrome: false,
  enableBangBash: false,
  modelPresets: DEFAULT_CLAUDE_MODEL_PRESETS.map(preset => ({ ...preset })),
  lastModel: 'haiku',
  environmentVariables: '',
  environmentHash: '',
});

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: HostnameCliPaths = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return result;
}

function readLegacyToggle(
  config: Record<string, unknown>,
  settings: Record<string, unknown>,
  key: 'enableSonnet1M' | 'enableOpus1M',
): boolean {
  const value = config[key] ?? settings[key];
  return value === true;
}

/**
 * One-shot migration from the retired 1M toggles + custom-model textarea into
 * the preset list. Deterministic and idempotent: it only runs when the stored
 * config has no usable modelPresets, and the output never depends on how often
 * it is invoked.
 */
export function migrateClaudeModelPresets(
  config: Record<string, unknown>,
  settings: Record<string, unknown>,
): ClaudeModelPreset[] {
  const enableSonnet1M = readLegacyToggle(config, settings, 'enableSonnet1M');
  const enableOpus1M = readLegacyToggle(config, settings, 'enableOpus1M');

  const presets: ClaudeModelPreset[] = [
    { label: 'Haiku', model: 'haiku' },
    enableSonnet1M
      ? { label: 'Sonnet 1M', model: 'sonnet[1m]' }
      : { label: 'Sonnet', model: 'sonnet' },
    enableOpus1M
      ? { label: 'Opus 1M', model: 'opus[1m]' }
      : { label: 'Opus', model: 'opus' },
    { ...DEFAULT_CLAUDE_MODEL_PRESETS[3] },
  ];

  for (const modelId of parseLegacyCustomModelIds(config.customModels ?? settings.customModels)) {
    if (presets.some(preset => preset.model === modelId)) {
      continue;
    }
    presets.push({ label: formatCustomModelLabel(modelId), model: modelId });
  }

  importLegacyContextLimits(presets, settings.customContextLimits);
  return presets;
}

export function getClaudeProviderSettings(
  settings: Record<string, unknown>,
): ClaudeProviderSettings {
  const config = getProviderConfig(settings, 'claude');
  const modelPresets = normalizeModelPresets(config.modelPresets)
    ?? migrateClaudeModelPresets(config, settings);

  return {
    cliPath: (config.cliPath as string | undefined)
      ?? (settings.claudeCliPath as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost: normalizeHostnameCliPaths(config.cliPathsByHost ?? settings.claudeCliPathsByHost),
    loadUserSettings: (config.loadUserSettings as boolean | undefined)
      ?? (settings.loadUserClaudeSettings as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.loadUserSettings,
    enableChrome: (config.enableChrome as boolean | undefined)
      ?? (settings.enableChrome as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableChrome,
    enableBangBash: (config.enableBangBash as boolean | undefined)
      ?? (settings.enableBangBash as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableBangBash,
    modelPresets,
    lastModel: (config.lastModel as string | undefined)
      ?? (settings.lastClaudeModel as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.lastModel,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'claude')
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? (settings.lastEnvHash as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentHash,
    nativeMcpCutover: config.nativeMcpCutover as NativeMcpCutoverRecord | undefined,
  };
}

export function resolveClaudeSettingSources(
  loadUserSettings: boolean,
): ClaudeSettingSource[] {
  return loadUserSettings
    ? ['user', 'project', 'local']
    : ['project', 'local'];
}

export function updateClaudeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<ClaudeProviderSettings>,
): ClaudeProviderSettings {
  const current = getClaudeProviderSettings(settings);
  const next = {
    ...current,
    ...updates,
  };
  setProviderConfig(settings, 'claude', next);
  if ('modelPresets' in updates) {
    settings.customContextLimits = projectModelPresetsToContextLimits(
      settings.customContextLimits,
      next.modelPresets,
    );
  }
  return next;
}
