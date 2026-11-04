import { parseContextLimit } from '../../utils/env';

/** Editable model tier shown in a provider's model selector. */
export interface ModelPreset {
  label: string;
  model: string;
  contextWindow?: number;
}

/** Editable draft shape used by the settings UI before parsing the window input. */
export interface ModelPresetDraft {
  label: string;
  model: string;
  contextWindow: string;
}

/**
 * Provider adapter for the shared preset editor: every provider difference
 * (storage, factory defaults, rename follow-through, editor copy) lives here
 * so the component itself stays provider-neutral.
 */
export interface ModelPresetEditorBinding {
  /** i18n key prefix for provider-specific editor copy (placeholders, reset). */
  i18nPrefix: string;
  getPresets(settings: Record<string, unknown>): ModelPreset[];
  /** Persists the whole preset array in one provider-settings update. */
  commitPresets(settings: Record<string, unknown>, presets: ModelPreset[]): void;
  /** Fresh copies of the provider's factory presets (reset button). */
  resetPresets(): ModelPreset[];
  /** Carries selection / title / saved-model state over renamed model ids. */
  applyRenames(settings: Record<string, unknown>, renames: Map<string, string>): void;
}

function isValidContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidStoredContextLimits(value: unknown): value is Record<string, number> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes stored presets: trims fields, drops invalid rows, keeps the first
 * row per model id. Returns null when no usable preset survives, so callers
 * fall through to the legacy migration (or defaults).
 */
export function normalizeModelPresets(value: unknown): ModelPreset[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const presets: ModelPreset[] = [];
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

/** Parses the retired custom-model textarea format into deduped model ids. */
export function parseLegacyCustomModelIds(value: unknown): string[] {
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
 * Carries legacy customContextLimits entries into migrated presets, so the
 * window projection cannot silently drop them on the migration write-back.
 */
export function importLegacyContextLimits(
  presets: ModelPreset[],
  customContextLimits: unknown,
): void {
  if (!isValidStoredContextLimits(customContextLimits)) {
    return;
  }

  for (const preset of presets) {
    const limit = customContextLimits[preset.model];
    if (isValidContextWindow(limit)) {
      preset.contextWindow = limit;
    }
  }
}

/**
 * Row-level validation for the settings editor. Returns one i18n error key per
 * draft (null = valid); the caller blocks the whole commit when any row fails.
 */
export function validateModelPresetDrafts(
  drafts: ModelPresetDraft[],
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
export function modelPresetDraftsToPresets(
  drafts: ModelPresetDraft[],
): ModelPreset[] {
  return drafts.map(draft => {
    const window = draft.contextWindow.trim() ? parseContextLimit(draft.contextWindow) : null;
    return {
      label: draft.label.trim(),
      model: draft.model.trim(),
      ...(window !== null ? { contextWindow: window } : {}),
    };
  });
}

/**
 * Preset windows are the editable truth for model denominators, but existing
 * readers (view, tabs, usage transform) consume the provider-neutral
 * customContextLimits map. Projects every preset window into that map and
 * removes entries for presets without a window, leaving foreign keys
 * untouched.
 */
export function projectModelPresetsToContextLimits(
  currentLimits: unknown,
  presets: ModelPreset[],
): Record<string, number> {
  const current = isValidStoredContextLimits(currentLimits)
    ? { ...currentLimits }
    : {};

  for (const preset of presets) {
    if (isValidContextWindow(preset.contextWindow)) {
      current[preset.model] = preset.contextWindow;
    } else {
      delete current[preset.model];
    }
  }

  return current;
}
