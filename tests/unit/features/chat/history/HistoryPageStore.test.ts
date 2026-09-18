import type { ChatMessage } from '@/core/types';
import { HistoryPageStore } from '@/features/chat/history/HistoryPageStore';

const message = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  content: id,
  timestamp: 1,
});

describe('HistoryPageStore', () => {
  it('keeps stable descriptors while weighted LRU evicts unpinned page data', () => {
    const store = new HistoryPageStore({ maxPages: 2, maxProjectedWeight: 100 });
    store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 40 });
    store.upsertPage({ pageKey: 'b', range: { start: 1, end: 2 }, messages: [message('b')], projectedWeight: 40 });
    store.pin('a', 'visible');
    store.upsertPage({ pageKey: 'c', range: { start: 2, end: 3 }, messages: [message('c')], projectedWeight: 40 });

    expect(store.get('a')?.messages).not.toBeNull();
    expect(store.get('b')?.messages).toBeNull();
    expect(store.get('b')?.range).toEqual({ start: 1, end: 2 });
    expect(store.get('c')?.messages).not.toBeNull();
  });

  it('never evicts mounted page data before DOM unmount', () => {
    const diagnostics: string[] = [];
    const store = new HistoryPageStore({ maxPages: 1, onDiagnostic: event => diagnostics.push(event.kind) });
    const first = store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 1 });
    first.renderState = 'mounted';
    const second = store.upsertPage({ pageKey: 'b', range: { start: 1, end: 2 }, messages: [message('b')], projectedWeight: 1, pins: ['transaction'] });
    second.renderState = 'mounted';
    store.unpin('b', 'transaction');
    store.enforceLimits();
    expect(first.messages).not.toBeNull();
    expect(second.messages).not.toBeNull();
    expect(diagnostics).toContain('page_data_overcommit');
  });

  it('does not evict frozen live pages that lack provider page identity', () => {
    const store = new HistoryPageStore({ maxPages: 1 });
    const live = store.upsertPage({ pageKey: 'live:t', range: { start: 2, end: 2 }, messages: [message('live')], projectedWeight: 1 });
    live.renderState = 'spacer';
    store.upsertPage({ pageKey: 'w:snapshot:0:1', range: { start: 0, end: 1 }, messages: [message('stored')], projectedWeight: 1 });
    expect(live.messages).not.toBeNull();
  });

  it('allows diagnosed overcommit when every resident page is pinned', () => {
    const diagnostics: string[] = [];
    const store = new HistoryPageStore({ maxPages: 1, maxProjectedWeight: 50, onDiagnostic: event => diagnostics.push(event.kind) });
    store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 40 });
    store.pin('a', 'live');
    store.pin('a', 'search');
    store.upsertPage({ pageKey: 'b', range: { start: 1, end: 2 }, messages: [message('b')], projectedWeight: 40, pins: new Set(['search']) });
    store.pin('b', 'search');
    store.enforceLimits();

    expect(store.get('a')?.messages).not.toBeNull();
    expect(store.get('b')?.messages).not.toBeNull();
    expect(diagnostics).toContain('page_data_overcommit');
  });

  it('opens a fresh ticket when lazy work begins after the current ticket settled', () => {
    const store = new HistoryPageStore();
    store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 1 });
    const first = store.beginRender('a', 1);
    store.closeRenderTicket('a', first);

    const slot = store.registerCurrentRenderWork('a');
    expect(store.peek('a')?.renderTicket).toBe(first + 1);
    expect(store.peek('a')?.settledTicket).toBeNull();
    slot();
    expect(store.peek('a')?.settledTicket).toBe(first + 1);
  });

  it('finds an evicted page by its retained message descriptor', () => {
    const store = new HistoryPageStore({ maxPages: 1 });
    store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 1 });
    store.upsertPage({ pageKey: 'b', range: { start: 1, end: 2 }, messages: [message('b')], projectedWeight: 1 });
    expect(store.findByMessageId('a')?.pageKey).toBe('a');
  });

  it('discards superseded settled ticket entries', () => {
    const store = new HistoryPageStore();
    store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 1 });
    const first = store.beginRender('a', 1);
    store.closeRenderTicket('a', first);
    const second = store.beginRender('a', 2);
    store.closeRenderTicket('a', second);
    expect((store as any).tickets.get('a').size).toBe(1);
  });

  it('settles only the current closed ticket and ignores late old slots', async () => {
    const store = new HistoryPageStore();
    store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 1 });
    const first = store.beginRender('a', 1);
    const oldSlot = store.registerRenderSlot('a', first);
    store.closeRenderTicket('a', first);

    const second = store.beginRender('a', 2);
    const currentSlot = store.registerRenderSlot('a', second);
    store.closeRenderTicket('a', second);
    oldSlot();
    expect(store.get('a')?.settledTicket).not.toBe(second);
    currentSlot();
    await store.waitForCurrentTicket('a', 10);
    expect(store.get('a')?.settledTicket).toBe(second);
  });

  it('keeps spacer descriptors when their page data is evicted', () => {
    const store = new HistoryPageStore({ maxPages: 1 });
    const first = store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 1 });
    first.renderState = 'spacer';
    first.measuredHeight = 120;
    store.upsertPage({ pageKey: 'b', range: { start: 1, end: 2 }, messages: [message('b')], projectedWeight: 1 });

    expect(store.peek('a')).toMatchObject({ messages: null, renderState: 'spacer', measuredHeight: 120 });
  });

  it('marks old measured height stale on a new ticket and never lets estimated overwrite measured at the same width', () => {
    const store = new HistoryPageStore();
    store.upsertPage({ pageKey: 'a', range: { start: 0, end: 1 }, messages: [message('a')], projectedWeight: 1 });
    const first = store.beginRender('a', 1);
    store.closeRenderTicket('a', first);
    store.recordHeight('a', first, 100, 500, 'measured');
    const second = store.beginRender('a', 2);
    store.recordHeight('a', second, 80, 500, 'estimated');

    expect(store.get('a')).toMatchObject({ measuredHeight: 100, heightQuality: 'measured', heightStale: true });
  });
});
