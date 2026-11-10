import { type FileHandle, open, stat } from 'fs/promises';
import { Worker } from 'worker_threads';

import { isCompactionCanceledStderr } from '../../../utils/interrupt';
import {
  extractExternalDisplayContent,
  extractUserText,
  isDisplayableExternalUser,
  isRealUserMessage,
  unwrapExternalEnvelope,
} from './externalUserMessage';
import { buildOpaqueOversizedPlaceholders } from './HistorySummaryProjection';
import { isRebuiltContextMessage } from './rebuiltContext';
import { filterActiveBranchEntries } from './sdkBranchFilter';
import type { SDKNativeMessage } from './sdkHistoryTypes';
import {
  advanceSDKProjection,
  createSDKProjectionState,
  getSDKProjectionKind,
  isSDKMessageProjectionSkipped,
} from './sdkMessageProjection';

// Exists only in the eval'd worker source (see buildInWorker); declared so the
// serialized helper sources type-check against the worker-local binding.
declare const HISTORY_OMISSION_MARKER: string;

const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
// Bounded prefix read used to extract reliable identity facts from an
// oversized line; anything past this bound stays unknown rather than guessed.
const OVERSIZED_FACTS_READ_BYTES = 256 * 1024;
// Bounded tail read, symmetric with the prefix budget: CC rows keep uuid/
// timestamp after the message payload and a short structural tail, so a giant
// message.content hides identity from the prefix while the tail still sees it.
// Worst-case dual reads stay at 512 KiB per oversized row. A row occluded at
// both bounds stays unresolved — recovery must be provable, not guessed.
const OVERSIZED_FACTS_TAIL_READ_BYTES = 256 * 1024;
const OVERSIZED_FACTS_STRING_CAP = 4096;

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
  /** Opaque stand-in for a line that exceeded maxLineBytes; never read back. */
  oversized?: boolean;
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
  /** Canonical entry index of the first contributing row: structural ordering key. */
  entryIndex: number;
  timestamp?: string;
  textOffset: number;
  textLength: number;
}

export interface TranscriptProjectionDescriptor {
  projectionKey: string;
  turnIndex: number;
  startEntry: number;
  endEntry: number;
  sourceBytes: number;
}

export interface TranscriptHistoryIndex {
  filePath: string;
  dev: number;
  ino: number;
  snapshotSize: number;
  mtimeMs: number;
  ctimeMs: number;
  readonly projectionVariantKey: string;
  /** Offset just past the last fully processed newline; tail reads start here. */
  committedSize: number;
  entries: TranscriptIndexEntry[];
  turns: TranscriptTurnIndex[];
  searchCorpus: TranscriptSearchCorpusItem[];
  searchText: string;
  projectionDescriptors?: TranscriptProjectionDescriptor[];
  skippedLines: number;
  buildDurationMs: number;
  peakWorkerHeapBytes: number;
}

export type TranscriptIndexResult =
  | { status: 'complete'; index: TranscriptHistoryIndex; fromCache?: true }
  | { status: 'partial'; index: TranscriptHistoryIndex; error: string; fromCache?: true }
  | { status: 'failed'; error: string };

export type OversizedIdentityRecovery = 'prefix' | 'suffix' | 'both' | 'unresolved' | 'conflict';
export type OversizedIdentityField = 'uuid' | 'parentUuid' | 'type' | 'timestamp';

export interface TranscriptLineSkipEvent {
  reason: 'oversized' | 'malformed';
  offset: number;
  bytes: number;
  /** Oversized-row identity provenance; absent for malformed lines. */
  identityRecovery?: OversizedIdentityRecovery;
  /** Recovered identity field names only — never values. */
  recoveredIdentityFields?: OversizedIdentityField[];
}

interface BuildOptions {
  chunkSize?: number;
  maxLineBytes?: number;
  useWorker?: boolean;
  resumeAtMessageId?: string;
  /** Reobserve the source; an unchanged snapshot may still use the completed cache. */
  forceNewSnapshot?: boolean;
  signal?: AbortSignal;
  onProgress?: (bytesRead: number, snapshotSize: number) => void;
  onFinalize?: () => void;
  onLineSkipped?: (event: TranscriptLineSkipEvent) => void;
  /** Synchronous handoff: retain a successful index before its temporary flight pin is released. */
  onIndex?: (index: TranscriptHistoryIndex) => void;
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
  rebuiltContext: boolean;
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
    rebuiltContext: isRebuiltContextMessage(message),
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

interface OversizedLineFacts {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sourceToolUseID?: string;
  toolResultIds: string[];
}

/** Decodes a bounded raw string token; null when over cap or unparseable. */
function decodeBoundedJsonString(raw: string): string | null {
  if (raw.length > OVERSIZED_FACTS_STRING_CAP) return null;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

/**
 * Structure-aware scanner over the bounded prefix of an oversized JSONL row.
 * Walks object/array nesting and string-token boundaries so keys that merely
 * occur inside string values can never be mistaken for real fields; whatever
 * the read bound cuts off stays unknown rather than guessed.
 */
function parseOversizedLineFacts(buffer: Buffer): OversizedLineFacts | null {
  let pos = 0;
  const end = buffer.length;
  const facts: OversizedLineFacts = { toolResultIds: [] };

  const skipWhitespace = (): void => {
    while (pos < end) {
      const byte = buffer[pos];
      if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) pos += 1;
      else break;
    }
  };

  // Scans a JSON string token. Returns null when the buffer cuts the token
  // (its extent is unknowable, the walk must stop) and value null when the
  // string is complete but unusable (over cap / unparseable escapes).
  const scanString = (): { value: string | null; next: number } | null => {
    if (pos >= end || buffer[pos] !== 0x22) return null;
    let cursor = pos + 1;
    while (cursor < end) {
      const byte = buffer[cursor];
      if (byte === 0x5c) {
        cursor += 2;
        continue;
      }
      if (byte === 0x22) {
        const raw = buffer.toString('utf8', pos + 1, cursor);
        return { value: decodeBoundedJsonString(raw), next: cursor + 1 };
      }
      cursor += 1;
    }
    return null;
  };

  // Generic value skipper (numbers, literals, strings, nested containers).
  // Returns false when the buffer cut the value mid-token.
  const skipValue = (): boolean => {
    skipWhitespace();
    if (pos >= end) return false;
    const byte = buffer[pos];
    if (byte === 0x22) {
      const scanned = scanString();
      if (!scanned) return false;
      pos = scanned.next;
      return true;
    }
    if (byte === 0x7b || byte === 0x5b) return skipContainer();
    const start = pos;
    while (pos < end) {
      const b = buffer[pos];
      if (b === 0x2c || b === 0x7d || b === 0x5d || b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) break;
      pos += 1;
    }
    return pos > start;
  };

  const skipContainer = (): boolean => {
    const opener = buffer[pos];
    const closer = opener === 0x7b ? 0x7d : 0x5d;
    pos += 1;
    skipWhitespace();
    if (pos < end && buffer[pos] === closer) {
      pos += 1;
      return true;
    }
    for (;;) {
      skipWhitespace();
      if (pos >= end) return false;
      if (opener === 0x7b) {
        if (buffer[pos] !== 0x22) return false;
        const key = scanString();
        if (!key) return false;
        pos = key.next;
        skipWhitespace();
        if (pos >= end || buffer[pos] !== 0x3a) return false;
        pos += 1;
      }
      if (!skipValue()) return false;
      skipWhitespace();
      if (pos >= end) return false;
      if (buffer[pos] === 0x2c) {
        pos += 1;
        continue;
      }
      if (buffer[pos] === closer) {
        pos += 1;
        return true;
      }
      return false;
    }
  };

  type VisitResult = 'consumed' | 'delegate' | 'cut';

  // pos sits on '{'. The visitor consumes watched keys' values itself.
  const walkObject = (visit: (key: string | null) => VisitResult): boolean => {
    pos += 1;
    for (;;) {
      skipWhitespace();
      if (pos >= end) return false;
      if (buffer[pos] === 0x7d) {
        pos += 1;
        return true;
      }
      if (buffer[pos] !== 0x22) return false;
      const key = scanString();
      if (!key) return false;
      pos = key.next;
      skipWhitespace();
      if (pos >= end || buffer[pos] !== 0x3a) return false;
      pos += 1;
      const result = visit(key.value);
      if (result === 'cut') return false;
      if (result === 'delegate' && !skipValue()) return false;
      skipWhitespace();
      if (pos >= end) return false;
      if (buffer[pos] === 0x2c) {
        pos += 1;
        continue;
      }
      if (buffer[pos] === 0x7d) {
        pos += 1;
        return true;
      }
      return false;
    }
  };

  // pos sits on '['. The visitor consumes watched elements itself.
  const walkArray = (visitElement: () => VisitResult): boolean => {
    pos += 1;
    for (;;) {
      skipWhitespace();
      if (pos >= end) return false;
      if (buffer[pos] === 0x5d) {
        pos += 1;
        return true;
      }
      const result = visitElement();
      if (result === 'cut') return false;
      if (result === 'delegate' && !skipValue()) return false;
      skipWhitespace();
      if (pos >= end) return false;
      if (buffer[pos] === 0x2c) {
        pos += 1;
        continue;
      }
      if (buffer[pos] === 0x5d) {
        pos += 1;
        return true;
      }
      return false;
    }
  };

  // Reads a string value at pos; 'cut' means the buffer ended mid-token.
  const readStringHere = (): 'cut' | { consumed: false } | { consumed: true; value: string | null } => {
    skipWhitespace();
    if (pos >= end) return 'cut';
    if (buffer[pos] !== 0x22) return { consumed: false };
    const scanned = scanString();
    if (!scanned) return 'cut';
    pos = scanned.next;
    return { consumed: true, value: scanned.value };
  };

  skipWhitespace();
  if (pos >= end || buffer[pos] !== 0x7b) return null;
  // A cut or malformed structure keeps every fact collected so far: each of
  // them was verified at its own structural position in the real bytes.
  walkObject(key => {
    if (key === 'message') {
      skipWhitespace();
      if (pos >= end) return 'cut';
      if (buffer[pos] !== 0x7b) return 'delegate';
      const messageOk = walkObject(messageKey => {
        if (messageKey !== 'content') return 'delegate';
        skipWhitespace();
        if (pos >= end) return 'cut';
        if (buffer[pos] !== 0x5b) return 'delegate';
        const contentOk = walkArray(() => {
          skipWhitespace();
          if (pos >= end) return 'cut';
          if (buffer[pos] !== 0x7b) return 'delegate';
          let isToolResult = false;
          return walkObject(blockKey => {
            if (blockKey === 'type') {
              const value = readStringHere();
              if (value === 'cut') return 'cut';
              if (value.consumed) isToolResult = value.value === 'tool_result';
              return 'consumed';
            }
            if (blockKey === 'tool_use_id' && isToolResult) {
              const value = readStringHere();
              if (value === 'cut') return 'cut';
              if (value.consumed && value.value !== null && !facts.toolResultIds.includes(value.value)) {
                facts.toolResultIds.push(value.value);
              }
              return 'consumed';
            }
            return 'delegate';
          }) ? 'consumed' : 'cut';
        });
        return contentOk ? 'consumed' : 'cut';
      });
      return messageOk ? 'consumed' : 'cut';
    }
    if (key === 'parentUuid') {
      skipWhitespace();
      if (pos >= end) return 'cut';
      if (buffer[pos] === 0x6e) {
        if (!skipValue()) return 'cut';
        if (facts.parentUuid === undefined) facts.parentUuid = null;
        return 'consumed';
      }
    }
    if (key !== 'type' && key !== 'uuid' && key !== 'parentUuid' && key !== 'timestamp' && key !== 'sourceToolUseID') {
      return 'delegate';
    }
    const value = readStringHere();
    if (value === 'cut') return 'cut';
    if (!value.consumed) return 'delegate';
    if (value.value !== null) {
      if (key === 'type' && facts.type === undefined) facts.type = value.value;
      else if (key === 'uuid' && facts.uuid === undefined) facts.uuid = value.value;
      else if (key === 'parentUuid' && facts.parentUuid === undefined) facts.parentUuid = value.value;
      else if (key === 'timestamp' && facts.timestamp === undefined) facts.timestamp = value.value;
      else if (key === 'sourceToolUseID' && facts.sourceToolUseID === undefined) facts.sourceToolUseID = value.value;
    }
    return 'consumed';
  });
  return facts;
}

/**
 * Structure-aware scanner over the bounded tail of an oversized JSONL row,
 * mirroring parseOversizedLineFacts from the real end of the row backwards.
 * Only top-level identity fields (uuid/parentUuid/timestamp/type/
 * sourceToolUseID, plus a literal null parentUuid) are accepted; strings are
 * skipped as whole tokens by tracking escapes through backslash parity, so
 * keys occurring inside message/toolUseResult text can never masquerade as
 * fields. Anything the tail bound cuts off stays unknown.
 */
function parseOversizedLineFactsSuffix(buffer: Buffer): OversizedLineFacts | null {
  const facts: OversizedLineFacts = { toolResultIds: [] };
  let pos = buffer.length - 1;

  const skipWhitespaceBackward = (): void => {
    while (pos >= 0) {
      const byte = buffer[pos];
      if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) pos -= 1;
      else break;
    }
  };

  // pos sits on a string token's closing quote; returns the opening quote
  // position, or -1 when the window cuts the token (escape parity decides
  // which quotes are real terminators while walking left).
  const scanStringBackward = (): number => {
    let cursor = pos - 1;
    while (cursor >= 0) {
      if (buffer[cursor] === 0x22) {
        let slashes = 0;
        let probe = cursor - 1;
        while (probe >= 0 && buffer[probe] === 0x5c) { slashes += 1; probe -= 1; }
        if (slashes % 2 === 0) return cursor;
      }
      cursor -= 1;
    }
    return -1;
  };

  // pos sits on `}`/`]`; returns the matching opener position, or -1 when the
  // window cuts the container. Strings inside are skipped whole so brackets
  // in string values never disturb the depth count.
  const skipContainerBackward = (): number => {
    const closer = buffer[pos];
    const opener = closer === 0x7d ? 0x7b : 0x5b;
    let depth = 0;
    let cursor = pos;
    while (cursor >= 0) {
      const byte = buffer[cursor];
      if (byte === 0x22) {
        pos = cursor;
        const open = scanStringBackward();
        if (open < 0) return -1;
        cursor = open - 1;
        continue;
      }
      if (byte === 0x7d || byte === 0x5d) depth += 1;
      else if (byte === 0x7b || byte === 0x5b) {
        depth -= 1;
        if (depth === 0) return byte === opener ? cursor : -1;
      }
      cursor -= 1;
    }
    return -1;
  };

  skipWhitespaceBackward();
  if (pos < 0 || buffer[pos] !== 0x7d) return null;
  pos -= 1;
  // Like the forward scanner, a cut structure keeps every fact collected so
  // far: each of them was verified at its own structural position in the
  // real bytes, and the tail bound cutting mid-payload is the normal case.
  for (;;) {
    skipWhitespaceBackward();
    if (pos < 0) return facts;
    if (buffer[pos] === 0x7b) return facts;
    // Value: walking right-to-left the value's right edge comes first.
    let stringValue: string | null | undefined;
    let literalText: string | undefined;
    const byte = buffer[pos];
    if (byte === 0x22) {
      const open = scanStringBackward();
      if (open < 0) return facts;
      stringValue = decodeBoundedJsonString(buffer.toString('utf8', open + 1, pos));
      pos = open - 1;
    } else if (byte === 0x7d || byte === 0x5d) {
      const open = skipContainerBackward();
      if (open < 0) return facts;
      pos = open - 1;
    } else {
      let cursor = pos;
      while (cursor >= 0) {
        const b = buffer[cursor];
        if (b === 0x2c || b === 0x3a || b === 0x7b || b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) break;
        cursor -= 1;
      }
      if (cursor < 0) return facts;
      literalText = buffer.toString('utf8', cursor + 1, pos + 1);
      pos = cursor;
    }
    skipWhitespaceBackward();
    if (pos < 0 || buffer[pos] !== 0x3a) return facts;
    pos -= 1;
    skipWhitespaceBackward();
    if (pos < 0 || buffer[pos] !== 0x22) return facts;
    const keyOpen = scanStringBackward();
    if (keyOpen < 0) return facts;
    const key = buffer.toString('utf8', keyOpen + 1, pos);
    if (key.length <= OVERSIZED_FACTS_STRING_CAP) {
      // First occurrence seen wins from the right (JSON.parse semantics for
      // duplicate keys); the forward scanner keeps the leftmost, so a real
      // duplicate surfaces as a merge conflict instead of a silent pick.
      if (stringValue !== undefined && stringValue !== null) {
        if (key === 'type' && facts.type === undefined) facts.type = stringValue;
        else if (key === 'uuid' && facts.uuid === undefined) facts.uuid = stringValue;
        else if (key === 'parentUuid' && facts.parentUuid === undefined) facts.parentUuid = stringValue;
        else if (key === 'timestamp' && facts.timestamp === undefined) facts.timestamp = stringValue;
        else if (key === 'sourceToolUseID' && facts.sourceToolUseID === undefined) facts.sourceToolUseID = stringValue;
      } else if (key === 'parentUuid' && literalText === 'null' && facts.parentUuid === undefined) {
        facts.parentUuid = null;
      }
    }
    pos = keyOpen - 1;
    skipWhitespaceBackward();
    if (pos < 0) return facts;
    if (buffer[pos] === 0x2c) { pos -= 1; continue; }
    if (buffer[pos] === 0x7b) return facts;
    return facts;
  }
}

function listOversizedIdentityFields(facts: OversizedLineFacts | null): OversizedIdentityField[] {
  if (!facts) return [];
  const fields: OversizedIdentityField[] = [];
  if (facts.uuid !== undefined) fields.push('uuid');
  if (facts.parentUuid !== undefined) fields.push('parentUuid');
  if (facts.type !== undefined) fields.push('type');
  if (facts.timestamp !== undefined) fields.push('timestamp');
  return fields;
}

interface OversizedLineRecovery {
  facts: OversizedLineFacts | null;
  identityRecovery: OversizedIdentityRecovery;
  recoveredIdentityFields: OversizedIdentityField[];
}

/**
 * Conservative per-field merge of the two bounded scans: one-sided values are
 * adopted, agreeing values kept, and conflicts dropped to unknown — never
 * guessed. toolResultIds stay prefix-sourced because their structure lives
 * inside the message payload the tail scan deliberately never enters.
 */
function mergeOversizedLineFacts(
  prefix: OversizedLineFacts | null,
  suffix: OversizedLineFacts | null,
): OversizedLineRecovery {
  const facts: OversizedLineFacts = { toolResultIds: prefix?.toolResultIds ?? [] };
  let conflict = false;
  const mergeString = (key: 'type' | 'uuid' | 'timestamp' | 'sourceToolUseID'): void => {
    const fromPrefix = prefix?.[key];
    const fromSuffix = suffix?.[key];
    if (fromPrefix !== undefined && fromSuffix !== undefined && fromPrefix !== fromSuffix) {
      conflict = true;
      return;
    }
    if (fromPrefix !== undefined) facts[key] = fromPrefix;
    else if (fromSuffix !== undefined) facts[key] = fromSuffix;
  };
  const prefixParent = prefix?.parentUuid;
  const suffixParent = suffix?.parentUuid;
  if (prefixParent !== undefined && suffixParent !== undefined && prefixParent !== suffixParent) conflict = true;
  else if (prefixParent !== undefined) facts.parentUuid = prefixParent;
  else if (suffixParent !== undefined) facts.parentUuid = suffixParent;
  mergeString('type');
  mergeString('uuid');
  mergeString('timestamp');
  mergeString('sourceToolUseID');
  let identityRecovery: OversizedIdentityRecovery;
  if (conflict) identityRecovery = 'conflict';
  else if (facts.uuid === undefined) identityRecovery = 'unresolved';
  else if (prefix?.uuid !== undefined && suffix?.uuid !== undefined) identityRecovery = 'both';
  else if (prefix?.uuid !== undefined) identityRecovery = 'prefix';
  else identityRecovery = 'suffix';
  return { facts, identityRecovery, recoveredIdentityFields: listOversizedIdentityFields(facts) };
}

async function extractOversizedLineFacts(
  handle: FileHandle,
  offset: number,
  length: number,
): Promise<OversizedLineRecovery> {
  const unresolved: OversizedLineRecovery = { facts: null, identityRecovery: 'unresolved', recoveredIdentityFields: [] };
  const prefixLength = Math.min(OVERSIZED_FACTS_READ_BYTES, length);
  if (prefixLength <= 0) return unresolved;
  const prefixBuffer = Buffer.allocUnsafe(prefixLength);
  const { bytesRead: prefixRead } = await handle.read(prefixBuffer, 0, prefixLength, offset);
  if (prefixRead <= 0) return unresolved;
  const tailLength = Math.min(OVERSIZED_FACTS_TAIL_READ_BYTES, length);
  const tailStart = offset + length - tailLength;
  if (tailStart <= offset + prefixRead) {
    // The windows overlap: scan the merged coverage (bounded by both
    // budgets) once with the forward scanner instead of interpreting
    // the row twice.
    const mergedLength = Math.min(length, prefixRead + tailLength);
    const mergedBuffer = Buffer.allocUnsafe(mergedLength);
    const { bytesRead } = await handle.read(mergedBuffer, 0, mergedLength, offset);
    if (bytesRead <= 0) return unresolved;
    const facts = parseOversizedLineFacts(mergedBuffer.subarray(0, bytesRead));
    return {
      facts,
      identityRecovery: facts?.uuid !== undefined ? 'prefix' : 'unresolved',
      recoveredIdentityFields: listOversizedIdentityFields(facts),
    };
  }
  const tailBuffer = Buffer.allocUnsafe(tailLength);
  const { bytesRead: tailRead } = await handle.read(tailBuffer, 0, tailLength, tailStart);
  const prefixFacts = parseOversizedLineFacts(prefixBuffer.subarray(0, prefixRead));
  if (tailRead <= 0) return mergeOversizedLineFacts(prefixFacts, null);
  const suffixFacts = parseOversizedLineFactsSuffix(tailBuffer.subarray(0, tailRead));
  return mergeOversizedLineFacts(prefixFacts, suffixFacts);
}

async function appendOversizedEntry(
  handle: FileHandle,
  entries: RawIndexEntry[],
  offset: number,
  length: number,
  lineNumber: number,
): Promise<OversizedLineRecovery> {
  const recovery = await extractOversizedLineFacts(handle, offset, length);
  const facts = recovery.facts;
  entries.push({
    offset,
    length,
    // Facts the bounded scans could not reliably read stay unknown; the
    // opaque entry must not guess a type/uuid it never saw.
    type: facts?.type ?? 'unknown',
    messageKey: facts?.uuid ?? `line:${lineNumber}`,
    uuid: facts?.uuid,
    parentUuid: facts?.parentUuid,
    timestamp: facts?.timestamp,
    realUser: false,
    displayable: false,
    isMeta: false,
    sourceToolUseID: facts?.sourceToolUseID,
    toolUseIds: [],
    toolResultIds: facts?.toolResultIds ?? [],
    rebuiltContext: false,
    projectionKind: 'skip',
    oversized: true,
  });
  return recovery;
}

async function finalizeIndex(
  filePath: string,
  snapshot: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  rawEntries: RawIndexEntry[],
  skippedLines: number,
  committedSize: number,
  projectionVariantKey: string,
  resumeAtMessageId?: string,
  signal?: AbortSignal,
): Promise<TranscriptHistoryIndex> {
  throwIfAborted(signal);
  const oversizedEntries = rawEntries.filter(entry => entry.oversized);
  if (resumeAtMessageId && oversizedEntries.length > 0) {
    // A resume anchor on or behind an opaque row cannot be honored safely:
    // truncation could land on the wrong branch. Refuse explicitly instead
    // of silently ignoring the anchor.
    if (oversizedEntries.some(entry => entry.uuid === resumeAtMessageId)) {
      throw new Error('Transcript resume anchor falls inside an oversized line');
    }
    if (oversizedEntries.some(entry => entry.uuid === undefined || entry.parentUuid === undefined)) {
      // Without reliable uuid/parentUuid we cannot tell which ancestry chains
      // cross the opaque row, so verification is impossible; disable rather
      // than guess.
      throw new Error('Transcript resume anchor cannot be verified: an oversized line is missing reliable uuid/parentUuid');
    }
  }
  // Recovery prompts are transport artifacts, not conversation facts. Remove
  // them before turns, descriptors and search corpus are derived so every
  // projection consumer (window/detail/title/export) shares the same truth.
  const canonical = filterActiveBranchEntries(rawEntries, resumeAtMessageId, entry => entry.realUser)
    .filter(entry => !entry.rebuiltContext);
  await yieldToMainThread(signal);
  let currentTurn: TranscriptTurnIndex | undefined;
  let currentTurnIndex = -1;
  let currentTurnBytes = 0;
  const projection = createSDKProjectionState();
  const turns: TranscriptTurnIndex[] = [];
  const searchCorpus: TranscriptSearchCorpusItem[] = [];
  const searchTextParts: string[] = [];
  const projectionDescriptors: TranscriptProjectionDescriptor[] = [];
  const descriptorByKey = new Map<string, TranscriptProjectionDescriptor>();
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
    if (projectionKey && currentTurnIndex >= 0) {
      const existingDescriptor = descriptorByKey.get(projectionKey);
      if (existingDescriptor) {
        existingDescriptor.endEntry = index;
        existingDescriptor.sourceBytes += entry.length;
      } else {
        const descriptor = {
          projectionKey,
          turnIndex: currentTurnIndex,
          startEntry: index,
          endEntry: index,
          sourceBytes: entry.length,
        };
        descriptorByKey.set(projectionKey, descriptor);
        projectionDescriptors.push(descriptor);
      }
    }
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
          entryIndex: index,
          timestamp: entry.timestamp,
          textOffset: searchTextLength,
          textLength: entry.searchText.length,
        });
      }
      searchTextLength += separator.length + entry.searchText.length;
    }
    delete entry.originMessageId;
    delete entry.searchText;
    delete (entry as Partial<RawIndexEntry>).rebuiltContext;
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
    ctimeMs: snapshot.ctimeMs,
    projectionVariantKey,
    committedSize,
    entries: canonical,
    turns,
    searchCorpus,
    searchText: searchTextParts.join(''),
    projectionDescriptors,
    skippedLines,
    buildDurationMs: 0,
    peakWorkerHeapBytes: 0,
  };
}

async function scanSnapshot(
  filePath: string,
  chunkSize: number,
  maxLineBytes: number,
  onLineSkipped?: (event: TranscriptLineSkipEvent) => void,
  onProgress?: (bytesRead: number, snapshotSize: number) => void,
  signal?: AbortSignal,
): Promise<{
  entries: RawIndexEntry[];
  skippedLines: number;
  incomplete: boolean;
  committedSize: number;
  snapshot: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
  peakHeapBytes: number;
}> {
  const handle = await open(filePath, 'r');
  const info = await handle.stat();
  const snapshot = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  const entries: RawIndexEntry[] = [];
  let skippedLines = 0;
  let position = 0;
  let partial = Buffer.alloc(0);
  let partialOffset = 0;
  let lineNumber = 0;
  // Offset just past the last fully processed newline. Everything before it
  // is committed index content; the tail reader must resume here, never at
  // the stat-time EOF, or a half-written final line would be split in two.
  let committedSize = 0;
  // Oversized-line discard state: once a line passes the cap we stop
  // accumulating it and drop bytes until its closing newline; only then does
  // the opaque entry exist. EOF inside this state leaves the line
  // uncommitted (the build reports partial).
  let discardingOversizedLine = false;
  let oversizedLineOffset = 0;
  let oversizedLineBytes = 0;
  let peakHeapBytes = process.memoryUsage().heapUsed;

  const scanData = async (data: Buffer, dataOffset: number): Promise<void> => {
    let start = 0;
    for (let cursor = 0; cursor < data.length; cursor += 1) {
      if (data[cursor] !== 0x0a) continue;
      const lineOffset = dataOffset + start;
      const line = data.subarray(start, cursor);
      if (line.length > maxLineBytes) {
        const recovery = await appendOversizedEntry(handle, entries, lineOffset, line.length, lineNumber);
        skippedLines += 1;
        onLineSkipped?.({
          reason: 'oversized',
          offset: lineOffset,
          bytes: line.length,
          identityRecovery: recovery.identityRecovery,
          recoveredIdentityFields: recovery.recoveredIdentityFields,
        });
      } else if (line.toString('utf8').trim()) {
        try {
          const message = JSON.parse(line.toString('utf8').replace(/\r$/, '')) as SDKNativeMessage;
          entries.push(toRawEntry(message, lineOffset, cursor - start, lineNumber));
        } catch {
          skippedLines += 1;
          onLineSkipped?.({ reason: 'malformed', offset: lineOffset, bytes: line.length });
        }
      }
      lineNumber += 1;
      committedSize = dataOffset + cursor + 1;
      start = cursor + 1;
    }
    partial = Buffer.from(data.subarray(start));
    partialOffset = dataOffset + start;
    if (partial.length > maxLineBytes) {
      // Enter discard mode instead of throwing: clearing partial and
      // continuing here would misread the oversized line's tail as a fresh
      // JSON line, so the bytes are dropped until the next newline.
      discardingOversizedLine = true;
      oversizedLineOffset = partialOffset;
      oversizedLineBytes = partial.length;
      partial = Buffer.alloc(0);
    }
  };

  try {
    while (position < snapshot.size) {
      throwIfAborted(signal);
      const length = Math.min(chunkSize, snapshot.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      const chunkData = chunk.subarray(0, bytesRead);
      if (discardingOversizedLine) {
        const newlineIndex = chunkData.indexOf(0x0a);
        if (newlineIndex === -1) {
          oversizedLineBytes += chunkData.length;
        } else {
          oversizedLineBytes += newlineIndex;
          const recovery = await appendOversizedEntry(handle, entries, oversizedLineOffset, oversizedLineBytes, lineNumber);
          skippedLines += 1;
          onLineSkipped?.({
            reason: 'oversized',
            offset: oversizedLineOffset,
            bytes: oversizedLineBytes,
            identityRecovery: recovery.identityRecovery,
            recoveredIdentityFields: recovery.recoveredIdentityFields,
          });
          lineNumber += 1;
          committedSize = position + newlineIndex + 1;
          discardingOversizedLine = false;
          await scanData(chunkData.subarray(newlineIndex + 1), position + newlineIndex + 1);
        }
      } else {
        const data = partial.length > 0 ? Buffer.concat([partial, chunkData]) : chunkData;
        const dataOffset = partial.length > 0 ? partialOffset : position;
        await scanData(data, dataOffset);
      }
      position += bytesRead;
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
      onProgress?.(position, snapshot.size);
      await yieldToMainThread(signal);
    }
    if (discardingOversizedLine) {
      // EOF closed the file inside the oversized line: no committed entry and
      // the committed boundary stays at the line start for the tail reader.
      // No line_skipped here — the line is not yet closed, so no opaque entry
      // exists; the rebuild that observes the closing newline reports it, and
      // reporting now would double-count the same line across snapshots.
      // Partial state is already expressed by status 'partial'.
    }
  } finally {
    await handle.close();
  }
  return {
    entries,
    skippedLines,
    incomplete: partial.length > 0 || discardingOversizedLine || position < snapshot.size,
    committedSize,
    snapshot,
    peakHeapBytes,
  };
}

async function buildDirect(filePath: string, options: BuildOptions): Promise<TranscriptIndexResult> {
  const startedAt = performance.now();
  try {
    const scanned = await scanSnapshot(
      filePath,
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      options.onLineSkipped,
      options.onProgress,
      options.signal,
    );
    options.onFinalize?.();
    const index = await finalizeIndex(
      filePath,
      scanned.snapshot,
      scanned.entries,
      scanned.skippedLines,
      scanned.committedSize,
      projectionVariantKeyFor(options.resumeAtMessageId, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES),
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

const MAX_COMPLETED_INDEXES = 8;
const MAX_COMPLETED_INDEX_METADATA_BYTES = 128 * 1024 * 1024;
/** Only successful builds enter the completed cache; failed results are never cached. */
type CompletedCacheEntry = Exclude<TranscriptIndexResult, { status: 'failed' }>;
const completed = new Map<string, CompletedCacheEntry>();
interface BuildSubscription {
  options: BuildOptions;
  finish: (result: TranscriptIndexResult) => void;
}

interface BuildFlight {
  controller: AbortController;
  subscribers: Set<BuildSubscription>;
  promise: Promise<TranscriptIndexResult>;
  settled: boolean;
  temporaryIndex?: TranscriptHistoryIndex;
}

const inFlight = new Map<string, BuildFlight>();
const protectedPaths = new Map<string, number>();
const protectedIndexes = new Map<TranscriptHistoryIndex, number>();

function touchCompleted(key: string, result: CompletedCacheEntry): void {
  completed.delete(key);
  completed.set(key, result);
}

function isProtectedCompletedKey(key: string, result: CompletedCacheEntry): boolean {
  if (protectedIndexes.has(result.index)) return true;
  if (!protectedPaths.has(result.index.filePath)) return false;
  const keys = [...completed.entries()]
    .filter(([, candidate]) => candidate.index.filePath === result.index.filePath)
    .map(([candidateKey]) => candidateKey);
  return keys[keys.length - 1] === key;
}

function estimateIndexMetadataBytes(result: CompletedCacheEntry): number {
  const index = result.index;
  return index.searchText.length * 2
    + index.projectionVariantKey.length * 2
    + index.entries.length * 192
    + index.turns.length * 64
    + index.searchCorpus.length * 80
    + (index.projectionDescriptors?.length ?? 0) * 80;
}

function completedMetadataBytes(): number {
  let total = 0;
  for (const result of completed.values()) total += estimateIndexMetadataBytes(result);
  return total;
}

function evictCompleted(): void {
  while (completed.size > MAX_COMPLETED_INDEXES || completedMetadataBytes() > MAX_COMPLETED_INDEX_METADATA_BYTES) {
    const candidate = [...completed.entries()].find(([key, result]) =>
      !inFlight.has(key) && !isProtectedCompletedKey(key, result));
    if (!candidate) {
      diagnosticSink?.({ phase: 'cache_overcommit', bytes: completedMetadataBytes(), entries: completed.size });
      return;
    }
    completed.delete(candidate[0]);
    diagnosticSink?.({ phase: 'cache_evict' });
  }
}

function snapshotIdentity(
  filePath: string,
  snapshot: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): string {
  return JSON.stringify([filePath, snapshot.dev, snapshot.ino, snapshot.size, snapshot.mtimeMs, snapshot.ctimeMs]);
}

async function snapshotKey(filePath: string): Promise<string> {
  return snapshotIdentity(filePath, await stat(filePath));
}

export function builtIndexCacheKey(index: TranscriptHistoryIndex): string {
  return indexCacheKey(snapshotIdentity(index.filePath, { ...index, size: index.snapshotSize }), index.projectionVariantKey);
}

export function transcriptIndexResultIdentity(result: CompletedCacheEntry): string {
  return JSON.stringify([builtIndexCacheKey(result.index), result.status, result.index.committedSize,
    result.status === 'partial' ? result.error : null]);
}

function isSameScannedSnapshot(reference: CompletedCacheEntry, candidate: TranscriptIndexResult): candidate is CompletedCacheEntry {
  return candidate.status !== 'failed' && transcriptIndexResultIdentity(candidate) === transcriptIndexResultIdentity(reference);
}

function projectionVariantKeyFor(resumeAtMessageId: string | undefined, maxLineBytes: number): string {
  // Preserve finalizeIndex's truthiness without trimming or case normalization.
  return JSON.stringify([resumeAtMessageId || null, maxLineBytes]);
}

function indexCacheKey(snapshot: string, projectionVariantKey: string): string {
  return JSON.stringify([snapshot, projectionVariantKey]);
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
    const OVERSIZED_FACTS_READ_BYTES = ${OVERSIZED_FACTS_READ_BYTES};
    const OVERSIZED_FACTS_TAIL_READ_BYTES = ${OVERSIZED_FACTS_TAIL_READ_BYTES};
    const OVERSIZED_FACTS_STRING_CAP = ${OVERSIZED_FACTS_STRING_CAP};
    // Mirrors HISTORY_OMISSION_MARKER from runtime/HistoryContextAccumulator —
    // the eval'd worker source has no imports, so keep the two in sync.
    const HISTORY_OMISSION_MARKER = '[Earlier history omitted: context recovery budget]';
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
    const isRebuiltContextContent = (${serializeWorkerFunction((textContent: string) => {
      if (textContent.startsWith(HISTORY_OMISSION_MARKER)) return true;
      if (!/^(User|Assistant):\s/.test(textContent)) return false;
      return textContent.includes('\n\nUser:') || textContent.includes('\n\nAssistant:') || textContent.includes('\n\nA:');
    })});
    const isRebuiltContextMessage = (${serializeWorkerFunction(isRebuiltContextMessage)});
    const toRawEntry = (${serializeWorkerFunction(toRawEntry)});
    const decodeBoundedJsonString = (${serializeWorkerFunction(decodeBoundedJsonString)});
    const parseOversizedLineFacts = (${serializeWorkerFunction(parseOversizedLineFacts)});
    const parseOversizedLineFactsSuffix = (${serializeWorkerFunction(parseOversizedLineFactsSuffix)});
    const listOversizedIdentityFields = (${serializeWorkerFunction(listOversizedIdentityFields)});
    const mergeOversizedLineFacts = (${serializeWorkerFunction(mergeOversizedLineFacts)});
    const extractOversizedLineFacts = (${serializeWorkerFunction(extractOversizedLineFacts)});
    const appendOversizedEntry = (${serializeWorkerFunction(appendOversizedEntry)});
    const filterActiveBranchEntries = (${serializeWorkerFunction(filterActiveBranchEntries)});
    const finalizeIndex = (${serializeWorkerFunction(finalizeIndex)});
    const scanSnapshot = (${serializeWorkerFunction(scanSnapshot)});
    const projectionVariantKeyFor = (${serializeWorkerFunction(projectionVariantKeyFor)});
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
      onLineSkipped: (event) => parentPort.postMessage({ kind: 'line_skipped', event }),
    };
    buildDirect(workerData.filePath, options).then(result => parentPort.postMessage({ kind: 'result', result }), error => parentPort.postMessage({ kind: 'result', result: { status: 'failed', error: String(error) } }));
  `;
  return new Promise((resolve, reject) => {
    const { onProgress: _, onFinalize: __, onLineSkipped: ____, onIndex: _____, signal: ___, ...workerOptions } = options;
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
        | { kind: 'line_skipped'; event: TranscriptLineSkipEvent }
        | { kind: 'result'; result: TranscriptIndexResult };
      if (payload.kind === 'progress') options.onProgress?.(payload.bytesRead, payload.snapshotSize);
      else if (payload.kind === 'finalize') options.onFinalize?.();
      else if (payload.kind === 'line_skipped') options.onLineSkipped?.(payload.event);
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

const requests = new Map<string, BuildFlight>();

function failedBuildResult(error: unknown): TranscriptIndexResult {
  return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
}

function retainFlightIndex(flight: BuildFlight, index: TranscriptHistoryIndex): void {
  if (flight.controller.signal.aborted || flight.subscribers.size === 0 || flight.temporaryIndex === index) return;
  protectTranscriptIndex(index);
  const previous = flight.temporaryIndex;
  flight.temporaryIndex = index;
  if (previous) releaseTranscriptIndex(previous);
}

function releaseFlightIndex(flight: BuildFlight): void {
  if (flight.subscribers.size > 0 || !flight.temporaryIndex) return;
  const index = flight.temporaryIndex;
  flight.temporaryIndex = undefined;
  releaseTranscriptIndex(index);
}

function dispatchBuildCallback(flight: BuildFlight, call: (options: BuildOptions) => void): void {
  for (const subscriber of [...flight.subscribers]) {
    if (!flight.subscribers.has(subscriber)) continue;
    try { call(subscriber.options); }
    catch (error) { subscriber.finish(failedBuildResult(error)); }
  }
}

function createBuildFlight(
  run: (options: BuildOptions, flight: BuildFlight) => Promise<TranscriptIndexResult>,
  remove: (flight: BuildFlight) => void,
  publish?: (flight: BuildFlight, result: TranscriptIndexResult) => void,
): BuildFlight {
  const controller = new AbortController();
  const flight: BuildFlight = { controller, subscribers: new Set(), settled: false, promise: undefined! };
  controller.signal.addEventListener('abort', () => remove(flight), { once: true });
  const options: BuildOptions = {
    signal: controller.signal,
    onProgress: (bytes, total) => dispatchBuildCallback(flight, subscriber => subscriber.onProgress?.(bytes, total)),
    onFinalize: () => dispatchBuildCallback(flight, subscriber => subscriber.onFinalize?.()),
    onLineSkipped: event => dispatchBuildCallback(flight, subscriber => subscriber.onLineSkipped?.(event)),
    onIndex: index => retainFlightIndex(flight, index),
  };
  // Subscribe before starting discovery/build, including same-tick cancellation.
  flight.promise = Promise.resolve().then(() => run(options, flight)).catch(failedBuildResult).then(result => {
    flight.settled = true;
    if (result.status !== 'failed') retainFlightIndex(flight, result.index);
    publish?.(flight, result);
    remove(flight);
    releaseFlightIndex(flight);
    return result;
  });
  return flight;
}

function subscribeBuildFlight(flight: BuildFlight, options: BuildOptions): Promise<TranscriptIndexResult> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: TranscriptIndexResult): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (result.status !== 'failed') {
        // Each successor flight/lease retains synchronously, before its
        // predecessor drops the exact-instance handoff protection.
        try { options.onIndex?.(result.index); }
        catch (error) { result = failedBuildResult(error); }
      }
      flight.subscribers.delete(subscriber);
      if (!flight.settled && flight.subscribers.size === 0) flight.controller.abort();
      releaseFlightIndex(flight);
      resolve(result);
    };
    const subscriber: BuildSubscription = { options: { ...options }, finish };
    const abort = (): void => finish({ status: 'failed', error: 'History index build aborted' });
    flight.subscribers.add(subscriber);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    void flight.promise.then(finish);
  });
}

export interface TranscriptIndexDiagnosticEvent {
  phase: 'index_worker_fallback' | 'queued' | 'start' | 'progress' | 'finalize' | 'complete' | 'failed' | 'aborted' | 'stalled' | 'cache_hit' | 'cache_evict' | 'cache_overcommit' | 'line_skipped';
  errorName?: string;
  buildId?: string;
  mode?: 'worker' | 'direct';
  reason?: 'oversized' | 'malformed';
  /** Oversized-row identity provenance; field names only, never values. */
  identityRecovery?: OversizedIdentityRecovery;
  recoveredIdentityFields?: OversizedIdentityField[];
  offset?: number;
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
    // Line-skip diagnostics flow through the build context (buildId/mode)
    // instead of a global sink read inside scanSnapshot, keeping the scan
    // worker-serializable and free of module-level timing assumptions.
    onLineSkipped: event => {
      options.onLineSkipped?.(event);
      diagnosticSink?.({
        phase: 'line_skipped', buildId, mode, reason: event.reason, offset: event.offset, bytes: event.bytes,
        identityRecovery: event.identityRecovery, recoveredIdentityFields: event.recoveredIdentityFields,
      });
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

async function runPhysicalBuild(filePath: string, options: BuildOptions): Promise<TranscriptIndexResult> {
  if (options.useWorker === false || !await probeWorkerAvailability()) {
    return scheduleDirectBuild(filePath, options);
  }
  const queuedAt = performance.now();
  const buildId = `index-${Date.now().toString(36)}-${(++buildSequence).toString(36)}`;
  diagnosticSink?.({ phase: 'queued', buildId, mode: 'worker' });
  try {
    return await observeBuild(buildId, 'worker', queuedAt, options, observed => buildInWorker(filePath, observed), false);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    workerAvailability = false;
    recordWorkerFallback(error);
    return scheduleDirectBuild(filePath, options, buildId);
  }
}

export function buildTranscriptIndex(filePath: string, options: BuildOptions = {}): Promise<TranscriptIndexResult> {
  // A flight's variant and scan options cannot change while source observation awaits IO.
  options = { ...options };
  if (options.signal?.aborted) {
    diagnosticSink?.({ phase: 'aborted', mode: options.useWorker === false ? 'direct' : undefined, errorName: 'AbortError' });
    return Promise.resolve({ status: 'failed', error: 'History index build aborted' });
  }
  const chunkSize = options.chunkSize === undefined ? DEFAULT_CHUNK_SIZE : options.chunkSize;
  const maxLineBytes = options.maxLineBytes === undefined ? DEFAULT_MAX_LINE_BYTES : options.maxLineBytes;
  for (const [name, value] of [['chunkSize', chunkSize], ['maxLineBytes', maxLineBytes]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return Promise.resolve({ status: 'failed', error: `Invalid history index ${name}: expected a positive finite safe integer` });
    }
  }
  options = { ...options, chunkSize, maxLineBytes };
  const projectionVariantKey = projectionVariantKeyFor(options.resumeAtMessageId, maxLineBytes);
  const requestKey = JSON.stringify([filePath, chunkSize, options.useWorker !== false, projectionVariantKey]);
  const existingRequest = requests.get(requestKey);
  if (!options.forceNewSnapshot && existingRequest && !existingRequest.controller.signal.aborted) {
    return subscribeBuildFlight(existingRequest, options);
  }
  const request = createBuildFlight(async (requestOptions, requestFlight) => {
    const snapshot = await snapshotKey(filePath);
    throwIfAborted(requestOptions.signal);
    const key = indexCacheKey(snapshot, projectionVariantKey);
    const cached = completed.get(key);
    if (cached) {
      retainFlightIndex(requestFlight, cached.index);
      touchCompleted(key, cached);
      diagnosticSink?.({ phase: 'cache_hit' });
      return { ...cached, fromCache: true };
    }
    let build = inFlight.get(key);
    if (!build || build.controller.signal.aborted) {
      const ownedKeys = new Set([key]);
      build = createBuildFlight(async (subscriptionOptions, flight) => {
        // Physical build cancellation belongs to the flight, never to the
        // first caller. Request flights are themselves independent subscribers.
        const result = await runPhysicalBuild(filePath, { ...options, ...subscriptionOptions });
        if (result.status !== 'failed') {
          // Worker structured cloning does not preserve property descriptors.
          Object.defineProperty(result.index, 'projectionVariantKey', {
            value: result.index.projectionVariantKey, enumerable: true, writable: false, configurable: false,
          });
        }
        if (result.status === 'failed' || flight.controller.signal.aborted) return result;
        const actualKey = builtIndexCacheKey(result.index);
        if (actualKey === key) return result;
        // The source changed between pre-observation and open/stat. Retire the
        // predicted identity before following an actual-key owner: followers
        // are no longer discoverable, so identity reconciliation cannot cycle.
        if (inFlight.get(key) === flight) inFlight.delete(key);
        // Keep our proven result pinned while a predicted owner is still in IO.
        // Its eventual success/failure cannot change our snapshot or boundary.
        retainFlightIndex(flight, result.index);
        while (true) {
          throwIfAborted(subscriptionOptions.signal);
          const actualCached = completed.get(actualKey);
          if (actualCached) {
            if (!isSameScannedSnapshot(result, actualCached)) return result;
            retainFlightIndex(flight, actualCached.index);
            touchCompleted(actualKey, actualCached);
            // We did scan, so fromCache stays absent despite instance reuse.
            return actualCached;
          }
          const candidate = inFlight.get(actualKey);
          if (!candidate || candidate === flight || candidate.controller.signal.aborted) {
            ownedKeys.add(actualKey);
            inFlight.set(actualKey, flight);
            return result;
          }
          let candidatePin: TranscriptHistoryIndex | undefined;
          try {
            const candidateResult = await subscribeBuildFlight(candidate, {
              // No callback replay. Retain the candidate separately through
              // verification; never replace our proven pin on a prediction.
              signal: subscriptionOptions.signal,
              onIndex: index => { protectTranscriptIndex(index); candidatePin = index; },
            });
            throwIfAborted(subscriptionOptions.signal);
            if (isSameScannedSnapshot(result, candidateResult)) {
              retainFlightIndex(flight, candidateResult.index);
              return candidateResult;
            }
          } finally {
            if (candidatePin) releaseTranscriptIndex(candidatePin);
          }
          // A settled candidate removed/rekeyed only its own identities. Observe
          // the now-vacant or reassigned slot, without rescanning or stealing it.
          // A failed/different candidate's result is never returned to our callers.
        }
      }, flight => {
        for (const ownedKey of ownedKeys) {
          if (inFlight.get(ownedKey) === flight) inFlight.delete(ownedKey);
        }
      }, (flight, result) => {
        if (result.status === 'failed' || flight.controller.signal.aborted) return;
        const actualKey = builtIndexCacheKey(result.index);
        // A retired/aborting build can neither overwrite nor remove its replacement.
        if (inFlight.get(actualKey) !== flight) return;
        touchCompleted(actualKey, result);
        evictCompleted();
      });
      inFlight.set(key, build);
    }
    return subscribeBuildFlight(build, requestOptions);
  }, flight => {
    if (requests.get(requestKey) === flight) requests.delete(requestKey);
  });
  requests.set(requestKey, request);
  return subscribeBuildFlight(request, options);
}

async function readIndexEntries(
  index: TranscriptHistoryIndex,
  entries: TranscriptIndexEntry[],
): Promise<SDKNativeMessage[]> {
  const handle = await open(index.filePath, 'r');
  try {
    const info = await handle.stat();
    if (info.dev !== index.dev || info.ino !== index.ino || info.size < index.snapshotSize) {
      throw new Error('Transcript index invalidated by replacement or truncation');
    }
    const messages: SDKNativeMessage[] = [];
    for (const entry of entries) {
      // Oversized lines are never read back — that read is the exact failure
      // the opaque entry exists for. Facts-based placeholders keep tool
      // pairing honest and mark the omission visibly.
      if (entry.oversized) {
        messages.push(...buildOpaqueOversizedPlaceholders(entry));
        continue;
      }
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

/** Reads an explicit entry subset (summary materialization path). */
export async function materializeTranscriptEntries(
  index: TranscriptHistoryIndex,
  entries: TranscriptIndexEntry[],
): Promise<SDKNativeMessage[]> {
  return readIndexEntries(index, entries);
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

export function protectTranscriptIndex(index: TranscriptHistoryIndex | string): void {
  if (typeof index === 'string') protectedPaths.set(index, (protectedPaths.get(index) ?? 0) + 1);
  else protectedIndexes.set(index, (protectedIndexes.get(index) ?? 0) + 1);
}

export function releaseTranscriptIndex(index: TranscriptHistoryIndex | string): void {
  if (typeof index === 'string') {
    const count = protectedPaths.get(index) ?? 0;
    if (count <= 1) protectedPaths.delete(index);
    else protectedPaths.set(index, count - 1);
  } else {
    const count = protectedIndexes.get(index) ?? 0;
    if (count <= 1) protectedIndexes.delete(index);
    else protectedIndexes.set(index, count - 1);
  }
  evictCompleted();
}

/** Evicts only unprotected completed indexes; active and in-flight indexes survive. */
export function clearTranscriptIndexCache(): void {
  for (const [key, result] of completed) {
    if (!isProtectedCompletedKey(key, result)) completed.delete(key);
  }
  evictCompleted();
}

export function getTranscriptIndexCacheSize(): number {
  return completed.size;
}
