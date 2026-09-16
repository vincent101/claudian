jest.mock('obsidian', () => {
  const createMockEl = (): any => {
    const el: any = {
      tag: 'div',
      cls: undefined,
      attr: undefined,
      textContent: '',
      value: '',
      children: [] as any[],
      listeners: {} as Record<string, Array<(...args: any[]) => any>>,
      empty: jest.fn(() => { el.children = []; }),
      addClass: jest.fn(),
      setText: jest.fn((text: string) => { el.textContent = text; }),
      addEventListener: jest.fn((type: string, handler: any) => {
        el.listeners[type] = el.listeners[type] ?? [];
        el.listeners[type].push(handler);
      }),
      createDiv: jest.fn((opts?: any) => appendChild('div', opts)),
      createSpan: jest.fn((opts?: any) => appendChild('span', opts)),
      createEl: jest.fn((tag: string, opts?: any) => appendChild(tag, opts)),
    };
    const appendChild = (tag: string, opts?: any) => {
      const child = createMockEl();
      child.tag = tag;
      child.cls = opts?.cls;
      child.attr = opts?.attr;
      if (typeof opts?.text === 'string') {
        child.textContent = opts.text;
      }
      el.children.push(child);
      return child;
    };
    return el;
  };

  // Modal input elements in onOpen() creation order, so tests can drive the
  // save flow without a src-side test hook.
  const textInputs: Array<{ value: string }> = [];
  const textAreaInputs: Array<{ value: string }> = [];
  const modals: any[] = [];

  return {
    setIcon: jest.fn(),
    Notice: jest.fn(),
    Modal: class MockModal {
      contentEl = createMockEl();
      modalEl = createMockEl();
      constructor(_app?: unknown) {
        modals.push(this);
      }
      setTitle = jest.fn();
      open() { this.onOpen(); }
      close = jest.fn();
      onOpen() {}
      onClose() {}
    },
    Setting: jest.fn().mockImplementation(() => {
      const setting: any = {
        setName: jest.fn().mockReturnThis(),
        setDesc: jest.fn().mockReturnThis(),
        setHeading: jest.fn().mockReturnThis(),
        addText: jest.fn().mockImplementation((cb: any) => {
          const inputEl = { value: '' };
          textInputs.push(inputEl);
          const component: any = {
            inputEl,
            setValue: jest.fn((v: string) => { inputEl.value = v; return component; }),
            setPlaceholder: jest.fn().mockReturnThis(),
          };
          cb(component);
          return setting;
        }),
        addTextArea: jest.fn().mockImplementation((cb: any) => {
          const inputEl = { value: '' };
          textAreaInputs.push(inputEl);
          const component: any = {
            inputEl,
            setValue: jest.fn((v: string) => { inputEl.value = v; return component; }),
            setPlaceholder: jest.fn().mockReturnThis(),
          };
          cb(component);
          return setting;
        }),
        addToggle: jest.fn().mockImplementation((cb: any) => {
          const component: any = {
            setValue: jest.fn().mockReturnThis(),
            onChange: jest.fn(),
          };
          cb(component);
          return setting;
        }),
      };
      return setting;
    }),
    __testUtils: { createMockEl, textInputs, textAreaInputs, modals },
  };
});

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirmDelete: jest.fn(),
}));

import { Notice } from 'obsidian';

import { setLocale, t } from '@/i18n/i18n';
import type { TranslationKey } from '@/i18n/types';
import type { OpencodeAgentStorage } from '@/providers/opencode/storage/OpencodeAgentStorage';
import { createOpencodeAgentPersistenceKey } from '@/providers/opencode/storage/OpencodeAgentStorage';
import type { OpencodeAgentDefinition } from '@/providers/opencode/types/agent';
import {
  findOpencodeAgentNameConflict,
  getOpencodeAgentNameIssue,
  OpencodeAgentSettings,
  validateOpencodeAgentName,
} from '@/providers/opencode/ui/OpencodeAgentSettings';

const { __testUtils } = jest.requireMock('obsidian') as {
  __testUtils: {
    createMockEl: () => ModalTestElement;
    textInputs: Array<{ value: string }>;
    textAreaInputs: Array<{ value: string }>;
    modals: Array<{ contentEl: ModalTestElement }>;
  };
};

interface ModalTestElement {
  tag: string;
  cls?: string;
  attr?: Record<string, string>;
  textContent: string;
  value: string;
  children: ModalTestElement[];
  listeners: Record<string, Array<() => void | Promise<void>>>;
}

function makeAgent(overrides: Partial<OpencodeAgentDefinition> = {}): OpencodeAgentDefinition {
  return {
    name: 'review',
    description: 'Reviews code.',
    prompt: 'Review carefully.',
    ...overrides,
  };
}

describe('validateOpencodeAgentName', () => {
  it('accepts mixed-case nested names with spaces', () => {
    expect(validateOpencodeAgentName('Security Review/Builder')).toBeNull();
  });

  it('rejects leading or trailing slashes', () => {
    expect(validateOpencodeAgentName('/review')).toBe(
      'Agent name must use slash-separated path segments without leading or trailing slashes',
    );
    expect(validateOpencodeAgentName('review/')).toBe(
      'Agent name must use slash-separated path segments without leading or trailing slashes',
    );
  });

  it('rejects dot path segments', () => {
    expect(validateOpencodeAgentName('review/../builder')).toBe(
      'Agent name cannot include "." or ".." path segments',
    );
  });

  it('rejects Windows-reserved filename characters', () => {
    expect(validateOpencodeAgentName('review:builder')).toBe(
      'Agent name path segments cannot contain Windows-reserved filename characters',
    );
  });

  it('rejects leading or trailing whitespace inside a segment', () => {
    expect(validateOpencodeAgentName('review /builder')).toBe(
      'Agent name path segments cannot start or end with whitespace',
    );
  });
});

describe('getOpencodeAgentNameIssue', () => {
  it('returns stable issue codes', () => {
    expect(getOpencodeAgentNameIssue('')).toEqual({ code: 'required' });
    expect(getOpencodeAgentNameIssue('/review')).toEqual({ code: 'pathSegments' });
    expect(getOpencodeAgentNameIssue('review/ /builder')).toEqual({ code: 'segmentEmpty' });
    expect(getOpencodeAgentNameIssue('review /builder')).toEqual({ code: 'segmentWhitespace' });
    expect(getOpencodeAgentNameIssue('review/../builder')).toEqual({ code: 'dotSegment' });
    expect(getOpencodeAgentNameIssue('review:builder')).toEqual({ code: 'reservedCharacter' });
    expect(getOpencodeAgentNameIssue('Security Review/Builder')).toBeNull();
  });

  it('mirrors the legacy string wrapper', () => {
    const issue = getOpencodeAgentNameIssue('/review');
    expect(issue?.code).toBe('pathSegments');
    expect(validateOpencodeAgentName('/review')).toBe(
      'Agent name must use slash-separated path segments without leading or trailing slashes',
    );
  });
});

describe('findOpencodeAgentNameConflict', () => {
  it('detects conflicts against primary-capable agents, not just visible subagents', () => {
    const agents = [
      makeAgent({
        name: 'Builder',
        mode: 'primary',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/Builder.md' }),
      }),
      makeAgent({
        name: 'review',
        mode: 'subagent',
        persistenceKey: createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/review.md' }),
      }),
    ];

    expect(findOpencodeAgentNameConflict(agents, 'builder')?.name).toBe('Builder');
  });

  it('ignores the current backing file when editing in place', () => {
    const persistenceKey = createOpencodeAgentPersistenceKey({ filePath: '.opencode/agent/review.md' });
    const agents = [
      makeAgent({
        name: 'review',
        mode: 'subagent',
        persistenceKey,
      }),
    ];

    expect(findOpencodeAgentNameConflict(agents, 'review', persistenceKey)).toBeNull();
  });
});

describe('OpencodeAgentSettings modal save validation', () => {
  beforeEach(() => {
    setLocale('en');
    (Notice as unknown as jest.Mock).mockClear();
    __testUtils.textInputs.length = 0;
    __testUtils.textAreaInputs.length = 0;
    __testUtils.modals.length = 0;
  });

  function findElements(
    root: ModalTestElement,
    predicate: (el: ModalTestElement) => boolean,
  ): ModalTestElement[] {
    const found: ModalTestElement[] = [];
    const walk = (el: ModalTestElement): void => {
      if (predicate(el)) {
        found.push(el);
      }
      for (const child of el.children) {
        walk(child);
      }
    };
    walk(root);
    return found;
  }

  function createMockStorage(): OpencodeAgentStorage {
    return {
      loadAll: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as OpencodeAgentStorage;
  }

  // Drives the real UI path (settings list -> add button -> modal onOpen) and
  // returns the modal's save handler, since OpencodeAgentModal is not exported.
  async function openAddAgentModal(): Promise<{
    save: () => Promise<void>;
    storage: OpencodeAgentStorage;
    contentEl: ModalTestElement;
  }> {
    const container = __testUtils.createMockEl();
    const storage = createMockStorage();
    new OpencodeAgentSettings(container as unknown as HTMLElement, storage, {} as any, undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const addBtn = findElements(container, (el) => el.attr?.['aria-label'] === t('common.add'))[0];
    addBtn.listeners.click[0]();

    const modal = __testUtils.modals[__testUtils.modals.length - 1];
    const saveBtn = findElements(modal.contentEl, (el) => el.cls === 'claudian-save-btn')[0];
    return { save: saveBtn.listeners.click[0] as () => Promise<void>, storage, contentEl: modal.contentEl };
  }

  // Fills the required basics so the save flow reaches the field validators.
  async function openAddAgentModalWithBasics() {
    const harness = await openAddAgentModal();
    const [nameInput, descriptionInput] = __testUtils.textInputs;
    const promptArea = findElements(harness.contentEl, (el) => el.tag === 'textarea')[0];
    nameInput.value = 'review';
    descriptionInput.value = 'Reviews code.';
    promptArea.value = 'Review carefully.';
    return harness;
  }

  function fieldInput(field: 'temperature' | 'topP' | 'steps' | 'tools' | 'permission' | 'options'): { value: string } {
    const [, , , , temperature, topP, , steps] = __testUtils.textInputs;
    const [tools, permission, options] = __testUtils.textAreaInputs;
    const inputs: Record<string, { value: string }> = { temperature, topP, steps, tools, permission, options };
    return inputs[field];
  }

  // One scenario per formatAgentFieldIssue branch, plus one per validated
  // field so every t(field) label wiring is covered.
  const FIELD_VALIDATION_SCENARIOS: Array<{
    field: 'temperature' | 'topP' | 'steps' | 'tools' | 'permission' | 'options';
    value: string;
    issueKey: TranslationKey;
    fieldKey: TranslationKey;
  }> = [
    {
      field: 'temperature',
      value: 'abc',
      issueKey: 'settings.opencode.subagents.validation.validNumber',
      fieldKey: 'settings.opencode.subagents.modal.temperature',
    },
    {
      field: 'topP',
      value: 'not-a-number',
      issueKey: 'settings.opencode.subagents.validation.validNumber',
      fieldKey: 'settings.opencode.subagents.modal.topP',
    },
    {
      field: 'steps',
      value: '2.5',
      issueKey: 'settings.opencode.subagents.validation.positiveInteger',
      fieldKey: 'settings.opencode.subagents.modal.steps',
    },
    {
      field: 'tools',
      value: 'not json',
      issueKey: 'settings.opencode.subagents.validation.validJson',
      fieldKey: 'settings.opencode.subagents.modal.tools',
    },
    {
      field: 'tools',
      value: '[]',
      issueKey: 'settings.opencode.subagents.validation.jsonObject',
      fieldKey: 'settings.opencode.subagents.modal.tools',
    },
    {
      field: 'tools',
      value: '{"write": "yes"}',
      issueKey: 'settings.opencode.subagents.validation.booleanMap',
      fieldKey: 'settings.opencode.subagents.modal.tools',
    },
    {
      field: 'permission',
      value: 'not json',
      issueKey: 'settings.opencode.subagents.validation.validJson',
      fieldKey: 'settings.opencode.subagents.modal.permission',
    },
    {
      field: 'options',
      value: '[]',
      issueKey: 'settings.opencode.subagents.validation.jsonObject',
      fieldKey: 'settings.opencode.subagents.modal.options',
    },
  ];

  it.each(FIELD_VALIDATION_SCENARIOS)(
    'shows the localized $issueKey notice for $field without saving',
    async ({ field, value, issueKey, fieldKey }) => {
      const harness = await openAddAgentModalWithBasics();
      fieldInput(field).value = value;

      await harness.save();

      expect(Notice).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith(t(issueKey, { field: t(fieldKey) }));
      expect(harness.storage.save).not.toHaveBeenCalled();
    },
  );

  it('saves the agent and shows the localized created notice when every field is valid', async () => {
    const harness = await openAddAgentModalWithBasics();
    fieldInput('temperature').value = '0.5';
    fieldInput('topP').value = '0.9';
    fieldInput('steps').value = '10';
    fieldInput('tools').value = '{"write": false}';
    fieldInput('permission').value = '{"edit": "deny"}';
    fieldInput('options').value = '{"focus": "security"}';

    await harness.save();

    expect(harness.storage.save).toHaveBeenCalledTimes(1);
    expect(harness.storage.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'review',
        temperature: 0.5,
        topP: 0.9,
        steps: 10,
        tools: { write: false },
        permission: { edit: 'deny' },
        options: { focus: 'security' },
      }),
      null,
    );
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith(t('settings.opencode.subagents.created', { name: 'review' }));
  });
});
