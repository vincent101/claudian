import type { MessageUiState } from './HistoryPageStore';

export function capturePageUiState(root: HTMLElement, state: Map<string, MessageUiState>): void {
  root.querySelectorAll<HTMLElement>('[data-message-id]').forEach(messageEl => {
    const messageId = messageEl.dataset.messageId;
    if (!messageId) return;
    messageEl.querySelectorAll<HTMLElement>('[aria-expanded]').forEach((element, index) => {
      const key = `${messageId}:expanded:${stableBlockKey(element, index)}`;
      const expanded = element.getAttribute('aria-expanded') === 'true';
      state.set(key, { expanded });
      const toolId = element.closest<HTMLElement>('[data-tool-id]')?.dataset.toolId;
      if (toolId) {
        const message = (messageEl as HTMLElement & { __message?: { toolCalls?: Array<{ id: string; isExpanded?: boolean }> } }).__message;
        const tool = message?.toolCalls?.find(candidate => candidate.id === toolId);
        if (tool) tool.isExpanded = expanded;
      }
    });
    messageEl.querySelectorAll<HTMLElement>('.claudian-text-block').forEach((element, index) => {
      state.set(`${messageId}:detail:${stableBlockKey(element, index)}`, {
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
      const expanded = state.get(`${messageId}:expanded:${stableBlockKey(element, index)}`)?.expanded;
      if (expanded !== undefined && expanded !== (element.getAttribute('aria-expanded') === 'true')) element.click();
    });
    messageEl.querySelectorAll<HTMLElement>('.claudian-text-block').forEach((element, index) => {
      if (!state.get(`${messageId}:detail:${stableBlockKey(element, index)}`)?.detailLoaded || !element.classList.contains('claudian-text-lazy')) return;
      element.querySelector<HTMLElement>('.claudian-text-lazy-expand')?.click();
    });
  });
}

function stableBlockKey(element: HTMLElement, fallbackIndex: number): string {
  const stableClass = [...element.classList]
    .filter(name => name !== 'expanded' && name !== 'claudian-text-lazy')
    .sort()
    .join('.');
  return element.dataset.blockId
    ?? element.dataset.toolId
    ?? element.closest<HTMLElement>('[data-tool-id]')?.dataset.toolId
    ?? `${stableClass}:${fallbackIndex}`;
}
