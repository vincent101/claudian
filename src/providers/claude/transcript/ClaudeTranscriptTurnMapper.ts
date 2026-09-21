import type {
  AutoTurnSource,
} from '../../../core/runtime/types';
import type { ChatTurnMetadata } from '../../../core/runtime/types';
import type { StreamChunk } from '../../../core/types';
import {
  extractExternalDisplayContent,
  extractUserText,
} from '../history/externalUserMessage';
import type { SDKNativeMessage } from '../history/sdkHistoryTypes';
import { createRuntimeTurn } from '../runtime/types';
import { transformSDKMessage } from '../stream/transformClaudeMessage';

/**
 * Transcript facts (turn identity, batch 1 §3.1): the mapper reports what the
 * transcript says, nothing more. Whether an observed_start opens a promoted
 * auto turn, an embedded bubble, or a host mirror is a reconciliation verdict,
 * not a mapper decision.
 */
export interface TranscriptIdentity {
  /** Transcript user row UUID (origin.msg_id fallback when the row has no UUID). */
  canonicalTurnId: string;
  transcriptUserId: string;
  generation: number;
}

export type TranscriptTerminalKind =
  | 'result'
  | 'end_turn_quiet'
  | 'next_user'
  | 'next_assistant';

export type TranscriptTurnFact =
  | {
      type: 'observed_start';
      identity: TranscriptIdentity;
      /** Present only for rows carrying an external origin. */
      source?: AutoTurnSource;
      showUser: boolean;
      displayContent?: string;
      lineOffset?: number;
      replay: boolean;
    }
  | {
      type: 'observed_chunk';
      canonicalTurnId: string;
      identity: string;
      generation: number;
      chunk: StreamChunk;
      lineOffset?: number;
      replay: boolean;
    }
  | {
      type: 'observed_terminal';
      identity: TranscriptIdentity;
      terminalKind: TranscriptTerminalKind;
      lineOffset?: number;
      metadata: ChatTurnMetadata;
      replay: boolean;
    }
  | {
      type: 'observed_interrupted';
      identity: TranscriptIdentity;
      reason: string;
      /** Generation the cancelled/interrupted projection reports (legacy +1 semantics). */
      nextGeneration: number;
      lineOffset?: number;
      replay: boolean;
    };

export interface TranscriptMapContext {
  hostUserTurnActive: boolean;
  lineOffset?: number;
}

export interface TranscriptTurnStart {
  turnId: string;
  source: AutoTurnSource;
  displayContent?: string;
  showUser: boolean;
}

function isStopHookBlockFeedback(message: SDKNativeMessage): boolean {
  if (message.type !== 'user' || message.isMeta !== true || message.userType !== 'external') return false;
  const text = extractUserText(message);
  return text?.startsWith('Stop hook feedback:') === true;
}

export { extractExternalDisplayContent } from '../history/externalUserMessage';

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

/**
 * A host-dispatched user row: queryable, not a protocol mechanism row, not a
 * tool-result continuation of an earlier tool_use, and carrying a UUID the
 * reconciliation coordinator can match against a dispatched binding.
 */
function isQueryableHostUserRow(message: SDKNativeMessage): message is SDKNativeMessage & { uuid: string } {
  if (message.type !== 'user' || message.isReplay === true || message.isSidechain === true) return false;
  if (message.isMeta === true) return false;
  if (message.shouldQuery === false) return false;
  if (message.origin?.kind) return false;
  if (!message.uuid) return false;
  const content = message.message?.content;
  if (Array.isArray(content) && content.length > 0 && content.every(block => block.type === 'tool_result')) return false;
  return true;
}

interface ActiveTurn {
  id: string;
  generation: number;
  source: AutoTurnSource;
  displayContent?: string;
  seen: Set<string>;
  runtimeTurn: ReturnType<typeof createRuntimeTurn>;
  assistantMessageId?: string;
  currentAssistantMessageId?: string;
  assistantInstanceInterrupted: boolean;
  terminalCandidate: boolean;
  terminalOffset?: number;
}

export class ClaudeTranscriptTurnMapper {
  private active: ActiveTurn | null = null;

  constructor(private generation = 0) {}

  reset(generation = this.generation + 1): void {
    this.generation = generation;
    this.active = null;
  }

  mapLine(line: string, replay = false, context: TranscriptMapContext = { hostUserTurnActive: false }): TranscriptTurnFact[] {
    let message: SDKNativeMessage;
    try {
      message = JSON.parse(line) as SDKNativeMessage;
    } catch {
      return [];
    }
    return this.map(message, replay, context);
  }

  map(message: SDKNativeMessage, replay = false, context: TranscriptMapContext = { hostUserTurnActive: false }): TranscriptTurnFact[] {
    if (message.isSidechain === true) return [];
    const facts: TranscriptTurnFact[] = [];
    const start = classifyLeaselessTurnStart(message);
    if (start) {
      if (this.active) facts.push(...this.closeBeforeNextUser(replay));
      facts.push({
        type: 'observed_start',
        identity: { canonicalTurnId: start.turnId, transcriptUserId: start.turnId, generation: this.generation },
        source: start.source,
        showUser: start.showUser,
        ...(start.showUser && start.displayContent ? { displayContent: start.displayContent } : {}),
        lineOffset: context.lineOffset,
        replay,
      });
      if (context.hostUserTurnActive && start.showUser) {
        return facts;
      }
      this.active = {
        id: start.turnId,
        generation: this.generation,
        source: start.source,
        displayContent: start.displayContent,
        seen: new Set(),
        runtimeTurn: createRuntimeTurn({ id: start.turnId, kind: 'auto', phase: 'collecting' }),
        assistantInstanceInterrupted: false,
        terminalCandidate: false,
      };
      return facts;
    }
    if (isQueryableHostUserRow(message)) {
      // Host rows never open an observer turn (the host runtime owns their
      // lifecycle); the fact exists so reconciliation can match the UUID.
      facts.push({
        type: 'observed_start',
        identity: { canonicalTurnId: message.uuid, transcriptUserId: message.uuid, generation: this.generation },
        showUser: false,
        lineOffset: context.lineOffset,
        replay,
      });
    }

    const active = this.active;
    if (!active) return facts;

    const stopHookBlockFeedback = isStopHookBlockFeedback(message);
    const assistantId = message.type === 'assistant' ? message.message?.id ?? message.uuid : undefined;
    if (active.terminalCandidate && !stopHookBlockFeedback && (
      (assistantId !== undefined && (
        assistantId !== active.currentAssistantMessageId || active.assistantInstanceInterrupted
      ))
      || (message.type === 'system' && message.subtype === 'stop_hook_summary')
    )) {
      facts.push(...this.finishActive(replay, 'next_assistant'));
      return facts;
    }

    const lineId = message.uuid ?? `${message.message?.id ?? message.type}:${message.parentUuid ?? ''}`;
    if (message.type === 'assistant') {
      active.currentAssistantMessageId = assistantId;
      active.assistantInstanceInterrupted = false;
      active.assistantMessageId = assistantId ?? active.assistantMessageId;
    }
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
      facts.push({ type: 'observed_chunk', canonicalTurnId: active.id, identity, generation: active.generation, chunk, lineOffset: context.lineOffset, replay });
    }

    if (message.type === 'assistant' && message.message?.stop_reason === 'end_turn') {
      active.terminalCandidate = true;
      active.terminalOffset = context.lineOffset;
    } else if (message.type === 'result') {
      active.terminalOffset = context.lineOffset;
      facts.push(...this.finishActive(replay, 'result'));
    } else if (stopHookBlockFeedback) {
      active.terminalCandidate = false;
      active.assistantInstanceInterrupted = false;
    } else if (message.type !== 'assistant') {
      active.assistantInstanceInterrupted = true;
    }
    return facts;
  }

  settleTerminalCandidate(replay = false): TranscriptTurnFact[] {
    return this.active?.terminalCandidate ? this.finishActive(replay, 'end_turn_quiet') : [];
  }

  hasOpenTurn(): boolean {
    return this.active !== null;
  }

  hasTerminalCandidate(): boolean {
    return this.active?.terminalCandidate === true;
  }

  private closeBeforeNextUser(replay: boolean): TranscriptTurnFact[] {
    if (!this.active) return [];
    if (this.active.terminalCandidate) return this.finishActive(replay, 'next_user');
    const active = this.active;
    this.active = null;
    return [{
      type: 'observed_interrupted',
      identity: { canonicalTurnId: active.id, transcriptUserId: active.id, generation: active.generation },
      reason: 'protocol_gap',
      nextGeneration: active.generation + 1,
      replay,
    }];
  }

  private finishActive(replay: boolean, terminalKind: TranscriptTerminalKind): TranscriptTurnFact[] {
    const active = this.active;
    if (!active) return [];
    this.active = null;
    return [{
      type: 'observed_terminal',
      identity: { canonicalTurnId: active.id, transcriptUserId: active.id, generation: active.generation },
      terminalKind,
      lineOffset: active.terminalOffset,
      metadata: { assistantMessageId: active.assistantMessageId },
      replay,
    }];
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
