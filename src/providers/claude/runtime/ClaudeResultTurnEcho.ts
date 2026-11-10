/**
 * CLI-produced turn-consumption echo on result frames (G1).
 *
 * The SDK 0.2.112 transport is a bare pipe in both directions (stdin
 * JSON.stringify, stdout JSON.parse), so these fields reach the fork today
 * even though `sdk.d.ts` does not declare them. They are READ STRUCTURALLY
 * and may be absent: an older CLI, or a turn that carried no client uuid and
 * folded no user message in, simply produces none — callers must fall back to
 * the existing lease/heuristic binding without erroring.
 *
 * Field semantics (CLI >= 2.1.193 / 2.1.245 / 2.1.259 / 2.1.303):
 * - `user_message_uuid`: the client uuid this turn consumed as its subject
 * - `user_message_uuids`: every consumed uuid in consumption order, <= 64,
 *   always containing the singular one
 * - `queued_turn_count`: pending user sends when the result was written
 * - `result_index`: write order of the result (failures still consume an
 *   index) — diagnostics only, never turn order
 */

export const RESULT_TURN_ECHO_MAX_UUIDS = 64;

/** Result-echo uuid hashes per diagnostic row; the count field carries the rest. */
export const RESULT_TURN_ECHO_LOG_HASH_LIMIT = 8;

export interface ResultTurnEcho {
  userMessageUuid: string | null;
  userMessageUuids: string[] | null;
  queuedTurnCount: number | null;
  resultIndex: number | null;
  /** The producer reported more than the cap; only the first 64 were kept. */
  userMessageUuidsTruncated: boolean;
  /** The plural echo omitted the singular uuid (producer contract violation). */
  userMessageUuidMissingFromPlural: boolean;
  /** The plural field was present but malformed; it is never partially trusted. */
  userMessageUuidsInvalid: boolean;
}

export type ResultTurnEchoStatus = 'absent' | 'present' | 'invalid';

export interface ResultTurnEchoRead {
  status: ResultTurnEchoStatus;
  echo: ResultTurnEcho | null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Reads the four passthrough fields off a result frame. `absent` and
 * `invalid` are both normal degradation signals, not errors; only `present`
 * carries bindable evidence.
 */
export function readResultTurnEcho(message: unknown): ResultTurnEchoRead {
  if (!message || typeof message !== 'object') {
    return { status: 'absent', echo: null };
  }
  const frame = message as Record<string, unknown>;
  if (frame.type !== 'result') {
    return { status: 'absent', echo: null };
  }

  const userMessageUuid = readNonEmptyString(frame.user_message_uuid);
  const queuedTurnCount = readNonNegativeInteger(frame.queued_turn_count);
  const resultIndex = readNonNegativeInteger(frame.result_index);

  let userMessageUuids: string[] | null = null;
  let userMessageUuidsTruncated = false;
  let userMessageUuidsInvalid = false;
  const pluralRaw = frame.user_message_uuids;
  if (pluralRaw !== undefined) {
    if (!Array.isArray(pluralRaw) || pluralRaw.length === 0) {
      userMessageUuidsInvalid = true;
    } else {
      const normalized: string[] = [];
      for (const entry of pluralRaw) {
        const uuid = readNonEmptyString(entry);
        // A malformed member makes the whole consumption list untrustworthy:
        // never bind on a partially parsed echo.
        if (uuid === null) {
          userMessageUuidsInvalid = true;
          break;
        }
        normalized.push(uuid);
      }
      if (!userMessageUuidsInvalid) {
        userMessageUuidsTruncated = normalized.length > RESULT_TURN_ECHO_MAX_UUIDS;
        userMessageUuids = normalized.slice(0, RESULT_TURN_ECHO_MAX_UUIDS);
      }
    }
  }

  const hasEchoField = frame.user_message_uuid !== undefined
    || frame.user_message_uuids !== undefined
    || frame.queued_turn_count !== undefined
    || frame.result_index !== undefined;
  if (!hasEchoField) {
    return { status: 'absent', echo: null };
  }
  if (
    userMessageUuid === null
    && userMessageUuids === null
    && queuedTurnCount === null
    && resultIndex === null
  ) {
    return { status: 'invalid', echo: null };
  }

  return {
    status: 'present',
    echo: {
      userMessageUuid,
      userMessageUuids,
      queuedTurnCount,
      resultIndex,
      userMessageUuidsTruncated,
      userMessageUuidMissingFromPlural: userMessageUuid !== null
        && userMessageUuids !== null
        && !userMessageUuids.includes(userMessageUuid),
      userMessageUuidsInvalid,
    },
  };
}

/**
 * Canonical evidence set for binding: the plural consumption list first (it
 * is the recorded consumption order), then the singular uuid when the
 * producer's plural omitted it. Deduped defensively.
 */
export function resultEchoConsumedUuids(echo: ResultTurnEcho): string[] {
  const uuids: string[] = [];
  const seen = new Set<string>();
  const add = (uuid: string | null): void => {
    if (uuid === null || seen.has(uuid)) return;
    seen.add(uuid);
    uuids.push(uuid);
  };
  for (const uuid of echo.userMessageUuids ?? []) add(uuid);
  add(echo.userMessageUuid);
  return uuids;
}

export interface CliTurnEchoSupport {
  singular: boolean;
  queuedTurnCount: boolean;
  plural: boolean;
  resultIndex: boolean;
}

const TURN_ECHO_MIN_CLI: ReadonlyArray<
  readonly [keyof CliTurnEchoSupport, readonly [number, number, number]]
> = [
  ['singular', [2, 1, 193]],
  ['queuedTurnCount', [2, 1, 245]],
  ['plural', [2, 1, 259]],
  ['resultIndex', [2, 1, 303]],
];

export function parseCliVersion(raw: string | null | undefined): { major: number; minor: number; patch: number } | null {
  if (typeof raw !== 'string') return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Version-derived capability expectation. Diagnostics and degradation only:
 * runtime behavior always keys on field presence, never on this verdict, and
 * an unknown version must never block startup or sending.
 */
export function detectTurnEchoSupport(rawVersion: string | null | undefined): CliTurnEchoSupport | null {
  const version = parseCliVersion(rawVersion);
  if (version === null) return null;
  const atLeast = (min: readonly [number, number, number]): boolean => {
    if (version.major !== min[0]) return version.major > min[0];
    if (version.minor !== min[1]) return version.minor > min[1];
    return version.patch >= min[2];
  };
  const support: CliTurnEchoSupport = {
    singular: false,
    queuedTurnCount: false,
    plural: false,
    resultIndex: false,
  };
  for (const [field, min] of TURN_ECHO_MIN_CLI) {
    support[field] = atLeast(min);
  }
  return support;
}

export function formatTurnEchoSupport(support: CliTurnEchoSupport): string {
  const enabled = TURN_ECHO_MIN_CLI
    .filter(([field]) => support[field])
    .map(([field]) => field);
  return enabled.length > 0 ? enabled.join('+') : 'none';
}

/** The CLI version rides the raw init frame (`claude_code_version`). */
export function readClaudeCodeVersion(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const frame = message as Record<string, unknown>;
  if (frame.type !== 'system' || frame.subtype !== 'init') return null;
  return readNonEmptyString(frame.claude_code_version);
}
