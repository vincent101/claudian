import { open, stat } from 'fs/promises';
import { Worker } from 'worker_threads';

import { isCompactionCanceledStderr } from '../../../utils/interrupt';
import {
  extractExternalDisplayContent,
  extractUserText,
  isDisplayableExternalUser,
  isRealUserMessage,
  unwrapExternalEnvelope,
} from './externalUserMessage';
import { filterActiveBranchEntries } from './sdkBranchFilter';
import type { SDKNativeMessage } from './sdkHistoryTypes';
import {
  advanceSDKProjection,
  createSDKProjectionState,
  getSDKProjectionKind,
  isSDKMessageProjectionSkipped,
} from './sdkMessageProjection';

const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface TranscriptIndexEntry {
  offset: number;
  length: number;
  type: string;
  messageKey: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  turnId?: string;
  realUser: boolean;
  displayable: boolean;
  isMeta: boolean;
  sourceToolUseID?: string;
  toolUseIds: string[];
  toolResultIds: string[];
}

export interface TranscriptTurnIndex {
  turnId: string;
  startEntry: number;
  endEntry: number;
  /** Sum of entry byte lengths inside the turn; aggregated at finalize, no content read. */
  sourceBytes: number;
}

export interface TranscriptSearchCorpusItem {
  projectionKey: string;
  turnIndex: number;
  timestamp?: string;
  textOffset: number;
  textLength: number;
}

export interface TranscriptHistoryIndex {
  filePath: string;
  dev: number;
  ino: number;
  snapshotSize: number;
  mtimeMs: number;
  entries: TranscriptIndexEntry[];
  turns: TranscriptTurnIndex[];
  searchCorpus: TranscriptSearchCorpusItem[];
  searchText: string;
  skippedLines: number;
  buildDurationMs: number;
  peakWorkerHeapBytes: number;
}

export type TranscriptIndexResult =
  | { status: 'complete'; index: TranscriptHistoryIndex }
  | { status: 'partial'; index: TranscriptHistoryIndex; error: string }
  | { status: 'failed'; error: string };

interface BuildOptions {
  chunkSize?: number;
  maxLineBytes?: number;
  useWorker?: boolean;
  resumeAtMessageId?: string;
  signal?: AbortSignal;
  onProgress?: (bytesRead: number, snapshotSize: number) => void;
  onFinalize?: () => void;
}

const FINALIZE_BATCH_SIZE = 2_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('History index build aborted');
}

async function yieldToMainThread(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  throwIfAborted(signal);
}

interface RawIndexEntry extends TranscriptIndexEntry {
  originMessageId?: string;
  searchText?: string;
  projectionKind: 'skip' | 'user' | 'assistant' | 'compact-boundary';
}

function extractVisibleUserSearchText(message: SDKNativeMessage): string | undefined {
  const text = extractUserText(message);
  if (!text) return undefined;
  if (text.startsWith('This session is being continued from a previous conversation')) return undefined;
  if (text.includes('<local-command-stdout>') || text.includes('<local-command-stderr>')) return undefined;
  const query = text.match(/<query>\n?([\s\S]*?)\n?<\/query>/)?.[1];
  if (query !== undefined) return query.trim() || undefined;
  const context = text.match(/\n\n<(?:current_note|editor_selection|editor_cursor|context_files|canvas_selection|browser_selection)[\s>]/);
  return (context?.index === undefined ? text : text.slice(0, context.index)).trim() || undefined;
}

function extractSearchText(message: SDKNativeMessage): string | undefined {
  if (message.type === 'user') {
    if (!isRealUserMessage(message)) return undefined;
    return isDisplayableExternalUser(message)
      ? extractExternalDisplayContent(message)
      : extractVisibleUserSearchText(message);
  }
  if (message.type !== 'assistant') return undefined;
  const content = message.message?.content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '(no content)')
    .map(block => block.text as string)
    .join('\n')
    .trim();
  return text || undefined;
}

function toRawEntry(message: SDKNativeMessage, offset: number, length: number, lineNumber: number): RawIndexEntry {
  const content = message.message?.content;
  const blocks = Array.isArray(content) ? content : [];
  return {
    offset,
    length,
    type: message.type as string,
    messageKey: message.uuid ?? `line:${lineNumber}`,
    uuid: message.uuid,
    originMessageId: message.origin?.msg_id,
    searchText: extractSearchText(message),
    projectionKind: getSDKProjectionKind(message),
    parentUuid: message.parentUuid,
    timestamp: message.timestamp,
    realUser: isRealUserMessage(message),
    displayable: isDisplayableExternalUser(message),
    isMeta: message.isMeta === true,
    sourceToolUseID: message.sourceToolUseID,
    toolUseIds: blocks.flatMap(block => block.type === 'tool_use' && block.id ? [block.id] : []),
    toolResultIds: blocks.flatMap(block => block.type === 'tool_result' && block.tool_use_id ? [block.tool_use_id] : []),
  };
}

async function finalizeIndex(
  filePath: string,
  snapshot: { dev: number; ino: number; size: number; mtimeMs: number },
  rawEntries: RawIndexEntry[],
  skippedLines: number,
  resumeAtMessageId?: string,
  signal?: AbortSignal,
): Promise<TranscriptHistoryIndex> {
  throwIfAborted(signal);
  const canonical = filterActiveBranchEntries(rawEntries, resumeAtMessageId, entry => entry.realUser);
  await yieldToMainThread(signal);
  let currentTurn: TranscriptTurnIndex | undefined;
  let currentTurnIndex = -1;
  let currentTurnBytes = 0;
  const projection = createSDKProjectionState();
  const turns: TranscriptTurnIndex[] = [];
  const searchCorpus: TranscriptSearchCorpusItem[] = [];
  const searchTextParts: string[] = [];
  let searchTextLength = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    const entry = canonical[index];
    const projectionKey = advanceSDKProjection(projection, entry.projectionKind, entry.messageKey);
    if (entry.realUser) {
      if (currentTurn) {
        currentTurn.endEntry = index - 1;
        currentTurn.sourceBytes = currentTurnBytes;
      }
      currentTurn = {
        turnId: entry.uuid ?? entry.originMessageId!,
        startEntry: index,
        endEntry: index,
        sourceBytes: 0,
      };
      currentTurnBytes = entry.length;
      turns.push(currentTurn);
      currentTurnIndex = turns.length - 1;
    } else if (currentTurn) {
      currentTurn.endEntry = index;
      currentTurnBytes += entry.length;
    }
    entry.turnId = currentTurn?.turnId;
    if (entry.searchText && currentTurnIndex >= 0 && projectionKey) {
      const existing = searchCorpus[searchCorpus.length - 1];
      const separator = entry.type === 'assistant' && existing?.projectionKey === projectionKey ? '\n\n' : '';
      searchTextParts.push(separator, entry.searchText);
      if (separator) {
        existing.textLength += separator.length + entry.searchText.length;
        existing.timestamp ??= entry.timestamp;
      } else {
        searchCorpus.push({
          projectionKey,
          turnIndex: currentTurnIndex,
          timestamp: entry.timestamp,
          textOffset: searchTextLength,
          textLength: entry.searchText.length,
        });
      }
      searchTextLength += separator.length + entry.searchText.length;
    }
    delete entry.originMessageId;
    delete entry.searchText;
    delete (entry as Partial<RawIndexEntry>).projectionKind;
    if ((index + 1) % FINALIZE_BATCH_SIZE === 0) await yieldToMainThread(signal);
  }
  if (currentTurn) currentTurn.sourceBytes = currentTurnBytes;
  return {
    filePath,
    dev: snapshot.dev,
    ino: snapshot.ino,
    snapshotSize: snapshot.size,
    mtimeMs: snapshot.mtimeMs,
    entries: canonical,
    turns,
    searchCorpus,
    searchText: searchTextParts.join(''),
    skippedLines,
    buildDurationMs: 0,
    peakWorkerHeapBytes: 0,
  };
}

async function scanSnapshot(
  filePath: string,
  chunkSize: number,
  maxLineBytes: number,
  onProgress?: (bytesRead: number, snapshotSize: number) => void,
  signal?: AbortSignal,
): Promise<{
  entries: RawIndexEntry[];
  skippedLines: number;
  incomplete: boolean;
  snapshot: { dev: number; ino: number; size: number; mtimeMs: number };
  peakHeapBytes: number;
}> {
  const handle = await open(filePath, 'r');
  const info = await handle.stat();
  const snapshot = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
  const entries: RawIndexEntry[] = [];
  let skippedLines = 0;
  let position = 0;
  let partial = Buffer.alloc(0);
  let partialOffset = 0;
  let lineNumber = 0;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  try {
    while (position < snapshot.size) {
      throwIfAborted(signal);
      const length = Math.min(chunkSize, snapshot.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      const data = partial.length > 0
        ? Buffer.concat([partial, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      const dataOffset = partial.length > 0 ? partialOffset : position;
      let start = 0;
      for (let cursor = 0; cursor < data.length; cursor += 1) {
        if (data[cursor] !== 0x0a) continue;
        const line = data.subarray(start, cursor);
        if (line.length > maxLineBytes) throw new Error(`Transcript line exceeds ${maxLineBytes} bytes at offset ${dataOffset + start}`);
        if (line.toString('utf8').trim()) {
          try {
            const message = JSON.parse(line.toString('utf8').replace(/\r$/, '')) as SDKNativeMessage;
            entries.push(toRawEntry(message, dataOffset + start, cursor - start, lineNumber));
          } catch {
            skippedLines += 1;
          }
        }
        lineNumber += 1;
        start = cursor + 1;
      }
      partial = Buffer.from(data.subarray(start));
      partialOffset = dataOffset + start;
      if (partial.length > maxLineBytes) throw new Error(`Transcript line exceeds ${maxLineBytes} bytes at offset ${partialOffset}`);
      position += bytesRead;
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      onProgress?.(position, snapshot.size);
      await yieldToMainThread(signal);
    }
  } finally {
    await handle.close();
  }
  return { entries, skippedLines, incomplete: partial.length > 0, snapshot, peakHeapBytes };
}

async function buildDirect(filePath: string, options: BuildOptions): Promise<TranscriptIndexResult> {
  const startedAt = performance.now();
  try {
    const scanned = await scanSnapshot(
      filePath,
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      options.onProgress,
      options.signal,
    );
    options.onFinalize?.();
    const index = await finalizeIndex(
      filePath,
      scanned.snapshot,
      scanned.entries,
      scanned.skippedLines,
      options.resumeAtMessageId,
      options.signal,
    );
    index.buildDurationMs = performance.now() - startedAt;
    index.peakWorkerHeapBytes = scanned.peakHeapBytes;
    if (scanned.incomplete) return { status: 'partial', index, error: 'Incomplete final transcript line at snapshot boundary' };
    return { status: 'complete', index };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

const MAX_COMPLETED_INDEXES = 2;
const completed = new Map<string, TranscriptIndexResult>();
const inFlight = new Map<string, Promise<TranscriptIndexResult>>();
const protectedPaths = new Map<string, number>();

function touchCompleted(key: string, result: TranscriptIndexResult): void {
  completed.delete(key);
  completed.set(key, result);
}

function isProtectedCompletedKey(key: string, result: TranscriptIndexResult): boolean {
  if (result.status === 'failed' || !protectedPaths.has(result.index.filePath)) return false;
  const keys = [...completed.entries()]
    .filter(([, candidate]) => candidate.status !== 'failed' && candidate.index.filePath === result.index.filePath)
    .map(([candidateKey]) => candidateKey);
  return keys[keys.length - 1] === key;
}

function evictCompleted(): void {
  while (completed.size > MAX_COMPLETED_INDEXES) {
    const candidate = [...completed.keys()].find(key => {
      const result = completed.get(key);
      return !result || !isProtectedCompletedKey(key, result);
    }) ?? completed.keys().next().value;
    if (!candidate) return;
    completed.delete(candidate);
  }
}

async function snapshotKey(filePath: string): Promise<string> {
  const info = await stat(filePath);
  return `${filePath}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

function serializeWorkerFunction(fn: (...args: never[]) => unknown): string {
  // ts-jest/esbuild may namespace imported helpers before Function#toString;
  // the worker source defines those helpers as locals, so normalize qualifiers.
  return fn.toString()
    .replace(/\(0,\s*(?:import_[A-Za-z0-9_$]+|[A-Za-z_$][\w$]*_\d+)\.([A-Za-z_$][\w$]*)\)/g, '$1')
    .replace(/\bimport_[A-Za-z0-9_$]+\.([A-Za-z_$][\w$]*)/g, '$1')
    .replace(/\bexports\.([A-Za-z_$][\w$]*)/g, '$1')
    .replace(/__name\([^;]+;?/g, '');
}

function buildInWorker(filePath: string, options: BuildOptions): Promise<TranscriptIndexResult> {
  const source = `
    const { parentPort, workerData } = require('worker_threads');
    const import_promises = require('fs/promises');
    const promises_1 = import_promises;
    const { open, stat } = import_promises;
    const DEFAULT_CHUNK_SIZE = ${DEFAULT_CHUNK_SIZE};
    const DEFAULT_MAX_LINE_BYTES = ${DEFAULT_MAX_LINE_BYTES};
    const FINALIZE_BATCH_SIZE = ${FINALIZE_BATCH_SIZE};
    const throwIfAborted = (${serializeWorkerFunction(throwIfAborted)});
    const yieldToMainThread = (${serializeWorkerFunction(yieldToMainThread)});
    const DISPLAYABLE_EXTERNAL_KINDS = new Set(['peer', 'channel', 'coordinator']);
    const extractUserText = (${serializeWorkerFunction(extractUserText)});
    const unwrapExternalEnvelope = (${serializeWorkerFunction(unwrapExternalEnvelope)});
    const extractExternalDisplayContent = (${serializeWorkerFunction(extractExternalDisplayContent)});
    const isDisplayableExternalUser = (${serializeWorkerFunction(isDisplayableExternalUser)});
    const isRealUserMessage = (${serializeWorkerFunction(isRealUserMessage)});
    const normalize = text => text.trim();
    const COMPACTION_CANCELED_STDERR_PATTERN = /^<local-command-stderr>\\s*Error:\\s*Compaction canceled\\.?\\s*<\\/local-command-stderr>$/i;
    const isCompactionCanceledStderr = (${serializeWorkerFunction(isCompactionCanceledStderr)});
    const projectionText = (message) => {
      const content = message.message?.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\\n');
    };
    const isSDKMessageProjectionSkipped = (${serializeWorkerFunction(isSDKMessageProjectionSkipped)});
    const getSDKProjectionKind = (${serializeWorkerFunction(getSDKProjectionKind)});
    const createSDKProjectionState = (${serializeWorkerFunction(createSDKProjectionState)});
    const advanceSDKProjection = (${serializeWorkerFunction(advanceSDKProjection)});
    const extractVisibleUserSearchText = (${serializeWorkerFunction(extractVisibleUserSearchText)});
    const extractSearchText = (${serializeWorkerFunction(extractSearchText)});
    const toRawEntry = (${serializeWorkerFunction(toRawEntry)});
    const filterActiveBranchEntries = (${serializeWorkerFunction(filterActiveBranchEntries)});
    const finalizeIndex = (${serializeWorkerFunction(finalizeIndex)});
    const scanSnapshot = (${serializeWorkerFunction(scanSnapshot)});
    const buildDirect = (${serializeWorkerFunction(buildDirect)});
    // ts-jest CJS output references imported symbols through module namespaces
    // (name_1.symbol); alias them so the serialized sources resolve in both
    // bundled and ts-jest shapes.
    const externalUserMessage_1 = { extractUserText, unwrapExternalEnvelope, extractExternalDisplayContent, isDisplayableExternalUser, isRealUserMessage };
    const sdkBranchFilter_1 = { filterActiveBranchEntries };
    const sdkMessageProjection_1 = { createSDKProjectionState, advanceSDKProjection, getSDKProjectionKind, isSDKMessageProjectionSkipped };
    const options = {
      ...workerData.options,
      onProgress: (bytesRead, snapshotSize) => parentPort.postMessage({ kind: 'progress', bytesRead, snapshotSize }),
      onFinalize: () => parentPort.postMessage({ kind: 'finalize' }),
    };
    buildDirect(workerData.filePath, options).then(result => parentPort.postMessage({ kind: 'result', result }), error => parentPort.postMessage({ kind: 'result', result: { status: 'failed', error: String(error) } }));
  `;
  return new Promise((resolve, reject) => {
    const { onProgress: _, onFinalize: __, signal: ___, ...workerOptions } = options;
    const worker = new Worker(source, { eval: true, workerData: { filePath, options: { ...workerOptions, useWorker: false } } });
    let settled = false;
    const finish = (result: TranscriptIndexResult): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => {
      void worker.terminate();
      finish({ status: 'failed', error: 'History index build aborted' });
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.on('message', message => {
      const payload = message as { kind: 'progress'; bytesRead: number; snapshotSize: number }
        | { kind: 'finalize' }
        | { kind: 'result'; result: TranscriptIndexResult };
      if (payload.kind === 'progress') options.onProgress?.(payload.bytesRead, payload.snapshotSize);
      else if (payload.kind === 'finalize') options.onFinalize?.();
      else finish(payload.result);
    });
    worker.once('error', error => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    worker.once('exit', code => {
      if (code === 0 || settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      reject(new Error(`History index worker exited with code ${code}`));
    });
  });
}

const requests = new Map<string, Promise<TranscriptIndexResult>>();

export interface TranscriptIndexDiagnosticEvent {
  phase: 'index_worker_fallback' | 'queued' | 'start' | 'progress' | 'finalize' | 'complete' | 'failed' | 'aborted' | 'stalled';
  errorName?: string;
  buildId?: string;
  mode?: 'worker' | 'direct';
  queueMs?: number;
  elapsedMs?: number;
  bytes?: number;
  totalBytes?: number;
  entries?: number;
  turns?: number;
}

type TranscriptIndexDiagnosticSink = (event: TranscriptIndexDiagnosticEvent) => void;
let diagnosticSink: TranscriptIndexDiagnosticSink | null = null;

export function setTranscriptIndexDiagnosticSink(sink: TranscriptIndexDiagnosticSink | null): void {
  diagnosticSink = sink;
}

// Electron renderer processes run on a V8 platform without worker_threads support:
// `new Worker` throws synchronously. Probe once per process; while unavailable, the
// streaming main-thread path builds the index instead. Re-probing only happens after
// a module reload, so future Electron support recovers without code changes.
let workerAvailability: boolean | null = null;
let workerProbe: Promise<boolean> | null = null;
let directBuildTail = Promise.resolve();
let buildSequence = 0;

function observeBuild(
  buildId: string,
  mode: 'worker' | 'direct',
  queuedAt: number,
  options: BuildOptions,
  run: (observedOptions: BuildOptions) => Promise<TranscriptIndexResult>,
  recordRejection = true,
): Promise<TranscriptIndexResult> {
  const startedAt = performance.now();
  let lastBytes = 0;
  let totalBytes = 0;
  let lastAdvanceAt = startedAt;
  let lastProgressAt = -Infinity;
  let lastProgressPercent = -Infinity;
  let stalledReported = false;
  diagnosticSink?.({ phase: 'start', buildId, mode, queueMs: startedAt - queuedAt });
  const stalledTimer = setInterval(() => {
    const now = performance.now();
    if (!stalledReported && now - lastAdvanceAt >= 30_000) {
      stalledReported = true;
      diagnosticSink?.({ phase: 'stalled', buildId, mode, elapsedMs: now - startedAt, bytes: lastBytes, totalBytes });
    }
  }, 1_000);
  const observedOptions: BuildOptions = {
    ...options,
    onProgress: (bytes, total) => {
      options.onProgress?.(bytes, total);
      const now = performance.now();
      if (bytes > lastBytes) {
        lastAdvanceAt = now;
        stalledReported = false;
      }
      lastBytes = bytes;
      totalBytes = total;
      const percent = total > 0 ? bytes / total * 100 : 100;
      if (now - lastProgressAt >= 2_000 || percent - lastProgressPercent >= 5 || bytes === total) {
        lastProgressAt = now;
        lastProgressPercent = percent;
        diagnosticSink?.({ phase: 'progress', buildId, mode, elapsedMs: now - startedAt, bytes, totalBytes: total });
      }
    },
    onFinalize: () => {
      options.onFinalize?.();
      diagnosticSink?.({ phase: 'finalize', buildId, mode, elapsedMs: performance.now() - startedAt, bytes: lastBytes, totalBytes });
    },
  };
  return run(observedOptions).then(result => {
    const elapsedMs = performance.now() - startedAt;
    if (result.status === 'failed') {
      const aborted = options.signal?.aborted || /aborted/i.test(result.error);
      diagnosticSink?.({ phase: aborted ? 'aborted' : 'failed', buildId, mode, elapsedMs, errorName: aborted ? 'AbortError' : 'Error' });
    } else {
      diagnosticSink?.({
        phase: 'complete', buildId, mode, elapsedMs,
        bytes: result.index.snapshotSize, totalBytes: result.index.snapshotSize,
        entries: result.index.entries.length, turns: result.index.turns.length,
      });
    }
    return result;
  }, error => {
    if (recordRejection || options.signal?.aborted) {
      const aborted = options.signal?.aborted;
      diagnosticSink?.({ phase: aborted ? 'aborted' : 'failed', buildId, mode, elapsedMs: performance.now() - startedAt, errorName: error instanceof Error ? error.name : 'UnknownError' });
    }
    throw error;
  }).finally(() => clearInterval(stalledTimer));
}

function recordWorkerFallback(error: unknown): void {
  diagnosticSink?.({
    phase: 'index_worker_fallback',
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
}

async function probeWorkerAvailability(): Promise<boolean> {
  if (workerAvailability !== null) return workerAvailability;
  if (workerProbe) return workerProbe;
  const probe = new Promise<boolean>(resolve => {
    let worker: Worker;
    try {
      worker = new Worker('require("worker_threads").parentPort.postMessage("ready")', { eval: true });
    } catch (error) {
      workerAvailability = false;
      recordWorkerFallback(error);
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (available: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      workerAvailability = available;
      if (!available) recordWorkerFallback(error);
      void worker.terminate();
      resolve(available);
    };
    const timeout = setTimeout(() => finish(false, new Error('History index worker probe timed out')), 1_000);
    worker.once('message', () => finish(true));
    worker.once('error', error => finish(false, error));
    worker.once('exit', code => {
      if (code !== 0) finish(false, new Error(`History index worker probe exited with code ${code}`));
    });
  });
  workerProbe = probe.finally(() => { workerProbe = null; });
  return workerProbe;
}

function scheduleDirectBuild(filePath: string, options: BuildOptions, buildId = `index-${Date.now().toString(36)}-${(++buildSequence).toString(36)}`): Promise<TranscriptIndexResult> {
  const queuedAt = performance.now();
  diagnosticSink?.({ phase: 'queued', buildId, mode: 'direct' });
  const build = directBuildTail.then(async () => {
    throwIfAborted(options.signal);
    return observeBuild(buildId, 'direct', queuedAt, options, observed => buildDirect(filePath, observed));
  }, async () => {
    throwIfAborted(options.signal);
    return observeBuild(buildId, 'direct', queuedAt, options, observed => buildDirect(filePath, observed));
  });
  directBuildTail = build.then(() => undefined, () => undefined);
  return build.catch(error => {
    diagnosticSink?.({
      phase: options.signal?.aborted ? 'aborted' : 'failed',
      buildId,
      mode: 'direct',
      elapsedMs: performance.now() - queuedAt,
      errorName: options.signal?.aborted ? 'AbortError' : (error instanceof Error ? error.name : 'UnknownError'),
    });
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  });
}

export function resetTranscriptIndexWorkerProbe(): void {
  workerAvailability = null;
  workerProbe = null;
}

export function buildTranscriptIndex(filePath: string, options: BuildOptions = {}): Promise<TranscriptIndexResult> {
  const requestKey = `${filePath}:${options.chunkSize ?? DEFAULT_CHUNK_SIZE}:${options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES}:${options.useWorker !== false}:${options.resumeAtMessageId ?? ''}`;
  const existingRequest = requests.get(requestKey);
  if (existingRequest) return existingRequest;
  const request = snapshotKey(filePath).then(key => {
    const cached = completed.get(key);
    if (cached) {
      touchCompleted(key, cached);
      return cached;
    }
    const existing = inFlight.get(key);
    if (existing) return existing;
    const build = (async (): Promise<TranscriptIndexResult> => {
      if (options.useWorker === false || !await probeWorkerAvailability()) {
        return scheduleDirectBuild(filePath, options);
      }
      try {
        const queuedAt = performance.now();
        const buildId = `index-${Date.now().toString(36)}-${(++buildSequence).toString(36)}`;
        diagnosticSink?.({ phase: 'queued', buildId, mode: 'worker' });
        try {
          return await observeBuild(buildId, 'worker', queuedAt, options, observed => buildInWorker(filePath, observed), false);
        } catch (error) {
          workerAvailability = false;
          recordWorkerFallback(error);
          return scheduleDirectBuild(filePath, options, buildId);
        }
      } catch (error) {
        return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    })();
    inFlight.set(key, build);
    // Same supersede race as the request cache below, one layer deeper: an
    // aborted build only settles after its scanSnapshot close() IO completes,
    // so a same-tick rebuild would otherwise join the doomed in-flight build.
    const removeInFlight = (): void => {
      if (inFlight.get(key) === build) inFlight.delete(key);
    };
    options.signal?.addEventListener('abort', removeInFlight, { once: true });
    void build.then(result => {
      options.signal?.removeEventListener('abort', removeInFlight);
      inFlight.delete(key);
      if (result.status !== 'failed') {
        touchCompleted(key, result);
        evictCompleted();
      }
    });
    return build;
  });
  requests.set(requestKey, request);
  // A supersede caller aborts the old controller and synchronously starts a
  // new build for the same request key; the .finally cleanup below only runs
  // on a later microtask, so the doomed entry must leave the shared cache
  // inside the abort listener itself.
  const removeRequest = (): void => {
    if (requests.get(requestKey) === request) requests.delete(requestKey);
  };
  options.signal?.addEventListener('abort', removeRequest, { once: true });
  void request.finally(() => {
    options.signal?.removeEventListener('abort', removeRequest);
    removeRequest();
  });
  return request;
}

async function readIndexEntries(
  index: TranscriptHistoryIndex,
  entries: TranscriptIndexEntry[],
): Promise<SDKNativeMessage[]> {
  const info = await stat(index.filePath);
  if (info.dev !== index.dev || info.ino !== index.ino || info.size < index.snapshotSize) {
    throw new Error('Transcript index invalidated by replacement or truncation');
  }
  const handle = await open(index.filePath, 'r');
  try {
    const messages: SDKNativeMessage[] = [];
    for (const entry of entries) {
      const buffer = Buffer.allocUnsafe(entry.length);
      const { bytesRead } = await handle.read(buffer, 0, entry.length, entry.offset);
      if (bytesRead !== entry.length) throw new Error(`Short transcript read at offset ${entry.offset}`);
      messages.push(JSON.parse(buffer.toString('utf8').replace(/\r$/, '')) as SDKNativeMessage);
    }
    return messages;
  } finally {
    await handle.close();
  }
}

export async function materializeTranscriptPage(
  index: TranscriptHistoryIndex,
  startTurn: number,
  turnCount: number,
): Promise<SDKNativeMessage[]> {
  const selected = index.turns.slice(startTurn, startTurn + turnCount);
  if (selected.length === 0) return [];
  const first = selected[0].startEntry;
  const last = selected[selected.length - 1].endEntry;
  return readIndexEntries(index, index.entries.slice(first, last + 1));
}

export async function materializeTranscriptToolAssociations(
  index: TranscriptHistoryIndex,
  pageEntries: SDKNativeMessage[],
): Promise<SDKNativeMessage[]> {
  const wanted = new Set<string>();
  for (const message of pageEntries) {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) wanted.add(block.id);
      if (block.type === 'tool_result' && block.tool_use_id) wanted.add(block.tool_use_id);
    }
  }
  if (wanted.size === 0) return pageEntries;
  const associations = index.entries.filter(entry =>
    entry.toolUseIds.some(id => wanted.has(id)) || entry.toolResultIds.some(id => wanted.has(id))
  );
  const extras = await readIndexEntries(index, associations);
  const byUuid = new Set(pageEntries.map(message => message.uuid).filter(Boolean));
  return [...pageEntries, ...extras.filter(message => !message.uuid || !byUuid.has(message.uuid))];
}

export function protectTranscriptIndex(filePath: string): void {
  protectedPaths.set(filePath, (protectedPaths.get(filePath) ?? 0) + 1);
}

export function releaseTranscriptIndex(filePath: string): void {
  const count = protectedPaths.get(filePath) ?? 0;
  if (count <= 1) protectedPaths.delete(filePath);
  else protectedPaths.set(filePath, count - 1);
  evictCompleted();
}

/** Evicts only unprotected completed indexes; active and in-flight indexes survive. */
export function clearTranscriptIndexCache(): void {
  for (const [key, result] of completed) {
    if (result.status === 'failed' || !isProtectedCompletedKey(key, result)) completed.delete(key);
  }
  evictCompleted();
}

export function getTranscriptIndexCacheSize(): number {
  return completed.size;
}
