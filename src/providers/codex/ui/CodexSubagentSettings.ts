import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import { t } from '../../../i18n/i18n';
import type { TranslationKey } from '../../../i18n/types';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import type { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import { DEFAULT_CODEX_PRIMARY_MODEL } from '../types/models';
import type { CodexSubagentDefinition } from '../types/subagent';

// Labels are resolved via t() at render time so locale switches take effect.
const REASONING_EFFORT_OPTION_KEYS: Record<string, TranslationKey> = {
  '': 'settings.codex.subagents.options.inherit',
  'low': 'settings.codex.subagents.options.low',
  'medium': 'settings.codex.subagents.options.medium',
  'high': 'settings.codex.subagents.options.high',
  'xhigh': 'settings.codex.subagents.options.extraHigh',
};

const SANDBOX_MODE_OPTION_KEYS: Record<string, TranslationKey> = {
  '': 'settings.codex.subagents.options.inherit',
  'read-only': 'settings.codex.subagents.options.readOnly',
  'danger-full-access': 'settings.codex.subagents.options.dangerFullAccess',
  'workspace-write': 'settings.codex.subagents.options.workspaceWrite',
};

const MAX_NAME_LENGTH = 64;
const CODEX_AGENT_NAME_PATTERN = /^[a-z0-9_-]+$/;
const CODEX_NICKNAME_PATTERN = /^[A-Za-z0-9 _-]+$/;

export type CodexSubagentNameIssueCode = 'required' | 'tooLong' | 'invalidChars';
export type CodexNicknameIssueCode = 'invalidChars' | 'duplicate';

export interface CodexSubagentNameIssue {
  code: CodexSubagentNameIssueCode;
  /** Present when code === 'tooLong'. */
  max: number;
}

export interface CodexNicknameIssue {
  code: CodexNicknameIssueCode;
}

/** Locale-free validation outcome so the modal can map to i18n keys. */
export function getCodexSubagentNameIssue(name: string): CodexSubagentNameIssue | null {
  if (!name) return { code: 'required', max: MAX_NAME_LENGTH };
  if (name.length > MAX_NAME_LENGTH) return { code: 'tooLong', max: MAX_NAME_LENGTH };
  if (!CODEX_AGENT_NAME_PATTERN.test(name)) return { code: 'invalidChars', max: MAX_NAME_LENGTH };
  return null;
}

export function getCodexNicknameCandidatesIssue(candidates: string[]): CodexNicknameIssue | null {
  const normalized = candidates.map(candidate => candidate.trim()).filter(Boolean);
  if (normalized.length === 0) return null;

  const seen = new Set<string>();
  for (const candidate of normalized) {
    if (!CODEX_NICKNAME_PATTERN.test(candidate)) {
      return { code: 'invalidChars' };
    }

    const dedupeKey = candidate.toLowerCase();
    if (seen.has(dedupeKey)) {
      return { code: 'duplicate' };
    }
    seen.add(dedupeKey);
  }

  return null;
}

function formatCodexSubagentNameIssue(issue: CodexSubagentNameIssue): string {
  switch (issue.code) {
    case 'required': return t('settings.codex.subagents.validation.nameRequired');
    case 'tooLong': return t('settings.codex.subagents.validation.nameTooLong', { max: issue.max });
    case 'invalidChars': return t('settings.codex.subagents.validation.nameInvalid');
  }
}

function formatCodexNicknameIssue(issue: CodexNicknameIssue): string {
  switch (issue.code) {
    case 'invalidChars': return t('settings.codex.subagents.validation.nicknameInvalid');
    case 'duplicate': return t('settings.codex.subagents.validation.nicknameDuplicate');
  }
}

// Legacy English-string wrappers kept for existing callers and tests.
export function validateCodexSubagentName(name: string): string | null {
  const issue = getCodexSubagentNameIssue(name);
  if (!issue) return null;
  switch (issue.code) {
    case 'required': return 'Subagent name is required';
    case 'tooLong': return `Subagent name must be ${issue.max} characters or fewer`;
    case 'invalidChars': return 'Subagent name can only contain lowercase letters, numbers, hyphens, and underscores';
  }
}

export function validateCodexNicknameCandidates(candidates: string[]): string | null {
  const issue = getCodexNicknameCandidatesIssue(candidates);
  if (!issue) return null;
  switch (issue.code) {
    case 'invalidChars': return 'Nickname candidates can only contain ASCII letters, numbers, spaces, hyphens, and underscores';
    case 'duplicate': return 'Nickname candidates must be unique';
  }
}

/** Exposed for unit tests (mirrors CodexSkillModal). */
export class CodexSubagentModal extends Modal {
  private existing: CodexSubagentDefinition | null;
  private allAgents: CodexSubagentDefinition[];
  private onSave: (agent: CodexSubagentDefinition) => Promise<void>;

  private _nameInput!: HTMLInputElement;
  private _descInput!: HTMLInputElement;
  private _instructionsArea!: HTMLTextAreaElement;
  private _nicknamesInput!: HTMLInputElement;
  private _modelInput!: HTMLInputElement;
  private _reasoningEffort = '';
  private _sandboxMode = '';
  private _triggerSave!: () => Promise<void>;

  constructor(
    app: App,
    existing: CodexSubagentDefinition | null,
    allAgents: CodexSubagentDefinition[],
    onSave: (agent: CodexSubagentDefinition) => Promise<void>,
  ) {
    super(app);
    this.existing = existing;
    this.allAgents = allAgents;
    this.onSave = onSave;
    this._reasoningEffort = existing?.modelReasoningEffort ?? '';
    this._sandboxMode = existing?.sandboxMode ?? '';
  }

  getTestInputs() {
    return {
      nameInput: this._nameInput,
      descInput: this._descInput,
      instructionsArea: this._instructionsArea,
      nicknamesInput: this._nicknamesInput,
      modelInput: this._modelInput,
      setReasoningEffort: (v: string) => { this._reasoningEffort = v; },
      setSandboxMode: (v: string) => { this._sandboxMode = v; },
      triggerSave: this._triggerSave,
    };
  }

  onOpen() {
    this.setTitle(this.existing
      ? t('settings.codex.subagents.modal.titleEdit')
      : t('settings.codex.subagents.modal.titleAdd'));
    this.modalEl.addClass('claudian-sp-modal');

    const { contentEl } = this;

    new Setting(contentEl)
      .setName(t('settings.codex.subagents.modal.name'))
      .setDesc(t('settings.codex.subagents.modal.nameDesc'))
      .addText(text => {
        this._nameInput = text.inputEl;
        text.setValue(this.existing?.name ?? '')
          .setPlaceholder('code_reviewer');
      });

    new Setting(contentEl)
      .setName(t('settings.codex.subagents.modal.description'))
      .setDesc(t('settings.codex.subagents.modal.descriptionDesc'))
      .addText(text => {
        this._descInput = text.inputEl;
        text.setValue(this.existing?.description ?? '')
          .setPlaceholder(t('settings.codex.subagents.modal.descriptionPlaceholder'));
      });

    // Advanced options
    const details = contentEl.createEl('details', { cls: 'claudian-sp-advanced-section' });
    details.createEl('summary', {
      text: t('settings.codex.subagents.modal.advancedOptions'),
      cls: 'claudian-sp-advanced-summary',
    });
    if (
      this.existing?.model ||
      this.existing?.modelReasoningEffort ||
      this.existing?.sandboxMode ||
      this.existing?.nicknameCandidates?.length
    ) {
      details.open = true;
    }

    new Setting(details)
      .setName(t('settings.codex.subagents.modal.model'))
      .setDesc(t('settings.codex.subagents.modal.modelDesc'))
      .addText(text => {
        this._modelInput = text.inputEl;
        text.setValue(this.existing?.model ?? '')
          .setPlaceholder(DEFAULT_CODEX_PRIMARY_MODEL);
      });

    new Setting(details)
      .setName(t('settings.codex.subagents.modal.reasoningEffort'))
      .setDesc(t('settings.codex.subagents.modal.reasoningEffortDesc'))
      .addDropdown(dropdown => {
        for (const [value, key] of Object.entries(REASONING_EFFORT_OPTION_KEYS)) {
          dropdown.addOption(value, t(key));
        }
        dropdown.setValue(this._reasoningEffort);
        dropdown.onChange(v => { this._reasoningEffort = v; });
      });

    new Setting(details)
      .setName(t('settings.codex.subagents.modal.sandboxMode'))
      .setDesc(t('settings.codex.subagents.modal.sandboxModeDesc'))
      .addDropdown(dropdown => {
        for (const [value, key] of Object.entries(SANDBOX_MODE_OPTION_KEYS)) {
          dropdown.addOption(value, t(key));
        }
        dropdown.setValue(this._sandboxMode);
        dropdown.onChange(v => { this._sandboxMode = v; });
      });

    new Setting(details)
      .setName(t('settings.codex.subagents.modal.nicknames'))
      .setDesc(t('settings.codex.subagents.modal.nicknamesDesc'))
      .addText(text => {
        this._nicknamesInput = text.inputEl;
        text.setValue(this.existing?.nicknameCandidates?.join(', ') ?? '');
      });

    // Developer instructions
    new Setting(contentEl)
      .setName(t('settings.codex.subagents.modal.instructions'))
      .setDesc(t('settings.codex.subagents.modal.instructionsDesc'));

    const instructionsArea = contentEl.createEl('textarea', {
      cls: 'claudian-sp-content-area',
      attr: {
        rows: '10',
        placeholder: t('settings.codex.subagents.modal.instructionsPlaceholder'),
      },
    });
    instructionsArea.value = this.existing?.developerInstructions ?? '';
    this._instructionsArea = instructionsArea;

    // Buttons
    const doSave = async () => {
      const name = this._nameInput.value.trim();
      const nameIssue = getCodexSubagentNameIssue(name);
      if (nameIssue) {
        new Notice(formatCodexSubagentNameIssue(nameIssue));
        return;
      }

      const description = this._descInput.value.trim();
      if (!description) {
        new Notice(t('settings.codex.subagents.validation.descriptionRequired'));
        return;
      }

      const developerInstructions = this._instructionsArea.value;
      if (!developerInstructions.trim()) {
        new Notice(t('settings.codex.subagents.validation.instructionsRequired'));
        return;
      }

      const nicknameCandidates = this._nicknamesInput.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const nicknameIssue = getCodexNicknameCandidatesIssue(nicknameCandidates);
      if (nicknameIssue) {
        new Notice(formatCodexNicknameIssue(nicknameIssue));
        return;
      }

      const duplicate = this.allAgents.find(
        a => a.name.toLowerCase() === name.toLowerCase() &&
             a.persistenceKey !== this.existing?.persistenceKey,
      );
      if (duplicate) {
        new Notice(t('settings.codex.subagents.validation.duplicateName', { name }));
        return;
      }

      const agent: CodexSubagentDefinition = {
        name,
        description,
        developerInstructions,
        nicknameCandidates: nicknameCandidates.length > 0 ? nicknameCandidates : undefined,
        model: this._modelInput.value.trim() || undefined,
        modelReasoningEffort: this._reasoningEffort || undefined,
        sandboxMode: this._sandboxMode || undefined,
        persistenceKey: this.existing?.persistenceKey,
        extraFields: this.existing?.extraFields,
      };

      try {
        await this.onSave(agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('common.unknownError');
        new Notice(t('settings.codex.subagents.saveFailed', { message }));
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

export class CodexSubagentSettings {
  private containerEl: HTMLElement;
  private storage: CodexSubagentStorage;
  private agents: CodexSubagentDefinition[] = [];
  private app?: App;
  private onChanged?: () => void;

  constructor(containerEl: HTMLElement, storage: CodexSubagentStorage, app?: App, onChanged?: () => void) {
    this.containerEl = containerEl;
    this.storage = storage;
    this.app = app;
    this.onChanged = onChanged;
    this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    try {
      this.agents = await this.storage.loadAll();
    } catch {
      this.agents = [];
    }

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-sp-header' });
    headerEl.createSpan({ text: t('settings.codex.subagents.name'), cls: 'claudian-sp-label' });

    const actionsEl = headerEl.createDiv({ cls: 'claudian-sp-header-actions' });

    const refreshBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.refresh') },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => { void this.render(); });

    const addBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.add') },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openModal(null));

    if (this.agents.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
      emptyEl.setText(t('settings.codex.subagents.noAgents'));
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-sp-list' });
    for (const agent of this.agents) {
      this.renderItem(listEl, agent);
    }
  }

  private renderItem(listEl: HTMLElement, agent: CodexSubagentDefinition): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-sp-item' });
    const infoEl = itemEl.createDiv({ cls: 'claudian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-sp-item-header' });
    const nameEl = headerRow.createSpan({ cls: 'claudian-sp-item-name' });
    nameEl.setText(agent.name);

    if (agent.model) {
      headerRow.createSpan({ text: agent.model, cls: 'claudian-slash-item-badge' });
    }

    if (agent.description) {
      const descEl = infoEl.createDiv({ cls: 'claudian-sp-item-desc' });
      descEl.setText(agent.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'claudian-sp-item-actions' });

    const editBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.edit') },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openModal(agent));

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
      attr: { 'aria-label': t('common.delete') },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', async () => {
      if (!this.app) return;
      const confirmed = await confirmDelete(
        this.app,
        t('settings.codex.subagents.deleteConfirm', { name: agent.name }),
      );
      if (!confirmed) return;
      try {
        await this.storage.delete(agent);
        await this.render();
        this.onChanged?.();
        new Notice(t('settings.codex.subagents.deleted', { name: agent.name }));
      } catch {
        new Notice(t('settings.codex.subagents.deleteFailed'));
      }
    });
  }

  private openModal(existing: CodexSubagentDefinition | null): void {
    if (!this.app) return;

    const modal = new CodexSubagentModal(
      this.app,
      existing,
      this.agents,
      async (agent) => {
        await this.storage.save(agent, existing);
        await this.render();
        this.onChanged?.();
        new Notice(
          existing
            ? t('settings.codex.subagents.updated', { name: agent.name })
            : t('settings.codex.subagents.created', { name: agent.name }),
        );
      },
    );
    modal.open();
  }
}
