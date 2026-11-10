import type { ConversationSizeSnapshot } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';

export interface ConversationSizeInfo {
  sizeSnapshot?: ConversationSizeSnapshot;
}

export function formatFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatConversationSize(info: ConversationSizeInfo): string {
  const files = info.sizeSnapshot?.files;
  return files?.status === 'known'
    ? t('chat.history.sessionFileKnown', { size: formatFileBytes(files.bytes) })
    : t('chat.history.sessionFileUnknown');
}

export function formatConversationSizeTooltip(info: ConversationSizeInfo): string {
  return [
    formatConversationSize(info),
    t('chat.history.sessionFileTooltip'),
  ].join(' · ');
}
