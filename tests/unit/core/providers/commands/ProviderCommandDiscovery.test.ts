import type { ProviderCommandCatalog, ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type {
  CommandDiscoveryResult,
  CommandDropdownReceipt,
  CommandDropdownSession,
  CommandDropdownSnapshot,
  CommandDropdownSourceValues,
  CommandProbeCleanup,
  CommandProbeCleanupFinal,
  CommandProbeRun,
  CommandRuntimeEligibility,
  CommandSourceReceipt,
  CommandSourceReference,
  CommandTargetCapture,
  ProbeCommandSourceReceipt,
  QueryCommandSourceReceipt,
  RuntimeCommandDiscovery,
  RuntimeCommandRead,
  VaultCommandSourceReceipt,
} from '@/core/providers/commands/ProviderCommandDiscovery';
import type { ChatRuntime } from '@/core/runtime/ChatRuntime';
import type { SlashCommand } from '@/core/types';

// tsc enforces these negative controls. Never execute their invalid assignments.
function compileTimeNegativeControls(
  ready: Extract<RuntimeCommandRead, { status: 'ready' }>,
  probeReceipt: ProbeCommandSourceReceipt,
  pendingCleanup: Extract<CommandProbeCleanup, { status: 'pending' }>,
  run: CommandProbeRun,
) {
  // @ts-expect-error An actual-query runtime read cannot carry a base-probe receipt.
  const queryWithProbeReceipt: RuntimeCommandRead = { ...ready, receipt: probeReceipt };
  // @ts-expect-error Runtime eligibility is mandatory even when no Query exists.
  const unavailableWithoutEligibility: RuntimeCommandRead = { status: 'unavailable' };
  // @ts-expect-error Pending cleanup is not a terminal cleanup result.
  const pendingFinal: CommandProbeCleanupFinal = pendingCleanup;
  // @ts-expect-error Confirmed cleanup requires direct-child-exit evidence.
  const confirmedWithoutEvidence: CommandProbeCleanupFinal = { status: 'confirmed' };
  // @ts-expect-error stdout EOF does not prove direct-child exit.
  const eofConfirmation: CommandProbeCleanupFinal = { status: 'confirmed', evidence: 'stdout-eof' };

  const { inputToken, ...withoutInputToken } = run;
  // @ts-expect-error A probe handle must retain the frozen input token.
  const missingInputToken: CommandProbeRun = withoutInputToken;
  const { flightToken, ...withoutFlightToken } = run;
  // @ts-expect-error A probe handle must retain its own flight token.
  const missingFlightToken: CommandProbeRun = withoutFlightToken;
  const { discovery, ...withoutDiscovery } = run;
  // @ts-expect-error A probe handle must expose the discovery Promise.
  const missingDiscovery: CommandProbeRun = withoutDiscovery;
  const { cleanup, ...withoutCleanup } = run;
  // @ts-expect-error A probe handle must independently expose the cleanup Promise.
  const missingCleanup: CommandProbeRun = withoutCleanup;

  const probeReady: CommandDiscoveryResult<SlashCommand, ProbeCommandSourceReceipt> = {
    status: 'ready', entries: [], receipt: probeReceipt,
  };
  // @ts-expect-error Discovery must be a Promise, not a synchronous outcome.
  const synchronousDiscovery: CommandProbeRun = { ...run, discovery: probeReady };
  // @ts-expect-error Cleanup must be a Promise, not a synchronous outcome.
  const synchronousCleanup: CommandProbeRun = { ...run, cleanup: { status: 'not-started' } };
  // @ts-expect-error The cleanup Promise must resolve to a final result, never pending.
  const pendingCleanupPromise: CommandProbeRun = { ...run, cleanup: Promise.resolve(pendingCleanup) };

  void [
    queryWithProbeReceipt, unavailableWithoutEligibility, pendingFinal,
    confirmedWithoutEvidence, eofConfirmation, missingInputToken, missingFlightToken,
    missingDiscovery, missingCleanup, synchronousDiscovery, synchronousCleanup,
    pendingCleanupPromise, inputToken, flightToken, discovery, cleanup,
  ];
}
void compileTimeNegativeControls;

// Optional outlets must expose the frozen contracts without changing legacy APIs.
function compileTimeOptionalOutlets(
  runtime: ChatRuntime,
  catalog: ProviderCommandCatalog,
  config: ProviderCommandDropdownConfig,
  targetCapture: CommandTargetCapture,
) {
  const facet: RuntimeCommandDiscovery | undefined = runtime.getCommandDiscovery?.();
  const unboundSession: CommandDropdownSession | undefined = catalog.openDropdownSession?.();
  const targetSession: CommandDropdownSession | undefined = catalog.openDropdownSession?.(targetCapture);
  const dropdownSession: CommandDropdownSession | undefined = config.createDiscoverySession?.();
  const commands: Promise<SlashCommand[]> = runtime.getSupportedCommands();
  void [facet, unboundSession, targetSession, dropdownSession, commands];
}
void compileTimeOptionalOutlets;

// tsc enforces these contract-revision negative controls. Never execute them.
function eligibilityContractNegativeControls(
  details: Omit<CommandDropdownSnapshot, 'status' | 'entries' | 'runtime' | 'receipt'>,
  receipt: CommandDropdownReceipt,
  ready: Extract<RuntimeCommandRead, { status: 'ready' }>,
  failed: Extract<RuntimeCommandRead, { status: 'failed' }>,
  unavailable: Extract<RuntimeCommandRead, { status: 'unavailable' }>,
  cancelled: Extract<RuntimeCommandRead, { status: 'cancelled' }>,
  stale: Extract<RuntimeCommandRead, { status: 'stale' }>,
  eligibility: CommandRuntimeEligibility,
) {
  // @ts-expect-error Ready runtime cannot lose eligibility in a publishable snapshot.
  const lostReadyEligibility: CommandDropdownSnapshot = { ...details, status: 'ready', entries: [], runtime: ready, receipt: { ...receipt, runtimeEligibility: null } };
  // @ts-expect-error Attempted failed cannot discard runtime eligibility.
  const lostFailedEligibility: CommandDropdownSnapshot = { ...details, status: 'ready', entries: [], runtime: failed, receipt: { ...receipt, runtimeEligibility: null } };
  // @ts-expect-error Attempted unavailable cannot discard runtime eligibility.
  const lostUnavailableEligibility: CommandDropdownSnapshot = { ...details, status: 'ready', entries: [], runtime: unavailable, receipt: { ...receipt, runtimeEligibility: null } };
  // @ts-expect-error Cancelled runtime cannot lose eligibility if wrapped as a ready projection.
  const lostCancelledEligibility: CommandDropdownSnapshot = { ...details, status: 'ready', entries: [], runtime: cancelled, receipt: { ...receipt, runtimeEligibility: null } };
  // @ts-expect-error Stale runtime cannot lose eligibility if wrapped as a ready projection.
  const lostStaleEligibility: CommandDropdownSnapshot = { ...details, status: 'ready', entries: [], runtime: stale, receipt: { ...receipt, runtimeEligibility: null } };
  // @ts-expect-error Not-attempted has no runtime eligibility to claim.
  const inventedEligibility: CommandDropdownSnapshot = { ...details, status: 'ready', entries: [], runtime: { status: 'not-attempted' }, receipt: { ...receipt, runtimeEligibility: eligibility } };
  const { runtimeEligibility, ...withoutEligibility } = receipt;
  // @ts-expect-error A publishable snapshot must retain the explicit eligibility field.
  const missingEligibility: CommandDropdownSnapshot = { ...details, status: 'ready', entries: [], runtime: ready, receipt: withoutEligibility };
  // @ts-expect-error Broad receipt cannot silently flow into an attempted-only receipt.
  const uncheckedReceipt: CommandDropdownReceipt<CommandRuntimeEligibility> = receipt;
  void [
    lostReadyEligibility, lostFailedEligibility, lostUnavailableEligibility,
    lostCancelledEligibility, lostStaleEligibility, inventedEligibility,
    missingEligibility, uncheckedReceipt, runtimeEligibility,
  ];
}
void eligibilityContractNegativeControls;

function relationContractNegativeControls(
  receipt: CommandDropdownReceipt,
  probe: ProbeCommandSourceReceipt,
  vault: VaultCommandSourceReceipt,
  mixed: QueryCommandSourceReceipt | VaultCommandSourceReceipt,
) {
  // @ts-expect-error Vault is not owned by the target Query.
  const vaultAsOwned: CommandSourceReference = { receipt: vault, relation: 'query-owned' };
  // @ts-expect-error Probe is not owned by the target Query.
  const probeAsOwned: CommandSourceReference = { receipt: probe, relation: 'query-owned' };
  const invalidRef = { receipt: vault, relation: 'query-owned' as const };
  // @ts-expect-error Wrong source relation must remain invalid through an existing variable.
  const indirect: CommandSourceReference = invalidRef;
  // @ts-expect-error Dropdown receipt arrays cannot launder wrong source relations.
  const launderedReceipt: CommandDropdownReceipt = { ...receipt, sourceRefs: [invalidRef] };
  // @ts-expect-error Snapshot reference arrays use the same correlated contract.
  const launderedSnapshot: CommandDropdownSnapshot['sourceRefs'] = [invalidRef];
  // @ts-expect-error Explicit vault receipt generic cannot claim Query ownership.
  const explicitVault: CommandSourceReference<VaultCommandSourceReceipt> = invalidRef;
  // @ts-expect-error Explicit receipt unions must distribute rather than lose correlation.
  const widened: CommandSourceReference<QueryCommandSourceReceipt | VaultCommandSourceReceipt> = { receipt: mixed, relation: 'query-owned' };
  void [vaultAsOwned, probeAsOwned, indirect, launderedReceipt, launderedSnapshot, explicitVault, widened];
}
void relationContractNegativeControls;

function coverageContractNegativeControls() {
  // @ts-expect-error Runtime coverage slot cannot use probe coverage.
  const runtimeAsCandidate: CommandDropdownSnapshot['coverage'] = { runtime: 'candidate', probe: null, vault: null };
  // @ts-expect-error Runtime coverage slot cannot use vault coverage.
  const runtimeAsVault: CommandDropdownSnapshot['coverage'] = { runtime: 'best-effort-unknown', probe: null, vault: null };
  // @ts-expect-error Probe coverage slot cannot use Query coverage.
  const probeAsInitialize: CommandDropdownSnapshot['coverage'] = { runtime: null, probe: 'initialize-observed', vault: null };
  // @ts-expect-error Probe coverage slot cannot use vault coverage.
  const probeAsVault: CommandDropdownSnapshot['coverage'] = { runtime: null, probe: 'best-effort-unknown', vault: null };
  // @ts-expect-error Vault coverage slot cannot use Query coverage.
  const vaultAsInitialize: CommandDropdownSnapshot['coverage'] = { runtime: null, probe: null, vault: 'initialize-observed' };
  // @ts-expect-error Vault coverage slot cannot use probe coverage.
  const vaultAsCandidate: CommandDropdownSnapshot['coverage'] = { runtime: null, probe: null, vault: 'candidate' };
  void [runtimeAsCandidate, runtimeAsVault, probeAsInitialize, probeAsVault, vaultAsInitialize, vaultAsCandidate];
}
void coverageContractNegativeControls;

const queryToken = {};
const queryReceipt: QueryCommandSourceReceipt = {
  sourceKind: 'initialize-response',
  sourceToken: queryToken,
  sourceRevision: 1,
  scope: { kind: 'actual-query', sourceToken: queryToken, unknown: ['plugins'] },
  coverage: 'initialize-observed',
};
const probeToken = {};
const probeReceipt: ProbeCommandSourceReceipt = {
  sourceKind: 'probe-candidate',
  sourceToken: probeToken,
  sourceRevision: 1,
  scope: { kind: 'base-probe', sourceToken: probeToken, unknown: ['mcp'] },
  coverage: 'candidate',
};
const vaultToken = {};
const vaultReceipt: VaultCommandSourceReceipt = {
  sourceKind: 'vault-best-effort',
  sourceToken: vaultToken,
  sourceRevision: 1,
  scope: { kind: 'vault', sourceToken: vaultToken, unknown: [] },
  coverage: 'best-effort-unknown',
};
const eligibility: CommandRuntimeEligibility = { token: {}, revision: 1 };
const dropdownDetails: Omit<CommandDropdownSnapshot, 'status' | 'entries' | 'runtime' | 'receipt'> = {
  probe: { status: 'not-attempted' },
  vault: { status: 'ready', entries: [], receipt: vaultReceipt },
  probeCleanup: { status: 'not-started' },
  sourceRefs: [],
  rawCount: { runtime: 0, probe: null, vault: null },
  catalogVisibleCount: { runtime: 0, probe: null, vault: null },
  coverage: { runtime: null, probe: null, vault: vaultReceipt.coverage },
  fallbackReason: null,
};
const dropdownReceipt: CommandDropdownReceipt = {
  catalogToken: {},
  registryRevision: 1,
  sessionEpoch: 1,
  sessionRevision: 1,
  targetToken: null,
  targetTicket: null,
  targetGeneration: null,
  runtimeEligibility: eligibility,
  sourceRefs: [],
  projectionPolicyVersion: 1,
};
const eligibilityOf = (snapshot: CommandDropdownSnapshot): CommandRuntimeEligibility | null =>
  snapshot.receipt?.runtimeEligibility ?? null;

// These are valid typed fixtures, not production runtime/probe behavior tests.
describe('ProviderCommandDiscovery type contract', () => {
  it('accepts a ready-empty actual-query read with explicit eligibility', () => {
    const read: RuntimeCommandRead = {
      status: 'ready', entries: [], receipt: queryReceipt, eligibility,
    };

    expect(read.entries).toEqual([]);
    expect(read.receipt.sourceKind).toBe('initialize-response');
    expect(read.receipt.coverage).toBe('initialize-observed');
    expect(read.eligibility).toBe(eligibility);
  });

  it('retains eligibility for failed and unavailable runtime reads', () => {
    const failed: RuntimeCommandRead = {
      status: 'failed', code: 'query-command-read-failed', eligibility,
    };
    const unavailable: RuntimeCommandRead = {
      status: 'unavailable', reason: 'no-query', eligibility,
    };

    expect(failed.status).toBe('failed');
    expect(unavailable.status).toBe('unavailable');
    expect(failed.eligibility).toBe(unavailable.eligibility);
  });

  it('accepts pending observation separately from confirmed final cleanup', () => {
    const pending: CommandProbeCleanup = { status: 'pending' };
    const confirmed: CommandProbeCleanupFinal = {
      status: 'confirmed', evidence: 'direct-child-exit',
    };

    expect(pending.status).toBe('pending');
    expect(confirmed.evidence).toBe('direct-child-exit');
  });

  it('accepts independent input/flight tokens and discovery/cleanup Promises', async () => {
    const inputToken = {};
    const flightToken = {};
    const discovery: CommandDiscoveryResult<SlashCommand, ProbeCommandSourceReceipt> = {
      status: 'ready', entries: [], receipt: probeReceipt,
    };
    const cleanup: CommandProbeCleanupFinal = {
      status: 'confirmed', evidence: 'direct-child-exit',
    };
    const run: CommandProbeRun = {
      inputToken, flightToken,
      discovery: Promise.resolve(discovery),
      cleanup: Promise.resolve(cleanup),
    };

    expect(run.inputToken).toBe(inputToken);
    expect(run.flightToken).toBe(flightToken);
    expect(run.inputToken).not.toBe(run.flightToken);
    await expect(run.discovery).resolves.toBe(discovery);
    await expect(run.cleanup).resolves.toBe(cleanup);
  });

  it('keeps a legacy dropdown config valid without a session factory', () => {
    const config: ProviderCommandDropdownConfig = {
      providerId: 'claude', triggerChars: ['/'], builtInPrefix: '/',
      skillPrefix: '/', commandPrefix: '/',
    };

    expect(config.createDiscoverySession).toBeUndefined();
    expect(config.triggerChars).toEqual(['/']);
  });

  it('carries each attempted runtime read eligibility into its ready snapshot', () => {
    const projected = (runtime: RuntimeCommandRead): CommandDropdownSnapshot => ({
      ...dropdownDetails, status: 'ready', entries: [], runtime,
      receipt: { ...dropdownReceipt, runtimeEligibility: runtime.eligibility },
    });
    const readyEmpty = projected({ status: 'ready', entries: [], receipt: queryReceipt, eligibility });
    const failed = projected({ status: 'failed', code: 'query-command-read-failed', eligibility });
    const unavailable = projected({ status: 'unavailable', reason: 'no-query', eligibility });
    const cancelled = projected({ status: 'cancelled', eligibility });
    const stale = projected({ status: 'stale', eligibility });

    expect(readyEmpty.status).toBe('ready');
    expect(eligibilityOf(readyEmpty)).toBe(eligibility);
    expect(eligibilityOf(failed)).toBe(eligibility);
    expect(eligibilityOf(unavailable)).toBe(eligibility);
    expect(eligibilityOf(cancelled)).toBe(eligibility);
    expect(eligibilityOf(stale)).toBe(eligibility);
  });

  it('accepts a not-attempted runtime with null eligibility over the vault fallback', () => {
    const snapshot: CommandDropdownSnapshot = {
      ...dropdownDetails, status: 'ready', entries: [],
      runtime: { status: 'not-attempted' },
      receipt: { ...dropdownReceipt, runtimeEligibility: null },
    };

    expect(snapshot.status).toBe('ready');
    expect(eligibilityOf(snapshot)).toBeNull();
  });

  it('accepts a cold snapshot whose probe has not been attempted', () => {
    const cold: CommandDropdownSnapshot = {
      ...dropdownDetails, status: 'ready', entries: [],
      probe: { status: 'not-attempted' },
      runtime: { status: 'unavailable', reason: 'no-query', eligibility },
      receipt: { ...dropdownReceipt, runtimeEligibility: eligibility },
    };

    expect(cold.probe.status).toBe('not-attempted');
    expect(eligibilityOf(cold)).toBe(eligibility);
  });

  it('accepts all three relations for Query and mismatch/unverified for probe and vault', () => {
    const queryOwned: CommandSourceReference<QueryCommandSourceReceipt> = { receipt: queryReceipt, relation: 'query-owned' };
    const queryMismatch: CommandSourceReference = { receipt: queryReceipt, relation: 'scope-mismatch' };
    const queryUnverified: CommandSourceReference = { receipt: queryReceipt, relation: 'unverified' };
    const probeMismatch: CommandSourceReference = { receipt: probeReceipt, relation: 'scope-mismatch' };
    const probeUnverified: CommandSourceReference = { receipt: probeReceipt, relation: 'unverified' };
    const vaultMismatch: CommandSourceReference = { receipt: vaultReceipt, relation: 'scope-mismatch' };
    const vaultUnverified: CommandSourceReference = { receipt: vaultReceipt, relation: 'unverified' };

    expect(queryOwned.relation).toBe('query-owned');
    expect(queryOwned.receipt).toBe(queryReceipt);
    expect(queryMismatch.relation).toBe('scope-mismatch');
    expect(queryUnverified.relation).toBe('unverified');
    expect(probeMismatch.relation).toBe('scope-mismatch');
    expect(probeUnverified.relation).toBe('unverified');
    expect(vaultMismatch.relation).toBe('scope-mismatch');
    expect(vaultUnverified.relation).toBe('unverified');
  });

  it('constructs unverified references from any broad source receipt', () => {
    const toUnverified = (source: CommandSourceReceipt): CommandSourceReference =>
      ({ receipt: source, relation: 'unverified' });
    const fromQuery = toUnverified(queryReceipt);
    const fromProbe = toUnverified(probeReceipt);
    const fromVault = toUnverified(vaultReceipt);

    expect(fromQuery.relation).toBe('unverified');
    expect(fromProbe.receipt).toBe(probeReceipt);
    expect(fromVault.relation).toBe('unverified');
  });

  it('accepts correlated coverage slots and null placeholders', () => {
    const coverage: CommandDropdownSnapshot['coverage'] = {
      runtime: queryReceipt.coverage,
      probe: probeReceipt.coverage,
      vault: vaultReceipt.coverage,
    };
    const coldCoverage: CommandDropdownSnapshot['coverage'] = {
      runtime: null, probe: null, vault: vaultReceipt.coverage,
    };

    expect(coverage.runtime).toBe('initialize-observed');
    expect(coverage.probe).toBe('candidate');
    expect(coverage.vault).toBe('best-effort-unknown');
    expect(coldCoverage.runtime).toBeNull();
    expect(coldCoverage.probe).toBeNull();
  });

  it('accepts single-generic count values mixing zeros and nulls', () => {
    const rawCount: CommandDropdownSourceValues<number> = { runtime: 0, probe: null, vault: 1 };
    const catalogVisibleCount: CommandDropdownSourceValues<number> = { runtime: 0, probe: null, vault: null };

    expect(rawCount.runtime).toBe(0);
    expect(rawCount.probe).toBeNull();
    expect(rawCount.vault).toBe(1);
    expect(catalogVisibleCount.vault).toBeNull();
  });

  it('accepts outer cancelled and stale snapshots with empty entries and null receipts', () => {
    const cancelled: CommandDropdownSnapshot = {
      ...dropdownDetails, status: 'cancelled', entries: [],
      runtime: { status: 'cancelled', eligibility }, receipt: null,
    };
    const stale: CommandDropdownSnapshot = {
      ...dropdownDetails, status: 'stale', entries: [],
      runtime: { status: 'stale', eligibility }, receipt: null,
    };

    expect(cancelled.entries).toEqual([]);
    expect(eligibilityOf(cancelled)).toBeNull();
    expect(stale.entries).toEqual([]);
    expect(eligibilityOf(stale)).toBeNull();
  });
});
