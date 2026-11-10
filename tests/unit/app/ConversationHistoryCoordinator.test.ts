import { execFileSync } from 'node:child_process';

import { ConversationHistoryCoordinator } from '@/app/ConversationHistoryCoordinator';
import type {
  MetadataAdmission, MetadataSavePort, MetadataWriteResult, RegisteredSaveRequest, SaveAdmission, SaveIntent, SaveIntentBase, SaveRequestResult,
} from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import type {
  BindingAttempt, CommitReceipt, CoreResult, PersistableBindingState, RuntimePersistencePort,
} from '@/features/chat/state/types';
import { ConversationOpenRegistry } from '@/features/chat/tabs/ConversationOpenRegistry';

function checkAdmissionTypeContracts(base: SaveIntentBase, binding: CommitReceipt): void {
  // @ts-expect-error backfill cannot carry a seed
  const backfillSeed: SaveIntent = { ...base, reason: 'backfill', binding: null, dirtyRevision: null, session: { kind: 'seed', patch: state('A').sessionSeed } };
  // @ts-expect-error shell saves cannot have none
  const normalNone: SaveIntent = { ...base, reason: 'normal', binding: binding.token, dirtyRevision: 0, session: { kind: 'none' } };
  // @ts-expect-error every intent requires a session discriminant
  const missingSession: SaveIntent = { ...base, reason: 'backfill', binding: null, dirtyRevision: null };
  // @ts-expect-error none cannot have an inline patch
  const noneWithPatch: SaveIntent = { ...base, reason: 'backfill', binding: null, dirtyRevision: null, session: { kind: 'none', patch: state('A').sessionSeed } };
  // @ts-expect-error rejected requests cannot occur in the frozen final list
  const invalidFinal: RegisteredSaveRequest = { status: 'rejected', reason: 'unknown-token' };
  void [backfillSeed, normalNone, missingSession, noneWithPatch, invalidFinal];
}
void checkAdmissionTypeContracts;

function ok<T>(result: CoreResult<T>): T {
  if (result.status !== 'ok') throw new Error(`Unexpected rejection: ${result.reason}`);
  return result.value;
}

function accepted(result: SaveRequestResult): Extract<SaveAdmission, { status: 'accepted' }> {
  if (result.status !== 'accepted') throw new Error(`Unexpected admission status: ${result.status}`);
  return result;
}

class ControlledPort implements MetadataSavePort {
  readonly entries: Array<{ intent: SaveIntent; resolve: (result: MetadataWriteResult) => void; reject: (error: unknown) => void }> = [];
  readonly counts = new Map<string, number>();
  onAdmit?: () => void;
  rejectOnAdmit = false;
  throwOnAdmit: unknown = undefined;

  admit(intent: SaveIntent): MetadataAdmission {
    if (this.rejectOnAdmit || this.throwOnAdmit !== undefined) {
      this.onAdmit?.();
      if (this.throwOnAdmit !== undefined) throw this.throwOnAdmit;
      return { status: 'rejected', reason: 'controlled' };
    }
    const sequence = (this.counts.get(intent.record.id) ?? 0) + 1;
    this.counts.set(intent.record.id, sequence);
    let resolve!: (value: MetadataWriteResult) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<MetadataWriteResult>((done, fail) => { resolve = done; reject = fail; });
    this.entries.push({ intent, resolve, reject });
    this.onAdmit?.();
    return { status: 'accepted', sequence, completion };
  }

  finish(id: string, result: MetadataWriteResult = { status: 'written', confirmedRevision: 1 }): void {
    const entry = this.entries.find(item => item.intent.record.id === id && !finished.has(item));
    if (!entry) throw new Error(`No pending entry for ${id}`);
    finished.add(entry);
    entry.resolve(result);
  }

  failRaw(id: string, error: unknown): void {
    const entry = this.entries.find(item => item.intent.record.id === id && !finished.has(item));
    if (!entry) throw new Error(`No pending entry for ${id}`);
    finished.add(entry);
    entry.reject(error);
  }
}
const finished = new WeakSet<object>();

function conversation(id: string): Conversation {
  return { id, providerId: 'claude', title: id, createdAt: 0, updatedAt: 0, sessionId: null, messages: [] };
}
function state(id: string): PersistableBindingState {
  return { metadata: { preview: { op: 'set', value: id } },
    sessionSeed: { sessionId: { op: 'set', value: id }, providerFields: {} } };
}
function fixture() {
  const port = new ControlledPort();
  const core = new ConversationHistoryCoordinator({ metadata: port });
  const registry = new ConversationOpenRegistry();
  const manager = {};
  const tab = {};
  const owner = ok(core.registerOwner(manager, tab));
  const claim = (id: string) => {
    const value = registry.reserve(id, () => {});
    if (!value) throw new Error(`Already reserved: ${id}`);
    return { claim: value, owns: () => registry.owns(value) };
  };
  const record = (id: string) => ok(core.registerRecord(conversation(id)));
  const attempt = (handle: ReturnType<typeof record>): BindingAttempt => ok(core.beginBindingAttempt({
    owner, record: handle, expectedRecordVersions: ok(core.readRecordVersions(handle)), reservation: claim(handle.id),
  }));
  const bind = (id: string) => {
    const handle = record(id);
    const pending = attempt(handle);
    const receipt = ok(core.commitPreparedBinding({ attempt: pending, state: state(id) }));
    return { handle, pending, receipt };
  };
  return { port, core, registry, manager, tab, owner, claim, record, attempt, bind };
}
function runtime(facts: Record<string, string> = { session: 'R' }) {
  const capture = jest.fn(() => ({ protocolVersion: 1 as const, providerId: 'claude', facts,
    invalidation: { revision: 1, invalidated: true } }));
  const ack = jest.fn();
  const port: RuntimePersistencePort = { identity: {}, providerId: 'claude',
    captureSessionPersistence: capture, acknowledgeSessionPersistenceCapture: ack };
  return { port, capture, ack };
}

it('C01 preserves record incarnation identity and retires old handles', () => {
  const f = fixture();
  const original = conversation('A');
  const first = ok(f.core.registerRecord(original));
  expect(ok(f.core.registerRecord(original))).toBe(first);
  expect(f.core.registerRecord(conversation('A'))).toMatchObject({ status: 'rejected', reason: 'stale-record' });
  ok(f.core.retireRecord(first));
  expect(ok(f.core.registerRecord(conversation('A')))).not.toBe(first);
  expect(f.core.readRecordVersions(first)).toMatchObject({ status: 'rejected', reason: 'record-retired' });
});

it('C02 distinguishes owners by object identity', () => {
  const f = fixture();
  expect(ok(f.core.registerOwner(f.manager, f.tab))).toBe(f.owner);
  const other = ok(f.core.registerOwner(f.manager, { id: 'same' }));
  expect(other).not.toBe(f.owner);
  ok(f.core.sealForClose(f.owner));
  const a = f.record('A');
  expect(f.core.beginBindingAttempt({ owner: other, record: a,
    expectedRecordVersions: ok(f.core.readRecordVersions(a)), reservation: f.claim('A') }).status).toBe('ok');
});

it('C03 rejects stale materialization without changing binding', () => {
  const f = fixture();
  const a = f.record('A');
  const attempt = f.attempt(a);
  ok(f.core.advanceRecordVersions({ record: a, expected: attempt.expectedRecordVersions, changed: ['materialization'] }));
  expect(f.core.commitPreparedBinding({ attempt, state: state('A') })).toMatchObject({ status: 'rejected', reason: 'version-mismatch' });
});

it('C04 rejects ABA old versions even when source is the same', () => {
  const f = fixture();
  const a = f.record('A');
  const v0 = ok(f.core.readRecordVersions(a));
  const v1 = ok(f.core.advanceRecordVersions({ record: a, expected: v0, changed: ['binding'] }));
  expect(ok(f.core.advanceRecordVersions({ record: a, expected: v1, changed: ['binding'] })).binding).toBe(2);
  expect(f.core.advanceRecordVersions({ record: a, expected: v0, changed: ['binding'] })).toMatchObject({ status: 'rejected', reason: 'version-mismatch' });
});

it('C05 seals original A and requires its written outgoing before B commit', async () => {
  const f = fixture();
  const a = f.bind('A');
  const r = runtime({ session: 'RA' });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const b = f.record('B');
  const next = f.attempt(b);
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  expect(f.port.entries[0].intent).toMatchObject({ record: { id: 'A', token: a.handle.token }, reason: 'outgoing',
    session: { kind: 'runtime', capture: { facts: { session: 'RA' } } } });
  expect(f.core.commitPreparedBinding({ attempt: next, state: state('B') })).toMatchObject({ status: 'rejected', reason: 'outgoing-not-written' });
  f.port.finish('A');
  await outgoing.durability;
  expect(ok(f.core.commitPreparedBinding({ attempt: next, state: state('B') })).record).toBe(b);
});

it('C06 reuses a runtime only after adoption on the new binding', async () => {
  const f = fixture();
  const a = f.bind('A');
  const r = runtime();
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const b = f.record('B');
  const next = f.attempt(b);
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  f.port.finish('A'); await outgoing.durability;
  const receipt = ok(f.core.commitPreparedBinding({ attempt: next, state: state('B') }));
  const adoption = ok(f.core.beginRuntimeAdoption({ binding: receipt, runtime: r.port }));
  r.capture.mockClear();
  const seed = accepted(f.core.admitSave({ binding: receipt }));
  expect(r.capture).not.toHaveBeenCalled();
  expect(f.port.entries[1].intent).toMatchObject({ record: { id: 'B' }, session: { kind: 'seed', patch: { sessionId: { value: 'B' } } } });
  ok(f.core.completeRuntimeAdoption(adoption));
  const live = accepted(f.core.admitSave({ binding: receipt }));
  expect(f.port.entries[2].intent.session.kind).toBe('runtime');
  expect(f.core.admitSave({ binding: a.receipt }).status).toBe('rejected');
  f.port.finish('B'); f.port.finish('B'); await Promise.all([seed.durability, live.durability]);
});

it('C07 B to A rebinding rejects late adoption on older binding tokens', async () => {
  const f = fixture(); const a = f.record('A'); const claimA = f.claim('A'); const r = runtime();
  const firstAttempt = ok(f.core.beginBindingAttempt({ owner: f.owner, record: a,
    expectedRecordVersions: ok(f.core.readRecordVersions(a)), reservation: claimA }));
  const first = ok(f.core.commitPreparedBinding({ attempt: firstAttempt, state: state('A1') }));
  const old = ok(f.core.beginRuntimeAdoption({ binding: first, runtime: r.port }));
  ok(f.core.completeRuntimeAdoption(old));
  const b = f.record('B'); const bAttempt = f.attempt(b);
  const saveA = accepted(f.core.sealOutgoing(first)); f.port.finish('A'); await saveA.durability;
  const second = ok(f.core.commitPreparedBinding({ attempt: bAttempt, state: state('B2') }));
  const middle = ok(f.core.beginRuntimeAdoption({ binding: second, runtime: r.port }));
  ok(f.core.completeRuntimeAdoption(middle));
  const thirdAttempt = ok(f.core.beginBindingAttempt({ owner: f.owner, record: a,
    expectedRecordVersions: ok(f.core.readRecordVersions(a)), reservation: claimA }));
  const saveB = accepted(f.core.sealOutgoing(second)); f.port.finish('B'); await saveB.durability;
  const third = ok(f.core.commitPreparedBinding({ attempt: thirdAttempt, state: state('A3') }));
  const current = ok(f.core.beginRuntimeAdoption({ binding: third, runtime: r.port }));
  expect(current.token).not.toBe(old.token);
  expect(f.core.completeRuntimeAdoption(old)).toMatchObject({ status: 'rejected', reason: 'stale-binding' });
  expect(f.core.failRuntimeAdoption(middle, new Error('late'))).toMatchObject({ status: 'rejected', reason: 'stale-binding' });
  ok(f.core.completeRuntimeAdoption(current));
  const saved = accepted(f.core.admitSave({ binding: third }));
  expect(f.port.entries[2].intent).toMatchObject({ record: { id: 'A', token: a.token }, session: { kind: 'runtime' } });
  f.port.finish('A'); await saved.durability;
});

it('C08 accepts B metadata-only backfill before commit and survives cancel and close', async () => {
  const f = fixture(); const a = f.bind('A');
  ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('dirty') }));
  const r = runtime(); ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const b = f.record('B'); const attempt = f.attempt(b);
  const result = accepted(f.core.admitRecordDelta({ attempt, metadata: { preview: { op: 'set', value: 'B' }, currentNote: { op: 'delete' }, messageCount: { op: 'keep' } } }));
  expect(f.port.entries[0].intent).toMatchObject({ record: { id: 'B', token: b.token }, reason: 'backfill', binding: null, dirtyRevision: null });
  expect(f.port.entries[0].intent.session).toEqual({ kind: 'none' });
  expect(r.capture).not.toHaveBeenCalled(); expect(r.ack).not.toHaveBeenCalled();
  ok(f.core.cancelBindingAttempt(attempt));
  const close = ok(f.core.sealForClose(f.owner));
  f.port.finish('B'); await result.durability;
  expect(ok(f.core.readPersistenceStatus(a.receipt)).dirty).toBe(true);
  f.port.finish('A'); await close.completion;
});

it('C09 claim alone cannot manufacture a binding while backfill is allowed', () => {
  const f = fixture(); f.bind('A'); const b = f.record('B'); const attempt = f.attempt(b);
  expect(f.core.admitRecordDelta({ attempt, metadata: {} }).status).toBe('accepted');
  expect(f.port.entries).toHaveLength(1);
  expect(f.port.entries[0].intent.reason).toBe('backfill');
  f.port.finish('B');
});

it('C10 old ACK does not clear a newer dirty revision', async () => {
  const f = fixture(); const a = f.bind('A');
  for (let i = 0; i < 7; i++) ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: i, state: state(String(i)) }));
  const save7 = accepted(f.core.admitSave({ binding: a.receipt }));
  ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 7, state: state('8') }));
  f.port.finish('A'); await save7.durability;
  expect(ok(f.core.readPersistenceStatus(a.receipt))).toMatchObject({ dirtyRevision: 8, dirty: true });
  expect(ok(f.core.getSaveReceipt(save7.ticket))).toMatchObject({ status: 'settled', receipt: { status: 'written' } });
  const save8 = accepted(f.core.admitSave({ binding: a.receipt }));
  f.port.finish('A'); await save8.durability;
  expect(ok(f.core.readPersistenceStatus(a.receipt)).dirty).toBe(false);
});

it('C11 detaches nested arrays and capture facts from caller-owned data', async () => {
  const f = fixture(); const handle = f.record('A'); const attempt = f.attempt(handle);
  const paths = ['first']; const s = state('A');
  const binding = ok(f.core.commitPreparedBinding({ attempt, state: { ...s,
    metadata: { externalContextPaths: { op: 'set', value: paths } } } }));
  const facts = { nested: { values: ['before'] } };
  const runtimePort: RuntimePersistencePort = { identity: {}, providerId: 'claude',
    captureSessionPersistence: () => ({ protocolVersion: 1, providerId: 'claude', facts,
      invalidation: { revision: 1, invalidated: true } }), acknowledgeSessionPersistenceCapture: () => {} };
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding, runtime: runtimePort }))));
  const saved = accepted(f.core.admitSave({ binding }));
  paths.push('late'); facts.nested.values.push('late');
  const intent = f.port.entries[0].intent;
  expect(intent.metadata).toEqual({ externalContextPaths: { op: 'set', value: ['first'] } });
  expect(intent.session).toMatchObject({ kind: 'runtime', capture: { facts: { nested: { values: ['before'] } } } });
  expect(Object.isFrozen(intent.session)).toBe(true);
  f.port.finish('A'); await saved.durability;
});

it('C12 rejects getters at the state boundary without invoking them', () => {
  const f = fixture(); const record = f.record('A'); const attempt = f.attempt(record);
  const getter = jest.fn(() => ({}));
  const bad = Object.defineProperty({ sessionSeed: state('A').sessionSeed }, 'metadata', { enumerable: true, get: getter });
  expect(f.core.commitPreparedBinding({ attempt, state: bad as PersistableBindingState })).toMatchObject({ status: 'rejected', reason: 'invalid-snapshot' });
  expect(getter).not.toHaveBeenCalled(); expect(f.port.entries).toHaveLength(0);
});

it('C12 rejects unsupported metadata and set undefined before admission', () => {
  const f = fixture(); const b = f.record('B'); const attempt = f.attempt(b);
  const wrong = { title: { op: 'set', value: 'not allowed' } };
  expect(f.core.admitRecordDelta({ attempt, metadata: wrong as never })).toMatchObject({ status: 'rejected', reason: 'invalid-snapshot' });
  expect(f.core.admitRecordDelta({ attempt, metadata: { preview: { op: 'set', value: undefined } } as never })).toMatchObject({ status: 'rejected', reason: 'invalid-snapshot' });
  expect(f.port.entries).toHaveLength(0);
});

it('C12 rejects malformed optional usage fields', () => {
  const f = fixture(); const b = f.record('B'); const attempt = f.attempt(b);
  const usage = { inputTokens: 1, contextWindow: 2, contextTokens: 1, percentage: 50, model: 3 };
  expect(f.core.admitRecordDelta({ attempt, metadata: { usage: { op: 'set', value: usage } } as never }))
    .toMatchObject({ status: 'rejected', reason: 'invalid-snapshot' });
  expect(f.port.entries).toHaveLength(0);
});

it.each([
  { protocolVersion: 2, providerId: 'claude', facts: {}, invalidation: { revision: 1, invalidated: true } },
  { protocolVersion: 1, providerId: 'other', facts: {}, invalidation: { revision: 1, invalidated: true } },
  { protocolVersion: 1, providerId: 'claude', facts: {}, invalidation: { revision: -1, invalidated: true } },
  { protocolVersion: 1, providerId: 'claude', facts: [], invalidation: { revision: 1, invalidated: true } },
])('C21 rejects invalid runtime capture without acknowledgement', badCapture => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  r.capture.mockReturnValue(badCapture as never);
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  expect(f.core.admitSave({ binding: a.receipt }).status).toBe('rejected');
  expect(r.ack).not.toHaveBeenCalled(); expect(f.port.entries).toHaveLength(0);
});

it('C12 rejects accessor snapshots without executing getters or acknowledging', () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  const getter = jest.fn(() => 'unsafe');
  r.capture.mockReturnValue({ protocolVersion: 1, providerId: 'claude', facts: Object.defineProperty({}, 'unsafe', { enumerable: true, get: getter }), invalidation: { revision: 1, invalidated: true } });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  expect(f.core.admitSave({ binding: a.receipt })).toMatchObject({ status: 'rejected', reason: 'invalid-snapshot' });
  expect(getter).not.toHaveBeenCalled(); expect(r.ack).not.toHaveBeenCalled(); expect(f.port.entries).toHaveLength(0);
});

it('C13 capture reentry changing the binding revision rejects before enqueue and acknowledgement', () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  r.capture.mockImplementationOnce(() => {
    ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('changed') }));
    return { protocolVersion: 1, providerId: 'claude', facts: { session: 'old' }, invalidation: { revision: 1, invalidated: true } };
  });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  expect(f.core.admitSave({ binding: a.receipt }).status).toBe('rejected');
  expect(f.port.entries).toHaveLength(0); expect(r.ack).not.toHaveBeenCalled();
});

it('C13 capture reentry sealing outgoing rejects the original normal save', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  let outgoing: SaveRequestResult | undefined;
  r.capture.mockImplementationOnce(() => {
    outgoing = f.core.sealOutgoing(a.receipt);
    return { protocolVersion: 1, providerId: 'claude', facts: { session: 'old' }, invalidation: { revision: 1, invalidated: true } };
  });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const normal = f.core.admitSave({ binding: a.receipt });
  expect(normal).toMatchObject({ status: 'rejected', reason: 'binding-sealed' });
  if (!outgoing) throw new Error('Expected outgoing save');
  const saved = accepted(outgoing);
  expect(f.port.entries).toHaveLength(1);
  expect(f.port.entries[0].intent.reason).toBe('outgoing');
  expect(r.ack).toHaveBeenCalledTimes(1);
  f.port.finish('A'); await saved.durability;
});

it('C14 acknowledgement error does not revoke accepted ticket or durability', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime(); const error = new Error('ack');
  r.ack.mockImplementationOnce(() => { throw error; });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  expect(saved.captureAcknowledgement).toEqual({ status: 'failed', error });
  expect(f.port.entries).toHaveLength(1); f.port.finish('A');
  expect(await saved.durability).toMatchObject({ status: 'written', ticket: saved.ticket });
});

it('acknowledgement throw after reentrant close preserves accepted ticket and error', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime(); const error = new Error('ack');
  let close: ReturnType<typeof f.core.sealForClose> | undefined;
  r.ack.mockImplementationOnce(() => { close = f.core.sealForClose(f.owner); throw error; });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  expect(saved.captureAcknowledgement).toEqual({ status: 'failed', error });
  if (!close) throw new Error('Expected close');
  const plan = ok(close);
  expect(plan.acceptedAtSeal).toEqual([saved.ticket]);
  expect(f.port.entries).toHaveLength(2);
  f.port.finish('A'); await saved.durability;
  f.port.finish('A');
  expect(await plan.completion).toMatchObject([{ status: 'settled', receipt: { ticket: saved.ticket, status: 'written' },
    captureAcknowledgement: { status: 'failed', error } }, { status: 'settled', receipt: { status: 'written' } }]);
});

it('accepted ticket is queryable during a reentrant capture acknowledgement', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  let query: ReturnType<typeof f.core.getSaveReceipt> | undefined;
  r.ack.mockImplementationOnce(() => {
    const inflight = f.core.snapshotAcceptedSaves(f.owner);
    query = f.core.getSaveReceipt(inflight[0].ticket);
  });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  expect(query).toEqual({ status: 'ok', value: { status: 'pending' } });
  f.port.finish('A'); await saved.durability;
});

it('runtime capture acknowledgement occurs at acceptance before durability', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('dirty') }));
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  expect(r.capture).toHaveBeenCalledTimes(1);
  expect(r.ack).toHaveBeenCalledTimes(1);
  expect(r.ack).toHaveBeenCalledWith(expect.objectContaining({ facts: { session: 'R' }, invalidation: { revision: 1, invalidated: true } }));
  expect(saved.captureAcknowledgement).toEqual({ status: 'acknowledged' });
  expect(ok(f.core.getSaveReceipt(saved.ticket))).toEqual({ status: 'pending' });
  expect(ok(f.core.readPersistenceStatus(a.receipt)).dirty).toBe(true);
  f.port.finish('A'); await saved.durability;
  expect(r.ack).toHaveBeenCalledTimes(1);
});

it('unknown completion status settles a normal save without clearing dirty', async () => {
  const f = fixture(); const a = f.bind('A');
  ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('dirty') }));
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  const getter = jest.fn(() => { throw new Error('unexpected getter'); });
  const result = Object.defineProperties({ status: 'unexpected' }, {
    toJSON: { get: getter }, ticket: { get: getter },
  });
  f.port.finish('A', result as unknown as MetadataWriteResult);
  let error: unknown;
  try { await saved.durability; } catch (caught) { error = caught; }
  const queried = ok(f.core.getSaveReceipt(saved.ticket));
  expect(queried.status).toBe('settled');
  if (queried.status !== 'settled') throw new Error('Expected settled receipt');
  expect(error).toBeInstanceOf(Error);
  expect(queried.receipt).toMatchObject({ status: 'failed', stage: 'unknown' });
  expect(queried.receipt.ticket).toBe(saved.ticket);
  if (queried.receipt.status !== 'failed') throw new Error('Expected failed receipt');
  expect(queried.receipt.error).toBe(error);
  expect(ok(f.core.readPersistenceStatus(a.receipt)).dirty).toBe(true);
  expect(f.core.snapshotAcceptedSaves(f.owner)).toEqual([]);
  expect(getter).not.toHaveBeenCalled();
});

// The pre-fix close rejection is contained in a child and observed with a bounded race.
function observeUnknownCompletionAtClose(mode: 'before-close' | 'during-close' | 'runtime-outgoing') {
  const script = `
    const fs = require('node:fs');
    const ts = require('typescript');
    const load = file => {
      const source = fs.readFileSync(file, 'utf8');
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const module = { exports: {} };
      new Function('module', 'exports', 'require', js)(module, module.exports, require);
      return module.exports;
    };
    const { ConversationHistoryCoordinator } = load('src/app/ConversationHistoryCoordinator.ts');
    const { ConversationOpenRegistry } = load('src/features/chat/tabs/ConversationOpenRegistry.ts');
    const errors = [];
    process.on('unhandledRejection', (error, promise) => { errors.push(error.message); promise.catch(() => {}); });
    process.on('rejectionHandled', () => {});
    const entries = [];
    const core = new ConversationHistoryCoordinator({ metadata: { admit() {
      let resolve;
      const completion = new Promise(done => { resolve = done; });
      entries.push(resolve);
      return { status: 'accepted', sequence: entries.length, completion };
    } } });
    const ok = result => { if (result.status !== 'ok') throw new Error(result.reason); return result.value; };
    const owner = ok(core.registerOwner({}, {}));
    const record = ok(core.registerRecord({ id: 'A', providerId: 'claude', title: 'A', createdAt: 0,
      updatedAt: 0, sessionId: null, messages: [] }));
    const registry = new ConversationOpenRegistry();
    const claim = registry.reserve('A', () => {});
    const attempt = ok(core.beginBindingAttempt({ owner, record, expectedRecordVersions: ok(core.readRecordVersions(record)),
      reservation: { claim, owns: () => registry.owns(claim) } }));
    const state = { metadata: { preview: { op: 'set', value: 'dirty' } },
      sessionSeed: { sessionId: { op: 'set', value: 'A' }, providerFields: {} } };
    const binding = ok(core.commitPreparedBinding({ attempt, state }));
    ok(core.updatePersistableBinding({ binding, expectedDirtyRevision: 0, state }));
    const mode = process.argv[1];
    let captureCalls = 0, ackCalls = 0, ackMatchesCapture = false;
    if (mode === 'runtime-outgoing') {
      const runtime = { identity: {}, providerId: 'claude',
        captureSessionPersistence() { captureCalls++; return { protocolVersion: 1, providerId: 'claude',
          facts: { session: 'R' }, invalidation: { revision: 1, invalidated: true } }; },
        acknowledgeSessionPersistenceCapture(capture) { ackCalls++; ackMatchesCapture = capture.providerId === 'claude'
          && capture.facts.session === 'R' && capture.invalidation.revision === 1 && capture.invalidation.invalidated; } };
      ok(core.completeRuntimeAdoption(ok(core.beginRuntimeAdoption({ binding, runtime }))));
    }
    const normal = mode === 'before-close' ? core.admitSave({ binding })
      : mode === 'runtime-outgoing' ? core.sealOutgoing(binding) : null;
    const ackAtAdmission = ackCalls;
    const plan = ok(core.sealForClose(owner));
    const bounded = promise => new Promise(resolve => {
      const timer = setTimeout(() => resolve({ status: 'timeout' }), 100);
      promise.then(value => { clearTimeout(timer); resolve(value); });
    });
    (async () => {
      const saved = normal || await plan.finalAdmissions[0].settlement;
      if (saved.status !== 'accepted') throw new Error('Expected accepted save');
      let getterCalls = 0;
      const result = Object.defineProperties({ status: 'unexpected' }, {
        toJSON: { get() { getterCalls++; throw new Error('toJSON getter'); } },
        ticket: { get() { getterCalls++; throw new Error('ticket getter'); } }
      });
      let error;
      const durability = saved.durability.then(() => ({ status: 'resolved' }), caught => {
        error = caught; return { status: 'rejected', isError: caught instanceof Error };
      });
      entries[0](result);
      if (mode === 'before-close') entries[1]({ status: 'skipped', reason: 'missing' });
      const durable = await bounded(durability);
      let closeAck, closeReceipt;
      const close = await bounded(plan.completion.then(outcomes => {
        const outcome = outcomes.find(item => item.status === 'settled' && item.receipt.ticket === saved.ticket);
        closeReceipt = outcome?.receipt;
        closeAck = outcome && { status: outcome.captureAcknowledgement.status,
          sameObject: outcome.captureAcknowledgement === saved.captureAcknowledgement };
        return { status: 'completed', count: outcomes.length, found: !!outcome,
          failed: outcome?.receipt.status === 'failed', stage: outcome?.receipt.stage,
          sameError: outcome?.receipt.error === error };
      }));
      const queried = ok(core.getSaveReceipt(saved.ticket));
      const receipt = queried.status === 'settled' ? { status: queried.receipt.status, stage: queried.receipt.stage,
        sameTicket: queried.receipt.ticket === saved.ticket, sameError: queried.receipt.error === error } : { status: queried.status };
      await new Promise(resolve => setImmediate(resolve));
      process.stdout.write(JSON.stringify({ durable, close, receipt, dirty: ok(core.readPersistenceStatus(binding)).dirty,
        inflight: core.snapshotAcceptedSaves(owner).length, atSeal: plan.acceptedAtSeal.includes(saved.ticket), getterCalls, errors,
        ...(mode === 'runtime-outgoing' ? { captureCalls, ackAtAdmission, ackCalls, ackMatchesCapture,
          admissionAck: saved.captureAcknowledgement.status, closeAck: closeAck || null,
          sameCloseReceipt: queried.status === 'settled' && queried.receipt === closeReceipt } : {}) }));
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script, mode], { encoding: 'utf8', timeout: 5000 })) as unknown;
}

it.each(['before-close', 'during-close'] as const)(
  'unknown completion status settles an accepted flight %s', mode => {
    expect(observeUnknownCompletionAtClose(mode)).toEqual({
      durable: { status: 'rejected', isError: true },
      close: { status: 'completed', count: mode === 'before-close' ? 2 : 1, found: true, failed: true, stage: 'unknown', sameError: true },
      receipt: { status: 'failed', stage: 'unknown', sameTicket: true, sameError: true },
      dirty: true, inflight: 0, atSeal: mode === 'before-close', getterCalls: 0, errors: [],
    });
  },
);

it('runtime capture acknowledgement survives unknown completion through close', () => {
  expect(observeUnknownCompletionAtClose('runtime-outgoing')).toEqual({
    durable: { status: 'rejected', isError: true },
    close: { status: 'completed', count: 1, found: true, failed: true, stage: 'unknown', sameError: true },
    receipt: { status: 'failed', stage: 'unknown', sameTicket: true, sameError: true },
    dirty: true, inflight: 0, atSeal: true, getterCalls: 0, errors: [],
    captureCalls: 1, ackAtAdmission: 1, ackCalls: 1, ackMatchesCapture: true,
    admissionAck: 'acknowledged', closeAck: { status: 'acknowledged', sameObject: true }, sameCloseReceipt: true,
  });
});

it('writer result extra ticket cannot replace the admitted ticket', async () => {
  const f = fixture(); const a = f.bind('A');
  f.port.counts.set('A', 122);
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  const plan = ok(f.core.sealForClose(f.owner));
  const fakeTicket = { ...saved.ticket, sequence: 999 };
  const result = { status: 'written' as const, confirmedRevision: 1, ticket: fakeTicket };
  expect(saved.ticket.sequence).toBe(123);
  f.port.finish('A', result);
  const receipt = await saved.durability;
  expect(receipt.ticket).toBe(saved.ticket);
  expect(ok(f.core.getSaveReceipt(saved.ticket))).toEqual({ status: 'settled', receipt });
  f.port.finish('A');
  const outcomes = await plan.completion;
  expect(outcomes[0]).toEqual({ status: 'settled', receipt, captureAcknowledgement: saved.captureAcknowledgement });
  if (outcomes[0].status !== 'settled') throw new Error('Expected settled receipt');
  expect(outcomes[0].receipt.ticket).toBe(saved.ticket);
});

// A child owns the pre-fix close rejection, so the failing observation cannot leak into Jest.
function observeCompletionGetter(mode: 'extra' | 'status' | 'confirmedRevision' | 'reason' | 'stage' | 'error') {
  const script = `
    const fs = require('node:fs');
    const ts = require('typescript');
    const load = (file) => {
      const source = fs.readFileSync(file, 'utf8');
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const module = { exports: {} };
      new Function('module', 'exports', 'require', js)(module, module.exports, require);
      return module.exports;
    };
    const { ConversationHistoryCoordinator } = load('src/app/ConversationHistoryCoordinator.ts');
    const { ConversationOpenRegistry } = load('src/features/chat/tabs/ConversationOpenRegistry.ts');
    const errors = [];
    process.on('unhandledRejection', (error, promise) => { errors.push(error.message); promise.catch(() => {}); });
    process.on('rejectionHandled', () => {});
    const entries = [];
    const port = { admit() {
      let resolve;
      const completion = new Promise(done => { resolve = done; });
      entries.push(resolve);
      return { status: 'accepted', sequence: entries.length, completion };
    } };
    const core = new ConversationHistoryCoordinator({ metadata: port });
    const registry = new ConversationOpenRegistry();
    const ok = result => { if (result.status !== 'ok') throw new Error(result.reason); return result.value; };
    const owner = ok(core.registerOwner({}, {}));
    const record = ok(core.registerRecord({ id: 'A', providerId: 'claude', title: 'A', createdAt: 0,
      updatedAt: 0, sessionId: null, messages: [] }));
    const claim = registry.reserve('A', () => {});
    const attempt = ok(core.beginBindingAttempt({ owner, record, expectedRecordVersions: ok(core.readRecordVersions(record)),
      reservation: { claim, owns: () => registry.owns(claim) } }));
    const binding = ok(core.commitPreparedBinding({ attempt, state: { metadata: {},
      sessionSeed: { sessionId: { op: 'set', value: 'A' }, providerFields: {} } } }));
    const saved = core.admitSave({ binding });
    if (saved.status !== 'accepted') throw new Error('Expected accepted save');
    const plan = ok(core.sealForClose(owner));
    const error = new Error('getter');
    let getterCalls = 0;
    const mode = process.argv[1];
    const result = mode === 'reason' ? { status: 'skipped', reason: 'missing' }
      : mode === 'stage' || mode === 'error' ? { status: 'failed', stage: 'write', error: new Error('writer') }
      : { status: 'written', confirmedRevision: 1 };
    Object.defineProperty(result, mode === 'extra' ? 'ticket' : mode, {
      enumerable: true, get() { getterCalls++; throw error; }
    });
    let durability = { status: 'pending' };
    saved.durability.then(receipt => { durability = { status: receipt.status, ticket: receipt.ticket === saved.ticket }; },
      caught => { durability = { status: 'rejected', error: caught === error }; });
    let close = { status: 'pending' };
    plan.completion.then(outcomes => { close = { status: 'completed', count: outcomes.length,
      receipt: outcomes[0].receipt.status, ticket: outcomes[0].receipt.ticket === saved.ticket,
      error: outcomes[0].receipt.error === error }; });
    entries[0](result);
    entries[1]({ status: 'written', confirmedRevision: 1 });
    setImmediate(() => setImmediate(() => {
      const queried = ok(core.getSaveReceipt(saved.ticket));
      const receipt = queried.status === 'settled' ? { status: queried.receipt.status,
        ticket: queried.receipt.ticket === saved.ticket, error: queried.receipt.error === error,
        stage: queried.receipt.stage } : { status: queried.status };
      process.stdout.write(JSON.stringify({ getterCalls, durability, receipt, close, errors }));
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script, mode], { encoding: 'utf8', timeout: 5000 })) as {
    getterCalls: number; durability: unknown; receipt: unknown; close: unknown; errors: string[];
  };
}

it('completion ignores extra enumerable ticket getter and close finishes', () => {
  expect(observeCompletionGetter('extra')).toEqual({ getterCalls: 0,
    durability: { status: 'written', ticket: true }, receipt: { status: 'written', ticket: true, error: false },
    close: { status: 'completed', count: 2, receipt: 'written', ticket: true, error: false }, errors: [] });
});

it.each(['status', 'confirmedRevision', 'reason', 'stage', 'error'] as const)(
  'completion required %s getter failure settles the accepted flight', field => {
    expect(observeCompletionGetter(field)).toEqual({ getterCalls: 1,
      durability: { status: 'rejected', error: true },
      receipt: { status: 'failed', ticket: true, error: true, stage: 'unknown' },
      close: { status: 'completed', count: 2, receipt: 'failed', ticket: true, error: true }, errors: [] });
  },
);

it.each(['raw', 'thenable'] as const)('completion %s rejection preserves error through close', async mode => {
  const f = fixture(); const a = f.bind('A'); const error = new Error(mode);
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  const plan = ok(f.core.sealForClose(f.owner));
  if (mode === 'raw') f.port.failRaw('A', error);
  else {
    const thenable = Object.defineProperty({}, 'then', { get: () => { throw error; } });
    f.port.finish('A', thenable as MetadataWriteResult);
  }
  await expect(saved.durability).rejects.toBe(error);
  const state = ok(f.core.getSaveReceipt(saved.ticket));
  expect(state).toMatchObject({ status: 'settled', receipt: { ticket: saved.ticket, status: 'failed', stage: 'unknown', error } });
  f.port.finish('A');
  expect(await plan.completion).toMatchObject([{ status: 'settled', receipt: { ticket: saved.ticket, status: 'failed', stage: 'unknown', error } },
    { status: 'settled', receipt: { status: 'written' } }]);
});

it('C15 preserves error identity and dirty on failed write', async () => {
  const f = fixture(); const a = f.bind('A');
  ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('dirty') }));
  const saved = accepted(f.core.admitSave({ binding: a.receipt })); const error = new Error('write');
  f.port.finish('A', { status: 'failed', stage: 'write', error });
  await expect(saved.durability).rejects.toBe(error);
  expect(ok(f.core.getSaveReceipt(saved.ticket))).toMatchObject({ status: 'settled', receipt: { status: 'failed', stage: 'write', error } });
  expect(ok(f.core.readPersistenceStatus(a.receipt)).dirty).toBe(true);
});

it('C16 legacy cleanup failure preserves error while a later write progresses', async () => {
  const f = fixture(); const a = f.bind('A'); const error = new Error('legacy');
  const first = accepted(f.core.admitSave({ binding: a.receipt }));
  const second = accepted(f.core.admitSave({ binding: a.receipt }));
  f.port.finish('A', { status: 'failed', stage: 'legacy-cleanup', error });
  await expect(first.durability).rejects.toBe(error);
  f.port.finish('A'); expect(await second.durability).toMatchObject({ status: 'written' });
  expect(ok(f.core.getSaveReceipt(first.ticket))).toMatchObject({ status: 'settled', receipt: { status: 'failed', stage: 'legacy-cleanup', error } });
});

it.each([
  { status: 'skipped', reason: 'missing' }, { status: 'skipped', reason: 'deleted' },
  { status: 'conflict', reason: 'record-replaced' }, { status: 'conflict', reason: 'binding-version' },
  { status: 'conflict', reason: 'materialization-version' },
] as const)('C17 non-written result $status $reason retains dirty', async result => {
  const f = fixture(); const a = f.bind('A');
  ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('dirty') }));
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  f.port.finish('A', result);
  expect(await saved.durability).toMatchObject(result);
  expect(ok(f.core.readPersistenceStatus(a.receipt)).dirty).toBe(true);
  expect(f.port.entries).toHaveLength(1);
});

it('outgoing already dispatching remains queryable after reentrant close', async () => {
  const f = fixture(); const a = f.bind('A');
  let pending: ReturnType<typeof f.core.sealOutgoing> | undefined;
  let plan: ReturnType<typeof f.core.sealForClose> | undefined;
  let duplicate: ReturnType<typeof f.core.sealOutgoing> | undefined;
  f.port.onAdmit = () => {
    plan = f.core.sealForClose(f.owner);
    pending = f.core.sealOutgoing(a.receipt);
    duplicate = f.core.sealOutgoing(a.receipt);
  };
  const result = accepted(f.core.sealOutgoing(a.receipt));
  if (!plan || !pending || pending.status !== 'admitting') throw new Error('Missing flight');
  expect(duplicate).toBe(pending);
  expect(await pending.settlement).toBe(result);
  expect(pending.token).toBe(result.ticket.token);
  expect(f.core.sealOutgoing(a.receipt)).toBe(result);
  expect(f.port.entries).toHaveLength(1);
  f.port.finish('A'); await result.durability;
  const outcomes = await ok(plan).completion;
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: 'settled', receipt: { status: 'written', ticket: result.ticket } });
});

it('outgoing synchronous reentry returns one pending and one actual ticket', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  let inner: ReturnType<typeof f.core.sealOutgoing> | undefined;
  f.port.onAdmit = () => { inner = f.core.sealOutgoing(a.receipt); };
  const outer = accepted(f.core.sealOutgoing(a.receipt) as SaveAdmission);
  if (!inner || inner.status !== 'admitting') throw new Error('Expected pending outgoing');
  expect(inner).not.toHaveProperty('ticket');
  expect(inner).not.toHaveProperty('sequence');
  expect(inner.token).toBe(outer.ticket.token);
  expect(await inner.settlement).toBe(outer);
  expect(r.capture).toHaveBeenCalledTimes(1);
  expect(f.port.entries).toHaveLength(1);
  expect(outer.ticket.sequence).toBe(1);
  f.port.finish('A'); await outer.durability;
  expect(f.core.sealOutgoing(a.receipt)).toBe(outer);
});

it('outgoing port reentry close reuses the pending flight and real result', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  let plan: ReturnType<typeof f.core.sealForClose> | undefined;
  f.port.onAdmit = () => { plan = f.core.sealForClose(f.owner); };
  const outer = accepted(f.core.sealOutgoing(a.receipt) as SaveAdmission);
  if (!plan) throw new Error('Expected reentrant close');
  const close = ok(plan);
  expect(ok(f.core.sealForClose(f.owner))).toBe(close);
  expect(close.acceptedAtSeal).toHaveLength(0);
  expect(close.pendingAtSeal).toHaveLength(1);
  expect(close.finalAdmissions).toHaveLength(1);
  expect(close.finalAdmissions[0]).toBe(close.pendingAtSeal[0]);
  expect(f.port.entries).toHaveLength(1); expect(r.capture).toHaveBeenCalledTimes(1);
  let done = false; void close.completion.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  f.port.finish('A'); await outer.durability;
  expect(await close.completion).toMatchObject([{ status: 'settled', receipt: { status: 'written', ticket: outer.ticket } }]);
});

it.each(['reject', 'throw'] as const)('outgoing %s preserves pending and close rejection without a ticket', async mode => {
  const f = fixture(); const a = f.bind('A'); const error = new Error('before enqueue');
  if (mode === 'reject') f.port.rejectOnAdmit = true; else f.port.throwOnAdmit = error;
  let pending: ReturnType<typeof f.core.sealOutgoing> | undefined;
  let close: ReturnType<typeof f.core.sealForClose> | undefined;
  f.port.onAdmit = () => { pending = f.core.sealOutgoing(a.receipt); close = f.core.sealForClose(f.owner); };
  const result = f.core.sealOutgoing(a.receipt);
  if (!pending || pending.status !== 'admitting' || !close) throw new Error('Expected pending and close');
  expect(await pending.settlement).toBe(result);
  expect(result).toMatchObject({ status: 'rejected', reason: mode === 'reject' ? 'storage-rejected' : 'storage-admission-failed',
    ...(mode === 'throw' ? { error } : {}) });
  const outcomes = await ok(close).completion;
  expect(outcomes).toEqual([{ status: 'not-admitted', token: pending.token, rejection: result }]);
  expect(f.port.entries).toHaveLength(0);
  expect(f.core.sealOutgoing(a.receipt)).toBe(result);
});

it('outgoing write failure remains visible in close and rejects by identity', async () => {
  const f = fixture(); const a = f.bind('A'); const error = new Error('write');
  let close: ReturnType<typeof f.core.sealForClose> | undefined;
  f.port.onAdmit = () => { close = f.core.sealForClose(f.owner); };
  const saved = accepted(f.core.sealOutgoing(a.receipt) as SaveAdmission);
  if (!close) throw new Error('Expected close');
  f.port.finish('A', { status: 'failed', stage: 'write', error });
  await expect(saved.durability).rejects.toBe(error);
  expect(f.core.sealOutgoing(a.receipt)).toBe(saved);
  expect(await ok(close).completion).toMatchObject([{ status: 'settled', receipt: { status: 'failed', stage: 'write', error } }]);
});

it('close retains an outgoing failure that settled before close', async () => {
  const f = fixture(); const a = f.bind('A'); const error = new Error('write');
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  f.port.finish('A', { status: 'failed', stage: 'write', error });
  await expect(outgoing.durability).rejects.toBe(error);
  expect(f.core.sealOutgoing(a.receipt)).toBe(outgoing);
  const plan = ok(f.core.sealForClose(f.owner));
  expect(plan.acceptedAtSeal).toEqual([]);
  expect(await plan.completion).toMatchObject([{ status: 'settled', receipt: { ticket: outgoing.ticket, status: 'failed', stage: 'write', error } }]);
  expect(f.port.entries).toHaveLength(1);
});

it('superseded outgoing is queryable only through its original signed receipt', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const attempt = f.attempt(b);
  const original = accepted(f.core.sealOutgoing(a.receipt));
  f.port.finish('A'); await original.durability;
  const next = ok(f.core.commitPreparedBinding({ attempt, state: state('B') }));
  expect(f.core.sealOutgoing(a.receipt)).toBe(original);
  expect(f.core.sealOutgoing({ ...a.receipt, owner: {} as never }).status).toBe('rejected');
  expect(f.core.sealOutgoing({ ...a.receipt, record: next.record }).status).toBe('rejected');
  expect(f.port.entries).toHaveLength(1);
});

it('retiring owner cannot start outgoing when only normal and final flights exist', async () => {
  const f = fixture(); const a = f.bind('A');
  const normal = accepted(f.core.admitSave({ binding: a.receipt }));
  const plan = ok(f.core.sealForClose(f.owner));
  expect(f.core.sealOutgoing(a.receipt)).toMatchObject({ status: 'rejected', reason: 'owner-retiring' });
  expect(f.port.entries).toHaveLength(2);
  f.port.finish('A'); await normal.durability;
  f.port.finish('A'); expect(await plan.completion).toHaveLength(2);
});

it('final port reentry observes the same complete plan and enqueues only once', async () => {
  const f = fixture(); f.bind('A');
  let nested: ReturnType<typeof f.core.sealForClose> | undefined;
  f.port.onAdmit = () => { nested = f.core.sealForClose(f.owner); };
  const plan = ok(f.core.sealForClose(f.owner));
  if (!nested) throw new Error('Expected nested close');
  expect(ok(nested)).toBe(plan);
  expect(plan.finalAdmissions).toHaveLength(1);
  expect(plan.finalAdmissions[0].status).toBe('admitting');
  expect(f.port.entries).toHaveLength(1);
  f.port.finish('A');
  expect(await plan.completion).toHaveLength(1);
});

it('sealing-outgoing rejects mutation and adoption and does not authorize commit', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const pending = f.attempt(b); const r = runtime();
  let commit: ReturnType<typeof f.core.commitPreparedBinding> | undefined;
  let update: ReturnType<typeof f.core.updatePersistableBinding> | undefined;
  let adoption: ReturnType<typeof f.core.beginRuntimeAdoption> | undefined;
  f.port.onAdmit = () => {
    commit = f.core.commitPreparedBinding({ attempt: pending, state: state('B') });
    update = f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('changed') });
    adoption = f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port });
  };
  const saved = accepted(f.core.sealOutgoing(a.receipt) as SaveAdmission);
  expect(commit).toMatchObject({ status: 'rejected', reason: 'outgoing-not-written' });
  expect(update).toMatchObject({ status: 'rejected', reason: 'binding-sealed' });
  expect(adoption).toMatchObject({ status: 'rejected', reason: 'binding-sealed' });
  f.port.finish('A'); await saved.durability;
  expect(ok(f.core.commitPreparedBinding({ attempt: pending, state: state('B') })).record).toBe(b);
});

it('C19 capture reentry close retains the original pending and permits one final', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime();
  let plan: ReturnType<typeof f.core.sealForClose> | undefined;
  let pending: ReturnType<typeof f.core.sealOutgoing> | undefined;
  r.capture.mockImplementationOnce(() => {
    plan = f.core.sealForClose(f.owner);
    pending = f.core.sealOutgoing(a.receipt);
    return { protocolVersion: 1, providerId: 'claude', facts: { session: 'old' }, invalidation: { revision: 1, invalidated: true } };
  });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const result = f.core.sealOutgoing(a.receipt);
  expect(result.status).toBe('rejected');
  if (!plan || !pending || pending.status !== 'admitting') throw new Error('Expected close and pending');
  expect(await pending.settlement).toBe(result);
  expect(f.port.entries).toHaveLength(1);
  expect(f.port.entries[0].intent.reason).toBe('final');
  f.port.finish('A');
  expect((await ok(plan).completion).some(item => item.status === 'not-admitted')).toBe(true);
});

it('C19 normal port reentry close drains the original pending and one final', async () => {
  const f = fixture(); const a = f.bind('A');
  let close: ReturnType<typeof f.core.sealForClose> | undefined;
  f.port.onAdmit = () => { f.port.onAdmit = undefined; close = f.core.sealForClose(f.owner); };
  const normal = accepted(f.core.admitSave({ binding: a.receipt }));
  if (!close) throw new Error('Expected close');
  const plan = ok(close);
  expect(plan.pendingAtSeal).toHaveLength(1);
  expect(plan.pendingAtSeal[0].token).toBe(normal.ticket.token);
  expect(plan.finalAdmissions).toHaveLength(1);
  expect(f.port.entries.map(entry => entry.intent.reason)).toEqual(['normal', 'final']);
  let done = false; void plan.completion.then(() => { done = true; });
  f.port.finish('A'); await normal.durability; await Promise.resolve();
  expect(done).toBe(false);
  f.port.finish('A');
  const outcomes = await plan.completion;
  expect(outcomes).toHaveLength(2);
  expect(outcomes[0]).toMatchObject({ status: 'settled', receipt: { ticket: normal.ticket, status: 'written' } });
});

it('unknown receipt does not create a flight or alter a legal close', async () => {
  const f = fixture();
  expect(f.core.sealOutgoing({ token: {} } as CommitReceipt)).toMatchObject({ status: 'rejected', reason: 'unknown-token' });
  const plan = ok(f.core.sealForClose(f.owner));
  expect(plan.pendingAtSeal).toEqual([]); expect(plan.finalAdmissions).toEqual([]);
  expect(await plan.completion).toEqual([]); expect(f.port.entries).toHaveLength(0);
});

it('two owners do not drain one another', async () => {
  const f = fixture(); const a = f.bind('A');
  const owner2 = ok(f.core.registerOwner(f.manager, {})); const b = f.record('B');
  const attempt = ok(f.core.beginBindingAttempt({ owner: owner2, record: b,
    expectedRecordVersions: ok(f.core.readRecordVersions(b)), reservation: f.claim('B') }));
  const receipt = ok(f.core.commitPreparedBinding({ attempt, state: state('B') }));
  const pendingA = accepted(f.core.admitSave({ binding: a.receipt }));
  const pendingB = accepted(f.core.admitSave({ binding: receipt }));
  const plan = ok(f.core.sealForClose(f.owner));
  expect(plan.acceptedAtSeal).toEqual([pendingA.ticket]);
  f.port.finish('A'); f.port.finish('A');
  expect(await plan.completion).toHaveLength(2);
  expect(f.core.snapshotAcceptedSaves(owner2).map(item => item.ticket)).toEqual([pendingB.ticket]);
  f.port.finish('B'); await pendingB.durability;
});

it('final capture error reports the reserved token without fabricating a ticket', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime(); const error = new Error('capture');
  let nested: ReturnType<typeof f.core.sealForClose> | undefined;
  r.capture.mockImplementationOnce(() => { nested = f.core.sealForClose(f.owner); throw error; });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const plan = ok(f.core.sealForClose(f.owner));
  if (!nested) throw new Error('Expected nested close');
  expect(ok(nested)).toBe(plan);
  const pending = plan.finalAdmissions[0];
  if (pending.status !== 'admitting') throw new Error('Expected final pending');
  expect(await pending.settlement).toMatchObject({ status: 'rejected', reason: 'runtime-capture-failed', error });
  expect(await plan.completion).toEqual([{ status: 'not-admitted', token: pending.token,
    rejection: { status: 'rejected', reason: 'runtime-capture-failed', error } }]);
  expect(f.port.entries).toHaveLength(0);
});

it.each(['port', 'ack'] as const)('fence A %s reentry transfers the pending outgoing to C', async hook => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const first = f.attempt(b); const c = f.record('C');
  const claim = f.claim('C'); const r = runtime();
  let second: BindingAttempt | undefined; let pending: SaveRequestResult | undefined;
  let stale: ReturnType<typeof f.core.cancelBindingAttempt> | undefined;
  const transfer = () => {
    ok(f.core.cancelBindingAttempt(first));
    second = ok(f.core.beginBindingAttempt({ owner: f.owner, record: c,
      expectedRecordVersions: ok(f.core.readRecordVersions(c)), reservation: claim }));
    pending = f.core.sealOutgoing(a.receipt);
    stale = f.core.cancelBindingAttempt(first);
  };
  if (hook === 'port') f.port.onAdmit = () => { f.port.onAdmit = undefined; transfer(); };
  else {
    ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
    r.ack.mockImplementationOnce(transfer);
  }
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  if (!second || !pending || pending.status !== 'admitting') throw new Error('Expected C and pending outgoing');
  expect(stale).toMatchObject({ status: 'rejected', reason: 'stale-attempt' });
  expect(pending.token).toBe(outgoing.ticket.token);
  expect(await pending.settlement).toBe(outgoing);
  expect(f.port.entries).toHaveLength(1);
  expect(f.core.sealOutgoing(a.receipt)).toBe(outgoing);
  expect(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('blocked') }))
    .toMatchObject({ status: 'rejected', reason: 'binding-sealed' });
  f.port.finish('A'); await outgoing.durability;
  expect(ok(f.core.commitPreparedBinding({ attempt: second, state: state('C') })).record).toBe(c);
});

it('fence A C becomes a consumer on begin even without another seal', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const first = f.attempt(b); const c = f.record('C');
  let second: BindingAttempt | undefined;
  f.port.onAdmit = () => { ok(f.core.cancelBindingAttempt(first)); second = f.attempt(c); };
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  if (!second) throw new Error('Expected C');
  expect(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('blocked') }))
    .toMatchObject({ status: 'rejected', reason: 'binding-sealed' });
  f.port.finish('A'); await outgoing.durability;
  expect(ok(f.core.commitPreparedBinding({ attempt: second, state: state('C') })).record).toBe(c);
});

it('fence A cancelling C before settlement releases after admission but preserves durability', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const first = f.attempt(b); const c = f.record('C');
  f.port.onAdmit = () => { ok(f.core.cancelBindingAttempt(first)); const second = f.attempt(c); ok(f.core.cancelBindingAttempt(second)); };
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  expect(f.port.entries).toHaveLength(1);
  expect(ok(f.core.getSaveReceipt(outgoing.ticket))).toEqual({ status: 'pending' });
  expect(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('allowed') }).status).toBe('ok');
  f.port.finish('A'); expect(await outgoing.durability).toMatchObject({ status: 'written', ticket: outgoing.ticket });
});

it.each([false, true])('fence A failed C begin preserves predecessor or allows release when cancelled=%s', async cancelFirst => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const first = f.attempt(b); const c = f.record('C');
  const claim = f.claim('C'); let failure: ReturnType<typeof f.core.beginBindingAttempt> | undefined;
  f.port.onAdmit = () => {
    if (cancelFirst) ok(f.core.cancelBindingAttempt(first));
    failure = f.core.beginBindingAttempt({ owner: f.owner, record: c,
      expectedRecordVersions: ok(f.core.readRecordVersions(c)), reservation: { claim: claim.claim, owns: () => false } });
  };
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  expect(failure).toMatchObject({ status: 'rejected', reason: 'reservation-lost' });
  const update = f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('changed') });
  expect(update).toMatchObject(cancelFirst ? { status: 'ok' } : { status: 'rejected', reason: 'binding-sealed' });
  f.port.finish('A'); await outgoing.durability;
  const commit = cancelFirst ? null : f.core.commitPreparedBinding({ attempt: first, state: state('B') });
  const committedB = expect.objectContaining({ status: 'ok', value: expect.objectContaining({ record: b }) });
  expect(commit).toEqual(cancelFirst ? null : committedB);
});

it('fence A transfer then close drains one pending outgoing and retains failure', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const first = f.attempt(b); const c = f.record('C');
  const error = new Error('write'); let close: ReturnType<typeof f.core.sealForClose> | undefined;
  let duplicate: ReturnType<typeof f.core.sealForClose> | undefined;
  f.port.onAdmit = () => { ok(f.core.cancelBindingAttempt(first)); f.attempt(c);
    close = f.core.sealForClose(f.owner); duplicate = f.core.sealForClose(f.owner); };
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  if (!close || !duplicate) throw new Error('Expected close');
  const plan = ok(close);
  expect(ok(duplicate)).toBe(plan);
  expect(plan.pendingAtSeal.map(item => item.token)).toEqual([outgoing.ticket.token]);
  expect(plan.finalAdmissions).toHaveLength(1);
  expect(f.port.entries).toHaveLength(1);
  expect(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('blocked') }))
    .toMatchObject({ status: 'rejected', reason: 'owner-retiring' });
  f.port.finish('A', { status: 'failed', stage: 'write', error });
  await expect(outgoing.durability).rejects.toBe(error);
  expect(await plan.completion).toMatchObject([{ status: 'settled', receipt: { ticket: outgoing.ticket, status: 'failed', error } }]);
  expect(f.core.sealOutgoing(a.receipt)).toBe(outgoing);
});

it('fence A later C must reseal if B cancelled after admission had settled', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const first = f.attempt(b);
  const old = accepted(f.core.sealOutgoing(a.receipt)); ok(f.core.cancelBindingAttempt(first));
  const c = f.record('C'); const second = f.attempt(c);
  const next = accepted(f.core.sealOutgoing(a.receipt));
  expect(next.ticket.token).not.toBe(old.ticket.token);
  f.port.finish('A'); await old.durability;
  expect(f.core.sealOutgoing(a.receipt)).toBe(next);
  expect(f.core.commitPreparedBinding({ attempt: second, state: state('C') })).toMatchObject({ reason: 'outgoing-not-written' });
  f.port.finish('A'); await next.durability;
  expect(ok(f.core.commitPreparedBinding({ attempt: second, state: state('C') })).record).toBe(c);
});

it('fence A begin rechecks owner and record after reservation reentry', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const versions = ok(f.core.readRecordVersions(b));
  const claim = f.claim('B'); let plan: ReturnType<typeof f.core.sealForClose> | undefined;
  const result = f.core.beginBindingAttempt({ owner: f.owner, record: b, expectedRecordVersions: versions,
    reservation: { claim: claim.claim, owns: () => { plan = f.core.sealForClose(f.owner); return true; } } });
  expect(result).toMatchObject({ status: 'rejected', reason: 'owner-retiring' });
  if (!plan) throw new Error('Expected close');
  expect(f.port.entries).toHaveLength(1); f.port.finish('A'); await ok(plan).completion;
  expect(f.core.sealOutgoing(a.receipt)).toMatchObject({ reason: 'owner-retiring' });
});

it('fence A failed reentrant C version check leaves B current', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const first = f.attempt(b); const c = f.record('C');
  const claim = f.claim('C'); const versions = ok(f.core.readRecordVersions(c));
  let result: ReturnType<typeof f.core.beginBindingAttempt> | undefined;
  f.port.onAdmit = () => { result = f.core.beginBindingAttempt({ owner: f.owner, record: c, expectedRecordVersions: versions,
    reservation: { claim: claim.claim, owns: () => { ok(f.core.advanceRecordVersions({ record: c, expected: versions, changed: ['turn'] })); return true; } } }); };
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  expect(result).toMatchObject({ status: 'rejected', reason: 'version-mismatch' });
  f.port.finish('A'); await outgoing.durability;
  expect(ok(f.core.commitPreparedBinding({ attempt: first, state: state('B') })).record).toBe(b);
});

it('fence A commit rechecks current attempt after reservation reentry', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const c = f.record('C'); const claim = f.claim('B');
  let reenter = false; let second: BindingAttempt | undefined; let next: SaveRequestResult | undefined;
  const first = ok(f.core.beginBindingAttempt({ owner: f.owner, record: b, expectedRecordVersions: ok(f.core.readRecordVersions(b)),
    reservation: { claim: claim.claim, owns: () => { if (reenter) { reenter = false; ok(f.core.cancelBindingAttempt(first));
      second = f.attempt(c); next = f.core.sealOutgoing(a.receipt); } return claim.owns(); } } }));
  const old = accepted(f.core.sealOutgoing(a.receipt)); f.port.finish('A'); await old.durability;
  reenter = true;
  expect(f.core.commitPreparedBinding({ attempt: first, state: state('B') })).toMatchObject({ status: 'rejected', reason: 'stale-attempt' });
  if (!second || !next) throw new Error('Expected C and new outgoing');
  const newer = accepted(next); expect(f.core.sealOutgoing(a.receipt)).toBe(newer);
  f.port.finish('A'); await newer.durability;
  expect(ok(f.core.commitPreparedBinding({ attempt: second, state: state('C') })).record).toBe(c);
});

it('fence A commit rechecks target version after reservation reentry', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const versions = ok(f.core.readRecordVersions(b));
  const claim = f.claim('B'); let reenter = false;
  const attempt = ok(f.core.beginBindingAttempt({ owner: f.owner, record: b, expectedRecordVersions: versions,
    reservation: { claim: claim.claim, owns: () => { if (reenter) {
      reenter = false; ok(f.core.advanceRecordVersions({ record: b, expected: versions, changed: ['turn'] }));
    } return claim.owns(); } } }));
  const outgoing = accepted(f.core.sealOutgoing(a.receipt)); f.port.finish('A'); await outgoing.durability;
  reenter = true;
  expect(f.core.commitPreparedBinding({ attempt, state: state('B') })).toMatchObject({ status: 'rejected', reason: 'version-mismatch' });
  expect(ok(f.core.readBinding(a.receipt)).record).toBe(a.handle);
});

it('C20 cancel during outgoing port admission releases its fence after settlement', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const attempt = f.attempt(b);
  let cancellation: ReturnType<typeof f.core.cancelBindingAttempt> | undefined;
  f.port.onAdmit = () => { cancellation = f.core.cancelBindingAttempt(attempt); };
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  expect(cancellation).toMatchObject({ status: 'ok' });
  expect(f.port.entries).toHaveLength(1);
  f.port.finish('A'); expect(await outgoing.durability).toMatchObject({ status: 'written', ticket: outgoing.ticket });
  expect(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('allowed') }).status).toBe('ok');
  expect(ok(f.core.getSaveReceipt(outgoing.ticket))).toMatchObject({ status: 'settled', receipt: { status: 'written' } });
});

it('C20 cancel during outgoing capture acknowledgement releases its fence after settlement', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const attempt = f.attempt(b); const r = runtime();
  let cancellation: ReturnType<typeof f.core.cancelBindingAttempt> | undefined;
  r.ack.mockImplementationOnce(() => { cancellation = f.core.cancelBindingAttempt(attempt); });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  expect(cancellation).toMatchObject({ status: 'ok' });
  expect(outgoing.captureAcknowledgement).toEqual({ status: 'acknowledged' });
  f.port.finish('A'); expect(await outgoing.durability).toMatchObject({ status: 'written', ticket: outgoing.ticket });
  expect(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('allowed') }).status).toBe('ok');
  expect(ok(f.core.getSaveReceipt(outgoing.ticket))).toMatchObject({ status: 'settled', receipt: { status: 'written' } });
});

it('C20 cancelled outgoing failure remains in close and cannot release the next flight fence', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const attempt = f.attempt(b); const error = new Error('old write');
  let cancellation: ReturnType<typeof f.core.cancelBindingAttempt> | undefined;
  f.port.onAdmit = () => { f.port.onAdmit = undefined; cancellation = f.core.cancelBindingAttempt(attempt); };
  const old = accepted(f.core.sealOutgoing(a.receipt));
  expect(cancellation).toMatchObject({ status: 'ok' });
  const next = accepted(f.core.sealOutgoing(a.receipt));
  expect(next.ticket.token).not.toBe(old.ticket.token);
  const plan = ok(f.core.sealForClose(f.owner));
  expect(plan.acceptedAtSeal).toEqual([old.ticket, next.ticket]);
  f.port.finish('A', { status: 'failed', stage: 'write', error });
  await expect(old.durability).rejects.toBe(error);
  expect(f.core.sealOutgoing(a.receipt)).toBe(next);
  f.port.finish('A'); await next.durability;
  const outcomes = await plan.completion;
  expect(outcomes).toMatchObject([{ status: 'settled', receipt: { ticket: old.ticket, status: 'failed', error } },
    { status: 'settled', receipt: { ticket: next.ticket, status: 'written' } }]);
});

it('C20 cancelling a superseded attempt does not release the current binding fence', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const oldAttempt = f.attempt(b);
  const old = accepted(f.core.sealOutgoing(a.receipt)); f.port.finish('A'); await old.durability;
  const current = ok(f.core.commitPreparedBinding({ attempt: oldAttempt, state: state('B') }));
  const c = f.record('C'); const nextAttempt = f.attempt(c);
  const next = accepted(f.core.sealOutgoing(current));
  expect(f.core.cancelBindingAttempt(oldAttempt)).toMatchObject({ status: 'rejected', reason: 'stale-attempt' });
  expect(f.core.updatePersistableBinding({ binding: current, expectedDirtyRevision: 0, state: state('blocked') })).toMatchObject({ reason: 'binding-sealed' });
  f.port.finish('B'); await next.durability;
  expect(ok(f.core.commitPreparedBinding({ attempt: nextAttempt, state: state('C') })).record).toBe(c);
});

it('C20 cancel releases the outgoing fence while retaining its accepted save', async () => {
  const f = fixture(); const a = f.bind('A'); const b = f.record('B'); const attempt = f.attempt(b);
  const outgoing = accepted(f.core.sealOutgoing(a.receipt));
  expect(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('blocked') })).toMatchObject({ reason: 'binding-sealed' });
  ok(f.core.cancelBindingAttempt(attempt));
  expect(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('allowed') }).status).toBe('ok');
  f.port.finish('A'); expect(await outgoing.durability).toMatchObject({ status: 'written' });
});

it('C21 forged receipt and malformed versions do not change the current slot', () => {
  const f = fixture(); const a = f.bind('A');
  expect(f.core.admitSave({ binding: { ...a.receipt, owner: {} as never } })).toMatchObject({ status: 'rejected' });
  expect(f.core.advanceRecordVersions({ record: a.handle, expected: { binding: NaN, materialization: 0, turn: 0 }, changed: ['binding'] })).toMatchObject({ status: 'rejected', reason: 'version-mismatch' });
  expect(ok(f.core.readRecordVersions(a.handle))).toEqual({ binding: 0, materialization: 0, turn: 0 });
  expect(f.port.entries).toHaveLength(0);
});

it('C21 forged record handle cannot advance, retire or begin an attempt', () => {
  const f = fixture(); const a = f.bind('A');
  const forged = { ...a.handle, id: 'B' };
  expect(f.core.advanceRecordVersions({ record: forged, expected: ok(f.core.readRecordVersions(a.handle)), changed: ['binding'] }).status).toBe('rejected');
  expect(f.core.retireRecord(forged).status).toBe('rejected');
  expect(f.core.beginBindingAttempt({ owner: f.owner, record: forged, expectedRecordVersions: ok(f.core.readRecordVersions(a.handle)), reservation: f.claim('B') }).status).toBe('rejected');
  expect(ok(f.core.readRecordVersions(a.handle))).toEqual({ binding: 0, materialization: 0, turn: 0 });
  expect(f.core.admitSave({ binding: a.receipt }).status).toBe('accepted');
  f.port.finish('A');
});

it.each([false, true])('backfill reservation revalidation throw settles flight with close reentry=%s', async reenterClose => {
  const f = fixture(); const b = f.record('B'); const witness = f.claim('B'); const error = new Error('owns');
  let calls = 0; let close: ReturnType<typeof f.core.sealForClose> | undefined;
  const reservation = { claim: witness.claim, owns: () => {
    calls += 1;
    if (calls === 3) {
      if (reenterClose) close = f.core.sealForClose(f.owner);
      throw error;
    }
    return witness.owns();
  } };
  const attempt = ok(f.core.beginBindingAttempt({ owner: f.owner, record: b,
    expectedRecordVersions: ok(f.core.readRecordVersions(b)), reservation }));
  let result: SaveAdmission | { status: 'threw'; error: unknown };
  try { result = f.core.admitRecordDelta({ attempt, metadata: {} }); }
  catch (thrown) { result = { status: 'threw', error: thrown }; }
  expect(result).toMatchObject({ status: 'rejected', error });
  expect(f.port.entries).toHaveLength(0);
  if (!close) close = f.core.sealForClose(f.owner);
  const plan = ok(close);
  expect(plan.pendingAtSeal).toHaveLength(reenterClose ? 1 : 0);
  const settlements = await Promise.all(plan.pendingAtSeal.map(pending => pending.settlement));
  expect(settlements).toEqual(reenterClose ? [result] : []);
  expect(await plan.completion).toEqual(plan.pendingAtSeal.map(pending => ({ status: 'not-admitted', token: pending.token, rejection: result })));
});

it('reservation revalidation returning true after reentrant close does not admit backfill', async () => {
  const f = fixture(); const b = f.record('B'); const witness = f.claim('B');
  let calls = 0; let close: ReturnType<typeof f.core.sealForClose> | undefined;
  const reservation = { claim: witness.claim, owns: () => {
    calls += 1;
    if (calls === 3) close = f.core.sealForClose(f.owner);
    return witness.owns();
  } };
  const attempt = ok(f.core.beginBindingAttempt({ owner: f.owner, record: b,
    expectedRecordVersions: ok(f.core.readRecordVersions(b)), reservation }));
  const result = f.core.admitRecordDelta({ attempt, metadata: {} });
  expect(result).toMatchObject({ status: 'rejected', reason: 'owner-retiring' });
  if (!close) throw new Error('Expected close');
  const plan = ok(close);
  expect(await plan.pendingAtSeal[0].settlement).toBe(result);
  expect(await plan.completion).toEqual([{ status: 'not-admitted', token: plan.pendingAtSeal[0].token, rejection: result }]);
  expect(f.port.entries).toHaveLength(0);
});

it('snapshot trap throwing during reentrant close settles its registered backfill', async () => {
  const f = fixture(); const b = f.record('B'); const attempt = f.attempt(b); const error = new Error('snapshot');
  let close: ReturnType<typeof f.core.sealForClose> | undefined;
  const metadata = new Proxy({}, { ownKeys: () => { close = f.core.sealForClose(f.owner); throw error; } });
  const result = f.core.admitRecordDelta({ attempt, metadata });
  expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-snapshot', error });
  if (!close) throw new Error('Expected close');
  const plan = ok(close);
  expect(plan.pendingAtSeal).toHaveLength(1);
  expect(await plan.pendingAtSeal[0].settlement).toBe(result);
  expect(await plan.completion).toEqual([{ status: 'not-admitted', token: plan.pendingAtSeal[0].token, rejection: result }]);
  expect(f.port.entries).toHaveLength(0);
});

it('capture throwing during reentrant close settles original and retains final', async () => {
  const f = fixture(); const a = f.bind('A'); const r = runtime(); const error = new Error('capture');
  let close: ReturnType<typeof f.core.sealForClose> | undefined;
  r.capture.mockImplementationOnce(() => { close = f.core.sealForClose(f.owner); throw error; });
  ok(f.core.completeRuntimeAdoption(ok(f.core.beginRuntimeAdoption({ binding: a.receipt, runtime: r.port }))));
  const result = f.core.admitSave({ binding: a.receipt });
  expect(result).toMatchObject({ status: 'rejected', reason: 'runtime-capture-failed', error });
  if (!close) throw new Error('Expected close');
  const plan = ok(close);
  expect(await plan.pendingAtSeal[0].settlement).toBe(result);
  expect(f.port.entries).toHaveLength(1);
  f.port.finish('A');
  expect(await plan.completion).toMatchObject([{ status: 'not-admitted', token: plan.pendingAtSeal[0].token, rejection: result },
    { status: 'settled', receipt: { status: 'written' } }]);
});

it('C21 raw completion rejection keeps the original error and unknown stage', async () => {
  const f = fixture(); const a = f.bind('A'); const error = new Error('raw');
  ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('dirty') }));
  const saved = accepted(f.core.admitSave({ binding: a.receipt }));
  f.port.failRaw('A', error);
  await expect(saved.durability).rejects.toBe(error);
  expect(ok(f.core.getSaveReceipt(saved.ticket))).toMatchObject({ status: 'settled', receipt: { status: 'failed', stage: 'unknown', error } });
  expect(ok(f.core.readPersistenceStatus(a.receipt)).dirty).toBe(true);
});

it('C12 cyclic, bigint, toJSON and thrown proxy snapshots are rejected without side effects', () => {
  const f = fixture(); const b = f.record('B'); const attempt = f.attempt(b);
  const toJSON = jest.fn(); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const error = new Error('proxy');
  const values = [cyclic, BigInt(1), { toJSON }];
  for (const value of values) {
    const result = f.core.admitRecordDelta({ attempt, metadata: { usage: { op: 'set', value } } as never });
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid-snapshot' });
  }
  const proxy = new Proxy({}, { ownKeys: () => { throw error; } });
  expect(f.core.admitRecordDelta({ attempt, metadata: { usage: { op: 'set', value: proxy } } as never }))
    .toMatchObject({ status: 'rejected', reason: 'invalid-snapshot', error });
  expect(toJSON).not.toHaveBeenCalled(); expect(f.port.entries).toHaveLength(0);
});

it('C22 admission settlement precedes independent controlled writer completion', async () => {
  const f = fixture(); const a = f.bind('A');
  ok(f.core.updatePersistableBinding({ binding: a.receipt, expectedDirtyRevision: 0, state: state('changed') }));
  let pending: ReturnType<typeof f.core.sealOutgoing> | undefined;
  let close: ReturnType<typeof f.core.sealForClose> | undefined;
  f.port.onAdmit = () => { pending = f.core.sealOutgoing(a.receipt); close = f.core.sealForClose(f.owner); };
  const saved = accepted(f.core.sealOutgoing(a.receipt));
  if (!pending || pending.status !== 'admitting' || !close) throw new Error('Expected pending and close');
  expect(await pending.settlement).toBe(saved);
  const plan = ok(close);
  let done = false; void plan.completion.then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(ok(f.core.getSaveReceipt(saved.ticket))).toEqual({ status: 'pending' });
  f.port.finish('A');
  expect(await saved.durability).toMatchObject({ status: 'written', ticket: saved.ticket });
  expect(await plan.completion).toMatchObject([{ status: 'settled', receipt: { status: 'written', ticket: saved.ticket } }]);
  expect(ok(f.core.readPersistenceStatus(a.receipt)).dirty).toBe(false);
});

it('C18 close drains failures and pending saves without short circuit', async () => {
  const f = fixture(); const a = f.bind('A');
  const one = accepted(f.core.admitSave({ binding: a.receipt }));
  const two = accepted(f.core.admitSave({ binding: a.receipt }));
  const plan = ok(f.core.sealForClose(f.owner));
  expect(ok(f.core.sealForClose(f.owner))).toBe(plan);
  expect(plan.acceptedAtSeal).toHaveLength(2);
  const error = new Error('fail');
  f.port.finish('A', { status: 'failed', stage: 'write', error });
  await expect(one.durability).rejects.toBe(error);
  let done = false; void plan.completion.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  f.port.finish('A'); await two.durability;
  f.port.finish('A');
  const receipts = await plan.completion;
  expect(receipts).toHaveLength(3); expect(receipts.some(item => item.status === 'settled' && item.receipt.status === 'failed' && item.receipt.error === error)).toBe(true);
});
