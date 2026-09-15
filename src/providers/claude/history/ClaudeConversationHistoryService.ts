import type {
  ConversationHistoryHydrationResult,
  HistoryIndexLease,
  HistoryLoadBudget,
  HistoryLoadProgress,
  HistoryRangePage,
  HistorySearchResult,
  HistoryWindowPage,
  HistoryWindowRequest,
  ProviderConversationHistoryService,
} from '../../../core/providers/types';
import { isSubagentToolName, TOOL_TASK } from '../../../core/tools/toolNames';
import type {
  AsyncSubagentStatus,
  ChatMessage,
  Conversation,
  ForkSource,
  SubagentInfo,
  ToolCallInfo,
} from '../../../core/types';
import { ClaudeTranscriptDiagnosticLog } from '../transcript/ClaudeTranscriptDiagnosticLog';
import { type ClaudeProviderState, getClaudeState } from '../types/providerState';
import {
  deleteSDKSession,
  loadSDKSessionMessages,
  loadSubagentToolCalls,
  materializeSDKMessages,
  sdkSessionExists,
} from './ClaudeHistoryStore';
import {
  buildTranscriptIndex,
  materializeTranscriptEntries,
  materializeTranscriptPage,
  materializeTranscriptToolAssociations,
  protectTranscriptIndex,
  releaseTranscriptIndex,
  setTranscriptIndexDiagnosticSink,
  type TranscriptHistoryIndex,
} from './ClaudeTranscriptHistoryIndex';
import {
  buildOversizedEntryPlaceholder,
  buildOversizedTurnMarker,
  hardCapChatProjection,
  HISTORY_SUMMARY_LIMITS,
  measureChatProjectionChars,
  summarizeChatMessages,
} from './HistorySummaryProjection';
import { planHistoryWindow } from './HistoryWindowPlanner';
import type { SDKNativeMessage } from './sdkHistoryTypes';
import { getSDKSessionPath } from './sdkSessionPaths';

function chooseRicherResult(sdkResult?: string, cachedResult?: string): string | undefined {
  const sdkText = typeof sdkResult === 'string' ? sdkResult.trim() : '';
  const cachedText = typeof cachedResult === 'string' ? cachedResult.trim() : '';

  if (sdkText.length === 0 && cachedText.length === 0) return undefined;
  if (sdkText.length === 0) return cachedResult;
  if (cachedText.length === 0) return sdkResult;

  return sdkText.length >= cachedText.length ? sdkResult : cachedResult;
}

function chooseRicherToolCalls(
  sdkToolCalls: ToolCallInfo[] = [],
  cachedToolCalls: ToolCallInfo[] = [],
): ToolCallInfo[] {
  if (sdkToolCalls.length >= cachedToolCalls.length) {
    return sdkToolCalls;
  }

  return cachedToolCalls;
}

function normalizeAsyncStatus(
  subagent: SubagentInfo | undefined,
  modeOverride?: SubagentInfo['mode'],
): AsyncSubagentStatus | undefined {
  if (!subagent) return undefined;

  const mode = modeOverride ?? subagent.mode;
  if (mode === 'sync') return undefined;
  if (mode === 'async') return subagent.asyncStatus ?? subagent.status;
  return subagent.asyncStatus;
}

function isTerminalAsyncStatus(status: AsyncSubagentStatus | undefined): boolean {
  return status === 'completed' || status === 'error' || status === 'orphaned';
}

function mergeSubagentInfo(
  taskToolCall: ToolCallInfo,
  cachedSubagent: SubagentInfo,
): SubagentInfo {
  const sdkSubagent = taskToolCall.subagent;
  const cachedAsyncStatus = normalizeAsyncStatus(cachedSubagent);
  if (!sdkSubagent) {
    return {
      ...cachedSubagent,
      asyncStatus: cachedAsyncStatus,
      result: chooseRicherResult(taskToolCall.result, cachedSubagent.result),
    };
  }

  const sdkAsyncStatus = normalizeAsyncStatus(sdkSubagent);
  const sdkIsTerminal = isTerminalAsyncStatus(sdkAsyncStatus);
  const cachedIsTerminal = isTerminalAsyncStatus(cachedAsyncStatus);
  const sdkResult = taskToolCall.result ?? sdkSubagent.result;

  const preferred = (!sdkIsTerminal && cachedIsTerminal) ? cachedSubagent : sdkSubagent;

  const mergedMode = sdkSubagent.mode
    ?? cachedSubagent.mode
    ?? (taskToolCall.input?.run_in_background === true ? 'async' : undefined);
  const fallbackResult = chooseRicherResult(sdkResult, cachedSubagent.result);
  const mergedResult = preferred === cachedSubagent
    ? (cachedSubagent.result ?? fallbackResult)
    : fallbackResult;
  const mergedAsyncStatus = normalizeAsyncStatus(preferred, mergedMode);

  return {
    ...cachedSubagent,
    ...sdkSubagent,
    description: sdkSubagent.description || cachedSubagent.description,
    prompt: sdkSubagent.prompt || cachedSubagent.prompt,
    mode: mergedMode,
    status: preferred.status,
    asyncStatus: mergedAsyncStatus,
    result: mergedResult,
    toolCalls: chooseRicherToolCalls(sdkSubagent.toolCalls, cachedSubagent.toolCalls),
    agentId: sdkSubagent.agentId || cachedSubagent.agentId,
    outputToolId: sdkSubagent.outputToolId || cachedSubagent.outputToolId,
    startedAt: sdkSubagent.startedAt ?? cachedSubagent.startedAt,
    completedAt: sdkSubagent.completedAt ?? cachedSubagent.completedAt,
    isExpanded: sdkSubagent.isExpanded ?? cachedSubagent.isExpanded,
  };
}

function ensureTaskToolCall(
  msg: ChatMessage,
  subagentId: string,
  subagent: SubagentInfo,
): ToolCallInfo {
  msg.toolCalls = msg.toolCalls || [];
  let taskToolCall = msg.toolCalls.find(
    tc => tc.id === subagentId && isSubagentToolName(tc.name),
  );

  if (!taskToolCall) {
    taskToolCall = {
      id: subagentId,
      name: TOOL_TASK,
      input: {
        description: subagent.description,
        prompt: subagent.prompt || '',
        ...(subagent.mode === 'async' ? { run_in_background: true } : {}),
      },
      status: subagent.status,
      result: subagent.result,
      isExpanded: false,
      subagent,
    };
    msg.toolCalls.push(taskToolCall);
    return taskToolCall;
  }

  if (!taskToolCall.input.description) {
    taskToolCall.input.description = subagent.description;
  }
  if (!taskToolCall.input.prompt) {
    taskToolCall.input.prompt = subagent.prompt || '';
  }
  if (subagent.mode === 'async') {
    taskToolCall.input.run_in_background = true;
  }
  const mergedSubagent = mergeSubagentInfo(taskToolCall, subagent);
  taskToolCall.status = mergedSubagent.status;
  if (mergedSubagent.mode === 'async') {
    taskToolCall.input.run_in_background = true;
  }
  if (mergedSubagent.result !== undefined) {
    taskToolCall.result = mergedSubagent.result;
  }
  taskToolCall.subagent = mergedSubagent;
  return taskToolCall;
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const result: ChatMessage[] = [];

  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }

  return result;
}

async function enrichAsyncSubagentToolCalls(
  subagentData: Record<string, SubagentInfo>,
  vaultPath: string,
  sessionIds: string[],
): Promise<void> {
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) return;

  const loaderCache = new Map<string, ReturnType<typeof loadSubagentToolCalls>>();

  for (const subagent of Object.values(subagentData)) {
    if (subagent.mode !== 'async') continue;
    if (!subagent.agentId) continue;
    if ((subagent.toolCalls?.length ?? 0) > 0) continue;

    for (const sessionId of uniqueSessionIds) {
      const cacheKey = `${sessionId}:${subagent.agentId}`;

      let loader = loaderCache.get(cacheKey);
      if (!loader) {
        loader = loadSubagentToolCalls(vaultPath, sessionId, subagent.agentId);
        loaderCache.set(cacheKey, loader);
      }

      const recoveredToolCalls = await loader;
      if (recoveredToolCalls.length === 0) continue;

      subagent.toolCalls = recoveredToolCalls.map(toolCall => ({
        ...toolCall,
        input: { ...toolCall.input },
      }));
      break;
    }
  }
}

function applySubagentData(
  messages: ChatMessage[],
  subagentData: Record<string, SubagentInfo>,
): void {
  const attachedSubagentIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    for (const [subagentId, subagent] of Object.entries(subagentData)) {
      const hasSubagentBlock = msg.contentBlocks?.some(
        block => (block.type === 'subagent' && block.subagentId === subagentId)
          || (block.type === 'tool_use' && block.toolId === subagentId),
      );
      const hasTaskToolCall = msg.toolCalls?.some(tc => tc.id === subagentId) ?? false;

      if (!hasSubagentBlock && !hasTaskToolCall) continue;
      ensureTaskToolCall(msg, subagentId, subagent);

      if (!msg.contentBlocks) {
        msg.contentBlocks = [];
      }

      let hasNormalizedSubagentBlock = false;
      for (let i = 0; i < msg.contentBlocks.length; i++) {
        const block = msg.contentBlocks[i];
        if (block.type === 'tool_use' && block.toolId === subagentId) {
          msg.contentBlocks[i] = {
            type: 'subagent',
            subagentId,
            mode: subagent.mode,
          };
          hasNormalizedSubagentBlock = true;
        } else if (block.type === 'subagent' && block.subagentId === subagentId && !block.mode) {
          block.mode = subagent.mode;
          hasNormalizedSubagentBlock = true;
        } else if (block.type === 'subagent' && block.subagentId === subagentId) {
          hasNormalizedSubagentBlock = true;
        }
      }

      if (!hasNormalizedSubagentBlock && hasTaskToolCall) {
        msg.contentBlocks.push({
          type: 'subagent',
          subagentId,
          mode: subagent.mode,
        });
      }

      attachedSubagentIds.add(subagentId);
    }
  }

  for (const [subagentId, subagent] of Object.entries(subagentData)) {
    if (attachedSubagentIds.has(subagentId)) continue;

    let anchor = [...messages].reverse().find((msg): msg is ChatMessage => msg.role === 'assistant');
    if (!anchor) {
      anchor = {
        id: `subagent-recovery-${subagentId}`,
        role: 'assistant',
        content: '',
        timestamp: subagent.completedAt ?? subagent.startedAt ?? Date.now(),
        contentBlocks: [],
      };
      messages.push(anchor);
    }

    ensureTaskToolCall(anchor, subagentId, subagent);

    anchor.contentBlocks = anchor.contentBlocks || [];
    const hasSubagentBlock = anchor.contentBlocks.some(
      block => block.type === 'subagent' && block.subagentId === subagentId,
    );
    if (!hasSubagentBlock) {
      anchor.contentBlocks.push({
        type: 'subagent',
        subagentId,
        mode: subagent.mode,
      });
    }
  }
}

function buildPersistedSubagentData(messages: ChatMessage[]): Record<string, SubagentInfo> {
  const result: Record<string, SubagentInfo> = {};

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;

    for (const toolCall of msg.toolCalls) {
      if (!isSubagentToolName(toolCall.name) || !toolCall.subagent) continue;
      result[toolCall.subagent.id] = toolCall.subagent;
    }
  }

  return result;
}

function sanitizeProviderState(
  providerState: ClaudeProviderState,
): Record<string, unknown> | undefined {
  const sanitizedEntries = Object.entries(providerState).filter(([, value]) => value !== undefined);
  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}

interface IndexedSegment {
  sessionId: string;
  index: TranscriptHistoryIndex;
}

interface ConversationIndexState {
  conversationId: string;
  vaultPath: string;
  segments: IndexedSegment[];
  flattenedTurns: Array<{ segment: IndexedSegment; turnIndex: number }>;
}

interface SharedHistoryIndex {
  refs: number;
  controller: AbortController;
  ready: Promise<ConversationIndexState>;
  state?: ConversationIndexState;
  protectedPaths: string[];
}

export class ClaudeConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationIds = new Set<string>();
  private sharedIndexes = new Map<string, SharedHistoryIndex>();
  private indexDiagnostics: ClaudeTranscriptDiagnosticLog | null = null;
  private windowDiagnostics: ClaudeTranscriptDiagnosticLog | null = null;

  // The index module probes worker_threads once per process; route its fallback
  // event into a dedicated diagnostics file so worker degradation stays visible
  // without surfacing anything in the UI. Window materialization gets its own
  // log so budget/oversized behavior is observable on real giant sessions.
  private ensureIndexDiagnostics(vaultPath: string): void {
    if (this.indexDiagnostics) return;
    const diagnostics = new ClaudeTranscriptDiagnosticLog(vaultPath, () => {}, 'history-index');
    this.indexDiagnostics = diagnostics;
    this.windowDiagnostics = new ClaudeTranscriptDiagnosticLog(vaultPath, () => {}, 'history-window');
    setTranscriptIndexDiagnosticSink(event => diagnostics.record(event));
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getClaudeState(conversation.providerState);
    return !!state.forkSource
      && !state.providerSessionId
      && !conversation.sessionId;
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;
    const state = getClaudeState(conversation.providerState);
    return state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const state: ClaudeProviderState = {
      forkSource: { sessionId: sourceSessionId, resumeAt } satisfies ForkSource,
    };
    return state as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const providerState: ClaudeProviderState = {
      ...getClaudeState(conversation.providerState),
    };

    const subagentData = {
      ...(providerState.subagentData ?? {}),
      ...buildPersistedSubagentData(conversation.messages),
    };
    if (Object.keys(subagentData).length > 0) providerState.subagentData = subagentData;

    return sanitizeProviderState(providerState);
  }

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<ConversationHistoryHydrationResult> {
    if (!vaultPath || this.hydratedConversationIds.has(conversation.id)) {
      return { status: 'ready' };
    }
    this.ensureIndexDiagnostics(vaultPath);

    const state = getClaudeState(conversation.providerState);
    const isPendingFork = this.isPendingForkConversation(conversation);
    const allSessionIds: string[] = isPendingFork
      ? [state.forkSource!.sessionId]
      : [
          ...(state.previousProviderSessionIds || []),
          state.providerSessionId ?? conversation.sessionId,
        ].filter((id): id is string => !!id);

    if (allSessionIds.length === 0) {
      return { status: 'ready' };
    }

    const allSdkMessages: ChatMessage[] = [];
    let missingSessionCount = 0;
    const errors: Array<{ sessionId: string; message: string }> = [];
    const oversizeSegments: Array<{ sessionId: string; sizeBytes: number }> = [];

    const currentSessionId = isPendingFork
      ? state.forkSource!.sessionId
      : (state.providerSessionId ?? conversation.sessionId);

    for (const sessionId of allSessionIds) {
      if (!sdkSessionExists(vaultPath, sessionId)) {
        missingSessionCount++;
        continue;
      }

      const isCurrentSession = sessionId === currentSessionId;
      const truncateAt = isCurrentSession
        ? (isPendingFork ? state.forkSource!.resumeAt : conversation.resumeAtMessageId)
        : undefined;
      const result = await loadSDKSessionMessages(vaultPath, sessionId, truncateAt);

      if (result.status === 'oversize') {
        oversizeSegments.push({ sessionId, sizeBytes: result.sizeBytes ?? 0 });
        // Oversize hydration only reports structured state; the active tab
        // builds the index exclusively through acquireHistoryIndex so the same
        // snapshot is never rebuilt twice from split entry points.
        continue;
      }
      if (result.status === 'failed') {
        errors.push({ sessionId, message: result.error ?? 'Unknown history read error' });
        continue;
      }

      allSdkMessages.push(...result.messages);
    }

    if (oversizeSegments.length > 0) {
      return { status: 'oversize', segments: oversizeSegments };
    }
    if (errors.length > 0) {
      return { status: 'error', errors };
    }

    const allSessionsMissing = missingSessionCount === allSessionIds.length;
    if (allSessionsMissing) {
      this.hydratedConversationIds.add(conversation.id);
      return { status: 'ready' };
    }

    const filteredSdkMessages = allSdkMessages.filter(msg => !msg.isRebuiltContext);

    const merged = dedupeMessages([
      ...conversation.messages,
      ...filteredSdkMessages,
    ]).sort((a, b) => a.timestamp - b.timestamp);

    if (state.subagentData) {
      await enrichAsyncSubagentToolCalls(
        state.subagentData,
        vaultPath,
        allSessionIds,
      );
      applySubagentData(merged, state.subagentData);
    }

    conversation.messages = merged;
    this.hydratedConversationIds.add(conversation.id);
    return { status: 'ready' };
  }

  acquireHistoryIndex(
    conversation: Conversation,
    vaultPath: string | null,
    onProgress?: (progress: HistoryLoadProgress) => void,
    forceNewSnapshot = false,
  ): HistoryIndexLease {
    if (!vaultPath) throw new Error('Vault path is unavailable');
    this.ensureIndexDiagnostics(vaultPath);
    if (forceNewSnapshot) this.sharedIndexes.delete(conversation.id);
    let shared = this.sharedIndexes.get(conversation.id);
    if (!shared) {
      const controller = new AbortController();
      shared = {
        refs: 0,
        controller,
        protectedPaths: [],
        ready: this.buildConversationIndex(conversation, vaultPath, controller.signal, onProgress),
      };
      this.sharedIndexes.set(conversation.id, shared);
      void shared.ready.then(state => {
        if (this.sharedIndexes.get(conversation.id) !== shared) return;
        shared!.state = state;
        shared!.protectedPaths = state.segments.map(segment => segment.index.filePath);
        shared!.protectedPaths.forEach(protectTranscriptIndex);
      }).catch(() => {
        if (this.sharedIndexes.get(conversation.id) === shared) {
          this.sharedIndexes.delete(conversation.id);
        }
      });
    }
    shared.refs += 1;
    const fixed = shared;
    let released = false;
    const ready = fixed.ready.then(() => undefined);
    return {
      conversationId: conversation.id,
      get totalTurns() { return fixed.state?.flattenedTurns.length ?? 0; },
      ready,
      search: async query => this.searchIndex(await fixed.ready, query),
      loadRange: async (start, end) => this.materializeRange(await fixed.ready, start, end),
      loadWindow: async request => this.materializeWindow(await fixed.ready, request),
      planWindow: request => {
        if (!fixed.state) throw new Error('History index is not ready for window planning');
        const plan = this.planWindowFor(fixed.state, request);
        return { start: plan.start, end: plan.end };
      },
      release: () => {
        if (released) return;
        released = true;
        fixed.refs -= 1;
        if (fixed.refs > 0) return;
        // Unfinished builds abort; completed indexes only lose their lease
        // protection and stay in the global completed cache as idle entries
        // so reopening the same snapshot hits instead of rebuilding.
        if (!fixed.state) fixed.controller.abort();
        fixed.protectedPaths.forEach(releaseTranscriptIndex);
        if (this.sharedIndexes.get(conversation.id) === fixed) {
          this.sharedIndexes.delete(conversation.id);
        }
        this.windowDiagnostics?.record({ phase: 'lease_release' });
      },
    };
  }

  private async buildConversationIndex(
    conversation: Conversation,
    vaultPath: string,
    signal: AbortSignal,
    onProgress?: (progress: HistoryLoadProgress) => void,
  ): Promise<ConversationIndexState> {
    const providerState = getClaudeState(conversation.providerState);
    const currentSessionId = providerState.providerSessionId ?? conversation.sessionId ?? providerState.forkSource?.sessionId;
    if (!currentSessionId) throw new Error('Conversation has no Claude session');
    const sessionIds = [...(providerState.previousProviderSessionIds ?? []), currentSessionId];
    const segments: IndexedSegment[] = [];
    onProgress?.({ phase: 'queued' });
    for (const sessionId of sessionIds) {
      if (!sdkSessionExists(vaultPath, sessionId)) continue;
      const result = await buildTranscriptIndex(getSDKSessionPath(vaultPath, sessionId), {
        resumeAtMessageId: sessionId === currentSessionId
          ? (providerState.forkSource?.resumeAt ?? conversation.resumeAtMessageId)
          : undefined,
        signal,
        onProgress: (bytes, totalBytes) => onProgress?.({
          phase: 'indexing',
          percent: totalBytes > 0 ? Math.min(100, Math.round(bytes / totalBytes * 100)) : 100,
        }),
        onFinalize: () => onProgress?.({ phase: 'finalizing' }),
      });
      if (result.status === 'failed' || result.status === 'partial') throw new Error(result.error);
      segments.push({ sessionId, index: result.index });
    }
    if (segments.length === 0) throw new Error('Conversation transcript is unavailable');
    const flattenedTurns = segments.flatMap(segment =>
      segment.index.turns.map((_, turnIndex) => ({ segment, turnIndex }))
    );
    return { conversationId: conversation.id, vaultPath, segments, flattenedTurns };
  }

  private searchIndex(state: ConversationIndexState, query: string): HistorySearchResult[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const results: HistorySearchResult[] = [];
    const ordinals = new Map<string, number>();
    let globalTurnOffset = 0;
    for (const segment of state.segments) {
      for (const item of segment.index.searchCorpus) {
        const text = segment.index.searchText.slice(item.textOffset, item.textOffset + item.textLength);
        const lowerText = text.toLocaleLowerCase();
        let matchStart = lowerText.indexOf(needle);
        while (matchStart >= 0) {
          const matchOrdinal = ordinals.get(item.projectionKey) ?? 0;
          results.push({
            projectionKey: item.projectionKey,
            turnIndex: globalTurnOffset + item.turnIndex,
            matchOrdinal,
            matchedText: text.slice(matchStart, matchStart + query.trim().length),
          });
          ordinals.set(item.projectionKey, matchOrdinal + 1);
          matchStart = lowerText.indexOf(needle, matchStart + needle.length);
        }
      }
      globalTurnOffset += segment.index.turns.length;
    }
    return results.sort((a, b) =>
      a.turnIndex - b.turnIndex
      || a.projectionKey.localeCompare(b.projectionKey)
      || a.matchOrdinal - b.matchOrdinal
    );
  }

  private async materializeRange(
    state: ConversationIndexState,
    start: number,
    end: number,
  ): Promise<HistoryRangePage> {
    const total = state.flattenedTurns.length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > total) {
      throw new RangeError(`Invalid history range [${start}, ${end}) for ${total} turns`);
    }
    const selected = state.flattenedTurns.slice(start, end);
    const messages: ChatMessage[] = [];
    for (const segment of state.segments) {
      const indexes = selected.filter(item => item.segment === segment).map(item => item.turnIndex);
      if (indexes.length === 0) continue;
      const native = await materializeTranscriptPage(segment.index, indexes[0], indexes.length);
      const associations = await materializeTranscriptToolAssociations(segment.index, native);
      messages.push(...await materializeSDKMessages(state.vaultPath, segment.sessionId, native, associations));
    }
    const current = state.segments[state.segments.length - 1];
    return {
      messages: dedupeMessages(messages).sort((a, b) => a.timestamp - b.timestamp),
      range: { start, end },
      snapshotOffset: current.index.snapshotSize,
    };
  }

  private turnSourceBytes(state: ConversationIndexState): number[] {
    return state.flattenedTurns.map(item => item.segment.index.turns[item.turnIndex].sourceBytes ?? 0);
  }

  private planWindowFor(state: ConversationIndexState, request: HistoryWindowRequest) {
    return planHistoryWindow(this.turnSourceBytes(state), {
      anchorTurn: request.anchorTurn,
      direction: request.direction,
      budget: request.budget,
      minTurn: request.minTurn,
      maxTurn: request.maxTurn,
    });
  }

  private async materializeTurn(
    state: ConversationIndexState,
    segment: IndexedSegment,
    turnIndex: number,
  ): Promise<ChatMessage[]> {
    const native = await materializeTranscriptPage(segment.index, turnIndex, 1);
    const associations = await materializeTranscriptToolAssociations(segment.index, native);
    return materializeSDKMessages(state.vaultPath, segment.sessionId, native, associations);
  }

  /**
   * Bounded materialization of one oversized turn. Entries are read from the
   * head (turn opener) and tail (final answer) within the byte budget; giant
   * entries and the squeezed middle are replaced by explicit omission markers.
   */
  private async materializeSummaryTurn(
    state: ConversationIndexState,
    segment: IndexedSegment,
    turnIndex: number,
    budget: HistoryLoadBudget,
  ): Promise<{ messages: ChatMessage[]; readBytes: number }> {
    const index = segment.index;
    const turn = index.turns[turnIndex];
    const entries = index.entries.slice(turn.startEntry, turn.endEntry + 1);
    const selected = new Array<boolean>(entries.length).fill(false);
    const headBudget = Math.floor(budget.maxSourceBytes * 0.6);
    let readBytes = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.length > HISTORY_SUMMARY_LIMITS.entryReadBytes || readBytes + entry.length > headBudget) continue;
      selected[i] = true;
      readBytes += entry.length;
    }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (selected[i]) continue;
      const entry = entries[i];
      if (entry.length > HISTORY_SUMMARY_LIMITS.entryReadBytes || readBytes + entry.length > budget.maxSourceBytes) continue;
      selected[i] = true;
      readBytes += entry.length;
    }
    const read = entries.filter((_, i) => selected[i]);
    const skipped = entries.filter((_, i) => !selected[i]);
    const native = read.length > 0 ? await materializeTranscriptEntries(index, read) : [];
    const synthetic: SDKNativeMessage[] = skipped
      .map(entry => buildOversizedEntryPlaceholder(entry))
      .filter((message): message is SDKNativeMessage => message !== null);
    if (skipped.length > 0) {
      synthetic.push(buildOversizedTurnMarker(turn.turnId, skipped, entries[entries.length - 1]?.timestamp));
    }
    const combined = [...native, ...synthetic];
    const messages = await materializeSDKMessages(state.vaultPath, segment.sessionId, combined, combined);
    summarizeChatMessages(messages);
    return { messages, readBytes };
  }

  private async materializeWindow(
    state: ConversationIndexState,
    request: HistoryWindowRequest,
  ): Promise<HistoryWindowPage> {
    const startedAt = performance.now();
    const total = state.flattenedTurns.length;
    const plan = this.planWindowFor(state, request);
    this.windowDiagnostics?.record({
      phase: 'window_planned',
      turnCount: plan.end - plan.start,
      sourceBytes: plan.plannedSourceBytes,
    });
    const messages: ChatMessage[] = [];
    let actualStart = plan.end;
    let sourceBytes = 0;
    let projectedChars = 0;
    let oversizedTurnCount = 0;
    // Materialize newest-first so budget overruns drop older turns and the
    // anchor-adjacent turn always survives (giant turn -> summary, not empty;
    // the planner already guarantees a non-empty plan includes that turn).
    for (let index = plan.end - 1; index >= plan.start; index -= 1) {
      const item = state.flattenedTurns[index];
      const turnBytes = item.segment.index.turns[item.turnIndex].sourceBytes ?? 0;
      const oversized = turnBytes > request.budget.maxSourceBytes;
      let produced: ChatMessage[];
      let readBytes: number;
      let shrunk = oversized;
      if (oversized) {
        const summary = await this.materializeSummaryTurn(state, item.segment, item.turnIndex, request.budget);
        produced = summary.messages;
        readBytes = summary.readBytes;
      } else {
        produced = await this.materializeTurn(state, item.segment, item.turnIndex);
        readBytes = turnBytes;
      }
      // Per-turn hard ceiling: `isNewest` only exempts the cumulative window
      // admission below, never this cap — an anchor turn whose summary
      // projection alone exceeds the char budget is hard-capped to the real
      // measured value (identity and order survive, payloads shrink).
      let chars = measureChatProjectionChars(produced);
      if (chars > request.budget.maxProjectedChars) {
        const capped = hardCapChatProjection(produced, request.budget.maxProjectedChars);
        produced = capped.messages;
        chars = capped.projectedChars;
        shrunk = true;
      }
      const isNewest = index === plan.end - 1;
      if (!isNewest && (
        projectedChars + chars > request.budget.maxProjectedChars
        || sourceBytes + readBytes > request.budget.maxSourceBytes
      )) {
        break;
      }
      messages.push(...produced);
      sourceBytes += readBytes;
      projectedChars += chars;
      if (shrunk) oversizedTurnCount += 1;
      actualStart = index;
    }
    const current = state.segments[state.segments.length - 1];
    this.windowDiagnostics?.record({
      phase: 'window_complete',
      turnCount: actualStart < plan.end ? plan.end - actualStart : 0,
      sourceBytes,
      projectedChars,
      oversizedTurns: oversizedTurnCount,
      elapsedMs: performance.now() - startedAt,
    });
    return {
      messages: dedupeMessages(messages).sort((a, b) => a.timestamp - b.timestamp),
      range: { start: actualStart, end: plan.end },
      snapshotOffset: current.index.snapshotSize,
      sourceBytes,
      projectedChars,
      oversizedTurnCount,
      pageKey: `w:${actualStart}:${plan.end}`,
      hasMoreBefore: actualStart > 0,
      hasMoreAfter: plan.end < total,
    };
  }

  async exportFullHistory(conversation: Conversation, vaultPath: string | null): Promise<ChatMessage[]> {
    if (!vaultPath) return [...conversation.messages];
    const lease = this.acquireHistoryIndex(conversation, vaultPath);
    try {
      await lease.ready;
      if (lease.totalTurns === 0) return [];
      return (await lease.loadRange(0, lease.totalTurns)).messages;
    } finally {
      lease.release();
    }
  }

  async deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const state = getClaudeState(conversation.providerState);
    const sessionId = state.providerSessionId ?? conversation.sessionId;
    if (!vaultPath || !sessionId) {
      return;
    }

    await deleteSDKSession(vaultPath, sessionId);
  }
}
