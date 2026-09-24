import type { AskUserQuestionItem, AskUserQuestionOption } from '@/core/types/tools';

/**
 * Shared AskUserQuestion normalize pipeline. The desktop card rendering and
 * the ask-relay file export MUST go through this single code path: normalize
 * filters invalid questions and deduplicates options by label, so a second,
 * independent serialization from the raw input would renumber options and a
 * phone pick would land on a different desktop answer ("phone picks A,
 * desktop answers B").
 */
export function normalizeAskQuestions(input: Record<string, unknown>): AskUserQuestionItem[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(
      (q): q is {
        question: string;
        header?: string;
        options?: unknown[] | null;
        multiSelect?: boolean;
        isOther?: boolean;
        isSecret?: boolean;
        id?: string;
      } =>
        typeof q === 'object' &&
        q !== null &&
        typeof q.question === 'string' &&
        ((Array.isArray(q.options) && q.options.length > 0) || q.isOther === true),
    )
    .map((q, idx) => ({
      question: q.question,
      id: typeof (q as Record<string, unknown>).id === 'string' ? (q as Record<string, unknown>).id as string : undefined,
      header: typeof q.header === 'string' ? q.header.slice(0, 12) : `Q${idx + 1}`,
      options: deduplicateOptions((q.options ?? []).map((o) => coerceOption(o))),
      multiSelect: q.multiSelect === true,
      isOther: q.isOther === true,
      isSecret: q.isSecret === true,
    }));
}

function coerceOption(opt: unknown): AskUserQuestionOption {
  if (typeof opt === 'object' && opt !== null) {
    const obj = opt as Record<string, unknown>;
    const label = extractLabel(obj);
    const description = typeof obj.description === 'string' ? obj.description : '';
    const value = extractValue(obj, label);
    return { label, description, ...(value !== label ? { value } : {}) };
  }
  return { label: typeof opt === 'string' ? opt : String(opt), description: '' };
}

function deduplicateOptions(options: AskUserQuestionOption[]): AskUserQuestionOption[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    if (seen.has(o.label)) return false;
    seen.add(o.label);
    return true;
  });
}

function extractLabel(obj: Record<string, unknown>): string {
  if (typeof obj.label === 'string') return obj.label;
  if (typeof obj.value === 'string') return obj.value;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.name === 'string') return obj.name;
  return String(obj);
}

function extractValue(obj: Record<string, unknown>, fallback: string): string {
  if (typeof obj.value === 'string') return obj.value;
  if (typeof obj.id === 'string') return obj.id;
  return fallback;
}

/** ask.json question shape: the normalized item, trimmed to what the phone side needs. */
export interface AskRelayQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  isSecret: boolean;
  isOther: boolean;
  options: Array<{ label: string; description: string }>;
}

/**
 * Projects normalized questions into the ask-relay file shape. Must only be
 * fed with normalizeAskQuestions output — never the raw tool input.
 */
export function toRelayQuestions(questions: AskUserQuestionItem[]): AskRelayQuestion[] {
  return questions.map((q) => ({
    question: q.question,
    header: q.header,
    multiSelect: q.multiSelect,
    isSecret: q.isSecret === true,
    isOther: q.isOther === true,
    options: q.options.map((o) => ({ label: o.label, description: o.description })),
  }));
}
