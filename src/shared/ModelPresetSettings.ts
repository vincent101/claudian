import {
  type ModelPreset,
  type ModelPresetDraft,
  modelPresetDraftsToPresets,
  type ModelPresetEditorBinding,
  validateModelPresetDrafts,
} from '../core/providers/modelPresets';
import { t } from '../i18n/i18n';
import { formatContextLimit } from '../utils/env';

interface PresetRow {
  draft: ModelPresetDraft;
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
  /** Provider adapter: storage, factory defaults, rename follow-through. */
  binding: ModelPresetEditorBinding;
}

function presetToDraft(preset: ModelPreset): ModelPresetDraft {
  return {
    label: preset.label,
    model: preset.model,
    contextWindow: preset.contextWindow !== undefined
      ? formatContextLimit(preset.contextWindow)
      : '',
  };
}

function samePresets(a: ModelPreset[], b: ModelPreset[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Sortable preset row editor. Commits are atomic: the whole array is validated
 * first (row-level errors block the save), then written together with the
 * current-model / title-model rename migration. Provider specifics (storage,
 * defaults, rename targets, copy) all come from the injected binding.
 */
export class ModelPresetSettings {
  private rows: PresetRow[] = [];
  private committedPresets: ModelPreset[];
  private readonly listEl: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly options: ModelPresetEditorOptions,
  ) {
    this.committedPresets = this.options.binding
      .getPresets(this.options.getSettings())
      .map(preset => ({ ...preset }));

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
      text: this.tProvider('reset'),
      cls: 'claudian-model-preset-reset',
    }).addEventListener('click', () => {
      this.resetToDefaults();
    });
  }

  /** Provider-specific editor copy (placeholders, reset) via the binding prefix. */
  private tProvider(key: 'labelPlaceholder' | 'modelPlaceholder' | 'windowPlaceholder' | 'reset'): string {
    return t(`${this.options.binding.i18nPrefix}.${key}` as never);
  }

  private addRow(draft: ModelPresetDraft): void {
    const rowEl = this.listEl.createDiv({ cls: 'claudian-model-preset-row' });

    const labelInput = rowEl.createEl('input', {
      type: 'text',
      cls: 'claudian-model-preset-label',
      placeholder: this.tProvider('labelPlaceholder'),
      value: draft.label,
    }) as HTMLInputElement;
    const modelInput = rowEl.createEl('input', {
      type: 'text',
      cls: 'claudian-model-preset-model',
      placeholder: this.tProvider('modelPlaceholder'),
      value: draft.model,
    }) as HTMLInputElement;
    const windowInput = rowEl.createEl('input', {
      type: 'text',
      cls: 'claudian-model-preset-window',
      placeholder: this.tProvider('windowPlaceholder'),
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
    for (const preset of this.options.binding.resetPresets()) {
      this.addRow(presetToDraft(preset));
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
    const errors = validateModelPresetDrafts(drafts);

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

    const presets = modelPresetDraftsToPresets(drafts);
    if (samePresets(presets, this.committedPresets)) {
      this.syncRowState();
      return;
    }

    // Rename migration: a row whose model id changed carries the current
    // selection (model / title model / provider saved state) over to the new
    // id, via the binding.
    const renames = new Map<string, string>();
    for (const row of this.rows) {
      const committed = row.committedModel;
      const next = row.modelInput.value.trim();
      if (committed && next && committed !== next) {
        renames.set(committed, next);
      }
    }

    const settings = this.options.getSettings();
    this.options.binding.applyRenames(settings, renames);
    this.options.binding.commitPresets(settings, presets);

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
