import type { MarkdownRenderSummary, MarkdownVisibility } from '../history/HistoryDiagnostics';

export interface MarkdownRenderContext {
  tabIdHash?: string;
  conversationIdHash?: string;
  tabGeneration?: number;
  conversationGeneration?: number;
  getTabActive?: () => boolean | undefined;
}

type Identity = {
  tabIdState: 'known' | 'unknown';
  conversationIdState: 'known' | 'unknown';
  tabIdHash?: string;
  conversationIdHash?: string;
  tabGeneration?: number;
  conversationGeneration?: number;
  tabActive: MarkdownVisibility;
  documentVisible: MarkdownVisibility;
  domConnected: MarkdownVisibility;
  viewport: 'unknown';
};

type Counters = Pick<MarkdownRenderSummary,
  'callsSum' | 'charsSum' | 'charsMax' | 'charsHistogram' | 'elapsedMsSum' | 'elapsedMsMax' |
  'elapsedMsHistogram' | 'settledCalls' | 'successCalls' | 'failureCalls' | 'inFlightAtStart' |
  'inFlightAtEnd' | 'abandonedCalls' | 'startVisibilityHistogram'>;

type Slot = {
  number: number;
  identity?: Identity;
  inFlight: number;
  dirty: boolean;
  counters: Counters;
};

class Token {
  settled = false;
  constructor(readonly owner: MarkdownRenderDiagnostics, readonly slot: Slot, readonly startedAt: number) {}
}

const CHAR_BOUNDS = [1024, 4096, 16384, 65536, 262144, 1048576];
const ELAPSED_BOUNDS = [1, 4, 16, 64, 256, 1024, 4096];
const CALL_BOUNDS = [2, 4, 8, 16, 32, 64, 128];
const HASH = /^[a-f0-9]{12}$/;

function counters(inFlight: number): Counters {
  return {
    callsSum: 0, charsSum: 0, charsMax: 0, charsHistogram: Array(7).fill(0),
    elapsedMsSum: 0, elapsedMsMax: 0, elapsedMsHistogram: Array(8).fill(0),
    settledCalls: 0, successCalls: 0, failureCalls: 0,
    inFlightAtStart: inFlight, inFlightAtEnd: inFlight, abandonedCalls: 0,
    startVisibilityHistogram: Array(27).fill(0),
  };
}

function increment(histogram: number[], bounds: number[], value: number): void {
  let index = 0;
  while (index < bounds.length && value >= bounds[index]) index++;
  histogram[index]++;
}

function visibility(value: boolean | undefined): MarkdownVisibility {
  return value === true ? 'yes' : value === false ? 'no' : 'unknown';
}

function visibilityIndex(identity: Identity): number {
  const index = (value: MarkdownVisibility): number => value === 'yes' ? 0 : value === 'no' ? 1 : 2;
  return index(identity.tabActive) * 9 + index(identity.documentVisible) * 3 + index(identity.domConnected);
}

function validGeneration(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! >= 0 ? value : undefined;
}

export class MarkdownRenderDiagnostics {
  private sink: ((summary: MarkdownRenderSummary) => void) | null;
  private context: MarkdownRenderContext = {};
  private readonly knownSlots = new Map<string, Slot>();
  private overflow: Slot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastCut: number;
  private flushId = 0;
  private closed = false;
  private lastCensusAt: number | null = null;
  private census: { domPageNodes: number; domMessageNodes: number; domTextBlockNodes: number } | null = null;

  constructor(private readonly collectorIdHash: string, sink: (summary: MarkdownRenderSummary) => void) {
    this.sink = sink;
    try {
      if (!HASH.test(collectorIdHash)) throw new Error('invalid diagnostic identity');
      this.lastCut = this.clock();
    } catch {
      this.lastCut = 0;
      this.disable();
    }
  }

  setContext(context: MarkdownRenderContext): void {
    if (this.closed) return;
    try {
      this.context = {
        tabIdHash: context.tabIdHash && HASH.test(context.tabIdHash) ? context.tabIdHash : undefined,
        conversationIdHash: context.conversationIdHash && HASH.test(context.conversationIdHash) ? context.conversationIdHash : undefined,
        tabGeneration: validGeneration(context.tabGeneration),
        conversationGeneration: validGeneration(context.conversationGeneration),
        getTabActive: context.getTabActive,
      };
    } catch {
      this.disable();
    }
  }

  start(element: HTMLElement, chars: number): unknown {
    if (this.closed) return undefined;
    try {
      if (!Number.isSafeInteger(chars) || chars < 0) throw new Error('invalid diagnostic length');
      const identity = this.identity(element);
      const slot = this.slot(identity);
      slot.inFlight++;
      slot.dirty = true;
      const c = slot.counters;
      c.callsSum++;
      c.charsSum += chars;
      c.charsMax = Math.max(c.charsMax, chars);
      increment(c.charsHistogram, CHAR_BOUNDS, chars);
      c.startVisibilityHistogram[visibilityIndex(identity)]++;
      this.schedule();
      return new Token(this, slot, this.clock());
    } catch {
      this.disable();
      return undefined;
    }
  }

  end(token: unknown, success: boolean): void {
    if (this.closed || !(token instanceof Token) || token.owner !== this || token.settled) return;
    token.settled = true;
    try {
      const elapsed = this.clock() - token.startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('invalid diagnostic clock');
      const slot = token.slot;
      slot.inFlight--;
      slot.dirty = true;
      const c = slot.counters;
      c.settledCalls++;
      if (success) c.successCalls++; else c.failureCalls++;
      c.elapsedMsSum += elapsed;
      c.elapsedMsMax = Math.max(c.elapsedMsMax, elapsed);
      increment(c.elapsedMsHistogram, ELAPSED_BOUNDS, elapsed);
      this.schedule();
    } catch {
      this.disable();
    }
  }

  /** Explicit, rate-limited DOM node census, never part of rendering. */
  sampleDom(root: HTMLElement): void {
    if (this.closed) return;
    try {
      const now = this.clock();
      if (this.lastCensusAt !== null && now - this.lastCensusAt < 5000) return;
      this.census = {
        domPageNodes: root.querySelectorAll('.claudian-history-page').length,
        domMessageNodes: root.querySelectorAll('.claudian-message').length,
        domTextBlockNodes: root.querySelectorAll('.claudian-text-block').length,
      };
      this.lastCensusAt = now;
      this.schedule();
    } catch {
      this.disable();
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    try {
      for (const slot of this.slots()) {
        if (slot.inFlight > 0) {
          slot.counters.abandonedCalls += slot.inFlight;
          slot.inFlight = 0;
          slot.dirty = true;
        }
      }
      this.flush('dispose');
    } catch {
      // Diagnostics must never change teardown or rendering.
    } finally {
      this.disable();
    }
  }

  private clock(): number {
    const value = performance.now();
    if (!Number.isFinite(value) || value < 0) throw new Error('invalid diagnostic clock');
    return value;
  }

  private identity(element: HTMLElement): Identity {
    const tabIdHash = this.context.tabIdHash;
    const conversationIdHash = this.context.conversationIdHash;
    const documentState = element.ownerDocument?.visibilityState;
    return {
      tabIdState: tabIdHash ? 'known' : 'unknown',
      conversationIdState: conversationIdHash ? 'known' : 'unknown',
      ...(tabIdHash ? { tabIdHash } : {}),
      ...(conversationIdHash ? { conversationIdHash } : {}),
      ...(this.context.tabGeneration !== undefined ? { tabGeneration: this.context.tabGeneration } : {}),
      ...(this.context.conversationGeneration !== undefined ? { conversationGeneration: this.context.conversationGeneration } : {}),
      tabActive: visibility(this.context.getTabActive?.()),
      documentVisible: documentState === 'visible' ? 'yes' : documentState === 'hidden' ? 'no' : 'unknown',
      domConnected: visibility(typeof element.isConnected === 'boolean' ? element.isConnected : undefined),
      viewport: 'unknown',
    };
  }

  private slot(identity: Identity): Slot {
    const key = JSON.stringify(identity);
    const existing = this.knownSlots.get(key);
    if (existing) return existing;
    if (this.knownSlots.size < 31) {
      const slot: Slot = { number: this.knownSlots.size + 1, identity, inFlight: 0, dirty: false, counters: counters(0) };
      this.knownSlots.set(key, slot);
      return slot;
    }
    if (!this.overflow) this.overflow = { number: 0, inFlight: 0, dirty: false, counters: counters(0) };
    return this.overflow;
  }

  private slots(): Slot[] {
    return [...this.knownSlots.values(), ...(this.overflow ? [this.overflow] : [])];
  }

  private schedule(): void {
    if (this.timer === null && !this.closed) this.timer = setTimeout(() => {
      this.timer = null;
      try { this.flush('timer'); } catch { this.disable(); }
    }, 5000);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private flush(reason: 'timer' | 'dispose'): void {
    this.clearTimer();
    const slots = this.slots();
    if (!this.census && !slots.some(slot => slot.dirty)) return;
    const now = this.clock();
    const windowMs = now - this.lastCut;
    if (!Number.isFinite(windowMs) || windowMs < 0) throw new Error('invalid diagnostic clock');
    this.lastCut = now;
    const flushId = ++this.flushId;
    const base = { kind: 'markdown_render_summary' as const, metricVersion: 1 as const,
      collectorIdHash: this.collectorIdHash, flushId, flushReason: reason, windowMs };
    const total = counters(0);
    const callsHistogram = Array(8).fill(0) as number[];
    let callsMax = 0;
    let callsSampleCount = 0;
    const rows: MarkdownRenderSummary[] = [];
    for (const slot of slots) {
      const c = slot.counters;
      c.inFlightAtEnd = slot.inFlight;
      if (slot.dirty || c.inFlightAtStart || c.inFlightAtEnd) {
        rows.push({ ...base, flushScope: 'attribution', ...c, attributionSlot: slot.number,
          attributionKind: slot.number === 0 ? 'overflow' : 'known', ...slot.identity });
        total.callsSum += c.callsSum;
        total.charsSum += c.charsSum;
        total.charsMax = Math.max(total.charsMax, c.charsMax);
        total.elapsedMsSum += c.elapsedMsSum;
        total.elapsedMsMax = Math.max(total.elapsedMsMax, c.elapsedMsMax);
        total.settledCalls += c.settledCalls;
        total.successCalls += c.successCalls;
        total.failureCalls += c.failureCalls;
        total.inFlightAtStart += c.inFlightAtStart;
        total.inFlightAtEnd += c.inFlightAtEnd;
        total.abandonedCalls += c.abandonedCalls;
        c.charsHistogram.forEach((n, i) => { total.charsHistogram[i] += n; });
        c.elapsedMsHistogram.forEach((n, i) => { total.elapsedMsHistogram[i] += n; });
        c.startVisibilityHistogram.forEach((n, i) => { total.startVisibilityHistogram[i] += n; });
        if (c.callsSum > 0) {
          callsSampleCount++;
          callsMax = Math.max(callsMax, c.callsSum);
          increment(callsHistogram, CALL_BOUNDS, c.callsSum);
        }
      }
      slot.counters = counters(slot.inFlight);
      slot.dirty = false;
    }
    const census = this.census;
    this.census = null;
    rows.push({ ...base, flushScope: 'window', ...total, callsMax, callsSampleCount,
      callsHistogram, attributionRows: rows.length, ...(census ?? {}) });
    for (const row of rows) {
      if (!this.sink) break;
      try { this.sink(row); } catch { this.disable(); break; }
    }
  }

  disable(): void {
    this.closed = true;
    this.clearTimer();
    this.sink = null;
    this.context = {};
    this.knownSlots.clear();
    this.overflow = null;
    this.census = null;
  }
}
