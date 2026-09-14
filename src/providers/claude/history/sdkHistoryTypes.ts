import type { AsyncSubagentStatus, ChatMessage } from '../../../core/types';

export type SDKSessionReadStatus = 'complete' | 'missing' | 'oversize' | 'failed';

export interface SDKSessionReadResult {
  messages: SDKNativeMessage[];
  skippedLines: number;
  status: SDKSessionReadStatus;
  error?: string;
  sizeBytes?: number;
}

/** Stored in session JSONL files. Based on Claude Agent SDK internal format. */
export interface SDKNativeMessage {
  type: 'user' | 'assistant' | 'system' | 'result' | 'file-history-snapshot' | 'queue-operation' | 'attachment' | 'mode' | 'last-prompt';
  parentUuid?: string | null;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  isSidechain?: boolean;
  isReplay?: boolean;
  promptSource?: string;
  shouldQuery?: boolean;
  userType?: string;
  origin?: {
    kind?: string;
    body?: unknown;
    name?: string;
    server?: string;
    msg_id?: string;
    [key: string]: unknown;
  };
  message?: {
    id?: string;
    role?: string;
    content?: string | SDKNativeContentBlock[];
    model?: string;
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  subtype?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
  sourceToolUseID?: string;
  isMeta?: boolean;
  operation?: string;
  content?: string;
}

export interface SDKNativeContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface SDKSessionLoadResult {
  messages: ChatMessage[];
  skippedLines: number;
  status?: SDKSessionReadStatus;
  error?: string;
  sizeBytes?: number;
}

export interface AsyncSubagentResult {
  result: string;
  status: string;
}

export type ResolvedAsyncStatus = Exclude<AsyncSubagentStatus, 'pending'>;
