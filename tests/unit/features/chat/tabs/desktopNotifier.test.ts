import { notifyBackgroundTabStateChange } from '@/features/chat/tabs/desktopNotifier';

type MockNotificationOptions = { body?: string; silent?: boolean };

describe('notifyBackgroundTabStateChange', () => {
  const created: Array<{ title: string; options?: MockNotificationOptions }> = [];

  class MockNotification {
    static permission: NotificationPermission = 'granted';
    constructor(title: string, options?: MockNotificationOptions) {
      created.push({ title, options });
    }
  }

  let originalNotification: unknown;

  beforeAll(() => {
    originalNotification = (globalThis as unknown as Record<string, unknown>).Notification;
  });

  afterAll(() => {
    (globalThis as unknown as Record<string, unknown>).Notification = originalNotification;
  });

  beforeEach(() => {
    created.length = 0;
    (globalThis as unknown as Record<string, unknown>).Notification = MockNotification;
    MockNotification.permission = 'granted';
  });

  function createPlugin(settings: Record<string, unknown> = {}): any {
    return { settings };
  }

  it('shows a needs-attention notification when permission is granted', () => {
    notifyBackgroundTabStateChange({
      plugin: createPlugin(),
      kind: 'needsAttention',
      tabIndex: 2,
      tabTitle: 'Refactor plan',
    });

    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Claudian');
    expect(created[0].options).toEqual({
      body: 'Tab 2 "Refactor plan" needs your response',
      silent: true,
    });
  });

  it('shows a stream-complete notification', () => {
    notifyBackgroundTabStateChange({
      plugin: createPlugin(),
      kind: 'streamComplete',
      tabIndex: 3,
      tabTitle: 'Data prep',
    });

    expect(created).toHaveLength(1);
    expect(created[0].options).toEqual({
      body: 'Tab 3 "Data prep" finished. Ready for review.',
      silent: true,
    });
  });

  it('treats missing setting as enabled (legacy settings files)', () => {
    notifyBackgroundTabStateChange({
      plugin: createPlugin(),
      kind: 'needsAttention',
      tabIndex: 1,
      tabTitle: 'Any',
    });

    expect(created).toHaveLength(1);
  });

  it('skips when desktopNotifications is disabled', () => {
    notifyBackgroundTabStateChange({
      plugin: createPlugin({ desktopNotifications: false }),
      kind: 'needsAttention',
      tabIndex: 2,
      tabTitle: 'Refactor plan',
    });

    expect(created).toHaveLength(0);
  });

  it('skips when permission is not granted', () => {
    MockNotification.permission = 'denied';

    notifyBackgroundTabStateChange({
      plugin: createPlugin(),
      kind: 'needsAttention',
      tabIndex: 2,
      tabTitle: 'Refactor plan',
    });

    expect(created).toHaveLength(0);
  });

  it('does not throw when Notification is unavailable', () => {
    delete (globalThis as unknown as Record<string, unknown>).Notification;

    expect(() => notifyBackgroundTabStateChange({
      plugin: createPlugin(),
      kind: 'needsAttention',
      tabIndex: 2,
      tabTitle: 'Refactor plan',
    })).not.toThrow();

    expect(created).toHaveLength(0);
  });

  it('does not throw when the Notification constructor throws', () => {
    class ThrowingNotification {
      static permission: NotificationPermission = 'granted';
      constructor() {
        throw new Error('blocked');
      }
    }
    (globalThis as unknown as Record<string, unknown>).Notification = ThrowingNotification;

    expect(() => notifyBackgroundTabStateChange({
      plugin: createPlugin(),
      kind: 'streamComplete',
      tabIndex: 2,
      tabTitle: 'Refactor plan',
    })).not.toThrow();
  });
});
