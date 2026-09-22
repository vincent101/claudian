import type {
  AutoTurnCancelledEvent,
  AutoTurnChunkEvent,
  AutoTurnDiagnosticEvent,
  AutoTurnFinishedEvent,
  AutoTurnStartedEvent,
} from '../../../core/runtime/types';
import type { ChatMessage } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type { HistoryWindowRenderer } from '../rendering/HistoryWindowRenderer';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { ProjectionWriteLease } from '../rendering/ProjectionWriteCoordinator';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { CompletedTurnEvent } from '../tabs/types';
import type { ConversationController } from './ConversationController';
import {
  createTurnProjectionContext,
  type StreamController,
  type TurnProjectionContext,
} from './StreamController';
import type { TurnCoordinator } from './TurnCoordinator';

// Initial values conservatively exceed measured 1–16 ms callback ticks; calibrate from smoke-test percentiles.
const CALLBACK_CHUNK_TIMEOUT_MS = 1_000;
const CALLBACK_FINALIZE_TIMEOUT_MS = 3_000;
// 30 s instead of a tighter bound: a slow disk or a held file lock must not
// abort a save that would still land, and the timeout only gates the auto
// turn's settlement — the save promise itself keeps running either way.
const CALLBACK_SAVE_TIMEOUT_MS = 30_000;

interface AutoTurnProjectionControllerDeps {
  state: ChatState;
  renderer: MessageRenderer;
  streamController: StreamController;
  conversationController: ConversationController;
  turnCoordinator: TurnCoordinator;
  subagentManager: SubagentManager;
  getConversationId: () => string | null;
  isTabConnected: () => boolean;
  generateId: () => string;
  notify: (message: string) => void;
  recordDiagnostic?: (event: AutoTurnDiagnosticEvent) => void;
  /**
   * Per-tab projection write lease (coord protocol P1/P2). The auto turn's
   * message mount acquires the live lease FIFO-queued behind any stored
   * transaction; absent in legacy tests → mounts synchronously like before.
   */
  getProjectionCoordinator?: () => {
    acquireLive: (isCancelled?: () => boolean) => Promise<ProjectionWriteLease | null>;
    runStored: <T>(isCancelled: () => boolean, task: () => Promise<T>) => Promise<T | null>;
  } | null;
  getHistoryWindowRenderer?: () => HistoryWindowRenderer | null;
  /** Updates the tab's welcome element reference after a full re-projection. */
  setWelcomeEl?: (el: HTMLElement | null) => void;
  /**
   * Successful auto-turn completion signal: fired once per turn, only after
   * finalization and the final projection settled. Notification policy reads
   * this, never the UI busy state.
   */
  onTurnCompleted?: (event: CompletedTurnEvent) => void;
}

interface AutoProjection {
  turnId: string;
  generation: number;
  conversationId: string | null;
  assistantMessage: ChatMessage;
  pageMessages: ChatMessage[];
  context: TurnProjectionContext;
  /**
   * Live-lease-gated mount state (P2): the user/assistant DOM pair only
   * mounts once the projection write lease is granted. `mountTask` settles
   * even when the wait is cancelled (then `mounted` stays false).
   */
  mounted: boolean;
  mountTask: Promise<void> | null;
  liveLease: ProjectionWriteLease | null;
  /** Chunks that arrived before the mount; replayed in order right after it. */
  pendingChunks: AutoTurnChunkEvent[];
  /** Replay chunks already projected in this projection, keyed by transcript identity. */
  replaySeenIdentities: Set<string>;
  /**
   * How far the replay text chunks have been reconciled against the hydrated
   * message content (which carries no transcript identity). Hydrated text is
   * always a prefix of the replay stream, so alignment at block boundaries is
   * exact — unlike a substring match, which also drops new blocks that happen
   * to be substrings of hydrated content.
   */
  replayTextCursor: number;
}

export class AutoTurnProjectionController {
  private active: AutoProjection | null = null;
  /**
   * Conversations whose save-timeout notice has already been shown, cleared
   * by the next successful save: a persistently slow disk must re-notify at
   * most once per conversation per failure episode, not on every message.
   */
  private readonly saveTimeoutNoticeShownFor = new Set<string>();

  constructor(private readonly deps: AutoTurnProjectionControllerDeps) {}

  started(event: AutoTurnStartedEvent): boolean {
    if (!this.deps.turnCoordinator.beginAutoTurn(event.turnId, event.generation)) return false;
    this.deps.recordDiagnostic?.({ phase: 'lease_begin', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
    if (!this.deps.isTabConnected()) {
      this.deps.turnCoordinator.finish(event.turnId);
      return false;
    }

    this.deps.streamController.beginRenderFlushScope();
    this.deps.subagentManager.resetSpawnedCount();
    this.deps.state.ignoreUsageUpdates = false;
    this.deps.state.autoScrollEnabled = true;

    const existingUserIndex = event.transcriptUserId
      ? this.deps.state.messages.findIndex(message => message.userMessageId === event.transcriptUserId)
      : -1;
    let pendingUserMessage: ChatMessage | null = null;
    if (event.displayContent && existingUserIndex < 0) {
      const label = this.sourceLabel(event);
      const userMessage: ChatMessage = {
        id: this.deps.generateId(),
        role: 'user',
        content: event.displayContent,
        displayContent: label ? `${label}\n\n${event.displayContent}` : event.displayContent,
        timestamp: Date.now(),
        userMessageId: event.transcriptUserId,
      };
      // Domain truth is immediate; the DOM mount is gated by the live lease.
      this.deps.state.addMessage(userMessage);
      pendingUserMessage = userMessage;
    }

    const existingAssistant = event.replay && existingUserIndex >= 0
      ? this.deps.state.messages.slice(existingUserIndex + 1).find(message => message.role === 'assistant')
      : undefined;
    const assistantMessage: ChatMessage = existingAssistant ?? {
      id: this.deps.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      contentBlocks: [],
    };
    if (!existingAssistant) this.deps.state.addMessage(assistantMessage);
    const liveRoot = this.deps.getHistoryWindowRenderer?.()?.beginLivePage(
      `live:${event.turnId}`,
      [pendingUserMessage, assistantMessage].filter((message): message is ChatMessage => message !== null),
      this.deps.state.historyLease?.totalTurns ?? this.deps.state.loadedRanges.at(-1)?.end ?? 0,
    );
    if (liveRoot) this.deps.renderer.setMessagesEl(liveRoot);
    this.deps.state.currentContentEl = null;
    this.deps.state.currentTextEl = null;
    this.deps.state.currentTextContent = '';
    this.deps.state.currentThinkingState = null;
    this.deps.state.toolCallElements.clear();
    this.deps.state.responseStartTime = performance.now();
    this.deps.streamController.showThinkingIndicator(
      event.source.kind === 'notification-continuation' ? 'Background task continuing...' : 'Background activity...',
    );

    this.active = {
      turnId: event.turnId,
      generation: event.generation,
      conversationId: this.deps.getConversationId(),
      assistantMessage,
      pageMessages: [pendingUserMessage, assistantMessage].filter((message): message is ChatMessage => message !== null),
      context: createTurnProjectionContext({
        turnId: event.turnId,
        message: assistantMessage,
        // Set at mount; chunks buffer until then.
        renderTarget: null,
        generation: event.generation,
        domEpoch: this.deps.renderer.domEpoch,
      }),
      mounted: false,
      mountTask: null,
      liveLease: null,
      pendingChunks: [],
      replaySeenIdentities: new Set(),
      replayTextCursor: 0,
    };
    this.mountUnderLiveLease(this.active, pendingUserMessage, existingAssistant !== undefined);
    return true;
  }

  /**
   * P2 live-lease mount: the user/assistant DOM pair may only mount once the
   * projection write lease is granted — FIFO behind any in-flight stored
   * transaction (search re-locate, paging) so the mount can neither interleave
   * with pending render frames nor be cleared by a clear-rebuild. Chunks that
   * arrive before the grant are buffered raw and replayed through the normal
   * chunk path right after the mount, so domain projection and replay dedup
   * stay exactly as they are post-mount. Lock order is unchanged: the
   * business turn lease is already held when the live lease is requested.
   */
  private mountUnderLiveLease(
    active: AutoProjection,
    userMessage: ChatMessage | null,
    hasExistingAssistant: boolean,
  ): void {
    const coordinator = this.deps.getProjectionCoordinator?.() ?? null;
    if (!coordinator) {
      this.mountLive(active, userMessage, hasExistingAssistant);
      return;
    }
    active.mountTask = (async () => {
      try {
        const lease = await coordinator.acquireLive(() => !this.isCurrent(active, active.turnId, active.generation));
        if (!lease) return;
        if (!this.isCurrent(active, active.turnId, active.generation)) {
          lease.release();
          return;
        }
        active.liveLease = lease;
        this.mountLive(active, userMessage, hasExistingAssistant);
        const buffered = active.pendingChunks;
        active.pendingChunks = [];
        for (const bufferedEvent of buffered) {
          if (this.active !== active) return;
          await this.chunk(bufferedEvent);
        }
      } catch {
        // The mount is fire-and-forget from the synchronous started()
        // contract: a failure must not surface as an unhandled rejection.
        // Abort like a failing chunk so the lease settles through the
        // standard cancel path and finished() sees a dead projection.
        this.abortActive(active.turnId, active.generation);
      }
    })();
  }

  private mountLive(
    active: AutoProjection,
    userMessage: ChatMessage | null,
    hasExistingAssistant: boolean,
  ): void {
    if (userMessage) this.deps.renderer.addMessage(userMessage);
    let contentEl: HTMLElement | null = null;
    if (!hasExistingAssistant) {
      const messageEl = this.deps.renderer.addMessage(active.assistantMessage);
      contentEl = messageEl.querySelector('.claudian-message-content') as HTMLElement | null;
    }
    this.deps.state.currentContentEl = contentEl;
    active.context.renderTarget = contentEl;
    // The mount may land after a stored clear-rebuild bumped the epoch.
    active.context.domEpoch = this.deps.renderer.domEpoch;
    active.mounted = true;
  }

  async chunk(event: AutoTurnChunkEvent): Promise<void> {
    const active = this.active;
    if (!active || !this.isCurrent(active, event.turnId, event.generation)) return;
    if (event.replay && this.isDuplicateReplayChunk(active, event)) return;
    if (!active.mounted) {
      // Pre-mount (live lease still queued behind a stored transaction):
      // buffer the raw event — replayed in order once the mount lands.
      active.pendingChunks.push(event);
      return;
    }
    await this.projectChunk(active, event);
  }

  private async projectChunk(active: AutoProjection, event: AutoTurnChunkEvent): Promise<void> {
    active.context.renderTarget = this.deps.state.currentContentEl;
    try {
      await this.withTimeout(
        this.deps.streamController.handleStreamChunk(event.chunk, active.context),
        CALLBACK_CHUNK_TIMEOUT_MS,
        'chunk_timeout',
      );
    } catch (error) {
      this.abortActive(event.turnId, event.generation);
      throw error;
    }
    if (event.replay) {
      if (event.transcriptIdentity) active.replaySeenIdentities.add(event.transcriptIdentity);
      if (event.chunk.type === 'text') {
        active.replayTextCursor = active.assistantMessage.content.length;
      }
    }
  }

  /**
   * Replay dedup (v6 §4.3 "已有不重复，仅补缺项"): first by transcript identity
   * (exact, idempotent), then by reconciling the hydrated message content,
   * which carries no identity. Text reconciles block-by-block against the
   * projected prefix; thinking and tool blocks keep exact matches (thinking
   * content equality, tool id).
   */
  async projectEmbeddedExternal(event: AutoTurnStartedEvent): Promise<void> {
    if (!event.displayContent || !event.transcriptUserId || !this.deps.isTabConnected()) return;
    if (this.deps.state.messages.some(message => message.userMessageId === event.transcriptUserId)) return;
    let assistantIndex = -1;
    for (let index = this.deps.state.messages.length - 1; index >= 0; index -= 1) {
      if (this.deps.state.messages[index].role === 'assistant') {
        assistantIndex = index;
        break;
      }
    }
    if (assistantIndex < 0) return;
    const label = this.sourceLabel(event);
    const userMessage: ChatMessage = {
      id: this.deps.generateId(),
      role: 'user',
      content: event.displayContent,
      displayContent: label ? `${label}\n\n${event.displayContent}` : event.displayContent,
      timestamp: Date.now(),
      userMessageId: event.transcriptUserId,
    };
    const messages = this.deps.state.messages;
    messages.splice(assistantIndex, 0, userMessage);
    this.deps.state.messages = messages;
    const assistantMessage = messages[assistantIndex + 1];
    const messageEl = this.deps.renderer.addMessage(userMessage);
    const assistantEl = messageEl.parentElement?.querySelector(
      `[data-message-id="${assistantMessage.id}"]`,
    );
    if (assistantEl && messageEl.parentElement) messageEl.parentElement.insertBefore(messageEl, assistantEl);
  }

  private isDuplicateReplayChunk(active: AutoProjection, event: AutoTurnChunkEvent): boolean {
    if (event.transcriptIdentity && active.replaySeenIdentities.has(event.transcriptIdentity)) {
      return true;
    }
    const chunk = event.chunk;
    if (chunk.type === 'text') {
      if (active.assistantMessage.content.startsWith(chunk.content, active.replayTextCursor)) {
        active.replayTextCursor += chunk.content.length;
        return true;
      }
      return false;
    }
    if (chunk.type === 'thinking') {
      return active.assistantMessage.contentBlocks?.some(
        block => block.type === 'thinking' && block.content === chunk.content,
      ) ?? false;
    }
    if (chunk.type === 'tool_use' || chunk.type === 'tool_result') {
      return active.assistantMessage.toolCalls?.some(tool => tool.id === chunk.id) ?? false;
    }
    return false;
  }

  async finished(event: AutoTurnFinishedEvent): Promise<void> {
    const active = this.active;
    if (!active || !this.isCurrent(active, event.turnId, event.generation)) return;

    let completionError: unknown = null;
    let timedOut = false;
    // Completion gate: only turns whose finalization actually succeeded may
    // emit the completion event (save failures do not affect this flag).
    let finalizedCleanly = false;
    this.deps.recordDiagnostic?.({ phase: 'render_start', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
    try {
      // A deferred mount (queued behind a stored transaction) must land and
      // replay its buffered chunks before the finalize, or the buffered
      // output never reaches the projection.
      if (active.mountTask) await active.mountTask;
      if (!this.isCurrent(active, event.turnId, event.generation)) return;
      active.assistantMessage.assistantMessageId =
        event.metadata.assistantMessageId ?? active.assistantMessage.assistantMessageId;
      this.deps.streamController.hideThinkingIndicator();
      await this.withTimeout(
        this.deps.streamController.finalizeCurrentThinkingBlock(active.assistantMessage, active.context),
        CALLBACK_FINALIZE_TIMEOUT_MS,
        'finalize_timeout',
      );
      await this.withTimeout(
        this.deps.streamController.finalizeCurrentTextBlock(active.assistantMessage, active.context),
        CALLBACK_FINALIZE_TIMEOUT_MS,
        'finalize_timeout',
      );
      finalizedCleanly = true;
      this.deps.recordDiagnostic?.({ phase: 'render_end', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
      this.deps.state.hasPendingConversationSave = true;
      this.deps.recordDiagnostic?.({ phase: 'save_start', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
      const savePromise = this.deps.conversationController.save(true);
      void savePromise.catch(() => {});
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          savePromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('save_timeout')), CALLBACK_SAVE_TIMEOUT_MS);
          }),
        ]);
        // A successful save proves the save path works again — re-arm the
        // timeout notice for every conversation.
        this.saveTimeoutNoticeShownFor.clear();
        this.deps.recordDiagnostic?.({ phase: 'save_end', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
      } catch (error) {
        completionError = error;
        timedOut = error instanceof Error && error.message === 'save_timeout';
        if (timedOut) {
          savePromise.finally(() => { this.deps.state.hasPendingConversationSave = true; }).catch(() => {});
          // The timed-out save may still land once the disk frees up; a late
          // success re-arms the notice just like a raced one.
          void savePromise.then(() => { this.saveTimeoutNoticeShownFor.clear(); }).catch(() => {});
        }
        this.deps.state.hasPendingConversationSave = true;
        this.deps.recordDiagnostic?.({
          phase: timedOut ? 'save_timeout' : 'callback_error',
          turnId: event.turnId,
          generation: event.generation,
          leaseKind: 'auto',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (error) {
      completionError ??= error;
      timedOut = error instanceof Error && error.message === 'finalize_timeout';
    } finally {
      if (timedOut) {
        this.abortActive(event.turnId, event.generation);
      } else {
        try {
          this.deps.streamController.resetStreamingState();
        } catch {
          // Lease release must survive cleanup failures.
        }
        // P5: the live lease releases BEFORE the stored reprojection is
        // queued — holding live while acquiring stored self-deadlocks the FIFO.
        this.releaseLiveLease(active);
        const historyWindowRenderer = this.deps.getHistoryWindowRenderer?.();
        historyWindowRenderer?.freezeLivePage(active.pageMessages);
        if (historyWindowRenderer) this.deps.renderer.setMessagesEl(historyWindowRenderer.getRoot());
        const reprojectionSettled = await this.reprojectIfDirty(active, event.turnId, event.generation);
        if (finalizedCleanly) this.refreshRewindButtonsForPrecedingUserTurn(active);
        this.active = null;
        this.deps.turnCoordinator.finish(event.turnId);
        this.deps.recordDiagnostic?.({ phase: 'lease_finish', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
        if (finalizedCleanly && reprojectionSettled && event.supersededByHostUser !== true) {
          // Emitted only after the final projection settled: save failures
          // still notify (the reply is visible), finalize failures never do.
          // Never emitted from TurnCoordinator.finish — that path also serves
          // cancellation and invalidation.
          this.deps.onTurnCompleted?.({ turnId: event.turnId, kind: 'auto', outcome: 'completed' });
        }
      }
    }
    if (completionError) {
      const saveTimedOut = completionError instanceof Error && completionError.message === 'save_timeout';
      try {
        if (saveTimedOut) {
          // Save timeout: localized one-shot notice per conversation until the
          // next successful save re-arms it. Keyed by the projection's
          // conversation — the one whose save timed out — not the tab's
          // current one, so a mid-save switch cannot mute the next episode.
          const conversationId = active.conversationId ?? '';
          if (!this.saveTimeoutNoticeShownFor.has(conversationId)) {
            this.deps.notify(t('chat.save.timeoutNotice'));
            // Marked after the notice call so a throwing Notice retries next turn.
            this.saveTimeoutNoticeShownFor.add(conversationId);
          }
        } else {
          this.deps.notify('Background response is visible but could not be saved. It will retry on the next conversation save.');
        }
      } catch {
        // Notice failures must not affect settlement.
      }
    }
  }

  /**
   * P5 turn-boundary re-projection: when the auto turn's mount was evicted
   * mid-turn, the streamed output stays invisible until the active projection
   * is rebuilt. Indexed tabs rebuild mounted pages; non-index providers retain
   * the legacy full render, mirroring the user-turn path
   * (InputController.sendMessage).
   *
   * Returns whether the final projection settled: nothing dirty to
   * re-project counts as success; stale, cancelled or failed re-projections
   * return false so the completion event is suppressed — the previous void
   * swallow could not distinguish these outcomes.
   */
  private async reprojectIfDirty(active: AutoProjection, turnId: string, generation: number): Promise<boolean> {
    if (!active.context.projectionDirty) return true;
    if (this.active !== active || !this.isCurrent(active, turnId, generation)) return false;
    const coordinator = this.deps.getProjectionCoordinator?.() ?? null;
    const reproject = async (): Promise<void> => {
      const windowRenderer = this.deps.getHistoryWindowRenderer?.();
      if (windowRenderer) {
        windowRenderer.rebuildMountedPages();
        return;
      }
      const welcomeEl = this.deps.renderer.renderMessages(
        this.deps.state.messages,
        () => this.deps.conversationController.getGreeting(),
      );
      this.deps.setWelcomeEl?.(welcomeEl);
      await this.deps.renderer.waitForRenderedMessages();
    };
    try {
      if (coordinator) {
        return (await coordinator.runStored(() => !this.isCurrent(active, turnId, generation), reproject)) !== null;
      }
      await reproject();
      return true;
    } catch {
      // Reprojection is a DOM repair; a failure must not break lease settlement.
      return false;
    }
  }

  /**
   * A user message whose rewind evaluation ran while this auto turn's user row
   * sat ahead of it loses its rewind button (findRewindContext stops at the
   * first user message and sees no response yet). Once the turn settles,
   * re-check the buttons on the nearest user message before this turn's
   * anchor. Idempotent: the renderer skips messages already carrying buttons
   * or ineligible; nothing to evaluate means no call.
   */
  private refreshRewindButtonsForPrecedingUserTurn(active: AutoProjection): void {
    const anchor = active.pageMessages.find(message => message.role === 'user') ?? active.assistantMessage;
    const anchorIndex = this.deps.state.messages.indexOf(anchor);
    if (anchorIndex < 0) return;
    for (let index = anchorIndex - 1; index >= 0; index -= 1) {
      const candidate = this.deps.state.messages[index];
      if (candidate.role === 'user') {
        this.deps.renderer.refreshActionButtons(candidate, this.deps.state.messages, index);
        return;
      }
    }
  }

  cancelled(event: AutoTurnCancelledEvent): void {
    const active = this.active;
    if (active && active.turnId === event.turnId) {
      this.deps.streamController.invalidateRenderFlush();
      this.deps.streamController.resetStreamingState();
      if (!active.assistantMessage.content && (active.assistantMessage.toolCalls?.length ?? 0) === 0) {
        this.deps.state.messages = this.deps.state.messages.filter(
          message => message.id !== active.assistantMessage.id,
        );
        this.deps.renderer.removeMessage(active.assistantMessage.id);
      }
      this.releaseLiveLease(active);
      this.active = null;
    }
    this.deps.turnCoordinator.cancelAutoTurn(event.turnId, event.generation);
  }

  invalidate(): void {
    this.deps.streamController.invalidateRenderFlush();
    if (this.active) this.releaseLiveLease(this.active);
    this.active = null;
  }

  private releaseLiveLease(active: AutoProjection): void {
    // Idempotent: the coordinator tolerates double release.
    active.liveLease?.release();
    active.liveLease = null;
  }

  private abortActive(turnId: string, generation: number): void {
    this.deps.streamController.invalidateRenderFlush();
    try {
      this.deps.streamController.resetStreamingState();
    } catch {
      // Lease cancellation must survive cleanup failures.
    }
    if (this.active && this.active.turnId === turnId) {
      this.releaseLiveLease(this.active);
      this.active = null;
    }
    this.deps.turnCoordinator.cancelAutoTurn(turnId, generation + 1);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
    void promise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isCurrent(active: AutoProjection, turnId: string, generation: number): boolean {
    return this.deps.isTabConnected()
      && active.turnId === turnId
      && active.generation === generation
      && active.conversationId === this.deps.getConversationId()
      && this.deps.turnCoordinator.isCurrentTurn(turnId, generation);
  }

  private sourceLabel(event: AutoTurnStartedEvent): string {
    switch (event.source.kind) {
      case 'peer':
        return event.source.label ? `Peer · ${event.source.label}` : 'Peer';
      case 'channel':
        return event.source.label ? `Channel · ${event.source.label}` : 'Channel';
      case 'coordinator':
        return 'Coordinator';
      default:
        return '';
    }
  }
}
