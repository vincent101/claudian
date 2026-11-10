import '@/providers';

import { createMockEl } from '@test/helpers/mockElement';

import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type {
  CommandDropdownReceipt,
  CommandDropdownSession,
  CommandDropdownSnapshot,
  CommandRuntimeEligibility,
  CommandSourceReference,
  RuntimeCommandRead,
  VaultCommandSourceReceipt,
} from '@/core/providers/commands/ProviderCommandDiscovery';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import {
  SlashCommandDropdown,
  type SlashCommandDropdownCallbacks,
} from '@/shared/components/SlashCommandDropdown';

function createMockInput(): any {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    focus: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
}

function createMockCallbacks(overrides: Partial<SlashCommandDropdownCallbacks> = {}): SlashCommandDropdownCallbacks {
  return {
    onSelect: jest.fn(),
    onHide: jest.fn(),
    ...overrides,
  };
}

function getRenderedItems(containerEl: any): { name: string; description: string }[] {
  const dropdownEl = containerEl.children.find(
    (c: any) => c.hasClass('claudian-slash-dropdown')
  );
  if (!dropdownEl) return [];
  const items = dropdownEl.querySelectorAll('.claudian-slash-item');
  return items.map((item: any) => {
    const nameSpan = item.children.find((c: any) => c.hasClass('claudian-slash-name'));
    const descDiv = item.children.find((c: any) => c.hasClass('claudian-slash-desc'));
    return {
      name: nameSpan?.textContent ?? '',
      description: descDiv?.textContent ?? '',
    };
  });
}

function getRenderedCommandNames(containerEl: any): string[] {
  return getRenderedItems(containerEl).map(i => i.name);
}

const CLAUDE_CONFIG: ProviderCommandDropdownConfig = {
  providerId: 'claude',
  triggerChars: ['/'],
  builtInPrefix: '/',
  skillPrefix: '/',
  commandPrefix: '/',
};

const CODEX_CONFIG: ProviderCommandDropdownConfig = {
  providerId: 'codex',
  triggerChars: ['/', '$'],
  builtInPrefix: '/',
  skillPrefix: '$',
  commandPrefix: '/',
};

const OPENCODE_CONFIG: ProviderCommandDropdownConfig = {
  ...CLAUDE_CONFIG,
  providerId: 'opencode',
  triggerChars: ['/', '$'],
};

const CLAUDE_ENTRIES: ProviderCommandEntry[] = [
  {
    id: 'cmd-review', providerId: 'claude', kind: 'command', name: 'review',
    description: 'Review code', content: '', scope: 'vault', source: 'user',
    isEditable: true, isDeletable: true, displayPrefix: '/', insertPrefix: '/',
  },
  {
    id: 'skill-deploy', providerId: 'claude', kind: 'skill', name: 'deploy',
    description: 'Deploy app', content: '', scope: 'vault', source: 'user',
    isEditable: true, isDeletable: true, displayPrefix: '/', insertPrefix: '/',
  },
];

const CODEX_ENTRIES: ProviderCommandEntry[] = [
  {
    id: 'codex-skill-analyze', providerId: 'codex', kind: 'skill', name: 'analyze',
    description: 'Analyze code', content: '', scope: 'vault', source: 'user',
    isEditable: true, isDeletable: true, displayPrefix: '$', insertPrefix: '$',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Typed discovery session fixtures (fake CommandDropdownSession contract)
// ─────────────────────────────────────────────────────────────────────────────

const vaultSourceToken = {};
const vaultSourceReceipt: VaultCommandSourceReceipt = {
  sourceKind: 'vault-best-effort',
  sourceToken: vaultSourceToken,
  sourceRevision: 1,
  scope: { kind: 'vault', sourceToken: vaultSourceToken, unknown: [] },
  coverage: 'best-effort-unknown',
};
const vaultSourceRef: CommandSourceReference = { receipt: vaultSourceReceipt, relation: 'unverified' };

const snapshotDetails: Omit<CommandDropdownSnapshot, 'status' | 'entries' | 'runtime' | 'receipt'> = {
  probe: { status: 'not-attempted' },
  vault: { status: 'ready', entries: [], receipt: vaultSourceReceipt },
  probeCleanup: { status: 'not-started', reason: 'owned-probe-disabled' },
  sourceRefs: [vaultSourceRef],
  rawCount: { runtime: null, probe: null, vault: 1 },
  catalogVisibleCount: { runtime: null, probe: null, vault: 1 },
  coverage: { runtime: null, probe: null, vault: 'best-effort-unknown' },
  fallbackReason: null,
};

let receiptSeq = 0;
function makeReceipt<E extends CommandRuntimeEligibility | null>(
  catalogToken: object,
  runtimeEligibility: E,
): CommandDropdownReceipt<E> {
  return {
    catalogToken,
    registryRevision: 1,
    sessionEpoch: 1,
    sessionRevision: ++receiptSeq,
    targetToken: null,
    targetTicket: null,
    targetGeneration: null,
    runtimeEligibility,
    sourceRefs: [vaultSourceRef],
    projectionPolicyVersion: 1,
  };
}

function readyFromNotAttemptedRuntime(
  entries: ProviderCommandEntry[],
  catalogToken: object,
  fallbackReason = 'unbound',
): CommandDropdownSnapshot {
  const receipt = makeReceipt(catalogToken, null);
  return {
    ...snapshotDetails, fallbackReason, status: 'ready', entries,
    runtime: { status: 'not-attempted' }, receipt,
  };
}

function readyFromAttemptedRuntime(
  entries: ProviderCommandEntry[],
  catalogToken: object,
  runtime: RuntimeCommandRead,
): CommandDropdownSnapshot {
  const receipt = makeReceipt(catalogToken, runtime.eligibility);
  return { ...snapshotDetails, status: 'ready', entries, runtime, receipt };
}

function cancelledSnapshot(): CommandDropdownSnapshot {
  return {
    ...snapshotDetails, status: 'cancelled', entries: [],
    runtime: { status: 'not-attempted' }, receipt: null,
  };
}

function staleSnapshot(): CommandDropdownSnapshot {
  return {
    ...snapshotDetails, status: 'stale', entries: [],
    runtime: { status: 'not-attempted' }, receipt: null,
  };
}

interface FakeCommandDropdownSession extends CommandDropdownSession {
  readonly catalogToken: object;
  readonly unsubscribeSpies: Array<jest.Mock>;
  notify(): void;
  read: jest.Mock;
  subscribe: jest.Mock;
  isCurrent: jest.Mock;
  invalidate: jest.Mock;
  release: jest.Mock;
}

function createFakeSession(catalogToken: object): FakeCommandDropdownSession {
  const listeners = new Set<() => void>();
  const unsubscribeSpies: Array<jest.Mock> = [];
  const session: FakeCommandDropdownSession = {
    catalogToken,
    unsubscribeSpies,
    read: jest.fn(async (_signal?: AbortSignal): Promise<CommandDropdownSnapshot> => {
      throw new Error('fake session read was not scripted for this call');
    }),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener);
      const unsubscribe = jest.fn(() => { listeners.delete(listener); });
      unsubscribeSpies.push(unsubscribe);
      return unsubscribe;
    }),
    isCurrent: jest.fn((receipt: CommandDropdownReceipt) => receipt.catalogToken === catalogToken),
    invalidate: jest.fn(),
    release: jest.fn(),
    notify: () => { for (const listener of Array.from(listeners)) listener(); },
  };
  return session;
}

function typedConfig(
  session: FakeCommandDropdownSession,
): ProviderCommandDropdownConfig {
  return { ...CLAUDE_CONFIG, createDiscoverySession: () => session };
}

function makeTypedEntry(name: string): ProviderCommandEntry {
  return {
    id: `typed-${name}`, providerId: 'claude', kind: 'command', name,
    description: `Typed ${name}`, content: '', scope: 'vault', source: 'user',
    isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/',
  };
}

function getDropdownEl(containerEl: any): any {
  return containerEl.children.find((c: any) => c.hasClass('claudian-slash-dropdown'));
}

function getFirstItemEl(containerEl: any): any {
  const dropdownEl = getDropdownEl(containerEl);
  return dropdownEl?.querySelectorAll('.claudian-slash-item')[0] ?? null;
}

async function flushAsync(ticks = 15): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

describe('SlashCommandDropdown - provider catalog', () => {
  let containerEl: any;
  let inputEl: any;
  let callbacks: SlashCommandDropdownCallbacks;

  beforeEach(() => {
    containerEl = createMockEl();
    inputEl = createMockInput();
    callbacks = createMockCallbacks();
  });

  describe('Claude provider (/ trigger)', () => {
    it('shows provider entries on / trigger', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      // Built-ins + Claude entries (all use / prefix)
      expect(names).toContain('/clear');
      expect(names).toContain('/review');
      expect(names).toContain('/deploy');

      dropdown.destroy();
    });

    it('displays Claude entries with / prefix', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries }
      );

      inputEl.value = '/rev';
      inputEl.selectionStart = 4;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('/review');

      dropdown.destroy();
    });
  });

  describe('Codex provider (/ and $ triggers)', () => {
    it('shows Codex skills on $ trigger', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('$analyze');
      // Built-ins should NOT show on $ trigger (names render with displayPrefix, e.g. '/clear')
      expect(names).not.toContain('/clear');

      dropdown.destroy();
    });

    it('shows built-ins + skills on / trigger at position 0', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('/clear');
      expect(names).toContain('$analyze');

      dropdown.destroy();
    });

    it('includes Codex-compatible built-ins in the Codex dropdown', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('/clear');
      expect(names).toContain('/add-dir');
      expect(names).toContain('/resume');
      expect(names).toContain('/fork');

      dropdown.destroy();
    });

    it('inserts $name for Codex skill selection', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Simulate selecting the first (only) item via handleKeydown Enter
      const event = { key: 'Enter', preventDefault: jest.fn() } as any;
      dropdown.handleKeydown(event);

      // Input should now contain $analyze
      expect(inputEl.value).toContain('$analyze');

      dropdown.destroy();
    });
  });

  describe('catalog removal and builtin eligibility', () => {
    it('retains the provider capabilities and stops calling a removed legacy getter', async () => {
      const oldEntries: ProviderCommandEntry[] = [{
        ...CLAUDE_ENTRIES[0], providerId: 'opencode', name: 'vault-opencode',
      }];
      const oldGetter = jest.fn().mockResolvedValue(oldEntries);
      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks, {
        providerConfig: OPENCODE_CONFIG, getProviderEntries: oldGetter,
      });

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(oldGetter).toHaveBeenCalledTimes(1);
      expect(getRenderedCommandNames(containerEl)).toEqual(expect.arrayContaining([
        '/clear', '/resume', '/vault-opencode',
      ]));
      expect(getRenderedCommandNames(containerEl)).not.toContain('/fork');

      dropdown.setProviderCatalog(null, null);
      expect(getRenderedCommandNames(containerEl)).toEqual([]);
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual(expect.arrayContaining(['/clear', '/resume']));
      expect(getRenderedCommandNames(containerEl)).not.toContain('/fork');
      expect(getRenderedCommandNames(containerEl)).not.toContain('/vault-opencode');
      expect(oldGetter).toHaveBeenCalledTimes(1);

      dropdown.resetSdkSkillsCache();
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual(expect.arrayContaining(['/clear', '/resume']));
      expect(getRenderedCommandNames(containerEl)).not.toContain('/fork');
      expect(oldGetter).toHaveBeenCalledTimes(1);

      // A null config always detaches the getter, even if one is supplied.
      dropdown.setProviderCatalog(null, oldGetter);
      dropdown.handleInputChange();
      await flushAsync();
      expect(oldGetter).toHaveBeenCalledTimes(1);
      expect(getRenderedCommandNames(containerEl)).not.toContain('/vault-opencode');
      dropdown.destroy();
    });

    it('updates explicit null-catalog identity and lets non-null configs replace it', async () => {
      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks);
      inputEl.value = '/';
      inputEl.selectionStart = 1;

      // The third argument is the UI provider even when there is no catalog.
      dropdown.setProviderCatalog(null, null, 'opencode');
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual(expect.arrayContaining(['/clear', '/resume']));
      expect(getRenderedCommandNames(containerEl)).not.toContain('/fork');

      dropdown.setProviderCatalog(null, null, 'claude');
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/fork');

      dropdown.setProviderCatalog(null, null);
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/fork');

      dropdown.setProviderCatalog(OPENCODE_CONFIG, null);
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual(expect.arrayContaining(['/clear', '/resume']));
      expect(getRenderedCommandNames(containerEl)).not.toContain('/fork');
      dropdown.setProviderCatalog(null, null);
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).not.toContain('/fork');
      dropdown.destroy();
    });

    it('shows builtins only for a slash at position zero', async () => {
      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks, {
        providerConfig: OPENCODE_CONFIG,
      });
      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual([]);

      inputEl.value = 'prefix /';
      inputEl.selectionStart = inputEl.value.length;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual([]);

      dropdown.setProviderCatalog(null, null);
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual([]);

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual(expect.arrayContaining(['/clear', '/resume']));
      expect(getRenderedCommandNames(containerEl)).not.toContain('/fork');
      dropdown.destroy();
    });
  });

  describe('provider switch', () => {
    it('does not publish or cache a provider response after destruction', async () => {
      let resolveEntries!: (entries: ProviderCommandEntry[]) => void;
      const getProviderEntries = jest.fn(() => new Promise<ProviderCommandEntry[]>(resolve => {
        resolveEntries = resolve;
      }));
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      expect(getProviderEntries).toHaveBeenCalledTimes(1);
      dropdown.destroy();
      dropdown.destroy();
      resolveEntries(CLAUDE_ENTRIES);
      for (let i = 0; i < 4; i++) await Promise.resolve();

      expect(dropdown.isVisible()).toBe(false);
      expect(getRenderedCommandNames(containerEl)).toEqual([]);
      expect((dropdown as unknown as { cachedProviderEntries: ProviderCommandEntry[] }).cachedProviderEntries).toEqual([]);
      expect(inputEl.removeEventListener).toHaveBeenCalledTimes(1);
    });

    it('cannot reuse a request identity after the provider catalog changes', async () => {
      let resolveOld!: (entries: ProviderCommandEntry[]) => void;
      const oldEntries = jest.fn(() => new Promise<ProviderCommandEntry[]>(resolve => {
        resolveOld = resolve;
      }));
      const newEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries: oldEntries }
      );
      try {
        inputEl.value = '/';
        inputEl.selectionStart = 1;
        dropdown.handleInputChange();
        dropdown.setProviderCatalog(CODEX_CONFIG, newEntries);
        inputEl.value = '$';
        dropdown.handleInputChange();
        for (let i = 0; i < 4; i++) await Promise.resolve();
        expect(getRenderedCommandNames(containerEl)).toContain('$analyze');

        resolveOld(CLAUDE_ENTRIES);
        for (let i = 0; i < 4; i++) await Promise.resolve();
        expect(getRenderedCommandNames(containerEl)).toEqual(['$analyze']);
        expect((dropdown as unknown as { cachedProviderEntries: ProviderCommandEntry[] }).cachedProviderEntries)
          .toEqual(CODEX_ENTRIES);
      } finally {
        resolveOld(CLAUDE_ENTRIES);
        dropdown.destroy();
      }
    });

    it('resets cached entries on provider switch', async () => {
      const claudeEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries: claudeEntries }
      );

      // Fetch Claude entries
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(claudeEntries).toHaveBeenCalledTimes(1);

      // Switch provider
      const codexEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      dropdown.setProviderCatalog(CODEX_CONFIG, codexEntries);

      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(codexEntries).toHaveBeenCalledTimes(1);

      dropdown.destroy();
    });
  });

  describe('mid-sentence trigger detection', () => {
    it('opens Codex $ trigger mid-sentence', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = 'some text $';
      inputEl.selectionStart = 11;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('$analyze');

      dropdown.destroy();
    });

    it('opens Claude / trigger mid-sentence', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries }
      );

      inputEl.value = 'check this /';
      inputEl.selectionStart = 12;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('/review');

      dropdown.destroy();
    });

    it('does not show built-ins mid-sentence', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = 'some text /';
      inputEl.selectionStart = 11;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      // Mid-sentence: provider entries only, no built-ins
      expect(names).not.toContain('/clear');
      expect(names).not.toContain('/add-dir');

      dropdown.destroy();
    });

    it('does not open trigger without preceding whitespace', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = 'word$';
      inputEl.selectionStart = 5;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(dropdown.isVisible()).toBe(false);

      dropdown.destroy();
    });

    it('inserts correctly at mid-sentence position', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = 'prefix $';
      inputEl.selectionStart = 8;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Select the item
      const event = { key: 'Enter', preventDefault: jest.fn() } as any;
      dropdown.handleKeydown(event);

      // Should replace $analyze at the mid-sentence position
      expect(inputEl.value).toBe('prefix $analyze ');

      dropdown.destroy();
    });
  });

  describe('typed discovery session consumption', () => {
    it('uses a typed factory instead of the legacy entries callback', async () => {
      const session = createFakeSession({});
      const factory = jest.fn(() => session);
      const getProviderEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks, {
        providerConfig: { ...CLAUDE_CONFIG, createDiscoverySession: factory },
        getProviderEntries,
      });

      expect(factory).toHaveBeenCalledTimes(1);
      expect(session.subscribe).toHaveBeenCalledTimes(1);

      session.read.mockResolvedValue(readyFromNotAttemptedRuntime([makeTypedEntry('typed-cmd')], session.catalogToken));

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();

      inputEl.value = '/t';
      inputEl.selectionStart = 2;
      dropdown.handleInputChange();
      await flushAsync();

      expect(session.read).toHaveBeenCalledTimes(2);
      expect(getProviderEntries).toHaveBeenCalledTimes(0);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(getRenderedCommandNames(containerEl)).toContain('/typed-cmd');

      dropdown.destroy();
    });

    it('renders both ready branches without treating vault fallback as runtime success', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const vaultEntries = [makeTypedEntry('vault-cmd')];

      // Branch 1: unbound cold target — runtime not attempted, no runtime eligibility.
      const sessionA = createFakeSession({});
      const dropdownA = new SlashCommandDropdown(createMockEl(), createMockInput(), createMockCallbacks(), {
        providerConfig: typedConfig(sessionA), getProviderEntries,
      });
      sessionA.read.mockResolvedValue(readyFromNotAttemptedRuntime(vaultEntries, sessionA.catalogToken));
      const containerA = (dropdownA as unknown as { containerEl: any }).containerEl;
      const inputA = (dropdownA as unknown as { inputEl: any }).inputEl;
      inputA.value = '/';
      inputA.selectionStart = 1;
      dropdownA.handleInputChange();
      await flushAsync();

      const namesA = getRenderedCommandNames(containerA);
      expect(namesA).toContain('/vault-cmd');
      expect(namesA).toContain('/clear');
      expect(getDropdownEl(containerA).getAttribute('data-command-runtime-status')).toBe('not-attempted');
      expect(getDropdownEl(containerA).getAttribute('data-command-source-kinds')).toBe('vault-best-effort');
      const receiptA = sessionA.isCurrent.mock.calls[0][0] as CommandDropdownReceipt;
      expect(receiptA.runtimeEligibility).toBeNull();

      // Branch 2: attempted unavailable runtime — same-object eligibility preserved.
      const eligibilityE0: CommandRuntimeEligibility = { token: {}, revision: 10 };
      const sessionB = createFakeSession({});
      const dropdownB = new SlashCommandDropdown(createMockEl(), createMockInput(), createMockCallbacks(), {
        providerConfig: typedConfig(sessionB), getProviderEntries,
      });
      sessionB.read.mockResolvedValue(readyFromAttemptedRuntime(vaultEntries, sessionB.catalogToken, {
        status: 'unavailable', reason: 'no-readable-query', eligibility: eligibilityE0,
      }));
      const containerB = (dropdownB as unknown as { containerEl: any }).containerEl;
      const inputB = (dropdownB as unknown as { inputEl: any }).inputEl;
      inputB.value = '/';
      inputB.selectionStart = 1;
      dropdownB.handleInputChange();
      await flushAsync();

      const namesB = getRenderedCommandNames(containerB);
      expect(namesB).toContain('/vault-cmd');
      expect(namesB).toContain('/clear');
      const statusB = getDropdownEl(containerB).getAttribute('data-command-runtime-status');
      expect(statusB).toBe('unavailable');
      expect(statusB).not.toBe(getDropdownEl(containerA).getAttribute('data-command-runtime-status'));
      const receiptB = sessionB.isCurrent.mock.calls[0][0] as CommandDropdownReceipt;
      expect(receiptB.runtimeEligibility).toBe(eligibilityE0);

      // Ready-empty projection is accepted without falling back to the legacy getter.
      const sessionC = createFakeSession({});
      const dropdownC = new SlashCommandDropdown(createMockEl(), createMockInput(), createMockCallbacks(), {
        providerConfig: typedConfig(sessionC), getProviderEntries,
      });
      sessionC.read.mockResolvedValue(readyFromNotAttemptedRuntime([], sessionC.catalogToken));
      const containerC = (dropdownC as unknown as { containerEl: any }).containerEl;
      const inputC = (dropdownC as unknown as { inputEl: any }).inputEl;
      inputC.value = '/';
      inputC.selectionStart = 1;
      dropdownC.handleInputChange();
      await flushAsync();
      inputC.value = '/c';
      inputC.selectionStart = 2;
      dropdownC.handleInputChange();
      await flushAsync();

      expect(getRenderedCommandNames(containerC)).toContain('/clear');
      expect(sessionC.read).toHaveBeenCalledTimes(2);
      expect(getProviderEntries).toHaveBeenCalledTimes(0);

      dropdownA.destroy();
      dropdownB.destroy();
      dropdownC.destroy();
    });

    it('rejects cancelled stale and non-current ready snapshots', async () => {
      const session = createFakeSession({});
      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks, {
        providerConfig: typedConfig(session),
      });

      // (a) cancelled snapshot: nothing is published.
      session.read.mockResolvedValueOnce(cancelledSnapshot());
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(session.read).toHaveBeenCalledTimes(1);
      expect(getRenderedCommandNames(containerEl)).toEqual([]);
      expect(dropdown.isVisible()).toBe(false);

      // (b) stale snapshot: nothing is published.
      session.read.mockResolvedValueOnce(staleSnapshot());
      inputEl.value = '/x';
      inputEl.selectionStart = 2;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual([]);

      // (c) ready snapshot that is no longer current: nothing is published.
      session.isCurrent.mockReturnValue(false);
      session.read.mockResolvedValueOnce(readyFromNotAttemptedRuntime([makeTypedEntry('rejected-cmd')], session.catalogToken));
      inputEl.value = '/y';
      inputEl.selectionStart = 2;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toEqual([]);
      expect(dropdown.isVisible()).toBe(false);
      session.isCurrent.mockReturnValue(true);

      // (d) a late old-request completion must not modify the newer list.
      let resolveFirst!: (snapshot: CommandDropdownSnapshot) => void;
      session.read.mockImplementationOnce(() => new Promise<CommandDropdownSnapshot>(resolve => { resolveFirst = resolve; }));
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();

      const newerEntries = [makeTypedEntry('newer-cmd')];
      session.read.mockResolvedValueOnce(readyFromNotAttemptedRuntime(newerEntries, session.catalogToken));
      inputEl.value = '/n';
      inputEl.selectionStart = 2;
      dropdown.handleInputChange();
      await flushAsync();
      const namesAfterNew = getRenderedCommandNames(containerEl);
      expect(namesAfterNew).toContain('/newer-cmd');
      expect(namesAfterNew).not.toContain('/old-cmd');

      resolveFirst(readyFromNotAttemptedRuntime([makeTypedEntry('old-cmd')], session.catalogToken));
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/newer-cmd');
      expect(getRenderedCommandNames(containerEl)).not.toContain('/old-cmd');
      expect(callbacks.onSelect).toHaveBeenCalledTimes(0);
      expect(inputEl.value).toBe('/n');

      dropdown.destroy();
    });

    it('clears visible options synchronously before a refresh microtask', async () => {
      const session = createFakeSession({});
      const vaultEntries = [makeTypedEntry('vault-cmd')];
      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks, {
        providerConfig: typedConfig(session),
      });
      session.read.mockResolvedValue(readyFromNotAttemptedRuntime(vaultEntries, session.catalogToken));

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();

      expect(getRenderedCommandNames(containerEl)).toContain('/vault-cmd');
      const oldItemEl = getFirstItemEl(containerEl);
      expect(oldItemEl).not.toBeNull();

      // Session change must synchronously clear rendered options before any microtask runs.
      session.notify();

      expect(getRenderedCommandNames(containerEl)).toEqual([]);
      expect(dropdown.isVisible()).toBe(false);

      // Old DOM click closure no longer has selection eligibility.
      oldItemEl.click();
      expect(inputEl.value).toBe('/');
      expect(callbacks.onSelect).toHaveBeenCalledTimes(0);

      const enterEvent = { key: 'Enter', preventDefault: jest.fn() } as any;
      expect(dropdown.handleKeydown(enterEvent)).toBe(false);
      const tabEvent = { key: 'Tab', preventDefault: jest.fn() } as any;
      expect(dropdown.handleKeydown(tabEvent)).toBe(false);
      expect(inputEl.value).toBe('/');

      // After the coalesced microtask the menu is re-evaluated and re-rendered.
      session.read.mockClear();
      await flushAsync();
      expect(session.read).toHaveBeenCalledTimes(1);
      expect(getRenderedCommandNames(containerEl)).toContain('/vault-cmd');

      dropdown.destroy();
    });

    it('aborts only its waiter on hide and releases once on replacement or destruction', async () => {
      const session1 = createFakeSession({});
      const session2 = createFakeSession({});
      const container1 = createMockEl();
      const input1 = createMockInput();
      const callbacks1 = createMockCallbacks();
      const container2 = createMockEl();
      const input2 = createMockInput();
      const callbacks2 = createMockCallbacks();

      const dropdown1 = new SlashCommandDropdown(container1, input1, callbacks1, {
        providerConfig: typedConfig(session1),
      });
      const dropdown2 = new SlashCommandDropdown(container2, input2, callbacks2, {
        providerConfig: typedConfig(session2),
      });

      let resolveRead1!: (snapshot: CommandDropdownSnapshot) => void;
      let resolveRead2!: (snapshot: CommandDropdownSnapshot) => void;
      session1.read.mockImplementationOnce(() => new Promise<CommandDropdownSnapshot>(resolve => { resolveRead1 = resolve; }));
      session2.read.mockImplementationOnce(() => new Promise<CommandDropdownSnapshot>(resolve => { resolveRead2 = resolve; }));

      input1.value = '/';
      input1.selectionStart = 1;
      dropdown1.handleInputChange();
      input2.value = '/';
      input2.selectionStart = 1;
      dropdown2.handleInputChange();

      const signal1 = session1.read.mock.calls[0][0] as AbortSignal;
      const signal2 = session2.read.mock.calls[0][0] as AbortSignal;

      // hide aborts only this UI's waiter; it does not release the session owner.
      dropdown1.hide();
      expect(signal1.aborted).toBe(true);
      expect(signal2.aborted).toBe(false);
      expect(session1.release).toHaveBeenCalledTimes(0);
      expect(session1.unsubscribeSpies[0]).not.toHaveBeenCalled();

      // Replacement unsubscribes and releases the old session exactly once.
      const session3 = createFakeSession({});
      const replacementConfig = { ...CLAUDE_CONFIG, createDiscoverySession: () => session3 };
      dropdown1.setProviderCatalog(replacementConfig, null);
      expect(session1.release).toHaveBeenCalledTimes(1);
      expect(session1.unsubscribeSpies[0]).toHaveBeenCalledTimes(1);
      expect(session3.subscribe).toHaveBeenCalledTimes(1);

      // The replaced UI's late result does not revive.
      resolveRead1(readyFromNotAttemptedRuntime([makeTypedEntry('stale-cmd')], session1.catalogToken));
      await flushAsync();
      expect(getRenderedCommandNames(container1)).toEqual([]);

      // The second UI's waiter is unaffected and still publishes.
      resolveRead2(readyFromNotAttemptedRuntime([makeTypedEntry('shared-cmd')], session2.catalogToken));
      await flushAsync();
      expect(getRenderedCommandNames(container2)).toContain('/shared-cmd');

      // destroy unsubscribes and releases exactly once, idempotently.
      dropdown1.destroy();
      expect(session3.release).toHaveBeenCalledTimes(1);
      expect(session3.unsubscribeSpies[0]).toHaveBeenCalledTimes(1);
      dropdown1.destroy();
      expect(session3.release).toHaveBeenCalledTimes(1);
      expect(session3.unsubscribeSpies[0]).toHaveBeenCalledTimes(1);

      dropdown2.destroy();
    });

    it('keeps reset epochs distinct across A B A catalog contexts', async () => {
      const sessionA1 = createFakeSession({});
      const sessionB = createFakeSession({});
      const sessionA2 = createFakeSession({});
      const configA1 = { ...CLAUDE_CONFIG, createDiscoverySession: () => sessionA1 };
      const configB = { ...CLAUDE_CONFIG, createDiscoverySession: () => sessionB };
      const configA2 = { ...CLAUDE_CONFIG, createDiscoverySession: () => sessionA2 };

      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks, {
        providerConfig: configA1,
      });

      sessionA1.read.mockResolvedValue(readyFromNotAttemptedRuntime([makeTypedEntry('a-first')], sessionA1.catalogToken));
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/a-first');
      const oldAItemEl = getFirstItemEl(containerEl);

      // A -> B
      dropdown.setProviderCatalog(configB, null);
      expect(sessionA1.release).toHaveBeenCalledTimes(1);
      sessionB.read.mockResolvedValue(readyFromNotAttemptedRuntime([makeTypedEntry('b-cmd')], sessionB.catalogToken));
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/b-cmd');
      expect(getRenderedCommandNames(containerEl)).not.toContain('/a-first');

      // B -> A: a fresh A session with its own receipt epoch.
      dropdown.setProviderCatalog(configA2, null);
      expect(sessionB.release).toHaveBeenCalledTimes(1);
      sessionA2.read.mockResolvedValue(readyFromNotAttemptedRuntime([makeTypedEntry('a-second')], sessionA2.catalogToken));
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/a-second');

      // The old A receipt can never insert again, even though the name space matches.
      oldAItemEl.click();
      expect(inputEl.value).toBe('/');
      expect(callbacks.onSelect).toHaveBeenCalledTimes(0);

      // The new A receipt is consumable through the freshly rendered options.
      getFirstItemEl(containerEl).click();
      expect(inputEl.value).toBe('/a-second ');
      expect(callbacks.onSelect).toHaveBeenCalledTimes(1);

      dropdown.destroy();
    });

    it('coalesces source notifications without retries for stable empty or failed results', async () => {
      const eligibilityE0: CommandRuntimeEligibility = { token: {}, revision: 3 };
      const failedRuntime: RuntimeCommandRead = {
        status: 'failed', code: 'query-read-error', eligibility: eligibilityE0,
      };

      for (const kind of ['ready-empty', 'runtime-failed'] as const) {
        const session = createFakeSession({});
        const stableSnapshot: CommandDropdownSnapshot = kind === 'ready-empty'
          ? readyFromNotAttemptedRuntime([], session.catalogToken)
          : {
            ...readyFromAttemptedRuntime([makeTypedEntry('vault-cmd')], session.catalogToken, failedRuntime),
            fallbackReason: 'runtime-failed',
          };
        const localContainer = createMockEl();
        const localInput = createMockInput();
        const localCallbacks = createMockCallbacks();
        const dropdown = new SlashCommandDropdown(localContainer, localInput, localCallbacks, {
          providerConfig: typedConfig(session),
        });
        session.read.mockResolvedValue(stableSnapshot);

        localInput.value = '/';
        localInput.selectionStart = 1;
        dropdown.handleInputChange();
        await flushAsync();
        expect(session.read).toHaveBeenCalledTimes(1);
        expect(getRenderedCommandNames(localContainer)).toContain('/clear');

        // Synchronous consecutive notifications merge into a single refresh read.
        session.notify();
        session.notify();
        session.notify();
        await flushAsync();
        expect(session.read).toHaveBeenCalledTimes(2);

        // Stable empty/failed results do not self-trigger further reads.
        await flushAsync();
        await flushAsync();
        expect(session.read).toHaveBeenCalledTimes(2);

        dropdown.destroy();
        expect(session.release).toHaveBeenCalledTimes(1);
      }
    });

    it('clears a removed provider catalog without retaining its factory', async () => {
      const session = createFakeSession({});
      const factory = jest.fn(() => session);
      const legacyGetter = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks, {
        providerConfig: { ...CLAUDE_CONFIG, createDiscoverySession: factory },
        getProviderEntries: legacyGetter,
      });

      session.read.mockResolvedValue(readyFromNotAttemptedRuntime([makeTypedEntry('vault-cmd')], session.catalogToken));
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/vault-cmd');
      expect(session.read).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledTimes(1);

      // Removing the catalog clears provider callback/factory/entries but keeps builtins.
      dropdown.setProviderCatalog(null, null);
      expect(session.release).toHaveBeenCalledTimes(1);
      expect(session.unsubscribeSpies[0]).toHaveBeenCalledTimes(1);

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(session.read).toHaveBeenCalledTimes(1);
      expect(legacyGetter).toHaveBeenCalledTimes(0);
      const namesAfterRemoval = getRenderedCommandNames(containerEl);
      expect(namesAfterRemoval).toContain('/clear');
      expect(namesAfterRemoval).not.toContain('/vault-cmd');

      // A newly installed catalog re-displays through its own session.
      const session2 = createFakeSession({});
      dropdown.setProviderCatalog(typedConfig(session2), null);
      session2.read.mockResolvedValue(readyFromNotAttemptedRuntime([makeTypedEntry('reinstalled-cmd')], session2.catalogToken));
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/reinstalled-cmd');

      dropdown.destroy();
    });

    it('does not resurrect a hidden or destroyed menu from a session notification', async () => {
      const session = createFakeSession({});
      const dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks, {
        providerConfig: typedConfig(session),
      });
      session.read.mockResolvedValue(readyFromNotAttemptedRuntime([makeTypedEntry('vault-cmd')], session.catalogToken));

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/vault-cmd');
      expect(dropdown.isVisible()).toBe(true);

      // hide() withdraws menu interest: a later source notification clears
      // state but must not re-open the menu even though the trigger text is
      // still '/'.
      dropdown.hide();
      expect(dropdown.isVisible()).toBe(false);
      session.read.mockClear();
      session.notify();
      await flushAsync();
      expect(session.read).toHaveBeenCalledTimes(0);
      expect(dropdown.isVisible()).toBe(false);
      expect(getRenderedCommandNames(containerEl)).toEqual([]);

      // User intent returns through real input; only then may a notification
      // driven refresh re-open the menu.
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await flushAsync();
      expect(getRenderedCommandNames(containerEl)).toContain('/vault-cmd');

      // destroy() unsubscribes entirely: a late notification reaches nothing
      // and cannot re-render or re-read. The dropdown element is detached and
      // its stale click closure inserts nothing.
      const firstItemEl = getFirstItemEl(containerEl);
      dropdown.destroy();
      session.read.mockClear();
      session.notify();
      await flushAsync();
      expect(session.read).toHaveBeenCalledTimes(0);
      expect(session.unsubscribeSpies[0]).toHaveBeenCalledTimes(1);
      expect(getDropdownEl(containerEl)).toBeUndefined();
      firstItemEl?.click();
      expect(inputEl.value).toBe('/');
      expect(callbacks.onSelect).toHaveBeenCalledTimes(0);
    });
  });

});
