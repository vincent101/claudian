import {
  clampToolResultForProjection,
  setClampedToolCallResult,
  TOOL_RESULT_PROJECTION_CHARS,
} from '@/core/tools/toolResultProjection';
import type { ToolCallInfo } from '@/core/types';

const buildToolCall = (result?: string): ToolCallInfo => ({
  id: 'tool-1',
  name: 'Read',
  input: {},
  status: 'running',
  result,
});

describe('toolResultProjection', () => {
  describe('clampToolResultForProjection', () => {
    it('returns text unchanged when within the threshold', () => {
      const text = 'a'.repeat(TOOL_RESULT_PROJECTION_CHARS);
      expect(clampToolResultForProjection(text)).toEqual({
        text,
        truncated: false,
        originalChars: TOOL_RESULT_PROJECTION_CHARS,
      });
    });

    it('returns short text unchanged', () => {
      expect(clampToolResultForProjection('ok')).toEqual({
        text: 'ok',
        truncated: false,
        originalChars: 2,
      });
    });

    it('clamps oversized text to prefix + marker with originalChars', () => {
      const originalChars = TOOL_RESULT_PROJECTION_CHARS + 1234;
      const text = 'x'.repeat(originalChars);
      const clamped = clampToolResultForProjection(text);

      expect(clamped.truncated).toBe(true);
      expect(clamped.originalChars).toBe(originalChars);
      expect(clamped.text.length).toBe(
        TOOL_RESULT_PROJECTION_CHARS + `\n…[已截断：原文 ${originalChars} 字符]`.length
      );
      expect(clamped.text.startsWith('x'.repeat(TOOL_RESULT_PROJECTION_CHARS))).toBe(true);
      expect(clamped.text.endsWith(`\n…[已截断：原文 ${originalChars} 字符]`)).toBe(true);
    });

    it('handles empty string and undefined inputs', () => {
      expect(clampToolResultForProjection('')).toEqual({
        text: '',
        truncated: false,
        originalChars: 0,
      });
      expect(clampToolResultForProjection(undefined as unknown as string)).toEqual({
        text: '',
        truncated: false,
        originalChars: 0,
      });
    });

    it('is idempotent for already-clamped values (marker-aware)', () => {
      // Write points 6+7 compose on the same string: extractAgentResult
      // clamps, then the StreamController write point clamps again. The
      // helper must keep the value and the original count exact.
      const originalChars = TOOL_RESULT_PROJECTION_CHARS * 4;
      const first = clampToolResultForProjection('y'.repeat(originalChars));
      const second = clampToolResultForProjection(first.text);

      expect(second).toEqual({ ...first, truncated: true, originalChars });
    });
  });

  describe('setClampedToolCallResult', () => {
    it('sets result and resultTruncated metadata for oversized text', () => {
      const toolCall = buildToolCall();
      const originalChars = TOOL_RESULT_PROJECTION_CHARS + 10;

      setClampedToolCallResult(toolCall, 'z'.repeat(originalChars));

      expect(toolCall.result?.length).toBeLessThanOrEqual(
        TOOL_RESULT_PROJECTION_CHARS + 64
      );
      expect(toolCall.resultTruncated).toEqual({ originalChars });
    });

    it('leaves small results without metadata and clears stale metadata', () => {
      const toolCall = buildToolCall('big');
      toolCall.resultTruncated = { originalChars: 999 };

      setClampedToolCallResult(toolCall, 'small');

      expect(toolCall.result).toBe('small');
      expect(toolCall.resultTruncated).toBeUndefined();
    });
  });
});
