import type { ChatMessage } from '@/core/types';
import {
  buildOversizedEntryPlaceholder,
  buildOversizedTurnMarker,
  excerptHeadTail,
  measureChatProjectionChars,
  summarizeChatMessages,
} from '@/providers/claude/history/HistorySummaryProjection';

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    ...overrides,
  };
}

describe('HistorySummaryProjection', () => {
  it('keeps short text intact and excerpts long text with head, tail, and omitted count', () => {
    expect(excerptHeadTail('short')).toBe('short');
    const long = `${'a'.repeat(1500)}MIDDLE${'b'.repeat(1500)}`;
    const excerpt = excerptHeadTail(long);
    expect(excerpt).toContain('… 958 characters omitted …');
    expect(excerpt.startsWith('a'.repeat(1024))).toBe(true);
    expect(excerpt.endsWith('b'.repeat(1024))).toBe(true);
    expect(excerpt).not.toContain('MIDDLE');
  });

  it('shrinks text blocks, tool results, tool inputs, and drops thinking and images', () => {
    const message = assistantMessage({
      content: 'x'.repeat(5000),
      images: [{ id: 'i', name: 'n', mediaType: 'image/png', data: 'q'.repeat(1000), size: 750, source: 'paste' }],
      contentBlocks: [
        { type: 'thinking', content: 'secret reasoning', durationSeconds: 1 },
        { type: 'text', content: 'y'.repeat(5000) },
        { type: 'context_compacted' },
      ],
      toolCalls: [{
        id: 't1',
        name: 'Read',
        input: { file_path: '/a.md', content: 'z'.repeat(4000), list: Array.from({ length: 40 }, (_, i) => `item-${i}`) },
        status: 'completed',
        result: 'r'.repeat(4000),
        diffData: { files: [] } as any,
      }],
    });

    summarizeChatMessages([message]);

    expect(message.images).toBeUndefined();
    expect(message.contentBlocks?.some(block => block.type === 'thinking')).toBe(false);
    const textBlock = message.contentBlocks!.find(block => block.type === 'text') as { type: 'text'; content: string };
    expect(textBlock.content.length).toBeLessThan(2500);
    expect(textBlock.content).toContain('characters omitted');
    expect(message.content.length).toBeLessThan(2500);
    const toolCall = message.toolCalls![0];
    expect(toolCall.result!.length).toBeLessThan(300);
    expect((toolCall.input.content as string).length).toBeLessThan(300);
    expect(toolCall.diffData).toBeUndefined();
    expect((toolCall.input.list as unknown[]).length).toBe(33); // 32 items + omission marker
  });

  it('caps subagent results and drops nested subagent tool calls', () => {
    const message = assistantMessage({
      toolCalls: [{
        id: 't1',
        name: 'Task',
        input: {},
        status: 'completed',
        subagent: {
          id: 't1',
          description: 'd',
          prompt: 'p',
          status: 'completed',
          result: 'r'.repeat(4000),
          toolCalls: [{ id: 'n1', name: 'Read', input: {}, status: 'completed' }],
        } as any,
      }],
    });

    summarizeChatMessages([message]);

    expect(message.toolCalls![0].subagent!.result!.length).toBeLessThan(300);
    expect(message.toolCalls![0].subagent!.toolCalls).toEqual([]);
  });

  it('measures string payloads exactly and estimates structured input deterministically', () => {
    const message = assistantMessage({
      content: 'abcde',
      toolCalls: [
        { id: 't1', name: 'Read', input: { file_path: '/a.md' }, status: 'completed', result: '12345678' },
        { id: 't2', name: 'Grep', input: { pattern: 'x', flags: 2 }, status: 'completed' },
      ],
    });
    // 5 content + 8 result + 5 file_path + 1 pattern + 1 number estimated as 64
    expect(measureChatProjectionChars([message])).toBe(5 + 8 + 5 + 1 + 64);
  });

  it('builds a tool-result placeholder that stays system-injected', () => {
    const placeholder = buildOversizedEntryPlaceholder({
      offset: 1,
      length: 10 * 1024 * 1024,
      type: 'user',
      messageKey: 'r1',
      uuid: 'r1',
      parentUuid: 't1',
      realUser: false,
      displayable: false,
      isMeta: false,
      toolUseIds: [],
      toolResultIds: ['toolu_1'],
    });
    expect(placeholder).toMatchObject({
      type: 'user',
      sourceToolUseID: 'toolu_1',
    });
    const blocks = placeholder!.message!.content as Array<{ type: string; tool_use_id: string; content: string }>;
    expect(blocks[0].tool_use_id).toBe('toolu_1');
    expect(blocks[0].content).toContain('10485760 bytes omitted');
  });

  it('returns null for skipped entries without tool results', () => {
    expect(buildOversizedEntryPlaceholder({
      offset: 1,
      length: 100,
      type: 'assistant',
      messageKey: 'a1',
      realUser: false,
      displayable: false,
      isMeta: false,
      toolUseIds: ['toolu_1'],
      toolResultIds: [],
    })).toBeNull();
  });

  it('builds an aggregate turn marker with entry count and byte total', () => {
    const marker = buildOversizedTurnMarker('u1', [
      { offset: 0, length: 300, type: 'user', messageKey: 'x', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
      { offset: 400, length: 100, type: 'user', messageKey: 'y', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
    ], '2026-01-01T00:00:00Z');
    const text = (marker.message!.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('2 transcript entries (400 bytes) omitted');
    expect(marker.timestamp).toBe('2026-01-01T00:00:00Z');
  });
});
