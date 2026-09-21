import type {
  AutoTurnCancelledEvent,
  AutoTurnChunkEvent,
  AutoTurnFinishedEvent,
  AutoTurnStartedEvent,
} from '../../../core/runtime/types';
import type { TranscriptTurnFact } from './ClaudeTranscriptTurnMapper';

/**
 * Legacy auto-turn events. Batch 1 keeps the observer/feature contract on
 * these shapes; the mapper speaks facts only and this adapter is the single
 * place that turns facts back into the legacy projection events.
 */
export type TranscriptTurnEvent =
  | { type: 'started'; event: AutoTurnStartedEvent }
  | { type: 'embedded'; event: AutoTurnStartedEvent }
  | { type: 'chunk'; event: AutoTurnChunkEvent; identity: string }
  | { type: 'finished'; event: AutoTurnFinishedEvent }
  | { type: 'interrupted'; event: AutoTurnCancelledEvent };

export interface TranscriptFactAdaptationContext {
  hostUserTurnActive: boolean;
}

/**
 * Adapts transcript facts onto the legacy event stream (batch 1 §3.1):
 * - external starts project as started/embedded exactly as before;
 * - host-row starts never open observer turns (the host runtime owns them);
 * - terminal evidence keeps the legacy `finished` shape, with the evidence
 *   level (terminalKind) retained on the fact for reconciliation consumers.
 */
export function adaptTranscriptFacts(
  facts: TranscriptTurnFact[],
  context: TranscriptFactAdaptationContext,
): TranscriptTurnEvent[] {
  const events: TranscriptTurnEvent[] = [];
  for (const fact of facts) {
    switch (fact.type) {
      case 'observed_start': {
        if (!fact.source) continue;
        const event: AutoTurnStartedEvent = {
          turnId: fact.identity.canonicalTurnId,
          generation: fact.identity.generation,
          source: fact.source,
          ...(fact.showUser && fact.displayContent ? { displayContent: fact.displayContent } : {}),
          transcriptUserId: fact.identity.transcriptUserId,
          replay: fact.replay,
        };
        if (context.hostUserTurnActive && fact.showUser) {
          events.push({ type: 'embedded', event });
        } else {
          events.push({ type: 'started', event });
        }
        continue;
      }
      case 'observed_chunk': {
        events.push({
          type: 'chunk',
          identity: fact.identity,
          event: {
            turnId: fact.canonicalTurnId,
            generation: fact.generation,
            chunk: fact.chunk,
            transcriptIdentity: fact.identity,
            replay: fact.replay,
          },
        });
        continue;
      }
      case 'observed_terminal': {
        events.push({
          type: 'finished',
          event: {
            turnId: fact.identity.canonicalTurnId,
            generation: fact.identity.generation,
            metadata: fact.metadata,
            replay: fact.replay,
            terminalOffset: fact.lineOffset,
          },
        });
        continue;
      }
      case 'observed_interrupted': {
        events.push({
          type: 'interrupted',
          event: {
            turnId: fact.identity.canonicalTurnId,
            generation: fact.nextGeneration,
            reason: fact.reason,
            interrupted: true,
          },
        });
        continue;
      }
    }
  }
  return events;
}
