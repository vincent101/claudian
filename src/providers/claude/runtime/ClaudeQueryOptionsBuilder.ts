import type {
  CanUseTool,
  Options,
  PermissionMode as SDKPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';

import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import type { AppPluginManager } from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types/settings';
import {
  resolveClaudeRuntimePermissionMode,
  resolveClaudeSdkPermissionModeForRuntime,
} from '../permissionModes';
import {
  getClaudeProviderSettings,
  resolveClaudeSettingSources,
} from '../settings';
import {
  resolveAdaptiveEffortLevel,
  resolveThinkingTokens,
} from '../types/models';
import { createCustomSpawnFunction } from './customSpawn';
import {
  DISABLED_BUILTIN_SUBAGENTS,
  type PersistentQueryConfig,
  UNSUPPORTED_SDK_TOOLS,
} from './types';

export interface QueryOptionsContext {
  vaultPath: string;
  cliPath: string;
  settings: ClaudianSettings;
  customEnv: Record<string, string>;
  enhancedPath: string;
  pluginManager: AppPluginManager;
}

export interface PersistentQueryContext extends QueryOptionsContext {
  abortController?: AbortController;
  resume?: {
    sessionId: string;
    sessionAt?: string;
    fork?: boolean;
  };
  canUseTool?: CanUseTool;
  hooks: Options['hooks'];
  externalContextPaths?: string[];
  /** Query-scope-bound CLI exit notification (retirement rebuild waits for the real exit). */
  onProcessExit?: (code: number | null) => void;
}

export interface ColdStartQueryContext extends QueryOptionsContext {
  abortController?: AbortController;
  sessionId?: string;
  modelOverride?: string;
  canUseTool?: CanUseTool;
  hooks: Options['hooks'];
  allowedTools?: string[];
  hasEditorContext: boolean;
  externalContextPaths?: string[];
}

export class QueryOptionsBuilder {
  static needsRestart(
    currentConfig: PersistentQueryConfig | null,
    newConfig: PersistentQueryConfig
  ): boolean {
    if (!currentConfig) return true;

    // These require restart (cannot be updated dynamically)
    if (currentConfig.systemPromptKey !== newConfig.systemPromptKey) return true;
    if (currentConfig.disallowedToolsKey !== newConfig.disallowedToolsKey) return true;
    if (currentConfig.pluginsKey !== newConfig.pluginsKey) return true;
    if (currentConfig.settingSources !== newConfig.settingSources) return true;
    if (currentConfig.claudeCliPath !== newConfig.claudeCliPath) return true;

    // Note: Permission mode is handled dynamically via setPermissionMode() in ClaudianService.
    // Since allowDangerouslySkipPermissions is always true, both directions work without restart.

    if (currentConfig.enableChrome !== newConfig.enableChrome) return true;
    if (currentConfig.enableAutoMode !== newConfig.enableAutoMode) return true;

    // External context paths require restart (additionalDirectories can't be updated dynamically)
    if (QueryOptionsBuilder.pathsChanged(currentConfig.externalContextPaths, newConfig.externalContextPaths)) {
      return true;
    }

    return false;
  }

  static buildPersistentQueryConfig(
    ctx: QueryOptionsContext,
    externalContextPaths?: string[]
  ): PersistentQueryConfig {
    const claudeSettings = getClaudeProviderSettings(ctx.settings as unknown as Record<string, unknown>);
    const systemPromptSettings: SystemPromptSettings = {
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
    };

    const permissionMode = resolveClaudeRuntimePermissionMode(
      ctx.settings.permissionMode,
      ctx.settings as unknown as Record<string, unknown>,
    );
    const sdkPermissionMode = resolveClaudeSdkPermissionModeForRuntime(permissionMode);

    const disallowedToolsKey = [...UNSUPPORTED_SDK_TOOLS, ...DISABLED_BUILTIN_SUBAGENTS].join('|');
    const pluginsKey = ctx.pluginManager.getPluginsKey();

    const settingSources = resolveClaudeSettingSources(claudeSettings.loadUserSettings);

    return {
      model: ctx.settings.model,
      thinkingTokens: resolveThinkingTokens(ctx.settings.model, ctx.settings.thinkingBudget),
      effortLevel: resolveAdaptiveEffortLevel(ctx.settings.model, ctx.settings.effortLevel),
      permissionMode,
      sdkPermissionMode,
      systemPromptKey: computeSystemPromptKey(systemPromptSettings),
      disallowedToolsKey,
      pluginsKey,
      externalContextPaths: externalContextPaths || [],
      settingSources: settingSources.join(','),
      claudeCliPath: ctx.cliPath,
      enableChrome: claudeSettings.enableChrome,
      // Auto mode stays available on every launch so permission switches
      // remain live setters (design §5.1).
      enableAutoMode: true,
    };
  }

  static buildPersistentQueryOptions(ctx: PersistentQueryContext): Options {
    const { options } = QueryOptionsBuilder.buildBaseOptions(
      ctx,
      ctx.settings.model,
      ctx.abortController,
      ctx.onProcessExit,
    );

    options.disallowedTools = [
      ...UNSUPPORTED_SDK_TOOLS,
      ...DISABLED_BUILTIN_SUBAGENTS,
    ];

    QueryOptionsBuilder.applyPermissionMode(
      options,
      ctx.settings.permissionMode,
      ctx.settings as unknown as Record<string, unknown>,
      ctx.canUseTool,
    );
    QueryOptionsBuilder.applyThinking(options, ctx.settings, ctx.settings.model);
    options.hooks = ctx.hooks;

    options.enableFileCheckpointing = true;

    if (ctx.resume) {
      options.resume = ctx.resume.sessionId;
      if (ctx.resume.sessionAt) {
        options.resumeSessionAt = ctx.resume.sessionAt;
      }
      if (ctx.resume.fork) {
        options.forkSession = true;
      }
    }

    if (ctx.externalContextPaths && ctx.externalContextPaths.length > 0) {
      options.additionalDirectories = ctx.externalContextPaths;
    }

    return options;
  }

  static buildColdStartQueryOptions(ctx: ColdStartQueryContext): Options {
    const selectedModel = ctx.modelOverride ?? ctx.settings.model;
    const { options } = QueryOptionsBuilder.buildBaseOptions(
      ctx,
      selectedModel,
      ctx.abortController,
    );

    options.disallowedTools = [
      ...UNSUPPORTED_SDK_TOOLS,
      ...DISABLED_BUILTIN_SUBAGENTS,
    ];

    QueryOptionsBuilder.applyPermissionMode(
      options,
      ctx.settings.permissionMode,
      ctx.settings as unknown as Record<string, unknown>,
      ctx.canUseTool,
    );
    options.hooks = ctx.hooks;
    QueryOptionsBuilder.applyThinking(options, ctx.settings, ctx.modelOverride ?? ctx.settings.model);

    if (ctx.allowedTools !== undefined && ctx.allowedTools.length > 0) {
      options.tools = ctx.allowedTools;
    }

    if (ctx.sessionId) {
      options.resume = ctx.sessionId;
    }

    if (ctx.externalContextPaths && ctx.externalContextPaths.length > 0) {
      options.additionalDirectories = ctx.externalContextPaths;
    }

    return options;
  }

  static resolveClaudeSdkPermissionMode(
    permissionMode: unknown,
    settings?: Record<string, unknown>,
  ): SDKPermissionMode {
    const runtimeMode = resolveClaudeRuntimePermissionMode(permissionMode, settings);
    return resolveClaudeSdkPermissionModeForRuntime(runtimeMode);
  }

  private static applyPermissionMode(
    options: Options,
    permissionMode: unknown,
    settings: Record<string, unknown>,
    canUseTool?: CanUseTool
  ): void {
    // Allows a future explicit switch to YOLO without a restart; it does NOT
    // mean the current mode bypasses approvals. canUseTool stays registered
    // in every mode (design §5.1).
    options.allowDangerouslySkipPermissions = true;

    if (canUseTool) {
      options.canUseTool = canUseTool;
    }

    options.permissionMode = QueryOptionsBuilder.resolveClaudeSdkPermissionMode(
      permissionMode,
      settings,
    );
  }

  private static applyExtraArgs(
    options: Options,
    settings: { enableChrome: boolean },
  ): void {
    // Auto mode stays available on every launch so permission switches remain
    // live setters instead of restarts (design §5.1).
    options.extraArgs = { ...options.extraArgs, 'enable-auto-mode': null };

    if (settings.enableChrome) {
      options.extraArgs = { ...options.extraArgs, chrome: null };
    }
  }

  private static buildBaseOptions(
    ctx: QueryOptionsContext,
    model: string,
    abortController?: AbortController,
    onProcessExit?: (code: number | null) => void,
  ): { options: Options; claudeSettings: ReturnType<typeof getClaudeProviderSettings> } {
    const claudeSettings = getClaudeProviderSettings(ctx.settings as unknown as Record<string, unknown>);
    const systemPromptSettings: SystemPromptSettings = {
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
    };
    const options: Options = {
      cwd: ctx.vaultPath,
      systemPrompt: buildSystemPrompt(systemPromptSettings),
      model,
      abortController,
      pathToClaudeCodeExecutable: ctx.cliPath,
      settingSources: resolveClaudeSettingSources(claudeSettings.loadUserSettings),
      env: {
        ...process.env,
        ...ctx.customEnv,
        PATH: ctx.enhancedPath,
      },
      includePartialMessages: true,
    };

    QueryOptionsBuilder.applyExtraArgs(options, claudeSettings);
    options.spawnClaudeCodeProcess = createCustomSpawnFunction(ctx.enhancedPath, onProcessExit);

    return { options, claudeSettings };
  }

  private static applyThinking(
    options: Options,
    settings: ClaudianSettings,
    model: string
  ): void {
    const effortLevel = resolveAdaptiveEffortLevel(model, settings.effortLevel);
    if (effortLevel !== null) {
      options.thinking = { type: 'adaptive' };
      // SDK runtime accepts `xhigh` on Opus 4.7+ and silently falls back to
      // `high` elsewhere, but its type definition lags our local EffortLevel.
      options.effort = effortLevel as Options['effort'];
      return;
    }

    const thinkingTokens = resolveThinkingTokens(model, settings.thinkingBudget);
    if (thinkingTokens !== null) {
      options.maxThinkingTokens = thinkingTokens;
    }
  }

  private static pathsChanged(a?: string[], b?: string[]): boolean {
    const aKey = [...(a || [])].sort().join('|');
    const bKey = [...(b || [])].sort().join('|');
    return aKey !== bKey;
  }

}
