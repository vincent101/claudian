import { createRequire } from 'node:module';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * End-to-end CLI-death settlement tests.
 *
 * These tests deliberately bypass the global SDK mock (jest moduleNameMapper)
 * and load the real ESM SDK through Node's native require(esm), then drive the
 * real ClaudianService against a fake CLI subprocess. The fake CLI reproduces
 * the 2026-09-25 incident timeline: init -> user dequeue -> assistant chunks
 * (sawAnyChunk=true) -> idle stall (stop-hook) -> death (exit / SIGKILL /
 * SIGTERM). The contract under test: the active turn's feature generator must
 * settle within seconds of CLI death so isStreaming clears and the queue can
 * pump.
 */

const nativeRequire = createRequire(__filename);

// The real SDK surface re-exported as the module every runtime import sees.
// jest's resolver intercepts bare specifiers even through createRequire, so
// the ESM entry is addressed by absolute path (cwd is the repo root under
// `npm run test` / `npx jest`). The `mock`-prefixed binding keeps the hoisted
// factory within jest's allowed scope, so the substitution applies to every
// transitively imported runtime module — including those pulled in by the
// provider registration import below.
const mockRealSdk = nativeRequire(path.join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
jest.mock('@anthropic-ai/claude-agent-sdk', () => mockRealSdk);

// Registers the claude provider (workspace registry) — must run after the mock
// substitution above. The type-only import is erased at compile time, so it
// does not disturb that ordering.
import '@/providers';

import type { ChatMessage, StreamChunk } from '@/core/types';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
type ClaudianServiceInstance = InstanceType<typeof ClaudianService>;

type FakeCliScript = {
  path: string;
};

/**
 * Writes a fake CLI bash script. Phase plan (seconds relative to user input):
 * init immediately, assistant after stdin arrives, then stall, then die.
 * `orphan` leaves a background subshell that inherits the stdout pipe write
 * end (the 2026-09-25 incident: a running background Task agent held the pipe
 * open after the main CLI process died).
 */
function writeFakeCli(
  death: 'sigkill' | 'exit' | 'sigterm',
  opts?: { queueOperation?: boolean; orphan?: boolean },
): FakeCliScript {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-cli-death-'));
  const scriptPath = path.join(dir, 'fake-claude.sh');
  const queueOp = opts?.queueOperation
    ? `echo '{"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>t1</task-id><status>completed</status><result>done</result></task-notification>"}'
sleep 0.4
`
    : '';
  const orphan = opts?.orphan ? '(sleep 25 &)\n' : '';
  const deathCmd = death === 'sigkill'
    ? 'kill -9 $$'
    : death === 'sigterm'
      ? 'kill -TERM $$'
      : 'exit 1';
  const script = `#!/bin/bash
echo '{"type":"system","subtype":"init","session_id":"cli-death-session","cwd":"${dir}","model":"claude-sonnet"}'
read -r line
echo '{"type":"assistant","uuid":"a-1","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]},"session_id":"cli-death-session"}'
sleep 0.4
${queueOp}${orphan}${deathCmd}
sleep 5
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return { path: scriptPath };
}

/**
 * Writes a fake CLI that streams one assistant chunk and then hangs mid-turn
 * (stop-hook stall without dying) — used to observe teardown of a still-live
 * process.
 */
function writeHangingCli(): FakeCliScript {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-cli-death-'));
  const scriptPath = path.join(dir, 'fake-claude.sh');
  const script = `#!/bin/bash
echo '{"type":"system","subtype":"init","session_id":"cli-death-session","cwd":"${dir}","model":"claude-sonnet"}'
read -r line
echo '{"type":"assistant","uuid":"a-1","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]},"session_id":"cli-death-session"}'
sleep 30
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return { path: scriptPath };
}

function buildService(cliPath: string): ClaudianServiceInstance {
  const storageMock = {
    addDenyRule: jest.fn().mockResolvedValue(undefined),
    addAllowRule: jest.fn().mockResolvedValue(undefined),
    getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
  };
  const plugin = {
    app: { vault: { adapter: { basePath: os.tmpdir() } } },
    storage: storageMock,
    settings: {
      model: 'claude-sonnet',
      permissionMode: 'ask',
      thinkingBudget: 0,
      mediaFolder: 'claudian-media',
      systemPrompt: '',
      loadUserClaudeSettings: false,
      claudeCliPath: cliPath,
      claudeCliPaths: [],
      enableAutoTitleGeneration: false,
    },
    getResolvedProviderCliPath: jest.fn().mockReturnValue(cliPath),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    pluginManager: { getPluginsKey: jest.fn().mockReturnValue('') },
  };
  const mcpManager = {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getActiveServers: jest.fn().mockReturnValue({}),
    getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    extractMentions: jest.fn().mockReturnValue(new Set()),
    transformMentions: jest.fn().mockImplementation((text: string) => text),
  };
  return new ClaudianService(plugin as never, mcpManager as never) as ClaudianServiceInstance;
}

/**
 * Drives service.query() to completion with an overall deadline. Returns the
 * chunk types observed. Resolves { timedOut: true } if the generator is still
 * pending when the deadline expires — that is the defect signature.
 */
async function consumeQueryWithDeadline(
  service: ClaudianServiceInstance,
  deadlineMs: number,
): Promise<{ timedOut: boolean; chunks: string[]; lastError: string | null }> {
  const prepared = service.prepareTurn({ turnId: `death-turn-${Date.now()}`, text: 'run the task' });
  // Feature callers always attach conversation history; the session-expired
  // retry path (CLI exit-code deaths classify as session errors) depends on
  // it, so the test must drive the same shape.
  const history: ChatMessage[] = [
    { id: 'h1', role: 'user', content: 'earlier task', timestamp: 1 },
    { id: 'h2', role: 'assistant', content: 'earlier answer', timestamp: 2 },
  ];
  const iterator = service.query(prepared, history)[Symbol.asyncIterator]();
  const chunks: string[] = [];
  let lastError: string | null = null;
  const deadline = Date.now() + deadlineMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { timedOut: true, chunks, lastError };
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('__DEADLINE__')), remaining)),
    ]).catch((e: Error) => {
      if (e.message === '__DEADLINE__') throw e;
      lastError = e.message;
      return { done: true, value: undefined } as IteratorResult<StreamChunk>;
    });
    if (next.done) return { timedOut: false, chunks, lastError };
    const value = next.value as { type: string; content?: string };
    chunks.push(value.type === 'error' ? `error:${value.content}` : value.type);
    if (value.type === 'error') lastError = value.content ?? null;
  }
}

describe('CLI death settlement (end-to-end, real SDK + fake CLI)', () => {
  jest.setTimeout(30000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['sigkill', 'Claude Code process terminated by signal SIGKILL'],
    ['exit', 'Claude Code process exited with code 1'],
    ['sigterm', 'Claude Code process terminated by signal SIGTERM'],
  ] as const)('settles the active turn when the CLI dies by %s', async (death, expectedErrorFragment) => {
    const fakeCli = writeFakeCli(death);
    const service = buildService(fakeCli.path);

    const result = await consumeQueryWithDeadline(service, 15000);

    expect(result.timedOut).toBe(false);
    // The turn must surface the CLI death as an error chunk, not hang.
    expect(result.chunks).toContainEqual(expect.stringContaining('error:'));
    expect(result.lastError ?? '').toContain(expectedErrorFragment);
    service.cleanup();
  });

  it('settles the active turn when the CLI dies after a queue-operation enqueue', async () => {
    const fakeCli = writeFakeCli('sigkill', { queueOperation: true });
    const service = buildService(fakeCli.path);

    const result = await consumeQueryWithDeadline(service, 15000);

    expect(result.timedOut).toBe(false);
    expect(result.chunks).toContainEqual(expect.stringContaining('error:'));
    service.cleanup();
  });

  // The 2026-09-25 incident reproduction: the CLI dies while a background
  // agent (orphan) still holds the stdout pipe write end. The SDK's death
  // detection depends on stdout reaching EOF, so without a forced stream
  // close the consumer loop — and every active turn handler behind it —
  // hangs forever (isStreaming stuck, queue dead, ESC dead).
  it.each([
    ['sigkill', 'Claude Code process terminated by signal SIGKILL'],
    ['exit', 'Claude Code process exited with code 1'],
    ['sigterm', 'Claude Code process terminated by signal SIGTERM'],
  ] as const)('settles the active turn when the CLI dies by %s while an orphan holds stdout', async (death, expectedErrorFragment) => {
    const fakeCli = writeFakeCli(death, { orphan: true });
    const service = buildService(fakeCli.path);

    const result = await consumeQueryWithDeadline(service, 15000);

    expect(result.timedOut).toBe(false);
    expect(result.chunks).toContainEqual(expect.stringContaining('error:'));
    expect(result.lastError ?? '').toContain(expectedErrorFragment);
    service.cleanup();
  });

  // Abort-driven teardown (user cancel) must still terminate the turn: the
  // forced stdout close fires unconditionally (no signal check — an aborted
  // kill leaves the same orphaned fd holder as any other death, so the close
  // is REQUIRED here too), and the SDK's exit listener classifies it as
  // "aborted by user" because the spawn signal is aborted. The history
  // forces the cold-start path, whose abort controller is the one cancel()
  // actually aborts — mirroring ESC on a stalled turn.
  it('settles the active turn when cancel() aborts a hanging CLI (forced close still fires)', async () => {
    const fakeCli = writeHangingCli();
    const service = buildService(fakeCli.path);
    const prepared = service.prepareTurn({ turnId: `abort-turn-${Date.now()}`, text: 'run the task' });
    const history: ChatMessage[] = [
      { id: 'h1', role: 'user', content: 'earlier task', timestamp: 1 },
      { id: 'h2', role: 'assistant', content: 'earlier answer', timestamp: 2 },
    ];
    const iterator = service.query(prepared, history)[Symbol.asyncIterator]();

    // First chunk arrives while the CLI is alive and hanging mid-turn.
    const first = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('__DEADLINE__')), 8000)),
    ]);
    expect((first.value as { type: string }).type).toBe('text');

    // cancel() aborts the turn controller -> SIGTERM -> the CLI dies with
    // signal.aborted set, so the SDK's exit listener records "aborted by
    // user" as the exitError; the forced stdout close still fires (the
    // killed CLI's sleep child holds the pipe) and surfaces that error.
    service.cancel();

    const chunks: string[] = [];
    const deadline = Date.now() + 8000;
    let terminated = false;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('__DEADLINE__')), remaining)),
      ]).catch((e: Error) => {
        chunks.push(`throw:${e.message}`);
        return { done: true, value: undefined } as IteratorResult<StreamChunk>;
      });
      if (next.done) { terminated = true; break; }
      const value = next.value as { type: string; content?: string };
      chunks.push(value.type === 'error' ? `error:${value.content}` : value.type);
    }
    expect(terminated).toBe(true);
    expect(chunks).toContainEqual(expect.stringContaining('error:'));
    service.cleanup();
  });
});

