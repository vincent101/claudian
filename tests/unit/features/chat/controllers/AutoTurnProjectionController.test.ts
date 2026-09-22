import { createMockEl } from '@test/helpers/mockElement';

import { AutoTurnProjectionController } from '@/features/chat/controllers/AutoTurnProjectionController';
import { TurnCoordinator } from '@/features/chat/controllers/TurnCoordinator';
import { ProjectionWriteCoordinator } from '@/features/chat/rendering/ProjectionWriteCoordinator';
import { ChatState } from '@/features/chat/state/ChatState';
import { t } from '@/i18n/i18n';

describe('AutoTurnProjectionController', () => {
  function setup(options: { coordinator?: ProjectionWriteCoordinator; windowed?: boolean } = {}) {
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
    const setMessagesEl = jest.fn();
    const renderMessages = jest.fn().mockReturnValue(createMockEl());
    const waitForRenderedMessages = jest.fn().mockResolvedValue(undefined);
    const refreshActionButtons = jest.fn();
    const setWelcomeEl = jest.fn();
    const rebuildMountedPages = jest.fn();
    const beginLivePage = jest.fn().mockReturnValue(null);
    const freezeLivePage = jest.fn();
    const getRoot = jest.fn().mockReturnValue(createMockEl());
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
    const onTurnCompleted = jest.fn();
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
      renderer: { addMessage, removeMessage, setMessagesEl, renderMessages, waitForRenderedMessages, refreshActionButtons, domEpoch: 0 } as any,
      streamController,
      conversationController: { save } as any,
      turnCoordinator,
      subagentManager: { resetSpawnedCount: jest.fn() } as any,
      getConversationId: () => state.currentConversationId,
      isTabConnected: () => contentEl.isConnected,
      generateId: (() => { let id = 0; return () => `msg-${++id}`; })(),
      notify,
      ...(options.coordinator ? { getProjectionCoordinator: () => options.coordinator! } : {}),
      ...(options.windowed ? { getHistoryWindowRenderer: () => ({ rebuildMountedPages, beginLivePage, freezeLivePage, getRoot }) as any } : {}),
      setWelcomeEl,
      onTurnCompleted,
    });
    Object.defineProperty(contentEl, 'isConnected', { value: true, configurable: true });
    return {
      controller, state, turnCoordinator, processQueuedMessage, finishSpy,
      addMessage, removeMessage, renderMessages, waitForRenderedMessages, setWelcomeEl, rebuildMountedPages, refreshActionButtons,
      streamController, handleStreamChunk, save, notify, onTurnCompleted, contentEl,
    };
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

  it('finished re-evaluates rewind buttons on the user message preceding the auto turn', async () => {
    const { controller, state, refreshActionButtons } = setup();
    state.messages = [
      { id: 'host-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'host-assistant', role: 'assistant', content: 'answer', timestamp: 2 },
    ];
    controller.started({
      turnId: 'auto-1',
      generation: 0,
      source: { kind: 'peer', label: 'researcher' },
      displayContent: 'inspect report',
    });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    expect(refreshActionButtons).toHaveBeenCalledWith(state.messages[0], state.messages, 0);
  });

  it('finished skips the rewind re-evaluation when no user message precedes the auto turn', async () => {
    const { controller, refreshActionButtons } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    expect(refreshActionButtons).not.toHaveBeenCalled();
  });

  it('finished re-evaluates rewind buttons from the assistant position when the auto turn has no user row', async () => {
    const { controller, state, refreshActionButtons } = setup();
    state.messages = [
      { id: 'host-user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'host-assistant', role: 'assistant', content: 'answer', timestamp: 2 },
    ];
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    expect(refreshActionButtons).toHaveBeenCalledWith(state.messages[0], state.messages, 0);
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
    expect(notify).toHaveBeenCalledWith('Background response is visible but could not be saved. It will retry on the next conversation save.');
  });

  it('shows no notice when the save settles within the timeout', async () => {
    const { controller, save, notify } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    expect(save).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('times out a never-settling save after thirty seconds and releases once', async () => {
    jest.useFakeTimers();
    const { controller, state, turnCoordinator, save, notify } = setup();
    save.mockImplementationOnce(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-timeout', generation: 0, source: { kind: 'assistant-continuation' } });
    const finished = controller.finished({ turnId: 'auto-timeout', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(29_999);
    expect(turnCoordinator.isBusy()).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    await finished;
    expect(turnCoordinator.isBusy()).toBe(false);
    expect(state.hasPendingConversationSave).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(t('chat.save.timeoutNotice'));
    jest.useRealTimers();
  });

  it('notifies once across repeated save timeouts in the same conversation', async () => {
    jest.useFakeTimers();
    const { controller, save, notify } = setup();
    save.mockImplementation(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    const first = controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(30_000);
    await first;
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(t('chat.save.timeoutNotice'));

    controller.started({ turnId: 'auto-2', generation: 0, source: { kind: 'assistant-continuation' } });
    const second = controller.finished({ turnId: 'auto-2', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(30_000);
    await second;
    expect(notify).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('re-arms the save-timeout notice after a successful save', async () => {
    jest.useFakeTimers();
    const { controller, save, notify } = setup();
    save.mockImplementation(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    const first = controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(30_000);
    await first;
    expect(notify).toHaveBeenCalledTimes(1);

    save.mockImplementationOnce(jest.fn().mockResolvedValue(undefined));
    controller.started({ turnId: 'auto-2', generation: 0, source: { kind: 'assistant-continuation' } });
    await controller.finished({ turnId: 'auto-2', generation: 0, metadata: {} });
    expect(notify).toHaveBeenCalledTimes(1);

    controller.started({ turnId: 'auto-3', generation: 0, source: { kind: 'assistant-continuation' } });
    const third = controller.finished({ turnId: 'auto-3', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(30_000);
    await third;
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(t('chat.save.timeoutNotice'));
    jest.useRealTimers();
  });

  it('re-arms the save-timeout notice when a timed-out save settles successfully later', async () => {
    jest.useFakeTimers();
    const { controller, save, notify } = setup();
    let resolveFirstSave!: () => void;
    save.mockImplementationOnce(() => new Promise<void>(resolve => { resolveFirstSave = resolve; }));
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    const first = controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(30_000);
    await first;
    expect(notify).toHaveBeenCalledTimes(1);

    resolveFirstSave();
    await jest.advanceTimersByTimeAsync(0);

    save.mockImplementationOnce(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-2', generation: 0, source: { kind: 'assistant-continuation' } });
    const second = controller.finished({ turnId: 'auto-2', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(30_000);
    await second;
    expect(notify).toHaveBeenCalledTimes(2);
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
    await jest.advanceTimersByTimeAsync(30_000);
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

  it('times out a never-settling chunk and invalidates the render flush', async () => {
    jest.useFakeTimers();
    const { controller, turnCoordinator, streamController, handleStreamChunk } = setup();
    handleStreamChunk.mockImplementationOnce(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-chunk-timeout', generation: 0, source: { kind: 'assistant-continuation' } });
    const chunk = controller.chunk({ turnId: 'auto-chunk-timeout', generation: 0, chunk: { type: 'text', content: 'stuck' } });
    const rejected = expect(chunk).rejects.toThrow('chunk_timeout'); // eslint-disable-line jest/valid-expect
    await jest.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(streamController.invalidateRenderFlush).toHaveBeenCalled();
    expect(turnCoordinator.isBusy()).toBe(false);
    jest.useRealTimers();
  });

  it('times out never-settling finalization after three seconds and releases', async () => {
    jest.useFakeTimers();
    const { controller, turnCoordinator, streamController } = setup();
    streamController.finalizeCurrentThinkingBlock.mockImplementationOnce(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-finalize-timeout', generation: 0, source: { kind: 'assistant-continuation' } });
    const finished = controller.finished({ turnId: 'auto-finalize-timeout', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(3_000);
    await finished;
    expect(streamController.invalidateRenderFlush).toHaveBeenCalled();
    expect(turnCoordinator.isBusy()).toBe(false);
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

  // ============================================
  // Projection write lease (coord protocol P1/P2/P5)
  // ============================================

  it('holds the auto-turn mount behind an in-flight stored transaction and replays buffered chunks', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const { controller, state, addMessage, handleStreamChunk, turnCoordinator } = setup({ coordinator });
    let releaseStored!: () => void;
    const stored = coordinator.runStored(
      () => false,
      () => new Promise<void>(resolve => { releaseStored = resolve; }),
    );
    await Promise.resolve();

    expect(controller.started({
      turnId: 'auto-1', generation: 0,
      source: { kind: 'peer', label: 'researcher' },
      displayContent: 'inspect report',
    })).toBe(true);

    // Domain truth lands immediately; the DOM pair waits for the live lease
    // so it can neither interleave with the stored rebuild nor be cleared by it.
    expect(state.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(addMessage).not.toHaveBeenCalled();

    // Chunks that arrive pre-mount buffer raw instead of projecting domain-only.
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'early' } });
    expect(handleStreamChunk).not.toHaveBeenCalled();

    releaseStored();
    await stored;
    await (controller as any).active.mountTask;

    expect(addMessage).toHaveBeenCalledTimes(2);
    expect(handleStreamChunk).toHaveBeenCalledWith(
      { type: 'text', content: 'early' },
      expect.objectContaining({ turnId: 'auto-1' }),
    );
    expect(state.messages[1].content).toBe('early');
    expect(turnCoordinator.isBusy()).toBe(true);
  });

  it('waits for a deferred mount at finish and replays buffered chunks before finalizing', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const { controller, state, handleStreamChunk, save } = setup({ coordinator });
    let releaseStored!: () => void;
    const stored = coordinator.runStored(
      () => false,
      () => new Promise<void>(resolve => { releaseStored = resolve; }),
    );
    await Promise.resolve();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'early' } });

    const finished = controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    await Promise.resolve();
    await Promise.resolve();
    expect(handleStreamChunk).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    releaseStored();
    await stored;
    await finished;

    expect(handleStreamChunk).toHaveBeenCalledWith(
      { type: 'text', content: 'early' },
      expect.objectContaining({ turnId: 'auto-1' }),
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(state.messages[0].content).toBe('early');
  });

  it('re-projects a projection-dirty auto turn from ChatState at finish', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const { controller, state, renderMessages, waitForRenderedMessages, setWelcomeEl, turnCoordinator } = setup({ coordinator });
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'peer', label: 'researcher' }, displayContent: 'inspect' });
    await (controller as any).active.mountTask;
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'work' } });
    // A stored clear-rebuild evicted the mount mid-turn (P4 flags the context).
    (controller as any).active.context.projectionDirty = true;

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    // P5: the streamed output becomes visible again through a full re-render
    // from the latest ChatState, run as a stored transaction after the live
    // lease was released (lock order: live released before stored is queued).
    expect(renderMessages).toHaveBeenCalledTimes(1);
    expect(renderMessages).toHaveBeenCalledWith(state.messages, expect.any(Function));
    expect(waitForRenderedMessages).toHaveBeenCalled();
    expect(setWelcomeEl).toHaveBeenCalledTimes(1);
    expect(turnCoordinator.isBusy()).toBe(false);
  });

  it('rebuilds mounted pages instead of full-rendering a dirty indexed auto turn', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const { controller, rebuildMountedPages, renderMessages } = setup({ coordinator, windowed: true });
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'peer', label: 'researcher' }, displayContent: 'inspect' });
    await (controller as any).active.mountTask;
    (controller as any).active.context.projectionDirty = true;
    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    expect(rebuildMountedPages).toHaveBeenCalledTimes(1);
    expect(renderMessages).not.toHaveBeenCalled();
  });

  it('does not re-project a clean auto turn at finish', async () => {
    const { controller, renderMessages } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'work' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    expect(renderMessages).not.toHaveBeenCalled();
  });

  it('drops the deferred mount and buffered chunks when the turn is cancelled', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const { controller, state, handleStreamChunk, turnCoordinator } = setup({ coordinator });
    let releaseStored!: () => void;
    const stored = coordinator.runStored(
      () => false,
      () => new Promise<void>(resolve => { releaseStored = resolve; }),
    );
    await Promise.resolve();
    controller.started({
      turnId: 'auto-1', generation: 0,
      source: { kind: 'peer', label: 'researcher' },
      displayContent: 'do work',
    });
    const mountTask = (controller as any).active.mountTask as Promise<void>;
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'early' } });

    // The runtime bumps the turn generation before firing the cancel event.
    controller.cancelled({ turnId: 'auto-1', generation: 1, reason: 'shutdown' });
    releaseStored();
    await stored;
    await mountTask;
    await Promise.resolve();
    await Promise.resolve();

    // The cancelled mount never mounts; buffered chunks never project; the
    // empty assistant placeholder is dropped and the user bubble stays.
    expect(handleStreamChunk).not.toHaveBeenCalled();
    expect(turnCoordinator.isBusy()).toBe(false);
    expect(state.messages.map(message => message.role)).toEqual(['user']);
  });

  // ============================================
  // Turn completion notification
  // ============================================

  it('emits one completion event when finish settles cleanly without a re-projection', async () => {
    const { controller, onTurnCompleted } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'work' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
    expect(onTurnCompleted).toHaveBeenCalledWith({ turnId: 'auto-1', kind: 'auto', outcome: 'completed' });
  });

  it('suppresses only the completion event for a delayed terminal superseded by a host row', async () => {
    const { controller, onTurnCompleted, save, turnCoordinator } = setup();
    controller.started({ turnId: 'auto-old', generation: 0, source: { kind: 'assistant-continuation' } });
    await controller.chunk({ turnId: 'auto-old', generation: 0, chunk: { type: 'text', content: 'work' } });

    await controller.finished({
      turnId: 'auto-old',
      generation: 0,
      metadata: {},
      terminalOffset: 10,
      supersededByHostUser: true,
    });

    expect(onTurnCompleted).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
    expect(turnCoordinator.isBusy()).toBe(false);
  });

  it('emits one completion event when a dirty turn re-projects successfully', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const { controller, onTurnCompleted } = setup({ coordinator });
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'peer', label: 'researcher' }, displayContent: 'inspect' });
    await (controller as any).active.mountTask;
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'work' } });
    (controller as any).active.context.projectionDirty = true;

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not emit when the re-projection fails', async () => {
    const { controller, onTurnCompleted, renderMessages } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'work' } });
    (controller as any).active.context.projectionDirty = true;
    renderMessages.mockImplementation(() => { throw new Error('render failed'); });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    expect(onTurnCompleted).not.toHaveBeenCalled();
  });

  it('does not emit when the turn went stale before the re-projection', async () => {
    const { controller, onTurnCompleted, state, save } = setup();
    let releaseSave!: () => void;
    save.mockImplementationOnce(() => new Promise<void>(resolve => { releaseSave = resolve; }));
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'work' } });
    (controller as any).active.context.projectionDirty = true;

    const finished = controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    // A conversation switch mid-save stales the turn before the boundary
    // re-projection runs.
    state.currentConversationId = 'conv-2';
    releaseSave();
    await finished;

    expect(onTurnCompleted).not.toHaveBeenCalled();
  });

  it('does not emit when the dirty re-projection stored wait resolves null', async () => {
    const coordinator = new ProjectionWriteCoordinator();
    const { controller, onTurnCompleted, state, renderMessages } = setup({ coordinator });
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });
    await (controller as any).active.mountTask;
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'work' } });
    (controller as any).active.context.projectionDirty = true;

    // Hold a stored transaction so the boundary re-projection queues behind
    // it in the coordinator FIFO instead of running immediately.
    let releaseStored!: () => void;
    const stored = coordinator.runStored(
      () => false,
      () => new Promise<void>(resolve => { releaseStored = resolve; }),
    );
    await Promise.resolve();

    const finished = controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    // The turn goes stale only after the re-projection queued its stored
    // wait: the wait resolves null (cancelled at grant time) — the
    // re-projection must not run and the turn must not be reported.
    state.currentConversationId = 'conv-2';
    releaseStored();
    await stored;
    await finished;

    expect(renderMessages).not.toHaveBeenCalled();
    expect(onTurnCompleted).not.toHaveBeenCalled();
  });

  it('does not emit for cancelled turns', () => {
    const { controller, onTurnCompleted } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    controller.cancelled({ turnId: 'auto-1', generation: 1, reason: 'shutdown' });

    expect(onTurnCompleted).not.toHaveBeenCalled();
  });

  it('does not emit when the observer cancels the turn as interrupted', async () => {
    const { controller, onTurnCompleted } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'peer', label: 'researcher' }, displayContent: 'work' });
    await controller.chunk({ turnId: 'auto-1', generation: 0, chunk: { type: 'text', content: 'partial' } });

    // Observer stop / transcript replacement: the runtime bumps the turn
    // generation and flags the cancel as interrupted — no end marker will
    // ever follow, so the turn must never be reported as completed.
    controller.cancelled({ turnId: 'auto-1', generation: 1, reason: 'observer_stopped', interrupted: true });

    expect(onTurnCompleted).not.toHaveBeenCalled();
  });

  it('does not emit when finalization rejects', async () => {
    const { controller, onTurnCompleted, streamController } = setup();
    streamController.finalizeCurrentThinkingBlock.mockRejectedValueOnce(new Error('render failed'));
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    expect(onTurnCompleted).not.toHaveBeenCalled();
  });

  it('does not emit when finalization times out', async () => {
    jest.useFakeTimers();
    const { controller, onTurnCompleted, streamController } = setup();
    streamController.finalizeCurrentThinkingBlock.mockImplementationOnce(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-finalize-timeout', generation: 0, source: { kind: 'assistant-continuation' } });
    const finished = controller.finished({ turnId: 'auto-finalize-timeout', generation: 0, metadata: {} });
    await jest.advanceTimersByTimeAsync(3_000);
    await finished;

    expect(onTurnCompleted).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('does not emit when a chunk timeout aborts the turn', async () => {
    jest.useFakeTimers();
    const { controller, onTurnCompleted, handleStreamChunk } = setup();
    handleStreamChunk.mockImplementationOnce(() => new Promise(() => {}));
    controller.started({ turnId: 'auto-chunk-timeout', generation: 0, source: { kind: 'assistant-continuation' } });
    const chunk = controller.chunk({ turnId: 'auto-chunk-timeout', generation: 0, chunk: { type: 'text', content: 'stuck' } });
    const rejected = expect(chunk).rejects.toThrow('chunk_timeout'); // eslint-disable-line jest/valid-expect
    await jest.advanceTimersByTimeAsync(1_000);
    await rejected;

    expect(onTurnCompleted).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('emits at most once for duplicate finished callbacks of the same turn', async () => {
    const { controller, onTurnCompleted } = setup();
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });
    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
  });

  it('still emits when the save fails after a successful projection', async () => {
    const { controller, onTurnCompleted, save } = setup();
    save.mockRejectedValueOnce(new Error('disk full'));
    controller.started({ turnId: 'auto-1', generation: 0, source: { kind: 'assistant-continuation' } });

    await controller.finished({ turnId: 'auto-1', generation: 0, metadata: {} });

    // Save failure leaves the reply visible — the existing "visible but not
    // saved" Notice stays independent of the completion event.
    expect(onTurnCompleted).toHaveBeenCalledTimes(1);
  });
});
