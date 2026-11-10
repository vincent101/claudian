import type * as FsPromisesModule from 'fs/promises';
import { appendFile, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { HistoryTailStart } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import { buildTranscriptIndex } from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import * as sdkSessionPaths from '@/providers/claude/history/sdkSessionPaths';
import { ClaudeTranscriptTailReader } from '@/providers/claude/transcript/ClaudeTranscriptTailReader';
import { ClaudeTranscriptTurnObserver } from '@/providers/claude/transcript/ClaudeTranscriptTurnObserver';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, message: string, timeoutMs = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function peerTurn(id: string, text: string, complete = true): string[] {
  const lines = [
    JSON.stringify({ type: 'user', uuid: id, origin: { kind: 'peer', body: text }, message: { role: 'user', content: text } }),
    JSON.stringify({ type: 'assistant', uuid: `${id}-a1`, message: { id: `${id}-m1`, role: 'assistant', content: [{ type: 'text', text: 'working' }], stop_reason: 'tool_use' } }),
  ];
  if (complete) {
    lines.push(JSON.stringify({ type: 'assistant', uuid: `${id}-a2`, message: { id: `${id}-m2`, role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }));
    lines.push(JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', uuid: `${id}-stop` }));
  }
  return lines;
}

/** Task-notification turns keep showUser:false, so they queue behind a busy
 * host user turn instead of becoming embedded bubbles (the 18:22 dead-turn shape). */
function notificationTurn(id: string, text: string): string[] {
  return [
    JSON.stringify({ type: 'user', uuid: id, origin: { kind: 'task-notification' }, message: { role: 'user', content: text } }),
    JSON.stringify({ type: 'assistant', uuid: `${id}-a1`, message: { id: `${id}-m1`, role: 'assistant', content: [{ type: 'text', text: 'working' }], stop_reason: 'tool_use' } }),
  ];
}

/** Index-shaped tail-start descriptor for the CURRENT file state: the
 * credential semantics a real page handoff carries, with the caller's
 * committed boundary (0 = consume every existing row on first read). */
async function tailStartDescriptor(path: string, committedOffset = 0): Promise<HistoryTailStart> {
  const info = await stat(path);
  return {
    provider: 'claude',
    protocol: 1,
    payload: { path, dev: info.dev, ino: info.ino, snapshotSize: info.size, committedOffset },
  };
}

describe('ClaudeTranscriptTurnObserver', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claudian-observer-'));
    file = join(dir, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(canAcquire = () => true) {
    const order: string[] = [];
    const callbacks = {
      started: jest.fn(event => { order.push(`start:${event.turnId}`); return canAcquire(); }),
      chunk: jest.fn(async event => { order.push(`chunk:${event.turnId}:${event.chunk.type}`); }),
      finished: jest.fn(async event => { order.push(`finish:${event.turnId}`); }),
      released: jest.fn(turnId => { order.push(`release:${turnId}`); }),
      cancelled: jest.fn(),
      projectEmbeddedExternal: jest.fn(async event => { order.push(`embedded:${event.turnId}`); }),
      onHostTurnTerminalObserved: jest.fn(turnId => { order.push(`host-terminal:${turnId}`); }),
    };
    const observer = new ClaudeTranscriptTurnObserver(callbacks, canAcquire);
    return { observer, callbacks, order };
  }

  it('does not replay a valid JSON user row before its newline arrives', async () => {
    const user = peerTurn('peer-unclosed', '中文', false)[0];
    await writeFile(file, user);
    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      expect(callbacks.started).not.toHaveBeenCalled();
      await appendFile(file, '\n');
      observer.beginUserTurnProjection('host');
      await observer.completeUserTurnProjection('host');
      expect(callbacks.projectEmbeddedExternal).toHaveBeenCalledTimes(1);
      expect(callbacks.projectEmbeddedExternal).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'peer-unclosed' }),
      );
      expect(callbacks.started).not.toHaveBeenCalled();
    } finally {
      observer.stop();
    }
  });

  it('rejects an index tail-start handoff whose source was replaced before priming (H/P8)', async () => {
    // The second source-replacement seam: the index snapshot produced the
    // committed boundary, and the observer must prime there only against the
    // file identity that snapshot observed. The takeover counterexample: a
    // same-size replacement landing before the prime used to pair the old
    // offset with the new file, read 0 bytes with no reset, and silently
    // miss every later row of the new source.
    const original = `${peerTurn('old', 'old').join('\n')}\n`;
    await writeFile(file, original);
    const indexResult = await buildTranscriptIndex(file, { useWorker: false });
    expect(indexResult.status).toBe('complete');
    if (indexResult.status !== 'complete') return;
    const { dev, ino, snapshotSize, committedSize, filePath } = indexResult.index;
    const tailStart = {
      provider: 'claude' as const,
      protocol: 1 as const,
      payload: { path: filePath, dev, ino, snapshotSize, committedOffset: committedSize },
    };
    const replacement = join(dir, 'replacement.jsonl');
    await writeFile(replacement, original);
    await rename(replacement, file);
    const { observer, callbacks } = setup();
    try {
      await expect(observer.start(file, tailStart)).rejects.toThrow(/source.*changed/i);
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      expect(reader.sourceIdentity()).toBeNull();
      expect(reader.getOffset()).toBe(0);
      expect(callbacks.started).not.toHaveBeenCalled();
    } finally {
      observer.stop();
    }
  });

  it('records a diagnostic when the tail-start handshake rejects a replaced source (H/P8)', async () => {
    const original = `${peerTurn('old', 'old').join('\n')}\n`;
    await writeFile(file, original);
    const indexResult = await buildTranscriptIndex(file, { useWorker: false });
    expect(indexResult.status).toBe('complete');
    if (indexResult.status !== 'complete') return;
    const { dev, ino, snapshotSize, committedSize, filePath } = indexResult.index;
    const tailStart = {
      provider: 'claude' as const,
      protocol: 1 as const,
      payload: { path: filePath, dev, ino, snapshotSize, committedOffset: committedSize },
    };
    const replacement = join(dir, 'replacement.jsonl');
    await writeFile(replacement, original);
    await rename(replacement, file);
    const diagnostics = { record: jest.fn(), hashId: jest.fn(() => 'hash') };
    const { callbacks } = setup();
    const observer = new ClaudeTranscriptTurnObserver(callbacks, () => true, diagnostics as any);
    try {
      await expect(observer.start(file, tailStart)).rejects.toThrow(/source.*changed/i);
      expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'prime_rejected', reason: 'source_changed',
      }));
    } finally {
      observer.stop();
    }
  });

  it('stays silent without polling when the tail-start source vanished before priming (H/P8)', async () => {
    const original = `${peerTurn('old', 'old').join('\n')}\n`;
    await writeFile(file, original);
    const indexResult = await buildTranscriptIndex(file, { useWorker: false });
    expect(indexResult.status).toBe('complete');
    if (indexResult.status !== 'complete') return;
    const { dev, ino, snapshotSize, committedSize, filePath } = indexResult.index;
    const tailStart = {
      provider: 'claude' as const,
      protocol: 1 as const,
      payload: { path: filePath, dev, ino, snapshotSize, committedOffset: committedSize },
    };
    await unlink(file);
    const diagnostics = { record: jest.fn(), hashId: jest.fn(() => 'hash') };
    const { callbacks } = setup();
    const observer = new ClaudeTranscriptTurnObserver(callbacks, () => true, diagnostics as any);
    try {
      await observer.start(file, tailStart);
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      const start = jest.spyOn(reader, 'start');
      expect(reader.getOffset()).toBe(0);
      expect(reader.sourceIdentity()).toBeNull();
      expect(start).not.toHaveBeenCalled();
      // Polling never began, so a recreated file at the same path stays unread.
      await writeFile(file, original);
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
      expect(callbacks.started).not.toHaveBeenCalled();
      expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'prime_rejected', reason: 'missing',
      }));
    } finally {
      observer.stop();
    }
  });

  it('rejects a replacement between recovery scanning and priming without replaying the old source', async () => {
    const old = `${peerTurn('old', 'old', false).join('\n')}\n`;
    const replacement = `${peerTurn('new', 'new', false).join('\n')}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(old));
    await writeFile(file, old);
    const nextFile = join(dir, 'replacement.jsonl');
    await writeFile(nextFile, replacement);
    const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');
    const open = fsPromises.open;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        await fsPromises.rename(nextFile, file);
        return result;
      }) as typeof handle.read;
      return handle;
    });
    const { observer, callbacks } = setup();
    try {
      await expect(observer.start(file)).rejects.toThrow(/source.*changed/i);
      expect(callbacks.started).not.toHaveBeenCalled();
      expect(callbacks.chunk).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      observer.stop();
    }
  });

  it('keeps a new same-id host token when the old host completion resets the source', async () => {
    await writeFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      observer.beginUserTurnProjection('host');
      callbacks.cancelled.mockImplementationOnce(() => observer.beginUserTurnProjection('host'));
      await writeFile(file, '');
      await observer.completeUserTurnProjection('host');
      expect((observer as any).hostUserTurnId).toBe('host');
      expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
    } finally {
      observer.stop();
    }
  });

  it('keeps a reentrant same-id host and drops embedded work from the reset source', async () => {
    await writeFile(file, '');
    const { observer, callbacks } = setup();
    const polled = deferred<void>();
    let nextToken: object | null = null;
    callbacks.chunk.mockImplementation(async event => {
      if (event.turnId === 'active') polled.resolve();
    });
    try {
      await observer.start(file);
      observer.beginUserTurnProjection('host');
      const oldToken = (observer as any).hostProjection;
      await appendFile(file, `${[...peerTurn('stale-embedded', 'old'), ...notificationTurn('active', 'active')].join('\n')}\n`);
      await within(polled.promise, 'poll did not consume the old source', 3_500);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((observer as any).embeddedQueue.map((event: { turnId: string }) => event.turnId)).toEqual(['stale-embedded']);
      expect((observer as any).active?.started.turnId).toBe('active');
      callbacks.cancelled.mockImplementationOnce(() => {
        observer.beginUserTurnProjection('host');
        nextToken = (observer as any).hostProjection;
      });
      await writeFile(file, '');
      await observer.completeUserTurnProjection('host');
      expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
      expect(nextToken).not.toBeNull();
      expect(nextToken).not.toBe(oldToken);
      expect((observer as any).hostProjection).toBe(nextToken);
      expect((observer as any).hostUserTurnId).toBe('host');
      expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
      await appendFile(file, `${peerTurn('fresh', 'new').join('\n')}\n`);
      await observer.completeUserTurnProjection('host');
      expect(callbacks.projectEmbeddedExternal.mock.calls.map(([event]) => event.turnId)).toEqual(['fresh']);
      expect((observer as any).hostUserTurnId).toBeNull();
    } finally {
      observer.stop();
    }
  }, 8_000);

  it('keeps a reentrant new source when an old host completion resets', async () => {
    await writeFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
    const nextFile = join(dir, 'next.jsonl');
    await writeFile(nextFile, '');
    const { observer, callbacks } = setup();
    let restarted: Promise<void> | undefined;
    try {
      await observer.start(file);
      observer.beginUserTurnProjection('host');
      const nextStart = await tailStartDescriptor(nextFile);
      callbacks.cancelled.mockImplementationOnce(() => {
        restarted = observer.start(nextFile, nextStart);
        observer.beginUserTurnProjection('host');
      });
      await writeFile(file, '');
      await observer.completeUserTurnProjection('host');
      await restarted;
      expect((observer as any).reader?.filePath).toBe(nextFile);
      expect((observer as any).hostUserTurnId).toBe('host');
      expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
    } finally {
      observer.stop();
    }
  });

  describe('lifecycle ownership', () => {
    it.each(['stop', 'restart', 'running'] as const)(
      'keeps an accepted embedded callback and gates the remaining batch: %s',
      async mode => {
        await writeFile(file, '');
        const { observer, callbacks } = setup();
        const entered = deferred<void>();
        const gate = deferred<void>();
        callbacks.projectEmbeddedExternal.mockImplementationOnce(async () => {
          entered.resolve();
          await gate.promise;
        });
        try {
          await observer.start(file);
          observer.beginUserTurnProjection('host');
          await appendFile(file, `${[...peerTurn('e1', 'one'), ...peerTurn('e2', 'two')].join('\n')}\n`);
          const completing = observer.completeUserTurnProjection('host');
          await entered.promise;
          if (mode !== 'running') observer.stop();
          if (mode === 'restart') {
            await observer.start(file, await tailStartDescriptor(file, (await stat(file)).size));
            observer.beginUserTurnProjection('host');
          }
          const reader = (observer as any).reader;
          const mapper = (observer as any).mapper;
          gate.resolve();
          await expect(completing).resolves.toBeUndefined();
          expect(callbacks.projectEmbeddedExternal.mock.calls.map(([event]) => event.turnId))
            .toEqual(mode === 'running' ? ['e1', 'e2'] : ['e1']);
          expect((observer as any).reader).toBe(reader);
          expect((observer as any).mapper).toBe(mapper);
          expect((observer as any).hostUserTurnId).toBe(mode === 'restart' ? 'host' : null);
        } finally {
          gate.resolve();
          observer.stop();
        }
      },
    );

    it('keeps new consume work behind the unresolved old callback', async () => {
      await writeFile(file, '');
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(nextFile, '');
      const { observer, callbacks } = setup();
      const entered = deferred<void>();
      const gate = deferred<void>();
      callbacks.projectEmbeddedExternal.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
      try {
        await observer.start(file);
        observer.beginUserTurnProjection('old-host');
        await appendFile(file, `${peerTurn('old', 'old').join('\n')}\n`);
        const oldCompletion = observer.completeUserTurnProjection('old-host');
        await entered.promise;
        observer.stop();
        await observer.start(nextFile, await tailStartDescriptor(nextFile));
        observer.beginUserTurnProjection('new-host');
        await appendFile(nextFile, `${peerTurn('new', 'new').join('\n')}\n`);
        const newCompletion = observer.completeUserTurnProjection('new-host');
        await Promise.resolve();
        expect(callbacks.projectEmbeddedExternal).toHaveBeenCalledTimes(1);
        gate.resolve();
        await Promise.all([oldCompletion, newCompletion]);
        expect(callbacks.projectEmbeddedExternal.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'new']);
      } finally {
        gate.resolve();
        observer.stop();
      }
    });

    it('preserves rejection of an already accepted embedded callback after stop', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      const entered = deferred<void>();
      const gate = deferred<void>();
      callbacks.projectEmbeddedExternal.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
      try {
        await observer.start(file);
        observer.beginUserTurnProjection('host');
        await appendFile(file, `${[...peerTurn('e1', 'one'), ...peerTurn('e2', 'two')].join('\n')}\n`);
        const completing = observer.completeUserTurnProjection('host');
        const settlement = completing.then(() => null, error => error);
        const failure = new Error('accepted failure');
        await entered.promise;
        observer.stop();
        gate.reject(failure);
        expect(await settlement).toBe(failure);
        expect(callbacks.projectEmbeddedExternal).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve();
        observer.stop();
      }
    });

    it.each([
      ['chunk', 'resolve'], ['chunk', 'reject'], ['finished', 'resolve'], ['finished', 'reject'],
    ] as const)(
      'does not clear a new pending turn when an old %s callback %ss',
      async (callback, settlement) => {
        await writeFile(file, '');
        const nextFile = join(dir, 'next.jsonl');
        await writeFile(nextFile, `${peerTurn('new', 'new', false).join('\n')}\n`);
        const { observer, callbacks } = setup();
        const entered = deferred<void>();
        const gate = deferred<void>();
        callbacks[callback].mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
        try {
          await observer.start(file);
          observer.beginUserTurnProjection('host');
          const result = JSON.stringify({ type: 'result', subtype: 'success', turn_uuid: 'old' });
          await appendFile(file, `${[...notificationTurn('old', 'old'), result].join('\n')}\n`);
          const completing = observer.completeUserTurnProjection('host');
          const settlementOf = completing.then(() => null, error => error);
          const failure = new Error('old callback failure');
          await entered.promise;
          observer.stop();
          await observer.start(nextFile);
          const reader = (observer as any).reader;
          const active = (observer as any).active;
          const queue = (observer as any).queue;
          expect(active?.started.turnId).toBe('new');
          if (settlement === 'reject') gate.reject(failure);
          else gate.resolve();
          expect(await settlementOf).toBe(settlement === 'reject' ? failure : null);
          expect((observer as any).reader).toBe(reader);
          expect((observer as any).active).toBe(active);
          expect((observer as any).queue).toBe(queue);
          expect(callbacks.released).not.toHaveBeenCalledWith('new');
          expect(callbacks.released).not.toHaveBeenCalledWith('old');
        } finally {
          gate.resolve();
          observer.stop();
        }
      },
    );

    it.each([
      ['chunk', 'cancelled', 'stop'], ['chunk', 'cancelled', 'restart'],
      ['chunk', 'released', 'stop'], ['chunk', 'released', 'restart'],
      ['finished', 'cancelled', 'stop'], ['finished', 'cancelled', 'restart'],
      ['finished', 'released', 'stop'], ['finished', 'released', 'restart'],
    ] as const)(
      'rejects the accepted %s failure when %s reenters with %s',
      async (failing, reentry, action) => {
        await writeFile(file, '');
        const nextFile = join(dir, 'next.jsonl');
        await writeFile(nextFile, '');
        const { observer, callbacks } = setup();
        const failure = new Error('original accepted callback failure');
        if (failing === 'chunk') callbacks.chunk.mockRejectedValueOnce(failure);
        else callbacks.finished.mockRejectedValueOnce(failure);
        const next: {
          restart?: Promise<void>;
          reader?: ClaudeTranscriptTailReader;
          mapper?: unknown;
          queue?: unknown;
          token?: object | null;
          offset?: number;
        } = {};
        const result = (turnId: string) => JSON.stringify({ type: 'result', subtype: 'success', turn_uuid: turnId });
        try {
          await observer.start(file, await tailStartDescriptor(file));
          const oldReader = (observer as any).reader as ClaudeTranscriptTailReader;
          const nextStart = await tailStartDescriptor(nextFile);
          const reenter = () => {
            next.offset = oldReader.getOffset();
            if (action === 'stop') {
              observer.stop();
              return;
            }
            next.restart = observer.start(nextFile, nextStart);
            void next.restart.catch(() => {});
            observer.beginUserTurnProjection('host');
            next.reader = (observer as any).reader;
            next.mapper = (observer as any).mapper;
            next.queue = (observer as any).queue;
            next.token = (observer as any).hostProjection;
          };
          if (reentry === 'cancelled') callbacks.cancelled.mockImplementationOnce(reenter);
          else callbacks.released.mockImplementationOnce(reenter);
          observer.beginUserTurnProjection('host');
          await appendFile(file, `${[...notificationTurn('old', 'old'), result('old')].join('\n')}\n`);
          const expectedOffset = (await stat(file)).size;
          const completion = observer.completeUserTurnProjection('host');
          const outcome = await within(completion.then(() => null, error => error), 'old completion did not settle');
          expect(outcome).toBe(failure);
          expect(next.offset).toBe(expectedOffset);
          expect(oldReader.getOffset()).toBe(expectedOffset);
          expect(callbacks[failing].mock.calls.filter(([event]) => event.turnId === 'old')).toHaveLength(1);
          expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
          expect(callbacks.cancelled).toHaveBeenCalledWith(expect.objectContaining({
            turnId: 'old', reason: failure.message, interrupted: true,
          }));
          expect(callbacks.released).toHaveBeenCalledTimes(reentry === 'cancelled' ? 0 : 1);
          expect((observer as any).reader).toBe(action === 'stop' ? null : next.reader);
          expect((observer as any).hostUserTurnId).toBe(action === 'stop' ? null : 'host');
          if (action === 'stop') return;
          expect(next.restart).toBeDefined();
          await within(next.restart!, 'new reader did not start');
          expect(next.reader).toBeDefined();
          expect((observer as any).reader).toBe(next.reader);
          expect((observer as any).mapper).toBe(next.mapper);
          expect((observer as any).queue).toBe(next.queue);
          expect((observer as any).hostProjection).toBe(next.token);
          expect((observer as any).hostUserTurnId).toBe('host');
          expect(next.reader?.getOffset()).toBe(0);
          expect(callbacks.started.mock.calls.map(([event]) => event.turnId)).toEqual(['old']);
          await appendFile(nextFile, `${[...notificationTurn('new', 'new'), result('new')].join('\n')}\n`);
          await within(observer.completeUserTurnProjection('host'), 'new completion did not settle');
          expect(callbacks.started.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'new']);
          expect(callbacks.finished).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'new' }));
          expect(callbacks.released.mock.calls.map(([turnId]) => turnId))
            .toEqual(reentry === 'cancelled' ? ['new'] : ['old', 'new']);
        } finally {
          observer.stop();
          if (next.restart) await Promise.allSettled([next.restart]);
        }
      },
    );

    it.each([
      ['chunk', 'reject'], ['chunk', 'throw'], ['finished', 'reject'], ['finished', 'throw'],
    ] as const)(
      'rejects a same-owner %s %s while preserving cancellation, release and continuation',
      async (failing, mode) => {
        await writeFile(file, '');
        const { observer, callbacks, order } = setup();
        const failure = new Error('same-owner callback failure');
        if (mode === 'throw') callbacks[failing].mockImplementationOnce(() => { throw failure; });
        else callbacks[failing].mockRejectedValueOnce(failure);
        const result = (turnId: string) => JSON.stringify({ type: 'result', subtype: 'success', turn_uuid: turnId });
        try {
          await observer.start(file, await tailStartDescriptor(file));
          const reader = (observer as any).reader as ClaudeTranscriptTailReader;
          observer.beginUserTurnProjection('host');
          await appendFile(file, `${[
            ...notificationTurn('old', 'old'), result('old'),
            ...notificationTurn('next', 'next'), result('next'),
          ].join('\n')}\n`);
          const expectedOffset = (await stat(file)).size;
          const completion = observer.completeUserTurnProjection('host');
          const outcome = await within(completion.then(() => null, error => error), 'same-owner completion did not settle');
          expect(outcome).toBe(failure);
          expect(reader.getOffset()).toBe(expectedOffset);
          expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
          expect(callbacks.cancelled).toHaveBeenCalledWith(expect.objectContaining({
            turnId: 'old', reason: failure.message, interrupted: true,
          }));
          expect(callbacks.released.mock.calls.map(([turnId]) => turnId)).toEqual(['old', 'next']);
          expect(callbacks.started.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'next']);
          expect(order.indexOf('release:old')).toBeLessThan(order.indexOf('start:next'));
          expect(callbacks.finished).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'next' }));
          observer.beginUserTurnProjection('empty');
          await within(observer.completeUserTurnProjection('empty'), 'empty completion did not settle');
          expect(callbacks.started.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'next']);
        } finally {
          observer.stop();
        }
      },
    );

    it.each([
      ['chunk', 'reject'], ['chunk', 'throw'], ['finished', 'reject'], ['finished', 'throw'],
    ] as const)(
      'reports a same-owner poll %s %s without replaying the accepted batch',
      async (failing, mode) => {
        await writeFile(file, '');
        const { callbacks, order } = setup();
        const failure = new Error('same-owner poll callback failure');
        failure.name = 'SameOwnerPollFailure';
        if (mode === 'throw') callbacks[failing].mockImplementationOnce(() => { throw failure; });
        else callbacks[failing].mockRejectedValueOnce(failure);
        const reported = deferred<void>();
        const diagnostics = {
          record: jest.fn((event: { phase: string; errorName?: string; turnIdHash?: string }) => {
            if (event.phase === 'callback_error' && event.errorName === failure.name && !('turnIdHash' in event)) {
              reported.resolve();
            }
          }),
          hashId: jest.fn(() => 'hash'),
        };
        const observer = new ClaudeTranscriptTurnObserver(callbacks, () => true, diagnostics as any);
        const result = (turnId: string) => JSON.stringify({ type: 'result', subtype: 'success', turn_uuid: turnId });
        try {
          await observer.start(file, await tailStartDescriptor(file));
          const generation = (observer as any).generation;
          const reader = (observer as any).reader as ClaudeTranscriptTailReader;
          await appendFile(file, `${[
            ...notificationTurn('old', 'old'), result('old'),
            ...notificationTurn('next', 'next'), result('next'),
          ].join('\n')}\n`);
          const expectedOffset = (await stat(file)).size;
          await within(reported.promise, 'same-owner poll did not reject its accepted completion', 4_000);
          expect((reader as any).lastPollFailure.error).toBe(failure);
          expect(diagnostics.record).toHaveBeenCalledWith({
            phase: 'callback_error', generation, errorName: failure.name,
          });
          expect(reader.getOffset()).toBe(expectedOffset);
          expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
          expect(callbacks.cancelled).toHaveBeenCalledWith(expect.objectContaining({
            turnId: 'old', reason: failure.message, interrupted: true,
          }));
          expect(callbacks.released.mock.calls.map(([turnId]) => turnId)).toEqual(['old', 'next']);
          expect(callbacks.started.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'next']);
          expect(order.indexOf('release:old')).toBeLessThan(order.indexOf('start:next'));
          expect(callbacks.finished).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'next' }));
          observer.beginUserTurnProjection('empty');
          await within(observer.completeUserTurnProjection('empty'), 'post-failure catch-up did not settle');
          expect(callbacks.started.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'next']);
          expect(reader.getOffset()).toBe(expectedOffset);
          await appendFile(file, `${[...notificationTurn('fresh', 'fresh'), result('fresh')].join('\n')}\n`);
          observer.beginUserTurnProjection('host');
          await within(observer.completeUserTurnProjection('host'), 'fresh catch-up did not settle');
          expect(callbacks.released.mock.calls.map(([turnId]) => turnId)).toEqual(['old', 'next', 'fresh']);
          expect(reader.getOffset()).toBe((await stat(file)).size);
        } finally {
          observer.stop();
        }
      },
      8_000,
    );

    it.each(['chunk', 'finished'] as const)(
      'rejects the original %s failure when continuation promotion restarts the observer',
      async failing => {
        await writeFile(file, '');
        const nextFile = join(dir, 'next.jsonl');
        await writeFile(nextFile, '');
        const { observer, callbacks } = setup();
        const failure = new Error('original callback failure before promotion');
        if (failing === 'chunk') callbacks.chunk.mockRejectedValueOnce(failure);
        else callbacks.finished.mockRejectedValueOnce(failure);
        const next: {
          restart?: Promise<void>;
          reader?: ClaudeTranscriptTailReader;
          token?: object | null;
          offset?: number;
        } = {};
        const result = (turnId: string) => JSON.stringify({ type: 'result', subtype: 'success', turn_uuid: turnId });
        try {
          await observer.start(file, await tailStartDescriptor(file));
          const oldReader = (observer as any).reader as ClaudeTranscriptTailReader;
          const nextStart = await tailStartDescriptor(nextFile);
          callbacks.started.mockImplementation(event => {
            if (event.turnId === 'old-next') {
              next.offset = oldReader.getOffset();
              next.restart = observer.start(nextFile, nextStart);
              void next.restart.catch(() => {});
              observer.beginUserTurnProjection('host');
              next.reader = (observer as any).reader;
              next.token = (observer as any).hostProjection;
            }
            return true;
          });
          observer.beginUserTurnProjection('host');
          await appendFile(file, `${[
            ...notificationTurn('old', 'old'), result('old'),
            ...notificationTurn('old-next', 'next'), result('old-next'),
          ].join('\n')}\n`);
          const expectedOffset = (await stat(file)).size;
          const completion = observer.completeUserTurnProjection('host');
          const outcome = await within(completion.then(() => null, error => error), 'old completion did not settle');
          expect(outcome).toBe(failure);
          expect(next.offset).toBe(expectedOffset);
          expect(oldReader.getOffset()).toBe(expectedOffset);
          expect(callbacks.cancelled.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'old-next']);
          expect(callbacks.released.mock.calls.map(([turnId]) => turnId)).toEqual(['old']);
          expect(next.restart).toBeDefined();
          await within(next.restart!, 'new reader did not start');
          expect((observer as any).reader).toBe(next.reader);
          expect((observer as any).hostProjection).toBe(next.token);
          expect((observer as any).hostUserTurnId).toBe('host');
          expect(next.reader?.getOffset()).toBe(0);
          await appendFile(nextFile, `${[...notificationTurn('new', 'new'), result('new')].join('\n')}\n`);
          await within(observer.completeUserTurnProjection('host'), 'new completion did not settle');
          expect(callbacks.started.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'old-next', 'new']);
          expect(callbacks.released.mock.calls.map(([turnId]) => turnId)).toEqual(['old', 'new']);
        } finally {
          observer.stop();
          if (next.restart) await Promise.allSettled([next.restart]);
        }
      },
    );

    it.each([
      ['chunk', 'cancelled'], ['finished', 'released'],
    ] as const)(
      'reports an accepted poll %s failure to its old owner when %s restarts',
      async (failing, reentry) => {
        await writeFile(file, '');
        const nextFile = join(dir, 'next.jsonl');
        await writeFile(nextFile, '');
        const { callbacks } = setup();
        const failure = new Error('accepted poll callback failure');
        failure.name = 'AcceptedPollFailure';
        if (failing === 'chunk') callbacks.chunk.mockRejectedValueOnce(failure);
        else callbacks.finished.mockRejectedValueOnce(failure);
        const reported = deferred<void>();
        const diagnostics = {
          record: jest.fn((event: { phase: string; generation?: number; errorName?: string; turnIdHash?: string }) => {
            if (event.phase === 'callback_error' && event.errorName === failure.name && !('turnIdHash' in event)) {
              reported.resolve();
            }
          }),
          hashId: jest.fn(() => 'hash'),
        };
        const observer = new ClaudeTranscriptTurnObserver(callbacks, () => true, diagnostics as any);
        const next: {
          restart?: Promise<void>;
          reader?: ClaudeTranscriptTailReader;
          token?: object | null;
          offset?: number;
        } = {};
        const result = (turnId: string) => JSON.stringify({ type: 'result', subtype: 'success', turn_uuid: turnId });
        try {
          await observer.start(file, await tailStartDescriptor(file));
          const generation = (observer as any).generation;
          const oldReader = (observer as any).reader as ClaudeTranscriptTailReader;
          const nextStart = await tailStartDescriptor(nextFile);
          const reenter = () => {
            next.offset = oldReader.getOffset();
            next.restart = observer.start(nextFile, nextStart);
            void next.restart.catch(() => {});
            observer.beginUserTurnProjection('host');
            next.reader = (observer as any).reader;
            next.token = (observer as any).hostProjection;
          };
          if (reentry === 'cancelled') callbacks.cancelled.mockImplementationOnce(reenter);
          else callbacks.released.mockImplementationOnce(reenter);
          observer.beginUserTurnProjection('host');
          await appendFile(file, `${[...notificationTurn('old', 'old'), result('old')].join('\n')}\n`);
          const expectedOffset = (await stat(file)).size;
          await within(reported.promise, 'old poll completion did not report its failure', 4_000);
          expect(diagnostics.record).toHaveBeenCalledWith({
            phase: 'callback_error', generation, errorName: failure.name,
          });
          expect(next.offset).toBe(expectedOffset);
          expect(oldReader.getOffset()).toBe(expectedOffset);
          expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
          expect(callbacks.released).toHaveBeenCalledTimes(reentry === 'cancelled' ? 0 : 1);
          expect(next.restart).toBeDefined();
          await within(next.restart!, 'new reader did not start');
          expect((observer as any).reader).toBe(next.reader);
          expect((observer as any).hostProjection).toBe(next.token);
          expect((observer as any).hostUserTurnId).toBe('host');
          expect(next.reader?.getOffset()).toBe(0);
          await appendFile(nextFile, `${[...notificationTurn('new', 'new'), result('new')].join('\n')}\n`);
          await within(observer.completeUserTurnProjection('host'), 'new completion did not settle');
          expect(callbacks.started.mock.calls.map(([event]) => event.turnId)).toEqual(['old', 'new']);
          expect(callbacks.released.mock.calls.map(([turnId]) => turnId))
            .toEqual(reentry === 'cancelled' ? ['new'] : ['old', 'new']);
        } finally {
          observer.stop();
          if (next.restart) await Promise.allSettled([next.restart]);
        }
      },
      8_000,
    );

    it('does not drain the new active pending turn when an old chunk returns', async () => {
      await writeFile(file, '');
      const nextFile = join(dir, 'next.jsonl');
      const secondChunk = JSON.stringify({ type: 'assistant', uuid: 'new-a2', message: { id: 'new-m2', role: 'assistant', content: [{ type: 'text', text: 'second' }], stop_reason: 'tool_use' } });
      await writeFile(nextFile, `${[...peerTurn('new', 'new', false), secondChunk].join('\n')}\n`);
      const { observer, callbacks } = setup();
      const oldEntered = deferred<void>();
      const newEntered = deferred<void>();
      const oldGate = deferred<void>();
      const newGate = deferred<void>();
      callbacks.chunk.mockImplementation(async event => {
        if (event.turnId === 'old') { oldEntered.resolve(); await oldGate.promise; }
        else if (callbacks.chunk.mock.calls.filter(([item]) => item.turnId === 'new').length === 1) {
          newEntered.resolve();
          await newGate.promise;
        }
      });
      try {
        await observer.start(file);
        const reader = (observer as any).reader as ClaudeTranscriptTailReader;
        await appendFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
        const batch = await reader.readAvailable();
        const oldConsume = (observer as any).consumeBatch(batch, (observer as any).generation) as Promise<void>;
        await oldEntered.promise;
        observer.stop();
        const newStart = observer.start(nextFile);
        await newEntered.promise;
        oldGate.resolve();
        await oldConsume;
        expect(callbacks.chunk.mock.calls.filter(([event]) => event.turnId === 'new')).toHaveLength(1);
        newGate.resolve();
        await newStart;
        expect(callbacks.chunk.mock.calls.filter(([event]) => event.turnId === 'new')).toHaveLength(2);
      } finally {
        oldGate.resolve();
        newGate.resolve();
        observer.stop();
      }
    });

    it('does not run an old queued completion against a same-id new host', async () => {
      await writeFile(file, '');
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(nextFile, '');
      const { observer, callbacks } = setup();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const closing = deferred<void>();
      const closeGate = deferred<void>();
      const closed = deferred<void>();
      const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');
      const open = fsPromises.open;
      let restoreOpen = () => {};
      let first: Promise<void> | undefined;
      let queued: Promise<void> | undefined;
      callbacks.projectEmbeddedExternal.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
      try {
        await observer.start(file);
        observer.beginUserTurnProjection('host');
        await appendFile(file, `${peerTurn('old', 'old').join('\n')}\n`);
        first = observer.completeUserTurnProjection('host');
        void first.catch(() => {});
        await within(entered.promise, 'first callback did not enter');
        observer.beginUserTurnProjection('host');
        await appendFile(file, `${peerTurn('queued-old', 'queued').join('\n')}\n`);
        const oldReader = (observer as any).reader as ClaudeTranscriptTailReader;
        const previousOffset = oldReader.getOffset();
        const expectedOffset = (await stat(file)).size;
        const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
          const handle = await open(...args);
          const close = handle.close.bind(handle);
          handle.close = async () => { closing.resolve(); await closeGate.promise; await close(); closed.resolve(); };
          return handle;
        });
        restoreOpen = () => openSpy.mockRestore();
        queued = observer.completeUserTurnProjection('host');
        void queued.catch(() => {});
        await within(closing.promise, 'queued catch-up did not reach physical close');
        expect(oldReader.getOffset()).toBe(previousOffset);
        closeGate.resolve();
        await within(closed.promise, 'queued catch-up did not close');
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(oldReader.getOffset()).toBe(expectedOffset);
        openSpy.mockRestore();
        observer.stop();
        await observer.start(nextFile, await tailStartDescriptor(nextFile));
        observer.beginUserTurnProjection('host');
        const reader = (observer as any).reader as ClaudeTranscriptTailReader;
        const mapper = (observer as any).mapper;
        const queue = (observer as any).queue;
        const hostProjection = (observer as any).hostProjection;
        let newOpens = 0;
        const newOpenSpy = jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
          if (args[0] === nextFile) newOpens += 1;
          return open(...args);
        });
        restoreOpen = () => newOpenSpy.mockRestore();
        gate.resolve();
        await within(Promise.all([first, queued]), 'old completions did not settle');
        expect(newOpens).toBe(0);
        expect((observer as any).reader).toBe(reader);
        expect((observer as any).mapper).toBe(mapper);
        expect((observer as any).queue).toBe(queue);
        expect((observer as any).hostProjection).toBe(hostProjection);
        expect((observer as any).hostUserTurnId).toBe('host');
        expect(reader.getOffset()).toBe(0);
        expect(callbacks.projectEmbeddedExternal.mock.calls.map(([event]) => event.turnId)).toEqual(['old']);
      } finally {
        closeGate.resolve();
        gate.resolve();
        observer.stop();
        restoreOpen();
        await Promise.allSettled([first, queued].filter((item): item is Promise<void> => item !== undefined));
      }
    });

    it('drops a read that returns after stop and restart with the same host id', async () => {
      await writeFile(file, '');
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(nextFile, '');
      const { observer, callbacks } = setup();
      const closing = deferred<void>();
      const gate = deferred<void>();
      const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');
      const open = fsPromises.open;
      let restoreOpen = () => {};
      let completing: Promise<void> | undefined;
      try {
        await observer.start(file);
        observer.beginUserTurnProjection('host');
        const oldLines = peerTurn('old', 'old');
        await appendFile(file, `${oldLines.join('\n')}\n`);
        const oldReader = (observer as any).reader as ClaudeTranscriptTailReader;
        const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
          const handle = await open(...args);
          const close = handle.close.bind(handle);
          handle.close = async () => { closing.resolve(); await gate.promise; await close(); };
          return handle;
        });
        restoreOpen = () => openSpy.mockRestore();
        completing = observer.completeUserTurnProjection('host');
        void completing.catch(() => {});
        await within(closing.promise, 'old read did not reach physical close');
        expect(oldReader.getOffset()).toBe(0);
        observer.stop();
        await observer.start(nextFile, await tailStartDescriptor(nextFile));
        observer.beginUserTurnProjection('host');
        const reader = (observer as any).reader as ClaudeTranscriptTailReader;
        const mapper = (observer as any).mapper;
        const queue = (observer as any).queue;
        const hostProjection = (observer as any).hostProjection;
        gate.resolve();
        await within(completing, 'old read did not settle after close');
        expect(oldReader.getOffset()).toBe(0);
        expect((observer as any).reader).toBe(reader);
        expect((observer as any).mapper).toBe(mapper);
        expect((observer as any).queue).toBe(queue);
        expect((observer as any).hostProjection).toBe(hostProjection);
        expect((observer as any).hostUserTurnId).toBe('host');
        expect(reader.getOffset()).toBe(0);
        expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
        openSpy.mockRestore();
        expect((await oldReader.readAvailable()).lines).toEqual(oldLines);
        await appendFile(nextFile, `${peerTurn('new', 'new').join('\n')}\n`);
        await observer.completeUserTurnProjection('host');
        expect(callbacks.projectEmbeddedExternal.mock.calls.map(([event]) => event.turnId)).toEqual(['new']);
      } finally {
        gate.resolve();
        observer.stop();
        restoreOpen();
        if (completing) await Promise.allSettled([completing]);
      }
    });

    it('reports a late poll close failure to its original generation after restart', async () => {
      await writeFile(file, '');
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(nextFile, '');
      const { callbacks } = setup();
      const reported = deferred<void>();
      const closing = deferred<void>();
      const gate = deferred<void>();
      const closed = deferred<void>();
      const failure = new Error('old poll close failure');
      failure.name = 'OldPollCloseError';
      const diagnostics = {
        record: jest.fn((event: { phase: string; generation?: number; errorName?: string }) => {
          if (event.phase === 'callback_error') reported.resolve();
        }),
        hashId: jest.fn(() => 'hash'),
      };
      const observer = new ClaudeTranscriptTurnObserver(callbacks, () => true, diagnostics as any);
      const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');
      const open = fsPromises.open;
      let restoreOpen = () => {};
      let closeEntered = false;
      try {
        await observer.start(file);
        const oldGeneration = (observer as any).generation;
        const oldReader = (observer as any).reader as ClaudeTranscriptTailReader;
        await appendFile(file, `${peerTurn('old', 'old').join('\n')}\n`);
        const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
          const handle = await open(...args);
          const close = handle.close.bind(handle);
          handle.close = async () => {
            closeEntered = true;
            closing.resolve();
            await gate.promise;
            await close();
            closed.resolve();
            throw failure;
          };
          return handle;
        });
        restoreOpen = () => openSpy.mockRestore();
        await within(closing.promise, 'old poll did not reach physical close', 3_500);
        expect(oldReader.getOffset()).toBe(0);
        observer.stop();
        await observer.start(nextFile, await tailStartDescriptor(nextFile));
        observer.beginUserTurnProjection('host');
        const reader = (observer as any).reader;
        const mapper = (observer as any).mapper;
        const queue = (observer as any).queue;
        const token = (observer as any).hostProjection;
        gate.resolve();
        await within(closed.promise, 'old poll handle did not close');
        await within(reported.promise, 'old poll failure lost its error owner');
        expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
          phase: 'callback_error', generation: oldGeneration, errorName: failure.name,
        }));
        expect((observer as any).reader).toBe(reader);
        expect((observer as any).mapper).toBe(mapper);
        expect((observer as any).queue).toBe(queue);
        expect((observer as any).hostProjection).toBe(token);
        expect(oldReader.getOffset()).toBe(0);
        expect(callbacks.started).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        observer.stop();
        restoreOpen();
        if (closeEntered) await within(closed.promise, 'old handle remained open during cleanup');
      }
    }, 8_000);

    it('binds a post-reset poll failure to the new watcher generation', async () => {
      await writeFile(file, 'old\n');
      const { callbacks } = setup();
      const reported = deferred<void>();
      const closed = deferred<void>();
      const failure = new Error('post-reset poll read failure');
      failure.name = 'NewPollReadError';
      const diagnostics = {
        record: jest.fn((event: { phase: string; generation?: number; errorName?: string }) => {
          if (event.phase === 'callback_error') reported.resolve();
        }),
        hashId: jest.fn(() => 'hash'),
      };
      const observer = new ClaudeTranscriptTurnObserver(callbacks, () => true, diagnostics as any);
      const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');
      const open = fsPromises.open;
      let restoreOpen = () => {};
      try {
        await observer.start(file);
        const oldGeneration = (observer as any).generation;
        observer.beginUserTurnProjection('host');
        await writeFile(file, '');
        await observer.completeUserTurnProjection('host');
        const generation = (observer as any).generation;
        const reader = (observer as any).reader as ClaudeTranscriptTailReader;
        expect(generation).toBeGreaterThan(oldGeneration);
        await appendFile(file, `${peerTurn('new', 'new').join('\n')}\n`);
        const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
          const handle = await open(...args);
          handle.read = (async () => { throw failure; }) as typeof handle.read;
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); closed.resolve(); };
          return handle;
        });
        restoreOpen = () => openSpy.mockRestore();
        await within(closed.promise, 'post-reset poll did not close its handle', 3_500);
        await within(reported.promise, 'post-reset poll failure lost its error owner');
        expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
          phase: 'callback_error', generation, errorName: failure.name,
        }));
        expect((reader as any).lastPollFailure.error).toBe(failure);
        expect(reader.getOffset()).toBe(0);
        expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
      } finally {
        restoreOpen();
        observer.stop();
      }
    }, 8_000);

    it('does not start a new reader when an old prime completes after restart', async () => {
      await writeFile(file, '');
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(nextFile, '');
      const { observer } = setup();
      const entered = deferred<void>();
      const gate = deferred<void>();
      const originalPrime = ClaudeTranscriptTailReader.prototype.prime;
      const prime = jest.spyOn(ClaudeTranscriptTailReader.prototype, 'prime')
        .mockImplementationOnce(async function (this: ClaudeTranscriptTailReader, offset?: number) {
          entered.resolve();
          await gate.promise;
          await originalPrime.call(this, offset);
        });
      try {
        const oldStart = observer.start(file);
        await entered.promise;
        observer.stop();
        await observer.start(nextFile, await tailStartDescriptor(nextFile));
        const reader = (observer as any).reader as ClaudeTranscriptTailReader;
        const start = jest.spyOn(reader, 'start');
        gate.resolve();
        await oldStart;
        expect((observer as any).reader).toBe(reader);
        expect(start).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        prime.mockRestore();
        observer.stop();
      }
    });

    it('leaves a reentrant start authoritative over an outer start', async () => {
      const nextFile = join(dir, 'next.jsonl');
      const outerFile = join(dir, 'outer.jsonl');
      await writeFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
      await writeFile(nextFile, '');
      await writeFile(outerFile, '');
      const { observer, callbacks } = setup();
      let restarted: Promise<void> | undefined;
      try {
        await observer.start(file);
        const nextStart = await tailStartDescriptor(nextFile);
        callbacks.cancelled.mockImplementationOnce(() => { restarted = observer.start(nextFile, nextStart); });
        await observer.start(outerFile, await tailStartDescriptor(outerFile));
        await restarted;
        expect((observer as any).reader?.filePath).toBe(nextFile);
      } finally {
        observer.stop();
      }
    });

    it('does not poll after reset priming cannot stat the transcript', async () => {
      await writeFile(file, '');
      const { observer } = setup();
      try {
        await observer.start(file);
        const reader = (observer as any).reader as ClaudeTranscriptTailReader;
        const start = jest.spyOn(reader, 'start');
        const prime = reader.prime.bind(reader);
        jest.spyOn(reader, 'prime').mockImplementationOnce(async offset => {
          await unlink(file);
          await prime(offset);
        });
        await (observer as any).consumeBatch({ lines: [], reset: true }, (observer as any).generation);
        expect(start).not.toHaveBeenCalled();
      } finally {
        observer.stop();
      }
    });

    it('completes the host projection when its read observes a transcript reset', async () => {
      await writeFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
      const { observer } = setup();
      try {
        await observer.start(file);
        observer.beginUserTurnProjection('host');
        await writeFile(file, '');
        await observer.completeUserTurnProjection('host');
        expect((observer as any).hostUserTurnId).toBeNull();
      } finally {
        observer.stop();
      }
    });

    it('does not let transcript-reset cancellation overwrite a reentrant start', async () => {
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
      await writeFile(nextFile, '');
      const { observer, callbacks } = setup();
      let restarted: Promise<void> | undefined;
      try {
        await observer.start(file);
        const nextStart = await tailStartDescriptor(nextFile);
        callbacks.cancelled.mockImplementationOnce(() => {
          restarted = observer.start(nextFile, nextStart);
          observer.beginUserTurnProjection('new-host');
        });
        const oldGeneration = (observer as any).generation;
        await (observer as any).consumeBatch({ lines: [], reset: true }, oldGeneration);
        await restarted;
        expect((observer as any).reader?.filePath).toBe(nextFile);
        expect((observer as any).hostUserTurnId).toBe('new-host');
      } finally {
        observer.stop();
      }
    });

    it('does not release an old turn after interrupt cancellation starts a new generation', async () => {
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
      await writeFile(nextFile, '');
      const { observer, callbacks } = setup();
      let restarted: Promise<void> | undefined;
      try {
        await observer.start(file);
        const nextStart = await tailStartDescriptor(nextFile);
        callbacks.cancelled.mockImplementationOnce(() => {
          restarted = observer.start(nextFile, nextStart);
          observer.beginUserTurnProjection('new-host');
        });
        observer.interruptActiveTurn('user_cancel');
        await restarted;
        expect((observer as any).reader?.filePath).toBe(nextFile);
        expect((observer as any).hostUserTurnId).toBe('new-host');
        expect(callbacks.released).not.toHaveBeenCalledWith('old');
      } finally {
        observer.stop();
      }
    });

    it('does not requeue an old pending turn when started synchronously restarts', async () => {
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(file, '');
      await writeFile(nextFile, '');
      const { observer, callbacks } = setup();
      let restarted: Promise<void> | undefined;
      try {
        await observer.start(file);
        const nextStart = await tailStartDescriptor(nextFile);
        callbacks.started.mockImplementationOnce(() => {
          restarted = observer.start(nextFile, nextStart);
          return false;
        });
        const generation = (observer as any).generation;
        await (observer as any).consumeBatch({ lines: peerTurn('old', 'old', false), reset: false }, generation);
        await restarted;
        expect((observer as any).reader?.filePath).toBe(nextFile);
        expect((observer as any).active).toBeNull();
        expect((observer as any).queue).toHaveLength(0);
      } finally {
        observer.stop();
      }
    });

    it('does not clear a generation started synchronously from cancellation', async () => {
      const nextFile = join(dir, 'next.jsonl');
      await writeFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
      await writeFile(nextFile, '');
      const { observer, callbacks } = setup();
      let restarted: Promise<void> | undefined;
      try {
        await observer.start(file);
        const nextStart = await tailStartDescriptor(nextFile);
        callbacks.cancelled.mockImplementationOnce(() => {
          restarted = observer.start(nextFile, nextStart);
          observer.beginUserTurnProjection('new-host');
          observer.registerHostUserTranscriptId('new-row');
        });
        observer.stop();
        await restarted;
        expect((observer as any).reader?.filePath).toBe(nextFile);
        expect((observer as any).hostUserTurnId).toBe('new-host');
        expect((observer as any).hostUserTranscriptIds.has('new-row')).toBe(true);
      } finally {
        observer.stop();
      }
    });
  });

  it('reads host catch-up and projects a mid-turn peer before settling the captured token', async () => {
    await writeFile(file, '');
    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      observer.beginUserTurnProjection('host');
      await appendFile(file, `${peerTurn('old', 'old').join('\n')}\n`);
      await observer.completeUserTurnProjection('host');
      expect((observer as any).hostUserTurnId).toBeNull();
      expect((observer as any).hostProjection).toBeNull();
      expect(callbacks.started).not.toHaveBeenCalled();
      expect(callbacks.projectEmbeddedExternal).toHaveBeenCalledTimes(1);
      expect(callbacks.projectEmbeddedExternal).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'old' }));
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      expect(reader.getOffset()).toBe((await stat(file)).size);
    } finally {
      observer.stop();
    }
  });

  it('keeps host catch-up IO running while an accepted callback gates the FIFO', async () => {
    await writeFile(file, '');
    const { observer, callbacks, order } = setup();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const closing = deferred<void>();
    const closeGate = deferred<void>();
    const closed = deferred<void>();
    const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');
    let restoreOpen = () => {};
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let bytesRead = 0;
    callbacks.projectEmbeddedExternal.mockImplementation(async event => {
      order.push(`embedded:${event.turnId}`);
      if (event.turnId === 'e1') { entered.resolve(); await gate.promise; }
    });
    try {
      await observer.start(file);
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      observer.beginUserTurnProjection('h1');
      await appendFile(file, `${peerTurn('e1', 'one').join('\n')}\n`);
      first = observer.completeUserTurnProjection('h1');
      void first.catch(() => {});
      await entered.promise;
      const firstOffset = reader.getOffset();
      observer.beginUserTurnProjection('h2');
      const next = `${peerTurn('e2', 'two').join('\n')}\n`;
      await appendFile(file, next);
      const open = fsPromises.open;
      const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
        const handle = await open(...args);
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          bytesRead += result.bytesRead;
          return result;
        }) as typeof handle.read;
        const close = handle.close.bind(handle);
        handle.close = async () => { closing.resolve(); await closeGate.promise; await close(); closed.resolve(); };
        return handle;
      });
      restoreOpen = () => openSpy.mockRestore();
      second = observer.completeUserTurnProjection('h2');
      void second.catch(() => {});
      await Promise.race([
        closing.promise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('host catch-up did not reach physical close while FIFO was gated')), 1_500);
        }),
      ]);
      expect(bytesRead).toBe(Buffer.byteLength(next));
      expect(reader.getOffset()).toBe(firstOffset);
      expect(order).toEqual(['embedded:e1']);
      closeGate.resolve();
      await closed.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(reader.getOffset()).toBe(firstOffset + Buffer.byteLength(next));
      expect(order).toEqual(['embedded:e1']);
      gate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(['embedded:e1', 'embedded:e2']);
      expect((observer as any).hostUserTurnId).toBeNull();
    } finally {
      if (deadline) clearTimeout(deadline);
      closeGate.resolve();
      gate.resolve();
      observer.stop();
      restoreOpen();
      await Promise.allSettled([first, second].filter((item): item is Promise<void> => item !== undefined));
    }
  });

  it('settles the captured host token even when the read observes a reset', async () => {
    await writeFile(file, `${peerTurn('old', 'old', false).join('\n')}\n`);
    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      observer.beginUserTurnProjection('host');
      await writeFile(file, '');
      await observer.completeUserTurnProjection('host');
      expect((observer as any).hostUserTurnId).toBeNull();
      expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
    } finally {
      observer.stop();
    }
  });

  it('settles the captured host token on an empty catch-up batch', async () => {
    await writeFile(file, '');
    const { observer } = setup();
    try {
      await observer.start(file);
      observer.beginUserTurnProjection('host');
      await observer.completeUserTurnProjection('host');
      expect((observer as any).hostUserTurnId).toBeNull();
      expect((observer as any).hostProjection).toBeNull();
    } finally {
      observer.stop();
    }
  });

  it('serializes poll and host consumption while host IO runs during a poll callback', async () => {
    await writeFile(file, '');
    const { observer, callbacks, order } = setup();
    const pollEntered = deferred<void>();
    const pollGate = deferred<void>();
    const closing = deferred<void>();
    const closeGate = deferred<void>();
    const closed = deferred<void>();
    const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');
    const open = fsPromises.open;
    let restoreOpen = () => {};
    let completing: Promise<void> | undefined;
    callbacks.finished.mockImplementationOnce(async event => {
      order.push(`finish:${event.turnId}`);
      pollEntered.resolve();
      await pollGate.promise;
    });
    try {
      await observer.start(file);
      await appendFile(file, `${peerTurn('poll', 'poll').join('\n')}\n`);
      await within(pollEntered.promise, 'poll callback did not enter', 3_500);
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      const pollOffset = reader.getOffset();
      observer.beginUserTurnProjection('host');
      const next = `${peerTurn('host-peer', 'host').join('\n')}\n`;
      await appendFile(file, next);
      const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
        const handle = await open(...args);
        const close = handle.close.bind(handle);
        handle.close = async () => { closing.resolve(); await closeGate.promise; await close(); closed.resolve(); };
        return handle;
      });
      restoreOpen = () => openSpy.mockRestore();
      completing = observer.completeUserTurnProjection('host');
      void completing.catch(() => {});
      await within(closing.promise, 'host IO did not reach close while poll consumption was gated');
      expect(reader.getOffset()).toBe(pollOffset);
      expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
      closeGate.resolve();
      await within(closed.promise, 'host IO did not close');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(reader.getOffset()).toBe(pollOffset + Buffer.byteLength(next));
      expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
      pollGate.resolve();
      await within(completing, 'host completion did not follow poll completion');
      expect(callbacks.projectEmbeddedExternal.mock.calls.map(([event]) => event.turnId)).toEqual(['host-peer']);
      expect(order.indexOf('finish:poll')).toBeGreaterThan(-1);
      expect(order.indexOf('release:poll')).toBeGreaterThan(order.indexOf('finish:poll'));
      expect(order.indexOf('embedded:host-peer')).toBeGreaterThan(order.indexOf('release:poll'));
    } finally {
      closeGate.resolve();
      pollGate.resolve();
      observer.stop();
      restoreOpen();
      if (completing) await Promise.allSettled([completing]);
    }
  }, 8_000);

  it.each(['open', 'read', 'close'] as const)(
    'preserves host catch-up %s failure without consuming or projecting the batch',
    async stage => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');
      const open = fsPromises.open;
      const failure = new Error(`host ${stage} failure`);
      let restoreOpen = () => {};
      try {
        await observer.start(file);
        observer.beginUserTurnProjection('host');
        const token = (observer as any).hostProjection;
        await appendFile(file, `${peerTurn('peer', 'value').join('\n')}\n`);
        const reader = (observer as any).reader as ClaudeTranscriptTailReader;
        const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
          if (stage === 'open') throw failure;
          const handle = await open(...args);
          if (stage === 'read') handle.read = (async () => { throw failure; }) as typeof handle.read;
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); if (stage === 'close') throw failure; };
          return handle;
        });
        restoreOpen = () => openSpy.mockRestore();
        await expect(observer.completeUserTurnProjection('host')).rejects.toBe(failure);
        expect(reader.getOffset()).toBe(0);
        expect((observer as any).hostProjection).toBe(token);
        expect(callbacks.started).not.toHaveBeenCalled();
        expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
        openSpy.mockRestore();
        await observer.completeUserTurnProjection('host');
        expect(reader.getOffset()).toBe((await stat(file)).size);
        expect(callbacks.projectEmbeddedExternal.mock.calls.map(([event]) => event.turnId)).toEqual(['peer']);
        expect((observer as any).hostUserTurnId).toBeNull();
      } finally {
        restoreOpen();
        observer.stop();
      }
    },
  );

  it('recovery replays only an unfinished external turn', async () => {
    await writeFile(file, `${peerTurn('peer-open', 'hello', false).join('\n')}\n`);
    const { observer, callbacks } = setup();
    await observer.start(file);
    observer.stop();
    expect(callbacks.started).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-open', replay: true }));
    expect(callbacks.chunk).toHaveBeenCalledWith(expect.objectContaining({ replay: true }));
    expect(callbacks.finished).not.toHaveBeenCalled();
  });

  it('starts from an explicit snapshot boundary without recovery duplication', async () => {
    const snapshot = `${peerTurn('old', 'old').join('\n')}\n`;
    await writeFile(file, snapshot);
    const boundary = (await stat(file)).size;
    const { observer, callbacks } = setup();
    await observer.start(file, await tailStartDescriptor(file, boundary));
    await appendFile(file, `${peerTurn('new', 'new').join('\n')}\n`);
    const reader = (observer as any).reader as ClaudeTranscriptTailReader;
    const batch = await reader.readAvailable();
    await (observer as any).consumeBatch(batch, (observer as any).generation);
    expect(callbacks.started).toHaveBeenCalledTimes(1);
    expect(callbacks.started).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'new' }));
    observer.stop();
  });

  it('recovery primes completed history without reprojecting it', async () => {    await writeFile(file, `${peerTurn('peer-done', 'hello').join('\n')}\n`);
    const { observer, callbacks } = setup();
    await observer.start(file);
    observer.stop();
    expect(callbacks.started).not.toHaveBeenCalled();
    expect(callbacks.chunk).not.toHaveBeenCalled();
  });

  it('reset recovery replays an external start as started even while a host user turn is active', async () => {
    // Transcript-replaced recovery (batch.reset) does not clear
    // hostUserTurnId. The replay path must keep the baseline projection:
    // mapLine replays without a context (mapper default hostUserTurnActive
    // = false), so the external start promotes as `started`. Diverting it
    // into `embedded` (live hostUserTurnActive) would push the event into
    // embeddedQueue while the mapper's active turn is already open — the
    // buffered chunks then find no pending record and the turn's content is
    // silently dropped without ever settling.
    await writeFile(file, '');
    const { observer, callbacks } = setup();
    await observer.start(file);
    observer.beginUserTurnProjection('host-active');
    const generation = (observer as any).generation;

    try {
      await appendFile(file, `${peerTurn('peer-reset', 'hi', false).join('\n')}\n`);
      await (observer as any).consumeBatch({ lines: [], reset: true }, generation);

      expect(callbacks.started).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-reset', replay: true }));
      expect(callbacks.projectEmbeddedExternal).not.toHaveBeenCalled();
    } finally {
      observer.stop();
    }
  });

  it('clears a pending quiet timer when settled directly instead of orphaning it', async () => {
    await writeFile(file, '');
    const { observer } = setup();
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
    try {
      await observer.start(file);
      const generation = (observer as any).generation;
      // A terminal candidate schedules the quiet-settle timer.
      await (observer as any).consumeBatch({ lines: peerTurn('peer-x', 'x').slice(0, -1), lineOffsets: [0, 100, 200], reset: false }, generation);
      const pending = (observer as any).quietTimer as ReturnType<typeof setTimeout> | null;
      expect(pending).not.toBeNull();

      // Direct settlement (as tests and future callers do) must drop the
      // still-pending timeout: an orphaned 2s timer fires long after the
      // observer is done and keeps the worker alive.
      await (observer as any).settleQuietCandidate(generation);
      expect(clearSpy).toHaveBeenCalledWith(pending);
    } finally {
      // Always stop the observer: the reader poll loop and any leaked timer
      // would otherwise keep the Jest worker from exiting.
      clearSpy.mockRestore();
      observer.stop();
    }
  });

  it('marks a delayed auto completion superseded when a later host user row exists', async () => {
    await writeFile(file, '');
    const { observer, callbacks } = setup();
    await observer.start(file);
    const generation = (observer as any).generation;
    observer.registerHostUserTranscriptId('host-row');
    const lines = [
      ...peerTurn('peer-old', 'old').slice(0, -1),
      JSON.stringify({ type: 'user', uuid: 'host-row', message: { role: 'user', content: 'new prompt' } }),
    ];
    await (observer as any).consumeBatch({ lines, lineOffsets: [0, 100, 200, 300], reset: false }, generation);
    await (observer as any).settleQuietCandidate(generation);

    expect(callbacks.finished).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'peer-old',
      terminalOffset: 200,
      supersededByHostUser: true,
    }));
    observer.stop();
  });

  it('does not supersede an auto terminal that follows the latest host user row', async () => {
    await writeFile(file, '');
    const { observer, callbacks } = setup();
    await observer.start(file);
    const generation = (observer as any).generation;
    observer.registerHostUserTranscriptId('host-row');
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'host-row', message: { role: 'user', content: 'new prompt' } }),
      ...peerTurn('peer-new', 'new').slice(0, -1),
    ];
    await (observer as any).consumeBatch({ lines, lineOffsets: [0, 100, 200, 300], reset: false }, generation);
    await (observer as any).settleQuietCandidate(generation);

    expect(callbacks.finished).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'peer-new',
      terminalOffset: 300,
      supersededByHostUser: false,
    }));
    observer.stop();
  });

  it('holds FIFO until the feature lease is available, then finishes before release', async () => {
    let available = false;
    const { observer, callbacks, order } = setup(() => available);
    await writeFile(file, '');
    await observer.start(file);
    const generation = (observer as any).generation;
    await (observer as any).consumeBatch({ lines: peerTurn('peer-1', 'one'), reset: false }, generation);
    expect(callbacks.started).not.toHaveBeenCalled();
    available = true;
    observer.beginUserTurnProjection('host');
    await observer.completeUserTurnProjection('host');
    expect(order).toEqual([
      'start:peer-1',
      'chunk:peer-1:text',
      'chunk:peer-1:text',
      'finish:peer-1',
      'release:peer-1',
    ]);
    observer.stop();
  });

  it('runs two queued peer turns strictly in FIFO order: peer-1 full chain, then peer-2, releases last', async () => {
    // v6 §验证方式 4: both peers queue behind a busy user turn; after the
    // user turn hands over, peer-1 runs its whole chain before peer-2 starts,
    // and the release signals (the feature queue pump) fire only afterwards.
    let available = false;
    const { observer, order } = setup(() => available);
    await writeFile(file, '');
    await observer.start(file);
    const generation = (observer as any).generation;
    await (observer as any).consumeBatch({ lines: peerTurn('peer-1', 'one'), reset: false }, generation);
    await (observer as any).consumeBatch({ lines: peerTurn('peer-2', 'two'), reset: false }, generation);
    expect(order).toEqual([]);

    available = true;
    observer.beginUserTurnProjection('host');
    await observer.completeUserTurnProjection('host');

    expect(order).toEqual([
      'start:peer-1',
      'chunk:peer-1:text',
      'chunk:peer-1:text',
      'finish:peer-1',
      'release:peer-1',
      'start:peer-2',
      'chunk:peer-2:text',
      'chunk:peer-2:text',
      'finish:peer-2',
      'release:peer-2',
    ]);
    observer.stop();
  });

  it('releases turn A before promoting turn B', async () => {
    const { observer, order } = setup();
    await writeFile(file, '');
    await observer.start(file);
    const generation = (observer as any).generation;
    await (observer as any).consumeBatch({
      lines: [...peerTurn('peer-a', 'one'), ...peerTurn('peer-b', 'two')],
      reset: false,
    }, generation);
    await (observer as any).settleQuietCandidate(generation);
    expect(order.indexOf('release:peer-a')).toBeLessThan(order.indexOf('start:peer-b'));
    observer.stop();
  });

  it('times out a stuck chunk callback, releases, and continues the next turn', async () => {
    jest.useFakeTimers();
    const { observer, callbacks, order } = setup();
    callbacks.chunk.mockImplementationOnce(() => new Promise(() => {}));
    await writeFile(file, '');
    await observer.start(file);
    const generation = (observer as any).generation;
    try {
      const consuming = (observer as any).consumeBatch({
        lines: [...peerTurn('peer-stuck', 'stuck'), ...peerTurn('peer-next', 'next')],
        reset: false,
      }, generation);
      const settlement = consuming.then(() => null, (error: unknown) => error);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(await settlement).toEqual(expect.objectContaining({ message: 'chunk_timeout' }));
      await (observer as any).settleQuietCandidate(generation);
      expect(callbacks.cancelled).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-stuck' }));
      expect(order).toContain('release:peer-stuck');
      expect(order).toContain('start:peer-next');
    } finally {
      observer.stop();
      jest.useRealTimers();
    }
  });

  it('projects a mid-turn peer only as an embedded bubble after catch-up', async () => {
    await writeFile(file, '');
    const { observer, callbacks, order } = setup();
    await observer.start(file);
    observer.beginUserTurnProjection('host-1');
    await appendFile(file, `${peerTurn('peer-mid', 'mid turn').join('\n')}\n`);

    await observer.completeUserTurnProjection('host-1');

    expect(order).toEqual(['embedded:peer-mid']);
    expect(callbacks.started).not.toHaveBeenCalled();
    expect(callbacks.chunk).not.toHaveBeenCalled();
    expect(callbacks.finished).not.toHaveBeenCalled();
    expect((observer as any).mapper.hasOpenTurn()).toBe(false);
    observer.stop();
  });

  it('invalidates stale generation callbacks on stop', async () => {
    await writeFile(file, '');
    const { observer, callbacks } = setup();
    await observer.start(file);
    const stale = (observer as any).generation;
    observer.stop();
    await (observer as any).consumeBatch({ lines: peerTurn('peer-stale', 'stale'), reset: false }, stale);
    expect(callbacks.started).not.toHaveBeenCalled();
  });

  it.each(['chunk', 'finished'])('cancels and releases the lease when %s callback rejects', async failing => {
    await writeFile(file, '');
    const { observer, callbacks } = setup();
    const failure = new Error('injected');
    callbacks[failing as 'chunk' | 'finished'].mockRejectedValueOnce(failure);
    await observer.start(file);
    const generation = (observer as any).generation;
    try {
      await expect((observer as any).consumeBatch({ lines: peerTurn('peer-fail', 'failure'), reset: false }, generation)).rejects.toBe(failure);
      expect(callbacks.cancelled).toHaveBeenCalledWith(expect.objectContaining({
        turnId: 'peer-fail',
        interrupted: true,
      }));
    } finally {
      observer.stop();
    }
  });

  it('stops an unfinished active turn with the interrupted flag, never as completed', async () => {
    await writeFile(file, `${peerTurn('peer-open-stop', 'hello', false).join('\n')}\n`);
    const { observer, callbacks } = setup();
    await observer.start(file);
    observer.stop();
    expect(callbacks.finished).not.toHaveBeenCalled();
    expect(callbacks.cancelled).toHaveBeenCalledWith({
      turnId: 'peer-open-stop',
      generation: 3,
      reason: 'observer_stopped',
      interrupted: true,
    });
  });

  it('settles queued turns promoted after a user cancel deterministically, keeping drained content (2.5.1 残余 a)', async () => {
    // 2026-09-17 18:22 exact pattern: at ESC time the dead auto turn is still
    // in the FIFO (the user turn holds the feature lease, every promote
    // attempt's started() is rejected and the turn re-queued), so
    // interruptActiveTurn is a no-op; the cancel barrier handoff then frees
    // the lease and promotes the dead turn onto it — no result line will ever
    // come. The cancel latch must settle each promoted turn after draining its
    // buffered content.
    await writeFile(file, '');
    let featureLeaseFree = false;
    const order: string[] = [];
    const callbacks = {
      started: jest.fn((event: { turnId: string }) => { order.push(`start:${event.turnId}`); return featureLeaseFree; }),
      chunk: jest.fn(async (event: { turnId: string; chunk: { type: string } }) => { order.push(`chunk:${event.turnId}:${event.chunk.type}`); }),
      finished: jest.fn(async (event: { turnId: string }) => { order.push(`finish:${event.turnId}`); }),
      released: jest.fn((turnId: string) => { order.push(`release:${turnId}`); }),
      cancelled: jest.fn(),
      projectEmbeddedExternal: jest.fn(async () => {}),
      onHostTurnTerminalObserved: jest.fn(),
    };
    const observer = new ClaudeTranscriptTurnObserver(callbacks, () => true);
    try {
      await observer.start(file);
      observer.beginUserTurnProjection('host');
      const generation = (observer as any).generation;
      await (observer as any).consumeBatch(
        { lines: notificationTurn('notif-dead', 'bg task done'), reset: false },
        generation,
      );
      // Promote was attempted and rejected (host user turn holds the feature
      // lease): turn re-queued, nothing projected yet.
      expect(callbacks.started).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'notif-dead' }));
      expect(callbacks.chunk).not.toHaveBeenCalled();

      // ESC: no active turn in the observer yet — the latch is armed silently.
      observer.interruptActiveTurn('user_cancel');
      expect(callbacks.cancelled).not.toHaveBeenCalled();

      // Cancel barrier handoff: the host user turn projection completes, the
      // feature lease frees, the queued dead turn promotes.
      featureLeaseFree = true;
      await observer.completeUserTurnProjection('host');

      // Deterministic settle: buffered content drained (kept), then exactly
      // one cancelled+released pair for the promoted turn.
      expect(order).toContain('chunk:notif-dead:text');
      expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
      expect(callbacks.cancelled).toHaveBeenCalledWith({
        turnId: 'notif-dead',
        generation: generation + 1,
        reason: 'user_cancel',
        interrupted: true,
      });
      expect(callbacks.released).toHaveBeenCalledTimes(1);
      expect(callbacks.released).toHaveBeenCalledWith('notif-dead');
      // Queue drained, no residual active turn: the lease is free for the
      // next turn.
      expect((observer as any).queue).toHaveLength(0);
      expect((observer as any).active).toBeNull();
    } finally {
      observer.stop();
    }
  });

  it('deterministically settles the active turn on user cancel, exactly once, and drops its late result (2.5.1 F3)', async () => {
    // 2026-09-17 18:22 ghost-lease pattern: the CLI turn is interrupted but the
    // auto turn's trailing result never settles the promoted turn — cancel must
    // settle it here instead, and a late transcript result must not re-settle.
    await writeFile(file, '');
    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      const generation = (observer as any).generation;
      await (observer as any).consumeBatch({ lines: peerTurn('peer-live', 'hello', false), reset: false }, generation);
      expect(callbacks.started).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-live' }));

      observer.interruptActiveTurn('user_cancel');

      // started.generation + 1: the generation the feature TurnCoordinator's
      // cancelAutoTurn accepts for this lease.
      expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
      expect(callbacks.cancelled).toHaveBeenCalledWith({
        turnId: 'peer-live',
        generation: generation + 1,
        reason: 'user_cancel',
        interrupted: true,
      });
      expect(callbacks.released).toHaveBeenCalledTimes(1);
      expect(callbacks.released).toHaveBeenCalledWith('peer-live');

      // The interrupted CLI may still flush a trailing result line for the turn:
      // no pending record owns it anymore, so it must not finish or re-cancel.
      await (observer as any).consumeBatch(
        { lines: [JSON.stringify({ type: 'result', subtype: 'success' })], reset: false },
        generation,
      );
      expect(callbacks.finished).not.toHaveBeenCalled();
      expect(callbacks.cancelled).toHaveBeenCalledTimes(1);
      expect(callbacks.released).toHaveBeenCalledTimes(1);
    } finally {
      observer.stop();
    }
  });

  it('drops the whole FIFO on transcript reset and never promotes the stale turns', async () => {
    await writeFile(file, `${peerTurn('peer-old', 'old', false).join('\n')}\n`);
    const { observer, callbacks, order } = setup();
    try {
      await observer.start(file);
      expect(callbacks.started).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'peer-old', replay: true }),
      );

      // The file is replaced with a fresh session holding a different open turn.
      await writeFile(file, `${peerTurn('peer-new', 'new', false).join('\n')}\n`);
      const generation = (observer as any).generation;
      await (observer as any).consumeBatch({ lines: [], reset: true }, generation);

      // Old turn: terminated as interrupted (no end marker will ever follow),
      // not finished; queue was dropped, only the new file's turn is projected.
      expect(callbacks.finished).not.toHaveBeenCalled();
      expect(callbacks.cancelled).toHaveBeenCalledWith({
        turnId: 'peer-old',
        generation: 3,
        reason: 'transcript_replaced',
        interrupted: true,
      });
      expect(callbacks.started).toHaveBeenCalledTimes(2);
      expect(callbacks.started).toHaveBeenLastCalledWith(
        expect.objectContaining({ turnId: 'peer-new', replay: true }),
      );
      expect(order).toEqual([
        'start:peer-old',
        'chunk:peer-old:text',
        'start:peer-new',
        'chunk:peer-new:text',
      ]);
    } finally {
      observer.stop();
    }
  });

  it('recovers a mid-write tail user line: the writer finishes it and the turn still starts (F2)', async () => {
    // The writer flushed only the first half of the boundary user line —
    // no trailing newline yet. Recovery must prime at the last complete
    // newline so those bytes survive as the reader's partial buffer;
    // priming at the observed EOF would orphan them forever.
    const lines = peerTurn('peer-half', 'half-written', false);
    const userLine = lines[0];
    const splitAt = Math.floor(userLine.length / 2);
    await writeFile(file, userLine.slice(0, splitAt));
    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      expect(callbacks.started).not.toHaveBeenCalled();

      await appendFile(file, `${userLine.slice(splitAt)}\n`);
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      const batch = await reader.readAvailable();
      expect(batch.lines).toEqual([userLine]);
      await (observer as any).consumeBatch(batch, (observer as any).generation);

      expect(callbacks.started).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'peer-half' }),
      );
    } finally {
      observer.stop();
    }
  });

  it('recovers a mid-write tail assistant line so its chunk is not lost (F2)', async () => {
    const lines = peerTurn('peer-tail', 'tail', false);
    const assistantLine = lines[1];
    const splitAt = Math.floor(assistantLine.length / 2);
    await writeFile(file, `${lines[0]}\n${assistantLine.slice(0, splitAt)}`);
    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      // The complete user line replays as the open turn's start.
      expect(callbacks.started).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'peer-tail', replay: true }),
      );
      expect(callbacks.chunk).not.toHaveBeenCalled();

      await appendFile(file, `${assistantLine.slice(splitAt)}\n`);
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      const batch = await reader.readAvailable();
      expect(batch.lines).toEqual([assistantLine]);
      await (observer as any).consumeBatch(batch, (observer as any).generation);

      expect(callbacks.chunk).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'peer-tail' }),
      );
    } finally {
      observer.stop();
    }
  });

  it('recovers a mid-write tail result line so the replayed turn finishes and releases (F2)', async () => {
    // Open turn with a half-written terminal result row: recovery replays
    // the turn (started + chunks), and the finished row must still land once
    // the writer completes it — losing it would hang the feature auto lease.
    const lines = peerTurn('peer-result', 'result-tail', false);
    const resultLine = JSON.stringify({
      type: 'result', subtype: 'success', isSidechain: false,
      total_cost_usd: 0.01, duration_ms: 100, turn_uuid: 'peer-result',
    });
    const splitAt = Math.floor(resultLine.length / 2);
    await writeFile(file, `${lines.slice(0, 2).join('\n')}\n${resultLine.slice(0, splitAt)}`);
    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      expect(callbacks.started).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'peer-result', replay: true }),
      );
      expect(callbacks.finished).not.toHaveBeenCalled();

      await appendFile(file, `${resultLine.slice(splitAt)}\n`);
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      const batch = await reader.readAvailable();
      expect(batch.lines).toEqual([resultLine]);
      await (observer as any).consumeBatch(batch, (observer as any).generation);

      expect(callbacks.finished).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'peer-result' }),
      );
      expect(callbacks.released).toHaveBeenCalledWith('peer-result');
    } finally {
      observer.stop();
    }
  });

  it('does not skip lines appended between the recovery scan and prime (recovery→prime race)', async () => {
    // Completed history: recovery observes the EOF but replays nothing.
    await writeFile(file, `${peerTurn('peer-done', 'hello').join('\n')}\n`);
    const sizeBefore = (await stat(file)).size;
    const lateLine = JSON.stringify({
      type: 'user',
      uuid: 'peer-late',
      origin: { kind: 'peer', body: 'late arrival' },
      message: { role: 'user', content: 'late arrival' },
    });
    const originalPrime = ClaudeTranscriptTailReader.prototype.prime;
    const primeSpy = jest.spyOn(ClaudeTranscriptTailReader.prototype, 'prime')
      .mockImplementation(async function (this: ClaudeTranscriptTailReader, offset?: number) {
        // Append right before prime re-stats: the old double-stat behaviour
        // would treat these bytes as pre-existing and silently skip them.
        await appendFile(file, `${lateLine}\n`);
        return originalPrime.call(this, offset);
      });

    const { observer, callbacks } = setup();
    try {
      await observer.start(file);
      expect(primeSpy.mock.calls[0][0]).toBe(sizeBefore);

      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      const batch = await reader.readAvailable();
      expect(batch.reset).toBe(false);
      expect(batch.lines).toEqual([lateLine]);
    } finally {
      primeSpy.mockRestore();
      observer.stop();
    }
    expect(callbacks.started).not.toHaveBeenCalled();
  });

  it('primes at the index committed boundary across service and observer layers (F2 contract)', async () => {
    // Locks the cross-layer contract behind fromOffset: the index reports a
    // committed boundary pinned to the last complete newline, the service
    // hands that exact boundary out as the page snapshotOffset, and an
    // observer primed there consumes the completed half line plus the next
    // line exactly once without re-reading committed rows. If a future
    // producer ever feeds a non-boundary offset, this contract — not an
    // unconditional recover inside the observer — is the seam that must hold.
    const done = `${peerTurn('peer-done', 'old').join('\n')}\n`;
    const openUserRow = JSON.stringify({ type: 'user', uuid: 'peer-open', origin: { kind: 'peer', body: 'hi' }, message: { role: 'user', content: 'hi' } });
    const openResultRow = JSON.stringify({ type: 'result', subtype: 'success', isSidechain: false, total_cost_usd: 0.01, duration_ms: 100, turn_uuid: 'peer-open' });
    await writeFile(file, `${done}${openUserRow.slice(0, 40)}`);

    // Layer 1 (index): partial snapshot, committedSize sits one byte past a
    // real newline and before the half line.
    const indexResult = await buildTranscriptIndex(file, { useWorker: false });
    expect(indexResult.status).toBe('partial');
    if (indexResult.status !== 'partial') return;
    const committed = indexResult.index.committedSize;
    expect(committed).toBe(Buffer.byteLength(done));
    const raw = await readFile(file);
    expect(raw[committed - 1]).toBe(0x0a);
    expect(committed).toBeLessThan(raw.length);

    // Layer 2 (service): the page handoff offset equals the committed
    // boundary, and the tail-start descriptor carries the snapshot's source
    // identity for it — what Tab.ts forwards to the runtime's
    // setTranscriptObserverTailStart.
    const sessionPathSpy = jest.spyOn(sdkSessionPaths, 'getSDKSessionPath').mockReturnValue(file);
    const existsSpy = jest.spyOn(sdkSessionPaths, 'sdkSessionExists').mockReturnValue(true);
    const conversation: Conversation = {
      id: 'f2-contract', providerId: 'claude', title: 'F2', createdAt: 1, updatedAt: 1,
      sessionId: 'f2-contract', providerState: { providerSessionId: 'f2-contract' }, messages: [],
    };
    const service = new ClaudeConversationHistoryService();
    const lease = service.acquireHistoryIndex(conversation, dir);
    await lease.ready;
    const page = await lease.loadWindow({
      anchorTurn: 1, direction: 'older',
      budget: { maxTurns: 25, maxSourceBytes: 8 * 1024 * 1024, maxProjectedChars: 2_000_000, timeSliceMs: 8 },
      projectionLevel: 'detail',
    });
    expect(page.snapshotOffset).toBe(committed);
    expect(page.tailStart).toEqual({
      provider: 'claude',
      protocol: 1,
      payload: {
        path: file,
        dev: indexResult.index.dev,
        ino: indexResult.index.ino,
        snapshotSize: indexResult.index.snapshotSize,
        committedOffset: committed,
      },
    });
    lease.release();
    sessionPathSpy.mockRestore();
    existsSpy.mockRestore();

    // Layer 3 (observer): primed at that boundary, the completed half line
    // and the line after it are each consumed once; nothing replays.
    const { observer, callbacks } = setup();
    try {
      await observer.start(file, page.tailStart);
      await appendFile(file, `${openUserRow.slice(40)}\n${openResultRow}\n`);
      const reader = (observer as any).reader as ClaudeTranscriptTailReader;
      const batch = await reader.readAvailable();
      expect(batch.lines).toEqual([openUserRow, openResultRow]);
      await (observer as any).consumeBatch(batch, (observer as any).generation);

      expect(callbacks.started).toHaveBeenCalledTimes(1);
      expect(callbacks.started).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-open' }));
      expect(callbacks.finished).toHaveBeenCalledTimes(1);
      expect(callbacks.finished).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-open' }));
    } finally {
      observer.stop();
    }
  });

  describe('host user turn terminal notification (P0-1 result-late watchdog)', () => {
    function hostUserRow(uuid: string): string {
      return JSON.stringify({ type: 'user', uuid, isSidechain: false, message: { role: 'user', content: 'hello' } });
    }

    function hostEndTurn(): string {
      return JSON.stringify({ type: 'assistant', uuid: 'host-a1', message: { id: 'host-m1', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
    }

    function stopHookSummary(): string {
      return JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' });
    }

    function hostTerminalLines(): string[] {
      return [hostEndTurn(), stopHookSummary()];
    }

    it('notifies the runtime with the live hostUserTurnId at tick time', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('host-watch');
      observer.registerHostUserTranscriptId('host-watch-row');
      const generation = (observer as any).generation;

      await (observer as any).consumeBatch(
        { lines: [hostUserRow('host-watch-row'), ...hostTerminalLines()], lineOffsets: [0, 100, 200], reset: false },
        generation,
      );

      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledTimes(1);
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledWith('host-watch');
      observer.stop();
    });

    it('does not notify after the host turn projection completed (hostUserTurnId cleared)', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('host-done');
      observer.registerHostUserTranscriptId('host-done-row');
      await observer.completeUserTurnProjection('host-done');
      const generation = (observer as any).generation;

      await (observer as any).consumeBatch(
        { lines: [hostUserRow('host-done-row'), ...hostTerminalLines()], lineOffsets: [0, 100, 200], reset: false },
        generation,
      );

      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
      observer.stop();
    });

    it('does not notify for stop-hook block continuations until the turn really ends', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('host-block');
      observer.registerHostUserTranscriptId('host-block-row');
      const generation = (observer as any).generation;

      const blocked = [
        hostUserRow('host-block-row'),
        JSON.stringify({ type: 'assistant', uuid: 'host-b1', message: { id: 'host-bm1', role: 'assistant', content: [{ type: 'text', text: 'first' }], stop_reason: 'end_turn' } }),
        JSON.stringify({ type: 'user', isMeta: true, userType: 'external', message: { role: 'user', content: 'Stop hook feedback: Background subagent still running' } }),
        JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' }),
      ];
      await (observer as any).consumeBatch({ lines: blocked, lineOffsets: [0, 100, 200, 300], reset: false }, generation);
      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();

      await (observer as any).consumeBatch({ lines: hostTerminalLines(), lineOffsets: [400, 500], reset: false }, generation);
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledTimes(1);
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledWith('host-block');
      observer.stop();
    });

    it('quiet-settles a host terminal candidate that never saw stop_hook_summary', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('host-quiet');
      observer.registerHostUserTranscriptId('host-quiet-row');
      const generation = (observer as any).generation;

      await (observer as any).consumeBatch(
        { lines: [hostUserRow('host-quiet-row'), hostEndTurn()], lineOffsets: [0, 100], reset: false },
        generation,
      );
      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
      expect((observer as any).quietTimer).not.toBeNull();

      await (observer as any).settleQuietCandidate(generation);
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledTimes(1);
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledWith('host-quiet');
      observer.stop();
    });

    it('recovery replay of past terminal rows never notifies the host callback', async () => {
      // beginUserTurnProjection happens before the observer start in this
      // shape (host turn live while recovery scans prior transcript rows);
      // replay facts must stay out of the live host notification channel.
      await writeFile(file, `${hostTerminalLines().join('\n')}\n`);
      const { observer, callbacks } = setup();
      observer.beginUserTurnProjection('host-replay');
      await observer.start(file);

      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
      observer.stop();
    });

    it('isolates a throwing host callback from the consume chain', async () => {
      await writeFile(file, '');
      const order: string[] = [];
      const observer = new ClaudeTranscriptTurnObserver({
        started: () => true,
        chunk: async () => {},
        finished: async () => {},
        released: () => {},
        cancelled: () => {},
        projectEmbeddedExternal: async () => {},
        onHostTurnTerminalObserved: () => { order.push('throw'); throw new Error('host callback failure'); },
      }, () => true);
      await observer.start(file);
      observer.beginUserTurnProjection('host-throw');
      observer.registerHostUserTranscriptId('host-throw-row');
      const generation = (observer as any).generation;

      await expect((observer as any).consumeBatch(
        { lines: [hostUserRow('host-throw-row'), ...hostTerminalLines()], lineOffsets: [0, 100, 200], reset: false },
        generation,
      )).resolves.toBeUndefined();
      expect(order).toEqual(['throw']);
      observer.stop();
    });

    describe('cross-turn residue attribution (reviewer #1: terminal rows flushing after the hostUserTurnId switched)', () => {
      it('the previous turn\'s stop_hook_summary never stamps the freshly dispatched turn', async () => {
        await writeFile(file, '');
        const { observer, callbacks } = setup();
        await observer.start(file);
        observer.registerHostUserTranscriptId('n1-row');
        observer.beginUserTurnProjection('turn-n1');
        observer.registerHostUserTranscriptId('n2-row');
        const generation = (observer as any).generation;

        // Turn n1: its user row lands, its end_turn lands — then the result
        // settles, the queue pumps and the next dispatch switches the
        // hostUserTurnId before the stop_hook_summary row is consumed.
        await (observer as any).consumeBatch(
          { lines: [hostUserRow('n1-row'), hostEndTurn()], lineOffsets: [0, 100], reset: false },
          generation,
        );
        expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();

        observer.beginUserTurnProjection('turn-n2');

        // The residue flushes in the same batch as the new turn's user row:
        // physically [stop_hook_summary n1][user row n2].
        await (observer as any).consumeBatch(
          { lines: [stopHookSummary(), hostUserRow('n2-row')], lineOffsets: [200, 300], reset: false },
          generation,
        );
        expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();

        // The new turn's own terminal still notifies normally.
        await (observer as any).consumeBatch({ lines: hostTerminalLines(), lineOffsets: [400, 500], reset: false }, generation);
        expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledTimes(1);
        expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledWith('turn-n2');
        observer.stop();
      });

      it('a whole stale batch ([end_turn n1][stop_hook_summary n1][user row n2]) after the switch stamps nothing', async () => {
        await writeFile(file, '');
        const { observer, callbacks } = setup();
        await observer.start(file);
        observer.registerHostUserTranscriptId('stale-n1-row');
        observer.beginUserTurnProjection('turn-stale-n1');
        observer.registerHostUserTranscriptId('stale-n2-row');
        const generation = (observer as any).generation;

        await (observer as any).consumeBatch({ lines: [hostUserRow('stale-n1-row')], lineOffsets: [0], reset: false }, generation);
        observer.beginUserTurnProjection('turn-stale-n2');

        await (observer as any).consumeBatch(
          { lines: [hostEndTurn(), stopHookSummary(), hostUserRow('stale-n2-row')], lineOffsets: [100, 200, 300], reset: false },
          generation,
        );
        expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
        observer.stop();
      });

      it('a quiet-settled residue re-armed after the switch never notifies (row not yet observed)', async () => {
        await writeFile(file, '');
        const { observer, callbacks } = setup();
        await observer.start(file);
        observer.registerHostUserTranscriptId('quiet-n1-row');
        observer.beginUserTurnProjection('turn-quiet-n1');
        observer.registerHostUserTranscriptId('quiet-n2-row');
        const generation = (observer as any).generation;

        await (observer as any).consumeBatch({ lines: [hostUserRow('quiet-n1-row')], lineOffsets: [0], reset: false }, generation);
        observer.beginUserTurnProjection('turn-quiet-n2');
        // The stale end_turn is consumed AFTER the switch (tail lag), re-arming
        // a candidate; the new turn's user row has not landed yet.
        await (observer as any).consumeBatch({ lines: [hostEndTurn()], lineOffsets: [100], reset: false }, generation);
        expect((observer as any).quietTimer).not.toBeNull();

        await (observer as any).settleQuietCandidate(generation);
        expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
        observer.stop();
      });

      it('the offset guard is the second line of defense for terminal facts preceding the live row', async () => {
        await writeFile(file, '');
        const { observer, callbacks } = setup();
        await observer.start(file);
        observer.beginUserTurnProjection('turn-guard');
        observer.registerHostUserTranscriptId('guard-n2-row');
        const generation = (observer as any).generation;

        // Mechanism-level shape (offsets deliberately non-monotonic): the
        // live turn's row is observed first, then a terminal row that
        // physically precedes it produces a fact — the offset guard must
        // drop it even though the row anchor is satisfied.
        await (observer as any).consumeBatch({ lines: [hostUserRow('guard-n2-row')], lineOffsets: [300], reset: false }, generation);
        await (observer as any).consumeBatch({ lines: [hostEndTurn()], lineOffsets: [100], reset: false }, generation);
        await (observer as any).consumeBatch({ lines: [stopHookSummary()], lineOffsets: [200], reset: false }, generation);

        expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
        observer.stop();
      });

      it('beginUserTurnProjection retires an unconfirmed candidate outright', async () => {
        await writeFile(file, '');
        const { observer, callbacks } = setup();
        await observer.start(file);
        observer.registerHostUserTranscriptId('retire-n1-row');
        observer.beginUserTurnProjection('turn-retire-n1');
        observer.registerHostUserTranscriptId('retire-n2-row');
        const generation = (observer as any).generation;

        await (observer as any).consumeBatch(
          { lines: [hostUserRow('retire-n1-row'), hostEndTurn()], lineOffsets: [0, 100], reset: false },
          generation,
        );
        observer.beginUserTurnProjection('turn-retire-n2');

        // Quiet settle finds no candidate: the switch retired it.
        await (observer as any).settleQuietCandidate(generation);
        expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
        observer.stop();
      });
    });
  });

  describe('compact boundary attribution (2026-11-04 d8912b5b: boundary flushes before the host /compact row)', () => {
    function hostUserRow(uuid: string): string {
      return JSON.stringify({ type: 'user', uuid, isSidechain: false, message: { role: 'user', content: 'hello' } });
    }

    function compactBoundaryLine(timestamp: string, lineOffset = 100): { line: string; lineOffset: number } {
      return {
        line: JSON.stringify({
          type: 'system', subtype: 'compact_boundary', timestamp,
          compactMetadata: { trigger: 'manual', durationMs: 137011 }, version: '2.1.227',
        }),
        lineOffset,
      };
    }

    /** The #1 measured row order: boundary → continuation → caveat → the
     * buffered /compact host row → stdout. The host row has NOT landed when
     * the boundary is consumed. */
    function compactTurnTail(boundaryTimestamp: string): { lines: string[]; lineOffsets: number[] } {
      const rows = [
        compactBoundaryLine(boundaryTimestamp, 100).line,
        JSON.stringify({ type: 'user', uuid: 'compact-continuation', isSidechain: false, shouldQuery: false, message: { role: 'user', content: 'Conversation compacted' } }),
        JSON.stringify({ type: 'user', uuid: 'compact-caveat', isSidechain: false, isMeta: true, userType: 'external', message: { role: 'user', content: 'caveat' } }),
        JSON.stringify({ type: 'user', uuid: 'compact-cmd-row', isSidechain: false, message: { role: 'user', content: '/compact' } }),
        JSON.stringify({ type: 'user', uuid: 'compact-stdout', isSidechain: false, isMeta: true, message: { role: 'user', content: 'Compacted Tip: You have access to Opus 1M.' } }),
      ];
      return { lines: rows, lineOffsets: rows.map((_, index) => 100 + index * 50) };
    }

    it('timestamps attribute the boundary to the live host turn whose own row has not landed yet (row order inverted)', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('turn-compact');
      observer.registerHostUserTranscriptId('compact-cmd-row');
      const generation = (observer as any).generation;

      // REAL dispatch anchor (fix 3): the channel stamped delivery; the
      // boundary row carries a creation timestamp strictly after it
      // (compaction ran for 2m17s after dispatch).
      const dispatchedAt = Date.now();
      observer.observeDispatch({ leaseTurnId: 'turn-compact', canonicalUuid: 'compact-cmd-row', hostTurnIds: ['turn-compact'], dispatchedAt, isManualCompact: true });
      const tail = compactTurnTail(new Date(dispatchedAt + 137_000).toISOString());
      await (observer as any).consumeBatch({ ...tail, reset: false }, generation);

      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledTimes(1);
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledWith('turn-compact', { kind: 'compact', cliVersion: '2.1.227' });
      observer.stop();
    });

    it('T-cross-1: the previous turn\'s boundary residue (rowTimestamp ≤ dispatchedAt) never stamps the new turn', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.registerHostUserTranscriptId('cross1-n2-row');
      const dispatchedAt = Date.now();
      observer.beginUserTurnProjection('turn-cross1-n2');
      const generation = (observer as any).generation;

      // Turn N-1's boundary was written before turn N was dispatched, but is
      // batch-consumed only now (tail lag). Its row timestamp predates the
      // dispatch: attribution must drop it.
      const residue = compactBoundaryLine(new Date(dispatchedAt - 60_000).toISOString());
      await (observer as any).consumeBatch(
        { lines: [residue.line, hostUserRow('cross1-n2-row')], lineOffsets: [residue.lineOffset, 300], reset: false },
        generation,
      );
      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
      observer.stop();
    });

    it('T-cross-2: double compact dispatch — the stale boundary drops while the live boundary stamps once', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('turn-cross2-n2');
      observer.registerHostUserTranscriptId('cross2-n2-row');
      const dispatchedN2 = Date.now();
      observer.observeDispatch({ leaseTurnId: 'turn-cross2-n2', canonicalUuid: 'cross2-n2-row', hostTurnIds: ['turn-cross2-n2'], dispatchedAt: dispatchedN2, isManualCompact: true });
      const generation = (observer as any).generation;

      const stale = compactBoundaryLine(new Date(dispatchedN2 - 60_000).toISOString(), 100);
      const live = compactBoundaryLine(new Date(dispatchedN2 + 30_000).toISOString(), 150);
      await (observer as any).consumeBatch(
        { lines: [stale.line, live.line, hostUserRow('cross2-n2-row')], lineOffsets: [stale.lineOffset, live.lineOffset, 300], reset: false },
        generation,
      );
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledTimes(1);
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledWith('turn-cross2-n2', { kind: 'compact', cliVersion: '2.1.227' });
      observer.stop();
    });

    it('recovery replay of a boundary row never notifies the host callback (double insurance with the mapper guard)', async () => {
      const dispatchedAt = Date.now();
      await writeFile(file, `${compactBoundaryLine(new Date(dispatchedAt + 10_000).toISOString()).line}\n`);
      const { observer, callbacks } = setup();
      observer.beginUserTurnProjection('turn-compact-replay');
      await observer.start(file);

      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
      observer.stop();
    });

    it('defect 3: a feature-begin stamp never substitutes the real dispatch — boundary predating dispatch never stamps', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('turn-anchor');
      observer.registerHostUserTranscriptId('anchor-row');
      const generation = (observer as any).generation;

      // begin at T0; the boundary lands at T+10s; the REAL dispatch happens
      // at T+30s (feature begin awaited a projection lease before the
      // message reached the CLI). The boundary predates the dispatch: it is
      // residue of the previous turn, never this turn's terminal.
      const beginAt = Date.now();
      const boundaryAt = new Date(beginAt + 10_000).toISOString();
      const dispatchAt = new Date(beginAt + 30_000).getTime();
      observer.observeDispatch({ leaseTurnId: 'turn-anchor', canonicalUuid: 'anchor-row', hostTurnIds: ['turn-anchor'], dispatchedAt: dispatchAt, isManualCompact: true });

      await (observer as any).consumeBatch(
        { lines: [compactBoundaryLine(boundaryAt, 100).line], lineOffsets: [100], reset: false },
        generation,
      );
      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
      observer.stop();
    });

    it('defect 3: a boundary postdating the real dispatch stamps immediately, before the buffered host row lands', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('turn-late-dispatch');
      observer.registerHostUserTranscriptId('late-dispatch-row');
      const generation = (observer as any).generation;

      const beginAt = Date.now();
      const dispatchAt = beginAt + 30_000;
      observer.observeDispatch({ leaseTurnId: 'turn-late-dispatch', canonicalUuid: 'late-dispatch-row', hostTurnIds: ['turn-late-dispatch'], dispatchedAt: dispatchAt, isManualCompact: true });

      // The boundary flushes at dispatch+130s; the host's own /compact row is
      // still buffered behind it. The stamp must not wait for the host row.
      const tail = compactTurnTail(new Date(dispatchAt + 130_000).toISOString());
      const linesWithoutHostRow = [tail.lines[0], tail.lines[1], tail.lines[2]];
      await (observer as any).consumeBatch(
        { lines: linesWithoutHostRow, lineOffsets: [100, 150, 200], reset: false },
        generation,
      );
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledTimes(1);
      expect(callbacks.onHostTurnTerminalObserved).toHaveBeenCalledWith('turn-late-dispatch', { kind: 'compact', cliVersion: '2.1.227' });
      observer.stop();
    });

    it('a manual boundary on a NON-compact dispatch never stamps (final payload decides, not the row)', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('turn-plain-input');
      observer.registerHostUserTranscriptId('plain-row');
      const generation = (observer as any).generation;

      const dispatchAt = Date.now();
      // A plain user turn whose dispatch happens to see the previous turn's
      // manual compact boundary flush late: isManualCompact=false drops it.
      observer.observeDispatch({ leaseTurnId: 'turn-plain-input', canonicalUuid: 'plain-row', hostTurnIds: ['turn-plain-input'], dispatchedAt: dispatchAt, isManualCompact: false });

      const boundary = compactBoundaryLine(new Date(dispatchAt + 60_000).toISOString());
      await (observer as any).consumeBatch(
        { lines: [boundary.line, hostUserRow('plain-row')], lineOffsets: [boundary.lineOffset, 300], reset: false },
        generation,
      );
      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
      observer.stop();
    });

    it('a boundary without a parseable timestamp never notifies (fail-safe)', async () => {
      await writeFile(file, '');
      const { observer, callbacks } = setup();
      await observer.start(file);
      observer.beginUserTurnProjection('turn-compact-nan');
      const generation = (observer as any).generation;

      const bad = compactBoundaryLine('not-a-timestamp');
      await (observer as any).consumeBatch({ lines: [bad.line], lineOffsets: [bad.lineOffset], reset: false }, generation);
      expect(callbacks.onHostTurnTerminalObserved).not.toHaveBeenCalled();
      observer.stop();
    });
  });

  describe('host terminal retraction notification (2026-11-05 fix 1)', () => {
    function hostUserRow(uuid: string): string {
      return JSON.stringify({ type: 'user', uuid, isSidechain: false, message: { role: 'user', content: 'hello' } });
    }

    function hostEndTurn(assistantId: string): string {
      return JSON.stringify({ type: 'assistant', uuid: `a-${assistantId}`, message: { id: assistantId, role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
    }

    function stopHookSummary(): string {
      return JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' });
    }

    function blockFeedback(): string {
      return JSON.stringify({ type: 'user', isMeta: true, userType: 'external', message: { role: 'user', content: 'Stop hook feedback: Background subagent still running' } });
    }

    it('notifies the runtime with the live hostUserTurnId when strong continuation proof retracts the terminal', async () => {
      await writeFile(file, '');
      const retracted = jest.fn();
      const observer = new ClaudeTranscriptTurnObserver({
        started: () => true,
        chunk: async () => {},
        finished: async () => {},
        released: () => {},
        cancelled: () => {},
        projectEmbeddedExternal: async () => {},
        onHostTurnTerminalObserved: () => {},
        onHostTurnTerminalRetracted: retracted,
      }, () => true);
      await observer.start(file);
      observer.beginUserTurnProjection('turn-retract');
      observer.registerHostUserTranscriptId('retract-row');
      const generation = (observer as any).generation;

      await (observer as any).consumeBatch(
        { lines: [hostUserRow('retract-row'), hostEndTurn('m-retract'), stopHookSummary()], lineOffsets: [0, 100, 200], reset: false },
        generation,
      );

      await (observer as any).consumeBatch({ lines: [blockFeedback()], lineOffsets: [300], reset: false }, generation);
      expect(retracted).toHaveBeenCalledTimes(1);
      expect(retracted).toHaveBeenCalledWith('turn-retract', 'stop_hook_block');
      observer.stop();
    });

    it('a retraction for the same assistant instance never notifies, replay retraction never notifies', async () => {
      await writeFile(file, '');
      const retracted = jest.fn();
      const observer = new ClaudeTranscriptTurnObserver({
        started: () => true,
        chunk: async () => {},
        finished: async () => {},
        released: () => {},
        cancelled: () => {},
        projectEmbeddedExternal: async () => {},
        onHostTurnTerminalObserved: () => {},
        onHostTurnTerminalRetracted: retracted,
      }, () => true);
      await observer.start(file);
      observer.beginUserTurnProjection('turn-retract-same');
      observer.registerHostUserTranscriptId('retract-same-row');
      const generation = (observer as any).generation;

      await (observer as any).consumeBatch(
        { lines: [hostUserRow('retract-same-row'), hostEndTurn('m-same'), stopHookSummary()], lineOffsets: [0, 100, 200], reset: false },
        generation,
      );
      // Same assistant instance: not continuation proof.
      await (observer as any).consumeBatch(
        { lines: [JSON.stringify({ type: 'assistant', uuid: 'a-same-tail', message: { id: 'm-same', role: 'assistant', content: [{ type: 'text', text: 'tail' }] } })], lineOffsets: [300], reset: false },
        generation,
      );
      expect(retracted).not.toHaveBeenCalled();
      observer.stop();
    });
  });
});

describe('ClaudeTranscriptTurnObserver — reconciliation bypass (batch 1)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claudian-observer-recon-'));
    file = join(dir, 'session.jsonl');
    await writeFile(file, '');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setupWithReconciliation(canAcquire = () => true) {
    const order: string[] = [];
    const callbacks = {
      started: jest.fn(event => { order.push(`start:${event.turnId}`); return canAcquire(); }),
      chunk: jest.fn(async event => { order.push(`chunk:${event.turnId}:${event.chunk.type}`); }),
      finished: jest.fn(async event => { order.push(`finish:${event.turnId}`); }),
      released: jest.fn(turnId => { order.push(`release:${turnId}`); }),
      cancelled: jest.fn(),
      projectEmbeddedExternal: jest.fn(async event => { order.push(`embedded:${event.turnId}`); }),
      onHostTurnTerminalObserved: jest.fn(turnId => { order.push(`host-terminal:${turnId}`); }),
    };
    const observedStarts: Array<{ canonicalTurnId: string; lineOffset?: number; sourceKind?: string }> = [];
    const reconciliation = {
      recordObservedStart: jest.fn((fact: { canonicalTurnId: string; lineOffset?: number; sourceKind?: string }) => {
        observedStarts.push(fact);
      }),
    };
    const observer = new ClaudeTranscriptTurnObserver(callbacks, canAcquire, undefined, reconciliation);
    return { observer, callbacks, order, observedStarts, reconciliation };
  }

  it('forwards host-row and external observed_start facts to the reconciliation sink', async () => {
    const { observer, observedStarts } = setupWithReconciliation();
    await observer.start(file);
    const generation = (observer as any).generation;
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'host-uuid-a', message: { role: 'user', content: 'host prompt' } }),
      JSON.stringify({ type: 'user', uuid: 'peer-uuid-a', origin: { kind: 'peer', body: 'hi' }, message: { role: 'user', content: 'hi' } }),
    ];
    await (observer as any).consumeBatch({ lines, lineOffsets: [10, 60], reset: false }, generation);

    expect(observedStarts).toEqual([
      { canonicalTurnId: 'host-uuid-a', lineOffset: 10 },
      { canonicalTurnId: 'peer-uuid-a', lineOffset: 60, sourceKind: 'peer' },
    ]);
    observer.stop();
  });

  it('does not forward replay/recovery observed starts, and a throwing sink never breaks the consume chain', async () => {
    const callbacks = {
      started: jest.fn(() => true),
      chunk: jest.fn(async () => {}),
      finished: jest.fn(async () => {}),
      released: jest.fn(),
      cancelled: jest.fn(),
      projectEmbeddedExternal: jest.fn(async () => {}),
      onHostTurnTerminalObserved: jest.fn(),
    };
    const reconciliation = {
      recordObservedStart: jest.fn(() => { throw new Error('sink failure'); }),
    };
    const observer = new ClaudeTranscriptTurnObserver(callbacks, () => true, undefined, reconciliation);
    await observer.start(file);
    const generation = (observer as any).generation;
    const lines = peerTurn('peer-x', 'x').slice(0, -1);

    await expect((observer as any).consumeBatch({ lines, lineOffsets: [0, 100, 200], reset: false }, generation)).resolves.toBeUndefined();

    expect(reconciliation.recordObservedStart).toHaveBeenCalledTimes(1);
    expect(callbacks.started).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-x' }));
    observer.stop();
  });

  it('keeps legacy projection identical whether or not a sink is attached', async () => {
    const withSink = setupWithReconciliation();
    // No-sink baseline: the same callbacks shape, no reconciliation parameter.
    const plainOrder: string[] = [];
    const plainObserver = new ClaudeTranscriptTurnObserver({
      started: event => { plainOrder.push(`start:${event.turnId}`); return true; },
      chunk: async event => { plainOrder.push(`chunk:${event.turnId}:${event.chunk.type}`); },
      finished: async event => { plainOrder.push(`finish:${event.turnId}`); },
      released: turnId => { plainOrder.push(`release:${turnId}`); },
      cancelled: () => {},
      projectEmbeddedExternal: async () => {},
      onHostTurnTerminalObserved: () => {},
    }, () => true);

    await withSink.observer.start(file);
    await plainObserver.start(file);
    const lines = peerTurn('peer-same', 'same');

    await (withSink.observer as any).consumeBatch({ lines, lineOffsets: [0, 10, 20, 30], reset: false }, (withSink.observer as any).generation);
    await (plainObserver as any).consumeBatch({ lines, lineOffsets: [0, 10, 20, 30], reset: false }, (plainObserver as any).generation);

    expect(withSink.order).toEqual(plainOrder);
    withSink.observer.stop();
    plainObserver.stop();
  });

});
