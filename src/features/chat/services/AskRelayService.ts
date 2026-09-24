import { randomInt } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { AskUserQuestionItem } from '@/core/types/tools';

import { normalizeAskQuestions, toRelayQuestions } from '../rendering/askQuestions';

/** File protocol lives under <vault>/.claudian/ask-relay/ (gitignored). */
export const ASK_RELAY_DIR_SEGMENTS = ['.claudian', 'ask-relay'];

export const ASK_RELAY_POLL_INTERVAL_MS = 2000;

/** Consecutive nonce failures before the relay channel for a pending ask is voided. */
export const ASK_RELAY_NONCE_FAILURE_LIMIT = 5;

export interface AskRelayPendingInfo {
  askId: string;
  /** 6-digit anti-guess nonce; lives in the desktop notification only, never in ask.json. */
  nonce: string;
  /** First-question summary for the attention notification body. */
  summary: string;
}

export interface AskRelayArmParams {
  turnKind: 'user' | 'auto';
  sessionId: string;
  sessionName: string;
  input: Record<string, unknown>;
}

export interface AskRelayServiceDeps {
  /** Vault project root; null disables the relay (armFor returns null). */
  getVaultPath: () => string | null;
  generateId: () => string;
  /** Fires when the relay channel is voided by nonce failures. */
  onInvalidated?: () => void;
}

interface ActiveAsk {
  info: AskRelayPendingInfo;
  sessionId: string;
  questions: AskUserQuestionItem[];
  hasSecretQuestion: boolean;
  askFilePath: string;
  replyFilePath: string;
  nonceFailures: number;
  pollTimer: ReturnType<typeof setInterval>;
  /** Per-arm void callback: lets the armer cancel its attention notification. */
  onArmInvalidated?: () => void;
}

/**
 * Channel B of the dual-channel ask wait: file-protocol relay so a phone
 * (via dxchannel + ask_relay.py) can answer a pending AskUserQuestion while
 * the desktop card stays live. Answers resolve through
 * InlineAskUserQuestion.resolveExternal — the resolved guard makes the two
 * channels a first-settled race. Replies NEVER travel over SendMessage /
 * the CLI queue (they would not be consumed as answers while the ask is
 * pending — fe case, 2026-09-23).
 */
export class AskRelayService {
  private deps: AskRelayServiceDeps;
  private active: ActiveAsk | null = null;

  constructor(deps: AskRelayServiceDeps) {
    this.deps = deps;
  }

  /**
   * Arms the relay for a pending ask. Synchronous on purpose: the caller
   * gets the nonce immediately for the attention notification. Returns null
   * when the relay cannot arm (no vault path / empty question set).
   */
  armFor(
    params: AskRelayArmParams,
    onAnswers: (answers: Record<string, string | string[]>) => void,
    onArmInvalidated?: () => void,
  ): AskRelayPendingInfo | null {
    this.dispose();

    const vaultPath = this.deps.getVaultPath();
    if (!vaultPath) return null;

    // Same normalize pipeline as the desktop card — the phone-side option
    // numbers must match what the card renders, never the raw input.
    const questions = normalizeAskQuestions(params.input);
    if (questions.length === 0) return null;

    const dir = path.join(vaultPath, ...ASK_RELAY_DIR_SEGMENTS);
    const askId = this.deps.generateId();
    const info: AskRelayPendingInfo = {
      askId,
      nonce: String(randomInt(100000, 1000000)),
      summary: buildSummary(questions),
    };

    const askFile = {
      askId,
      sessionId: params.sessionId,
      sessionName: params.sessionName,
      turnKind: params.turnKind,
      createdAt: Date.now(),
      questions: toRelayQuestions(questions),
    };

    const askFilePath = path.join(dir, `${params.sessionId.slice(0, 8)}.ask.json`);
    // Fail-safe: the relay is a bypass channel — a write failure (read-only
    // vault, full disk) must degrade to "no relay this turn", never propagate
    // into handleAskUserQuestion where the catch-all would deny+interrupt
    // and kill the user's turn.
    try {
      writeJsonAtomic(askFilePath, askFile);
    } catch (error) {
      console.warn('[Claudian] ask relay arm failed; continuing without relay', error);
      return null;
    }

    const active: ActiveAsk = {
      info,
      sessionId: params.sessionId,
      questions,
      hasSecretQuestion: questions.some((q) => q.isSecret === true),
      askFilePath,
      replyFilePath: path.join(dir, `${askId}.reply.json`),
      nonceFailures: 0,
      pollTimer: setInterval(() => {
        this.pollReply(onAnswers);
      }, ASK_RELAY_POLL_INTERVAL_MS),
      onArmInvalidated,
    };
    this.active = active;
    return info;
  }

  /** Settles the relay (ask answered on either channel): stop polling, clean files. Idempotent. */
  dispose(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    clearInterval(active.pollTimer);
    removeFileSync(active.askFilePath);
    removeFileSync(active.replyFilePath);
  }

  /** True when a pending ask is armed. */
  isArmed(): boolean {
    return this.active !== null;
  }

  private pollReply(onAnswers: (answers: Record<string, string | string[]>) => void): void {
    const active = this.active;
    if (!active) return;

    let raw: string;
    try {
      raw = fs.readFileSync(active.replyFilePath, 'utf-8');
    } catch {
      return; // No reply yet — keep polling.
    }

    let reply: Record<string, unknown>;
    try {
      reply = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      removeFileSync(active.replyFilePath); // Corrupt file: drop so polling cannot loop on it.
      return;
    }

    if (reply.askId !== active.info.askId || reply.sessionId !== active.sessionId) {
      // Addressing mismatch (askId lives in the filename; sessionId guards
      // cross-session mixups when several tabs each hold a pending ask).
      removeFileSync(active.replyFilePath);
      return;
    }

    if (typeof reply.nonce !== 'string' || reply.nonce !== active.info.nonce) {
      removeFileSync(active.replyFilePath);
      active.nonceFailures++;
      if (active.nonceFailures >= ASK_RELAY_NONCE_FAILURE_LIMIT) {
        // Void the relay channel only: the desktop card keeps waiting — a
        // desktop deny would be ending the user's turn for them (DoS
        // amplification for 5 deliberate wrong guesses).
        this.deps.onInvalidated?.();
        active.onArmInvalidated?.();
        this.dispose();
      }
      return;
    }

    removeFileSync(active.replyFilePath);

    if (active.hasSecretQuestion) {
      return; // Secret asks must be answered at the desktop.
    }

    const answers = buildAnswers(active.questions, reply.answers);
    if (!answers) {
      return; // Structural reject: dropped, ask stays armed for a corrected reply.
    }

    this.dispose();
    onAnswers(answers);
  }
}

/** Desktop-submit-equivalent mapping from the reply protocol to SDK answers. */
function buildAnswers(
  questions: AskUserQuestionItem[],
  rawAnswers: unknown,
): Record<string, string | string[]> | null {
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== questions.length) {
    return null; // Desktop requires every question answered before submit.
  }

  const result: Record<string, string | string[]> = {};
  const seen = new Set<number>();

  for (const entry of rawAnswers) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { q, picks, text } = entry as { q?: unknown; picks?: unknown; text?: unknown };
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 0 || q >= questions.length) return null;
    if (seen.has(q)) return null;
    seen.add(q);

    const question = questions[q];
    const options = question.options;

    if (!Array.isArray(picks)) return null;
    for (const p of picks) {
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > options.length) return null;
    }
    const hasText = typeof text === 'string' && text.trim().length > 0;
    if (typeof text !== 'undefined' && typeof text !== 'string') return null;
    if (picks.length === 0 && !hasText) return null;
    if (hasText && question.isOther !== true) return null; // Desktop hides the custom input for non-other questions.

    const pickedValues = picks.map((p) => options[p - 1].value ?? options[p - 1].label);

    if (question.multiSelect) {
      result[question.id ?? question.question] = hasText ? [...pickedValues, text] : pickedValues;
    } else {
      if (picks.length > 1) return null; // Single-select with several picks is a protocol error.
      result[question.id ?? question.question] = hasText ? text : pickedValues[0];
    }
  }

  if (seen.size !== questions.length) return null;
  return result;
}

function buildSummary(questions: AskUserQuestionItem[]): string {
  const first = questions[0];
  const total = questions.length;
  const text = first.question.length > 80 ? `${first.question.slice(0, 77)}...` : first.question;
  return total > 1 ? `${text} (+${total - 1})` : text;
}

function writeJsonAtomic(filePath: string, body: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, filePath);
}

function removeFileSync(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Missing file is the common case (first dispose after settle).
  }
}

/**
 * Startup orphan sweep: plugin start can never inherit a live pending ask
 * (the SDK connection dropped with the previous process aborted any turn),
 * so every relay file from a previous run is stale.
 */
export function cleanupAskRelayFiles(vaultPath: string): void {
  const dir = path.join(vaultPath, ...ASK_RELAY_DIR_SEGMENTS);
  let entries: unknown;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // No relay dir — nothing to sweep.
  }
  // The sweep must never break onload (e.g. mocked fs in tests): a non-array
  // listing is a no-op, not a crash.
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (typeof entry === 'string'
      && (entry.endsWith('.ask.json') || entry.endsWith('.reply.json') || entry.endsWith('.ask.json.tmp'))) {
      removeFileSync(path.join(dir, entry));
    }
  }
}
