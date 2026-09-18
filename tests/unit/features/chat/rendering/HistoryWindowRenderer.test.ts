/** @jest-environment jsdom */
import type { ChatMessage } from '@/core/types';
import { HistoryPageStore } from '@/features/chat/history/HistoryPageStore';
import { HistoryWindowRenderer } from '@/features/chat/rendering/HistoryWindowRenderer';
import { ProjectionWriteCoordinator } from '@/features/chat/rendering/ProjectionWriteCoordinator';

const messages = (count: number, prefix = 'm'): ChatMessage[] => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`,
  role: 'assistant' as const,
  content: `${prefix}-${index}`,
  timestamp: index,
}));

function createHarness(totalTurns = 300, overrides: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="viewport"><div id="messages"></div></div>';
  const viewport = document.querySelector('#viewport') as HTMLElement;
  const root = document.querySelector('#messages') as HTMLElement;
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 600 });
  const store = new HistoryPageStore();
  const coordinator = new ProjectionWriteCoordinator();
  let conversationId = 'conversation';
  const renderer = new HistoryWindowRenderer({
    root,
    viewport,
    pageStore: store,
    coordinator,
    getConversationId: () => conversationId,
    getDomEpoch: () => 1,
    isLive: () => false,
    renderPage: (record, wrapper) => {
      for (const item of record.messages ?? []) {
        const el = document.createElement('div');
        el.dataset.messageId = item.id;
        wrapper.appendChild(el);
      }
    },
    ...overrides,
  });
  return { renderer, store, coordinator, root, viewport, setConversationId: (id: string) => { conversationId = id; }, totalTurns };
}

describe('HistoryWindowRenderer', () => {
  it('does not create spacers for small conversations', () => {
    const { renderer, root } = createHarness(250);
    renderer.addPage({ pageKey: 'small', range: { start: 0, end: 250 }, messages: messages(250), projectedWeight: 1 }, 250);
    renderer.flushForTest();
    expect(root.querySelector('.claudian-history-page-spacer')).toBeNull();
  });

  it('coalesces twenty scroll intents into one stored commit without synchronous mutation', async () => {
    const { renderer, coordinator, root } = createHarness();
    const runStored = jest.spyOn(coordinator, 'runStored');
    renderer.addPage({ pageKey: 'a', range: { start: 0, end: 100 }, messages: messages(100, 'a'), projectedWeight: 1 }, 300);
    renderer.flushFrameForTest();
    await Promise.resolve();
    runStored.mockClear();
    renderer.flushForTest();
    const before = root.innerHTML;
    for (let index = 0; index < 20; index += 1) renderer.sampleIntent('older');
    expect(root.innerHTML).toBe(before);
    renderer.flushFrameForTest();
    await Promise.resolve();
    await Promise.resolve();
    expect(runStored).toHaveBeenCalledTimes(1);
  });

  it('keeps real newest-first load order sorted by turn range', () => {
    const { renderer, root } = createHarness(400);
    renderer.addPage({ pageKey: 'newest', range: { start: 300, end: 400 }, messages: messages(100, 'newest'), projectedWeight: 1 }, 400);
    renderer.addPage({ pageKey: 'older', range: { start: 200, end: 300 }, messages: messages(100, 'older'), projectedWeight: 1 }, 400);

    expect(Array.from(root.querySelectorAll<HTMLElement>('[data-page-key]')).map(el => el.dataset.pageKey))
      .toEqual(['older', 'newest']);
  });

  it('keeps mounted turns at the hard cap after twenty pages loaded newest-first', async () => {
    const { renderer } = createHarness(400);
    for (let page = 19; page >= 0; page -= 1) {
      renderer.addPage({
        pageKey: `p-${page}`,
        range: { start: page * 20, end: page * 20 + 20 },
        messages: messages(20, `p-${page}`),
        projectedWeight: 1,
      }, 400);
    }
    renderer.setVisiblePages(['p-19']);
    renderer.flushForTest();
    await renderer.reconcileNowForTest('older');
    expect(renderer.getMountedTurnCount()).toBeLessThanOrEqual(200);
  });

  it('queues behind live lease and retains only the latest intent per direction', async () => {
    const { renderer, coordinator } = createHarness();
    renderer.addPage({ pageKey: 'a', range: { start: 0, end: 20 }, messages: messages(20), projectedWeight: 1 }, 300);
    renderer.flushFrameForTest();
    await new Promise(resolve => setTimeout(resolve, 0));
    const baseline = renderer.getCommittedIntentCount();
    const live = await coordinator.acquireLive();
    renderer.sampleIntent('older');
    renderer.flushFrameForTest();
    renderer.sampleIntent('older');
    renderer.flushFrameForTest();
    expect(renderer.getCommittedIntentCount()).toBe(baseline);
    live?.release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(renderer.getCommittedIntentCount()).toBe(baseline + 1);
  });

  it('defers scroll-triggered spacer mounting until rAF and stored grant', async () => {
    let resolvePage!: (page: any) => void;
    const rematerializePage = jest.fn(() => new Promise(resolve => { resolvePage = resolve; }));
    const { renderer, store, root, viewport, coordinator } = createHarness(300, { rematerializePage });
    renderer.addPage({ pageKey: 'a', range: { start: 0, end: 100 }, messages: messages(100, 'a'), projectedWeight: 1 }, 300);
    renderer.addPage({ pageKey: 'b', range: { start: 100, end: 200 }, messages: messages(100, 'b'), projectedWeight: 1 }, 300);
    const record = store.peek('b')!;
    record.messages = null;
    record.renderState = 'spacer';
    const wrapper = root.querySelector<HTMLElement>('[data-page-key="b"]')!;
    jest.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100, height: 100 } as DOMRect);
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });
    const before = root.innerHTML;
    const runStored = jest.spyOn(coordinator, 'runStored');

    viewport.dispatchEvent(new Event('scroll'));
    expect(root.innerHTML).toBe(before);
    expect(rematerializePage).not.toHaveBeenCalled();
    renderer.flushFrameForTest();
    await Promise.resolve();
    resolvePage({ pageKey: 'b', range: record.range, messages: messages(100, 'b'), projectedWeight: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runStored).toHaveBeenCalled();
    expect(store.peek('b')?.renderState).toBe('mounted');
  });

  it('actively samples viewport after first indexed page mount', () => {
    const { renderer } = createHarness();
    const sample = jest.spyOn(renderer, 'sampleViewport');
    renderer.addPage({ pageKey: 'a', range: { start: 200, end: 300 }, messages: messages(100), projectedWeight: 1 }, 300);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('detects visible pages from viewport geometry and pre-mounts neighbors', async () => {
    const { renderer, store, root, viewport } = createHarness();
    for (let page = 0; page < 3; page += 1) {
      renderer.addPage({ pageKey: `p-${page}`, range: { start: page * 100, end: page * 100 + 100 }, messages: messages(100, `p-${page}`), projectedWeight: 1 }, 300);
    }
    const wrappers = Array.from(root.querySelectorAll<HTMLElement>('[data-page-key]'));
    wrappers.forEach((wrapper, index) => {
      jest.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ top: index * 100, bottom: index * 100 + 100, height: 100 } as DOMRect);
    });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });
    renderer.sampleViewport();
    renderer.flushFrameForTest();
    await Promise.resolve();
    expect(store.peek('p-0')?.pins.has('visible')).toBe(true);
    expect(store.peek('p-1')?.pins.has('adjacent')).toBe(true);
  });

  it('rematerializes evicted adjacent pages before mounting without holding stored lease', async () => {
    let resolvePage!: (value: any) => void;
    const rematerializePage = jest.fn(() => new Promise(resolve => { resolvePage = resolve; }));
    const { renderer, store } = createHarness(300, { rematerializePage });
    renderer.addPage({ pageKey: 'a', range: { start: 0, end: 100 }, messages: messages(100, 'a'), projectedWeight: 1 }, 300);
    renderer.addPage({ pageKey: 'b', range: { start: 100, end: 200 }, messages: messages(100, 'b'), projectedWeight: 1 }, 300);
    store.peek('b')!.messages = null;
    store.peek('b')!.renderState = 'spacer';
    renderer.setVisiblePages(['a']);
    (renderer as any).pendingVisiblePages = new Set(['a']);
    renderer.sampleIntent('newer');
    renderer.flushFrameForTest();
    const reconcile = new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rematerializePage).toHaveBeenCalledTimes(1);
    expect((renderer as any).options.coordinator.hasLiveTurn()).toBe(false);
    resolvePage({ pageKey: 'b', range: { start: 100, end: 200 }, messages: messages(100, 'b2'), projectedWeight: 1 });
    await reconcile;
    expect(store.peek('b')?.renderState).toBe('mounted');
  });

  it('replaces a search detail in its existing mounted page without adding a duplicate wrapper', () => {
    const { renderer, root } = createHarness();
    renderer.addPage({ pageKey: 'existing', range: { start: 0, end: 2 }, messages: messages(2, 'hit'), projectedWeight: 1 }, 300);
    expect(renderer.replaceMessage({ id: 'hit-0', role: 'assistant', content: 'exact', timestamp: 1 }, 'search')).toBe(true);
    expect(root.querySelectorAll('[data-page-key]').length).toBe(1);
    expect(root.querySelector('[data-message-id="hit-0"]')).not.toBeNull();
  });

  it.each(['mounted', 'spacer', 'evicted'] as const)('reveals search hits from %s pages', async renderState => {
    const rematerializePage = jest.fn(async (record: any) => ({
      pageKey: record.pageKey,
      range: record.range,
      messages: messages(1, 'hit'),
      projectedWeight: 1,
    }));
    const { renderer, store } = createHarness(300, { rematerializePage });
    renderer.addPage({ pageKey: 'hit-page', range: { start: 0, end: 1 }, messages: messages(1, 'hit'), projectedWeight: 1 }, 300);
    const record = store.peek('hit-page')!;
    record.renderState = renderState;
    if (renderState === 'evicted') record.messages = null;
    await renderer.revealMessage('hit-0');
    expect(store.peek('hit-page')?.renderState).toBe('mounted');
    expect(store.peek('hit-page')?.pins.has('search')).toBe(true);
  });

  it('deduplicates rematerialization and drops its result after conversation changes', async () => {
    let resolvePage!: (value: any) => void;
    const rematerializePage = jest.fn(() => new Promise(resolve => { resolvePage = resolve; }));
    const { renderer, store, setConversationId } = createHarness(300, { rematerializePage });
    renderer.addPage({ pageKey: 'a', range: { start: 0, end: 100 }, messages: messages(100, 'a'), projectedWeight: 1 }, 300);
    renderer.addPage({ pageKey: 'b', range: { start: 100, end: 200 }, messages: messages(100, 'b'), projectedWeight: 1 }, 300);
    store.peek('b')!.messages = null;
    store.peek('b')!.renderState = 'spacer';
    renderer.setVisiblePages(['a']);
    renderer.setVisiblePages(['a']);
    (renderer as any).pendingVisiblePages = new Set(['a']);
    renderer.sampleIntent('newer');
    renderer.flushFrameForTest();
    const reconcile = new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rematerializePage).toHaveBeenCalledTimes(1);
    setConversationId('other');
    resolvePage({ pageKey: 'b', range: { start: 100, end: 200 }, messages: messages(100, 'b2'), projectedWeight: 1 });
    await reconcile;
    expect(store.peek('b')?.messages).toBeNull();
  });

  it('restores page UI state after spacer remount', async () => {
    const restorePageUiState = jest.fn();
    const { renderer, store } = createHarness(300, { restorePageUiState });
    renderer.addPage({ pageKey: 'a', range: { start: 0, end: 100 }, messages: messages(100, 'a'), projectedWeight: 1 }, 300);
    store.peek('a')!.renderState = 'spacer';
    renderer.setVisiblePages(['a']);
    await Promise.resolve();
    expect(restorePageUiState).toHaveBeenCalledWith(expect.any(HTMLElement), store.peek('a'));
  });

  it('keeps live page pinned until the turn freezes', () => {
    const { renderer, store } = createHarness();
    renderer.beginLivePage('live:1', messages(2, 'live'), 300);
    expect(store.peek('live:1')?.pins.has('live')).toBe(true);
    renderer.freezeLivePage(messages(3, 'live'));
    expect(store.peek('live:1')?.pins.has('live')).toBe(false);
  });

  it('releases search pin after the located page leaves the viewport', async () => {
    const { renderer, store } = createHarness();
    renderer.addPage({ pageKey: 'hit', range: { start: 0, end: 100 }, messages: messages(100, 'hit'), projectedWeight: 1 }, 300, 'search');
    renderer.setVisiblePages(['hit']);
    renderer.setVisiblePages([]);
    expect(store.peek('hit')?.pins.has('search')).toBe(false);
  });

  it('times out unsettled tickets to estimated height without accepting the late ticket', async () => {
    jest.useFakeTimers();
    const { renderer, store, root } = createHarness();
    renderer.addPage({ pageKey: 'slow', range: { start: 0, end: 200 }, messages: messages(200, 'slow'), projectedWeight: 1 }, 400);
    const record = store.peek('slow')!;
    const release = store.registerCurrentRenderWork('slow');
    const wrapper = root.querySelector('[data-page-key="slow"]') as HTMLElement;
    jest.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ height: 120, top: 0, bottom: 120 } as DOMRect);
    const reconcile = renderer.reconcileNowForTest('newer');
    await jest.advanceTimersByTimeAsync(3000);
    await reconcile;
    expect(record).toMatchObject({ renderState: 'spacer', heightQuality: 'estimated' });
    release();
    expect(record.heightQuality).toBe('estimated');
    jest.useRealTimers();
  });

  it('marks height caches stale on width, font, and theme changes', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const mutationCallbacks: MutationCallback[] = [];
    const originalResize = global.ResizeObserver;
    const originalMutation = global.MutationObserver;
    const loadingListeners: Array<() => void> = [];
    (global as any).ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (global as any).MutationObserver = class {
      constructor(callback: MutationCallback) { mutationCallbacks.push(callback); }
      observe() {}
      disconnect() {}
    };
    Object.defineProperty(document, 'fonts', { configurable: true, value: {
      ready: Promise.resolve(),
      addEventListener: (_name: string, callback: () => void) => loadingListeners.push(callback),
      removeEventListener: jest.fn(),
    } });
    const { renderer } = createHarness();
    const record = renderer.addPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: messages(1), projectedWeight: 1 }, 300);
    record.measuredHeight = 100;
    record.heightStale = false;
    resizeCallbacks[1]([], {} as ResizeObserver);
    expect(record.heightStale).toBe(true);
    record.heightStale = false;
    mutationCallbacks[0]([], {} as MutationObserver);
    expect(record.heightStale).toBe(true);
    record.heightStale = false;
    loadingListeners[0]();
    expect(record.heightStale).toBe(true);
    renderer.dispose();
    (global as any).ResizeObserver = originalResize;
    (global as any).MutationObserver = originalMutation;
  });

  it('applies a second anchor correction after async page settlement', async () => {
    let top = 20;
    let release!: () => void;
    const renderPage = (record: any, wrapper: HTMLElement, ticket: number) => {
      const message = document.createElement('div');
      message.dataset.messageId = record.messages[0].id;
      jest.spyOn(message, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 20, height: 20 } as DOMRect));
      wrapper.appendChild(message);
      release = record.__store.registerRenderSlot(record.pageKey, ticket);
    };
    const store = new HistoryPageStore();
    document.body.innerHTML = '<div id="viewport"><div id="messages"></div></div>';
    const viewport = document.querySelector('#viewport') as HTMLElement;
    const root = document.querySelector('#messages') as HTMLElement;
    const renderer = new HistoryWindowRenderer({ root, viewport, pageStore: store, coordinator: new ProjectionWriteCoordinator(), getConversationId: () => 'c', getDomEpoch: () => 1, isLive: () => false, renderPage: (record, wrapper, ticket) => renderPage(Object.assign(record, { __store: store }), wrapper, ticket) });
    viewport.scrollTop = 100;
    const anchor = document.createElement('div');
    anchor.dataset.messageId = 'existing';
    jest.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 20, height: 20 } as DOMRect));
    root.appendChild(anchor);
    renderer.addPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: messages(1), projectedWeight: 1 }, 300);
    top = 40;
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(viewport.scrollTop).toBe(120);
  });

  it('drops search pins explicitly when search closes', () => {
    const { renderer, store } = createHarness();
    renderer.addPage({ pageKey: 'hit', range: { start: 0, end: 1 }, messages: messages(1), projectedWeight: 1 }, 300, 'search');
    renderer.releaseSearchPins();
    expect(store.peek('hit')?.pins.has('search')).toBe(false);
  });

  it('drops a queued commit after conversation changes', async () => {
    const { renderer, coordinator, setConversationId } = createHarness();
    const live = await coordinator.acquireLive();
    renderer.sampleIntent('older');
    renderer.flushFrameForTest();
    setConversationId('other');
    live?.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.getCommittedIntentCount()).toBe(0);
  });
});
