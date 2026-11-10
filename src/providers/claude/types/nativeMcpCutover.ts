/**
 * Provider-owned cutover contract for the removal of in-app MCP management
 * (design 2026-11-09-provider-native-mcp-alignment, plan B).
 *
 * The record is intentionally non-secret: scopeKey is a normalized join of
 * launch-identity inputs, never server URLs, env, headers, tokens, or old
 * file contents.
 */

export const POLICY_VERSION = 1;

export type NativeMcpDecision = 'native-config-reviewed';

export interface NativeMcpCutoverRecord {
  policyVersion: number;
  scopeKey: string;
  confirmedAt: number;
  decision: NativeMcpDecision;
}

/** Non-secret launch-identity inputs that make a confirmation scope-valid. */
export interface NativeMcpScopeInput {
  providerId: string;
  cwd: string;
  configHome: string;
  cliPath: string;
  settingSources: readonly string[];
}

export function resolveNativeMcpScopeKey(input: NativeMcpScopeInput): string {
  const sources = [...input.settingSources].sort().join(',');
  return [
    input.providerId,
    input.cwd,
    input.configHome,
    input.cliPath,
    sources,
  ].join('|');
}

export type CutoverStatus =
  | 'eligible-new'
  | 'eligible-confirmed'
  | 'review-required'
  | 'native-running';

export type CutoverBlockReason =
  | 'legacy-file-present'
  | 'loaded-legacy-metadata'
  | 'legacy-state-unknown'
  | 'policy-version-changed';

export interface CutoverLaunchAdmission {
  allowed: boolean;
  status: CutoverStatus;
  scopeKey: string;
  reason?: CutoverBlockReason;
}

/**
 * Fail-closed existence probe for the legacy `.claude/mcp.json`. Returns
 * true/false for presence; 'unknown' when absence cannot be confirmed. The
 * implementation MUST NOT read file contents.
 */
export type LegacyMcpFileProbe = (
  legacyPath: string,
) => Promise<boolean | 'unknown'>;

export interface CutoverServiceDeps {
  loadRecord: () => Promise<NativeMcpCutoverRecord | undefined>;
  saveRecord: (record: NativeMcpCutoverRecord) => Promise<void>;
  legacyFileProbe: LegacyMcpFileProbe;
  /** True when already-loaded conversation metadata still carries legacy MCP selections. */
  hasLoadedLegacyMetadata: () => boolean;
  /** Absolute path of the legacy config file for the current cwd. */
  legacyFilePath: (cwd: string) => string;
}

export interface CutoverConfirmResult {
  ok: boolean;
}
