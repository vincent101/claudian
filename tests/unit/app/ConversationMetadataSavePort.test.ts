import { ConversationMetadataSavePort } from '@/app/ConversationMetadataSavePort';
import type { MetadataAdmission, SaveIntent } from '@/core/providers/types';
import type { ChatMessage, Conversation } from '@/core/types';
import type ClaudianPlugin from '@/main';

/**
 * Production-mirror unit for the stage-1 MetadataSavePort adapter (R2
 * wiring): the adapter must reduce the frozen intent onto the latest base
 * through the real plugin update chain, report skipped/failed honestly, and
 * serialize admissions in FIFO order. The plugin seam is stubbed; the adapter
 * itself is never mocked.
 */
type UpdateCall = { id: string; updates: Partial<Conversation> };

function createPluginStub(options: {
  conversations?: Conversation[];
  failing?: Error;
  writes?: UpdateCall[];
}): ClaudianPlugin {
  const writes = options.writes ?? [];
  const stub = {
    getConversationSync: (id: string) => options.conversations?.find(conversation => conversation.id === id) ?? null,
    async updateConversation(id: string, updates: Partial<Conversation>) {
      writes.push({ id, updates });
      if (options.failing) throw options.failing;
    },
  };
  return stub as unknown as ClaudianPlugin;
}

function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    providerId: 'codex',
    title: `title-${id}`,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    messages: [],
    ...overrides,
  };
}

function accepted(admission: MetadataAdmission): Extract<MetadataAdmission, { status: 'accepted' }> {
  if (admission.status !== 'accepted') throw new Error(`admission rejected: ${admission.reason}`);
  return admission;
}

function intent(overrides: Partial<SaveIntent> & { recordId: string }): SaveIntent {
  return {
    token: Object.freeze({}) as SaveIntent['token'],
    record: {
      id: overrides.recordId,
      providerId: 'codex',
      token: Object.freeze({}) as never,
    },
    expectedRecordVersions: { binding: 0, materialization: 0, turn: 0 },
    owner: Object.freeze({}) as SaveIntent['owner'],
    metadata: {},
    reason: 'normal',
    binding: Object.freeze({}) as never,
    dirtyRevision: 0,
    session: { kind: 'seed', patch: { sessionId: { op: 'keep' }, providerFields: {} } },
    ...overrides,
  } as SaveIntent;
}

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: 'user' as const,
    content: `content-${index}`,
    timestamp: index,
  }));
}

describe('ConversationMetadataSavePort (production MetadataSavePort adapter)', () => {
  it('reduces a metadata patch onto the latest base through plugin.updateConversation', async () => {
    const base = conversation('record-1', { messageCount: 2 });
    const writes: UpdateCall[] = [];
    const port = new ConversationMetadataSavePort({ plugin: createPluginStub({ conversations: [base], writes }) });
    const admission = accepted(port.admit(intent({
      recordId: 'record-1',
      metadata: {
        messageCount: { op: 'set', value: 5 },
        currentNote: { op: 'delete' },
        preview: { op: 'keep' },
      },
    })));
    const result = await admission.completion;
    expect(result).toMatchObject({ status: 'written', confirmedRevision: 1 });
    expect(writes).toHaveLength(1);
    const updates = writes[0].updates as Record<string, unknown>;
    expect(updates.messageCount).toBe(5);
    expect(updates.currentNote).toBeUndefined();
    expect('preview' in updates).toBe(false);
  });

  it('applies a seed session patch on top of the base providerState', async () => {
    const base = conversation('record-2', {
      sessionId: 'session-old',
      providerState: { threadId: 'session-old', sessionFilePath: '/tmp/old.jsonl', staleField: 'x' },
    });
    const writes: UpdateCall[] = [];
    const port = new ConversationMetadataSavePort({ plugin: createPluginStub({ conversations: [base], writes }) });
    await accepted(port.admit(intent({
      recordId: 'record-2',
      session: {
        kind: 'seed',
        patch: {
          sessionId: { op: 'set', value: 'session-new' },
          providerFields: { threadId: { op: 'set', value: 'session-new' }, staleField: { op: 'delete' } },
        },
      },
    }))).completion;
    const updates = writes[0].updates as Record<string, unknown>;
    expect(updates.sessionId).toBe('session-new');
    expect(updates.providerState).toEqual({ threadId: 'session-new', sessionFilePath: '/tmp/old.jsonl' });
  });

  it('applies the frozen runtime capture as the provider-owned session reduction', async () => {
    const base = conversation('record-3');
    const writes: UpdateCall[] = [];
    const port = new ConversationMetadataSavePort({ plugin: createPluginStub({ conversations: [base], writes }) });
    await accepted(port.admit(intent({
      recordId: 'record-3',
      session: {
        kind: 'runtime',
        capture: {
          protocolVersion: 1,
          providerId: 'codex',
          facts: { sessionId: 'session-live', providerState: { threadId: 'session-live' } } as never,
          invalidation: { revision: 0, invalidated: false },
        },
      },
    }))).completion;
    const updates = writes[0].updates as Record<string, unknown>;
    expect(updates.sessionId).toBe('session-live');
    expect(updates.providerState).toEqual({ threadId: 'session-live' });
  });

  it('resolves a missing base record as skipped, never a fabricated write', async () => {
    const writes: UpdateCall[] = [];
    const port = new ConversationMetadataSavePort({ plugin: createPluginStub({ writes }) });
    const result = await accepted(port.admit(intent({ recordId: 'missing' }))).completion;
    expect(result).toMatchObject({ status: 'skipped', reason: 'missing' });
    expect(writes).toHaveLength(0);
  });

  it('reports a write failure with the original error identity', async () => {
    const failure = new Error('fixture write failure');
    const base = conversation('record-4');
    const port = new ConversationMetadataSavePort({
      plugin: createPluginStub({ conversations: [base], failing: failure }),
    });
    const result = await accepted(port.admit(intent({ recordId: 'record-4' }))).completion;
    expect(result).toMatchObject({ status: 'failed', stage: 'write', error: failure });
  });

  it('captures the materialization snapshot at admission and never at write time', async () => {
    const base = conversation('record-5');
    const writes: UpdateCall[] = [];
    let live = messages(1);
    const port = new ConversationMetadataSavePort({ plugin: createPluginStub({ conversations: [base], writes }) });
    port.registerMaterializationSource('record-5', () => live);
    const admission = accepted(port.admit(intent({ recordId: 'record-5' })));
    // Mutating the caller array after admission must not change the frozen job.
    live = messages(3);
    await admission.completion;
    const updates = writes[0].updates as Record<string, unknown>;
    expect(updates.messages).toHaveLength(1);
  });

  it('leaves the persisted messages untouched for native sessions and diverged displays', async () => {
    const native = conversation('record-6', { sessionId: 'session-native' });
    const sessionless = conversation('record-7');
    const writes: UpdateCall[] = [];
    const port = new ConversationMetadataSavePort({
      plugin: createPluginStub({ conversations: [native, sessionless], writes }),
    });
    port.registerMaterializationSource('record-6', () => messages(2));
    port.registerMaterializationSource('record-7', () => null);
    await accepted(port.admit(intent({ recordId: 'record-6' }))).completion;
    await accepted(port.admit(intent({ recordId: 'record-7' }))).completion;
    expect(writes[0].updates.messages).toEqual([]);
    expect('messages' in writes[1].updates).toBe(false);
  });

  it('freezes message objects at admission — later in-place mutations cannot reach the write', async () => {
    // P6 §6.2: a shallow array copy is insufficient — the FIFO window between
    // admission and write shares the message object references, so an in-place
    // mutation would land on disk. The captured materialization must be a
    // detached copy of the message graph.
    const base = conversation('record-9');
    const writes: UpdateCall[] = [];
    const gate = new Promise<void>(done => { setTimeout(done, 0); });
    const stub = createPluginStub({ conversations: [base] });
    (stub as unknown as { updateConversation: (id: string, updates: Partial<Conversation>) => Promise<void> })
      .updateConversation = async (id, updates) => {
      writes.push({ id, updates });
      await gate;
    };
    const port = new ConversationMetadataSavePort({ plugin: stub });
    const live: ChatMessage[] = [{
      id: 'fixture-message', role: 'user', content: 'fixture original content', timestamp: 1,
    }];
    port.registerMaterializationSource('record-9', () => live);
    const admission = accepted(port.admit(intent({ recordId: 'record-9' })));
    // The write job is pending inside the FIFO; mutate the caller graph now.
    live[0].content = 'fixture mutated content';
    live.push({ id: 'fixture-late', role: 'user', content: 'fixture late content', timestamp: 2 });
    await admission.completion;
    const written = (writes[0].updates.messages as ChatMessage[])[0] as { content?: string };
    expect(written.content).toBe('fixture original content');
    expect((writes[0].updates.messages as ChatMessage[])).toHaveLength(1);
  });

  it('rejects the whole materialization when one message is not plain JSON — no silent null element', async () => {
    // P6 snapshot semantics: "rejected — not copied at all". A non-plain
    // message (accessor, cycle, non-plain prototype) inside the array must
    // never degrade into a [msg, null] payload on disk.
    const base = conversation('record-10');
    const writes: UpdateCall[] = [];
    const port = new ConversationMetadataSavePort({ plugin: createPluginStub({ conversations: [base], writes }) });
    const poisoned: Record<string, unknown> = {
      id: 'fixture-poisoned', role: 'user', content: 'fixture poisoned', timestamp: 2,
    };
    Object.defineProperty(poisoned, 'content', { get: () => 'fixture poisoned', enumerable: true });
    port.registerMaterializationSource('record-10', () => [
      { id: 'fixture-plain', role: 'user', content: 'fixture plain', timestamp: 1 },
      poisoned as unknown as ChatMessage,
    ]);
    const result = await accepted(port.admit(intent({ recordId: 'record-10' }))).completion;
    expect(result.status).toBe('written');
    // The messages axis must be dropped entirely, never partially copied.
    expect('messages' in writes[0].updates).toBe(false);
  });

  it('executes admitted writes in FIFO order with monotonically increasing sequences', async () => {
    const base = conversation('record-8');
    const writes: UpdateCall[] = [];
    const port = new ConversationMetadataSavePort({ plugin: createPluginStub({ conversations: [base], writes }) });
    const first = port.admit(intent({ recordId: 'record-8', metadata: { messageCount: { op: 'set', value: 1 } } }));
    const second = port.admit(intent({ recordId: 'record-8', metadata: { messageCount: { op: 'set', value: 2 } } }));
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    const firstAdmission = first as { sequence: number; completion: Promise<{ confirmedRevision: number }> };
    const secondAdmission = second as { sequence: number; completion: Promise<{ confirmedRevision: number }> };
    expect(secondAdmission.sequence).toBeGreaterThan(firstAdmission.sequence);
    const [firstResult, secondResult] = await Promise.all([firstAdmission.completion, secondAdmission.completion]);
    expect(firstResult.confirmedRevision).toBeLessThan(secondResult.confirmedRevision);
    expect((writes[0].updates as Record<string, unknown>).messageCount).toBe(1);
    expect((writes[1].updates as Record<string, unknown>).messageCount).toBe(2);
  });
});
