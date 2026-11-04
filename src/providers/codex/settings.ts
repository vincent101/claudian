import {
  importLegacyContextLimits,
  type ModelPreset,
  normalizeModelPresets,
  parseLegacyCustomModelIds,
  projectModelPresetsToContextLimits,
} from '../../core/providers/modelPresets';
import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  CODEX_SPARK_MODEL,
  DEFAULT_CODEX_MODEL_PRESETS,
  formatCodexModelLabel,
} from './types/models';

export type CodexSafeMode = 'workspace-write' | 'read-only';
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type CodexInstallationMethod = 'native-windows' | 'wsl';
export type HostnameInstallationMethods = Record<string, CodexInstallationMethod>;

/** Editable model tier for the Codex selector (shared preset shape). */
export type CodexModelPreset = ModelPreset;

function normalizeCodexInstallationMethod(value: unknown): CodexInstallationMethod {
  return value === 'wsl' ? 'wsl' : 'native-windows';
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface CodexProviderSettings {
  enabled: boolean;
  safeMode: CodexSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  modelPresets: CodexModelPreset[];
  reasoningSummary: CodexReasoningSummary;
  environmentVariables: string;
  environmentHash: string;
  installationMethod: CodexInstallationMethod;
  installationMethodsByHost: HostnameInstallationMethods;
  wslDistroOverride: string;
  wslDistroOverridesByHost: HostnameCliPaths;
}

export const DEFAULT_CODEX_PROVIDER_SETTINGS: Readonly<CodexProviderSettings> = Object.freeze({
  enabled: false,
  safeMode: 'workspace-write',
  cliPath: '',
  cliPathsByHost: {},
  modelPresets: DEFAULT_CODEX_MODEL_PRESETS.map(preset => ({ ...preset })),
  reasoningSummary: 'detailed',
  environmentVariables: '',
  environmentHash: '',
  installationMethod: 'native-windows',
  installationMethodsByHost: {},
  wslDistroOverride: '',
  wslDistroOverridesByHost: {},
});

export function shouldDisableCodexReasoningSummary(model: string | undefined): boolean {
  return model === CODEX_SPARK_MODEL;
}

export function getEffectiveCodexReasoningSummary(
  settings: Record<string, unknown>,
  model: string | undefined,
): CodexReasoningSummary {
  if (shouldDisableCodexReasoningSummary(model)) {
    return 'none';
  }

  return getCodexProviderSettings(settings).reasoningSummary;
}

export function applyCodexModelDefaults(
  model: string,
  settings: Record<string, unknown>,
): void {
  if (shouldDisableCodexReasoningSummary(model)) {
    updateCodexProviderSettings(settings, { reasoningSummary: 'none' });
  }
}

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

function normalizeInstallationMethodsByHost(value: unknown): HostnameInstallationMethods {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: HostnameInstallationMethods = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === 'string' && key.trim()) {
      result[key] = normalizeCodexInstallationMethod(entry);
    }
  }
  return result;
}

/**
 * One-shot migration from the retired custom-model textarea into the preset
 * list. Deterministic and idempotent: it only runs when the stored config has
 * no usable modelPresets, and the output never depends on how often it is
 * invoked. Legacy labels reuse the picker's display formatting, so the
 * migrated list is visually identical to the pre-migration selector.
 */
export function migrateCodexModelPresets(
  config: Record<string, unknown>,
  settings: Record<string, unknown>,
): CodexModelPreset[] {
  const presets: CodexModelPreset[] = DEFAULT_CODEX_MODEL_PRESETS.map(preset => ({ ...preset }));

  for (const modelId of parseLegacyCustomModelIds(config.customModels)) {
    if (presets.some(preset => preset.model === modelId)) {
      continue;
    }
    presets.push({ label: formatCodexModelLabel(modelId), model: modelId });
  }

  importLegacyContextLimits(presets, settings.customContextLimits);
  return presets;
}

export function getCodexProviderSettings(
  settings: Record<string, unknown>,
): CodexProviderSettings {
  const config = getProviderConfig(settings, 'codex');
  const hostnameKey = getHostnameKey();
  const installationMethodsByHost = normalizeInstallationMethodsByHost(config.installationMethodsByHost);
  const wslDistroOverridesByHost = normalizeHostnameCliPaths(config.wslDistroOverridesByHost);
  const hasHostScopedInstallationMethods = Object.keys(installationMethodsByHost).length > 0;
  const hasHostScopedWslDistroOverrides = Object.keys(wslDistroOverridesByHost).length > 0;
  const legacyInstallationMethod = normalizeCodexInstallationMethod(config.installationMethod);
  const legacyWslDistroOverride = normalizeOptionalString(config.wslDistroOverride);
  const modelPresets = normalizeModelPresets(config.modelPresets)
    ?? migrateCodexModelPresets(config, settings);

  return {
    enabled: (config.enabled as boolean | undefined)
      ?? (settings.codexEnabled as boolean | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.enabled,
    safeMode: (config.safeMode as CodexSafeMode | undefined)
      ?? (settings.codexSafeMode as CodexSafeMode | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.safeMode,
    cliPath: (config.cliPath as string | undefined)
      ?? (settings.codexCliPath as string | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost: normalizeHostnameCliPaths(config.cliPathsByHost ?? settings.codexCliPathsByHost),
    modelPresets,
    reasoningSummary: (config.reasoningSummary as CodexReasoningSummary | undefined)
      ?? (settings.codexReasoningSummary as CodexReasoningSummary | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.reasoningSummary,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'codex')
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? (settings.lastCodexEnvHash as string | undefined)
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.environmentHash,
    installationMethod: installationMethodsByHost[hostnameKey]
      ?? (
        hasHostScopedInstallationMethods
          ? DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod
          : legacyInstallationMethod
      ),
    installationMethodsByHost,
    wslDistroOverride: wslDistroOverridesByHost[hostnameKey]
      ?? (
        hasHostScopedWslDistroOverrides
          ? DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride
          : legacyWslDistroOverride
      ),
    wslDistroOverridesByHost,
  };
}

export function updateCodexProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CodexProviderSettings>,
): CodexProviderSettings {
  const current = getCodexProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const installationMethodsByHost = 'installationMethodsByHost' in updates
    ? normalizeInstallationMethodsByHost(updates.installationMethodsByHost)
    : { ...current.installationMethodsByHost };
  const wslDistroOverridesByHost = 'wslDistroOverridesByHost' in updates
    ? normalizeHostnameCliPaths(updates.wslDistroOverridesByHost)
    : { ...current.wslDistroOverridesByHost };

  if (
    Object.keys(installationMethodsByHost).length === 0
    && current.installationMethod !== DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod
  ) {
    installationMethodsByHost[hostnameKey] = current.installationMethod;
  }

  if (
    Object.keys(wslDistroOverridesByHost).length === 0
    && current.wslDistroOverride
  ) {
    wslDistroOverridesByHost[hostnameKey] = current.wslDistroOverride;
  }

  if ('installationMethod' in updates) {
    installationMethodsByHost[hostnameKey] = normalizeCodexInstallationMethod(updates.installationMethod);
  }

  if ('wslDistroOverride' in updates) {
    const normalizedDistroOverride = normalizeOptionalString(updates.wslDistroOverride);
    if (normalizedDistroOverride) {
      wslDistroOverridesByHost[hostnameKey] = normalizedDistroOverride;
    } else {
      delete wslDistroOverridesByHost[hostnameKey];
    }
  }

  const next: CodexProviderSettings = {
    ...current,
    ...updates,
    installationMethod: installationMethodsByHost[hostnameKey]
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.installationMethod,
    installationMethodsByHost,
    wslDistroOverride: wslDistroOverridesByHost[hostnameKey]
      ?? DEFAULT_CODEX_PROVIDER_SETTINGS.wslDistroOverride,
    wslDistroOverridesByHost,
  };

  setProviderConfig(settings, 'codex', {
    enabled: next.enabled,
    safeMode: next.safeMode,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    modelPresets: next.modelPresets,
    reasoningSummary: next.reasoningSummary,
    environmentVariables: next.environmentVariables,
    environmentHash: next.environmentHash,
    installationMethodsByHost,
    wslDistroOverridesByHost,
  });
  if ('modelPresets' in updates) {
    settings.customContextLimits = projectModelPresetsToContextLimits(
      settings.customContextLimits,
      next.modelPresets,
    );
  }
  return next;
}
