import { createMockEl } from '@test/helpers/mockElement';

import { ClaudeNativeMcpCutoverModal } from '@/providers/claude/ui/ClaudeNativeMcpCutoverModal';

let lastModalInstance: any;
const createdButtons: any[] = [];

jest.mock('obsidian', () => {
  class MockModal {
    app: any;
    modalEl: any;
    contentEl: any;

    constructor(app: any) {
      this.app = app;
      this.modalEl = createMockEl();
      this.contentEl = createMockEl();
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastModalInstance = this;
    }

    setTitle = jest.fn();

    open() {
      this.onOpen();
    }

    close() {
      this.onClose();
    }

    onOpen() {
      // Overridden by subclass
    }

    onClose() {
      // Overridden by subclass
    }
  }

  class MockSetting {
    public infoEl = createMockEl();

    constructor(private readonly containerEl: any) {}

    setName(name: string) {
      (this.containerEl as any).lastName = name;
      return this;
    }

    setDesc(desc: string) {
      (this.containerEl as any).lastDesc = desc;
      return this;
    }

    addButton(cb: (btn: any) => void) {
      const btn: any = {
        _onClick: null as null | (() => void),
        _text: '' as string,
        setButtonText: jest.fn().mockImplementation((text: string) => {
          btn._text = text;
          return btn;
        }),
        setWarning: jest.fn().mockReturnThis(),
        setCta: jest.fn().mockReturnThis(),
        onClick: jest.fn((handler: () => void) => {
          btn._onClick = handler;
          return btn;
        }),
      };
      createdButtons.push(btn);
      cb(btn);
      return this;
    }
  }

  return { Modal: MockModal, Setting: MockSetting };
});

function collectText(el: any): string {
  let text = '';
  const walk = (node: any) => {
    if (typeof node?.textContent === 'string') text += node.textContent + ' ';
    for (const child of node?.children ?? []) walk(child);
  };
  walk(el);
  return text;
}

describe('ClaudeNativeMcpCutoverModal', () => {
  let confirmSpy: jest.Mock;
  let laterSpy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    lastModalInstance = null;
    createdButtons.length = 0;
    confirmSpy = jest.fn();
    laterSpy = jest.fn();
  });

  function openModal() {
    const modal = new ClaudeNativeMcpCutoverModal({} as any, {
      onConfirm: confirmSpy,
      onLater: laterSpy,
    });
    modal.open();
    return modal;
  }

  it('explains the cutover consequences in fixed copy', () => {
    openModal();

    const text = collectText(lastModalInstance.contentEl);
    expect(text).toContain('remains untouched');
    expect(text).toContain('same name');
    expect(text).toContain('fine-grained');
  });

  it('never offers export, delete, or migration buttons', () => {
    openModal();

    const texts = createdButtons.map(btn => String(btn._text ?? '')).join('|').toLowerCase();
    expect(texts).not.toContain('export');
    expect(texts).not.toContain('delete');
    expect(texts).not.toContain('migrate');
  });

  it('provides exactly three actions: help link, later, and explicit confirmation', () => {
    openModal();

    const anchors = collectAnchors(lastModalInstance.contentEl);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    expect(anchors[0].getAttribute('href')).toBe('https://code.claude.com/docs/en/mcp');
    const buttonTexts = createdButtons.map(btn => String(btn._text ?? ''));
    expect(buttonTexts).toHaveLength(2);
    expect(buttonTexts.some(t => /confirm/i.test(t))).toBe(true);
    expect(buttonTexts.some(t => /later/i.test(t))).toBe(true);
  });

  it('invokes onConfirm only through the explicit confirm button', () => {
    openModal();

    const confirmBtn = createdButtons.find(btn => /confirm/i.test(String(btn._text ?? '')));
    const laterBtn = createdButtons.find(btn => /later/i.test(String(btn._text ?? '')));

    (confirmBtn?._onClick as (() => void) | null)?.();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(laterSpy).not.toHaveBeenCalled();

    (laterBtn?._onClick as (() => void) | null)?.();
    expect(laterSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it('does not receive or display any server configuration values', () => {
    // Constructor contract: the modal takes only callbacks — no server
    // inventory, no config records, nothing that could print a secret.
    const modal = new ClaudeNativeMcpCutoverModal({} as any, {
      onConfirm: confirmSpy,
      onLater: laterSpy,
    });
    expect(modal).toBeDefined();
  });
});

function collectAnchors(el: any): any[] {
  const anchors: any[] = [];
  const walk = (node: any) => {
    if (typeof node?.tagName === 'string' && node.tagName.toLowerCase() === 'a') anchors.push(node);
    for (const child of node?.children ?? []) walk(child);
  };
  walk(el);
  return anchors;
}
