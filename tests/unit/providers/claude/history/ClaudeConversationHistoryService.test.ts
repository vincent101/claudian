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

  it('loads the newest 50 turns and advances an opaque cursor', async () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index }));
    mockBuildTranscriptIndex.mockResolvedValue({
      status: 'complete',
      index: { filePath: '/current', dev: 1, ino: 1, snapshotSize: 999, mtimeMs: 1, entries: [], turns, searchCorpus: [], skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 },
    });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    mockMaterializeTranscriptPage.mockResolvedValue([]);
    mockMaterializeTranscriptToolAssociations.mockResolvedValue([]);
    mockMaterializeSDKMessages.mockResolvedValue([]);
    const service = new ClaudeConversationHistoryService();

    const first = await service.loadInitialHistory(createConversation(), '/vault', 50);
    expect(mockMaterializeTranscriptPage).toHaveBeenCalledWith(expect.anything(), 70, 50);
    expect(first).toMatchObject({ hasMore: true, snapshotOffset: 999 });
    expect(first.cursor).toMatch(/^claude-history:/);

    await service.loadOlderHistory(first.cursor!, 50);
    expect(mockMaterializeTranscriptPage).toHaveBeenLastCalledWith(expect.anything(), 20, 50);
  });

  it('searches case-insensitive substrings and returns snippets with page cursors', async () => {
    const searchCorpus = [
      { messageKey: 'u1', turnIndex: 0, timestamp: '2026-01-01T00:00:00Z', text: 'Alpha NEEDLE omega' },
      { messageKey: 'a1', turnIndex: 1, timestamp: '2026-01-02T00:00:00Z', text: 'another needle result' },
    ];
    mockBuildTranscriptIndex.mockResolvedValue({
      status: 'complete',
      index: { filePath: '/current', dev: 1, ino: 1, snapshotSize: 999, mtimeMs: 1, entries: [], turns: [{ turnId: 'u1', startEntry: 0, endEntry: 0 }, { turnId: 'u2', startEntry: 1, endEntry: 1 }], searchCorpus, skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 },
    });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    mockMaterializeTranscriptPage.mockResolvedValue([]);
    mockMaterializeTranscriptToolAssociations.mockResolvedValue([]);
    mockMaterializeSDKMessages.mockResolvedValue([]);
    const service = new ClaudeConversationHistoryService();
    await service.loadInitialHistory(createConversation(), '/vault', 50);

    await expect(service.searchHistory!(createConversation(), '/vault', 'needle')).resolves.toEqual([
      expect.objectContaining({ messageKey: 'u1', cursor: expect.stringMatching(/^claude-search:/), matchLength: 6 }),
      expect.objectContaining({ messageKey: 'a1', cursor: expect.stringMatching(/^claude-search:/), matchLength: 6 }),
    ]);
    await expect(service.searchHistory!(createConversation(), '/vault', 'missing')).resolves.toEqual([]);
  });

  it('restores a cursor whose page failed to materialize so retry succeeds', async () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index }));
    mockBuildTranscriptIndex.mockResolvedValue({
      status: 'complete',
      index: { filePath: '/current', dev: 1, ino: 1, snapshotSize: 999, mtimeMs: 1, entries: [], turns, searchCorpus: [], skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 },
    });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    mockMaterializeTranscriptPage.mockResolvedValue([]);
    mockMaterializeTranscriptToolAssociations.mockResolvedValue([]);
    mockMaterializeSDKMessages.mockResolvedValue([]);
    const service = new ClaudeConversationHistoryService();

    const first = await service.loadInitialHistory(createConversation(), '/vault', 50);
    mockMaterializeTranscriptPage.mockRejectedValueOnce(new Error('transient read failure'));

    await expect(service.loadOlderHistory(first.cursor!, 50)).rejects.toThrow('transient read failure');

    const older = await service.loadOlderHistory(first.cursor!, 50);
    expect(mockMaterializeTranscriptPage).toHaveBeenLastCalledWith(expect.anything(), 20, 50);
    expect(older).toMatchObject({ hasMore: true });
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
