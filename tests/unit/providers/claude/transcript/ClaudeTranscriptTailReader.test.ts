import type * as FsPromisesModule from 'fs/promises';
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ClaudeTranscriptTailReader } from '@/providers/claude/transcript/ClaudeTranscriptTailReader';

const fsPromises = jest.requireActual<typeof FsPromisesModule>('fs/promises');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('ClaudeTranscriptTailReader', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claudian-transcript-'));
    file = join(dir, 'session.jsonl');
    await writeFile(file, '');
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves a just-read batch for the next generation when the watcher stops before delivery', async () => {
    await writeFile(file, 'line\n');
    const reader = new ClaudeTranscriptTailReader(file, undefined, 1);
    await reader.prime(0);
    const switched = deferred();
    const oldCallback = jest.fn();
    let nextRead!: ReturnType<typeof reader.readAvailable>;
    const open = fsPromises.open;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        queueMicrotask(() => queueMicrotask(() => {
          reader.stop();
          nextRead = reader.readAvailable();
          switched.resolve();
        }));
      };
      return handle;
    });
    try {
      reader.start(oldCallback);
      await switched.promise;
      const next = await nextRead;
      expect(oldCallback).not.toHaveBeenCalled();
      expect(next.lines).toEqual(['line']);
      expect(next.lineOffsets).toEqual([0]);
      expect(reader.getOffset()).toBe(5);
    } finally {
      openSpy.mockRestore();
      reader.stop();
    }
  });

  it('delivers a just-read batch to a restarted watcher instead of the stopped one', async () => {
    await writeFile(file, 'line\n');
    const reader = new ClaudeTranscriptTailReader(file, undefined, 1);
    await reader.prime(0);
    const delivered = deferred();
    const oldCallback = jest.fn();
    const newCallback = jest.fn(() => { delivered.resolve(); });
    let offsetAtSwitch = -1;
    const open = fsPromises.open;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        queueMicrotask(() => queueMicrotask(() => {
          reader.stop();
          offsetAtSwitch = reader.getOffset();
          reader.start(newCallback);
        }));
      };
      return handle;
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      reader.start(oldCallback);
      await Promise.race([
        delivered.promise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('restarted watcher did not deliver')), 2_000);
        }),
      ]);
      expect(oldCallback).not.toHaveBeenCalled();
      expect(offsetAtSwitch).toBe(0);
      expect(newCallback).toHaveBeenCalledTimes(1);
      expect(newCallback).toHaveBeenCalledWith(expect.objectContaining({ lines: ['line'], lineOffsets: [0] }));
      expect(reader.getOffset()).toBe(5);
    } finally {
      if (deadline) clearTimeout(deadline);
      openSpy.mockRestore();
      reader.stop();
    }
  });

  it('enters the watcher admission before committing its candidate cursor', async () => {
    await writeFile(file, 'line\n');
    const reader = new ClaudeTranscriptTailReader(file, undefined, 1);
    await reader.prime(0);
    const entered = deferred();
    const gate = deferred();
    let offsetAtAdmission = -1;
    try {
      reader.start(() => {
        offsetAtAdmission = reader.getOffset();
        entered.resolve();
        return gate.promise;
      });
      await entered.promise;
      expect(offsetAtAdmission).toBe(0);
      expect(reader.getOffset()).toBe(5);
    } finally {
      gate.resolve();
      reader.stop();
    }
  });

  it('preserves a synchronous accepted-consumer error without replaying the batch', async () => {
    await writeFile(file, 'line\n');
    const reported = deferred();
    const failure = new Error('synchronous accepted-consumer failure');
    const onError = jest.fn((_error: unknown) => { reported.resolve(); });
    const reader = new ClaudeTranscriptTailReader(file, undefined, 1, onError);
    await reader.prime(0);
    try {
      reader.start(() => { throw failure; });
      await reported.promise;
      reader.stop();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(failure);
      expect(onError.mock.calls[0][0]).toBe(failure);
      expect(reader.getOffset()).toBe(5);
      expect((await reader.readAvailable()).lines).toEqual([]);
    } finally {
      reader.stop();
    }
  });

  it('recognizes a same-length replacement opened after the path stat', async () => {
    await writeFile(file, 'old\n');
    const replacement = join(dir, 'replacement');
    await writeFile(replacement, 'new\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    const open = fsPromises.open;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
      await rename(replacement, file);
      return open(...args);
    });
    try {
      const batch = await reader.readAvailable();
      expect(batch.reset).toBe(true);
      expect(batch.lines).toEqual(['new']);
      expect(batch.lineOffsets).toEqual([0]);
    } finally {
      openSpy.mockRestore();
      reader.stop();
    }
  });

  it('keeps the real file handle and IO lane until the pending close finishes', async () => {
    await writeFile(file, 'line\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    const entered = deferred();
    const gate = deferred();
    const open = fsPromises.open;
    let firstHandle!: Awaited<ReturnType<typeof open>>;
    let opens = 0;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      opens += 1;
      if (opens === 1) {
        firstHandle = handle;
        const close = handle.close.bind(handle);
        handle.close = async () => { entered.resolve(); await gate.promise; await close(); };
      }
      return handle;
    });
    try {
      const old = reader.readAvailable();
      await entered.promise;
      expect((await firstHandle.stat()).size).toBe(5);
      reader.stop();
      let newFinished = false;
      const current = reader.readAvailable().then(batch => { newFinished = true; return batch; });
      await Promise.resolve();
      await Promise.resolve();
      expect(opens).toBe(1);
      expect(newFinished).toBe(false);
      gate.resolve();
      expect((await old).lines).toEqual([]);
      expect((await current).lines).toEqual(['line']);
      expect(opens).toBe(2);
    } finally {
      gate.resolve();
      openSpy.mockRestore();
      reader.stop();
    }
  });

  it('does not replay an accepted batch when its old consumer later rejects', async () => {
    await writeFile(file, 'old\n');
    const oldEntered = deferred();
    const newEntered = deferred();
    const errorEntered = deferred();
    let finishOld!: () => void;
    let rejectOld!: (error: unknown) => void;
    const oldCompletion = new Promise<void>((resolve, reject) => { finishOld = resolve; rejectOld = reject; });
    const onError = jest.fn((_error: unknown) => { errorEntered.resolve(); });
    const reader = new ClaudeTranscriptTailReader(file, undefined, 1, onError);
    await reader.prime(0);
    const oldCallback = jest.fn(() => { oldEntered.resolve(); return oldCompletion; });
    const newCallback = jest.fn(() => { newEntered.resolve(); });
    const failure = new Error('old accepted consumer failed');
    try {
      reader.start(oldCallback);
      await oldEntered.promise;
      expect(reader.getOffset()).toBe(4);
      reader.stop();
      await appendFile(file, 'new\n');
      reader.start(newCallback);
      await newEntered.promise;
      rejectOld(failure);
      await errorEntered.promise;
      expect(oldCallback).toHaveBeenCalledTimes(1);
      expect(newCallback).toHaveBeenCalledTimes(1);
      expect(newCallback).toHaveBeenCalledWith(expect.objectContaining({ lines: ['new'], lineOffsets: [4] }));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(failure);
      expect(onError.mock.calls[0][0]).toBe(failure);
      expect(reader.getOffset()).toBe(8);
    } finally {
      finishOld();
      reader.stop();
    }
  });

  it('caps the first poll read to the remaining eight-megabyte tick budget', async () => {
    const budget = 8 * 1024 * 1024;
    await writeFile(file, Buffer.concat([Buffer.alloc(budget - 1, 0x61), Buffer.from('\nz\n')]));
    const reader = new ClaudeTranscriptTailReader(file, 64 * 1024 * 1024, 1);
    await reader.prime(0);
    const delivered = deferred();
    let bytesRead = 0;
    try {
      reader.start(batch => {
        bytesRead = batch.bytesRead ?? 0;
        reader.stop();
        delivered.resolve();
      });
      await delivered.promise;
      expect(bytesRead).toBeLessThanOrEqual(budget);
      expect(reader.getOffset()).toBe(budget);
    } finally {
      reader.stop();
    }
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid maxReadBytes value %s',
    maxReadBytes => {
      expect(() => new ClaudeTranscriptTailReader(file, maxReadBytes)).toThrow(RangeError);
    },
  );

  it.each(['open', 'read', 'close'] as const)(
    'reports poll %s failures to the original error owner without consuming bytes',
    async stage => {
      await writeFile(file, 'line\n');
      const onError = jest.fn();
      const reader = new ClaudeTranscriptTailReader(file, undefined, 1, onError);
      await reader.prime(0);
      const attempted = deferred();
      const closed = deferred();
      const failure = new Error(`${stage} failure`);
      const open = fsPromises.open;
      const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
        if (stage === 'open') {
          attempted.resolve();
          closed.resolve();
          throw failure;
        }
        const handle = await open(...args);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          closed.resolve();
          if (stage === 'close') { attempted.resolve(); throw failure; }
        };
        if (stage === 'read') {
          handle.read = (async () => { attempted.resolve(); throw failure; }) as typeof handle.read;
        }
        return handle;
      });
      try {
        reader.start(jest.fn());
        await attempted.promise;
        await closed.promise;
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
        reader.stop();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(failure);
        expect(reader.getOffset()).toBe(0);
      } finally {
        openSpy.mockRestore();
        reader.stop();
      }
    },
  );

  it('retains both poll read and close failures for the same error owner', async () => {
    await writeFile(file, 'line\n');
    const onError = jest.fn();
    const reader = new ClaudeTranscriptTailReader(file, undefined, 1, onError);
    await reader.prime(0);
    const closed = deferred();
    const readFailure = new Error('read failure');
    const closeFailure = new Error('close failure');
    const open = fsPromises.open;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      handle.read = (async () => { throw readFailure; }) as typeof handle.read;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed.resolve(); throw closeFailure; };
      return handle;
    });
    try {
      reader.start(jest.fn());
      await closed.promise;
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      reader.stop();
      expect(onError).toHaveBeenCalledTimes(1);
      const failure = onError.mock.calls[0][0] as AggregateError;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toEqual([readFailure, closeFailure]);
      expect(failure.errors[0]).toBe(readFailure);
      expect(failure.errors[1]).toBe(closeFailure);
      expect(reader.getOffset()).toBe(0);
    } finally {
      openSpy.mockRestore();
      reader.stop();
    }
  });

  it('serializes prime and reads on one lane using the newly committed cursor', async () => {
    await writeFile(file, 'skip\nnext\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    const entered = deferred();
    const gate = deferred();
    const stat = fsPromises.stat;
    let blocked = true;
    let overlappingStats = 0;
    const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
      const first = blocked && args[0] === file && overlappingStats === 0;
      if (blocked && args[0] === file) overlappingStats += 1;
      const info = await stat(...args);
      if (first) {
        entered.resolve();
        await gate.promise;
      }
      return info;
    });
    try {
      const priming = reader.prime(5);
      await entered.promise;
      const reading = reader.readAvailable();
      await Promise.resolve();
      await Promise.resolve();
      expect(overlappingStats).toBe(1);
      blocked = false;
      gate.resolve();
      await priming;
      expect(await reading).toEqual(expect.objectContaining({ lines: ['next'], lineOffsets: [5] }));
    } finally {
      blocked = false;
      gate.resolve();
      statSpy.mockRestore();
      reader.stop();
    }
  });

  it('invalidates a suspended prime before it can commit its cursor', async () => {
    await writeFile(file, 'old\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    const entered = deferred();
    const gate = deferred();
    const stat = fsPromises.stat;
    const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementationOnce(async (...args) => {
      const info = await stat(...args);
      entered.resolve();
      await gate.promise;
      return info;
    });
    try {
      const old = reader.prime();
      await entered.promise;
      reader.stop();
      const current = reader.prime(0);
      let offsetAfterOld = -1;
      const observed = old.then(() => { offsetAfterOld = reader.getOffset(); });
      gate.resolve();
      await Promise.all([observed, current]);
      expect(offsetAfterOld).toBe(0);
      expect((await reader.readAvailable()).lines).toEqual(['old']);
    } finally {
      gate.resolve();
      statSpy.mockRestore();
      reader.stop();
    }
  });

  it('drops queued old requests but permits new manual reads after stop', async () => {
    await writeFile(file, 'line\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    const entered = deferred();
    const gate = deferred();
    const stat = fsPromises.stat;
    const statSpy = jest.spyOn(fsPromises, 'stat').mockImplementationOnce(async (...args) => {
      const info = await stat(...args);
      entered.resolve();
      await gate.promise;
      return info;
    });
    try {
      const blockingPrime = reader.prime();
      await entered.promise;
      const oldRead = reader.readAvailable();
      const oldPrime = reader.prime(999);
      reader.stop();
      const currentRead = reader.readAvailable();
      gate.resolve();
      const [, stale, , current] = await Promise.all([blockingPrime, oldRead, oldPrime, currentRead]);
      expect(stale.lines).toEqual([]);
      expect(current.lines).toEqual(['line']);
      expect(current.lineOffsets).toEqual([0]);
      expect(reader.getOffset()).toBe(5);
    } finally {
      gate.resolve();
      statSpy.mockRestore();
      reader.stop();
    }
  });

  it('closes but never reads a handle opened after its request was stopped', async () => {
    await writeFile(file, 'line\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    const entered = deferred();
    const gate = deferred();
    const open = fsPromises.open;
    let oldRead: jest.SpyInstance | undefined;
    let oldClose: jest.SpyInstance | undefined;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      oldRead = jest.spyOn(handle, 'read');
      oldClose = jest.spyOn(handle, 'close');
      entered.resolve();
      await gate.promise;
      return handle;
    });
    try {
      const stale = reader.readAvailable();
      await entered.promise;
      reader.stop();
      const current = reader.readAvailable();
      gate.resolve();
      expect((await stale).lines).toEqual([]);
      expect(oldRead).not.toHaveBeenCalled();
      expect(oldClose).toHaveBeenCalledTimes(1);
      expect((await current).lines).toEqual(['line']);
    } finally {
      gate.resolve();
      openSpy.mockRestore();
      reader.stop();
    }
  });

  it.each(['read', 'close'] as const)(
    'invalidates a stopped %s before a queued new prime and read',
    async stage => {
      await writeFile(file, 'old-line\nold-part');
      const reader = new ClaudeTranscriptTailReader(file);
      await reader.prime(0);
      const entered = deferred();
      const gate = deferred();
      const open = fsPromises.open;
      const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
        const handle = await open(...args);
        if (stage === 'read') {
          const read = handle.read.bind(handle);
          handle.read = (async (...readArgs: Parameters<typeof read>) => {
            const result = await read(...readArgs);
            entered.resolve();
            await gate.promise;
            return result;
          }) as typeof handle.read;
        } else {
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); entered.resolve(); await gate.promise; };
        }
        return handle;
      });
      try {
        const old = reader.readAvailable();
        await entered.promise;
        reader.stop();
        await writeFile(file, '新-line\ntail');
        const priming = reader.prime(0);
        const reading = reader.readAvailable();
        gate.resolve();
        const [stale, , current] = await Promise.all([old, priming, reading]);
        expect(stale.lines).toEqual([]);
        expect(current.lines).toEqual(['新-line']);
        expect(current.lineOffsets).toEqual([0]);
        expect(reader.getOffset()).toBe(Buffer.byteLength('新-line\ntail'));
        await appendFile(file, '-end\n');
        expect((await reader.readAvailable()).lines).toEqual(['tail-end']);
      } finally {
        gate.resolve();
        openSpy.mockRestore();
        reader.stop();
      }
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'allows a restarted watcher to run while the previous callback will %s',
    async settlement => {
      await writeFile(file, 'old\n');
      const onError = jest.fn();
      const reader = new ClaudeTranscriptTailReader(file, undefined, undefined, onError);
      await reader.prime(0);
      jest.useFakeTimers();
      const oldEntered = deferred();
      const newEntered = deferred();
      const oldFinished = deferred();
      const oldGate = deferred();
      const newGate = deferred();
      const oldCallback = jest.fn(async () => {
        oldEntered.resolve();
        await oldGate.promise;
        try {
          if (settlement === 'reject') throw new Error('old callback failure');
        } finally {
          oldFinished.resolve();
        }
      });
      const newCallback = jest.fn(async () => { newEntered.resolve(); await newGate.promise; });
      try {
        reader.start(oldCallback);
        await jest.advanceTimersByTimeAsync(2_000);
        await oldEntered.promise;
        await jest.advanceTimersByTimeAsync(6_000);
        expect(oldCallback).toHaveBeenCalledTimes(1);
        reader.stop();
        await appendFile(file, 'new\n');
        reader.start(newCallback);
        await jest.advanceTimersByTimeAsync(2_000);
        await newEntered.promise;
        expect(newCallback).toHaveBeenCalledWith(expect.objectContaining({ lines: ['new'], lineOffsets: [4] }));
        oldGate.resolve();
        await oldFinished.promise;
        await jest.advanceTimersByTimeAsync(4_000);
        expect(jest.getTimerCount()).toBe(0);
        expect(onError).toHaveBeenCalledTimes(settlement === 'reject' ? 1 : 0);
        expect(oldCallback).toHaveBeenCalledTimes(1);
        expect(newCallback).toHaveBeenCalledTimes(1);
        expect((await reader.readAvailable()).lines).toEqual([]);
      } finally {
        oldGate.resolve();
        newGate.resolve();
        reader.stop();
      }
    },
  );

  it('releases the IO lane and closes the handle when a read rejects', async () => {
    await writeFile(file, 'line\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    const open = fsPromises.open;
    let close: jest.SpyInstance | undefined;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      close = jest.spyOn(handle, 'close');
      jest.spyOn(handle, 'read').mockRejectedValueOnce(new Error('read failure') as never);
      return handle;
    });
    try {
      await expect(reader.readAvailable()).rejects.toThrow('read failure');
      expect(close).toHaveBeenCalledTimes(1);
      expect((await reader.readAvailable()).lines).toEqual(['line']);
    } finally {
      openSpy.mockRestore();
      reader.stop();
    }
  });

  it('keeps the IO lane free during a real pending onBatch across watcher restart', async () => {
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    await writeFile(file, 'old\n');
    jest.useFakeTimers();
    const oldEntered = deferred();
    const newEntered = deferred();
    const oldGate = deferred();
    const oldCallback = jest.fn(async () => { oldEntered.resolve(); await oldGate.promise; });
    const newCallback = jest.fn(async () => { newEntered.resolve(); });
    try {
      reader.start(oldCallback);
      await jest.advanceTimersByTimeAsync(2_000);
      await oldEntered.promise;
      expect(oldCallback).toHaveBeenCalledWith(expect.objectContaining({ lines: ['old'], lineOffsets: [0] }));
      expect((await reader.readAvailable()).lines).toEqual([]);
      await appendFile(file, 'new\n');
      reader.stop();
      reader.start(newCallback);
      await jest.advanceTimersByTimeAsync(2_000);
      await newEntered.promise;
      expect(newCallback).toHaveBeenCalledWith(expect.objectContaining({ lines: ['new'], lineOffsets: [4] }));
      expect(oldCallback).toHaveBeenCalledTimes(1);
      expect(newCallback).toHaveBeenCalledTimes(1);
      oldGate.resolve();
    } finally {
      oldGate.resolve();
      reader.stop();
    }
  });

  it('supports an absent file at prime and reads it when created', async () => {
    await rm(file);
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime();
    expect((await reader.readAvailable()).lines).toEqual([]);
    await writeFile(file, 'created\n');
    expect((await reader.readAvailable()).lines).toEqual(['created']);
  });

  it('primes at EOF and reads only appended complete lines', async () => {
    await writeFile(file, '{"old":true}\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime();
    await appendFile(file, '{"new":1}\n{"half":"中');
    expect(await reader.readAvailable()).toEqual(expect.objectContaining({ lines: ['{"new":1}'], reset: false }));
    await appendFile(file, '文"}\n');
    expect(await reader.readAvailable()).toEqual(expect.objectContaining({ lines: ['{"half":"中文"}'], reset: false }));
  });

  it('reports the byte offset of each complete line across partial reads', async () => {
    const reader = new ClaudeTranscriptTailReader(file, 8);
    await reader.prime(5);
    await writeFile(file, 'old!\nabc\ndefgh\n');

    expect(await reader.readAvailable()).toEqual(expect.objectContaining({
      lines: ['abc'],
      lineOffsets: [5],
    }));
    expect(await reader.readAvailable()).toEqual(expect.objectContaining({
      lines: ['defgh'],
      lineOffsets: [9],
    }));
  });

  it('preserves UTF-8 split across byte batches and does not advance past unread bytes', async () => {
    const reader = new ClaudeTranscriptTailReader(file, 8);
    await reader.prime(0);
    await writeFile(file, '123456中\nnext\n');
    expect((await reader.readAvailable()).lines).toEqual([]);
    expect(reader.getOffset()).toBe(8);
    expect((await reader.readAvailable()).lines).toEqual(['123456中', 'next']);
  });

  it('reports truncate and replacement resets', async () => {
    await writeFile(file, 'old\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime();
    await truncate(file, 0);
    expect((await reader.readAvailable()).reset).toBe(true);
    await writeFile(join(dir, 'replacement'), 'new\n');
    await rename(join(dir, 'replacement'), file);
    const result = await reader.readAvailable();
    expect(result.reset).toBe(true);
    expect(result.lines).toEqual(['new']);
  });

  it('polls every fixed 2s, does not re-enter a slow tick, and stops timers', async () => {
    await writeFile(file, 'one\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    const entered = deferred();
    const gate = deferred();
    const delivered = deferred();
    const open = fsPromises.open;
    const openSpy = jest.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        entered.resolve();
        await gate.promise;
        return read(...readArgs);
      }) as typeof handle.read;
      return handle;
    });
    jest.useFakeTimers();
    const callback = jest.fn(() => { delivered.resolve(); });
    try {
      reader.start(callback);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(openSpy).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await entered.promise;
      expect(openSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(4_000);
      expect(openSpy).toHaveBeenCalledTimes(1);
      gate.resolve();
      await delivered.promise;
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ lines: ['one'] }));
      reader.stop();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      gate.resolve();
      reader.stop();
      openSpy.mockRestore();
    }
  });

  it('bounds one tick to four batches and resumes on the next macrotask', async () => {
    const reader = new ClaudeTranscriptTailReader(file, 2, 1);
    await reader.prime(0);
    await writeFile(file, 'a\nb\nc\nd\ne\n');
    const callback = jest.fn();
    const inputTimer = jest.fn();
    let resolveFifth!: () => void;
    const fifth = new Promise<void>(resolve => { resolveFifth = resolve; });
    callback.mockImplementation(() => {
      if (callback.mock.calls.length === 4) setTimeout(inputTimer, 0);
      if (callback.mock.calls.length === 5) resolveFifth();
    });
    reader.start(callback);
    await fifth;

    expect(callback).toHaveBeenCalledTimes(5);
    expect(inputTimer).toHaveBeenCalledTimes(1);
    expect(reader.getOffset()).toBe(10);
    reader.stop();
  });

  it('isolates onBatch rejection and retries only after the normal poll delay', async () => {
    await writeFile(file, 'a\nb\n');
    const errorSeen = deferred();
    const secondSeen = deferred();
    const onError = jest.fn(() => { errorSeen.resolve(); });
    const reader = new ClaudeTranscriptTailReader(file, 2, 2_000, onError);
    await reader.prime(0);
    const failure = new Error('injected');
    const callback = jest.fn()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(async () => { secondSeen.resolve(); });
    jest.useFakeTimers();
    try {
      reader.start(callback);
      await jest.advanceTimersByTimeAsync(2_000);
      await errorSeen.promise;
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenNthCalledWith(1, expect.objectContaining({ lines: ['a'] }));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(failure);
      expect(reader.getOffset()).toBe(2);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(callback).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await secondSeen.promise;
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenNthCalledWith(2, expect.objectContaining({ lines: ['b'] }));
      expect(reader.getOffset()).toBe(4);
    } finally {
      reader.stop();
    }
  });

  it('serializes concurrent readAvailable calls over one offset', async () => {
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime(0);
    await writeFile(file, 'one\ntwo\n');
    const [first, second] = await Promise.all([reader.readAvailable(), reader.readAvailable()]);
    expect([...first.lines, ...second.lines]).toEqual(['one', 'two']);
    expect(second.lines).toEqual([]);
  });

  it('reads a sparse 79MB file incrementally instead of loading it', async () => {
    await truncate(file, 79 * 1024 * 1024);
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime();
    for (let index = 0; index < 100; index += 1) {
      expect((await reader.readAvailable()).lines).toEqual([]);
    }
    expect(reader.getOffset()).toBe(79 * 1024 * 1024);
  });
});
