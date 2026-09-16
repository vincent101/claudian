import type { HistoryLoadBudget } from '@/core/providers/types';
import type { ChatMessage, Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import { loadSDKSessionMessages, materializeSDKMessages, sdkSessionExists } from '@/providers/claude/history/ClaudeHistoryStore';
import {
  buildTranscriptIndex,
  clearTranscriptIndexCache,
  materializeTranscriptEntries,
  materializeTranscriptPage,
  materializeTranscriptToolAssociations,
} from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import { measureChatProjectionChars } from '@/providers/claude/history/HistorySummaryProjection';

jest.mock('@/providers/claude/history/ClaudeTranscriptHistoryIndex', () => ({
  buildTranscriptIndex: jest.fn().mockResolvedValue({ status: 'complete', index: { entries: [], turns: [] } }),
  clearTranscriptIndexCache: jest.fn(),
  materializeTranscriptEntries: jest.fn(),
  materializeTranscriptPage: jest.fn(),
  materializeTranscriptToolAssociations: jest.fn(),
  protectTranscriptIndex: jest.fn(),
  releaseTranscriptIndex: jest.fn(),
  setTranscriptIndexDiagnosticSink: jest.fn(),
}));
jest.mock('@/providers/claude/history/ClaudeHistoryStore', () => ({
  loadSDKSessionMessages: jest.fn(),
  materializeSDKMessages: jest.fn(),
  loadSubagentToolCalls: jest.fn().mockResolvedValue([]),
  sdkSessionExists: jest.fn().mockReturnValue(true),
  deleteSDKSession: jest.fn().mockResolvedValue(undefined),
}));

const mockLoadSDKSessionMessages = loadSDKSessionMessages as jest.MockedFunction<typeof loadSDKSessionMessages>;
const mockSdkSessionExists = sdkSessionExists as jest.MockedFunction<typeof sdkSessionExists>;
const mockBuildTranscriptIndex = buildTranscriptIndex as jest.MockedFunction<typeof buildTranscriptIndex>;
const mockMaterializeTranscriptEntries = materializeTranscriptEntries as jest.MockedFunction<typeof materializeTranscriptEntries>;
const mockClearTranscriptIndexCache = clearTranscriptIndexCache as jest.MockedFunction<typeof clearTranscriptIndexCache>;
const mockMaterializeTranscriptPage = materializeTranscriptPage as jest.MockedFunction<typeof materializeTranscriptPage>;
const mockMaterializeTranscriptToolAssociations = materializeTranscriptToolAssociations as jest.MockedFunction<typeof materializeTranscriptToolAssociations>;
const mockMaterializeSDKMessages = materializeSDKMessages as jest.MockedFunction<typeof materializeSDKMessages>;

function createConversation(): Conversation {
  return {
    id: 'conversation-1',
    providerId: 'claude',
    title: 'Large history',
    createdAt: 1,
    updatedAt: 1,
    sessionId: 'current-session',
    providerState: {
      previousProviderSessionIds: ['previous-session'],
      providerSessionId: 'current-session',
    },
    messages: [],
  };
}

describe('ClaudeConversationHistoryService M1 fuse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSdkSessionExists.mockReturnValue(true);
  });

  it('preserves subagent metadata outside the currently materialized page when saving', () => {
    const conversation = createConversation();
    const oldSubagent = { id: 'old-agent', mode: 'async', status: 'completed', taskId: 'old-task' } as any;
    const visibleSubagent = { id: 'visible-agent', mode: 'sync', status: 'completed', taskId: 'visible-task' } as any;
    conversation.providerState = {
      ...conversation.providerState,
      subagentData: { 'old-agent': oldSubagent },
    };
    conversation.messages = [{
      id: 'assistant',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{ id: 'tool', name: 'Task', input: {}, status: 'completed', subagent: visibleSubagent }],
    }];
    const service = new ClaudeConversationHistoryService();

    expect(service.buildPersistedProviderState(conversation)).toMatchObject({
      subagentData: {
        'old-agent': oldSubagent,
        'visible-agent': visibleSubagent,
      },
    });
  });

  it('returns oversize without merging a successful previous segment', async () => {
    mockLoadSDKSessionMessages
      .mockResolvedValueOnce({
        status: 'complete',
        messages: [{ id: 'old', role: 'user', content: 'old', timestamp: 1 }],
        skippedLines: 0,
      })
      .mockResolvedValueOnce({
        status: 'oversize',
        messages: [],
        skippedLines: 0,
        sizeBytes: 65 * 1024 * 1024,
      });
    const conversation = createConversation();
    const service = new ClaudeConversationHistoryService();

    const result = await service.hydrateConversationHistory(conversation, '/vault');

    expect(result).toEqual({
      status: 'oversize',
      segments: [{ sessionId: 'current-session', sizeBytes: 65 * 1024 * 1024 }],
    });
    expect(conversation.messages).toEqual([]);
    // Shadow prewarm removed: the oversize hydration only reports structured
    // state; the active tab builds the index through acquireHistoryIndex.
    expect(mockBuildTranscriptIndex).not.toHaveBeenCalled();
  });

  it('shares one build across leases and loads exact stateless ranges', async () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
    mockBuildTranscriptIndex.mockResolvedValue({ status: 'complete', index: { filePath: '/current', dev: 1, ino: 1, snapshotSize: 999, mtimeMs: 1, entries: [], turns, searchCorpus: [], searchText: '', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    mockMaterializeTranscriptPage.mockResolvedValue([]); mockMaterializeTranscriptToolAssociations.mockResolvedValue([]); mockMaterializeSDKMessages.mockResolvedValue([]);
    const service = new ClaudeConversationHistoryService(); const conversation = createConversation();
    const first = service.acquireHistoryIndex(conversation, '/vault'); const second = service.acquireHistoryIndex(conversation, '/vault');
    await first.ready; await second.ready;
    expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1); expect(first.totalTurns).toBe(120);
    await first.loadRange(70, 120);
    expect(mockMaterializeTranscriptPage).toHaveBeenCalledWith(expect.anything(), 70, 50);
    await expect(first.loadRange(-1, 2)).rejects.toThrow(RangeError);
    first.release(); first.release(); await expect(second.loadRange(0, 1)).resolves.toBeDefined(); second.release();
  });

  it('enumerates every non-overlapping match with stable projection ordinals', async () => {
    const searchText = 'needle needle needleneedle';
    const searchCorpus = [
      { projectionKey: 'same', turnIndex: 1, entryIndex: 0, timestamp: '', textOffset: 0, textLength: 13 },
      { projectionKey: 'same', turnIndex: 1, entryIndex: 1, timestamp: '', textOffset: 14, textLength: 12 },
    ];
    mockBuildTranscriptIndex.mockResolvedValue({ status: 'complete', index: { filePath: '/current', dev: 1, ino: 1, snapshotSize: 1, mtimeMs: 1, entries: [], turns: [{ turnId: '0', startEntry: 0, endEntry: 0, sourceBytes: 1024 }, { turnId: '1', startEntry: 1, endEntry: 1, sourceBytes: 1024 }], searchCorpus, searchText, skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    const service = new ClaudeConversationHistoryService(); const lease = service.acquireHistoryIndex(createConversation(), '/vault'); await lease.ready;
    await expect(lease.search('needle')).resolves.toEqual([
      expect.objectContaining({ projectionKey: 'same', turnIndex: 1, matchOrdinal: 0 }),
      expect.objectContaining({ projectionKey: 'same', turnIndex: 1, matchOrdinal: 1 }),
      expect.objectContaining({ projectionKey: 'same', turnIndex: 1, matchOrdinal: 2 }),
      expect.objectContaining({ projectionKey: 'same', turnIndex: 1, matchOrdinal: 3 }),
    ]);
  });

  it('orders same-turn search hits by canonical corpus position, not projectionKey string', async () => {
    const searchCorpus = [
      { projectionKey: 'zzz-user', turnIndex: 0, entryIndex: 0, timestamp: '', textOffset: 0, textLength: 6 },
      { projectionKey: 'aaa-assistant', turnIndex: 0, entryIndex: 1, timestamp: '', textOffset: 7, textLength: 6 },
    ];
    mockBuildTranscriptIndex.mockResolvedValue({ status: 'complete', index: { filePath: '/current', dev: 1, ino: 1, snapshotSize: 1, mtimeMs: 1, entries: [], turns: [{ turnId: '0', startEntry: 0, endEntry: 1, sourceBytes: 1024 }], searchCorpus, searchText: 'needle needle', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    const service = new ClaudeConversationHistoryService(); const lease = service.acquireHistoryIndex(createConversation(), '/vault'); await lease.ready;
    const results = await lease.search('needle');
    // Same turn: the user projection (entry 0) precedes the assistant one
    // regardless of their projectionKey strings.
    expect(results.map(result => result.projectionKey)).toEqual(['zzz-user', 'aaa-assistant']);
  });

  it('hydrates the merged history in canonical display order with the SDK key adopted by id', async () => {
    mockLoadSDKSessionMessages
      .mockResolvedValueOnce({
        status: 'complete',
        messages: [
          { id: 'p1', role: 'user', content: 'previous first', timestamp: 300, displayOrder: [0, 0, 0] },
          { id: 'p2', role: 'user', content: 'previous second', timestamp: 100, displayOrder: [0, 1, 0] },
        ],
        skippedLines: 0,
      })
      .mockResolvedValueOnce({
        status: 'complete',
        messages: [
          { id: 'c1', role: 'user', content: 'current', timestamp: 200, displayOrder: [1, 0, 0] },
        ],
        skippedLines: 0,
      });
    const conversation = createConversation();
    conversation.messages = [
      { id: 'live', role: 'assistant', content: 'live tail', timestamp: 400 },
      { id: 'c1', role: 'user', content: 'current (cached copy)', timestamp: 200 },
    ];
    const service = new ClaudeConversationHistoryService();

    await service.hydrateConversationHistory(conversation, '/vault');

    // The cached c1 copy adopts the SDK canonical key; the keyless live
    // message stays at the tail; timestamps (p2 newest-looking) never reorder.
    expect(conversation.messages.map(message => message.id)).toEqual(['p1', 'p2', 'c1', 'live']);
    expect(conversation.messages.find(message => message.id === 'c1')?.displayOrder).toEqual([1, 0, 0]);
    // Segment ordinals are explicit: previous sessions first, current last.
    expect(mockLoadSDKSessionMessages).toHaveBeenNthCalledWith(1, '/vault', 'previous-session', undefined, 0);
    expect(mockLoadSDKSessionMessages).toHaveBeenNthCalledWith(2, '/vault', 'current-session', undefined, 1);
  });

  it('drops a failed shared build so acquire can retry', async () => {
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    mockBuildTranscriptIndex.mockResolvedValueOnce({ status: 'failed', error: 'worker crashed' }).mockResolvedValueOnce({ status: 'complete', index: { filePath: '/current', dev: 1, ino: 1, snapshotSize: 1, mtimeMs: 1, entries: [], turns: [], searchCorpus: [], searchText: '', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } });
    const service = new ClaudeConversationHistoryService(); const conversation = createConversation();
    const callsBefore = mockBuildTranscriptIndex.mock.calls.length;
    const failed = service.acquireHistoryIndex(conversation, '/vault'); await expect(failed.ready).rejects.toThrow('worker crashed');
    const retried = service.acquireHistoryIndex(conversation, '/vault'); await expect(retried.ready).resolves.toBeUndefined();
    expect(mockBuildTranscriptIndex.mock.calls.length - callsBefore).toBe(2);
  });

  it('does not cache failures so hydration can be retried', async () => {
    mockLoadSDKSessionMessages
      .mockResolvedValueOnce({ status: 'failed', messages: [], skippedLines: 0, error: 'disk error' })
      .mockResolvedValueOnce({ status: 'failed', messages: [], skippedLines: 0, error: 'disk error' });
    const service = new ClaudeConversationHistoryService();
    const conversation = { ...createConversation(), providerState: {}, sessionId: 'current-session' };

    await service.hydrateConversationHistory(conversation, '/vault');
    await service.hydrateConversationHistory(conversation, '/vault');

    expect(mockLoadSDKSessionMessages).toHaveBeenCalledTimes(2);
  });

  describe('loadWindow budget materialization', () => {
    const MiB = 1024 * 1024;
    const budget = (overrides: Partial<HistoryLoadBudget> = {}): HistoryLoadBudget => ({
      maxTurns: 25,
      maxSourceBytes: 8 * MiB,
      maxProjectedChars: 2_000_000,
      timeSliceMs: 8,
      ...overrides,
    });

    function mockIndex(turns: Array<{ turnId: string; startEntry: number; endEntry: number; sourceBytes: number }>, entries: any[] = []) {
      return { status: 'complete' as const, index: { filePath: '/current', dev: 1, ino: 1, snapshotSize: 999, mtimeMs: 1, entries, turns, searchCorpus: [], searchText: '', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } };
    }

    async function nativeToMessages(_vaultPath: string, _sessionId: string, native: any[]): Promise<ChatMessage[]> {
      return native.map((message, index): ChatMessage => ({
        id: message.uuid ?? `n${index}`,
        role: message.type === 'user' ? 'user' : 'assistant',
        content: typeof message.message?.content === 'string' ? message.message.content : '',
        timestamp: index + 1,
      }));
    }

    beforeEach(() => {
      mockMaterializeTranscriptToolAssociations.mockImplementation(async (_index, pageEntries) => pageEntries);
      mockMaterializeSDKMessages.mockImplementation(nativeToMessages);
    });

    it('materializes the planned window within the byte and turn budgets', async () => {
      const turns = Array.from({ length: 30 }, (_, index) => ({ turnId: `u${index}`, startEntry: index * 2, endEntry: index * 2 + 1, sourceBytes: 1024 * 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow!({ anchorTurn: 30, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      // 25 x 1 MiB exceeds the 8 MiB byte budget, so bytes bind before turns.
      expect(page.range).toEqual({ start: 22, end: 30 });
      expect(page.sourceBytes).toBe(8 * 1024 * 1024);
      expect(page.projectedChars).toBe(0);
      expect(page.oversizedTurnCount).toBe(0);
      expect(page.pageKey).toBe('w:22:30');
      expect(page.hasMoreBefore).toBe(true);
      expect(page.hasMoreAfter).toBe(false);
      expect(mockMaterializeTranscriptPage).toHaveBeenCalledTimes(8);
    });

    it('plans the same window synchronously for progress reporting', async () => {
      const turns = Array.from({ length: 30 }, (_, index) => ({ turnId: `u${index}`, startEntry: index * 2, endEntry: index * 2 + 1, sourceBytes: 1024 * 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      expect(lease.planWindow!({ anchorTurn: 30, direction: 'older', budget: budget(), projectionLevel: 'summary' }))
        .toEqual({ start: 22, end: 30 });
    });

    it('returns the oversized newest turn as a bounded summary page', async () => {
      const giantBytes = 12 * MiB;
      const entries = [
        { offset: 0, length: 100, type: 'user', messageKey: 'u0', uuid: 'u0', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 100, length: 100, type: 'assistant', messageKey: 'a0', uuid: 'a0', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 200, length: 100, type: 'user', messageKey: 'u1', uuid: 'u1', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 300, length: 100, type: 'assistant', messageKey: 'a1', uuid: 'a1', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 400, length: 90, type: 'user', messageKey: 'u2', uuid: 'u2', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 490, length: 90, type: 'assistant', messageKey: 'tu2', uuid: 'tu2', realUser: false, displayable: false, isMeta: false, toolUseIds: ['toolu_2'], toolResultIds: [] },
        { offset: 580, length: giantBytes, type: 'user', messageKey: 'tr2', uuid: 'tr2', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: ['toolu_2'] },
        { offset: 580 + giantBytes, length: 80, type: 'assistant', messageKey: 'af2', uuid: 'af2', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
      ];
      const turns = [
        { turnId: 'u0', startEntry: 0, endEntry: 1, sourceBytes: 200 },
        { turnId: 'u1', startEntry: 2, endEntry: 3, sourceBytes: 200 },
        { turnId: 'u2', startEntry: 4, endEntry: 7, sourceBytes: 180 + giantBytes },
      ];
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns, entries));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptEntries.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow!({ anchorTurn: 3, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      expect(page.range).toEqual({ start: 2, end: 3 });
      expect(page.oversizedTurnCount).toBe(1);
      expect(page.sourceBytes).toBeLessThanOrEqual(budget().maxSourceBytes);
      // Only entries below the per-entry read cap were read (head and tail of the turn).
      const readEntries = mockMaterializeTranscriptEntries.mock.calls[0][1] as Array<{ messageKey: string }>;
      expect(readEntries.map(entry => entry.messageKey)).toEqual(['u2', 'tu2', 'af2']);
      // The projection received the tool-result placeholder plus the aggregate omission marker.
      const projected = mockMaterializeSDKMessages.mock.calls[0][2] as any[];
      const placeholder = projected.find(message => message.uuid === 'oversized-tr2');
      expect(placeholder).toMatchObject({ type: 'user', sourceToolUseID: 'toolu_2' });
      const marker = projected.find(message => message.uuid === 'oversized-marker-u2');
      expect((marker.message.content as any[])[0].text).toContain('1 transcript entries');
    });

    it('stops adding older turns once the projected-char budget is exceeded', async () => {
      const turns = Array.from({ length: 30 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      // Unique uuids per turn: real turns never share message ids, and the
      // measured == reported invariant below depends on dedupe not firing.
      let nativeCounter = 0;
      mockMaterializeTranscriptPage.mockImplementation(() => {
        nativeCounter += 1;
        return Promise.resolve([{ type: 'user', uuid: `native-${nativeCounter}` }]);
      });
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map((message, index) => ({ id: message.uuid ?? `n${index}`, role: 'user' as const, content: 'c'.repeat(1_000_000), timestamp: 1 })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow!({ anchorTurn: 30, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      // Two 1M-char turns fit the 2M budget; the third would exceed it.
      expect(page.range).toEqual({ start: 28, end: 30 });
      expect(page.projectedChars).toBe(2_000_000);
      // Old-turn cumulative overflow keeps the measured == reported invariant.
      expect(page.projectedChars).toBe(measureChatProjectionChars(page.messages));
      expect(page.projectedChars).toBeLessThanOrEqual(budget().maxProjectedChars);
    });

    it('hard-caps a plain turn whose projection alone exceeds the char budget (anchor)', async () => {
      const turns = Array.from({ length: 3 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([{ type: 'user', uuid: 'native' }]);
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map((message, index) => ({ id: message.uuid ?? `n${index}`, role: 'user' as const, content: 'c'.repeat(5000), timestamp: 1 })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow!({ anchorTurn: 3, direction: 'older', budget: budget({ maxProjectedChars: 1000 }), projectionLevel: 'summary' });

      // The oversized anchor turn is included as a summary projection, not an empty page.
      expect(page.range).toEqual({ start: 2, end: 3 });
      expect(page.oversizedTurnCount).toBe(1);
      // Hard cap: the real measured projection never exceeds the budget.
      expect(page.projectedChars).toBeLessThanOrEqual(1000);
      expect(page.projectedChars).toBe(measureChatProjectionChars(page.messages));
      expect(page.messages[0].content.length).toBeLessThanOrEqual(1000);
      // Explicit omission marker when there is room for one.
      expect(page.messages[0].content).toContain('…');
    });

    it('hard-caps an oversized source turn whose summary projection still exceeds the budget', async () => {
      const giantBytes = 20 * 1024 * 1024;
      const entries = [
        { offset: 0, length: 90, type: 'user', messageKey: 'u0', uuid: 'u0', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 90, length: 90, type: 'assistant', messageKey: 'a0', uuid: 'a0', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 180, length: giantBytes, type: 'user', messageKey: 'tr0', uuid: 'tr0', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
      ];
      const turns = [{ turnId: 'u0', startEntry: 0, endEntry: 2, sourceBytes: 180 + giantBytes }];
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns, entries));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptEntries.mockResolvedValue([]);
      // The materialized summary projection itself dwarfs the tiny budget.
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map((message, index) => ({ id: message.uuid ?? `n${index}`, role: 'user' as const, content: 's'.repeat(40_000), timestamp: 1 })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow!({ anchorTurn: 1, direction: 'older', budget: budget({ maxProjectedChars: 1000 }), projectionLevel: 'summary' });

      // Oversized source turn: hard-capped to the budget, shells kept.
      expect(page.range).toEqual({ start: 0, end: 1 });
      expect(page.projectedChars).toBeLessThanOrEqual(1000);
      expect(page.projectedChars).toBe(measureChatProjectionChars(page.messages));
      expect(page.messages.length).toBeGreaterThan(0);
      for (const message of page.messages) {
        expect(message.content.length).toBeLessThanOrEqual(1000);
      }
    });

    it('hard-caps the anchor when it is the only turn in the plan', async () => {
      const turns = [{ turnId: 'u0', startEntry: 0, endEntry: 0, sourceBytes: 1024 }];
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([{ type: 'user', uuid: 'native' }]);
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map((message, index) => ({ id: message.uuid ?? `n${index}`, role: 'user' as const, content: 'only '.repeat(2000), timestamp: 1 })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow!({ anchorTurn: 1, direction: 'older', budget: budget({ maxProjectedChars: 1000 }), projectionLevel: 'summary' });

      expect(page.range).toEqual({ start: 0, end: 1 });
      expect(page.projectedChars).toBeLessThanOrEqual(1000);
      expect(page.projectedChars).toBe(measureChatProjectionChars(page.messages));
      // The anchor's message identity survives the hard cap.
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0].id).toBe('native');
      expect(page.messages[0].content).toContain('…');
    });

    it('plans windows across segments', async () => {
      const prevTurns = Array.from({ length: 10 }, (_, index) => ({ turnId: `p${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 * 1024 }));
      const currentTurns = Array.from({ length: 5 }, (_, index) => ({ turnId: `c${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 * 1024 }));
      mockBuildTranscriptIndex.mockImplementation(async (path: string) =>
        String(path).includes('previous-session') ? mockIndex(prevTurns) : mockIndex(currentTurns));
      mockSdkSessionExists.mockReturnValue(true);
      mockMaterializeTranscriptPage.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;
      expect(lease.totalTurns).toBe(15);

      const page = await lease.loadWindow!({ anchorTurn: 15, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      expect(page.range).toEqual({ start: 7, end: 15 });
      expect(mockMaterializeTranscriptPage).toHaveBeenCalledTimes(8);
    });

    it('unprotects the snapshot without clearing the global transcript cache', async () => {
      const turns = Array.from({ length: 3 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      lease.release();

      // release() unprotects the snapshot for LRU but never wipes the global
      // completed cache; the idle-cache hit itself is covered by the index
      // module tests against the real cache.
      expect(mockClearTranscriptIndexCache).not.toHaveBeenCalled();
    });

    it('restores the canonical order of a newest-first materialized window by displayOrder', async () => {
      const turns = Array.from({ length: 3 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockImplementation(async (_index: any, start: number) => [{ type: 'user', uuid: `t${start}` }]);
      const orderById = new Map([
        ['t0', [0, 0, 0]],
        ['t1', [0, 1, 0]],
        ['t2', [0, 2, 0]],
      ]);
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map(message => ({
          id: message.uuid,
          role: 'user' as const,
          content: `content ${message.uuid}`,
          timestamp: 1,
          displayOrder: orderById.get(message.uuid) as [number, number, number] | undefined,
        })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow!({ anchorTurn: 3, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      // The window loop materializes newest-first; only the canonical
      // displayOrder key restores the ascending structural order (identical
      // timestamps here would otherwise keep the reversed push order).
      expect(page.messages.map(message => message.id)).toEqual(['t0', 't1', 't2']);
    });

    it('interleaves oversized summary placeholders at their canonical entry positions', async () => {
      const giantBytes = 12 * MiB;
      const entries = [
        { offset: 0, length: 100, type: 'user', messageKey: 'u2', uuid: 'u2', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 100, length: 100, type: 'assistant', messageKey: 'tu2', uuid: 'tu2', realUser: false, displayable: false, isMeta: false, toolUseIds: ['toolu_2'], toolResultIds: [] },
        { offset: 200, length: giantBytes, type: 'user', messageKey: 'tr2', uuid: 'tr2', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: ['toolu_2'] },
        { offset: 200 + giantBytes, length: 80, type: 'assistant', messageKey: 'af2', uuid: 'af2', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
      ];
      const turns = [{ turnId: 'u2', startEntry: 0, endEntry: 3, sourceBytes: 180 + giantBytes }];
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns, entries));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptEntries.mockImplementation(async (_index: any, readEntries: any[]) =>
        readEntries.map(entry => ({ type: 'user', uuid: entry.messageKey })));
      mockMaterializeSDKMessages.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      await lease.loadWindow!({ anchorTurn: 1, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      // The summary projection must keep the skipped entry's canonical slot:
      // placeholder between its neighbors, turn marker last — never a
      // tail-appended synthetic block that detaches from the original order.
      const projected = mockMaterializeSDKMessages.mock.calls[0][2] as any[];
      expect(projected.map(message => message.uuid)).toEqual(['u2', 'tu2', 'oversized-tr2', 'af2', 'oversized-marker-u2']);
    });
  });

});
