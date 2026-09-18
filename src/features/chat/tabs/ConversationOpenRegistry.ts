export interface ConversationOpenClaim {
  conversationId: string;
  ownerToken: string;
}

type FocusOwner = () => Promise<void> | void;

/** Plugin-scoped ownership registry. Tokens make stale releases harmless. */
export class ConversationOpenRegistry {
  private readonly claims = new Map<string, ConversationOpenClaim>();
  private readonly focusOwners = new Map<string, FocusOwner>();
  private sequence = 0;

  reserve(conversationId: string, focusOwner: FocusOwner): ConversationOpenClaim | null {
    if (this.claims.has(conversationId)) return null;
    const claim = {
      conversationId,
      ownerToken: `conversation-owner-${Date.now()}-${++this.sequence}`,
    };
    this.claims.set(conversationId, claim);
    this.focusOwners.set(claim.ownerToken, focusOwner);
    return claim;
  }

  owns(claim: ConversationOpenClaim): boolean {
    return this.claims.get(claim.conversationId)?.ownerToken === claim.ownerToken;
  }

  release(conversationId: string, ownerToken: string): boolean {
    const current = this.claims.get(conversationId);
    if (!current || current.ownerToken !== ownerToken) return false;
    this.claims.delete(conversationId);
    this.focusOwners.delete(ownerToken);
    return true;
  }

  async focusOwner(conversationId: string): Promise<boolean> {
    const claim = this.claims.get(conversationId);
    if (!claim) return false;
    await this.focusOwners.get(claim.ownerToken)?.();
    return true;
  }
}
