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
 * - Dynamic updates (model, thinking tokens, permission mode)
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

import type {
  CommandDiscoveryToken,
  CommandRuntimeEligibility,
  QueryCommandSourceReceipt,
  RuntimeCommandDiscovery,
  RuntimeCommandRead,
} from '../../../core/providers/commands/ProviderCommandDiscovery';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  AppAgentManager,
  AppPluginManager,
  FullHistoryIterable,
  HistoryTailStart,
} from '../../../core/providers/types';
import type { ChatRuntime, HistoryRecoveryStatus } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCancelledEvent,
  AutoTurnChunkEvent,
  AutoTurnDiagnosticEvent,
  AutoTurnFinishedEvent,
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
import type { ClaudianSettings } from '../../../core/types/settings';
import { t } from '../../../i18n/i18n';
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
import type { ClaudeNativeMcpCutoverService} from '../app/ClaudeNativeMcpCutover';
import { createClaudeNativeMcpCutoverService, resolveClaudeLaunchScopeInput } from '../app/ClaudeNativeMcpCutover';
import { CLAUDE_PROVIDER_CAPABILITIES } from '../capabilities';
import { loadSubagentFinalResult, loadSubagentToolCalls } from '../history/ClaudeHistoryStore';
import { extractXmlTag } from '../history/sdkMessageParsing';
import { getSDKSessionPath } from '../history/sdkSessionPaths';
import {
  createStopSubagentHook,
  type SubagentHookState,
} from '../hooks/SubagentHooks';
import {
  isClaudePermissionMode,
  resolveClaudeAppPermissionModeFromSdk,
  resolveClaudeRuntimePermissionMode,
  resolveClaudeSdkPermissionModeForRuntime,
} from '../permissionModes';
import { encodeClaudeTurn } from '../prompt/ClaudeTurnEncoder';
import { isSessionInitEvent, isStreamChunk } from '../sdk/typeGuards';
import type { SessionInitEvent, TransformEvent } from '../sdk/types';
import { getClaudeProviderSettings, resolveClaudeSettingSources } from '../settings';
import {
  transformSDKMessage,
} from '../stream/transformClaudeMessage';
import { ClaudeTranscriptDiagnosticLog, type TranscriptDiagnosticEvent } from '../transcript/ClaudeTranscriptDiagnosticLog';
import { ClaudeTranscriptTurnObserver } from '../transcript/ClaudeTranscriptTurnObserver';
import { getContextWindowSize } from '../types/models';
import {
  CutoverLaunchBlockedError,
  resolveNativeMcpScopeKey,
} from '../types/nativeMcpCutover';
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
import {
  detectTurnEchoSupport,
  formatTurnEchoSupport,
  readClaudeCodeVersion,
  readResultTurnEcho,
  RESULT_TURN_ECHO_LOG_HASH_LIMIT,
  resultEchoConsumedUuids,
  type ResultTurnEchoRead,
} from './ClaudeResultTurnEcho';
import { executeClaudeRewind } from './ClaudeRewindService';
import { SessionManager } from './ClaudeSessionManager';
import { ClaudeTurnReconciliationCoordinator } from './ClaudeTurnReconciliationCoordinator';
import {
  buildClaudePromptWithImages,
  buildClaudeSDKUserMessage,
} from './ClaudeUserMessageFactory';
import { HistoryContextAccumulator, recoveryCharacterBudget } from './HistoryContextAccumulator';
import {
  type ClaudeEnsureReadyOptions,
  type ClosePersistentQueryOptions,
  createResponseHandler,
  createRuntimeTurn,
  type DequeuedTurnInfo,
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
  pluginManager: AppPluginManager;
  agentManager: Pick<AppAgentManager, 'setBuiltinAgentNames'>;
}

type QueryOptions = ChatRuntimeQueryOptions;

/**
 * P0-1 result-late watchdog (2026-10-31 5m18s stall): the CLI can stop
 * yielding the SDK result after the transcript already recorded end_turn +
 * Stop-hook completion. Terminal-evidence threshold before the watchdog may
 * act, plus the post-interrupt grace window for a belated result.
 */
const RESULT_WATCHDOG_MS = 120_000;
const RESULT_WATCHDOG_GRACE_MS = 15_000;
const STOP_TASK_GRACE_MS = 15_000;
const STOP_TASK_TURN_SILENCE_MS = 30 * 60_000;
const STOP_TASK_AGENT_MIN_AGE_MS = 2 * 60 * 60 * 1000;
/** P0-3: escalate an interrupt the CLI never acknowledged. */
const INTERRUPT_ACK_WATCHDOG_MS = 5_000;
/** Retirement rebuild: max wait for the old CLI's real process exit. */
const QUERY_EXIT_CONFIRM_TIMEOUT_MS = 15_000;
/** Plain user-cancel isolation: how long the old-turn boundary may hold the lease. */
const CANCEL_BOUNDARY_TIMEOUT_MS = 15_000;

/** Chunk-wait state of the queryViaPersistent generator loop. */
interface ChunkWaitState {
  chunks: StreamChunk[];
  resolveChunk: ((chunk: StreamChunk | null) => void) | null;
  done: boolean;
  error: Error | null;
}

/**
 * Independent recovery attempt (2026-11-05 fix 1): the stopTask→interrupt→
 * cancel chain runs on its OWN timers, decoupled from the generator's
 * chunk-wait timer. Identity is frozen at creation — turn, generation,
 * query epoch, evidence revision, CLI version — and every liveness check
 * re-verifies all of them, so chunks arriving mid-window (the old
 * resolveChunk-as-recovery-identity bug) can never restart or extend the
 * chain, and a late stopTask response can never read mutated identity.
 */
interface StopTaskRecoveryAttempt {
  readonly attemptId: number;
  readonly turnId: string;
  readonly generation: number;
  readonly queryEpoch: number | undefined;
  readonly evidenceRevision: number;
  readonly cliVersion: string | undefined;
  phase: 'observing_stop' | 'observing_interrupt' | 'retiring' | 'finished';
}

/** Frozen diagnostic context for stopTask sends (2026-11-05 fix 4). */
interface StopTaskDiagnosticSnapshot {
  turnId: string;
  generation: number;
  queryEpoch: number | undefined;
  attemptId: number | null;
  cliVersion: string | undefined;
  sentAt: number;
}

/**
 * Query boundary (2026-11-05 fix 2): one scope per persistent query
 * incarnation. Every consumer/routing/handoff side effect must verify it
 * still acts on the CURRENT, un-retired scope — a result arriving through an
 * old consumer must never settle a turn leased by a newer query, and an old
 * consumer's error/teardown must never act on the new query.
 */
type QueryCommandResult =
  | { status: 'ready'; entries: readonly SlashCommand[] }
  | { status: 'failed' | 'cancelled' | 'stale' | 'unavailable' };

type QueryCommandWaiter = (result: QueryCommandResult) => void;

interface QueryCommandFlight {
  readonly waiters: Set<QueryCommandWaiter>;
}

interface QueryCommandCell {
  readonly query: Query;
  state: 'unobserved' | 'pending' | 'ready' | 'revoked';
  entries: readonly SlashCommand[];
  lastOutcome: 'failed' | null;
  flight: QueryCommandFlight | null;
}

interface QueryScope {
  readonly epoch: number;
  readonly query: Query;
  readonly channel: MessageChannel;
  readonly abortController: AbortController;
  readonly commandCell: QueryCommandCell;
  /** Retired scopes reject routing and block new dispatches (watchdog rebuild). */
  retired: boolean;
  /** Prevents a second consumer loop on the same scope. */
  consumerStarted: boolean;
  /** Set once this scope's CLI truly exited (spawn exit notification). */
  exitNotified: boolean;
}

/**
 * W4a command-eligibility generation. Kept separate from P1 cell state: every
 * scope install/replace/revoke/removal mints a new generation, so captured
 * receipts — including unavailable and failed ones — become invalid the
 * moment the underlying truth moves. Getter completion does NOT mint one.
 */
interface CommandEligibilityGeneration {
  /** Stable public eligibility object handed out with every typed read. */
  readonly eligibility: CommandRuntimeEligibility;
  /** The readable scope/cell this generation certifies; null = absence. */
  readonly readable: { readonly scope: QueryScope; readonly cell: QueryCommandCell } | null;
}

/**
 * W4a per-scope command source observation. Binds an opaque token to the
 * Query's observation without exposing the SDK Query object. Applied option
 * dims absent at capture time stay listed in `unknown` and are never
 * re-derived from the mutable currentConfig.
 */
interface QueryCommandSourceMeta {
  readonly token: CommandDiscoveryToken;
  readonly scope: QueryScope;
  readonly cell: QueryCommandCell;
  cwd?: string;
  additionalDirectories?: readonly string[];
  settingSources?: readonly string[];
  readonly unknown: string[];
}

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
 * excluded: it is routed by isTaskNotificationMessage instead (settle-only,
 * no auto turn — see routeMessage).
 */
function isLeaselessSessionControlMessage(message: SDKMessage): boolean {
  if ((message as { type?: string }).type !== 'system') {
    return false;
  }
  return (message as { subtype?: string }).subtype !== 'task_notification';
}

type UserTurnCompletionBarrier = {
  featureFinished: Promise<void>;
  resolveFeatureFinished: () => void;
  runtimeHandoffDone: Promise<void>;
  resolveRuntimeHandoffDone: () => void;
};

export class ClaudianService implements ChatRuntime {
  readonly providerId = CLAUDE_PROVIDER_CAPABILITIES.providerId;
  private plugin: ClaudianPlugin;
  private agentManager: Pick<AppAgentManager, 'setBuiltinAgentNames'> | null;
  private pluginManager: AppPluginManager | null;
  private abortController: AbortController | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  /** canUseTool callbacks pending on approval, questions, or plan-exit input. */
  private pendingCanUseToolCount = 0;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  /** Receives provider-normalized app permission modes (see setPermissionModeSyncCallback). */
  private permissionModeSyncCallback: ((appMode: string) => void) | null = null;
  private vaultPath: string | null = null;
  private currentExternalContextPaths: string[] = [];
  private readyStateListeners = new Set<(ready: boolean) => void>();

  // Modular components
  private sessionManager = new SessionManager();
  /** Cutover admission gate service (design 2026-11-09); lazily bound. */
  private nativeMcpCutoverService: ClaudeNativeMcpCutoverService | null = null;

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

  // SDK-resolved model from system/init (concrete id, not the settings alias).
  // Session-scoped so turns after the first still label usage with what
  // actually serves the query.
  private sessionResolvedModel: string | null = null;

  // Subagent hook state provider (set from feature layer to avoid core→feature dependency)
  private _subagentStateProvider: (() => SubagentHookState) | null = null;

  // Fix 2 (通知直接销账): live task-notification sink (set from feature layer).
  private _subagentNotificationHandler: SubagentTaskNotificationHandler | null = null;
  // Auto-triggered turn handling (e.g., task-notification delivery by the SDK)
  private _autoTurnCallback: ((result: AutoTurnResult) => void) | null = null;
  /** Sync signal for feature layer when an SDK-initiated turn starts (S1 API). */
  private _onAutoTurnStarted: ((event: AutoTurnStartedEvent) => unknown) | null = null;
  /** Ordered live projection for SDK-initiated turns. */
  private _onAutoTurnChunk: ((event: AutoTurnChunkEvent) => Promise<void>) | null = null;
  /** Runtime→feature→runtime completion handshake for user turns. */
  private userTurnCompletionBarriers = new Map<string, UserTurnCompletionBarrier>();
  /** S2 lifecycle: feature projection finalized before runtime settlement. */
  private _onAutoTurnFinished: ((event: AutoTurnFinishedEvent) => Promise<void>) | null = null;
  /** S2 lifecycle: lease gone + channel released → UI queue may proceed (step 7). */
  private _onAutoTurnReleased: ((turnId: string) => void) | null = null;
  /** S2 lifecycle: feature clears its auto lease only (v3 §4.2). */
  private _onAutoTurnCancelled: ((event: AutoTurnCancelledEvent) => void) | null = null;
  private _onEmbeddedExternal: ((event: AutoTurnStartedEvent) => Promise<void>) | null = null;
  /**
   * Turn-lease hotfix fix 6: a queued message dequeued for a turn the runtime
   * no longer knows — the feature layer conditionally cancels its lease for
   * the same turnId so the two layers cannot drift apart.
   */
  private _onUnregisteredTurnDequeued: ((turnId: string) => void) | null = null;
  private transcriptObserver: ClaudeTranscriptTurnObserver | null = null;
  private transcriptObserverTarget: string | null = null;
  private transcriptObserverRestartChain: Promise<void> = Promise.resolve();
  private transcriptObserverTailStart: HistoryTailStart | null = null;
  private historyRecoverySource: (() => FullHistoryIterable) | null = null;
  private transcriptDiagnosticLog: ClaudeTranscriptDiagnosticLog | null = null;
  private transcriptCliVersion: string | undefined;
  /**
   * CLI build version from the latest `system/init` frame. Diagnostics and
   * degradation expectations only (G1 result echo); never gates startup or
   * sending — old CLIs simply produce no echo fields.
   */
  private cliCodeVersion: string | undefined;
  /** Query boundary isolation (2.4): the live persistent-query scope, null when retired/absent. */
  private currentQueryScope: QueryScope | null = null;
  // W4a typed command facet: eligibility/source metadata and invalidation
  // listeners live beside the P1 cell but advance independently of it.
  private commandDiscoveryFacet: RuntimeCommandDiscovery | null = null;
  private commandDiscoveryListeners = new Set<() => void>();
  private commandEligibility: CommandEligibilityGeneration = {
    eligibility: { token: {}, revision: 0 },
    readable: null,
  };
  private commandSourceRevision = 0;
  private commandSourceMeta: QueryCommandSourceMeta | null = null;
  private queryEpochCounter = 0;
  private stopTaskAttemptCounter = 0;
  /** Single-flight retirement/rebuild chain: query()/ensureReady() wait on it (2.4 gate). */
  private queryRetirementChain: Promise<void> | null = null;
  /** Spawn-exit waiters per query epoch: retirement waits for the REAL exit, not abort flags. */
  private scopeExitNotifications = new Map<number, { scope: QueryScope; waiters: Array<() => void> }>();
  /** Latest real dispatch description (observer rebuild restore anchor, fix 3). */
  private currentDispatchDescriptor: DequeuedTurnInfo | null = null;
  /** Live host projection turn id (observer rebuild restore, survives async observer start). */
  private beginUserTurnProjectionTarget: string | null = null;
  /**
   * Plain user-cancel boundary tombstone (2.4): a cancelled turn's lease is
   * NOT proof the CLI turn ended — the queued input must not dispatch into
   * the same still-running CLI turn. The lease holds until the old turn's
   * REAL result arrives (unknown-lease release) or the window expires with
   * an explicit "input held" notice. Never auto-closes the query.
   */
  private cancelBoundaryTombstone: { turnId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /**
   * Persistent-query start single-flight (2.4): concurrent callers (ensureReady
   * fire-and-forget, query, rewind, retirement rebuild) must all join the
   * SAME start attempt — a second entry during the options await would build
   * a second channel and race the first into the slot.
   */
  private persistentQueryStart: Promise<void> | null = null;
  /**
   * Send prohibition (2.4): a retirement whose CLI never exited (15s timeout)
   * or whose rebuild failed locks ALL query starts — persistent and
   * cold-start alike. Starting a second CLI over a possibly-live one is
   * never an option; only an explicit close/reset clears this.
   */
  private queryStartProhibited: string | null = null;
  /**
   * Turn-identity reconciliation (batch 1, observe mode): read-only bypass
   * recording host/observer facts and rate diagnostics. Never consulted by
   * settlement, promotion, or notification paths.
   */
  private readonly turnReconciliation = new ClaudeTurnReconciliationCoordinator();

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

  constructor(plugin: ClaudianPlugin, services: ClaudeRuntimeServices) {
    this.plugin = plugin;
    const legacyPlugin = this.getLegacyPluginDeps();

    this.pluginManager = services.pluginManager ?? legacyPlugin.pluginManager ?? null;
    this.agentManager = services.agentManager ?? legacyPlugin.agentManager ?? null;
  }

  getCapabilities() {
    return CLAUDE_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeClaudeTurn(request);
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
    if (update.userMessageId) {
      this.transcriptObserver?.registerHostUserTranscriptId(update.userMessageId);
    }
  }

  private bufferUsageChunk(
    turn: RuntimeTurn,
    chunk: Extract<StreamChunk, { type: 'usage' }>,
  ): Extract<StreamChunk, { type: 'usage' }> {
    turn.bufferedUsage = chunk;
    return chunk;
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

    // Retirement/start gate (2.4): a rebuild in flight owns the slot — never
    // start a second CLI on top of it (concurrent ensureReady stays single).
    if (this.queryRetirementChain) {
      await this.queryRetirementChain;
      if (this.persistentQuery) {
        return false;
      }
    }

    // Send prohibition (2.4): force/config restarts close FIRST — that close
    // must never clear the prohibition and start a second CLI over the
    // possibly-live orphan. Fail fast here; only explicit reset/switch/cleanup
    // entries (which pass clearStartProhibition) can lift it.
    if (this.queryStartProhibited && !this.persistentQuery) {
      throw new Error(this.queryStartBlockedMessage());
    }

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
   * Single-flight gate (2.4): concurrent callers join the in-flight attempt;
   * the send prohibition turns starts into explicit errors instead of
   * spawning a second CLI over a possibly-live one.
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
    if (this.queryStartProhibited) {
      throw new Error(this.queryStartBlockedMessage());
    }
    if (this.persistentQueryStart) {
      return this.persistentQueryStart;
    }
    const gated = this.executePersistentQueryStart(
      vaultPath,
      cliPath,
      resumeSessionId,
      externalContextPaths
    ).finally(() => {
      if (this.persistentQueryStart === gated) {
        this.persistentQueryStart = null;
      }
    });
    this.persistentQueryStart = gated;
    return gated;
  }

  private async executePersistentQueryStart(
    vaultPath: string,
    cliPath: string,
    resumeSessionId?: string,
    externalContextPaths?: string[]
  ): Promise<void> {
    this.shuttingDown = false;
    this.vaultPath = vaultPath;

    this.messageChannel = new MessageChannel(
      undefined,
      (info) => this.handleTurnDequeued(info),
    );

    if (resumeSessionId) {
      this.messageChannel.setSessionId(resumeSessionId);
      this.sessionManager.setSessionId(resumeSessionId, this.getScopedSettings().model);
    }

    this.queryAbortController = new AbortController();

    const config = this.buildPersistentQueryConfig(vaultPath, cliPath, externalContextPaths);
    this.currentConfig = config;

    // Slot identity is captured with the synchronous build (2.4): any close
    // landing while the flight is parked (gate/options awaits) orphans it.
    const channel = this.messageChannel;
    const abortController = this.queryAbortController;

    // Cutover admission (design §5.1): strictly before any CLI spawn, with
    // resume/fork/auto-continuation included. Placed after the synchronous
    // slot build so the 2.4 single-flight observable structure is unchanged;
    // a blocked launch tears the half-built slot down (same shape the
    // mid-flight close uses) instead of leaving it behind.
    if (!(await this.resolveNativeMcpCutoverAdmission(vaultPath, cliPath)).allowed) {
      this.currentConfig = null;
      channel.close();
      if (this.messageChannel === channel) this.messageChannel = null;
      if (this.queryAbortController === abortController) {
        abortController.abort();
        this.queryAbortController = null;
      }
      throw new CutoverLaunchBlockedError();
    }

    // Query-scope exit sink: the spawn callback lands here once THIS CLI
    // truly exits; the binding to the scope happens right after creation.
    const exitSink: { handler: ((code: number | null) => void) | null } = { handler: null };

    // await is intentional: yields to microtask queue so fire-and-forget callers
    // (e.g. setSessionId → ensureReady) don't synchronously set persistentQuery
    const resumeAtMessageId = this.pendingResumeAt;
    const options = await this.buildPersistentQueryOptions(
      vaultPath,
      cliPath,
      resumeSessionId,
      resumeAtMessageId,
      externalContextPaths,
      code => exitSink.handler?.(code)
    );

    // Slot identity re-check after the options await (2.4): a concurrent
    // close/reset (or anything that took the slot down during the await)
    // must orphan this attempt instead of reviving it — the channel it
    // built is discarded closed, never spawning a CLI nobody owns.
    if (this.persistentQuery !== null || this.messageChannel !== channel || this.queryAbortController !== abortController) {
      channel.close();
      abortController.abort();
      return;
    }

    this.persistentQuery = agentQuery({
      prompt: this.messageChannel,
      options,
    });

    // Admission passed and the CLI is spawning: record the transient
    // native-running observation for this scope.
    this.noteNativeMcpCutoverRunning(vaultPath, cliPath);

    const scope = this.ensureQueryScope();
    if (scope) {
      // W4a: copy the applied options whitelist onto the scope's command
      // source meta at Query creation, before any later settings mutation.
      this.recordAppliedCommandScope(scope, options);
      exitSink.handler = () => {
        // Epoch-bound notification: a retirement waiting on THIS scope
        // resolves; a replaced scope (new epoch) is never falsely confirmed.
        this.notifyQueryProcessExit(scope.epoch);
      };
    }

    if (this.pendingResumeAt === resumeAtMessageId) {
      this.pendingResumeAt = undefined;
    }
    this.attachPersistentQueryStdinErrorHandler(this.persistentQuery);

    this.startResponseConsumer();
    this.notifyReadyStateChange();
  }

  /**
   * Send prohibition (2.4): set when a retirement lost the CLI (exit timeout
   * or rebuild failure). Blocks every start path — starting a second CLI over
   * a possibly-live one is never an option. Cleared only by an explicit
   * close/reset.
   */
  private setQueryStartProhibited(reason: string): void {
    this.queryStartProhibited = reason;
    this.recordTranscriptDiagnostic({ phase: 'query_start_prohibited', detail: reason });
  }

  /** Single source of the blocked-start message (ensureReady, start, send paths). */
  private queryStartBlockedMessage(): string {
    return `Claude session start is blocked after a failed query recovery (${this.queryStartProhibited}). Reload the conversation or reset the session to recover.`;
  }

  /**
   * Query boundary: materializes the scope for the query currently sitting in
   * the slot fields. Idempotent — the lazy attach also serves the test seams
   * that install persistentQuery/messageChannel directly, so every consumer
   * started after those installs is scope-guarded without test changes.
   */
  private ensureQueryScope(): QueryScope | null {
    const query = this.persistentQuery;
    const channel = this.messageChannel;
    if (!query || !channel) return null;
    if (this.currentQueryScope?.query === query) return this.currentQueryScope;
    if (this.currentQueryScope) this.revokeQueryCommands(this.currentQueryScope.commandCell);
    const scope: QueryScope = {
      epoch: ++this.queryEpochCounter,
      query,
      channel,
      abortController: this.queryAbortController ?? new AbortController(),
      commandCell: {
        query,
        state: 'unobserved',
        entries: [],
        lastOutcome: null,
        flight: null,
      },
      retired: false,
      consumerStarted: false,
      exitNotified: false,
    };
    this.currentQueryScope = scope;
    this.queryAbortController = scope.abortController;
    // W4a: mint the scope's command source observation (all dims unknown
    // until the applied options are recorded) and advance the eligibility —
    // an absence eligibility captured earlier dies with this install.
    this.commandSourceMeta = {
      token: {},
      scope,
      cell: scope.commandCell,
      unknown: ['cwd', 'additionalDirectories', 'settingSources'],
    };
    this.advanceCommandEligibility({ scope, cell: scope.commandCell });
    return scope;
  }

  /** The scope still owning the runtime slot, or null once retired/replaced. */
  private liveQueryScope(): QueryScope | null {
    const scope = this.currentQueryScope;
    if (!scope || scope.retired) return null;
    return scope;
  }

  private isCurrentQueryScope(scope: QueryScope | null | undefined): boolean {
    if (!scope) return false;
    return this.currentQueryScope === scope && !scope.retired;
  }

  /** Query boundary (2.4): a turn dispatched under a retired/replaced scope. */
  private isOldScopeTurn(turn: RuntimeTurn): boolean {
    const scope = this.currentQueryScope;
    return turn.queryEpoch !== undefined && scope !== null && scope.epoch !== turn.queryEpoch;
  }

  /**
   * The channel a turn's settlement may act on — null for old-scope turns.
   * Every completion path (settle, handoff, cancel) must release through
   * this so a lease handed to a replacement channel is never escalated on
   * from behind a retired scope.
   */
  private turnReleaseChannel(turn: RuntimeTurn): MessageChannel | null {
    return this.isOldScopeTurn(turn) ? null : this.messageChannel;
  }

  /**
   * Spawn exit notification (query-scope-bound by epoch): resolves any
   * retirement wait for THIS scope. Epoch isolation guarantees an old
   * process's late exit can never mark a replacement scope as exited.
   */
  notifyQueryProcessExit(scopeEpoch: number): void {
    const scope = this.currentQueryScope;
    if (scope?.epoch === scopeEpoch) this.revokeQueryCommands(scope.commandCell);
    const entry = this.scopeExitNotifications.get(scopeEpoch);
    if (!entry) return;
    this.scopeExitNotifications.delete(scopeEpoch);
    entry.scope.exitNotified = true;
    for (const resolve of entry.waiters.splice(0)) resolve();
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
      // Query boundary: an old query's stdin must never close the scope that
      // replaced it — identity check, not slot liveness (2026-11-05 fix 2).
      if (this.currentQueryScope && this.currentQueryScope.query !== query) {
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
  closePersistentQuery(reason?: string, options?: ClosePersistentQueryOptions): void {
    // P0-2: the close reason is the U3 discriminator (reload vs stdin error
    // vs session reset) — it was already plumbed but never recorded.
    this.recordTranscriptDiagnostic({ phase: 'query_close', detail: reason });
    this.abortUserTurnCompletionBarriers();
    const scope = this.currentQueryScope;
    if (!this.persistentQuery) {
      if (scope) this.revokeQueryCommands(scope.commandCell);
      // A start may be mid-flight: it has built the channel and the abort
      // controller but not yet the query. Tear the half-built slot down so
      // the start's post-await identity re-check orphans it (2.4) — a query
      // must never revive after an explicit close. A channel holding an
      // active turn cannot be a mid-flight start (no dispatch happens
      // before the query exists) — it is left untouched. Idempotent for
      // the plain already-closed case (all fields are null there).
      if (this.messageChannel && this.messageChannel.getActiveTurnId() === null) {
        this.messageChannel = null;
        this.queryAbortController = null;
      }
      // Only an explicit recovery entry may lift the prohibition here; a
      // zombie stdin error or internal close must not revive starts over a
      // possibly-live orphaned CLI (2.4).
      if (options?.clearStartProhibition) {
        this.queryStartProhibited = null;
      }
      return;
    }

    const preserveHandlers = options?.preserveHandlers ?? false;

    this.shuttingDown = true;

    // Retire the scope FIRST (2.4): from here the old consumer rejects
    // routing and its teardown can never act on a replacement scope.
    if (scope) {
      scope.retired = true;
      this.revokeQueryCommands(scope.commandCell);
    }

    // Close the message channel (ends the async iterable). close() reports
    // every turn that still held lease/queue state so the runtime can settle it.
    const channelTurnIds = this.messageChannel?.close() ?? [];

    // Official Query.close(): terminates the CLI subprocess and cleans up
    // pending requests/MCP transports. interrupt()+abort() alone cannot
    // guarantee the process is gone (2026-11-05 fix 2); close() replaces it.
    try {
      this.persistentQuery.close();
    } catch {
      // Already-closed/failed transports are fine: abort below is the backup.
    }

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
    this.currentQueryScope = null;
    // W4a: the slot fields are actually gone — advance to an absence
    // generation and drop the source meta so the old Query is not retained.
    this.commandSourceMeta = null;
    this.advanceCommandEligibility(null);
    if (this.cancelBoundaryTombstone) {
      clearTimeout(this.cancelBoundaryTombstone.timer);
      this.cancelBoundaryTombstone = null;
    }
    // Explicit teardown may lift the send prohibition — but only the explicit
    // recovery entries (session reset/switch, plugin cleanup) pass the flag.
    // Internal closes (force restarts, stdin errors, session invalidation)
    // must never revive starts over a possibly-live orphaned CLI (2.4).
    if (options?.clearStartProhibition) {
      this.queryStartProhibited = null;
    }
    this.responseConsumerRunning = false;
    this.responseConsumerPromise = null;
    this.currentConfig = null;
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
   * Cutover admission (design 2026-11-09-provider-native-mcp-alignment §4.2):
   * one shared gate in front of every Claude spawn — persistent start,
   * cold-start fallback, resume, fork, and auto-continuation all land here.
   */
  private async resolveNativeMcpCutoverAdmission(vaultPath: string, cliPath: string) {
    const cutover = this.getNativeMcpCutoverService();
    const claudeSettings = getClaudeProviderSettings(this.getScopedSettings() as unknown as Record<string, unknown>);
    const scope = resolveClaudeLaunchScopeInput(
      this.plugin,
      vaultPath,
      cliPath,
      resolveClaudeSettingSources(claudeSettings.loadUserSettings),
    );
    const admission = await cutover.resolveLaunchAdmission(scope);
    if (!admission.allowed) {
      this.recordTranscriptDiagnostic({
        phase: 'native_mcp_cutover_block',
        detail: `reason=${admission.reason ?? 'unspecified'}`,
      });
    }
    return admission;
  }

  private noteNativeMcpCutoverRunning(vaultPath: string, cliPath: string): void {
    const claudeSettings = getClaudeProviderSettings(this.getScopedSettings() as unknown as Record<string, unknown>);
    const scope = resolveClaudeLaunchScopeInput(
      this.plugin,
      vaultPath,
      cliPath,
      resolveClaudeSettingSources(claudeSettings.loadUserSettings),
    );
    this.getNativeMcpCutoverService().markNativeRunning(resolveNativeMcpScopeKey(scope));
  }

  private getNativeMcpCutoverService(): ClaudeNativeMcpCutoverService {
    if (!this.nativeMcpCutoverService) {
      this.nativeMcpCutoverService = createClaudeNativeMcpCutoverService(this.plugin);
    }
    return this.nativeMcpCutoverService;
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
    externalContextPaths?: string[],
    onProcessExit?: (code: number | null) => void
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
      onProcessExit,
    };

    return QueryOptionsBuilder.buildPersistentQueryOptions(ctx);
  }

  /**
   * Builds the hooks for SDK options.
   * Hooks need access to `this` for dynamic settings, so they're built here.
   */
  private buildHooks() {
    const hooks: Options['hooks'] = {};

    // Always register subagent hooks — closures resolve provider at execution time
    // so hooks work even when provider is set after the persistent query starts.
    hooks.Stop = [createStopSubagentHook(
      () => this._subagentStateProvider?.() ?? { hasRunning: false },
    )];

    return hooks;
  }

  /**
   * Starts the background consumer loop that routes chunks to handlers. The
   * loop captures the query SCOPE, not the mutable slot fields: once a scope
   * is retired or replaced, the loop stops routing, its error handler stops
   * restarting anything, and its teardown never touches the new scope.
   */
  private startResponseConsumer(): void {
    const scope = this.ensureQueryScope();
    if (!scope) {
      return;
    }
    if (scope.consumerStarted) {
      return;
    }
    scope.consumerStarted = true;
    this.responseConsumerRunning = true;

    this.responseConsumerPromise = (async () => {
      try {
        for await (const message of scope.query) {
          if (this.shuttingDown || scope.retired || this.currentQueryScope !== scope) break;

          // P0-2 runPhase bypass (read-only): the SDK session-state channel
          // tells whether the CLI agent loop is running/idle — the U1
          // discriminator for the stall family. Must never affect routing.
          this.noteSessionStateChange(message);
          await this.routeMessage(message, scope);
          // Post-await re-check (2.4): routing may have awaited chunk delivery
          // while the scope was retired/replaced; further messages must not route.
          if (scope.retired || this.currentQueryScope !== scope) break;
        }
      } catch (error) {
        // Skip error handling if this consumer's scope was replaced or retired,
        // or the slot query was swapped out from under it (test seam / manual
        // installs). This prevents race conditions where the OLD consumer's
        // error handler interferes with the NEW handler after a restart (e.g.,
        // from applyDynamicUpdates), and keeps a retired scope's teardown from
        // restarting crash recovery.
        if (!this.isCurrentQueryScope(scope) || this.persistentQuery !== scope.query) {
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
              // Crash recovery is a LEGITIMATE cross-scope rebuild: the close
              // above retired THIS consumer's own scope by design, so the
              // isCurrentQueryScope guard must not run here — the replay
              // targets the freshly rebuilt channel and its own preserved
              // turn, never a third party's scope.
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
              // The turn MUST settle even though this scope retired itself
              // during the failed restart — a dropped onError hangs the
              // user's generator forever.
              if (handler) {
                handler.onError(errorInstance);
              }
              return;
            }
          }

          // Notify active handler of error
          if (handler && this.isCurrentQueryScope(scope)) {
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
        this.revokeQueryCommands(scope.commandCell);
        // Only clear the flag if this consumer wasn't replaced by a new one (e.g., after restart)
        // If ensureReady() restarted, it starts a new consumer which sets the flag true,
        // so we shouldn't clear it here.
        if (this.currentQueryScope === scope || this.currentQueryScope === null) {
          this.responseConsumerRunning = false;
        }
      }
    })();
  }

  /** @param modelOverride - Optional model override for cold-start queries */
  private getTransformOptions(turn: RuntimeTurn, modelOverride?: string) {
    const settings = this.getScopedSettings();
    return {
      intendedModel: modelOverride ?? turn.model ?? settings.model,
      sessionResolvedModel: this.sessionResolvedModel ?? undefined,
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
   *    message).
   * 2. No active lease + session-level control message (system/init,
   *    compact_boundary, ...) → side effects only via
   *    applyLeaselessSystemMessage: no auto turn, no lease, no callbacks.
   * 3. No active lease + task-notification → settle-only: the notification
   *    is dispatched for accounting and dropped; no auto turn, no lease.
   *    A pure notification (~49% of deliveries, measured 0823 over 1383
   *    transcript occurrences) never sees a result, so an auto turn opened
   *    here would hold the lease forever — tab stuck "running", queued user
   *    messages dead-waiting (ghost auto turn, fbd4de8 regression).
   * 4. No active lease otherwise → dropped. External (SDK-initiated) turns
   *    are no longer opened from the stdout stream: the transcript observer
   *    owns their lifecycle (v6), so an unleased assistant/stream message
   *    has no runtime turn to land on.
   * 5. A notification arriving under an existing lease is dispatched for
   *    accounting only; a second lease is never created.
   * 6. Chunks go to the owning turn's waiters; a turn without waiters buffers
   *    chunks and flushes through the auto-turn callback adapter on result.
   */
  private async routeMessage(message: SDKMessage, scope: QueryScope | null = this.currentQueryScope): Promise<void> {
    // Note: Session expiration errors are handled in catch blocks (queryViaSDK, handleAbort)
    // The SDK throws errors as exceptions, not as message types

    // Query boundary (2.4): any side effect requires the CURRENT, un-retired
    // scope. A result arriving through an old consumer must never settle a
    // turn leased by a newer query (the 2026-11-05 defect 2 shape). A null
    // scope means no query incarnation exists to discriminate against.
    if (scope !== null && !this.isCurrentQueryScope(scope)) {
      this.recordTranscriptDiagnostic({
        phase: 'query_scope_stale',
        detail: `epoch=${scope.epoch} type=${message.type}`,
      });
      return;
    }

    // G1: the CLI build version rides the init frame. Recorded for the
    // result-echo diagnostics only — echo behavior keys on field presence,
    // never on this value, so an unknown/old CLI cannot block anything.
    const cliCodeVersion = readClaudeCodeVersion(message);
    if (cliCodeVersion !== null) {
      this.cliCodeVersion = cliCodeVersion;
    }

    if (message.type === 'user' && (message as SDKUserMessage & { isReplay?: boolean }).isReplay === true) {
      return;
    }

    // Plain-cancel isolation (2.4): the cancelled turn's boundary tombstone
    // dissolves ONLY on that CLI turn's real result. Chunks still streaming
    // from the cancelled turn prove it is running; releasing on them would
    // dispatch the queued input into that live turn (the defect-2 shape).
    if (this.cancelBoundaryTombstone && isTurnCompleteMessage(message)) {
      const tombstonedLease = this.messageChannel?.getActiveTurnId();
      if (tombstonedLease === this.cancelBoundaryTombstone.turnId) {
        this.settleCancelBoundaryTombstone(tombstonedLease);
      }
    }

    // Native permission reports (status/system, and init redundantly with the
    // transform path) sync through one scope-guarded helper for BOTH the
    // leased and leaseless entries; unknown native modes are ignored rather
    // than misattributed to a toolbar value (design §5.2).
    if (message.type === 'system' && (message as { permissionMode?: unknown }).permissionMode !== undefined) {
      this.syncNativePermissionMode((message as { permissionMode?: unknown }).permissionMode, scope);
    }

    const turn = this.resolveActiveTurn();
    const user = message.type === 'user' ? message as SDKUserMessage : null;
    if (user?.origin) {
      if (user.origin.kind === 'task-notification') {
        this.dispatchTaskNotification(message);
        // 2.3.2 fix ①: the injected notification is dequeued as its own SDK
        // turn of this persistent query, so the result message that follows it
        // belongs to that notification turn. Arm the lease holder so its
        // settlement skips that result — settling on it would complete the
        // user turn seconds in while the model keeps running (false
        // "completed" notify, 2026-09-17 evidence: four 4-5s premature
        // completions in one morning). The queue-operation envelope / system
        // shapes never arm this flag: they record an enqueue that may still
        // sit behind the running turn, whose own result must still settle.
        if (turn) turn.notificationResultPending = true;
      }
      return;
    }
    if (this.dispatchTaskNotification(message)) return;

    if (!turn) {
      if (isLeaselessSessionControlMessage(message)) this.applyLeaselessSystemMessage(message, scope);
      return;
    }
    // P0-3 evidence: any message routed to this turn's lease proves CLI
    // activity on the turn — recorded before the cancelled-phase gate so a
    // trailing result being dropped still counts as an interrupt response.
    turn.lastRoutedMessageAt = Date.now();
    if (turn.phase === 'cancelled' && isTurnCompleteMessage(message)) {
      // Plain-cancel boundary (2.4): the CLI turn is provably over — the
      // handoff skips the 15s tombstone window instead of holding the
      // queued input for a result that already arrived.
      turn.sawTerminalResult = true;
      return;
    }
    const activeTurn = turn;

    // Result attribution (2.3.2 fix ①): a result armed as belonging to an
    // injected notification turn settles nothing on this turn — not the
    // waiters, not the lease. The user turn's own result arrives later (after
    // the model finishes the queued user input) and settles normally. The
    // transform is skipped too: the notification turn's usage/window figures
    // must not project into the user turn's stream.
    if (isTurnCompleteMessage(message) && activeTurn.notificationResultPending) {
      activeTurn.notificationResultPending = false;
      return;
    }

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
        this.applySessionInitSideEffects(event, scope);
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
        // and sync the transient plan state through the shared native helper.
        if (event.type === 'tool_use' && event.name === TOOL_ENTER_PLAN_MODE) {
          this.syncNativePermissionMode('plan', scope);
        }

        const normalizedChunk = event.type === 'usage'
          ? this.bufferUsageChunk(activeTurn, { ...event, sessionId: this.sessionManager.getSessionId() })
          : event;

        await this.deliverChunkToTurn(activeTurn, normalizedChunk);
        // Post-await re-check (2.4): chunk delivery can await the feature
        // projection; a scope/turn replaced mid-delivery must not keep routing.
        if ((scope !== null && !this.isCurrentQueryScope(scope)) || this.runtimeTurns.get(activeTurn.id) !== activeTurn) {
          return;
        }
      }
    }

    if (message.type === 'assistant' && message.uuid) {
      this.recordTurnMetadata(activeTurn, { assistantMessageId: message.uuid });
    }

    // Recovery confirmation is tied to the exact dispatched session/result;
    // session_init alone is not a completion signal for persistent queries.
    if (isTurnCompleteMessage(message)) {
      const result = message as SDKMessage & { session_id?: string; subtype?: string; is_error?: boolean };
      // Pre-settlement scope re-check: the transform loop above may have
      // awaited chunk delivery while the scope was retired/replaced. An old
      // query's result must never settle a turn owned by a newer query.
      if (scope !== null && !this.isCurrentQueryScope(scope)) {
        this.recordTranscriptDiagnostic({
          phase: 'query_scope_stale',
          turnId: activeTurn.id,
          detail: `result epoch=${scope.epoch}`,
        });
        return;
      }
      if (activeTurn.recoveryGeneration !== undefined) {
        this.sessionManager.confirmRecovery(
          activeTurn.recoveryGeneration,
          result.session_id ?? null,
          result.subtype === 'success' && result.is_error !== true,
        );
      }
      this.noteResultTurnEcho(message, activeTurn);
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
  private applyLeaselessSystemMessage(message: SDKMessage, scope: QueryScope | null): void {
    const scratch = createRuntimeTurn({
      id: `system-event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: 'auto',
      phase: 'collecting',
    });

    for (const event of transformSDKMessage(message, this.getTransformOptions(scratch))) {
      if (isSessionInitEvent(event)) {
        this.applySessionInitSideEffects(event, scope);
      }
      // Everything else has no consumer — dropped with the scratch state.
    }
  }

  /** Session-level side effects of a session_init event, shared by the leased and lease-less routing paths. */
  private applySessionInitSideEffects(event: SessionInitEvent, scope: QueryScope | null): void {
    if (event.model) {
      this.sessionResolvedModel = event.model;
    }
    // Fork: suppress needsHistoryRebuild since SDK returns a different session ID by design
    const wasFork = this.pendingForkSession;
    this.sessionManager.captureSession(event.sessionId, wasFork);
    this.restartTranscriptObserver(event.sessionId);
    if (wasFork) this.pendingForkSession = false;
    this.messageChannel?.setSessionId(event.sessionId);
    if (event.agents) {
      try { this.getAgentManager()?.setBuiltinAgentNames(event.agents); } catch { /* non-critical */ }
    }
    if (event.permissionMode !== undefined) {
      this.syncNativePermissionMode(event.permissionMode, scope);
    }
    // Init adds an observation for the originating scope, never a replacement.
    void this.readQueryCommands(scope, undefined, false);
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
      // Plain-cancel isolation (2.4): while the tombstone owns this lease the
      // release is forbidden here — chunks from the still-running cancelled
      // turn would pump the queue into it. Only the real result (routeMessage
      // dissolves the tombstone first, then this branch releases) may
      // release; the 15s window only prompts that the input stays staged —
      // it never releases.
      if (this.cancelBoundaryTombstone?.turnId === activeTurnId) {
        return null;
      }
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
  private async deliverChunkToTurn(turn: RuntimeTurn, chunk: StreamChunk): Promise<void> {
    turn.receivedChunk = true;
    turn.lastChunkAt = Date.now();
    if (turn.waiters.size > 0) {
      for (const handler of turn.waiters) {
        handler.onChunk(chunk);
      }
      return;
    }
    if (turn.kind === 'auto' && this._onAutoTurnChunk && !turn.liveProjectionFailed) {
      try {
        await this._onAutoTurnChunk({
          turnId: turn.id,
          generation: turn.generation,
          chunk,
        });
        return;
      } catch {
        turn.liveProjectionFailed = true;
      }
    }
    turn.chunks.push(chunk);
  }

  private async fireOnAutoTurnFinished(turn: RuntimeTurn): Promise<void> {
    try {
      await this._onAutoTurnFinished?.({
        turnId: turn.id,
        generation: turn.generation,
        metadata: { ...turn.metadata },
      });
    } catch {
      // Lifecycle callback errors are isolated.
    }
  }

  private fireOnAutoTurnReleased(turnId: string): void {
    try {
      this._onAutoTurnReleased?.(turnId);
    } catch {
      // Lifecycle callback errors are isolated.
    }
  }

  private fireOnAutoTurnCancelled(turnId: string, generation: number, reason: string): void {
    try {
      this._onAutoTurnCancelled?.({ turnId, generation, reason });
    } catch {
      // Lifecycle callback errors are isolated.
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
    // P0-2: settle_result marks the result-arrival settlement path — the
    // hardest signal to separate from cancel/force settlement in the case
    // post-mortem (the CLI never reached this line during the 5m18s stall).
    this.recordTranscriptDiagnostic({ phase: 'settle_result', turnId: turn.id, generation: turn.generation, leaseKind: turn.kind });
    // Attempt teardown: a REAL result settles the turn — any live recovery
    // attempt ends here and its outcome attribution reads this flag.
    turn.terminalSettlementKind = 'result';
    turn.recoveryAttemptId = null;
    this.noteTurnIdentitySettled(turn.id);
    // Defensive only: terminal cleanup cannot prove attribution when the
    // notification result itself never arrives; the dual-track state machine
    // must close that remaining gap.
    turn.notificationResultPending = false;
    turn.phase = 'projecting';

    if (turn.waiters.size > 0) {
      const barrier = turn.kind === 'user' && this._onAutoTurnStarted
        ? this.registerUserTurnCompletionBarrier(turn.id)
        : null;
      // Feature layer consumes this after the generator drains. The barrier is
      // registered first so a fast feature acknowledgement cannot be lost.
      this.pendingFeatureTurnMetadata = { ...turn.metadata };
      for (const handler of turn.waiters) {
        handler.resetStreamText();
        handler.resetStreamThinking();
        handler.onDone();
      }
      turn.waiters.clear();
      if (barrier) await barrier.featureFinished;
      await this.executeDeferredRestartIfAny(turn.id);
      turn.phase = 'settled';
      if (barrier) {
        this.completeUserRuntimeHandoff(turn, barrier);
      } else {
        this.runtimeTurns.delete(turn.id);
        this.completeChannelTurn(turn.id, this.turnReleaseChannel(turn));
      }
      return;
    }

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
      await this.fireOnAutoTurnFinished(turn);
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
    this.completeChannelTurn(turn.id, this.turnReleaseChannel(turn));
    // Step 7: release remains the only feature queue pump. If a pending
    // external turn was promoted, its newly acquired feature lease blocks it.
    if (turn.kind === 'auto') {
      this.fireOnAutoTurnReleased(turn.id);
    }
  }


  private registerUserTurnCompletionBarrier(turnId: string): UserTurnCompletionBarrier {
    const existing = this.userTurnCompletionBarriers.get(turnId);
    if (existing) return existing;
    let resolveFeatureFinished!: () => void;
    let resolveRuntimeHandoffDone!: () => void;
    const barrier: UserTurnCompletionBarrier = {
      featureFinished: new Promise(resolve => { resolveFeatureFinished = resolve; }),
      resolveFeatureFinished,
      runtimeHandoffDone: new Promise(resolve => { resolveRuntimeHandoffDone = resolve; }),
      resolveRuntimeHandoffDone,
    };
    this.userTurnCompletionBarriers.set(turnId, barrier);
    return barrier;
  }

  private completeUserRuntimeHandoff(turn: RuntimeTurn, barrier: UserTurnCompletionBarrier): void {
    // Defense-in-depth at the projection barrier; this does not identify a
    // missing notification result before a host result reaches routeMessage.
    turn.notificationResultPending = false;
    this.runtimeTurns.delete(turn.id);
    // Query boundary (2.4), mirroring the cancel handoff: a handoff that
    // resumes after a retirement/rebuild must never release — or escalate a
    // lease mismatch — on the replacement channel.
    this.completeChannelTurn(turn.id, this.turnReleaseChannel(turn));
    barrier.resolveRuntimeHandoffDone();
    this.userTurnCompletionBarriers.delete(turn.id);
  }

  private abortUserTurnCompletionBarriers(): void {
    for (const barrier of this.userTurnCompletionBarriers.values()) {
      barrier.resolveFeatureFinished();
      barrier.resolveRuntimeHandoffDone();
    }
    this.userTurnCompletionBarriers.clear();
  }

  beginUserTurnProjection(turnId: string): void {
    // Remember the target: the observer may not exist yet (async start after
    // session init) — the rebuild restores the projection onto it (fix 3).
    this.beginUserTurnProjectionTarget = turnId;
    this.transcriptObserver?.beginUserTurnProjection(turnId);
  }

  async completeUserTurnProjection(turnId: string): Promise<void> {
    const barrier = this.userTurnCompletionBarriers.get(turnId);
    if (barrier) {
      barrier.resolveFeatureFinished();
      await barrier.runtimeHandoffDone;
    }
    await this.transcriptObserver?.completeUserTurnProjection(turnId);
  }

  /** Channel dequeue hook: a user message left the queue and now owns the lease. */
  private handleTurnDequeued(info: DequeuedTurnInfo): void {
    try {
      this.turnReconciliation.recordDispatched({
        leaseTurnId: info.leaseTurnId,
        canonicalTurnId: info.canonicalTurnId,
        hostTurnIds: info.hostTurnIds,
      });
    } catch {
      // Reconciliation is a read-only bypass; lease handling must not depend on it.
    }
    // Real dispatch anchor (fix 3): the channel stamps delivery time and the
    // merge-safe command kind; the observer attributes compact boundary
    // evidence against THIS, never the feature-begin timestamp.
    this.currentDispatchDescriptor = info;
    try {
      this.transcriptObserver?.observeDispatch({
        leaseTurnId: info.leaseTurnId,
        canonicalUuid: info.canonicalTurnId,
        hostTurnIds: info.hostTurnIds,
        dispatchedAt: info.dispatchedAt,
        isManualCompact: info.isManualCompact,
      });
    } catch {
      // Observer dispatch notification is best-effort.
    }
    const turnId = info.leaseTurnId;
    const turn = this.runtimeTurns.get(turnId);
    if (!turn) {
      // v4 §3.3 dequeue mismatch: the runtime no longer knows this turn
      // (cancelled earlier). Release the item and continue with the next.
      this.completeChannelTurn(turnId);
      // Fix 6: the feature layer may still hold the lease for this turnId —
      // notify it so both layers settle for the same turn instead of drifting.
      try {
        this._onUnregisteredTurnDequeued?.(turnId);
      } catch {
        // Runtime mismatch callbacks are best-effort.
      }
      return;
    }
    // Query boundary: the turn was dispatched under this scope's epoch; lease
    // release and delayed handoffs for it resolve against this scope only.
    turn.queryEpoch = this.liveQueryScope()?.epoch;
    turn.dispatchedAt = info.dispatchedAt;
    if (turn.phase === 'queued') {
      turn.phase = 'collecting';
    }
  }

  /** Reconciliation bypass: a host turn reached terminal state (settle or cancel). */
  private noteTurnIdentitySettled(turnId: string): void {
    try {
      this.turnReconciliation.noteHostTurnSettled(turnId);
    } catch {
      // The bypass never gates settlement or cancellation.
    }
  }

  /**
   * G1: consume the CLI-produced result turn echo. CLI >= 2.1.193 writes
   * `user_message_uuid` (2.1.259 adds `user_message_uuids`; 2.1.303 adds
   * `result_index`) into the result frame; the 0.2.112 SDK transport pipes
   * both directions untouched, so the fields are read structurally. Absence
   * is normal degradation (older CLI, or a turn with no client uuid): the
   * existing lease/reconciliation heuristics stay authoritative.
   */
  private noteResultTurnEcho(message: SDKMessage, turn: RuntimeTurn): void {
    const read = readResultTurnEcho(message);
    this.recordResultEchoDiagnostic(turn, read);
    // Auto turns never dispatched a client uuid, so there is no binding to
    // consult — only the raw echo stays in diagnostics.
    if (read.echo === null || turn.kind !== 'user') {
      return;
    }
    try {
      this.turnReconciliation.recordResultEcho({
        leaseTurnId: turn.id,
        consumedUuids: resultEchoConsumedUuids(read.echo),
        ...(read.echo.queuedTurnCount !== null ? { queuedTurnCount: read.echo.queuedTurnCount } : {}),
        ...(read.echo.resultIndex !== null ? { resultIndex: read.echo.resultIndex } : {}),
      });
    } catch {
      // Reconciliation stays a read-only bypass: an echo consultation must
      // never affect settlement, lease handling or waiters.
    }
  }

  /** Raw echo diagnostic (hashed identities only) with the CLI capability expectation. */
  private recordResultEchoDiagnostic(turn: RuntimeTurn, read: ResultTurnEchoRead): void {
    const log = this.transcriptDiagnosticLog;
    if (!log) return;
    const echo = read.echo;
    const consumedUuids = echo === null ? [] : resultEchoConsumedUuids(echo);
    const support = detectTurnEchoSupport(this.cliCodeVersion);
    log.record({
      phase: 'turn_result_echo',
      turnIdHash: log.hashId(turn.id),
      generation: turn.generation,
      leaseKind: turn.kind,
      echoStatus: read.status,
      ...(echo?.userMessageUuid !== null && echo?.userMessageUuid !== undefined
        ? { echoUuidHash: log.hashId(echo.userMessageUuid) }
        : {}),
      ...(consumedUuids.length > 0
        ? {
            echoUuidCount: consumedUuids.length,
            echoUuidHashes: consumedUuids
              .slice(0, RESULT_TURN_ECHO_LOG_HASH_LIMIT)
              .map(uuid => log.hashId(uuid)),
          }
        : {}),
      ...(echo?.userMessageUuidsTruncated === true ? { echoPluralTruncated: true } : {}),
      ...(echo?.userMessageUuidMissingFromPlural === true ? { echoSingularMissingFromPlural: true } : {}),
      ...(echo?.queuedTurnCount !== null && echo?.queuedTurnCount !== undefined
        ? { queuedTurnCount: echo.queuedTurnCount }
        : {}),
      ...(echo?.resultIndex !== null && echo?.resultIndex !== undefined
        ? { resultIndex: echo.resultIndex }
        : {}),
      ...(support !== null ? { echoSupport: formatTurnEchoSupport(support) } : {}),
      ...(this.cliCodeVersion !== undefined ? { cliVersion: this.cliCodeVersion } : {}),
    });
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
    // 2.3.2: the crashed query may have armed notificationResultPending (a
    // task-notification turn was dequeued before the crash). The replayed
    // query contains no notification turn, so a stale armed flag would make
    // the replayed turn swallow its own first result and hang its waiters.
    turn.notificationResultPending = false;
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
   *
   * Query boundary (2.4): when an explicit channel is passed (the turn's own
   * scope), an old-scope completion must never act on the live channel — no
   * "lease mismatch → cancel the actual holder" escalation across scopes.
   */
  private completeChannelTurn(turnId: string, channel: MessageChannel | null = this.messageChannel): void {
    if (!channel) {
      return;
    }
    if (channel !== this.messageChannel) {
      // Old-scope channel: its queue/lease are being torn down by the
      // retirement path itself; cross-scope escalation is forbidden.
      return;
    }
    const result = channel.completeTurn(turnId);
    if (result.ok) {
      return;
    }


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
    // P0-2 blind-spot closure (2026-11-04 U-A): cancelTurn had no diagnostic
    // at all, so silent settles like the d8912b5b host_only@11:46:08 could
    // never be attributed. reason answers "who cancelled what, when".
    this.recordTranscriptDiagnostic({ phase: 'turn_cancel', turnId, generation: turn.generation, detail: reason });
    // Attempt teardown: a cancelled turn ends any live recovery attempt and
    // records HOW the turn ended for the attempt's result-attribution check.
    turn.terminalSettlementKind = 'cancel';
    turn.recoveryAttemptId = null;
    this.noteTurnIdentitySettled(turnId);
    // Clear before branching so every cancellation exit drops stale defensive
    // attribution state. This cannot fix a missing notification result while
    // the turn remains live.
    turn.notificationResultPending = false;
    // A cancelled turn can never receive its own result confirmation (its
    // trailing result is dropped by the cancelled-phase gate in routeMessage),
    // so its recovery dispatch must fail now: back to pending while the
    // attempt budget lasts, tripped otherwise. Without this the state
    // machine sticks in awaiting_result and recovery never re-runs
    // (silent amnesia). Covers both the plain and the projection-barrier
    // user-cancel paths (v3 §2.1: query interruption must not clear state).
    if (turn.recoveryGeneration !== undefined) {
      this.sessionManager.failRecoveryDispatch(turn.recoveryGeneration);
    }
    if (turn.kind === 'user' && reason === 'user_cancel' && this._onAutoTurnStarted) {
      this.cancelUserTurnWithProjectionBarrier(turn, error);
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

    // Holds the lease → release so the next queued message can flow. The
    // release resolves against the turn's OWN scope channel (2.4): an old
    // turn's cancellation must never release or escalate on a newer channel.
    const releaseChannel = this.turnReleaseChannel(turn);
    if (releaseChannel?.getActiveTurnId() === turnId) {
      this.completeChannelTurn(turnId, releaseChannel);
        if (turn.kind === 'auto') this.fireOnAutoTurnReleased(turnId);
    }
  }

  private cancelUserTurnWithProjectionBarrier(turn: RuntimeTurn, error?: Error): void {
    turn.phase = 'cancelled';
    turn.generation += 1;
    try { turn.abortController.abort(); } catch { /* Already aborted */ }
    const barrier = this.registerUserTurnCompletionBarrier(turn.id);
    this.pendingFeatureTurnMetadata = { ...turn.metadata };
    for (const handler of turn.waiters) {
      if (error) handler.onError(error);
      else handler.onDone();
    }
    turn.waiters.clear();
    void barrier.featureFinished.then(async () => {
      await this.executeDeferredRestartIfAny(turn.id);
      this.completeUserCancelHandoffWithBoundary(turn, barrier);
    }).catch(() => {
      this.completeUserCancelHandoffWithBoundary(turn, barrier);
    });
  }

  /**
   * Plain-cancel handoff (2.4 isolation): local cancellation proceeds, but
   * the channel lease becomes the old turn's boundary tombstone. A late
   * result from that CLI turn settles nothing (the turn is gone); it only
   * releases the tombstone so the queue pumps. No result within the window
   * → explicit notice that the input stays staged; the lease is never
   * released by the timeout — only the real result dissolves the tombstone.
   * The query itself is never closed.
   */
  private completeUserCancelHandoffWithBoundary(turn: RuntimeTurn, barrier: UserTurnCompletionBarrier): void {
    turn.notificationResultPending = false;
    this.runtimeTurns.delete(turn.id);
    // Query boundary (2.4): an old-scope turn's handoff must never tombstone
    // the replacement channel — its lease lived on the retired channel.
    const oldScopeTurn = this.isOldScopeTurn(turn);
    const channel = this.turnReleaseChannel(turn);
    const holdsLease = channel !== null && channel.getActiveTurnId() === turn.id;
    if (holdsLease && channel && !turn.sawTerminalResult) {
      if (this.cancelBoundaryTombstone) clearTimeout(this.cancelBoundaryTombstone.timer);
      const tombstone = {
        turnId: turn.id,
        timer: setTimeout(() => this.expireCancelBoundaryTombstone(turn.id), CANCEL_BOUNDARY_TIMEOUT_MS),
      };
      this.cancelBoundaryTombstone = tombstone;
      this.recordTranscriptDiagnostic({
        phase: 'turn_cancel', turnId: turn.id, generation: turn.generation,
        detail: 'user_cancel_boundary_held',
      });
    } else if (!oldScopeTurn) {
      this.completeChannelTurn(turn.id);
    }
    // An old-scope turn owns no release on the live channel — its lease died
    // with the retired channel (2.4: no cross-scope escalation).
    barrier.resolveRuntimeHandoffDone();
    this.userTurnCompletionBarriers.delete(turn.id);
  }

  /** The old turn's real result arrived: the tombstone dissolves silently and the queue pumps. */
  private settleCancelBoundaryTombstone(turnId: string): void {
    const tombstone = this.cancelBoundaryTombstone;
    if (!tombstone || tombstone.turnId !== turnId) return;
    clearTimeout(tombstone.timer);
    this.cancelBoundaryTombstone = null;
    this.recordTranscriptDiagnostic({ phase: 'turn_cancel', turnId, detail: 'cancel_boundary_result_arrived' });
  }

  private expireCancelBoundaryTombstone(turnId: string): void {
    const tombstone = this.cancelBoundaryTombstone;
    if (!tombstone || tombstone.turnId !== turnId) return;
    // 2.4 correction: the 15s timeout only PROMPTS that the input is staged.
    // The tombstone stays armed and the lease stays held — only the real
    // result dissolves it and pumps the queue. Releasing here would let the
    // cancelled CLI turn race a fresh dispatch.
    this.recordTranscriptDiagnostic({ phase: 'turn_cancel', turnId, detail: 'cancel_boundary_timeout' });
    new Notice(t('chat.cancel.boundaryHeld'));
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
    } catch {
      // Deferred restart is retried by the next query.
    }
  }

  /**
   * Fix 2 (通知直接销账): parses a live message as a harness task-notification
   * and forwards it to the notification handler. Returns true when the message
   * was a task-notification (and has been fully handled here).
   */
  /**
   * Harness task-notification shapes Fix 2 settles: queue-operation envelopes
   * carrying a <task-notification> XML payload, and the SDK's typed
   * system/subtype=task_notification spelling.
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
      return true;
    }

    try {
      this._subagentNotificationHandler(taskId, status, result);
    } catch {
      // Settlement must never break the message routing loop.
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
    };
  }

  private buildQueryOptionsFromTurnRequest(
    request: ChatTurnRequest,
    _encodedTurn: PreparedChatTurn,
    legacyQueryOptions?: QueryOptions,
  ): QueryOptions | undefined {
    const effectiveQueryOptions: QueryOptions = {
      allowedTools: legacyQueryOptions?.allowedTools,
      model: legacyQueryOptions?.model,
      forceColdStart: legacyQueryOptions?.forceColdStart,
      externalContextPaths: request.externalContextPaths ?? legacyQueryOptions?.externalContextPaths,
    };

    if (
      effectiveQueryOptions.allowedTools === undefined &&
      effectiveQueryOptions.model === undefined &&
      effectiveQueryOptions.forceColdStart === undefined &&
      effectiveQueryOptions.externalContextPaths === undefined
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
    let streamedRecoveryContext: string | null = null;
    let streamedRecoveryLastUser: ChatMessage | null = null;
    if (this.sessionManager.needsHistoryRebuild() && this.historyRecoverySource) {
      const model = queryOptions?.model || this.getScopedSettings().model;
      const contextTokens = getContextWindowSize(model, this.getScopedSettings().customContextLimits);
      const accumulator = new HistoryContextAccumulator(recoveryCharacterBudget(contextTokens));
      for await (const chunk of this.historyRecoverySource()) accumulator.appendChunk(chunk);
      streamedRecoveryContext = accumulator.build();
      streamedRecoveryLastUser = accumulator.getLastUserMessage();
    }

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

    // Every send path joins the same lifecycle gate before choosing either
    // persistent or cold-start. Checking only inside shouldUsePersistent
    // would let forceColdStart bypass a retiring, possibly-live CLI (2.4).
    if (this.queryRetirementChain) await this.queryRetirementChain;
    if (this.persistentQueryStart) await this.persistentQueryStart;

    // Send prohibition (2.4): after a failed recovery (CLI never exited /
    // rebuild failed) no path may start another CLI — not persistent, not
    // cold-start. An explicit close/reset (session switch, reload) clears it.
    if (this.queryStartProhibited) {
      yield {
        type: 'error',
        content: this.queryStartBlockedMessage(),
      };
      return;
    }

    // Register the user RuntimeTurn for this query (both persistent and
    // cold-start paths consume it). Deletion happens at settlement, cancel or
    // generator cleanup — never by re-generating the id.
    const turn = createRuntimeTurn({ id: turnId, kind: 'user' });
    // Snapshot the dispatch model: provider settings are app-global and can be
    // switched mid-turn from another tab, but this turn's usage transforms and
    // context-window selection must keep the model the query actually runs on
    // (a sonnet[1m] turn must never re-denominate to the 200k fallback of a
    // mid-turn "sonnet" selection).
    turn.model = queryOptions?.model || this.getScopedSettings().model;
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
    if (this.sessionManager.needsHistoryRebuild() && (streamedRecoveryContext || (conversationHistory && conversationHistory.length > 0))) {
      const historyContext = streamedRecoveryContext ?? buildContextFromHistory(conversationHistory!);
      const actualPrompt = stripCurrentNoteContext(prompt);
      promptToSend = buildPromptWithHistoryContext(
        historyContext, prompt, actualPrompt,
        streamedRecoveryLastUser ? [streamedRecoveryLastUser] : (conversationHistory ?? []),
      );
      turn.recoveryGeneration = this.sessionManager.getHistoryRecoveryState().generation;
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
      // Retirement/start gate (2.4): the rebuild chain owns the slot until
      // it finishes; a query arriving mid-rebuild must never cold-start
      // around it.
      if (this.queryRetirementChain) {
        await this.queryRetirementChain;
      }
      // Start persistent query if not running
      if (!this.persistentQuery && !this.shuttingDown) {
        try {
          await this.startPersistentQuery(
            vaultPath,
            resolvedClaudePath,
            this.sessionManager.getSessionId() ?? undefined
          );
        } catch (error) {
          yield {
            type: 'error',
            content: error instanceof Error ? error.message : 'Failed to start the Claude session',
          };
          return;
        }
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
    // A failed permission setter aborts THIS send with a visible error — the
    // message is never enqueued to run under the previous mode (design §5.1).
    try {
      await this.applyDynamicUpdates(queryOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', content: message };
      return;
    }

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
    try {
      // reserved (batch 1 §2.2): the factory minted a candidate UUID; the
      // binding itself is only established when the channel dequeues it.
      if (message.uuid) {
        this.turnReconciliation.recordReserved(turn.id, message.uuid);
      }
    } catch {
      // Reconciliation bypass must never break the send path.
    }

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
        if (!enqueueResult.dropped && turn.recoveryGeneration !== undefined) {
          turn.recoveryGeneration = this.sessionManager.markRecoveryDispatched() ?? undefined;
        }
        if (enqueueResult.dropped) {
          // Queue overflow dropped this message (S1 leftover #1): settle the
          // turn immediately instead of leaving its handler waiting on a
          // lease that will never come. The dropped message must not remain
          // eligible for crash-recovery replay either. onError flips
          // state.done, so the loop below is skipped and the error is
          // yielded on the shared drain path.
          if (this.lastSentTurnId === turn.id) {
            this.lastSentMessage = null;
            this.lastSentQueryOptions = null;
            this.lastSentTurnId = null;
          }
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

      // Yield chunks as they arrive. The bare promise is raced with the
      // result-late watchdog: without it a CLI that never yields the result
      // parks this generator (and the lease) indefinitely (P0-1).
      while (!state.done) {
        if (state.chunks.length > 0) {
          yield state.chunks.shift()!;
        } else {
          const chunk = await this.awaitChunkWithResultWatchdog(turn, state);
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

      // Clear message tracking after completion — ownership-checked (2.4): a
      // late generator finishing behind a retirement/rebuild must not wipe
      // the replacement dispatch's crash-replay anchor.
      if (this.lastSentTurnId === turn.id) {
        this.lastSentMessage = null;
        this.lastSentQueryOptions = null;
        this.lastSentTurnId = null;
      }

      yield { type: 'done' };
    } finally {
      this.unregisterResponseHandler(handlerId);
      this.currentAllowedTools = null;
      this.finishTurnFromGenerator(turn, handler);
    }
  }

  /**
   * P0-1 result-late watchdog: the chunk wait races a re-arming timer. The
   * timer resolves nothing by itself — every wake re-checks the guards, so
   * chunk arrival, turn settlement and generation replacement all clear it
   * through the settle path (clearTimeout on resolve; identity check on
   * stale ticks). No timer survives a resolved wait.
   */
  private awaitChunkWithResultWatchdog(turn: RuntimeTurn, state: ChunkWaitState): Promise<StreamChunk | null> {
    return new Promise<StreamChunk | null>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (value: StreamChunk | null): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(value);
      };
      const arm = (delayMs: number = RESULT_WATCHDOG_MS): void => {
        timer = setTimeout(() => {
          void this.onResultWatchdogTick(turn, state, settle, arm);
        }, delayMs);
      };
      state.resolveChunk = settle;
      arm();
    });
  }

  private async onResultWatchdogTick(
    turn: RuntimeTurn,
    state: ChunkWaitState,
    settle: (chunk: StreamChunk | null) => void,
    arm: (delayMs?: number) => void,
  ): Promise<void> {
    // State guard (v2): a resolved or superseded wait must never act.
    if (state.resolveChunk !== settle || state.done) return;
    // The turn left the registry (settled/cancelled elsewhere): stop ticking.
    if (this.runtimeTurns.get(turn.id) !== turn) return;
    // Fix 1 (2026-11-05): once an independent attempt owns the chain, the
    // chunk-wait timer must NOT re-fire — a chunk resolving the wait used to
    // re-arm 120s and fire a SECOND stop round on the same agents. The
    // generator stays parked: the attempt's terminal (cancelTurn/result
    // settle) resolves the waiters' onDone which wakes it.
    if (turn.recoveryAttemptId !== null) return;
    const terminalSeenAt = turn.transcriptTerminalSeenAt;
    if (terminalSeenAt === null) {
      // No evidence permits only the one-shot background-agent probe. A
      // blocking sync Agent is absent from the candidate list, and a pending
      // permission/question wait suppresses the probe altogether.
      const now = Date.now();
      if (turn.phase === 'collecting' && !turn.stopTaskProbeSent && this.pendingCanUseToolCount === 0
        && now - Math.max(turn.lastChunkAt ?? turn.dispatchedAt, turn.dispatchedAt) > STOP_TASK_TURN_SILENCE_MS
        && this.persistentQuery && !this.shuttingDown) {
        const candidates = this.getRunningAgentCandidates()
          .filter(agent => now - agent.startedAt > STOP_TASK_AGENT_MIN_AGE_MS);
        if (candidates.length > 0) {
          turn.stopTaskProbeSent = true;
          // Shared per-logical-turn registry (B-(a)/(b)): the armed recovery
          // later filters out ids the probe already stopped.
          for (const agent of candidates) turn.stopTaskSentAgentIds.add(agent.agentId);
          void this.sendStopTasks(turn, candidates, 'silent_probe', null);
        }
      }
      // T4 red line: a probe never interrupts or force-settles an unproven turn.
      arm();
      return;
    }
    const now = Date.now();
    if (now - terminalSeenAt < RESULT_WATCHDOG_MS) {
      // Terminal was stamped mid-wait: re-arm for the REMAINING window
      // (reviewer #2) instead of a full period, so a stamp 60s into the wait
      // fires at stamp+120s (180s total), never at 240s.
      arm(RESULT_WATCHDOG_MS - (now - terminalSeenAt));
      return;
    }
    // Fire: hand the chain to an INDEPENDENT attempt with frozen identity.
    this.startStopTaskRecovery(turn, now);
  }

  /**
   * Fix 1 (2026-11-05): the recovery chain runs as an independent attempt —
   * its own timers, its own liveness checks, decoupled from the generator's
   * chunk-wait timer. resolveChunk only wakes the generator; it never
   * participates in attempt survival.
   */
  private startStopTaskRecovery(turn: RuntimeTurn, firedAt: number): void {
    const scope = this.currentQueryScope;
    const attempt: StopTaskRecoveryAttempt = {
      attemptId: ++this.stopTaskAttemptCounter,
      turnId: turn.id,
      generation: turn.generation,
      queryEpoch: scope?.epoch,
      evidenceRevision: turn.evidenceRevision,
      cliVersion: turn.transcriptTerminalCliVersion ?? this.transcriptCliVersion,
      phase: 'observing_stop',
    };
    turn.recoveryAttemptId = attempt.attemptId;
    const candidates = this.getRunningAgentCandidates();
    const unsent = candidates.filter(agent => !turn.stopTaskSentAgentIds.has(agent.agentId));
    this.recordTranscriptDiagnostic({
      phase: 'settle_watchdog_fire',
      turnId: turn.id,
      generation: attempt.generation,
      leaseKind: turn.kind,
      terminalSeenAgeMs: firedAt - (turn.transcriptTerminalSeenAt ?? firedAt),
      ...(turn.lastChunkAt !== null ? { lastChunkAgeMs: firedAt - turn.lastChunkAt } : {}),
      evidenceKind: turn.transcriptTerminalSource ?? 'stop_hook',
      ...(attempt.cliVersion ? { cliVersion: attempt.cliVersion } : {}),
      agentCandidateCount: unsent.length,
      queryEpoch: attempt.queryEpoch,
      attemptId: attempt.attemptId,
    });
    void this.runStopTaskRecovery(turn, attempt, unsent);
  }

  /** Full re-verification of every frozen identity dimension. */
  private attemptAlive(turn: RuntimeTurn, attempt: StopTaskRecoveryAttempt): boolean {
    if (this.runtimeTurns.get(turn.id) !== turn) return false;
    if (turn.phase === 'settled' || turn.phase === 'cancelled') return false;
    if (turn.recoveryAttemptId !== attempt.attemptId) return false;
    if (turn.evidenceRevision !== attempt.evidenceRevision) return false;
    if ((this.currentQueryScope?.epoch ?? undefined) !== attempt.queryEpoch) return false;
    return true;
  }

  private async runStopTaskRecovery(
    turn: RuntimeTurn,
    attempt: StopTaskRecoveryAttempt,
    unsent: Array<{ agentId: string; startedAt: number }>,
  ): Promise<void> {
    try {
      const scope = this.currentQueryScope;
      let sentAny = false;
      if (unsent.length > 0 && scope && !this.shuttingDown) {
        sentAny = true;
        // Register BEFORE the SDK call: a reject or a never-settling request
        // must never trigger a re-send of the same agent id (fix 1).
        for (const agent of unsent) turn.stopTaskSentAgentIds.add(agent.agentId);
        void this.sendStopTasks(turn, unsent, 'result_watchdog', attempt);
      } else {
        this.recordTranscriptDiagnostic({
          phase: 'stop_task_outcome', turnId: attempt.turnId, generation: attempt.generation,
          outcome: 'no_candidates', agentCandidateCount: 0,
          queryEpoch: attempt.queryEpoch, attemptId: attempt.attemptId,
          ...(attempt.cliVersion ? { cliVersion: attempt.cliVersion } : {}),
        });
      }
      if (sentAny) {
        // Observation window: attempt-owned timer — chunk arrivals never
        // reset or extend it (fix 1).
        await this.attemptDelay(STOP_TASK_GRACE_MS);
        if (!this.attemptAlive(turn, attempt)) {
          this.noteAttemptTerminatedByResult(turn, attempt, unsent.length);
          return;
        }
      }
      attempt.phase = 'observing_interrupt';
      const interruptScope = this.currentQueryScope;
      if (interruptScope && interruptScope.query === scope?.query && !this.shuttingDown) {
        this.recordTranscriptDiagnostic({
          phase: 'interrupt_sent', turnId: attempt.turnId, generation: attempt.generation,
          detail: 'result_watchdog', queryEpoch: attempt.queryEpoch, attemptId: attempt.attemptId,
        });
        void interruptScope.query.interrupt().catch(() => {
          // Silence abort/interrupt errors
        });
      }
      await this.attemptDelay(RESULT_WATCHDOG_GRACE_MS);
      if (!this.attemptAlive(turn, attempt)) {
        this.noteAttemptTerminatedByResult(turn, attempt, unsent.length);
        return;
      }
      attempt.phase = 'retiring';
      // Terminal: retire the old query (extract+rebuild the unsent queue),
      // then cancel this turn. Retiring FIRST matters: the lease is not a
      // proof the CLI turn ended, and cancelling before the rebuild would
      // pump the queue into the same dead query. A result arriving later is
      // dropped by the stale-scope routing guard.
      await this.retireAndRebuildQuery('result_watchdog', turn.id);
      this.cancelTurn(turn.id, 'result_watchdog');
    } finally {
      attempt.phase = 'finished';
      if (this.runtimeTurns.get(turn.id) === turn && turn.recoveryAttemptId === attempt.attemptId) {
        turn.recoveryAttemptId = null;
      }
    }
  }

  private noteAttemptTerminatedByResult(turn: RuntimeTurn, attempt: StopTaskRecoveryAttempt, candidateCount: number): void {
    // settled_by_result means a REAL result settled the turn inside the
    // observation window — time order alone never implies causation.
    if (turn.terminalSettlementKind === 'result') {
      this.recordTranscriptDiagnostic({
        phase: 'stop_task_outcome', turnId: attempt.turnId, generation: attempt.generation,
        outcome: 'settled_by_result', agentCandidateCount: candidateCount,
        queryEpoch: attempt.queryEpoch, attemptId: attempt.attemptId,
        ...(attempt.cliVersion ? { cliVersion: attempt.cliVersion } : {}),
      });
    }
  }

  private attemptDelay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Watchdog force settlement = retire the old query and rebuild (2.4): the
   * lease is NOT a proof the CLI turn ended, so cancel-and-reuse would let
   * the old result settle the NEXT turn. Single-flight — concurrent callers
   * (query/ensureReady/cold fallback) all wait on the same chain.
   */
  retireAndRebuildQuery(reason: string, exemptTurnId?: string): Promise<void> {
    if (this.queryRetirementChain) {
      return this.queryRetirementChain;
    }
    this.queryRetirementChain = this.executeQueryRetirement(reason, exemptTurnId).finally(() => {
      this.queryRetirementChain = null;
    });
    return this.queryRetirementChain;
  }

  private async executeQueryRetirement(reason: string, exemptTurnId?: string): Promise<void> {
    const scope = this.currentQueryScope;
    const query = this.persistentQuery;
    const channel = this.messageChannel;
    if (!scope || !query || !channel) {
      return;
    }

    // 1. Retire FIRST: routing stops, new dispatches are blocked.
    scope.retired = true;
    this.revokeQueryCommands(scope.commandCell);
    // 2. Extract the never-dispatched queue BEFORE closing the input —
    //    canonical UUIDs, host aliases, merged payloads, order all survive.
    const unsent = channel.extractUnsentQueue();
    // Baseline closePersistentQuery parity: close() reports every id that
    // still held lease/queue state on the dying channel. The retirement
    // caller settles its own stalled turn afterwards (exemptTurnId); any
    // OTHER live holder is a protocol anomaly — it is settled below so its
    // waiters cannot hang on a channel that will never route again.
    const retiredChannelTurnIds = channel.close();
    // 3. Remove from the slot. A plain-cancel tombstone belonged to the dying
    //    channel; its 15s window must never fire against the replacement.
    if (this.cancelBoundaryTombstone) {
      clearTimeout(this.cancelBoundaryTombstone.timer);
      this.cancelBoundaryTombstone = null;
    }
    this.currentQueryScope = null;
    this.persistentQuery = null;
    this.messageChannel = null;
    this.queryAbortController = null;
    this.responseConsumerRunning = false;
    // W4a: actual removal completed — advance to an absence generation and
    // drop the source meta so the retired Query is not retained.
    this.commandSourceMeta = null;
    this.advanceCommandEligibility(null);
    this.recordTranscriptDiagnostic({
      phase: 'query_retire',
      detail: `${reason} epoch=${scope.epoch} unsent=${unsent.length}`,
    });
    // Anomaly fallback (the slot is already cleared, so cancelTurn's lease
    // release is a no-op — settling never touches the replacement channel):
    // a lease holder the retirement caller does not settle itself must not
    // keep waiters parked on a dead channel.
    for (const id of retiredChannelTurnIds) {
      if (id === exemptTurnId) continue;
      if (this.runtimeTurns.has(id)) {
        this.cancelTurn(id, 'persistent_query_retired');
      }
    }
    // 4. Official close + abort (no extra interrupt — close terminates).
    //    Register the exit wait BEFORE close: the spawn exit notification can
    //    fire synchronously inside close() and must find its waiter.
    const exitWait = this.waitForScopeExit(scope);
    try {
      query.close();
    } catch {
      // Already-closed transports are fine; abort below is the backup.
    }
    scope.abortController.abort();

    // 6a. Confirm the old CLI TRULY exited (abort/killed/loop-end are not proof).
    const exited = await exitWait;
    if (!exited) {
      this.recordTranscriptDiagnostic({ phase: 'query_exit_confirmed', detail: `timeout epoch=${scope.epoch}` });
      this.setQueryStartProhibited('query_exit_timeout');
      // Explicit failure: settle the affected unsent turns with an error and
      // keep the send prohibition — never start a second CLI, never claim recovery.
      const failure = new Error('The Claude CLI process did not exit after close; unsent input stays queued locally.');
      for (const item of unsent) {
        if (this.runtimeTurns.has(item.turnId)) {
          this.cancelTurn(item.turnId, 'query_exit_timeout', failure);
        }
      }
      return;
    }
    this.recordTranscriptDiagnostic({ phase: 'query_exit_confirmed', detail: `epoch=${scope.epoch}` });

    // 6b. Rebuild under the original session configuration.
    const vaultPath = getVaultPath(this.plugin.app);
    const cliPath = this.plugin.getResolvedProviderCliPath('claude');
    if (!vaultPath || !cliPath) {
      this.setQueryStartProhibited('query_rebuild_failed');
      const failure = new Error('Persistent query rebuild failed: vault path or CLI path unavailable.');
      for (const item of unsent) {
        if (this.runtimeTurns.has(item.turnId)) {
          this.cancelTurn(item.turnId, 'query_rebuild_failed', failure);
        }
      }
      return;
    }
    try {
      await this.startPersistentQuery(
        vaultPath,
        cliPath,
        this.sessionManager.getSessionId() ?? undefined,
        this.currentExternalContextPaths
      );
    } catch (error) {
      this.setQueryStartProhibited('query_rebuild_failed');
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const item of unsent) {
        if (this.runtimeTurns.has(item.turnId)) {
          this.cancelTurn(item.turnId, 'query_rebuild_failed', failure);
        }
      }
      return;
    }

    // 6c. Restore the never-sent queue onto the new channel (the already
    //     dispatched input is never re-sent).
    const rebuiltScope = this.liveQueryScope();
    const newChannel = rebuiltScope?.channel ?? null;
    if (newChannel && unsent.length > 0) {
      newChannel.restoreQueue(unsent);
      this.recordTranscriptDiagnostic({
        phase: 'query_rebuilt',
        detail: `epoch=${rebuiltScope?.epoch ?? 'none'} restored=${unsent.length}`,
      });
    } else {
      this.recordTranscriptDiagnostic({ phase: 'query_rebuilt', detail: `epoch=${rebuiltScope?.epoch ?? 'none'} restored=0` });
    }
  }

  /** Waits for the real spawn exit; resolves false on timeout (15s). */
  private waitForScopeExit(scope: QueryScope): Promise<boolean> {
    if (scope.exitNotified) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const notify = () => {
        if (timer !== null) clearTimeout(timer);
        this.scopeExitNotifications.delete(scope.epoch);
        resolve(true);
      };
      const entry = this.scopeExitNotifications.get(scope.epoch) ?? { scope, waiters: [] };
      entry.waiters.push(notify);
      this.scopeExitNotifications.set(scope.epoch, entry);
      timer = setTimeout(() => {
        const current = this.scopeExitNotifications.get(scope.epoch);
        if (current && current.waiters.length > 0) {
          current.waiters = current.waiters.filter(waiter => waiter !== notify);
          if (current.waiters.length === 0) this.scopeExitNotifications.delete(scope.epoch);
        }
        resolve(scope.exitNotified);
      }, QUERY_EXIT_CONFIRM_TIMEOUT_MS);
    });
  }

  private getRunningAgentCandidates(): Array<{ agentId: string; startedAt: number }> {
    try {
      // Read only runningAgents: hasRunning is a lazy getter with stale
      // cleanup, so accessing it would orphanize the candidates before send.
      return this._subagentStateProvider?.().runningAgents ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Fix 4 (2026-11-05): the diagnostic context is an IMMUTABLE snapshot taken
   * before the send. A late stopTask response must never read the turn's
   * mutated generation or the current CLI version — sent/success/reject/
   * outcome events all carry the frozen copy.
   */
  private async sendStopTasks(
    turn: RuntimeTurn,
    candidates: Array<{ agentId: string; startedAt: number }>,
    context: 'result_watchdog' | 'silent_probe',
    attempt: StopTaskRecoveryAttempt | null,
  ): Promise<void> {
    const query = attempt ? this.currentQueryScope?.query : this.persistentQuery;
    if (!query || this.shuttingDown) return;
    const snapshot: StopTaskDiagnosticSnapshot = {
      turnId: turn.id,
      generation: attempt ? attempt.generation : turn.generation,
      queryEpoch: attempt ? attempt.queryEpoch : this.currentQueryScope?.epoch,
      attemptId: attempt ? attempt.attemptId : null,
      cliVersion: attempt ? attempt.cliVersion : (turn.transcriptTerminalCliVersion ?? this.transcriptCliVersion),
      sentAt: Date.now(),
    };
    const log = this.transcriptDiagnosticLog;
    await Promise.allSettled(candidates.map(async agent => {
      this.recordTranscriptDiagnostic({
        phase: 'stop_task_sent', turnId: snapshot.turnId, generation: snapshot.generation,
        agentIdHash: log?.hashId(agent.agentId), detail: context,
        queryEpoch: snapshot.queryEpoch, attemptId: snapshot.attemptId ?? undefined,
        ...(snapshot.cliVersion ? { cliVersion: snapshot.cliVersion } : {}),
      });
      try {
        await query.stopTask(agent.agentId);
        if (context === 'silent_probe') {
          this.recordTranscriptDiagnostic({
            phase: 'stop_task_outcome', turnId: snapshot.turnId, generation: snapshot.generation,
            agentIdHash: log?.hashId(agent.agentId), outcome: 'sent', detail: context,
            queryEpoch: snapshot.queryEpoch, attemptId: snapshot.attemptId ?? undefined,
            ...(snapshot.cliVersion ? { cliVersion: snapshot.cliVersion } : {}),
          });
        }
      } catch (error) {
        // CLI 2.1.311 may reject missing tasks. A rejected stop is benign:
        // retain diagnostic evidence and let the recovery chain continue.
        this.recordTranscriptDiagnostic({
          phase: 'stop_task_outcome', turnId: snapshot.turnId, generation: snapshot.generation,
          agentIdHash: log?.hashId(agent.agentId), outcome: 'error', detail: context,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          queryEpoch: snapshot.queryEpoch, attemptId: snapshot.attemptId ?? undefined,
          ...(snapshot.cliVersion ? { cliVersion: snapshot.cliVersion } : {}),
        });
      }
    }));
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
        // Scoped snapshot, never the top-level projection another provider owns.
        getPermissionMode: () => this.getScopedSettings().permissionMode,
        resolveSDKPermissionMode: (mode) => this.resolveSDKPermissionMode(mode),
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
    const selectedModel = turn.model ?? (queryOptions?.model || this.getScopedSettings().model);

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
      allowedTools,
      hasEditorContext,
      externalContextPaths,
    };

    const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

    try {
      // Cutover admission: the cold-start fallback spawns a real CLI, so it
      // passes the same gate as the persistent query.
      if (!(await this.resolveNativeMcpCutoverAdmission(cwd, cliPath)).allowed) {
        throw new CutoverLaunchBlockedError();
      }
      const response = agentQuery({ prompt: queryPrompt, options });
      this.noteNativeMcpCutoverRunning(cwd, cliPath);
      if (turn.recoveryGeneration !== undefined && this.sessionManager.needsHistoryRebuild()) {
        turn.recoveryGeneration = this.sessionManager.markRecoveryDispatched() ?? undefined;
      }
      this.recordTurnMetadata(turn, { wasSent: true });
      let streamSessionId: string | null = this.sessionManager.getSessionId();

      for await (const message of response) {
        if (this.abortController?.signal.aborted) {
          // Aborted mid-stream: the loop exits normally here — no catch, no
          // result event — so without failing the dispatch the recovery
          // state machine sticks in awaiting_result (v3 §2.1: query
          // interruption must fall back to pending while budget remains).
          if (turn.recoveryGeneration !== undefined) {
            this.sessionManager.failRecoveryDispatch(turn.recoveryGeneration);
          }
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
        if (isTurnCompleteMessage(message) && turn.recoveryGeneration !== undefined) {
          const result = message as SDKMessage & { session_id?: string; subtype?: string; is_error?: boolean };
          this.sessionManager.confirmRecovery(
            turn.recoveryGeneration,
            result.session_id ?? null,
            result.subtype === 'success' && result.is_error !== true,
          );
        }
      }
    } catch (error) {
      if (turn.recoveryGeneration !== undefined) {
        this.sessionManager.failRecoveryDispatch(turn.recoveryGeneration);
      }
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
    if (turn.notificationResultPending) {
      throw new Error('Cold-start turn cannot own a notification result');
    }
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
    this.recordTranscriptDiagnostic({
      phase: 'runtime_cancel',
      turnId: this.messageChannel?.getActiveTurnId() ?? undefined,
    });

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
      this.recordTranscriptDiagnostic({ phase: 'interrupt_sent', turnId: activeTurnId ?? undefined, detail: 'user_cancel' });
      void this.persistentQuery.interrupt().catch(() => {
        // Silence abort/interrupt errors
      });
      this.armInterruptAcknowledgementWatchdog(activeTurnId);
    }

    // 2.5.1 F3: transcript-observed auto turns have no runtime-side lease, so
    // none of the cancelTurn paths above can settle them. The CLI's trailing
    // result line is not a reliable settlement signal after an interrupt
    // (ignored while blocked on canUseTool; an abandoned notification turn may
    // never run at all — 2026-09-17 18:22 ghost lease) — settle the promoted
    // auto turn here so its feature lease finishes exactly once.
    this.transcriptObserver?.interruptActiveTurn('user_cancel');
  }

  /**
   * Reset the conversation session.
   * Closes the persistent query since session is changing.
   */
  resetSession() {
    // Close persistent query (new session will use cold-start resume).
    // Reset is an explicit recovery entry: it owns the slot lifecycle from
    // scratch and may lift a send prohibition left by a failed recovery.
    this.closePersistentQuery('session reset', { clearStartProhibition: true });
    this.turnReconciliation.advanceSessionGeneration();

    // Reset crash recovery for fresh start
    this.crashRecoveryAttempted = false;

    // The next session's system/init reports its own resolved model.
    this.sessionResolvedModel = null;

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

  /** The array API remains a compatibility shell over the current Query's observation. */
  async getSupportedCommands(signal?: AbortSignal): Promise<SlashCommand[]> {
    const scope = this.liveQueryScope();
    const result = await this.readQueryCommands(scope, signal);
    if (result.status !== 'ready' || !scope || signal?.aborted ||
        !this.isCurrentQueryCommandCell(scope, scope.commandCell)) {
      return [];
    }
    return result.entries.map(entry => ({ ...entry }));
  }

  private isCurrentQueryCommandCell(scope: QueryScope, cell: QueryCommandCell): boolean {
    return !this.shuttingDown && this.currentQueryScope === scope && !scope.retired &&
      this.persistentQuery === scope.query && scope.commandCell === cell &&
      cell.query === scope.query && cell.state !== 'revoked';
  }

  private async readQueryCommands(
    scope: QueryScope | null,
    signal?: AbortSignal,
    retryFailed = true,
  ): Promise<QueryCommandResult> {
    if (signal?.aborted) return { status: 'cancelled' };
    if (!scope) return { status: 'unavailable' };
    const cell = scope.commandCell;
    if (!this.isCurrentQueryCommandCell(scope, cell)) return { status: 'stale' };
    if (cell.state === 'ready') return { status: 'ready', entries: cell.entries };
    if (cell.state === 'unobserved' && cell.lastOutcome === 'failed' && !retryFailed) {
      return { status: 'failed' };
    }

    const flight = cell.flight ?? this.startQueryCommandFlight(scope, cell);
    if (!this.isCurrentQueryCommandCell(scope, cell) || cell.flight !== flight) {
      return { status: 'stale' };
    }
    const result = await this.waitForQueryCommandFlight(scope, cell, flight, signal);
    if (signal?.aborted) return { status: 'cancelled' };
    if (!this.isCurrentQueryCommandCell(scope, cell)) return { status: 'stale' };
    return result;
  }

  private startQueryCommandFlight(scope: QueryScope, cell: QueryCommandCell): QueryCommandFlight {
    const flight: QueryCommandFlight = { waiters: new Set() };
    cell.state = 'pending';
    cell.flight = flight;

    // Install the flight before invoking the SDK, including synchronous re-entry.
    let pending: Promise<SDKSlashCommand[]>;
    try {
      pending = Promise.resolve(scope.query.supportedCommands());
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.then(sdkCommands => {
      const entries = sdkCommands.map(cmd => ({
        id: `sdk:${cmd.name}`,
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        content: '',
        source: 'sdk' as const,
      }));
      this.finishQueryCommandFlight(scope, cell, flight, { status: 'ready', entries });
    }, () => {
      this.finishQueryCommandFlight(scope, cell, flight, { status: 'failed' });
    }).catch(() => {
      this.finishQueryCommandFlight(scope, cell, flight, { status: 'failed' });
    });
    return flight;
  }

  private finishQueryCommandFlight(
    scope: QueryScope,
    cell: QueryCommandCell,
    flight: QueryCommandFlight,
    result: QueryCommandResult,
  ): void {
    if (!this.isCurrentQueryCommandCell(scope, cell) || cell.flight !== flight) {
      this.settleQueryCommandWaiters(flight, { status: 'stale' });
      return;
    }
    cell.flight = null;
    if (result.status === 'ready') {
      cell.state = 'ready';
      cell.entries = result.entries;
      cell.lastOutcome = null;
    } else {
      cell.state = 'unobserved';
      cell.lastOutcome = 'failed';
    }
    this.settleQueryCommandWaiters(flight, result);
    // W4a: the committed snapshot is a fresh source observation. Advance the
    // source revision and notify — listeners only invalidate UI; this never
    // re-enters the SDK here.
    this.commandSourceRevision += 1;
    this.notifyCommandDiscoveryChanged();
  }

  private waitForQueryCommandFlight(
    scope: QueryScope,
    cell: QueryCommandCell,
    flight: QueryCommandFlight,
    signal?: AbortSignal,
  ): Promise<QueryCommandResult> {
    return new Promise(resolve => {
      let finished = false;
      const onAbort = () => finish({ status: 'cancelled' });
      const finish: QueryCommandWaiter = result => {
        if (finished) return;
        finished = true;
        flight.waiters.delete(finish);
        try { signal?.removeEventListener('abort', onAbort); } catch { /* caller-owned signal */ }
        if (signal?.aborted) resolve({ status: 'cancelled' });
        else if (!this.isCurrentQueryCommandCell(scope, cell)) resolve({ status: 'stale' });
        else resolve(result);
      };
      flight.waiters.add(finish);
      try { signal?.addEventListener('abort', onAbort, { once: true }); } catch {
        finish({ status: 'cancelled' });
        return;
      }
      if (signal?.aborted) finish({ status: 'cancelled' });
      else if (!this.isCurrentQueryCommandCell(scope, cell) || cell.flight !== flight) {
        finish({ status: 'stale' });
      }
    });
  }

  private settleQueryCommandWaiters(flight: QueryCommandFlight, result: QueryCommandResult): void {
    const waiters = [...flight.waiters];
    flight.waiters.clear();
    for (const waiter of waiters) {
      try { waiter(result); } catch { /* command waiters cannot interrupt lifecycle */ }
    }
  }

  private revokeQueryCommands(cell: QueryCommandCell): void {
    if (cell.state === 'revoked') return;
    cell.state = 'revoked';
    cell.entries = [];
    cell.lastOutcome = null;
    const flight = cell.flight;
    cell.flight = null;
    if (flight) this.settleQueryCommandWaiters(flight, { status: 'stale' });
    // W4a: revoking a readable cell ends its eligibility generation — an
    // already-replaced cell (old consumer teardown, late old child exit)
    // never matches the current generation, so it cannot revoke Q2.
    if (this.commandEligibility.readable?.cell === cell) {
      this.advanceCommandEligibility(null);
    }
  }

  // ---- W4a: public typed command discovery facet --------------------------
  // Read-only bypass over the P1 command cell. P1 keeps owning the getter
  // flight, waiters, revocation, and the array compatibility shell; the facet
  // only adds eligibility generations, an opaque per-scope source
  // observation, and invalidation listeners.

  getCommandDiscovery(): RuntimeCommandDiscovery {
    if (!this.commandDiscoveryFacet) {
      this.commandDiscoveryFacet = {
        read: (waiterSignal, options) => this.readCommandDiscoverySnapshot(waiterSignal, options),
        subscribe: listener => this.subscribeCommandDiscovery(listener),
        isCurrent: eligibility => this.isCommandEligibilityCurrent(eligibility),
      };
    }
    return this.commandDiscoveryFacet;
  }

  private subscribeCommandDiscovery(listener: () => void): () => void {
    this.commandDiscoveryListeners.add(listener);
    return () => { this.commandDiscoveryListeners.delete(listener); };
  }

  /** Invalidation fan-out only — a throwing listener must never break the runtime. */
  private notifyCommandDiscoveryChanged(): void {
    if (this.commandDiscoveryListeners.size === 0) return;
    for (const listener of [...this.commandDiscoveryListeners]) {
      try { listener(); } catch { /* isolated by contract */ }
    }
  }

  private advanceCommandEligibility(readable: CommandEligibilityGeneration['readable']): void {
    const token: CommandDiscoveryToken = {};
    const revision = this.commandEligibility.eligibility.revision + 1;
    this.commandEligibility = { eligibility: { token, revision }, readable };
    this.notifyCommandDiscoveryChanged();
  }

  private isCommandEligibilityCurrent(eligibility: CommandRuntimeEligibility): boolean {
    const generation = this.commandEligibility;
    // (1) The eligibility object itself must be the current generation.
    if (!eligibility ||
        eligibility.token !== generation.eligibility.token ||
        eligibility.revision !== generation.eligibility.revision) {
      return false;
    }
    // (2)+(3) Query-bound generations must still own a live, unrevoked
    // scope-cell; absence generations stay current until the next advance.
    return generation.readable === null ||
      this.isCurrentQueryCommandCell(generation.readable.scope, generation.readable.cell);
  }

  private async readCommandDiscoverySnapshot(
    waiterSignal?: AbortSignal,
    options?: { retryFailed?: boolean },
  ): Promise<RuntimeCommandRead> {
    // Capture the eligibility generation and the readable scope/cell BEFORE
    // any await: a cell already revoked/exited/EOF'd reads as a fresh
    // no-readable-query absence, never as a stale carry-over, and a read
    // started on one Query never re-binds to a replacement.
    const eligibility = this.commandEligibility.eligibility;
    const scope = this.currentQueryScope;
    const cell = scope?.commandCell ?? null;
    if (waiterSignal?.aborted) {
      return { status: 'cancelled', eligibility };
    }
    if (!scope || !cell || !this.isCurrentQueryCommandCell(scope, cell)) {
      return { status: 'unavailable', reason: 'no-readable-query', eligibility };
    }
    // Typed reads are passive by default: a cached failure is preserved
    // unless the caller explicitly asks for retryFailed.
    const result = await this.readQueryCommands(scope, waiterSignal, options?.retryFailed === true);
    if (result.status === 'ready') {
      return {
        status: 'ready',
        entries: result.entries.map(entry => ({ ...entry })),
        receipt: this.buildQueryCommandReceipt(scope, cell),
        eligibility,
      };
    }
    if (result.status === 'failed') {
      return { status: 'failed', code: 'query-command-read-failed', eligibility };
    }
    return { status: result.status, eligibility };
  }

  private buildQueryCommandReceipt(
    scope: QueryScope,
    cell: QueryCommandCell,
  ): QueryCommandSourceReceipt {
    const meta = this.commandSourceMeta;
    const bound = meta && meta.scope === scope && meta.cell === cell ? meta : null;
    // Unknown dims are reported as unknown — never fabricated from
    // currentConfig or the live slot state.
    const sourceToken: CommandDiscoveryToken = bound ? bound.token : {};
    return {
      sourceKind: 'initialize-response',
      sourceToken,
      sourceRevision: this.commandSourceRevision,
      scope: {
        kind: 'actual-query',
        sourceToken,
        cwd: bound?.cwd,
        additionalDirectories: bound?.additionalDirectories,
        settingSources: bound?.settingSources,
        unknown: [...(bound ? bound.unknown : ['cwd', 'additionalDirectories', 'settingSources'])],
      },
      coverage: 'initialize-observed',
    };
  }

  /**
   * W4a: copy the applied options whitelist (cwd / additionalDirectories /
   * settingSources) onto the scope's command source meta. Dimensions absent
   * from the applied options stay in `unknown` — the meta is never repaired
   * from the mutable currentConfig.
   */
  private recordAppliedCommandScope(scope: QueryScope, options: Options): void {
    const meta = this.commandSourceMeta;
    if (!meta || meta.scope !== scope) return;
    if (typeof options.cwd === 'string') {
      meta.cwd = options.cwd;
      this.dropUnknownCommandScopeDim(meta, 'cwd');
    }
    if (options.additionalDirectories) {
      meta.additionalDirectories = [...options.additionalDirectories];
      this.dropUnknownCommandScopeDim(meta, 'additionalDirectories');
    }
    if (options.settingSources) {
      meta.settingSources = [...options.settingSources];
      this.dropUnknownCommandScopeDim(meta, 'settingSources');
    }
  }

  private dropUnknownCommandScopeDim(meta: QueryCommandSourceMeta, dim: string): void {
    const index = meta.unknown.indexOf(dim);
    if (index !== -1) meta.unknown.splice(index, 1);
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

    // Close synchronously when session changes. A session switch (reload,
    // restore) is an explicit recovery entry: it may lift a send prohibition
    // left by a failed recovery and start the new session fresh.
    if (sessionChanged) {
      this.closePersistentQuery('session switch', { clearStartProhibition: true });
      this.crashRecoveryAttempted = false;
      // Bindings are scoped to the session generation: late events from the
      // old session must never hit the new session's map (batch 1 §2.4).
      this.turnReconciliation.advanceSessionGeneration();
    }

    this.sessionManager.setSessionId(id, this.getScopedSettings().model);
    this.restartTranscriptObserver(id);

    // Track external context paths for when the runtime starts on demand
    if (externalContextPaths !== undefined) {
      this.currentExternalContextPaths = externalContextPaths;
    }

    // Passive: do NOT call ensureReady() here.
    // Runtime starts on demand when query() is called.
  }

  setTranscriptObserverTailStart(tailStart: HistoryTailStart | null): void {
    this.transcriptObserverTailStart = tailStart;
  }

  setHistoryRecoverySource(source: (() => FullHistoryIterable) | null): void {
    this.historyRecoverySource = source;
  }

  onHistoryRecoveryStateChange(listener: (state: HistoryRecoveryStatus) => void): () => void {
    this.sessionManager.onHistoryRecoveryStateChange(state => listener({
      status: state.status === 'tripped' ? 'tripped' : state.status === 'idle' ? 'idle' : 'recovering',
      generation: state.generation,
      ...(state.status === 'tripped' ? { reason: state.reason } : {}),
    }));
    return () => this.sessionManager.onHistoryRecoveryStateChange(null);
  }

  retryHistoryRecovery(generation: number): boolean {
    return this.sessionManager.retryHistoryRecovery(generation);
  }

  private restartTranscriptObserver(sessionId: string | null): void {
    const vaultPath = getVaultPath(this.plugin.app);
    const ready = Boolean(sessionId && vaultPath && this._onAutoTurnStarted && this._onAutoTurnChunk && this._onAutoTurnFinished);
    const target = ready ? getSDKSessionPath(vaultPath!, sessionId!) : null;
    if (target === this.transcriptObserverTarget && (target === null || this.transcriptObserver)) return;
    this.transcriptObserverTarget = target;
    this.transcriptCliVersion = undefined;
    this.transcriptObserverRestartChain = this.transcriptObserverRestartChain.then(async () => {
      if (target !== this.transcriptObserverTarget) return;
      this.transcriptObserver?.stop('session_switch');
      this.transcriptObserver = null;
      if (!target || !vaultPath) return;
      this.transcriptDiagnosticLog ??= new ClaudeTranscriptDiagnosticLog(vaultPath, message => { new Notice(message); });
      this.turnReconciliation.attachDiagnostics(this.transcriptDiagnosticLog);
      const observer = new ClaudeTranscriptTurnObserver({
        started: event => this._onAutoTurnStarted?.(event) !== false,
        chunk: event => this._onAutoTurnChunk?.(event) ?? Promise.resolve(),
        finished: event => this._onAutoTurnFinished?.(event) ?? Promise.resolve(),
        released: turnId => this._onAutoTurnReleased?.(turnId),
        cancelled: event => this._onAutoTurnCancelled?.(event),
        projectEmbeddedExternal: event => this._onEmbeddedExternal?.(event) ?? Promise.resolve(),
        onHostTurnTerminalObserved: (turnId, evidence) => this.noteTranscriptTerminalSeen(turnId, evidence),
        onHostTurnTerminalRetracted: (turnId, reason) => this.noteTranscriptTerminalRetracted(turnId, reason),
        onCliVersionObserved: version => { this.transcriptCliVersion = version; },
      }, () => true, this.transcriptDiagnosticLog, {
        // Observe-mode bypass: verdicts are recorded as diagnostics only.
        recordObservedStart: fact => this.turnReconciliation.recordObservedStart(fact),
      });
      this.transcriptObserver = observer;
      try {
        // The tail-start credentials are consumed exactly once: the first
        // observer start after runtime creation primes at the committed
        // boundary only after re-verifying the snapshot's source identity.
        const tailStart = this.transcriptObserverTailStart ?? undefined;
        this.transcriptObserverTailStart = null;
        await observer.start(target, tailStart);
      } catch (error) {
        // A source-change rejection kills this observer on purpose; the
        // diagnostic carries the session identity (hashed — no paths or raw
        // ids land in the log) so the restart-loop cause stays auditable.
        if (error instanceof Error && /source.*changed/i.test(error.message)) {
          this.transcriptDiagnosticLog?.record({
            phase: 'prime_rejected',
            reason: 'source_changed',
            conversationIdHash: this.transcriptDiagnosticLog.hashId(sessionId ?? 'unknown'),
            detail: 'observer_start',
          });
        }
        observer.stop('start_failed');
        if (this.transcriptObserver === observer) this.transcriptObserver = null;
        if (this.transcriptObserverTarget === target) this.transcriptObserverTarget = null;
        return;
      }
      // Observer rebuild (session init/switch): restore the CURRENT dispatch
      // anchor AFTER start (start's internal stop would clear it). A late
      // observer initialization must never stamp "now" in place of the real
      // dispatch time, and the live host projection carries over (fix 3).
      const savedDispatch = this.currentDispatchDescriptor;
      const liveHostTurnId = this.beginUserTurnProjectionTarget;
      if (liveHostTurnId && savedDispatch
        && (savedDispatch.leaseTurnId === liveHostTurnId || savedDispatch.hostTurnIds.includes(liveHostTurnId))) {
        observer.beginUserTurnProjection(liveHostTurnId);
      }
      if (savedDispatch) {
        try {
          observer.observeDispatch({
            leaseTurnId: savedDispatch.leaseTurnId,
            canonicalUuid: savedDispatch.canonicalTurnId,
            hostTurnIds: savedDispatch.hostTurnIds,
            dispatchedAt: savedDispatch.dispatchedAt,
            isManualCompact: savedDispatch.isManualCompact,
          });
        } catch {
          // Best-effort anchor restore.
        }
      }
      if (target !== this.transcriptObserverTarget && this.transcriptObserver === observer) {
        observer.stop('session_switch');
        this.transcriptObserver = null;
      }
    });
  }

  /**
   * Cleanup resources (Phase 5).
   * Called on plugin unload to close persistent query and abort any cold-start query.
   */
  cleanup() {
    this.transcriptObserverTarget = null;
    this.transcriptObserver?.stop('plugin_cleanup');
    this.transcriptObserver = null;
    this.turnReconciliation.advanceSessionGeneration();
    // Close persistent query. Plugin teardown is an explicit recovery entry:
    // the next plugin load owns the slot lifecycle from scratch.
    this.closePersistentQuery('plugin cleanup', { clearStartProhibition: true });

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
    // Lazy runtime contract: a hydrated tab that has never sent a message has
    // no persistent query. Start it on demand with the same lazy startup the
    // send path uses in query() (startPersistentQuery with the current
    // session), so rewind doesn't fail with a bare "No active query".
    // All failure paths below throw before any file or message state is
    // touched — the rewind service only runs once a query exists.
    if (!this.persistentQuery && !this.shuttingDown) {
      const vaultPath = getVaultPath(this.plugin.app);
      if (!vaultPath) {
        throw new Error('Could not determine vault path');
      }
      const cliPath = this.plugin.getResolvedProviderCliPath('claude');
      if (!cliPath) {
        throw new Error('Claude CLI not found. Please install Claude Code CLI.');
      }
      try {
        await this.startPersistentQuery(
          vaultPath,
          cliPath,
          this.sessionManager.getSessionId() ?? undefined
        );
      } catch (error) {
        throw new Error(
          `Rewind could not start the Claude session: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { cause: error },
        );
      }
    }
    if (!this.persistentQuery) {
      throw new Error('Rewind could not start the Claude session');
    }
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

  /**
   * Payload contract (#1894 semantics): the value is the PROVIDER-NORMALIZED
   * app permission mode (a policy value, plus the fork's transient 'plan'),
   * never the raw Claude SDK mode. The runtime reverse-maps observations
   * before invoking this callback.
   */
  setPermissionModeSyncCallback(callback: ((appMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  /**
   * Scope-guarded native permission sync (design §5.2): reverse-maps an
   * observed SDK mode onto the provider app mode, updates the live config,
   * and notifies the feature layer — all through the same owner. Unknown
   * native modes (dontAsk, delegate, ...) never masquerade as a toolbar
   * value; a retired scope's late message never writes back.
   */
  private syncNativePermissionMode(sdkMode: unknown, scope: QueryScope | null): void {
    if (scope !== null && !this.isCurrentQueryScope(scope)) {
      return;
    }
    const appMode = resolveClaudeAppPermissionModeFromSdk(sdkMode);
    if (appMode === null) {
      return;
    }
    if (this.currentConfig) {
      this.currentConfig.permissionMode = appMode;
      this.currentConfig.sdkPermissionMode = isClaudePermissionMode(appMode)
        ? resolveClaudeSdkPermissionModeForRuntime(appMode)
        : 'plan';
    }
    if (this.permissionModeSyncCallback) {
      try { this.permissionModeSyncCallback(appMode); } catch { /* non-critical */ }
    }
  }

  setSubagentHookProvider(getState: () => SubagentHookState): void {
    this._subagentStateProvider = getState;
  }

  setAutoTurnCallback(callback: ((result: AutoTurnResult) => void) | null): void {
    this._autoTurnCallback = callback;
  }

  /** S1: fired synchronously when an SDK-initiated (auto) turn starts. */
  setOnAutoTurnStarted(callback: ((event: AutoTurnStartedEvent) => unknown) | null): void {
    this._onAutoTurnStarted = callback;
  }

  setOnAutoTurnChunk(callback: ((event: AutoTurnChunkEvent) => Promise<void>) | null): void {
    this._onAutoTurnChunk = callback;
  }


  /** Feature finalization is awaited before runtime settlement and lease release. */
  setOnAutoTurnFinished(callback: ((event: AutoTurnFinishedEvent) => Promise<void>) | null): void {
    this._onAutoTurnFinished = callback;
    this.restartTranscriptObserver(this.sessionManager.getSessionId());
  }

  /** S2 (v4 §3.1 step 7): lease gone + channel released → UI queue may proceed. */
  setOnAutoTurnReleased(callback: ((turnId: string) => void) | null): void {
    this._onAutoTurnReleased = callback;
  }

  /** S2 (v3 §4.2): feature clears only the cancelled turn's state. */
  setOnAutoTurnCancelled(callback: ((event: AutoTurnCancelledEvent) => void) | null): void {
    this._onAutoTurnCancelled = callback;
  }

  setOnEmbeddedExternal(callback: ((event: AutoTurnStartedEvent) => Promise<void>) | null): void {
    this._onEmbeddedExternal = callback;
  }

  recordAutoTurnDiagnostic(event: AutoTurnDiagnosticEvent): void {
    this.transcriptDiagnosticLog?.record({
      ...event,
      ...(event.turnId ? { turnIdHash: this.transcriptDiagnosticLog.hashId(event.turnId) } : {}),
    });
  }

  /** Runtime-side settlement diagnostics: hashes the turn id when a log exists. */
  private recordTranscriptDiagnostic(event: TranscriptDiagnosticEvent & { turnId?: string }): void {
    const log = this.transcriptDiagnosticLog;
    if (!log) return;
    const { turnId, ...rest } = event;
    log.record(turnId !== undefined ? { ...rest, turnIdHash: log.hashId(turnId) } : rest);
  }

  /**
   * P0-1: stamp the observer tick time at which the transcript first showed
   * the host turn's terminal state. First-seen wins: later ticks (quiet
   * settle, trailing rows) must not extend the threshold. The evidence
   * payload (compact vs stop_hook, CLI version) only rides the compact path.
   */
  private noteTranscriptTerminalSeen(turnId: string, evidence?: { kind: 'compact' | 'stop_hook'; cliVersion?: string }): void {
    const turn = this.runtimeTurns.get(turnId);
    if (!turn || turn.phase === 'settled' || turn.phase === 'cancelled') return;
    if (turn.transcriptTerminalSeenAt === null) {
      turn.transcriptTerminalSeenAt = Date.now();
      if (evidence) {
        turn.transcriptTerminalSource = evidence.kind;
        if (evidence.cliVersion) turn.transcriptTerminalCliVersion = evidence.cliVersion;
      }
    }
  }

  /**
   * Fix 1 (2026-11-05): strong continuation proof retracts the stamped
   * terminal evidence. The watchdog can re-arm on the turn's NEW terminal;
   * any live recovery attempt freezes out via the evidence revision bump
   * (its liveness check re-verifies the revision).
   */
  private noteTranscriptTerminalRetracted(turnId: string, reason: string): void {
    const turn = this.runtimeTurns.get(turnId);
    if (!turn || turn.phase === 'settled' || turn.phase === 'cancelled') return;
    if (turn.transcriptTerminalSeenAt !== null) {
      turn.transcriptTerminalSeenAt = null;
      turn.transcriptTerminalSource = undefined;
      turn.transcriptTerminalCliVersion = undefined;
      turn.evidenceRevision += 1;
      this.recordTranscriptDiagnostic({
        phase: 'host_terminal_retracted', turnId, generation: turn.generation, detail: reason,
      });
    }
  }

  /**
   * P0-2 runPhase bypass: SDK session_state_changed carries the CLI agent
   * loop phase ('idle' fires after held-back results flush and the
   * background-agent gate exits). Read-only, never throws into routing.
   */
  private noteSessionStateChange(message: SDKMessage): void {
    if (message.type !== 'system' || message.subtype !== 'session_state_changed') return;
    const state = (message as { state?: string }).state ?? 'unknown';
    this.recordTranscriptDiagnostic({ phase: 'run_phase', detail: state });
  }

  /**
   * P0-3 interrupt acknowledgement: escalate only when the CLI produced NO
   * response evidence since the interrupt — no message routed to the turn's
   * lease (chunk, trailing result, even one the cancelled gate drops) and no
   * settlement completing. A turn still registered behind the projection
   * barrier is NOT evidence of a dead cancel (reviewer #3): the feature
   * close-out (completeUserTurnProjection) can legitimately outlast the
   * window while the CLI already responded. Complements the feature-side
   * forceSettleForDeadCancel watchdog, which only drops flags.
   */
  private armInterruptAcknowledgementWatchdog(turnId: string | null): void {
    if (!turnId) return;
    // Snapshot taken after cancelTurn ran (its own phase mutation is local,
    // never CLI evidence): only post-interrupt changes count as a response.
    const turn = this.runtimeTurns.get(turnId);
    const routedEvidenceAt = turn?.lastRoutedMessageAt ?? null;
    setTimeout(() => {
      const current = this.runtimeTurns.get(turnId);
      if (!current || current.phase === 'settled') return;
      if (this.shuttingDown || !this.persistentQuery) return;
      if (current.lastRoutedMessageAt !== routedEvidenceAt) return;
      this.recordTranscriptDiagnostic({ phase: 'interrupt_sent', turnId, detail: 'interrupt_unacknowledged' });
      void this.persistentQuery.interrupt().catch(() => {
        // Silence abort/interrupt errors
      });
      new Notice(t('chat.cancel.interruptUnacknowledged'));
    }, INTERRUPT_ACK_WATCHDOG_MS);
  }

  /** Turn-lease hotfix fix 6: notify the feature layer on an unregistered dequeue. */
  setOnUnregisteredTurnDequeued(callback: ((turnId: string) => void) | null): void {
    this._onUnregisteredTurnDequeued = callback;
  }

  private createApprovalCallback(): CanUseTool {
    const callback = createClaudeApprovalCallback({
      getAllowedTools: () => this.currentAllowedTools,
      getApprovalCallback: () => this.approvalCallback,
      getAskUserQuestionCallback: () => this.askUserQuestionCallback,
      getExitPlanModeCallback: () => this.exitPlanModeCallback,
      // Scoped snapshot, never the top-level projection another provider owns.
      getPermissionMode: () => resolveClaudeRuntimePermissionMode(
        this.getScopedSettings().permissionMode,
        this.getScopedSettings() as unknown as Record<string, unknown>,
      ),
      resolveSDKPermissionMode: (mode) => this.resolveSDKPermissionMode(mode),
      syncPermissionMode: (mode, sdkMode) => {
        if (this.currentConfig) {
          this.currentConfig.permissionMode = mode;
          this.currentConfig.sdkPermissionMode = sdkMode;
        }
      },
    });
    return async (...args) => {
      this.pendingCanUseToolCount += 1;
      try {
        return await callback(...args);
      } finally {
        this.pendingCanUseToolCount -= 1;
      }
    };
  }

  private resolveSDKPermissionMode(mode: string): SDKPermissionMode {
    return QueryOptionsBuilder.resolveClaudeSdkPermissionMode(
      mode,
      this.getScopedSettings() as unknown as Record<string, unknown>,
    ) as SDKPermissionMode;
  }
}
