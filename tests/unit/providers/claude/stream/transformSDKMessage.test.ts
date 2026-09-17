import { buildSDKMessage } from '@test/helpers/sdkMessages';

import type { UsageInfo } from '@/core/types/chat';
import {
  createTransformStreamState,
  createTransformUsageState,
  transformSDKMessage,
} from '@/providers/claude/stream/transformClaudeMessage';

const msg = buildSDKMessage;

describe('transformSDKMessage', () => {
  describe('system messages', () => {
    it('yields session_init event for init subtype with session_id', () => {
      const message = msg({
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-123',
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'session_init',
          sessionId: 'test-session-123',
          model: 'claude-sonnet-4-5',
          agents: undefined,
          permissionMode: 'default',
        },
      ]);
    });

    it('yields nothing for system messages without init subtype', () => {
      const message = msg({
        type: 'system',
        subtype: 'status',
        session_id: 'test-session',
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields context_compacted event for compact_boundary subtype', () => {
      const message = msg({
        type: 'system',
        subtype: 'compact_boundary',
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'context_compacted' },
      ]);
    });

    it('captures agents from init message', () => {
      const message = msg({
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-456',
        agents: ['Explore', 'Plan', 'custom-agent'],
        skills: ['commit', 'review-pr'],
        slash_commands: ['clear', 'add-dir'],
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'session_init',
        sessionId: 'test-session-456',
        model: 'claude-sonnet-4-5',
        agents: ['Explore', 'Plan', 'custom-agent'],
        permissionMode: 'default',
      });
    });

    it('captures permissionMode from init message', () => {
      const message = msg({
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-789',
        permissionMode: 'plan',
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'session_init',
        sessionId: 'test-session-789',
        model: 'claude-sonnet-4-5',
        permissionMode: 'plan',
      });
    });
  });

  describe('assistant messages', () => {
    it('yields text content block', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello, world!' },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: 'Hello, world!' },
      ]);
    });

    it('yields thinking content block', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'thinking', content: 'Let me think about this...' },
      ]);
    });

    it('yields tool_use content block with all fields', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-123',
              name: 'Read',
              input: { file_path: '/test/file.ts' },
            },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_use',
          id: 'tool-123',
          name: 'Read',
          input: { file_path: '/test/file.ts' },
        },
      ]);
    });

    it('generates fallback id for tool_use without id', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash' },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('tool_use');
      expect((results[0] as any).id).toMatch(/^tool-\d+-\w+$/);
      expect((results[0] as any).name).toBe('Bash');
      expect((results[0] as any).input).toEqual({});
    });

    it('handles multiple content blocks', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Thinking...' },
            { type: 'text', text: 'Here is my response' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ type: 'thinking', content: 'Thinking...' });
      expect(results[1]).toEqual({ type: 'text', content: 'Here is my response' });
      expect(results[2]).toMatchObject({ type: 'tool_use', id: 'tool-1', name: 'Read' });
    });

    it('yields subagent_tool_use for assistant tool_use in subagent context', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: 'parent-tool-abc',
        message: {
          content: [
            { type: 'tool_use', id: 'child-tool-1', name: 'Read', input: { file_path: 'subagent.md' } },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'subagent_tool_use',
          subagentId: 'parent-tool-abc',
          id: 'child-tool-1',
          name: 'Read',
          input: { file_path: 'subagent.md' },
        },
      ]);
    });

    it('handles empty content array', () => {
      const message = msg({
        type: 'assistant',
        message: { content: [] },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('handles missing message.content', () => {
      const message = msg({
        type: 'assistant',
        message: {},
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('skips empty text blocks', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'Valid text' },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: 'Valid text' },
      ]);
    });

    it('skips "(no content)" placeholder text blocks', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '(no content)' },
            { type: 'tool_use', id: 'tool-1', name: 'Skill', input: { skill: 'md2docx' } },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'tool_use', id: 'tool-1', name: 'Skill', input: { skill: 'md2docx' } },
      ]);
    });

    it('skips empty thinking blocks', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'thinking', thinking: 'Valid thinking' },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'thinking', content: 'Valid thinking' },
      ]);
    });

    it('yields error event for assistant message with error field', () => {
      const message = msg({
        type: 'assistant',
        error: 'rate_limit',
        message: {
          content: [
            { type: 'text', text: 'Partial response' },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'error', content: 'rate_limit' },
        { type: 'text', content: 'Partial response' },
      ]);
    });
  });

  describe('user messages', () => {
    it('yields warning notice for blocked tool calls', () => {
      const message = msg({
        type: 'user',
        _blocked: true,
        _blockReason: 'Command blocked: rm -rf /',
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'notice', content: 'Command blocked: rm -rf /', level: 'warning' },
      ]);
    });

    it('yields tool_result for tool_use_result with parent_tool_use_id', () => {
      const message = msg({
        type: 'user',
        parent_tool_use_id: 'tool-123',
        tool_use_result: 'File contents here',
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'subagent_tool_result',
          subagentId: 'tool-123',
          id: 'tool-123',
          content: 'File contents here',
          isError: false,
          toolUseResult: 'File contents here',
        },
      ]);
    });

    it('stringifies non-string tool_use_result', () => {
      const message = msg({
        type: 'user',
        parent_tool_use_id: 'tool-123',
        tool_use_result: { status: 'success', data: [1, 2, 3] },
      });

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('subagent_tool_result');
      expect((results[0] as any).content).toContain('"status": "success"');
    });

    it('extracts text from array-based tool_use_result content', () => {
      const toolUseResult = [
        { type: 'text', text: 'Agent completed successfully.' },
        { type: 'text', text: 'Saved summary to notes.md' },
      ];
      const message = msg({
        type: 'user',
        parent_tool_use_id: 'tool-123',
        tool_use_result: toolUseResult,
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'subagent_tool_result',
          subagentId: 'tool-123',
          id: 'tool-123',
          content: 'Agent completed successfully.\nSaved summary to notes.md',
          isError: false,
          toolUseResult,
        },
      ]);
    });

    it('yields tool_result from message.content blocks', () => {
      const message = msg({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-456',
              content: 'Result content',
              is_error: false,
            },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-456',
          content: 'Result content',
          isError: false,
        },
      ]);
    });

    it('handles tool_result with is_error flag', () => {
      const message = msg({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-error',
              content: 'Error: File not found',
              is_error: true,
            },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-error',
          content: 'Error: File not found',
          isError: true,
        },
      ]);
    });

    it('extracts text from array content in tool_result blocks', () => {
      const message = msg({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-agent',
              content: [
                { type: 'text', text: 'Agent completed successfully.' },
                { type: 'text', text: 'Next step queued.' },
              ],
            },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-agent',
          content: 'Agent completed successfully.\nNext step queued.',
          isError: false,
        },
      ]);
    });

    it('stringifies non-string object content in tool_result blocks', () => {
      const message = msg({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-obj',
              content: { key: 'value' },
            },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect((results[0] as any).content).toContain('"key": "value"');
    });

    it('preserves tool_reference array content in tool_result blocks', () => {
      const toolRefs = [
        { type: 'tool_reference', tool_name: 'WebSearch' },
        { type: 'tool_reference', tool_name: 'Grep' },
      ];
      const message = msg({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-search-1',
              content: toolRefs,
            },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect((results[0] as any).content).toBe(JSON.stringify(toolRefs, null, 2));
    });

    it('uses parent_tool_use_id as fallback for tool_result id', () => {
      const message = msg({
        type: 'user',
        parent_tool_use_id: 'fallback-id',
        message: {
          content: [
            { type: 'tool_result', content: 'Some result' },
          ],
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect((results[0] as any).id).toBe('fallback-id');
    });

    it('yields nothing for user messages without tool results', () => {
      const message = msg({
        type: 'user',
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });
  });

  describe('stream_event messages', () => {
    it('yields tool_use for content_block_start with tool_use', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'stream-tool-1',
            name: 'Write',
            input: { file_path: '/test.ts' },
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: { file_path: '/test.ts' },
        },
      ]);
    });

    it('generates fallback id for content_block_start without id', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            name: 'Glob',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect((results[0] as any).id).toMatch(/^tool-\d+$/);
    });

    it('yields cumulative tool_use updates for input_json_delta', () => {
      const streamState = createTransformStreamState();
      const startMessage = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'stream-tool-1',
            name: 'Write',
            input: {},
          },
        },
      });
      const firstDeltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"file_path":"notes.md"',
          },
        },
      });
      const secondDeltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: ',"content":"Hello"',
          },
        },
      });

      expect([...transformSDKMessage(startMessage, { streamState })]).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: {},
        },
      ]);
      expect([...transformSDKMessage(firstDeltaMessage, { streamState })]).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: { file_path: 'notes.md' },
        },
      ]);
      expect([...transformSDKMessage(secondDeltaMessage, { streamState })]).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: { file_path: 'notes.md', content: 'Hello' },
        },
      ]);
    });

    it('yields thinking for content_block_start with thinking', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'thinking',
            thinking: 'Initial thinking...',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'thinking', content: 'Initial thinking...' },
      ]);
    });

    it('yields text for content_block_start with text', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'text',
            text: 'Starting response...',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: 'Starting response...' },
      ]);
    });

    it('yields thinking for thinking_delta', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'thinking_delta',
            thinking: 'More thinking...',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'thinking', content: 'More thinking...' },
      ]);
    });

    it('yields text for text_delta', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: ' additional text',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: ' additional text' },
      ]);
    });

    it('yields nothing for empty thinking in content_block_start', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields nothing for empty text in content_block_start', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'text',
            text: '',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields nothing for empty thinking_delta', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'thinking_delta',
            thinking: '',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields nothing for empty text_delta', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: '',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('suppresses subagent text deltas in stream events', () => {
      const message = msg({
        type: 'stream_event',
        parent_tool_use_id: 'subagent-parent',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: 'Subagent stream text',
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('handles missing event property', () => {
      const message = msg({
        type: 'stream_event',
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields usage when Anthropic-compatible message_delta carries prompt tokens', () => {
      const usageState = createTransformUsageState();
      const startMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        },
      });
      const deltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            input_tokens: 16,
            output_tokens: 6,
            cache_read_input_tokens: 0,
          },
        },
      });

      expect([...transformSDKMessage(startMessage, {
        intendedModel: 'glm-5.1',
        usageState,
      })]).toEqual([]);

      const results = [...transformSDKMessage(deltaMessage, {
        intendedModel: 'glm-5.1',
        usageState,
      })];

      expect(results).toEqual([
        {
          type: 'usage',
          usage: {
            model: 'glm-5.1',
            inputTokens: 16,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 200000,
            contextTokens: 16,
            percentage: 0,
          },
        },
      ]);
    });

    it('keeps standard message_start prompt usage on the final assistant usage path', () => {
      const usageState = createTransformUsageState();
      const startMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      });
      const deltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            input_tokens: 10,
            output_tokens: 4,
          },
        },
      });
      const assistantMessage = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      const startResults = [...transformSDKMessage(startMessage, {
        intendedModel: 'sonnet',
        usageState,
      })];
      const deltaResults = [...transformSDKMessage(deltaMessage, {
        intendedModel: 'sonnet',
        usageState,
      })];
      const assistantResults = [...transformSDKMessage(assistantMessage, {
        intendedModel: 'sonnet',
        usageState,
      })];

      expect(startResults).toEqual([]);
      expect(deltaResults).toEqual([]);
      expect(assistantResults).toEqual([
        { type: 'text', content: 'Hello' },
        {
          type: 'usage',
          usage: {
            model: 'sonnet',
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 200000,
            contextTokens: 10,
            percentage: 0,
          },
        },
      ]);
    });

    it('emits message_start prompt usage at result when no assistant usage arrives', () => {
      const usageState = createTransformUsageState();
      const startMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      });
      const deltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: 4,
          },
        },
      });
      const resultMessage = msg({
        type: 'result',
        subtype: 'success',
        modelUsage: undefined,
      });

      expect([...transformSDKMessage(startMessage, {
        intendedModel: 'sonnet',
        usageState,
      })]).toEqual([]);
      expect([...transformSDKMessage(deltaMessage, {
        intendedModel: 'sonnet',
        usageState,
      })]).toEqual([]);

      expect([...transformSDKMessage(resultMessage, {
        intendedModel: 'sonnet',
        usageState,
      })]).toEqual([
        {
          type: 'usage',
          usage: {
            model: 'sonnet',
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 200000,
            contextTokens: 10,
            percentage: 0,
          },
        },
      ]);
    });

    it('ignores standard message_delta usage that only contains output tokens', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: 6,
          },
        },
      });

      const results = [...transformSDKMessage(message, { usageState })];

      expect(results).toEqual([]);
    });

    it('ignores subagent stream usage deltas', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'stream_event',
        parent_tool_use_id: 'subagent-parent',
        event: {
          type: 'message_delta',
          usage: {
            input_tokens: 16,
            output_tokens: 6,
          },
        },
      });

      const results = [...transformSDKMessage(message, { usageState })];

      expect(results).toEqual([]);
    });

    it('ignores subagent message_start usage', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'stream_event',
        parent_tool_use_id: 'subagent-parent',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 16,
              output_tokens: 0,
            },
          },
        },
      });

      const results = [...transformSDKMessage(message, { usageState })];

      expect(results).toEqual([]);
      expect([...transformSDKMessage(msg({
        type: 'result',
        subtype: 'success',
        modelUsage: undefined,
      }), { usageState })]).toEqual([]);
    });
  });

  describe('result messages', () => {
    it('emits no context_window for result messages: modelUsage no longer denominates (2.3.2 ②)', () => {
      // User ruling 2026-09-17: the denominator follows the model selector's
      // preset configuration only. The SDK-reported contextWindow (200k here
      // while the preset configures 1M) must never override it.
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-sonnet[1m]': {
            inputTokens: 1000,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 200,
            outputTokens: 300,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields error for failed result messages without a context_window', () => {
      const message = msg({
        type: 'result',
        subtype: 'error_max_turns',
        errors: ['Hit maximum turn limit'],
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'error', content: 'Hit maximum turn limit' },
      ]);
    });

    it('keeps the configured preset window as the settled denominator when the result reports a smaller one', () => {
      // 2.3.2 ② acceptance: a result carrying a 200k window over a
      // sonnet[1m] turn configured for 1M must leave the denominator at 1M —
      // stream phase and post-result stay on the same single source.
      const usageState = createTransformUsageState();
      const options = {
        intendedModel: 'sonnet[1m]',
        customContextLimits: { 'sonnet': 1_000_000 },
        usageState,
      };

      const chunks = [
        ...transformSDKMessage(msg({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'text', text: 'Hello' }],
            usage: { input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }), options),
        ...transformSDKMessage(msg({
          type: 'result',
          subtype: 'success',
          modelUsage: {
            'claude-sonnet[1m]': { contextWindow: 200_000 },
          },
        }), options),
      ];
      const usageChunks = chunks.filter((chunk): chunk is Extract<typeof chunk, { type: 'usage' }> => chunk.type === 'usage');

      expect(usageChunks.length).toBeGreaterThan(0);
      for (const chunk of usageChunks) {
        expect(chunk.usage.contextWindow).toBe(1_000_000);
      }
    });

    describe('fable stream-phase denominator (2.3.2 ②: result modelUsage no longer denominates)', () => {
      it('falls back to the standard window as the stream-phase denominator for unconfigured fable', () => {
        // Preset-only resolution (2026-09-16); result windows stopped
        // denominating entirely (2.3.2 ②, 2026-09-17): an unconfigured fable
        // keeps the conservative 200k denominator stream-phase and settled,
        // until a preset window is projected (covered below).
        const usageState = createTransformUsageState();
        const message = msg({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'text', text: 'Hello' }],
            usage: {
              input_tokens: 1000,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        });

        const results = [...transformSDKMessage(message, { intendedModel: 'fable', usageState })];
        const usage = (results.find(r => r.type === 'usage') as { usage: { contextWindow: number } }).usage;

        expect(usage.contextWindow).toBe(200000);
      });

      it('prefers a preset context window projected into customContextLimits', () => {
        const usageState = createTransformUsageState();
        const message = msg({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'text', text: 'Hello' }],
            usage: {
              input_tokens: 1000,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        });

        const results = [...transformSDKMessage(message, {
          intendedModel: 'fable',
          customContextLimits: { 'fable': 500_000 },
          usageState,
        })];
        const usage = (results.find(r => r.type === 'usage') as { usage: { contextWindow: number } }).usage;

        expect(usage.contextWindow).toBe(500000);
      });
    });
  });

  describe('assistant message usage extraction', () => {
    it('yields usage info from main agent assistant message', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null, // Main agent
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 200,
          },
        },
      });

      const results = [...transformSDKMessage(message, { intendedModel: 'sonnet' })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.inputTokens).toBe(1000);
      expect(usage.cacheCreationInputTokens).toBe(300);
      expect(usage.cacheReadInputTokens).toBe(200);
      expect(usage.contextTokens).toBe(1500); // 1000 + 300 + 200
      expect(usage.contextWindow).toBe(200000); // Standard context window
      expect(usage.percentage).toBe(1); // 1500 / 200000 * 100 rounded
    });

    it('yields usage from assistant message when usage state has no stream prompt usage', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 200,
          },
        },
      });

      const results = [...transformSDKMessage(message, {
        intendedModel: 'sonnet',
        usageState,
      })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);
      expect((usageResults[0] as any).usage).toEqual({
        model: 'sonnet',
        inputTokens: 1000,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 200,
        contextWindow: 200000,
        contextTokens: 1500,
        percentage: 1,
      });
    });

    it('skips usage extraction for subagent messages', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: 'subagent-task-123', // Subagent
        message: {
          content: [{ type: 'text', text: 'Subagent response' }],
          usage: {
            input_tokens: 5000,
            output_tokens: 1000,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 100,
          },
        },
      });

      const results = [...transformSDKMessage(message)];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(0);
    });

    it('uses custom context limits when provided', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 50000,
            output_tokens: 10000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      const results = [...transformSDKMessage(message, {
        intendedModel: 'custom-model',
        customContextLimits: { 'custom-model': 500000 },
      })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.contextWindow).toBe(500000); // Custom context limit
      expect(usage.percentage).toBe(10); // 50000 / 500000 * 100 = 10%
    });

    it('uses custom context limits over standard window', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 100000,
            output_tokens: 10000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      const results = [...transformSDKMessage(message, {
        intendedModel: 'sonnet',
        customContextLimits: { 'sonnet': 256000 },
      })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.contextWindow).toBe(256000); // Custom limit takes precedence
      expect(usage.percentage).toBe(39); // 100000 / 256000 * 100 ≈ 39%
    });

    it('handles missing usage field gracefully', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      });

      const results = [...transformSDKMessage(message)];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(0);
    });

    it('handles missing token fields with defaults', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {}, // Empty usage object
        },
      });

      const results = [...transformSDKMessage(message, { intendedModel: 'sonnet' })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.inputTokens).toBe(0);
      expect(usage.cacheCreationInputTokens).toBe(0);
      expect(usage.cacheReadInputTokens).toBe(0);
      expect(usage.contextTokens).toBe(0);
    });

    it('emits final zero usage with usage state when no stream prompt usage exists', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 0,
            output_tokens: 6,
          },
        },
      });

      const results = [...transformSDKMessage(message, {
        intendedModel: 'sonnet',
        usageState,
      })];

      expect(results).toEqual([
        { type: 'text', content: 'Hello' },
        {
          type: 'usage',
          usage: {
            model: 'sonnet',
            inputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 200000,
            contextTokens: 0,
            percentage: 0,
          },
        },
      ]);
    });

    it('does not let final zero assistant usage overwrite positive stream usage', () => {
      const usageState = createTransformUsageState();
      const deltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: {
            input_tokens: 16,
            output_tokens: 6,
          },
        },
      });
      const assistantMessage = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 0,
            output_tokens: 6,
          },
        },
      });

      const streamResults = [...transformSDKMessage(deltaMessage, {
        intendedModel: 'glm-5.1',
        usageState,
      })];
      const assistantResults = [...transformSDKMessage(assistantMessage, {
        intendedModel: 'glm-5.1',
        usageState,
      })];

      expect(streamResults.filter(r => r.type === 'usage')).toHaveLength(1);
      expect(assistantResults).toEqual([
        { type: 'text', content: 'Hello' },
      ]);
    });
  });

  describe('error messages', () => {
    it('yields error event from assistant message with error field', () => {
      const message = msg({
        type: 'assistant',
        error: 'unknown',
        message: { content: [] },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'error', content: 'unknown' },
      ]);
    });

    it('yields nothing for assistant message without error field', () => {
      const message = msg({
        type: 'assistant',
        message: { content: [] },
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });
  });

  describe('request-boundary usage snapshots (A0b)', () => {
    const MISS_REQUEST = {
      input_tokens: 496652,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 22272,
    };
    const HIT_REQUEST = {
      input_tokens: 598,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 518912,
    };
    const MISS_CONTEXT = 496652 + 5000 + 22272;
    const HIT_CONTEXT = 598 + 100 + 518912;

    const assistantUsage = (messageId: string, usage: Record<string, number>, parentToolUseId: string | null = null) => msg({
      type: 'assistant',
      parent_tool_use_id: parentToolUseId,
      message: { id: messageId, content: [{ type: 'text', text: 'chunk' }], usage },
    });

    const messageStart = (messageId: string, usage: Record<string, number>) => msg({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: messageId, usage } },
    });

    const collectUsage = (
      messages: Parameters<typeof transformSDKMessage>[0][],
      options?: Parameters<typeof transformSDKMessage>[1],
    ) => {
      const chunks: UsageInfo[] = [];
      for (const message of messages) {
        for (const event of transformSDKMessage(message, options)) {
          if (event.type === 'usage') chunks.push(event.usage);
        }
      }
      return chunks;
    };

    it('replaces the snapshot at each request boundary (miss -> hit)', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_miss', MISS_REQUEST),
        assistantUsage('msg_hit', HIT_REQUEST),
        msg({ type: 'result' }),
      ], options);

      const last = chunks[chunks.length - 1];
      expect(last.inputTokens).toBe(598);
      expect(last.cacheReadInputTokens).toBe(518912);
      expect(last.contextTokens).toBe(HIT_CONTEXT);
      expect(last.contextTokens).not.toBe(496652 + 518912);
    });

    it('replaces the snapshot at each request boundary (hit -> miss)', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_hit', HIT_REQUEST),
        assistantUsage('msg_miss', MISS_REQUEST),
        msg({ type: 'result' }),
      ], options);

      const last = chunks[chunks.length - 1];
      expect(last.inputTokens).toBe(496652);
      expect(last.cacheReadInputTokens).toBe(22272);
      expect(last.contextTokens).toBe(MISS_CONTEXT);
    });

    it('merges same-request assistant segments by monotonic max', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_a', { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
        assistantUsage('msg_a', { input_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 60 }),
        msg({ type: 'result' }),
      ], options);

      const last = chunks[chunks.length - 1];
      expect(last.inputTokens).toBe(100);
      expect(last.cacheCreationInputTokens).toBe(40);
      expect(last.cacheReadInputTokens).toBe(60);
      expect(last.contextTokens).toBe(200);
    });

    it('does not let an all-zero fragment clobber an established snapshot, and later non-zero data of the new request replaces it', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_miss', MISS_REQUEST),
        assistantUsage('msg_hit', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
        assistantUsage('msg_hit', HIT_REQUEST),
        msg({ type: 'result' }),
      ], options);

      const last = chunks[chunks.length - 1];
      expect(last.contextTokens).toBe(HIT_CONTEXT);
      expect(last.inputTokens).toBe(598);
    });

    it('keeps the last non-empty snapshot when a new request only ever reports all-zero usage', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_miss', MISS_REQUEST),
        assistantUsage('msg_hit', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
        msg({ type: 'result' }),
      ], options);

      const last = chunks[chunks.length - 1];
      expect(last.contextTokens).toBe(MISS_CONTEXT);
    });

    it('filters subagent assistant and stream_event usage out of the main-agent state machine', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_miss', MISS_REQUEST),
        assistantUsage('msg_sub', { input_tokens: 900000, cache_creation_input_tokens: 0, cache_read_input_tokens: 900000 }, 'task-1'),
        msg({ type: 'stream_event', parent_tool_use_id: 'task-1', event: { type: 'message_start', message: { id: 'msg_sub_start', usage: { input_tokens: 800000, cache_read_input_tokens: 800000 } } } }),
        assistantUsage('msg_hit', HIT_REQUEST),
        msg({ type: 'result' }),
      ], options);

      const last = chunks[chunks.length - 1];
      expect(last.contextTokens).toBe(HIT_CONTEXT);
    });

    it('isolates usage across turns when a result is missing', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_miss', MISS_REQUEST),
        assistantUsage('msg_hit', HIT_REQUEST),
        msg({ type: 'result' }),
      ], options);

      expect(chunks[chunks.length - 1].contextTokens).toBe(HIT_CONTEXT);
    });

    it('starts a fresh snapshot after a result even when the next turn reuses stale boundaries', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_miss', MISS_REQUEST),
        msg({ type: 'result' }),
        assistantUsage('msg_hit', HIT_REQUEST),
        msg({ type: 'result' }),
      ], options);

      const last = chunks[chunks.length - 1];
      expect(last.contextTokens).toBe(HIT_CONTEXT);
    });

    it('treats stream_event message_start as the request boundary on the streaming path', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        messageStart('msg_miss', MISS_REQUEST),
        assistantUsage('msg_miss', MISS_REQUEST),
        messageStart('msg_hit', HIT_REQUEST),
        assistantUsage('msg_hit', HIT_REQUEST),
        msg({ type: 'result' }),
      ], options);

      const last = chunks[chunks.length - 1];
      expect(last.contextTokens).toBe(HIT_CONTEXT);
      expect(last.inputTokens).toBe(598);
    });

    it('reports the SDK-resolved model on usage chunks instead of the intended alias', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet', usageState };

      const chunks = collectUsage([
        msg({ type: 'system', subtype: 'init', session_id: 'test-session', model: 'claude-sonnet-4-5-20260929' }),
        assistantUsage('msg_miss', MISS_REQUEST),
      ], options);

      expect(chunks[chunks.length - 1].model).toBe('claude-sonnet-4-5-20260929');
    });

    it('falls back to the intended model when no resolved model was captured', () => {
      const usageState = createTransformUsageState();
      const options = { intendedModel: 'sonnet[1m]', usageState };

      const chunks = collectUsage([
        assistantUsage('msg_miss', MISS_REQUEST),
      ], options);

      expect(chunks[chunks.length - 1].model).toBe('sonnet[1m]');
    });
  });

  describe('unhandled message types', () => {
    it('yields nothing for tool_progress messages', () => {
      const message = msg({
        type: 'tool_progress',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        elapsed_time_seconds: 5,
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields nothing for auth_status messages', () => {
      const message = msg({
        type: 'auth_status',
        isAuthenticating: true,
        output: [],
      });

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });
  });
});
