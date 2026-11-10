import type ClaudianPlugin from '../../main';
import type { CursorContext } from '../../utils/editor';
import type { SharedAppStorage } from '../bootstrap/storage';
import type { McpServerManager } from '../mcp/McpServerManager';
import type { ChatRuntime } from '../runtime/ChatRuntime';
import type { HomeFileAdapter } from '../storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  AgentDefinition,
  ChatMessage,
  Conversation,
  InstructionRefineResult,
  ManagedMcpServer,
  PluginInfo,
  SessionMetadata,
  SlashCommand,
  SubagentInfo,
  ToolCallInfo,
} from '../types';
import type { ProviderId } from '../types/provider';
import type { ProviderCommandCatalog } from './commands/ProviderCommandCatalog';

export type { ProviderId } from '../types/provider';

declare const persistenceTokenBrand: unique symbol;

export type PersistenceToken<K extends string> = Readonly<{ [persistenceTokenBrand]: K }>;
export type RecordToken = PersistenceToken<'record'>;
export type OwnerToken = PersistenceToken<'owner'>;
export type BindingToken = PersistenceToken<'binding'>;
export type AttemptToken = PersistenceToken<'attempt'>;
export type RuntimeAdoptionToken = PersistenceToken<'runtime-adoption'>;
export type SaveToken = PersistenceToken<'save'>;
export type CloseToken = PersistenceToken<'close'>;

export interface RecordHandle {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly token: RecordToken;
}
export interface RecordVersions {
  readonly binding: number;
  readonly materialization: number;
  readonly turn: number;
}
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type FieldPatch<T> = { readonly op: 'keep' } | { readonly op: 'set'; readonly value: T } | { readonly op: 'delete' };
export type PersistableMetadataKey = 'hasHistory' | 'messageCount' | 'preview' | 'firstUserExcerpt'
  | 'currentNote' | 'externalContextPaths' | 'enabledMcpServers' | 'usage' | 'resumeAtMessageId' | 'lastResponseAt';
export type MetadataPatch = Readonly<Partial<{ [K in PersistableMetadataKey]: FieldPatch<Exclude<SessionMetadata[K], undefined>> }>>;
export interface SessionBindingPatch {
  readonly sessionId: FieldPatch<string | null>;
  readonly providerFields: Readonly<Record<string, FieldPatch<JsonValue>>>;
}
export interface CapturedSessionPersistence {
  readonly protocolVersion: 1;
  readonly providerId: ProviderId;
  readonly facts: JsonObject;
  readonly invalidation: { readonly revision: number; readonly invalidated: boolean };
}
export type SessionSaveInput = { readonly kind: 'none' } | { readonly kind: 'seed'; readonly patch: SessionBindingPatch }
  | { readonly kind: 'runtime'; readonly capture: CapturedSessionPersistence };
export interface SaveIntentBase {
  readonly token: SaveToken;
  readonly record: RecordHandle;
  readonly expectedRecordVersions: RecordVersions;
  readonly owner: OwnerToken;
  readonly metadata: MetadataPatch;
}
export type SaveIntent = SaveIntentBase & (
  | { readonly reason: 'backfill'; readonly binding: null; readonly dirtyRevision: null; readonly session: { readonly kind: 'none' } }
  | { readonly reason: 'normal' | 'outgoing' | 'final'; readonly binding: BindingToken; readonly dirtyRevision: number;
      readonly session: Exclude<SessionSaveInput, { readonly kind: 'none' }> }
);
export interface SaveTicket {
  readonly token: SaveToken;
  readonly record: RecordHandle;
  readonly owner: OwnerToken;
  readonly binding: BindingToken | null;
  readonly dirtyRevision: number | null;
  readonly reason: SaveIntent['reason'];
  readonly sequence: number;
}
export type SaveFailureStage = 'admission' | 'record-validation' | 'reduce' | 'serialize' | 'write' | 'legacy-cleanup' | 'recovery-read' | 'unknown';
export type SaveReceipt = { readonly ticket: SaveTicket } & (
  | { readonly status: 'written'; readonly confirmedRevision: number }
  | { readonly status: 'skipped'; readonly reason: 'missing' | 'deleted' }
  | { readonly status: 'conflict'; readonly reason: 'record-replaced' | 'binding-version' | 'materialization-version' }
  | { readonly status: 'failed'; readonly stage: SaveFailureStage; readonly error: unknown }
);
export type SaveRejectionReason = 'unknown-token' | 'owner-retiring' | 'record-retired' | 'stale-record'
  | 'stale-attempt' | 'stale-binding' | 'binding-sealed' | 'unbound' | 'version-mismatch' | 'reservation-lost'
  | 'provider-mismatch' | 'invalid-snapshot' | 'runtime-capture-failed' | 'storage-rejected' | 'storage-admission-failed';
export type CaptureAcknowledgement = { readonly status: 'not-needed' } | { readonly status: 'acknowledged' }
  | { readonly status: 'failed'; readonly error: unknown };
export type SaveAdmission = { readonly status: 'rejected'; readonly reason: SaveRejectionReason; readonly error?: unknown }
  | { readonly status: 'accepted'; readonly ticket: SaveTicket; readonly durability: Promise<SaveReceipt>;
      readonly captureAcknowledgement: CaptureAcknowledgement };
export interface SaveAdmissionPending {
  readonly status: 'admitting';
  readonly token: SaveToken;
  readonly settlement: Promise<SaveAdmission>;
}
export type SaveRequestResult = SaveAdmission | SaveAdmissionPending;
export type RegisteredSaveRequest = SaveAdmissionPending | Extract<SaveAdmission, { status: 'accepted' }>;
export type MetadataWriteResult = { readonly status: 'written'; readonly confirmedRevision: number }
  | { readonly status: 'skipped'; readonly reason: 'missing' | 'deleted' }
  | { readonly status: 'conflict'; readonly reason: 'record-replaced' | 'binding-version' | 'materialization-version' }
  | { readonly status: 'failed'; readonly stage: SaveFailureStage; readonly error: unknown };
export type MetadataAdmission = { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'accepted'; readonly sequence: number; readonly completion: Promise<MetadataWriteResult> };
export interface MetadataSavePort { admit(intent: SaveIntent): MetadataAdmission }


export interface ProviderCapabilities {
  providerId: ProviderId;
  supportsPersistentRuntime: boolean;
  supportsNativeHistory: boolean;
  supportsPlanMode: boolean;
  supportsRewind: boolean;
  supportsFork: boolean;
  supportsProviderCommands: boolean;
  supportsImageAttachments: boolean;
  supportsInstructionMode: boolean;
  supportsMcpTools: boolean;
  supportsTurnSteer?: boolean;
  reasoningControl: 'effort' | 'token-budget' | 'none';
  planPathPrefix?: string;
}

export const DEFAULT_CHAT_PROVIDER_ID = 'claude' as const satisfies ProviderId;

export interface CreateChatRuntimeOptions {
  plugin: ClaudianPlugin;
  providerId?: ProviderId;
}

/**
 * Chat-facing provider registration.
 *
 * This is intentionally limited to chat-facing services.
 * Shared bootstrap (defaults, storage) is in `src/core/bootstrap/`.
 * Provider-owned workspace services (CLI resolution, commands, agents,
 * MCP, settings tabs) live behind `src/providers/<id>/app/`.
 */
export interface ProviderRegistration {
  displayName: string;
  blankTabOrder: number;
  isEnabled: (settings: Record<string, unknown>) => boolean;
  capabilities: ProviderCapabilities;
  environmentKeyPatterns?: RegExp[];
  chatUIConfig: ProviderChatUIConfig;
  settingsReconciler: ProviderSettingsReconciler;
  createRuntime: (options: Omit<CreateChatRuntimeOptions, 'providerId'>) => ChatRuntime;
  createTitleGenerationService: (plugin: ClaudianPlugin) => TitleGenerationService;
  createInstructionRefineService: (plugin: ClaudianPlugin) => InstructionRefineService;
  createInlineEditService: (plugin: ClaudianPlugin) => InlineEditService;
  historyService: ProviderConversationHistoryService;
  taskResultInterpreter: ProviderTaskResultInterpreter;
  subagentLifecycleAdapter?: ProviderSubagentLifecycleAdapter;
}

export interface ProviderSettingsReconciler {
  handleEnvironmentChange?(settings: Record<string, unknown>): boolean;

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] };

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean;
}

// ---------------------------------------------------------------------------
// App-level service interfaces
// ---------------------------------------------------------------------------

/** Tab manager state persisted across restarts. */
export interface AppTabManagerState {
  openTabs: Array<{
    tabId: string;
    conversationId: string | null;
    draftModel?: string | null;
    draftProviderId?: ProviderId | null;
  }>;
  activeTabId: string | null;
}

/** Provider-neutral session metadata storage. */
export interface AppSessionStorage {
  listMetadata(): Promise<SessionMetadata[]>;
  saveMetadata(meta: SessionMetadata): Promise<void>;
  deleteMetadata(id: string): Promise<void>;
  toSessionMetadata(conv: Conversation): SessionMetadata;
}

// ---------------------------------------------------------------------------
// Provider-owned workspace sub-interfaces
//
// These remain here as standalone types so app-level settings/chat code can
// depend on stable provider workspace contracts without importing concrete
// provider implementations. They are NOT part of the shared bootstrap storage
// contract (`SharedAppStorage`).
// ---------------------------------------------------------------------------

export interface AppMcpStorage {
  load(): Promise<ManagedMcpServer[]>;
  save(servers: ManagedMcpServer[]): Promise<void>;
  tryParseClipboardConfig?(text: string): unknown | null;
}

export interface AppCommandStorage {
  save(command: SlashCommand): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface AppSkillStorage {
  save(skill: SlashCommand): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface AppAgentStorage {
  load(agent: AgentDefinition): Promise<AgentDefinition | null>;
  save(agent: AgentDefinition): Promise<void>;
  delete(agent: AgentDefinition): Promise<void>;
}

export type AgentMentionSource = AgentDefinition['source'];

export interface AgentMentionProvider {
  searchAgents(query: string): Array<{
    id: string;
    name: string;
    description?: string;
    source: AgentMentionSource;
  }>;
}

/** Provider plugin manager interface consumed by the app layer. */
export interface AppPluginManager {
  loadPlugins(): Promise<void>;
  getPlugins(): PluginInfo[];
  hasPlugins(): boolean;
  hasEnabledPlugins(): boolean;
  getEnabledCount(): number;
  getPluginsKey(): string;
  togglePlugin(pluginId: string): Promise<void>;
  enablePlugin(pluginId: string): Promise<void>;
  disablePlugin(pluginId: string): Promise<void>;
}

/** Provider agent manager interface consumed by the app layer. */
export interface AppAgentManager extends AgentMentionProvider {
  loadAgents(): Promise<void>;
  getAvailableAgents(): AgentDefinition[];
  getAgentById(id: string): AgentDefinition | undefined;
  searchAgents(query: string): AgentDefinition[];
  setBuiltinAgentNames(names: string[]): void;
}

// ---------------------------------------------------------------------------
// Provider-owned chat UI configuration
// ---------------------------------------------------------------------------

/** Option for model, reasoning, or other UI selectors. */
export interface ProviderUIOption {
  value: string;
  label: string;
  description?: string;
  /** Optional group label for visual separators in dropdowns. */
  group?: string;
  /** Per-option icon override (e.g. when mixing providers in a single dropdown). */
  providerIcon?: ProviderIconSvg;
}

export interface ProviderModelSelection {
  providerId: ProviderId;
  modelId: string;
}

export interface ProviderModelOption extends ProviderUIOption {
  providerId: ProviderId;
}

export interface ProviderPathIconSvg {
  kind?: 'path';
  viewBox: string;
  path: string;
}

export interface ProviderMarkupIconSvg {
  kind: 'markup';
  viewBox: string;
  markup: string;
}

/** SVG icon descriptor for provider branding in selectors and headers. */
export type ProviderIconSvg = ProviderPathIconSvg | ProviderMarkupIconSvg;

/** Extended option with token count for budget-based reasoning controls. */
export interface ProviderReasoningOption extends ProviderUIOption {
  tokens?: number;
}

/**
 * Permission-mode values a provider accepts in the shared `permissionMode`
 * setting. The policy owns validity, migration, and fail-closed behavior;
 * the UI options own only presentation.
 */
export interface ProviderPermissionModePolicy {
  readonly values: readonly string[];
  /** Fail-closed value for unknown stored values. */
  readonly fallbackValue: string;
  /** Value used when the provider has no stored choice (e.g. fresh install). */
  readonly defaultValue?: string;
  /** Maps a retired stored value to a current one; unmapped values fail closed. */
  migrateValue?(value: string, settings: Record<string, unknown>): string | undefined;
  /**
   * Runtime-only values (fork plan mode) accepted by in-memory projection but
   * never persisted by storage serialization.
   */
  readonly transientValues?: readonly string[];
}

/** One toolbar permission-mode choice, in menu order. */
export interface ProviderPermissionModeOption extends ProviderUIOption {
  /** Skips approval prompts; the toolbar marks the selection as a warning. */
  bypassesApprovals?: boolean;
}

/** Compact service-tier toggle descriptor for providers that expose a fast/standard toolbar control. */
export interface ProviderServiceTierToggleConfig {
  inactiveValue: string;
  inactiveLabel: string;
  activeValue: string;
  activeLabel: string;
  description?: string;
}

export interface ProviderModeSelectorConfig {
  activeValue?: string;
  label: string;
  options: ProviderUIOption[];
  value: string;
}

/** Static UI configuration owned by the provider (model list, reasoning, context window). */
export interface ProviderChatUIConfig {
  /** Model options for the selector dropdown. Provider extracts what it needs from the settings bag. */
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[];

  /** Whether this provider owns the given model id. */
  ownsModel(model: string, settings: Record<string, unknown>): boolean;

  /** Whether the model uses adaptive reasoning (effort levels vs token budgets). */
  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean;

  /** Reasoning options for the current model (effort levels if adaptive, budgets otherwise). */
  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[];

  /** Default reasoning value for the model. */
  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string;

  /** Context window size in tokens. */
  getContextWindowSize(model: string, customLimits?: Record<string, number>): number;

  /** Whether this is a built-in (default) model vs custom/env model. */
  isDefaultModel(model: string): boolean;

  /** Apply model change side effects to settings (defaults, tracking). */
  applyModelDefaults(model: string, settings: unknown): void;

  /** Optional hook when the toolbar changes a reasoning selection. */
  applyReasoningSelection?(model: string, value: string, settings: unknown): void;

  /** Normalize model variant based on visibility flags. Provider extracts what it needs from the settings bag. */
  normalizeModelVariant(model: string, settings: Record<string, unknown>): string;

  /** Extract custom model IDs from parsed environment variables. Used for per-model context limit UI. */
  getCustomModelIds(envVars: Record<string, string>): Set<string>;

  /** Permission-mode values this provider accepts, with migration and fail-closed rules. */
  readonly permissionModes?: ProviderPermissionModePolicy;

  /** Permission-mode menu choices in menu order. Null when the provider exposes no permission UI. */
  getPermissionModeOptions?(
    settings: Record<string, unknown>,
  ): readonly ProviderPermissionModeOption[] | null;

  /** Display label for a runtime-only transient state (e.g. plan); null when unknown. */
  getPermissionTransientModeLabel?(value: string): string | null;

  /** Optional provider-owned mapping back into the shared permission-mode contract. */
  resolvePermissionMode?(settings: Record<string, unknown>): string | null;

  /** Optional hook when the toolbar changes permission mode. */
  applyPermissionMode?(value: string, settings: unknown): void;

  /** Optional service-tier toggle descriptor. Return null when the provider exposes no fast/standard UI. */
  getServiceTierToggle?(settings: Record<string, unknown>): ProviderServiceTierToggleConfig | null;

  /** Optional provider-owned mode selector descriptor. */
  getModeSelector?(settings: Record<string, unknown>): ProviderModeSelectorConfig | null;

  /** Optional hook when the toolbar changes a provider-owned mode selection. */
  applyModeSelection?(value: string, settings: unknown): void;

  /** Whether the provider enables the shared bang-bash input mode. */
  isBangBashEnabled?(settings: Record<string, unknown>): boolean;

  /** SVG icon for the provider (shown next to model names in selectors). */
  getProviderIcon?(): ProviderIconSvg | null;
}

// ---------------------------------------------------------------------------
// Provider-owned boundary services
// ---------------------------------------------------------------------------

export interface ProviderCliResolver {
  resolveFromSettings(settings: Record<string, unknown>): string | null;
  reset(): void;
}

export interface ProviderRuntimeCommandLoaderContext {
  // Shared command discovery may need a short-lived provider session; the tab
  // manager decides when that is allowed for the active tab.
  allowSessionCreation?: boolean;
  conversation: Conversation | null;
  externalContextPaths: string[];
  plugin: ClaudianPlugin;
  runtime: ChatRuntime | null;
}

export interface ProviderRuntimeCommandLoader {
  isAvailable(settings: Record<string, unknown>): boolean;
  loadCommands(context: ProviderRuntimeCommandLoaderContext): Promise<SlashCommand[]>;
}

// `commands` warms provider-owned command discovery without fully priming the
// bound tab runtime. `runtime` primes the real tab runtime itself.
export type ProviderTabWarmupMode = 'none' | 'commands' | 'runtime';

export type ProviderTabWarmupLifecycleState = 'blank' | 'bound_cold' | 'bound_active' | 'closing';

export interface ProviderTabWarmupContext {
  conversation: Conversation | null;
  externalContextPaths: string[];
  plugin: ClaudianPlugin;
  runtime: ChatRuntime | null;
  tab: {
    conversationId: string | null;
    draftModel: string | null;
    lifecycleState: ProviderTabWarmupLifecycleState;
    providerId: ProviderId;
  };
}

export interface ProviderTabWarmupPolicy {
  resolveMode(context: ProviderTabWarmupContext): ProviderTabWarmupMode;
}

export interface ProviderWorkspaceServices {
  commandCatalog?: ProviderCommandCatalog | null;
  agentMentionProvider?: AgentMentionProvider | null;
  cliResolver?: ProviderCliResolver | null;
  runtimeCommandLoader?: ProviderRuntimeCommandLoader | null;
  tabWarmupPolicy?: ProviderTabWarmupPolicy | null;
  mcpServerManager?: McpServerManager | null;
  settingsTabRenderer?: ProviderSettingsTabRenderer | null;
  refreshAgentMentions?(): Promise<void>;
}

export interface ProviderSettingsTabRendererContext {
  plugin: ClaudianPlugin;
  renderHiddenProviderCommandSetting(
    container: HTMLElement,
    providerId: ProviderId,
    copy: { name: string; desc: string; placeholder: string },
  ): void;
  refreshModelSelectors(): void;
  renderCustomContextLimits(container: HTMLElement, providerId?: ProviderId): void;
}

export interface ProviderSettingsTabRenderer {
  render(container: HTMLElement, context: ProviderSettingsTabRendererContext): void;
}

export interface ProviderWorkspaceInitContext {
  plugin: ClaudianPlugin;
  storage: SharedAppStorage;
  vaultAdapter: VaultFileAdapter;
  homeAdapter: HomeFileAdapter;
}

export interface ProviderWorkspaceRegistration<
  TServices extends ProviderWorkspaceServices = ProviderWorkspaceServices,
> {
  initialize(context: ProviderWorkspaceInitContext): Promise<TServices>;
}

export type ConversationHistoryHydrationResult =
  | { status: 'ready' }
  | { status: 'error'; errors: Array<{ sessionId: string; message: string }> };

export class ConversationHistoryHydrationError extends Error {
  constructor(readonly result: Exclude<ConversationHistoryHydrationResult, { status: 'ready' }>) {
    super('Conversation history failed to load');
    this.name = 'ConversationHistoryHydrationError';
  }
}

export interface LoadedTurnRange {
  /** Inclusive global turn index. */
  start: number;
  /** Exclusive global turn index. */
  end: number;
}

export type HistoryLoadProgress =
  | { phase: 'queued' }
  | { phase: 'indexing'; percent: number }
  | { phase: 'finalizing' }
  | { phase: 'loading'; turnCount: number };

export interface HistorySearchResult {
  /** Stable DOM identity produced by the shared transcript projection rules. */
  projectionKey: string;
  /** Global turn containing this match. */
  turnIndex: number;
  /** Zero-based occurrence within all corpus items sharing projectionKey. */
  matchOrdinal: number;
  matchedText: string;
  status?: 'projection_mismatch';
}

export interface FullHistoryIterationOptions {
  maxTurnsPerChunk: number;
  maxSourceBytesPerChunk: number;
  maxProjectedCharsPerChunk: number;
  projectionLevel: 'detail';
  signal?: AbortSignal;
}

export interface FullHistoryChunk {
  messages: ChatMessage[];
  range: LoadedTurnRange;
  sourceBytes: number;
  done: boolean;
}

export type FullHistoryIterable = AsyncIterable<FullHistoryChunk>;

export interface WritableLike {
  write(text: string): Promise<void>;
  close?(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export class HistoryEntryTooLargeError extends Error {
  constructor(
    readonly turnIndex: number,
    readonly sourceBytes: number,
    readonly projectedChars: number | null,
  ) {
    super(`History turn ${turnIndex} exceeds the full-history iteration budget`);
    this.name = 'HistoryEntryTooLargeError';
  }
}

export type HistorySourceUnavailableReason =
  | 'vault_unavailable'
  | 'session_unavailable'
  | 'transcript_unavailable';

export class HistorySourceUnavailableError extends Error {
  constructor(readonly reason: HistorySourceUnavailableReason) {
    super(`Conversation history source is unavailable: ${reason}`);
    this.name = 'HistorySourceUnavailableError';
  }
}

export type HistoryMessageDetailResult =
  | { status: 'exact'; message: ChatMessage }
  | { status: 'not_found' }
  | { status: 'too_large' };

export interface HistoryIndexLease {
  conversationId: string;
  /** Fixed total from the index snapshot acquired for this lease. */
  totalTurns: number;
  /**
   * Provenance of the acquired snapshot — 'rebuilt' (at least one segment
   * rescanned) or 'cache_hit' (identical snapshot already indexed). Undefined
   * until `ready` settles, and only set by services that can report it.
   */
  acquireOutcome?: 'rebuilt' | 'cache_hit';
  ready: Promise<void>;
  search(query: string): Promise<HistorySearchResult[]>;
  loadMessageDetail(
    projectionKey: string,
    options: { maxSourceBytes: number; signal?: AbortSignal },
  ): Promise<HistoryMessageDetailResult>;
  /** Budget-bounded window materialization for interactive UI. */
  loadWindow(request: HistoryWindowRequest): Promise<HistoryWindowPage>;
  /** Metadata-only window plan (no reads); used for progress reporting. */
  planWindow(request: HistoryWindowRequest): { start: number; end: number };
  release(): void;
}

/** Hard resource bounds shared by every history entry point. */
export interface HistoryLoadBudget {
  maxTurns: number;
  maxSourceBytes: number;
  maxProjectedChars: number;
  /** Cooperative main-thread slice; lowers long tasks, never replaces the byte/char caps. */
  timeSliceMs: number;
}

export type HistoryWindowDirection = 'older' | 'newer' | 'around';

export type HistoryProjectionLevel = 'summary' | 'detail';

export interface HistoryWindowRequest {
  /** Global turn index the window grows from (exclusive end for 'older', start for 'newer', center for 'around'). */
  anchorTurn: number;
  direction: HistoryWindowDirection;
  budget: HistoryLoadBudget;
  projectionLevel: HistoryProjectionLevel;
  /** Inclusive floor for 'older' planning: turns below are already loaded. */
  minTurn?: number;
  /** Exclusive ceiling for 'newer' planning. */
  maxTurn?: number;
}

/**
 * Neutral tail-start handoff shell (H/P8): the provider that produced a
 * windowed page certifies the transcript source its committed boundary was
 * observed on. The payload stays provider-owned and opaque — feature code
 * stores and forwards it, never parses it. A consumer priming at the
 * committed boundary must reject a source whose identity does not match
 * these credentials instead of reading a replacement at the stale offset.
 */
export interface HistoryTailStart {
  provider: ProviderId;
  protocol: 1;
  payload: unknown;
}

export interface HistoryWindowPage {
  messages: ChatMessage[];
  /** Estimated retained/render cost used by the page-data weighted LRU. */
  projectedWeight?: number;
  /** Actual half-open turn range that satisfied the budgets. */
  range: LoadedTurnRange;
  snapshotOffset?: number;
  /** Identity credentials for the source snapshotOffset was observed on. */
  tailStart?: HistoryTailStart;
  sourceBytes: number;
  projectedChars: number;
  /** Turns materialized through the oversized summary projection. */
  oversizedTurnCount: number;
  /** Stable per-range key for page-level caching. */
  pageKey: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface ConversationSizeSnapshot {
  conversationId: string;
  revision: number;
  files:
    | { status: 'known'; bytes: number }
    | { status: 'unknown'; reason: 'unsupported' | 'unavailable' };
}

export interface ConversationSizeSource {
  readonly sessionId?: string | null;
  readonly filePath?: string | null;
}

/** Only the current native file identity; never transcript content or persisted readings. */
export interface ConversationSizeReadInput {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly source: ConversationSizeSource;
}

export interface ConversationSizeReadResult {
  readonly snapshot: ConversationSizeSnapshot;
}

export interface ProviderConversationHistoryService {
  /** Capture only the provider-owned size source, not transcript content. */
  captureConversationSizeSource?(conversation: Conversation): ConversationSizeSource;
  readConversationSize?(
    input: ConversationSizeReadInput,
    vaultPath: string | null,
    options: { revision: number; signal?: AbortSignal },
  ): Promise<ConversationSizeReadResult>;
  hydrateConversationHistory?(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void | ConversationHistoryHydrationResult>;
  acquireHistoryIndex?(
    conversation: Conversation,
    vaultPath: string | null,
    onProgress?: (progress: HistoryLoadProgress) => void,
    forceNewSnapshot?: boolean,
  ): HistoryIndexLease;
  iterateFullHistory?(
    conversation: Conversation,
    vaultPath: string | null,
    options: FullHistoryIterationOptions,
  ): FullHistoryIterable;
  /** @deprecated Use iterateFullHistory with a bounded consumer. */
  exportFullHistory?(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<ChatMessage[]>;
  deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void>;
  resolveSessionIdForConversation(conversation: Conversation | null): string | null;
  isPendingForkConversation(conversation: Conversation): boolean;
  /** Builds opaque provider state for a forked conversation. */
  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown>;
  /** Adds provider-owned persisted metadata to Conversation.providerState before session save. */
  buildPersistedProviderState?(conversation: Conversation): Record<string, unknown> | undefined;
  mergePersistedSubagentState?(
    providerState: Record<string, unknown> | undefined,
    subagent: SubagentInfo,
  ): Record<string, unknown>;
  loadTitleMaterial?(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<{ firstUserExcerpt: string; recentUserExcerpts: string[] } | null>;
}

export type ProviderTaskTerminalStatus = Extract<ToolCallInfo['status'], 'completed' | 'error'>;

export interface ProviderTaskResultInterpreter {
  hasAsyncLaunchMarker(toolUseResult: unknown): boolean;
  extractAgentId(toolUseResult: unknown): string | null;
  extractStructuredResult(toolUseResult: unknown): string | null;
  resolveTerminalStatus(
    toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus;
  extractTagValue(payload: string, tagName: string): string | null;
}

export interface ProviderSubagentLaunchResult {
  agentId?: string;
  nickname?: string;
}

export interface ProviderSubagentWaitStatus {
  completed?: string;
  error?: string;
  failed?: string;
}

export interface ProviderSubagentWaitResult {
  statuses: Record<string, ProviderSubagentWaitStatus>;
  timedOut: boolean;
}

export interface ProviderSubagentLifecycleAdapter {
  isHiddenTool(name: string): boolean;
  isSpawnTool(name: string): boolean;
  isWaitTool(name: string): boolean;
  isCloseTool(name: string): boolean;
  resolveSpawnToolIds(
    waitToolCall: ToolCallInfo,
    agentIdToSpawnId: ReadonlyMap<string, string>,
  ): string[];
  buildSubagentInfo(
    spawnToolCall: ToolCallInfo,
    siblingToolCalls?: ToolCallInfo[],
  ): SubagentInfo;
  extractSpawnResult(raw: string | undefined): ProviderSubagentLaunchResult;
  extractWaitResult(raw: string | undefined): ProviderSubagentWaitResult;
}

// ---------------------------------------------------------------------------
// Auxiliary service contracts
// ---------------------------------------------------------------------------

// -- Title generation --

export type TitleGenerationResult =
  | { success: true; title: string }
  | { success: false; error: string };

export type TitleGenerationCallback = (
  conversationId: string,
  result: TitleGenerationResult
) => Promise<void>;

export interface TitleGenerationService {
  generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void>;
  cancel(): void;
}

// -- Instruction refinement --

export type RefineProgressCallback = (update: InstructionRefineResult) => void;

export interface InstructionRefineService {
  setModelOverride?(model?: string): void;
  resetConversation(): void;
  refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult>;
  continueConversation(
    message: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult>;
  cancel(): void;
}

// -- Inline edit --

export type InlineEditMode = 'selection' | 'cursor';

export interface InlineEditSelectionRequest {
  mode: 'selection';
  instruction: string;
  notePath: string;
  selectedText: string;
  startLine?: number;
  lineCount?: number;
  contextFiles?: string[];
}

export interface InlineEditCursorRequest {
  mode: 'cursor';
  instruction: string;
  notePath: string;
  cursorContext: CursorContext;
  contextFiles?: string[];
}

export type InlineEditRequest = InlineEditSelectionRequest | InlineEditCursorRequest;

export interface InlineEditResult {
  success: boolean;
  editedText?: string;
  insertedText?: string;
  clarification?: string;
  error?: string;
}

export interface InlineEditService {
  setModelOverride?(model?: string): void;
  resetConversation(): void;
  editText(request: InlineEditRequest): Promise<InlineEditResult>;
  continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult>;
  cancel(): void;
}
