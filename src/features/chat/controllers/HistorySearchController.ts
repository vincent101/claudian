import type { HistorySearchResult } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';

interface HistorySearchControllerDeps {
  rootEl: HTMLElement;
  messagesEl: HTMLElement;
  getConversationId: () => string | null;
  searchHistory: (conversationId: string, query: string) => Promise<HistorySearchResult[]>;
  locateResult: (result: HistorySearchResult) => Promise<void>;
}

export class HistorySearchController {
  private panel: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private results: HistorySearchResult[] = [];
  private selectedIndex = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readonly onRootKeyDown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'f' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      this.open();
      return;
    }
    if (event.key === 'Escape' && this.panel) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  };

  constructor(private readonly deps: HistorySearchControllerDeps) {
    deps.rootEl.addEventListener('keydown', this.onRootKeyDown);
  }

  open(): void {
    if (this.panel) {
      this.input?.focus();
      return;
    }
    const panel = document.createElement('div');
    panel.className = 'claudian-history-search';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = t('chat.search.placeholder');
    input.setAttribute('aria-label', t('chat.search.placeholder'));
    const results = document.createElement('div');
    results.className = 'claudian-history-search-results';
    panel.append(input, results);
    this.deps.rootEl.insertBefore(panel, this.deps.rootEl.firstChild);
    this.panel = panel;
    this.input = input;
    this.resultsEl = results;
    input.addEventListener('input', () => this.scheduleSearch());
    input.addEventListener('keydown', event => this.onInputKeyDown(event));
    input.focus();
  }

  close(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.panel?.remove();
    this.panel = null;
    this.input = null;
    this.resultsEl = null;
    this.results = [];
    this.selectedIndex = -1;
  }

  destroy(): void {
    this.close();
    this.deps.rootEl.removeEventListener('keydown', this.onRootKeyDown);
  }

  private scheduleSearch(): void {
    if (this.timer) clearTimeout(this.timer);
    const generation = ++this.generation;
    this.timer = setTimeout(() => { void this.runSearch(generation); }, 300);
  }

  private async runSearch(generation: number): Promise<void> {
    const conversationId = this.deps.getConversationId();
    const query = this.input?.value.trim() ?? '';
    if (!conversationId || !query) {
      this.results = [];
      this.selectedIndex = -1;
      this.renderResults();
      return;
    }
    let results: HistorySearchResult[];
    try {
      results = await this.deps.searchHistory(conversationId, query);
    } catch {
      if (generation !== this.generation || !this.panel) return;
      this.renderError();
      return;
    }
    if (generation !== this.generation || !this.panel) return;
    this.results = results;
    this.selectedIndex = results.length > 0 ? 0 : -1;
    this.renderResults();
  }

  private locate(result: HistorySearchResult): void {
    // e.g. the search cursor expired between indexing and clicking a result;
    // surface the failure in the panel instead of an unhandled rejection.
    this.deps.locateResult(result).catch(() => {
      if (this.panel) this.renderError();
    });
  }

  private onInputKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (this.results.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
      this.renderResults();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = this.results[Math.max(0, this.selectedIndex)];
      if (selected) this.locate(selected);
    }
  }

  private renderResults(): void {
    if (!this.resultsEl) return;
    this.resultsEl.replaceChildren();
    if (this.results.length === 0) {
      if (this.input?.value.trim()) {
        const empty = document.createElement('div');
        empty.className = 'claudian-history-search-empty';
        empty.textContent = t('chat.search.noResults');
        this.resultsEl.appendChild(empty);
      }
      return;
    }
    this.results.forEach((result, index) => {
      const button = document.createElement('button');
      button.className = `claudian-history-search-result${index === this.selectedIndex ? ' is-selected' : ''}`;
      const snippet = document.createElement('div');
      snippet.className = 'claudian-history-search-snippet';
      snippet.textContent = result.snippet;
      const time = document.createElement('div');
      time.className = 'claudian-history-search-time';
      time.textContent = result.timestamp ? new Date(result.timestamp).toLocaleString() : '';
      button.append(snippet, time);
      button.addEventListener('click', () => this.locate(result));
      this.resultsEl!.appendChild(button);
    });
  }

  private renderError(): void {
    if (!this.resultsEl) return;
    this.results = [];
    this.selectedIndex = -1;
    this.resultsEl.replaceChildren();
    const error = document.createElement('div');
    error.className = 'claudian-history-search-error';
    error.textContent = t('chat.search.error');
    this.resultsEl.appendChild(error);
  }
}
