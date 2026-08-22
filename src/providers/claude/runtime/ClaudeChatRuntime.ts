/**
 * Claudian - Claude Agent SDK wrapper
 *
 * Handles communication with Claude via the Agent SDK. Manages streaming,
 * session persistence, permission modes, and security hooks.
 *
 * Architecture:
 * - Persistent query for active chat conversation (eliminates cold-start latency)
 * - Cold-start queries for inline edit, title generation
 * - MessageChannel for message queueing and turn management
 * - Dynamic updates (model, thinking tokens, permission mode, MCP servers)
 */

import type {
  CanUseTool,
  Options,
  PermissionMode as SDKPermissionMode,
  Query,
  RewindFilesResult,
  SDKMessage,
  SDKUserMessage,
  SlashCommand as SDKSlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';
import { Notice } from 'obsidian';

import type { McpServerManager } from '../../../core/mcp/McpServerManager';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  AppAgentManager,
  AppPluginManager,
} from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCancelledEvent,
  AutoTurnResult,
  AutoTurnStartedEvent,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentTaskNotificationHandler,
} from '../../../core/runtime/types';
import { TOOL_ENTER_PLAN_MODE, TOOL_SKILL } from '../../../core/tools/toolNames';
import type {
  ApprovalDecision,
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
} from '../../../core/types';
import type { ClaudianSettings, PermissionMode } from '../../../core/types/settings';
import type ClaudianPlugin from '../../../main';
import { stripCurrentNoteContext } from '../../../utils/context';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  getLastUserMessage,
  isSessionExpiredError,
} from '../../../utils/session';
import { CLAUDE_PROVIDER_CAPABILITIES } from '../capabilities';
import { loadSubagentFinalResult, loadSubagentToolCalls } from '../history/ClaudeHistoryStore';
import { extractXmlTag } from '../history/sdkMessageParsing';
import {
  createStopSubagentHook,
  type StopHookCircuitBreaker,
  type SubagentHookState,
} from '../hooks/SubagentHooks';
import { encodeClaudeTurn } from '../prompt/ClaudeTurnEncoder';
import { isContextWindowEvent, isSessionInitEvent, isStreamChunk } from '../sdk/typeGuards';
import type { SessionInitEvent, TransformEvent } from '../sdk/types';
import { getClaudeProviderSettings } from '../settings';
import {
  transformSDKMessage,
} from '../stream/transformClaudeMessage';
import { type ClaudeProviderState, getClaudeState } from '../types/providerState';
import { createClaudeApprovalCallback } from './ClaudeApprovalHandler';
import { applyClaudeDynamicUpdates } from './ClaudeDynamicUpdates';
import { MessageChannel } from './ClaudeMessageChannel';
import {
  type ColdStartQueryContext,
  type PersistentQueryContext,
  QueryOptionsBuilder,
  type QueryOptionsContext,
} from './ClaudeQueryOptionsBuilder';
import { executeClaudeRewind } from './ClaudeRewindService';
import { SessionManager } from './ClaudeSessionManager';
import {
  buildClaudePromptWithImages,
  buildClaudeSDKUserMessage,
} from './ClaudeUserMessageFactory';
import {
  type ClaudeEnsureReadyOptions,
  type ClosePersistentQueryOptions,
  createResponseHandler,
  createRuntimeTurn,
  isTurnCompleteMessage,
  type PersistentQueryConfig,
  type ResponseHandler,
  type RuntimeTurn,
} from './types';

export type { ApprovalDecision };
export type {
  ApprovalCallback,
  ApprovalCallbackOptions,
  AskUserQuestionCallback,
} from '../../../core/runtime/types';

export interface ClaudeRuntimeServices {
  mcpManager: McpServerManager;
  pluginManager: AppPluginManager;
  agentManager: Pick<AppAgentManager, 'setBuiltinAgentNames'>;
}

type QueryOptions = ChatRuntimeQueryOptions;

function isChatMessageArray(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.length > 0 &&
    !!value[0] && typeof value[0] === 'object' && 'role' in value[0] && 'content' in value[0];
}

function isImageAttachmentArray(value: unknown): value is ImageAttachment[] {
  return Array.isArray(value) && value.length > 0 &&
    !!value[0] && typeof value[0] === 'object' && 'mediaType' in value[0] && 'data' in value[0];
}

/**
 * Session-level control message (system/init at persistent-query start,
 * compact_boundary, hook lifecycle, ...). These carry no result message, so
 * they must never start an auto turn — an auto lease only releases at result
 * (routeMessage → settleTurnAtResult), so an auto turn opened here would hang
 * forever and deadlock the first queued user message. task_notification is
 * excluded: it keeps the v4 §6 create-auto-turn-then-settle order.
 */
function isLeaselessSessionControlMessage(message: SDKMessage): boolean {
  if ((message as { type?: string }).type !== 'system') {
    return false;
  }
  return (message as { subtype?: string }).subtype !== 'task_notification';
}

export class ClaudianService implements ChatRuntime {
  readonly providerId = CLAUDE_PROVIDER_CAPABILITIES.providerId;
  private plugin: ClaudianPlugin;
  private agentManager: Pick<AppAgentManager, 'setBuiltinAgentNames'> | null;
  private pluginManager: AppPluginManager | null;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private vaultPath: string | null = null;
  private currentExternalContextPaths: string[] = [];
  private readyStateListeners = new Set<(ready: boolean) => void>();

  // Modular components
  private sessionManager = new SessionManager();
  private mcpManager: McpServerManager;

  private persistentQuery: Query | null = null;
  private messageChannel: MessageChannel | null = null;
  private queryAbortController: AbortController | null = null;
  private responseHandlers: ResponseHandler[] = [];
  private responseConsumerRunning = false;
  private responseConsumerPromise: Promise<void> | null = null;
  private shuttingDown = false;

  // Tracked configuration for detecting changes that require restart
  private currentConfig: PersistentQueryConfig | null = null;

  // Current allowed tools for canUseTool enforcement (null = no restriction)
  private currentAllowedTools: string[] | null = null;

  private pendingResumeAt?: string;
  private pendingForkSession = false;

  // Last sent message for crash recovery (Phase 1.3)
  private lastSentMessage: SDKUserMessage | null = null;
  private lastSentQueryOptions: QueryOptions | null = null;
  private crashRecoveryAttempted = false;
  private coldStartInProgress = false;  // Prevent consumer error restarts during cold-start

  // SDK command cache — populated on system/init, cleared on persistent query close
  private cachedSdkCommands: SlashCommand[] = [];

  // Subagent hook state provider (set from feature layer to avoid core→feature dependency)
  private _subagentStateProvider: (() => SubagentHookState) | null = null;

  // Fix 1 (熔断): consecutive Stop-hook blocks since the last allow / user message.
  private _stopHookConsecutiveBlocks = 0;
  private static readonly STOP_HOOK_MAX_CONSECUTIVE_BLOCKS = 3;

  // Fix 2 (通知直接销账): live task-notification sink (set from feature layer).
  private _subagentNotificationHandler: SubagentTaskNotificationHandler | null = null;

  // Auto-triggered turn handling (e.g., task-notification delivery by the SDK)
  private _autoTurnCallback: ((result: AutoTurnResult) => void) | null = null;
  /** Sync signal for feature layer when an SDK-initiated turn starts (S1 API). */
  private _onAutoTurnStarted: ((event: AutoTurnStartedEvent) => void) | null = null;
  /** S2 lifecycle: feature lease cleared (v4 §3.1 step 3). */
  private _onAutoTurnFinished: ((turnId: string) => void) | null = null;
  /** S2 lifecycle: lease gone + channel released → UI queue may proceed (step 7). */
  private _onAutoTurnReleased: ((turnId: string) => void) | null = null;
  /** S2 lifecycle: feature clears its auto lease only (v3 §4.2). */
  private _onAutoTurnCancelled: ((event: AutoTurnCancelledEvent) => void) | null = null;

  // S1 turn-lease base: live turn registry keyed by turnId. All transform,
  // usage, metadata and dedup state lives on the turn, never on the runtime.
  private runtimeTurns = new Map<string, RuntimeTurn>();
  /** Metadata of the most recently settled user turn, awaiting feature consumption. */
  private pendingFeatureTurnMetadata: ChatTurnMetadata = {};
  /** Config restart deferred while a turn is mid-flight (executed when idle). */
  private deferredRestartPaths: string[] | null = null;
  private lastSentTurnId: string | null = null;

  private getLegacyPluginDeps(): ClaudianPlugin & {
    agentManager?: Pick<AppAgentManager, 'setBuiltinAgentNames'>;
    pluginManager?: AppPluginManager;
  } {
    return this.plugin as ClaudianPlugin & {
      agentManager?: Pick<AppAgentManager, 'setBuiltinAgentNames'>;
      pluginManager?: AppPluginManager;
    };
  }

  constructor(plugin: ClaudianPlugin, services: ClaudeRuntimeServices | McpServerManager) {
    this.plugin = plugin;
    const legacyPlugin = this.getLegacyPluginDeps();

    if ('mcpManager' in services) {
      this.mcpManager = services.mcpManager;
      this.pluginManager = services.pluginManager ?? legacyPlugin.pluginManager ?? null;
      this.agentManager = services.agentManager ?? legacyPlugin.agentManager ?? null;
      return;
    }

    this.mcpManager = services;
    this.pluginManager = legacyPlugin.pluginManager ?? null;
    this.agentManager = legacyPlugin.agentManager ?? null;
  }

  getCapabilities() {
    return CLAUDE_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeClaudeTurn(request, this.mcpManager);
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = { ...this.pendingFeatureTurnMetadata };
    this.pendingFeatureTurnMetadata = {};
    return metadata;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    try {
      listener(this.isReady());
    } catch {
      // Ignore listener errors
    }
    return () => {
      this.readyStateListeners.delete(listener);
    };
  }

  private notifyReadyStateChange(): void {
    if (this.readyStateListeners.size === 0) {
      return;
    }

    const isReady = this.isReady();
    for (const listener of this.readyStateListeners) {
      try {
        listener(isReady);
      } catch {
        // Ignore listener errors
      }
    }
  }

  private recordTurnMetadata(turn: RuntimeTurn, update: Partial<ChatTurnMetadata>): void {
    turn.metadata = {
      ...turn.metadata,
      ...update,
    };
  }

  private bufferUsageChunk(
    turn: RuntimeTurn,
    chunk: Extract<StreamChunk, { type: 'usage' }>,
  ): Extract<StreamChunk, { type: 'usage' }> {
    turn.bufferedUsage = chunk;
    return chunk;
  }

  private updateBufferedUsageContextWindow(
    turn: RuntimeTurn,
    contextWindow: number,
  ): Extract<StreamChunk, { type: 'usage' }> | null {
    if (!turn.bufferedUsage || contextWindow <= 0) {
      return null;
    }

    const usage = turn.bufferedUsage.usage;
    const percentage = Math.min(
      100,
      Math.max(0, Math.round((usage.contextTokens / contextWindow) * 100)),
    );
    const nextChunk: Extract<StreamChunk, { type: 'usage' }> = {
      ...turn.bufferedUsage,
      usage: {
        ...usage,
        contextWindow,
        contextWindowIsAuthoritative: true,
        percentage,
      },
    };
    turn.bufferedUsage = nextChunk;
    return nextChunk;
  }

  setPendingResumeAt(uuid: string | undefined): void {
    this.pendingResumeAt = uuid;
  }

  setResumeCheckpoint(checkpointId: string | undefined): void {
    this.setPendingResumeAt(checkpointId);
  }

  /** One-shot: consumed on the next query, then cleared by routeMessage on session init. */
  private applyForkState(conv: ChatRuntimeConversationState): string | null {
    const state = getClaudeState(conv.providerState);
    const isPending = !conv.sessionId && !state.providerSessionId && !!state.forkSource;
    this.pendingForkSession = isPending;
    if (isPending) {
      this.pendingResumeAt = state.forkSource!.resumeAt;
    } else {
      this.pendingResumeAt = undefined;
    }
    return conv.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.pendingForkSession = false;
      this.pendingResumeAt = undefined;
      this.setSessionId(null, externalContextPaths);
      return;
    }

    const resolvedSessionId = this.applyForkState(conversation);
    this.setSessionId(resolvedSessionId, externalContextPaths);
  }

  buildSessionUpdates({ conversation, sessionInvalidated }: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const sessionId = this.getSessionId();
    const existingState = getClaudeState(conversation?.providerState);

    const oldSdkSessionId = existingState.providerSessionId;
    const sessionChanged = sessionId && oldSdkSessionId && sessionId !== oldSdkSessionId;
    const previousProviderSessionIds = sessionChanged
      ? [...new Set([...(existingState.previousProviderSessionIds || []), oldSdkSessionId])]
      : existingState.previousProviderSessionIds;

    const isForkSourceOnly = !!existingState.forkSource &&
      !existingState.providerSessionId &&
      sessionId === existingState.forkSource.sessionId;

    let resolvedSessionId: string | null;
    if (sessionInvalidated) {
      resolvedSessionId = null;
    } else if (isForkSourceOnly) {
      resolvedSessionId = conversation?.sessionId ?? null;
    } else {
      resolvedSessionId = sessionId ?? conversation?.sessionId ?? null;
    }

    const newProviderState: ClaudeProviderState = {
      ...existingState,
      providerSessionId: sessionId && !isForkSourceOnly ? sessionId : existingState.providerSessionId,
      previousProviderSessionIds,
    };

    if (existingState.forkSource && sessionId && sessionId !== existingState.forkSource.sessionId) {
      delete newProviderState.forkSource;
    }

    return {
      updates: {
        sessionId: resolvedSessionId,
        providerState: newProviderState as Record<string, unknown>,
      },
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    const sessionId = this.getSessionId();
    if (sessionId) return sessionId;
    if (!conversation) return null;
    const state = getClaudeState(conversation.providerState);
    return state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  async loadSubagentToolCalls(agentId: string): Promise<ToolCallInfo[]> {
    const sessionId = this.getSessionId();
    const vaultPath = getVaultPath(this.plugin.app);
    if (!sessionId || !vaultPath) return [];
    return loadSubagentToolCalls(vaultPath, sessionId, agentId);
  }

  async loadSubagentFinalResult(agentId: string): Promise<string | null> {
    const sessionId = this.getSessionId();
    const vaultPath = getVaultPath(this.plugin.app);
    if (!sessionId || !vaultPath) return null;
    return loadSubagentFinalResult(vaultPath, sessionId, agentId);
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  /**
   * Ensures the persistent query is running with current configuration.
   * Unified API that replaces preWarm() and restartPersistentQuery().
   *
   * Behavior:
   * - If not running → start (if paths available)
   * - If running and force=true → close and restart
   * - If running and config changed → close and restart
   * - If running and config unchanged → no-op
   *
   * Note: When restart is needed, the query is closed BEFORE checking if we can
   * start a new one. This ensures fallback to cold-start if CLI becomes unavailable.
   *
   * @returns true if the query was (re)started, false otherwise
   */
  async ensureReady(options?: ClaudeEnsureReadyOptions): Promise<boolean> {
    const vaultPath = getVaultPath(this.plugin.app);

    // Track external context paths for dynamic updates (empty list clears)
    if (options && options.externalContextPaths !== undefined) {
      this.currentExternalContextPaths = options.externalContextPaths;
    }

    // Auto-resolve session ID from sessionManager if not explicitly provided
    const effectiveSessionId = options?.sessionId ?? this.sessionManager.getSessionId() ?? undefined;
    const externalContextPaths = options?.externalContextPaths ?? this.currentExternalContextPaths;

    // Case 1: Not running → try to start
    if (!this.persistentQuery) {
      if (!vaultPath) return false;
      const cliPath = this.plugin.getResolvedProviderCliPath('claude');
      if (!cliPath) return false;
      await this.startPersistentQuery(vaultPath, cliPath, effectiveSessionId, externalContextPaths);
      return true;
    }

    // Case 2: Force restart (session switch, crash recovery)
    // Close FIRST, then try to start new one (allows fallback if CLI unavailable)
    if (options?.force) {
      this.closePersistentQuery('forced restart', { preserveHandlers: options.preserveHandlers });
      if (!vaultPath) return false;
      const cliPath = this.plugin.getResolvedProviderCliPath('claude');
      if (!cliPath) return false;
      await this.startPersistentQuery(vaultPath, cliPath, effectiveSessionId, externalContextPaths);
      return true;
    }

    // Case 3: Check if config changed → restart if needed
    // We need vaultPath and cliPath to build config for comparison
    if (!vaultPath) return false;
    const cliPath = this.plugin.getResolvedProviderCliPath('claude');
    if (!cliPath) return false;

    const newConfig = this.buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
    if (this.needsRestart(newConfig)) {
      // Close FIRST, then try to start new one (allows fallback if CLI unavailable)
      this.closePersistentQuery('config changed', { preserveHandlers: options?.preserveHandlers });
      // Re-check CLI path as it might have changed during close
      const cliPathAfterClose = this.plugin.getResolvedProviderCliPath('claude');
      if (cliPathAfterClose) {
        await this.startPersistentQuery(vaultPath, cliPathAfterClose, effectiveSessionId, externalContextPaths);
        return true;
      }
      // CLI unavailable after close - query is closed, will fallback to cold-start
      return false;
    }

    // Case 4: Running and config unchanged → no-op
    return false;
  }

  /**
   * Starts the persistent query for the active chat conversation.
   */
  private async startPersistentQuery(
    vaultPath: string,
    cliPath: string,
    resumeSessionId?: string,
    externalContextPaths?: string[]
  ): Promise<void> {
    if (this.persistentQuery) {
      return;
    }

    this.shuttingDown = false;
    this.vaultPath = vaultPath;

    this.messageChannel = new MessageChannel(
      undefined,
      (turnId) => this.handleTurnDequeued(turnId),
    );

    if (resumeSessionId) {
      this.messageChannel.setSessionId(resumeSessionId);
      this.sessionManager.setSessionId(resumeSessionId, this.getScopedSettings().model);
    }

    this.queryAbortController = new AbortController();

    const config = this.buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
    this.currentConfig = config;

    // await is intentional: yields to microtask queue so fire-and-forget callers
    // (e.g. setSessionId → ensureReady) don't synchronously set persistentQuery
    const resumeAtMessageId = this.pendingResumeAt;
    const options = await this.buildPersistentQueryOptions(
      vaultPath,
      cliPath,
      resumeSessionId,
      resumeAtMessageId,
      externalContextPaths
    );

    this.persistentQuery = agentQuery({
      prompt: this.messageChannel,
      options,
    });

    if (this.pendingResumeAt === resumeAtMessageId) {
      this.pendingResumeAt = undefined;
    }
    this.attachPersistentQueryStdinErrorHandler(this.persistentQuery);

    this.startResponseConsumer();
    this.notifyReadyStateChange();
  }

  private attachPersistentQueryStdinErrorHandler(query: Query): void {
    const stdin = (query as { transport?: { processStdin?: NodeJS.WritableStream } }).transport?.processStdin;
    if (!stdin || typeof stdin.on !== 'function' || typeof stdin.once !== 'function') {
      return;
    }

    const handler = (error: NodeJS.ErrnoException) => {
      if (this.shuttingDown || this.isPipeError(error)) {
        return;
      }
      this.closePersistentQuery('stdin error');
    };

    stdin.on('error', handler);
    stdin.once('close', () => {
      stdin.removeListener('error', handler);
    });
  }

  private isPipeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const e = error as { code?: string; message?: string };
    return e.code === 'EPIPE' || (typeof e.message === 'string' && e.message.includes('EPIPE'));
  }

  /**
   * Closes the persistent query and cleans up resources.
   */
  closePersistentQuery(_reason?: string, options?: ClosePersistentQueryOptions): void {
    if (!this.persistentQuery) {
      return;
    }

    const preserveHandlers = options?.preserveHandlers ?? false;

    this.shuttingDown = true;

    // Close the message channel (ends the async iterable). close() reports
    // every turn that still held lease/queue state so the runtime can settle it.
    const channelTurnIds = this.messageChannel?.close() ?? [];

    // Interrupt the query
    void this.persistentQuery.interrupt().catch(() => {
      // Silence abort/interrupt errors during shutdown
    });

    // Abort as backup
    this.queryAbortController?.abort();

    if (preserveHandlers) {
      // Crash recovery: keep the replay turn (and its waiters) alive so the
      // re-enqueued message can finish on the restarted query. Everything
      // else on the dying channel is force-settled.
      for (const id of channelTurnIds) {
        if (id === this.lastSentTurnId) continue;
        this.cancelTurn(id, 'persistent_query_closed');
      }
      for (const id of [...this.runtimeTurns.keys()]) {
        if (id === this.lastSentTurnId) continue;
        this.cancelTurn(id, 'persistent_query_closed');
      }
    } else {
      // Settle every live turn (waiters get onDone) so generators don't hang.
      this.cancelAllTurns('persistent_query_closed');
      // Handlers not attached to any live turn still get their terminal event.
      for (const handler of this.responseHandlers) {
        handler.onDone();
      }
    }

    // Any deferred config restart is superseded: the query is being rebuilt
    // from current configuration anyway.
    this.deferredRestartPaths = null;

    // Reset shuttingDown synchronously. The consumer loop sees shuttingDown=true
    // on its next iteration check and breaks. The messageChannel.close()
    // above also terminates the for-await loop. Resetting here allows new queries
    // to proceed immediately without waiting for consumer loop teardown.
    this.shuttingDown = false;
    this.notifyReadyStateChange();

    // Clear state
    this.persistentQuery = null;
    this.messageChannel = null;
    this.queryAbortController = null;
    this.responseConsumerRunning = false;
    this.responseConsumerPromise = null;
    this.currentConfig = null;
    this.cachedSdkCommands = [];
    if (!preserveHandlers) {
      this.responseHandlers = [];
      this.currentAllowedTools = null;
    }

    // NOTE: Do NOT reset crashRecoveryAttempted here.
    // It's reset in queryViaPersistent after a successful message send,
    // or in resetSession/setSessionId when switching sessions.
    // Resetting it here would cause infinite restart loops on persistent errors.
  }

  /**
   * Checks if the persistent query needs to be restarted based on configuration changes.
   */
  private needsRestart(newConfig: PersistentQueryConfig): boolean {
    return QueryOptionsBuilder.needsRestart(this.currentConfig, newConfig);
  }

  /**
   * Builds configuration object for tracking changes.
   */
  private buildPersistentQueryConfig(
    vaultPath: string,
    cliPath: string,
    externalContextPaths?: string[]
  ): PersistentQueryConfig {
    return QueryOptionsBuilder.buildPersistentQueryConfig(
      this.buildQueryOptionsContext(vaultPath, cliPath),
      externalContextPaths
    );
  }

  /**
   * Builds the base query options context from current state.
   */
  private getScopedSettings(): ClaudianSettings {
    return ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    ) as unknown as ClaudianSettings;
  }

  private buildQueryOptionsContext(vaultPath: string, cliPath: string): QueryOptionsContext {
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables(this.providerId));
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);

    return {
      vaultPath,
      cliPath,
      settings: this.getScopedSettings(),
      customEnv,
      enhancedPath,
      mcpManager: this.mcpManager,
      pluginManager: this.requirePluginManager(),
    };
  }

  private requirePluginManager(): AppPluginManager {
    const pluginManager = this.pluginManager ?? this.getLegacyPluginDeps().pluginManager ?? null;
    if (!pluginManager) {
      throw new Error('Claude plugin manager is unavailable.');
    }
    return pluginManager;
  }

  private getAgentManager(): Pick<AppAgentManager, 'setBuiltinAgentNames'> | null {
    return this.agentManager ?? this.getLegacyPluginDeps().agentManager ?? null;
  }

  /**
   * Builds SDK options for the persistent query.
   */
  private buildPersistentQueryOptions(
    vaultPath: string,
    cliPath: string,
    resumeSessionId?: string,
    resumeAtMessageId?: string,
    externalContextPaths?: string[]
  ): Options {
    const baseContext = this.buildQueryOptionsContext(vaultPath, cliPath);
    const hooks = this.buildHooks();

    const ctx: PersistentQueryContext = {
      ...baseContext,
      abortController: this.queryAbortController ?? undefined,
      resume: resumeSessionId
        ? { sessionId: resumeSessionId, sessionAt: resumeAtMessageId, fork: this.pendingForkSession || undefined }
        : undefined,
      canUseTool: this.createApprovalCallback(),
      hooks,
      externalContextPaths,
    };

    return QueryOptionsBuilder.buildPersistentQueryOptions(ctx);
  }

  /**
   * Builds the hooks for SDK options.
   * Hooks need access to `this` for dynamic settings, so they're built here.
   */
  private buildHooks() {
    const hooks: Options['hooks'] = {};

    // Fix 1 (熔断): the hook is a stateless closure, so the consecutive-block
    // counter lives on this runtime instance. Reset on every allow and on every
    // user-initiated turn (see query()).
    const breaker: StopHookCircuitBreaker = {
      registerBlock: () => {
        this._stopHookConsecutiveBlocks += 1;
        if (this._stopHookConsecutiveBlocks > ClaudianService.STOP_HOOK_MAX_CONSECUTIVE_BLOCKS) {
          this._stopHookConsecutiveBlocks = 0;
          new Notice(
            `Claudian: Stop hook blocked ${ClaudianService.STOP_HOOK_MAX_CONSECUTIVE_BLOCKS} times while background tasks were still marked running. Allowing stop (circuit breaker) — please verify your background tasks.`
          );
          return true;
        }
        return false;
      },
      reset: () => {
        this._stopHookConsecutiveBlocks = 0;
      },
    };

    // Always register subagent hooks — closures resolve provider at execution time
    // so hooks work even when provider is set after the persistent query starts.
    hooks.Stop = [createStopSubagentHook(
      () => this._subagentStateProvider?.() ?? { hasRunning: false },
      breaker
    )];

    return hooks;
  }

  /**
   * Starts the background consumer loop that routes chunks to handlers.
   */
  private startResponseConsumer(): void {
    if (this.responseConsumerRunning) {
      return;
    }

    this.responseConsumerRunning = true;

    // Track which query this consumer is for, to detect if we were replaced
    const queryForThisConsumer = this.persistentQuery;

    this.responseConsumerPromise = (async () => {
      if (!this.persistentQuery) return;

      try {
        for await (const message of this.persistentQuery) {
          if (this.shuttingDown) break;

          await this.routeMessage(message);
        }
      } catch (error) {
        // Skip error handling if this consumer was replaced by a new one.
        // This prevents race conditions where the OLD consumer's error handler
        // interferes with the NEW handler after a restart (e.g., from applyDynamicUpdates).
        if (this.persistentQuery !== queryForThisConsumer && this.persistentQuery !== null) {
          return;
        }

        // Skip restart if cold-start is in progress (it will handle session capture)
        if (!this.shuttingDown && !this.coldStartInProgress) {
          const handler = this.responseHandlers[this.responseHandlers.length - 1];
          const errorInstance = error instanceof Error ? error : new Error(String(error));
          const messageToReplay = this.lastSentMessage;

          if (!this.crashRecoveryAttempted && messageToReplay && handler && !handler.sawAnyChunk) {
            this.crashRecoveryAttempted = true;
            try {
              await this.ensureReady({ force: true, preserveHandlers: true });
              if (!this.messageChannel) {
                throw new Error('Persistent query restart did not create message channel', {
                  cause: error,
                });
              }
              await this.applyDynamicUpdates(this.lastSentQueryOptions ?? undefined, { preserveHandlers: true });
              // Replay on the same turnId so the preserved handler/turn stay
              // bound to one lease across the restart.
              const replayTurnId = this.lastSentTurnId;
              const replayTurn = replayTurnId ? this.runtimeTurns.get(replayTurnId) : undefined;
              if (replayTurnId && replayTurn) {
                this.reRegisterTurnForRetry(replayTurn);
                this.messageChannel.enqueue(replayTurnId, messageToReplay);
              } else {
                // Turn registry lost the turn — settle instead of replaying
                // under an untracked lease.
                handler.onError(errorInstance);
              }
              return;
            } catch (restartError) {
              // If restart failed due to session expiration, invalidate session
              // so next query triggers noSessionButHasHistory → history rebuild
              if (isSessionExpiredError(restartError)) {
                this.sessionManager.invalidateSession();
              }
              handler.onError(errorInstance);
              return;
            }
          }

          // Notify active handler of error
          if (handler) {
            handler.onError(errorInstance);
          }

          // Crash recovery: restart persistent query to prepare for next user message.
          if (!this.crashRecoveryAttempted) {
            this.crashRecoveryAttempted = true;
            try {
              await this.ensureReady({ force: true });
            } catch (restartError) {
              // If restart failed due to session expiration, invalidate session
              // so next query triggers noSessionButHasHistory → history rebuild
              if (isSessionExpiredError(restartError)) {
                this.sessionManager.invalidateSession();
              }
              // Restart failed - next query will start fresh.
            }
          }
        }
      } finally {
        // Only clear the flag if this consumer wasn't replaced by a new one (e.g., after restart)
        // If ensureReady() restarted, it starts a new consumer which sets the flag true,
        // so we shouldn't clear it here.
        if (this.persistentQuery === queryForThisConsumer || this.persistentQuery === null) {
          this.responseConsumerRunning = false;
        }
      }
    })();
  }

  /** @param modelOverride - Optional model override for cold-start queries */
  private getTransformOptions(turn: RuntimeTurn, modelOverride?: string) {
    const settings = this.getScopedSettings();
    return {
      intendedModel: modelOverride ?? settings.model,
      customContextLimits: settings.customContextLimits,
      streamState: turn.streamState,
      usageState: turn.usageState,
    };
  }

  /**
   * Routes an SDK message to the turn that owns the message channel lease.
   *
   * Turn resolution (S1 turn lease):
   * 1. The channel's activeTurnId names the owning turn (a dequeued user
   *    message or an auto turn begun via beginExternalTurn).
   * 2. No active lease + session-level control message (system/init,
   *    compact_boundary, ...) → side effects only via
   *    applyLeaselessSystemMessage: no auto turn, no lease, no callbacks.
   * 3. No active lease otherwise → the SDK initiated a turn on its own
   *    (task-notification delivery): ensureAutoTurn() creates the auto
   *    RuntimeTurn, signs the external lease and fires onAutoTurnStarted
   *    synchronously — strictly before the notification is dispatched.
   * 4. A notification arriving under an existing lease is dispatched for
   *    accounting only; a second lease is never created.
   * 5. Chunks go to the owning turn's waiters; a turn without waiters buffers
   *    chunks and flushes through the auto-turn callback adapter on result.
   */
  private async routeMessage(message: SDKMessage): Promise<void> {
    // Note: Session expiration errors are handled in catch blocks (queryViaSDK, handleAbort)
    // The SDK throws errors as exceptions, not as message types

    let turn = this.resolveActiveTurn();

    if (!turn && isTurnCompleteMessage(message)) {
      // Trailing result of a turn already settled by cancel()/close: its
      // generation is invalid, so instead of spinning up a ghost auto turn
      // (which would flash isStreaming in the feature layer), drop it and
      // keep the consumer alive (S1 leftover #3).
      console.warn('[Claudian] trailing result without a turn lease; dropping');
      return;
    }

    // Lease-less session-level control messages (system/init at persistent
    // query start, compact_boundary mid-session) never start an auto turn:
    // they carry no result, so the auto lease would never release and the
    // first queued user message would deadlock (S1 regression). Session-level
    // side effects still run on a throwaway transform state.
    if (!turn && isLeaselessSessionControlMessage(message)) {
      this.applyLeaselessSystemMessage(message);
      return;
    }

    // Auto turn (lease signed) must exist before the notification handler runs
    // so its accounting happens under one exclusive turn (v4 §6 order).
    if (!turn) {
      turn = this.ensureAutoTurn();
    }

    // Fix 2 (通知直接销账): intercept harness task-notifications on the live
    // stream. Two shapes exist:
    // 1. queue-operation messages carrying a <task-notification> XML payload
    //    (the form observed in transcripts);
    // 2. system/subtype=task_notification structured messages (the SDK's
    //    typed spelling; 'stopped' there is the same terminal state as 'killed').
    // Neither shape is otherwise handled below, so settling here and returning
    // is safe. Session-load replay (collectAsyncSubagentResults) reads these
    // from the transcript independently — double settlement is tolerated.
    if (this.dispatchTaskNotification(message)) {
      return;
    }

    if (!turn) {
      // No lease owner could be established — drop the message but keep the
      // consumer loop alive.
      console.warn('[Claudian] message arrived with no turn lease; dropping', (message as { type?: string }).type);
      return;
    }
    const activeTurn = turn;

    // Transform SDK message to StreamChunks using the turn's own state
    for (const event of transformSDKMessage(message, this.getTransformOptions(activeTurn))) {
      this.noteVisibleStreamContent(message, event, {
        onText: () => {
          activeTurn.sawStreamText = true;
        },
        onThinking: () => {
          activeTurn.sawStreamThinking = true;
        },
      });

      if (isSessionInitEvent(event)) {
        this.applySessionInitSideEffects(event);
      } else if (isContextWindowEvent(event)) {
        const usageChunk = this.updateBufferedUsageContextWindow(activeTurn, event.contextWindow);
        if (!usageChunk) {
          continue;
        }
        this.deliverChunkToTurn(activeTurn, usageChunk);
      } else if (isStreamChunk(event)) {
        // Dedup: SDK delivers text via stream_events (incremental) AND the assistant message
        // (complete). Skip the assistant message text if stream text was already seen.
        if (message.type === 'assistant' && event.type === 'text') {
          if (activeTurn.sawStreamText) {
            continue;
          }
        }
        if (message.type === 'assistant' && event.type === 'thinking') {
          if (activeTurn.sawStreamThinking) {
            continue;
          }
        }

        // SDK auto-approves EnterPlanMode (checkPermissions → allow),
        // so canUseTool is never called. Detect the tool_use in the stream
        // and fire the sync callback to update the UI.
        if (event.type === 'tool_use' && event.name === TOOL_ENTER_PLAN_MODE) {
          if (this.currentConfig) {
            this.currentConfig.permissionMode = 'plan';
            this.currentConfig.sdkPermissionMode = 'plan';
          }
          if (this.permissionModeSyncCallback) {
            try { this.permissionModeSyncCallback('plan'); } catch { /* non-critical */ }
          }
        }

        const normalizedChunk = event.type === 'usage'
          ? this.bufferUsageChunk(activeTurn, { ...event, sessionId: this.sessionManager.getSessionId() })
          : event;

        this.deliverChunkToTurn(activeTurn, normalizedChunk);
      }
    }

    if (message.type === 'assistant' && message.uuid) {
      this.recordTurnMetadata(activeTurn, { assistantMessageId: message.uuid });
    }

    // Check for turn completion
    if (isTurnCompleteMessage(message)) {
      await this.settleTurnAtResult(activeTurn);
    }
  }

  /**
   * Lease-less session-level control message path: the message runs its
   * session-level side effects on a throwaway transform state but never
   * creates a RuntimeTurn, never signs the channel lease and never fires
   * onAutoTurnStarted. Generated chunks have no consumer and are dropped with
   * the scratch state — the transform only emits session_init (side effects
   * applied) / compact_boundary separator (only meaningful in a live turn)
   * for system messages; all other subtypes produce no output.
   */
  private applyLeaselessSystemMessage(message: SDKMessage): void {
    const scratch = createRuntimeTurn({
      id: `system-event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: 'auto',
      phase: 'collecting',
    });

    for (const event of transformSDKMessage(message, this.getTransformOptions(scratch))) {
      if (isSessionInitEvent(event)) {
        this.applySessionInitSideEffects(event);
      }
      // Everything else has no consumer — dropped with the scratch state.
    }
  }

  /** Session-level side effects of a session_init event, shared by the leased and lease-less routing paths. */
  private applySessionInitSideEffects(event: SessionInitEvent): void {
    // Fork: suppress needsHistoryRebuild since SDK returns a different session ID by design
    const wasFork = this.pendingForkSession;
    this.sessionManager.captureSession(event.sessionId);
    if (wasFork) {
      this.sessionManager.clearHistoryRebuild();
      this.pendingForkSession = false;
    }
    this.messageChannel?.setSessionId(event.sessionId);
    if (event.agents) {
      try { this.getAgentManager()?.setBuiltinAgentNames(event.agents); } catch { /* non-critical */ }
    }
    if (event.permissionMode && this.permissionModeSyncCallback) {
      try { this.permissionModeSyncCallback(event.permissionMode); } catch { /* non-critical */ }
    }
    // Cache SDK commands on init (SDK already scans the vault).
    // Pass the current query instance so late completions from a dead query
    // cannot overwrite the active cache after a restart or shutdown.
    void this.fetchAndCacheCommands(this.persistentQuery);
  }

  /** Returns the turn owning the channel lease, settling an unknown lease locally. */
  private resolveActiveTurn(): RuntimeTurn | null {
    const channel = this.messageChannel;
    const activeTurnId = channel ? channel.getActiveTurnId() : null;
    if (!activeTurnId) {
      return null;
    }
    const turn = this.runtimeTurns.get(activeTurnId) ?? null;
    if (!turn) {
      // Lease held for a turn unknown to the runtime (cancelled/crashed
      // earlier). v4 §3.3: settle that queue item, keep the consumer alive.
      console.warn('[Claudian] channel lease references unregistered turn; releasing', { turnId: activeTurnId });
      this.completeChannelTurn(activeTurnId);
    }
    return turn;
  }

  /**
   * Delivers a transformed chunk to the turn's live waiters. A turn without
   * waiters (SDK-initiated auto turn, or trailing content after an early
   * generator exit) buffers the chunk; settlement flushes it through the
   * auto-turn callback adapter.
   */
  private deliverChunkToTurn(turn: RuntimeTurn, chunk: StreamChunk): void {
    turn.receivedChunk = true;
    if (turn.waiters.size > 0) {
      for (const handler of turn.waiters) {
        handler.onChunk(chunk);
      }
      return;
    }
    turn.chunks.push(chunk);
  }

  /**
   * Creates the SDK-initiated (auto) turn for a message that arrived with no
   * channel lease: registers the turn, signs the external lease and fires
   * onAutoTurnStarted synchronously. If another turn raced us to the lease,
   * that turn is returned — a second lease is never created (v4 §3.3).
   */
  private ensureAutoTurn(): RuntimeTurn | null {
    const channel = this.messageChannel;
    const turn = createRuntimeTurn({
      id: `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: 'auto',
      phase: 'collecting',
    });

    if (!channel) {
      // Defensive: no channel → track the turn without a lease.
      this.runtimeTurns.set(turn.id, turn);
      this.fireOnAutoTurnStarted(turn);
      return turn;
    }

    let lease = channel.beginExternalTurn(turn.id);
    if (!lease.ok && lease.activeTurnId && !this.runtimeTurns.has(lease.activeTurnId)) {
      // Stale lease on an unregistered turn — release it and retry once.
      console.warn('[Claudian] beginExternalTurn found stale lease; releasing', { activeTurnId: lease.activeTurnId });
      this.completeChannelTurn(lease.activeTurnId);
      lease = channel.beginExternalTurn(turn.id);
    }

    if (lease.ok) {
      this.runtimeTurns.set(turn.id, turn);
      this.fireOnAutoTurnStarted(turn);
      return turn;
    }

    // An existing registered turn owns the lease — process under it.
    if (lease.activeTurnId && this.runtimeTurns.has(lease.activeTurnId)) {
      return this.runtimeTurns.get(lease.activeTurnId)!;
    }
    return null;
  }

  private fireOnAutoTurnStarted(turn: RuntimeTurn): void {
    try {
      this._onAutoTurnStarted?.({ turnId: turn.id, generation: turn.generation });
    } catch (error) {
      // Feature callback must never break the consumer loop.
      console.warn('[Claudian] onAutoTurnStarted callback failed', error);
    }
  }

  private fireOnAutoTurnFinished(turnId: string): void {
    try {
      this._onAutoTurnFinished?.(turnId);
    } catch (error) {
      console.warn('[Claudian] onAutoTurnFinished callback failed', error);
    }
  }

  private fireOnAutoTurnReleased(turnId: string): void {
    try {
      this._onAutoTurnReleased?.(turnId);
    } catch (error) {
      console.warn('[Claudian] onAutoTurnReleased callback failed', error);
    }
  }

  private fireOnAutoTurnCancelled(turnId: string, generation: number, reason: string): void {
    try {
      this._onAutoTurnCancelled?.({ turnId, generation, reason });
    } catch (error) {
      console.warn('[Claudian] onAutoTurnCancelled callback failed', error);
    }
  }

  /**
   * Terminal settlement on an SDK result message, in the fixed v4 §3.1 order:
   * projecting → feature projection → finishFeatureTurn → deferred restart →
   * settle → completeTurn (releases dequeue) → onTurnReleased.
   *
   * User turns: the feature generator owns projection/finalize and clears its
   * own lease in sendMessage()'s finally; the runtime-side order here runs
   * projecting → onDone → deferred restart → settle → completeTurn (the full
   * seven-step order with runtime-driven projection lands with S4).
   *
   * Auto turns: the complete order runs here — legacy-adapter projection
   * (S2), feature finish, deferred restart, settle, channel release, then
   * the released signal that lets the UI queue proceed.
   */
  private async settleTurnAtResult(turn: RuntimeTurn): Promise<void> {
    turn.phase = 'projecting';

    if (turn.waiters.size > 0) {
      // Feature layer consumes this after the generator drains.
      this.pendingFeatureTurnMetadata = { ...turn.metadata };
      for (const handler of turn.waiters) {
        handler.resetStreamText();
        handler.resetStreamThinking();
        handler.onDone();
      }
      turn.waiters.clear();
      await this.executeDeferredRestartIfAny(turn.id);
      turn.phase = 'settled';
      this.runtimeTurns.delete(turn.id);
      this.completeChannelTurn(turn.id);
      return;
    }

    // Auto turn (or a user turn whose generator already exited): buffered
    // chunks flush through the legacy adapter (kept until S4 projection).
    if (turn.chunks.length > 0) {
      const chunks = [...turn.chunks];
      const metadata = { ...turn.metadata };
      turn.chunks = [];
      try {
        this._autoTurnCallback?.({ chunks, metadata });
      } catch {
        new Notice('Background task completed, but the result could not be rendered.');
      }
    }

    // v4 §3.1 step 3: feature clears its lease before the channel releases.
    // Only auto turns drive the lifecycle callbacks — a user turn whose
    // generator exited early keeps its feature lease until sendMessage()'s
    // finally runs (S4 moves user projection onto this order as well).
    if (turn.kind === 'auto') {
      this.fireOnAutoTurnFinished(turn.id);
    }
    // Step 4: deferred config restart runs only when the channel is idle
    // (this turn's lease excepted), i.e. strictly before the next queued
    // user turn dequeues (step 6).
    await this.executeDeferredRestartIfAny(turn.id);
    // Step 5: settle — phase, registry entry, waiters are all gone.
    turn.phase = 'settled';
    this.runtimeTurns.delete(turn.id);
    // Step 6: release the lease so the async iterator may dequeue the next
    // queued user message.
    this.completeChannelTurn(turn.id);
    // Step 7: no active lease remains — the UI queued message may proceed.
    if (turn.kind === 'auto') {
      this.fireOnAutoTurnReleased(turn.id);
    }
  }

  /** Channel dequeue hook: a user message left the queue and now owns the lease. */
  private handleTurnDequeued(turnId: string): void {
    const turn = this.runtimeTurns.get(turnId);
    if (!turn) {
      // v4 §3.3 dequeue mismatch: the runtime no longer knows this turn
      // (cancelled earlier). Release the item and continue with the next.
      console.warn('[Claudian] dequeued message for unregistered turn; releasing', { turnId });
      this.completeChannelTurn(turnId);
      return;
    }
    if (turn.phase === 'queued') {
      turn.phase = 'collecting';
    }
  }

  /**
   * Re-registers a turn that a failed attempt already settled (session-expired
   * retry, pre-send restart, crash-recovery replay). The abort controller is
   * replaced: reusing one that cancel() already aborted would make the retry
   * break on its first aborted-signal check (S1 leftover #2).
   */
  private reRegisterTurnForRetry(turn: RuntimeTurn): void {
    turn.abortController = new AbortController();
    turn.phase = 'queued';
    this.runtimeTurns.set(turn.id, turn);
    if (this.abortController) {
      this.abortController = turn.abortController;
    }
  }

  /**
   * Releases the channel lease for a turn. A mismatch is settled locally
   * (v4 §3.3): cancel the turn that actually holds the lease, retry the
   * release once; only a lease stuck on an unknown turn closes the channel.
   * Never throws — the consumer loop must survive protocol errors.
   */
  private completeChannelTurn(turnId: string): void {
    const channel = this.messageChannel;
    if (!channel) {
      return;
    }
    const result = channel.completeTurn(turnId);
    if (result.ok) {
      return;
    }

    console.warn('[Claudian] completeTurn mismatch', {
      turnId,
      code: result.code,
      activeTurnId: result.activeTurnId,
    });

    const actualActive = result.activeTurnId;
    if (actualActive && actualActive !== turnId) {
      if (this.runtimeTurns.has(actualActive)) {
        // Cancel the reported actual active turn (also releases its lease).
        this.cancelTurn(actualActive, 'complete_turn_mismatch');
      } else {
        const release = channel.completeTurn(actualActive);
        if (!release.ok) {
          // Stuck lease on an unknown turn — close and settle everything.
          this.closePersistentQuery('message channel lease protocol error');
          return;
        }
      }
    }

    const retry = channel.completeTurn(turnId);
    if (retry.ok || retry.activeTurnId === null) {
      // Free lease (double completion) — nothing stuck.
      return;
    }
    if (this.runtimeTurns.has(retry.activeTurnId)) {
      // A live turn owns the lease now and settles itself on its own result.
      return;
    }
    this.closePersistentQuery('message channel lease protocol error');
  }

  /**
   * Forces a turn to its terminal state (v3 §4.2 / v4 §3.2): phase/generation
   * /abort → feature cancellation (auto turns only, strictly before channel
   * release) → dequeue removal → waiter settlement → delete → lease release.
   * Plain cancellation settles waiters with onDone; failures with onError.
   */
  private cancelTurn(turnId: string, reason: string, error?: Error): void {
    const turn = this.runtimeTurns.get(turnId);
    if (!turn) {
      return;
    }

    turn.phase = 'cancelled';
    turn.generation += 1;
    try {
      turn.abortController.abort();
    } catch {
      // Already aborted
    }

    // Feature cancellation first: the feature layer clears only this turn's
    // lease-created state and never writes new state (v4 §3.2).
    if (turn.kind === 'auto') {
      this.fireOnAutoTurnCancelled(turn.id, turn.generation, reason);
    }

    // Still queued → remove the item so it never dequeues.
    this.messageChannel?.cancelQueuedTurn(turnId);

    // A cancelled user turn still hands its metadata (message ids, wasSent)
    // to the feature layer: the trailing SDK result is dropped lease-less by
    // routeMessage, so this is the last chance for rewind/fork anchoring.
    if (turn.kind === 'user' && turn.waiters.size > 0) {
      this.pendingFeatureTurnMetadata = { ...turn.metadata };
    }

    // Settle waiters and delete the turn before releasing the lease, so the
    // next queued message can only flow after this turn is fully settled.
    for (const handler of turn.waiters) {
      if (error) {
        handler.onError(error);
      } else {
        handler.onDone();
      }
    }
    turn.waiters.clear();
    this.runtimeTurns.delete(turnId);

    // Holds the lease → release so the next queued message can flow.
    if (this.messageChannel?.getActiveTurnId() === turnId) {
      this.completeChannelTurn(turnId);
    }
  }

  /** Cancels every live turn plus any turn still holding channel state. */
  private cancelAllTurns(reason: string, error?: Error): void {
    const channelIds = this.messageChannel ? this.messageChannel.cancelAll() : [];
    const turnIds = new Set<string>([...channelIds, ...this.runtimeTurns.keys()]);
    for (const id of turnIds) {
      this.cancelTurn(id, reason, error);
    }
  }

  /**
   * Executes a config restart that was deferred while a turn was mid-flight.
   * Fires only when the channel is fully idle (no active lease other than the
   * turn currently settling, empty queue) so no queued message is dropped by
   * the rebuild. v4 §3.1 step 4: runs after the feature lease is gone and
   * before the channel releases the dequeue.
   */
  private async executeDeferredRestartIfAny(exemptTurnId?: string): Promise<void> {
    const paths = this.deferredRestartPaths;
    if (!paths) {
      return;
    }
    const channel = this.messageChannel;
    if (!this.persistentQuery || !channel) {
      this.deferredRestartPaths = null;
      return;
    }
    const activeTurnId = channel.getActiveTurnId();
    const busyWithAnotherTurn = activeTurnId !== null && activeTurnId !== exemptTurnId;
    if (busyWithAnotherTurn || channel.getQueueLength() > 0) {
      // Still busy — retry after the next settle.
      return;
    }
    this.deferredRestartPaths = null;
    try {
      await this.ensureReady({ force: true, externalContextPaths: paths });
    } catch (error) {
      console.warn('[Claudian] deferred restart failed; next query will retry', error);
    }
  }

  /**
   * Fix 2 (通知直接销账): parses a live message as a harness task-notification
   * and forwards it to the notification handler. Returns true when the message
   * was a task-notification (and has been fully handled here).
   */
  private dispatchTaskNotification(message: SDKMessage): boolean {
    if (!this._subagentNotificationHandler) {
      return false;
    }

    let taskId: string | null;
    let status: string | null;
    let result: string | null;

    const record = message as Record<string, unknown>;

    if (record['type'] === 'queue-operation') {
      if (record['operation'] !== 'enqueue' || typeof record['content'] !== 'string') {
        return false;
      }
      const content = record['content'];
      if (!content.includes('<task-notification>')) {
        return false;
      }
      taskId = extractXmlTag(content, 'task-id');
      status = extractXmlTag(content, 'status');
      result = extractXmlTag(content, 'result');
    } else if (record['type'] === 'system' && record['subtype'] === 'task_notification') {
      if (typeof record['task_id'] !== 'string' || typeof record['status'] !== 'string') {
        return false;
      }
      taskId = record['task_id'];
      status = record['status'];
      result = typeof record['summary'] === 'string' ? record['summary'] : null;
    } else {
      return false;
    }

    if (!taskId || !status) {
      console.warn('[Claudian] task-notification arrived without task-id/status; ignoring');
      return true;
    }

    try {
      this._subagentNotificationHandler(taskId, status, result);
    } catch (error) {
      // Settlement must never break the message routing loop.
      console.warn('[Claudian] task-notification handler failed', error);
    }
    return true;
  }

  setSubagentNotificationHandler(handler: SubagentTaskNotificationHandler | null): void {
    this._subagentNotificationHandler = handler;
  }

  private registerResponseHandler(handler: ResponseHandler): void {
    this.responseHandlers.push(handler);
  }

  private unregisterResponseHandler(handlerId: string): void {
    const idx = this.responseHandlers.findIndex(h => h.id === handlerId);
    if (idx >= 0) {
      this.responseHandlers.splice(idx, 1);
    }
  }

  private buildLegacyTurnRequest(
    prompt: string,
    images?: ImageAttachment[],
    queryOptions?: QueryOptions,
  ): ChatTurnRequest {
    return {
      // Legacy string-overload entry has no feature-layer turnId; mint one
      // here (test/internal callers only) so every PreparedChatTurn still
      // carries a single-source id. Feature callers pass theirs through
      // prepareTurn and the runtime never regenerates it.
      turnId: `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: prompt,
      images,
      externalContextPaths: queryOptions?.externalContextPaths,
      enabledMcpServers: queryOptions?.enabledMcpServers,
    };
  }

  private buildQueryOptionsFromTurnRequest(
    request: ChatTurnRequest,
    encodedTurn: PreparedChatTurn,
    legacyQueryOptions?: QueryOptions,
  ): QueryOptions | undefined {
    const mcpMentions = legacyQueryOptions?.mcpMentions
      ? new Set([...legacyQueryOptions.mcpMentions, ...encodedTurn.mcpMentions])
      : encodedTurn.mcpMentions;

    const effectiveQueryOptions: QueryOptions = {
      allowedTools: legacyQueryOptions?.allowedTools,
      model: legacyQueryOptions?.model,
      mcpMentions,
      enabledMcpServers: request.enabledMcpServers ?? legacyQueryOptions?.enabledMcpServers,
      forceColdStart: legacyQueryOptions?.forceColdStart,
      externalContextPaths: request.externalContextPaths ?? legacyQueryOptions?.externalContextPaths,
    };

    if (
      effectiveQueryOptions.allowedTools === undefined &&
      effectiveQueryOptions.model === undefined &&
      effectiveQueryOptions.enabledMcpServers === undefined &&
      effectiveQueryOptions.forceColdStart === undefined &&
      effectiveQueryOptions.externalContextPaths === undefined &&
      (effectiveQueryOptions.mcpMentions?.size ?? 0) === 0
    ) {
      return undefined;
    }

    return effectiveQueryOptions;
  }

  private normalizeTurnInvocation(
    turnOrPrompt: PreparedChatTurn | string,
    imagesOrHistory?: ImageAttachment[] | ChatMessage[],
    conversationHistoryOrQueryOptions?: ChatMessage[] | QueryOptions,
    legacyQueryOptions?: QueryOptions,
  ): {
    request: ChatTurnRequest;
    encodedTurn: PreparedChatTurn;
    conversationHistory?: ChatMessage[];
    queryOptions?: QueryOptions;
  } {
    if (typeof turnOrPrompt !== 'string') {
      const turn = turnOrPrompt;
      const conversationHistory = isChatMessageArray(imagesOrHistory)
        ? imagesOrHistory
        : undefined;
      const explicitQueryOptions = isChatMessageArray(conversationHistoryOrQueryOptions)
        ? undefined
        : conversationHistoryOrQueryOptions as QueryOptions | undefined;
      return {
        request: turn.request,
        encodedTurn: turn,
        conversationHistory,
        queryOptions: this.buildQueryOptionsFromTurnRequest(turn.request, turn, explicitQueryOptions),
      };
    }

    const images = isImageAttachmentArray(imagesOrHistory) ? imagesOrHistory : undefined;
    const conversationHistory = isChatMessageArray(conversationHistoryOrQueryOptions)
      ? conversationHistoryOrQueryOptions
      : undefined;
    const queryOptions = isChatMessageArray(conversationHistoryOrQueryOptions)
      ? legacyQueryOptions
      : conversationHistoryOrQueryOptions ?? legacyQueryOptions;
    const request = this.buildLegacyTurnRequest(turnOrPrompt, images, queryOptions);
    const encodedTurn = this.prepareTurn(request);

    return {
      request,
      encodedTurn,
      conversationHistory,
      queryOptions: this.buildQueryOptionsFromTurnRequest(request, encodedTurn, queryOptions),
    };
  }

  isPersistentQueryActive(): boolean {
    return this.persistentQuery !== null && !this.shuttingDown;
  }

  /**
   * Sends a query to Claude and streams the response.
   *
   * Query selection:
   * - Persistent query: default chat conversation
   * - Cold-start query: only when forceColdStart is set
   */
  query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions,
  ): AsyncGenerator<StreamChunk>;
  query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions,
  ): AsyncGenerator<StreamChunk>;
  async *query(
    turnOrPrompt: PreparedChatTurn | string,
    imagesOrHistory?: ImageAttachment[] | ChatMessage[],
    conversationHistoryOrQueryOptions?: ChatMessage[] | QueryOptions,
    legacyQueryOptions?: QueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const normalized = this.normalizeTurnInvocation(
      turnOrPrompt,
      imagesOrHistory,
      conversationHistoryOrQueryOptions,
      legacyQueryOptions,
    );
    const prompt = normalized.encodedTurn.prompt;
    const images = normalized.request.images;
    const conversationHistory = normalized.conversationHistory;
    const queryOptions = normalized.queryOptions;

    // v4 §2.1: the user turnId comes from the feature layer (PreparedChatTurn).
    // The runtime neither regenerates it nor accepts an empty/duplicate one.
    const turnId = normalized.encodedTurn.turnId;
    if (!turnId) {
      yield { type: 'error', content: 'Protocol error: query() requires a non-empty turnId' };
      return;
    }
    if (this.runtimeTurns.has(turnId)) {
      yield { type: 'error', content: `Protocol error: turnId '${turnId}' is already in flight` };
      return;
    }

    // Fix 1 (熔断): a user-initiated turn resets the consecutive Stop-hook
    // block count — the breaker scope is "since last user message / last allow".
    this._stopHookConsecutiveBlocks = 0;

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: 'Could not determine vault path' };
      return;
    }

    const resolvedClaudePath = this.plugin.getResolvedProviderCliPath('claude');
    if (!resolvedClaudePath) {
      yield { type: 'error', content: 'Claude CLI not found. Please install Claude Code CLI.' };
      return;
    }

    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables(this.providerId));
    const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedClaudePath);
    const missingNodeError = getMissingNodeError(resolvedClaudePath, enhancedPath);
    if (missingNodeError) {
      yield { type: 'error', content: missingNodeError };
      return;
    }

    // Register the user RuntimeTurn for this query (both persistent and
    // cold-start paths consume it). Deletion happens at settlement, cancel or
    // generator cleanup — never by re-generating the id.
    const turn = createRuntimeTurn({ id: turnId, kind: 'user' });
    this.runtimeTurns.set(turnId, turn);
    // Fresh turn must not inherit a previous turn's unconsumed metadata.
    this.pendingFeatureTurnMetadata = {};

    // Rebuild history if needed before choosing persistent vs cold-start
    let promptToSend = prompt;
    let forceColdStart = false;

    // Clear interrupted flag - persistent query handles interruption gracefully,
    // no need to force cold-start just because user cancelled previous response
    if (this.sessionManager.wasInterrupted()) {
      this.sessionManager.clearInterrupted();
    }

    // Session mismatch recovery: SDK returned a different session ID (context lost)
    // Inject history to restore context without forcing cold-start
    if (this.sessionManager.needsHistoryRebuild() && conversationHistory && conversationHistory.length > 0) {
      const historyContext = buildContextFromHistory(conversationHistory);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
      this.sessionManager.clearHistoryRebuild();
    }

    const noSessionButHasHistory = !this.sessionManager.getSessionId() &&
      conversationHistory && conversationHistory.length > 0;

    if (noSessionButHasHistory) {
      const historyContext = buildContextFromHistory(conversationHistory!);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory!);

      // Note: Do NOT call invalidateSession() here. The cold-start will capture
      // a new session ID anyway, and invalidating would break any persistent query
      // restart that happens during the cold-start (causing SESSION MISMATCH).
      forceColdStart = true;
    }

    const effectiveQueryOptions = forceColdStart
      ? { ...queryOptions, forceColdStart: true }
      : queryOptions;

    if (forceColdStart) {
      // Set flag BEFORE closing to prevent consumer error from triggering restart
      this.coldStartInProgress = true;
      this.closePersistentQuery('session invalidated');
    }

    // Determine query path: persistent vs cold-start
    const shouldUsePersistent = !effectiveQueryOptions?.forceColdStart;

    if (shouldUsePersistent) {
      // Start persistent query if not running
      if (!this.persistentQuery && !this.shuttingDown) {
        await this.startPersistentQuery(
          vaultPath,
          resolvedClaudePath,
          this.sessionManager.getSessionId() ?? undefined
        );
      }

      if (this.persistentQuery && !this.shuttingDown) {
        // Use persistent query path
        try {
          yield* this.queryViaPersistent(promptToSend, images, vaultPath, resolvedClaudePath, effectiveQueryOptions, turn);
          return;
        } catch (error) {
          if (isSessionExpiredError(error) && conversationHistory && conversationHistory.length > 0) {
            this.sessionManager.invalidateSession();
            const retryRequest = this.buildHistoryRebuildRequest(prompt, conversationHistory);

            this.coldStartInProgress = true;
            // The failed attempt settled the turn in its finally block —
            // re-register it so the retry reuses the same turnId/lease slot.
            this.reRegisterTurnForRetry(turn);
            this.abortController = turn.abortController;

            try {
              yield* this.queryViaSDK(
                retryRequest.prompt,
                vaultPath,
                resolvedClaudePath,
                // Use current message's images, fallback to history images
                images ?? retryRequest.images,
                effectiveQueryOptions,
                turn
              );
            } catch (retryError) {
              const msg = retryError instanceof Error ? retryError.message : 'Unknown error';
              yield { type: 'error', content: msg };
            } finally {
              this.coldStartInProgress = false;
              this.abortController = null;
            }
            return;
          }

          throw error;
        }
      }
    }

    // Cold-start path (existing logic)
    // Set flag to prevent consumer error restarts from interfering
    this.coldStartInProgress = true;
    this.abortController = turn.abortController;

    try {
      yield* this.queryViaSDK(promptToSend, vaultPath, resolvedClaudePath, images, effectiveQueryOptions, turn);
    } catch (error) {
      if (isSessionExpiredError(error) && conversationHistory && conversationHistory.length > 0) {
        this.sessionManager.invalidateSession();
        const retryRequest = this.buildHistoryRebuildRequest(prompt, conversationHistory);

        // Re-register the turn settled by the failed attempt (same turnId).
        this.reRegisterTurnForRetry(turn);

        try {
          yield* this.queryViaSDK(
            retryRequest.prompt,
            vaultPath,
            resolvedClaudePath,
            // Use current message's images, fallback to history images
            images ?? retryRequest.images,
            effectiveQueryOptions,
            turn
          );
        } catch (retryError) {
          const msg = retryError instanceof Error ? retryError.message : 'Unknown error';
          yield { type: 'error', content: msg };
        }
        return;
      }

      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.coldStartInProgress = false;
      this.abortController = null;
    }
  }

  private buildHistoryRebuildRequest(
    prompt: string,
    conversationHistory: ChatMessage[]
  ): { prompt: string; images?: ImageAttachment[] } {
    const historyContext = buildContextFromHistory(conversationHistory);
    const actualPrompt = stripCurrentNoteContext(prompt);
    const fullPrompt = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
    const lastUserMessage = getLastUserMessage(conversationHistory);

    return {
      prompt: fullPrompt,
      images: lastUserMessage?.images,
    };
  }

  /**
   * Query via persistent query (Phase 1.5).
   * Uses the message channel to send messages without cold-start latency.
   */
  private async *queryViaPersistent(
    prompt: string,
    images: ImageAttachment[] | undefined,
    vaultPath: string,
    cliPath: string,
    queryOptions?: QueryOptions,
    turn?: RuntimeTurn
  ): AsyncGenerator<StreamChunk> {
    // v4 §2.1: the turn (and its feature-layer turnId) is created in query();
    // the runtime must never mint a fallback user turn here.
    if (!turn) {
      yield { type: 'error', content: 'Protocol error: queryViaPersistent requires a RuntimeTurn' };
      return;
    }
    if (!this.persistentQuery || !this.messageChannel) {
      // Fallback to cold-start if persistent query not available
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, images, queryOptions, turn);
      return;
    }

    // Set allowed tools for canUseTool enforcement
    // undefined = no restriction, [] = no tools, [...] = restricted
    if (queryOptions?.allowedTools !== undefined) {
      this.currentAllowedTools = queryOptions.allowedTools.length > 0
        ? [...queryOptions.allowedTools, TOOL_SKILL]
        : [];
    } else {
      this.currentAllowedTools = null;
    }

    // Save allowedTools before applyDynamicUpdates - restart would clear it
    const savedAllowedTools = this.currentAllowedTools;

    // Apply dynamic updates before sending (Phase 1.6). With an active turn
    // on the channel this only defers a config restart instead of rebuilding.
    await this.applyDynamicUpdates(queryOptions);

    // Restore allowedTools in case restart cleared it
    this.currentAllowedTools = savedAllowedTools;

    // An immediate pre-send restart settles every live turn — including this
    // one, whose message has not been enqueued yet. Re-register it so the
    // channel lease below resolves against a live turn.
    if (this.runtimeTurns.get(turn.id) !== turn) {
      this.reRegisterTurnForRetry(turn);
    }

    // Check if applyDynamicUpdates triggered a restart that failed
    // (e.g., CLI path not found, vault path missing)
    if (!this.persistentQuery || !this.messageChannel) {
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, images, queryOptions, turn);
      return;
    }
    if (!this.responseConsumerRunning) {
      yield* this.queryViaSDK(prompt, vaultPath, cliPath, images, queryOptions, turn);
      return;
    }

    const message = this.buildSDKUserMessage(prompt, images);

    // Create a promise-based handler to yield chunks
    // Use a mutable state object to work around TypeScript's control flow analysis
    const state = {
      chunks: [] as StreamChunk[],
      resolveChunk: null as ((chunk: StreamChunk | null) => void) | null,
      done: false,
      error: null as Error | null,
    };

    const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handler = createResponseHandler({
      id: handlerId,
      onChunk: (chunk) => {
        handler.markChunkSeen();
        if (state.resolveChunk) {
          state.resolveChunk(chunk);
          state.resolveChunk = null;
        } else {
          state.chunks.push(chunk);
        }
      },
      onDone: () => {
        state.done = true;
        if (state.resolveChunk) {
          state.resolveChunk(null);
          state.resolveChunk = null;
        }
      },
      onError: (err) => {
        state.error = err;
        state.done = true;
        if (state.resolveChunk) {
          state.resolveChunk(null);
          state.resolveChunk = null;
        }
      },
    });

    this.registerResponseHandler(handler);
    turn.waiters.add(handler);

    try {
      // Track message for crash recovery (Phase 1.3)
      this.lastSentMessage = message;
      this.lastSentQueryOptions = queryOptions ?? null;
      this.lastSentTurnId = turn.id;
      this.crashRecoveryAttempted = false;

      // Enqueue the message with race condition protection
      // The channel could close between our null check above and this call
      try {
        const enqueueResult = this.messageChannel.enqueue(turn.id, message);
        if (enqueueResult.dropped) {
          // Queue overflow dropped this message (S1 leftover #1): settle the
          // turn immediately instead of leaving its handler waiting on a
          // lease that will never come. The dropped message must not remain
          // eligible for crash-recovery replay either. onError flips
          // state.done, so the loop below is skipped and the error is
          // yielded on the shared drain path.
          this.lastSentMessage = null;
          this.lastSentQueryOptions = null;
          this.lastSentTurnId = null;
          handler.onError(new Error('Message queue is full; the newest message was dropped.'));
        } else if (enqueueResult.canonicalTurnId !== turn.id) {
          // Merged into an already queued item (text merge / attachment
          // replace): join the canonical turn's lease so our handler receives
          // that turn's chunks and settlement.
          turn.mergedInto = enqueueResult.canonicalTurnId;
          const canonical = this.runtimeTurns.get(enqueueResult.canonicalTurnId);
          if (canonical) {
            canonical.waiters.add(handler);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('closed')) {
          yield* this.queryViaSDK(prompt, vaultPath, cliPath, images, queryOptions, turn);
          return;
        }
        throw error;
      }
      this.recordTurnMetadata(turn, {
        userMessageId: message.uuid ?? undefined,
        wasSent: true,
      });

      // Yield chunks as they arrive
      while (!state.done) {
        if (state.chunks.length > 0) {
          yield state.chunks.shift()!;
        } else {
          const chunk = await new Promise<StreamChunk | null>((resolve) => {
            state.resolveChunk = resolve;
          });
          if (chunk) {
            yield chunk;
          }
        }
      }

      // Yield any remaining chunks
      while (state.chunks.length > 0) {
        yield state.chunks.shift()!;
      }

      // Check if an error occurred (assigned in onError callback)
      if (state.error) {
        // Re-throw session expired errors for outer retry logic to handle
        if (isSessionExpiredError(state.error)) {
          throw state.error;
        }
        yield { type: 'error', content: state.error.message };
      }

      // Clear message tracking after completion
      this.lastSentMessage = null;
      this.lastSentQueryOptions = null;
      this.lastSentTurnId = null;

      yield { type: 'done' };
    } finally {
      this.unregisterResponseHandler(handlerId);
      this.currentAllowedTools = null;
      this.finishTurnFromGenerator(turn, handler);
    }
  }

  /**
   * Generator-side turn cleanup. A still-queued turn (its message never
   * dequeued) is fully retractable: drop the queue item and the registry
   * entry. A collecting turn is left to the runtime — the SDK emits its
   * result (or a close/cancel path settles it) and trailing chunks flush
   * through the auto-turn adapter since the generator no longer waits.
   */
  private finishTurnFromGenerator(turn: RuntimeTurn, handler: ResponseHandler): void {
    turn.waiters.delete(handler);
    if (turn.mergedInto) {
      const canonical = this.runtimeTurns.get(turn.mergedInto);
      canonical?.waiters.delete(handler);
    }
    if (turn.phase === 'queued') {
      this.messageChannel?.cancelQueuedTurn(turn.id);
      this.runtimeTurns.delete(turn.id);
    }
  }

  private buildSDKUserMessage(prompt: string, images?: ImageAttachment[]): SDKUserMessage {
    return buildClaudeSDKUserMessage(
      prompt,
      this.sessionManager.getSessionId() || '',
      images,
    );
  }

  /**
   * Apply dynamic updates to the persistent query before sending a message (Phase 1.6).
   */
  private async applyDynamicUpdates(
    queryOptions?: QueryOptions,
    restartOptions?: ClosePersistentQueryOptions,
    allowRestart = true
  ): Promise<void> {
    await applyClaudeDynamicUpdates(
      {
        getPersistentQuery: () => this.persistentQuery,
        getCurrentConfig: () => this.currentConfig,
        mutateCurrentConfig: (mutate) => {
          if (this.currentConfig) {
            mutate(this.currentConfig);
          }
        },
        getVaultPath: () => this.vaultPath,
        getCliPath: () => this.plugin.getResolvedProviderCliPath('claude'),
        getScopedSettings: () => this.getScopedSettings(),
        getPermissionMode: () => this.plugin.settings.permissionMode,
        resolveSDKPermissionMode: (mode) => this.resolveSDKPermissionMode(mode),
        mcpManager: this.mcpManager,
        buildPersistentQueryConfig: (vaultPath, cliPath, externalContextPaths) =>
          this.buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths),
        needsRestart: (newConfig) => this.needsRestart(newConfig),
        ensureReady: (options) => this.ensureReady(options),
        setCurrentExternalContextPaths: (paths) => {
          this.currentExternalContextPaths = paths;
        },
        notifyFailure: (message) => {
          new Notice(message);
        },
        hasActiveTurn: () => this.messageChannel?.getActiveTurnId?.() != null,
        setDeferredRestart: (paths) => {
          this.deferredRestartPaths = paths;
        },
      },
      queryOptions,
      restartOptions,
      allowRestart,
    );
  }

  private noteVisibleStreamContent(
    message: SDKMessage,
    event: TransformEvent,
    callbacks: { onText: () => void; onThinking: () => void },
  ): void {
    // Drive dedup off transformed chunks rather than raw SDK message shapes.
    // transformSDKMessage already filters out empty payloads and subagent-only
    // stream events, so these callbacks only fire for content the user can see.
    if (message.type !== 'stream_event') {
      return;
    }

    if (event.type === 'text') {
      callbacks.onText();
    } else if (event.type === 'thinking') {
      callbacks.onThinking();
    }
  }

  private buildPromptWithImages(prompt: string, images?: ImageAttachment[]): string | AsyncGenerator<any> {
    return buildClaudePromptWithImages(prompt, images);
  }

  private async *queryViaSDK(
    prompt: string,
    cwd: string,
    cliPath: string,
    images?: ImageAttachment[],
    queryOptions?: QueryOptions,
    turn?: RuntimeTurn
  ): AsyncGenerator<StreamChunk> {
    if (!turn) {
      yield { type: 'error', content: 'Protocol error: queryViaSDK requires a RuntimeTurn' };
      return;
    }
    turn.phase = 'collecting';
    const selectedModel = queryOptions?.model || this.getScopedSettings().model;

    this.sessionManager.setPendingModel(selectedModel);
    this.vaultPath = cwd;

    const queryPrompt = this.buildPromptWithImages(prompt, images);
    const baseContext = this.buildQueryOptionsContext(cwd, cliPath);
    const externalContextPaths = queryOptions?.externalContextPaths || [];
    const hooks = this.buildHooks();
    const hasEditorContext = prompt.includes('<editor_selection');

    let allowedTools: string[] | undefined;
    if (queryOptions?.allowedTools !== undefined && queryOptions.allowedTools.length > 0) {
      const toolSet = new Set([...queryOptions.allowedTools, TOOL_SKILL]);
      allowedTools = [...toolSet];
    }

    const ctx: ColdStartQueryContext = {
      ...baseContext,
      abortController: this.abortController ?? undefined,
      sessionId: this.sessionManager.getSessionId() ?? undefined,
      modelOverride: queryOptions?.model,
      canUseTool: this.createApprovalCallback(),
      hooks,
      mcpMentions: queryOptions?.mcpMentions,
      enabledMcpServers: queryOptions?.enabledMcpServers,
      allowedTools,
      hasEditorContext,
      externalContextPaths,
    };

    const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

    try {
      const response = agentQuery({ prompt: queryPrompt, options });
      this.recordTurnMetadata(turn, { wasSent: true });
      let streamSessionId: string | null = this.sessionManager.getSessionId();

      for await (const message of response) {
        if (this.abortController?.signal.aborted) {
          await response.interrupt();
          break;
        }

        for (const event of transformSDKMessage(message, this.getTransformOptions(turn, selectedModel))) {
          this.noteVisibleStreamContent(message, event, {
            onText: () => {
              turn.sawStreamText = true;
            },
            onThinking: () => {
              turn.sawStreamThinking = true;
            },
          });

          if (isSessionInitEvent(event)) {
            this.sessionManager.captureSession(event.sessionId);
            streamSessionId = event.sessionId;
          } else if (isContextWindowEvent(event)) {
            const usageChunk = this.updateBufferedUsageContextWindow(turn, event.contextWindow);
            if (usageChunk) {
              yield usageChunk;
            }
          } else if (isStreamChunk(event)) {
            if (message.type === 'assistant' && turn.sawStreamText && event.type === 'text') {
              continue;
            }
            if (message.type === 'assistant' && turn.sawStreamThinking && event.type === 'thinking') {
              continue;
            }
            if (event.type === 'usage') {
              yield this.bufferUsageChunk(turn, { ...event, sessionId: streamSessionId });
            } else {
              yield event;
            }
          }
        }

        if (message.type === 'assistant' && message.uuid) {
          this.recordTurnMetadata(turn, { assistantMessageId: message.uuid });
        }
      }
    } catch (error) {
      // Re-throw session expired errors for outer retry logic to handle
      if (isSessionExpiredError(error)) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : 'Unknown error';
      yield { type: 'error', content: msg };
    } finally {
      this.sessionManager.clearPendingModel();
      this.currentAllowedTools = null; // Clear tool restriction after query
      this.settleColdStartTurn(turn);
    }

    yield { type: 'done' };
  }

  /**
   * Cold-start turns have no channel lease; settle them when the generator
   * ends and hand the turn's metadata to the feature layer (consumed via
   * consumeTurnMetadata after the stream finishes).
   */
  private settleColdStartTurn(turn: RuntimeTurn): void {
    if (this.runtimeTurns.get(turn.id) !== turn) {
      // Already settled/cancelled elsewhere (e.g. session-expired retry reuses
      // a fresh registration) — nothing to do.
      return;
    }
    turn.phase = 'settled';
    this.pendingFeatureTurnMetadata = { ...turn.metadata };
    this.runtimeTurns.delete(turn.id);
  }

  cancel() {
    this.approvalDismisser?.();

    if (this.abortController) {
      this.abortController.abort();
      this.sessionManager.markInterrupted();
    }

    // v3 §4.2: user cancel settles the active turn itself (queued user turns
    // are kept). A trailing SDK result for the settled turn then arrives
    // lease-less and is dropped by routeMessage instead of creating a ghost
    // auto turn (S1 leftover #3).
    const activeTurnId = this.messageChannel?.getActiveTurnId() ?? null;
    if (activeTurnId && this.runtimeTurns.has(activeTurnId)) {
      this.cancelTurn(activeTurnId, 'user_cancel');
    }

    // Interrupt persistent query (Phase 1.9)
    if (this.persistentQuery && !this.shuttingDown) {
      void this.persistentQuery.interrupt().catch(() => {
        // Silence abort/interrupt errors
      });
    }
  }

  /**
   * Reset the conversation session.
   * Closes the persistent query since session is changing.
   */
  resetSession() {
    // Close persistent query (new session will use cold-start resume)
    this.closePersistentQuery('session reset');

    // Reset crash recovery for fresh start
    this.crashRecoveryAttempted = false;

    this.sessionManager.reset();
  }

  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  /** Consume session invalidation flag for persistence updates. */
  consumeSessionInvalidation(): boolean {
    return this.sessionManager.consumeInvalidation();
  }

  /**
   * Check if the service is ready (persistent query is active).
   * Used to determine if SDK skills are available.
   */
  isReady(): boolean {
    return this.isPersistentQueryActive();
  }

  /**
   * Get supported commands (SDK skills).
   * Returns cached commands populated on system/init. Falls back to a fresh
   * supportedCommands() call if the cache is empty (e.g., dropdown opened
   * before the first init event).
   */
  async getSupportedCommands(): Promise<SlashCommand[]> {
    if (this.cachedSdkCommands.length > 0) {
      return this.cachedSdkCommands;
    }
    if (!this.persistentQuery) {
      return [];
    }
    return this.fetchAndCacheCommands(this.persistentQuery);
  }

  /**
   * Fetches commands from the SDK and caches them. Called on system/init
   * (fire-and-forget) and as a fallback from getSupportedCommands().
   */
  private async fetchAndCacheCommands(query: Query | null): Promise<SlashCommand[]> {
    if (!query) return [];
    try {
      const sdkCommands: SDKSlashCommand[] = await query.supportedCommands();
      const mappedCommands = sdkCommands.map((cmd) => ({
        id: `sdk:${cmd.name}`,
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        content: '',
        source: 'sdk' as const,
      }));
      if (this.persistentQuery !== query) {
        return this.cachedSdkCommands;
      }
      this.cachedSdkCommands = mappedCommands;
      return this.cachedSdkCommands;
    } catch {
      return [];
    }
  }

  /**
   * Set the session ID (for restoring from saved conversation).
   * Closes persistent query synchronously if session is changing, then ensures query is ready.
   *
   * @param id - Session ID to restore, or null for new session
   * @param externalContextPaths - External context paths for the session (prevents stale contexts)
   */
  setSessionId(id: string | null, externalContextPaths?: string[]): void {
    const currentId = this.sessionManager.getSessionId();
    const sessionChanged = currentId !== id;

    // Close synchronously when session changes
    if (sessionChanged) {
      this.closePersistentQuery('session switch');
      this.crashRecoveryAttempted = false;
    }

    this.sessionManager.setSessionId(id, this.getScopedSettings().model);

    // Track external context paths for when the runtime starts on demand
    if (externalContextPaths !== undefined) {
      this.currentExternalContextPaths = externalContextPaths;
    }

    // Passive: do NOT call ensureReady() here.
    // Runtime starts on demand when query() is called.
  }

  /**
   * Cleanup resources (Phase 5).
   * Called on plugin unload to close persistent query and abort any cold-start query.
   */
  cleanup() {
    // Close persistent query
    this.closePersistentQuery('plugin cleanup');

    // Cancel any in-flight cold-start query
    this.cancel();
    this.resetSession();
  }

  async rewindFiles(userMessageId: string, dryRun?: boolean): Promise<RewindFilesResult> {
    if (!this.persistentQuery) throw new Error('No active query');
    if (this.shuttingDown) throw new Error('Service is shutting down');
    return this.persistentQuery.rewindFiles(userMessageId, { dryRun });
  }

  async rewind(userMessageId: string, assistantMessageId: string): Promise<ChatRewindResult> {
    return executeClaudeRewind(userMessageId, {
      assistantMessageId,
      rewindFiles: this.rewindFiles.bind(this),
      closePersistentQuery: (reason) => this.closePersistentQuery(reason),
      setPendingResumeAt: (resumeAt) => {
        this.pendingResumeAt = resumeAt;
      },
      vaultPath: this.vaultPath,
    });
  }

  setApprovalCallback(callback: ApprovalCallback | null) {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null) {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null) {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(getState: () => SubagentHookState): void {
    this._subagentStateProvider = getState;
  }

  setAutoTurnCallback(callback: ((result: AutoTurnResult) => void) | null): void {
    this._autoTurnCallback = callback;
  }

  /** S1: fired synchronously when an SDK-initiated (auto) turn starts. */
  setOnAutoTurnStarted(callback: ((event: AutoTurnStartedEvent) => void) | null): void {
    this._onAutoTurnStarted = callback;
  }

  /** S2 (v4 §3.1 step 3): feature clears its auto-turn lease. */
  setOnAutoTurnFinished(callback: ((turnId: string) => void) | null): void {
    this._onAutoTurnFinished = callback;
  }

  /** S2 (v4 §3.1 step 7): lease gone + channel released → UI queue may proceed. */
  setOnAutoTurnReleased(callback: ((turnId: string) => void) | null): void {
    this._onAutoTurnReleased = callback;
  }

  /** S2 (v3 §4.2): feature clears only the cancelled turn's state. */
  setOnAutoTurnCancelled(callback: ((event: AutoTurnCancelledEvent) => void) | null): void {
    this._onAutoTurnCancelled = callback;
  }

  private createApprovalCallback(): CanUseTool {
    return createClaudeApprovalCallback({
      getAllowedTools: () => this.currentAllowedTools,
      getApprovalCallback: () => this.approvalCallback,
      getAskUserQuestionCallback: () => this.askUserQuestionCallback,
      getExitPlanModeCallback: () => this.exitPlanModeCallback,
      getPermissionMode: () => this.plugin.settings.permissionMode,
      resolveSDKPermissionMode: (mode) => this.resolveSDKPermissionMode(mode),
      syncPermissionMode: (mode, sdkMode) => {
        if (this.currentConfig) {
          this.currentConfig.permissionMode = mode;
          this.currentConfig.sdkPermissionMode = sdkMode;
        }
      },
    });
  }

  private resolveSDKPermissionMode(mode: PermissionMode): SDKPermissionMode {
    return QueryOptionsBuilder.resolveClaudeSdkPermissionMode(
      mode,
      getClaudeProviderSettings(this.plugin.settings as unknown as Record<string, unknown>).safeMode,
    ) as SDKPermissionMode;
  }
}
