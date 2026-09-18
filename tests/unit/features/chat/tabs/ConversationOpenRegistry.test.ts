import { ConversationOpenRegistry } from '@/features/chat/tabs/ConversationOpenRegistry';

describe('ConversationOpenRegistry', () => {
  it('allows exactly one owner and focuses it on duplicate reserve', async () => {
    const registry = new ConversationOpenRegistry();
    const focus = jest.fn();
    const first = registry.reserve('conversation', focus);

    expect(first).not.toBeNull();
    expect(registry.reserve('conversation', jest.fn())).toBeNull();
    await registry.focusOwner('conversation');
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('rejects a delayed stale release without disturbing the new owner', () => {
    const registry = new ConversationOpenRegistry();
    const oldClaim = registry.reserve('conversation', jest.fn())!;
    expect(registry.release('conversation', oldClaim.ownerToken)).toBe(true);
    const newClaim = registry.reserve('conversation', jest.fn())!;

    expect(registry.release('conversation', oldClaim.ownerToken)).toBe(false);
    expect(registry.owns(newClaim)).toBe(true);
  });
});
