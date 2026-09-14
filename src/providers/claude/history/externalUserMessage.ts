import type { SDKNativeMessage } from './sdkHistoryTypes';

export const DISPLAYABLE_EXTERNAL_KINDS = new Set(['peer', 'channel', 'coordinator']);

export function extractUserText(message: SDKNativeMessage): string | undefined {
  const content = message.message?.content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim();
  return text || undefined;
}

export function unwrapExternalEnvelope(candidate: string, tag: 'cross-session-message' | 'agent-message'): string | null {
  const start = candidate.indexOf(`<${tag}`);
  if (start < 0) return candidate;
  const openEnd = candidate.indexOf('>', start + tag.length + 1);
  const close = openEnd < 0 ? -1 : candidate.indexOf(`</${tag}>`, openEnd + 1);
  return openEnd < 0 || close < 0 ? null : candidate.slice(openEnd + 1, close);
}

export function extractExternalDisplayContent(message: SDKNativeMessage): string | undefined {
  let candidate = typeof message.origin?.body === 'string'
    && message.origin.body.trim()
    ? message.origin.body
    : extractUserText(message);
  if (!candidate) return undefined;
  candidate = candidate.trim();
  const prologue = 'Another Claude session sent a message:';
  if (candidate.startsWith(prologue)) candidate = candidate.slice(prologue.length).trim();
  for (const tag of ['cross-session-message', 'agent-message'] as const) {
    const value = unwrapExternalEnvelope(candidate, tag);
    if (value === null) return undefined;
    candidate = value.trim();
  }
  const lines = candidate.split('\n');
  let first = 0;
  while (first < lines.length && (/^\[to\](?:\s|$)/.test(lines[first]) || /^\[from\](?:\s|$)/.test(lines[first]))) first += 1;
  if (first < lines.length && /^\[msg\](?:\s|$)/.test(lines[first])) lines[first] = lines[first].replace(/^\[msg\]\s*/, '');
  return lines.slice(first).join('\n').trim() || undefined;
}

export function isDisplayableExternalUser(message: SDKNativeMessage): boolean {
  if (message.type !== 'user' || 'toolUseResult' in message || 'sourceToolUseID' in message) return false;
  if (!DISPLAYABLE_EXTERNAL_KINDS.has(message.origin?.kind ?? '')) return false;
  if (!message.uuid && !message.origin?.msg_id) return false;
  return extractExternalDisplayContent(message) !== undefined;
}

export function isRealUserMessage(message: SDKNativeMessage): boolean {
  return message.type === 'user'
    && message.origin?.kind !== 'task-notification'
    && !('toolUseResult' in message)
    && (!message.isMeta || isDisplayableExternalUser(message))
    && !('sourceToolUseID' in message);
}
