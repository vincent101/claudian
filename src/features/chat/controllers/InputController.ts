import { Notice } from 'obsidian';

import {
  type BuiltInCommand,
  detectBuiltInCommand,
  isBuiltInCommandSupported,
} from '../../../core/commands/builtInCommands';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type InstructionRefineService,
  type ProviderCapabilities,
  type ProviderId,
  type TitleGenerationService,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallbackOptions,
  ApprovalDecisionOption,
  ChatTurnRequest,
} from '../../../core/runtime/types';
import { TOOL_EXIT_PLAN_MODE } from '../../../core/tools/toolNames';
import type { ApprovalDecision, ChatMessage, ExitPlanModeDecision, StreamChunk } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';
import { ResumeSessionDropdown } from '../../../shared/components/ResumeSessionDropdown';
import { InstructionModal } from '../../../shared/modals/InstructionConfirmModal';
import type { BrowserSelectionContext } from '../../../utils/browser';
import type { CanvasSelectionContext } from '../../../utils/canvas';
import { formatDurationMmSs } from '../../../utils/date';
import type { EditorSelectionContext } from '../../../utils/editor';
import { appendMarkdownSnippet } from '../../../utils/markdown';
import { COMPLETION_FLAVOR_WORDS } from '../constants';
import type { HistoryWindowRenderer } from '../rendering/HistoryWindowRenderer';
import { type InlineAskQuestionConfig, InlineAskUserQuestion } from '../rendering/InlineAskUserQuestion';
import { InlineExitPlanMode } from '../rendering/InlineExitPlanMode';
import { InlinePlanApproval,type PlanApprovalDecision } from '../rendering/InlinePlanApproval';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { ProjectionWriteLease } from '../rendering/ProjectionWriteCoordinator';
import { setToolIcon, updateToolCallResult } from '../rendering/ToolCallRenderer';
import { finalizeWriteEditBlock } from '../rendering/WriteEditRenderer';
import type { AskRelayPendingInfo, AskRelayService } from '../services/AskRelayService';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { QueuedMessage } from '../state/types';
import type { CompletedTurnEvent } from '../tabs/types';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type { AddExternalContextResult, McpServerSelector } from '../ui/InputToolbar';
import type { InstructionModeManager } from '../ui/InstructionModeManager';
import type { StatusPanel } from '../ui/StatusPanel';
import type { BrowserSelectionController } from './BrowserSelectionController';
import type { CanvasSelectionController } from './CanvasSelectionController';
import type { ConversationController } from './ConversationController';
import type { SelectionController } from './SelectionController';
import { createTurnProjectionContext, type StreamController, type TurnProjectionContext } from './StreamController';
import type { TurnCoordinator } from './TurnCoordinator';

const APPROVAL_OPTION_MAP: Record<string, ApprovalDecision> = {
  'Deny': 'deny',
  'Allow once': 'allow',
  'Always allow': 'allow-always',
};

/** Plan A bound for auto-turn asks: 5 minutes for the attention notification
 * to reach the user before falling back to the deny+interrupt protection. */
const AUTO_TURN_ASK_TIMEOUT_MS = 5 * 60 * 1000;

/** User-turn ask attention window: past this the ask relay pending info goes
 * out as a desktop notification (summary + nonce) — the user has likely left
 * the desk and the phone is the reachable channel. */
const USER_ASK_ATTENTION_TIMEOUT_MS = 60 * 1000;

const DEFAULT_APPROVAL_DECISION_OPTIONS: ApprovalDecisionOption[] =
  Object.entries(APPROVAL_OPTION_MAP).map(([label, decision]) => ({
    label,
    value: label,
    decision,
  }));

export interface InputControllerDeps {
  plugin: ClaudianPlugin;
  state: ChatState;
  renderer: MessageRenderer;
  streamController: StreamController;
  selectionController: SelectionController;
  browserSelectionController?: BrowserSelectionController;
  canvasSelectionController: CanvasSelectionController;
  conversationController: ConversationController;
  getInputEl: () => HTMLTextAreaElement;
  getWelcomeEl: () => HTMLElement | null;
  setWelcomeEl?: (el: HTMLElement | null) => void;
  getMessagesEl: () => HTMLElement;
  getFileContextManager: () => FileContextManager | null;
  getImageContextManager: () => ImageContextManager | null;
  getMcpServerSelector: () => McpServerSelector | null;
  getExternalContextSelector: () => {
    getExternalContexts: () => string[];
    addExternalContext: (path: string) => AddExternalContextResult;
  } | null;
  getInstructionModeManager: () => InstructionModeManager | null;
  getInstructionRefineService: () => InstructionRefineService | null;
  getTitleGenerationService: () => TitleGenerationService | null;
  getStatusPanel: () => StatusPanel | null;
  getInputContainerEl: () => HTMLElement;
  generateId: () => string;
  resetInputHeight: () => void;
  getAuxiliaryModel?: () => string | null;
  getAgentService?: () => ChatRuntime | null;
  getSubagentManager: () => SubagentManager;
  /** Feature-layer turn lease (S2); absent in legacy tests → state-only checks. */
  getTurnCoordinator?: () => TurnCoordinator | null;
  /**
   * Per-tab projection write lease (coord protocol P1/P2); absent in legacy
   * tests → sends proceed without waiting for the stored render queue.
   */
  getProjectionCoordinator?: () => {
    acquireLive: (isCancelled?: () => boolean) => Promise<ProjectionWriteLease | null>;
    runStored: <T>(isCancelled: () => boolean, task: () => Promise<T>) => Promise<T | null>;
  } | null;
  getHistoryWindowRenderer?: () => HistoryWindowRenderer | null;
  /** Tab-level provider fallback for blank tabs (derived from draft model). */
  getTabProviderId?: () => ProviderId;
  /**
   * Successful user-turn completion signal: fired once per turn, only after
   * the provider stream exhausted naturally and the final visible projection
   * settled. Notification policy reads this, never the UI busy state.
   */
  onTurnCompleted?: (event: CompletedTurnEvent) => void;
  /**
   * Ask relay service (channel B for AskUserQuestion). Absent in legacy
   * tests → user-turn asks keep the pure desktop card path.
   */
  getAskRelay?: () => AskRelayService | null;
  /**
   * A user-turn ask armed the relay and stayed unanswered for the attention
   * window — fire the ask-pending desktop notification (summary + nonce).
   */
  onAskAttentionTimeout?: (pending: AskRelayPendingInfo) => void;
  /** Returns true if ready. */
  ensureServiceInitialized?: () => Promise<boolean>;
  openConversation?: (conversationId: string) => Promise<void>;
  onForkAll?: () => Promise<void>;
  restorePrePlanPermissionModeIfNeeded?: () => void;
}

export class InputController {
  private deps: InputControllerDeps;
  private pendingApprovalInline: InlineAskUserQuestion | null = null;
  private pendingAskInline: InlineAskUserQuestion | null = null;
  private pendingExitPlanModeInline: InlineExitPlanMode | null = null;
  private pendingPlanApproval: InlinePlanApproval | null = null;
  private pendingPlanApprovalInvalidated = false;
  private activeResumeDropdown: ResumeSessionDropdown | null = null;
  private inputContainerHideDepth = 0;
  private steerInFlight = false;
  private pendingSteerMessage: QueuedMessage | null = null;
  private activeStreamingAssistantMessage: ChatMessage | null = null;
  private activeLivePageMessages: ChatMessage[] = [];
  /** Turn projection context of the in-flight turn (v3 §5.1); cleared on turn end. */
  private activeTurnContext: TurnProjectionContext | null = null;
  private pendingProviderUserMessages: Array<{
    displayContent: string;
    persistedContent?: string;
    currentNote?: string;
    images?: ChatMessage['images'];
  }> = [];
  private sawInitialProviderUserMessage = false;
  private awaitingProviderAssistantStart = false;

  constructor(deps: InputControllerDeps) {
    this.deps = deps;
  }

  private getAgentService(): ChatRuntime | null {
    return this.deps.getAgentService?.() ?? null;
  }

  private getTurnCoordinator(): TurnCoordinator | null {
    return this.deps.getTurnCoordinator?.() ?? null;
  }

  private getAuxiliaryModel(): string | null {
    return this.deps.getAuxiliaryModel?.()
      ?? this.getAgentService()?.getAuxiliaryModel?.()
      ?? null;
  }

  private syncInstructionRefineModelOverride(
    instructionRefineService: InstructionRefineService,
  ): void {
    instructionRefineService.setModelOverride?.(this.getAuxiliaryModel() ?? undefined);
  }

  private getActiveProviderId(): ProviderId {
    const agentService = this.getAgentService();
    const conversationId = this.deps.state.currentConversationId;
    if (!conversationId) {
      return this.deps.getTabProviderId?.() ?? agentService?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    }

    if (agentService?.providerId) {
      return agentService.providerId;
    }

    return this.deps.plugin.getConversationSync(conversationId)?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
  }

  private getActiveCapabilities(): ProviderCapabilities {
    const providerId = this.getActiveProviderId();
    const agentService = this.getAgentService();
    if (agentService?.providerId === providerId) {
      return agentService.getCapabilities();
    }

    return ProviderRegistry.getCapabilities(providerId);
  }

  private isResumeSessionAtStillNeeded(resumeUuid: string, previousMessages: ChatMessage[]): boolean {
    for (let i = previousMessages.length - 1; i >= 0; i--) {
      if (previousMessages[i].role === 'assistant' && previousMessages[i].assistantMessageId === resumeUuid) {
        // Still needed only if no messages follow the resume point
        return i === previousMessages.length - 1;
      }
    }
    return false;
  }

  // ============================================
  // Message Sending
  // ============================================

  async sendMessage(options?: {
    editorContextOverride?: EditorSelectionContext | null;
    browserContextOverride?: BrowserSelectionContext | null;
    canvasContextOverride?: CanvasSelectionContext | null;
    content?: string;
  }): Promise<void> {
    const {
      plugin,
      state,
      renderer,
      streamController,
      selectionController,
      browserSelectionController,
      canvasSelectionController,
      conversationController
    } = this.deps;

    // During conversation creation/switching, don't send - input is preserved so user can retry
    if (state.isCreatingConversation || state.isSwitchingConversation) return;

    const inputEl = this.deps.getInputEl();
    const imageContextManager = this.deps.getImageContextManager();
    const fileContextManager = this.deps.getFileContextManager();

    const contentOverride = options?.content;
    const shouldUseInput = contentOverride === undefined;
    const content = (contentOverride ?? inputEl.value).trim();
    const hasImages = imageContextManager?.hasImages() ?? false;
    if (!content && !hasImages) return;

    // Check for built-in commands first (e.g., /clear, /new, /add-dir)
    const builtInCmd = detectBuiltInCommand(content);
    if (builtInCmd) {
      if (shouldUseInput) {
        inputEl.value = '';
        this.deps.resetInputHeight();
      }
      await this.executeBuiltInCommand(builtInCmd.command, builtInCmd.args);
      return;
    }

    // If agent is working, queue the message instead of dropping it.
    // The feature turn lease (S2) covers both user turns and SDK-initiated
    // auto turns; either way the input may only enter the UI queue.
    if (state.isStreaming || this.getTurnCoordinator()?.isBusy()) {
      const images = hasImages ? [...(imageContextManager?.getAttachedImages() || [])] : undefined;
      const editorContext = selectionController.getContext();
      const browserContext = browserSelectionController?.getContext() ?? null;
      const canvasContext = canvasSelectionController.getContext();
      state.queuedMessage = this.mergeQueuedMessages(state.queuedMessage, {
        content,
        images,
        editorContext,
        browserContext,
        canvasContext,
      });

      if (shouldUseInput) {
        inputEl.value = '';
        this.deps.resetInputHeight();
      }
      imageContextManager?.clearImages();
      this.updateQueueIndicator();
      return;
    }

    if (shouldUseInput) {
      inputEl.value = '';
      this.deps.resetInputHeight();
    }
    state.isStreaming = true;
    state.cancelRequested = false;
    state.ignoreUsageUpdates = false; // Allow usage updates for new query
    this.deps.getSubagentManager().resetSpawnedCount();
    state.autoScrollEnabled = plugin.settings.enableAutoScroll ?? true; // Reset auto-scroll based on setting
    const streamGeneration = state.bumpStreamGeneration();

    // v4 §2.1: the user turnId is minted here (single source) and threads
    // through the feature lease, ChatTurnRequest and the runtime turn. The
    // feature lease must be taken before any user/assistant DOM is created
    // (v3 §3) so a racing auto turn cannot interleave.
    const turnId = this.deps.generateId();
    const turnCoordinator = this.getTurnCoordinator();
    if (turnCoordinator && !turnCoordinator.beginUserTurn(turnId, streamGeneration)) {
      // Fail-fast (turn-lease hotfix): the lease was lost between the
      // isBusy() gate above and here — queue behind the winner instead of
      // creating UI/runtime turn state for a lease this send does not own.
      // isStreaming stays true: the lease winner owns it now.
      state.queuedMessage = this.mergeQueuedMessages(state.queuedMessage, {
        content,
        images: hasImages ? [...(imageContextManager?.getAttachedImages() || [])] : undefined,
        editorContext: selectionController.getContext(),
        browserContext: browserSelectionController?.getContext() ?? null,
        canvasContext: canvasSelectionController.getContext(),
      });
      imageContextManager?.clearImages();
      this.updateQueueIndicator();
      return;
    }

    let hostProjectionRuntime: ChatRuntime | null = null;
    const registerHostProjection = (): void => {
      const runtime = this.getAgentService();
      if (!runtime || runtime === hostProjectionRuntime) return;
      runtime.beginUserTurnProjection?.(turnId);
      runtime.recordAutoTurnDiagnostic?.({
        phase: 'lease_begin', turnId, generation: streamGeneration, leaseKind: 'user',
      });
      hostProjectionRuntime = runtime;
    };
    // Existing runtimes register synchronously with the feature lease. Cold
    // starts retain turnId in this closure and register immediately after init.
    registerHostProjection();

    // Turn-scoped render flushes (turn-lease hotfix): a fresh scope so a
    // cancel/invalidation from a previous turn cannot drop this turn's
    // pending renders.
    streamController.beginRenderFlushScope?.();

    // P2 live projection lease: the user/assistant DOM pair must wait for any
    // stored render queue (initial history framing, search re-locate) to
    // drain before mounting, or the new turn interleaves with pending slices.
    // The wait is conditional — no timers; stale waits are cancelled through
    // generation/turn-lease invalidation.
    const projectionCoordinator = this.deps.getProjectionCoordinator?.() ?? null;
    let projectionLease: ProjectionWriteLease | null = null;
    if (projectionCoordinator) {
      const turnLeaseLost = (): boolean =>
        !!turnCoordinator && !turnCoordinator.isCurrentTurn(turnId, streamGeneration);
      projectionLease = await projectionCoordinator.acquireLive(() =>
        state.streamGeneration !== streamGeneration || turnLeaseLost()
      );
      if (projectionLease && (state.streamGeneration !== streamGeneration || turnLeaseLost())) {
        // The turn was invalidated while queued behind the stored drain.
        projectionLease.release();
        projectionLease = null;
      }
      if (!projectionLease) {
        // Queue instead of dropping — the cancelled wait lost the race, the
        // message itself is still wanted. No user/assistant DOM was created,
        // so no projection cleanup is needed.
        state.queuedMessage = this.mergeQueuedMessages(state.queuedMessage, {
          content,
          images: hasImages ? [...(imageContextManager?.getAttachedImages() || [])] : undefined,
          editorContext: selectionController.getContext(),
          browserContext: browserSelectionController?.getContext() ?? null,
          canvasContext: canvasSelectionController.getContext(),
        });
        imageContextManager?.clearImages();
        this.updateQueueIndicator();
        if (state.streamGeneration === streamGeneration && state.isStreaming) {
          state.isStreaming = false;
          streamController.hideThinkingIndicator();
        }
        this.getTurnCoordinator()?.finish(turnId);
        return;
      }
    }

    let turnContext: TurnProjectionContext | null = null;
    this.activeLivePageMessages = [];
    let shouldReleaseUserTurn = false;
    let deferredAutoSendContent: string | null = null;
    let deferredNewSessionPlan: string | null = null;
    let wasInvalidated = false;
    // Turn-completion gates: the event may only fire when the provider
    // stream exhausted naturally (break/throw leave this false) and the
    // final visible projection settled — see the outer finally.
    let providerCompletedNaturally = false;
    let turnCompletionNotified = false;
    // Turn-local cancellation latch: state.cancelRequested is reset during
    // cleanup, so the emission gate in the outer finally must not re-read the
    // shared flag — a cancel landing between natural exhaustion and the reset
    // would otherwise be forgotten and misreported as completed.
    let didCancelThisTurn = false;

    try {
    // Hide welcome message when sending first message
    const welcomeEl = this.deps.getWelcomeEl();
    if (welcomeEl) {
      welcomeEl.style.display = 'none';
    }

    fileContextManager?.startSession();

    // Slash commands are passed directly to SDK for handling
    // SDK handles expansion, $ARGUMENTS, @file references, and frontmatter options
    const images = imageContextManager?.getAttachedImages() || [];
    const imagesForMessage = images.length > 0 ? [...images] : undefined;
    const isCompact = /^\/compact(\s|$)/i.test(content);

    // Only clear images if we consumed user input (not for programmatic content override)
    if (shouldUseInput) {
      imageContextManager?.clearImages();
    }

    const { displayContent, turnRequest } = this.buildTurnSubmission({
      turnId,
      content,
      images: imagesForMessage,
      editorContextOverride: options?.editorContextOverride,
      browserContextOverride: options?.browserContextOverride,
      canvasContextOverride: options?.canvasContextOverride,
    });

    fileContextManager?.markCurrentNoteSent();

    const userMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'user',
      content: displayContent,
      displayContent,                // Original user input (for UI display)
      timestamp: Date.now(),
      images: imagesForMessage,
    };
    state.addMessage(userMsg);
    this.activeLivePageMessages.push(userMsg);
    state.hasPendingConversationSave = true;
    const liveRoot = this.deps.getHistoryWindowRenderer?.()?.beginLivePage(
      `live:${turnId}`,
      [userMsg],
      state.historyLease?.totalTurns ?? state.loadedRanges.at(-1)?.end ?? 0,
    );
    if (liveRoot) renderer.setMessagesEl(liveRoot);
    renderer.addMessage(userMsg);

    await this.triggerTitleGeneration();

    const assistantMsg: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    state.addMessage(assistantMsg);
    this.activeLivePageMessages.push(assistantMsg);
    this.activeStreamingAssistantMessage = assistantMsg;
    this.activateStreamingAssistantMessage(assistantMsg);
    // v3 §5.1: explicit projection context — the data truth for this turn.
    // message/renderTarget are refreshed per chunk because provider boundary
    // chunks switch the active assistant message and its content element.
    // domEpoch captures the DOM generation the mount point belongs to (P4).
    turnContext = createTurnProjectionContext({
      turnId,
      message: assistantMsg,
      renderTarget: state.currentContentEl,
      generation: streamGeneration,
      domEpoch: renderer.domEpoch,
    });
    this.activeTurnContext = turnContext;
    this.pendingProviderUserMessages = [{
      displayContent,
      images: imagesForMessage,
    }];
    this.sawInitialProviderUserMessage = false;
    this.awaitingProviderAssistantStart = true;

    streamController.showThinkingIndicator(
      isCompact ? 'Compacting...' : undefined,
      isCompact ? 'claudian-thinking--compact' : undefined,
    );
    state.responseStartTime = performance.now();

    let wasInterrupted = false;
    let didEnqueueToSdk = false;
    let planCompleted = false;

    // Lazy initialization: ensure service is ready before first query
    if (this.deps.ensureServiceInitialized) {
      const ready = await this.deps.ensureServiceInitialized();
      if (!ready) {
        new Notice(t('chat.input.serviceInitFailed'));
        streamController.hideThinkingIndicator();
        state.isStreaming = false;
        return;
      }
    }

    const agentService = this.getAgentService();
    if (!agentService) {
      new Notice(t('chat.input.serviceUnavailable'));
      return;
    }
    registerHostProjection();

    // Restore pendingResumeAt from persisted conversation state (survives plugin reload)
    const conversationIdForSend = state.currentConversationId;
    if (conversationIdForSend) {
      const conv = plugin.getConversationSync(conversationIdForSend);
      if (conv?.resumeAtMessageId) {
        if (this.isResumeSessionAtStillNeeded(conv.resumeAtMessageId, state.messages.slice(0, -2))) {
          agentService.setResumeCheckpoint(conv.resumeAtMessageId);
        } else {
          try {
            await plugin.updateConversation(conversationIdForSend, { resumeAtMessageId: undefined });
          } catch {
            // Best-effort — don't block send
          }
        }
      }
    }

    try {
      const preparedTurn = agentService.prepareTurn(turnRequest);
      userMsg.content = preparedTurn.persistedContent;
      userMsg.currentNote = preparedTurn.isCompact
        ? undefined
        : preparedTurn.request.currentNotePath;

      // Pass history WITHOUT current turn (userMsg + assistantMsg we just added)
      // This prevents duplication when rebuilding context for new sessions
      const previousMessages = state.messages.slice(0, -2);
      for await (const chunk of agentService.query(preparedTurn, previousMessages)) {
        if (state.streamGeneration !== streamGeneration) {
          wasInvalidated = true;
          break;
        }
        if (state.cancelRequested) {
          wasInterrupted = true;
          break;
        }

        if (await this.handleProviderMessageBoundaryChunk(chunk)) {
          continue;
        }

        turnContext.message = this.activeStreamingAssistantMessage ?? assistantMsg;
        turnContext.renderTarget = state.currentContentEl;
        await streamController.handleStreamChunk(chunk, turnContext);
      }
      // Natural exhaustion only: break paths set wasInvalidated/wasInterrupted
      // beforehand and a thrown query skips this line entirely.
      providerCompletedNaturally = !wasInvalidated && !wasInterrupted;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      // Null guard: a turn projection that was never created has no DOM to
      // append the error marker to — appending anyway would TypeError and
      // mask the original error.
      if (turnContext) {
        await streamController.appendTurnText(`\n\n**Error:** ${errorMsg}`, turnContext);
      }
    } finally {
      // Nested finally: the cleanup body below contains throwing awaits
      // (finalize, plan approval prompt, save, title refresh, createNew).
      // The lease release in the inner finally must run even when one of
      // them rejects — otherwise the feature lease leaks and isBusy() stays
      // true forever, deadlocking all future sends.
      try {
      const finalAssistantMsg = this.activeStreamingAssistantMessage ?? assistantMsg;
      const turnMetadata = agentService.consumeTurnMetadata();
      userMsg.userMessageId = turnMetadata.userMessageId ?? userMsg.userMessageId;
      finalAssistantMsg.assistantMessageId = turnMetadata.assistantMessageId ?? finalAssistantMsg.assistantMessageId;
      didEnqueueToSdk = didEnqueueToSdk || turnMetadata.wasSent === true;
      planCompleted = planCompleted || turnMetadata.planCompleted === true;

      // ALWAYS clear the timer interval, even on stream invalidation (prevents memory leaks)
      state.clearFlavorTimerInterval();

      // Skip remaining cleanup if stream was invalidated (tab closed or conversation switched)
      if (!wasInvalidated && state.streamGeneration === streamGeneration) {
        didCancelThisTurn = wasInterrupted || state.cancelRequested;
        if (didCancelThisTurn) {
          this.settleInterruptedTurn(finalAssistantMsg);
        }
        if (didCancelThisTurn && !state.pendingNewSessionPlan && turnContext) {
          await streamController.appendTurnText('\n\n<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>', turnContext);
        }
        streamController.hideThinkingIndicator();
        state.isStreaming = false;
        state.cancelRequested = false;
        this.restorePendingSteerMessageToQueue();

        // Capture response duration before resetting state (skip for interrupted responses and compaction)
        const hasCompactBoundary = finalAssistantMsg.contentBlocks?.some(b => b.type === 'context_compacted');
        if (!didCancelThisTurn && !hasCompactBoundary) {
          const durationSeconds = state.responseStartTime
            ? Math.floor((performance.now() - state.responseStartTime) / 1000)
            : 0;
          if (durationSeconds > 0) {
            const flavorWord =
              COMPLETION_FLAVOR_WORDS[Math.floor(Math.random() * COMPLETION_FLAVOR_WORDS.length)];
            finalAssistantMsg.durationSeconds = durationSeconds;
            finalAssistantMsg.durationFlavorWord = flavorWord;
            // Add footer to live message in DOM
            if (state.currentContentEl) {
              const footerEl = state.currentContentEl.createDiv({ cls: 'claudian-response-footer' });
              footerEl.createSpan({
                text: `* ${flavorWord} for ${formatDurationMmSs(durationSeconds)}`,
                cls: 'claudian-baked-duration',
              });
            }
          }
        }

        state.currentContentEl = null;

        await streamController.finalizeCurrentThinkingBlock(finalAssistantMsg, turnContext!);
        await streamController.finalizeCurrentTextBlock(finalAssistantMsg, turnContext!);
        this.deps.getSubagentManager().resetStreamingState();

        // Auto-hide completed todo panel on response end
        // Panel reappears only when new TodoWrite tool is called
        if (state.currentTodos && state.currentTodos.every(t => t.status === 'completed')) {
          state.currentTodos = null;
        }
        this.syncScrollToBottomAfterRenderUpdates();

        // approve-new-session: the tool_result chunk is dropped because cancelRequested
        // was set before the stream loop could process it — manually set the result so
        // the saved conversation renders correctly when revisited
        if (state.pendingNewSessionPlan && finalAssistantMsg.toolCalls) {
          for (const tc of finalAssistantMsg.toolCalls) {
            if (tc.name === TOOL_EXIT_PLAN_MODE && !tc.result) {
              tc.status = 'completed';
              tc.result = 'User approved the plan and started a new session.';
              updateToolCallResult(tc.id, tc, state.toolCallElements);
            }
          }
        }

        // Provider-agnostic post-plan approval: show UI and await decision before save/auto-send
        let planAutoSendContent: string | null = null;
        let planApprovalInvalidated = false;
        let shouldProcessQueuedMessage = true;
        if (planCompleted && !didCancelThisTurn) {
          let decision: PlanApprovalDecision | null;
          let invalidated: boolean;
          this.deps.state.beginAttention();
          try {
            ({ decision, invalidated } = await this.showPlanApproval());
          } finally {
            this.deps.state.endAttention();
          }

          // Re-check invalidation after async approval prompt
          if (state.streamGeneration !== streamGeneration || invalidated) {
            planApprovalInvalidated = true;
          } else if (decision?.type === 'implement') {
            this.deps.restorePrePlanPermissionModeIfNeeded?.();
            planAutoSendContent = 'Implement the plan.';
          } else if (decision?.type === 'revise') {
            // Keep plan mode active, populate input with feedback text
            this.deps.getInputEl().value = decision.text;
            shouldProcessQueuedMessage = false;
          } else {
            // cancel or null (dismissed)
            this.deps.restorePrePlanPermissionModeIfNeeded?.();
          }
        }

        if (!planApprovalInvalidated) {
          // Only clear resumeAtMessageId if enqueue succeeded; preserve checkpoint on failure for retry
          const saveExtras = didEnqueueToSdk ? { resumeAtMessageId: undefined } : undefined;
          await conversationController.save(true, saveExtras);

          // Periodically refresh the AI title with recent context (every 10 user messages)
          {
            const convId = state.currentConversationId;
            const userCount = state.messages.filter(m => m.role === 'user' && m.content).length;
            if (plugin.settings.enableAutoTitleGeneration && convId && userCount > 0 && userCount % 10 === 0) {
              const conv = await plugin.getConversationById(convId);
              if (conv && (conv.titleGenerationStatus === 'success' || conv.titleGenerationStatus === 'failed')) {
                conversationController.regenerateTitle(convId, { silent: true }).catch(() => {
                });
              }
            }
          }

          const userMsgIndex = state.messages.indexOf(userMsg);
          renderer.refreshActionButtons(userMsg, state.messages, userMsgIndex >= 0 ? userMsgIndex : undefined);

          // Auto-implement takes precedence over both approve-new-session and queued input
          if (planAutoSendContent) {
            deferredAutoSendContent = planAutoSendContent;
          } else {
            // Record successors only; the runtime acknowledgement must promote
            // any pending external turn before another user turn can start.
            const planContent = state.pendingNewSessionPlan;
            if (planContent) {
              state.pendingNewSessionPlan = null;
              deferredNewSessionPlan = planContent;
            } else if (shouldProcessQueuedMessage) {
              shouldReleaseUserTurn = true;
            }
          }
        }
      }

      if (wasInvalidated) {
        this.clearPendingSteerState();
        this.updateQueueIndicator();
      }
      } finally {
        this.activeStreamingAssistantMessage = null;
        this.activeTurnContext = null;
        this.resetProviderMessageBoundaryState();
      }
    }
    } finally {
      // Outer protective lease (turn-lease hotfix fix 1): covers every await
      // from beginUserTurn() to the end of the turn — title generation,
      // service init, checkpoint restore, query, projection and save. Any
      // rejection here previously leaked the feature lease (isBusy() stuck
      // true, all future sends dead-ended in the queue).
      this.getTurnCoordinator()?.finish(turnId);
      this.getAgentService()?.recordAutoTurnDiagnostic?.({
        phase: 'lease_finish', turnId, generation: streamGeneration, leaseKind: 'user',
      });

      // Defensive cleanup for paths that never reached the cleanup body
      // (title/init rejection): only when no newer turn took over the
      // stream generation — a newer turn owns the flag and the DOM then.
      if (state.streamGeneration === streamGeneration && state.isStreaming) {
        state.isStreaming = false;
        streamController.hideThinkingIndicator();
      }

      this.activeStreamingAssistantMessage = null;
      this.activeTurnContext = null;
      this.resetProviderMessageBoundaryState();

      const runtime = this.getAgentService();
      try {
        await runtime?.completeUserTurnProjection?.(turnId);
      } catch {
        // Best-effort acknowledgement: a failing observer handoff must not
        // break the turn-cleanup path (matches runtime callback isolation).
      }

      // P5 turn-boundary re-projection: when chunks skipped DOM writes
      // (mount evicted by a clear-rebuild), rebuild from the latest domain
      // state. Lock order is fixed — the live lease releases BEFORE the
      // stored transaction is queued; holding live while queueing stored
      // would self-deadlock the FIFO.
      projectionLease?.release();
      const historyWindowRenderer = this.deps.getHistoryWindowRenderer?.();
      historyWindowRenderer?.freezeLivePage(this.activeLivePageMessages);
      this.activeLivePageMessages = [];
      if (historyWindowRenderer) renderer.setMessagesEl(this.deps.getMessagesEl());
      // Whether the final visible projection settled — the completion event
      // may only fire after this is true. A dirty turn must re-project
      // cleanly first; a cancelled stored wait resolves null and a failing
      // re-projection throws, both leaving this false.
      let finalProjectionSettled: boolean;
      if (
        turnContext?.projectionDirty
        && !wasInvalidated
        && state.streamGeneration === streamGeneration
      ) {
        const reproject = async (): Promise<void> => {
          if (historyWindowRenderer) {
            historyWindowRenderer.rebuildMountedPages();
            return;
          }
          const welcomeEl = renderer.renderMessages(state.messages, () => conversationController.getGreeting());
          this.deps.setWelcomeEl?.(welcomeEl);
          await renderer.waitForRenderedMessages();
        };
        if (projectionCoordinator) {
          finalProjectionSettled = (await projectionCoordinator.runStored(
            () => state.streamGeneration !== streamGeneration,
            reproject,
          )) !== null;
        } else {
          await reproject();
          finalProjectionSettled = true;
        }
      } else {
        // Not dirty: the live streaming mount is the final projection; stale
        // or invalidated turns are excluded by the same gates here.
        finalProjectionSettled = !wasInvalidated && state.streamGeneration === streamGeneration;
      }

      // Once-guard: additional emission sites in this finally (deferred
      // follow-up sends, future re-entry) must not double-report the turn.
      const notifyTurnCompletedOnce = (): void => {
        if (turnCompletionNotified) return;
        turnCompletionNotified = true;
        this.deps.onTurnCompleted?.({ turnId, kind: 'user', outcome: 'completed' });
      };

      if (
        finalProjectionSettled
        && providerCompletedNaturally
        && !didCancelThisTurn
      ) {
        // Save is deliberately not a gate — a visible reply still completes
        // the turn even when persistence failed.
        notifyTurnCompletedOnce();
      }

      if (shouldReleaseUserTurn) {
        this.getAgentService()?.recordAutoTurnDiagnostic?.({
          phase: 'lease_release', turnId, generation: streamGeneration, leaseKind: 'user',
        });
        this.getTurnCoordinator()?.release(turnId);
      }
      if (deferredNewSessionPlan) {
        await conversationController.createNew();
        this.deps.getInputEl().value = deferredNewSessionPlan;
        this.sendMessage().catch(() => {});
      } else if (deferredAutoSendContent) {
        this.deps.getInputEl().value = deferredAutoSendContent;
        this.sendMessage().catch(() => {});
      }
    }
  }

  // ============================================
  // Cancel Settle-Down
  // ============================================

  /**
   * Cancel-path settle-down (2.3.2 ③): the stream loop breaks on interrupt
   * before the provider's rejected tool_results project, so running tool
   * elements and subagent panels would keep their spinner/Initializing state
   * forever. Forces every in-flight tool call of the turn into a terminal
   * error state and settles live subagent panels. Natural-completion and
   * error paths never reach this — their terminal semantics are untouched.
   */
  private settleInterruptedTurn(assistantMsg: ChatMessage): void {
    const { state } = this.deps;
    const interruptResultText = t('chat.cancel.toolInterrupted');

    for (const toolCall of assistantMsg.toolCalls ?? []) {
      if (toolCall.status !== 'running') continue;
      toolCall.status = 'error';
      toolCall.result = interruptResultText;

      const writeEditState = state.writeEditStates.get(toolCall.id);
      if (writeEditState) {
        finalizeWriteEditBlock(writeEditState, true);
      } else {
        updateToolCallResult(toolCall.id, toolCall, state.toolCallElements);
      }
    }

    this.deps.getSubagentManager().interruptAllActive(interruptResultText);
  }

  // ============================================
  // Queue Management
  // ============================================

  updateQueueIndicator(): void {
    const { state } = this.deps;
    const indicatorEl = state.queueIndicatorEl;
    if (!indicatorEl) return;

    indicatorEl.empty();

    const visibleQueuedMessage = state.queuedMessage ?? this.pendingSteerMessage;
    if (visibleQueuedMessage) {
      const isPendingSteerOnly = !state.queuedMessage && !!this.pendingSteerMessage;
      indicatorEl.createSpan({
        cls: 'claudian-queue-indicator-text',
        text: `${isPendingSteerOnly ? '⌙ Steering: ' : '⌙ Queued: '}${this.getQueuedMessageDisplay(visibleQueuedMessage)}`,
      });

      if (state.queuedMessage && this.canSteerQueuedMessage()) {
        const steerButton = indicatorEl.createEl('button', {
          cls: 'claudian-queue-indicator-action',
          text: this.steerInFlight ? 'Steering...' : 'Steer Now',
        });
        steerButton.setAttribute('type', 'button');
        if (this.steerInFlight) {
          steerButton.setAttribute('disabled', 'true');
        } else {
          steerButton.addEventListener('click', (event) => {
            event.stopPropagation();
            void this.steerQueuedMessage();
          });
        }
      }

      indicatorEl.style.display = 'flex';
      return;
    }

    indicatorEl.style.display = 'none';
  }

  clearQueuedMessage(): void {
    const { state } = this.deps;
    state.queuedMessage = null;
    this.updateQueueIndicator();
  }

  private restoreMessageToInput(message: QueuedMessage | null): void {
    if (!message) return;

    const { content, images } = message;
    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }
  }

  private restorePendingMessagesToInput(): void {
    const { state } = this.deps;
    const combinedMessage = this.mergePendingMessages(
      this.pendingSteerMessage,
      state.queuedMessage,
    );
    this.restoreMessageToInput(combinedMessage);
    state.queuedMessage = null;
    this.clearPendingSteerState();
    this.updateQueueIndicator();
  }

  /** Queue pump (v4 §3.1 step 7 target). Public for the TurnCoordinator wiring. */
  processQueuedMessage(): void {
    const { state } = this.deps;
    if (!state.queuedMessage) return;

    const { content, images, editorContext, browserContext, canvasContext } = state.queuedMessage;
    state.queuedMessage = null;
    this.updateQueueIndicator();

    const inputEl = this.deps.getInputEl();
    inputEl.value = content;
    if (images && images.length > 0) {
      this.deps.getImageContextManager()?.setImages(images);
    }

    setTimeout(
      () => this.sendMessage({
        editorContextOverride: editorContext,
        browserContextOverride: browserContext ?? null,
        canvasContextOverride: canvasContext,
      }),
      0
    );
  }

  private buildTurnSubmission(options: {
    /** User turns pass the feature-lease turnId; steer mints its own below. */
    turnId?: string;
    content: string;
    images?: ChatMessage['images'];
    editorContextOverride?: EditorSelectionContext | null;
    browserContextOverride?: BrowserSelectionContext | null;
    canvasContextOverride?: CanvasSelectionContext | null;
  }): {
    displayContent: string;
    turnRequest: ChatTurnRequest;
  } {
    const {
      selectionController,
      browserSelectionController,
      canvasSelectionController,
    } = this.deps;

    const fileContextManager = this.deps.getFileContextManager();
    const mcpServerSelector = this.deps.getMcpServerSelector();
    const externalContextSelector = this.deps.getExternalContextSelector();

    const currentNotePath = fileContextManager?.getCurrentNotePath() || null;
    const shouldSendCurrentNote = fileContextManager?.shouldSendCurrentNote(currentNotePath) ?? false;

    const editorContext = options.editorContextOverride !== undefined
      ? options.editorContextOverride
      : selectionController.getContext();
    const browserContext = options.browserContextOverride !== undefined
      ? options.browserContextOverride
      : (browserSelectionController?.getContext() ?? null);
    const canvasContext = options.canvasContextOverride !== undefined
      ? options.canvasContextOverride
      : canvasSelectionController.getContext();

    const externalContextPaths = externalContextSelector?.getExternalContexts();
    const isCompact = /^\/compact(\s|$)/i.test(options.content);
    const transformedText = !isCompact && fileContextManager
      ? fileContextManager.transformContextMentions(options.content)
      : options.content;
    const enabledMcpServers = mcpServerSelector?.getEnabledServers();

    return {
      displayContent: options.content,
      turnRequest: {
        // Single-source user turn id: generated here (feature layer), passed
        // unchanged through prepareTurn → runtime turn registry → message
        // channel lease. The runtime must not regenerate it. Steer requests
        // (mid-turn injections) mint their own id — they do not take the
        // feature lease.
        turnId: options.turnId ?? this.deps.generateId(),
        text: transformedText,
        images: options.images,
        currentNotePath: shouldSendCurrentNote && currentNotePath ? currentNotePath : undefined,
        editorSelection: editorContext,
        browserSelection: browserContext,
        canvasSelection: canvasContext,
        externalContextPaths: externalContextPaths && externalContextPaths.length > 0
          ? externalContextPaths
          : undefined,
        enabledMcpServers: enabledMcpServers && enabledMcpServers.size > 0
          ? enabledMcpServers
          : undefined,
      },
    };
  }

  private getQueuedMessageDisplay(message: QueuedMessage | null): string {
    if (!message) {
      return '';
    }

    const rawContent = message.content.trim();
    const preview = rawContent.length > 40
      ? rawContent.slice(0, 40) + '...'
      : rawContent;
    const hasImages = (message.images?.length ?? 0) > 0;

    if (hasImages) {
      return preview ? `${preview} [images]` : '[images]';
    }

    return preview;
  }

  private canSteerQueuedMessage(): boolean {
    const agentService = this.getAgentService();
    return this.deps.state.isStreaming
      && this.getActiveCapabilities().supportsTurnSteer === true
      && typeof agentService?.steer === 'function';
  }

  private cloneQueuedMessage(message: QueuedMessage): QueuedMessage {
    return {
      ...message,
      images: message.images ? [...message.images] : undefined,
    };
  }

  private mergePendingMessages(
    first: QueuedMessage | null,
    second: QueuedMessage | null,
  ): QueuedMessage | null {
    if (first && second) {
      return this.mergeQueuedMessages(first, second);
    }

    if (first) {
      return this.cloneQueuedMessage(first);
    }

    if (second) {
      return this.cloneQueuedMessage(second);
    }

    return null;
  }

  private clearPendingSteerState(): void {
    this.pendingSteerMessage = null;
    this.steerInFlight = false;
  }

  private restorePendingSteerMessageToQueue(): void {
    if (!this.pendingSteerMessage) {
      return;
    }

    const { state } = this.deps;
    const pendingSteerMessage = this.cloneQueuedMessage(this.pendingSteerMessage);
    this.clearPendingSteerState();
    state.queuedMessage = state.queuedMessage
      ? this.mergeQueuedMessages(pendingSteerMessage, state.queuedMessage)
      : pendingSteerMessage;
    this.updateQueueIndicator();
  }

  private mergeQueuedMessages(
    existing: QueuedMessage | null,
    incoming: QueuedMessage,
  ): QueuedMessage {
    if (!existing) {
      return {
        ...incoming,
        images: incoming.images ? [...incoming.images] : undefined,
      };
    }

    const contentParts = [existing.content, incoming.content].filter(part => part.length > 0);

    return {
      content: contentParts.join('\n\n'),
      images: [...(existing.images || []), ...(incoming.images || [])].filter(Boolean).length > 0
        ? [...(existing.images || []), ...(incoming.images || [])]
        : undefined,
      editorContext: incoming.editorContext,
      browserContext: incoming.browserContext,
      canvasContext: incoming.canvasContext,
    };
  }

  private async steerQueuedMessage(): Promise<void> {
    if (this.steerInFlight) {
      return;
    }

    const { state } = this.deps;
    const agentService = this.getAgentService();
    if (!state.queuedMessage || !this.canSteerQueuedMessage() || !agentService?.steer) {
      return;
    }

    const queuedMessage = this.cloneQueuedMessage(state.queuedMessage);
    state.queuedMessage = null;
    this.pendingSteerMessage = queuedMessage;
    this.steerInFlight = true;
    this.updateQueueIndicator();

    try {
      const { displayContent, turnRequest } = this.buildTurnSubmission({
        content: queuedMessage.content,
        images: queuedMessage.images,
        editorContextOverride: queuedMessage.editorContext,
        browserContextOverride: queuedMessage.browserContext ?? null,
        canvasContextOverride: queuedMessage.canvasContext,
      });

      const preparedTurn = agentService.prepareTurn(turnRequest);
      const accepted = await agentService.steer(preparedTurn);
      if (state.cancelRequested || !this.pendingSteerMessage) {
        return;
      }
      if (!accepted) {
        this.restoreQueuedMessageAfterSteerFailure(queuedMessage);
        return;
      }

      this.deps.getFileContextManager()?.markCurrentNoteSent();

      this.pendingProviderUserMessages.push({
        displayContent,
        persistedContent: preparedTurn.persistedContent,
        currentNote: preparedTurn.isCompact
          ? undefined
          : preparedTurn.request.currentNotePath,
        images: queuedMessage.images,
      });
    } catch {
      this.restoreQueuedMessageAfterSteerFailure(queuedMessage);
      new Notice(t('chat.input.steerQueuedFailed'));
    }
  }

  private restoreQueuedMessageAfterSteerFailure(
    message: QueuedMessage,
  ): void {
    const { state } = this.deps;
    this.clearPendingSteerState();
    if (state.cancelRequested) {
      this.updateQueueIndicator();
      return;
    }

    if (state.isStreaming) {
      state.queuedMessage = state.queuedMessage
        ? this.mergeQueuedMessages(message, state.queuedMessage)
        : message;
      this.updateQueueIndicator();
      return;
    }

    this.restoreMessageToInput(message);
    this.updateQueueIndicator();
  }

  private activateStreamingAssistantMessage(message: ChatMessage): void {
    const { state, renderer } = this.deps;
    const msgEl = renderer.addMessage(message);
    const contentEl = msgEl.querySelector('.claudian-message-content') as HTMLElement | null;

    if (!contentEl) {
      return;
    }

    if (!state.currentContentEl) {
      state.toolCallElements.clear();
    }

    state.currentContentEl = contentEl;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;

    // Provider boundary (P4): the new mount point belongs to the current DOM
    // generation, so the turn context re-captures the epoch. renderTarget is
    // refreshed by the next chunk from state.currentContentEl.
    if (this.activeTurnContext) {
      this.activeTurnContext.domEpoch = renderer.domEpoch;
    }
  }

  private resetProviderMessageBoundaryState(): void {
    this.pendingProviderUserMessages = [];
    this.sawInitialProviderUserMessage = false;
    this.awaitingProviderAssistantStart = false;
  }

  private async handleProviderMessageBoundaryChunk(chunk: StreamChunk): Promise<boolean> {
    switch (chunk.type) {
      case 'user_message_start':
        await this.handleProviderUserMessageStart(chunk);
        return true;
      case 'assistant_message_start':
        await this.handleProviderAssistantMessageStart();
        return true;
      default:
        return false;
    }
  }

  private async handleProviderUserMessageStart(
    chunk: Extract<StreamChunk, { type: 'user_message_start' }>,
  ): Promise<void> {
    const expected = this.pendingProviderUserMessages.shift();
    if (!this.sawInitialProviderUserMessage) {
      this.sawInitialProviderUserMessage = true;
      return;
    }

    this.clearPendingSteerState();
    this.updateQueueIndicator();

    const previousAssistant = this.activeStreamingAssistantMessage;
    const shouldDiscardPlaceholder = this.shouldDiscardPendingAssistantPlaceholder(previousAssistant);
    if (previousAssistant) {
      if (shouldDiscardPlaceholder) {
        this.discardStreamingAssistantMessage(previousAssistant.id);
      } else {
        await this.deps.streamController.finalizeCurrentThinkingBlock(previousAssistant, this.activeTurnContext ?? undefined);
        await this.deps.streamController.finalizeCurrentTextBlock(previousAssistant, this.activeTurnContext ?? undefined);
      }
    }
    this.deps.streamController.hideThinkingIndicator();

    const displayContent = expected?.displayContent ?? chunk.content;
    const persistedContent = expected?.persistedContent ?? displayContent;
    const images = expected?.images;
    if (displayContent || (images?.length ?? 0) > 0) {
      const userMessage: ChatMessage = {
        id: this.deps.generateId(),
        role: 'user',
        content: persistedContent,
        displayContent,
        timestamp: Date.now(),
        currentNote: expected?.currentNote,
        images,
      };
      this.deps.state.addMessage(userMessage);
      this.activeLivePageMessages.push(userMessage);
      this.deps.renderer.addMessage(userMessage);
    }

    const assistantMessage: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    this.deps.state.addMessage(assistantMessage);
    this.activeLivePageMessages.push(assistantMessage);
    this.activeStreamingAssistantMessage = assistantMessage;
    this.activateStreamingAssistantMessage(assistantMessage);
    this.deps.streamController.showThinkingIndicator();
    this.deps.state.responseStartTime = performance.now();
    this.awaitingProviderAssistantStart = true;
  }

  private async handleProviderAssistantMessageStart(): Promise<void> {
    if (this.awaitingProviderAssistantStart) {
      this.awaitingProviderAssistantStart = false;
      return;
    }

    const previousAssistant = this.activeStreamingAssistantMessage;
    if (previousAssistant) {
      await this.deps.streamController.finalizeCurrentThinkingBlock(previousAssistant, this.activeTurnContext ?? undefined);
      await this.deps.streamController.finalizeCurrentTextBlock(previousAssistant, this.activeTurnContext ?? undefined);
    }

    const assistantMessage: ChatMessage = {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    this.deps.state.addMessage(assistantMessage);
    this.activeLivePageMessages.push(assistantMessage);
    this.activeStreamingAssistantMessage = assistantMessage;
    this.activateStreamingAssistantMessage(assistantMessage);
    this.deps.streamController.showThinkingIndicator();
  }

  private shouldDiscardPendingAssistantPlaceholder(message: ChatMessage | null): boolean {
    return this.awaitingProviderAssistantStart
      && !!message
      && !message.content.trim()
      && (message.toolCalls?.length ?? 0) === 0
      && (message.contentBlocks?.length ?? 0) === 0;
  }

  private discardStreamingAssistantMessage(messageId: string): void {
    const { state, renderer } = this.deps;
    state.messages = state.messages.filter((message) => message.id !== messageId);
    renderer.removeMessage(messageId);
    state.currentContentEl = null;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
  }

  // ============================================
  // Title Generation
  // ============================================

  /**
   * Triggers AI title generation after first user message.
   * Handles setting fallback title, firing async generation, and updating UI.
   */
  private async triggerTitleGeneration(): Promise<void> {
    const { plugin, state, conversationController } = this.deps;

    if (state.messages.length !== 1) {
      return;
    }

    if (!state.currentConversationId) {
      const sessionId = this.getAgentService()?.getSessionId() ?? undefined;
      const conversation = await plugin.createConversation({
        providerId: this.getActiveProviderId(),
        sessionId,
      });
      state.currentConversationId = conversation.id;
    }

    // Find first user message by role (not by index)
    const firstUserMsg = state.messages.find(m => m.role === 'user');

    if (!firstUserMsg) {
      return;
    }

    const userContent = firstUserMsg.displayContent || firstUserMsg.content;

    // Set immediate fallback title
    const fallbackTitle = conversationController.generateFallbackTitle(userContent);
    await plugin.renameConversation(state.currentConversationId, fallbackTitle);

    if (!plugin.settings.enableAutoTitleGeneration) {
      return;
    }

    // Fire async AI title generation only if service available
    const titleService = this.deps.getTitleGenerationService();
    if (!titleService) {
      // No titleService, just keep the fallback title with no status
      return;
    }

    // Mark as pending only when we're actually starting generation
    await plugin.updateConversation(state.currentConversationId, { titleGenerationStatus: 'pending' });
    conversationController.updateHistoryDropdown();

    const convId = state.currentConversationId;
    const expectedTitle = fallbackTitle; // Store to check if user renamed during generation

    titleService.generateTitle(
      convId,
      userContent,
      async (conversationId, result) => {
        // Check if conversation still exists and user hasn't manually renamed
        const currentConv = await plugin.getConversationById(conversationId);
        if (!currentConv) return;

        // Only apply AI title if user hasn't manually renamed (title still matches fallback)
        const userManuallyRenamed = currentConv.title !== expectedTitle;

        if (result.success && !userManuallyRenamed) {
          await plugin.renameConversation(conversationId, result.title);
          await plugin.updateConversation(conversationId, { titleGenerationStatus: 'success' });
        } else if (!userManuallyRenamed) {
          // Keep fallback title, mark as failed (only if user hasn't renamed)
          await plugin.updateConversation(conversationId, { titleGenerationStatus: 'failed' });
        } else {
          // User manually renamed, clear the status (user's choice takes precedence)
          await plugin.updateConversation(conversationId, { titleGenerationStatus: undefined });
        }
        conversationController.updateHistoryDropdown();
      }
    ).catch(() => {
      // Silently ignore title generation errors
    });
  }

  // ============================================
  // Streaming Control
  // ============================================

  cancelStreaming(): void {
    const { state, streamController } = this.deps;
    if (!state.isStreaming) return;
    state.cancelRequested = true;
    // Settle any pending render flush now (fix 3): the generator's finalize
    // must not hang on a render promise for a turn the user just cancelled.
    streamController.invalidateRenderFlush?.();
    // Restore queued message to input instead of discarding
    this.restorePendingMessagesToInput();
    this.getAgentService()?.cancel();
    streamController.hideThinkingIndicator();
  }

  private syncScrollToBottomAfterRenderUpdates(): void {
    const { plugin, state } = this.deps;
    if (!(plugin.settings.enableAutoScroll ?? true)) return;
    if (!state.autoScrollEnabled) return;

    requestAnimationFrame(() => {
      if (!(this.deps.plugin.settings.enableAutoScroll ?? true)) return;
      if (!this.deps.state.autoScrollEnabled) return;

      const messagesEl = this.deps.getMessagesEl();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ============================================
  // Instruction Mode
  // ============================================

  async handleInstructionSubmit(rawInstruction: string): Promise<void> {
    const { plugin } = this.deps;

    const instructionRefineService = this.deps.getInstructionRefineService();
    const instructionModeManager = this.deps.getInstructionModeManager();

    if (!instructionRefineService) return;

    const existingPrompt = plugin.settings.systemPrompt;
    let modal: InstructionModal | null = null;
    let wasCancelled = false;

    try {
      modal = new InstructionModal(
        plugin.app,
        rawInstruction,
        {
          onAccept: async (finalInstruction) => {
            const currentPrompt = plugin.settings.systemPrompt;
            plugin.settings.systemPrompt = appendMarkdownSnippet(currentPrompt, finalInstruction);
            await plugin.saveSettings();

            new Notice(t('chat.instruction.added'));
            instructionModeManager?.clear();
          },
          onReject: () => {
            wasCancelled = true;
            instructionRefineService.cancel();
            instructionModeManager?.clear();
          },
          onClarificationSubmit: async (response) => {
            this.syncInstructionRefineModelOverride(instructionRefineService);
            const result = await instructionRefineService.continueConversation(response);

            if (wasCancelled) {
              return;
            }

            if (!result.success) {
              if (result.error === 'Cancelled') {
                return;
              }
              new Notice(result.error || t('chat.instruction.processFailed'));
              modal?.showError(result.error || t('chat.instruction.processFailed'));
              return;
            }

            if (result.clarification) {
              modal?.showClarification(result.clarification);
            } else if (result.refinedInstruction) {
              modal?.showConfirmation(result.refinedInstruction);
            }
          }
        }
      );
      modal.open();

      this.syncInstructionRefineModelOverride(instructionRefineService);
      instructionRefineService.resetConversation();
      const result = await instructionRefineService.refineInstruction(
        rawInstruction,
        existingPrompt
      );

      if (wasCancelled) {
        return;
      }

      if (!result.success) {
        if (result.error === 'Cancelled') {
          instructionModeManager?.clear();
          return;
        }
        new Notice(result.error || t('chat.instruction.refineFailed'));
        modal.showError(result.error || t('chat.instruction.refineFailed'));
        instructionModeManager?.clear();
        return;
      }

      if (result.clarification) {
        modal.showClarification(result.clarification);
      } else if (result.refinedInstruction) {
        modal.showConfirmation(result.refinedInstruction);
      } else {
        new Notice(t('chat.instruction.noneReceived'));
        modal.showError(t('chat.instruction.noneReceived'));
        instructionModeManager?.clear();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      new Notice(t('chat.input.errorNotice', { error: errorMsg }));
      modal?.showError(errorMsg);
      instructionModeManager?.clear();
    }
  }

  // ============================================
  // Approval Dialogs
  // ============================================

  async handleApprovalRequest(
    toolName: string,
    _input: Record<string, unknown>,
    description: string,
    approvalOptions?: ApprovalCallbackOptions,
  ): Promise<ApprovalDecision> {
    const inputContainerEl = this.deps.getInputContainerEl();
    const parentEl = inputContainerEl.parentElement;
    if (!parentEl) {
      throw new Error('Input container is detached from DOM');
    }

    // Build header element, then detach — InlineAskUserQuestion will re-attach it
    const headerEl = parentEl.createDiv({ cls: 'claudian-ask-approval-info' });
    headerEl.remove();

    const toolEl = headerEl.createDiv({ cls: 'claudian-ask-approval-tool' });
    const iconEl = toolEl.createSpan({ cls: 'claudian-ask-approval-icon' });
    iconEl.setAttribute('aria-hidden', 'true');
    setToolIcon(iconEl, toolName);
    toolEl.createSpan({ text: toolName, cls: 'claudian-ask-approval-tool-name' });

    if (approvalOptions?.decisionReason) {
      headerEl.createDiv({ text: approvalOptions.decisionReason, cls: 'claudian-ask-approval-reason' });
    }
    if (approvalOptions?.blockedPath) {
      headerEl.createDiv({ text: approvalOptions.blockedPath, cls: 'claudian-ask-approval-blocked-path' });
    }
    if (approvalOptions?.agentID) {
      headerEl.createDiv({ text: t('chat.approval.agentLabel', { id: approvalOptions.agentID }), cls: 'claudian-ask-approval-agent' });
    }

    headerEl.createDiv({ text: description, cls: 'claudian-ask-approval-desc' });

    const decisionOptions = approvalOptions?.decisionOptions ?? DEFAULT_APPROVAL_DECISION_OPTIONS;
    const optionDecisionMap = new Map<string, ApprovalDecision>();
    const questionOptions = decisionOptions.map((option, index) => {
      const value = option.value || `approval-option-${index}`;
      if (option.decision) {
        optionDecisionMap.set(value, option.decision);
      }
      return {
        label: option.label,
        description: option.description ?? '',
        value,
      };
    });
    const input = {
      questions: [{
        question: 'Allow this action?',
        options: questionOptions,
        isOther: false,
        isSecret: false,
      }],
    };

    const result = await this.showInlineQuestion(
      parentEl,
      inputContainerEl,
      input,
      (inline) => { this.pendingApprovalInline = inline; },
      undefined,
      { title: 'Permission required', headerEl, showCustomInput: false, immediateSelect: true },
    );

    if (!result) return 'cancel';
    const selected = Object.values(result)[0];
    const selectedValue = Array.isArray(selected) ? selected[0] : selected;
    if (typeof selectedValue !== 'string') {
      new Notice(t('chat.approval.unexpectedSelection', { value: String(selectedValue) }));
      return 'cancel';
    }

    const decision = optionDecisionMap.get(selectedValue);
    if (decision) {
      return decision;
    }

    return {
      type: 'select-option',
      value: selectedValue,
    };
  }

  async handleAskUserQuestion(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, string | string[]> | null> {
    const inputContainerEl = this.deps.getInputContainerEl();
    const parentEl = inputContainerEl.parentElement;
    if (!parentEl) {
      throw new Error('Input container is detached from DOM');
    }

    const askPromise = this.showInlineQuestion(
      parentEl,
      inputContainerEl,
      input,
      (inline) => { this.pendingAskInline = inline; },
      signal,
    );

    // Auto turns (task-notification continuations, peer-forwarded runs) have
    // no guaranteed attending user, so their pending canUseTool promise must
    // stay bounded — 2.5.1 F2 bounded it to zero by denying before any UI.
    // Plan A: render the card anyway (the attention callback notifies the
    // background tab; on the active tab the card is directly visible), then
    // fall back to the same deny+interrupt protection after a 5-minute
    // window, with a visible notice. The lease is exclusive, so its kind
    // still attributes the ask reliably; user turns keep the unbounded path.
    if (this.getTurnCoordinator()?.getActiveTurn()?.kind !== 'auto') {
      this.armAskRelay(askPromise, input);
      return askPromise;
    }

    return this.raceAutoTurnAskTimeout(askPromise, parentEl);
  }

  /**
   * Channel B for user-turn asks (fe case: user leaves the desk, the card
   * waits forever and CLI-queued messages never dequeue). Arms the relay
   * file protocol next to the desktop card — first answer wins via the
   * InlineAskUserQuestion resolved guard. Replies never travel through the
   * message queue: while the ask is pending, queue messages are not consumed
   * as answers (2026-09-23 fe transcript).
   *
   * Fail-safe end to end: the relay is a bypass channel, so any failure while
   * arming (read-only vault, full disk, broken deps) degrades to "no relay
   * this turn" — it must never propagate into handleAskUserQuestion where the
   * catch-all would deny+interrupt and kill the user's turn.
   */
  private armAskRelay(
    askPromise: Promise<Record<string, string | string[]> | null>,
    input: Record<string, unknown>,
  ): void {
    try {
      const relay = this.deps.getAskRelay?.() ?? null;
      const sessionId = this.getAgentService()?.getSessionId() ?? null;
      if (!relay || !sessionId) return;

      const conversationId = this.deps.state.currentConversationId;
      const conversation = conversationId
        ? this.deps.plugin.getConversationSync(conversationId)
        : null;

      // Same one-shot race shape as raceAutoTurnAskTimeout: any settle (answer,
      // ESC, abort, dismiss) or relay invalidation (5 nonce failures) clears
      // the timer; the timer against an already-settled ask is a no-op.
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cancelNotification = () => {
        settled = true;
        if (timer) clearTimeout(timer);
      };

      const pending = relay.armFor(
        {
          turnKind: 'user',
          sessionId,
          sessionName: conversation?.title ?? '',
          input,
        },
        (answers) => {
          // dispose first, synchronously: the askPromise settle → dispose path
          // runs on a microtask, and a same-tick poll tick must not race it.
          relay.dispose();
          this.pendingAskInline?.resolveExternal(answers);
        },
        // Relay channel voided by nonce failures: the nonce in the pending
        // info is dead — a notification carrying it would mislead the user.
        cancelNotification,
      );
      if (!pending) return;

      timer = setTimeout(() => {
        if (!settled) {
          this.deps.onAskAttentionTimeout?.(pending);
        }
      }, USER_ASK_ATTENTION_TIMEOUT_MS);
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer!);
        relay.dispose();
      };
      askPromise.then(settle, settle);
    } catch (error) {
      console.warn('[Claudian] ask relay arm failed; continuing without relay', error);
    }
  }

  /**
   * Plan A bound for auto-turn asks: settle deny (null → ClaudeApprovalHandler
   * deny+interrupt) if the card goes unanswered past the window. The settled
   * flag makes the race one-shot — an answer, ESC, signal abort, or dismiss
   * that settles the ask first cancels the timer, and a late timer against an
   * already-settled ask (turn ended by another path) is a no-op.
   */
  private raceAutoTurnAskTimeout(
    askPromise: Promise<Record<string, string | string[]> | null>,
    parentEl: HTMLElement,
  ): Promise<Record<string, string | string[]> | null> {
    return new Promise<Record<string, string | string[]> | null>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          // destroy() is idempotent (InlineAskUserQuestion.resolved guard):
          // when the ask settled in the same tick this is already a no-op.
          this.pendingAskInline?.destroy();
          parentEl.createDiv({
            cls: 'claudian-ask-timeout-notice',
            text: t('chat.ask.autoTurnTimeout'),
          });
          resolve(null);
        });
      }, AUTO_TURN_ASK_TIMEOUT_MS);
      askPromise.then(
        (result) => settle(() => resolve(result)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  private showInlineQuestion(
    parentEl: HTMLElement,
    inputContainerEl: HTMLElement,
    input: Record<string, unknown>,
    setPending: (inline: InlineAskUserQuestion | null) => void,
    signal?: AbortSignal,
    config?: InlineAskQuestionConfig,
  ): Promise<Record<string, string | string[]> | null> {
    this.deps.streamController.hideThinkingIndicator();
    this.hideInputContainer(inputContainerEl);

    return new Promise<Record<string, string | string[]> | null>((resolve, reject) => {
      const inline = new InlineAskUserQuestion(
        parentEl,
        input,
        (result: Record<string, string | string[]> | null) => {
          setPending(null);
          this.restoreInputContainer(inputContainerEl);
          resolve(result);
        },
        signal,
        config,
      );
      setPending(inline);
      try {
        inline.render();
      } catch (err) {
        setPending(null);
        this.restoreInputContainer(inputContainerEl);
        reject(err);
      }
    });
  }

  async handleExitPlanMode(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ExitPlanModeDecision | null> {
    const { state, streamController } = this.deps;
    const inputContainerEl = this.deps.getInputContainerEl();
    const parentEl = inputContainerEl.parentElement;
    if (!parentEl) {
      throw new Error('Input container is detached from DOM');
    }

    streamController.hideThinkingIndicator();
    this.hideInputContainer(inputContainerEl);

    const enrichedInput = state.planFilePath
      ? { ...input, planFilePath: state.planFilePath }
      : input;

    const renderContent = (el: HTMLElement, markdown: string) =>
      this.deps.renderer.renderContent(el, markdown);

    const planPathPrefix = this.getActiveCapabilities().planPathPrefix;

    return new Promise<ExitPlanModeDecision | null>((resolve, reject) => {
      const inline = new InlineExitPlanMode(
        parentEl,
        enrichedInput,
        (decision: ExitPlanModeDecision | null) => {
          this.pendingExitPlanModeInline = null;
          this.restoreInputContainer(inputContainerEl);
          resolve(decision);
        },
        signal,
        renderContent,
        planPathPrefix,
      );
      this.pendingExitPlanModeInline = inline;
      try {
        inline.render();
      } catch (err) {
        this.pendingExitPlanModeInline = null;
        this.restoreInputContainer(inputContainerEl);
        reject(err);
      }
    });
  }

  dismissPendingApprovalPrompt(): void {
    if (this.pendingApprovalInline) {
      this.pendingApprovalInline.destroy();
      this.pendingApprovalInline = null;
    }
    // 2.5.1 F1: the pending ask's unresolved promise is the only thing keeping
    // the SDK's canUseTool (and with it the whole turn) blocked — a cancel path
    // that skips it leaves the CLI waiting on control_response forever
    // (2026-09-17 e000fea0: auto lease stuck, isStreaming never cleared).
    // destroy() resolves the promise with null → deny+interrupt → CLI unblocks.
    if (this.pendingAskInline) {
      this.pendingAskInline.destroy();
      this.pendingAskInline = null;
    }
    // 2.5.1 F1b (same family): an exit-plan-mode card left pending here keeps
    // canUseTool blocked the same way — destroy() resolves the decision with
    // null → deny+interrupt ('User cancelled.') → CLI unblocks.
    if (this.pendingExitPlanModeInline) {
      this.pendingExitPlanModeInline.destroy();
      this.pendingExitPlanModeInline = null;
    }
  }

  dismissPendingApproval(): void {
    this.dismissPendingApprovalPrompt();
    this.dismissPendingPlanApproval(true);
    this.resetInputContainerVisibility();
  }

  private showPlanApproval(): Promise<{ decision: PlanApprovalDecision | null; invalidated: boolean }> {
    const inputContainerEl = this.deps.getInputContainerEl();
    const parentEl = inputContainerEl.parentElement;
    if (!parentEl) {
      return Promise.resolve({ decision: null, invalidated: false });
    }

    this.hideInputContainer(inputContainerEl);
    this.pendingPlanApprovalInvalidated = false;

    return new Promise<{ decision: PlanApprovalDecision | null; invalidated: boolean }>((resolve, reject) => {
      const inline = new InlinePlanApproval(
        parentEl,
        (decision: PlanApprovalDecision | null) => {
          const invalidated = this.pendingPlanApprovalInvalidated;
          this.pendingPlanApprovalInvalidated = false;
          this.pendingPlanApproval = null;
          this.restoreInputContainer(inputContainerEl);
          resolve({ decision, invalidated });
        },
      );
      this.pendingPlanApproval = inline;
      try {
        inline.render();
      } catch (err) {
        this.pendingPlanApproval = null;
        this.pendingPlanApprovalInvalidated = false;
        this.restoreInputContainer(inputContainerEl);
        reject(err);
      }
    });
  }

  private dismissPendingPlanApproval(invalidated: boolean): void {
    if (!this.pendingPlanApproval) {
      return;
    }

    if (invalidated) {
      this.pendingPlanApprovalInvalidated = true;
    }
    this.pendingPlanApproval.destroy();
    this.pendingPlanApproval = null;
  }

  private hideInputContainer(inputContainerEl: HTMLElement): void {
    this.inputContainerHideDepth++;
    inputContainerEl.style.display = 'none';
  }

  private restoreInputContainer(inputContainerEl: HTMLElement): void {
    if (this.inputContainerHideDepth <= 0) return;
    this.inputContainerHideDepth--;
    if (this.inputContainerHideDepth === 0) {
      inputContainerEl.style.display = '';
    }
  }

  private resetInputContainerVisibility(): void {
    if (this.inputContainerHideDepth > 0) {
      this.inputContainerHideDepth = 0;
      this.deps.getInputContainerEl().style.display = '';
    }
  }

  // ============================================
  // Built-in Commands
  // ============================================

  private async executeBuiltInCommand(command: BuiltInCommand, args: string): Promise<void> {
    const { conversationController } = this.deps;
    const capabilities = this.getActiveCapabilities();

    if (!isBuiltInCommandSupported(command, capabilities)) {
      new Notice(t('chat.commands.unsupportedProvider', { command: command.name }));
      return;
    }

    switch (command.action) {
      case 'clear':
        await conversationController.createNew();
        break;
      case 'add-dir': {
        const externalContextSelector = this.deps.getExternalContextSelector();
        if (!externalContextSelector) {
          new Notice(t('chat.commands.externalContextUnavailable'));
          return;
        }
        const result = externalContextSelector.addExternalContext(args);
        if (result.success) {
          new Notice(t('chat.commands.externalContextAdded', { path: result.normalizedPath }));
        } else {
          new Notice(result.error);
        }
        break;
      }
      case 'resume':
        this.showResumeDropdown();
        break;
      case 'fork': {
        if (!this.getActiveCapabilities().supportsFork) {
          new Notice(t('chat.fork.unsupportedProvider'));
          return;
        }
        if (!this.deps.onForkAll) {
          new Notice(t('chat.fork.unavailable'));
          return;
        }
        await this.deps.onForkAll();
        break;
      }
      default:
        // Unknown command - notify user
        new Notice(t('chat.commands.unknown', { action: command.action }));
    }
  }

  // ============================================
  // Resume Session Dropdown
  // ============================================

  handleResumeKeydown(e: KeyboardEvent): boolean {
    if (!this.activeResumeDropdown?.isVisible()) return false;
    return this.activeResumeDropdown.handleKeydown(e);
  }

  isResumeDropdownVisible(): boolean {
    return this.activeResumeDropdown?.isVisible() ?? false;
  }

  destroyResumeDropdown(): void {
    if (this.activeResumeDropdown) {
      this.activeResumeDropdown.destroy();
      this.activeResumeDropdown = null;
    }
  }

  private showResumeDropdown(): void {
    const { plugin, state } = this.deps;

    // Clean up any existing dropdown
    this.destroyResumeDropdown();

    const conversations = plugin.getConversationList();
    if (conversations.length === 0) {
      new Notice(t('chat.resume.noConversations'));
      return;
    }

    const openConversation = this.deps.openConversation;
    if (!openConversation) return;

    this.activeResumeDropdown = new ResumeSessionDropdown(
      this.deps.getInputContainerEl(),
      this.deps.getInputEl(),
      conversations,
      state.currentConversationId,
      {
        onSelect: (id) => {
          this.destroyResumeDropdown();
          openConversation(id).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(t('chat.resume.openFailed', { error: msg }));
          });
        },
        onDismiss: () => {
          this.destroyResumeDropdown();
        },
      }
    );
  }
}
