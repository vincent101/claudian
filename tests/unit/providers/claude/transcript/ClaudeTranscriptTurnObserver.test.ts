import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import { buildTranscriptIndex } from '@/providers/claude/history/ClaudeTranscriptHistoryIndex';
import * as sdkSessionPaths from '@/providers/claude/history/sdkSessionPaths';
import { ClaudeTranscriptTailReader } from '@/providers/claude/transcript/ClaudeTranscriptTailReader';
import { ClaudeTranscriptTurnObserver } from '@/providers/claude/transcript/ClaudeTranscriptTurnObserver';

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

  it('starts from an explicit snapshot boundary without recovery duplication', async () => {
    const snapshot = `${peerTurn('old', 'old').join('\n')}\n`;
    await writeFile(file, snapshot);
    const boundary = (await stat(file)).size;
    const { observer, callbacks } = setup();
    await observer.start(file, boundary);
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
    const consuming = (observer as any).consumeBatch({
      lines: [...peerTurn('peer-stuck', 'stuck'), ...peerTurn('peer-next', 'next')],
      reset: false,
    }, generation);
    await jest.advanceTimersByTimeAsync(1_000);
    await consuming;
    await (observer as any).settleQuietCandidate(generation);
    expect(callbacks.cancelled).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'peer-stuck' }));
    expect(order).toContain('release:peer-stuck');
    expect(order).toContain('start:peer-next');
    observer.stop();
    jest.useRealTimers();
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
    // boundary; this is the value Tab.ts forwards to the runtime's
    // setTranscriptObserverStartOffset.
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
    lease.release();
    sessionPathSpy.mockRestore();
    existsSpy.mockRestore();

    // Layer 3 (observer): primed at that boundary, the completed half line
    // and the line after it are each consumed once; nothing replays.
    const { observer, callbacks } = setup();
    try {
      await observer.start(file, page.snapshotOffset);
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
