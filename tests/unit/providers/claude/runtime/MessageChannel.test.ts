import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { MessageChannel } from '@/providers/claude/runtime/ClaudeMessageChannel';

// Helper to create SDK-format text user message
function createTextUserMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

// Helper to create SDK-format image user message
function createImageUserMessage(data = 'image-data'): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data,
          },
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

describe('MessageChannel', () => {
  let channel: MessageChannel;
  let warnings: string[];
  let dequeuedTurnIds: string[];

  beforeEach(() => {
    warnings = [];
    dequeuedTurnIds = [];
    channel = new MessageChannel(
      (message) => warnings.push(message),
      (turnId) => dequeuedTurnIds.push(turnId),
    );
  });

  afterEach(() => {
    channel.close();
  });

  describe('basic operations', () => {
    it('should initially not be closed', () => {
      expect(channel.isClosed()).toBe(false);
    });

    it('should initially have no active turn', () => {
      expect(channel.isTurnActive()).toBe(false);
      expect(channel.getActiveTurnId()).toBeNull();
    });

    it('should initially have empty queue', () => {
      expect(channel.getQueueLength()).toBe(0);
    });
  });

  describe('enqueue and iteration', () => {
    it('merges queued text messages and stamps the session ID', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const firstPromise = iterator.next();
      channel.enqueue('turn-1', createTextUserMessage('first'));
      const first = await firstPromise;

      expect(first.value.message.content).toBe('first');

      channel.enqueue('turn-2', createTextUserMessage('second'));
      channel.enqueue('turn-3', createTextUserMessage('third'));
      channel.setSessionId('session-abc');
      channel.completeTurn('turn-1');

      const merged = await iterator.next();
      expect(merged.value.message.content).toBe('second\n\nthird');
      expect(merged.value.session_id).toBe('session-abc');
      expect(warnings).toHaveLength(0);
    });

    it('defers attachment messages and keeps the latest one', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const firstPromise = iterator.next();
      channel.enqueue('turn-1', createTextUserMessage('first'));
      await firstPromise;

      const attachmentOne = createImageUserMessage('image-one');
      const attachmentTwo = createImageUserMessage('image-two');

      channel.enqueue('turn-2', attachmentOne);
      channel.enqueue('turn-3', attachmentTwo);

      channel.completeTurn('turn-1');

      const queued = await iterator.next();
      expect(queued.value.message.content).toEqual(attachmentTwo.message.content);
      expect(warnings.some((msg) => msg.includes('Attachment message replaced'))).toBe(true);
    });

    it('drops merged text when it exceeds the max length', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const firstPromise = iterator.next();
      channel.enqueue('turn-1', createTextUserMessage('first'));
      await firstPromise;

      const longText = 'x'.repeat(12000);
      channel.enqueue('turn-2', createTextUserMessage('short'));
      channel.enqueue('turn-3', createTextUserMessage(longText));

      channel.completeTurn('turn-1');

      const merged = await iterator.next();
      expect(merged.value.message.content).toBe('short');
      expect(warnings.some((msg) => msg.includes('Merged content exceeds'))).toBe(true);
    });

    it('delivers message when enqueue is called before next (no deadlock)', async () => {
      // Enqueue BEFORE calling next() - this used to cause a deadlock
      channel.enqueue('turn-early', createTextUserMessage('early message'));

      // Now call next() - it should pick up the queued message
      const iterator = channel[Symbol.asyncIterator]();
      const result = await iterator.next();

      expect(result.done).toBe(false);
      expect(result.value.message.content).toBe('early message');
    });

    it('handles multiple enqueues before first next (queued separately)', async () => {
      // Enqueue multiple messages before any next() call
      // When turnActive=false, messages queue separately (no merging)
      channel.enqueue('turn-a', createTextUserMessage('first'));
      channel.enqueue('turn-b', createTextUserMessage('second'));

      const iterator = channel[Symbol.asyncIterator]();

      // First next() gets first message, turns on turnActive
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.message.content).toBe('first');

      // Complete turn so second message can be delivered
      channel.completeTurn('turn-a');

      // Second next() gets second message
      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value.message.content).toBe('second');
    });
  });

  describe('error handling', () => {
    it('throws error when enqueueing to closed channel', () => {
      channel.close();
      expect(() => channel.enqueue('turn-1', createTextUserMessage('test'))).toThrow('MessageChannel is closed');
    });
  });

  describe('queue overflow', () => {
    it('drops newest messages when queue is full before consumer starts', () => {
      // Queue many messages before starting iteration (turnActive=false)
      for (let i = 0; i < 10; i++) {
        channel.enqueue(`turn-${i}`, createTextUserMessage(`msg-${i}`));
      }

      // Queue full warning should be triggered
      expect(warnings.filter((msg) => msg.includes('Queue full'))).not.toHaveLength(0);

      // Verify the queue length is capped at MAX_QUEUED_MESSAGES (8)
      expect(channel.getQueueLength()).toBe(8);
    });

    it('reports a dropped signal on queue-full overflow (S1 leftover #1)', () => {
      for (let i = 0; i < 8; i++) {
        const result = channel.enqueue(`turn-${i}`, createTextUserMessage(`msg-${i}`));
        expect(result.dropped).toBeUndefined();
      }
      // The 9th message overflows: recognizable drop signal so the runtime
      // can settle the turn instead of leaving its handler pending forever.
      const dropped = channel.enqueue('turn-overflow', createTextUserMessage('msg-8'));
      expect(dropped).toEqual({ canonicalTurnId: 'turn-overflow', dropped: true });
      expect(channel.getQueueLength()).toBe(8);
    });

    it('reports a dropped signal when merged text exceeds the cap', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const firstPromise = iterator.next();
      channel.enqueue('turn-1', createTextUserMessage('first'));
      await firstPromise;

      channel.enqueue('turn-2', createTextUserMessage('a'.repeat(11000)));
      const dropped = channel.enqueue('turn-3', createTextUserMessage('b'.repeat(2000)));
      expect(dropped).toEqual({ canonicalTurnId: 'turn-2', dropped: true });
      expect(warnings.filter((msg) => msg.includes('Merged content exceeds'))).not.toHaveLength(0);
    });
  });

  describe('close resolves pending consumer', () => {
    it('resolves pending next() with done:true when closed', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      // Start waiting for a message (no message enqueued yet)
      const pendingPromise = iterator.next();

      // Close the channel while consumer is waiting
      channel.close();

      const result = await pendingPromise;
      expect(result.done).toBe(true);
    });
  });

  describe('queue overflow during active turn', () => {
    it('drops text when queue is full during active turn', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      // Start a turn
      const firstPromise = iterator.next();
      channel.enqueue('turn-1', createTextUserMessage('first'));
      await firstPromise;

      // Fill queue during active turn - first text merges, then subsequent
      // ones also merge. Attachments replace each other.
      channel.enqueue('turn-2', createTextUserMessage('queued-text'));

      // Enqueue attachments to fill remaining queue slots
      for (let i = 0; i < 8; i++) {
        channel.enqueue(`turn-img-${i}`, createImageUserMessage(`img-${i}`));
      }

      // The queue should have text + attachment = 2 items
      expect(channel.getQueueLength()).toBe(2);
    });
  });

  describe('enqueue attachment before consumer starts (no active turn)', () => {
    it('queues attachment message when no turn is active and no consumer', () => {
      channel.enqueue('turn-1', createImageUserMessage('early-img'));
      expect(channel.getQueueLength()).toBe(1);
    });
  });

  describe('completeTurn with queued messages and waiting consumer', () => {
    it('delivers queued message to waiting consumer on turn complete', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      // Deliver first message to start a turn
      const firstPromise = iterator.next();
      channel.enqueue('turn-1', createTextUserMessage('turn-1'));
      await firstPromise;

      // Queue a message during active turn
      channel.enqueue('turn-2', createTextUserMessage('turn-2'));

      // Start waiting for next message (consumer blocks)
      const secondPromise = iterator.next();

      // Complete the turn - should deliver queued message to waiting consumer
      channel.completeTurn('turn-1');

      const result = await secondPromise;
      expect(result.done).toBe(false);
      expect(result.value.message.content).toBe('turn-2');
      expect(channel.isTurnActive()).toBe(true);
      expect(channel.getActiveTurnId()).toBe('turn-2');
    });
  });

  describe('text extraction from content blocks', () => {
    it('extracts text from mixed content blocks', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      const mixedMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
          ],
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      const firstPromise = iterator.next();
      channel.enqueue('turn-1', mixedMessage);
      const result = await firstPromise;

      // Text blocks joined with \n\n when no turn is active (direct delivery)
      expect(result.value.message.content).toEqual(mixedMessage.message.content);
    });

    it('handles empty content gracefully', async () => {
      const iterator = channel[Symbol.asyncIterator]();

      // Start a turn so messages get queued
      const firstPromise = iterator.next();
      channel.enqueue('turn-1', createTextUserMessage('first'));
      await firstPromise;

      // Enqueue a message with no content during active turn
      const emptyMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: '',
        },
        parent_tool_use_id: null,
        session_id: '',
      };
      channel.enqueue('turn-2', emptyMessage);

      channel.completeTurn('turn-1');

      const result = await iterator.next();
      expect(result.value.message.content).toBe('');
    });
  });

  describe('close and reset', () => {
    it('should mark channel as closed', () => {
      channel.close();
      expect(channel.isClosed()).toBe(true);
    });

    it('should clear queue on close', () => {
      channel.enqueue('turn-1', createTextUserMessage('test'));
      channel.close();
      expect(channel.getQueueLength()).toBe(0);
    });

    it('should reset channel state', () => {
      channel.enqueue('turn-1', createTextUserMessage('test'));
      channel.reset();
      expect(channel.getQueueLength()).toBe(0);
      expect(channel.isClosed()).toBe(false);
      expect(channel.isTurnActive()).toBe(false);
    });

    it('should return done when iterating closed channel', async () => {
      channel.close();
      const iterator = channel[Symbol.asyncIterator]();
      const result = await iterator.next();
      expect(result.done).toBe(true);
    });
  });

  describe('extractTextContent with array content blocks', () => {
    it('should extract and merge text from array-format content during active turn', async () => {
      const ch = new MessageChannel();
      const iterator = ch[Symbol.asyncIterator]();

      // Start a turn with a normal message
      ch.enqueue('turn-1', createTextUserMessage('initial'));
      await iterator.next(); // consume → turn active

      // Enqueue a message with array content (text-only, no images)
      const arrayContentMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      ch.enqueue('turn-2', arrayContentMessage);

      // Complete turn so merged message is delivered
      ch.completeTurn('turn-1');
      const result = await iterator.next();
      expect(result.value.message.content).toBe('Hello\n\nWorld');
    });

    it('should filter out non-text blocks from array content', async () => {
      const ch = new MessageChannel();
      const iterator = ch[Symbol.asyncIterator]();

      // Start a turn
      ch.enqueue('turn-1', createTextUserMessage('initial'));
      await iterator.next(); // consume → turn active

      const mixedContentMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Visible' },
            { type: 'tool_result', tool_use_id: 'x', content: 'hidden' } as any,
            { type: 'text', text: 'Also Visible' },
          ],
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      ch.enqueue('turn-2', mixedContentMessage);

      ch.completeTurn('turn-1');
      const result = await iterator.next();
      expect(result.value.message.content).toBe('Visible\n\nAlso Visible');
    });
  });

  describe('turn management', () => {
    it('should track turn state correctly', async () => {
      expect(channel.isTurnActive()).toBe(false);

      const iterator = channel[Symbol.asyncIterator]();
      channel.enqueue('turn-1', createTextUserMessage('test'));

      // Wait for message to be delivered
      const firstPromise = iterator.next();
      const result = await firstPromise;

      expect(result.done).toBe(false);
      expect(channel.isTurnActive()).toBe(true);
      expect(channel.getActiveTurnId()).toBe('turn-1');

      channel.completeTurn('turn-1');
      expect(channel.isTurnActive()).toBe(false);
      expect(channel.getActiveTurnId()).toBeNull();
    });
  });

  // ============================================
  // S1 turn lease: external turns, dequeue lease, cancel, close reporting
  // ============================================

  describe('beginExternalTurn (auto turn lease)', () => {
    it('acquires the lease when idle', () => {
      const result = channel.beginExternalTurn('auto-1');
      expect(result).toEqual({ ok: true });
      expect(channel.getActiveTurnId()).toBe('auto-1');
    });

    it('fails without overwriting an active user turn', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const firstPromise = iterator.next();
      channel.enqueue('user-1', createTextUserMessage('first'));
      await firstPromise;

      const result = channel.beginExternalTurn('auto-1');
      expect(result).toEqual({ ok: false, code: 'active_turn_exists', activeTurnId: 'user-1' });
      expect(channel.getActiveTurnId()).toBe('user-1');
    });

    it('fails when another external turn holds the lease', () => {
      channel.beginExternalTurn('auto-1');
      const result = channel.beginExternalTurn('auto-2');
      expect(result).toEqual({ ok: false, code: 'active_turn_exists', activeTurnId: 'auto-1' });
    });

    it('external turn blocks user delivery until completed (mutual exclusion)', async () => {
      channel.beginExternalTurn('auto-1');

      // User message enqueued while an external turn is active → queued
      channel.enqueue('user-1', createTextUserMessage('user msg'));
      expect(channel.getQueueLength()).toBe(1);

      const iterator = channel[Symbol.asyncIterator]();
      const pending = iterator.next();

      channel.completeTurn('auto-1');
      const result = await pending;
      expect(result.done).toBe(false);
      expect(result.value.message.content).toBe('user msg');
      expect(channel.getActiveTurnId()).toBe('user-1');
    });
  });

  describe('completeTurn validation', () => {
    it('rejects completion of a non-active turn id', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const firstPromise = iterator.next();
      channel.enqueue('user-1', createTextUserMessage('first'));
      await firstPromise;

      const result = channel.completeTurn('other-turn');
      expect(result).toEqual({ ok: false, code: 'turn_mismatch', activeTurnId: 'user-1' });
      expect(channel.getActiveTurnId()).toBe('user-1');
    });

    it('reports unknown turn when no lease is held', () => {
      const result = channel.completeTurn('user-1');
      expect(result).toEqual({ ok: false, code: 'unknown_turn', activeTurnId: null });
    });
  });

  describe('dequeue signs the lease (onTurnDequeued)', () => {
    it('signs lease and fires callback on direct delivery to waiting consumer', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const pending = iterator.next();

      channel.enqueue('user-1', createTextUserMessage('hello'));
      await pending;

      expect(channel.getActiveTurnId()).toBe('user-1');
      expect(dequeuedTurnIds).toEqual(['user-1']);
    });

    it('signs lease and fires callback when next() picks up a queued item', async () => {
      channel.enqueue('user-1', createTextUserMessage('hello'));

      const iterator = channel[Symbol.asyncIterator]();
      await iterator.next();

      expect(channel.getActiveTurnId()).toBe('user-1');
      expect(dequeuedTurnIds).toEqual(['user-1']);
    });

    it('fires for each queued item as the previous turn completes', async () => {
      channel.enqueue('user-1', createTextUserMessage('one'));
      channel.enqueue('user-2', createTextUserMessage('two'));

      const iterator = channel[Symbol.asyncIterator]();
      await iterator.next(); // user-1 dequeues

      channel.completeTurn('user-1');
      await iterator.next(); // user-2 dequeues

      expect(dequeuedTurnIds).toEqual(['user-1', 'user-2']);
    });
  });

  describe('canonical lease merging', () => {
    it('text merge keeps the first turnId canonical and reports it', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const firstPromise = iterator.next();
      channel.enqueue('user-1', createTextUserMessage('first'));
      await firstPromise;

      // user-2 opens a queued text item; user-3 merges into it and is told
      // the canonical lease stayed with user-2.
      const second = channel.enqueue('user-2', createTextUserMessage('second'));
      expect(second).toEqual({ canonicalTurnId: 'user-2' });
      const third = channel.enqueue('user-3', createTextUserMessage('third'));
      expect(third).toEqual({ canonicalTurnId: 'user-2' });

      channel.completeTurn('user-1');
      const merged = await iterator.next();
      expect(merged.value.message.content).toBe('second\n\nthird');
      expect(channel.getActiveTurnId()).toBe('user-2');
    });

    it('attachment replace keeps the first turnId canonical', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const firstPromise = iterator.next();
      channel.enqueue('user-1', createTextUserMessage('first'));
      await firstPromise;

      channel.enqueue('user-2', createImageUserMessage('img-1'));
      const replaced = channel.enqueue('user-3', createImageUserMessage('img-2'));
      expect(replaced).toEqual({ canonicalTurnId: 'user-2' });

      channel.completeTurn('user-1');
      const result = await iterator.next();
      expect(result.value.message.content).toEqual(createImageUserMessage('img-2').message.content);
      expect(channel.getActiveTurnId()).toBe('user-2');
    });

    it('non-merged queued items keep their own turnIds', () => {
      channel.enqueue('user-1', createTextUserMessage('one'));
      channel.enqueue('user-2', createTextUserMessage('two'));
      expect(channel.getQueuedTurnIds()).toEqual(['user-1', 'user-2']);
    });
  });

  describe('cancelQueuedTurn', () => {
    it('removes the queued item for the given turn and returns true', () => {
      channel.enqueue('user-1', createTextUserMessage('one'));
      channel.enqueue('user-2', createTextUserMessage('two'));

      expect(channel.cancelQueuedTurn('user-1')).toBe(true);
      expect(channel.getQueuedTurnIds()).toEqual(['user-2']);
    });

    it('returns false for an unknown or already-cancelled turn', () => {
      expect(channel.cancelQueuedTurn('nope')).toBe(false);
      channel.enqueue('user-1', createTextUserMessage('one'));
      channel.cancelQueuedTurn('user-1');
      expect(channel.cancelQueuedTurn('user-1')).toBe(false);
    });
  });

  describe('cancelAll', () => {
    it('clears lease and queue, returning all affected turnIds', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const firstPromise = iterator.next();
      channel.enqueue('user-1', createTextUserMessage('first'));
      await firstPromise;

      // Text items merge into one canonical lease; attachments stay separate.
      channel.enqueue('user-2', createTextUserMessage('second'));
      channel.enqueue('user-3', createTextUserMessage('third'));
      channel.enqueue('user-4', createImageUserMessage('img'));

      const ids = channel.cancelAll();
      expect(ids).toEqual(['user-1', 'user-2', 'user-4']);
      expect(channel.getActiveTurnId()).toBeNull();
      expect(channel.getQueueLength()).toBe(0);
      expect(channel.isClosed()).toBe(false);
    });
  });

  describe('close turn reporting', () => {
    it('returns active and queued turnIds for runtime settlement', async () => {
      const iterator = channel[Symbol.asyncIterator]();
      const firstPromise = iterator.next();
      channel.enqueue('user-1', createTextUserMessage('first'));
      await firstPromise;

      channel.enqueue('user-2', createTextUserMessage('second'));

      const ids = channel.close();
      expect(ids).toEqual(['user-1', 'user-2']);
      expect(channel.getActiveTurnId()).toBeNull();
      expect(channel.getQueueLength()).toBe(0);
    });
  });
});
