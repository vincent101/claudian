import type {
  PermissionMode as SDKPermissionMode,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  ChatRuntimeEnsureReadyOptions,
  ChatTurnMetadata,
} from '../../../core/runtime/types';
import type { ImageAttachment, StreamChunk } from '../../../core/types';
import type { PermissionMode } from '../../../core/types/settings';
import type { TransformStreamState } from '../stream/toolInputStreamState';
import type { TransformUsageState } from '../stream/transformClaudeMessage';
import { createTransformStreamState, createTransformUsageState } from '../stream/transformClaudeMessage';
import type { ClaudeModel, EffortLevel } from '../types/models';

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageAttachment['mediaType'];
    data: string;
  };
}

export type UserContentBlock = TextContentBlock | ImageContentBlock;

export const MESSAGE_CHANNEL_CONFIG = {
  MAX_QUEUED_MESSAGES: 8, // Memory protection from rapid user input
  MAX_MERGED_CHARS: 12000, // ~3k tokens — batch size under context limits
} as const;

export interface PendingTextMessage {
  type: 'text';
  turnId: string;
  content: string;
}

export interface PendingAttachmentMessage {
  type: 'attachment';
  turnId: string;
  message: SDKUserMessage;
}

export type PendingMessage = PendingTextMessage | PendingAttachmentMessage;

/** Channel lease operation outcome. Occupancy conflicts are reported, never thrown. */
export type TurnChannelResult =
  | { ok: true }
  | {
      ok: false;
      code: 'active_turn_exists' | 'turn_mismatch' | 'unknown_turn';
      activeTurnId: string | null;
    };

export interface EnqueueResult {
  /** Turn id that owns the resulting queue item (first writer wins on text merge). */
  canonicalTurnId: string;
}

/** Sync payload fired when the runtime starts an SDK-initiated (auto) turn. */
export interface AutoTurnStartedEvent {
  turnId: string;
  generation: number;
}

export type RuntimeTurnKind = 'user' | 'auto';

export type RuntimeTurnPhase =
  | 'queued'
  | 'collecting'
  | 'projecting'
  | 'settled'
  | 'cancelled';

/**
 * Turn-scoped state. Replaces the runtime's global transform/usage/metadata
 * buffers so that two overlapping turns (user + auto) never share state.
 */
export interface RuntimeTurn {
  id: string;
  kind: RuntimeTurnKind;
  phase: RuntimeTurnPhase;
  generation: number;
  /** Buffered chunks for auto turns (no live consumer); empty for user turns. */
  chunks: StreamChunk[];
  metadata: ChatTurnMetadata;
  bufferedUsage: Extract<StreamChunk, { type: 'usage' }> | null;
  streamState: TransformStreamState;
  usageState: TransformUsageState;
  sawStreamText: boolean;
  sawStreamThinking: boolean;
  receivedChunk: boolean;
  abortController: AbortController;
  /** Live consumer handlers; all of them receive chunks and settlement. */
  waiters: Set<ResponseHandler>;
  /** Set when this turn's message merged into another turn's queue item. */
  mergedInto: string | null;
}

export interface RuntimeTurnOptions {
  id: string;
  kind: RuntimeTurnKind;
  phase?: RuntimeTurnPhase;
}

export function createRuntimeTurn(options: RuntimeTurnOptions): RuntimeTurn {
  return {
    id: options.id,
    kind: options.kind,
    phase: options.phase ?? 'queued',
    generation: 0,
    chunks: [],
    metadata: {},
    bufferedUsage: null,
    streamState: createTransformStreamState(),
    usageState: createTransformUsageState(),
    sawStreamText: false,
    sawStreamThinking: false,
    receivedChunk: false,
    abortController: new AbortController(),
    waiters: new Set(),
    mergedInto: null,
  };
}

export interface ClosePersistentQueryOptions {
  preserveHandlers?: boolean;
}

export interface ClaudeEnsureReadyOptions extends ChatRuntimeEnsureReadyOptions {
  externalContextPaths?: string[];
  preserveHandlers?: boolean;
  sessionId?: string;
}

export interface ResponseHandler {
  readonly id: string;
  onChunk: (chunk: StreamChunk) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  readonly sawStreamText: boolean;
  readonly sawStreamThinking: boolean;
  readonly sawAnyChunk: boolean;
  markStreamTextSeen(): void;
  markStreamThinkingSeen(): void;
  resetStreamText(): void;
  resetStreamThinking(): void;
  markChunkSeen(): void;
}

export interface ResponseHandlerOptions {
  id: string;
  onChunk: (chunk: StreamChunk) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

export function createResponseHandler(options: ResponseHandlerOptions): ResponseHandler {
  let _sawStreamText = false;
  let _sawStreamThinking = false;
  let _sawAnyChunk = false;

  return {
    id: options.id,
    onChunk: options.onChunk,
    onDone: options.onDone,
    onError: options.onError,
    get sawStreamText() { return _sawStreamText; },
    get sawStreamThinking() { return _sawStreamThinking; },
    get sawAnyChunk() { return _sawAnyChunk; },
    markStreamTextSeen() { _sawStreamText = true; },
    markStreamThinkingSeen() { _sawStreamThinking = true; },
    resetStreamText() { _sawStreamText = false; },
    resetStreamThinking() { _sawStreamThinking = false; },
    markChunkSeen() { _sawAnyChunk = true; },
  };
}

export interface PersistentQueryConfig {
  model: string | null;
  thinkingTokens: number | null;
  effortLevel: EffortLevel | null;
  permissionMode: PermissionMode | null;
  sdkPermissionMode: SDKPermissionMode | null;
  systemPromptKey: string;
  disallowedToolsKey: string;
  mcpServersKey: string;
  pluginsKey: string;
  externalContextPaths: string[];
  settingSources: string;
  claudeCliPath: string;
  enableChrome: boolean;
  enableAutoMode: boolean;
}

export interface SessionState {
  sessionId: string | null;
  sessionModel: ClaudeModel | null;
  pendingSessionModel: ClaudeModel | null;
  wasInterrupted: boolean;
  /** Set when SDK returns a different session ID than expected (context lost). */
  needsHistoryRebuild: boolean;
  /** Set when the current session is invalidated by SDK errors. */
  sessionInvalidated: boolean;
}

export const UNSUPPORTED_SDK_TOOLS = [] as const;

/** Built-in subagents that don't apply to Obsidian context. */
export const DISABLED_BUILTIN_SUBAGENTS = [
  'Task(statusline-setup)',
] as const;

export function isTurnCompleteMessage(message: SDKMessage): boolean {
  return message.type === 'result';
}
