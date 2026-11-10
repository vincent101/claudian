import { Notice } from 'obsidian';

import {
  type CommandDiscoveryTarget,
  type CommandDiscoveryToken,
  type CommandTargetCapture,
  type CommandTargetReadContext,
} from '../../../core/providers/commands/ProviderCommandDiscovery';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import {
  type ProviderId,
  type ProviderTabWarmupContext,
  type ProviderTabWarmupMode,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { Conversation, SlashCommand } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';
import { chooseForkTarget } from '../../../shared/modals/ForkTargetModal';
import { getVaultPath } from '../../../utils/path';
import type { AskRelayPendingInfo } from '../services/AskRelayService';
import type { CloseSaveOutcome } from '../state/types';
import type { ReservationWitness } from '../state/types';
import { type ConversationOpenClaim, ConversationOpenRegistry } from './ConversationOpenRegistry';
import { type DesktopNotificationKind,notifyBackgroundTabStateChange } from './desktopNotifier';
import { getTabProviderId } from './providerResolution';
import { syncRuntimeUnderAdoption } from './runtimeAdoptionSync';
import {
  activateTab,
  cleanupTabRuntime,
  createTab,
  deactivateTab,
  destroyTab,
  type ForkContext,
  getTabTitle,
  initializeTabControllers,
  initializeTabService,
  initializeTabUI,
  renderTabHydrationPlaceholder,
  setupServiceCallbacks,
  subscribeTabCommandContextChanges,
  wireTabInputEvents,
} from './Tab';
import {
  DEFAULT_MAX_TABS,
  MAX_TABS,
  MIN_TABS,
  type PersistedTabManagerState,
  type PersistedTabState,
  type TabBarItem,
  type TabData,
  type TabHydrationState,
  type TabId,
  type TabManagerCallbacks,
  type TabManagerInterface,
  type TabManagerViewHost,
} from './types';

function isTabManagerViewHost(value: unknown): value is TabManagerViewHost {
  return !!value
    && typeof value === 'object'
    && 'getTabManager' in (value as Record<string, unknown>);
}

type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
  draftProviderId?: ProviderId;
  shouldContinue?: () => boolean;
};

type OpenConversationOptions = {
  preferNewTab?: boolean;
  activate?: boolean;
};

type ProviderCommandCacheEntry = {
  commands: SlashCommand[];
  key: string;
};

type ProviderWarmupContext = {
  conversation: Conversation | null;
  externalContextPaths: string[];
  runtime: ChatRuntime | null;
  tab: ProviderTabWarmupContext['tab'];
  warmupMode: ProviderTabWarmupMode;
};

type ProviderCommandContext = ProviderWarmupContext & {
  cacheKey: string;
};

type ProviderCommandWarmupEntry = {
  key: string;
  promise: Promise<SlashCommand[]>;
};

type ProviderCommandTicket = {
  key: string;
};

/**
 * Per-tab command capture controller (§6 W4c): one entry per tab holds the
 * eligibility AbortController (revoked on every invalidation), an opaque
 * target token, the capture listeners, and the last frozen context key so a
 * context change detected inside capture() revokes the old ticket first.
 */
type TabCommandCaptureEntry = {
  controller: AbortController;
  targetToken: CommandDiscoveryToken;
  listeners: Set<() => void>;
  lastContextKey: string | null;
};

/**
 * TabManager coordinates multiple chat tabs.
 */
export class TabManager implements TabManagerInterface {
  private plugin: ClaudianPlugin;
  private containerEl: HTMLElement;
  private view: TabManagerViewHost;

  private tabs: Map<TabId, TabData> = new Map();
  private activeTabId: TabId | null = null;
  private callbacks: TabManagerCallbacks;
  private providerCommandWarmups = new Map<TabId, ProviderCommandWarmupEntry>();
  private providerCommandCache = new Map<TabId, ProviderCommandCacheEntry>();
  private readonly providerCommandTickets = new WeakMap<TabData, ProviderCommandTicket>();
  private readonly providerCommandGenerations = new WeakMap<TabData, number>();
  private readonly tabCommandCaptures = new WeakMap<TabData, TabCommandCaptureEntry>();
  private readonly commandCatalogUnsubscribers = new Map<ProviderId, () => void>();
  private isRestoringState = false;
  private markdownDiagnosticsEnabled = true;
  private readonly conversationOpenRegistry: ConversationOpenRegistry;
  private pendingConversationClaims = new Map<TabData, ConversationOpenClaim>();
  private readonly candidateTabs = new Set<TabData>();
  private readonly cleanupFlights = new WeakMap<TabData, Promise<void>>();
  private readonly closeFlights = new WeakMap<TabData, Promise<boolean>>();
  private readonly closeSaveFlights = new Map<TabData, Promise<void>>();
  private retirementState: 'open' | 'retiring' | 'retired' = 'open';
  private retiringTabs: TabData[] = [];
  private acceptedSavesAtClose: Promise<void>[] = [];
  /** R2 close plans: per-tab sealed binding completions (P6 §4.5 sealForClose). */
  private readonly closeSavePlans: Promise<readonly CloseSaveOutcome[]>[] = [];
  private readonly closeErrors: unknown[] = [];
  private destroyFlight: Promise<void> | null = null;

  /** Guard to prevent concurrent tab switches. */
  private isSwitchingTab = false;

  /**
   * Gets the current max tabs limit from settings.
   * Clamps to MIN_TABS and MAX_TABS bounds.
   */
  private getMaxTabs(): number {
    const settingsValue = this.plugin.settings.maxTabs ?? DEFAULT_MAX_TABS;
    return Math.max(MIN_TABS, Math.min(MAX_TABS, settingsValue));
  }

  /**
   * Fires a desktop notification for a background tab state edge.
   * The index is the 1-based position the tab bar shows for this tab.
   */
  private notifyBackgroundTab(tab: TabData, kind: DesktopNotificationKind): void {
    const tabIndex = Array.from(this.tabs.keys()).indexOf(tab.id) + 1;
    if (tabIndex === 0) {
      return;
    }

    notifyBackgroundTabStateChange({
      plugin: this.plugin,
      kind,
      tabIndex,
      tabTitle: getTabTitle(tab, this.plugin),
    });
  }

  /**
   * Ask-pending detail notification: a user-turn ask armed the relay and
   * stayed unanswered past the attention window. Unlike
   * notifyBackgroundTabStateChange edges this fires for the active tab too —
   * the user has likely left the desk and the notification body (summary +
   * relay nonce) is the phone channel's entry point.
   */
  private notifyAskPending(tab: TabData, pending: AskRelayPendingInfo): void {
    const tabIndex = Array.from(this.tabs.keys()).indexOf(tab.id) + 1;
    if (tabIndex === 0) {
      return;
    }

    notifyBackgroundTabStateChange({
      plugin: this.plugin,
      kind: 'needsAttention',
      tabIndex,
      tabTitle: getTabTitle(tab, this.plugin),
      detail: `${pending.summary} · nonce ${pending.nonce}`,
    });
  }

  constructor(
    plugin: ClaudianPlugin,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks?: TabManagerCallbacks,
  );
  constructor(
    plugin: ClaudianPlugin,
    legacyArg: unknown,
    containerEl: HTMLElement,
    view: TabManagerViewHost,
    callbacks?: TabManagerCallbacks,
  );
  constructor(
    plugin: ClaudianPlugin,
    arg2: HTMLElement | unknown,
    arg3: HTMLElement | TabManagerViewHost,
    arg4?: TabManagerViewHost | TabManagerCallbacks,
    arg5: TabManagerCallbacks = {},
  ) {
    this.plugin = plugin;
    this.conversationOpenRegistry = plugin.conversationOpenRegistry ?? new ConversationOpenRegistry();

    if (isTabManagerViewHost(arg3)) {
      this.containerEl = arg2 as HTMLElement;
      this.view = arg3;
      this.callbacks = (arg4 as TabManagerCallbacks | undefined) ?? {};
      return;
    }

    this.containerEl = arg3 as HTMLElement;
    this.view = arg4 as TabManagerViewHost;
    this.callbacks = arg5;
  }

  isOpen(): boolean {
    return this.retirementState === 'open';
  }

  private isTabActive(tab: TabData): boolean {
    return this.isOpen()
      && tab.lifecycleState !== 'closing'
      && !this.cleanupFlights.has(tab)
      && (this.tabs.get(tab.id) === tab || this.candidateTabs.has(tab));
  }

  /** Revokes local admission synchronously while leaving tab state readable. */
  beginClose(): void {
    if (!this.isOpen()) return;
    this.retirementState = 'retiring';
    this.stopMarkdownDiagnostics();
    this.retiringTabs = Array.from(new Set([...this.tabs.values(), ...this.candidateTabs]));
    const accepted = new Set<Promise<void>>();
    for (const tab of this.retiringTabs) {
      try {
        for (const save of tab.controllers.conversationController?.snapshotAcceptedSaves?.() ?? []) {
          accepted.add(save);
        }
        const closeSave = this.closeSaveFlights.get(tab);
        if (closeSave) accepted.add(closeSave);
      } catch (error) {
        this.closeErrors.push(error);
      }
    }
    this.acceptedSavesAtClose = Array.from(accepted);
    for (const save of this.acceptedSavesAtClose) void save.catch(() => {});
    // R2 close plan: seal each still-installed tab's binding synchronously so
    // the final save captures from the committed binding — an outgoing shell
    // can never read a runtime a later rebind owns. Tabs already in their
    // cleanup flight keep riding their own close-save instead.
    for (const tab of this.retiringTabs) {
      if (this.tabs.get(tab.id) !== tab || this.cleanupFlights.has(tab)) continue;
      try {
        this.closeSavePlans.push(...(tab.controllers.conversationController?.sealForCloseSave?.() ?? []));
      } catch (error) {
        this.closeErrors.push(error);
      }
    }
    // Revoke command eligibility and settle capture waiters before any UI is
    // destroyed: a pending typed read must go stale in this round (§6 W4c).
    for (const tab of this.retiringTabs) {
      try {
        this.invalidateProviderCommandState(tab);
      } catch (error) {
        this.closeErrors.push(error);
      }
    }
    for (const tab of this.retiringTabs) {
      try {
        tab.ui.slashCommandDropdown?.destroy();
      } catch (error) {
        this.closeErrors.push(error);
      }
    }
  }

  // ============================================
  // Tab Lifecycle
  // ============================================

  /**
   * Creates a new tab.
   * @param conversationId Optional conversation to load into the tab.
   * @param tabId Optional tab ID (for restoration).
   * @param options Controls whether the new tab becomes active immediately.
   * @returns The created tab, or null if max tabs reached.
   */
  async createTab(
    conversationId?: string | null,
    tabId?: TabId,
    options: CreateTabOptions = {},
  ): Promise<TabData | null> {
    if (!this.isOpen() || options.shouldContinue?.() === false) return null;
    const maxTabs = this.getMaxTabs();
    if (this.tabs.size >= maxTabs) {
      return null;
    }

    const { activate = true, draftModel, draftProviderId } = options;

    const conversation = conversationId
      ? this.plugin.getConversationSync(conversationId) ?? undefined
      : undefined;

    // Inherit the active tab's provider so the new blank tab picks up its model
    const activeTab = this.getActiveTab();
    const defaultProviderId = conversation
      ? undefined
      : (activeTab ? getTabProviderId(activeTab, this.plugin) : undefined);

    const tab = createTab({
      plugin: this.plugin,
      containerEl: this.containerEl,
      conversation: conversation ?? undefined,
      tabId,
      ...(typeof draftModel === 'string' ? { draftModel } : {}),
      ...(typeof draftProviderId === 'string' ? { draftProviderId } : {}),
      defaultProviderId,
      onStreamingChanged: (isStreaming) => {
        // UI busy-state sync only: false also fires on cancel, invalidation
        // and startup failures, so it must not be read as turn completion.
        if (this.isTabActive(tab)) this.callbacks.onTabStreamingChanged?.(tab.id, isStreaming);
      },
      onTurnCompleted: (event) => {
        if (!this.isTabActive(tab)) return;
        // Completion-notification policy: only a successfully finished turn
        // that ran while the tab was in the background marks it for review
        // and notifies. The per-tab last-notified id deduplicates replays
        // (observer restarts, repeated finished callbacks); switching tabs
        // clears needsReview but never this id.
        if (tab.lastNotifiedCompletedTurnId === event.turnId) {
          return;
        }
        tab.lastNotifiedCompletedTurnId = event.turnId;
        if (tab.id === this.activeTabId) {
          return;
        }
        tab.state.needsReview = true;
        this.callbacks.onTabReviewChanged?.(tab.id, true);
        this.notifyBackgroundTab(tab, 'streamComplete');
      },
      onTitleChanged: (title) => {
        if (this.isTabActive(tab)) this.callbacks.onTabTitleChanged?.(tab.id, title);
      },
      onAttentionChanged: (needsAttention) => {
        if (!this.isTabActive(tab)) return;
        if (needsAttention && tab.id !== this.activeTabId) {
          this.notifyBackgroundTab(tab, 'needsAttention');
        }
        this.callbacks.onTabAttentionChanged?.(tab.id, needsAttention);
      },
      onAskAttentionTimeout: (pending) => {
        if (this.isTabActive(tab)) this.notifyAskPending(tab, pending);
      },
      onConversationIdChanged: (conversationId) => {
        // An accepted save still owns its local bookkeeping after retirement.
        tab.conversationId = conversationId;
        if (this.isTabActive(tab)) this.callbacks.onTabConversationChanged?.(tab.id, conversationId);
      },
    });

    // Subscribe to the tab's command-context commits (runtime install/remove,
    // binding and directory changes) before the UI exists: every notification
    // revokes stale manager-side command eligibility synchronously (§6 W4c).
    // Unsubscribe rides the tab's own event cleanups (destroyTab).
    tab.dom.eventCleanups.push(subscribeTabCommandContextChanges(tab, () => {
      this.invalidateProviderCommandState(tab);
    }));

    this.candidateTabs.add(tab);
    const canContinue = () => this.isTabActive(tab) && (options.shouldContinue?.() ?? true);
    const abandonCandidate = async (): Promise<null> => {
      if (this.isOpen() && this.candidateTabs.has(tab)) {
        await this.cleanupTabOnce(tab);
        this.candidateTabs.delete(tab);
      }
      return null;
    };
    try {
      if (conversation) {
        const reserved = await this.reserveConversationForTab(tab, conversation.id);
        if (!canContinue()) return await abandonCandidate();
        if (reserved) {
          this.commitConversationForTab(tab, conversation.id);
        } else {
          tab.conversationId = null;
          tab.state.currentConversationId = null;
          tab.lifecycleState = 'blank';
          tab.hydrationState = 'READY';
        }
      }

      // A colliding candidate must not replace a live TabData or its claim.
      if (this.tabs.has(tab.id)) {
        await this.cleanupTabOnce(tab);
        this.candidateTabs.delete(tab);
        return null;
      }
      if (!canContinue()) return await abandonCandidate();

      initializeTabUI(tab, this.plugin, {
        getProviderCatalogConfig: () => this.getProviderCatalogConfig(tab),
        onProviderChanged: (providerId) => {
          if (!this.isTabActive(tab)) return;
          this.invalidateProviderCommandState(tab);
          this.callbacks.onTabProviderChanged?.(tab.id, providerId);
          void this.prewarmProviderTab(tab).catch(() => {
            // Keep provider switching non-blocking even if command warmup fails.
          });
        },
      });
      if (!canContinue()) {
        tab.ui.slashCommandDropdown?.destroy();
        return await abandonCandidate();
      }

      initializeTabControllers(
        tab,
        this.plugin,
        this.view,
        (forkContext) => this.isTabActive(tab) ? this.handleForkRequest(forkContext, tab) : Promise.resolve(),
        (conversationId) => this.isTabActive(tab) ? this.openConversation(conversationId) : Promise.resolve(),
        () => this.getProviderCatalogConfig(tab),
        {
          isManagerActive: () => this.isTabActive(tab),
          markHydrationReady: () => {
            if (this.isTabActive(tab)) this.setHydrationState(tab, 'READY');
          },
          isHydrationReady: () => tab.hydrationState === 'READY',
          reserveConversation: (conversationId) => this.reserveConversationForTab(tab, conversationId),
          commitConversation: (conversationId) => this.commitConversationForTab(tab, conversationId),
          cancelConversationReservation: (conversationId) => this.cancelConversationForTab(tab, conversationId),
          releaseConversation: (conversationId) => this.releaseConversationForTab(tab, conversationId),
          getBindingReservation: (conversationId) => this.getBindingReservationForTab(tab, conversationId),
        },
        this.markdownDiagnosticsEnabled,
      );
      if (!canContinue()) return await abandonCandidate();

      wireTabInputEvents(tab, this.plugin);
      if (!canContinue()) return await abandonCandidate();

      if (conversation && tab.conversationId) {
        tab.state.currentConversationId = conversation.id;
        this.setHydrationState(tab, 'SHELL');
      }

      this.tabs.set(tab.id, tab);
      this.candidateTabs.delete(tab);
      // Resolve the subscription slot without a conversation read: the
      // TabData already carries the effective provider id at commit time.
      this.ensureCommandCatalogSubscription(tab.service?.providerId ?? tab.providerId);
      this.callbacks.onTabCreated?.(tab);
      if (!canContinue()) return null;

      if (!this.isRestoringState && (activate || !this.activeTabId)) {
        await this.switchToTab(tab.id);
      } else if (!this.isRestoringState) {
        this.maybePrimeProviderRuntime(tab);
      }

      return canContinue() ? tab : null;
    } catch (error) {
      if (this.isOpen() && this.candidateTabs.has(tab)) {
        try { await this.cleanupTabOnce(tab); } catch { /* Preserve the creation error. */ }
        this.candidateTabs.delete(tab);
      }
      throw error;
    }
  }

  /**
   * Switches to a different tab.
   * @param tabId The tab to switch to.
   */
  async switchToTab(tabId: TabId): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.isTabActive(tab)) {
      return;
    }

    // Guard against concurrent tab switches
    if (this.isSwitchingTab) {
      return;
    }

    this.isSwitchingTab = true;
    const previousTabId = this.activeTabId;

    try {
      // Deactivate current tab and invalidate any in-flight history writeback.
      if (previousTabId && previousTabId !== tabId) {
        const currentTab = this.tabs.get(previousTabId);
        if (currentTab) {
          currentTab.hydrationGeneration++;
          deactivateTab(currentTab);
        }
      }

      // Activate new tab
      this.activeTabId = tabId;
      activateTab(tab);
      if (!this.isTabActive(tab)) return;
      tab.state.needsReview = false;

      // Bound shells hydrate only from this activation path, after one frame.
      // SCHEDULED/LOADING tabs were invalidated by a previous switch-away
      // (generation++), so re-schedule here: without it they would hang in
      // the loading placeholder forever after switching back.
      if (
        tab.conversationId
        && (tab.hydrationState === 'SHELL'
          || tab.hydrationState === 'SCHEDULED'
          || tab.hydrationState === 'LOADING'
          || tab.hydrationState === 'ERROR')
      ) {
        this.scheduleTabHydration(tab);
      } else if (
        tab.conversationId
        && tab.hydrationState === 'READY'
        && tab.state.messages.length > 0
        && !tab.state.isStreaming
      ) {
        const conversation = this.plugin.getConversationSync(tab.conversationId);
        if (conversation) {
          // Passive sync is only safe once local tab state has been
          // persisted.
          if (tab.service && !tab.state.hasPendingConversationSave) {
            const hasMessages = conversation.hasHistory === true
              || (conversation.messageCount ?? conversation.messages.length) > 0;
            const externalContextPaths = hasMessages
              ? conversation.externalContextPaths || []
              : (this.plugin.settings.persistentExternalContextPaths || []);

            // R2: the passive re-sync on tab activation also runs under the
            // binding's adoption registry.
            const passiveService = tab.service;
            syncRuntimeUnderAdoption(
              tab,
              passiveService,
              () => { passiveService?.syncConversationState(conversation, externalContextPaths); },
              { conversationId: conversation.id },
            );
          }
          // The denominator refresh is read-only (provider settings plus
          // in-memory usage) and must not be postponed by a pending save
          // that keeps failing: a READY tab skipped full hydration, so a
          // stale stored usage denominator (e.g. 200k persisted before a
          // preset change) must not survive the switch back — re-derive
          // through the same refresh entry hydration uses.
          tab.controllers.conversationController?.refreshUsageWindow?.(conversation);
        }
      } else if (!tab.conversationId && tab.state.messages.length === 0) {
        // New tab with no conversation - initialize welcome greeting
        tab.controllers.conversationController?.initializeWelcome();
      }

      if (!this.isTabActive(tab)) return;
      this.callbacks.onTabSwitched?.(previousTabId, tabId);
      if (this.isTabActive(tab)) this.maybePrimeProviderRuntime(tab);
    } finally {
      this.isSwitchingTab = false;
    }
  }

  private scheduleTabHydration(tab: TabData): void {
    if (!this.isTabActive(tab)) return;
    const generation = ++tab.hydrationGeneration;
    this.setHydrationState(tab, 'SCHEDULED');
    tab.historyLoadProgress = { phase: 'queued' };
    renderTabHydrationPlaceholder(tab);

    const scheduleFrame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
    scheduleFrame(() => {
      setTimeout(() => {
        try {
          void this.hydrateTab(tab, generation).catch(error => this.reportHydrationFailure(error));
        } catch (error) {
          this.reportHydrationFailure(error);
        }
      }, 0);
    });
  }

  private reportHydrationFailure(_error: unknown): void {
    try {
      new Notice(t('chat.history.errorTitle'));
    } catch {
      setTimeout(() => { throw new Error('Hydration failure notification failed'); }, 0);
    }
  }

  private async hydrateTab(tab: TabData, generation: number): Promise<void> {
    if (this.isStaleHydration(tab, generation)) return;

    try {
      this.setHydrationState(tab, 'LOADING');
      renderTabHydrationPlaceholder(tab);
      await tab.controllers.conversationController?.loadActive(
        () => this.isTabActive(tab) && tab.hydrationGeneration === generation && this.activeTabId === tab.id,
      );
      if (this.isStaleHydration(tab, generation)) return;

      // The conversation loadActive restored — fully hydrated for small
      // transcripts or the materialized first page for oversize ones — is
      // already this tab's view. Pass it as the initializeTabService override:
      // letting that call re-fetch via getConversationById would re-run history
      // hydration and re-throw the oversize error the paged path just handled,
      // clobbering the materialized tab back to the blocked placeholder.
      const historyConversation = tab.conversationId
        ? this.plugin.getConversationSync(tab.conversationId)
        : null;
      // A hydrated Claude tab must own its runtime before becoming READY so
      // transcript observation covers the idle period. Shell/blocked tabs
      // never reach this point and therefore cannot start an observer.
      await initializeTabService(tab, this.plugin, historyConversation, () => this.isTabActive(tab));
      if (!this.isTabActive(tab)) return;
      if (this.isStaleHydration(tab, generation)) {
        cleanupTabRuntime(tab);
        return;
      }
      this.bindHistoryRecoverySource(tab, historyConversation);
      setupServiceCallbacks(tab, this.plugin, () => this.isTabActive(tab));
      if (!this.isTabActive(tab)) return;
      if (this.isStaleHydration(tab, generation)) {
        cleanupTabRuntime(tab);
        return;
      }

      // P6: READY means the first-screen DOM is settled, not just that the
      // data and runtime are back — the frame-batched render queue must
      // drain before the input unblocks. The hard race protection is the
      // projection lease; this wait is the UX readiness semantics.
      await tab.renderer?.waitForRenderedMessages();
      if (!this.isTabActive(tab)) return;
      if (this.isStaleHydration(tab, generation)) {
        cleanupTabRuntime(tab);
        return;
      }

      this.setHydrationState(tab, 'READY');
      tab.hydrationDiagnostic = null;
      tab.historyLoadProgress = null;
    } catch (error) {
      if (!this.isTabActive(tab)) throw error;
      try {
        this.bindHistoryRecoverySource(tab, null);
        if (this.isStaleHydration(tab, generation)) {
          // initializeTabService may have created a runtime before throwing;
          // a stale catch must not leave it parked on the tab.
          cleanupTabRuntime(tab);
        } else {
          this.setHydrationState(tab, 'ERROR');
          tab.hydrationDiagnostic = {
            message: error instanceof Error ? error.message : String(error),
          };
          renderTabHydrationPlaceholder(tab, () => {
            if (this.activeTabId === tab.id) this.scheduleTabHydration(tab);
          });
          return;
        }
      } catch (handlingError) {
        // Both failures remain available in their original order and identity.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([error, handlingError], 'Hydration error handling failed');
      }
      throw error;
    }
  }

  /**
   * Stale check for in-flight hydration. A newer schedule superseding this
   * one (same tab, reactivated) leaves state untouched; a tab switched away
   * with no pending reschedule falls back to SHELL so a background tab never
   * parks in an intermediate state (SCHEDULED/LOADING).
   */
  private isStaleHydration(tab: TabData, generation: number): boolean {
    if (!this.isTabActive(tab)) return true;
    if (tab.hydrationGeneration === generation && this.activeTabId === tab.id) {
      return false;
    }
    if (this.activeTabId !== tab.id) {
      this.setHydrationState(tab, 'SHELL');
    }
    return true;
  }

  private setHydrationState(tab: TabData, state: TabHydrationState): void {
    tab.hydrationState = state;
    // Block input in every non-READY shell state so sends cannot race the
    // hydration restore (a message sent mid-LOADING could be overwritten by
    // the restored history) nor hit the hydration error path. READY
    // re-enables it; `disabled` does not clear the textarea value, so user
    // drafts survive the loading window.
    tab.dom.inputEl.disabled = state !== 'READY';
  }

  /**
   * Closes a tab.
   * @param tabId The tab to close.
   * @param force If true, close even if streaming.
   * @returns True if the tab was closed.
   */
  closeTab(tabId: TabId, force = false): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return Promise.resolve(false);
    const existing = this.closeFlights.get(tab);
    if (existing) return existing;
    if (!this.isTabActive(tab)) return Promise.resolve(false);

    if (tab.state.isStreaming && !force) return Promise.resolve(false);
    if (this.tabs.size === 1 && !tab.conversationId && tab.state.messages.length === 0) {
      return Promise.resolve(false);
    }

    let resolve!: (closed: boolean) => void;
    let reject!: (reason: unknown) => void;
    const flight = new Promise<boolean>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.closeFlights.set(tab, flight);
    void flight.then(
      () => this.closeFlights.delete(tab),
      () => this.closeFlights.delete(tab),
    );
    void this.closeTabAfterSave(tab).then(resolve, reject);
    return flight;
  }

  private async closeTabAfterSave(tab: TabData): Promise<boolean> {
    const save = tab.controllers.conversationController?.save() ?? Promise.resolve();
    this.closeSaveFlights.set(tab, save);
    try {
      await save;
    } finally {
      if (this.closeSaveFlights.get(tab) === save) this.closeSaveFlights.delete(tab);
    }
    if (!this.isTabActive(tab)) return false;

    const tabIdsBefore = Array.from(this.tabs.keys());
    const closingIndex = tabIdsBefore.indexOf(tab.id);
    await this.cleanupTabOnce(tab, true);
    if (!this.isOpen() || this.tabs.get(tab.id) !== tab) return false;

    this.invalidateProviderCommandState(tab);
    this.tabs.delete(tab.id);
    this.callbacks.onTabClosed?.(tab.id);
    if (!this.isOpen()) return true;

    if (this.activeTabId === tab.id) {
      this.activeTabId = null;
      if (this.tabs.size > 0) {
        const fallbackTabId = closingIndex === 0
          ? tabIdsBefore[1]
          : tabIdsBefore[closingIndex - 1];
        if (fallbackTabId && this.tabs.has(fallbackTabId)) {
          await this.switchToTab(fallbackTabId);
        }
      } else {
        await this.createTab();
      }
    }

    return this.isOpen();
  }

  private cleanupTabOnce(tab: TabData, releaseLeaseBeforeDestroy = false): Promise<void> {
    const existing = this.cleanupFlights.get(tab);
    if (existing) return existing;
    const cleanup = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      // Revoke eligibility and settle capture waiters before destroyTab tears
      // down the UI (§6 W4c); the shared path covers closeTab and candidate
      // abandonment alike.
      try { this.invalidateProviderCommandState(tab); } catch (error) { errors.push(error); }
      const pending = this.pendingConversationClaims.get(tab);
      if (pending) {
        try {
          this.conversationOpenRegistry.release(pending.conversationId, pending.ownerToken);
        } catch (error) {
          errors.push(error);
        }
        this.pendingConversationClaims.delete(tab);
      }
      const committed = tab.conversationOpenClaim;
      if (committed) {
        try {
          this.conversationOpenRegistry.release(committed.conversationId, committed.ownerToken);
        } catch (error) {
          errors.push(error);
        }
        tab.conversationOpenClaim = null;
      }
      try { this.bindHistoryRecoverySource(tab, null); } catch (error) { errors.push(error); }
      if (releaseLeaseBeforeDestroy) {
        try { tab.state.historyLease?.release(); } catch (error) { errors.push(error); }
        tab.state.historyLease = null;
      }
      try { await destroyTab(tab); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw errors[0];
    });
    this.cleanupFlights.set(tab, cleanup);
    return cleanup;
  }

  /**
   * Moves a tab to a new position in the tab bar.
   *
   * `targetIndex` is the insertion index in the order that remains after the
   * source tab is removed first ("remove-then-insert"), which is exactly the
   * index a drop gesture computes. The Map is rebuilt in the new order so every
   * order-derived behavior (badge numbering, close fallback, notification
   * index, persisted openTabs) follows the visual order; TabData instances,
   * the active tab, runtimes and hydration state are never touched.
   *
   * @returns True when the order actually changed.
   */
  moveTab(tabId: TabId, targetIndex: number): boolean {
    if (!this.isOpen()) return false;
    const currentIds = Array.from(this.tabs.keys());
    const sourceIndex = currentIds.indexOf(tabId);
    if (sourceIndex === -1) {
      return false;
    }
    if (targetIndex < 0 || targetIndex > currentIds.length - 1) {
      return false;
    }

    // Remove-then-insert: indices after the source shift down by one before
    // the target index applies.
    const removed = currentIds.splice(sourceIndex, 1);
    currentIds.splice(targetIndex, 0, removed[0]);

    const previousIds = Array.from(this.tabs.keys());
    if (currentIds.every((id, i) => id === previousIds[i])) {
      return false;
    }

    // Map iteration order follows insertion order, so rebuilding with the same
    // TabData references re-keys the order without recreating tab state.
    const reordered = currentIds.map((id) => this.tabs.get(id)!);
    this.tabs.clear();
    for (const tab of reordered) {
      this.tabs.set(tab.id, tab);
    }

    this.callbacks.onTabOrderChanged?.();
    return true;
  }

  // ============================================
  // Tab Queries
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null;
  }

  /** Gets the active tab ID. */
  getActiveTabId(): TabId | null {
    return this.activeTabId;
  }

  /** Gets a tab by ID. */
  getTab(tabId: TabId): TabData | null {
    return this.tabs.get(tabId) ?? null;
  }

  /** Gets all tabs. */
  getAllTabs(): TabData[] {
    return Array.from(this.tabs.values());
  }

  /** Gets the number of tabs. */
  getTabCount(): number {
    return this.tabs.size;
  }

  /** Checks if more tabs can be created. */
  canCreateTab(): boolean {
    return this.isOpen() && this.tabs.size < this.getMaxTabs();
  }

  // ============================================
  // Tab Bar Data
  // ============================================

  /** Gets data for rendering the tab bar. */
  getTabBarItems(): TabBarItem[] {
    const items: TabBarItem[] = [];
    let index = 1;

    for (const tab of this.tabs.values()) {
      const conversation = tab.conversationId
        ? this.plugin.getConversationSync(tab.conversationId)
        : null;
      items.push({
        id: tab.id,
        index: index++,
        title: getTabTitle(tab, this.plugin),
        conversationTitle: conversation?.title ?? null,
        conversationId: tab.conversationId ?? null,
        sizeSnapshot: conversation ? this.plugin.conversationSizes?.getSnapshot(conversation.id) : undefined,
        providerId: getTabProviderId(tab, this.plugin),
        isActive: tab.id === this.activeTabId,
        isStreaming: tab.state.isStreaming,
        needsAttention: tab.state.needsAttention,
        needsReview: tab.state.needsReview,
        canClose: this.tabs.size > 1 || !tab.state.isStreaming,
      });
    }

    return items;
  }

  // ============================================
  // Conversation Management
  // ============================================

  private async reserveConversationForTab(tab: TabData, conversationId: string): Promise<boolean> {
    if (!this.isTabActive(tab)) return false;
    if (tab.conversationOpenClaim?.conversationId === conversationId
      && this.conversationOpenRegistry.owns(tab.conversationOpenClaim)) return true;
    const pending = this.pendingConversationClaims.get(tab);
    if (pending?.conversationId === conversationId && this.conversationOpenRegistry.owns(pending)) return true;
    if (pending) {
      this.conversationOpenRegistry.release(pending.conversationId, pending.ownerToken);
      this.pendingConversationClaims.delete(tab);
    }
    const claim = this.conversationOpenRegistry.reserve(conversationId, async () => {
      if (!this.isTabActive(tab)) return;
      this.plugin.app.workspace.revealLeaf(this.view.leaf);
      if (!this.isTabActive(tab)) return;
      await this.switchToTab(tab.id);
    });
    if (!claim) {
      await this.conversationOpenRegistry.focusOwner(conversationId);
      return false;
    }
    this.pendingConversationClaims.set(tab, claim);
    return this.isTabActive(tab);
  }

  private commitConversationForTab(tab: TabData, conversationId: string): void {
    if (!this.isTabActive(tab)) return;
    const claim = this.pendingConversationClaims.get(tab) ?? tab.conversationOpenClaim;
    if (!claim || claim.conversationId !== conversationId || !this.conversationOpenRegistry.owns(claim)) {
      throw new Error('Conversation ownership changed during restore');
    }
    tab.conversationOpenClaim = claim;
    this.pendingConversationClaims.delete(tab);
    // Recovery traversal is conversation-scoped, not runtime-scoped. Rebind at
    // the ownership commit so a reused runtime cannot retain the old transcript.
    this.bindHistoryRecoverySource(tab, this.plugin.getConversationSync(conversationId));
  }

  private bindHistoryRecoverySource(tab: TabData, conversation: Conversation | null | undefined): void {
    const historyService = conversation
      ? ProviderRegistry.getConversationHistoryService(conversation.providerId)
      : null;
    tab.service?.setHistoryRecoverySource?.(
      conversation && historyService?.iterateFullHistory
        ? () => historyService.iterateFullHistory!(conversation, getVaultPath(this.plugin.app), {
            maxTurnsPerChunk: 50,
            maxSourceBytesPerChunk: 8 * 1024 * 1024,
            maxProjectedCharsPerChunk: 2 * 1024 * 1024,
            projectionLevel: 'detail',
          })
        : null,
    );
  }

  private cancelConversationForTab(tab: TabData, conversationId: string): void {
    if (!this.isTabActive(tab)) return;
    const claim = this.pendingConversationClaims.get(tab);
    if (!claim || claim.conversationId !== conversationId) return;
    this.conversationOpenRegistry.release(conversationId, claim.ownerToken);
    this.pendingConversationClaims.delete(tab);
  }

  /** R2 binding reservation witness over this tab's pending or committed claim (P6 §3.2). */
  private getBindingReservationForTab(tab: TabData, conversationId: string): ReservationWitness | null {
    const pending = this.pendingConversationClaims.get(tab);
    const committed = tab.conversationOpenClaim;
    const claim = pending?.conversationId === conversationId
      ? pending
      : committed?.conversationId === conversationId
        ? committed
        : null;
    if (!claim) return null;
    return { claim, owns: () => this.conversationOpenRegistry.owns(claim) };
  }

  private releaseConversationForTab(tab: TabData, conversationId: string): void {
    if (!this.isTabActive(tab)) return;
    const claim = tab.conversationOpenClaim;
    if (!claim || claim.conversationId !== conversationId) return;
    if (this.conversationOpenRegistry.release(conversationId, claim.ownerToken)) {
      tab.conversationOpenClaim = null;
      this.bindHistoryRecoverySource(tab, null);
    }
  }

  /**
   * Opens a conversation in a new tab or existing tab.
   * @param conversationId The conversation to open.
   * @param options Controls tab creation behavior (backward-compatible with boolean).
   */
  async openConversation(
    conversationId: string,
    options: boolean | OpenConversationOptions = false,
  ): Promise<void> {
    if (!this.isOpen()) return;
    const preferNewTab = typeof options === 'boolean'
      ? options
      : options.preferNewTab ?? false;
    const activate = typeof options === 'boolean'
      ? true
      : options.activate ?? true;

    // Check if conversation is already open in this view's tabs
    for (const tab of this.tabs.values()) {
      if (this.isTabActive(tab) && tab.conversationId === conversationId) {
        await this.switchToTab(tab.id);
        return;
      }
    }

    // A closing owner retains its claim but must not be revealed or focused.
    const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
    const isSameView = crossViewResult?.view === this.view;
    if (crossViewResult && !isSameView) {
      const owner = crossViewResult.view.getTabManager();
      if (!this.isOpen() || !owner?.isOpen()) return;
      this.plugin.app.workspace.revealLeaf(crossViewResult.view.leaf);
      if (!this.isOpen() || !owner.isOpen()) return;
      await owner.switchToTab(crossViewResult.tabId);
      return;
    }

    // Open in current tab or new tab
    if (preferNewTab && this.canCreateTab()) {
      await this.createTab(conversationId, undefined, { activate });
    } else {
      // Open in current tab
      // Note: Don't set tab.conversationId here - the onConversationIdChanged callback
      // will sync it after successful switch. Setting it before switchTo() would cause
      // incorrect tab metadata if switchTo() returns early (streaming/switching/creating).
      const activeTab = this.getActiveTab();
      if (activeTab && this.isTabActive(activeTab)) {
        await activeTab.controllers.conversationController?.switchTo(conversationId);
      }
    }
  }

  /**
   * Creates a new conversation in the active tab.
   */
  async createNewConversation(): Promise<void> {
    const activeTab = this.getActiveTab();
    if (activeTab && this.isTabActive(activeTab)) {
      await activeTab.controllers.conversationController?.createNew();
      if (!this.isTabActive(activeTab)) return;
      // Sync tab.conversationId with the newly created conversation
      activeTab.conversationId = activeTab.state.currentConversationId;
      this.maybePrimeProviderRuntime(activeTab);
    }
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId | ProviderId[]): void {
    if (!this.isOpen()) return;
    for (const tab of this.filterTabsByProvider(providerIds, (tab) => getTabProviderId(tab, this.plugin))) {
      this.invalidateProviderCommandState(tab);
      tab.ui?.slashCommandDropdown?.resetSdkSkillsCache();
    }
  }

  private invalidateProviderCommandState(tab: TabData): void {
    this.revokeTabCommandCapture(tab);
    // Settle target-capture listeners synchronously (§6 W4c): a pending
    // typed read must go stale in this round, never wait for its underlying
    // vault/SDK promise. The subscription set is inherited by the new entry.
    const entry = this.tabCommandCaptures.get(tab);
    if (entry) {
      for (const listener of [...entry.listeners]) {
        try { listener(); } catch { /* One broken consumer must not block revocation. */ }
      }
    }
  }

  /**
   * Revokes manager-side command eligibility without notifying capture
   * listeners: bumps the generation, drops the ticket/warmup/cache, aborts
   * the old eligibility controller, and installs a fresh capture entry. Old
   * receipts lose eligibility through the generation/ticket checks in
   * isCurrent; the old read's waiter settles through the aborted signal.
   */
  private revokeTabCommandCapture(tab: TabData): void {
    this.providerCommandGenerations.set(tab, (this.providerCommandGenerations.get(tab) ?? 0) + 1);
    this.providerCommandTickets.delete(tab);
    this.providerCommandWarmups.delete(tab.id);
    this.providerCommandCache.delete(tab.id);
    const previousEntry = this.tabCommandCaptures.get(tab);
    if (previousEntry) {
      previousEntry.controller.abort();
      this.tabCommandCaptures.set(tab, {
        controller: new AbortController(),
        targetToken: {},
        listeners: previousEntry.listeners,
        lastContextKey: previousEntry.lastContextKey,
      });
    }
  }

  /**
   * Freezes the tab's command target for one typed read (§6 W4c): the opaque
   * target token, ticket object, generation, provider/runtime/context key,
   * registry revision, and a copy of the requested external paths. isCurrent
   * keeps the original isTabActive/provider/ticket/generation/runtime/context
   * checks and re-checks the registry revision; it never re-resolves the tab
   * by id.
   */
  private getTabCommandCaptureEntry(tab: TabData): TabCommandCaptureEntry {
    let entry = this.tabCommandCaptures.get(tab);
    if (!entry) {
      entry = {
        controller: new AbortController(),
        targetToken: {},
        listeners: new Set(),
        lastContextKey: null,
      };
      this.tabCommandCaptures.set(tab, entry);
    }
    return entry;
  }

  private createTabCommandTargetCapture(tab: TabData): CommandTargetCapture {
    return {
      capture: sessionEpoch => this.captureTabCommandTarget(tab, sessionEpoch),
      subscribe: listener => {
        const entry = this.getTabCommandCaptureEntry(tab);
        entry.listeners.add(listener);
        return () => {
          entry.listeners.delete(listener);
        };
      },
    };
  }

  /**
   * One registry subscription per provider (§6 W4c): a catalog replacement or
   * clear revokes the related tabs' eligibility and rebinds visible dropdowns
   * through the tab-specific factory (explicit null/null when no catalog
   * remains). The unbind happens at retirement — no static listener survives
   * the manager.
   */
  private ensureCommandCatalogSubscription(providerId: ProviderId): void {
    if (this.commandCatalogUnsubscribers.has(providerId)) return;
    const unsubscribe = ProviderWorkspaceRegistry.subscribeCommandCatalog(providerId, () => {
      for (const tab of this.filterTabsByProvider(providerId, current => getTabProviderId(current, this.plugin))) {
        this.invalidateProviderCommandState(tab);
        const info = this.getProviderCatalogConfig(tab);
        tab.ui.slashCommandDropdown?.setProviderCatalog(info?.config ?? null, info?.getEntries ?? null, providerId);
      }
    });
    this.commandCatalogUnsubscribers.set(providerId, unsubscribe);
  }

  private captureTabCommandTarget(tab: TabData, sessionEpoch: number): CommandTargetReadContext {
    const providerId = getTabProviderId(tab, this.plugin);
    const warmupContext = this.buildProviderWarmupContext(tab, providerId);
    const context = this.buildProviderCommandContext(tab, providerId, warmupContext);
    let entry = this.getTabCommandCaptureEntry(tab);
    // A context-key change revokes the old ticket/controller/receipt
    // eligibility synchronously, then mints a new ticket; a same-value return
    // still settles on the new generation, never on key equality. The
    // revocation stays silent on purpose: notifying capture listeners here
    // would invalidate the very read this capture belongs to (the session
    // froze its revision before calling capture); old receipts still lose
    // eligibility through the generation/ticket checks in isCurrent.
    if (entry.lastContextKey !== null && entry.lastContextKey !== context.cacheKey) {
      this.revokeTabCommandCapture(tab);
      entry = this.tabCommandCaptures.get(tab) ?? entry;
    }
    let ticket = this.providerCommandTickets.get(tab);
    if (!ticket || ticket.key !== context.cacheKey) {
      ticket = { key: context.cacheKey };
      this.providerCommandTickets.set(tab, ticket);
    }
    const generation = this.providerCommandGenerations.get(tab) ?? 0;
    const runtime = context.runtime;
    const registryRevision = ProviderWorkspaceRegistry.getCommandCatalogRevision(providerId);
    const requestedExternalPaths = [...context.externalContextPaths];
    entry.lastContextKey = context.cacheKey;
    const target: CommandDiscoveryTarget = {
      kind: 'tab',
      providerId,
      sessionEpoch,
      registryRevision,
      requestedExternalPaths,
      targetToken: entry.targetToken,
      ticket,
      generation,
      runtime,
      contextKey: context.cacheKey,
    };
    const isCurrent = () => this.isTabActive(tab)
      && getTabProviderId(tab, this.plugin) === providerId
      && this.providerCommandTickets.get(tab) === ticket
      && (this.providerCommandGenerations.get(tab) ?? 0) === generation
      && this.buildProviderWarmupContext(tab, providerId).runtime === runtime
      && this.buildProviderCommandContext(
        tab,
        providerId,
        this.buildProviderWarmupContext(tab, providerId),
      ).cacheKey === context.cacheKey
      && ProviderWorkspaceRegistry.getCommandCatalogRevision(providerId) === registryRevision;
    return { target, eligibilitySignal: entry.controller.signal, isCurrent };
  }

  primeProviderRuntime(providerIds?: ProviderId | ProviderId[]): void {    if (!this.isOpen()) return;
    for (const tab of this.filterTabsByProvider(providerIds, (tab) => tab.service?.providerId ?? tab.providerId)) {
      this.maybePrimeProviderRuntime(tab);
    }
  }

  private *filterTabsByProvider(
    providerIds: ProviderId | ProviderId[] | undefined,
    resolve: (tab: TabData) => ProviderId,
  ): Iterable<TabData> {
    const filter = providerIds
      ? new Set(Array.isArray(providerIds) ? providerIds : [providerIds])
      : null;

    for (const tab of this.tabs.values()) {
      if (filter && !filter.has(resolve(tab))) {
        continue;
      }
      yield tab;
    }
  }

  // ============================================
  // Fork
  // ============================================

  private async handleForkRequest(context: ForkContext, sourceTab: TabData): Promise<void> {
    if (!this.isTabActive(sourceTab)) return;
    const target = await chooseForkTarget(this.plugin.app);
    if (!target || !this.isTabActive(sourceTab)) return;

    if (target === 'new-tab') {
      const tab = await this.forkToNewTab(context, sourceTab);
      if (!this.isTabActive(sourceTab)) return;
      if (!tab) {
        const maxTabs = this.getMaxTabs();
        new Notice(t('chat.fork.maxTabsReached', { count: String(maxTabs) }));
        return;
      }
      if (!this.isTabActive(tab)) return;
      if (context.prefill) tab.dom.inputEl.value = context.prefill;
      new Notice(t('chat.fork.notice'));
    } else {
      if (this.getActiveTab() !== sourceTab) return;
      const success = await this.forkInCurrentTab(context, sourceTab);
      if (!this.isTabActive(sourceTab)) return;
      if (!success) {
        new Notice(t('chat.fork.failed', { error: t('chat.fork.errorNoActiveTab') }));
        return;
      }
      if (context.prefill) sourceTab.dom.inputEl.value = context.prefill;
      new Notice(t('chat.fork.noticeCurrentTab'));
    }
  }

  async forkToNewTab(context: ForkContext, sourceTab = this.getActiveTab()): Promise<TabData | null> {
    const isSourceActive = () => sourceTab ? this.isTabActive(sourceTab) : this.isOpen();
    if (!isSourceActive() || this.tabs.size >= this.getMaxTabs()) return null;

    const conversationId = await this.createForkConversation(context, isSourceActive);
    if (!conversationId || !isSourceActive()) return null;
    try {
      const tab = await this.createTab(conversationId, undefined, { shouldContinue: isSourceActive });
      return isSourceActive() && tab && this.isTabActive(tab) ? tab : null;
    } catch (error) {
      if (isSourceActive()) {
        await this.plugin.deleteConversation(conversationId).catch(() => {});
      }
      throw error;
    }
  }

  async forkInCurrentTab(context: ForkContext, activeTab = this.getActiveTab()): Promise<boolean> {
    if (!activeTab?.controllers.conversationController || !this.isTabActive(activeTab)) return false;
    const isSourceActive = () => this.isTabActive(activeTab);

    const conversationId = await this.createForkConversation(context, isSourceActive);
    if (!conversationId || !isSourceActive()) return false;
    try {
      await activeTab.controllers.conversationController.switchTo(conversationId);
    } catch (error) {
      if (isSourceActive()) {
        await this.plugin.deleteConversation(conversationId).catch(() => {});
      }
      throw error;
    }
    return isSourceActive();
  }

  private async createForkConversation(
    context: ForkContext,
    isSourceActive: () => boolean,
  ): Promise<string | null> {
    if (!isSourceActive()) return null;
    const conversation = await this.plugin.createConversation({
      providerId: context.providerId,
    });
    if (!isSourceActive()) return null;

    const title = context.sourceTitle
      ? this.buildForkTitle(context.sourceTitle, context.forkAtUserMessage)
      : undefined;

    const forkProviderState = ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .buildForkProviderState(
        context.sourceSessionId,
        context.resumeAt,
        context.sourceProviderState,
      );

    await this.plugin.updateConversation(conversation.id, {
      messages: context.messages,
      providerState: forkProviderState,
      ...(title && { title }),
      ...(context.currentNote && { currentNote: context.currentNote }),
    });

    return isSourceActive() ? conversation.id : null;
  }

  private buildForkTitle(sourceTitle: string, forkAtUserMessage?: number): string {
    const MAX_TITLE_LENGTH = 50;
    const forkSuffix = forkAtUserMessage ? ` (#${forkAtUserMessage})` : '';
    const forkPrefix = 'Fork: ';
    const maxSourceLength = MAX_TITLE_LENGTH - forkPrefix.length - forkSuffix.length;
    const truncatedSource = sourceTitle.length > maxSourceLength
      ? sourceTitle.slice(0, maxSourceLength - 1) + '…'
      : sourceTitle;
    let title = forkPrefix + truncatedSource + forkSuffix;

    const existingTitles = new Set(this.plugin.getConversationList().map(c => c.title));
    if (existingTitles.has(title)) {
      let n = 2;
      while (existingTitles.has(`${title} ${n}`)) n++;
      title = `${title} ${n}`;
    }

    return title;
  }

  // ============================================
  // Persistence
  // ============================================

  /** Gets the state to persist. */
  getPersistedState(): PersistedTabManagerState {
    const openTabs: PersistedTabState[] = [];

    const persistedConversationIds = new Set<string>();
    for (const tab of this.tabs.values()) {
      if (tab.conversationId && persistedConversationIds.has(tab.conversationId)) continue;
      if (tab.conversationId) persistedConversationIds.add(tab.conversationId);
      openTabs.push({
        ...(tab.lifecycleState === 'blank' && tab.draftModel
          ? { draftModel: tab.draftModel, draftProviderId: tab.providerId }
          : {}),
        tabId: tab.id,
        conversationId: tab.conversationId,
      });
    }

    return {
      openTabs,
      activeTabId: this.activeTabId,
    };
  }

  /** Restores state from persisted data. */
  async restoreState(state: PersistedTabManagerState): Promise<void> {
    if (!this.isOpen()) return;
    this.isRestoringState = true;
    try {
      const selectedByConversation = new Map<string, PersistedTabState>();
      for (const candidate of state.openTabs) {
        if (!candidate.conversationId) continue;
        const selected = selectedByConversation.get(candidate.conversationId);
        if (!selected || candidate.tabId === state.activeTabId) {
          selectedByConversation.set(candidate.conversationId, candidate);
        }
      }
      const restoredTabs = state.openTabs.filter(candidate =>
        !candidate.conversationId || selectedByConversation.get(candidate.conversationId) === candidate
      );
      // Create tabs from persisted state with error handling.
      for (const tabState of restoredTabs) {
        if (!this.isOpen()) return;
        try {
          await this.createTab(tabState.conversationId, tabState.tabId, {
            activate: false,
            ...(typeof tabState.draftModel === 'string' ? { draftModel: tabState.draftModel } : {}),
            ...(typeof tabState.draftProviderId === 'string' ? { draftProviderId: tabState.draftProviderId } : {}),
          });
        } catch (error) {
          if (!this.isOpen()) throw error;
          // Continue restoring other tabs
        }
        if (!this.isOpen()) return;
      }
    } finally {
      this.isRestoringState = false;
    }

    if (!this.isOpen()) return;
    const fallbackTabId = state.openTabs.find((tabState) => this.tabs.has(tabState.tabId))?.tabId
      ?? Array.from(this.tabs.keys())[0]
      ?? null;
    const targetTabId = state.activeTabId && this.tabs.has(state.activeTabId)
      ? state.activeTabId
      : fallbackTabId;

    // Switch to the previously active tab after all tabs are restored so background
    // restore does not warm the first restored tab by accident.
    if (targetTabId) {
      try {
        await this.switchToTab(targetTabId);
      } catch (error) {
        if (!this.isOpen()) throw error;
        // Ignore switch errors
      }
    }

    if (!this.isOpen()) return;
    // If no tabs were restored, create a default one
    if (this.tabs.size === 0) {
      await this.createTab();
    }
  }

  // ============================================
  // SDK Commands (Shared)
  // ============================================

  /**
   * Gets provider-scoped SDK supported commands for a tab.
   * Reuses a ready runtime from the same provider when available to avoid
   * leaking commands across providers in mixed-provider workspaces.
   * @returns Array of SDK commands, or empty array if no service is ready.
   */
  async getSdkCommands(tabId?: TabId): Promise<SlashCommand[]> {
    const targetTab = (tabId ? this.tabs.get(tabId) : this.getActiveTab()) ?? null;
    if (!targetTab || !this.isTabActive(targetTab)) return [];

    const providerId = getTabProviderId(targetTab, this.plugin);
    const staticCapabilities = ProviderRegistry.getCapabilities(providerId);
    if (!staticCapabilities.supportsProviderCommands) return [];

    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    // Typed routing happens before any runtime/loader logic (§6 W4c): with a
    // typed catalog the commands come from the original target's runtime
    // facet only — never borrowed from another tab, never through the loader,
    // never written into the legacy global array.
    if (typeof catalog?.openDropdownSession === 'function') {
      return this.readTypedRuntimeCommands(targetTab, providerId);
    }
    const runtimeCommandLoader = ProviderWorkspaceRegistry.getRuntimeCommandLoader(providerId);
    const warmupContext = this.buildProviderWarmupContext(targetTab, providerId);
    const context = this.buildProviderCommandContext(targetTab, providerId, warmupContext);
    if (!this.isTabActive(targetTab)) return [];
    let ticket = this.providerCommandTickets.get(targetTab);
    if (!ticket || ticket.key !== context.cacheKey) {
      ticket = { key: context.cacheKey };
      this.providerCommandTickets.set(targetTab, ticket);
    }
    const generation = this.providerCommandGenerations.get(targetTab) ?? 0;
    const requestTicket = ticket;
    const isCurrent = () => this.isProviderCommandContextCurrent(
      targetTab, providerId, context, requestTicket, generation,
    )
      && ProviderWorkspaceRegistry.getCommandCatalog(providerId) === catalog
      && ProviderWorkspaceRegistry.getRuntimeCommandLoader(providerId) === runtimeCommandLoader;
    if (!isCurrent()) return [];

    if (
      targetTab.lifecycleState === 'blank'
      && runtimeCommandLoader
      && (context.warmupMode !== 'commands' || targetTab.id !== this.activeTabId)
    ) {
      catalog?.setRuntimeCommands([]);
      return [];
    }

    let sdkCommands: SlashCommand[] = [];
    const targetService = targetTab.service;
    if (targetService?.providerId === providerId && targetService.isReady()) {
      sdkCommands = await targetService.getSupportedCommands();
      if (!isCurrent() || targetTab.service !== targetService) return [];
    } else if (!runtimeCommandLoader) {
      for (const tab of this.tabs.values()) {
        if (tab === targetTab || !this.isTabActive(tab)) continue;
        const service = tab.service;
        if (service?.providerId === providerId && service.isReady()) {
          sdkCommands = await service.getSupportedCommands();
          if (!isCurrent() || !this.isTabActive(tab) || tab.service !== service) return [];
          break;
        }
      }
    }

    if (sdkCommands.length === 0) {
      sdkCommands = await this.ensureProviderCommandRuntime(targetTab, providerId, context, isCurrent);
      if (!isCurrent()) return [];
    }

    catalog?.setRuntimeCommands(sdkCommands);
    return isCurrent() ? sdkCommands : [];
  }

  /**
   * Typed-catalog command read (§6 W4c): only the original target's runtime
   * facet is consulted. No runtime or no facet resolves to []; failed,
   * unavailable and ready-empty results map to the array-compatible empty
   * result. The eligibility checks (active tab, provider, ticket, generation,
   * frozen runtime/context) are preserved; no other tab, loader, or the
   * legacy global array is ever touched.
   */
  private async readTypedRuntimeCommands(tab: TabData, providerId: ProviderId): Promise<SlashCommand[]> {
    const warmupContext = this.buildProviderWarmupContext(tab, providerId);
    const context = this.buildProviderCommandContext(tab, providerId, warmupContext);
    let ticket = this.providerCommandTickets.get(tab);
    if (!ticket || ticket.key !== context.cacheKey) {
      ticket = { key: context.cacheKey };
      this.providerCommandTickets.set(tab, ticket);
    }
    const generation = this.providerCommandGenerations.get(tab) ?? 0;
    const runtime = context.runtime;
    const facet = runtime?.getCommandDiscovery?.() ?? null;
    const isCurrent = () => this.isTabActive(tab)
      && getTabProviderId(tab, this.plugin) === providerId
      && this.providerCommandTickets.get(tab) === ticket
      && (this.providerCommandGenerations.get(tab) ?? 0) === generation
      && this.buildProviderWarmupContext(tab, providerId).runtime === runtime
      && this.buildProviderCommandContext(
        tab,
        providerId,
        this.buildProviderWarmupContext(tab, providerId),
      ).cacheKey === context.cacheKey;
    if (!facet) return [];
    const read = await facet.read(undefined, { retryFailed: false });
    if (!isCurrent()) return [];
    if (read.status !== 'ready') return [];
    return [...read.entries];
  }

  private isProviderCommandContextCurrent(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderCommandContext,
    ticket: ProviderCommandTicket,
    generation: number,
  ): boolean {
    if (!this.isTabActive(tab)
      || getTabProviderId(tab, this.plugin) !== providerId
      || this.providerCommandTickets.get(tab) !== ticket
      || (this.providerCommandGenerations.get(tab) ?? 0) !== generation) return false;
    const current = this.buildProviderWarmupContext(tab, providerId);
    return this.isTabActive(tab)
      && current.runtime === context.runtime
      && this.buildProviderCommandContext(tab, providerId, current).cacheKey === context.cacheKey;
  }

  private async ensureProviderCommandRuntime(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderCommandContext,
    isCurrent: () => boolean,
  ): Promise<SlashCommand[]> {
    if (!isCurrent() || !this.isProviderCommandLoaderAvailable(providerId) || !isCurrent()) return [];

    const cached = this.providerCommandCache.get(tab.id);
    if (
      (!context.runtime || !context.runtime.isReady())
      && cached
      && cached.key === context.cacheKey
    ) {
      return cached.commands.map((command) => ({ ...command }));
    }

    const existing = this.providerCommandWarmups.get(tab.id);
    if (existing?.key === context.cacheKey) {
      const commands = await existing.promise;
      return isCurrent() ? commands : [];
    }
    this.providerCommandWarmups.delete(tab.id);

    const warmup: Promise<SlashCommand[]> = this.warmProviderCommandRuntime(
      tab,
      providerId,
      context,
      () => isCurrent() && this.providerCommandWarmups.get(tab.id)?.promise === warmup,
    ).finally(() => {
      if (this.providerCommandWarmups.get(tab.id)?.promise === warmup) {
        this.providerCommandWarmups.delete(tab.id);
      }
    });
    this.providerCommandWarmups.set(tab.id, { key: context.cacheKey, promise: warmup });
    const commands = await warmup;
    return isCurrent() ? commands : [];
  }

  private maybePrimeProviderRuntime(tab: TabData): void {
    if (!this.isTabActive(tab)) return;
    void this.prewarmProviderTab(tab).catch(() => {});
  }

  private isProviderCommandLoaderAvailable(providerId: ProviderId): boolean {
    const loader = ProviderWorkspaceRegistry.getRuntimeCommandLoader(providerId);
    if (!loader) return false;
    return loader.isAvailable(this.plugin.settings as unknown as Record<string, unknown>);
  }

  private async prewarmProviderTab(tab: TabData): Promise<void> {
    if (!this.isTabActive(tab)) return;
    const providerId = tab.service?.providerId ?? tab.providerId;
    const context = this.buildProviderWarmupContext(tab, providerId);
    if (!this.isTabActive(tab)) return;
    const hasReadyRuntime = tab.service?.providerId === providerId && tab.service.isReady();
    if (!hasReadyRuntime && tab.id !== this.activeTabId) {
      return;
    }

    switch (context.warmupMode) {
      case 'commands':
        await this.getSdkCommands(tab.id);
        return;
      case 'runtime':
        await this.ensureProviderTabRuntimeReady(tab, providerId, context);
        return;
      default:
        return;
    }
  }

  private async ensureProviderTabRuntimeReady(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderWarmupContext,
  ): Promise<void> {
    const isCurrent = () => this.isTabActive(tab)
      && tab.conversationId === context.tab.conversationId
      && (tab.service?.providerId ?? tab.providerId) === providerId;
    if (!isCurrent()) return;
    if (!context.runtime || context.runtime.providerId !== providerId || !tab.serviceInitialized) {
      await initializeTabService(tab, this.plugin, context.conversation, isCurrent);
      if (!isCurrent()) return;
      setupServiceCallbacks(tab, this.plugin, isCurrent);
    }

    const runtime = tab.service?.providerId === providerId ? tab.service : null;
    if (!runtime || !isCurrent()) return;

    // R2: warmup sync also routes through the binding's adoption registry.
    syncRuntimeUnderAdoption(
      tab,
      runtime,
      () => { runtime.syncConversationState(context.conversation, context.externalContextPaths); },
      { conversationId: context.conversation?.id ?? null },
    );
    if (!isCurrent() || tab.service !== runtime) return;
    await runtime.ensureReady();
    if (!isCurrent() || tab.service !== runtime) return;
    if (ProviderRegistry.getCapabilities(providerId).supportsProviderCommands) {
      await this.getSdkCommands(tab.id);
    }
  }

  private buildProviderWarmupContext(
    tab: TabData,
    providerId: ProviderId,
  ): ProviderWarmupContext {
    const conversation = tab.conversationId
      ? this.plugin.getConversationSync(tab.conversationId)
      : null;
    const hasConversationContext = conversation?.hasHistory === true
      || (conversation?.messageCount ?? conversation?.messages.length ?? 0) > 0;
    const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts()
      ?? (hasConversationContext
        ? conversation?.externalContextPaths ?? []
        : this.plugin.settings.persistentExternalContextPaths ?? []);
    const runtime = tab.service?.providerId === providerId ? tab.service : null;
    const warmupMode = this.resolveProviderTabWarmupMode({
      conversation,
      externalContextPaths,
      plugin: this.plugin,
      runtime,
      tab: {
        conversationId: tab.conversationId,
        draftModel: tab.draftModel,
        lifecycleState: tab.lifecycleState,
        providerId,
      },
    });

    return {
      conversation,
      externalContextPaths,
      runtime,
      tab: {
        conversationId: tab.conversationId,
        draftModel: tab.draftModel,
        lifecycleState: tab.lifecycleState,
        providerId,
      },
      warmupMode,
    };
  }

  private resolveProviderTabWarmupMode(context: ProviderTabWarmupContext): ProviderTabWarmupMode {
    return ProviderWorkspaceRegistry.getTabWarmupPolicy(context.tab.providerId)?.resolveMode(context) ?? 'none';
  }

  private buildProviderCommandContext(
    tab: TabData,
    providerId: ProviderId,
    warmupContext: ProviderWarmupContext,
  ): ProviderCommandContext {
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      providerId,
    );

    return {
      ...warmupContext,
      cacheKey: JSON.stringify({
        allowSessionCreation: warmupContext.warmupMode === 'commands'
          && tab.lifecycleState === 'blank'
          && tab.id === this.activeTabId,
        conversationId: warmupContext.conversation?.id ?? null,
        draftModel: tab.draftModel ?? null,
        externalContextPaths: warmupContext.externalContextPaths,
        lifecycleState: tab.lifecycleState,
        providerId,
        providerSettings,
        providerState: warmupContext.conversation?.providerState ?? null,
        sessionId: warmupContext.conversation?.sessionId ?? null,
        warmupMode: warmupContext.warmupMode,
      }),
    };
  }

  private async warmProviderCommandRuntime(
    tab: TabData,
    providerId: ProviderId,
    context: ProviderCommandContext,
    isCurrent: () => boolean,
  ): Promise<SlashCommand[]> {
    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    const loader = ProviderWorkspaceRegistry.getRuntimeCommandLoader(providerId);
    if (!catalog || !loader) {
      return [];
    }
    const commands = await loader.loadCommands({
      allowSessionCreation: context.warmupMode === 'commands'
        && tab.lifecycleState === 'blank'
        && tab.id === this.activeTabId,
      conversation: context.conversation,
      externalContextPaths: context.externalContextPaths,
      plugin: this.plugin,
      runtime: context.runtime,
    });
    if (!isCurrent()) return [];

    if (!context.runtime || !context.runtime.isReady()) {
      this.providerCommandCache.set(tab.id, {
        key: context.cacheKey,
        commands: commands.map((command) => ({ ...command })),
      });
    } else {
      this.providerCommandCache.delete(tab.id);
    }
    catalog.setRuntimeCommands(commands);
    return commands;
  }

  // ============================================
  // Provider Command Catalog
  // ============================================

  private getProviderCatalogConfig(tab: TabData) {
    if (!this.isTabActive(tab)) return null;
    const providerId = getTabProviderId(tab, this.plugin);
    // Before resolving config, make sure this provider's catalog slot is
    // subscribed: a provider fallback (or a not-yet-published catalog) must
    // still propagate later publish/clear notifications to the tab. The call
    // is idempotent, and the subscription callback re-resolves config through
    // this method without re-subscribing.
    this.ensureCommandCatalogSubscription(providerId);
    const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
    if (!catalog) return null;
    // Typed routing is decided by catalog capability, not by runtime facets
    // (§6 W4c): a typed catalog gets a target-specific session factory; the
    // legacy array handoff stays untouched for array-only catalogs.
    const openSession = typeof catalog.openDropdownSession === 'function'
      ? catalog.openDropdownSession.bind(catalog)
      : null;
    if (openSession) {
      const capture = this.createTabCommandTargetCapture(tab);
      return {
        config: {
          ...catalog.getDropdownConfig(),
          createDiscoverySession: () => openSession(capture),
        },
        getEntries: async () => {
          // Compatibility shell: one temporary session per call, mapped only
          // when the snapshot is still current, always released.
          const session = openSession(capture);
          try {
            const snapshot = await session.read();
            return snapshot.status === 'ready' && session.isCurrent(snapshot.receipt)
              ? [...snapshot.entries]
              : [];
          } finally {
            session.release();
          }
        },
      };
    }
    const isCatalogCurrent = () => this.isTabActive(tab)
      && getTabProviderId(tab, this.plugin) === providerId
      && ProviderWorkspaceRegistry.getCommandCatalog(providerId) === catalog;

    return {
      config: catalog.getDropdownConfig(),
      getEntries: async () => {
        if (!isCatalogCurrent()) return [];
        const generation = this.providerCommandGenerations.get(tab) ?? 0;
        const commands = this.getSdkCommands(tab.id);
        const ticket = this.providerCommandTickets.get(tab);
        const isRequestCurrent = () => isCatalogCurrent()
          && (this.providerCommandGenerations.get(tab) ?? 0) === generation
          && this.providerCommandTickets.get(tab) === ticket;
        await commands;
        if (!isRequestCurrent()) return [];
        const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });
        return isRequestCurrent() ? entries : [];
      },
    };
  }

  // ============================================
  // Broadcast
  // ============================================

  /**
   * Broadcasts a function call to all initialized tab runtimes.
   * Used by settings managers to apply configuration changes to all tabs.
   * @param fn Function to call on each runtime.
   */
  async broadcastToAllTabs(fn: (service: ChatRuntime) => Promise<void>): Promise<void> {
    await this.broadcastToTabs(this.tabs.values(), fn);
  }

  async broadcastToProviderTabs(
    providerIds: ProviderId | ProviderId[],
    fn: (service: ChatRuntime) => Promise<void>,
  ): Promise<void> {
    await this.broadcastToTabs(
      this.filterTabsByProvider(providerIds, (tab) => tab.service?.providerId ?? tab.providerId),
      fn,
    );
  }

  private async broadcastToTabs(
    tabs: Iterable<TabData>,
    fn: (service: ChatRuntime) => Promise<void>,
  ): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const tab of tabs) {
      if (!this.isTabActive(tab)) continue;
      if (tab.service && tab.serviceInitialized) {
        promises.push(
          fn(tab.service).catch(() => {
            // Silently ignore broadcast errors
          })
        );
      }
    }

    await Promise.all(promises);
  }

  // ============================================
  // Cleanup
  // ============================================

  stopMarkdownDiagnostics(): void {
    this.markdownDiagnosticsEnabled = false;
  }

  /** Destroys the stable retiring set once, after its accepted and final saves. */
  destroy(): Promise<void> {
    if (this.destroyFlight) return this.destroyFlight;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const flight = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.destroyFlight = flight;
    this.beginClose();
    void this.destroyRetiringTabs().then(resolve, reject);
    return flight;
  }

  private async destroyRetiringTabs(): Promise<void> {
    const acceptedResults = await Promise.allSettled(this.acceptedSavesAtClose);
    const errors = [...this.closeErrors];
    for (const result of acceptedResults) {
      if (result.status === 'rejected') errors.push(result.reason);
    }

    // R2: the final saves were sealed synchronously at beginClose from each
    // tab's committed binding; wait for their receipts here. A failed write
    // reports its original error, skipped/conflict stay honest non-writes, and
    // cleanup proceeds for every tab regardless (P6 §4.5).
    const planResults = await Promise.allSettled(this.closeSavePlans);
    for (const result of planResults) {
      if (result.status === 'rejected') {
        errors.push(result.reason);
        continue;
      }
      for (const outcome of result.value) {
        if (outcome.status === 'settled' && outcome.receipt.status === 'failed') {
          errors.push(outcome.receipt.error);
        }
      }
    }

    // Observable final-save entry kept for close contracts that count the
    // controller save call; in coordinator mode the retiring owner rejects
    // admission silently (the sealed plan already carried the write).
    const finalSaves = this.retiringTabs
      .filter(tab => this.tabs.get(tab.id) === tab && !this.cleanupFlights.has(tab))
      .map(tab => Promise.resolve().then(() => tab.controllers.conversationController?.save()));
    const finalResults = await Promise.allSettled(finalSaves);
    for (const result of finalResults) {
      if (result.status === 'rejected') errors.push(result.reason);
    }

    const cleanupResults = await Promise.allSettled(this.retiringTabs.map(tab => this.cleanupTabOnce(tab)));
    for (const result of cleanupResults) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    this.tabs.clear();
    this.candidateTabs.clear();
    this.pendingConversationClaims.clear();
    this.providerCommandWarmups.clear();
    this.providerCommandCache.clear();
    // Retirement unsubscribes from every registry catalog slot: no static
    // listener may outlive the manager (§6 W4c).
    for (const unsubscribe of this.commandCatalogUnsubscribers.values()) {
      try { unsubscribe(); } catch { /* Retirement must not fail on a broken unsubscribe. */ }
    }
    this.commandCatalogUnsubscribers.clear();
    this.activeTabId = null;
    this.retirementState = 'retired';
    if (errors.length > 0) throw errors[0];
  }
}
