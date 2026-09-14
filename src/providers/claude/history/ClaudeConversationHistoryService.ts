import type {
  ConversationHistoryHydrationResult,
  HistoryPage,
  HistorySearchResult,
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
  clearTranscriptIndexCache,
  materializeTranscriptPage,
  materializeTranscriptToolAssociations,
  protectTranscriptIndex,
  releaseTranscriptIndex,
  setTranscriptIndexDiagnosticSink,
  type TranscriptHistoryIndex,
} from './ClaudeTranscriptHistoryIndex';
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

interface PageCursorState {
  conversationId: string;
  vaultPath: string;
  segments: IndexedSegment[];
  endTurn: number;
  flattenedTurns: Array<{ segment: IndexedSegment; turnIndex: number }>;
}

export class ClaudeConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationIds = new Set<string>();
  private pageCursors = new Map<string, PageCursorState>();
  private searchCursors = new Map<string, PageCursorState>();
  private conversationIndexes = new Map<string, PageCursorState>();
  private protectedConversations = new Map<string, string>();
  private cursorSequence = 0;
  private indexDiagnostics: ClaudeTranscriptDiagnosticLog | null = null;

  // The index module probes worker_threads once per process; route its fallback
  // event into a dedicated diagnostics file so worker degradation stays visible
  // without surfacing anything in the UI.
  private ensureIndexDiagnostics(vaultPath: string): void {
    if (this.indexDiagnostics) return;
    const diagnostics = new ClaudeTranscriptDiagnosticLog(vaultPath, () => {}, 'history-index');
    this.indexDiagnostics = diagnostics;
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

    const subagentData = buildPersistedSubagentData(conversation.messages);
    if (Object.keys(subagentData).length > 0) {
      providerState.subagentData = subagentData;
    } else {
      delete providerState.subagentData;
    }

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
        // M2 shadow only: build the paged-history index without changing M1's
        // blocked UI or starting the runtime/observer. M3 will consume it.
        // Shadow-mode fire-and-forget: snapshotKey stat failures on vanishing
        // transcripts (file-race) must not surface as unhandled rejections.
        void buildTranscriptIndex(getSDKSessionPath(vaultPath, sessionId), {
          resumeAtMessageId: truncateAt,
        }).catch(() => {});
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

  async loadInitialHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pageSize: number,
  ): Promise<HistoryPage> {
    if (!vaultPath) throw new Error('Vault path is unavailable');
    this.ensureIndexDiagnostics(vaultPath);
    const state = getClaudeState(conversation.providerState);
    const currentSessionId = state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId;
    if (!currentSessionId) throw new Error('Conversation has no Claude session');
    const sessionIds = [...(state.previousProviderSessionIds ?? []), currentSessionId];
    const segments: IndexedSegment[] = [];
    for (const sessionId of sessionIds) {
      if (!sdkSessionExists(vaultPath, sessionId)) continue;
      const result = await buildTranscriptIndex(getSDKSessionPath(vaultPath, sessionId), {
        resumeAtMessageId: sessionId === currentSessionId
          ? (state.forkSource?.resumeAt ?? conversation.resumeAtMessageId)
          : undefined,
      });
      if (result.status === 'failed' || result.status === 'partial') throw new Error(result.error);
      segments.push({ sessionId, index: result.index });
    }
    if (segments.length === 0) throw new Error('Conversation transcript is unavailable');
    this.releaseHistory(conversation.id);
    for (const segment of segments) protectTranscriptIndex(segment.index.filePath);
    this.protectedConversations.set(conversation.id, segments.map(segment => segment.index.filePath).join('\n'));
    const flattenedTurns = segments.flatMap(segment =>
      segment.index.turns.map((_, turnIndex) => ({ segment, turnIndex }))
    );
    const startTurn = Math.max(0, flattenedTurns.length - pageSize);
    const cursorState = { conversationId: conversation.id, vaultPath, segments, endTurn: startTurn, flattenedTurns };
    this.conversationIndexes.set(conversation.id, cursorState);
    return this.materializePage(cursorState, pageSize);
  }

  async searchHistory(
    conversation: Conversation,
    vaultPath: string | null,
    query: string,
  ): Promise<HistorySearchResult[]> {
    let state = this.conversationIndexes.get(conversation.id);
    if (!state && vaultPath) {
      await this.loadInitialHistory(conversation, vaultPath, 50);
      state = this.conversationIndexes.get(conversation.id);
    }
    const needle = query.trim().toLocaleLowerCase();
    if (!state || !needle) return [];
    const results: HistorySearchResult[] = [];
    let globalTurnOffset = 0;
    for (const segment of state.segments) {
      for (const item of segment.index.searchCorpus) {
        const matchStart = item.text.toLocaleLowerCase().indexOf(needle);
        if (matchStart < 0) continue;
        const turnIndex = globalTurnOffset + item.turnIndex;
        const cursor = `claude-search:${++this.cursorSequence}`;
        this.searchCursors.set(cursor, { ...state, endTurn: turnIndex });
        const contextStart = Math.max(0, matchStart - 48);
        const contextEnd = Math.min(item.text.length, matchStart + query.length + 48);
        results.push({
          messageKey: item.messageKey,
          cursor,
          timestamp: item.timestamp ? new Date(item.timestamp).getTime() : 0,
          snippet: `${contextStart > 0 ? '…' : ''}${item.text.slice(contextStart, contextEnd)}${contextEnd < item.text.length ? '…' : ''}`,
          matchStart: matchStart - contextStart + (contextStart > 0 ? 1 : 0),
          matchLength: query.length,
          matchedText: item.text.slice(matchStart, matchStart + query.length),
        });
      }
      globalTurnOffset += segment.index.turns.length;
    }
    return results;
  }

  async loadHistoryAt(cursor: string, pageSize: number): Promise<HistoryPage> {
    const state = this.searchCursors.get(cursor);
    if (!state) throw new Error('History search cursor expired');
    return this.materializePage(state, pageSize);
  }

  async loadOlderHistory(cursor: string, pageSize: number): Promise<HistoryPage> {
    const state = this.pageCursors.get(cursor);
    if (!state) throw new Error('History cursor expired');
    this.pageCursors.delete(cursor);
    const startTurn = Math.max(0, state.endTurn - pageSize);
    try {
      return await this.materializePage({ ...state, endTurn: startTurn }, pageSize);
    } catch (error) {
      // A failed page must not burn the cursor: restore it so the pager's
      // Retry replays this page instead of failing with "cursor expired".
      this.pageCursors.set(cursor, state);
      throw error;
    }
  }

  async exportFullHistory(conversation: Conversation, vaultPath: string | null): Promise<ChatMessage[]> {
    if (!vaultPath) return [...conversation.messages];
    this.ensureIndexDiagnostics(vaultPath);
    const state = getClaudeState(conversation.providerState);
    const currentSessionId = state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId;
    if (!currentSessionId) return [...conversation.messages];
    const sessionIds = [...(state.previousProviderSessionIds ?? []), currentSessionId];
    const messages: ChatMessage[] = [];
    for (const sessionId of sessionIds) {
      if (!sdkSessionExists(vaultPath, sessionId)) continue;
      const result = await buildTranscriptIndex(getSDKSessionPath(vaultPath, sessionId), {
        resumeAtMessageId: sessionId === currentSessionId
          ? (state.forkSource?.resumeAt ?? conversation.resumeAtMessageId)
          : undefined,
      });
      if (result.status !== 'complete') throw new Error(result.error);
      const native = await materializeTranscriptPage(result.index, 0, result.index.turns.length);
      messages.push(...await materializeSDKMessages(vaultPath, sessionId, native));
    }
    return dedupeMessages(messages).sort((a, b) => a.timestamp - b.timestamp);
  }

  releaseHistory(conversationId: string): void {
    const filePaths = this.protectedConversations.get(conversationId);
    for (const filePath of filePaths?.split('\n') ?? []) releaseTranscriptIndex(filePath);
    this.protectedConversations.delete(conversationId);
    this.conversationIndexes.delete(conversationId);
    clearTranscriptIndexCache();
    for (const [cursor, state] of this.searchCursors) {
      if (state.conversationId === conversationId) this.searchCursors.delete(cursor);
    }
    for (const [cursor, state] of this.pageCursors) {
      if (state.conversationId === conversationId) this.pageCursors.delete(cursor);
    }
  }

  private async materializePage(state: PageCursorState, pageSize: number): Promise<HistoryPage> {
    const selected = state.flattenedTurns.slice(state.endTurn, state.endTurn + pageSize);
    const messages: ChatMessage[] = [];
    for (const segment of state.segments) {
      const indexes = selected.filter(item => item.segment === segment).map(item => item.turnIndex);
      if (indexes.length === 0) continue;
      const native = await materializeTranscriptPage(segment.index, indexes[0], indexes.length);
      const associations = await materializeTranscriptToolAssociations(segment.index, native);
      messages.push(...await materializeSDKMessages(state.vaultPath, segment.sessionId, native, associations));
    }
    const hasMore = state.endTurn > 0;
    const cursor = hasMore ? `claude-history:${++this.cursorSequence}` : null;
    if (cursor) this.pageCursors.set(cursor, state);
    const current = state.segments[state.segments.length - 1];
    return {
      messages: dedupeMessages(messages).sort((a, b) => a.timestamp - b.timestamp),
      cursor,
      hasMore,
      snapshotOffset: current.index.snapshotSize,
    };
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
