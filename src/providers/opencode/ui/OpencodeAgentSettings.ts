import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import { t } from '../../../i18n/i18n';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import type { OpencodeAgentStorage } from '../storage/OpencodeAgentStorage';
import type { OpencodeAgentDefinition } from '../types/agent';

const OPENCODE_AGENT_INVALID_SEGMENT_PATTERN = /[<>:"\\|?*]/;

export type OpencodeAgentNameIssueCode =
  | 'required'
  | 'pathSegments'
  | 'segmentEmpty'
  | 'segmentWhitespace'
  | 'dotSegment'
  | 'reservedCharacter';

export interface OpencodeAgentNameIssue {
  code: OpencodeAgentNameIssueCode;
}

/** Locale-free validation outcome so the modal can map to i18n keys. */
export function getOpencodeAgentNameIssue(name: string): OpencodeAgentNameIssue | null {
  if (!name) return { code: 'required' };

  const segments = name.split('/');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return { code: 'pathSegments' };
  }

  for (const segment of segments) {
    if (!segment.trim()) {
      return { code: 'segmentEmpty' };
    }

    if (segment !== segment.trim()) {
      return { code: 'segmentWhitespace' };
    }

    if (segment === '.' || segment === '..') {
      return { code: 'dotSegment' };
    }

    if (segment.includes('\0') || OPENCODE_AGENT_INVALID_SEGMENT_PATTERN.test(segment)) {
      return { code: 'reservedCharacter' };
    }
  }

  return null;
}

// Legacy English-string wrapper kept for existing callers and tests.
export function validateOpencodeAgentName(name: string): string | null {
  const issue = getOpencodeAgentNameIssue(name);
  if (!issue) return null;
  switch (issue.code) {
    case 'required': return 'Agent name is required';
    case 'pathSegments': return 'Agent name must use slash-separated path segments without leading or trailing slashes';
    case 'segmentEmpty': return 'Agent name path segments cannot be empty or whitespace-only';
    case 'segmentWhitespace': return 'Agent name path segments cannot start or end with whitespace';
    case 'dotSegment': return 'Agent name cannot include "." or ".." path segments';
    case 'reservedCharacter': return 'Agent name path segments cannot contain Windows-reserved filename characters';
  }
}

function formatOpencodeAgentNameIssue(issue: OpencodeAgentNameIssue): string {
  switch (issue.code) {
    case 'required': return t('settings.opencode.subagents.validation.nameRequired');
    case 'pathSegments': return t('settings.opencode.subagents.validation.namePath');
    case 'segmentEmpty': return t('settings.opencode.subagents.validation.segmentEmpty');
    case 'segmentWhitespace': return t('settings.opencode.subagents.validation.segmentWhitespace');
    case 'dotSegment': return t('settings.opencode.subagents.validation.dotSegment');
    case 'reservedCharacter': return t('settings.opencode.subagents.validation.reservedCharacter');
  }
}

export function findOpencodeAgentNameConflict(
  agents: OpencodeAgentDefinition[],
  name: string,
  currentPersistenceKey?: string,
): OpencodeAgentDefinition | null {
  const normalizedName = name.toLowerCase();
  return agents.find(
    (agent) => agent.name.toLowerCase() === normalizedName
      && agent.persistenceKey !== currentPersistenceKey,
  ) ?? null;
}

class OpencodeAgentModal extends Modal {
  private existing: OpencodeAgentDefinition | null;
  private allAgents: OpencodeAgentDefinition[];
  private onSave: (agent: OpencodeAgentDefinition) => Promise<void>;

  constructor(
    app: App,
    existing: OpencodeAgentDefinition | null,
    allAgents: OpencodeAgentDefinition[],
    onSave: (agent: OpencodeAgentDefinition) => Promise<void>,
  ) {
    super(app);
    this.existing = existing;
    this.allAgents = allAgents;
    this.onSave = onSave;
  }

  onOpen() {
    this.setTitle(this.existing
      ? t('settings.opencode.subagents.modal.titleEdit')
      : t('settings.opencode.subagents.modal.titleAdd'));
    this.modalEl.addClass('claudian-sp-modal');

    const { contentEl } = this;

    let nameInput!: HTMLInputElement;
    let descriptionInput!: HTMLInputElement;
    let modelInput!: HTMLInputElement;
    let variantInput!: HTMLInputElement;
    let temperatureInput!: HTMLInputElement;
    let topPInput!: HTMLInputElement;
    let colorInput!: HTMLInputElement;
    let stepsInput!: HTMLInputElement;
    let hiddenValue = this.existing?.hidden ?? false;
    let disableValue = this.existing?.disable ?? false;
    let toolsInput!: HTMLTextAreaElement;
    let permissionInput!: HTMLTextAreaElement;
    let optionsInput!: HTMLTextAreaElement;

    new Setting(contentEl)
      .setName(t('settings.opencode.subagents.modal.name'))
      .setDesc(t('settings.opencode.subagents.modal.nameDesc'))
      .addText((text) => {
        nameInput = text.inputEl;
        text.setValue(this.existing?.name ?? '')
          .setPlaceholder('review');
      });

    new Setting(contentEl)
      .setName(t('settings.opencode.subagents.modal.description'))
      .setDesc(t('settings.opencode.subagents.modal.descriptionDesc'))
      .addText((text) => {
        descriptionInput = text.inputEl;
        text.setValue(this.existing?.description ?? '')
          .setPlaceholder(t('settings.opencode.subagents.modal.descriptionPlaceholder'));
      });

    const details = contentEl.createEl('details', { cls: 'claudian-sp-advanced-section' });
    details.createEl('summary', {
      text: t('settings.opencode.subagents.modal.advancedOptions'),
      cls: 'claudian-sp-advanced-summary',
    });
    if (
      this.existing?.model ||
      this.existing?.variant ||
      this.existing?.temperature !== undefined ||
      this.existing?.topP !== undefined ||
      this.existing?.color ||
      this.existing?.steps !== undefined ||
      this.existing?.hidden ||
      this.existing?.disable ||
      this.existing?.tools ||
      this.existing?.permission !== undefined ||
      this.existing?.options
    ) {
      details.open = true;
    }

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.model'))
      .setDesc(t('settings.opencode.subagents.modal.modelDesc'))
      .addText((text) => {
        modelInput = text.inputEl;
        text.setValue(this.existing?.model ?? '')
          .setPlaceholder('anthropic/claude-sonnet-4-20250514');
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.variant'))
      .setDesc(t('settings.opencode.subagents.modal.variantDesc'))
      .addText((text) => {
        variantInput = text.inputEl;
        text.setValue(this.existing?.variant ?? '')
          .setPlaceholder('high');
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.temperature'))
      .setDesc(t('settings.opencode.subagents.modal.temperatureDesc'))
      .addText((text) => {
        temperatureInput = text.inputEl;
        text.setValue(this.existing?.temperature !== undefined ? String(this.existing.temperature) : '')
          .setPlaceholder('0.1');
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.topP'))
      .setDesc(t('settings.opencode.subagents.modal.topPDesc'))
      .addText((text) => {
        topPInput = text.inputEl;
        text.setValue(this.existing?.topP !== undefined ? String(this.existing.topP) : '')
          .setPlaceholder('0.9');
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.color'))
      .setDesc(t('settings.opencode.subagents.modal.colorDesc'))
      .addText((text) => {
        colorInput = text.inputEl;
        text.setValue(this.existing?.color ?? '')
          .setPlaceholder('#FF5733');
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.steps'))
      .setDesc(t('settings.opencode.subagents.modal.stepsDesc'))
      .addText((text) => {
        stepsInput = text.inputEl;
        text.setValue(this.existing?.steps !== undefined ? String(this.existing.steps) : '')
          .setPlaceholder('10');
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.hide'))
      .setDesc(t('settings.opencode.subagents.modal.hideDesc'))
      .addToggle((toggle) => {
        toggle.setValue(hiddenValue).onChange((value) => {
          hiddenValue = value;
        });
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.disable'))
      .setDesc(t('settings.opencode.subagents.modal.disableDesc'))
      .addToggle((toggle) => {
        toggle.setValue(disableValue).onChange((value) => {
          disableValue = value;
        });
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.tools'))
      .setDesc(t('settings.opencode.subagents.modal.toolsDesc'))
      .addTextArea((text) => {
        toolsInput = text.inputEl;
        text.setValue(this.existing?.tools ? JSON.stringify(this.existing.tools, null, 2) : '')
          .setPlaceholder('{\n  "write": false,\n  "edit": false\n}');
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.permission'))
      .setDesc(t('settings.opencode.subagents.modal.permissionDesc'))
      .addTextArea((text) => {
        permissionInput = text.inputEl;
        text.setValue(this.existing?.permission !== undefined ? JSON.stringify(this.existing.permission, null, 2) : '')
          .setPlaceholder('{\n  "edit": "deny"\n}');
      });

    new Setting(details)
      .setName(t('settings.opencode.subagents.modal.options'))
      .setDesc(t('settings.opencode.subagents.modal.optionsDesc'))
      .addTextArea((text) => {
        optionsInput = text.inputEl;
        text.setValue(this.existing?.options ? JSON.stringify(this.existing.options, null, 2) : '')
          .setPlaceholder('{\n  "focus": "security"\n}');
      });

    new Setting(contentEl)
      .setName(t('settings.opencode.subagents.modal.prompt'))
      .setDesc(t('settings.opencode.subagents.modal.promptDesc'));

    const promptArea = contentEl.createEl('textarea', {
      cls: 'claudian-sp-content-area',
      attr: {
        rows: '10',
        placeholder: t('settings.opencode.subagents.modal.promptPlaceholder'),
      },
    });
    promptArea.value = this.existing?.prompt ?? '';

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
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const nameIssue = getOpencodeAgentNameIssue(name);
      if (nameIssue) {
        new Notice(formatOpencodeAgentNameIssue(nameIssue));
        return;
      }

      const description = descriptionInput.value.trim();
      if (!description) {
        new Notice(t('settings.opencode.subagents.validation.descriptionRequired'));
        return;
      }

      const prompt = promptArea.value;
      if (!prompt.trim()) {
        new Notice(t('settings.opencode.subagents.validation.promptRequired'));
        return;
      }

      const duplicate = findOpencodeAgentNameConflict(
        this.allAgents,
        name,
        this.existing?.persistenceKey,
      );
      if (duplicate) {
        new Notice(t('settings.opencode.subagents.validation.duplicateName', { name }));
        return;
      }

      const temperature = parseOptionalNumber(temperatureInput.value);
      if (temperature.issue) {
        new Notice(formatAgentFieldIssue(temperature.issue, t('settings.opencode.subagents.modal.temperature')));
        return;
      }

      const topP = parseOptionalNumber(topPInput.value);
      if (topP.issue) {
        new Notice(formatAgentFieldIssue(topP.issue, t('settings.opencode.subagents.modal.topP')));
        return;
      }

      const steps = parseOptionalPositiveInteger(stepsInput.value);
      if (steps.issue) {
        new Notice(formatAgentFieldIssue(steps.issue, t('settings.opencode.subagents.modal.steps')));
        return;
      }

      const tools = parseOptionalJsonObjectOfBooleans(toolsInput.value);
      if (tools.issue) {
        new Notice(formatAgentFieldIssue(tools.issue, t('settings.opencode.subagents.modal.tools')));
        return;
      }

      const permission = parseOptionalJson(permissionInput.value);
      if (permission.issue) {
        new Notice(formatAgentFieldIssue(permission.issue, t('settings.opencode.subagents.modal.permission')));
        return;
      }

      const options = parseOptionalJsonObject(optionsInput.value);
      if (options.issue) {
        new Notice(formatAgentFieldIssue(options.issue, t('settings.opencode.subagents.modal.options')));
        return;
      }

      const agent: OpencodeAgentDefinition = {
        name,
        description,
        prompt,
        mode: 'subagent',
        hidden: hiddenValue || undefined,
        disable: disableValue || undefined,
        model: modelInput.value.trim() || undefined,
        variant: variantInput.value.trim() || undefined,
        temperature: temperature.value,
        topP: topP.value,
        color: colorInput.value.trim() || undefined,
        steps: steps.value,
        tools: tools.value,
        permission: permission.value,
        options: options.value,
        persistenceKey: this.existing?.persistenceKey,
        extraFrontmatter: this.existing?.extraFrontmatter,
      };

      try {
        await this.onSave(agent);
      } catch (error) {
        const message = error instanceof Error ? error.message : t('common.unknownError');
        new Notice(t('settings.opencode.subagents.saveFailed', { message }));
        return;
      }
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class OpencodeAgentSettings {
  private containerEl: HTMLElement;
  private storage: OpencodeAgentStorage;
  private agents: OpencodeAgentDefinition[] = [];
  private app?: App;
  private onChanged?: () => Promise<void> | void;

  constructor(
    containerEl: HTMLElement,
    storage: OpencodeAgentStorage,
    app?: App,
    onChanged?: () => Promise<void> | void,
  ) {
    this.containerEl = containerEl;
    this.storage = storage;
    this.app = app;
    this.onChanged = onChanged;
    void this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    try {
      this.agents = await this.storage.loadAll();
    } catch {
      this.agents = [];
    }

    const visibleAgents = this.agents.filter((agent) => agent.mode === 'subagent');

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-sp-header' });
    headerEl.createSpan({ text: t('settings.opencode.subagents.name'), cls: 'claudian-sp-label' });

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

    if (visibleAgents.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
      emptyEl.setText(t('settings.opencode.subagents.noAgents'));
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-sp-list' });
    for (const agent of visibleAgents) {
      this.renderItem(listEl, agent);
    }
  }

  private renderItem(listEl: HTMLElement, agent: OpencodeAgentDefinition): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-sp-item' });
    const infoEl = itemEl.createDiv({ cls: 'claudian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-sp-item-header' });
    const nameEl = headerRow.createSpan({ cls: 'claudian-sp-item-name' });
    nameEl.setText(agent.name);

    headerRow.createSpan({
      text: t('settings.opencode.subagents.badge'),
      cls: 'claudian-slash-item-badge',
    });

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
        t('settings.opencode.subagents.deleteConfirm', { name: agent.name }),
      );
      if (!confirmed) return;
      try {
        await this.storage.delete(agent);
        await this.render();
        await this.onChanged?.();
        new Notice(t('settings.opencode.subagents.deleted', { name: agent.name }));
      } catch {
        new Notice(t('settings.opencode.subagents.deleteFailed'));
      }
    });
  }

  private openModal(existing: OpencodeAgentDefinition | null): void {
    if (!this.app) return;

    const modal = new OpencodeAgentModal(
      this.app,
      existing,
      this.agents,
      async (agent) => {
        await this.storage.save(agent, existing);
        await this.render();
        await this.onChanged?.();
        new Notice(
          existing
            ? t('settings.opencode.subagents.updated', { name: agent.name })
            : t('settings.opencode.subagents.created', { name: agent.name }),
        );
      },
    );
    modal.open();
  }
}

/** Stable issue categories so the modal can format with its own field label / locale. */
export type OpencodeFieldIssueCode =
  | 'validNumber'
  | 'positiveInteger'
  | 'validJson'
  | 'jsonObject'
  | 'booleanMap';

function formatAgentFieldIssue(issue: OpencodeFieldIssueCode, fieldLabel: string): string {
  switch (issue) {
    case 'validNumber': return t('settings.opencode.subagents.validation.validNumber', { field: fieldLabel });
    case 'positiveInteger': return t('settings.opencode.subagents.validation.positiveInteger', { field: fieldLabel });
    case 'validJson': return t('settings.opencode.subagents.validation.validJson', { field: fieldLabel });
    case 'jsonObject': return t('settings.opencode.subagents.validation.jsonObject', { field: fieldLabel });
    case 'booleanMap': return t('settings.opencode.subagents.validation.booleanMap', { field: fieldLabel });
  }
}

function parseOptionalNumber(
  value: string,
): { issue?: OpencodeFieldIssueCode; value?: number } {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { issue: 'validNumber' };
  }

  return { value: parsed };
}

function parseOptionalPositiveInteger(
  value: string,
): { issue?: OpencodeFieldIssueCode; value?: number } {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { issue: 'positiveInteger' };
  }

  return { value: parsed };
}

function parseOptionalJson(
  value: string,
): { issue?: OpencodeFieldIssueCode; value?: unknown } {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    return { issue: 'validJson' };
  }
}

function parseOptionalJsonObject(
  value: string,
): { issue?: OpencodeFieldIssueCode; value?: Record<string, unknown> } {
  const parsed = parseOptionalJson(value);
  if (parsed.issue || parsed.value === undefined) {
    return parsed.issue ? { issue: parsed.issue } : {};
  }

  if (!isJsonObject(parsed.value)) {
    return { issue: 'jsonObject' };
  }

  return { value: parsed.value };
}

function parseOptionalJsonObjectOfBooleans(
  value: string,
): { issue?: OpencodeFieldIssueCode; value?: Record<string, boolean> } {
  const parsed = parseOptionalJsonObject(value);
  if (parsed.issue || parsed.value === undefined) {
    return parsed.issue ? { issue: parsed.issue } : {};
  }

  if (!Object.values(parsed.value).every((entry) => typeof entry === 'boolean')) {
    return { issue: 'booleanMap' };
  }

  return { value: parsed.value as Record<string, boolean> };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
