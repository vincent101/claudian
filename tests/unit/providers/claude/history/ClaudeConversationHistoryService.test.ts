import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import { loadSDKSessionMessages, materializeSDKMessages, sdkSessionExists } from '@/providers/claude/history/ClaudeHistoryStore';
import {
  buildTranscriptIndex,
  materializeTranscriptPage,
  materializeTranscriptToolAssociations,
} from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';

jest.mock('@/providers/claude/history/ClaudeTranscriptHistoryIndex', () => ({
  buildTranscriptIndex: jest.fn().mockResolvedValue({ status: 'complete', index: { entries: [], turns: [] } }),
  clearTranscriptIndexCache: jest.fn(),
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
    expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
    expect(mockBuildTranscriptIndex.mock.calls[0][0]).toContain('current-session.jsonl');
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
      { projectionKey: 'same', turnIndex: 1, timestamp: '', textOffset: 0, textLength: 13 },
      { projectionKey: 'same', turnIndex: 1, timestamp: '', textOffset: 14, textLength: 12 },
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

});
