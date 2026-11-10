import type { MarkdownRenderSummary } from '@/features/chat/history/HistoryDiagnostics';
import { mapHistoryDiagnosticEvent } from '@/main';

function windowSummary(): MarkdownRenderSummary {
  return {
    kind: 'markdown_render_summary',
    metricVersion: 1,
    collectorIdHash: 'aaaaaaaaaaaa',
    flushId: 7,
    flushReason: 'timer',
    flushScope: 'window',
    windowMs: 125.5,
    callsSum: 2,
    callsMax: 2,
    callsSampleCount: 1,
    callsHistogram: [0, 1, 0, 0, 0, 0, 0, 0],
    charsSum: 30,
    charsMax: 20,
    charsHistogram: [2, 0, 0, 0, 0, 0, 0],
    elapsedMsSum: 12.25,
    elapsedMsMax: 8.75,
    elapsedMsHistogram: [2, 0, 0, 0, 0, 0, 0, 0],
    settledCalls: 2,
    successCalls: 1,
    failureCalls: 1,
    inFlightAtStart: 1,
    inFlightAtEnd: 0,
    abandonedCalls: 0,
    startVisibilityHistogram: [2, ...Array<number>(26).fill(0)],
    attributionRows: 1,
    domPageNodes: 3,
    domMessageNodes: 4,
    domTextBlockNodes: 5,
  };
}

function commonFields() {
  const event = windowSummary();
  return {
    phase: event.kind,
    metricVersion: event.metricVersion,
    collectorIdHash: event.collectorIdHash,
    flushId: event.flushId,
    flushReason: event.flushReason,
    flushScope: event.flushScope,
    windowMs: event.windowMs,
    callsSum: event.callsSum,
    charsSum: event.charsSum,
    charsMax: event.charsMax,
    charsHistogram: event.charsHistogram,
    elapsedMsSum: event.elapsedMsSum,
    elapsedMsMax: event.elapsedMsMax,
    elapsedMsHistogram: event.elapsedMsHistogram,
    settledCalls: event.settledCalls,
    successCalls: event.successCalls,
    failureCalls: event.failureCalls,
    inFlightAtStart: event.inFlightAtStart,
    inFlightAtEnd: event.inFlightAtEnd,
    abandonedCalls: event.abandonedCalls,
    startVisibilityHistogram: event.startVisibilityHistogram,
  };
}

describe('markdown summary mapping', () => {
  const hash = jest.fn(() => 'must-not-rehash');

  beforeEach(() => hash.mockClear());

  it('maps window-only metrics and copies dense arrays without spreading input', () => {
    const event = Object.assign(windowSummary(), {
      tabIdHash: 'bbbbbbbbbbbb', tabGeneration: 6, privateText: 'private body', path: '/private/path',
    });
    const mapped = mapHistoryDiagnosticEvent(event, hash);
    expect(mapped).toEqual({
      ...commonFields(),
      callsMax: 2,
      callsHistogram: [0, 1, 0, 0, 0, 0, 0, 0],
      callsSampleCount: 1,
      attributionRows: 1,
      domPageNodes: 3,
      domMessageNodes: 4,
      domTextBlockNodes: 5,
    });
    expect(mapped.charsHistogram).not.toBe(event.charsHistogram);
    expect(mapped.callsHistogram).not.toBe(event.callsHistogram);
    expect(JSON.stringify(mapped)).not.toContain('private');
    expect(hash).not.toHaveBeenCalled();
  });

  it('passes known attribution hashes and generations through without window fields or rehashing', () => {
    const event: MarkdownRenderSummary = {
      ...windowSummary(),
      flushScope: 'attribution',
      attributionKind: 'known',
      attributionSlot: 9,
      tabIdState: 'known',
      conversationIdState: 'known',
      tabIdHash: 'bbbbbbbbbbbb',
      conversationIdHash: 'cccccccccccc',
      tabGeneration: 6,
      conversationGeneration: 4,
      tabActive: 'yes',
      documentVisible: 'no',
      domConnected: 'unknown',
      viewport: 'unknown',
    };
    const mapped = mapHistoryDiagnosticEvent(event, hash);
    expect(mapped).toEqual({
      ...commonFields(),
      flushScope: 'attribution',
      attributionKind: 'known',
      attributionSlot: 9,
      tabIdState: 'known',
      conversationIdState: 'known',
      tabIdHash: 'bbbbbbbbbbbb',
      conversationIdHash: 'cccccccccccc',
      tabGeneration: 6,
      conversationGeneration: 4,
      tabActive: 'yes',
      documentVisible: 'no',
      domConnected: 'unknown',
      viewport: 'unknown',
    });
    expect(hash).not.toHaveBeenCalled();
  });

  it('omits all identities and generations from overflow even if supplied', () => {
    const event: MarkdownRenderSummary = {
      ...windowSummary(),
      flushScope: 'attribution',
      attributionKind: 'overflow',
      attributionSlot: 0,
      tabIdHash: 'bbbbbbbbbbbb',
      conversationIdHash: 'cccccccccccc',
      tabGeneration: 6,
      conversationGeneration: 4,
      tabActive: 'yes',
    };
    expect(mapHistoryDiagnosticEvent(event, hash)).toEqual({
      ...commonFields(), flushScope: 'attribution', attributionKind: 'overflow', attributionSlot: 0,
    });
    expect(hash).not.toHaveBeenCalled();
  });

  it('drops invalid numeric and enum fields individually instead of forwarding them', () => {
    const event = Object.assign(windowSummary(), {
      metricVersion: 2, collectorIdHash: '/private/path', flushId: -1, flushReason: 'private error',
      windowMs: NaN, callsSum: Number.MAX_SAFE_INTEGER + 1, charsSum: 1.5, charsMax: -1,
      elapsedMsSum: Infinity, elapsedMsMax: -0.5, settledCalls: -1, successCalls: NaN,
      failureCalls: 'private', inFlightAtStart: 0.5, inFlightAtEnd: Infinity, abandonedCalls: -1,
      callsMax: -1, callsSampleCount: -1, attributionRows: -1,
      domPageNodes: Infinity, domMessageNodes: -1, domTextBlockNodes: 1.5,
    }) as unknown as MarkdownRenderSummary;
    const mapped = mapHistoryDiagnosticEvent(event, hash);
    for (const field of [
      'metricVersion', 'collectorIdHash', 'flushId', 'flushReason', 'windowMs', 'callsSum',
      'charsSum', 'charsMax', 'elapsedMsSum', 'elapsedMsMax', 'settledCalls', 'successCalls',
      'failureCalls', 'inFlightAtStart', 'inFlightAtEnd', 'abandonedCalls', 'callsMax',
      'callsSampleCount', 'attributionRows', 'domPageNodes', 'domMessageNodes', 'domTextBlockNodes',
    ]) {
      expect(mapped).toHaveProperty(field, undefined);
    }
    expect(JSON.stringify(mapped)).not.toContain('private');
    expect(hash).not.toHaveBeenCalled();
  });

  it('drops invalid known attribution identities, slots, visibility and viewport fields', () => {
    const event = Object.assign(windowSummary(), {
      flushScope: 'attribution', attributionKind: 'known', attributionSlot: 32,
      tabIdState: 'private', conversationIdState: 'private', tabIdHash: 'BBBBBBBBBBBB',
      conversationIdHash: '/private/path', tabGeneration: -1, conversationGeneration: 1.5,
      tabActive: 'private', documentVisible: 'private', domConnected: 'private', viewport: 'yes',
    }) as unknown as MarkdownRenderSummary;
    const mapped = mapHistoryDiagnosticEvent(event, hash);
    expect(mapped.attributionKind).toBe('known');
    for (const field of [
      'attributionSlot', 'tabIdState', 'conversationIdState', 'tabIdHash', 'conversationIdHash',
      'tabGeneration', 'conversationGeneration', 'tabActive', 'documentVisible', 'domConnected', 'viewport',
    ]) {
      expect(mapped).toHaveProperty(field, undefined);
    }
    expect(JSON.stringify(mapped)).not.toContain('private');
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects invalid scopes, attribution kinds and slot boundaries', () => {
    const invalidScope = { ...windowSummary(), flushScope: 'private' } as unknown as MarkdownRenderSummary;
    const scopeMapped = mapHistoryDiagnosticEvent(invalidScope, hash);
    expect(scopeMapped.flushScope).toBeUndefined();
    expect(scopeMapped).not.toHaveProperty('attributionKind');
    expect(scopeMapped).not.toHaveProperty('tabIdHash');

    const invalidKind = {
      ...windowSummary(), flushScope: 'attribution', attributionKind: 'private', tabIdHash: 'bbbbbbbbbbbb',
    } as unknown as MarkdownRenderSummary;
    const kindMapped = mapHistoryDiagnosticEvent(invalidKind, hash);
    expect(kindMapped).not.toHaveProperty('attributionKind');
    expect(kindMapped).not.toHaveProperty('tabIdHash');

    for (const [kind, slot] of [['known', 0], ['known', 32], ['overflow', 1]] as const) {
      const event: MarkdownRenderSummary = {
        ...windowSummary(), flushScope: 'attribution', attributionKind: kind, attributionSlot: slot,
      };
      expect(mapHistoryDiagnosticEvent(event, hash).attributionSlot).toBeUndefined();
    }
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects sparse, inherited, wrong-length and invalid histogram values', () => {
    const inherited = Array<number>(7).fill(0);
    delete inherited[3];
    const prototype = Object.create(Array.prototype) as number[];
    Object.defineProperty(prototype, '3', { value: 1 });
    Object.setPrototypeOf(inherited, prototype);
    const invalid: Array<[keyof MarkdownRenderSummary, number[]]> = [
      ['charsHistogram', inherited],
      ['elapsedMsHistogram', Array<number>(8)],
      ['callsHistogram', [0, 0, 0, 0, 0, 0, 0, Infinity]],
      ['startVisibilityHistogram', Array<number>(26).fill(0)],
      ['charsHistogram', [0, 0, 0, 0, 0, 0, -1]],
      ['elapsedMsHistogram', [0, 0, 0, 0, 0, 0, 0, 0.5]],
    ];
    for (const [field, histogram] of invalid) {
      const event = { ...windowSummary(), [field]: histogram };
      expect(mapHistoryDiagnosticEvent(event, hash)).toHaveProperty(field, undefined);
    }
    expect(hash).not.toHaveBeenCalled();
  });
});
