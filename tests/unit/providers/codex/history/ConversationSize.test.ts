import { randomUUID } from 'crypto';
import {  mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import type { ConversationHistoryHydrationResult } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';
import * as store from '@/providers/codex/history/CodexHistoryStore';

const fixtureDir = join('/tmp', `claudian-size-codex-${randomUUID()}`);

type SizeResult = {
  files: { status: string; bytes?: number; fileCount?: number; reason?: string };
};

function conversation(providerState: Record<string, unknown>): Conversation {
  return {
    id: 'codex-fixture', providerId: 'codex', title: 'Fixture', createdAt: 1, updatedAt: 1,
    sessionId: 'thread', providerState, messages: [],
  };
}

async function readSize(service: CodexConversationHistoryService, input: Conversation): Promise<SizeResult> {
  return (await service.readConversationSize({
    id: input.id, providerId: input.providerId, source: service.captureConversationSizeSource(input),
  }, fixtureDir, { revision: 1 })).snapshot;
}

function hydrate(
  service: CodexConversationHistoryService,
  input: Conversation,
): Promise<ConversationHistoryHydrationResult> {
  return service.hydrateConversationHistory(input, fixtureDir);
}

function messageRows(...texts: string[]): string {
  return texts.map((text, index) => JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message', role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: index % 2 === 0 ? 'input_text' : 'output_text', text }],
    },
  })).join('\n') + '\n';
}

function identifiedTurn(id: string): string {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
    { type: 'event_msg', payload: { type: 'user_message', message: `question ${id}` } },
    { type: 'event_msg', payload: { type: 'agent_message', message: `answer ${id}` } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}

function imageTurn(image: string): string {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'question' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'view_image', arguments: '{"path":"fixture.png"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: [{ type: 'input_image', image_url: image }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
}

beforeAll(async () => { await mkdir(fixtureDir); });

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('G1 Codex semantic certification', () => {
  it.each([true, false])('R2 case 3: discarded fork image output needs pre-normalization proof (conflict=%s)', async conflict => {
    const source = join(fixtureDir, `r2-image-source-${conflict}.jsonl`);
    const native = join(fixtureDir, `r2-image-native-${conflict}.jsonl`);
    await writeFile(source, imageTurn('first'));
    await writeFile(native, imageTurn(conflict ? 'second' : 'first') + identifiedTurn('fork'));
    const input = conversation({ threadId: 'thread', sessionFilePath: native, forkSourceSessionFilePath: source,
      forkSource: { sessionId: 'parent', resumeAt: 'one' } });
    const service = new CodexConversationHistoryService();
    await hydrate(service, input);
    expect(input.messages.map(message => message.content)).toEqual(['question', 'answer', 'question fork', 'answer fork']);
    expect(input.messages[1].toolCalls?.[0]).toMatchObject({ result: 'fixture.png', status: 'completed' });
    expect(JSON.stringify(input.messages)).not.toContain('image_url');
  });
  it.each(['post-checkpoint', 'prefix-duplicate', 'later-checkpoint', 'pending'] as const)(
    'R2 case 4: a discarded native ID must actually be retained (%s)', async variant => {
      const source = join(fixtureDir, `r2-prefix-source-${variant}.jsonl`);
      const native = join(fixtureDir, `r2-prefix-native-${variant}.jsonl`);
      await writeFile(source, identifiedTurn('one') + identifiedTurn('two'));
      await writeFile(native, identifiedTurn(variant === 'prefix-duplicate' ? 'one' : 'two') + identifiedTurn('fork'));
      const pending = variant === 'pending';
      const input = conversation({ ...(pending ? {} : { threadId: 'thread', sessionFilePath: native }),
        forkSourceSessionFilePath: source, forkSourceTranscriptRootPath: fixtureDir,
        forkSource: { sessionId: 'parent', resumeAt: variant === 'later-checkpoint' ? 'two' : 'one' } });
      if (pending) input.sessionId = null;
      const service = new CodexConversationHistoryService();
      await hydrate(service, input);
      const expected = ['question one', 'answer one',
        ...(variant === 'later-checkpoint' ? ['question two', 'answer two'] : []),
        ...(pending ? [] : ['question fork', 'answer fork'])];
      expect(input.messages.map(message => message.content)).toEqual(expected);
    });

  it.each(['conflict', 'identical', 'unique'] as const)(
    'G1 fix 4: requires unambiguous pending-fork checkpoint identity (%s)', async variant => {
      const path = join(fixtureDir, `fix4-${variant}.jsonl`);
      await writeFile(path, identifiedTurn('one') + (variant === 'unique' ? identifiedTurn('two')
        : variant === 'conflict' ? identifiedTurn('one').replace('question one', 'different question') : identifiedTurn('one')));
      const input = conversation({ forkSourceSessionFilePath: path, forkSourceTranscriptRootPath: fixtureDir,
        forkSource: { sessionId: 'parent', resumeAt: 'one' } });
      input.sessionId = null;
      const service = new CodexConversationHistoryService();
      const receipt = await hydrate(service, input);
      expect(input.messages.map(message => message.content)).toEqual(['question one', 'answer one']);
      expect(receipt).toMatchObject({ status: 'ready', });
    });

  it.each(['text-conflict', 'thinking-conflict', 'tool-conflict', 'identical', 'different-local-offset'] as const)(
    'G1 fix 5: audits native turns actually discarded by the established-fork merge (%s)', async variant => {
      const source = join(fixtureDir, `fix5-source-${variant}.jsonl`);
      const native = join(fixtureDir, `fix5-native-${variant}.jsonl`);
      const extra = variant === 'thinking-conflict'
        ? JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] } }) + '\n'
        : variant === 'tool-conflict' ? [
          { type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: 'exec_command', arguments: '{"command":"fixture"}' } },
          { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: 'first' } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n' : '';
      const withExtra = identifiedTurn('one').split('\n').filter(Boolean);
      if (extra) withExtra.splice(withExtra.length - 1, 0, extra.trimEnd());
      const shared = withExtra.join('\n') + '\n';
      const conflicting = variant === 'text-conflict' ? shared.replace('question one', 'different question')
        : variant === 'thinking-conflict' ? shared.replace('thought', 'different thought')
          : variant === 'tool-conflict' ? shared.replace('"output":"first"', '"output":"second"') : shared;
      const prefix = variant === 'different-local-offset' ? identifiedTurn('zero') : '';
      await writeFile(source, prefix + shared + identifiedTurn('two'));
      await writeFile(native, conflicting + identifiedTurn('fork'));
      const input = conversation({ threadId: 'thread', sessionFilePath: native, forkSourceSessionFilePath: source,
        forkSource: { sessionId: 'parent', resumeAt: 'one' } });
      const service = new CodexConversationHistoryService();
      await hydrate(service, input);
      expect(input.messages.map(message => message.content)).toEqual([
        ...(prefix ? ['question zero', 'answer zero'] : []), 'question one', 'answer one', 'question fork', 'answer fork',
      ]);
      const sourceMessage = input.messages.find(message => message.content === 'answer one');
      expect(sourceMessage?.contentBlocks).toEqual([
        ...(variant === 'thinking-conflict' ? [{ type: 'thinking', content: 'thought' }] : []),
        ...(variant === 'tool-conflict' ? [{ type: 'tool_use', toolId: 'call' }] : []),
        { type: 'text', content: 'answer one' },
      ]);
      expect(sourceMessage?.toolCalls?.[0]?.result).toBe(variant === 'tool-conflict' ? 'first' : undefined);
    });

  it.each(['legacy', 'mixed'] as const)('R2 case 5: terminal evidence follows the actual %s exit, not stream updates', async format => {
    for (const variant of ['conflict', 'identical', 'single', 'updates', 'compaction'] as const) {
      const start = { type: 'event', event: { type: 'item.started', item: { id: 'call', type: 'command_execution', command: 'fixture' } } };
      const completion = (output: string) => ({ type: 'event', event: { type: 'item.completed', item: { id: 'call', type: 'command_execution', aggregated_output: output, exit_code: 0 } } });
      const rows: unknown[] = [
        ...(format === 'mixed' ? [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } }] : []), start,
        ...(variant === 'updates' ? [{ type: 'event', event: { type: 'item.updated', item: { id: 'call', type: 'command_execution', aggregated_output: 'partial' } } }] : []),
        completion('first'),
      ];
      if (variant === 'identical' || variant === 'conflict') rows.push(completion(variant === 'conflict' ? 'second' : 'first'));
      if (variant === 'compaction') {
        if (format === 'mixed') rows.push({ type: 'compacted', payload: { replacement_history: [
          { type: 'function_call', call_id: 'call', name: 'exec_command', arguments: '{"command":"fixture"}' },
        ] } }, completion('replacement'));
        else rows.push({ type: 'event', event: { type: 'turn.completed' } }, { type: 'event', event: { type: 'turn.started' } }, start, completion('replacement'));
      }
      const path = join(fixtureDir, `r2-terminal-${format}-${variant}.jsonl`);
      const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
      await writeFile(path, content);
      const input = conversation({ threadId: 'thread', sessionFilePath: path });
      const service = new CodexConversationHistoryService();
      await hydrate(service, input);
      const output = variant === 'conflict' ? 'second' : variant === 'compaction' ? 'replacement' : 'first';
      expect(input.messages.at(-1)?.toolCalls?.[0]).toMatchObject({ result: output, status: 'completed' });
    }
  });

  it.each(['conflict', 'identical', 'single-final', 'array-conflict', 'array-identical', 'cross-turn-conflict'] as const)(
    'G1 fix 6: audits the real tool-result overwrite before hydrate certification (%s)', async variant => {
      const array = variant.startsWith('array');
      const first = array ? [{ type: 'input_image', image_url: 'first' }] : 'first';
      const last = variant.includes('conflict') ? array ? [{ type: 'input_image', image_url: 'second' }] : 'second' : first;
      const rows: unknown[] = [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'call', name: array ? 'view_image' : 'exec_command',
          arguments: array ? '{"path":"fixture.png"}' : '{"command":"fixture"}' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: first } },
      ];
      if (variant === 'cross-turn-conflict') rows.push(
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'two' } },
      );
      if (variant !== 'single-final') rows.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: last } });
      const path = join(fixtureDir, `fix6-${variant}.jsonl`);
      const content = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
      await writeFile(path, content);
      const input = conversation({ threadId: 'thread', sessionFilePath: path });
      const service = new CodexConversationHistoryService();
      await hydrate(service, input);
      expect(input.messages).toHaveLength(1);
      expect(input.messages[0].toolCalls).toHaveLength(1);
      expect(input.messages[0].toolCalls?.[0]).toMatchObject({ result: array ? 'fixture.png' : last, status: 'completed' });
    });

  it('G1 fix 6 regression: accepts a new tool result after a lawful compaction replacement', async () => {
    const call = { type: 'function_call', call_id: 'call', name: 'exec_command', arguments: '{"command":"fixture"}' };
    const output = (text: string) => ({ type: 'function_call_output', call_id: 'call', output: text });
    const content = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
      { type: 'response_item', payload: call }, { type: 'response_item', payload: output('first') },
      { type: 'compacted', payload: { replacement_history: [call, output('replacement')] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    const path = join(fixtureDir, 'fix6-compaction.jsonl');
    await writeFile(path, content);
    const input = conversation({ threadId: 'thread', sessionFilePath: path });
    const service = new CodexConversationHistoryService();
    await hydrate(service, input);
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0].toolCalls?.[0]).toMatchObject({ result: 'replacement', status: 'completed' });
  });

  it.each([false, true])('does not certify a damaged text as zero or a partial count (mixed=%s)', async mixed => {
    const path = join(fixtureDir, `loss-${mixed}.jsonl`);
    const bad = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text' }] } }) + '\n';
    await writeFile(path, (mixed ? messageRows('valid') : '') + bad);
    const input = conversation({ threadId: 'thread', sessionFilePath: path });
    const service = new CodexConversationHistoryService();
    expect(await hydrate(service, input)).toEqual({ status: 'ready', });
    expect(input.messages.map(msg => msg.content)).toEqual(mixed ? ['valid'] : []);
  });
});

describe('Codex size source boundaries', () => {
  it('never discovers an unknown session path by directory DFS for display', async () => {
    const find = jest.spyOn(store, 'findCodexSessionFile');
    const service = new CodexConversationHistoryService();
    const hydrate = jest.spyOn(service, 'hydrateConversationHistory');
    const result = await readSize(service, conversation({ threadId: 'thread', transcriptRootPath: fixtureDir }));
    expect(result.files).toEqual({ status: 'unknown', reason: 'unavailable' });
    expect(find).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    find.mockRestore();
  });

  it('publishes only a complete normal hydration and marks changed or malformed sources unknown', async () => {
    const path = join(fixtureDir, 'hydrated.jsonl');
    const rows = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] } },
    ];
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const input = conversation({ threadId: 'thread', sessionFilePath: path });
    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(input, fixtureDir);
    expect(input.messages.map(message => message.content)).toEqual(['Hello', 'Hi']);
    await readSize(service, input);
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n{broken}\n');
    input.messages = [];
    await service.hydrateConversationHistory(input, fixtureDir);
    expect(input.messages.map(message => message.content)).toEqual(['Hello', 'Hi']);
  });

  it('stats only explicit native and fork source paths and refuses a partial total', async () => {
    const path = join(fixtureDir, 'native.jsonl');
    await writeFile(path, '中文');
    const service = new CodexConversationHistoryService();
    const normal = await readSize(service, conversation({ threadId: 'thread', sessionFilePath: path }));
    expect(normal.files).toEqual({ status: 'known', bytes: 6, });
    const fork = await readSize(service, conversation({
      threadId: 'thread', sessionFilePath: path,
      forkSource: { sessionId: 'parent', resumeAt: 'checkpoint' },
      forkSourceSessionFilePath: join(fixtureDir, 'missing-source.jsonl'),
    }));
    expect(fork.files).toEqual({ status: 'known', bytes: 6 });
    const unknownSource = await readSize(service, conversation({
      threadId: 'thread', sessionFilePath: path,
      forkSource: { sessionId: 'parent', resumeAt: 'checkpoint' },
    }));
    expect(unknownSource.files).toEqual({ status: 'known', bytes: 6 });
  });

  it('counts the normal fork merge and makes a changed checkpoint stale', async () => {
    const sourcePath = join(fixtureDir, 'fork-source.jsonl');
    const forkPath = join(fixtureDir, 'fork-native.jsonl');
    const turn = (id: string) => [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
      { type: 'event_msg', payload: { type: 'user_message', message: `question ${id}` } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${id}` }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ];
    await writeFile(sourcePath, [...turn('one'), ...turn('two')].map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeFile(forkPath, [...turn('one'), ...turn('fork')].map(row => JSON.stringify(row)).join('\n') + '\n');
    const input = conversation({
      threadId: 'fork-thread', sessionFilePath: forkPath, forkSourceSessionFilePath: sourcePath,
      forkSource: { sessionId: 'parent', resumeAt: 'one' },
    });
    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(input, fixtureDir);
    expect(input.messages).toHaveLength(4);
    (input.providerState!.forkSource as { resumeAt: string }).resumeAt = 'two';
  });

  it('does not certify a fork merge when a copied turn lacks a stable identity', async () => {
    const sourcePath = join(fixtureDir, 'fork-unkeyed-source.jsonl');
    const forkPath = join(fixtureDir, 'fork-unkeyed-native.jsonl');
    const identified = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'one' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'first question' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'first answer' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'one' } },
    ];
    const unkeyed = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'unkeyed' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] } },
    ];
    const content = [...identified, ...unkeyed].map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(sourcePath, content);
    await writeFile(forkPath, content);
    const input = conversation({
      threadId: 'fork-thread', sessionFilePath: forkPath, forkSourceSessionFilePath: sourcePath,
      forkSource: { sessionId: 'parent', resumeAt: 'one' },
    });
    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(input, fixtureDir);
    expect(input.messages.map(message => message.content)).toEqual(['first question', 'first answer', 'unkeyed', 'reply']);
  });

  it('does not certify structurally malformed messages as complete history', async () => {
    const path = join(fixtureDir, 'malformed-object.jsonl');
    const rows = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    ];
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const input = conversation({ threadId: 'thread', sessionFilePath: path });
    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(input, fixtureDir);
    expect(input.messages.map(message => message.content)).toEqual(['Hello']);
  });
});

describe('Codex normal-read size proof', () => {

  it.each([
    ['malformed line', `${messageRows('hello')}not-json\n`],
    ['unfinished tail', messageRows('hello').trimEnd()],
    ['invalid message structure', `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant' } })}\n`],
  ])('keeps %s loading ready without certifying history', async (_name, content) => {
    const path = join(fixtureDir, `partial-${Buffer.byteLength(content)}.jsonl`);
    await writeFile(path, content);
    const input = conversation({ threadId: 'thread', sessionFilePath: path });
    const service = new CodexConversationHistoryService();
    expect(await hydrate(service, input)).toEqual({ status: 'ready', });
  });

  it('certifies a real empty file but not an unreadable or undiscovered file', async () => {
    const path = join(fixtureDir, 'empty.jsonl');
    await writeFile(path, '');
    const input = conversation({ threadId: 'thread', sessionFilePath: path });
    const service = new CodexConversationHistoryService();
    const empty = await hydrate(service, input);
    expect(empty).toMatchObject({ });
    expect(await readSize(service, input)).toMatchObject({
      files: { status: 'known', bytes: 0, },
    });
    const unreadable = conversation({ threadId: 'thread', sessionFilePath: fixtureDir });
    expect(await hydrate(service, unreadable)).toEqual({ status: 'ready', });
    const missing = conversation({ threadId: 'absent-thread', transcriptRootPath: fixtureDir });
    expect(await hydrate(service, missing)).toEqual({ status: 'ready', });
  });

  it('does not certify an established fork when normal loading falls back to native only', async () => {
    const path = join(fixtureDir, 'fork-degraded.jsonl');
    await writeFile(path, messageRows('native', 'reply'));
    const input = conversation({
      threadId: 'thread', sessionFilePath: path,
      forkSource: { sessionId: 'absent-parent', resumeAt: 'one' },
      forkSourceTranscriptRootPath: fixtureDir,
    });
    const service = new CodexConversationHistoryService();
    expect(await hydrate(service, input)).toEqual({ status: 'ready', });
    expect(input.messages).toHaveLength(2);
  });

  it('G1 regression: rejects duplicate turn identities in an otherwise readable fork merge', async () => {
    const source = join(fixtureDir, 'duplicate-parent.jsonl');
    const native = join(fixtureDir, 'duplicate-native.jsonl');
    await writeFile(source, identifiedTurn('one') + identifiedTurn('one'));
    await writeFile(native, identifiedTurn('fork'));
    const input = conversation({ threadId: 'thread', sessionFilePath: native, forkSourceSessionFilePath: source,
      forkSource: { sessionId: 'parent', resumeAt: 'one' } });
    const service = new CodexConversationHistoryService();
    expect(await hydrate(service, input)).toEqual({ status: 'ready', });
    expect(input.messages).toHaveLength(4);
  });

  it('never certifies missing checkpoints or unidentifiable fork merges', async () => {
    const source = join(fixtureDir, 'proof-parent.jsonl');
    const native = join(fixtureDir, 'proof-native.jsonl');
    await writeFile(source, identifiedTurn('one'));
    await writeFile(native, messageRows('unidentified', 'reply'));
    const input = conversation({
      threadId: 'thread', sessionFilePath: native, forkSourceSessionFilePath: source,
      forkSource: { sessionId: 'parent', resumeAt: 'missing' },
    });
    const service = new CodexConversationHistoryService();
    expect(await hydrate(service, input)).toEqual({ status: 'ready', });
    (input.providerState!.forkSource as { resumeAt: string }).resumeAt = 'one';
    expect(await hydrate(service, input)).toEqual({ status: 'ready', });
  });
});
