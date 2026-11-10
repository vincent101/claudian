import { ClaudeNativeMcpCutoverService } from '@/providers/claude/app/ClaudeNativeMcpCutover';
import {
  type CutoverServiceDeps,
  type NativeMcpCutoverRecord,
  POLICY_VERSION,
  resolveNativeMcpScopeKey,
} from '@/providers/claude/types/nativeMcpCutover';

function createDeps(overrides: Partial<CutoverServiceDeps> = {}): CutoverServiceDeps {
  let stored: NativeMcpCutoverRecord | undefined;
  return {
    loadRecord: jest.fn(async () => stored),
    saveRecord: jest.fn(async (record: NativeMcpCutoverRecord) => {
      stored = record;
    }),
    legacyFileProbe: jest.fn(async () => false),
    hasLoadedLegacyMetadata: jest.fn(() => false),
    legacyFilePath: jest.fn((cwd: string) => `${cwd}/.claude/mcp.json`),
    ...overrides,
  };
}

function createScope(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'claude',
    cwd: '/tmp/vault-a',
    configHome: '/home/user',
    cliPath: '/usr/local/bin/claude',
    settingSources: ['project', 'local'] as const,
    ...overrides,
  };
}

describe('resolveNativeMcpScopeKey', () => {
  it('derives a stable key from the non-secret scope inputs', () => {
    const a = resolveNativeMcpScopeKey(createScope());
    const b = resolveNativeMcpScopeKey(createScope());
    expect(a).toBe(b);
    expect(a).toContain('claude');
    expect(a).toContain('/tmp/vault-a');
    expect(a).toContain('local,project');
  });

  it('normalizes settingSources order so equivalent sets share one key', () => {
    const a = resolveNativeMcpScopeKey(createScope({ settingSources: ['project', 'local'] }));
    const b = resolveNativeMcpScopeKey(createScope({ settingSources: ['local', 'project'] }));
    expect(a).toBe(b);
  });

  it('separates scopes that differ in cwd, config home, or CLI target', () => {
    const base = resolveNativeMcpScopeKey(createScope());
    expect(resolveNativeMcpScopeKey(createScope({ cwd: '/tmp/vault-b' }))).not.toBe(base);
    expect(resolveNativeMcpScopeKey(createScope({ configHome: '/other/home' }))).not.toBe(base);
    expect(resolveNativeMcpScopeKey(createScope({ cliPath: '/opt/claude' }))).not.toBe(base);
  });

  it('separates settingSource sets (user source flips the scope)', () => {
    const base = resolveNativeMcpScopeKey(createScope());
    const withUser = resolveNativeMcpScopeKey(
      createScope({ settingSources: ['user', 'project', 'local'] }),
    );
    expect(withUser).not.toBe(base);
  });
});

describe('ClaudeNativeMcpCutoverService', () => {
  it('admits a fresh install with no legacy traces as eligible-new without writing a record', async () => {
    const deps = createDeps();
    const service = new ClaudeNativeMcpCutoverService(deps);
    const scope = createScope();

    const admission = await service.resolveLaunchAdmission(scope);

    expect(admission.allowed).toBe(true);
    expect(admission.status).toBe('eligible-new');
    expect(deps.saveRecord).not.toHaveBeenCalled();
  });

  it('blocks launches (review-required) when the legacy mcp.json file exists', async () => {
    const deps = createDeps({ legacyFileProbe: jest.fn(async () => true) });
    const service = new ClaudeNativeMcpCutoverService(deps);

    const admission = await service.resolveLaunchAdmission(createScope());

    expect(admission.allowed).toBe(false);
    expect(admission.status).toBe('review-required');
    expect(admission.reason).toBe('legacy-file-present');
  });

  it('blocks launches when loaded conversation metadata still carries legacy MCP selections', async () => {
    const deps = createDeps({ hasLoadedLegacyMetadata: jest.fn(() => true) });
    const service = new ClaudeNativeMcpCutoverService(deps);

    const admission = await service.resolveLaunchAdmission(createScope());

    expect(admission.allowed).toBe(false);
    expect(admission.status).toBe('review-required');
    expect(admission.reason).toBe('loaded-legacy-metadata');
  });

  it('fails closed when the legacy file probe cannot confirm absence', async () => {
    const deps = createDeps({ legacyFileProbe: jest.fn(async () => 'unknown') });
    const service = new ClaudeNativeMcpCutoverService(deps);

    const admission = await service.resolveLaunchAdmission(createScope());

    expect(admission.allowed).toBe(false);
    expect(admission.status).toBe('review-required');
  });

  it('admits a stored confirmation whose scope and policy match', async () => {
    const scope = createScope();
    const record: NativeMcpCutoverRecord = {
      policyVersion: POLICY_VERSION,
      scopeKey: resolveNativeMcpScopeKey(scope),
      confirmedAt: 123,
      decision: 'native-config-reviewed',
    };
    const deps = createDeps({ loadRecord: jest.fn(async () => record) });
    const service = new ClaudeNativeMcpCutoverService(deps);

    const admission = await service.resolveLaunchAdmission(scope);

    expect(admission.allowed).toBe(true);
    expect(admission.status).toBe('eligible-confirmed');
  });

  it('refuses to reuse a confirmation recorded for a different scope', async () => {
    const otherScopeRecord: NativeMcpCutoverRecord = {
      policyVersion: POLICY_VERSION,
      scopeKey: resolveNativeMcpScopeKey(createScope({ cwd: '/tmp/other-vault' })),
      confirmedAt: 123,
      decision: 'native-config-reviewed',
    };
    const deps = createDeps({
      legacyFileProbe: jest.fn(async () => true),
      loadRecord: jest.fn(async () => otherScopeRecord),
    });
    const service = new ClaudeNativeMcpCutoverService(deps);

    const admission = await service.resolveLaunchAdmission(createScope());

    expect(admission.allowed).toBe(false);
    expect(admission.status).toBe('review-required');
  });

  it('refuses a confirmation recorded under an older policy version', async () => {
    const scope = createScope();
    const staleRecord: NativeMcpCutoverRecord = {
      policyVersion: POLICY_VERSION - 1,
      scopeKey: resolveNativeMcpScopeKey(scope),
      confirmedAt: 123,
      decision: 'native-config-reviewed',
    };
    const deps = createDeps({
      legacyFileProbe: jest.fn(async () => true),
      loadRecord: jest.fn(async () => staleRecord),
    });
    const service = new ClaudeNativeMcpCutoverService(deps);

    const admission = await service.resolveLaunchAdmission(scope);

    expect(admission.allowed).toBe(false);
    expect(admission.status).toBe('review-required');
    expect(admission.reason).toBe('policy-version-changed');
  });

  describe('confirmCutover', () => {
    it('persists a non-secret ack record and admits subsequent launches', async () => {
      const deps = createDeps({ legacyFileProbe: jest.fn(async () => true) });
      const service = new ClaudeNativeMcpCutoverService(deps);
      const scope = createScope();

      const confirmed = await service.confirmCutover(scope);

      expect(confirmed.ok).toBe(true);
      expect(deps.saveRecord).toHaveBeenCalledTimes(1);
      const saved = (deps.saveRecord as jest.Mock).mock.calls[0][0] as NativeMcpCutoverRecord;
      expect(saved.policyVersion).toBe(POLICY_VERSION);
      expect(saved.decision).toBe('native-config-reviewed');
      expect(saved.scopeKey).toBe(resolveNativeMcpScopeKey(scope));
      expect(Object.keys(saved).sort()).toEqual(['confirmedAt', 'decision', 'policyVersion', 'scopeKey']);
      expect(saved.confirmedAt).toBeGreaterThan(0);

      const admission = await service.resolveLaunchAdmission(scope);
      expect(admission.allowed).toBe(true);
      expect(admission.status).toBe('eligible-confirmed');
    });

    it('stays review-required when the ack write fails (no in-memory pass)', async () => {
      const deps = createDeps({
        legacyFileProbe: jest.fn(async () => true),
        saveRecord: jest.fn(async () => {
          throw new Error('disk full');
        }),
      });
      const service = new ClaudeNativeMcpCutoverService(deps);
      const scope = createScope();

      const confirmed = await service.confirmCutover(scope);

      expect(confirmed.ok).toBe(false);
      const admission = await service.resolveLaunchAdmission(scope);
      expect(admission.allowed).toBe(false);
      expect(admission.status).toBe('review-required');
    });

    it('is idempotent for a repeated confirmation of the same scope', async () => {
      const deps = createDeps({ legacyFileProbe: jest.fn(async () => true) });
      const service = new ClaudeNativeMcpCutoverService(deps);
      const scope = createScope();

      await service.confirmCutover(scope);
      await service.confirmCutover(scope);

      expect(deps.saveRecord).toHaveBeenCalledTimes(2);
      const first = (deps.saveRecord as jest.Mock).mock.calls[0][0] as NativeMcpCutoverRecord;
      const second = (deps.saveRecord as jest.Mock).mock.calls[1][0] as NativeMcpCutoverRecord;
      expect(second.scopeKey).toBe(first.scopeKey);
      expect(second.decision).toBe(first.decision);
    });
  });

  describe('native running observation', () => {
    it('marks an admitted scope as native-running after launch and keeps blocking unadmitted scopes', async () => {
      const deps = createDeps();
      const service = new ClaudeNativeMcpCutoverService(deps);
      const scope = createScope();

      service.markNativeRunning(resolveNativeMcpScopeKey(scope));

      const admission = await service.resolveLaunchAdmission(scope);
      expect(admission.status).toBe('native-running');
      expect(admission.allowed).toBe(true);

      const other = await service.resolveLaunchAdmission(createScope({ cwd: '/tmp/vault-b' }));
      expect(other.status).toBe('eligible-new');
    });

    it('still reports native-running for an admitted scope even with legacy traces present', async () => {
      // A confirmed scope where the launch already happened: the confirmation
      // stays valid (legacy file remaining on disk is expected and inert).
      const scope = createScope();
      const record: NativeMcpCutoverRecord = {
        policyVersion: POLICY_VERSION,
        scopeKey: resolveNativeMcpScopeKey(scope),
        confirmedAt: 123,
        decision: 'native-config-reviewed',
      };
      const deps = createDeps({
        legacyFileProbe: jest.fn(async () => true),
        loadRecord: jest.fn(async () => record),
      });
      const service = new ClaudeNativeMcpCutoverService(deps);
      service.markNativeRunning(record.scopeKey);

      const admission = await service.resolveLaunchAdmission(scope);
      expect(admission.allowed).toBe(true);
      expect(admission.status).toBe('native-running');
    });
  });

  it('never exposes legacy file content: the probe contract carries booleans only', () => {
    // Compile-time contract: CutoverServiceDeps.legacyFileProbe returns a
    // boolean or the unknown sentinel — it cannot return file contents.
    const probe: CutoverServiceDeps['legacyFileProbe'] = jest.fn(async () => true);
    expect(probe).toBeDefined();
  });
});
