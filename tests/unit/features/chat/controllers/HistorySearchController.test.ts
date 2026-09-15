/** @jest-environment jsdom */

import type { HistorySearchResult } from '@/core/providers/types';
import { HistorySearchController } from '@/features/chat/controllers/HistorySearchController';

function result(messageKey: string, snippet = 'before Needle after'): HistorySearchResult {
  return { projectionKey: messageKey, turnIndex: 0, matchOrdinal: 0, cursor: `cursor:${messageKey}`, timestamp: 1, snippet, matchStart: 7, matchLength: 6, matchedText: 'Needle' };
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

  it('debounces case-insensitive search and renders empty state', async () => {
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'NeEdLe';
    input.dispatchEvent(new Event('input'));
    expect(searchHistory).not.toHaveBeenCalled();
    jest.advanceTimersByTime(299);
    expect(searchHistory).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(searchHistory).toHaveBeenCalledWith('conversation', 'NeEdLe');

    searchHistory.mockResolvedValueOnce([]);
    input.value = 'absent';
    input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    expect(root.querySelector('.claudian-history-search-empty')).not.toBeNull();
  });

  it('navigates with Enter and arrows and locates the selected result', async () => {
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'needle';
    input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(300);
    await Promise.resolve();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(locate).toHaveBeenCalledWith(expect.objectContaining({ projectionKey: 'm2' }));
  });

  it('shows an in-panel error instead of failing silently when locating a result rejects', async () => {
    // e.g. cursor expired: the history service can no longer resolve the page
    locate.mockRejectedValueOnce(new Error('cursor expired'));
    controller.open();
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'needle';
    input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(300);
    await Promise.resolve();

    const firstResult = root.querySelector('.claudian-history-search-result') as HTMLElement;
    firstResult.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(locate).toHaveBeenCalled();
    const error = root.querySelector('.claudian-history-search-error');
    expect(error).not.toBeNull();
    expect(error?.textContent).toBeTruthy();
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
