import '@/providers';

// eslint-disable-next-line jest/no-mocks-import
import {
  getLastOptions,
  getQueryCallCount,
  resetMockMessages,
  setMockMessages,
} from '@test/__mocks__/claude-agent-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { runColdStartQuery } from '@/providers/claude/runtime/claudeColdStartQuery';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
import { POLICY_VERSION } from '@/providers/claude/types/nativeMcpCutover';

/**
 * Native MCP cutover gate — integration over the real production chain
 * (design 2026-11-09-provider-native-mcp-alignment §4.2/§5.1, acceptance
 * matrix "入口×机制" Claude rows).
 *
 * Isolation contract: every fixture is a hand-crafted file inside a jest
 * temp directory. No real CLI is executed (the SDK mock counts spawns),
 * zero server/network/LLM calls, and the real vault's .claude/mcp.json is
 * never touched — the temp vault root replaces it via the app adapter path.
 */

const LEGACY_MCP_BYTES = JSON.stringify({
  mcpServers: { 'test-server': { command: 'test' } },
  _claudian: { servers: [] },
}, null, 2);

function makeTempVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-cutover-'));
}

function writeLegacyMcp(vaultRoot: string, bytes = LEGACY_MCP_BYTES): string {
  const dir = path.join(vaultRoot, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const legacyPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(legacyPath, bytes, 'utf8');
  return legacyPath;
}

function createMockPlugin(vaultRoot: string, settings: Record<string, unknown> = {}) {
  const savedSettings: Record<string, unknown> = {
    permissionMode: 'yolo',
    loadUserClaudeSettings: false,
    mediaFolder: '',
    systemPrompt: '',
    model: 'claude-sonnet-4-5',
    thinkingBudget: 'off',
    ...settings,
  };
  return {
    settings: savedSettings,
    app: {
      vault: {
        adapter: {
          basePath: vaultRoot,
        },
      },
    },
    conversations: [] as Array<{ id: string; enabledMcpServers?: string[] }>,
    hasLoadedLegacyMcpMetadata(): boolean {
      return (this.conversations as Array<{ enabledMcpServers?: string[] }>)
        .some(c => (c.enabledMcpServers?.length ?? 0) > 0);
    },
    saveSettings: jest.fn().mockImplementation(async () => {
      // No-op: settings persist in the in-memory object.
    }),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/mock/claude'),
    getView: jest.fn().mockReturnValue(null),
    pluginManager: {
      getPluginsKey: jest.fn().mockReturnValue(''),
      hasEnabledPlugins: jest.fn().mockReturnValue(false),
    },
  } as any;
}

function createService(plugin: any): ClaudianService {
  return new ClaudianService(plugin, {
    pluginManager: plugin.pluginManager,
    agentManager: (plugin as unknown as { agentManager?: unknown }).agentManager as never,
  });
}

function seedHappyPathMessages() {
  setMockMessages([
    { type: 'system', subtype: 'init', session_id: 'cutover-session' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
    { type: 'result', subtype: 'success', session_id: 'cutover-session' },
  ]);
}

describe('Native MCP cutover gate (production launch chain)', () => {
  let vaultRoot: string;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockMessages();
    vaultRoot = makeTempVault();
  });

  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('matrix[new-install]: no legacy traces → first send spawns exactly once, no ack written', async () => {
    const plugin = createMockPlugin(vaultRoot);
    const service = createService(plugin);
    seedHappyPathMessages();

    const chunks: any[] = [];
    for await (const chunk of service.query('hello')) chunks.push(chunk);

    expect(getQueryCallCount()).toBe(1);
    expect(
      getClaudeProviderSettings(plugin.settings as unknown as Record<string, unknown>)
        .nativeMcpCutover,
    ).toBeUndefined();
  });

  it('matrix[old-install cold start]: legacy file present → spawn=0, visible cutover error, file bytes untouched', async () => {
    const legacyPath = writeLegacyMcp(vaultRoot);
    const bytesBefore = fs.readFileSync(legacyPath, 'utf8');
    const plugin = createMockPlugin(vaultRoot);
    const service = createService(plugin);
    seedHappyPathMessages();

    const chunks: any[] = [];
    for await (const chunk of service.query('hello')) chunks.push(chunk);

    expect(getQueryCallCount()).toBe(0);
    const errorChunk = chunks.find(c => c.type === 'error');
    expect(errorChunk).toBeDefined();
    expect(errorChunk?.content).toContain('native MCP');
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(bytesBefore);
  });

  it('matrix[loaded legacy metadata]: conversation metadata with enabledMcpServers blocks the launch', async () => {
    const plugin = createMockPlugin(vaultRoot);
    plugin.conversations.push({ id: 'conv-1', enabledMcpServers: ['legacy-server'] });
    const service = createService(plugin);
    seedHappyPathMessages();

    const chunks: any[] = [];
    for await (const chunk of service.query('hello')) chunks.push(chunk);

    expect(getQueryCallCount()).toBe(0);
    expect(chunks.some(c => c.type === 'error')).toBe(true);
  });

  it('matrix[resume/fork/auto-continuation]: a session restore goes through the same gate (spawn=0 until confirmed)', async () => {
    writeLegacyMcp(vaultRoot);
    const plugin = createMockPlugin(vaultRoot);
    const service = createService(plugin);
    service.setSessionId('resumed-session');
    seedHappyPathMessages();

    const chunks: any[] = [];
    for await (const chunk of service.query('hello', [], [{ role: 'user', content: 'hi', timestamp: 1 } as any], { model: 'claude-sonnet-4-5' })) chunks.push(chunk);

    expect(getQueryCallCount()).toBe(0);
    expect(chunks.some(c => c.type === 'error')).toBe(true);
  });

  it('matrix[settings confirm]: confirming through the settings channel persists a valid ack and unblocks the launch', async () => {
    writeLegacyMcp(vaultRoot);
    const plugin = createMockPlugin(vaultRoot);
    const service = createService(plugin);

    const { createClaudeNativeMcpCutoverService, resolveClaudeLaunchScopeInput } = await import(
      '@/providers/claude/app/ClaudeNativeMcpCutover'
    );
    const cutover = createClaudeNativeMcpCutoverService(plugin);
    const scope = resolveClaudeLaunchScopeInput(plugin, vaultRoot, '/mock/claude', ['project', 'local']);

    // Confirmation itself must not spawn the CLI.
    const confirmed = await cutover.confirmCutover(scope);
    expect(confirmed.ok).toBe(true);
    expect(getQueryCallCount()).toBe(0);

    const record = getClaudeProviderSettings(plugin.settings as unknown as Record<string, unknown>)
      .nativeMcpCutover;
    expect(record?.policyVersion).toBe(POLICY_VERSION);
    expect(record?.decision).toBe('native-config-reviewed');

    seedHappyPathMessages();
    const chunks: any[] = [];
    for await (const chunk of service.query('hello')) chunks.push(chunk);
    expect(getQueryCallCount()).toBe(1);
    expect(chunks.some(c => c.type === 'error')).toBe(false);
  });

  it('matrix[ack write failure]: a failed settings write keeps the launch blocked (no in-memory pass)', async () => {
    writeLegacyMcp(vaultRoot);
    const plugin = createMockPlugin(vaultRoot);
    plugin.saveSettings = jest.fn().mockRejectedValue(new Error('disk full'));
    const service = createService(plugin);

    const { createClaudeNativeMcpCutoverService, resolveClaudeLaunchScopeInput } = await import(
      '@/providers/claude/app/ClaudeNativeMcpCutover'
    );
    const cutover = createClaudeNativeMcpCutoverService(plugin);
    const scope = resolveClaudeLaunchScopeInput(plugin, vaultRoot, '/mock/claude', ['project', 'local']);

    const confirmed = await cutover.confirmCutover(scope);
    expect(confirmed.ok).toBe(false);

    seedHappyPathMessages();
    const chunks: any[] = [];
    for await (const chunk of service.query('hello')) chunks.push(chunk);
    expect(getQueryCallCount()).toBe(0);
    expect(chunks.some(c => c.type === 'error')).toBe(true);
  });

  it('matrix[directory/scope change]: a confirmation does not carry over to another cwd scope', async () => {
    const vaultA = vaultRoot;
    const vaultB = makeTempVault();
    try {
      writeLegacyMcp(vaultA);
      writeLegacyMcp(vaultB);
      const plugin = createMockPlugin(vaultA);
      const service = createService(plugin);

      const { createClaudeNativeMcpCutoverService, resolveClaudeLaunchScopeInput } = await import(
        '@/providers/claude/app/ClaudeNativeMcpCutover'
      );
      const cutover = createClaudeNativeMcpCutoverService(plugin);
      const scopeA = resolveClaudeLaunchScopeInput(plugin, vaultA, '/mock/claude', ['project', 'local']);
      expect((await cutover.confirmCutover(scopeA)).ok).toBe(true);

      // Switch the plugin's vault root to scope B: the recorded ack must not
      // admit launches for the new scope.
      plugin.app.vault.adapter.basePath = vaultB;
      seedHappyPathMessages();
      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) chunks.push(chunk);
      expect(getQueryCallCount()).toBe(0);
      expect(chunks.some(c => c.type === 'error')).toBe(true);
    } finally {
      fs.rmSync(vaultB, { recursive: true, force: true });
    }
  });

  it('matrix[inline/title/refine aux]: the cold-start helper shares the same gate', async () => {
    writeLegacyMcp(vaultRoot);
    const plugin = createMockPlugin(vaultRoot);
    seedHappyPathMessages();

    await expect(runColdStartQuery(
      {
        plugin,
        systemPrompt: '',
        thinking: { disabled: true },
        persistSession: false,
      },
      'summarize',
    )).rejects.toThrow(/native MCP/);

    expect(getQueryCallCount()).toBe(0);
  });

  it('matrix[aux new scope]: the cold-start helper launches when no legacy traces exist', async () => {
    const plugin = createMockPlugin(vaultRoot);
    seedHappyPathMessages();

    const result = await runColdStartQuery(
      {
        plugin,
        systemPrompt: '',
        thinking: { disabled: true },
        persistSession: false,
      },
      'summarize',
    );

    expect(getQueryCallCount()).toBe(1);
    expect(result.text).toBe('Hello');
  });

  it('matrix[persistent next turns]: after a confirmed launch, subsequent sends reuse the running query (one spawn)', async () => {
    const plugin = createMockPlugin(vaultRoot);
    const service = createService(plugin);
    seedHappyPathMessages();

    for (let i = 0; i < 3; i++) {
      const chunks: any[] = [];
       
      for await (const chunk of service.query(`turn-${i}`)) chunks.push(chunk);
      expect(chunks.some(c => c.type === 'error')).toBe(false);
    }

    expect(getQueryCallCount()).toBe(1);
    void getLastOptions;
  });
});
