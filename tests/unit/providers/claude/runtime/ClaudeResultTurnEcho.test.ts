import {
  detectTurnEchoSupport,
  parseCliVersion,
  readClaudeCodeVersion,
  readResultTurnEcho,
  RESULT_TURN_ECHO_MAX_UUIDS,
  resultEchoConsumedUuids,
} from '@/providers/claude/runtime/ClaudeResultTurnEcho';

function resultFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'result', subtype: 'success', ...overrides };
}

describe('readResultTurnEcho (G1 passthrough fields)', () => {
  it('reads all four CLI-produced fields from a result frame', () => {
    const read = readResultTurnEcho(resultFrame({
      user_message_uuid: 'uuid-singular',
      user_message_uuids: ['uuid-a', 'uuid-b', 'uuid-singular'],
      queued_turn_count: 2,
      result_index: 7,
    }));

    expect(read.status).toBe('present');
    expect(read.echo).toEqual({
      userMessageUuid: 'uuid-singular',
      userMessageUuids: ['uuid-a', 'uuid-b', 'uuid-singular'],
      queuedTurnCount: 2,
      resultIndex: 7,
      userMessageUuidsTruncated: false,
      userMessageUuidMissingFromPlural: false,
      userMessageUuidsInvalid: false,
    });
  });

  it('reports absent for frames without any echo field', () => {
    expect(readResultTurnEcho(resultFrame())).toEqual({ status: 'absent', echo: null });
  });

  it('only reads result frames, never other message types', () => {
    expect(readResultTurnEcho({ type: 'assistant', user_message_uuid: 'uuid-a' })).toEqual({
      status: 'absent',
      echo: null,
    });
    expect(readResultTurnEcho(null)).toEqual({ status: 'absent', echo: null });
    expect(readResultTurnEcho('result')).toEqual({ status: 'absent', echo: null });
  });

  it('accepts a singular-only echo (older producers)', () => {
    const read = readResultTurnEcho(resultFrame({ user_message_uuid: 'uuid-singular' }));

    expect(read.status).toBe('present');
    expect(read.echo).toEqual(expect.objectContaining({
      userMessageUuid: 'uuid-singular',
      userMessageUuids: null,
    }));
  });

  it('accepts a plural echo without singular', () => {
    const read = readResultTurnEcho(resultFrame({ user_message_uuids: ['uuid-a', 'uuid-b'] }));

    expect(read.status).toBe('present');
    expect(read.echo).toEqual(expect.objectContaining({
      userMessageUuid: null,
      userMessageUuids: ['uuid-a', 'uuid-b'],
    }));
  });

  it('flags a plural echo that omits the singular uuid and keeps both as evidence', () => {
    const read = readResultTurnEcho(resultFrame({
      user_message_uuid: 'uuid-singular',
      user_message_uuids: ['uuid-a'],
    }));

    expect(read.echo?.userMessageUuidMissingFromPlural).toBe(true);
    expect(resultEchoConsumedUuids(read.echo!)).toEqual(['uuid-a', 'uuid-singular']);
  });

  it('rejects a malformed plural echo instead of trusting part of it', () => {
    const read = readResultTurnEcho(resultFrame({
      user_message_uuid: 'uuid-singular',
      user_message_uuids: ['uuid-a', 42],
    }));

    expect(read.status).toBe('present');
    expect(read.echo).toEqual(expect.objectContaining({
      userMessageUuid: 'uuid-singular',
      userMessageUuids: null,
      userMessageUuidsInvalid: true,
    }));
    expect(resultEchoConsumedUuids(read.echo!)).toEqual(['uuid-singular']);
  });

  it('reports invalid when every present field is malformed', () => {
    const read = readResultTurnEcho(resultFrame({
      user_message_uuid: 42,
      user_message_uuids: 'uuid-a',
      queued_turn_count: '2',
      result_index: -1,
    }));

    expect(read.status).toBe('invalid');
    expect(read.echo).toBeNull();
  });

  it(`truncates the plural echo to the first ${RESULT_TURN_ECHO_MAX_UUIDS} uuids`, () => {
    const uuids = Array.from({ length: RESULT_TURN_ECHO_MAX_UUIDS + 3 }, (_, index) => `uuid-${index}`);
    const read = readResultTurnEcho(resultFrame({ user_message_uuids: uuids }));

    expect(read.echo?.userMessageUuids).toHaveLength(RESULT_TURN_ECHO_MAX_UUIDS);
    expect(read.echo?.userMessageUuids?.[0]).toBe('uuid-0');
    expect(read.echo?.userMessageUuids?.at(-1)).toBe(`uuid-${RESULT_TURN_ECHO_MAX_UUIDS - 1}`);
    expect(read.echo?.userMessageUuidsTruncated).toBe(true);
  });

  it('ignores non-integer and negative context counters', () => {
    const read = readResultTurnEcho(resultFrame({
      user_message_uuid: 'uuid-a',
      queued_turn_count: 1.5,
      result_index: -3,
    }));

    expect(read.echo).toEqual(expect.objectContaining({
      queuedTurnCount: null,
      resultIndex: null,
    }));
  });

  it('dedupes consumed uuids while preserving consumption order', () => {
    const read = readResultTurnEcho(resultFrame({
      user_message_uuid: 'uuid-a',
      user_message_uuids: ['uuid-b', 'uuid-a', 'uuid-b'],
    }));

    expect(resultEchoConsumedUuids(read.echo!)).toEqual(['uuid-b', 'uuid-a']);
  });
});

describe('CLI turn-echo capability (diagnostics and degradation only)', () => {
  it('parses the leading version out of CLI version strings', () => {
    expect(parseCliVersion('2.1.311')).toEqual({ major: 2, minor: 1, patch: 311 });
    expect(parseCliVersion('2.1.311 (Claude Code)')).toEqual({ major: 2, minor: 1, patch: 311 });
    expect(parseCliVersion('')).toBeNull();
    expect(parseCliVersion(null)).toBeNull();
    expect(parseCliVersion('homebrew')).toBeNull();
  });

  it.each([
    ['2.1.192', { singular: false, queuedTurnCount: false, plural: false, resultIndex: false }],
    ['2.1.193', { singular: true, queuedTurnCount: false, plural: false, resultIndex: false }],
    ['2.1.258', { singular: true, queuedTurnCount: true, plural: false, resultIndex: false }],
    ['2.1.259', { singular: true, queuedTurnCount: true, plural: true, resultIndex: false }],
    ['2.1.303', { singular: true, queuedTurnCount: true, plural: true, resultIndex: true }],
    ['2.1.311', { singular: true, queuedTurnCount: true, plural: true, resultIndex: true }],
  ] as const)('classifies %s', (version, expected) => {
    expect(detectTurnEchoSupport(version)).toEqual(expected);
  });

  it('returns null when the CLI version is unknown', () => {
    expect(detectTurnEchoSupport(undefined)).toBeNull();
    expect(detectTurnEchoSupport('unknown-build')).toBeNull();
  });

  it('reads claude_code_version from the raw init frame only', () => {
    expect(readClaudeCodeVersion({ type: 'system', subtype: 'init', claude_code_version: '2.1.311' }))
      .toBe('2.1.311');
    expect(readClaudeCodeVersion({ type: 'system', subtype: 'init' })).toBeNull();
    expect(readClaudeCodeVersion({ type: 'result', claude_code_version: '2.1.311' })).toBeNull();
    expect(readClaudeCodeVersion(null)).toBeNull();
  });
});
