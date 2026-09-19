/** @jest-environment jsdom */

import type { HistorySearchResult } from '@/core/providers/types';
import {
  enumerateVisibleMatches,
  HistorySearchController,
  projectVisibleText,
} from '@/features/chat/controllers/HistorySearchController';

function result(messageKey: string, snippet = 'before Needle after'): HistorySearchResult {
  return { projectionKey: messageKey, turnIndex: 0, matchOrdinal: 0, matchedText: 'Needle' };
}

describe('HistorySearchController', () => {
  let root: HTMLElement;
  let messages: HTMLElement;
  let searchHistory: jest.Mock;
  let locate: jest.Mock;
  let controller: HistorySearchController;
  let isActive: jest.Mock;
  let releaseSearchPins: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    root = document.createElement('div');
    messages = document.createElement('div');
    root.appendChild(messages);
    document.body.appendChild(root);
    searchHistory = jest.fn().mockResolvedValue([result('m1'), result('m2')]);
    locate = jest.fn().mockResolvedValue(undefined);
    isActive = jest.fn().mockReturnValue(true);
    releaseSearchPins = jest.fn();
    controller = new HistorySearchController({
      rootEl: root,
      messagesEl: messages,
      isActive,
      getConversationId: () => 'conversation',
      searchHistory,
      locateResult: locate,
      waitForResultRender: jest.fn().mockResolvedValue(undefined),
      releaseSearchPins,
    });
  });

  afterEach(() => {
    controller.destroy();
    root.remove();
    jest.useRealTimers();
  });

  it('handles the platform shortcut at document capture only for the active chat tab', () => {
    const shortcut = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: navigator.platform.includes('Mac'),
      ctrlKey: !navigator.platform.includes('Mac'),
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(shortcut);
    expect(root.querySelector('.claudian-history-search')).not.toBeNull();
    expect(shortcut.defaultPrevented).toBe(true);

    controller.close({ restoreFocus: false });
    isActive.mockReturnValue(false);
    const inactiveShortcut = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: navigator.platform.includes('Mac'),
      ctrlKey: !navigator.platform.includes('Mac'),
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(inactiveShortcut);
    expect(root.querySelector('.claudian-history-search')).toBeNull();
    expect(inactiveShortcut.defaultPrevented).toBe(false);
  });

  it('releases search page pins when the panel closes', () => {
    controller.open();
    controller.close({ restoreFocus: false });
    expect(releaseSearchPins).toHaveBeenCalledTimes(1);
  });

  it('selects the existing query when the shortcut is repeated', () => {
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'needle';
    const select = jest.spyOn(input, 'select');

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: navigator.platform.includes('Mac'),
      ctrlKey: !navigator.platform.includes('Mac'),
      bubbles: true,
      cancelable: true,
    }));

    expect(select).toHaveBeenCalled();
  });

  it('first Escape closes active search and restores the opening focus', () => {
    const opener = document.createElement('button');
    root.appendChild(opener);
    opener.focus();
    controller.open();

    const firstEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    messages.dispatchEvent(firstEscape);
    expect(root.querySelector('.claudian-history-search')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(firstEscape.defaultPrevented).toBe(true);

    const secondEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    messages.dispatchEvent(secondEscape);
    expect(secondEscape.defaultPrevented).toBe(false);
  });

  it('close button restores focus while lifecycle close does not', () => {
    const opener = document.createElement('button');
    root.appendChild(opener);
    opener.focus();
    controller.open();
    (root.querySelector('.claudian-history-search-close') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(opener);

    controller.open();
    messages.tabIndex = 0;
    messages.focus();
    controller.close({ restoreFocus: false });
    expect(document.activeElement).toBe(messages);
  });

  it('exposes platform shortcut text and active state', () => {
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    const expected = navigator.platform.includes('Mac') ? '⌘F' : 'Ctrl+F';
    expect(input.placeholder).toContain(expected);
    expect(controller.isActive()).toBe(true);
    controller.close({ restoreFocus: false });
    expect(controller.isActive()).toBe(false);
  });

  it('debounces search, defaults to newest, and uses non-circular Enter navigation', async () => {
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'NeEdLe'; input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve();
    expect(searchHistory).toHaveBeenCalledWith('conversation', 'NeEdLe', expect.any(Function));
    expect(locate).toHaveBeenCalledWith(expect.objectContaining({ projectionKey: 'm2' }));
    const next = root.querySelector('[aria-label] + button') as HTMLButtonElement | null;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(locate).toHaveBeenCalledTimes(1);
    expect(next).toBeDefined();
  });

  it('shows localized projection mismatch text when locating fails', async () => {
    locate.mockRejectedValueOnce(new Error('projection_mismatch'));
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'needle'; input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const text = root.querySelector('.claudian-history-search-error')?.textContent ?? '';
    expect(text).toBeTruthy();
    expect(text).not.toContain('projection_mismatch');
  });

  it('waits for an asynchronously rendered located result before applying marks', async () => {
    let releaseRender!: () => void;
    const renderGate = new Promise<void>(resolve => { releaseRender = resolve; });
    const message = document.createElement('div');
    message.className = 'claudian-message';
    message.dataset.messageId = 'm2';
    const block = document.createElement('div');
    block.className = 'claudian-text-block';
    message.appendChild(block);
    messages.appendChild(message);
    locate.mockResolvedValue(message);
    const waitForResultRender = jest.fn(async () => {
      await renderGate;
      block.textContent = 'before needle after';
    });
    controller.destroy();
    controller = new HistorySearchController({
      rootEl: root,
      messagesEl: messages,
      isActive,
      getConversationId: () => 'conversation',
      searchHistory,
      locateResult: locate,
      waitForResultRender,
    });

    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'needle';
    (controller as any).results = [result('m2')];
    (controller as any).selectedIndex = 0;
    const search = (controller as any).locateCurrent() as Promise<void>;
    await Promise.resolve();
    expect(waitForResultRender).toHaveBeenCalledWith('m2');
    expect(message.querySelector('mark')).toBeNull();

    releaseRender();
    await search;
    expect(waitForResultRender).toHaveBeenCalledWith('m2');
    expect(message.querySelector('mark')?.textContent).toBe('needle');
    expect(message.querySelector('mark')?.classList.contains('is-current')).toBe(true);
  });

  it('projects inline nodes, excludes controls, and rejects cross-block pseudo matches', () => {
    const message = document.createElement('div');
    message.innerHTML = '<div class="claudian-text-block"><p>nee<em>dl</em><a>e</a></p><p>other</p><table><tr><td>left</td><td>right</td></tr></table><button>needle</button></div>';
    expect(projectVisibleText(message).text).toBe('needle\nother\nleft\tright');
    expect(enumerateVisibleMatches(message, 'needle')).toHaveLength(1);
    expect(enumerateVisibleMatches(message, 'eother')).toHaveLength(0);
    expect(enumerateVisibleMatches(message, 'leftright')).toHaveLength(0);
  });

  it('enumerates three non-overlapping matches before marks mutate text nodes', () => {
    const message = document.createElement('div');
    message.innerHTML = '<div class="claudian-text-block"><code>x x</code> <span>x</span></div>';
    const matches = enumerateVisibleMatches(message, 'x');
    expect(matches.map(match => match.ordinal)).toEqual([0, 1, 2]);
    const ranges = matches.flatMap(match => match.ranges);
    expect(ranges).toHaveLength(3);
  });

  it('shows no-results for a non-empty query with an empty result set', async () => {
    searchHistory.mockResolvedValueOnce([]);
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'absent'; input.dispatchEvent(new Event('input'));
    await jest.advanceTimersByTimeAsync(300);

    expect(root.querySelector('.claudian-history-search-status')?.textContent).toBeTruthy();
    expect(locate).not.toHaveBeenCalled();
  });

  it('shows searching after index readiness and before results resolve', async () => {
    let release!: (value: HistorySearchResult[]) => void;
    searchHistory.mockImplementation(async (_id, _query, onPhase) => {
      onPhase?.('searching');
      return new Promise<HistorySearchResult[]>(resolve => { release = resolve; });
    });
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'needle'; input.dispatchEvent(new Event('input'));
    await jest.advanceTimersByTimeAsync(300);
    expect(root.querySelector('.claudian-history-search-status')?.textContent).toBeTruthy();
    release([]);
    await Promise.resolve();
  });

  it('shows an in-panel error instead of failing silently when searchHistory rejects', async () => {
    searchHistory.mockRejectedValueOnce(new Error('index unavailable'));
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'needle';
    input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();

    const error = root.querySelector('.claudian-history-search-error');
    expect(error).not.toBeNull();
    expect(error?.textContent).toBeTruthy();
  });

  describe('snapshot binding and unified results', () => {
    let refreshSnapshot: jest.Mock;

    const mountMessage = (key: string, text: string): HTMLElement => {
      const message = document.createElement('div');
      message.className = 'claudian-message';
      message.dataset.messageId = key;
      const block = document.createElement('div');
      block.className = 'claudian-text-block';
      block.textContent = text;
      message.appendChild(block);
      messages.appendChild(message);
      return message;
    };

    const makeController = (overrides: Partial<{ searchHistoryImpl: jest.Mock }> = {}): HistorySearchController => {
      controller.destroy();
      controller = new HistorySearchController({
        rootEl: root,
        messagesEl: messages,
        isActive,
        getConversationId: () => 'conversation',
        searchHistory: overrides.searchHistoryImpl ?? searchHistory,
        locateResult: locate,
        waitForResultRender: jest.fn().mockResolvedValue(undefined),
        refreshSearchSnapshot: refreshSnapshot,
      });
      return controller;
    };

    const typeQuery = async (instance: HistorySearchController, query: string): Promise<void> => {
      const input = root.querySelector('input') as HTMLInputElement;
      input.value = query;
      input.dispatchEvent(new Event('input'));
      await jest.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      void instance;
    };

    beforeEach(() => {
      refreshSnapshot = jest.fn().mockResolvedValue(undefined);
    });

    it('refreshes the snapshot once before the first non-empty query of each open', async () => {
      const callOrder: string[] = [];
      refreshSnapshot.mockImplementation(async () => { callOrder.push('refresh'); });
      searchHistory.mockImplementation(async () => { callOrder.push('search'); return []; });
      const instance = makeController();
      instance.open();
      await typeQuery(instance, 'needle');
      // The panel must not search a snapshot fixed before it was opened.
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['refresh', 'search']);

      await typeQuery(instance, 'other');
      // Subsequent keystrokes in the same open reuse the refreshed snapshot.
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['refresh', 'search', 'search']);

      instance.close({ restoreFocus: false });
      instance.open();
      await typeQuery(instance, 'needle');
      // A fresh open rebinds: closing while new turns landed must not leave
      // the next search on the pre-open snapshot.
      expect(refreshSnapshot).toHaveBeenCalledTimes(2);
      expect(callOrder).toEqual(['refresh', 'search', 'search', 'refresh', 'search']);
    });

    it('produces no ghost marks for DOM hits absent from the fixed results', async () => {
      mountMessage('m1', 'needle one');
      mountMessage('m2', 'needle two');
      searchHistory.mockResolvedValue([
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 0, matchedText: 'needle' },
      ]);
      const instance = makeController();
      instance.open();

      await typeQuery(instance, 'needle');

      // m2's DOM contains a hit the fixed snapshot does not know: it must
      // not gain a mark (no unnavigable highlight), while m1 stays marked.
      expect(messages.querySelector<HTMLElement>('[data-message-id="m1"] mark')).not.toBeNull();
      expect(messages.querySelector<HTMLElement>('[data-message-id="m2"] mark')).toBeNull();

      // After a stream-complete refresh re-searches, m2 enters the results
      // (mark + total) while the current item stays on the retained m1.
      searchHistory.mockResolvedValue([
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 0, matchedText: 'needle' },
        { projectionKey: 'm2', turnIndex: 1, matchOrdinal: 0, matchedText: 'needle' },
      ]);
      instance.onStreamComplete();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(messages.querySelector<HTMLElement>('[data-message-id="m2"] mark')).not.toBeNull();
      expect(messages.querySelector<HTMLElement>('[data-message-id="m1"] mark')?.classList.contains('is-current')).toBe(true);
      expect(messages.querySelector<HTMLElement>('[data-message-id="m2"] mark')?.classList.contains('is-current')).toBe(false);
    });

    it('keeps total, marks, and the current ordinal on the same results set', async () => {
      mountMessage('m1', 'needle needle needle');
      mountMessage('m2', 'needle');
      searchHistory.mockResolvedValue([
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 0, matchedText: 'needle' },
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 1, matchedText: 'needle' },
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 2, matchedText: 'needle' },
        { projectionKey: 'm2', turnIndex: 1, matchOrdinal: 0, matchedText: 'needle' },
      ]);
      const instance = makeController();
      instance.open();

      await typeQuery(instance, 'needle');

      const m1 = messages.querySelector<HTMLElement>('[data-message-id="m1"]');
      const m2 = messages.querySelector<HTMLElement>('[data-message-id="m2"]');
      // N/M total (4) equals the visible mark set; default current is the
      // newest result (m2 ordinal 0).
      expect(m1?.querySelectorAll('mark')).toHaveLength(3);
      expect(m2?.querySelectorAll('mark')).toHaveLength(1);
      expect(m2?.querySelector('mark')?.classList.contains('is-current')).toBe(true);
      expect(m1?.querySelector('mark.is-current')).toBeNull();

      // Enter navigates backwards through the same set; only the navigated
      // ordinal carries .is-current.
      const input = root.querySelector('input') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const m1Marks = Array.from(m1?.querySelectorAll('mark') ?? []);
      expect(m1Marks.map(mark => mark.classList.contains('is-current'))).toEqual([false, false, true]);
      expect(m2?.querySelector('mark')?.classList.contains('is-current')).toBe(false);
    });

    it('marks mixed-case matches case-insensitively from the visible projection', async () => {
      mountMessage('m1', 'Rewind then rewind then REWIND');
      searchHistory.mockResolvedValue([
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 0, matchedText: 'Rewind' },
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 1, matchedText: 'rewind' },
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 2, matchedText: 'REWIND' },
      ]);
      const instance = makeController();
      instance.open();

      await typeQuery(instance, 'rewIND');

      expect(messages.querySelectorAll('[data-message-id="m1"] mark')).toHaveLength(3);
    });

    it('re-searches after stream completion and preserves the current item by projectionKey and matchOrdinal', async () => {
      mountMessage('m1', 'needle one');
      mountMessage('m2', 'needle two');
      searchHistory.mockResolvedValueOnce([
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 0, matchedText: 'needle' },
        { projectionKey: 'm2', turnIndex: 1, matchOrdinal: 0, matchedText: 'needle' },
      ]);
      const instance = makeController();
      instance.open();
      await typeQuery(instance, 'needle');

      // The refresh may race a close: a rejected refresh must not break the
      // panel; the search still runs on the old snapshot.
      searchHistory.mockResolvedValueOnce([
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 0, matchedText: 'needle' },
        { projectionKey: 'm2', turnIndex: 1, matchOrdinal: 0, matchedText: 'needle' },
        { projectionKey: 'm3', turnIndex: 2, matchOrdinal: 0, matchedText: 'needle' },
      ]);
      instance.onStreamComplete();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // One refresh for the first query of this open plus the stream-completion
      // refresh; the re-search itself must not refresh again.
      expect(refreshSnapshot).toHaveBeenCalledTimes(2);
      // Current stays on m2 ordinal 0 even though a newer m3 hit exists.
      expect(messages.querySelector<HTMLElement>('[data-message-id="m2"] mark')?.classList.contains('is-current')).toBe(true);
      expect(messages.querySelector<HTMLElement>('[data-message-id="m3"] mark')).toBeNull();
    });

    describe('snapshot refresh state machine', () => {
      const settle = async (): Promise<void> => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      };
      const staleEl = (): HTMLElement | null => root.querySelector('.claudian-history-search-stale');
      const retryEl = (): HTMLButtonElement | null => root.querySelector('.claudian-history-search-retry');

      it('keeps the stale snapshot searchable after a failed refresh and never auto-retries', async () => {
        mountMessage('m1', 'needle one');
        mountMessage('m2', 'needle two');
        locate.mockImplementation(async result => {
          const element = messages.querySelector<HTMLElement>(`[data-message-id="${result.projectionKey}"]`);
          // jsdom does not implement scrollIntoView; production only needs it to exist.
          if (element) element.scrollIntoView = () => {};
          return element;
        });
        refreshSnapshot.mockRejectedValue(new Error('index build failed'));
        const instance = makeController();
        instance.open();
        await typeQuery(instance, 'needle');

        // The old snapshot still answers the query; the failure surfaces as
        // a stale hint with a Retry affordance, not a fatal error banner.
        expect(searchHistory).toHaveBeenCalledTimes(1);
        expect(root.querySelector('.claudian-history-search-error')).toBeNull();
        expect(staleEl()?.textContent).toBeTruthy();
        expect(retryEl()).not.toBeNull();

        await typeQuery(instance, 'needle t');
        await typeQuery(instance, 'needle th');
        // Keystrokes in the same open reuse the stale snapshot: exactly one
        // acquire attempt per open, no per-key retries.
        expect(refreshSnapshot).toHaveBeenCalledTimes(1);
        expect(searchHistory).toHaveBeenCalledTimes(3);
        // The hint coexists with the result count instead of hiding it.
        expect(root.querySelector('.claudian-history-search-status')?.textContent).toBeTruthy();
      });

      it('treats a lease-less refresh as a normal capability branch without a stale hint', async () => {
        refreshSnapshot.mockResolvedValue({ status: 'not_applicable', reason: 'provider_without_index' });
        const instance = makeController();
        instance.open();
        await typeQuery(instance, 'needle');

        // Codex/OpenCode DOM search is the designed path here: no warning,
        // no retry affordance, and the search itself ran.
        expect(refreshSnapshot).toHaveBeenCalledTimes(1);
        expect(searchHistory).toHaveBeenCalledTimes(1);
        expect(staleEl()).toBeNull();
        expect(retryEl()).toBeNull();
      });

      it('recovers through the explicit Retry affordance and re-runs the current query', async () => {
        refreshSnapshot.mockRejectedValueOnce(new Error('index build failed'));
        const instance = makeController();
        instance.open();
        await typeQuery(instance, 'needle');
        expect(staleEl()).not.toBeNull();

        refreshSnapshot.mockResolvedValue({ status: 'rebuilt' });
        retryEl()!.click();
        await settle();

        // The retry re-acquired exactly once, cleared the stale state, and
        // re-ran the active query on the fresh snapshot.
        expect(refreshSnapshot).toHaveBeenCalledTimes(2);
        expect(searchHistory).toHaveBeenCalledTimes(2);
        expect(staleEl()).toBeNull();
        expect(retryEl()).toBeNull();
      });

      it('stays stale when the explicit retry fails again', async () => {
        refreshSnapshot.mockRejectedValue(new Error('index build failed'));
        const instance = makeController();
        instance.open();
        await typeQuery(instance, 'needle');

        retryEl()!.click();
        await settle();

        expect(refreshSnapshot).toHaveBeenCalledTimes(2);
        expect(staleEl()).not.toBeNull();
        expect(retryEl()).not.toBeNull();
      });

      it('merges concurrent retry and stream-completion refreshes into one acquire', async () => {
        refreshSnapshot.mockRejectedValueOnce(new Error('index build failed'));
        const instance = makeController();
        instance.open();
        await typeQuery(instance, 'needle');
        expect(refreshSnapshot).toHaveBeenCalledTimes(1);

        let releaseRefresh!: (value: { status: 'rebuilt' }) => void;
        refreshSnapshot.mockImplementationOnce(() => new Promise(resolve => { releaseRefresh = resolve; }));
        retryEl()!.click();
        // The stream completes while the retry refresh is still in flight:
        // both must join the same acquire, not stack a second rebuild.
        instance.onStreamComplete();
        await Promise.resolve();
        releaseRefresh({ status: 'rebuilt' });
        await settle();

        expect(refreshSnapshot).toHaveBeenCalledTimes(2);
        // First query plus exactly one post-refresh re-run (the superseded
        // generation's search bails before querying).
        expect(searchHistory).toHaveBeenCalledTimes(2);
        expect(staleEl()).toBeNull();
      });

      it('shows the stale hint instead of a fatal error when the stream-completion refresh fails', async () => {
        mountMessage('m1', 'needle one');
        mountMessage('m2', 'needle two');
        refreshSnapshot.mockResolvedValue({ status: 'rebuilt' });
        const instance = makeController();
        instance.open();
        await typeQuery(instance, 'needle');

        refreshSnapshot.mockRejectedValueOnce(new Error('index build failed'));
        instance.onStreamComplete();
        await settle();

        expect(root.querySelector('.claudian-history-search-error')).toBeNull();
        expect(staleEl()).not.toBeNull();
        // Results from the old snapshot stay visible and searchable.
        expect(searchHistory).toHaveBeenCalledTimes(1);
      });

      it('re-arms the per-open auto refresh after close and reopen', async () => {
        refreshSnapshot.mockRejectedValue(new Error('index build failed'));
        const instance = makeController();
        instance.open();
        await typeQuery(instance, 'needle');
        expect(refreshSnapshot).toHaveBeenCalledTimes(1);

        instance.close({ restoreFocus: false });
        instance.open();
        await typeQuery(instance, 'needle');

        // A fresh open must retry the rebind: the failed open's state is
        // not allowed to stick across opens.
        expect(refreshSnapshot).toHaveBeenCalledTimes(2);
        expect(staleEl()).not.toBeNull();
      });

      it('does not let an in-flight refresh from a closed open pollute the reopened panel', async () => {
        let rejectRefresh!: (error: Error) => void;
        refreshSnapshot.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
        const instance = makeController();
        instance.open();
        const input = root.querySelector('input') as HTMLInputElement;
        input.value = 'needle';
        input.dispatchEvent(new Event('input'));
        jest.advanceTimersByTime(300);
        await Promise.resolve();
        // The first query's refresh is still in flight when the panel closes
        // and immediately reopens.
        instance.close({ restoreFocus: false });
        instance.open();

        rejectRefresh(new Error('index build failed'));
        await settle();

        // The old open's late rejection must not flip the new open's state:
        // no phantom stale hint, and the state machine is still armed.
        expect(staleEl()).toBeNull();
        expect(retryEl()).toBeNull();

        refreshSnapshot.mockResolvedValue({ status: 'rebuilt' });
        await typeQuery(instance, 'needle');
        // The reopened open performed its own auto refresh (its first query
        // plus the abandoned one from the closed open = 2 refreshes), and
        // only the reopened open's query searched (the closed open's search
        // aborted with its generation).
        expect(refreshSnapshot).toHaveBeenCalledTimes(2);
        expect(searchHistory).toHaveBeenCalledTimes(1);
        expect(staleEl()).toBeNull();
      });
    });
  });
});
