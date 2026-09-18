/** @jest-environment jsdom */
import type { MessageUiState } from '@/features/chat/history/HistoryPageStore';
import { capturePageUiState, restorePageUiState } from '@/features/chat/history/HistoryPageUiState';

const kinds = ['tool', 'thinking', 'subagent'] as const;

describe('HistoryPageUiState', () => {
  it.each(kinds)('restores %s expanded state after remount', kind => {
    const source = document.createElement('div');
    source.innerHTML = `<div data-message-id="m"><div class="${kind}" aria-expanded="true"></div></div>`;
    const state = new Map<string, MessageUiState>();
    capturePageUiState(source, state);

    const target = document.createElement('div');
    target.innerHTML = `<div data-message-id="m"><div class="${kind}" aria-expanded="false"></div></div>`;
    const toggle = target.querySelector<HTMLElement>('[aria-expanded]')!;
    toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', 'true'));
    restorePageUiState(target, state);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('uses stable block ids instead of sibling positions', () => {
    const source = document.createElement('div');
    source.innerHTML = '<div data-message-id="m"><div data-block-id="stable" aria-expanded="true"></div></div>';
    const state = new Map<string, MessageUiState>();
    capturePageUiState(source, state);
    const target = document.createElement('div');
    target.innerHTML = '<div data-message-id="m"><span aria-expanded="false"></span><div data-block-id="stable" aria-expanded="false"></div></div>';
    const stable = target.querySelector<HTMLElement>('[data-block-id="stable"]')!;
    stable.addEventListener('click', () => stable.setAttribute('aria-expanded', 'true'));
    restorePageUiState(target, state);
    expect(stable.getAttribute('aria-expanded')).toBe('true');
  });

  it('restores loaded detail through its lazy expand control', () => {
    const source = document.createElement('div');
    source.innerHTML = '<div data-message-id="m"><div class="claudian-text-block">full</div></div>';
    const state = new Map<string, MessageUiState>();
    capturePageUiState(source, state);

    const target = document.createElement('div');
    target.innerHTML = '<div data-message-id="m"><div class="claudian-text-block claudian-text-lazy"><button class="claudian-text-lazy-expand"></button></div></div>';
    const block = target.querySelector<HTMLElement>('.claudian-text-block')!;
    target.querySelector<HTMLElement>('button')!.addEventListener('click', () => block.classList.remove('claudian-text-lazy'));
    restorePageUiState(target, state);

    expect(block.classList.contains('claudian-text-lazy')).toBe(false);
  });
});
