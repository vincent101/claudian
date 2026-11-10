/**
 * PersistenceCoordinator — same-host write-ordering coordinator (S slice).
 *
 * Production metadata writes reach disk through several long-lived storage
 * instances (`SharedStorageService.sessions` and the provider `StorageService`
 * both construct their own `SessionStorage`, plus the layout RMWs write the
 * plugin data.json). Instance-local FIFOs could not order writes across those
 * instances: two instances writing the same record could land write 1 after
 * write 2, or resurrect a record a delete had already removed.
 *
 * Contract (takeover §2.7, P6 §6.4): the write order is held by one
 * long-lived coordinator per host App; every metadata save/delete/create,
 * legacy migration and layout RMW routes through it, and reads honor a read
 * barrier so a newly constructed instance never observes a stale file while a
 * previously admitted write is still in flight.
 *
 * Host scoping: one coordinator per host object (the Obsidian `App`), so all
 * storage instances over the same app share the same lanes regardless of when
 * each instance was constructed. The resource key is the vault-relative
 * target (the metadata file path, or the layout resource below) and doubles
 * as the vault/plugin namespace discriminator — a different vault's writes
 * use different paths and never contend with these lanes.
 */

/** Shared resource for the plugin data.json tabManagerState RMW. */
export const TAB_LAYOUT_RESOURCE = 'plugin-data/tabManagerState';

export class PersistenceCoordinator {
  private static readonly byHost = new WeakMap<object, PersistenceCoordinator>();

  /** One long-lived coordinator per host App; instances over the same app share it. */
  static forHost(host: object): PersistenceCoordinator {
    let coordinator = PersistenceCoordinator.byHost.get(host);
    if (!coordinator) {
      coordinator = new PersistenceCoordinator();
      PersistenceCoordinator.byHost.set(host, coordinator);
    }
    return coordinator;
  }

  private readonly lanes = new Map<string, Promise<void>>();

  /**
   * Enqueues a write job on the resource's FIFO lane. The returned promise
   * settles with the job's own outcome — failures reject with the original
   * error identity and the caller must observe them; the lane itself never
   * gets poisoned and later jobs still run.
   */
  enqueue(resource: string, job: () => Promise<void>): Promise<void> {
    const previous = this.lanes.get(resource) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(job);
    const tracked = task.finally(() => {
      if (this.lanes.get(resource) === tracked) this.lanes.delete(resource);
    });
    this.lanes.set(resource, tracked);
    return tracked;
  }

  /**
   * Read barrier: resolves once every write admitted to the resource before
   * this call has settled. It never rejects — a reader must not inherit a
   * previous write's failure, it just proceeds against whatever is on disk.
   */
  drain(resource: string): Promise<void> {
    const tail = this.lanes.get(resource);
    return tail ? tail.catch(() => undefined) : Promise.resolve();
  }

  /** Read barrier across every lane whose resource starts with the prefix. */
  drainMatching(prefix: string): Promise<void> {
    const tails: Promise<void>[] = [];
    for (const [resource, tail] of this.lanes) {
      if (resource.startsWith(prefix)) tails.push(tail);
    }
    return Promise.all(tails.map(tail => tail.catch(() => undefined))).then(() => undefined);
  }
}

/**
 * Host key for a storage adapter: a real VaultFileAdapter exposes its App via
 * `host`, so every instance constructed over the same app shares one
 * coordinator. Adapters without a host (plain test fakes) fall back to the
 * adapter object itself, preserving the previous per-instance isolation.
 */
export function resolvePersistenceHost(adapter: unknown): object {
  const host = (adapter as { host?: unknown } | null)?.host;
  return typeof host === 'object' && host !== null ? host : (adapter as object);
}
