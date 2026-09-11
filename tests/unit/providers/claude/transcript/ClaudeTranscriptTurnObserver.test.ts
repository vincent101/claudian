import { appendFile, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ClaudeTranscriptTailReader } from '@/providers/claude/transcript/ClaudeTranscriptTailReader';
import { ClaudeTranscriptTurnObserver } from '@/providers/claude/transcript/ClaudeTranscriptTurnObserver';

function peerTurn(id: string, text: string, complete = true): string[] {
  const lines = [
    JSON.stringify({ type: 'user', uuid: id, origin: { kind: 'peer', body: text }, message: { role: 'user', content: text } }),
    JSON.stringify({ type: 'assistant', uuid: `${id}-a1`, message: { id: `${id}-m1`, role: 'assistant', content: [{ type: 'text', text: 'working' }], stop_reason: 'tool_use' } }),
  ];
  if (complete) lines.push(JSON.stringify({ type: 'assistant', uuid: `${id}-a2`, message: { id: `${id}-m2`, role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }));
  return lines;
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
    };
    const observer = new ClaudeTranscriptTurnObserver(callbacks, canAcquire);
    return { observer, callbacks, order };
  }

  it('recovery replays only an unfinished external turn', async () => {
    await writeFile(file, `${peerTurn('peer-open', 'hello', false).join('\n')}\n`);
    const { observer, callbacks } = setup();
    await observer.start(file);
    observer.stop();
    expect(callbacks.started).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-open', replay: true }));
    expect(callbacks.chunk).toHaveBeenCalledWith(expect.objectContaining({ replay: true }));
    expect(callbacks.finished).not.toHaveBeenCalled();
  });

  it('recovery primes completed history without reprojecting it', async () => {
    await writeFile(file, `${peerTurn('peer-done', 'hello').join('\n')}\n`);
    const { observer, callbacks } = setup();
    await observer.start(file);
    observer.stop();
    expect(callbacks.started).not.toHaveBeenCalled();
    expect(callbacks.chunk).not.toHaveBeenCalled();
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
      'start:peer-2',
      'chunk:peer-2:text',
      'chunk:peer-2:text',
      'finish:peer-2',
      'release:peer-2',
      'release:peer-1',
    ]);
    observer.stop();
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
    callbacks[failing as 'chunk' | 'finished'].mockRejectedValueOnce(new Error('injected'));
    await observer.start(file);
    const generation = (observer as any).generation;
    await (observer as any).consumeBatch({ lines: peerTurn('peer-fail', 'failure'), reset: false }, generation);
    expect(callbacks.cancelled).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'peer-fail',
      interrupted: true,
    }));
    observer.stop();
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
});
