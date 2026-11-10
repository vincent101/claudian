import { appendContextFiles } from '../../utils/context';
import {
  buildInlineEditPrompt,
  getInlineEditSystemPrompt,
  parseInlineEditResponse,
} from '../prompt/inlineEdit';
import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService,
} from '../providers/types';
import type { AuxQueryRunner } from './AuxQueryRunner';

export class QueryBackedInlineEditService implements InlineEditService {
  private conversationToken = 0;
  private hasConversation = false;
  private modelOverride: string | undefined;
  private readonly pendingControllers = new Set<AbortController>();

  constructor(private readonly runner: AuxQueryRunner) {}

  setModelOverride(model?: string): void {
    const trimmed = model?.trim();
    this.modelOverride = trimmed ? trimmed : undefined;
  }

  resetConversation(): void {
    // Invalidation precedes local clearing, which precedes runner teardown, so
    // any completion that a reset unblocks can never publish stale state.
    this.conversationToken += 1;
    this.hasConversation = false;
    this.runner.reset();
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.resetConversation();
    return this.sendMessage(buildInlineEditPrompt(request));
  }

  async continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult> {
    if (!this.hasConversation) {
      return { success: false, error: 'No active conversation to continue' };
    }

    let prompt = message;
    if (contextFiles && contextFiles.length > 0) {
      prompt = appendContextFiles(message, contextFiles);
    }
    return this.sendMessage(prompt);
  }

  cancel(): void {
    for (const abortController of this.pendingControllers) {
      abortController.abort();
    }
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
    const conversationToken = this.conversationToken;
    const abortController = new AbortController();
    this.pendingControllers.add(abortController);

    try {
      const text = await this.runner.query({
        abortController,
        model: this.modelOverride,
        systemPrompt: getInlineEditSystemPrompt(),
      }, prompt);
      if (this.canPublishCompletion(conversationToken, abortController)) {
        this.hasConversation = true;
      }
      return parseInlineEditResponse(text);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.pendingControllers.delete(abortController);
    }
  }

  private canPublishCompletion(conversationToken: number, abortController: AbortController): boolean {
    return conversationToken === this.conversationToken && !abortController.signal.aborted;
  }
}
