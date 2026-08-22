import { t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';

export type DesktopNotificationKind = 'needsAttention' | 'streamComplete';

export type BackgroundTabNotification = {
  plugin: ClaudianPlugin;
  kind: DesktopNotificationKind;
  /** 1-based tab position as shown in the tab bar. */
  tabIndex: number;
  tabTitle: string;
};

const NOTIFICATION_TITLE = 'Claudian';

/**
 * Notifies the desktop OS that a background tab crossed a state edge
 * (needs response / finished streaming). Permission and settings gating lives
 * here so TabManager stays free of notification policy; failures are silent
 * because notifications must never break the chat state flow.
 */
export function notifyBackgroundTabStateChange({
  plugin,
  kind,
  tabIndex,
  tabTitle,
}: BackgroundTabNotification): void {
  // Undefined means "default on" so pre-existing settings files keep notifying.
  if (plugin.settings.desktopNotifications === false) {
    return;
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return;
  }

  const body = t(
    kind === 'needsAttention'
      ? 'chat.notifications.needsAttention'
      : 'chat.notifications.streamComplete',
    { index: tabIndex, title: tabTitle },
  );

  try {
    new Notification(NOTIFICATION_TITLE, { body, silent: true });
  } catch {
    // Notification construction can throw in locked-down environments.
  }
}
