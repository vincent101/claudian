import { ReadableStream, TransformStream, WritableStream } from 'stream/web';
import { TextDecoder, TextEncoder } from 'util';

Object.assign(globalThis, { ReadableStream, TransformStream, WritableStream, TextDecoder, TextEncoder });

// Obsidian extends real DOM nodes; keep browser event and node semantics intact.
export function installObsidianDom(): void {
  const proto = HTMLElement.prototype;
  Object.assign(proto, {
    createEl(this: HTMLElement, tag: string, options: Record<string, any> = {}) {
      const child = document.createElement(tag);
      if (options.cls) child.className = options.cls;
      if (options.text !== undefined) child.textContent = options.text;
      for (const key of ['type', 'placeholder', 'value']) {
        if (options[key] !== undefined) (child as any)[key] = options[key];
      }
      for (const [key, value] of Object.entries(options.attr ?? {})) {
        child.setAttribute(key, String(value));
      }
      this.appendChild(child);
      return child;
    },
    createDiv(this: HTMLElement, options: Record<string, any> = {}) {
      return this.createEl('div', options);
    },
    createSpan(this: HTMLElement, options: Record<string, any> = {}) {
      return this.createEl('span', options);
    },
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, value: string) { this.textContent = value; },
    addClass(this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); },
    removeClass(this: HTMLElement, ...classes: string[]) { this.classList.remove(...classes); },
    toggleClass(this: HTMLElement, cls: string, enabled: boolean) { this.classList.toggle(cls, enabled); },
    hasClass(this: HTMLElement, cls: string) { return this.classList.contains(cls); },
    setCssProps(this: HTMLElement, props: Record<string, string>) {
      for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
    },
  });
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
}
