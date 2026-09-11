import type {
  AutoTurnCancelledEvent,
  AutoTurnChunkEvent,
  AutoTurnDiagnosticEvent,
  AutoTurnFinishedEvent,
  AutoTurnStartedEvent,
} from '../../../core/runtime/types';
import type { ChatMessage } from '../../../core/types';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { ConversationController } from './ConversationController';
import {
  createTurnProjectionContext,
  type StreamController,
  type TurnProjectionContext,
} from './StreamController';
import type { TurnCoordinator } from './TurnCoordinator';

const SAVE_SETTLE_TIMEOUT_MS = 5_000;

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
}

interface AutoProjection {
  turnId: string;
  generation: number;
  conversationId: string | null;
  assistantMessage: ChatMessage;
  context: TurnProjectionContext;
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
      this.deps.state.addMessage(userMessage);
      this.deps.renderer.addMessage(userMessage);
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
    const messageEl = existingAssistant
      ? { querySelector: () => null }
      : this.deps.renderer.addMessage(assistantMessage);
    const contentEl = messageEl.querySelector('.claudian-message-content') as HTMLElement | null;
    this.deps.state.currentContentEl = contentEl;
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
      context: createTurnProjectionContext({
        turnId: event.turnId,
        message: assistantMessage,
        renderTarget: contentEl,
        generation: event.generation,
      }),
      replaySeenIdentities: new Set(),
      replayTextCursor: 0,
    };
    return true;
  }

  async chunk(event: AutoTurnChunkEvent): Promise<void> {
    const active = this.active;
    if (!active || !this.isCurrent(active, event.turnId, event.generation)) return;
    if (event.replay && this.isDuplicateReplayChunk(active, event)) return;
    active.context.renderTarget = this.deps.state.currentContentEl;
    await this.deps.streamController.handleStreamChunk(event.chunk, active.context);
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
    this.deps.recordDiagnostic?.({ phase: 'render_start', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
    try {
      active.assistantMessage.assistantMessageId =
        event.metadata.assistantMessageId ?? active.assistantMessage.assistantMessageId;
      this.deps.streamController.hideThinkingIndicator();
      await this.deps.streamController.finalizeCurrentThinkingBlock(active.assistantMessage, active.context);
      await this.deps.streamController.finalizeCurrentTextBlock(active.assistantMessage, active.context);
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
            timeout = setTimeout(() => reject(new Error('save_timeout')), SAVE_SETTLE_TIMEOUT_MS);
          }),
        ]);
        this.deps.recordDiagnostic?.({ phase: 'save_end', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
      } catch (error) {
        completionError = error;
        const timedOut = error instanceof Error && error.message === 'save_timeout';
        if (timedOut) {
          savePromise.finally(() => { this.deps.state.hasPendingConversationSave = true; }).catch(() => {});
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
    } finally {
      try {
        this.deps.streamController.resetStreamingState();
      } catch {
        // Lease release must survive cleanup failures.
      }
      this.active = null;
      this.deps.turnCoordinator.finish(event.turnId);
      this.deps.recordDiagnostic?.({ phase: 'lease_finish', turnId: event.turnId, generation: event.generation, leaseKind: 'auto' });
    }
    if (completionError) {
      try {
        this.deps.notify('Background response is visible but could not be saved. It will retry on the next conversation save.');
      } catch {
        // Notice failures must not affect settlement.
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
      this.active = null;
    }
    this.deps.turnCoordinator.cancelAutoTurn(event.turnId, event.generation);
  }

  invalidate(): void {
    this.deps.streamController.invalidateRenderFlush();
    this.active = null;
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
