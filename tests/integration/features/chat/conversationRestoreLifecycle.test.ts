/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */
 
import { installObsidianDom } from '@test/helpers/obsidianDom';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { MarkdownRenderer } from 'obsidian';
import { tmpdir } from 'os';
import { join } from 'path';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SharedStorageService } from '@/app/storage/SharedStorageService';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ChatRuntime } from '@/core/runtime/ChatRuntime';
import type { AutoTurnStartedEvent } from '@/core/runtime/types';
import type { ChatMessage, Conversation } from '@/core/types';
import type { ClaudianView } from '@/features/chat/ClaudianView';
import type { TabData } from '@/features/chat/tabs/types';
import ClaudianPlugin from '@/main';
import { CODEX_PROVIDER_CAPABILITIES } from '@/providers/codex/capabilities';

/**
 * R2 binding/save-receipt restore-lifecycle cases (design: new integration
 * lives here instead of expanding the Markdown diagnostics mixed file).
 * Real Plugin → View → TabManager → Controller → coordinator chain over
 * file-backed metadata storage.
 */
jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  return {
    ...actual,
    Scope: class { register() {} },
    ItemView: class extends actual.ItemView {
      app: unknown;
      contentEl: HTMLElement;
      constructor(leaf: { app: unknown }) {
        super(leaf);
        this.app = leaf.app;
        this.containerEl = document.createElement('div');
        this.contentEl = this.containerEl.createDiv();
        document.body.appendChild(this.containerEl);
      }
      load() {}
      registerDomEvent(target: EventTarget, type: string, handler: EventListener) {
        target.addEventListener(type, handler);
      }
      registerEvent() {}
      register() {}
      registerInterval() {}
    },
  };
});

const FIRST_ID = 'fixture-restore-conversation-a';
const SECOND_ID = 'fixture-restore-conversation-b';
let directory: string;
let plugin: ClaudianPlugin;
let views: ClaudianView[] = [];
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function paint(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function addConversation(id: string, text: string): Conversation {
  const conversation: Conversation = {
    id, title: 'fixture restore title', providerId: 'codex', createdAt: 1, updatedAt: 1, sessionId: null,
    messages: [{ id: `${id}-message`, role: 'user' as const, content: text, timestamp: 1 }],
  };
  (plugin as unknown as { conversations: Conversation[] }).conversations.push(conversation);
  return conversation;
}

function useFileBackedFixtureStorage(): SharedStorageService {
  const dataPath = join(directory, 'obsidian-plugin-data.json');
  Object.assign(plugin.app.vault.adapter, {
    exists: async (path: string) => existsSync(join(directory, path)),
    read: async (path: string) => readFileSync(join(directory, path), 'utf8'),
    write: async (path: string, content: string) => { writeFileSync(join(directory, path), content, 'utf8'); },
    mkdir: async (path: string) => { mkdirSync(join(directory, path), { recursive: true }); },
    remove: async (path: string) => { rmSync(join(directory, path), { force: true }); },
  });
  (plugin.loadData as jest.Mock).mockImplementation(async () =>
    existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : null);
  (plugin.saveData as jest.Mock).mockImplementation(async (data: unknown) => {
    writeFileSync(dataPath, JSON.stringify(data), 'utf8');
  });
  const storage = new SharedStorageService(plugin);
  plugin.storage = storage;
  return storage;
}

function createFixtureRuntime() {
  return {
    providerId: 'codex',
    getCapabilities: () => CODEX_PROVIDER_CAPABILITIES,
    onReadyStateChange: () => () => {},
    syncConversationState: jest.fn(),
    setApprovalCallback: jest.fn(),
    setApprovalDismisser: jest.fn(),
    setAskUserQuestionCallback: jest.fn(),
    setExitPlanModeCallback: jest.fn(),
    setSubagentHookProvider: jest.fn(),
    setAutoTurnCallback: jest.fn(),
    setPermissionModeSyncCallback: jest.fn(),
    setOnEmbeddedExternal: jest.fn((_callback: ((event: AutoTurnStartedEvent) => Promise<void>) | null) => {}),
    getSessionId: () => null,
    consumeSessionInvalidation: () => false,
    buildSessionUpdates: () => ({ updates: {} }),
    resetSession: jest.fn(),
    ensureReady: jest.fn(async () => true),
    cleanup: jest.fn(),
  };
}

async function openFixture(): Promise<{ view: ClaudianView; tab: TabData }> {
  const adapter = { basePath: directory };
  const app = {
    vault: {
      adapter, getName: () => 'Fixture', on: jest.fn(() => ({})), offref: jest.fn(),
      getFiles: () => [], getMarkdownFiles: () => [], getAllLoadedFiles: () => [],
    },
    workspace: {
      activeLeaf: null as unknown,
      getLeavesOfType: () => views.map(view => view.leaf),
      on: jest.fn(() => ({})), offref: jest.fn(), getActiveFile: () => null,
      getActiveViewOfType: () => null, getMostRecentLeaf: () => null,
    },
    metadataCache: { on: jest.fn(), offref: jest.fn(), getFileCache: () => null },
    scope: {},
  };
  plugin = new ClaudianPlugin(app as never, { id: 'fixture' } as never);
  jest.spyOn(plugin, 'loadSettings').mockImplementation(async () => {
    plugin.settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS));
    plugin.storage = {
      getTabManagerState: async () => null,
      setTabManagerState: async () => {},
      sessions: { saveMetadata: async () => {}, toSessionMetadata: (value: unknown) => value },
    } as never;
  });
  jest.spyOn(ProviderWorkspaceRegistry, 'initializeAll').mockResolvedValue();
  await plugin.onload();
  const factory = (plugin.registerView as jest.Mock).mock.calls[0][1] as (leaf: unknown) => ClaudianView;
  const leaf: { app: typeof plugin.app; view?: ClaudianView } = { app: plugin.app };
  const view = factory(leaf);
  leaf.view = view;
  views.push(view);
  (plugin.app.workspace as unknown as { activeLeaf: unknown }).activeLeaf = leaf;
  await view.onOpen();
  paint();
  await settle();
  const tab = view.getActiveTab();
  if (!tab?.renderer || !tab.controllers.streamController) throw new Error('fixture tab not initialized');
  return { view, tab };
}

async function openConversation(view: ClaudianView, id: string): Promise<void> {
  const opening = view.getTabManager()!.openConversation(id);
  for (let index = 0; index < 3; index++) {
    await settle();
    paint();
  }
  await opening;
}

beforeEach(() => {
  installObsidianDom();
  Object.assign(globalThis, {
    createEl: (tag: keyof HTMLElementTagNameMap, options?: Record<string, unknown>) => document.createElement('div').createEl(tag, options),
    createDiv: (options?: Record<string, unknown>) => document.createElement('div').createDiv(options),
  });
  directory = mkdtempSync(join(tmpdir(), 'claudian-restore-lifecycle-'));
  plugin = undefined as never;
  views = [];
  frames = new Map();
  nextFrame = 0;
  jest.useFakeTimers();
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockReset();
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementation(async (markdown: string, el: HTMLElement) => {
    el.textContent = markdown;
  });
});

afterEach(async () => {
  for (const view of views) await view.onClose();
  if (plugin) await plugin.onunload();
  ProviderWorkspaceRegistry.clear();
  jest.restoreAllMocks();
  jest.useRealTimers();
  document.body.replaceChildren();
  rmSync(directory, { recursive: true, force: true });
});

it('R2: an environment re-sync seen with a stale conversation id cannot feed the adopted runtime into the record save', async () => {
  const { view, tab } = await openFixture();
  const storage = useFileBackedFixtureStorage();
  const first = addConversation(FIRST_ID, 'fixture outgoing history');
  const second = addConversation(SECOND_ID, 'fixture incoming history');
  const firstSession = 'fixture-restore-session-a';
  const secondSession = 'fixture-restore-session-b';
  first.sessionId = firstSession;
  first.providerState = { threadId: firstSession };
  second.sessionId = secondSession;
  second.providerState = { threadId: secondSession };
  for (const conversation of [first, second]) {
    await storage.sessions.saveMetadata(storage.sessions.toSessionMetadata(conversation));
  }
  await openConversation(view, FIRST_ID);

  let runtimeSession: string | null = null;
  const runtime = Object.assign(createFixtureRuntime(), {
    syncConversationState: jest.fn((conversation: Conversation | null) => {
      runtimeSession = conversation?.sessionId ?? null;
    }),
    getSessionId: () => runtimeSession,
    buildSessionUpdates: () => ({
      updates: {
        sessionId: runtimeSession,
        providerState: runtimeSession ? { threadId: runtimeSession } : undefined,
      },
    }),
  });
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  const input = tab.controllers.inputController as unknown as {
    deps: { ensureServiceInitialized: () => Promise<boolean> };
  };
  expect(await input.deps.ensureServiceInitialized()).toBe(true);
  expect(runtimeSession).toBe(firstSession);

  // Full same-provider switch: outgoing seal for A written, binding B
  // committed, runtime re-bound and adopted under B.
  await openConversation(view, SECOND_ID);
  expect(tab.state.currentConversationId).toBe(SECOND_ID);
  expect(runtimeSession).toBe(secondSession);

  // Construct the reviewed window: the environment reconcile handler reads
  // tab.conversationId while the tab-level binding still shows the outgoing
  // record (binding B is already committed and adopted). The stale id must
  // not let the re-sync feed A's session facts into B's save.
  const staleConversationId = tab.conversationId;
  tab.conversationId = FIRST_ID;
  try {
    await plugin.applyEnvironmentVariables('provider:codex', 'FIXTURE_ENV_VAR=fixture-value');
    expect(runtime.syncConversationState).toHaveBeenCalledWith(
      expect.objectContaining({ id: FIRST_ID }),
      expect.anything(),
    );
  } finally {
    tab.conversationId = staleConversationId;
  }
  expect(runtimeSession).toBe(firstSession);

  // The record save must not capture the adopted runtime's now-foreign
  // session: it falls back to the binding's seed (B's persisted identity).
  await tab.controllers.conversationController!.save(false);
  const storedSecond = await storage.sessions.loadMetadata(SECOND_ID);
  expect({
    secondSession: storedSecond?.sessionId,
    secondThread: storedSecond?.providerState?.threadId,
  }).toEqual({ secondSession, secondThread: secondSession });
  const storedFirst = await storage.sessions.loadMetadata(FIRST_ID);
  expect({
    firstSession: storedFirst?.sessionId,
    firstThread: storedFirst?.providerState?.threadId,
  }).toEqual({ firstSession, firstThread: firstSession });
  expect((tab.state.messages as ChatMessage[]).length).toBeGreaterThanOrEqual(0);
});
