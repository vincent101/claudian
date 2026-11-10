// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

import './providers';

import type { Editor, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, Notice, Plugin } from 'obsidian';

import { ConversationHistoryCoordinator } from './app/ConversationHistoryCoordinator';
import { ConversationMetadataSavePort } from './app/ConversationMetadataSavePort';
import { ConversationSizeService } from './app/ConversationSizeService';
import { DEFAULT_CLAUDIAN_SETTINGS } from './app/settings/defaultSettings';
import { SharedStorageService } from './app/storage/SharedStorageService';
import type { SharedAppStorage } from './core/bootstrap/storage';
import {
  getEnvironmentVariablesForScope as getScopedEnvironmentVariables,
  getRuntimeEnvironmentText,
  setEnvironmentVariablesForScope,
} from './core/providers/providerEnvironment';
import { ProviderRegistry } from './core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from './core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from './core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from './core/providers/types';
import type { AppTabManagerState } from './core/providers/types';
import {
  ConversationHistoryHydrationError,
  DEFAULT_CHAT_PROVIDER_ID,
} from './core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
} from './core/types';
import {
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import type { ChatViewPlacement, EnvironmentScope } from './core/types/settings';
import { ClaudianView } from './features/chat/ClaudianView';
import { type HistoryDiagnosticEvent, recordHistoryDiagnosticEvent, setHistoryDiagnosticsSink } from './features/chat/history/HistoryDiagnostics';
import { MarkdownRenderDiagnostics } from './features/chat/rendering/MarkdownRenderDiagnostics';
import { cleanupAskRelayFiles } from './features/chat/services/AskRelayService';
import { ConversationOpenRegistry } from './features/chat/tabs/ConversationOpenRegistry';
import { syncRuntimeUnderAdoption } from './features/chat/tabs/runtimeAdoptionSync';
import type { MarkdownRenderDiagnosticBinding } from './features/chat/tabs/types';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale } from './i18n/i18n';
import type { Locale } from './i18n/types';
import { ClaudeTranscriptDiagnosticLog,type TranscriptDiagnosticEvent } from './providers/claude/transcript/ClaudeTranscriptDiagnosticLog';
import { OPENCODE_PLAN_MODE_ID, OPENCODE_SAFE_MODE_ID } from './providers/opencode/modes';
import { buildCursorContext } from './utils/editor';
import { getVaultPath } from './utils/path';

function isClaudianView(value: unknown): value is ClaudianView {
  return !!value
    && typeof value === 'object'
    && typeof (value as { getTabManager?: unknown }).getTabManager === 'function';
}

function diagnosticInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function diagnosticDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function diagnosticHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{12}$/.test(value) ? value : undefined;
}

function diagnosticHistogram(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  const counts: number[] = [];
  for (let index = 0; index < length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined;
    const count = diagnosticInteger(value[index]);
    if (count === undefined) return undefined;
    counts.push(count);
  }
  return counts;
}

function diagnosticVisibility(value: unknown): 'yes' | 'no' | 'unknown' | undefined {
  return value === 'yes' || value === 'no' || value === 'unknown' ? value : undefined;
}

function diagnosticIdState(value: unknown): 'known' | 'unknown' | undefined {
  return value === 'known' || value === 'unknown' ? value : undefined;
}

/**
 * Maps feature history diagnostics onto the persisted transcript diagnostic
 * shape. Page keys embed local transcript paths, so they are salted-hashed
 * before landing on disk. Exhaustive over HistoryDiagnosticEvent: adding a
 * new kind fails compilation here instead of silently dropping fields.
 */
export function mapHistoryDiagnosticEvent(
  event: HistoryDiagnosticEvent,
  hashId: (id: string) => string,
): TranscriptDiagnosticEvent {
  switch (event.kind) {
    case 'markdown_render_summary': {
      const common: TranscriptDiagnosticEvent = {
        phase: event.kind,
        metricVersion: event.metricVersion === 1 ? 1 : undefined,
        collectorIdHash: diagnosticHash(event.collectorIdHash),
        flushId: diagnosticInteger(event.flushId),
        flushReason: event.flushReason === 'timer' || event.flushReason === 'dispose' ? event.flushReason : undefined,
        flushScope: event.flushScope === 'window' || event.flushScope === 'attribution' ? event.flushScope : undefined,
        windowMs: diagnosticDuration(event.windowMs),
        callsSum: diagnosticInteger(event.callsSum),
        charsSum: diagnosticInteger(event.charsSum),
        charsMax: diagnosticInteger(event.charsMax),
        charsHistogram: diagnosticHistogram(event.charsHistogram, 7),
        elapsedMsSum: diagnosticDuration(event.elapsedMsSum),
        elapsedMsMax: diagnosticDuration(event.elapsedMsMax),
        elapsedMsHistogram: diagnosticHistogram(event.elapsedMsHistogram, 8),
        settledCalls: diagnosticInteger(event.settledCalls),
        successCalls: diagnosticInteger(event.successCalls),
        failureCalls: diagnosticInteger(event.failureCalls),
        inFlightAtStart: diagnosticInteger(event.inFlightAtStart),
        inFlightAtEnd: diagnosticInteger(event.inFlightAtEnd),
        abandonedCalls: diagnosticInteger(event.abandonedCalls),
        startVisibilityHistogram: diagnosticHistogram(event.startVisibilityHistogram, 27),
      };
      if (event.flushScope === 'window') {
        return {
          ...common,
          callsMax: diagnosticInteger(event.callsMax),
          callsHistogram: diagnosticHistogram(event.callsHistogram, 8),
          callsSampleCount: diagnosticInteger(event.callsSampleCount),
          attributionRows: diagnosticInteger(event.attributionRows),
          domPageNodes: diagnosticInteger(event.domPageNodes),
          domMessageNodes: diagnosticInteger(event.domMessageNodes),
          domTextBlockNodes: diagnosticInteger(event.domTextBlockNodes),
        };
      }
      if (event.flushScope === 'attribution' && event.attributionKind === 'known') {
        const slot = diagnosticInteger(event.attributionSlot);
        return {
          ...common,
          attributionKind: 'known',
          attributionSlot: slot !== undefined && slot >= 1 && slot <= 31 ? slot : undefined,
          tabIdState: diagnosticIdState(event.tabIdState),
          conversationIdState: diagnosticIdState(event.conversationIdState),
          tabIdHash: diagnosticHash(event.tabIdHash),
          conversationIdHash: diagnosticHash(event.conversationIdHash),
          tabGeneration: diagnosticInteger(event.tabGeneration),
          conversationGeneration: diagnosticInteger(event.conversationGeneration),
          tabActive: diagnosticVisibility(event.tabActive),
          documentVisible: diagnosticVisibility(event.documentVisible),
          domConnected: diagnosticVisibility(event.domConnected),
          viewport: event.viewport === 'unknown' ? 'unknown' : undefined,
        };
      }
      if (event.flushScope === 'attribution' && event.attributionKind === 'overflow') {
        return { ...common, attributionKind: 'overflow', attributionSlot: event.attributionSlot === 0 ? 0 : undefined };
      }
      return common;
    }
    case 'render_batch':
      return { phase: event.kind, batchLines: event.mounted, entries: event.total, elapsedMs: event.elapsedMs };
    case 'render_complete':
      return { phase: event.kind, entries: event.messages, turns: event.batches, elapsedMs: event.elapsedMs };
    case 'page_render_timeout':
      return { phase: event.kind, pageKeyHash: hashId(event.pageKey), renderTicket: event.ticket, elapsedMs: event.timeoutMs };
    case 'page_data_overcommit':
      return { phase: event.kind, entries: event.pages, projectedWeight: event.projectedWeight };
    case 'search_snapshot_refresh':
      return { phase: event.kind, outcome: event.outcome, reason: event.reason, trigger: event.trigger, elapsedMs: event.elapsedMs };
    case 'memory_only_rematerialize':
      return { phase: event.kind, pageKeyHash: hashId(event.pageKey) };
    case 'page_rekeyed':
      return {
        phase: event.kind,
        pageKeyHash: hashId(event.pageKey),
        previousPageKeyHash: hashId(event.previousPageKey),
        turns: event.turns,
      };
    case 'page_rematerialize_refused':
      return {
        phase: event.kind,
        pageKeyHash: hashId(event.pageKey),
        reason: event.reason,
        rangeStart: event.rangeStart,
        rangeEnd: event.rangeEnd,
        turnCount: event.actualRangeEnd - event.actualRangeStart,
      };
    case 'dom_overcommit':
      return { phase: event.kind, pageKeyHash: hashId(event.pageKey), turns: event.turns };
    case 'save_adoption_target_mismatch':
      return { phase: event.kind };
    case 'save_materialization_rejected':
      // 'malformed' carries both rejection reasons: the payload (or its
      // source) could not be detached honestly, so the messages axis was
      // dropped for that save.
      return { phase: event.kind, reason: 'malformed' };
    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled history diagnostic kind: ${unhandled}`);
    }
  }
}

export default class ClaudianPlugin extends Plugin {
  settings!: ClaudianSettings;
  storage!: SharedAppStorage;
  private conversations: Conversation[] = [];
  readonly conversationOpenRegistry = new ConversationOpenRegistry();
  /**
   * R2 wiring (stage 1): one plugin-lifetime save-admission coordinator. All
   * production save paths route through it so the save target and session
   * payload come from the same committed binding — never from a live runtime
   * that a later rebind already owns.
   */
  private readonly conversationMetadataSavePort = new ConversationMetadataSavePort({
    plugin: this,
    onDiagnostic: recordHistoryDiagnosticEvent,
  });
  readonly conversationHistoryCoordinator = new ConversationHistoryCoordinator({
    metadata: this.conversationMetadataSavePort,
  });
  readonly conversationSizes = new ConversationSizeService({
    getConversation: id => this.getConversationSync(id),
    getHistoryService: providerId => ProviderRegistry.getConversationHistoryService(providerId),
    getVaultPath: () => getVaultPath(this.app),
    onPublished: id => {
      for (const view of this.getAllViews()) view.onConversationSizePublished(id);
    },
  });
  private lastKnownTabManagerState: AppTabManagerState | null = null;
  private markdownRenderLog: ClaudeTranscriptDiagnosticLog | null = null;
  private readonly markdownRenderBindings = new Set<MarkdownRenderDiagnosticBinding>();
  private markdownTabGeneration = 0;

  async onload() {
    await this.loadSettings();
    await ProviderWorkspaceRegistry.initializeAll(this);

    // B1: route frame-batched render diagnostics into the shared
    // .claudian/diagnostics jsonl logs next to the index/window channels.
    const vaultPath = getVaultPath(this.app);
    if (vaultPath) {
      const renderDiagnostics = new ClaudeTranscriptDiagnosticLog(vaultPath, () => {}, 'history-render');
      try {
        this.markdownRenderLog = new ClaudeTranscriptDiagnosticLog(vaultPath, () => {}, 'markdown-render');
      } catch {
        this.markdownRenderLog = null;
      }
      setHistoryDiagnosticsSink(event => {
        if (event.kind === 'markdown_render_summary') {
          const log = this.markdownRenderLog;
          if (log) log.record(mapHistoryDiagnosticEvent(event, id => log.hashId(id)));
        } else {
          renderDiagnostics.record(mapHistoryDiagnosticEvent(event, id => renderDiagnostics.hashId(id)));
        }
      });
      // Startup orphan sweep: plugin start can never inherit a live pending
      // ask (the SDK connection dropped with the previous process aborted any
      // turn), so every ask-relay file from a previous run is stale.
      cleanupAskRelayFiles(vaultPath);
    }

    this.registerView(
      VIEW_TYPE_CLAUDIAN,
      (leaf) => new ClaudianView(leaf, this)
    );

    this.addRibbonIcon('bot', 'Open Claudian', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-view',
      name: 'Open chat view',
      callback: () => {
        this.activateView();
      },
    });

    this.addCommand({
      id: 'inline-edit',
      name: 'Inline edit',
      editorCallback: async (editor: Editor, ctx) => {
        const view = ctx instanceof MarkdownView
          ? ctx
          : this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          new Notice('Inline edit unavailable: could not access the active markdown view.');
          return;
        }

        const selectedText = editor.getSelection();
        const notePath = view.file?.path || 'unknown';

        let editContext: InlineEditContext;
        if (selectedText.trim()) {
          editContext = { mode: 'selection', selectedText };
        } else {
          const cursor = editor.getCursor();
          const cursorContext = buildCursorContext(
            (line) => editor.getLine(line),
            editor.lineCount(),
            cursor.line,
            cursor.ch
          );
          editContext = { mode: 'cursor', cursorContext };
        }

        const modal = new InlineEditModal(
          this.app,
          this,
          editor,
          view,
          editContext,
          notePath,
          () => this.getView()?.getActiveTab()?.ui.externalContextSelector?.getExternalContexts() ?? []
        );
        const result = await modal.openAndWait();

        if (result.decision === 'accept' && result.editedText !== undefined) {
          new Notice(editContext.mode === 'cursor' ? 'Inserted' : 'Edit applied');
        }
      },
    });

    this.addCommand({
      id: 'new-tab',
      name: 'New tab',
      checkCallback: (checking: boolean) => {
        if (!this.canCreateNewTab()) return false;

        if (!checking) {
          void this.openNewTab();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'new-session',
      name: 'New session (in current tab)',
      checkCallback: (checking: boolean) => {
        const view = this.getView();
        if (!view) return false;

        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        const activeTab = tabManager.getActiveTab();
        if (!activeTab) return false;

        if (activeTab.state.isStreaming) return false;

        if (!checking) {
          tabManager.createNewConversation();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'close-current-tab',
      name: 'Close current tab',
      checkCallback: (checking: boolean) => {
        const view = this.getView();
        if (!view) return false;

        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        if (!checking) {
          const activeTabId = tabManager.getActiveTabId();
          if (activeTabId) {
            tabManager.closeTab(activeTabId);
          }
        }
        return true;
      },
    });

    this.addSettingTab(new ClaudianSettingTab(this.app, this));
  }

  async onunload() {
    for (const binding of this.markdownRenderBindings) binding.dispose();
    this.markdownRenderBindings.clear();
    this.markdownRenderLog = null;
    setHistoryDiagnosticsSink(null);

    // Ensures state is saved even if Obsidian quits without calling onClose()
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (tabManager) {
        const state = tabManager.getPersistedState();
        await this.persistTabManagerState(state);
      }
    }
  }

  registerMarkdownRenderDiagnostics(
    tabId: string,
    initialConversationId: string | null,
    getTabActive: () => boolean | undefined,
  ): MarkdownRenderDiagnosticBinding | null {
    let log = this.markdownRenderLog;
    if (!log) return null;
    let collector: MarkdownRenderDiagnostics | null = null;
    try {
      const tabGeneration = ++this.markdownTabGeneration;
      if (!Number.isSafeInteger(tabGeneration)) return null;
      const collectorIdHash = log.hashId(`collector:${tabGeneration}`);
      const tabIdHash = log.hashId(tabId);
      let conversationId = initialConversationId;
      let conversationGeneration = 1;
      const conversationIdHash = conversationId === null ? undefined : log.hashId(conversationId);
      let readActive: (() => boolean | undefined) | null = getTabActive;
      collector = new MarkdownRenderDiagnostics(collectorIdHash, recordHistoryDiagnosticEvent);
      const instance = collector;
      instance.setContext({
        tabIdHash, conversationIdHash, tabGeneration, conversationGeneration,
        getTabActive: () => readActive?.(),
      });
      let closed = false;
      const binding: MarkdownRenderDiagnosticBinding = {
        collector: instance,
        bindConversation: next => {
          if (closed || next === conversationId) return;
          try {
            if (!log || !Number.isSafeInteger(conversationGeneration + 1)) throw new Error('diagnostic binding unavailable');
            const nextHash = next === null ? undefined : log.hashId(next);
            conversationId = next;
            conversationGeneration++;
            instance.setContext({
              tabIdHash, conversationIdHash: nextHash, tabGeneration, conversationGeneration,
              getTabActive: () => readActive?.(),
            });
          } catch {
            try { instance.disable(); } catch { /* diagnostics are isolated */ }
            binding.dispose();
          }
        },
        dispose: () => {
          if (closed) return;
          closed = true;
          try {
            instance.dispose();
          } catch {
            // Diagnostics must not interrupt teardown.
          } finally {
            conversationId = null;
            readActive = null;
            log = null;
            this.markdownRenderBindings.delete(binding);
          }
        },
      };
      this.markdownRenderBindings.add(binding);
      return binding;
    } catch {
      try { collector?.disable(); } catch { /* diagnostics are isolated */ }
      return null;
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];

    if (!leaf) {
      const newLeaf = this.getLeafForPlacement(this.settings.chatViewPlacement);
      if (newLeaf) {
        await newLeaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
        leaf = newLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  private getLeafForPlacement(placement: ChatViewPlacement): WorkspaceLeaf | null {
    const { workspace } = this.app;
    switch (placement) {
      case 'main-tab':
        return workspace.getLeaf('tab');
      case 'left-sidebar':
        return workspace.getLeftLeaf(false);
      case 'right-sidebar':
        return workspace.getRightLeaf(false);
    }
  }

  private canCreateNewTab(): boolean {
    const hasClaudianLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN).length > 0;
    const view = this.getView();
    const tabManager = view?.getTabManager();

    if (tabManager) {
      return tabManager.canCreateTab();
    }

    if (hasClaudianLeaf) {
      return false;
    }

    return this.getLastKnownOpenTabCount() < this.getMaxTabsLimit();
  }

  private async ensureViewOpen(): Promise<ClaudianView | null> {
    const existingView = this.getView();
    if (existingView) {
      return existingView;
    }

    await this.activateView();
    return this.getView();
  }

  private async openNewTab(): Promise<void> {
    const existingView = this.getView();
    if (existingView) {
      await existingView.createNewTab();
      return;
    }

    const restoredTabCount = this.getLastKnownOpenTabCount();
    const view = await this.ensureViewOpen();
    if (!view) {
      return;
    }

    // A cold-open view creates its initial tab during restore. Avoid stacking
    // an extra blank tab on top when there was no prior layout to restore.
    if (restoredTabCount === 0) {
      return;
    }

    await view.createNewTab();
  }

  async loadSettings() {
    this.storage = new SharedStorageService(this);
    const { claudian } = await this.storage.initialize();
    this.lastKnownTabManagerState = await this.storage.getTabManagerState();

    this.settings = {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      ...claudian,
    } as ClaudianSettings;

    // Plan is a runtime overlay and never survives a reload: storage already
    // normalizes durable values per provider fallback, so no blanket plan
    // rewrite may run here — it would erase a legitimate Claude Manual.
    const opencodeConfig = this.settings.providerConfigs?.opencode;
    if (
      opencodeConfig
      && typeof opencodeConfig === 'object'
      && !Array.isArray(opencodeConfig)
      && opencodeConfig.selectedMode === OPENCODE_PLAN_MODE_ID
    ) {
      opencodeConfig.selectedMode = OPENCODE_SAFE_MODE_ID;
    }

    const didNormalizeProviderSelection = ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings as unknown as Record<string, unknown>,
    );
    const didNormalizeModelVariants = this.normalizeModelVariantSettings();

    const allMetadata = await this.storage.sessions.listMetadata();
    this.conversations = allMetadata.map(meta => {
      const resumeSessionId = meta.sessionId !== undefined ? meta.sessionId : meta.id;

      return {
        id: meta.id,
        providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        lastResponseAt: meta.lastResponseAt,
        sessionId: resumeSessionId,
        providerState: meta.providerState,
        messages: [],
        hasHistory: meta.hasHistory,
        messageCount: meta.messageCount,
        preview: meta.preview,
        firstUserExcerpt: meta.firstUserExcerpt,
        currentNote: meta.currentNote,
        externalContextPaths: meta.externalContextPaths,
        enabledMcpServers: meta.enabledMcpServers,
        usage: meta.usage,
        titleGenerationStatus: meta.titleGenerationStatus,
        resumeAtMessageId: meta.resumeAtMessageId,
      };
    }).sort(
      (a, b) => (b.lastResponseAt ?? b.updatedAt) - (a.lastResponseAt ?? a.updatedAt)
    );
    setLocale(this.settings.locale as Locale);

    const backfilledConversations = this.backfillConversationResponseTimestamps();

    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment();

    ProviderSettingsCoordinator.projectActiveProviderState(
      this.settings as unknown as Record<string, unknown>,
    );

    if (changed || didNormalizeModelVariants || didNormalizeProviderSelection) {
      await this.saveSettings();
    }

    const conversationsToSave = new Set([...backfilledConversations, ...invalidatedConversations]);
    for (const conv of conversationsToSave) {
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conv)
      );
    }
  }

  private backfillConversationResponseTimestamps(): Conversation[] {
    const updated: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.lastResponseAt != null) continue;
      if (!conv.messages || conv.messages.length === 0) continue;

      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const msg = conv.messages[i];
        if (msg.role === 'assistant') {
          conv.lastResponseAt = msg.timestamp;
          updated.push(conv);
          break;
        }
      }
    }
    return updated;
  }

  normalizeModelVariantSettings(): boolean {
    return ProviderSettingsCoordinator.normalizeAllModelVariants(
      this.settings as unknown as Record<string, unknown>,
    );
  }

  async saveSettings() {
    ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings as unknown as Record<string, unknown>,
    );
    ProviderSettingsCoordinator.persistProjectedProviderState(
      this.settings as unknown as Record<string, unknown>,
    );

    await this.storage.saveClaudianSettings(this.settings);
  }

  /** Updates and persists environment variables, restarting processes to apply changes. */
  async applyEnvironmentVariables(scope: EnvironmentScope, envText: string): Promise<void> {
    await this.applyEnvironmentVariablesBatch([{ scope, envText }]);
  }

  async applyEnvironmentVariablesBatch(
    updates: Array<{ scope: EnvironmentScope; envText: string }>,
  ): Promise<void> {
    const settingsBag = this.settings as unknown as Record<string, unknown>;
    const nextEnvironmentByScope = new Map<EnvironmentScope, string>();
    for (const update of updates) {
      nextEnvironmentByScope.set(update.scope, update.envText);
    }

    const changedScopes: EnvironmentScope[] = [];
    for (const [scope, envText] of nextEnvironmentByScope) {
      const currentValue = getScopedEnvironmentVariables(settingsBag, scope);
      if (currentValue !== envText) {
        changedScopes.push(scope);
      }
      setEnvironmentVariablesForScope(settingsBag, scope, envText);
    }

    if (changedScopes.length === 0) {
      await this.saveSettings();
      return;
    }

    const affectedProviderIds = this.getAffectedEnvironmentProviders(changedScopes);
    ProviderSettingsCoordinator.handleEnvironmentChange(settingsBag, affectedProviderIds);
    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(affectedProviderIds);
    await this.saveSettings();

    if (invalidatedConversations.length > 0) {
      for (const conv of invalidatedConversations) {
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conv)
        );
      }
    }

    const view = this.getView();
    const tabManager = view?.getTabManager();

    if (tabManager) {
      const affectedTabs = tabManager.getAllTabs().filter((tab) => (
        affectedProviderIds.includes(tab.providerId ?? DEFAULT_CHAT_PROVIDER_ID)
      ));
      const syncTabRuntimeState = (tab: (typeof affectedTabs)[number]): void => {
        if (!tab.service || !tab.serviceInitialized) {
          return;
        }

        const conversation = tab.conversationId
          ? this.getConversationSync(tab.conversationId)
          : null;
        const hasConversationContext = conversation?.hasHistory === true
          || (conversation?.messageCount ?? conversation?.messages.length ?? 0) > 0;
        const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts()
          ?? (hasConversationContext
            ? conversation?.externalContextPaths ?? []
            : this.settings.persistentExternalContextPaths ?? []);

        // R2: environment re-syncs also route through the binding's adoption
        // registry — a reconcile that still sees a stale conversationId (the
        // switch's commit→rebind window) must never leave the adopted runtime
        // feedable into the record's save.
        syncRuntimeUnderAdoption(
          tab,
          tab.service,
          () => { tab.service?.syncConversationState(conversation, externalContextPaths); },
          { conversationId: tab.conversationId ?? null },
        );
      };

      for (const tab of affectedTabs) {
        if (tab.state.isStreaming) {
          tab.controllers.inputController?.cancelStreaming();
        }
      }

      let failedTabs = 0;
      if (changed) {
        for (const tab of affectedTabs) {
          if (!tab.service || !tab.serviceInitialized) {
            continue;
          }
          try {
            syncTabRuntimeState(tab);
            tab.service.resetSession();
            await tab.service.ensureReady();
          } catch {
            failedTabs++;
          }
        }
      } else {
        for (const tab of affectedTabs) {
          if (!tab.service || !tab.serviceInitialized) {
            continue;
          }
          try {
            syncTabRuntimeState(tab);
            await tab.service.ensureReady({ force: true });
          } catch {
            failedTabs++;
          }
        }
      }
      if (failedTabs > 0) {
        new Notice(`Environment changes applied, but ${failedTabs} affected tab(s) failed to restart.`);
      }
    }

    for (const openView of this.getAllViews()) {
      openView.invalidateProviderCommandCaches(affectedProviderIds);
      openView.refreshModelSelector();
    }

    const noticeText = changed
      ? 'Environment variables applied. Sessions will be rebuilt on next message.'
      : 'Environment variables applied.';
    new Notice(noticeText);
  }

  /** Returns the runtime environment variables (fixed at plugin load). */
  getActiveEnvironmentVariables(
    providerId: ProviderId = ProviderRegistry.resolveSettingsProviderId(
      this.settings as unknown as Record<string, unknown>,
    ),
  ): string {
    return getRuntimeEnvironmentText(
      this.settings as unknown as Record<string, unknown>,
      providerId,
    );
  }

  getEnvironmentVariablesForScope(scope: EnvironmentScope): string {
    return getScopedEnvironmentVariables(
      this.settings as unknown as Record<string, unknown>,
      scope,
    );
  }

  getResolvedProviderCliPath(providerId: ProviderId): string | null {
    const cliResolver = ProviderWorkspaceRegistry.getCliResolver(providerId);
    if (!cliResolver) {
      return null;
    }

    return cliResolver.resolveFromSettings(this.settings as unknown as Record<string, unknown>);
  }

  private reconcileModelWithEnvironment(providerIds: ProviderId[] = ProviderRegistry.getRegisteredProviderIds()): {
    changed: boolean;
    invalidatedConversations: Conversation[];
  } {
    return ProviderSettingsCoordinator.reconcileProviders(
      this.settings as unknown as Record<string, unknown>,
      this.conversations,
      providerIds,
    );
  }

  private getAffectedEnvironmentProviders(scopes: EnvironmentScope[]): ProviderId[] {
    const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
    const affectedProviderIds = new Set<ProviderId>();

    for (const scope of scopes) {
      if (scope === 'shared') {
        for (const providerId of registeredProviderIds) {
          affectedProviderIds.add(providerId);
        }
        continue;
      }

      const providerId = scope.slice('provider:'.length) as ProviderId;
      if (registeredProviderIds.has(providerId)) {
        affectedProviderIds.add(providerId);
      }
    }

    return Array.from(affectedProviderIds);
  }

  private generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateDefaultTitle(): string {
    const now = new Date();
    return now.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private getConversationPreview(conv: Conversation): string {
    if (conv.preview) return conv.preview;
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) {
      return 'New conversation';
    }
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
  }

  private async loadSdkMessagesForConversation(conversation: Conversation): Promise<void> {
    const service = ProviderRegistry.getConversationHistoryService(conversation.providerId);
    if (service.acquireHistoryIndex || !service.hydrateConversationHistory) return;
    const result = await service.hydrateConversationHistory(conversation, getVaultPath(this.app));
    if (result && result.status !== 'ready') {
      throw new ConversationHistoryHydrationError(result);
    }
  }

  async createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
  }): Promise<Conversation> {
    const providerId = options?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    const sessionId = options?.sessionId;
    const conversationId = sessionId ?? this.generateConversationId();
    const conversation: Conversation = {
      id: conversationId,
      providerId,
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: sessionId ?? null,
      messages: [],
    };

    this.conversations.unshift(conversation);
    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );

    return conversation;
  }

  async switchConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return null;

    await this.loadSdkMessagesForConversation(conversation);

    return conversation;
  }

  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.conversations.splice(index, 1);
    for (const view of this.getAllViews()) view.onConversationDeleted(id);

    await ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .deleteConversationSession(conversation, getVaultPath(this.app));

    await this.storage.sessions.deleteMetadata(id);

    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.conversationId === id) {
          tab.controllers.inputController?.cancelStreaming();
          await tab.controllers.conversationController?.createNew({ force: true });
        }
      }
    }
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();

    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );
  }

  /**
   * Manual (user-initiated) rename: rename, then clear titleGenerationStatus.
   * The clear must follow the rename — periodic AI title regeneration only
   * fires when the status is 'success'/'failed', so leaving it set lets the
   * next regeneration cycle overwrite the hand-edited title. Both entry
   * points (history dropdown, tab context menu) share this method; the
   * automatic title path keeps calling renameConversation directly and
   * preserves its status.
   */
  async renameConversationManually(id: string, title: string): Promise<void> {
    await this.renameConversation(id, title);
    await this.updateConversation(id, { titleGenerationStatus: undefined });
  }

  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    // providerId is immutable — strip it from updates to prevent accidental mutation
    const { providerId: _, ...safeUpdates } = updates;
    Object.assign(conversation, safeUpdates, { updatedAt: Date.now() });

    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );

  }

  async getConversationById(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id) || null;

    if (conversation) {
      await this.loadSdkMessagesForConversation(conversation);
    }

    return conversation;
  }

  getConversationSync(id: string): Conversation | null {
    return this.conversations.find(c => c.id === id) || null;
  }

  getConversationHistoryCoordinator(): ConversationHistoryCoordinator {
    return this.conversationHistoryCoordinator;
  }

  getConversationMetadataSavePort(): ConversationMetadataSavePort {
    return this.conversationMetadataSavePort;
  }

  findEmptyConversation(): Conversation | null {
    return this.conversations.find(conversation =>
      conversation.hasHistory !== true
      && (conversation.messageCount ?? conversation.messages.length) === 0
    ) || null;
  }

  getConversationList(): ConversationMeta[] {
    return this.conversations.map(c => ({
      id: c.id,
      providerId: c.providerId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastResponseAt: c.lastResponseAt,
      messageCount: c.messageCount ?? c.messages.length,
      preview: c.preview ?? this.getConversationPreview(c),
      sizeSnapshot: this.conversationSizes.getSnapshot(c.id),
      titleGenerationStatus: c.titleGenerationStatus,
    }));
  }

  async persistTabManagerState(state: AppTabManagerState): Promise<void> {
    this.lastKnownTabManagerState = state;
    await this.storage.setTabManagerState(state);
  }

  getView(): ClaudianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view).find(isClaudianView) ?? null;
  }

  getAllViews(): ClaudianView[] {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view).filter(isClaudianView);
  }

  findConversationAcrossViews(conversationId: string): { view: ClaudianView; tabId: string } | null {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      const tabs = tabManager.getAllTabs();
      for (const tab of tabs) {
        if (tab.conversationId === conversationId) {
          return { view, tabId: tab.id };
        }
      }
    }
    return null;
  }

  private getLastKnownOpenTabCount(): number {
    return this.lastKnownTabManagerState?.openTabs.length ?? 0;
  }

  private getMaxTabsLimit(): number {
    const maxTabs = this.settings.maxTabs ?? 3;
    return Math.max(3, Math.min(10, maxTabs));
  }

}
