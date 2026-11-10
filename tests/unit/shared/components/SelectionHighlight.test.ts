import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { installObsidianDom } from '@test/helpers/obsidianDom';
import { JSDOM } from 'jsdom';

import {
  hideSelectionHighlight,
  showSelectionHighlight,
} from '@/shared/components/SelectionHighlight';

describe('SelectionHighlight', () => {
  let dom: JSDOM;
  let editorView: EditorView;
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    const browser = dom.window;
    const globals: Record<string, unknown> = {
      document: browser.document,
      DOMRect: browser.DOMRect,
      Element: browser.Element,
      Event: browser.Event,
      EventTarget: browser.EventTarget,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      HTMLElement: browser.HTMLElement,
      KeyboardEvent: browser.KeyboardEvent,
      MouseEvent: browser.MouseEvent,
      MutationObserver: browser.MutationObserver,
      navigator: browser.navigator,
      Node: browser.Node,
      Range: browser.Range,
      ResizeObserver: undefined,
      window: browser,
      Window: browser.Window,
    };
    savedGlobals = new Map();
    for (const [key, value] of Object.entries(globals)) {
      savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    installObsidianDom();
    browser.requestAnimationFrame = () => 1;
    browser.cancelAnimationFrame = () => {};
    editorView = new EditorView({
      state: EditorState.create({ doc: 'alpha beta\ngamma' }),
      parent: browser.document.body,
    });
  });

  afterEach(() => {
    try {
      editorView?.destroy();
    } finally {
      dom?.window.close();
      for (const [key, descriptor] of savedGlobals ?? []) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      }
    }
  });

  it('paints the highlight on a freshly shown selection', () => {
    showSelectionHighlight(editorView, 0, 5);
    expect(editorView.dom.querySelectorAll('.claudian-selection-highlight')).toHaveLength(1);

    hideSelectionHighlight(editorView);
    expect(editorView.dom.querySelectorAll('.claudian-selection-highlight')).toHaveLength(0);
  });

  it('reinstalls the highlight field after a setState so a later show still paints', () => {
    showSelectionHighlight(editorView, 0, 5);
    expect(editorView.dom.querySelectorAll('.claudian-selection-highlight')).toHaveLength(1);

    // setState swaps the whole state: every appended extension is dropped.
    editorView.setState(EditorState.create({ doc: 'alpha beta\ngamma' }));
    expect(editorView.dom.querySelectorAll('.claudian-selection-highlight')).toHaveLength(0);

    // The stale-installation bug: with a historical install mark the second
    // show dispatches into a state that no longer owns the field, so the
    // highlight never repaints. Installation must follow the live state.
    showSelectionHighlight(editorView, 6, 11);
    expect(editorView.dom.querySelectorAll('.claudian-selection-highlight')).toHaveLength(1);
  });

  it('keeps installation bounded across repeated show/hide cycles on one view', () => {
    showSelectionHighlight(editorView, 0, 5);
    hideSelectionHighlight(editorView);

    const dispatch = jest.spyOn(editorView, 'dispatch');
    for (let cycle = 0; cycle < 3; cycle++) {
      showSelectionHighlight(editorView, 0, 5);
      hideSelectionHighlight(editorView);
    }
    const appendConfigEffects = dispatch.mock.calls.reduce((sum: number, call: any) => {
      const spec: any = call[0];
      const effects = Array.isArray(spec?.effects)
        ? spec.effects
        : spec?.effects
          ? [spec.effects]
          : [];
      return sum + effects.filter((effect: any) => effect?.is?.(StateEffect.appendConfig)).length;
    }, 0);
    expect(appendConfigEffects).toBe(0);
  });

  it('hide stays a no-op on a view that never installed the field', () => {
    expect(() => hideSelectionHighlight(editorView)).not.toThrow();
  });
});
