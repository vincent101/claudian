import { isCompactionCanceledStderr } from '../../../utils/interrupt';
import { isDisplayableExternalUser } from './externalUserMessage';
import type { SDKNativeMessage } from './sdkHistoryTypes';

export type SDKProjectionKind = 'skip' | 'user' | 'assistant' | 'compact-boundary';

function projectionText(message: SDKNativeMessage): string {
  const content = message.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n');
}

export function isSDKMessageProjectionSkipped(message: SDKNativeMessage): boolean {
  if (message.type === 'assistant') return message.message?.model === '<synthetic>';
  if (message.type !== 'user') return message.type !== 'system' || message.subtype !== 'compact_boundary';
  if ('toolUseResult' in message || 'sourceToolUseID' in message) return true;
  if (message.isMeta && !isDisplayableExternalUser(message)) return true;
  const text = projectionText(message);
  if (!text || (text.includes('<command-name>') && text.includes('<command-message>')) || isCompactionCanceledStderr(text)) return false;
  return text.startsWith('This session is being continued from a previous conversation')
    || text.includes('<command-name>')
    || text.includes('<local-command-stdout>')
    || text.includes('<local-command-stderr>')
    || text.includes('<task-notification>');
}

export function getSDKProjectionKind(message: SDKNativeMessage): SDKProjectionKind {
  if (isSDKMessageProjectionSkipped(message)) return 'skip';
  if (message.type === 'system' && message.subtype === 'compact_boundary') return 'compact-boundary';
  if (message.type === 'assistant') return 'assistant';
  if (message.type === 'user') return 'user';
  return 'skip';
}

export interface SDKProjectionState {
  pendingAssistantKey: string | null;
}

export function createSDKProjectionState(): SDKProjectionState {
  return { pendingAssistantKey: null };
}

/**
 * Assigns the stable DOM identity for the same grouping used by history
 * materialization. Consecutive assistants share their first key; a real user or
 * compact boundary closes that group. Skipped rows do not affect grouping.
 */
export function advanceSDKProjection(
  state: SDKProjectionState,
  kind: SDKProjectionKind,
  sourceKey: string,
): string | null {
  if (kind === 'skip') return null;
  if (kind === 'user') {
    state.pendingAssistantKey = null;
    return sourceKey;
  }
  if (kind === 'compact-boundary') {
    state.pendingAssistantKey = null;
    return sourceKey;
  }
  state.pendingAssistantKey ??= sourceKey;
  return state.pendingAssistantKey;
}
