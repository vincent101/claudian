import {
  type FullHistoryIterable,
  type FullHistoryIterationOptions,
  HistoryEntryTooLargeError,
  type HistoryIndexLease,
  type HistoryLoadBudget,
  type HistoryLoadProgress,
  type HistoryMessageDetailResult,
  type HistorySearchResult,
  HistorySourceUnavailableError,
  type HistoryWindowPage,
  type HistoryWindowRequest,
  type ProviderConversationHistoryService,
} from '../../../core/providers/types';
import type {
  ChatMessage,
  Conversation,
  ForkSource,
  SubagentInfo,
} from '../../../core/types';
import { compareChatDisplayOrder } from '../../../core/types';
import { ClaudeTranscriptDiagnosticLog } from '../transcript/ClaudeTranscriptDiagnosticLog';
import { type ClaudeProviderState, getClaudeState } from '../types/providerState';
import {
  deleteSDKSession,
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
  segmentOrdinal: number;
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

  mergePersistedSubagentState(
    providerState: Record<string, unknown> | undefined,
    subagent: SubagentInfo,
  ): Record<string, unknown> {
    const current = getClaudeState(providerState);
    return { ...current, subagentData: { ...(current.subagentData ?? {}), [subagent.id]: subagent } };
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const providerState: ClaudeProviderState = {
      ...getClaudeState(conversation.providerState),
    };

    return sanitizeProviderState(providerState);
  }

  async loadTitleMaterial(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<{ firstUserExcerpt: string; recentUserExcerpts: string[] } | null> {
    if (!vaultPath) return null;
    const lease = this.acquireHistoryIndex(conversation, vaultPath);
    try {
      await lease.ready;
      const budget: HistoryLoadBudget = {
        maxTurns: 8,
        maxSourceBytes: 256 * 1024,
        maxProjectedChars: 32 * 1024,
        timeSliceMs: 8,
      };
      const first = await lease.loadWindow({
        anchorTurn: 0,
        direction: 'newer',
        maxTurn: Math.min(1, lease.totalTurns),
        budget,
        projectionLevel: 'detail',
      });
      const recent = await lease.loadWindow({
        anchorTurn: lease.totalTurns,
        direction: 'older',
        budget,
        projectionLevel: 'detail',
      });
      const firstUser = first.messages.find(message => message.role === 'user');
      if (!firstUser) return null;
      const userTexts = recent.messages
        .filter(message => message.role === 'user')
        .map(message => message.displayContent ?? message.content);
      const isNoise = (text: string): boolean => !text
        || /^This session is being continued/i.test(text)
        || /^\[Request interrupted by user/i.test(text)
        || /^<command-/i.test(text)
        || /^<local-command-caveat>/i.test(text);
      const highInformation = userTexts
        .filter(text => !isNoise(text) && text.length >= 40)
        .slice(-5)
        .map(text => text.slice(0, 250));
      return {
        firstUserExcerpt: (firstUser.displayContent ?? firstUser.content).slice(0, 300),
        recentUserExcerpts: highInformation.length > 0
          ? highInformation
          : userTexts.slice(-3).map(text => text.slice(0, 100)),
      };
    } finally {
      lease.release();
    }
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
      loadMessageDetail: async (projectionKey, options) =>
        this.materializeMessageDetail(await fixed.ready, projectionKey, options),
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
    for (let segmentOrdinal = 0; segmentOrdinal < sessionIds.length; segmentOrdinal += 1) {
      const sessionId = sessionIds[segmentOrdinal];
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
      segments.push({ sessionId, segmentOrdinal, index: result.index });
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
    // Parallel canonical entry index per result: within one turn the corpus
    // entry position orders projections structurally (user before assistant),
    // so the sort below never falls back to projectionKey string comparison.
    const resultEntryIndexes: number[] = [];
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
          resultEntryIndexes.push(item.entryIndex);
          ordinals.set(item.projectionKey, matchOrdinal + 1);
          matchStart = lowerText.indexOf(needle, matchStart + needle.length);
        }
      }
      globalTurnOffset += segment.index.turns.length;
    }
    return results
      .map((result, index) => ({ result, index }))
      .sort((a, b) =>
        a.result.turnIndex - b.result.turnIndex
        || resultEntryIndexes[a.index] - resultEntryIndexes[b.index]
        || a.result.matchOrdinal - b.result.matchOrdinal
      )
      .map(entry => entry.result);
  }

  private async materializeMessageDetail(
    state: ConversationIndexState,
    projectionKey: string,
    options: { maxSourceBytes: number; signal?: AbortSignal },
  ): Promise<HistoryMessageDetailResult> {
    if (options.signal?.aborted) throw new Error('History detail load aborted');
    for (const segment of state.segments) {
      const descriptor = segment.index.projectionDescriptors?.find(item => item.projectionKey === projectionKey);
      if (!descriptor) continue;
      const entries = segment.index.entries.slice(descriptor.startEntry, descriptor.endEntry + 1);
      const wantedToolIds = new Set(entries.flatMap(entry => [...entry.toolUseIds, ...entry.toolResultIds]));
      const associationEntries = wantedToolIds.size > 0
        ? segment.index.entries.filter(entry =>
          entry.toolUseIds.some(id => wantedToolIds.has(id))
          || entry.toolResultIds.some(id => wantedToolIds.has(id)))
        : entries;
      const uniqueEntries = [...new Map([...entries, ...associationEntries].map(entry => [entry.offset, entry])).values()];
      const sourceBytes = uniqueEntries.reduce((sum, entry) => sum + entry.length, 0);
      if (sourceBytes > options.maxSourceBytes) return { status: 'too_large' };
      const native = await materializeTranscriptEntries(segment.index, entries);
      if (options.signal?.aborted) throw new Error('History detail load aborted');
      // Equal cardinality does not imply equal entries: a descriptor entry
      // without tool ids can mask an out-of-range tool_result of the same
      // count, so associations always come from the association set itself.
      const associations = await materializeTranscriptEntries(segment.index, associationEntries);
      const messages = await materializeSDKMessages(
        state.vaultPath,
        segment.sessionId,
        native,
        associations,
        segment.segmentOrdinal,
        descriptor.startEntry,
      );
      const message = messages.find(candidate => candidate.id === projectionKey);
      if (!message) return { status: 'not_found' };
      message.projectionLevel = 'detail';
      message.historyTurnOrdinal = state.segments
        .slice(0, state.segments.indexOf(segment))
        .reduce((sum, item) => sum + item.index.turns.length, 0) + descriptor.turnIndex;
      return { status: 'exact', message };
    }
    return { status: 'not_found' };
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
    // The single-turn page starts at the turn's segment-global startEntry;
    // without the base every turn would restart the entry counter and all
    // turns of a window would collide on the same displayOrder keys.
    return materializeSDKMessages(
      state.vaultPath, segment.sessionId, native, associations, segment.segmentOrdinal,
      segment.index.turns[turnIndex].startEntry,
    );
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
    // readIndexEntries preserves the input entry order, so native aligns with
    // the selected slots by cursor.
    const native = read.length > 0 ? await materializeTranscriptEntries(index, read) : [];
    const placeholderByMessageKey = new Map(
      skipped
        .map(entry => [entry.messageKey, buildOversizedEntryPlaceholder(entry)] as const)
        .filter((pair): pair is readonly [string, SDKNativeMessage] => pair[1] !== null),
    );
    // Interleave placeholders at their original entry slots so the summary
    // projection keeps the turn's canonical row order; a tail-appended
    // synthetic block would detach the projection from the transcript order
    // the search index and the detail materialization both use.
    const combined: SDKNativeMessage[] = [];
    let nativeCursor = 0;
    for (let i = 0; i < entries.length; i += 1) {
      if (selected[i]) {
        if (nativeCursor < native.length) {
          combined.push(native[nativeCursor]);
          nativeCursor += 1;
        }
      } else {
        const placeholder = placeholderByMessageKey.get(entries[i].messageKey);
        if (placeholder) combined.push(placeholder);
      }
    }
    if (skipped.length > 0) {
      combined.push(buildOversizedTurnMarker(turn.turnId, skipped, entries[entries.length - 1]?.timestamp));
    }
    const messages = await materializeSDKMessages(
      state.vaultPath, segment.sessionId, combined, combined, segment.segmentOrdinal,
      turn.startEntry,
    );
    // The tail-appended marker has no real entry slot; its natural index
    // (endEntry + 1) ties with the next turn's opener key, so a prepended
    // older window would merge it behind that opener. Park it on the last
    // real slot's second projection position: after every real projection of
    // the turn, before the next turn. Markers merged into a trailing assistant
    // projection have no standalone key and stay untouched.
    const marker = messages.find(message => message.id === `oversized-marker-${turn.turnId}`);
    if (marker) {
      marker.displayOrder = [segment.segmentOrdinal, turn.endEntry, 1];
    }
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
    const turns: Array<{
      index: number;
      messages: ChatMessage[];
      sourceBytes: number;
      projectedChars: number;
      shrunk: boolean;
    }> = [];
    // Preserve the planner's contiguous interval and canonical direction. If
    // projected chars force a second shrink, endpoints are removed by distance
    // from the anchor rather than always sacrificing the older side.
    for (let index = plan.start; index < plan.end; index += 1) {
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
      let chars = measureChatProjectionChars(produced);
      if (chars > request.budget.maxProjectedChars) {
        const capped = hardCapChatProjection(produced, request.budget.maxProjectedChars);
        produced = capped.messages;
        chars = capped.projectedChars;
        shrunk = true;
      }
      for (const message of produced) message.projectionLevel = shrunk ? 'summary' : 'detail';
      turns.push({ index, messages: produced, sourceBytes: readBytes, projectedChars: chars, shrunk });
    }
    const anchorIndex = request.direction === 'older'
      ? Math.max(plan.start, plan.end - 1)
      : request.direction === 'newer'
        ? plan.start
        : Math.max(plan.start, Math.min(request.anchorTurn, plan.end - 1));
    let sourceBytes = turns.reduce((sum, turn) => sum + turn.sourceBytes, 0);
    let projectedChars = turns.reduce((sum, turn) => sum + turn.projectedChars, 0);
    while (turns.length > 1 && (
      sourceBytes > request.budget.maxSourceBytes
      || projectedChars > request.budget.maxProjectedChars
    )) {
      const firstDistance = Math.abs(turns[0].index - anchorIndex);
      const lastDistance = Math.abs(turns[turns.length - 1].index - anchorIndex);
      const removed = firstDistance >= lastDistance ? turns.shift()! : turns.pop()!;
      sourceBytes -= removed.sourceBytes;
      projectedChars -= removed.projectedChars;
    }
    const actualStart = turns[0]?.index ?? plan.end;
    const actualEnd = turns[turns.length - 1]?.index + 1 || plan.end;
    const messages = turns.flatMap(turn => turn.messages);
    const oversizedTurnCount = turns.filter(turn => turn.shrunk).length;
    const current = state.segments[state.segments.length - 1];
    this.windowDiagnostics?.record({
      phase: 'window_complete',
      turnCount: turns.length,
      sourceBytes,
      projectedChars,
      oversizedTurns: oversizedTurnCount,
      elapsedMs: performance.now() - startedAt,
    });
    return {
      messages: dedupeMessages(messages).sort(compareChatDisplayOrder),
      range: { start: actualStart, end: actualEnd },
      snapshotOffset: current.index.snapshotSize,
      sourceBytes,
      projectedChars,
      oversizedTurnCount,
      pageKey: `w:${actualStart}:${actualEnd}`,
      hasMoreBefore: actualStart > 0,
      hasMoreAfter: actualEnd < total,
    };
  }

  iterateFullHistory(
    conversation: Conversation,
    vaultPath: string | null,
    options: FullHistoryIterationOptions,
  ): FullHistoryIterable {
    if (!vaultPath) throw new HistorySourceUnavailableError('vault_unavailable');
    const state = getClaudeState(conversation.providerState);
    if (!(state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId)) {
      throw new HistorySourceUnavailableError('session_unavailable');
    }
    const lease = this.acquireHistoryIndex(conversation, vaultPath);
    const getShared = () => this.sharedIndexes.get(conversation.id);
    const getTurnBytes = (fixed: ConversationIndexState) => this.turnSourceBytes(fixed);
    const materialize = (fixed: ConversationIndexState, start: number, end: number) =>
      this.materializeDetailChunk(fixed, start, end, options.maxProjectedCharsPerChunk);
    return {
      async *[Symbol.asyncIterator]() {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          lease.release();
        };
        const abort = () => release();
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
          await lease.ready;
          const shared = getShared();
          if (!shared) throw new HistorySourceUnavailableError('transcript_unavailable');
          const fixed = await shared.ready;
          let cursor = 0;
          while (cursor < lease.totalTurns) {
            if (options.signal?.aborted) throw options.signal.reason ?? new Error('History iteration aborted');
            const plan = planHistoryWindow(getTurnBytes(fixed), {
              anchorTurn: cursor,
              direction: 'newer',
              budget: {
                maxTurns: options.maxTurnsPerChunk,
                maxSourceBytes: options.maxSourceBytesPerChunk,
                maxProjectedChars: options.maxProjectedCharsPerChunk,
                timeSliceMs: 0,
              },
            });
            if (plan.oversizedAnchor) {
              throw new HistoryEntryTooLargeError(cursor, plan.plannedSourceBytes, null);
            }
            const page = await materialize(fixed, plan.start, plan.end);
            if (page.projectedChars > options.maxProjectedCharsPerChunk) {
              throw new HistoryEntryTooLargeError(cursor, page.sourceBytes, page.projectedChars);
            }
            cursor = page.range.end;
            yield {
              messages: page.messages,
              range: page.range,
              sourceBytes: page.sourceBytes,
              done: cursor === lease.totalTurns,
            };
          }
        } catch (error) {
          if (error instanceof HistorySourceUnavailableError || error instanceof HistoryEntryTooLargeError) throw error;
          // An abort is a consumer-side cancellation, not a source failure:
          // rethrow the abort reason as-is so callers can tell a cancelled
          // iteration apart from a genuinely missing transcript.
          if (options.signal?.aborted) throw error;
          throw new HistorySourceUnavailableError('transcript_unavailable');
        } finally {
          options.signal?.removeEventListener('abort', abort);
          release();
        }
      },
    };
  }

  private async materializeDetailChunk(
    state: ConversationIndexState,
    start: number,
    plannedEnd: number,
    maxProjectedChars: number,
  ): Promise<{ messages: ChatMessage[]; range: { start: number; end: number }; sourceBytes: number; projectedChars: number }> {
    const messages: ChatMessage[] = [];
    let sourceBytes = 0;
    let projectedChars = 0;
    let end = start;
    for (let index = start; index < plannedEnd; index += 1) {
      const item = state.flattenedTurns[index];
      const produced = await this.materializeTurn(state, item.segment, item.turnIndex);
      const chars = measureChatProjectionChars(produced);
      const bytes = item.segment.index.turns[item.turnIndex].sourceBytes ?? 0;
      if (chars > maxProjectedChars) {
        throw new HistoryEntryTooLargeError(index, bytes, chars);
      }
      if (index > start && projectedChars + chars > maxProjectedChars) break;
      messages.push(...produced);
      projectedChars += chars;
      sourceBytes += bytes;
      end = index + 1;
    }
    return {
      messages: dedupeMessages(messages).sort(compareChatDisplayOrder),
      range: { start, end },
      sourceBytes,
      projectedChars,
    };
  }

  /** @deprecated Use iterateFullHistory with a bounded consumer. */
  async exportFullHistory(conversation: Conversation, vaultPath: string | null): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for await (const chunk of this.iterateFullHistory(conversation, vaultPath, {
      maxTurnsPerChunk: 100,
      maxSourceBytesPerChunk: 8 * 1024 * 1024,
      maxProjectedCharsPerChunk: 2 * 1024 * 1024,
      projectionLevel: 'detail',
    })) messages.push(...chunk.messages);
    return messages;
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
