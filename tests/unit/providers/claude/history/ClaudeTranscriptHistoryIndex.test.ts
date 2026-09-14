import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import {
  buildTranscriptIndex,
  clearTranscriptIndexCache,
  getTranscriptIndexCacheSize,
  materializeTranscriptPage,
} from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import { filterActiveBranch } from '@/providers/claude/history/sdkBranchFilter';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';

const fixtures = join(__dirname, '..', 'transcript', 'fixtures');

async function fixture(name: string): Promise<{ path: string; rows: SDKNativeMessage[] }> {
  const path = join(fixtures, name);
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { path, rows };
}

describe('ClaudeTranscriptHistoryIndex', () => {
  it.each(['production-auto-turn-sequence.jsonl', 'stop-hook-continuation.jsonl'])(
    'matches canonical branch ordering for %s',
    async name => {
      const { path, rows } = await fixture(name);
      const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 37 });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;
      expect(result.index.entries.map(entry => entry.messageKey)).toEqual(
        filterActiveBranch(rows).map((row, index) => row.uuid ?? `line:${index}`),
      );
    },
  );

  it('opens visible real and external turns but not notification turns', async () => {
    const { path } = await fixture('production-auto-turn-sequence.jsonl');
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 41 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['peer-a', 'peer-b']);
    expect(result.index.entries.find(entry => entry.messageKey === 'notification-a')?.turnId).toBe('peer-a');
  });

  it('builds searchable visible text without thinking, tool payloads, attachments, or system injection', async () => {
    const { path } = await fixture('production-auto-turn-sequence.jsonl');
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 41 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.searchCorpus.map(item => item.text)).toEqual([
      'fixture A',
      'answer A\nnotification answer A',
      'fixture B',
      'answer B\nnotification answer B',
    ]);
    const corpus = result.index.searchCorpus.map(item => item.text).join('\n');
    expect(corpus).not.toContain('thinking A');
    expect(corpus).not.toContain('queue item');
    expect(corpus).not.toContain('fixture notification');
  });

  it('indexes an external meta row and materializes byte-exact pages across chunks', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-index-${process.pid}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'world' } }),
      JSON.stringify({ type: 'user', uuid: 'p1', parentUuid: 'a1', isMeta: true, origin: { kind: 'peer', body: '[msg] peer' }, message: { content: 'envelope' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'p1', message: { content: 'done' } }),
    ];
    await writeFile(path, `${lines.join('\n')}\n`);
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 11 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['u1', 'p1']);
    await expect(materializeTranscriptPage(result.index, 1, 1)).resolves.toEqual([
      expect.objectContaining({ uuid: 'p1' }),
      expect.objectContaining({ uuid: 'a2' }),
    ]);
  });

  it('pins snapshot size and ignores an appended half-line', async () => {
    const path = join(process.env.TMPDIR ?? '/tmp', `claudian-snapshot-${process.pid}.jsonl`);
    await writeFile(path, '{"type":"user","uuid":"u1","message":{"content":"one"}}\n{"type":"assistant"');
    const result = await buildTranscriptIndex(path, { useWorker: false, chunkSize: 9 });
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(result.index.entries.map(entry => entry.messageKey)).toEqual(['u1']);
    expect(result.error).toMatch(/incomplete/i);
  });

  it('keeps at most two unprotected completed indexes', async () => {
    clearTranscriptIndexCache();
    for (let index = 0; index < 3; index += 1) {
      const path = join(process.env.TMPDIR ?? '/tmp', `claudian-lru-${process.pid}-${index}.jsonl`);
      await writeFile(path, `${JSON.stringify({ type: 'user', uuid: `u${index}`, message: { content: 'x' } })}\n`);
      await buildTranscriptIndex(path, { useWorker: false });
    }
    expect(getTranscriptIndexCacheSize()).toBeLessThanOrEqual(2);
  });

  it('deduplicates concurrent worker builds for the same snapshot', async () => {
    const { path } = await fixture('production-auto-turn-sequence.jsonl');
    const first = buildTranscriptIndex(path, { useWorker: false });
    const second = buildTranscriptIndex(path, { useWorker: false });
    expect(second).toBe(first);
    const result = await first;
    if (result.status === 'failed') throw new Error(result.error);
    expect(result.status).toBe('complete');
    expect(result.index.turns.map(turn => turn.turnId)).toEqual(['peer-a', 'peer-b']);
  });
});
