import type { SDKMessage, SDKResultError } from '@anthropic-ai/claude-agent-sdk';

import type { SDKToolUseResult, StreamChunk, UsageInfo } from '../../../core/types';
import { isBlockedMessage } from '../sdk/messages';
import { extractToolResultContent } from '../sdk/toolResultContent';
import type { TransformEvent } from '../sdk/types';
import { getContextWindowSize } from '../types/models';
import { createTransformStreamState, type TransformStreamState } from './toolInputStreamState';

type ToolUseFields = { id: string; name: string; input: Record<string, unknown> };
type ToolResultFields = { id: string; content: string; isError?: boolean; toolUseResult?: SDKToolUseResult };

export { createTransformStreamState };

function getToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function emitToolUse(parentToolUseId: string | null, fields: ToolUseFields): StreamChunk {
  if (parentToolUseId === null) {
    return { type: 'tool_use', ...fields };
  }
  return { type: 'subagent_tool_use', subagentId: parentToolUseId, ...fields };
}

function emitToolResult(parentToolUseId: string | null, fields: ToolResultFields): StreamChunk {
  if (parentToolUseId === null) {
    return { type: 'tool_result', ...fields };
  }
  return { type: 'subagent_tool_result', subagentId: parentToolUseId, ...fields };
}

export interface TransformOptions {
  /** The intended model from settings/query (used for context window size). */
  intendedModel?: string;
  /**
   * SDK-resolved model captured at session_init, owned by the runtime so it
   * survives across turns (system/init fires once per persistent query).
   */
  sessionResolvedModel?: string;
  /** Custom context limits from settings (model ID → tokens). */
  customContextLimits?: Record<string, number>;
  /** Tracks active streamed tool blocks so input_json_delta can be normalized. */
  streamState?: TransformStreamState;
  /** Tracks prompt-token usage across Anthropic-compatible stream events. */
  usageState?: TransformUsageState;
}

export interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface PromptUsageSnapshot {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextTokens: number;
}

export interface TransformUsageState {
  clear(): void;
  /**
   * Advances the request boundary without usage data (stream_event
   * message_start). Subsequent same-request fragments merge into the new
   * request instead of the previous one's snapshot.
   */
  beginRequest(messageId?: string | null): void;
  mergePromptUsage(usage: MessageUsage, messageId?: string | null): PromptUsageSnapshot;
  getPromptUsage(): PromptUsageSnapshot;
  hasEmitted(promptUsage: PromptUsageSnapshot): boolean;
  markEmitted(promptUsage: PromptUsageSnapshot): void;
  /** Records the SDK-resolved model reported by system/init. */
  setResolvedModel(model: string): void;
  getResolvedModel(): string | null;
}

function isResultError(message: { type: 'result'; subtype: string }): message is SDKResultError {
  return !!message.subtype && message.subtype !== 'success';
}

const EMPTY_PROMPT_USAGE: PromptUsageSnapshot = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  contextTokens: 0,
};

function normalizeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function hasPromptUsageField(usage: unknown): usage is MessageUsage {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return false;
  }

  const record = usage as Record<string, unknown>;
  return typeof record.input_tokens === 'number'
    || typeof record.cache_creation_input_tokens === 'number'
    || typeof record.cache_read_input_tokens === 'number';
}

function toPromptUsageSnapshot(usage: MessageUsage): PromptUsageSnapshot {
  const inputTokens = normalizeTokenCount(usage.input_tokens);
  const cacheCreationInputTokens = normalizeTokenCount(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = normalizeTokenCount(usage.cache_read_input_tokens);
  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

function mergePromptUsage(
  current: PromptUsageSnapshot,
  usage: MessageUsage,
): PromptUsageSnapshot {
  const next = toPromptUsageSnapshot(usage);
  const inputTokens = Math.max(current.inputTokens, next.inputTokens);
  const cacheCreationInputTokens = Math.max(current.cacheCreationInputTokens, next.cacheCreationInputTokens);
  const cacheReadInputTokens = Math.max(current.cacheReadInputTokens, next.cacheReadInputTokens);
  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

function samePromptUsage(a: PromptUsageSnapshot, b: PromptUsageSnapshot): boolean {
  return a.inputTokens === b.inputTokens
    && a.cacheCreationInputTokens === b.cacheCreationInputTokens
    && a.cacheReadInputTokens === b.cacheReadInputTokens
    && a.contextTokens === b.contextTokens;
}

function buildUsageInfo(promptUsage: PromptUsageSnapshot, options?: TransformOptions): UsageInfo {
  const intendedModel = options?.intendedModel ?? 'sonnet';
  const contextWindow = getContextWindowSize(intendedModel, options?.customContextLimits);
  // Label with the SDK-resolved model (system/init) so persisted usage.model
  // records what actually served the session instead of the alias. Falls back
  // to the runtime's session-level capture, then to the intended alias for
  // turns that never saw a session_init (pre-init or id-less providers). The
  // denominator stays on the turn model snapshot (50214f22): a stale session
  // resolution must not re-denominate a turn dispatched on another model.
  const model = options?.usageState?.getResolvedModel()
    ?? options?.sessionResolvedModel
    ?? intendedModel;
  const percentage = Math.min(100, Math.max(0, Math.round((promptUsage.contextTokens / contextWindow) * 100)));

  return {
    model,
    inputTokens: promptUsage.inputTokens,
    cacheCreationInputTokens: promptUsage.cacheCreationInputTokens,
    cacheReadInputTokens: promptUsage.cacheReadInputTokens,
    contextWindow,
    contextTokens: promptUsage.contextTokens,
    percentage,
  };
}

export function createTransformUsageState(): TransformUsageState {
  let promptUsage: PromptUsageSnapshot = { ...EMPTY_PROMPT_USAGE };
  let lastEmittedPromptUsage: PromptUsageSnapshot | null = null;
  // Request-boundary tracking. SDK assistant messages carry the API message
  // id: segments of one request share it, different requests never do. The
  // snapshot owner records which request the current snapshot belongs to.
  let currentRequestId: string | null = null;
  let snapshotOwner: string | null = null;
  // Session-scoped: unlike prompt usage, the resolved model survives clear()
  // (which fires per assistant message_start) because system/init is emitted
  // once per query while later turns still need it to label usage with the
  // model that actually served the session.
  let resolvedModel: string | null = null;

  return {
    clear(): void {
      promptUsage = { ...EMPTY_PROMPT_USAGE };
      lastEmittedPromptUsage = null;
      currentRequestId = null;
      snapshotOwner = null;
    },

    beginRequest(messageId?: string | null): void {
      if (typeof messageId === 'string' && messageId.length > 0) {
        currentRequestId = messageId;
      }
      lastEmittedPromptUsage = null;
    },

    mergePromptUsage(usage: MessageUsage, messageId?: string | null): PromptUsageSnapshot {
      const next = toPromptUsageSnapshot(usage);
      const id = typeof messageId === 'string' && messageId.length > 0 ? messageId : null;
      if (id !== null) {
        currentRequestId = id;
      }
      const requestKey = id ?? currentRequestId;
      if (requestKey === null || snapshotOwner === requestKey) {
        // No boundary signal, or same request: segments only ever grow
        // monotonically within one request, so max-merge is safe here.
        promptUsage = mergePromptUsage(promptUsage, usage);
      } else if (next.contextTokens > 0) {
        // New request boundary: replace with this request's full usage
        // object. Field-wise max across requests double-counts context (a
        // miss request's uncached input and a hit request's cache_read
        // describe the same tokens, not additive ones).
        promptUsage = next;
        snapshotOwner = requestKey;
      }
      // All-zero fragment from a newer request keeps the established snapshot.
      return { ...promptUsage };
    },

    getPromptUsage(): PromptUsageSnapshot {
      return { ...promptUsage };
    },

    hasEmitted(nextPromptUsage: PromptUsageSnapshot): boolean {
      return lastEmittedPromptUsage !== null && samePromptUsage(lastEmittedPromptUsage, nextPromptUsage);
    },

    markEmitted(nextPromptUsage: PromptUsageSnapshot): void {
      lastEmittedPromptUsage = { ...nextPromptUsage };
    },

    setResolvedModel(model: string): void {
      resolvedModel = model;
    },

    getResolvedModel(): string | null {
      return resolvedModel;
    },
  };
}

function maybeEmitUsageFromPromptUsage(
  promptUsage: PromptUsageSnapshot,
  options?: TransformOptions,
  behavior: { emitZeroUsage?: boolean } = {},
): StreamChunk | null {
  if (promptUsage.contextTokens <= 0) {
    return behavior.emitZeroUsage
      ? { type: 'usage', usage: buildUsageInfo(promptUsage, options) }
      : null;
  }

  if (options?.usageState?.hasEmitted(promptUsage)) {
    return null;
  }

  options?.usageState?.markEmitted(promptUsage);
  return { type: 'usage', usage: buildUsageInfo(promptUsage, options) };
}

/**
 * Transform SDK message to StreamChunk format.
 * One SDK message can yield multiple chunks (e.g., text + tool_use blocks).
 */
export function* transformSDKMessage(
  message: SDKMessage,
  options?: TransformOptions
): Generator<TransformEvent> {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init' && message.session_id) {
        if (message.model) {
          options?.usageState?.setResolvedModel(message.model);
        }
        yield {
          type: 'session_init',
          sessionId: message.session_id,
          model: message.model,
          agents: message.agents,
          permissionMode: message.permissionMode,
        };
      } else if (message.subtype === 'compact_boundary') {
        yield { type: 'context_compacted' };
      }
      break;

    case 'assistant': {
      const parentToolUseId = message.parent_tool_use_id ?? null;

      // Errors on assistant messages (e.g. rate_limit, billing_error)
      if (message.error) {
        yield { type: 'error', content: message.error };
      }

      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'thinking' && block.thinking) {
            if (parentToolUseId === null) {
              yield { type: 'thinking', content: block.thinking };
            }
          } else if (block.type === 'text' && block.text && block.text.trim() !== '(no content)') {
            if (parentToolUseId === null) {
              yield { type: 'text', content: block.text };
            }
          } else if (block.type === 'tool_use') {
            yield emitToolUse(parentToolUseId, {
              id: block.id || `tool-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              name: block.name || 'unknown',
              input: getToolInput(block.input),
            });
          }
        }
      }

      options?.streamState?.clearParent(parentToolUseId);

      // Extract usage from main agent assistant messages only (not subagent)
      // This gives accurate per-turn context usage without subagent token pollution
      const usage = (message.message as { usage?: MessageUsage; id?: string } | undefined)?.usage;
      if (parentToolUseId === null && usage) {
        if (options?.usageState) {
          const promptUsage = options.usageState.mergePromptUsage(
            usage,
            message.message?.id ?? undefined,
          );
          const usageChunk = maybeEmitUsageFromPromptUsage(promptUsage, options, { emitZeroUsage: true });
          if (usageChunk) {
            yield usageChunk;
          }
        } else {
          yield { type: 'usage', usage: buildUsageInfo(toPromptUsageSnapshot(usage), options) };
        }
      }
      break;
    }

    case 'user': {
      const parentToolUseId = message.parent_tool_use_id ?? null;

      // Check for blocked tool calls (from hook denials)
      if (isBlockedMessage(message)) {
        yield {
          type: 'notice',
          content: message._blockReason,
          level: 'warning',
        };
        break;
      }
      // User messages can contain tool results
      if (message.tool_use_result !== undefined && message.parent_tool_use_id) {
        const toolUseResult = (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined;
        yield emitToolResult(parentToolUseId, {
          id: message.parent_tool_use_id,
          content: extractToolResultContent(message.tool_use_result, { fallbackIndent: 2 }),
          isError: false,
          ...(toolUseResult !== undefined ? { toolUseResult } : {}),
        });
      }
      // Also check message.message.content for tool_result blocks
      if (message.message?.content && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            const toolUseResult = (message.tool_use_result ?? undefined) as SDKToolUseResult | undefined;
            yield emitToolResult(parentToolUseId, {
              id: block.tool_use_id || message.parent_tool_use_id || '',
              content: extractToolResultContent(block.content, { fallbackIndent: 2 }),
              isError: block.is_error || false,
              ...(toolUseResult !== undefined ? { toolUseResult } : {}),
            });
          }
        }
      }
      break;
    }

    case 'stream_event': {
      const parentToolUseId = message.parent_tool_use_id ?? null;
      const event = message.event;
      if (parentToolUseId === null && event?.type === 'message_start') {
        // Each main-agent message_start opens a new API request boundary; the
        // boundary id also carries to the following assistant message.
        options?.usageState?.beginRequest((event.message as { id?: string } | undefined)?.id ?? null);
        const usage = (event.message as { usage?: MessageUsage } | undefined)?.usage;
        if (usage && hasPromptUsageField(usage)) {
          if (options?.usageState) {
            options.usageState.mergePromptUsage(usage);
          } else {
            const usageChunk = maybeEmitUsageFromPromptUsage(toPromptUsageSnapshot(usage), options);
            if (usageChunk) {
              yield usageChunk;
            }
          }
        }
      } else if (parentToolUseId === null && event?.type === 'message_delta' && hasPromptUsageField(event.usage)) {
        if (options?.usageState) {
          const previousPromptUsage = options.usageState.getPromptUsage();
          const promptUsage = options.usageState.mergePromptUsage(event.usage);
          const shouldEmitDeltaUsage = previousPromptUsage.contextTokens <= 0
            || options.usageState.hasEmitted(previousPromptUsage);
          if (shouldEmitDeltaUsage) {
            const usageChunk = maybeEmitUsageFromPromptUsage(promptUsage, options);
            if (usageChunk) {
              yield usageChunk;
            }
          }
        } else {
          const usageChunk = maybeEmitUsageFromPromptUsage(toPromptUsageSnapshot(event.usage), options);
          if (usageChunk) {
            yield usageChunk;
          }
        }
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const toolUseFields: ToolUseFields = {
          id: event.content_block.id || `tool-${Date.now()}`,
          name: event.content_block.name || 'unknown',
          input: getToolInput(event.content_block.input),
        };
        if (typeof event.index === 'number') {
          options?.streamState?.registerToolUse(parentToolUseId, event.index, toolUseFields);
        }
        yield emitToolUse(parentToolUseId, toolUseFields);
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        if (parentToolUseId === null && event.content_block.thinking) {
          yield { type: 'thinking', content: event.content_block.thinking };
        }
      } else if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        if (parentToolUseId === null && event.content_block.text) {
          yield { type: 'text', content: event.content_block.text };
        }
      } else if (event?.type === 'content_block_delta') {
        if (event.delta?.type === 'input_json_delta' && typeof event.index === 'number') {
          const toolUseFields = options?.streamState?.applyInputJsonDelta(
            parentToolUseId,
            event.index,
            event.delta.partial_json,
          );
          if (toolUseFields) {
            yield emitToolUse(parentToolUseId, toolUseFields);
          }
        } else if (parentToolUseId === null && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          yield { type: 'thinking', content: event.delta.thinking };
        } else if (parentToolUseId === null && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', content: event.delta.text };
        }
      } else if (event?.type === 'content_block_stop' && typeof event.index === 'number') {
        options?.streamState?.clearContentBlock(parentToolUseId, event.index);
      }
      break;
    }

    case 'result':
      options?.streamState?.clearAll();
      if (options?.usageState) {
        const usageChunk = maybeEmitUsageFromPromptUsage(options.usageState.getPromptUsage(), options);
        if (usageChunk) {
          yield usageChunk;
        }
        options.usageState.clear();
      }
      if (isResultError(message)) {
        const content = message.errors.filter((e) => e.trim().length > 0).join('\n');
        yield {
          type: 'error',
          content: content || `Result error: ${message.subtype}`,
        };
      }

      // Usage is extracted from assistant messages for accuracy (excludes
      // subagent tokens); result-message usage is aggregated across main +
      // subagents and would cause inaccurate spikes.

      // modelUsage / contextWindow is deliberately ignored (2.3.2 ②, user
      // ruling 2026-09-17): the denominator follows the model selector's
      // preset configuration only. Stream-phase and settled denominators stay
      // on this single source; the SDK-reported window never overrides it.
      break;

    default:
      break;
  }
}
