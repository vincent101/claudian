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
  | {
    kind: 'search_snapshot_refresh';
    outcome: HistorySearchSnapshotRefreshOutcome;
    reason?: 'no_conversation' | 'no_lease' | 'provider_without_index';
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
