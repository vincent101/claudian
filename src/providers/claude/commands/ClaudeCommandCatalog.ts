import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type {
  CommandCatalogRegistryBinding,
  CommandDiscoveryResult,
  CommandDiscoveryTarget,
  CommandDiscoveryToken,
  CommandDropdownReceipt,
  CommandDropdownSession,
  CommandDropdownSnapshot,
  CommandProbeCleanup,
  CommandRuntimeEligibility,
  CommandSourceOutcome,
  CommandSourceReference,
  CommandSourceTargetRelation,
  CommandTargetCapture,
  CommandTargetReadContext,
  QueryCommandSourceReceipt,
  RuntimeCommandDiscovery,
  RuntimeCommandRead,
  VaultCommandSourceReceipt,
} from '../../../core/providers/commands/ProviderCommandDiscovery';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';
import { normalizePathForComparison } from '../../../utils/path';
import { isSkill } from '../../../utils/slashCommand';
import type { SkillStorage } from '../storage/SkillStorage';
import type { SlashCommandStorage } from '../storage/SlashCommandStorage';

function slashCommandToEntry(cmd: SlashCommand): ProviderCommandEntry {
  const skill = isSkill(cmd);
  return {
    id: cmd.id,
    providerId: 'claude',
    kind: skill ? 'skill' : 'command',
    name: cmd.name,
    description: cmd.description,
    content: cmd.content,
    argumentHint: cmd.argumentHint,
    allowedTools: cmd.allowedTools,
    model: cmd.model,
    disableModelInvocation: cmd.disableModelInvocation,
    userInvocable: cmd.userInvocable,
    context: cmd.context,
    agent: cmd.agent,
    hooks: cmd.hooks,
    scope: cmd.source === 'sdk' ? 'runtime' : 'vault',
    source: cmd.source ?? 'user',
    isEditable: cmd.source !== 'sdk',
    isDeletable: cmd.source !== 'sdk',
    displayPrefix: '/',
    insertPrefix: '/',
  };
}

function entryToSlashCommand(entry: ProviderCommandEntry): SlashCommand {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    content: entry.content,
    argumentHint: entry.argumentHint,
    allowedTools: entry.allowedTools,
    model: entry.model,
    disableModelInvocation: entry.disableModelInvocation,
    userInvocable: entry.userInvocable,
    context: entry.context,
    agent: entry.agent,
    hooks: entry.hooks,
    source: entry.source,
    kind: entry.kind,
  };
}

// SDK built-in skills that have no meaning inside Claudian
const BUILTIN_HIDDEN_COMMANDS = new Set([
  'context', 'cost', 'debug', 'extra-usage', 'heapdump', 'init',
  'insights', 'loop', 'schedule', 'security-review', 'simplify', 'update-config',
]);

// Projection evaluation order (§2.2 of the W1 design record), version 1.
const PROJECTION_POLICY_VERSION = 1;

// Production owned probes are banned by policy; the slot stays a constant fact.
const PROBE_CLEANUP_OWNED_DISABLED: CommandProbeCleanup = {
  status: 'not-started',
  reason: 'owned-probe-disabled',
};

function classifyQuerySourceRelation(
  requestedExternalPaths: readonly string[],
  scope: QueryCommandSourceReceipt['scope'],
): CommandSourceTargetRelation {
  // Missing metadata is not evidence of an empty Query scope.
  if (scope.unknown.includes('additionalDirectories')) {
    return 'unverified';
  }
  const scopeDirectories = scope.additionalDirectories;
  if (scopeDirectories === undefined) {
    return 'unverified';
  }
  const requested = new Set(requestedExternalPaths.map(normalizePathForComparison));
  const actual = new Set(scopeDirectories.map(normalizePathForComparison));
  if (requested.size !== actual.size) {
    return 'scope-mismatch';
  }
  for (const member of requested) {
    if (!actual.has(member)) {
      return 'scope-mismatch';
    }
  }
  return 'query-owned';
}

export type CommandProbe = () => Promise<SlashCommand[]>;

/** Same-file seam: the narrow catalog surface a dropdown session may touch. */
interface CatalogSessionHost {
  readonly catalogToken: CommandDiscoveryToken;
  readonly vaultToken: CommandDiscoveryToken;
  getVaultRevision(): number;
  currentRegistryRevision(): number;
  registryIsCurrent(): boolean;
  acquireVaultFlight(): { promise: Promise<ProviderCommandEntry[]>; revision: number };
  removeSession(session: ClaudeCommandDropdownSession): void;
}

type SessionSettlement = 'ok' | 'cancelled' | 'stale';

/** Everything a read freezes synchronously before its first await. */
interface FrozenRead {
  epoch: number;
  revision: number;
  vaultRevision: number;
  registryRevision: number;
  targetContext: CommandTargetReadContext;
  facet: RuntimeCommandDiscovery | null;
  waiter: AbortController;
  callerSignal: AbortSignal | undefined;
}

/**
 * Thin per-dropdown session over the W0 typed contracts. Sessions share the
 * catalog's storage but never the legacy sdkCommands/probe path, and never
 * write back into legacy state.
 */
class ClaudeCommandDropdownSession implements CommandDropdownSession {
  private epoch = 1;
  private revision = 0;
  private released = false;
  private receipt: CommandDropdownReceipt | null = null;
  private readonly waiters = new Set<AbortController>();
  private readonly listeners = new Set<() => void>();
  private targetSub: (() => void) | null = null;
  private facetSub: (() => void) | null = null;
  private currentFacet: RuntimeCommandDiscovery | null = null;
  private bindingSub: (() => void) | null = null;
  private readonly targetCapture: CommandTargetCapture | null;
  private lastTargetContext: CommandTargetReadContext | null = null;
  private vaultCache: { entries: readonly ProviderCommandEntry[]; vaultRevision: number } | null = null;
  // Unbound targets have no external mutators; the signal never aborts.
  private readonly unboundEligibility = new AbortController();

  constructor(
    private readonly host: CatalogSessionHost,
    targetCapture: CommandTargetCapture | null,
    binding: CommandCatalogRegistryBinding | null,
  ) {
    this.targetCapture = targetCapture;
    if (targetCapture) {
      this.targetSub = targetCapture.subscribe(() => this.handleTargetChanged());
    }
    if (binding) {
      this.bindingSub = binding.subscribe(() => this.invalidateProjection());
    }
  }

  read(callerSignal?: AbortSignal): Promise<CommandDropdownSnapshot> {
    let observedRuntime: CommandSourceOutcome<RuntimeCommandRead> = { status: 'not-attempted' };
    const terminal = (status: 'cancelled' | 'stale'): CommandDropdownSnapshot =>
      this.terminalSnapshot(status, observedRuntime);

    if (this.released) return Promise.resolve(terminal('stale'));
    if (callerSignal?.aborted) return Promise.resolve(terminal('cancelled'));

    const waiter = new AbortController();
    this.waiters.add(waiter);

    // Freeze target capture, registry revision, session epoch/revision, and
    // the runtime facet synchronously before the first await.
    const frozen: FrozenRead = {
      epoch: this.epoch,
      revision: this.revision,
      vaultRevision: this.host.getVaultRevision(),
      registryRevision: this.host.currentRegistryRevision(),
      targetContext: this.captureTargetContext(this.epoch),
      facet: null,
      waiter,
      callerSignal,
    };
    frozen.facet = this.bindFacet(frozen.targetContext);
    this.lastTargetContext = frozen.targetContext;

    const main = this.executeRead(frozen, runtime => {
      observedRuntime = runtime;
    });

    // The session must settle even when a vault/SDK promise stays pending
    // forever: caller abort, target abort, invalidate, and release all abort
    // the waiter, and this settlement races the main flow.
    let abortListener: (() => void) | null = null;
    const abortSettlement = new Promise<CommandDropdownSnapshot>(resolve => {
      abortListener = () => resolve(terminal(callerSignal?.aborted ? 'cancelled' : 'stale'));
      if (waiter.signal.aborted) {
        abortListener();
      } else {
        waiter.signal.addEventListener('abort', abortListener, { once: true });
      }
    });

    const callerListener = () => waiter.abort();
    callerSignal?.addEventListener('abort', callerListener, { once: true });
    const eligibilityListener = () => waiter.abort();
    frozen.targetContext.eligibilitySignal.addEventListener('abort', eligibilityListener, { once: true });

    return (async () => {
      try {
        return await Promise.race([main, abortSettlement]);
      } finally {
        this.waiters.delete(waiter);
        if (!waiter.signal.aborted && abortListener) {
          waiter.signal.removeEventListener('abort', abortListener);
        }
        callerSignal?.removeEventListener('abort', callerListener);
        frozen.targetContext.eligibilitySignal.removeEventListener('abort', eligibilityListener);
      }
    })();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isCurrent(receipt: CommandDropdownReceipt): boolean {
    if (this.released) return false;
    if (receipt.catalogToken !== this.host.catalogToken) return false;
    if (receipt.sessionEpoch !== this.epoch) return false;
    if (receipt.sessionRevision !== this.revision) return false;
    if (receipt.registryRevision !== this.host.currentRegistryRevision()) return false;
    if (!this.host.registryIsCurrent()) return false;
    const context = this.lastTargetContext;
    if (!context || !context.isCurrent()) return false;
    if (receipt.runtimeEligibility !== null &&
        (!this.currentFacet || !this.currentFacet.isCurrent(receipt.runtimeEligibility))) return false;
    const target = context.target;
    if (target.kind === 'tab') {
      return receipt.targetToken === target.targetToken
        && receipt.targetTicket === target.ticket
        && receipt.targetGeneration === target.generation;
    }
    return receipt.targetToken === null && receipt.targetTicket === null && receipt.targetGeneration === null;
  }

  /** Advances epoch+revision; keeps the session open for later reads. */
  invalidate(): void {
    this.invalidateProjection(true);
  }

  /** Idempotent; settles every waiter but never closes the borrowed Query owner. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.epoch++;
    this.revision++;
    this.receipt = null;
    this.vaultCache = null;
    this.abortWaiters();
    this.notifyListeners();
    this.listeners.clear();
    this.targetSub?.();
    this.targetSub = null;
    this.facetSub?.();
    this.facetSub = null;
    this.currentFacet = null;
    this.bindingSub?.();
    this.bindingSub = null;
    this.host.removeSession(this);
  }

  private async executeRead(
    frozen: FrozenRead,
    observeRuntime: (runtime: CommandSourceOutcome<RuntimeCommandRead>) => void,
  ): Promise<CommandDropdownSnapshot> {
    let runtimeSlot: CommandSourceOutcome<RuntimeCommandRead> = { status: 'not-attempted' };

    if (frozen.facet) {
      const runtimeRead = await frozen.facet.read(frozen.waiter.signal, { retryFailed: false });
      runtimeSlot = runtimeRead;
      observeRuntime(runtimeRead);

      let status = this.settlementStatus(frozen);
      // Attempted failed/unavailable results are guarded by the same
      // eligibility check as ready ones.
      if (status === 'ok' && !frozen.facet.isCurrent(runtimeRead.eligibility)) {
        status = 'stale';
      }
      if (status !== 'ok') return this.terminalSnapshot(status, runtimeSlot);
    }

    let fallbackReason: string | null;
    let entries: readonly ProviderCommandEntry[] = [];
    let needsVault: boolean;
    let rawRuntime: number | null = null;
    let visibleRuntime: number | null = null;
    let runtimeCoverage: QueryCommandSourceReceipt['coverage'] | null = null;
    let runtimeEligibility: CommandRuntimeEligibility | null = null;
    const sourceRefs: CommandSourceReference[] = [];

    if (!frozen.facet) {
      // Unbound target or a tab whose runtime exposes no facet: never fall
      // back to legacy sdkCommands or cross-tab reads.
      runtimeSlot = { status: 'not-attempted' };
      fallbackReason = frozen.targetContext.target.kind === 'tab' ? 'runtime-not-attempted' : 'unbound';
      needsVault = true;
    } else {
      const runtimeRead = runtimeSlot as RuntimeCommandRead;
      runtimeEligibility = runtimeRead.eligibility;
      if (runtimeRead.status === 'ready') {
        rawRuntime = runtimeRead.entries.length;
        const visible = runtimeRead.entries.filter(cmd => !BUILTIN_HIDDEN_COMMANDS.has(cmd.name.toLowerCase()));
        visibleRuntime = visible.length;
        runtimeCoverage = runtimeRead.receipt.coverage;
        sourceRefs.push({
          receipt: runtimeRead.receipt,
          relation: classifyQuerySourceRelation(
            frozen.targetContext.target.requestedExternalPaths,
            runtimeRead.receipt.scope,
          ),
        });
        if (visible.length > 0) {
          entries = visible.map(slashCommandToEntry);
          fallbackReason = null;
          needsVault = false;
        } else {
          fallbackReason = rawRuntime === 0 ? 'runtime-empty' : 'name-policy-empty';
          needsVault = true;
        }
      } else if (runtimeRead.status === 'unavailable') {
        fallbackReason = 'runtime-unavailable';
        needsVault = true;
      } else if (runtimeRead.status === 'failed') {
        fallbackReason = 'runtime-failed';
        needsVault = true;
      } else {
        // Runtime cancelled/stale lift to the outer projection; no new fallback starts.
        return this.terminalSnapshot(runtimeRead.status, runtimeRead);
      }
    }

    let vaultOutcome: CommandSourceOutcome<CommandDiscoveryResult<ProviderCommandEntry, VaultCommandSourceReceipt>> = { status: 'not-attempted' };
    let rawVault: number | null = null;
    let visibleVault: number | null = null;

    if (needsVault) {
      const preStatus = this.settlementStatus(frozen);
      if (preStatus !== 'ok') return this.terminalSnapshot(preStatus, runtimeSlot);

      let vaultEntries: readonly ProviderCommandEntry[] | null;
      if (this.vaultCache && this.vaultCache.vaultRevision === this.host.getVaultRevision()) {
        vaultEntries = this.vaultCache.entries;
      } else {
        const flight = this.host.acquireVaultFlight();
        try {
          vaultEntries = await flight.promise;
        } catch {
          // Explicit vault failure is registered, never fabricated as ready.
          vaultEntries = null;
        }
      }

      const postStatus = this.settlementStatus(frozen);
      if (postStatus !== 'ok') return this.terminalSnapshot(postStatus, runtimeSlot);
      // Runtime eligibility may have been revoked silently while vault I/O
      // was pending. Validate the same attempted generation before cache or
      // publication, even when the tab target itself remains current.
      if (runtimeEligibility !== null &&
          (!frozen.facet || !frozen.facet.isCurrent(runtimeEligibility))) {
        return this.terminalSnapshot('stale', runtimeSlot);
      }
      if (this.host.getVaultRevision() !== frozen.vaultRevision) return this.terminalSnapshot('stale', runtimeSlot);

      if (vaultEntries === null) {
        vaultOutcome = { status: 'failed', code: 'vault-read-failed' };
        entries = [];
      } else {
        const vaultReceipt: VaultCommandSourceReceipt = {
          sourceKind: 'vault-best-effort',
          sourceToken: this.host.vaultToken,
          sourceRevision: this.host.getVaultRevision(),
          scope: { kind: 'vault', sourceToken: this.host.vaultToken, unknown: [] },
          coverage: 'best-effort-unknown',
        };
        vaultOutcome = { status: 'ready', entries: vaultEntries, receipt: vaultReceipt };
        sourceRefs.push({ receipt: vaultReceipt, relation: 'unverified' });
        entries = vaultEntries;
        rawVault = vaultEntries.length;
        visibleVault = vaultEntries.length;
        // A late old vault completion must never poison the session cache.
        this.vaultCache = { entries: vaultEntries, vaultRevision: this.host.getVaultRevision() };
      }
    }

    const vaultCoverage = vaultOutcome.status === 'ready' ? ('best-effort-unknown' as const) : null;
    const target = frozen.targetContext.target;
    const targetToken = target.kind === 'tab' ? target.targetToken : null;
    const targetTicket = target.kind === 'tab' ? target.ticket : null;
    const targetGeneration = target.kind === 'tab' ? target.generation : null;

    if (runtimeEligibility === null) {
      const receipt: CommandDropdownReceipt<null> = {
        catalogToken: this.host.catalogToken,
        registryRevision: frozen.registryRevision,
        sessionEpoch: frozen.epoch,
        sessionRevision: frozen.revision,
        targetToken,
        targetTicket,
        targetGeneration,
        runtimeEligibility: null,
        sourceRefs,
        projectionPolicyVersion: PROJECTION_POLICY_VERSION,
      };
      const snapshot: CommandDropdownSnapshot = {
        status: 'ready',
        entries,
        runtime: { status: 'not-attempted' },
        receipt,
        probe: { status: 'not-attempted' },
        vault: vaultOutcome,
        probeCleanup: PROBE_CLEANUP_OWNED_DISABLED,
        sourceRefs,
        rawCount: { runtime: rawRuntime, probe: null, vault: rawVault },
        catalogVisibleCount: { runtime: visibleRuntime, probe: null, vault: visibleVault },
        coverage: { runtime: runtimeCoverage, probe: null, vault: vaultCoverage },
        fallbackReason,
      };
      this.commitReceipt(frozen, receipt);
      return snapshot;
    }

    const receipt: CommandDropdownReceipt<CommandRuntimeEligibility> = {
      catalogToken: this.host.catalogToken,
      registryRevision: frozen.registryRevision,
      sessionEpoch: frozen.epoch,
      sessionRevision: frozen.revision,
      targetToken,
      targetTicket,
      targetGeneration,
      runtimeEligibility,
      sourceRefs,
      projectionPolicyVersion: PROJECTION_POLICY_VERSION,
    };
    const snapshot: CommandDropdownSnapshot = {
      status: 'ready',
      entries,
      runtime: runtimeSlot as RuntimeCommandRead,
      receipt,
      probe: { status: 'not-attempted' },
      vault: vaultOutcome,
      probeCleanup: PROBE_CLEANUP_OWNED_DISABLED,
      sourceRefs,
      rawCount: { runtime: rawRuntime, probe: null, vault: rawVault },
      catalogVisibleCount: { runtime: visibleRuntime, probe: null, vault: visibleVault },
      coverage: { runtime: runtimeCoverage, probe: null, vault: vaultCoverage },
      fallbackReason,
    };
    this.commitReceipt(frozen, receipt);
    return snapshot;
  }

  private captureTargetContext(epoch: number): CommandTargetReadContext {
    if (this.targetCapture) {
      return this.targetCapture.capture(epoch);
    }
    // Unbound default: no active-tab lookup, no global sdkCommands read.
    const frozenEpoch = epoch;
    const frozenRevision = this.revision;
    const frozenRegistryRevision = this.host.currentRegistryRevision();
    const target: CommandDiscoveryTarget = {
      kind: 'unbound',
      providerId: 'claude',
      sessionEpoch: frozenEpoch,
      registryRevision: frozenRegistryRevision,
      targetToken: null,
      ticket: null,
      generation: null,
      runtime: null,
      contextKey: null,
      requestedExternalPaths: [],
    };
    return {
      target,
      eligibilitySignal: this.unboundEligibility.signal,
      isCurrent: () => !this.released && this.epoch === frozenEpoch && this.revision === frozenRevision,
    };
  }

  private bindFacet(context: CommandTargetReadContext): RuntimeCommandDiscovery | null {
    const runtime = context.target.kind === 'tab' ? context.target.runtime : null;
    const facet = runtime?.getCommandDiscovery?.() ?? null;
    if (facet !== this.currentFacet) {
      this.facetSub?.();
      this.facetSub = null;
      this.currentFacet = facet;
      if (facet) {
        // Source notifications only invalidate; listeners never re-read the SDK.
        this.facetSub = facet.subscribe(() => this.invalidateProjection());
      }
    }
    return facet;
  }

  private settlementStatus(frozen: FrozenRead): SessionSettlement {
    if (frozen.waiter.signal.aborted) {
      return frozen.callerSignal?.aborted ? 'cancelled' : 'stale';
    }
    if (this.released) return 'stale';
    if (this.epoch !== frozen.epoch || this.revision !== frozen.revision) return 'stale';
    if (!frozen.targetContext.isCurrent()) return 'stale';
    if (this.host.currentRegistryRevision() !== frozen.registryRevision) return 'stale';
    if (!this.host.registryIsCurrent()) return 'stale';
    return 'ok';
  }

  private commitReceipt(frozen: FrozenRead, receipt: CommandDropdownReceipt): void {
    if (this.released || this.epoch !== frozen.epoch || this.revision !== frozen.revision) return;
    this.receipt = receipt;
  }

  private terminalSnapshot(
    status: 'cancelled' | 'stale',
    runtime: CommandSourceOutcome<RuntimeCommandRead>,
  ): CommandDropdownSnapshot {
    return {
      status,
      entries: [],
      runtime,
      receipt: null,
      probe: { status: 'not-attempted' },
      vault: { status: 'not-attempted' },
      probeCleanup: PROBE_CLEANUP_OWNED_DISABLED,
      sourceRefs: [],
      rawCount: { runtime: null, probe: null, vault: null },
      catalogVisibleCount: { runtime: null, probe: null, vault: null },
      coverage: { runtime: null, probe: null, vault: null },
      fallbackReason: null,
    };
  }

  private handleTargetChanged(): void {
    // A new target retires the old facet binding; the next read rebinds.
    this.facetSub?.();
    this.facetSub = null;
    this.currentFacet = null;
    this.invalidateProjection();
  }

  onVaultRevisionChanged(): void {
    this.invalidateProjection();
  }

  /**
   * Advance revision (and optionally epoch), void the receipt and vault
   * cache, settle the session's waiters, then notify listeners — in that
   * order. Listeners only learn about invalidation.
   */
  private invalidateProjection(advanceEpoch = false): void {
    if (this.released) return;
    if (advanceEpoch) this.epoch++;
    this.revision++;
    this.receipt = null;
    this.vaultCache = null;
    this.abortWaiters();
    this.notifyListeners();
  }

  private abortWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.abort();
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export class ClaudeCommandCatalog implements ProviderCommandCatalog {
  private sdkCommands: SlashCommand[] = [];
  private probePromise: Promise<void> | null = null;
  private readonly catalogToken: CommandDiscoveryToken = {};
  private readonly vaultToken: CommandDiscoveryToken = {};
  private vaultRevision = 0;
  private vaultFlight: { promise: Promise<ProviderCommandEntry[]>; revision: number } | null = null;
  private readonly activeSessions = new Set<ClaudeCommandDropdownSession>();

  constructor(
    private commandStorage: SlashCommandStorage,
    private skillStorage: SkillStorage,
    private probe?: CommandProbe,
    private registryBinding?: CommandCatalogRegistryBinding,
  ) {}

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.sdkCommands = commands;
  }

  async listDropdownEntries(context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    void context;
    // SDK commands already include vault commands/skills (the SDK scans
    // .claude/commands/ and .claude/skills/ internally). No file scan needed.
    // When the cache is empty (cold start, no active runtime), probe the SDK.
    if (this.sdkCommands.length === 0 && this.probe) {
      await this.ensureProbed();
    }
    const runtimeEntries = this.sdkCommands
      .filter(cmd => !BUILTIN_HIDDEN_COMMANDS.has(cmd.name.toLowerCase()))
      .map(slashCommandToEntry);
    if (runtimeEntries.length > 0) {
      return runtimeEntries;
    }
    return this.listVaultEntries();
  }

  /** Probe the SDK for commands. Deduplicates concurrent calls. */
  private async ensureProbed(): Promise<void> {
    if (!this.probe) return;
    if (!this.probePromise) {
      this.probePromise = this.probe().then((commands) => {
        // Only apply probe results if the runtime hasn't provided fresher data
        if (this.sdkCommands.length === 0 && commands.length > 0) {
          this.sdkCommands = commands;
        }
      }).catch(() => {
        // Probe is best-effort
      }).finally(() => {
        this.probePromise = null;
      });
    }
    await this.probePromise;
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    const commands = await this.commandStorage.loadAll();
    const skills = await this.skillStorage.loadAll();
    return [...commands, ...skills].map(slashCommandToEntry);
  }

  async saveVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    const cmd = entryToSlashCommand(entry);
    if (entry.kind === 'skill') {
      await this.skillStorage.save(cmd);
    } else {
      await this.commandStorage.save(cmd);
    }
    this.bumpVaultRevision();
  }

  async deleteVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    if (entry.kind === 'skill') {
      await this.skillStorage.delete(entry.id);
    } else {
      await this.commandStorage.delete(entry.id);
    }
    this.bumpVaultRevision();
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      providerId: 'claude',
      triggerChars: ['/'],
      builtInPrefix: '/',
      skillPrefix: '/',
      commandPrefix: '/',
      // Unbound by default: no active-tab lookup, no global sdkCommands read.
      createDiscoverySession: () => this.openDropdownSession(),
    };
  }

  async refresh(): Promise<void> {
    // Claude runtime revalidation happens externally via setRuntimeCommands
    // (legacy); typed sessions rescan vault through the bumped revision.
    this.bumpVaultRevision();
  }

  openDropdownSession(targetCapture?: CommandTargetCapture): CommandDropdownSession {
    const host: CatalogSessionHost = {
      catalogToken: this.catalogToken,
      vaultToken: this.vaultToken,
      getVaultRevision: () => this.vaultRevision,
      currentRegistryRevision: () => this.currentRegistryRevision(),
      registryIsCurrent: () => this.registryIsCurrent(),
      acquireVaultFlight: () => this.acquireVaultFlight(),
      removeSession: session => {
        this.activeSessions.delete(session);
      },
    };
    const session = new ClaudeCommandDropdownSession(host, targetCapture ?? null, this.registryBinding ?? null);
    this.activeSessions.add(session);
    return session;
  }

  // A catalog without a registry binding behaves as revision 0 / current —
  // the production factory must supply a real binding (W4).
  private currentRegistryRevision(): number {
    return this.registryBinding ? this.registryBinding.getRevision() : 0;
  }

  private registryIsCurrent(): boolean {
    return this.registryBinding ? this.registryBinding.isCurrent() : true;
  }

  private acquireVaultFlight(): { promise: Promise<ProviderCommandEntry[]>; revision: number } {
    if (this.vaultFlight && this.vaultFlight.revision === this.vaultRevision) {
      return this.vaultFlight;
    }
    const promise = this.listVaultEntries();
    // Observe the underlying promise so a late failure never becomes an
    // unhandled rejection once every joiner has settled early.
    void promise.catch(() => {});
    const flight = { promise, revision: this.vaultRevision };
    this.vaultFlight = flight;
    void promise.then(
      () => {
        if (this.vaultFlight === flight) this.vaultFlight = null;
      },
      () => {
        if (this.vaultFlight === flight) this.vaultFlight = null;
      },
    );
    return flight;
  }

  private bumpVaultRevision(): void {
    this.vaultRevision++;
    for (const session of [...this.activeSessions]) session.onVaultRevisionChanged();
  }
}
