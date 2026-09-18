import { createMockEl } from '@test/helpers/mockElement';
import { Menu, Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ConversationController, type ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import * as historySearchModule from '@/features/chat/controllers/HistorySearchController';
import { ProjectionWriteCoordinator } from '@/features/chat/rendering/ProjectionWriteCoordinator';
import { ChatState } from '@/features/chat/state/ChatState';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { confirm } from '@/shared/modals/ConfirmModal';

// Hydration usage re-derivation needs a real chat UI config behind the
// provider registry; only the config seam is registered. The empty
// historyService keeps bindHistoryLease on its legacy reset path instead of
// throwing on a missing registration.
ProviderRegistry.register('claude', {
  chatUIConfig: claudeChatUIConfig,
  historyService: {},
} as never);

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/utils/path', () => ({ getVaultPath: jest.fn().mockReturnValue('/vault') }));

const mockNotice = Notice as jest.Mock;

function createMockDeps(overrides: Partial<ConversationControllerDeps> = {}): ConversationControllerDeps {
  const state = new ChatState();
  const inputEl = { value: '', focus: jest.fn() } as unknown as HTMLTextAreaElement;
  const historyDropdown = createMockEl();
  let welcomeEl: any = createMockEl();
  const messagesEl = createMockEl();

  const fileContextManager = {
    resetForNewConversation: jest.fn(),
    resetForLoadedConversation: jest.fn(),
    autoAttachActiveFile: jest.fn(),
    setCurrentNote: jest.fn(),
    getCurrentNotePath: jest.fn().mockReturnValue(null),
  };

  return {
    plugin: {
      createConversation: jest.fn().mockResolvedValue({
        id: 'new-conv',
        title: 'New Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      switchConversation: jest.fn().mockResolvedValue({
        id: 'switched-conv',
        title: 'Switched Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      getConversationById: jest.fn().mockResolvedValue(null),
      getConversationSync: jest.fn().mockReturnValue(null),
      getConversationList: jest.fn().mockReturnValue([]),
      findEmptyConversation: jest.fn().mockResolvedValue(null),
      updateConversation: jest.fn().mockResolvedValue(undefined),
      renameConversation: jest.fn().mockResolvedValue(undefined),
      deleteConversation: jest.fn().mockResolvedValue(undefined),
      agentService: {
        getSessionId: jest.fn().mockResolvedValue(null),
        setSessionId: jest.fn(),
      },
      settings: {
        userName: '',
        enableAutoTitleGeneration: true,
        permissionMode: 'yolo',
      },
    } as any,
    state,
    renderer: {
      renderMessages: jest.fn().mockReturnValue(createMockEl()),
      renderHistoryPager: jest.fn(),
      prependMessages: jest.fn(),
      renderSearchCandidate: jest.fn(),
      waitForMessageContentRendered: jest.fn().mockResolvedValue(undefined),
      waitForRenderedMessages: jest.fn().mockResolvedValue(undefined),
      findMessageElement: jest.fn(),
      highlightSearchMatch: jest.fn(),
    } as any,
    subagentManager: {
      orphanAllActive: jest.fn(),
      clear: jest.fn(),
    } as any,
    getHistoryDropdown: () => historyDropdown as any,
    getWelcomeEl: () => welcomeEl,
    setWelcomeEl: (el: any) => { welcomeEl = el; },
    getMessagesEl: () => messagesEl as any,
    getInputEl: () => inputEl,
    getFileContextManager: () => fileContextManager as any,
    getImageContextManager: () => ({
      clearImages: jest.fn(),
    }) as any,
    getMcpServerSelector: () => ({
      clearEnabled: jest.fn(),
      getEnabledServers: jest.fn().mockResolvedValue(new Set()),
      setEnabledServers: jest.fn(),
    }) as any,
    getExternalContextSelector: () => ({
      getExternalContexts: jest.fn().mockReturnValue([]),
      setExternalContexts: jest.fn(),
      clearExternalContexts: jest.fn(),
    }) as any,
    clearQueuedMessage: jest.fn(),
    getTitleGenerationService: () => null,
    getHistoryIndexCapableService: () => null,
    getStatusPanel: () => ({
      remount: jest.fn(),
    }) as any,
    ...overrides,
  };
}

describe('ConversationController', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    (Menu as typeof Menu & { instances: unknown[] }).instances.length = 0;
    deps = createMockDeps();
    controller = new ConversationController(deps);
  });

  describe('paged history', () => {
    const makeLease = (totalTurns = 120) => ({
      conversationId: 'large', totalTurns, ready: Promise.resolve(), release: jest.fn(), search: jest.fn(),
      loadMessageDetail: jest.fn().mockImplementation(async (projectionKey: string) => ({
        status: 'exact', message: { id: projectionKey, role: 'user', content: 'needle', timestamp: 1, projectionLevel: 'detail' },
      })),
      loadWindow: jest.fn(),
      planWindow: jest.fn().mockImplementation(({ anchorTurn, direction, budget }: any) => {
        const turns = Math.min(budget.maxTurns, anchorTurn);
        return { start: direction === 'older' ? anchorTurn - turns : anchorTurn, end: direction === 'older' ? anchorTurn : anchorTurn + turns };
      }),
    });

    it('restores a Claude draft without transcript identity instead of indexing it', async () => {
      const draft = {
        id: 'draft', providerId: 'claude', title: 'Draft', messages: [
          { id: 'draft-user', role: 'user', content: 'unsent transcript tail', timestamp: 1 },
        ], createdAt: 1, updatedAt: 1,
      } as any;
      deps.state.currentConversationId = 'draft';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(draft);
      const acquireHistoryIndex = jest.fn();
      deps.getHistoryIndexCapableService = () => ({
        acquireHistoryIndex,
        resolveSessionIdForConversation: jest.fn().mockReturnValue(null),
        isPendingForkConversation: jest.fn().mockReturnValue(false),
      } as any);

      await controller.loadActive();

      expect(acquireHistoryIndex).not.toHaveBeenCalled();
      expect(deps.state.messages).toEqual(draft.messages);
      expect(deps.renderer.renderMessages).toHaveBeenCalled();
    });

    it('loads indexed history through the single first-screen path', async () => {
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      deps.state.currentConversationId = 'large';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(conversation);
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const lease = makeLease();
      lease.loadWindow.mockResolvedValue({ messages: [{ id: 'latest', role: 'user', content: 'latest', timestamp: 1 }], range: { start: 110, end: 120 }, snapshotOffset: 123, sourceBytes: 1024, projectedChars: 7, oversizedTurnCount: 0, pageKey: 'w:110:120', hasMoreBefore: true, hasMoreAfter: false });
      const service = { acquireHistoryIndex: jest.fn().mockReturnValue(lease) };
      deps.getHistoryIndexCapableService = () => service as any;

      await controller.loadActive();

      expect(lease.loadWindow).toHaveBeenCalledWith(expect.objectContaining({
        anchorTurn: 120,
        direction: 'older',
        projectionLevel: 'summary',
        budget: expect.objectContaining({ maxTurns: 200, maxSourceBytes: 8 * 1024 * 1024, maxProjectedChars: 2_000_000 }),
      }));
      expect(deps.state.loadedRanges).toEqual([{ start: 110, end: 120 }]);
      expect(deps.state.historyHasMore).toBe(true);
      expect(deps.state.historySnapshotOffset).toBe(123);
      expect(deps.state.historyLease).toBe(lease);
      expect(lease.release).not.toHaveBeenCalled();
    });

    it('backfills legacy metadata before runtime initialization', async () => {
      const conversation = { id: 'legacy', providerId: 'claude', title: 'Legacy', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      deps.state.currentConversationId = 'legacy';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(conversation);
      const lease = makeLease(1);
      lease.loadWindow.mockResolvedValue({
        messages: [{ id: 'first', role: 'user', content: 'legacy first request', timestamp: 1 }],
        range: { start: 0, end: 1 }, sourceBytes: 10, projectedChars: 20,
        oversizedTurnCount: 0, pageKey: 'w:0:1', hasMoreBefore: false, hasMoreAfter: false,
      });
      deps.getHistoryIndexCapableService = () => ({ acquireHistoryIndex: () => lease } as any);
      deps.ensureServiceForConversation = jest.fn(async (shell) => {
        expect(shell).toMatchObject({ hasHistory: true, messageCount: 1 });
      });

      await controller.loadActive();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('legacy', expect.objectContaining({
        hasHistory: true,
        messageCount: 1,
        preview: 'legacy first request',
        firstUserExcerpt: 'legacy first request',
      }));
    });

    it('does not backfill messageCount from a partial window', async () => {
      const conversation = { id: 'legacy', providerId: 'claude', title: 'Legacy', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      deps.state.currentConversationId = 'legacy';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(conversation);
      const lease = makeLease(120);
      lease.loadWindow.mockResolvedValue({
        messages: [{ id: 'latest', role: 'user', content: 'latest request', timestamp: 1 }],
        range: { start: 110, end: 120 }, sourceBytes: 10, projectedChars: 20,
        oversizedTurnCount: 0, pageKey: 'w:snapshot:110:120', hasMoreBefore: true, hasMoreAfter: false,
      });
      deps.getHistoryIndexCapableService = () => ({ acquireHistoryIndex: () => lease } as any);

      await controller.loadActive();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('legacy', expect.not.objectContaining({ messageCount: expect.anything() }));
    });

    it('releases the previous lease when indexed loadActive repeats', async () => {
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      deps.state.currentConversationId = 'large';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(conversation);
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const first = makeLease();
      const second = makeLease();
      const page = { messages: [{ id: 'latest', role: 'user', content: 'latest', timestamp: 1 }], range: { start: 110, end: 120 }, snapshotOffset: 123, sourceBytes: 1024, projectedChars: 7, oversizedTurnCount: 0, pageKey: 'w:110:120', hasMoreBefore: true, hasMoreAfter: false };
      first.loadWindow.mockResolvedValue(page);
      second.loadWindow.mockResolvedValue(page);
      const service = { acquireHistoryIndex: jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) };
      deps.getHistoryIndexCapableService = () => service as any;

      await controller.loadActive();
      expect(first.release).not.toHaveBeenCalled();

      // Tab switched away before hydrate READY and back: a second oversize
      // loadActive must release the first lease instead of leaking it.
      await controller.loadActive();

      expect(first.release).toHaveBeenCalledTimes(1);
      expect(deps.state.historyLease).toBe(second);
      expect(second.release).not.toHaveBeenCalled();
    });

    it('releases the lease exactly once when the window load fails', async () => {
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      deps.state.currentConversationId = 'large';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(conversation);
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const lease = makeLease();
      lease.loadWindow.mockRejectedValue(new Error('materialization failed'));
      const service = { acquireHistoryIndex: jest.fn().mockReturnValue(lease) };
      deps.getHistoryIndexCapableService = () => service as any;

      await expect(controller.loadActive()).rejects.toThrow('materialization failed');

      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(deps.state.historyLease).toBeNull();
      expect(deps.state.historyLoading).toBe(false);
    });

    it('releases the lease when the index build fails', async () => {
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      deps.state.currentConversationId = 'large';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(conversation);
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const lease = makeLease();
      (lease as any).ready = Promise.reject(new Error('index build failed'));
      const service = { acquireHistoryIndex: jest.fn().mockReturnValue(lease) };
      deps.getHistoryIndexCapableService = () => service as any;

      await expect(controller.loadActive()).rejects.toThrow('index build failed');

      expect(lease.release).toHaveBeenCalledTimes(1);
    });

    it('releases the lease when the generation is invalidated before applying', async () => {
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      deps.state.currentConversationId = 'large';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(conversation);
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const lease = makeLease();
      lease.loadWindow.mockResolvedValue({ messages: [{ id: 'latest', role: 'user', content: 'latest', timestamp: 1 }], range: { start: 110, end: 120 }, snapshotOffset: 123, sourceBytes: 1024, projectedChars: 7, oversizedTurnCount: 0, pageKey: 'w:110:120', hasMoreBefore: true, hasMoreAfter: false });
      const service = { acquireHistoryIndex: jest.fn().mockReturnValue(lease) };
      deps.getHistoryIndexCapableService = () => service as any;

      await controller.loadActive(() => false);

      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(deps.state.historyLease).toBeNull();
    });

    it('loads a distant hit once then fills the newest-side gap when loading older', async () => {
      deps.state.currentConversationId = 'large';
      deps.state.messages = [{ id: 'latest', role: 'user', content: 'latest', timestamp: 100 }];
      const lease = makeLease(200);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 150, end: 200 }];
      deps.state.historyHasMore = true;
      lease.loadWindow
        .mockResolvedValueOnce({ messages: [{ id: 'target', role: 'user', content: 'needle', timestamp: 50 }], range: { start: 25, end: 26 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:25:26', hasMoreBefore: true, hasMoreAfter: true })
        .mockResolvedValueOnce({ messages: [{ id: 'gap', role: 'user', content: 'gap', timestamp: 75 }], range: { start: 100, end: 150 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:100:150', hasMoreBefore: true, hasMoreAfter: false });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValueOnce(null).mockReturnValue({} as HTMLElement);

      await controller.locateHistorySearchResult({ projectionKey: 'target', turnIndex: 25, matchOrdinal: 0, matchedText: 'needle' });
      await controller.loadOlderHistory();

      // Locate materializes only the hit turn through the searchLocate budget.
      expect(lease.loadWindow).toHaveBeenNthCalledWith(1, expect.objectContaining({ anchorTurn: 25, direction: 'around', budget: expect.objectContaining({ maxTurns: 1 }) }));
      // Anchor at the newest loaded range start; floor at the older range end.
      expect(lease.loadWindow).toHaveBeenNthCalledWith(2, expect.objectContaining({ anchorTurn: 150, direction: 'older', minTurn: 26 }));
      expect(deps.state.loadedRanges).toEqual([{ start: 25, end: 26 }, { start: 100, end: 200 }]);
      expect(deps.renderer.prependMessages).toHaveBeenCalledTimes(1);
      expect(deps.renderer.renderMessages).toHaveBeenCalledTimes(1);
    });

    it('reuses loaded message nodes and preserves the scroll anchor when loading earlier', async () => {
      deps.state.currentConversationId = 'large';
      const existing = { id: 'latest', role: 'user', content: 'latest', timestamp: 100, displayOrder: [1, 0, 0] } as any;
      deps.state.messages = [existing];
      const lease = makeLease(100);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 50, end: 100 }];
      deps.state.historyHasMore = true;
      const older = { id: 'older', role: 'user', content: 'older', timestamp: 1, displayOrder: [0, 0, 0] } as any;
      lease.loadWindow.mockResolvedValue({ messages: [older], range: { start: 0, end: 50 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:0:50', hasMoreBefore: false, hasMoreAfter: true });

      await controller.loadOlderHistory();

      expect(deps.renderer.prependMessages).toHaveBeenCalledWith([older], [older, existing]);
      expect(deps.renderer.renderMessages).not.toHaveBeenCalled();
      expect(deps.state.historyHasMore).toBe(false);
    });

    it('locates a distant search hit through the searchLocate budget window', async () => {
      deps.state.currentConversationId = 'large';
      deps.state.messages = [{ id: 'latest', role: 'user', content: 'latest', timestamp: 100, displayOrder: [1, 0, 0] }];
      const lease = makeLease(200);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 150, end: 200 }];
      lease.loadWindow.mockResolvedValueOnce({ messages: [{ id: 'target', role: 'user', content: 'needle', timestamp: 50, displayOrder: [0, 25, 0] }], range: { start: 25, end: 26 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:25:26', hasMoreBefore: true, hasMoreAfter: true });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValueOnce(null).mockReturnValue({} as HTMLElement);

      await controller.locateHistorySearchResult({ projectionKey: 'target', turnIndex: 25, matchOrdinal: 0, matchedText: 'needle' });

      expect(lease.loadWindow).toHaveBeenCalledWith(expect.objectContaining({
        anchorTurn: 25,
        direction: 'around',
        projectionLevel: 'summary',
        budget: expect.objectContaining({ maxTurns: 1, maxSourceBytes: 8 * 1024 * 1024, maxProjectedChars: 2_000_000 }),
      }));
      expect(deps.state.loadedRanges).toEqual([{ start: 25, end: 26 }, { start: 150, end: 200 }]);
      expect(deps.state.messages.map(message => message.id)).toEqual(['target', 'latest']);
    });

    it('does not paginate when a search hit is already loaded', async () => {
      const lease = makeLease(100);
      deps.state.historyLease = lease as any;
      const loaded = {} as HTMLElement;
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValue(loaded);

      await expect(controller.locateHistorySearchResult({ projectionKey: 'loaded', turnIndex: 10, matchOrdinal: 0, matchedText: 'needle' })).resolves.toBe(loaded);

    });

    it('reuses an offscreen rendered candidate across different queries', async () => {
      const lease = makeLease(10);
      deps.state.historyLease = lease as any;
      lease.search
        .mockResolvedValueOnce([{ projectionKey: 'target', turnIndex: 3, matchOrdinal: 0, matchedText: 'needle' }])
        .mockResolvedValueOnce([{ projectionKey: 'target', turnIndex: 3, matchOrdinal: 0, matchedText: 'other' }]);
      lease.loadMessageDetail.mockResolvedValue({ status: 'exact', message: { id: 'target', role: 'user', content: 'needle other', timestamp: 1, projectionLevel: 'detail' } });
      const detached = createMockEl() as unknown as HTMLElement;
      (deps.renderer.renderSearchCandidate as jest.Mock).mockResolvedValue(detached);

      await controller.searchHistory('needle');
      await controller.searchHistory('other');

      expect(deps.renderer.renderSearchCandidate).toHaveBeenCalledTimes(1);
    });

    it('rolls back to the previous lease when a search snapshot refresh fails', async () => {
      deps.state.currentConversationId = 'large';
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const previous = makeLease(100);
      deps.state.historyLease = previous as any;
      deps.state.loadedRanges = [{ start: 50, end: 100 }];
      deps.state.historyHasMore = true;
      const older = { id: 'older', role: 'user', content: 'older', timestamp: 1 } as any;
      previous.loadWindow.mockResolvedValue({ messages: [older], range: { start: 0, end: 50 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:0:50', hasMoreBefore: false, hasMoreAfter: true });
      const failed = { ...makeLease(100), ready: Promise.reject(new Error('index build failed')) };
      const service = { acquireHistoryIndex: jest.fn().mockReturnValue(failed) };
      deps.getHistoryIndexCapableService = () => service as any;

      await expect(controller.refreshHistorySearchSnapshot()).rejects.toThrow('index build failed');

      expect(deps.state.historyLease).toBe(previous);
      expect(previous.release).not.toHaveBeenCalled();
      await controller.loadOlderHistory();
      expect(deps.state.loadedRanges).toEqual([{ start: 0, end: 100 }]);
      expect(deps.state.historyHasMore).toBe(false);
      expect(deps.renderer.prependMessages).toHaveBeenCalledWith([older], [older]);
    });

    it('surfaces projection_mismatch after window materialization', async () => {
      deps.state.currentConversationId = 'large';
      const lease = makeLease(10); deps.state.historyLease = lease as any;
      lease.loadWindow.mockResolvedValue({ messages: [], range: { start: 3, end: 4 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:3:4', hasMoreBefore: true, hasMoreAfter: true });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValue(null);
      await expect(controller.locateHistorySearchResult({ projectionKey: 'missing', turnIndex: 3, matchOrdinal: 0, matchedText: 'needle' })).rejects.toThrow('projection_mismatch');
    });


    it('keeps progress reporting for the paged first-screen acquire', async () => {
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      deps.state.currentConversationId = 'large';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(conversation);
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const lease = makeLease();
      lease.loadWindow.mockResolvedValue({ messages: [{ id: 'latest', role: 'user', content: 'latest', timestamp: 1 }], range: { start: 110, end: 120 }, snapshotOffset: 123, sourceBytes: 1024, projectedChars: 7, oversizedTurnCount: 0, pageKey: 'w:110:120', hasMoreBefore: true, hasMoreAfter: false });
      const service = { acquireHistoryIndex: jest.fn().mockReturnValue(lease) };
      deps.getHistoryIndexCapableService = () => service as any;

      await controller.loadActive();

      // The oversize first screen shows index phases on the placeholder, so
      // this acquire keeps its progress callback (default semantics).
      expect(service.acquireHistoryIndex).toHaveBeenCalledWith(conversation, '/vault', expect.any(Function));
    });

    it('refreshes the search snapshot silently (runs after READY with rendered messages)', async () => {
      deps.state.currentConversationId = 'large';
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const previous = makeLease(100);
      deps.state.historyLease = previous as any;
      const next = makeLease(100);
      const service = { acquireHistoryIndex: jest.fn().mockReturnValue(next) };
      deps.getHistoryIndexCapableService = () => service as any;

      await controller.refreshHistorySearchSnapshot();

      expect(service.acquireHistoryIndex).toHaveBeenCalledWith(conversation, '/vault', undefined, true);
      expect(previous.release).toHaveBeenCalled();
    });

    // ============================================
    // Projection write lease (coord protocol P3)
    // ============================================

    it('defers an unloaded search locate behind a live streaming turn and merges the streamed messages', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      deps.getProjectionCoordinator = () => coordinator;
      deps.state.currentConversationId = 'large';
      deps.state.messages = [
        { id: 'old-1', role: 'user', content: 'old', timestamp: 1 },
        { id: 'streamed', role: 'assistant', content: 'live turn output', timestamp: 2 },
      ] as any;
      const lease = makeLease(200);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 150, end: 200 }];
      lease.loadWindow.mockResolvedValue({ messages: [{ id: 'hit', role: 'user', content: 'needle', timestamp: 0 }], range: { start: 25, end: 26 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:25:26', hasMoreBefore: true, hasMoreAfter: true });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValueOnce(null).mockReturnValue({} as HTMLElement);
      const liveLease = await coordinator.acquireLive();

      const locatePromise = controller.locateHistorySearchResult({ projectionKey: 'hit', turnIndex: 25, matchOrdinal: 0, matchedText: 'needle' });
      await Promise.resolve();
      await Promise.resolve();

      // P3: the live turn is streaming — the re-locate must not clear-rebuild.
      expect(lease.loadWindow).not.toHaveBeenCalled();
      expect(deps.renderer.renderMessages).not.toHaveBeenCalled();

      liveLease!.release();
      await locatePromise;

      // After the live turn ends, the rebuild merges the latest ChatState —
      // including the streamed message — with the materialized hit window.
      expect(lease.loadWindow).toHaveBeenCalledWith(expect.objectContaining({ anchorTurn: 25, direction: 'around' }));
      const rendered = (deps.renderer.renderMessages as jest.Mock).mock.calls[0][0] as Array<{ id: string }>;
      expect(rendered.map(message => message.id)).toEqual(expect.arrayContaining(['old-1', 'streamed', 'hit']));
    });

    it('drops a queued search locate when the conversation switches while waiting', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      deps.getProjectionCoordinator = () => coordinator;
      deps.state.currentConversationId = 'large';
      const lease = makeLease(200);
      deps.state.historyLease = lease as any;
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValue(null);
      const liveLease = await coordinator.acquireLive();

      const locatePromise = controller.locateHistorySearchResult({ projectionKey: 'hit', turnIndex: 25, matchOrdinal: 0, matchedText: 'needle' });
      await Promise.resolve();

      // Switch away while the locate waits for the live turn: the stale
      // transaction must never redraw into the new conversation.
      deps.state.currentConversationId = 'switched';
      liveLease!.release();

      await expect(locatePromise).rejects.toThrow('projection_mismatch');
      expect(lease.loadWindow).not.toHaveBeenCalled();
      expect(deps.renderer.renderMessages).not.toHaveBeenCalled();
    });

    it('serializes paging and search locate stored transactions', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      deps.getProjectionCoordinator = () => coordinator;
      deps.state.currentConversationId = 'large';
      deps.state.messages = [{ id: 'latest', role: 'user', content: 'latest', timestamp: 100 }] as any;
      const lease = makeLease(200);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 150, end: 200 }];
      lease.loadWindow
        .mockResolvedValueOnce({ messages: [{ id: 'older', role: 'user', content: 'older', timestamp: 50 }], range: { start: 100, end: 150 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:100:150', hasMoreBefore: true, hasMoreAfter: false })
        .mockResolvedValueOnce({ messages: [{ id: 'hit', role: 'user', content: 'needle', timestamp: 0 }], range: { start: 25, end: 26 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:25:26', hasMoreBefore: true, hasMoreAfter: true });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValueOnce(null).mockReturnValue({} as HTMLElement);

      // A stored transaction already in flight (e.g. an earlier paging load).
      let releaseInFlight!: () => void;
      const inFlight = coordinator.runStored(
        () => false,
        () => new Promise<void>(resolve => { releaseInFlight = resolve; }),
      );
      await Promise.resolve();

      const pagingPromise = controller.loadOlderHistory();
      const locatePromise = controller.locateHistorySearchResult({ projectionKey: 'hit', turnIndex: 25, matchOrdinal: 0, matchedText: 'needle' });
      await Promise.resolve();
      await Promise.resolve();

      // Both queue behind the in-flight transaction: nothing interleaves.
      expect(lease.loadWindow).not.toHaveBeenCalled();

      releaseInFlight();
      await inFlight;
      await pagingPromise;
      await locatePromise;

      // Each ran exactly once, serialized through the FIFO.
      expect(lease.loadWindow).toHaveBeenCalledTimes(2);
      expect(deps.state.loadedRanges).toEqual(expect.arrayContaining([{ start: 25, end: 26 }, { start: 100, end: 200 }]));
    });

    // ============================================
    // Conversation revalidation inside granted stored tasks (design §3.6)
    // ============================================

    it('discards a granted search locate when the conversation switches during loadWindow', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      deps.getProjectionCoordinator = () => coordinator;
      deps.state.currentConversationId = 'large';
      deps.state.messages = [{ id: 'old-1', role: 'user', content: 'old', timestamp: 1 }] as any;
      const lease = makeLease(200);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 150, end: 200 }];
      lease.loadWindow.mockImplementationOnce(async () => {
        // switchTo does not set isStreaming: the user can switch while the
        // already-granted transaction is suspended on the window load.
        deps.state.currentConversationId = 'switched';
        deps.state.messages = [{ id: 'new-1', role: 'user', content: 'new', timestamp: 1 }] as any;
        deps.state.loadedRanges = [];
        return { messages: [{ id: 'hit', role: 'user', content: 'needle', timestamp: 0 }], range: { start: 25, end: 26 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:25:26', hasMoreBefore: true, hasMoreAfter: true };
      });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValue(null);

      await expect(controller.locateHistorySearchResult({ projectionKey: 'hit', turnIndex: 25, matchOrdinal: 0, matchedText: 'needle' })).rejects.toThrow('projection_mismatch');

      // The stale page never merges into, renders into, or paginates the
      // switched-to conversation.
      expect(deps.renderer.renderMessages).not.toHaveBeenCalled();
      expect(deps.state.messages.map(message => message.id)).toEqual(['new-1']);
      expect(deps.state.loadedRanges).toEqual([]);
    });

    it('leaves pagination state untouched when the conversation switches while the rebuild drains', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      deps.getProjectionCoordinator = () => coordinator;
      deps.state.currentConversationId = 'large';
      deps.state.messages = [{ id: 'old-1', role: 'user', content: 'old', timestamp: 1 }] as any;
      const lease = makeLease(200);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 150, end: 200 }];
      lease.loadWindow.mockResolvedValueOnce({ messages: [{ id: 'hit', role: 'user', content: 'needle', timestamp: 0 }], range: { start: 25, end: 26 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:25:26', hasMoreBefore: true, hasMoreAfter: true });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValueOnce(null).mockReturnValue({} as HTMLElement);
      (deps.renderer.waitForRenderedMessages as jest.Mock).mockImplementationOnce(async () => {
        // The rebuild already rendered; switchTo's restoreConversation reset
        // the pagination state of the conversation this transaction served.
        deps.state.currentConversationId = 'switched';
        deps.state.loadedRanges = [];
      });

      await controller.locateHistorySearchResult({ projectionKey: 'hit', turnIndex: 25, matchOrdinal: 0, matchedText: 'needle' });

      expect(deps.state.loadedRanges).toEqual([]);
      expect(deps.state.historyHasMore).toBe(false);
    });

    it('discards an in-flight older-window page when the conversation switches mid-load', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      deps.getProjectionCoordinator = () => coordinator;
      deps.state.currentConversationId = 'large';
      const existing = { id: 'latest', role: 'user', content: 'latest', timestamp: 100 } as any;
      deps.state.messages = [existing];
      const lease = makeLease(100);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 50, end: 100 }];
      deps.state.historyHasMore = true;
      lease.loadWindow.mockImplementationOnce(async () => {
        deps.state.currentConversationId = 'switched';
        deps.state.messages = [{ id: 'new-1', role: 'user', content: 'new', timestamp: 1 }] as any;
        deps.state.loadedRanges = [];
        return { messages: [{ id: 'older', role: 'user', content: 'older', timestamp: 1 }], range: { start: 0, end: 50 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:0:50', hasMoreBefore: false, hasMoreAfter: true };
      });

      await controller.loadOlderHistory();

      expect(deps.renderer.prependMessages).not.toHaveBeenCalled();
      expect(deps.state.messages.map(message => message.id)).toEqual(['new-1']);
      expect(deps.state.loadedRanges).toEqual([]);
      expect(deps.state.historyError).toBeNull();
    });

    it('notifies when an unloaded search locate is deferred behind a live turn', async () => {
      const coordinator = new ProjectionWriteCoordinator();
      deps.getProjectionCoordinator = () => coordinator;
      deps.state.currentConversationId = 'large';
      deps.state.messages = [{ id: 'latest', role: 'user', content: 'latest', timestamp: 100 }] as any;
      const lease = makeLease(200);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 150, end: 200 }];
      lease.loadWindow.mockResolvedValue({ messages: [{ id: 'hit', role: 'user', content: 'needle', timestamp: 0 }], range: { start: 25, end: 26 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:25:26', hasMoreBefore: true, hasMoreAfter: true });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValue(null);
      const liveLease = await coordinator.acquireLive();

      const locatePromise = controller.locateHistorySearchResult({ projectionKey: 'hit', turnIndex: 25, matchOrdinal: 0, matchedText: 'needle' });
      await Promise.resolve();

      // UX: the click must not look dead while it waits for the live turn.
      expect(mockNotice).toHaveBeenCalledTimes(1);

      liveLease!.release();
      await expect(locatePromise).rejects.toThrow('projection_mismatch');
    });

    // ============================================
    // Unified results semantics (③ + P0a fallback)
    // ============================================

    it('searches fully-hydrated loaded messages without a lease (Codex/OpenCode fallback)', async () => {
      deps.state.currentConversationId = 'codex-conv';
      deps.state.messages = [
        { id: 'm1', role: 'user', content: 'needle here', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'not rendered', timestamp: 2 },
      ] as any;
      const mounted = createMockEl();
      (deps.renderer.findMessageElement as jest.Mock).mockImplementation((key: string) => (key === 'm1' ? mounted : null));
      const mockEnumerate = jest.spyOn(historySearchModule, 'enumerateVisibleMatches')
        .mockReturnValue([{ ordinal: 0, ranges: [{ toString: () => 'Need' } as any, { toString: () => 'le' } as any] }, { ordinal: 1, ranges: [{ toString: () => 'needle' } as any] }]);

      const results = await controller.searchHistory('needle');

      // Only the mounted projection counts; locating must not trigger any
      // window load for the unmounted message.
      expect(results).toEqual([
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 0, matchedText: 'Needle' },
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 1, matchedText: 'needle' },
      ]);
      expect(deps.renderer.waitForMessageContentRendered).toHaveBeenCalledWith('m1');
      mockEnumerate.mockRestore();
    });

    it('does not leak the previous conversation into a lease-less fallback search after switching', async () => {
      deps.state.currentConversationId = 'codex-conv';
      deps.state.messages = [
        { id: 'old-1', role: 'user', content: 'needle in old conversation', timestamp: 1 },
      ] as any;
      const mounted = createMockEl();
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValue(mounted);
      const mockEnumerate = jest.spyOn(historySearchModule, 'enumerateVisibleMatches')
        .mockReturnValue([{ ordinal: 0, ranges: [{ toString: () => 'needle' } as any] }]);

      await controller.searchHistory('needle');

      // The conversation switched: the fallback enumerates the new state only.
      deps.state.currentConversationId = 'codex-conv-2';
      deps.state.messages = [
        { id: 'new-1', role: 'user', content: 'fresh', timestamp: 1 },
      ] as any;
      const second = await controller.searchHistory('needle');

      expect(second.map(result => result.projectionKey)).toEqual(['new-1']);
      mockEnumerate.mockRestore();
    });

    it('keeps projection mismatches out of the navigable results and records them as diagnostics', async () => {
      const lease = makeLease(10);
      deps.state.historyLease = lease as any;
      lease.search.mockResolvedValue([
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 0, matchedText: 'needle' },
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 1, matchedText: 'needle' },
        { projectionKey: 'm1', turnIndex: 0, matchOrdinal: 2, matchedText: 'needle' },
        { projectionKey: 'm2', turnIndex: 1, matchOrdinal: 0, matchedText: 'needle' },
      ]);
      const mounted = createMockEl();
      const detached = createMockEl();
      (deps.renderer.findMessageElement as jest.Mock).mockImplementation((key: string) => (key === 'm1' ? mounted : null));
      lease.loadMessageDetail.mockResolvedValue({ status: 'exact', message: { id: 'm2', role: 'assistant', content: 'needle once', timestamp: 2, projectionLevel: 'detail' } });
      (deps.renderer.renderSearchCandidate as jest.Mock).mockResolvedValue(detached);
      const mockEnumerate = jest.spyOn(historySearchModule, 'enumerateVisibleMatches')
        .mockImplementation((root: HTMLElement) =>
          root === mounted ? [{ ordinal: 0, ranges: [] }, { ordinal: 1, ranges: [] }] : [{ ordinal: 0, ranges: [] }]);

      const results = await controller.searchHistory('needle');

      // m1 has 3 detail candidates but only 2 mountable ordinals; m2 mounts 1.
      expect(results).toEqual([
        expect.objectContaining({ projectionKey: 'm1', matchOrdinal: 0 }),
        expect.objectContaining({ projectionKey: 'm1', matchOrdinal: 1 }),
        expect.objectContaining({ projectionKey: 'm2', matchOrdinal: 0 }),
      ]);
      expect(controller.getSearchDiagnostics()).toEqual([
        expect.objectContaining({ projectionKey: 'm1', matchOrdinal: 2, status: 'projection_mismatch' }),
      ]);
      mockEnumerate.mockRestore();
    });

    it('releases the orphaned previous lease when a mid-refresh conversation switch makes the rollback impossible', async () => {
      deps.state.currentConversationId = 'large';
      const conversation = { id: 'large', providerId: 'claude', title: 'Large', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue(conversation);
      const previous = makeLease(100);
      deps.state.historyLease = previous as any;
      let rejectReady!: (error: Error) => void;
      const next = makeLease(100);
      next.ready = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
      const service = { acquireHistoryIndex: jest.fn().mockReturnValue(next) };
      deps.getHistoryIndexCapableService = () => service as any;

      const refreshPromise = controller.refreshHistorySearchSnapshot();
      await Promise.resolve();
      // The conversation switched while the new index build failed: the
      // switch already released and cleared the pending lease, so restoring
      // `previous` onto the tab would pollute the new conversation.
      deps.state.currentConversationId = 'switched';
      deps.state.historyLease = null;
      rejectReady(new Error('index build failed'));

      await expect(refreshPromise).rejects.toThrow('index build failed');

      // The previous lease is released exactly once (no leak) and the null
      // state of the switched-to conversation stays untouched.
      expect(previous.release).toHaveBeenCalledTimes(1);
      expect(deps.state.historyLease).toBeNull();
    });

    // ============================================
    // displayOrder structural merges (③ canonical order)
    // ============================================

    it('merges an older window page by displayOrder with the live tail kept last', async () => {
      deps.state.currentConversationId = 'large';
      deps.state.messages = [
        { id: 'sdk', role: 'user', content: 'sdk', timestamp: 100, displayOrder: [1, 0, 0] },
        { id: 'live', role: 'assistant', content: 'live', timestamp: 101 },
      ] as any;
      const lease = makeLease(100);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 50, end: 100 }];
      deps.state.historyHasMore = true;
      const older = { id: 'older', role: 'user', content: 'older', timestamp: 999, displayOrder: [0, 5, 0] } as any;
      lease.loadWindow.mockResolvedValue({ messages: [older], range: { start: 0, end: 50 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:0:50', hasMoreBefore: false, hasMoreAfter: true });

      await controller.loadOlderHistory();

      expect(deps.renderer.prependMessages).toHaveBeenCalledWith(
        [older],
        [older, expect.objectContaining({ id: 'sdk' }), expect.objectContaining({ id: 'live' })],
      );
    });

    it('merges an around search-locate window by displayOrder', async () => {
      deps.state.currentConversationId = 'large';
      deps.state.messages = [
        { id: 'sdk', role: 'user', content: 'sdk', timestamp: 100, displayOrder: [1, 0, 0] },
        { id: 'live', role: 'assistant', content: 'live', timestamp: 101 },
      ] as any;
      const lease = makeLease(100);
      deps.state.historyLease = lease as any;
      deps.state.loadedRanges = [{ start: 50, end: 100 }];
      const hit = { id: 'hit', role: 'user', content: 'needle', timestamp: 999, displayOrder: [0, 5, 0] } as any;
      lease.loadWindow.mockResolvedValue({ messages: [hit], range: { start: 5, end: 6 }, snapshotOffset: 5, sourceBytes: 1, projectedChars: 1, oversizedTurnCount: 0, pageKey: 'w:5:6', hasMoreBefore: true, hasMoreAfter: true });
      (deps.renderer.findMessageElement as jest.Mock).mockReturnValueOnce(null).mockReturnValue({} as HTMLElement);

      await controller.locateHistorySearchResult({ projectionKey: 'hit', turnIndex: 5, matchOrdinal: 0, matchedText: 'needle' });

      const rendered = (deps.renderer.renderMessages as jest.Mock).mock.calls[0][0] as Array<{ id: string }>;
      expect(rendered.map(message => message.id)).toEqual(['hit', 'sdk', 'live']);
    });

  });

  describe('Queue Management', () => {
    describe('Creating new conversation', () => {
      it('should clear queued message on new conversation', async () => {
        deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null, canvasContext: null };
        deps.state.isStreaming = false;

        await controller.createNew();

        expect(deps.clearQueuedMessage).toHaveBeenCalled();
      });

      it('should not create new conversation while streaming', async () => {
        deps.state.isStreaming = true;

        await controller.createNew();

        expect(deps.plugin.createConversation).not.toHaveBeenCalled();
      });

      it('should save current conversation before creating new one', async () => {
        deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
        deps.state.currentConversationId = 'old-conv';

        await controller.createNew();

        expect(deps.plugin.updateConversation).toHaveBeenCalledWith('old-conv', expect.any(Object));
      });

      it('should reset file context for new conversation', async () => {
        const fileContextManager = deps.getFileContextManager()!;

        await controller.createNew();

        expect(fileContextManager.resetForNewConversation).toHaveBeenCalled();
        expect(fileContextManager.autoAttachActiveFile).toHaveBeenCalled();
      });

      it('should clear todos for new conversation', async () => {
        deps.state.currentTodos = [
          { content: 'Existing todo', status: 'pending', activeForm: 'Doing existing todo' }
        ];
        expect(deps.state.currentTodos).not.toBeNull();

        await controller.createNew();

        expect(deps.state.currentTodos).toBeNull();
      });

      it('should reset to entry point state (null conversationId) instead of creating conversation', async () => {
        // Entry point model: createNew() resets to blank state without creating conversation
        // Conversation is created lazily on first message send
        await controller.createNew();

        expect(deps.plugin.findEmptyConversation).not.toHaveBeenCalled();
        expect(deps.plugin.createConversation).not.toHaveBeenCalled();
        expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
        expect(deps.state.currentConversationId).toBeNull();
      });

      it('should clear messages and reset state when creating new', async () => {
        deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
        deps.state.currentConversationId = 'old-conv';

        const clearMessagesSpy = jest.spyOn(deps.state, 'clearMessages');

        await controller.createNew();

        expect(clearMessagesSpy).toHaveBeenCalled();
        expect(deps.state.currentConversationId).toBeNull();

        clearMessagesSpy.mockRestore();
      });

      it('should invalidate the feature turn lease lifecycle on createNew, including force (S2)', async () => {
        const invalidateTurnLifecycle = jest.fn();
        deps = createMockDeps({ invalidateTurnLifecycle });
        controller = new ConversationController(deps);

        await controller.createNew();
        expect(invalidateTurnLifecycle).toHaveBeenCalledTimes(1);

        // Force path (streaming): still invalidated after the forced cancel.
        deps.state.isStreaming = true;
        await controller.createNew({ force: true });
        expect(invalidateTurnLifecycle).toHaveBeenCalledTimes(2);
      });
    });

    describe('Switching conversations', () => {
      it('releases the outgoing owner before committing the incoming owner', async () => {
        deps.state.currentConversationId = 'conversation-a';
        const calls: string[] = [];
        deps.reserveConversation = jest.fn().mockResolvedValue(true);
        deps.releaseConversation = jest.fn((id: string) => { calls.push(`release:${id}`); });
        deps.commitConversation = jest.fn((id: string) => { calls.push(`commit:${id}`); });

        await controller.switchTo('conversation-b');

        expect(calls).toEqual(['release:conversation-a', 'commit:conversation-b']);
      });

      it('backfills legacy metadata when switching to an old conversation', async () => {
        const conversation = { id: 'legacy', providerId: 'claude', title: 'Legacy', messages: [], sessionId: 'session', createdAt: 1, updatedAt: 1 } as any;
        deps.state.currentConversationId = 'old-conv';
        (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(conversation);
        const lease = {
          conversationId: 'legacy', totalTurns: 1, ready: Promise.resolve(), release: jest.fn(), search: jest.fn(),
          loadMessageDetail: jest.fn(),
          loadWindow: jest.fn().mockResolvedValue({
            messages: [{ id: 'first', role: 'user', content: 'legacy first request', timestamp: 1 }],
            range: { start: 0, end: 1 }, sourceBytes: 10, projectedChars: 20,
            oversizedTurnCount: 0, pageKey: 'w:0:1', hasMoreBefore: false, hasMoreAfter: false,
          }),
          planWindow: jest.fn().mockReturnValue({ start: 0, end: 1 }),
        };
        deps.getHistoryIndexCapableService = () => ({ acquireHistoryIndex: () => lease } as any);
        deps.ensureServiceForConversation = jest.fn(async (shell) => {
          expect(shell).toMatchObject({ hasHistory: true, messageCount: 1 });
        });

        await controller.switchTo('legacy');

        expect(deps.plugin.updateConversation).toHaveBeenCalledWith('legacy', expect.objectContaining({
          hasHistory: true,
          messageCount: 1,
          preview: 'legacy first request',
          firstUserExcerpt: 'legacy first request',
        }));
      });

      it('cancels the pending reservation when the target disappears', async () => {
        deps.state.currentConversationId = 'conversation-a';
        deps.reserveConversation = jest.fn().mockResolvedValue(true);
        deps.cancelConversationReservation = jest.fn();
        (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(null);

        await controller.switchTo('missing');

        expect(deps.cancelConversationReservation).toHaveBeenCalledWith('missing');
      });

      it('should clear queued message on conversation switch', async () => {
        deps.state.currentConversationId = 'old-conv';
        deps.state.queuedMessage = { content: 'test', images: undefined, editorContext: null, canvasContext: null };

        await controller.switchTo('new-conv');

        expect(deps.clearQueuedMessage).toHaveBeenCalled();
      });

      it('should not switch while streaming', async () => {
        deps.state.isStreaming = true;
        deps.state.currentConversationId = 'old-conv';

        await controller.switchTo('new-conv');

        expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
      });

      it('should not switch to current conversation', async () => {
        deps.state.currentConversationId = 'same-conv';

        await controller.switchTo('same-conv');

        expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
      });

      it('should reset file context when switching conversations', async () => {
        deps.state.currentConversationId = 'old-conv';
        const fileContextManager = deps.getFileContextManager()!;

        await controller.switchTo('new-conv');

        expect(fileContextManager.resetForLoadedConversation).toHaveBeenCalled();
      });

      it('should clear input value on switch', async () => {
        deps.state.currentConversationId = 'old-conv';
        const inputEl = deps.getInputEl();
        inputEl.value = 'some input';

        await controller.switchTo('new-conv');

        expect(inputEl.value).toBe('');
      });

      it('should hide history dropdown after switch', async () => {
        deps.state.currentConversationId = 'old-conv';
        const dropdown = deps.getHistoryDropdown()!;
        dropdown.addClass('visible');

        await controller.switchTo('new-conv');

        expect(dropdown.hasClass('visible')).toBe(false);
      });

      it('should invalidate the feature turn lease lifecycle on switch (S2)', async () => {
        const invalidateTurnLifecycle = jest.fn();
        deps = createMockDeps({ invalidateTurnLifecycle });
        controller = new ConversationController(deps);
        deps.state.currentConversationId = 'old-conv';

        await controller.switchTo('new-conv');

        expect(invalidateTurnLifecycle).toHaveBeenCalledTimes(1);
      });

  
      it('still rejects non-hydration switch errors when no shell hook is configured', async () => {
        deps.state.currentConversationId = 'old-conv';
        (deps.plugin.switchConversation as jest.Mock).mockRejectedValue(new Error('storage failed'));

        await expect(controller.switchTo('broken-conv')).rejects.toThrow('storage failed');
      });

      it('marks hydration ready after a successful switch', async () => {
        deps.state.currentConversationId = 'old-conv';
        const markHydrationReady = jest.fn();
        deps.markHydrationReady = markHydrationReady;

        await controller.switchTo('new-conv');

        expect(markHydrationReady).toHaveBeenCalledTimes(1);
      });

      it('releases the switched-away conversation history protection after a successful switch', async () => {
        deps.state.currentConversationId = 'old-conv';
        (deps.plugin.getConversationSync as jest.Mock).mockImplementation((id: string) => (
          id === 'old-conv'
            ? { id: 'old-conv', providerId: 'claude', title: 'Old', messages: [], createdAt: 1, updatedAt: 1 }
            : null
        ));
        const release = jest.fn();
        deps.state.historyLease = { release } as any;

        await controller.switchTo('new-conv');

        expect(release).toHaveBeenCalledTimes(1);
      });

  
      it('does not release the current conversation history when the switch does not complete', async () => {
        deps.state.currentConversationId = 'old-conv';
        (deps.plugin.getConversationSync as jest.Mock).mockImplementation((id: string) => (
          id === 'old-conv'
            ? { id: 'old-conv', providerId: 'claude', title: 'Old', messages: [], createdAt: 1, updatedAt: 1 }
            : null
        ));
        (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(null);
        const release = jest.fn();
        deps.state.historyLease = { release } as any;

        await controller.switchTo('missing-conv');

        expect(release).not.toHaveBeenCalled();
      });

      it('releases the switched-away conversation history protection when createNew resets to blank', async () => {
        deps.state.currentConversationId = 'old-conv';
        (deps.plugin.getConversationSync as jest.Mock).mockReturnValue({ id: 'old-conv', providerId: 'claude' });
        const release = jest.fn();
        deps.state.historyLease = { release } as any;

        await controller.createNew();

        expect(release).toHaveBeenCalledTimes(1);
      });

      it('marks hydration ready after createNew resets to the entry point', async () => {
        deps.state.currentConversationId = 'old-conv';
        const markHydrationReady = jest.fn();
        deps.markHydrationReady = markHydrationReady;

        await controller.createNew();

        expect(markHydrationReady).toHaveBeenCalledTimes(1);
      });
    });

    describe('Welcome visibility', () => {
      it('should hide welcome when messages exist', () => {
        deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
        const welcomeEl = deps.getWelcomeEl()!;

        controller.updateWelcomeVisibility();

        expect(welcomeEl.style.display).toBe('none');
      });

      it('should show welcome when no messages exist', () => {
        deps.state.messages = [];
        const welcomeEl = deps.getWelcomeEl()!;

        controller.updateWelcomeVisibility();

        // When no messages, welcome should not be 'none' (either 'block' or empty string)
        expect(welcomeEl.style.display).not.toBe('none');
      });

      it('should update welcome visibility after switching to conversation with messages', async () => {
        deps.state.currentConversationId = 'old-conv';
        deps.state.messages = [];
        (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
          id: 'new-conv',
          messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
          sessionId: null,
        });

        await controller.switchTo('new-conv');

        expect(deps.state.messages.length).toBe(1);
        const welcomeEl = deps.getWelcomeEl()!;
        expect(welcomeEl.style.display).toBe('none');
      });
    });
  });

  describe('initializeWelcome', () => {
    it('should initialize file context for new tab', () => {
      const fileContextManager = deps.getFileContextManager()!;

      controller.initializeWelcome();

      expect(fileContextManager.resetForNewConversation).toHaveBeenCalled();
      expect(fileContextManager.autoAttachActiveFile).toHaveBeenCalled();
    });

    it('should not throw if welcomeEl is null', () => {
      const depsWithNullWelcome = createMockDeps({
        getWelcomeEl: () => null,
      });
      const controllerWithNullWelcome = new ConversationController(depsWithNullWelcome);

      expect(() => controllerWithNullWelcome.initializeWelcome()).not.toThrow();
    });

    it('should only add greeting if not already present', () => {
      const welcomeEl = deps.getWelcomeEl()!;
      const createDivSpy = jest.spyOn(welcomeEl, 'createDiv');

      // First call should add greeting
      controller.initializeWelcome();
      expect(createDivSpy).toHaveBeenCalledTimes(1);

      // Mock querySelector to return an element (greeting already exists)
      welcomeEl.querySelector = jest.fn().mockReturnValue(createMockEl());

      // Second call should not add another greeting
      controller.initializeWelcome();
      expect(createDivSpy).toHaveBeenCalledTimes(1); // Still 1, not 2
    });
  });

  describe('formatDate', () => {
    it('should return time format for today', () => {
      const now = new Date();
      const result = controller.formatDate(now.getTime());

      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    it('should return month/day format for a past date', () => {
      const pastDate = new Date(2023, 0, 15).getTime();
      const result = controller.formatDate(pastDate);

      expect(result).toContain('15');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return month/day format for yesterday', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const result = controller.formatDate(yesterday.getTime());

      expect(result).not.toMatch(/^\d{2}:\d{2}$/);
    });
  });

  describe('toggleHistoryDropdown', () => {
    it('should add visible class when dropdown is hidden', () => {
      const dropdown = deps.getHistoryDropdown()!;
      expect(dropdown.hasClass('visible')).toBe(false);

      controller.toggleHistoryDropdown();

      expect(dropdown.hasClass('visible')).toBe(true);
    });

    it('should remove visible class when dropdown is visible', () => {
      const dropdown = deps.getHistoryDropdown()!;
      dropdown.addClass('visible');

      controller.toggleHistoryDropdown();

      expect(dropdown.hasClass('visible')).toBe(false);
    });

    it('should not throw when dropdown is null', () => {
      const depsNullDropdown = createMockDeps({
        getHistoryDropdown: () => null,
      });
      const ctrl = new ConversationController(depsNullDropdown);

      expect(() => ctrl.toggleHistoryDropdown()).not.toThrow();
    });
  });

  describe('save edge cases', () => {
    it('should return early when no conversationId and no messages', async () => {
      deps.state.currentConversationId = null;
      deps.state.messages = [];

      await controller.save();

      expect(deps.plugin.updateConversation).not.toHaveBeenCalled();
      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });

    it('should lazily create conversation when entry point has messages', async () => {
      deps.state.currentConversationId = null;
      deps.state.messages = [{ id: '1', role: 'user', content: 'hello', timestamp: Date.now() }];

      (deps.plugin.createConversation as jest.Mock).mockResolvedValue({
        id: 'lazy-conv',
        title: 'New Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await controller.save();

      expect(deps.plugin.createConversation).toHaveBeenCalled();
      expect(deps.state.currentConversationId).toBe('lazy-conv');
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'lazy-conv',
        expect.any(Object)
      );
    });

    it('should preserve the active runtime provider when lazily creating a conversation', async () => {
      deps = createMockDeps({
        getAgentService: () => ({
          providerId: 'codex',
          getSessionId: jest.fn().mockReturnValue('session-codex'),
          consumeSessionInvalidation: jest.fn().mockReturnValue(false),
          buildSessionUpdates: jest.fn().mockReturnValue({ updates: {} }),
          syncConversationState: jest.fn(),
        }) as any,
      });
      controller = new ConversationController(deps);
      deps.state.currentConversationId = null;
      deps.state.messages = [{ id: '1', role: 'user', content: 'hello', timestamp: Date.now() }];

      (deps.plugin.createConversation as jest.Mock).mockResolvedValue({
        id: 'lazy-codex-conv',
        providerId: 'codex',
        title: 'Codex Conversation',
        messages: [],
        sessionId: 'session-codex',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await controller.save();

      expect(deps.plugin.createConversation).toHaveBeenCalledWith({
        providerId: 'codex',
        sessionId: 'session-codex',
      });
    });

    it('should set lastResponseAt when updateLastResponse is true', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      const beforeCall = Date.now();

      await controller.save(true);

      const call = (deps.plugin.updateConversation as jest.Mock).mock.calls[0];
      const updates = call[1];
      expect(updates.lastResponseAt).toBeDefined();
      expect(updates.lastResponseAt).toBeGreaterThanOrEqual(beforeCall);
      expect(updates.lastResponseAt).toBeLessThanOrEqual(Date.now());
    });

    it('should NOT clear resumeAtMessageId when updateLastResponse is true (caller must pass extraUpdates)', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      await controller.save(true);

      const call = (deps.plugin.updateConversation as jest.Mock).mock.calls[0];
      const updates = call[1];
      expect(updates).not.toHaveProperty('resumeAtMessageId');
    });

    it('should clear resumeAtMessageId when passed via extraUpdates', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      await controller.save(true, { resumeAtMessageId: undefined });

      const call = (deps.plugin.updateConversation as jest.Mock).mock.calls[0];
      const updates = call[1];
      expect(updates.resumeAtMessageId).toBeUndefined();
      // Verify it's explicitly set (not just missing)
      expect('resumeAtMessageId' in updates).toBe(true);
    });

    it('should not clear resumeAtMessageId when updateLastResponse is false', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      await controller.save(false);

      const call = (deps.plugin.updateConversation as jest.Mock).mock.calls[0];
      const updates = call[1];
      expect(updates).not.toHaveProperty('resumeAtMessageId');
    });

    it('should clear pending conversation save state after persisting', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];
      deps.state.hasPendingConversationSave = true;

      await controller.save();

      expect(deps.state.hasPendingConversationSave).toBe(false);
    });
  });

  describe('save hydration shell guard (M1 review fix)', () => {
    /**
     * Rebuilds a pre-READY shell scenario where tab.service still parks the
     * runtime of the previous conversation Y. save() at that point must
     * not persist anything, or buildSessionUpdates overwrites X's meta with
     * Y's session and a loading-window close clears X's persisted fields.
     */
    function setupParkedRuntimeScenario(): Record<string, any> {
      // Mock storage layer: conv-X meta as persisted on disk.
      const metaStore: Record<string, any> = {
        'conv-X': {
          id: 'conv-X',
          providerId: 'claude',
          title: 'Oversize X',
          messages: [{ id: 'm1', role: 'user', content: 'x', timestamp: 1 }],
          sessionId: 'session-X',
          providerState: { providerSessionId: 'session-X' },
          currentNote: 'notes/X.md',
          usage: { inputTokens: 10 },
          externalContextPaths: ['/ext/x'],
          enabledMcpServers: ['mcp-x'],
          createdAt: 1,
          updatedAt: 1,
        },
      };
      (deps.plugin.getConversationSync as jest.Mock).mockImplementation(
        (id: string) => metaStore[id],
      );
      (deps.plugin.updateConversation as jest.Mock).mockImplementation(
        async (id: string, updates: Record<string, unknown>) => {
          Object.assign(metaStore[id], updates);
        },
      );

      // Parked runtime from conversation Y. buildSessionUpdates mirrors
      // ClaudeChatRuntime semantics: the live runtime session wins over the
      // conversation's persisted session.
      const parkedRuntime = {
        providerId: 'claude',
        getSessionId: jest.fn().mockReturnValue('session-Y'),
        consumeSessionInvalidation: jest.fn().mockReturnValue(false),
        buildSessionUpdates: jest.fn().mockImplementation(({ conversation }: { conversation: { providerState?: Record<string, unknown> } | null }) => ({
          updates: {
            sessionId: 'session-Y',
            providerState: {
              ...(conversation?.providerState || {}),
              providerSessionId: 'session-Y',
            },
          },
        })),
        syncConversationState: jest.fn(),
      };
      deps.getAgentService = () => parkedRuntime as any;

      // Pre-READY shell state: bound to X, not hydrated.
      deps.state.currentConversationId = 'conv-X';
      deps.state.messages = [];
      deps.isHydrationReady = () => false;
      return metaStore;
    }

    it('skips the write while the tab is in a shell state, keeping X meta free of Y session pollution', async () => {
      const metaStore = setupParkedRuntimeScenario();

      await controller.save();

      expect(deps.plugin.updateConversation).not.toHaveBeenCalled();
      expect(metaStore['conv-X'].sessionId).toBe('session-X');
      expect(metaStore['conv-X'].providerState.providerSessionId).toBe('session-X');
    });

    it('keeps persisted currentNote/usage/externalContextPaths/enabledMcpServers when a loading window is closed', async () => {
      const metaStore = setupParkedRuntimeScenario();

      await controller.save();

      expect(metaStore['conv-X'].currentNote).toBe('notes/X.md');
      expect(metaStore['conv-X'].usage).toEqual({ inputTokens: 10 });
      expect(metaStore['conv-X'].externalContextPaths).toEqual(['/ext/x']);
      expect(metaStore['conv-X'].enabledMcpServers).toEqual(['mcp-x']);
      expect(metaStore['conv-X'].messages).toHaveLength(1);
    });

    it('saves normally once hydration reports READY', async () => {
      setupParkedRuntimeScenario();
      deps.isHydrationReady = () => true;

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-X', expect.any(Object));
    });

    it('saves normally when no hydration hook is wired (legacy callers)', async () => {
      setupParkedRuntimeScenario();
      deps.isHydrationReady = undefined;

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-X', expect.any(Object));
    });
  });

  describe('loadActive with existing conversation', () => {
    it('should restore currentNote when conversation has one', async () => {
      const fileContextManager = deps.getFileContextManager()!;
      deps.state.currentConversationId = 'conv-with-note';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-with-note',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        currentNote: 'notes/my-note.md',
      });

      await controller.loadActive();

      expect(fileContextManager.setCurrentNote).toHaveBeenCalledWith('notes/my-note.md');
    });

    it('should auto-attach active file when no currentNote and no messages', async () => {
      const fileContextManager = deps.getFileContextManager()!;
      deps.state.currentConversationId = 'empty-conv';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'empty-conv',
        messages: [],
        sessionId: null,
        currentNote: undefined,
      });

      await controller.loadActive();

      expect(fileContextManager.autoAttachActiveFile).toHaveBeenCalled();
      expect(fileContextManager.setCurrentNote).not.toHaveBeenCalled();
    });

    it('does not apply a stale load after its generation is invalidated', async () => {
      let valid = true;
      deps.state.currentConversationId = 'conv-1';
      (deps.plugin.getConversationById as jest.Mock).mockImplementation(async () => {
        valid = false;
        return {
          id: 'conv-1',
          messages: [{ id: '1', role: 'user', content: 'stale', timestamp: Date.now() }],
        };
      });

      await controller.loadActive(() => valid);

      expect(deps.state.messages).toEqual([]);
      expect(deps.renderer.renderMessages).not.toHaveBeenCalled();
    });

    it('should call renderer.renderMessages with greeting callback', async () => {
      deps.state.currentConversationId = 'conv-1';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
      });

      await controller.loadActive();

      expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Function)
      );

      const greetingFn = (deps.renderer.renderMessages as jest.Mock).mock.calls[0][1];
      expect(greetingFn().length).toBeGreaterThan(0);
    });
  });

  describe('loadActive usage denominator re-derivation (idle-session fix)', () => {
    const usagePresets = [
      { label: 'Haiku', model: 'haiku' },
      { label: 'Sonnet', model: 'sonnet' },
      { label: 'Opus', model: 'opus' },
    ];

    function seedClaudeSettings(
      customContextLimits: Record<string, number>,
      savedProviderModel?: Record<string, string>,
    ): void {
      deps.plugin.settings = {
        userName: '',
        enableAutoTitleGeneration: true,
        permissionConfigs: {},
        providerConfigs: {
          claude: { modelPresets: usagePresets },
        },
        customContextLimits,
        ...(savedProviderModel ? { savedProviderModel } : {}),
      } as unknown as typeof deps.plugin.settings;
    }

    function storedUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        model: 'sonnet',
        inputTokens: 400_000,
        cacheCreationInputTokens: 30_000,
        cacheReadInputTokens: 20_000,
        contextWindow: 200_000,
        contextWindowIsAuthoritative: false,
        contextTokens: 450_000,
        percentage: 100,
        ...overrides,
      };
    }

    function storedConversation(usage?: Record<string, unknown>): Record<string, unknown> {
      return {
        id: 'conv-usage',
        providerId: 'claude',
        title: 'Old session',
        sessionId: 'session-1',
        messages: [{ id: '1', role: 'user', content: 'hello', timestamp: 1 }],
        createdAt: 1,
        updatedAt: 1,
        ...(usage !== undefined ? { usage } : {}),
      };
    }

    it('denominates from the restored selector model on hydration, ignoring the CLI-reported usage label (2.3.2 ②)', async () => {
      seedClaudeSettings({ 'sonnet': 1_000_000 }, { claude: 'sonnet' });
      deps.state.currentConversationId = 'conv-usage';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(
        storedConversation(storedUsage({
          // CLI-reported form: a label, never a denominator source.
          model: 'claude-sonnet[1m]',
        })),
      );

      await controller.loadActive();

      expect(deps.state.usage?.model).toBe('sonnet');
      expect(deps.state.usage?.contextWindow).toBe(1_000_000);
      expect(deps.state.usage?.percentage).toBe(45);
    });

    it('keeps the stored usage as-is when no selector model projection exists', async () => {
      seedClaudeSettings({ 'sonnet': 1_000_000 });
      deps.state.currentConversationId = 'conv-usage';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(
        storedConversation(storedUsage()),
      );

      await controller.loadActive();

      // No selector model to denominate from: the stored snapshot survives.
      expect(deps.state.usage).toEqual(storedUsage());
    });

    it('drops a stale authoritative window when the selector model differs from the usage model', async () => {
      seedClaudeSettings({ 'sonnet': 1_000_000 }, { claude: 'sonnet' });
      deps.state.currentConversationId = 'conv-usage';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(
        storedConversation(storedUsage({
          model: 'other-model',
          contextWindow: 800_000,
          contextWindowIsAuthoritative: true,
        })),
      );

      await controller.loadActive();

      expect(deps.state.usage?.model).toBe('sonnet');
      expect(deps.state.usage?.contextWindow).toBe(1_000_000);
      expect(deps.state.usage?.contextWindowIsAuthoritative).toBe(false);
    });

    it('keeps sessions without usage untouched (gauge stays hidden)', async () => {
      seedClaudeSettings({ 'sonnet': 1_000_000 });
      deps.state.currentConversationId = 'conv-usage';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(storedConversation());

      await controller.loadActive();

      expect(deps.state.usage).toBeNull();
    });

    it('restores the stored usage as-is when the conversation carries no provider id', async () => {
      seedClaudeSettings({ 'sonnet': 1_000_000 });
      deps.state.currentConversationId = 'conv-usage';
      const legacyConversation = storedConversation(storedUsage());
      delete legacyConversation.providerId;
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(legacyConversation);

      await controller.loadActive();

      expect(deps.state.usage).toEqual(storedUsage());
    });
  });

  describe('switchTo with currentNote', () => {
    it('should set currentNote when switched conversation has one', async () => {
      const fileContextManager = deps.getFileContextManager()!;
      deps.state.currentConversationId = 'old-conv';

      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        currentNote: 'docs/readme.md',
      });

      await controller.switchTo('new-conv');

      expect(fileContextManager.setCurrentNote).toHaveBeenCalledWith('docs/readme.md');
    });

    it('should not set currentNote when switched conversation has none', async () => {
      const fileContextManager = deps.getFileContextManager()!;
      deps.state.currentConversationId = 'old-conv';

      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [],
        sessionId: null,
        currentNote: undefined,
      });

      await controller.switchTo('new-conv');

      expect(fileContextManager.setCurrentNote).not.toHaveBeenCalled();
    });

    it('should call renderer.renderMessages with greeting callback on switch', async () => {
      deps.state.currentConversationId = 'old-conv';

      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        messages: [],
        sessionId: null,
      });

      await controller.switchTo('new-conv');

      expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Function)
      );

      const greetingFn = (deps.renderer.renderMessages as jest.Mock).mock.calls[0][1];
      expect(greetingFn().length).toBeGreaterThan(0);
    });
  });

  describe('History Rendering', () => {
    let dropdown: any;

    beforeEach(() => {
      dropdown = createMockEl();
      deps.getHistoryDropdown = () => dropdown;
    });

    describe('updateHistoryDropdown with conversations', () => {
      it('should render conversation items when conversations exist', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'First Conversation', createdAt: 1000, lastResponseAt: 3000 },
          { id: 'conv-2', title: 'Second Conversation', createdAt: 2000, lastResponseAt: 2000 },
        ]);

        controller.updateHistoryDropdown();

        expect(dropdown.children.length).toBe(2);
        const list = dropdown.children[1];
        expect(list.hasClass('claudian-history-list')).toBe(true);
        expect(list.children.length).toBe(2);
      });

      it('should show "No conversations" when list is empty', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        expect(list.children[0].hasClass('claudian-history-empty')).toBe(true);
      });

      it('should sort conversations by lastResponseAt descending', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-old', title: 'Old', createdAt: 1000, lastResponseAt: 1000 },
          { id: 'conv-new', title: 'New', createdAt: 2000, lastResponseAt: 5000 },
          { id: 'conv-mid', title: 'Mid', createdAt: 3000, lastResponseAt: 3000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const firstTitle = list.children[0].querySelector('.claudian-history-item-title');
        expect(firstTitle?.textContent).toBe('New');
      });

      it('should mark current conversation as active', () => {
        deps.state.currentConversationId = 'conv-1';

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 1000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 2000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const items = list.children;
        const activeItem = items.find((item: any) => item.hasClass('active'));
        expect(activeItem).toBeDefined();
      });

      it('should show loading indicator for pending title generation', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Generating...', createdAt: 1000, lastResponseAt: 1000, titleGenerationStatus: 'pending' },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const item = list.children[0];
        const loadingEl = item.querySelector('.claudian-action-loading');
        expect(loadingEl).toBeTruthy();
      });

      it('should show regenerate button for failed title generation', () => {
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Fallback Title', createdAt: 1000, lastResponseAt: 1000, titleGenerationStatus: 'failed' },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const item = list.children[0];
        const actions = item.querySelector('.claudian-history-item-actions');
        expect(actions).toBeTruthy();
        // regenerate button + rename button + delete button = 3 children
        expect(actions!.children.length).toBe(3);
      });

      it('should not show select click handler on current conversation', () => {
        deps.state.currentConversationId = 'conv-1';

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 1000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const item = list.children[0];
        const content = item.querySelector('.claudian-history-item-content');
        const listeners = content?._eventListeners?.get('click');
        expect(listeners).toBeUndefined();
      });

      it('should attach select click handler on non-current conversations', () => {
        deps.state.currentConversationId = 'conv-1';

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        // conv-2 is the non-current one (sorted second by lastResponseAt)
        const otherItem = list.children[1];
        const content = otherItem.querySelector('.claudian-history-item-content');
        const listeners = content?._eventListeners?.get('click');
        expect(listeners).toBeDefined();
        expect(listeners!.length).toBe(1);
      });

      it('should not delete while streaming', async () => {
        deps.state.isStreaming = true;

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Test', createdAt: 1000, lastResponseAt: 1000 },
        ]);

        controller.updateHistoryDropdown();

        const list = dropdown.children[1];
        const item = list.children[0];
        const deleteBtn = item.querySelector('.claudian-delete-btn');
        expect(deleteBtn).toBeTruthy();

        const clickHandlers = deleteBtn!._eventListeners?.get('click');
        expect(clickHandlers).toBeDefined();
        await clickHandlers![0]({ stopPropagation: jest.fn() });

        expect(deps.plugin.deleteConversation).not.toHaveBeenCalled();
      });
    });

    describe('renderHistoryDropdown', () => {
      it('should render history items to provided container', () => {
        const container = createMockEl();
        const onSelectConversation = jest.fn();

        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Test', createdAt: 1000, lastResponseAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, { onSelectConversation });

        expect(container.children.length).toBe(2); // header + list
      });

      it('should open a conversation in a new tab on modifier click when supported', async () => {
        const container = createMockEl();
        const onSelectConversation = jest.fn();
        const onOpenConversationInNewTab = jest.fn().mockResolvedValue(undefined);

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation,
          onOpenConversationInNewTab,
          getConversationOpenState: () => 'closed',
        });

        const list = container.children[1];
        const otherItem = list.children[1];
        const content = otherItem.querySelector('.claudian-history-item-content');
        const clickHandlers = content?._eventListeners?.get('click');
        expect(clickHandlers).toBeDefined();

        await clickHandlers![0]({
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        });

        expect(onOpenConversationInNewTab).toHaveBeenCalledWith('conv-2', true);
        expect(onSelectConversation).not.toHaveBeenCalled();
      });

      it('should open a conversation in a new tab on middle click when supported', async () => {
        const container = createMockEl();
        const onSelectConversation = jest.fn();
        const onOpenConversationInNewTab = jest.fn().mockResolvedValue(undefined);

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation,
          onOpenConversationInNewTab,
          getConversationOpenState: () => 'closed',
        });

        const list = container.children[1];
        const otherItem = list.children[1];
        const content = otherItem.querySelector('.claudian-history-item-content');
        const auxClickHandlers = content?._eventListeners?.get('auxclick');
        expect(auxClickHandlers).toBeDefined();

        await auxClickHandlers![0]({
          button: 1,
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
        });

        expect(onOpenConversationInNewTab).toHaveBeenCalledWith('conv-2', true);
        expect(onSelectConversation).not.toHaveBeenCalled();
      });

      it('should show new-tab actions in the context menu for closed conversations', () => {
        const container = createMockEl();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          onOpenConversationInNewTab: jest.fn().mockResolvedValue(undefined),
          getConversationOpenState: () => 'closed',
        });

        const list = container.children[1];
        const otherItem = list.children[1];
        otherItem.dispatchEvent({
          type: 'contextmenu',
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
        });

        const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string }> }> }).instances[0];
        expect(menu.items.map(item => item.title)).toEqual([
          'Open in New Tab',
          'Open in Background Tab',
          'Export full conversation to file',
          'Copy full conversation text',
          'Rename',
          'Delete',
        ]);
      });

      it('should show switch action in the context menu for already-open conversations', () => {
        const container = createMockEl();

        deps.state.currentConversationId = 'conv-1';
        (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
          { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
          { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
        ]);

        controller.renderHistoryDropdown(container, {
          onSelectConversation: jest.fn(),
          onOpenConversationInNewTab: jest.fn().mockResolvedValue(undefined),
          getConversationOpenState: () => 'open',
        });

        const list = container.children[1];
        const otherItem = list.children[1];
        otherItem.dispatchEvent({
          type: 'contextmenu',
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
        });

        const menu = (Menu as typeof Menu & { instances: Array<{ items: Array<{ title: string }> }> }).instances[0];
        expect(menu.items.map(item => item.title)).toEqual([
          'Switch to Open Session',
          'Export full conversation to file',
          'Copy full conversation text',
          'Rename',
          'Delete',
        ]);
      });
    });
  });

  describe('History Item Interactions', () => {
    let dropdown: any;

    beforeEach(() => {
      dropdown = createMockEl();
      deps.getHistoryDropdown = () => dropdown;
    });

    it('should switch conversation when clicking a non-current item content', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
        { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const otherItem = list.children[1];
      const content = otherItem.querySelector('.claudian-history-item-content');
      const clickHandlers = content?._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.switchConversation).toHaveBeenCalledWith('conv-2');
    });

    it('should call regenerateTitle when clicking regenerate button on failed item', async () => {
      const mockTitleService = {
        generateTitle: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn(),
      };
      deps.getTitleGenerationService = () => mockTitleService as any;

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Failed', createdAt: 1000, lastResponseAt: 1000, titleGenerationStatus: 'failed' },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const item = list.children[0];
      const actions = item.querySelector('.claudian-history-item-actions');
      // First child is the regenerate button
      const regenerateBtn = actions!.children[0];
      const clickHandlers = regenerateBtn._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        title: 'Failed',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'pending',
      });
    });

    it('should invoke rename handler when clicking rename button', () => {
      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Test Title', createdAt: 1000, lastResponseAt: 1000 },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const item = list.children[0];
      const actions = item.querySelector('.claudian-history-item-actions');
      expect(actions).toBeTruthy();
      // For non-failed items: rename is children[0], delete is children[1]
      const rBtn = actions!.children[0];
      expect(rBtn).toBeTruthy();
      const clickHandlers = rBtn._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      const mockInput = createMockEl();
      (mockInput as any).type = '';
      (mockInput as any).className = '';
      (mockInput as any).value = '';
      (mockInput as any).focus = jest.fn();
      (mockInput as any).select = jest.fn();

      const titleEl = item.querySelector('.claudian-history-item-title');
      if (titleEl) {
        (titleEl as any).replaceWith = jest.fn();
      }

      const origDocument = global.document;
      global.document = { createElement: jest.fn().mockReturnValue(mockInput) } as any;

      try {
        clickHandlers![0]({ stopPropagation: jest.fn() });

        expect(global.document.createElement).toHaveBeenCalledWith('input');
        expect((mockInput as any).value).toBe('Test Title');
        expect(titleEl!.replaceWith).toHaveBeenCalledWith(mockInput);
      } finally {
        global.document = origDocument;
      }
    });

    it('should delete conversation and reload active when deleting current conversation', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 1000 },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const item = list.children[0];
      const deleteBtn = item.querySelector('.claudian-delete-btn');
      expect(deleteBtn).toBeTruthy();

      const clickHandlers = deleteBtn!._eventListeners?.get('click');
      expect(clickHandlers).toBeDefined();

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.deleteConversation).toHaveBeenCalledWith('conv-1');
    });

    it('should delete non-current conversation without calling loadActive', async () => {
      deps.state.currentConversationId = 'conv-1';

      (deps.plugin.getConversationList as jest.Mock).mockReturnValue([
        { id: 'conv-1', title: 'Current', createdAt: 1000, lastResponseAt: 2000 },
        { id: 'conv-2', title: 'Other', createdAt: 2000, lastResponseAt: 1000 },
      ]);

      controller.updateHistoryDropdown();

      const list = dropdown.children[1];
      const otherItem = list.children[1]; // conv-2
      const deleteBtn = otherItem.querySelector('.claudian-delete-btn');
      const clickHandlers = deleteBtn!._eventListeners?.get('click');

      await clickHandlers![0]({ stopPropagation: jest.fn() });

      expect(deps.plugin.deleteConversation).toHaveBeenCalledWith('conv-2');
      // Should not have called switchConversation (which is used in loadActive path)
      // The key check is that deleteConversation was called with conv-2
    });
  });

  describe('loadActive with greeting', () => {
    it('should show welcome and return early when no conversation exists', async () => {
      deps.state.currentConversationId = null;

      await controller.loadActive();

      const welcomeEl = deps.getWelcomeEl();
      expect(welcomeEl?.style.display).not.toBe('none');
    });
  });

  describe('Greeting Time Branches', () => {
    it.each([
      { name: 'morning (5-12)', hour: 9, day: 1, patterns: ['morning', 'Coffee'] },
      { name: 'afternoon (12-18)', hour: 14, day: 2, patterns: ['afternoon'] },
      { name: 'evening (18-22)', hour: 20, day: 3, patterns: ['evening', 'Evening', 'your day'] },
      { name: 'night owl (22+)', hour: 23, day: 4, patterns: ['night owl', 'Evening'] },
      { name: 'early morning night owl (0-4)', hour: 2, day: 0, patterns: ['night owl', 'Evening'] },
    ])('should include $name greetings', ({ hour, day, patterns }) => {
      jest.spyOn(Date.prototype, 'getHours').mockReturnValue(hour);
      jest.spyOn(Date.prototype, 'getDay').mockReturnValue(day);

      const greetings = new Set<string>();
      for (let i = 0; i < 50; i++) {
        jest.spyOn(Math, 'random').mockReturnValue(i / 50);
        greetings.add(controller.getGreeting());
      }

      const hasTimeBased = [...greetings].some(g =>
        patterns.some(p => g.includes(p))
      );
      expect(hasTimeBased).toBe(true);

      jest.restoreAllMocks();
    });
  });
});

describe('ConversationController - Callbacks', () => {
  it('should call onNewConversation callback', async () => {
    const onNewConversation = jest.fn();
    const deps = createMockDeps();
    const controller = new ConversationController(deps, { onNewConversation });

    await controller.createNew();

    expect(onNewConversation).toHaveBeenCalled();
  });

  it('should call onConversationSwitched callback', async () => {
    const onConversationSwitched = jest.fn();
    const deps = createMockDeps();
    deps.state.currentConversationId = 'old-conv';
    const controller = new ConversationController(deps, { onConversationSwitched });

    await controller.switchTo('new-conv');

    expect(onConversationSwitched).toHaveBeenCalled();
  });

  it('should call onConversationLoaded callback', async () => {
    const onConversationLoaded = jest.fn();
    const deps = createMockDeps();
    const controller = new ConversationController(deps, { onConversationLoaded });

    await controller.loadActive();

    expect(onConversationLoaded).toHaveBeenCalled();
  });
});

describe('ConversationController - Title Generation', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockTitleService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTitleService = {
      generateTitle: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
    };
    deps = createMockDeps({
      getTitleGenerationService: () => mockTitleService,
    });
    controller = new ConversationController(deps);
  });

  describe('regenerateTitle', () => {
    it('should not regenerate if titleService is null', async () => {
      const depsNoService = createMockDeps({
        getTitleGenerationService: () => null,
      });
      const controllerNoService = new ConversationController(depsNoService);

      (depsNoService.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controllerNoService.regenerateTitle('conv-1');

      expect(depsNoService.plugin.updateConversation).not.toHaveBeenCalled();
    });

    it('should not regenerate if enableAutoTitleGeneration is false', async () => {
      deps.plugin.settings.enableAutoTitleGeneration = false;
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
      expect(deps.plugin.updateConversation).not.toHaveBeenCalled();

      deps.plugin.settings.enableAutoTitleGeneration = true;
    });

    it('should not regenerate if conversation not found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue(null);

      await controller.regenerateTitle('non-existent');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if conversation has no messages', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Title',
        messages: [],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should not regenerate if no user message found', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Title',
        messages: [
          { role: 'assistant', content: 'Hi' },
          { role: 'assistant', content: 'There' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(mockTitleService.generateTitle).not.toHaveBeenCalled();
    });

    it('should set pending status before generating', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
        titleGenerationStatus: 'pending',
      });
    });

    it('should call titleService.generateTitle with correct params', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Hello world', displayContent: 'Hello world!' },
          { role: 'assistant', content: 'Hi there!' },
        ],
      });

      await controller.regenerateTitle('conv-1');

      const expectedMaterial = `Current title: "Old Title"
Return it unchanged if it still accurately summarizes the conversation below.

First request:
Hello world!

Recent messages:
- Hello world!`;
      expect(mockTitleService.generateTitle).toHaveBeenCalledWith(
        'conv-1',
        expectedMaterial,
        expect.any(Function)
      );
    });

    it('should regenerate title with only user message (no assistant yet)', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [{ role: 'user', content: 'Hello world' }],
      });

      await controller.regenerateTitle('conv-1');

      const expectedMaterial = `Current title: "Old Title"
Return it unchanged if it still accurately summarizes the conversation below.

First request:
Hello world

Recent messages:
- Hello world`;
      expect(mockTitleService.generateTitle).toHaveBeenCalledWith(
        'conv-1',
        expectedMaterial,
        expect.any(Function)
      );
    });

    it('should rename conversation with generated title', async () => {
      (deps.plugin.getConversationById as any) = jest.fn().mockResolvedValue({
        id: 'conv-1',
        title: 'Old Title',
        messages: [
          { role: 'user', content: 'Create a plan' },
          { role: 'assistant', content: 'Here is the plan...' },
        ],
      });

      mockTitleService.generateTitle.mockImplementation(
        async (convId: string, _user: string, callback: any) => {
          await callback(convId, { success: true, title: 'New Generated Title' });
        }
      );

      (deps.plugin.renameConversation as any) = jest.fn().mockResolvedValue(undefined);

      await controller.regenerateTitle('conv-1');

      expect(deps.plugin.renameConversation).toHaveBeenCalledWith('conv-1', 'New Generated Title');
    });
  });

  describe('generateFallbackTitle', () => {
    it('should generate title from first sentence', () => {
      const title = controller.generateFallbackTitle('How do I set up React? I need help.');

      expect(title).toBe('How do I set up React');
    });

    it('should truncate long titles to 50 chars', () => {
      const longMessage = 'A'.repeat(100);
      const title = controller.generateFallbackTitle(longMessage);

      expect(title.length).toBeLessThanOrEqual(53); // 50 + '...'
      expect(title).toContain('...');
    });

    it('should handle messages with no sentence breaks', () => {
      const title = controller.generateFallbackTitle('Hello world');

      expect(title).toBe('Hello world');
    });
  });
});

describe('ConversationController - MCP Server Persistence', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockMcpServerSelector: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMcpServerSelector = {
      clearEnabled: jest.fn(),
      getEnabledServers: jest.fn().mockReturnValue(new Set(['mcp-server-1', 'mcp-server-2'])),
      setEnabledServers: jest.fn(),
    };
    deps = createMockDeps({
      getMcpServerSelector: () => mockMcpServerSelector,
    });
    controller = new ConversationController(deps);
  });

  describe('save', () => {
    it('should save enabled MCP servers to conversation', async () => {
      deps.state.currentConversationId = 'conv-1';

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          enabledMcpServers: ['mcp-server-1', 'mcp-server-2'],
        })
      );
    });

    it('should save undefined when no MCP servers enabled', async () => {
      mockMcpServerSelector.getEnabledServers.mockReturnValue(new Set());
      deps.state.currentConversationId = 'conv-1';

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          enabledMcpServers: undefined,
        })
      );
    });
  });

  describe('loadActive', () => {
    it('should restore enabled MCP servers from conversation', async () => {
      deps.state.currentConversationId = 'conv-1';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [],
        sessionId: null,
        enabledMcpServers: ['restored-server-1', 'restored-server-2'],
      });

      await controller.loadActive();

      expect(mockMcpServerSelector.setEnabledServers).toHaveBeenCalledWith([
        'restored-server-1',
        'restored-server-2',
      ]);
    });

    it('should clear MCP servers when conversation has none', async () => {
      deps.state.currentConversationId = 'conv-1';
      (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
        id: 'conv-1',
        messages: [],
        sessionId: null,
        enabledMcpServers: undefined,
      });

      await controller.loadActive();

      expect(mockMcpServerSelector.clearEnabled).toHaveBeenCalled();
    });
  });

  describe('switchTo', () => {
    it('should restore enabled MCP servers when switching conversations', async () => {
      deps.state.currentConversationId = 'old-conv';
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        providerId: 'claude',
        messages: [],
        sessionId: null,
        enabledMcpServers: ['switched-server'],
      });

      await controller.switchTo('new-conv');

      expect(mockMcpServerSelector.setEnabledServers).toHaveBeenCalledWith(['switched-server']);
    });

    it('should clear MCP servers when switching to conversation with no servers', async () => {
      deps.state.currentConversationId = 'old-conv';
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'new-conv',
        providerId: 'claude',
        messages: [],
        sessionId: null,
        enabledMcpServers: undefined,
      });

      await controller.switchTo('new-conv');

      expect(mockMcpServerSelector.clearEnabled).toHaveBeenCalled();
    });

    it('should ensure the tab service matches the switched conversation provider', async () => {
      const ensureServiceForConversation = jest.fn().mockResolvedValue(undefined);
      const switchedConversation = {
        id: 'new-conv',
        providerId: 'codex',
        title: 'Codex Conversation',
        messages: [],
        sessionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      deps = createMockDeps({
        ensureServiceForConversation,
        plugin: {
          ...createMockDeps().plugin,
          switchConversation: jest.fn().mockResolvedValue(switchedConversation),
        } as any,
      });
      controller = new ConversationController(deps);
      deps.state.currentConversationId = 'old-conv';

      await controller.switchTo('new-conv');

      expect(ensureServiceForConversation).toHaveBeenCalledWith(switchedConversation);
    });
  });

  describe('createNew', () => {
    it('should clear enabled MCP servers for new conversation', async () => {
      await controller.createNew();

      expect(mockMcpServerSelector.clearEnabled).toHaveBeenCalled();
    });
  });
});

describe('ConversationController - Race Condition Guards', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    controller = new ConversationController(deps);
  });

  describe('createNew guards', () => {
    it('should not create when isCreatingConversation is already true', async () => {
      deps.state.isCreatingConversation = true;

      await controller.createNew();

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should not create when isSwitchingConversation is true', async () => {
      deps.state.isSwitchingConversation = true;

      await controller.createNew();

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });

    it('should reset even when streaming if force is true', async () => {
      deps.state.isStreaming = true;
      deps.state.cancelRequested = false;
      const initialGeneration = deps.state.streamGeneration;

      await controller.createNew({ force: true });

      expect(deps.state.isStreaming).toBe(false);
      expect(deps.state.cancelRequested).toBe(true);
      expect(deps.state.streamGeneration).toBe(initialGeneration + 1);
      expect(deps.state.currentConversationId).toBeNull();
    });

    it('should set and reset isCreatingConversation flag during entry point reset', async () => {
      // Entry point model: createNew() just resets state, doesn't create conversation
      // But isCreatingConversation flag should still be set during the reset
      let flagDuringExecution = false;

      deps.state.clearMessages = jest.fn(() => {
        flagDuringExecution = deps.state.isCreatingConversation;
      });

      await controller.createNew();

      expect(flagDuringExecution).toBe(true);
      expect(deps.state.isCreatingConversation).toBe(false);
    });
  });

  describe('switchTo guards', () => {
    it('should not switch when isSwitchingConversation is already true', async () => {
      deps.state.currentConversationId = 'old-conv';
      deps.state.isSwitchingConversation = true;

      await controller.switchTo('new-conv');

      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should not switch when isCreatingConversation is true', async () => {
      deps.state.currentConversationId = 'old-conv';
      deps.state.isCreatingConversation = true;

      await controller.switchTo('new-conv');

      expect(deps.plugin.switchConversation).not.toHaveBeenCalled();
    });

    it('should reset isSwitchingConversation flag even on error', async () => {
      deps.state.currentConversationId = 'old-conv';
      (deps.plugin.switchConversation as jest.Mock).mockRejectedValue(new Error('Switch failed'));

      await expect(controller.switchTo('new-conv')).rejects.toThrow('Switch failed');

      expect(deps.state.isSwitchingConversation).toBe(false);
    });

    it('should reset isSwitchingConversation flag when conversation not found', async () => {
      deps.state.currentConversationId = 'old-conv';
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(null);

      await controller.switchTo('non-existent');

      expect(deps.state.isSwitchingConversation).toBe(false);
    });

    it('should set isSwitchingConversation flag during switch', async () => {
      deps.state.currentConversationId = 'old-conv';
      let flagDuringSwitch = false;
      (deps.plugin.switchConversation as jest.Mock).mockImplementation(async () => {
        flagDuringSwitch = deps.state.isSwitchingConversation;
        return {
          id: 'new-conv',
          title: 'New Conversation',
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      });

      await controller.switchTo('new-conv');

      expect(flagDuringSwitch).toBe(true);
      expect(deps.state.isSwitchingConversation).toBe(false);
    });
  });

  describe('mutual exclusion', () => {
    it('should prevent createNew during switchTo', async () => {
      deps.state.currentConversationId = 'old-conv';

      // Simulate switchTo in progress
      let switchPromiseResolve: () => void;
      const switchPromise = new Promise<void>((resolve) => {
        switchPromiseResolve = resolve;
      });

      (deps.plugin.switchConversation as jest.Mock).mockImplementation(async () => {
        // During switch, try to createNew
        const createPromise = controller.createNew();

        // createNew should be blocked because isSwitchingConversation is true
        expect(deps.plugin.createConversation).not.toHaveBeenCalled();

        switchPromiseResolve!();
        await createPromise;

        return {
          id: 'new-conv',
          messages: [],
          sessionId: null,
        };
      });

      await controller.switchTo('new-conv');
      await switchPromise;

      expect(deps.plugin.createConversation).not.toHaveBeenCalled();
    });
  });
});

describe('ConversationController - Persistent External Context Paths', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockExternalContextSelector: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExternalContextSelector = {
      getExternalContexts: jest.fn().mockReturnValue([]),
      setExternalContexts: jest.fn(),
      clearExternalContexts: jest.fn(),
    };
    deps = createMockDeps({
      getExternalContextSelector: () => mockExternalContextSelector,
    });
    (deps.plugin.settings as any).persistentExternalContextPaths = ['/persistent/path/a', '/persistent/path/b'];
    controller = new ConversationController(deps);
  });

  describe('createNew', () => {
    it('should call clearExternalContexts with persistent paths from settings', async () => {
      await controller.createNew();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/persistent/path/a', '/persistent/path/b']
      );
    });

    it('should call clearExternalContexts with empty array if no persistent paths', async () => {
      (deps.plugin.settings as any).persistentExternalContextPaths = undefined;

      await controller.createNew();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith([]);
    });
  });

  describe('loadActive', () => {
    it('should use persistent paths for new conversation (no existing conversation)', async () => {
      deps.state.currentConversationId = null;

      await controller.loadActive();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/persistent/path/a', '/persistent/path/b']
      );
    });

    it('should use persistent paths for empty conversation (msg=0)', async () => {
      deps.state.currentConversationId = 'existing-conv';
      deps.plugin.getConversationById = jest.fn().mockResolvedValue({
        id: 'existing-conv',
        messages: [],
        sessionId: null,
      });

      await controller.loadActive();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/persistent/path/a', '/persistent/path/b']
      );
    });

    it('should restore saved paths for conversation with messages (msg>0)', async () => {
      deps.state.currentConversationId = 'existing-conv';
      deps.plugin.getConversationById = jest.fn().mockResolvedValue({
        id: 'existing-conv',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: ['/saved/path'],
      });

      await controller.loadActive();

      expect(mockExternalContextSelector.setExternalContexts).toHaveBeenCalledWith(['/saved/path']);
      expect(mockExternalContextSelector.clearExternalContexts).not.toHaveBeenCalled();
    });

    it('should restore empty paths for conversation with messages but no saved paths', async () => {
      deps.state.currentConversationId = 'existing-conv';
      deps.plugin.getConversationById = jest.fn().mockResolvedValue({
        id: 'existing-conv',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: undefined,
      });

      await controller.loadActive();

      expect(mockExternalContextSelector.setExternalContexts).toHaveBeenCalledWith([]);
    });
  });

  describe('switchTo', () => {
    beforeEach(() => {
      deps.state.currentConversationId = 'old-conv';
    });

    it('should use persistent paths when switching to empty conversation (msg=0)', async () => {
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'empty-conv',
        messages: [],
        sessionId: null,
        externalContextPaths: ['/old/saved/path'],
      });

      await controller.switchTo('empty-conv');

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/persistent/path/a', '/persistent/path/b']
      );
      expect(mockExternalContextSelector.setExternalContexts).not.toHaveBeenCalled();
    });

    it('should restore saved paths when switching to conversation with messages', async () => {
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'conv-with-messages',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: ['/saved/path/from/session'],
      });

      await controller.switchTo('conv-with-messages');

      expect(mockExternalContextSelector.setExternalContexts).toHaveBeenCalledWith(
        ['/saved/path/from/session']
      );
      expect(mockExternalContextSelector.clearExternalContexts).not.toHaveBeenCalled();
    });

    it('should restore empty array for conversation with messages but no saved paths', async () => {
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'conv-with-messages',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: undefined,
      });

      await controller.switchTo('conv-with-messages');

      expect(mockExternalContextSelector.setExternalContexts).toHaveBeenCalledWith([]);
    });
  });

  describe('Scenario: Adding persistent paths across sessions', () => {
    it('should show all persistent paths when returning to empty session', async () => {
      // Scenario:
      // 1. User is in session 0 (empty), adds path A as persistent
      // 2. User switches to session 1 (with messages), adds path B as persistent
      // 3. User returns to session 0 (empty) - should see both A and B

      // Step 1: Session 0 is empty, persistent paths = [A]
      (deps.plugin.settings as any).persistentExternalContextPaths = ['/path/a'];
      deps.state.currentConversationId = null;
      await controller.loadActive();

      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(['/path/a']);

      // Step 2: User switches to session 1 and adds path B, settings now have [A, B]
      deps.state.currentConversationId = 'session-0'; // Currently in session 0
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'session-1',
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        sessionId: null,
        externalContextPaths: [],
      });
      await controller.switchTo('session-1');

      // User adds path B in session 1, settings now have [A, B]
      (deps.plugin.settings as any).persistentExternalContextPaths = ['/path/a', '/path/b'];

      // Step 3: User returns to session 0 (empty)
      (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
        id: 'session-0',
        messages: [], // Empty session
        sessionId: null,
        externalContextPaths: ['/path/a'], // Only had A when originally created
      });

      jest.clearAllMocks();
      await controller.switchTo('session-0');

      // Should get BOTH paths because session is empty (msg=0)
      expect(mockExternalContextSelector.clearExternalContexts).toHaveBeenCalledWith(
        ['/path/a', '/path/b']
      );
    });
  });
});

function createMockBuildSessionUpdates(mockService: any) {
  return jest.fn().mockImplementation(({ conversation, sessionInvalidated }: any) => {
    const sessionId = mockService.getSessionId();
    const legacyMessages = conversation?.messages ?? [];
    const hasSession = !!sessionId;
    const legacyCutoffAt = hasSession && !conversation?.providerSessionId
      ? legacyMessages[legacyMessages.length - 1]?.timestamp
      : conversation?.legacyCutoffAt;
    const oldSdkSessionId = conversation?.providerSessionId;
    const sessionChanged = hasSession && sessionId && oldSdkSessionId && sessionId !== oldSdkSessionId;
    const previousProviderSessionIds = sessionChanged
      ? [...new Set([...(conversation?.previousProviderSessionIds || []), oldSdkSessionId])]
      : conversation?.previousProviderSessionIds;
    const isForkSourceOnly = !!conversation?.forkSource &&
      !conversation?.providerSessionId &&
      sessionId === conversation.forkSource.sessionId;
    let resolvedSessionId: string | null;
    if (sessionInvalidated) {
      resolvedSessionId = null;
    } else if (isForkSourceOnly) {
      resolvedSessionId = conversation?.sessionId ?? null;
    } else {
      resolvedSessionId = sessionId ?? conversation?.sessionId ?? null;
    }
    const updates: any = {
      sessionId: resolvedSessionId,
      providerSessionId: hasSession && sessionId && !isForkSourceOnly ? sessionId : conversation?.providerSessionId,
      previousProviderSessionIds,
      legacyCutoffAt,
    };
    if (conversation?.forkSource && sessionId && sessionId !== conversation.forkSource.sessionId) {
      updates.forkSource = undefined;
    }
    return { updates };
  });
}

describe('ConversationController - Previous SDK Session IDs', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockAgentService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentService = {
      getSessionId: jest.fn().mockReturnValue(null),
      setSessionId: jest.fn(),
      consumeSessionInvalidation: jest.fn().mockReturnValue(false),
      buildSessionUpdates: null as any,
    };
    mockAgentService.buildSessionUpdates = createMockBuildSessionUpdates(mockAgentService);
    deps = createMockDeps({
      getAgentService: () => mockAgentService,
    });
    controller = new ConversationController(deps);
  });

  describe('save - session change detection', () => {
    it('should accumulate old providerSessionId when SDK creates new session', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      // Existing conversation has providerSessionId 'session-A'
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue({
        id: 'conv-1',
        messages: [],
        providerSessionId: 'session-A',
        previousProviderSessionIds: undefined,
      });

      // Agent service reports new session 'session-B' (resume failed, new session created)
      mockAgentService.getSessionId.mockReturnValue('session-B');

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          providerSessionId: 'session-B',
          previousProviderSessionIds: ['session-A'],
        })
      );
    });

    it('should preserve existing previousProviderSessionIds when session changes again', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      // Conversation already has previous sessions [A], current is B
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue({
        id: 'conv-1',
        messages: [],
        providerSessionId: 'session-B',
        previousProviderSessionIds: ['session-A'],
      });

      // Agent service reports new session 'session-C'
      mockAgentService.getSessionId.mockReturnValue('session-C');

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          providerSessionId: 'session-C',
          previousProviderSessionIds: ['session-A', 'session-B'],
        })
      );
    });

    it('should not modify previousProviderSessionIds when session has not changed', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue({
        id: 'conv-1',
        messages: [],
        providerSessionId: 'session-A',
        previousProviderSessionIds: undefined,
      });

      mockAgentService.getSessionId.mockReturnValue('session-A');

      await controller.save();

      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          providerSessionId: 'session-A',
          previousProviderSessionIds: undefined,
        })
      );
    });

    it('should deduplicate session IDs to prevent duplicates from race conditions', async () => {
      deps.state.currentConversationId = 'conv-1';
      deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

      // Simulate a race condition where session-A is already in previousProviderSessionIds
      // but providerSessionId is still session-A (should not duplicate)
      (deps.plugin.getConversationSync as jest.Mock).mockReturnValue({
        id: 'conv-1',
        messages: [],
        providerSessionId: 'session-A',
        previousProviderSessionIds: ['session-A'], // Already contains A (from prior bug/race)
      });

      // Agent reports new session-B
      mockAgentService.getSessionId.mockReturnValue('session-B');

      await controller.save();

      // Should deduplicate: [A, A] -> [A]
      expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          providerSessionId: 'session-B',
          previousProviderSessionIds: ['session-A'], // Deduplicated, not ['session-A', 'session-A']
        })
      );
    });
  });
});

describe('ConversationController - Fork Session ID Isolation', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockAgentService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentService = {
      getSessionId: jest.fn().mockReturnValue(null),
      setSessionId: jest.fn(),
      consumeSessionInvalidation: jest.fn().mockReturnValue(false),
      buildSessionUpdates: null as any,
    };
    mockAgentService.buildSessionUpdates = createMockBuildSessionUpdates(mockAgentService);
    deps = createMockDeps({
      getAgentService: () => mockAgentService,
    });
    controller = new ConversationController(deps);
  });

  it('should not persist fork source session ID as conversation own sessionId/providerSessionId', async () => {
    deps.state.currentConversationId = 'fork-conv';
    deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

    // Fork conversation: has forkSource but no own providerSessionId yet
    (deps.plugin.getConversationSync as jest.Mock).mockReturnValue({
      id: 'fork-conv',
      messages: [],
      sessionId: null,
      providerSessionId: undefined,
      forkSource: { sessionId: 'source-session-abc', resumeAt: 'assistant-uuid-1' },
    });

    // Agent service has the fork source ID set for resume purposes
    mockAgentService.getSessionId.mockReturnValue('source-session-abc');

    await controller.save();

    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'fork-conv',
      expect.objectContaining({
        sessionId: null,
        providerSessionId: undefined,
      })
    );
  });

  it('should persist new session ID after SDK captures a different session for fork', async () => {
    deps.state.currentConversationId = 'fork-conv';
    deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

    (deps.plugin.getConversationSync as jest.Mock).mockReturnValue({
      id: 'fork-conv',
      messages: [],
      sessionId: null,
      providerSessionId: undefined,
      forkSource: { sessionId: 'source-session-abc', resumeAt: 'assistant-uuid-1' },
    });

    // SDK captured a new session (different from fork source)
    mockAgentService.getSessionId.mockReturnValue('new-session-xyz');

    await controller.save();

    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'fork-conv',
      expect.objectContaining({
        sessionId: 'new-session-xyz',
        providerSessionId: 'new-session-xyz',
        forkSource: undefined,
      })
    );
  });

  it('should allow normal session ID persistence when fork metadata is already cleared', async () => {
    deps.state.currentConversationId = 'fork-conv';
    deps.state.messages = [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }];

    // Fork conversation after fork metadata was cleared (has its own providerSessionId)
    (deps.plugin.getConversationSync as jest.Mock).mockReturnValue({
      id: 'fork-conv',
      messages: [],
      sessionId: 'new-session-xyz',
      providerSessionId: 'new-session-xyz',
      forkSource: undefined,
    });

    mockAgentService.getSessionId.mockReturnValue('new-session-xyz');

    await controller.save();

    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'fork-conv',
      expect.objectContaining({
        sessionId: 'new-session-xyz',
        providerSessionId: 'new-session-xyz',
      })
    );
  });
});

describe('ConversationController - switchTo fork path', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockAgentService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentService = {
      getSessionId: jest.fn().mockReturnValue(null),
      syncConversationState: jest.fn(),
      consumeSessionInvalidation: jest.fn().mockReturnValue(false),
      buildSessionUpdates: null as any,
    };
    mockAgentService.buildSessionUpdates = createMockBuildSessionUpdates(mockAgentService);
    deps = createMockDeps({
      getAgentService: () => mockAgentService,
    });
    controller = new ConversationController(deps);
  });

  it('should sync conversation state for pending fork conversations', async () => {
    deps.state.currentConversationId = 'old-conv';

    const forkConversation = {
      id: 'fork-conv',
      messages: [{ id: '1', role: 'user', content: 'forked msg', timestamp: Date.now() }],
      sessionId: null,
      providerSessionId: undefined,
      forkSource: { sessionId: 'source-session-abc', resumeAt: 'assistant-uuid-1' },
    };
    (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(forkConversation);

    await controller.switchTo('fork-conv');

    expect(mockAgentService.syncConversationState).toHaveBeenCalledWith(
      forkConversation,
      expect.any(Array),
    );
  });

  it('should resolve to own sessionId when fork already has its own session', async () => {
    deps.state.currentConversationId = 'old-conv';

    const forkConversation = {
      id: 'fork-conv',
      messages: [{ id: '1', role: 'user', content: 'forked msg', timestamp: Date.now() }],
      sessionId: 'own-session-xyz',
      providerSessionId: 'own-session-xyz',
      forkSource: { sessionId: 'source-session-abc', resumeAt: 'assistant-uuid-1' },
    };
    (deps.plugin.switchConversation as jest.Mock).mockResolvedValue(forkConversation);

    await controller.switchTo('fork-conv');

    expect(mockAgentService.syncConversationState).toHaveBeenCalledWith(
      forkConversation,
      expect.any(Array),
    );
  });
});

describe('ConversationController - restoreExternalContextPaths null selector', () => {
  it('should return early when external context selector is null', async () => {
    const deps = createMockDeps({
      getExternalContextSelector: () => null,
    });
    const controller = new ConversationController(deps);

    deps.state.currentConversationId = 'old-conv';
    (deps.plugin.switchConversation as jest.Mock).mockResolvedValue({
      id: 'new-conv',
      messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
      sessionId: null,
      externalContextPaths: ['/some/path'],
    });

    // Should not throw even though selector is null
    await expect(controller.switchTo('new-conv')).resolves.not.toThrow();
  });
});

describe('ConversationController - regenerateTitle callback branches', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockTitleService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTitleService = {
      generateTitle: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn(),
    };
    deps = createMockDeps({
      getTitleGenerationService: () => mockTitleService,
    });
    controller = new ConversationController(deps);
  });

  it('should mark as failed when generation fails and user has not renamed', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        // On callback, getConversationById returns same title (user didn't rename)
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
          id: 'conv-1',
          title: 'Original Title',
          messages: [],
        });
        await callback('conv-1', { success: false, title: '' });
      }
    );

    await controller.regenerateTitle('conv-1');

    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
      titleGenerationStatus: 'failed',
    });
  });

  it('should keep status untouched when user manually renamed during generation (status cleared later by finishRename)', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    // Simulate callback where user has renamed the conversation
    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        // On callback, getConversationById returns a different title (user renamed)
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
          id: 'conv-1',
          title: 'User Renamed Title',
          messages: [],
        });
        await callback('conv-1', { success: true, title: 'AI Generated Title' });
      }
    );

    await controller.regenerateTitle('conv-1');

    // Should NOT rename because user already renamed
    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
    // Patched behavior: manual rename no longer clears status in the callback
    // (finishRename owns clearing it); only the initial pending write happens.
    expect(deps.plugin.updateConversation).toHaveBeenCalledTimes(1);
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conv-1', {
      titleGenerationStatus: 'pending',
    });
  });

  it('should not apply title when conversation no longer exists during callback', async () => {
    (deps.plugin.getConversationById as jest.Mock).mockResolvedValue({
      id: 'conv-1',
      title: 'Original Title',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });

    // Simulate callback where conversation was deleted
    mockTitleService.generateTitle.mockImplementation(
      async (_convId: string, _user: string, callback: any) => {
        (deps.plugin.getConversationById as jest.Mock).mockResolvedValue(null);
        await callback('conv-1', { success: true, title: 'New Title' });
      }
    );

    await controller.regenerateTitle('conv-1');

    expect(deps.plugin.renameConversation).not.toHaveBeenCalled();
  });
});

describe('ConversationController - Rewind', () => {
  let controller: ConversationController;
  let deps: ConversationControllerDeps;
  let mockAgentService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentService = {
      getSessionId: jest.fn().mockReturnValue(null),
      setSessionId: jest.fn(),
      consumeSessionInvalidation: jest.fn().mockReturnValue(false),
      rewind: jest.fn().mockResolvedValue({ canRewind: true, filesChanged: ['a.ts'] }),
      getCapabilities: jest.fn().mockReturnValue({ supportsRewind: true }),
      buildSessionUpdates: null as any,
    };
    mockAgentService.buildSessionUpdates = createMockBuildSessionUpdates(mockAgentService);
    deps = createMockDeps({
      getAgentService: () => mockAgentService,
    });
    controller = new ConversationController(deps);
  });

  it('loads exact detail before confirming a summary rewind and prefills displayContent', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a', projectionLevel: 'detail' },
      { id: 'm2', role: 'user', content: 'summary', timestamp: 2, userMessageId: 'user-uuid', projectionLevel: 'summary' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a', projectionLevel: 'detail' },
    ];
    const loadMessageDetail = jest.fn().mockResolvedValue({
      status: 'exact',
      message: { id: 'm2', role: 'user', content: 'expanded exact', displayContent: 'exact input', timestamp: 2, userMessageId: 'user-uuid', projectionLevel: 'detail' },
    });
    deps.state.historyLease = { loadMessageDetail } as any;

    await controller.rewind('m2');

    expect(loadMessageDetail).toHaveBeenCalledWith('m2', { maxSourceBytes: 16 * 1024 * 1024 });
    expect(confirm).toHaveBeenCalled();
    expect(mockAgentService.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a');
    expect(deps.getInputEl().value).toBe('exact input');
  });

  it.each(['not_found', 'too_large'] as const)('aborts a summary rewind when detail is %s without changing input', async status => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a', projectionLevel: 'detail' },
      { id: 'm2', role: 'user', content: 'summary', timestamp: 2, userMessageId: 'user-uuid', projectionLevel: 'summary' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a', projectionLevel: 'detail' },
    ];
    deps.getInputEl().value = 'unchanged';
    deps.state.historyLease = { loadMessageDetail: jest.fn().mockResolvedValue({ status }) } as any;

    await controller.rewind('m2');

    expect(confirm).not.toHaveBeenCalled();
    expect(mockAgentService.rewind).not.toHaveBeenCalled();
    expect(deps.getInputEl().value).toBe('unchanged');
  });

  it('should find prev/response assistants with bounded scan (skipping non-uuid messages)', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'assistant', content: 'boundary', timestamp: 2 }, // No uuid
      { id: 'm3', role: 'user', content: 'test', timestamp: 3, userMessageId: 'user-uuid' },
      { id: 'm4', role: 'assistant', content: 'boundary2', timestamp: 4 }, // No uuid
      { id: 'm5', role: 'assistant', content: 'resp', timestamp: 5, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m3');

    expect(mockAgentService.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a');
  });

  it('should show Notice when message ID not found', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('nonexistent');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockAgentService.rewind).not.toHaveBeenCalled();
  });

  it('should show Notice when streaming', async () => {
    deps.state.isStreaming = true;
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockAgentService.rewind).not.toHaveBeenCalled();
  });

  it('should show Notice when user message has no userMessageId', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2 }, // No userMessageId
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockAgentService.rewind).not.toHaveBeenCalled();
  });

  it('should show Notice when no previous assistant with uuid exists', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'user', content: 'test', timestamp: 1, userMessageId: 'u1' },
      { id: 'm2', role: 'assistant', content: '', timestamp: 2, assistantMessageId: 'a1' },
    ];

    await controller.rewind('m1');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockAgentService.rewind).not.toHaveBeenCalled();
  });

  it('should show Notice when no response assistant with uuid exists', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockAgentService.rewind).not.toHaveBeenCalled();
  });

  it('should show i18n Notice on SDK rewind exception', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    mockAgentService.rewind.mockRejectedValue(new Error('SDK error'));

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('SDK error');
  });

  it('should show i18n Notice when canRewind is false', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    mockAgentService.rewind.mockResolvedValue({ canRewind: false, error: 'No checkpoints' });

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('No checkpoints');
  });

  it('should truncateAt, save with resumeAtMessageId, and renderMessages on success', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    const truncateSpy = jest.spyOn(deps.state, 'truncateAt');

    await controller.rewind('m2');

    expect(mockAgentService.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a');
    expect(truncateSpy).toHaveBeenCalledWith('m2');
    expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function)
    );
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ resumeAtMessageId: 'prev-a' })
    );

    // Should populate input with rewound message content
    const inputEl = deps.getInputEl();
    expect(inputEl.value).toBe('test');
    expect(inputEl.focus).toHaveBeenCalled();

    // Should show success notice with file count
    const noticeMsg = mockNotice.mock.calls[0][0] as string;
    expect(noticeMsg).toContain('1');

    truncateSpy.mockRestore();
  });

  it('should abort when confirmation is declined', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    (confirm as jest.Mock).mockResolvedValueOnce(false);

    await controller.rewind('m2');

    expect(mockAgentService.rewind).not.toHaveBeenCalled();
    expect(mockNotice).not.toHaveBeenCalled();
  });

  it('should re-check streaming state after confirmation dialog', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    (confirm as jest.Mock).mockImplementationOnce(async () => {
      deps.state.isStreaming = true;
      return true;
    });

    await controller.rewind('m2');

    expect(mockAgentService.rewind).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalled();
  });

  it('should show a warning notice when rewind succeeded but save failed', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    (deps.plugin.updateConversation as jest.Mock).mockRejectedValueOnce(new Error('Save failed'));

    await controller.rewind('m2');

    expect(mockAgentService.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a');
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('Save failed');
  });

  describe('Inline prompt dismissal', () => {
    it('dismisses pending inline prompts during createNew()', async () => {
      const dismissFn = jest.fn();
      deps = createMockDeps({ dismissPendingInlinePrompts: dismissFn });
      controller = new ConversationController(deps);

      await controller.createNew();

      expect(dismissFn).toHaveBeenCalled();
    });

    it('dismisses pending inline prompts during switchTo()', async () => {
      const dismissFn = jest.fn();
      deps = createMockDeps({ dismissPendingInlinePrompts: dismissFn });
      controller = new ConversationController(deps);
      deps.state.currentConversationId = 'old-conv';

      await controller.switchTo('switched-conv');

      expect(dismissFn).toHaveBeenCalled();
    });
  });
});
