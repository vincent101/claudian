import { Menu, Notice, setIcon } from 'obsidian';

import type { ConversationHistoryCoordinator } from '../../../app/ConversationHistoryCoordinator';
import type { ConversationMetadataSavePort } from '../../../app/ConversationMetadataSavePort';
import { consumeHistoryText } from '../../../core/providers/consumeHistoryText';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import {
  type FieldPatch,
  type FullHistoryIterable,
  type HistoryIndexLease,
  type HistoryLoadProgress,
  type HistorySearchResult,
  HistorySourceUnavailableError,
  type HistoryWindowPage,
  type HistoryWindowRequest,
  type JsonObject,
  type JsonValue,
  type LoadedTurnRange,
  type MetadataPatch,
  type OwnerToken,
  type ProviderConversationHistoryService,
  type ProviderId,
  type SaveReceipt,
  type SaveRequestResult,
  type SessionBindingPatch,
  type TitleGenerationService,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { CapturedSessionPersistence } from '../../../core/runtime/types';
import { type ChatMessage, compareChatDisplayOrder, type Conversation } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';
import { confirm } from '../../../shared/modals/ConfirmModal';
import { getVaultPath } from '../../../utils/path';
import { recordHistoryDiagnosticEvent } from '../history/HistoryDiagnostics';
import type { HistoryPageRetention } from '../history/HistoryPageStore';
import { HISTORY_RESOURCE_POLICY } from '../history/HistoryResourcePolicy';
import type { HistoryPageInput, HistoryWindowRenderer } from '../rendering/HistoryWindowRenderer';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { ProjectionWriteCoordinator } from '../rendering/ProjectionWriteCoordinator';
import { cleanupThinkingBlock } from '../rendering/ThinkingBlockRenderer';
import { findRewindContext } from '../rewind';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type {
  CloseSaveOutcome,
  CommitReceipt,
  PersistableBindingState,
  ReservationWitness,
  RuntimePersistencePort,
} from '../state/types';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type { ExternalContextSelector, McpServerSelector } from '../ui/InputToolbar';
import type { StatusPanel } from '../ui/StatusPanel';
import { formatConversationSize, formatConversationSizeTooltip } from '../utils/conversationSize';
import { formatActiveSessionIdentity, loadActiveSessionNames } from '../utils/sessionIdentity';
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
  /** Local view/tab admission only; it does not revoke accepted saves. */
  isManagerActive?: () => boolean;
  /**
   * R2 binding/save-admission wiring (stage 1). Absent in legacy unit fixtures —
   * the controller then keeps the pre-R2 save path.
   */
  getConversationHistoryCoordinator?: () => ConversationHistoryCoordinator | null;
  getConversationMetadataSavePort?: () => ConversationMetadataSavePort | null;
  /** Stable owner identity pair (view plays the manager role: one TabManager per view). */
  getBindingOwnerIdentity?: () => { manager: object; tab: object };
  /** Sync claim witness over the tab's pending/committed ConversationOpenRegistry claim. */
  getBindingReservation?: (conversationId: string) => ReservationWitness | null;
}

type SaveOptions = {
  resumeAtMessageId?: string;
};

export type HistoryConversationOpenState = 'closed' | 'open' | 'current';

type HistoryRenderOptions = {
  onSelectConversation: (id: string) => Promise<void>;
  onOpenConversationInNewTab?: (id: string, activate?: boolean) => Promise<void>;
  getConversationOpenState?: (id: string) => HistoryConversationOpenState;
  refreshSizes?: boolean;
  onRerender: () => void;
};

export class ConversationController {
  /**
   * Cap on the search-refresh exchange's FIFO wait for the stored grant —
   * never on the granted task body. The critical section itself is <ms
   * (lease pointer swap + two releases + one diagnostic write) and the index
   * build runs outside the grant, so the entire budget is pure queue time.
   * The exchange no longer queues behind live turns (B: it rides the stored
   * slot only), so this budget covers the S slot held by slow stored work —
   * a rewind rebuild or a large-page mount. Aborting costs nothing durable
   * (the old snapshot keeps serving; Retry / onStreamComplete / reopening
   * re-trigger) while a 60s wait already sits at the edge of "索引中" user
   * patience.
   */
  private static readonly REFRESH_EXCHANGE_GRANT_TIMEOUT_MS = 60_000;
  private deps: ConversationControllerDeps;
  private callbacks: ConversationCallbacks;
  private projectionCache = new Map<string, HTMLElement>();
  private readonly acceptedSaves = new Set<Promise<void>>();
  /**
   * Open-generation bookkeeping for history-menu size results: a refresh that
   * resolves for a menu epoch that has since closed must never write into the
   * currently rendered dropdown.
   */
  private historyMenuEpoch = 0;
  private historySizeRows = new Map<string, {
    epoch: number;
    container: HTMLElement;
    sizeEl: HTMLElement;
    conversation: Conversation | null;
    menuConversationId: string | null;
  }>();
  /**
   * The current row's identity-suffix target for this menu epoch. The session
   * registry is CC-external state scanned asynchronously, so the suffix first
   * renders from the last resolved scan (if any) and is backfilled under the
   * same epoch/visibility guards as the size rows when the scan resolves.
   */
  private historyIdentityRow: {
    epoch: number;
    container: HTMLElement;
    titleEl: HTMLElement;
    title: string;
    conversation: Conversation | null;
    menuConversationId: string | null;
  } | null = null;
  /** Last resolved registry scan; per-use scans keep it fresh, never cached as a promise. */
  private activeSessionNames: ReadonlyMap<string, string> = new Map();
  /**
   * Candidates the provider index verified in detail text but the current
   * (summary/loaded) projection cannot mount — recorded for diagnostics only;
   * they never enter the navigable search results or the total.
   */
  private searchDiagnostics: HistorySearchResult[] = [];
  /**
   * R2 binding/save-admission state (P6-0 core wiring, stage 1). The receipt
   * is the committed tab binding; saves target its record so the save target
   * and the session payload can never come from two different bindings.
   */
  private bindingReceipt: CommitReceipt | null = null;
  private ownerToken: OwnerToken | null = null;
  /** Owner-epoch identity object; rotated only when a binding's record is deleted. */
  private ownerEpoch: object = {};
  private currentRuntimePort: ChatRuntimePersistencePort | null = null;
  private closeSaveCompletion: Promise<readonly CloseSaveOutcome[]> | null = null;
  /** Set once the current binding is sealed outgoing and its write is settled. */
  private outgoingSealed = false;

  constructor(deps: ConversationControllerDeps, callbacks: ConversationCallbacks = {}) {
    this.deps = deps;
    this.callbacks = callbacks;
  }

  private getAgentService(): ChatRuntime | null {
    return this.deps.getAgentService?.() ?? null;
  }

  private isManagerActive(): boolean {
    return this.deps.isManagerActive?.() ?? true;
  }

  /** Captures only saves already accepted by this controller, not pending reads. */
  snapshotAcceptedSaves(): Promise<void>[] {
    return Array.from(this.acceptedSaves);
  }

  private trackAcceptedSave(operation: () => Promise<void>): Promise<void> {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const save = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.acceptedSaves.add(save);
    void save.then(
      () => this.acceptedSaves.delete(save),
      () => this.acceptedSaves.delete(save),
    );
    try {
      void operation().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return save;
  }

  // ============================================
  // R2 binding / save admission (P6-0 core wiring)
  // ============================================

  private getSaveCoordinator(): ConversationHistoryCoordinator | null {
    return this.deps.getConversationHistoryCoordinator?.() ?? null;
  }

  private ensureOwnerToken(): OwnerToken | null {
    const coordinator = this.getSaveCoordinator();
    const identity = this.deps.getBindingOwnerIdentity?.();
    if (!coordinator || !identity) return null;
    const registered = coordinator.registerOwner(identity.manager, this.ownerEpoch);
    if (registered.status === 'ok') {
      this.ownerToken = registered.value;
      return registered.value;
    }
    if (registered.reason === 'owner-retiring') this.rotateOwnerEpoch();
    return null;
  }

  /** A dead binding epoch may never be reused; a fresh owner identity restarts clean. */
  private rotateOwnerEpoch(): void {
    this.ownerEpoch = {};
    this.ownerToken = null;
    this.bindingReceipt = null;
    this.currentRuntimePort = null;
    this.outgoingSealed = false;
  }

  /** Seed state captured from the persisted record at binding-commit time. */
  private buildSeedState(conversation: Conversation): PersistableBindingState {
    const providerFields: Record<string, FieldPatch<JsonValue>> = {};
    for (const [key, value] of Object.entries(conversation.providerState ?? {})) {
      providerFields[key] = { op: 'set', value: value as JsonValue };
    }
    return {
      metadata: {},
      sessionSeed: {
        sessionId: conversation.sessionId == null
          ? { op: 'delete' }
          : { op: 'set', value: conversation.sessionId },
        providerFields,
      },
    };
  }

  /** Live persistable-field refresh; the sessionSeed always passes through unchanged. */
  private buildPersistableState(
    conversation: Conversation,
    sessionSeed: SessionBindingPatch,
    updateLastResponse: boolean,
    options: SaveOptions | undefined,
  ): PersistableBindingState {
    const { state } = this.deps;
    const fileCtx = this.deps.getFileContextManager();
    const currentNote = fileCtx?.getCurrentNotePath() || undefined;
    const externalContextPaths = this.deps.getExternalContextSelector()?.getExternalContexts() ?? [];
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const enabledMcpServers = mcpServerSelector ? Array.from(mcpServerSelector.getEnabledServers()) : [];
    const firstUser = state.messages.find(message => message.role === 'user');
    const metadata: MetadataPatch = {
      hasHistory: { op: 'set', value: state.messages.length > 0 || conversation.hasHistory === true },
      messageCount: { op: 'set', value: Math.max(conversation.messageCount ?? 0, state.messages.length) },
      firstUserExcerpt: conversation.firstUserExcerpt != null
        ? { op: 'keep' }
        : firstUser
          ? { op: 'set', value: (firstUser.displayContent ?? firstUser.content).slice(0, 300) }
          : { op: 'keep' },
      preview: conversation.preview != null
        ? { op: 'keep' }
        : firstUser
          ? { op: 'set', value: (firstUser.displayContent ?? firstUser.content).slice(0, 50) }
          : { op: 'keep' },
      currentNote: currentNote === undefined ? { op: 'delete' } : { op: 'set', value: currentNote },
      externalContextPaths: externalContextPaths.length > 0
        ? { op: 'set', value: externalContextPaths }
        : { op: 'delete' },
      usage: state.usage ? { op: 'set', value: state.usage } : { op: 'delete' },
      enabledMcpServers: enabledMcpServers.length > 0
        ? { op: 'set', value: enabledMcpServers }
        : { op: 'delete' },
      ...(updateLastResponse ? { lastResponseAt: { op: 'set', value: Date.now() } } : {}),
      ...(options
        ? {
          resumeAtMessageId: options.resumeAtMessageId === undefined
            ? { op: 'delete' }
            : { op: 'set', value: options.resumeAtMessageId },
        }
        : {}),
    };
    return { metadata, sessionSeed };
  }

  private registerMaterializationSource(recordId: string): void {
    this.deps.getConversationMetadataSavePort?.()?.registerMaterializationSource(recordId, () => {
      // Display/record divergence (mid-switch) must never leak the other
      // conversation's materialized view into this record's metadata.
      if (this.deps.state.currentConversationId !== recordId) return null;
      const base = this.deps.plugin.getConversationSync(recordId);
      if (!base) return null;
      return base.sessionId ? [] : this.deps.state.messages;
    });
  }

  /**
   * Commits the R2 tab binding for a conversation: record + owner + attempt +
   * immutable seed state, all before any runtime adoption or UI notification
   * for the incoming conversation (P6 §6.2 prepare→commit→adoption→notify).
   * Requires the outgoing binding (if any) to be sealed and written first.
   */
  private async commitConversationBinding(
    conversation: Conversation,
    options?: { unclaimedIsOwn?: boolean },
  ): Promise<CommitReceipt | null> {
    const coordinator = this.getSaveCoordinator();
    if (!coordinator) return null;
    const registered = coordinator.registerRecord(conversation);
    if (registered.status !== 'ok') return null;
    const record = registered.value;
    const owner = this.ensureOwnerToken();
    if (!owner) return null;
    const versions = coordinator.readRecordVersions(record);
    if (versions.status !== 'ok') return null;
    // An outgoing binding whose record was deleted can never be sealed
    // written; declare the epoch dead and start a fresh owner for the commit.
    if (this.bindingReceipt && this.deps.plugin.getConversationSync(this.bindingReceipt.record.id) == null) {
      coordinator.retireRecord(this.bindingReceipt.record);
      this.rotateOwnerEpoch();
    }
    if (this.bindingReceipt && !this.outgoingSealed) {
      try {
        await this.sealOutgoingBinding();
      } catch (error) {
        if (!this.isManagerActive()) return null;
        throw error;
      }
    }
    const freshOwner = this.ownerToken ?? this.ensureOwnerToken();
    if (!freshOwner) return null;
    // A lost or missing claim means this tab no longer holds display
    // admission for the record — the binding must not commit. Only a record
    // this tab just created (lazy create) is self-evidently its own.
    const reservation = options?.unclaimedIsOwn
      ? { claim: this.ownerEpoch, owns: () => true }
      : (this.deps.getBindingReservation?.(conversation.id) ?? null);
    if (!reservation) return null;
    const attempt = coordinator.beginBindingAttempt({
      owner: freshOwner,
      record,
      expectedRecordVersions: versions.value,
      reservation,
    });
    if (attempt.status !== 'ok') return null;
    const committed = coordinator.commitPreparedBinding({ attempt: attempt.value, state: this.buildSeedState(conversation) });
    if (committed.status !== 'ok') return null;
    this.bindingReceipt = committed.value;
    this.outgoingSealed = false;
    this.registerMaterializationSource(conversation.id);
    return committed.value;
  }

  /**
   * Seals the current binding as outgoing and waits for its receipt. Idempotent:
   * an already sealed binding returns its original ticket without re-writing.
   * A failed write rejects with the original error (the switch must fail
   * loudly rather than rebind past an unwritten outgoing state).
   */
  private async sealOutgoingBinding(): Promise<void> {
    const coordinator = this.getSaveCoordinator();
    const receipt = this.bindingReceipt;
    if (!coordinator || !receipt) return;
    const request = this.sealOutgoingAdmission();
    if (!request) return;
    // The admitting window is synchronous for this port; settle it explicitly
    // anyway — the receipt chain must be followed, not assumed.
    const admission = request.status === 'admitting' ? await request.settlement : request;
    if (admission.status !== 'accepted') return;
    const savedId = admission.ticket.record.id;
    this.deps.plugin.conversationSizes?.invalidate(savedId);
    try {
      const result = await admission.durability;
      if (result.status === 'written') {
        this.outgoingSealed = true;
        if (this.deps.state.currentConversationId === savedId) {
          this.deps.state.hasPendingConversationSave = false;
        }
      }
    } catch (error) {
      void Promise.resolve()
        .then(() => this.deps.plugin.conversationSizes?.refresh(savedId, true))
        .catch(() => undefined);
      throw error;
    }
    void Promise.resolve()
      .then(() => this.deps.plugin.conversationSizes?.refresh(savedId, true))
      .catch(() => undefined);
  }

  private sealOutgoingAdmission(): SaveRequestResult | null {
    const coordinator = this.getSaveCoordinator();
    const receipt = this.bindingReceipt;
    if (!coordinator || !receipt) return null;
    const current = coordinator.readBinding(receipt);
    if (current.status !== 'ok') return null;
    const conversation = this.deps.plugin.getConversationSync(receipt.record.id);
    // The outgoing payload is frozen before the first await: metadata from the
    // live display only while it still shows the outgoing record, and the
    // session input from the binding itself (adopted capture or seed).
    if (conversation && this.deps.state.currentConversationId === receipt.record.id) {
      const fresh = this.buildPersistableState(conversation, current.value.state.sessionSeed, false, undefined);
      coordinator.updatePersistableBinding({
        binding: receipt,
        expectedDirtyRevision: current.value.dirtyRevision,
        state: fresh,
      });
    }
    return coordinator.sealOutgoing(receipt);
  }

  /**
   * Wraps an actual runtime sync under the current binding's adoption
   * (P6 §4.2/§6.2): every production sync entry point routes through here so a
   * save can only capture from the runtime its binding adopted.
   *
   * A sync whose target conversation is not the binding's record (e.g. an
   * environment reconcile that still sees the outgoing conversationId inside
   * the commit→rebind window) still runs — environment changes must reach the
   * runtime — but the adoption is failed afterwards: the binding's saves fall
   * back to its seed instead of capturing a runtime state that now belongs to
   * a different record.
   */
  adoptRuntimeSync(runtime: ChatRuntime | null, sync: () => void, target?: { conversationId: string | null }): void {
    const coordinator = this.getSaveCoordinator();
    const receipt = this.bindingReceipt;
    if (!runtime || !coordinator || !receipt) {
      sync();
      return;
    }
    const port = new ChatRuntimePersistencePort(runtime, () =>
      this.deps.plugin.getConversationSync(receipt.record.id));
    const adoption = coordinator.beginRuntimeAdoption({ binding: receipt, runtime: port });
    if (adoption.status !== 'ok') {
      sync();
      return;
    }
    try {
      sync();
    } catch (error) {
      coordinator.failRuntimeAdoption(adoption.value, error);
      throw error;
    }
    if (target !== undefined && target.conversationId !== receipt.record.id) {
      // The seed fallback is the safety property, so the silent degradation
      // itself must be traceable — an unattributed bypass is indistinguishable
      // from the bug this guard exists to prevent.
      recordHistoryDiagnosticEvent({ kind: 'save_adoption_target_mismatch' });
      coordinator.failRuntimeAdoption(adoption.value, new Error(
        `runtime sync targeted conversation ${String(target.conversationId)} outside binding record ${receipt.record.id}`,
      ));
      return;
    }
    const completed = coordinator.completeRuntimeAdoption(adoption.value);
    if (completed.status === 'ok') this.currentRuntimePort = port;
  }

  /**
   * Close-time sealing (manager beginClose): synchronously prepares the
   * binding's last persistable state and obtains the core CloseSavePlan. The
   * plan's final admission captures from the committed binding — an outgoing
   * shell can never read a runtime a later rebind owns. Idempotent per close.
   */
  sealForCloseSave(): readonly Promise<readonly CloseSaveOutcome[]>[] {
    const coordinator = this.getSaveCoordinator();
    const owner = this.ownerToken;
    if (!coordinator || !owner || this.closeSaveCompletion) {
      return this.closeSaveCompletion ? [this.closeSaveCompletion] : [];
    }
    const receipt = this.bindingReceipt;
    // An incoming binding whose restore never committed (a switch canceled by
    // close) must leave no persistence trace: its record belongs to the next
    // owner now, and the entered switch is revoked (R1a close semantics).
    if (receipt && this.deps.state.currentConversationId !== receipt.record.id) return [];
    if (receipt) {
      const current = coordinator.readBinding(receipt);
      const conversation = this.deps.plugin.getConversationSync(receipt.record.id);
      if (current.status === 'ok' && conversation && this.deps.state.currentConversationId === receipt.record.id) {
        const fresh = this.buildPersistableState(conversation, current.value.state.sessionSeed, false, undefined);
        coordinator.updatePersistableBinding({
          binding: receipt,
          expectedDirtyRevision: current.value.dirtyRevision,
          state: fresh,
        });
      }
    }
    const plan = coordinator.sealForClose(owner);
    if (plan.status !== 'ok') return [];
    this.closeSaveCompletion = plan.value.completion;
    return [plan.value.completion];
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
    if (!this.isManagerActive()) return;
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

      // Save current conversation if it has messages. R2: the outgoing save is
      // a binding seal — its payload is frozen before the tab blanks, so the
      // blank/reset runtime state can never overwrite the record.
      if (state.currentConversationId && state.messages.length > 0) {
        await this.save(false, undefined, { outgoing: true });
      }
      if (!this.isManagerActive()) return;

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
      if (!this.isManagerActive()) return;

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
    const canApply = (): boolean => this.isManagerActive() && shouldApply();
    if (!this.isManagerActive()) return;

    const conversationId = state.currentConversationId;
    const conversation = conversationId ? await plugin.getConversationById(conversationId) : null;
    if (!this.isManagerActive()) return;
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
        let bodyFailed = false;
        let bodyError: unknown;
        try {
          await lease.ready;
          if (!this.isManagerActive()) return;
          firstScreen = await this.loadFirstScreenWindow(lease);
          if (!canApply()) return;
          state.historyLease?.release();
          state.historyLease = lease;
          transferred = true;
          state.loadedRanges = [firstScreen.range];
          state.historyHasMore = firstScreen.hasMoreBefore;
          state.historySnapshotOffset = firstScreen.snapshotOffset ?? null;
          state.historyTailStart = firstScreen.tailStart ?? null;
          state.historyError = null;
          await this.backfillLegacyHistoryMetadata(conversation, firstScreen);
          if (!canApply()) return;
        } catch (error) {
          bodyFailed = true;
          bodyError = error;
          throw error;
        } finally {
          if (!transferred) {
            try {
              lease.release();
            } catch (releaseError) {
              if (bodyFailed) {
                // Both failures, including non-Error values, remain ordered in the aggregate.
                // eslint-disable-next-line no-unsafe-finally, preserve-caught-error
                throw new AggregateError([bodyError, releaseError], 'History lease release failed');
              }
              // A release failure must override a pending return without changing its identity.
              // eslint-disable-next-line no-unsafe-finally
              throw releaseError;
            }
          }
          if (this.isManagerActive()) state.historyLoading = false;
        }
      }
    }
    if (!canApply()) return;

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

    // R2: commit the tab binding before the runtime adoption so the sync
    // inside ensureServiceForConversation runs under this record's adoption —
    // never the outgoing binding's (P6 §6.2 commit→adoption→notify).
    await this.commitConversationBinding(conversation);
    if (!canApply()) return;
    await this.deps.ensureServiceForConversation?.(conversation);
    if (!canApply()) return;
    await this.restoreConversation(conversation, firstScreen, { autoAttachFile: true });
    if (!canApply()) return;
    this.updateWelcomeVisibility();

    this.renderHistoryPager();
    this.callbacks.onConversationLoaded?.();
  }

  async loadOlderHistory(): Promise<void> {
    const { state } = this.deps;
    if (!this.isManagerActive() || !state.historyLease || state.historyLoading) return;
    await this.loadOlderWindow();
  }

  async rematerializeHistoryPage(record: { pageKey: string; range: LoadedTurnRange; retention?: HistoryPageRetention; uiState: Map<string, { detailLoaded?: boolean }> }): Promise<HistoryPageInput | null> {
    if (record.retention === 'memory-only') {
      // Unreachable while eviction exempts memory-only pages; if the
      // invariant breaks, refuse loudly instead of reading the stale index —
      // the snapshot still contains the branches the rewind discarded (F1).
      recordHistoryDiagnosticEvent({ kind: 'memory_only_rematerialize', pageKey: record.pageKey });
      return null;
    }
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
    if (conversationId !== this.deps.state.currentConversationId) return null;
    if (page.pageKey !== record.pageKey) {
      // The pageKey guard protects against a window that is not the window
      // we asked for. A pure identity drift (equal range, new snapshot
      // generation after a search snapshot refresh) is not an error: the
      // exchanged lease is the only truth, so the data is accepted and the
      // renderer re-keys the record onto the fresh key. A range mismatch
      // (planner shrink or snapshot fork) is a real refusal, traced.
      if (page.range.start !== record.range.start || page.range.end !== record.range.end) {
        recordHistoryDiagnosticEvent({
          kind: 'page_rematerialize_refused',
          pageKey: record.pageKey,
          reason: 'range_mismatch',
          rangeStart: record.range.start,
          rangeEnd: record.range.end,
          actualRangeStart: page.range.start,
          actualRangeEnd: page.range.end,
        });
        return null;
      }
    }
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
    options?: { timeoutMs?: number; bypassLive?: boolean },
  ): Promise<T | null> {
    const conversationId = this.deps.state.currentConversationId;
    const isStale = (): boolean => !this.isManagerActive()
      || this.deps.state.currentConversationId !== conversationId;
    const coordinator = this.deps.getProjectionCoordinator?.() ?? null;
    if (!coordinator) {
      return isStale() ? null : task(isStale);
    }
    return coordinator.runStored(isStale, () => isStale() ? Promise.resolve(null) : task(isStale), options);
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
    if (!this.isManagerActive() || conversation.hasHistory === true || firstScreen.messages.length === 0) return;
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
    await this.trackAcceptedSave(() => this.deps.plugin.updateConversation(conversation.id, backfill));
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
   * are never re-materialized. The lease and anchor are captured under the
   * stored grant (F5): a search snapshot refresh that swapped the mounted
   * lease while this load queued must never materialize through the
   * released previous lease.
   */
  private async loadOlderWindow(): Promise<void> {
    const { state } = this.deps;
    state.historyLoading = true;
    state.historyError = null;
    this.renderHistoryPager();
    try {
      await this.runStoredTransaction(async isStale => {
        const lease = state.historyLease;
        if (!lease) return;
        const total = lease.totalTurns;
        const merged = this.mergeRanges(state.loadedRanges);
        const newest = merged.find(range => range.start <= total - 1 && range.end >= total);
        const anchor = newest ? newest.start : total;
        if (anchor <= 0) return;
        const older = [...merged].reverse().find(range => range.end <= anchor);
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
        state.historyTailStart = page.tailStart ?? state.historyTailStart;
      });
    } catch (error) {
      if (this.isManagerActive()) state.historyError = error instanceof Error ? error.message : String(error);
      else throw error;
    } finally {
      if (this.isManagerActive()) {
        state.historyLoading = false;
        this.renderHistoryPager();
      }
    }
  }

  private renderHistoryPager(): void {
    if (!this.isManagerActive()) return;
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

  async refreshHistorySearchSnapshot(trigger: 'search' | 'rewind' | 'fork' = 'search'): Promise<HistorySearchSnapshotRefreshResult> {
    const { plugin, state } = this.deps;
    const startedAt = performance.now();
    const conversationId = state.currentConversationId;
    // Early returns are capability/state branches, not failures: the caller
    // keeps searching whatever the tab already has. Providers without an
    // index (Codex/OpenCode lease-less search) must never be reported as a
    // staleness problem.
    if (!conversationId) {
      return this.reportRefreshNotApplicable('no_conversation', startedAt, trigger);
    }
    const conversation = plugin.getConversationSync(conversationId);
    if (!conversation) {
      return this.reportRefreshNotApplicable('no_conversation', startedAt, trigger);
    }
    const service = this.deps.getHistoryIndexCapableService(conversation);
    if (!service) {
      return this.reportRefreshNotApplicable('provider_without_index', startedAt, trigger);
    }
    const previous = state.historyLease;
    if (!previous) {
      return this.reportRefreshNotApplicable('no_lease', startedAt, trigger);
    }
    // P1: the forced rebuild runs OUTSIDE the stored grant. A grant-held
    // build kept the shared projection FIFO exclusive for the whole rescan
    // (tens of seconds on large transcripts), head-blocking every later
    // live turn and stored window load. Instead the previous lease stays
    // mounted and protected while `next` builds: paging, search locate and
    // live turns keep using the old snapshot through the FIFO, and search
    // reads stay stale-but-consistent until the atomic exchange below.
    // Silent acquire: the refresh runs after stream completion with the tab
    // already READY, so index progress must not touch the rendered
    // messages.
    const next = this.acquireLease(conversation, service, true, false);
    try {
      await next.ready;
    } catch (error) {
      // Rollback path: only the never-mounted `next` ends its reference
      // here; the old lease stays mounted, so a failed refresh keeps
      // pagination and search usable on stale data.
      next.release();
      recordHistoryDiagnosticEvent({ kind: 'search_snapshot_refresh', outcome: 'failed', trigger, elapsedMs: performance.now() - startedAt });
      throw error;
    }
    // Short critical section (F5): only the revalidated exchange takes the
    // stored grant, FIFO-serialized with loadOlderWindow and search
    // re-locate, so the previous lease's index protection can never be
    // revoked under an in-flight window load that captured it. The
    // revalidation covers a conversation switch (which never queues on the
    // coordinator and may have released or replaced the mounted lease
    // during the build) and a same-conversation exchange (loadActive): in
    // either case `next` was never mounted, so it ends its reference and no
    // lease is resurrected onto the tab. Swap before releasing previous so
    // no window load ever observes a mounted-but-released lease.
    //
    // The exchange enters through bypassLive (B): it queues on the stored
    // slot only, so a Stop-hook-stretched live turn no longer delays the
    // swap — its writes (lease refs, paging bookkeeping) are disjoint from
    // the live page, while the stored-domain serialization above is kept
    // whole. STRUCTURAL CONTRACT: this task body must stay synchronous —
    // no await. The exchange now runs inside the live domain's blind spot,
    // and the switch-vs-exchange / finalize-vs-exchange total orders are
    // only decidable because the section is atomic.
    const exchange = await this.runStoredTransaction<HistorySearchSnapshotRefreshResult>(
      async () => {
        if (state.currentConversationId !== conversationId || state.historyLease !== previous) {
          next.release();
          return this.reportRefreshNotApplicable('stale', startedAt, trigger);
        }
        state.historyLease = next;
        previous.release();
        // Anchor-chain repair (invariant g): live turns that landed between
        // the two snapshots never enter loadedRanges through their own
        // writers (first screen / paging / rewind / reset are the only
        // ones), so fold [previous.totalTurns, next.totalTurns) in here —
        // otherwise loadOlderWindow's newest-range probe misses, the anchor
        // walks past the live tail, and the transcript copies of turns
        // already in memory get materialized as duplicates. B made the
        // exchange land mid-turn routinely, so this gap is now the common
        // path, not a rare race. A regressed or flat total (rewind refresh)
        // merges nothing: a negative or zero interval is never a range.
        if (next.totalTurns > previous.totalTurns) {
          state.loadedRanges = this.mergeRanges([...state.loadedRanges, { start: previous.totalTurns, end: next.totalTurns }]);
          state.historyHasMore = !this.coversAll(state.loadedRanges, next.totalTurns);
        }
        // The lease reports what actually happened; without a service-provided
        // outcome the honest report is rebuilt (a fresh acquire did run).
        const outcome = next.acquireOutcome === 'cache_hit' ? 'cache_hit' : 'rebuilt';
        recordHistoryDiagnosticEvent({ kind: 'search_snapshot_refresh', outcome, trigger, elapsedMs: performance.now() - startedAt });
        return outcome === 'cache_hit' ? { status: 'cache_hit' } : { status: 'rebuilt' };
      },
      { timeoutMs: ConversationController.REFRESH_EXCHANGE_GRANT_TIMEOUT_MS, bypassLive: true },
    );
    // A null transaction (the conversation switched while the exchange
    // queued behind a live turn or stored work, the coordinator was
    // disposed, or the grant wait timed out) never ran the swap: `next` was
    // never mounted, so it ends its reference here.
    if (!exchange) {
      next.release();
      // runStored's null cannot distinguish timeout / cancelled / disposed,
      // so re-check the same staleness the task body would have checked: a
      // real conversation switch (or a same-conversation lease swap) keeps
      // the honest 'stale' report — 'stale' means conversation-switch
      // mismatch and must not absorb the timeout; only a non-stale null is
      // a grant_timeout (coordinator dispose at teardown lands here too:
      // diagnostic-label difference only, no behavioral consequence).
      const stale = state.currentConversationId !== conversationId || state.historyLease !== previous;
      return this.reportRefreshNotApplicable(stale ? 'stale' : 'grant_timeout', startedAt, trigger);
    }
    return exchange;
  }

  private reportRefreshNotApplicable(
    reason: 'no_conversation' | 'no_lease' | 'provider_without_index' | 'stale' | 'grant_timeout',
    startedAt: number,
    trigger: 'search' | 'rewind' | 'fork',
  ): HistorySearchSnapshotRefreshResult {
    recordHistoryDiagnosticEvent({ kind: 'search_snapshot_refresh', outcome: 'not_applicable', reason, trigger, elapsedMs: performance.now() - startedAt });
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
      state.historyTailStart = page.tailStart ?? state.historyTailStart;
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
      ? (value: HistoryLoadProgress) => {
          if (this.isManagerActive()) this.deps.onHistoryLoadProgress?.(value);
        }
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

    if (!this.isManagerActive()) return;
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
    if (!this.isManagerActive()) return;
    state.isSwitchingConversation = true;
    let lease: HistoryIndexLease | null = null;
    let transferred = false;

    try {
      this.deps.dismissPendingInlinePrompts?.();

      // S2 lifecycle cancellation: an auto turn may start between the
      // isStreaming guard above and the restore below; invalidating the
      // lease generation keeps its late callbacks from writing into the
      // conversation being switched to.
      this.deps.invalidateTurnLifecycle?.();

      // R2: the outgoing conversation's final save is an outgoing seal — its
      // payload freezes before the first await, so the rebind below can never
      // leak the incoming runtime's identity into the outgoing record.
      await this.save(false, undefined, { outgoing: true });
      if (!this.isManagerActive()) return;

      subagentManager.orphanAllActive();
      subagentManager.clear();

      const conversation = await plugin.switchConversation(id);
      if (!this.isManagerActive()) return;
      if (!conversation) {
        this.deps.cancelConversationReservation?.(id);
        return;
      }

      const historyService = this.deps.getHistoryIndexCapableService(conversation);
      let firstScreen: HistoryWindowPage | null = null;
      if (historyService) {
        lease = this.acquireLease(conversation, historyService);
        await lease.ready;
        if (!this.isManagerActive()) return;
        firstScreen = await this.loadFirstScreenWindow(lease);
        if (!this.isManagerActive()) return;
        await this.backfillLegacyHistoryMetadata(conversation, firstScreen);
        if (!this.isManagerActive()) return;
      }

      // R2: commit the incoming binding after the outgoing seal above — the
      // runtime rebind inside ensureServiceForConversation then adopts under
      // the incoming record, and the outgoing shell can never read it.
      await this.commitConversationBinding(conversation);
      if (!this.isManagerActive()) return;
      await this.deps.ensureServiceForConversation?.(conversation);
      if (!this.isManagerActive()) return;

      this.deps.getInputEl().value = '';
      this.deps.clearQueuedMessage();

      this.releaseSwitchedAwayHistory(previousConversationId, previousProviderId);
      this.deps.getHistoryWindowRenderer?.()?.reset();
      if (lease && firstScreen) {
        state.historyLease = lease;
        transferred = true;
        state.loadedRanges = [firstScreen.range];
        state.historyHasMore = firstScreen.hasMoreBefore;
        state.historySnapshotOffset = firstScreen.snapshotOffset ?? null;
        state.historyTailStart = firstScreen.tailStart ?? null;
      } else {
        // Non-index conversations have no pager: stale pagination flags from
        // the outgoing conversation must not leak a dead button.
        state.historyHasMore = false;
        state.historySnapshotOffset = null;
        state.historyTailStart = null;
      }
      await this.restoreConversation(conversation, firstScreen);
      if (!this.isManagerActive()) return;
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
      if (!this.isManagerActive()) return;

      this.deps.markHydrationReady?.();

      this.callbacks.onConversationSwitched?.();
    } catch (error) {
      if (this.isManagerActive()) this.deps.cancelConversationReservation?.(id);
      throw error;
    } finally {
      if (lease && !transferred) lease.release();
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

  /**
   * Resolves the exact content of a projected user message for rewind/fork.
   *
   * Only a summary projection carries trimmed content: live/detail/draft
   * messages are already exact in memory, and live messages carry a local id
   * that is not a transcript projection key, so loading them from the index
   * would always miss regardless of snapshot freshness (real-world
   * regression: rewinding a just-sent message failed). A summary miss
   * triggers one forced snapshot refresh (the search refresh's P1 exchange
   * semantics) and a single retry; `too_large` is a property of the message,
   * not the snapshot, and never refreshes. A conversation switch during the
   * refresh returns 'switched' so callers abort silently instead of writing
   * into the newly displayed conversation.
   */
  async resolveExactUserMessage(
    projected: ChatMessage,
    trigger: 'search' | 'rewind' | 'fork',
  ): Promise<
    | { status: 'exact'; message: ChatMessage }
    | { status: 'too_large' }
    | { status: 'not_found' }
    | { status: 'switched' }
  > {
    const { state } = this.deps;
    if (!this.isManagerActive()) return { status: 'switched' };
    if (projected.projectionLevel !== 'summary') return { status: 'exact', message: projected };
    const conversationId = state.currentConversationId;
    const lease = state.historyLease;
    // Fail-closed: pre-filling the input from a trimmed summary would rewrite
    // the user's message, so a lease-less summary can only abort.
    if (!lease) return { status: 'not_found' };
    const detail = await lease.loadMessageDetail(projected.id, { maxSourceBytes: 16 * 1024 * 1024 });
    if (!this.isManagerActive()) return { status: 'switched' };
    if (detail.status !== 'not_found') return detail;
    if (state.currentConversationId !== conversationId) return { status: 'switched' };
    try {
      await this.refreshHistorySearchSnapshot(trigger);
    } catch {
      // A failed rebuild leaves the old lease mounted; the retry below then
      // honestly ends not_found instead of surfacing the build error as a
      // rewind failure.
    }
    if (!this.isManagerActive() || state.currentConversationId !== conversationId) return { status: 'switched' };
    const retryLease = state.historyLease;
    if (!retryLease) return { status: 'not_found' };
    const retry = await retryLease.loadMessageDetail(projected.id, { maxSourceBytes: 16 * 1024 * 1024 });
    return this.isManagerActive() ? retry : { status: 'switched' };
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
    const resolved = await this.resolveExactUserMessage(projectedUserMsg, 'rewind');
    if (resolved.status === 'switched') return;
    if (resolved.status !== 'exact') {
      new Notice(t(resolved.status === 'too_large' ? 'chat.rewind.detailTooLarge' : 'chat.rewind.detailUnavailable'));
      return;
    }
    const userMsg = resolved.message;
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
        // No projectedWeight: the page store computes the synthetic page's
        // weight through its per-message cache — the same formula the old
        // inline reduce used, now single-sourced in HistoryPageStore.
        windowRenderer.addPage({
          pageKey: `rewind:${pageStart}:${keepEnd}`,
          range: { start: pageStart, end: keepEnd },
          messages: state.messages,
          // The synthetic page IS the memory truth: the disk snapshot still
          // contains the discarded branches, so it is exempt from eviction
          // (explicit overcommit) and must never be rematerialized (F1).
          retention: 'memory-only',
        }, lease.totalTurns);
        state.loadedRanges = kept;
        state.historyHasMore = !this.coversAll(kept, keepEnd);
      });
      this.updateWelcomeVisibility();
      this.renderHistoryPager();
      // The F1 rebuild routes through renderStoredPage, which (unlike the
      // legacy renderMessages path) never scrolls: messagesEl.empty() clamps
      // scrollTop to 0 while only the welcome remains and nothing restores
      // it afterwards — the view parks at the very top. Anchor the view on
      // the rewound message: it is the semantic focus of the rewind (the
      // input box is pre-filled with its content).
      this.revealMessageInViewport(userMessageId);
    } else {
      const welcomeEl = renderer.renderMessages(state.messages, () => this.getGreeting());
      this.deps.setWelcomeEl(welcomeEl);
      this.updateWelcomeVisibility();
    }
    // Legacy (non-windowed) path: renderMessages renders bottom-up from
    // scratch and its non-prepend branch scrolls to bottom — which lands on
    // the rewound message anyway (it is the last message now). No extra call.
    await this.finishRewind(result, prevAssistantUuid);
  }

  /**
   * Scrolls the rewound user message into view after the F1 synthetic-page
   * rebuild. Deferred to the next frame so the freshly mounted page layout
   * settles first; page-level async content (markdown, tool calls) grows the
   * message height afterwards, but 'nearest' keeps the anchor approximate
   * without fighting the growth.
   */
  private revealMessageInViewport(messageId: string): void {
    const messagesEl = this.deps.getMessagesEl();
    const renderer = this.deps.renderer;
    const reveal = () => {
      // A conversation switch between the rewind and this frame rebuilds the
      // DOM under a different lease — scrolling then would relocate the new
      // view; the gone anchor query naturally no-ops except for the fallback,
      // which the switch-away conversation's messagesEl also guards.
      if (!messagesEl.isConnected) return;
      const target = renderer.findMessageElement(messageId);
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
      } else {
        // Anchor gone (race with a switch): bottom of the rebuilt view is
        // still better than parked at the welcome header.
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
    else setTimeout(reveal, 0);
  }

  private async finishRewind(result: { filesChanged?: string[] }, prevAssistantUuid: string): Promise<void> {
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
  save(updateLastResponse = false, options?: SaveOptions, phase?: { outgoing?: boolean }): Promise<void> {
    return this.trackAcceptedSave(() => this.performSave(updateLastResponse, options, phase));
  }

  private async performSave(
    updateLastResponse: boolean,
    options?: SaveOptions,
    phase?: { outgoing?: boolean },
  ): Promise<void> {
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
    if (sessionInvalidated) this.currentRuntimePort?.markSessionInvalidated();

    // Entry point with messages - create conversation lazily
    // New conversations always use SDK-native storage.
    if (!state.currentConversationId && state.messages.length > 0) {
      const initialSessionId = agentService?.getSessionId() ?? undefined;
      const conversation = await plugin.createConversation({
        providerId: agentService?.providerId,
        sessionId: initialSessionId,
      });
      state.currentConversationId = conversation.id;
      const lazyReceipt = await this.commitConversationBinding(conversation, { unclaimedIsOwn: true });
      // The runtime's session belongs to this record's first turn even though
      // no conversation sync ran (the tab was blank at runtime install): the
      // immediately-completed adoption marks it as the binding's persistence
      // source so the first save captures provider-native session facts.
      if (lazyReceipt && agentService) {
        const coordinator = this.getSaveCoordinator();
        const port = new ChatRuntimePersistencePort(agentService, () =>
          plugin.getConversationSync(conversation.id));
        const adoption = coordinator?.beginRuntimeAdoption({ binding: lazyReceipt, runtime: port });
        if (coordinator && adoption?.status === 'ok') {
          this.currentRuntimePort = port;
          coordinator.completeRuntimeAdoption(adoption.value);
        }
      }
    }

    const coordinator = this.getSaveCoordinator();
    const receipt = this.bindingReceipt;
    if (!coordinator || !receipt) {
      await this.performLegacySave(updateLastResponse, options, sessionInvalidated);
      return;
    }

    // Outgoing save (switch/reset): the binding's final write is a seal — its
    // payload freezes before the first await so the rebind that follows can
    // never leak the incoming runtime's identity into the outgoing record.
    if (phase?.outgoing) {
      await this.sealOutgoingBinding();
      return;
    }

    // The save target is the committed binding's record, never the display
    // state — display and binding only diverge mid-switch, where the incoming
    // binding must not receive the outgoing conversation's live fields.
    const conversation = plugin.getConversationSync(receipt.record.id);
    if (!conversation) return;

    const current = coordinator.readBinding(receipt);
    if (current.status !== 'ok') return;
    if (state.currentConversationId === receipt.record.id) {
      const fresh = this.buildPersistableState(conversation, current.value.state.sessionSeed, updateLastResponse, options);
      const updated = coordinator.updatePersistableBinding({
        binding: receipt,
        expectedDirtyRevision: current.value.dirtyRevision,
        state: fresh,
      });
      if (updated.status !== 'ok') {
        // Structural rejections (stale/sealed/retiring/retired) mean this
        // binding no longer qualifies for a shell save — the binding that
        // replaced it owns the record's persistence from here on.
        return;
      }
    }

    const admission = coordinator.admitSave({ binding: receipt });
    if (admission.status !== 'accepted') return;
    const savedId = admission.ticket.record.id;
    plugin.conversationSizes?.invalidate(savedId);
    let saveReceipt: SaveReceipt;
    try {
      saveReceipt = await admission.durability;
    } catch (error) {
      void Promise.resolve()
        .then(() => plugin.conversationSizes?.refresh(savedId, true))
        .catch(() => undefined);
      throw error;
    }
    // File observations must not delay or replace the metadata save outcome.
    void Promise.resolve()
      .then(() => plugin.conversationSizes?.refresh(savedId, true))
      .catch(() => undefined);
    // Only a written receipt clears the pending flag; skipped/conflict keep
    // the dirty state honest (P6 §4.4).
    if (saveReceipt.status === 'written') {
      state.hasPendingConversationSave = false;
    }
  }

  /** Pre-R2 save path, kept for legacy unit fixtures without the coordinator dep. */
  private async performLegacySave(
    updateLastResponse: boolean,
    options: SaveOptions | undefined,
    sessionInvalidated: boolean,
  ): Promise<void> {
    const { plugin, state } = this.deps;
    const agentService = this.getAgentService();

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

    const savedId = state.currentConversationId!;
    plugin.conversationSizes?.invalidate(savedId);
    try {
      await plugin.updateConversation(savedId, updates);
    } finally {
      // File observations must not delay or replace the metadata save outcome.
      void Promise.resolve()
        .then(() => plugin.conversationSizes?.refresh(savedId, true))
        .catch(() => undefined);
    }
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
    if (!this.isManagerActive()) return;

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

    // R2: the restore sync runs under the committed binding's adoption so
    // saves capture this runtime only through the adoption registry.
    const agentService = this.getAgentService();
    this.adoptRuntimeSync(
      agentService,
      () => { agentService?.syncConversationState(conversation, externalContextPaths); },
      { conversationId: conversation.id },
    );

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

  releaseHistorySizeRows(container?: HTMLElement): void {
    if (!container) {
      this.historyMenuEpoch += 1;
      this.historySizeRows.clear();
      return;
    }
    let released = false;
    for (const [id, row] of this.historySizeRows) {
      if (row.container !== container) continue;
      this.historySizeRows.delete(id);
      released = true;
    }
    if (released) this.historyMenuEpoch += 1;
  }

  discardHistorySizeRow(conversationId: string): void {
    this.historySizeRows.delete(conversationId);
  }

  /** Publication targets the current rows, not the nodes that initiated a stat. */
  onConversationSizePublished(conversationId: string, container?: HTMLElement): void {
    const { plugin, state } = this.deps;
    const row = this.historySizeRows.get(conversationId);
    const snapshot = plugin.conversationSizes?.getSnapshot(conversationId);
    if (!row || !snapshot || snapshot.conversationId !== conversationId
      || (container && row.container !== container) || row.epoch !== this.historyMenuEpoch
      || !row.container.hasClass('visible') || !row.container.contains(row.sizeEl)
      || state.currentConversationId !== row.menuConversationId || !row.conversation
      || plugin.getConversationSync(conversationId) !== row.conversation) return;
    const info = { sizeSnapshot: snapshot };
    row.sizeEl.textContent = formatConversationSize(info);
    row.sizeEl.setAttribute('aria-label', formatConversationSizeTooltip(info));
  }

  toggleHistoryDropdown(): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    const isVisible = dropdown.hasClass('visible');
    if (isVisible) {
      dropdown.removeClass('visible');
      this.releaseHistorySizeRows(dropdown);
    } else {
      this.updateHistoryDropdown(true);
      dropdown.addClass('visible');
    }
  }

  updateHistoryDropdown(refreshSizes = false): void {
    const dropdown = this.deps.getHistoryDropdown();
    if (!dropdown) return;

    this.renderHistoryItems(dropdown, {
      refreshSizes,
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
    const menuEpoch = ++this.historyMenuEpoch;
    const menuConversationId = state.currentConversationId;
    const bindSizeRows = options.refreshSizes || container.hasClass('visible');
    this.historySizeRows.clear();
    this.historyIdentityRow = null;

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
      if (isCurrent) {
        // Identity suffix is current-session-only: history rows, drafts
        // (sessionId null), and registry misses render plain titles. The
        // Conversation (not the list meta) carries the full session UUID.
        this.historyIdentityRow = {
          epoch: menuEpoch,
          container,
          titleEl,
          title: conv.title,
          conversation: plugin.getConversationSync(conv.id),
          menuConversationId,
        };
        this.applySessionIdentitySuffix(this.historyIdentityRow);
        this.refreshActiveSessionNames();
      }
      content.createDiv({
        cls: 'claudian-history-item-date',
        text: isCurrent ? 'Current session' : this.formatDate(conv.lastResponseAt ?? conv.createdAt),
      });

      const sizeEl = content.createDiv({ cls: 'claudian-history-item-date', text: formatConversationSize(conv) });
      sizeEl.setAttribute('aria-label', formatConversationSizeTooltip(conv));
      if (bindSizeRows) this.historySizeRows.set(conv.id, {
        epoch: menuEpoch, container, sizeEl, menuConversationId,
        conversation: plugin.getConversationSync(conv.id),
      });
      const request = options.refreshSizes ? plugin.conversationSizes?.refresh(conv.id, true) : undefined;
      if (request) void request.then(() => this.onConversationSizePublished(conv.id, container)).catch(() => undefined);

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

  /**
   * One registry scan per current-row render (registry scale = active
   * process count, so no promise caching). On resolve, backfill the suffix
   * under the menu guards; scan failures degrade to the last known names.
   */
  private refreshActiveSessionNames(): void {
    loadActiveSessionNames()
      .then((names) => {
        this.activeSessionNames = names;
        const row = this.historyIdentityRow;
        if (!row) return;
        const { plugin, state } = this.deps;
        if (row.epoch !== this.historyMenuEpoch
          || state.currentConversationId !== row.menuConversationId
          || !row.container.hasClass('visible') || !row.container.contains(row.titleEl)
          || plugin.getConversationSync(row.menuConversationId ?? '') !== row.conversation) return;
        this.applySessionIdentitySuffix(row);
      })
      .catch(() => undefined);
  }

  /** Idempotent suffix + tooltip write; no registry hit → no dangling separator. */
  private applySessionIdentitySuffix(row: NonNullable<ConversationController['historyIdentityRow']>): void {
    const sessionId = row.conversation?.sessionId ?? '';
    const identity = formatActiveSessionIdentity(sessionId, this.activeSessionNames.get(sessionId) ?? '');
    if (!identity) return;
    const existing = row.titleEl.querySelector<HTMLElement>('.claudian-history-item-identity');
    if (existing) {
      existing.textContent = ` · ${identity}`;
    } else {
      row.titleEl.createSpan({ cls: 'claudian-history-item-identity', text: ` · ${identity}` });
    }
    row.titleEl.setAttribute('title', `${row.title} · ${identity}`);
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
        await this.deps.plugin.renameConversationManually(convId, newTitle);
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
      onRerender: () => this.renderHistoryDropdown(container, { ...options, refreshSizes: false }),
    });
  }
}

/**
 * Controller-side RuntimePersistencePort: wraps a ChatRuntime as the pure
 * capture source for its adopted binding (P6 §4.2/§6.3). The capture runs the
 * provider-owned session reduction synchronously at admission time against
 * the record's latest base — never at write time, never against a runtime
 * another binding owns. The one-shot session-invalidation flag is consumed by
 * the controller before admission and cleared by the capture acknowledgement
 * only for the revision it was captured with.
 */
class ChatRuntimePersistencePort implements RuntimePersistencePort {
  readonly identity: object;
  readonly providerId: ProviderId;
  private invalidationRevision = 0;
  private invalidated = false;

  constructor(
    private readonly runtime: ChatRuntime,
    private readonly getBase: () => Conversation | null,
  ) {
    this.identity = runtime;
    this.providerId = runtime.providerId;
  }

  markSessionInvalidated(): void {
    this.invalidated = true;
    this.invalidationRevision += 1;
  }

  captureSessionPersistence(): CapturedSessionPersistence {
    const base = this.getBase();
    const { updates } = this.runtime.buildSessionUpdates({
      conversation: base,
      sessionInvalidated: this.invalidated,
    });
    // JSON-clean provider reduction: undefined-valued fields (legal in a
    // Partial<Conversation> assign payload) cannot ride the capture — encode
    // sessionId null-for-absent and providerState null-for-cleared instead.
    const reduced = updates ?? {};
    const providerState = reduced.providerState === undefined
      ? null
      : ChatRuntimePersistencePort.cleanUndefined(reduced.providerState);
    return {
      protocolVersion: 1,
      providerId: this.providerId,
      facts: {
        sessionId: reduced.sessionId === undefined ? null : reduced.sessionId,
        providerState,
      } as unknown as JsonObject,
      invalidation: { revision: this.invalidationRevision, invalidated: this.invalidated },
    };
  }

  /** Deep-copies plain JSON data with undefined-valued keys stripped. */
  private static cleanUndefined(value: unknown, seen: Set<object> = new Set()): unknown {
    if (value === undefined) return undefined;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      const copy = value
        .map(item => ChatRuntimePersistencePort.cleanUndefined(item, seen))
        .filter(item => item !== undefined);
      seen.delete(value);
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = ChatRuntimePersistencePort.cleanUndefined(item, seen);
      if (cleaned !== undefined) copy[key] = cleaned;
    }
    seen.delete(value);
    return copy;
  }

  acknowledgeSessionPersistenceCapture(capture: CapturedSessionPersistence): void {
    if (capture.invalidation.invalidated && capture.invalidation.revision === this.invalidationRevision) {
      this.invalidated = false;
    }
  }
}
