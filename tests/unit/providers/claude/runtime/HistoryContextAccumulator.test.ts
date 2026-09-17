import type { FullHistoryChunk } from '@/core/providers/types';
import { HISTORY_OMISSION_MARKER,HistoryContextAccumulator } from '@/providers/claude/runtime/HistoryContextAccumulator';

function chunk(start: number, pairs: number): FullHistoryChunk {
  return {
    messages: Array.from({ length: pairs }, (_, i) => [
      { id: `u${start + i}`, role: 'user' as const, content: `question-${start + i}`, timestamp: start + i },
      { id: `a${start + i}`, role: 'assistant' as const, content: `answer-${start + i}`, timestamp: start + i + 0.1 },
    ]).flat(),
    range: { start, end: start + pairs }, sourceBytes: pairs * 10, done: false,
  };
}

describe('HistoryContextAccumulator', () => {
  it('keeps a contiguous newest complete-turn suffix and marks omission', () => {
    const accumulator = new HistoryContextAccumulator(120);
    accumulator.appendChunk(chunk(0, 4));
    const text = accumulator.build();
    expect(text).toContain(HISTORY_OMISSION_MARKER);
    expect(text).toContain('question-3');
    expect(text).toContain('answer-3');
    expect(text).not.toContain('question-0');
  });
});
