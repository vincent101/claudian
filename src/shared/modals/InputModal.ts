import { type App, Modal, Setting } from 'obsidian';

import { t } from '../../i18n/i18n';

export interface InputModalOptions {
  /** Prefilled input value. */
  value: string;
  /** Modal title; defaults to the rename-title label. */
  title?: string;
  /** Receives the trimmed, non-empty value. Never called on cancel or blank input. */
  onSubmit: (value: string) => void | Promise<void>;
}

/** Single-line text input modal: Enter/Save confirms, Esc/Cancel dismisses. */
export class InputModal extends Modal {
  private options: InputModalOptions;
  private inputEl: HTMLInputElement | null = null;

  constructor(app: App, options: InputModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen() {
    this.setTitle(this.options.title ?? t('chat.tabs.renameTitle'));

    const inputEl = this.contentEl.createEl('input', { cls: 'claudian-input-modal-field' });
    inputEl.type = 'text';
    inputEl.value = this.options.value;
    inputEl.style.width = '100%';
    this.inputEl = inputEl;

    inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      // !isComposing keeps IME candidate confirmation (CJK) from submitting.
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    new Setting(this.contentEl)
      .addButton(btn =>
        btn
          .setButtonText(t('common.cancel'))
          .onClick(() => this.close())
      )
      .addButton(btn =>
        btn
          .setButtonText(t('common.save'))
          .setCta()
          .onClick(() => this.submit())
      );

    inputEl.focus();
    inputEl.select();
  }

  onClose() {
    this.contentEl.empty();
  }

  private submit(): void {
    const value = (this.inputEl?.value ?? '').trim();
    this.close();
    if (!value) return;
    void this.options.onSubmit(value);
  }
}
