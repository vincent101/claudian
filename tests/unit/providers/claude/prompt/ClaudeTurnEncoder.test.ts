import type { ChatTurnRequest } from '@/core/runtime/types';
import { encodeClaudeTurn } from '@/providers/claude/prompt/ClaudeTurnEncoder';

describe('encodeClaudeTurn', () => {
  it('should return PreparedChatTurn with correct shape', () => {
    const request: ChatTurnRequest = { turnId: 'turn-encoder-1', text: 'hello' };
    const result = encodeClaudeTurn(request);

    expect(result).toEqual({
      turnId: 'turn-encoder-1',
      request,
      persistedContent: 'hello',
      prompt: 'hello',
      isCompact: false,
    });
  });

  it('should detect /compact command', () => {
    const result = encodeClaudeTurn({ turnId: 'turn-encoder', text: '/compact' });
    expect(result.isCompact).toBe(true);
  });

  it('should detect /compact with arguments', () => {
    const result = encodeClaudeTurn({ turnId: 'turn-encoder', text: '/compact summarize' });
    expect(result.isCompact).toBe(true);
  });

  it('should not treat "compact" without slash as compact', () => {
    const result = encodeClaudeTurn({ turnId: 'turn-encoder', text: 'compact this' });
    expect(result.isCompact).toBe(false);
  });

  it('should skip all context appending when /compact', () => {
    const request: ChatTurnRequest = {
      turnId: 'turn-encoder',
      text: '/compact',
      currentNotePath: 'notes/test.md',
      editorSelection: { notePath: 'test.md', mode: 'selection', selectedText: 'selected' } as any,
      browserSelection: { source: 'surfing-view', selectedText: 'browser text' } as any,
    };
    const result = encodeClaudeTurn(request);

    expect(result.persistedContent).toBe('/compact');
    expect(result.prompt).toBe('/compact');
  });

  it('should append current note context', () => {
    const request: ChatTurnRequest = {
      turnId: 'turn-encoder',
      text: 'hello',
      currentNotePath: 'notes/test.md',
    };
    const result = encodeClaudeTurn(request);

    expect(result.persistedContent).toContain('<current_note>');
    expect(result.persistedContent).toContain('notes/test.md');
  });

  it('should append editor selection context', () => {
    const request: ChatTurnRequest = {
      turnId: 'turn-encoder',
      text: 'explain this',
      editorSelection: {
        notePath: 'notes/test.md',
        mode: 'selection',
        selectedText: 'selected code',
      } as any,
    };
    const result = encodeClaudeTurn(request);

    expect(result.persistedContent).toContain('<editor_selection');
    expect(result.persistedContent).toContain('selected code');
  });

  it('should append browser selection context', () => {
    const request: ChatTurnRequest = {
      turnId: 'turn-encoder',
      text: 'summarize',
      browserSelection: {
        source: 'surfing-view',
        selectedText: 'browser text',
        title: 'Test Page',
      } as any,
    };
    const result = encodeClaudeTurn(request);

    expect(result.persistedContent).toContain('<browser_selection');
    expect(result.persistedContent).toContain('browser text');
  });

  it('should append canvas selection context', () => {
    const request: ChatTurnRequest = {
      turnId: 'turn-encoder',
      text: 'explain this canvas',
      canvasSelection: {
        canvasPath: 'diagrams/overview.canvas',
        nodeIds: ['node-1', 'node-2'],
      } as any,
    };
    const result = encodeClaudeTurn(request);

    expect(result.persistedContent).toContain('<canvas_selection');
    expect(result.persistedContent).toContain('diagrams/overview.canvas');
    expect(result.persistedContent).toContain('node-1');
    expect(result.persistedContent).toContain('node-2');
  });

  it('should keep @server text as plain text (no MCP mention machinery)', () => {
    const result = encodeClaudeTurn({ turnId: 'turn-encoder', text: '@server-a hello' });

    // No suffix transformation: an @name is just text now.
    expect(result.prompt).toBe('@server-a hello');
    expect(result.persistedContent).toBe('@server-a hello');
  });

  it('should handle request with no optional fields', () => {
    const result = encodeClaudeTurn({ turnId: 'turn-encoder', text: 'plain message' });

    expect(result.persistedContent).toBe('plain message');
    expect(result.prompt).toBe('plain message');
    expect(result.isCompact).toBe(false);
    expect(result.request.text).toBe('plain message');
  });

  it('should preserve request reference in output', () => {
    const request: ChatTurnRequest = { turnId: 'turn-encoder-img', text: 'hello', images: [{ mediaType: 'image/png', data: 'abc' }] as any };
    const result = encodeClaudeTurn(request);

    expect(result.request).toBe(request);
  });
});
