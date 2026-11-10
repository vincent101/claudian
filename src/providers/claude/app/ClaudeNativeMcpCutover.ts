import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type ClaudianPlugin from '../../../main';
import { getEnhancedPath } from '../../../utils/env';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '../settings';
import {
  type CutoverConfirmResult,
  type CutoverLaunchAdmission,
  type CutoverServiceDeps,
  type NativeMcpCutoverRecord,
  type NativeMcpScopeInput,
  POLICY_VERSION,
  resolveNativeMcpScopeKey,
} from '../types/nativeMcpCutover';

/**
 * Cutover admission gate for provider-native MCP management
 * (design 2026-11-09-provider-native-mcp-alignment §5.1).
 *
 * Responsibilities are deliberately narrow: detect that legacy management
 * traces exist (existence only — never file contents), persist the user's
 * one-shot confirmation through the existing Claudian settings storage, and
 * answer "may a Claude launch start under this scope?". It never lists
 * servers, edits configs, tests connections, or manages anything at runtime.
 *
 * Fail-closed rules:
 * - Legacy file present, loaded metadata carries legacy selections, or the
 *   existence probe cannot confirm absence → review-required → spawn blocked.
 * - A confirmation is only valid for the exact scope (cwd, config home, CLI
 *   target, setting sources) and policy version it was recorded under.
 * - An ack write failure leaves the scope review-required — no in-memory
 *   pass is ever granted ahead of the persisted write.
 */
export class ClaudeNativeMcpCutoverService {
  private readonly deps: CutoverServiceDeps;
  /** Transient runtime observation per scopeKey; never persisted. */
  private readonly runningScopes = new Set<string>();

  constructor(deps: CutoverServiceDeps) {
    this.deps = deps;
  }

  async resolveLaunchAdmission(input: NativeMcpScopeInput): Promise<CutoverLaunchAdmission> {
    const scopeKey = resolveNativeMcpScopeKey(input);

    if (this.runningScopes.has(scopeKey)) {
      return { allowed: true, status: 'native-running', scopeKey };
    }

    const record = await this.deps.loadRecord();
    if (
      record
      && record.scopeKey === scopeKey
      && record.policyVersion === POLICY_VERSION
      && record.decision === 'native-config-reviewed'
    ) {
      return { allowed: true, status: 'eligible-confirmed', scopeKey };
    }

    if (record && record.scopeKey === scopeKey && record.policyVersion !== POLICY_VERSION) {
      return this.blocked(scopeKey, 'policy-version-changed');
    }

    const legacyPath = this.deps.legacyFilePath(input.cwd);
    const legacyExists = await this.deps.legacyFileProbe(legacyPath);
    if (legacyExists === 'unknown') {
      return this.blocked(scopeKey, 'legacy-state-unknown');
    }
    if (legacyExists === true) {
      return this.blocked(scopeKey, 'legacy-file-present');
    }
    if (this.deps.hasLoadedLegacyMetadata()) {
      return this.blocked(scopeKey, 'loaded-legacy-metadata');
    }

    // Fresh install / no legacy traces: the same admission function's
    // automatic branch — no confirmation record is written for these.
    return { allowed: true, status: 'eligible-new', scopeKey };
  }

  async confirmCutover(input: NativeMcpScopeInput): Promise<CutoverConfirmResult> {
    const scopeKey = resolveNativeMcpScopeKey(input);
    const record: NativeMcpCutoverRecord = {
      policyVersion: POLICY_VERSION,
      scopeKey,
      confirmedAt: Date.now(),
      decision: 'native-config-reviewed',
    };
    try {
      await this.deps.saveRecord(record);
    } catch {
      // A failed write must never grant an in-memory pass: the scope stays
      // review-required and the next admission re-reads persisted state.
      return { ok: false };
    }
    return { ok: true };
  }

  markNativeRunning(scopeKey: string): void {
    this.runningScopes.add(scopeKey);
  }

  isNativeRunning(scopeKey: string): boolean {
    return this.runningScopes.has(scopeKey);
  }

  private blocked(
    scopeKey: string,
    reason: CutoverLaunchAdmission['reason'],
  ): CutoverLaunchAdmission {
    return { allowed: false, status: 'review-required', scopeKey, reason };
  }
}

function createLegacyMcpFileProbe(
  probe: (legacyPath: string) => Promise<boolean | 'unknown'>,
): (legacyPath: string) => Promise<boolean | 'unknown'> {
  return probe;
}

/**
 * Production binding: the legacy probe stats the file (lstat — a symlink
 * counts as present, a broken symlink too), never reading its content. The
 * confirmation record lives in the Claude provider settings block
 * (non-secret, round-tripped by the provider settings normalizers).
 */
export function createClaudeNativeMcpCutoverService(
  plugin: ClaudianPlugin,
): ClaudeNativeMcpCutoverService {
  return new ClaudeNativeMcpCutoverService({
    loadRecord: async () =>
      getClaudeProviderSettings(plugin.settings as unknown as Record<string, unknown>)
        .nativeMcpCutover,
    saveRecord: async record => {
      // Persisted through the standard provider-settings channel so the
      // record survives load/save normalization (design §6.1 settings row).
      // A failed persist rolls the in-memory mutation back — a failed write
      // must never leave an in-memory pass behind (design §5.2).
      const settingsBag = plugin.settings as unknown as Record<string, unknown>;
      const previous = getClaudeProviderSettings(settingsBag).nativeMcpCutover;
      updateClaudeProviderSettings(settingsBag, { nativeMcpCutover: record });
      try {
        await plugin.saveSettings();
      } catch (error) {
        updateClaudeProviderSettings(settingsBag, { nativeMcpCutover: previous });
        throw error;
      }
    },
    legacyFileProbe: createLegacyMcpFileProbe(async legacyPath => {
      try {
        // lstat: presence only — presence of the link itself counts, and the
        // file content is never opened here.
        await fs.lstat(legacyPath);
        return true;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return false;
        }
        // Permission/EAGAIN/etc: absence is not confirmed → fail closed.
        return 'unknown';
      }
    }),
    hasLoadedLegacyMetadata: () => {
      // The production plugin exposes a boolean-only signal; older plugin
      // shapes (test seams, isolated construction) fall back to inspecting
      // the conversations array existence — a missing signal is "no loaded
      // legacy traces", never a fabrication of traces.
      const candidate = plugin as unknown as {
        hasLoadedLegacyMcpMetadata?: () => boolean;
        conversations?: Array<{ enabledMcpServers?: string[] }>;
      };
      if (typeof candidate.hasLoadedLegacyMcpMetadata === 'function') {
        return candidate.hasLoadedLegacyMcpMetadata();
      }
      return (candidate.conversations ?? []).some(
        conversation => (conversation.enabledMcpServers?.length ?? 0) > 0,
      );
    },
    legacyFilePath: cwd => path.join(cwd, '.claude', 'mcp.json'),
  });
}

/** Resolves the non-secret scope identity for a launch about to happen. */
export function resolveClaudeLaunchScopeInput(
  plugin: ClaudianPlugin,
  vaultPath: string,
  cliPath: string,
  settingSources: readonly string[],
): NativeMcpScopeInput {
  return {
    providerId: 'claude',
    cwd: vaultPath,
    configHome: process.env.CLAUDE_CONFIG_DIR ?? os.homedir(),
    cliPath,
    settingSources,
  };
}

/** Re-exported for callers that build the enhanced PATH alongside the probe. */
export { getEnhancedPath };
