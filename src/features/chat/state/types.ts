import type { EditorView } from '@codemirror/view';

import type {
  AttemptToken, BindingToken, CaptureAcknowledgement, CloseToken, HistoryIndexLease, HistoryTailStart, LoadedTurnRange, MetadataPatch,
  OwnerToken, ProviderId, RecordHandle, RecordVersions, RegisteredSaveRequest, RuntimeAdoptionToken, SaveAdmission,
  SaveAdmissionPending, SaveReceipt, SaveRejectionReason, SaveTicket, SaveToken, SessionBindingPatch,
} from '../../../core/providers/types';
import type { CapturedSessionPersistence } from '../../../core/runtime/types';
import type { ChatRuntimeQueryOptions } from '../../../core/runtime/types';
import type { TodoItem } from '../../../core/tools/todo';
import type {
  ChatMessage,
  ImageAttachment,
  SubagentInfo,
  ToolCallInfo,
  UsageInfo,
} from '../../../core/types';
import type { BrowserSelectionContext } from '../../../utils/browser';
import type { CanvasSelectionContext } from '../../../utils/canvas';
import type { EditorSelectionContext } from '../../../utils/editor';
import type { HistoryPageStore } from '../history/HistoryPageStore';
import type { ThinkingBlockState } from '../rendering/ThinkingBlockRenderer';
import type { WriteEditState } from '../rendering/WriteEditRenderer';

/** Queued message waiting to be sent after current streaming completes. */
export interface QueuedMessage {
  content: string;
  images?: ImageAttachment[];
  editorContext: EditorSelectionContext | null;
  browserContext?: BrowserSelectionContext | null;
  canvasContext: CanvasSelectionContext | null;
}

/** Pending tool call waiting to be rendered (buffered until input is complete). */
export interface PendingToolCall {
  toolCall: ToolCallInfo;
  parentEl: HTMLElement | null;
}

/** Stored selection state from editor polling. */
export interface StoredSelection {
  notePath: string;
  selectedText: string;
  lineCount: number;
  startLine?: number;
  from?: number;
  to?: number;
  editorView?: EditorView;
  domRanges?: Range[];
}

/** Centralized chat state data. */
export interface ChatStateData {
  // Message state
  messages: ChatMessage[];
  historyLease: HistoryIndexLease | null;
  loadedRanges: LoadedTurnRange[];
  historyHasMore: boolean;
  historyLoading: boolean;
  historyError: string | null;
  historySnapshotOffset: number | null;
  /** Opaque tail-start credentials riding with the snapshot offset (H/P8). */
  historyTailStart: HistoryTailStart | null;
  historyPageStore: HistoryPageStore;

  // Streaming control
  isStreaming: boolean;
  cancelRequested: boolean;
  streamGeneration: number;
  /** Guards against concurrent operations during conversation creation. */
  isCreatingConversation: boolean;
  /** Guards against concurrent operations during conversation switching. */
  isSwitchingConversation: boolean;
  /** Local tab state is ahead of persisted conversation metadata. */
  hasPendingConversationSave: boolean;

  // Conversation identity
  currentConversationId: string | null;

  // Queued message
  queuedMessage: QueuedMessage | null;

  // Active streaming DOM state
  currentContentEl: HTMLElement | null;
  currentTextEl: HTMLElement | null;
  currentTextContent: string;
  currentThinkingState: ThinkingBlockState | null;
  thinkingEl: HTMLElement | null;
  queueIndicatorEl: HTMLElement | null;
  /** Debounce timeout for showing thinking indicator after inactivity. */
  thinkingIndicatorTimeout: ReturnType<typeof setTimeout> | null;

  // Tool tracking maps
  toolCallElements: Map<string, HTMLElement>;
  writeEditStates: Map<string, WriteEditState>;
  /** Pending tool calls buffered until input is complete (for non-streaming-style render). */
  pendingTools: Map<string, PendingToolCall>;

  // Context window usage
  usage: UsageInfo | null;
  // Flag to ignore usage updates (during session reset)
  ignoreUsageUpdates: boolean;

  // Current todo items for the persistent bottom panel
  currentTodos: TodoItem[] | null;

  // Attention state (approval pending, error, etc.)
  needsAttention: boolean;
  /** Nesting counter for begin/endAttention pairs (attention restored on last end). */
  pendingAttentionCount: number;
  /** Background tab finished streaming and awaits user review. */
  needsReview: boolean;

  // Auto-scroll control during streaming
  autoScrollEnabled: boolean;

  // Response timer state
  responseStartTime: number | null;
  flavorTimerInterval: ReturnType<typeof setInterval> | null;

  // Pending plan content for approve-new-session (auto-sends in new session after stream ends)
  pendingNewSessionPlan: string | null;

  // Plan file path captured from Write tool calls to provider plan directory during plan mode
  planFilePath: string | null;

  // Saved permission mode before entering plan mode (for Shift+Tab toggle restore)
  prePlanPermissionMode: string | null;
}

/** Callbacks for ChatState changes. */
export interface ChatStateCallbacks {
  onMessagesChanged?: () => void;
  onStreamingStateChanged?: (isStreaming: boolean) => void;
  onConversationChanged?: (id: string | null) => void;
  onUsageChanged?: (usage: UsageInfo | null) => void;
  onTodosChanged?: (todos: TodoItem[] | null) => void;
  onAttentionChanged?: (needsAttention: boolean) => void;
  onAutoScrollChanged?: (enabled: boolean) => void;
}

/** Options for query execution. */
export type QueryOptions = ChatRuntimeQueryOptions;

export interface PersistableBindingState {
  readonly metadata: MetadataPatch;
  readonly sessionSeed: SessionBindingPatch;
}
export interface ReservationWitness { readonly claim: object; readonly owns: () => boolean }
export interface BindingAttempt {
  readonly token: AttemptToken;
  readonly owner: OwnerToken;
  readonly record: RecordHandle;
  readonly expectedRecordVersions: RecordVersions;
  readonly outgoing: BindingToken | null;
}
export interface CommittedTabBinding {
  readonly token: BindingToken;
  readonly owner: OwnerToken;
  readonly record: RecordHandle;
  readonly recordVersions: RecordVersions;
  readonly dirtyRevision: number;
  readonly state: PersistableBindingState;
}
export interface CommitReceipt {
  readonly token: BindingToken;
  readonly attempt: AttemptToken;
  readonly owner: OwnerToken;
  readonly record: RecordHandle;
  readonly recordVersions: RecordVersions;
}
export interface RuntimePersistencePort {
  readonly identity: object;
  readonly providerId: ProviderId;
  captureSessionPersistence(): CapturedSessionPersistence;
  acknowledgeSessionPersistenceCapture(capture: CapturedSessionPersistence): void;
}
export interface RuntimeAdoptionReceipt {
  readonly token: RuntimeAdoptionToken;
  readonly owner: OwnerToken;
  readonly binding: BindingToken;
}
export type CoreRejectReason = SaveRejectionReason | 'outgoing-not-written';
export type CoreResult<T> = { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: CoreRejectReason; readonly error?: unknown };
export interface CloseSavePlan {
  readonly token: CloseToken;
  readonly owner: OwnerToken;
  readonly acceptedAtSeal: readonly SaveTicket[];
  readonly pendingAtSeal: readonly SaveAdmissionPending[];
  readonly finalAdmissions: readonly RegisteredSaveRequest[];
  readonly completion: Promise<readonly CloseSaveOutcome[]>;
}
export type CloseSaveOutcome =
  | { readonly status: 'not-admitted'; readonly token: SaveToken; readonly rejection: Extract<SaveAdmission, { status: 'rejected' }> }
  | { readonly status: 'settled'; readonly receipt: SaveReceipt; readonly captureAcknowledgement: CaptureAcknowledgement };
export type SaveReceiptState = { readonly status: 'pending' } | { readonly status: 'settled'; readonly receipt: SaveReceipt };
export interface BindingPersistenceStatus {
  readonly dirtyRevision: number;
  readonly confirmedDirtyRevision: number;
  readonly dirty: boolean;
}

// Re-export types that are used across the chat feature
export type {
  ChatMessage,
  EditorSelectionContext,
  ImageAttachment,
  SubagentInfo,
  ThinkingBlockState,
  TodoItem,
  ToolCallInfo,
  UsageInfo,
  WriteEditState,
};
