import { HISTORY_OMISSION_MARKER } from '../runtime/HistoryContextAccumulator';
import type { SDKNativeMessage } from './sdkHistoryTypes';

/**
 * Recovery injection is persisted by Claude Code as an ordinary user row; its
 * stable identity is the role-prefixed multi-turn transcript body we generate,
 * or the budget-omission marker prefix when the rebuilt body was truncated.
 */
export function isRebuiltContextContent(textContent: string): boolean {
  if (textContent.startsWith(HISTORY_OMISSION_MARKER)) return true;
  if (!/^(User|Assistant):\s/.test(textContent)) return false;
  return textContent.includes('\n\nUser:')
    || textContent.includes('\n\nAssistant:')
    || textContent.includes('\n\nA:');
}

export function isRebuiltContextMessage(message: SDKNativeMessage): boolean {
  if (message.type !== 'user') return false;
  const content = message.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
      : '';
  return isRebuiltContextContent(text);
}
