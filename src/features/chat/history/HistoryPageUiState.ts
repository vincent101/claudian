import type { MessageUiState } from './HistoryPageStore';

export function capturePageUiState(root: HTMLElement, state: Map<string, MessageUiState>): void {
  root.querySelectorAll<HTMLElement>('[data-message-id]').forEach(messageEl => {
    const messageId = messageEl.dataset.messageId;
    if (!messageId) return;
    messageEl.querySelectorAll<HTMLElement>('[aria-expanded]').forEach((element, index) => {
      state.set(`${messageId}:expanded:${index}`, {
        expanded: element.getAttribute('aria-expanded') === 'true',
      });
    });
    messageEl.querySelectorAll<HTMLElement>('.claudian-text-block').forEach((element, index) => {
      state.set(`${messageId}:detail:${index}`, {
        detailLoaded: !element.classList.contains('claudian-text-lazy'),
      });
    });
  });
}

export function restorePageUiState(root: HTMLElement, state: Map<string, MessageUiState>): void {
  root.querySelectorAll<HTMLElement>('[data-message-id]').forEach(messageEl => {
    const messageId = messageEl.dataset.messageId;
    if (!messageId) return;
    messageEl.querySelectorAll<HTMLElement>('[aria-expanded]').forEach((element, index) => {
      const expanded = state.get(`${messageId}:expanded:${index}`)?.expanded;
      if (expanded !== undefined && expanded !== (element.getAttribute('aria-expanded') === 'true')) element.click();
    });
    messageEl.querySelectorAll<HTMLElement>('.claudian-text-block').forEach((element, index) => {
      if (!state.get(`${messageId}:detail:${index}`)?.detailLoaded || !element.classList.contains('claudian-text-lazy')) return;
      element.querySelector<HTMLElement>('.claudian-text-lazy-expand')?.click();
    });
  });
}
