import { readFileSync } from 'fs';

import type {
  ConversationHistoryHydrationResult,
  ConversationSizeReadInput,
  ConversationSizeReadResult,
  ConversationSizeSource,
  ProviderConversationHistoryService,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { sizeSourceRecord, sizeSourceString, statConversationFile } from '../../../utils/conversationSizeSource';
import type { CodexProviderState } from '../types';
import { getCodexState } from '../types';
import {
  type CodexParsedTurn,
  deriveCodexSessionsRootFromSessionPath,
  findCodexSessionFile,
  parseCodexSessionTurns,
} from './CodexHistoryStore';

function readSessionTurns(sessionFilePath: string): { turns: CodexParsedTurn[] } {
  try {
    return { turns: parseCodexSessionTurns(readFileSync(sessionFilePath, 'utf-8')) };
  } catch {
    return { turns: [] };
  }
}

export class CodexConversationHistoryService implements ProviderConversationHistoryService {
  private hydratedConversationPaths = new Map<string, string>();

  captureConversationSizeSource(conversation: Conversation): ConversationSizeSource {
    const state = getCodexState(sizeSourceRecord(conversation.providerState));
    return Object.freeze({ filePath: sizeSourceString(state.sessionFilePath) ?? null });
  }

  async readConversationSize(
    input: ConversationSizeReadInput,
    _vaultPath: string | null,
    options: { revision: number; signal?: AbortSignal },
  ): Promise<ConversationSizeReadResult> {
    const path = input.providerId === 'codex' ? sizeSourceString(input.source.filePath) : null;
    return { snapshot: {
      conversationId: input.id, revision: options.revision,
      files: await statConversationFile(path, options.signal),
    } };
  }

  async hydrateConversationHistory(
    conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<ConversationHistoryHydrationResult> {
    const state = getCodexState(conversation.providerState);
    const transcriptRootPath = state.transcriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(state.sessionFilePath);
    const ready = (): ConversationHistoryHydrationResult => ({ status: 'ready' });

    // Pending fork with existing in-memory messages: keep them as-is
    if (this.isPendingForkConversation(conversation) && conversation.messages.length > 0) {
      return ready();
    }

    // Pending fork without messages: hydrate from source transcript truncated at resumeAt
    if (this.isPendingForkConversation(conversation)) {
      const sourceSessionFile = this.resolveSourceSessionFile(state);
      if (!sourceSessionFile) return ready();

      const source = readSessionTurns(sourceSessionFile);
      const resumeAt = state.forkSource!.resumeAt;
      const truncated = this.truncateTurnsAtCheckpoint(source.turns, resumeAt);
      if (!truncated) {
        this.hydratedConversationPaths.delete(conversation.id);
        return ready();
      }
      const sourceRoot = state.forkSourceTranscriptRootPath
        ?? deriveCodexSessionsRootFromSessionPath(sourceSessionFile);
      if (!state.forkSourceSessionFilePath || (sourceRoot && state.forkSourceTranscriptRootPath == null)) {
        conversation.providerState = {
          ...(conversation.providerState ?? {}),
          forkSourceSessionFilePath: sourceSessionFile,
          ...(sourceRoot && state.forkSourceTranscriptRootPath == null ? { forkSourceTranscriptRootPath: sourceRoot } : {}),
        };
      }
      conversation.messages = truncated.flatMap(t => t.messages);
      return ready();
    }

    // Established fork: source prefix + fork-only turns
    if (state.forkSource && state.threadId) {
      const sourceSessionFile = this.resolveSourceSessionFile(state);
      const forkSessionFile = state.sessionFilePath ?? (
        state.threadId
          ? findCodexSessionFile(state.threadId, transcriptRootPath ?? undefined)
          : null
      );

      if (sourceSessionFile && forkSessionFile) {
        const source = readSessionTurns(sourceSessionFile);
        const fork = readSessionTurns(forkSessionFile);

        const resumeAt = state.forkSource.resumeAt;
        const sourcePrefix = this.truncateTurnsAtCheckpoint(source.turns, resumeAt);
        if (!sourcePrefix) {
          this.hydratedConversationPaths.delete(conversation.id);
          return ready();
        }
        const sourceTurnIds = new Set(source.turns.map(turn => turn.turnId).filter(Boolean));
        const forkOnlyTurns = fork.turns.filter(turn => !turn.turnId || !sourceTurnIds.has(turn.turnId));

        const messages = [
          ...sourcePrefix.flatMap(t => t.messages),
          ...forkOnlyTurns.flatMap(t => t.messages),
        ];
        const sourceRoot = state.forkSourceTranscriptRootPath
          ?? deriveCodexSessionsRootFromSessionPath(sourceSessionFile);
        const nativeRoot = transcriptRootPath ?? deriveCodexSessionsRootFromSessionPath(forkSessionFile);
        if (!state.forkSourceSessionFilePath || !state.sessionFilePath
          || (sourceRoot && state.forkSourceTranscriptRootPath == null)
          || (nativeRoot && state.transcriptRootPath == null)) {
          conversation.providerState = {
            ...(conversation.providerState ?? {}),
            forkSourceSessionFilePath: sourceSessionFile,
            sessionFilePath: forkSessionFile,
            ...(sourceRoot && state.forkSourceTranscriptRootPath == null ? { forkSourceTranscriptRootPath: sourceRoot } : {}),
            ...(nativeRoot && state.transcriptRootPath == null ? { transcriptRootPath: nativeRoot } : {}),
          };
        }
        if (messages.length === 0) {
          this.hydratedConversationPaths.delete(conversation.id);
          return ready();
        }

        conversation.messages = messages;
        this.hydratedConversationPaths.set(conversation.id, `fork::${state.threadId}`);
        return ready();
      }
    }

    // Normal hydration
    const threadId = state.threadId ?? conversation.sessionId ?? null;
    const sessionFilePath = state.sessionFilePath ?? (
      threadId
        ? findCodexSessionFile(threadId, transcriptRootPath ?? undefined)
        : null
    );
    const resolvedTranscriptRootPath = transcriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(sessionFilePath);

    if (!sessionFilePath) {
      this.hydratedConversationPaths.delete(conversation.id);
      return ready();
    }

    const hydrationKey = `${threadId ?? ''}::${sessionFilePath}`;
    if (
      conversation.messages.length > 0
      && this.hydratedConversationPaths.get(conversation.id) === hydrationKey
    ) {
      return ready();
    }

    if (sessionFilePath !== state.sessionFilePath) {
      conversation.providerState = {
        ...(conversation.providerState ?? {}),
        ...(threadId ? { threadId } : {}),
        sessionFilePath,
        ...(resolvedTranscriptRootPath ? { transcriptRootPath: resolvedTranscriptRootPath } : {}),
      };
    } else if (resolvedTranscriptRootPath && resolvedTranscriptRootPath !== state.transcriptRootPath) {
      conversation.providerState = {
        ...(conversation.providerState ?? {}),
        ...(threadId ? { threadId } : {}),
        transcriptRootPath: resolvedTranscriptRootPath,
      };
    }

    const parsed = readSessionTurns(sessionFilePath);
    const sdkMessages = parsed.turns.flatMap(turn => turn.messages);
    if (sdkMessages.length === 0) {
      this.hydratedConversationPaths.delete(conversation.id);
      return ready();
    }

    conversation.messages = sdkMessages;
    this.hydratedConversationPaths.set(conversation.id, hydrationKey);
    return ready();
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
  ): Promise<void> {
    // Never delete ~/.codex transcripts
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) return null;
    const state = getCodexState(conversation.providerState);
    return state.threadId ?? conversation.sessionId ?? state.forkSource?.sessionId ?? null;
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    const state = getCodexState(conversation.providerState);
    return !!state.forkSource && !state.threadId && !conversation.sessionId;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    const sourceState = getCodexState(sourceProviderState);
    const sourceTranscriptRootPath = sourceState.transcriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(sourceState.sessionFilePath);
    const providerState: CodexProviderState = {
      forkSource: { sessionId: sourceSessionId, resumeAt },
      ...(sourceState.sessionFilePath ? { forkSourceSessionFilePath: sourceState.sessionFilePath } : {}),
      ...(
        sourceTranscriptRootPath
          ? { forkSourceTranscriptRootPath: sourceTranscriptRootPath }
          : {}
      ),
    };
    return providerState as Record<string, unknown>;
  }

  buildPersistedProviderState(
    conversation: Conversation,
  ): Record<string, unknown> | undefined {
    const entries = Object.entries(getCodexState(conversation.providerState))
      .filter(([, value]) => value !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveSourceSessionFile(state: CodexProviderState): string | null {
    if (!state.forkSource) return null;
    const sourceTranscriptRootPath = state.forkSourceTranscriptRootPath
      ?? deriveCodexSessionsRootFromSessionPath(state.forkSourceSessionFilePath);
    return state.forkSourceSessionFilePath
      ?? findCodexSessionFile(state.forkSource.sessionId, sourceTranscriptRootPath ?? undefined);
  }

  private truncateTurnsAtCheckpoint(
    turns: CodexParsedTurn[],
    resumeAt: string,
  ): CodexParsedTurn[] | null {
    const checkpointIndex = turns.findIndex(turn => turn.turnId === resumeAt);
    if (checkpointIndex < 0) {
      return null;
    }

    return turns.slice(0, checkpointIndex + 1);
  }
}
