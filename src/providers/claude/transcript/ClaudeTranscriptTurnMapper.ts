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
    }
  | {
      /**
       * Terminal evidence for the HOST user turn (P0-1 result-late watchdog).
       * Host rows never open a mapper turn, so the fact carries no identity:
       * the observer attaches the live hostUserTurnId when notifying the
       * runtime. Evidence = end_turn candidate confirmed by stop_hook_summary
       * (or quiet-settled when no Stop hook writes a summary row), OR a
       * manual compact_boundary row (compact turns never write end_turn —
       * emitted immediately, no candidate state).
       */
      type: 'observed_host_terminal';
      lineOffset?: number;
      replay: boolean;
      /** Present only for compact_boundary evidence (stop_hook facts stay unset). */
      terminalSource?: 'compact';
      /** Boundary row's creation timestamp (ISO 8601) as epoch ms — the observer attributes by timestamp, not offset. */
      rowTimestamp?: number;
      /** CLI version carried by the boundary row (retirement-evidence for the stopTask probe). */
      cliVersion?: string;
    }
  | {
      /**
       * Terminal-evidence retraction (2026-11-05 fix 1): a strong continuation
       * proof (Stop-hook block feedback, or a NEW main assistant request
       * distinguishable from the terminal one) arrived after the terminal
       * fact was emitted. Ordinary trailing rows (text tails, usage,
       * notifications, local-command rows) never retract.
       */
      type: 'observed_host_terminal_retracted';
      reason: 'stop_hook_block' | 'new_assistant_request';
      /** Distinguisher of the continuing assistant request (message id / uuid). */
      assistantInstanceId?: string;
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
  /** end_turn seen for the host user turn, awaiting stop_hook_summary (or quiet settle). */
  private hostTerminalCandidate = false;
  /** Offset of the row that armed the host candidate: the fact inherits it so
   * the observer can attribute the terminal to the turn owning that row. */
  private hostTerminalCandidateOffset?: number;
  /** A host terminal fact was EMITTED for the current host turn: from here,
   * only strong continuation proof (block feedback / a new main assistant
   * request distinguishable from the terminal one) retracts it. */
  private hostTerminalEmitted = false;
  /** Assistant message id of the terminal request the emission relied on
   * (undefined for compact evidence — compact turns have no terminal assistant). */
  private hostTerminalEmittedAssistantId?: string;
  /** Assistant message id of the row that armed the pending candidate. */
  private hostTerminalCandidateAssistantId?: string;
  /**
   * An embedded external turn (hostUserTurnActive + showUser start diverted
   * into the embedded queue) owns transcript emission until its own
   * end_turn/summary: those terminal rows belong to it, never to the host.
   */
  private embeddedExternalEmission = false;

  constructor(private generation = 0) {}

  reset(generation = this.generation + 1): void {
    this.generation = generation;
    this.active = null;
    this.hostTerminalCandidate = false;
    this.hostTerminalCandidateOffset = undefined;
    this.hostTerminalCandidateAssistantId = undefined;
    this.hostTerminalEmitted = false;
    this.hostTerminalEmittedAssistantId = undefined;
    this.embeddedExternalEmission = false;
  }

  /**
   * A new host user turn is live: any unconfirmed host candidate belongs to
   * the turn that just ended (queue release requires its settlement), so it
   * must never arm the next turn's result-late watchdog (reviewer #1: the
   * previous turn's stop_hook_summary can be flushed by the next dispatch).
   * The previous turn's emitted-terminal state dies with it too.
   */
  clearHostTerminalCandidate(): void {
    this.hostTerminalCandidate = false;
    this.hostTerminalCandidateOffset = undefined;
    this.hostTerminalCandidateAssistantId = undefined;
    this.hostTerminalEmitted = false;
    this.hostTerminalEmittedAssistantId = undefined;
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
        this.embeddedExternalEmission = true;
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
      // A newer host row also retires any pending terminal candidate: its
      // end_turn belonged to the previous turn, which must already have
      // settled for this row to dispatch (queue release requires settle).
      this.hostTerminalCandidate = false;
      this.hostTerminalCandidateOffset = undefined;
      this.hostTerminalCandidateAssistantId = undefined;
      this.hostTerminalEmitted = false;
      this.hostTerminalEmittedAssistantId = undefined;
      this.embeddedExternalEmission = false;
      facts.push({
        type: 'observed_start',
        identity: { canonicalTurnId: message.uuid, transcriptUserId: message.uuid, generation: this.generation },
        showUser: false,
        lineOffset: context.lineOffset,
        replay,
      });
    }

    this.trackHostTerminalEvidence(message, replay, facts, context);

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
    const facts: TranscriptTurnFact[] = this.active?.terminalCandidate ? this.finishActive(replay, 'end_turn_quiet') : [];
    if (this.hostTerminalCandidate) {
      // Quiet settle without a stop_hook_summary row (no Stop hooks
      // configured): end_turn plus transcript silence settles the host too.
      // The fact carries the arming end_turn's offset so the observer can
      // still attribute it when the host turn has since been replaced.
      this.hostTerminalCandidate = false;
      facts.push({ type: 'observed_host_terminal', lineOffset: this.hostTerminalCandidateOffset, replay });
      this.hostTerminalCandidateOffset = undefined;
      this.hostTerminalEmitted = true;
      this.hostTerminalEmittedAssistantId = this.hostTerminalCandidateAssistantId;
      this.hostTerminalCandidateAssistantId = undefined;
    }
    return facts;
  }

  hasOpenTurn(): boolean {
    return this.active !== null;
  }

  hasTerminalCandidate(): boolean {
    return this.active?.terminalCandidate === true || this.hostTerminalCandidate;
  }

  /**
   * P0-1 terminal evidence for the host user turn. While no external turn is
   * open, the rows between the host user row and the turn's end belong to the
   * host turn: end_turn arms the candidate, stop_hook_summary confirms it
   * (the CLI only writes that row after the hook round-trip completed — the
   * 2026-10-31 case's terminal pair), and a Stop-hook block feedback row
   * retracts it (the turn continues).
   */
  private trackHostTerminalEvidence(
    message: SDKNativeMessage,
    replay: boolean,
    facts: TranscriptTurnFact[],
    context: TranscriptMapContext,
  ): void {
    if (!context.hostUserTurnActive || this.active !== null) return;
    const endTurn = message.type === 'assistant' && message.message?.stop_reason === 'end_turn';
    const stopHookSummary = message.type === 'system' && message.subtype === 'stop_hook_summary';
    if (this.embeddedExternalEmission) {
      // Rows between an embedded external start and its terminal belong to
      // that turn: its end_turn/summary only return emission ownership to
      // the host, they never arm the host candidate.
      if (endTurn || stopHookSummary) this.embeddedExternalEmission = false;
      return;
    }
    const compactBoundary = message.type === 'system' && message.subtype === 'compact_boundary'
      && (message as { compactMetadata?: { trigger?: unknown } }).compactMetadata?.trigger === 'manual';
    if (compactBoundary) {
      // Manual compact terminal evidence (2026-11-04 d8912b5b): compact turns
      // never write end_turn/stop_hook_summary, so the boundary row itself is
      // arm+confirm. Emitted IMMEDIATELY with no candidate state: the boundary
      // lands before the buffered /compact host row and the continuation rows
      // that follow would walk the host-row reset branch and destroy a
      // candidate — immediate emission is structurally immune to that order.
      // auto compact is a mid-turn non-terminal (turn keeps running): only
      // trigger=manual qualifies (explicit exclusion, not ≠auto).
      const timestamp = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
      if (!Number.isNaN(timestamp)) {
        const version = (message as { version?: unknown }).version;
        facts.push({
          type: 'observed_host_terminal',
          terminalSource: 'compact',
          rowTimestamp: timestamp,
          ...(typeof version === 'string' ? { cliVersion: version } : {}),
          lineOffset: context.lineOffset,
          replay,
        });
        this.hostTerminalEmitted = true;
        this.hostTerminalEmittedAssistantId = undefined;
      }
      // Unparseable timestamp: no fact (fail-safe — a timestamp-less boundary
      // cannot pass the observer's dispatch attribution, degrading to the
      // pre-compact behavior instead of guessing).
      return;
    }
    if (this.hostTerminalEmitted) {
      // Fix 1 (2026-11-05): after a terminal fact was emitted, only STRONG
      // continuation proof retracts it — a Stop-hook block feedback, or a
      // NEW main assistant request distinguishable from the terminal one.
      // Ordinary trailing rows (text tails, usage, notifications,
      // local-command rows, compact continuation shapes) never retract.
      const blockFeedback = isStopHookBlockFeedback(message);
      const assistantId = message.type === 'assistant' ? message.message?.id ?? message.uuid : undefined;
      const newAssistantRequest = message.type === 'assistant'
        && assistantId !== undefined
        && assistantId !== this.hostTerminalEmittedAssistantId;
      if (blockFeedback || newAssistantRequest) {
        this.hostTerminalEmitted = false;
        this.hostTerminalEmittedAssistantId = undefined;
        facts.push({
          type: 'observed_host_terminal_retracted',
          reason: blockFeedback ? 'stop_hook_block' : 'new_assistant_request',
          ...(assistantId !== undefined ? { assistantInstanceId: assistantId } : {}),
          lineOffset: context.lineOffset,
          replay,
        });
        // Fall through: the row itself continues the normal candidate logic
        // (block feedback clears the candidate; a new request's end_turn
        // re-arms it, so the watchdog can re-arm on the NEW terminal).
      } else {
        return;
      }
    }
    if (isStopHookBlockFeedback(message)) {
      this.hostTerminalCandidate = false;
      this.hostTerminalCandidateOffset = undefined;
      this.hostTerminalCandidateAssistantId = undefined;
      return;
    }
    if (endTurn) {
      this.hostTerminalCandidate = true;
      this.hostTerminalCandidateOffset = context.lineOffset;
      this.hostTerminalCandidateAssistantId = message.message?.id ?? message.uuid;
      return;
    }
    if (stopHookSummary && this.hostTerminalCandidate) {
      this.hostTerminalCandidate = false;
      facts.push({ type: 'observed_host_terminal', lineOffset: context.lineOffset, replay });
      this.hostTerminalCandidateOffset = undefined;
      this.hostTerminalEmitted = true;
      this.hostTerminalEmittedAssistantId = this.hostTerminalCandidateAssistantId;
      this.hostTerminalCandidateAssistantId = undefined;
    }
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
