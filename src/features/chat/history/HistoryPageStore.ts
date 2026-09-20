import type { LoadedTurnRange } from '../../../core/providers/types';
import type { ChatMessage } from '../../../core/types';

export type HistoryPagePin = 'visible' | 'adjacent' | 'live' | 'search' | 'transaction';
export type HistoryPageRenderState = 'mounted' | 'spacer' | 'evicted';
export type HistoryHeightQuality = 'measured' | 'estimated';
/**
 * Where a page's data may be reloaded from. `memory-only` marks synthetic
 * pages whose only valid source is the retained projection itself (rewind
 * rebuilds): the disk snapshot still contains the discarded branches, so
 * eviction would destroy the truth — these pages overcommit explicitly
 * under budget pressure instead of being reloaded from a stale index.
 */
export type HistoryPageRetention = 'reloadable' | 'memory-only';

export interface MessageUiState {
  expanded?: boolean;
  detailLoaded?: boolean;
}

export interface HistorySearchState {
  projectionKey: string;
  matchedText: string;
  matchOrdinal: number;
}

export interface HistoryPageRecord {
  pageKey: string;
  range: LoadedTurnRange;
  messages: ChatMessage[] | null;
  projectedWeight: number;
  retention: HistoryPageRetention;
  measuredHeight: number | null;
  measuredWidth: number | null;
  renderState: HistoryPageRenderState;
  uiState: Map<string, MessageUiState>;
  messageIds: Set<string>;
  lastAccess: number;
  pins: Set<HistoryPagePin>;
  renderGeneration: number;
  renderTicket: number;
  settledTicket: number | null;
  heightQuality: HistoryHeightQuality | null;
  heightStale: boolean;
}

export type HistoryPageStoreDiagnostic =
  | { kind: 'page_data_overcommit'; pages: number; projectedWeight: number };

export interface HistoryPageStoreOptions {
  maxPages?: number;
  maxProjectedWeight?: number;
  onDiagnostic?: (event: HistoryPageStoreDiagnostic) => void;
}

type TicketState = {
  outstanding: number;
  closed: boolean;
  waiters: Set<() => void>;
};

export class HistoryPageStore {
  private readonly records = new Map<string, HistoryPageRecord>();
  private readonly tickets = new Map<string, Map<number, TicketState>>();
  private readonly maxPages: number;
  private readonly maxProjectedWeight: number;
  private readonly onDiagnostic?: (event: HistoryPageStoreDiagnostic) => void;
  private clock = 0;

  constructor(options: HistoryPageStoreOptions = {}) {
    this.maxPages = options.maxPages ?? 12;
    this.maxProjectedWeight = options.maxProjectedWeight ?? 32 * 1024 * 1024;
    this.onDiagnostic = options.onDiagnostic;
  }

  upsertPage(input: Pick<HistoryPageRecord, 'pageKey' | 'range' | 'messages' | 'projectedWeight'> & { retention?: HistoryPageRetention; pins?: Iterable<HistoryPagePin> }): HistoryPageRecord {
    const existing = this.records.get(input.pageKey);
    if (existing) {
      existing.range = { ...input.range };
      existing.messages = input.messages;
      if (input.messages) existing.messageIds = new Set(input.messages.map(message => message.id));
      existing.projectedWeight = input.projectedWeight;
      // Absent retention preserves the record's data-source semantics — a
      // memory-only page must never be silently downgraded to evictable.
      if (input.retention) existing.retention = input.retention;
      for (const pin of input.pins ?? []) existing.pins.add(pin);
      existing.lastAccess = ++this.clock;
      this.enforceLimits();
      return existing;
    }
    const record: HistoryPageRecord = {
      ...input,
      retention: input.retention ?? 'reloadable',
      range: { ...input.range },
      measuredHeight: null,
      measuredWidth: null,
      renderState: 'evicted',
      uiState: new Map(),
      messageIds: new Set(input.messages?.map(message => message.id) ?? []),
      lastAccess: ++this.clock,
      pins: new Set(input.pins),
      renderGeneration: 0,
      renderTicket: 0,
      settledTicket: null,
      heightQuality: null,
      heightStale: false,
    };
    this.records.set(record.pageKey, record);
    this.enforceLimits();
    return record;
  }

  get(pageKey: string): HistoryPageRecord | undefined {
    const record = this.records.get(pageKey);
    if (record) record.lastAccess = ++this.clock;
    return record;
  }

  peek(pageKey: string): HistoryPageRecord | undefined {
    return this.records.get(pageKey);
  }

  values(): HistoryPageRecord[] {
    return [...this.records.values()];
  }

  findByMessageId(messageId: string): HistoryPageRecord | undefined {
    const record = [...this.records.values()].find(candidate => candidate.messageIds.has(messageId));
    if (record) record.lastAccess = ++this.clock;
    return record;
  }

  replaceMessage(pageKey: string, message: ChatMessage): boolean {
    const record = this.records.get(pageKey);
    if (!record?.messages) return false;
    record.messages = record.messages.map(current => current.id === message.id ? message : current);
    record.messageIds.add(message.id);
    record.lastAccess = ++this.clock;
    return true;
  }

  clear(): void {
    for (const ticketMap of this.tickets.values()) {
      for (const ticket of ticketMap.values()) this.resolveWaiters(ticket);
    }
    this.records.clear();
    this.tickets.clear();
  }

  pin(pageKey: string, pin: HistoryPagePin): void {
    this.records.get(pageKey)?.pins.add(pin);
  }

  unpin(pageKey: string, pin: HistoryPagePin): void {
    this.records.get(pageKey)?.pins.delete(pin);
    this.enforceLimits();
  }

  setUiState(pageKey: string, key: string, state: MessageUiState): void {
    this.records.get(pageKey)?.uiState.set(key, { ...state });
  }

  getUiState(pageKey: string, key: string): MessageUiState | undefined {
    const state = this.records.get(pageKey)?.uiState.get(key);
    return state ? { ...state } : undefined;
  }

  beginRender(pageKey: string, generation: number): number {
    const record = this.require(pageKey);
    record.renderGeneration = generation;
    record.renderTicket += 1;
    record.settledTicket = null;
    if (record.measuredHeight !== null) record.heightStale = true;
    const pageTickets = this.tickets.get(pageKey) ?? new Map<number, TicketState>();
    pageTickets.set(record.renderTicket, { outstanding: 0, closed: false, waiters: new Set() });
    this.tickets.set(pageKey, pageTickets);
    return record.renderTicket;
  }

  registerCurrentRenderWork(pageKey: string): () => void {
    const record = this.require(pageKey);
    if (this.isTicketSettled(pageKey, record.renderTicket)) {
      const ticket = this.beginRender(pageKey, record.renderGeneration + 1);
      const release = this.registerRenderSlot(pageKey, ticket);
      this.closeRenderTicket(pageKey, ticket);
      return release;
    }
    return this.registerRenderSlot(pageKey, record.renderTicket);
  }

  registerRenderSlot(pageKey: string, ticket: number): () => void {
    const state = this.ticket(pageKey, ticket);
    state.outstanding += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.tickets.get(pageKey)?.get(ticket);
      if (!current) return;
      current.outstanding = Math.max(0, current.outstanding - 1);
      this.trySettle(pageKey, ticket, current);
    };
  }

  closeRenderTicket(pageKey: string, ticket: number): void {
    const state = this.ticket(pageKey, ticket);
    state.closed = true;
    this.trySettle(pageKey, ticket, state);
  }

  isTicketSettled(pageKey: string, ticket: number): boolean {
    const record = this.records.get(pageKey);
    const state = this.tickets.get(pageKey)?.get(ticket);
    return record?.renderTicket === ticket
      && record.settledTicket === ticket
      && !!state?.closed
      && state.outstanding === 0;
  }

  async waitForCurrentTicket(pageKey: string, timeoutMs = 3000): Promise<boolean> {
    const record = this.require(pageKey);
    const ticket = record.renderTicket;
    if (this.isTicketSettled(pageKey, ticket)) return true;
    const state = this.ticket(pageKey, ticket);
    return new Promise(resolve => {
      let resolved = false;
      const finish = (value: boolean): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        state.waiters.delete(onSettled);
        resolve(value);
      };
      const onSettled = (): void => finish(this.isTicketSettled(pageKey, ticket));
      const timeout = setTimeout(() => finish(false), timeoutMs);
      state.waiters.add(onSettled);
    });
  }

  recordHeight(
    pageKey: string,
    ticket: number,
    height: number,
    width: number,
    quality: HistoryHeightQuality,
  ): boolean {
    const record = this.require(pageKey);
    if (ticket !== record.renderTicket) return false;
    const exact = quality === 'measured' && this.isTicketSettled(pageKey, ticket);
    const nextQuality: HistoryHeightQuality = exact ? 'measured' : 'estimated';
    if (
      nextQuality === 'estimated'
      && record.heightQuality === 'measured'
      && record.measuredWidth === width
    ) return false;
    record.measuredHeight = Math.max(0, height);
    record.measuredWidth = width;
    record.heightQuality = nextQuality;
    record.heightStale = !exact;
    return true;
  }

  markHeightsStale(): void {
    for (const record of this.records.values()) {
      if (record.measuredHeight !== null) record.heightStale = true;
    }
  }

  enforceLimits(): void {
    const resident = (): HistoryPageRecord[] => [...this.records.values()].filter(record => record.messages !== null);
    const overweight = (): boolean => {
      const pages = resident();
      return pages.length > this.maxPages
        || pages.reduce((sum, page) => sum + page.projectedWeight, 0) > this.maxProjectedWeight;
    };
    while (overweight()) {
      const victim = resident()
        .filter(record => record.pins.size === 0
          && record.renderState !== 'mounted'
          && !record.pageKey.startsWith('live:')
          && record.retention !== 'memory-only')
        .sort((a, b) => a.lastAccess - b.lastAccess)[0];
      if (!victim) {
        const pages = resident().filter(page => !page.pageKey.startsWith('live:'));
        if (pages.length === 0) return;
        this.onDiagnostic?.({
          kind: 'page_data_overcommit',
          pages: pages.length,
          projectedWeight: pages.reduce((sum, page) => sum + page.projectedWeight, 0),
        });
        return;
      }
      victim.messages = null;
      if (victim.renderState !== 'spacer') victim.renderState = 'evicted';
    }
  }

  private require(pageKey: string): HistoryPageRecord {
    const record = this.records.get(pageKey);
    if (!record) throw new Error(`Unknown history page: ${pageKey}`);
    return record;
  }

  private ticket(pageKey: string, ticket: number): TicketState {
    const state = this.tickets.get(pageKey)?.get(ticket);
    if (!state) throw new Error(`Unknown history render ticket: ${pageKey}/${ticket}`);
    return state;
  }

  private trySettle(pageKey: string, ticket: number, state: TicketState): void {
    if (!state.closed || state.outstanding !== 0) return;
    const record = this.records.get(pageKey);
    if (record?.renderTicket === ticket) record.settledTicket = ticket;
    this.resolveWaiters(state);
    const pageTickets = this.tickets.get(pageKey);
    for (const prior of [...(pageTickets?.keys() ?? [])]) {
      if (prior < ticket) pageTickets?.delete(prior);
    }
  }

  private resolveWaiters(state: TicketState): void {
    const waiters = [...state.waiters];
    state.waiters.clear();
    for (const waiter of waiters) waiter();
  }
}
