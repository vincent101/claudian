import { consumeHistoryText } from '@/core/providers/consumeHistoryText';
import type { FullHistoryIterable } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import { buildContextFromHistory } from '@/utils/session';

const messages: ChatMessage[] = [
  { id: 'u', role: 'user', content: 'hello', timestamp: 1 },
  { id: 'a', role: 'assistant', content: 'world', timestamp: 2 },
];

describe('consumeHistoryText', () => {
  it('matches the legacy small-array formatter byte for byte and applies backpressure', async () => {
    let nextCalls = 0;
    let writes = 0;
    const iterable: FullHistoryIterable = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () => {
            nextCalls += 1;
            expect(nextCalls).toBeLessThanOrEqual(writes + 1);
            if (index >= messages.length) return { done: true, value: undefined };
            const message = messages[index++];
            return { done: false, value: { messages: [message], range: { start: index - 1, end: index }, sourceBytes: 1, done: index === messages.length } };
          },
        };
      },
    };
    const parts: string[] = [];
    await consumeHistoryText(iterable, { write: async text => { await Promise.resolve(); parts.push(text); writes += 1; } });
    expect(parts.join('')).toBe(buildContextFromHistory(messages));
  });
});
