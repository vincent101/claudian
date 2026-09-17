import { formatHistoryMessage } from '../../utils/session';
import type { FullHistoryIterable, WritableLike } from '../providers/types';

export async function consumeHistoryText(
  iterable: FullHistoryIterable,
  writer: WritableLike,
): Promise<void> {
  let first = true;
  try {
    for await (const chunk of iterable) {
      for (const message of chunk.messages) {
        const formatted = formatHistoryMessage(message);
        if (formatted === null) continue;
        await writer.write(first ? formatted : `\n\n${formatted}`);
        first = false;
      }
    }
    await writer.close?.();
  } catch (error) {
    await writer.abort?.(error);
    throw error;
  }
}
