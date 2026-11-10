import type { PermissionMode as SDKPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { createMockEl } from '@test/helpers/mockElement';

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

/** handleExitPlanMode additionally resolves provider capabilities through the
 * agent service (planPathPrefix) and needs the content renderer hook. */
function createExitPlanControllerDeps(): InputControllerDeps {
  return {
    ...createAskControllerDeps(),
    renderer: { renderContent: jest.fn() } as any,
    getAgentService: () => ({
      providerId: 'claude',
      getCapabilities: () => ({ planPathPrefix: '/plans' }),
    }) as any,
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
    getPermissionMode: () => 'manual',
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

describe('createClaudeApprovalCallback - ExitPlanMode approval', () => {
  it.each([
    [{ type: 'approve' }],
    [{ type: 'approve-new-session', planContent: 'the plan' }],
  ])('retains the session setMode update for %s', async (decision) => {
    const exitPlanModeCallback = jest.fn().mockResolvedValue(decision);
    const approvalCallback = jest.fn();
    const resolveSDKPermissionMode = jest.fn().mockReturnValue('default');
    const syncPermissionMode = jest.fn();
    const canUseTool = createClaudeApprovalCallback({
      getAllowedTools: () => null,
      getApprovalCallback: () => approvalCallback,
      getAskUserQuestionCallback: () => null,
      getExitPlanModeCallback: () => exitPlanModeCallback,
      getPermissionMode: () => 'manual',
      resolveSDKPermissionMode,
      syncPermissionMode,
    });
    const input = { plan: 'the plan' };
    const signal = new AbortController().signal;

    const result = await canUseTool('ExitPlanMode', input, { signal } as any);

    expect(exitPlanModeCallback).toHaveBeenCalledWith(input, signal);
    expect(resolveSDKPermissionMode).toHaveBeenCalledWith('manual');
    expect(syncPermissionMode).toHaveBeenCalledWith('manual', 'default');
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    });
    expect(result.behavior === 'allow' && result.updatedInput).toBe(input);
    expect(approvalCallback).not.toHaveBeenCalled();
  });
});

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

  it('settles a pending exit-plan-mode prompt as deny+interrupt when the cancel path dismisses it (2.5.1 F1b)', async () => {
    // Same family as F1: an exit-plan-mode card left pending by the cancel
    // path keeps the SDK's canUseTool blocked forever.
    const controller = new InputController(createExitPlanControllerDeps());
    const canUseTool = createClaudeApprovalCallback({
      getAllowedTools: () => null,
      getApprovalCallback: () => jest.fn(),
      getAskUserQuestionCallback: () => null,
      getExitPlanModeCallback: () => (input, signal) => controller.handleExitPlanMode(input, signal),
      getPermissionMode: () => 'manual',
      resolveSDKPermissionMode: (mode) => mode as unknown as SDKPermissionMode,
      syncPermissionMode: () => {},
    });

    const permissionPromise = canUseTool(
      'ExitPlanMode',
      { plan: 'do the thing' },
      { signal: new AbortController().signal } as any,
    );
    expect((controller as any).pendingExitPlanModeInline).not.toBeNull();

    controller.dismissPendingApprovalPrompt();

    const result = await Promise.race([
      permissionPromise,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('canUseTool never settled: the cancelled exit-plan-mode promise leaked')),
        500,
      )),
    ]);

    // Existing deny semantics (handler): null decision → deny + interrupt.
    expect(result).toEqual({
      behavior: 'deny',
      message: 'User cancelled.',
      interrupt: true,
    });
    expect((controller as any).pendingExitPlanModeInline).toBeNull();
  });
});

describe('createClaudeApprovalCallback - plain allow without permission updates', () => {
  it('returns only behavior+updatedInput for a plain allow even when options.suggestions is []', async () => {
    const approvalCallback = jest.fn().mockResolvedValue('allow');
    const canUseTool = createClaudeApprovalCallback({
      getAllowedTools: () => null,
      getApprovalCallback: () => approvalCallback,
      getAskUserQuestionCallback: () => null,
      getExitPlanModeCallback: () => null,
      getPermissionMode: () => 'manual',
      resolveSDKPermissionMode: (mode) => mode as unknown as SDKPermissionMode,
      syncPermissionMode: () => {},
    });
    const input = { command: 'ls -la' };
    const signal = new AbortController().signal;

    // Plain allow never consults options.suggestions: the allow variant of
    // PermissionResult must carry no updatedPermissions key at all. That the
    // rule builder itself stays uninvoked is proven by the module-spy case in
    // ClaudianService.test.ts (plain-allow it.each), not inferable here.
    const result = await canUseTool('Bash', input, { signal, suggestions: [] } as any);

    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    expect(result.behavior === 'allow' && result.updatedInput).toBe(input);
    expect(Object.hasOwn(result, 'updatedPermissions')).toBe(false);
    expect(approvalCallback).toHaveBeenCalledWith(
      'Bash',
      input,
      expect.any(String),
      expect.objectContaining({ decisionReason: undefined, blockedPath: undefined, agentID: undefined }),
    );
  });
});

describe('createClaudeApprovalCallback - AskUserQuestion positive answers', () => {
  it('returns updatedInput.answers when the user answers the ask card normally', async () => {
    const controller = new InputController(createAskControllerDeps());
    const canUseTool = createCanUseTool(controller);

    const permissionPromise = canUseTool(
      'AskUserQuestion',
      ASK_INPUT,
      { signal: new AbortController().signal } as any,
    );
    expect((controller as any).pendingAskInline).not.toBeNull();

    // Same relay/answer entry the desktop card and Channel B both converge on.
    ((controller as any).pendingAskInline as { resolveExternal(r: unknown): void })
      .resolveExternal({ 'Proceed?': 'yes' });

    const answers = { 'Proceed?': 'yes' };
    // Independent expected constant: not derived from the input reference the
    // handler may have mutated in place.
    const expectedQuestions = [{
      question: 'Proceed?',
      options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
      isOther: false,
      isSecret: false,
    }];

    const result = await permissionPromise;

    // Real narrowing (no suppressions): updatedInput is optional on the allow
    // variant of PermissionResult.
    if (result.behavior !== 'allow' || !result.updatedInput) {
      throw new Error(`expected allow with updatedInput, got ${JSON.stringify(result)}`);
    }

    expect(result.updatedInput.answers).toEqual(answers);
    // The ask input already carries isOther: false — the handler must not rewrite it.
    expect((result.updatedInput.questions as Array<{ isOther?: boolean }>)[0].isOther).toBe(false);
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { questions: expectedQuestions, answers },
    });
    expect(Object.hasOwn(result, 'updatedPermissions')).toBe(false);
    expect((controller as any).pendingAskInline).toBeNull();
  });

  it('injects isOther=true into questions missing the key before the ask callback sees them', async () => {
    // Capture at call time: the handler mutates the forwarded input in place,
    // so a post-hoc read of the mock-saved reference cannot prove the value
    // the callback actually observed when invoked.
    const isOtherAtCall: Array<boolean | undefined> = [];
    const answers = { 'Choose?': 'custom text' };
    const askUserQuestionCallback = jest.fn((forwarded: Record<string, unknown>) => {
      isOtherAtCall.push((forwarded.questions as Array<{ isOther?: boolean }>)[0]?.isOther);
      return Promise.resolve(answers);
    });
    const canUseTool = createClaudeApprovalCallback({
      getAllowedTools: () => null,
      getApprovalCallback: () => jest.fn(),
      getAskUserQuestionCallback: () => askUserQuestionCallback,
      getExitPlanModeCallback: () => null,
      getPermissionMode: () => 'manual',
      resolveSDKPermissionMode: (mode) => mode as unknown as SDKPermissionMode,
      syncPermissionMode: () => {},
    });
    const input = {
      questions: [{
        question: 'Choose?',
        options: [{ label: 'A', value: 'a' }],
        isSecret: false,
      }],
    };

    const result = await canUseTool('AskUserQuestion', input, { signal: new AbortController().signal } as any);

    expect(isOtherAtCall).toEqual([true]);

    // Independent expected constant: never derived from the (handler-mutated)
    // input reference.
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [{
          question: 'Choose?',
          options: [{ label: 'A', value: 'a' }],
          isOther: true,
          isSecret: false,
        }],
        answers,
      },
    });
    expect(Object.hasOwn(result, 'updatedPermissions')).toBe(false);
  });
});

describe('createClaudeApprovalCallback - ExitPlanMode feedback branch', () => {
  it('denies with the feedback text and no interrupt, without syncing permission mode', async () => {
    const exitPlanModeCallback = jest.fn().mockResolvedValue({ type: 'feedback', text: 'Split step 2 first.' });
    const approvalCallback = jest.fn();
    const syncPermissionMode = jest.fn();
    const canUseTool = createClaudeApprovalCallback({
      getAllowedTools: () => null,
      getApprovalCallback: () => approvalCallback,
      getAskUserQuestionCallback: () => null,
      getExitPlanModeCallback: () => exitPlanModeCallback,
      getPermissionMode: () => 'manual',
      resolveSDKPermissionMode: (mode) => mode as unknown as SDKPermissionMode,
      syncPermissionMode,
    });
    const input = { plan: 'the plan' };
    const signal = new AbortController().signal;

    const result = await canUseTool('ExitPlanMode', input, { signal } as any);

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Split step 2 first.',
      interrupt: false,
    });
    expect(syncPermissionMode).not.toHaveBeenCalled();
    expect(approvalCallback).not.toHaveBeenCalled();
  });
});
