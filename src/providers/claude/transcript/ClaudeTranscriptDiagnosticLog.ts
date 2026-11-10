import { createHash, randomBytes } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { RESULT_TURN_ECHO_LOG_HASH_LIMIT } from '../runtime/ClaudeResultTurnEcho';

export type TranscriptDiagnosticPhase =
  | 'tick_start' | 'tick_end' | 'map'
  | 'lease_begin' | 'lease_finish' | 'lease_release'
  | 'render_start' | 'render_end' | 'render_batch' | 'render_complete'
  | 'save_start' | 'save_end' | 'save_timeout' | 'callback_error'
  | 'index_worker_fallback'
  | 'queued' | 'start' | 'progress' | 'finalize' | 'complete' | 'failed' | 'aborted' | 'stalled'
  | 'window_planned' | 'window_complete'
  | 'cache_hit' | 'cache_evict' | 'cache_overcommit'
  | 'line_skipped' | 'partial_snapshot' | 'stale_partial_segment'
  | 'page_render_timeout' | 'page_data_overcommit' | 'dom_overcommit'
  | 'search_snapshot_refresh' | 'memory_only_rematerialize'
  | 'page_rekeyed' | 'page_rematerialize_refused'
  | 'turn_identity_reserved' | 'turn_identity_dispatched' | 'turn_identity_matched'
  | 'turn_identity_host_only' | 'turn_identity_observer_only'
  | 'turn_identity_duplicate' | 'turn_identity_conflict'
  // G1 result-frame turn echo: the raw passthrough read (`turn_result_echo`)
  // and the coordinator's binding verdict (`turn_identity_result_echo`).
  | 'turn_result_echo' | 'turn_identity_result_echo'
  // Turn settlement & cancellation reliability (P0 batch, 2026-11-01):
  // cancel/close/settle/interrupt trace plus the SDK session-state (runPhase)
  // bypass. reconcile_fix is reserved for the P1-2 reconciler.
  // 2026-11-04 d8912b5b follow-up: turn_cancel closes the cancelTurn blind
  // spot (U-A: silent settles were unattributable).
  | 'cancel_request' | 'runtime_cancel' | 'query_close' | 'force_settle'
  | 'settle_watchdog_fire' | 'interrupt_sent' | 'settle_result' | 'reconcile_fix'
  | 'run_phase' | 'turn_cancel' | 'stop_task_sent' | 'stop_task_outcome'
  // Query boundary isolation (2026-11-05 fix 2): stale-scope routing refusals
  // and rebuild milestones (retire/exit-confirmed/rebuild/restored), plus the
  // send prohibition locking starts after a failed recovery (2.4).
  | 'query_scope_stale' | 'query_retire' | 'query_exit_confirmed' | 'query_rebuilt'
  | 'query_start_prohibited'
  // Terminal-evidence retraction (fix 1): strong continuation proof un-arms
  // a stamped terminal so the watchdog can re-arm on the new terminal.
  | 'host_terminal_retracted'
  | 'save_adoption_target_mismatch'
  | 'save_materialization_rejected'
  | 'markdown_render_summary'
  // H/P8 tail-start handoff: the prime rejected (or silently declined) the
  // credentials' source. source_changed = replacement detected; missing =
  // the vanished source is unverifiable; stale/identity_missing = the
  // recovery-prime handshake variants.
  | 'prime_rejected'
  // Native MCP cutover (design 2026-11-09): a launch was blocked before
  // spawn by the scope admission gate.
  | 'native_mcp_cutover_block'
  // Stop-hook waiting-semantics hardening (design 2026-11-10): the Stop event
  // records what the SubagentManager believed, a hook/projection instance
  // split is called out explicitly, and the feature lease's silence watchdog
  // reports its force settle (or the skip reason).
  | 'stop_hook_state' | 'subagent_state_source_mismatch' | 'lease_stall_force_settle';

export interface TranscriptDiagnosticEvent {
  phase: TranscriptDiagnosticPhase;
  tabIdHash?: string;
  turnIdHash?: string;
  pageKeyHash?: string;
  previousPageKeyHash?: string;
  rangeStart?: number;
  rangeEnd?: number;
  generation?: number;
  renderTicket?: number;
  projectedWeight?: number;
  leaseKind?: 'user' | 'auto';
  batchBytes?: number;
  batchLines?: number;
  elapsedMs?: number;
  errorName?: string;
  buildId?: string;
  mode?: 'worker' | 'direct';
  reason?: 'oversized' | 'malformed' | 'no_conversation' | 'no_lease' | 'provider_without_index' | 'stale' | 'grant_timeout' | 'identity_missing' | 'alias_remap' | 'canonical_rebind' | 'range_mismatch' | 'rekey_conflict' | 'source_changed' | 'missing';
  outcome?: 'rebuilt' | 'cache_hit' | 'not_applicable' | 'failed' | 'settled_by_result' | 'error' | 'no_candidates' | 'sent';
  /** Which surface forced a search snapshot refresh (search panel default). */
  trigger?: 'search' | 'rewind' | 'fork';
  /** How the oversized-row identity was recovered (field names only, never values). */
  identityRecovery?: string;
  recoveredIdentityFields?: string[];
  offset?: number;
  queueMs?: number;
  bytes?: number;
  totalBytes?: number;
  entries?: number;
  turns?: number;
  turnCount?: number;
  sourceBytes?: number;
  projectedChars?: number;
  oversizedTurns?: number;
  /** Turn-identity reconciliation: number of host aliases on the dispatched queue item. */
  hostAliases?: number;
  /** Turn-identity reconciliation: observed external source kind (category only). */
  sourceKind?: string;
  /** Result-frame turn echo (G1): read status. Absent is normal degradation. */
  echoStatus?: 'absent' | 'present' | 'invalid';
  /** Result-frame turn echo (G1): hash of the singular uuid, never the raw id. */
  echoUuidHash?: string;
  /** Result-frame turn echo (G1): hashes of the consumed uuid list (bounded, count carries the total). */
  echoUuidHashes?: string[];
  /** Result-frame turn echo (G1): consumed uuid count after the 64-uuid cap. */
  echoUuidCount?: number;
  /** Result-frame turn echo (G1): pending user sends when the result was written. */
  queuedTurnCount?: number;
  /** Result-frame turn echo (G1): result write index — not turn order. */
  resultIndex?: number;
  /** Result-frame turn echo (G1): producer exceeded the 64-uuid cap. */
  echoPluralTruncated?: boolean;
  /** Result-frame turn echo (G1): plural omitted the singular uuid (contract violation). */
  echoSingularMissingFromPlural?: boolean;
  /** Result-frame turn echo (G1): version-derived capability expectation (diagnostics only). */
  echoSupport?: string;
  /** Result-frame turn echo (G1): coordinator binding verdict. */
  echoOutcome?: 'bound' | 'mismatch' | 'unbound';
  /** Feature-layer cancel snapshot (cancel_request): queued message slots held at cancel time. */
  queueLength?: number;
  /** Feature-layer cancel snapshot (cancel_request): streaming flag state. */
  isStreaming?: boolean;
  /** Watchdog (settle_watchdog_fire): ms since the transcript terminal tick. */
  terminalSeenAgeMs?: number;
  /** Watchdog (settle_watchdog_fire): ms since the last chunk reached the turn. */
  lastChunkAgeMs?: number;
  /** Watchdog (settle_watchdog_fire): which terminal evidence armed it (compact boundary vs stop_hook pair). */
  evidenceKind?: 'compact' | 'stop_hook';
  /** CLI version carried by the terminal-evidence transcript row (compact boundary rows carry it natively). */
  cliVersion?: string;
  agentIdHash?: string;
  /** Stop-hook snapshot: salted hashes of the running agents (bounded list). */
  agentIdHashes?: string[];
  agentCandidateCount?: number;
  /** Query epoch of the scope the recovery action acted on (frozen at send time). */
  queryEpoch?: number;
  /** Independent recovery attempt id (null for the silent probe's diagnostics). */
  attemptId?: number;
  /** Free-form short context: query-close reason, run_phase state value, force-settle outcome. */
  detail?: string;
  metricVersion?: 1;
  collectorIdHash?: string;
  flushId?: number;
  flushReason?: 'timer' | 'dispose';
  flushScope?: 'window' | 'attribution';
  windowMs?: number;
  callsSum?: number;
  callsMax?: number;
  callsSampleCount?: number;
  callsHistogram?: number[];
  charsSum?: number;
  charsMax?: number;
  charsHistogram?: number[];
  elapsedMsSum?: number;
  elapsedMsMax?: number;
  elapsedMsHistogram?: number[];
  settledCalls?: number;
  successCalls?: number;
  failureCalls?: number;
  inFlightAtStart?: number;
  inFlightAtEnd?: number;
  abandonedCalls?: number;
  startVisibilityHistogram?: number[];
  attributionRows?: number;
  attributionSlot?: number;
  attributionKind?: 'known' | 'overflow';
  tabIdState?: 'known' | 'unknown';
  conversationIdState?: 'known' | 'unknown';
  conversationIdHash?: string;
  tabGeneration?: number;
  conversationGeneration?: number;
  tabActive?: 'yes' | 'no' | 'unknown';
  documentVisible?: 'yes' | 'no' | 'unknown';
  domConnected?: 'yes' | 'no' | 'unknown';
  viewport?: 'unknown';
  domPageNodes?: number;
  domMessageNodes?: number;
  domTextBlockNodes?: number;
}

const SEGMENT_BYTES = 128 * 1024;
const ENTRY_BYTES = 1024;
/** Stop-hook snapshot list bound; agentCandidateCount carries the total. */
const SUBAGENT_ID_HASH_LIMIT = 8;

export class ClaudeTranscriptDiagnosticLog {
  private readonly currentPath: string;
  private readonly previousPath: string;
  private readonly salt = randomBytes(16);
  private seq = 0;
  private disabled = false;
  private notified = false;

  constructor(vaultPath: string, private readonly notify: (message: string) => void = () => {}, fileBase = 'transcript-tail') {
    const directory = join(vaultPath, '.claudian', 'diagnostics');
    this.currentPath = join(directory, `${fileBase}.current.jsonl`);
    this.previousPath = join(directory, `${fileBase}.previous.jsonl`);
  }

  hashId(id: string): string {
    return createHash('sha256').update(this.salt).update(id).digest('hex').slice(0, 12);
  }

  record(event: TranscriptDiagnosticEvent): void {
    if (this.disabled) return;
    try {
      mkdirSync(dirname(this.currentPath), { recursive: true });
      const entry = this.serialize(event);
      const bytes = Buffer.byteLength(entry);
      const currentBytes = existsSync(this.currentPath) ? statSync(this.currentPath).size : 0;
      if (currentBytes + bytes > SEGMENT_BYTES) {
        rmSync(this.previousPath, { force: true });
        if (existsSync(this.currentPath)) renameSync(this.currentPath, this.previousPath);
        writeFileSync(this.currentPath, '');
      }
      appendFileSync(this.currentPath, entry);
    } catch {
      this.disabled = true;
      if (!this.notified) {
        this.notified = true;
        try { this.notify('Transcript diagnostics could not be written.'); } catch { /* diagnostic failure is isolated */ }
      }
    }
  }

  private serialize(event: TranscriptDiagnosticEvent): string {
    if (event.phase === 'markdown_render_summary') return this.serializeMarkdown(event);
    const clean: Record<string, unknown> = { ts: Date.now(), seq: ++this.seq, phase: event.phase };
    for (const key of ['tabIdHash', 'turnIdHash', 'pageKeyHash', 'previousPageKeyHash', 'rangeStart', 'rangeEnd', 'generation', 'renderTicket', 'projectedWeight', 'leaseKind', 'batchBytes', 'batchLines', 'elapsedMs', 'errorName', 'buildId', 'mode', 'reason', 'outcome', 'trigger', 'identityRecovery', 'recoveredIdentityFields', 'offset', 'queueMs', 'bytes', 'totalBytes', 'entries', 'turns', 'turnCount', 'sourceBytes', 'projectedChars', 'oversizedTurns', 'hostAliases', 'sourceKind', 'queueLength', 'isStreaming', 'terminalSeenAgeMs', 'lastChunkAgeMs', 'evidenceKind', 'cliVersion', 'agentIdHash', 'agentCandidateCount', 'queryEpoch', 'attemptId', 'detail', 'echoStatus', 'echoUuidHash', 'echoUuidCount', 'queuedTurnCount', 'resultIndex', 'echoPluralTruncated', 'echoSingularMissingFromPlural', 'echoSupport', 'echoOutcome'] as const) {
      const value = event[key];
      if (value !== undefined) clean[key] = typeof value === 'string' ? value.slice(0, 128) : value;
    }
    // Echo uuid hashes are already salted hashes; keep the row bounded while
    // echoUuidCount carries the full list size.
    const echoHashes = event.echoUuidHashes;
    if (Array.isArray(echoHashes)) {
      const validHashes = echoHashes
        .filter(hash => typeof hash === 'string' && /^[a-f0-9]{12}$/.test(hash))
        .slice(0, RESULT_TURN_ECHO_LOG_HASH_LIMIT);
      if (validHashes.length > 0) clean.echoUuidHashes = validHashes;
    }
    // Stop-hook snapshot hashes follow the same rule: already salted, bounded
    // by the list limit, total carried by agentCandidateCount.
    const agentHashes = event.agentIdHashes;
    if (Array.isArray(agentHashes)) {
      const validHashes = agentHashes
        .filter(hash => typeof hash === 'string' && /^[a-f0-9]{12}$/.test(hash))
        .slice(0, SUBAGENT_ID_HASH_LIMIT);
      if (validHashes.length > 0) clean.agentIdHashes = validHashes;
    }
    let line = `${JSON.stringify(clean)}\n`;
    if (Buffer.byteLength(line) > ENTRY_BYTES) {
      delete clean.errorName;
      line = `${JSON.stringify(clean)}\n`;
    }
    return line;
  }

  private serializeMarkdown(event: TranscriptDiagnosticEvent): string {
    const clean: Record<string, unknown> = { ts: Date.now(), seq: ++this.seq, phase: 'markdown_render_summary' };
    const integerKeys = [
      'flushId', 'callsSum', 'charsSum', 'charsMax', 'settledCalls', 'successCalls', 'failureCalls',
      'inFlightAtStart', 'inFlightAtEnd', 'abandonedCalls',
    ] as const;
    const windowIntegerKeys = ['callsMax', 'callsSampleCount', 'attributionRows', 'domPageNodes', 'domMessageNodes', 'domTextBlockNodes'] as const;
    const attributionIntegerKeys = ['tabGeneration', 'conversationGeneration'] as const;
    const addIntegers = (keys: readonly (keyof TranscriptDiagnosticEvent)[]): void => {
      for (const key of keys) {
        const value = event[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) clean[key] = value;
      }
    };
    if (event.metricVersion === 1) clean.metricVersion = 1;
    for (const key of ['collectorIdHash'] as const) {
      const value = event[key];
      if (typeof value === 'string' && /^[a-f0-9]{12}$/.test(value)) clean[key] = value;
    }
    if (event.flushReason === 'timer' || event.flushReason === 'dispose') clean.flushReason = event.flushReason;
    if (event.flushScope === 'window' || event.flushScope === 'attribution') clean.flushScope = event.flushScope;
    addIntegers(integerKeys);
    for (const key of ['windowMs', 'elapsedMsSum', 'elapsedMsMax'] as const) {
      const value = event[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[key] = value;
    }
    const addHistogram = (key: 'charsHistogram' | 'elapsedMsHistogram' | 'startVisibilityHistogram' | 'callsHistogram', length: number): void => {
      const value = event[key];
      if (!Array.isArray(value) || value.length !== length) return;
      const histogram: number[] = [];
      for (let index = 0; index < length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return;
        const count: unknown = value[index];
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return;
        histogram.push(count);
      }
      clean[key] = histogram;
    };
    addHistogram('charsHistogram', 7);
    addHistogram('elapsedMsHistogram', 8);
    addHistogram('startVisibilityHistogram', 27);
    if (event.flushScope === 'window') {
      addIntegers(windowIntegerKeys);
      addHistogram('callsHistogram', 8);
    } else if (event.flushScope === 'attribution') {
      if (event.attributionKind === 'known' || event.attributionKind === 'overflow') clean.attributionKind = event.attributionKind;
      if (event.attributionKind === 'known') {
        if (Number.isInteger(event.attributionSlot) && event.attributionSlot! >= 1 && event.attributionSlot! <= 31) clean.attributionSlot = event.attributionSlot;
        addIntegers(attributionIntegerKeys);
        for (const key of ['tabIdHash', 'conversationIdHash'] as const) {
          const value = event[key];
          if (typeof value === 'string' && /^[a-f0-9]{12}$/.test(value)) clean[key] = value;
        }
        for (const key of ['tabIdState', 'conversationIdState'] as const) {
          if (event[key] === 'known' || event[key] === 'unknown') clean[key] = event[key];
        }
        for (const key of ['tabActive', 'documentVisible', 'domConnected'] as const) {
          if (event[key] === 'yes' || event[key] === 'no' || event[key] === 'unknown') clean[key] = event[key];
        }
        if (event.viewport === 'unknown') clean.viewport = 'unknown';
      } else if (event.attributionKind === 'overflow' && event.attributionSlot === 0) {
        clean.attributionSlot = 0;
      }
    }
    return `${JSON.stringify(clean)}\n`;
  }
}
