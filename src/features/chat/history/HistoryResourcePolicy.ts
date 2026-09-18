import type { HistoryLoadBudget } from '../../../core/providers/types';

const MiB = 1024 * 1024;

/**
 * First-round safe baselines from the B1 resource-budget design. Values are
 * calibratable constants, not user settings; adjust only after the 71.6 MB /
 * 91.3 MB / 1.59 GB isolation runs pass, and never remove the byte or char
 * hard caps when tuning.
 */
export const HISTORY_RESOURCE_POLICY = {
  firstScreen: { maxTurns: 200, maxSourceBytes: 8 * MiB, maxProjectedChars: 2_000_000, timeSliceMs: 8 },
  paging: { maxTurns: 25, maxSourceBytes: 8 * MiB, maxProjectedChars: 2_000_000, timeSliceMs: 8 },
  searchLocate: { maxTurns: 1, maxSourceBytes: 8 * MiB, maxProjectedChars: 2_000_000, timeSliceMs: 8 },
} satisfies Record<string, HistoryLoadBudget>;

export type HistoryBudgetKind = keyof typeof HISTORY_RESOURCE_POLICY;

/** Rendering-side guards for the lazy-shell batch; data bounds live in the policy budgets above. */
export const HISTORY_RENDER_LIMITS = {
  /** Text blocks above this render as a plain-text shell; Markdown renders only on expand. */
  lazyTextChars: 4096,
  /** Plain-text excerpt length shown by a lazy shell. */
  shellExcerptChars: 2048,
  /** Expand renders Markdown up to this size; larger blocks show an inline notice instead. */
  expandRenderMaxChars: 256 * 1024,
  /** Cooperative render slice: stop mounting after this many milliseconds. */
  renderTimeSliceMs: 8,
  /** Hard cap of messages mounted per frame slice, so tiny messages cannot starve the slice. */
  renderBatchMessages: 20,
};
