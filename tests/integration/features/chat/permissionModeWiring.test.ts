/**
 * Integration coverage for the #1482 Claude permission-mode port: the host→SDK
 * wiring across storage migration, coordinator projection, request building,
 * dynamic setter behavior, native write-back, and the feature-layer Tab
 * settings owner. The SDK is the shared jest mock; scripted inputs declare
 * their own verdicts and are never derived from the production forward
 * mapping (design §9.2 mock-realism boundary).
 *
 * This suite proves adapter wiring only — not the real SDK classifier, rules
 * precedence, Auto availability, or any organization policy.
 */
import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type ClaudianPlugin from '@/main';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { QueryOptionsBuilder } from '@/providers/claude/runtime/ClaudeQueryOptionsBuilder';

const sdkMock = sdkModule as unknown as {
  setMockMessages: (messages: any[], options?: { appendResult?: boolean }) => void;
  resetMockMessages: () => void;
  getQueryCallCount: () => number;
  getLastOptions: () => sdkModule.Options | undefined;
  getLastResponse: () => any;
};

function createMockAdapter() {
  return {
    exists: jest.fn().mockResolvedValue(false),
    read: jest.fn().mockResolvedValue('{}'),
    write: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<VaultFileAdapter>;
}

function createMockPlugin(overrides: Record<string, unknown> = {}) {
  return {
    app: { vault: { adapter: { basePath: '/test/vault' } } },
    storage: {
      addDenyRule: jest.fn().mockResolvedValue(undefined),
      addAllowRule: jest.fn().mockResolvedValue(undefined),
      getPermissions: jest.fn().mockResolvedValue({ allow: [], deny: [], ask: [] }),
    },
    settings: {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      ...overrides,
    },
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/mock/claude'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    pluginManager: { getPluginsKey: jest.fn().mockReturnValue('') },
  } as unknown as ClaudianPlugin;
}

function createMockMcpManager() {
  return {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getActiveServers: jest.fn().mockReturnValue({}),
    getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    extractMentions: jest.fn().mockReturnValue(new Set<string>()),
    transformMentions: jest.fn().mockImplementation((text: string) => text),
  } as any;
}

function createOptionsContext(permissionMode: string) {
  return {
    vaultPath: '/test/vault',
    cliPath: '/mock/claude',
    settings: {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      permissionMode,
    } as typeof DEFAULT_CLAUDIAN_SETTINGS,
    customEnv: {},
    enhancedPath: '/usr/bin:/mock/bin',
    mcpManager: createMockMcpManager(),
    pluginManager: { getPluginsKey: jest.fn().mockReturnValue('') } as any,
  };
}

function installPersistentQuerySeam(service: ClaudianService) {
  const persistentQuery = {
    interrupt: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
    setMaxThinkingTokens: jest.fn().mockResolvedValue(undefined),
    setPermissionMode: jest.fn().mockResolvedValue(undefined),
    applyFlagSettings: jest.fn().mockResolvedValue(undefined),
    setMcpServers: jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
    close: jest.fn(),
  };
  (service as any).persistentQuery = persistentQuery;
  (service as any).vaultPath = '/test/vault';
  (service as any).currentConfig = (service as any).buildPersistentQueryConfig(
    '/test/vault',
    '/mock/claude',
    [],
  );
  return persistentQuery;
}

describe('permission mode wiring (host-to-SDK contract)', () => {
  describe('request building (T01)', () => {
    it.each([
      ['auto', 'auto'],
      ['manual', 'default'],
      ['acceptEdits', 'acceptEdits'],
      ['yolo', 'bypassPermissions'],
      ['plan', 'plan'],
    ])('maps the %s durable/plan value onto %s with callback retained', (appMode, sdkMode) => {
      const canUseTool = jest.fn();
      const ctx = {
        ...createOptionsContext(appMode),
        abortController: new AbortController(),
        hooks: {},
        canUseTool,
      };

      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.permissionMode).toBe(sdkMode);
      // Every mode registers canUseTool and the bypass capability flag (§5.1).
      expect(options.canUseTool).toBe(canUseTool);
      expect(options.allowDangerouslySkipPermissions).toBe(true);
      expect(options.extraArgs).toEqual({ 'enable-auto-mode': null });
    });

    it('does not derive the request from a retired safeMode field', () => {
      const ctx = {
        ...createOptionsContext('manual'),
        settings: {
          ...DEFAULT_CLAUDIAN_SETTINGS,
          permissionMode: 'manual',
          providerConfigs: {
            claude: { safeMode: 'auto' },
          } as typeof DEFAULT_CLAUDIAN_SETTINGS.providerConfigs,
        } as typeof DEFAULT_CLAUDIAN_SETTINGS,
        abortController: new AbortController(),
        hooks: {},
      };

      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.permissionMode).toBe('default');
      expect(options.extraArgs).toEqual({ 'enable-auto-mode': null });
    });
  });

  describe('four-mode rotation stays a live setter (T08)', () => {
    it('rotates modes on one query with setter calls and no restart', async () => {
      const plugin = createMockPlugin({ permissionMode: 'yolo' });
      const service = new ClaudianService(plugin, createMockMcpManager());
      const persistentQuery = installPersistentQuerySeam(service);
      const startSpy = jest.spyOn(service as any, 'startPersistentQuery');
      const queriesBefore = sdkMock.getQueryCallCount();

      for (const mode of ['manual', 'auto', 'acceptEdits', 'yolo', 'manual']) {
        plugin.settings.permissionMode = mode;
        await (service as any).applyDynamicUpdates({});
      }

      expect(persistentQuery.setPermissionMode).toHaveBeenNthCalledWith(1, 'default');
      expect(persistentQuery.setPermissionMode).toHaveBeenNthCalledWith(2, 'auto');
      expect(persistentQuery.setPermissionMode).toHaveBeenNthCalledWith(3, 'acceptEdits');
      expect(persistentQuery.setPermissionMode).toHaveBeenNthCalledWith(4, 'bypassPermissions');
      expect(persistentQuery.setPermissionMode).toHaveBeenNthCalledWith(5, 'default');
      // One query for the whole rotation, no restarts.
      expect(sdkMock.getQueryCallCount()).toBe(queriesBefore);
      expect(startSpy).not.toHaveBeenCalled();
      expect((service as any).currentConfig.permissionMode).toBe('manual');
      expect((service as any).currentConfig.sdkPermissionMode).toBe('default');
    });

    it('does not repeat the setter for a same-value selection', async () => {
      const plugin = createMockPlugin({ permissionMode: 'manual' });
      const service = new ClaudianService(plugin, createMockMcpManager());
      const persistentQuery = installPersistentQuerySeam(service);

      await (service as any).applyDynamicUpdates({});

      expect(persistentQuery.setPermissionMode).not.toHaveBeenCalled();
    });
  });

  describe('permission setter failure aborts the send (T09)', () => {
    it('surfaces an error and keeps the config on the last known SDK mode', async () => {
      const plugin = createMockPlugin({ permissionMode: 'yolo' });
      const service = new ClaudianService(plugin, createMockMcpManager());
      const persistentQuery = installPersistentQuerySeam(service);
      plugin.settings.permissionMode = 'manual';
      persistentQuery.setPermissionMode.mockRejectedValue(new Error('Auto not supported'));

      await expect((service as any).applyDynamicUpdates({})).rejects.toThrow('Auto not supported');

      // currentConfig keeps the previous (bypass) mode — no fake manual write.
      expect((service as any).currentConfig.permissionMode).toBe('yolo');
      expect((service as any).currentConfig.sdkPermissionMode).toBe('bypassPermissions');
    });

    it('the send path yields an error chunk instead of enqueueing', async () => {
      const plugin = createMockPlugin({ permissionMode: 'yolo' });
      const service = new ClaudianService(plugin, createMockMcpManager());
      const persistentQuery = installPersistentQuerySeam(service);
      // Message channel present so queryViaPersistent is the chosen path.
      (service as any).messageChannel = (service as any).messageChannel
        ?? { enqueue: jest.fn().mockReturnValue({ dropped: false, canonicalTurnId: 't' }) };
      const channelEnqueueSpy = (service as any).messageChannel.enqueue as jest.Mock;
      plugin.settings.permissionMode = 'manual';
      persistentQuery.setPermissionMode.mockRejectedValue(new Error('setter rejected'));

      const gen = (service as any).queryViaPersistent('hi', undefined, '/test/vault', '/mock/claude', {}, {
        id: 'turn-fail',
        kind: 'user',
      } as never);
      const chunks: any[] = [];
      for await (const chunk of gen) chunks.push(chunk);

      expect(chunks.some(chunk => chunk.type === 'error')).toBe(true);
      expect(channelEnqueueSpy).not.toHaveBeenCalled();
    });
  });

  describe('native write-back through the same settings owner (T10)', () => {
    it.each([
      ['default', 'manual'],
      ['auto', 'auto'],
      ['acceptEdits', 'acceptEdits'],
      ['bypassPermissions', 'yolo'],
      ['plan', 'plan'],
    ])('normalizes the observed SDK mode %s to %s and updates the config', (sdkMode, appMode) => {
      const plugin = createMockPlugin({ permissionMode: 'acceptEdits' });
      const service = new ClaudianService(plugin, createMockMcpManager());
      installPersistentQuerySeam(service);
      const observed: string[] = [];
      service.setPermissionModeSyncCallback(mode => observed.push(mode));

      (service as any).syncNativePermissionMode(sdkMode, null);

      expect(observed).toEqual([appMode]);
      expect((service as any).currentConfig.permissionMode).toBe(appMode);
    });

    it('ignores native modes outside the toolbar policy', () => {
      const plugin = createMockPlugin({ permissionMode: 'acceptEdits' });
      const service = new ClaudianService(plugin, createMockMcpManager());
      installPersistentQuerySeam(service);
      const observed: string[] = [];
      service.setPermissionModeSyncCallback(mode => observed.push(mode));

      (service as any).syncNativePermissionMode('dontAsk', null);
      (service as any).syncNativePermissionMode(undefined, null);

      expect(observed).toEqual([]);
      expect((service as any).currentConfig.permissionMode).toBe('acceptEdits');
    });

    it('feeds the init path through the same scope-guarded helper', () => {
      const plugin = createMockPlugin({ permissionMode: 'acceptEdits' });
      const service = new ClaudianService(plugin, createMockMcpManager());
      installPersistentQuerySeam(service);
      const observed: string[] = [];
      service.setPermissionModeSyncCallback(mode => observed.push(mode));

      (service as any).applySessionInitSideEffects(
        { type: 'session_init', sessionId: 's1', permissionMode: 'bypassPermissions' },
        null,
      );

      expect(observed).toEqual(['yolo']);
    });
  });

  describe('provider ownership and cross-provider isolation', () => {
    it('a Codex-owned top level never becomes the Claude choice (T12 provider isolation)', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        providerConfigs: { codex: { enabled: true } },
        permissionMode: 'yolo',
        savedProviderPermissionMode: {},
      };

      const claudeSnapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'claude');
      const codexSnapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'codex');

      expect(claudeSnapshot.permissionMode).toBe('auto');
      expect(codexSnapshot.permissionMode).toBe('yolo');
      expect(settings.permissionMode).toBe('yolo');
    });

    it('keeps saved four-mode values per provider without cross-contamination', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'codex',
        permissionMode: 'normal',
        providerConfigs: { codex: { enabled: true } },
        savedProviderPermissionMode: { claude: 'acceptEdits', codex: 'normal' },
      };

      const claudeSnapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'claude');

      expect(claudeSnapshot.permissionMode).toBe('acceptEdits');
    });

    it('plan in the in-memory map stays plan for the runtime projection (T14 transient)', () => {
      const settings: Record<string, unknown> = {
        settingsProvider: 'claude',
        permissionMode: 'acceptEdits',
        savedProviderPermissionMode: { claude: 'plan' },
      };

      const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'claude');
      expect(snapshot.permissionMode).toBe('plan');
    });
  });

  describe('storage round-trip keeps durable values idempotent (T12/T13)', () => {
    it('load→save→load produces identical durable values', async () => {
      const adapter = createMockAdapter();
      adapter.exists.mockResolvedValue(true);
      const raw = {
        permissionMode: 'normal',
        claudeSafeMode: 'auto',
      };
      adapter.read.mockResolvedValue(JSON.stringify(raw));
      const storage = new ClaudianSettingsStorage(adapter);

      const first = await storage.load();
      const firstWrite = adapter.write.mock.calls[adapter.write.mock.calls.length - 1][1];
      expect(first.permissionMode).toBe('auto');

      adapter.read.mockResolvedValue(firstWrite);
      adapter.write.mockClear();
      adapter.exists.mockResolvedValue(true);
      const second = await storage.load();

      expect(second.permissionMode).toBe('auto');
      expect(second.savedProviderPermissionMode).toEqual(first.savedProviderPermissionMode);
      expect(adapter.write).not.toHaveBeenCalled();
    });

    it('a failed write-back keeps the legacy source file', async () => {
      const adapter = createMockAdapter();
      adapter.exists.mockImplementation(async (path: string) => (
        path === '.claude/claudian-settings.json'
      ));
      adapter.read.mockImplementation(async (path: string) => (
        path === '.claude/claudian-settings.json'
          ? JSON.stringify({ permissionMode: 'normal', claudeSafeMode: 'auto' })
          : '{}'
      ));
      adapter.write.mockRejectedValue(new Error('disk full'));
      const storage = new ClaudianSettingsStorage(adapter);

      await expect(storage.load()).rejects.toThrow('disk full');
      expect(adapter.delete).not.toHaveBeenCalledWith('.claude/claudian-settings.json');
    });
  });
});
