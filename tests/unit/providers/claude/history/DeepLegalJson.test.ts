import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import {
  buildTranscriptIndex,
  clearTranscriptIndexCache,
  materializeTranscriptPage,
  resetTranscriptIndexWorkerProbe,
  setTranscriptIndexDiagnosticSink,
  type TranscriptIndexDiagnosticEvent,
} from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import * as sdkPaths from '@/providers/claude/history/sdkSessionPaths';

it.each([false, true])('retains legal deeply nested JSON in visible history (worker=%s)', async useWorker => {
  const dir = await mkdtemp(join(tmpdir(), 'claudian-deep-legal-'));
  const events: TranscriptIndexDiagnosticEvent[] = [];
  clearTranscriptIndexCache();
  resetTranscriptIndexWorkerProbe();
  setTranscriptIndexDiagnosticSink(event => events.push(event));
  try {
    for (const depth of [20_000, 80_000]) {
      const nested = '{"child":'.repeat(depth) + '0' + '}'.repeat(depth);
      // Construct raw JSON, not JSON.stringify: parsing is legal even when
      // recursive serializers cannot represent the same tool input.
      const rows = [
        '{"type":"user","uuid":"u","parentUuid":null,"message":{"content":"visible question"},"extra":' + nested + '}',
        '{"type":"assistant","uuid":"a","parentUuid":"u","message":{"content":[{"type":"text","text":"visible answer"},{"type":"tool_use","id":"tool","name":"fixture","input":' + nested + '}]}}',
        '{"type":"user","uuid":"r","parentUuid":"a","message":{"content":[{"type":"tool_result","tool_use_id":"tool","content":"done"}]},"toolUseResult":' + nested + '}',
      ];
      const text = rows.join('\n') + '\n';
      rows.forEach(row => expect(() => JSON.parse(row)).not.toThrow());
      const path = join(dir, `${depth}.jsonl`);
      await writeFile(path, text);
      const result = await buildTranscriptIndex(path, { useWorker, chunkSize: 32_768 });
      expect(result.status).toBe('complete');
      if (result.status === 'failed') throw new Error(result.error);
      expect(result.index.skippedLines).toBe(0);
      expect(result.index.committedSize).toBe(Buffer.byteLength(text));
      expect(result.index.turns.map(turn => turn.turnId)).toEqual(['u']);
      expect(result.index.entries.map(entry => entry.uuid)).toEqual(['u', 'a', 'r']);
      expect(result.index.searchText).toContain('visible question');
      expect(result.index.searchText).toContain('visible answer');
      const page = await materializeTranscriptPage(result.index, 0, 1);
      expect(page.map(row => row.uuid)).toEqual(['u', 'a', 'r']);
      const pathSpy = jest.spyOn(sdkPaths, 'getSDKSessionPath').mockReturnValue(path);
      const exists = jest.spyOn(sdkPaths, 'sdkSessionExists').mockReturnValue(true);
      const conversation: Conversation = { id: String(depth), providerId: 'claude', title: 'Synthetic',
        createdAt: 1, updatedAt: 1, sessionId: String(depth), messages: [] };
      const lease = new ClaudeConversationHistoryService().acquireHistoryIndex(conversation, dir);
      setTranscriptIndexDiagnosticSink(event => events.push(event));
      try {
        await lease.ready;
        const window = await lease.loadWindow({ anchorTurn: 1, direction: 'older', projectionLevel: 'detail',
          budget: { maxTurns: 10, maxSourceBytes: 4 * 1024 * 1024, maxProjectedChars: 100_000, timeSliceMs: 8 } });
        expect(lease.totalTurns).toBe(1);
        expect(window.messages.map(message => message.content)).toEqual(['visible question', 'visible answer']);
        expect(window.messages[1].toolCalls?.[0]).toMatchObject({ id: 'tool', name: 'fixture', result: 'done' });
      } finally { lease.release(); pathSpy.mockRestore(); exists.mockRestore(); }
    }
    expect(events.filter(event => event.phase === 'complete' && event.mode === (useWorker ? 'worker' : 'direct'))).toHaveLength(2);
    expect(events.some(event => event.phase === 'index_worker_fallback')).toBe(false);
    expect(events.some(event => event.phase === 'line_skipped')).toBe(false);
  } finally {
    setTranscriptIndexDiagnosticSink(null);
    await rm(dir, { recursive: true, force: true });
  }
});
