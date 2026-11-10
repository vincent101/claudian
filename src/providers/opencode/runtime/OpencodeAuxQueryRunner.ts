import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpReadTextFileRequest,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  extractAcpSessionModelState,
} from '../../acp';
import { decodeOpencodeModelId } from '../models';
import { opencodeChatUIConfig } from '../ui/OpencodeChatUIConfig';
import {
  type OpencodeManagedAgentConfig,
  prepareOpencodeLaunchArtifacts,
} from './OpencodeLaunchArtifacts';
import { buildOpencodeRuntimeEnv } from './OpencodeRuntimeEnvironment';

type OpencodeAuxAgentProfile = 'passive' | 'readonly';
type OpencodeAuxArtifactPurpose = 'inline' | 'instructions' | 'title-gen';

interface OpencodeAuxQueryRunnerOptions {
  agentProfile: OpencodeAuxAgentProfile;
  artifactPurpose: OpencodeAuxArtifactPurpose;
  allowReadTextFile?: boolean;
}

// A query's eligibility is pinned to the runner generation it started with.
// Only an external reset() bumps the generation, so a stale query fails its
// gate checks instead of publishing onto whatever resources replaced it.
interface OpencodeAuxStartupCandidate {
  process: AcpSubprocess;
  transport: AcpJsonRpcTransport;
  connection: AcpClientConnection;
}

const SUPERSEDED_MESSAGE = 'OpenCode aux query was superseded by a reset';

const OPENCODE_AUX_AGENT_IDS: Record<OpencodeAuxAgentProfile, string> = {
  passive: 'claudian-aux-passive',
  readonly: 'claudian-aux-readonly',
};

const OPENCODE_AUX_READ_PERMISSION = Object.freeze({
  '*': 'allow',
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
});

export class OpencodeAuxQueryRunner implements AuxQueryRunner {
  private availableModelIds = new Set<string>();
  private connection: AcpClientConnection | null = null;
  private currentModelId: string | null = null;
  private currentLaunchKey: string | null = null;
  private generation = 0;
  private process: AcpSubprocess | null = null;
  private readonly sessionCwds = new Map<string, string>();
  private sessionId: string | null = null;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private transport: AcpJsonRpcTransport | null = null;

  constructor(
    private readonly plugin: ClaudianPlugin,
    private readonly options: OpencodeAuxQueryRunnerOptions,
  ) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const generation = this.generation;
    const signal = config.abortController?.signal;
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    await this.ensureReady(cwd, config.systemPrompt, generation, signal);
    this.assertCurrentGeneration(generation);

    if (signal?.aborted) {
      throw new Error('Cancelled');
    }

    const connection = this.connection;
    const proc = this.process;
    if (!connection || !proc) {
      throw new Error('OpenCode runtime is not ready.');
    }

    let sessionId = this.sessionId;
    if (!sessionId) {
      sessionId = await this.createSession(connection, cwd, generation);
      if (!sessionId) {
        throw new Error('Failed to create an OpenCode session.');
      }
    }

    const selectedModel = this.resolveSelectedRawModel(config.model);
    const nextModel = this.resolveApplicableModel(selectedModel);
    if (nextModel) {
      const response = await connection.setConfigOption({
        configId: 'model',
        sessionId,
        type: 'select',
        value: nextModel,
      });
      this.assertCurrentGeneration(generation);
      this.syncSessionModelState({
        configOptions: response.configOptions,
      });
    }

    this.sessionUpdateNormalizer.reset();
    let accumulatedText = '';
    const removeListener = connection.onSessionNotification((notification) => {
      if (notification.sessionId !== sessionId) {
        return;
      }

      const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
      if (normalized.type !== 'message_chunk' || normalized.role !== 'assistant') {
        return;
      }

      for (const chunk of normalized.streamChunks) {
        if (chunk.type !== 'text') {
          continue;
        }

        accumulatedText += chunk.content;
        config.onTextChunk?.(accumulatedText);
      }
    });

    // Captured references only: a stale query's abort, error, and cleanup paths
    // must never act on the session or process that replaced it.
    const abortHandler = () => {
      connection.cancel({ sessionId });
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      if (signal?.aborted) {
        throw new Error('Cancelled');
      }

      await connection.prompt({
        prompt: [{ type: 'text', text: prompt }],
        sessionId,
      });

      if (signal?.aborted) {
        throw new Error('Cancelled');
      }

      return accumulatedText;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenCode request failed';
      const stderr = proc.getStderrSnapshot();
      throw new Error(
        stderr ? `${message}\n\n${stderr}` : message,
        error instanceof Error ? { cause: error } : undefined,
      );
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      removeListener();
    }
  }

  reset(): void {
    // Eligibility is revoked first, then resources are detached and disposed,
    // so completions that unblock during teardown read cleared slots and a
    // dead generation instead of reaching whatever comes next.
    this.generation += 1;
    const detached = this.detachResources();
    detached.connection?.dispose();
    detached.transport?.dispose();
    if (detached.process) {
      void detached.process.shutdown().catch(() => {});
    }
    this.availableModelIds.clear();
    this.sessionId = null;
    this.sessionCwds.clear();
    this.currentModelId = null;
    this.currentLaunchKey = null;
    this.sessionUpdateNormalizer.reset();
  }

  private async ensureReady(
    cwd: string,
    systemPrompt: string,
    generation: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const resolvedCliPath = this.plugin.getResolvedProviderCliPath('opencode') ?? 'opencode';

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const runtimeEnv = buildOpencodeRuntimeEnv(settings, resolvedCliPath);
    const auxAgentId = OPENCODE_AUX_AGENT_IDS[this.options.agentProfile];
    const artifacts = await prepareOpencodeLaunchArtifacts({
      artifactsSubdir: `opencode/aux/${this.options.artifactPurpose}`,
      defaultAgentId: auxAgentId,
      managedAgents: [buildOpencodeAuxAgentConfig(this.options.agentProfile)],
      runtimeEnv,
      systemPromptKey: systemPrompt,
      systemPromptText: systemPrompt,
      userName: typeof settings.userName === 'string' ? settings.userName : undefined,
      workspaceRoot: cwd,
    });
    if (signal?.aborted) {
      // A cancellation landing while materials are pending must not spawn.
      throw new Error('Cancelled');
    }
    this.assertCurrentGeneration(generation);
    const nextLaunchKey = JSON.stringify({
      artifactKey: artifacts.launchKey,
      command: resolvedCliPath,
      configPath: artifacts.configPath,
      envText: getRuntimeEnvironmentText(settings, 'opencode'),
    });

    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.currentLaunchKey !== nextLaunchKey;

    if (!shouldRestart) {
      return;
    }

    // An internal relaunch swaps resources without invalidating the calling
    // query's eligibility; only an external reset() bumps the generation.
    this.teardownResources();
    const candidate = this.launchStartupCandidate({
      command: resolvedCliPath,
      configPath: artifacts.configPath,
      configContent: artifacts.configContent,
      cwd,
      runtimeEnv,
    });
    this.process = candidate.process;
    this.transport = candidate.transport;
    this.connection = candidate.connection;
    await candidate.connection.initialize();
    if (signal?.aborted || !this.isCurrentGeneration(generation)) {
      this.reclaimCandidate(candidate);
      throw signal?.aborted ? new Error('Cancelled') : new Error(SUPERSEDED_MESSAGE);
    }
    this.currentLaunchKey = nextLaunchKey;
  }

  private async createSession(
    connection: AcpClientConnection,
    cwd: string,
    generation: number,
  ): Promise<string | null> {
    try {
      const response = await connection.newSession({
        cwd,
        mcpServers: [],
      });
      this.assertCurrentGeneration(generation);
      this.syncSessionModelState({
        configOptions: response.configOptions ?? null,
        models: response.models ?? null,
      });
      await connection.setConfigOption({
        configId: 'mode',
        sessionId: response.sessionId,
        type: 'select',
        value: OPENCODE_AUX_AGENT_IDS[this.options.agentProfile],
      });
      this.assertCurrentGeneration(generation);
      this.sessionId = response.sessionId;
      this.sessionCwds.set(response.sessionId, cwd);
      return response.sessionId;
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) {
        throw new Error(SUPERSEDED_MESSAGE, { cause: error });
      }
      return null;
    }
  }

  private launchStartupCandidate(params: {
    command: string;
    configPath: string;
    configContent: string;
    cwd: string;
    runtimeEnv: NodeJS.ProcessEnv;
  }): OpencodeAuxStartupCandidate {
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...params.runtimeEnv,
      OPENCODE_CONFIG: params.configPath,
      OPENCODE_CONFIG_CONTENT: params.configContent,
      PATH: params.runtimeEnv.PATH,
    };

    const proc = new AcpSubprocess({
      args: ['acp', `--cwd=${params.cwd}`],
      command: params.command,
      cwd: params.cwd,
      env: processEnv,
    });
    proc.start();

    const transport = new AcpJsonRpcTransport({
      input: proc.stdout,
      onClose: (listener) => proc.onClose(listener),
      output: proc.stdin,
    });

    const connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian-aux',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        fileSystem: this.options.allowReadTextFile
          ? {
            readTextFile: (request) => this.readTextFile(request),
          }
          : undefined,
        requestPermission: (request) => this.handlePermissionRequest(request),
      },
      transport,
    });

    transport.start();
    return { connection, process: proc, transport };
  }

  private detachResources(): {
    process: AcpSubprocess | null;
    transport: AcpJsonRpcTransport | null;
    connection: AcpClientConnection | null;
  } {
    const detached = {
      process: this.process,
      transport: this.transport,
      connection: this.connection,
    };
    this.process = null;
    this.transport = null;
    this.connection = null;
    return detached;
  }

  private teardownResources(): void {
    const detached = this.detachResources();
    detached.connection?.dispose();
    detached.transport?.dispose();
    if (detached.process) {
      void detached.process.shutdown().catch(() => {});
    }
    this.currentLaunchKey = null;
  }

  // A candidate that lost its startup race is shut down on its own references;
  // slots are only cleared when they still point at this candidate, so a
  // replacement is never torn down by a stale reclaim.
  private reclaimCandidate(candidate: OpencodeAuxStartupCandidate): void {
    if (this.process === candidate.process) {
      this.process = null;
    }
    if (this.transport === candidate.transport) {
      this.transport = null;
    }
    if (this.connection === candidate.connection) {
      this.connection = null;
    }
    candidate.connection.dispose();
    candidate.transport.dispose();
    void candidate.process.shutdown().catch(() => {});
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.generation;
  }

  private assertCurrentGeneration(generation: number): void {
    if (!this.isCurrentGeneration(generation)) {
      throw new Error(SUPERSEDED_MESSAGE);
    }
  }

  private async readTextFile(
    request: AcpReadTextFileRequest,
  ): Promise<{ content: string }> {
    const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
    const content = await fs.readFile(resolvedPath, 'utf-8');

    if (request.line === undefined && request.limit === undefined) {
      return { content };
    }

    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, (request.line ?? 1) - 1);
    const endIndex = request.limit
      ? startIndex + Math.max(0, request.limit)
      : lines.length;

    return {
      content: lines.slice(startIndex, endIndex).join('\n'),
    };
  }

  private async handlePermissionRequest(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    return selectPermissionOption(request.options, ['reject_once', 'reject_always']);
  }

  private resolveSelectedRawModel(explicitModel?: string): string | undefined {
    const projectedSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'opencode',
    );
    if (explicitModel) {
      const trimmed = explicitModel.trim();
      if (!trimmed) {
        return undefined;
      }
      return opencodeChatUIConfig.ownsModel(trimmed, projectedSettings)
        ? decodeOpencodeModelId(trimmed) ?? undefined
        : trimmed;
    }

    const selectedModel = typeof projectedSettings.model === 'string'
      ? projectedSettings.model
      : '';
    return opencodeChatUIConfig.ownsModel(selectedModel, projectedSettings)
      ? decodeOpencodeModelId(selectedModel) ?? undefined
      : undefined;
  }

  private resolveApplicableModel(selectedModel: string | undefined): string | null {
    if (!selectedModel) {
      return null;
    }
    if (selectedModel === this.currentModelId) {
      return null;
    }
    if (this.availableModelIds.size === 0) {
      return selectedModel;
    }
    return this.availableModelIds.has(selectedModel)
      ? selectedModel
      : null;
  }

  private syncSessionModelState(params: {
    configOptions?: Parameters<typeof extractAcpSessionModelState>[0]['configOptions'];
    models?: Parameters<typeof extractAcpSessionModelState>[0]['models'];
  }): void {
    const state = extractAcpSessionModelState(params);
    this.currentModelId = state.currentModelId;
    this.availableModelIds = new Set(state.availableModels.map((model) => model.id));
  }

  private resolveSessionPath(sessionId: string, rawPath: string): string {
    const cwd = this.sessionCwds.get(sessionId)
      ?? getVaultPath(this.plugin.app)
      ?? process.cwd();
    const resolvedPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(cwd, rawPath);
    const relative = path.relative(cwd, resolvedPath);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return resolvedPath;
    }

    throw new Error('OpenCode aux read access is limited to the current workspace.');
  }
}

function buildOpencodeAuxAgentConfig(profile: OpencodeAuxAgentProfile): OpencodeManagedAgentConfig {
  const id = OPENCODE_AUX_AGENT_IDS[profile];
  if (profile === 'readonly') {
    return {
      definition: {
        description: 'Internal Claudian read-only agent for OpenCode auxiliary tasks.',
        mode: 'primary',
        permission: {
          '*': 'deny',
          codesearch: 'allow',
          external_directory: 'deny',
          glob: 'allow',
          grep: 'allow',
          lsp: 'allow',
          read: OPENCODE_AUX_READ_PERMISSION,
          webfetch: 'allow',
          websearch: 'allow',
        },
      },
      id,
    };
  }

  return {
    definition: {
      description: 'Internal Claudian no-tool agent for OpenCode auxiliary tasks.',
      mode: 'primary',
      permission: {
        '*': 'deny',
        external_directory: 'deny',
      },
    },
    id,
  };
}

function selectPermissionOption(
  options: readonly {
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    optionId: string;
  }[],
  preferredKinds: readonly ('allow_once' | 'allow_always' | 'reject_once' | 'reject_always')[],
): AcpRequestPermissionResponse {
  for (const kind of preferredKinds) {
    const option = options.find((entry) => entry.kind === kind);
    if (option) {
      return {
        outcome: {
          optionId: option.optionId,
          outcome: 'selected',
        },
      };
    }
  }

  return { outcome: { outcome: 'cancelled' } };
}
