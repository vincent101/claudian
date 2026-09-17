import type { FullHistoryChunk } from '../../../core/providers/types';
import type { ChatMessage } from '../../../core/types';
import { formatHistoryMessage } from '../../../utils/session';

export const HISTORY_OMISSION_MARKER = '[Earlier history omitted: context recovery budget]';

interface CompleteTurn {
  text: string;
}

export class HistoryContextAccumulator {
  private turns: CompleteTurn[] = [];
  private chars = 0;
  private omitted = false;
  private lastUserMessage: ChatMessage | null = null;

  constructor(private readonly maxChars: number) {}

  appendChunk(chunk: FullHistoryChunk): void {
    let current: ChatMessage[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const text = current.map(formatHistoryMessage).filter((item): item is string => item !== null).join('\n\n');
      current = [];
      if (!text) return;
      this.turns.push({ text });
      this.chars += text.length + (this.turns.length > 1 ? 2 : 0);
    };
    for (const message of chunk.messages) {
      if (message.role === 'user' && current.length > 0) flush();
      current.push(message);
      if (message.role === 'user') this.lastUserMessage = message;
    }
    flush();
    while (this.turns.length > 0 && this.projectedLength(true) > this.maxChars) {
      const removed = this.turns.shift();
      this.omitted = true;
      this.chars -= (removed?.text.length ?? 0) + (this.turns.length > 0 ? 2 : 0);
    }
  }

  private projectedLength(omitted: boolean): number {
    return this.chars + (omitted ? HISTORY_OMISSION_MARKER.length + 2 : 0);
  }

  build(): string {
    const joined = this.turns.map(turn => turn.text).join('\n\n');
    if (!joined) return this.omitted ? HISTORY_OMISSION_MARKER : '';
    return this.omitted ? `${HISTORY_OMISSION_MARKER}\n\n${joined}` : joined;
  }

  getLastUserMessage(): ChatMessage | null {
    return this.lastUserMessage;
  }
}

export function recoveryCharacterBudget(contextTokens: number): number {
  // Four chars/token is the existing conservative approximation; half the
  // window remains available for system/current prompts, tools and output.
  return Math.max(16_384, Math.floor(contextTokens * 4 * 0.5));
}
