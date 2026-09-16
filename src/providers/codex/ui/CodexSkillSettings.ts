import { Modal, Notice, setIcon, Setting } from 'obsidian';

import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import { t } from '../../../i18n/i18n';
import { getCommandNameIssue, type SlugNameIssue } from '../../../utils/slashCommand';
import {
  CODEX_SKILL_ROOT_OPTIONS,
  type CodexSkillRootId,
  createCodexSkillPersistenceKey,
  parseCodexSkillPersistenceKey,
} from '../storage/CodexSkillStorage';

function formatSkillNameIssue(issue: SlugNameIssue): string {
  switch (issue.code) {
    case 'required': return t('settings.codex.skills.validation.nameRequired');
    case 'tooLong': return t('settings.codex.skills.validation.nameTooLong', { max: issue.max });
    case 'invalidChars': return t('settings.codex.skills.validation.nameInvalid');
    case 'reserved': return t('settings.codex.skills.validation.nameReserved');
  }
}

export class CodexSkillModal extends Modal {
  private existing: ProviderCommandEntry | null;
  private onSave: (entry: ProviderCommandEntry) => Promise<void>;

  private _nameInput!: HTMLInputElement;
  private _descInput!: HTMLInputElement;
  private _contentArea!: HTMLTextAreaElement;
  private _selectedRootId: CodexSkillRootId;
  private _triggerSave!: () => Promise<void>;

  constructor(
    app: any,
    existing: ProviderCommandEntry | null,
    onSave: (entry: ProviderCommandEntry) => Promise<void>
  ) {
    super(app);
    this.existing = existing;
    this.onSave = onSave;
    this._selectedRootId = parseCodexSkillPersistenceKey(existing?.persistenceKey)?.rootId ?? 'vault-codex';
  }

  /** Exposed for unit tests only. */
  getTestInputs() {
    return {
      nameInput: this._nameInput,
      descInput: this._descInput,
      contentArea: this._contentArea,
      setDirectory: (rootId: CodexSkillRootId) => { this._selectedRootId = rootId; },
      triggerSave: this._triggerSave,
    };
  }

  onOpen() {
    this.setTitle(this.existing
      ? t('settings.codex.skills.modal.titleEdit')
      : t('settings.codex.skills.modal.titleAdd'));
    this.modalEl.addClass('claudian-sp-modal');

    const { contentEl } = this;

    new Setting(contentEl)
      .setName(t('settings.codex.skills.modal.directory'))
      .setDesc(t('settings.codex.skills.modal.directoryDesc'))
      .addDropdown(dropdown => {
        for (const opt of CODEX_SKILL_ROOT_OPTIONS) {
          dropdown.addOption(opt.id, opt.label);
        }
        dropdown.setValue(this._selectedRootId);
        dropdown.onChange(value => { this._selectedRootId = value as CodexSkillRootId; });
      });

    new Setting(contentEl)
      .setName(t('settings.codex.skills.modal.name'))
      .setDesc(t('settings.codex.skills.modal.nameDesc'))
      .addText(text => {
        this._nameInput = text.inputEl;
        text.setValue(this.existing?.name || '')
          .setPlaceholder('analyze-code');
      });

    new Setting(contentEl)
      .setName(t('settings.codex.skills.modal.description'))
      .setDesc(t('settings.codex.skills.modal.descriptionDesc'))
      .addText(text => {
        this._descInput = text.inputEl;
        text.setValue(this.existing?.description || '');
      });

    new Setting(contentEl)
      .setName(t('settings.codex.skills.modal.instructions'))
      .setDesc(t('settings.codex.skills.modal.instructionsDesc'));

    const contentArea = contentEl.createEl('textarea', {
      cls: 'claudian-sp-content-area',
      attr: { rows: '10', placeholder: t('settings.codex.skills.modal.instructionsPlaceholder') },
    });
    contentArea.value = this.existing?.content || '';
    this._contentArea = contentArea as HTMLTextAreaElement;

    const doSave = async () => {
      const name = this._nameInput.value.trim();
      const nameIssue = getCommandNameIssue(name);
      if (nameIssue) {
        new Notice(formatSkillNameIssue(nameIssue));
        return;
      }

      const content = this._contentArea.value;
      if (!content.trim()) {
        new Notice(t('settings.codex.skills.validation.instructionsRequired'));
        return;
      }

      const entry: ProviderCommandEntry = {
        id: this.existing?.id || `codex-skill-${name}`,
        providerId: 'codex',
        kind: 'skill',
        name,
        description: this._descInput.value.trim() || undefined,
        content,
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '$',
        insertPrefix: '$',
        persistenceKey: createCodexSkillPersistenceKey({
          rootId: this._selectedRootId,
          ...(this.existing?.name ? { currentName: this.existing.name } : {}),
        }),
      };

      try {
        await this.onSave(entry);
      } catch {
        new Notice(t('settings.codex.skills.saveFailed'));
        return;
      }
      this.close();
    };
    this._triggerSave = doSave;

    const buttonContainer = contentEl.createDiv({ cls: 'claudian-sp-modal-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: t('common.cancel'),
      cls: 'claudian-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: t('common.save'),
      cls: 'claudian-save-btn',
    });
    saveBtn.addEventListener('click', doSave);
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class CodexSkillSettings {
  private containerEl: HTMLElement;
  private catalog: ProviderCommandCatalog;
  private entries: ProviderCommandEntry[] = [];
  private app?: any;

  constructor(containerEl: HTMLElement, catalog: ProviderCommandCatalog, app?: any) {
    this.containerEl = containerEl;
    this.catalog = catalog;
    this.app = app;
    this.render();
  }

  async deleteEntry(entry: ProviderCommandEntry): Promise<void> {
    await this.catalog.deleteVaultEntry(entry);
    await this.render();
  }

  async refresh(): Promise<void> {
    await this.catalog.refresh();
    await this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    try {
      this.entries = await this.catalog.listVaultEntries();
    } catch {
      this.entries = [];
    }

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-sp-header' });
    headerEl.createSpan({ text: t('settings.codex.skills.name'), cls: 'claudian-sp-label' });

    const actionsEl = headerEl.createDiv({ cls: 'claudian-sp-header-actions' });
    const refreshBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.refresh') },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => { void this.refresh(); });

    const addBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.add') },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openModal(null));

    if (this.entries.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
      emptyEl.setText(t('settings.codex.skills.noSkills'));
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-sp-list' });
    for (const entry of this.entries) {
      this.renderItem(listEl, entry);
    }
  }

  private renderItem(listEl: HTMLElement, entry: ProviderCommandEntry): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-sp-item' });
    const infoEl = itemEl.createDiv({ cls: 'claudian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-sp-item-header' });
    const nameEl = headerRow.createSpan({ cls: 'claudian-sp-item-name' });
    nameEl.setText(`$${entry.name}`);
    headerRow.createSpan({ text: t('settings.codex.skills.badge'), cls: 'claudian-slash-item-badge' });

    if (entry.description) {
      const descEl = infoEl.createDiv({ cls: 'claudian-sp-item-desc' });
      descEl.setText(entry.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'claudian-sp-item-actions' });

    if (entry.isEditable) {
      const editBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn',
        attr: { 'aria-label': t('common.edit') },
      });
      setIcon(editBtn, 'pencil');
      editBtn.addEventListener('click', () => this.openModal(entry));
    }

    if (entry.isDeletable) {
      const deleteBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
        attr: { 'aria-label': t('common.delete') },
      });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.addEventListener('click', async () => {
        try {
          await this.deleteEntry(entry);
          new Notice(t('settings.codex.skills.deleted', { name: entry.name }));
        } catch {
          new Notice(t('settings.codex.skills.deleteFailed'));
        }
      });
    }
  }

  private openModal(existing: ProviderCommandEntry | null): void {
    if (!this.app) return;

    const modal = new CodexSkillModal(
      this.app,
      existing,
      async (entry) => {
        await this.catalog.saveVaultEntry(entry);
        await this.render();
        new Notice(existing
          ? t('settings.codex.skills.updated', { name: entry.name })
          : t('settings.codex.skills.created', { name: entry.name }));
      }
    );
    modal.open();
  }
}
