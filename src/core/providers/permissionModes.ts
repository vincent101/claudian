import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from './types';

/**
 * Safe/YOLO policy for providers whose Safe mode is their native approval
 * flow (Codex, OpenCode). The fork's plan mode stays a runtime transient.
 */
export const BINARY_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: Object.freeze(['normal', 'yolo']),
  defaultValue: 'normal',
  fallbackValue: 'normal',
  transientValues: Object.freeze(['plan']),
});

/** Shared two-option menu list; labels resolve through t() at render time. */
export function getBinaryPermissionModeOptions(
  labels: { safe: string; yolo: string },
): readonly ProviderPermissionModeOption[] {
  return [
    { value: 'normal', label: labels.safe },
    { value: 'yolo', label: labels.yolo, bypassesApprovals: true },
  ];
}

export function isDurableProviderPermissionModeValue(
  policy: ProviderPermissionModePolicy,
  value: unknown,
): value is string {
  return typeof value === 'string' && policy.values.includes(value);
}

export function isTransientProviderPermissionModeValue(
  policy: ProviderPermissionModePolicy,
  value: unknown,
): value is string {
  return typeof value === 'string'
    && (policy.transientValues ?? []).includes(value);
}

export function isProviderPermissionModeValue(
  policy: ProviderPermissionModePolicy,
  value: unknown,
): value is string {
  return isDurableProviderPermissionModeValue(policy, value)
    || isTransientProviderPermissionModeValue(policy, value);
}

function migrateStoredValue(
  policy: ProviderPermissionModePolicy,
  value: string,
  settings: Record<string, unknown>,
  accepts: (candidate: string) => boolean,
): string | undefined {
  const migrated = policy.migrateValue?.(value, settings);
  return migrated !== undefined && accepts(migrated) ? migrated : undefined;
}

/**
 * In-memory projection normalization: keeps durable and transient values,
 * migrates retired ones, and fails any other present value closed to the
 * fallback. `undefined` means "no value" so the projection chain continues.
 */
export function resolveProviderPermissionMode(
  policy: ProviderPermissionModePolicy,
  value: unknown,
  settings: Record<string, unknown>,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isProviderPermissionModeValue(policy, value)) {
    return value;
  }
  if (typeof value === 'string') {
    const migrated = migrateStoredValue(policy, value, settings, candidate =>
      isProviderPermissionModeValue(policy, candidate));
    if (migrated !== undefined) {
      return migrated;
    }
  }
  return policy.fallbackValue;
}

/**
 * Disk serialization normalization: durable values only. Transient states
 * (plan) and unmapped legacy values settle on the fallback so nothing
 * runtime-ephemeral ever reaches the settings file.
 */
export function normalizeDurableProviderPermissionMode(
  policy: ProviderPermissionModePolicy,
  value: unknown,
  settings: Record<string, unknown>,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isDurableProviderPermissionModeValue(policy, value)) {
    return value;
  }
  if (typeof value === 'string') {
    const migrated = migrateStoredValue(policy, value, settings, candidate =>
      isDurableProviderPermissionModeValue(policy, candidate));
    if (migrated !== undefined) {
      return migrated;
    }
  }
  return policy.fallbackValue;
}
