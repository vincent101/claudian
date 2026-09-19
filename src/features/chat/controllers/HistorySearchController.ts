import type { HistorySearchResult } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';

type ProjectionPoint = { node: Text; offset: number } | null;
export interface VisibleTextProjection { text: string; points: ProjectionPoint[] }
export interface VisibleMatch { ordinal: number; ranges: Range[] }

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'LI']);
const EXCLUDED_SELECTOR = '.claudian-message-actions,button,time,.claudian-message-timestamp,[aria-hidden="true"],[hidden]';
const isHidden = (el: Element): boolean => el.matches(EXCLUDED_SELECTOR) || el.closest(EXCLUDED_SELECTOR) !== null;

export function projectVisibleText(root: HTMLElement): VisibleTextProjection {
  let text = '';
  const points: ProjectionPoint[] = [];
  const separator = (value: string): void => {
    if (!text || text.endsWith(value)) return;
    text += value;
    points.push(...Array.from<ProjectionPoint>({ length: value.length }).fill(null));
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.parentElement || isHidden(node.parentElement)) return;
      const value = node.textContent ?? '';
      text += value;
      for (let index = 0; index < value.length; index += 1) points.push({ node: node as Text, offset: index });
      return;
    }
    if (!(node instanceof HTMLElement) || isHidden(node)) return;
    if (node.tagName === 'BR') { separator('\n'); return; }
    Array.from(node.childNodes).forEach((child, index, children) => {
      visit(child);
      const element = child instanceof HTMLElement ? child : null;
      if (!element || index === children.length - 1) return;
      if (element.tagName === 'TD' || element.tagName === 'TH') separator('\t');
      else if (element.tagName === 'TR' || BLOCK_TAGS.has(element.tagName)) separator('\n');
    });
  };
  root.querySelectorAll<HTMLElement>('.claudian-text-block').forEach((block, index) => {
    if (index > 0) separator('\n');
    visit(block);
  });
  return { text, points };
}

export function enumerateVisibleMatches(root: HTMLElement, query: string): VisibleMatch[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const projection = projectVisibleText(root);
  const lower = projection.text.toLocaleLowerCase();
  const matches: VisibleMatch[] = [];
  let start = lower.indexOf(needle);
  while (start >= 0) {
    const slice = projection.points.slice(start, start + needle.length);
    if (slice.length === needle.length && slice.every(Boolean)) {
      const ranges: Range[] = [];
      let segmentStart = 0;
      for (let index = 1; index <= slice.length; index += 1) {
        const previous = slice[index - 1]!;
        const current = slice[index];
        if (index < slice.length && current?.node === previous.node && current.offset === previous.offset + 1) continue;
        const first = slice[segmentStart]!;
        const range = root.ownerDocument.createRange();
        range.setStart(first.node, first.offset);
        range.setEnd(previous.node, previous.offset + 1);
        ranges.push(range);
        segmentStart = index;
      }
      matches.push({ ordinal: matches.length, ranges });
    }
    start = lower.indexOf(needle, start + needle.length);
  }
  return matches;
}

/**
 * Structured outcome of a search snapshot refresh, reported by the history
 * layer instead of guessed by callers. Early returns say why they do not
 * apply (lease-less providers are a normal capability branch, not a
 * failure); a real acquire/build failure still rejects.
 */
export type HistorySearchSnapshotRefreshResult =
  | { status: 'rebuilt' }
  | { status: 'cache_hit' }
  | { status: 'not_applicable'; reason: 'no_conversation' | 'no_lease' | 'provider_without_index' };

interface HistorySearchControllerDeps {
  rootEl: HTMLElement;
  messagesEl: HTMLElement;
  isActive: () => boolean;
  getConversationId: () => string | null;
  searchHistory: (
    conversationId: string,
    query: string,
    onPhase?: (phase: 'indexing' | 'searching') => void,
  ) => Promise<HistorySearchResult[]>;
  locateResult: (result: HistorySearchResult) => Promise<HTMLElement>;
  waitForResultRender: (projectionKey: string) => Promise<void>;
  refreshSearchSnapshot?: () => Promise<HistorySearchSnapshotRefreshResult>;
  releaseSearchPins?: () => void;
}
interface CloseOptions { restoreFocus?: boolean }
interface MarkEntry { generation: number; marks: HTMLElement[] }

export class HistorySearchController {
  private panel: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;
  private previousButton: HTMLButtonElement | null = null;
  private nextButton: HTMLButtonElement | null = null;
  private results: HistorySearchResult[] = [];
  private selectedIndex = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private openingFocus: HTMLElement | null = null;
  private locating = false;
  /**
   * Whether this open already rebound to a fresh snapshot. The first
   * non-empty query of each open refreshes once; later keystrokes reuse it so
   * typing never rebuilds the index per key.
   */
  private snapshotRefreshed = false;
  private readonly registry = new Map<string, MarkEntry>();
  private readonly eventDocument: Document | null;
  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (this.isSearchShortcut(event)) {
      if (!this.deps.isActive()) return;
      event.preventDefault(); event.stopPropagation(); this.open(); return;
    }
    if (event.key === 'Escape' && this.panel) { event.preventDefault(); event.stopPropagation(); this.close(); }
  };

  constructor(private readonly deps: HistorySearchControllerDeps) {
    this.eventDocument = deps.rootEl.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    this.eventDocument?.addEventListener('keydown', this.onDocumentKeyDown, { capture: true });
  }
  isActive(): boolean { return this.panel !== null; }

  open(): void {
    if (this.panel) { this.input?.focus(); this.input?.select(); return; }
    // A new open must rebind: turns that completed while the panel was
    // closed are invisible to the snapshot the tab acquired earlier.
    this.snapshotRefreshed = false;
    this.openingFocus = this.eventDocument?.activeElement instanceof HTMLElement ? this.eventDocument.activeElement : null;
    if (!this.eventDocument) return;
    const panel = this.eventDocument.createElement('div'); panel.className = 'claudian-history-search';
    const input = this.eventDocument.createElement('input'); input.type = 'search';
    const shortcut = this.getShortcutLabel(); input.placeholder = t('chat.search.placeholder', { shortcut }); input.setAttribute('aria-label', input.placeholder);
    const status = this.eventDocument.createElement('span'); status.className = 'claudian-history-search-status';
    const previous = this.makeButton('↑', 'chat.search.previous', () => { void this.navigate(-1); });
    const next = this.makeButton('↓', 'chat.search.next', () => { void this.navigate(1); });
    const close = this.makeButton('×', 'chat.search.close', () => this.close()); close.classList.add('claudian-history-search-close');
    panel.append(input, status, previous, next, close); this.deps.rootEl.insertBefore(panel, this.deps.rootEl.firstChild);
    this.panel = panel; this.input = input; this.statusEl = status; this.previousButton = previous; this.nextButton = next;
    input.addEventListener('input', () => this.scheduleSearch()); input.addEventListener('keydown', event => this.onInputKeyDown(event));
    this.renderStatus(); input.focus();
  }

  close(options: CloseOptions = {}): void {
    const focusTarget = this.openingFocus; this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.clearHighlights(); this.panel?.remove();
    this.panel = null; this.input = null; this.statusEl = null; this.previousButton = null; this.nextButton = null;
    this.results = []; this.selectedIndex = -1; this.openingFocus = null;
    this.deps.releaseSearchPins?.();
    if ((options.restoreFocus ?? true) && focusTarget?.isConnected) focusTarget.focus();
  }
  destroy(): void { this.close({ restoreFocus: false }); this.eventDocument?.removeEventListener('keydown', this.onDocumentKeyDown, { capture: true }); }
  onMessageContentRendered(projectionKey: string): void { if (this.panel && this.input?.value.trim()) this.applyMarks(projectionKey, this.generation); }
  onStreamComplete(): void {
    if (!this.panel || !this.input?.value.trim()) return;
    const generation = ++this.generation;
    void (async () => {
      try {
        await this.deps.refreshSearchSnapshot?.();
        // The stream-completion refresh already rebound this open.
        this.snapshotRefreshed = true;
        if (generation === this.generation) await this.runSearch(generation, true);
      } catch {
        if (generation === this.generation && this.panel) this.renderError(t('chat.search.error'));
      }
    })();
  }

  private makeButton(text: string, key: 'chat.search.previous' | 'chat.search.next' | 'chat.search.close', action: () => void): HTMLButtonElement {
    const button = this.deps.rootEl.ownerDocument.createElement('button'); button.type = 'button'; button.textContent = text;
    button.setAttribute('aria-label', t(key)); button.title = t(key); button.addEventListener('click', action); return button;
  }
  private isSearchShortcut(event: KeyboardEvent): boolean {
    if (event.isComposing || event.key.toLocaleLowerCase() !== 'f') return false;
    const isMac = navigator.platform.includes('Mac');
    return isMac ? event.metaKey && !event.ctrlKey && !event.altKey : event.ctrlKey && !event.metaKey && !event.altKey;
  }
  private getShortcutLabel(): string { return navigator.platform.includes('Mac') ? '⌘F' : 'Ctrl+F'; }
  private clearHighlights(): void { for (const entry of this.registry.values()) for (const mark of entry.marks) mark.replaceWith(mark.textContent ?? ''); this.registry.clear(); }
  private scheduleSearch(): void { if (this.timer) clearTimeout(this.timer); const generation = ++this.generation; this.timer = setTimeout(() => { void this.runSearch(generation); }, 300); }

  private async runSearch(generation: number, preserveCurrent = false): Promise<void> {
    const conversationId = this.deps.getConversationId(); const query = this.input?.value.trim() ?? ''; this.clearHighlights();
    if (!conversationId || !query) { this.results = []; this.selectedIndex = -1; this.renderStatus(); return; }
    // Rebind once per open before the first real query: the tab's fixed
    // snapshot predates the panel and may miss turns that finished while the
    // panel was closed. A failed refresh keeps the old snapshot usable; this
    // open still stops retrying so keystrokes never rebuild the index.
    if (!this.snapshotRefreshed) {
      this.snapshotRefreshed = true;
      try {
        await this.deps.refreshSearchSnapshot?.();
      } catch { /* stale snapshot stays searchable */ }
      if (generation !== this.generation || !this.panel) return;
    }
    this.setBusy(t('chat.search.indexing'));
    try {
      const previous = preserveCurrent ? this.results[this.selectedIndex] : undefined;
      const results = await this.deps.searchHistory(conversationId, query, phase => {
        if (generation === this.generation && this.panel) {
          this.setBusy(t(phase === 'indexing' ? 'chat.search.indexing' : 'chat.search.searching'));
        }
      });
      if (generation !== this.generation || !this.panel) return;
      this.results = results;
      const retained = previous ? results.findIndex(item => item.projectionKey === previous.projectionKey && item.matchOrdinal === previous.matchOrdinal) : -1;
      this.selectedIndex = retained >= 0 ? retained : results.length - 1;
      // Marks exist only where the fixed results say a navigable match is;
      // scanning every DOM message would ghost-highlight hits the snapshot
      // does not contain.
      new Set(results.map(item => item.projectionKey)).forEach(key => this.applyMarks(key, generation));
      this.renderStatus(); if (this.selectedIndex >= 0) await this.locateCurrent();
    } catch { if (generation === this.generation && this.panel) this.renderError(t('chat.search.error')); }
  }

  private async navigate(delta: number): Promise<void> {
    if (this.locating) return;
    const next = this.selectedIndex + delta;
    if (next < 0 || next >= this.results.length) { this.renderStatus(); return; }
    this.selectedIndex = next; this.renderStatus(); await this.locateCurrent();
  }
  private async locateCurrent(): Promise<void> {
    const result = this.results[this.selectedIndex]; if (!result) return;
    this.locating = true; this.setBusy(t('chat.search.locating'));
    try {
      const element = await this.deps.locateResult(result);
      await this.deps.waitForResultRender(result.projectionKey);
      this.applyMarks(result.projectionKey, this.generation);
      const current = this.registry.get(result.projectionKey)?.marks.filter(mark => mark.dataset.ordinal === String(result.matchOrdinal));
      if (!current?.length) throw new Error('projection_mismatch');
      this.registry.forEach(value => value.marks.forEach(mark => mark.classList.remove('is-current')));
      current.forEach(mark => mark.classList.add('is-current')); element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (error) { this.renderError(error instanceof Error && error.message === 'projection_mismatch' ? t('chat.search.projectionMismatch') : t('chat.search.retryError')); }
    finally { this.locating = false; if (this.panel && !this.panel.querySelector('.claudian-history-search-error')) this.renderStatus(); }
  }

  private applyMarks(projectionKey: string, generation: number): void {
    this.registry.get(projectionKey)?.marks.forEach(mark => mark.replaceWith(mark.textContent ?? ''));
    const message = Array.from(this.deps.messagesEl.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find(element => element.dataset.messageId === projectionKey) ?? null;
    if (!message) { this.registry.delete(projectionKey); return; }
    // `results` is the single truth: only ordinals the fixed snapshot
    // actually returned may carry a mark. DOM hits beyond the result set
    // (live turns not yet in the snapshot, trimmed summary text) must not
    // become unnavigable ghost highlights.
    const validOrdinals = new Set(
      this.results.filter(item => item.projectionKey === projectionKey && item.status !== 'projection_mismatch')
        .map(item => item.matchOrdinal),
    );
    const matches = enumerateVisibleMatches(message, this.input?.value.trim() ?? ''); const marks: HTMLElement[] = [];
    const segments = matches
      .flatMap(match => match.ranges.map(range => ({ range, ordinal: match.ordinal })))
      .filter(segment => validOrdinals.has(segment.ordinal));
    for (const { range, ordinal } of segments.reverse()) {
      const mark = this.deps.rootEl.ownerDocument.createElement('mark'); mark.className = 'claudian-search-match'; mark.dataset.ordinal = String(ordinal);
      range.surroundContents(mark); marks.push(mark);
    }
    this.registry.set(projectionKey, { generation, marks });
  }
  private onInputKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
    if (event.key === 'Enter') { event.preventDefault(); void this.navigate(event.shiftKey ? -1 : 1); }
  }
  private setBusy(text: string): void { if (this.statusEl) this.statusEl.textContent = text; if (this.previousButton) this.previousButton.disabled = true; if (this.nextButton) this.nextButton.disabled = true; }
  private renderStatus(): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = this.results.length === 0 ? (this.input?.value.trim() ? t('chat.search.noResults') : '') : t('chat.search.resultCount', { current: this.selectedIndex + 1, total: this.results.length });
    if (this.previousButton) this.previousButton.disabled = this.selectedIndex <= 0 || this.locating;
    if (this.nextButton) this.nextButton.disabled = this.selectedIndex < 0 || this.selectedIndex >= this.results.length - 1 || this.locating;
    this.panel?.querySelector('.claudian-history-search-error')?.remove();
  }
  private renderError(message: string): void {
    if (!this.panel) return;
    let error = this.panel.querySelector<HTMLElement>('.claudian-history-search-error');
    if (!error) { error = this.deps.rootEl.ownerDocument.createElement('span'); error.className = 'claudian-history-search-error'; this.panel.appendChild(error); }
    error.textContent = message; this.setBusy(message);
  }
}
