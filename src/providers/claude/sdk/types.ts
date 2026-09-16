import type { StreamChunk } from '../../../core/types';

export interface SessionInitEvent {
  type: 'session_init';
  sessionId: string;
  /** SDK-resolved model reported by system/init (concrete id, not the alias). */
  model?: string;
  agents?: string[];
  permissionMode?: string;
}

export interface ContextWindowEvent {
  type: 'context_window';
  contextWindow: number;
}

export type TransformEvent = StreamChunk | SessionInitEvent | ContextWindowEvent;
