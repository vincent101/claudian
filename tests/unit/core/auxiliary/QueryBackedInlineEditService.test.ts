import type { AuxQueryConfig } from '@/core/auxiliary/AuxQueryRunner';
import { QueryBackedInlineEditService } from '@/core/auxiliary/QueryBackedInlineEditService';
import type { InlineEditRequest } from '@/core/providers/types';

interface ControlledRunnerCall {
  config: AuxQueryConfig;
  prompt: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

function createControlledRunner() {
  const calls: ControlledRunnerCall[] = [];
  const reset = jest.fn();
  const runner = {
    query: (config: AuxQueryConfig, prompt: string) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ config, prompt, resolve, reject });
      }),
    reset,
  };
  return { calls, reset, runner };
}

const REQUEST: InlineEditRequest = {
  mode: 'selection',
  selectedText: 'text',
  instruction: 'edit',
  notePath: 'note.md',
};

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('QueryBackedInlineEditService', () => {
  let calls: ControlledRunnerCall[];
  let service: QueryBackedInlineEditService;

  beforeEach(() => {
    const controlled = createControlledRunner();
    calls = controlled.calls;
    service = new QueryBackedInlineEditService(controlled.runner);
  });

  it('keeps a later request abortable after an earlier request finishes', async () => {
    const editA = service.editText(REQUEST);
    const editB = service.editText(REQUEST);

    calls[0].resolve('<replacement>A</replacement>');
    await editA;

    service.cancel();
    expect(calls[1].config.abortController?.signal.aborted).toBe(true);

    calls[1].reject(new Error('Cancelled'));
    const resultB = await editB;
    expect(resultB.success).toBe(false);
  });

  it('cancel aborts every pending request', async () => {
    const editA = service.editText(REQUEST);
    const editB = service.editText(REQUEST);

    service.cancel();

    expect(calls[0].config.abortController?.signal.aborted).toBe(true);
    expect(calls[1].config.abortController?.signal.aborted).toBe(true);

    calls[0].reject(new Error('Cancelled'));
    calls[1].reject(new Error('Cancelled'));
    await Promise.all([editA, editB]);
  });

  it('a late pre-reset completion must not re-establish the conversation', async () => {
    const editA = service.editText(REQUEST);
    service.resetConversation();
    const editB = service.editText(REQUEST);

    calls[1].reject(new Error('boom'));
    await editB;

    calls[0].resolve('<replacement>A</replacement>');
    const resultA = await editA;
    expect(resultA.success).toBe(true);

    const continuation = service.continueConversation('more');
    await flushMicrotasks();

    expect(calls).toHaveLength(2);
    const result = await continuation;
    expect(result.success).toBe(false);
  });

  it('a cancelled completion must not publish conversation state', async () => {
    const editA = service.editText(REQUEST);

    service.cancel();
    calls[0].resolve('<replacement>A</replacement>');

    const resultA = await editA;
    expect(resultA.success).toBe(true);

    const continuation = service.continueConversation('more');
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    const result = await continuation;
    expect(result.success).toBe(false);
  });

  it('publishes conversation state for a valid completion and continues it', async () => {
    const editA = service.editText(REQUEST);
    calls[0].resolve('<replacement>fixed</replacement>');
    const resultA = await editA;
    expect(resultA.success).toBe(true);
    expect(resultA.editedText).toBe('fixed');

    const continuation = service.continueConversation('more');
    expect(calls).toHaveLength(2);
    calls[1].resolve('<replacement>continued</replacement>');
    const result = await continuation;
    expect(result.success).toBe(true);
    expect(result.editedText).toBe('continued');
  });

  it('resetConversation resets the runner', () => {
    const controlled = createControlledRunner();
    const localService = new QueryBackedInlineEditService(controlled.runner);
    localService.resetConversation();
    expect(controlled.reset).toHaveBeenCalledTimes(1);
  });
});
