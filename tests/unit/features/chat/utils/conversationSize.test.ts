import type { UsageInfo } from '@/core/types';
import { formatConversationSize, formatConversationSizeTooltip, formatFileBytes } from '@/features/chat/utils/conversationSize';

function createUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: 40_000,
    contextWindow: 200_000,
    contextTokens: 45_230,
    percentage: 23,
    ...overrides,
  };
}

describe('provider-backed size snapshots', () => {
  it('formats file bytes separately from the complete active-branch turn count', () => {
    expect(formatConversationSize({
      sizeSnapshot: {
        conversationId: 'one', revision: 1,
        files: { status: 'known', bytes: 13_002_342, },
      },
    } as never)).toBe('Current session file 12.4 MiB');
  });

  it('distinguishes zero-byte files and missing files from an unknown history', () => {
    expect(formatConversationSize({
      sizeSnapshot: {
        conversationId: 'empty', revision: 1,
        files: { status: 'known', bytes: 0, },
      },
    } as never)).toBe('Current session file 0 B');
    expect(formatConversationSize({
      sizeSnapshot: {
        conversationId: 'missing', revision: 1,
        files: { status: 'unknown', reason: 'unavailable' },
      },
    } as never)).toBe('Current session file unknown');
  });

  it('never upgrades an old messageCount or context usage into complete history', () => {
    expect(formatConversationSize({
      messageCount: 0,
      usage: createUsage(),
      sizeSnapshot: {
        conversationId: 'cold', revision: 0,
        files: { status: 'unknown', reason: 'unavailable' },
      },
    } as never)).toBe('Current session file unknown');
  });
});

describe('conversationSize', () => {
  describe('formatFileBytes', () => {
    it('keeps sub-KiB sizes in bytes', () => {
      expect(formatFileBytes(0)).toBe('0 B');
      expect(formatFileBytes(1023)).toBe('1023 B');
    });

    it('abbreviates binary multiples with one decimal', () => {
      expect(formatFileBytes(1024)).toBe('1.0 KiB');
      expect(formatFileBytes(13_002_342)).toBe('12.4 MiB');
    });
  });

  describe('formatConversationSize', () => {
    it('formats file bytes separately from the complete active-branch turn count', () => {
      expect(formatConversationSize({
        sizeSnapshot: {
          conversationId: 'one', revision: 1,
          files: { status: 'known', bytes: 13_002_342, },
        },
      })).toBe('Current session file 12.4 MiB');
    });

    it('renders message units and thousands separators', () => {
      expect(formatConversationSize({
        sizeSnapshot: {
          conversationId: 'one', revision: 1,
          files: { status: 'known', bytes: 2048, },
        },
      })).toBe('Current session file 2.0 KiB');
    });

    it('distinguishes zero-byte files and missing files from an unknown history', () => {
      expect(formatConversationSize({
        sizeSnapshot: {
          conversationId: 'empty', revision: 1,
          files: { status: 'known', bytes: 0, },
        },
      })).toBe('Current session file 0 B');
      expect(formatConversationSize({
        sizeSnapshot: {
          conversationId: 'missing', revision: 1,
          files: { status: 'unknown', reason: 'unavailable' },
        },
      })).toBe('Current session file unknown');
      expect(formatConversationSize({
        sizeSnapshot: {
          conversationId: 'incomplete', revision: 1,
          files: { status: 'unknown', reason: 'unavailable' },
        },
      })).toBe('Current session file unknown');
    });

    it('never upgrades an old messageCount or context usage into complete history', () => {
      expect(formatConversationSize({
        messageCount: 0,
        usage: createUsage(),
        sizeSnapshot: {
          conversationId: 'cold', revision: 0,
          files: { status: 'unknown', reason: 'unavailable' },
        },
      } as never)).toBe('Current session file unknown');
    });
  });

  describe('formatConversationSizeTooltip', () => {
    it('appends the shared-sources caveat and fork source notice', () => {
      const snapshot = {
        conversationId: 'one', revision: 1,
        files: { status: 'known' as const, bytes: 2048, },
      };
      expect(formatConversationSizeTooltip({ sizeSnapshot: snapshot })).toBe(
        "Current session file 2.0 KiB · Disk size of the current session's native log file only; excludes parent sessions, fork sources, and metadata.",
      );
    });
  });
});
