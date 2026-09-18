import type { HistoryWindowPage } from '../../../core/providers/types';
import type { ChatMessage } from '../../../core/types';
import { recordHistoryRenderEvent } from '../history/HistoryDiagnostics';
import type { HistoryPageRecord, HistoryPageStore } from '../history/HistoryPageStore';
import type { ProjectionWriteCoordinator, StoredIntentDirection } from './ProjectionWriteCoordinator';

export const HISTORY_WINDOWING_ENABLED = true;
export const HISTORY_WINDOW_LIMITS = {
  enableTurns: 250,
  enableProjectedWeight: 16 * 1024 * 1024,
  softMountedTurns: 180,
  hardMountedTurns: 200,
  settleTimeoutMs: 3000,
} as const;

export interface HistoryPageInput extends Pick<HistoryWindowPage, 'pageKey' | 'range' | 'messages'> {
  projectedWeight: number;
}

type WindowIntent = {
  direction: StoredIntentDirection;
  conversationId: string | null;
  domEpoch: number;
  sequence: number;
};

export interface HistoryWindowRendererOptions {
  root: HTMLElement;
  viewport: HTMLElement;
  pageStore: HistoryPageStore;
  coordinator: ProjectionWriteCoordinator;
  getConversationId: () => string | null;
  getDomEpoch: () => number;
  isLive: () => boolean;
  renderPage: (record: HistoryPageRecord, wrapper: HTMLElement, ticket: number) => void;
  clearPageReferences?: (messageIds: string[], wrapper: HTMLElement, record: HistoryPageRecord) => void;
  invalidateDomEpoch?: () => void;
  restorePageUiState?: (wrapper: HTMLElement, record: HistoryPageRecord) => void;
  onPageSettled?: (wrapper: HTMLElement, record: HistoryPageRecord) => void;
  rematerializePage?: (record: HistoryPageRecord) => Promise<HistoryPageInput | null>;
}

export class HistoryWindowRenderer {
  private readonly wrappers = new Map<string, HTMLElement>();
  private readonly pendingIntents = new Map<StoredIntentDirection, WindowIntent>();
  private readonly visiblePages = new Set<string>();
  private readonly adjacentPages = new Set<string>();
  private pendingVisiblePages: Set<string> | null = null;
  private readonly rematerializations = new Map<string, Promise<boolean>>();
  private readonly resizeObserver: ResizeObserver | null;
  private readonly viewportResizeObserver: ResizeObserver | null;
  private readonly themeObserver: MutationObserver | null;
  private rafId: number | null = null;
  private sequence = 0;
  private committedIntents = 0;
  private totalTurns = 0;
  private generation = 0;
  private lastScrollTop = 0;
  private livePageKey: string | null = null;
  private disposed = false;
  private readonly onViewportChange = (): void => this.sampleViewport();

  constructor(private readonly options: HistoryWindowRendererOptions) {
    this.resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      for (const entry of entries) {
        const wrapper = entry.target as HTMLElement;
        const pageKey = wrapper.dataset.pageKey;
        if (!pageKey) continue;
        const record = this.options.pageStore.peek(pageKey);
        if (!record || record.renderState !== 'mounted') continue;
        const quality = this.options.pageStore.isTicketSettled(pageKey, record.renderTicket)
          ? 'measured'
          : 'estimated';
        this.options.pageStore.recordHeight(
          pageKey,
          record.renderTicket,
          entry.contentRect.height,
          this.options.viewport.clientWidth,
          quality,
        );
      }
    });
    this.viewportResizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      this.options.pageStore.markHeightsStale();
      this.sampleViewport();
    });
    this.viewportResizeObserver?.observe(options.viewport);
    options.viewport.addEventListener('scroll', this.onViewportChange, { passive: true });
    this.themeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      this.options.pageStore.markHeightsStale();
    });
    if (typeof document !== 'undefined') {
      this.themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      const fonts = document.fonts;
      if (fonts) {
        void fonts.ready.then(() => this.options.pageStore.markHeightsStale());
        fonts.addEventListener?.('loadingdone', this.markStale);
      }
    }
  }

  addPage(page: HistoryPageInput, totalTurns: number, pin?: 'live' | 'search'): HistoryPageRecord {
    this.totalTurns = Math.max(this.totalTurns, totalTurns);
    const pins = new Set<'live' | 'search' | 'transaction'>(pin ? [pin, 'transaction'] : ['transaction']);
    const record = this.options.pageStore.upsertPage({ ...page, pins });
    this.ensureWrapper(record);
    if (record.renderState !== 'mounted' && record.messages !== null) this.mount(record);
    this.options.pageStore.unpin(record.pageKey, 'transaction');
    this.sampleViewport('older');
    return record;
  }

  beginLivePage(pageKey: string, messages: ChatMessage[], totalTurns: number): HTMLElement {
    if (this.livePageKey && this.livePageKey !== pageKey) this.freezeLivePage();
    this.livePageKey = pageKey;
    const record = this.options.pageStore.upsertPage({
      pageKey,
      range: { start: totalTurns, end: totalTurns },
      messages,
      projectedWeight: this.estimateWeight(messages),
      pins: ['live'],
    });
    const wrapper = this.ensureWrapper(record);
    wrapper.className = 'claudian-history-page claudian-history-page-live';
    record.renderState = 'mounted';
    const ticket = this.options.pageStore.beginRender(record.pageKey, ++this.generation);
    this.options.pageStore.closeRenderTicket(record.pageKey, ticket);
    return wrapper;
  }

  freezeLivePage(messages?: ChatMessage[]): void {
    if (!this.livePageKey) return;
    const record = this.options.pageStore.peek(this.livePageKey);
    if (record && messages) {
      this.options.pageStore.upsertPage({
        pageKey: record.pageKey,
        range: record.range,
        messages,
        projectedWeight: this.estimateWeight(messages),
      });
    }
    this.options.pageStore.unpin(this.livePageKey, 'live');
    this.livePageKey = null;
    this.sampleIntent('older');
  }

  releaseSearchPins(): void {
    for (const record of this.options.pageStore.values()) this.options.pageStore.unpin(record.pageKey, 'search');
  }

  getRoot(): HTMLElement {
    return this.options.root;
  }

  rebuildMountedPages(): void {
    for (const record of this.options.pageStore.values().filter(page => page.renderState === 'mounted')) this.mount(record);
  }

  reset(): void {
    if (this.rafId !== null) this.cancelFrame(this.rafId);
    this.rafId = null;
    this.pendingIntents.clear();
    this.pendingVisiblePages = null;
    this.rematerializations.clear();
    for (const wrapper of this.wrappers.values()) this.resizeObserver?.unobserve(wrapper);
    this.wrappers.clear();
    this.visiblePages.clear();
    this.adjacentPages.clear();
    this.options.pageStore.clear();
    this.totalTurns = 0;
    this.livePageKey = null;
    this.generation += 1;
  }

  replaceMessage(message: ChatMessage, pin?: 'search'): boolean {
    const record = this.options.pageStore.findByMessageId(message.id);
    if (!record) return false;
    if (!this.options.pageStore.replaceMessage(record.pageKey, message)) return false;
    if (pin) this.options.pageStore.pin(record.pageKey, pin);
    if (record.renderState === 'mounted') this.mount(record);
    return true;
  }

  async revealMessage(messageId: string): Promise<boolean> {
    const record = this.options.pageStore.findByMessageId(messageId);
    if (!record) return false;
    this.options.pageStore.pin(record.pageKey, 'search');
    await this.ensureMounted(record);
    return record.renderState === 'mounted';
  }

  setVisiblePages(pageKeys: string[]): void {
    const nextVisible = new Set(pageKeys);
    for (const pageKey of this.visiblePages) {
      if (nextVisible.has(pageKey)) continue;
      this.options.pageStore.unpin(pageKey, 'visible');
      this.options.pageStore.unpin(pageKey, 'search');
    }
    for (const pageKey of nextVisible) {
      if (!this.visiblePages.has(pageKey)) this.options.pageStore.pin(pageKey, 'visible');
    }
    this.visiblePages.clear();
    for (const pageKey of nextVisible) this.visiblePages.add(pageKey);
    this.recomputeAdjacentPages();
  }

  sampleViewport(direction?: StoredIntentDirection): void {
    if (this.disposed) return;
    const viewportRect = this.options.viewport.getBoundingClientRect();
    const top = viewportRect.height > 0 ? viewportRect.top : 0;
    const bottom = viewportRect.height > 0
      ? viewportRect.bottom
      : top + this.options.viewport.clientHeight;
    const visible: string[] = [];
    for (const [pageKey, wrapper] of this.wrappers) {
      const rect = wrapper.getBoundingClientRect();
      if (rect.bottom > top && rect.top < bottom) visible.push(pageKey);
    }
    this.pendingVisiblePages = new Set(visible);
    if (!this.windowingActive()) {
      this.pendingVisiblePages = null;
      this.setVisiblePages(visible);
      return;
    }
    this.sampleIntent(direction ?? this.scrollDirection());
  }

  sampleIntent(direction: StoredIntentDirection): void {
    if (this.disposed || !this.windowingActive()) return;
    this.pendingIntents.set(direction, {
      direction,
      conversationId: this.options.getConversationId(),
      domEpoch: this.options.getDomEpoch(),
      sequence: ++this.sequence,
    });
    if (this.rafId !== null) return;
    this.rafId = this.requestFrame(() => {
      this.rafId = null;
      this.flushIntents();
    });
  }

  registerRenderSlot(pageKey: string, ticket: number): () => void {
    return this.options.pageStore.registerRenderSlot(pageKey, ticket);
  }

  closeRenderTicket(pageKey: string, ticket: number): void {
    this.options.pageStore.closeRenderTicket(pageKey, ticket);
  }

  markAllHeightsStale(): void {
    this.options.pageStore.markHeightsStale();
  }

  getMountedTurnCount(): number {
    return this.options.pageStore.values()
      .filter(page => page.renderState === 'mounted')
      .reduce((sum, page) => sum + page.range.end - page.range.start, 0);
  }

  getPendingIntentCount(): number {
    return this.pendingIntents.size;
  }

  getCommittedIntentCount(): number {
    return this.committedIntents;
  }

  flushForTest(): void {
    for (const record of this.options.pageStore.values()) this.ensureWrapper(record);
  }

  flushFrameForTest(): void {
    if (this.rafId !== null) this.cancelFrame(this.rafId);
    this.rafId = null;
    this.flushIntents();
  }

  async reconcileNowForTest(direction: StoredIntentDirection): Promise<void> {
    await this.processIntent({
      direction,
      conversationId: this.options.getConversationId(),
      domEpoch: this.options.getDomEpoch(),
      sequence: ++this.sequence,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
    this.resizeObserver?.disconnect();
    this.viewportResizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.options.viewport.removeEventListener('scroll', this.onViewportChange);
    document.fonts?.removeEventListener?.('loadingdone', this.markStale);
  }

  private readonly markStale = (): void => this.options.pageStore.markHeightsStale();

  private windowingActive(): boolean {
    const projectedWeight = this.options.pageStore.values()
      .filter(page => page.renderState === 'mounted')
      .reduce((sum, page) => sum + page.projectedWeight, 0);
    return HISTORY_WINDOWING_ENABLED
      && (this.totalTurns > HISTORY_WINDOW_LIMITS.enableTurns
        || projectedWeight > HISTORY_WINDOW_LIMITS.enableProjectedWeight);
  }

  private flushIntents(): void {
    const intents = [...this.pendingIntents.values()];
    this.pendingIntents.clear();
    for (const intent of intents) void this.processIntent(intent);
  }

  private async processIntent(intent: WindowIntent): Promise<void> {
    if (this.pendingVisiblePages) {
      const visible = [...this.pendingVisiblePages];
      this.pendingVisiblePages = null;
      this.setVisiblePages(visible);
    }
    const targets = new Set([...this.visiblePages, ...this.adjacentPages]);
    for (const pageKey of targets) {
      const record = this.options.pageStore.get(pageKey);
      if (!record || record.messages !== null || this.isStale(intent)) continue;
      await this.materialize(record);
    }
    await this.options.coordinator.runLatestStoredIntent(
      intent.direction,
      () => this.isStale(intent),
      () => this.reconcile(intent),
    );
  }

  private async reconcile(intent: WindowIntent): Promise<void> {
    if (this.isStale(intent) || this.options.isLive()) return;
    await this.mountTargetPages(intent);
    if (this.isStale(intent)) return;
    this.committedIntents += 1;
    const mounted = this.options.pageStore.values()
      .filter(page => page.renderState === 'mounted')
      .sort((a, b) => a.range.start - b.range.start);
    let turns = mounted.reduce((sum, page) => sum + page.range.end - page.range.start, 0);
    const overLimitVisible = mounted.find(page => this.visiblePages.has(page.pageKey)
      && page.range.end - page.range.start > HISTORY_WINDOW_LIMITS.hardMountedTurns);
    if (overLimitVisible) {
      recordHistoryRenderEvent({
        kind: 'dom_overcommit',
        pageKey: overLimitVisible.pageKey,
        turns: overLimitVisible.range.end - overLimitVisible.range.start,
      });
    }
    const candidates = intent.direction === 'older' ? mounted.slice().reverse() : mounted;
    for (const page of candidates) {
      if (turns <= HISTORY_WINDOW_LIMITS.softMountedTurns) break;
      if (this.visiblePages.has(page.pageKey) || this.adjacentPages.has(page.pageKey) || page.pins.has('live')) continue;
      const pageTurns = page.range.end - page.range.start;
      await this.unmount(page, intent);
      turns -= pageTurns;
    }
  }

  private async unmount(record: HistoryPageRecord, intent: WindowIntent): Promise<void> {
    const wrapper = this.wrappers.get(record.pageKey);
    if (!wrapper || !wrapper.isConnected || this.isStale(intent) || record.pins.has('live')) return;
    const ticket = record.renderTicket;
    const settled = await this.options.pageStore.waitForCurrentTicket(record.pageKey, HISTORY_WINDOW_LIMITS.settleTimeoutMs);
    if (this.isStale(intent) || record.renderTicket !== ticket || !wrapper.isConnected || record.pins.has('live')) return;
    const anchor = this.captureAnchor();
    const rect = wrapper.getBoundingClientRect();
    if (settled) {
      this.options.pageStore.recordHeight(record.pageKey, ticket, rect.height, this.options.viewport.clientWidth, 'measured');
    } else {
      this.options.pageStore.recordHeight(record.pageKey, ticket, rect.height, this.options.viewport.clientWidth, 'estimated');
      recordHistoryRenderEvent({
        kind: 'page_render_timeout',
        pageKey: record.pageKey,
        ticket,
        timeoutMs: HISTORY_WINDOW_LIMITS.settleTimeoutMs,
      });
    }
    this.options.clearPageReferences?.([...record.messageIds], wrapper, record);
    this.options.invalidateDomEpoch?.();
    intent.domEpoch = this.options.getDomEpoch();
    this.resizeObserver?.unobserve(wrapper);
    const spacer = document.createElement('div');
    spacer.className = 'claudian-history-page-spacer';
    spacer.dataset.pageKey = record.pageKey;
    spacer.style.height = `${record.measuredHeight ?? rect.height}px`;
    wrapper.replaceWith(spacer);
    this.wrappers.set(record.pageKey, spacer);
    record.renderState = 'spacer';
    this.restoreAnchor(anchor);
  }

  private mount(record: HistoryPageRecord): void {
    const current = this.ensureWrapper(record);
    const anchor = this.captureAnchor();
    const wrapper = document.createElement('div');
    wrapper.className = 'claudian-history-page';
    wrapper.dataset.pageKey = record.pageKey;
    current.replaceWith(wrapper);
    this.wrappers.set(record.pageKey, wrapper);
    record.renderState = 'mounted';
    const ticket = this.options.pageStore.beginRender(record.pageKey, ++this.generation);
    this.options.renderPage(record, wrapper, ticket);
    this.options.restorePageUiState?.(wrapper, record);
    this.options.pageStore.closeRenderTicket(record.pageKey, ticket);
    this.resizeObserver?.observe(wrapper);
    this.restoreAnchor(anchor);
    void this.options.pageStore.waitForCurrentTicket(record.pageKey).then(settled => {
      if (!settled || record.renderTicket !== ticket || !wrapper.isConnected) return;
      this.restoreAnchor(anchor);
      this.options.onPageSettled?.(wrapper, record);
    });
  }

  private ensureWrapper(record: HistoryPageRecord): HTMLElement {
    const existing = this.wrappers.get(record.pageKey);
    if (existing) return existing;
    const wrapper = document.createElement('div');
    wrapper.className = 'claudian-history-page';
    wrapper.dataset.pageKey = record.pageKey;
    const next = this.options.pageStore.values()
      .filter(candidate => candidate.pageKey !== record.pageKey && candidate.range.start > record.range.start)
      .sort((a, b) => a.range.start - b.range.start)
      .map(candidate => this.wrappers.get(candidate.pageKey))
      .find((candidate): candidate is HTMLElement => !!candidate?.isConnected);
    this.options.root.insertBefore(wrapper, next ?? null);
    this.wrappers.set(record.pageKey, wrapper);
    return wrapper;
  }

  private recomputeAdjacentPages(): void {
    for (const page of this.adjacentPages) this.options.pageStore.unpin(page, 'adjacent');
    this.adjacentPages.clear();
    const ordered = this.options.pageStore.values().sort((a, b) => a.range.start - b.range.start);
    for (let index = 0; index < ordered.length; index += 1) {
      if (!this.visiblePages.has(ordered[index].pageKey)) continue;
      for (const neighbor of [ordered[index - 1], ordered[index + 1]]) {
        if (!neighbor) continue;
        this.adjacentPages.add(neighbor.pageKey);
        this.options.pageStore.pin(neighbor.pageKey, 'adjacent');
      }
    }
  }

  private async mountTargetPages(intent: WindowIntent): Promise<void> {
    const targets = new Set([...this.visiblePages, ...this.adjacentPages]);
    for (const pageKey of targets) {
      const record = this.options.pageStore.get(pageKey);
      if (!record || record.renderState === 'mounted' || this.isStale(intent)) continue;
      if (record.messages === null) continue;
      this.mount(record);
      intent.domEpoch = this.options.getDomEpoch();
    }
  }

  private async materialize(record: HistoryPageRecord): Promise<void> {
    const rematerialize = this.options.rematerializePage;
    const existing = this.rematerializations.get(record.pageKey);
    if (existing) {
      await existing;
      return;
    }
    if (!rematerialize) return;
    const conversationId = this.options.getConversationId();
    const domEpoch = this.options.getDomEpoch();
    this.options.pageStore.pin(record.pageKey, 'transaction');
    const pending = rematerialize(record).then(page => {
      if (!page || this.disposed || conversationId !== this.options.getConversationId() || domEpoch !== this.options.getDomEpoch() || page.pageKey !== record.pageKey) return false;
      this.options.pageStore.upsertPage(page);
      return true;
    }).finally(() => {
      this.options.pageStore.unpin(record.pageKey, 'transaction');
      this.rematerializations.delete(record.pageKey);
    });
    this.rematerializations.set(record.pageKey, pending);
    await pending;
  }

  private async ensureMounted(record: HistoryPageRecord): Promise<void> {
    this.options.pageStore.get(record.pageKey);
    if (record.messages !== null) {
      this.mount(record);
      return;
    }
    const rematerialize = this.options.rematerializePage;
    if (!rematerialize || this.rematerializations.has(record.pageKey)) return;
    const conversationId = this.options.getConversationId();
    const domEpoch = this.options.getDomEpoch();
    this.options.pageStore.pin(record.pageKey, 'transaction');
    const pending = rematerialize(record).then(page => {
      if (
        !page
        || this.disposed
        || conversationId !== this.options.getConversationId()
        || domEpoch !== this.options.getDomEpoch()
        || page.pageKey !== record.pageKey
      ) return false;
      this.options.pageStore.upsertPage(page);
      return true;
    }).finally(() => {
      this.options.pageStore.unpin(record.pageKey, 'transaction');
      this.rematerializations.delete(record.pageKey);
    });
    this.rematerializations.set(record.pageKey, pending);
    if (!await pending) return;
    const current = this.options.pageStore.peek(record.pageKey);
    if (
      !current
      || current.messages === null
      || (!this.visiblePages.has(record.pageKey) && !this.adjacentPages.has(record.pageKey) && !current.pins.has('search'))
    ) return;
    await this.options.coordinator.runStored(
      () => this.disposed || conversationId !== this.options.getConversationId() || domEpoch !== this.options.getDomEpoch(),
      async () => { this.mount(current); },
    );
  }

  private estimateWeight(messages: ChatMessage[]): number {
    return messages.reduce((sum, message) => sum + JSON.stringify(message).length * 2, 0);
  }

  private scrollDirection(): StoredIntentDirection {
    const current = this.options.viewport.scrollTop;
    const direction = current < this.lastScrollTop ? 'older' : 'newer';
    this.lastScrollTop = current;
    return direction;
  }

  private isStale(intent: WindowIntent): boolean {
    return this.disposed
      || intent.conversationId !== this.options.getConversationId()
      || intent.domEpoch !== this.options.getDomEpoch();
  }

  private captureAnchor(): { element: HTMLElement; top: number } | null {
    const viewportTop = this.options.viewport.getBoundingClientRect().top;
    const elements = Array.from(this.options.root.querySelectorAll<HTMLElement>('[data-message-id]'));
    const element = elements.find(candidate => candidate.getBoundingClientRect().bottom >= viewportTop)
      ?? elements[0]
      ?? null;
    return element ? { element, top: element.getBoundingClientRect().top } : null;
  }

  private restoreAnchor(anchor: { element: HTMLElement; top: number } | null): void {
    if (!anchor?.element.isConnected) return;
    this.options.viewport.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
  }

  private requestFrame(callback: () => void): number {
    return typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(callback)
      : setTimeout(callback, 0) as unknown as number;
  }

  private cancelFrame(id: number): void {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id);
  }
}
