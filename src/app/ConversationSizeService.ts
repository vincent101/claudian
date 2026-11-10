import type {
  ConversationSizeReadInput,
  ConversationSizeSnapshot,
  ConversationSizeSource,
  ProviderConversationHistoryService,
  ProviderId,
} from '../core/providers/types';
import type { Conversation } from '../core/types';
import { sizeSourceString } from '../utils/conversationSizeSource';

interface ConversationSizeDependencies {
  getConversation(id: string): Conversation | null;
  getHistoryService(providerId: ProviderId): ProviderConversationHistoryService;
  getVaultPath(): string | null;
  onPublished(id: string, snapshot: ConversationSizeSnapshot): void;
}

interface CapturedSource {
  input: ConversationSizeReadInput;
  identity: symbol;
  key: string;
  vaultPath: string | null;
}

interface ConversationSizeGeneration {
  revision: number;
  sourceKey: string;
}

interface PublishedSnapshot {
  snapshot: ConversationSizeSnapshot;
  sourceKey: string;
}

interface PendingRequest {
  generation: ConversationSizeGeneration;
  identity: symbol;
  promise: Promise<ConversationSizeSnapshot | undefined>;
}

/** Coordinates current native file readings in memory without loading history. */
export class ConversationSizeService {
  private readonly revisions = new Map<string, number>();
  private readonly identities = new WeakMap<Conversation, symbol>();
  // Reading identities must not keep deleted conversations and their chat bodies alive.
  private readonly snapshots = new WeakMap<Conversation, PublishedSnapshot>();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly deps: ConversationSizeDependencies) {}

  private getIdentity(conversation: Conversation): symbol {
    let identity = this.identities.get(conversation);
    if (!identity) {
      identity = Symbol();
      this.identities.set(conversation, identity);
    }
    return identity;
  }

  private sourceKey(input: ConversationSizeReadInput, vaultPath: string | null): string {
    return JSON.stringify({ id: input.id, providerId: input.providerId, source: input.source, vaultPath });
  }

  private captureConversationSource(conversation: Conversation): CapturedSource | null {
    const vaultPath = this.deps.getVaultPath();
    try {
      const service = this.deps.getHistoryService(conversation.providerId);
      const provided = service.captureConversationSizeSource?.(conversation);
      if (!provided) return null;
      // Async work keeps only scalar provenance, even if a provider adds fields.
      const source: ConversationSizeSource = Object.freeze({
        sessionId: sizeSourceString(provided.sessionId),
        filePath: sizeSourceString(provided.filePath),
      });
      const input = Object.freeze({ id: conversation.id, providerId: conversation.providerId, source });
      return {
        key: this.sourceKey(input, vaultPath), vaultPath, input,
        identity: this.getIdentity(conversation),
      };
    } catch {
      return null;
    }
  }

  private captureSource(id: string): CapturedSource | null {
    const conversation = this.deps.getConversation(id);
    return conversation ? this.captureConversationSource(conversation) : null;
  }

  private getRevision(id: string): number {
    return this.revisions.get(id) ?? 0;
  }

  private isCurrent(id: string, generation: ConversationSizeGeneration, identity: symbol): boolean {
    if (this.getRevision(id) !== generation.revision) return false;
    const source = this.captureSource(id);
    return source?.key === generation.sourceKey && source.identity === identity;
  }

  getSnapshot(id: string): ConversationSizeSnapshot | undefined {
    const conversation = this.deps.getConversation(id);
    if (!conversation) return undefined;
    const source = this.captureConversationSource(conversation);
    if (!source) return undefined;
    const published = this.snapshots.get(conversation);
    if (!published || published.snapshot.revision !== this.getRevision(id)) return undefined;
    return source.key === published.sourceKey ? published.snapshot : undefined;
  }

  invalidate(id: string): void {
    this.revisions.set(id, this.getRevision(id) + 1);
    const conversation = this.deps.getConversation(id);
    if (conversation) this.snapshots.delete(conversation);
  }

  refresh(id: string, fresh = false): Promise<ConversationSizeSnapshot | undefined> {
    // A newly opened surface or real hover owns a new observation, not a
    // delayed stat started by a surface that has since closed or rebound.
    if (fresh) this.invalidate(id);
    const source = this.captureSource(id);
    if (!source) return Promise.resolve(undefined);
    const generation: ConversationSizeGeneration = {
      revision: this.getRevision(id), sourceKey: source.key,
    };
    return this.requestRefresh(id, source, generation);
  }

  private requestRefresh(
    id: string,
    source: CapturedSource,
    generation: ConversationSizeGeneration,
  ): Promise<ConversationSizeSnapshot | undefined> {
    const pending = this.requests.get(id);
    if (pending && pending.generation.revision === generation.revision
      && pending.generation.sourceKey === generation.sourceKey
      && pending.identity === source.identity) return pending.promise;

    const request: PendingRequest = {
      generation, identity: source.identity,
      promise: this.performRefresh(id, source, generation),
    };
    this.requests.set(id, request);
    void request.promise.finally(() => {
      if (this.requests.get(id) === request) this.requests.delete(id);
    });
    return request.promise;
  }

  private async acquire(): Promise<void> {
    if (this.active < 2) {
      this.active += 1;
      return;
    }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  private publishSnapshot(
    id: string,
    source: CapturedSource,
    generation: ConversationSizeGeneration,
    snapshot: ConversationSizeSnapshot,
  ): ConversationSizeSnapshot | undefined {
    if (this.getRevision(id) !== generation.revision
      || snapshot.conversationId !== id || snapshot.revision !== generation.revision) return undefined;
    // Reacquire the object only for this synchronous commit, never across an await.
    const conversation = this.deps.getConversation(id);
    if (!conversation) return undefined;
    const current = this.captureConversationSource(conversation);
    if (!current || current.identity !== source.identity || current.key !== generation.sourceKey) return undefined;
    this.snapshots.set(conversation, { snapshot, sourceKey: generation.sourceKey });
    this.deps.onPublished(id, snapshot);
    return snapshot;
  }

  private async performRefresh(
    id: string,
    source: CapturedSource,
    generation: ConversationSizeGeneration,
  ): Promise<ConversationSizeSnapshot | undefined> {
    const isCurrent = () => this.isCurrent(id, generation, source.identity);
    await this.acquire();
    try {
      if (!isCurrent()) return undefined;
      const service = this.deps.getHistoryService(source.input.providerId);
      const snapshot: ConversationSizeSnapshot = service.readConversationSize
        ? (await service.readConversationSize(source.input, source.vaultPath, { revision: generation.revision })).snapshot
        : { conversationId: id, revision: generation.revision, files: { status: 'unknown', reason: 'unsupported' } };
      if (!isCurrent()) return undefined;
      return this.publishSnapshot(id, source, generation, snapshot);
    } catch {
      return undefined;
    } finally {
      this.release();
    }
  }
}
