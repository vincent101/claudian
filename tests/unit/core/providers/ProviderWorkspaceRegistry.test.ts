import '@/providers';

import type { ProviderCommandCatalog } from '@/core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

function makeCatalog(): ProviderCommandCatalog {
  return {
    listDropdownEntries: jest.fn(),
    openDropdownSession: jest.fn(),
    listVaultEntries: jest.fn(),
    saveVaultEntry: jest.fn(),
    deleteVaultEntry: jest.fn(),
    setRuntimeCommands: jest.fn(),
    getDropdownConfig: jest.fn(),
    refresh: jest.fn(),
  } as unknown as ProviderCommandCatalog;
}

describe('ProviderWorkspaceRegistry', () => {
  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
  });

  it('returns agent mention providers through the workspace registry', () => {
    const claudeProvider = { searchAgents: jest.fn().mockReturnValue([]) };
    const codexProvider = { searchAgents: jest.fn().mockReturnValue([]) };

    ProviderWorkspaceRegistry.setServices('claude', {
      agentMentionProvider: claudeProvider as any,
    });
    ProviderWorkspaceRegistry.setServices('codex', {
      agentMentionProvider: codexProvider as any,
    });

    expect(ProviderWorkspaceRegistry.getAgentMentionProvider('claude')).toBe(claudeProvider);
    expect(ProviderWorkspaceRegistry.getAgentMentionProvider('codex')).toBe(codexProvider);
  });

  it('refreshes agent mention state through the workspace registry', async () => {
    const refreshClaude = jest.fn().mockResolvedValue(undefined);
    const refreshCodex = jest.fn().mockResolvedValue(undefined);

    ProviderWorkspaceRegistry.setServices('claude', {
      refreshAgentMentions: refreshClaude,
    });
    ProviderWorkspaceRegistry.setServices('codex', {
      refreshAgentMentions: refreshCodex,
    });

    await ProviderWorkspaceRegistry.refreshAgentMentions('codex');

    expect(refreshClaude).not.toHaveBeenCalled();
    expect(refreshCodex).toHaveBeenCalled();
  });

  it('returns the assigned catalog for a provider', () => {
    const mockCatalog = {
      listDropdownEntries: jest.fn(),
      listVaultEntries: jest.fn(),
      saveVaultEntry: jest.fn(),
      deleteVaultEntry: jest.fn(),
      setRuntimeCommands: jest.fn(),
      getDropdownConfig: jest.fn(),
      refresh: jest.fn(),
    };

    ProviderWorkspaceRegistry.setServices('claude', {
      commandCatalog: mockCatalog as any,
    });

    expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(mockCatalog);
  });

  it('returns the runtime command loader for a provider', () => {
    const runtimeCommandLoader = {
      isAvailable: jest.fn().mockReturnValue(true),
      loadCommands: jest.fn().mockResolvedValue([]),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      runtimeCommandLoader: runtimeCommandLoader as any,
    });

    expect(ProviderWorkspaceRegistry.getRuntimeCommandLoader('opencode')).toBe(runtimeCommandLoader);
  });

  it('returns the tab warmup policy for a provider', () => {
    const tabWarmupPolicy = {
      resolveMode: jest.fn().mockReturnValue('commands'),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      tabWarmupPolicy: tabWarmupPolicy as any,
    });

    expect(ProviderWorkspaceRegistry.getTabWarmupPolicy('opencode')).toBe(tabWarmupPolicy);
  });

  it('notifies command replacement synchronously after publishing services and revision', () => {
    const seen: Array<{ catalog: ProviderCommandCatalog | null; revision: number }> = [];
    const unsubscribe = ProviderWorkspaceRegistry.subscribeCommandCatalog('claude', () => {
      seen.push({
        catalog: ProviderWorkspaceRegistry.getCommandCatalog('claude'),
        revision: ProviderWorkspaceRegistry.getCommandCatalogRevision('claude'),
      });
    });

    try {
      const revisionBefore = ProviderWorkspaceRegistry.getCommandCatalogRevision('claude');
      const catalog1 = makeCatalog();
      const catalog2 = makeCatalog();

      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog1 });
      // Synchronous: the listener already sees the new catalog and revision.
      expect(seen).toEqual([{ catalog: catalog1, revision: revisionBefore + 1 }]);

      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog2 });
      expect(seen).toEqual([
        { catalog: catalog1, revision: revisionBefore + 1 },
        { catalog: catalog2, revision: revisionBefore + 2 },
      ]);
      expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(catalog2);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionBefore + 2);
    } finally {
      unsubscribe();
    }
  });

  it('detects catalog replacement on a reused services object', () => {
    const listener = jest.fn();
    const revisionBefore = ProviderWorkspaceRegistry.getCommandCatalogRevision('claude');
    const unsubscribe = ProviderWorkspaceRegistry.subscribeCommandCatalog('claude', listener);

    try {
      const catalog1 = makeCatalog();
      const catalog2 = makeCatalog();
      const services: { commandCatalog?: ProviderCommandCatalog; mcpServerManager?: unknown } = {
        commandCatalog: catalog1,
      };

      ProviderWorkspaceRegistry.setServices('claude', services as any);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionBefore + 1);

      // Same services object mutated in place, MCP slot only: the command
      // slot is unchanged, so its revision must not advance.
      services.mcpServerManager = { replaced: true };
      ProviderWorkspaceRegistry.setServices('claude', services as any);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionBefore + 1);

      // Same services object with the catalog swapped in place: replacement
      // must still be detected — the old reference comes from the registry's
      // own slot, never by re-reading the already-mutated services object.
      services.commandCatalog = catalog2;
      ProviderWorkspaceRegistry.setServices('claude', services as any);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(catalog2);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionBefore + 2);
    } finally {
      unsubscribe();
    }
  });

  it('keeps command revisions monotonic across clear and A B A restoration', () => {
    const catalogA = makeCatalog();
    const catalogB = makeCatalog();
    const codexCatalog = makeCatalog();
    const revisionBefore = ProviderWorkspaceRegistry.getCommandCatalogRevision('claude');
    const clearSeen: Array<{ claude: ProviderCommandCatalog | null; codex: ProviderCommandCatalog | null; revision: number }> = [];
    const listener = jest.fn(() => {
      clearSeen.push({
        claude: ProviderWorkspaceRegistry.getCommandCatalog('claude'),
        codex: ProviderWorkspaceRegistry.getCommandCatalog('codex'),
        revision: ProviderWorkspaceRegistry.getCommandCatalogRevision('claude'),
      });
    });
    const unsubscribe = ProviderWorkspaceRegistry.subscribeCommandCatalog('claude', listener);

    try {
      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalogA });
      const revisionA = ProviderWorkspaceRegistry.getCommandCatalogRevision('claude');
      expect(revisionA).toBe(revisionBefore + 1);

      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalogB });
      const revisionB = ProviderWorkspaceRegistry.getCommandCatalogRevision('claude');
      expect(revisionB).toBe(revisionBefore + 2);

      ProviderWorkspaceRegistry.setServices('codex', { commandCatalog: codexCatalog });

      ProviderWorkspaceRegistry.clear();
      expect(listener).toHaveBeenCalledTimes(3);
      // Inside the clear callback every affected slot is already detached and
      // the revision advanced — it never resets to zero.
      expect(clearSeen[2]).toEqual({ claude: null, codex: null, revision: revisionBefore + 3 });
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionBefore + 3);
      expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBeNull();
      expect(ProviderWorkspaceRegistry.getCommandCatalog('codex')).toBeNull();

      // A B A: restoring the ORIGINAL catalog object still publishes a NEW
      // revision. The old (catalogA, revisionA) pair can never become
      // current again.
      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalogA });
      expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(catalogA);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionBefore + 4);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).not.toBe(revisionA);
      expect(listener).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribe();
    }
  });

  it('does not notify command consumers for unrelated service or provider changes', () => {
    const claudeListener = jest.fn();
    const throwingListener = jest.fn(() => {
      throw new Error('listener boom');
    });
    const first = ProviderWorkspaceRegistry.subscribeCommandCatalog('claude', claudeListener);
    const second = ProviderWorkspaceRegistry.subscribeCommandCatalog('claude', throwingListener);

    try {
      const revisionBefore = ProviderWorkspaceRegistry.getCommandCatalogRevision('claude');
      const catalog = makeCatalog();
      const services: { commandCatalog?: ProviderCommandCatalog; mcpServerManager?: unknown } = {
        commandCatalog: catalog,
      };

      ProviderWorkspaceRegistry.setServices('claude', services as any);
      expect(claudeListener).toHaveBeenCalledTimes(1);

      // MCP-only change on the same services object.
      services.mcpServerManager = { replaced: true };
      ProviderWorkspaceRegistry.setServices('claude', services as any);
      expect(claudeListener).toHaveBeenCalledTimes(1);
      expect(ProviderWorkspaceRegistry.getCommandCatalogRevision('claude')).toBe(revisionBefore + 1);

      // Another provider's publication must not notify this provider's slot.
      ProviderWorkspaceRegistry.setServices('codex', {
        commandCatalog: makeCatalog(),
        agentMentionProvider: { searchAgents: jest.fn().mockReturnValue([]) },
      } as any);
      expect(claudeListener).toHaveBeenCalledTimes(1);

      // A throwing listener must not block publication or the other listener.
      services.commandCatalog = makeCatalog();
      expect(() => ProviderWorkspaceRegistry.setServices('claude', services as any)).not.toThrow();
      expect(claudeListener).toHaveBeenCalledTimes(2);
      expect(throwingListener).toHaveBeenCalledTimes(2);

      // Unsubscribed listeners never fire again; unsubscribing twice is safe.
      second();
      second();
      services.commandCatalog = makeCatalog();
      ProviderWorkspaceRegistry.setServices('claude', services as any);
      expect(claudeListener).toHaveBeenCalledTimes(3);
      expect(throwingListener).toHaveBeenCalledTimes(2);
    } finally {
      first();
    }
  });
});
