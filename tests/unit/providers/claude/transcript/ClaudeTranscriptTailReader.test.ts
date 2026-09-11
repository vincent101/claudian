import { appendFile, mkdtemp, rename, rm,truncate, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ClaudeTranscriptTailReader } from '@/providers/claude/transcript/ClaudeTranscriptTailReader';

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

  it('primes at EOF and reads only appended complete lines', async () => {
    await writeFile(file, '{"old":true}\n');
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime();
    await appendFile(file, '{"new":1}\n{"half":"中');
    expect(await reader.readAvailable()).toEqual(expect.objectContaining({ lines: ['{"new":1}'], reset: false }));
    await appendFile(file, '文"}\n');
    expect(await reader.readAvailable()).toEqual(expect.objectContaining({ lines: ['{"half":"中文"}'], reset: false }));
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
    jest.useFakeTimers();
    const reader = new ClaudeTranscriptTailReader(file);
    await reader.prime();
    let release!: () => void;
    jest.spyOn(reader, 'readAvailable').mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ lines: ['one'], reset: false });
    }));
    const callback = jest.fn();
    reader.start(callback);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(reader.readAvailable).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(reader.readAvailable).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(reader.readAvailable).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    reader.stop();
    expect(jest.getTimerCount()).toBe(0);
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
    jest.useFakeTimers();
    const onError = jest.fn();
    const reader = new ClaudeTranscriptTailReader(file, 2, 2_000, onError);
    await reader.prime(0);
    await writeFile(file, 'a\nb\n');
    jest.spyOn(reader, 'readAvailable').mockImplementation(async () => {
      (reader as any).byteOffset += 2;
      return { lines: ['x'], reset: false, bytesRead: 2 };
    });
    const callback = jest.fn().mockRejectedValue(new Error('injected'));
    reader.start(callback);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(callback).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    reader.stop();
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
