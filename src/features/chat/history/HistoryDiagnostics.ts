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

export type MarkdownVisibility = 'yes' | 'no' | 'unknown';

export interface MarkdownRenderSummary {
  kind: 'markdown_render_summary';
  metricVersion: 1;
  collectorIdHash: string;
  flushId: number;
  flushReason: 'timer' | 'dispose';
  flushScope: 'window' | 'attribution';
  windowMs: number;
  callsSum: number;
  charsSum: number;
  charsMax: number;
  charsHistogram: number[];
  elapsedMsSum: number;
  elapsedMsMax: number;
  elapsedMsHistogram: number[];
  settledCalls: number;
  successCalls: number;
  failureCalls: number;
  inFlightAtStart: number;
  inFlightAtEnd: number;
  abandonedCalls: number;
  startVisibilityHistogram: number[];
  attributionRows?: number;
  callsMax?: number;
  callsHistogram?: number[];
  callsSampleCount?: number;
  attributionSlot?: number;
  attributionKind?: 'known' | 'overflow';
  tabIdState?: 'known' | 'unknown';
  conversationIdState?: 'known' | 'unknown';
  tabIdHash?: string;
  conversationIdHash?: string;
  tabGeneration?: number;
  conversationGeneration?: number;
  tabActive?: MarkdownVisibility;
  documentVisible?: MarkdownVisibility;
  domConnected?: MarkdownVisibility;
  viewport?: 'unknown';
  domPageNodes?: number;
  domMessageNodes?: number;
  domTextBlockNodes?: number;
}

export type HistoryDiagnosticEvent =
  | MarkdownRenderSummary
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
    reason?: 'no_conversation' | 'no_lease' | 'provider_without_index' | 'stale' | 'grant_timeout';
    /** Attribution: which surface forced the refresh (search panel default). */
    trigger?: 'search' | 'rewind' | 'fork';
    elapsedMs: number;
  }
  /**
   * R2 save admission: a runtime sync targeted a conversation outside the
   * committed binding's record (e.g. an environment reconcile that still saw
   * the outgoing conversationId inside the commit→rebind window). The sync
   * ran but the adoption was failed — the binding's saves fall back to its
   * seed. The event traces the protocol bypass, never the session values.
   */
  | { kind: 'save_adoption_target_mismatch' }
  /**
   * R2 save admission: the record's materialization snapshot could not be
   * detached honestly (a non-plain-JSON message, or a throwing source), so the
   * messages axis was dropped for that save instead of persisting an
   * untrustworthy payload.
   */
  | { kind: 'save_materialization_rejected'; reason: 'not_plain_json' | 'source_error' };

type HistoryDiagnosticSink = (event: HistoryDiagnosticEvent) => void;

let sink: HistoryDiagnosticSink | null = null;

export function setHistoryDiagnosticsSink(next: HistoryDiagnosticSink | null): void {
  sink = next;
}

export function recordHistoryDiagnosticEvent(event: HistoryDiagnosticEvent): void {
  sink?.(event);
}
