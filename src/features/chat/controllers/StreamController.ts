import { TFile } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import {
  DEFAULT_CHAT_PROVIDER_ID,
  type ProviderId,
  type ProviderSubagentLifecycleAdapter,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import { parseTodoInput } from '../../../core/tools/todo';
import { extractResolvedAnswers, extractResolvedAnswersFromResultText } from '../../../core/tools/toolInput';
import {
  isEditTool,
  isSubagentToolName,
  isWriteEditTool,
  skipsBlockedDetection,
  TOOL_AGENT_OUTPUT,
  TOOL_APPLY_PATCH,
  TOOL_ASK_USER_QUESTION,
  TOOL_TASK,
  TOOL_TODO_WRITE,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import type { ChatMessage, StreamChunk, SubagentInfo, ToolCallInfo } from '../../../core/types';
import type { SDKToolUseResult } from '../../../core/types/diff';
import type ClaudianPlugin from '../../../main';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';
import { formatDurationMmSs } from '../../../utils/date';
import { extractDiffData } from '../../../utils/diff';
import { hasStreamingMathDelimiters } from '../../../utils/markdownMath';
import { getVaultPath, normalizePathForVault } from '../../../utils/path';
import { FLAVOR_TEXTS } from '../constants';
import type { MessageRenderer, RenderContentOptions } from '../rendering/MessageRenderer';
import { resolveSubagentLifecycleAdapter } from '../rendering/subagentLifecycleResolution';
import {
  createSubagentBlock,
  finalizeSubagentBlock,
  type SubagentState,
} from '../rendering/SubagentRenderer';
import {
  createThinkingBlock,
  finalizeThinkingBlock,
} from '../rendering/ThinkingBlockRenderer';
import {
  getToolName,
  getToolSummary,
  isBlockedToolResult,
  renderToolCall,
  updateToolCallResult,
} from '../rendering/ToolCallRenderer';
import {
  createWriteEditBlock,
  finalizeWriteEditBlock,
  updateWriteEditWithDiff,
} from '../rendering/WriteEditRenderer';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { FileContextManager } from '../ui/FileContext';

export interface StreamControllerDeps {
  plugin: ClaudianPlugin;
  state: ChatState;
  renderer: MessageRenderer;
  subagentManager: SubagentManager;
  getMessagesEl: () => HTMLElement;
  getFileContextManager: () => FileContextManager | null;
  updateQueueIndicator: () => void;
  /** Get the agent service from the tab. */
  getAgentService?: () => ChatRuntime | null;
}

/**
 * Explicit per-turn projection context (v3 §5.1): the data truth for one
 * turn's projection, replacing implicit reads of the global ChatState
 * current* fields. Domain data (message content, toolCalls, contentBlocks,
 * subagent records) is always updated; DOM rendering happens only when
 * renderTarget is set. `message`/`renderTarget` are refreshed per chunk when
 * provider boundary chunks switch the active assistant message.
 */
export interface TurnProjectionContext {
  turnId: string;
  message: ChatMessage;
  renderTarget: HTMLElement | null;
  /** Text accumulated for the current assistant message (data layer). */
  textBuffer: string;
  /** Thinking accumulated for the current assistant message (data layer). */
  thinkingBuffer: string;
  /** Tool ids registered this turn that have not been rendered/settled yet. */
  pendingToolIds: Set<string>;
  generation: number;
}

export function createTurnProjectionContext(init: {
  turnId: string;
  message: ChatMessage;
  renderTarget: HTMLElement | null;
  generation: number;
}): TurnProjectionContext {
  return {
    turnId: init.turnId,
    message: init.message,
    renderTarget: init.renderTarget,
    textBuffer: '',
    thinkingBuffer: '',
    pendingToolIds: new Set<string>(),
    generation: init.generation,
  };
}

export class StreamController {
  private static readonly ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS = [200, 600, 1500] as const;
  /** After the initial fast-retry sequence, poll the sidecar at this interval
   *  while the agent is still running, so tool calls appear incrementally. */
  private static readonly ASYNC_SUBAGENT_RUNNING_POLL_MS = 2000;
  /** Cap total attempts (~30 min at 2s interval) — bounds zombie poll chains
   *  whose agents never reach terminal state AND are never orphaned. Normal
   *  long agents are stopped by terminal/orphaned, not by this cap. */
  private static readonly ASYNC_SUBAGENT_MAX_ATTEMPTS = 900;

  private deps: StreamControllerDeps;
  private pendingTextRenderFrame: ScheduledAnimationFrame | null = null;
  private pendingTextRenderPromise: Promise<void> | null = null;
  private resolvePendingTextRender: (() => void) | null = null;
  private isTextRenderRunning = false;
  private pendingThinkingRenderFrame: ScheduledAnimationFrame | null = null;
  private pendingThinkingRenderPromise: Promise<void> | null = null;
  private resolvePendingThinkingRender: (() => void) | null = null;
  private isThinkingRenderRunning = false;
  private pendingToolOutputFrames = new Map<string, ScheduledAnimationFrame>();
  private pendingScrollFrame: ScheduledAnimationFrame | null = null;

  /**
   * Render-flush invalidation (turn-lease hotfix fix 3): set by cancel /
   * lifecycle invalidation so a finalize can never hang forever on a pending
   * render promise whose DOM state a cancelled turn no longer owns. The flag
   * is per user-turn scope — a new send starts a fresh scope.
   */
  private renderFlushInvalidated = false;
  private renderFlushInvalidationWaiters = new Set<() => void>();

  /** Context of the turn currently streaming through handleStreamChunk (v3 §5.1). */
  private activeContext: TurnProjectionContext | null = null;
  /** Tracks which async agents have a live sidecar poll chain (timer pending
   *  or mid-tick). Entries are added when a chain starts (running state change
   *  or terminal hydration with no existing chain) and released only when that
   *  chain stops (terminal with final result / orphaned / attempt cap /
   *  exception) — never by the state-change callback itself, so a
   *  still-pending chain is always visible to the dedup checks. */
  private asyncRetryScheduled: Set<string> = new Set();

  // Provider lifecycle agent tracking (spawn → wait/close lifecycle)
  private lifecycleSubagentStates = new Map<string, SubagentState>(); // spawn callId → SubagentState
  private lifecycleAgentIdToSpawnId = new Map<string, string>();      // agentId → spawn callId

  constructor(deps: StreamControllerDeps) {
    this.deps = deps;
  }

  /** Opens a fresh render-flush scope at user-turn start (InputController.sendMessage). */
  beginRenderFlushScope(): void {
    this.renderFlushInvalidated = false;
  }

  /**
   * Cancel/lifecycle invalidation: settle every pending render-flush await,
   * dropping the pending render instead of waiting on DOM state a cancelled
   * turn no longer owns. No timeout is used — a timed release could let old
   * and new turn projections run concurrently.
   */
  invalidateRenderFlush(): void {
    this.renderFlushInvalidated = true;
    const waiters = [...this.renderFlushInvalidationWaiters];
    this.renderFlushInvalidationWaiters.clear();
    for (const settle of waiters) {
      settle();
    }
  }

  private waitForRenderFlushInvalidation(): { promise: Promise<void>; dispose: () => void } {
    let settle!: () => void;
    const promise = new Promise<void>(resolve => { settle = resolve; });
    this.renderFlushInvalidationWaiters.add(settle);
    return {
      promise,
      dispose: () => { this.renderFlushInvalidationWaiters.delete(settle); },
    };
  }

  /**
   * Turn-scoped cancellable await for finalize-time renderContent calls: the
   * math-deferred finalize path runs outside the scheduled flush pipeline and
   * has no pending-render promise of its own, so a cancelled turn must not
   * block finalize on renderer DOM state it no longer owns. Loser promise is
   * dropped — the data finalize below still runs on either outcome.
   */
  private async awaitRenderCancelable(render: Promise<void>): Promise<void> {
    if (this.renderFlushInvalidated) return;
    const invalidation = this.waitForRenderFlushInvalidation();
    try {
      await Promise.race([render, invalidation.promise]);
    } finally {
      invalidation.dispose();
    }
  }

  private getActiveProviderId(): ProviderId {
    return this.deps.getAgentService?.()?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
  }

  private getSubagentLifecycleAdapter(toolName?: string): ProviderSubagentLifecycleAdapter | null {
    return resolveSubagentLifecycleAdapter(this.getActiveProviderId(), toolName);
  }

  private normalizeToolResultContent(content: unknown): string {
    return extractToolResultContent(content, { fallbackIndent: 2 });
  }

  // ============================================
  // Stream Chunk Handling
  // ============================================

  async handleStreamChunk(chunk: StreamChunk, context: TurnProjectionContext): Promise<void> {
    const { state } = this.deps;
    this.activeContext = context;
    const msg = context.message;

    switch (chunk.type) {
      case 'thinking':
        // Flush pending tools before rendering new content type
        this.flushPendingTools();
        if (state.currentTextEl || context.textBuffer) {
          await this.finalizeCurrentTextBlock(msg, context);
        }
        // Thinking always accumulates in the context buffer (data layer)
        context.thinkingBuffer += chunk.content;
        if (context.renderTarget) {
          await this.appendThinking(chunk.content);
        }
        break;

      case 'text':
        // Flush pending tools before rendering new content type
        this.flushPendingTools();
        if (state.currentThinkingState || context.thinkingBuffer) {
          await this.finalizeCurrentThinkingBlock(msg, context);
        }
        // Text always lands in message data (data layer)
        msg.content += chunk.content;
        context.textBuffer += chunk.content;
        if (context.renderTarget) {
          await this.appendText(chunk.content);
        }
        break;

      case 'tool_use': {
        if (state.currentThinkingState || context.thinkingBuffer) {
          await this.finalizeCurrentThinkingBlock(msg, context);
        }
        await this.finalizeCurrentTextBlock(msg, context);

        if (isSubagentToolName(chunk.name)) {
          // Flush pending tools before Agent
          this.flushPendingTools();
          this.handleTaskToolUseViaManager(chunk, msg, context);
          break;
        }

        if (chunk.name === TOOL_AGENT_OUTPUT) {
          this.handleAgentOutputToolUse(chunk, msg);
          break;
        }

        const subagentLifecycleAdapter = this.getSubagentLifecycleAdapter(chunk.name);
        if (subagentLifecycleAdapter?.isSpawnTool(chunk.name)) {
          this.handleProviderSubagentSpawn(chunk, msg, context, subagentLifecycleAdapter);
          break;
        }
        if (subagentLifecycleAdapter?.isHiddenTool(chunk.name)) {
          this.handleProviderHiddenSubagentTool(chunk, msg);
          break;
        }

        this.handleRegularToolUse(chunk, msg, context);
        break;
      }

      case 'tool_result': {
        await this.handleToolResult(chunk, msg, context);
        break;
      }

      case 'subagent_tool_use':
      case 'subagent_tool_result':
        await this.handleSubagentChunk(chunk, msg, context);
        break;

      case 'tool_output':
        this.handleToolOutput(chunk, msg);
        break;

      case 'notice': {
        // Normalized text block first (data layer), optional DOM after (v3 §5.1)
        this.flushPendingTools();
        const noticeText = `\n\n⚠️ **${chunk.level === 'warning' ? 'Blocked' : 'Notice'}:** ${chunk.content}`;
        msg.content += noticeText;
        context.textBuffer += noticeText;
        if (context.renderTarget) {
          await this.appendText(noticeText);
        }
        break;
      }

      case 'error': {
        // Normalized text block first (data layer), optional DOM after (v3 §5.1)
        this.flushPendingTools();
        const errorText = `\n\n❌ **Error:** ${chunk.content}`;
        msg.content += errorText;
        context.textBuffer += errorText;
        if (context.renderTarget) {
          await this.appendText(errorText);
        }
        break;
      }

      case 'done':
        // Flush any remaining pending tools
        this.flushPendingTools();
        break;

      case 'context_compacted': {
        this.flushPendingTools();
        if (state.currentThinkingState || context.thinkingBuffer) {
          await this.finalizeCurrentThinkingBlock(msg, context);
        }
        await this.finalizeCurrentTextBlock(msg, context);
        msg.contentBlocks = msg.contentBlocks || [];
        msg.contentBlocks.push({ type: 'context_compacted' });
        this.renderCompactBoundary();
        break;
      }

      case 'usage': {
        // Usage is DOM-independent (v3 §5.1): always updates the scoped
        // conversation state, subject to session/subagent guards.
        // Skip usage updates from other sessions or when flagged (during session reset)
        const currentSessionId = this.deps.getAgentService?.()?.getSessionId() ?? null;
        const chunkSessionId = chunk.sessionId ?? null;
        if (
          (chunkSessionId && currentSessionId && chunkSessionId !== currentSessionId) ||
          (chunkSessionId && !currentSessionId)
        ) {
          break;
        }
        // Skip usage updates when subagents ran (SDK reports cumulative usage including subagents)
        if (this.deps.subagentManager.subagentsSpawnedThisStream > 0) {
          break;
        }
        if (!state.ignoreUsageUpdates) {
          const activeModel = this.getActiveProviderModel();
          state.usage = activeModel && !chunk.usage.model
            ? { ...chunk.usage, model: activeModel }
            : chunk.usage;
        }
        break;
      }

      default:
        break;
    }

    this.scrollToBottom();
  }

  // ============================================
  // Tool Use Handling
  // ============================================

  /**
   * Handles regular tool_use chunks by buffering them.
   * Tools are rendered when flushPendingTools is called (on next content type or tool_result).
   * Data layer (toolCalls/contentBlocks) is always updated; the DOM buffer is
   * only filled when the turn has a render target (v3 §5.1).
   */
  private handleRegularToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    msg: ChatMessage,
    context: TurnProjectionContext
  ): void {
    const { state } = this.deps;

    // Check if this is an update to an existing tool call
    const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (existingToolCall) {
      const newInput = chunk.input || {};
      if (Object.keys(newInput).length > 0) {
        existingToolCall.input = { ...existingToolCall.input, ...newInput };

        // Re-parse TodoWrite on input updates (streaming may complete the input)
        if (existingToolCall.name === TOOL_TODO_WRITE) {
          const todos = parseTodoInput(existingToolCall.input);
          if (todos) {
            this.deps.state.currentTodos = todos;
          }
        }

        // Capture plan file path on input updates (file_path may arrive in a later chunk)
        if (existingToolCall.name === TOOL_WRITE) {
          this.capturePlanFilePath(existingToolCall.input);
        }

        // If already rendered, update the header name + summary
        const toolEl = state.toolCallElements.get(chunk.id);
        if (toolEl) {
          const nameEl = toolEl.querySelector('.claudian-tool-name') as HTMLElement | null
            ?? toolEl.querySelector('.claudian-write-edit-name') as HTMLElement | null;
          if (nameEl) {
            nameEl.setText(getToolName(existingToolCall.name, existingToolCall.input));
          }
          const summaryEl = toolEl.querySelector('.claudian-tool-summary') as HTMLElement | null
            ?? toolEl.querySelector('.claudian-write-edit-summary') as HTMLElement | null;
          if (summaryEl) {
            summaryEl.setText(getToolSummary(existingToolCall.name, existingToolCall.input));
          }
        }
        // If still pending, the updated input is already in the toolCall object
      }
      return;
    }

    // Create new tool call
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      status: 'running',
      isExpanded: false,
    };
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCall);

    // Add to contentBlocks for ordering
    msg.contentBlocks = msg.contentBlocks || [];
    msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });

    // TodoWrite: update panel state immediately (side effect), but still buffer render
    if (chunk.name === TOOL_TODO_WRITE) {
      const todos = parseTodoInput(chunk.input);
      if (todos) {
        this.deps.state.currentTodos = todos;
      }
    }

    // Track Write to provider plan directory for plan mode (used by approve-new-session)
    if (chunk.name === TOOL_WRITE) {
      this.capturePlanFilePath(chunk.input);
    }

    // Data-layer registration always happens; the DOM render buffer is optional
    context.pendingToolIds.add(chunk.id);
    if (context.renderTarget) {
      state.pendingTools.set(chunk.id, {
        toolCall,
        parentEl: context.renderTarget,
      });
      this.showThinkingIndicator();
    }
  }

  private getActiveProviderModel(): string | undefined {
    const providerId = this.deps.getAgentService?.()?.providerId;
    if (!providerId) {
      return undefined;
    }

    const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.deps.plugin.settings as unknown as Record<string, unknown>,
      providerId,
    );
    return typeof settings.model === 'string' ? settings.model : undefined;
  }

  private shouldDeferMathRendering(): boolean {
    return this.deps.plugin.settings.deferMathRenderingDuringStreaming !== false;
  }

  private getStreamingRenderOptions(content: string): RenderContentOptions | undefined {
    return this.shouldDeferMathRendering() && hasStreamingMathDelimiters(content)
      ? { deferMath: true }
      : undefined;
  }

  private capturePlanFilePath(input: Record<string, unknown>): void {
    const filePath = input.file_path as string | undefined;
    if (!filePath) return;

    const planPathPrefix = this.deps.getAgentService?.()?.getCapabilities().planPathPrefix;
    if (planPathPrefix && filePath.replace(/\\/g, '/').includes(planPathPrefix)) {
      this.deps.state.planFilePath = filePath;
    }
  }

  /**
   * Flushes all pending tool calls by rendering them.
   * Called when a different content type arrives or stream ends.
   */
  private flushPendingTools(): void {
    const { state } = this.deps;

    if (state.pendingTools.size === 0) {
      return;
    }

    // Render pending tools in order (Map preserves insertion order)
    for (const toolId of state.pendingTools.keys()) {
      this.renderPendingTool(toolId);
    }

    state.pendingTools.clear();
    this.activeContext?.pendingToolIds.clear();
  }

  /**
   * Renders a single pending tool call and moves it from pending to rendered state.
   */
  private renderPendingTool(toolId: string): void {
    const { state } = this.deps;
    const pending = state.pendingTools.get(toolId);
    if (!pending) return;

    const { toolCall, parentEl } = pending;
    if (!parentEl) return;
    if (isWriteEditTool(toolCall.name)) {
      const writeEditState = createWriteEditBlock(parentEl, toolCall);
      state.writeEditStates.set(toolId, writeEditState);
      state.toolCallElements.set(toolId, writeEditState.wrapperEl);
    } else {
      renderToolCall(parentEl, toolCall, state.toolCallElements);
    }
    state.pendingTools.delete(toolId);
    this.activeContext?.pendingToolIds.delete(toolId);
  }

  private handleToolOutput(
    chunk: { type: 'tool_output'; id: string; content: string },
    msg: ChatMessage,
  ): void {
    const { state } = this.deps;

    if (state.pendingTools.has(chunk.id)) {
      this.renderPendingTool(chunk.id);
    }

    const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (!existingToolCall) {
      return;
    }

    existingToolCall.result = (existingToolCall.result ?? '') + chunk.content;
    this.scheduleToolOutputRender(chunk.id, existingToolCall);
    this.showThinkingIndicator();
  }

  // ============================================
  // Provider lifecycle subagents (spawn → wait/close)
  // ============================================

  private handleProviderSubagentSpawn(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    msg: ChatMessage,
    context: TurnProjectionContext,
    adapter: ProviderSubagentLifecycleAdapter,
  ): void {
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      status: 'running',
      isExpanded: false,
    };
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCall);
    msg.contentBlocks = msg.contentBlocks || [];
    msg.contentBlocks.push({ type: 'tool_use', toolId: chunk.id });

    // Render as subagent block immediately (optional DOM projection)
    if (context.renderTarget) {
      this.flushPendingTools();
      const subagentInfo = adapter.buildSubagentInfo(toolCall, msg.toolCalls);

      const subagentState = createSubagentBlock(context.renderTarget, chunk.id, {
        description: subagentInfo.description,
        prompt: subagentInfo.prompt,
      });
      this.lifecycleSubagentStates.set(chunk.id, subagentState);
    }
  }

  private handleProviderHiddenSubagentTool(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    msg: ChatMessage
  ): void {
    // Track in toolCalls for data completeness, but don't create DOM or content block
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      status: 'running',
      isExpanded: false,
    };
    msg.toolCalls = msg.toolCalls || [];
    msg.toolCalls.push(toolCall);
  }

  /**
   * Handles tool_result for provider lifecycle subagent tools.
   * Returns true if the result was consumed (caller should return early).
   */
  private handleProviderSubagentResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean },
    msg: ChatMessage
  ): boolean {
    const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
    if (!existingToolCall) return false;
    const normalizedContent = this.normalizeToolResultContent(chunk.content);

    const adapter = this.getSubagentLifecycleAdapter(existingToolCall.name);
    if (!adapter) return false;

    if (adapter.isSpawnTool(existingToolCall.name)) {
      existingToolCall.status = chunk.isError ? 'error' : 'completed';
      existingToolCall.result = normalizedContent;

      const spawnResult = adapter.extractSpawnResult(normalizedContent);
      if (spawnResult.agentId) {
        this.lifecycleAgentIdToSpawnId.set(spawnResult.agentId, chunk.id);
      }

      const subagentInfo = adapter.buildSubagentInfo(existingToolCall, msg.toolCalls ?? []);
      const subagentState = this.lifecycleSubagentStates.get(chunk.id);
      if (subagentState) {
        subagentState.info.description = subagentInfo.description;
        subagentState.info.prompt = subagentInfo.prompt;
        subagentState.labelEl.setText(
          subagentInfo.description.length > 40
            ? subagentInfo.description.substring(0, 40) + '...'
            : subagentInfo.description
        );
      }

      if (chunk.isError) {
        if (subagentState) {
          finalizeSubagentBlock(subagentState, normalizedContent || 'Error', true);
        }
      }
      return true;
    }

    if (adapter.isWaitTool(existingToolCall.name)) {
      existingToolCall.status = chunk.isError ? 'error' : 'completed';
      existingToolCall.result = normalizedContent;

      for (const spawnId of adapter.resolveSpawnToolIds(
        existingToolCall,
        this.lifecycleAgentIdToSpawnId,
      )) {
        const spawnToolCall = msg.toolCalls?.find(tc => tc.id === spawnId);
        const subagentState = this.lifecycleSubagentStates.get(spawnId);
        if (!spawnToolCall || !subagentState) continue;

        const subagentInfo = adapter.buildSubagentInfo(spawnToolCall, msg.toolCalls ?? []);
        subagentState.info.description = subagentInfo.description;
        subagentState.info.prompt = subagentInfo.prompt;

        if (subagentInfo.status === 'completed' || subagentInfo.status === 'error') {
          finalizeSubagentBlock(
            subagentState,
            subagentInfo.result || (subagentInfo.status === 'error' ? 'Error' : 'DONE'),
            subagentInfo.status === 'error'
          );
        }
      }
      return true;
    }

    if (adapter.isCloseTool(existingToolCall.name)) {
      existingToolCall.status = chunk.isError ? 'error' : 'completed';
      existingToolCall.result = normalizedContent;
      return true;
    }

    return false;
  }

  private async handleToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean; toolUseResult?: SDKToolUseResult },
    msg: ChatMessage,
    context: TurnProjectionContext
  ): Promise<void> {
    const { state, subagentManager } = this.deps;
    const normalizedContent = this.normalizeToolResultContent(chunk.content);

    // Resolve pending Task before processing result.
    if (subagentManager.hasPendingTask(chunk.id)) {
      this.renderPendingTaskFromTaskResultViaManager(chunk, msg, context);
    }

    // Check if it's a sync subagent result
    const syncSubagent = subagentManager.getSyncSubagent(chunk.id);
    if (syncSubagent) {
      this.finalizeSubagent(chunk, msg);
      return;
    }

    // Check if it's an async task result
    if (this.handleAsyncTaskToolResult(chunk)) {
      this.showThinkingIndicator();
      return;
    }

    // Check if it's an agent output result
    if (await this.handleAgentOutputToolResult(chunk)) {
      this.showThinkingIndicator();
      return;
    }

    if (this.handleProviderSubagentResult(chunk, msg)) {
      this.showThinkingIndicator();
      return;
    }

    // Check if tool is still pending (buffered) - render it now before applying result
    if (state.pendingTools.has(chunk.id)) {
      this.renderPendingTool(chunk.id);
    }

    const existingToolCall = msg.toolCalls?.find(tc => tc.id === chunk.id);
    // The tool call is settled by this result in every path below.
    context.pendingToolIds.delete(chunk.id);

    // Regular tool result
    const isBlocked = isBlockedToolResult(normalizedContent, chunk.isError);

    if (existingToolCall) {
      // Tools that resolve via dedicated callbacks (not content-based) skip
      // blocked detection — their status is determined solely by isError
      if (chunk.isError) {
        existingToolCall.status = 'error';
      } else if (!skipsBlockedDetection(existingToolCall.name) && isBlocked) {
        existingToolCall.status = 'blocked';
      } else {
        existingToolCall.status = 'completed';
      }
      existingToolCall.result = normalizedContent;

      if (existingToolCall.name === TOOL_ASK_USER_QUESTION) {
        const answers =
          extractResolvedAnswers(chunk.toolUseResult) ??
          extractResolvedAnswersFromResultText(normalizedContent);
        if (answers) existingToolCall.resolvedAnswers = answers;
      }

      const writeEditState = state.writeEditStates.get(chunk.id);
      if (writeEditState && isWriteEditTool(existingToolCall.name)) {
        if (!chunk.isError && !isBlocked) {
          const diffData = extractDiffData(chunk.toolUseResult, existingToolCall);
          if (diffData) {
            existingToolCall.diffData = diffData;
            updateWriteEditWithDiff(writeEditState, diffData);
          }
        }
        finalizeWriteEditBlock(writeEditState, chunk.isError || isBlocked);
      } else {
        this.cancelPendingToolOutputRender(chunk.id);
        updateToolCallResult(chunk.id, existingToolCall, state.toolCallElements);
      }

      // Notify Obsidian vault so the file tree refreshes after Write/Edit/NotebookEdit
      if (!chunk.isError && !isBlocked && isEditTool(existingToolCall.name)) {
        this.notifyVaultFileChange(existingToolCall.input);
      }

      // Runtime apply_patch: refresh each changed file path
      if (!chunk.isError && !isBlocked && existingToolCall.name === TOOL_APPLY_PATCH) {
        this.notifyApplyPatchFileChanges(existingToolCall.input);
      }
    }

    this.showThinkingIndicator();
  }

  // ============================================
  // Text Block Management
  // ============================================

  async appendText(text: string): Promise<void> {
    const { state } = this.deps;
    if (!state.currentContentEl) return;

    this.hideThinkingIndicator();

    if (!state.currentTextEl) {
      state.currentTextEl = state.currentContentEl.createDiv({ cls: 'claudian-text-block' });
      state.currentTextContent = '';
    }

    state.currentTextContent += text;
    void this.scheduleCurrentTextRender();
  }

  async finalizeCurrentTextBlock(msg?: ChatMessage, context?: TurnProjectionContext): Promise<void> {
    const { state, renderer } = this.deps;
    await this.flushPendingTextRender();

    // DOM turns read the render buffer; detached turns read the context buffer
    // (v3 §5.1) — text always lands in contentBlocks.
    const textContent = state.currentTextContent || context?.textBuffer || '';
    if (msg && textContent) {
      if (
        state.currentTextEl
        && this.shouldDeferMathRendering()
        && hasStreamingMathDelimiters(textContent)
      ) {
        // Cancellable finalize render (fix 3 follow-up): the math-deferred
        // renderContent has no pending-render promise of its own, so it must
        // join the same turn-scoped invalidation as flushPendingTextRender.
        await this.awaitRenderCancelable(
          renderer.renderContent(state.currentTextEl, textContent)
        );
      }
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({ type: 'text', content: textContent });
      // Copy button added here (not during streaming) to match history-loaded messages
      if (state.currentTextEl) {
        renderer.addTextCopyButton(state.currentTextEl, textContent);
      }
    }
    state.currentTextEl = null;
    state.currentTextContent = '';
    if (context) {
      context.textBuffer = '';
    }
  }

  private scheduleCurrentTextRender(): Promise<void> {
    if (!this.pendingTextRenderPromise) {
      this.pendingTextRenderPromise = new Promise(resolve => {
        this.resolvePendingTextRender = resolve;
      });
    }

    if (this.pendingTextRenderFrame === null && !this.isTextRenderRunning) {
      this.pendingTextRenderFrame = scheduleAnimationFrame(() => {
        this.pendingTextRenderFrame = null;
        void this.renderPendingText();
      });
    }

    return this.pendingTextRenderPromise;
  }

  private async flushPendingTextRender(): Promise<void> {
    const pendingRender = this.pendingTextRenderPromise;
    if (!pendingRender) return;

    if (this.pendingTextRenderFrame !== null) {
      cancelScheduledAnimationFrame(this.pendingTextRenderFrame);
      this.pendingTextRenderFrame = null;
      void this.renderPendingText();
    }

    // Turn-scoped cancellable await (fix 3): cancel/lifecycle invalidation
    // settles this flush and drops the pending render — the flush must never
    // depend on global DOM render state a cancelled turn no longer owns.
    if (this.renderFlushInvalidated) {
      this.cancelPendingTextRender();
      return;
    }
    const invalidation = this.waitForRenderFlushInvalidation();
    try {
      await Promise.race([pendingRender, invalidation.promise]);
    } finally {
      invalidation.dispose();
    }
    if (this.renderFlushInvalidated && this.pendingTextRenderPromise === pendingRender) {
      this.cancelPendingTextRender();
      return;
    }
  }

  private async renderPendingText(): Promise<void> {
    if (this.isTextRenderRunning) return;
    this.isTextRenderRunning = true;

    const { state, renderer } = this.deps;
    const textEl = state.currentTextEl;
    const content = state.currentTextContent;

    try {
      if (textEl) {
        const options = this.getStreamingRenderOptions(content);
        if (options) {
          await renderer.renderContent(textEl, content, options);
        } else {
          await renderer.renderContent(textEl, content);
        }
        this.scrollToBottom();
      }
    } catch {
      // MessageRenderer owns user-visible render fallback; keep stream state moving.
    } finally {
      this.isTextRenderRunning = false;
    }

    if (state.currentTextEl === textEl && state.currentTextContent !== content) {
      this.pendingTextRenderFrame = scheduleAnimationFrame(() => {
        this.pendingTextRenderFrame = null;
        void this.renderPendingText();
      });
      return;
    }

    const resolve = this.resolvePendingTextRender;
    this.pendingTextRenderPromise = null;
    this.resolvePendingTextRender = null;
    resolve?.();
  }

  private cancelPendingTextRender(): void {
    if (this.pendingTextRenderFrame !== null) {
      cancelScheduledAnimationFrame(this.pendingTextRenderFrame);
      this.pendingTextRenderFrame = null;
    }

    const resolve = this.resolvePendingTextRender;
    this.pendingTextRenderPromise = null;
    this.resolvePendingTextRender = null;
    resolve?.();
  }

  private scheduleToolOutputRender(toolId: string, toolCall: ToolCallInfo): void {
    if (this.pendingToolOutputFrames.has(toolId)) return;

    const frame = scheduleAnimationFrame(() => {
      this.pendingToolOutputFrames.delete(toolId);
      updateToolCallResult(toolId, toolCall, this.deps.state.toolCallElements);
      this.scrollToBottom();
    });
    this.pendingToolOutputFrames.set(toolId, frame);
  }

  private cancelPendingToolOutputRender(toolId: string): void {
    const frame = this.pendingToolOutputFrames.get(toolId);
    if (!frame) return;

    cancelScheduledAnimationFrame(frame);
    this.pendingToolOutputFrames.delete(toolId);
  }

  private cancelPendingToolOutputRenders(): void {
    for (const frame of this.pendingToolOutputFrames.values()) {
      cancelScheduledAnimationFrame(frame);
    }
    this.pendingToolOutputFrames.clear();
  }

  // ============================================
  // Thinking Block Management
  // ============================================

  async appendThinking(content: string): Promise<void> {
    const { state, renderer } = this.deps;
    if (!state.currentContentEl) return;

    this.hideThinkingIndicator();
    if (!state.currentThinkingState) {
      state.currentThinkingState = createThinkingBlock(
        state.currentContentEl,
        (el, md) => renderer.renderContent(el, md)
      );
    }

    state.currentThinkingState.content += content;
    void this.scheduleCurrentThinkingRender();
  }

  async finalizeCurrentThinkingBlock(msg?: ChatMessage, context?: TurnProjectionContext): Promise<void> {
    const { state, renderer } = this.deps;
    const thinkingState = state.currentThinkingState;
    // Detached turns have no thinking DOM state; the context buffer is the
    // data truth (v3 §5.1) and always lands in contentBlocks.
    if (!thinkingState && !context?.thinkingBuffer) return;
    await this.flushPendingThinkingRender();

    if (thinkingState) {
      if (this.getStreamingRenderOptions(thinkingState.content)) {
        // Cancellable finalize render (fix 3 follow-up) — same turn-scoped
        // invalidation as flushPendingThinkingRender.
        await this.awaitRenderCancelable(
          renderer.renderContent(thinkingState.contentEl, thinkingState.content)
        );
      }

      const durationSeconds = finalizeThinkingBlock(thinkingState);

      if (msg && thinkingState.content) {
        msg.contentBlocks = msg.contentBlocks || [];
        msg.contentBlocks.push({
          type: 'thinking',
          content: thinkingState.content,
          durationSeconds,
        });
      }
    } else if (msg && context?.thinkingBuffer) {
      msg.contentBlocks = msg.contentBlocks || [];
      msg.contentBlocks.push({
        type: 'thinking',
        content: context.thinkingBuffer,
      });
    }

    state.currentThinkingState = null;
    if (context) {
      context.thinkingBuffer = '';
    }
  }

  private scheduleCurrentThinkingRender(): Promise<void> {
    if (!this.pendingThinkingRenderPromise) {
      this.pendingThinkingRenderPromise = new Promise(resolve => {
        this.resolvePendingThinkingRender = resolve;
      });
    }

    if (this.pendingThinkingRenderFrame === null && !this.isThinkingRenderRunning) {
      this.pendingThinkingRenderFrame = scheduleAnimationFrame(() => {
        this.pendingThinkingRenderFrame = null;
        void this.renderPendingThinking();
      });
    }

    return this.pendingThinkingRenderPromise;
  }

  private async flushPendingThinkingRender(): Promise<void> {
    const pendingRender = this.pendingThinkingRenderPromise;
    if (!pendingRender) return;

    if (this.pendingThinkingRenderFrame !== null) {
      cancelScheduledAnimationFrame(this.pendingThinkingRenderFrame);
      this.pendingThinkingRenderFrame = null;
      void this.renderPendingThinking();
    }

    // Turn-scoped cancellable await (fix 3) — mirrors flushPendingTextRender.
    if (this.renderFlushInvalidated) {
      this.cancelPendingThinkingRender();
      return;
    }
    const invalidation = this.waitForRenderFlushInvalidation();
    try {
      await Promise.race([pendingRender, invalidation.promise]);
    } finally {
      invalidation.dispose();
    }
    if (this.renderFlushInvalidated && this.pendingThinkingRenderPromise === pendingRender) {
      this.cancelPendingThinkingRender();
      return;
    }
  }

  private async renderPendingThinking(): Promise<void> {
    if (this.isThinkingRenderRunning) return;
    this.isThinkingRenderRunning = true;

    const { state, renderer } = this.deps;
    const thinkingState = state.currentThinkingState;
    const content = thinkingState?.content ?? '';

    try {
      if (thinkingState) {
        const options = this.getStreamingRenderOptions(content);
        if (options) {
          await renderer.renderContent(thinkingState.contentEl, content, options);
        } else {
          await renderer.renderContent(thinkingState.contentEl, content);
        }
        this.scrollToBottom();
      }
    } catch {
      // MessageRenderer owns user-visible render fallback; keep stream state moving.
    } finally {
      this.isThinkingRenderRunning = false;
    }

    if (state.currentThinkingState === thinkingState && thinkingState && thinkingState.content !== content) {
      this.pendingThinkingRenderFrame = scheduleAnimationFrame(() => {
        this.pendingThinkingRenderFrame = null;
        void this.renderPendingThinking();
      });
      return;
    }

    const resolve = this.resolvePendingThinkingRender;
    this.pendingThinkingRenderPromise = null;
    this.resolvePendingThinkingRender = null;
    resolve?.();
  }

  private cancelPendingThinkingRender(): void {
    if (this.pendingThinkingRenderFrame !== null) {
      cancelScheduledAnimationFrame(this.pendingThinkingRenderFrame);
      this.pendingThinkingRenderFrame = null;
    }

    const resolve = this.resolvePendingThinkingRender;
    this.pendingThinkingRenderPromise = null;
    this.resolvePendingThinkingRender = null;
    resolve?.();
  }

  // ============================================
  // Subagent Tool Handling (via SubagentManager)
  // ============================================

  /** Delegates Agent tool_use to SubagentManager and updates message based on result. */
  private handleTaskToolUseViaManager(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    msg: ChatMessage,
    context: TurnProjectionContext
  ): void {
    const { subagentManager } = this.deps;
    this.ensureTaskToolCall(msg, chunk.id, chunk.input);

    const result = subagentManager.handleTaskToolUse(chunk.id, chunk.input, context.renderTarget);

    switch (result.action) {
      case 'created_sync':
        this.recordSubagentInMessage(msg, result.info, chunk.id);
        this.showThinkingIndicator();
        break;
      case 'created_async':
        this.recordSubagentInMessage(msg, result.info, chunk.id, 'async');
        this.showThinkingIndicator();
        break;
      case 'buffered':
        this.showThinkingIndicator();
        break;
      case 'label_updated':
        break;
    }
  }

  /** Renders a pending Agent tool call via SubagentManager and updates message. */
  private renderPendingTaskViaManager(
    toolId: string,
    msg: ChatMessage,
    context: TurnProjectionContext
  ): void {
    const result = this.deps.subagentManager.renderPendingTask(toolId, context.renderTarget);
    if (!result) return;

    this.recordSubagentInMessage(msg, result.info, toolId, result.mode === 'async' ? 'async' : undefined);
  }

  /** Resolves a pending Agent tool call when its own tool_result arrives. */
  private renderPendingTaskFromTaskResultViaManager(
    chunk: { id: string; content: string; isError?: boolean; toolUseResult?: unknown },
    msg: ChatMessage,
    context: TurnProjectionContext
  ): void {
    const result = this.deps.subagentManager.renderPendingTaskFromTaskResult(
      chunk.id,
      chunk.content,
      chunk.isError || false,
      context.renderTarget,
      chunk.toolUseResult
    );
    if (!result) return;

    this.recordSubagentInMessage(msg, result.info, chunk.id, result.mode === 'async' ? 'async' : undefined);
  }

  private recordSubagentInMessage(
    msg: ChatMessage,
    info: SubagentInfo,
    toolId: string,
    mode?: 'async'
  ): void {
    const taskToolCall = this.ensureTaskToolCall(msg, toolId);
    this.applySubagentToTaskToolCall(taskToolCall, info);

    msg.contentBlocks = msg.contentBlocks || [];
    const existingBlock = msg.contentBlocks.find(
      block => block.type === 'subagent' && block.subagentId === toolId
    );
    if (existingBlock && mode && existingBlock.type === 'subagent') {
      existingBlock.mode = mode;
    } else if (!existingBlock) {
      msg.contentBlocks.push(mode
        ? { type: 'subagent', subagentId: toolId, mode }
        : { type: 'subagent', subagentId: toolId }
      );
    }
  }

  private async handleSubagentChunk(
    chunk: Extract<StreamChunk, { type: 'subagent_tool_use' | 'subagent_tool_result' }>,
    msg: ChatMessage,
    context: TurnProjectionContext,
  ): Promise<void> {
    const parentToolUseId = chunk.subagentId;
    const { subagentManager } = this.deps;

    // If parent Agent call is still pending, child chunk confirms it's sync - render now
    if (subagentManager.hasPendingTask(parentToolUseId)) {
      this.renderPendingTaskViaManager(parentToolUseId, msg, context);
    }

    const syncSubagent = subagentManager.getSyncSubagent(parentToolUseId);

    if (!syncSubagent) {
      return;
    }

    switch (chunk.type) {
      case 'subagent_tool_use': {
        const toolCall: ToolCallInfo = {
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
          status: 'running',
          isExpanded: false,
        };
        subagentManager.addSyncToolCall(parentToolUseId, toolCall);
        this.showThinkingIndicator();
        break;
      }

      case 'subagent_tool_result': {
        const toolCall = syncSubagent.toolCalls.find((tc: ToolCallInfo) => tc.id === chunk.id);
        if (toolCall) {
          const normalizedContent = this.normalizeToolResultContent(chunk.content);
          const isBlocked = isBlockedToolResult(normalizedContent, chunk.isError);
          toolCall.status = isBlocked ? 'blocked' : (chunk.isError ? 'error' : 'completed');
          toolCall.result = normalizedContent;
          subagentManager.updateSyncToolResult(parentToolUseId, chunk.id, toolCall);
        }
        break;
      }

      default:
        break;
    }
  }

  /** Finalizes a sync subagent when its Agent tool_result is received. */
  private finalizeSubagent(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean; toolUseResult?: unknown },
    msg: ChatMessage
  ): void {
    const isError = chunk.isError || false;
    const normalizedContent = this.normalizeToolResultContent(chunk.content);
    const finalized = this.deps.subagentManager.finalizeSyncSubagent(
      chunk.id, chunk.content, isError, chunk.toolUseResult
    );

    const extractedResult = finalized?.result ?? normalizedContent;

    const taskToolCall = this.ensureTaskToolCall(msg, chunk.id);
    taskToolCall.status = isError ? 'error' : 'completed';
    taskToolCall.result = extractedResult;
    if (taskToolCall.subagent) {
      taskToolCall.subagent.status = isError ? 'error' : 'completed';
      taskToolCall.subagent.result = extractedResult;
    }

    if (finalized) {
      this.applySubagentToTaskToolCall(taskToolCall, finalized);
    }

    this.showThinkingIndicator();
  }

  // ============================================
  // Async Subagent Handling
  // ============================================

  /** Handles TaskOutput tool_use (invisible, links to async subagent). */
  private handleAgentOutputToolUse(
    chunk: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    _msg: ChatMessage
  ): void {
    const toolCall: ToolCallInfo = {
      id: chunk.id,
      name: chunk.name,
      input: chunk.input,
      status: 'running',
      isExpanded: false,
    };

    this.deps.subagentManager.handleAgentOutputToolUse(toolCall);

    // Show flavor text while waiting for TaskOutput result
    this.showThinkingIndicator();
  }

  private handleAsyncTaskToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean; toolUseResult?: unknown }
  ): boolean {
    const { subagentManager } = this.deps;
    if (!subagentManager.isPendingAsyncTask(chunk.id)) {
      return false;
    }

    const earlySettled = subagentManager.handleTaskToolResult(
      chunk.id,
      chunk.content,
      chunk.isError,
      chunk.toolUseResult
    );
    // 秒完成竞态: a terminal notification arrived before this promotion, so
    // the settle happened here instead of the notification entry — run the
    // same sidecar hydration the notification entry would have. Merge-by-id
    // keeps this idempotent against any later duplicate notification.
    if (earlySettled) {
      void this.hydrateAsyncSubagentToolCalls(earlySettled).catch((error) => {
        console.warn('[Claudian] async subagent early-settle hydration failed', {
          taskToolId: chunk.id,
          error,
        });
      });
    }
    return true;
  }

  /** Handles TaskOutput result to finalize async subagent. */
  private async handleAgentOutputToolResult(
    chunk: { type: 'tool_result'; id: string; content: string; isError?: boolean; toolUseResult?: unknown }
  ): Promise<boolean> {
    const { subagentManager } = this.deps;
    const isLinked = subagentManager.isLinkedAgentOutputTool(chunk.id);

    const handled = subagentManager.handleAgentOutputToolResult(
      chunk.id,
      chunk.content,
      chunk.isError || false,
      chunk.toolUseResult
    );

    await this.hydrateAsyncSubagentToolCalls(handled);

    return isLinked || handled !== undefined;
  }

  /**
   * Terminal-notification entry for async subagents: settles the bookkeeping
   * via SubagentManager (c5ad19d semantics unchanged — settle-only, no lease,
   * no auto turn), then immediately hydrates tool details from the SDK
   * sidecar. Without this entry, a settled subagent that never gets a
   * TaskOutput round-trip shows Prompt + Result but no tool details, because
   * the settle itself removes the record the TaskOutput hydration path needs.
   * Fire-and-observe: failures are diagnostics only and must never break the
   * runtime notification loop that calls back into here.
   */
  handleAsyncSubagentNotification(taskId: string, status: string, result?: string | null): void {
    try {
      const settled = this.deps.subagentManager.handleTaskNotification(taskId, status, result);
      if (settled) {
        void this.hydrateAsyncSubagentToolCalls(settled).catch((error) => {
          console.warn('[Claudian] async subagent notification hydration failed', {
            taskId,
            status,
            error,
          });
        });
      }
    } catch (error) {
      console.warn('[Claudian] async subagent notification settlement failed', {
        taskId,
        status,
        error,
      });
    }
  }

  private async hydrateAsyncSubagentToolCalls(subagent: SubagentInfo | undefined): Promise<void> {
    if (!subagent) return;
    if (subagent.mode !== 'async') return;
    if (!subagent.agentId) return;

    const asyncStatus = subagent.asyncStatus ?? subagent.status;
    if (asyncStatus !== 'completed' && asyncStatus !== 'error') return;

    const runtime = this.deps.getAgentService?.();
    if (!runtime) return;

    const { hasHydrated, finalResultHydrated } = await this.tryHydrateAsyncSubagent(
      subagent,
      runtime
    );

    if (hasHydrated) {
      this.deps.subagentManager.refreshAsyncSubagent(subagent);
    }

    if (!finalResultHydrated && !this.asyncRetryScheduled.has(subagent.agentId)
        && typeof runtime.loadSubagentToolCalls === 'function') {
      // A poll chain is already scheduled for this agent (running-phase chain
      // whose next tick observes the terminal status and concludes on its
      // own) — starting a second one here would double-read the sidecar until
      // the final result flushes. Only agents without a chain (e.g. 秒完成
      // early-settle before any running callback) start one from here.
      // The loadSubagentToolCalls guard mirrors onAsyncSubagentStateChange:
      // runtimes without sidecar reads (non-Claude) must not start a chain
      // that would spin on empty reads until the cap.
      this.asyncRetryScheduled.add(subagent.agentId);
      this.scheduleAsyncSubagentResultRetry(subagent, runtime, 0);
    }
  }

  /**
   * One hydration pass: re-reads tool calls AND final result from the sidecar
   * on every call. Tool calls merge by id (never frozen after a partial first
   * read); retries re-read both because the sidecar may flush late content
   * between reads.
   */
  private async tryHydrateAsyncSubagent(
    subagent: SubagentInfo,
    runtime: ChatRuntime
  ): Promise<{ hasHydrated: boolean; finalResultHydrated: boolean }> {
    let hasHydrated = false;
    let finalResultHydrated = false;

    const recoveredToolCalls = await runtime.loadSubagentToolCalls?.(
      subagent.agentId || ''
    ) ?? [];
    if (recoveredToolCalls.length > 0 && this.mergeSubagentToolCallsById(subagent, recoveredToolCalls)) {
      hasHydrated = true;
    }

    const recoveredFinalResult = await runtime.loadSubagentFinalResult?.(
      subagent.agentId || ''
    ) ?? null;
    if (recoveredFinalResult && recoveredFinalResult.trim().length > 0) {
      finalResultHydrated = true;
      if (recoveredFinalResult !== subagent.result) {
        subagent.result = recoveredFinalResult;
        hasHydrated = true;
      }
    }

    return { hasHydrated, finalResultHydrated };
  }

  /**
   * Merges a fresh sidecar read into the subagent record by tool id: keeps
   * existing order and UI state, appends entries not seen before, and
   * refreshes fields of known entries when the sidecar carries more data.
   * Returns whether anything changed — unchanged re-reads stay invisible so
   * repeated hydration is idempotent.
   */
  private mergeSubagentToolCallsById(subagent: SubagentInfo, recovered: ToolCallInfo[]): boolean {
    const existing = subagent.toolCalls ?? [];
    const byId = new Map(existing.map((toolCall) => [toolCall.id, toolCall]));
    let changed = false;

    for (const incoming of recovered) {
      const current = byId.get(incoming.id);
      if (!current) {
        byId.set(incoming.id, { ...incoming, input: { ...incoming.input } });
        changed = true;
        continue;
      }
      if (this.mergeToolCallFields(current, incoming)) {
        changed = true;
      }
    }

    if (changed) {
      subagent.toolCalls = Array.from(byId.values());
    }
    return changed;
  }

  /** Sidecar read wins on richer data; the existing entry keeps its identity and UI state. */
  private mergeToolCallFields(current: ToolCallInfo, incoming: ToolCallInfo): boolean {
    let changed = false;

    let inputChanged = false;
    for (const key of Object.keys(incoming.input ?? {})) {
      if (current.input?.[key] !== incoming.input[key]) {
        inputChanged = true;
        break;
      }
    }
    if (inputChanged) {
      current.input = { ...(current.input ?? {}), ...incoming.input };
      changed = true;
    }

    if (incoming.status && incoming.status !== current.status) {
      current.status = incoming.status;
      changed = true;
    }

    if (typeof incoming.result === 'string' && incoming.result !== current.result) {
      current.result = incoming.result;
      changed = true;
    }

    return changed;
  }

  private scheduleAsyncSubagentResultRetry(
    subagent: SubagentInfo,
    runtime: ChatRuntime,
    attempt: number
  ): void {
    if (!subagent.agentId) return;
    if (attempt >= StreamController.ASYNC_SUBAGENT_MAX_ATTEMPTS) {
      // Cap reached: the chain ends here, so release the schedule slot —
      // otherwise the registration leaks and blocks nothing (agent ids are
      // unique) while growing the Set forever.
      this.asyncRetryScheduled.delete(subagent.agentId);
      return;
    }

    const delay = attempt < StreamController.ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS.length
      ? StreamController.ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS[attempt]
      : StreamController.ASYNC_SUBAGENT_RUNNING_POLL_MS;
    setTimeout(() => {
      void this.retryAsyncSubagentResult(subagent, runtime, attempt);
    }, delay);
  }

  private async retryAsyncSubagentResult(
    subagent: SubagentInfo,
    runtime: ChatRuntime,
    attempt: number
  ): Promise<void> {
    if (!subagent.agentId) return;
    try {
      const asyncStatus = subagent.asyncStatus ?? subagent.status;
      // Orphaned (conversation switched / tab destroyed) → stop immediately:
      // do NOT hydrate or refresh — the tab/conversation that owned this agent
      // no longer exists; touching its state is at best wasted and at worst
      // writes into the newly-switched conversation.
      if (asyncStatus === 'orphaned') {
        this.asyncRetryScheduled.delete(subagent.agentId);
        return;
      }

      // Terminal + final result obtained → stop polling.
      const isTerminal = asyncStatus === 'completed' || asyncStatus === 'error';
      if (isTerminal) {
        // Even at terminal, re-read once more for late sidecar content, then stop
        // unless finalResult is still missing.
        const { hasHydrated, finalResultHydrated } = await this.tryHydrateAsyncSubagent(
          subagent,
          runtime
        );
        if (hasHydrated) {
          this.deps.subagentManager.refreshAsyncSubagent(subagent);
        }
        if (finalResultHydrated) {
          // Chain concludes here — release the schedule slot (registration is
          // chain-owned; the state-change callback no longer clears it).
          this.asyncRetryScheduled.delete(subagent.agentId);
          return;
        }
        this.scheduleAsyncSubagentResultRetry(subagent, runtime, attempt + 1);
        return;
      }

      // Running: poll the sidecar so tool calls appear incrementally.
      const { hasHydrated } = await this.tryHydrateAsyncSubagent(subagent, runtime);
      if (hasHydrated) {
        this.deps.subagentManager.refreshAsyncSubagent(subagent);
      }
      this.scheduleAsyncSubagentResultRetry(subagent, runtime, attempt + 1);
    } catch (error) {
      // Defensive containment: the sidecar reads swallow their own errors,
      // but the DOM projection chain (refreshAsyncSubagent) can still throw.
      // Stop the chain and release its slot — a broken chain must not leave
      // an unhandled rejection or a zombie registration behind.
      console.warn('[Claudian] async subagent result retry failed', {
        agentId: subagent.agentId,
        attempt,
        error,
      });
      this.asyncRetryScheduled.delete(subagent.agentId);
    }
  }

  /** Callback from SubagentManager when async state changes. Updates messages only (DOM handled by manager). */
  onAsyncSubagentStateChange(subagent: SubagentInfo): void {
    this.updateSubagentInMessages(subagent);
    this.scrollToBottom();
    // Kick off sidecar polling when the agent enters 'running' so tool calls
    // appear incrementally instead of all at once on completion.
    const runtime = this.deps.getAgentService?.();
    if (runtime && subagent.agentId) {
      const status = subagent.asyncStatus ?? subagent.status;
      if (status === 'running' && !this.asyncRetryScheduled.has(subagent.agentId)
          && typeof runtime.loadSubagentToolCalls === 'function') {
        this.asyncRetryScheduled.add(subagent.agentId);
        this.scheduleAsyncSubagentResultRetry(subagent, runtime, 0);
      }
      // Terminal states do NOT clear the registration here: the settle path
      // fires this callback synchronously BEFORE the notification hydration
      // runs, so clearing would make the hydration-path dedup check miss and
      // start a second chain alongside the still-pending one. The chain owns
      // its registration and releases it when it actually stops (terminal
      // with final result / orphaned / attempt cap / exception).
    }
  }

  private updateSubagentInMessages(subagent: SubagentInfo): void {
    const { state } = this.deps;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (msg.role !== 'assistant') continue;
      if (this.linkTaskToolCallToSubagent(msg, subagent)) {
        return;
      }
    }
  }

  private ensureTaskToolCall(
    msg: ChatMessage,
    toolId: string,
    input?: Record<string, unknown>
  ): ToolCallInfo {
    msg.toolCalls = msg.toolCalls || [];
    const existing = msg.toolCalls.find(
      tc => tc.id === toolId && isSubagentToolName(tc.name)
    );
    if (existing) {
      if (input && Object.keys(input).length > 0) {
        existing.input = { ...existing.input, ...input };
      }
      return existing;
    }

    const taskToolCall: ToolCallInfo = {
      id: toolId,
      name: TOOL_TASK,
      input: input ? { ...input } : {},
      status: 'running',
      isExpanded: false,
    };
    msg.toolCalls.push(taskToolCall);
    return taskToolCall;
  }

  private applySubagentToTaskToolCall(taskToolCall: ToolCallInfo, subagent: SubagentInfo): void {
    taskToolCall.subagent = subagent;
    if (subagent.status === 'completed') taskToolCall.status = 'completed';
    else if (subagent.status === 'error') taskToolCall.status = 'error';
    else taskToolCall.status = 'running';
    if (subagent.result !== undefined) {
      taskToolCall.result = subagent.result;
    }
  }

  private linkTaskToolCallToSubagent(msg: ChatMessage, subagent: SubagentInfo): boolean {
    const taskToolCall = msg.toolCalls?.find(
      tc => tc.id === subagent.id && isSubagentToolName(tc.name)
    );
    if (!taskToolCall) return false;
    this.applySubagentToTaskToolCall(taskToolCall, subagent);
    return true;
  }

  // ============================================
  // Thinking Indicator
  // ============================================

  /** Debounce delay before showing thinking indicator (ms). */
  private static readonly THINKING_INDICATOR_DELAY = 400;

  /**
   * Schedules showing the thinking indicator after a delay.
   * If content arrives before the delay, the indicator won't show.
   * This prevents the indicator from appearing during active streaming.
   * Note: Flavor text is hidden when model thinking block is active (thinking takes priority).
   */
  showThinkingIndicator(overrideText?: string, overrideCls?: string): void {
    const { state } = this.deps;

    // Early return if no content element
    if (!state.currentContentEl) return;

    // Clear any existing timeout
    if (state.thinkingIndicatorTimeout) {
      clearTimeout(state.thinkingIndicatorTimeout);
      state.thinkingIndicatorTimeout = null;
    }

    // Don't show flavor text while model thinking block is active
    if (state.currentThinkingState) {
      return;
    }

    // If indicator already exists, just re-append it to the bottom
    if (state.thinkingEl) {
      state.currentContentEl.appendChild(state.thinkingEl);
      this.deps.updateQueueIndicator();
      return;
    }

    // Schedule showing the indicator after a delay
    state.thinkingIndicatorTimeout = setTimeout(() => {
      state.thinkingIndicatorTimeout = null;
      // Double-check we still have a content element, no indicator exists, and no thinking block
      if (!state.currentContentEl || state.thinkingEl || state.currentThinkingState) return;

      const cls = overrideCls
        ? `claudian-thinking ${overrideCls}`
        : 'claudian-thinking';
      state.thinkingEl = state.currentContentEl.createDiv({ cls });
      const text = overrideText || FLAVOR_TEXTS[Math.floor(Math.random() * FLAVOR_TEXTS.length)];
      state.thinkingEl.createSpan({ text });

      // Create timer span with initial value
      const timerSpan = state.thinkingEl.createSpan({ cls: 'claudian-thinking-hint' });
      const updateTimer = () => {
        if (!state.responseStartTime) return;
        // Check if element is still connected to DOM (prevents orphaned interval updates)
        if (!timerSpan.isConnected) {
          if (state.flavorTimerInterval) {
            clearInterval(state.flavorTimerInterval);
            state.flavorTimerInterval = null;
          }
          return;
        }
        const elapsedSeconds = Math.floor((performance.now() - state.responseStartTime) / 1000);
        timerSpan.setText(` (esc to interrupt · ${formatDurationMmSs(elapsedSeconds)})`);
      };
      updateTimer(); // Initial update

      // Start interval to update timer every second
      if (state.flavorTimerInterval) {
        clearInterval(state.flavorTimerInterval);
      }
      state.flavorTimerInterval = setInterval(updateTimer, 1000);

    }, StreamController.THINKING_INDICATOR_DELAY);
  }

  /** Hides the thinking indicator and cancels any pending show timeout. */
  hideThinkingIndicator(): void {
    const { state } = this.deps;

    // Cancel any pending show timeout
    if (state.thinkingIndicatorTimeout) {
      clearTimeout(state.thinkingIndicatorTimeout);
      state.thinkingIndicatorTimeout = null;
    }

    // Clear timer interval (but preserve responseStartTime for duration capture)
    state.clearFlavorTimerInterval();

    if (state.thinkingEl) {
      state.thinkingEl.remove();
      state.thinkingEl = null;
    }
  }

  // ============================================
  // Compact Boundary
  // ============================================

  private renderCompactBoundary(): void {
    const { state } = this.deps;
    if (!state.currentContentEl) return;
    this.hideThinkingIndicator();
    const el = state.currentContentEl.createDiv({ cls: 'claudian-compact-boundary' });
    el.createSpan({ cls: 'claudian-compact-boundary-label', text: 'Conversation compacted' });
  }

  // ============================================
  // Utilities
  // ============================================

  /**
   * Nudges Obsidian's vault after a Write/Edit/NotebookEdit so the file tree
   * refreshes. Direct `fs` writes bypass the Vault API, and macOS + iCloud
   * FSWatcher often misses the event.
   */
  private notifyVaultFileChange(input: Record<string, unknown>): void {
    const rawPath = (input.file_path ?? input.notebook_path) as string | undefined;
    const vaultPath = getVaultPath(this.deps.plugin.app);
    const relativePath = normalizePathForVault(rawPath, vaultPath);
    if (!relativePath || relativePath.startsWith('/')) return;

    setTimeout(() => {
      const { vault } = this.deps.plugin.app;
      const file = vault.getAbstractFileByPath(relativePath);
      if (file instanceof TFile) {
        // Existing file — tell listeners the content changed
        vault.trigger('modify', file);
      } else {
        // New file — scan parent directory so Obsidian discovers it
        const parentDir = relativePath.includes('/')
          ? relativePath.substring(0, relativePath.lastIndexOf('/'))
          : '';
        vault.adapter.list(parentDir).catch(() => { /* ignore */ });
      }
    }, 200);
  }

  /** Refreshes vault for each file path in an apply_patch changes array or patch text. */
  private notifyApplyPatchFileChanges(input: Record<string, unknown>): void {
    const notified = new Set<string>();

    // Legacy changes array
    const changes = input.changes;
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (change && typeof change === 'object' && typeof change.path === 'string') {
          notified.add(change.path);
          this.notifyVaultFileChange({ file_path: change.path });
        }
      }
    }

    // Parse file paths from patch text markers (current custom_tool_call format)
    const patchText = typeof input.patch === 'string' ? input.patch : '';
    if (patchText) {
      for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        const filePath = match[1]?.trim();
        if (filePath && !notified.has(filePath)) {
          this.notifyVaultFileChange({ file_path: filePath });
        }
      }
    }
  }

  /** Scrolls messages to bottom if auto-scroll is enabled. */
  private scrollToBottom(): void {
    if (this.pendingScrollFrame !== null) return;

    this.pendingScrollFrame = scheduleAnimationFrame(() => {
      this.pendingScrollFrame = null;
      this.applyScrollToBottom();
    });
  }

  private applyScrollToBottom(): void {
    const { state, plugin } = this.deps;
    if (!(plugin.settings.enableAutoScroll ?? true)) return;
    if (!state.autoScrollEnabled) return;

    const messagesEl = this.deps.getMessagesEl();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private cancelPendingScroll(): void {
    if (this.pendingScrollFrame === null) return;

    cancelScheduledAnimationFrame(this.pendingScrollFrame);
    this.pendingScrollFrame = null;
  }

  resetStreamingState(): void {
    const { state } = this.deps;
    this.cancelPendingTextRender();
    this.cancelPendingThinkingRender();
    this.cancelPendingToolOutputRenders();
    this.cancelPendingScroll();
    this.hideThinkingIndicator();
    this.activeContext = null;
    state.currentContentEl = null;
    state.currentTextEl = null;
    state.currentTextContent = '';
    state.currentThinkingState = null;
    this.deps.subagentManager.resetStreamingState();
    state.pendingTools.clear();
    // Reset response timer (duration already captured at this point)
    state.responseStartTime = null;
  }
}
