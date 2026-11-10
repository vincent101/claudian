import { Notice, setIcon } from 'obsidian';
import * as path from 'path';

import type { McpServerManager } from '../../../core/mcp/McpServerManager';
import {
  isTransientProviderPermissionModeValue,
} from '../../../core/providers/permissionModes';
import type {
  ProviderCapabilities,
  ProviderChatUIConfig,
  ProviderModelOption,
  ProviderModelSelection,
  ProviderModeSelectorConfig,
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
  ProviderReasoningOption,
  ProviderServiceTierToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import type {
  ManagedMcpServer,
  UsageInfo,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { CHECK_ICON_SVG, createProviderIconSvg, MCP_ICON_SVG } from '../../../shared/icons';
import { filterValidPaths, findConflictingPath, isDuplicatePath, isValidDirectoryPath, validateDirectoryPath } from '../../../utils/externalContext';
import { expandHomePath, normalizePathForFilesystem } from '../../../utils/path';

export interface ToolbarSettings {
  model: string;
  thinkingBudget: string;
  effortLevel: string;
  serviceTier: string;
  permissionMode: string;
  [key: string]: unknown;
}

export interface ToolbarCallbacks {
  onModelChange: (selection: ProviderModelSelection) => Promise<void>;
  getModelSelection: () => ProviderModelSelection;
  getModelOptions: () => ProviderModelOption[];
  onModeChange: (mode: string) => Promise<void>;
  onThinkingBudgetChange: (budget: string) => Promise<void>;
  onEffortLevelChange: (effort: string) => Promise<void>;
  onServiceTierChange: (serviceTier: string) => Promise<void>;
  onPermissionModeChange: (mode: string) => Promise<void>;
  getSettings: () => ToolbarSettings;
  getEnvironmentVariables?: () => string;
  getUIConfig: () => ProviderChatUIConfig;
  getCapabilities: () => ProviderCapabilities;
}

export class ModelSelector {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-model-selector' });
    this.render();
  }

  private getAvailableModels(): ProviderModelOption[] {
    return this.callbacks.getModelOptions();
  }

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createDiv({ cls: 'claudian-model-btn' });
    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-model-dropdown' });
    this.renderOptions();
  }

  updateDisplay() {
    if (!this.buttonEl) return;
    const currentSelection = this.callbacks.getModelSelection();
    const models = this.getAvailableModels();
    const modelInfo = models.find(m => m.providerId === currentSelection.providerId && m.value === currentSelection.modelId);

    const displayModel = modelInfo || models[0];

    this.buttonEl.empty();

    const labelEl = this.buttonEl.createSpan({ cls: 'claudian-model-label' });
    labelEl.setText(displayModel?.label || 'Unknown');
  }

  renderOptions() {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    const currentSelection = this.callbacks.getModelSelection();
    const models = this.getAvailableModels();
    const reversed = [...models].reverse();

    let lastGroup: string | undefined;
    for (const model of reversed) {
      if (model.group && model.group !== lastGroup) {
        const separator = this.dropdownEl.createDiv({ cls: 'claudian-model-group' });
        separator.setText(model.group);
        lastGroup = model.group;
      }

      const option = this.dropdownEl.createDiv({ cls: 'claudian-model-option' });
      if (model.providerId === currentSelection.providerId && model.value === currentSelection.modelId) {
        option.addClass('selected');
      }

      const icon = model.providerIcon ?? this.callbacks.getUIConfig().getProviderIcon?.();
      if (icon) {
        option.appendChild(createProviderIconSvg(icon, {
          className: 'claudian-model-provider-icon',
          height: 12,
          width: 12,
        }));
      }
      option.createSpan({ text: model.label });
      if (model.description) {
        option.setAttribute('title', model.description);
      }

      option.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onModelChange({ providerId: model.providerId, modelId: model.value });
        this.updateDisplay();
        this.renderOptions();
      });
    }
  }
}

export class ModeSelector {
  private container: HTMLElement;
  private labelEl: HTMLElement | null = null;
  private toggleEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-mode-selector' });
    this.render();
  }

  private getSelectorConfig(): ProviderModeSelectorConfig | null {
    return this.callbacks.getUIConfig().getModeSelector?.(this.callbacks.getSettings()) ?? null;
  }

  private render() {
    this.container.empty();

    this.labelEl = this.container.createSpan({ cls: 'claudian-mode-label' });
    this.toggleEl = this.container.createDiv({ cls: 'claudian-toggle-switch' });

    this.toggleEl.addEventListener('click', () => this.toggle());

    this.updateDisplay();
  }

  /** Resolves the active/inactive option pair for a two-option toggle. */
  private resolveOptionPair(
    selectorConfig: ProviderModeSelectorConfig,
  ): { active: ProviderUIOption; inactive: ProviderUIOption } {
    const [first, second] = selectorConfig.options;
    const active = selectorConfig.activeValue
      ? selectorConfig.options.find((option) => option.value === selectorConfig.activeValue) ?? second
      : second;
    const inactive = active.value === first.value ? second : first;
    return { active, inactive };
  }

  updateDisplay() {
    if (!this.toggleEl || !this.labelEl) {
      return;
    }

    const selectorConfig = this.getSelectorConfig();
    if (!selectorConfig || selectorConfig.options.length !== 2) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = '';
    const { active, inactive } = this.resolveOptionPair(selectorConfig);
    const currentOption = selectorConfig.options.find((option) => option.value === selectorConfig.value)
      ?? selectorConfig.options[0];
    const isActive = currentOption.value === active.value;

    this.labelEl.setText(currentOption.label || selectorConfig.label);
    this.labelEl.toggleClass('active', isActive);
    if (isActive) {
      this.toggleEl.addClass('active');
    } else {
      this.toggleEl.removeClass('active');
    }

    const titleParts = [`${inactive.label} <-> ${active.label}`];
    if (currentOption.description) {
      titleParts.push(currentOption.description);
    }
    this.container.setAttribute('title', titleParts.join('\n'));
  }

  renderOptions() {
    this.updateDisplay();
  }

  private async toggle() {
    const selectorConfig = this.getSelectorConfig();
    if (!selectorConfig || selectorConfig.options.length !== 2) {
      return;
    }

    const { active, inactive } = this.resolveOptionPair(selectorConfig);
    const nextValue = selectorConfig.value === active.value ? inactive.value : active.value;
    await this.callbacks.onModeChange(nextValue);
    this.updateDisplay();
  }
}

export class ThinkingBudgetSelector {
  private container: HTMLElement;
  private effortEl: HTMLElement | null = null;
  private effortGearsEl: HTMLElement | null = null;
  private budgetEl: HTMLElement | null = null;
  private budgetGearsEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-thinking-selector' });
    this.render();
  }

  private render() {
    this.container.empty();

    // Effort selector (for adaptive thinking models)
    this.effortEl = this.container.createDiv({ cls: 'claudian-thinking-effort' });
    const effortLabel = this.effortEl.createSpan({ cls: 'claudian-thinking-label-text' });
    effortLabel.setText('Effort:');
    this.effortGearsEl = this.effortEl.createDiv({ cls: 'claudian-thinking-gears' });

    // Legacy budget selector (for custom models)
    this.budgetEl = this.container.createDiv({ cls: 'claudian-thinking-budget' });
    const budgetLabel = this.budgetEl.createSpan({ cls: 'claudian-thinking-label-text' });
    budgetLabel.setText('Thinking:');
    this.budgetGearsEl = this.budgetEl.createDiv({ cls: 'claudian-thinking-gears' });

    this.updateDisplay();
  }

  private renderEffortGears() {
    if (!this.effortGearsEl) return;
    this.effortGearsEl.empty();

    const currentEffort = this.callbacks.getSettings().effortLevel;
    const uiConfig = this.callbacks.getUIConfig();
    const settings = this.callbacks.getSettings();
    const model = settings.model;
    const options = uiConfig.getReasoningOptions(model, settings);
    const currentInfo = options.find(e => e.value === currentEffort);

    const currentEl = this.effortGearsEl.createDiv({ cls: 'claudian-thinking-current' });
    currentEl.setText(currentInfo?.label || options[0]?.label || 'High');

    const optionsEl = this.effortGearsEl.createDiv({ cls: 'claudian-thinking-options' });

    for (const effort of [...options].reverse()) {
      const gearEl = optionsEl.createDiv({ cls: 'claudian-thinking-gear' });
      gearEl.setText(effort.label);

      if (effort.value === currentEffort) {
        gearEl.addClass('selected');
      }

      gearEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onEffortLevelChange(effort.value);
        this.updateDisplay();
      });
    }
  }

  private renderBudgetGears() {
    if (!this.budgetGearsEl) return;
    this.budgetGearsEl.empty();

    const currentBudget = this.callbacks.getSettings().thinkingBudget;
    const uiConfig = this.callbacks.getUIConfig();
    const settings = this.callbacks.getSettings();
    const model = settings.model;
    const options: ProviderReasoningOption[] = uiConfig.getReasoningOptions(model, settings);
    const currentBudgetInfo = options.find(b => b.value === currentBudget);

    const currentEl = this.budgetGearsEl.createDiv({ cls: 'claudian-thinking-current' });
    currentEl.setText(currentBudgetInfo?.label || options[0]?.label || 'Off');

    const optionsEl = this.budgetGearsEl.createDiv({ cls: 'claudian-thinking-options' });

    for (const budget of [...options].reverse()) {
      const gearEl = optionsEl.createDiv({ cls: 'claudian-thinking-gear' });
      gearEl.setText(budget.label);
      const tokens = budget.tokens ?? 0;
      gearEl.setAttribute('title', tokens > 0 ? `${tokens.toLocaleString()} tokens` : 'Disabled');

      if (budget.value === currentBudget) {
        gearEl.addClass('selected');
      }

      gearEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onThinkingBudgetChange(budget.value);
        this.updateDisplay();
      });
    }
  }

  updateDisplay() {
    const capabilities = this.callbacks.getCapabilities();
    if (capabilities.reasoningControl === 'none') {
      if (this.effortEl) this.effortEl.style.display = 'none';
      if (this.budgetEl) this.budgetEl.style.display = 'none';
      return;
    }

    const settings = this.callbacks.getSettings();
    const model = settings.model;
    const uiConfig = this.callbacks.getUIConfig();
    const options = uiConfig.getReasoningOptions(model, settings);
    const defaultValue = uiConfig.getDefaultReasoningValue(model, settings);
    const shouldHide = options.length === 0
      || (options.length === 1 && options[0]?.value === defaultValue);

    if (shouldHide) {
      if (this.effortEl) this.effortEl.style.display = 'none';
      if (this.budgetEl) this.budgetEl.style.display = 'none';
      return;
    }

    const adaptive = uiConfig.isAdaptiveReasoningModel(model, settings);

    if (this.effortEl) {
      this.effortEl.style.display = adaptive ? '' : 'none';
    }
    if (this.budgetEl) {
      this.budgetEl.style.display = adaptive ? 'none' : '';
    }

    if (adaptive) {
      this.renderEffortGears();
    } else {
      this.renderBudgetGears();
    }
  }
}

/**
 * Permission-mode menu driven by the provider's policy options (four modes for
 * Claude, two for Safe/YOLO providers). Plan is a read-only transient display
 * state, never a fifth option; unknown values render as unavailable and wait
 * for the projection instead of masquerading as the first option.
 */
export class PermissionToggle {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;
  private iconEl: HTMLElement | null = null;
  private chevronEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private itemEls: HTMLElement[] = [];
  private callbacks: ToolbarCallbacks;
  private visible = true;
  private menuOpen = false;
  private focusedIndex: number | null = null;
  private documentClickListener: ((e: Event) => void) | null = null;
  private destroyed = false;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-permission-toggle' });
    this.render();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.updateDisplay();
  }

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createEl('button', { cls: 'claudian-permission-button' });
    this.iconEl = this.buttonEl.createSpan({ cls: 'claudian-permission-icon' });
    this.labelEl = this.buttonEl.createSpan({ cls: 'claudian-permission-label' });
    this.chevronEl = this.buttonEl.createSpan({ cls: 'claudian-permission-chevron' });
    this.menuEl = this.container.createDiv({ cls: 'claudian-permission-menu' });

    this.buttonEl.setAttribute('aria-haspopup', 'menu');
    this.buttonEl.setAttribute('aria-expanded', 'false');
    this.menuEl.setAttribute('role', 'menu');
    this.menuEl.setAttribute('aria-label', t('chat.permission.ariaLabel', { mode: '' }));
    this.menuEl.style.display = 'none';

    this.buttonEl.addEventListener('click', () => {
      if (this.menuOpen) {
        this.closeMenu();
      } else {
        this.openMenu();
      }
    });

    // Button + menu item keys share one bubbled handler.
    this.container.addEventListener('keydown', (e: KeyboardEvent) => {
      this.handleKeydown(e);
    });

    this.updateDisplay();
  }

  private getOptions(): readonly ProviderPermissionModeOption[] {
    return this.callbacks.getUIConfig().getPermissionModeOptions?.(this.callbacks.getSettings()) ?? [];
  }

  private getPolicy(): ProviderPermissionModePolicy | null {
    return this.callbacks.getUIConfig().permissionModes ?? null;
  }

  isMenuOpen(): boolean {
    return this.menuOpen;
  }

  /** Closes the menu; returns whether it was open (Escape arbitration). */
  closeMenu(): boolean {
    if (!this.menuOpen) {
      return false;
    }
    this.menuOpen = false;
    this.focusedIndex = null;
    if (this.menuEl) this.menuEl.style.display = 'none';
    this.buttonEl?.setAttribute('aria-expanded', 'false');
    this.chevronEl?.removeClass('claudian-permission-chevron-open');
    this.detachDocumentClickListener();
    return true;
  }

  private openMenu(): void {
    if (this.destroyed || this.menuOpen || !this.menuEl) {
      return;
    }
    this.menuOpen = true;
    this.menuEl.style.display = '';
    this.buttonEl?.setAttribute('aria-expanded', 'true');
    this.chevronEl?.addClass('claudian-permission-chevron-open');
    this.attachDocumentClickListener();
    this.focusItemAt(0);
  }

  /**
   * Consumed-key report for the three Escape paths (view scope, input keydown,
   * navigation controller): a menu-open Escape closes the menu instead of
   * cancelling streaming; a closed menu never swallows keys.
   */
  handleKeydown(e: KeyboardEvent): boolean {
    if (this.destroyed) {
      return false;
    }
    if (this.menuOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeMenu();
        this.buttonEl?.focus();
        return true;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.focusItemAt((this.focusedIndex ?? -1) + 1);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.focusItemAt((this.focusedIndex ?? this.itemEls.length) - 1);
        return true;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (this.focusedIndex !== null) {
          this.itemEls[this.focusedIndex]?.click();
        }
        return true;
      }
      return false;
    }

    // Closed menu: only the button itself opens via keyboard.
    if (e.target !== this.buttonEl) {
      return false;
    }
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.openMenu();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.openMenu();
      this.focusItemAt(this.itemEls.length - 1);
      return true;
    }
    return false;
  }

  /** Idempotent teardown: clears the menu and every document listener. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.closeMenu();
    this.destroyed = true;
    this.container.empty();
    this.buttonEl = null;
    this.labelEl = null;
    this.iconEl = null;
    this.chevronEl = null;
    this.menuEl = null;
    this.itemEls = [];
  }

  private focusItemAt(index: number): void {
    if (this.itemEls.length === 0) {
      return;
    }
    const wrapped = ((index % this.itemEls.length) + this.itemEls.length) % this.itemEls.length;
    this.focusedIndex = wrapped;
    this.itemEls[wrapped]?.focus();
  }

  private attachDocumentClickListener(): void {
    if (typeof document === 'undefined') {
      return;
    }
    this.detachDocumentClickListener();
    this.documentClickListener = (e: Event) => {
      const target = e.target as Node | null;
      if (target && this.container.contains(target)) {
        return;
      }
      this.closeMenu();
    };
    document.addEventListener('click', this.documentClickListener);
  }

  private detachDocumentClickListener(): void {
    if (this.documentClickListener && typeof document !== 'undefined') {
      document.removeEventListener('click', this.documentClickListener);
    }
    this.documentClickListener = null;
  }

  updateDisplay() {
    if (this.destroyed || !this.buttonEl || !this.labelEl || !this.iconEl) return;

    const options = this.getOptions();
    const policy = this.getPolicy();
    if (!this.visible || options.length === 0) {
      this.closeMenu();
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = '';
    const mode = this.callbacks.getSettings().permissionMode;
    const current = options.find(option => option.value === mode) ?? null;
    const isTransientPlan = policy !== null
      && isTransientProviderPermissionModeValue(policy, mode);
    const transientLabel = isTransientPlan
      ? this.callbacks.getUIConfig().getPermissionTransientModeLabel?.(mode as string) ?? null
      : null;
    const bypasses = current?.bypassesApprovals === true;

    // Plan and unknown states never fall back to options[0] — plan renders its
    // own read-only label; anything else waits for the projection to recover.
    const displayLabel = current?.label
      ?? transientLabel
      ?? t('chat.permission.unavailable');

    this.labelEl.setText(displayLabel);
    this.labelEl.toggleClass('plan-active', isTransientPlan);
    this.iconEl.empty();
    setIcon(this.iconEl, bypasses ? 'shield-alert' : 'shield');
    this.buttonEl.toggleClass('claudian-permission-warning', bypasses);
    this.buttonEl.setAttribute('aria-label', t('chat.permission.ariaLabel', { mode: displayLabel }));

    // Provider switch / selection: rebuild from current options and drop the
    // old menu so it can never commit against a stale provider.
    this.closeMenu();
    this.renderMenuItems(options, mode);
  }

  private renderMenuItems(
    options: readonly ProviderPermissionModeOption[],
    currentMode: string,
  ): void {
    if (!this.menuEl) return;
    this.menuEl.empty();
    this.itemEls = [];

    for (const option of options) {
      const item = this.menuEl.createDiv({ cls: 'claudian-permission-option' });
      item.setAttribute('role', 'menuitemradio');
      // Programmatically focusable for arrow-key navigation.
      item.setAttribute('tabindex', '-1');
      const selected = option.value === currentMode;
      item.setAttribute('aria-checked', selected ? 'true' : 'false');
      if (selected) {
        item.addClass('selected');
        const checkEl = item.createSpan({ cls: 'claudian-permission-check' });
        checkEl.innerHTML = CHECK_ICON_SVG;
      }

      item.createSpan({ cls: 'claudian-permission-option-label' }).setText(option.label);
      if (option.description) {
        item.createDiv({ cls: 'claudian-permission-option-desc' }).setText(option.description);
      }

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.selectOption(option.value);
      });
      this.itemEls.push(item);
    }
  }

  private async selectOption(value: string): Promise<void> {
    // Same-value selections never commit; plan exits only through an explicit
    // durable choice, which the Tab writer resolves + persists.
    if (value === this.callbacks.getSettings().permissionMode) {
      this.closeMenu();
      this.buttonEl?.focus();
      return;
    }
    try {
      await this.callbacks.onPermissionModeChange(value);
    } finally {
      this.closeMenu();
      this.buttonEl?.focus();
      this.updateDisplay();
    }
  }
}

export class ServiceTierToggle {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private iconEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-service-tier-toggle' });
    this.render();
  }

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createDiv({ cls: 'claudian-service-tier-button' });
    this.iconEl = this.buttonEl.createSpan({ cls: 'claudian-service-tier-icon' });
    setIcon(this.iconEl, 'zap');

    this.updateDisplay();

    this.buttonEl.addEventListener('click', () => this.toggle());
  }

  private getToggleConfig(): ProviderServiceTierToggleConfig | null {
    const uiConfig = this.callbacks.getUIConfig();
    return uiConfig.getServiceTierToggle?.(this.callbacks.getSettings()) ?? null;
  }

  updateDisplay() {
    if (!this.buttonEl || !this.iconEl) return;

    const toggleConfig = this.getToggleConfig();
    if (!toggleConfig) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = '';
    const current = this.callbacks.getSettings().serviceTier;
    const isActive = current === toggleConfig.activeValue;
    if (isActive) {
      this.buttonEl.addClass('active');
    } else {
      this.buttonEl.removeClass('active');
    }

    this.container.setAttribute('title', 'Toggle on/off fast mode');
  }

  private async toggle() {
    const toggleConfig = this.getToggleConfig();
    if (!toggleConfig) return;

    const current = this.callbacks.getSettings().serviceTier;
    const next = current === toggleConfig.activeValue
      ? toggleConfig.inactiveValue
      : toggleConfig.activeValue;
    await this.callbacks.onServiceTierChange(next);
    this.updateDisplay();
  }
}

export type AddExternalContextResult =
  | { success: true; normalizedPath: string }
  | { success: false; error: string };

export class ExternalContextSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  /**
   * Current external context paths. May contain:
   * - Persistent paths only (new sessions via clearExternalContexts)
   * - Restored session paths (loaded sessions via setExternalContexts)
   * - Mixed paths during active sessions
   */
  private externalContextPaths: string[] = [];
  /** Paths that persist across all sessions (stored in settings). */
  private persistentPaths: Set<string> = new Set();
  private onChangeCallback: ((paths: string[]) => void) | null = null;
  private onPersistenceChangeCallback: ((paths: string[]) => void) | null = null;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-external-context-selector' });
    this.render();
  }

  setOnChange(callback: (paths: string[]) => void): void {
    this.onChangeCallback = callback;
  }

  setOnPersistenceChange(callback: (paths: string[]) => void): void {
    this.onPersistenceChangeCallback = callback;
  }

  /**
   * Single commit point for every effective external-context directory
   * mutation. The new list is assigned before the effective-directory
   * listener runs, the listener receives a defensive copy, and unchanged
   * lists do not notify (no command revocation for no-op commits). A→B→A
   * still notifies on each transition: freshness rides on the commit itself,
   * never on remembered path strings.
   */
  private commitExternalContextPaths(nextPaths: string[]): boolean {
    const changed = !ExternalContextSelector.sameEffectivePaths(nextPaths, this.externalContextPaths);
    this.externalContextPaths = nextPaths;
    if (changed) {
      this.onChangeCallback?.([...nextPaths]);
    }
    this.updateDisplay();
    return changed;
  }

  private static sameEffectivePaths(next: string[], current: string[]): boolean {
    if (next.length !== current.length) return false;
    const currentSet = new Set(current);
    return next.every(p => currentSet.has(p));
  }

  getExternalContexts(): string[] {
    return [...this.externalContextPaths];
  }

  getPersistentPaths(): string[] {
    return [...this.persistentPaths];
  }

  setPersistentPaths(paths: string[]): void {
    // Validate paths - remove non-existent directories
    const validPaths = filterValidPaths(paths);
    const invalidPaths = paths.filter(p => !validPaths.includes(p));

    this.persistentPaths = new Set(validPaths);
    // Merge persistent paths into external context paths
    this.mergePersistentPaths();
    this.renderDropdown();

    // If invalid paths were removed, notify user and save updated list
    if (invalidPaths.length > 0) {
      const pathNames = invalidPaths.map(p => this.shortenPath(p)).join(', ');
      new Notice(`Removed ${invalidPaths.length} invalid external context path(s): ${pathNames}`, 5000);
      this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    }
  }

  togglePersistence(path: string): void {
    if (this.persistentPaths.has(path)) {
      this.persistentPaths.delete(path);
    } else {
      // Validate path still exists before persisting
      if (!isValidDirectoryPath(path)) {
        new Notice(`Cannot persist "${this.shortenPath(path)}" - directory no longer exists`, 4000);
        return;
      }
      this.persistentPaths.add(path);
    }
    this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    this.renderDropdown();
  }

  private mergePersistentPaths(): void {
    const pathSet = new Set(this.externalContextPaths);
    for (const path of this.persistentPaths) {
      pathSet.add(path);
    }
    this.commitExternalContextPaths([...pathSet]);
  }

  /**
   * Restore exact external context paths from a saved conversation.
   * Does NOT merge with persistent paths - preserves the session's historical state.
   * Use clearExternalContexts() for new sessions to start with current persistent paths.
   */
  setExternalContexts(paths: string[]): void {
    this.commitExternalContextPaths([...paths]);
    this.renderDropdown();
  }

  /**
   * Remove a path from external contexts (and persistent paths if applicable).
   * Exposed for testing the remove button behavior.
   */
  removePath(pathStr: string): void {
    const nextActive = this.externalContextPaths.filter(p => p !== pathStr);
    // Update both in-memory slots before notifying so the effective-directory
    // listener observes a consistent selector state.
    const wasPersistent = this.persistentPaths.has(pathStr);
    if (wasPersistent) {
      this.persistentPaths.delete(pathStr);
    }
    this.commitExternalContextPaths(nextActive);
    if (wasPersistent) {
      this.onPersistenceChangeCallback?.([...this.persistentPaths]);
    }
    this.renderDropdown();
  }

  /**
   * Add an external context path programmatically (e.g., from /add-dir command).
   * Validates the path and handles duplicates/conflicts.
   * @param pathInput - Path string (supports ~/ expansion)
   * @returns Result with success status and normalized path, or error message on failure
   */
  addExternalContext(pathInput: string): AddExternalContextResult {
    const trimmed = pathInput?.trim();
    if (!trimmed) {
      return { success: false, error: 'No path provided. Usage: /add-dir /absolute/path' };
    }

    // Strip surrounding quotes if present (e.g., "/path/with spaces")
    let cleanPath = trimmed;
    if ((cleanPath.startsWith('"') && cleanPath.endsWith('"')) ||
        (cleanPath.startsWith("'") && cleanPath.endsWith("'"))) {
      cleanPath = cleanPath.slice(1, -1);
    }

    // Expand home directory and normalize path
    const expandedPath = expandHomePath(cleanPath);
    const normalizedPath = normalizePathForFilesystem(expandedPath);

    if (!path.isAbsolute(normalizedPath)) {
      return { success: false, error: 'Path must be absolute. Usage: /add-dir /absolute/path' };
    }

    // Validate path exists and is a directory with specific error messages
    const validation = validateDirectoryPath(normalizedPath);
    if (!validation.valid) {
      return { success: false, error: `${validation.error}: ${pathInput}` };
    }

    // Check for duplicate (normalized comparison for cross-platform support)
    if (isDuplicatePath(normalizedPath, this.externalContextPaths)) {
      return { success: false, error: 'This folder is already added as an external context.' };
    }

    // Check for nested/overlapping paths
    const conflict = findConflictingPath(normalizedPath, this.externalContextPaths);
    if (conflict) {
      return { success: false, error: this.formatConflictMessage(normalizedPath, conflict) };
    }

    // Add the path through the effective-directory commit point
    this.commitExternalContextPaths([...this.externalContextPaths, normalizedPath]);
    this.renderDropdown();

    return { success: true, normalizedPath };
  }

  /**
   * Clear session-only external context paths (call on new conversation).
   * Uses persistent paths from settings if provided, otherwise falls back to local cache.
   * Validates paths before using them (silently filters invalid during session init).
   */
  clearExternalContexts(persistentPathsFromSettings?: string[]): void {
    // Use settings value if provided (most up-to-date), otherwise use local cache
    if (persistentPathsFromSettings) {
      // Validate paths - silently filter during session initialization (not user action)
      const validPaths = filterValidPaths(persistentPathsFromSettings);
      this.persistentPaths = new Set(validPaths);
    }
    this.commitExternalContextPaths([...this.persistentPaths]);
    this.renderDropdown();
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'claudian-external-context-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'claudian-external-context-icon' });
    setIcon(this.iconEl, 'folder');

    this.badgeEl = iconWrapper.createDiv({ cls: 'claudian-external-context-badge' });

    this.updateDisplay();

    // Click to open native folder picker
    iconWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openFolderPicker();
    });

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-external-context-dropdown' });
    this.renderDropdown();
  }

  private async openFolderPicker() {
    try {
      // Access Electron's dialog through remote
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { remote } = require('electron');
      const result = await remote.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select External Context',
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];

        // Check for duplicate (normalized comparison for cross-platform support)
        if (isDuplicatePath(selectedPath, this.externalContextPaths)) {
          new Notice('This folder is already added as an external context.', 3000);
          return;
        }

        // Check for nested/overlapping paths
        const conflict = findConflictingPath(selectedPath, this.externalContextPaths);
        if (conflict) {
          new Notice(this.formatConflictMessage(selectedPath, conflict), 5000);
          return;
        }

        this.commitExternalContextPaths([...this.externalContextPaths, selectedPath]);
        this.renderDropdown();
      }
    } catch {
      new Notice('Unable to open folder picker.', 5000);
    }
  }

  /** Formats a conflict error message for display. */
  private formatConflictMessage(newPath: string, conflict: { path: string; type: 'parent' | 'child' }): string {
    const shortNew = this.shortenPath(newPath);
    const shortExisting = this.shortenPath(conflict.path);
    return conflict.type === 'parent'
      ? `Cannot add "${shortNew}" - it's inside existing path "${shortExisting}"`
      : `Cannot add "${shortNew}" - it contains existing path "${shortExisting}"`;
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;

    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'claudian-external-context-header' });
    headerEl.setText('External Contexts');

    // Path list
    const listEl = this.dropdownEl.createDiv({ cls: 'claudian-external-context-list' });

    if (this.externalContextPaths.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'claudian-external-context-empty' });
      emptyEl.setText('Click folder icon to add');
    } else {
      for (const pathStr of this.externalContextPaths) {
        const itemEl = listEl.createDiv({ cls: 'claudian-external-context-item' });

        const pathTextEl = itemEl.createSpan({ cls: 'claudian-external-context-text' });
        // Show shortened path for display
        const displayPath = this.shortenPath(pathStr);
        pathTextEl.setText(displayPath);
        pathTextEl.setAttribute('title', pathStr);

        // Lock toggle button
        const isPersistent = this.persistentPaths.has(pathStr);
        const lockBtn = itemEl.createSpan({ cls: 'claudian-external-context-lock' });
        if (isPersistent) {
          lockBtn.addClass('locked');
        }
        setIcon(lockBtn, isPersistent ? 'lock' : 'unlock');
        lockBtn.setAttribute('title', isPersistent ? 'Persistent (click to make session-only)' : 'Session-only (click to persist)');
        lockBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.togglePersistence(pathStr);
        });

        const removeBtn = itemEl.createSpan({ cls: 'claudian-external-context-remove' });
        setIcon(removeBtn, 'x');
        removeBtn.setAttribute('title', 'Remove path');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removePath(pathStr);
        });
      }
    }
  }

  /** Shorten path for display (replace home dir with ~) */
  private shortenPath(fullPath: string): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('os');
      const homeDir = os.homedir();
      const normalize = (value: string) => value.replace(/\\/g, '/');
      const normalizedFull = normalize(fullPath);
      const normalizedHome = normalize(homeDir);
      const compareFull = process.platform === 'win32'
        ? normalizedFull.toLowerCase()
        : normalizedFull;
      const compareHome = process.platform === 'win32'
        ? normalizedHome.toLowerCase()
        : normalizedHome;
      if (compareFull.startsWith(compareHome)) {
        // Use normalized path length and normalize the result for consistent display
        const remainder = normalizedFull.slice(normalizedHome.length);
        return '~' + remainder;
      }
    } catch {
      // Fall through to return full path
    }
    return fullPath;
  }

  updateDisplay() {
    if (!this.iconEl || !this.badgeEl) return;

    const count = this.externalContextPaths.length;

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} external context${count > 1 ? 's' : ''} (click to add more)`);

      // Show badge only when more than 1 path
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', 'Add external contexts (click)');
      this.badgeEl.removeClass('visible');
    }
  }
}

export class McpServerSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private mcpManager: McpServerManager | null = null;
  private enabledServers: Set<string> = new Set();
  private onChangeCallback: ((enabled: Set<string>) => void) | null = null;
  private visible = true;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-mcp-selector' });
    this.render();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.container.style.display = 'none';
    } else {
      this.updateDisplay();
    }
  }

  setMcpManager(manager: McpServerManager | null): void {
    this.mcpManager = manager;
    if (!manager && this.enabledServers.size > 0) {
      this.enabledServers.clear();
      this.onChangeCallback?.(this.enabledServers);
    }
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  setOnChange(callback: (enabled: Set<string>) => void): void {
    this.onChangeCallback = callback;
  }

  getEnabledServers(): Set<string> {
    return new Set(this.enabledServers);
  }

  addMentionedServers(names: Set<string>): void {
    let changed = false;
    for (const name of names) {
      if (!this.enabledServers.has(name)) {
        this.enabledServers.add(name);
        changed = true;
      }
    }
    if (changed) {
      this.updateDisplay();
      this.renderDropdown();
    }
  }

  clearEnabled(): void {
    this.enabledServers.clear();
    this.updateDisplay();
    this.renderDropdown();
  }

  setEnabledServers(names: string[]): void {
    this.enabledServers = new Set(names);
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  private pruneEnabledServers(): void {
    if (!this.mcpManager) return;
    const activeNames = new Set(this.mcpManager.getServers().filter((s) => s.enabled).map((s) => s.name));
    let changed = false;
    for (const name of this.enabledServers) {
      if (!activeNames.has(name)) {
        this.enabledServers.delete(name);
        changed = true;
      }
    }
    if (changed) {
      this.onChangeCallback?.(this.enabledServers);
    }
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'claudian-mcp-selector-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'claudian-mcp-selector-icon' });
    this.iconEl.innerHTML = MCP_ICON_SVG;

    this.badgeEl = iconWrapper.createDiv({ cls: 'claudian-mcp-selector-badge' });

    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-mcp-selector-dropdown' });
    this.renderDropdown();

    // Re-render dropdown content on hover (CSS handles visibility)
    this.container.addEventListener('mouseenter', () => {
      this.renderDropdown();
    });
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;
    this.pruneEnabledServers();
    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'claudian-mcp-selector-header' });
    headerEl.setText('MCP Servers');

    // Server list
    const listEl = this.dropdownEl.createDiv({ cls: 'claudian-mcp-selector-list' });

    const allServers = this.mcpManager?.getServers() || [];
    const servers = allServers.filter(s => s.enabled);

    if (servers.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'claudian-mcp-selector-empty' });
      emptyEl.setText(allServers.length === 0 ? 'No MCP servers configured' : 'All MCP servers disabled');
      return;
    }

    for (const server of servers) {
      this.renderServerItem(listEl, server);
    }
  }

  private renderServerItem(listEl: HTMLElement, server: ManagedMcpServer) {
    const itemEl = listEl.createDiv({ cls: 'claudian-mcp-selector-item' });
    itemEl.dataset.serverName = server.name;

    const isEnabled = this.enabledServers.has(server.name);
    if (isEnabled) {
      itemEl.addClass('enabled');
    }

    // Checkbox
    const checkEl = itemEl.createDiv({ cls: 'claudian-mcp-selector-check' });
    if (isEnabled) {
      checkEl.innerHTML = CHECK_ICON_SVG;
    }

    // Info
    const infoEl = itemEl.createDiv({ cls: 'claudian-mcp-selector-item-info' });

    const nameEl = infoEl.createSpan({ cls: 'claudian-mcp-selector-item-name' });
    nameEl.setText(server.name);

    // Badges
    if (server.contextSaving) {
      const csEl = infoEl.createSpan({ cls: 'claudian-mcp-selector-cs-badge' });
      csEl.setText('@');
      csEl.setAttribute('title', 'Context-saving: can also enable via @' + server.name);
    }

    // Click to toggle (use mousedown for more reliable capture)
    itemEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleServer(server.name, itemEl);
    });
  }

  private toggleServer(name: string, itemEl: HTMLElement) {
    if (this.enabledServers.has(name)) {
      this.enabledServers.delete(name);
    } else {
      this.enabledServers.add(name);
    }

    // Update item visually in-place (immediate feedback)
    const isEnabled = this.enabledServers.has(name);
    const checkEl = itemEl.querySelector('.claudian-mcp-selector-check') as HTMLElement | null;

    if (isEnabled) {
      itemEl.addClass('enabled');
      if (checkEl) checkEl.innerHTML = CHECK_ICON_SVG;
    } else {
      itemEl.removeClass('enabled');
      if (checkEl) checkEl.innerHTML = '';
    }

    this.updateDisplay();
    this.onChangeCallback?.(this.enabledServers);
  }

  updateDisplay() {
    this.pruneEnabledServers();
    if (!this.iconEl || !this.badgeEl) return;

    const count = this.enabledServers.size;
    const hasServers = (this.mcpManager?.getServers().length || 0) > 0;

    // Show/hide container based on whether there are servers and visibility
    if (!hasServers || !this.visible) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = '';

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} MCP server${count > 1 ? 's' : ''} enabled (click to manage)`);

      // Show badge only when more than 1
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', 'MCP servers (click to enable)');
      this.badgeEl.removeClass('visible');
    }
  }
}

export class ContextUsageMeter {
  private container: HTMLElement;
  private fillPath: SVGPathElement | null = null;
  private percentEl: HTMLElement | null = null;
  private circumference: number = 0;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-context-meter' });
    this.render();
    // Initially hidden
    this.container.style.display = 'none';
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }

  private render() {
    const size = 16;
    const strokeWidth = 2;
    const radius = (size - strokeWidth) / 2;
    const cx = size / 2;
    const cy = size / 2;

    // 240° arc: from 150° to 390° (upper-left through bottom to upper-right)
    const startAngle = 150;
    const endAngle = 390;
    const arcDegrees = endAngle - startAngle;
    const arcRadians = (arcDegrees * Math.PI) / 180;
    this.circumference = radius * arcRadians;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(startRad);
    const y1 = cy + radius * Math.sin(startRad);
    const x2 = cx + radius * Math.cos(endRad);
    const y2 = cy + radius * Math.sin(endRad);

    const gaugeEl = this.container.createDiv({ cls: 'claudian-context-meter-gauge' });
    gaugeEl.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <path class="claudian-meter-bg"
          d="M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}"
          fill="none" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <path class="claudian-meter-fill"
          d="M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}"
          fill="none" stroke-width="${strokeWidth}" stroke-linecap="round"
          stroke-dasharray="${this.circumference}" stroke-dashoffset="${this.circumference}"/>
      </svg>
    `;
    this.fillPath = gaugeEl.querySelector('.claudian-meter-fill');

    this.percentEl = this.container.createSpan({ cls: 'claudian-context-meter-percent' });
  }

  update(usage: UsageInfo | null): void {
    if (!usage || usage.contextTokens <= 0) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'flex';
    const fillLength = (usage.percentage / 100) * this.circumference;
    if (this.fillPath) {
      this.fillPath.style.strokeDashoffset = String(this.circumference - fillLength);
    }

    if (this.percentEl) {
      this.percentEl.setText(`${usage.percentage}%`);
    }

    // Toggle warning class for > 80%
    if (usage.percentage > 80) {
      this.container.addClass('warning');
    } else {
      this.container.removeClass('warning');
    }

    // Set tooltip with detailed usage
    let tooltip = `${this.formatTokens(usage.contextTokens)} / ${this.formatTokens(usage.contextWindow)}`;
    if (usage.percentage > 80) {
      tooltip += ' (Approaching limit, run `/compact` to continue)';
    }
    this.container.setAttribute('data-tooltip', tooltip);
  }

  private formatTokens(tokens: number): string {
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}k`;
    }
    return String(tokens);
  }
}

export function createInputToolbar(
  parentEl: HTMLElement,
  callbacks: ToolbarCallbacks
): {
  modelSelector: ModelSelector;
  modeSelector: ModeSelector;
  thinkingBudgetSelector: ThinkingBudgetSelector;
  contextUsageMeter: ContextUsageMeter | null;
  externalContextSelector: ExternalContextSelector;
  mcpServerSelector: McpServerSelector;
  permissionToggle: PermissionToggle;
  serviceTierToggle: ServiceTierToggle;
} {
  const modelSelector = new ModelSelector(parentEl, callbacks);
  const thinkingBudgetSelector = new ThinkingBudgetSelector(parentEl, callbacks);
  const serviceTierToggle = new ServiceTierToggle(parentEl, callbacks);
  const contextUsageMeter = new ContextUsageMeter(parentEl);
  const externalContextSelector = new ExternalContextSelector(parentEl, callbacks);
  const mcpServerSelector = new McpServerSelector(parentEl);
  const permissionToggle = new PermissionToggle(parentEl, callbacks);
  const modeSelector = new ModeSelector(parentEl, callbacks);

  return {
    modelSelector,
    modeSelector,
    thinkingBudgetSelector,
    serviceTierToggle,
    contextUsageMeter,
    externalContextSelector,
    mcpServerSelector,
    permissionToggle,
  };
}
