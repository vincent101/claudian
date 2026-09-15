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

  beforeEach(() => {
    jest.useFakeTimers();
    root = document.createElement('div');
    messages = document.createElement('div');
    root.appendChild(messages);
    document.body.appendChild(root);
    searchHistory = jest.fn().mockResolvedValue([result('m1'), result('m2')]);
    locate = jest.fn().mockResolvedValue(undefined);
    isActive = jest.fn().mockReturnValue(true);
    controller = new HistorySearchController({
      rootEl: root,
      messagesEl: messages,
      isActive,
      getConversationId: () => 'conversation',
      searchHistory,
      locateResult: locate,
      waitForResultRender: jest.fn().mockResolvedValue(undefined),
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
});
