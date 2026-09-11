import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import { loadSDKSessionMessages, sdkSessionExists } from '@/providers/claude/history/ClaudeHistoryStore';

jest.mock('@/providers/claude/history/ClaudeHistoryStore', () => ({
  loadSDKSessionMessages: jest.fn(),
  loadSubagentToolCalls: jest.fn().mockResolvedValue([]),
  sdkSessionExists: jest.fn().mockReturnValue(true),
  deleteSDKSession: jest.fn().mockResolvedValue(undefined),
}));

const mockLoadSDKSessionMessages = loadSDKSessionMessages as jest.MockedFunction<typeof loadSDKSessionMessages>;
const mockSdkSessionExists = sdkSessionExists as jest.MockedFunction<typeof sdkSessionExists>;

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
