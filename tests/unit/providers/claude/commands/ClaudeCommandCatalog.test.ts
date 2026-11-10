import type {
  CommandCatalogRegistryBinding,
  CommandDiscoveryToken,
  CommandDropdownSnapshot,
  CommandRuntimeEligibility,
  CommandTargetCapture,
  CommandTargetReadContext,
  QueryCommandSourceReceipt,
  RuntimeCommandDiscovery,
  RuntimeCommandRead,
} from '@/core/providers/commands/ProviderCommandDiscovery';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import type { ChatRuntime } from '@/core/runtime/ChatRuntime';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { SlashCommand } from '@/core/types';
import type { CommandProbe } from '@/providers/claude/commands/ClaudeCommandCatalog';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';
import { SkillStorage } from '@/providers/claude/storage/SkillStorage';
import { SlashCommandStorage } from '@/providers/claude/storage/SlashCommandStorage';

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
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

describe('ClaudeCommandCatalog', () => {
  describe('listDropdownEntries', () => {
    it('returns SDK runtime commands as ProviderCommandEntry', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      const sdkCommands: SlashCommand[] = [
        { id: 'sdk:commit', name: 'commit', description: 'Create git commit', content: '', source: 'sdk' },
        { id: 'sdk:review', name: 'review', description: 'Review code', content: '', source: 'sdk' },
      ];
      catalog.setRuntimeCommands(sdkCommands);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(2);

      const commitEntry = entries.find(e => e.name === 'commit');
      expect(commitEntry).toBeDefined();
      expect(commitEntry!.providerId).toBe('claude');
      expect(commitEntry!.scope).toBe('runtime');
      expect(commitEntry!.source).toBe('sdk');
      expect(commitEntry!.isEditable).toBe(false);
      expect(commitEntry!.isDeletable).toBe(false);
      expect(commitEntry!.displayPrefix).toBe('/');
      expect(commitEntry!.insertPrefix).toBe('/');
    });

    it('returns empty when no runtime commands and no probe', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(entries).toHaveLength(0);
    });

    it('filters out built-in hidden SDK commands', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      catalog.setRuntimeCommands([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
        { id: 'sdk:init', name: 'init', description: 'Init', content: '', source: 'sdk' },
        { id: 'sdk:debug', name: 'debug', description: 'Debug', content: '', source: 'sdk' },
        { id: 'sdk:cost', name: 'cost', description: 'Cost', content: '', source: 'sdk' },
        { id: 'sdk:review', name: 'review', description: 'Review', content: '', source: 'sdk' },
      ]);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      const names = entries.map(e => e.name);
      expect(names).toEqual(['commit', 'review']);
      expect(names).not.toContain('init');
      expect(names).not.toContain('debug');
      expect(names).not.toContain('cost');
    });

    it('probes SDK on cold start when cache is empty', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:commit', name: 'commit', description: 'Create git commit', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('commit');
      expect(entries[0].scope).toBe('runtime');
    });

    it('falls back to vault commands and skills when SDK discovery is empty', async () => {
      const adapter = createMockAdapter({
        '.claude/commands/review.md': `---
description: Review code
---
Review this code`,
        '.claude/skills/deploy/SKILL.md': `---
description: Deploy app
---
Deploy the app`,
      });
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(entries).toHaveLength(2);
      expect(entries.map(entry => entry.name).sort()).toEqual(['deploy', 'review']);
      expect(entries.every(entry => entry.scope === 'vault')).toBe(true);
    });

    it('does not probe when runtime commands are cached', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      catalog.setRuntimeCommands([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);

      await catalog.listDropdownEntries({ includeBuiltIns: false });

      expect(probe).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent probe calls', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = jest.fn().mockResolvedValue([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      const [a, b] = await Promise.all([
        catalog.listDropdownEntries({ includeBuiltIns: false }),
        catalog.listDropdownEntries({ includeBuiltIns: false }),
      ]);

      expect(probe).toHaveBeenCalledTimes(1);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('does not overwrite runtime commands with stale probe results', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);

      let resolveProbe: (v: SlashCommand[]) => void;
      const probe = jest.fn().mockReturnValue(new Promise<SlashCommand[]>((r) => { resolveProbe = r; }));
      const catalog = new ClaudeCommandCatalog(commands, skills, probe);

      // Start probe (it will hang)
      const entriesPromise = catalog.listDropdownEntries({ includeBuiltIns: false });

      // Runtime provides fresh data while probe is in-flight
      catalog.setRuntimeCommands([
        { id: 'sdk:review', name: 'review', description: 'Review', content: '', source: 'sdk' },
      ]);

      // Probe returns stale data
      resolveProbe!([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);

      const entries = await entriesPromise;

      // Runtime data wins — probe result is discarded
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('review');
    });
  });

  describe('listVaultEntries', () => {
    it('returns only vault-owned commands and skills', async () => {
      const adapter = createMockAdapter({
        '.claude/commands/review.md': `---
description: Review code
---
Review this code`,
        '.claude/skills/deploy/SKILL.md': `---
description: Deploy
---
Deploy the app`,
      });
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      // Set SDK commands to verify they're excluded from vault entries
      catalog.setRuntimeCommands([
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ]);

      const entries = await catalog.listVaultEntries();

      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.scope === 'vault')).toBe(true);
      expect(entries.find(e => e.name === 'commit')).toBeUndefined();
    });
  });

  describe('saveVaultEntry', () => {
    it('saves a command entry via command storage', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      await catalog.saveVaultEntry({
        id: 'cmd-review',
        providerId: 'claude',
        kind: 'command',
        name: 'review',
        description: 'Review code',
        allowedTools: ['Read', 'Edit'],
        model: 'claude-sonnet-4-5',
        content: 'Review this code',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      });

      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/commands/review.md',
        expect.stringContaining('Review this code'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/commands/review.md',
        expect.stringContaining('allowed-tools:'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/commands/review.md',
        expect.stringContaining('model: claude-sonnet-4-5'),
      );
    });

    it('saves a skill entry via skill storage', async () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      await catalog.saveVaultEntry({
        id: 'skill-deploy',
        providerId: 'claude',
        kind: 'skill',
        name: 'deploy',
        description: 'Deploy app',
        content: 'Deploy the app',
        disableModelInvocation: true,
        userInvocable: false,
        context: 'fork',
        agent: 'deployer',
        hooks: { preToolUse: ['check'] },
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      });

      expect(adapter.ensureFolder).toHaveBeenCalledWith('.claude/skills/deploy');
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/skills/deploy/SKILL.md',
        expect.stringContaining('Deploy the app'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/skills/deploy/SKILL.md',
        expect.stringContaining('disable-model-invocation: true'),
      );
      expect(adapter.write).toHaveBeenCalledWith(
        '.claude/skills/deploy/SKILL.md',
        expect.stringContaining('user-invocable: false'),
      );
    });
  });

  describe('deleteVaultEntry', () => {
    it('deletes a command entry', async () => {
      const adapter = createMockAdapter({
        '.claude/commands/review.md': `---
description: Review
---
Review`,
      });
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      await catalog.deleteVaultEntry({
        id: 'cmd-review',
        providerId: 'claude',
        kind: 'command',
        name: 'review',
        description: 'Review',
        content: 'Review',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      });

      expect(adapter.delete).toHaveBeenCalled();
    });

    it('deletes a skill entry', async () => {
      const adapter = createMockAdapter({
        '.claude/skills/deploy/SKILL.md': `---
description: Deploy
---
Deploy`,
      });
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      await catalog.deleteVaultEntry({
        id: 'skill-deploy',
        providerId: 'claude',
        kind: 'skill',
        name: 'deploy',
        description: 'Deploy',
        content: 'Deploy',
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      });

      expect(adapter.delete).toHaveBeenCalledWith('.claude/skills/deploy/SKILL.md');
    });
  });

  describe('getDropdownConfig', () => {
    it('returns Claude-specific config', () => {
      const adapter = createMockAdapter({});
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const catalog = new ClaudeCommandCatalog(commands, skills);

      const config = catalog.getDropdownConfig();

      expect(config.triggerChars).toEqual(['/']);
      expect(config.builtInPrefix).toBe('/');
      expect(config.skillPrefix).toBe('/');
      expect(config.commandPrefix).toBe('/');
    });
  });

  describe('typed dropdown session', () => {
    type ReadySnapshot = Extract<CommandDropdownSnapshot, { status: 'ready' }>;

    function readySnapshot(snapshot: CommandDropdownSnapshot): ReadySnapshot {
      if (snapshot.status !== 'ready') {
        throw new Error(`expected a ready snapshot, got ${snapshot.status}`);
      }
      return snapshot;
    }

    async function settleWithin<T>(promise: Promise<T>, ms = 2000): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`read did not settle within ${ms}ms`)), ms);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }

    function vaultFile(name: string): Record<string, string> {
      return {
        [`.claude/commands/${name}.md`]: `---
description: ${name} command
---
Body of ${name}`,
      };
    }

    function makeVaultEntry(name: string): ProviderCommandEntry {
      return {
        id: `cmd-${name}`,
        providerId: 'claude',
        kind: 'command',
        name,
        description: name,
        content: name,
        scope: 'vault',
        source: 'user',
        isEditable: true,
        isDeletable: true,
        displayPrefix: '/',
        insertPrefix: '/',
      };
    }

    function createCatalog(
      files: Record<string, string>,
      options: { probe?: CommandProbe; binding?: CommandCatalogRegistryBinding } = {},
    ) {
      const adapter = createMockAdapter(files);
      const commands = new SlashCommandStorage(adapter);
      const skills = new SkillStorage(adapter);
      const probe = options.probe ?? jest.fn().mockResolvedValue([]);
      const catalog = new ClaudeCommandCatalog(commands, skills, probe, options.binding);
      return { catalog, adapter, probe: probe as jest.Mock };
    }

    function queryReceiptFixture(sourceRevision = 1): QueryCommandSourceReceipt {
      const sourceToken: CommandDiscoveryToken = {};
      return {
        sourceKind: 'initialize-response',
        sourceToken,
        sourceRevision,
        scope: { kind: 'actual-query', sourceToken, unknown: [] },
        coverage: 'initialize-observed',
      };
    }

    type FakeFacetRead = (
      signal: AbortSignal | undefined,
      options?: { retryFailed?: boolean },
    ) => Promise<RuntimeCommandRead>;

    function createFakeFacet(readImpl: FakeFacetRead): RuntimeCommandDiscovery & {
      readonly readCalls: Array<{ signal: AbortSignal | undefined; options?: { retryFailed?: boolean } }>;
      notify(): void;
      setCurrency(fn: (eligibility: CommandRuntimeEligibility) => boolean): void;
    } {
      const listeners = new Set<() => void>();
      const readCalls: Array<{ signal: AbortSignal | undefined; options?: { retryFailed?: boolean } }> = [];
      let currency: (eligibility: CommandRuntimeEligibility) => boolean = () => true;
      return {
        read: (signal, options) => {
          readCalls.push({ signal, options });
          return readImpl(signal, options);
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        isCurrent: (eligibility) => currency(eligibility),
        notify: () => {
          for (const listener of [...listeners]) listener();
        },
        setCurrency: (fn) => {
          currency = fn;
        },
        readCalls,
      };
    }

    function fakeRuntime(facet: RuntimeCommandDiscovery, extra: Record<string, unknown> = {}): ChatRuntime {
      return {
        providerId: 'claude',
        getCommandDiscovery: () => facet,
        ...extra,
      } as unknown as ChatRuntime;
    }

    function createFakeCapture(initial: {
      ticket?: CommandDiscoveryToken;
      generation?: number;
      runtime: ChatRuntime | null;
      registryRevision?: number;
      requestedExternalPaths?: readonly string[];
    }): CommandTargetCapture & {
      changeTarget(next: { ticket?: CommandDiscoveryToken; generation: number }): void;
      readonly unsubscribeCount: number;
    } {
      const state = {
        ticket: initial.ticket ?? ({} as CommandDiscoveryToken),
        generation: initial.generation ?? 1,
        runtime: initial.runtime,
      };
      const targetToken: CommandDiscoveryToken = {};
      const eligibilityController = new AbortController();
      const listeners = new Set<() => void>();
      const liveContexts = new Set<{ alive: boolean }>();
      let unsubscribed = 0;
      const capture: CommandTargetCapture = {
        capture: (sessionEpoch: number): CommandTargetReadContext => {
          const holder = { alive: true };
          liveContexts.add(holder);
          return {
            target: {
              kind: 'tab',
              providerId: 'claude',
              sessionEpoch,
              registryRevision: initial.registryRevision ?? 0,
              targetToken,
              ticket: state.ticket,
              generation: state.generation,
              runtime: state.runtime,
              contextKey: 'fake-context',
              requestedExternalPaths: [...(initial.requestedExternalPaths ?? [])],
            },
            eligibilitySignal: eligibilityController.signal,
            isCurrent: () => holder.alive,
          };
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            unsubscribed++;
          };
        },
      };
      return {
        ...capture,
        changeTarget: (next) => {
          if (next.ticket) state.ticket = next.ticket;
          state.generation = next.generation;
          for (const holder of liveContexts) holder.alive = false;
          liveContexts.clear();
          for (const listener of [...listeners]) listener();
        },
        get unsubscribeCount() {
          return unsubscribed;
        },
      };
    }

    function createFakeBinding(initialRevision = 1): CommandCatalogRegistryBinding & {
      replace(): void;
      restore(): void;
      readonly unsubscribeCount: number;
    } {
      let revision = initialRevision;
      let current = true;
      const listeners = new Set<() => void>();
      let unsubscribed = 0;
      const notify = () => {
        for (const listener of [...listeners]) listener();
      };
      return {
        getRevision: () => revision,
        isCurrent: () => current,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            unsubscribed++;
          };
        },
        replace: () => {
          revision++;
          current = false;
          notify();
        },
        restore: () => {
          revision++;
          current = true;
          notify();
        },
        get unsubscribeCount() {
          return unsubscribed;
        },
      };
    }

    it.each([
      { label: 'A/A', requested: ['/scope/A'], actual: ['/scope/A'], unknown: [], expected: 'query-owned' },
      { label: 'A/B', requested: ['/scope/B'], actual: ['/scope/A'], unknown: [], expected: 'scope-mismatch' },
      { label: 'A/empty', requested: [], actual: ['/scope/A'], unknown: [], expected: 'scope-mismatch' },
      { label: 'empty/A', requested: ['/scope/A'], actual: [], unknown: [], expected: 'scope-mismatch' },
      { label: 'explicit empty/empty', requested: [], actual: [], unknown: [], expected: 'query-owned' },
      {
        label: 'reordered and normalized directories',
        requested: ['/scope/B/', '/scope/A/child/..'],
        actual: ['/scope/A', '/scope/B'],
        unknown: [],
        expected: 'query-owned',
      },
      {
        label: 'duplicate normalized members',
        requested: ['/scope/A/', '/scope/A/.'],
        actual: ['/scope/A'],
        unknown: [],
        expected: 'query-owned',
      },
      {
        label: 'commas within directory names',
        requested: ['/scope/a', '/scope/b'],
        actual: ['/scope/a,/scope/b'],
        unknown: [],
        expected: 'scope-mismatch',
      },
      { label: 'missing directories', requested: [], actual: undefined, unknown: [], expected: 'unverified' },
      {
        label: 'directories explicitly unknown despite matching empty values',
        requested: [],
        actual: [],
        unknown: ['additionalDirectories'],
        expected: 'unverified',
      },
      {
        label: 'directories explicitly unknown despite different values',
        requested: ['/scope/B'],
        actual: ['/scope/A'],
        unknown: ['additionalDirectories'],
        expected: 'unverified',
      },
      {
        label: 'other unknown dimensions with matching directories',
        requested: ['/scope/A'],
        actual: ['/scope/A'],
        unknown: ['cwd', 'settingSources'],
        expected: 'query-owned',
      },
      {
        label: 'other unknown dimensions cannot hide a mismatch',
        requested: ['/scope/B'],
        actual: ['/scope/A'],
        unknown: ['cwd', 'settingSources'],
        expected: 'scope-mismatch',
      },
    ])('classifies captured Query scope by directory members ($label)', async ({ requested, actual, unknown, expected }) => {
      const eligibility: CommandRuntimeEligibility = { token: {}, revision: 9 };
      const baseReceipt = queryReceiptFixture(9);
      const receipt: QueryCommandSourceReceipt = {
        ...baseReceipt,
        scope: {
          ...baseReceipt.scope,
          ...(actual === undefined ? {} : { additionalDirectories: actual }),
          unknown,
        },
      };
      const runtimeRead: RuntimeCommandRead = {
        status: 'ready',
        entries: [
          { id: 'sdk:keep', name: 'keep', description: 'Keep', content: '', source: 'sdk' },
          { id: 'sdk:cost', name: 'cost', description: 'Cost', content: '', source: 'sdk' },
        ],
        receipt,
        eligibility,
      };
      const facet = createFakeFacet(async () => runtimeRead);
      const { catalog, adapter, probe } = createCatalog(vaultFile('vault-only'));
      const session = catalog.openDropdownSession!(createFakeCapture({
        runtime: fakeRuntime(facet),
        requestedExternalPaths: requested,
      }));

      const snap = readySnapshot(await session.read());

      expect(snap.runtime).toBe(runtimeRead);
      expect(snap.sourceRefs).toHaveLength(1);
      expect(snap.sourceRefs[0].relation).toBe(expected);
      expect(snap.sourceRefs[0].receipt).toBe(receipt);
      expect(snap.sourceRefs[0].receipt.scope).toBe(receipt.scope);
      expect(snap.sourceRefs[0].receipt.sourceToken).toBe(receipt.sourceToken);
      expect(snap.receipt.sourceRefs).toBe(snap.sourceRefs);
      expect(snap.receipt.runtimeEligibility).toBe(eligibility);
      expect(session.isCurrent(snap.receipt)).toBe(true);
      expect(snap.entries.map(entry => entry.name)).toEqual(['keep']);
      expect(snap.rawCount).toEqual({ runtime: 2, probe: null, vault: null });
      expect(snap.catalogVisibleCount).toEqual({ runtime: 1, probe: null, vault: null });
      expect(snap.coverage).toEqual({ runtime: 'initialize-observed', probe: null, vault: null });
      expect(snap.fallbackReason).toBeNull();
      expect(snap.vault).toEqual({ status: 'not-attempted' });
      expect(snap.probe).toEqual({ status: 'not-attempted' });
      expect(facet.readCalls).toHaveLength(1);
      expect(facet.readCalls[0].options).toEqual({ retryFailed: false });
      expect(adapter.listFilesRecursive).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      session.release();
    });

    it('keeps a mismatched empty Query ready while falling back only because it is empty', async () => {
      const eligibility: CommandRuntimeEligibility = { token: {}, revision: 2 };
      const baseReceipt = queryReceiptFixture(2);
      const receipt: QueryCommandSourceReceipt = {
        ...baseReceipt,
        scope: { ...baseReceipt.scope, additionalDirectories: ['/scope/A'] },
      };
      const runtimeRead: RuntimeCommandRead = { status: 'ready', entries: [], receipt, eligibility };
      const facet = createFakeFacet(async () => runtimeRead);
      const { catalog, probe } = createCatalog(vaultFile('vault-only'));
      const session = catalog.openDropdownSession!(createFakeCapture({
        runtime: fakeRuntime(facet),
        requestedExternalPaths: ['/scope/B'],
      }));

      const snap = readySnapshot(await session.read());

      expect(snap.runtime).toBe(runtimeRead);
      expect(snap.sourceRefs[0]).toEqual({ receipt, relation: 'scope-mismatch' });
      expect(snap.sourceRefs[0].receipt).toBe(receipt);
      expect(snap.sourceRefs[1]).toMatchObject({
        relation: 'unverified',
        receipt: { sourceKind: 'vault-best-effort' },
      });
      expect(snap.entries.map(entry => entry.name)).toEqual(['vault-only']);
      expect(snap.rawCount).toEqual({ runtime: 0, probe: null, vault: 1 });
      expect(snap.coverage).toEqual({ runtime: 'initialize-observed', probe: null, vault: 'best-effort-unknown' });
      expect(snap.fallbackReason).toBe('runtime-empty');
      expect(snap.receipt.runtimeEligibility).toBe(eligibility);
      expect(session.isCurrent(snap.receipt)).toBe(true);
      expect(probe).not.toHaveBeenCalled();
      session.release();
    });

    it('rechecks attempted receipt eligibility on the bound facet without requiring the latest receipt', async () => {
      const eligibility: CommandRuntimeEligibility = { token: {}, revision: 1 };
      const baseReceipt = queryReceiptFixture();
      const receipt: QueryCommandSourceReceipt = {
        ...baseReceipt,
        scope: { ...baseReceipt.scope, additionalDirectories: [] },
      };
      const facet = createFakeFacet(async () => ({
        status: 'ready',
        entries: [{ id: 'sdk:keep', name: 'keep', description: 'Keep', content: '', source: 'sdk' }],
        receipt,
        eligibility,
      }));
      const { catalog } = createCatalog({});
      const session = catalog.openDropdownSession!(createFakeCapture({ runtime: fakeRuntime(facet) }));

      const [firstResult, secondResult] = await Promise.all([session.read(), session.read()]);
      const first = readySnapshot(firstResult);
      const second = readySnapshot(secondResult);
      expect(first.receipt).not.toBe(second.receipt);
      expect(first.entries.map(entry => entry.name)).toEqual(['keep']);
      expect(second.entries.map(entry => entry.name)).toEqual(['keep']);
      expect(session.isCurrent(first.receipt)).toBe(true);
      expect(session.isCurrent(second.receipt)).toBe(true);

      facet.setCurrency(() => false);

      expect(session.isCurrent(first.receipt)).toBe(false);
      expect(session.isCurrent(second.receipt)).toBe(false);
      const stale = await session.read();
      expect(stale.status).toBe('stale');
      expect(stale.entries).toEqual([]);
      expect(stale.receipt).toBeNull();
      session.release();
    });

    it.each(['ready-empty', 'unavailable', 'failed'] as const)(
      'rejects and does not cache a vault completion after runtime eligibility is revoked (%s)',
      async (kind) => {
        const oldEligibility: CommandRuntimeEligibility = { token: {}, revision: 1 };
        const newEligibility: CommandRuntimeEligibility = { token: {}, revision: 2 };
        const baseReceipt = queryReceiptFixture();
        const receipt: QueryCommandSourceReceipt = {
          ...baseReceipt,
          scope: { ...baseReceipt.scope, additionalDirectories: ['/scope/A'] },
        };
        const makeRuntimeRead = (eligibility: CommandRuntimeEligibility): RuntimeCommandRead => {
          if (kind === 'ready-empty') return { status: 'ready', entries: [], receipt, eligibility };
          if (kind === 'unavailable') return { status: 'unavailable', reason: 'no-readable-query', eligibility };
          return { status: 'failed', code: 'query-command-read-failed', eligibility };
        };
        const oldRead = makeRuntimeRead(oldEligibility);
        let currentRead = oldRead;
        let currentEligibility = oldEligibility;
        const facet = createFakeFacet(async () => currentRead);
        facet.setCurrency(candidate => candidate === currentEligibility);
        const { catalog, adapter, probe } = createCatalog({
          ...vaultFile('old-vault'),
          ...vaultFile('new-vault'),
        });
        const session = catalog.openDropdownSession!(createFakeCapture({
          runtime: fakeRuntime(facet),
          requestedExternalPaths: ['/scope/B'],
        }));
        let completeVault: (files: string[]) => void = () => { throw new Error('vault scan not started'); };
        const pendingVault = new Promise<string[]>(resolve => { completeVault = resolve; });
        const scans = adapter.listFilesRecursive as jest.Mock;
        scans.mockImplementationOnce(() => pendingVault)
          .mockImplementationOnce(async () => ['.claude/commands/new-vault.md']);

        const pendingRead = session.read();
        await Promise.resolve();
        await Promise.resolve();
        expect(scans).toHaveBeenCalledTimes(1);
        currentEligibility = newEligibility;
        completeVault(['.claude/commands/old-vault.md']);

        const stale = await settleWithin(pendingRead);
        expect(stale.status).toBe('stale');
        expect(stale.entries).toEqual([]);
        expect(stale.receipt).toBeNull();
        expect(stale.runtime).toBe(oldRead);

        currentRead = makeRuntimeRead(newEligibility);
        const fresh = readySnapshot(await session.read());
        expect(fresh.entries.map(entry => entry.name)).toEqual(['new-vault']);
        expect(scans).toHaveBeenCalledTimes(2);
        expect(fresh.receipt.runtimeEligibility).toBe(newEligibility);
        expect(session.isCurrent(fresh.receipt)).toBe(true);
        expect(probe).not.toHaveBeenCalled();
        session.release();
      },
    );

    it.each(['same session', 'independent sessions'] as const)(
      'shares one pending vault scan across typed reads at the same revision (%s)',
      async (mode) => {
        const { catalog, adapter, probe } = createCatalog(vaultFile('shared'));
        let completeScan: (files: string[]) => void = () => { throw new Error('scan not started'); };
        const pendingScan = new Promise<string[]>(resolve => { completeScan = resolve; });
        const scans = adapter.listFilesRecursive as jest.Mock;
        scans.mockImplementation(() => pendingScan);
        const firstSession = catalog.openDropdownSession!();
        const secondSession = mode === 'same session' ? firstSession : catalog.openDropdownSession!();

        try {
          const firstRead = firstSession.read();
          const secondRead = secondSession.read();
          const settled: string[] = [];
          void firstRead.then(() => { settled.push('first'); }, () => { settled.push('first'); });
          void secondRead.then(() => { settled.push('second'); }, () => { settled.push('second'); });
          await new Promise<void>(resolve => setImmediate(resolve));

          expect(settled).toEqual([]);
          expect(scans).toHaveBeenCalledTimes(1);
          expect(scans).toHaveBeenCalledWith('.claude/commands');
          expect(adapter.read).not.toHaveBeenCalled();

          completeScan(['.claude/commands/shared.md']);
          const [firstResult, secondResult] = await settleWithin(Promise.all([firstRead, secondRead]));
          const first = readySnapshot(firstResult);
          const second = readySnapshot(secondResult);

          for (const [session, snap] of [[firstSession, first], [secondSession, second]] as const) {
            expect(snap.entries.map(entry => entry.name)).toEqual(['shared']);
            expect(snap.runtime).toEqual({ status: 'not-attempted' });
            expect(snap.receipt.runtimeEligibility).toBeNull();
            expect(snap.fallbackReason).toBe('unbound');
            expect(snap.vault.status).toBe('ready');
            expect(snap.sourceRefs).toHaveLength(1);
            expect(snap.sourceRefs[0]).toMatchObject({
              relation: 'unverified',
              receipt: { sourceKind: 'vault-best-effort', sourceRevision: 0 },
            });
            expect(snap.rawCount).toEqual({ runtime: null, probe: null, vault: 1 });
            expect(snap.catalogVisibleCount).toEqual({ runtime: null, probe: null, vault: 1 });
            expect(snap.coverage).toEqual({ runtime: null, probe: null, vault: 'best-effort-unknown' });
            expect(session.isCurrent(snap.receipt)).toBe(true);
          }
          expect(first.receipt).not.toBe(second.receipt);
          expect(first.sourceRefs[0].receipt.sourceToken).toBe(second.sourceRefs[0].receipt.sourceToken);
          expect(scans).toHaveBeenCalledTimes(1);
          expect(adapter.read).toHaveBeenCalledTimes(1);
          expect(adapter.read).toHaveBeenCalledWith('.claude/commands/shared.md');
          expect(adapter.listFolders).toHaveBeenCalledTimes(1);
          expect(adapter.listFolders).toHaveBeenCalledWith('.claude/skills');
          expect(probe).not.toHaveBeenCalled();
        } finally {
          firstSession.release();
          if (secondSession !== firstSession) secondSession.release();
        }
      },
    );

    it('opens independent unbound sessions without reading legacy runtime commands or probing', async () => {
      const { catalog, probe } = createCatalog(vaultFile('vault-only'));
      catalog.setRuntimeCommands([
        { id: 'sdk:foreign', name: 'foreign', description: 'foreign', content: '', source: 'sdk' },
      ]);

      const session1 = catalog.openDropdownSession!();
      const session2 = catalog.openDropdownSession!();

      const snap1 = readySnapshot(await session1.read());
      const snap2 = readySnapshot(await session2.read());

      for (const snap of [snap1, snap2]) {
        expect(snap.runtime.status).toBe('not-attempted');
        expect(snap.receipt.runtimeEligibility).toBeNull();
        expect(snap.fallbackReason).toBe('unbound');
        expect(snap.entries.map(entry => entry.name)).toEqual(['vault-only']);
        expect(snap.entries.every(entry => entry.scope === 'vault')).toBe(true);
      }
      expect(snap1.entries.some(entry => entry.name === 'foreign')).toBe(false);
      expect(probe).not.toHaveBeenCalled();

      const configSession = catalog.getDropdownConfig().createDiscoverySession!();
      const configSnap = readySnapshot(await configSession.read());
      expect(configSnap.entries.map(entry => entry.name)).toEqual(['vault-only']);
      expect(configSnap.receipt.runtimeEligibility).toBeNull();
      expect(probe).not.toHaveBeenCalled();

      session1.release();
      expect(session1.isCurrent(snap1.receipt)).toBe(false);
      const afterRelease = await session1.read();
      expect(afterRelease.status).toBe('stale');

      const snap2After = readySnapshot(await session2.read());
      expect(snap2After.status).toBe('ready');
      expect(snap2After.entries.map(entry => entry.name)).toEqual(['vault-only']);
      expect(probe).not.toHaveBeenCalled();
    });

    it('keeps attempted unavailable eligibility over the vault fallback', async () => {
      const eligibility: CommandRuntimeEligibility = { token: {}, revision: 10 };
      const facet = createFakeFacet(async () => ({
        status: 'unavailable',
        reason: 'no-readable-query',
        eligibility,
      }));
      const { catalog } = createCatalog(vaultFile('vault-only'));
      const session = catalog.openDropdownSession!(createFakeCapture({ runtime: fakeRuntime(facet) }));

      const snap = readySnapshot(await session.read());

      expect(snap.runtime.status).toBe('unavailable');
      expect(snap.runtime).toMatchObject({ status: 'unavailable', eligibility });
      expect(snap.receipt.runtimeEligibility).toBe(eligibility);
      expect(snap.fallbackReason).toBe('runtime-unavailable');
      expect(snap.entries.map(entry => entry.name)).toEqual(['vault-only']);
      expect(snap.sourceRefs.some(ref => ref.relation === 'unverified' && ref.receipt.sourceKind === 'vault-best-effort')).toBe(true);
      expect(snap.sourceRefs.some(ref => ref.relation === 'query-owned')).toBe(false);
      expect(snap.rawCount).toEqual({ runtime: null, probe: null, vault: 1 });
      expect(snap.catalogVisibleCount.runtime).toBeNull();
      expect(snap.coverage).toEqual({ runtime: null, probe: null, vault: 'best-effort-unknown' });
      expect(snap.probeCleanup).toEqual({ status: 'not-started', reason: 'owned-probe-disabled' });
      expect(session.isCurrent(snap.receipt)).toBe(true);
    });

    it.each([
      { label: 'runtime-empty', raw: [] as SlashCommand[], rawCount: 0 },
      {
        label: 'name-policy-empty',
        raw: [{ id: 'sdk:cost', name: 'cost', description: 'Cost', content: '', source: 'sdk' }] as SlashCommand[],
        rawCount: 1,
      },
    ])('preserves ready empty and hidden-to-empty without retry or probe ($label)', async ({ raw, rawCount }) => {
      const eligibility: CommandRuntimeEligibility = { token: {}, revision: 1 };
      const receipt = queryReceiptFixture();
      const facet = createFakeFacet(async () => ({
        status: 'ready',
        entries: raw,
        receipt,
        eligibility,
      }));
      const { catalog, adapter, probe } = createCatalog(vaultFile('vault-only'));
      const session = catalog.openDropdownSession!(createFakeCapture({ runtime: fakeRuntime(facet) }));

      const snap = readySnapshot(await session.read());

      expect(snap.runtime.status).toBe('ready');
      expect(snap.receipt.runtimeEligibility).toBe(eligibility);
      expect(snap.rawCount).toEqual({ runtime: rawCount, probe: null, vault: 1 });
      expect(snap.catalogVisibleCount.runtime).toBe(0);
      expect(snap.coverage.runtime).toBe('initialize-observed');
      expect(snap.fallbackReason).toBe(rawCount === 0 ? 'runtime-empty' : 'name-policy-empty');
      expect(snap.entries.map(entry => entry.name)).toEqual(['vault-only']);
      expect(facet.readCalls).toHaveLength(1);
      expect(facet.readCalls[0].options).toEqual({ retryFailed: false });
      expect(probe).not.toHaveBeenCalled();
      expect(adapter.listFilesRecursive).toHaveBeenCalled();
      session.release();
    });

    it('preserves failed outcome while rendering a best effort vault fallback', async () => {
      const eligibility: CommandRuntimeEligibility = { token: {}, revision: 3 };
      const facet = createFakeFacet(async () => ({
        status: 'failed',
        code: 'query-command-read-failed',
        eligibility,
      }));
      const { catalog, probe } = createCatalog({});
      const session = catalog.openDropdownSession!(createFakeCapture({ runtime: fakeRuntime(facet) }));

      const snap = readySnapshot(await session.read());

      expect(snap.runtime.status).toBe('failed');
      expect(snap.runtime).toMatchObject({ status: 'failed', code: 'query-command-read-failed' });
      expect(snap.receipt.runtimeEligibility).toBe(eligibility);
      expect(snap.fallbackReason).toBe('runtime-failed');
      expect(snap.entries).toEqual([]);
      expect(snap.rawCount).toEqual({ runtime: null, probe: null, vault: 0 });
      expect(snap.probe).toEqual({ status: 'not-attempted' });
      expect(facet.readCalls[0].options).toEqual({ retryFailed: false });

      const snap2 = readySnapshot(await session.read());
      expect(snap2.runtime.status).toBe('failed');
      expect(snap2.receipt.runtimeEligibility).toBe(eligibility);
      expect(facet.readCalls).toHaveLength(2);
      expect(facet.readCalls[1].options).toEqual({ retryFailed: false });
      expect(probe).not.toHaveBeenCalled();
    });

    it('rejects old unavailable vault completion after a new Query becomes eligible', async () => {
      const oldEligibility: CommandRuntimeEligibility = { token: {}, revision: 10 };
      const newEligibility: CommandRuntimeEligibility = { token: {}, revision: 11 };
      const newQueryCommands: SlashCommand[] = [
        { id: 'sdk:commit', name: 'commit', description: 'Commit', content: '', source: 'sdk' },
      ];
      let mode: 'ready-new' | 'unavailable-old' | 'unavailable-new' = 'ready-new';
      const facet = createFakeFacet(async () => {
        if (mode === 'ready-new') {
          return {
            status: 'ready',
            entries: newQueryCommands,
            receipt: queryReceiptFixture(2),
            eligibility: newEligibility,
          };
        }
        return {
          status: 'unavailable',
          reason: 'no-readable-query',
          eligibility: mode === 'unavailable-new' ? newEligibility : oldEligibility,
        };
      });
      const { catalog, adapter } = createCatalog(vaultFile('vault-only'));
      const session = catalog.openDropdownSession!(createFakeCapture({ runtime: fakeRuntime(facet) }));

      // A ready Query read publishes a receipt without touching vault, so the
      // session cache stays empty for the pending fallback below.
      const first = readySnapshot(await session.read());
      expect(first.entries.map(entry => entry.name)).toEqual(['commit']);
      expect(session.isCurrent(first.receipt)).toBe(true);

      let releaseVault: (() => void) | null = null;
      const hangingScan = new Promise<string[]>(resolve => {
        releaseVault = () => resolve(['.claude/commands/vault-only.md']);
      });
      (adapter.listFilesRecursive as jest.Mock).mockImplementation(() => hangingScan);

      mode = 'unavailable-old';
      const pendingRead = session.read();
      await Promise.resolve();
      await Promise.resolve();
      expect(adapter.listFilesRecursive).toHaveBeenCalled();

      // A new Query becomes eligible on the same runtime: the facet revokes the
      // old eligibility and notifies.
      facet.setCurrency(eligibility => eligibility === newEligibility);
      facet.notify();

      const stale = await settleWithin(pendingRead);
      expect(stale.status).toBe('stale');
      expect(stale.entries).toEqual([]);
      expect(stale.receipt).toBeNull();
      expect(session.isCurrent(first.receipt)).toBe(false);

      const scansBefore = (adapter.listFilesRecursive as jest.Mock).mock.calls.length;
      mode = 'ready-new';
      const fresh = readySnapshot(await session.read());
      expect(fresh.entries.map(entry => entry.name)).toEqual(['commit']);
      expect(fresh.rawCount).toEqual({ runtime: 1, probe: null, vault: null });
      expect(fresh.fallbackReason).toBeNull();
      expect(fresh.receipt.runtimeEligibility).toBe(newEligibility);
      expect((adapter.listFilesRecursive as jest.Mock).mock.calls.length).toBe(scansBefore);

      releaseVault!();
      await new Promise(resolve => setTimeout(resolve, 0));

      mode = 'unavailable-new';
      const scansBeforeLate = (adapter.listFilesRecursive as jest.Mock).mock.calls.length;
      const afterLateVault = readySnapshot(await session.read());
      expect(afterLateVault.entries.map(entry => entry.name)).toEqual(['vault-only']);
      expect((adapter.listFilesRecursive as jest.Mock).mock.calls.length).toBeGreaterThan(scansBeforeLate);
    });

    it('settles caller and released session while a vault scan remains pending', async () => {
      const eligibility: CommandRuntimeEligibility = { token: {}, revision: 5 };
      const facet = createFakeFacet(async () => ({
        status: 'unavailable',
        reason: 'no-readable-query',
        eligibility,
      }));
      const runtime = fakeRuntime(facet, { cancel: jest.fn(), cleanup: jest.fn() });
      const { catalog, adapter } = createCatalog({});
      const session = catalog.openDropdownSession!(createFakeCapture({ runtime }));

      let rejectVault: ((error: Error) => void) | null = null;
      const hangingScan = new Promise<string[]>((_, reject) => {
        rejectVault = reject;
      });
      (adapter.listFilesRecursive as jest.Mock).mockImplementation(() => hangingScan);

      const caller = new AbortController();
      const cancelledRead = session.read(caller.signal);
      await Promise.resolve();
      await Promise.resolve();
      expect(adapter.listFilesRecursive).toHaveBeenCalled();
      caller.abort();
      const cancelled = await settleWithin(cancelledRead);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.entries).toEqual([]);
      expect(cancelled.receipt).toBeNull();

      const invalidatedRead = session.read();
      await Promise.resolve();
      await Promise.resolve();
      session.invalidate();
      const invalidated = await settleWithin(invalidatedRead);
      expect(invalidated.status).toBe('stale');
      expect(invalidated.receipt).toBeNull();

      const releasedRead = session.read();
      await Promise.resolve();
      await Promise.resolve();
      session.release();
      const released = await settleWithin(releasedRead);
      expect(released.status).toBe('stale');
      expect(released.receipt).toBeNull();
      expect((runtime as unknown as { cancel: jest.Mock }).cancel).not.toHaveBeenCalled();
      expect((runtime as unknown as { cleanup: jest.Mock }).cleanup).not.toHaveBeenCalled();

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        rejectVault!(new Error('late vault failure'));
        await new Promise(resolve => setTimeout(resolve, 10));
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toEqual([]);
    });

    it.each([
      { read: { status: 'cancelled', eligibility: { token: {}, revision: 7 } } as RuntimeCommandRead, outer: 'cancelled' as const },
      { read: { status: 'stale', eligibility: { token: {}, revision: 7 } } as RuntimeCommandRead, outer: 'stale' as const },
    ])('never wraps runtime cancelled or stale as a ready projection ($outer)', async ({ read, outer }) => {
      const facet = createFakeFacet(async () => read);
      const { catalog, adapter, probe } = createCatalog(vaultFile('vault-only'));
      const session = catalog.openDropdownSession!(createFakeCapture({ runtime: fakeRuntime(facet) }));

      const snap = await settleWithin(session.read());

      expect(snap.status).toBe(outer);
      expect(snap.entries).toEqual([]);
      expect(snap.receipt).toBeNull();
      expect((snap.runtime as RuntimeCommandRead).status).toBe(outer);
      expect((snap.runtime as RuntimeCommandRead).eligibility).toBe(read.eligibility);
      expect(snap.rawCount).toEqual({ runtime: null, probe: null, vault: null });
      expect(adapter.listFilesRecursive).not.toHaveBeenCalled();
      expect(adapter.listFolders).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      session.release();
    });

    it('invalidates receipts on target registry and vault revision changes', async () => {
      const eligibility: CommandRuntimeEligibility = { token: {}, revision: 1 };
      const facet = createFakeFacet(async () => ({
        status: 'unavailable',
        reason: 'no-readable-query',
        eligibility,
      }));
      const binding = createFakeBinding(1);
      const capture = createFakeCapture({ ticket: {}, generation: 20, runtime: fakeRuntime(facet), registryRevision: 1 });
      const { catalog, adapter } = createCatalog(vaultFile('vault-only'), { binding });
      const session = catalog.openDropdownSession!(capture);

      const first = readySnapshot(await session.read());
      expect(session.isCurrent(first.receipt)).toBe(true);

      capture.changeTarget({ ticket: {}, generation: 21 });
      expect(session.isCurrent(first.receipt)).toBe(false);

      const second = readySnapshot(await session.read());
      expect(session.isCurrent(second.receipt)).toBe(true);

      binding.replace();
      expect(session.isCurrent(second.receipt)).toBe(false);

      binding.restore();
      const third = readySnapshot(await session.read());
      expect(session.isCurrent(third.receipt)).toBe(true);

      const scansBeforeSave = (adapter.listFilesRecursive as jest.Mock).mock.calls.length;
      await catalog.saveVaultEntry(makeVaultEntry('fresh'));
      expect(session.isCurrent(third.receipt)).toBe(false);
      const fourth = readySnapshot(await session.read());
      expect((adapter.listFilesRecursive as jest.Mock).mock.calls.length).toBeGreaterThan(scansBeforeSave);
      expect(session.isCurrent(fourth.receipt)).toBe(true);

      await catalog.deleteVaultEntry(makeVaultEntry('vault-only'));
      expect(session.isCurrent(fourth.receipt)).toBe(false);
      const fifth = readySnapshot(await session.read());
      expect(session.isCurrent(fifth.receipt)).toBe(true);

      await catalog.refresh();
      expect(session.isCurrent(fifth.receipt)).toBe(false);

      const sixth = readySnapshot(await session.read());
      expect(session.isCurrent(sixth.receipt)).toBe(true);
      (adapter.write as jest.Mock).mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      await expect(catalog.saveVaultEntry(makeVaultEntry('broken'))).rejects.toThrow('disk full');
      expect(session.isCurrent(sixth.receipt)).toBe(true);

      session.release();
      session.release();
      expect(binding.unsubscribeCount).toBe(1);
      expect(capture.unsubscribeCount).toBe(1);
      expect(session.isCurrent(sixth.receipt)).toBe(false);
    });
  });
});
