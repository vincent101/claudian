import type { App, Component } from 'obsidian';
import { MarkdownRenderer, Notice } from 'obsidian';

import { DEFAULT_CHAT_PROVIDER_ID, type HistoryProjectionLevel,type ProviderCapabilities } from '../../../core/providers/types';
import {
  isSubagentToolName,
  isWriteEditTool,
  TOOL_AGENT_OUTPUT,
} from '../../../core/tools/toolNames';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import type { ChatMessage, ImageAttachment, SubagentInfo, ToolCallInfo } from '../../../core/types';
import { getLocale, t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';
import { formatDurationMmSs } from '../../../utils/date';
import { processFileLinks, registerFileLinkHandler } from '../../../utils/fileLink';
import { replaceImageEmbedsWithHtml } from '../../../utils/imageEmbed';
import { escapeMathDelimitersForStreaming } from '../../../utils/markdownMath';
import { HISTORY_RENDER_LIMITS } from '../history/HistoryResourcePolicy';
import { findRewindContext } from '../rewind';
import { resolveSubagentLifecycleAdapter } from './subagentLifecycleResolution';
import {
  renderStoredAsyncSubagent,
  renderStoredSubagent,
} from './SubagentRenderer';
import { renderStoredThinkingBlock } from './ThinkingBlockRenderer';
import { renderStoredToolCall } from './ToolCallRenderer';
import { renderStoredWriteEdit } from './WriteEditRenderer';

export interface RenderContentOptions {
  deferMath?: boolean;
}

export type RenderContentFn = (
  el: HTMLElement,
  markdown: string,
  options?: RenderContentOptions
) => Promise<void>;

export class MessageRenderer {
  private app: App;
  private plugin: ClaudianPlugin;
  private component: Component;
  private messagesEl: HTMLElement;
  private rewindCallback?: (messageId: string) => Promise<void>;
  private getCapabilities: () => ProviderCapabilities;
  private forkCallback?: (messageId: string) => Promise<void>;
  private liveMessageEls = new Map<string, HTMLElement>();
  private readonly contentRenderGenerations = new Map<string, number>();
  private readonly pendingContentRenders = new Map<string, Promise<void>>();
  private readonly onMessageContentRendered?: (projectionKey: string, projectionLevel: HistoryProjectionLevel) => void;
  private renderGeneration = 0;
  private renderIdlePromise: Promise<void> = Promise.resolve();
  private renderIdleResolver: (() => void) | null = null;

  private static readonly REWIND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;

  private static readonly FORK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>`;

  constructor(
    plugin: ClaudianPlugin,
    component: Component,
    messagesEl: HTMLElement,
    rewindCallback?: (messageId: string) => Promise<void>,
    forkCallback?: (messageId: string) => Promise<void>,
    getCapabilities?: () => ProviderCapabilities,
    onMessageContentRendered?: (projectionKey: string, projectionLevel: HistoryProjectionLevel) => void,
  ) {
    this.app = plugin.app;
    this.plugin = plugin;
    this.component = component;
    this.messagesEl = messagesEl;
    this.rewindCallback = rewindCallback;
    this.forkCallback = forkCallback;
    this.onMessageContentRendered = onMessageContentRendered;
    this.getCapabilities = getCapabilities ?? (() => ({
      providerId: DEFAULT_CHAT_PROVIDER_ID,
      supportsPersistentRuntime: false,
      supportsNativeHistory: false,
      supportsPlanMode: false,
      supportsRewind: false,
      supportsFork: false,
      supportsProviderCommands: false,
      supportsImageAttachments: false,
      supportsInstructionMode: false,
      supportsMcpTools: false,
      supportsTurnSteer: false,
      reasoningControl: 'none' as const,
    }));

    // Register delegated click handler for file links
    registerFileLinkHandler(this.app, this.messagesEl, this.component);
  }

  /** Sets the messages container element. */
  setMessagesEl(el: HTMLElement): void {
    this.messagesEl = el;
  }

  private getSubagentLifecycleAdapter(toolName?: string) {
    return resolveSubagentLifecycleAdapter(this.getCapabilities().providerId, toolName);
  }

  async renderMessageContent(
    projectionKey: string,
    jobs: Array<Promise<void>>,
    projectionLevel: HistoryProjectionLevel = 'detail',
  ): Promise<void> {
    const generation = (this.contentRenderGenerations.get(projectionKey) ?? 0) + 1;
    this.contentRenderGenerations.set(projectionKey, generation);
    const pending = Promise.all(jobs).then(() => {
      if (this.contentRenderGenerations.get(projectionKey) !== generation) return;
      this.onMessageContentRendered?.(projectionKey, projectionLevel);
    });
    this.pendingContentRenders.set(projectionKey, pending);
    try {
      await pending;
    } finally {
      if (this.pendingContentRenders.get(projectionKey) === pending) {
        this.pendingContentRenders.delete(projectionKey);
      }
    }
  }

  async waitForMessageContentRendered(projectionKey: string): Promise<void> {
    await this.pendingContentRenders.get(projectionKey);
  }

  async renderSearchCandidate(message: ChatMessage): Promise<HTMLElement> {
    const root = this.messagesEl.ownerDocument.createElement('div');
    root.className = `claudian-message claudian-message-${message.role}`;
    root.dataset.messageId = message.id;
    const content = root.createDiv({ cls: 'claudian-message-content' });
    const jobs: Array<Promise<void>> = [];
    if (message.role === 'user') {
      const markdown = message.displayContent ?? message.content;
      if (markdown) jobs.push(this.renderContent(content.createDiv({ cls: 'claudian-text-block' }), markdown));
    } else {
      for (const block of message.contentBlocks ?? []) {
        if (block.type === 'text' && block.content.trim()) {
          jobs.push(this.renderContent(content.createDiv({ cls: 'claudian-text-block' }), block.content));
        }
      }
      if (jobs.length === 0 && message.content) {
        jobs.push(this.renderContent(content.createDiv({ cls: 'claudian-text-block' }), message.content));
      }
    }
    await Promise.all(jobs);
    return root;
  }

  // ============================================
  // Streaming Message Rendering
  // ============================================

  /**
   * Adds a new message to the chat during streaming.
   * Returns the message element for content updates.
   */
  addMessage(msg: ChatMessage): HTMLElement {
    // Render images above message bubble for user messages
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    // Skip empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (!textToShow) {
        this.scrollToBottom();
        const lastChild = this.messagesEl.lastElementChild as HTMLElement;
        return lastChild ?? this.messagesEl;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
      attr: {
        'data-message-id': msg.id,
        'data-role': msg.role,
      },
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content', attr: { dir: 'auto' } });

    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (textToShow) {
        const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
        void this.renderMessageContent(msg.id, [this.renderContent(textEl, textToShow)]);
        this.addUserCopyButton(msgEl, textToShow);
      }
      if (this.rewindCallback || this.forkCallback) {
        this.liveMessageEls.set(msg.id, msgEl);
      }
    }
    this.addMessageTimestamp(msgEl, msg.timestamp);

    this.scrollToBottom();
    return msgEl;
  }

  updateLiveUserMessage(msg: ChatMessage): void {
    if (msg.role !== 'user') {
      return;
    }

    const msgEl = this.liveMessageEls.get(msg.id)
      ?? this.messagesEl.querySelector(`[data-message-id="${msg.id}"]`) as HTMLElement | null;
    if (!msgEl) {
      return;
    }

    const contentEl = msgEl.querySelector('.claudian-message-content') as HTMLElement | null;
    if (!contentEl) {
      return;
    }

    contentEl.empty();

    const textToShow = msg.displayContent ?? msg.content;
    if (textToShow) {
      const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
      void this.renderMessageContent(msg.id, [this.renderContent(textEl, textToShow)]);
    }

    const toolbar = msgEl.querySelector('.claudian-message-actions') as HTMLElement | null;
    if (toolbar) {
      toolbar.querySelectorAll('.claudian-user-msg-copy-btn').forEach((el) => el.remove());
    }

    if (textToShow) {
      this.addUserCopyButton(msgEl, textToShow);
    }
  }

  removeMessage(messageId: string): void {
    const msgEl = this.liveMessageEls.get(messageId)
      ?? this.messagesEl.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (!msgEl) {
      return;
    }

    msgEl.remove();
    this.liveMessageEls.delete(messageId);
  }

  // ============================================
  // Stored Message Rendering (Batch/Replay)
  // ============================================

  /**
   * Renders all messages for conversation load/switch.
   * The first slice mounts synchronously so small conversations appear
   * immediately; further slices mount per animation frame so the browser can
   * paint between them (B1 frame-batched rendering).
   * @param messages Array of messages to render
   * @param getGreeting Function to get greeting text
   * @returns The newly created welcome element
   */
  renderMessages(
    messages: ChatMessage[],
    getGreeting: () => string
  ): HTMLElement {
    this.messagesEl.empty();
    this.liveMessageEls.clear();

    // Recreate welcome element after clearing
    const newWelcomeEl = this.messagesEl.createDiv({ cls: 'claudian-welcome' });
    newWelcomeEl.createDiv({ cls: 'claudian-welcome-greeting', text: getGreeting() });

    this.startBatchedRender(messages, messages, false);
    return newWelcomeEl;
  }

  prependMessages(messages: ChatMessage[], allMessages: ChatMessage[]): void {
    this.startBatchedRender(messages, allMessages, true);
  }

  /** Resolves once the current batched render queue has fully mounted. */
  waitForRenderedMessages(): Promise<void> {
    return this.renderIdlePromise;
  }

  private scheduleFrame(callback: () => void): void {
    // Node test environments may lack requestAnimationFrame; the fallback
    // still yields the event loop between slices.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
    else setTimeout(() => callback(), 0);
  }

  private startBatchedRender(
    messages: ChatMessage[],
    allMessages: ChatMessage[],
    prepend: boolean,
  ): void {
    const generation = ++this.renderGeneration;
    // Superseding render: the previous queue stops and its waiter resolves.
    this.renderIdleResolver?.();
    let resolveIdle!: () => void;
    this.renderIdlePromise = new Promise<void>(resolve => { resolveIdle = resolve; });
    this.renderIdleResolver = resolveIdle;
    const complete = (): void => {
      if (this.renderIdleResolver === resolveIdle) this.renderIdleResolver = null;
      resolveIdle();
    };
    const step = (from: number): void => {
      if (generation !== this.renderGeneration) {
        complete();
        return;
      }
      const sliceStart = performance.now();
      const original = this.messagesEl;
      const fragment = prepend
        ? document.createDocumentFragment()
        : null;
      if (fragment) this.messagesEl = fragment as unknown as HTMLElement;
      let index = from;
      try {
        while (
          index < messages.length
          && index - from < HISTORY_RENDER_LIMITS.renderBatchMessages
          && (index === from || performance.now() - sliceStart < HISTORY_RENDER_LIMITS.renderTimeSliceMs)
        ) {
          this.renderStoredMessage(messages[index], allMessages, index);
          index += 1;
        }
      } finally {
        if (fragment) this.messagesEl = original;
      }
      if (fragment) {
        const anchor = original.querySelector('.claudian-message') as HTMLElement | null;
        const before = anchor?.getBoundingClientRect().top ?? 0;
        original.insertBefore(fragment, anchor);
        if (anchor) original.scrollTop += anchor.getBoundingClientRect().top - before;
      }
      if (index < messages.length) {
        this.scheduleFrame(() => step(index));
        return;
      }
      if (!prepend) this.scrollToBottom();
      complete();
    };
    step(0);
  }

  renderHistoryPager(
    hasMore: boolean,
    loading: boolean,
    error: string | null,
    onLoad: () => void,
  ): void {
    this.messagesEl.querySelector('.claudian-history-pager')?.remove();
    if (!hasMore && !error) return;
    const pager = document.createElement('div');
    pager.className = 'claudian-history-pager';
    const button = document.createElement('button');
    button.textContent = loading ? 'Loading earlier messages…' : (error ? 'Retry loading earlier messages' : 'Load earlier messages');
    button.disabled = loading;
    button.addEventListener('click', onLoad);
    pager.appendChild(button);
    if (error) {
      const detail = document.createElement('div');
      detail.className = 'claudian-history-pager-error';
      detail.textContent = error;
      pager.appendChild(detail);
    }
    this.messagesEl.insertBefore(pager, this.messagesEl.firstChild);
  }

  findMessageElement(messageKey: string): HTMLElement | null {
    return this.messagesEl.querySelector(`[data-message-id="${CSS.escape(messageKey)}"]`) as HTMLElement | null;
  }

  highlightSearchMatch(messageEl: HTMLElement, matchedText: string, matchOrdinal = 0): void {
    messageEl.querySelectorAll('mark.claudian-search-match').forEach(mark => mark.replaceWith(mark.textContent ?? ''));
    const needle = matchedText.toLocaleLowerCase();
    if (needle) {
      const walker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let remaining = matchOrdinal;
      while (node) {
        const text = node.textContent ?? '';
        let from = 0;
        let matchStart = text.toLocaleLowerCase().indexOf(needle, from);
        while (matchStart >= 0) {
          if (remaining === 0) {
            const mark = document.createElement('mark');
            mark.className = 'claudian-search-match';
            mark.textContent = text.slice(matchStart, matchStart + matchedText.length);
            const after = (node as Text).splitText(matchStart);
            after.deleteData(0, matchedText.length);
            after.parentNode?.insertBefore(mark, after);
            node = null;
            break;
          }
          remaining -= 1;
          from = matchStart + needle.length;
          matchStart = text.toLocaleLowerCase().indexOf(needle, from);
        }
        node = node ? walker.nextNode() : null;
      }
    }
    messageEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    messageEl.classList.remove('claudian-search-highlight');
    void messageEl.offsetWidth;
    messageEl.classList.add('claudian-search-highlight');
    setTimeout(() => messageEl.classList.remove('claudian-search-highlight'), 1600);
  }

  renderStoredMessage(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    try {
      this.renderStoredMessageBody(msg, allMessages, index);
    } catch {
      // One broken message must not block the rest of the batch (B1 rule).
      const msgEl = this.messagesEl.createDiv({
        cls: `claudian-message claudian-message-${msg.role}`,
        attr: { 'data-message-id': msg.id, 'data-role': msg.role },
      });
      const contentEl = msgEl.createDiv({ cls: 'claudian-message-content' });
      contentEl.createDiv({ cls: 'claudian-render-error', text: 'Failed to render this message.' });
    }
  }

  private renderStoredMessageBody(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    // Bare interrupt marker: user-role interrupts (Claude bracket markers) always render
    // as a standalone indicator. Assistant-role interrupts (Codex partial responses)
    // only use the bare marker when there's no content to preserve.
    if (msg.isInterrupt && (msg.role === 'user' || !this.hasVisibleContent(msg))) {
      this.renderInterruptMessage();
      return;
    }

    // Skip rebuilt context messages (history sent to SDK on session reset)
    // These are internal context for the AI, not actual user messages to display
    if (msg.isRebuiltContext) {
      return;
    }

    // Render images above bubble for user messages
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      this.renderMessageImages(this.messagesEl, msg.images);
    }

    // Skip empty bubble for image-only messages
    if (msg.role === 'user') {
      const textToShow = msg.displayContent ?? msg.content;
      if (!textToShow) {
        return;
      }
    }

    const msgEl = this.messagesEl.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
      attr: {
        'data-message-id': msg.id,
        'data-role': msg.role,
      },
    });

    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content', attr: { dir: 'auto' } });

    try {
      if (msg.role === 'user') {
        const textToShow = msg.displayContent ?? msg.content;
        let deferred = false;
        if (textToShow) {
          deferred = this.renderTextContent(contentEl, textToShow, []);
          this.addUserCopyButton(msgEl, textToShow);
        }
        // Summary completion must not masquerade as detail completion (B1
        // rule): a message with deferred shells notifies at summary level.
        void this.renderMessageContent(msg.id, [], deferred ? 'summary' : 'detail');
        if (msg.userMessageId && this.isRewindEligible(allMessages, index)) {
          if (this.rewindCallback) {
            this.addRewindButton(msgEl, msg.id);
          }
          if (this.forkCallback) {
            this.addForkButton(msgEl, msg.id);
          }
        }
      } else if (msg.role === 'assistant') {
        const jobs: Array<Promise<void>> = [];
        const deferred = this.renderAssistantContent(msg, contentEl, jobs);
        void this.renderMessageContent(msg.id, jobs, deferred ? 'summary' : 'detail');
        if (msg.isInterrupt) {
          this.appendInterruptIndicator(contentEl);
        }
      }
    } catch {
      // Replace partial content with an error card instead of leaving a
      // half-built message or appending a duplicate bubble.
      contentEl.empty();
      contentEl.createDiv({ cls: 'claudian-render-error', text: 'Failed to render this message.' });
    }
    this.addMessageTimestamp(msgEl, msg.timestamp);
  }

  private hasVisibleContent(msg: ChatMessage): boolean {
    if (msg.content && msg.content.trim().length > 0) return true;
    if (msg.toolCalls && msg.toolCalls.length > 0) return true;
    if (msg.contentBlocks && msg.contentBlocks.length > 0) return true;
    return false;
  }

  private isRewindEligible(allMessages?: ChatMessage[], index?: number): boolean {
    if (!allMessages || index === undefined) return false;
    const ctx = findRewindContext(allMessages, index);
    return !!ctx.prevAssistantUuid && ctx.hasResponse;
  }

  private renderInterruptMessage(): void {
    const msgEl = this.messagesEl.createDiv({ cls: 'claudian-message claudian-message-assistant' });
    const contentEl = msgEl.createDiv({ cls: 'claudian-message-content', attr: { dir: 'auto' } });
    this.appendInterruptIndicator(contentEl);
  }

  private appendInterruptIndicator(contentEl: HTMLElement): void {
    const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
    textEl.innerHTML = '<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>';
  }

  /**
   * Renders assistant message content (content blocks or fallback).
   * Returns whether any large text block was deferred to a lazy shell.
   */
  private renderAssistantContent(
    msg: ChatMessage,
    contentEl: HTMLElement,
    jobs: Array<Promise<void>>,
  ): boolean {
    let deferred = false;
    if (msg.contentBlocks && msg.contentBlocks.length > 0) {
      const renderedToolIds = new Set<string>();
      for (const block of msg.contentBlocks) {
        if (block.type === 'thinking') {
          renderStoredThinkingBlock(
            contentEl,
            block.content,
            block.durationSeconds,
            (el, md) => this.renderContent(el, md)
          );
        } else if (block.type === 'text') {
          // Skip empty or whitespace-only text blocks to avoid extra gaps
          if (!block.content || !block.content.trim()) {
            continue;
          }
          if (this.renderTextContent(contentEl, block.content, jobs)) deferred = true;
        } else if (block.type === 'tool_use') {
          const toolCall = msg.toolCalls?.find(tc => tc.id === block.toolId);
          if (toolCall) {
            this.renderToolCall(contentEl, toolCall, msg);
            renderedToolIds.add(toolCall.id);
          }
        } else if (block.type === 'context_compacted') {
          const boundaryEl = contentEl.createDiv({ cls: 'claudian-compact-boundary' });
          boundaryEl.createSpan({ cls: 'claudian-compact-boundary-label', text: 'Conversation compacted' });
        } else if (block.type === 'subagent') {
          const taskToolCall = msg.toolCalls?.find(
            tc => tc.id === block.subagentId && isSubagentToolName(tc.name)
          );
          if (!taskToolCall) continue;

          this.renderTaskSubagent(contentEl, taskToolCall, block.mode);
          renderedToolIds.add(taskToolCall.id);
        }
      }

      // Defensive fallback: preserve tool visibility when contentBlocks/toolCalls drift on reload.
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          if (renderedToolIds.has(toolCall.id)) continue;
          this.renderToolCall(contentEl, toolCall, msg);
          renderedToolIds.add(toolCall.id);
        }
      }
    } else {
      // Fallback for old conversations without contentBlocks
      if (msg.content) {
        if (this.renderTextContent(contentEl, msg.content, jobs)) deferred = true;
      }
      if (msg.toolCalls) {
        for (const toolCall of msg.toolCalls) {
          this.renderToolCall(contentEl, toolCall, msg);
        }
      }
    }

    // Render response duration footer (skip when message contains a compaction boundary)
    const hasCompactBoundary = msg.contentBlocks?.some(b => b.type === 'context_compacted');
    if (msg.durationSeconds && msg.durationSeconds > 0 && !hasCompactBoundary) {
      const flavorWord = msg.durationFlavorWord || 'Baked';
      const footerEl = contentEl.createDiv({ cls: 'claudian-response-footer' });
      footerEl.createSpan({
        text: `* ${flavorWord} for ${formatDurationMmSs(msg.durationSeconds)}`,
        cls: 'claudian-baked-duration',
      });
    }
    return deferred;
  }

  /**
   * Renders one text block: small blocks render Markdown immediately; large
   * blocks mount a plain-text shell first and only invoke the Markdown
   * renderer on explicit expand (B1 lazy body).
   * Returns whether the block was deferred.
   */
  private renderTextContent(
    contentEl: HTMLElement,
    text: string,
    jobs: Array<Promise<void>>,
  ): boolean {
    if (text.length <= HISTORY_RENDER_LIMITS.lazyTextChars) {
      const textEl = contentEl.createDiv({ cls: 'claudian-text-block' });
      jobs.push(this.renderContent(textEl, text));
      this.addTextCopyButton(textEl, text);
      return false;
    }
    this.addLazyTextShell(contentEl, text);
    return true;
  }

  private addLazyTextShell(contentEl: HTMLElement, text: string): void {
    const shell = contentEl.createDiv({ cls: 'claudian-text-block claudian-text-lazy' });
    const excerptEl = shell.createDiv({ cls: 'claudian-text-lazy-excerpt' });
    excerptEl.setText(text.slice(0, HISTORY_RENDER_LIMITS.shellExcerptChars));
    shell.createDiv({
      cls: 'claudian-text-lazy-note',
      text: t('chat.message.contentTruncatedNote', { count: String(text.length) }),
    });
    const expandBtn = shell.createDiv({
      cls: 'claudian-text-lazy-expand',
      text: t('chat.message.expandFullContent'),
      attr: { role: 'button', tabindex: '0' },
    });
    expandBtn.addEventListener('click', () => {
      void this.expandLazyTextShell(shell, text);
    });
  }

  private async expandLazyTextShell(shell: HTMLElement, text: string): Promise<void> {
    if (text.length > HISTORY_RENDER_LIMITS.expandRenderMaxChars) {
      // Chunked detail loading lands with B2; until then an explicit notice
      // is the honest alternative to a multi-second Markdown freeze.
      if (!shell.querySelector('.claudian-text-lazy-toolarge')) {
        shell.createDiv({
          cls: 'claudian-text-lazy-toolarge',
          text: t('chat.message.tooLargeToRender', { count: String(text.length) }),
        });
      }
      return;
    }
    shell.removeClass('claudian-text-lazy');
    await this.renderContent(shell, text);
    this.addTextCopyButton(shell, text);
  }

  /**
   * Renders a tool call with special handling for Write/Edit, Agent (subagent),
   * and Codex collab agent lifecycle tools.
   */
  private renderToolCall(contentEl: HTMLElement, toolCall: ToolCallInfo, msg?: ChatMessage): void {
    const subagentLifecycleAdapter = this.getSubagentLifecycleAdapter(toolCall.name);

    // Skip invisible internal tools
    if (toolCall.name === TOOL_AGENT_OUTPUT) return;
    if (subagentLifecycleAdapter?.isHiddenTool(toolCall.name)) return;

    if (isWriteEditTool(toolCall.name)) {
      renderStoredWriteEdit(contentEl, toolCall);
    } else if (isSubagentToolName(toolCall.name)) {
      this.renderTaskSubagent(contentEl, toolCall);
    } else if (subagentLifecycleAdapter?.isSpawnTool(toolCall.name) && msg) {
      this.renderProviderLifecycleSubagent(contentEl, toolCall, msg);
    } else {
      renderStoredToolCall(contentEl, toolCall);
    }
  }

  private renderTaskSubagent(
    contentEl: HTMLElement,
    toolCall: ToolCallInfo,
    modeHint?: 'sync' | 'async'
  ): void {
    const subagentInfo = this.resolveTaskSubagent(toolCall, modeHint);
    if (subagentInfo.mode === 'async') {
      renderStoredAsyncSubagent(contentEl, subagentInfo);
      return;
    }
    renderStoredSubagent(contentEl, subagentInfo);
  }

  /**
   * Consolidates provider lifecycle tools (spawn + wait/close)
   * into a single subagent block with prompt and result.
   */
  private renderProviderLifecycleSubagent(
    contentEl: HTMLElement,
    spawnToolCall: ToolCallInfo,
    msg: ChatMessage,
  ): void {
    const subagentLifecycleAdapter = this.getSubagentLifecycleAdapter(spawnToolCall.name);
    if (!subagentLifecycleAdapter) {
      renderStoredToolCall(contentEl, spawnToolCall);
      return;
    }

    const subagentInfo = subagentLifecycleAdapter.buildSubagentInfo(
      spawnToolCall,
      msg.toolCalls ?? [],
    );
    renderStoredSubagent(contentEl, subagentInfo);
  }

  private resolveTaskSubagent(toolCall: ToolCallInfo, modeHint?: 'sync' | 'async'): SubagentInfo {
    if (toolCall.subagent) {
      if (!modeHint || toolCall.subagent.mode === modeHint) {
        return toolCall.subagent;
      }
      return {
        ...toolCall.subagent,
        mode: modeHint,
      };
    }

    const description = (toolCall.input?.description as string) || 'Subagent task';
    const prompt = (toolCall.input?.prompt as string) || '';
    const mode = modeHint ?? (toolCall.input?.run_in_background === true ? 'async' : 'sync');

    if (mode !== 'async') {
      return {
        id: toolCall.id,
        description,
        prompt,
        status: this.mapToolStatusToSubagentStatus(toolCall.status),
        toolCalls: [],
        isExpanded: false,
        result: toolCall.result,
      };
    }

    const asyncStatus = this.inferAsyncStatusFromTaskTool(toolCall);
    return {
      id: toolCall.id,
      description,
      prompt,
      mode: 'async',
      status: asyncStatus,
      asyncStatus,
      toolCalls: [],
      isExpanded: false,
      result: toolCall.result,
    };
  }

  private mapToolStatusToSubagentStatus(
    status: ToolCallInfo['status']
  ): 'completed' | 'error' | 'running' {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'error':
      case 'blocked':
        return 'error';
      default:
        return 'running';
    }
  }

  private inferAsyncStatusFromTaskTool(toolCall: ToolCallInfo): 'running' | 'completed' | 'error' {
    if (toolCall.status === 'error' || toolCall.status === 'blocked') return 'error';
    if (toolCall.status === 'running') return 'running';

    const lowerResult = extractToolResultContent(toolCall.result, { fallbackIndent: 2 }).toLowerCase();
    if (
      lowerResult.includes('not_ready') ||
      lowerResult.includes('not ready') ||
      lowerResult.includes('"status":"running"') ||
      lowerResult.includes('"status":"pending"') ||
      lowerResult.includes('"retrieval_status":"running"') ||
      lowerResult.includes('"retrieval_status":"not_ready"')
    ) {
      return 'running';
    }

    return 'completed';
  }

  // ============================================
  // Image Rendering
  // ============================================

  /**
   * Renders image attachments above a message.
   */
  renderMessageImages(containerEl: HTMLElement, images: ImageAttachment[]): void {
    const imagesEl = containerEl.createDiv({ cls: 'claudian-message-images' });

    for (const image of images) {
      const imageWrapper = imagesEl.createDiv({ cls: 'claudian-message-image' });
      const imgEl = imageWrapper.createEl('img', {
        attr: {
          alt: image.name,
        },
      });

      void this.setImageSrc(imgEl, image);

      // Click to view full size
      imgEl.addEventListener('click', () => {
        void this.showFullImage(image);
      });
    }
  }

  /**
   * Shows full-size image in modal overlay.
   */
  showFullImage(image: ImageAttachment): void {
    const dataUri = `data:${image.mediaType};base64,${image.data}`;

    const overlay = document.body.createDiv({ cls: 'claudian-image-modal-overlay' });
    const modal = overlay.createDiv({ cls: 'claudian-image-modal' });

    modal.createEl('img', {
      attr: {
        src: dataUri,
        alt: image.name,
      },
    });

    const closeBtn = modal.createDiv({ cls: 'claudian-image-modal-close' });
    closeBtn.setText('\u00D7');

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    const close = () => {
      document.removeEventListener('keydown', handleEsc);
      overlay.remove();
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', handleEsc);
  }

  /**
   * Sets image src from attachment data.
   */
  setImageSrc(imgEl: HTMLImageElement, image: ImageAttachment): void {
    const dataUri = `data:${image.mediaType};base64,${image.data}`;
    imgEl.setAttribute('src', dataUri);
  }

  // ============================================
  // Content Rendering
  // ============================================

  /**
   * Renders markdown content with code block enhancements.
   */
  async renderContent(
    el: HTMLElement,
    markdown: string,
    options?: RenderContentOptions
  ): Promise<void> {
    el.empty();

    try {
      const renderMarkdown = options?.deferMath
        ? escapeMathDelimitersForStreaming(markdown)
        : markdown;
      // Normalize embeds before MarkdownRenderer consumes them.
      const processedMarkdown = replaceImageEmbedsWithHtml(
        renderMarkdown,
        this.app,
        this.plugin.settings.mediaFolder
      );
      await MarkdownRenderer.renderMarkdown(
        processedMarkdown,
        el,
        '',
        this.component
      );

      // Wrap pre elements and move buttons outside scroll area
      el.querySelectorAll('pre').forEach((pre) => {
        // Skip if already wrapped
        if (pre.parentElement?.classList.contains('claudian-code-wrapper')) return;

        // Create wrapper
        const wrapper = createEl('div', { cls: 'claudian-code-wrapper' });
        pre.parentElement?.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        // Check for language class and add label
        const code = pre.querySelector('code[class*="language-"]');
        if (code) {
          const match = code.className.match(/language-(\w+)/);
          if (match) {
            wrapper.classList.add('has-language');
            const label = createEl('span', {
              cls: 'claudian-code-lang-label',
              text: match[1],
            });
            wrapper.appendChild(label);
            label.addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(code.textContent || '');
                label.setText('copied!');
                setTimeout(() => label.setText(match[1]), 1500);
              } catch {
                // Clipboard API may fail in non-secure contexts
              }
            });
          }
        }

        // Move Obsidian's copy button outside pre into wrapper
        const copyBtn = pre.querySelector('.copy-code-button');
        if (copyBtn) {
          wrapper.appendChild(copyBtn);
        }
      });

      // Process wikilinks only when the source can contain them; the DOM pass is expensive.
      if (processedMarkdown.includes('[[')) {
        processFileLinks(this.app, el);
      }
    } catch {
      el.createDiv({
        cls: 'claudian-render-error',
        text: 'Failed to render message content.',
      });
    }
  }

  // ============================================
  // Copy Button
  // ============================================

  /** Clipboard icon SVG for copy button. */
  private static readonly COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  /**
   * Adds a copy button to a text block.
   * Button shows clipboard icon on hover, changes to "copied!" on click.
   * @param textEl The rendered text element
   * @param markdown The original markdown content to copy
   */
  addTextCopyButton(textEl: HTMLElement, markdown: string): void {
    const copyBtn = textEl.createSpan({ cls: 'claudian-text-copy-btn' });
    copyBtn.innerHTML = MessageRenderer.COPY_ICON;

    let feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      try {
        await navigator.clipboard.writeText(markdown);
      } catch {
        // Clipboard API may fail in non-secure contexts
        return;
      }

      // Clear any pending timeout from rapid clicks
      if (feedbackTimeout) {
        clearTimeout(feedbackTimeout);
      }

      // Show "copied!" feedback
      copyBtn.innerHTML = '';
      copyBtn.setText('copied!');
      copyBtn.classList.add('copied');

      feedbackTimeout = setTimeout(() => {
        copyBtn.innerHTML = MessageRenderer.COPY_ICON;
        copyBtn.classList.remove('copied');
        feedbackTimeout = null;
      }, 1500);
    });
  }

  refreshActionButtons(msg: ChatMessage, allMessages?: ChatMessage[], index?: number): void {
    if (!msg.userMessageId) return;
    if (!this.isRewindEligible(allMessages, index)) return;
    const msgEl = this.liveMessageEls.get(msg.id);
    if (!msgEl) return;

    if (this.rewindCallback && !msgEl.querySelector('.claudian-message-rewind-btn')) {
      this.addRewindButton(msgEl, msg.id);
    }
    if (this.forkCallback && !msgEl.querySelector('.claudian-message-fork-btn')) {
      this.addForkButton(msgEl, msg.id);
    }
    this.cleanupLiveMessageEl(msg.id, msgEl);
  }

  private cleanupLiveMessageEl(msgId: string, msgEl: HTMLElement): void {
    const needsRewind = this.rewindCallback && !msgEl.querySelector('.claudian-message-rewind-btn');
    const needsFork = this.forkCallback && !msgEl.querySelector('.claudian-message-fork-btn');
    if (!needsRewind && !needsFork) {
      this.liveMessageEls.delete(msgId);
    }
  }

  private getOrCreateActionsToolbar(msgEl: HTMLElement): HTMLElement {
    const existing = msgEl.querySelector('.claudian-message-actions') as HTMLElement | null;
    if (existing) return existing;
    return msgEl.createDiv({ cls: 'claudian-message-actions' });
  }

  private addMessageTimestamp(msgEl: HTMLElement, timestamp: number): void {
    if (!Number.isFinite(timestamp)) return;
    const toolbar = this.getOrCreateActionsToolbar(msgEl);
    if (toolbar.querySelector('.claudian-message-timestamp')) return;
    const formatted = new Intl.DateTimeFormat(getLocale(), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(timestamp));
    const timeEl = toolbar.createSpan({
      cls: 'claudian-message-timestamp',
      text: formatted,
    });
    timeEl.setAttribute('aria-label', t('chat.message.timestamp', { time: formatted }));
  }

  private addUserCopyButton(msgEl: HTMLElement, content: string): void {
    const toolbar = this.getOrCreateActionsToolbar(msgEl);
    const copyBtn = toolbar.createSpan({ cls: 'claudian-user-msg-copy-btn' });
    copyBtn.innerHTML = MessageRenderer.COPY_ICON;
    copyBtn.setAttribute('aria-label', 'Copy message');

    let feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        return;
      }
      if (feedbackTimeout) clearTimeout(feedbackTimeout);
      copyBtn.innerHTML = '';
      copyBtn.setText('copied!');
      copyBtn.classList.add('copied');
      feedbackTimeout = setTimeout(() => {
        copyBtn.innerHTML = MessageRenderer.COPY_ICON;
        copyBtn.classList.remove('copied');
        feedbackTimeout = null;
      }, 1500);
    });
  }

  private addRewindButton(msgEl: HTMLElement, messageId: string): void {
    if (!this.getCapabilities().supportsRewind) return;
    const toolbar = this.getOrCreateActionsToolbar(msgEl);
    const btn = toolbar.createSpan({ cls: 'claudian-message-rewind-btn' });
    if (toolbar.firstChild !== btn) toolbar.insertBefore(btn, toolbar.firstChild);
    btn.innerHTML = MessageRenderer.REWIND_ICON;
    btn.setAttribute('aria-label', t('chat.rewind.ariaLabel'));
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await this.rewindCallback?.(messageId);
      } catch (err) {
        new Notice(t('chat.rewind.failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
      }
    });
  }

  private addForkButton(msgEl: HTMLElement, messageId: string): void {
    if (!this.getCapabilities().supportsFork) return;
    const toolbar = this.getOrCreateActionsToolbar(msgEl);
    const btn = toolbar.createSpan({ cls: 'claudian-message-fork-btn' });
    if (toolbar.firstChild !== btn) toolbar.insertBefore(btn, toolbar.firstChild);
    btn.innerHTML = MessageRenderer.FORK_ICON;
    btn.setAttribute('aria-label', t('chat.fork.ariaLabel'));
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await this.forkCallback?.(messageId);
      } catch (err) {
        new Notice(t('chat.fork.failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
      }
    });
  }

  // ============================================
  // Utilities
  // ============================================

  /** Scrolls messages container to bottom. */
  scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Scrolls to bottom if already near bottom (within threshold). */
  scrollToBottomIfNeeded(threshold = 100): void {
    const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < threshold;
    if (isNearBottom) {
      requestAnimationFrame(() => {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
    }
  }

}
