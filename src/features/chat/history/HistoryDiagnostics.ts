/**
 * Feature-level sink for history diagnostics. The chat feature cannot
 * depend on the provider-owned diagnostic log, so it emits neutral events
 * here and the composition root (plugin onload) wires the sink.
 */
export type HistorySearchSnapshotRefreshOutcome =
  | 'rebuilt'
  | 'cache_hit'
  | 'not_applicable'
  | 'failed';

export type HistoryDiagnosticEvent =
  | { kind: 'render_batch'; mounted: number; total: number; elapsedMs: number }
  | { kind: 'render_complete'; messages: number; batches: number; elapsedMs: number }
  | { kind: 'page_render_timeout'; pageKey: string; ticket: number; timeoutMs: number }
  | { kind: 'page_data_overcommit'; pages: number; projectedWeight: number }
  | { kind: 'dom_overcommit'; pageKey: string; turns: number }
  /**
   * A memory-only page was asked to rematerialize. Unreachable while eviction
   * exempts those pages; the event proves the invariant broke — the page must
   * never be reloaded from its stale disk source (F1).
   */
  | { kind: 'memory_only_rematerialize'; pageKey: string }
  /**
   * A spacer record was re-keyed onto the current snapshot generation
   * (same range, new identity) after a search snapshot refresh exchanged
   * the lease. The wrapper, height, and UI state survive in place.
   */
  | { kind: 'page_rekeyed'; pageKey: string; previousPageKey: string; turns: number }
  /**
   * A rematerialized window was refused: `range_mismatch` means the loaded
   * window does not equal the requested range (planner shrink or snapshot
   * fork — the permanent hole, now traced); `rekey_conflict` means the
   * fresh-generation key already holds a record, so the spacer stays
   * rather than merging two windows into one key.
   */
  | {
    kind: 'page_rematerialize_refused';
    pageKey: string;
    reason: 'range_mismatch' | 'rekey_conflict';
    rangeStart: number;
    rangeEnd: number;
    actualRangeStart: number;
    actualRangeEnd: number;
  }
  | {
    kind: 'search_snapshot_refresh';
    outcome: HistorySearchSnapshotRefreshOutcome;
    reason?: 'no_conversation' | 'no_lease' | 'provider_without_index' | 'stale';
    /** Attribution: which surface forced the refresh (search panel default). */
    trigger?: 'search' | 'rewind' | 'fork';
    elapsedMs: number;
  };

type HistoryDiagnosticSink = (event: HistoryDiagnosticEvent) => void;

let sink: HistoryDiagnosticSink | null = null;

export function setHistoryDiagnosticsSink(next: HistoryDiagnosticSink | null): void {
  sink = next;
}

export function recordHistoryDiagnosticEvent(event: HistoryDiagnosticEvent): void {
  sink?.(event);
}
