import { t } from '../../../i18n/i18n';
import { formatContextLimit } from '../../../utils/env';
import {
  type ClaudeModelPreset,
  type ClaudeModelPresetDraft,
  claudeModelPresetDraftsToPresets,
  DEFAULT_CLAUDE_MODEL_PRESETS,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
  validateClaudeModelPresetDrafts,
} from '../settings';

interface PresetRow {
  draft: ClaudeModelPresetDraft;
  /** Model value as of the last successful commit; drives rename migration. */
  committedModel: string;
  rowEl: HTMLElement;
  errorEl: HTMLElement;
  labelInput: HTMLInputElement;
  modelInput: HTMLInputElement;
  windowInput: HTMLInputElement;
}

export interface ModelPresetEditorOptions {
  /** Mutable plugin settings bag. */
  getSettings: () => Record<string, unknown>;
  saveSettings: () => Promise<void>;
  refreshModelSelectors: () => void;
  /** Runs after presets are written (and current-model renames applied). */
  onModelOptionsChanged: () => void;
}

function presetToDraft(preset: ClaudeModelPreset): ClaudeModelPresetDraft {
  return {
    label: preset.label,
    model: preset.model,
    contextWindow: preset.contextWindow !== undefined
      ? formatContextLimit(preset.contextWindow)
      : '',
  };
}

function samePresets(a: ClaudeModelPreset[], b: ClaudeModelPreset[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Sortable preset row editor. Commits are atomic: the whole array is validated
 * first (row-level errors block the save), then written together with the
 * current-model / title-model / last-model rename migration.
 */
export class ModelPresetSettings {
  private rows: PresetRow[] = [];
  private committedPresets: ClaudeModelPreset[];
  private readonly listEl: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly options: ModelPresetEditorOptions,
  ) {
    const claudeSettings = getClaudeProviderSettings(this.options.getSettings());
    this.committedPresets = claudeSettings.modelPresets.map(preset => ({ ...preset }));

    this.listEl = container.createDiv({ cls: 'claudian-model-preset-list' });
    for (const preset of this.committedPresets) {
      this.addRow(presetToDraft(preset));
    }

    const actionsEl = container.createDiv({ cls: 'claudian-model-preset-actions' });
    actionsEl.createEl('button', {
      text: t('settings.modelPresets.add'),
      cls: 'claudian-model-preset-add',
    }).addEventListener('click', () => {
      this.addRow({ label: '', model: '', contextWindow: '' });
    });

    actionsEl.createEl('button', {
      text: t('settings.modelPresets.reset'),
      cls: 'claudian-model-preset-reset',
    }).addEventListener('click', () => {
      this.resetToDefaults();
    });
  }

  private addRow(draft: ClaudeModelPresetDraft): void {
    const rowEl = this.listEl.createDiv({ cls: 'claudian-model-preset-row' });

    const labelInput = rowEl.createEl('input', {
      type: 'text',
      cls: 'claudian-model-preset-label',
      placeholder: t('settings.modelPresets.labelPlaceholder'),
      value: draft.label,
    }) as HTMLInputElement;
    const modelInput = rowEl.createEl('input', {
      type: 'text',
      cls: 'claudian-model-preset-model',
      placeholder: t('settings.modelPresets.modelPlaceholder'),
      value: draft.model,
    }) as HTMLInputElement;
    const windowInput = rowEl.createEl('input', {
      type: 'text',
      cls: 'claudian-model-preset-window',
      placeholder: t('settings.modelPresets.windowPlaceholder'),
      value: draft.contextWindow,
    }) as HTMLInputElement;

    const moveUp = rowEl.createEl('button', {
      text: '↑',
      cls: 'claudian-model-preset-move-up',
      attr: { 'aria-label': t('settings.modelPresets.moveUp') },
    });
    const moveDown = rowEl.createEl('button', {
      text: '↓',
      cls: 'claudian-model-preset-move-down',
      attr: { 'aria-label': t('settings.modelPresets.moveDown') },
    });
    const remove = rowEl.createEl('button', {
      text: '✕',
      cls: 'claudian-model-preset-remove',
      attr: { 'aria-label': t('settings.modelPresets.remove') },
    });

    const errorEl = rowEl.createDiv({ cls: 'claudian-model-preset-error' });
    errorEl.style.display = 'none';

    const row: PresetRow = {
      draft: { ...draft },
      committedModel: draft.model.trim(),
      rowEl,
      errorEl,
      labelInput,
      modelInput,
      windowInput,
    };
    this.rows.push(row);

    const commit = (): void => { void this.commit(); };
    for (const input of [labelInput, modelInput, windowInput]) {
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          commit();
        }
      });
    }

    moveUp.addEventListener('click', () => this.moveRow(row, -1));
    moveDown.addEventListener('click', () => this.moveRow(row, 1));
    remove.addEventListener('click', () => this.removeRow(row));
  }

  private moveRow(row: PresetRow, delta: number): void {
    const index = this.rows.indexOf(row);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this.rows.length) {
      return;
    }

    this.rows.splice(target, 0, this.rows.splice(index, 1)[0]);
    // DOM order mirrors the rows array; moving existing nodes keeps
    // in-progress edits alive.
    for (const candidate of this.rows) {
      this.listEl.appendChild(candidate.rowEl);
    }
  }

  private removeRow(row: PresetRow): void {
    // Keep at least one preset: an empty list would dead-end the selector.
    if (this.rows.length <= 1) {
      return;
    }

    this.rows = this.rows.filter(candidate => candidate !== row);
    this.listEl.removeChild(row.rowEl);
    void this.commit();
  }

  private resetToDefaults(): void {
    for (const row of this.rows) {
      this.listEl.removeChild(row.rowEl);
    }
    this.rows = [];
    for (const preset of DEFAULT_CLAUDE_MODEL_PRESETS) {
      this.addRow(presetToDraft({ ...preset }));
    }
    void this.commit();
  }

  private showError(row: PresetRow, errorKey: string): void {
    row.errorEl.setText(t(errorKey as never));
    row.errorEl.style.display = 'block';
  }

  private async commit(): Promise<void> {
    const drafts = this.rows.map(row => ({
      label: row.labelInput.value,
      model: row.modelInput.value,
      contextWindow: row.windowInput.value,
    }));
    const errors = validateClaudeModelPresetDrafts(drafts);

    let hasError = false;
    this.rows.forEach((row, index) => {
      if (errors[index]) {
        hasError = true;
        this.showError(row, errors[index] as string);
      } else {
        row.errorEl.style.display = 'none';
      }
    });
    if (hasError) {
      return;
    }

    const presets = claudeModelPresetDraftsToPresets(drafts);
    if (samePresets(presets, this.committedPresets)) {
      this.syncRowState();
      return;
    }

    // Rename migration: a row whose model id changed carries the current
    // selection (model / title model / last model) over to the new id.
    const renames = new Map<string, string>();
    for (const row of this.rows) {
      const committed = row.committedModel;
      const next = row.modelInput.value.trim();
      if (committed && next && committed !== next) {
        renames.set(committed, next);
      }
    }

    const settings = this.options.getSettings();
    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    if (currentModel && renames.has(currentModel)) {
      settings.model = renames.get(currentModel);
    }
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    if (titleModel && renames.has(titleModel)) {
      settings.titleGenerationModel = renames.get(titleModel);
    }

    const lastModel = getClaudeProviderSettings(settings).lastModel;
    const lastModelUpdate = lastModel && renames.has(lastModel)
      ? { lastModel: renames.get(lastModel) as string }
      : {};

    updateClaudeProviderSettings(settings, {
      modelPresets: presets,
      ...lastModelUpdate,
    });

    this.committedPresets = presets;
    this.options.onModelOptionsChanged();
    await this.options.saveSettings();
    this.options.refreshModelSelectors();
    this.syncRowState();
  }

  private syncRowState(): void {
    for (const row of this.rows) {
      row.draft = {
        label: row.labelInput.value,
        model: row.modelInput.value,
        contextWindow: row.windowInput.value,
      };
      row.committedModel = row.modelInput.value.trim();
    }
  }
}
