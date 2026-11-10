/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */
import { MarkdownRenderDiagnostics } from '@/features/chat/rendering/MarkdownRenderDiagnostics';

const element = { isConnected: true, ownerDocument: { visibilityState: 'visible' } } as unknown as HTMLElement;
const context = (n: number, active = true) => ({
  tabIdHash: n.toString(16).padStart(12, '0'),
  conversationIdHash: 'aaaaaaaaaaaa',
  tabGeneration: n,
  conversationGeneration: 1,
  getTabActive: () => active,
});

describe('MarkdownRenderDiagnostics', () => {
  let now: number;
  let events: any[];
  let collector: MarkdownRenderDiagnostics;

  beforeEach(() => {
    jest.useFakeTimers();
    now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    events = [];
    collector = new MarkdownRenderDiagnostics('cccccccccccc', event => events.push(event));
    collector.setContext(context(1));
  });

  afterEach(() => {
    collector.dispose();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function advance(ms: number): void {
    now += ms;
    jest.advanceTimersByTime(ms);
  }

  function rows() {
    return events.filter(event => event.flushScope === 'attribution');
  }

  function windows() {
    return events.filter(event => event.flushScope === 'window');
  }

  it('aggregates overlapping calls in frozen attribution buckets after a single five-second timer', () => {
    const a = collector.start(element, 3);
    advance(10);
    const b = collector.start(element, 6);
    advance(10);
    collector.end(b, true);
    collector.setContext(context(2, false));
    const c = collector.start(element, 9);
    advance(80);
    collector.end(a, false);
    collector.end(c, true);
    advance(4899);
    expect(events).toHaveLength(0);
    advance(1);
    expect(windows()).toHaveLength(1);
    expect(windows()[0]).toMatchObject({
      callsSum: 3, callsMax: 2, callsSampleCount: 2,
      callsHistogram: [1, 1, 0, 0, 0, 0, 0, 0],
      charsSum: 18, charsMax: 9, settledCalls: 3,
      elapsedMsSum: 190, elapsedMsMax: 100, successCalls: 2, failureCalls: 1,
      inFlightAtStart: 0, inFlightAtEnd: 0, abandonedCalls: 0,
      attributionRows: 2,
    });
    expect(rows()[0]).toMatchObject({ tabIdHash: context(1).tabIdHash, callsSum: 2, elapsedMsSum: 110 });
    expect(rows()[1]).toMatchObject({ tabIdHash: context(2).tabIdHash, callsSum: 1, elapsedMsSum: 80 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('splits start and settlement across windows without idle polling', () => {
    const token = collector.start(element, 3);
    advance(5000);
    expect(windows()[0]).toMatchObject({ callsSum: 1, charsSum: 3, settledCalls: 0, inFlightAtStart: 0, inFlightAtEnd: 1 });
    expect(jest.getTimerCount()).toBe(0);
    advance(1000);
    collector.setContext(context(2));
    collector.end(token, true);
    collector.end(token, true);
    advance(5000);
    expect(windows()[1]).toMatchObject({
      windowMs: 6000, callsSum: 0, callsMax: 0, callsSampleCount: 0,
      charsSum: 0, settledCalls: 1, elapsedMsSum: 6000, inFlightAtStart: 1, inFlightAtEnd: 0,
    });
    expect(rows()[1]).toMatchObject({ tabIdHash: context(1).tabIdHash });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('accounts for abandoned calls on disposal and ignores late or foreign tokens', () => {
    const token = collector.start(element, 3);
    advance(5000);
    advance(500);
    collector.dispose();
    const afterDispose = events.length;
    expect(windows()[1]).toMatchObject({ flushReason: 'dispose', callsSum: 0, settledCalls: 0, abandonedCalls: 1, inFlightAtStart: 1, inFlightAtEnd: 0, elapsedMsSum: 0 });
    collector.end(token, false);
    collector.start(element, 9);
    collector.dispose();
    advance(10000);
    expect(events).toHaveLength(afterDispose);
    expect(jest.getTimerCount()).toBe(0);
    const second = new MarkdownRenderDiagnostics('dddddddddddd', event => events.push(event));
    second.end(token, true);
    second.dispose();
    expect(events).toHaveLength(afterDispose);
  });

  it('reserves one lifetime overflow slot and does not expose overflow identities', () => {
    for (let i = 1; i <= 33; i++) {
      collector.setContext(context(i));
      const token = collector.start(element, 1);
      collector.end(token, true);
    }
    advance(5000);
    expect(rows()).toHaveLength(32);
    const overflow = rows().find(row => row.attributionKind === 'overflow');
    expect(overflow).toMatchObject({ attributionSlot: 0, callsSum: 2 });
    expect(overflow).not.toHaveProperty('tabIdHash');
    expect(overflow).not.toHaveProperty('conversationGeneration');
    expect(windows()[0]).toMatchObject({ callsSum: 33, callsMax: 2, callsSampleCount: 32, callsHistogram: [31, 1, 0, 0, 0, 0, 0, 0] });
    expect(overflow.startVisibilityHistogram[0]).toBe(2);
  });

  it('uses left-closed fixed histogram buckets and preserves elapsed fractions', () => {
    let token = collector.start(element, 1023);
    advance(15.999);
    collector.end(token, true);
    token = collector.start(element, 1024);
    advance(16);
    collector.end(token, true);
    advance(4969);
    const window = windows()[0];
    expect(window.charsHistogram).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect(window.elapsedMsHistogram).toEqual([0, 0, 1, 1, 0, 0, 0, 0]);
    expect(window.elapsedMsSum).toBeCloseTo(31.999);
  });

  it('keeps calls buckets at 127/128 and never evicts the original slots after flush', () => {
    for (let n = 0; n < 127; n++) {
      const token = collector.start(element, 0);
      collector.end(token, true);
    }
    collector.setContext(context(2));
    for (let n = 0; n < 128; n++) {
      const token = collector.start(element, 0);
      collector.end(token, true);
    }
    advance(5000);
    expect(windows()[0]).toMatchObject({ callsSum: 255, callsMax: 128, callsSampleCount: 2,
      callsHistogram: [0, 0, 0, 0, 0, 0, 1, 1], charsHistogram: [255, 0, 0, 0, 0, 0, 0],
      elapsedMsHistogram: [255, 0, 0, 0, 0, 0, 0, 0] });
    collector.setContext(context(1));
    const token = collector.start(element, 1);
    collector.end(token, true);
    advance(5000);
    expect(rows()[2]).toMatchObject({ attributionSlot: 1, tabIdHash: context(1).tabIdHash });
  });

  it('captures unknown visibility and identities without retaining element or raw identifier', () => {
    const unknown = { isConnected: undefined, ownerDocument: { visibilityState: 'prerender' } } as unknown as HTMLElement;
    collector.setContext({ tabIdHash: '/private/path', conversationIdHash: 'private', getTabActive: () => undefined });
    const token = collector.start(unknown, 3);
    collector.end(token, true);
    advance(5000);
    expect(rows()[0]).toMatchObject({ tabIdState: 'unknown', conversationIdState: 'unknown',
      tabActive: 'unknown', documentVisible: 'unknown', domConnected: 'unknown', viewport: 'unknown' });
    expect(rows()[0].startVisibilityHistogram[26]).toBe(1);
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('samples exact DOM node selectors only explicitly and no more often than five seconds', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="claudian-history-page"><div class="claudian-message"><i class="claudian-text-block"></i><i class="claudian-text-block"></i></div><div class="claudian-message"><i class="claudian-text-block"></i></div></div><div class="claudian-history-page-spacer"></div>';
    const querySelectorAll = jest.spyOn(root, 'querySelectorAll');
    const token = collector.start(element, 1);
    collector.end(token, true);
    expect(querySelectorAll).not.toHaveBeenCalled();
    collector.sampleDom(root);
    advance(4999);
    collector.sampleDom(root);
    expect(querySelectorAll).toHaveBeenCalledTimes(3);
    advance(1);
    expect(windows()[0]).toMatchObject({ domPageNodes: 1, domMessageNodes: 2, domTextBlockNodes: 3 });
    collector.sampleDom(root);
    expect(querySelectorAll.mock.calls.map(([selector]) => selector)).toEqual([
      '.claudian-history-page', '.claudian-message', '.claudian-text-block',
      '.claudian-history-page', '.claudian-message', '.claudian-text-block',
    ]);
    advance(5000);
    expect(windows()[1]).toMatchObject({ callsSum: 0, attributionRows: 0, domPageNodes: 1, domMessageNodes: 2, domTextBlockNodes: 3 });
  });

  it('isolates a clock exception without retry or fabricated elapsed time', () => {
    const token = collector.start(element, 3);
    jest.mocked(performance.now).mockImplementationOnce(() => { throw new Error('private clock error'); });
    collector.end(token, true);
    advance(10000);
    expect(events).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('discards pending work and clears its timer when explicitly disabled', () => {
    const token = collector.start(element, 3);
    expect(jest.getTimerCount()).toBe(1);
    collector.disable();
    collector.disable();
    expect(jest.getTimerCount()).toBe(0);
    collector.end(token, true);
    collector.start(element, 6);
    collector.dispose();
    advance(10000);
    expect(events).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('disables after a throwing sink and does not retry', () => {
    const sink = jest.fn(() => { throw new Error('private error'); });
    const failing = new MarkdownRenderDiagnostics('dddddddddddd', sink);
    failing.setContext(context(1));
    failing.start(element, 3);
    advance(5000);
    failing.start(element, 6);
    advance(10000);
    failing.dispose();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
