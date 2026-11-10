import '@/providers';

import { getTabProviderId } from '@/features/chat/tabs/providerResolution';
import type { TabProviderContext } from '@/features/chat/tabs/types';
import type ClaudianPlugin from '@/main';

function context(overrides: Partial<TabProviderContext> = {}): TabProviderContext {
  return { lifecycleState: 'blank', providerId: 'claude', draftModel: 'shared', conversationId: null, service: null, ...overrides };
}
const plugin = { getConversationSync: () => null } as unknown as ClaudianPlugin;

describe('tab provider resolution', () => {
  it('reads the explicit blank identity regardless of a same-ID stale runtime', () => {
    expect(getTabProviderId(context({ providerId: 'codex', service: { providerId: 'claude' } as any }), plugin)).toBe('codex');
  });
  it('uses a stored conversation provider ahead of the runtime and tab', () => {
    const owner = { getConversationSync: () => ({ providerId: 'codex' }) } as unknown as ClaudianPlugin;
    expect(getTabProviderId(context({ lifecycleState: 'bound_cold', conversationId: 'conversation' }), owner)).toBe('codex');
  });
  it('uses the explicit conversation override during a history switch', () => {
    expect(getTabProviderId(context(), plugin, { providerId: 'codex' } as any)).toBe('codex');
  });
  it('retains cold tab ownership without starting a runtime', () => {
    const tab = context({ lifecycleState: 'bound_cold', draftModel: null, providerId: 'codex' });
    expect(getTabProviderId(tab, plugin)).toBe('codex');
    expect(tab.service).toBeNull();
  });
});
