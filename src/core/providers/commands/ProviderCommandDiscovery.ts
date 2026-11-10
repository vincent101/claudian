import type { ChatRuntime } from '../../runtime/ChatRuntime';
import type { SlashCommand } from '../../types';
import type { ProviderId } from '../types';
import type { ProviderCommandEntry } from './ProviderCommandEntry';

export type CommandDiscoveryToken = object;

export interface CommandDiscoveryScope {
  readonly kind: 'actual-query' | 'base-probe' | 'vault';
  readonly sourceToken: CommandDiscoveryToken;
  readonly cwd?: string;
  readonly additionalDirectories?: readonly string[];
  readonly settingSources?: readonly string[];
  readonly unknown: readonly string[];
}

export type CommandDiscoveryCoverage =
  | 'initialize-observed'
  | 'candidate'
  | 'best-effort-unknown';

interface SourceReceipt<
  K extends string,
  S extends CommandDiscoveryScope['kind'],
  C extends CommandDiscoveryCoverage,
> {
  readonly sourceKind: K;
  readonly sourceToken: CommandDiscoveryToken;
  readonly sourceRevision: number;
  readonly scope: CommandDiscoveryScope & { readonly kind: S };
  readonly coverage: C;
}

export type QueryCommandSourceReceipt = SourceReceipt<
  'initialize-response', 'actual-query', 'initialize-observed'
>;
export type ProbeCommandSourceReceipt = SourceReceipt<
  'probe-candidate', 'base-probe', 'candidate'
>;
export type VaultCommandSourceReceipt = SourceReceipt<
  'vault-best-effort', 'vault', 'best-effort-unknown'
>;

export type CommandSourceReceipt =
  | QueryCommandSourceReceipt
  | ProbeCommandSourceReceipt
  | VaultCommandSourceReceipt;

export type CommandDiscoveryResult<
  T,
  R extends CommandSourceReceipt = CommandSourceReceipt,
> =
  | { readonly status: 'ready'; readonly entries: readonly T[]; readonly receipt: R }
  | { readonly status: 'failed'; readonly code: string; readonly stage?: string; readonly retryable?: boolean }
  | { readonly status: 'cancelled'; readonly reason?: string }
  | { readonly status: 'stale'; readonly reason?: string }
  | { readonly status: 'unavailable'; readonly reason?: string };

/** 包含无Query/失败状态的资格，不是来源新鲜度。 */
export interface CommandRuntimeEligibility {
  readonly token: CommandDiscoveryToken;
  readonly revision: number;
}

export type RuntimeCommandRead =
  CommandDiscoveryResult<SlashCommand, QueryCommandSourceReceipt> & {
    readonly eligibility: CommandRuntimeEligibility;
  };

export interface RuntimeCommandDiscovery {
  read(
    waiterSignal?: AbortSignal,
    options?: { retryFailed?: boolean },
  ): Promise<RuntimeCommandRead>;
  subscribe(listener: () => void): () => void;
  isCurrent(eligibility: CommandRuntimeEligibility): boolean;
}

interface TargetCommon {
  readonly providerId: ProviderId;
  readonly sessionEpoch: number;
  readonly registryRevision: number;
  readonly requestedExternalPaths: readonly string[];
}

export type CommandDiscoveryTarget =
  | (TargetCommon & {
    readonly kind: 'tab';
    readonly targetToken: CommandDiscoveryToken;
    readonly ticket: CommandDiscoveryToken;
    readonly generation: number;
    readonly runtime: ChatRuntime | null;
    readonly contextKey: string;
  })
  | (TargetCommon & {
    readonly kind: 'unbound';
    readonly targetToken: null;
    readonly ticket: null;
    readonly generation: null;
    readonly runtime: null;
    readonly contextKey: null;
    readonly requestedExternalPaths: readonly [];
  });

export interface CommandTargetReadContext {
  readonly target: CommandDiscoveryTarget;
  readonly eligibilitySignal: AbortSignal;
  isCurrent(): boolean;
}

export interface CommandTargetCapture {
  capture(sessionEpoch: number): CommandTargetReadContext;
  subscribe(listener: () => void): () => void;
}

export interface CommandCatalogRegistryBinding {
  getRevision(): number;
  isCurrent(): boolean;
  subscribe(listener: () => void): () => void;
}

export type CommandSourceTargetRelation =
  | 'query-owned'
  | 'scope-mismatch'
  | 'unverified';

export type CommandSourceReference<
  R extends CommandSourceReceipt = CommandSourceReceipt,
> =
  | (Extract<R, QueryCommandSourceReceipt> extends never ? never : {
    readonly receipt: Extract<R, QueryCommandSourceReceipt>;
    readonly relation: 'query-owned';
  })
  | {
    readonly receipt: R;
    readonly relation: Exclude<CommandSourceTargetRelation, 'query-owned'>;
  };

export interface CommandDropdownReceipt<
  E extends CommandRuntimeEligibility | null = CommandRuntimeEligibility | null,
> {
  readonly catalogToken: CommandDiscoveryToken;
  readonly registryRevision: number;
  readonly sessionEpoch: number;
  readonly sessionRevision: number;
  readonly targetToken: CommandDiscoveryToken | null;
  readonly targetTicket: CommandDiscoveryToken | null;
  readonly targetGeneration: number | null;
  readonly runtimeEligibility: E;
  readonly sourceRefs: readonly CommandSourceReference[];
  readonly projectionPolicyVersion: number;
}

export type CommandSourceOutcome<T> = T | { readonly status: 'not-attempted' };

export interface CommandDropdownSourceValues<T, P = T, V = T> {
  readonly runtime: T | null;
  readonly probe: P | null;
  readonly vault: V | null;
}

export type CommandProbeCleanupFinal =
  | { readonly status: 'not-started'; readonly reason?: string }
  | { readonly status: 'confirmed'; readonly evidence: 'direct-child-exit' }
  | { readonly status: 'failed'; readonly reason: string };

export type CommandProbeCleanup =
  | CommandProbeCleanupFinal
  | { readonly status: 'pending'; readonly reason?: string };

interface CommandDropdownSnapshotDetails {
  readonly probe: CommandSourceOutcome<CommandDiscoveryResult<SlashCommand, ProbeCommandSourceReceipt>>;
  readonly vault: CommandSourceOutcome<CommandDiscoveryResult<ProviderCommandEntry, VaultCommandSourceReceipt>>;
  readonly probeCleanup: CommandProbeCleanup;
  readonly sourceRefs: readonly CommandSourceReference[];
  readonly rawCount: CommandDropdownSourceValues<number>;
  readonly catalogVisibleCount: CommandDropdownSourceValues<number>;
  readonly coverage: CommandDropdownSourceValues<
    QueryCommandSourceReceipt['coverage'],
    ProbeCommandSourceReceipt['coverage'],
    VaultCommandSourceReceipt['coverage']
  >;
  readonly fallbackReason: string | null;
}

/** ready只表示投影可消费，不升级任何来源outcome。 */
export type CommandDropdownSnapshot = CommandDropdownSnapshotDetails & (
  | {
    readonly status: 'ready';
    readonly entries: readonly ProviderCommandEntry[];
    readonly runtime: RuntimeCommandRead;
    readonly receipt: CommandDropdownReceipt<CommandRuntimeEligibility>;
  }
  | {
    readonly status: 'ready';
    readonly entries: readonly ProviderCommandEntry[];
    readonly runtime: Extract<CommandSourceOutcome<RuntimeCommandRead>, { status: 'not-attempted' }>;
    readonly receipt: CommandDropdownReceipt<null>;
  }
  | {
    readonly status: 'cancelled' | 'stale';
    readonly entries: readonly [];
    readonly runtime: CommandSourceOutcome<RuntimeCommandRead>;
    readonly receipt: null;
  }
);

export interface CommandDropdownSession {
  read(callerSignal?: AbortSignal): Promise<CommandDropdownSnapshot>;
  subscribe(listener: () => void): () => void;
  isCurrent(receipt: CommandDropdownReceipt): boolean;
  invalidate(): void;
  release(): void;
}

/** 以下仅冻结未来probe合同，本片不得实例化生产executor。 */
export interface FrozenCommandProbeInput {
  readonly inputToken: CommandDiscoveryToken;
  readonly inputKey: string;
  readonly scope: Omit<CommandDiscoveryScope, 'sourceToken'> & { readonly kind: 'base-probe' };
}

export type CommandProbeInputResult =
  | { readonly status: 'captured'; readonly input: FrozenCommandProbeInput }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface CommandProbeRequest {
  readonly input: FrozenCommandProbeInput;
  readonly flightToken: CommandDiscoveryToken;
  readonly admissionToken: CommandDiscoveryToken;
  readonly ownerSignal: AbortSignal;
  readonly hardDeadlineMs: number;
  readonly cleanupGraceMs: number;
  isCurrent(): boolean;
}

export interface CommandProbeRun {
  readonly inputToken: CommandDiscoveryToken;
  readonly flightToken: CommandDiscoveryToken;
  readonly discovery: Promise<CommandDiscoveryResult<SlashCommand, ProbeCommandSourceReceipt>>;
  readonly cleanup: Promise<CommandProbeCleanupFinal>;
}

export interface TypedCommandProbe {
  captureInput(): CommandProbeInputResult;
  start(request: CommandProbeRequest): CommandProbeRun;
}
