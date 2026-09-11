import { createMockEl } from '@test/helpers/mockElement';

import { AutoTurnProjectionController } from '@/features/chat/controllers/AutoTurnProjectionController';
import { TurnCoordinator } from '@/features/chat/controllers/TurnCoordinator';
import { ChatState } from '@/features/chat/state/ChatState';

describe('AutoTurnProjectionController', () => {
  function setup() {
    const state = new ChatState();
    state.currentConversationId = 'conv-1';
    const processQueuedMessage = jest.fn();
    const finishSpy = jest.fn();
    const turnCoordinator = new TurnCoordinator({
      state,
      getConversationId: () => state.currentConversationId,
      processQueuedMessage,
    });
    const originalFinish = turnCoordinator.finish.bind(turnCoordinator);
    jest.spyOn(turnCoordinator, 'finish').mockImplementation(turnId => {
      finishSpy(turnId);
      return originalFinish(turnId);
    });
    const contentEl = createMockEl('div');
    const addMessage = jest.fn(() => {
      const messageEl = createMockEl('div');
      messageEl.createDiv({ cls: 'claudian-message-content' });
      return messageEl;
    });
    const removeMessage = jest.fn();
    const handleStreamChunk = jest.fn(async (chunk, context) => {
      if (chunk.type === 'text') context.message.content += chunk.content;
      if (chunk.type === 'tool_use') context.message.toolCalls.push({
        id: chunk.id,
        name: chunk.name,
        input: chunk.input,
        status: 'pending',
      });
    });
    const save = jest.fn().mockResolvedValue(undefined);
    const notify = jest.fn();
    const streamController = {
      beginRenderFlushScope: jest.fn(),
      handleStreamChunk,
      showThinkingIndicator: jest.fn(),
      hideThinkingIndicator: jest.fn(),
      finalizeCurrentThinkingBlock: jest.fn().mockResolvedValue(undefined),
      finalizeCurrentTextBlock: jest.fn().mockResolvedValue(undefined),
      resetStreamingState: jest.fn(),
      invalidateRenderFlush: jest.fn(),
    } as any;
    const controller = new AutoTurnProjectionController({
      state,
      renderer: { addMessage, removeMessage } as any,
      streamController,
      conversationController: { save } as any,
      turnCoordinator,
      subagentManager: { resetSpawnedCount: jest.fn() } as any,
      getConversationId: () => state.currentConversationId,
      isTabConnected: () => contentEl.isConnected,
      generateId: (() => { let id = 0; return () => `msg-${++id}`; })(),
      notify,
    });
    Object.defineProperty(contentEl, 'isConnected', { value: true, configurable: true });
    return { controller, state, turnCoordinator, processQueuedMessage, finishSpy, addMessage, removeMessage, streamController, handleStreamChunk, save, notify, contentEl };
  }

  it('shows the sanitized peer source and projects text/tools before result', async () => {
    const { controller, state, handleStreamChunk, save } = setup();
    controller.started({
      turnId: 'auto-1',
      generation: 0,
      source: { kind: 'peer', label: 'researcher' },
      displayContent: 'inspect report',
    });

    expect(state.messages[0]).toEqual(expect.objectContaining({
      role: 'user',
      content: 'inspect report',
      displayContent: 'Peer · researcher\n\ninspect report',
    }));
    expect(state.messages[1]).toEqual(expect.objectContaining({ role: 'assistant', content: '' }));

    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'working' } });
    await controller.chunk({
      turnId: 'auto-1',
      generation: 0,
      chunk: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
    });

    expect(handleStreamChunk).toHaveBeenCalledTimes(2);
    expect(state.messages[1]).toEqual(expect.objectContaining({
      content: 'working',
      toolCalls: [expect.objectContaining({ id: 'tool-1' })],
    }));
    expect(save).not.toHaveBeenCalled();

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: { assistantMessageId: 'assistant-1' } });
    expect(save).toHaveBeenCalledTimes(1);
    expect(state.messages[1].assistantMessageId).toBe('assistant-1');
  });

  it('inserts an embedded peer once before the host assistant without taking an auto lease', async () => {
    const { controller, state, turnCoordinator, addMessage } = setup();
    expect(turnCoordinator.beginUserTurn('host', 1)).toBe(true);
    state.messages = [
      { id: 'host-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'host-assistant', role: 'assistant', content: 'answer', timestamp: 2 },
    ];
    const event = {
      turnId: 'peer-mid', generation: 1, source: { kind: 'peer' as const },
      displayContent: 'peer note', transcriptUserId: 'peer-mid',
    };
    await controller.projectEmbeddedExternal(event);
    await controller.projectEmbeddedExternal(event);
    expect(state.messages.map(message => message.id)).toEqual(['host-user', 'msg-1', 'host-assistant']);
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(turnCoordinator.getActiveTurn()).toEqual(expect.objectContaining({ turnId: 'host', kind: 'user' }));
  });

  it('drops stale chunks after conversation switch', async () => {
    const { controller, state, handleStreamChunk } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    state.currentConversationId = 'conv-2';

    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'stale' } });
    expect(handleStreamChunk).not.toHaveBeenCalled();
  });

  it('cancelled clears the projection context, drops the empty assistant placeholder, and releases the lease', () => {
    const { controller, state, turnCoordinator, removeMessage, streamController } = setup();
    controller.started({
      turnId: 'auto-1',
      generation: 0,
      source: { kind: 'peer', label: 'researcher' },
      displayContent: 'do work',
    });
    expect(state.messages).toHaveLength(2);
    expect(turnCoordinator.isBusy()).toBe(true);
    expect(state.isStreaming).toBe(true);

    // The runtime bumps the turn generation before firing the cancel event.
    controller.cancelled({ turnId: 'auto-1', generation: 1, reason: 'shutdown' });

    expect(streamController.invalidateRenderFlush).toHaveBeenCalled();
    expect(streamController.resetStreamingState).toHaveBeenCalled();
    // The empty assistant placeholder is removed; the peer user bubble stays
    // behind (lenient by design).
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(expect.objectContaining({ role: 'user', content: 'do work' }));
    expect(removeMessage).toHaveBeenCalledWith('msg-2');
    expect(turnCoordinator.isBusy()).toBe(false);
    expect(state.isStreaming).toBe(false);
  });

  it('finished clears the active projection and rejects later chunks', async () => {
    const { controller, handleStreamChunk, save, turnCoordinator } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'working' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: { assistantMessageId: 'assistant-9' } });
    expect(save).toHaveBeenCalledTimes(1);
    expect(turnCoordinator.isBusy()).toBe(false);

    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'late' } });
    expect(handleStreamChunk).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('drops chunks after the tab DOM is detached', async () => {
    const { controller, handleStreamChunk, contentEl } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    Object.defineProperty(contentEl, 'isConnected', { value: false });
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'orphan' } });

    expect(handleStreamChunk).not.toHaveBeenCalled();
  });

  it('finishes and retains the pending-save marker when save rejects', async () => {
    const { controller, state, turnCoordinator, save, notify } = setup();
    save.mockRejectedValueOnce(new Error('disk full'));
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    await expect(controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} })).resolves.toBeUndefined();

    expect(turnCoordinator.isBusy()).toBe(false);
    expect(state.isStreaming).toBe(false);
    expect(state.hasPendingConversationSave).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('times out a never-settling save after five seconds and releases once', async () => {
    jest.useFakeTimers();
    const { controller, state, turnCoordinator, save, notify } = setup();
    save.mockImplementationOnce(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-timeout', generation: 0, source: { kind: 'assistant-continuation' } });
    const finished = controller.finished({ turnId: 'auto-timeout', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(turnCoordinator.isBusy()).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    await finished;
    expect(turnCoordinator.isBusy()).toBe(false);
    expect(state.hasPendingConversationSave).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it.each(['resolve', 'reject'])('ignores a late save %s after timeout settlement', async outcome => {
    jest.useFakeTimers();
    const { controller, state, turnCoordinator, save, notify, finishSpy, processQueuedMessage } = setup();
    let resolveSave!: () => void;
    let rejectSave!: (error: Error) => void;
    save.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      resolveSave = resolve;
      rejectSave = reject;
    }));
    controller.started({ turnId: 'auto-late', generation: 0, source: { kind: 'assistant-continuation' } });
    const finished = controller.finished({ turnId: 'auto-late', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(5_000);
    await finished;
    turnCoordinator.release('auto-late');
    expect(finishSpy).toHaveBeenCalledTimes(1);
    expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);

    if (outcome === 'resolve') resolveSave();
    else rejectSave(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(finishSpy).toHaveBeenCalledTimes(1);
    expect(processQueuedMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(state.hasPendingConversationSave).toBe(true);
    jest.useRealTimers();
  });

  it('finishes without deadlocking when finalization rejects', async () => {
    const { controller, state, turnCoordinator, streamController, notify } = setup();
    streamController.finalizeCurrentThinkingBlock.mockRejectedValueOnce(new Error('render failed'));
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    await expect(controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} })).resolves.toBeUndefined();

    expect(turnCoordinator.isBusy()).toBe(false);
    expect(state.isStreaming).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('replay dedup: hydrate prefix reconciles at block boundaries, identity keys are idempotent', async () => {
    const { controller, state, handleStreamChunk } = setup();
    // Reopened tab with a partially hydrated open turn: the user bubble and
    // the assistant message rendered before the reload are already in state.
    state.messages = [
      {
        id: 'msg-hydrated-user',
        role: 'user',
        content: 'inspect report',
        displayContent: 'Peer · researcher\n\ninspect report',
        timestamp: 1,
        userMessageId: 'peer-u-1',
      },
      {
        id: 'msg-hydrated-assistant',
        role: 'assistant',
        content: 'working',
        timestamp: 2,
        toolCalls: [],
        contentBlocks: [],
      },
    ];

    controller.started({
      turnId: 'peer-u-1',
      generation: 0,
      source: { kind: 'peer', label: 'researcher' },
      displayContent: 'inspect report',
      transcriptUserId: 'peer-u-1',
      replay: true,
    });
    // The hydrated user bubble and assistant message are reused, not duplicated.
    expect(state.messages).toHaveLength(2);

    // Hydrated prefix block: aligned, skipped without re-rendering.
    await controller.chunk({
      turnId: 'peer-u-1',
      generation: 0,
      replay: true,
      transcriptIdentity: 'a1:text:0',
      chunk: { type: 'text', content: 'working' },
    });
    expect(handleStreamChunk).not.toHaveBeenCalled();
    expect(state.messages[1].content).toBe('working');

    // New block whose text happens to be a substring of hydrated content:
    // must NOT be skipped (the old includes() match dropped it).
    await controller.chunk({
      turnId: 'peer-u-1',
      generation: 0,
      replay: true,
      transcriptIdentity: 'a2:text:0',
      chunk: { type: 'text', content: 'work' },
    });
    expect(handleStreamChunk).toHaveBeenCalledTimes(1);
    expect(state.messages[1].content).toBe('workingwork');

    // Same transcript identity delivered again: idempotent skip.
    await controller.chunk({
      turnId: 'peer-u-1',
      generation: 0,
      replay: true,
      transcriptIdentity: 'a2:text:0',
      chunk: { type: 'text', content: 'work' },
    });
    expect(handleStreamChunk).toHaveBeenCalledTimes(1);
    expect(state.messages[1].content).toBe('workingwork');

    // Tool chunks reconcile by tool id and stay idempotent by identity.
    await controller.chunk({
      turnId: 'peer-u-1',
      generation: 0,
      replay: true,
      transcriptIdentity: 'tool:t1:tool_use',
      chunk: { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    });
    expect(handleStreamChunk).toHaveBeenCalledTimes(2);
    await controller.chunk({
      turnId: 'peer-u-1',
      generation: 0,
      replay: true,
      transcriptIdentity: 'tool:t1:tool_use',
      chunk: { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    });
    expect(handleStreamChunk).toHaveBeenCalledTimes(2);
    expect(state.messages[1].toolCalls).toEqual([
      expect.objectContaining({ id: 't1', name: 'Read' }),
    ]);
  });
});
