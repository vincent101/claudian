import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ClaudeTranscriptDiagnosticLog } from '@/providers/claude/transcript/ClaudeTranscriptDiagnosticLog';

describe('ClaudeTranscriptDiagnosticLog', () => {
  let vault: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'claudian-diagnostic-'));
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  it('persists each sanitized event synchronously', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    log.record({ phase: 'save_start', turnIdHash: log.hashId('secret-id'), errorName: 'Error' });
    const content = await readFile(join(vault, '.claudian/diagnostics/transcript-tail.current.jsonl'), 'utf8');
    expect(content).toContain('"phase":"save_start"');
    expect(content).not.toContain('secret-id');
  });

  it('persists line offsets for skipped-line diagnostics', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    log.record({ phase: 'line_skipped', reason: 'oversized', offset: 1234, bytes: 99 });
    const content = await readFile(join(vault, '.claudian/diagnostics/transcript-tail.current.jsonl'), 'utf8');
    expect(content).toContain('"offset":1234');
  });

  it('keeps each serialized event within one kilobyte', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    log.record({ phase: 'callback_error', errorName: 'X'.repeat(10_000) });
    const content = await readFile(join(vault, '.claudian/diagnostics/transcript-tail.current.jsonl'));
    expect(content.byteLength).toBeLessThanOrEqual(1024);
  });

  it('fuses after a write failure and notifies only once', async () => {
    const diagnosticsPath = join(vault, '.claudian');
    await writeFile(diagnosticsPath, 'blocks directory creation');
    const notify = jest.fn();
    const log = new ClaudeTranscriptDiagnosticLog(vault, notify);
    expect(() => log.record({ phase: 'tick_start' })).not.toThrow();
    expect(() => log.record({ phase: 'tick_end' })).not.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('rotates bounded current and previous segments', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    for (let index = 0; index < 2_000; index += 1) {
      log.record({ phase: 'callback_error', errorName: 'X'.repeat(128), generation: index });
    }
    const directory = join(vault, '.claudian/diagnostics');
    const current = await stat(join(directory, 'transcript-tail.current.jsonl'));
    const previous = await stat(join(directory, 'transcript-tail.previous.jsonl'));
    expect(current.size).toBeLessThanOrEqual(128 * 1024);
    expect(previous.size).toBeLessThanOrEqual(128 * 1024);
  });
});
