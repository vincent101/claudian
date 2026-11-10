import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import {
  buildInlineEditPrompt,
  getInlineEditSystemPrompt,
  parseInlineEditResponse,
} from '../../../core/prompt/inlineEdit';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  InlineEditRequest,
  InlineEditResult,
} from '../../../core/providers/types';
import {
  isReadOnlyTool,
  READ_ONLY_TOOLS,
} from '../../../core/tools/toolNames';
import type ClaudianPlugin from '../../../main';
import { appendContextFiles } from '../../../utils/context';
import { runColdStartQuery } from '../runtime/claudeColdStartQuery';

export type { InlineEditRequest };

export function createReadOnlyHook(): HookCallbackMatcher {
  return {
    hooks: [
      async (hookInput) => {
        const input = hookInput as {
          tool_name: string;
          tool_input: Record<string, unknown>;
        };
        const toolName = input.tool_name;

        if (isReadOnlyTool(toolName)) {
          return { continue: true };
        }

        return {
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `Inline edit mode: tool "${toolName}" is not allowed (read-only)`,
          },
        };
      },
    ],
  };
}

export class InlineEditService {
  private conversationToken = 0;
  private readonly pendingControllers = new Set<AbortController>();
  private plugin: ClaudianPlugin;
  private sessionId: string | null = null;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  private getScopedSettings(): Record<string, unknown> {
    return ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'claude',
    );
  }

  resetConversation(): void {
    // Invalidation precedes local clearing so a completion that unblocks after
    // a reset can never publish a stale session id.
    this.conversationToken += 1;
    this.sessionId = null;
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.resetConversation();
    const prompt = buildInlineEditPrompt(request);
    return this.sendMessage(prompt);
  }

  async continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult> {
    if (!this.sessionId) {
      return { success: false, error: 'No active conversation to continue' };
    }
    let prompt = message;
    if (contextFiles && contextFiles.length > 0) {
      prompt = appendContextFiles(message, contextFiles);
    }
    return this.sendMessage(prompt);
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
    const settings = this.getScopedSettings();
    const conversationToken = this.conversationToken;
    const abortController = new AbortController();
    this.pendingControllers.add(abortController);

    const hooks = {
      PreToolUse: [createReadOnlyHook()],
    };

    try {
      const result = await runColdStartQuery({
        plugin: this.plugin,
        systemPrompt: getInlineEditSystemPrompt(),
        tools: [...READ_ONLY_TOOLS],
        hooks,
        resumeSessionId: this.sessionId ?? undefined,
        abortController,
        providerSettings: settings,
      }, prompt);

      if (this.canPublishCompletion(conversationToken, abortController)) {
        this.sessionId = result.sessionId;
      }
      return parseInlineEditResponse(result.text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.pendingControllers.delete(abortController);
    }
  }

  private canPublishCompletion(conversationToken: number, abortController: AbortController): boolean {
    return conversationToken === this.conversationToken && !abortController.signal.aborted;
  }

  cancel(): void {
    for (const abortController of this.pendingControllers) {
      abortController.abort();
    }
  }
}
