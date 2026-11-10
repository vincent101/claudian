/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */
// eslint-disable-next-line jest/no-mocks-import
import { getLastOptions, getLastResponse, getQueryCallCount, resetMockMessages, setMockMessages } from '@test/__mocks__/claude-agent-sdk';
import { installObsidianDom } from '@test/helpers/obsidianDom';
import type * as NodeCrypto from 'crypto';
import type * as NodeFs from 'fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import type * as NodeFsPromises from 'fs/promises';
import { MarkdownRenderer, Notice } from 'obsidian';
import { tmpdir } from 'os';
import { join } from 'path';
import { setImmediate as nodeSetImmediate } from 'timers';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SharedStorageService } from '@/app/storage/SharedStorageService';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { HistoryIndexLease, HistoryLoadProgress, ProviderConversationHistoryService } from '@/core/providers/types';
import type { ChatRuntime } from '@/core/runtime/ChatRuntime';
import type { AutoTurnStartedEvent } from '@/core/runtime/types';
import type { ChatMessage, Conversation } from '@/core/types';
import type { ClaudianView } from '@/features/chat/ClaudianView';
import { createTurnProjectionContext, type TurnProjectionContext } from '@/features/chat/controllers/StreamController';
import type { TabData } from '@/features/chat/tabs/types';
import { t } from '@/i18n/i18n';
import ClaudianPlugin from '@/main';
import { CLAUDE_PROVIDER_CAPABILITIES } from '@/providers/claude/capabilities';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as transcriptHistoryIndex from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import * as sdkSessionPaths from '@/providers/claude/history/sdkSessionPaths';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { ClaudeTranscriptDiagnosticLog } from '@/providers/claude/transcript/ClaudeTranscriptDiagnosticLog';
import { ClaudeTranscriptTurnObserver } from '@/providers/claude/transcript/ClaudeTranscriptTurnObserver';
import { CODEX_PROVIDER_CAPABILITIES } from '@/providers/codex/capabilities';
import { OPENCODE_PROVIDER_CAPABILITIES } from '@/providers/opencode/capabilities';
import * as opencodeHistoryStore from '@/providers/opencode/history/OpencodeHistoryStore';

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

const PRIVATE_CREDENTIAL = 'fixture-private-credential-marker';
const STREAM_BODY = `fixture chat body $x+y$ ${PRIVATE_CREDENTIAL}`;
const HISTORY_BODY = 'fixture private history body';
const PRIVATE_TITLE = 'fixture private conversation title';
const PRIVATE_ERROR = 'fixture private exception detail';
const FIRST_ID = 'fixture-private-conversation-a';
const SECOND_ID = 'fixture-private-conversation-b';
const ALLOWED_FIELDS = new Set([
  'ts', 'seq', 'phase', 'metricVersion', 'collectorIdHash', 'flushId', 'flushReason', 'flushScope',
  'windowMs', 'callsSum', 'callsMax', 'callsSampleCount', 'callsHistogram', 'charsSum', 'charsMax',
  'charsHistogram', 'elapsedMsSum', 'elapsedMsMax', 'elapsedMsHistogram', 'settledCalls', 'successCalls',
  'failureCalls', 'inFlightAtStart', 'inFlightAtEnd', 'abandonedCalls', 'startVisibilityHistogram',
  'attributionRows', 'attributionSlot', 'attributionKind', 'tabIdState', 'conversationIdState',
  'tabIdHash', 'conversationIdHash', 'tabGeneration', 'conversationGeneration', 'tabActive',
  'documentVisible', 'domConnected', 'viewport', 'domPageNodes', 'domMessageNodes', 'domTextBlockNodes',
]);
type DiagnosticRow = Record<string, unknown>;
let directory: string;
let plugin: ClaudianPlugin;
let views: ClaudianView[];
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

async function waitForFixture(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 20000; i++) {
    if (predicate()) return;
    paint();
    await new Promise<void>(resolve => nodeSetImmediate(resolve));
  }
  throw new Error(`fixture did not reach ${label}`);
}

function logPath(): string {
  return join(directory, '.claudian', 'diagnostics', 'markdown-render.current.jsonl');
}

function logRows(): DiagnosticRow[] {
  if (!existsSync(logPath())) return [];
  return readFileSync(logPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line) as DiagnosticRow);
}

function expectPrivateLog(rows: DiagnosticRow[], tabIds: string[] = []): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.phase).toBe('markdown_render_summary');
    expect(Object.keys(row).filter(key => !ALLOWED_FIELDS.has(key))).toEqual([]);
  }
  const text = JSON.stringify(rows);
  for (const secret of [STREAM_BODY, HISTORY_BODY, PRIVATE_CREDENTIAL, PRIVATE_TITLE, PRIVATE_ERROR, FIRST_ID, SECOND_ID, directory, ...tabIds]) {
    expect(text).not.toContain(secret);
  }
}

function addConversation(id: string, text: string): Conversation {
  const conversation: Conversation = {
    id, title: PRIVATE_TITLE, providerId: 'codex', createdAt: 1, updatedAt: 1, sessionId: null,
    messages: [{ id: `${id}-message`, role: 'user', content: text, timestamp: 1 }],
  };
  (plugin as unknown as { conversations: Conversation[] }).conversations.push(conversation);
  return conversation;
}

function prepareStream(tab: TabData): { message: ChatMessage; target: HTMLElement; context: TurnProjectionContext } {
  tab.state.resetStreamingState();
  tab.controllers.streamController!.beginRenderFlushScope();
  const message: ChatMessage = { id: `message-${nextFrame}`, role: 'assistant', content: '', timestamp: 1, toolCalls: [], contentBlocks: [] };
  const messageEl = tab.renderer!.addMessage(message);
  const target = messageEl.querySelector<HTMLElement>('.claudian-message-content')!;
  const context = createTurnProjectionContext({
    turnId: `turn-${nextFrame}`, message, renderTarget: target, generation: 1, domEpoch: tab.renderer!.domEpoch,
  });
  return { message, target, context };
}

async function streamChunk(tab: TabData, context: TurnProjectionContext, text: string): Promise<void> {
  await tab.controllers.streamController!.handleStreamChunk({ type: 'text', content: text }, context);
  paint();
  await settle();
}

async function openConversation(view: ClaudianView, id: string): Promise<void> {
  const opening = view.getTabManager()!.openConversation(id);
  for (let index = 0; index < 3; index++) {
    await settle();
    paint();
  }
  await opening;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
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
    cleanup: jest.fn(),
  };
}

async function initializeEmbeddedRuntime(tab: TabData) {
  const runtime = createFixtureRuntime();
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  const input = tab.controllers.inputController as unknown as {
    deps: { ensureServiceInitialized: () => Promise<boolean> };
  };
  expect(await input.deps.ensureServiceInitialized()).toBe(true);
  const emit = runtime.setOnEmbeddedExternal.mock.calls[0]?.[0];
  if (!emit) throw new Error('fixture runtime did not receive the embedded callback');
  return { runtime, emit };
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
  return openAdditionalView();
}

function useFileBackedFixtureStorage(): { dataPath: string; storage: SharedStorageService } {
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
  return { dataPath, storage };
}

function createFixtureView(): ClaudianView {
  const factory = (plugin.registerView as jest.Mock).mock.calls[0][1] as (leaf: unknown) => ClaudianView;
  const leaf: { app: typeof plugin.app; view?: ClaudianView } = { app: plugin.app };
  const view = factory(leaf);
  leaf.view = view;
  views.push(view);
  (plugin.app.workspace as unknown as { activeLeaf: unknown }).activeLeaf = leaf;
  return view;
}

async function openAdditionalView(): Promise<{ view: ClaudianView; tab: TabData }> {
  const view = createFixtureView();
  await view.onOpen();
  paint();
  await settle();
  const tab = view.getActiveTab();
  if (!tab?.renderer || !tab.controllers.streamController) throw new Error('fixture tab not initialized');
  return { view, tab };
}

async function openHydrationFixture() {
  await openFixture();
  const conversation = addConversation(FIRST_ID, HISTORY_BODY);
  const view = createFixtureView();
  jest.spyOn(plugin.storage, 'getTabManagerState').mockResolvedValueOnce({
    openTabs: [{ tabId: 'fixture-hydration-contract', conversationId: FIRST_ID }],
    activeTabId: 'fixture-hydration-contract',
  });
  await view.onOpen();
  const manager = view.getTabManager()!;
  const tab = manager.getActiveTab()!;
  return { view, manager, tab, conversation };
}

async function pendingConflictingTab() {
  const owner = await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  const ownerManager = owner.view.getTabManager()!;
  const owned = await ownerManager.createTab(FIRST_ID, 'fixture-owner-tab', { activate: false });
  expect(owned?.conversationId).toBe(FIRST_ID);
  const closing = await openAdditionalView();
  const manager = closing.view.getTabManager()!;
  (plugin.app.workspace as unknown as { revealLeaf: jest.Mock }).revealLeaf = jest.fn();
  const gate = deferred();
  const focusOwner = jest.spyOn(ownerManager, 'switchToTab').mockImplementationOnce(async () => gate.promise);
  const creating = manager.createTab(FIRST_ID, 'fixture-delayed-tab', { activate: false });
  await settle();
  expect(focusOwner).toHaveBeenCalledTimes(1);
  return { owner, closing, manager, gate, creating };
}

beforeEach(() => {
  installObsidianDom();
  Object.assign(globalThis, {
    createEl: (tag: keyof HTMLElementTagNameMap, options?: Record<string, unknown>) => document.createElement('div').createEl(tag, options),
    createDiv: (options?: Record<string, unknown>) => document.createElement('div').createDiv(options),
  });
  directory = mkdtempSync(join(tmpdir(), 'claudian-markdown-diagnostics-'));
  plugin = undefined as never;
  views = [];
  frames = new Map();
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockReset();
  nextFrame = 0;
  jest.useFakeTimers();
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
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

it('writes the real stream and final Markdown calls through the production assembly after five seconds', async () => {
  const { tab } = await openFixture();
  const message: ChatMessage = { id: 'fixture-message', role: 'assistant', content: '', timestamp: 1, toolCalls: [], contentBlocks: [] };
  const messageEl = tab.renderer!.addMessage(message);
  const target = messageEl.querySelector<HTMLElement>('.claudian-message-content')!;
  const context = createTurnProjectionContext({
    turnId: 'fixture-turn', message, renderTarget: target, generation: 1, domEpoch: tab.renderer!.domEpoch,
  });
  await tab.controllers.streamController!.handleStreamChunk({ type: 'text', content: STREAM_BODY }, context);
  expect(MarkdownRenderer.renderMarkdown).not.toHaveBeenCalled();
  paint();
  await settle();
  await tab.controllers.streamController!.finalizeCurrentTextBlock(message, context);
  expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledTimes(2);
  expect(target.textContent).toContain(STREAM_BODY);

  jest.advanceTimersByTime(4999);
  expect(existsSync(logPath())).toBe(false);
  jest.advanceTimersByTime(1);
  expect(existsSync(logPath())).toBe(true);
  const rows = readFileSync(logPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const window = rows.find(row => row.flushScope === 'window');
  expect(window).toMatchObject({ phase: 'markdown_render_summary', callsSum: 2, settledCalls: 2, successCalls: 2 });
  expect(readFileSync(logPath(), 'utf8')).not.toContain(STREAM_BODY);
  expectPrivateLog(rows, [tab.id]);
});

it('preserves in-flight accounting across real five-second flush windows', async () => {
  const { tab } = await openFixture();
  const pending = deferred();
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(async (text: string, el: HTMLElement) => {
    await pending.promise;
    el.textContent = text;
  });
  const stream = prepareStream(tab);
  await streamChunk(tab, stream.context, STREAM_BODY);
  jest.advanceTimersByTime(5000);
  const first = logRows().find(row => row.flushScope === 'window');
  expect(first).toMatchObject({ callsSum: 1, settledCalls: 0, inFlightAtStart: 0, inFlightAtEnd: 1 });

  jest.advanceTimersByTime(1000);
  pending.resolve();
  await settle();
  jest.advanceTimersByTime(4999);
  expect(logRows().filter(row => row.flushScope === 'window')).toHaveLength(1);
  jest.advanceTimersByTime(1);
  const rows = logRows();
  const windows = rows.filter(row => row.flushScope === 'window');
  expect(windows).toHaveLength(2);
  expect(windows[1]).toMatchObject({
    callsSum: 0, settledCalls: 1, successCalls: 1, inFlightAtStart: 1, inFlightAtEnd: 0,
  });
  expect(Number(windows[1].elapsedMsSum)).toBeGreaterThanOrEqual(6000);
  const attributed = rows.filter(row => row.flushScope === 'attribution');
  expect(attributed).toHaveLength(2);
  expect(attributed[0].tabIdHash).toBe(attributed[1].tabIdHash);
  expectPrivateLog(rows, [tab.id]);
});

it('records restored history through the same mapper without mixing it into the history log', async () => {
  jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const { view, tab } = await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  await openConversation(view, FIRST_ID);

  expect(tab.state.currentConversationId).toBe(FIRST_ID);
  expect(tab.dom.messagesEl.textContent).toContain(HISTORY_BODY);
  expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(5000);
  const rows = logRows();
  expect(rows.find(row => row.flushScope === 'window')).toMatchObject({
    callsSum: 1, charsSum: HISTORY_BODY.length, settledCalls: 1, successCalls: 1,
  });
  expect(rows.find(row => row.flushScope === 'attribution')).toMatchObject({
    tabIdState: 'known', conversationIdState: 'known', tabActive: 'yes',
    documentVisible: 'yes', domConnected: 'yes', viewport: 'unknown',
  });
  const historyPath = join(directory, '.claudian', 'diagnostics', 'history-render.current.jsonl');
  expect(readFileSync(historyPath, 'utf8')).not.toContain('markdown_render_summary');
  expectPrivateLog(rows);
});

it('freezes a pending render to its starting conversation and hashes only binding changes', async () => {
  const hash = jest.spyOn(ClaudeTranscriptDiagnosticLog.prototype, 'hashId');
  const { view, tab } = await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  addConversation(SECOND_ID, HISTORY_BODY);
  expect(hash).toHaveBeenCalledTimes(2);

  await openConversation(view, FIRST_ID);
  const firstIndex = hash.mock.calls.findIndex(([value]) => value === FIRST_ID);
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  const firstHash = hash.mock.results[firstIndex].value;
  const afterFirstBinding = hash.mock.calls.length;
  tab.state.currentConversationId = FIRST_ID;
  expect(hash).toHaveBeenCalledTimes(afterFirstBinding);

  const oldRender = deferred();
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(async (text: string, el: HTMLElement) => {
    await oldRender.promise;
    el.textContent = text;
  });
  const oldStream = prepareStream(tab);
  await streamChunk(tab, oldStream.context, STREAM_BODY);
  expect(hash).toHaveBeenCalledTimes(afterFirstBinding);

  await openConversation(view, SECOND_ID);
  expect(tab.state.currentConversationId).toBe(SECOND_ID);
  const secondIndex = hash.mock.calls.findIndex(([value]) => value === SECOND_ID);
  expect(secondIndex).toBeGreaterThanOrEqual(0);
  const secondHash = hash.mock.results[secondIndex].value;
  expect(secondHash).not.toBe(firstHash);
  const afterSecondBinding = hash.mock.calls.length;
  oldRender.resolve();
  await settle();

  const newStream = prepareStream(tab);
  await streamChunk(tab, newStream.context, 'first');
  await streamChunk(tab, newStream.context, 'second');
  await streamChunk(tab, newStream.context, 'third');
  await tab.controllers.streamController!.finalizeCurrentTextBlock(newStream.message, newStream.context);
  expect(hash).toHaveBeenCalledTimes(afterSecondBinding);

  jest.advanceTimersByTime(5000);
  const rows = logRows();
  const first = rows.find(row => row.flushScope === 'attribution' && row.conversationIdHash === firstHash);
  const second = rows.find(row => row.flushScope === 'attribution' && row.conversationIdHash === secondHash);
  expect(first).toMatchObject({ callsSum: 2, settledCalls: 2, successCalls: 2 });
  expect(second).toMatchObject({ callsSum: 4, settledCalls: 4, successCalls: 4 });
  expect(first!.tabIdHash).toBe(second!.tabIdHash);
  expect(Number(first!.conversationGeneration)).toBeLessThan(Number(second!.conversationGeneration));
  expectPrivateLog(rows);
});

it('samples tab visibility at each start and leaves no five-second polling timer when idle', async () => {
  jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const timeout = jest.spyOn(globalThis, 'setTimeout');
  const { view, tab: first } = await openFixture();
  const manager = view.getTabManager()!;
  const second = await manager.createTab(null, 'fixture-tab-two');
  expect(second).not.toBeNull();
  const scheduled = () => timeout.mock.calls.filter(([, delay]) => delay === 5000).length;
  expect(scheduled()).toBe(0);

  const stream = prepareStream(first);
  await streamChunk(first, stream.context, 'background');
  expect(scheduled()).toBe(1);
  await manager.switchToTab(first.id);
  await streamChunk(first, stream.context, 'foreground');
  expect(scheduled()).toBe(1);
  jest.advanceTimersByTime(4999);
  expect(logRows()).toEqual([]);
  jest.advanceTimersByTime(1);

  const rows = logRows();
  const attributed = rows.filter(row => row.flushScope === 'attribution');
  expect(attributed).toEqual(expect.arrayContaining([
    expect.objectContaining({ tabActive: 'no', documentVisible: 'yes', domConnected: 'yes', viewport: 'unknown', callsSum: 1 }),
    expect.objectContaining({ tabActive: 'yes', documentVisible: 'yes', domConnected: 'yes', viewport: 'unknown', callsSum: 1 }),
  ]));
  const beforeIdle = readFileSync(logPath(), 'utf8');
  jest.advanceTimersByTime(10000);
  expect(scheduled()).toBe(1);
  expect(readFileSync(logPath(), 'utf8')).toBe(beforeIdle);
  expectPrivateLog(rows);
});

it('closes one tab with one abandoned final flush while another tab keeps logging', async () => {
  const { view, tab: first } = await openFixture();
  const manager = view.getTabManager()!;
  const second = (await manager.createTab(null, 'fixture-tab-two'))!;
  const pending = deferred();
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(async (text: string, el: HTMLElement) => {
    await pending.promise;
    el.textContent = text;
  });
  const oldStream = prepareStream(second);
  await streamChunk(second, oldStream.context, STREAM_BODY);
  await expect(manager.closeTab(second.id)).resolves.toBe(true);

  const final = logRows().find(row => row.flushScope === 'window');
  expect(final).toMatchObject({
    flushReason: 'dispose', callsSum: 1, settledCalls: 0, failureCalls: 0, abandonedCalls: 1, inFlightAtEnd: 0,
  });
  const closedCollector = final!.collectorIdHash;
  const closedRows = logRows().filter(row => row.collectorIdHash === closedCollector).length;
  pending.resolve();
  await settle();
  paint();
  await settle();
  const newStream = prepareStream(first);
  await streamChunk(first, newStream.context, STREAM_BODY);
  jest.advanceTimersByTime(5000);

  const rows = logRows();
  expect(rows.filter(row => row.collectorIdHash === closedCollector)).toHaveLength(closedRows);
  expect(rows.some(row => row.collectorIdHash !== closedCollector && row.flushScope === 'window'
    && row.flushReason === 'timer' && row.successCalls === 1)).toBe(true);
  expectPrivateLog(rows);
});

it('gives a recreated tab with the same ID a new collector and generation', async () => {
  const { view } = await openFixture();
  const manager = view.getTabManager()!;
  const first = (await manager.createTab(null, 'fixture-reused-tab'))!;
  await streamChunk(first, prepareStream(first).context, STREAM_BODY);
  await expect(manager.closeTab(first.id)).resolves.toBe(true);

  const second = (await manager.createTab(null, 'fixture-reused-tab'))!;
  await streamChunk(second, prepareStream(second).context, STREAM_BODY);
  jest.advanceTimersByTime(5000);
  const rows = logRows();
  const attributed = rows.filter(row => row.flushScope === 'attribution');
  expect(attributed).toHaveLength(2);
  expect(attributed[0].tabIdHash).toBe(attributed[1].tabIdHash);
  expect(attributed[0].collectorIdHash).not.toBe(attributed[1].collectorIdHash);
  expect(Number(attributed[0].tabGeneration)).toBeLessThan(Number(attributed[1].tabGeneration));
  expectPrivateLog(rows, [first.id]);
});

it('flushes the view before waiting for tab-state persistence', async () => {
  const { view, tab } = await openFixture();
  await streamChunk(tab, prepareStream(tab).context, STREAM_BODY);
  const persistence = deferred();
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const closing = view.onClose();
  let closed = false;
  void closing.then(() => { closed = true; });
  try {
    await settle();
    expect(closed).toBe(false);
    const rows = logRows();
    expect(rows.find(row => row.flushScope === 'window')).toMatchObject({
      flushReason: 'dispose', callsSum: 1, settledCalls: 1, successCalls: 1,
    });
    expectPrivateLog(rows, [tab.id]);
  } finally {
    persistence.resolve();
    await closing;
  }
});

it('closes one view without waiting for Markdown or disabling another view', async () => {
  const first = await openFixture();
  const second = await openAdditionalView();
  const pending = deferred();
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(async (text: string, el: HTMLElement) => {
    await pending.promise;
    el.textContent = text;
  });
  const oldStream = prepareStream(first.tab);
  await streamChunk(first.tab, oldStream.context, STREAM_BODY);
  await first.view.onClose();
  await first.view.onClose();

  const final = logRows().find(row => row.flushScope === 'window');
  expect(final).toMatchObject({ flushReason: 'dispose', abandonedCalls: 1, failureCalls: 0 });
  const closedCollector = final!.collectorIdHash;
  const closedRows = logRows().filter(row => row.collectorIdHash === closedCollector).length;
  pending.resolve();
  await settle();
  const otherStream = prepareStream(second.tab);
  await streamChunk(second.tab, otherStream.context, STREAM_BODY);
  jest.advanceTimersByTime(5000);

  const rows = logRows();
  expect(rows.filter(row => row.collectorIdHash === closedCollector)).toHaveLength(closedRows);
  expect(rows.some(row => row.collectorIdHash !== closedCollector && row.flushScope === 'window'
    && row.flushReason === 'timer' && row.successCalls === 1)).toBe(true);
  expectPrivateLog(rows);
});

it('generation: ignores a bound state read that finishes after close and reopen', async () => {
  await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  (plugin.app.workspace as unknown as { revealLeaf: jest.Mock }).revealLeaf = jest.fn();
  const view = createFixtureView();
  const gate = deferred();
  jest.spyOn(plugin.storage, 'getTabManagerState').mockImplementationOnce(async () => {
    await gate.promise;
    return {
      openTabs: [{ tabId: 'fixture-old-bound', conversationId: FIRST_ID }],
      activeTabId: 'fixture-old-bound',
    };
  });
  const opening = view.onOpen();
  await settle();
  const oldManager = view.getTabManager()!;
  const restore = jest.spyOn(oldManager, 'restoreState');
  const create = jest.spyOn(oldManager, 'createTab');
  try {
    await view.onClose();
    await view.onOpen();
    const liveManager = view.getTabManager()!;
    const liveTabs = liveManager.getAllTabs();
    const prime = jest.spyOn(liveManager, 'primeProviderRuntime');
    const register = jest.spyOn(plugin, 'registerMarkdownRenderDiagnostics');
    expect(liveManager).not.toBe(oldManager);

    gate.resolve();
    await opening;
    expect(restore).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(oldManager.getTabCount()).toBe(0);
    expect(liveManager.getAllTabs()).toEqual(liveTabs);
    expect(prime).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    await openConversation(view, FIRST_ID);
    const live = liveManager.getActiveTab()!;
    expect(live.conversationId).toBe(FIRST_ID);
    expect(live.conversationOpenClaim).not.toBeNull();
    expect(plugin.conversationOpenRegistry.owns(live.conversationOpenClaim!)).toBe(true);
  } finally {
    gate.resolve();
    await opening.catch(() => undefined);
  }
});

it('R1a: a captured old manager callback cannot repaint or persist a reopened view', async () => {
  const { view, tab } = await openFixture();
  const oldManager = view.getTabManager()!;
  const callbacks = (oldManager as unknown as {
    callbacks: { onTabCreated?: (created: TabData) => void };
  }).callbacks;
  await view.onClose();
  await view.onOpen();
  paint();
  await settle();

  const internals = view as unknown as {
    updateTabBar: () => void;
    persistTabState: () => void;
    updateNavRowLocation: () => void;
    syncProviderBrandColor: () => void;
  };
  const repaint = jest.spyOn(internals, 'updateTabBar');
  const persist = jest.spyOn(internals, 'persistTabState');
  const moveNav = jest.spyOn(internals, 'updateNavRowLocation');
  const brand = jest.spyOn(internals, 'syncProviderBrandColor');
  callbacks.onTabCreated?.(tab);

  expect(repaint).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  expect(moveNav).not.toHaveBeenCalled();
  expect(brand).not.toHaveBeenCalled();
});

it('R1a: old view event handlers cannot act on a reopened generation', async () => {
  const { view } = await openFixture();
  const workspaceOn = plugin.app.workspace.on as jest.Mock;
  const oldFileOpen = workspaceOn.mock.calls.find(([event]: [string]) => event === 'file-open')?.[1] as
    ((file: unknown) => void) | undefined;
  expect(oldFileOpen).toBeDefined();
  await view.onClose();
  await view.onOpen();
  paint();
  await settle();

  const reopenedTab = view.getActiveTab()!;
  const fileContext = reopenedTab.ui.fileContextManager!;
  const handleFileOpen = jest.spyOn(fileContext, 'handleFileOpen').mockImplementation(() => {});
  const hide = jest.spyOn(view as unknown as { hideHistoryDropdown: () => void }, 'hideHistoryDropdown');
  oldFileOpen!({ path: 'fixture.md' });
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  expect(handleFileOpen).not.toHaveBeenCalled();
  expect(hide).toHaveBeenCalledTimes(1);
});

it('R1a: an entered conflicting tab creation does not publish after close starts', async () => {
  const { owner, closing, manager, gate, creating } = await pendingConflictingTab();
  const persistence = deferred();
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const closingPromise = closing.view.onClose();
  try {
    gate.resolve();
    const created = await creating;
    expect(created).toBeNull();
    expect(manager.getTab('fixture-delayed-tab')).toBeNull();
    const ownerClaim = owner.view.getTabManager()!.getTab('fixture-owner-tab')!.conversationOpenClaim!;
    expect(plugin.conversationOpenRegistry.owns(ownerClaim)).toBe(true);
  } finally {
    gate.resolve();
    persistence.resolve();
    await Promise.allSettled([creating, closingPromise]);
  }
});

it.each(['open', 'destroy'] as const)(
  'R1a: concurrent close calls share the cleanup flight with manager %s',
  async phase => {
    const { view, tab } = await openFixture();
    const live = await openAdditionalView();
    addConversation(FIRST_ID, HISTORY_BODY);
    await openConversation(view, FIRST_ID);
    const { runtime } = await initializeEmbeddedRuntime(tab);
    const manager = view.getTabManager()!;
    const liveManager = live.view.getTabManager()!;
    const oldClaim = tab.conversationOpenClaim!;
    expect(plugin.conversationOpenRegistry.owns(oldClaim)).toBe(true);
    const lease = { release: jest.fn() };
    tab.state.historyLease = lease as unknown as HistoryIndexLease;
    const remove = jest.spyOn(tab.dom.contentEl, 'remove');
    const release = jest.spyOn(plugin.conversationOpenRegistry, 'release');
    let repeated: Promise<boolean> | undefined;
    let repeatedAfterDestroy: Promise<boolean> | undefined;
    let transferring: Promise<TabData | null> | undefined;
    let destroying: Promise<void> | undefined;
    tab.dom.eventCleanups.push(() => {
      repeated = manager.closeTab(tab.id, true);
      transferring = liveManager.createTab(FIRST_ID, 'fixture-transferred-owner', { activate: false });
      if (phase === 'destroy') {
        destroying = manager.destroy();
        repeatedAfterDestroy = manager.closeTab(tab.id, true);
      }
    });
    const closing = manager.closeTab(tab.id, true);
    try {
      await settle();
      expect(repeated).toBe(closing);
      expect(repeatedAfterDestroy).toBe(phase === 'destroy' ? closing : undefined);
      expect(transferring).toBeDefined();
      const transferred = await transferring!;
      expect(transferred?.conversationId).toBe(FIRST_ID);
      const newClaim = transferred!.conversationOpenClaim!;
      expect(newClaim.ownerToken).not.toBe(oldClaim.ownerToken);
      expect(await closing).toBe(phase === 'open');
      if (destroying) await destroying;
      expect(plugin.conversationOpenRegistry.owns(newClaim)).toBe(true);
      expect(release.mock.calls.filter(([id, token]) => id === FIRST_ID && token === oldClaim.ownerToken)).toHaveLength(1);
      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(runtime.cleanup).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([
        closing,
        ...(repeated ? [repeated] : []),
        ...(repeatedAfterDestroy ? [repeatedAfterDestroy] : []),
        ...(transferring ? [transferring] : []),
        ...(destroying ? [destroying] : []),
      ]);
    }
  },
);

it('R1a: cleanup failure still releases tab resources without harming a new owner', async () => {
  const { view, tab } = await openFixture();
  const live = await openAdditionalView();
  addConversation(FIRST_ID, HISTORY_BODY);
  await openConversation(view, FIRST_ID);
  const { runtime } = await initializeEmbeddedRuntime(tab);
  const manager = view.getTabManager()!;
  const liveManager = live.view.getTabManager()!;
  const oldClaim = tab.conversationOpenClaim!;
  const lease = { release: jest.fn() };
  tab.state.historyLease = lease as unknown as HistoryIndexLease;
  const failure = new Error('fixture tab event cleanup failure');
  let repeated: Promise<boolean> | undefined;
  let transferring: Promise<TabData | null> | undefined;
  let destroying: Promise<void> | undefined;
  let destroyResult: Promise<unknown> | undefined;
  tab.dom.eventCleanups.push(() => {
    repeated = manager.closeTab(tab.id, true);
    transferring = liveManager.createTab(FIRST_ID, 'fixture-owner-after-failure', { activate: false });
    destroying = manager.destroy();
    destroyResult = destroying.then(() => null, error => error);
    throw failure;
  });
  const closing = manager.closeTab(tab.id, true);
  const closeResult = closing.then(() => null, error => error);
  try {
    await settle();
    expect(repeated).toBe(closing);
    expect(await closeResult).toBe(failure);
    expect(await destroyResult).toBe(failure);
    const transferred = await transferring!;
    expect(transferred?.conversationId).toBe(FIRST_ID);
    const newClaim = transferred!.conversationOpenClaim!;
    expect(newClaim.ownerToken).not.toBe(oldClaim.ownerToken);
    expect(plugin.conversationOpenRegistry.owns(newClaim)).toBe(true);
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect({ runtimeCleanupCalls: runtime.cleanup.mock.calls.length, domConnected: tab.dom.contentEl.isConnected })
      .toEqual({ runtimeCleanupCalls: 1, domConnected: false });
  } finally {
    await Promise.allSettled([
      closing,
      ...(repeated ? [repeated] : []),
      ...(transferring ? [transferring] : []),
      ...(destroying ? [destroying] : []),
    ]);
    await view.onClose().catch(() => {});
    if (tab.service) {
      tab.service.cleanup();
      tab.service = null;
    }
    tab.dom.contentEl.remove();
  }
});

it('R1a: an embedded projection resumed after close cannot start a save', async () => {
  const { view, tab } = await openFixture();
  const conversation = addConversation(FIRST_ID, HISTORY_BODY);
  conversation.messages.push({ id: 'fixture-assistant', role: 'assistant', content: 'fixture reply', timestamp: 2 });
  await openConversation(view, FIRST_ID);
  const { runtime, emit } = await initializeEmbeddedRuntime(tab);
  const controller = tab.controllers.conversationController!;
  const save = jest.spyOn(controller, 'save');
  const projection = tab.controllers.autoTurnProjectionController!;
  const project = projection.projectEmbeddedExternal.bind(projection);
  const projectionGate = deferred();
  let projected = false;
  jest.spyOn(projection, 'projectEmbeddedExternal').mockImplementationOnce(async event => {
    await project(event);
    projected = true;
    await projectionGate.promise;
  });
  const persistence = deferred();
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const pending = emit({
    turnId: 'fixture-embedded', generation: 1, source: { kind: 'peer' },
    displayContent: 'fixture embedded message', transcriptUserId: 'fixture-embedded-user',
  });
  let closing: Promise<void> | undefined;
  try {
    await settle();
    expect(projected).toBe(true);
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-embedded-user')).toBe(true);
    expect(save).not.toHaveBeenCalled();
    const manager = view.getTabManager()!;
    closing = view.onClose();
    expect(manager.isOpen()).toBe(false);
    projectionGate.resolve();
    await pending;
    expect(save).not.toHaveBeenCalled();
    expect(tab.state.hasPendingConversationSave).toBe(false);
    persistence.resolve();
    await closing;
    expect(save).toHaveBeenCalledTimes(1);
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
  } finally {
    projectionGate.resolve();
    persistence.resolve();
    await Promise.allSettled([pending, ...(closing ? [closing] : [])]);
  }
});

it('R1a race: a stopped observer batch must not project later events into a new runtime session', async () => {
  const { view, tab } = await openFixture();
  const first = addConversation(FIRST_ID, 'fixture original conversation');
  first.providerId = 'claude';
  first.messages.push({ id: 'fixture-original-assistant', role: 'assistant', content: 'original reply', timestamp: 2 });
  const second = addConversation(SECOND_ID, 'fixture replacement conversation');
  second.providerId = 'opencode';
  second.hasHistory = true;
  second.messages.push({ id: 'fixture-replacement-assistant', role: 'assistant', content: 'replacement reply', timestamp: 2 });
  const page = {
    messages: second.messages.map(message => ({ ...message })),
    range: { start: 0, end: 1 }, snapshotOffset: 0, sourceBytes: 1, projectedChars: 50,
    oversizedTurnCount: 0, pageKey: 'fixture-replacement-page', hasMoreBefore: false, hasMoreAfter: false,
  };
  const lease = {
    conversationId: SECOND_ID, totalTurns: 1, ready: Promise.resolve(),
    planWindow: () => ({ start: 0, end: 1 }), loadWindow: jest.fn().mockResolvedValue(page), release: jest.fn(),
  };
  const historyService = { acquireHistoryIndex: () => lease } as unknown as ProviderConversationHistoryService;
  const controller = tab.controllers.conversationController!;
  const internals = controller as unknown as {
    deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
  };
  jest.spyOn(internals.deps, 'getHistoryIndexCapableService')
    .mockImplementation(conversation => conversation.id === SECOND_ID ? historyService : null);
  const oldRuntime = { ...createFixtureRuntime(), providerId: 'claude', getCapabilities: () => CLAUDE_PROVIDER_CAPABILITIES };
  const newRuntime = { ...createFixtureRuntime(), providerId: 'opencode', getCapabilities: () => OPENCODE_PROVIDER_CAPABILITIES };
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockImplementation(({ providerId }) => (
    providerId === 'claude' ? oldRuntime : newRuntime
  ) as unknown as ChatRuntime);
  await openConversation(view, FIRST_ID);
  const input = tab.controllers.inputController as unknown as { deps: { ensureServiceInitialized: () => Promise<boolean> } };
  expect(await input.deps.ensureServiceInitialized()).toBe(true);
  expect(tab.service).toBe(oldRuntime);
  const oldCallback = oldRuntime.setOnEmbeddedExternal.mock.calls.at(-1)?.[0];
  if (!oldCallback) throw new Error('fixture runtime did not receive the observer callback');

  const transcript = join(directory, 'fixture-observer.jsonl');
  writeFileSync(transcript, '', 'utf8');
  const delivered: string[] = [];
  const observer = new ClaudeTranscriptTurnObserver({
    started: () => true,
    chunk: async () => {},
    finished: async () => {},
    released: () => {},
    cancelled: () => {},
    projectEmbeddedExternal: async event => {
      delivered.push(event.transcriptUserId!);
      await oldCallback(event);
    },
    onHostTurnTerminalObserved: () => {},
  }, () => true);
  oldRuntime.cleanup.mockImplementation(() => observer.stop('fixture_runtime_cleanup'));
  const transcriptIdentity = statSync(transcript);
  await observer.start(transcript, {
    provider: 'claude',
    protocol: 1,
    payload: { path: transcript, dev: transcriptIdentity.dev, ino: transcriptIdentity.ino, snapshotSize: transcriptIdentity.size, committedOffset: 0 },
  });
  observer.beginUserTurnProjection('fixture-host-turn');
  const rows = [
    { type: 'user', uuid: 'fixture-old-peer-1', origin: { kind: 'peer', body: 'fixture first peer' }, message: { role: 'user', content: 'fixture first peer' } },
    { type: 'user', uuid: 'fixture-old-peer-2', origin: { kind: 'peer', body: 'fixture second peer' }, message: { role: 'user', content: 'fixture second peer' } },
  ];
  writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const reader = (observer as unknown as { reader: { readAvailable: () => Promise<{ lines: string[] }> } }).reader;
  const read = jest.spyOn(reader, 'readAvailable');
  const entered = deferred();
  const gate = deferred();
  const updateConversation = plugin.updateConversation.bind(plugin);
  const update = jest.spyOn(plugin, 'updateConversation').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await gate.promise;
    return updateConversation(...args);
  });
  const save = jest.spyOn(controller, 'save');
  const completion = observer.completeUserTurnProjection('fixture-host-turn');
  const completionOutcome = completion.then(() => null, (error: unknown) => error);
  try {
    expect(await Promise.race([entered.promise.then(() => true), completionOutcome.then(() => false)])).toBe(true);
    const batch = await read.mock.results[0].value;
    expect(batch.lines).toHaveLength(2);
    expect(delivered).toEqual(['fixture-old-peer-1']);
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-old-peer-1')).toBe(true);
    const acceptedSaves = controller.snapshotAcceptedSaves();
    expect(acceptedSaves).toHaveLength(1);
    expect(update.mock.calls[0][0]).toBe(FIRST_ID);

    await openConversation(view, SECOND_ID);
    expect(await input.deps.ensureServiceInitialized()).toBe(true);
    expect(oldRuntime.cleanup).toHaveBeenCalledTimes(1);
    expect(tab.service).toBe(newRuntime);
    expect(tab.state.currentConversationId).toBe(SECOND_ID);
    expect(tab.state.historyLease).toBe(lease);
    expect(lease.loadWindow).toHaveBeenCalledTimes(1);
    expect(tab.state.messages.map(message => message.id)).toEqual(page.messages.map(message => message.id));
    expect(tab.state.historyPageStore.peek(page.pageKey)?.messages?.map(message => message.id))
      .toEqual(page.messages.map(message => message.id));
    expect(tab.dom.messagesEl.querySelector(`[data-page-key="${page.pageKey}"]`)?.textContent).toContain('replacement reply');
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-old-peer-2')).toBe(false);
    save.mockClear();
    const secondUpdatesBeforeRelease = update.mock.calls.filter(([id]) => id === SECOND_ID).length;

    gate.resolve();
    const completionError = await completionOutcome;
    const acceptedOutcomes = await Promise.allSettled(acceptedSaves);
    await settle();
    paint();
    await settle();
    expect([['fixture-old-peer-1'], ['fixture-old-peer-1', 'fixture-old-peer-2']]).toContainEqual(delivered);
    expect(save).not.toHaveBeenCalled();
    expect(update.mock.calls.filter(([id]) => id === SECOND_ID)).toHaveLength(secondUpdatesBeforeRelease);
    expect(acceptedOutcomes.map(outcome => outcome.status)).toEqual(['fulfilled']);
    expect(tab.state.currentConversationId).toBe(SECOND_ID);
    expect(tab.state.messages.map(message => message.id)).toEqual(page.messages.map(message => message.id));
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-old-peer-2')).toBe(false);
    const currentRecords = tab.state.historyPageStore.values();
    expect(currentRecords.map(record => record.pageKey)).toEqual([page.pageKey]);
    expect(tab.state.historyPageStore.peek(page.pageKey)?.messages?.map(message => message.id))
      .toEqual(page.messages.map(message => message.id));
    expect(currentRecords.flatMap(record => record.messages ?? []).some(message =>
      message.userMessageId === 'fixture-old-peer-1' || message.userMessageId === 'fixture-old-peer-2')).toBe(false);
    const pageNodes = [...tab.dom.messagesEl.querySelectorAll<HTMLElement>('[data-page-key]')];
    expect(pageNodes.map(element => element.dataset.pageKey)).toEqual([page.pageKey]);
    const currentPage = tab.dom.messagesEl.querySelector<HTMLElement>(`[data-page-key="${page.pageKey}"]`);
    expect(currentPage?.textContent).toContain('replacement reply');
    expect(currentPage?.textContent).not.toContain('fixture first peer');
    expect(currentPage?.textContent).not.toContain('fixture second peer');
    expect(tab.dom.messagesEl.textContent).toContain('replacement reply');
    expect(tab.dom.messagesEl.textContent).not.toContain('fixture first peer');
    expect(tab.dom.messagesEl.textContent).not.toContain('fixture second peer');
    expect(completionError).toBeNull();
  } finally {
    gate.resolve();
    await completionOutcome;
    observer.stop();
  }
});

it('R1a control: an unstopped observer delivers both embedded events to the original owner', async () => {
  const { view, tab } = await openFixture();
  const first = addConversation(FIRST_ID, 'fixture control conversation');
  first.providerId = 'claude';
  first.messages.push({ id: 'fixture-control-assistant', role: 'assistant', content: 'control reply', timestamp: 2 });
  const controller = tab.controllers.conversationController!;
  const internals = controller as unknown as {
    deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
  };
  jest.spyOn(internals.deps, 'getHistoryIndexCapableService').mockReturnValue(null);
  const runtime = { ...createFixtureRuntime(), providerId: 'claude', getCapabilities: () => CLAUDE_PROVIDER_CAPABILITIES };
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  await openConversation(view, FIRST_ID);
  const input = tab.controllers.inputController as unknown as { deps: { ensureServiceInitialized: () => Promise<boolean> } };
  expect(await input.deps.ensureServiceInitialized()).toBe(true);
  expect(tab.service).toBe(runtime);
  const callback = runtime.setOnEmbeddedExternal.mock.calls.at(-1)?.[0];
  if (!callback) throw new Error('fixture runtime did not receive the observer callback');

  const transcript = join(directory, 'fixture-observer-control.jsonl');
  writeFileSync(transcript, '', 'utf8');
  const delivered: Array<{ id: string | undefined; conversationId: string | null; originalRuntime: boolean }> = [];
  const observer = new ClaudeTranscriptTurnObserver({
    started: () => true,
    chunk: async () => {},
    finished: async () => {},
    released: () => {},
    cancelled: () => {},
    projectEmbeddedExternal: async event => {
      delivered.push({ id: event.transcriptUserId, conversationId: tab.state.currentConversationId, originalRuntime: Object.is(tab.service, runtime) });
      await callback(event);
    },
    onHostTurnTerminalObserved: () => {},
  }, () => true);
  const transcriptIdentity = statSync(transcript);
  await observer.start(transcript, {
    provider: 'claude',
    protocol: 1,
    payload: { path: transcript, dev: transcriptIdentity.dev, ino: transcriptIdentity.ino, snapshotSize: transcriptIdentity.size, committedOffset: 0 },
  });
  const stop = jest.spyOn(observer, 'stop');
  observer.beginUserTurnProjection('fixture-control-host');
  const rows = [
    { type: 'user', uuid: 'fixture-control-peer-1', origin: { kind: 'peer', body: 'fixture control first peer' }, message: { role: 'user', content: 'fixture control first peer' } },
    { type: 'user', uuid: 'fixture-control-peer-2', origin: { kind: 'peer', body: 'fixture control second peer' }, message: { role: 'user', content: 'fixture control second peer' } },
  ];
  writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const reader = (observer as unknown as { reader: { readAvailable: () => Promise<{ lines: string[] }> } }).reader;
  const read = jest.spyOn(reader, 'readAvailable');
  const entered = deferred();
  const gate = deferred();
  const updateConversation = plugin.updateConversation.bind(plugin);
  let gatedSaveCompleted = false;
  const update = jest.spyOn(plugin, 'updateConversation').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await gate.promise;
    await updateConversation(...args);
    gatedSaveCompleted = true;
  });
  const completion = observer.completeUserTurnProjection('fixture-control-host');
  const completionOutcome = completion.then(() => null, (error: unknown) => error);
  try {
    expect(await Promise.race([entered.promise.then(() => true), completionOutcome.then(() => false)])).toBe(true);
    expect((await read.mock.results[0].value).lines).toHaveLength(2);
    expect(delivered).toEqual([{ id: 'fixture-control-peer-1', conversationId: FIRST_ID, originalRuntime: true }]);
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-control-peer-1')).toBe(true);
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-control-peer-2')).toBe(false);
    expect(controller.snapshotAcceptedSaves()).toHaveLength(1);
    expect(update.mock.calls.map(([id]) => id)).toEqual([FIRST_ID]);

    gate.resolve();
    const completionError = await completionOutcome;
    await settle();
    paint();
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(completionError).toBeNull();
    expect(gatedSaveCompleted).toBe(true);
    expect(delivered).toEqual([
      { id: 'fixture-control-peer-1', conversationId: FIRST_ID, originalRuntime: true },
      { id: 'fixture-control-peer-2', conversationId: FIRST_ID, originalRuntime: true },
    ]);
    expect(tab.state.currentConversationId).toBe(FIRST_ID);
    expect(tab.service).toBe(runtime);
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-control-peer-1')).toBe(true);
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-control-peer-2')).toBe(true);
    expect(tab.dom.messagesEl.textContent).toContain('fixture control first peer');
    expect(tab.dom.messagesEl.textContent).toContain('fixture control second peer');
    expect(update.mock.calls.map(([id]) => id)).toEqual([FIRST_ID, FIRST_ID]);
  } finally {
    gate.resolve();
    await completionOutcome;
    observer.stop();
  }
});

it('R1a race: an old observer batch must not project into a new session on the same runtime', async () => {
  const { view, tab } = await openFixture();
  const first = addConversation(FIRST_ID, 'fixture original session');
  first.providerId = 'claude';
  first.sessionId = 'fixture-observer-session-a';
  first.messages.push({ id: 'fixture-original-assistant', role: 'assistant', content: 'original reply', timestamp: 2 });
  const second = addConversation(SECOND_ID, 'fixture replacement session');
  second.providerId = 'claude';
  second.sessionId = 'fixture-observer-session-b';
  second.hasHistory = true;
  const firstPath = join(directory, `${first.sessionId}.jsonl`);
  const secondPath = join(directory, `${second.sessionId}.jsonl`);
  writeFileSync(firstPath, '', 'utf8');
  writeFileSync(secondPath, '', 'utf8');
  jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockImplementation((_vault, sessionId) => join(directory, `${sessionId}.jsonl`));

  const controller = tab.controllers.conversationController!;
  const controllerInternals = controller as unknown as {
    deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
  };
  const page = {
    messages: [
      { id: 'fixture-new-user', role: 'user' as const, content: 'new session user', timestamp: 1 },
      { id: 'fixture-new-assistant', role: 'assistant' as const, content: 'new session reply', timestamp: 2 },
    ],
    range: { start: 0, end: 1 }, snapshotOffset: 0, sourceBytes: 1, projectedChars: 30,
    oversizedTurnCount: 0, pageKey: 'fixture-new-session-page', hasMoreBefore: false, hasMoreAfter: false,
  };
  const lease = {
    conversationId: SECOND_ID,
    totalTurns: 1,
    ready: Promise.resolve(),
    planWindow: () => ({ start: 0, end: 1 }),
    loadWindow: jest.fn().mockResolvedValue(page),
    release: jest.fn(),
  };
  const historyService = { acquireHistoryIndex: () => lease } as unknown as ProviderConversationHistoryService;
  jest.spyOn(controllerInternals.deps, 'getHistoryIndexCapableService')
    .mockImplementation(conversation => conversation.id === SECOND_ID ? historyService : null);

  const runtime = new ClaudianService(plugin, {} as never);
  const runtimeInternals = runtime as unknown as {
    startPersistentQuery: (...args: unknown[]) => Promise<void>;
    transcriptObserver: ClaudeTranscriptTurnObserver | null;
    transcriptObserverRestartChain: Promise<void>;
  };
  const startProvider = jest.spyOn(runtimeInternals, 'startPersistentQuery').mockImplementation(() => {
    throw new Error('fixture must not start a provider');
  });
  const query = jest.spyOn(runtime, 'query').mockImplementation(() => {
    throw new Error('fixture must not query a provider');
  });
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime);
  await openConversation(view, FIRST_ID);
  const input = tab.controllers.inputController as unknown as { deps: { ensureServiceInitialized: () => Promise<boolean> } };
  expect(await input.deps.ensureServiceInitialized()).toBe(true);
  await runtimeInternals.transcriptObserverRestartChain;
  const observer = runtimeInternals.transcriptObserver;
  if (!observer) throw new Error('fixture runtime did not start its transcript observer');
  expect(tab.service).toBe(runtime);
  expect(runtime.getSessionId()).toBe(first.sessionId);
  const stop = jest.spyOn(observer, 'stop');
  const reader = (observer as unknown as { reader: { readAvailable: () => Promise<{ lines: string[] }> } }).reader;
  const read = jest.spyOn(reader, 'readAvailable');
  observer.beginUserTurnProjection('fixture-same-runtime-host');
  const rows = [
    { type: 'user', uuid: 'fixture-same-peer-1', origin: { kind: 'peer', body: 'fixture same runtime first peer' }, message: { role: 'user', content: 'fixture same runtime first peer' } },
    { type: 'user', uuid: 'fixture-same-peer-2', origin: { kind: 'peer', body: 'fixture same runtime second peer' }, message: { role: 'user', content: 'fixture same runtime second peer' } },
  ];
  writeFileSync(firstPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const entered = deferred();
  const gate = deferred();
  const updateConversation = plugin.updateConversation.bind(plugin);
  const update = jest.spyOn(plugin, 'updateConversation').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await gate.promise;
    return updateConversation(...args);
  });
  const save = jest.spyOn(controller, 'save');
  const completion = observer.completeUserTurnProjection('fixture-same-runtime-host');
  const completionOutcome = completion.then(() => null, (error: unknown) => error);
  try {
    expect(await Promise.race([entered.promise.then(() => true), completionOutcome.then(() => false)])).toBe(true);
    const batch = await read.mock.results[0].value;
    expect(batch.lines).toHaveLength(2);
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-same-peer-1')).toBe(true);
    expect(controller.snapshotAcceptedSaves()).toHaveLength(1);

    await openConversation(view, SECOND_ID);
    await runtimeInternals.transcriptObserverRestartChain;
    expect(stop).toHaveBeenCalledWith('session_switch');
    expect(tab.service).toBe(runtime);
    expect(runtime.getSessionId()).toBe(second.sessionId);
    expect(tab.state.currentConversationId).toBe(SECOND_ID);
    expect(tab.state.historyLease).toBe(lease);
    expect(lease.loadWindow).toHaveBeenCalledTimes(1);
    const newPage = tab.state.historyPageStore.peek(page.pageKey);
    const newPageEl = tab.dom.messagesEl.querySelector<HTMLElement>(`[data-page-key="${page.pageKey}"]`);
    expect(newPage?.messages?.map(message => message.id)).toEqual(['fixture-new-user', 'fixture-new-assistant']);
    expect(newPageEl?.textContent).toContain('new session reply');
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-same-peer-2')).toBe(false);
    save.mockClear();
    update.mockClear();

    gate.resolve();
    const completionError = await completionOutcome;
    await settle();
    paint();
    await settle();
    expect(startProvider).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect({
      conversationId: tab.state.currentConversationId,
      staleMessage: tab.state.messages.some(message => message.userMessageId === 'fixture-same-peer-2'),
      staleDom: tab.dom.messagesEl.textContent?.includes('fixture same runtime second peer'),
      stalePageData: newPage?.messages?.some(message => message.userMessageId === 'fixture-same-peer-2'),
      stalePageDom: newPageEl?.textContent?.includes('fixture same runtime second peer'),
      savesToNewConversation: update.mock.calls.filter(([id]) => id === SECOND_ID).length,
      completionError: completionError === null ? null : String(completionError),
    }).toEqual({
      conversationId: SECOND_ID, staleMessage: false, staleDom: false,
      stalePageData: false, stalePageDom: false, savesToNewConversation: 0, completionError: null,
    });
  } finally {
    gate.resolve();
    await completionOutcome;
  }
});

it('R1a characterization: a real send holds the live lease while the next session waits to mount', async () => {
  const { view, tab } = await openFixture();
  const { storage } = useFileBackedFixtureStorage();
  plugin.settings.enableAutoTitleGeneration = false;
  const first = addConversation(FIRST_ID, 'fixture original session');
  first.providerId = 'claude';
  first.sessionId = 'fixture-real-send-session-a';
  first.messages.push({ id: 'fixture-real-old-assistant', role: 'assistant', content: 'old reply', timestamp: 2 });
  const second = addConversation(SECOND_ID, 'fixture replacement session');
  second.providerId = 'claude';
  second.sessionId = 'fixture-real-send-session-b';
  second.hasHistory = true;
  await storage.sessions.saveMetadata(storage.sessions.toSessionMetadata(first));
  await storage.sessions.saveMetadata(storage.sessions.toSessionMetadata(second));
  const metadataWrite = jest.spyOn(storage.getAdapter(), 'write');

  const firstPath = join(directory, `${first.sessionId}.jsonl`);
  const secondPath = join(directory, `${second.sessionId}.jsonl`);
  writeFileSync(firstPath, '', 'utf8');
  writeFileSync(secondPath, '', 'utf8');
  jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockImplementation((_vault, sessionId) => join(directory, `${sessionId}.jsonl`));
  jest.spyOn(plugin, 'getResolvedProviderCliPath').mockReturnValue(join(directory, 'fixture-claude-cli'));
  jest.spyOn(plugin, 'getActiveEnvironmentVariables').mockReturnValue('');

  const controller = tab.controllers.conversationController!;
  const controllerInternals = controller as unknown as {
    deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
  };
  const page = {
    messages: [
      { id: 'fixture-real-new-user', role: 'user' as const, content: 'new session user', timestamp: 1 },
      { id: 'fixture-real-new-assistant', role: 'assistant' as const, content: 'new session reply', timestamp: 2 },
    ],
    range: { start: 0, end: 1 }, snapshotOffset: 0, sourceBytes: 1, projectedChars: 30,
    oversizedTurnCount: 0, pageKey: 'fixture-real-new-session-page', hasMoreBefore: false, hasMoreAfter: false,
  };
  const lease = {
    conversationId: SECOND_ID, totalTurns: 1, ready: Promise.resolve(),
    planWindow: () => ({ start: 0, end: 1 }), loadWindow: jest.fn().mockResolvedValue(page), release: jest.fn(),
  };
  const historyService = { acquireHistoryIndex: () => lease } as unknown as ProviderConversationHistoryService;
  jest.spyOn(controllerInternals.deps, 'getHistoryIndexCapableService')
    .mockImplementation(conversation => conversation.id === SECOND_ID ? historyService : null);

  const runtime = new ClaudianService(plugin, {
    mcpManager: {
      getAllDisallowedMcpTools: () => [], getActiveServers: () => ({}), getDisallowedMcpTools: () => [],
      extractMentions: () => new Set<string>(), transformMentions: (text: string) => text,
    },
    pluginManager: { getPluginsKey: () => '' },
    agentManager: { setBuiltinAgentNames: () => {} },
  } as never);
  const runtimeInternals = runtime as unknown as {
    transcriptObserver: ClaudeTranscriptTurnObserver | null;
    transcriptObserverRestartChain: Promise<void>;
  };
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime);
  await openConversation(view, FIRST_ID);
  const input = tab.controllers.inputController!;
  const inputInternals = input as unknown as { deps: { ensureServiceInitialized: () => Promise<boolean> } };
  expect(await inputInternals.deps.ensureServiceInitialized()).toBe(true);
  await runtimeInternals.transcriptObserverRestartChain;
  const observer = runtimeInternals.transcriptObserver;
  if (!observer) throw new Error('fixture runtime did not start its transcript observer');
  const stop = jest.spyOn(observer, 'stop');
  const read = jest.spyOn((observer as unknown as { reader: { readAvailable: () => Promise<{ lines: string[] }> } }).reader, 'readAvailable');
  const begin = jest.spyOn(runtime, 'beginUserTurnProjection');
  const complete = jest.spyOn(runtime, 'completeUserTurnProjection');
  const query = jest.spyOn(runtime, 'query');
  const coordinator = tab.controllers.projectionWriteCoordinator!;
  const coordinatorInternals = coordinator as unknown as { queue: Array<{ isLive: boolean }> };
  const renderer = tab.renderer as unknown as { messagesEl: HTMLElement };
  const projection = tab.controllers.autoTurnProjectionController!;
  const project = projection.projectEmbeddedExternal.bind(projection);
  const delivered: Array<{ id: string | undefined; conversationId: string | null; live: boolean }> = [];
  jest.spyOn(projection, 'projectEmbeddedExternal').mockImplementation(async event => {
    delivered.push({ id: event.transcriptUserId, conversationId: tab.state.currentConversationId, live: coordinator.hasLiveTurn() });
    await project(event);
  });

  const gate = deferred();
  let gatedSaveStarted = false;
  let gatedSaveCommitted = false;
  const updateConversation = plugin.updateConversation.bind(plugin);
  const update = jest.spyOn(plugin, 'updateConversation').mockImplementation(async (...args) => {
    if (!gatedSaveStarted && args[0] === FIRST_ID
      && tab.state.messages.some(message => message.userMessageId === 'fixture-real-peer-1')) {
      gatedSaveStarted = true;
      await gate.promise;
      await updateConversation(...args);
      gatedSaveCommitted = true;
      return;
    }
    await updateConversation(...args);
  });
  resetMockMessages();
  setMockMessages([{ type: 'assistant', message: { id: 'fixture-sdk-assistant', content: [{ type: 'text', text: 'fixture streamed reply' }] } }], { appendResult: false });
  let sendSettled = false;
  let sendError: unknown = null;
  const sending = input.sendMessage({ content: 'fixture real send' }).then(
    () => { sendSettled = true; }, error => { sendError = error; sendSettled = true; },
  );
  let switching: Promise<void> | undefined;
  let switchSettled = false;
  let switchError: unknown = null;
  try {
    await waitForFixture(() => getQueryCallCount() > 0 && observer.currentDispatch() !== null, 'real SDK dispatch');
    expect(tab.service).toBe(runtime);
    expect(runtime.getSessionId()).toBe(first.sessionId);
    expect(tab.state.isStreaming).toBe(true);
    expect(coordinator.hasLiveTurn()).toBe(true);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(getLastOptions()?.cwd).toBe(directory);
    expect(getLastOptions()?.pathToClaudeCodeExecutable).toBe(join(directory, 'fixture-claude-cli'));
    await view.getTabManager()!.openConversation(SECOND_ID);
    expect(tab.state.currentConversationId).toBe(FIRST_ID);
    expect(tab.state.isStreaming).toBe(true);

    const rows = [
      { type: 'user', uuid: 'fixture-real-peer-1', origin: { kind: 'peer', body: 'fixture real first peer' }, message: { role: 'user', content: 'fixture real first peer' } },
      { type: 'user', uuid: 'fixture-real-peer-2', origin: { kind: 'peer', body: 'fixture real second peer' }, message: { role: 'user', content: 'fixture real second peer' } },
    ];
    writeFileSync(firstPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    getLastResponse()!.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'fixture completed' });
    await waitForFixture(() => gatedSaveStarted || sendSettled, 'first embedded save');
    expect(gatedSaveStarted).toBe(true);
    expect(sendSettled).toBe(false);
    expect(tab.state.isStreaming).toBe(false);
    expect(coordinator.hasLiveTurn()).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await read.mock.results[0].value).lines).toHaveLength(2);
    expect(delivered).toEqual([{ id: 'fixture-real-peer-1', conversationId: FIRST_ID, live: true }]);
    const acceptedSaves = controller.snapshotAcceptedSaves();
    expect(acceptedSaves).toHaveLength(1);
    expect(gatedSaveCommitted).toBe(false);

    switching = view.getTabManager()!.openConversation(SECOND_ID).then(
      () => { switchSettled = true; }, error => { switchError = error; switchSettled = true; },
    );
    await waitForFixture(() => tab.state.currentConversationId === SECOND_ID
      && coordinatorInternals.queue.some(item => !item.isLive)
      && stop.mock.calls.some(([reason]) => reason === 'session_switch'), 'next session waiting behind live lease');
    await runtimeInternals.transcriptObserverRestartChain;
    expect(switchSettled).toBe(false);
    expect(coordinator.hasLiveTurn()).toBe(true);
    expect(tab.service).toBe(runtime);
    expect(runtime.getSessionId()).toBe(second.sessionId);
    expect(tab.state.historyLease).toBe(lease);
    expect(lease.loadWindow).toHaveBeenCalledTimes(1);
    expect(tab.state.messages.map(message => message.id)).toEqual(page.messages.map(message => message.id));
    expect(tab.state.historyPageStore.peek(page.pageKey)).toBeUndefined();
    expect(tab.dom.messagesEl.querySelector(`[data-page-key="${page.pageKey}"]`)).toBeNull();
    expect(renderer.messagesEl).toBe(tab.dom.messagesEl);
    expect(delivered).toHaveLength(1);
    const firstMetadataPath = storage.sessions.getMetadataPath(FIRST_ID);
    const firstWritesBeforeRelease = metadataWrite.mock.calls.filter(([path]) => path === firstMetadataPath).length;

    gate.resolve();
    await waitForFixture(() => sendSettled && switchSettled, 'send and switch completion');
    await Promise.all([sending, switching, ...acceptedSaves]);
    expect(sendError).toBeNull();
    expect(switchError).toBeNull();
    expect(gatedSaveCommitted).toBe(true);
    const firstWritesAfterRelease = metadataWrite.mock.calls.filter(([path]) => path === firstMetadataPath).slice(firstWritesBeforeRelease);
    expect(firstWritesAfterRelease.length).toBeGreaterThan(0);
    const lastFirstWrite = firstWritesAfterRelease[firstWritesAfterRelease.length - 1];
    expect(JSON.parse(readFileSync(join(directory, firstMetadataPath), 'utf8'))).toEqual(JSON.parse(lastFirstWrite[1]));
    expect(await storage.sessions.loadMetadata(FIRST_ID)).toMatchObject({ id: FIRST_ID, sessionId: first.sessionId });
    const completion = complete.mock.results[0].value as Promise<void>;
    expect(await completion.then(() => null, error => String(error))).toBeNull();
    expect(coordinator.hasLiveTurn()).toBe(false);
    expect(delivered).toEqual([{ id: 'fixture-real-peer-1', conversationId: FIRST_ID, live: true }]);
    expect(tab.state.currentConversationId).toBe(SECOND_ID);
    expect(runtime.getSessionId()).toBe(second.sessionId);
    expect(tab.state.messages.map(message => message.id)).toEqual(page.messages.map(message => message.id));
    expect(tab.state.messages.some(message => message.userMessageId === 'fixture-real-peer-2')).toBe(false);
    expect(update.mock.calls.filter(([id]) => id === SECOND_ID)).toHaveLength(0);
    const currentRecords = tab.state.historyPageStore.values();
    expect(currentRecords.map(record => record.pageKey)).toEqual([page.pageKey]);
    expect(tab.state.historyPageStore.peek(page.pageKey)?.messages?.map(message => message.id)).toEqual(page.messages.map(message => message.id));
    expect(currentRecords.flatMap(record => record.messages ?? []).some(message => message.userMessageId === 'fixture-real-peer-2')).toBe(false);
    const pageNodes = [...tab.dom.messagesEl.querySelectorAll<HTMLElement>('[data-page-key]')];
    expect(pageNodes.map(element => element.dataset.pageKey)).toEqual([page.pageKey]);
    const currentPage = tab.dom.messagesEl.querySelector<HTMLElement>(`[data-page-key="${page.pageKey}"]`);
    expect(currentPage?.textContent).toContain('new session reply');
    expect(currentPage?.textContent).not.toContain('fixture real second peer');
    expect(tab.dom.messagesEl.textContent).not.toContain('fixture real second peer');
    expect(getQueryCallCount()).toBe(1);
  } finally {
    gate.resolve();
    getLastResponse()?.pushStdoutMessage({ type: 'result', subtype: 'success', result: 'fixture cleanup' });
    await waitForFixture(() => sendSettled && (!switching || switchSettled), 'fixture cleanup');
    await Promise.all([sending, ...(switching ? [switching] : [])]);
    resetMockMessages();
  }
});

it('R1a: close drains an embedded save accepted before retirement', async () => {
  const { view, tab } = await openFixture();
  const conversation = addConversation(FIRST_ID, HISTORY_BODY);
  conversation.messages.push({ id: 'fixture-assistant', role: 'assistant', content: 'fixture reply', timestamp: 2 });
  await openConversation(view, FIRST_ID);
  const { runtime, emit } = await initializeEmbeddedRuntime(tab);
  const controller = tab.controllers.conversationController!;
  const claim = tab.conversationOpenClaim!;
  expect(plugin.conversationOpenRegistry.owns(claim)).toBe(true);
  const updateConversation = plugin.updateConversation.bind(plugin);
  const updateGate = deferred();
  const update = jest.spyOn(plugin, 'updateConversation').mockImplementationOnce(async (...args) => {
    await updateGate.promise;
    return updateConversation(...args);
  });
  const remove = jest.spyOn(tab.dom.contentEl, 'remove');
  const pending = emit({
    turnId: 'fixture-accepted-embedded', generation: 1, source: { kind: 'peer' },
    displayContent: 'fixture accepted message', transcriptUserId: 'fixture-accepted-user',
  });
  let closing: Promise<void> | undefined;
  try {
    await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(controller.snapshotAcceptedSaves()).toHaveLength(1);
    closing = view.onClose();
    let closed = false;
    void closing.then(() => { closed = true; }, () => { closed = true; });
    await settle();
    expect(closed).toBe(false);
    expect(plugin.conversationOpenRegistry.owns(claim)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    updateGate.resolve();
    await pending;
    await closing;
    expect(conversation.messages.some(message => message.userMessageId === 'fixture-accepted-user')).toBe(true);
    expect(plugin.conversationOpenRegistry.owns(claim)).toBe(false);
    expect(runtime.cleanup).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    updateGate.resolve();
    await Promise.allSettled([pending, ...(closing ? [closing] : [])]);
  }
});

it('R1a: waits for an accepted lazy save without creating a duplicate conversation', async () => {
  const { view, tab } = await openFixture();
  tab.state.messages = [{ id: 'fixture-unsaved', role: 'user', content: 'pending save', timestamp: 1 }];
  const gate = deferred();
  const createConversation = plugin.createConversation.bind(plugin);
  const create = jest.spyOn(plugin, 'createConversation').mockImplementationOnce(async (...args) => {
    await gate.promise;
    return createConversation(...args);
  });
  const saving = tab.controllers.conversationController!.save();
  const closing = view.onClose();
  let closed = false;
  void closing.then(() => { closed = true; }, () => { closed = true; });
  try {
    await settle();
    expect(closed).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    gate.resolve();
    await saving;
    await closing;
    expect(create).toHaveBeenCalledTimes(1);
    expect(tab.state.currentConversationId).toBeTruthy();
    expect(tab.conversationId).toBe(tab.state.currentConversationId);
  } finally {
    gate.resolve();
    await Promise.allSettled([saving, closing]);
  }
});

it('R1a: an accepted lazy save remains bound in the persisted layout after reopen', async () => {
  const { view, tab: anchor } = await openFixture();
  const { dataPath, storage } = useFileBackedFixtureStorage();
  const conversation = addConversation(FIRST_ID, 'fixture existing conversation');
  await storage.sessions.saveMetadata(storage.sessions.toSessionMetadata(conversation));
  await openConversation(view, FIRST_ID);
  const manager = view.getTabManager()!;
  const lazy = await manager.createTab();
  if (!lazy?.controllers.conversationController) throw new Error('fixture lazy tab was not initialized');
  await initializeEmbeddedRuntime(lazy);
  const message = 'fixture pending lazy-save message';
  lazy.state.messages = [{ id: 'fixture-lazy-message', role: 'user', content: message, timestamp: 1 }];

  jest.advanceTimersByTime(300);
  await settle();
  expect(existsSync(dataPath)).toBe(true);
  const initialLayout = await plugin.storage.getTabManagerState();
  expect(initialLayout).toMatchObject({
    activeTabId: lazy.id,
    openTabs: expect.arrayContaining([
      expect.objectContaining({ tabId: anchor.id, conversationId: FIRST_ID }),
      expect.objectContaining({ tabId: lazy.id, conversationId: null }),
    ]),
  });
  expect(JSON.parse(readFileSync(dataPath, 'utf8')).tabManagerState).toEqual(initialLayout);

  const gate = deferred();
  const createConversation = plugin.createConversation.bind(plugin);
  const create = jest.spyOn(plugin, 'createConversation').mockImplementationOnce(async (...args) => {
    await gate.promise;
    return createConversation(...args);
  });
  const controller = lazy.controllers.conversationController;
  const saving = controller.save();
  const persist = jest.spyOn(plugin, 'persistTabManagerState');
  let closing: Promise<void> | undefined;
  try {
    expect(create).toHaveBeenCalledTimes(1);
    expect(controller.snapshotAcceptedSaves()).toContain(saving);
    expect(lazy.state.currentConversationId).toBeNull();
    expect(lazy.state.messages[0].content).toBe(message);
    closing = view.onClose();
    let closed = false;
    void closing.then(() => { closed = true; }, () => { closed = true; });
    await settle();
    expect(manager.isOpen()).toBe(false);
    expect(closed).toBe(false);
    const layoutWhileSaving = await plugin.storage.getTabManagerState();
    expect(layoutWhileSaving?.openTabs.find(item => item.tabId === lazy.id)?.conversationId).toBeNull();
    const lastCloseWrite = persist.mock.calls.at(-1)?.[0];
    const closePersistedBeforeId = !!lastCloseWrite
      && JSON.stringify(JSON.parse(readFileSync(dataPath, 'utf8')).tabManagerState) === JSON.stringify(lastCloseWrite);

    gate.resolve();
    await saving;
    const savedId = lazy.state.currentConversationId;
    expect(savedId).toBeTruthy();
    expect(savedId).not.toBe(FIRST_ID);
    expect(lazy.conversationId).toBe(savedId);
    expect(await storage.sessions.loadMetadata(savedId!)).toMatchObject({
      id: savedId, hasHistory: true, messageCount: 1, firstUserExcerpt: message,
    });
    await closing;
    const finalLayout = await plugin.storage.getTabManagerState();
    expect(JSON.parse(readFileSync(dataPath, 'utf8')).tabManagerState).toEqual(finalLayout);
    const persistedId = finalLayout?.openTabs.find(item => item.tabId === lazy.id)?.conversationId;
    // A deferred close write is also valid if it includes the completed save's ID.
    expect(closePersistedBeforeId || persistedId === savedId).toBe(true);

    await view.onOpen();
    const reopened = view.getTabManager()!;
    expect(reopened.getTab(anchor.id)?.conversationId).toBe(FIRST_ID);
    const restored = reopened.getTab(lazy.id);
    expect({
      closePersistedBeforeId,
      persistedConversationId: finalLayout?.openTabs.find(item => item.tabId === lazy.id)?.conversationId,
      reopenedConversationId: restored?.conversationId,
      reopenedStateId: restored?.state.currentConversationId,
      activeTabId: reopened.getActiveTab()?.id,
    }).toEqual({
      closePersistedBeforeId: expect.any(Boolean),
      persistedConversationId: savedId,
      reopenedConversationId: savedId,
      reopenedStateId: savedId,
      activeTabId: lazy.id,
    });
  } finally {
    gate.resolve();
    await Promise.allSettled([saving, ...(closing ? [closing] : [])]);
  }
});

it('R1a: waits for every accepted save before cleanup and reports a failure', async () => {
  const { view, tab } = await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  await openConversation(view, FIRST_ID);
  const failure = new Error('fixture accepted save failure');
  const failedGate = deferred();
  const pendingGate = deferred();
  const updateConversation = plugin.updateConversation.bind(plugin);
  jest.spyOn(plugin, 'updateConversation')
    .mockImplementationOnce(async () => {
      await failedGate.promise;
      throw failure;
    })
    .mockImplementationOnce(async (...args) => {
      await pendingGate.promise;
      return updateConversation(...args);
    });
  const remove = jest.spyOn(tab.dom.contentEl, 'remove');
  const controller = tab.controllers.conversationController!;
  const failed = controller.save();
  const pending = controller.save();
  const failedResult = failed.then(() => null, error => error);
  const closing = view.onClose();
  const closeResult = closing.then(() => null, error => error);
  let closed = false;
  void closeResult.then(() => { closed = true; });
  try {
    failedGate.resolve();
    await settle();
    expect(await failedResult).toBe(failure);
    expect(closed).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    pendingGate.resolve();
    await pending;
    expect(await closeResult).toBe(failure);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    failedGate.resolve();
    pendingGate.resolve();
    await Promise.allSettled([failed, pending, closing]);
  }
});

it('A/B: close after a same-provider runtime rebind preserves the outgoing session metadata', async () => {
  const { view, tab } = await openFixture();
  const { storage } = useFileBackedFixtureStorage();
  const first = addConversation(FIRST_ID, 'fixture outgoing history');
  const second = addConversation(SECOND_ID, 'fixture incoming history');
  const firstSession = 'fixture-session-a';
  const secondSession = 'fixture-session-b';
  first.sessionId = firstSession;
  first.providerState = { threadId: firstSession, sessionFilePath: join(directory, 'missing-a.jsonl') };
  second.sessionId = secondSession;
  second.providerState = { threadId: secondSession, sessionFilePath: join(directory, 'missing-b.jsonl') };
  for (const conversation of [first, second]) {
    await storage.sessions.saveMetadata(storage.sessions.toSessionMetadata(conversation));
  }
  await openConversation(view, FIRST_ID);

  let runtimeSession: string | null = null;
  let runtimeSessionPath: string | null = null;
  const runtime = Object.assign(createFixtureRuntime(), {
    syncConversationState: jest.fn((conversation: Conversation | null) => {
      runtimeSession = conversation?.sessionId ?? null;
      runtimeSessionPath = typeof conversation?.providerState?.sessionFilePath === 'string'
        ? conversation.providerState.sessionFilePath
        : null;
    }),
    getSessionId: () => runtimeSession,
    buildSessionUpdates: () => ({
      updates: {
        sessionId: runtimeSession,
        providerState: runtimeSession
          ? { threadId: runtimeSession, ...(runtimeSessionPath ? { sessionFilePath: runtimeSessionPath } : {}) }
          : undefined,
      },
    }),
  });
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  const input = tab.controllers.inputController as unknown as {
    deps: { ensureServiceInitialized: () => Promise<boolean> };
  };
  expect(await input.deps.ensureServiceInitialized()).toBe(true);
  expect(runtimeSession).toBe(firstSession);

  const controller = tab.controllers.conversationController!;
  const internals = controller as unknown as {
    deps: { ensureServiceForConversation: (conversation: Conversation | null) => Promise<void> };
  };
  const ensureService = internals.deps.ensureServiceForConversation.bind(internals.deps);
  const gate = deferred();
  let rebound = false;
  jest.spyOn(internals.deps, 'ensureServiceForConversation').mockImplementationOnce(async conversation => {
    await ensureService(conversation);
    rebound = true;
    await gate.promise;
  });
  const updates = jest.spyOn(plugin, 'updateConversation');
  const switching = view.getTabManager()!.openConversation(SECOND_ID);
  void switching.catch(() => undefined);
  try {
    for (let index = 0; index < 5 && !rebound; index++) {
      await settle();
      paint();
    }
    expect(rebound).toBe(true);
    expect(tab.state.currentConversationId).toBe(FIRST_ID);
    expect(tab.conversationId).toBe(SECOND_ID);
    expect(tab.conversationOpenClaim?.conversationId).toBe(FIRST_ID);
    expect(tab.state.isSwitchingConversation).toBe(true);
    expect(tab.hydrationState).toBe('READY');
    expect(runtimeSession).toBe(secondSession);
    expect(updates.mock.calls.filter(([id]) => id === FIRST_ID)).toHaveLength(1);
    expect(controller.snapshotAcceptedSaves()).toHaveLength(0);
    expect(await storage.sessions.loadMetadata(FIRST_ID)).toMatchObject({
      id: FIRST_ID, sessionId: firstSession, providerState: { threadId: firstSession },
    });
    expect(await storage.sessions.loadMetadata(SECOND_ID)).toMatchObject({
      id: SECOND_ID, sessionId: secondSession, providerState: { threadId: secondSession },
    });

    await view.onClose();
    gate.resolve();
    await switching;
    const storedFirst = await storage.sessions.loadMetadata(FIRST_ID);
    const storedSecond = await storage.sessions.loadMetadata(SECOND_ID);
    expect({
      firstSession: storedFirst?.sessionId,
      firstThread: storedFirst?.providerState?.threadId,
      secondSession: storedSecond?.sessionId,
      secondThread: storedSecond?.providerState?.threadId,
    }).toEqual({
      firstSession, firstThread: firstSession, secondSession, secondThread: secondSession,
    });
  } finally {
    gate.resolve();
    await switching.catch(() => undefined);
  }
});

it('A/B: an entered switch keeps its pending claim until the original manager is destroyed', async () => {
  const closing = await openFixture();
  const live = await openAdditionalView();
  addConversation(FIRST_ID, HISTORY_BODY);
  (plugin.app.workspace as unknown as { revealLeaf: jest.Mock }).revealLeaf = jest.fn();
  const internals = closing.tab.controllers.conversationController as unknown as {
    deps: { ensureServiceForConversation: (conversation: Conversation | null) => Promise<void> };
  };
  const ensureService = internals.deps.ensureServiceForConversation.bind(internals.deps);
  const gate = deferred();
  const persistence = deferred();
  let reached = false;
  jest.spyOn(internals.deps, 'ensureServiceForConversation').mockImplementationOnce(async conversation => {
    await ensureService(conversation);
    reached = true;
    await gate.promise;
  });
  const reserve = jest.spyOn(plugin.conversationOpenRegistry, 'reserve');
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const switching = closing.view.getTabManager()!.openConversation(FIRST_ID);
  void switching.catch(() => undefined);
  await settle();
  const oldClaim = reserve.mock.results.at(-1)?.value;
  if (!oldClaim || !reached) throw new Error('fixture did not reach the pending switch');
  expect(plugin.conversationOpenRegistry.owns(oldClaim)).toBe(true);
  const closingPromise = closing.view.onClose();
  try {
    expect(plugin.conversationOpenRegistry.owns(oldClaim)).toBe(true);
    persistence.resolve();
    await closingPromise;
    expect(plugin.conversationOpenRegistry.owns(oldClaim)).toBe(false);
    const liveTab = await live.view.getTabManager()!.createTab(FIRST_ID, 'fixture-live-claim', { activate: false });
    expect(liveTab?.conversationId).toBe(FIRST_ID);
    const liveClaim = liveTab!.conversationOpenClaim!;
    gate.resolve();
    await switching.catch(() => undefined);
    expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
  } finally {
    gate.resolve();
    persistence.resolve();
    await Promise.allSettled([switching, closingPromise]);
  }
});

it('A/B: destroy saves a READY incoming session even before its switch commits', async () => {
  const { view, tab } = await openFixture();
  addConversation(FIRST_ID, 'fixture outgoing history');
  addConversation(SECOND_ID, HISTORY_BODY);
  await openConversation(view, FIRST_ID);
  const controller = tab.controllers.conversationController!;
  const internals = controller as unknown as {
    restoreConversation: (conversation: Conversation, page: unknown) => Promise<void>;
  };
  const gate = deferred();
  const restore = internals.restoreConversation.bind(controller);
  let reached = false;
  jest.spyOn(internals, 'restoreConversation').mockImplementationOnce(async (...args) => {
    await restore(...args);
    reached = true;
    await gate.promise;
  });
  const updates = jest.spyOn(plugin, 'updateConversation');
  const switching = view.getTabManager()!.openConversation(SECOND_ID);
  void switching.catch(() => undefined);
  try {
    await settle();
    expect(reached).toBe(true);
    expect(tab.hydrationState).toBe('READY');
    expect(tab.state.currentConversationId).toBe(SECOND_ID);
    expect(tab.state.isSwitchingConversation).toBe(true);
    await view.onClose();
    expect(updates.mock.calls.filter(([id]) => id === FIRST_ID)).toHaveLength(1);
    expect(updates.mock.calls.filter(([id]) => id === SECOND_ID)).toHaveLength(1);
  } finally {
    gate.resolve();
    await switching.catch(() => undefined);
  }
});

it('R1a: retains a candidate claim until destroy without installing or publishing the tab', async () => {
  const closing = await openFixture();
  const live = await openAdditionalView();
  addConversation(FIRST_ID, HISTORY_BODY);
  const oldManager = closing.view.getTabManager()!;
  const liveManager = live.view.getTabManager()!;
  const reserve = jest.spyOn(plugin.conversationOpenRegistry, 'reserve');
  const register = jest.spyOn(plugin, 'registerMarkdownRenderDiagnostics');
  const persistence = deferred();
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const oldCreation = oldManager.createTab(FIRST_ID, 'fixture-old-pending', { activate: false });
  const oldClaim = reserve.mock.results.at(-1)?.value;
  if (!oldClaim) throw new Error('fixture failed to acquire the old claim');
  expect(plugin.conversationOpenRegistry.owns(oldClaim)).toBe(true);
  expect(oldManager.getTab('fixture-old-pending')).toBeNull();

  const closingPromise = closing.view.onClose();
  try {
    expect(plugin.conversationOpenRegistry.owns(oldClaim)).toBe(true);
    const oldTab = await oldCreation;
    expect(oldTab).toBeNull();
    expect(oldManager.getTab('fixture-old-pending')).toBeNull();
    expect(plugin.conversationOpenRegistry.owns(oldClaim)).toBe(true);
    expect(register.mock.calls.some(([id]) => id === 'fixture-old-pending')).toBe(false);
    jest.advanceTimersByTime(5000);
    expect(logRows()).toEqual([]);

    persistence.resolve();
    await closingPromise;
    expect(plugin.conversationOpenRegistry.owns(oldClaim)).toBe(false);
    const liveTab = await liveManager.createTab(FIRST_ID, 'fixture-live-owner', { activate: false });
    expect(liveTab?.conversationId).toBe(FIRST_ID);
    expect(plugin.conversationOpenRegistry.owns(liveTab!.conversationOpenClaim!)).toBe(true);
  } finally {
    persistence.resolve();
    await Promise.allSettled([oldCreation, closingPromise]);
  }
});

it('R1a: a restore already inside the manager stops before its next tab after close', async () => {
  await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  addConversation(SECOND_ID, HISTORY_BODY);
  const view = createFixtureView();
  jest.spyOn(plugin.storage, 'getTabManagerState').mockResolvedValueOnce({
    openTabs: [
      { tabId: 'fixture-first-restored', conversationId: FIRST_ID },
      { tabId: 'fixture-second-restored', conversationId: SECOND_ID },
    ],
    activeTabId: 'fixture-first-restored',
  });
  const opening = view.onOpen();
  const oldManager = view.getTabManager()!;
  const reached = deferred();
  const gate = deferred();
  const create = oldManager.createTab.bind(oldManager);
  jest.spyOn(oldManager, 'createTab').mockImplementation(async (...args) => {
    const result = await create(...args);
    if (args[1] === 'fixture-first-restored') {
      reached.resolve();
      await gate.promise;
    }
    return result;
  });
  try {
    await reached.promise;
    expect(oldManager.getTab('fixture-first-restored')?.conversationId).toBe(FIRST_ID);
    await view.onClose();
    await view.onOpen();
    const liveManager = view.getTabManager()!;
    await openConversation(view, FIRST_ID);
    const liveClaim = liveManager.getActiveTab()!.conversationOpenClaim!;

    gate.resolve();
    await opening;
    expect(oldManager.getTabCount()).toBe(0);
    expect(oldManager.getTab('fixture-second-restored')).toBeNull();
    expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
  } finally {
    gate.resolve();
    await opening.catch(() => undefined);
    await oldManager.destroy();
  }
});

it('R1a: an entered restore does not create a blank fallback after close', async () => {
  await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  const view = createFixtureView();
  jest.spyOn(plugin.storage, 'getTabManagerState').mockResolvedValueOnce({
    openTabs: [{ tabId: 'fixture-switch-restored', conversationId: FIRST_ID }],
    activeTabId: 'fixture-switch-restored',
  });
  const opening = view.onOpen();
  const oldManager = view.getTabManager()!;
  const reached = deferred();
  const gate = deferred();
  const switchTo = oldManager.switchToTab.bind(oldManager);
  jest.spyOn(oldManager, 'switchToTab').mockImplementation(async tabId => {
    await switchTo(tabId);
    reached.resolve();
    await gate.promise;
  });
  try {
    await reached.promise;
    await view.onClose();
    await view.onOpen();
    const liveManager = view.getTabManager()!;
    await openConversation(view, FIRST_ID);
    const liveClaim = liveManager.getActiveTab()!.conversationOpenClaim!;

    gate.resolve();
    await opening;
    expect(oldManager.getTabCount()).toBe(0);
    expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
  } finally {
    gate.resolve();
    await opening.catch(() => undefined);
    await oldManager.destroy();
  }
});

it('R1a: an entered activation does not return its destroyed tab', async () => {
  const { view } = await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  const oldManager = view.getTabManager()!;
  const reached = deferred();
  const gate = deferred();
  const switchTo = oldManager.switchToTab.bind(oldManager);
  jest.spyOn(oldManager, 'switchToTab').mockImplementation(async tabId => {
    await switchTo(tabId);
    reached.resolve();
    await gate.promise;
  });
  const creating = oldManager.createTab(FIRST_ID, 'fixture-activating-tab');
  try {
    await reached.promise;
    await view.onClose();
    await view.onOpen();
    const liveManager = view.getTabManager()!;
    await openConversation(view, FIRST_ID);
    const liveClaim = liveManager.getActiveTab()!.conversationOpenClaim!;

    gate.resolve();
    const created = await creating;
    expect(created).toBeNull();
    expect(oldManager.getTabCount()).toBe(0);
    expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
  } finally {
    gate.resolve();
    await creating.catch(() => null);
  }
});

it('R1a: an entered switch becomes a silent no-op after close', async () => {
  const { view, tab } = await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  const gate = deferred();
  const switchConversation = plugin.switchConversation.bind(plugin);
  const waiting = jest.spyOn(plugin, 'switchConversation').mockImplementationOnce(async id => {
    await gate.promise;
    return switchConversation(id);
  });
  const switching = view.getTabManager()!.openConversation(FIRST_ID);
  void switching.catch(() => undefined);
  try {
    await settle();
    expect(waiting).toHaveBeenCalledWith(FIRST_ID);
    await view.onClose();
    await view.onOpen();
    const liveManager = view.getTabManager()!;
    await openConversation(view, FIRST_ID);
    const live = liveManager.getActiveTab()!;
    const liveClaim = live.conversationOpenClaim!;
    expect(live.conversationId).toBe(FIRST_ID);

    const stateAtClose = tab.state.currentConversationId;
    gate.resolve();
    await expect(switching).resolves.toBeUndefined();
    expect(tab.state.currentConversationId).toBe(stateAtClose);
    expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
    expect(liveManager.getActiveTab()).toBe(live);
  } finally {
    gate.resolve();
    await switching.catch(() => undefined);
  }
});

async function observeExistingOpencodeSharedWrite() {
  const { view } = await openFixture();
  const conversation = addConversation(FIRST_ID, HISTORY_BODY);
  conversation.providerId = 'opencode';
  conversation.sessionId = 'fixture-opencode-session';
  conversation.messages = [];
  const oldMessage: ChatMessage = { id: 'fixture-old-history', role: 'user', content: 'old fixture', timestamp: 1 };
  const liveMessage: ChatMessage = { id: 'fixture-live-history', role: 'user', content: 'live fixture', timestamp: 2 };
  const gate = deferred();
  const load = jest.spyOn(opencodeHistoryStore, 'loadOpencodeSessionMessages')
    .mockImplementationOnce(async () => {
      await gate.promise;
      return [oldMessage];
    })
    .mockResolvedValue([liveMessage]);
  const switching = view.getTabManager()!.openConversation(FIRST_ID);
  void switching.catch(() => undefined);
  try {
    await settle();
    const oldReadCount = load.mock.calls.length;
    await view.onClose();
    await view.onOpen();
    await openConversation(view, FIRST_ID);
    const live = view.getActiveTab()!;
    const liveClaim = live.conversationOpenClaim!;
    const liveBefore = [...live.state.messages];
    const sharedBefore = [...conversation.messages];
    const readCount = load.mock.calls.length;

    gate.resolve();
    for (let index = 0; index < 3; index++) {
      await settle();
      paint();
    }
    const oldOutcome = await switching.then(() => 'fulfilled', () => 'rejected');
    return {
      oldMessage, liveMessage, oldReadCount, readCount, liveBefore, sharedBefore, oldOutcome,
      liveClaimOwned: plugin.conversationOpenRegistry.owns(liveClaim),
      sharedAfter: [...conversation.messages],
    };
  } finally {
    gate.resolve();
    await switching.catch(() => undefined);
  }
}

it('A/B: control reproduces the pre-existing OpenCode shared Conversation write', async () => {
  const observed = await observeExistingOpencodeSharedWrite();
  expect(observed.oldReadCount).toBe(1);
  expect(observed.readCount).toBe(2);
  expect(observed.liveBefore).toEqual([observed.liveMessage]);
  expect(observed.sharedBefore).toEqual([observed.liveMessage]);
  expect(observed.oldOutcome).toBe('fulfilled');
  expect(observed.liveClaimOwned).toBe(true);
  expect(observed.sharedAfter).toEqual([observed.oldMessage]);
});

it('A/B known baseline issue: late OpenCode history overwrites the live owner', async () => {
  const observed = await observeExistingOpencodeSharedWrite();
  expect(observed.sharedBefore).toEqual([observed.liveMessage]);
  expect(observed.sharedAfter).toEqual([observed.oldMessage]);
  expect(observed.sharedAfter).not.toEqual([observed.liveMessage]);
});

it.each(['save', 'service', 'projection', 'render drain'] as const)(
  'R1a: cancels an entered switch after close during %s',
  async phase => {
    const { view, tab } = await openFixture();
    addConversation(FIRST_ID, HISTORY_BODY);
    const controller = tab.controllers.conversationController!;
    const internals = controller as unknown as {
      deps: { ensureServiceForConversation: (conversation: Conversation | null) => Promise<void> };
      restoreConversation: (conversation: Conversation, page: unknown) => Promise<void>;
    };
    const gate = deferred();
    let reached = false;
    const updates = jest.spyOn(plugin, 'updateConversation');
    if (phase === 'save') {
      const save = controller.save.bind(controller);
      jest.spyOn(controller, 'save').mockImplementationOnce(async (...args) => {
        await save(...args);
        reached = true;
        await gate.promise;
      });
    } else if (phase === 'service') {
      const ensureService = internals.deps.ensureServiceForConversation.bind(internals.deps);
      jest.spyOn(internals.deps, 'ensureServiceForConversation').mockImplementationOnce(async conversation => {
        await ensureService(conversation);
        reached = true;
        await gate.promise;
      });
    } else if (phase === 'projection') {
      const restore = internals.restoreConversation.bind(controller);
      jest.spyOn(internals, 'restoreConversation').mockImplementationOnce(async (...args) => {
        await restore(...args);
        reached = true;
        await gate.promise;
      });
    } else {
      const waitForRendered = tab.renderer!.waitForRenderedMessages.bind(tab.renderer);
      jest.spyOn(tab.renderer!, 'waitForRenderedMessages').mockImplementationOnce(async () => {
        reached = true;
        await gate.promise;
        await waitForRendered();
      });
    }

    const switching = view.getTabManager()!.openConversation(FIRST_ID);
    void switching.catch(() => undefined);
    try {
      for (let index = 0; index < 3; index++) {
        await settle();
        paint();
      }
      expect(reached).toBe(true);
      await view.onClose();
      const stateAtClose = tab.state.currentConversationId;
      expect(updates.mock.calls.some(([id]) => id === FIRST_ID))
        .toBe(phase === 'projection' || phase === 'render drain');
      await view.onOpen();
      const liveManager = view.getTabManager()!;
      await openConversation(view, FIRST_ID);
      const live = liveManager.getActiveTab()!;
      const liveClaim = live.conversationOpenClaim!;
      expect(live.conversationId).toBe(FIRST_ID);

      gate.resolve();
      paint();
      const outcome = await switching.then(() => 'resolved', error => (error as Error).message);
      expect(outcome).toBe('resolved');
      expect(stateAtClose).toBe(phase === 'save' || phase === 'service' ? null : FIRST_ID);
      expect(tab.state.currentConversationId).toBe(stateAtClose);
      expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
      expect(liveManager.getActiveTab()).toBe(live);
    } finally {
      gate.resolve();
      paint();
      await switching.catch(() => undefined);
    }
  },
);

it.each(['index ready', 'window read', 'metadata save', 'projection'] as const)(
  'R1a: preserves indexed-history lease ownership and accepted saves during %s',
  async phase => {
    const { view, tab } = await openFixture();
    addConversation(FIRST_ID, HISTORY_BODY);
    const controller = tab.controllers.conversationController!;
    const internals = controller as unknown as {
      deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
      restoreConversation: (conversation: Conversation, page: unknown) => Promise<void>;
    };
    const gate = deferred();
    let reached = false;
    const release = jest.fn();
    const page = {
      messages: [{ id: 'fixture-indexed-message', role: 'user', content: HISTORY_BODY, timestamp: 1 }],
      range: { start: 0, end: 1 }, snapshotOffset: 1, sourceBytes: 1, projectedChars: HISTORY_BODY.length,
      oversizedTurnCount: 0, pageKey: 'fixture-indexed-page', hasMoreBefore: false, hasMoreAfter: false,
    };
    const lease = {
      conversationId: FIRST_ID,
      totalTurns: 1,
      ready: phase === 'index ready' ? gate.promise : Promise.resolve(),
      planWindow: () => ({ start: 0, end: 1 }),
      loadWindow: async () => {
        if (phase === 'window read') {
          reached = true;
          await gate.promise;
        }
        return page;
      },
      release,
    } as unknown as HistoryIndexLease;
    const service = {
      acquireHistoryIndex: () => {
        if (phase === 'index ready') reached = true;
        return lease;
      },
    } as unknown as ProviderConversationHistoryService;
    jest.spyOn(internals.deps, 'getHistoryIndexCapableService').mockReturnValue(service);
    if (phase === 'metadata save') {
      const update = plugin.updateConversation.bind(plugin);
      jest.spyOn(plugin, 'updateConversation').mockImplementationOnce(async (...args) => {
        await update(...args);
        reached = true;
        await gate.promise;
      });
    } else if (phase === 'projection') {
      const restore = internals.restoreConversation.bind(controller);
      jest.spyOn(internals, 'restoreConversation').mockImplementationOnce(async (...args) => {
        await restore(...args);
        reached = true;
        await gate.promise;
      });
    }

    const switching = view.getTabManager()!.openConversation(FIRST_ID);
    void switching.catch(() => undefined);
    try {
      for (let index = 0; index < 3; index++) {
        await settle();
        paint();
      }
      expect(reached).toBe(true);
      const closing = view.onClose();
      let closedBeforeGate: boolean | undefined;
      if (phase === 'metadata save') {
        let closed = false;
        void closing.then(() => { closed = true; });
        await settle();
        closedBeforeGate = closed;
        gate.resolve();
      }
      expect(closedBeforeGate).toBe(phase === 'metadata save' ? false : undefined);
      await closing;
      await view.onOpen();
      await openConversation(view, FIRST_ID);
      const live = view.getActiveTab()!;
      const liveClaim = live.conversationOpenClaim!;
      expect(live.conversationId).toBe(FIRST_ID);

      gate.resolve();
      paint();
      await expect(switching).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledTimes(1);
      expect(tab.state.historyLease).toBeNull();
      expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
    } finally {
      gate.resolve();
      paint();
      await switching.catch(() => undefined);
      if (tab.state.historyLease === lease) {
        lease.release();
        tab.state.historyLease = null;
      }
    }
  },
);

it('A/B: preserves outgoing and READY incoming saves across an uncommitted switch', async () => {
  const { view, tab } = await openFixture();
  addConversation(FIRST_ID, 'fixture outgoing history');
  addConversation(SECOND_ID, HISTORY_BODY);
  await openConversation(view, FIRST_ID);
  const controller = tab.controllers.conversationController!;
  const internals = controller as unknown as {
    restoreConversation: (conversation: Conversation, page: unknown) => Promise<void>;
  };
  const gate = deferred();
  const restore = internals.restoreConversation.bind(controller);
  let reached = false;
  jest.spyOn(internals, 'restoreConversation').mockImplementationOnce(async (...args) => {
    await restore(...args);
    reached = true;
    await gate.promise;
  });
  const updates = jest.spyOn(plugin, 'updateConversation');
  const switching = view.getTabManager()!.openConversation(SECOND_ID);
  void switching.catch(() => undefined);
  try {
    await settle();
    expect(reached).toBe(true);
    await view.onClose();
    expect(updates.mock.calls.filter(([id]) => id === FIRST_ID)).toHaveLength(1);
    expect(updates.mock.calls.filter(([id]) => id === SECOND_ID)).toHaveLength(1);
    await view.onOpen();
    await openConversation(view, FIRST_ID);
    const liveManager = view.getTabManager()!;
    const outgoingClaim = liveManager.getActiveTab()!.conversationOpenClaim!;
    const incoming = await liveManager.createTab(SECOND_ID, 'fixture-live-incoming', { activate: false });
    expect(incoming?.conversationId).toBe(SECOND_ID);

    gate.resolve();
    await expect(switching).resolves.toBeUndefined();
    expect(updates.mock.calls.filter(([id]) => id === SECOND_ID)).toHaveLength(1);
    expect(plugin.conversationOpenRegistry.owns(outgoingClaim)).toBe(true);
    expect(plugin.conversationOpenRegistry.owns(incoming!.conversationOpenClaim!)).toBe(true);
  } finally {
    gate.resolve();
    await switching.catch(() => undefined);
  }
});

it('A/B: a closing uncommitted switch remains the cross-view owner until destroy', async () => {
  const closing = await openFixture();
  const live = await openAdditionalView();
  addConversation(FIRST_ID, HISTORY_BODY);
  const reveal = jest.fn();
  (plugin.app.workspace as unknown as { revealLeaf: jest.Mock }).revealLeaf = reveal;
  const internals = closing.tab.controllers.conversationController as unknown as {
    deps: { ensureServiceForConversation: (conversation: Conversation | null) => Promise<void> };
  };
  const ensureService = internals.deps.ensureServiceForConversation.bind(internals.deps);
  const gate = deferred();
  const persistence = deferred();
  let reached = false;
  jest.spyOn(internals.deps, 'ensureServiceForConversation').mockImplementationOnce(async conversation => {
    await ensureService(conversation);
    reached = true;
    await gate.promise;
  });
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const switching = closing.view.getTabManager()!.openConversation(FIRST_ID);
  void switching.catch(() => undefined);
  await settle();
  expect(reached).toBe(true);
  expect(closing.tab.conversationId).toBe(FIRST_ID);
  expect(closing.tab.conversationOpenClaim).toBeNull();
  const closePromise = closing.view.onClose();
  try {
    await openConversation(live.view, FIRST_ID);
    expect(reveal).not.toHaveBeenCalled();
    expect(live.tab.conversationId).toBeNull();
    expect(live.tab.conversationOpenClaim).toBeNull();

    persistence.resolve();
    await closePromise;
    await openConversation(live.view, FIRST_ID);
    const liveClaim = live.tab.conversationOpenClaim!;
    expect(live.tab.conversationId).toBe(FIRST_ID);
    gate.resolve();
    await expect(switching).resolves.toBeUndefined();
    expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
  } finally {
    gate.resolve();
    persistence.resolve();
    await Promise.allSettled([switching, closePromise]);
  }
});

it.each(['read', 'service'] as const)(
  'R1a: an entered hydration cannot publish after close starts during %s',
  async phase => {
    await openFixture();
    addConversation(FIRST_ID, HISTORY_BODY);
    const view = createFixtureView();
    jest.spyOn(plugin.storage, 'getTabManagerState').mockResolvedValueOnce({
      openTabs: [{ tabId: 'fixture-hydrating-tab', conversationId: FIRST_ID }],
      activeTabId: 'fixture-hydrating-tab',
    });
    await view.onOpen();
    const oldManager = view.getTabManager()!;
    const oldTab = oldManager.getActiveTab()!;
    const gate = deferred();
    const persistence = deferred();
    let reached = false;
    if (phase === 'read') {
      const read = plugin.getConversationById.bind(plugin);
      jest.spyOn(plugin, 'getConversationById').mockImplementationOnce(async id => {
        reached = true;
        await gate.promise;
        return read(id);
      });
    } else {
      const internals = oldTab.controllers.conversationController as unknown as {
        deps: { ensureServiceForConversation: (conversation: Conversation | null) => Promise<void> };
      };
      const ensureService = internals.deps.ensureServiceForConversation.bind(internals.deps);
      jest.spyOn(internals.deps, 'ensureServiceForConversation').mockImplementationOnce(async conversation => {
        await ensureService(conversation);
        reached = true;
        await gate.promise;
      });
    }
    jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
    paint();
    jest.advanceTimersByTime(0);
    await settle();
    expect(reached).toBe(true);
    const closing = view.onClose();
    try {
      gate.resolve();
      await settle();
      paint();
      await settle();
      expect(oldTab.state.messages.map(message => message.content)).not.toContain(HISTORY_BODY);
      expect(oldTab.dom.messagesEl.textContent).not.toContain(HISTORY_BODY);
      expect(oldTab.hydrationState).not.toBe('READY');
      jest.advanceTimersByTime(5000);
      expect(logRows()).toEqual([]);

      persistence.resolve();
      await closing;
      await view.onOpen();
      await openConversation(view, FIRST_ID);
      const live = view.getActiveTab()!;
      expect(live.conversationId).toBe(FIRST_ID);
      expect(plugin.conversationOpenRegistry.owns(live.conversationOpenClaim!)).toBe(true);
    } finally {
      gate.resolve();
      persistence.resolve();
      await closing;
    }
  },
);

it.each(['sync throw', 'rejection'] as const)(
  'R1a hydration: active %s keeps its ERROR shell and retry without a Notice',
  async mode => {
    const { view, tab } = await openHydrationFixture();
    const runtime = createFixtureRuntime();
    jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
    const failure = new Error('fixture active read failure');
    jest.spyOn(plugin, 'getConversationById').mockImplementationOnce(() => {
      if (mode === 'sync throw') throw failure;
      return Promise.reject(failure);
    });
    (Notice as jest.Mock).mockClear();
    paint();
    jest.advanceTimersByTime(0);
    await settle();
    expect(tab.hydrationState).toBe('ERROR');
    expect(tab.dom.messagesEl.textContent).toContain(failure.message);
    expect(Notice).not.toHaveBeenCalled();
    const retry = tab.dom.messagesEl.querySelector('button');
    expect(retry).not.toBeNull();
    retry!.click();
    paint();
    jest.advanceTimersByTime(0);
    for (let index = 0; index < 3; index++) {
      await settle();
      paint();
    }
    expect(view.getActiveTab()).toBe(tab);
    expect(tab.hydrationState).toBe('READY');
    expect(Notice).not.toHaveBeenCalled();
  },
);

it('R1a hydration: a synchronous LOADING placeholder failure retains the active retry shell', async () => {
  const { tab } = await openHydrationFixture();
  const failure = new Error('fixture loading placeholder failure');
  jest.spyOn(tab.dom.messagesEl, 'empty').mockImplementationOnce(() => { throw failure; });
  (Notice as jest.Mock).mockClear();
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(tab.hydrationState).toBe('ERROR');
  expect(tab.dom.messagesEl.textContent).toContain(failure.message);
  expect(tab.dom.messagesEl.querySelector('button')).not.toBeNull();
  expect(Notice).not.toHaveBeenCalled();
});

it('R1a hydration: a failed ERROR placeholder reaches the generic terminal once', async () => {
  const { manager, tab } = await openHydrationFixture();
  const terminal = jest.spyOn(manager as unknown as { reportHydrationFailure: (error: unknown) => void }, 'reportHydrationFailure');
  const failure = new Error('fixture original hydration failure');
  const placeholderFailure = new Error('fixture error placeholder failure');
  jest.spyOn(plugin, 'getConversationById').mockRejectedValueOnce(failure);
  const empty = tab.dom.messagesEl.empty.bind(tab.dom.messagesEl);
  jest.spyOn(tab.dom.messagesEl, 'empty').mockImplementation(() => {
    if (tab.hydrationState === 'ERROR') throw placeholderFailure;
    empty();
  });
  (Notice as jest.Mock).mockClear();
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(Notice).toHaveBeenCalledTimes(1);
  expect(Notice).toHaveBeenCalledWith(t('chat.history.errorTitle'));
  expect((Notice as jest.Mock).mock.calls[0][0]).not.toContain(failure.message);
  expect((Notice as jest.Mock).mock.calls[0][0]).not.toContain(placeholderFailure.message);
  expect(terminal).toHaveBeenCalledTimes(1);
  const reported = terminal.mock.calls[0][0] as AggregateError;
  expect(reported).toBeInstanceOf(AggregateError);
  expect(reported.errors).toEqual([failure, placeholderFailure]);
});

it('R1a hydration: a superseded read failure cannot paint either tab and reports once', async () => {
  const { view, manager, tab } = await openHydrationFixture();
  addConversation(SECOND_ID, 'fixture replacement conversation');
  const runtime = createFixtureRuntime();
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  let rejectRead!: (error: Error) => void;
  const read = new Promise<Conversation | null>((_resolve, reject) => { rejectRead = reject; });
  jest.spyOn(plugin, 'getConversationById').mockImplementationOnce(() => read);
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  const live = await manager.createTab(SECOND_ID, 'fixture-live-hydration');
  expect(live).not.toBeNull();
  paint();
  jest.advanceTimersByTime(0);
  for (let index = 0; index < 3; index++) {
    await settle();
    paint();
  }
  expect(live!.hydrationState).toBe('READY');
  expect(view.getActiveTab()).toBe(live);
  (Notice as jest.Mock).mockClear();
  rejectRead(new Error('fixture superseded hydration failure'));
  await settle();
  expect(Notice).toHaveBeenCalledTimes(1);
  expect(Notice).toHaveBeenCalledWith(t('chat.history.errorTitle'));
  expect(tab.hydrationState).not.toBe('ERROR');
  expect(live!.hydrationState).toBe('READY');
  expect(live!.dom.messagesEl.textContent).toContain('fixture replacement conversation');
});

it('R1a hydration: stale runtime cleanup failure does not hide the original failure', async () => {
  const { manager, tab } = await openHydrationFixture();
  const terminal = jest.spyOn(manager as unknown as { reportHydrationFailure: (error: unknown) => void }, 'reportHydrationFailure');
  const runtime = createFixtureRuntime();
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  let rejectDrain!: (error: Error) => void;
  const drain = new Promise<void>((_resolve, reject) => { rejectDrain = reject; });
  jest.spyOn(tab.renderer!, 'waitForRenderedMessages').mockImplementationOnce(() => drain);
  paint();
  jest.advanceTimersByTime(0);
  for (let index = 0; index < 3; index++) {
    await settle();
    paint();
  }
  expect(tab.service).toBe(runtime);
  const live = await manager.createTab();
  expect(live).not.toBeNull();
  const original = new Error('fixture hydration drain failure');
  const cleanup = new Error('fixture stale runtime cleanup failure');
  runtime.cleanup.mockImplementationOnce(() => { throw cleanup; });
  (Notice as jest.Mock).mockClear();
  rejectDrain(original);
  await settle();
  expect(Notice).toHaveBeenCalledTimes(1);
  expect(Notice).toHaveBeenCalledWith(t('chat.history.errorTitle'));
  expect(terminal).toHaveBeenCalledTimes(1);
  const reported = terminal.mock.calls[0][0] as AggregateError;
  expect(reported).toBeInstanceOf(AggregateError);
  expect(reported.errors).toEqual([original, cleanup]);
  expect(tab.hydrationState).not.toBe('ERROR');
  expect(live!.hydrationState).not.toBe('ERROR');
});

it('R1a race: a superseded hydration failure must not clean the runtime installed after switching back', async () => {
  const { view, manager, tab } = await openHydrationFixture();
  const runtime = createFixtureRuntime();
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  let rejectOldRead!: (error: Error) => void;
  let oldReadEntered = false;
  const oldRead = new Promise<Conversation | null>((_resolve, reject) => { rejectOldRead = reject; });
  jest.spyOn(plugin, 'getConversationById').mockImplementationOnce(() => {
    oldReadEntered = true;
    return oldRead;
  });

  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(oldReadEntered).toBe(true);
  expect(tab.hydrationState).toBe('LOADING');
  const oldGeneration = tab.hydrationGeneration;
  const other = await manager.createTab();
  expect(other).not.toBeNull();
  expect(view.getActiveTab()).toBe(other);
  await manager.switchToTab(tab.id);
  expect(tab.hydrationGeneration).toBeGreaterThan(oldGeneration);
  paint();
  jest.advanceTimersByTime(0);
  for (let index = 0; index < 3; index++) {
    await settle();
    paint();
  }
  expect(view.getActiveTab()).toBe(tab);
  expect(tab.hydrationState).toBe('READY');
  expect(tab.service).toBe(runtime);
  expect(runtime.cleanup).not.toHaveBeenCalled();
  const claim = tab.conversationOpenClaim!;
  expect(plugin.conversationOpenRegistry.owns(claim)).toBe(true);

  (Notice as jest.Mock).mockClear();
  rejectOldRead(new Error('fixture superseded read failure'));
  await settle();
  expect(Notice).toHaveBeenCalledTimes(1);
  expect({
    cleanupCalls: runtime.cleanup.mock.calls.length,
    runtimeStillInstalled: Object.is(tab.service, runtime),
    hydrationState: tab.hydrationState,
    claimOwned: plugin.conversationOpenRegistry.owns(claim),
  }).toEqual({ cleanupCalls: 0, runtimeStillInstalled: true, hydrationState: 'READY', claimOwned: true });
});

it('R1a race: a superseded hydration must not clean a runtime reused by the new attempt', async () => {
  const { view, manager, tab } = await openHydrationFixture();
  const runtime = { ...createFixtureRuntime(), setHistoryRecoverySource: jest.fn() };
  const historyService = { iterateFullHistory: jest.fn() } as unknown as ProviderConversationHistoryService;
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue(historyService);
  const createRuntime = jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  let rejectOldDrain!: (error: Error) => void;
  const oldDrain = new Promise<void>((_resolve, reject) => { rejectOldDrain = reject; });
  jest.spyOn(tab.renderer!, 'waitForRenderedMessages').mockImplementationOnce(() => oldDrain);

  paint();
  jest.advanceTimersByTime(0);
  for (let index = 0; index < 3; index++) {
    await settle();
    paint();
  }
  expect(tab.service).toBe(runtime);
  expect(tab.hydrationState).toBe('LOADING');
  const oldGeneration = tab.hydrationGeneration;
  const other = await manager.createTab();
  expect(other).not.toBeNull();
  await manager.switchToTab(tab.id);
  expect(tab.hydrationGeneration).toBeGreaterThan(oldGeneration);
  paint();
  jest.advanceTimersByTime(0);
  for (let index = 0; index < 3; index++) {
    await settle();
    paint();
  }
  expect(view.getActiveTab()).toBe(tab);
  expect(tab.hydrationState).toBe('READY');
  expect(tab.service).toBe(runtime);
  expect(createRuntime).toHaveBeenCalledTimes(1);
  expect(runtime.setHistoryRecoverySource).toHaveBeenLastCalledWith(expect.any(Function));
  runtime.setHistoryRecoverySource.mockClear();

  (Notice as jest.Mock).mockClear();
  rejectOldDrain(new Error('fixture superseded render drain failure'));
  await settle();
  expect(Notice).toHaveBeenCalledTimes(1);
  expect({
    cleanupCalls: runtime.cleanup.mock.calls.length,
    recoverySourceCalls: runtime.setHistoryRecoverySource.mock.calls,
    runtimeStillInstalled: Object.is(tab.service, runtime),
    hydrationState: tab.hydrationState,
  }).toEqual({ cleanupCalls: 0, recoverySourceCalls: [], runtimeStillInstalled: true, hydrationState: 'READY' });
});

it('R1a race: old lease progress must not repaint a newer loading attempt on the same tab', async () => {
  const { view, manager, tab, conversation } = await openHydrationFixture();
  conversation.hasHistory = true;
  const runtime = createFixtureRuntime();
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  const oldReady = deferred();
  const newReady = deferred();
  const page = {
    messages: [{ id: 'fixture-progress-message', role: 'user' as const, content: HISTORY_BODY, timestamp: 1 }],
    range: { start: 0, end: 1 }, snapshotOffset: 1, sourceBytes: 1, projectedChars: HISTORY_BODY.length,
    oversizedTurnCount: 0, pageKey: 'fixture-progress-page', hasMoreBefore: false, hasMoreAfter: false,
  };
  const makeLease = (ready: Promise<void>): HistoryIndexLease => ({
    conversationId: FIRST_ID,
    totalTurns: 1,
    ready,
    planWindow: () => ({ start: 0, end: 1 }),
    loadWindow: async () => page,
    release: jest.fn(),
  } as unknown as HistoryIndexLease);
  const leases = [makeLease(oldReady.promise), makeLease(newReady.promise)];
  const progress: Array<(value: HistoryLoadProgress) => void> = [];
  const service = {
    acquireHistoryIndex: (_conversation: Conversation, _vaultPath: string | null, onProgress: (value: HistoryLoadProgress) => void) => {
      progress.push(onProgress);
      return leases[progress.length - 1];
    },
  } as unknown as ProviderConversationHistoryService;
  const controller = tab.controllers.conversationController! as unknown as {
    deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
  };
  jest.spyOn(controller.deps, 'getHistoryIndexCapableService').mockReturnValue(service);

  try {
    paint();
    jest.advanceTimersByTime(0);
    await settle();
    expect(progress).toHaveLength(1);
    expect(tab.hydrationState).toBe('LOADING');
    const oldGeneration = tab.hydrationGeneration;
    const other = await manager.createTab();
    expect(other).not.toBeNull();
    await manager.switchToTab(tab.id);
    expect(tab.hydrationGeneration).toBeGreaterThan(oldGeneration);
    paint();
    jest.advanceTimersByTime(0);
    await settle();
    expect(view.getActiveTab()).toBe(tab);
    expect(tab.hydrationState).toBe('LOADING');
    expect(progress).toHaveLength(2);
    progress[1]({ phase: 'indexing', percent: 37 });
    expect(tab.historyLoadProgress).toEqual({ phase: 'indexing', percent: 37 });
    const newPlaceholder = tab.dom.messagesEl.textContent;
    expect(newPlaceholder).toContain('37');

    progress[0]({ phase: 'indexing', percent: 91 });
    expect({ progress: tab.historyLoadProgress, placeholder: tab.dom.messagesEl.textContent }).toEqual({
      progress: { phase: 'indexing', percent: 37 }, placeholder: newPlaceholder,
    });
  } finally {
    oldReady.resolve();
    newReady.resolve();
    for (let index = 0; index < 3; index++) {
      await settle();
      paint();
    }
  }
});

it('R1a characterization: same-source overlapping hydration leases receive one real index progress stream', async () => {
  const { manager, tab, conversation } = await openHydrationFixture();
  conversation.providerId = 'claude';
  conversation.sessionId = 'fixture-shared-progress-session';
  conversation.hasHistory = true;
  const transcript = join(directory, `${conversation.sessionId}.jsonl`);
  const rows = [
    { type: 'user', uuid: 'fixture-shared-progress-user', message: { role: 'user', content: 'fixture shared history question' } },
    { type: 'assistant', uuid: 'fixture-shared-progress-assistant', parentUuid: 'fixture-shared-progress-user', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture shared history answer' }] } },
  ];
  writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockImplementation((_vault, sessionId) => join(directory, `${sessionId}.jsonl`));
  const runtime = { ...createFixtureRuntime(), providerId: 'claude', getCapabilities: () => CLAUDE_PROVIDER_CAPABILITIES };
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  const service = new ClaudeConversationHistoryService();
  const getHistoryService = ProviderRegistry.getConversationHistoryService.bind(ProviderRegistry);
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
    .mockImplementation(providerId => providerId === 'claude' ? service : getHistoryService(providerId));
  const build = jest.spyOn(transcriptHistoryIndex, 'buildTranscriptIndex');
  const fsPromises = jest.requireActual<typeof NodeFsPromises>('fs/promises');
  const stat = fsPromises.stat;
  const gate = deferred();
  let statEntered = false;
  jest.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
    if (!statEntered && args[0] === transcript) {
      statEntered = true;
      await gate.promise;
    }
    return stat(...args);
  });
  const leases: HistoryIndexLease[] = [];
  const progress: Array<{ attempt: number; value: HistoryLoadProgress; visible: HistoryLoadProgress | null; placeholder: string | null }> = [];
  const acquireIndex = service.acquireHistoryIndex.bind(service);
  const acquire = jest.spyOn(service, 'acquireHistoryIndex').mockImplementation((source, vaultPath, onProgress, forceNewSnapshot) => {
    const attempt = leases.length + 1;
    const lease = acquireIndex(source, vaultPath, event => {
      onProgress?.(event);
      progress.push({
        attempt, value: { ...event }, visible: tab.historyLoadProgress ? { ...tab.historyLoadProgress } : null,
        placeholder: tab.dom.messagesEl.textContent,
      });
    }, forceNewSnapshot);
    leases.push(lease);
    return lease;
  });
  try {
    paint();
    jest.advanceTimersByTime(0);
    await waitForFixture(() => statEntered && leases.length === 1, 'first real shared index stat');
    expect(tab.hydrationState).toBe('LOADING');
    expect(progress.map(item => [item.attempt, item.value.phase])).toEqual([[1, 'queued']]);
    expect(build).toHaveBeenCalledTimes(1);
    const oldGeneration = tab.hydrationGeneration;
    const other = await manager.createTab();
    expect(other).not.toBeNull();
    await manager.switchToTab(tab.id);
    expect(tab.hydrationGeneration).toBeGreaterThan(oldGeneration);
    paint();
    jest.advanceTimersByTime(0);
    await waitForFixture(() => leases.length === 2, 'second real shared index lease');
    expect(tab.hydrationState).toBe('LOADING');
    expect(leases[0]).not.toBe(leases[1]);
    expect(leases[0].ready).not.toBe(leases[1].ready);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitForFixture(() => tab.hydrationState === 'READY' || tab.hydrationState === 'ERROR', 'shared-index hydration completion');
    await Promise.all(leases.map(lease => lease.ready));
    expect(tab.hydrationState).toBe('READY');
    expect(build).toHaveBeenCalledTimes(1);
    const indexing = progress.filter((item): item is typeof item & { value: Extract<HistoryLoadProgress, { phase: 'indexing' }> } => item.value.phase === 'indexing');
    const firstProgress = indexing.filter(item => item.attempt === 1).map(item => item.value);
    const secondProgress = indexing.filter(item => item.attempt === 2).map(item => item.value);
    expect(firstProgress.length).toBeGreaterThan(0);
    expect(secondProgress).toEqual(firstProgress);
    expect(indexing.map(item => item.attempt)).toEqual(firstProgress.flatMap(() => [1, 2]));
    for (const item of indexing.filter(event => event.attempt === 2)) {
      expect(item.visible).toEqual(item.value);
      expect(item.placeholder).toContain(String(item.value.percent));
    }
    expect(tab.state.messages.map(message => message.id)).toContain('fixture-shared-progress-user');
  } finally {
    gate.resolve();
    await Promise.allSettled(leases.map(lease => lease.ready));
    for (let index = 0; index < 3; index++) {
      await settle();
      paint();
    }
    transcriptHistoryIndex.setTranscriptIndexDiagnosticSink(null);
  }
});

it('R1a: a superseded real index source cannot publish progress into the next hydration', async () => {
  const { manager, tab, conversation } = await openHydrationFixture();
  conversation.providerId = 'claude';
  conversation.sessionId = 'fixture-old-progress-source';
  conversation.hasHistory = true;
  const oldPath = join(directory, 'fixture-old-progress-source.jsonl');
  const newPath = join(directory, 'fixture-new-progress-source.jsonl');
  for (const [path, id] of [[oldPath, 'fixture-old-source'], [newPath, 'fixture-new-source']]) {
    const rows = [
      { type: 'user', uuid: `${id}-user`, message: { role: 'user', content: `${id} question` } },
      { type: 'assistant', uuid: `${id}-assistant`, parentUuid: `${id}-user`, message: { role: 'assistant', content: [{ type: 'text', text: `${id} answer` }] } },
    ];
    writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  }
  jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockImplementation((_vault, sessionId) => join(directory, `${sessionId}.jsonl`));
  const runtime = { ...createFixtureRuntime(), providerId: 'claude', getCapabilities: () => CLAUDE_PROVIDER_CAPABILITIES };
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  const service = new ClaudeConversationHistoryService();
  const getHistoryService = ProviderRegistry.getConversationHistoryService.bind(ProviderRegistry);
  jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
    .mockImplementation(providerId => providerId === 'claude' ? service : getHistoryService(providerId));
  const build = jest.spyOn(transcriptHistoryIndex, 'buildTranscriptIndex');
  const fsPromises = jest.requireActual<typeof NodeFsPromises>('fs/promises');
  const stat = fsPromises.stat;
  const oldGate = deferred();
  const newGate = deferred();
  const entered = new Set<string>();
  jest.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
    const path = String(args[0]);
    if ((path === oldPath || path === newPath) && !entered.has(path)) {
      entered.add(path);
      await (path === oldPath ? oldGate.promise : newGate.promise);
    }
    return stat(...args);
  });
  const leases: HistoryIndexLease[] = [];
  const progress: Array<{
    attempt: number; value: HistoryLoadProgress;
    before: HistoryLoadProgress | null; after: HistoryLoadProgress | null;
    beforeDom: string | null; afterDom: string | null;
  }> = [];
  const acquireIndex = service.acquireHistoryIndex.bind(service);
  jest.spyOn(service, 'acquireHistoryIndex').mockImplementation((source, vaultPath, onProgress, forceNewSnapshot) => {
    const attempt = leases.length + 1;
    const lease = acquireIndex(source, vaultPath, value => {
      const before = tab.historyLoadProgress ? { ...tab.historyLoadProgress } : null;
      const beforeDom = tab.dom.messagesEl.textContent;
      onProgress?.(value);
      progress.push({
        attempt, value: { ...value }, before, after: tab.historyLoadProgress ? { ...tab.historyLoadProgress } : null,
        beforeDom, afterDom: tab.dom.messagesEl.textContent,
      });
    }, forceNewSnapshot);
    leases.push(lease);
    return lease;
  });
  try {
    paint();
    jest.advanceTimersByTime(0);
    await waitForFixture(() => entered.has(oldPath) && leases.length === 1, 'old real index source');
    await plugin.updateConversation(FIRST_ID, { sessionId: 'fixture-new-progress-source' });
    const oldGeneration = tab.hydrationGeneration;
    const other = await manager.createTab();
    expect(other).not.toBeNull();
    await manager.switchToTab(tab.id);
    expect(tab.hydrationGeneration).toBeGreaterThan(oldGeneration);
    paint();
    jest.advanceTimersByTime(0);
    await waitForFixture(() => entered.has(newPath) && leases.length === 2, 'new real index source');
    expect(build.mock.calls.map(([path]) => path)).toEqual([oldPath, newPath]);
    expect(tab.hydrationState).toBe('LOADING');
    expect(tab.historyLoadProgress).toEqual({ phase: 'queued' });
    expect(progress.map(item => [item.attempt, item.value.phase])).toEqual([[1, 'queued'], [2, 'queued']]);
    const queuedPlaceholder = tab.dom.messagesEl.textContent;
    let newLeaseSettled = false;
    void leases[1].ready.then(() => { newLeaseSettled = true; }, () => { newLeaseSettled = true; });

    oldGate.resolve();
    await waitForFixture(() => progress.some(item => item.attempt === 1 && item.value.phase === 'indexing'), 'old source progress');
    const stale = progress.find(item => item.attempt === 1 && item.value.phase === 'indexing');
    if (!stale) throw new Error('old source did not report indexing progress');
    expect(newLeaseSettled).toBe(false);
    expect(stale.before).toEqual({ phase: 'queued' });
    expect(stale.beforeDom).toBe(queuedPlaceholder);

    newGate.resolve();
    await waitForFixture(() => tab.hydrationState === 'READY' || tab.hydrationState === 'ERROR', 'new source hydration completion');
    await Promise.all(leases.map(lease => lease.ready));
    expect(tab.hydrationState).toBe('READY');
    expect(progress.some(item => item.attempt === 2 && item.value.phase === 'indexing')).toBe(true);
    expect(tab.state.messages.map(message => message.id)).toContain('fixture-new-source-user');
    expect(tab.state.messages.map(message => message.id)).not.toContain('fixture-old-source-user');
    expect({ progress: stale.after, placeholder: stale.afterDom }).toEqual({
      progress: stale.before, placeholder: stale.beforeDom,
    });
  } finally {
    oldGate.resolve();
    newGate.resolve();
    await Promise.allSettled(leases.map(lease => lease.ready));
    for (let index = 0; index < 3; index++) {
      await settle();
      paint();
    }
    transcriptHistoryIndex.setTranscriptIndexDiagnosticSink(null);
  }
});

it.each(['same attempt', 'new attempt'] as const)(
  'R1a release characterization: paging after failure in the %s',
  async attempt => {
    const { view, manager, tab, conversation } = await openHydrationFixture();
    conversation.hasHistory = true;
    const runtime = createFixtureRuntime();
    jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
    const drain = deferred();
    jest.spyOn(tab.renderer!, 'waitForRenderedMessages').mockImplementationOnce(() => drain.promise);

    const makeLease = (name: string) => ({
      conversationId: FIRST_ID,
      totalTurns: 3,
      ready: Promise.resolve(),
      planWindow: jest.fn(() => ({ start: 2, end: 3 })),
      loadWindow: jest.fn(async ({ anchorTurn }: { anchorTurn: number }) => {
        const start = anchorTurn - 1;
        if (start < 0 || start > 2) throw new Error('Unexpected fixture page anchor');
        const content = `${name}-turn-${start}`;
        return {
          messages: [{ id: content, role: 'user' as const, content, timestamp: start + 1 }],
          range: { start, end: anchorTurn }, snapshotOffset: 1, sourceBytes: 1,
          projectedChars: content.length, oversizedTurnCount: 0, pageKey: `${name}-${start}`,
          hasMoreBefore: start > 0, hasMoreAfter: anchorTurn < 3,
        };
      }),
      release: jest.fn(),
    });
    const installedLease = makeLease('installed');
    const retryLease = makeLease('retry');
    let rejectReady!: (error: Error) => void;
    const failedReady = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
    const readFailure = new Error('fixture paginated lease read failure');
    const releaseFailure = new Error('fixture paginated lease release failure');
    const failedLease = {
      conversationId: FIRST_ID,
      totalTurns: 3,
      ready: failedReady,
      release: jest.fn(() => { throw releaseFailure; }),
    };
    const acquire = jest.fn()
      .mockReturnValueOnce(installedLease)
      .mockReturnValueOnce(failedLease)
      .mockReturnValueOnce(retryLease);
    const controller = tab.controllers.conversationController!;
    const internals = controller as unknown as {
      deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
    };
    jest.spyOn(internals.deps, 'getHistoryIndexCapableService').mockReturnValue({
      acquireHistoryIndex: acquire,
    } as unknown as ProviderConversationHistoryService);

    try {
      paint();
      jest.advanceTimersByTime(0);
      for (let index = 0; index < 3; index++) {
        await settle();
        paint();
      }
      expect(tab.hydrationState).toBe('LOADING');
      expect(tab.state.historyLease).toBe(installedLease);
      expect(tab.state.historyLoading).toBe(false);
      expect(tab.state.loadedRanges).toEqual([{ start: 2, end: 3 }]);
      const initialPager = tab.dom.messagesEl.querySelector<HTMLButtonElement>('.claudian-history-pager button');
      expect(initialPager?.disabled).toBe(false);
      initialPager!.click();
      for (let index = 0; index < 3; index++) {
        await settle();
        paint();
      }
      expect(installedLease.loadWindow).toHaveBeenCalledTimes(2);
      expect(installedLease.loadWindow).toHaveBeenLastCalledWith(expect.objectContaining({ anchorTurn: 2 }));
      expect(tab.state.loadedRanges).toEqual([{ start: 1, end: 3 }]);
      expect(tab.state.historyHasMore).toBe(true);
      expect(tab.dom.messagesEl.textContent).toContain('installed-turn-1');

      const other = await manager.createTab();
      expect(other).not.toBeNull();
      await manager.switchToTab(tab.id);
      paint();
      jest.advanceTimersByTime(0);
      await settle();
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(view.getActiveTab()).toBe(tab);
      expect(tab.hydrationState).toBe('LOADING');
      rejectReady(readFailure);
      await settle();
      expect(failedLease.release).toHaveBeenCalledTimes(1);
      expect(tab.hydrationState).toBe('ERROR');
      expect(tab.dom.messagesEl.textContent).toContain('History lease release failed');
      expect(tab.state.historyLease).toBe(installedLease);
      expect(tab.state.loadedRanges).toEqual([{ start: 1, end: 3 }]);
      expect(tab.state.historyHasMore).toBe(true);
      expect(tab.state.historyLoading).toBe(true);
      expect(tab.dom.messagesEl.querySelector('.claudian-history-pager')).toBeNull();

      const requestsBefore = installedLease.loadWindow.mock.calls.length;
      await controller.loadOlderHistory();
      expect(installedLease.loadWindow).toHaveBeenCalledTimes(requestsBefore);
      expect(tab.state.loadedRanges).toEqual([{ start: 1, end: 3 }]);
      expect(tab.state.messages.some(message => message.id === 'installed-turn-0')).toBe(false);
      if (attempt === 'same attempt') return;

      const retry = tab.dom.messagesEl.querySelector<HTMLButtonElement>('.claudian-history-placeholder button');
      expect(retry).not.toBeNull();
      retry!.click();
      paint();
      jest.advanceTimersByTime(0);
      for (let index = 0; index < 3; index++) {
        await settle();
        paint();
      }
      expect(acquire).toHaveBeenCalledTimes(3);
      expect(tab.hydrationState).toBe('READY');
      expect(tab.state.historyLease).toBe(retryLease);
      expect(installedLease.release).toHaveBeenCalledTimes(1);
      expect(tab.state.historyLoading).toBe(false);
      expect(tab.state.loadedRanges).toEqual([{ start: 2, end: 3 }]);
      const retryPager = tab.dom.messagesEl.querySelector<HTMLButtonElement>('.claudian-history-pager button');
      expect(retryPager?.disabled).toBe(false);
      retryPager!.click();
      for (let index = 0; index < 3; index++) {
        await settle();
        paint();
      }
      expect(retryLease.loadWindow).toHaveBeenCalledTimes(2);
      expect(retryLease.loadWindow).toHaveBeenLastCalledWith(expect.objectContaining({ anchorTurn: 2 }));
      expect(tab.state.loadedRanges).toEqual([{ start: 1, end: 3 }]);
      expect(tab.state.historyLoading).toBe(false);
      expect(tab.dom.messagesEl.textContent).toContain('retry-turn-1');
    } finally {
      drain.resolve();
      for (let index = 0; index < 3; index++) {
        await settle();
        paint();
      }
    }
  },
);

it.each(['scheduled placeholder', 'animation frame'] as const)(
  'R1a race: a synchronous %s failure from the tab click is owned',
  async failureSite => {
    const { view, manager, tab } = await openHydrationFixture();
    const other = await manager.createTab();
    expect(other).not.toBeNull();
    paint();
    jest.advanceTimersByTime(0);
    await settle();
    expect(view.getActiveTab()).toBe(other);
    expect(tab.hydrationState).toBe('SHELL');
    const tabIndex = manager.getAllTabs().indexOf(tab);
    const badge = view.contentEl.querySelectorAll<HTMLElement>('.claudian-tab-badge')[tabIndex];
    expect(badge).toBeDefined();

    const failure = new Error(`fixture synchronous ${failureSite} failure`);
    const throwAtSite = jest.fn(() => { throw failure; });
    if (failureSite === 'scheduled placeholder') {
      jest.spyOn(tab.dom.messagesEl, 'empty').mockImplementationOnce(throwAtSite);
    } else {
      jest.mocked(globalThis.requestAnimationFrame).mockImplementationOnce(throwAtSite);
    }

    // Observe UI ownership on the real flight; the test consumes its rejection directly.
    const originalSwitch = manager.switchToTab.bind(manager);
    let clickFlight!: Promise<void>;
    let uiObservedRejection = false;
    const switchSpy = jest.spyOn(manager, 'switchToTab').mockImplementation(id => {
      clickFlight = originalSwitch(id);
      return new Proxy(clickFlight, {
        get(target, property) {
          if (property === 'then') {
            return (onFulfilled?: (value: void) => unknown, onRejected?: (reason: unknown) => unknown) => {
              if (onRejected) uiObservedRejection = true;
              return target.then(onFulfilled, onRejected);
            };
          }
          if (property === 'catch') {
            return (onRejected: (reason: unknown) => unknown) => {
              uiObservedRejection = true;
              return target.catch(onRejected);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    (Notice as jest.Mock).mockClear();
    badge.click();
    expect(switchSpy).toHaveBeenCalledWith(tab.id);
    expect(throwAtSite).toHaveBeenCalledTimes(1);
    const reason: unknown = await clickFlight.then(() => null, error => error);
    expect(reason === null || reason === failure).toBe(true);
    expect({ unownedRejection: reason !== null && !uiObservedRejection }).toEqual({ unownedRejection: false });
  },
);

it('R1a hydration: active lease double failure keeps its ERROR shell and retry without a Notice', async () => {
  const { view, manager, tab } = await openHydrationFixture();
  const terminal = jest.spyOn(manager as unknown as { reportHydrationFailure: (error: unknown) => void }, 'reportHydrationFailure');
  const runtime = createFixtureRuntime();
  jest.spyOn(ProviderRegistry, 'createChatRuntime').mockReturnValue(runtime as unknown as ChatRuntime);
  let rejectReady!: (error: Error) => void;
  let acquired = false;
  const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
  const readFailure = new Error('fixture active lease read failure');
  const releaseFailure = new Error('fixture active lease release failure');
  const lease = {
    conversationId: FIRST_ID,
    totalTurns: 1,
    ready,
    release: jest.fn(() => { throw releaseFailure; }),
  } as unknown as HistoryIndexLease;
  const internals = tab.controllers.conversationController as unknown as {
    deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
  };
  jest.spyOn(internals.deps, 'getHistoryIndexCapableService').mockReturnValueOnce({
    acquireHistoryIndex: () => { acquired = true; return lease; },
  } as unknown as ProviderConversationHistoryService);
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(acquired).toBe(true);
  (Notice as jest.Mock).mockClear();
  rejectReady(readFailure);
  await settle();
  expect(lease.release).toHaveBeenCalledTimes(1);
  expect(tab.hydrationState).toBe('ERROR');
  expect(tab.dom.messagesEl.textContent).toContain('History lease release failed');
  expect(terminal).not.toHaveBeenCalled();
  expect(Notice).not.toHaveBeenCalled();
  const retry = tab.dom.messagesEl.querySelector('button');
  expect(retry).not.toBeNull();
  retry!.click();
  paint();
  jest.advanceTimersByTime(0);
  for (let index = 0; index < 3; index++) {
    await settle();
    paint();
  }
  expect(view.getActiveTab()).toBe(tab);
  expect(tab.hydrationState).toBe('READY');
  expect(Notice).not.toHaveBeenCalled();
});

it('R1a hydration: a failed uninstalled lease release preserves the read failure', async () => {
  const { view, manager, tab } = await openHydrationFixture();
  const terminal = jest.spyOn(manager as unknown as { reportHydrationFailure: (error: unknown) => void }, 'reportHydrationFailure');
  let rejectReady!: (error: Error) => void;
  let acquired = false;
  const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
  const readFailure = new Error('fixture lease read failure');
  const releaseFailure = new Error('fixture uninstalled lease release failure');
  const lease = {
    conversationId: FIRST_ID,
    totalTurns: 1,
    ready,
    release: jest.fn(() => { throw releaseFailure; }),
  } as unknown as HistoryIndexLease;
  const controller = tab.controllers.conversationController!;
  const internals = controller as unknown as {
    deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
  };
  jest.spyOn(internals.deps, 'getHistoryIndexCapableService').mockReturnValue({
    acquireHistoryIndex: () => { acquired = true; return lease; },
  } as unknown as ProviderConversationHistoryService);
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(acquired).toBe(true);
  await view.onClose();
  await view.onOpen();
  await openConversation(view, FIRST_ID);
  const live = view.getActiveTab()!;
  const liveClaim = live.conversationOpenClaim!;
  const liveContent = live.dom.messagesEl.textContent;
  expect(live).not.toBe(tab);
  expect(live.state.messages.map(message => message.content)).toContain(HISTORY_BODY);
  expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);

  (Notice as jest.Mock).mockClear();
  rejectReady(readFailure);
  await settle();
  expect((Notice as jest.Mock).mock.calls).toEqual([[t('chat.history.errorTitle')]]);
  expect(lease.release).toHaveBeenCalledTimes(1);
  expect(terminal).toHaveBeenCalledTimes(1);
  expect(tab.hydrationState).not.toBe('ERROR');
  expect(live.hydrationState).toBe('READY');
  expect(live.state.currentConversationId).toBe(FIRST_ID);
  expect(live.dom.messagesEl.textContent).toBe(liveContent);
  expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
  const reported = terminal.mock.calls[0][0] as AggregateError;
  expect(reported).not.toBe(releaseFailure);
  expect(reported).toBeInstanceOf(AggregateError);
  expect(reported.errors).toHaveLength(2);
  expect(reported.errors[0]).toBe(readFailure);
  expect(reported.errors[1]).toBe(releaseFailure);
  jest.useRealTimers();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
});

it('R1a hydration: a read failure during close notifies without repainting the retiring tab', async () => {
  const { view, manager, tab } = await openHydrationFixture();
  let rejectRead!: (error: Error) => void;
  let reached = false;
  const read = new Promise<Conversation | null>((_resolve, reject) => { rejectRead = reject; });
  jest.spyOn(plugin, 'getConversationById').mockImplementationOnce(() => {
    reached = true;
    return read;
  });
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(reached).toBe(true);
  const persistence = deferred();
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const closing = view.onClose();
  try {
    expect(manager.isOpen()).toBe(false);
    (Notice as jest.Mock).mockClear();
    rejectRead(new Error('fixture during-close hydration failure'));
    await settle();
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith(t('chat.history.errorTitle'));
    expect(tab.hydrationState).not.toBe('ERROR');
    expect(tab.dom.messagesEl.textContent).not.toContain(HISTORY_BODY);
  } finally {
    persistence.resolve();
    await closing;
  }
});

it('R1a: a hydration read failure after view close does not become an unhandled rejection', async () => {
  await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  const view = createFixtureView();
  jest.spyOn(plugin.storage, 'getTabManagerState').mockResolvedValueOnce({
    openTabs: [{ tabId: 'fixture-failing-hydration', conversationId: FIRST_ID }],
    activeTabId: 'fixture-failing-hydration',
  });
  await view.onOpen();
  const oldManager = view.getTabManager()!;
  const oldTab = oldManager.getActiveTab()!;
  let rejectRead!: (error: Error) => void;
  let reached = false;
  const read = new Promise<Conversation | null>((_resolve, reject) => { rejectRead = reject; });
  jest.spyOn(plugin, 'getConversationById').mockImplementationOnce(() => {
    reached = true;
    return read;
  });
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(reached).toBe(true);

  await view.onClose();
  expect(oldManager.getTabCount()).toBe(0);
  await view.onOpen();
  await openConversation(view, FIRST_ID);
  const live = view.getActiveTab()!;
  const liveClaim = live.conversationOpenClaim!;
  expect(live).not.toBe(oldTab);
  expect(live.state.messages.map(message => message.content)).toContain(HISTORY_BODY);
  (Notice as jest.Mock).mockClear();
  rejectRead(new Error('fixture late hydration read failure'));
  await settle();
  expect(Notice).toHaveBeenCalledTimes(1);
  expect(Notice).toHaveBeenCalledWith(t('chat.history.errorTitle'));
  expect(oldTab.dom.messagesEl.textContent).not.toContain(HISTORY_BODY);
  expect(oldTab.hydrationState).not.toBe('ERROR');
  expect(live.hydrationState).toBe('READY');
  expect(live.state.messages.map(message => message.content)).toContain(HISTORY_BODY);
  expect(plugin.conversationOpenRegistry.owns(liveClaim)).toBe(true);
  jest.useRealTimers();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
});

it('R1a hydration: a backfill failure reaches both the terminal and the accepted-save drain', async () => {
  const { view, manager, tab } = await openHydrationFixture();
  const terminal = jest.spyOn(manager as unknown as { reportHydrationFailure: (error: unknown) => void }, 'reportHydrationFailure');
  const gate = deferred();
  const failure = new Error('fixture accepted backfill failure');
  let reached = false;
  jest.spyOn(plugin, 'updateConversation').mockImplementationOnce(async () => {
    reached = true;
    await gate.promise;
    throw failure;
  });
  const page = {
    messages: [{ id: 'fixture-backfill-message', role: 'user', content: HISTORY_BODY, timestamp: 1 }],
    range: { start: 0, end: 1 }, snapshotOffset: 1, sourceBytes: 1, projectedChars: HISTORY_BODY.length,
    oversizedTurnCount: 0, pageKey: 'fixture-backfill-page', hasMoreBefore: false, hasMoreAfter: false,
  };
  const lease = {
    conversationId: FIRST_ID,
    totalTurns: 1,
    ready: Promise.resolve(),
    planWindow: () => ({ start: 0, end: 1 }),
    loadWindow: async () => page,
    release: jest.fn(),
  };
  const controller = tab.controllers.conversationController!;
  const internals = controller as unknown as {
    deps: { getHistoryIndexCapableService: (conversation: Conversation) => ProviderConversationHistoryService | null };
  };
  jest.spyOn(internals.deps, 'getHistoryIndexCapableService').mockReturnValue({
    acquireHistoryIndex: () => lease as unknown as HistoryIndexLease,
  } as unknown as ProviderConversationHistoryService);
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(reached).toBe(true);
  expect(controller.snapshotAcceptedSaves()).toHaveLength(1);
  const closing = view.onClose();
  const closeResult = closing.then(() => null, error => error);
  try {
    (Notice as jest.Mock).mockClear();
    gate.resolve();
    expect(await closeResult).toBe(failure);
    await settle();
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith(t('chat.history.errorTitle'));
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(failure);
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(tab.hydrationState).not.toBe('ERROR');
  } finally {
    gate.resolve();
    await closeResult;
  }
});

it('R1a hydration: a throwing Notice schedules a fixed independent host error', async () => {
  const { view } = await openHydrationFixture();
  let rejectRead!: (error: Error) => void;
  let reached = false;
  const read = new Promise<Conversation | null>((_resolve, reject) => { rejectRead = reject; });
  jest.spyOn(plugin, 'getConversationById').mockImplementationOnce(() => {
    reached = true;
    return read;
  });
  paint();
  jest.advanceTimersByTime(0);
  await settle();
  expect(reached).toBe(true);
  await view.onClose();
  const notice = Notice as jest.Mock;
  notice.mockClear();
  notice.mockImplementationOnce(() => { throw new Error('fixture private notice failure'); });
  const tasks: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
  const timeout = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number) => {
    if (delay === 0 && typeof handler === 'function') {
      tasks.push(handler as () => void);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(handler, delay);
  }) as typeof setTimeout);
  try {
    rejectRead(new Error('fixture private hydration failure'));
    await settle();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(t('chat.history.errorTitle'));
    expect(tasks).toHaveLength(1);
    let reported: unknown;
    try { tasks[0](); } catch (error) { reported = error; }
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toMatch(/hydration/i);
    expect((reported as Error).message).not.toContain('fixture');
    expect((reported as Error & { cause?: unknown }).cause).toBeUndefined();
  } finally {
    timeout.mockRestore();
    notice.mockImplementation((_message: string) => {});
  }
});

it('generation: normally restores active sessions and focuses the existing cross-view owner', async () => {
  await openFixture();
  addConversation(FIRST_ID, HISTORY_BODY);
  const revealLeaf = jest.fn();
  (plugin.app.workspace as unknown as { revealLeaf: jest.Mock }).revealLeaf = revealLeaf;
  const owner = createFixtureView();
  jest.spyOn(plugin.storage, 'getTabManagerState').mockResolvedValueOnce({
    openTabs: [
      { tabId: 'fixture-active-restored', conversationId: FIRST_ID },
      { tabId: 'fixture-restored-blank', conversationId: null },
    ],
    activeTabId: 'fixture-active-restored',
  });
  await owner.onOpen();
  const ownerManager = owner.getTabManager()!;
  const restored = ownerManager.getTab('fixture-active-restored')!;
  expect(ownerManager.getActiveTab()).toBe(restored);
  expect(restored.conversationId).toBe(FIRST_ID);
  expect(plugin.conversationOpenRegistry.owns(restored.conversationOpenClaim!)).toBe(true);
  await ownerManager.switchToTab('fixture-restored-blank');

  const contender = await openAdditionalView();
  const focus = jest.spyOn(ownerManager, 'switchToTab');
  const rejected = await contender.view.getTabManager()!.createTab(FIRST_ID, 'fixture-contender', { activate: false });
  expect(revealLeaf).toHaveBeenCalledWith(owner.leaf);
  expect(focus).toHaveBeenCalledWith(restored.id);
  expect(ownerManager.getActiveTab()).toBe(restored);
  expect(rejected?.conversationId).toBeNull();
  expect(plugin.conversationOpenRegistry.owns(restored.conversationOpenClaim!)).toBe(true);
});

it('does not publish a late tab while view-close persistence is pending', async () => {
  const { closing, manager, gate, creating } = await pendingConflictingTab();
  const persistence = deferred();
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const register = jest.spyOn(plugin, 'registerMarkdownRenderDiagnostics');
  const closePromise = closing.view.onClose();
  let closed = false;
  void closePromise.then(() => { closed = true; });
  try {
    await settle();
    expect(closed).toBe(false);
    gate.resolve();
    const late = await creating;
    expect(late).toBeNull();
    expect(manager.getTab('fixture-delayed-tab')).toBeNull();
    jest.advanceTimersByTime(5000);
    expect(logRows()).toEqual([]);
    expect(register).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    persistence.resolve();
    await creating.catch(() => null);
    await closePromise;
  }
});

it('flushes once across concurrent closes while another view remains active', async () => {
  const { owner, closing, manager, gate, creating } = await pendingConflictingTab();
  const closingStream = prepareStream(closing.tab);
  await streamChunk(closing.tab, closingStream.context, STREAM_BODY);
  const firstPersistence = deferred();
  const secondPersistence = deferred();
  const persist = jest.spyOn(plugin, 'persistTabManagerState')
    .mockImplementationOnce(() => firstPersistence.promise)
    .mockImplementationOnce(() => secondPersistence.promise);
  const register = jest.spyOn(plugin, 'registerMarkdownRenderDiagnostics');
  const firstClose = closing.view.onClose();
  const secondClose = closing.view.onClose();
  try {
    await settle();
    expect(persist).toHaveBeenCalledTimes(1);
    const closedRows = logRows();
    expect(closedRows.filter(row => row.flushScope === 'window')).toEqual([
      expect.objectContaining({ flushReason: 'dispose', callsSum: 1, successCalls: 1 }),
    ]);
    gate.resolve();
    const late = await creating;
    expect(late).toBeNull();
    expect(manager.getTab('fixture-delayed-tab')).toBeNull();
    jest.advanceTimersByTime(5000);
    expect(logRows()).toEqual(closedRows);
    expect(register).not.toHaveBeenCalled();

    firstPersistence.resolve();
    secondPersistence.resolve();
    await Promise.all([firstClose, secondClose]);
    expect(logRows()).toEqual(closedRows);
    const activeStream = prepareStream(owner.tab);
    await streamChunk(owner.tab, activeStream.context, STREAM_BODY);
    jest.advanceTimersByTime(5000);
    const rows = logRows();
    expect(rows.filter(row => row.flushScope === 'window')).toHaveLength(2);
    expect(activeStream.target.textContent).toContain('fixture chat body');
    expectPrivateLog(rows, ['fixture-delayed-tab', owner.tab.id]);
  } finally {
    gate.resolve();
    firstPersistence.resolve();
    secondPersistence.resolve();
    await creating.catch(() => null);
    await Promise.all([firstClose, secondClose]);
  }
});

it('does not register or log a late tab after its view closes while another view remains active', async () => {
  const { owner, closing, manager, gate, creating } = await pendingConflictingTab();
  const register = jest.spyOn(plugin, 'registerMarkdownRenderDiagnostics');
  try {
    await closing.view.onClose();
    await closing.view.onClose();
    const bindings = (plugin as unknown as { markdownRenderBindings: Set<unknown> }).markdownRenderBindings.size;
    const timeout = jest.spyOn(globalThis, 'setTimeout');
    gate.resolve();
    const late = await creating;
    expect(late).toBeNull();
    expect(manager.getTabCount()).toBe(0);
    expect(timeout.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(0);
    jest.advanceTimersByTime(5000);
    expect(logRows()).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    expect((plugin as unknown as { markdownRenderBindings: Set<unknown> }).markdownRenderBindings.size).toBe(bindings);

    const activeStream = prepareStream(owner.tab);
    await streamChunk(owner.tab, activeStream.context, STREAM_BODY);
    expect(timeout.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(1);
    jest.advanceTimersByTime(5000);
    const rows = logRows();
    expect(rows.filter(row => row.flushScope === 'window')).toEqual([
      expect.objectContaining({ callsSum: 1, successCalls: 1 }),
    ]);
    expect(activeStream.target.textContent).toContain('fixture chat body');
    expectPrivateLog(rows, ['fixture-delayed-tab', owner.tab.id]);
  } finally {
    gate.resolve();
    await creating.catch(() => null);
    await manager.destroy();
  }
});

it('keeps an old generation disabled after reopening the same view', async () => {
  const { closing, manager, gate, creating } = await pendingConflictingTab();
  const register = jest.spyOn(plugin, 'registerMarkdownRenderDiagnostics');
  try {
    await closing.view.onClose();
    await closing.view.onOpen();
    paint();
    await settle();
    const reopened = closing.view.getActiveTab();
    expect(reopened?.markdownRenderDiagnostics).toBeTruthy();
    const registrationsAfterReopen = register.mock.calls.length;
    const bindings = (plugin as unknown as { markdownRenderBindings: Set<unknown> }).markdownRenderBindings.size;
    gate.resolve();
    const late = await creating;
    expect(late).toBeNull();
    expect(manager.getTabCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(logRows()).toEqual([]);
    expect(register).toHaveBeenCalledTimes(registrationsAfterReopen);
    expect((plugin as unknown as { markdownRenderBindings: Set<unknown> }).markdownRenderBindings.size).toBe(bindings);

    const reopenedStream = prepareStream(reopened!);
    await streamChunk(reopened!, reopenedStream.context, STREAM_BODY);
    jest.advanceTimersByTime(5000);
    const rows = logRows();
    expect(rows.filter(row => row.flushScope === 'window')).toEqual([
      expect.objectContaining({ callsSum: 1, successCalls: 1 }),
    ]);
    expect(reopenedStream.target.textContent).toContain('fixture chat body');
    expectPrivateLog(rows, ['fixture-delayed-tab', reopened!.id]);
  } finally {
    gate.resolve();
    await creating.catch(() => null);
    await manager.destroy();
  }
});

it('keeps a reopened view active when the previous close is still persisting', async () => {
  const { closing, manager, gate, creating } = await pendingConflictingTab();
  const persistence = deferred();
  jest.spyOn(plugin, 'persistTabManagerState').mockImplementationOnce(() => persistence.promise);
  const closePromise = closing.view.onClose();
  try {
    await settle();
    await closing.view.onOpen();
    paint();
    await settle();
    const reopenedManager = closing.view.getTabManager()!;
    const reopened = closing.view.getActiveTab()!;
    const reopenedTabBar = (closing.view as unknown as { tabBar: unknown }).tabBar;
    expect(reopenedManager).not.toBe(manager);
    expect(reopened.markdownRenderDiagnostics).toBeTruthy();
    const register = jest.spyOn(plugin, 'registerMarkdownRenderDiagnostics');

    gate.resolve();
    const late = await creating;
    expect(late).toBeNull();
    expect(manager.getTab('fixture-delayed-tab')).toBeNull();
    jest.advanceTimersByTime(5000);
    expect(logRows()).toEqual([]);
    expect(register).not.toHaveBeenCalled();

    persistence.resolve();
    await closePromise;
    expect(closing.view.getTabManager() === reopenedManager).toBe(true);
    expect((closing.view as unknown as { tabBar: unknown }).tabBar).toBe(reopenedTabBar);
    expect(reopenedManager.getTab(reopened.id)).toBe(reopened);
    const activeStream = prepareStream(reopened);
    await streamChunk(reopened, activeStream.context, STREAM_BODY);
    jest.advanceTimersByTime(5000);
    const rows = logRows();
    expect(rows.filter(row => row.flushScope === 'window')).toEqual([
      expect.objectContaining({ callsSum: 1, successCalls: 1 }),
    ]);
    expect(activeStream.target.textContent).toContain('fixture chat body');
    expectPrivateLog(rows, ['fixture-delayed-tab', reopened.id]);
  } finally {
    gate.resolve();
    persistence.resolve();
    await creating.catch(() => null);
    await closePromise;
  }
});

it.each([
  { name: 'empty', state: null },
  {
    name: 'persisted',
    state: { openTabs: [{ tabId: 'fixture-restored-tab', conversationId: null }], activeTabId: 'fixture-restored-tab' },
  },
])('keeps a delayed $name restore in its original view generation after reopening', async ({ state }) => {
  await openFixture();
  const view = createFixtureView();
  const gate = deferred();
  jest.spyOn(plugin.storage, 'getTabManagerState').mockImplementationOnce(async () => {
    await gate.promise;
    return state;
  });
  const opening = view.onOpen();
  await settle();
  const oldManager = view.getTabManager()!;
  const restore = jest.spyOn(oldManager, 'restoreState');
  const create = jest.spyOn(oldManager, 'createTab');
  try {
    await view.onClose();
    await view.onOpen();
    paint();
    await settle();
    const reopenedManager = view.getTabManager()!;
    expect(reopenedManager).not.toBe(oldManager);
    const reopened = view.getActiveTab()!;
    const originalTabs = reopenedManager.getAllTabs();
    const register = jest.spyOn(plugin, 'registerMarkdownRenderDiagnostics');
    const timeout = jest.spyOn(globalThis, 'setTimeout');

    gate.resolve();
    await opening;
    expect(restore).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(oldManager.getTabCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(logRows()).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    expect(timeout.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(0);
    expect(reopenedManager.getAllTabs()).toEqual(originalTabs);

    const activeStream = prepareStream(reopened);
    await streamChunk(reopened, activeStream.context, STREAM_BODY);
    jest.advanceTimersByTime(5000);
    const rows = logRows();
    expect(rows.filter(row => row.flushScope === 'window')).toEqual([
      expect.objectContaining({ callsSum: 1, successCalls: 1 }),
    ]);
    expect(activeStream.target.textContent).toContain('fixture chat body');
    expectPrivateLog(rows, ['fixture-restored-tab', reopened.id]);
  } finally {
    gate.resolve();
    await opening.catch(() => undefined);
  }
});

it('flushes every open view before plugin unload and ignores all late tokens', async () => {
  const first = await openFixture();
  const second = await openAdditionalView();
  const pending = [deferred(), deferred()];
  for (const item of pending) {
    (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(async (text: string, el: HTMLElement) => {
      await item.promise;
      el.textContent = text;
    });
  }
  await streamChunk(first.tab, prepareStream(first.tab).context, STREAM_BODY);
  await streamChunk(second.tab, prepareStream(second.tab).context, STREAM_BODY);
  await plugin.onunload();
  const windows = logRows().filter(row => row.flushScope === 'window');
  expect(windows).toHaveLength(2);
  expect(new Set(windows.map(row => row.collectorIdHash)).size).toBe(2);
  for (const row of windows) {
    expect(row).toMatchObject({ flushReason: 'dispose', abandonedCalls: 1, settledCalls: 0, failureCalls: 0 });
  }
  const beforeLate = readFileSync(logPath(), 'utf8');
  pending.forEach(item => item.resolve());
  await settle();
  const afterUnload = prepareStream(first.tab);
  await streamChunk(first.tab, afterUnload.context, STREAM_BODY);
  expect(afterUnload.target.textContent).toContain('fixture chat body');
  jest.advanceTimersByTime(10000);
  expect(readFileSync(logPath(), 'utf8')).toBe(beforeLate);
  expectPrivateLog(logRows());
});

it('samples only the requested tab subtree, explicitly and at most once per five seconds', async () => {
  const { view, tab } = await openFixture();
  const other = (await view.getTabManager()!.createTab(null, 'fixture-tab-two', { activate: false }))!;
  const page = tab.dom.messagesEl.createDiv({ cls: 'claudian-history-page' });
  page.createDiv({ cls: 'claudian-message' }).createDiv({ cls: 'claudian-text-block' });
  const otherPage = other.dom.messagesEl.createDiv({ cls: 'claudian-history-page' });
  otherPage.createDiv({ cls: 'claudian-message' }).createDiv({ cls: 'claudian-text-block' });
  const query = jest.spyOn(tab.dom.messagesEl, 'querySelectorAll');
  const pageScans = () => query.mock.calls.filter(([selector]) => selector === '.claudian-history-page').length;

  view.sampleMarkdownRenderDom('missing-tab');
  expect(pageScans()).toBe(0);
  view.sampleMarkdownRenderDom(tab.id);
  view.sampleMarkdownRenderDom(tab.id);
  expect(pageScans()).toBe(1);
  page.createDiv({ cls: 'claudian-message' }).createDiv({ cls: 'claudian-text-block' });
  const stream = prepareStream(tab);
  await streamChunk(tab, stream.context, STREAM_BODY);
  expect(pageScans()).toBe(1);
  jest.advanceTimersByTime(4999);
  view.sampleMarkdownRenderDom(tab.id);
  expect(pageScans()).toBe(1);
  jest.advanceTimersByTime(1);
  view.sampleMarkdownRenderDom(tab.id);
  view.sampleMarkdownRenderDom(tab.id);
  expect(pageScans()).toBe(2);
  jest.advanceTimersByTime(5000);

  const rows = logRows();
  const windows = rows.filter(row => row.flushScope === 'window');
  expect(windows).toHaveLength(2);
  expect(windows[0]).toMatchObject({ domPageNodes: 1, domMessageNodes: 1, domTextBlockNodes: 1 });
  expect(windows[1]).toMatchObject({ domPageNodes: 1, domMessageNodes: 3, domTextBlockNodes: 3, callsSum: 0 });
  expectPrivateLog(rows);
});

it('preserves the actual Markdown fallback and release while logging a failure without error text', async () => {
  const { tab } = await openFixture();
  const release = jest.fn();
  tab.renderer!.setPageRenderWorkRegistrar(() => release);
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockRejectedValueOnce(new Error(PRIVATE_ERROR));
  const stream = prepareStream(tab);
  await streamChunk(tab, stream.context, STREAM_BODY);
  expect(stream.target.querySelector('.claudian-render-error')).not.toBeNull();
  expect(release).toHaveBeenCalledTimes(1);
  expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(5000);
  const rows = logRows();
  expect(rows.find(row => row.flushScope === 'window')).toMatchObject({
    callsSum: 1, settledCalls: 1, successCalls: 0, failureCalls: 1,
  });
  expectPrivateLog(rows);
});

it('disables the real logger after a filesystem failure without blocking or retrying Markdown', async () => {
  const { tab } = await openFixture();
  const fs = jest.requireActual<typeof NodeFs>('fs');
  const append = jest.spyOn(fs, 'appendFileSync');
  mkdirSync(logPath(), { recursive: true });
  const first = prepareStream(tab);
  await streamChunk(tab, first.context, STREAM_BODY);
  expect(first.target.textContent).toContain('fixture chat body');
  jest.advanceTimersByTime(5000);
  const writes = () => append.mock.calls.filter(([path]) => path === logPath()).length;
  expect(writes()).toBe(1);
  rmSync(logPath(), { recursive: true, force: true });

  const second = prepareStream(tab);
  await streamChunk(tab, second.context, STREAM_BODY);
  expect(second.target.textContent).toContain('fixture chat body');
  jest.advanceTimersByTime(5000);
  expect(writes()).toBe(1);
  expect(existsSync(logPath())).toBe(false);
  expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledTimes(2);
});

it('drops pending data and stops the collector when the measurement clock fails', async () => {
  const { tab } = await openFixture();
  const clock = jest.spyOn(performance, 'now');
  (MarkdownRenderer.renderMarkdown as jest.Mock).mockImplementationOnce(async (text: string, el: HTMLElement) => {
    await Promise.resolve();
    el.textContent = text;
    clock.mockReturnValueOnce(NaN);
  });
  const first = prepareStream(tab);
  await streamChunk(tab, first.context, STREAM_BODY);
  expect(first.target.textContent).toContain('fixture chat body');
  jest.advanceTimersByTime(5000);
  expect(logRows()).toEqual([]);
  const second = prepareStream(tab);
  await streamChunk(tab, second.context, STREAM_BODY);
  jest.advanceTimersByTime(5000);
  expect(second.target.textContent).toContain('fixture chat body');
  expect(logRows()).toEqual([]);
  expect(MarkdownRenderer.renderMarkdown).toHaveBeenCalledTimes(2);
});

it('isolates a binding hash failure while preserving the real conversation change and other tabs', async () => {
  const { view, tab } = await openFixture();
  const other = (await view.getTabManager()!.createTab(null, 'fixture-tab-two', { activate: false }))!;
  addConversation(FIRST_ID, HISTORY_BODY);
  addConversation(SECOND_ID, HISTORY_BODY);
  const dirty = prepareStream(tab);
  await streamChunk(tab, dirty.context, STREAM_BODY);
  const crypto = jest.requireActual<typeof NodeCrypto>('crypto');
  const hash = jest.spyOn(crypto, 'createHash').mockImplementationOnce(() => { throw new Error(PRIVATE_ERROR); });

  await openConversation(view, FIRST_ID);
  expect(tab.state.currentConversationId).toBe(FIRST_ID);
  expect(tab.conversationId).toBe(FIRST_ID);
  expect(tab.dom.messagesEl.textContent).toContain(HISTORY_BODY);
  expect(hash).toHaveBeenCalledTimes(1);
  await openConversation(view, SECOND_ID);
  expect(tab.state.currentConversationId).toBe(SECOND_ID);
  expect(hash).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(5000);
  expect(logRows()).toEqual([]);

  const otherStream = prepareStream(other);
  await streamChunk(other, otherStream.context, STREAM_BODY);
  jest.advanceTimersByTime(5000);
  const rows = logRows();
  expect(rows.find(row => row.flushScope === 'window')).toMatchObject({ callsSum: 1, successCalls: 1 });
  expectPrivateLog(rows);
});
