import '@/providers';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
import {
  CLAUDIAN_SETTINGS_PATH,
  ClaudianSettingsStorage,
  LEGACY_CLAUDIAN_SETTINGS_PATH,
} from '@/providers/claude/storage/ClaudianSettingsStorage';
import { DEFAULT_SETTINGS } from '@/providers/claude/types/settings';
import { getCodexProviderSettings } from '@/providers/codex/settings';

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'host-a',
}));

const mockAdapter = {
  exists: jest.fn(),
  read: jest.fn(),
  write: jest.fn(),
  delete: jest.fn(),
} as unknown as jest.Mocked<VaultFileAdapter>;

describe('ClaudianSettingsStorage', () => {
  let storage: ClaudianSettingsStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations to default resolved values
    mockAdapter.exists.mockResolvedValue(false);
    mockAdapter.read.mockResolvedValue('{}');
    mockAdapter.write.mockResolvedValue(undefined);
    mockAdapter.delete.mockResolvedValue(undefined);
    storage = new ClaudianSettingsStorage(mockAdapter);
  });

  describe('load', () => {
    it('should return defaults when file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.load();

      expect(result.model).toBe(DEFAULT_SETTINGS.model);
      expect(result.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget);
      expect(result.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
      expect(mockAdapter.read).not.toHaveBeenCalled();
    });

    it('loads legacy .claude settings and migrates them to .claudian', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === LEGACY_CLAUDIAN_SETTINGS_PATH
      ));
      mockAdapter.read.mockImplementation(async (path: string) => {
        if (path === LEGACY_CLAUDIAN_SETTINGS_PATH) {
          return JSON.stringify({
            model: 'claude-opus-4-5',
            userName: 'MigratedUser',
          });
        }
        return '{}';
      });

      const result = await storage.load();

      expect(result.model).toBe('claude-opus-4-5');
      expect(result.userName).toBe('MigratedUser');
      expect(mockAdapter.write).toHaveBeenCalledWith(
        CLAUDIAN_SETTINGS_PATH,
        expect.any(String),
      );
      expect(mockAdapter.delete).toHaveBeenCalledWith(LEGACY_CLAUDIAN_SETTINGS_PATH);
    });

    it('should parse valid JSON and merge with defaults', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'claude-opus-4-5',
        userName: 'TestUser',
      }));

      const result = await storage.load();

      expect(result.model).toBe('claude-opus-4-5');
      expect(result.userName).toBe('TestUser');
      // Defaults should still be present for unspecified fields
      expect(result.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget);
    });

    it('migrates legacy openInMainTab true to main-tab placement', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        openInMainTab: true,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.chatViewPlacement).toBe('main-tab');
      expect(writtenContent.chatViewPlacement).toBe('main-tab');
      expect(writtenContent).not.toHaveProperty('openInMainTab');
    });

    it('migrates legacy openInMainTab false to right-sidebar placement', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        openInMainTab: false,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.chatViewPlacement).toBe('right-sidebar');
      expect(writtenContent.chatViewPlacement).toBe('right-sidebar');
      expect(writtenContent).not.toHaveProperty('openInMainTab');
    });

    it('normalizes invalid chatViewPlacement values', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        chatViewPlacement: 'floating-window',
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.chatViewPlacement).toBe('right-sidebar');
      expect(writtenContent.chatViewPlacement).toBe('right-sidebar');
    });

    it('should strip legacy blocklist fields from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        enableBlocklist: false,
        blockedCommands: {
          unix: ['custom-unix-cmd'],
          windows: ['custom-win-cmd'],
        },
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect('enableBlocklist' in result).toBe(false);
      expect('blockedCommands' in result).toBe(false);
      expect(writtenContent).not.toHaveProperty('enableBlocklist');
      expect(writtenContent).not.toHaveProperty('blockedCommands');
    });

    it('should normalize claudeCliPathsByHost from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        claudeCliPathsByHost: {
          'host-a': '/custom/path-a',
          'host-b': '/custom/path-b',
        },
      }));

      const result = await storage.load();

      expect(getClaudeProviderSettings(result).cliPathsByHost['host-a']).toBe('/custom/path-a');
      expect(getClaudeProviderSettings(result).cliPathsByHost['host-b']).toBe('/custom/path-b');
    });

    it('should preserve legacy claudeCliPath field', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        claudeCliPath: '/legacy/path',
      }));

      const result = await storage.load();

      expect(getClaudeProviderSettings(result).cliPath).toBe('/legacy/path');
    });

    it('should normalize codexCliPathsByHost from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        codexCliPathsByHost: {
          'host-a': '/custom/codex-a',
          'host-b': '/custom/codex-b',
        },
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).cliPathsByHost['host-a']).toBe('/custom/codex-a');
      expect(getCodexProviderSettings(result).cliPathsByHost['host-b']).toBe('/custom/codex-b');
    });

    it('should preserve legacy codexCliPath field', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        codexCliPath: '/legacy/codex',
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).cliPath).toBe('/legacy/codex');
    });

    it('defaults Codex installation method and WSL distro override when missing', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({}));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).installationMethod).toBe('native-windows');
      expect(getCodexProviderSettings(result).wslDistroOverride).toBe('');
    });

    it('normalizes invalid Codex installation fields from provider config', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          codex: {
            installationMethod: 'auto',
            wslDistroOverride: 42,
          },
        },
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).installationMethod).toBe('native-windows');
      expect(getCodexProviderSettings(result).wslDistroOverride).toBe('');
    });

    it('does not inherit another host WSL selection from host-scoped provider config', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        providerConfigs: {
          codex: {
            installationMethodsByHost: {
              'host-b': 'wsl',
            },
            wslDistroOverridesByHost: {
              'host-b': 'Ubuntu',
            },
          },
        },
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).installationMethod).toBe('native-windows');
      expect(getCodexProviderSettings(result).wslDistroOverride).toBe('');
    });

    it('should remove legacy show1MModel from the stored file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'sonnet',
        show1MModel: true,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(getClaudeProviderSettings(result).modelPresets).toEqual(
        getClaudeProviderSettings(DEFAULT_SETTINGS).modelPresets,
      );
      expect(writtenContent.model).toBe('sonnet');
      expect(writtenContent.hiddenProviderCommands).toEqual({});
      expect(writtenContent).not.toHaveProperty('show1MModel');
    });

    it('should remove legacy slashCommands from the stored file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'sonnet',
        slashCommands: [{ id: 'cmd-review', name: 'review', content: 'Review' }],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect('slashCommands' in result).toBe(false);
      expect(writtenContent.model).toBe('sonnet');
      expect(writtenContent.hiddenProviderCommands).toEqual({});
      expect(writtenContent).not.toHaveProperty('slashCommands');
    });

    it('should migrate legacy hiddenSlashCommands into Claude hiddenProviderCommands', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        hiddenSlashCommands: ['commit', '/review'],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.hiddenProviderCommands).toEqual({
        claude: ['commit', 'review'],
      });
      expect(writtenContent.hiddenProviderCommands).toEqual({
        claude: ['commit', 'review'],
      });
    });

    it('should not override explicit provider hidden commands with legacy hiddenSlashCommands', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        hiddenProviderCommands: {
          claude: ['existing'],
        },
        hiddenSlashCommands: ['commit', '/review'],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.hiddenProviderCommands).toEqual({
        claude: ['existing'],
      });
      expect(writtenContent.hiddenProviderCommands).toEqual({
        claude: ['existing'],
      });
    });

    it('normalizes stale scoped mixed env snippets back to unscoped on load', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        envSnippets: [{
          id: 'snippet-1',
          name: 'Mixed snippet',
          description: '',
          envVars: 'PATH=/usr/local/bin\nANTHROPIC_MODEL=claude-custom',
          scope: 'shared',
        }],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.envSnippets).toEqual([{
        id: 'snippet-1',
        name: 'Mixed snippet',
        description: '',
        envVars: 'PATH=/usr/local/bin\nANTHROPIC_MODEL=claude-custom',
        scope: undefined,
        contextLimits: undefined,
      }]);
      expect(writtenContent.envSnippets[0].scope).toBeUndefined();
    });

    it('should throw on JSON parse error', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('invalid json');

      await expect(storage.load()).rejects.toThrow();
    });

    describe('Claude model preset migration', () => {
      it('migrates legacy toggles/customModels to modelPresets and drops the old fields on write-back', async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockResolvedValue(JSON.stringify({
          providerConfigs: {
            claude: {
              enableSonnet1M: true,
              enableOpus1M: false,
              customModels: 'claude-opus-4-6',
              lastModel: 'sonnet',
            },
          },
        }));

        const result = await storage.load();
        const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
        const claudeConfig = writtenContent.providerConfigs.claude;

        expect(getClaudeProviderSettings(result).modelPresets.map(p => p.model)).toEqual([
          'haiku', 'sonnet[1m]', 'opus', 'fable', 'claude-opus-4-6',
        ]);
        expect(claudeConfig.modelPresets.map((p: { model: string }) => p.model)).toEqual([
          'haiku', 'sonnet[1m]', 'opus', 'fable', 'claude-opus-4-6',
        ]);
        expect(claudeConfig).not.toHaveProperty('customModels');
        expect(claudeConfig).not.toHaveProperty('enableSonnet1M');
        expect(claudeConfig).not.toHaveProperty('enableOpus1M');
      });

      it('imports legacy customContextLimits into the migrated presets', async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockResolvedValue(JSON.stringify({
          customContextLimits: { 'claude-opus-4-6': 500_000 },
          providerConfigs: {
            claude: { customModels: 'claude-opus-4-6' },
          },
        }));

        const result = await storage.load();

        const byModel = new Map(
          getClaudeProviderSettings(result).modelPresets.map(p => [p.model, p]),
        );
        expect(byModel.get('claude-opus-4-6')?.contextWindow).toBe(500_000);
      });

      it('does not rewrite the file again once presets are stored', async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockResolvedValue(JSON.stringify({
          permissionMode: 'auto',
          savedProviderPermissionMode: { claude: 'auto' },
          providerConfigs: {
            claude: {
              modelPresets: [{ label: 'Haiku', model: 'haiku' }],
            },
          },
        }));

        await storage.load();

        expect(mockAdapter.write).not.toHaveBeenCalled();
      });
    });

    describe('Codex model preset migration', () => {
      it('migrates legacy customModels to modelPresets and drops the old field on write-back', async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockResolvedValue(JSON.stringify({
          providerConfigs: {
            codex: {
              customModels: 'claude-opus\nclaude-sonnet\nclaude-haiku',
            },
          },
        }));

        const result = await storage.load();
        const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
        const codexConfig = writtenContent.providerConfigs.codex;

        expect(getCodexProviderSettings(result).modelPresets.map(p => p.model)).toEqual([
          'gpt-5.4-mini', 'gpt-5.5', 'claude-opus', 'claude-sonnet', 'claude-haiku',
        ]);
        expect(getCodexProviderSettings(result).modelPresets.map(p => p.label)).toEqual([
          'GPT-5.4 Mini', 'GPT-5.5', 'claude-opus', 'claude-sonnet', 'claude-haiku',
        ]);
        expect(codexConfig.modelPresets).toHaveLength(5);
        expect(codexConfig).not.toHaveProperty('customModels');
      });

      it('seeds the two factory presets on first launch', async () => {
        mockAdapter.exists.mockResolvedValue(false);

        const result = await storage.load();

        expect(getCodexProviderSettings(result as unknown as Record<string, unknown>).modelPresets)
          .toEqual([
            { label: 'GPT-5.4 Mini', model: 'gpt-5.4-mini' },
            { label: 'GPT-5.5', model: 'gpt-5.5' },
          ]);
        expect(mockAdapter.write).not.toHaveBeenCalled();
      });

      it('does not rewrite the file again once codex presets are stored', async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockResolvedValue(JSON.stringify({
          permissionMode: 'auto',
          savedProviderPermissionMode: { claude: 'auto' },
          providerConfigs: {
            codex: {
              modelPresets: [{ label: 'Only', model: 'only-model' }],
            },
          },
        }));

        await storage.load();

        expect(mockAdapter.write).not.toHaveBeenCalled();
      });
    });

    it('should throw on read error', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockRejectedValue(new Error('Read failed'));

      await expect(storage.load()).rejects.toThrow('Read failed');
    });

    describe('Claude permission mode migration', () => {
      async function loadRaw(raw: Record<string, unknown>) {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockResolvedValue(JSON.stringify(raw));
        return storage.load();
      }

      function lastWritten(): Record<string, unknown> {
        return JSON.parse(
          mockAdapter.write.mock.calls[mockAdapter.write.mock.calls.length - 1][1],
        );
      }

      it('keeps a stored yolo and strips the legacy safeMode source', async () => {
        const result = await loadRaw({
          permissionMode: 'yolo',
          providerConfigs: { claude: { safeMode: 'default' } },
        });
        const written = lastWritten();

        expect(result.permissionMode).toBe('yolo');
        expect(result.savedProviderPermissionMode.claude).toBe('yolo');
        const writtenClaudeConfig = (written.providerConfigs as Record<string, Record<string, unknown>>).claude;
        expect(writtenClaudeConfig).not.toHaveProperty('safeMode');
        expect(written).not.toHaveProperty('claudeSafeMode');
      });

      it.each([
        [{ providerConfigs: { claude: { safeMode: 'auto' } } }, 'auto'],
        [{ providerConfigs: { claude: { safeMode: 'default' } } }, 'manual'],
        [{ providerConfigs: { claude: { safeMode: 'acceptEdits' } } }, 'acceptEdits'],
        [{}, 'acceptEdits'],
        [{ claudeSafeMode: 'auto' }, 'auto'],
        [{ providerConfigs: { claude: { safeMode: 'default' } }, claudeSafeMode: 'auto' }, 'manual'],
        [{ providerConfigs: { claude: { safeMode: 'bogus' } }, claudeSafeMode: 'auto' }, 'manual'],
      ])('maps legacy normal with %j to %s', async (raw, expected) => {
        const result = await loadRaw({ permissionMode: 'normal', ...raw });

        expect(result.permissionMode).toBe(expected);
        expect(result.savedProviderPermissionMode.claude).toBe(expected);
      });

      it('fails an invalid stored permission value closed to manual, never back to auto', async () => {
        for (const invalid of ['future', null, false, '']) {
          const result = await loadRaw({ permissionMode: invalid });

          expect(result.permissionMode).toBe('manual');
        }
      });

      it('defaults an unowned top level to auto and keeps the other provider intact', async () => {
        const result = await loadRaw({
          settingsProvider: 'codex',
          providerConfigs: { codex: { enabled: true } },
          permissionMode: 'yolo',
        });
        const written = lastWritten();

        expect(result.permissionMode).toBe('yolo');
        expect(result.savedProviderPermissionMode.claude).toBe('auto');
        expect(written.permissionMode).toBe('yolo');
      });

      it('lets a persisted plan never survive a reload', async () => {
        const result = await loadRaw({ permissionMode: 'plan' });

        expect(result.permissionMode).toBe('manual');
        expect(result.savedProviderPermissionMode.claude).toBe('manual');
      });

      it('is idempotent: the second load of a migrated file does not rewrite', async () => {
        mockAdapter.exists.mockResolvedValue(true);
        mockAdapter.read.mockResolvedValue(JSON.stringify({
          permissionMode: 'normal',
          claudeSafeMode: 'auto',
        }));

        const first = await storage.load();
        const writesAfterFirst = mockAdapter.write.mock.calls.length;
        const diskContent = mockAdapter.write.mock.calls[writesAfterFirst - 1][1];

        // Second load reads the migrated file back.
        mockAdapter.read.mockResolvedValue(diskContent);
        mockAdapter.write.mockClear();
        const second = await storage.load();

        expect(second.permissionMode).toBe(first.permissionMode);
        expect(second.savedProviderPermissionMode.claude)
          .toBe(first.savedProviderPermissionMode.claude);
        expect(mockAdapter.write).not.toHaveBeenCalled();
        expect(writesAfterFirst).toBe(1);
      });

      it('does not delete the legacy file when the write-back fails', async () => {
        mockAdapter.exists.mockImplementation(async (path: string) => (
          path === LEGACY_CLAUDIAN_SETTINGS_PATH
        ));
        mockAdapter.read.mockResolvedValue(JSON.stringify({
          permissionMode: 'normal',
          claudeSafeMode: 'auto',
        }));
        mockAdapter.write.mockRejectedValue(new Error('Write failed'));

        await expect(storage.load()).rejects.toThrow('Write failed');
        expect(mockAdapter.delete).not.toHaveBeenCalledWith(LEGACY_CLAUDIAN_SETTINGS_PATH);
      });
    });
  });

  describe('save', () => {
    it('should write settings to file', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        model: 'claude-opus-4-5' as const,
      };

      await storage.save(settings);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        CLAUDIAN_SETTINGS_PATH,
        expect.any(String)
      );
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent.providerConfigs.codex.installationMethodsByHost).toEqual({});
      expect(writtenContent.providerConfigs.codex.wslDistroOverridesByHost).toEqual({});
    });

    it('should strip legacy slashCommands before writing', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        model: 'claude-opus-4-5' as const,
        slashCommands: [{ id: 'cmd-review', name: 'review', content: 'Review' }],
      } as typeof DEFAULT_SETTINGS & { slashCommands: unknown[] };

      await storage.save(settings as any);

      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent).not.toHaveProperty('slashCommands');
    });

    it('deletes the legacy settings file after writing the new path', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === LEGACY_CLAUDIAN_SETTINGS_PATH
      ));

      await storage.save(DEFAULT_SETTINGS);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        CLAUDIAN_SETTINGS_PATH,
        expect.any(String),
      );
      expect(mockAdapter.delete).toHaveBeenCalledWith(LEGACY_CLAUDIAN_SETTINGS_PATH);
    });

    it('should throw on write error', async () => {
      mockAdapter.write.mockRejectedValue(new Error('Write failed'));

      await expect(storage.save(DEFAULT_SETTINGS)).rejects.toThrow('Write failed');
    });

    it('serializes a transient plan onto the durable fallback without mutating the caller object', async () => {
      const live = {
        ...DEFAULT_SETTINGS,
        permissionMode: 'plan',
        savedProviderPermissionMode: { claude: 'plan', codex: 'plan' as unknown as string },
      } as typeof DEFAULT_SETTINGS;

      await storage.save(live);

      const written = JSON.parse(
        mockAdapter.write.mock.calls[mockAdapter.write.mock.calls.length - 1][1],
      );
      expect(written.permissionMode).toBe('manual');
      expect(written.savedProviderPermissionMode.claude).toBe('manual');
      expect(written.savedProviderPermissionMode.codex).toBe('normal');
      // The live in-memory plan overlay survives for the running session.
      expect(live.permissionMode).toBe('plan');
      expect(live.savedProviderPermissionMode.claude).toBe('plan');
    });

    it('maps an old-format input on save instead of only stripping legacy fields', async () => {
      await storage.save({
        ...DEFAULT_SETTINGS,
        permissionMode: 'normal',
        claudeSafeMode: 'auto',
        providerConfigs: { claude: { safeMode: 'auto' } },
      } as typeof DEFAULT_SETTINGS & { claudeSafeMode: unknown });

      const written = JSON.parse(
        mockAdapter.write.mock.calls[mockAdapter.write.mock.calls.length - 1][1],
      );
      expect(written.permissionMode).toBe('auto');
      expect(written).not.toHaveProperty('claudeSafeMode');
      const claudeConfig = (written.providerConfigs as Record<string, Record<string, unknown>>).claude;
      expect(claudeConfig).not.toHaveProperty('safeMode');
    });
  });

  describe('exists', () => {
    it('should return true when the new file exists', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === CLAUDIAN_SETTINGS_PATH
      ));

      const result = await storage.exists();

      expect(result).toBe(true);
      expect(mockAdapter.exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
    });

    it('should return true when only the legacy file exists', async () => {
      mockAdapter.exists.mockImplementation(async (path: string) => (
        path === LEGACY_CLAUDIAN_SETTINGS_PATH
      ));

      const result = await storage.exists();

      expect(result).toBe(true);
      expect(mockAdapter.exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
      expect(mockAdapter.exists).toHaveBeenCalledWith(LEGACY_CLAUDIAN_SETTINGS_PATH);
    });

    it('should return false when file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.exists();

      expect(result).toBe(false);
    });
  });

  describe('update', () => {
    it('should merge updates with existing settings', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'claude-haiku-4-5',
        userName: 'ExistingUser',
      }));

      await storage.update({ model: 'claude-opus-4-5' });

      const writeCall = mockAdapter.write.mock.calls[mockAdapter.write.mock.calls.length - 1];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent.userName).toBe('ExistingUser');
    });
  });

  describe('setLastModel', () => {
    it('should update lastClaudeModel for non-custom models', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({}));

      await storage.setLastModel('claude-sonnet-4-5', false);

      const writeCall = mockAdapter.write.mock.calls[mockAdapter.write.mock.calls.length - 1];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.providerConfigs.claude.lastModel).toBe('claude-sonnet-4-5');
      // lastCustomModel keeps its default value (empty string)
    });

    it('should update lastCustomModel for custom models', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({}));

      await storage.setLastModel('custom-model-id', true);

      const writeCall = mockAdapter.write.mock.calls[mockAdapter.write.mock.calls.length - 1];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.lastCustomModel).toBe('custom-model-id');
      // lastClaudeModel keeps its default value
    });
  });

  describe('setLastEnvHash', () => {
    it('should update environment hash', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({}));

      await storage.setLastEnvHash('abc123');

      const writeCall = mockAdapter.write.mock.calls[mockAdapter.write.mock.calls.length - 1];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.providerConfigs.claude.environmentHash).toBe('abc123');
    });
  });
});
