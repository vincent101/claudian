import { Menu, Notice, setIcon } from 'obsidian';

import { consumeHistoryText } from '../../../core/providers/consumeHistoryText';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import {
  type FullHistoryIterable,
  type HistoryIndexLease,
  type HistoryLoadProgress,
  type HistorySearchResult,
  HistorySourceUnavailableError,
  type HistoryWindowPage,
  type HistoryWindowRequest,
  type LoadedTurnRange,
  type ProviderConversationHistoryService,
  type ProviderId,
  type TitleGenerationService,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import { type ChatMessage, compareChatDisplayOrder, type Conversation } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';
import { confirm } from '../../../shared/modals/ConfirmModal';
import { getVaultPath } from '../../../utils/path';
import { recordHistoryDiagnosticEvent } from '../history/HistoryDiagnostics';
import { HISTORY_RESOURCE_POLICY } from '../history/HistoryResourcePolicy';
import type { HistoryPageInput, HistoryWindowRenderer } from '../rendering/HistoryWindowRenderer';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { ProjectionWriteCoordinator } from '../rendering/ProjectionWriteCoordinator';
import { cleanupThinkingBlock } from '../rendering/ThinkingBlockRenderer';
import { findRewindContext } from '../rewind';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type { ExternalContextSelector, McpServerSelector } from '../ui/InputToolbar';
import type { StatusPanel } from '../ui/StatusPanel';
import { refreshUsageContextWindow } from '../utils/usageInfo';
import { enumerateVisibleMatches, type HistorySearchSnapshotRefreshResult } from './HistorySearchController';

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
  /**
   * Per-tab projection write lease (coord protocol P1/P3): stored
   * transactions (paging prepend, search re-locate clear-rebuild) queue
   * behind any live streaming turn instead of clearing its DOM. Absent in
   * legacy tests → transactions run unguarded as before.
   */
  getProjectionCoordinator?: () => ProjectionWriteCoordinator | null;
  getHistoryWindowRenderer?: () => HistoryWindowRenderer | null;
  getTitleGenerationService: () => TitleGenerationService | null;
  getStatusPanel: () => StatusPanel | null;
  getAgentService?: () => ChatRuntime | null;
  getHistoryIndexCapableService: (
    conversation: Conversation,
  ) => ProviderConversationHistoryService | null;
  ensureServiceForConversation?: (conversation: Conversation | null) => Promise<void>;
  dismissPendingInlinePrompts?: () => void;
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
  reserveConversation?: (conversationId: string) => Promise<boolean>;
  commitConversation?: (conversationId: string) => void;
  cancelConversationReservation?: (conversationId: string) => void;
  releaseConversation?: (conversationId: string) => void;
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
  private projectionCache = new Map<string, HTMLElement>();
  /**
   * Candidates the provider index verified in detail text but the current
   * (summary/loaded) projection cannot mount — recorded for diagnostics only;
   * they never enter the navigable search results or the total.
   */
  private searchDiagnostics: HistorySearchResult[] = [];

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

    const outgoingConversationId = state.currentConversationId;
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
      this.deps.getHistoryWindowRenderer?.()?.reset();
      state.currentConversationId = null;
      if (outgoingConversationId) this.deps.releaseConversation?.(outgoingConversationId);
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

      await this.runStoredTransaction(async () => {
        const messagesEl = this.deps.getMessagesEl();
        messagesEl.empty();

        // Recreate welcome element first (before StatusPanel for consistent ordering)
        const welcomeEl = messagesEl.createDiv({ cls: 'claudian-welcome' });
        welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });
        this.deps.setWelcomeEl(welcomeEl);

        // Remount StatusPanel to restore state for new conversation
        this.deps.getStatusPanel()?.remount();
      });

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
    const conversation = conversationId ? await plugin.getConversationById(conversationId) : null;
    let firstScreen: HistoryWindowPage | null = null;
    if (conversation) {
      const historyService = this.deps.getHistoryIndexCapableService(conversation);
      const isTranscriptlessDraft = historyService
        && typeof historyService.resolveSessionIdForConversation === 'function'
        && typeof historyService.isPendingForkConversation === 'function'
        && historyService.resolveSessionIdForConversation(conversation) === null
        && !historyService.isPendingForkConversation(conversation);
      if (historyService && !isTranscriptlessDraft) {
        state.historyLoading = true;
        const lease = this.acquireLease(conversation, historyService);
        let transferred = false;
        try {
          await lease.ready;
          firstScreen = await this.loadFirstScreenWindow(lease);
          if (!shouldApply()) return;
          state.historyLease?.release();
          state.historyLease = lease;
          transferred = true;
          state.loadedRanges = [firstScreen.range];
          state.historyHasMore = firstScreen.hasMoreBefore;
          state.historySnapshotOffset = firstScreen.snapshotOffset ?? null;
          state.historyError = null;
          await this.backfillLegacyHistoryMetadata(conversation, firstScreen);
        } finally {
          if (!transferred) lease.release();
          state.historyLoading = false;
        }
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
    await this.restoreConversation(conversation, firstScreen, { autoAttachFile: true });
    this.updateWelcomeVisibility();

    this.renderHistoryPager();
    this.callbacks.onConversationLoaded?.();
  }

  async loadOlderHistory(): Promise<void> {
    const { state } = this.deps;
    const lease = state.historyLease;
    if (!lease || state.historyLoading) return;
    await this.loadOlderWindow(lease);
  }

  async rematerializeHistoryPage(record: { pageKey: string; range: LoadedTurnRange; uiState: Map<string, { detailLoaded?: boolean }> }): Promise<HistoryPageInput | null> {
    const lease = this.deps.state.historyLease;
    const conversationId = this.deps.state.currentConversationId;
    if (!lease || !conversationId) return null;
    const detailMessageIds = [...record.uiState.entries()]
      .filter(([, ui]) => ui.detailLoaded)
      .map(([key]) => key.split(':detail:')[0]);
    const page = await lease.loadWindow({
      anchorTurn: record.range.start,
      direction: 'newer',
      budget: {
        ...HISTORY_RESOURCE_POLICY.paging,
        maxTurns: Math.max(1, record.range.end - record.range.start),
      },
      projectionLevel: 'summary',
      maxTurn: record.range.end,
    });
    if (conversationId !== this.deps.state.currentConversationId || page.pageKey !== record.pageKey) return null;
    const details = new Map<string, ChatMessage>();
    for (const messageId of new Set(detailMessageIds)) {
      const result = await lease.loadMessageDetail(messageId, { maxSourceBytes: 16 * 1024 * 1024 });
      if (result.status === 'exact') details.set(messageId, result.message);
    }
    return this.toPageInput({
      ...page,
      messages: page.messages.map(message => details.get(message.id) ?? message),
    });
  }

  /**
   * P3 stored transaction: history load + ChatState merge + render + queue
   * drain runs as one unit under the projection write lease, FIFO-queued
   * behind any live streaming turn so it can never clear the turn's DOM.
   * A conversation switch cancels the queued transaction (P7: conditional,
   * no timers) — and, because switchTo does not set isStreaming, the switch
   * can also happen while an already-granted task is suspended on an await.
   * The task body must therefore revalidate the conversation id captured at
   * request time after every await and abort silently (design §3.6): a stale
   * page must never merge into, render into, or paginate the newly displayed
   * conversation. Without a coordinator (legacy wiring) the task runs
   * directly, under the same revalidation.
   */
  private async runStoredTransaction<T>(
    task: (isStale: () => boolean) => Promise<T>,
  ): Promise<T | null> {
    const conversationId = this.deps.state.currentConversationId;
    const isStale = (): boolean => this.deps.state.currentConversationId !== conversationId;
    const coordinator = this.deps.getProjectionCoordinator?.() ?? null;
    if (!coordinator) {
      return task(isStale);
    }
    return coordinator.runStored(isStale, () => task(isStale));
  }

  /**
   * Backfills history metadata onto legacy conversations that predate the
   * hasHistory/messageCount fields, so warmup/passive sync in the same
   * restore observes history state instead of misjudging the session empty.
   */
  private async backfillLegacyHistoryMetadata(
    conversation: Conversation,
    firstScreen: HistoryWindowPage,
  ): Promise<void> {
    if (conversation.hasHistory === true || firstScreen.messages.length === 0) return;
    const firstUser = firstScreen.messages.find(message => message.role === 'user');
    const backfill: Partial<Conversation> = {
      hasHistory: true,
      // A partial page is not a truthful conversation message count.
      ...(firstScreen.hasMoreBefore || firstScreen.hasMoreAfter
        ? {}
        : { messageCount: firstScreen.messages.length }),
      preview: firstUser ? (firstUser.displayContent ?? firstUser.content).slice(0, 50) : undefined,
      firstUserExcerpt: firstUser
        ? (firstUser.displayContent ?? firstUser.content).slice(0, 300)
        : undefined,
    };
    // Update the shell before persistence so warmup/passive sync in the
    // same restore observes history metadata immediately.
    Object.assign(conversation, backfill);
    await this.deps.plugin.updateConversation(conversation.id, backfill);
  }

  /** Budget-window first screen; every oversized turn arrives as a summary projection. */
  private async loadFirstScreenWindow(lease: HistoryIndexLease): Promise<HistoryWindowPage> {
    const request: HistoryWindowRequest = {
      anchorTurn: lease.totalTurns,
      direction: 'older',
      budget: HISTORY_RESOURCE_POLICY.firstScreen,
      projectionLevel: 'summary',
    };
    const planned = lease.planWindow(request);
    this.deps.onHistoryLoadProgress?.({
      phase: 'loading',
      turnCount: Math.max(0, planned.end - planned.start),
    });
    return lease.loadWindow(request);
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
      await this.runStoredTransaction(async isStale => {
        const page = await lease.loadWindow({
          anchorTurn: anchor,
          direction: 'older',
          budget: HISTORY_RESOURCE_POLICY.paging,
          projectionLevel: 'summary',
          minTurn: older ? older.end : 0,
        });
        if (isStale()) return;
        const existingIds = new Set(state.messages.map(message => message.id));
        const added = page.messages.filter(message => !existingIds.has(message.id));
        const combined = [...state.messages, ...added].sort(compareChatDisplayOrder);
        state.messages = combined;
        const addedIds = new Set(added.map(message => message.id));
        const prepend = combined.filter(message => addedIds.has(message.id));
        const windowRenderer = this.deps.getHistoryWindowRenderer?.();
        if (windowRenderer) {
          windowRenderer.addPage(this.toPageInput(page), total);
          windowRenderer.sampleIntent('older');
        } else this.deps.renderer.prependMessages(prepend, combined);
        await this.deps.renderer.waitForRenderedMessages();
        if (isStale()) return;
        state.loadedRanges = this.mergeRanges([...state.loadedRanges, page.range]);
        state.historyHasMore = !this.coversAll(state.loadedRanges, total);
        state.historySnapshotOffset = page.snapshotOffset ?? state.historySnapshotOffset;
      });
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
    this.searchDiagnostics = [];
    const lease = this.deps.state.historyLease;
    // Providers without a history index (Codex/OpenCode fully-hydrated tabs)
    // fall back to the loaded messages: only currently mounted projections
    // can be navigated, so the fallback enumerates visible DOM matches and
    // never triggers a window load.
    if (!lease) return this.searchLoadedMessages(query);
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
      const loadedMessage = this.deps.state.messages.find(message => message.id === group[0].projectionKey);
      let count: number;
      if (loaded && loadedMessage?.projectionLevel !== 'summary') {
        await this.deps.renderer.waitForMessageContentRendered(group[0].projectionKey);
        count = enumerateVisibleMatches(loaded, query).length;
      } else {
        const message = await this.loadSearchCandidate(group[0].turnIndex, group[0].projectionKey);
        if (!message) {
          this.searchDiagnostics.push(...group.map(item => ({ ...item, status: 'projection_mismatch' as const })));
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
      // Only matches the current projection can actually mount become
      // navigable results; detail-verified but unmountable ordinals (summary
      // trimmed their text) stay diagnostics so the total never lies.
      for (const item of group) {
        if (item.matchOrdinal < count) results.push(item);
        else this.searchDiagnostics.push({ ...item, status: 'projection_mismatch' as const });
      }
    }
    return results;
  }

  /** Diagnostics from the most recent searchHistory call (never navigable). */
  getSearchDiagnostics(): HistorySearchResult[] {
    return this.searchDiagnostics;
  }

  /**
   * Lease-less search over fully-hydrated state.messages. Mirrors the leased
   * path's mountability rule: a message without a rendered DOM projection is
   * skipped (counted nowhere) rather than force-located.
   */
  private async searchLoadedMessages(query: string): Promise<HistorySearchResult[]> {
    const needle = query.trim();
    if (!needle) return [];
    const results: HistorySearchResult[] = [];
    const messages = this.deps.state.messages;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      const element = this.deps.renderer.findMessageElement(message.id);
      if (!element) continue;
      await this.deps.renderer.waitForMessageContentRendered(message.id);
      for (const match of enumerateVisibleMatches(element, query)) {
        results.push({
          projectionKey: message.id,
          turnIndex: messageIndex,
          matchOrdinal: match.ordinal,
          matchedText: match.ranges.map(range => range.toString()).join(''),
        });
      }
    }
    return results;
  }

  private async loadSearchCandidate(_turnIndex: number, projectionKey: string) {
    const lease = this.deps.state.historyLease;
    if (!lease) return null;
    const detail = await lease.loadMessageDetail(projectionKey, { maxSourceBytes: 16 * 1024 * 1024 });
    return detail.status === 'exact' ? detail.message : null;
  }

  private contentHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(36);
  }

  async refreshHistorySearchSnapshot(): Promise<HistorySearchSnapshotRefreshResult> {
    const { plugin, state } = this.deps;
    const startedAt = performance.now();
    const conversationId = state.currentConversationId;
    // Early returns are capability/state branches, not failures: the caller
    // keeps searching whatever the tab already has. Providers without an
    // index (Codex/OpenCode lease-less search) must never be reported as a
    // staleness problem.
    if (!conversationId) {
      return this.reportRefreshNotApplicable('no_conversation', startedAt);
    }
    const conversation = plugin.getConversationSync(conversationId);
    if (!conversation) {
      return this.reportRefreshNotApplicable('no_conversation', startedAt);
    }
    const service = this.deps.getHistoryIndexCapableService(conversation);
    if (!service) {
      return this.reportRefreshNotApplicable('provider_without_index', startedAt);
    }
    if (!state.historyLease) {
      return this.reportRefreshNotApplicable('no_lease', startedAt);
    }
    const previous = state.historyLease;
    // Rollback path: the old lease stays live until the new snapshot is ready,
    // so a failed refresh keeps pagination and search usable on stale data.
    // Silent acquire: the refresh runs after stream completion with the tab
    // already READY, so index progress must not touch the rendered messages.
    const next = this.acquireLease(conversation, service, true, false);
    state.historyLease = next;
    try {
      await next.ready;
    } catch (error) {
      next.release();
      if (state.historyLease === next) {
        // Still the mounted lease: restore the still-live previous one.
        state.historyLease = previous;
      } else {
        // A conversation switch (or takeover) already released and unmounted
        // `next`; `previous` lost its last reference — release it so the
        // exchange cannot leak a protected index.
        previous.release();
      }
      recordHistoryDiagnosticEvent({ kind: 'search_snapshot_refresh', outcome: 'failed', elapsedMs: performance.now() - startedAt });
      throw error;
    }
    // Exchange completed (or raced with a switch): `previous` ends its
    // reference here either way; the mounted state is never rewritten.
    previous.release();
    // The lease reports what actually happened; without a service-provided
    // outcome the honest report is rebuilt (a fresh acquire did run).
    const outcome = next.acquireOutcome === 'cache_hit' ? 'cache_hit' : 'rebuilt';
    recordHistoryDiagnosticEvent({ kind: 'search_snapshot_refresh', outcome, elapsedMs: performance.now() - startedAt });
    return outcome === 'cache_hit' ? { status: 'cache_hit' } : { status: 'rebuilt' };
  }

  private reportRefreshNotApplicable(
    reason: 'no_conversation' | 'no_lease' | 'provider_without_index',
    startedAt: number,
  ): HistorySearchSnapshotRefreshResult {
    recordHistoryDiagnosticEvent({ kind: 'search_snapshot_refresh', outcome: 'not_applicable', reason, elapsedMs: performance.now() - startedAt });
    return { status: 'not_applicable', reason };
  }

  async locateHistorySearchResult(result: HistorySearchResult): Promise<HTMLElement> {
    const { renderer } = this.deps;
    const conversationId = this.deps.state.currentConversationId;
    if (result.status === 'projection_mismatch') throw new Error('projection_mismatch');
    let target = renderer.findMessageElement(result.projectionKey);
    if (!target && await this.deps.getHistoryWindowRenderer?.()?.revealMessage(result.projectionKey)) {
      target = renderer.findMessageElement(result.projectionKey);
    }
    const mountedMessage = this.deps.state.messages.find(message => message.id === result.projectionKey);
    if (!target || mountedMessage?.projectionLevel === 'summary') {
      // UX (coord protocol risk 1): the re-locate queues behind a live
      // streaming turn (P3) — say so instead of letting the click look dead
      // until the response completes.
      if (this.deps.getProjectionCoordinator?.()?.hasLiveTurn()) {
        new Notice(t('chat.search.locateDeferred'));
      }
      const detail = await this.loadSearchCandidate(result.turnIndex, result.projectionKey);
      if (!detail || this.deps.state.currentConversationId !== conversationId) throw new Error('projection_mismatch');
      await this.loadSearchResultWindow(result.turnIndex, detail);
      // Frame-batched rendering mounts asynchronously; the element can only be
      // located after the queue drains.
      await renderer.waitForRenderedMessages?.();
      target = renderer.findMessageElement(result.projectionKey);
    }
    if (!target) throw new Error('projection_mismatch');
    return target;
  }

  /**
   * Search locate materializes only the hit turn through the searchLocate
   * budget window. The summary projection matches the first screen, so the
   * The around window supplies neighboring context; the separately loaded
   * exact detail replaces the target projection before mounting.
   */
  private async loadSearchResultWindow(turnIndex: number, detail: ChatMessage): Promise<void> {
    const { state } = this.deps;
    const lease = state.historyLease;
    if (!lease) throw new Error('History lease unavailable');
    // P3: the whole re-locate (load → exact replacement → rebuild → drain) is
    // one stored transaction, queued behind a live turn when one is streaming.
    await this.runStoredTransaction(async isStale => {
      const page = await lease.loadWindow({
        anchorTurn: turnIndex,
        direction: 'around',
        budget: HISTORY_RESOURCE_POLICY.searchLocate,
        projectionLevel: 'summary',
      });
      if (isStale()) return;
      const byId = new Map(state.messages.map(message => [message.id, message]));
      for (const message of page.messages) if (!byId.has(message.id)) byId.set(message.id, message);
      const windowProjection = page.messages.find(message => message.id === detail.id);
      if (!detail.displayOrder && windowProjection?.displayOrder) detail.displayOrder = windowProjection.displayOrder;
      byId.set(detail.id, detail);
      const combined = [...byId.values()].sort(compareChatDisplayOrder);
      state.messages = combined;
      const windowRenderer = this.deps.getHistoryWindowRenderer?.();
      if (windowRenderer) {
        if (!windowRenderer.replaceMessage(detail, 'search')) {
          windowRenderer.addPage(this.toPageInput({
            ...page,
            messages: page.messages.map(message => message.id === detail.id ? detail : message),
          }), lease.totalTurns, 'search');
        }
      } else {
        this.deps.renderer.renderMessages(combined, () => this.getGreeting());
      }
      await this.deps.renderer.waitForRenderedMessages();
      if (isStale()) return;
      state.loadedRanges = this.mergeRanges([...state.loadedRanges, page.range]);
      state.historyHasMore = !this.coversAll(state.loadedRanges, lease.totalTurns);
      state.historySnapshotOffset = page.snapshotOffset ?? state.historySnapshotOffset;
    });
  }

  private toPageInput(page: HistoryWindowPage): HistoryPageInput {
    return {
      pageKey: page.pageKey,
      range: page.range,
      messages: page.messages,
      projectedWeight: page.projectedWeight ?? page.projectedChars * 2,
    };
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

  private acquireLease(conversation: Conversation, service: { acquireHistoryIndex?: (
    conversation: Conversation,
    vaultPath: string | null,
    onProgress?: (progress: HistoryLoadProgress) => void,
    forceNewSnapshot?: boolean,
  ) => HistoryIndexLease }, forceNewSnapshot = false, notifyProgress = true): HistoryIndexLease {
    // Silent acquires (warm-up lease, search snapshot refresh) omit the
    // callback entirely — the service only emits progress when one is
    // passed — so their async index events can never drive the hydration
    // placeholder over messages that are already rendered.
    const progress = notifyProgress
      ? (value: HistoryLoadProgress) => this.deps.onHistoryLoadProgress?.(value)
      : undefined;
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

    if (this.deps.reserveConversation && !(await this.deps.reserveConversation(id))) return;
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
        this.deps.cancelConversationReservation?.(id);
        return;
      }

      const historyService = this.deps.getHistoryIndexCapableService(conversation);
      let firstScreen: HistoryWindowPage | null = null;
      let lease: HistoryIndexLease | null = null;
      if (historyService) {
        lease = this.acquireLease(conversation, historyService);
        try {
          await lease.ready;
          firstScreen = await this.loadFirstScreenWindow(lease);
          await this.backfillLegacyHistoryMetadata(conversation, firstScreen);
        } catch (error) {
          lease.release();
          throw error;
        }
      }

      await this.deps.ensureServiceForConversation?.(conversation);

      this.deps.getInputEl().value = '';
      this.deps.clearQueuedMessage();

      this.releaseSwitchedAwayHistory(previousConversationId, previousProviderId);
      this.deps.getHistoryWindowRenderer?.()?.reset();
      if (lease && firstScreen) {
        state.historyLease = lease;
        state.loadedRanges = [firstScreen.range];
        state.historyHasMore = firstScreen.hasMoreBefore;
        state.historySnapshotOffset = firstScreen.snapshotOffset ?? null;
      } else {
        // Non-index conversations have no pager: stale pagination flags from
        // the outgoing conversation must not leak a dead button.
        state.historyHasMore = false;
        state.historySnapshotOffset = null;
      }
      await this.restoreConversation(conversation, firstScreen);
      // Release while the tab still carries the outgoing claim; commit replaces it.
      if (previousConversationId) this.deps.releaseConversation?.(previousConversationId);
      this.deps.commitConversation?.(id);

      this.deps.getHistoryDropdown()?.removeClass('visible');
      this.updateWelcomeVisibility();
      // The restored projection owns the pager: switching in through the
      // dropdown bypasses loadActive, so the pager must be rendered here too
      // or a paged conversation shows no "Load earlier messages" button.
      this.renderHistoryPager();

      // P6: READY must mean the first-screen DOM is settled, not just that
      // the data arrived — the restored render queue drains first (the real
      // race protection is the projection lease; this is the UX semantics).
      await this.deps.renderer.waitForRenderedMessages();

      this.deps.markHydrationReady?.();

      this.callbacks.onConversationSwitched?.();
    } catch (error) {
      this.deps.cancelConversationReservation?.(id);
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
    const projectedUserMsg = msgs[userIdx];
    let userMsg = projectedUserMsg;
    if (projectedUserMsg.projectionLevel !== 'detail' && state.historyLease) {
      const detail = await state.historyLease.loadMessageDetail(projectedUserMsg.id, { maxSourceBytes: 16 * 1024 * 1024 });
      if (detail.status !== 'exact') {
        new Notice(t(detail.status === 'too_large' ? 'chat.rewind.detailTooLarge' : 'chat.rewind.detailUnavailable'));
        return;
      }
      userMsg = detail.message;
    }
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
    inputEl.value = userMsg.displayContent ?? userMsg.content;
    inputEl.focus();

    const windowRenderer = this.deps.getHistoryWindowRenderer?.() ?? null;
    if (windowRenderer && state.historyLease) {
      // F1: a windowed rewind must re-enter the window pipeline, not the
      // clear-rebuild legacy path — renderMessages bumps the DOM epoch and
      // empties messagesEl, orphaning every page wrapper while the page
      // store keeps the stale records (upsertPage then hands back detached
      // wrappers). Mirror switchTo: reset, then remount the surviving
      // projection as one synthetic page.
      const lease = state.historyLease;
      const rewindRecord = this.deps.state.historyPageStore.findByMessageId(userMessageId);
      const keepStart = rewindRecord?.range.start;
      const keepEnd = rewindRecord?.range.end ?? lease.totalTurns;
      await this.runStoredTransaction(async isStale => {
        if (isStale()) return;
        // Loaded ranges keep their union through the rewind page's end: turns
        // past the rewind point were loaded once and the stale index snapshot
        // must never re-materialize them, while the load-older anchor stays
        // at the surviving window start. Ranges beyond the rewind page are
        // dropped with their truncated messages.
        const kept = keepStart === undefined
          ? this.mergeRanges(state.loadedRanges)
          : this.mergeRanges([
            ...state.loadedRanges.filter(range => range.end <= keepStart),
            { start: keepStart, end: keepEnd },
          ]);
        windowRenderer.reset();
        const messagesEl = this.deps.getMessagesEl();
        messagesEl.empty();
        const welcomeEl = messagesEl.createDiv({ cls: 'claudian-welcome' });
        welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });
        this.deps.setWelcomeEl(welcomeEl);
        const pageStart = kept.length > 0 ? kept[0].start : (keepStart ?? lease.totalTurns);
        windowRenderer.addPage({
          pageKey: `rewind:${pageStart}:${keepEnd}`,
          range: { start: pageStart, end: keepEnd },
          messages: state.messages,
          projectedWeight: state.messages.reduce((sum, message) => sum + JSON.stringify(message).length * 2, 0),
        }, lease.totalTurns);
        state.loadedRanges = kept;
        state.historyHasMore = !this.coversAll(kept, keepEnd);
      });
      this.updateWelcomeVisibility();
      this.renderHistoryPager();
    } else {
      const welcomeEl = renderer.renderMessages(state.messages, () => this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();
    }

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

    const hasHistory = state.messages.length > 0 || conversation?.hasHistory === true;
    const firstUser = state.messages.find(message => message.role === 'user');
    const updates: Partial<Conversation> = {
      ...sessionUpdates,
      messages: conversation?.sessionId ? [] : state.messages,
      hasHistory,
      messageCount: Math.max(conversation?.messageCount ?? 0, state.messages.length),
      firstUserExcerpt: conversation?.firstUserExcerpt
        ?? (firstUser ? (firstUser.displayContent ?? firstUser.content).slice(0, 300) : undefined),
      preview: conversation?.preview
        ?? (firstUser ? (firstUser.displayContent ?? firstUser.content).slice(0, 50) : undefined),
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
  private async restoreConversation(
    conversation: Conversation,
    page: HistoryWindowPage | null,
    options?: { autoAttachFile?: boolean }
  ): Promise<void> {
    const { plugin, state, renderer } = this.deps;

    state.currentConversationId = conversation.id;
    state.messages = page ? [...page.messages] : [...conversation.messages];
    state.usage = conversation.usage ?? null;
    this.refreshUsageWindow(conversation);
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true;
    state.hasPendingConversationSave = false;

    // Clear status panels (auto-hide: panels reappear when agent creates new todos)
    state.currentTodos = null;

    const hasMessages = conversation.hasHistory === true
      || (conversation.messageCount ?? state.messages.length) > 0;

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

    await this.runStoredTransaction(async () => {
      const windowRenderer = this.deps.getHistoryWindowRenderer?.();
      if (page && windowRenderer) {
        const messagesEl = this.deps.getMessagesEl();
        messagesEl.empty();
        const welcomeEl = messagesEl.createDiv({ cls: 'claudian-welcome' });
        welcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: this.getGreeting() });
        this.deps.setWelcomeEl(welcomeEl);
        windowRenderer.addPage(this.toPageInput(page), state.historyLease?.totalTurns ?? page.range.end);
      } else {
        const welcomeEl = renderer.renderMessages(
          state.messages,
          () => this.getGreeting()
        );
        this.deps.setWelcomeEl(welcomeEl);
      }
    });
  }

  /**
   * Re-derives the usage denominator from the model the tab's selector will
   * show for this conversation's provider: the provider settings snapshot
   * (same source as the re-selection and settings-refresh chains), with the
   * persisted projection as fallback. The persisted usage.model is a runtime
   * label, never a denominator source (2.3.2 ②, user ruling 2026-09-17), and
   * settings may have changed since the snapshot was written, so neither
   * hydration nor tab-switch passive sync may trust the stored denominator.
   */
  refreshUsageWindow(conversation: Conversation): void {
    const usage = this.deps.state.usage;
    if (!usage || !conversation.providerId) {
      return;
    }

    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.deps.plugin.settings as unknown as Record<string, unknown>,
      conversation.providerId,
    );
    const snapshotModel = typeof providerSettings.model === 'string'
      ? providerSettings.model.trim()
      : '';
    const selectorModel = snapshotModel
      || this.deps.plugin.settings.savedProviderModel?.[conversation.providerId]
      || '';
    this.deps.state.usage = refreshUsageContextWindow(usage, {
      uiConfig: ProviderRegistry.getChatUIConfig(conversation.providerId),
      settings: providerSettings,
      selectorModel,
    });
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
      .setTitle(t('chat.history.export.file'))
      .onClick(() => void this.exportHistory(conversationId, title, false)));
    menu.addItem((menuItem) => menuItem
      .setTitle(t('chat.history.export.clipboard'))
      .onClick(() => void this.exportHistory(conversationId, title, true)));

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

  private async exportHistory(conversationId: string, title: string, clipboard: boolean): Promise<void> {
    const conversation = this.deps.plugin.getConversationSync(conversationId);
    const service = conversation ? ProviderRegistry.getConversationHistoryService(conversation.providerId) : null;
    if (!conversation || !service?.iterateFullHistory) {
      new Notice(t('chat.history.export.sourceUnavailable'));
      return;
    }
    let iterable: FullHistoryIterable;
    try {
      const hasTranscriptIdentity = service.resolveSessionIdForConversation(conversation) !== null;
      if (!hasTranscriptIdentity && conversationId === this.deps.state.currentConversationId && this.deps.state.messages.length > 0) {
        const messages = [...this.deps.state.messages];
        iterable = {
          async *[Symbol.asyncIterator]() {
            yield { messages, range: { start: 0, end: 1 }, sourceBytes: 0, done: true };
          },
        };
      } else {
        iterable = service.iterateFullHistory(conversation, getVaultPath(this.deps.plugin.app), {
          maxTurnsPerChunk: 50,
          maxSourceBytesPerChunk: 8 * 1024 * 1024,
          maxProjectedCharsPerChunk: 2 * 1024 * 1024,
          projectionLevel: 'detail',
        });
      }
    } catch (error) {
      new Notice(error instanceof HistorySourceUnavailableError
        ? t('chat.history.export.sourceUnavailable')
        : t('chat.history.export.failed'));
      return;
    }
    let partialPath: string | null = null;
    try {
      if (clipboard) {
        const parts: string[] = [];
        let bytes = 0;
        await consumeHistoryText(iterable, {
          write: async text => {
            bytes += new TextEncoder().encode(text).byteLength;
            if (bytes > 4 * 1024 * 1024) throw new RangeError('clipboard_limit');
            parts.push(text);
          },
        });
        await navigator.clipboard.writeText(parts.join(''));
        new Notice(t('chat.history.export.clipboardSuccess'));
        return;
      }
      const adapter = this.deps.plugin.app.vault.adapter;
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').trim() || 'conversation';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const directory = '.claudian/exports';
      const path = `${directory}/${safeTitle}-${stamp}.md`;
      partialPath = `${path}.partial`;
      if (!await adapter.exists(directory)) await adapter.mkdir(directory);
      await adapter.write(partialPath, '');
      await consumeHistoryText(iterable, { write: text => adapter.append(partialPath!, text) });
      await adapter.rename(partialPath, path);
      partialPath = null;
      new Notice(t('chat.history.export.fileSuccess', { path }));
    } catch (error) {
      if (partialPath) {
        try { await this.deps.plugin.app.vault.adapter.remove(partialPath); } catch { /* best-effort cleanup */ }
      }
      if (error instanceof RangeError && error.message === 'clipboard_limit') {
        new Notice(t('chat.history.export.clipboardTooLarge'));
      } else if (error instanceof HistorySourceUnavailableError) {
        new Notice(t('chat.history.export.sourceUnavailable'));
      } else {
        new Notice(t('chat.history.export.failed'));
      }
    }
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

    const fullConv = await plugin.getConversationById(conversationId);
    if (!fullConv) return;
    const service = this.deps.getHistoryIndexCapableService(fullConv);
    const bounded = service?.loadTitleMaterial
      ? await service.loadTitleMaterial(fullConv, getVaultPath(plugin.app))
      : null;
    const firstUser = fullConv.messages.find(message => message.role === 'user');
    const firstContent = bounded?.firstUserExcerpt
      ?? fullConv.firstUserExcerpt
      ?? (firstUser ? (firstUser.displayContent ?? firstUser.content).slice(0, 300) : '');
    if (!firstContent) return;

    const titleService = this.deps.getTitleGenerationService();
    if (!titleService) return;

    const recentExcerpt = bounded?.recentUserExcerpts.join('\n- ')
      ?? fullConv.messages.filter(message => message.role === 'user').slice(-3)
        .map(message => (message.displayContent ?? message.content).slice(0, 100)).join('\n- ');
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
