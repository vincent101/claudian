/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */
import { installObsidianDom } from '@test/helpers/obsidianDom';
import type * as fsPromises from 'fs/promises';
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { ItemView } from 'obsidian';
import { tmpdir } from 'os';
import { join } from 'path';
import { setImmediate } from 'timers';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SessionStorage } from '@/core/bootstrap/SessionStorage';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation } from '@/core/types';
import { ClaudianView } from '@/features/chat/ClaudianView';
import { ConversationController, type ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import { ChatState } from '@/features/chat/state/ChatState';
import { createTab, deactivateTab, destroyTab } from '@/features/chat/tabs/Tab';
import { TabManager } from '@/features/chat/tabs/TabManager';
import type { TabData } from '@/features/chat/tabs/types';
import ClaudianPlugin from '@/main';
import * as index from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import * as codexStore from '@/providers/codex/history/CodexHistoryStore';

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  Scope: class { register() {} },
}));

const fs = jest.requireActual<typeof fsPromises>('fs/promises');
let dir: string;
beforeAll(async () => {
  installObsidianDom();
  dir = await mkdtemp(join(tmpdir(), 'claudian-native-ui-'));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => { jest.restoreAllMocks(); document.body.replaceChildren(); });

async function fixture(name: string) {
  const path = join(dir, `${name}.jsonl`);
  await writeFile(path, '123');
  const views: ClaudianView[] = [];
  const write = jest.fn();
  const app = { vault: { adapter: { basePath: dir } }, workspace: { getLeavesOfType: () => views.map(view => ({ view })) } };
  const plugin = new ClaudianPlugin(app as never, { id: 'claudian' } as never);
  plugin.settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS));
  plugin.storage = { sessions: { saveSizeSnapshot: write, saveMetadata: write } } as never;
  const input: Conversation = { id: name, title: 'Fixture', providerId: 'codex', createdAt: 1, updatedAt: 1,
    sessionId: null, providerState: { sessionFilePath: path }, messages: [] };
  const other: Conversation = { ...input, id: `${name}-other`, title: 'Other', providerState: {} };
  (plugin as unknown as { conversations: Conversation[] }).conversations = [input, other];
  const prototype = ItemView.prototype as unknown as { load: () => Promise<void> };
  const old = prototype.load;
  prototype.load = async () => {};
  let view: ClaudianView;
  try { view = new ClaudianView({ id: 'leaf' } as never, plugin); }
  finally { prototype.load = old; }
  const fields = view as unknown as {
    buildNavRowContent(): HTMLElement; updateHistoryDropdown(): void; updateTabBar(): void;
    tabManager: TabManager; tabBarContainerEl: HTMLElement; historyDropdown: HTMLElement;
  };
  document.body.appendChild(fields.buildNavRowContent());
  const manager = new TabManager(plugin, document.body.createDiv(), view);
  fields.tabManager = manager;
  const state = new ChatState();
  state.currentConversationId = input.id;
  const controller = new ConversationController({ plugin, state,
    getHistoryDropdown: () => fields.historyDropdown,
  } as unknown as ConversationControllerDeps);
  const tab = { id: 'tab-one', conversationId: input.id, providerId: 'codex', state, service: null,
    controllers: { conversationController: controller } } as unknown as TabData;
  const second = { ...tab, id: 'tab-two', conversationId: other.id, state: new ChatState() };
  const managerFields = manager as unknown as { tabs: Map<string, TabData>; activeTabId: string };
  managerFields.tabs = new Map([[tab.id, tab], [second.id, second]]);
  managerFields.activeTabId = tab.id;
  views.push(view);
  const frames: FrameRequestCallback[] = [];
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  const paint = () => { frames.splice(0).forEach(callback => callback(0)); };
  fields.updateTabBar();
  paint();
  const historyButton = document.querySelector<HTMLElement>('[aria-label="Chat history"]')!;
  const line = () => fields.historyDropdown.querySelectorAll<HTMLElement>('.claudian-history-item-date')[1];
  const badge = () => fields.tabBarContainerEl.children[0] as HTMLElement;
  return { plugin, input, tab, other, fields, manager, managerFields, historyButton, line, badge, path, paint, write };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function retainedHistoryRows(controller: ConversationController) {
  return [...(controller as unknown as {
    historySizeRows: Map<string, { conversation: Conversation | null; container: HTMLElement; sizeEl: HTMLElement }>;
  }).historySizeRows.values()];
}

async function historyOwnerFixture(name: string) {
  const f = await fixture(name);
  const area = document.body.createDiv();
  const manager = new TabManager(f.plugin, area, f.fields as unknown as ClaudianView, {
    onTabSwitched: () => f.fields.updateHistoryDropdown(),
    onTabClosed: () => f.fields.updateTabBar(),
  });
  const tabs = [f.input, f.other].map((conversation, index) => {
    const tab = createTab({ plugin: f.plugin, containerEl: area, conversation, tabId: `owner-${index}` });
    tab.hydrationState = 'READY';
    tab.state.currentConversationId = conversation.id;
    const controller = new ConversationController({ plugin: f.plugin, state: tab.state,
      getHistoryDropdown: () => f.fields.historyDropdown,
      getFileContextManager: () => null, getExternalContextSelector: () => null,
      getAgentService: () => null, isHydrationReady: () => true,
    } as unknown as ConversationControllerDeps);
    tab.controllers.conversationController = controller;
    return { tab, controller };
  });
  const fields = manager as unknown as { tabs: Map<string, TabData>; activeTabId: string };
  fields.tabs = new Map(tabs.map(({ tab }) => [tab.id, tab]));
  fields.activeTabId = tabs[0].tab.id;
  f.fields.tabManager = manager;
  const files = new Map<string, string>();
  f.plugin.storage = { sessions: new SessionStorage({
    exists: async (path: string) => files.has(path), read: async (path: string) => files.get(path)!,
    write: async (path: string, data: string) => { files.set(path, data); },
    delete: async (path: string) => { files.delete(path); }, listFiles: async () => [],
  } as unknown as VaultFileAdapter) } as never;
  return { ...f, ownerManager: manager, ownerFields: fields, tabs };
}

it('row ownership releases a deleted third conversation after real tab switching and list deletion', async () => {
  const f = await historyOwnerFixture('row-retention');
  const path = join(dir, 'retained-third.jsonl');
  await writeFile(path, 'third');
  const third: Conversation = { ...f.input, id: 'retained-third', title: 'Third',
    providerState: { sessionFilePath: path },
    messages: [{ id: 'large-fixture', role: 'user', content: 'synthetic payload'.repeat(100_000), timestamp: 1 }],
  };
  (f.plugin as unknown as { conversations: Conversation[] }).conversations.push(third);
  const stat = jest.spyOn(fs, 'stat');
  f.historyButton.click();
  await Promise.all([f.input.id, f.other.id, third.id].map(id => f.plugin.conversationSizes.refresh(id)));
  expect(retainedHistoryRows(f.tabs[0].controller).some(row => row.conversation === third)).toBe(true);
  const reads = stat.mock.calls.length;
  await f.ownerManager.switchToTab(f.tabs[1].tab.id);
  const item = [...f.fields.historyDropdown.querySelectorAll<HTMLElement>('.claudian-history-item')]
    .find(row => row.querySelector('.claudian-history-item-title')?.textContent === 'Third')!;
  const deletion = jest.spyOn(f.plugin, 'deleteConversation');
  item.querySelector<HTMLButtonElement>('.claudian-delete-btn')!.click();
  await deletion.mock.results[0].value;
  await Promise.resolve();
  expect(f.plugin.getConversationSync(third.id)).toBeNull();
  expect(f.fields.historyDropdown.textContent).not.toContain('Third');
  expect(retainedHistoryRows(f.tabs[1].controller).some(row => row.conversation === third)).toBe(false);
  expect(retainedHistoryRows(f.tabs[0].controller)).toHaveLength(0);
  expect(stat).toHaveBeenCalledTimes(reads);
});

it.each(['close', 'hidden-render', 'owner-change', 'deactivate', 'destroy'] as const)(
  'row ownership releases conversation and DOM bindings on %s', async action => {
    const f = await historyOwnerFixture(`row-owner-${action}`);
    f.historyButton.click();
    await Promise.all([f.input.id, f.other.id].map(id => f.plugin.conversationSizes.refresh(id)));
    const rows = retainedHistoryRows(f.tabs[0].controller);
    expect(rows).toHaveLength(2);
    if (action === 'close' || action === 'hidden-render') f.historyButton.click();
    if (action === 'hidden-render') f.fields.updateHistoryDropdown();
    if (action === 'owner-change') {
      f.ownerFields.activeTabId = f.tabs[1].tab.id;
      f.fields.updateHistoryDropdown();
    }
    if (action === 'deactivate') deactivateTab(f.tabs[0].tab);
    if (action === 'destroy') await destroyTab(f.tabs[0].tab);
    expect(retainedHistoryRows(f.tabs[0].controller)).toHaveLength(0);
  },
);

it('row ownership releases bindings through the real document-click close handler', async () => {
  const f = await historyOwnerFixture('row-document-close');
  const cleanups: Array<() => void> = [];
  const fields = f.fields as unknown as {
    app: unknown; containerEl: HTMLElement; wireEventHandlers(): void;
    registerEvent(ref: unknown): void;
    registerDomEvent(el: HTMLElement | Document, type: string, handler: EventListener): void;
  };
  fields.app = f.plugin.app;
  fields.containerEl = document.body.createDiv();
  fields.registerEvent = () => {};
  fields.registerDomEvent = (el, type, handler) => {
    el.addEventListener(type, handler);
    cleanups.push(() => el.removeEventListener(type, handler));
  };
  Object.assign(f.plugin.app.vault, { on: () => ({}) });
  Object.assign(f.plugin.app.workspace, { on: () => ({}) });
  fields.wireEventHandlers();
  try {
    f.historyButton.click();
    await Promise.all([f.input.id, f.other.id].map(id => f.plugin.conversationSizes.refresh(id)));
    expect(retainedHistoryRows(f.tabs[0].controller).length).toBe(2);
    document.body.click();
    expect(f.fields.historyDropdown.classList.contains('visible')).toBe(false);
    expect(retainedHistoryRows(f.tabs[0].controller).length).toBe(0);
  } finally { cleanups.forEach(cleanup => cleanup()); }
});

it('row ownership releases bindings on real view teardown', async () => {
  const f = await historyOwnerFixture('row-view-close');
  Object.assign(f.plugin.storage, { setTabManagerState: async () => {} });
  f.historyButton.click();
  await Promise.all([f.input.id, f.other.id].map(id => f.plugin.conversationSizes.refresh(id)));
  expect(retainedHistoryRows(f.tabs[0].controller).length).toBe(2);
  await (f.fields as unknown as ClaudianView).onClose();
  expect(retainedHistoryRows(f.tabs[0].controller).length).toBe(0);
  expect(retainedHistoryRows(f.tabs[1].controller).length).toBe(0);
  expect(f.fields.historyDropdown.classList.contains('visible')).toBe(false);
  expect(f.ownerManager.getAllTabs()).toHaveLength(0);
});

it('row ownership releases programmatically deleted conversation bindings without requiring a list redraw', async () => {
  const f = await historyOwnerFixture('row-api-delete');
  const third = { ...f.input, id: 'api-third', title: 'API third', messages: [] };
  (f.plugin as unknown as { conversations: Conversation[] }).conversations.push(third);
  f.historyButton.click();
  await Promise.all([f.input.id, f.other.id, third.id].map(id => f.plugin.conversationSizes.refresh(id)));
  expect(retainedHistoryRows(f.tabs[0].controller).some(row => row.conversation === third)).toBe(true);
  await f.plugin.deleteConversation(third.id);
  expect(retainedHistoryRows(f.tabs[0].controller).some(row => row.conversation === third)).toBe(false);
});

it('P2-1 publishes the delayed stat to a rerendered visible history row without another stat', async () => {
  const f = await fixture('p2-rerender');
  const actualStat = fs.stat;
  const captured = await actualStat(f.path);
  const pending = deferred<Awaited<ReturnType<typeof fs.stat>>>();
  const stat = jest.spyOn(fs, 'stat').mockImplementationOnce(() => pending.promise as ReturnType<typeof fs.stat>);
  f.historyButton.click();
  const reading = f.plugin.conversationSizes.refresh(f.input.id);
  const oldLine = f.line();
  await Promise.resolve();
  f.fields.updateHistoryDropdown();
  const currentLine = f.line();
  try {
    expect(currentLine).not.toBe(oldLine);
    expect(currentLine.textContent).toContain('unknown');
    expect(stat).toHaveBeenCalledTimes(1);
    pending.resolve(captured);
    await reading;
    expect(oldLine.textContent).toContain('unknown');
    expect(currentLine.textContent).toContain('3 B');
    expect(stat).toHaveBeenCalledTimes(1);
  } finally { pending.resolve(captured); await reading; }
});

it.each([false, true])('P2-2 publishes a same-session tab refresh to the visible list (rerender=%s)', async rerender => {
  const f = await fixture(`p2-cross-surface-${rerender}`);
  const actualStat = fs.stat;
  const oldStat = await actualStat(f.path);
  const menuPending = deferred<Awaited<ReturnType<typeof fs.stat>>>();
  const tabPending = deferred<Awaited<ReturnType<typeof fs.stat>>>();
  const stat = jest.spyOn(fs, 'stat')
    .mockImplementationOnce(() => menuPending.promise as ReturnType<typeof fs.stat>)
    .mockImplementationOnce(() => tabPending.promise as ReturnType<typeof fs.stat>);
  f.historyButton.click();
  const menuReading = f.plugin.conversationSizes.refresh(f.input.id);
  await Promise.resolve();
  await appendFile(f.path, '456');
  const latestStat = await actualStat(f.path);
  f.badge().dispatchEvent(new MouseEvent('mouseenter'));
  const tabReading = f.plugin.conversationSizes.refresh(f.input.id);
  await Promise.resolve();
  if (rerender) f.fields.updateHistoryDropdown();
  const currentLine = f.line();
  const currentBadge = f.badge();
  try {
    expect(stat).toHaveBeenCalledTimes(2);
    tabPending.resolve(latestStat);
    await tabReading;
    expect(f.line()).toBe(currentLine);
    expect(f.badge()).toBe(currentBadge);
    expect(f.badge().getAttribute('aria-label')).toContain('6 B');
    expect(currentLine.textContent).toContain('6 B');
    menuPending.resolve(oldStat);
    expect(await menuReading).toBeUndefined();
    expect(currentLine.textContent).toContain('6 B');
    expect(stat).toHaveBeenCalledTimes(2);
  } finally {
    menuPending.resolve(oldStat);
    tabPending.resolve(latestStat);
    await Promise.all([menuReading, tabReading]);
  }
});

it.each(['save', 'close'].flatMap(operation => [false, true].map(failed => [operation, failed] as const)))(
  'P2-3 settles %s after metadata (failed=%s) while stat remains pending', async (operation, failed) => {
    const f = await fixture(`p2-save-${operation}-${failed}`);
    const actualStat = fs.stat;
    const captured = await actualStat(f.path);
    const pending = deferred<Awaited<ReturnType<typeof fs.stat>>>();
    const stat = jest.spyOn(fs, 'stat').mockImplementationOnce(() => pending.promise as ReturnType<typeof fs.stat>);
    const metadataWritten = deferred<void>();
    const failure = new Error('controlled metadata failure');
    const files = new Map<string, string>();
    const write = jest.fn(async (name: string, data: string) => {
      metadataWritten.resolve();
      if (failed) throw failure;
      files.set(name, data);
    });
    const sessions = new SessionStorage({ exists: async (name: string) => files.has(name),
      read: async (name: string) => files.get(name)!, write,
      delete: async () => {}, listFiles: async () => [],
    } as unknown as VaultFileAdapter);
    f.plugin.storage = { sessions } as never;
    const tab = createTab({ plugin: f.plugin, containerEl: document.body.createDiv(), conversation: f.input, tabId: f.tab.id });
    tab.state.currentConversationId = f.input.id;
    tab.state.hasPendingConversationSave = true;
    tab.hydrationState = 'READY';
    const controller = new ConversationController({ plugin: f.plugin, state: tab.state,
      getFileContextManager: () => null, getExternalContextSelector: () => null,
      getAgentService: () => null, isHydrationReady: () => true,
    } as unknown as ConversationControllerDeps);
    tab.controllers.conversationController = controller;
    f.managerFields.tabs.set(tab.id, tab);
    // Close the inactive tab: this exercises real teardown without unrelated hydration.
    f.managerFields.activeTabId = 'tab-two';
    const task = operation === 'close' ? f.manager.closeTab(tab.id) : controller.save();
    const outcome = task.then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error }));
    try {
      await metadataWritten.promise;
      const observed = await Promise.race([
        outcome,
        new Promise<{ status: 'pending' }>(resolve => setImmediate(() => resolve({ status: 'pending' }))),
      ]);
      expect(stat).toHaveBeenCalledTimes(1);
      expect(observed).toEqual(failed ? { status: 'rejected', error: failure }
        : { status: 'resolved', value: operation === 'close' ? true : undefined });
      expect(tab.state.hasPendingConversationSave).toBe(failed);
      expect(f.manager.getTab(tab.id)).toBe(operation === 'close' && !failed ? null : tab);
      expect(write).toHaveBeenCalledTimes(1);
      const reading = f.plugin.conversationSizes.refresh(f.input.id);
      const replacement = { ...f.input, providerState: { ...f.input.providerState } };
      (f.plugin as unknown as { conversations: Conversation[] }).conversations = [replacement, f.other];
      pending.resolve(captured);
      expect(await reading).toBeUndefined();
      expect(f.plugin.conversationSizes.getSnapshot(f.input.id)).toBeUndefined();
      expect(replacement).not.toHaveProperty('sizeSnapshot');
    } finally { pending.resolve(captured); await outcome; }
  },
);

it('P2-2 does not publish a replacement object into rows bound to the old same-ID object', async () => {
  const f = await fixture('p2-row-object');
  const actualStat = fs.stat;
  const captured = await actualStat(f.path);
  const pending = deferred<Awaited<ReturnType<typeof fs.stat>>>();
  const stat = jest.spyOn(fs, 'stat').mockImplementationOnce(() => pending.promise as ReturnType<typeof fs.stat>);
  f.historyButton.click();
  const oldReading = f.plugin.conversationSizes.refresh(f.input.id);
  const oldLine = f.line();
  await Promise.resolve();
  const replacementPath = join(dir, 'p2-replacement.jsonl');
  await writeFile(replacementPath, '123456');
  const replacement = { ...f.input, title: 'Replacement', providerState: { sessionFilePath: replacementPath } };
  (f.plugin as unknown as { conversations: Conversation[] }).conversations = [replacement, f.other];
  try {
    f.badge().dispatchEvent(new MouseEvent('mouseenter'));
    await f.plugin.conversationSizes.refresh(replacement.id);
    expect(oldLine.textContent).toContain('unknown');
    expect(f.badge().getAttribute('aria-label')).toContain('6 B');
    pending.resolve(captured);
    expect(await oldReading).toBeUndefined();
    f.fields.updateHistoryDropdown();
    expect(f.line().textContent).toContain('6 B');
    expect(oldLine.textContent).toContain('unknown');
    expect(stat).toHaveBeenCalledTimes(2);
  } finally { pending.resolve(captured); await oldReading; }
});

it.each([false, true])('P2-3 preserves metadata outcome despite background refresh failure (metadata failed=%s)', async failed => {
  const f = await fixture(`p2-background-error-${failed}`);
  const savedId = f.input.id;
  const descriptor = Object.getOwnPropertyDescriptor(f.input, 'id')!;
  const metadataFailure = new Error('controlled metadata failure');
  const refreshFailure = new Error('controlled source lookup failure');
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  const stat = jest.spyOn(fs, 'stat');
  const sessions = new SessionStorage({ exists: async () => false,
    write: async () => {
      // The completed metadata operation precedes a failing source lookup.
      Object.defineProperty(f.input, 'id', { configurable: true, enumerable: true, get: () => { throw refreshFailure; } });
      if (failed) throw metadataFailure;
    }, delete: async () => {},
  } as unknown as VaultFileAdapter);
  f.plugin.storage = { sessions } as never;
  const controller = new ConversationController({ plugin: f.plugin, state: f.tab.state,
    getFileContextManager: () => null, getExternalContextSelector: () => null,
    getAgentService: () => null, isHydrationReady: () => true,
  } as unknown as ConversationControllerDeps);
  try {
    const outcome = await controller.save().then(() => null, error => error);
    expect(outcome).toBe(failed ? metadataFailure : null);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
    expect(f.tab.state.currentConversationId).toBe(savedId);
  } finally {
    Object.defineProperty(f.input, 'id', descriptor);
    process.off('unhandledRejection', listener);
  }
});

it('opens history and refreshes known values through the real view/controller chain without metadata or hydration', async () => {
  const f = await fixture('menu-refresh');
  const history = ProviderRegistry.getConversationHistoryService('codex');
  const hydrate = jest.spyOn(history, 'hydrateConversationHistory');
  const find = jest.spyOn(codexStore, 'findCodexSessionFile');
  const build = jest.spyOn(index, 'buildTranscriptIndex');
  f.historyButton.click();
  await f.plugin.conversationSizes.refresh(f.input.id);
  expect(f.line().textContent).toContain('3 B');
  expect(f.line().textContent).not.toMatch(/Complete history|turns|messages|Associated files/);
  f.historyButton.click();
  await appendFile(f.path, '456');
  f.historyButton.click();
  await f.plugin.conversationSizes.refresh(f.input.id);
  expect(f.line().textContent).toContain('6 B');
  expect(f.write).not.toHaveBeenCalled();
  expect(hydrate).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
});

it('connects mouseenter to onTabSizeRequest, refreshes known bytes, and preserves drag nodes on publication', async () => {
  const f = await fixture('hover-refresh');
  const read = jest.spyOn(ProviderRegistry.getConversationHistoryService('codex'), 'readConversationSize');
  const reorder = jest.spyOn(f.fields as unknown as { handleTabReorder(id: string, index: number): void }, 'handleTabReorder').mockImplementation(() => {});
  const original = f.badge();
  original.dispatchEvent(new MouseEvent('mouseenter'));
  await f.plugin.conversationSizes.refresh(f.input.id);
  f.paint();
  expect(original.getAttribute('aria-label')).toContain('3 B');
  expect(f.badge()).toBe(original);
  expect(original.getAttribute('title')).toBeNull();
  original.dispatchEvent(new MouseEvent('mouseleave'));
  await appendFile(f.path, '456');
  original.dispatchEvent(new MouseEvent('mouseenter'));
  original.dispatchEvent(new Event('dragstart'));
  await f.plugin.conversationSizes.refresh(f.input.id);
  f.paint();
  expect(f.badge()).toBe(original);
  expect(original.classList.contains('claudian-tab-badge-dragging')).toBe(true);
  expect(original.getAttribute('aria-label')).toContain('6 B');
  expect(read).toHaveBeenCalledTimes(2);
  const target = f.fields.tabBarContainerEl.lastElementChild!;
  target.dispatchEvent(new MouseEvent('drop', { clientX: 1, cancelable: true }));
  expect(reorder).toHaveBeenCalledWith('tab-one', 1);
  expect(f.write).not.toHaveBeenCalled();
});

it('does not start another stat when an open history menu rerenders', async () => {
  const f = await fixture('menu-no-loop');
  const read = jest.spyOn(ProviderRegistry.getConversationHistoryService('codex'), 'readConversationSize');
  f.historyButton.click();
  await f.plugin.conversationSizes.refresh(f.input.id);
  const reads = read.mock.calls.length;
  f.fields.updateHistoryDropdown();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(reads);
  expect(f.line().textContent).toContain('3 B');
});

it('refreshes file bytes after a real normal save even when metadata writing fails', async () => {
  const f = await fixture('save-independent');
  const files = new Map<string, string>();
  const failure = new Error('controlled metadata failure');
  const write = jest.fn(async (_name: string, data: string) => {
    files.set(_name, data);
    throw failure;
  });
  const sessions = new SessionStorage({ exists: async (name: string) => files.has(name),
    read: async (name: string) => files.get(name)!, write,
    delete: async () => {}, listFiles: async () => [],
  } as unknown as VaultFileAdapter);
  f.plugin.storage = { sessions } as never;
  const controller = new ConversationController({ plugin: f.plugin, state: f.tab.state,
    getFileContextManager: () => null, getExternalContextSelector: () => null,
    getAgentService: () => null, isHydrationReady: () => true,
  } as unknown as ConversationControllerDeps);
  const hydrate = jest.spyOn(ProviderRegistry.getConversationHistoryService('codex'), 'hydrateConversationHistory');
  f.badge().dispatchEvent(new MouseEvent('mouseenter'));
  await f.plugin.conversationSizes.refresh(f.input.id);
  await appendFile(f.path, '456');
  await expect(controller.save()).rejects.toBe(failure);
  await f.plugin.conversationSizes.refresh(f.input.id);
  expect(f.plugin.conversationSizes.getSnapshot(f.input.id)?.files).toEqual({ status: 'known', bytes: 6 });
  expect(f.badge().getAttribute('aria-label')).toContain('6 B');
  expect(write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(write.mock.calls[0][1])).not.toHaveProperty('sizeSnapshot');
  expect(f.input).not.toHaveProperty('sizeSnapshot');
  expect(hydrate).not.toHaveBeenCalled();
});

it.each(['closed', 'reopened', 'rerendered'] as const)('does not apply a previous menu request to %s nodes', async action => {
  const f = await fixture(`menu-${action}`);
  const actualStat = fs.stat;
  const captured = await actualStat(f.path);
  let release!: () => void;
  const pending = new Promise<Awaited<ReturnType<typeof fs.stat>>>(resolve => { release = () => resolve(captured); });
  jest.spyOn(fs, 'stat').mockImplementationOnce(() => pending as ReturnType<typeof fs.stat>);
  f.historyButton.click();
  const oldLine = f.line();
  const oldText = oldLine.textContent;
  const old = f.plugin.conversationSizes.refresh(f.input.id);
  await Promise.resolve();
  if (action === 'rerendered') f.fields.updateHistoryDropdown();
  else f.historyButton.click();
  let reopened: ReturnType<typeof f.plugin.conversationSizes.refresh> | undefined;
  if (action === 'reopened') {
    await appendFile(f.path, '456');
    f.historyButton.click();
    reopened = f.plugin.conversationSizes.refresh(f.input.id);
  }
  release();
  await Promise.all([old, reopened]);
  expect(oldLine.textContent).toBe(oldText);
  const currentSize = expect.stringContaining('6 B');
  expect(action === 'reopened' ? f.line().textContent : null).toEqual(action === 'reopened' ? currentSize : null);
  expect(f.fields.historyDropdown.classList.contains('visible')).toBe(action !== 'closed');
});

it('keeps a fresh rehover result when the previous hover stat arrives last', async () => {
  const f = await fixture('rehover-race');
  const actualStat = fs.stat;
  const captured = await actualStat(f.path);
  let release!: () => void;
  const pending = new Promise<Awaited<ReturnType<typeof fs.stat>>>(resolve => { release = () => resolve(captured); });
  jest.spyOn(fs, 'stat').mockImplementationOnce(() => pending as ReturnType<typeof fs.stat>);
  const badge = f.badge();
  badge.dispatchEvent(new MouseEvent('mouseenter'));
  const old = f.plugin.conversationSizes.refresh(f.input.id);
  await Promise.resolve();
  badge.dispatchEvent(new MouseEvent('mouseleave'));
  await appendFile(f.path, '456');
  badge.dispatchEvent(new MouseEvent('mouseenter'));
  await f.plugin.conversationSizes.refresh(f.input.id);
  expect(badge.getAttribute('aria-label')).toContain('6 B');
  release();
  expect(await old).toBeUndefined();
  expect(badge.getAttribute('aria-label')).toContain('6 B');
});

it.each(['leave', 'rebind', 'close', 'reopen'] as const)('rejects a late hover result after tab %s', async action => {
  const f = await fixture(`tab-${action}`);
  const actualStat = fs.stat;
  const captured = await actualStat(f.path);
  let release!: () => void;
  const pending = new Promise<Awaited<ReturnType<typeof fs.stat>>>(resolve => { release = () => resolve(captured); });
  jest.spyOn(fs, 'stat').mockImplementationOnce(() => pending as ReturnType<typeof fs.stat>);
  const oldBadge = f.badge();
  const oldLabel = oldBadge.getAttribute('aria-label');
  oldBadge.dispatchEvent(new MouseEvent('mouseenter'));
  const old = f.plugin.conversationSizes.refresh(f.input.id);
  await Promise.resolve();
  if (action === 'leave') oldBadge.dispatchEvent(new MouseEvent('mouseleave'));
  if (action === 'rebind') f.tab.conversationId = f.other.id;
  if (action === 'close' || action === 'reopen') f.managerFields.tabs.delete(f.tab.id);
  if (action !== 'leave') { f.fields.updateTabBar(); f.paint(); }
  if (action === 'reopen') {
    f.managerFields.tabs.set(f.tab.id, { ...f.tab });
    f.fields.updateTabBar();
    f.paint();
  }
  release();
  await old;
  f.paint();
  expect(oldBadge.getAttribute('aria-label')).toBe(oldLabel);
  const reopenedLabel = action === 'reopen' ? f.fields.tabBarContainerEl.lastElementChild!.getAttribute('aria-label') : '';
  expect(reopenedLabel).not.toContain('3 B');
});
