import {
  BINARY_PERMISSION_MODE_POLICY,
  isDurableProviderPermissionModeValue,
  isTransientProviderPermissionModeValue,
  normalizeDurableProviderPermissionMode,
  resolveProviderPermissionMode,
} from '@/core/providers/permissionModes';
import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from '@/core/providers/types';

describe('core permission mode contracts', () => {
  describe('BINARY_PERMISSION_MODE_POLICY', () => {
    it('exposes the shared Safe/YOLO values with a normal default and fallback', () => {
      expect(BINARY_PERMISSION_MODE_POLICY.values).toEqual(['normal', 'yolo']);
      expect(BINARY_PERMISSION_MODE_POLICY.defaultValue).toBe('normal');
      expect(BINARY_PERMISSION_MODE_POLICY.fallbackValue).toBe('normal');
    });

    it('accepts plan only as a runtime transient value', () => {
      expect(BINARY_PERMISSION_MODE_POLICY.transientValues).toEqual(['plan']);
      expect(isTransientProviderPermissionModeValue(BINARY_PERMISSION_MODE_POLICY, 'plan')).toBe(true);
      expect(isDurableProviderPermissionModeValue(BINARY_PERMISSION_MODE_POLICY, 'plan')).toBe(false);
      expect(isDurableProviderPermissionModeValue(BINARY_PERMISSION_MODE_POLICY, 'yolo')).toBe(true);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(BINARY_PERMISSION_MODE_POLICY)).toBe(true);
      expect(Object.isFrozen(BINARY_PERMISSION_MODE_POLICY.values)).toBe(true);
    });
  });

  describe('resolveProviderPermissionMode (memory projection)', () => {
    it('keeps durable values', () => {
      expect(resolveProviderPermissionMode(BINARY_PERMISSION_MODE_POLICY, 'normal', {})).toBe('normal');
      expect(resolveProviderPermissionMode(BINARY_PERMISSION_MODE_POLICY, 'yolo', {})).toBe('yolo');
    });

    it('keeps transient values so in-memory plan survives projection', () => {
      expect(resolveProviderPermissionMode(BINARY_PERMISSION_MODE_POLICY, 'plan', {})).toBe('plan');
    });

    it('returns undefined for a missing value so the projection chain can continue', () => {
      expect(resolveProviderPermissionMode(BINARY_PERMISSION_MODE_POLICY, undefined, {})).toBeUndefined();
    });

    it('migrates retired values through the policy hook', () => {
      const policy: ProviderPermissionModePolicy = {
        values: ['auto', 'manual'],
        fallbackValue: 'manual',
        migrateValue: value => (value === 'legacy' ? 'auto' : undefined),
      };

      expect(resolveProviderPermissionMode(policy, 'legacy', {})).toBe('auto');
      expect(resolveProviderPermissionMode(policy, 'other', {})).toBe('manual');
    });

    it('fails present-but-invalid values closed to the fallback instead of skipping', () => {
      for (const invalid of ['future', '', null, false, 42, {}]) {
        expect(resolveProviderPermissionMode(BINARY_PERMISSION_MODE_POLICY, invalid, {}))
          .toBe('normal');
      }
    });

    it('passes the settings bag to the migration hook', () => {
      const migrateValue = jest.fn().mockReturnValue('normal');
      const policy: ProviderPermissionModePolicy = {
        values: ['normal', 'yolo'],
        fallbackValue: 'normal',
        migrateValue,
      };

      resolveProviderPermissionMode(policy, 'retired', { marker: true });

      expect(migrateValue).toHaveBeenCalledWith('retired', { marker: true });
    });
  });

  describe('normalizeDurableProviderPermissionMode (disk serialization)', () => {
    it('keeps durable values and rejects transient plan to the fallback', () => {
      expect(normalizeDurableProviderPermissionMode(BINARY_PERMISSION_MODE_POLICY, 'yolo', {})).toBe('yolo');
      expect(normalizeDurableProviderPermissionMode(BINARY_PERMISSION_MODE_POLICY, 'plan', {})).toBe('normal');
    });

    it('returns undefined for a missing value', () => {
      expect(normalizeDurableProviderPermissionMode(BINARY_PERMISSION_MODE_POLICY, undefined, {}))
        .toBeUndefined();
    });

    it('migrates retired values before failing closed', () => {
      const policy: ProviderPermissionModePolicy = {
        values: ['auto', 'manual'],
        fallbackValue: 'manual',
        migrateValue: value => (value === 'legacy' ? 'auto' : undefined),
      };

      expect(normalizeDurableProviderPermissionMode(policy, 'legacy', {})).toBe('auto');
      expect(normalizeDurableProviderPermissionMode(policy, 'plan', {})).toBe('manual');
      expect(normalizeDurableProviderPermissionMode(policy, 'future', {})).toBe('manual');
    });
  });

  describe('option shape', () => {
    it('extends ProviderUIOption with bypassesApprovals only', () => {
      const option: ProviderPermissionModeOption = {
        value: 'yolo',
        label: 'YOLO',
        description: 'bypasses approvals',
        bypassesApprovals: true,
      };

      expect(option.value).toBe('yolo');
      expect(option.bypassesApprovals).toBe(true);
    });
  });
});
