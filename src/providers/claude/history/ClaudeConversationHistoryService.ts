import { existsSync } from 'fs';
import { types as utilTypes } from 'util';

import {
  type ConversationSizeReadInput,
  type ConversationSizeReadResult,
  type ConversationSizeSource,
  type FullHistoryChunk,
  type FullHistoryIterable,
  type FullHistoryIterationOptions,
  HistoryEntryTooLargeError,
  type HistoryIndexLease,
  type HistoryLoadBudget,
  type HistoryLoadProgress,
  type HistoryMessageDetailResult,
  type HistorySearchResult,
  HistorySourceUnavailableError,
  type HistoryWindowPage,
  type HistoryWindowRequest,
  type ProviderConversationHistoryService,
} from '../../../core/providers/types';
import type {
  ChatMessage,
  Conversation,
  ForkSource,
  SubagentInfo,
} from '../../../core/types';
import { compareChatDisplayOrder } from '../../../core/types';
import { sizeSourceRecord, sizeSourceString, statConversationFile } from '../../../utils/conversationSizeSource';
import { ClaudeTranscriptDiagnosticLog, type TranscriptDiagnosticEvent } from '../transcript/ClaudeTranscriptDiagnosticLog';
import { type ClaudeProviderState, getClaudeState } from '../types/providerState';
import {
  deleteSDKSession,
  materializeSDKMessages,
} from './ClaudeHistoryStore';
import {
  buildTranscriptIndex,
  materializeTranscriptEntries,
  materializeTranscriptPage,
  materializeTranscriptToolAssociations,
  protectTranscriptIndex,
  releaseTranscriptIndex,
  setTranscriptIndexDiagnosticSink,
  type TranscriptHistoryIndex,
  type TranscriptIndexDiagnosticEvent,
  type TranscriptIndexResult,
  transcriptIndexResultIdentity,
} from './ClaudeTranscriptHistoryIndex';
import {
  buildOpaqueOversizedPlaceholders,
  buildOversizedEntryPlaceholder,
  buildOversizedTurnMarker,
  hardCapChatProjection,
  HISTORY_SUMMARY_LIMITS,
  measureChatProjectionChars,
  summarizeChatMessages,
} from './HistorySummaryProjection';
import { planHistoryWindow } from './HistoryWindowPlanner';
import type { SDKNativeMessage } from './sdkHistoryTypes';
import { claudeTailStart } from './sdkHistoryTypes';
import { getSDKSessionPath } from './sdkSessionPaths';

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const result: ChatMessage[] = [];

  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }

  return result;
}

function sanitizeProviderState(
  providerState: ClaudeProviderState,
): Record<string, unknown> | undefined {
  const sanitizedEntries = Object.entries(providerState).filter(([, value]) => value !== undefined);
  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}

interface ConversationHistorySource {
  readonly conversationId: string;
  readonly vaultPath: string;
  readonly currentSessionId?: string;
  readonly key: string;
  readonly segments: readonly {
    readonly sessionId: string;
    readonly segmentOrdinal: number;
    /** null preserves an unresolvable segment's place in the frozen chain. */
    readonly filePath: string | null;
    readonly resumeAtMessageId?: string;
  }[];
}

interface IndexedSegment {
  sessionId: string;
  segmentOrdinal: number;
  index: TranscriptHistoryIndex;
  result: Exclude<TranscriptIndexResult, { status: 'failed' }>;
  /** Served from a partial snapshot: the committed prefix still drives every projection. */
  partial: boolean;
}

interface ConversationIndexState {
  conversationId: string;
  vaultPath: string;
  segments: IndexedSegment[];
  flattenedTurns: Array<{ segment: IndexedSegment; turnIndex: number }>;
  /** Provenance of this state: any segment rescanned ('rebuilt') or every segment served from the completed index cache ('cache_hit'). */
  acquireOutcome: 'rebuilt' | 'cache_hit';
}

const historyPromise = Promise;
const historyPromisePrototype = Promise.prototype;
const historyPromiseThen = Promise.prototype.then;
const historyGetPrototypeOf = Object.getPrototypeOf;
const historyGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const historyHasOwn = Object.hasOwn;
const historyApply = Reflect.apply;
const historyIsPromise = utilTypes.isPromise;
const historyPromiseSpecies = Symbol.species;
const historyPromiseSpeciesGetter = historyGetOwnPropertyDescriptor(historyPromise, historyPromiseSpecies)?.get;

function observeOrdinaryHistoryPromise(returned: object): boolean {
  try {
    // Native branding excludes proxies; exact prototype identity excludes other
    // realms/subclasses. Descriptors never execute external constructor/species
    // accessors. Recheck the intrinsics on every use, not just at module load.
    if (historyGetPrototypeOf(returned) !== historyPromisePrototype
      || historyGetOwnPropertyDescriptor(returned, 'constructor') !== undefined) return false;
    const constructor = historyGetOwnPropertyDescriptor(historyPromisePrototype, 'constructor');
    const prototype = historyGetOwnPropertyDescriptor(historyPromise, 'prototype');
    const then = historyGetOwnPropertyDescriptor(historyPromisePrototype, 'then');
    const species = historyGetOwnPropertyDescriptor(historyPromise, historyPromiseSpecies);
    if (!constructor || !historyHasOwn(constructor, 'value') || constructor.value !== historyPromise
      || !prototype || !historyHasOwn(prototype, 'value') || prototype.value !== historyPromisePrototype
      || !then || !historyHasOwn(then, 'value') || then.value !== historyPromiseThen
      || !species || !historyHasOwn(species, 'get') || !historyPromiseSpeciesGetter
      || species.get !== historyPromiseSpeciesGetter || species.set !== undefined) return false;
    // Neither handler forwards a payload into the newly created child promise.
    // If intrinsic then still fails, no observation receipt can be claimed.
    historyApply(historyPromiseThen, returned, [() => undefined, () => undefined]);
    return true;
  } catch { return false; }
}

type HistoryBoundaryReturn = 'synchronous' | 'asynchronous' | 'native_observation_not_established';

function inspectHistoryBoundaryReturn(returned: unknown, boundary: 'callback' | 'diagnostic'): HistoryBoundaryReturn {
  if (returned === null || (typeof returned !== 'object' && typeof returned !== 'function')) return 'synchronous';
  if (historyIsPromise(returned)) {
    return observeOrdinaryHistoryPromise(returned) ? 'asynchronous' : 'native_observation_not_established';
  }
  // Synchronous boundaries read then once, but never invoke or assimilate a
  // non-native thenable: cyclic resolution could starve unrelated leases.
  const then = (returned as { then?: unknown }).then;
  return typeof then === 'function' ? 'asynchronous' : 'synchronous';
}

interface HistoryIndexDeferred<T> {
  readonly ready: Promise<T>;
  readonly resolveReady: (value: T) => void;
  readonly rejectReady: (error: unknown) => void;
}

function observedHistoryReady<T>(): HistoryIndexDeferred<T> {
  let resolveReady!: (value: T) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<T>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Observe without replacing the promise: callers must still receive its
  // original rejection, including cursors released before their first next().
  void ready.then(() => undefined, () => undefined);
  return { ready, resolveReady, rejectReady };
}

const HISTORY_ERROR_NAMES = [
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
  'AggregateError', 'AbortError', 'HistorySourceUnavailableError', 'HistoryEntryTooLargeError', 'UnknownError',
] as const;
type HistoryErrorName = typeof HISTORY_ERROR_NAMES[number];

function controlledHistoryErrorName(name: unknown): HistoryErrorName {
  return HISTORY_ERROR_NAMES.find(known => known === name) ?? 'UnknownError';
}

function historyIndexErrorName(error: unknown): HistoryErrorName {
  try { return controlledHistoryErrorName(error instanceof Error ? error.name : undefined); }
  catch { return 'UnknownError'; }
}

type HistoryDiagnosticChannel = 'index' | 'window';
type HistoryDiagnosticEventPhase = TranscriptIndexDiagnosticEvent['phase']
  | 'lease_release' | 'callback_error' | 'partial_snapshot' | 'stale_partial_segment'
  | 'window_planned' | 'window_complete';
type HistoryDiagnosticPhase = HistoryDiagnosticEventPhase | 'logger_create' | 'sink_register';
type HistoryDiagnosticStatus = 'uninitialized' | 'normal' | 'internally_disabled' | 'boundary_failed';

interface HistoryDiagnosticChannelState {
  readonly status: HistoryDiagnosticStatus;
  readonly failureCount: number;
  readonly suppressedCount: number;
  readonly reentrantSuppressedCount: number;
  readonly nativeObservationNotEstablishedCount: number;
}

/** Bounded process-local observations, not a persistence receipt or user alert. */
export interface HistoryDiagnosticState {
  readonly channels: Readonly<Record<HistoryDiagnosticChannel, HistoryDiagnosticChannelState>>;
  readonly callbackErrorCount: number;
  readonly callbackPostTerminalErrorCount: number;
  /** No receipt that this boundary marked the external native rejection handled. */
  readonly callbackNativeObservationNotEstablishedCount: number;
  readonly lastCallback: { readonly phase: HistoryLoadProgress['phase']; readonly errorName: HistoryErrorName } | null;
  readonly lastDiagnosticFailure: {
    readonly channel: HistoryDiagnosticChannel;
    readonly phase: HistoryDiagnosticPhase;
    readonly errorName: HistoryErrorName;
  } | null;
}

interface HistoryDiagnosticBinding {
  status: HistoryDiagnosticStatus;
  failureCount: number;
  suppressedCount: number;
  reentrantSuppressedCount: number;
  nativeObservationNotEstablishedCount: number;
  logger?: ClaudeTranscriptDiagnosticLog;
  activePhase?: HistoryDiagnosticPhase;
}

function incrementHistoryDiagnosticCount(count: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, count + 1);
}

interface HistoryLeaseSubscription extends HistoryIndexDeferred<void> {
  readonly shared: SharedHistoryIndex;
  readonly onProgress?: (progress: HistoryLoadProgress) => void;
  status: 'pending' | 'ready' | 'failed';
  state?: ConversationIndexState;
  inactiveReason?: unknown;
}

interface SharedHistoryIndex extends HistoryIndexDeferred<ConversationIndexState> {
  readonly source: ConversationHistorySource;
  readonly controller: AbortController;
  /** Membership is the sole reference/eligibility authority, not callback identity. */
  readonly leases: Set<HistoryLeaseSubscription>;
  started: boolean;
  state?: ConversationIndexState;
  protectedIndexes: TranscriptHistoryIndex[];
}

export class ClaudeConversationHistoryService implements ProviderConversationHistoryService {
  private sharedIndexes = new Map<string, SharedHistoryIndex>();
  private leaseIndexes = new WeakMap<HistoryIndexLease, SharedHistoryIndex>();
  private readonly diagnosticBindings: Record<HistoryDiagnosticChannel, HistoryDiagnosticBinding> = {
    index: { status: 'uninitialized', failureCount: 0, suppressedCount: 0, reentrantSuppressedCount: 0, nativeObservationNotEstablishedCount: 0 },
    window: { status: 'uninitialized', failureCount: 0, suppressedCount: 0, reentrantSuppressedCount: 0, nativeObservationNotEstablishedCount: 0 },
  };
  private historyDiagnosticBusy = false;
  private callbackErrorCount = 0;
  private callbackPostTerminalErrorCount = 0;
  private callbackNativeObservationNotEstablishedCount = 0;
  private lastCallback: HistoryDiagnosticState['lastCallback'] = null;
  private lastDiagnosticFailure: HistoryDiagnosticState['lastDiagnosticFailure'] = null;

  getHistoryDiagnosticState(): HistoryDiagnosticState {
    const copyChannel = (binding: HistoryDiagnosticBinding): HistoryDiagnosticChannelState => ({
      status: binding.status, failureCount: binding.failureCount, suppressedCount: binding.suppressedCount,
      reentrantSuppressedCount: binding.reentrantSuppressedCount,
      nativeObservationNotEstablishedCount: binding.nativeObservationNotEstablishedCount,
    });
    return {
      channels: { index: copyChannel(this.diagnosticBindings.index), window: copyChannel(this.diagnosticBindings.window) },
      callbackErrorCount: this.callbackErrorCount,
      callbackPostTerminalErrorCount: this.callbackPostTerminalErrorCount,
      callbackNativeObservationNotEstablishedCount: this.callbackNativeObservationNotEstablishedCount,
      lastCallback: this.lastCallback ? { ...this.lastCallback } : null,
      lastDiagnosticFailure: this.lastDiagnosticFailure ? { ...this.lastDiagnosticFailure } : null,
    };
  }

  private failHistoryDiagnostics(
    channel: HistoryDiagnosticChannel,
    phase: HistoryDiagnosticPhase,
    status: 'internally_disabled' | 'boundary_failed',
    errorName: HistoryErrorName,
  ): void {
    const binding = this.diagnosticBindings[channel];
    if (binding.status === 'internally_disabled' || binding.status === 'boundary_failed') return;
    binding.status = status;
    binding.failureCount = incrementHistoryDiagnosticCount(binding.failureCount);
    this.lastDiagnosticFailure = { channel, phase, errorName };
    // Never clear the global sink: record/notify can reenter and replace it.
    // This service's binding alone is fused, without recursively logging failure.
  }

  private runHistoryDiagnostic(channel: HistoryDiagnosticChannel, phase: HistoryDiagnosticPhase, write: () => unknown): void {
    const binding = this.diagnosticBindings[channel];
    if (binding.status === 'internally_disabled' || binding.status === 'boundary_failed') {
      binding.suppressedCount = incrementHistoryDiagnosticCount(binding.suppressedCount);
      return;
    }
    if (this.historyDiagnosticBusy) {
      binding.suppressedCount = incrementHistoryDiagnosticCount(binding.suppressedCount);
      binding.reentrantSuppressedCount = incrementHistoryDiagnosticCount(binding.reentrantSuppressedCount);
      return;
    }
    const previousPhase = binding.activePhase;
    this.historyDiagnosticBusy = true;
    binding.activePhase = phase;
    try {
      const returned = inspectHistoryBoundaryReturn(write(), 'diagnostic');
      if (returned === 'native_observation_not_established') {
        binding.nativeObservationNotEstablishedCount = incrementHistoryDiagnosticCount(binding.nativeObservationNotEstablishedCount);
      }
      if (returned !== 'synchronous') throw new TypeError('History diagnostics must be synchronous');
      if (binding.status === 'uninitialized') binding.status = 'normal';
    } catch (error) {
      this.failHistoryDiagnostics(channel, phase, 'boundary_failed', historyIndexErrorName(error));
    } finally {
      binding.activePhase = previousPhase;
      this.historyDiagnosticBusy = false;
    }
  }

  private recordHistoryDiagnostic(
    channel: HistoryDiagnosticChannel,
    event: TranscriptDiagnosticEvent & { phase: HistoryDiagnosticEventPhase },
  ): void {
    this.runHistoryDiagnostic(channel, event.phase, () => this.diagnosticBindings[channel].logger!.record({
      ...event, errorName: event.errorName === undefined ? undefined : controlledHistoryErrorName(event.errorName),
    }));
  }

  private ensureIndexDiagnostics(vaultPath: string): void {
    for (const channel of ['index', 'window'] as const) {
      const binding = this.diagnosticBindings[channel];
      if (binding.status !== 'uninitialized') continue;
      this.runHistoryDiagnostic(channel, 'logger_create', () => {
        binding.logger = new ClaudeTranscriptDiagnosticLog(vaultPath, () => {
          // Real logger write/serialization failure is internally caught. Its
          // one-shot notify supplies no error category or persistence receipt.
          this.failHistoryDiagnostics(channel, binding.activePhase ?? 'logger_create', 'internally_disabled', 'UnknownError');
        }, `history-${channel}`);
        return binding.logger;
      });
      if (channel === 'index' && this.diagnosticBindings[channel].status === 'normal') {
        this.runHistoryDiagnostic(channel, 'sink_register', () =>
          setTranscriptIndexDiagnosticSink(event => this.recordHistoryDiagnostic('index', event)));
      }
    }
  }

  captureConversationSizeSource(conversation: Conversation): ConversationSizeSource {
    const state = getClaudeState(sizeSourceRecord(conversation.providerState));
    return Object.freeze({ sessionId: sizeSourceString(state.providerSessionId ?? conversation.sessionId) ?? null });
  }

  async readConversationSize(
    input: ConversationSizeReadInput,
    vaultPath: string | null,
    options: { revision: number; signal?: AbortSignal },
  ): Promise<ConversationSizeReadResult> {
    const sessionId = sizeSourceString(input.source.sessionId);
    const path = input.providerId === 'claude' && vaultPath && sessionId
      ? getSDKSessionPath(vaultPath, sessionId) : null;
    return { snapshot: {
      conversationId: input.id, revision: options.revision,
      files: await statConversationFile(path, options.signal),
    } };
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getClaudeState(conversation.providerState);
    return !!state.forkSource
      && !state.providerSessionId
      && !conversation.sessionId;
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;
    const state = getClaudeState(conversation.providerState);
    return state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const state: ClaudeProviderState = {
      forkSource: { sessionId: sourceSessionId, resumeAt } satisfies ForkSource,
    };
    return state as Record<string, unknown>;
  }

  mergePersistedSubagentState(
    providerState: Record<string, unknown> | undefined,
    subagent: SubagentInfo,
  ): Record<string, unknown> {
    const current = getClaudeState(providerState);
    return { ...current, subagentData: { ...(current.subagentData ?? {}), [subagent.id]: subagent } };
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const providerState: ClaudeProviderState = {
      ...getClaudeState(conversation.providerState),
    };

    return sanitizeProviderState(providerState);
  }

  async loadTitleMaterial(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<{ firstUserExcerpt: string; recentUserExcerpts: string[] } | null> {
    if (!vaultPath) return null;
    const lease = this.acquireHistoryIndex(conversation, vaultPath);
    try {
      await lease.ready;
      const budget: HistoryLoadBudget = {
        maxTurns: 8,
        maxSourceBytes: 256 * 1024,
        maxProjectedChars: 32 * 1024,
        timeSliceMs: 8,
      };
      const first = await lease.loadWindow({
        anchorTurn: 0,
        direction: 'newer',
        maxTurn: Math.min(1, lease.totalTurns),
        budget,
        projectionLevel: 'detail',
      });
      const recent = await lease.loadWindow({
        anchorTurn: lease.totalTurns,
        direction: 'older',
        budget,
        projectionLevel: 'detail',
      });
      const firstUser = first.messages.find(message => message.role === 'user');
      if (!firstUser) return null;
      const userTexts = recent.messages
        .filter(message => message.role === 'user')
        .map(message => message.displayContent ?? message.content);
      const isNoise = (text: string): boolean => !text
        || /^This session is being continued/i.test(text)
        || /^\[Request interrupted by user/i.test(text)
        || /^<command-/i.test(text)
        || /^<local-command-caveat>/i.test(text);
      const highInformation = userTexts
        .filter(text => !isNoise(text) && text.length >= 40)
        .slice(-5)
        .map(text => text.slice(0, 250));
      return {
        firstUserExcerpt: (firstUser.displayContent ?? firstUser.content).slice(0, 300),
        recentUserExcerpts: highInformation.length > 0
          ? highInformation
          : userTexts.slice(-3).map(text => text.slice(0, 100)),
      };
    } finally {
      lease.release();
    }
  }

  acquireHistoryIndex(
    conversation: Conversation,
    vaultPath: string | null,
    onProgress?: (progress: HistoryLoadProgress) => void,
    forceNewSnapshot = false,
  ): HistoryIndexLease {
    if (!vaultPath) throw new Error('Vault path is unavailable');
    const shared = this.acquireSharedIndex(conversation, vaultPath, forceNewSnapshot);
    const lease = this.createHistoryLease(conversation.id, shared, onProgress);
    if (!shared.started) {
      shared.started = true;
      // Lookup, subscription and rejection observers are installed before any
      // IO/progress. Reentrant acquires cannot receive the dispatch in progress.
      const build = Promise.resolve().then(() => this.startSharedIndex(shared, forceNewSnapshot));
      void build.then(() => undefined, error => this.failSharedIndex(shared, error));
    }
    return lease;
  }

  private captureIndexSource(conversation: Conversation, vaultPath: string): ConversationHistorySource {
    const state = getClaudeState(conversation.providerState);
    const currentSessionId = state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId;
    const resumeAt = state.forkSource?.resumeAt ?? conversation.resumeAtMessageId;
    const sessions = currentSessionId ? [...(state.previousProviderSessionIds ?? []), currentSessionId] : [];
    const segments = Object.freeze(sessions.map((sessionId, segmentOrdinal) => {
      let filePath: string | null = null;
      // Match the old per-session availability check without freezing existence:
      // a resolvable file may appear before the queued build starts.
      try { filePath = getSDKSessionPath(vaultPath, sessionId); } catch { /* skip at build time */ }
      return Object.freeze({
        sessionId, segmentOrdinal, filePath,
        resumeAtMessageId: sessionId === currentSessionId && resumeAt ? resumeAt : undefined,
      });
    }));
    return Object.freeze({
      conversationId: conversation.id, vaultPath, currentSessionId: currentSessionId || undefined, segments,
      key: JSON.stringify([vaultPath, segments.map(segment => [segment.sessionId, segment.filePath, segment.resumeAtMessageId ?? null])]),
    });
  }

  private acquireSharedIndex(
    conversation: Conversation,
    vaultPath: string,
    forceNewSnapshot: boolean,
  ): SharedHistoryIndex {
    this.ensureIndexDiagnostics(vaultPath);
    const source = this.captureIndexSource(conversation, vaultPath);
    let shared = this.sharedIndexes.get(source.conversationId);
    if (!shared || forceNewSnapshot || shared.source.key !== source.key || shared.controller.signal.aborted) {
      shared = {
        ...observedHistoryReady<ConversationIndexState>(), source,
        controller: new AbortController(), leases: new Set(), started: false, protectedIndexes: [],
      };
      this.sharedIndexes.set(source.conversationId, shared);
    }
    return shared;
  }

  private async startSharedIndex(shared: SharedHistoryIndex, forceNewSnapshot: boolean): Promise<void> {
    if (shared.leases.size === 0 || shared.controller.signal.aborted) return;
    const state = await this.buildConversationIndex(
      shared.source, shared.controller.signal, event => this.dispatchHistoryProgress(shared, event), forceNewSnapshot,
      index => {
        // The synchronous onIndex handoff protects each segment once per
        // shared build, including repeated physical segments. Retired sources
        // retain their own pins; revoked sources cannot accept late handoffs.
        if (shared.leases.size === 0 || shared.controller.signal.aborted) return;
        protectTranscriptIndex(index);
        shared.protectedIndexes.push(index);
      },
    );
    if (shared.leases.size === 0 || shared.controller.signal.aborted) return;
    shared.state = state;
    shared.resolveReady(state);
    for (const subscription of shared.leases) this.completeHistoryLease(subscription, state);
  }

  private failSharedIndex(shared: SharedHistoryIndex, error: unknown): void {
    if (shared.state || shared.leases.size === 0) return;
    shared.rejectReady(error);
    // Settle/revoke every lease and retire its pins before observing failure.
    // The acquire's build rejection handler is the sole source-failure owner.
    for (const subscription of [...shared.leases]) this.failHistoryLease(subscription, error);
    this.recordHistoryDiagnostic('window', { phase: 'failed', errorName: historyIndexErrorName(error) });
  }

  private dispatchHistoryProgress(shared: SharedHistoryIndex, event: HistoryLoadProgress): void {
    for (const subscription of [...shared.leases]) {
      if (subscription.shared !== shared || !shared.leases.has(subscription)
        || subscription.status !== 'pending' || !subscription.onProgress) continue;
      try {
        const returned = inspectHistoryBoundaryReturn(subscription.onProgress({ ...event }), 'callback');
        if (returned === 'native_observation_not_established') {
          this.callbackNativeObservationNotEstablishedCount = incrementHistoryDiagnosticCount(this.callbackNativeObservationNotEstablishedCount);
        }
        if (returned !== 'synchronous') throw new TypeError('History progress callbacks must be synchronous');
      } catch (error) {
        const errorName = historyIndexErrorName(error);
        this.callbackErrorCount = incrementHistoryDiagnosticCount(this.callbackErrorCount);
        if (!shared.leases.has(subscription) || subscription.status !== 'pending') {
          this.callbackPostTerminalErrorCount = incrementHistoryDiagnosticCount(this.callbackPostTerminalErrorCount);
        }
        this.lastCallback = { phase: event.phase, errorName };
        this.failHistoryLease(subscription, error);
        // First-terminal owns the business result, not the observation. Even
        // self-release then throw remains visible after the last lease exits.
        this.recordHistoryDiagnostic('window', { phase: 'callback_error', errorName });
      }
    }
  }

  private completeHistoryLease(subscription: HistoryLeaseSubscription, state: ConversationIndexState): void {
    if (!subscription.shared.leases.has(subscription) || subscription.status !== 'pending') return;
    subscription.state = state;
    subscription.status = 'ready';
    subscription.resolveReady();
  }

  private failHistoryLease(subscription: HistoryLeaseSubscription, error: unknown): boolean {
    if (!subscription.shared.leases.has(subscription) || subscription.status !== 'pending') return false;
    subscription.status = 'failed';
    subscription.rejectReady(error);
    this.exitHistoryLease(subscription, error);
    return true;
  }

  private exitHistoryLease(subscription: HistoryLeaseSubscription, reason: unknown): void {
    const shared = subscription.shared;
    if (!shared.leases.has(subscription)) return;
    subscription.inactiveReason = reason;
    shared.leases.delete(subscription);
    if (shared.leases.size > 0) return;
    // Revoke and CAS before abort: abort listeners may reentrantly acquire a
    // successor. Only this instance's subscriber/controller and pins retire.
    if (this.sharedIndexes.get(shared.source.conversationId) === shared) {
      this.sharedIndexes.delete(shared.source.conversationId);
    }
    if (!shared.state) shared.rejectReady(reason);
    shared.controller.abort();
    this.releaseSharedProtection(shared);
    this.recordHistoryDiagnostic('window', { phase: 'lease_release' });
  }

  private releaseSharedProtection(shared: SharedHistoryIndex): void {
    const indexes = shared.protectedIndexes;
    shared.protectedIndexes = [];
    indexes.forEach(releaseTranscriptIndex);
  }

  private requireHistoryLease(subscription: HistoryLeaseSubscription): void {
    if (!subscription.shared.leases.has(subscription)) throw subscription.inactiveReason;
  }

  private readyHistoryLease(subscription: HistoryLeaseSubscription): ConversationIndexState {
    this.requireHistoryLease(subscription);
    if (subscription.status !== 'ready' || !subscription.state) {
      throw new Error('History index is not ready for window planning');
    }
    return subscription.state;
  }

  private async readHistoryLease<T>(
    subscription: HistoryLeaseSubscription,
    read: (state: ConversationIndexState) => T | Promise<T>,
  ): Promise<T> {
    this.requireHistoryLease(subscription);
    await subscription.ready;
    const result = await read(this.readyHistoryLease(subscription));
    // Already-started IO need not be interrupted, but revoked leases cannot
    // deliver a successful page/detail/search after an await.
    this.requireHistoryLease(subscription);
    return result;
  }

  private createHistoryLease(
    conversationId: string,
    shared: SharedHistoryIndex,
    onProgress?: (progress: HistoryLoadProgress) => void,
  ): HistoryIndexLease {
    const subscription: HistoryLeaseSubscription = {
      ...observedHistoryReady<void>(), shared, onProgress, status: 'pending',
    };
    shared.leases.add(subscription);
    const lease: HistoryIndexLease = {
      conversationId,
      get totalTurns() { return subscription.state?.flattenedTurns.length ?? 0; },
      get acquireOutcome() { return subscription.state?.acquireOutcome; },
      ready: subscription.ready,
      search: query => this.readHistoryLease(subscription, state => this.searchIndex(state, query)),
      loadMessageDetail: (projectionKey, options) => this.readHistoryLease(subscription,
        state => this.materializeMessageDetail(state, projectionKey, options)),
      loadWindow: request => this.readHistoryLease(subscription, state => this.materializeWindow(state, request)),
      planWindow: request => {
        const plan = this.planWindowFor(this.readyHistoryLease(subscription), request);
        return { start: plan.start, end: plan.end };
      },
      release: () => {
        if (!shared.leases.has(subscription)) return;
        const error = new Error('History index build aborted');
        if (subscription.status === 'pending') this.failHistoryLease(subscription, error);
        else this.exitHistoryLease(subscription, error);
      },
    };
    this.leaseIndexes.set(lease, shared);
    if (shared.state) this.completeHistoryLease(subscription, shared.state);
    return lease;
  }

  private async buildConversationIndex(
    source: ConversationHistorySource,
    signal: AbortSignal,
    onProgress?: (progress: HistoryLoadProgress) => void,
    forceNewSnapshot = false,
    onSegment?: (index: TranscriptHistoryIndex) => void,
  ): Promise<ConversationIndexState> {
    if (signal.aborted) throw new Error('History index build aborted');
    if (!source.currentSessionId) throw new Error('Conversation has no Claude session');
    const segments: IndexedSegment[] = [];
    let anySegmentRescanned = false;
    onProgress?.({ phase: 'queued' });
    for (const { sessionId, segmentOrdinal, filePath, resumeAtMessageId } of source.segments) {
      if (signal.aborted) throw new Error('History index build aborted');
      if (!filePath || !existsSync(filePath)) continue;
      const result = await buildTranscriptIndex(filePath, {
        resumeAtMessageId,
        forceNewSnapshot,
        signal,
        onProgress: (bytes, totalBytes) => onProgress?.({
          phase: 'indexing',
          percent: totalBytes > 0 ? Math.min(100, Math.round(bytes / totalBytes * 100)) : 100,
        }),
        onFinalize: () => onProgress?.({ phase: 'finalizing' }),
        onIndex: onSegment,
      });
      if (signal.aborted) throw new Error('History index build aborted');
      if (result.status === 'failed') throw new Error(result.error);
      if (!result.fromCache) anySegmentRescanned = true;
      if (result.status === 'partial') {
        // A partial snapshot still serves its committed prefix: search,
        // paging, titles and windows all operate on complete lines only. The
        // current segment's partial is a transient append-in-progress state;
        // an older segment's partial will not heal on its own.
        this.recordHistoryDiagnostic('window', {
          phase: sessionId === source.currentSessionId ? 'partial_snapshot' : 'stale_partial_segment',
          bytes: result.index.snapshotSize,
        });
      }
      segments.push({ sessionId, segmentOrdinal, index: result.index, result, partial: result.status === 'partial' });
    }
    if (segments.length === 0) throw new Error('Conversation transcript is unavailable');
    const flattenedTurns = segments.flatMap(segment =>
      segment.index.turns.map((_, turnIndex) => ({ segment, turnIndex }))
    );
    return {
      conversationId: source.conversationId, vaultPath: source.vaultPath, segments, flattenedTurns,
      acquireOutcome: anySegmentRescanned ? 'rebuilt' : 'cache_hit',
    };
  }

  private searchIndex(state: ConversationIndexState, query: string): HistorySearchResult[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const results: HistorySearchResult[] = [];
    // Parallel canonical entry index per result: within one turn the corpus
    // entry position orders projections structurally (user before assistant),
    // so the sort below never falls back to projectionKey string comparison.
    const resultEntryIndexes: number[] = [];
    const ordinals = new Map<string, number>();
    let globalTurnOffset = 0;
    for (const segment of state.segments) {
      for (const item of segment.index.searchCorpus) {
        const text = segment.index.searchText.slice(item.textOffset, item.textOffset + item.textLength);
        const lowerText = text.toLocaleLowerCase();
        let matchStart = lowerText.indexOf(needle);
        while (matchStart >= 0) {
          const matchOrdinal = ordinals.get(item.projectionKey) ?? 0;
          results.push({
            projectionKey: item.projectionKey,
            turnIndex: globalTurnOffset + item.turnIndex,
            matchOrdinal,
            matchedText: text.slice(matchStart, matchStart + query.trim().length),
          });
          resultEntryIndexes.push(item.entryIndex);
          ordinals.set(item.projectionKey, matchOrdinal + 1);
          matchStart = lowerText.indexOf(needle, matchStart + needle.length);
        }
      }
      globalTurnOffset += segment.index.turns.length;
    }
    return results
      .map((result, index) => ({ result, index }))
      .sort((a, b) =>
        a.result.turnIndex - b.result.turnIndex
        || resultEntryIndexes[a.index] - resultEntryIndexes[b.index]
        || a.result.matchOrdinal - b.result.matchOrdinal
      )
      .map(entry => entry.result);
  }

  private async materializeMessageDetail(
    state: ConversationIndexState,
    projectionKey: string,
    options: { maxSourceBytes: number; signal?: AbortSignal },
  ): Promise<HistoryMessageDetailResult> {
    if (options.signal?.aborted) throw new Error('History detail load aborted');
    for (const segment of state.segments) {
      const descriptor = segment.index.projectionDescriptors?.find(item => item.projectionKey === projectionKey);
      if (!descriptor) continue;
      const entries = segment.index.entries.slice(descriptor.startEntry, descriptor.endEntry + 1);
      const wantedToolIds = new Set(entries.flatMap(entry => [...entry.toolUseIds, ...entry.toolResultIds]));
      const associationEntries = wantedToolIds.size > 0
        ? segment.index.entries.filter(entry =>
          entry.toolUseIds.some(id => wantedToolIds.has(id))
          || entry.toolResultIds.some(id => wantedToolIds.has(id)))
        : entries;
      const uniqueEntries = [...new Map([...entries, ...associationEntries].map(entry => [entry.offset, entry])).values()];
      const sourceBytes = uniqueEntries.reduce((sum, entry) => sum + entry.length, 0);
      if (sourceBytes > options.maxSourceBytes) return { status: 'too_large' };
      const native = await materializeTranscriptEntries(segment.index, entries);
      if (options.signal?.aborted) throw new Error('History detail load aborted');
      // Equal cardinality does not imply equal entries: a descriptor entry
      // without tool ids can mask an out-of-range tool_result of the same
      // count, so associations always come from the association set itself.
      const associations = await materializeTranscriptEntries(segment.index, associationEntries);
      const messages = await materializeSDKMessages(
        state.vaultPath,
        segment.sessionId,
        native,
        associations,
        segment.segmentOrdinal,
        descriptor.startEntry,
      );
      const message = messages.find(candidate => candidate.id === projectionKey);
      if (!message) return { status: 'not_found' };
      message.projectionLevel = 'detail';
      message.historyTurnOrdinal = state.segments
        .slice(0, state.segments.indexOf(segment))
        .reduce((sum, item) => sum + item.index.turns.length, 0) + descriptor.turnIndex;
      return { status: 'exact', message };
    }
    return { status: 'not_found' };
  }

  private turnSourceBytes(state: ConversationIndexState): number[] {
    return state.flattenedTurns.map(item => item.segment.index.turns[item.turnIndex].sourceBytes ?? 0);
  }

  private planWindowFor(state: ConversationIndexState, request: HistoryWindowRequest) {
    return planHistoryWindow(this.turnSourceBytes(state), {
      anchorTurn: request.anchorTurn,
      direction: request.direction,
      budget: request.budget,
      minTurn: request.minTurn,
      maxTurn: request.maxTurn,
    });
  }

  private async materializeTurn(
    state: ConversationIndexState,
    segment: IndexedSegment,
    turnIndex: number,
  ): Promise<ChatMessage[]> {
    const native = await materializeTranscriptPage(segment.index, turnIndex, 1);
    const associations = await materializeTranscriptToolAssociations(segment.index, native);
    // The single-turn page starts at the turn's segment-global startEntry;
    // without the base every turn would restart the entry counter and all
    // turns of a window would collide on the same displayOrder keys.
    return materializeSDKMessages(
      state.vaultPath, segment.sessionId, native, associations, segment.segmentOrdinal,
      segment.index.turns[turnIndex].startEntry,
    );
  }

  /**
   * Bounded materialization of one oversized turn. Entries are read from the
   * head (turn opener) and tail (final answer) within the byte budget; giant
   * entries and the squeezed middle are replaced by explicit omission markers.
   */
  private async materializeSummaryTurn(
    state: ConversationIndexState,
    segment: IndexedSegment,
    turnIndex: number,
    budget: HistoryLoadBudget,
  ): Promise<{ messages: ChatMessage[]; readBytes: number }> {
    const index = segment.index;
    const turn = index.turns[turnIndex];
    const entries = index.entries.slice(turn.startEntry, turn.endEntry + 1);
    const selected = new Array<boolean>(entries.length).fill(false);
    const headBudget = Math.floor(budget.maxSourceBytes * 0.6);
    let readBytes = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.length > HISTORY_SUMMARY_LIMITS.entryReadBytes || readBytes + entry.length > headBudget) continue;
      selected[i] = true;
      readBytes += entry.length;
    }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (selected[i]) continue;
      const entry = entries[i];
      if (entry.length > HISTORY_SUMMARY_LIMITS.entryReadBytes || readBytes + entry.length > budget.maxSourceBytes) continue;
      selected[i] = true;
      readBytes += entry.length;
    }
    const read = entries.filter((_, i) => selected[i]);
    const skipped = entries.filter((_, i) => !selected[i]);
    // readIndexEntries preserves the input entry order, so native aligns with
    // the selected slots by cursor.
    const native = read.length > 0 ? await materializeTranscriptEntries(index, read) : [];
    const placeholderRowsByMessageKey = new Map<string, SDKNativeMessage[]>();
    for (const entry of skipped) {
      // Opaque oversized rows always surface a visible omission marker (plus
      // a synthetic tool_result when ids were reliably extracted); ordinary
      // skipped entries only get the tool-result pairing row.
      if (entry.oversized) {
        placeholderRowsByMessageKey.set(entry.messageKey, buildOpaqueOversizedPlaceholders(entry));
        continue;
      }
      const placeholder = buildOversizedEntryPlaceholder(entry);
      if (placeholder) placeholderRowsByMessageKey.set(entry.messageKey, [placeholder]);
    }
    // Interleave placeholders at their original entry slots so the summary
    // projection keeps the turn's canonical row order; a tail-appended
    // synthetic block would detach the projection from the transcript order
    // the search index and the detail materialization both use.
    const combined: SDKNativeMessage[] = [];
    let nativeCursor = 0;
    for (let i = 0; i < entries.length; i += 1) {
      if (selected[i]) {
        if (nativeCursor < native.length) {
          combined.push(native[nativeCursor]);
          nativeCursor += 1;
        }
      } else {
        const rows = placeholderRowsByMessageKey.get(entries[i].messageKey);
        if (rows) combined.push(...rows);
      }
    }
    if (skipped.length > 0) {
      combined.push(buildOversizedTurnMarker(turn.turnId, skipped, entries[entries.length - 1]?.timestamp));
    }
    const messages = await materializeSDKMessages(
      state.vaultPath, segment.sessionId, combined, combined, segment.segmentOrdinal,
      turn.startEntry,
    );
    // The tail-appended marker has no real entry slot; its natural index
    // (endEntry + 1) ties with the next turn's opener key, so a prepended
    // older window would merge it behind that opener. Park it on the last
    // real slot's second projection position: after every real projection of
    // the turn, before the next turn. Markers merged into a trailing assistant
    // projection have no standalone key and stay untouched.
    const marker = messages.find(message => message.id === `oversized-marker-${turn.turnId}`);
    if (marker) {
      marker.displayOrder = [segment.segmentOrdinal, turn.endEntry, 1];
    }
    summarizeChatMessages(messages);
    return { messages, readBytes };
  }

  private async materializeWindow(
    state: ConversationIndexState,
    request: HistoryWindowRequest,
  ): Promise<HistoryWindowPage> {
    const startedAt = performance.now();
    const total = state.flattenedTurns.length;
    const plan = this.planWindowFor(state, request);
    this.recordHistoryDiagnostic('window', {
      phase: 'window_planned',
      turnCount: plan.end - plan.start,
      sourceBytes: plan.plannedSourceBytes,
    });
    const turns: Array<{
      index: number;
      messages: ChatMessage[];
      sourceBytes: number;
      projectedChars: number;
      shrunk: boolean;
    }> = [];
    // Preserve the planner's contiguous interval and canonical direction. If
    // projected chars force a second shrink, endpoints are removed by distance
    // from the anchor rather than always sacrificing the older side.
    for (let index = plan.start; index < plan.end; index += 1) {
      const item = state.flattenedTurns[index];
      const turnBytes = item.segment.index.turns[item.turnIndex].sourceBytes ?? 0;
      const oversized = turnBytes > request.budget.maxSourceBytes;
      let produced: ChatMessage[];
      let readBytes: number;
      let shrunk = oversized;
      if (oversized) {
        const summary = await this.materializeSummaryTurn(state, item.segment, item.turnIndex, request.budget);
        produced = summary.messages;
        readBytes = summary.readBytes;
      } else {
        produced = await this.materializeTurn(state, item.segment, item.turnIndex);
        readBytes = turnBytes;
      }
      let chars = measureChatProjectionChars(produced);
      if (chars > request.budget.maxProjectedChars) {
        const capped = hardCapChatProjection(produced, request.budget.maxProjectedChars);
        produced = capped.messages;
        chars = capped.projectedChars;
        shrunk = true;
      }
      for (const message of produced) message.projectionLevel = shrunk ? 'summary' : 'detail';
      turns.push({ index, messages: produced, sourceBytes: readBytes, projectedChars: chars, shrunk });
    }
    const anchorIndex = request.direction === 'older'
      ? Math.max(plan.start, plan.end - 1)
      : request.direction === 'newer'
        ? plan.start
        : Math.max(plan.start, Math.min(request.anchorTurn, plan.end - 1));
    let sourceBytes = turns.reduce((sum, turn) => sum + turn.sourceBytes, 0);
    let projectedChars = turns.reduce((sum, turn) => sum + turn.projectedChars, 0);
    while (turns.length > 1 && (
      sourceBytes > request.budget.maxSourceBytes
      || projectedChars > request.budget.maxProjectedChars
    )) {
      const firstDistance = Math.abs(turns[0].index - anchorIndex);
      const lastDistance = Math.abs(turns[turns.length - 1].index - anchorIndex);
      const removed = firstDistance >= lastDistance ? turns.shift()! : turns.pop()!;
      sourceBytes -= removed.sourceBytes;
      projectedChars -= removed.projectedChars;
    }
    const actualStart = turns[0]?.index ?? plan.end;
    const actualEnd = turns[turns.length - 1]?.index + 1 || plan.end;
    const messages = turns.flatMap(turn => turn.messages);
    const oversizedTurnCount = turns.filter(turn => turn.shrunk).length;
    const current = state.segments[state.segments.length - 1];
    const segmentIdentities = state.segments.map(segment => transcriptIndexResultIdentity(segment.result));
    this.recordHistoryDiagnostic('window', {
      phase: 'window_complete',
      turnCount: turns.length,
      sourceBytes,
      projectedChars,
      oversizedTurns: oversizedTurnCount,
      elapsedMs: performance.now() - startedAt,
    });
    return {
      messages: dedupeMessages(messages).sort(compareChatDisplayOrder),
      range: { start: actualStart, end: actualEnd },
      // Tail handoff must start at the committed boundary, not at the
      // stat-time EOF: on a partial snapshot the observer would otherwise
      // begin mid-line and lose every later row.
      snapshotOffset: current.index.committedSize,
      // The boundary travels with the identity credentials of the snapshot
      // that observed it (H/P8): a consumer priming there must reject a
      // replaced source instead of reading a new file at the stale offset.
      tailStart: claudeTailStart(current.index),
      sourceBytes,
      projectedChars,
      oversizedTurnCount,
      pageKey: `w:${JSON.stringify([segmentIdentities, [actualStart, actualEnd]])}`,
      hasMoreBefore: actualStart > 0,
      hasMoreAfter: actualEnd < total,
    };
  }

  iterateFullHistory(
    conversation: Conversation,
    vaultPath: string | null,
    options: FullHistoryIterationOptions,
  ): FullHistoryIterable {
    if (!vaultPath) throw new HistorySourceUnavailableError('vault_unavailable');
    const state = getClaudeState(conversation.providerState);
    if (!(state.providerSessionId ?? conversation.sessionId ?? state.forkSource?.sessionId)) {
      throw new HistorySourceUnavailableError('session_unavailable');
    }
    const lease = this.acquireHistoryIndex(conversation, vaultPath);
    const shared = this.leaseIndexes.get(lease)!;
    const getTurnBytes = (fixed: ConversationIndexState) => this.turnSourceBytes(fixed);
    const materialize = (fixed: ConversationIndexState, start: number, end: number) =>
      this.materializeDetailChunk(fixed, start, end, options.maxProjectedCharsPerChunk);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      options.signal?.removeEventListener('abort', release);
      lease.release();
    };
    const checkAbort = () => {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('History iteration aborted');
    };
    // Cancellation/return must work even before the generator's first next().
    options.signal?.addEventListener('abort', release, { once: true });
    if (options.signal?.aborted) release();
    void lease.ready.then(() => undefined, () => undefined);
    const generator = (async function* () {
      try {
        checkAbort();
        await lease.ready;
        const fixed = await shared.ready;
        const total = fixed.flattenedTurns.length;
        let cursor = 0;
        while (cursor < total) {
          checkAbort();
          if (released) return;
          const plan = planHistoryWindow(getTurnBytes(fixed), {
            anchorTurn: cursor,
            direction: 'newer',
            budget: {
              maxTurns: options.maxTurnsPerChunk,
              maxSourceBytes: options.maxSourceBytesPerChunk,
              maxProjectedChars: options.maxProjectedCharsPerChunk,
              timeSliceMs: 0,
            },
          });
          if (plan.oversizedAnchor) {
            throw new HistoryEntryTooLargeError(cursor, plan.plannedSourceBytes, null);
          }
          const page = await materialize(fixed, plan.start, plan.end);
          checkAbort();
          if (released) return;
          if (page.projectedChars > options.maxProjectedCharsPerChunk) {
            throw new HistoryEntryTooLargeError(cursor, page.sourceBytes, page.projectedChars);
          }
          cursor = page.range.end;
          yield {
            messages: page.messages,
            range: page.range,
            sourceBytes: page.sourceBytes,
            done: cursor === total,
          };
        }
      } catch (error) {
        if (error instanceof HistorySourceUnavailableError || error instanceof HistoryEntryTooLargeError) throw error;
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        throw new HistorySourceUnavailableError('transcript_unavailable');
      } finally {
        release();
      }
    })();
    const cursor: AsyncIterableIterator<FullHistoryChunk> = {
      [Symbol.asyncIterator]() { return this; },
      next: () => generator.next(),
      return: () => { release(); return generator.return(); },
      throw: error => { release(); return generator.throw(error); },
    };
    return cursor;
  }

  private async materializeDetailChunk(
    state: ConversationIndexState,
    start: number,
    plannedEnd: number,
    maxProjectedChars: number,
  ): Promise<{ messages: ChatMessage[]; range: { start: number; end: number }; sourceBytes: number; projectedChars: number }> {
    const messages: ChatMessage[] = [];
    let sourceBytes = 0;
    let projectedChars = 0;
    let end = start;
    for (let index = start; index < plannedEnd; index += 1) {
      const item = state.flattenedTurns[index];
      const produced = await this.materializeTurn(state, item.segment, item.turnIndex);
      const chars = measureChatProjectionChars(produced);
      const bytes = item.segment.index.turns[item.turnIndex].sourceBytes ?? 0;
      if (chars > maxProjectedChars) {
        throw new HistoryEntryTooLargeError(index, bytes, chars);
      }
      if (index > start && projectedChars + chars > maxProjectedChars) break;
      messages.push(...produced);
      projectedChars += chars;
      sourceBytes += bytes;
      end = index + 1;
    }
    return {
      messages: dedupeMessages(messages).sort(compareChatDisplayOrder),
      range: { start, end },
      sourceBytes,
      projectedChars,
    };
  }

  /** @deprecated Use iterateFullHistory with a bounded consumer. */
  async exportFullHistory(conversation: Conversation, vaultPath: string | null): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for await (const chunk of this.iterateFullHistory(conversation, vaultPath, {
      maxTurnsPerChunk: 100,
      maxSourceBytesPerChunk: 8 * 1024 * 1024,
      maxProjectedCharsPerChunk: 2 * 1024 * 1024,
      projectionLevel: 'detail',
    })) messages.push(...chunk.messages);
    return messages;
  }

  async deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    const state = getClaudeState(conversation.providerState);
    const sessionId = state.providerSessionId ?? conversation.sessionId;
    if (!vaultPath || !sessionId) {
      return;
    }

    await deleteSDKSession(vaultPath, sessionId);
  }
}
