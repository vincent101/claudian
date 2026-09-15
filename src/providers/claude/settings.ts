import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import { parseContextLimit } from '../../utils/env';
import { formatCustomModelLabel } from './modelLabels';

export const CLAUDE_SAFE_MODES = ['acceptEdits', 'auto', 'default'] as const;
export type ClaudeSafeMode = typeof CLAUDE_SAFE_MODES[number];
export type ClaudeSettingSource = 'user' | 'project' | 'local';

export interface ClaudeModelPreset {
  label: string;
  model: string;
  contextWindow?: number;
}

/** Editable draft shape used by the settings UI before parsing the window input. */
export interface ClaudeModelPresetDraft {
  label: string;
  model: string;
  contextWindow: string;
}

export const DEFAULT_CLAUDE_MODEL_PRESETS: readonly ClaudeModelPreset[] = Object.freeze([
  { label: 'Haiku', model: 'haiku' },
  { label: 'Sonnet', model: 'sonnet' },
  { label: 'Opus', model: 'opus' },
  { label: 'Fable', model: 'fable', contextWindow: 1_000_000 },
]);

export interface ClaudeProviderSettings {
  safeMode: ClaudeSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  loadUserSettings: boolean;
  enableChrome: boolean;
  enableBangBash: boolean;
  modelPresets: ClaudeModelPreset[];
  lastModel: string;
  environmentVariables: string;
  environmentHash: string;
}

export const DEFAULT_CLAUDE_PROVIDER_SETTINGS: Readonly<ClaudeProviderSettings> = Object.freeze({
  safeMode: 'acceptEdits',
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

function normalizeClaudeSafeMode(value: unknown): ClaudeSafeMode | undefined {
  return (CLAUDE_SAFE_MODES as readonly unknown[]).includes(value)
    ? value as ClaudeSafeMode
    : undefined;
}

function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Normalizes stored presets: trims fields, drops invalid rows, keeps the first
 * row per model id. Returns null when no usable preset survives, so callers
 * fall through to the legacy migration (or defaults).
 */
export function normalizeClaudeModelPresets(value: unknown): ClaudeModelPreset[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const presets: ClaudeModelPreset[] = [];
  const seenModels = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const label = typeof (entry as Record<string, unknown>).label === 'string'
      ? ((entry as Record<string, unknown>).label as string).trim()
      : '';
    const model = typeof (entry as Record<string, unknown>).model === 'string'
      ? ((entry as Record<string, unknown>).model as string).trim()
      : '';
    const rawWindow = (entry as Record<string, unknown>).contextWindow;
    if (!label || !model || seenModels.has(model)) {
      continue;
    }

    seenModels.add(model);
    presets.push(
      isValidContextWindow(rawWindow)
        ? { label, model, contextWindow: rawWindow }
        : { label, model },
    );
  }

  return presets.length > 0 ? presets : null;
}

function readLegacyToggle(
  config: Record<string, unknown>,
  settings: Record<string, unknown>,
  key: 'enableSonnet1M' | 'enableOpus1M',
): boolean {
  const value = config[key] ?? settings[key];
  return value === true;
}

function parseLegacyCustomModelIds(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const modelId = line.trim();
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
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

function importLegacyContextLimits(
  presets: ClaudeModelPreset[],
  customContextLimits: unknown,
): void {
  if (!customContextLimits || typeof customContextLimits !== 'object' || Array.isArray(customContextLimits)) {
    return;
  }

  for (const preset of presets) {
    const limit = (customContextLimits as Record<string, unknown>)[preset.model];
    if (isValidContextWindow(limit)) {
      preset.contextWindow = limit;
    }
  }
}

/**
 * Row-level validation for the settings editor. Returns one i18n error key per
 * draft (null = valid); the caller blocks the whole commit when any row fails.
 */
export function validateClaudeModelPresetDrafts(
  drafts: ClaudeModelPresetDraft[],
): (string | null)[] {
  const seenModels = new Set<string>();
  const duplicateRows = new Set<number>();
  drafts.forEach((draft, index) => {
    const model = draft.model.trim();
    if (model && seenModels.has(model)) {
      duplicateRows.add(index);
    }
    if (model) {
      seenModels.add(model);
    }
  });

  return drafts.map((draft, index) => {
    if (!draft.label.trim()) {
      return 'settings.modelPresets.validation.emptyLabel';
    }
    if (!draft.model.trim()) {
      return 'settings.modelPresets.validation.emptyModel';
    }
    if (duplicateRows.has(index)) {
      return 'settings.modelPresets.validation.duplicateModel';
    }
    if (draft.contextWindow.trim() && parseContextLimit(draft.contextWindow) === null) {
      return 'settings.modelPresets.validation.invalidWindow';
    }
    return null;
  });
}

/** Parses validated drafts into the persisted preset shape. */
export function claudeModelPresetDraftsToPresets(
  drafts: ClaudeModelPresetDraft[],
): ClaudeModelPreset[] {
  return drafts.map(draft => {
    const window = draft.contextWindow.trim() ? parseContextLimit(draft.contextWindow) : null;
    return {
      label: draft.label.trim(),
      model: draft.model.trim(),
      ...(window !== null ? { contextWindow: window } : {}),
    };
  });
}

function isValidStoredContextLimits(value: unknown): value is Record<string, number> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Preset windows are the editable truth for Claude model denominators, but the
 * existing readers (view, tabs, usage transform) consume the provider-neutral
 * customContextLimits map. Projects every preset window into that map and
 * removes entries for presets without a window, leaving foreign keys untouched.
 */
function projectModelPresetsToContextLimits(
  settings: Record<string, unknown>,
  presets: ClaudeModelPreset[],
): void {
  const current = isValidStoredContextLimits(settings.customContextLimits)
    ? { ...settings.customContextLimits }
    : {};

  for (const preset of presets) {
    if (isValidContextWindow(preset.contextWindow)) {
      current[preset.model] = preset.contextWindow;
    } else {
      delete current[preset.model];
    }
  }

  settings.customContextLimits = current;
}

export function getClaudeProviderSettings(
  settings: Record<string, unknown>,
): ClaudeProviderSettings {
  const config = getProviderConfig(settings, 'claude');
  const modelPresets = normalizeClaudeModelPresets(config.modelPresets)
    ?? migrateClaudeModelPresets(config, settings);

  return {
    safeMode: normalizeClaudeSafeMode(config.safeMode)
      ?? normalizeClaudeSafeMode(settings.claudeSafeMode)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.safeMode,
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
    safeMode: 'safeMode' in updates
      ? normalizeClaudeSafeMode(updates.safeMode) ?? current.safeMode
      : current.safeMode,
  };
  setProviderConfig(settings, 'claude', next);
  if ('modelPresets' in updates) {
    projectModelPresetsToContextLimits(settings, next.modelPresets);
  }
  return next;
}
