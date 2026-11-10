import { stat } from 'fs/promises';

import type { ConversationSizeSnapshot } from '../core/providers/types';

export function sizeSourceRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conversation size source container');
  return value as Readonly<Record<string, unknown>>;
}

export function sizeSourceString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid conversation size source');
  return value;
}

/** A single explicit native file, with no reads, discovery, or source fingerprinting. */
export async function statConversationFile(
  path: string | null | undefined, signal?: AbortSignal,
): Promise<ConversationSizeSnapshot['files']> {
  if (signal?.aborted) throw new Error('Conversation size request aborted');
  if (!path) return { status: 'unknown', reason: 'unavailable' };
  try {
    const info = await stat(path);
    if (signal?.aborted) throw new Error('Conversation size request aborted');
    if (info.isFile() && Number.isSafeInteger(info.size) && info.size >= 0) {
      return { status: 'known', bytes: info.size };
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return { status: 'unknown', reason: 'unavailable' };
}
