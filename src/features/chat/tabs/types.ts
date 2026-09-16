import type { Component, WorkspaceLeaf } from 'obsidian';

import type { HistoryLoadProgress, InstructionRefineService, ProviderId, TitleGenerationService } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import type { AutoTurnProjectionController } from '../controllers/AutoTurnProjectionController';
import type { BrowserSelectionController } from '../controllers/BrowserSelectionController';
import type { CanvasSelectionController } from '../controllers/CanvasSelectionController';
import type { ConversationController } from '../controllers/ConversationController';
import type { HistorySearchController } from '../controllers/HistorySearchController';
import type { InputController } from '../controllers/InputController';
import type { NavigationController } from '../controllers/NavigationController';
import type { SelectionController } from '../controllers/SelectionController';
import type { StreamController } from '../controllers/StreamController';
import type { TurnCoordinator } from '../controllers/TurnCoordinator';
import type { MessageRenderer } from '../rendering/MessageRenderer';
import type { ProjectionWriteCoordinator } from '../rendering/ProjectionWriteCoordinator';
import type { SubagentManager } from '../services/SubagentManager';
import type { ChatState } from '../state/ChatState';
import type { BangBashModeManager } from '../ui/BangBashModeManager';
import type { FileContextManager } from '../ui/FileContext';
import type { ImageContextManager } from '../ui/ImageContext';
import type {
  ContextUsageMeter,
  ExternalContextSelector,
  McpServerSelector,
  ModelSelector,
  ModeSelector,
  PermissionToggle,
  ServiceTierToggle,
  ThinkingBudgetSelector,
} from '../ui/InputToolbar';
import type { InstructionModeManager } from '../ui/InstructionModeManager';
import type { NavigationSidebar } from '../ui/NavigationSidebar';
import type { StatusPanel } from '../ui/StatusPanel';

/**
 * Default number of tabs allowed.
 *
 * Set to 3 to balance usability with resource usage:
 * - Each tab has its own chat runtime and persistent query
 * - More tabs = more memory and potential SDK processes
 * - 3 tabs allows multi-tasking without excessive overhead
 */
export const DEFAULT_MAX_TABS = 3;

/**
 * Minimum number of tabs allowed (settings floor).
 */
export const MIN_TABS = 3;

/**
 * Maximum number of tabs allowed (settings ceiling).
 * Users can configure up to this many tabs via settings.
 */
export const MAX_TABS = 10;

/**
 * Minimum max-height for textarea in pixels.
 * Used by autoResizeTextarea to ensure minimum usable space.
 */
export const TEXTAREA_MIN_MAX_HEIGHT = 150;

/**
 * Percentage of view height for max textarea height.
 * Textarea can grow up to this portion of the view.
 */
export const TEXTAREA_MAX_HEIGHT_PERCENT = 0.55;

/**
 * Minimal interface for the ClaudianView methods used by TabManager and Tab.
 * Extends Component for Obsidian integration (event handling, cleanup).
 * Avoids circular dependency by not importing ClaudianView directly.
 */
export interface TabManagerViewHost extends Component {
  /** Reference to the workspace leaf for revealing the view. */
  leaf: WorkspaceLeaf;

  /** Gets the tab manager instance (used for cross-view coordination). */
  getTabManager(): TabManagerInterface | null;
}

/**
 * Minimal interface for TabManager methods used by external code.
 * Used to break circular dependencies.
 */
export interface TabManagerInterface {
  /** Switches to a specific tab. */
  switchToTab(tabId: TabId): Promise<void>;

  /** Gets all tabs. */
  getAllTabs(): TabData[];
}

/** Tab identifier type. */
export type TabId = string;

/**
 * Provider-neutral successful turn completion. Emitted only after the
 * provider stream exhausted naturally AND the final visible projection
 * landed; cancels, failures, lease losses and invalidations never emit.
 * Notification policy must read this instead of UI busy state.
 */
export type CompletedTurnEvent = {
  turnId: string;
  kind: 'user' | 'auto';
  outcome: 'completed';
};

export type TabHydrationState =
  | 'SHELL'
  | 'SCHEDULED'
  | 'LOADING'
  | 'READY'
  | 'OVERSIZE_BLOCKED'
  | 'ERROR';

export interface TabHydrationDiagnostic {
  segments?: Array<{ sessionId: string; sizeBytes: number }>;
  message?: string;
}

/**
 * Tab-level hydration hooks injected into the per-tab ConversationController.
 * Keeps the controller free of TabData references while letting the M1 shell
 * state machine own every hydration transition.
 */
export interface TabHydrationHooks {
  /** Route a hydration-blocked active open onto the shell state machine. */
  switchToHydrationShell: (conversationId: string) => void;
  /** Report a direct (non-shell) load/switch completion (reset to READY). */
  markHydrationReady: () => void;
  /** Whether the tab has fully hydrated (READY) and may persist session state. */
  isHydrationReady: () => boolean;
}

/** Generates a unique tab ID. */
export function generateTabId(): TabId {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Controllers managed per-tab.
 * Each tab has its own set of controllers for independent operation.
 */
export interface TabControllers {
  autoTurnProjectionController: AutoTurnProjectionController | null;
  selectionController: SelectionController | null;
  browserSelectionController: BrowserSelectionController | null;
  canvasSelectionController: CanvasSelectionController | null;
  conversationController: ConversationController | null;
  historySearchController: HistorySearchController | null;
  streamController: StreamController | null;
  inputController: InputController | null;
  navigationController: NavigationController | null;
  /** Feature-layer turn lease (S2): user sends and auto turns arbitrate here. */
  turnCoordinator: TurnCoordinator | null;
  /**
   * Per-tab projection write lease (coord protocol): stored history
   * transactions and live streaming turns arbitrate messagesEl writes here.
   * Disposed on tab close to settle queued waiters.
   */
  projectionWriteCoordinator: ProjectionWriteCoordinator | null;
}

/**
 * Services managed per-tab.
 */
export interface TabServices {
  subagentManager: SubagentManager;
  instructionRefineService: InstructionRefineService | null;
  titleGenerationService: TitleGenerationService | null;
}

/**
 * UI components managed per-tab.
 */
export interface TabUIComponents {
  fileContextManager: FileContextManager | null;
  imageContextManager: ImageContextManager | null;
  modelSelector: ModelSelector | null;
  modeSelector: ModeSelector | null;
  thinkingBudgetSelector: ThinkingBudgetSelector | null;
  externalContextSelector: ExternalContextSelector | null;
  mcpServerSelector: McpServerSelector | null;
  permissionToggle: PermissionToggle | null;
  serviceTierToggle: ServiceTierToggle | null;
  slashCommandDropdown: SlashCommandDropdown | null;
  instructionModeManager: InstructionModeManager | null;
  bangBashModeManager: BangBashModeManager | null;
  contextUsageMeter: ContextUsageMeter | null;
  statusPanel: StatusPanel | null;
  navigationSidebar: NavigationSidebar | null;
}

/**
 * DOM elements managed per-tab.
 */
export interface TabDOMElements {
  contentEl: HTMLElement;
  messagesEl: HTMLElement;
  welcomeEl: HTMLElement | null;

  /** Container for status panel (fixed between messages and input). */
  statusPanelContainerEl: HTMLElement;

  inputContainerEl: HTMLElement;
  queueIndicatorEl: HTMLElement;
  inputWrapper: HTMLElement;
  inputEl: HTMLTextAreaElement;

  /** Nav row for tab badges and header icons (above input wrapper). */
  navRowEl: HTMLElement;

  /** Context row for file chips and selection indicator (inside input wrapper). */
  contextRowEl: HTMLElement;

  selectionIndicatorEl: HTMLElement | null;
  browserIndicatorEl: HTMLElement | null;
  canvasIndicatorEl: HTMLElement | null;

  /** Cleanup functions for event listeners (prevents memory leaks). */
  eventCleanups: Array<() => void>;
}

/**
 * Tab lifecycle states:
 * - `blank`: No conversation binding, no runtime. Draft model selection only.
 * - `bound_cold`: Bound to a conversation, but runtime not started yet.
 * - `bound_active`: Bound to a conversation with a running runtime.
 * - `closing`: Tab is being torn down.
 */
export type TabLifecycleState = 'blank' | 'bound_cold' | 'bound_active' | 'closing';

/**
 * Represents a single tab in the multi-tab system.
 * Each tab is an independent chat session with its own runtime instance.
 */
export interface TabData {
  /** Unique tab identifier. */
  id: TabId;

  /** Explicit lifecycle state. */
  lifecycleState: TabLifecycleState;

  /**
   * Draft model selected in a blank tab (before first send).
   * Used to derive provider on first send. Null after binding.
   */
  draftModel: string | null;

  /** Active provider for this tab's current conversation/runtime. */
  providerId: ProviderId;

  /** Conversation ID bound to this tab (null for new/empty tabs). */
  conversationId: string | null;

  /** UI-only history hydration lifecycle for restored/bound tabs. */
  hydrationState: TabHydrationState;
  hydrationGeneration: number;
  hydrationDiagnostic: TabHydrationDiagnostic | null;
  historyLoadProgress: HistoryLoadProgress | null;

  /** Per-tab chat runtime instance for independent streaming. */
  service: ChatRuntime | null;

  /** Whether the service has been initialized (lazy start). */
  serviceInitialized: boolean;

  /** Per-tab chat state. */
  state: ChatState;

  /** Per-tab controllers. */
  controllers: TabControllers;

  /** Per-tab services. */
  services: TabServices;

  /** Per-tab UI components. */
  ui: TabUIComponents;

  /** Per-tab DOM elements. */
  dom: TabDOMElements;

  /** Per-tab renderer. */
  renderer: MessageRenderer | null;

  /**
   * Last turn id already consumed by the completion-notification policy.
   * Turn ids are monotonic per tab, so a single slot deduplicates replays
   * (observer restarts, repeated finished callbacks) without a Set.
   */
  lastNotifiedCompletedTurnId: string | null;

  /** Successful-turn-completion callback wired into the turn controllers. */
  onTurnCompleted?: (event: CompletedTurnEvent) => void;
}

export type TabProviderContext = Pick<TabData, 'conversationId' | 'service' | 'providerId' | 'lifecycleState' | 'draftModel'>;

/**
 * Persisted tab state for restoration on plugin reload.
 */
export interface PersistedTabState {
  tabId: TabId;
  conversationId: string | null;
  draftModel?: string | null;
}

/**
 * Tab manager state persisted to data.json.
 */
export interface PersistedTabManagerState {
  openTabs: PersistedTabState[];
  activeTabId: TabId | null;
}

/**
 * Callbacks for tab state changes.
 */
export interface TabManagerCallbacks {
  /** Called when a tab is created. */
  onTabCreated?: (tab: TabData) => void;

  /** Called when switching to a different tab. */
  onTabSwitched?: (fromTabId: TabId | null, toTabId: TabId) => void;

  /** Called when a tab is closed. */
  onTabClosed?: (tabId: TabId) => void;

  /** Called when tab streaming state changes. */
  onTabStreamingChanged?: (tabId: TabId, isStreaming: boolean) => void;

  /** Called when a background tab's needsReview flips on (completed turn unseen). */
  onTabReviewChanged?: (tabId: TabId, needsReview: boolean) => void;

  /** Called when tab title changes. */
  onTabTitleChanged?: (tabId: TabId, title: string) => void;

  /** Called when tab attention state changes (approval pending, etc.). */
  onTabAttentionChanged?: (tabId: TabId, needsAttention: boolean) => void;

  /** Called when a tab's conversation changes (loaded different conversation in same tab). */
  onTabConversationChanged?: (tabId: TabId, conversationId: string | null) => void;

  /** Called when the active provider changes within a tab (blank tab model selection). */
  onTabProviderChanged?: (tabId: TabId, providerId: ProviderId) => void;

  /**
   * Called after a successful moveTab reorder. Map ordering is behavior data
   * (badge numbering, close fallback, notification index), so listeners must
   * re-derive anything cached from the old order.
   */
  onTabOrderChanged?: () => void;
}

/**
 * Tab bar item representation for rendering.
 */
export interface TabBarItem {
  id: TabId;
  /** 1-based index for display. */
  index: number;
  title: string;
  providerId: ProviderId;
  isActive: boolean;
  isStreaming: boolean;
  needsAttention: boolean;
  /** Background tab finished streaming and awaits user review. */
  needsReview: boolean;
  canClose: boolean;
}
