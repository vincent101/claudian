/**
 * Feature-level sink for history-render diagnostics. The renderer cannot
 * depend on the provider-owned diagnostic log, so it emits neutral events
 * here and the composition root (plugin onload) wires the sink.
 */
export type HistoryRenderDiagnosticEvent =
  | { kind: 'render_batch'; mounted: number; total: number; elapsedMs: number }
  | { kind: 'render_complete'; messages: number; batches: number; elapsedMs: number };

type HistoryRenderDiagnosticSink = (event: HistoryRenderDiagnosticEvent) => void;

let sink: HistoryRenderDiagnosticSink | null = null;

export function setHistoryRenderDiagnosticsSink(next: HistoryRenderDiagnosticSink | null): void {
  sink = next;
}

export function recordHistoryRenderEvent(event: HistoryRenderDiagnosticEvent): void {
  sink?.(event);
}
