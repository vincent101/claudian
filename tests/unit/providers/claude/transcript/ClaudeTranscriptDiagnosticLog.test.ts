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

  it('persists oversized identity-recovery provenance without values', async () => {
    // Real-machine acceptance for the dual-scan fix depends on the recovery
    // source being visible in the on-disk log, not just in the sink event.
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    log.record({
      phase: 'line_skipped',
      reason: 'oversized',
      offset: 1234,
      identityRecovery: 'suffix',
      recoveredIdentityFields: ['uuid', 'timestamp'],
    });
    const content = await readFile(join(vault, '.claudian/diagnostics/transcript-tail.current.jsonl'), 'utf8');
    expect(content).toContain('"identityRecovery":"suffix"');
    expect(content).toContain('"recoveredIdentityFields":["uuid","timestamp"]');
  });

  it('persists hashed page keys without leaking raw paths', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    const pageKey = '/Users/me/.claude/projects/vault/transcript.jsonl:1200:1700000000';
    log.record({ phase: 'page_render_timeout', pageKeyHash: log.hashId(pageKey), renderTicket: 7, elapsedMs: 5000 });
    const content = await readFile(join(vault, '.claudian/diagnostics/transcript-tail.current.jsonl'), 'utf8');
    expect(content).toContain('"pageKeyHash":');
    expect(content).not.toContain(pageKey);
  });

  it('persists re-key and refusal diagnostics through the serialization whitelist', async () => {
    // The mapper hands these events over with previousPageKeyHash/rangeStart/
    // rangeEnd; the serialization key whitelist must carry them to disk or
    // they are silently dropped (matrix #7 visibility).
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    log.record({
      phase: 'page_rekeyed',
      pageKeyHash: log.hashId('w:S2:0:5'),
      previousPageKeyHash: log.hashId('w:S1:0:5'),
      turns: 5,
    });
    log.record({
      phase: 'page_rematerialize_refused',
      pageKeyHash: log.hashId('w:S1:0:5'),
      reason: 'range_mismatch',
      rangeStart: 0,
      rangeEnd: 5,
      turnCount: 3,
    });
    const content = await readFile(join(vault, '.claudian/diagnostics/transcript-tail.current.jsonl'), 'utf8');
    expect(content).toContain('"phase":"page_rekeyed"');
    expect(content).toContain('"previousPageKeyHash":');
    expect(content).toContain('"phase":"page_rematerialize_refused"');
    expect(content).toContain('"rangeStart":0');
    expect(content).toContain('"rangeEnd":5');
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
