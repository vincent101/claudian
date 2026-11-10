import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as RealSdk from '@anthropic-ai/claude-agent-sdk';

const nativeRequire = createRequire(__filename);
const mockRealSdk: typeof RealSdk = nativeRequire(
  path.join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
);
jest.mock('@anthropic-ai/claude-agent-sdk', () => mockRealSdk);

import '@/providers';

import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import * as customSpawn from '@/providers/claude/runtime/customSpawn';

type RecordMessage = Record<string, unknown>;
type Trace = { event: string; subtype?: string; uuid?: string; request_id?: string; message?: RecordMessage; pid?: number; callback_id?: string | null; response?: RecordMessage };

const fixtureDir = path.join(__dirname, 'fixtures');
const fakeCli = path.join(fixtureDir, 'a3-fake-cli.sh');
const peer = path.join(fixtureDir, 'a3-peer.cjs');
const vault = process.env.TEST_VAULT || os.tmpdir();
const fields = ['user_message_uuid', 'user_message_uuids', 'result_index', 'queued_turn_count', 'run_id', 'level'] as const;

// Independent synthetic expectations: no claim these fields are sent by a CLI.
const expected: Record<string, RecordMessage> = {
  'a3-success': { user_message_uuid: 'H', user_message_uuids: ['H'], result_index: 0, queued_turn_count: 1 },
  'a3-batch': { user_message_uuid: 'H', user_message_uuids: ['H', 'N'], result_index: 1, queued_turn_count: 0 },
  'a3-absent': {},
  'a3-conflict': { user_message_uuid: 'H', user_message_uuids: ['N'], result_index: 2, queued_turn_count: 3 },
  'a3-invalid': { user_message_uuid: null, user_message_uuids: 'bad', result_index: 'bad', queued_turn_count: null },
  'a3-empty': { user_message_uuid: 42, user_message_uuids: [], result_index: -1, queued_turn_count: 'bad' },
  'a3-execution-error': { user_message_uuid: 'H', user_message_uuids: ['H'] },
  'a3-delivery-failure': { user_message_uuid: 'H' },
  'a3-zeroed-error': {},
  'a3-task': { run_id: 'run-synthetic', level: 'ambient' },
};
const ids = Object.keys(expected);
const sdkInput = { uuid: '11111111-1111-4111-8111-111111111111', text: 'synthetic SDK input\nsecond line' } as const;
const runtimeInput = { uuid: '22222222-2222-4222-8222-222222222222', text: 'synthetic runtime input\nsecond line' } as const;

function checkUser(trace: Trace[], input: { uuid: string; text: string }) {
  const users = trace.filter((event) => event.event === 'user');
  expect(users).toHaveLength(1);
  expect(users[0].uuid).toBe(input.uuid);
  expect(users[0].message).toEqual({ role: 'user', content: input.text });
}

function checkFields(messages: RecordMessage[]) {
  expect(messages.map((message) => message.uuid)).toEqual(ids);
  for (const message of messages) {
    const want = expected[message.uuid as string];
    for (const field of fields) {
      expect(Object.prototype.hasOwnProperty.call(message, field)).toBe(Object.prototype.hasOwnProperty.call(want, field));
      if (Object.prototype.hasOwnProperty.call(want, field)) expect(message[field]).toEqual(want[field]);
    }
  }
  expect(messages.find((m) => m.uuid === 'a3-execution-error')?.errors).toEqual(['synthetic execution error']);
  const deliveryFailure = messages.find((m) => m.uuid === 'a3-delivery-failure');
  expect(deliveryFailure?.subtype).toBe('error_during_execution');
  expect(deliveryFailure?.errors).toEqual(['synthetic delivery failure']);
}

function readTrace(file: string): Trace[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Trace);
}
function samplesFromTrace(trace: Trace[]): RecordMessage[] {
  return trace.filter((event) => event.event === 'wire' && ids.includes(event.message?.uuid as string)).map((event) => event.message!);
}
async function deadline<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('A3 deadline')), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('A3 wait deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function envFor(trace: string): NodeJS.ProcessEnv {
  return { ...process.env, A3_TRACE: trace, A3_BIN: process.execPath, A3_PEER: peer };
}
function buildService() {
  const plugin = {
    app: { vault: { adapter: { basePath: vault } } },
    storage: { addDenyRule: jest.fn(), addAllowRule: jest.fn(), getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }) },
    settings: { model: 'claude-sonnet', permissionMode: 'ask', thinkingBudget: 0, mediaFolder: 'media', systemPrompt: '', loadUserClaudeSettings: false, claudeCliPath: fakeCli, claudeCliPaths: [], enableAutoTitleGeneration: false },
    getResolvedProviderCliPath: jest.fn().mockReturnValue(fakeCli),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    pluginManager: { getPluginsKey: jest.fn().mockReturnValue('') },
  };
  const mcp = { loadServers: jest.fn().mockResolvedValue(undefined), getAllDisallowedMcpTools: jest.fn().mockReturnValue([]), getActiveServers: jest.fn().mockReturnValue({}), getDisallowedMcpTools: jest.fn().mockReturnValue([]), extractMentions: jest.fn().mockReturnValue(new Set()), transformMentions: jest.fn((text: string) => text) };
  return new ClaudianService(plugin as never, mcp as never);
}

function checkTrace(trace: Trace[]) {
  expect(trace.filter((e) => e.event === 'start')).toHaveLength(1);
  expect(trace.filter((e) => e.event === 'control' && e.subtype === 'initialize')).toHaveLength(1);
  expect(trace.filter((e) => e.event === 'user')).toHaveLength(1);
  expect(trace.filter((e) => e.event === 'unknown-control' || e.event === 'unknown-message' || e.event === 'invalid-json')).toEqual([]);
  checkFields(samplesFromTrace(trace));
}

describe('synthetic installed SDK field bridge', () => {
  jest.setTimeout(20000);
  afterEach(() => { jest.restoreAllMocks(); });

  it('preserves synthetic wire fields and absence through the real SDK query', async () => {
    expect(fs.realpathSync(path.join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'))).toBe(path.join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
    expect(jest.isMockFunction(mockRealSdk.query)).toBe(false);
    const traceFile = path.join(process.env.TMPDIR!, 'a3-sdk-trace.jsonl');
    fs.rmSync(traceFile, { force: true });
    let exited = false;
    const spawn = customSpawn.createCustomSpawnFunction(process.env.PATH!, () => { exited = true; });
    async function* prompt() {
      yield { type: 'user' as const, uuid: sdkInput.uuid, session_id: '', parent_tool_use_id: null, message: { role: 'user' as const, content: process.env.A3_BAD_SDK_TEXT ? '' : sdkInput.text } };
    }
    const query = mockRealSdk.query({ prompt: prompt(), options: { cwd: vault, pathToClaudeCodeExecutable: fakeCli, spawnClaudeCodeProcess: spawn, env: envFor(traceFile), settingSources: [] } });
    const yielded: RecordMessage[] = [];
    const consumer = (async () => { for await (const message of query) if (ids.includes((message as RecordMessage).uuid as string)) yielded.push(message as RecordMessage); })();
    try {
      const initialized = await deadline(query.initializationResult());
      expect(initialized.commands.map((command) => command.name)).toContain('a3-init-canary');
      await deadline(consumer);
      const trace = readTrace(traceFile);
      checkTrace(trace);
      checkUser(trace, sdkInput);
      // The negative control mutates only the observational mirror, never the SDK or peer.
      const mirror = yielded.map((message) => {
        const copy = { ...message };
        if (process.env.A3_DROP_MIRROR && copy.uuid === 'a3-success') delete copy.user_message_uuids;
        return copy;
      });
      checkFields(mirror);
      expect(mirror).toEqual(samplesFromTrace(trace));
    } finally {
      query.close();
      await deadline(consumer.catch(() => undefined));
      await waitFor(() => exited);
    }
  });

  it('passes synthetic SDK messages into the persistent production route', async () => {
    const traceFile = path.join(process.env.TMPDIR!, 'a3-runtime-trace.jsonl');
    fs.rmSync(traceFile, { force: true });
    const old = { A3_TRACE: process.env.A3_TRACE, A3_BIN: process.env.A3_BIN, A3_PEER: process.env.A3_PEER };
    Object.assign(process.env, { A3_TRACE: traceFile, A3_BIN: process.execPath, A3_PEER: peer });
    const exits: Array<number | null> = [];
    const originalSpawn = customSpawn.createCustomSpawnFunction;
    jest.spyOn(customSpawn, 'createCustomSpawnFunction').mockImplementation((enhancedPath, onExit) => originalSpawn(enhancedPath, (code) => { exits.push(code); onExit?.(code); }));
    const service = buildService();
    const route = jest.spyOn(service as any, 'routeMessage');
    let consumer: Promise<unknown> | undefined;
    try {
      expect(await service.ensureReady()).toBe(true);
      const query = (service as any).persistentQuery as ReturnType<typeof mockRealSdk.query>;
      expect(query).toBeDefined();
      expect((await deadline(query.initializationResult())).commands.map((command) => command.name)).toContain('a3-init-canary');
      const prepared = service.prepareTurn({ turnId: 'a3-turn', text: process.env.A3_BAD_RUNTIME_TEXT ? 'incorrect synthetic input' : runtimeInput.text });
      // Only fix the factory's next generated UUID; the production message path remains intact.
      const nodeCrypto = nativeRequire('crypto') as { randomUUID: () => `${string}-${string}-${string}-${string}-${string}` };
      const uuid = jest.spyOn(nodeCrypto, 'randomUUID').mockReturnValueOnce(runtimeInput.uuid);
      consumer = (async () => { for await (const chunk of service.query(prepared)) { void chunk; } })();
      await waitFor(() => route.mock.calls.filter((call) => ids.includes((call[0] as RecordMessage).uuid as string)).length === ids.length);
      await deadline(consumer);
      await waitFor(() => readTrace(traceFile).some((event) => event.event === 'control-response' && event.request_id === 'a3-hook-request'));
      const trace = readTrace(traceFile);
      checkTrace(trace);
      expect(uuid).toHaveBeenCalledTimes(1);
      checkUser(trace, runtimeInput);
      expect(trace.find((event) => event.event === 'stop-registration')?.callback_id).toEqual(expect.any(String));
      expect(trace.find((event) => event.event === 'control-response' && event.request_id === 'a3-hook-request')?.response).toEqual({ subtype: 'success', request_id: 'a3-hook-request', response: {} });
      const routed = route.mock.calls.map((call) => call[0] as RecordMessage).filter((message) => ids.includes(message.uuid as string));
      checkFields(routed);
      expect(routed).toEqual(samplesFromTrace(trace));
    } finally {
      service.cleanup();
      if (consumer) await deadline(consumer.catch(() => undefined));
      await waitFor(() => exits.length >= 1 && exits.length >= readTrace(traceFile).filter((event) => event.event === 'start').length);
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      expect(exits).toHaveLength(1);
    }
  });
});
