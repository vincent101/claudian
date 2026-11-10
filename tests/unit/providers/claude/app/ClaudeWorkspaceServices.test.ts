// eslint-disable-next-line jest/no-mocks-import
import { getQueryCallCount, resetMockMessages, simulateCrash } from '@test/__mocks__/claude-agent-sdk';

import type {
  CommandDiscoveryToken,
  CommandDropdownSnapshot,
  CommandTargetCapture,
  CommandTargetReadContext,
} from '@/core/providers/commands/ProviderCommandDiscovery';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type ClaudianPlugin from '@/main';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';
// Tripwire: the production factory must never make the legacy probe reachable.
// If any production path calls it, the mock throws and the spy records it.
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';

jest.mock('@/providers/claude/commands/probeRuntimeCommands', () => ({
  probeRuntimeCommands: jest.fn(() => {
    throw new Error('probeRuntimeCommands must not be reachable from the production factory');
  }),
}));

jest.mock('fs', () => ({
  ...jest.createMockFromModule<object>('fs'),
  promises: {
    readdir: jest.fn().mockResolvedValue([]),
    access: jest.fn().mockRejectedValue(new Error('ENOENT')),
    readFile: jest.fn().mockRejectedValue(new Error('ENOENT')),
    stat: jest.fn().mockRejectedValue(new Error('ENOENT')),
    appendFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
  },
}));

function createMockAdapter(files: Record<string, string>): VaultFileAdapter {
  return {
    exists: jest.fn(async (path: string) => path in files || Object.keys(files).some(k => k.startsWith(path + '/'))),
    read: jest.fn(async (path: string) => {
      if (!(path in files)) throw new Error(`File not found: ${path}`);
      return files[path];
    }),
    write: jest.fn(),
    delete: jest.fn(),
    listFolders: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : folder + '/';
      const folders = new Set<string>();
      for (const path of Object.keys(files)) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          if (firstSlash >= 0) {
            folders.add(prefix + rest.slice(0, firstSlash));
          }
        }
      }
      return Array.from(folders);
    }),
    listFiles: jest.fn(),
    listFilesRecursive: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : folder + '/';
      return Object.keys(files).filter(k => k.startsWith(prefix));
    }),
    ensureFolder: jest.fn(),
    rename: jest.fn(),
    append: jest.fn(),
    stat: jest.fn(),
    deleteFolder: jest.fn(),
  } as unknown as VaultFileAdapter;
}

function pluginFixture(): ClaudianPlugin {
  const adapter = {
    basePath: '/fixture/vault', getBasePath: () => '/fixture/vault',
    exists: async () => false, read: async () => '', write: async () => {},
    mkdir: async () => {}, list: async () => ({ files: [], folders: [] }),
  };
  return {
    app: {
      vault: {
        adapter, getName: () => 'Fixture', on: jest.fn(), offref: jest.fn(),
        getFiles: () => [], getMarkdownFiles: () => [], getAllLoadedFiles: () => [],
      },
      workspace: {
        on: jest.fn(), offref: jest.fn(), getActiveFile: () => null,
        getActiveViewOfType: () => null, getLeavesOfType: () => [],
        revealLeaf: jest.fn(),
      },
      metadataCache: { on: jest.fn(), offref: jest.fn(), getFileCache: () => null },
    },
    loadData: async () => ({}), saveData: async () => {}, saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: () => '', getResolvedProviderCliPath: () => '/fixture/cli',
  } as unknown as ClaudianPlugin;
}

function vaultFiles(): Record<string, string> {
  return {
    '.claude/commands/vault-only.md': `---
description: vault-only command
---
Body of vault-only`,
  };
}

type ReadySnapshot = Extract<CommandDropdownSnapshot, { status: 'ready' }>;

function readySnapshot(snapshot: CommandDropdownSnapshot): ReadySnapshot {
  if (snapshot.status !== 'ready') {
    throw new Error(`expected a ready snapshot, got ${snapshot.status}`);
  }
  return snapshot;
}

/** Cold tab target: a tab capture whose runtime is null — no readable Query. */
function coldTabCapture(): CommandTargetCapture {
  const targetToken: CommandDiscoveryToken = {};
  const eligibilityController = new AbortController();
  return {
    capture: (sessionEpoch: number): CommandTargetReadContext => ({
      target: {
        kind: 'tab',
        providerId: 'claude',
        sessionEpoch,
        registryRevision: 0,
        targetToken,
        ticket: {},
        generation: 1,
        runtime: null,
        contextKey: 'cold-tab',
        requestedExternalPaths: [],
      },
      eligibilitySignal: eligibilityController.signal,
      isCurrent: () => true,
    }),
    subscribe: () => () => {},
  };
}

describe('createClaudeWorkspaceServices', () => {
  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
  });

  it('creates a production catalog whose cold session never calls SDK query or probe', async () => {
    // Any SDK query attempt fails immediately; the counter must stay at zero.
    resetMockMessages();
    simulateCrash(0);

    const services = await createClaudeWorkspaceServices(pluginFixture(), createMockAdapter(vaultFiles()));
    ProviderWorkspaceRegistry.setServices('claude', services);

    const catalog = services.commandCatalog;
    expect(catalog).toBeInstanceOf(ClaudeCommandCatalog);

    // Unbound default session from the dropdown config.
    const config = catalog.getDropdownConfig();
    expect(typeof config.createDiscoverySession).toBe('function');
    const unboundSession = config.createDiscoverySession!();
    const unboundSnapshot = readySnapshot(await unboundSession.read());
    expect(unboundSnapshot.runtime.status).toBe('not-attempted');
    expect(unboundSnapshot.receipt.runtimeEligibility).toBeNull();
    expect(unboundSnapshot.fallbackReason).toBe('unbound');
    expect(unboundSnapshot.entries.map(entry => entry.name)).toEqual(['vault-only']);

    // Cold tab target: runtime is null, only vault entries are visible.
    const coldSession = catalog.openDropdownSession!(coldTabCapture());
    const coldSnapshot = readySnapshot(await coldSession.read());
    expect(coldSnapshot.runtime.status).toBe('not-attempted');
    expect(coldSnapshot.receipt.runtimeEligibility).toBeNull();
    expect(coldSnapshot.fallbackReason).toBe('runtime-not-attempted');
    expect(coldSnapshot.entries.map(entry => entry.name)).toEqual(['vault-only']);

    // The legacy cold path must no longer reach a factory-injected probe.
    const legacyEntries = await catalog.listDropdownEntries({ includeBuiltIns: false });
    expect(legacyEntries.map(entry => entry.name)).toEqual(['vault-only']);

    expect(probeRuntimeCommands).not.toHaveBeenCalled();
    expect(getQueryCallCount()).toBe(0);

    unboundSession.release();
    coldSession.release();
  });

  it('binds production sessions to command registry replacement and removal', async () => {
    resetMockMessages();
    simulateCrash(0);

    const services = await createClaudeWorkspaceServices(pluginFixture(), createMockAdapter(vaultFiles()));
    const publishedCatalog = services.commandCatalog as ClaudeCommandCatalog;

    ProviderWorkspaceRegistry.setServices('claude', services);
    const revisionAtPublish = ProviderWorkspaceRegistry.getCommandCatalogRevision('claude');
    expect(revisionAtPublish).toBeGreaterThan(0);

    const registryListener = jest.fn();
    const unsubscribe = ProviderWorkspaceRegistry.subscribeCommandCatalog('claude', registryListener);
    const sessionListener = jest.fn();

    try {
      const session = publishedCatalog.openDropdownSession!();
      const unsubscribeSession = session.subscribe(sessionListener);

      const snapshot = readySnapshot(await session.read());
      expect(session.isCurrent(snapshot.receipt)).toBe(true);
      expect(registryListener).not.toHaveBeenCalled();
      expect(sessionListener).not.toHaveBeenCalled();

      // Replace the published catalog in place on the same services object.
      services.commandCatalog = new ClaudeCommandCatalog(
        services.claudeStorage.commands,
        services.claudeStorage.skills,
      );
      ProviderWorkspaceRegistry.setServices('claude', services);

      // Old receipts die synchronously, without any microtask.
      expect(session.isCurrent(snapshot.receipt)).toBe(false);
      expect(registryListener).toHaveBeenCalledTimes(1);
      expect(sessionListener).toHaveBeenCalledTimes(1);
      expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).not.toBe(publishedCatalog);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionAtPublish + 1);

      // clear() removes the slot; receipts stay invalid and consumers hear it.
      ProviderWorkspaceRegistry.clear();
      expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBeNull();
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionAtPublish + 2);
      expect(session.isCurrent(snapshot.receipt)).toBe(false);
      expect(registryListener).toHaveBeenCalledTimes(2);
      expect(sessionListener).toHaveBeenCalledTimes(2);

      // After unsubscribing, further registry changes never call back.
      unsubscribe();
      unsubscribeSession();
      ProviderWorkspaceRegistry.setServices('claude', {
        ...services,
        commandCatalog: publishedCatalog,
      });
      expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(publishedCatalog);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionAtPublish + 3);
      expect(registryListener).toHaveBeenCalledTimes(2);
      expect(sessionListener).toHaveBeenCalledTimes(2);

      session.release();
    } finally {
      unsubscribe();
    }
  });
});
