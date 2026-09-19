import type { ChatMessage, ToolCallInfo } from '../../../core/types';
import type { TranscriptIndexEntry } from './ClaudeTranscriptHistoryIndex';
import type { SDKNativeMessage } from './sdkHistoryTypes';

/**
 * Summary-projection caps for oversized turns. Reading and projecting stay
 * bounded even when a single turn dwarfs the whole window budget; omitted
 * content is always marked, never silently dropped.
 */
export const HISTORY_SUMMARY_LIMITS = {
  /** Per-entry read cap while materializing an oversized turn at summary level. */
  entryReadBytes: 512 * 1024,
  /** Head+tail excerpt budget for text blocks (split half/half). */
  textExcerptChars: 2048,
  /** Head excerpt cap for tool results. */
  toolResultChars: 256,
  /** Per-string cap inside tool inputs. */
  toolInputChars: 256,
  /** Tool input array cap; longer arrays are cut with an explicit marker. */
  toolInputArrayItems: 32,
} as const;

export function excerptHeadTail(text: string, limit = HISTORY_SUMMARY_LIMITS.textExcerptChars): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n\n[… ${omitted} characters omitted …]\n\n${text.slice(text.length - half)}`;
}

function excerptHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… ${text.length - limit} characters omitted …]`;
}

function shrinkJsonish(value: unknown, limit: number, depth: number): unknown {
  if (typeof value === 'string') return value.length > limit ? excerptHead(value, limit) : value;
  if (Array.isArray(value)) {
    const capped = value.slice(0, HISTORY_SUMMARY_LIMITS.toolInputArrayItems)
      .map(item => shrinkJsonish(item, limit, depth + 1));
    if (value.length > HISTORY_SUMMARY_LIMITS.toolInputArrayItems) {
      capped.push(`[… ${value.length - HISTORY_SUMMARY_LIMITS.toolInputArrayItems} more items omitted …]`);
    }
    return capped;
  }
  if (value && typeof value === 'object') {
    if (depth >= 4) return '[object]';
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = shrinkJsonish(entry, limit, depth + 1);
    return out;
  }
  return value;
}

function summarizeToolCall(toolCall: ToolCallInfo): void {
  if (typeof toolCall.result === 'string' && toolCall.result.length > HISTORY_SUMMARY_LIMITS.toolResultChars) {
    toolCall.result = excerptHead(toolCall.result, HISTORY_SUMMARY_LIMITS.toolResultChars);
  }
  toolCall.input = shrinkJsonish(toolCall.input, HISTORY_SUMMARY_LIMITS.toolInputChars, 0) as Record<string, unknown>;
  // Diff payloads and nested subagent tool calls are detail-level content.
  toolCall.diffData = undefined;
  if (toolCall.subagent) {
    if (typeof toolCall.subagent.result === 'string'
      && toolCall.subagent.result.length > HISTORY_SUMMARY_LIMITS.toolResultChars) {
      toolCall.subagent.result = excerptHead(toolCall.subagent.result, HISTORY_SUMMARY_LIMITS.toolResultChars);
    }
    // SubagentInfo.toolCalls is required; empty marks "detail omitted".
    toolCall.subagent.toolCalls = [];
  }
}

/** Shrinks a materialized message in place to the summary projection. */
export function summarizeChatMessage(message: ChatMessage): void {
  message.content = excerptHeadTail(message.content);
  if (message.displayContent) message.displayContent = excerptHeadTail(message.displayContent);
  // Base64 attachments never enter the summary projection.
  message.images = undefined;
  if (message.contentBlocks) {
    message.contentBlocks = message.contentBlocks
      .filter(block => block.type !== 'thinking')
      .map(block => block.type === 'text' ? { ...block, content: excerptHeadTail(block.content) } : block);
  }
  for (const toolCall of message.toolCalls ?? []) summarizeToolCall(toolCall);
}

export function summarizeChatMessages(messages: ChatMessage[]): void {
  for (const message of messages) summarizeChatMessage(message);
}

export interface HardCapResult {
  messages: ChatMessage[];
  /** Real post-compression measurement — never a Math.min of two numbers. */
  projectedChars: number;
  truncated: boolean;
}

const HARD_CAP_OMISSION_MARKER = '[… truncated …]';

/**
 * Budget-aware single-string truncation: keeps head+tail excerpts around an
 * explicit omission marker. When the budget cannot hold the full marker, the
 * marker itself is cut to the remaining length; a zero budget yields ''.
 */
function capTextToBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  if (budget <= HARD_CAP_OMISSION_MARKER.length) {
    return HARD_CAP_OMISSION_MARKER.slice(0, budget);
  }
  const body = budget - HARD_CAP_OMISSION_MARKER.length;
  const head = Math.ceil(body / 2);
  const tail = body - head;
  return `${text.slice(0, head)}${HARD_CAP_OMISSION_MARKER}${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

/** Strips every surface measureChatProjectionChars counts, keeping the shell. */
function emptyMeasurableSurfaces(message: ChatMessage): void {
  message.content = '';
  message.displayContent = undefined;
  for (const block of message.contentBlocks ?? []) {
    if (block.type === 'text' || block.type === 'thinking') block.content = '';
  }
  for (const toolCall of message.toolCalls ?? []) {
    toolCall.input = {};
    toolCall.result = undefined;
    if (toolCall.subagent) {
      toolCall.subagent.toolCalls = [];
      toolCall.subagent.result = undefined;
    }
  }
}

/**
 * Shrinks one message in place to at most `budget` projected chars.
 * Deterministic surface order: tool payloads (input/result/nested subagent
 * detail — the summary layer's non-essential fields) go first, then text
 * blocks and displayContent, and message.content is kept last as the single
 * carrier with a head/tail excerpt plus an omission marker.
 */
function hardCapMessage(message: ChatMessage, budget: number): void {
  if (measureChatProjectionChars([message]) <= budget) return;

  for (const toolCall of message.toolCalls ?? []) {
    toolCall.input = {};
    toolCall.result = undefined;
    toolCall.diffData = undefined;
    if (toolCall.subagent) {
      toolCall.subagent.toolCalls = [];
      toolCall.subagent.result = undefined;
    }
  }
  if (measureChatProjectionChars([message]) <= budget) return;

  if (message.contentBlocks) {
    for (const block of message.contentBlocks) {
      if (block.type === 'text' || block.type === 'thinking') block.content = '';
    }
  }
  message.displayContent = undefined;
  message.content = capTextToBudget(message.content, budget);
}

/**
 * Second-pass hard cap for a single produced turn whose summary projection
 * still exceeds `maxProjectedChars` (anchor turns are exempt from cumulative
 * window admission, never from this per-turn ceiling). Message identity —
 * id, role, timestamp, provider-native message ids — and array order always
 * survive; only projection payloads shrink. Postcondition:
 * measureChatProjectionChars(result.messages) <= maxProjectedChars.
 */
export function hardCapChatProjection(
  messages: ChatMessage[],
  maxProjectedChars: number,
): HardCapResult {
  if (!Number.isFinite(maxProjectedChars) || maxProjectedChars < 0) {
    throw new RangeError(`maxProjectedChars must be a non-negative finite number, got ${maxProjectedChars}`);
  }
  summarizeChatMessages(messages);
  let total = measureChatProjectionChars(messages);
  if (total <= maxProjectedChars) {
    return { messages, projectedChars: total, truncated: false };
  }

  // Equal-share budget across message shells: Σ min(m_i, share_i) ≤ Σ share_i
  // = budget, so no message can push the turn over the ceiling.
  const share = Math.floor(maxProjectedChars / messages.length);
  const leftover = maxProjectedChars - share * messages.length;
  messages.forEach((message, index) => {
    hardCapMessage(message, share + (index < leftover ? 1 : 0));
  });

  total = measureChatProjectionChars(messages);
  if (total > maxProjectedChars) {
    // Defensive postcondition guarantee: a surface the estimator counts but
    // the capper missed must not leak over the hard ceiling.
    for (const message of messages) emptyMeasurableSurfaces(message);
    total = measureChatProjectionChars(messages);
  }
  return { messages, projectedChars: total, truncated: true };
}

/**
 * Deterministic projection-size estimate used for budget enforcement. String
 * payloads count exactly; non-string input values are estimated at a fixed
 * cost so structured inputs cannot bypass the char budget.
 */
export function measureChatProjectionChars(messages: ReadonlyArray<ChatMessage>): number {
  let total = 0;
  for (const message of messages) {
    total += message.content.length + (message.displayContent?.length ?? 0);
    for (const block of message.contentBlocks ?? []) {
      if (block.type === 'text' || block.type === 'thinking') total += block.content.length;
    }
    for (const toolCall of message.toolCalls ?? []) {
      total += toolCall.result?.length ?? 0;
      for (const value of Object.values(toolCall.input ?? {})) {
        total += typeof value === 'string' ? value.length : 64;
      }
      if (toolCall.subagent?.toolCalls) total += toolCall.subagent.toolCalls.length * 256;
    }
  }
  return total;
}

const OMITTED_ENTRY_BYTES_TEXT = (bytes: number): string => `[… transcript entry of ${bytes} bytes omitted …]`;

/**
 * Placeholder for an oversized entry skipped during summary materialization.
 * Tool-result entries keep a synthetic result so their paired tool calls show
 * a completed status with an honest omission marker instead of "running".
 * Returns null for entries with no projectable summary (tool_use/text/meta);
 * those are covered by the aggregate turn marker.
 */
export function buildOversizedEntryPlaceholder(entry: TranscriptIndexEntry): SDKNativeMessage | null {
  if (entry.toolResultIds.length === 0) return null;
  return {
    type: 'user',
    uuid: `oversized-${entry.messageKey}`,
    parentUuid: entry.parentUuid ?? null,
    timestamp: entry.timestamp,
    // Mirrors a real tool-result row: sourceToolUseID marks it system-injected
    // so it feeds collectToolResults without breaking assistant grouping.
    sourceToolUseID: entry.toolResultIds[0],
    message: {
      content: entry.toolResultIds.map(toolUseId => ({
        type: 'tool_result' as const,
        tool_use_id: toolUseId,
        content: OMITTED_ENTRY_BYTES_TEXT(entry.length),
      })),
    },
  };
}

/** Aggregate end-of-turn marker listing everything the summary left unread. */
export function buildOversizedTurnMarker(
  turnId: string,
  skippedEntries: ReadonlyArray<TranscriptIndexEntry>,
  fallbackTimestamp?: string,
): SDKNativeMessage {
  const omittedBytes = skippedEntries.reduce((sum, entry) => sum + entry.length, 0);
  return {
    type: 'assistant',
    uuid: `oversized-marker-${turnId}`,
    timestamp: fallbackTimestamp,
    message: {
      content: [{
        type: 'text',
        text: `[… ${skippedEntries.length} transcript entries (${omittedBytes} bytes) omitted from this oversized turn …]`,
      }],
    },
  };
}

/**
 * Placeholder rows for an opaque oversized transcript entry (indexed but
 * never read back). Always yields a visible omission marker; when the index
 * extracted reliable tool-result ids, additionally yields the synthetic
 * tool_result row so paired tool calls show completed instead of hanging in
 * a running state. Unknown associations are never faked.
 */
export function buildOpaqueOversizedPlaceholders(entry: TranscriptIndexEntry): SDKNativeMessage[] {
  const rows: SDKNativeMessage[] = [];
  const toolResultRow = buildOversizedEntryPlaceholder(entry);
  if (toolResultRow) rows.push(toolResultRow);
  rows.push({
    type: 'assistant',
    uuid: `oversized-opaque-${entry.messageKey}`,
    parentUuid: entry.parentUuid ?? null,
    timestamp: entry.timestamp,
    message: {
      content: [{
        type: 'text',
        text: OMITTED_ENTRY_BYTES_TEXT(entry.length),
      }],
    },
  });
  return rows;
}
