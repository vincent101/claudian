import {
  CLAUDE_PERMISSION_MODE_PLAN,
  CLAUDE_PERMISSION_MODE_POLICY,
  CLAUDE_PERMISSION_MODES,
  getClaudePermissionModeOptions,
  isClaudePermissionMode,
  migrateClaudePermissionMode,
  resolveClaudeAppPermissionModeFromSdk,
  resolveClaudeRuntimePermissionMode,
  toClaudeSdkPermissionMode,
} from '@/providers/claude/permissionModes';

describe('Claude permission modes', () => {
  describe('policy', () => {
    it('offers exactly the four durable modes in menu order', () => {
      expect(CLAUDE_PERMISSION_MODES).toEqual(['auto', 'manual', 'acceptEdits', 'yolo']);
      expect(CLAUDE_PERMISSION_MODE_POLICY.values).toEqual(CLAUDE_PERMISSION_MODES);
    });

    it('defaults new installs to auto and fails closed to manual', () => {
      expect(CLAUDE_PERMISSION_MODE_POLICY.defaultValue).toBe('auto');
      expect(CLAUDE_PERMISSION_MODE_POLICY.fallbackValue).toBe('manual');
    });

    it('keeps plan as a transient-only value that never persists', () => {
      expect(CLAUDE_PERMISSION_MODE_POLICY.transientValues).toEqual(['plan']);
      expect(CLAUDE_PERMISSION_MODE_PLAN).toBe('plan');
    });
  });

  describe('SDK forward mapping', () => {
    it('maps each durable app mode onto its SDK request value', () => {
      expect(toClaudeSdkPermissionMode('auto')).toBe('auto');
      expect(toClaudeSdkPermissionMode('manual')).toBe('default');
      expect(toClaudeSdkPermissionMode('acceptEdits')).toBe('acceptEdits');
      expect(toClaudeSdkPermissionMode('yolo')).toBe('bypassPermissions');
    });

    it('resolves runtime values with plan support and legacy migration', () => {
      for (const mode of CLAUDE_PERMISSION_MODES) {
        expect(resolveClaudeRuntimePermissionMode(mode)).toBe(mode);
      }
      expect(resolveClaudeRuntimePermissionMode('plan')).toBe('plan');
    });

    it('migrates legacy normal through the stored Safe selection', () => {
      expect(resolveClaudeRuntimePermissionMode('normal', {
        providerConfigs: { claude: { safeMode: 'auto' } },
      })).toBe('auto');
      expect(resolveClaudeRuntimePermissionMode('normal', {
        providerConfigs: { claude: { safeMode: 'default' } },
      })).toBe('manual');
      expect(resolveClaudeRuntimePermissionMode('normal', {
        providerConfigs: { claude: { safeMode: 'acceptEdits' } },
      })).toBe('acceptEdits');
    });

    it('treats a legacy normal without any Safe source as historical acceptEdits', () => {
      expect(resolveClaudeRuntimePermissionMode('normal', {})).toBe('acceptEdits');
      expect(resolveClaudeRuntimePermissionMode('normal')).toBe('acceptEdits');
    });

    it('prefers the nested Safe source over the retired top-level field', () => {
      expect(resolveClaudeRuntimePermissionMode('normal', {
        providerConfigs: { claude: { safeMode: 'default' } },
        claudeSafeMode: 'auto',
      })).toBe('manual');
    });

    it('reads the top-level claudeSafeMode when the nested source is absent', () => {
      expect(resolveClaudeRuntimePermissionMode('normal', {
        claudeSafeMode: 'auto',
      })).toBe('auto');
    });

    it('fails closed to manual on unknown or malformed values', () => {
      for (const invalid of ['future', '', 'WEIRD', null, false, 42]) {
        expect(resolveClaudeRuntimePermissionMode(invalid, {
          providerConfigs: { claude: { safeMode: 'auto' } },
        })).toBe('manual');
      }
    });

    it('fails closed to manual when the nested Safe source is explicitly invalid', () => {
      // An invalid nested value must not fall back to the older top-level source.
      expect(resolveClaudeRuntimePermissionMode('normal', {
        providerConfigs: { claude: { safeMode: 'bogus' } },
        claudeSafeMode: 'auto',
      })).toBe('manual');
    });
  });

  describe('native reverse mapping', () => {
    it('maps observed SDK modes back onto the four app modes', () => {
      expect(resolveClaudeAppPermissionModeFromSdk('auto')).toBe('auto');
      expect(resolveClaudeAppPermissionModeFromSdk('default')).toBe('manual');
      expect(resolveClaudeAppPermissionModeFromSdk('acceptEdits')).toBe('acceptEdits');
      expect(resolveClaudeAppPermissionModeFromSdk('bypassPermissions')).toBe('yolo');
    });

    it('keeps the fork plan transient state observable', () => {
      expect(resolveClaudeAppPermissionModeFromSdk('plan')).toBe('plan');
    });

    it('refuses to misattribute unknown native modes', () => {
      for (const unknown of ['dontAsk', 'delegate', '', 'WEIRD', undefined, null, 42]) {
        expect(resolveClaudeAppPermissionModeFromSdk(unknown)).toBeNull();
      }
    });
  });

  describe('migrateClaudePermissionMode (raw storage entry)', () => {
    function migrate(raw: {
      permissionMode?: unknown;
      savedClaudeMode?: unknown;
      nestedSafeMode?: unknown;
      topLevelSafeMode?: unknown;
      topPermissionOwnedByClaude?: boolean;
    }): string {
      return migrateClaudePermissionMode({
        storedPermissionMode: raw.permissionMode,
        storedSavedClaudeMode: raw.savedClaudeMode,
        providerConfigs: raw.nestedSafeMode === undefined
          ? {}
          : { claude: { safeMode: raw.nestedSafeMode } },
        topLevelSafeMode: raw.topLevelSafeMode,
        topPermissionOwnedByClaude: raw.topPermissionOwnedByClaude ?? true,
      });
    }

    it('defaults an unowned top level to auto (no Claude history)', () => {
      // active provider is codex: its yolo must not become Claude's choice.
      expect(migrate({
        permissionMode: 'yolo',
        topPermissionOwnedByClaude: false,
      })).toBe('auto');
    });

    it('keeps a stored yolo untouched (no silent reset)', () => {
      for (const safeMode of ['auto', 'default', 'acceptEdits', 'bogus']) {
        expect(migrate({ permissionMode: 'yolo', nestedSafeMode: safeMode })).toBe('yolo');
      }
    });

    it('maps legacy normal through each historical Safe target', () => {
      expect(migrate({ permissionMode: 'normal', nestedSafeMode: 'auto' })).toBe('auto');
      expect(migrate({ permissionMode: 'normal', nestedSafeMode: 'default' })).toBe('manual');
      expect(migrate({ permissionMode: 'normal', nestedSafeMode: 'acceptEdits' })).toBe('acceptEdits');
    });

    it('treats normal with both Safe sources missing as historical acceptEdits', () => {
      expect(migrate({ permissionMode: 'normal' })).toBe('acceptEdits');
    });

    it('reads the top-level Safe source when the nested one is absent', () => {
      expect(migrate({ permissionMode: 'normal', topLevelSafeMode: 'auto' })).toBe('auto');
    });

    it('prefers the nested Safe source over the top-level one', () => {
      expect(migrate({
        permissionMode: 'normal',
        nestedSafeMode: 'default',
        topLevelSafeMode: 'auto',
      })).toBe('manual');
    });

    it('fails an invalid nested Safe source closed instead of raising to the top-level auto', () => {
      expect(migrate({
        permissionMode: 'normal',
        nestedSafeMode: 'bogus',
        topLevelSafeMode: 'auto',
      })).toBe('manual');
    });

    it('fails invalid or missing top-level values closed to manual, never back to auto', () => {
      for (const invalid of ['future', null, false, '']) {
        expect(migrate({ permissionMode: invalid, nestedSafeMode: 'auto' })).toBe('manual');
      }
    });

    it('defaults a claude-owned file without any permission choice to auto', () => {
      expect(migrate({})).toBe('auto');
    });

    it('keeps a saved four-mode selection even with residual Safe sources', () => {
      for (const mode of CLAUDE_PERMISSION_MODES) {
        expect(migrate({
          permissionMode: 'normal',
          savedClaudeMode: mode,
          nestedSafeMode: 'default',
        })).toBe(mode);
      }
    });

    it('prefers a saved legacy choice over the ignored top level', () => {
      // saved.claude=normal + safeMode=default wins over the top-level yolo.
      expect(migrate({
        permissionMode: 'yolo',
        savedClaudeMode: 'normal',
        nestedSafeMode: 'default',
      })).toBe('manual');
    });

    it('fails an invalid saved value closed instead of adopting the top-level yolo', () => {
      expect(migrate({
        permissionMode: 'yolo',
        savedClaudeMode: 'future',
      })).toBe('manual');
    });

    it('never lets a persisted plan survive a reload', () => {
      expect(migrate({ permissionMode: 'plan' })).toBe('manual');
      expect(migrate({ permissionMode: 'auto', savedClaudeMode: 'plan' })).toBe('manual');
    });

    it('migrates a non-active Claude saved choice through the legacy sources', () => {
      // active=codex, saved.claude=normal, legacy auto → saved.claude becomes auto.
      expect(migrate({
        permissionMode: 'normal',
        savedClaudeMode: 'normal',
        nestedSafeMode: 'auto',
        topPermissionOwnedByClaude: false,
      })).toBe('auto');
    });
  });

  describe('menu options', () => {
    it('exposes one option per durable mode with bypass only on yolo', () => {
      const options = getClaudePermissionModeOptions();

      expect(options.map(option => option.value)).toEqual([...CLAUDE_PERMISSION_MODES]);
      expect(options.map(option => option.bypassesApprovals === true)).toEqual([false, false, false, true]);
      expect(options.every(option => option.label.length > 0)).toBe(true);
      expect(options.every(option => typeof option.description === 'string' && option.description.length > 0))
        .toBe(true);
    });

    it('recognizes durable values', () => {
      expect(isClaudePermissionMode('manual')).toBe(true);
      expect(isClaudePermissionMode('plan')).toBe(false);
      expect(isClaudePermissionMode('normal')).toBe(false);
    });
  });
});
