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

  it('serializes markdown summary fields and rejects non-whitelisted values', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault, () => {}, 'markdown-render');
    const summary = {
      phase: 'markdown_render_summary', metricVersion: 1, collectorIdHash: log.hashId('private-collector'),
      flushId: 1, flushReason: 'timer', flushScope: 'window', windowMs: 5000,
      callsSum: 3, callsMax: 2, callsSampleCount: 2, callsHistogram: [1, 1, 0, 0, 0, 0, 0, 0],
      charsSum: 18, charsMax: 9, charsHistogram: [3, 0, 0, 0, 0, 0, 0],
      elapsedMsSum: 80.5, elapsedMsMax: 64, elapsedMsHistogram: [1, 0, 0, 1, 1, 0, 0, 0],
      settledCalls: 3, successCalls: 2, failureCalls: 1, inFlightAtStart: 0, inFlightAtEnd: 0,
      abandonedCalls: 0, startVisibilityHistogram: [3, ...Array(26).fill(0)], attributionRows: 2,
      domPageNodes: 1, domMessageNodes: 2, domTextBlockNodes: 3,
      detail: 'private chat/path/title/credential', errorName: 'private exception', extra: { secret: 'private object' },
    };
    log.record(summary as any);
    log.record({ ...summary, flushScope: 'attribution', attributionKind: 'known', attributionSlot: 1, tabIdHash: 'private-id', tabActive: 'private-text',
      charsHistogram: ['private-text', ...Array(6).fill(0)], elapsedMsSum: Infinity } as any);
    log.record({ ...summary, flushScope: 'attribution', attributionKind: 'overflow', attributionSlot: 0,
      tabIdHash: 'aaaaaaaaaaaa', conversationIdHash: 'bbbbbbbbbbbb', tabGeneration: 5, tabActive: 'yes' } as any);
    const content = await readFile(join(vault, '.claudian/diagnostics/markdown-render.current.jsonl'), 'utf8');
    const [first, second, overflow] = content.trim().split('\n').map(line => JSON.parse(line));
    expect(first).toMatchObject({ phase: 'markdown_render_summary', callsSum: 3, callsMax: 2,
      charsHistogram: [3, 0, 0, 0, 0, 0, 0], domMessageNodes: 2 });
    expect(first.startVisibilityHistogram).toHaveLength(27);
    expect(second).not.toHaveProperty('tabIdHash');
    expect(second).not.toHaveProperty('tabActive');
    expect(second).not.toHaveProperty('charsHistogram');
    expect(second).not.toHaveProperty('elapsedMsSum');
    expect(second).not.toHaveProperty('callsHistogram');
    expect(overflow).toMatchObject({ attributionKind: 'overflow', attributionSlot: 0 });
    expect(overflow).not.toHaveProperty('tabIdHash');
    expect(overflow).not.toHaveProperty('conversationIdHash');
    expect(overflow).not.toHaveProperty('tabGeneration');
    expect(overflow).not.toHaveProperty('tabActive');
    expect(content).not.toContain('private');
  });

  it.each([
    ['charsHistogram', 7],
    ['elapsedMsHistogram', 8],
    ['startVisibilityHistogram', 27],
    ['callsHistogram', 8],
  ] as const)('rejects holes and invalid elements in %s while preserving dense values', async (key, length) => {
    const log = new ClaudeTranscriptDiagnosticLog(vault, () => {}, 'markdown-render');
    const sparse = Array(length);
    const holeInMiddle = Array(length).fill(1);
    delete holeInMiddle[Math.floor(length / 2)];
    const inherited = Array(length).fill(1);
    delete inherited[0];
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: 1 }));
    const invalidValues = [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined];
    const invalidArrays = [sparse, holeInMiddle, inherited, ...invalidValues.map(value => {
      const array = Array(length).fill(1);
      array[1] = value;
      return array;
    })];
    for (const array of invalidArrays) {
      log.record({ phase: 'markdown_render_summary', flushScope: 'window', [key]: array } as any);
    }
    const dense = Array.from({ length }, (_, index) => index);
    log.record({ phase: 'markdown_render_summary', flushScope: 'window', [key]: dense } as any);
    const content = await readFile(join(vault, '.claudian/diagnostics/markdown-render.current.jsonl'), 'utf8');
    const rows = content.trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(invalidArrays.length + 1);
    for (const row of rows.slice(0, -1)) expect(row).not.toHaveProperty(key);
    expect(rows[rows.length - 1][key]).toEqual(dense);
    expect(content).not.toContain('null');
  });

  it('rotates markdown summary rows within the existing 128 KiB segments', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault, () => {}, 'markdown-render');
    const summary = { phase: 'markdown_render_summary', metricVersion: 1, collectorIdHash: 'aaaaaaaaaaaa',
      flushId: 1, flushReason: 'timer', flushScope: 'window', windowMs: 5000, callsSum: 1,
      callsMax: 1, callsSampleCount: 1, callsHistogram: [1, 0, 0, 0, 0, 0, 0, 0],
      charsSum: 3, charsMax: 3, charsHistogram: [1, 0, 0, 0, 0, 0, 0], elapsedMsSum: 1,
      elapsedMsMax: 1, elapsedMsHistogram: [0, 1, 0, 0, 0, 0, 0, 0], settledCalls: 1,
      successCalls: 1, failureCalls: 0, inFlightAtStart: 0, inFlightAtEnd: 0, abandonedCalls: 0,
      startVisibilityHistogram: [1, ...Array(26).fill(0)], attributionRows: 1 };
    for (let i = 0; i < 1000; i++) log.record({ ...summary, flushId: i + 1 } as any);
    const directory = join(vault, '.claudian/diagnostics');
    expect((await stat(join(directory, 'markdown-render.current.jsonl'))).size).toBeLessThanOrEqual(128 * 1024);
    expect((await stat(join(directory, 'markdown-render.previous.jsonl'))).size).toBeLessThanOrEqual(128 * 1024);
    const current = await readFile(join(directory, 'markdown-render.current.jsonl'), 'utf8');
    expect(JSON.parse(current.trim().split('\n')[0])).toMatchObject({ phase: 'markdown_render_summary', callsSum: 1 });
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

  it('persists compact and stopTask diagnostic fields without raw agent identifiers', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    const agentIdHash = log.hashId('private-agent-id');
    log.record({ phase: 'settle_watchdog_fire', evidenceKind: 'compact', cliVersion: '2.1.311', agentCandidateCount: 2 });
    log.record({ phase: 'stop_task_sent', agentIdHash });
    log.record({ phase: 'stop_task_outcome', outcome: 'settled_by_result', cliVersion: '2.1.311', agentCandidateCount: 2 });
    log.record({ phase: 'turn_cancel', generation: 4, detail: 'result_watchdog' });
    const content = await readFile(join(vault, '.claudian/diagnostics/transcript-tail.current.jsonl'), 'utf8');
    expect(content).toContain('"evidenceKind":"compact"');
    expect(content).toContain('"cliVersion":"2.1.311"');
    expect(content).toContain('"agentCandidateCount":2');
    expect(content).toContain(`"agentIdHash":"${agentIdHash}"`);
    expect(content).toContain('"outcome":"settled_by_result"');
    expect(content).not.toContain('private-agent-id');
  });

  it('persists result-echo diagnostics with hashed uuids and a bounded hash list', async () => {
    const log = new ClaudeTranscriptDiagnosticLog(vault);
    const hashes = Array.from({ length: 12 }, (_, index) => log.hashId(`uuid-${index}`));
    log.record({
      phase: 'turn_result_echo',
      echoStatus: 'present',
      echoUuidHash: log.hashId('uuid-singular'),
      echoUuidHashes: hashes,
      echoUuidCount: hashes.length,
      queuedTurnCount: 2,
      resultIndex: 3,
      echoSupport: 'singular+queuedTurnCount+plural+resultIndex',
      echoPluralTruncated: true,
      echoSingularMissingFromPlural: true,
    });
    log.record({ phase: 'turn_identity_result_echo', echoOutcome: 'bound' });

    const content = await readFile(join(vault, '.claudian/diagnostics/transcript-tail.current.jsonl'), 'utf8');
    const [echo, verdict] = content.trim().split('\n').map(line => JSON.parse(line));
    expect(echo).toMatchObject({
      phase: 'turn_result_echo',
      echoStatus: 'present',
      echoUuidCount: 12,
      queuedTurnCount: 2,
      resultIndex: 3,
      echoPluralTruncated: true,
      echoSingularMissingFromPlural: true,
    });
    expect(echo.echoUuidHashes).toEqual(hashes.slice(0, 8));
    expect(verdict).toMatchObject({ phase: 'turn_identity_result_echo', echoOutcome: 'bound' });
    expect(content).not.toContain('uuid-');
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
