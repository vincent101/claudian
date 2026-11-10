import type {
  FieldPatch,
  JsonValue,
  MetadataAdmission,
  MetadataSavePort,
  MetadataWriteResult,
  PersistableMetadataKey,
  SaveIntent,
  SessionBindingPatch,
} from '../core/providers/types';
import type { ChatMessage, Conversation } from '../core/types';
import type ClaudianPlugin from '../main';

type MaterializationSource = () => ChatMessage[] | null | undefined;

/**
 * Diagnostics this adapter can emit. Injected as a callback by the composition
 * root so the app-layer adapter stays free of runtime imports from the
 * features layer; the event shape matches the shared history-diagnostics
 * channel (kind + machine-readable reason only, never record ids or content).
 */
export type SavePortDiagnosticEvent =
  | { kind: 'save_adoption_target_mismatch' }
  | { kind: 'save_materialization_rejected'; reason: 'not_plain_json' | 'source_error' };

/**
 * Plain-JSON deep copy (P6 snapshot rules): own enumerable data properties
 * only; getters, functions, non-plain prototypes and cycles are rejected —
 * a payload that cannot be detached honestly is not copied at all.
 */
function deepCopyPlainJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return null;
  seen.add(value);
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      seen.delete(value);
      return null;
    }
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !('value' in descriptor)) {
        seen.delete(value);
        return null;
      }
      const nested = deepCopyPlainJson(descriptor.value, seen);
      // Null-ambiguity mirror of the object branch: a null result for a
      // non-null element means that element was rejected (accessor, cycle,
      // non-plain value) — the whole snapshot is rejected, never degraded to
      // a [message, null] payload.
      if (nested === null && descriptor.value !== null) {
        seen.delete(value);
        return null;
      }
      copy.push(nested);
    }
    seen.delete(value);
    return copy;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || !descriptor.enumerable) {
      seen.delete(value);
      return null;
    }
    if (descriptor.value === undefined) continue; // undefined ≈ absent in JSON
    const nested = deepCopyPlainJson(descriptor.value, seen);
    if (nested === null && descriptor.value !== null) {
      seen.delete(value);
      return null;
    }
    copy[key] = nested;
  }
  seen.delete(value);
  return copy;
}

/**
 * Production MetadataSavePort bridging the P6-0 save-admission core onto the
 * existing plugin metadata write chain (R2 wiring, stage 1).
 *
 * Contract notes:
 * - admit() only normalizes and enqueues synchronously into one instance-level
 *   FIFO; the write (reduce against the latest in-memory base → serialize via
 *   plugin.updateConversation) happens in the lane. Sequence numbers therefore
 *   reflect actual admission order inside this single writer instance.
 * - Cross-instance write ordering and the full PersistenceCoordinator lane
 *   (same-host App + namespace write sequencing, read barrier) belong to the
 *   S slice and are explicitly not covered here yet.
 * - A missing base record resolves as skipped('missing') — never a silent
 *   success and never a fabricated write.
 */
export class ConversationMetadataSavePort implements MetadataSavePort {
  private readonly plugin: ClaudianPlugin;
  private readonly onDiagnostic: ((event: SavePortDiagnosticEvent) => void) | null;
  private readonly confirmedRevisions = new Map<string, number>();
  private readonly materializationSources = new Map<string, MaterializationSource>();
  private sequence = 0;
  private queueDepth = 0;
  private lane: Promise<void> = Promise.resolve();

  constructor(deps: { plugin: ClaudianPlugin; onDiagnostic?: (event: SavePortDiagnosticEvent) => void }) {
    this.plugin = deps.plugin;
    this.onDiagnostic = deps.onDiagnostic ?? null;
  }

  /**
   * The messages axis is deliberately outside MetadataPatch (P6 §3.1), so the
   * controller registers a synchronous, binding-consistent materialization
   * getter per record. The value is captured at admission time and frozen into
   * the FIFO job; a getter returning null/undefined leaves the persisted
   * messages untouched.
   */
  registerMaterializationSource(recordId: string, source: MaterializationSource): void {
    this.materializationSources.set(recordId, source);
  }

  admit(intent: SaveIntent): MetadataAdmission {
    const sequence = ++this.sequence;
    // Captured synchronously at admission — the FIFO job only sees the frozen
    // array; later display mutations cannot leak into an accepted save.
    const materialization = this.captureMaterialization(intent);
    // Empty-queue fast path: the first admitted job IS the FIFO head and
    // starts immediately; later admissions chain behind it in order.
    const idle = this.queueDepth === 0;
    const completion = idle
      ? this.write(intent, materialization)
      : this.lane.then(
        () => this.write(intent, materialization),
        () => this.write(intent, materialization),
      );
    this.queueDepth += 1;
    this.lane = completion.then(() => undefined, () => {
      // The lane never rejects; failures surface through the completion only.
    });
    void this.lane.then(() => {
      this.queueDepth = Math.max(0, this.queueDepth - 1);
    });
    return { status: 'accepted', sequence, completion };
  }

  private captureMaterialization(intent: SaveIntent): ChatMessage[] | null {
    try {
      const messages = this.materializationSources.get(intent.record.id)?.();
      if (!messages) return null;
      // P6 §6.2: a shallow array copy is insufficient — the FIFO window shares
      // the message object references. Deep-copy the plain-JSON message graph
      // so an in-place mutation after admission cannot reach the write.
      const copied = deepCopyPlainJson(messages, new Set());
      if (!Array.isArray(copied)) {
        // Rejected — not copied at all: an untrustworthy message graph drops
        // the messages axis for this save instead of persisting a partial
        // payload. Traced (never the values), because a silent drop hides
        // exactly the corruption the snapshot rules exist to prevent.
        this.emitDiagnostic({ kind: 'save_materialization_rejected', reason: 'not_plain_json' });
        return null;
      }
      return copied as ChatMessage[];
    } catch {
      this.emitDiagnostic({ kind: 'save_materialization_rejected', reason: 'source_error' });
      return null;
    }
  }

  private emitDiagnostic(event: SavePortDiagnosticEvent): void {
    try {
      this.onDiagnostic?.(event);
    } catch {
      // Diagnostics must never alter the save outcome.
    }
  }

  private async write(intent: SaveIntent, materialization: ChatMessage[] | null): Promise<MetadataWriteResult> {
    const base = this.plugin.getConversationSync(intent.record.id);
    if (!base) return { status: 'skipped', reason: 'missing' };

    const updates: Partial<Conversation> = {};
    this.applyMetadataPatch(intent, updates);
    this.applySessionInput(intent, base, updates);
    this.applyMaterialization(base, updates, materialization);

    try {
      await this.plugin.updateConversation(intent.record.id, updates);
    } catch (error) {
      return { status: 'failed', stage: 'write', error };
    }
    const confirmed = (this.confirmedRevisions.get(intent.record.id) ?? 0) + 1;
    this.confirmedRevisions.set(intent.record.id, confirmed);
    return { status: 'written', confirmedRevision: confirmed };
  }

  private applyMetadataPatch(intent: SaveIntent, updates: Partial<Conversation>): void {
    for (const key of Object.keys(intent.metadata) as PersistableMetadataKey[]) {
      const patch = intent.metadata[key];
      if (!patch || patch.op === 'keep') continue;
      if (patch.op === 'delete') {
        (updates as Record<string, unknown>)[key] = undefined;
      } else {
        (updates as Record<string, unknown>)[key] = patch.value;
      }
    }
  }

  private applySessionInput(intent: SaveIntent, base: Conversation, updates: Partial<Conversation>): void {
    if (intent.session.kind === 'none') return;
    if (intent.session.kind === 'seed') {
      this.applyBindingPatch(intent.session.patch, base, updates);
      return;
    }
    // Runtime capture: the frozen provider-owned reduction result, computed
    // synchronously at admission against the adopted runtime. Applied as-is —
    // the provider already reduced it against the conversation base.
    const captured = intent.session.capture.facts as { sessionId?: string | null; providerState?: unknown };
    if (captured && typeof captured === 'object' && 'sessionId' in captured) {
      // null encodes "no session"/"cleared providerState" from the capture
      // normalization (Partial<Conversation> assigns clear via undefined).
      updates.sessionId = captured.sessionId ?? null;
      updates.providerState = captured.providerState === null
        ? undefined
        : captured.providerState as Record<string, unknown>;
    }
  }

  private applyBindingPatch(patch: SessionBindingPatch, base: Conversation, updates: Partial<Conversation>): void {
    if (patch.sessionId && patch.sessionId.op !== 'keep') {
      updates.sessionId = patch.sessionId.op === 'delete' ? undefined : patch.sessionId.value;
    }
    const fields = Object.entries(patch.providerFields) as [string, FieldPatch<JsonValue>][];
    if (fields.length === 0) return;
    const providerState: Record<string, unknown> = { ...(base.providerState ?? {}) };
    for (const [key, field] of fields) {
      if (field.op === 'keep') continue;
      if (field.op === 'delete') delete providerState[key];
      else providerState[key] = field.value;
    }
    updates.providerState = providerState;
  }

  private applyMaterialization(
    base: Conversation,
    updates: Partial<Conversation>,
    materialization: ChatMessage[] | null,
  ): void {
    if (!materialization) return;
    // Native sessions keep no message array in metadata (the SDK owns them);
    // non-native conversations persist the binding's materialized view.
    updates.messages = base.sessionId ? [] : materialization;
  }
}
