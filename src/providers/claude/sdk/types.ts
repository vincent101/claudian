import type { StreamChunk } from '../../../core/types';

export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
  /** SDK-resolved model reported by system/init (concrete id, not the alias). */
  model?: string;
  agents?: string[];
  permissionMode?: string;
}

// No ContextWindowEvent anymore (2.3.2 ②, 2026-09-17): the SDK-reported
// context window stopped denominating usage — the preset configuration behind
// the model selector is the single denominator source.
export type TransformEvent = StreamChunk | SessionInitEvent;
