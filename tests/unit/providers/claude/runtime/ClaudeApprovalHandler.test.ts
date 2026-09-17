import type { PermissionMode as SDKPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { createMockEl } from '@test/helpers/mockElement';

import type { PermissionMode } from '@/core/types/settings';
import type { InputControllerDeps } from '@/features/chat/controllers/InputController';
import { InputController } from '@/features/chat/controllers/InputController';
import { ChatState } from '@/features/chat/state/ChatState';
import { createClaudeApprovalCallback } from '@/providers/claude/runtime/ClaudeApprovalHandler';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

/** Minimal deps: handleAskUserQuestion only needs state, the input container
 * (with a parent to mount into) and the thinking-indiator hook. */
function createAskControllerDeps(): InputControllerDeps {
  const state = new ChatState();
  const parentEl = createMockEl();
  const containerEl = createMockEl();
  (containerEl as any).parentElement = parentEl;
  return {
    state,
    getInputContainerEl: () => containerEl as any,
    streamController: { hideThinkingIndicator: jest.fn() } as any,
  } as unknown as InputControllerDeps;
}

function createCanUseTool(controller: InputController) {
  return createClaudeApprovalCallback({
    getAllowedTools: () => null,
    getApprovalCallback: () => jest.fn(),
    // Same wiring shape as Tab.setupServiceCallbacks: the ask callback is the
    // InputController entry, so a leaked pending-ask promise blocks the SDK's
    // canUseTool exactly like in the app.
    getAskUserQuestionCallback: () => (input, signal) => controller.handleAskUserQuestion(input, signal),
    getExitPlanModeCallback: () => null,
    getPermissionMode: () => 'normal' as PermissionMode,
    resolveSDKPermissionMode: (mode) => mode as unknown as SDKPermissionMode,
    syncPermissionMode: () => {},
  });
}

const ASK_INPUT = {
  questions: [{
    question: 'Proceed?',
    options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
    isOther: false,
    isSecret: false,
  }],
};

describe('createClaudeApprovalCallback - AskUserQuestion cancel path (2.5.1 F1)', () => {
  it('settles a pending ask as deny+interrupt when the cancel path dismisses it', async () => {
    const controller = new InputController(createAskControllerDeps());
    const canUseTool = createCanUseTool(controller);

    // The SDK blocks on this control_response while the ask card is pending.
    const permissionPromise = canUseTool(
      'AskUserQuestion',
      ASK_INPUT,
      { signal: new AbortController().signal } as any,
    );
    // The ask card mounted synchronously inside the callback chain.
    expect((controller as any).pendingAskInline).not.toBeNull();

    // ESC → ClaudeChatRuntime.cancel() → approvalDismisser → this dismiss path.
    controller.dismissPendingApprovalPrompt();

    const result = await Promise.race([
      permissionPromise,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('canUseTool never settled: the cancelled ask promise leaked')),
        500,
      )),
    ]);

    // Existing deny semantics: null → deny + interrupt → the CLI's canUseTool
    // unblocks and the turn ends instead of hanging the lease.
    expect(result).toEqual({
      behavior: 'deny',
      message: 'User declined to answer.',
      interrupt: true,
    });
    expect((controller as any).pendingAskInline).toBeNull();
  });
});
