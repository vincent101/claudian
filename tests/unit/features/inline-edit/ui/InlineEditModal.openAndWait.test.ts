import '@/providers';

import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, type WidgetType } from '@codemirror/view';
import { createMockEl } from '@test/helpers/mockElement';
import { installObsidianDom } from '@test/helpers/obsidianDom';
import { JSDOM } from 'jsdom';
import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { type InlineEditContext, InlineEditModal } from '@/features/inline-edit/ui/InlineEditModal';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';
import { SlashCommandDropdown } from '@/shared/components/SlashCommandDropdown';
import { MentionDropdownController } from '@/shared/mention/MentionDropdownController';
import { VaultFolderCache } from '@/shared/mention/VaultMentionCache';
import * as editorUtils from '@/utils/editor';

jest.mock('@/utils/externalContextScanner', () => ({
  externalContextScanner: {
    scanPaths: jest.fn().mockReturnValue([]),
  },
}));

describe('InlineEditModal - openAndWait', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses editorCallback references first and falls back to view.editor before rejecting', async () => {
    const callbackEditor = {} as any;
    const fallbackEditor = {} as any;

    const app = {
      workspace: {
        getActiveViewOfType: jest.fn(),
      },
    } as any;
    const plugin = {} as any;
    const view = { editor: fallbackEditor } as any;

    const editContext: InlineEditContext = {
      mode: 'cursor',
      cursorContext: {
        beforeCursor: '',
        afterCursor: '',
        isInbetween: true,
        line: 0,
        column: 0,
      },
    };

    const getEditorViewSpy = jest
      .spyOn(editorUtils, 'getEditorView')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined);

    const modal = new InlineEditModal(app, plugin, callbackEditor, view, editContext, 'note.md');
    const result = await modal.openAndWait();

    expect(result).toEqual({ decision: 'reject' });
    expect(getEditorViewSpy).toHaveBeenNthCalledWith(1, callbackEditor);
    expect(getEditorViewSpy).toHaveBeenNthCalledWith(2, fallbackEditor);
    expect(app.workspace.getActiveViewOfType).not.toHaveBeenCalled();

    const noticeMock = Notice as unknown as jest.Mock;
    expect(noticeMock).toHaveBeenCalledWith(
      'Inline edit unavailable: could not access the active editor. Try reopening the note.'
    );
  });

  it('wires mention getCachedVaultFolders through VaultFolderCache.getFolders', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue([]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0 })),
          },
        },
        dispatch,
        dom: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);
      const getFoldersSpy = jest
        .spyOn(VaultFolderCache.prototype, 'getFolders')
        .mockReturnValue([{ name: 'src', path: 'src' } as any]);

      const editContext: InlineEditContext = {
        mode: 'cursor',
        cursorContext: {
          beforeCursor: '',
          afterCursor: '',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      expect(widgetRef.mentionDropdown).toBeDefined();
      const callbacks = widgetRef.mentionDropdown.callbacks;
      expect(callbacks).toBeDefined();
      expect(callbacks.getCachedVaultFolders()).toEqual([{ name: 'src', path: 'src' }]);
      expect(getFoldersSpy).toHaveBeenCalledTimes(1);

      widgetRef?.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });

      getEditorViewSpy.mockRestore();
      getFoldersSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('uses provider-scoped hidden commands for Codex inline edit dropdowns', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue([]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: ['commit'],
            codex: ['analyze'],
          },
        },
        getConversationSync: jest.fn().mockReturnValue(null),
        getView: jest.fn().mockReturnValue({
          getActiveTab: jest.fn().mockReturnValue({
            providerId: 'codex',
            service: null,
            conversationId: null,
          }),
        }),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0 })),
          },
        },
        dispatch,
        dom: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      jest.spyOn(editorUtils, 'getEditorView').mockReturnValue(editorView);

      const editContext: InlineEditContext = {
        mode: 'cursor',
        cursorContext: {
          beforeCursor: '',
          afterCursor: '',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      expect(Array.from(widgetRef.slashCommandDropdown.hiddenCommands)).toEqual(['analyze']);

      widgetRef?.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('passes the active chat runtime model into inline edit services when available', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          getFiles: jest.fn().mockReturnValue([]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const inlineEditService = {
        cancel: jest.fn(),
        continueConversation: jest.fn(),
        editText: jest.fn(),
        resetConversation: jest.fn(),
        setModelOverride: jest.fn(),
      };
      const providerSpy = jest
        .spyOn(ProviderRegistry, 'createInlineEditService')
        .mockReturnValue(inlineEditService as any);
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            opencode: [],
          },
        },
        getConversationSync: jest.fn().mockReturnValue(null),
        getView: jest.fn().mockReturnValue({
          getActiveTab: jest.fn().mockReturnValue({
            conversationId: null,
            draftModel: 'opencode:openai/gpt-5.4',
            providerId: 'opencode',
            service: {
              getAuxiliaryModel: jest.fn().mockReturnValue('opencode:openai/gpt-5.4'),
              providerId: 'opencode',
            },
          }),
        }),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0 })),
          },
        },
        dispatch,
        dom: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

      const editContext: InlineEditContext = {
        mode: 'cursor',
        cursorContext: {
          beforeCursor: '',
          afterCursor: '',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      expect(providerSpy).toHaveBeenCalledWith(plugin, 'opencode');
      expect(inlineEditService.setModelOverride).toHaveBeenCalledWith('opencode:openai/gpt-5.4');

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
      providerSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('shows a single notice and degrades gracefully when getFiles throws', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockImplementation(() => {
            throw new Error('vault unavailable');
          }),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

      const { externalContextScanner } = jest.requireMock('@/utils/externalContextScanner');
      (externalContextScanner.scanPaths as jest.Mock).mockImplementation((paths: string[]) => {
        if (paths[0] === '/external') {
          return [
            {
              path: '/external/src/app.md',
              name: 'app.md',
              relativePath: 'src/app.md',
              contextRoot: '/external',
              mtime: 1000,
            },
          ];
        }
        return [];
      });

      const editContext: InlineEditContext = {
        mode: 'cursor',
        cursorContext: {
          beforeCursor: '',
          afterCursor: '',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const modal = new InlineEditModal(
        app,
        plugin,
        editor,
        view,
        editContext,
        'note.md',
        () => ['/external']
      );
      const resultPromise = modal.openAndWait();

      const callbacks = widgetRef.mentionDropdown.callbacks;
      expect(callbacks.getCachedVaultFiles()).toEqual([]);
      expect(callbacks.getCachedVaultFiles()).toEqual([]);

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @external/src/app.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['/external/src/app.md']);

      const noticeMock = Notice as unknown as jest.Mock;
      expect(noticeMock).toHaveBeenCalledTimes(1);
      expect(noticeMock).toHaveBeenCalledWith(
        'Failed to load vault files. Vault @-mentions may be unavailable.'
      );

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('parses @mentions into contextFiles at send time without dropdown attachment state', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockReturnValue([
            { path: 'notes/a.md' },
            { path: 'notes/b.md' },
          ]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

      const editContext: InlineEditContext = {
        mode: 'cursor',
        cursorContext: {
          beforeCursor: '',
          afterCursor: '',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @notes/a.md and @notes/a.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['notes/a.md']);

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('resolves external context @mentions into contextFiles at send time', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockReturnValue([{ path: 'notes/local.md' }]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

      const editContext: InlineEditContext = {
        mode: 'cursor',
        cursorContext: {
          beforeCursor: '',
          afterCursor: '',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const { externalContextScanner } = jest.requireMock('@/utils/externalContextScanner');
      (externalContextScanner.scanPaths as jest.Mock).mockImplementation((paths: string[]) => {
        if (paths[0] === '/external') {
          return [
            {
              path: '/external/src/app.md',
              name: 'app.md',
              relativePath: 'src/app.md',
              contextRoot: '/external',
              mtime: 1000,
            },
          ];
        }
        return [];
      });

      const modal = new InlineEditModal(
        app,
        plugin,
        editor,
        view,
        editContext,
        'note.md',
        () => ['/external']
      );
      const resultPromise = modal.openAndWait();

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @external/src/app.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['/external/src/app.md']);

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('parses vault @mentions with spaces into contextFiles at send time', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockReturnValue([
            { path: 'notes/my note.md' },
          ]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

      const editContext: InlineEditContext = {
        mode: 'cursor',
        cursorContext: {
          beforeCursor: '',
          afterCursor: '',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const modal = new InlineEditModal(app, plugin, editor, view, editContext, 'note.md');
      const resultPromise = modal.openAndWait();

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @notes/my note.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['notes/my note.md']);

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });

  it('resolves external @mentions when vault has no files', async () => {
    const originalDocument = (global as any).document;
    (global as any).document = {
      body: createMockEl('body'),
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };

    try {
      const app = {
        vault: {
          adapter: { basePath: '/vault' },
          getFiles: jest.fn().mockReturnValue([]),
          getAllLoadedFiles: jest.fn().mockReturnValue([]),
        },
        workspace: {
          getActiveViewOfType: jest.fn(),
        },
      } as any;
      const plugin = {
        settings: {
          hiddenProviderCommands: {
            claude: [],
            codex: [],
          },
        },
        getSdkCommands: jest.fn().mockReturnValue([]),
      } as any;
      const editor = {} as any;
      const view = { editor } as any;

      let widgetRef: any = null;
      const dispatch = jest.fn((transaction: any) => {
        const effects = Array.isArray(transaction?.effects)
          ? transaction.effects
          : transaction?.effects
            ? [transaction.effects]
            : [];
        for (const effect of effects) {
          const widget = effect?.value?.widget;
          if (widget && typeof widget.createInputDOM === 'function') {
            widgetRef = widget;
            widget.createInputDOM();
          }
        }
      });
      const editorView = {
        state: {
          doc: {
            line: jest.fn(() => ({ from: 0 })),
            lineAt: jest.fn(() => ({ from: 0, number: 1 })),
          },
        },
        dispatch,
        dom: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      } as any;

      const getEditorViewSpy = jest
        .spyOn(editorUtils, 'getEditorView')
        .mockReturnValue(editorView);

      const editContext: InlineEditContext = {
        mode: 'cursor',
        cursorContext: {
          beforeCursor: '',
          afterCursor: '',
          isInbetween: true,
          line: 0,
          column: 0,
        },
      };

      const { externalContextScanner } = jest.requireMock('@/utils/externalContextScanner');
      (externalContextScanner.scanPaths as jest.Mock).mockImplementation((paths: string[]) => {
        if (paths[0] === '/external') {
          return [
            {
              path: '/external/src/my file.md',
              name: 'my file.md',
              relativePath: 'src/my file.md',
              contextRoot: '/external',
              mtime: 1000,
            },
          ];
        }
        return [];
      });

      const modal = new InlineEditModal(
        app,
        plugin,
        editor,
        view,
        editContext,
        'note.md',
        () => ['/external']
      );
      const resultPromise = modal.openAndWait();

      const editTextMock = jest.fn().mockResolvedValue({
        success: true,
        clarification: 'Need more detail',
      });
      widgetRef.inlineEditService = {
        editText: editTextMock,
        continueConversation: jest.fn(),
        cancel: jest.fn(),
        resetConversation: jest.fn(),
      };

      widgetRef.inputEl.value = 'Please check @external/src/my file.md.';
      await widgetRef.generate();

      expect(editTextMock).toHaveBeenCalledTimes(1);
      expect(editTextMock.mock.calls[0][0].contextFiles).toEqual(['/external/src/my file.md']);

      widgetRef.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      getEditorViewSpy.mockRestore();
    } finally {
      (global as any).document = originalDocument;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Command discovery wiring (§6 W4d): the inline entry must consume the typed
// catalog unbound — the active chat's SDK commands never leak in — and must
// rebind/unsubscribe across registry catalog replacement and cleanup.
// ─────────────────────────────────────────────────────────────────────────────
describe('InlineEditModal - command discovery wiring', () => {
  let originalDocument: any;
  let originalWindow: any;
  let bodyEl: any;

  function installDom() {
    originalDocument = (global as any).document;
    originalWindow = (global as any).window;
    bodyEl = createMockEl('body');
    (global as any).document = {
      body: bodyEl,
      createElement: (tagName: string) => createMockEl(tagName),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    (global as any).window = { innerHeight: 600, innerWidth: 800 };
  }

  function restoreDom() {
    (global as any).document = originalDocument;
    (global as any).window = originalWindow;
  }

  function vaultCommand(name: string) {
    return {
      id: `vault:${name}`,
      name,
      description: `${name} command`,
      content: '',
      source: 'user',
    };
  }

  function createVaultCatalog(names: string[]) {
    const commands = names.map(vaultCommand);
    const probe = jest.fn(() => {
      throw new Error('owned probe must not fire from the inline entry');
    });
    const catalog = new ClaudeCommandCatalog(
      { loadAll: async () => commands } as any,
      { loadAll: async () => [] } as any,
      probe as any,
    );
    return { catalog, probe };
  }

  function getRenderedCommandNames(): string[] {
    const dropdownEl = bodyEl.children.find((c: any) => c.hasClass('claudian-slash-dropdown'));
    if (!dropdownEl) return [];
    const items = dropdownEl.querySelectorAll('.claudian-slash-item');
    return items.map((item: any) => {
      const nameSpan = item.children.find((c: any) => c.hasClass('claudian-slash-name'));
      return nameSpan?.textContent ?? '';
    });
  }

  function wiringPluginFixture() {
    return {
      settings: {
        hiddenProviderCommands: { claude: [], codex: [] },
      },
      getConversationSync: jest.fn().mockReturnValue({ providerId: 'claude' }),
      getView: jest.fn().mockReturnValue({
        getActiveTab: jest.fn().mockReturnValue({
          providerId: 'claude',
          service: null,
          conversationId: 'active-conversation',
        }),
      }),
    } as any;
  }

  async function flushAsync(ticks = 20): Promise<void> {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  }

  /** Creates the modal, drives openAndWait until createInputDOM ran. */
  async function openInlineModal(plugin: any): Promise<{ modal: InlineEditModal; widget: any; resultPromise: Promise<any> }> {
    const editor = {} as any;
    const view = { editor } as any;
    const editContext: InlineEditContext = {
      mode: 'cursor',
      cursorContext: {
        beforeCursor: '',
        afterCursor: '',
        isInbetween: true,
        line: 0,
        column: 0,
      },
    };
    let widget: any = null;
    const dispatch = jest.fn((transaction: any) => {
      const effects = Array.isArray(transaction?.effects)
        ? transaction.effects
        : transaction?.effects
          ? [transaction.effects]
          : [];
      for (const effect of effects) {
        const candidate = effect?.value?.widget;
        if (candidate && typeof candidate.createInputDOM === 'function') {
          widget = candidate;
          widget.createInputDOM();
        }
      }
    });
    const editorView = {
      state: {
        doc: {
          line: jest.fn(() => ({ from: 0 })),
          lineAt: jest.fn(() => ({ from: 0 })),
        },
      },
      dispatch,
      dom: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    } as any;
    jest
      .spyOn(editorUtils, 'getEditorView')
      .mockReturnValue(editorView);

    const modal = new InlineEditModal(
      { vault: { getFiles: jest.fn().mockReturnValue([]), getAllLoadedFiles: jest.fn().mockReturnValue([]) }, workspace: {} } as any,
      plugin,
      editor,
      view,
      editContext,
      'note.md',
      () => [],
    );
    const resultPromise = modal.openAndWait();
    await flushAsync(5);
    expect(widget).not.toBeNull();
    return { modal, widget, resultPromise };
  }

  function getRealDropdown(widget: any): any {
    const instance = widget.slashCommandDropdown;
    expect(instance).toBeDefined();
    return instance;
  }

  function typeSlash(widget: any): void {
    const inputEl = (widget as any).inputEl;
    inputEl.value = '/';
    inputEl.selectionStart = 1;
    getRealDropdown(widget).handleInputChange();
  }

  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
    jest.restoreAllMocks();
  });

  it('keeps inline discovery unbound even when an active chat has SDK commands', async () => {
    installDom();
    try {
      const { catalog, probe } = createVaultCatalog(['inline-vault']);
      // The active chat pushed its SDK commands into the catalog's legacy
      // global slot; the unbound typed factory must never surface them.
      catalog.setRuntimeCommands([{ id: 'sdk:foreign', name: 'foreign', content: '', source: 'sdk' } as any]);
      const listLegacy = jest.spyOn(catalog, 'listDropdownEntries');
      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog } as any);

      const plugin = wiringPluginFixture();
      const { widget, resultPromise } = await openInlineModal(plugin);

      // The real production config's typed factory reaches the real dropdown.
      const dropdown = getRealDropdown(widget);
      expect(typeof dropdown.providerConfig?.createDiscoverySession).toBe('function');

      typeSlash(widget);
      await flushAsync();

      const names = getRenderedCommandNames();
      expect(names).toContain('/inline-vault');
      expect(names).toContain('/clear');
      expect(names).not.toContain('/foreign');

      // The active chat getter and the owned probe never fire.
      expect(listLegacy).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();

      widget.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
    } finally {
      restoreDom();
    }
  });

  it('rebinds inline catalog replacement and unsubscribes on cleanup', async () => {
    installDom();
    const realSubscribeCommandCatalog =
      ProviderWorkspaceRegistry.subscribeCommandCatalog.bind(ProviderWorkspaceRegistry);
    const unsubscribeSpy = jest.fn();
    const subscribeSpy = jest
      .spyOn(ProviderWorkspaceRegistry, 'subscribeCommandCatalog')
      .mockImplementation((providerId, listener) => {
        const unsubscribe = realSubscribeCommandCatalog(providerId, listener);
        return () => {
          unsubscribeSpy();
          unsubscribe();
        };
      });
    try {
      const { catalog: catalog1 } = createVaultCatalog(['inline-one']);
      const { catalog: catalog2 } = createVaultCatalog(['inline-two']);
      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog1 } as any);

      const plugin = wiringPluginFixture();
      const { widget, resultPromise } = await openInlineModal(plugin);
      typeSlash(widget);
      await flushAsync();
      expect(getRenderedCommandNames()).toContain('/inline-one');

      const dropdown = getRealDropdown(widget);
      const setProviderCatalogSpy = jest.spyOn(dropdown, 'setProviderCatalog');
      const inputEl = (widget as any).inputEl;
      const oldItemEl = (bodyEl.children.find((c: any) => c.hasClass('claudian-slash-dropdown')) || { querySelectorAll: () => [] })
        .querySelectorAll('.claudian-slash-item')[0];

      // Registry replacement synchronously withdraws the old options; the
      // next input evaluation renders the replacement catalog's vault entries.
      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog2 } as any);
      expect(setProviderCatalogSpy).toHaveBeenCalledTimes(1);
      const [replacementConfig] = setProviderCatalogSpy.mock.calls[0] as [{ createDiscoverySession?: unknown }, unknown];
      expect(typeof replacementConfig.createDiscoverySession).toBe('function');
      expect(getRenderedCommandNames()).toEqual([]);
      typeSlash(widget);
      await flushAsync();
      expect(getRenderedCommandNames()).toContain('/inline-two');

      // A stale detached option from the replaced catalog cannot insert.
      inputEl.value = '/';
      oldItemEl?.click();
      expect(inputEl.value).toBe('/');

      // Registry clear rebinds to null: old options are gone, builtins remain.
      ProviderWorkspaceRegistry.setServices('claude', undefined);
      expect(setProviderCatalogSpy).toHaveBeenCalledTimes(2);
      // The provider identity is passed through even for a null catalog so
      // capability-gated built-ins stay gated.
      expect(setProviderCatalogSpy.mock.calls[1]).toEqual([null, null, 'claude']);
      typeSlash(widget);
      await flushAsync();
      const afterClear = getRenderedCommandNames();
      expect(afterClear).not.toContain('/inline-one');
      expect(afterClear).not.toContain('/inline-two');
      expect(afterClear).toContain('/clear');

      // cleanup() unsubscribes first: later registry notifications never call
      // back into the destroyed UI.
      widget.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
      const { catalog: catalog3 } = createVaultCatalog(['inline-three']);
      ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog3 } as any);
      expect(setProviderCatalogSpy).toHaveBeenCalledTimes(2);
    } finally {
      subscribeSpy.mockRestore();
      restoreDom();
    }
  });

  it('scopes inline built-in commands to the resolved provider when no catalog is published', async () => {
    installDom();
    try {
      // OpenCode publishes no workspace services here: the inline dropdown must
      // not fall back to an undefined provider identity, because an undefined
      // context ungates capability-gated built-ins such as /fork.
      const plugin = {
        settings: {
          hiddenProviderCommands: { claude: [], codex: [] },
        },
        getConversationSync: jest.fn().mockReturnValue(null),
        getView: jest.fn().mockReturnValue({
          getActiveTab: jest.fn().mockReturnValue({
            providerId: 'opencode',
            service: null,
            conversationId: null,
          }),
        }),
      } as any;
      jest.spyOn(ProviderRegistry, 'createInlineEditService').mockReturnValue({
        cancel: jest.fn(),
        continueConversation: jest.fn(),
        editText: jest.fn(),
        resetConversation: jest.fn(),
        setModelOverride: jest.fn(),
      } as any);

      const { widget, resultPromise } = await openInlineModal(plugin);
      try {
        expect((widget as any).resolvedProviderId).toBe('opencode');
        typeSlash(widget);
        await flushAsync();

        const names = getRenderedCommandNames();
        expect(names).toContain('/clear');
        expect(names).not.toContain('/fork');
      } finally {
        // Even a failing red assertion must not leak the module-level
        // activeController into later suites.
        widget?.reject();
        await resultPromise?.catch(() => undefined);
      }
    } finally {
      restoreDom();
    }
  });
});

describe('InlineEditModal - input DOM ownership', () => {
  let dom: JSDOM;
  let editorView: EditorView;
  let controller: any;
  let resultPromise: Promise<any>;
  let catalog: ClaudeCommandCatalog;
  let service: {
    cancel: jest.Mock;
    continueConversation: jest.Mock;
    editText: jest.Mock;
    resetConversation: jest.Mock;
    setModelOverride: jest.Mock;
  };
  let registryListeners: Array<() => void>;
  let unsubscribes: jest.Mock[];
  let unsubscribeHook: ((index: number) => void) | null;
  let addEventSpy: jest.SpyInstance;
  let removeEventSpy: jest.SpyInstance;
  let timeoutSpy: jest.SpyInstance;
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;

  function makeCatalog(name: string): ClaudeCommandCatalog {
    return new ClaudeCommandCatalog(
      { loadAll: async () => [{ id: `vault:${name}`, name, content: '', source: 'user' }] } as any,
      { loadAll: async () => [] } as any,
    );
  }

  function findInputWidget(): WidgetType {
    let inputWidget: WidgetType | null = null;
    for (const decorations of editorView.state.facet(EditorView.decorations)) {
      if (typeof decorations === 'function') continue;
      decorations.between(0, editorView.state.doc.length, (_from, _to, decoration) => {
        const candidate = decoration.spec.widget as WidgetType | undefined;
        if (candidate && (candidate as any).controller === controller) inputWidget = candidate;
      });
    }
    if (!inputWidget) throw new Error('CodeMirror input widget was not found');
    return inputWidget;
  }

  function changeSelection(): void {
    editorView.dispatch({ selection: { anchor: 1, head: 6 } });
    editorView.dom.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  }

  function listenersFor(target: EventTarget, type: string): EventListener[] {
    return addEventSpy.mock.calls.flatMap((args, index) => {
      const listener = args[1];
      return addEventSpy.mock.contexts[index] === target && args[0] === type && typeof listener === 'function'
        ? [listener as EventListener]
        : [];
    });
  }

  function removalsFor(target: EventTarget, type: string): number {
    return removeEventSpy.mock.calls.filter((args, index) =>
      removeEventSpy.mock.contexts[index] === target && args[0] === type
    ).length;
  }

  function focusCallbacks(): Array<() => void> {
    return timeoutSpy.mock.calls.flatMap(([callback, delay]) =>
      delay === 50 && typeof callback === 'function' ? [callback as () => void] : []
    );
  }

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  beforeEach(() => {
    jest.useFakeTimers();
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

    addEventSpy = jest.spyOn(browser.EventTarget.prototype, 'addEventListener');
    removeEventSpy = jest.spyOn(browser.EventTarget.prototype, 'removeEventListener');
    timeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    registryListeners = [];
    unsubscribes = [];
    unsubscribeHook = null;
    const subscribe = ProviderWorkspaceRegistry.subscribeCommandCatalog.bind(ProviderWorkspaceRegistry);
    jest.spyOn(ProviderWorkspaceRegistry, 'subscribeCommandCatalog').mockImplementation((providerId, listener) => {
      const index = registryListeners.push(listener) - 1;
      const unsubscribe = subscribe(providerId, listener);
      const trackedUnsubscribe = jest.fn(() => {
        unsubscribe();
        unsubscribeHook?.(index);
      });
      unsubscribes.push(trackedUnsubscribe);
      return trackedUnsubscribe;
    });

    service = {
      cancel: jest.fn(),
      continueConversation: jest.fn(),
      editText: jest.fn(),
      resetConversation: jest.fn(),
      setModelOverride: jest.fn(),
    };
    jest.spyOn(ProviderRegistry, 'createInlineEditService').mockReturnValue(service as any);
    catalog = makeCatalog('inline-owner');
    ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: catalog } as any);
    editorView = new EditorView({
      state: EditorState.create({ doc: 'alpha beta\ngamma', selection: { anchor: 0, head: 5 } }),
      parent: browser.document.body,
    });
    const editor = {
      cm: editorView,
      getCursor: (side: 'from' | 'to') => {
        const position = editorView.state.selection.main[side];
        const line = editorView.state.doc.lineAt(position);
        return { line: line.number - 1, ch: position - line.from };
      },
      getSelection: () => {
        const { from, to } = editorView.state.selection.main;
        return editorView.state.sliceDoc(from, to);
      },
      replaceRange: jest.fn(),
    } as any;
    const app = {
      vault: { adapter: { basePath: '/vault' }, getFiles: () => [], getAllLoadedFiles: () => [] },
      workspace: {},
    } as any;
    const plugin = { settings: { hiddenProviderCommands: { claude: [], codex: [] } } } as any;
    const modal = new InlineEditModal(
      app, plugin, editor, { editor } as any, { mode: 'selection', selectedText: 'alpha' }, 'note.md'
    );
    resultPromise = modal.openAndWait();
    controller = (modal as any).controller;
  });

  afterEach(async () => {
    unsubscribeHook = null;
    try {
      controller?.reject();
      editorView?.destroy();
      await resultPromise?.catch(() => undefined);
      ProviderWorkspaceRegistry.clear();
    } finally {
      jest.restoreAllMocks();
      dom?.window.close();
      for (const [key, descriptor] of savedGlobals ?? []) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as any)[key];
      }
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('replaces a real CodeMirror widget without leaving old dropdowns, listeners, or sessions', async () => {
    const oldWidget = findInputWidget();
    const oldRoot = controller.containerEl as HTMLElement;
    const oldInput = controller.inputEl as HTMLInputElement;
    const oldSlash = controller.slashCommandDropdown as SlashCommandDropdown;
    const oldMention = controller.mentionDropdown as MentionDropdownController;
    const oldSession = (oldSlash as any).session;
    const release = jest.spyOn(oldSession, 'release');
    const slashDestroy = jest.spyOn(oldSlash, 'destroy');
    const mentionDestroy = jest.spyOn(oldMention, 'destroy');
    const oldInputHandlers = listenersFor(oldInput, 'input');
    const oldKeyHandlers = listenersFor(oldInput, 'keydown');
    expect(oldInputHandlers).toHaveLength(2);
    expect(oldKeyHandlers).toHaveLength(1);

    oldInput.value = '/';
    oldInput.setSelectionRange(1, 1);
    oldInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flushMicrotasks();
    const oldSlashNode = document.querySelector<HTMLElement>('.claudian-slash-dropdown');
    const oldItem = oldSlashNode?.querySelector<HTMLElement>('.claudian-slash-item');
    expect(oldItem).toBeTruthy();
    oldInput.value = '@';
    oldInput.setSelectionRange(1, 1);
    oldInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    jest.advanceTimersByTime(200);
    const oldMentionNode = document.querySelector<HTMLElement>('.claudian-mention-dropdown');
    expect(oldMentionNode).toBeTruthy();
    expect((catalog as any).activeSessions.size).toBe(1);

    changeSelection();
    const newRoot = controller.containerEl as HTMLElement;
    const newInput = controller.inputEl as HTMLInputElement;
    const newSlash = controller.slashCommandDropdown as SlashCommandDropdown;
    const newMention = controller.mentionDropdown as MentionDropdownController;
    expect(newRoot).not.toBe(oldRoot);
    expect(newInput.value).toBe('');
    expect(newInput.placeholder).toBe('Edit instructions...');
    expect(oldRoot.isConnected).toBe(false);
    expect(oldSlashNode?.isConnected).toBe(false);
    expect(oldMentionNode?.isConnected).toBe(false);
    expect(slashDestroy).toHaveBeenCalledTimes(1);
    expect(mentionDestroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect((oldSession as any).listeners.size).toBe(0);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(removalsFor(oldInput, 'keydown')).toBe(1);
    expect(removalsFor(oldInput, 'input')).toBe(2);
    expect((catalog as any).activeSessions.size).toBe(1);

    const newSlashDestroy = jest.spyOn(newSlash, 'destroy');
    const rebindNew = jest.spyOn(newSlash, 'setProviderCatalog');
    const newMentionInput = jest.spyOn(newMention, 'handleInputChange');
    const newMentionKey = jest.spyOn(newMention, 'handleKeydown');
    const newSlashKey = jest.spyOn(newSlash, 'handleKeydown');
    newInput.value = 'keep this input';
    oldWidget.destroy(oldRoot);
    oldWidget.destroy(oldRoot);
    oldWidget.destroy(document.createElement('div'));
    registryListeners[0]();
    for (const listener of oldInputHandlers) listener.call(oldInput, new dom.window.Event('input'));
    for (const listener of oldKeyHandlers) {
      listener.call(oldInput, new dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    }
    oldInput.dispatchEvent(new dom.window.Event('input'));
    oldItem?.click();
    expect(newSlashDestroy).not.toHaveBeenCalled();
    expect(rebindNew).not.toHaveBeenCalled();
    expect(newMentionInput).not.toHaveBeenCalled();
    expect(newMentionKey).not.toHaveBeenCalled();
    expect(newSlashKey).not.toHaveBeenCalled();
    expect(service.editText).not.toHaveBeenCalled();
    expect(newInput.value).toBe('keep this input');
    expect(unsubscribes[1]).not.toHaveBeenCalled();

    ProviderWorkspaceRegistry.setServices('claude', { commandCatalog: makeCatalog('replacement') } as any);
    expect(rebindNew).toHaveBeenCalledTimes(1);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('does not let reentrant destruction of the old widget dispose a new owner', () => {
    const oldWidget = findInputWidget();
    const oldRoot = controller.containerEl as HTMLElement;
    const oldSlash = controller.slashCommandDropdown as SlashCommandDropdown;
    const oldMention = controller.mentionDropdown as MentionDropdownController;
    const oldSlashDestroy = jest.spyOn(oldSlash, 'destroy');
    const oldMentionDestroy = jest.spyOn(oldMention, 'destroy');
    let newRoot: HTMLElement | null = null;
    unsubscribeHook = (index) => {
      if (index !== 0) return;
      unsubscribeHook = null;
      newRoot = controller.createInputDOM();
    };

    oldWidget.destroy(oldRoot);
    expect(newRoot).not.toBeNull();
    expect(editorView.dom.contains(oldRoot)).toBe(true);
    expect(controller.containerEl).toBe(newRoot);
    expect(oldSlashDestroy).toHaveBeenCalledTimes(1);
    expect(oldMentionDestroy).toHaveBeenCalledTimes(1);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribes[1]).not.toHaveBeenCalled();
    const newSlash = controller.slashCommandDropdown as SlashCommandDropdown;
    const newDestroy = jest.spyOn(newSlash, 'destroy');
    const newSession = (newSlash as any).session;
    expect((catalog as any).activeSessions.has(newSession)).toBe(true);
    oldWidget.destroy(oldRoot);
    expect(newDestroy).not.toHaveBeenCalled();
    expect(controller.containerEl).toBe(newRoot);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('removes global listeners before disposing the owner and cleans up only once', async () => {
    const oldWidget = findInputWidget();
    const oldRoot = controller.containerEl as HTMLElement;
    const oldInput = controller.inputEl as HTMLInputElement;
    const slashDestroy = jest.spyOn(controller.slashCommandDropdown, 'destroy');
    const mentionDestroy = jest.spyOn(controller.mentionDropdown, 'destroy');
    const documentRemove = jest.spyOn(document, 'removeEventListener');
    const viewRemove = jest.spyOn(editorView.dom, 'removeEventListener');
    const dispatch = jest.spyOn(editorView, 'dispatch');

    controller.reject();
    await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
    const dispatchCount = dispatch.mock.calls.length;
    controller.cleanup();
    controller.reject();
    oldWidget.destroy(oldRoot);
    expect(dispatch).toHaveBeenCalledTimes(dispatchCount);
    expect(service.cancel).toHaveBeenCalledTimes(1);
    expect(service.resetConversation).toHaveBeenCalledTimes(1);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(slashDestroy).toHaveBeenCalledTimes(1);
    expect(mentionDestroy).toHaveBeenCalledTimes(1);
    expect(removalsFor(oldInput, 'keydown')).toBe(1);
    expect(removalsFor(oldInput, 'input')).toBe(2);
    expect(documentRemove.mock.invocationCallOrder[0]).toBeLessThan(unsubscribes[0].mock.invocationCallOrder[0]);
    expect(viewRemove.mock.invocationCallOrder[0]).toBeLessThan(unsubscribes[0].mock.invocationCallOrder[0]);
    expect(unsubscribes[0].mock.invocationCallOrder[0]).toBeLessThan(slashDestroy.mock.invocationCallOrder[0]);
    expect(mentionDestroy.mock.invocationCallOrder[0]).toBeLessThan(service.cancel.mock.invocationCallOrder[0]);
    expect(service.cancel.mock.invocationCallOrder[0]).toBeLessThan(service.resetConversation.mock.invocationCallOrder[0]);
  });

  it('releases the partial owner when catalog setup fails before subscription', () => {
    const oldRoot = controller.containerEl as HTMLElement;
    const slashDestroy = jest.spyOn(SlashCommandDropdown.prototype, 'destroy');
    const mentionDestroy = jest.spyOn(MentionDropdownController.prototype, 'destroy');
    const failure = new Error('catalog configuration failed');
    jest.spyOn(catalog, 'getDropdownConfig').mockImplementationOnce(() => { throw failure; });

    expect(() => controller.createInputDOM()).toThrow(failure);
    expect(editorView.dom.contains(oldRoot)).toBe(true);
    expect(unsubscribes).toHaveLength(1);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(slashDestroy).toHaveBeenCalledTimes(2);
    expect(mentionDestroy).toHaveBeenCalledTimes(1);
    expect((catalog as any).activeSessions.size).toBe(0);
    expect(controller.containerEl).toBeNull();
    expect(controller.inputEl).toBeNull();
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('releases acquired resources and rethrows the original construction error', () => {
    const oldRoot = controller.containerEl as HTMLElement;
    const slashDestroy = jest.spyOn(SlashCommandDropdown.prototype, 'destroy');
    const mentionDestroy = jest.spyOn(MentionDropdownController.prototype, 'destroy');
    const failure = new Error('focus timer unavailable');
    unsubscribeHook = (index) => {
      if (index === 1) throw new Error('unsubscribe failed');
    };
    timeoutSpy.mockImplementationOnce(() => { throw failure; });

    expect(() => controller.createInputDOM()).toThrow(failure);
    expect(editorView.dom.contains(oldRoot)).toBe(true);
    expect(unsubscribes).toHaveLength(2);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
    expect(slashDestroy).toHaveBeenCalledTimes(2);
    expect(mentionDestroy).toHaveBeenCalledTimes(2);
    expect((catalog as any).activeSessions.size).toBe(0);
    expect(controller.containerEl).toBeNull();
    expect(controller.inputEl).toBeNull();
    const inputs = addEventSpy.mock.calls.flatMap((args, index) => {
      const target = addEventSpy.mock.contexts[index];
      return args[0] === 'keydown' && target instanceof dom.window.HTMLInputElement ? [target] : [];
    });
    expect(inputs).toHaveLength(2);
    expect(removalsFor(inputs[1], 'keydown')).toBe(1);
    expect(removalsFor(inputs[1], 'input')).toBe(2);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('focuses only the live input and suppresses canceled or stale focus callbacks', () => {
    const oldInput = controller.inputEl as HTMLInputElement;
    const oldFocus = jest.spyOn(oldInput, 'focus');
    const oldCallback = focusCallbacks()[0];
    jest.advanceTimersByTime(20);
    changeSelection();
    const newInput = controller.inputEl as HTMLInputElement;
    const newFocus = jest.spyOn(newInput, 'focus');
    jest.advanceTimersByTime(30);
    expect(oldFocus).not.toHaveBeenCalled();
    expect(newFocus).not.toHaveBeenCalled();
    oldCallback();
    expect(oldFocus).not.toHaveBeenCalled();
    expect(newFocus).not.toHaveBeenCalled();
    jest.advanceTimersByTime(20);
    expect(newFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(newInput);

    const replacement = controller.createInputDOM() as HTMLElement;
    const replacementInput = replacement.querySelector('input') as HTMLInputElement;
    const replacementFocus = jest.spyOn(replacementInput, 'focus');
    const replacementCallback = focusCallbacks().at(-1)!;
    controller.reject();
    replacementCallback();
    jest.advanceTimersByTime(50);
    expect(replacementFocus).not.toHaveBeenCalled();
  });

  it('preserves the cursor placeholder and autofocus after a real widget redraw', async () => {
    const previous = controller;
    previous.reject();
    await resultPromise;
    const editor = previous.editor;
    const modal = new InlineEditModal(
      previous.app,
      previous.plugin,
      editor,
      { editor } as any,
      {
        mode: 'cursor',
        cursorContext: { beforeCursor: '', afterCursor: '', isInbetween: true, line: 1, column: 0 },
      },
      'note.md',
    );
    resultPromise = modal.openAndWait();
    controller = (modal as any).controller;
    const oldInput = controller.inputEl as HTMLInputElement;
    controller.updateHighlight();
    const newInput = controller.inputEl as HTMLInputElement;
    expect(newInput).not.toBe(oldInput);
    expect(newInput.value).toBe('');
    expect(newInput.placeholder).toBe('Insert instructions...');
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(newInput);
  });

  it.each([
    ['edit', { success: true, editedText: 'late edit' }],
    ['insertion', { success: true, insertedText: 'late insertion' }],
    ['clarification', { success: true, clarification: 'late clarification' }],
    ['error', { success: false, error: 'late error' }],
  ])('ignores a late %s result after terminal cleanup', async (_label, result) => {
    let complete!: (value: any) => void;
    service.editText.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const oldInput = controller.inputEl as HTMLInputElement;
    const oldSpinner = controller.spinnerEl as HTMLElement;
    const dispatch = jest.spyOn(editorView, 'dispatch');
    oldInput.value = 'edit this';
    const generation = controller.generate() as Promise<void>;
    expect(service.editText).toHaveBeenCalledTimes(1);
    expect(oldSpinner.style.display).toBe('block');
    controller.reject();
    await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
    const dispatchCount = dispatch.mock.calls.length;

    complete(result);
    await expect(generation).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(dispatchCount);
    expect(oldInput.disabled).toBe(true);
    expect(oldSpinner.style.display).toBe('block');
    expect(editorView.dom.querySelector('.claudian-inline-input-container')).toBeNull();
    expect(editorView.dom.querySelector('.claudian-inline-diff-replace')).toBeNull();
    expect(service.cancel).toHaveBeenCalledTimes(1);
    expect(service.resetConversation).toHaveBeenCalledTimes(1);
  });

  it('retains the existing fresh-input behavior after a live edit error', async () => {
    service.editText.mockResolvedValue({ success: false, error: 'Try again' });
    const oldRoot = controller.containerEl as HTMLElement;
    (controller.inputEl as HTMLInputElement).value = 'failed instruction';

    await controller.generate();
    const newRoot = controller.containerEl as HTMLElement;
    const newInput = controller.inputEl as HTMLInputElement;
    expect(newRoot).not.toBe(oldRoot);
    expect(oldRoot.isConnected).toBe(false);
    expect(newInput.value).toBe('');
    expect(newInput.placeholder).toBe('Edit instructions...');
    expect(newInput.disabled).toBe(false);
    expect(document.activeElement).toBe(newInput);
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.resetConversation).not.toHaveBeenCalled();
    changeSelection();
    expect(controller.inputEl).not.toBe(newInput);
    expect((catalog as any).activeSessions.size).toBe(1);
  });

  it('keeps a live clarification and successful edit working after the input widget is destroyed', async () => {
    service.editText.mockResolvedValue({ success: true, clarification: 'Need more detail' });
    service.continueConversation.mockResolvedValue({ success: true, editedText: 'refined' });
    const oldRoot = controller.containerEl as HTMLElement;
    const input = controller.inputEl as HTMLInputElement;
    input.value = 'edit this';

    await controller.generate();
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Reply to continue...');
    expect(oldRoot.querySelector('.claudian-inline-agent-reply')?.textContent).toBe('Need more detail');
    input.value = 'add detail';
    await controller.generate();

    expect(service.continueConversation).toHaveBeenCalledWith('add detail', []);
    expect(oldRoot.isConnected).toBe(false);
    expect(editorView.dom.querySelector('.claudian-inline-diff-replace')).not.toBeNull();
    expect((catalog as any).activeSessions.size).toBe(0);
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.resetConversation).not.toHaveBeenCalled();
    controller.accept();
    await expect(resultPromise).resolves.toEqual({ decision: 'accept', editedText: 'refined' });
    expect(controller.editor.replaceRange).toHaveBeenCalledTimes(1);
    expect(service.cancel).toHaveBeenCalledTimes(1);
    expect(service.resetConversation).toHaveBeenCalledTimes(1);
  });

  it('does not apply a late result to a replacement DOM or cancel the service', async () => {
    let complete!: (value: any) => void;
    service.editText.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const oldWidget = findInputWidget();
    const oldRoot = controller.containerEl as HTMLElement;
    const oldInput = controller.inputEl as HTMLInputElement;
    oldInput.value = 'edit this';
    const generation = controller.generate() as Promise<void>;
    const newRoot = oldWidget.toDOM(editorView);
    const newInput = newRoot.querySelector('input') as HTMLInputElement;
    const newReply = newRoot.querySelector<HTMLElement>('.claudian-inline-agent-reply')!;
    newInput.value = 'keep the new draft';
    oldWidget.destroy(oldRoot);

    complete({ success: true, clarification: 'late clarification' });
    await expect(generation).resolves.toBeUndefined();
    expect(controller.containerEl).toBe(newRoot);
    expect(newInput.value).toBe('keep the new draft');
    expect(newInput.placeholder).toBe('Edit instructions...');
    expect(newInput.disabled).toBe(false);
    expect(newReply.style.display).toBe('none');
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.resetConversation).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Owner lifetime: the controller is bound to the real CM editor/extension
  // owner (a per-controller ViewPlugin), not to widget destruction. Direct
  // editorView.destroy() must end the controller in every phase (input,
  // pending, diff) with no editor write, while selection rebuilds and
  // input→diff transitions must not terminate it.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('owner lifetime', () => {
    function documentKeydownRemovals(): number {
      return removeEventSpy.mock.calls.filter((args, index) =>
        removeEventSpy.mock.contexts[index] === document && args[0] === 'keydown'
      ).length;
    }

    it('terminates the controller when the view is destroyed while the input is open', async () => {
      const slashDestroy = jest.spyOn(controller.slashCommandDropdown, 'destroy');
      const mentionDestroy = jest.spyOn(controller.mentionDropdown, 'destroy');
      const dispatch = jest.spyOn(editorView, 'dispatch');
      const removalsBefore = documentKeydownRemovals();

      editorView.destroy();
      // The shared afterEach destroys the view again; keep that second call inert.
      editorView.destroy = () => {};

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
      expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(slashDestroy).toHaveBeenCalledTimes(1);
      expect(mentionDestroy).toHaveBeenCalledTimes(1);
      // Escape listener released, no editor write past the destroyed view.
      expect(documentKeydownRemovals()).toBe(removalsBefore + 1);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('terminates a pending generation when the view is destroyed', async () => {
      let complete!: (value: any) => void;
      service.editText.mockReturnValue(new Promise(resolve => { complete = resolve; }));
      const input = controller.inputEl as HTMLInputElement;
      input.value = 'edit this';
      const generation = controller.generate() as Promise<void>;

      editorView.destroy();
      // The shared afterEach destroys the view again; keep that second call inert.
      editorView.destroy = () => {};

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(service.resetConversation).toHaveBeenCalledTimes(1);

      complete({ success: true, editedText: 'late edit' });
      await expect(generation).resolves.toBeUndefined();
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
    });

    it('terminates a diff view when the view is destroyed without accepting', async () => {
      service.editText.mockResolvedValue({ success: true, editedText: 'edited' });
      const input = controller.inputEl as HTMLInputElement;
      input.value = 'edit this';
      await controller.generate();
      expect(editorView.dom.querySelector('.claudian-inline-diff-replace')).not.toBeNull();
      const replaceRange = controller.editor.replaceRange;

      editorView.destroy();
      // The shared afterEach destroys the view again; keep that second call inert.
      editorView.destroy = () => {};

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(replaceRange).not.toHaveBeenCalled();
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
    });

    it('does not terminate on selection rebuilds or input-to-diff transitions', async () => {
      changeSelection();
      expect(service.cancel).not.toHaveBeenCalled();
      let settled = false;
      resultPromise.then(() => { settled = true; });
      await flushMicrotasks();
      expect(settled).toBe(false);

      service.editText.mockResolvedValue({ success: true, editedText: 'edited' });
      const input = controller.inputEl as HTMLInputElement;
      input.value = 'edit this';
      await controller.generate();
      expect(editorView.dom.querySelector('.claudian-inline-diff-replace')).not.toBeNull();
      expect(service.cancel).not.toHaveBeenCalled();

      controller.accept();
      await expect(resultPromise).resolves.toEqual({ decision: 'accept', editedText: 'edited' });
    });

    it('clears the active controller so a fresh open is not auto-rejected after view destruction', async () => {
      editorView.destroy();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });

      const modal = new InlineEditModal(
        controller.app, controller.plugin, controller.editor,
        { editor: controller.editor } as any,
        { mode: 'selection', selectedText: 'alpha' }, 'note.md',
      );
      const secondPromise = modal.openAndWait();
      let settled = false;
      secondPromise.then(() => { settled = true; });
      await flushMicrotasks();
      expect(settled).toBe(false);

      (modal as any).controller.reject();
      await expect(secondPromise).resolves.toEqual({ decision: 'reject' });
    });

    it('a view destroy terminates the newer controller via its live owner, leaving the stale owner inert', async () => {
      const first = controller;
      const firstCancel = service.cancel;
      first.reject();
      await resultPromise;
      expect(firstCancel).toHaveBeenCalledTimes(1);

      // The second session gets its own service stub so termination counts
      // stay attributable per controller.
      const secondService = {
        cancel: jest.fn(),
        continueConversation: jest.fn(),
        editText: jest.fn(),
        resetConversation: jest.fn(),
        setModelOverride: jest.fn(),
      };
      jest.spyOn(ProviderRegistry, 'createInlineEditService').mockReturnValue(secondService as any);

      const modal = new InlineEditModal(
        first.app, first.plugin, first.editor,
        { editor: first.editor } as any,
        { mode: 'selection', selectedText: 'alpha' }, 'note.md',
      );
      const secondPromise = modal.openAndWait();
      const second = (modal as any).controller;
      const slashDestroy = jest.spyOn(second.slashCommandDropdown, 'destroy');
      const mentionDestroy = jest.spyOn(second.mentionDropdown, 'destroy');

      editorView.destroy();
      // The shared afterEach destroys the view again; keep that second call inert.
      editorView.destroy = () => {};

      await expect(secondPromise).resolves.toEqual({ decision: 'reject' });
      // The stale owner did not re-terminate the first controller.
      expect(firstCancel).toHaveBeenCalledTimes(1);
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
      // The live owner did terminate the newer controller exactly once.
      expect(secondService.cancel).toHaveBeenCalledTimes(1);
      expect(secondService.resetConversation).toHaveBeenCalledTimes(1);
      expect(slashDestroy).toHaveBeenCalledTimes(1);
      expect(mentionDestroy).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Reinstall and bounded accumulation. A setState drops every extension the
  // modal appended, so the next open on the same view must reinstall the
  // field + owner from the live state and stay bounded: repeated open/reject
  // cycles on one live view must never append further config.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('owner reinstall and bounded accumulation', () => {
    it('reinstalls the field and owner after a setState so the input reappears on the same view', async () => {
      expect(editorView.dom.querySelector('.claudian-inline-input-container')).not.toBeNull();

      // setState swaps the whole state: every appended extension (field and
      // owner plugin) is dropped and the owner plugin's destroy fires.
      editorView.setState(EditorState.create({ doc: 'alpha beta\ngamma', selection: { anchor: 0, head: 5 } }));

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
      expect(editorView.dom.querySelector('.claudian-inline-input-container')).toBeNull();

      const secondService = {
        cancel: jest.fn(),
        continueConversation: jest.fn(),
        editText: jest.fn(),
        resetConversation: jest.fn(),
        setModelOverride: jest.fn(),
      };
      jest.spyOn(ProviderRegistry, 'createInlineEditService').mockReturnValue(secondService as any);

      const modal = new InlineEditModal(
        controller.app, controller.plugin, controller.editor,
        { editor: controller.editor } as any,
        { mode: 'selection', selectedText: 'alpha' }, 'note.md',
      );
      const secondPromise = modal.openAndWait();
      const second = (modal as any).controller;

      // The reopened session renders its input: the dropped field was
      // reinstalled and consumed the show effect.
      expect(editorView.dom.querySelector('.claudian-inline-input-container')).not.toBeNull();

      // The reopened controller completes a full input → diff → accept cycle.
      secondService.editText.mockResolvedValue({ success: true, editedText: 'edited' });
      const input = second.inputEl as HTMLInputElement;
      input.value = 'edit this';
      await second.generate();
      expect(editorView.dom.querySelector('.claudian-inline-diff-replace')).not.toBeNull();

      second.accept();
      await expect(secondPromise).resolves.toEqual({ decision: 'accept', editedText: 'edited' });
      expect(controller.editor.replaceRange).toHaveBeenCalledWith('edited', { line: 0, ch: 0 }, { line: 0, ch: 5 });
    });

    it('keeps owner installation bounded across repeated open/reject cycles on one view', async () => {
      controller.reject();
      await resultPromise;

      const dispatch = jest.spyOn(editorView, 'dispatch');
      const appendConfigEffects = (): number => dispatch.mock.calls.reduce(
        (sum: number, call: any) => {
          const spec: any = call[0];
          const effects = Array.isArray(spec?.effects)
            ? spec.effects
            : spec?.effects
              ? [spec.effects]
              : [];
          return sum + effects.filter((effect: any) => effect?.is?.(StateEffect.appendConfig)).length;
        },
        0,
      );

      jest.spyOn(ProviderRegistry, 'createInlineEditService').mockImplementation(() => ({
        cancel: jest.fn(),
        continueConversation: jest.fn(),
        editText: jest.fn(),
        resetConversation: jest.fn(),
        setModelOverride: jest.fn(),
      } as any));

      for (let cycle = 0; cycle < 3; cycle++) {
        const modal = new InlineEditModal(
          controller.app, controller.plugin, controller.editor,
          { editor: controller.editor } as any,
          { mode: 'selection', selectedText: 'alpha' }, 'note.md',
        );
        const cyclePromise = modal.openAndWait();

        // Each reopen renders exactly one input: the field is not duplicated
        // and the current controller is rebound through the live owner.
        expect(editorView.dom.querySelectorAll('.claudian-inline-input-container')).toHaveLength(1);

        (modal as any).controller.reject();
        await cyclePromise;

        // Bounded: repeated opens on a live view append no further config,
        // so terminal owner closures cannot accumulate on the view.
        expect(appendConfigEffects()).toBe(0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Teardown fault isolation: cleanup revokes eligibility first, then runs
  // each teardown responsibility independently. A throwing step must not
  // abort the remaining ones, must surface through Notice, and the promise
  // must still settle exactly once. Assertions target the responsibilities
  // that run after the fault, not resource state before it.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('teardown fault isolation', () => {
    async function openSecondSession(): Promise<{ second: any; secondPromise: Promise<any> }> {
      const modal = new InlineEditModal(
        controller.app, controller.plugin, controller.editor,
        { editor: controller.editor } as any,
        { mode: 'selection', selectedText: 'alpha' }, 'note.md',
      );
      const secondPromise = modal.openAndWait();
      return { second: (modal as any).controller, secondPromise };
    }

    it('continues teardown and settles when the registry unsubscribe throws', async () => {
      const noticeMock = Notice as unknown as jest.Mock;
      noticeMock.mockClear();
      const slashDestroy = jest.spyOn(controller.slashCommandDropdown, 'destroy');
      const mentionDestroy = jest.spyOn(controller.mentionDropdown, 'destroy');
      const dispatch = jest.spyOn(editorView, 'dispatch');
      unsubscribeHook = () => { throw new Error('unsubscribe failed'); };

      controller.reject();

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('unsubscribe failed'));
      // Responsibilities after the fault still ran.
      expect(slashDestroy.mock.invocationCallOrder[0]).toBeGreaterThan(unsubscribes[0].mock.invocationCallOrder[0]);
      expect(mentionDestroy).toHaveBeenCalledTimes(1);
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalled();
      expect(document.querySelector('.claudian-inline-input-container')).toBeNull();

      const { secondPromise } = await openSecondSession();
      let settled = false;
      secondPromise.then(() => { settled = true; });
      await flushMicrotasks();
      expect(settled).toBe(false);
      controller.reject();
    });

    it('continues teardown and settles when the mention dropdown destroy throws', async () => {
      const noticeMock = Notice as unknown as jest.Mock;
      noticeMock.mockClear();
      const slashDestroy = jest.spyOn(controller.slashCommandDropdown, 'destroy');
      jest.spyOn(controller.mentionDropdown, 'destroy')
        .mockImplementation(() => { throw new Error('mention destroy failed'); });
      const dispatch = jest.spyOn(editorView, 'dispatch');

      controller.reject();

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('mention destroy failed'));
      expect(slashDestroy).toHaveBeenCalledTimes(1);
      expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalled();
      expect(document.querySelector('.claudian-inline-input-container')).toBeNull();
    });

    it('continues teardown and settles when cancel throws', async () => {
      const noticeMock = Notice as unknown as jest.Mock;
      noticeMock.mockClear();
      service.cancel.mockImplementationOnce(() => { throw new Error('cancel failed'); });
      const dispatch = jest.spyOn(editorView, 'dispatch');

      controller.reject();

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('cancel failed'));
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
      expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalled();
      expect(document.querySelector('.claudian-inline-input-container')).toBeNull();
    });

    it('continues teardown and settles when resetConversation throws', async () => {
      const noticeMock = Notice as unknown as jest.Mock;
      noticeMock.mockClear();
      service.resetConversation.mockImplementationOnce(() => { throw new Error('reset failed'); });
      const dispatch = jest.spyOn(editorView, 'dispatch');

      controller.reject();

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('reset failed'));
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalled();
      expect(document.querySelector('.claudian-inline-input-container')).toBeNull();
    });

    it('keeps destroying subsequent owners when an owner teardown throws on rebuild', async () => {
      const noticeMock = Notice as unknown as jest.Mock;
      noticeMock.mockClear();
      const input = controller.inputEl as HTMLInputElement;

      const failingDestroy = jest.spyOn(controller.mentionDropdown, 'destroy')
        .mockImplementation(() => { throw new Error('mention destroy failed'); });

      changeSelection();

      // The old owner's teardown fault must not take down the fresh owner.
      expect(controller.containerEl).not.toBeNull();
      expect(failingDestroy).toHaveBeenCalledTimes(1);
      expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('mention destroy failed'));
      const freshMention = controller.mentionDropdown as MentionDropdownController;
      const freshDestroy = jest.spyOn(freshMention, 'destroy');

      controller.reject();
      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(freshDestroy).toHaveBeenCalledTimes(1);
      expect(service.cancel).toHaveBeenCalledTimes(1);
      expect(service.resetConversation).toHaveBeenCalledTimes(1);
      expect(input.isConnected).toBe(false);
    });

    it('does not report accept when editor replacement fails', async () => {
      const noticeMock = Notice as unknown as jest.Mock;
      noticeMock.mockClear();
      service.editText.mockResolvedValue({ success: true, editedText: 'edited' });
      const input = controller.inputEl as HTMLInputElement;
      input.value = 'edit this';
      await controller.generate();
      controller.editor.replaceRange = jest.fn(() => { throw new Error('replace failed'); });

      controller.accept();

      await expect(resultPromise).resolves.toEqual({ decision: 'reject' });
      expect(noticeMock).toHaveBeenCalledWith(expect.stringContaining('replace failed'));
    });
  });
});
