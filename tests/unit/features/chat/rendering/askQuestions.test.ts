import {
  normalizeAskQuestions,
  toRelayQuestions,
} from '@/features/chat/rendering/askQuestions';

describe('askQuestions shared normalize pipeline', () => {
  describe('normalizeAskQuestions', () => {
    it('returns empty for missing / non-array / empty questions', () => {
      expect(normalizeAskQuestions({})).toEqual([]);
      expect(normalizeAskQuestions({ questions: 'bad' })).toEqual([]);
      expect(normalizeAskQuestions({ questions: [] })).toEqual([]);
    });

    it('filters invalid questions, keeps valid ones', () => {
      const result = normalizeAskQuestions({
        questions: [
          { question: 'Valid', options: ['A'] },
          { options: ['B'] }, // missing question
          'not an object',
          null,
          { question: 'Empty', options: [] },
        ],
      });
      expect(result).toHaveLength(1);
      expect(result[0].question).toBe('Valid');
    });

    it('keeps free-form-only questions (options null + isOther)', () => {
      const result = normalizeAskQuestions({
        questions: [{ question: 'Enter token', options: null, isOther: true, isSecret: true }],
      });
      expect(result).toHaveLength(1);
      expect(result[0].options).toEqual([]);
      expect(result[0].isSecret).toBe(true);
    });

    it('deduplicates options by label (option renumbering)', () => {
      const result = normalizeAskQuestions({
        questions: [{ question: 'Pick', options: ['A', 'A', 'B'] }],
      });
      expect(result[0].options.map((o) => o.label)).toEqual(['A', 'B']);
    });

    it('coerces label/value from label/value/text/name and keeps value only when it differs', () => {
      const result = normalizeAskQuestions({
        questions: [
          {
            question: 'Q',
            options: [
              { label: 'Option A', description: 'desc A' },
              { value: 'Option B' },
              { text: 'Option C' },
              { name: 'Option D' },
              { label: 'Approve', value: 'allow_with_policy' },
              42,
            ],
          },
        ],
      });
      const options = result[0].options;
      expect(options.map((o) => o.label)).toEqual([
        'Option A',
        'Option B',
        'Option C',
        'Option D',
        'Approve',
        '42',
      ]);
      expect(options[0].description).toBe('desc A');
      expect(options[0].value).toBeUndefined();
      expect(options[4].value).toBe('allow_with_policy');
    });

    it('normalizes header fallback + truncation and multiSelect coercion', () => {
      const result = normalizeAskQuestions({
        questions: [
          { question: 'First', options: ['A'], header: 'VeryLongHeaderText' },
          { question: 'Second', options: ['B'], multiSelect: 'false' },
          { question: 'Third', options: ['C'], multiSelect: true },
        ],
      });
      expect(result[0].header).toBe('VeryLongHead');
      expect(result[1].header).toBe('Q2');
      expect(result[1].multiSelect).toBe(false);
      expect(result[2].multiSelect).toBe(true);
    });

    it('keeps question id when present', () => {
      const result = normalizeAskQuestions({
        questions: [{ id: 'color_q', question: 'Favorite color?', options: ['Red'] }],
      });
      expect(result[0].id).toBe('color_q');
    });
  });

  describe('toRelayQuestions (single-source export)', () => {
    it('projects normalized output, including deduped option order', () => {
      const normalized = normalizeAskQuestions({
        questions: [
          {
            question: 'Pick',
            options: [
              { label: 'A', description: 'first' },
              { label: 'A', description: 'dup' },
              'B',
            ],
            multiSelect: true,
            isOther: true,
          },
        ],
      });
      const relay = toRelayQuestions(normalized);
      // Relay options must carry the post-dedupe ordering the desktop card
      // renders — pick index 2 maps to desktop option "B", not the dropped dup.
      expect(relay[0].options).toEqual([
        { label: 'A', description: 'first' },
        { label: 'B', description: '' },
      ]);
      expect(relay[0].multiSelect).toBe(true);
      expect(relay[0].isOther).toBe(true);
      expect(relay[0].isSecret).toBe(false);
    });

    it('marks secret questions for phone-side display', () => {
      const normalized = normalizeAskQuestions({
        questions: [{ question: 'Enter token', options: null, isOther: true, isSecret: true }],
      });
      expect(toRelayQuestions(normalized)[0].isSecret).toBe(true);
    });
  });
});
