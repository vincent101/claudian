import { createMockEl } from '@test/helpers/mockElement';

let lastModalInstance: any;
let createdButtons: any[] = [];

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');

  class MockModal {
    app: any;
    modalEl: any;
    contentEl: any;
    closeCount = 0;

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
      this.closeCount++;
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
    constructor(_containerEl: any) {}

    addButton(cb: (btn: any) => void) {
      const btn: any = {
        _text: '',
        _onClick: null as null | (() => void),
        setButtonText: jest.fn((text: string) => {
          btn._text = text;
          return btn;
        }),
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

  return {
    ...actual,
    Modal: MockModal,
    Setting: MockSetting,
  };
});

import { t } from '@/i18n/i18n';
import { InputModal } from '@/shared/modals/InputModal';

beforeEach(() => {
  lastModalInstance = null;
  createdButtons = [];
});

function openModal(value: string, onSubmit: jest.Mock) {
  const modal = new InputModal({} as any, { value, onSubmit });
  modal.open();
  const inputEl = (modal as any).inputEl;
  return { modal, inputEl };
}

function pressKey(inputEl: any, key: string, extra: Record<string, unknown> = {}) {
  const event = { type: 'keydown', key, isComposing: false, preventDefault: jest.fn(), ...extra };
  inputEl.dispatchEvent(event);
  return event;
}

describe('InputModal', () => {
  it('sets the rename title and prefills the input with the given value', () => {
    const { modal, inputEl } = openModal('Old title', jest.fn());

    expect(lastModalInstance.setTitle).toHaveBeenCalledWith(t('chat.tabs.renameTitle'));
    expect(inputEl.value).toBe('Old title');
    expect(modal).toBe(lastModalInstance);
  });

  it('creates cancel and save buttons using the shared common labels', () => {
    openModal('x', jest.fn());

    expect(createdButtons.map(btn => btn._text)).toEqual([t('common.cancel'), t('common.save')]);
  });

  it('submits the trimmed value on Enter and closes', () => {
    const onSubmit = jest.fn();
    const { inputEl } = openModal('Old', onSubmit);

    inputEl.value = '  New title  ';
    pressKey(inputEl, 'Enter');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('New title');
    expect(lastModalInstance.closeCount).toBe(1);
  });

  it('submits the trimmed value from the save button', () => {
    const onSubmit = jest.fn();
    const { inputEl } = openModal('Old', onSubmit);

    inputEl.value = ' Saved ';
    createdButtons[1]._onClick();

    expect(onSubmit).toHaveBeenCalledWith('Saved');
    expect(lastModalInstance.closeCount).toBe(1);
  });

  it('closes silently without submitting when the trimmed value is empty', () => {
    const onSubmit = jest.fn();
    const { inputEl } = openModal('Old', onSubmit);

    inputEl.value = '   \t ';
    pressKey(inputEl, 'Enter');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastModalInstance.closeCount).toBe(1);
  });

  it('does not submit while an IME composition is active', () => {
    const onSubmit = jest.fn();
    const { inputEl } = openModal('Old', onSubmit);

    inputEl.value = 'ni';
    pressKey(inputEl, 'Enter', { isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastModalInstance.closeCount).toBe(0);
  });

  it('closes without submitting on Escape', () => {
    const onSubmit = jest.fn();
    const { inputEl } = openModal('Old', onSubmit);

    inputEl.value = 'Edited but abandoned';
    pressKey(inputEl, 'Escape');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastModalInstance.closeCount).toBe(1);
  });

  it('closes without submitting from the cancel button', () => {
    const onSubmit = jest.fn();
    const { inputEl } = openModal('Old', onSubmit);

    inputEl.value = 'Edited but abandoned';
    createdButtons[0]._onClick();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastModalInstance.closeCount).toBe(1);
  });

  it('does not submit twice when close is triggered after a submit', () => {
    const onSubmit = jest.fn();
    const { inputEl } = openModal('Old', onSubmit);

    inputEl.value = 'New';
    pressKey(inputEl, 'Enter');
    lastModalInstance.close();

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
