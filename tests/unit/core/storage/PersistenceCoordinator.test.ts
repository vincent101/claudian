import '@/providers';

import type { Plugin } from 'obsidian';

import { SharedStorageService } from '@/app/storage/SharedStorageService';
import { SESSIONS_PATH, SessionStorage } from '@/core/bootstrap/SessionStorage';
import type { AppTabManagerState } from '@/core/providers/types';
import {
  PersistenceCoordinator,
  resolvePersistenceHost,
  TAB_LAYOUT_RESOURCE,
} from '@/core/storage/PersistenceCoordinator';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SessionMetadata } from '@/core/types';
import { StorageService } from '@/providers/claude/storage/StorageService';

/**
 * S slice acceptance (takeover §3 S row / P6 §6.4):
 * - cross-instance write ordering: two storage instances over one host app —
 *   write 1 then write 2 must land as 2;
 * - failures still reject with the original error and never poison the lane;
 * - new-instance reads honor a read barrier (no stale read racing a write);
 * - same-record delete after an in-flight save must not resurrect the file;
 * - layout RMW serialized through one host lane (no lost update), including
 *   across SharedStorageService and StorageService;
 * - an unload-style fire-and-forget layout save is still ordered, so a reopen
 *   read observes the persisted (lazy) id.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

type VaultFixtureOptions = { gateWrites?: boolean; failFirstWrite?: Error };

function createVaultFixture(options: VaultFixtureOptions = {}) {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const writeLog: string[] = [];
  const gate = deferred();
  let writeCalls = 0;

  const adapter = {
    exists: async (path: string) => files.has(path) || folders.has(path),
    read: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing file: ${path}`);
      return content;
    },
    write: async (path: string, content: string) => {
      writeCalls += 1;
      writeLog.push(`write:start:${writeCalls}`);
      if (options.gateWrites) await gate.promise;
      if (writeCalls === 1 && options.failFirstWrite) throw options.failFirstWrite;
      files.set(path, content);
      writeLog.push(`write:end:${writeCalls}`);
    },
    remove: async (path: string) => {
      files.delete(path);
      writeLog.push(`remove:${path}`);
    },
    mkdir: async (path: string) => {
      folders.add(path);
    },
    list: async (path: string) => {
      const prefix = `${path}/`;
      const listed = Array.from(files.keys())
        .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'));
      return { files: listed, folders: [] };
    },
  };
  const app = { vault: { adapter } };

  return {
    files,
    writeLog,
    app,
    gate,
    getWriteCalls: () => writeCalls,
  };
}

function meta(id: string, title: string): SessionMetadata {
  return { id, title, createdAt: 1700000000, updatedAt: 1700000000 };
}

function layout(tabId: string, conversationId: string): AppTabManagerState {
  return { openTabs: [{ tabId, conversationId }], activeTabId: tabId };
}

async function flushMicrotasks(): Promise<void> {
  // Deep enough for a queued write to pass the enqueue chain plus the adapter's
  // ensureFolder exists/mkdir hops and reach the gated fake write.
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve();
  }
}

type PluginFixture = {
  plugin: unknown;
  loadDataSnapshots: string[];
  readData: () => Record<string, unknown> | null;
  failNextSave: () => void;
};

function createPluginFixture(initialData: Record<string, unknown> | null): PluginFixture {
  let dataStore: Record<string, unknown> | null = initialData;
  let savesToFail = 0;
  const loadDataSnapshots: string[] = [];
  const emptyAdapter = {
    exists: async () => false,
    read: async () => { throw new Error('no vault files in this fixture'); },
    write: async () => {},
    remove: async () => {},
    mkdir: async () => {},
    list: async () => ({ files: [], folders: [] }),
  };
  const plugin = {
    app: { vault: { adapter: emptyAdapter } },
    // Snapshot semantics: loadData copies at call time so an RMW that loaded
    // before a concurrent save cannot observe that save retroactively.
    loadData: async () => {
      loadDataSnapshots.push(JSON.stringify(dataStore));
      return dataStore === null ? null : { ...dataStore };
    },
    saveData: async (data: Record<string, unknown>) => {
      if (savesToFail > 0) {
        savesToFail -= 1;
        throw new Error('fixture layout write failure');
      }
      dataStore = data;
    },
  };
  return {
    plugin,
    loadDataSnapshots,
    readData: () => dataStore,
    failNextSave: () => { savesToFail += 1; },
  };
}

describe('PersistenceCoordinator (S: same-host cross-instance write ordering)', () => {
  describe('metadata write ordering across storage instances', () => {
    it('orders the same record across two instances over one host: write 1 then write 2 lands as 2', async () => {
      const fixture = createVaultFixture({ gateWrites: true });
      const storageA = new SessionStorage(new VaultFileAdapter(fixture.app as never));
      const storageB = new SessionStorage(new VaultFileAdapter(fixture.app as never));

      const first = storageA.saveMetadata(meta('conv-x', 'write-1'));
      const second = storageB.saveMetadata(meta('conv-x', 'write-2'));
      await flushMicrotasks();

      // The second instance's write must not start while the first is in flight.
      expect(fixture.getWriteCalls()).toBe(1);

      fixture.gate.resolve();
      await first;
      await second;

      // Serialized start/end interleaving: the first write fully landed first.
      expect(fixture.writeLog).toEqual(['write:start:1', 'write:end:1', 'write:start:2', 'write:end:2']);
      const path = `${SESSIONS_PATH}/conv-x.meta.json`;
      expect(JSON.parse(fixture.files.get(path) ?? 'null').title).toBe('write-2');
    });

    it('rejects a failed write with the original error identity and keeps the lane ordered', async () => {
      const failure = new Error('fixture-disk-write-failure');
      const fixture = createVaultFixture({ gateWrites: true, failFirstWrite: failure });
      const storageA = new SessionStorage(new VaultFileAdapter(fixture.app as never));
      const storageB = new SessionStorage(new VaultFileAdapter(fixture.app as never));

      const failing = storageA.saveMetadata(meta('conv-f', 'failing'));
      const surviving = storageB.saveMetadata(meta('conv-f', 'surviving'));
      await flushMicrotasks();
      expect(fixture.getWriteCalls()).toBe(1);

      fixture.gate.resolve();
      const caught = await failing.then(() => null, error => error);
      expect(caught).toBe(failure);
      await surviving;
      const path = `${SESSIONS_PATH}/conv-f.meta.json`;
      expect(JSON.parse(fixture.files.get(path) ?? 'null').title).toBe('surviving');

      // The lane stays usable after a failure — a third write still lands.
      await storageA.saveMetadata(meta('conv-f', 'after-failure'));
      expect(JSON.parse(fixture.files.get(path) ?? 'null').title).toBe('after-failure');
    });

    it('guards the same record against resurrection: an in-flight save followed by a delete leaves the file deleted', async () => {
      const fixture = createVaultFixture({ gateWrites: true });
      const storageA = new SessionStorage(new VaultFileAdapter(fixture.app as never));
      const storageB = new SessionStorage(new VaultFileAdapter(fixture.app as never));

      const save = storageA.saveMetadata(meta('conv-d', 'doomed'));
      const remove = storageB.deleteMetadata('conv-d');
      await flushMicrotasks();
      expect(fixture.getWriteCalls()).toBe(1);

      fixture.gate.resolve();
      await save;
      await remove;

      const path = `${SESSIONS_PATH}/conv-d.meta.json`;
      expect(fixture.files.has(path)).toBe(false);
      // The delete ran after the save's write completed — ordered, not interleaved.
      const removeIndex = fixture.writeLog.findIndex(entry => entry.startsWith('remove:'));
      const writeEndIndex = fixture.writeLog.indexOf('write:end:1');
      expect(removeIndex).toBeGreaterThan(writeEndIndex);
    });

    it('orders delete-then-recreate for the same record (control)', async () => {
      const fixture = createVaultFixture();
      const storageA = new SessionStorage(new VaultFileAdapter(fixture.app as never));
      const storageB = new SessionStorage(new VaultFileAdapter(fixture.app as never));

      const remove = storageB.deleteMetadata('conv-c');
      const recreate = storageA.saveMetadata(meta('conv-c', 'recreated'));
      await remove;
      await recreate;

      const path = `${SESSIONS_PATH}/conv-c.meta.json`;
      expect(fixture.files.has(path)).toBe(true);
      expect(JSON.parse(fixture.files.get(path) ?? 'null').title).toBe('recreated');
    });
  });

  describe('metadata read barrier', () => {
    it('loadMetadata waits for an in-flight write admitted by another instance', async () => {
      const fixture = createVaultFixture({ gateWrites: true });
      const storageA = new SessionStorage(new VaultFileAdapter(fixture.app as never));
      const storageB = new SessionStorage(new VaultFileAdapter(fixture.app as never));

      const save = storageA.saveMetadata(meta('conv-r', 'fresh'));
      const read = storageB.loadMetadata('conv-r');
      fixture.gate.resolve();
      await save;

      const loaded = await read;
      expect(loaded).toMatchObject({ id: 'conv-r', title: 'fresh' });
    });

    it('listMetadata waits for in-flight metadata writes before listing', async () => {
      const fixture = createVaultFixture({ gateWrites: true });
      const storageA = new SessionStorage(new VaultFileAdapter(fixture.app as never));
      const storageB = new SessionStorage(new VaultFileAdapter(fixture.app as never));

      const save = storageA.saveMetadata(meta('conv-l', 'listed'));
      const list = storageB.listMetadata();
      fixture.gate.resolve();
      await save;

      const metas = await list;
      expect(metas.map(entry => entry.id)).toContain('conv-l');
    });
  });

  describe('layout RMW ordering', () => {
    it('serializes two concurrent layout saves through the shared app lane (no lost update window)', async () => {
      const { plugin, loadDataSnapshots, readData } = createPluginFixture({ otherKey: 'keep' });
      const service = new SharedStorageService(plugin as unknown as Plugin);

      const first = service.setTabManagerState(layout('t1', 'c1'));
      const second = service.setTabManagerState(layout('t2', 'c2'));
      await first;
      await second;

      const data = readData() as Record<string, unknown>;
      expect(data.tabManagerState).toEqual(layout('t2', 'c2'));
      expect(data.otherKey).toBe('keep');
      // The second RMW loaded the first save's data — no read-before-write interleave.
      expect(loadDataSnapshots[1]).toContain('"t1"');
    });

    it('serializes layout saves across SharedStorageService and StorageService on the same app', async () => {
      const { plugin, loadDataSnapshots, readData } = createPluginFixture(null);
      const shared = new SharedStorageService(plugin as unknown as Plugin);
      const claude = new StorageService(plugin as unknown as Plugin);

      const first = shared.setTabManagerState(layout('t1', 'c1'));
      const second = claude.setTabManagerState(layout('t2', 'c2'));
      await first;
      await second;

      const data = readData() as Record<string, unknown>;
      expect(data.tabManagerState).toEqual(layout('t2', 'c2'));
      expect(loadDataSnapshots[1]).toContain('"t1"');
    });

    it('a fire-and-forget unload layout save is still ordered: the reopen read observes the persisted lazy id', async () => {
      const { plugin } = createPluginFixture(null);
      const service = new SharedStorageService(plugin as unknown as Plugin);

      const lazyState = layout('lazy-tab', 'lazy-new-id');
      // Unload style: the host never awaits this save.
      void service.setTabManagerState(lazyState);

      const reopened = await service.getTabManagerState();
      expect(reopened).toEqual(lazyState);
    });

    it('keeps the layout failure surface: a failed layout save resolves silently and the lane keeps ordering (control)', async () => {
      const { plugin, readData, failNextSave } = createPluginFixture({});
      const service = new SharedStorageService(plugin as unknown as Plugin);
      failNextSave();

      await expect(service.setTabManagerState(layout('t1', 'c1'))).resolves.toBeUndefined();

      const later = layout('t2', 'c2');
      await service.setTabManagerState(later);
      const data = readData() as Record<string, unknown>;
      expect(data.tabManagerState).toEqual(later);
    });
  });

  describe('coordinator unit API', () => {
    it('runs jobs on one resource in admission order', async () => {
      const coordinator = new PersistenceCoordinator();
      const events: string[] = [];
      const gate = deferred();

      const first = coordinator.enqueue('resource-a', async () => {
        events.push('first:start');
        await gate.promise;
        events.push('first:end');
      });
      const second = coordinator.enqueue('resource-a', async () => {
        events.push('second:start');
        events.push('second:end');
      });
      await flushMicrotasks();
      expect(events).toEqual(['first:start']);

      gate.resolve();
      await first;
      await second;
      expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('does not serialize different resources against each other', async () => {
      const coordinator = new PersistenceCoordinator();
      const events: string[] = [];
      const gate = deferred();

      const gated = coordinator.enqueue('resource-a', async () => {
        events.push('a:start');
        await gate.promise;
        events.push('a:end');
      });
      const free = coordinator.enqueue('resource-b', async () => {
        events.push('b:start');
        events.push('b:end');
      });
      await flushMicrotasks();
      expect(events).toContain('b:end');
      expect(events).not.toContain('a:end');

      gate.resolve();
      await gated;
      await free;
      expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
    });

    it('rejects with the original error identity and keeps the lane usable', async () => {
      const coordinator = new PersistenceCoordinator();
      const failure = new Error('fixture-job-failure');

      const failing = coordinator.enqueue('resource-a', async () => {
        throw failure;
      });
      const caught = await failing.then(() => null, error => error);
      expect(caught).toBe(failure);

      let ran = false;
      await coordinator.enqueue('resource-a', async () => { ran = true; });
      expect(ran).toBe(true);
    });

    it('drain resolves without inheriting a failed write, and resolves immediately for an idle lane', async () => {
      const coordinator = new PersistenceCoordinator();
      await expect(coordinator.drain('idle-resource')).resolves.toBeUndefined();

      const failure = new Error('fixture-job-failure');
      const failing = coordinator.enqueue('resource-a', async () => {
        throw failure;
      });
      await failing.then(() => undefined, () => undefined);
      await expect(coordinator.drain('resource-a')).resolves.toBeUndefined();
    });

    it('drainMatching waits only for lanes matching the prefix', async () => {
      const coordinator = new PersistenceCoordinator();
      const events: string[] = [];
      const gate = deferred();

      const gated = coordinator.enqueue(`${SESSIONS_PATH}/conv-gated.meta.json`, async () => {
        events.push('gated:start');
        await gate.promise;
        events.push('gated:end');
      });
      coordinator.enqueue('other/conv-free.meta.json', async () => {
        events.push('free');
      });

      // The layout lane never blocks a metadata-prefix drain.
      const drained = coordinator.drainMatching(`${SESSIONS_PATH}/`);
      gate.resolve();
      await gated;
      await drained;
      expect(events).toEqual(['gated:start', 'free', 'gated:end']);
    });

    it('exposes one shared layout resource and one coordinator per host object', () => {
      expect(TAB_LAYOUT_RESOURCE).toBe('plugin-data/tabManagerState');

      const hostOne = {};
      const hostTwo = {};
      expect(PersistenceCoordinator.forHost(hostOne)).toBe(PersistenceCoordinator.forHost(hostOne));
      expect(PersistenceCoordinator.forHost(hostOne)).not.toBe(PersistenceCoordinator.forHost(hostTwo));
    });

    it('resolvePersistenceHost keys a real adapter by its App and a plain adapter by itself', () => {
      const app = { vault: { adapter: {} } };
      const adapter = new VaultFileAdapter(app as never);
      expect(resolvePersistenceHost(adapter)).toBe(app);

      const plain = { exists: async () => false };
      expect(resolvePersistenceHost(plain)).toBe(plain);
    });
  });
});
