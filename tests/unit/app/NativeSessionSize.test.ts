import type * as fsPromises from 'fs/promises';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConversationSizeService } from '@/app/ConversationSizeService';
import type { ProviderConversationHistoryService } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as index from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import * as sdkPaths from '@/providers/claude/history/sdkSessionPaths';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';
import * as codexStore from '@/providers/codex/history/CodexHistoryStore';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';

const fs = jest.requireActual<typeof fsPromises>('fs/promises');
let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'claudian-native-size-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => { jest.restoreAllMocks(); });

function conversation(providerId: Conversation['providerId'], providerState: Record<string, unknown> = {}): Conversation {
  return { id: 'one', providerId, title: 'Fixture', createdAt: 1, updatedAt: 1, sessionId: null, providerState, messages: [] };
}

async function read(provider: ProviderConversationHistoryService, input: Conversation) {
  return (await provider.readConversationSize!({ id: input.id, providerId: input.providerId,
    source: provider.captureConversationSizeSource!(input) }, dir, { revision: 0 })).snapshot;
}

it('stats only the current Claude file, not parent chains, fork sources, or metadata', async () => {
  const current = join(dir, 'current.jsonl');
  const parent = join(dir, 'parent.jsonl');
  await writeFile(current, '汉字');
  await writeFile(parent, 'parent'.repeat(100));
  await writeFile(join(dir, 'one.meta.json'), 'metadata'.repeat(100));
  const paths = jest.spyOn(sdkPaths, 'getSDKSessionPath').mockImplementation((_vault, id) => join(dir, `${id}.jsonl`));
  const stat = jest.spyOn(fs, 'stat');
  const build = jest.spyOn(index, 'buildTranscriptIndex');
  const provider = new ClaudeConversationHistoryService();
  const input = conversation('claude', { providerSessionId: 'current', previousProviderSessionIds: ['parent'],
    forkSource: { sessionId: 'parent', resumeAt: 'anchor' } });
  input.sessionId = 'parent';
  const result = await read(provider, input);
  expect(result.files).toEqual({ status: 'known', bytes: 6 });
  expect(result).not.toHaveProperty('history');
  expect(paths).toHaveBeenCalledTimes(1);
  expect(paths).toHaveBeenCalledWith(dir, 'current');
  expect(stat).toHaveBeenCalledTimes(1);
  expect(stat).toHaveBeenCalledWith(current);
  expect(build).not.toHaveBeenCalled();
});

it('uses Claude conversation.sessionId only when current providerSessionId is absent; pending fork stays unknown', async () => {
  const paths = jest.spyOn(sdkPaths, 'getSDKSessionPath').mockImplementation((_vault, id) => join(dir, `${id}.jsonl`));
  await writeFile(join(dir, 'fallback.jsonl'), 'ok');
  const provider = new ClaudeConversationHistoryService();
  const input = conversation('claude');
  input.sessionId = 'fallback';
  expect((await read(provider, input)).files).toEqual({ status: 'known', bytes: 2 });
  paths.mockClear();
  const fork = conversation('claude', { forkSource: { sessionId: 'fallback', resumeAt: 'anchor' }, previousProviderSessionIds: ['fallback'] });
  expect((await read(provider, fork)).files.status).toBe('unknown');
  expect(paths).not.toHaveBeenCalled();
});

it('Codex uses only the explicit current sessionFilePath and never DFS or parsing', async () => {
  const current = join(dir, 'codex-current.jsonl');
  const parent = join(dir, 'codex-parent.jsonl');
  await writeFile(current, 'native');
  await writeFile(parent, 'source'.repeat(100));
  const find = jest.spyOn(codexStore, 'findCodexSessionFile');
  const parse = jest.spyOn(codexStore, 'parseCodexSessionTurns');
  const provider = new CodexConversationHistoryService();
  const input = conversation('codex', { threadId: 'child', sessionFilePath: current,
    forkSource: { sessionId: 'parent', resumeAt: 'anchor' }, forkSourceSessionFilePath: parent });
  expect((await read(provider, input)).files).toEqual({ status: 'known', bytes: 6 });
  delete input.providerState!.sessionFilePath;
  expect((await read(provider, input)).files.status).toBe('unknown');
  expect(find).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
});

it.each(['zero', 'missing', 'directory', 'denied'] as const)('reports %s without inventing a size', async variant => {
  const path = variant === 'directory' ? dir : join(dir, `stat-${variant}.jsonl`);
  if (variant === 'zero') await writeFile(path, '');
  if (variant === 'denied') jest.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  const result = await read(new CodexConversationHistoryService(), conversation('codex', { sessionFilePath: path }));
  expect(result.files).toEqual(variant === 'zero' ? { status: 'known', bytes: 0 } : { status: 'unknown', reason: 'unavailable' });
});

it('does not stat the shared OpenCode database', async () => {
  const stat = jest.spyOn(fs, 'stat');
  const result = await read(new OpencodeConversationHistoryService(), conversation('opencode', { databasePath: join(dir, 'shared.db') }));
  expect(result.files).toEqual({ status: 'unknown', reason: 'unsupported' });
  expect(result).not.toHaveProperty('history');
  expect(stat).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(['path', 'replacement', 'delete', 'generation'] as const)('discards a delayed stat after %s changes', async change => {
  const path = join(dir, `race-${change}.jsonl`);
  await writeFile(path, '123');
  let current: Conversation | null = conversation('codex', { sessionFilePath: path });
  const original = current;
  const provider = new CodexConversationHistoryService();
  const actualStat = fs.stat;
  const pending = deferred<Awaited<ReturnType<typeof fs.stat>>>();
  jest.spyOn(fs, 'stat').mockImplementationOnce(() => pending.promise as ReturnType<typeof fs.stat>);
  const published = jest.fn();
  const persist = jest.fn().mockResolvedValue({ status: 'written' });
  const deps = { getConversation: () => current, getHistoryService: () => provider,
    getVaultPath: () => dir, persistSnapshot: persist, onPublished: published };
  const service = new ConversationSizeService(deps);
  const request = service.refresh('one');
  await Promise.resolve();
  if (change === 'path') current.providerState!.sessionFilePath = join(dir, 'other.jsonl');
  if (change === 'replacement') current = { ...current, providerState: { ...current.providerState } };
  if (change === 'delete') current = null;
  if (change === 'generation') service.invalidate('one');
  pending.resolve(await actualStat(path));
  expect(await request).toBeUndefined();
  expect(service.getSnapshot('one')).toBeUndefined();
  expect(original).not.toHaveProperty('sizeSnapshot');
  expect(published).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});

it.each(['conversation', 'revision'] as const)('rejects a provider reading with the wrong %s identity', async field => {
  const path = join(dir, `wrong-${field}.jsonl`);
  await writeFile(path, 'native');
  const input = conversation('codex', { sessionFilePath: path });
  const provider = new CodexConversationHistoryService();
  const actualRead = provider.readConversationSize.bind(provider);
  jest.spyOn(provider, 'readConversationSize').mockImplementation(async (...args) => {
    const observed = await actualRead(...args);
    return { snapshot: { ...observed.snapshot,
      ...(field === 'conversation' ? { conversationId: 'other' } : { revision: 99 }),
    } };
  });
  const published = jest.fn();
  const service = new ConversationSizeService({ getConversation: () => input,
    getHistoryService: () => provider, getVaultPath: () => dir, onPublished: published });
  expect(await service.refresh('one')).toBeUndefined();
  expect(service.getSnapshot('one')).toBeUndefined();
  expect(published).not.toHaveBeenCalled();
});

it('bounds stat concurrency to two, while same observations share one request', async () => {
  const paths = await Promise.all(['a', 'b', 'c'].map(async id => {
    const path = join(dir, `concurrency-${id}.jsonl`);
    await writeFile(path, id);
    return path;
  }));
  const actualStat = fs.stat;
  const stats = await Promise.all(paths.map(path => actualStat(path)));
  const inputs = new Map(paths.map((path, i) => [String(i), { ...conversation('codex', { sessionFilePath: path }), id: String(i) }]));
  const pending: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const stat = jest.spyOn(fs, 'stat').mockImplementation(path => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise(resolve => pending.push(() => {
      active -= 1;
      resolve(stats[paths.indexOf(String(path))]);
    })) as ReturnType<typeof fs.stat>;
  });
  const provider = new CodexConversationHistoryService();
  const service = new ConversationSizeService({ getConversation: id => inputs.get(id) ?? null,
    getHistoryService: () => provider, getVaultPath: () => dir, onPublished: () => {} });
  const requests = ['0', '1', '2'].map(id => service.refresh(id));
  expect(service.refresh('0')).toBe(requests[0]);
  await Promise.resolve();
  expect(stat).toHaveBeenCalledTimes(2);
  pending.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(stat).toHaveBeenCalledTimes(3);
  pending.splice(0).forEach(resolve => resolve());
  await Promise.all(requests);
  expect(maxActive).toBe(2);
});

it('ignores old persisted readings and opaque content getters', async () => {
  const path = join(dir, 'opaque.jsonl');
  await writeFile(path, 'native');
  const input = conversation('codex', { sessionFilePath: path });
  const opaque = jest.fn(() => { throw new Error('content was inspected'); });
  Object.defineProperty(input, 'messages', { get: opaque });
  Object.defineProperty(input, 'sizeSnapshot', { get: opaque });
  Object.defineProperty(input.providerState!, 'subagentData', { get: opaque, enumerable: true });
  Object.defineProperty(input.providerState!, 'forkSource', { get: opaque, enumerable: true });
  const service = new ConversationSizeService({ getConversation: () => input,
    getHistoryService: () => new CodexConversationHistoryService(), getVaultPath: () => dir, onPublished: () => {} });
  expect((await service.refresh('one'))?.files).toEqual({ status: 'known', bytes: 6 });
  expect(opaque).not.toHaveBeenCalled();
});

it('keeps readings in memory, refreshes known values, and invalidates same-ID cache replacements', async () => {
  const path = join(dir, 'refresh.jsonl');
  await writeFile(path, '123');
  let current = conversation('codex', { sessionFilePath: path });
  const provider = new CodexConversationHistoryService();
  const readSize = jest.spyOn(provider, 'readConversationSize');
  const persist = jest.fn().mockRejectedValue(new Error('metadata unavailable'));
  const deps = { getConversation: () => current, getHistoryService: () => provider,
    getVaultPath: () => dir, persistSnapshot: persist, onPublished: jest.fn() };
  const service = new ConversationSizeService(deps);
  const first = service.refresh('one');
  expect(service.refresh('one')).toBe(first);
  expect((await first)?.files).toEqual({ status: 'known', bytes: 3 });
  await writeFile(path, '123456');
  expect((await service.refresh('one'))?.files).toEqual({ status: 'known', bytes: 6 });
  expect(readSize).toHaveBeenCalledTimes(2);
  expect(current).not.toHaveProperty('sizeSnapshot');
  expect(persist).not.toHaveBeenCalled();
  current = { ...current, providerState: { ...current.providerState } };
  expect(service.getSnapshot('one')).toBeUndefined();
});
