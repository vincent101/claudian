import type * as fsPromises from 'fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';

import { ConversationSizeService } from '@/app/ConversationSizeService';
import type { Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';

const fs = jest.requireActual<typeof fsPromises>('fs/promises');
let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'claudian-size-retention-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => { jest.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function containsStrongReference(root: unknown, targets: readonly unknown[], seen = new Set<object>()): boolean {
  if (targets.includes(root)) return true;
  if (!root || typeof root !== 'object' || seen.has(root)) return false;
  seen.add(root);
  if (root instanceof WeakMap || root instanceof WeakSet || root instanceof Promise) return false;
  if (root instanceof Map) return [...root].some(entry => containsStrongReference(entry, targets, seen));
  if (root instanceof Set) return [...root].some(entry => containsStrongReference(entry, targets, seen));
  return Reflect.ownKeys(root).some(key => {
    const value = Object.getOwnPropertyDescriptor(root, key)?.value;
    return containsStrongReference(value, targets, seen);
  });
}

it.each(['in-flight', 'queued'].flatMap(stage => ['delete', 'replace'].map(change => [stage, change] as const)))(
  'retains no conversation graph in %s request captures after %s; late result is rejected', async (stage, change) => {
    const paths = ['a', 'b', 'c'].map(id => join(dir, `${stage}-${change}-${id}.jsonl`));
    await Promise.all(paths.map(path => writeFile(path, 'native')));
    const originalStat = fs.stat;
    const stats = await Promise.all(paths.map(path => originalStat(path)));
    const inputs = paths.map((path, i): Conversation => ({
      id: String(i), providerId: 'codex', title: 'Synthetic', createdAt: 1, updatedAt: 1, sessionId: null,
      providerState: { sessionFilePath: path },
      messages: [{ id: 'large-message', role: 'user', timestamp: 1, content: 'synthetic body'.repeat(100_000) }],
    }));
    const registry = new Map(inputs.map(input => [input.id, input]));
    const pending = paths.map(() => deferred<Awaited<ReturnType<typeof fs.stat>>>());
    const stat = jest.spyOn(fs, 'stat').mockImplementation(path => pending[paths.indexOf(String(path))].promise as ReturnType<typeof fs.stat>);
    const published = jest.fn();
    const provider = new CodexConversationHistoryService();
    const service = new ConversationSizeService({ getConversation: id => registry.get(id) ?? null,
      getHistoryService: () => provider, getVaultPath: () => dir, onPublished: published });
    const internals = service as unknown as {
      performRefresh(id: string, source: unknown, generation: unknown): Promise<unknown>;
      captureSource(id: string): unknown;
      requests: Map<string, unknown>;
      waiting: Array<() => void>;
      identities: WeakMap<Conversation, symbol>;
    };
    const capture = jest.spyOn(internals, 'performRefresh');
    const requests = inputs.map(input => service.refresh(input.id));
    const target = inputs[stage === 'in-flight' ? 0 : 2];
    expect(service.refresh(target.id)).toBe(requests[Number(target.id)]);
    await Promise.resolve();
    const before = internals.captureSource(target.id) as Record<string, unknown>;
    const again = internals.captureSource(target.id) as Record<string, unknown>;
    if (change === 'delete') registry.delete(target.id);
    else registry.set(target.id, { ...target, providerState: { ...target.providerState } });
    try {
      expect(stat).toHaveBeenCalledTimes(2);
      expect(internals.waiting.length).toBe(1);
      const captures = capture.mock.calls.map(call => call.slice(1));
      const graph = [captures, internals.requests, before, again];
      expect(containsStrongReference(graph, [target, target.messages, target.providerState])).toBe(false);
      expect(typeof before.identity).toBe('symbol');
      expect(again.identity).toBe(before.identity);
      expect(internals.identities instanceof WeakMap).toBe(true);
      const input = before.input as { source: Record<string, unknown> };
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.source)).toBe(true);
      expect(Object.values(input.source).every(value => value === undefined || typeof value === 'string')).toBe(true);
      const now = internals.captureSource(target.id) as Record<string, unknown> | null;
      expect(now?.identity ?? null).not.toBe(before.identity);
      expect(service.getSnapshot(target.id)).toBeUndefined();
      pending[0].resolve(stats[0]);
      pending[1].resolve(stats[1]);
      pending[2].resolve(stats[2]);
      expect(await requests[Number(target.id)]).toBeUndefined();
      await Promise.all(requests);
      expect(stat.mock.calls.some(call => call[0] === paths[2])).toBe(stage !== 'queued');
      expect(published.mock.calls.some(call => call[0] === target.id)).toBe(false);
      expect(service.getSnapshot(target.id)).toBeUndefined();
    } finally {
      pending.forEach((entry, i) => entry.resolve(stats[i]));
      await Promise.all(requests);
    }
  },
);

it('keeps conversation lookup and snapshot weak-key publication out of async locals and closures', async () => {
  const file = join(__dirname, '../../..', 'src/app/ConversationSizeService.ts');
  const text = await readFile(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(ts.isInterfaceDeclaration);
  for (const name of ['CapturedSource', 'PendingRequest']) {
    const declaration = declarations.find(node => node.name.text === name)!;
    const types = declaration.members.filter(ts.isPropertySignature).map(member => member.type?.getText(source));
    expect(types).not.toContain('Conversation');
    expect(types).toContain('symbol');
  }
  const bodies: ts.MethodDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) bodies.push(node);
    node.forEachChild(visit);
  };
  visit(source);
  expect(bodies.map(node => node.name.getText(source))).toContain('performRefresh');
  const forbidden: string[] = [];
  for (const method of bodies) {
    expect(method.parameters.map(parameter => parameter.type?.getText(source))).not.toContain('Conversation');
    const inspect = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && ['getConversation', 'liveConversation'].includes(node.name.text)) forbidden.push(node.getText(source));
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'this.snapshots.set') forbidden.push(node.getText(source));
      node.forEachChild(inspect);
    };
    inspect(method);
  }
  expect(forbidden).toEqual([]);
  // This checks the capture/closure structure, not when V8 elects to collect objects.
  expect(text).toMatch(/WeakMap<Conversation,\s*symbol>/);
});
