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
    renderer.flushForTest();
    const before = root.innerHTML;
    for (let index = 0; index < 20; index += 1) renderer.sampleIntent('older');
    expect(root.innerHTML).toBe(before);
    renderer.flushFrameForTest();
    await Promise.resolve();
    await Promise.resolve();
    expect(runStored).toHaveBeenCalledTimes(1);
  });

  it('keeps mounted turns at the hard cap after twenty pages', async () => {
    const { renderer } = createHarness(400);
    for (let page = 0; page < 20; page += 1) {
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
    const live = await coordinator.acquireLive();
    renderer.sampleIntent('older');
    renderer.flushFrameForTest();
    renderer.sampleIntent('older');
    renderer.flushFrameForTest();
    expect(renderer.getCommittedIntentCount()).toBe(0);
    live?.release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(renderer.getCommittedIntentCount()).toBe(1);
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
    expect(rematerializePage).toHaveBeenCalledTimes(1);
    expect((renderer as any).options.coordinator.hasLiveTurn()).toBe(false);
    resolvePage({ pageKey: 'b', range: { start: 100, end: 200 }, messages: messages(100, 'b2'), projectedWeight: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.peek('b')?.renderState).toBe('mounted');
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
    expect(rematerializePage).toHaveBeenCalledTimes(1);
    setConversationId('other');
    resolvePage({ pageKey: 'b', range: { start: 100, end: 200 }, messages: messages(100, 'b2'), projectedWeight: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
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
