import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type AskRelayPendingInfo,
  AskRelayService,
  cleanupAskRelayFiles,
} from '@/features/chat/services/AskRelayService';

jest.useFakeTimers();

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ask-relay-test-'));
}

function makeService(dir: string): {
  service: AskRelayService;
  answers: Array<Record<string, string | string[]>>;
  invalidated: jest.Mock;
} {
  const answers: Array<Record<string, string | string[]>> = [];
  const invalidated = jest.fn();
  const service = new AskRelayService({
    getVaultPath: () => dir,
    generateId: (() => {
      let n = 0;
      return () => `ask-${++n}`;
    })(),
    onInvalidated: invalidated,
  });
  return {
    service,
    get answers() { return answers; },
    invalidated,
  };
}

interface ArmOptions {
  sessionId?: string;
  sessionName?: string;
  input?: Record<string, unknown>;
}

function arm(
  service: AskRelayService,
  answers: Array<Record<string, string | string[]>>,
  opts: ArmOptions = {},
): AskRelayPendingInfo {
  const pending = service.armFor(
    {
      turnKind: 'user',
      sessionId: opts.sessionId ?? 'sess-aaaaaaaa-1111',
      sessionName: opts.sessionName ?? 'fe',
      input: opts.input ?? {
        questions: [{
          question: 'Proceed?',
          options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
          isOther: false,
        }],
      },
    },
    (result) => answers.push(result),
  );
  if (!pending) throw new Error('armFor returned null');
  return pending;
}

function writeReply(dir: string, pending: AskRelayPendingInfo, body: Record<string, unknown>): void {
  const file = path.join(relayDir(dir), `${pending.askId}.reply.json`);
  fs.writeFileSync(file, JSON.stringify(body));
}

function relayDir(dir: string): string {
  return path.join(dir, '.claudian', 'ask-relay');
}

function readAskFile(dir: string, sidPrefix = 'sess-aaa'): any {
  const files = fs.readdirSync(relayDir(dir)).filter((f) => f.endsWith('.ask.json'));
  const file = files.find((f) => f.startsWith(sidPrefix)) ?? files[0];
  return JSON.parse(fs.readFileSync(path.join(relayDir(dir), file), 'utf-8'));
}

describe('AskRelayService', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('armFor', () => {
    it('writes ask.json with single-source normalized questions (dedupe renumbering)', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers, {
        input: {
          questions: [{
            question: 'Pick',
            options: [
              { label: 'A', description: 'first' },
              { label: 'A', description: 'dup dropped' },
              { label: 'B', value: 'b_val' },
            ],
            isOther: false,
          }],
        },
      });

      const ask = readAskFile(dir);
      expect(ask.askId).toBe(pending.askId);
      expect(ask.sessionId).toBe('sess-aaaaaaaa-1111');
      expect(ask.sessionName).toBe('fe');
      expect(ask.turnKind).toBe('user');
      expect(ask.createdAt).toBeGreaterThan(0);
      // Post-dedupe option order — pick 2 maps to "B", not the dropped dup.
      expect(ask.questions[0].options).toEqual([
        { label: 'A', description: 'first' },
        { label: 'B', description: '' },
      ]);
      expect(pending.nonce).toMatch(/^\d{6}$/);
      expect(pending.summary).toContain('Pick');
    });

    it('returns null without writing when vault path is null', () => {
      const service = new AskRelayService({
        getVaultPath: () => null,
        generateId: () => 'ask-1',
      });
      const pending = service.armFor(
        { turnKind: 'user', sessionId: 's', sessionName: 'n', input: { questions: [{ question: 'Q', options: ['A'] }] } },
        () => {},
      );
      expect(pending).toBeNull();
      expect(fs.readdirSync(dir)).toHaveLength(0);
    });

    it('degrades to null on unwritable vault path (fail-safe, no throw)', () => {
      // Vault "root" occupied by a regular file: mkdir fails (ENOTDIR/EEXIST).
      const blockedPath = path.join(dir, 'not-a-dir');
      fs.writeFileSync(blockedPath, 'occupied');
      const service = new AskRelayService({
        getVaultPath: () => blockedPath,
        generateId: () => 'ask-1',
      });
      expect(() =>
        service.armFor(
          { turnKind: 'user', sessionId: 'sess-aaaaaaaa-1111', sessionName: 'fe', input: { questions: [{ question: 'Q', options: ['A'] }] } },
          () => {},
        ),
      ).not.toThrow();
      const pending = service.armFor(
        { turnKind: 'user', sessionId: 'sess-aaaaaaaa-1111', sessionName: 'fe', input: { questions: [{ question: 'Q', options: ['A'] }] } },
        () => {},
      );
      expect(pending).toBeNull();
      expect(service.isArmed()).toBe(false);
    });

    it('rejects arm when the normalized question set is empty', () => {
      const { service, answers } = makeService(dir);
      const pending = service.armFor(
        { turnKind: 'user', sessionId: 's', sessionName: 'n', input: { questions: [] } },
        () => answers.push({}),
      );
      expect(pending).toBeNull();
    });
  });

  describe('reply polling', () => {
    it('accepts a valid single-select reply: maps picks to option value, cleans files', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers);

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [2] }],
        via: 'phone-dxchannel',
        userQuote: '选 No',
        repliedAt: new Date().toISOString(),
      });
      jest.advanceTimersByTime(2000);

      expect(answers).toEqual([{ 'Proceed?': 'no' }]);
      // Both ask and reply files are cleaned once the ask settles.
      expect(fs.readdirSync(relayDir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(0);
    });

    it('maps picks to label when value is absent (value ?? label)', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers, {
        input: { questions: [{ question: 'Pick', options: ['A', 'B'], isOther: false }] },
      });

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1] }],
      });
      jest.advanceTimersByTime(2000);

      expect(answers).toEqual([{ Pick: 'A' }]);
    });

    it('keys answers by question id when present', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers, {
        input: { questions: [{ id: 'q_id', question: 'Proceed?', options: ['Yes', 'No'], isOther: false }] },
      });

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1] }],
      });
      jest.advanceTimersByTime(2000);

      expect(answers).toEqual([{ q_id: 'Yes' }]);
    });

    it('multi-select picks map to a value array; text appends (desktop submit semantics)', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers, {
        input: {
          questions: [
            { question: 'Pick many', options: ['X', 'Y', 'Z'], multiSelect: true, isOther: true },
            { question: 'Second?', options: ['A', 'B'], isOther: true },
          ],
        },
      });

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [
          { q: 0, picks: [1, 3], text: 'custom note' },
          { q: 1, picks: [2] },
        ],
      });
      jest.advanceTimersByTime(2000);

      expect(answers).toEqual([
        { 'Pick many': ['X', 'Z', 'custom note'], 'Second?': 'B' },
      ]);
    });

    it('single-select text overrides the pick (desktop custom-input semantics)', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers, {
        input: { questions: [{ question: 'Pick', options: ['A', 'B'], isOther: true }] },
      });

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1], text: 'my own answer' }],
      });
      jest.advanceTimersByTime(2000);

      expect(answers).toEqual([{ Pick: 'my own answer' }]);
    });

    it('rejects single-select with multiple picks', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers);

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1, 2] }],
      });
      jest.advanceTimersByTime(2000);
      jest.advanceTimersByTime(2000);

      expect(answers).toHaveLength(0);
      // Rejected reply file removed so polling does not loop on it.
      expect(fs.existsSync(path.join(relayDir(dir), `${pending.askId}.reply.json`))).toBe(false);
    });

    it('rejects picks/text on a question that does not allow other', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers, {
        input: { questions: [{ question: 'Pick', options: ['A', 'B'], isOther: false }] },
      });

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1], text: 'sneaky' }],
      });
      jest.advanceTimersByTime(2000);
      jest.advanceTimersByTime(2000);

      expect(answers).toHaveLength(0);
    });

    it('rejects out-of-range question index and out-of-range picks', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers);

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 5, picks: [1] }],
      });
      jest.advanceTimersByTime(2000);
      expect(answers).toHaveLength(0);

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [9] }],
      });
      jest.advanceTimersByTime(2000);
      expect(answers).toHaveLength(0);
    });

    it('rejects an empty answer (no picks, no text)', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers);

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [] }],
      });
      jest.advanceTimersByTime(2000);
      jest.advanceTimersByTime(2000);

      expect(answers).toHaveLength(0);
    });

    it('rejects replies that do not cover every question (desktop requires all answered)', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers, {
        input: {
          questions: [
            { question: 'Q1', options: ['A'], isOther: false },
            { question: 'Q2', options: ['B'], isOther: false },
          ],
        },
      });

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1] }],
      });
      jest.advanceTimersByTime(2000);
      jest.advanceTimersByTime(2000);

      expect(answers).toHaveLength(0);
    });

    it('rejects a reply whose sessionId does not address this ask (routing mismatch)', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers);

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'other-session-id',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1] }],
      });
      jest.advanceTimersByTime(2000);
      jest.advanceTimersByTime(2000);

      expect(answers).toHaveLength(0);
      // Addressing mismatch is not a nonce failure: the ask stays armed.
      expect(fs.existsSync(path.join(relayDir(dir), 'sess-aaa.ask.json'))).toBe(true);
    });

    it('drops corrupted replies without counting nonce failures', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers);

      fs.writeFileSync(path.join(relayDir(dir), `${pending.askId}.reply.json`), '{not json');
      jest.advanceTimersByTime(2000);
      jest.advanceTimersByTime(2000);

      expect(answers).toHaveLength(0);
      expect(fs.existsSync(path.join(relayDir(dir), `${pending.askId}.reply.json`))).toBe(false);
    });

    it('rejects any reply for an ask containing a secret question', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers, {
        input: {
          questions: [
            { question: 'Public', options: ['A'], isOther: false },
            { question: 'Token?', options: null, isOther: true, isSecret: true },
          ],
        },
      });

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1] }],
      });
      jest.advanceTimersByTime(2000);
      jest.advanceTimersByTime(2000);

      expect(answers).toHaveLength(0);
    });
  });

  describe('nonce hardening', () => {
    it('invalidates the relay channel after 5 consecutive nonce failures', () => {
      const { service, answers, invalidated } = makeService(dir);
      const pending = arm(service, answers);

      for (let i = 0; i < 5; i++) {
        writeReply(dir, pending, {
          askId: pending.askId,
          sessionId: 'sess-aaaaaaaa-1111',
          nonce: '000000',
          answers: [{ q: 0, picks: [1] }],
        });
        jest.advanceTimersByTime(2000);
      }

      expect(invalidated).toHaveBeenCalledTimes(1);
      // Ask file removed: the phone side sees no pending ask anymore.
      expect(fs.readdirSync(relayDir(dir)).filter((f) => f.endsWith('.ask.json'))).toHaveLength(0);
      expect(answers).toHaveLength(0);

      // Even a later reply with the correct nonce is refused (channel dead).
      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1] }],
      });
      jest.advanceTimersByTime(10_000);
      expect(answers).toHaveLength(0);
      expect(fs.existsSync(path.join(relayDir(dir), `${pending.askId}.reply.json`))).toBe(true);
    });

    it('4 failures then the correct nonce still accepts the reply', () => {
      const { service, answers, invalidated } = makeService(dir);
      const pending = arm(service, answers);

      for (let i = 0; i < 4; i++) {
        writeReply(dir, pending, {
          askId: pending.askId,
          sessionId: 'sess-aaaaaaaa-1111',
          nonce: '111111',
          answers: [{ q: 0, picks: [1] }],
        });
        jest.advanceTimersByTime(2000);
      }
      expect(invalidated).not.toHaveBeenCalled();

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1] }],
      });
      jest.advanceTimersByTime(2000);

      expect(answers).toEqual([{ 'Proceed?': 'yes' }]);
    });

    it('a missing nonce counts as a failure', () => {
      const { service, answers, invalidated } = makeService(dir);
      const pending = arm(service, answers);

      for (let i = 0; i < 5; i++) {
        writeReply(dir, pending, {
          askId: pending.askId,
          sessionId: 'sess-aaaaaaaa-1111',
          answers: [{ q: 0, picks: [1] }],
        });
        jest.advanceTimersByTime(2000);
      }

      expect(invalidated).toHaveBeenCalledTimes(1);
      expect(answers).toHaveLength(0);
    });
  });

  describe('first-settled race with the desktop channel', () => {
    it('dispose (desktop answered first) stops polling and cleans files; late reply is inert', () => {
      const { service, answers } = makeService(dir);
      const pending = arm(service, answers);

      service.dispose();

      expect(fs.readdirSync(relayDir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(0);

      writeReply(dir, pending, {
        askId: pending.askId,
        sessionId: 'sess-aaaaaaaa-1111',
        nonce: pending.nonce,
        answers: [{ q: 0, picks: [1] }],
      });
      jest.advanceTimersByTime(10_000);

      expect(answers).toHaveLength(0);
    });

    it('dispose is idempotent and safe when idle', () => {
      const { service, answers } = makeService(dir);
      arm(service, answers);
      service.dispose();
      service.dispose();
      expect(fs.readdirSync(relayDir(dir))).toHaveLength(0);
    });

    it('re-arming after dispose writes a fresh ask file', () => {
      const { service, answers } = makeService(dir);
      arm(service, answers);
      service.dispose();
      const second = arm(service, answers);

      const ask = readAskFile(dir);
      expect(ask.askId).toBe(second.askId);
    });
  });

  describe('cleanupAskRelayFiles (startup orphan sweep)', () => {
    it('removes stale ask and reply files from a previous run', () => {
      fs.mkdirSync(relayDir(dir), { recursive: true });
      fs.writeFileSync(path.join(relayDir(dir), 'abcd1234.ask.json'), '{}');
      fs.writeFileSync(path.join(relayDir(dir), 'ask-1.reply.json'), '{}');
      fs.writeFileSync(path.join(relayDir(dir), 'unrelated.txt'), 'keep');

      cleanupAskRelayFiles(dir);

      expect(fs.readdirSync(relayDir(dir))).toEqual(['unrelated.txt']);
    });

    it('is a no-op for a missing directory', () => {
      expect(() => cleanupAskRelayFiles(path.join(dir, 'nope'))).not.toThrow();
    });
  });
});
