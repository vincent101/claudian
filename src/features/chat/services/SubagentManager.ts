import { existsSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, sep } from 'path';

import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { ProviderTaskResultInterpreter } from '../../../core/providers/types';
import { TOOL_TASK } from '../../../core/tools/toolNames';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import type {
  SubagentInfo,
  SubagentMode,
  ToolCallInfo,
} from '../../../core/types';
import { extractFinalResultFromSubagentJsonl } from '../../../utils/subagentJsonl';
import {
  addSubagentToolCall,
  applySubagentToolResult,
  type AsyncSubagentState,
  createAsyncSubagentBlock,
  createSubagentBlock,
  finalizeAsyncSubagent,
  finalizeSubagentBlock,
  markAsyncSubagentOrphaned,
  mergeSubagentToolCall,
  type SubagentState,
  updateAsyncSubagentRunning,
  updateSubagentToolResult,
} from '../rendering/SubagentRenderer';
import type { PendingToolCall } from '../state/types';

export type SubagentStateChangeCallback = (subagent: SubagentInfo) => void;

export type HandleTaskResult =
  | { action: 'buffered' }
  | { action: 'created_sync'; info: SubagentInfo; domState?: SubagentState }
  | { action: 'created_async'; info: SubagentInfo; domState?: AsyncSubagentState }
  | { action: 'label_updated' };

export type RenderPendingResult =
  | { mode: 'sync'; info: SubagentInfo; domState?: SubagentState }
  | { mode: 'async'; info: SubagentInfo; domState?: AsyncSubagentState };

export class SubagentManager {
  private static readonly TRUSTED_OUTPUT_EXT = '.output';
  private static readonly TRUSTED_TMP_ROOTS = SubagentManager.resolveTrustedTmpRoots();

  /** Domain truth for live sync subagents (v3 §5.2): id → SubagentInfo. */
  private syncSubagentRecords: Map<string, SubagentInfo> = new Map();
  /** Optional DOM projector cache for sync subagents; entries share the domain info object. */
  private syncDomStates: Map<string, SubagentState> = new Map();
  private pendingTasks: Map<string, PendingToolCall> = new Map();
  private _spawnedThisStream = 0;

  private activeAsyncSubagents: Map<string, SubagentInfo> = new Map();
  private pendingAsyncSubagents: Map<string, SubagentInfo> = new Map();
  private taskIdToAgentId: Map<string, string> = new Map();
  private outputToolIdToAgentId: Map<string, string> = new Map();
  private asyncDomStates: Map<string, AsyncSubagentState> = new Map();

  // Fix 2 (秒完成竞态缓解): task-id -> terminal payload for notifications that
  // arrived before the pending -> active promotion. Bounded LRU.
  private seenTerminalNotifications: Map<string, { status: string; result: string | null }> = new Map();
  private static readonly SEEN_TERMINAL_NOTIFICATIONS_LIMIT = 100;

  private onStateChange: SubagentStateChangeCallback;
  private taskResultInterpreter: ProviderTaskResultInterpreter;

  constructor(
    onStateChange: SubagentStateChangeCallback,
    taskResultInterpreter: ProviderTaskResultInterpreter = ProviderRegistry.getTaskResultInterpreter(),
  ) {
    this.onStateChange = onStateChange;
    this.taskResultInterpreter = taskResultInterpreter;
  }

  public setCallback(callback: SubagentStateChangeCallback): void {
    this.onStateChange = callback;
  }

  public setTaskResultInterpreter(interpreter: ProviderTaskResultInterpreter): void {
    this.taskResultInterpreter = interpreter;
  }

  // ============================================
  // Unified Subagent Entry Point
  // ============================================

  /**
   * Handles an Agent tool_use chunk with minimal buffering to determine sync vs async.
   * Returns a typed result so StreamController can update messages accordingly.
   *
   * Domain-first (v3 §5.2): a known `run_in_background` mode creates the domain
   * entry immediately even without a parent element; only mode-unknown tasks
   * are buffered as pending.
   */
  public handleTaskToolUse(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    currentContentEl: HTMLElement | null
  ): HandleTaskResult {
    // Already created as sync → update label on domain record (+ DOM if attached)
    const existingSyncRecord = this.syncSubagentRecords.get(taskToolId);
    if (existingSyncRecord) {
      const existingSyncState = this.syncDomStates.get(taskToolId);
      this.updateSubagentLabel(
        existingSyncRecord,
        taskInput,
        existingSyncState?.wrapperEl ?? null
      );
      return { action: 'label_updated' };
    }

    // Already created as async → update label on domain record (+ DOM if attached)
    const existingAsyncRecord = this.getByTaskId(taskToolId);
    if (existingAsyncRecord && existingAsyncRecord.mode === 'async') {
      const existingAsyncState = this.asyncDomStates.get(taskToolId);
      this.updateSubagentLabel(
        existingAsyncRecord,
        taskInput,
        existingAsyncState?.wrapperEl ?? null
      );
      return { action: 'label_updated' };
    }

    // Already buffered → merge input and try to render
    const pending = this.pendingTasks.get(taskToolId);
    if (pending) {
      const newInput = taskInput || {};
      if (Object.keys(newInput).length > 0) {
        pending.toolCall.input = { ...pending.toolCall.input, ...newInput };
      }
      if (currentContentEl) {
        pending.parentEl = currentContentEl;
      }

      // Do not lock mode before run_in_background is explicitly known.
      // Sync fallback is handled when child chunks/tool_result confirm sync.
      if (this.resolveTaskMode(pending.toolCall.input)) {
        const result = this.renderPendingTask(taskToolId, currentContentEl);
        if (result) {
          return result.mode === 'sync'
            ? { action: 'created_sync', info: result.info, domState: result.domState }
            : { action: 'created_async', info: result.info, domState: result.domState };
        }
      }
      return { action: 'buffered' };
    }

    const mode = this.resolveTaskMode(taskInput);
    if (!mode) {
      const toolCall: ToolCallInfo = {
        id: taskToolId,
        name: TOOL_TASK,
        input: taskInput || {},
        status: 'running',
        isExpanded: false,
      };
      this.pendingTasks.set(taskToolId, { toolCall, parentEl: currentContentEl });
      return { action: 'buffered' };
    }

    this._spawnedThisStream++;
    if (mode === 'async') {
      return this.createAsyncTask(taskToolId, taskInput, currentContentEl);
    }
    return this.createSyncTask(taskToolId, taskInput, currentContentEl);
  }

  // ============================================
  // Pending Task Resolution
  // ============================================

  public hasPendingTask(toolId: string): boolean {
    return this.pendingTasks.has(toolId);
  }

  /**
   * Renders a buffered pending task. Called when a child chunk or tool_result
   * confirms the task is sync, or when run_in_background becomes known.
   * Uses the optional parentEl override, falling back to the stored parentEl.
   * Domain-first (v3 §5.2): resolves and records the domain entry even
   * without a DOM target.
   */
  public renderPendingTask(
    toolId: string,
    parentElOverride?: HTMLElement | null
  ): RenderPendingResult | null {
    const pending = this.pendingTasks.get(toolId);
    if (!pending) return null;

    const input = pending.toolCall.input;
    const targetEl = parentElOverride ?? pending.parentEl;

    this.pendingTasks.delete(toolId);

    try {
      if (input.run_in_background === true) {
        const result = this.createAsyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_async') {
          this._spawnedThisStream++;
          return { mode: 'async', info: result.info, domState: result.domState };
        }
      } else {
        const result = this.createSyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_sync') {
          this._spawnedThisStream++;
          return { mode: 'sync', info: result.info, domState: result.domState };
        }
      }
    } catch {
      // Non-fatal: task appears incomplete but doesn't crash the stream
    }

    return null;
  }

  /**
   * Resolves a pending Task when its own tool_result arrives.
   * If mode is still unknown, infer async from task result shape (agent_id/agentId),
   * otherwise fall back to sync so it never remains pending indefinitely.
   * Domain-first (v3 §5.2): infers the mode and creates the domain entry even
   * without a DOM target — the caller then processes the same tool_result
   * against the new entry.
   */
  public renderPendingTaskFromTaskResult(
    toolId: string,
    taskResult: unknown,
    isError: boolean,
    parentElOverride?: HTMLElement | null,
    taskToolUseResult?: unknown
  ): RenderPendingResult | null {
    const pending = this.pendingTasks.get(toolId);
    if (!pending) return null;

    const input = pending.toolCall.input;
    const targetEl = parentElOverride ?? pending.parentEl;

    const explicitMode = this.resolveTaskMode(input);
    const taskResultText = extractToolResultContent(taskResult, { fallbackIndent: 2 });
    const inferredMode = explicitMode
      ?? this.inferModeFromTaskResult(taskResultText, isError, taskToolUseResult);

    this.pendingTasks.delete(toolId);

    try {
      if (inferredMode === 'async') {
        const result = this.createAsyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_async') {
          this._spawnedThisStream++;
          return { mode: 'async', info: result.info, domState: result.domState };
        }
      } else {
        const result = this.createSyncTask(pending.toolCall.id, input, targetEl);
        if (result.action === 'created_sync') {
          this._spawnedThisStream++;
          return { mode: 'sync', info: result.info, domState: result.domState };
        }
      }
    } catch {
      // Non-fatal: task appears incomplete but doesn't crash the stream
    }

    return null;
  }

  // ============================================
  // Sync Subagent Operations
  // ============================================

  /** Domain record for a live sync subagent (DOM projector optional). */
  public getSyncSubagent(toolId: string): SubagentInfo | undefined {
    return this.syncSubagentRecords.get(toolId);
  }

  public addSyncToolCall(parentToolUseId: string, toolCall: ToolCallInfo): void {
    const record = this.syncSubagentRecords.get(parentToolUseId);
    if (!record) return;
    const domState = this.syncDomStates.get(parentToolUseId);
    if (domState) {
      addSubagentToolCall(domState, toolCall);
      return;
    }
    mergeSubagentToolCall(record, toolCall);
  }

  public updateSyncToolResult(
    parentToolUseId: string,
    toolId: string,
    toolCall: ToolCallInfo
  ): void {
    const record = this.syncSubagentRecords.get(parentToolUseId);
    if (!record) return;
    const domState = this.syncDomStates.get(parentToolUseId);
    if (domState) {
      updateSubagentToolResult(domState, toolId, toolCall);
      return;
    }
    applySubagentToolResult(record, toolId, toolCall);
  }

  public finalizeSyncSubagent(
    toolId: string,
    result: unknown,
    isError: boolean,
    toolUseResult?: unknown
  ): SubagentInfo | null {
    const record = this.syncSubagentRecords.get(toolId);
    if (!record) return null;

    const resultText = extractToolResultContent(result, { fallbackIndent: 2 });
    const extractedResult = this.extractAgentResult(resultText, '', toolUseResult);
    const domState = this.syncDomStates.get(toolId);
    if (domState) {
      finalizeSubagentBlock(domState, extractedResult, isError);
    } else {
      // Domain-only terminal transition (v3 §5.2): no projector attached.
      record.status = isError ? 'error' : 'completed';
      record.result = extractedResult;
    }
    this.syncSubagentRecords.delete(toolId);
    this.syncDomStates.delete(toolId);

    return record;
  }

  // ============================================
  // Async Subagent Lifecycle
  // ============================================

  /**
   * Returns the early-settled SubagentInfo when the promotion consumed a
   * seen terminal notification (秒完成竞态) — the caller then runs the same
   * sidecar hydration as the notification entry. Undefined in every other
   * path, including error transitions and normal promotion to running.
   */
  public handleTaskToolResult(
    taskToolId: string,
    result: unknown,
    isError?: boolean,
    toolUseResult?: unknown
  ): SubagentInfo | undefined {
    const subagent = this.pendingAsyncSubagents.get(taskToolId);
    if (!subagent) return undefined;
    const resultText = extractToolResultContent(result, { fallbackIndent: 2 });

    if (isError) {
      this.transitionToError(subagent, taskToolId, resultText || 'Task failed to start');
      return undefined;
    }

    const agentId = this.taskResultInterpreter.extractAgentId(toolUseResult) ?? this.parseAgentId(resultText);

    if (!agentId) {
      const truncatedResult = resultText.length > 100 ? resultText.substring(0, 100) + '...' : resultText;
      this.transitionToError(subagent, taskToolId, `Failed to parse agent_id. Result: ${truncatedResult}`);
      return undefined;
    }

    subagent.asyncStatus = 'running';
    subagent.agentId = agentId;
    subagent.startedAt = Date.now();

    this.pendingAsyncSubagents.delete(taskToolId);
    this.activeAsyncSubagents.set(agentId, subagent);
    this.taskIdToAgentId.set(taskToolId, agentId);

    // Fix 2 (秒完成竞态缓解): the completion notification may have arrived
    // before this promotion. If we already saw a terminal status for this
    // agentId, settle it as terminal instead of leaving it running forever.
    const earlyTerminal = this.seenTerminalNotifications.get(agentId);
    if (earlyTerminal) {
      this.seenTerminalNotifications.delete(agentId);
      this.settleActiveSubagent(subagent, agentId, earlyTerminal.status, earlyTerminal.result);
      return subagent;
    }

    this.projectAsyncSubagentState(subagent);
    this.onStateChange(subagent);
    return undefined;
  }

  // ============================================
  // Fix 2: Task Notification Settlement
  // ============================================

  /**
   * Fix 2 (通知直接销账): settles an async subagent from a harness
   * task-notification. The notification is the authoritative terminal signal —
   * arriving here settles the bookkeeping immediately, without waiting for a
   * TaskOutput round-trip.
   *
   * Terminal statuses: completed / killed / failed (+ 'stopped', the structured
   * SDK spelling of killed). Only active entries (key = agentId = task-id) are
   * settled; pending entries (launch in flight) are recorded in the
   * seen-terminal short table and settled at promotion time.
   * Idempotent: unknown task-ids are tolerated silently.
   * Returns the settled SubagentInfo, or undefined when nothing was settled.
   */
  public handleTaskNotification(taskId: string, status: string, result?: string | null): SubagentInfo | undefined {
    const normalized = status.trim().toLowerCase();
    if (
      normalized !== 'completed' &&
      normalized !== 'killed' &&
      normalized !== 'failed' &&
      normalized !== 'stopped'
    ) {
      return undefined; // non-terminal notification — ignore
    }

    const subagent = this.activeAsyncSubagents.get(taskId);
    if (!subagent) {
      // Notification arrived before promotion (or unknown task) — record for
      // the promotion-time check. Unknown ids age out via the LRU bound.
      this.rememberTerminalNotification(taskId, normalized, result);
      return undefined;
    }

    this.settleActiveSubagent(subagent, taskId, normalized, result);
    return subagent;
  }

  private settleActiveSubagent(
    subagent: SubagentInfo,
    agentId: string,
    status: string,
    result?: string | null
  ): void {
    const finalStatus: 'completed' | 'error' = status === 'completed' ? 'completed' : 'error';
    const trimmedResult = typeof result === 'string' ? result.trim() : '';

    subagent.asyncStatus = finalStatus;
    subagent.status = finalStatus;
    subagent.result = trimmedResult || subagent.result || `Task ${status}`;
    subagent.completedAt = Date.now();

    if (subagent.outputToolId) {
      this.outputToolIdToAgentId.delete(subagent.outputToolId);
    }
    this.activeAsyncSubagents.delete(agentId);
    this.removeTaskIdIndexEntries(agentId);

    this.projectAsyncSubagentState(subagent);
    this.onStateChange(subagent);
  }

  /**
   * Drops taskIdToAgentId entries pointing at a settled agent. The index
   * exists so getByTaskId can resolve a live agent's record; past settlement
   * the entries are unreachable dead weight (getByTaskId already returns
   * undefined via the empty active map). SubagentInfo does not carry its
   * taskToolId, so resolve by value scan — one entry per live agent, settles
   * are rare, full clears happen on orphanAllActive/clear anyway.
   */
  private removeTaskIdIndexEntries(agentId: string): void {
    for (const [taskToolId, mappedAgentId] of this.taskIdToAgentId) {
      if (mappedAgentId === agentId) {
        this.taskIdToAgentId.delete(taskToolId);
      }
    }
  }

  private rememberTerminalNotification(taskId: string, status: string, result?: string | null): void {
    // Refresh insertion order for LRU freshness, then evict the oldest entry.
    this.seenTerminalNotifications.delete(taskId);
    this.seenTerminalNotifications.set(taskId, {
      status,
      result: typeof result === 'string' ? result : null,
    });
    while (this.seenTerminalNotifications.size > SubagentManager.SEEN_TERMINAL_NOTIFICATIONS_LIMIT) {
      const oldest = this.seenTerminalNotifications.keys().next().value;
      if (oldest === undefined) break;
      this.seenTerminalNotifications.delete(oldest);
    }
  }

  public handleAgentOutputToolUse(toolCall: ToolCallInfo): void {
    const agentId = this.extractAgentIdFromInput(toolCall.input);
    if (!agentId) return;

    const subagent = this.activeAsyncSubagents.get(agentId);
    if (!subagent) return;

    subagent.outputToolId = toolCall.id;
    this.outputToolIdToAgentId.set(toolCall.id, agentId);
  }

  public handleAgentOutputToolResult(
    toolId: string,
    result: unknown,
    isError: boolean,
    toolUseResult?: unknown
  ): SubagentInfo | undefined {
    const resultText = extractToolResultContent(result, { fallbackIndent: 2 });
    let agentId = this.outputToolIdToAgentId.get(toolId);
    let subagent = agentId ? this.activeAsyncSubagents.get(agentId) : undefined;

    if (!subagent) {
      const inferredAgentId = this.inferAgentIdFromResult(resultText);
      if (inferredAgentId) {
        agentId = inferredAgentId;
        subagent = this.activeAsyncSubagents.get(inferredAgentId);
      }
    }

    if (!subagent) return undefined;

    if (agentId) {
      subagent.agentId = subagent.agentId || agentId;
      this.outputToolIdToAgentId.set(toolId, agentId);
    }

    if (subagent.asyncStatus !== 'running') {
      return undefined;
    }

    const stillRunning = this.isStillRunningResult(resultText, isError);
    if (stillRunning) {
      this.outputToolIdToAgentId.delete(toolId);
      return subagent;
    }

    const extractedResult = this.extractAgentResult(resultText, agentId ?? '', toolUseResult);

    // The chunk's is_error flag can be unreliable for async subagent results
    // (SDK may set is_error on the content block even when the agent succeeded).
    // Prefer the structured toolUseResult to determine actual error status.
    const finalStatus = this.taskResultInterpreter.resolveTerminalStatus(
      toolUseResult,
      isError ? 'error' : 'completed',
    );

    subagent.asyncStatus = finalStatus;
    subagent.status = finalStatus;
    subagent.result = extractedResult;
    subagent.completedAt = Date.now();

    if (agentId) {
      this.activeAsyncSubagents.delete(agentId);
      this.removeTaskIdIndexEntries(agentId);
    }
    this.outputToolIdToAgentId.delete(toolId);

    this.projectAsyncSubagentState(subagent);
    this.onStateChange(subagent);
    return subagent;
  }

  public isPendingAsyncTask(taskToolId: string): boolean {
    return this.pendingAsyncSubagents.has(taskToolId);
  }

  public isLinkedAgentOutputTool(toolId: string): boolean {
    return this.outputToolIdToAgentId.has(toolId);
  }

  public getByTaskId(taskToolId: string): SubagentInfo | undefined {
    const pending = this.pendingAsyncSubagents.get(taskToolId);
    if (pending) return pending;

    const agentId = this.taskIdToAgentId.get(taskToolId);
    if (agentId) {
      return this.activeAsyncSubagents.get(agentId);
    }

    return undefined;
  }

  /**
   * Re-renders an async subagent after data-only updates (for example,
   * hydrating tool calls from SDK sidecar files) without changing lifecycle state.
   */
  public refreshAsyncSubagent(subagent: SubagentInfo): void {
    this.projectAsyncSubagentState(subagent);
    this.onStateChange(subagent);
  }

  // ============================================
  // Hook State
  // ============================================

  public hasRunningSubagents(): boolean {
    // stale-hook patch（2026-08-09，自运行中 main.js 移植）：进程退出丢失状态的 agent 会永远卡在 Map 里，
    // 导致 stop hook 永久 block。超过 STALE_MS 无生命的 "running" 条目视为僵尸清理放行；
    // 真实活跃 agent（startedAt 距今 < 2h）仍正常拦截，保护语义保留。
    const STALE_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();
    const isLive = (s?: SubagentInfo): boolean => now - (s?.startedAt ?? 0) < STALE_MS;
    for (const [id, s] of this.pendingAsyncSubagents) {
      if (!isLive(s)) this.pendingAsyncSubagents.delete(id);
    }
    for (const [id, s] of this.activeAsyncSubagents) {
      if (!isLive(s)) {
        // Route through the unified terminal chain instead of a silent
        // asyncStatus flip: the record needs status/result/completedAt, DOM
        // projection, onStateChange (poll chains observe 'orphaned' and
        // stop), and taskId index cleanup — same as any other terminal path.
        // No re-entry risk: onStateChange's running branch only schedules
        // chains for 'running', and the schedule Set dedupes by agentId.
        this.markOrphaned(s);
        this.activeAsyncSubagents.delete(id);
      }
    }
    return this.pendingAsyncSubagents.size > 0 || this.activeAsyncSubagents.size > 0;
  }

  // ============================================
  // Lifecycle
  // ============================================

  public get subagentsSpawnedThisStream(): number {
    return this._spawnedThisStream;
  }

  public resetSpawnedCount(): void {
    this._spawnedThisStream = 0;
  }

  public resetStreamingState(): void {
    this.syncSubagentRecords.clear();
    this.syncDomStates.clear();
    this.pendingTasks.clear();
  }

  public orphanAllActive(): SubagentInfo[] {
    const orphaned: SubagentInfo[] = [];

    for (const subagent of this.pendingAsyncSubagents.values()) {
      this.markOrphaned(subagent);
      orphaned.push(subagent);
    }

    for (const subagent of this.activeAsyncSubagents.values()) {
      if (subagent.asyncStatus === 'running') {
        this.markOrphaned(subagent);
        orphaned.push(subagent);
      }
    }

    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
    this.taskIdToAgentId.clear();
    this.outputToolIdToAgentId.clear();

    return orphaned;
  }

  public clear(): void {
    this.syncSubagentRecords.clear();
    this.syncDomStates.clear();
    this.pendingTasks.clear();
    this.pendingAsyncSubagents.clear();
    this.activeAsyncSubagents.clear();
    this.taskIdToAgentId.clear();
    this.outputToolIdToAgentId.clear();
    this.asyncDomStates.clear();
    this.seenTerminalNotifications.clear();
  }

  // ============================================
  // Deferred Projection Attach
  // ============================================

  /**
   * Attaches a DOM projector to an existing domain record (v3 §5.2): renders
   * the current state in one pass when the tab becomes visible or after a
   * reload. No-op when no live domain record exists for the task (settled
   * entries already live in the message data).
   */
  public attachProjection(taskId: string, parentEl: HTMLElement): void {
    const syncRecord = this.syncSubagentRecords.get(taskId);
    if (syncRecord) {
      if (this.syncDomStates.has(taskId)) return;
      const state = createSubagentBlock(parentEl, taskId, {
        description: syncRecord.description,
        prompt: syncRecord.prompt,
      });
      state.info = syncRecord;
      for (const toolCall of syncRecord.toolCalls) {
        addSubagentToolCall(state, {
          ...toolCall,
          input: { ...toolCall.input },
        });
      }
      this.syncDomStates.set(taskId, state);
      return;
    }

    const asyncRecord = this.getByTaskId(taskId);
    if (asyncRecord && asyncRecord.mode === 'async' && !this.asyncDomStates.has(taskId)) {
      const domState = createAsyncSubagentBlock(parentEl, taskId, {
        description: asyncRecord.description,
        prompt: asyncRecord.prompt,
      });
      domState.info = asyncRecord;
      this.asyncDomStates.set(taskId, domState);

      switch (asyncRecord.asyncStatus) {
        case 'running':
          updateAsyncSubagentRunning(domState, asyncRecord.agentId || '');
          break;
        case 'completed':
        case 'error':
          finalizeAsyncSubagent(domState, asyncRecord.result || '', asyncRecord.asyncStatus === 'error');
          break;
        case 'orphaned':
          markAsyncSubagentOrphaned(domState);
          break;
        default:
          break; // 'pending' — initial block state already matches
      }
    }
  }

  // ============================================
  // Private: State Transitions
  // ============================================

  private markOrphaned(subagent: SubagentInfo): void {
    subagent.asyncStatus = 'orphaned';
    subagent.status = 'error';
    subagent.result = 'Conversation ended before task completed';
    subagent.completedAt = Date.now();
    // Index entries for a dead agent are unreachable dead weight; drop them
    // with the state transition so callers need not each remember to.
    if (subagent.agentId) {
      this.removeTaskIdIndexEntries(subagent.agentId);
    }
    this.projectAsyncSubagentState(subagent);
    this.onStateChange(subagent);
  }

  private transitionToError(subagent: SubagentInfo, taskToolId: string, errorResult: string): void {
    subagent.asyncStatus = 'error';
    subagent.status = 'error';
    subagent.result = errorResult;
    subagent.completedAt = Date.now();
    this.pendingAsyncSubagents.delete(taskToolId);
    this.projectAsyncSubagentState(subagent);
    this.onStateChange(subagent);
  }

  // ============================================
  // Private: Task Creation
  // ============================================

  /**
   * Creates a sync subagent domain record. The DOM block is an optional
   * projection (v3 §5.2): a null parentEl still creates the domain entry.
   */
  private createSyncTask(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    parentEl: HTMLElement | null
  ): HandleTaskResult {
    let info: SubagentInfo;
    if (parentEl) {
      const subagentState = createSubagentBlock(parentEl, taskToolId, taskInput);
      this.syncDomStates.set(taskToolId, subagentState);
      info = subagentState.info;
    } else {
      info = {
        id: taskToolId,
        description: (taskInput.description as string) || 'Subagent task',
        prompt: (taskInput.prompt as string) || '',
        status: 'running',
        toolCalls: [],
        isExpanded: false,
      };
    }
    this.syncSubagentRecords.set(taskToolId, info);
    return { action: 'created_sync', info };
  }

  /**
   * Creates an async subagent domain entry. The DOM block is an optional
   * projection (v3 §5.2): a null parentEl still creates the pending entry.
   */
  private createAsyncTask(
    taskToolId: string,
    taskInput: Record<string, unknown>,
    parentEl: HTMLElement | null
  ): HandleTaskResult {
    const description = (taskInput.description as string) || 'Background task';
    const prompt = (taskInput.prompt as string) || '';

    const info: SubagentInfo = {
      id: taskToolId,
      description,
      prompt,
      mode: 'async' as SubagentMode,
      isExpanded: false,
      status: 'running',
      toolCalls: [],
      asyncStatus: 'pending',
    };

    this.pendingAsyncSubagents.set(taskToolId, info);

    if (parentEl) {
      const domState = createAsyncSubagentBlock(parentEl, taskToolId, taskInput);
      // Projector references the domain record so later transitions stay in sync.
      domState.info = info;
      this.asyncDomStates.set(taskToolId, domState);
    }

    return { action: 'created_async', info };
  }

  // ============================================
  // Private: Label Update
  // ============================================

  /** Updates description/prompt on the domain record; DOM label refresh is optional. */
  private updateSubagentLabel(
    info: SubagentInfo,
    newInput: Record<string, unknown>,
    wrapperEl: HTMLElement | null
  ): void {
    if (!newInput || Object.keys(newInput).length === 0) return;
    const description = (newInput.description as string) || '';
    if (description) {
      info.description = description;
      const labelEl = wrapperEl?.querySelector('.claudian-subagent-label') as HTMLElement | null;
      if (labelEl) {
        const truncated = description.length > 40 ? description.substring(0, 40) + '...' : description;
        labelEl.setText(truncated);
      }
    }
    const prompt = (newInput.prompt as string) || '';
    if (prompt) {
      info.prompt = prompt;
      const promptEl = wrapperEl?.querySelector('.claudian-subagent-prompt-text') as HTMLElement | null;
      if (promptEl) {
        promptEl.setText(prompt);
      }
    }
  }

  private resolveTaskMode(taskInput: Record<string, unknown>): 'sync' | 'async' | null {
    if (!Object.prototype.hasOwnProperty.call(taskInput, 'run_in_background')) {
      return null;
    }
    if (taskInput.run_in_background === true) {
      return 'async';
    }
    if (taskInput.run_in_background === false) {
      return 'sync';
    }
    return null;
  }

  private inferModeFromTaskResult(
    taskResult: string,
    isError: boolean,
    taskToolUseResult?: unknown
  ): 'sync' | 'async' {
    if (isError) {
      return 'sync';
    }
    if (this.taskResultInterpreter.hasAsyncLaunchMarker(taskToolUseResult)) {
      return 'async';
    }
    // Only promote to async for launch-shaped payloads. Completed sync results
    // can still contain agent metadata in the payload or final output text.
    return this.parseAgentIdStrict(taskResult) ? 'async' : 'sync';
  }

  private parseAgentIdStrict(result: string): string | null {
    const payload = this.unwrapTextPayload(result).trim();
    if (!payload) {
      return null;
    }

    try {
      const parsed = JSON.parse(payload);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }

      if (this.hasTerminalTaskStatus(parsed)) {
        return null;
      }

      const directAgentId = this.extractAgentIdFromRecord(parsed as Record<string, unknown>);
      if (directAgentId) {
        return directAgentId;
      }

      const taskRecord = (parsed as Record<string, unknown>).task;
      if (taskRecord && typeof taskRecord === 'object' && !Array.isArray(taskRecord)) {
        return this.extractAgentIdFromRecord(taskRecord as Record<string, unknown>);
      }
    } catch {
      // Not JSON
    }

    const xmlStatus = this.taskResultInterpreter.extractTagValue(payload, 'retrieval_status')
      ?? this.taskResultInterpreter.extractTagValue(payload, 'status');
    if (this.isTerminalTaskStatusValue(xmlStatus)) {
      return null;
    }

    const exactLineMatch = payload.match(/^\s*(?:agent_id|agentId)\s*[=:]\s*"?([a-zA-Z0-9_-]+)"?\s*$/i);
    return exactLineMatch?.[1] ?? null;
  }

  private hasTerminalTaskStatus(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    const rawStatus = record.retrieval_status ?? record.status;
    return this.isTerminalTaskStatusValue(rawStatus);
  }

  private isTerminalTaskStatusValue(rawStatus: unknown): boolean {
    if (typeof rawStatus !== 'string') {
      return false;
    }

    const normalized = rawStatus.toLowerCase();
    return normalized === 'completed' || normalized === 'success' || normalized === 'error';
  }

  private extractAgentIdFromRecord(record: Record<string, unknown>): string | null {
    const direct = record.agent_id ?? record.agentId;
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }

    const data = record.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }

    const nested = (data as Record<string, unknown>).agent_id ?? (data as Record<string, unknown>).agentId;
    return typeof nested === 'string' && nested.length > 0 ? nested : null;
  }

  private extractAgentIdFromString(value: string): string | null {
    const regexPatterns = [
      /"agent_id"\s*:\s*"([^"]+)"/,
      /"agentId"\s*:\s*"([^"]+)"/,
      /agent_id[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
      /agentId[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
    ];

    for (const pattern of regexPatterns) {
      const match = value.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  // ============================================
  // Private: Async DOM State Updates
  // ============================================

  /**
   * Optional DOM projector (v3 §5.2): silently skips when no projector is
   * attached — the domain transition and onStateChange have already happened
   * before this is called.
   */
  private projectAsyncSubagentState(subagent: SubagentInfo): void {
    // Find DOM state by task ID first, then by agentId
    let asyncState = this.asyncDomStates.get(subagent.id);

    if (!asyncState) {
      for (const s of this.asyncDomStates.values()) {
        if (s.info.agentId === subagent.agentId) {
          asyncState = s;
          break;
        }
      }
      if (!asyncState) return;
    }

    asyncState.info = subagent;

    switch (subagent.asyncStatus) {
      case 'running':
        updateAsyncSubagentRunning(asyncState, subagent.agentId || '');
        break;

      case 'completed':
      case 'error':
        finalizeAsyncSubagent(asyncState, subagent.result || '', subagent.asyncStatus === 'error');
        break;

      case 'orphaned':
        markAsyncSubagentOrphaned(asyncState);
        break;
    }
  }

  // ============================================
  // Private: Async Parsing Logic
  // ============================================

  private isStillRunningResult(result: string, isError: boolean): boolean {
    const trimmed = result?.trim() || '';
    const payload = this.unwrapTextPayload(trimmed);

    if (isError) return false;
    if (!trimmed) return false;

    try {
      const parsed = JSON.parse(payload);
      const status = parsed.retrieval_status || parsed.status;
      const hasAgents = parsed.agents && Object.keys(parsed.agents).length > 0;

      if (status === 'not_ready' || status === 'running' || status === 'pending') {
        return true;
      }

      if (hasAgents) {
        const agentStatuses = Object.values(parsed.agents as Record<string, unknown>)
          .map((a) => (a && typeof a === 'object' && 'status' in a && typeof (a as Record<string, unknown>).status === 'string') ? ((a as Record<string, unknown>).status as string).toLowerCase() : '');
        const anyRunning = agentStatuses.some(s =>
          s === 'running' || s === 'pending' || s === 'not_ready'
        );
        if (anyRunning) return true;
        return false;
      }

      if (status === 'success' || status === 'completed') {
        return false;
      }

      return false;
    } catch {
      // Not JSON
    }

    const lowerResult = payload.toLowerCase();
    if (lowerResult.includes('not_ready') || lowerResult.includes('not ready')) {
      return true;
    }

    const xmlStatusMatch = lowerResult.match(/<status>([^<]+)<\/status>/);
    if (xmlStatusMatch) {
      const status = xmlStatusMatch[1].trim();
      if (status === 'running' || status === 'pending' || status === 'not_ready') {
        return true;
      }
    }

    return false;
  }

  private extractAgentResult(result: string, agentId: string, toolUseResult?: unknown): string {
    const structuredResult = this.taskResultInterpreter.extractStructuredResult(toolUseResult);
    const normalizedStructuredResult = this.extractResultFromCandidateString(structuredResult);
    if (normalizedStructuredResult) {
      return normalizedStructuredResult;
    }
    if (structuredResult) {
      return structuredResult;
    }

    const payload = this.unwrapTextPayload(result);

    try {
      const parsed = JSON.parse(payload);

      const taskResult = this.extractResultFromTaskObject(parsed.task);
      if (taskResult) {
        return taskResult;
      }

      if (parsed.agents && agentId && parsed.agents[agentId]) {
        const agentData = parsed.agents[agentId];
        const parsedResult = this.extractResultFromCandidateString(agentData?.result);
        if (parsedResult) {
          return parsedResult;
        }
        const parsedOutput = this.extractResultFromCandidateString(agentData?.output);
        if (parsedOutput) {
          return parsedOutput;
        }
        return JSON.stringify(agentData, null, 2);
      }

      if (parsed.agents) {
        const agentIds = Object.keys(parsed.agents);
        if (agentIds.length > 0) {
          const firstAgent = parsed.agents[agentIds[0]];
          const parsedResult = this.extractResultFromCandidateString(firstAgent?.result);
          if (parsedResult) {
            return parsedResult;
          }
          const parsedOutput = this.extractResultFromCandidateString(firstAgent?.output);
          if (parsedOutput) {
            return parsedOutput;
          }
          return JSON.stringify(firstAgent, null, 2);
        }
      }

      const parsedResult = this.extractResultFromCandidateString(parsed.result);
      if (parsedResult) {
        return parsedResult;
      }

      const parsedOutput = this.extractResultFromCandidateString(parsed.output);
      if (parsedOutput) {
        return parsedOutput;
      }

    } catch {
      // Not JSON, return as-is
    }

    const taggedResult = this.extractResultFromTaggedPayload(payload);
    if (taggedResult) {
      return taggedResult;
    }

    return payload;
  }

  private extractResultFromTaskObject(task: unknown): string | null {
    if (!task || typeof task !== 'object') {
      return null;
    }
    const taskRecord = task as Record<string, unknown>;
    return this.extractResultFromCandidateString(taskRecord.result)
      ?? this.extractResultFromCandidateString(taskRecord.output);
  }

  private extractResultFromCandidateString(candidate: unknown): string | null {
    if (typeof candidate !== 'string') {
      return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    const taggedResult = this.extractResultFromTaggedPayload(trimmed);
    if (taggedResult) {
      return taggedResult;
    }

    const jsonlResult = this.extractResultFromOutputJsonl(trimmed);
    if (jsonlResult) {
      return jsonlResult;
    }

    return trimmed;
  }

  private parseAgentId(result: string): string | null {
    const regexPatterns = [
      /"agent_id"\s*:\s*"([^"]+)"/,
      /"agentId"\s*:\s*"([^"]+)"/,
      /agent_id[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
      /agentId[=:]\s*"?([a-zA-Z0-9_-]+)"?/i,
      /\b([a-f0-9]{8})\b/,
    ];

    for (const pattern of regexPatterns) {
      const match = result.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    try {
      const parsed = JSON.parse(result);
      const agentId = parsed.agent_id || parsed.agentId;

      if (typeof agentId === 'string' && agentId.length > 0) {
        return agentId;
      }

      if (parsed.data?.agent_id) {
        return parsed.data.agent_id;
      }

      if (parsed.id && typeof parsed.id === 'string') {
        return parsed.id;
      }
    } catch {
      // Not JSON
    }

    return null;
  }

  private inferAgentIdFromResult(result: string): string | null {
    try {
      const parsed = JSON.parse(result);
      if (parsed.agents && typeof parsed.agents === 'object') {
        const keys = Object.keys(parsed.agents);
        if (keys.length > 0) {
          return keys[0];
        }
      }
    } catch {
      // Not JSON
    }
    return null;
  }

  private unwrapTextPayload(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const textBlock = parsed.find((b: any) => b && typeof b.text === 'string');
        if (textBlock?.text) return textBlock.text as string;
      } else if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
        return parsed.text;
      }
    } catch {
      // Not JSON or not an envelope
    }
    return raw;
  }

  private extractResultFromTaggedPayload(payload: string): string | null {
    const directResult = this.taskResultInterpreter.extractTagValue(payload, 'result');
    if (directResult) return directResult;

    const outputContent = this.taskResultInterpreter.extractTagValue(payload, 'output');
    if (!outputContent) return null;

    const extractedFromJsonl = this.extractResultFromOutputJsonl(outputContent);
    if (extractedFromJsonl) return extractedFromJsonl;

    const nestedResult = this.taskResultInterpreter.extractTagValue(outputContent, 'result');
    if (nestedResult) return nestedResult;

    const trimmed = outputContent.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private extractResultFromOutputJsonl(outputContent: string): string | null {
    const inlineResult = extractFinalResultFromSubagentJsonl(outputContent);
    if (inlineResult) {
      return inlineResult;
    }

    const fullOutputPath = this.extractFullOutputPath(outputContent);
    if (!fullOutputPath) {
      return null;
    }

    const fullOutput = this.readFullOutputFile(fullOutputPath);
    if (!fullOutput) {
      return null;
    }

    return extractFinalResultFromSubagentJsonl(fullOutput);
  }

  private extractFullOutputPath(content: string): string | null {
    const truncatedPattern = /\[Truncated\.\s*Full output:\s*([^\]\n]+)\]/i;
    const match = content.match(truncatedPattern);
    if (!match || !match[1]) {
      return null;
    }

    const outputPath = match[1].trim();
    return outputPath.length > 0 ? outputPath : null;
  }

  private readFullOutputFile(fullOutputPath: string): string | null {
    try {
      if (!this.isTrustedOutputPath(fullOutputPath)) {
        return null;
      }

      if (!existsSync(fullOutputPath)) {
        return null;
      }

      const fileContent = readFileSync(fullOutputPath, 'utf-8');
      const trimmed = fileContent.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  private extractAgentIdFromInput(input: Record<string, unknown>): string | null {
    const agentId = (input.task_id as string) || (input.agentId as string) || (input.agent_id as string);
    return agentId || null;
  }

  private static resolveTrustedTmpRoots(): string[] {
    const roots = new Set<string>();
    const candidates = [tmpdir(), '/tmp', '/private/tmp'];
    for (const candidate of candidates) {
      try {
        roots.add(realpathSync(candidate));
      } catch {
        // Ignore unavailable temp roots.
      }
    }
    return Array.from(roots);
  }

  private isTrustedOutputPath(fullOutputPath: string): boolean {
    if (!isAbsolute(fullOutputPath)) {
      return false;
    }

    if (!fullOutputPath.toLowerCase().endsWith(SubagentManager.TRUSTED_OUTPUT_EXT)) {
      return false;
    }

    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(fullOutputPath);
    } catch {
      return false;
    }

    return SubagentManager.TRUSTED_TMP_ROOTS.some((root) =>
      resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`)
    );
  }
}
