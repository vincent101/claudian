import type {
  AttemptToken, BindingToken, CaptureAcknowledgement, CloseToken, MetadataAdmission, MetadataPatch,
  MetadataSavePort, MetadataWriteResult, OwnerToken, RecordHandle, RecordVersions, RegisteredSaveRequest,
  RuntimeAdoptionToken, SaveAdmission, SaveAdmissionPending, SaveIntent, SaveReceipt, SaveRejectionReason,
  SaveRequestResult, SaveTicket, SaveToken, SessionSaveInput,
} from '../core/providers/types';
import type { CapturedSessionPersistence } from '../core/runtime/types';
import type { Conversation } from '../core/types';
import type {
  BindingAttempt, BindingPersistenceStatus, CloseSaveOutcome, CloseSavePlan, CommitReceipt,
  CommittedTabBinding, CoreResult, PersistableBindingState, ReservationWitness, RuntimeAdoptionReceipt,
  RuntimePersistencePort, SaveReceiptState,
} from '../features/chat/state/types';

const VERSION_MAX = Number.MAX_SAFE_INTEGER;

function versionsEqual(left: RecordVersions, right: RecordVersions): boolean {
  try {
    return right !== null && typeof right === 'object'
      && Number.isSafeInteger(right.binding) && right.binding >= 0
      && Number.isSafeInteger(right.materialization) && right.materialization >= 0
      && Number.isSafeInteger(right.turn) && right.turn >= 0
      && left.binding === right.binding && left.materialization === right.materialization && left.turn === right.turn;
  } catch { return false; }
}

/**
 * Deep copy restricted to plain JSON data: own enumerable data properties
 * only. Getters, toJSON, symbols, functions, non-plain objects and cycles are
 * never invoked or followed — they are rejected as invalid snapshots.
 */
function copyPlainJson(value: unknown, seen: Set<object>): { status: 'ok'; value: unknown } | { status: 'rejected' } {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { status: 'ok', value };
  if (typeof value === 'number') return Number.isFinite(value) ? { status: 'ok', value } : { status: 'rejected' };
  if (typeof value !== 'object' || seen.has(value)) return { status: 'rejected' };
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return { status: 'rejected' };
  seen.add(value);
  const copy: Record<string, unknown> | unknown[] = array ? [] : {};
  const keys = Reflect.ownKeys(value);
  const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : undefined;
  if (array && (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)) return { status: 'rejected' };
  for (const key of keys) {
    if (typeof key !== 'string' || key === 'toJSON') return { status: 'rejected' };
    if (array && key === 'length') continue;
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) return { status: 'rejected' };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return { status: 'rejected' };
    const nested = copyPlainJson(descriptor.value, seen);
    if (nested.status === 'rejected') return nested;
    Object.defineProperty(copy, key, { value: nested.value, enumerable: true, configurable: false, writable: false });
  }
  seen.delete(value);
  return { status: 'ok', value: Object.freeze(copy) };
}

function frozenCopy(value: unknown): { status: 'ok'; value: unknown } | { status: 'rejected'; error?: unknown } {
  try { return copyPlainJson(value, new Set()); }
  catch (error) { return { status: 'rejected', error }; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isPatch(value: unknown, check: (value: unknown) => boolean): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (value.op === 'keep' || value.op === 'delete') return keys.length === 1;
  return value.op === 'set' && keys.length === 2 && Object.hasOwn(value, 'value') && check(value.value);
}
function validMetadata(value: unknown): value is MetadataPatch {
  if (!isObject(value)) return false;
  for (const [key, patch] of Object.entries(value)) {
    let check: (item: unknown) => boolean;
    switch (key) {
      case 'hasHistory': check = item => typeof item === 'boolean'; break;
      case 'messageCount': case 'lastResponseAt': check = item => typeof item === 'number' && Number.isFinite(item); break;
      case 'preview': case 'firstUserExcerpt': case 'currentNote': case 'resumeAtMessageId':
        check = item => typeof item === 'string'; break;
      case 'externalContextPaths': case 'enabledMcpServers':
        check = item => Array.isArray(item) && item.every(part => typeof part === 'string'); break;
      case 'usage': check = item => isObject(item)
        && ['inputTokens', 'contextWindow', 'contextTokens', 'percentage']
          .every(field => typeof item[field] === 'number' && Number.isFinite(item[field]))
        && ['cacheCreationInputTokens', 'cacheReadInputTokens']
          .every(field => !Object.hasOwn(item, field) || (typeof item[field] === 'number' && Number.isFinite(item[field])))
        && (!Object.hasOwn(item, 'model') || typeof item.model === 'string')
        && (!Object.hasOwn(item, 'contextWindowIsAuthoritative') || typeof item.contextWindowIsAuthoritative === 'boolean'); break;
      default: return false;
    }
    if (!isPatch(patch, check)) return false;
  }
  return true;
}
function validBindingState(value: unknown): value is PersistableBindingState {
  if (!isObject(value) || Object.keys(value).length !== 2 || !validMetadata(value.metadata) || !isObject(value.sessionSeed)) return false;
  const seed = value.sessionSeed;
  if (Object.keys(seed).length !== 2 || !isPatch(seed.sessionId, item => item === null || typeof item === 'string') || !isObject(seed.providerFields)) return false;
  return Object.values(seed.providerFields).every(patch => isPatch(patch, () => true));
}

interface RecordState {
  handle: RecordHandle;
  versions: RecordVersions;
  active: boolean;
}

interface OwnerState {
  token: OwnerToken;
  managerIdentity: object;
  tabIdentity: object;
  open: boolean;
  currentBinding: BindingState | null;
  attempt: AttemptState | null;
  closePlan: CloseState | null;
  flights: Set<FlightState>;
}

interface AttemptState {
  token: AttemptToken;
  owner: OwnerState;
  record: RecordState;
  expectedRecordVersions: RecordVersions;
  outgoing: BindingToken | null;
  reservation: ReservationWitness;
  active: boolean;
}

interface BindingState {
  token: BindingToken;
  owner: OwnerState;
  record: RecordState;
  recordVersions: RecordVersions;
  attemptToken: BindingAttempt['token'];
  state: PersistableBindingState;
  dirtyRevision: number;
  confirmedDirtyRevision: number;
  phase: 'current' | 'sealing-outgoing' | 'sealed-outgoing' | 'superseded';
  outgoingFlight: FlightState | null;
  outgoingTicket: SaveTicket | null;
  adoption: AdoptionState | null;
}

interface AdoptionState {
  token: RuntimeAdoptionToken;
  binding: BindingState;
  runtime: RuntimePersistencePort;
  phase: 'adopting' | 'adopted' | 'failed' | 'superseded';
  error: unknown;
}

/** One synchronous admission pipeline instance. Phase covers the whole pipeline. */
interface FlightState {
  token: SaveToken;
  owner: OwnerState;
  binding: BindingState | null;
  attempt: AttemptState | null;
  capturedDirtyRevision: number | null;
  capturedVersions: RecordVersions;
  capturedAdoption: AdoptionState | null;
  reason: 'normal' | 'outgoing' | 'final' | 'backfill';
  phase: 'capturing' | 'dispatching' | 'accepted' | 'rejected';
  metadata: MetadataPatch | null;
  session: SessionSaveInput | null;
  capture: CapturedSessionPersistence | null;
  pending: SaveAdmissionPending | null;
  settled: SaveAdmission | null;
  ticket: SaveTicket | null;
  durability: Promise<SaveReceipt> | null;
  receipt: SaveReceipt | null;
  captureAcknowledgement: CaptureAcknowledgement;
  releaseRequestedBy: AttemptToken | null;
  error: unknown;
}

interface CloseState {
  token: CloseToken;
  owner: OwnerState;
  plan: CloseSavePlan;
  waitTokens: SaveToken[];
}

export class ConversationHistoryCoordinator {
  private readonly metadata: MetadataSavePort;
  private readonly recordByObject = new WeakMap<Conversation, RecordState>();
  private readonly recordById = new Map<string, RecordState>();
  private readonly recordsWithToken = new WeakMap<object, RecordState>();
  private readonly ownersWithToken = new WeakMap<object, OwnerState>();
  private readonly ownersByPair = new WeakMap<object, WeakMap<object, OwnerState>>();
  private readonly attemptsWithToken = new WeakMap<object, AttemptState>();
  private readonly bindingsWithToken = new WeakMap<object, BindingState>();
  private readonly adoptionsWithToken = new WeakMap<object, AdoptionState>();
  private readonly flightsWithToken = new WeakMap<object, FlightState>();
  private readonly settledSaves = new WeakMap<object, { ticket: SaveTicket; receipt: SaveReceipt; captureAcknowledgement: CaptureAcknowledgement }>();

  constructor(deps: { metadata: MetadataSavePort }) { this.metadata = deps.metadata; }

  registerRecord(record: Conversation): CoreResult<RecordHandle> {
    const existing = this.recordByObject.get(record);
    if (existing) return { status: 'ok', value: existing.handle };
    const prior = this.recordById.get(record.id);
    if (prior && prior.active) return { status: 'rejected', reason: 'stale-record' };
    const token = Object.freeze({}) as RecordHandle['token'];
    const handle: RecordHandle = Object.freeze({ id: record.id, providerId: record.providerId, token });
    const state: RecordState = { handle, versions: Object.freeze({ binding: 0, materialization: 0, turn: 0 }), active: true };
    this.recordByObject.set(record, state);
    this.recordById.set(record.id, state);
    this.recordsWithToken.set(token, state);
    return { status: 'ok', value: handle };
  }

  private recordByHandle(record: RecordHandle): RecordState | undefined {
    const state = this.recordsWithToken.get(record.token);
    return state && state.handle.id === record.id && state.handle.providerId === record.providerId ? state : undefined;
  }

  retireRecord(record: RecordHandle): CoreResult<void> {
    const state = this.recordByHandle(record);
    if (!state) return { status: 'rejected', reason: 'unknown-token' };
    state.active = false;
    if (this.recordById.get(state.handle.id) === state) this.recordById.delete(state.handle.id);
    return { status: 'ok', value: undefined };
  }

  registerOwner(managerIdentity: object, tabIdentity: object): CoreResult<OwnerToken> {
    let tabs = this.ownersByPair.get(managerIdentity);
    const existing = tabs?.get(tabIdentity);
    if (existing) {
      if (!existing.open) return { status: 'rejected', reason: 'owner-retiring' };
      return { status: 'ok', value: existing.token };
    }
    if (!tabs) { tabs = new WeakMap(); this.ownersByPair.set(managerIdentity, tabs); }
    const token = Object.freeze({}) as OwnerToken;
    const state: OwnerState = { token, managerIdentity, tabIdentity, open: true, currentBinding: null, attempt: null, closePlan: null, flights: new Set() };
    this.ownersWithToken.set(token, state);
    tabs.set(tabIdentity, state);
    return { status: 'ok', value: token };
  }

  readRecordVersions(record: RecordHandle): CoreResult<RecordVersions> {
    const state = this.recordByHandle(record);
    if (!state || !state.active) return { status: 'rejected', reason: 'record-retired' };
    return { status: 'ok', value: state.versions };
  }

  advanceRecordVersions(input: {
    record: RecordHandle; expected: RecordVersions; changed: readonly ('binding' | 'materialization' | 'turn')[];
  }): CoreResult<RecordVersions> {
    const state = this.recordByHandle(input.record);
    if (!state || !state.active) return { status: 'rejected', reason: 'record-retired' };
    if (!versionsEqual(state.versions, input.expected)) return { status: 'rejected', reason: 'version-mismatch' };
    const fields = Array.from(new Set(input.changed));
    for (const field of fields) {
      if (!['binding', 'materialization', 'turn'].includes(field) || state.versions[field] === VERSION_MAX) return { status: 'rejected', reason: 'version-mismatch' };
    }
    for (const field of fields) state.versions = Object.freeze({ ...state.versions, [field]: state.versions[field] + 1 });
    return { status: 'ok', value: state.versions };
  }

  private bindingByReceipt(receipt: CommitReceipt): BindingState | null {
    const state = this.bindingsWithToken.get(receipt.token);
    if (!state) return null;
    if (state.owner.token !== receipt.owner || state.record.handle !== receipt.record
      || state.attemptToken !== receipt.attempt || !versionsEqual(state.recordVersions, receipt.recordVersions)) return null;
    return state;
  }

  beginBindingAttempt(input: {
    owner: OwnerToken; record: RecordHandle; expectedRecordVersions: RecordVersions; reservation: ReservationWitness;
  }): CoreResult<BindingAttempt> {
    const owner = this.ownersWithToken.get(input.owner);
    if (!owner) return { status: 'rejected', reason: 'unknown-token' };
    if (!owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    const record = this.recordByHandle(input.record);
    if (!record) return { status: 'rejected', reason: 'unknown-token' };
    if (!record.active) return { status: 'rejected', reason: 'record-retired' };
    const originalBinding = owner.currentBinding;
    const predecessor = owner.attempt;
    const expectedVersions = record.versions;
    const reservation = input.reservation;
    if (!versionsEqual(expectedVersions, input.expectedRecordVersions)) return { status: 'rejected', reason: 'version-mismatch' };
    if (!reservation.owns()) return { status: 'rejected', reason: 'reservation-lost' };
    if (!owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    if (owner.currentBinding !== originalBinding) return { status: 'rejected', reason: 'stale-binding' };
    if (owner.attempt !== predecessor) return { status: 'rejected', reason: 'stale-attempt' };
    if (!record.active) return { status: 'rejected', reason: 'record-retired' };
    if (record.versions !== expectedVersions) return { status: 'rejected', reason: 'version-mismatch' };
    const token = Object.freeze({}) as BindingAttempt['token'];
    const outgoing = originalBinding?.token ?? null;
    const attempt: AttemptState = { token, owner, record, expectedRecordVersions: expectedVersions,
      outgoing, reservation, active: true };
    if (predecessor) predecessor.active = false;
    owner.attempt = attempt;
    this.attemptsWithToken.set(token, attempt);
    return { status: 'ok', value: Object.freeze({ token, owner: owner.token, record: record.handle,
      expectedRecordVersions: expectedVersions, outgoing }) };
  }

  private attemptByReceipt(attempt: BindingAttempt): AttemptState | undefined {
    const state = this.attemptsWithToken.get(attempt.token);
    if (!state || state.owner.token !== attempt.owner || state.record.handle !== attempt.record
      || state.outgoing !== attempt.outgoing || !versionsEqual(state.expectedRecordVersions, attempt.expectedRecordVersions)) return undefined;
    return state;
  }

  cancelBindingAttempt(attempt: BindingAttempt): CoreResult<void> {
    const state = this.attemptByReceipt(attempt);
    if (!state) return { status: 'rejected', reason: 'unknown-token' };
    if (!state.active || state.owner.attempt !== state) return { status: 'rejected', reason: 'stale-attempt' };
    state.active = false;
    state.owner.attempt = null;
    const outgoing = state.outgoing ? this.bindingsWithToken.get(state.outgoing) ?? null : null;
    if (outgoing?.outgoingFlight) {
      const flight = outgoing.outgoingFlight;
      flight.releaseRequestedBy = state.token;
      this.releaseOutgoingFence(flight);
    }
    return { status: 'ok', value: undefined };
  }

  commitPreparedBinding(input: { attempt: BindingAttempt; state: PersistableBindingState }): CoreResult<CommitReceipt> {
    const attemptState = this.attemptByReceipt(input.attempt);
    if (!attemptState) return { status: 'rejected', reason: 'unknown-token' };
    if (!attemptState.active) return { status: 'rejected', reason: 'stale-attempt' };
    const snapshot = this.snapshotBindingState(input.state);
    if (snapshot.status === 'rejected') return { status: 'rejected', reason: 'invalid-snapshot', error: snapshot.error };
    const owner = attemptState.owner;
    if (!attemptState.active || owner.attempt !== attemptState) return { status: 'rejected', reason: 'stale-attempt' };
    if (!owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    const record = attemptState.record;
    if (!record.active) return { status: 'rejected', reason: 'record-retired' };
    if (!versionsEqual(record.versions, attemptState.expectedRecordVersions)) return { status: 'rejected', reason: 'version-mismatch' };
    const outgoing = attemptState.outgoing ? this.bindingsWithToken.get(attemptState.outgoing) ?? null : null;
    if (owner.currentBinding !== outgoing) return { status: 'rejected', reason: 'outgoing-not-written' };
    const originalFlight = outgoing?.outgoingFlight ?? null;
    const originalTicket = outgoing?.outgoingTicket ?? null;
    if (!attemptState.reservation.owns()) return { status: 'rejected', reason: 'reservation-lost' };
    if (!attemptState.active || owner.attempt !== attemptState) return { status: 'rejected', reason: 'stale-attempt' };
    if (!owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    if (!record.active) return { status: 'rejected', reason: 'record-retired' };
    if (!versionsEqual(record.versions, attemptState.expectedRecordVersions)) return { status: 'rejected', reason: 'version-mismatch' };
    if (owner.currentBinding !== outgoing) return { status: 'rejected', reason: 'outgoing-not-written' };
    if (outgoing) {
      if (outgoing.phase !== 'sealed-outgoing' || !originalFlight || !originalTicket
        || outgoing.outgoingFlight !== originalFlight || outgoing.outgoingTicket !== originalTicket || originalFlight.ticket !== originalTicket) {
        return { status: 'rejected', reason: 'outgoing-not-written' };
      }
      const save = this.settledSaves.get(originalTicket.token);
      if (!save || save.ticket !== originalTicket || save.receipt.status !== 'written') return { status: 'rejected', reason: 'outgoing-not-written' };
    }
    const token = Object.freeze({}) as CommitReceipt['token'];
    const binding: BindingState = { token, owner, record, recordVersions: record.versions, attemptToken: attemptState.token,
      state: snapshot.value as PersistableBindingState, dirtyRevision: 0, confirmedDirtyRevision: 0,
      phase: 'current', outgoingFlight: null, outgoingTicket: null, adoption: null };
    if (owner.currentBinding) owner.currentBinding.phase = 'superseded';
    owner.currentBinding = binding;
    attemptState.active = false;
    if (owner.attempt === attemptState) owner.attempt = null;
    this.bindingsWithToken.set(token, binding);
    return { status: 'ok', value: Object.freeze({ token, attempt: attemptState.token, owner: owner.token,
      record: record.handle, recordVersions: record.versions }) };
  }

  private snapshotBindingState(state: PersistableBindingState): { status: 'ok'; value: PersistableBindingState } | { status: 'rejected'; error?: unknown } {
    const snapshot = frozenCopy(state);
    if (snapshot.status === 'rejected') return snapshot;
    return validBindingState(snapshot.value) ? { status: 'ok', value: snapshot.value } : { status: 'rejected' };
  }

  readBinding(binding: CommitReceipt): CoreResult<CommittedTabBinding> {
    const state = this.bindingByReceipt(binding);
    if (!state) return { status: 'rejected', reason: 'unknown-token' };
    return { status: 'ok', value: { token: state.token, owner: state.owner.token, record: state.record.handle,
      recordVersions: state.recordVersions, dirtyRevision: state.dirtyRevision, state: state.state } };
  }

  updatePersistableBinding(input: {
    binding: CommitReceipt; expectedDirtyRevision: number; state: PersistableBindingState;
  }): CoreResult<CommittedTabBinding> {
    const binding = this.bindingByReceipt(input.binding);
    if (!binding) return { status: 'rejected', reason: 'unknown-token' };
    if (!binding.owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    if (binding !== binding.owner.currentBinding) return { status: 'rejected', reason: 'stale-binding' };
    if (binding.phase === 'sealing-outgoing' || binding.phase === 'sealed-outgoing') return { status: 'rejected', reason: 'binding-sealed' };
    if (binding.dirtyRevision !== input.expectedDirtyRevision || binding.dirtyRevision === VERSION_MAX) return { status: 'rejected', reason: 'version-mismatch' };
    const snapshot = this.snapshotBindingState(input.state);
    if (snapshot.status === 'rejected') return { status: 'rejected', reason: 'invalid-snapshot', error: snapshot.error };
    if (!binding.owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    if (binding !== binding.owner.currentBinding) return { status: 'rejected', reason: 'stale-binding' };
    if (binding.phase !== 'current') return { status: 'rejected', reason: 'binding-sealed' };
    if (binding.dirtyRevision !== input.expectedDirtyRevision) return { status: 'rejected', reason: 'version-mismatch' };
    binding.state = snapshot.value;
    binding.dirtyRevision += 1;
    return { status: 'ok', value: { token: binding.token, owner: binding.owner.token, record: binding.record.handle,
      recordVersions: binding.recordVersions, dirtyRevision: binding.dirtyRevision, state: binding.state } };
  }

  readPersistenceStatus(binding: CommitReceipt): CoreResult<BindingPersistenceStatus> {
    const state = this.bindingByReceipt(binding);
    if (!state) return { status: 'rejected', reason: 'unknown-token' };
    return { status: 'ok', value: { dirtyRevision: state.dirtyRevision,
      confirmedDirtyRevision: state.confirmedDirtyRevision,
      dirty: state.dirtyRevision > state.confirmedDirtyRevision } };
  }

  beginRuntimeAdoption(input: { binding: CommitReceipt; runtime: RuntimePersistencePort }): CoreResult<RuntimeAdoptionReceipt> {
    const binding = this.bindingByReceipt(input.binding);
    if (!binding) return { status: 'rejected', reason: 'unknown-token' };
    if (!binding.owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    if (binding !== binding.owner.currentBinding) return { status: 'rejected', reason: 'stale-binding' };
    if (binding.phase === 'sealing-outgoing' || binding.phase === 'sealed-outgoing') return { status: 'rejected', reason: 'binding-sealed' };
    if (input.runtime.providerId !== binding.record.handle.providerId) return { status: 'rejected', reason: 'provider-mismatch' };
    if (binding.adoption) binding.adoption.phase = 'superseded';
    const token = Object.freeze({}) as RuntimeAdoptionToken;
    const adoption: AdoptionState = { token, binding, runtime: input.runtime, phase: 'adopting', error: undefined };
    binding.adoption = adoption;
    this.adoptionsWithToken.set(token, adoption);
    return { status: 'ok', value: { token, owner: binding.owner.token, binding: binding.token } };
  }

  completeRuntimeAdoption(adoption: RuntimeAdoptionReceipt): CoreResult<void> {
    const state = this.adoptionsWithToken.get(adoption.token);
    if (!state || state.binding.owner.token !== adoption.owner || state.binding.token !== adoption.binding) {
      return { status: 'rejected', reason: 'unknown-token' };
    }
    if (state.phase !== 'adopting' || !state.binding.owner.open || state.binding.adoption !== state
      || state.binding !== state.binding.owner.currentBinding) {
      return { status: 'rejected', reason: 'stale-binding' };
    }
    state.phase = 'adopted';
    return { status: 'ok', value: undefined };
  }

  failRuntimeAdoption(adoption: RuntimeAdoptionReceipt, error: unknown): CoreResult<void> {
    const state = this.adoptionsWithToken.get(adoption.token);
    if (!state || state.binding.owner.token !== adoption.owner || state.binding.token !== adoption.binding) {
      return { status: 'rejected', reason: 'unknown-token' };
    }
    if (state.phase !== 'adopting' || !state.binding.owner.open || state.binding.adoption !== state
      || state.binding !== state.binding.owner.currentBinding) {
      return { status: 'rejected', reason: 'stale-binding' };
    }
    state.phase = 'failed';
    state.error = error;
    return { status: 'ok', value: undefined };
  }

  // -- admission pipeline ---------------------------------------------------

  private newFlight(input: {
    owner: OwnerState; binding: BindingState | null; attempt: AttemptState | null;
    reason: FlightState['reason'];
  }): FlightState {
    const token = Object.freeze({}) as SaveToken;
    const flight: FlightState = { token, owner: input.owner, binding: input.binding, attempt: input.attempt,
      capturedDirtyRevision: input.binding?.dirtyRevision ?? null,
      capturedVersions: input.binding?.record.versions ?? input.attempt!.expectedRecordVersions,
      capturedAdoption: input.binding?.adoption ?? null,
      reason: input.reason, phase: 'capturing', metadata: null, session: null, capture: null,
      pending: null, settled: null, ticket: null, durability: null, receipt: null, captureAcknowledgement: { status: 'not-needed' },
      releaseRequestedBy: null, error: undefined };
    this.flightsWithToken.set(token, flight);
    input.owner.flights.add(flight);
    this.pendingOf(flight);
    return flight;
  }

  private pendingOf(flight: FlightState): SaveAdmissionPending {
    if (flight.pending) return flight.pending;
    const pending: SaveAdmissionPending = Object.freeze({ status: 'admitting', token: flight.token,
      settlement: new Promise<SaveAdmission>(resolve => { settleHooks.set(flight.token, resolve); }) });
    flight.pending = pending;
    return pending;
  }

  private activeFenceConsumer(flight: FlightState): boolean {
    const binding = flight.binding;
    const attempt = flight.owner.attempt;
    return !!binding && !!attempt && attempt.active && attempt.owner === flight.owner && attempt.outgoing === binding.token;
  }

  private releaseOutgoingFence(flight: FlightState): void {
    const binding = flight.binding;
    if (!binding || flight.reason !== 'outgoing' || !flight.releaseRequestedBy || !flight.settled
      || !flight.owner.open || flight.owner.currentBinding !== binding || binding.outgoingFlight !== flight
      || this.activeFenceConsumer(flight)) return;
    if (binding.phase === 'sealed-outgoing' || binding.phase === 'sealing-outgoing') binding.phase = 'current';
    binding.outgoingFlight = null;
    binding.outgoingTicket = null;
    flight.releaseRequestedBy = null;
  }

  private settleFlight(flight: FlightState, admission: SaveAdmission): void {
    flight.settled = admission;
    this.releaseOutgoingFence(flight);
    const hook = settleHooks.get(flight.token);
    if (hook) { settleHooks.delete(flight.token); hook(admission); }
  }

  /** Capture + validate + dispatch; every entry gate ran before calling. */
  private runFlight(flight: FlightState, metadataSource: MetadataPatch): SaveRequestResult {
    const binding = flight.binding;
    const failure = this.revalidate(flight);
    if (failure) return this.failFlight(flight, failure.reason, failure.error);
    const session = this.captureSession(flight);
    if ('reason' in session) return this.failFlight(flight, session.reason, session.error);
    const snapshot = frozenCopy(metadataSource);
    if (snapshot.status === 'rejected') return this.failFlight(flight, 'invalid-snapshot', snapshot.error);
    if (!validMetadata(snapshot.value)) return this.failFlight(flight, 'invalid-snapshot');
    flight.metadata = snapshot.value;
    flight.session = session.value;
    flight.capture = session.value.kind === 'runtime' ? session.value.capture : null;
    const failureAfter = this.revalidate(flight);
    if (failureAfter) return this.failFlight(flight, failureAfter.reason, failureAfter.error);
    if (flight.reason === 'outgoing' && binding) binding.phase = 'sealing-outgoing';
    flight.phase = 'dispatching';
    return this.dispatchFlight(flight);
  }

  private revalidate(flight: FlightState): { reason: SaveRejectionReason; error?: unknown } | null {
    if (!flight.owner.open && flight.reason !== 'final') return { reason: 'owner-retiring' };
    if (flight.attempt) {
      if (!flight.attempt.active) return { reason: 'stale-attempt' };
      if (!flight.attempt.record.active) return { reason: 'record-retired' };
      try {
        if (!flight.attempt.reservation.owns()) return { reason: 'reservation-lost' };
      } catch (error) {
        return { reason: 'reservation-lost', error };
      }
      if (!flight.owner.open) return { reason: 'owner-retiring' };
      if (!flight.attempt.active) return { reason: 'stale-attempt' };
      if (!flight.attempt.record.active) return { reason: 'record-retired' };
      if (!versionsEqual(flight.attempt.record.versions, flight.attempt.expectedRecordVersions)) return { reason: 'version-mismatch' };
      return null;
    }
    const binding = flight.binding!;
    if (binding !== binding.owner.currentBinding || binding.adoption !== flight.capturedAdoption) return { reason: 'stale-binding' };
    if (binding.phase !== 'current') return { reason: 'binding-sealed' };
    if (!binding.record.active) return { reason: 'record-retired' };
    if (binding.dirtyRevision !== flight.capturedDirtyRevision || !versionsEqual(binding.record.versions, flight.capturedVersions)) {
      return { reason: 'version-mismatch' };
    }
    return null;
  }

  private captureSession(flight: FlightState):
    { status: 'ok'; value: SessionSaveInput } | { status: 'rejected'; reason: SaveRejectionReason; error?: unknown } {
    const binding = flight.binding!;
    const adoption = flight.capturedAdoption;
    if (adoption && adoption.phase === 'adopted') {
      let raw: CapturedSessionPersistence;
      try {
        raw = adoption.runtime.captureSessionPersistence();
      } catch (error) {
        return { status: 'rejected', reason: 'runtime-capture-failed', error };
      }
      const snapshot = frozenCopy(raw);
      if (snapshot.status === 'rejected') return { status: 'rejected', reason: 'invalid-snapshot', error: snapshot.error };
      const data = snapshot.value;
      if (!isObject(data) || Object.keys(data).length !== 4 || data.protocolVersion !== 1 || !isObject(data.facts)
        || !isObject(data.invalidation) || Object.keys(data.invalidation).length !== 2
        || !Number.isSafeInteger(data.invalidation.revision) || (data.invalidation.revision as number) < 0
        || typeof data.invalidation.invalidated !== 'boolean') return { status: 'rejected', reason: 'invalid-snapshot' };
      if (data.providerId !== binding.record.handle.providerId) return { status: 'rejected', reason: 'provider-mismatch' };
      return { status: 'ok', value: Object.freeze({ kind: 'runtime', capture: data as unknown as CapturedSessionPersistence }) };
    }
    return { status: 'ok', value: Object.freeze({ kind: 'seed', patch: binding.state.sessionSeed }) };
  }

  private dispatchFlight(flight: FlightState): SaveRequestResult {
    const intent = this.buildIntent(flight);
    let admission: MetadataAdmission;
    try {
      admission = this.metadata.admit(intent);
    } catch (error) {
      return this.failFlight(flight, 'storage-admission-failed', error);
    }
    if (admission.status === 'rejected') return this.failFlight(flight, 'storage-rejected');
    const ticket: SaveTicket = Object.freeze({ token: flight.token, record: flight.binding?.record.handle ?? flight.attempt!.record.handle,
      owner: flight.owner.token, binding: flight.binding ? flight.binding.token : null,
      dirtyRevision: flight.capturedDirtyRevision,
      reason: flight.reason, sequence: admission.sequence });
    const durability = admission.completion.then(result => {
      let receipt: SaveReceipt;
      try {
        receipt = this.makeReceipt(ticket, result);
      } catch (error) {
        receipt = Object.freeze({ ticket, status: 'failed', stage: 'unknown' as const, error });
      }
      this.applyWritten(ticket, receipt);
      this.recordSettlement(flight, receipt);
      if (receipt.status === 'failed') throw receipt.error;
      return receipt;
    }, error => {
      const receipt = this.makeReceipt(ticket, { status: 'failed', stage: 'unknown', error });
      this.applyWritten(ticket, receipt);
      this.recordSettlement(flight, receipt);
      throw error;
    });
    void durability.catch(() => undefined);
    flight.ticket = ticket;
    flight.durability = durability;
    flight.phase = 'accepted';
    if (flight.binding && flight.reason === 'outgoing') {
      flight.binding.outgoingTicket = ticket;
      flight.binding.phase = 'sealed-outgoing';
    }
    this.acknowledgeCapture(flight);
    flight.captureAcknowledgement = Object.freeze(flight.captureAcknowledgement);
    this.releaseFlightPayload(flight);
    const admissionResult: SaveAdmission = Object.freeze({ status: 'accepted', ticket, durability,
      captureAcknowledgement: flight.captureAcknowledgement });
    this.settleFlight(flight, admissionResult);
    return admissionResult;
  }

  private acknowledgeCapture(flight: FlightState): void {
    const binding = flight.binding;
    if (!binding || !flight.capture) return;
    const adoption = flight.capturedAdoption;
    if (!adoption) return;
    try {
      adoption.runtime.acknowledgeSessionPersistenceCapture(flight.capture);
      flight.captureAcknowledgement = { status: 'acknowledged' };
    } catch (error) {
      flight.captureAcknowledgement = { status: 'failed', error };
    }
  }

  private releaseFlightPayload(flight: FlightState): void {
    flight.metadata = null;
    flight.session = null;
    flight.capture = null;
    flight.capturedAdoption = null;
  }

  private recordSettlement(flight: FlightState, receipt: SaveReceipt): void {
    flight.receipt = receipt;
    flight.owner.flights.delete(flight);
    this.settledSaves.set(flight.token, { ticket: receipt.ticket, receipt, captureAcknowledgement: flight.captureAcknowledgement });
    this.flightsWithToken.delete(flight.token);
  }

  private makeReceipt(ticket: SaveTicket, result: MetadataWriteResult): SaveReceipt {
    switch (result.status) {
      case 'written': return Object.freeze({ ticket, status: 'written', confirmedRevision: result.confirmedRevision });
      case 'skipped': return Object.freeze({ ticket, status: 'skipped', reason: result.reason });
      case 'conflict': return Object.freeze({ ticket, status: 'conflict', reason: result.reason });
      case 'failed': return Object.freeze({ ticket, status: 'failed', stage: result.stage, error: result.error });
      default: throw new Error('Unknown metadata write status');
    }
  }

  private applyWritten(ticket: SaveTicket, receipt: SaveReceipt): void {
    if (receipt.status !== 'written' || !ticket.binding) return;
    const binding = this.bindingsWithToken.get(ticket.binding);
    if (!binding || binding !== binding.owner.currentBinding) return;
    if (binding.dirtyRevision !== ticket.dirtyRevision) return;
    binding.confirmedDirtyRevision = Math.max(binding.confirmedDirtyRevision, ticket.dirtyRevision ?? 0);
  }

  private failFlight(flight: FlightState, reason: SaveRejectionReason, error?: unknown): SaveAdmission {
    flight.phase = 'rejected';
    flight.owner.flights.delete(flight);
    flight.error = error;
    this.releaseFlightPayload(flight);
    const admission: SaveAdmission = Object.freeze({ status: 'rejected', reason,
      ...(error === undefined ? {} : { error }) });
    this.settleFlight(flight, admission);
    if (flight.binding && flight.reason === 'outgoing') {
      if (flight.binding === flight.binding.owner.currentBinding && flight.binding.owner.open
        && flight.binding.outgoingFlight === flight && flight.binding.phase === 'sealing-outgoing') flight.binding.phase = 'current';
    }
    return admission;
  }

  private buildIntent(flight: FlightState): SaveIntent {
    const owner = flight.owner;
    const record = flight.binding ? flight.binding.record.handle : flight.attempt!.record.handle;
    const versions = flight.capturedVersions;
    if (flight.reason === 'backfill') {
      return Object.freeze({ token: flight.token, record, expectedRecordVersions: versions, owner: owner.token,
        metadata: flight.metadata, reason: 'backfill', binding: null, dirtyRevision: null,
        session: Object.freeze({ kind: 'none' }) }) as never;
    }
    const binding = flight.binding!;
    return Object.freeze({ token: flight.token, record, expectedRecordVersions: versions, owner: owner.token,
      metadata: flight.metadata, reason: flight.reason, binding: binding.token,
      dirtyRevision: flight.capturedDirtyRevision, session: flight.session }) as never;
  }

  // -- public admission entry points ---------------------------------------

  admitSave(input: { binding: CommitReceipt }): SaveAdmission {
    const binding = this.bindingByReceipt(input.binding);
    if (!binding) return { status: 'rejected', reason: 'unknown-token' };
    const owner = binding.owner;
    if (!owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    if (binding !== owner.currentBinding) return { status: 'rejected', reason: 'stale-binding' };
    if (binding.phase === 'sealing-outgoing' || binding.phase === 'sealed-outgoing') {
      return { status: 'rejected', reason: 'binding-sealed' };
    }
    if (!binding.record.active) return { status: 'rejected', reason: 'record-retired' };
    const flight = this.newFlight({ owner, binding, attempt: null, reason: 'normal' });
    return this.runFlight(flight, binding.state.metadata) as SaveAdmission;
  }

  sealOutgoing(binding: CommitReceipt): SaveRequestResult {
    const state = this.bindingByReceipt(binding);
    if (!state) return { status: 'rejected', reason: 'unknown-token' };
    const owner = state.owner;
    if (state.outgoingFlight) {
      const flight = state.outgoingFlight;
      if (flight.settled) return flight.settled;
      return this.pendingOf(flight);
    }
    if (!owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    if (state !== owner.currentBinding) return { status: 'rejected', reason: 'stale-binding' };
    if (!state.record.active) return { status: 'rejected', reason: 'record-retired' };
    const flight = this.newFlight({ owner, binding: state, attempt: null, reason: 'outgoing' });
    state.outgoingFlight = flight;
    return this.runFlight(flight, state.state.metadata);
  }

  admitRecordDelta(input: { attempt: BindingAttempt; metadata: MetadataPatch }): SaveAdmission {
    const attempt = this.attemptByReceipt(input.attempt);
    if (!attempt) return { status: 'rejected', reason: 'unknown-token' };
    if (!attempt.active) return { status: 'rejected', reason: 'stale-attempt' };
    const owner = attempt.owner;
    if (!owner.open) return { status: 'rejected', reason: 'owner-retiring' };
    if (!attempt.record.active) return { status: 'rejected', reason: 'record-retired' };
    if (!attempt.reservation.owns()) return { status: 'rejected', reason: 'reservation-lost' };
    if (!versionsEqual(attempt.record.versions, attempt.expectedRecordVersions)) {
      return { status: 'rejected', reason: 'version-mismatch' };
    }
    const flight = this.newFlight({ owner, binding: null, attempt, reason: 'backfill' });
    const snapshot = frozenCopy(input.metadata);
    if (snapshot.status === 'rejected') return this.failFlight(flight, 'invalid-snapshot', snapshot.error);
    if (!validMetadata(snapshot.value)) return this.failFlight(flight, 'invalid-snapshot');
    const failure = this.revalidate(flight);
    if (failure) return this.failFlight(flight, failure.reason, failure.error);
    flight.metadata = snapshot.value;
    flight.session = Object.freeze({ kind: 'none' });
    flight.phase = 'dispatching';
    return this.dispatchFlight(flight) as SaveAdmission;
  }

  // -- close ------------------------------------------------------------------

  sealForClose(owner: OwnerToken): CoreResult<CloseSavePlan> {
    const ownerState = this.ownersWithToken.get(owner);
    if (!ownerState) return { status: 'rejected', reason: 'unknown-token' };
    if (ownerState.closePlan) return { status: 'ok', value: ownerState.closePlan.plan };
    ownerState.open = false;
    if (ownerState.attempt) ownerState.attempt.active = false;
    const token = Object.freeze({}) as CloseSavePlan['token'];
    const accepted: SaveTicket[] = [];
    const pending: SaveAdmissionPending[] = [];
    const waitTokens: SaveToken[] = [];
    for (const flight of ownerState.flights) {
      if (flight.phase === 'accepted') {
        accepted.push(flight.ticket!);
        waitTokens.push(flight.token);
      } else if (flight.phase === 'capturing' || flight.phase === 'dispatching') {
        pending.push(this.pendingOf(flight));
        waitTokens.push(flight.token);
      }
    }
    const binding = ownerState.currentBinding;
    let finalFlight: FlightState | null = null;
    if (binding && binding.phase === 'current') {
      finalFlight = this.newFlight({ owner: ownerState, binding, attempt: null, reason: 'final' });
      waitTokens.push(finalFlight.token);
    }
    const finals: RegisteredSaveRequest[] = finalFlight ? [this.pendingOf(finalFlight)] : [];
    if (!finalFlight && binding?.outgoingFlight) {
      const outgoing = binding.outgoingFlight;
      if (outgoing.phase === 'dispatching' || (outgoing.phase === 'accepted' && !outgoing.settled)) finals.push(this.pendingOf(outgoing));
      else if (outgoing.phase === 'accepted' && outgoing.settled?.status === 'accepted') {
        finals.push(outgoing.settled);
        if (!waitTokens.includes(outgoing.token)) waitTokens.push(outgoing.token);
      }
    }
    const pendingAtSeal = Object.freeze(pending);
    const finalAdmissions = Object.freeze(finals);
    const close: CloseState = { token, owner: ownerState, waitTokens, plan: null as never };
    let resolveCompletion!: (value: readonly CloseSaveOutcome[]) => void;
    const completion = new Promise<readonly CloseSaveOutcome[]>(done => { resolveCompletion = done; });
    close.plan = Object.freeze({ token, owner, acceptedAtSeal: Object.freeze(accepted),
      pendingAtSeal, finalAdmissions, completion });
    ownerState.closePlan = close;
    this.resolveClose(close, resolveCompletion, finalFlight);
    return { status: 'ok', value: close.plan };
  }

  private resolveClose(close: CloseState, resolveCompletion: (value: readonly CloseSaveOutcome[]) => void, finalFlight: FlightState | null): void {
    if (finalFlight) this.runFlight(finalFlight, finalFlight.binding!.state.metadata);
    const waiting = close.waitTokens.map(saveToken => {
      const flight = this.flightsWithToken.get(saveToken);
      if (!flight) {
        const settled = this.settledSaves.get(saveToken);
        if (!settled) return Promise.resolve(null);
        return Promise.resolve(Object.freeze({ status: 'settled', receipt: settled.receipt,
          captureAcknowledgement: settled.captureAcknowledgement }) as CloseSaveOutcome);
      }
      if (flight.phase === 'accepted' && flight.durability) {
        return flight.durability.then(receipt => this.outcomeFor(flight, receipt), () => this.outcomeFor(flight, null));
      }
      const settlement = flight.pending ? flight.pending.settlement : Promise.resolve(flight.settled as SaveAdmission);
      return settlement.then(admission => {
        if (!admission) return this.outcomeFor(flight, null);
        if (admission.status === 'rejected') {
          return Object.freeze({ status: 'not-admitted', token: flight.token,
            rejection: admission }) as CloseSaveOutcome;
        }
        return admission.durability.then(receipt => this.outcomeFor(flight, receipt), () => this.outcomeFor(flight, null));
      });
    });
    void Promise.all(waiting).then(outcomes => {
      resolveCompletion(Object.freeze(outcomes.filter((item): item is CloseSaveOutcome => item !== null)));
    });
  }

  private outcomeFor(flight: FlightState, receipt: SaveReceipt | null): CloseSaveOutcome {
    const finalReceipt = receipt ?? flight.receipt;
    if (!finalReceipt) {
      const settled = flight.settled;
      if (settled && settled.status === 'rejected') {
        return Object.freeze({ status: 'not-admitted', token: flight.token, rejection: settled });
      }
      throw new Error('Accepted flight has no settled receipt');
    }
    const captureAcknowledgement = flight.phase === 'accepted' ? flight.captureAcknowledgement : { status: 'not-needed' as const };
    return Object.freeze({ status: 'settled', receipt: finalReceipt, captureAcknowledgement });
  }

  snapshotAcceptedSaves(owner: OwnerToken): readonly { ticket: SaveTicket; durability: Promise<SaveReceipt> }[] {
    const ownerState = this.ownersWithToken.get(owner);
    if (!ownerState) return [];
    const result: Array<{ ticket: SaveTicket; durability: Promise<SaveReceipt> }> = [];
    for (const flight of ownerState.flights) {
      if (flight.phase !== 'accepted' || !flight.durability) continue;
      if (flight.ticket) result.push(Object.freeze({ ticket: flight.ticket, durability: flight.durability }));
    }
    return Object.freeze(result);
  }

  getSaveReceipt(ticket: SaveTicket): CoreResult<SaveReceiptState> {
    const settled = this.settledSaves.get(ticket.token);
    if (settled) {
      if (settled.ticket !== ticket) return { status: 'rejected', reason: 'unknown-token' };
      return { status: 'ok', value: Object.freeze({ status: 'settled', receipt: settled.receipt }) };
    }
    const flight = this.flightsWithToken.get(ticket.token);
    if (!flight || flight.phase !== 'accepted') return { status: 'rejected', reason: 'unknown-token' };
    if (flight.ticket !== ticket) return { status: 'rejected', reason: 'unknown-token' };
    const recorded = flight.receipt;
    if (recorded) return { status: 'ok', value: Object.freeze({ status: 'settled', receipt: recorded }) };
    return { status: 'ok', value: Object.freeze({ status: 'pending' }) };
  }
}

const settleHooks = new Map<object, (admission: SaveAdmission) => void>();
