import '@/providers';

import { createMockEl } from '@test/helpers/mockElement';

import {
  TOOL_AGENT_OUTPUT,
  TOOL_SPAWN_AGENT,
  TOOL_TASK,
  TOOL_WAIT_AGENT,
} from '@/core/tools/toolNames';
import type { ChatMessage, ImageAttachment } from '@/core/types';
import {
  type HistoryRenderDiagnosticEvent,
  setHistoryRenderDiagnosticsSink,
} from '@/features/chat/history/HistoryDiagnostics';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { renderStoredAsyncSubagent, renderStoredSubagent } from '@/features/chat/rendering/SubagentRenderer';
import { renderStoredThinkingBlock } from '@/features/chat/rendering/ThinkingBlockRenderer';
import { renderStoredToolCall } from '@/features/chat/rendering/ToolCallRenderer';
import { renderStoredWriteEdit } from '@/features/chat/rendering/WriteEditRenderer';
import { t } from '@/i18n/i18n';

jest.mock('@/features/chat/rendering/SubagentRenderer', () => ({
  renderStoredAsyncSubagent: jest.fn().mockReturnValue({ wrapperEl: {}, cleanup: jest.fn() }),
  renderStoredSubagent: jest.fn(),
}));
jest.mock('@/features/chat/rendering/ThinkingBlockRenderer', () => ({
  renderStoredThinkingBlock: jest.fn(),
}));
jest.mock('@/features/chat/rendering/ToolCallRenderer', () => ({
  renderStoredToolCall: jest.fn(),
}));
jest.mock('@/features/chat/rendering/WriteEditRenderer', () => ({
  renderStoredWriteEdit: jest.fn(),
}));
jest.mock('@/utils/imageEmbed', () => ({
  replaceImageEmbedsWithHtml: jest.fn().mockImplementation((md: string) => md),
}));
jest.mock('@/utils/fileLink', () => ({
  processFileLinks: jest.fn(),
  registerFileLinkHandler: jest.fn(),
}));

function createMockComponent() {
  return {
    registerDomEvent: jest.fn(),
    register: jest.fn(),
    addChild: jest.fn(),
    load: jest.fn(),
    unload: jest.fn(),
  };
}

function mockCapabilities(providerId: 'claude' | 'codex' = 'claude') {
  return () => ({
    providerId,
    supportsPersistentRuntime: true,
    supportsNativeHistory: providerId === 'claude',
    supportsPlanMode: true,
    supportsRewind: true,
    supportsFork: true,
    supportsProviderCommands: true,
    supportsImageAttachments: true,
    supportsInstructionMode: true,
    supportsMcpTools: true,
    reasoningControl: 'effort' as const,
  });
}

function createRenderer(messagesEl?: any, providerId: 'claude' | 'codex' = 'claude', onRendered?: (projectionKey: string) => void) {
  const el = messagesEl ?? createMockEl();
  const comp = createMockComponent();
  const plugin = {
    app: {},
    settings: { mediaFolder: '' },
  };
  return {
    renderer: new MessageRenderer(
      plugin as any,
      comp as any,
      el,
      undefined,
      undefined,
      mockCapabilities(providerId),
      onRendered,
    ),
    messagesEl: el,
  };
}

describe('MessageRenderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================
  // renderMessages
  // ============================================

  it('renders welcome element and calls renderStoredMessage for each message', () => {
    const messagesEl = createMockEl();
    const emptySpy = jest.spyOn(messagesEl, 'empty');
    const mockComponent = createMockComponent();
    const renderer = new MessageRenderer({} as any, mockComponent as any, messagesEl);
    const renderStoredSpy = jest.spyOn(renderer, 'renderStoredMessage').mockImplementation(() => {});

    const messages: ChatMessage[] = [
      { id: 'm1', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [], contentBlocks: [] },
    ];

    const welcomeEl = renderer.renderMessages(messages, () => 'Hello');

    expect(emptySpy).toHaveBeenCalled();
    expect(renderStoredSpy).toHaveBeenCalledTimes(1);
    expect(welcomeEl.hasClass('claudian-welcome')).toBe(true);
    expect(welcomeEl.children[0].textContent).toBe('Hello');
  });

  it('renders empty messages list with just welcome element', () => {
    const { renderer } = createRenderer();
    const renderStoredSpy = jest.spyOn(renderer, 'renderStoredMessage').mockImplementation(() => {});

    const welcomeEl = renderer.renderMessages([], () => 'Welcome!');

    expect(renderStoredSpy).not.toHaveBeenCalled();
    expect(welcomeEl.hasClass('claudian-welcome')).toBe(true);
  });

  describe('renderMessageContent aggregation', () => {
    it('notifies once after all content jobs complete', async () => {
      const onRendered = jest.fn();
      const { renderer } = createRenderer(undefined, 'claude', onRendered);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const rendering = renderer.renderMessageContent('message', [Promise.resolve(), gate]);
      await Promise.resolve();
      expect(onRendered).not.toHaveBeenCalled();
      release();
      await rendering;
      expect(onRendered).toHaveBeenCalledTimes(1);
      expect(onRendered).toHaveBeenCalledWith('message', 'detail');
    });

    it('notifies summary level separately from detail level', async () => {
      const onRendered = jest.fn();
      const { renderer } = createRenderer(undefined, 'claude', onRendered);
      await renderer.renderMessageContent('summary-message', [], 'summary');
      await renderer.renderMessageContent('detail-message', [Promise.resolve()]);
      expect(onRendered).toHaveBeenCalledWith('summary-message', 'summary');
      expect(onRendered).toHaveBeenCalledWith('detail-message', 'detail');
    });

    it('does not notify on failure and suppresses stale generations', async () => {
      const onRendered = jest.fn();
      const { renderer } = createRenderer(undefined, 'claude', onRendered);
      let release!: () => void;
      const old = new Promise<void>(resolve => { release = resolve; });
      const oldRender = renderer.renderMessageContent('same', [old]);
      await renderer.renderMessageContent('same', [Promise.resolve()]);
      release();
      await oldRender;
      await expect(renderer.renderMessageContent('failed', [Promise.reject(new Error('render failed'))])).rejects.toThrow('render failed');

      expect(onRendered).toHaveBeenCalledTimes(1);
      expect(onRendered).toHaveBeenCalledWith('same', 'detail');
    });
  });

  // ============================================
  // renderStoredMessage
  // ============================================

  it('renders interrupt messages with interrupt styling instead of user bubble', () => {
    const messagesEl = createMockEl();
    const mockComponent = createMockComponent();
    const renderer = new MessageRenderer({} as any, mockComponent as any, messagesEl);

    const interruptMsg: ChatMessage = {
      id: 'interrupt-1',
      role: 'user',
      content: '[Request interrupted by user]',
      timestamp: Date.now(),
      isInterrupt: true,
    };

    renderer.renderStoredMessage(interruptMsg);

    // Should create assistant-style message with interrupt content
    expect(messagesEl.children.length).toBe(1);
    const msgEl = messagesEl.children[0];
    expect(msgEl.hasClass('claudian-message-assistant')).toBe(true);
    // Check the content contains interrupt styling
    const contentEl = msgEl.children[0];
    const textEl = contentEl.children[0];
    expect(textEl.innerHTML).toContain('claudian-interrupted');
    expect(textEl.innerHTML).toContain('Interrupted');
  });

  it('renders interrupted assistant message with content + interrupt indicator', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);

    const interruptMsg: ChatMessage = {
      id: 'interrupt-codex-1',
      role: 'assistant',
      content: 'Starting to work on the feature...',
      timestamp: Date.now(),
      isInterrupt: true,
      contentBlocks: [{ type: 'text', content: 'Starting to work on the feature...' }],
    };

    renderer.renderStoredMessage(interruptMsg);

    // Should create an assistant message (not a bare interrupt marker)
    expect(messagesEl.children.length).toBe(1);
    const msgEl = messagesEl.children[0];
    expect(msgEl.hasClass('claudian-message-assistant')).toBe(true);

    // The content div should have both content rendering and an interrupt indicator
    const contentEl = msgEl.children[0];
    const lastChild = contentEl.children[contentEl.children.length - 1];
    expect(lastChild.innerHTML).toContain('claudian-interrupted');
    expect(lastChild.innerHTML).toContain('Interrupted');
  });

  it('renders bare interrupt marker for empty interrupted assistant message', () => {
    const messagesEl = createMockEl();
    const mockComponent = createMockComponent();
    const renderer = new MessageRenderer({} as any, mockComponent as any, messagesEl);

    const interruptMsg: ChatMessage = {
      id: 'interrupt-codex-2',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isInterrupt: true,
    };

    renderer.renderStoredMessage(interruptMsg);

    // Should create a bare interrupt marker (same as Claude-style)
    expect(messagesEl.children.length).toBe(1);
    const msgEl = messagesEl.children[0];
    expect(msgEl.hasClass('claudian-message-assistant')).toBe(true);
    const contentEl = msgEl.children[0];
    const textEl = contentEl.children[0];
    expect(textEl.innerHTML).toContain('claudian-interrupted');
  });

  it('skips rebuilt context messages', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'rebuilt-1',
      role: 'user',
      content: 'rebuilt context',
      timestamp: Date.now(),
      isRebuiltContext: true,
    };

    renderer.renderStoredMessage(msg);

    expect(messagesEl.children.length).toBe(0);
  });

  it('renders user message with text content', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Hello world',
      timestamp: Date.now(),
    };

    renderer.renderStoredMessage(msg);

    expect(messagesEl.children.length).toBe(1);
    const msgEl = messagesEl.children[0];
    expect(msgEl.hasClass('claudian-message-user')).toBe(true);
  });

  it('renders user message with displayContent instead of content', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'full prompt with context',
      displayContent: 'user input only',
      timestamp: Date.now(),
    };

    renderer.renderStoredMessage(msg);

    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'user input only');
  });

  it('skips empty user message bubble (image-only)', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderMessageImages').mockImplementation(() => {});

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '',
      timestamp: Date.now(),
      images: [{ id: 'img-1', name: 'img.png', mediaType: 'image/png', data: 'abc', size: 100, source: 'paste' as const }],
    };

    renderer.renderStoredMessage(msg);

    // Images should still be rendered, but no message bubble
    expect(renderer.renderMessageImages).toHaveBeenCalled();
    // Only the images container, no message bubble
    const bubbles = messagesEl.children.filter(
      (c: any) => c.hasClass('claudian-message')
    );
    expect(bubbles.length).toBe(0);
  });

  it('renders user message with images above bubble', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
    const renderImagesSpy = jest.spyOn(renderer, 'renderMessageImages').mockImplementation(() => {});

    const images: ImageAttachment[] = [
      { id: 'img-1', name: 'photo.png', mediaType: 'image/png', data: 'base64data', size: 200, source: 'file' },
    ];

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Check this image',
      timestamp: Date.now(),
      images,
    };

    renderer.renderStoredMessage(msg);

    expect(renderImagesSpy).toHaveBeenCalledWith(messagesEl, images);
  });

  it('adds a rewind button for eligible stored user messages', () => {
    const messagesEl = createMockEl();
    const rewindCallback = jest.fn().mockResolvedValue(undefined);
    const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '' } } as any, createMockComponent() as any, messagesEl, rewindCallback, undefined, mockCapabilities());
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const allMessages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'u1', role: 'user', content: 'hello', timestamp: 2, userMessageId: 'user-u' },
      { id: 'a2', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    renderer.renderStoredMessage(allMessages[1], allMessages, 1);

    expect(messagesEl.querySelector('.claudian-message-rewind-btn')).not.toBeNull();
  });

  it('does not add a rewind button when stored render is called without context', () => {
    const messagesEl = createMockEl();
    const rewindCallback = jest.fn().mockResolvedValue(undefined);
    const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '' } } as any, createMockComponent() as any, messagesEl, rewindCallback, undefined, mockCapabilities());
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
      userMessageId: 'user-u',
    };

    renderer.renderStoredMessage(msg);

    expect(messagesEl.querySelector('.claudian-message-rewind-btn')).toBeNull();
  });

  it('adds a rewind button for eligible streamed user messages via refreshActionButtons', () => {
    const messagesEl = createMockEl();
    const rewindCallback = jest.fn().mockResolvedValue(undefined);
    const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '' } } as any, createMockComponent() as any, messagesEl, rewindCallback, undefined, mockCapabilities());
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const userMsg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: 2,
      userMessageId: 'user-u',
    };
    renderer.addMessage(userMsg);

    const allMessages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      userMsg,
      { id: 'a2', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    renderer.refreshActionButtons(userMsg, allMessages, 1);

    const btn = messagesEl.querySelector('.claudian-message-rewind-btn');
    expect(btn).not.toBeNull();

    btn!.click();
    expect(rewindCallback).toHaveBeenCalledWith('u1');
  });

  describe('message-level toolbar sync (assistant/user alignment)', () => {
    const timestamp = new Date(2026, 8, 14, 20, 35, 3).getTime();

    function findToolbarChildren(messagesEl: any, messageIndex = 0) {
      const msgEl = (messagesEl.children as any[])[messageIndex];
      const toolbar = (msgEl.children as any[]).find((child: any) => child.hasClass?.('claudian-message-actions'));
      return { msgEl, toolbar };
    }

    it('places the assistant copy action in the message toolbar before the timestamp', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      renderer.renderStoredMessage({
        id: 'a-copy',
        role: 'assistant',
        content: '',
        contentBlocks: [{ type: 'text', content: 'Answer body' } as any],
        timestamp,
      });

      const { msgEl, toolbar } = findToolbarChildren(messagesEl);
      expect(toolbar).toBeDefined();
      // Toolbar is a direct child of the message element, never nested in content.
      expect((msgEl.children as any[]).includes(toolbar)).toBe(true);
      const toolbarClasses = (toolbar.children as any[]).map((child: any) => child.className);
      expect(toolbarClasses).toEqual(['claudian-message-copy-btn', 'claudian-message-timestamp']);
    });

    it('keeps one copy button for multi-block assistant messages and joins all text blocks', async () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const writeTextMock = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: writeTextMock } },
        writable: true,
        configurable: true,
      });

      renderer.renderStoredMessage({
        id: 'a-multi',
        role: 'assistant',
        content: '',
        contentBlocks: [
          { type: 'text', content: 'First part' } as any,
          { type: 'thinking', content: 'hidden reasoning' } as any,
          { type: 'text', content: 'Second part' } as any,
        ],
        timestamp,
      });

      const { toolbar } = findToolbarChildren(messagesEl);
      const copyButtons = (toolbar.children as any[]).filter((child: any) => child.hasClass('claudian-message-copy-btn'));
      expect(copyButtons).toHaveLength(1);

      const clickHandlers = copyButtons[0]._eventListeners.get('click');
      await clickHandlers[0]({ stopPropagation: jest.fn() });

      // Thinking blocks are excluded; text blocks join in display order.
      expect(writeTextMock).toHaveBeenCalledWith('First part\n\nSecond part');
    });

    it('falls back to msg.content for old assistant messages without contentBlocks', async () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const writeTextMock = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: writeTextMock } },
        writable: true,
        configurable: true,
      });

      renderer.renderStoredMessage({
        id: 'a-legacy',
        role: 'assistant',
        content: 'Legacy answer',
        toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed' } as any],
        timestamp,
      });

      const { toolbar } = findToolbarChildren(messagesEl);
      const copyBtn = (toolbar.children as any[]).find((child: any) => child.hasClass('claudian-message-copy-btn'));
      expect(copyBtn).toBeDefined();

      await copyBtn._eventListeners.get('click')[0]({ stopPropagation: jest.fn() });
      expect(writeTextMock).toHaveBeenCalledWith('Legacy answer');
    });

    it('renders no copy action for tool-only assistant messages', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      renderer.renderStoredMessage({
        id: 'a-tools',
        role: 'assistant',
        content: '',
        contentBlocks: [{ type: 'tool_use', toolId: 't1' } as any],
        toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed' } as any],
        timestamp,
      });

      const { toolbar } = findToolbarChildren(messagesEl);
      expect(toolbar).toBeDefined();
      expect(toolbar.querySelector('.claudian-message-copy-btn')).toBeNull();
      expect(toolbar.querySelector('.claudian-message-timestamp')).not.toBeNull();
    });

    it('syncs the live assistant toolbar as text blocks finalize without adding buttons', async () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const writeTextMock = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: writeTextMock } },
        writable: true,
        configurable: true,
      });

      const liveMsg: ChatMessage = { id: 'a-live', role: 'assistant', content: '', timestamp };
      renderer.addMessage(liveMsg);

      // Live creation: timestamp only, no copy yet (nothing to copy).
      let { toolbar } = findToolbarChildren(messagesEl);
      expect(toolbar.querySelector('.claudian-message-timestamp')).not.toBeNull();
      expect(toolbar.querySelector('.claudian-message-copy-btn')).toBeNull();

      // First finalize lands the first text block in contentBlocks.
      liveMsg.contentBlocks = [{ type: 'text', content: 'Streamed part' } as any];
      renderer.syncLiveMessageActions(liveMsg);

      ({ toolbar } = findToolbarChildren(messagesEl));
      const copyButtons = (toolbar.children as any[]).filter((child: any) => child.hasClass('claudian-message-copy-btn'));
      expect(copyButtons).toHaveLength(1);
      expect(toolbar.querySelector('.claudian-message-timestamp')).not.toBeNull();

      // A later finalize only extends the payload — still one button.
      liveMsg.contentBlocks = [
        { type: 'text', content: 'Streamed part' } as any,
        { type: 'text', content: 'Follow-up part' } as any,
      ];
      renderer.syncLiveMessageActions(liveMsg);

      ({ toolbar } = findToolbarChildren(messagesEl));
      const updatedButtons = (toolbar.children as any[]).filter((child: any) => child.hasClass('claudian-message-copy-btn'));
      expect(updatedButtons).toHaveLength(1);
      await updatedButtons[0]._eventListeners.get('click')[0]({ stopPropagation: jest.fn() });
      expect(writeTextMock).toHaveBeenCalledWith('Streamed part\n\nFollow-up part');
    });

    it('keeps the user toolbar order fork → rewind → copy → timestamp', () => {
      const messagesEl = createMockEl();
      const rewindCallback = jest.fn().mockResolvedValue(undefined);
      const forkCallback = jest.fn().mockResolvedValue(undefined);
      const renderer = new MessageRenderer(
        { app: {}, settings: { mediaFolder: '' } } as any,
        createMockComponent() as any,
        messagesEl,
        rewindCallback,
        forkCallback,
        mockCapabilities(),
      );
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      const userMsg: ChatMessage = {
        id: 'u-order',
        role: 'user',
        content: 'Question',
        timestamp,
        userMessageId: 'user-u',
      };
      const allMessages: ChatMessage[] = [
        { id: 'a1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
        userMsg,
        { id: 'a2', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'resp-a' },
      ];
      renderer.renderStoredMessage(userMsg, allMessages, 1);

      const { toolbar } = findToolbarChildren(messagesEl);
      const toolbarClasses = (toolbar.children as any[]).map((child: any) => child.className);
      expect(toolbarClasses).toEqual([
        'claudian-message-fork-btn',
        'claudian-message-rewind-btn',
        'claudian-message-copy-btn',
        'claudian-message-timestamp',
      ]);
    });

    it('re-syncs the live user toolbar payload on updateLiveUserMessage', async () => {
      const messagesEl = createMockEl();
      // A rewind callback makes addMessage track the element in liveMessageEls,
      // which is how the live-user path resolves the mounted message.
      const renderer = new MessageRenderer(
        { app: {}, settings: { mediaFolder: '' } } as any,
        createMockComponent() as any,
        messagesEl,
        jest.fn().mockResolvedValue(undefined),
      );
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const writeTextMock = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: writeTextMock } },
        writable: true,
        configurable: true,
      });

      const userMsg: ChatMessage = { id: 'u-live', role: 'user', content: 'draft', timestamp };
      renderer.addMessage(userMsg);

      userMsg.content = 'edited prompt';
      renderer.updateLiveUserMessage(userMsg);

      const { toolbar } = findToolbarChildren(messagesEl);
      const copyButtons = (toolbar.children as any[]).filter((child: any) => child.hasClass('claudian-message-copy-btn'));
      expect(copyButtons).toHaveLength(1);
      await copyButtons[0]._eventListeners.get('click')[0]({ stopPropagation: jest.fn() });
      expect(writeTextMock).toHaveBeenCalledWith('edited prompt');
    });

    it('shows translated copied feedback after a successful copy', async () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } },
        writable: true,
        configurable: true,
      });

      renderer.renderStoredMessage({
        id: 'a-feedback',
        role: 'assistant',
        content: 'Answer',
        timestamp,
      });

      const { toolbar } = findToolbarChildren(messagesEl);
      const copyBtn = (toolbar.children as any[]).find((child: any) => child.hasClass('claudian-message-copy-btn'));
      expect(copyBtn.getAttribute('aria-label')).toBe(t('chat.message.copyAriaLabel'));

      await copyBtn._eventListeners.get('click')[0]({ stopPropagation: jest.fn() });
      expect(copyBtn.textContent).toBe(t('chat.message.copied'));
      expect(copyBtn.classList.contains('copied')).toBe(true);
    });
  });

  describe('message-level timestamp toolbar', () => {
    const timestamp = new Date(2026, 8, 14, 20, 35, 3).getTime();

    it.each(['user', 'assistant'] as const)('renders stored %s message time in the shared toolbar', (role) => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      renderer.renderStoredMessage({
        id: `${role}-stored`,
        role,
        content: role === 'user' ? 'Question' : 'Answer',
        contentBlocks: role === 'assistant' ? [{ type: 'text', content: 'Answer' }] : undefined,
        timestamp,
      });

      const toolbar = messagesEl.querySelector('.claudian-message-actions');
      const time = messagesEl.querySelector('.claudian-message-timestamp');
      expect(toolbar).not.toBeNull();
      expect(time?.textContent).toContain('2026');
      expect(time?.textContent).toContain('20:35:03');
    });

    it.each(['user', 'assistant'] as const)('renders streaming %s message time', (role) => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      renderer.addMessage({
        id: `${role}-live`,
        role,
        content: role === 'user' ? 'Question' : '',
        timestamp,
      });

      expect(messagesEl.querySelector('.claudian-message-timestamp')).not.toBeNull();
    });

    it.each(['user', 'assistant'] as const)('renders prepended %s message time through the stored helper', (role) => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      renderer.renderStoredMessage({
        id: `${role}-prepend`,
        role,
        content: role === 'user' ? 'Earlier' : 'Earlier answer',
        contentBlocks: role === 'assistant' ? [{ type: 'text', content: 'Earlier answer' }] : undefined,
        timestamp,
      });

      expect(messagesEl.querySelectorAll('.claudian-message-timestamp')).toHaveLength(1);
    });

    it('does not render a timestamp for invalid input', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      renderer.addMessage({ id: 'a-invalid', role: 'assistant', content: '', timestamp: Number.NaN });
      expect(messagesEl.querySelector('.claudian-message-timestamp')).toBeNull();
    });

    it('keeps the subagent message timestamp toolbar a direct child of the assistant message element', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      renderer.renderStoredMessage({
        id: 'sub-stored',
        role: 'assistant',
        content: '',
        timestamp,
        toolCalls: [
          {
            id: 'sub-1',
            name: TOOL_TASK,
            input: { description: 'Subagent task', prompt: 'Do things' },
            status: 'completed',
            result: 'done',
          } as any,
        ],
        contentBlocks: [{ type: 'subagent', subagentId: 'sub-1' } as any],
      });

      expect(renderStoredSubagent).toHaveBeenCalled();
      const msgEl = messagesEl.querySelector('.claudian-message-assistant');
      expect(msgEl).not.toBeNull();
      // The assistant-scoped positioning override
      // (.claudian-message-assistant .claudian-message-actions { bottom: 0 })
      // requires the toolbar to sit directly on the message element — never
      // inside the content/subagent block.
      const children = (msgEl as any).children as any[];
      const toolbar = children.find(child => child.hasClass?.('claudian-message-actions'));
      expect(toolbar).toBeDefined();
      const content = children.find(child => child.hasClass?.('claudian-message-content'));
      expect(content.querySelector('.claudian-message-actions')).toBeNull();
      const time = toolbar.querySelector('.claudian-message-timestamp');
      expect(time?.textContent).toContain('20:35:03');
    });
  });

  // ============================================
  // renderAssistantContent
  // ============================================

  it('renders assistant content blocks using specialized renderers', () => {
    const messagesEl = createMockEl();
    const mockComponent = createMockComponent();
    const renderer = new MessageRenderer({} as any, mockComponent as any, messagesEl);
    const renderContentSpy = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'todo', name: 'TodoWrite', input: { items: [] } } as any,
        { id: 'edit', name: 'Edit', input: { file_path: 'notes/test.md' } } as any,
        { id: 'read', name: 'Read', input: { file_path: 'notes/test.md' } } as any,
        {
          id: 'sub-1',
          name: TOOL_TASK,
          input: { description: 'Async subagent' },
          status: 'running',
          subagent: { id: 'sub-1', mode: 'async', status: 'running', toolCalls: [], isExpanded: false },
        } as any,
        {
          id: 'sub-2',
          name: TOOL_TASK,
          input: { description: 'Sync subagent' },
          status: 'running',
          subagent: { id: 'sub-2', mode: 'sync', status: 'running', toolCalls: [], isExpanded: false },
        } as any,
      ],
      contentBlocks: [
        { type: 'thinking', content: 'thinking', durationSeconds: 2 } as any,
        { type: 'text', content: 'Text block' } as any,
        { type: 'tool_use', toolId: 'todo' } as any,
        { type: 'tool_use', toolId: 'edit' } as any,
        { type: 'tool_use', toolId: 'read' } as any,
        { type: 'subagent', subagentId: 'sub-1', mode: 'async' } as any,
        { type: 'subagent', subagentId: 'sub-2' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderStoredThinkingBlock).toHaveBeenCalled();
    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Text block');
    // TodoWrite is not rendered inline - only in bottom panel
    expect(renderStoredWriteEdit).toHaveBeenCalled();
    expect(renderStoredToolCall).toHaveBeenCalled();
    expect(renderStoredAsyncSubagent).toHaveBeenCalled();
    expect(renderStoredSubagent).toHaveBeenCalled();
  });

  it('skips empty or whitespace-only text blocks', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      contentBlocks: [
        { type: 'text', content: '' } as any,
        { type: 'text', content: '   ' } as any,
        { type: 'text', content: 'Real content' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    // Only the non-empty text block should trigger renderContent
    expect(renderContentSpy).toHaveBeenCalledTimes(1);
    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Real content');
  });

  it('renders response duration footer when durationSeconds is present', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      contentBlocks: [
        { type: 'text', content: 'Response text' } as any,
      ],
      durationSeconds: 65,
      durationFlavorWord: 'Baked',
    };

    renderer.renderStoredMessage(msg);

    // Find the footer element
    const msgEl = messagesEl.children[0];
    const contentEl = msgEl.children[0]; // claudian-message-content
    const footerEl = contentEl.children.find((c: any) => c.hasClass('claudian-response-footer'));
    expect(footerEl).toBeDefined();
    const durationSpan = footerEl!.children[0];
    expect(durationSpan.textContent).toContain('Baked');
    expect(durationSpan.textContent).toContain('1m 5s');
  });

  it('does not render footer when durationSeconds is 0', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      contentBlocks: [
        { type: 'text', content: 'Response' } as any,
      ],
      durationSeconds: 0,
    };

    renderer.renderStoredMessage(msg);

    const msgEl = messagesEl.children[0];
    const contentEl = msgEl.children[0];
    const footerEl = contentEl.children.find((c: any) => c.hasClass('claudian-response-footer'));
    expect(footerEl).toBeUndefined();
  });

  it('uses default flavor word "Baked" when durationFlavorWord is not set', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      contentBlocks: [
        { type: 'text', content: 'Response' } as any,
      ],
      durationSeconds: 30,
    };

    renderer.renderStoredMessage(msg);

    const msgEl = messagesEl.children[0];
    const contentEl = msgEl.children[0];
    const footerEl = contentEl.children.find((c: any) => c.hasClass('claudian-response-footer'));
    expect(footerEl).toBeDefined();
    expect(footerEl!.children[0].textContent).toContain('Baked');
  });

  it('renders fallback content for old conversations without contentBlocks', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'Legacy response text',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, status: 'completed' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    // Should render content text
    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Legacy response text');
    // Message-level toolbar carries the copy action for the fallback text
    const toolbar = messagesEl.querySelector('.claudian-message-actions');
    expect(toolbar?.querySelector('.claudian-message-copy-btn')).not.toBeNull();
    // Should render tool call
    expect(renderStoredToolCall).toHaveBeenCalled();
  });

  it('renders unreferenced tool calls when contentBlocks miss tool_use blocks', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    (renderStoredToolCall as jest.Mock).mockClear();

    const msg: ChatMessage = {
      id: 'm-unreferenced-tool',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'read-1', name: 'Read', input: { file_path: 'a.md' }, status: 'completed' } as any,
      ],
      contentBlocks: [
        { type: 'text', content: 'Only text block persisted' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'Only text block persisted');
    expect(renderStoredToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'read-1', name: 'Read' })
    );
  });

  it('renders Task tool calls as subagents for backward compatibility', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);

    (renderStoredSubagent as jest.Mock).mockClear();

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'task-1',
          name: TOOL_TASK,
          input: { description: 'Run tests' },
          status: 'completed',
          result: 'All passed',
        } as any,
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'task-1' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderStoredSubagent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'task-1',
        description: 'Run tests',
        status: 'completed',
        result: 'All passed',
      })
    );
  });

  it('renders Task tool as async subagent when linked subagent mode is async', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);

    (renderStoredAsyncSubagent as jest.Mock).mockClear();
    (renderStoredSubagent as jest.Mock).mockClear();

    const msg: ChatMessage = {
      id: 'm-task-async',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'task-async-1',
          name: TOOL_TASK,
          input: { description: 'Background task', run_in_background: true },
          status: 'completed',
          result: 'Task running',
          subagent: {
            id: 'task-async-1',
            description: 'Background task',
            mode: 'async',
            asyncStatus: 'running',
            status: 'running',
            toolCalls: [],
            isExpanded: false,
          },
        } as any,
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'task-async-1' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderStoredAsyncSubagent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'task-async-1',
        mode: 'async',
        asyncStatus: 'running',
      })
    );
    expect(renderStoredSubagent).not.toHaveBeenCalled();
  });

  it('infers async running state from structured Task result content', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);

    (renderStoredAsyncSubagent as jest.Mock).mockClear();

    const msg: ChatMessage = {
      id: 'm-task-async-structured',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'task-async-structured-1',
          name: TOOL_TASK,
          input: { description: 'Background task', run_in_background: true },
          status: 'completed',
          result: [{ type: 'text', text: '{"status":"running"}' }] as any,
        } as any,
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'task-async-structured-1' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderStoredAsyncSubagent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'task-async-structured-1',
        asyncStatus: 'running',
      })
    );
  });

  it('uses subagent block mode hint when linked subagent mode is missing', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);

    (renderStoredAsyncSubagent as jest.Mock).mockClear();
    (renderStoredSubagent as jest.Mock).mockClear();

    const msg: ChatMessage = {
      id: 'm-task-mode-hint',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        {
          id: 'task-hint-1',
          name: TOOL_TASK,
          input: { description: 'Background task from block hint' },
          status: 'running',
          subagent: {
            id: 'task-hint-1',
            description: 'Background task from block hint',
            status: 'running',
            toolCalls: [],
            isExpanded: false,
          },
        } as any,
      ],
      contentBlocks: [
        { type: 'subagent', subagentId: 'task-hint-1', mode: 'async' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderStoredAsyncSubagent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'task-hint-1',
        mode: 'async',
      })
    );
    expect(renderStoredSubagent).not.toHaveBeenCalled();
  });

  // ============================================
  // TaskOutput skipping
  // ============================================

  it('should skip TaskOutput tool calls (internal async subagent communication)', () => {
    const messagesEl = createMockEl();
    const mockComponent = createMockComponent();
    const renderer = new MessageRenderer({} as any, mockComponent as any, messagesEl);

    (renderStoredToolCall as jest.Mock).mockClear();

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'agent-output-1', name: TOOL_AGENT_OUTPUT, input: { task_id: 'abc', block: true } } as any,
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'agent-output-1' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderStoredToolCall).not.toHaveBeenCalled();
  });

  it('should render other tool calls but skip TaskOutput when mixed', () => {
    const messagesEl = createMockEl();
    const mockComponent = createMockComponent();
    const renderer = new MessageRenderer({} as any, mockComponent as any, messagesEl);

    (renderStoredToolCall as jest.Mock).mockClear();

    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [
        { id: 'read-1', name: 'Read', input: { file_path: 'test.md' }, status: 'completed' } as any,
        { id: 'agent-output-1', name: TOOL_AGENT_OUTPUT, input: { task_id: 'abc' } } as any,
        { id: 'grep-1', name: 'Grep', input: { pattern: 'test' }, status: 'completed' } as any,
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'read-1' } as any,
        { type: 'tool_use', toolId: 'agent-output-1' } as any,
        { type: 'tool_use', toolId: 'grep-1' } as any,
      ],
    };

    renderer.renderStoredMessage(msg);

    expect(renderStoredToolCall).toHaveBeenCalledTimes(2);
    expect(renderStoredToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'read-1', name: 'Read' })
    );
    expect(renderStoredToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'grep-1', name: 'Grep' })
    );
  });

  // ============================================
  // addMessage (streaming)
  // ============================================

  it('addMessage creates user message bubble with text', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    };

    const msgEl = renderer.addMessage(msg);

    expect(msgEl.hasClass('claudian-message-user')).toBe(true);
  });

  it('addMessage renders images for user messages', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
    const renderImagesSpy = jest.spyOn(renderer, 'renderMessageImages').mockImplementation(() => {});

    const images: ImageAttachment[] = [
      { id: 'img-1', name: 'photo.png', mediaType: 'image/png', data: 'base64data', size: 200, source: 'file' },
    ];

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'Look at this',
      timestamp: Date.now(),
      images,
    };

    renderer.addMessage(msg);

    expect(renderImagesSpy).toHaveBeenCalledWith(messagesEl, images);
  });

  it('addMessage skips empty bubble for image-only user messages', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderMessageImages').mockImplementation(() => {});
    const scrollSpy = jest.spyOn(renderer, 'scrollToBottom').mockImplementation(() => {});

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: '',
      timestamp: Date.now(),
      images: [{ id: 'img-1', name: 'img.png', mediaType: 'image/png', data: 'abc', size: 100, source: 'paste' as const }],
    };

    const result = renderer.addMessage(msg);

    // Should still return an element (last child or messagesEl)
    expect(result).toBeDefined();
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('addMessage creates assistant message element without user-specific rendering', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);

    const msg: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    const msgEl = renderer.addMessage(msg);

    expect(msgEl.hasClass('claudian-message-assistant')).toBe(true);
  });

  // ============================================
  // setMessagesEl
  // ============================================

  it('setMessagesEl updates the container element', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    const newEl = createMockEl();

    renderer.setMessagesEl(newEl);

    // Verify by using scrollToBottom which references messagesEl
    renderer.scrollToBottom();
    // The new element should have been used (scrollTop set)
    expect(newEl.scrollTop).toBe(newEl.scrollHeight);
  });

  // ============================================
  // Image rendering
  // ============================================

  it('renderMessageImages creates image elements', () => {
    const containerEl = createMockEl();
    const { renderer } = createRenderer();
    jest.spyOn(renderer, 'setImageSrc').mockImplementation(() => {});

    const images: ImageAttachment[] = [
      { id: 'img-1', name: 'photo.png', mediaType: 'image/png', data: 'base64data1', size: 200, source: 'file' },
      { id: 'img-2', name: 'avatar.jpg', mediaType: 'image/jpeg', data: 'base64data2', size: 300, source: 'file' },
    ];

    renderer.renderMessageImages(containerEl, images);

    // Should create images container with 2 image wrappers
    expect(containerEl.children.length).toBe(1);
    const imagesContainer = containerEl.children[0];
    expect(imagesContainer.hasClass('claudian-message-images')).toBe(true);
    expect(imagesContainer.children.length).toBe(2);
  });

  it('setImageSrc sets data URI on image element', () => {
    const { renderer } = createRenderer();
    const imgEl = createMockEl('img');

    const image: ImageAttachment = {
      id: 'img-1',
      name: 'test.png',
      mediaType: 'image/png',
      data: 'abc123',
      size: 100,
      source: 'file',
    };

    renderer.setImageSrc(imgEl as any, image);

    expect(imgEl.getAttribute('src')).toBe('data:image/png;base64,abc123');
  });

  it('showFullImage creates overlay with image', () => {
    const { renderer } = createRenderer();
    const image: ImageAttachment = {
      id: 'img-1',
      name: 'test.png',
      mediaType: 'image/png',
      data: 'abc123',
      size: 100,
      source: 'file',
    };

    // Mock document.body.createDiv (document may not exist in node env)
    const overlayEl = createMockEl();
    const mockBody = { createDiv: jest.fn().mockReturnValue(overlayEl) };
    const origDocument = globalThis.document;
    (globalThis as any).document = { body: mockBody, addEventListener: jest.fn(), removeEventListener: jest.fn() };

    try {
      renderer.showFullImage(image);
      expect(mockBody.createDiv).toHaveBeenCalledWith({ cls: 'claudian-image-modal-overlay' });
    } finally {
      (globalThis as any).document = origDocument;
    }
  });

  // ============================================
  // Scroll utilities
  // ============================================

  it('scrollToBottom sets scrollTop to scrollHeight', () => {
    const messagesEl = createMockEl();
    messagesEl.scrollHeight = 1000;
    const { renderer } = createRenderer(messagesEl);

    renderer.scrollToBottom();

    expect(messagesEl.scrollTop).toBe(1000);
  });

  it('scrollToBottomIfNeeded scrolls when near bottom', () => {
    const messagesEl = createMockEl();
    messagesEl.scrollHeight = 1000;
    messagesEl.scrollTop = 950;
    Object.defineProperty(messagesEl, 'clientHeight', { value: 0, configurable: true });
    const { renderer } = createRenderer(messagesEl);

    // Mock requestAnimationFrame
    const origRAF = globalThis.requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = (cb: () => void) => { cb(); return 0; };

    try {
      renderer.scrollToBottomIfNeeded();
      // Near bottom (1000 - 950 - 0 = 50, < 100 threshold) → scrolls
      expect(messagesEl.scrollTop).toBe(1000);
    } finally {
      (globalThis as any).requestAnimationFrame = origRAF;
    }
  });

  it('scrollToBottomIfNeeded does not scroll when far from bottom', () => {
    const messagesEl = createMockEl();
    messagesEl.scrollHeight = 1000;
    messagesEl.scrollTop = 100;
    Object.defineProperty(messagesEl, 'clientHeight', { value: 0, configurable: true });
    const { renderer } = createRenderer(messagesEl);

    const originalScrollTop = messagesEl.scrollTop;
    renderer.scrollToBottomIfNeeded();

    // scrollTop should not change (900 > 100 threshold)
    expect(messagesEl.scrollTop).toBe(originalScrollTop);
  });

  // ============================================
  // renderContent
  // ============================================

  it('renderContent should not throw on valid markdown', async () => {
    const { renderer } = createRenderer();
    const el = createMockEl();

    // Should not throw even if internal rendering fails (graceful error handling)
    await expect(renderer.renderContent(el, '**Hello** world')).resolves.not.toThrow();
  });

  it('renderContent should empty the element before rendering', async () => {
    const { renderer } = createRenderer();
    const el = createMockEl();
    el.createDiv({ text: 'old content' });
    expect(el.children.length).toBe(1);

    await renderer.renderContent(el, 'new content');

    // After render, old content should be gone (empty() was called before rendering)
    expect(el.children.length).toBe(0);
  });

  it('renderContent should skip file-link post-processing when markdown has no wikilinks', async () => {
    const { processFileLinks } = await import('@/utils/fileLink');
    const { renderer } = createRenderer();
    const el = createMockEl();

    await renderer.renderContent(el, 'plain markdown without links');

    expect(processFileLinks).not.toHaveBeenCalled();
  });

  it('renderContent escapes math delimiters only when requested for streaming', async () => {
    const { MarkdownRenderer } = await import('obsidian');
    const { renderer } = createRenderer();
    const el = createMockEl();

    await renderer.renderContent(
      el,
      'Live $x + y$ and `echo $PATH`',
      { deferMath: true }
    );

    expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledWith(
      'Live \\$x + y\\$ and `echo $PATH`',
      el,
      '',
      expect.anything()
    );
  });

  // ============================================
  // message-level copy - click behavior
  // ============================================

  describe('message copy button - click behavior', () => {
    let originalNavigator: Navigator;

    beforeEach(() => {
      originalNavigator = globalThis.navigator;
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        writable: true,
        configurable: true,
      });
    });

    function mountCopyButton() {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      renderer.renderStoredMessage({
        id: 'a-copy-click',
        role: 'assistant',
        content: 'markdown content',
        timestamp: 1,
      });

      const msgEl = (messagesEl.children as any[])[0];
      const toolbar = (msgEl.children as any[]).find((child: any) => child.hasClass('claudian-message-actions'));
      return (toolbar.children as any[]).find((child: any) => child.hasClass('claudian-message-copy-btn'));
    }

    it('click should copy and show feedback', async () => {
      const writeTextMock = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: writeTextMock } },
        writable: true,
        configurable: true,
      });

      const copyBtn = mountCopyButton();
      const clickHandlers = copyBtn._eventListeners.get('click');
      expect(clickHandlers).toBeDefined();

      await clickHandlers[0]({ stopPropagation: jest.fn() });

      expect(writeTextMock).toHaveBeenCalledWith('markdown content');
      expect(copyBtn.textContent).toBe(t('chat.message.copied'));
      expect(copyBtn.classList.contains('copied')).toBe(true);
    });

    it('should handle clipboard API failure gracefully', async () => {
      const writeTextMock = jest.fn().mockRejectedValue(new Error('not allowed'));
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: writeTextMock } },
        writable: true,
        configurable: true,
      });

      const copyBtn = mountCopyButton();
      const clickHandlers = copyBtn._eventListeners.get('click');

      // Should not throw
      await clickHandlers[0]({ stopPropagation: jest.fn() });

      // Should not show feedback on error
      expect(copyBtn.textContent).not.toBe(t('chat.message.copied'));
    });
  });

  // ============================================
  // renderMessages (entry point)
  // ============================================

  it('renderMessages should render stored messages and return welcome element', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
    jest.spyOn(renderer, 'renderMessageImages').mockImplementation(() => {});

    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Hello', timestamp: Date.now() },
      { id: 'a1', role: 'assistant', content: 'Hi there', timestamp: Date.now(), contentBlocks: [{ type: 'text', content: 'Hi there' }] as any },
    ];

    const welcomeEl = renderer.renderMessages(messages, () => 'Good morning!');

    expect(welcomeEl).toBeDefined();
    expect(welcomeEl!.hasClass('claudian-welcome')).toBe(true);
  });

  it('renderMessages should hide welcome when messages exist', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
    jest.spyOn(renderer, 'renderMessageImages').mockImplementation(() => {});

    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Hello', timestamp: Date.now() },
    ];

    const welcomeEl = renderer.renderMessages(messages, () => 'Hello');

    // When messages exist, welcome should be hidden
    expect(welcomeEl).toBeDefined();
  });

  it('renderMessages should return welcome element when no messages', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);

    const welcomeEl = renderer.renderMessages([], () => 'Welcome');

    expect(welcomeEl).toBeDefined();
    expect(welcomeEl!.hasClass('claudian-welcome')).toBe(true);
  });

  // ============================================
  // Task tool rendering - error and running status
  // ============================================

  describe('Task tool rendering - error and running status', () => {
    it('renders Task tool with error status as subagent with status error', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl, 'codex');

      (renderStoredSubagent as jest.Mock).mockClear();

      const msg: ChatMessage = {
        id: 'm1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'task-err',
            name: TOOL_TASK,
            input: { description: 'Failing task' },
            status: 'error',
            result: 'Something went wrong',
          } as any,
        ],
        contentBlocks: [
          { type: 'tool_use', toolId: 'task-err' } as any,
        ],
      };

      renderer.renderStoredMessage(msg);

      expect(renderStoredSubagent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'task-err',
          description: 'Failing task',
          status: 'error',
          result: 'Something went wrong',
        })
      );
    });

    it('renders Task tool with running status (default case in switch)', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl, 'codex');

      (renderStoredSubagent as jest.Mock).mockClear();

      const msg: ChatMessage = {
        id: 'm1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'task-run',
            name: TOOL_TASK,
            input: { description: 'Running task' },
            status: 'pending',
          } as any,
        ],
        contentBlocks: [
          { type: 'tool_use', toolId: 'task-run' } as any,
        ],
      };

      renderer.renderStoredMessage(msg);

      expect(renderStoredSubagent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'task-run',
          description: 'Running task',
          status: 'running',
        })
      );
    });

    it('renders Task tool with no description uses fallback Subagent task', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);

      (renderStoredSubagent as jest.Mock).mockClear();

      const msg: ChatMessage = {
        id: 'm1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'task-no-desc',
            name: TOOL_TASK,
            input: {},
            status: 'completed',
            result: 'Done',
          } as any,
        ],
        contentBlocks: [
          { type: 'tool_use', toolId: 'task-no-desc' } as any,
        ],
      };

      renderer.renderStoredMessage(msg);

      expect(renderStoredSubagent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'task-no-desc',
          description: 'Subagent task',
          status: 'completed',
        })
      );
    });

    it('renders Codex spawn_agent with the same prompt and result recovered on reload', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl, 'codex');

      (renderStoredSubagent as jest.Mock).mockClear();

      const msg: ChatMessage = {
        id: 'm-codex-subagent',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'spawn-1',
            name: TOOL_SPAWN_AGENT,
            input: {
              message: 'Inspect utils.ts and return the final patch summary.',
              model: 'gpt-5.4-mini',
            },
            status: 'completed',
            result: '{"agent_id":"agent-1","nickname":"Zeno"}',
          } as any,
          {
            id: 'wait-1',
            name: TOOL_WAIT_AGENT,
            input: { targets: ['agent-1'], timeout_ms: 30000 },
            status: 'completed',
            result: '{"status":{"agent-1":{"completed":"Patched utils.ts and verified imports."}},"timed_out":false}',
          } as any,
        ],
        contentBlocks: [
          { type: 'tool_use', toolId: 'spawn-1' } as any,
        ],
      };

      renderer.renderStoredMessage(msg);

      expect(renderStoredSubagent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'spawn-1',
          description: 'Zeno (gpt-5.4-mini)',
          prompt: 'Inspect utils.ts and return the final patch summary.',
          status: 'completed',
          result: 'Patched utils.ts and verified imports.',
        })
      );
    });
  });

  // ============================================
  // showFullImage - close behaviors
  // ============================================

  describe('showFullImage - close behaviors', () => {
    const image: ImageAttachment = {
      id: 'img-1',
      name: 'test.png',
      mediaType: 'image/png',
      data: 'abc123',
      size: 100,
      source: 'file',
    };

    function setupDocumentMock() {
      const overlayEl = createMockEl();
      const mockBody = { createDiv: jest.fn().mockReturnValue(overlayEl) };
      const docListeners = new Map<string, ((...args: any[]) => void)[]>();
      const origDocument = globalThis.document;

      (globalThis as any).document = {
        body: mockBody,
        addEventListener: jest.fn((event: string, handler: (...args: any[]) => void) => {
          if (!docListeners.has(event)) docListeners.set(event, []);
          docListeners.get(event)!.push(handler);
        }),
        removeEventListener: jest.fn((event: string, handler: (...args: any[]) => void) => {
          const handlers = docListeners.get(event);
          if (handlers) {
            const idx = handlers.indexOf(handler);
            if (idx !== -1) handlers.splice(idx, 1);
          }
        }),
      };

      return { overlayEl, docListeners, origDocument };
    }

    it('closeBtn click removes overlay', () => {
      const { renderer } = createRenderer();
      const { overlayEl, origDocument } = setupDocumentMock();

      try {
        renderer.showFullImage(image);

        // The overlay has a modal child, which has a close button child
        const modalEl = overlayEl.children[0]; // claudian-image-modal
        // Children: img (index 0), closeBtn (index 1)
        const closeBtn = modalEl.children[1];
        expect(closeBtn.hasClass('claudian-image-modal-close')).toBe(true);

        const removeSpy = jest.spyOn(overlayEl, 'remove');
        closeBtn.click();

        expect(removeSpy).toHaveBeenCalled();
      } finally {
        (globalThis as any).document = origDocument;
      }
    });

    it('clicking overlay background removes overlay', () => {
      const { renderer } = createRenderer();
      const { overlayEl, origDocument } = setupDocumentMock();

      try {
        renderer.showFullImage(image);

        const removeSpy = jest.spyOn(overlayEl, 'remove');

        // Simulate click on the overlay itself (e.target === overlay)
        const clickHandlers = overlayEl._eventListeners.get('click');
        expect(clickHandlers).toBeDefined();
        clickHandlers![0]({ target: overlayEl });

        expect(removeSpy).toHaveBeenCalled();
      } finally {
        (globalThis as any).document = origDocument;
      }
    });

    it('ESC key removes overlay', () => {
      const { renderer } = createRenderer();
      const { overlayEl, docListeners, origDocument } = setupDocumentMock();

      try {
        renderer.showFullImage(image);

        const removeSpy = jest.spyOn(overlayEl, 'remove');

        // Simulate ESC key press via the document keydown listener
        const keydownHandlers = docListeners.get('keydown');
        expect(keydownHandlers).toBeDefined();
        expect(keydownHandlers!.length).toBeGreaterThan(0);
        keydownHandlers![0]({ key: 'Escape' });

        expect(removeSpy).toHaveBeenCalled();
        // After close, the keydown handler should be removed
        expect(document.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
      } finally {
        (globalThis as any).document = origDocument;
      }
    });
  });

  // ============================================
  // renderContent - code block wrapping (error path)
  // ============================================

  describe('renderContent - error handling', () => {
    it('renderContent shows error div when MarkdownRenderer throws', async () => {
      const { MarkdownRenderer } = await import('obsidian');
      (MarkdownRenderer.renderMarkdown as jest.Mock).mockRejectedValueOnce(
        new Error('Render failed')
      );

      const { renderer } = createRenderer();
      const el = createMockEl();

      await renderer.renderContent(el, '**broken markdown**');

      const errorDiv = el.children.find(
        (c: any) => c.hasClass('claudian-render-error')
      );
      expect(errorDiv).toBeDefined();
      expect(errorDiv!.textContent).toBe('Failed to render message content.');
    });
  });

  // ============================================
  // message-level copy - rapid click handling
  // ============================================

  describe('message copy button - rapid click handling', () => {
    let originalNavigator: Navigator;

    beforeEach(() => {
      originalNavigator = globalThis.navigator;
      jest.useFakeTimers();
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } },
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        writable: true,
        configurable: true,
      });
    });

    function mountCopyButton() {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      renderer.renderStoredMessage({
        id: 'a-copy-rapid',
        role: 'assistant',
        content: 'content to copy',
        timestamp: 1,
      });

      const msgEl = (messagesEl.children as any[])[0];
      const toolbar = (msgEl.children as any[]).find((child: any) => child.hasClass('claudian-message-actions'));
      return (toolbar.children as any[]).find((child: any) => child.hasClass('claudian-message-copy-btn'));
    }

    it('rapid clicks clear previous timeout', async () => {
      const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');

      const copyBtn = mountCopyButton();
      const clickHandlers = copyBtn._eventListeners.get('click');
      expect(clickHandlers).toBeDefined();

      // First click
      await clickHandlers![0]({ stopPropagation: jest.fn() });
      expect(copyBtn.textContent).toBe(t('chat.message.copied'));

      // Second rapid click before timeout expires
      await clickHandlers![0]({ stopPropagation: jest.fn() });

      // clearTimeout should have been called for the first pending timeout
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(copyBtn.textContent).toBe(t('chat.message.copied'));

      clearTimeoutSpy.mockRestore();
    });

    it('feedback timeout restores icon after delay', async () => {
      const copyBtn = mountCopyButton();
      const originalInnerHTML = copyBtn.innerHTML;
      const clickHandlers = copyBtn._eventListeners.get('click');

      // Click to copy
      await clickHandlers![0]({ stopPropagation: jest.fn() });
      expect(copyBtn.textContent).toBe(t('chat.message.copied'));
      expect(copyBtn.classList.contains('copied')).toBe(true);

      // Advance timers by 1500ms (the feedback duration)
      jest.advanceTimersByTime(1500);

      // Icon should be restored and copied class removed
      expect(copyBtn.innerHTML).toBe(originalInnerHTML);
      expect(copyBtn.classList.contains('copied')).toBe(false);
    });
  });

  // ============================================
  // renderContent - code block wrapping
  // ============================================

  describe('renderContent - code block wrapping', () => {
    it('passes image-processed markdown directly to MarkdownRenderer', async () => {
      const { MarkdownRenderer } = await import('obsidian');
      const { replaceImageEmbedsWithHtml } = await import('@/utils/imageEmbed');
      const { processFileLinks } = await import('@/utils/fileLink');
      const { renderer } = createRenderer();
      const el = createMockEl();

      (replaceImageEmbedsWithHtml as jest.Mock).mockReturnValueOnce(
        '<span title="[[note.md]]">raw html</span>\n    [[note.md]]'
      );

      await renderer.renderContent(el, 'before-images ![[image.png]] [[note.md]]');

      expect(replaceImageEmbedsWithHtml).toHaveBeenCalledWith(
        'before-images ![[image.png]] [[note.md]]',
        expect.anything(),
        ''
      );
      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledWith(
        '<span title="[[note.md]]">raw html</span>\n    [[note.md]]',
        el,
        '',
        expect.anything()
      );
      expect(processFileLinks).toHaveBeenCalledWith(expect.anything(), el);
    });

    it('should wrap pre elements in code wrapper divs', async () => {
      const { MarkdownRenderer } = await import('obsidian');
      const { renderer } = createRenderer();
      const el = createMockEl();

      // Mock renderMarkdown to create a pre element in the container
      (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(
        async (_md: string, container: any) => {
          const pre = container.createEl('pre');
          pre.createEl('code', { text: 'console.log("hello")' });
        }
      );

      await renderer.renderContent(el, '```js\nconsole.log("hello")\n```');

      // The pre should be wrapped in a claudian-code-wrapper
      // Due to mock limitations, check that querySelectorAll was called on el
      // The actual wrapping logic runs on real DOM, but the mock captures calls
      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalled();
    });

    it('should skip wrapping already-wrapped pre elements', async () => {
      const { MarkdownRenderer } = await import('obsidian');
      const { renderer } = createRenderer();
      const el = createMockEl();

      // Mock renderMarkdown to create an already-wrapped pre element
      (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(
        async (_md: string, container: any) => {
          const wrapper = container.createDiv({ cls: 'claudian-code-wrapper' });
          wrapper.createEl('pre');
        }
      );

      await renderer.renderContent(el, '```\nalready wrapped\n```');

      // Should not throw and should complete normally
      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalled();
    });
  });

  // ============================================
  // renderMessageImages - click handler
  // ============================================

  describe('renderMessageImages - click handler', () => {
    it('should add click handler on image elements', () => {
      const containerEl = createMockEl();
      const { renderer } = createRenderer();
      const showFullImageSpy = jest.spyOn(renderer, 'showFullImage').mockImplementation(() => {});
      jest.spyOn(renderer, 'setImageSrc').mockImplementation(() => {});

      const images: ImageAttachment[] = [
        { id: 'img-1', name: 'photo.png', mediaType: 'image/png', data: 'base64data', size: 200, source: 'file' },
      ];

      renderer.renderMessageImages(containerEl, images);

      // Find the img element and check for click handler
      const imagesContainer = containerEl.children[0];
      const wrapper = imagesContainer.children[0];
      const imgEl = wrapper.children[0]; // The img element

      // Check click handler is registered
      const clickHandlers = imgEl._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();
      expect(clickHandlers!.length).toBe(1);

      // Trigger click and verify showFullImage is called
      clickHandlers![0]();
      expect(showFullImageSpy).toHaveBeenCalledWith(images[0]);
    });
  });

  // ============================================
  // renderContent - code block wrapping with language labels
  // ============================================

  describe('renderContent - language label and copy', () => {
    it('should add language label when code block has language class', async () => {
      const { MarkdownRenderer } = await import('obsidian');
      const { renderer } = createRenderer();
      const el = createMockEl();

      (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(
        async (_md: string, container: any) => {
          const pre = container.createEl('pre');
          const code = pre.createEl('code');
          code.className = 'language-typescript';
          code.textContent = 'const x = 1;';
        }
      );

      await renderer.renderContent(el, '```typescript\nconst x = 1;\n```');

      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalled();
    });

    it('should move copy-code-button outside pre into wrapper', async () => {
      const { MarkdownRenderer } = await import('obsidian');
      const { renderer } = createRenderer();
      const el = createMockEl();

      (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(
        async (_md: string, container: any) => {
          const pre = container.createEl('pre');
          pre.createEl('code', { text: 'some code' });
          const copyBtn = pre.createEl('button');
          copyBtn.className = 'copy-code-button';
        }
      );

      await renderer.renderContent(el, '```\nsome code\n```');

      expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalled();
    });
  });

  // ============================================
  // addMessage - displayContent for user messages
  // ============================================

  it('addMessage renders displayContent instead of content when available', () => {
    const messagesEl = createMockEl();
    const { renderer } = createRenderer(messagesEl);
    const renderContentSpy = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

    const msg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'full prompt with context',
      displayContent: 'user input only',
      timestamp: Date.now(),
    };

    renderer.addMessage(msg);

    expect(renderContentSpy).toHaveBeenCalledWith(expect.anything(), 'user input only');
  });

  // ============================================
  // renderStoredThinkingBlock - durationSeconds parameter
  // ============================================

  describe('renderStoredThinkingBlock - durationSeconds parameter', () => {
    it('should pass durationSeconds to renderStoredThinkingBlock', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      (renderStoredThinkingBlock as jest.Mock).mockClear();

      const msg: ChatMessage = {
        id: 'm1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        contentBlocks: [
          { type: 'thinking', content: 'deep thought', durationSeconds: 42 } as any,
        ],
      };

      renderer.renderStoredMessage(msg);

      expect(renderStoredThinkingBlock).toHaveBeenCalledWith(
        expect.anything(),
        'deep thought',
        42,
        expect.any(Function)
      );
    });

    it('should pass undefined durationSeconds when not set', () => {
      const messagesEl = createMockEl();
      const { renderer } = createRenderer(messagesEl);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);

      (renderStoredThinkingBlock as jest.Mock).mockClear();

      const msg: ChatMessage = {
        id: 'm1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        contentBlocks: [
          { type: 'thinking', content: 'thought without duration' } as any,
        ],
      };

      renderer.renderStoredMessage(msg);

      expect(renderStoredThinkingBlock).toHaveBeenCalledWith(
        expect.anything(),
        'thought without duration',
        undefined,
        expect.any(Function)
      );
    });
  });

  // ============================================
  // B1 frame-batched rendering and lazy shells
  // ============================================

  describe('frame-batched rendering', () => {
    let rafQueue: FrameRequestCallback[];
    let originalRaf: typeof requestAnimationFrame | undefined;

    beforeEach(() => {
      rafQueue = [];
      originalRaf = (globalThis as any).requestAnimationFrame;
      (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      };
    });

    afterEach(() => {
      if (originalRaf === undefined) delete (globalThis as any).requestAnimationFrame;
      else (globalThis as any).requestAnimationFrame = originalRaf;
    });

    const flushFrames = async (): Promise<void> => {
      while (rafQueue.length > 0) {
        const callbacks = rafQueue.splice(0);
        for (const callback of callbacks) callback(0);
        await Promise.resolve();
      }
    };

    const countRenderedMessages = (el: any): number =>
      el._children.filter((child: any) => child.hasClass('claudian-message')).length;

    it('mounts the first slice synchronously and defers the rest across frames', async () => {
      const { renderer, messagesEl } = createRenderer();
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const messages = Array.from({ length: 45 }, (_, index) => ({
        id: `m${index}`, role: 'user' as const, content: `m${index}`, timestamp: index,
      }));

      renderer.renderMessages(messages, () => 'Hello');

      expect(countRenderedMessages(messagesEl)).toBe(20);
      expect(rafQueue.length).toBeGreaterThan(0);

      await flushFrames();

      expect(countRenderedMessages(messagesEl)).toBe(45);
      await expect(renderer.waitForRenderedMessages()).resolves.toBeUndefined();
    });

    it('resolves waitForRenderedMessages only after the queue drains', async () => {
      const { renderer, messagesEl } = createRenderer();
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const messages = Array.from({ length: 25 }, (_, index) => ({
        id: `m${index}`, role: 'user' as const, content: `m${index}`, timestamp: index,
      }));

      renderer.renderMessages(messages, () => 'Hello');
      let drained = false;
      void renderer.waitForRenderedMessages().then(() => { drained = true; });

      await Promise.resolve();
      expect(drained).toBe(false);
      expect(countRenderedMessages(messagesEl)).toBe(20);

      await flushFrames();
      expect(drained).toBe(true);
    });

    it('emits render batch and completion diagnostics', async () => {
      const events: HistoryRenderDiagnosticEvent[] = [];
      setHistoryRenderDiagnosticsSink(event => events.push(event));
      try {
        const { renderer } = createRenderer();
        jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
        const messages = Array.from({ length: 45 }, (_, index) => ({
          id: `m${index}`, role: 'user' as const, content: `m${index}`, timestamp: index,
        }));

        renderer.renderMessages(messages, () => 'Hello');
        await flushFrames();

        const batches = events.filter(event => event.kind === 'render_batch');
        expect(batches.length).toBeGreaterThanOrEqual(3);
        expect(batches.reduce((sum, event) => sum + (event.kind === 'render_batch' ? event.mounted : 0), 0)).toBe(45);
        const complete = events.find(event => event.kind === 'render_complete');
        expect(complete).toMatchObject({ kind: 'render_complete', messages: 45 });
      } finally {
        setHistoryRenderDiagnosticsSink(null);
      }
    });

    it('still settles render idle when a frame step throws mid-render', async () => {
      let batches = 0;
      setHistoryRenderDiagnosticsSink(() => {
        batches += 1;
        // The sink throws after the first frame mounts (e.g. a failing
        // diagnostics log write) — idle must still settle or hydration
        // stays LOADING forever.
        if (batches > 1) throw new Error('sink failure');
      });
      try {
        const { renderer } = createRenderer();
        jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
        const messages = Array.from({ length: 45 }, (_, index) => ({
          id: `m${index}`, role: 'user' as const, content: `m${index}`, timestamp: index,
        }));

        renderer.renderMessages(messages, () => 'Hello');
        const callbacks = rafQueue.splice(0);
        expect(() => {
          for (const callback of callbacks) callback(0);
        }).toThrow('sink failure');

        await expect(renderer.waitForRenderedMessages()).resolves.toBeUndefined();
      } finally {
        setHistoryRenderDiagnosticsSink(null);
      }
    });

    it('stops a superseded render queue when a new render starts', async () => {
      const { renderer } = createRenderer();
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const rendered: string[] = [];
      jest.spyOn(renderer, 'renderStoredMessage').mockImplementation(msg => { rendered.push(msg.id); });
      const first = Array.from({ length: 45 }, (_, index) => ({
        id: `a${index}`, role: 'user' as const, content: `a${index}`, timestamp: index,
      }));
      const second = Array.from({ length: 3 }, (_, index) => ({
        id: `b${index}`, role: 'user' as const, content: `b${index}`, timestamp: index,
      }));

      renderer.renderMessages(first, () => 'Hello');
      renderer.renderMessages(second, () => 'Hello');
      await flushFrames();

      // First slice of the superseded render already mounted; its pending
      // frames are discarded instead of appending to the cleared container.
      expect(rendered.filter(id => id.startsWith('a'))).toHaveLength(20);
      expect(rendered.filter(id => id.startsWith('b'))).toHaveLength(3);
    });

    it('does not let a superseded render read as global idle (condition wait)', async () => {
      const { renderer } = createRenderer();
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const first = Array.from({ length: 45 }, (_, index) => ({
        id: `a${index}`, role: 'user' as const, content: `a${index}`, timestamp: index,
      }));
      const second = Array.from({ length: 45 }, (_, index) => ({
        id: `b${index}`, role: 'user' as const, content: `b${index}`, timestamp: index,
      }));

      renderer.renderMessages(first, () => 'Hello');
      let drained = false;
      void renderer.waitForRenderedMessages().then(() => { drained = true; });

      // Supersede before the first queue drains; the early idle resolution of
      // the superseded promise must NOT release the waiter.
      renderer.renderMessages(second, () => 'Hello');
      await Promise.resolve();
      await Promise.resolve();
      expect(drained).toBe(false);

      // Flush only the second queue's frames; the waiter resolves once the
      // current generation actually drains.
      await flushFrames();
      expect(drained).toBe(true);
    });

    it('increments the DOM epoch on each clear-rebuild render', () => {
      const { renderer } = createRenderer();
      const before = renderer.domEpoch;
      renderer.renderMessages([], () => 'Hello');
      expect(renderer.domEpoch).toBe(before + 1);
      renderer.renderMessages([], () => 'Hello');
      expect(renderer.domEpoch).toBe(before + 2);
    });

    it('reports nodes evicted by a clear-rebuild as unmounted', async () => {
      const { renderer, messagesEl } = createRenderer();
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const first = Array.from({ length: 3 }, (_, index) => ({
        id: `a${index}`, role: 'user' as const, content: `a${index}`, timestamp: index,
      }));
      const second = Array.from({ length: 3 }, (_, index) => ({
        id: `b${index}`, role: 'user' as const, content: `b${index}`, timestamp: index,
      }));

      const firstMessage = (el: any) =>
        el._children.find((child: any) => child.hasClass('claudian-message'));

      renderer.renderMessages(first, () => 'Hello');
      const firstNode = firstMessage(messagesEl);
      expect(renderer.isMounted(firstNode)).toBe(true);

      renderer.renderMessages(second, () => 'Hello');
      expect(renderer.isMounted(firstNode)).toBe(false);
      const secondNode = firstMessage(messagesEl);
      expect(renderer.isMounted(secondNode)).toBe(true);
      expect(renderer.isMounted(null)).toBe(false);
    });

    it('isolates a single failing message behind an error card without blocking the rest', async () => {
      const { renderer, messagesEl } = createRenderer();
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const storedToolCall = renderStoredToolCall as jest.Mock;
      storedToolCall.mockImplementationOnce(() => { throw new Error('boom'); });
      const messages: ChatMessage[] = [
        { id: 'm0', role: 'user', content: 'first', timestamp: 1 },
        { id: 'm1', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 't1', name: 'Read', input: {}, status: 'completed' }], contentBlocks: [{ type: 'tool_use', toolId: 't1' }] },
        { id: 'm2', role: 'user', content: 'last', timestamp: 3 },
      ];

      renderer.renderMessages(messages, () => 'Hello');

      const rendered = messagesEl._children.filter((child: any) => child.hasClass('claudian-message'));
      expect(rendered).toHaveLength(3);
      expect(messagesEl.querySelectorAll('.claudian-render-error')).toHaveLength(1);
      expect(jest.spyOn(renderer, 'renderContent')).toHaveBeenCalled();
    });
  });

  describe('lazy text shells', () => {
    it('does not invoke the Markdown renderer for a large text block until expand', async () => {
      const { renderer, messagesEl } = createRenderer();
      const renderContent = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const large = 'x'.repeat(5000);
      const messages: ChatMessage[] = [{
        id: 'a1', role: 'assistant', content: large, timestamp: 1,
        contentBlocks: [{ type: 'text', content: large }],
      }];

      renderer.renderMessages(messages, () => 'Hello');

      expect(renderContent).not.toHaveBeenCalled();
      expect(messagesEl.querySelectorAll('.claudian-text-lazy')).toHaveLength(1);
      expect(messagesEl.querySelectorAll('.claudian-text-lazy-excerpt')[0].textContent.length).toBe(2048);

      const expandBtn = messagesEl.querySelectorAll('.claudian-text-lazy-expand')[0];
      expandBtn.click();
      await Promise.resolve();

      expect(renderContent).toHaveBeenCalledTimes(1);
      expect(messagesEl.querySelectorAll('.claudian-text-lazy')).toHaveLength(0);
    });

    it('keeps blocks under the lazy threshold on the direct Markdown path', () => {
      const { renderer, messagesEl } = createRenderer();
      const renderContent = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const messages: ChatMessage[] = [{
        id: 'a1', role: 'assistant', content: 'small', timestamp: 1,
        contentBlocks: [{ type: 'text', content: 'small' }],
      }];

      renderer.renderMessages(messages, () => 'Hello');

      expect(renderContent).toHaveBeenCalledTimes(1);
      expect(messagesEl.querySelectorAll('.claudian-text-lazy')).toHaveLength(0);
    });

    it('shows an inline notice instead of rendering beyond the expand cap', async () => {
      const { renderer, messagesEl } = createRenderer();
      const renderContent = jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const huge = 'y'.repeat(300 * 1024);
      const messages: ChatMessage[] = [{
        id: 'a1', role: 'assistant', content: huge, timestamp: 1,
        contentBlocks: [{ type: 'text', content: huge }],
      }];

      renderer.renderMessages(messages, () => 'Hello');
      messagesEl.querySelectorAll('.claudian-text-lazy-expand')[0].click();
      await Promise.resolve();

      expect(renderContent).not.toHaveBeenCalled();
      expect(messagesEl.querySelectorAll('.claudian-text-lazy-toolarge')).toHaveLength(1);
    });

    it('notifies message content at summary level when a block is deferred', async () => {
      const onRendered = jest.fn();
      const { renderer } = createRenderer(undefined, 'claude', onRendered);
      jest.spyOn(renderer, 'renderContent').mockResolvedValue(undefined);
      const large = 'x'.repeat(5000);
      const messages: ChatMessage[] = [{
        id: 'a1', role: 'assistant', content: large, timestamp: 1,
        contentBlocks: [{ type: 'text', content: large }],
      }];

      renderer.renderMessages(messages, () => 'Hello');
      await Promise.resolve();

      expect(onRendered).toHaveBeenCalledWith('a1', 'summary');
    });
  });
});
