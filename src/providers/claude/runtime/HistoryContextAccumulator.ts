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
  // 2 chars/token is a conservative first-pass coefficient for this
  // Chinese-heavy vault: CJK averages roughly 1-2 chars per token, so 2
  // bounds the projection from above — underestimating the token cost of a
  // recovery injection would overshoot the context window and trip the
  // breaker on large sessions. Half the window remains available for
  // system/current prompts, tools and output. TODO: calibrate against real
  // tokenizer measurements on this vault's transcripts.
  return Math.max(16_384, Math.floor(contextTokens * 2 * 0.5));
}
