import type {
  AutoTurnChunkEvent,
  AutoTurnFinishedEvent,
  AutoTurnSource,
  AutoTurnStartedEvent,
} from '../../../core/runtime/types';
import type { StreamChunk } from '../../../core/types';
import type { SDKNativeMessage } from '../history/sdkHistoryTypes';
import { createRuntimeTurn } from '../runtime/types';
import { transformSDKMessage } from '../stream/transformClaudeMessage';

export type TranscriptTurnEvent =
  | { type: 'started'; event: AutoTurnStartedEvent }
  | { type: 'embedded'; event: AutoTurnStartedEvent }
  | { type: 'chunk'; event: AutoTurnChunkEvent; identity: string }
  | { type: 'finished'; event: AutoTurnFinishedEvent };

export interface TranscriptMapContext {
  hostUserTurnActive: boolean;
}

export interface TranscriptTurnStart {
  turnId: string;
  source: AutoTurnSource;
  displayContent?: string;
  showUser: boolean;
}

function extractUserText(message: SDKNativeMessage): string | undefined {
  const content = message.message?.content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim();
  return text || undefined;
}

function unwrap(candidate: string, tag: 'cross-session-message' | 'agent-message'): string | null {
  const start = candidate.indexOf(`<${tag}`);
  if (start < 0) return candidate;
  const openEnd = candidate.indexOf('>', start + tag.length + 1);
  const close = openEnd < 0 ? -1 : candidate.indexOf(`</${tag}>`, openEnd + 1);
  return openEnd < 0 || close < 0 ? null : candidate.slice(openEnd + 1, close);
}

export function extractExternalDisplayContent(message: SDKNativeMessage): string | undefined {
  let candidate = typeof message.origin?.body === 'string'
    && message.origin.body.trim()
    ? message.origin.body
    : extractUserText(message);
  if (!candidate) return undefined;
  candidate = candidate.trim();
  const prologue = 'Another Claude session sent a message:';
  if (candidate.startsWith(prologue)) candidate = candidate.slice(prologue.length).trim();
  for (const tag of ['cross-session-message', 'agent-message'] as const) {
    const value = unwrap(candidate, tag);
    if (value === null) return undefined;
    candidate = value.trim();
  }
  const lines = candidate.split('\n');
  let first = 0;
  while (first < lines.length && (/^\[to\](?:\s|$)/.test(lines[first]) || /^\[from\](?:\s|$)/.test(lines[first]))) first += 1;
  if (first < lines.length && /^\[msg\](?:\s|$)/.test(lines[first])) lines[first] = lines[first].replace(/^\[msg\]\s*/, '');
  return lines.slice(first).join('\n').trim() || undefined;
}

export function classifyLeaselessTurnStart(message: SDKNativeMessage): TranscriptTurnStart | null {
  if (message.type !== 'user' || message.isReplay === true || message.isSidechain === true || message.shouldQuery === false) return null;
  const kind = message.origin?.kind;
  if (!kind) return null;
  const turnId = message.uuid ?? message.origin?.msg_id;
  if (!turnId) return null;
  if (kind === 'peer') return { turnId, source: { kind: 'peer', ...(message.origin?.name ? { label: message.origin.name } : {}) }, displayContent: extractExternalDisplayContent(message), showUser: true };
  if (kind === 'channel') return { turnId, source: { kind: 'channel', ...(message.origin?.server ? { label: message.origin.server } : {}) }, displayContent: extractExternalDisplayContent(message), showUser: true };
  if (kind === 'coordinator') return { turnId, source: { kind: 'coordinator' }, displayContent: extractExternalDisplayContent(message), showUser: true };
  if (kind === 'task-notification') return { turnId, source: { kind: 'notification-continuation' }, showUser: false };
  return null;
}

interface ActiveTurn {
  id: string;
  generation: number;
  source: AutoTurnSource;
  displayContent?: string;
  seen: Set<string>;
  runtimeTurn: ReturnType<typeof createRuntimeTurn>;
  assistantMessageId?: string;
}

export class ClaudeTranscriptTurnMapper {
  private active: ActiveTurn | null = null;

  constructor(private generation = 0) {}

  reset(generation = this.generation + 1): void {
    this.generation = generation;
    this.active = null;
  }

  mapLine(line: string, replay = false, context: TranscriptMapContext = { hostUserTurnActive: false }): TranscriptTurnEvent[] {
    let message: SDKNativeMessage;
    try {
      message = JSON.parse(line) as SDKNativeMessage;
    } catch {
      return [];
    }
    return this.map(message, replay, context);
  }

  map(message: SDKNativeMessage, replay = false, context: TranscriptMapContext = { hostUserTurnActive: false }): TranscriptTurnEvent[] {
    if (message.isSidechain === true) return [];
    const start = classifyLeaselessTurnStart(message);
    if (start) {
      const startedEvent: AutoTurnStartedEvent = {
        turnId: start.turnId,
        generation: this.generation,
        source: start.source,
        ...(start.showUser && start.displayContent ? { displayContent: start.displayContent } : {}),
        transcriptUserId: start.turnId,
        replay,
      };
      if (context.hostUserTurnActive && start.showUser) {
        return [{ type: 'embedded', event: startedEvent }];
      }
      this.active = {
        id: start.turnId,
        generation: this.generation,
        source: start.source,
        displayContent: start.displayContent,
        seen: new Set(),
        runtimeTurn: createRuntimeTurn({ id: start.turnId, kind: 'auto', phase: 'collecting' }),
      };
      return [{ type: 'started', event: startedEvent }];
    }
    const active = this.active;
    if (!active) return [];

    const events: TranscriptTurnEvent[] = [];
    const lineId = message.uuid ?? `${message.message?.id ?? message.type}:${message.parentUuid ?? ''}`;
    if (message.type === 'assistant') active.assistantMessageId = message.message?.id ?? message.uuid ?? active.assistantMessageId;
    const sdkMessage = message as unknown as Parameters<typeof transformSDKMessage>[0];
    let blockIndex = 0;
    for (const chunk of transformSDKMessage(sdkMessage, {
      streamState: active.runtimeTurn.streamState,
      usageState: active.runtimeTurn.usageState,
    })) {
      if (!isProjectableChunk(chunk)) continue;
      const identity = chunkIdentity(message, chunk, lineId, blockIndex++);
      if (active.seen.has(identity)) continue;
      active.seen.add(identity);
      events.push({ type: 'chunk', identity, event: {
        turnId: active.id,
        generation: active.generation,
        chunk,
        transcriptIdentity: identity,
        replay,
      } });
    }

    const complete = (message.type === 'assistant' && message.message?.stop_reason === 'end_turn')
      || message.type === 'result';
    if (complete) {
      events.push({ type: 'finished', event: {
        turnId: active.id,
        generation: active.generation,
        metadata: { assistantMessageId: active.assistantMessageId },
        replay,
      } });
      this.active = null;
    }
    return events;
  }

  hasOpenTurn(): boolean {
    return this.active !== null;
  }
}

function isProjectableChunk(chunk: StreamChunk | { type: string }): chunk is StreamChunk {
  return chunk.type === 'text' || chunk.type === 'thinking' || chunk.type === 'tool_use'
    || chunk.type === 'tool_result' || chunk.type === 'usage';
}

function chunkIdentity(message: SDKNativeMessage, chunk: StreamChunk, lineId: string, index: number): string {
  if (chunk.type === 'tool_use' || chunk.type === 'tool_result') return `tool:${chunk.id}:${chunk.type}`;
  if (message.uuid) return `${message.uuid}:${chunk.type}:${index}`;
  return `${lineId}:${chunk.type}:${index}`;
}
