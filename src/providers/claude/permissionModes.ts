import type { PermissionMode as SDKPermissionMode } from '@anthropic-ai/claude-agent-sdk';

import {
  normalizeDurableProviderPermissionMode,
  resolveProviderPermissionMode,
} from '../../core/providers/permissionModes';
import { getProviderConfig } from '../../core/providers/providerConfig';
import type {
  ProviderPermissionModeOption,
  ProviderPermissionModePolicy,
} from '../../core/providers/types';
import type { ProviderConfigMap } from '../../core/types/settings';
import { t } from '../../i18n/i18n';

export const CLAUDE_PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'yolo'] as const;
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];

/** Durable modes plus the fork's transient plan overlay. */
export type ClaudeRuntimePermissionMode = ClaudePermissionMode | 'plan';

/** Fork plan is a runtime overlay, never a fifth menu option. */
export const CLAUDE_PERMISSION_MODE_PLAN = 'plan' as const;

const SDK_PERMISSION_MODES: Record<ClaudePermissionMode, SDKPermissionMode> = {
  auto: 'auto',
  manual: 'default',
  acceptEdits: 'acceptEdits',
  yolo: 'bypassPermissions',
};

const APP_PERMISSION_MODES_BY_SDK: Record<string, ClaudeRuntimePermissionMode> = {
  auto: 'auto',
  default: 'manual',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'yolo',
  plan: CLAUDE_PERMISSION_MODE_PLAN,
};

/** Retired Safe-toggle targets, stored as `providerConfigs.claude.safeMode`. */
const LEGACY_SAFE_MODE_TO_PERMISSION_MODE: Readonly<Record<string, ClaudePermissionMode>> = {
  auto: 'auto',
  default: 'manual',
  acceptEdits: 'acceptEdits',
};

export const CLAUDE_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: CLAUDE_PERMISSION_MODES,
  defaultValue: 'auto',
  fallbackValue: 'manual',
  transientValues: Object.freeze([CLAUDE_PERMISSION_MODE_PLAN]),
  migrateValue(value: string, settings: Record<string, unknown>): string | undefined {
    if (value !== 'normal') {
      return undefined;
    }
    return resolveLegacyClaudeSafeModePermissionMode(settings);
  },
});

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(value);
}

export function toClaudeSdkPermissionMode(mode: ClaudePermissionMode): SDKPermissionMode {
  return SDK_PERMISSION_MODES[mode];
}

/**
 * Native modes outside the policy (dontAsk, delegate, ...) have no toolbar
 * value and must not be misattributed to Auto or Manual.
 */
export function resolveClaudeAppPermissionModeFromSdk(
  sdkMode: unknown,
): ClaudeRuntimePermissionMode | null {
  if (typeof sdkMode !== 'string') {
    return null;
  }
  return APP_PERMISSION_MODES_BY_SDK[sdkMode] ?? null;
}

/**
 * Retired Safe-toggle reading: the nested `providerConfigs.claude.safeMode`
 * wins over the older top-level `claudeSafeMode`; an explicitly invalid
 * source fails closed instead of raising through the older one; both absent
 * means the historical acceptEdits default.
 */
export function resolveLegacyClaudeSafeModePermissionMode(
  settings: Record<string, unknown>,
): ClaudePermissionMode | undefined {
  const nestedSafeMode = getProviderConfig(settings, 'claude').safeMode;
  if (nestedSafeMode !== undefined) {
    return LEGACY_SAFE_MODE_TO_PERMISSION_MODE[String(nestedSafeMode)];
  }
  const topLevelSafeMode = settings.claudeSafeMode;
  if (topLevelSafeMode !== undefined) {
    return LEGACY_SAFE_MODE_TO_PERMISSION_MODE[String(topLevelSafeMode)];
  }
  return 'acceptEdits';
}

/** Boundary normalization for any Claude permission input (four modes, plan, legacy). */
export function resolveClaudeRuntimePermissionMode(
  value: unknown,
  settings?: Record<string, unknown>,
): ClaudeRuntimePermissionMode {
  if (value === CLAUDE_PERMISSION_MODE_PLAN) {
    return CLAUDE_PERMISSION_MODE_PLAN;
  }
  const resolved = resolveProviderPermissionMode(
    CLAUDE_PERMISSION_MODE_POLICY,
    value,
    settings ?? {},
  );
  return isClaudePermissionMode(resolved) ? resolved : 'manual';
}

/** Maps a runtime app mode (including plan) onto the SDK request value. */
export function resolveClaudeSdkPermissionModeForRuntime(
  mode: ClaudeRuntimePermissionMode,
): SDKPermissionMode {
  return isClaudePermissionMode(mode)
    ? toClaudeSdkPermissionMode(mode)
    : CLAUDE_PERMISSION_MODE_PLAN;
}

/** Menu options; labels resolve through t() so a locale switch needs no reload. */
export function getClaudePermissionModeOptions(): readonly ProviderPermissionModeOption[] {
  return [
    {
      value: 'auto',
      label: t('chat.claude.permission.auto'),
      description: t('chat.claude.permission.autoDesc'),
    },
    {
      value: 'manual',
      label: t('chat.claude.permission.manual'),
      description: t('chat.claude.permission.manualDesc'),
    },
    {
      value: 'acceptEdits',
      label: t('chat.claude.permission.acceptEdits'),
      description: t('chat.claude.permission.acceptEditsDesc'),
    },
    {
      value: 'yolo',
      label: t('chat.claude.permission.yolo'),
      description: t('chat.claude.permission.yoloDesc'),
      bypassesApprovals: true,
    },
  ];
}

export interface ClaudePermissionModeMigrationInput {
  /** Raw top-level `permissionMode` from the stored settings file. */
  readonly storedPermissionMode: unknown;
  /** Raw `savedProviderPermissionMode.claude` from the stored settings file. */
  readonly storedSavedClaudeMode: unknown;
  /** Normalized provider configs carrying the retired nested `safeMode`. */
  readonly providerConfigs: ProviderConfigMap;
  /** Retired top-level `claudeSafeMode` field. */
  readonly topLevelSafeMode: unknown;
  /**
   * Whether the top-level `permissionMode` belongs to Claude. When the active
   * provider is Codex/OpenCode its yolo must never become Claude's choice.
   */
  readonly topPermissionOwnedByClaude: boolean;
}

/**
 * Raw-storage migration entry (design §4.1). Priority: saved Claude choice
 * (kept when new-style, migrated when legacy, fail-closed when invalid) →
 * claude-owned top level → provider default. A present-but-invalid value
 * never re-picks Auto/YOLO.
 */
export function migrateClaudePermissionMode(
  input: ClaudePermissionModeMigrationInput,
): ClaudePermissionMode {
  const legacySettings = {
    providerConfigs: input.providerConfigs,
    claudeSafeMode: input.topLevelSafeMode,
  };
  const policy = CLAUDE_PERMISSION_MODE_POLICY;

  if (input.storedSavedClaudeMode !== undefined) {
    const saved = normalizeDurableProviderPermissionMode(
      policy,
      input.storedSavedClaudeMode,
      legacySettings,
    );
    return (saved ?? policy.fallbackValue) as ClaudePermissionMode;
  }

  if (!input.topPermissionOwnedByClaude || input.storedPermissionMode === undefined) {
    return (policy.defaultValue ?? policy.fallbackValue) as ClaudePermissionMode;
  }

  const migrated = normalizeDurableProviderPermissionMode(
    policy,
    input.storedPermissionMode,
    legacySettings,
  );
  return (migrated ?? policy.fallbackValue) as ClaudePermissionMode;
}
