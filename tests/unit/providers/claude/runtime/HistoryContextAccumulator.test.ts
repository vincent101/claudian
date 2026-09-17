import type { FullHistoryChunk } from '@/core/providers/types';
import { HISTORY_OMISSION_MARKER, HistoryContextAccumulator, recoveryCharacterBudget } from '@/providers/claude/runtime/HistoryContextAccumulator';

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

describe('recoveryCharacterBudget', () => {
  it('budgets two characters per token for this Chinese-heavy vault', () => {
    // Conservative first-pass coefficient: CJK averages 1-2 chars per token,
    // so 2 chars/token bounds the projection from above. Half the window
    // stays reserved for system/current prompts, tools and output.
    // 200k-token standard window → 200k chars of recovery context.
    expect(recoveryCharacterBudget(200_000)).toBe(200_000);
  });

  it('keeps a floor budget for tiny windows', () => {
    expect(recoveryCharacterBudget(0)).toBe(16_384);
  });
});
