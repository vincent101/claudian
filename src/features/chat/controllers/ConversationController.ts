import { Menu, Notice, setIcon } from 'obsidian';

import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import {
  ConversationHistoryHydrationError,
  type HistoryIndexLease,
  type HistoryLoadProgress,
  type HistorySearchResult,
  type HistoryWindowRequest,
  type LoadedTurnRange,
  type ProviderId,
  type TitleGenerationService,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { ChatMessage, Conversation } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';
import { confirm } from '../../../shared/modals/ConfirmModal';
import { getVaultPath } from '../../../utils/path';
import { HISTORY_RESOURCE_POLICY } from '../history/HistoryResourcePolicy';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import { cleanupThinkingBlock } from '../rendering/ThinkingBlockRenderer';
import { findRewindContext } from '../rewind';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type { ExternalContextSelector, McpServerSelector } from '../ui/InputToolbar';
import type { StatusPanel } from '../ui/StatusPanel';
import { enumerateVisibleMatches } from './HistorySearchController';

export interface ConversationCallbacks {
  onNewConversation?: () => void;
  onConversationLoaded?: () => void;
  onConversationSwitched?: () => void;
}

export interface ConversationControllerDeps {
  plugin: ClaudianPlugin;
  state: ChatState;
  renderer: MessageRenderer;
  subagentManager: SubagentManager;
  getHistoryDropdown: () => HTMLElement | null;
  getWelcomeEl: () => HTMLElement | null;
  setWelcomeEl: (el: HTMLElement | null) => void;
  getMessagesEl: () => HTMLElement;
  getInputEl: () => HTMLTextAreaElement;
  getFileContextManager: () => FileContextManager | null;
  getImageContextManager: () => ImageContextManager | null;
  getMcpServerSelector: () => McpServerSelector | null;
  getExternalContextSelector: () => ExternalContextSelector | null;
  clearQueuedMessage: () => void;
  /** S2 lifecycle cancellation: invalidate the feature turn lease (generation++). */
  invalidateTurnLifecycle?: () => void;
  getTitleGenerationService: () => TitleGenerationService | null;
  getStatusPanel: () => StatusPanel | null;
  getAgentService?: () => ChatRuntime | null;
  ensureServiceForConversation?: (conversation: Conversation | null) => Promise<void>;
  dismissPendingInlinePrompts?: () => void;
  /**
   * M1 shell semantics for active opens: route a hydration-blocked switch
   * (oversize/failed segments) onto the tab-level shell state machine so the
   * blocked placeholder renders instead of the switch failing silently.
   */
  switchToHydrationShell?: (conversationId: string) => void;
  /**
   * Reports a direct (non-shell) load/switch completion so the tab-level
   * hydration state resets and a blocked input is re-enabled.
   */
  markHydrationReady?: () => void;
  /**
   * Whether the tab-level hydration reached READY. While false, the tab is
   * bound to a conversation whose runtime/contexts may not be restored yet,
   * so save() must not persist (see the guard in save()).
   */
  isHydrationReady?: () => boolean;
  onHistoryLoadProgress?: (progress: HistoryLoadProgress) => void;
}

type SaveOptions = {
  resumeAtMessageId?: string;
};

export type HistoryConversationOpenState = 'closed' | 'open' | 'current';

type HistoryRenderOptions = {
  onSelectConversation: (id: string) => Promise<void>;
  onOpenConversationInNewTab?: (id: string, activate?: boolean) => Promise<void>;
  getConversationOpenState?: (id: string) => HistoryConversationOpenState;
  onRerender: () => void;
};

export class ConversationController {
  private deps: ConversationControllerDeps;
  private callbacks: ConversationCallbacks;
  private rangeRequests = new Map<string, Promise<void>>();
  private projectionCache = new Map<string, HTMLElement>();

  constructor(deps: ConversationControllerDeps, callbacks: ConversationCallbacks = {}) {
    this.deps = deps;
    this.callbacks = callbacks;
  }

  private getAgentService(): ChatRuntime | null {
    return this.deps.getAgentService?.() ?? null;
  }

  // ============================================
  // Conversation Lifecycle
  // ============================================

  /**
   * Resets to entry point state (New Chat).
   *
   * Entry point is a blank UI state - no conversation is created until the
   * first message is sent. This prevents empty conversations cluttering history.
   */
  async createNew(options: { force?: boolean } = {}): Promise<void> {
    const { plugin, state, subagentManager } = this.deps;
    const force = !!options.force;
    if (state.isStreaming && !force) return;
    if (state.isCreatingConversation) return;
    if (state.isSwitchingConversation) return;

    // Set flag to block message sending during reset
    state.isCreatingConversation = true;

    try {
      this.deps.dismissPendingInlinePrompts?.();

      if (force && state.isStreaming) {
        state.cancelRequested = true;
        state.bumpStreamGeneration();
        this.getAgentService()?.cancel();
      }

      // S2 lifecycle cancellation: force-reset drops the feature lease and
      // invalidates every in-flight turn callback (generation++), so a late
      // auto-turn finish cannot write into the freshly blanked conversation.
      this.deps.invalidateTurnLifecycle?.();

      // Save current conversation if it has messages
      if (state.currentConversationId && state.messages.length > 0) {
        await this.save();
      }

      subagentManager.orphanAllActive();
      subagentManager.clear();

      // Clear streaming state and related DOM references
      cleanupThinkingBlock(state.currentThinkingState);
      state.currentContentEl = null;
      state.currentTextEl = null;
      state.currentTextContent = '';
      state.currentThinkingState = null;
      state.toolCallElements.clear();
      state.writeEditStates.clear();
      state.isStreaming = false;

      // Reset to entry point state - no conversation created yet
      state.currentConversationId = null;
      state.clearMessages();
      state.resetHistoryPagination();
      state.usage = null;
      state.currentTodos = null;
      state.pendingNewSessionPlan = null;
      state.planFilePath = null;
      state.prePlanPermissionMode = null;
      state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
      state.hasPendingConversationSave = false;

      // Reset agent service session (no session ID for entry point)
      // Pass persistent paths to prevent stale external contexts
      this.getAgentService()?.syncConversationState(
        null,
        plugin.settings.persistentExternalContextPaths || []
      );

      const messagesEl = this.deps.getMessagesEl();
      messagesEl.empty();

      // Recreate welcome element first (before StatusPanel for consistent ordering)
      const welcomeEl = messagesEl.createDiv({ cls: 'claudian-welcome' });
      welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });
      this.deps.setWelcomeEl(welcomeEl);

      // Remount StatusPanel to restore state for new conversation
      this.deps.getStatusPanel()?.remount();

      this.deps.getInputEl().value = '';

      const fileCtx = this.deps.getFileContextManager();
      fileCtx?.resetForNewConversation();
      fileCtx?.autoAttachActiveFile();

      this.deps.getImageContextManager()?.clearImages();
      this.deps.getMcpServerSelector()?.clearEnabled();
      // Pass current settings to ensure we have the most up-to-date persistent paths
      this.deps.getExternalContextSelector()?.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );
      this.deps.clearQueuedMessage();

      this.deps.markHydrationReady?.();

      this.callbacks.onNewConversation?.();
    } finally {
      state.isCreatingConversation = false;
    }
  }

  /**
   * Loads the current tab conversation, or starts at entry point if none.
   *
   * Entry point (no conversation) shows welcome screen without
   * creating a conversation. Conversation is created lazily on first message.
   */
  async loadActive(shouldApply: () => boolean = () => true): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    const conversationId = state.currentConversationId;
    let conversation: Conversation | null;
    let paged = false;
    try {
      conversation = conversationId ? await plugin.getConversationById(conversationId) : null;
    } catch (error) {
      if (!(error instanceof ConversationHistoryHydrationError) || error.result.status !== 'oversize' || !conversationId) {
        throw error;
      }
      conversation = plugin.getConversationSync(conversationId);
      if (!conversation) throw error;
      const historyService = ProviderRegistry.getConversationHistoryService(conversation.providerId);
      if (!historyService.acquireHistoryIndex) throw error;
      state.historyLoading = true;
      // No catch on purpose: a failed initial page must propagate its real
      // error so the tab-level catch renders it as a retryable ERROR
      // placeholder; rethrowing the oversize error instead would show only
      // the segment-size list and hide the cause (M3: any segment error
      // must be visible).
      const lease = this.acquireLease(conversation, historyService);
      // Single ownership transfer: only a successful write to
      // state.historyLease hands the lease over; every earlier failure
      // (ready, window load, generation invalidation) releases it exactly
      // once in the finally below.
      let transferred = false;
      try {
        await lease.ready;
        const firstScreen = lease.loadWindow
          ? await this.loadFirstScreenWindow(lease)
          : await this.loadLegacyFirstScreen(lease);
        if (!shouldApply()) {
          return;
        }
        // Write the page back into the stored conversation so every later
        // reader (tab service init, passive tab sync) sees the materialized
        // view the tab renders. Mirrors full hydration mutating the stored
        // conversation in place; session metadata never persists messages,
        // so this stays an in-memory view only.
        conversation.messages = firstScreen.messages;
        paged = true;
        state.historyLease = lease;
        transferred = true;
        state.loadedRanges = [firstScreen.range];
        state.historyHasMore = firstScreen.hasMoreBefore;
        state.historySnapshotOffset = firstScreen.snapshotOffset ?? null;
        state.historyError = null;
      } finally {
        if (!transferred) lease.release();
        state.historyLoading = false;
      }
    }
    if (!shouldApply()) return;

    // No active conversation - start at entry point
    if (!conversation) {
      state.currentConversationId = null;
      state.clearMessages();
      state.resetHistoryPagination();
      state.usage = null;
      state.currentTodos = null;
      state.pendingNewSessionPlan = null;
      state.planFilePath = null;
      state.prePlanPermissionMode = null;
      state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
      state.hasPendingConversationSave = false;

      // Pass persistent paths to prevent stale external contexts
      this.getAgentService()?.syncConversationState(
        null,
        plugin.settings.persistentExternalContextPaths || []
      );

      const fileCtx = this.deps.getFileContextManager();
      fileCtx?.resetForNewConversation();
      fileCtx?.autoAttachActiveFile();

      // Initialize external contexts with persistent paths from settings
      this.deps.getExternalContextSelector()?.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );

      this.deps.getMcpServerSelector()?.clearEnabled();

      const welcomeEl = renderer.renderMessages(
        [],
        () => this.getGreeting()
      );
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();

      this.callbacks.onConversationLoaded?.();
      return;
    }

    await this.deps.ensureServiceForConversation?.(conversation);
    this.restoreConversation(conversation, { autoAttachFile: true });
    if (!paged) this.bindHistoryLease(conversation);
    this.updateWelcomeVisibility();

    this.renderHistoryPager();
    this.callbacks.onConversationLoaded?.();
  }

  async loadOlderHistory(): Promise<void> {
    const { state } = this.deps;
    const lease = state.historyLease;
    if (!lease || state.historyLoading) return;
    if (lease.loadWindow) {
      await this.loadOlderWindow(lease);
      return;
    }
    const range = this.nextOlderRange(state.loadedRanges, lease.totalTurns, 50);
    if (!range) return;
    state.historyLoading = true;
    state.historyError = null;
    this.renderHistoryPager();
    try {
      await this.loadRange(range.start, range.end, false);
    } catch (error) {
      state.historyError = error instanceof Error ? error.message : String(error);
    } finally {
      state.historyLoading = false;
      this.renderHistoryPager();
    }
  }

  /** Budget-window first screen; every oversized turn arrives as a summary projection. */
  private async loadFirstScreenWindow(lease: HistoryIndexLease): Promise<{
    messages: ChatMessage[];
    range: LoadedTurnRange;
    hasMoreBefore: boolean;
    snapshotOffset?: number;
  }> {
    const request: HistoryWindowRequest = {
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: HISTORY_RESOURCE_POLICY.firstScreen,
      projectionLevel: 'summary',
    };
    const planned = lease.planWindow?.(request);
    this.deps.onHistoryLoadProgress?.({
      phase: 'loading',
      turnCount: planned ? Math.max(0, planned.end - planned.start) : HISTORY_RESOURCE_POLICY.firstScreen.maxTurns,
    });
    const page = await lease.loadWindow!(request);
    return {
      messages: page.messages,
      range: page.range,
      hasMoreBefore: page.hasMoreBefore,
      snapshotOffset: page.snapshotOffset,
    };
  }

  /** Legacy providers without loadWindow keep the fixed 50-turn first page. */
  private async loadLegacyFirstScreen(lease: HistoryIndexLease): Promise<{
    messages: ChatMessage[];
    range: LoadedTurnRange;
    hasMoreBefore: boolean;
    snapshotOffset?: number;
  }> {
    const start = Math.max(0, lease.totalTurns - 50);
    this.deps.onHistoryLoadProgress?.({ phase: 'loading', turnCount: lease.totalTurns - start });
    const page = await lease.loadRange(start, lease.totalTurns);
    return {
      messages: page.messages,
      range: page.range,
      hasMoreBefore: page.range.start > 0,
      snapshotOffset: page.snapshotOffset,
    };
  }

  /**
   * "Load earlier" through a budget window anchored at the newest loaded
   * range start, floored at the adjacent older range so already-loaded turns
   * are never re-materialized.
   */
  private async loadOlderWindow(lease: HistoryIndexLease): Promise<void> {
    const { state } = this.deps;
    const total = lease.totalTurns;
    const merged = this.mergeRanges(state.loadedRanges);
    const newest = merged.find(range => range.start <= total - 1 && range.end >= total);
    const anchor = newest ? newest.start : total;
    if (anchor <= 0) return;
    const older = [...merged].reverse().find(range => range.end <= anchor);
    state.historyLoading = true;
    state.historyError = null;
    this.renderHistoryPager();
    try {
      const page = await lease.loadWindow!({
        anchorTurn: anchor,
        direction: 'older',
        budget: HISTORY_RESOURCE_POLICY.paging,
        projectionLevel: 'summary',
        minTurn: older ? older.end : 0,
      });
      const existingIds = new Set(state.messages.map(message => message.id));
      const added = page.messages.filter(message => !existingIds.has(message.id));
      const combined = [...state.messages, ...added].sort((a, b) => a.timestamp - b.timestamp);
      state.messages = combined;
      const addedIds = new Set(added.map(message => message.id));
      const prepend = combined.filter(message => addedIds.has(message.id));
      this.deps.renderer.prependMessages(prepend, combined);
      state.loadedRanges = this.mergeRanges([...state.loadedRanges, page.range]);
      state.historyHasMore = !this.coversAll(state.loadedRanges, total);
      state.historySnapshotOffset = page.snapshotOffset ?? state.historySnapshotOffset;
    } catch (error) {
      state.historyError = error instanceof Error ? error.message : String(error);
    } finally {
      state.historyLoading = false;
      this.renderHistoryPager();
    }
  }

  private renderHistoryPager(): void {
    this.deps.renderer.renderHistoryPager(
      this.deps.state.historyHasMore,
      this.deps.state.historyLoading,
      this.deps.state.historyError,
      () => { void this.loadOlderHistory(); },
    );
  }

  async searchHistory(
    query: string,
    onPhase?: (phase: 'indexing' | 'searching') => void,
  ): Promise<HistorySearchResult[]> {
    const lease = this.deps.state.historyLease;
    if (!lease) return [];
    onPhase?.('indexing');
    await lease.ready;
    onPhase?.('searching');
    const candidates = await lease.search(query);
    const grouped = new Map<string, HistorySearchResult[]>();
    for (const candidate of candidates) {
      const group = grouped.get(candidate.projectionKey) ?? [];
      group.push(candidate);
      grouped.set(candidate.projectionKey, group);
    }
    const results: HistorySearchResult[] = [];
    for (const group of grouped.values()) {
      const loaded = this.deps.renderer.findMessageElement(group[0].projectionKey);
      let count: number;
      if (loaded) {
        await this.deps.renderer.waitForMessageContentRendered(group[0].projectionKey);
        count = enumerateVisibleMatches(loaded, query).length;
      } else {
        const message = await this.loadSearchCandidate(group[0].turnIndex, group[0].projectionKey);
        if (!message) {
          results.push(...group.map(item => ({ ...item, status: 'projection_mismatch' as const })));
          continue;
        }
        const hash = this.contentHash(JSON.stringify(message));
        const key = `${group[0].projectionKey}:${hash}`;
        let detached = this.projectionCache.get(key);
        if (!detached) {
          detached = await this.deps.renderer.renderSearchCandidate(message);
          this.projectionCache.set(key, detached);
          if (this.projectionCache.size > 100) this.projectionCache.delete(this.projectionCache.keys().next().value!);
        }
        count = enumerateVisibleMatches(detached, query).length;
      }
      results.push(...group.map(item => item.matchOrdinal < count ? item : ({ ...item, status: 'projection_mismatch' as const })));
    }
    return results;
  }

  private async loadSearchCandidate(turnIndex: number, projectionKey: string) {
    const lease = this.deps.state.historyLease;
    if (!lease) return null;
    const page = await lease.loadRange(turnIndex, Math.min(lease.totalTurns, turnIndex + 1));
    return page.messages.find(message => message.id === projectionKey) ?? null;
  }

  private contentHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(36);
  }

  async refreshHistorySearchSnapshot(): Promise<void> {
    const { plugin, state } = this.deps;
    const conversationId = state.currentConversationId;
    if (!conversationId || !state.historyLease) return;
    const conversation = plugin.getConversationSync(conversationId);
    if (!conversation) return;
    const service = ProviderRegistry.getConversationHistoryService(conversation.providerId);
    if (!service.acquireHistoryIndex) return;
    const previous = state.historyLease;
    // Rollback path: the old lease stays live until the new snapshot is ready,
    // so a failed refresh keeps pagination and search usable on stale data.
    const next = this.acquireLease(conversation, service, true);
    state.historyLease = next;
    try {
      await next.ready;
      previous.release();
    } catch (error) {
      next.release();
      if (state.historyLease === next) state.historyLease = previous;
      throw error;
    }
  }

  async locateHistorySearchResult(result: HistorySearchResult): Promise<HTMLElement> {
    const { state, renderer } = this.deps;
    if (result.status === 'projection_mismatch') throw new Error('projection_mismatch');
    let target = renderer.findMessageElement(result.projectionKey);
    if (!target) {
      const start = Math.max(0, Math.min(result.turnIndex, state.historyLease!.totalTurns - 50));
      await this.loadRange(start, Math.min(state.historyLease!.totalTurns, start + 50));
      // Frame-batched rendering mounts asynchronously; the element can only be
      // located after the queue drains.
      await renderer.waitForRenderedMessages?.();
      target = renderer.findMessageElement(result.projectionKey);
    }
    if (!target) throw new Error('projection_mismatch');
    return target;
  }

  private async loadRange(start: number, end: number, rerenderAll = true): Promise<void> {
    const { state, renderer } = this.deps;
    const lease = state.historyLease;
    if (!lease) throw new Error('History lease unavailable');
    const key = `${start}:${end}`;
    const existing = this.rangeRequests.get(key);
    if (existing) return existing;
    const request = (async () => {
      const page = await lease.loadRange(start, end);
      const existingIds = new Set(state.messages.map(message => message.id));
      const added = page.messages.filter(message => !existingIds.has(message.id));
      const combined = [...state.messages, ...added].sort((a, b) => a.timestamp - b.timestamp);
      state.messages = combined;
      if (rerenderAll) {
        renderer.renderMessages(combined, () => this.getGreeting());
      } else {
        const addedIds = new Set(added.map(message => message.id));
        const prepend = combined.filter(message => addedIds.has(message.id));
        renderer.prependMessages(prepend, combined);
      }
      state.loadedRanges = this.mergeRanges([...state.loadedRanges, page.range]);
      state.historyHasMore = !this.coversAll(state.loadedRanges, lease.totalTurns);
      state.historySnapshotOffset = page.snapshotOffset ?? state.historySnapshotOffset;
    })();
    this.rangeRequests.set(key, request);
    try {
      await request;
    } finally {
      this.rangeRequests.delete(key);
    }
  }

  private mergeRanges(ranges: LoadedTurnRange[]): LoadedTurnRange[] {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    const merged: LoadedTurnRange[] = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (!last || range.start > last.end) merged.push({ ...range });
      else last.end = Math.max(last.end, range.end);
    }
    return merged;
  }

  private coversAll(ranges: LoadedTurnRange[], total: number): boolean {
    return total === 0 || (ranges.length === 1 && ranges[0].start === 0 && ranges[0].end >= total);
  }

  private nextOlderRange(ranges: LoadedTurnRange[], total: number, pageSize: number): LoadedTurnRange | null {
    const merged = this.mergeRanges(ranges);
    const newest = merged.find(range => range.start <= total - 1 && range.end >= total);
    if (!newest) return total > 0 ? { start: Math.max(0, total - pageSize), end: total } : null;
    const older = [...merged].reverse().find(range => range.end <= newest!.start);
    const end = newest.start;
    if (end === 0) return null;
    const start = older ? Math.max(older.end, end - pageSize) : Math.max(0, end - pageSize);
    return start < end ? { start, end } : null;
  }

  private bindHistoryLease(conversation: Conversation): void {
    let service;
    try {
      service = ProviderRegistry.getConversationHistoryService(conversation.providerId);
    } catch {
      this.deps.state.resetHistoryPagination();
      return;
    }
    if (!service.acquireHistoryIndex) {
      this.deps.state.resetHistoryPagination();
      return;
    }
    this.deps.state.historyLease?.release();
    this.deps.state.historyLease = this.acquireLease(conversation, service);
    this.deps.state.loadedRanges = [];
    this.deps.state.historyHasMore = false;
  }

  private acquireLease(conversation: Conversation, service: { acquireHistoryIndex?: (
    conversation: Conversation,
    vaultPath: string | null,
    onProgress?: (progress: HistoryLoadProgress) => void,
    forceNewSnapshot?: boolean,
  ) => HistoryIndexLease }, forceNewSnapshot = false): HistoryIndexLease {
    const progress = (value: HistoryLoadProgress) => this.deps.onHistoryLoadProgress?.(value);
    const lease = forceNewSnapshot
      ? service.acquireHistoryIndex?.(conversation, getVaultPath(this.deps.plugin.app), progress, true)
      : service.acquireHistoryIndex?.(conversation, getVaultPath(this.deps.plugin.app), progress);
    if (!lease) throw new Error('Paged history is unavailable');
    return lease;
  }

  /** Switches to a different conversation. */
  async switchTo(id: string): Promise<void> {
    const { plugin, state, subagentManager } = this.deps;

    if (id === state.currentConversationId) return;
    if (state.isStreaming) return;
    if (state.isSwitchingConversation) return;
    if (state.isCreatingConversation) return;

    // Capture the outgoing conversation before the switch: once this tab
    // stops displaying it, its paged-history index protection must be
    // released (same release point as closeTab) or the protected index
    // stays pinned out of the LRU forever.
    const previousConversationId = state.currentConversationId;
    const previousProviderId = previousConversationId
      ? plugin.getConversationSync(previousConversationId)?.providerId
      : undefined;

    state.isSwitchingConversation = true;

    try {
      this.deps.dismissPendingInlinePrompts?.();

      // S2 lifecycle cancellation: an auto turn may start between the
      // isStreaming guard above and the restore below; invalidating the
      // lease generation keeps its late callbacks from writing into the
      // conversation being switched to.
      this.deps.invalidateTurnLifecycle?.();

      await this.save();

      subagentManager.orphanAllActive();
      subagentManager.clear();

      const conversation = await plugin.switchConversation(id);
      if (!conversation) {
        return;
      }

      await this.deps.ensureServiceForConversation?.(conversation);

      this.deps.getInputEl().value = '';
      this.deps.clearQueuedMessage();

      this.releaseSwitchedAwayHistory(previousConversationId, previousProviderId);
      this.restoreConversation(conversation);
      this.bindHistoryLease(conversation);

      this.deps.getHistoryDropdown()?.removeClass('visible');
      this.updateWelcomeVisibility();

      this.deps.markHydrationReady?.();

      this.callbacks.onConversationSwitched?.();
    } catch (error) {
      // Hydration-blocked opens follow the M1 shell semantics: keep the
      // switch but bind only the shell, then let the tab hydration state
      // machine render the oversize/error placeholder. Other errors
      // propagate to the caller (history dropdown surfaces a notice).
      if (
        error instanceof ConversationHistoryHydrationError
        && this.deps.switchToHydrationShell
      ) {
        this.deps.getHistoryDropdown()?.removeClass('visible');
        this.releaseSwitchedAwayHistory(previousConversationId, previousProviderId);
        this.deps.switchToHydrationShell(id);
        return;
      }
      throw error;
    } finally {
      state.isSwitchingConversation = false;
    }
  }

  /**
   * Releases the paged-history index protection of the conversation this tab
   * switched away from; mirrors closeTab so a protected transcript index
   * becomes LRU-evictable again instead of staying pinned.
   */
  private releaseSwitchedAwayHistory(
    conversationId: string | null,
    _providerId: ProviderId | undefined,
  ): void {
    if (!conversationId || !_providerId) return;
    this.deps.state.historyLease?.release();
    this.deps.state.historyLease = null;
    this.deps.state.loadedRanges = [];
  }

  async rewind(userMessageId: string): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    const agentServiceForCheck = this.getAgentService();
    if (agentServiceForCheck && !agentServiceForCheck.getCapabilities().supportsRewind) {
      new Notice(t('chat.rewind.failed', { error: 'Rewind is not supported by this provider.' }));
      return;
    }

    if (state.isStreaming) {
      new Notice(t('chat.rewind.unavailableStreaming'));
      return;
    }

    const msgs = state.messages;
    const userIdx = msgs.findIndex(m => m.id === userMessageId);
    if (userIdx === -1) {
      new Notice(t('chat.rewind.failed', { error: 'Message not found' }));
      return;
    }
    const userMsg = msgs[userIdx];
    if (!userMsg.userMessageId) {
      new Notice(t('chat.rewind.unavailableNoUuid'));
      return;
    }

    const rewindCtx = findRewindContext(msgs, userIdx);
    if (!rewindCtx.hasResponse || !rewindCtx.prevAssistantUuid) {
      new Notice(t('chat.rewind.unavailableNoUuid'));
      return;
    }
    const prevAssistantUuid = rewindCtx.prevAssistantUuid;

    const confirmed = await confirm(
      plugin.app,
      t('chat.rewind.confirmMessage'),
      t('chat.rewind.confirmButton')
    );
    if (!confirmed) return;

    if (state.isStreaming) {
      new Notice(t('chat.rewind.unavailableStreaming'));
      return;
    }

    const agentService = this.getAgentService();
    if (!agentService) {
      new Notice(t('chat.rewind.failed', { error: 'Agent service not available' }));
      return;
    }

    let result;
    try {
      result = await agentService.rewind(userMsg.userMessageId, prevAssistantUuid);
    } catch (e) {
      new Notice(t('chat.rewind.failed', { error: e instanceof Error ? e.message : 'Unknown error' }));
      return;
    }
    if (!result.canRewind) {
      new Notice(t('chat.rewind.cannot', { error: result.error ?? 'Unknown error' }));
      return;
    }

    state.truncateAt(userMessageId);

    const inputEl = this.deps.getInputEl();
    inputEl.value = userMsg.content;
    inputEl.focus();

    const welcomeEl = renderer.renderMessages(state.messages, () => this.getGreeting());
    this.deps.setWelcomeEl(welcomeEl);
    this.updateWelcomeVisibility();

    const filesChanged = result.filesChanged?.length ?? 0;
    let saveError: string | null = null;
    try {
      await this.save(false, { resumeAtMessageId: prevAssistantUuid });
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Failed to save';
    }

    if (saveError) {
      new Notice(t('chat.rewind.noticeSaveFailed', { count: String(filesChanged), error: saveError }));
      return;
    }

    new Notice(t('chat.rewind.notice', { count: String(filesChanged) }));
  }

  /**
   * Saves the current conversation.
   *
   * If we're at an entry point (no conversation yet) and have messages,
   * creates a new conversation first (lazy creation).
   *
   * For native sessions (new conversations with sessionId from SDK),
   * only metadata is saved - the SDK handles message persistence.
   */
  async save(updateLastResponse = false, options?: SaveOptions): Promise<void> {
    const { plugin, state } = this.deps;

    // Entry point with no messages - nothing to save
    if (!state.currentConversationId && state.messages.length === 0) {
      return;
    }

    // Shell-state guard: a non-READY tab is bound to a conversation whose
    // runtime may still be a parked foreign session (a hydration-blocked
    // switch throws before ensureServiceForConversation rebinds it) and
    // whose UI contexts have not been restored. Persisting here would
    // overwrite the conversation's sessionId/providerState with the parked
    // runtime's session and clear its persisted context fields, so skip the
    // write entirely — provider-native message storage is unaffected. A
    // missing hook (legacy wiring) keeps the previous behavior.
    if (this.deps.isHydrationReady && !this.deps.isHydrationReady()) {
      return;
    }

    const agentService = this.getAgentService();
    const sessionInvalidated = agentService?.consumeSessionInvalidation?.() ?? false;

    // Entry point with messages - create conversation lazily
    // New conversations always use SDK-native storage.
    if (!state.currentConversationId && state.messages.length > 0) {
      const initialSessionId = agentService?.getSessionId() ?? undefined;
      const conversation = await plugin.createConversation({
        providerId: agentService?.providerId,
        sessionId: initialSessionId,
      });
      state.currentConversationId = conversation.id;
    }

    const fileCtx = this.deps.getFileContextManager();
    const currentNote = fileCtx?.getCurrentNotePath() || undefined;
    const externalContextSelector = this.deps.getExternalContextSelector();
    const externalContextPaths = externalContextSelector?.getExternalContexts() ?? [];
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const enabledMcpServers = mcpServerSelector ? Array.from(mcpServerSelector.getEnabledServers()) : [];

    const conversation = plugin.getConversationSync(state.currentConversationId!);

    const { updates: sessionUpdates } = agentService
      ? agentService.buildSessionUpdates({ conversation, sessionInvalidated })
      : { updates: {} };

    const updates: Partial<Conversation> = {
      ...sessionUpdates,
      messages: state.messages,
      currentNote: currentNote,
      externalContextPaths: externalContextPaths.length > 0 ? externalContextPaths : undefined,
      usage: state.usage ?? undefined,
      enabledMcpServers: enabledMcpServers.length > 0 ? enabledMcpServers : undefined,
    };

    if (updateLastResponse) {
      updates.lastResponseAt = Date.now();
    }

    if (options) {
      updates.resumeAtMessageId = options.resumeAtMessageId;
    }

    await plugin.updateConversation(state.currentConversationId!, updates);
    state.hasPendingConversationSave = false;
  }

  /**
   * Shared logic for restoring a conversation into the current tab.
   * Used by both loadActive() and switchTo() to avoid duplication.
   */
  private restoreConversation(
    conversation: Conversation,
    options?: { autoAttachFile?: boolean }
  ): void {
    const { plugin, state, renderer } = this.deps;

    state.currentConversationId = conversation.id;
    state.messages = [...conversation.messages];
    state.usage = conversation.usage ?? null;
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
    state.hasPendingConversationSave = false;

    // Clear status panels (auto-hide: panels reappear when agent creates new todos)
    state.currentTodos = null;

    const hasMessages = state.messages.length > 0;

    // Determine external context paths for this session
    // Empty session: use persistent paths; session with messages: use saved paths
    const externalContextPaths = hasMessages
      ? conversation.externalContextPaths || []
      : plugin.settings.persistentExternalContextPaths || [];

    this.getAgentService()?.syncConversationState(conversation, externalContextPaths);

    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForLoadedConversation(hasMessages);

    if (conversation.currentNote) {
      fileCtx?.setCurrentNote(conversation.currentNote);
    } else if (!hasMessages && options?.autoAttachFile) {
      fileCtx?.autoAttachActiveFile();
    }

    this.restoreExternalContextPaths(conversation.externalContextPaths, !hasMessages);

    const mcpServerSelector = this.deps.getMcpServerSelector();
    if (conversation.enabledMcpServers && conversation.enabledMcpServers.length > 0) {
      mcpServerSelector?.setEnabledServers(conversation.enabledMcpServers);
    } else {
      mcpServerSelector?.clearEnabled();
    }

    const welcomeEl = renderer.renderMessages(
      state.messages,
      () => this.getGreeting()
    );
    this.deps.setWelcomeEl(welcomeEl);
  }

  /**
   * Restores external context paths based on session state.
   * New or empty sessions get current persistent paths from settings.
   * Sessions with messages restore exactly what was saved.
   */
  private restoreExternalContextPaths(
    savedPaths: string[] | undefined,
    isEmptySession: boolean
  ): void {
    const { plugin } = this.deps;
    const externalContextSelector = this.deps.getExternalContextSelector();
    if (!externalContextSelector) {
      return;
    }

    if (isEmptySession) {
      // Empty session: use current persistent paths from settings
      externalContextSelector.clearExternalContexts(
        plugin.settings.persistentExternalContextPaths || []
      );
    } else {
      // Session with messages: restore exactly what was saved
      externalContextSelector.setExternalContexts(savedPaths || []);
    }
  }

  // ============================================
  // History Dropdown
  // ============================================

  toggleHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    const isVisible = dropdown.hasClass('visible');
    if (isVisible) {
      dropdown.removeClass('visible');
    } else {
      this.updateHistoryDropdown();
      dropdown.addClass('visible');
    }
  }

  updateHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    this.renderHistoryItems(dropdown, {
      onSelectConversation: (id) => this.switchTo(id).catch((error: unknown) => {
        // Non-hydration failures have no shell route; surface them instead
        // of leaving an unhandled rejection with no user feedback.
        const message = error instanceof Error ? error.message : String(error);
        new Notice(t('chat.history.switchFailed', { error: message }));
      }),
      onRerender: () => this.updateHistoryDropdown(),
    });
  }

  /**
   * Renders history dropdown items to a container.
   * Shared implementation for updateHistoryDropdown() and renderHistoryDropdown().
   */
  private renderHistoryItems(
    container: HTMLElement,
    options: HistoryRenderOptions
  ): void {
    const { plugin, state } = this.deps;

    container.empty();

    const dropdownHeader = container.createDiv({ cls: 'claudian-history-header' });
    dropdownHeader.createSpan({ text: 'Conversations' });

    const list = container.createDiv({ cls: 'claudian-history-list' });
    const allConversations = plugin.getConversationList();

    if (allConversations.length === 0) {
      list.createDiv({ cls: 'claudian-history-empty', text: 'No conversations' });
      return;
    }

    // Sort by lastResponseAt (fallback to createdAt) descending
    const conversations = [...allConversations].sort((a, b) => {
      return (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt);
    });

    for (const conv of conversations) {
      const isCurrent = conv.id === state.currentConversationId;
      const item = list.createDiv({
        cls: `claudian-history-item${isCurrent ? ' active' : ''}`,
      });

      const iconEl = item.createDiv({ cls: 'claudian-history-item-icon' });
      setIcon(iconEl, isCurrent ? 'message-square-dot' : 'message-square');

      const content = item.createDiv({ cls: 'claudian-history-item-content' });
      const titleEl = content.createDiv({ cls: 'claudian-history-item-title', text: conv.title });
      titleEl.setAttribute('title', conv.title);
      content.createDiv({
        cls: 'claudian-history-item-date',
        text: isCurrent ? 'Current session' : this.formatDate(conv.lastResponseAt ?? conv.createdAt),
      });

      if (!isCurrent) {
        content.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.isHistoryNewTabModifierClick(e) && options.onOpenConversationInNewTab) {
            e.preventDefault();
            await this.runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conv.id, true),
              'Failed to load conversation',
            );
            return;
          }

          await this.runHistoryAction(
            () => options.onSelectConversation(conv.id),
            'Failed to load conversation',
          );
        });

        if (options.onOpenConversationInNewTab) {
          content.addEventListener('auxclick', async (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            e.stopPropagation();
            await this.runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conv.id, true),
              'Failed to load conversation',
            );
          });
        }
      }

      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showHistoryContextMenu(item, conv.id, conv.title, isCurrent, options, e);
      });

      const actions = item.createDiv({ cls: 'claudian-history-item-actions' });

      // Show regenerate button if title generation failed, or loading indicator if pending
      if (conv.titleGenerationStatus === 'pending') {
        const loadingEl = actions.createEl('span', { cls: 'claudian-action-btn claudian-action-loading' });
        setIcon(loadingEl, 'loader-2');
        loadingEl.setAttribute('aria-label', 'Generating title...');
      } else if (conv.titleGenerationStatus === 'failed') {
        const regenerateBtn = actions.createEl('button', { cls: 'claudian-action-btn' });
        setIcon(regenerateBtn, 'refresh-cw');
        regenerateBtn.setAttribute('aria-label', 'Regenerate title');
        regenerateBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await this.regenerateTitle(conv.id);
          } catch {
            new Notice('Failed to regenerate response');
          }
        });
      }

      const renameBtn = actions.createEl('button', { cls: 'claudian-action-btn' });
      setIcon(renameBtn, 'pencil');
      renameBtn.setAttribute('aria-label', 'Rename');
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showRenameInput(item, conv.id, conv.title);
      });

      const deleteBtn = actions.createEl('button', { cls: 'claudian-action-btn claudian-delete-btn' });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.setAttribute('aria-label', 'Delete');
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.runHistoryAction(
          () => this.deleteHistoryConversation(conv.id, options),
          'Failed to delete conversation',
        );
      });
    }
  }

  private isHistoryNewTabModifierClick(event: MouseEvent): boolean {
    return !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey);
  }

  private async runHistoryAction(
    action: () => Promise<void> | void,
    errorMessage: string,
  ): Promise<void> {
    try {
      await action();
    } catch {
      new Notice(errorMessage);
    }
  }

  private showHistoryContextMenu(
    item: HTMLElement,
    conversationId: string,
    title: string,
    isCurrent: boolean,
    options: HistoryRenderOptions,
    event: MouseEvent,
  ): void {
    const menu = new Menu();
    const openState = options.getConversationOpenState?.(conversationId) ?? (isCurrent ? 'current' : 'closed');

    if (!isCurrent) {
      if (openState === 'closed' && options.onOpenConversationInNewTab) {
        menu.addItem((menuItem) => menuItem
          .setTitle('Open in New Tab')
          .onClick(() => {
            void this.runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conversationId, true),
              'Failed to load conversation',
            );
          }));
        menu.addItem((menuItem) => menuItem
          .setTitle('Open in Background Tab')
          .onClick(() => {
            void this.runHistoryAction(
              () => options.onOpenConversationInNewTab?.(conversationId, false),
              'Failed to load conversation',
            );
          }));
      } else if (openState === 'open') {
        menu.addItem((menuItem) => menuItem
          .setTitle('Switch to Open Session')
          .onClick(() => {
            void this.runHistoryAction(
              () => options.onSelectConversation(conversationId),
              'Failed to load conversation',
            );
          }));
      }
    }

    menu.addItem((menuItem) => menuItem
      .setTitle('Rename')
      .onClick(() => {
        this.showRenameInput(item, conversationId, title);
      }));
    menu.addItem((menuItem) => menuItem
      .setTitle('Delete')
      .onClick(() => {
        void this.runHistoryAction(
          () => this.deleteHistoryConversation(conversationId, options),
          'Failed to delete conversation',
        );
      }));

    menu.showAtMouseEvent(event);
  }

  private async deleteHistoryConversation(
    conversationId: string,
    options: HistoryRenderOptions,
  ): Promise<void> {
    const { plugin, state } = this.deps;
    if (state.isStreaming) return;

    await plugin.deleteConversation(conversationId);
    options.onRerender();

    if (conversationId === state.currentConversationId) {
      await this.loadActive();
    }
  }

  /** Shows inline rename input for a conversation. */
  private showRenameInput(item: HTMLElement, convId: string, currentTitle: string): void {
    const titleEl = item.querySelector('.claudian-history-item-title') as HTMLElement;
    if (!titleEl) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'claudian-rename-input';
    input.value = currentTitle;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      try {
        const newTitle = input.value.trim() || currentTitle;
        await this.deps.plugin.renameConversation(convId, newTitle);
        await this.deps.plugin.updateConversation(convId, { titleGenerationStatus: undefined });
        this.updateHistoryDropdown();
      } catch {
        new Notice('Failed to rename conversation');
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', async (e) => {
      // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
      if (e.key === 'Enter' && !e.isComposing) {
        input.blur();
      } else if (e.key === 'Escape' && !e.isComposing) {
        input.value = currentTitle;
        input.blur();
      }
    });
  }

  // ============================================
  // Welcome & Greeting
  // ============================================

  /** Generates a dynamic greeting based on time/day. */
  getGreeting(): string {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0 = Sunday, 6 = Saturday
    const name = this.deps.plugin.settings.userName?.trim();

    // Helper to optionally personalize a greeting (with fallback for no-name case)
    const personalize = (base: string, noNameFallback?: string): string =>
      name ? `${base}, ${name}` : (noNameFallback ?? base);

    // Day-specific greetings (some personalized, some universal)
    const dayGreetings: Record<number, string[]> = {
      0: [personalize('Happy Sunday'), 'Sunday session?', 'Welcome to the weekend'],
      1: [personalize('Happy Monday'), personalize('Back at it', 'Back at it!')],
      2: [personalize('Happy Tuesday')],
      3: [personalize('Happy Wednesday')],
      4: [personalize('Happy Thursday')],
      5: [personalize('Happy Friday'), personalize('That Friday feeling')],
      6: [personalize('Happy Saturday', 'Happy Saturday!'), personalize('Welcome to the weekend')],
    };

    // Time-specific greetings
    const getTimeGreetings = (): string[] => {
      if (hour >= 5 && hour < 12) {
        return [personalize('Good morning'), 'Coffee and Claudian time?'];
      } else if (hour >= 12 && hour < 18) {
        return [personalize('Good afternoon'), personalize('Hey there'), personalize("How's it going") + '?'];
      } else if (hour >= 18 && hour < 22) {
        return [personalize('Good evening'), personalize('Evening'), personalize('How was your day') + '?'];
      } else {
        return ['Hello, night owl', personalize('Evening')];
      }
    };

    // General greetings
    const generalGreetings = [
      personalize('Hey there'),
      name ? `Hi ${name}, how are you?` : 'Hi, how are you?',
      personalize("How's it going") + '?',
      personalize('Welcome back') + '!',
      personalize("What's new") + '?',
      ...(name ? [`${name} returns!`] : []),
      'You are absolutely right!',
    ];

    // Combine day + time + general greetings, pick randomly
    const allGreetings = [
      ...(dayGreetings[day] || []),
      ...getTimeGreetings(),
      ...generalGreetings,
    ];

    return allGreetings[Math.floor(Math.random() * allGreetings.length)];
  }

  /** Updates welcome element visibility based on message count. */
  updateWelcomeVisibility(): void {
    const welcomeEl = this.deps.getWelcomeEl();
    if (!welcomeEl) return;

    if (this.deps.state.messages.length === 0) {
      welcomeEl.style.display = '';
    } else {
      welcomeEl.style.display = 'none';
    }
  }

  /**
   * Initializes the welcome greeting for a new tab without a conversation.
   * Called when a new tab is activated and has no conversation loaded.
   */
  initializeWelcome(): void {
    const welcomeEl = this.deps.getWelcomeEl();
    if (!welcomeEl) return;

    // Initialize file context to auto-attach the currently focused note
    const fileCtx = this.deps.getFileContextManager();
    fileCtx?.resetForNewConversation();
    fileCtx?.autoAttachActiveFile();

    // Only add greeting if not already present
    if (!welcomeEl.querySelector('.claudian-welcome-greeting')) {
      welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });
    }

    this.updateWelcomeVisibility();
  }

  // ============================================
  // Utilities
  // ============================================

  /** Generates a fallback title from the first message (used when AI fails). */
  generateFallbackTitle(firstMessage: string): string {
    const firstSentence = firstMessage.split(/[.!?\n]/)[0].trim();
    const autoTitle = firstSentence.substring(0, 50);
    const suffix = firstSentence.length > 50 ? '...' : '';
    return `${autoTitle}${suffix}`;
  }

  /** Regenerates AI title for a conversation. */
  async regenerateTitle(
    conversationId: string,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    const { silent = false } = options;
    const { plugin } = this.deps;
    if (!plugin.settings.enableAutoTitleGeneration) return;

    // Title generation is delegated to the active provider service
    const fullConv = await plugin.getConversationById(conversationId);
    if (!fullConv || fullConv.messages.length < 1) return;

    const titleService = this.deps.getTitleGenerationService();
    if (!titleService) return;

    // Find first user message by role (not by index)
    const firstUserMsg = fullConv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return;

    const isNoise = (text: string): boolean => {
      if (!text) return true;
      return /^This session is being continued/i.test(text) ||
        /^\[Request interrupted by user/i.test(text) ||
        /^<command-/i.test(text) ||
        /^<local-command-caveat>/i.test(text);
    };

    const firstContent = (firstUserMsg.displayContent || firstUserMsg.content || '').slice(0, 300);
    const userMsgs = fullConv.messages.filter(m => m.role === 'user');
    const highInfoMsgs: string[] = [];
    for (let i = userMsgs.length - 1; i >= 0 && highInfoMsgs.length < 5; i--) {
      const text = userMsgs[i].displayContent || userMsgs[i].content || '';
      if (!isNoise(text) && text.length >= 40) {
        highInfoMsgs.push(text.slice(0, 250));
      }
    }
    let recentExcerpt: string;
    if (highInfoMsgs.length > 0) {
      recentExcerpt = highInfoMsgs.join('\n- ');
    } else {
      const fallback = userMsgs.slice(-3).map(m => (m.displayContent || m.content || '').slice(0, 100));
      recentExcerpt = fallback.join('\n- ');
    }
    const material = `Current title: "${fullConv.title || ''}"
Return it unchanged if it still accurately summarizes the conversation below.

First request:
${firstContent}

Recent messages:
- ${recentExcerpt}`.slice(0, 1600);

    // Store current title to check if user renames during generation
    const expectedTitle = fullConv.title;

    // Set pending status before starting generation (skipped in silent mode)
    if (!silent) {
      await plugin.updateConversation(conversationId, { titleGenerationStatus: 'pending' });
      this.updateHistoryDropdown();
    }

    // Fire async AI title generation
    await titleService.generateTitle(
      conversationId,
      material,
      async (convId, result) => {
        // Check if conversation still exists and user hasn't manually renamed
        const currentConv = await plugin.getConversationById(convId);
        if (!currentConv) return;

        // Only apply AI title if user hasn't manually renamed (title still matches expected)
        const userManuallyRenamed = currentConv.title !== expectedTitle;

        if (result.success && !userManuallyRenamed) {
          await plugin.renameConversation(convId, result.title);
          await plugin.updateConversation(convId, { titleGenerationStatus: 'success' });
          this.updateHistoryDropdown();
        } else if (!silent && !userManuallyRenamed) {
          // Keep existing title, mark as failed (only if user hasn't renamed)
          await plugin.updateConversation(convId, { titleGenerationStatus: 'failed' });
          this.updateHistoryDropdown();
        }
      }
    );
  }

  /** Formats a timestamp for display. */
  formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ============================================
  // History Dropdown Rendering (for ClaudianView)
  // ============================================

  /**
   * Renders the history dropdown content to a provided container.
   * Used by ClaudianView to render the dropdown with custom selection callback.
   */
  renderHistoryDropdown(
    container: HTMLElement,
    options: Omit<HistoryRenderOptions, 'onRerender'>,
  ): void {
    this.renderHistoryItems(container, {
      ...options,
      onRerender: () => this.renderHistoryDropdown(container, options),
    });
  }
}
