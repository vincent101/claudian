import type { EventRef, WorkspaceLeaf } from 'obsidian';
import { ItemView, Notice, Scope, setIcon } from 'obsidian';

import { getHiddenProviderCommandSet } from '../../core/providers/commands/hiddenCommands';
import { resolveProviderPermissionMode } from '../../core/providers/permissionModes';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import { DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from '../../core/providers/types';
import { VIEW_TYPE_CLAUDIAN } from '../../core/types';
import { t } from '../../i18n/i18n';
import type ClaudianPlugin from '../../main';
import { createProviderIconSvg } from '../../shared/icons';
import { InputModal } from '../../shared/modals/InputModal';
import type { ConversationController, HistoryConversationOpenState } from './controllers/ConversationController';
import {
  closeHistorySearchForTab,
  getTabProviderId,
  onProviderAvailabilityChanged,
  openHistorySearchForTab,
  updatePlanModeUI,
} from './tabs/Tab';
import { TabBar } from './tabs/TabBar';
import { TabManager } from './tabs/TabManager';
import type { TabData, TabId } from './tabs/types';
import { refreshUsageContextWindow } from './utils/usageInfo';

export class ClaudianView extends ItemView {
  private plugin: ClaudianPlugin;

  // Tab management
  private tabManager: TabManager | null = null;
  private assemblyGeneration: object | null = null;
  private closeFlights?: WeakMap<TabManager, Promise<void>>;
  private tabBar: TabBar | null = null;
  private tabBarContainerEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;
  private navRowContent: HTMLElement | null = null;

  // DOM Elements
  private viewContainerEl: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private titleSlotEl: HTMLElement | null = null;
  private logoEl: HTMLElement | null = null;
  private titleTextEl: HTMLElement | null = null;
  private headerActionsEl: HTMLElement | null = null;
  private headerActionsContent: HTMLElement | null = null;

  // Header elements
  private historyDropdown: HTMLElement | null = null;
  private historyDropdownOwner: ConversationController | null = null;

  // Event refs for cleanup
  private eventRefs: EventRef[] = [];

  // Debouncing for tab bar updates
  private pendingTabBarUpdate: number | null = null;

  // Debouncing for tab state persistence
  private pendingPersist: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudianPlugin) {
    super(leaf);
    this.plugin = plugin;

    // Hover Editor compatibility: Define load as an instance method that can't be
    // overwritten by prototype patching. Hover Editor patches ClaudianView.prototype.load
    // after our class is defined, but instance methods take precedence over prototype methods.
    const originalLoad = Object.getPrototypeOf(this).load.bind(this);
    Object.defineProperty(this, 'load', {
      value: async () => {
        // Ensure containerEl exists before any patched load code tries to use it
        if (!this.containerEl) {
          (this as any).containerEl = createDiv({ cls: 'view-content' });
        }
        // Wrap in try-catch to prevent Hover Editor errors from breaking our view
        try {
          return await originalLoad();
        } catch {
          // Hover Editor may throw if its DOM setup fails - continue anyway
        }
      },
      writable: false,
      configurable: false,
    });
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN;
  }

  getDisplayText(): string {
    return 'Claudian';
  }

  getIcon(): string {
    return 'bot';
  }

  /** Refreshes model-dependent UI across all tabs (used after settings/env changes). */
  refreshModelSelector(): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      onProviderAvailabilityChanged(tab, this.plugin);
      const providerId = getTabProviderId(tab, this.plugin);
      const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
        this.plugin.settings as unknown as Record<string, unknown>,
        providerId,
      );
      const model = providerSettings.model as string;
      const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
      const capabilities = ProviderRegistry.getCapabilities(providerId);

      if (tab.state.usage) {
        // Re-derive each tab's denominator from the model its selector shows
        // (the provider's current model here): the selector is the single
        // denominator source (2.3.2 ②, user ruling 2026-09-17), and a
        // preset-window change applies to every open conversation.
        tab.state.usage = refreshUsageContextWindow(tab.state.usage, {
          uiConfig,
          settings: providerSettings,
          selectorModel: model,
        });
      }

      tab.ui.modelSelector?.updateDisplay();
      tab.ui.modelSelector?.renderOptions();
      tab.ui.modeSelector?.updateDisplay();
      tab.ui.modeSelector?.renderOptions();
      tab.ui.thinkingBudgetSelector?.updateDisplay();
      tab.ui.permissionToggle?.updateDisplay();
      tab.ui.serviceTierToggle?.updateDisplay();
      tab.dom.inputWrapper.toggleClass(
        'claudian-input-plan-mode',
        providerSettings.permissionMode === 'plan' && capabilities.supportsPlanMode,
      );
    }

    this.tabManager?.primeProviderRuntime();
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId[]): void {
    this.tabManager?.invalidateProviderCommandCaches(providerIds);
  }

  /** Updates provider-scoped hidden commands on all tabs after settings changes. */
  updateHiddenProviderCommands(): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.ui.slashCommandDropdown?.setHiddenCommands(
        getHiddenProviderCommandSet(this.plugin.settings, getTabProviderId(tab, this.plugin)),
      );
    }
  }

  async onOpen() {
    // Guard: Hover Editor and similar plugins may call onOpen before DOM is ready.
    // containerEl must exist before we can access contentEl or create elements.
    if (!this.containerEl) {
      return;
    }

    const generation = {};
    this.assemblyGeneration = generation;

    // Use contentEl (standard Obsidian API) as primary target.
    // Hover Editor and other plugins may modify the DOM structure,
    // so we need fallbacks to handle non-standard scenarios.
    let container: HTMLElement | null =
      this.contentEl ?? (this.containerEl.children[1] as HTMLElement | null);

    if (!container) {
      // Last resort: create our own container inside containerEl
      container = this.containerEl.createDiv();
    }

    this.viewContainerEl = container;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('claudian-container');

    const header = this.viewContainerEl.createDiv({ cls: 'claudian-header' });
    this.buildHeader(header);

    this.navRowContent = this.buildNavRowContent();
    this.tabContentEl = this.viewContainerEl.createDiv({ cls: 'claudian-tab-content-container' });

    let tabManager: TabManager | null = null;
    const isCurrent = () => this.isCurrentManager(tabManager, generation);
    tabManager = new TabManager(
      this.plugin,
      this.tabContentEl,
      this,
      {
        onTabCreated: () => {
          if (!isCurrent()) return;
          this.updateTabBar();
          this.updateNavRowLocation();
          this.persistTabState();
          this.syncProviderBrandColor();
        },
        onTabSwitched: () => {
          if (!isCurrent()) return;
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateNavRowLocation();
          this.persistTabState();
          this.syncProviderBrandColor();
        },
        onTabClosed: () => {
          if (!isCurrent()) return;
          this.updateTabBar();
          this.persistTabState();
        },
        onTabStreamingChanged: () => { if (isCurrent()) this.updateTabBar(); },
        onTabReviewChanged: () => { if (isCurrent()) this.updateTabBar(); },
        onTabTitleChanged: () => { if (isCurrent()) this.updateTabBar(); },
        onTabAttentionChanged: () => { if (isCurrent()) this.updateTabBar(); },
        onTabConversationChanged: () => {
          if (!isCurrent()) return;
          this.updateTabBar();
          this.persistTabState();
          this.syncProviderBrandColor();
        },
        onTabProviderChanged: () => {
          if (!isCurrent()) return;
          this.updateTabBar();
          this.syncProviderBrandColor();
        },
        onTabOrderChanged: () => {
          if (!isCurrent()) return;
          // Badge numbers and close-fallback neighbours derive from Map order,
          // so a reorder must repaint the bar and persist the new openTabs
          // sequence in the same pass.
          this.updateTabBar();
          this.persistTabState();
        },
      }
    );

    this.tabManager = tabManager;
    this.wireEventHandlers();
    await this.restoreOrCreateTabs(tabManager, generation);
    if (this.assemblyGeneration !== generation || this.tabManager !== tabManager) return;
    this.syncProviderBrandColor();
    this.updateLayoutForPosition();
    tabManager.primeProviderRuntime();
  }

  onClose(): Promise<void> {
    const tabManager = this.tabManager;
    const tabBar = this.tabBar;
    if (!tabManager) return this.closeGeneration(null, tabBar);

    const existing = this.closeFlights?.get(tabManager);
    if (existing) return existing;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const flight = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    (this.closeFlights ??= new WeakMap()).set(tabManager, flight);
    void this.closeGeneration(tabManager, tabBar).then(resolve, reject);
    return flight;
  }

  private async closeGeneration(tabManager: TabManager | null, tabBar: TabBar | null): Promise<void> {
    // Seal admission before persistence yields, and keep cleanup tied to this generation.
    this.assemblyGeneration = null;
    const errors: unknown[] = [];
    const attempt = (operation: () => void): void => {
      try { operation(); } catch (error) { errors.push(error); }
    };
    attempt(() => tabManager?.beginClose());
    attempt(() => tabManager?.stopMarkdownDiagnostics());
    for (const tab of tabManager?.getAllTabs() ?? []) {
      try { tab.markdownRenderDiagnostics?.dispose(); } catch { /* diagnostics are isolated */ }
    }
    attempt(() => this.hideHistoryDropdown());
    if (this.pendingTabBarUpdate !== null) {
      attempt(() => cancelAnimationFrame(this.pendingTabBarUpdate!));
      this.pendingTabBarUpdate = null;
    }

    const refs = this.eventRefs;
    this.eventRefs = [];
    for (const ref of refs) attempt(() => this.plugin.app.vault.offref(ref));

    try { await this.persistTabStateImmediate(tabManager); } catch (error) { errors.push(error); }
    try { await tabManager?.destroy(); } catch (error) { errors.push(error); }
    if (this.tabManager === tabManager) this.tabManager = null;
    attempt(() => tabBar?.destroy());
    if (this.tabBar === tabBar) this.tabBar = null;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'View close failed');
  }

  // ============================================
  // UI Building
  // ============================================

  private buildHeader(header: HTMLElement) {
    this.headerEl = header;

    // Title slot container (logo + title or tabs)
    this.titleSlotEl = header.createDiv({ cls: 'claudian-title-slot' });

    // Logo (hidden when 2+ tabs) — populated by syncHeaderLogo()
    this.logoEl = this.titleSlotEl.createSpan({ cls: 'claudian-logo' });
    this.syncHeaderLogo(DEFAULT_CHAT_PROVIDER_ID);

    // Title text (hidden in header mode when 2+ tabs)
    this.titleTextEl = this.titleSlotEl.createEl('h4', { text: 'Claudian', cls: 'claudian-title-text' });

    // Header actions container (for header mode - initially hidden)
    this.headerActionsEl = header.createDiv({ cls: 'claudian-header-actions claudian-header-actions-slot' });
    this.headerActionsEl.style.display = 'none';
  }

  /**
   * Builds the nav row content (tab badges + header actions).
   * This is called once and the content is moved between locations.
   */
  private buildNavRowContent(): HTMLElement {
    const generation = this.assemblyGeneration;
    const isCurrent = () => this.isCurrentManager(this.tabManager, generation);
    // Create a fragment to hold nav row content
    const fragment = document.createDocumentFragment();

    // Tab badges (left side in nav row, or in title slot for header mode)
    this.tabBarContainerEl = document.createElement('div');
    this.tabBarContainerEl.className = 'claudian-tab-bar-container';
    this.tabBar = new TabBar(this.tabBarContainerEl, {
      onTabClick: (tabId) => { if (isCurrent()) this.handleTabClick(tabId); },
      onTabClose: (tabId) => isCurrent() ? this.handleTabClose(tabId) : Promise.resolve(),
      onNewTab: () => isCurrent() ? this.createNewTab() : Promise.resolve(),
      onTabReorder: (tabId, targetIndex) => { if (isCurrent()) this.handleTabReorder(tabId, targetIndex); },
      onTabRename: (tabId) => { if (isCurrent()) this.handleTabRename(tabId); },
    });
    fragment.appendChild(this.tabBarContainerEl);

    // Header actions (right side)
    this.headerActionsContent = document.createElement('div');
    this.headerActionsContent.className = 'claudian-header-actions';

    // New tab button (plus icon)
    const newTabBtn = this.headerActionsContent.createDiv({ cls: 'claudian-header-btn claudian-new-tab-btn' });
    setIcon(newTabBtn, 'square-plus');
    newTabBtn.setAttribute('aria-label', 'New tab');
    newTabBtn.addEventListener('click', async () => {
      if (isCurrent()) await this.createNewTab();
    });

    // New conversation button (square-pen icon - new conversation in current tab)
    const newBtn = this.headerActionsContent.createDiv({ cls: 'claudian-header-btn' });
    setIcon(newBtn, 'square-pen');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', async () => {
      const tabManager = this.tabManager;
      if (!this.isCurrentManager(tabManager, generation)) return;
      await tabManager.createNewConversation();
      if (this.isCurrentManager(tabManager, generation)) this.updateHistoryDropdown();
    });

    // History dropdown
    const historyContainer = this.headerActionsContent.createDiv({ cls: 'claudian-history-container' });
    const historyBtn = historyContainer.createDiv({ cls: 'claudian-header-btn' });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Chat history');

    this.historyDropdown = historyContainer.createDiv({ cls: 'claudian-history-menu' });

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isCurrent()) this.toggleHistoryDropdown();
    });

    fragment.appendChild(this.headerActionsContent);

    // Create a wrapper div to hold the fragment (for input mode nav row)
    const wrapper = document.createElement('div');
    wrapper.style.display = 'contents';
    wrapper.appendChild(fragment);
    return wrapper;
  }

  /**
   * Moves nav row content based on tabBarPosition setting.
   * - 'input' mode: Both tab badges and actions go to active tab's navRowEl
   * - 'header' mode: Tab badges go to title slot (after logo), actions go to header right side
   */
  private updateNavRowLocation(): void {
    if (!this.tabBarContainerEl || !this.headerActionsContent) return;

    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    if (isHeaderMode) {
      // Header mode: Tab badges go to title slot, actions go to header right side
      if (this.titleSlotEl) {
        this.titleSlotEl.appendChild(this.tabBarContainerEl);
      }
      if (this.headerActionsEl) {
        this.headerActionsEl.appendChild(this.headerActionsContent);
        this.headerActionsEl.style.display = 'flex';
      }
    } else {
      // Input mode: Both go to active tab's navRowEl via the wrapper
      const activeTab = this.tabManager?.getActiveTab();
      if (activeTab && this.navRowContent) {
        // Re-assemble the nav row content wrapper
        this.navRowContent.appendChild(this.tabBarContainerEl);
        this.navRowContent.appendChild(this.headerActionsContent);
        activeTab.dom.navRowEl.appendChild(this.navRowContent);
      }
      // Hide header actions slot when in input mode
      if (this.headerActionsEl) {
        this.headerActionsEl.style.display = 'none';
      }
    }
  }

  /**
   * Updates layout when tabBarPosition setting changes.
   * Called from settings when user changes the tab bar position.
   */
  updateLayoutForPosition(): void {
    if (!this.viewContainerEl) return;

    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    // Update container class for CSS styling
    this.viewContainerEl.toggleClass('claudian-container--header-mode', isHeaderMode);

    // Move nav content to appropriate location
    this.updateNavRowLocation();

    // Update tab bar and title visibility
    this.updateTabBarVisibility();
  }

  // ============================================
  // Tab Management
  // ============================================

  private isCurrentManager(tabManager: TabManager | null, generation: object | null): tabManager is TabManager {
    return tabManager !== null
      && this.tabManager === tabManager
      && this.assemblyGeneration === generation
      && tabManager.isOpen();
  }

  private handleTabClick(tabId: TabId): void {
    const tabManager = this.tabManager;
    if (this.isCurrentManager(tabManager, this.assemblyGeneration)) void tabManager.switchToTab(tabId);
  }

  private async handleTabClose(tabId: TabId): Promise<void> {
    const tabManager = this.tabManager;
    const generation = this.assemblyGeneration;
    if (!this.isCurrentManager(tabManager, generation)) return;
    const tab = tabManager.getTab(tabId);
    // If streaming, treat close like user interrupt (force close cancels the stream)
    const force = tab?.state.isStreaming ?? false;
    await tabManager.closeTab(tabId, force);
    if (this.isCurrentManager(tabManager, generation)) this.updateTabBarVisibility();
  }

  /**
   * Reorders a tab (drag-drop or context-menu move). UI refresh and
   * persistence hang off the manager's onTabOrderChanged so every moveTab
   * caller — not just the tab bar — stays consistent.
   */
  private handleTabReorder(tabId: TabId, targetIndex: number): void {
    const tabManager = this.tabManager;
    if (this.isCurrentManager(tabManager, this.assemblyGeneration)) tabManager.moveTab(tabId, targetIndex);
  }

  private handleTabRename(tabId: TabId): void {
    const tabManager = this.tabManager;
    const generation = this.assemblyGeneration;
    if (!this.isCurrentManager(tabManager, generation)) return;
    const tab = tabManager.getTab(tabId);
    const conversationId = tab?.conversationId;
    if (!conversationId) return;
    const isCurrent = () => this.isCurrentManager(tabManager, generation)
      && tabManager.getTab(tabId) === tab
      && tab.conversationId === conversationId;

    const currentTitle = this.plugin.getConversationSync(conversationId)?.title;
    new InputModal(this.app, {
      value: currentTitle ?? '',
      onSubmit: async (raw) => {
        const title = raw.trim();
        if (!title || title === currentTitle || !isCurrent()) return;
        try {
          await this.plugin.renameConversationManually(conversationId, title);
          if (!isCurrent()) return;
          this.updateTabBar();
          this.updateHistoryDropdown();
        } catch {
          new Notice(t('chat.tabs.renameTitleFailed'));
        }
      },
    }).open();
  }

  async createNewTab(): Promise<void> {
    const tabManager = this.tabManager;
    const generation = this.assemblyGeneration;
    if (!this.isCurrentManager(tabManager, generation)) return;
    const tab = await tabManager.createTab();
    if (!this.isCurrentManager(tabManager, generation)) return;
    if (!tab) {
      const maxTabs = this.plugin.settings.maxTabs ?? 3;
      new Notice(`Maximum ${maxTabs} tabs allowed`);
      return;
    }
    this.updateTabBarVisibility();
  }

  onConversationSizePublished(conversationId: string): void {
    if (!this.tabManager) return;
    if (this.historyDropdown) {
      this.tabManager.getActiveTab()?.controllers.conversationController
        ?.onConversationSizePublished(conversationId, this.historyDropdown);
    }
  }

  private updateTabBar(): void {
    const tabManager = this.tabManager;
    const tabBar = this.tabBar;
    const generation = this.assemblyGeneration;
    if (!tabBar || !this.isCurrentManager(tabManager, generation)) return;

    // Debounce tab bar updates using requestAnimationFrame
    if (this.pendingTabBarUpdate !== null) {
      cancelAnimationFrame(this.pendingTabBarUpdate);
    }

    const frame: number = requestAnimationFrame(() => {
      if (this.pendingTabBarUpdate !== frame) return;
      this.pendingTabBarUpdate = null;
      if (!this.isCurrentManager(tabManager, generation) || this.tabBar !== tabBar) return;

      const items = tabManager.getTabBarItems();
      tabBar.update(items);
      this.updateTabBarVisibility();
    });
    this.pendingTabBarUpdate = frame;
  }

  private updateTabBarVisibility(): void {
    if (!this.tabBarContainerEl || !this.tabManager) return;

    const tabCount = this.tabManager.getTabCount();
    const showTabBar = tabCount >= 2;
    const isHeaderMode = this.plugin.settings.tabBarPosition === 'header';

    // Hide tab badges when only 1 tab, show when 2+
    this.tabBarContainerEl.style.display = showTabBar ? 'flex' : 'none';

    // In header mode, badges replace logo/title in the same location
    // In input mode, keep logo/title visible (badges are in nav row)
    const hideBranding = showTabBar && isHeaderMode;
    if (this.logoEl) {
      this.logoEl.style.display = hideBranding ? 'none' : '';
    }
    if (this.titleTextEl) {
      this.titleTextEl.style.display = hideBranding ? 'none' : '';
    }
  }

  /** Sets `data-provider` on the root container so CSS brand color follows the active provider. */
  private syncProviderBrandColor(): void {
    if (!this.viewContainerEl) return;
    const activeTab = this.tabManager?.getActiveTab();
    const providerId = activeTab ? getTabProviderId(activeTab, this.plugin) : DEFAULT_CHAT_PROVIDER_ID;
    this.viewContainerEl.dataset.provider = providerId;
    this.syncHeaderLogo(providerId);
  }

  /** Rebuilds the header logo SVG to match the given provider. */
  private syncHeaderLogo(providerId: ProviderId): void {
    if (!this.logoEl) return;
    const icon = ProviderRegistry.getChatUIConfig(providerId).getProviderIcon?.();
    if (!icon) return;
    const existing = this.logoEl.querySelector('svg');
    if (existing?.getAttribute('data-provider') === providerId) return;
    this.logoEl.empty();
    const svg = createProviderIconSvg(icon, {
      dataProvider: providerId,
      height: 18,
      width: 18,
    });
    this.logoEl.appendChild(svg);
  }

  // ============================================
  // History Dropdown
  // ============================================

  onConversationDeleted(conversationId: string): void {
    this.historyDropdownOwner?.discardHistorySizeRow(conversationId);
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.controllers.conversationController?.discardHistorySizeRow?.(conversationId);
    }
  }

  private hideHistoryDropdown(): void {
    this.historyDropdown?.removeClass('visible');
    const owner = this.historyDropdownOwner ?? this.tabManager?.getActiveTab()?.controllers.conversationController;
    owner?.releaseHistorySizeRows?.(this.historyDropdown ?? undefined);
    this.historyDropdownOwner = null;
  }

  private toggleHistoryDropdown(): void {
    if (!this.historyDropdown) return;

    const isVisible = this.historyDropdown.hasClass('visible');
    if (isVisible) {
      this.hideHistoryDropdown();
    } else {
      this.updateHistoryDropdown(true);
      this.historyDropdown.addClass('visible');
    }
  }

  private updateHistoryDropdown(refreshSizes = false): void {
    const tabManager = this.tabManager;
    const generation = this.assemblyGeneration;
    const dropdown = this.historyDropdown;
    if (!dropdown || !this.isCurrentManager(tabManager, generation)) return;
    const activeTab = tabManager.getActiveTab();
    const conversationController = activeTab?.controllers.conversationController ?? null;
    const ownsRows = refreshSizes || dropdown.hasClass('visible');
    if (this.historyDropdownOwner && (!ownsRows || this.historyDropdownOwner !== conversationController)) {
      this.historyDropdownOwner.releaseHistorySizeRows(dropdown);
    }
    this.historyDropdownOwner = ownsRows ? conversationController : null;
    dropdown.empty();

    if (conversationController) {
      const isCurrent = () => this.isCurrentManager(tabManager, generation)
        && this.historyDropdown === dropdown
        && tabManager.getActiveTab() === activeTab
        && activeTab?.controllers.conversationController === conversationController;
      conversationController.renderHistoryDropdown(dropdown, {
        refreshSizes,
        onSelectConversation: (id) => isCurrent() ? this.openHistoryConversation(id) : Promise.resolve(),
        onOpenConversationInNewTab: (id, activate) => isCurrent()
          ? this.openHistoryConversationInNewTab(id, activate) : Promise.resolve(),
        getConversationOpenState: (id) => isCurrent() ? this.getHistoryConversationOpenState(id) : 'closed',
      });
    }
  }

  private async openHistoryConversation(conversationId: string): Promise<void> {
    const tabManager = this.tabManager;
    const generation = this.assemblyGeneration;
    if (!this.isCurrentManager(tabManager, generation)) return;
    await tabManager.openConversation(conversationId);
    if (this.isCurrentManager(tabManager, generation)) this.hideHistoryDropdown();
  }

  private async openHistoryConversationInNewTab(
    conversationId: string,
    activate = true,
  ): Promise<void> {
    const tabManager = this.tabManager;
    const generation = this.assemblyGeneration;
    if (!this.isCurrentManager(tabManager, generation)) return;
    await tabManager.openConversation(conversationId, {
      preferNewTab: true,
      activate,
    });
    if (this.isCurrentManager(tabManager, generation)) this.hideHistoryDropdown();
  }

  private getHistoryConversationOpenState(conversationId: string): HistoryConversationOpenState {
    const activeTab = this.tabManager?.getActiveTab();
    if (activeTab?.conversationId === conversationId) {
      return 'current';
    }

    if (this.findTabWithConversation(conversationId)) {
      return 'open';
    }

    const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
    if (crossViewResult && crossViewResult.view !== this) {
      return 'open';
    }

    return 'closed';
  }

  private findTabWithConversation(conversationId: string): TabData | null {
    const tabs = this.tabManager?.getAllTabs() ?? [];
    return tabs.find(tab => tab.conversationId === conversationId) ?? null;
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers(): void {
    const tabManager = this.tabManager;
    const generation = this.assemblyGeneration;
    const isCurrent = () => this.isCurrentManager(tabManager, generation);
    // Document-level click to close dropdowns
    this.registerDomEvent(document, 'click', () => {
      if (isCurrent()) this.hideHistoryDropdown();
    });

    // View-level Shift+Tab to toggle plan mode (works from any focused element)
    this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
      if (!isCurrent()) return;
      if (e.key === 'Tab' && e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const activeTab = this.tabManager?.getActiveTab();
        if (!activeTab) return;
        const providerId = getTabProviderId(activeTab, this.plugin);
        if (!ProviderRegistry.getCapabilities(providerId).supportsPlanMode) return;
        const current = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
          this.plugin.settings as unknown as Record<string, unknown>,
          providerId,
        ).permissionMode as string;
        if (current === 'plan') {
          // Shift+Tab fallback (§5.3): a lost restore value falls back to the
          // provider's fail-closed mode (Manual for Claude), never YOLO/Auto.
          const policy = ProviderRegistry.getChatUIConfig(providerId).permissionModes;
          const prePlan = activeTab.state.prePlanPermissionMode;
          const restoreMode = policy && prePlan
            ? resolveProviderPermissionMode(policy, prePlan, {}) ?? policy.fallbackValue
            : policy?.fallbackValue ?? 'normal';
          activeTab.state.prePlanPermissionMode = null;
          updatePlanModeUI(activeTab, this.plugin, restoreMode);
        } else {
          activeTab.state.prePlanPermissionMode = current;
          updatePlanModeUI(activeTab, this.plugin, 'plan');
        }
      }
    });

    // Register Escape on the view's Obsidian Scope to prevent Obsidian from
    // navigating away when Claudian is open as a main-area tab.
    // Returning false consumes the event (preventDefault + stops scope propagation).
    this.scope = new Scope(this.app.scope);
    // Mod+F for the in-place history search must ride the view scope: Obsidian's
    // keymap consumes Mod+F at window capture (default editor:open-search hotkey
    // dispatch), so the controller's document-capture fallback never sees it.
    // The view scope outranks app scope exactly while this view is the active
    // leaf, and modals push their own scope so the shortcut stays gated.
    this.scope.register(['Mod'], 'F', () => {
      if (!isCurrent()) return;
      const activeTab = tabManager?.getActiveTab();
      if (activeTab && openHistorySearchForTab(activeTab)) return false;
    });
    this.scope.register([], 'Escape', () => {
      if (!isCurrent()) return;
      const activeTab = tabManager?.getActiveTab();
      // An open history-search panel outranks streaming-cancel in Escape
      // arbitration; both consume the event.
      if (activeTab && closeHistorySearchForTab(activeTab)) return false;
      // An open permission menu closes first; the second Escape resumes the
      // old cancel behavior (§5.3 arbitration).
      if (activeTab?.ui.permissionToggle?.isMenuOpen()) {
        activeTab.ui.permissionToggle.closeMenu();
        return false;
      }
      if (activeTab?.state.isStreaming) {
        activeTab.controllers.inputController?.cancelStreaming();
      }
      return false;
    });

    // Vault events - forward to active tab's file context manager
    const markCacheDirty = (includesFolders: boolean): void => {
      if (!isCurrent()) return;
      const mgr = tabManager?.getActiveTab()?.ui.fileContextManager;
      if (!mgr) return;
      mgr.markFileCacheDirty();
      if (includesFolders) mgr.markFolderCacheDirty();
    };
    this.eventRefs.push(
      this.plugin.app.vault.on('create', () => markCacheDirty(true)),
      this.plugin.app.vault.on('delete', () => markCacheDirty(true)),
      this.plugin.app.vault.on('rename', () => markCacheDirty(true)),
      this.plugin.app.vault.on('modify', () => markCacheDirty(false))
    );

    // File open event
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file && isCurrent()) {
          tabManager?.getActiveTab()?.ui.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    // Click outside to close mention dropdown
    this.registerDomEvent(document, 'click', (e) => {
      if (!isCurrent()) return;
      const activeTab = tabManager?.getActiveTab();
      if (activeTab) {
        const fcm = activeTab.ui.fileContextManager;
        if (fcm && !fcm.containsElement(e.target as Node) && e.target !== activeTab.dom.inputEl) {
          fcm.hideMentionDropdown();
        }
      }
    });
  }

  // ============================================
  // Persistence
  // ============================================

  private async restoreOrCreateTabs(tabManager: TabManager, generation: object): Promise<void> {
    // A delayed restore must keep the manager from its original view generation.
    const persistedState = await this.plugin.storage.getTabManagerState();
    if (this.assemblyGeneration !== generation || this.tabManager !== tabManager) return;
    if (persistedState && persistedState.openTabs.length > 0) {
      await tabManager.restoreState(persistedState);
      return;
    }

    // Fallback: create a new empty tab
    await tabManager.createTab();
  }

  private persistTabState(): void {
    const tabManager = this.tabManager;
    const generation = this.assemblyGeneration;
    if (!this.isCurrentManager(tabManager, generation)) return;
    // Debounce persistence to avoid rapid writes (300ms delay)
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
    }
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (this.pendingPersist !== timer) return;
      this.pendingPersist = null;
      if (!this.isCurrentManager(tabManager, generation)) return;
      const state = tabManager.getPersistedState();
      this.plugin.persistTabManagerState(state).catch(() => {
        // Silently ignore persistence errors
      });
    }, 300);
    this.pendingPersist = timer;
  }

  /** Force immediate persistence (for onClose/onunload). */
  private async persistTabStateImmediate(tabManager: TabManager | null): Promise<void> {
    // Cancel any pending debounced persist
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
      this.pendingPersist = null;
    }
    if (!tabManager) return;
    const state = tabManager.getPersistedState();
    await this.plugin.persistTabManagerState(state);
  }

  // ============================================
  // Public API
  // ============================================

  /** Explicit, rate-limited census of one tab's message subtree. */
  sampleMarkdownRenderDom(tabId: TabId): void {
    const tab = this.tabManager?.getTab(tabId);
    if (!tab?.markdownRenderDiagnostics) return;
    try {
      tab.markdownRenderDiagnostics.collector.sampleDom(tab.dom.messagesEl);
    } catch {
      try { tab.markdownRenderDiagnostics.collector.disable(); } catch { /* diagnostics are isolated */ }
    }
  }

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Gets the tab manager. */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }
}
