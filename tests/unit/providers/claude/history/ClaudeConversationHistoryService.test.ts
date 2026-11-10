import { spawnSync } from 'child_process';
import { appendFileSync, existsSync } from 'fs';
import type * as fsPromisesModule from 'fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type * as workerThreadsModule from 'worker_threads';

import type { HistoryIndexLease, HistoryLoadBudget, HistoryLoadProgress } from '@/core/providers/types';
import type { ChatMessage, Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import type * as historyStoreModule from '@/providers/claude/history/ClaudeHistoryStore';
import { materializeSDKMessages, sdkSessionExists } from '@/providers/claude/history/ClaudeHistoryStore';
import type * as historyIndexModule from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import {
  buildTranscriptIndex,
  clearTranscriptIndexCache,
  materializeTranscriptEntries,
  materializeTranscriptPage,
  materializeTranscriptToolAssociations,
} from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import { measureChatProjectionChars } from '@/providers/claude/history/HistorySummaryProjection';
import * as sdkSessionPaths from '@/providers/claude/history/sdkSessionPaths';
import * as diagnosticLogModule from '@/providers/claude/transcript/ClaudeTranscriptDiagnosticLog';
import { ClaudeTranscriptDiagnosticLog } from '@/providers/claude/transcript/ClaudeTranscriptDiagnosticLog';

jest.mock('@/providers/claude/history/ClaudeTranscriptHistoryIndex', () => ({
  buildTranscriptIndex: jest.fn().mockResolvedValue({ status: 'complete', index: { entries: [], turns: [] } }),
  clearTranscriptIndexCache: jest.fn(),
  materializeTranscriptEntries: jest.fn(),
  materializeTranscriptPage: jest.fn(),
  materializeTranscriptToolAssociations: jest.fn(),
  protectTranscriptIndex: jest.fn(),
  releaseTranscriptIndex: jest.fn(),
  setTranscriptIndexDiagnosticSink: jest.fn(),
  transcriptIndexResultIdentity: jest.fn(jest.requireActual('@/providers/claude/history/ClaudeTranscriptHistoryIndex').transcriptIndexResultIdentity),
}));
jest.mock('@/providers/claude/history/ClaudeHistoryStore', () => ({
  loadSDKSessionMessages: jest.fn(),
  materializeSDKMessages: jest.fn(),
  loadSubagentToolCalls: jest.fn().mockResolvedValue([]),
  sdkSessionExists: jest.fn().mockReturnValue(true),
  deleteSDKSession: jest.fn().mockResolvedValue(undefined),
}));

const realIndex = jest.requireActual<typeof historyIndexModule>('@/providers/claude/history/ClaudeTranscriptHistoryIndex');
const realStore = jest.requireActual<typeof historyStoreModule>('@/providers/claude/history/ClaudeHistoryStore');
const realGetSDKSessionPath = sdkSessionPaths.getSDKSessionPath;

const mockSdkSessionExists = sdkSessionExists as jest.MockedFunction<typeof sdkSessionExists>;
const mockBuildTranscriptIndex = buildTranscriptIndex as jest.MockedFunction<typeof buildTranscriptIndex>;
const mockMaterializeTranscriptEntries = materializeTranscriptEntries as jest.MockedFunction<typeof materializeTranscriptEntries>;
const mockClearTranscriptIndexCache = clearTranscriptIndexCache as jest.MockedFunction<typeof clearTranscriptIndexCache>;
const mockMaterializeTranscriptPage = materializeTranscriptPage as jest.MockedFunction<typeof materializeTranscriptPage>;
const mockMaterializeTranscriptToolAssociations = materializeTranscriptToolAssociations as jest.MockedFunction<typeof materializeTranscriptToolAssociations>;
const mockMaterializeSDKMessages = materializeSDKMessages as jest.MockedFunction<typeof materializeSDKMessages>;

function createConversation(): Conversation {
  return {
    id: 'conversation-1',
    providerId: 'claude',
    title: 'Large history',
    createdAt: 1,
    updatedAt: 1,
    sessionId: 'current-session',
    providerState: {
      previousProviderSessionIds: ['previous-session'],
      providerSessionId: 'current-session',
    },
    messages: [],
  };
}

describe('ClaudeConversationHistoryService fixed leases with the real index and reader', () => {
  const fixtureDir = join(process.env.TMPDIR ?? '/tmp', `claudian-fixed-leases-${process.pid}`);
  const budget = { maxTurns: 10, maxSourceBytes: 100_000, maxProjectedChars: 100_000, timeSliceMs: 0 };

  function source(session = 'current-session'): Conversation {
    return { ...createConversation(), sessionId: session, providerState: { providerSessionId: session } };
  }

  async function writeQuestion(session: string, uuid = 'u1'): Promise<void> {
    await writeFile(join(fixtureDir, `${session}.jsonl`), `${JSON.stringify({ type: 'user', uuid, message: { content: `question-${uuid}` } })}\n`);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    await mkdir(fixtureDir, { recursive: true });
    realIndex.clearTranscriptIndexCache();
    // Existing projection tests use doubles; this group forwards every index,
    // cache, protection and materialization operation to production code.
    const mockedIndex = jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex');
    for (const key of Object.keys(mockedIndex)) {
      mockedIndex[key].mockImplementation(realIndex[key as keyof typeof realIndex]);
    }
    mockMaterializeSDKMessages.mockImplementation(realStore.materializeSDKMessages);
    mockSdkSessionExists.mockImplementation((vault, id) => existsSync(sdkSessionPaths.getSDKSessionPath(vault, id)));
    jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockImplementation((_vault, id) => join(fixtureDir, `${id}.jsonl`));
  });

  afterEach(() => { jest.restoreAllMocks(); realIndex.setTranscriptIndexDiagnosticSink(null); });
  afterAll(async () => { await rm(fixtureDir, { recursive: true, force: true }); });

  describe('Service diagnostic boundary with real IO', () => {
    let vault: string;
    const request = { anchorTurn: 0, direction: 'newer' as const, budget, projectionLevel: 'detail' as const };
    const record = ClaudeTranscriptDiagnosticLog.prototype.record;
    const Log = ClaudeTranscriptDiagnosticLog;

    const stateOf = (service: ClaudeConversationHistoryService) => service.getHistoryDiagnosticState();

    async function windowEvents() {
      const text = await readFile(join(vault, '.claudian/diagnostics/history-window.current.jsonl'), 'utf8');
      return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    }

    beforeEach(async () => { vault = await mkdtemp(join(fixtureDir, 'diagnostic-')); });
    afterEach(async () => { realIndex.resetTranscriptIndexWorkerProbe(); await rm(vault, { recursive: true, force: true }); });

    describe('synchronous return classification', () => {
      async function runBoundary(scenario: string, boundary: 'callback' | 'diagnostic') {
        const home = join(vault, 'home'), tmp = join(vault, 'tmp');
        await mkdir(home, { recursive: true }); await mkdir(tmp, { recursive: true });
        const script = `
          const assert = require('node:assert/strict');
          const fs = require('node:fs/promises');
          const path = require('node:path');
          const { ClaudeConversationHistoryService } = require(process.argv[1]);
          const { ClaudeTranscriptDiagnosticLog } = require(path.join(path.dirname(process.argv[1]), '../transcript/ClaudeTranscriptDiagnosticLog.ts'));
          const index = require(path.join(path.dirname(process.argv[1]), 'ClaudeTranscriptHistoryIndex.ts'));
          const paths = require(path.join(path.dirname(process.argv[1]), 'sdkSessionPaths.ts'));
          (async () => {
            const vault = process.argv[2], scenario = process.argv[3], boundary = process.argv[4];
            const file = paths.getSDKSessionPath(vault, 'synthetic');
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'synthetic only' } }) + '\\n');
            const service = new ClaudeConversationHistoryService();
            let thenCalls = 0, thenGets = 0, payloadGets = 0, returns = 0;
            let finishTimer;
            const timer = new Promise(resolve => { finishTimer = resolve; });
            const failure = new ReferenceError('synthetic first getter failure');
            const payload = Object.defineProperty({}, 'then', { get() { payloadGets++; throw new Error('potential payload was read'); } });
            const called = () => { if (++thenCalls === 1000) process.stdout.write('then_calls=1000\\n'); };
            const makeReturn = () => {
              returns++;
              setTimeout(() => { process.stdout.write('timer_completed\\n'); finishTimer(); }, 50);
              if (scenario.endsWith('-cycle')) queueMicrotask(() => process.stdout.write(JSON.stringify({ scenario, boundary,
                thenCalls, thenGets, payloadGets, state: service.getHistoryDiagnosticState() }) + '\\n'));
              if (scenario === 'self-cycle') {
                const self = { then(resolve) { called(); resolve(self); } };
                return self;
              }
              if (scenario === 'pair-cycle') {
                const first = { then(resolve) { called(); resolve(second); } };
                const second = { then(resolve) { called(); resolve(first); } };
                return first;
              }
              if (scenario === 'hidden-rejection') {
                // Created by the caller, before the Service sees the wrapper.
                // Not invoking then cannot make this hidden rejection handled.
                const hidden = Promise.reject(new Error('synthetic external hidden rejection'));
                queueMicrotask(() => process.stdout.write(JSON.stringify({ scenario, boundary, thenCalls, payloadGets,
                  state: service.getHistoryDiagnosticState() }) + '\\n'));
                return { then(resolve) { called(); resolve(hidden); } };
              }
              return Object.defineProperty({}, 'then', { get() {
                thenGets++;
                if (scenario === 'getter-loop') {
                  process.stdout.write('getter_entered\\n');
                  while (true) {} // Deliberate isolated non-cooperative caller.
                }
                if (scenario === 'getter-throws') throw failure;
                if (scenario === 'non-callable-number') return 7;
                if (scenario === 'non-callable-object') return payload;
                if (thenGets > 1) throw new Error('synthetic second getter failure');
                return resolve => { called(); resolve(payload); };
              } });
            };
            const record = ClaudeTranscriptDiagnosticLog.prototype.record;
            if (boundary === 'diagnostic') ClaudeTranscriptDiagnosticLog.prototype.record = function(event) {
              if (event.phase === 'window_planned') return makeReturn();
              return record.call(this, event);
            };
            const conversation = { id: 'synthetic', sessionId: 'synthetic', messages: [] };
            const a = service.acquireHistoryIndex(conversation, vault, boundary === 'callback' ? event => {
              if (event.phase !== 'queued') return;
              if (scenario === 'self-release-thenable') a.release();
              return makeReturn();
            } : undefined);
            const b = service.acquireHistoryIndex(conversation, vault);
            const observedA = a.ready.then(() => ({ status: 'fulfilled' }), reason => {
              process.stdout.write('A_rejected\\n'); return { status: 'rejected', reason };
            });
            const observedB = b.ready.then(() => { process.stdout.write('B_completed\\n'); });
            const [resultA] = await Promise.all([observedA, observedB]);
            const synchronous = scenario.startsWith('non-callable-');
            assert.equal(resultA.status, boundary === 'callback' && !synchronous ? 'rejected' : 'fulfilled');
            if (resultA.status === 'rejected') {
              if (scenario === 'getter-throws') assert.equal(resultA.reason, failure);
              else assert.match(resultA.reason.message, scenario === 'self-release-thenable'
                ? /History index build aborted/ : /History progress callbacks must be synchronous/);
            }
            const pageReady = b.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
              budget: { maxTurns: 10, maxSourceBytes: 100000, maxProjectedChars: 100000, timeSliceMs: 0 } });
            assert.equal((await pageReady).messages.length, 1);
            process.stdout.write('page_completed\\n');
            const state = service.getHistoryDiagnosticState();
            process.stdout.write(JSON.stringify({ scenario, boundary, thenCalls, thenGets, payloadGets, state }) + '\\n');
            await timer;
            assert.equal(returns, 1);
            assert.equal(thenCalls, 0); assert.equal(payloadGets, 0);
            assert.equal(thenGets, ['self-cycle', 'pair-cycle', 'hidden-rejection'].includes(scenario) ? 0 : 1);
            assert.equal(state.channels.index.status, 'normal');
            if (boundary === 'callback') {
              assert.equal(state.channels.window.status, 'normal');
              assert.equal(state.callbackErrorCount, synchronous ? 0 : 1);
              assert.equal(state.callbackPostTerminalErrorCount, scenario === 'self-release-thenable' ? 1 : 0);
              assert.equal(state.callbackNativeObservationNotEstablishedCount, 0);
            } else {
              assert.equal(state.channels.window.status, synchronous ? 'normal' : 'boundary_failed');
              assert.equal(state.channels.window.failureCount, synchronous ? 0 : 1);
              assert.equal(state.channels.window.nativeObservationNotEstablishedCount, 0);
              if (!synchronous) assert.equal(state.lastDiagnosticFailure.errorName, scenario === 'getter-throws' ? 'ReferenceError' : 'TypeError');
            }
            a.release(); b.release(); index.clearTranscriptIndexCache();
            assert.equal(index.getTranscriptIndexCacheSize(), 0); assert.equal(service.sharedIndexes.size, 0);
            process.stdout.write('boundary_completed\\n');
          })().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 2; });
        `;
        return spawnSync(process.execPath, ['--unhandled-rejections=strict', '--require', 'tsx/cjs', '-e', script,
          join(__dirname, '../../../../../src/providers/claude/history/ClaudeConversationHistoryService.ts'), vault, scenario, boundary], {
          // This process-external deadline also covers microtask starvation and
          // getter loops; the child timer is a liveness assertion, not a guard.
          cwd: join(__dirname, '../../../../..'), env: { ...process.env, HOME: home, TMPDIR: tmp }, encoding: 'utf8', timeout: 4_000,
          killSignal: 'SIGKILL',
        });
      }

      it.each((['callback', 'diagnostic'] as const).flatMap(boundary =>
        ['self-cycle', 'pair-cycle'].map(scenario => [boundary, scenario] as const)
      ))('does not assimilate cyclic thenables and lets peers and timers finish (%s, %s)', async (boundary, scenario) => {
        const child = await runBoundary(scenario, boundary);
        expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr, stdout: child.stdout })
          .toEqual({ status: 0, signal: null, error: undefined, stderr: '', stdout: expect.stringContaining('boundary_completed') });
        expect(child.stdout).toContain('B_completed'); expect(child.stdout).toContain('timer_completed');
        expect(child.stdout).toContain('page_completed'); expect(child.stdout).toContain('boundary_completed');
        expect(child.stdout).not.toContain('then_calls=1000');
      });

      it.each((['callback', 'diagnostic'] as const).flatMap(boundary =>
        ['callable-getter', 'getter-throws', 'non-callable-number', 'non-callable-object',
          ...(boundary === 'callback' ? ['self-release-thenable'] : [])].map(scenario => [boundary, scenario] as const)
      ))('reads then once without invoking methods or reading potential payloads (%s, %s)', async (boundary, scenario) => {
        const child = await runBoundary(scenario, boundary);
        expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr, stdout: child.stdout })
          .toEqual({ status: 0, signal: null, error: undefined, stderr: '', stdout: expect.stringContaining('boundary_completed') });
        expect(child.stdout).toContain('boundary_completed');
      });

      it.each(['callback', 'diagnostic'] as const)('does not claim observation of an externally created hidden rejection (%s)', async boundary => {
        const child = await runBoundary('hidden-rejection', boundary);
        expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(1);
        expect(child.stderr).toContain('synthetic external hidden rejection');
        const snapshot = child.stdout.split('\n').find(line => line.startsWith('{'));
        expect(snapshot).toBeDefined();
        expect(JSON.parse(snapshot!)).toMatchObject({ thenCalls: 0, payloadGets: 0 });
      });

      it.each(['callback', 'diagnostic'] as const)('retains the isolated synchronous getter-loop limitation (%s)', async boundary => {
        const child = await runBoundary('getter-loop', boundary);
        expect(child.error).toMatchObject({ code: 'ETIMEDOUT' });
        expect(child.signal).toBe('SIGKILL'); expect(child.stdout).toContain('getter_entered');
        expect(child.stdout).not.toContain('boundary_completed');
      });
    });

    describe('restricted return observation', () => {
      async function runIsolated(scenario: string, boundary: 'callback' | 'diagnostic', rejected = false) {
        const home = join(vault, 'home'), tmp = join(vault, 'tmp');
        await mkdir(home, { recursive: true }); await mkdir(tmp, { recursive: true });
        const script = `
          const assert = require('node:assert/strict');
          const fs = require('node:fs/promises');
          const path = require('node:path');
          const vm = require('node:vm');
          const { ClaudeConversationHistoryService } = require(process.argv[1]);
          const { ClaudeTranscriptDiagnosticLog } = require(path.join(path.dirname(process.argv[1]), '../transcript/ClaudeTranscriptDiagnosticLog.ts'));
          const index = require(path.join(path.dirname(process.argv[1]), 'ClaudeTranscriptHistoryIndex.ts'));
          const paths = require(path.join(path.dirname(process.argv[1]), 'sdkSessionPaths.ts'));
          (async () => {
            const vault = process.argv[2], scenario = process.argv[3], boundary = process.argv[4], rejected = process.argv[5] === 'true';
            const file = paths.getSDKSessionPath(vault, 'synthetic');
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'synthetic only' } }) + '\\n');
            let thenGets = 0, constructorGets = 0, speciesGets = 0, payloadGets = 0, thenCalls = 0, returns = 0;
            let restoreIntrinsic = () => undefined;
            const payload = Object.defineProperty({}, 'then', { get() {
              payloadGets++;
              if (payloadGets > 1) throw new Error('synthetic payload second getter');
              return undefined;
            } });
            const makeReturn = () => {
              returns++;
              if (scenario === 'thenable-payload') return { then(resolve) { thenCalls++; resolve(payload); } };
              if (scenario === 'getter-count') return Object.defineProperty({}, 'then', { get() {
                thenGets++; return resolve => { thenCalls++; resolve(); };
              } });
              let promise = scenario === 'foreign' ? vm.runInNewContext(rejected
                ? 'Promise.reject(new Error("synthetic external rejection"))' : 'Promise.resolve()')
                : scenario === 'subclass' ? new (class extends Promise {})((resolve, reject) => rejected
                  ? reject(new Error('synthetic external rejection')) : resolve())
                : scenario === 'native-payload' ? Promise.resolve(payload)
                : rejected || scenario === 'native-then' || scenario === 'self-release-native'
                  ? Promise.reject(new Error('synthetic external rejection')) : Promise.resolve();
              if (scenario === 'constructor-getter' || scenario === 'frozen-constructor') {
                Object.defineProperty(promise, 'constructor', { get() { constructorGets++; throw new Error('synthetic constructor getter'); } });
                if (scenario === 'frozen-constructor') Object.freeze(promise);
              }
              if (scenario === 'constructor-data' || scenario === 'species-getter') {
                const constructor = scenario === 'constructor-data' ? Promise : function CustomPromise() {};
                if (scenario === 'species-getter') Object.defineProperty(constructor, Symbol.species, {
                  get() { speciesGets++; throw new Error('synthetic species getter'); }
                });
                Object.defineProperty(promise, 'constructor', { value: constructor });
              }
              if (scenario === 'prototype-proxy') Object.setPrototypeOf(promise, new Proxy(Promise.prototype, {
                get() { constructorGets++; throw new Error('synthetic prototype trap'); }
              }));
              if (scenario === 'native-then' || scenario === 'self-release-native') Object.defineProperty(promise, 'then', {
                get() { thenGets++; throw new Error('synthetic instance then getter'); }
              });
              if (scenario.startsWith('intrinsic-')) {
                const target = scenario === 'intrinsic-species' ? Promise : Promise.prototype;
                const key = scenario === 'intrinsic-species' ? Symbol.species : scenario === 'intrinsic-constructor' ? 'constructor' : 'then';
                const descriptor = Object.getOwnPropertyDescriptor(target, key);
                Object.defineProperty(target, key, { configurable: true, get() {
                  if (scenario === 'intrinsic-species') speciesGets++;
                  else if (scenario === 'intrinsic-constructor') constructorGets++;
                  else thenGets++;
                  throw new Error('synthetic changed intrinsic getter');
                } });
                let restored = false;
                restoreIntrinsic = () => {
                  if (!restored) { restored = true; Object.defineProperty(target, key, descriptor); }
                };
                // Keep global mutation local to this check: B restores during
                // progress dispatch; completed diagnostic IO restores next tick.
                queueMicrotask(restoreIntrinsic);
              }
              if (rejected) queueMicrotask(() => process.stdout.write(JSON.stringify({ scenario, boundary, rejected,
                thenGets, constructorGets, speciesGets, payloadGets, thenCalls, state: service.getHistoryDiagnosticState() }) + '\\n'));
              return promise;
            };
            const unobservable = scenario.startsWith('intrinsic-') || ['constructor-getter', 'frozen-constructor', 'constructor-data', 'species-getter', 'subclass', 'foreign', 'prototype-proxy'].includes(scenario);
            const service = new ClaudeConversationHistoryService();
            const conversation = { id: 'synthetic', sessionId: 'synthetic', messages: [] };
            const record = ClaudeTranscriptDiagnosticLog.prototype.record;
            if (boundary === 'diagnostic') ClaudeTranscriptDiagnosticLog.prototype.record = function(event) {
              if (event.phase === (scenario.startsWith('intrinsic-') ? 'window_complete' : 'window_planned')) return makeReturn();
              return record.call(this, event);
            };
            const a = service.acquireHistoryIndex(conversation, vault, boundary === 'callback' ? event => {
              if (scenario.startsWith('intrinsic-') && event.phase !== 'finalizing') return;
              if (scenario === 'self-release-native') a.release();
              return makeReturn();
            } : undefined);
            const b = service.acquireHistoryIndex(conversation, vault, () => { restoreIntrinsic(); });
            const results = await Promise.allSettled([a.ready, b.ready]);
            assert.equal(results[0].status, boundary === 'callback' ? 'rejected' : 'fulfilled');
            if (boundary === 'callback') assert.match(results[0].reason.message, scenario === 'self-release-native'
              ? /History index build aborted/ : /History progress callbacks must be synchronous/);
            assert.equal(results[1].status, 'fulfilled');
            assert.equal((await b.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
              budget: { maxTurns: 10, maxSourceBytes: 100000, maxProjectedChars: 100000, timeSliceMs: 0 } })).messages.length, 1);
            const state = service.getHistoryDiagnosticState();
            a.release(); b.release();
            index.clearTranscriptIndexCache();
            assert.equal(index.getTranscriptIndexCacheSize(), 0);
            assert.equal(service.sharedIndexes.size, 0);
            assert.equal(returns, 1);
            assert.equal(thenGets, scenario === 'getter-count' ? 1 : 0);
            assert.equal(constructorGets, 0); assert.equal(speciesGets, 0);
            assert.equal(payloadGets, scenario === 'native-payload' ? 1 : 0);
            assert.equal(thenCalls, 0);
            assert.equal(state.channels.index.status, 'normal');
            if (boundary === 'callback') {
              assert.equal(state.channels.window.status, 'normal');
              assert.equal(state.callbackErrorCount, 1);
              assert.equal(state.callbackPostTerminalErrorCount, scenario === 'self-release-native' ? 1 : 0);
              assert.equal(state.callbackNativeObservationNotEstablishedCount, unobservable ? 1 : 0);
            } else {
              assert.equal(state.channels.window.status, 'boundary_failed');
              assert.equal(state.channels.window.failureCount, 1);
              assert.equal(state.channels.window.nativeObservationNotEstablishedCount, unobservable ? 1 : 0);
            }
            assert.ok(!JSON.stringify(state).includes(vault));
            if (!rejected) process.stdout.write(JSON.stringify({ scenario, boundary, rejected, thenGets, constructorGets, speciesGets, payloadGets, thenCalls, state }) + '\\n');
            await new Promise(resolve => setTimeout(resolve, 50));
          })().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 2; });
        `;
        return spawnSync(process.execPath, ['--unhandled-rejections=strict', '--require', 'tsx/cjs', '-e', script,
          join(__dirname, '../../../../../src/providers/claude/history/ClaudeConversationHistoryService.ts'), vault, scenario, boundary, String(rejected)], {
          cwd: join(__dirname, '../../../../..'), env: { ...process.env, HOME: home, TMPDIR: tmp }, encoding: 'utf8', timeout: 15_000,
        });
      }

      it.each((['callback', 'diagnostic'] as const).flatMap(boundary =>
        ['native-then', 'native-payload', 'thenable-payload', 'getter-count', ...(boundary === 'callback' ? ['self-release-native'] : [])]
          .map(scenario => [boundary, scenario] as const)
      ))('classifies returns without assimilating thenables or forwarding native payloads (%s, %s)', async (boundary, scenario) => {
        const child = await runIsolated(scenario, boundary);
        expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr })
          .toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
        expect(JSON.parse(child.stdout)).toMatchObject({ boundary, scenario });
      });

      it.each((['callback', 'diagnostic'] as const).flatMap(boundary =>
        ['constructor-getter', 'frozen-constructor', 'constructor-data', 'species-getter', 'subclass', 'foreign', 'prototype-proxy',
          'intrinsic-species', 'intrinsic-constructor', 'intrinsic-then'].map(scenario => [boundary, scenario] as const)
      ))('reports no established native observation without executing external accessors (%s, %s)', async (boundary, scenario) => {
        const child = await runIsolated(scenario, boundary);
        expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr })
          .toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
        expect(JSON.parse(child.stdout)).toMatchObject({ constructorGets: 0, speciesGets: 0, thenGets: 0 });
      });

      // These are boundary counterexamples, not a claim that external rejection
      // is safe. No process handler or caller-side catch may hide strict exit.
      it.each((['callback', 'diagnostic'] as const).flatMap(boundary =>
        ['constructor-getter', 'frozen-constructor', 'constructor-data', 'species-getter', 'subclass', 'foreign', 'prototype-proxy']
          .map(scenario => [boundary, scenario] as const)
      ))('retains the strict external-rejection counterexample (%s, %s)', async (boundary, scenario) => {
        const child = await runIsolated(scenario, boundary, true);
        expect(child.error).toBeUndefined(); expect(child.signal).toBeNull();
        expect(child.status).toBe(1);
        // Node's own strict rejection reporting queries the abnormal prototype;
        // the pre-exit snapshot below proves the Service did not query it.
        expect(child.stderr).toContain(scenario === 'prototype-proxy' ? 'synthetic prototype trap' : 'synthetic external rejection');
        expect(child.stderr).not.toContain('synthetic constructor getter');
        expect(child.stderr).not.toContain('synthetic species getter');
        expect(child.stderr.includes('synthetic prototype trap')).toBe(scenario === 'prototype-proxy');
        expect(JSON.parse(child.stdout)).toMatchObject({ constructorGets: 0, speciesGets: 0, thenGets: 0 });
      });
    });

    describe('diagnostic reentry', () => {
      const lookupSize = (service: ClaudeConversationHistoryService) => (service as any).sharedIndexes.size;

      it.each(['same-channel', 'cross-channel'] as const)('suppresses nested records without fusing healthy channels (%s)', async mode => {
        await writeQuestion(`diagnostic-reentry-${mode}`);
        const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-reentry-${mode}`);
        const a = service.acquireHistoryIndex(conversation, vault), b = service.acquireHistoryIndex(conversation, vault);
        await Promise.all([a.ready, b.ready]);
        const mockedIndex = jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex');
        const sink = mockedIndex.setTranscriptIndexDiagnosticSink.mock.calls[0][0];
        let depth = 0, maxDepth = 0, calls = 0;
        jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
          if (event.phase !== 'lease_release' && event.phase !== 'cache_hit') return record.call(this, event);
          depth++; maxDepth = Math.max(depth, maxDepth); calls++;
          try {
            // Cap the red-test recursion; failure is measured entry depth, not
            // a Jest worker killed by a deliberately exhausted stack.
            if (calls < 20) {
              if (mode === 'cross-channel') sink({ phase: 'cache_hit' });
              const nested = service.acquireHistoryIndex(conversation, vault);
              nested.release();
            }
            return record.call(this, event);
          } finally { depth--; }
        });
        a.release(); b.release();
        expect(maxDepth).toBe(1); expect(calls).toBe(1);
        expect(lookupSize(service)).toBe(0);
        expect(mockedIndex.protectTranscriptIndex).toHaveBeenCalledTimes(1);
        expect(mockedIndex.releaseTranscriptIndex).toHaveBeenCalledTimes(1);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
        const state = stateOf(service);
        expect(state.channels.window).toMatchObject({ status: 'normal', failureCount: 0,
          suppressedCount: 1, reentrantSuppressedCount: 1 });
        expect(state.channels.index).toMatchObject({ status: 'normal', failureCount: 0,
          reentrantSuppressedCount: mode === 'cross-channel' ? 1 : 0 });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(lookupSize(service)).toBe(0);
      });

      it('isolates a reentrant diagnostic then getter without changing the completed page', async () => {
        await writeQuestion('diagnostic-reentry-getter');
        const service = new ClaudeConversationHistoryService(), conversation = source('diagnostic-reentry-getter');
        const failure = new ReferenceError('private then getter body');
        let gets = 0;
        jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
          if (event.phase !== 'window_planned') return record.call(this, event);
          return new Proxy({}, { get(_target, key) {
            if (key !== 'then') return undefined;
            gets++;
            const nested = service.acquireHistoryIndex({ ...conversation, id: 'nested-getter' }, vault);
            nested.release();
            throw failure;
          } });
        });
        const lease = service.acquireHistoryIndex(conversation, vault);
        try {
          await lease.ready; expect((await lease.loadWindow(request)).messages).toHaveLength(1);
          expect(gets).toBe(1);
          expect(stateOf(service)).toMatchObject({ channels: {
            index: { status: 'normal', failureCount: 0 },
            window: { status: 'boundary_failed', failureCount: 1, reentrantSuppressedCount: 1 },
          }, lastDiagnosticFailure: { channel: 'window', phase: 'window_planned', errorName: 'ReferenceError' } });
          expect(lookupSize(service)).toBe(1);
        } finally { lease.release(); }
        expect(lookupSize(service)).toBe(0);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
      });

      it('fuses a reentrant diagnostic returning a thenable without invoking it or changing the page', async () => {
        await writeQuestion('diagnostic-reentry-thenable');
        const service = new ClaudeConversationHistoryService(), conversation = source('diagnostic-reentry-thenable');
        let calls = 0, thenCalls = 0, payloadGets = 0;
        const payload = Object.defineProperty({}, 'then', { get() { payloadGets++; return undefined; } });
        jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
          if (event.phase !== 'window_planned') return record.call(this, event);
          calls++;
          const nested = service.acquireHistoryIndex({ ...conversation, id: 'nested-thenable' }, vault);
          nested.release();
          return { then(resolve: (value: unknown) => void) { thenCalls++; resolve(payload); } } as any;
        });
        const lease = service.acquireHistoryIndex(conversation, vault);
        try {
          await lease.ready; expect((await lease.loadWindow(request)).messages).toHaveLength(1);
          expect(calls).toBe(1); expect(thenCalls).toBe(0); expect(payloadGets).toBe(0);
          expect(stateOf(service)).toMatchObject({ channels: {
            index: { status: 'normal', failureCount: 0 },
            window: { status: 'boundary_failed', failureCount: 1, reentrantSuppressedCount: 1 },
          }, lastDiagnosticFailure: { channel: 'window', phase: 'window_planned', errorName: 'TypeError' } });
          expect(lookupSize(service)).toBe(1);
        } finally { lease.release(); }
        expect(lookupSize(service)).toBe(0);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
      });

      it('keeps a reentrant successor owner when the retiring logger throws', async () => {
        await writeQuestion('diagnostic-successor-owner');
        const service = new ClaudeConversationHistoryService(), conversation = source('diagnostic-successor-owner');
        let successor: HistoryIndexLease | undefined;
        jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
          if (event.phase === 'lease_release' && !successor) {
            successor = service.acquireHistoryIndex(conversation, vault);
            throw new RangeError('retiring diagnostic failure');
          }
          return record.call(this, event);
        });
        const old = service.acquireHistoryIndex(conversation, vault);
        try {
          await old.ready; old.release();
          await successor!.ready; old.release();
          expect(lookupSize(service)).toBe(1);
          expect((await successor!.loadWindow(request)).messages).toHaveLength(1);
          expect(stateOf(service).channels.index.status).toBe('normal');
          expect(stateOf(service).channels.window).toMatchObject({ status: 'boundary_failed', failureCount: 1 });
          realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(1);
        } finally { old.release(); successor?.release(); }
        expect(lookupSize(service)).toBe(0);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
      });

      it.each((['index', 'window', 'register'] as const).flatMap(stage =>
        (stage === 'register' ? ['throw', 'async'] as const : ['throw', 'async', 'notify'] as const)
          .map(outcome => [stage, outcome] as const)
      ))('resets busy and fuses only the outer initialization channel (%s, %s)', async (stage, outcome) => {
        await writeQuestion(`diagnostic-init-failure-${stage}-${outcome}`);
        const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-init-failure-${stage}-${outcome}`);
        let calls = 0;
        const reenter = () => {
          calls++;
          if (calls > 10) throw new Error('red recursion cap');
          const nested = service.acquireHistoryIndex({ ...conversation, id: 'nested-init-failure' }, vault);
          nested.release();
        };
        const ctor = jest.spyOn(diagnosticLogModule, 'ClaudeTranscriptDiagnosticLog').mockImplementation((path, notify, base) => {
          if (base !== `history-${stage}`) return new Log(path, notify, base);
          reenter();
          if (outcome === 'throw') throw new URIError('private initialization failure');
          if (outcome === 'async') return Promise.reject(new URIError('private unsupported factory')) as any;
          notify!('private notify payload');
          return new Log(path, notify, base);
        });
        const mockedIndex = jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex');
        mockedIndex.setTranscriptIndexDiagnosticSink.mockImplementation((sink: Parameters<typeof realIndex.setTranscriptIndexDiagnosticSink>[0]) => {
          if (stage !== 'register') return realIndex.setTranscriptIndexDiagnosticSink(sink);
          reenter();
          if (outcome === 'throw') throw new URIError('private registration failure');
          return Promise.reject(new URIError('private unsupported registration'));
        });
        const a = service.acquireHistoryIndex(conversation, vault), b = service.acquireHistoryIndex(conversation, vault);
        try {
          await Promise.all([a.ready, b.ready]);
          expect((await b.loadWindow(request)).messages).toHaveLength(1);
          expect(calls).toBe(1);
          expect(ctor.mock.calls.map(([, , base]) => base)).toEqual(['history-index', 'history-window']);
          const channel = stage === 'register' ? 'index' : stage;
          expect(stateOf(service).channels[channel]).toMatchObject({
            status: outcome === 'notify' ? 'internally_disabled' : 'boundary_failed', failureCount: 1,
          });
          expect(stateOf(service).channels[channel === 'index' ? 'window' : 'index'].status).toBe('normal');
          expect(lookupSize(service)).toBe(1);
        } finally { a.release(); b.release(); }
        expect(lookupSize(service)).toBe(0);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
      });

      it.each(['index', 'window', 'register'] as const)('guards initialization and registration before external reentry (%s)', async stage => {
        await writeQuestion(`diagnostic-init-reentry-${stage}`);
        const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-init-reentry-${stage}`);
        let calls = 0, maxDepth = 0, depth = 0;
        const snapshots: Array<{ before: unknown; after: unknown }> = [];
        const reenter = () => {
          calls++; depth++; maxDepth = Math.max(maxDepth, depth);
          try {
            if (calls >= 20) return;
            const bindings = (service as any).diagnosticBindings;
            const copy = () => ['index', 'window'].map(channel => ({ status: bindings[channel].status,
              logger: bindings[channel].logger, activePhase: bindings[channel].activePhase }));
            const before = copy();
            const nested = service.acquireHistoryIndex({ ...conversation, id: 'nested-init' }, vault);
            nested.release(); snapshots.push({ before, after: copy() });
          } finally { depth--; }
        };
        const ctor = jest.spyOn(diagnosticLogModule, 'ClaudeTranscriptDiagnosticLog').mockImplementation((path, notify, base) => {
          if (base === `history-${stage}`) reenter();
          return new Log(path, notify, base);
        });
        const mockedIndex = jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex');
        mockedIndex.setTranscriptIndexDiagnosticSink.mockImplementation((sink: Parameters<typeof realIndex.setTranscriptIndexDiagnosticSink>[0]) => {
          if (stage === 'register') reenter();
          realIndex.setTranscriptIndexDiagnosticSink(sink);
        });
        const lease = service.acquireHistoryIndex(conversation, vault);
        try {
          await lease.ready; expect((await lease.loadWindow(request)).messages).toHaveLength(1);
          expect(calls).toBe(1); expect(maxDepth).toBe(1);
          for (const snapshot of snapshots) expect(snapshot.after).toEqual(snapshot.before);
          expect(ctor.mock.calls.map(([, , base]) => base)).toEqual(['history-index', 'history-window']);
          expect(mockedIndex.setTranscriptIndexDiagnosticSink).toHaveBeenCalledTimes(1);
          expect(stateOf(service).channels.index.status).toBe('normal');
          expect(stateOf(service).channels.window).toMatchObject({ status: 'normal', failureCount: 0 });
          expect(stateOf(service).channels.window.reentrantSuppressedCount).toBeGreaterThan(0);
          expect(lookupSize(service)).toBe(1);
        } finally { lease.release(); }
        expect(lookupSize(service)).toBe(0);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
      });
    });

    it.each((['single', 'with-peer', 'both'] as const).flatMap(scenario =>
      (['queued', 'indexing', 'finalizing'] as const).map(phase => [scenario, phase] as const)
    ))('observes self release then throw without replacing cancellation (%s, %s)', async (scenario, phase) => {
      await writeQuestion(`diagnostic-release-${scenario}-${phase}`);
      const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-release-${scenario}-${phase}`);
      const a = service.acquireHistoryIndex(conversation, vault, event => {
        if (event.phase !== phase) return;
        a.release(); throw new TypeError('private A body');
      });
      const b = scenario === 'single' ? undefined : service.acquireHistoryIndex(conversation, vault,
        scenario === 'both' ? event => {
          if (event.phase !== phase) return;
          b!.release(); throw new RangeError('private B body');
        } : undefined);
      try {
        const results = await Promise.allSettled(b ? [a.ready, b.ready] : [a.ready]);
        expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('History index build aborted') });
        expect(results.slice(1)).toEqual(scenario === 'single' ? [] : scenario === 'both'
          ? [{ status: 'rejected', reason: new Error('History index build aborted') }] : [{ status: 'fulfilled', value: undefined }]);
        const events = await windowEvents();
        expect(events.filter(event => event.phase === 'callback_error').map(event => event.errorName))
          .toEqual(scenario === 'both' ? ['TypeError', 'RangeError'] : ['TypeError']);
        const state = stateOf(service);
        expect(state.callbackErrorCount).toBe(scenario === 'both' ? 2 : 1);
        expect(state.callbackPostTerminalErrorCount).toBe(state.callbackErrorCount);
        expect(state.lastCallback).toEqual({ phase, errorName: scenario === 'both' ? 'RangeError' : 'TypeError' });
        expect(JSON.stringify(events)).not.toContain('private');
      } finally { a.release(); b?.release(); }
      realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
    });

    it.each(['queued', 'indexing', 'finalizing'] as const)('keeps B readable when A callback and its logger fail at %s', async phase => {
      await writeQuestion(`diagnostic-callback-${phase}`);
      const failure = new TypeError('private callback body');
      const spy = jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
        if (event.phase === 'callback_error') throw new Error('private diagnostic body');
        return record.call(this, event);
      });
      const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-callback-${phase}`);
      const a = service.acquireHistoryIndex(conversation, vault, event => { if (event.phase === phase) throw failure; });
      const b = service.acquireHistoryIndex(conversation, vault);
      try {
        expect(await Promise.allSettled([a.ready, b.ready]))
          .toEqual([{ status: 'rejected', reason: failure }, { status: 'fulfilled', value: undefined }]);
        expect((await b.loadWindow(request)).messages[0].content).toBe('question-u1');
        await expect(a.search('question')).rejects.toBe(failure);
        expect(stateOf(service)).toMatchObject({
          channels: { index: { status: 'normal' }, window: { status: 'boundary_failed', failureCount: 1 } },
          callbackErrorCount: 1, callbackPostTerminalErrorCount: 0,
          lastCallback: { phase, errorName: 'TypeError' },
          lastDiagnosticFailure: { channel: 'window', phase: 'callback_error', errorName: 'Error' },
        });
        expect(spy.mock.calls.filter(([event]) => event.phase === 'callback_error')).toHaveLength(1);
      } finally { a.release(); b.release(); }
      realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
    });

    it.each(['healthy', 'throwing'] as const)('settles two distinct callback failures and counts both (%s logger)', async mode => {
      await writeQuestion(`diagnostic-two-errors-${mode}`);
      jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
        if (mode === 'throwing' && event.phase === 'callback_error') throw new Error('diagnostic failure');
        return record.call(this, event);
      });
      const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-two-errors-${mode}`);
      const errorA = new TypeError('private A'), errorB = new RangeError('private B');
      const a = service.acquireHistoryIndex(conversation, vault, () => { throw errorA; });
      const b = service.acquireHistoryIndex(conversation, vault, () => { throw errorB; });
      try {
        expect(await Promise.allSettled([a.ready, b.ready]))
          .toEqual([{ status: 'rejected', reason: errorA }, { status: 'rejected', reason: errorB }]);
        expect(stateOf(service)).toMatchObject({ callbackErrorCount: 2, callbackPostTerminalErrorCount: 0,
          lastCallback: { phase: 'queued', errorName: 'RangeError' } });
        const callbackEvents = mode === 'healthy' ? (await windowEvents()).filter(event => event.phase === 'callback_error') : [];
        expect(callbackEvents).toHaveLength(mode === 'healthy' ? 2 : 0);
      } finally { a.release(); b.release(); }
    });

    it.each(['unavailable', 'later-stat', 'later-open'] as const)('preserves original %s failure and cleans pins before failed logging', async scenario => {
      const conversation = source(`diagnostic-source-${scenario}`);
      const original = new RangeError('synthetic private later IO');
      if (scenario !== 'unavailable') {
        await writeQuestion('diagnostic-source-prefix'); await writeQuestion(`diagnostic-source-${scenario}`, 'u2');
        conversation.providerState = { ...conversation.providerState, previousProviderSessionIds: ['diagnostic-source-prefix'] };
        if (scenario === 'later-open') {
          // Worker IO lives in another thread; force the real supported direct
          // fallback so the physical open failure is injected at its actual boundary.
          const workers = jest.requireActual<typeof workerThreadsModule>('worker_threads');
          jest.spyOn(workers, 'Worker').mockImplementation(() => { throw new Error('synthetic worker unavailable'); });
          realIndex.resetTranscriptIndexWorkerProbe();
        }
        const fs = jest.requireActual<typeof fsPromisesModule>('fs/promises');
        const method = scenario === 'later-stat' ? 'stat' : 'open';
        const operation = fs[method];
        jest.spyOn(fs, method).mockImplementation((async (...args: any[]) => {
          if (args[0] === join(fixtureDir, `diagnostic-source-${scenario}.jsonl`)) throw original;
          return (operation as any)(...args);
        }) as any);
      }
      let failedCalls = 0, cleanupAtFailure = -1;
      jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
        if (event.phase === 'failed' && !('buildId' in event)) {
          failedCalls++;
          cleanupAtFailure = jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex').releaseTranscriptIndex.mock.calls.length;
          if (failedCalls === 1) throw new SyntaxError('injected diagnostic failure');
        }
        return record.call(this, event);
      });
      const service = new ClaudeConversationHistoryService();
      const a = service.acquireHistoryIndex(conversation, vault), b = service.acquireHistoryIndex(conversation, vault);
      try {
        const results = await Promise.allSettled([a.ready, b.ready]);
        const expected = scenario === 'unavailable' ? 'Conversation transcript is unavailable' : original.message;
        expect(results).toEqual(Array.from({ length: 2 }, () => ({ status: 'rejected', reason: new Error(expected) })));
        expect((results[0] as PromiseRejectedResult).reason).toBe((results[1] as PromiseRejectedResult).reason);
        // Both lower-index IO failures become its existing public failed result:
        // preserve that source message and the Service-owned Error shared by A/B,
        // not an IO Error identity the index contract does not expose.
        expect(cleanupAtFailure).toBe(scenario === 'unavailable' ? 0 : 1);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
        expect(stateOf(service).channels.window.status).toBe('boundary_failed');
      } finally { a.release(); b.release(); }
    });

    it.each(['partial_snapshot', 'stale_partial_segment', 'window_planned', 'window_complete', 'index'] as const)('does not change partial/page/index business results when %s diagnostics throw', async phase => {
        const session = `diagnostic-projection-${phase}`;
        await writeQuestion(session);
        const conversation = source(session);
        if (phase === 'partial_snapshot' || phase === 'stale_partial_segment') {
          appendFileSync(join(fixtureDir, `${session}.jsonl`), '{"type":"user"');
          if (phase === 'stale_partial_segment') {
            await writeQuestion(`${session}-current`, 'u2');
            conversation.providerState = { providerSessionId: `${session}-current`, previousProviderSessionIds: [session] };
          }
        }
        const spy = jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
          if ((phase === 'index' && 'buildId' in event) || event.phase === phase) throw new Error('private projection diagnostic');
          return record.call(this, event);
        });
        const service = new ClaudeConversationHistoryService(), lease = service.acquireHistoryIndex(conversation, vault);
        try {
          await lease.ready;
          const page = await lease.loadWindow(request);
          expect(page.messages.map(message => message.id)).toEqual(phase === 'stale_partial_segment' ? ['u1', 'u2'] : ['u1']);
          expect(await lease.search('question')).toHaveLength(phase === 'stale_partial_segment' ? 2 : 1);
          const channel = phase === 'index' ? 'index' : 'window';
          expect(stateOf(service).channels[channel]).toMatchObject({ status: 'boundary_failed', failureCount: 1 });
          expect(stateOf(service).channels[channel === 'index' ? 'window' : 'index'].status).toBe('normal');
          expect(spy.mock.calls.filter(([event]) => phase === 'index' ? 'buildId' in event : event.phase === phase)).toHaveLength(1);
        } finally { lease.release(); }
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
      });

    it.each(['index', 'window', 'both'] as const)('observes real directory failure via notify without replacing either callback (%s)', async blocked => {
      await writeQuestion(`diagnostic-disk-${blocked}`);
      if (blocked === 'both') await writeFile(join(vault, '.claudian'), 'not a directory');
      else await mkdir(join(vault, `.claudian/diagnostics/history-${blocked}.current.jsonl`), { recursive: true });
      const spy = jest.spyOn(Log.prototype, 'record'); // call-through: real serializer, fs, disable and notify
      const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-disk-${blocked}`);
      const original = new TypeError('private callback');
      const a = service.acquireHistoryIndex(conversation, vault, () => { throw original; });
      const b = service.acquireHistoryIndex(conversation, vault);
      try {
        expect(await Promise.allSettled([a.ready, b.ready]))
          .toEqual([{ status: 'rejected', reason: original }, { status: 'fulfilled', value: undefined }]);
        expect((await b.loadWindow(request)).messages).toHaveLength(1);
        const state = stateOf(service);
        for (const channel of ['index', 'window'] as const) expect(state.channels[channel]).toMatchObject({
          status: blocked === channel || blocked === 'both' ? 'internally_disabled' : 'normal',
          failureCount: blocked === channel || blocked === 'both' ? 1 : 0,
        });
        expect(state.callbackErrorCount).toBe(1);
        expect(spy.mock.calls.filter(([event]) => event.phase === 'callback_error')).toHaveLength(1);
      } finally { a.release(); b.release(); }
    });

    it.each(['index', 'window'] as const)('isolates logger creation failure to %s without retrying it', async channel => {
      await writeQuestion(`diagnostic-constructor-${channel}`);
      const ctor = jest.spyOn(diagnosticLogModule, 'ClaudeTranscriptDiagnosticLog').mockImplementation((path, notify, base) => {
        if (base === `history-${channel}`) throw new URIError('private constructor path');
        return new Log(path, notify, base);
      });
      const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-constructor-${channel}`);
      const a = service.acquireHistoryIndex(conversation, vault), b = service.acquireHistoryIndex(conversation, vault);
      try {
        await Promise.all([a.ready, b.ready]); expect((await b.loadWindow(request)).messages).toHaveLength(1);
        expect(ctor.mock.calls.filter(([, , base]) => base === `history-${channel}`)).toHaveLength(1);
        expect(stateOf(service)).toMatchObject({ channels: {
          [channel]: { status: 'boundary_failed', failureCount: 1 },
          [channel === 'index' ? 'window' : 'index']: { status: 'normal' },
        }, lastDiagnosticFailure: { channel, phase: 'logger_create', errorName: 'URIError' } });
      } finally { a.release(); b.release(); }
    });

    it('isolates sink registration failure without disabling window diagnostics', async () => {
      await writeQuestion('diagnostic-register');
      const mocked = jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex');
      mocked.setTranscriptIndexDiagnosticSink.mockImplementation(() => { throw new TypeError('registration failure'); });
      const service = new ClaudeConversationHistoryService(), lease = service.acquireHistoryIndex(source('diagnostic-register'), vault);
      try {
        await lease.ready; expect((await lease.loadWindow(request)).messages).toHaveLength(1);
        expect(stateOf(service)).toMatchObject({ channels: { index: { status: 'boundary_failed' }, window: { status: 'normal' } },
          lastDiagnosticFailure: { channel: 'index', phase: 'sink_register', errorName: 'TypeError' } });
        expect((await windowEvents()).some(event => event.phase === 'window_complete')).toBe(true);
      } finally { lease.release(); }
    });

    it('does not remove a successor global sink installed reentrantly before record throws', async () => {
      await writeQuestion('diagnostic-reentrant-sink');
      const successor = jest.fn(); let replaced = false;
      jest.spyOn(Log.prototype, 'record').mockImplementation(function (this: ClaudeTranscriptDiagnosticLog, event) {
        if (!replaced && 'buildId' in event) {
          replaced = true; realIndex.setTranscriptIndexDiagnosticSink(successor);
          throw new Error('old binding failure');
        }
        return record.call(this, event);
      });
      const service = new ClaudeConversationHistoryService(), lease = service.acquireHistoryIndex(source('diagnostic-reentrant-sink'), vault);
      try {
        await lease.ready; expect((await lease.loadWindow(request)).messages).toHaveLength(1);
        expect(replaced).toBe(true);
        expect(successor.mock.calls.map(([event]) => event.phase)).toContain('complete');
        expect(stateOf(service).channels.index.status).toBe('boundary_failed');
        expect(jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex').setTranscriptIndexDiagnosticSink)
          .toHaveBeenCalledTimes(1);
      } finally { lease.release(); }
    });

    it.each(['unknown', 'hostile'] as const)('restricts callback and diagnostic error names (%s)', async kind => {
      await writeQuestion(`diagnostic-name-${kind}`);
      const failure = new Error('private body /private/path');
      Object.defineProperty(failure, 'name', kind === 'unknown' ? { value: '/private/secret-name' }
        : { get: () => { throw new Error('private getter body'); } });
      const service = new ClaudeConversationHistoryService(), conversation = source(`diagnostic-name-${kind}`);
      const a = service.acquireHistoryIndex(conversation, vault, () => { throw failure; });
      const b = service.acquireHistoryIndex(conversation, vault);
      try {
        expect(await Promise.allSettled([a.ready, b.ready]))
          .toEqual([{ status: 'rejected', reason: failure }, { status: 'fulfilled', value: undefined }]);
        expect((await windowEvents()).filter(event => event.phase === 'callback_error'))
          .toEqual([expect.objectContaining({ errorName: 'UnknownError' })]);
        jest.spyOn(Log.prototype, 'record').mockImplementation(() => { throw failure; });
        expect((await b.loadWindow(request)).messages).toHaveLength(1);
        const state = stateOf(service);
        expect(state.lastCallback?.errorName).toBe('UnknownError');
        expect(state.lastDiagnosticFailure?.errorName).toBe('UnknownError');
        expect(JSON.stringify(state)).not.toContain('private');
      } finally { a.release(); b.release(); }
    });

    it('returns bounded detached read-only observation without retaining event payloads', async () => {
      await writeQuestion('diagnostic-state-copy');
      const service = new ClaudeConversationHistoryService();
      expect(stateOf(service)).toEqual({
        channels: { index: { status: 'uninitialized', failureCount: 0, suppressedCount: 0, reentrantSuppressedCount: 0, nativeObservationNotEstablishedCount: 0 },
          window: { status: 'uninitialized', failureCount: 0, suppressedCount: 0, reentrantSuppressedCount: 0, nativeObservationNotEstablishedCount: 0 } },
        callbackErrorCount: 0, callbackPostTerminalErrorCount: 0, callbackNativeObservationNotEstablishedCount: 0,
        lastCallback: null, lastDiagnosticFailure: null,
      });
      jest.spyOn(Log.prototype, 'record').mockImplementation(() => { throw new Error('private diagnostic'); });
      const lease = service.acquireHistoryIndex(source('diagnostic-state-copy'), vault);
      try {
        await lease.ready;
        for (let index = 0; index < 50; index++) expect((await lease.loadWindow(request)).messages).toHaveLength(1);
        const state = stateOf(service), serialized = JSON.stringify(state);
        expect(serialized.length).toBeLessThan(700);
        expect(state.channels.window).toMatchObject({ status: 'boundary_failed', failureCount: 1 });
        expect(state.channels.window.suppressedCount).toBeGreaterThanOrEqual(99);
        expect(serialized).not.toContain('private'); expect(serialized).not.toContain(vault);
        // The API is readonly in TypeScript; even a JS caller's mutation must
        // not alter the service's fixed in-process state.
        (state.channels.window as { failureCount: number }).failureCount = 999;
        (state.lastDiagnosticFailure as { errorName: string }).errorName = 'private replacement';
        expect(stateOf(service).channels.window.failureCount).toBe(1);
        expect(stateOf(service).lastDiagnosticFailure!.errorName).toBe('Error');
      } finally { lease.release(); }
    });

    it.each(['persistent', 'rejecting', 'custom-rejecting', 'hostile-then', 'native-hostile-then', 'record-getter', 'constructor-rejecting', 'registration-rejecting'] as const)('settles before deadline, fuses diagnostics and leaves no strict unhandled rejection (%s)', async scenario => {
        const home = join(vault, 'home'), tmp = join(vault, 'tmp');
        await mkdir(home); await mkdir(tmp);
        const script = `
          const assert = require('node:assert/strict');
          const fs = require('node:fs/promises');
          const path = require('node:path');
          const { ClaudeConversationHistoryService } = require(process.argv[1]);
          const diagnostics = require(path.join(path.dirname(process.argv[1]), '../transcript/ClaudeTranscriptDiagnosticLog.ts'));
          const { ClaudeTranscriptDiagnosticLog } = diagnostics;
          (async () => {
            const vault = process.argv[2], scenario = process.argv[3];
            let calls = 0;
            ClaudeTranscriptDiagnosticLog.prototype.record = function () {
              calls++;
              if (scenario === 'rejecting') return Promise.reject(new Error('private rejection'));
              if (scenario === 'custom-rejecting') return { then: (_, reject) => reject(new Error('private thenable')) };
              if (scenario === 'hostile-then') return Object.defineProperty({}, 'then', { get() { throw new Error('private then getter'); } });
              if (scenario === 'native-hostile-then') return Object.defineProperty(Promise.reject(new Error('private native rejection')), 'then', {
                get() { throw new Error('private native then getter'); }
              });
              throw new Error('private persistent failure');
            };
            if (scenario === 'record-getter') Object.defineProperty(ClaudeTranscriptDiagnosticLog.prototype, 'record', {
              configurable: true, get() { calls++; throw new Error('private record getter'); }
            });
            if (scenario === 'constructor-rejecting') diagnostics.ClaudeTranscriptDiagnosticLog = function () {
              calls++; return Promise.reject(new Error('private constructor rejection'));
            };
            if (scenario === 'registration-rejecting') {
              const index = require(path.join(path.dirname(process.argv[1]), 'ClaudeTranscriptHistoryIndex.ts'));
              index.setTranscriptIndexDiagnosticSink = function () {
                calls++; return Promise.reject(new Error('private registration rejection'));
              };
            }
            const service = new ClaudeConversationHistoryService();
            const missing = { id: 'missing', sessionId: 'missing', messages: [] };
            const a = service.acquireHistoryIndex(missing, vault), b = service.acquireHistoryIndex(missing, vault);
            // Leave caller-unobserved ready promises long enough to exercise strict mode.
            await new Promise(resolve => setTimeout(resolve, 40));
            let timer;
            const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline expired')), 250); });
            try { await assert.rejects(Promise.race([a.ready, deadline]), /Conversation transcript is unavailable/); }
            finally { clearTimeout(timer); }
            await assert.rejects(b.ready, /Conversation transcript is unavailable/);
            a.release(); b.release();
            const paths = require(path.join(path.dirname(process.argv[1]), 'sdkSessionPaths.ts'));
            const file = paths.getSDKSessionPath(vault, 'synthetic');
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'synthetic only' } }) + '\\n');
            const healthy = { id: 'healthy', sessionId: 'synthetic', messages: [] };
            const c = service.acquireHistoryIndex(healthy, vault);
            await c.ready;
            const page = await c.loadWindow({ anchorTurn: 0, direction: 'newer', projectionLevel: 'detail',
              budget: { maxTurns: 10, maxSourceBytes: 100000, maxProjectedChars: 100000, timeSliceMs: 0 } });
            assert.equal(page.messages.length, 1); c.release();
            await new Promise(resolve => setTimeout(resolve, 40));
            assert.equal(calls, 2); // once per channel; never retry failed diagnostic bindings
            const state = service.getHistoryDiagnosticState();
            assert.equal(state.channels.window.failureCount, 1);
            assert.equal(state.channels.index.failureCount, 1);
            assert.equal(state.channels.window.status, 'boundary_failed');
            assert.ok(state.channels.window.suppressedCount > 0);
            assert.ok(!JSON.stringify(state).includes('private'));
          })().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
        `;
        const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--require', 'tsx/cjs', '-e', script,
          join(__dirname, '../../../../../src/providers/claude/history/ClaudeConversationHistoryService.ts'), vault, scenario], {
          cwd: join(__dirname, '../../../../..'), env: { ...process.env, HOME: home, TMPDIR: tmp }, encoding: 'utf8', timeout: 15_000,
        });
        expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr })
          .toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
      });
  });

  describe('source and progress ownership contract', () => {
    const request = { anchorTurn: 0, direction: 'newer' as const, budget, projectionLevel: 'detail' as const };

    it.each(['previous', 'current'] as const)('skips an illegal %s id without losing the valid segment', async invalid => {
      await writeQuestion('legal', 'visible');
      jest.mocked(sdkSessionPaths.getSDKSessionPath).mockImplementation((vault, id) =>
        id === 'legal' ? join(fixtureDir, 'legal.jsonl') : realGetSDKSessionPath(vault, id));
      expect(sdkSessionPaths.sdkSessionExists(fixtureDir, '../invalid')).toBe(false);
      const conversation = source(invalid === 'current' ? '../invalid' : 'legal');
      conversation.providerState = { ...conversation.providerState,
        previousProviderSessionIds: [invalid === 'previous' ? '../invalid' : 'legal'] };
      const lease = new ClaudeConversationHistoryService().acquireHistoryIndex(conversation, fixtureDir);
      try {
        await lease.ready;
        expect(lease.totalTurns).toBe(1);
        const page = await lease.loadWindow(request);
        expect(page.messages.map(message => [message.id, message.displayOrder?.[0]]))
          .toEqual([['visible', invalid === 'previous' ? 1 : 0]]);
      } finally { lease.release(); }
    });

    it('releases earlier pins immediately on later stat failure, before explicit release', async () => {
      await writeQuestion('stat-first'); await writeQuestion('stat-second', 'u2');
      const fs = jest.requireActual<typeof fsPromisesModule>('fs/promises');
      const stat = fs.stat;
      const failure = new Error('synthetic later stat failure');
      jest.spyOn(fs, 'stat').mockImplementation(async (...args) => {
        if (args[0] === join(fixtureDir, 'stat-second.jsonl')) throw failure;
        return stat(...args);
      });
      const conversation = source('stat-second');
      conversation.providerState = { ...conversation.providerState, previousProviderSessionIds: ['stat-first'] };
      const lease = new ClaudeConversationHistoryService().acquireHistoryIndex(conversation, fixtureDir);
      try {
        await expect(lease.ready).rejects.toThrow(failure.message);
        realIndex.clearTranscriptIndexCache();
        expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
      } finally { lease.release(); }
    });

    it.each(['queued', 'indexing', 'finalizing'] as const)('isolates A throwing at %s while B remains readable and pinned', async phase => {
      await writeQuestion(`throws-${phase}`);
      const service = new ClaudeConversationHistoryService();
      const conversation = source(`throws-${phase}`);
      const failure = new TypeError(`callback A ${phase}`);
      const a = service.acquireHistoryIndex(conversation, fixtureDir, event => { if (event.phase === phase) throw failure; });
      const progress = jest.fn();
      const b = service.acquireHistoryIndex(conversation, fixtureDir, progress);
      try {
        const results = await Promise.allSettled([a.ready, b.ready]);
        expect(results).toEqual([{ status: 'rejected', reason: failure }, { status: 'fulfilled', value: undefined }]);
        expect(a.totalTurns).toBe(0); expect(a.acquireOutcome).toBeUndefined();
        expect(progress.mock.calls.map(([event]) => event.phase)).toContain(phase);
        const diagnostics = await jest.requireActual<typeof fsPromisesModule>('fs/promises')
          .readFile(join(fixtureDir, '.claudian/diagnostics/history-window.current.jsonl'), 'utf8');
        expect(diagnostics.split('\n').filter(Boolean).map(line => JSON.parse(line)))
          .toContainEqual(expect.objectContaining({ phase: 'callback_error', errorName: 'TypeError' }));
        expect(diagnostics).not.toContain(failure.message);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(1);
        a.release(); a.release();
        expect((await b.loadWindow(request)).messages[0].content).toBe('question-u1');
        await expect(a.search('question')).rejects.toBe(failure);
        await expect(a.loadWindow(request)).rejects.toBe(failure);
        await expect(a.loadMessageDetail('u1', { maxSourceBytes: 100_000 })).rejects.toBe(failure);
        expect(() => a.planWindow(request)).toThrow(failure);
      } finally { a.release(); b.release(); }
      realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
    });

    it.each(['undefined', 'string', 'hostile-name', 'then-getter'] as const)('isolates arbitrary synchronous callback failures (%s)', async kind => {
      await writeQuestion(`arbitrary-error-${kind}`);
      const service = new ClaudeConversationHistoryService(); const conversation = source(`arbitrary-error-${kind}`);
      const failure = kind === 'undefined' ? undefined : kind === 'string' ? 'private callback payload' : new Error('private callback payload');
      if (kind === 'hostile-name') Object.defineProperty(failure, 'name', { get: () => { throw new TypeError('diagnostic metadata failure'); } });
      const a = service.acquireHistoryIndex(conversation, fixtureDir, () => {
        if (kind === 'then-getter') return Object.defineProperty({}, 'then', { get: () => { throw failure; } });
        throw failure;
      });
      const progress = jest.fn(), b = service.acquireHistoryIndex(conversation, fixtureDir, progress);
      try {
        const results = await Promise.allSettled([a.ready, b.ready]);
        expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
        expect((results[0] as PromiseRejectedResult).reason).toBe(failure);
        expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(['queued', 'indexing', 'finalizing']);
        a.release(); expect((await b.loadWindow(request)).messages).toHaveLength(1);
      } finally { a.release(); b.release(); }
    });

    it('rejects reads already awaiting A ready with A original error while B succeeds', async () => {
      await writeQuestion('early-failed-reads');
      const service = new ClaudeConversationHistoryService(); const conversation = source('early-failed-reads');
      const failure = new TypeError('early callback failure');
      const a = service.acquireHistoryIndex(conversation, fixtureDir, () => { throw failure; });
      const b = service.acquireHistoryIndex(conversation, fixtureDir);
      const operations = Promise.allSettled([a.ready, a.search('question'), a.loadWindow(request),
        a.loadMessageDetail('u1', { maxSourceBytes: 100_000 }), b.ready]);
      try {
        expect(await operations).toEqual([
          ...Array.from({ length: 4 }, () => ({ status: 'rejected', reason: failure })),
          { status: 'fulfilled', value: undefined },
        ]);
        expect(b.totalTurns).toBe(1);
      } finally { a.release(); b.release(); }
    });

    it('delivers shared progress to B when A has no callback', async () => {
      await writeQuestion('later-progress');
      const service = new ClaudeConversationHistoryService();
      const conversation = source('later-progress');
      const a = service.acquireHistoryIndex(conversation, fixtureDir);
      const progress = jest.fn(); const b = service.acquireHistoryIndex(conversation, fixtureDir, progress);
      try {
        expect(progress).not.toHaveBeenCalled();
        expect(a.ready).not.toBe(b.ready);
        await Promise.all([a.ready, b.ready]);
        expect(progress.mock.calls.map(([event]) => event.phase)).toEqual(['queued', 'indexing', 'finalizing']);
        expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
      } finally { a.release(); b.release(); }
    });

    it('freezes missing and repeated slots without compressing ordinals or resolving paths again', async () => {
      await writeQuestion('ordinal-repeat', 'repeat'); await writeQuestion('ordinal-current', 'current');
      const conversation = source('ordinal-current');
      conversation.providerState = { ...conversation.providerState,
        previousProviderSessionIds: ['missing-slot', 'ordinal-repeat', 'ordinal-repeat'] };
      const service = new ClaudeConversationHistoryService();
      const getPath = jest.mocked(sdkSessionPaths.getSDKSessionPath);
      const lease = service.acquireHistoryIndex(conversation, fixtureDir, event => {
        if (event.phase !== 'queued') return;
        // Existence is checked at execution, not frozen at acquire.
        appendFileSync(join(fixtureDir, 'missing-slot.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'appeared', message: { content: 'appeared' } })}\n`);
        conversation.providerState = { providerSessionId: 'changed' };
        getPath.mockImplementation(() => { throw new Error('must not resolve again'); });
      });
      try {
        await lease.ready;
        expect(lease.totalTurns).toBe(4);
        expect(getPath).toHaveBeenCalledTimes(4);
        expect(mockBuildTranscriptIndex.mock.calls.map(([file]) => file)).toEqual([
          'missing-slot', 'ordinal-repeat', 'ordinal-repeat', 'ordinal-current',
        ].map(session => join(fixtureDir, `${session}.jsonl`)));
        const page = await lease.loadWindow(request);
        // Repeated UUIDs keep the existing projection dedupe, but both segments
        // remain in the turn index and each received a separate pin.
        expect(page.messages.map(message => [message.id, message.displayOrder?.[0]]))
          .toEqual([['appeared', 0], ['repeat', 1], ['current', 3]]);
        expect(jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex').protectTranscriptIndex)
          .toHaveBeenCalledTimes(4);
      } finally { lease.release(); }
    });

    it('preserves skipped missing ordinals and applies resume to every duplicate current id', async () => {
      const rows = [
        { type: 'user', uuid: 'first', message: { content: 'first' } },
        { type: 'assistant', uuid: 'anchor', parentUuid: 'first', message: { content: 'anchor' } },
        { type: 'user', uuid: 'second', parentUuid: 'anchor', message: { content: 'second' } },
      ];
      await writeFile(join(fixtureDir, 'duplicate-current.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      const conversation = source('duplicate-current');
      conversation.resumeAtMessageId = 'anchor';
      conversation.providerState = { ...conversation.providerState, previousProviderSessionIds: ['missing-stays-missing', 'duplicate-current'] };
      const lease = new ClaudeConversationHistoryService().acquireHistoryIndex(conversation, fixtureDir);
      try {
        await lease.ready; expect(lease.totalTurns).toBe(2);
        expect(mockBuildTranscriptIndex.mock.calls.map(([, options]) => options?.resumeAtMessageId)).toEqual(['anchor', 'anchor']);
        const page = await lease.loadWindow(request);
        expect(page.messages.map(message => [message.id, message.displayOrder?.[0]])).toEqual([['first', 1], ['anchor', 1]]);
      } finally { lease.release(); }
    });

    it.each(['no-current', 'all-illegal', 'all-missing'] as const)('retains the legacy unavailable error for %s', async scenario => {
      const conversation = source(scenario === 'all-illegal' ? '../invalid' : 'not-there');
      if (scenario === 'no-current') { conversation.sessionId = null; conversation.providerState = { previousProviderSessionIds: ['old'] }; }
      if (scenario === 'all-illegal') jest.mocked(sdkSessionPaths.getSDKSessionPath).mockImplementation(realGetSDKSessionPath);
      const lease = new ClaudeConversationHistoryService().acquireHistoryIndex(conversation, fixtureDir);
      try { await expect(lease.ready).rejects.toThrow(scenario === 'no-current'
        ? 'Conversation has no Claude session' : 'Conversation transcript is unavailable'); }
      finally { lease.release(); }
    });

    it.each(['self', 'other', 'self-then-throw'] as const)('rechecks dispatch membership after reentrant release (%s)', async action => {
      await writeQuestion(`reentrant-release-${action}`);
      const service = new ClaudeConversationHistoryService(); const conversation = source(`reentrant-release-${action}`);
      const aProgress: string[] = [], bProgress = jest.fn();
      const a = service.acquireHistoryIndex(conversation, fixtureDir, event => {
        aProgress.push(event.phase);
        if (event.phase !== 'queued') return;
        (action === 'other' ? b : a).release();
        if (action === 'self-then-throw') throw new TypeError('must not replace cancellation');
      });
      const b = service.acquireHistoryIndex(conversation, fixtureDir, bProgress);
      try {
        const results = await Promise.allSettled([a.ready, b.ready]);
        const releasedIndex = action === 'other' ? 1 : 0;
        expect(results[releasedIndex]).toMatchObject({ status: 'rejected', reason: new Error('History index build aborted') });
        expect(results[1 - releasedIndex]).toEqual({ status: 'fulfilled', value: undefined });
        expect(aProgress).toEqual(action === 'other' ? ['queued', 'indexing', 'finalizing'] : ['queued']);
        expect(bProgress.mock.calls.map(([event]) => event.phase)).toEqual(action === 'other' ? [] : ['queued', 'indexing', 'finalizing']);
        (action === 'other' ? b : a).release();
        expect((await (action === 'other' ? a : b).loadWindow(request)).messages).toHaveLength(1);
      } finally { a.release(); b.release(); }
    });

    it('excludes a reentrant C from the current round and isolates each progress argument', async () => {
      await writeQuestion('reentrant-subscribe');
      const service = new ClaudeConversationHistoryService(); const conversation = source('reentrant-subscribe');
      const bProgress = jest.fn(), cProgress = jest.fn(); let c: HistoryIndexLease | undefined;
      const a = service.acquireHistoryIndex(conversation, fixtureDir, event => {
        if (event.phase === 'queued') c = service.acquireHistoryIndex(conversation, fixtureDir, cProgress);
        // A is permitted to mutate its own argument, not any other subscriber's.
        (event as { phase: string; percent?: number }).phase = 'loading';
        (event as { percent?: number }).percent = -1;
      });
      const b = service.acquireHistoryIndex(conversation, fixtureDir, bProgress);
      try {
        await Promise.all([a.ready, b.ready]); await c!.ready;
        expect(bProgress.mock.calls.map(([event]) => event)).toEqual([
          { phase: 'queued' }, { phase: 'indexing', percent: 100 }, { phase: 'finalizing' },
        ]);
        expect(cProgress.mock.calls.map(([event]) => event.phase)).toEqual(['indexing', 'finalizing']);
        expect(bProgress.mock.calls[1][0]).not.toBe(cProgress.mock.calls[0][0]);
        expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
      } finally { a.release(); b.release(); c?.release(); }
    });

    it('treats two acquires of the same callback as independent subscriptions', async () => {
      await writeQuestion('same-callback');
      const service = new ClaudeConversationHistoryService(); const conversation = source('same-callback');
      const callback = jest.fn();
      const a = service.acquireHistoryIndex(conversation, fixtureDir, callback);
      const b = service.acquireHistoryIndex(conversation, fixtureDir, callback);
      try {
        await Promise.all([a.ready, b.ready]);
        expect(callback.mock.calls.map(([event]) => event.phase)).toEqual(['queued', 'queued', 'indexing', 'indexing', 'finalizing', 'finalizing']);
        expect(callback.mock.calls[0][0]).not.toBe(callback.mock.calls[1][0]);
        expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
      } finally { a.release(); b.release(); }
    });

    it('retains per-segment progress and multiple finalizing events', async () => {
      await writeQuestion('progress-first'); await writeQuestion('progress-last', 'u2');
      const conversation = source('progress-last');
      conversation.providerState = { ...conversation.providerState, previousProviderSessionIds: ['progress-first'] };
      const progress = jest.fn();
      const lease = new ClaudeConversationHistoryService().acquireHistoryIndex(conversation, fixtureDir, progress);
      try {
        await lease.ready;
        expect(progress.mock.calls.map(([event]) => event)).toEqual([
          { phase: 'queued' }, { phase: 'indexing', percent: 100 }, { phase: 'finalizing' },
          { phase: 'indexing', percent: 100 }, { phase: 'finalizing' },
        ]);
      } finally { lease.release(); }
    });

    it('subscribes late without replay and subscribes after completion without fabricated progress', async () => {
      await writeQuestion('late-subscriber');
      const service = new ClaudeConversationHistoryService(); const conversation = source('late-subscriber');
      let late: HistoryIndexLease | undefined, completed: HistoryIndexLease | undefined;
      const lateProgress = jest.fn(), completedProgress = jest.fn();
      const a = service.acquireHistoryIndex(conversation, fixtureDir, event => {
        if (event.phase === 'indexing' && !late) late = service.acquireHistoryIndex(conversation, fixtureDir, lateProgress);
      });
      try {
        await a.ready; await late!.ready;
        expect(lateProgress.mock.calls.map(([event]) => event.phase)).toEqual(['finalizing']);
        completed = service.acquireHistoryIndex(conversation, fixtureDir, completedProgress);
        await completed.ready;
        expect(completed.acquireOutcome).toBe(a.acquireOutcome);
        expect(completedProgress).not.toHaveBeenCalled();
        expect((await completed.loadWindow(request)).messages).toHaveLength(1);
        expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
      } finally { a.release(); late?.release(); completed?.release(); }
    });

    it('cancels the last lease before build without IO or callbacks and permits same-tick retry', async () => {
      await writeQuestion('cancel-before-start');
      const service = new ClaudeConversationHistoryService(); const conversation = source('cancel-before-start');
      const progress = jest.fn();
      const cancelled = service.acquireHistoryIndex(conversation, fixtureDir, progress);
      cancelled.release();
      const retry = service.acquireHistoryIndex(conversation, fixtureDir);
      try {
        await expect(cancelled.ready).rejects.toThrow('History index build aborted');
        await retry.ready;
        expect(progress).not.toHaveBeenCalled(); expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
      } finally { cancelled.release(); retry.release(); }
    });

    it('auto-releases a sole failing callback and permits a reentrant same-source retry', async () => {
      await writeQuestion('failed-callback-retry');
      const service = new ClaudeConversationHistoryService(); const conversation = source('failed-callback-retry');
      const failure = new Error('callback failed');
      const failed = service.acquireHistoryIndex(conversation, fixtureDir, () => { throw failure; });
      let retry: HistoryIndexLease | undefined;
      try {
        await expect(failed.ready).rejects.toBe(failure);
        retry = service.acquireHistoryIndex(conversation, fixtureDir); await retry.ready;
        failed.release();
        const shared = service.acquireHistoryIndex(conversation, fixtureDir);
        try { await shared.ready; expect(shared.totalTurns).toBe(1); }
        finally { shared.release(); }
        expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
      } finally { failed.release(); retry?.release(); }
    });

    it('uses each lease ready and checks validity again after awaiting it', async () => {
      await writeQuestion('method-eligibility');
      const service = new ClaudeConversationHistoryService(); const conversation = source('method-eligibility');
      const a = service.acquireHistoryIndex(conversation, fixtureDir);
      const b = service.acquireHistoryIndex(conversation, fixtureDir);
      expect(() => a.planWindow(request)).toThrow('History index is not ready for window planning');
      const earlySearch = a.search('question'), earlyWindow = a.loadWindow(request);
      const earlyDetail = a.loadMessageDetail('u1', { maxSourceBytes: 100_000 });
      const operations = Promise.allSettled([earlySearch, earlyWindow, earlyDetail]);
      a.release();
      try {
        expect(await operations).toEqual(Array.from({ length: 3 }, () => ({ status: 'rejected', reason: new Error('History index build aborted') })));
        await b.ready;
        expect(b.planWindow(request)).toEqual({ start: 0, end: 1 });
        await expect(b.search('question')).resolves.toHaveLength(1);
        await expect(b.loadMessageDetail('u1', { maxSourceBytes: 100_000 })).resolves.toMatchObject({ status: 'exact' });
        const readyPromise = b.ready;
        const pending = b.search('question'); b.release();
        await expect(pending).rejects.toThrow('History index build aborted');
        await expect(readyPromise).resolves.toBeUndefined();
        expect(b.acquireOutcome).toBe('rebuilt');
        await expect(b.search('question')).rejects.toThrow('History index build aborted');
        await expect(b.loadWindow(request)).rejects.toThrow('History index build aborted');
        await expect(b.loadMessageDetail('u1', { maxSourceBytes: 100_000 })).rejects.toThrow('History index build aborted');
        expect(() => b.planWindow(request)).toThrow('History index build aborted');
      } finally { a.release(); b.release(); }
    });

    it('revokes and removes the last instance before a queued callback reacquires then throws', async () => {
      await writeQuestion('reentrant-last-retry');
      const service = new ClaudeConversationHistoryService(); const conversation = source('reentrant-last-retry');
      let c: HistoryIndexLease | undefined;
      const progress = jest.fn((event: HistoryLoadProgress) => {
        if (event.phase !== 'queued') return;
        a.release();
        c = service.acquireHistoryIndex(conversation, fixtureDir);
        throw new Error('must not replace release or cancel C');
      });
      const a = service.acquireHistoryIndex(conversation, fixtureDir, progress);
      try {
        await expect(a.ready).rejects.toThrow('History index build aborted');
        await c!.ready; a.release();
        expect((await c!.loadWindow(request)).messages).toHaveLength(1);
        expect(progress).toHaveBeenCalledTimes(1);
        expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
      } finally { a.release(); c?.release(); }
    });

    it('releases acquired pins on last exit during a later segment stat and ignores late IO', async () => {
      await writeQuestion('cancel-build-first'); await writeQuestion('cancel-build-second', 'u2');
      const fs = jest.requireActual<typeof fsPromisesModule>('fs/promises'); const stat = fs.stat;
      let resume!: () => void, entered!: () => void, drained!: () => void;
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const blocked = new Promise<void>(resolve => { entered = resolve; });
      const completed = new Promise<void>(resolve => { drained = resolve; });
      let paused = false;
      jest.spyOn(fs, 'stat').mockImplementation(async (...args) => {
        if (!paused && args[0] === join(fixtureDir, 'cancel-build-second.jsonl')) {
          paused = true; entered(); await gate;
        }
        return stat(...args);
      });
      mockBuildTranscriptIndex.mockImplementation(async (file, options) => {
        const result = await realIndex.buildTranscriptIndex(file, options);
        if (file === join(fixtureDir, 'cancel-build-second.jsonl')) drained();
        return result;
      });
      const conversation = source('cancel-build-second');
      conversation.providerState = { ...conversation.providerState, previousProviderSessionIds: ['cancel-build-first'] };
      const lease = new ClaudeConversationHistoryService().acquireHistoryIndex(conversation, fixtureDir);
      try {
        await blocked;
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(1);
        lease.release();
        await expect(lease.ready).rejects.toThrow('History index build aborted');
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
        resume(); await completed;
        await new Promise<void>(resolve => setImmediate(resolve));
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
        const mocked = jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex');
        expect(mocked.protectTranscriptIndex).toHaveBeenCalledTimes(1);
        expect(mocked.releaseTranscriptIndex).toHaveBeenCalledTimes(1);
      } finally { resume(); lease.release(); }
    });

    it('rejects all source-failure leases, auto-unpins the prefix, and retries through real IO', async () => {
      await writeQuestion('retry-first'); await writeQuestion('retry-second', 'u2');
      const fs = jest.requireActual<typeof fsPromisesModule>('fs/promises'); const stat = fs.stat;
      let fail = true;
      jest.spyOn(fs, 'stat').mockImplementation(async (...args) => {
        if (fail && args[0] === join(fixtureDir, 'retry-second.jsonl')) { fail = false; throw new Error('one-shot stat failure'); }
        return stat(...args);
      });
      const service = new ClaudeConversationHistoryService(); const conversation = source('retry-second');
      conversation.providerState = { ...conversation.providerState, previousProviderSessionIds: ['retry-first'] };
      const a = service.acquireHistoryIndex(conversation, fixtureDir), b = service.acquireHistoryIndex(conversation, fixtureDir);
      let retry: HistoryIndexLease | undefined;
      try {
        const results = await Promise.allSettled([a.ready, b.ready]);
        expect(results).toEqual(Array.from({ length: 2 }, () => ({ status: 'rejected', reason: new Error('one-shot stat failure') })));
        const failures = results as PromiseRejectedResult[];
        expect(failures[0].reason).toBe(failures[1].reason);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
        await expect(a.loadWindow(request)).rejects.toThrow('one-shot stat failure');
        a.release(); b.release();
        await expect(b.search('question')).rejects.toThrow('one-shot stat failure');
        retry = service.acquireHistoryIndex(conversation, fixtureDir); await retry.ready;
        expect(retry.totalTurns).toBe(2);
        expect((await retry.loadWindow(request)).messages.map(message => message.id)).toEqual(['u1', 'u2']);
      } finally { a.release(); b.release(); retry?.release(); }
    });

    it.each(['success', 'failure', 'release'] as const)('preserves A prime through old A late %s in source ABA', async outcome => {
      await writeQuestion(`late-aba-a-${outcome}`, 'a'); await writeQuestion(`late-aba-b-${outcome}`, 'b');
      const fs = jest.requireActual<typeof fsPromisesModule>('fs/promises'); const stat = fs.stat;
      let resume!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { resume = resolve; }), blocked = new Promise<void>(resolve => { entered = resolve; });
      let paused = false;
      jest.spyOn(fs, 'stat').mockImplementation(async (...args) => {
        const info = await stat(...args);
        if (!paused && args[0] === join(fixtureDir, `late-aba-a-${outcome}.jsonl`)) {
          paused = true; entered(); await gate;
          if (outcome === 'failure') throw new Error('old A late stat failure');
        }
        return info;
      });
      const service = new ClaudeConversationHistoryService();
      const old = service.acquireHistoryIndex(source(`late-aba-a-${outcome}`), fixtureDir);
      let middle: HistoryIndexLease | undefined, returning: HistoryIndexLease | undefined, follower: HistoryIndexLease | undefined;
      try {
        await blocked;
        middle = service.acquireHistoryIndex(source(`late-aba-b-${outcome}`), fixtureDir);
        returning = service.acquireHistoryIndex(source(`late-aba-a-${outcome}`), fixtureDir, undefined, true);
        await Promise.all([middle.ready, returning.ready]);
        if (outcome === 'release') old.release();
        resume();
        const settlement = await Promise.allSettled([old.ready]);
        expect(settlement).toEqual(outcome === 'success' ? [{ status: 'fulfilled', value: undefined }]
          : [{ status: 'rejected', reason: new Error(outcome === 'failure' ? 'old A late stat failure' : 'History index build aborted') }]);
        old.release(); old.release(); middle.release();
        follower = service.acquireHistoryIndex(source(`late-aba-a-${outcome}`), fixtureDir);
        await follower.ready;
        expect((await follower.loadWindow(request)).messages.map(message => message.id)).toEqual(['a']);
        expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(3);
        realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(1);
      } finally { resume(); old.release(); middle?.release(); returning?.release(); follower?.release(); }
      await new Promise<void>(resolve => setImmediate(resolve));
      realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
    });

    it.each(['window', 'detail'] as const)('cannot deliver an already-started %s read after release', async method => {
      await writeQuestion(`read-release-${method}`);
      const service = new ClaudeConversationHistoryService(); const conversation = source(`read-release-${method}`);
      const a = service.acquireHistoryIndex(conversation, fixtureDir), b = service.acquireHistoryIndex(conversation, fixtureDir);
      let resume!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { resume = resolve; }), opened = new Promise<void>(resolve => { entered = resolve; });
      try {
        await Promise.all([a.ready, b.ready]);
        const fs = jest.requireActual<typeof fsPromisesModule>('fs/promises'); const open = fs.open;
        let paused = false;
        jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (!paused && args[0] === join(fixtureDir, `read-release-${method}.jsonl`)) { paused = true; entered(); await gate; }
          return handle;
        });
        const operation = method === 'window' ? a.loadWindow(request) : a.loadMessageDetail('u1', { maxSourceBytes: 100_000 });
        const observed = Promise.allSettled([operation]);
        await opened; a.release(); resume();
        expect(await observed).toEqual([{ status: 'rejected', reason: new Error('History index build aborted') }]);
        expect((await b.loadWindow(request)).messages).toHaveLength(1);
      } finally { resume(); a.release(); b.release(); }
    });

    it.each(['resolve', 'reject', 'custom-reject'] as const)('explicitly rejects an unsupported %s thenable without affecting B', async kind => {
      await writeQuestion(`thenable-${kind}`);
      const service = new ClaudeConversationHistoryService(); const conversation = source(`thenable-${kind}`);
      const callback = jest.fn((event: HistoryLoadProgress) => {
        if (event.phase !== 'queued') return;
        if (kind === 'custom-reject') return { then: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('thenable rejection')) };
        return kind === 'resolve' ? Promise.resolve() : Promise.reject(new Error('async callback rejection'));
      });
      const a = service.acquireHistoryIndex(conversation, fixtureDir, callback);
      const b = service.acquireHistoryIndex(conversation, fixtureDir);
      try {
        await expect(a.ready).rejects.toThrow('History progress callbacks must be synchronous');
        await b.ready; expect(b.totalTurns).toBe(1); expect(callback).toHaveBeenCalledTimes(1);
      } finally { a.release(); b.release(); }
    });

    it.each(['release', 'source', 'throw', 'resolve', 'reject', 'custom-reject'] as const)('observes unawaited ready and thenables under strict Node rejection mode (%s)', async scenario => {
      const home = join(fixtureDir, `strict-home-${scenario}`), tmp = join(fixtureDir, `strict-tmp-${scenario}`);
      await mkdir(home, { recursive: true }); await mkdir(tmp, { recursive: true });
      const script = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs/promises');
        const path = require('node:path');
        const { ClaudeConversationHistoryService } = require(process.argv[1]);
        const paths = require(path.join(path.dirname(process.argv[1]), 'sdkSessionPaths.ts'));
        (async () => {
          const vault = process.argv[2], scenario = process.argv[3];
          const file = paths.getSDKSessionPath(vault, 'synthetic');
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, JSON.stringify({ type: 'user', uuid: 'strict-u', message: { content: 'synthetic only' } }) + '\\n');
          const conversation = { id: 'strict-c', sessionId: scenario === 'source' ? 'missing' : 'synthetic', messages: [] };
          const service = new ClaudeConversationHistoryService();
          const callback = scenario === 'throw' ? () => { throw new TypeError('strict callback'); }
            : scenario === 'resolve' ? () => Promise.resolve()
            : scenario === 'reject' ? () => Promise.reject(new Error('strict async rejection'))
            : scenario === 'custom-reject' ? () => ({ then: (_, reject) => reject(new Error('strict thenable')) })
            : undefined;
          const a = service.acquireHistoryIndex(conversation, vault, callback);
          let b;
          if (scenario === 'release') a.release();
          if (callback) b = service.acquireHistoryIndex(conversation, vault);
          // No observer from the caller until after rejection would have fired.
          await new Promise(resolve => setTimeout(resolve, 80));
          await assert.rejects(a.ready, scenario === 'release' ? /History index build aborted/
            : scenario === 'source' ? /Conversation transcript is unavailable/
            : scenario === 'throw' ? /strict callback/ : /History progress callbacks must be synchronous/);
          if (b) { await b.ready; assert.equal(b.totalTurns, 1); b.release(); }
          a.release();
        })().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
      `;
      const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--require', 'tsx/cjs', '-e', script,
        join(__dirname, '../../../../../src/providers/claude/history/ClaudeConversationHistoryService.ts'), fixtureDir, scenario], {
        cwd: join(__dirname, '../../../../..'), env: { ...process.env, HOME: home, TMPDIR: tmp }, encoding: 'utf8', timeout: 15_000,
      });
      expect({ status: child.status, signal: child.signal, error: child.error, stderr: child.stderr })
        .toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
    });

    it('revokes A before queued and cannot invoke its stale throwing callback', async () => {
      await writeQuestion('release-before-queued');
      const service = new ClaudeConversationHistoryService(); const conversation = source('release-before-queued');
      const callback = jest.fn(() => { throw new Error('released callback invoked'); });
      const a = service.acquireHistoryIndex(conversation, fixtureDir, callback);
      const b = service.acquireHistoryIndex(conversation, fixtureDir);
      void b.ready.catch(() => undefined);
      a.release(); a.release();
      try {
        await expect(a.ready).rejects.toThrow('History index build aborted');
        await expect(b.ready).resolves.toBeUndefined();
        expect(callback).not.toHaveBeenCalled(); expect(b.totalTurns).toBe(1);
      } finally { b.release(); }
    });
  });

  it.each(['session', 'chain', 'anchor', 'vault'] as const)('replaces same-id lookup when its immutable source changes (%s)', async change => {
    const oldConversation = source('descriptor-a');
    const nextConversation = source('descriptor-b');
    let oldVault = fixtureDir, nextVault = fixtureDir;
    let oldIds = ['a'], nextIds = ['b'];
    await writeQuestion('descriptor-a', 'a'); await writeQuestion('descriptor-b', 'b'); await writeQuestion('descriptor-c', 'c');
    if (change === 'chain') {
      oldConversation.providerState = { providerSessionId: 'descriptor-b', previousProviderSessionIds: ['descriptor-a'] };
      nextConversation.providerState = { providerSessionId: 'descriptor-b', previousProviderSessionIds: ['descriptor-c'] };
      oldIds = ['a', 'b']; nextIds = ['c', 'b'];
    }
    if (change === 'anchor') {
      const rows = [
        { type: 'user', uuid: 'u1', message: { content: 'first' } },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'answer first' } },
        { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'second' } },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'answer second' } },
      ];
      await writeFile(join(fixtureDir, 'descriptor-a.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      oldConversation.providerState = { providerSessionId: 'descriptor-a', forkSource: { sessionId: 'descriptor-a', resumeAt: 'a1' } };
      nextConversation.providerState = { providerSessionId: 'descriptor-a', forkSource: { sessionId: 'descriptor-a', resumeAt: 'a2' } };
      oldIds = ['u1', 'a1']; nextIds = ['u1', 'a1', 'u2', 'a2'];
    }
    if (change === 'vault') {
      oldVault = join(fixtureDir, 'vault-a'); nextVault = join(fixtureDir, 'vault-b');
      await mkdir(oldVault, { recursive: true }); await mkdir(nextVault, { recursive: true });
      await writeFile(join(oldVault, 'descriptor-a.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'a', message: { content: 'vault a' } })}\n`);
      await writeFile(join(nextVault, 'descriptor-a.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'b', message: { content: 'vault b' } })}\n`);
      nextConversation.providerState = oldConversation.providerState;
      jest.mocked(sdkSessionPaths.getSDKSessionPath).mockImplementation((vault, id) => join(vault, `${id}.jsonl`));
    }
    const service = new ClaudeConversationHistoryService();
    const old = service.acquireHistoryIndex(oldConversation, oldVault);
    let next: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    try {
      await old.ready;
      next = service.acquireHistoryIndex(nextConversation, nextVault);
      await next.ready;
      const oldPage = await old.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      const nextPage = await next.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect({ oldIds: oldPage.messages.map(message => message.id), nextIds: nextPage.messages.map(message => message.id) })
        .toEqual({ oldIds, nextIds });
    } finally { old.release(); next?.release(); }
  });

  it('builds only from the paths and chain captured before queued callbacks mutate the source', async () => {
    const oldRoot = join(fixtureDir, 'captured-old'), newRoot = join(fixtureDir, 'captured-new');
    await mkdir(oldRoot, { recursive: true }); await mkdir(newRoot, { recursive: true });
    for (const [root, session, uuid] of [
      [oldRoot, 'prev', 'old-prev'], [oldRoot, 'cur', 'old-cur'],
      [newRoot, 'prev', 'new-prev'], [newRoot, 'cur', 'new-cur'],
      [newRoot, 'other', 'new-prev'], [newRoot, 'other-cur', 'new-cur'],
    ]) await writeFile(join(root, `${session}.jsonl`), `${JSON.stringify({ type: 'user', uuid, message: { content: uuid } })}\n`);
    const getPath = jest.mocked(sdkSessionPaths.getSDKSessionPath);
    getPath.mockImplementation((_vault, id) => join(oldRoot, `${id}.jsonl`));
    const conversation = source('cur');
    conversation.providerState = { providerSessionId: 'cur', previousProviderSessionIds: ['prev'] };
    const service = new ClaudeConversationHistoryService();
    const old = service.acquireHistoryIndex(conversation, fixtureDir, event => {
      if (event.phase !== 'queued') return;
      conversation.providerState = { providerSessionId: 'other-cur', previousProviderSessionIds: ['other'] };
      getPath.mockImplementation((_vault, id) => join(newRoot, `${id}.jsonl`));
    });
    let next: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    try {
      await old.ready;
      next = service.acquireHistoryIndex(conversation, fixtureDir);
      await next.ready;
      const oldPage = await old.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      const nextPage = await next.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect({ old: oldPage.messages.map(message => message.id), next: nextPage.messages.map(message => message.id) })
        .toEqual({ old: ['old-prev', 'old-cur'], next: ['new-prev', 'new-cur'] });
    } finally { old.release(); next?.release(); }
  });

  it.each(['ctime', 'resume'] as const)('distinguishes page identity when only %s changes for the same range', async dimension => {
    const session = `page-${dimension}`;
    const path = join(fixtureDir, `${session}.jsonl`);
    const rows = [
      { type: 'user', uuid: 'u1', message: { content: 'AA' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { content: 'first answer' } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'second' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { content: 'second answer' } },
    ];
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const fs = await import('fs/promises');
    await fs.utimes(path, 1_700_000_000, 1_700_000_000);
    const before = await fs.stat(path);
    const conversation = source(session);
    conversation.resumeAtMessageId = 'a1';
    const service = new ClaudeConversationHistoryService();
    const old = service.acquireHistoryIndex(conversation, fixtureDir);
    let next: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    const request = { anchorTurn: 0, direction: 'newer' as const, budget: { ...budget, maxTurns: 1 }, projectionLevel: 'detail' as const };
    try {
      await old.ready;
      const oldPage = await old.loadWindow(request);
      if (dimension === 'ctime') {
        rows[0].message.content = 'BB';
        await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        await fs.utimes(path, 1_700_000_000, 1_700_000_000);
      } else conversation.resumeAtMessageId = 'a2';
      const after = await fs.stat(path);
      next = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
      await next.ready;
      const nextPage = await next.loadWindow(request);
      expect({ size: after.size, mtime: after.mtimeMs, range: nextPage.range })
        .toEqual({ size: before.size, mtime: before.mtimeMs, range: oldPage.range });
      expect(nextPage.pageKey).not.toBe(oldPage.pageKey);
    } finally { old.release(); next?.release(); }
  });

  it('distinguishes identical S+P pages with different real coverage C', async () => {
    const fs = jest.requireActual<typeof fsPromisesModule>('fs/promises');
    const workers = jest.requireActual<typeof workerThreadsModule>('worker_threads');
    const path = join(fixtureDir, 'coverage.jsonl');
    const firstRow = `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'first' } })}\n`;
    const secondRow = `${JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: 'second' } })}\n`;
    await writeFile(path, firstRow);
    const stat = fs.stat, open = fs.open;
    let firstStat = true, firstOpen = true;
    const statSpy = jest.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      const info = await stat(...args);
      if (args[0] === path && firstStat) { firstStat = false; await fs.appendFile(path, secondRow); }
      return info;
    });
    const probeSpy = jest.spyOn(workers, 'Worker').mockImplementation(() => { throw new TypeError('controlled renderer fallback'); });
    realIndex.resetTranscriptIndexWorkerProbe();
    const service = new ClaudeConversationHistoryService();
    const conversation = source('coverage');
    let owner: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    const openSpy = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === path && firstOpen) {
        firstOpen = false;
        const read = handle.read.bind(handle);
        let reads = 0;
        handle.read = async (...readArgs: any[]) => {
          if (reads++ === 0) return (read as any)(readArgs[0], readArgs[1], Math.min(readArgs[2], firstRow.length), readArgs[3]);
          await owner!.ready;
          await fs.truncate(path, Buffer.byteLength(firstRow));
          return (read as any)(...readArgs);
        };
      }
      return handle;
    });
    const indexes: historyIndexModule.TranscriptHistoryIndex[] = [];
    mockBuildTranscriptIndex.mockImplementation((file, options = {}) => realIndex.buildTranscriptIndex(file, {
      ...options, onIndex: index => { indexes.push(index); options.onIndex?.(index); },
    }));
    const partial = service.acquireHistoryIndex(conversation, fixtureDir, event => {
      if (event.phase !== 'indexing' || owner) return;
      probeSpy.mockRestore(); realIndex.resetTranscriptIndexWorkerProbe();
      owner = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
    });
    try {
      await partial.ready; await owner!.ready;
      // Both scanners froze the same metadata before the controlled truncate.
      // Restore identical bytes only to materialize the already indexed ranges;
      // this test does not assert atomic content-snapshot behavior.
      await writeFile(path, firstRow + secondRow);
      const request = { anchorTurn: 0, direction: 'newer' as const, budget: { ...budget, maxTurns: 1 }, projectionLevel: 'detail' as const };
      const partialPage = await partial.loadWindow(request), fullPage = await owner!.loadWindow(request);
      const metadata = (index: historyIndexModule.TranscriptHistoryIndex) =>
        [index.filePath, index.dev, index.ino, index.snapshotSize, index.mtimeMs, index.ctimeMs];
      expect(indexes).toHaveLength(2);
      expect(metadata(indexes[0])).toEqual(metadata(indexes[1]));
      expect({ partialTurns: partial.totalTurns, fullTurns: owner!.totalTurns, partialOffset: partialPage.snapshotOffset,
        fullOffset: fullPage.snapshotOffset, partialRange: partialPage.range, fullRange: fullPage.range })
        .toEqual({ partialTurns: 1, fullTurns: 2, partialOffset: Buffer.byteLength(firstRow),
          fullOffset: Buffer.byteLength(firstRow + secondRow), partialRange: { start: 0, end: 1 }, fullRange: { start: 0, end: 1 } });
      expect(partialPage.pageKey).not.toBe(fullPage.pageKey);
    } finally {
      partial.release(); owner?.release(); statSpy.mockRestore(); openSpy.mockRestore(); probeSpy.mockRestore();
      realIndex.resetTranscriptIndexWorkerProbe();
    }
  });

  it('handles source lookup ABA without releasing the returning source instance', async () => {
    await writeQuestion('source-aba-a', 'a'); await writeQuestion('source-aba-b', 'b');
    const service = new ClaudeConversationHistoryService();
    const original = service.acquireHistoryIndex(source('source-aba-a'), fixtureDir);
    let middle: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    let returning: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    let shared: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    try {
      await original.ready;
      middle = service.acquireHistoryIndex(source('source-aba-b'), fixtureDir); await middle.ready;
      returning = service.acquireHistoryIndex(source('source-aba-a'), fixtureDir); await returning.ready;
      original.release(); middle.release();
      shared = service.acquireHistoryIndex(source('source-aba-a'), fixtureDir); await shared.ready;
      const page = await shared.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(page.messages.map(message => message.id)).toEqual(['a']);
      expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(3);
      realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(1);
    } finally { original.release(); middle?.release(); returning?.release(); shared?.release(); }
    realIndex.clearTranscriptIndexCache(); expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
  });

  it('does not overwrite a source lookup created by a reentrant queued acquire', async () => {
    await writeQuestion('reentrant-a', 'a'); await writeQuestion('reentrant-b', 'b');
    const service = new ClaudeConversationHistoryService();
    const conversation = source('reentrant-a');
    let next: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    let shared: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    const original = service.acquireHistoryIndex(conversation, fixtureDir, event => {
      if (event.phase !== 'queued' || next) return;
      conversation.providerState = { providerSessionId: 'reentrant-b' };
      next = service.acquireHistoryIndex(conversation, fixtureDir);
    });
    try {
      await original.ready; await next!.ready;
      shared = service.acquireHistoryIndex(conversation, fixtureDir); await shared.ready;
      const page = await shared.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(page.messages.map(message => message.id)).toEqual(['b']);
      expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(2);
    } finally { original.release(); next?.release(); shared?.release(); }
  });

  it('keeps page identity independent of materialization budgets for the same range', async () => {
    await writeFile(join(fixtureDir, 'budget-key.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'x'.repeat(5000) } })}\n`);
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(source('budget-key'), fixtureDir);
    try {
      await lease.ready;
      const full = await lease.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      const small = await lease.loadWindow({ anchorTurn: 0, direction: 'newer',
        budget: { ...budget, maxSourceBytes: 1024, maxProjectedChars: 2048 }, projectionLevel: 'summary' });
      expect(small.range).toEqual(full.range);
      expect(small.pageKey).toBe(full.pageKey);
      expect(small.messages).not.toEqual(full.messages);
    } finally { lease.release(); }
  });

  it('keeps a pending old lease readable after force refresh replaces the lookup instance', async () => {
    const conversation = createConversation();
    conversation.providerState = { providerSessionId: 'current-session' };
    await writeFile(join(fixtureDir, 'current-session.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'old lease question' } })}\n`);
    const service = new ClaudeConversationHistoryService();
    const old = service.acquireHistoryIndex(conversation, fixtureDir);
    const fresh = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
    try {
      await Promise.all([old.ready, fresh.ready]);
      expect([old.totalTurns, fresh.totalTurns]).toEqual([1, 1]);
      expect(old.planWindow!({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' }))
        .toEqual({ start: 0, end: 1 });
      const page = await old.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(page.messages.map(message => message.content)).toEqual(['old lease question']);
      await expect(old.loadMessageDetail('u1', { maxSourceBytes: 100_000 })).resolves
        .toMatchObject({ status: 'exact', message: { content: 'old lease question' } });
    } finally { old.release(); fresh.release(); }
  });

  it('releases two leases on one shared instance independently and exactly once', async () => {
    await writeQuestion('shared-release');
    const service = new ClaudeConversationHistoryService();
    const first = service.acquireHistoryIndex(source('shared-release'), fixtureDir);
    const second = service.acquireHistoryIndex(source('shared-release'), fixtureDir);
    const mockedIndex = jest.requireMock('@/providers/claude/history/ClaudeTranscriptHistoryIndex');
    first.release(); first.release();
    try {
      await second.ready;
      expect(second.totalTurns).toBe(1);
      expect(mockedIndex.protectTranscriptIndex).toHaveBeenCalledTimes(1);
      expect(mockedIndex.releaseTranscriptIndex).not.toHaveBeenCalled();
      const page = await second.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(page.messages[0].content).toBe('question-u1');
    } finally { second.release(); second.release(); }
    expect(mockedIndex.releaseTranscriptIndex).toHaveBeenCalledTimes(1);
  });

  it('reobserves an appended source during a pending build without changing the retired snapshot', async () => {
    await writeQuestion('reobserve');
    const service = new ClaudeConversationHistoryService();
    const conversation = source('reobserve');
    let fresh: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    const old = service.acquireHistoryIndex(conversation, fixtureDir, progress => {
      if (progress.phase !== 'finalizing' || fresh) return;
      appendFileSync(join(fixtureDir, 'reobserve.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: 'question-u2' } })}\n`);
      fresh = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
    });
    try {
      await old.ready;
      await fresh!.ready;
      expect([old.totalTurns, fresh!.totalTurns]).toEqual([1, 2]);
      const page = await old.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(page.messages.map(message => message.content)).toEqual(['question-u1']);
      const newPage = await fresh!.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(newPage.messages.map(message => message.content)).toEqual(['question-u1', 'question-u2']);
    } finally { old.release(); fresh?.release(); }
  });

  it('does not cancel a refreshed lease sharing the same physical build when the retired lease releases', async () => {
    await writeQuestion('retired-release');
    const service = new ClaudeConversationHistoryService();
    const conversation = source('retired-release');
    let progressed!: () => void;
    const progress = new Promise<void>(resolve => { progressed = resolve; });
    const old = service.acquireHistoryIndex(conversation, fixtureDir);
    const fresh = service.acquireHistoryIndex(conversation, fixtureDir, event => {
      if (event.phase === 'indexing' || event.phase === 'finalizing') progressed();
    }, true);
    void old.ready.catch(() => undefined);
    try {
      await progress;
      old.release();
      await fresh.ready;
      expect(fresh.totalTurns).toBe(1);
      const page = await fresh.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(page.messages[0].content).toBe('question-u1');
    } finally { old.release(); fresh.release(); }
  });

  it('retains exact old and new snapshot protections and reuses the unchanged completed snapshot', async () => {
    await writeQuestion('protected-refresh');
    const service = new ClaudeConversationHistoryService();
    const conversation = source('protected-refresh');
    const old = service.acquireHistoryIndex(conversation, fixtureDir);
    await old.ready;
    appendFileSync(join(fixtureDir, 'protected-refresh.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { content: 'question-u2' } })}\n`);
    const fresh = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
    let same: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    try {
      await fresh.ready;
      realIndex.clearTranscriptIndexCache();
      expect(realIndex.getTranscriptIndexCacheSize()).toBe(2);
      old.release();
      realIndex.clearTranscriptIndexCache();
      expect(realIndex.getTranscriptIndexCacheSize()).toBe(1);
      same = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
      await same.ready;
      expect(same.acquireOutcome).toBe('cache_hit');
      fresh.release();
      realIndex.clearTranscriptIndexCache();
      expect(realIndex.getTranscriptIndexCacheSize()).toBe(1);
      expect(same.totalTurns).toBe(2);
    } finally { old.release(); fresh.release(); same?.release(); }
    realIndex.clearTranscriptIndexCache();
    expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
  });

  it.each(['publication', 'cache-hit'] as const)('keeps temporary snapshot protection through the %s lease handoff', async pathKind => {
    const pins: historyIndexModule.TranscriptHistoryIndex[] = [];
    const service = new ClaudeConversationHistoryService();
    const conversation = source(`handoff-${pathKind}`);
    let old: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    let fresh: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    let third: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    let releasedExtraPin = false;
    try {
      for (let index = 0; index < 8; index += 1) {
        await writeQuestion(`handoff-pin-${pathKind}-${index}`);
        const result = await realIndex.buildTranscriptIndex(join(fixtureDir, `handoff-pin-${pathKind}-${index}.jsonl`), { useWorker: false });
        if (result.status === 'failed') throw new Error(result.error);
        realIndex.protectTranscriptIndex(result.index);
        pins.push(result.index);
      }
      if (pathKind === 'publication') realIndex.protectTranscriptIndex(pins[0]);
      await writeQuestion(`handoff-${pathKind}`);
      old = service.acquireHistoryIndex(conversation, fixtureDir);
      if (pathKind === 'cache-hit') {
        await old.ready;
        fresh = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
      }
      let gap = false;
      realIndex.setTranscriptIndexDiagnosticSink(event => {
        if (gap || event.phase !== (pathKind === 'publication' ? 'cache_overcommit' : 'cache_hit')) return;
        gap = true;
        queueMicrotask(() => {
          if (pathKind === 'publication') {
            realIndex.releaseTranscriptIndex(pins[0]);
            releasedExtraPin = true;
          } else old!.release();
        });
      });
      await (fresh ?? old).ready;
      expect(gap).toBe(true);
      expect(realIndex.getTranscriptIndexCacheSize()).toBe(9);
      third = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
      await third.ready;
      expect(third.acquireOutcome).toBe('cache_hit');
      const page = await third.loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(page.messages[0].content).toBe('question-u1');
    } finally {
      old?.release(); fresh?.release(); third?.release();
      if (pathKind === 'publication' && !releasedExtraPin && pins.length > 0) realIndex.releaseTranscriptIndex(pins[0]);
      pins.forEach(realIndex.releaseTranscriptIndex);
    }
    realIndex.clearTranscriptIndexCache();
    expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
  });

  it.each(['publication', 'cache-hit'] as const)('drops temporary pins when the %s receiver exits before ready', async pathKind => {
    const pins: historyIndexModule.TranscriptHistoryIndex[] = [];
    const service = new ClaudeConversationHistoryService();
    const conversation = source(`cancel-handoff-${pathKind}`);
    let old: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    let receiver: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    try {
      for (let index = 0; index < 8; index += 1) {
        const session = `cancel-pin-${pathKind}-${index}`;
        await writeQuestion(session);
        const result = await realIndex.buildTranscriptIndex(join(fixtureDir, `${session}.jsonl`), { useWorker: false });
        if (result.status === 'failed') throw new Error(result.error);
        realIndex.protectTranscriptIndex(result.index); pins.push(result.index);
      }
      await writeQuestion(`cancel-handoff-${pathKind}`);
      old = service.acquireHistoryIndex(conversation, fixtureDir);
      if (pathKind === 'cache-hit') { await old.ready; receiver = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true); }
      else receiver = old;
      let observed = false;
      realIndex.setTranscriptIndexDiagnosticSink(event => {
        if (observed || event.phase !== (pathKind === 'publication' ? 'cache_overcommit' : 'cache_hit')) return;
        observed = true;
        queueMicrotask(() => { old!.release(); receiver!.release(); });
      });
      await expect(receiver.ready).rejects.toThrow('History index build aborted');
      expect(observed).toBe(true);
    } finally { old?.release(); receiver?.release(); pins.forEach(realIndex.releaseTranscriptIndex); }
    realIndex.clearTranscriptIndexCache();
    expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
  });

  it('protects duplicate physical segments independently and releases all segment pins', async () => {
    await writeQuestion('duplicate-segment'); await writeQuestion('other-segment', 'u2');
    const conversation = source('other-segment');
    conversation.providerState = { ...conversation.providerState, previousProviderSessionIds: ['duplicate-segment', 'duplicate-segment'] };
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation, fixtureDir);
    try {
      await lease.ready;
      realIndex.clearTranscriptIndexCache();
      expect(realIndex.getTranscriptIndexCacheSize()).toBe(2);
      expect(lease.totalTurns).toBe(3);
    } finally { lease.release(); }
    realIndex.clearTranscriptIndexCache();
    expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
  });

  it('releases earlier segment pins when a later real source read fails', async () => {
    await writeQuestion('valid-segment');
    await mkdir(join(fixtureDir, 'unreadable-segment.jsonl'), { recursive: true });
    const conversation = source('unreadable-segment');
    conversation.providerState = { ...conversation.providerState, previousProviderSessionIds: ['valid-segment'] };
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation, fixtureDir);
    try { await expect(lease.ready).rejects.toThrow(); }
    finally { lease.release(); }
    realIndex.clearTranscriptIndexCache();
    expect(realIndex.getTranscriptIndexCacheSize()).toBe(0);
  });

  it('retains every actively leased snapshot when refreshes exceed the idle cache limit', async () => {
    await writeQuestion('active-overcommit');
    const service = new ClaudeConversationHistoryService();
    const conversation = source('active-overcommit');
    const leases: ReturnType<typeof service.acquireHistoryIndex>[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        if (index > 0) appendFileSync(join(fixtureDir, 'active-overcommit.jsonl'), `${JSON.stringify({
          type: 'user', uuid: `u${index + 1}`, parentUuid: `u${index}`, message: { content: `question-u${index + 1}` },
        })}\n`);
        const lease = service.acquireHistoryIndex(conversation, fixtureDir, undefined, true);
        leases.push(lease);
        await lease.ready;
      }
      realIndex.clearTranscriptIndexCache();
      expect(realIndex.getTranscriptIndexCacheSize()).toBe(10);
      expect(leases.map(lease => lease.totalTurns)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
      const page = await leases[0].loadWindow({ anchorTurn: 0, direction: 'newer', budget, projectionLevel: 'detail' });
      expect(page.messages.map(message => message.content)).toEqual(['question-u1']);
    } finally { leases.forEach(lease => lease.release()); }
    expect(realIndex.getTranscriptIndexCacheSize()).toBeLessThanOrEqual(8);
  });

  it('does not let a failed retired instance remove the replacement lookup', async () => {
    await writeQuestion('replacement');
    const service = new ClaudeConversationHistoryService();
    const missing = service.acquireHistoryIndex(source('missing'), fixtureDir);
    const fresh = service.acquireHistoryIndex(source('replacement'), fixtureDir, undefined, true);
    let shared: ReturnType<typeof service.acquireHistoryIndex> | undefined;
    try {
      await expect(missing.ready).rejects.toThrow('Conversation transcript is unavailable');
      await fresh.ready;
      shared = service.acquireHistoryIndex(source('replacement'), fixtureDir);
      await shared.ready;
      expect(shared.totalTurns).toBe(1);
      expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1);
    } finally { missing.release(); fresh.release(); shared?.release(); }
  });
});

describe('ClaudeConversationHistoryService M1 fuse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSdkSessionExists.mockReturnValue(true);
    // These legacy projection tests fake source availability; the production
    // service now checks the captured path rather than resolving session ids again.
    jest.spyOn(jest.requireActual('fs'), 'existsSync').mockImplementation((file: any) =>
      mockSdkSessionExists('/vault', String(file).split('/').at(-1)!.replace(/\.jsonl$/, '')));
  });
  afterEach(() => jest.restoreAllMocks());

  it('persists the incrementally maintained subagent sidecar without scanning messages', () => {
    const conversation = createConversation();
    const oldSubagent = { id: 'old-agent', mode: 'async', status: 'completed', taskId: 'old-task' } as any;
    conversation.providerState = {
      ...conversation.providerState,
      subagentData: { 'old-agent': oldSubagent },
    };
    conversation.messages = [{
      id: 'assistant',
      role: 'assistant',
      content: 'materialized window must be ignored',
      timestamp: 1,
    }];
    const service = new ClaudeConversationHistoryService();

    expect(service.buildPersistedProviderState(conversation)).toMatchObject({
      subagentData: { 'old-agent': oldSubagent },
    });
  });


  it('filters noisy title suffixes and falls back to recent short user messages', async () => {
    const turns = Array.from({ length: 4 }, (_, index) => ({
      turnId: `turn-${index}`,
      startEntry: index,
      endEntry: index,
      sourceBytes: 10,
    }));
    mockBuildTranscriptIndex.mockResolvedValue({
      status: 'complete',
      index: { filePath: '/current', projectionVariantKey: '[null,16777216]', dev: 1, ino: 1, snapshotSize: 99, mtimeMs: 1, ctimeMs: 1, committedSize: 99, entries: [], turns, searchCorpus: [], searchText: '', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 },
    });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    mockMaterializeTranscriptPage.mockImplementation(async (_index, start) => [{ start }] as any);
    mockMaterializeTranscriptToolAssociations.mockResolvedValue([]);
    mockMaterializeSDKMessages.mockImplementation(async (_vault, _session, native: any[]) => native.map(item => ({
      id: `user-${item.start}`,
      role: 'user' as const,
      content: [
        'first request',
        'This session is being continued from a previous conversation',
        'short two',
        'short three',
      ][item.start],
      timestamp: item.start,
    })));

    const material = await new ClaudeConversationHistoryService().loadTitleMaterial(createConversation(), '/vault');

    expect(material).toEqual({
      firstUserExcerpt: 'first request',
      recentUserExcerpts: [
        'This session is being continued from a previous conversation',
        'short two',
        'short three',
      ],
    });
  });

  it('shares one build across leases and loads stateless windows', async () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
    mockBuildTranscriptIndex.mockResolvedValue({ status: 'complete', index: { filePath: '/current', projectionVariantKey: '[null,16777216]', dev: 1, ino: 1, snapshotSize: 999, mtimeMs: 1, ctimeMs: 1, committedSize: 999, entries: [], turns, searchCorpus: [], searchText: '', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    mockMaterializeTranscriptPage.mockResolvedValue([]); mockMaterializeTranscriptToolAssociations.mockResolvedValue([]); mockMaterializeSDKMessages.mockResolvedValue([]);
    const service = new ClaudeConversationHistoryService(); const conversation = createConversation();
    const first = service.acquireHistoryIndex(conversation, '/vault'); const second = service.acquireHistoryIndex(conversation, '/vault');
    await first.ready; await second.ready;
    expect(mockBuildTranscriptIndex).toHaveBeenCalledTimes(1); expect(first.totalTurns).toBe(120);
    await first.loadWindow({ anchorTurn: 120, direction: 'older', budget: { maxTurns: 50, maxSourceBytes: 1024 * 1024, maxProjectedChars: 1024 * 1024, timeSliceMs: 8 }, projectionLevel: 'detail' });
    expect(mockMaterializeTranscriptPage).toHaveBeenCalledWith(expect.anything(), 70, 1);
    first.release(); first.release();
    await expect(second.loadWindow({ anchorTurn: 1, direction: 'older', budget: { maxTurns: 1, maxSourceBytes: 1024, maxProjectedChars: 1024, timeSliceMs: 8 }, projectionLevel: 'detail' })).resolves.toBeDefined();
    second.release();
  });

  it('reports the lease acquire outcome from the segment builds', async () => {
    const turns = [{ turnId: 'u0', startEntry: 0, endEntry: 0, sourceBytes: 8 }];
    const index = { filePath: '/current', projectionVariantKey: '[null,16777216]', dev: 1, ino: 1, snapshotSize: 10, mtimeMs: 1, ctimeMs: 1, committedSize: 10, entries: [], turns, searchCorpus: [], searchText: '', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 };
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    const service = new ClaudeConversationHistoryService();
    const conversation = createConversation();

    mockBuildTranscriptIndex.mockResolvedValueOnce({ status: 'complete', index });
    const rebuilt = service.acquireHistoryIndex(conversation, '/vault', undefined, true);
    // The outcome is only knowable once the build settles.
    expect(rebuilt.acquireOutcome).toBeUndefined();
    await rebuilt.ready;
    expect(rebuilt.acquireOutcome).toBe('rebuilt');

    mockBuildTranscriptIndex.mockResolvedValueOnce({ status: 'complete', index, fromCache: true });
    const cached = service.acquireHistoryIndex(conversation, '/vault', undefined, true);
    await cached.ready;
    expect(cached.acquireOutcome).toBe('cache_hit');
    rebuilt.release(); cached.release();
  });

  it('enumerates every non-overlapping match with stable projection ordinals', async () => {
    const searchText = 'needle needle needleneedle';
    const searchCorpus = [
      { projectionKey: 'same', turnIndex: 1, entryIndex: 0, timestamp: '', textOffset: 0, textLength: 13 },
      { projectionKey: 'same', turnIndex: 1, entryIndex: 1, timestamp: '', textOffset: 14, textLength: 12 },
    ];
    mockBuildTranscriptIndex.mockResolvedValue({ status: 'complete', index: { filePath: '/current', projectionVariantKey: '[null,16777216]', dev: 1, ino: 1, snapshotSize: 1, mtimeMs: 1, ctimeMs: 1, committedSize: 1, entries: [], turns: [{ turnId: '0', startEntry: 0, endEntry: 0, sourceBytes: 1024 }, { turnId: '1', startEntry: 1, endEntry: 1, sourceBytes: 1024 }], searchCorpus, searchText, skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    const service = new ClaudeConversationHistoryService(); const lease = service.acquireHistoryIndex(createConversation(), '/vault'); await lease.ready;
    await expect(lease.search('needle')).resolves.toEqual([
      expect.objectContaining({ projectionKey: 'same', turnIndex: 1, matchOrdinal: 0 }),
      expect.objectContaining({ projectionKey: 'same', turnIndex: 1, matchOrdinal: 1 }),
      expect.objectContaining({ projectionKey: 'same', turnIndex: 1, matchOrdinal: 2 }),
      expect.objectContaining({ projectionKey: 'same', turnIndex: 1, matchOrdinal: 3 }),
    ]);
  });

  it('orders same-turn search hits by canonical corpus position, not projectionKey string', async () => {
    const searchCorpus = [
      { projectionKey: 'zzz-user', turnIndex: 0, entryIndex: 0, timestamp: '', textOffset: 0, textLength: 6 },
      { projectionKey: 'aaa-assistant', turnIndex: 0, entryIndex: 1, timestamp: '', textOffset: 7, textLength: 6 },
    ];
    mockBuildTranscriptIndex.mockResolvedValue({ status: 'complete', index: { filePath: '/current', projectionVariantKey: '[null,16777216]', dev: 1, ino: 1, snapshotSize: 1, mtimeMs: 1, ctimeMs: 1, committedSize: 1, entries: [], turns: [{ turnId: '0', startEntry: 0, endEntry: 1, sourceBytes: 1024 }], searchCorpus, searchText: 'needle needle', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } });
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    const service = new ClaudeConversationHistoryService(); const lease = service.acquireHistoryIndex(createConversation(), '/vault'); await lease.ready;
    const results = await lease.search('needle');
    // Same turn: the user projection (entry 0) precedes the assistant one
    // regardless of their projectionKey strings.
    expect(results.map(result => result.projectionKey)).toEqual(['zzz-user', 'aaa-assistant']);
  });


  it('drops a failed shared build so acquire can retry', async () => {
    mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
    mockBuildTranscriptIndex.mockResolvedValueOnce({ status: 'failed', error: 'worker crashed' }).mockResolvedValueOnce({ status: 'complete', index: { filePath: '/current', projectionVariantKey: '[null,16777216]', dev: 1, ino: 1, snapshotSize: 1, mtimeMs: 1, ctimeMs: 1, committedSize: 1, entries: [], turns: [], searchCorpus: [], searchText: '', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } });
    const service = new ClaudeConversationHistoryService(); const conversation = createConversation();
    const callsBefore = mockBuildTranscriptIndex.mock.calls.length;
    const failed = service.acquireHistoryIndex(conversation, '/vault'); await expect(failed.ready).rejects.toThrow('worker crashed');
    const retried = service.acquireHistoryIndex(conversation, '/vault'); await expect(retried.ready).resolves.toBeUndefined();
    expect(mockBuildTranscriptIndex.mock.calls.length - callsBefore).toBe(2);
  });


  describe('loadWindow budget materialization', () => {
    const MiB = 1024 * 1024;
    const budget = (overrides: Partial<HistoryLoadBudget> = {}): HistoryLoadBudget => ({
      maxTurns: 25,
      maxSourceBytes: 8 * MiB,
      maxProjectedChars: 2_000_000,
      timeSliceMs: 8,
      ...overrides,
    });

    function mockIndex(turns: Array<{ turnId: string; startEntry: number; endEntry: number; sourceBytes: number }>, entries: any[] = []) {
      return { status: 'complete' as const, index: { filePath: '/current', projectionVariantKey: '[null,16777216]', dev: 1, ino: 1, snapshotSize: 999, mtimeMs: 1, ctimeMs: 1, committedSize: 999, entries, turns, searchCorpus: [], searchText: '', skippedLines: 0, buildDurationMs: 1, peakWorkerHeapBytes: 1 } };
    }

    async function nativeToMessages(_vaultPath: string, _sessionId: string, native: any[]): Promise<ChatMessage[]> {
      return native.map((message, index): ChatMessage => ({
        id: message.uuid ?? `n${index}`,
        role: message.type === 'user' ? 'user' : 'assistant',
        content: typeof message.message?.content === 'string' ? message.message.content : '',
        timestamp: index + 1,
      }));
    }

    beforeEach(() => {
      mockMaterializeTranscriptToolAssociations.mockImplementation(async (_index, pageEntries) => pageEntries);
      mockMaterializeSDKMessages.mockImplementation(nativeToMessages);
    });

    it('materializes the planned window within the byte and turn budgets', async () => {
      const turns = Array.from({ length: 30 }, (_, index) => ({ turnId: `u${index}`, startEntry: index * 2, endEntry: index * 2 + 1, sourceBytes: 1024 * 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow({ anchorTurn: 30, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      // 25 x 1 MiB exceeds the 8 MiB byte budget, so bytes bind before turns.
      expect(page.range).toEqual({ start: 22, end: 30 });
      expect(page.sourceBytes).toBe(8 * 1024 * 1024);
      expect(page.projectedChars).toBe(0);
      expect(page.oversizedTurnCount).toBe(0);
      const snapshot = JSON.stringify(['/current', 1, 1, 999, 1, 1]);
      const physicalIdentity = JSON.stringify([snapshot, JSON.stringify([null, 16 * 1024 * 1024])]);
      const coveredIdentity = JSON.stringify([physicalIdentity, 'complete', 999, null]);
      expect(page.pageKey).toBe(`w:${JSON.stringify([[coveredIdentity], [22, 30]])}`);
      expect(page.hasMoreBefore).toBe(true);
      expect(page.hasMoreAfter).toBe(false);
      expect(mockMaterializeTranscriptPage).toHaveBeenCalledTimes(8);
    });

    it('plans the same window synchronously for progress reporting', async () => {
      const turns = Array.from({ length: 30 }, (_, index) => ({ turnId: `u${index}`, startEntry: index * 2, endEntry: index * 2 + 1, sourceBytes: 1024 * 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      expect(lease.planWindow!({ anchorTurn: 30, direction: 'older', budget: budget(), projectionLevel: 'summary' }))
        .toEqual({ start: 22, end: 30 });
    });

    it('returns the oversized newest turn as a bounded summary page', async () => {
      const giantBytes = 12 * MiB;
      const entries = [
        { offset: 0, length: 100, type: 'user', messageKey: 'u0', uuid: 'u0', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 100, length: 100, type: 'assistant', messageKey: 'a0', uuid: 'a0', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 200, length: 100, type: 'user', messageKey: 'u1', uuid: 'u1', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 300, length: 100, type: 'assistant', messageKey: 'a1', uuid: 'a1', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 400, length: 90, type: 'user', messageKey: 'u2', uuid: 'u2', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 490, length: 90, type: 'assistant', messageKey: 'tu2', uuid: 'tu2', realUser: false, displayable: false, isMeta: false, toolUseIds: ['toolu_2'], toolResultIds: [] },
        { offset: 580, length: giantBytes, type: 'user', messageKey: 'tr2', uuid: 'tr2', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: ['toolu_2'] },
        { offset: 580 + giantBytes, length: 80, type: 'assistant', messageKey: 'af2', uuid: 'af2', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
      ];
      const turns = [
        { turnId: 'u0', startEntry: 0, endEntry: 1, sourceBytes: 200 },
        { turnId: 'u1', startEntry: 2, endEntry: 3, sourceBytes: 200 },
        { turnId: 'u2', startEntry: 4, endEntry: 7, sourceBytes: 180 + giantBytes },
      ];
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns, entries));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptEntries.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow({ anchorTurn: 3, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      expect(page.range).toEqual({ start: 2, end: 3 });
      expect(page.oversizedTurnCount).toBe(1);
      expect(page.sourceBytes).toBeLessThanOrEqual(budget().maxSourceBytes);
      // Only entries below the per-entry read cap were read (head and tail of the turn).
      const readEntries = mockMaterializeTranscriptEntries.mock.calls[0][1] as Array<{ messageKey: string }>;
      expect(readEntries.map(entry => entry.messageKey)).toEqual(['u2', 'tu2', 'af2']);
      // The projection received the tool-result placeholder plus the aggregate omission marker.
      const projected = mockMaterializeSDKMessages.mock.calls[0][2] as any[];
      const placeholder = projected.find(message => message.uuid === 'oversized-tr2');
      expect(placeholder).toMatchObject({ type: 'user', sourceToolUseID: 'toolu_2' });
      const marker = projected.find(message => message.uuid === 'oversized-marker-u2');
      expect((marker.message.content as any[])[0].text).toContain('1 transcript entries');
    });

    it('stops adding older turns once the projected-char budget is exceeded', async () => {
      const turns = Array.from({ length: 30 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      // Unique uuids per turn: real turns never share message ids, and the
      // measured == reported invariant below depends on dedupe not firing.
      let nativeCounter = 0;
      mockMaterializeTranscriptPage.mockImplementation(() => {
        nativeCounter += 1;
        return Promise.resolve([{ type: 'user', uuid: `native-${nativeCounter}` }]);
      });
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map((message, index) => ({ id: message.uuid ?? `n${index}`, role: 'user' as const, content: 'c'.repeat(1_000_000), timestamp: 1 })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow({ anchorTurn: 30, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      // Two 1M-char turns fit the 2M budget; the third would exceed it.
      expect(page.range).toEqual({ start: 28, end: 30 });
      expect(page.projectedChars).toBe(2_000_000);
      // Old-turn cumulative overflow keeps the measured == reported invariant.
      expect(page.projectedChars).toBe(measureChatProjectionChars(page.messages));
      expect(page.projectedChars).toBeLessThanOrEqual(budget().maxProjectedChars);
    });

    it('hard-caps a plain turn whose projection alone exceeds the char budget (anchor)', async () => {
      const turns = Array.from({ length: 3 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([{ type: 'user', uuid: 'native' }]);
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map((message, index) => ({ id: message.uuid ?? `n${index}`, role: 'user' as const, content: 'c'.repeat(5000), timestamp: 1 })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow({ anchorTurn: 3, direction: 'older', budget: budget({ maxProjectedChars: 1000 }), projectionLevel: 'summary' });

      // The oversized anchor turn is included as a summary projection, not an empty page.
      expect(page.range).toEqual({ start: 2, end: 3 });
      expect(page.oversizedTurnCount).toBe(1);
      // Hard cap: the real measured projection never exceeds the budget.
      expect(page.projectedChars).toBeLessThanOrEqual(1000);
      expect(page.projectedChars).toBe(measureChatProjectionChars(page.messages));
      expect(page.messages[0].content.length).toBeLessThanOrEqual(1000);
      // Explicit omission marker when there is room for one.
      expect(page.messages[0].content).toContain('…');
    });

    it('hard-caps an oversized source turn whose summary projection still exceeds the budget', async () => {
      const giantBytes = 20 * 1024 * 1024;
      const entries = [
        { offset: 0, length: 90, type: 'user', messageKey: 'u0', uuid: 'u0', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 90, length: 90, type: 'assistant', messageKey: 'a0', uuid: 'a0', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 180, length: giantBytes, type: 'user', messageKey: 'tr0', uuid: 'tr0', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
      ];
      const turns = [{ turnId: 'u0', startEntry: 0, endEntry: 2, sourceBytes: 180 + giantBytes }];
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns, entries));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptEntries.mockResolvedValue([]);
      // The materialized summary projection itself dwarfs the tiny budget.
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map((message, index) => ({ id: message.uuid ?? `n${index}`, role: 'user' as const, content: 's'.repeat(40_000), timestamp: 1 })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow({ anchorTurn: 1, direction: 'older', budget: budget({ maxProjectedChars: 1000 }), projectionLevel: 'summary' });

      // Oversized source turn: hard-capped to the budget, shells kept.
      expect(page.range).toEqual({ start: 0, end: 1 });
      expect(page.projectedChars).toBeLessThanOrEqual(1000);
      expect(page.projectedChars).toBe(measureChatProjectionChars(page.messages));
      expect(page.messages.length).toBeGreaterThan(0);
      for (const message of page.messages) {
        expect(message.content.length).toBeLessThanOrEqual(1000);
      }
    });

    it('hard-caps the anchor when it is the only turn in the plan', async () => {
      const turns = [{ turnId: 'u0', startEntry: 0, endEntry: 0, sourceBytes: 1024 }];
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([{ type: 'user', uuid: 'native' }]);
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map((message, index) => ({ id: message.uuid ?? `n${index}`, role: 'user' as const, content: 'only '.repeat(2000), timestamp: 1 })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow({ anchorTurn: 1, direction: 'older', budget: budget({ maxProjectedChars: 1000 }), projectionLevel: 'summary' });

      expect(page.range).toEqual({ start: 0, end: 1 });
      expect(page.projectedChars).toBeLessThanOrEqual(1000);
      expect(page.projectedChars).toBe(measureChatProjectionChars(page.messages));
      // The anchor's message identity survives the hard cap.
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0].id).toBe('native');
      expect(page.messages[0].content).toContain('…');
    });

    it('plans windows across segments', async () => {
      const prevTurns = Array.from({ length: 10 }, (_, index) => ({ turnId: `p${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 * 1024 }));
      const currentTurns = Array.from({ length: 5 }, (_, index) => ({ turnId: `c${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 * 1024 }));
      mockBuildTranscriptIndex.mockImplementation(async (path: string) =>
        String(path).includes('previous-session') ? mockIndex(prevTurns) : mockIndex(currentTurns));
      mockSdkSessionExists.mockReturnValue(true);
      mockMaterializeTranscriptPage.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;
      expect(lease.totalTurns).toBe(15);

      const page = await lease.loadWindow({ anchorTurn: 15, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      expect(page.range).toEqual({ start: 7, end: 15 });
      expect(mockMaterializeTranscriptPage).toHaveBeenCalledTimes(8);
    });

    it('unprotects the snapshot without clearing the global transcript cache', async () => {
      const turns = Array.from({ length: 3 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      lease.release();

      // release() unprotects the snapshot for LRU but never wipes the global
      // completed cache; the idle-cache hit itself is covered by the index
      // module tests against the real cache.
      expect(mockClearTranscriptIndexCache).not.toHaveBeenCalled();
    });

    it('restores the canonical order of a newest-first materialized window by displayOrder', async () => {
      const turns = Array.from({ length: 3 }, (_, index) => ({ turnId: `u${index}`, startEntry: index, endEntry: index, sourceBytes: 1024 }));
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptPage.mockImplementation(async (_index: any, start: number) => [{ type: 'user', uuid: `t${start}` }]);
      const orderById = new Map([
        ['t0', [0, 0, 0]],
        ['t1', [0, 1, 0]],
        ['t2', [0, 2, 0]],
      ]);
      mockMaterializeSDKMessages.mockImplementation(async (_vault: string, _sessionId: string, native: any[]) =>
        native.map(message => ({
          id: message.uuid,
          role: 'user' as const,
          content: `content ${message.uuid}`,
          timestamp: 1,
          displayOrder: orderById.get(message.uuid) as [number, number, number] | undefined,
        })));
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      const page = await lease.loadWindow({ anchorTurn: 3, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      // The window loop materializes newest-first; only the canonical
      // displayOrder key restores the ascending structural order (identical
      // timestamps here would otherwise keep the reversed push order).
      expect(page.messages.map(message => message.id)).toEqual(['t0', 't1', 't2']);
    });

    it('interleaves oversized summary placeholders at their canonical entry positions', async () => {
      const giantBytes = 12 * MiB;
      const entries = [
        { offset: 0, length: 100, type: 'user', messageKey: 'u2', uuid: 'u2', realUser: true, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
        { offset: 100, length: 100, type: 'assistant', messageKey: 'tu2', uuid: 'tu2', realUser: false, displayable: false, isMeta: false, toolUseIds: ['toolu_2'], toolResultIds: [] },
        { offset: 200, length: giantBytes, type: 'user', messageKey: 'tr2', uuid: 'tr2', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: ['toolu_2'] },
        { offset: 200 + giantBytes, length: 80, type: 'assistant', messageKey: 'af2', uuid: 'af2', realUser: false, displayable: false, isMeta: false, toolUseIds: [], toolResultIds: [] },
      ];
      const turns = [{ turnId: 'u2', startEntry: 0, endEntry: 3, sourceBytes: 180 + giantBytes }];
      mockBuildTranscriptIndex.mockResolvedValue(mockIndex(turns, entries));
      mockSdkSessionExists.mockImplementation((_vault, session) => session === 'current-session');
      mockMaterializeTranscriptEntries.mockImplementation(async (_index: any, readEntries: any[]) =>
        readEntries.map(entry => ({ type: 'user', uuid: entry.messageKey })));
      mockMaterializeSDKMessages.mockResolvedValue([]);
      const service = new ClaudeConversationHistoryService();
      const lease = service.acquireHistoryIndex(createConversation(), '/vault');
      await lease.ready;

      await lease.loadWindow({ anchorTurn: 1, direction: 'older', budget: budget(), projectionLevel: 'summary' });

      // The summary projection must keep the skipped entry's canonical slot:
      // placeholder between its neighbors, turn marker last — never a
      // tail-appended synthetic block that detaches from the original order.
      const projected = mockMaterializeSDKMessages.mock.calls[0][2] as any[];
      expect(projected.map(message => message.uuid)).toEqual(['u2', 'tu2', 'oversized-tr2', 'af2', 'oversized-marker-u2']);
    });
  });

});
