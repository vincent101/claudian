/**
 * Message Channel
 *
 * Queue-based async iterable for persistent queries.
 * Handles message queuing, turn lease management, and text merging.
 *
 * Turn lease rules (S1 turn-lease base):
 * - Exactly one activeTurnId at a time; set when a user message is delivered
 *   to the waiting consumer or picked up by next(), and by beginExternalTurn
 *   for SDK-initiated (auto) turns.
 * - completeTurn(turnId) validates the caller owns the lease before releasing.
 * - Lease operations return TurnChannelResult instead of throwing, so a
 *   mismatch can be settled locally instead of killing the consumer loop.
 * - Queue items carry their turnId; text merges keep the first item's turnId
 *   as the canonical lease (later queries join that turn's waiters).
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  type EnqueueResult,
  MESSAGE_CHANNEL_CONFIG,
  type PendingMessage,
  type PendingTextMessage,
  type TurnChannelResult,
} from './types';

/**
 * MessageChannel - Queue-based async iterable for persistent queries.
 *
 * Rules:
 * - Single in-flight turn at a time
 * - Text-only messages merge with \n\n while a turn is active
 * - Attachment messages (with images) queue one at a time; newer replaces older while turn is active
 * - Overflow policy: drop newest and warn
 */
export class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: PendingMessage[] = [];
  private activeTurnId: string | null = null;
  private closed = false;
  private resolveNext: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private currentSessionId: string | null = null;
  private onWarning: (message: string) => void;
  private onTurnDequeued: (turnId: string) => void;

  constructor(
    onWarning: (message: string) => void = () => {},
    onTurnDequeued: (turnId: string) => void = () => {},
  ) {
    this.onWarning = onWarning;
    this.onTurnDequeued = onTurnDequeued;
  }

  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  getActiveTurnId(): string | null {
    return this.activeTurnId;
  }

  isTurnActive(): boolean {
    return this.activeTurnId !== null;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Acquire the lease for an SDK-initiated (auto) turn. Fails fast when a
   * turn (user or auto) already owns the lease — never overwrites it.
   */
  beginExternalTurn(turnId: string): TurnChannelResult {
    if (this.activeTurnId !== null) {
      return { ok: false, code: 'active_turn_exists', activeTurnId: this.activeTurnId };
    }
    this.activeTurnId = turnId;
    return { ok: true };
  }

  /**
   * Release the lease after turn completion. Only the lease owner may
   * release; a mismatch is reported so the runtime can settle the actual
   * active turn. Releasing may synchronously deliver the next queued user
   * message to a waiting consumer.
   */
  completeTurn(turnId: string): TurnChannelResult {
    if (this.activeTurnId === null) {
      return { ok: false, code: 'unknown_turn', activeTurnId: null };
    }
    if (this.activeTurnId !== turnId) {
      return { ok: false, code: 'turn_mismatch', activeTurnId: this.activeTurnId };
    }

    this.activeTurnId = null;
    this.deliverNextIfWaiting();
    return { ok: true };
  }

  /** Remove a still-queued turn's item. Returns false when the turn was never (or no longer) queued. */
  cancelQueuedTurn(turnId: string): boolean {
    const index = this.queue.findIndex(m => m.turnId === turnId);
    if (index < 0) {
      return false;
    }
    this.queue.splice(index, 1);
    return true;
  }

  /** Drop the active lease and every queued item. Returns all affected turnIds (active first). */
  cancelAll(): string[] {
    const turnIds: string[] = [];
    if (this.activeTurnId !== null) {
      turnIds.push(this.activeTurnId);
      this.activeTurnId = null;
    }
    for (const item of this.queue) {
      turnIds.push(item.turnId);
    }
    this.queue = [];
    return turnIds;
  }

  /**
   * Enqueue a message. If a turn is active:
   * - Text-only: merge with queued text (up to MAX_MERGED_CHARS); the first
   *   item's turnId stays canonical and is returned as canonicalTurnId
   * - With attachments: replace any existing queued attachment (one at a
   *   time), keeping the first item's turnId canonical
   */
  enqueue(turnId: string, message: SDKUserMessage): EnqueueResult {
    if (this.closed) {
      throw new Error('MessageChannel is closed');
    }

    const hasAttachments = this.messageHasAttachments(message);

    if (this.activeTurnId === null) {
      if (this.resolveNext) {
        // Consumer is waiting - deliver immediately and sign the lease
        this.activeTurnId = turnId;
        const resolve = this.resolveNext;
        this.resolveNext = null;
        resolve({ value: message, done: false });
        this.onTurnDequeued(turnId);
      } else {
        // No consumer waiting yet - queue for later pickup by next()
        // Don't set activeTurnId here; next() will set it when it dequeues
        if (this.queue.length >= MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES) {
          this.onWarning(`[MessageChannel] Queue full (${MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES}), dropping newest`);
          return { canonicalTurnId: turnId, dropped: true };
        }
        if (hasAttachments) {
          this.queue.push({ type: 'attachment', turnId, message });
        } else {
          this.queue.push({ type: 'text', turnId, content: this.extractTextContent(message) });
        }
      }
      return { canonicalTurnId: turnId };
    }

    // Turn is active - queue the message
    if (hasAttachments) {
      // Non-text messages are deferred as-is (one at a time)
      // Find existing attachment message or add new one
      const existingIdx = this.queue.findIndex(m => m.type === 'attachment');
      if (existingIdx >= 0) {
        // Replace existing (newer takes precedence for attachments), but the
        // queue item keeps the first turnId as the canonical lease.
        const existing = this.queue[existingIdx];
        this.queue[existingIdx] = { type: 'attachment', turnId: existing.turnId, message };
        this.onWarning('[MessageChannel] Attachment message replaced (only one can be queued)');
        return { canonicalTurnId: existing.turnId };
      }
      this.queue.push({ type: 'attachment', turnId, message });
      return { canonicalTurnId: turnId };
    }

    // Text-only - merge with existing text in queue
    const textContent = this.extractTextContent(message);
    const existingTextIdx = this.queue.findIndex(m => m.type === 'text');

    if (existingTextIdx >= 0) {
      const existing = this.queue[existingTextIdx] as PendingTextMessage;
      const mergedContent = existing.content + '\n\n' + textContent;

      // Check merged size
      if (mergedContent.length > MESSAGE_CHANNEL_CONFIG.MAX_MERGED_CHARS) {
        this.onWarning(`[MessageChannel] Merged content exceeds ${MESSAGE_CHANNEL_CONFIG.MAX_MERGED_CHARS} chars, dropping newest`);
        return { canonicalTurnId: existing.turnId, dropped: true };
      }

      existing.content = mergedContent;
      return { canonicalTurnId: existing.turnId };
    }

    // No existing text - add new
    if (this.queue.length >= MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES) {
      this.onWarning(`[MessageChannel] Queue full (${MESSAGE_CHANNEL_CONFIG.MAX_QUEUED_MESSAGES}), dropping newest`);
      return { canonicalTurnId: turnId, dropped: true };
    }
    this.queue.push({ type: 'text', turnId, content: textContent });
    return { canonicalTurnId: turnId };
  }

  /**
   * Close the channel and end the async iterable. Returns all turnIds that
   * still held state (active + queued) so the runtime can settle them.
   */
  close(): string[] {
    const turnIds: string[] = [];
    if (this.activeTurnId !== null) {
      turnIds.push(this.activeTurnId);
      this.activeTurnId = null;
    }
    for (const item of this.queue) {
      turnIds.push(item.turnId);
    }

    this.closed = true;
    this.queue = [];
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
    }
    return turnIds;
  }

  reset(): void {
    this.queue = [];
    this.activeTurnId = null;
    this.closed = false;
    this.resolveNext = null;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  /** TurnIds of queued items, in order. Diagnostics and tests only. */
  getQueuedTurnIds(): string[] {
    return this.queue.map(item => item.turnId);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
        }

        // If there's a queued message and no active turn, return it
        if (this.queue.length > 0 && this.activeTurnId === null) {
          const pending = this.queue.shift()!;
          this.activeTurnId = pending.turnId;
          this.onTurnDequeued(pending.turnId);
          return Promise.resolve({ value: this.pendingToMessage(pending), done: false });
        }

        // Wait for next message
        return new Promise((resolve) => {
          this.resolveNext = resolve;
        });
      },
    };
  }

  private deliverNextIfWaiting(): void {
    if (this.queue.length === 0 || !this.resolveNext) {
      return;
    }
    const pending = this.queue.shift()!;
    this.activeTurnId = pending.turnId;
    const resolve = this.resolveNext;
    this.resolveNext = null;
    resolve({ value: this.pendingToMessage(pending), done: false });
    this.onTurnDequeued(pending.turnId);
  }

  private messageHasAttachments(message: SDKUserMessage): boolean {
    if (!message.message?.content) return false;
    if (typeof message.message.content === 'string') return false;
    return message.message.content.some((block: { type: string }) => block.type === 'image');
  }

  private extractTextContent(message: SDKUserMessage): string {
    if (!message.message?.content) return '';
    if (typeof message.message.content === 'string') return message.message.content;
    return message.message.content
      .filter((block: { type: string }): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block: { type: 'text'; text: string }) => block.text)
      .join('\n\n');
  }

  private pendingToMessage(pending: PendingMessage): SDKUserMessage {
    if (pending.type === 'attachment') {
      return pending.message;
    }

    return {
      type: 'user',
      message: {
        role: 'user',
        content: pending.content,
      },
      parent_tool_use_id: null,
      session_id: this.currentSessionId || '',
    };
  }
}
