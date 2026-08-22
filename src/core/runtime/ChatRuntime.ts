import type { ProviderCapabilities, ProviderId } from '../providers/types';
import type { ChatMessage, Conversation, SlashCommand, StreamChunk, ToolCallInfo } from '../types';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  AutoTurnCancelledEvent,
  AutoTurnResult,
  AutoTurnStartedEvent,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
  SubagentTaskNotificationHandler,
} from './types';

export interface ChatRuntime {
  readonly providerId: ProviderId;

  getCapabilities(): Readonly<ProviderCapabilities>;
  prepareTurn(request: ChatTurnRequest): PreparedChatTurn;
  onReadyStateChange(listener: (ready: boolean) => void): () => void;
  setResumeCheckpoint(checkpointId: string | undefined): void;
  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    externalContextPaths?: string[],
  ): void;
  reloadMcpServers(): Promise<void>;
  ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean>;
  query(
    turn: PreparedChatTurn,
    conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk>;
  steer?(turn: PreparedChatTurn): Promise<boolean>;
  cancel(): void;
  resetSession(): void;
  getSessionId(): string | null;
  consumeSessionInvalidation(): boolean;
  isReady(): boolean;
  getSupportedCommands(): Promise<SlashCommand[]>;
  getAuxiliaryModel?(): string | null;
  cleanup(): void;
  rewind(userMessageId: string, assistantMessageId: string): Promise<ChatRewindResult>;
  setApprovalCallback(callback: ApprovalCallback | null): void;
  setApprovalDismisser(dismisser: (() => void) | null): void;
  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void;
  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void;
  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void;
  setSubagentHookProvider(getState: () => SubagentRuntimeState): void;
  /** Fix 2: optional — providers that emit harness task-notifications. */
  setSubagentNotificationHandler?(handler: SubagentTaskNotificationHandler | null): void;
  setAutoTurnCallback(callback: ((result: AutoTurnResult) => void) | null): void;
  /**
   * S2 auto-turn lifecycle (providers with SDK-initiated turns only; others
   * provide no-ops). Fixed completion order (v4 §3.1): started → finished
   * (feature lease cleared) → released (queued UI message may proceed) — with
   * cancelled replacing finished/released on the cancellation path.
   */
  setOnAutoTurnStarted?(callback: ((event: AutoTurnStartedEvent) => void) | null): void;
  setOnAutoTurnFinished?(callback: ((turnId: string) => void) | null): void;
  setOnAutoTurnReleased?(callback: ((turnId: string) => void) | null): void;
  setOnAutoTurnCancelled?(callback: ((event: AutoTurnCancelledEvent) => void) | null): void;
  consumeTurnMetadata(): ChatTurnMetadata;

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult;

  resolveSessionIdForFork(conversation: Conversation | null): string | null;

  loadSubagentToolCalls?(agentId: string): Promise<ToolCallInfo[]>;
  loadSubagentFinalResult?(agentId: string): Promise<string | null>;
}
