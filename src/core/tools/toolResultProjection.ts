import type { ToolCallInfo } from '../types/tools';

/**
 * Projection clamp for oversized tool results (render-pipeline de-stress,
 * sub-item 3). ChatMessage projections are views — the transcript and the
 * history index keep the full text — so results above this budget are cut to
 * a prefix + marker before entering a ChatMessage.
 *
 * Why 256K chars: aligned with HISTORY_RENDER_LIMITS.expandRenderMaxChars
 * (HistoryResourcePolicy) — beyond this size the renderer already refuses
 * full content; and 32 MiB page budget ÷ (256K chars × 2 projected weight)
 * leaves room for 64 such entries before the data-layer cap.
 */
export const TOOL_RESULT_PROJECTION_CHARS = 256 * 1024;

const CLAMP_MARKER_SUFFIX = (originalChars: number): string =>
  `\n…[已截断：原文 ${originalChars} 字符]`;

const CLAMP_MARKER_PATTERN = /\n…\[已截断：原文 (\d+) 字符\]$/;

export interface ClampedToolResult {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/**
 * Recovers the original size recorded in a clamp marker, or null when the
 * text carries none. Consumers that receive an already-clamped string (sidecar
 * source clamp) use this to rebuild `resultTruncated` metadata.
 */
export function parseClampMarkerOriginalChars(text: string): number | null {
  const marker = CLAMP_MARKER_PATTERN.exec(text);
  if (!marker) return null;
  const originalChars = Number(marker[1]);
  return Number.isFinite(originalChars) && originalChars >= 0 ? originalChars : null;
}

export function clampToolResultForProjection(text: string): ClampedToolResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', truncated: false, originalChars: 0 };
  }
  if (text.length <= TOOL_RESULT_PROJECTION_CHARS) {
    return { text, truncated: false, originalChars: text.length };
  }

  // Idempotency: write points compose (extractAgentResult clamps, then the
  // StreamController write point clamps the same value again), so an
  // already-clamped string can reach this helper twice. Recognize our own
  // marker and keep the original count exact instead of double-clamping.
  const markerChars = parseClampMarkerOriginalChars(text);
  if (markerChars !== null && markerChars >= text.length) {
    return { text, truncated: true, originalChars: markerChars };
  }

  const originalChars = text.length;
  return {
    text: text.slice(0, TOOL_RESULT_PROJECTION_CHARS) + CLAMP_MARKER_SUFFIX(originalChars),
    truncated: true,
    originalChars,
  };
}

/**
 * Assigns a tool result to a ToolCallInfo with the projection clamp applied.
 * Metadata policy: `resultTruncated` reflects the CURRENT assignment exactly —
 * set on truncation, cleared otherwise (a later exact assignment supersedes an
 * earlier clamp from the progressive-append path).
 */
export function setClampedToolCallResult(toolCall: ToolCallInfo, text: string): void {
  const clamped = clampToolResultForProjection(text);
  toolCall.result = clamped.text;
  if (clamped.truncated) {
    toolCall.resultTruncated = { originalChars: clamped.originalChars };
  } else {
    delete toolCall.resultTruncated;
  }
}
