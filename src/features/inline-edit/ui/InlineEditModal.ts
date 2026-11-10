import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { App, Editor, MarkdownView } from 'obsidian';
import { Notice } from 'obsidian';

import { getHiddenProviderCommandSet } from '../../../core/providers/commands/hiddenCommands';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import { DEFAULT_CHAT_PROVIDER_ID, type InlineEditMode, type InlineEditService, type ProviderId } from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';
import { hideSelectionHighlight, showSelectionHighlight } from '../../../shared/components/SelectionHighlight';
import { SlashCommandDropdown } from '../../../shared/components/SlashCommandDropdown';
import { MentionDropdownController } from '../../../shared/mention/MentionDropdownController';
import { VaultMentionDataProvider } from '../../../shared/mention/VaultMentionDataProvider';
import {
  createExternalContextLookupGetter,
  findBestMentionLookupMatch,
  isMentionStart,
  normalizeForPlatformLookup,
  normalizeMentionPath,
  resolveExternalMentionAtIndex,
} from '../../../utils/contextMentionResolver';
import { type CursorContext, getEditorView } from '../../../utils/editor';
import { buildExternalContextDisplayEntries } from '../../../utils/externalContext';
import { externalContextScanner } from '../../../utils/externalContextScanner';
import { escapeHtml, normalizeInsertionText } from '../../../utils/inlineEdit';
import { getVaultPath, normalizePathForVault as normalizePathForVaultUtil } from '../../../utils/path';

export type InlineEditContext =
  | { mode: 'selection'; selectedText: string }
  | { mode: 'cursor'; cursorContext: CursorContext };

const showInlineEdit = StateEffect.define<{
  inputPos: number;
  selFrom: number;
  selTo: number;
  widget: InlineEditController;
  isInbetween?: boolean;
}>();
const showDiff = StateEffect.define<{
  from: number;
  to: number;
  diffHtml: string;
  widget: InlineEditController;
}>();
const showInsertion = StateEffect.define<{
  pos: number;
  diffHtml: string;
  widget: InlineEditController;
}>();
const hideInlineEdit = StateEffect.define<null>();

let activeController: InlineEditController | null = null;

class DiffWidget extends WidgetType {
  constructor(private diffHtml: string, private controller: InlineEditController) {
    super();
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'claudian-inline-diff-replace';
    span.innerHTML = this.diffHtml;

    const btns = document.createElement('span');
    btns.className = 'claudian-inline-diff-buttons';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'claudian-inline-diff-btn reject';
    rejectBtn.textContent = '✕';
    rejectBtn.title = 'Reject (Esc)';
    rejectBtn.onclick = () => this.controller.reject();

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'claudian-inline-diff-btn accept';
    acceptBtn.textContent = '✓';
    acceptBtn.title = 'Accept (Enter)';
    acceptBtn.onclick = () => this.controller.accept();

    btns.appendChild(rejectBtn);
    btns.appendChild(acceptBtn);
    span.appendChild(btns);

    return span;
  }
  eq(other: DiffWidget): boolean {
    return this.diffHtml === other.diffHtml;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class InputWidget extends WidgetType {
  constructor(private controller: InlineEditController) {
    super();
  }
  toDOM(): HTMLElement {
    return this.controller.createInputDOM();
  }
  destroy(dom: HTMLElement): void {
    this.controller.disposeInputDOM(dom);
  }
  eq(): boolean {
    return false;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const inlineEditField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(showInlineEdit)) {
        const builder = new RangeSetBuilder<Decoration>();
        // Block above line for selection/inline mode, inline widget for inbetween mode
        const isInbetween = e.value.isInbetween ?? false;
        builder.add(e.value.inputPos, e.value.inputPos, Decoration.widget({
          widget: new InputWidget(e.value.widget),
          block: !isInbetween,
          side: isInbetween ? 1 : -1,
        }));
        deco = builder.finish();
      } else if (e.is(showDiff)) {
        const builder = new RangeSetBuilder<Decoration>();
        builder.add(e.value.from, e.value.to, Decoration.replace({
          widget: new DiffWidget(e.value.diffHtml, e.value.widget),
        }));
        deco = builder.finish();
      } else if (e.is(showInsertion)) {
        const builder = new RangeSetBuilder<Decoration>();
        builder.add(e.value.pos, e.value.pos, Decoration.widget({
          widget: new DiffWidget(e.value.diffHtml, e.value.widget),
          side: 1, // After the position
        }));
        deco = builder.finish();
      } else if (e.is(hideInlineEdit)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Per-view owner binding: the shared owner plugin's destroy terminates the
// controller currently registered for the view. A terminal controller drops
// out of this map, so a live view never accumulates stale controller
// closures across repeated opens.
const viewOwners = new WeakMap<EditorView, InlineEditController>();

interface DiffOp { type: 'equal' | 'insert' | 'delete'; text: string; }

function computeDiff(oldText: string, newText: string): DiffOp[] {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  const m = oldWords.length, n = newWords.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldWords[i-1] === newWords[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = m, j = n;
  const temp: DiffOp[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i-1] === newWords[j-1]) {
      temp.push({ type: 'equal', text: oldWords[i-1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      temp.push({ type: 'insert', text: newWords[j-1] });
      j--;
    } else {
      temp.push({ type: 'delete', text: oldWords[i-1] });
      i--;
    }
  }

  temp.reverse();
  for (const op of temp) {
    if (ops.length > 0 && ops[ops.length-1].type === op.type) {
      ops[ops.length-1].text += op.text;
    } else {
      ops.push({ ...op });
    }
  }
  return ops;
}

function diffToHtml(ops: DiffOp[]): string {
  return ops.map(op => {
    const escaped = escapeHtml(op.text);
    switch (op.type) {
      case 'delete': return `<span class="claudian-diff-del">${escaped}</span>`;
      case 'insert': return `<span class="claudian-diff-ins">${escaped}</span>`;
      default: return escaped;
    }
  }).join('');
}

export type InlineEditDecision = 'accept' | 'edit' | 'reject';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class InlineEditModal {
  private controller: InlineEditController | null = null;

  constructor(
    private app: App,
    private plugin: ClaudianPlugin,
    private editor: Editor,
    private view: MarkdownView,
    private editContext: InlineEditContext,
    private notePath: string,
    private getExternalContexts: () => string[] = () => []
  ) {}

  async openAndWait(): Promise<{ decision: InlineEditDecision; editedText?: string }> {
    if (activeController) {
      activeController.reject();
      return { decision: 'reject' };
    }

    // Use the editor/view provided by Obsidian's editorCallback.
    // This avoids timing issues during leaf/view transitions (e.g., navigating via Search in the same tab).
    let editor = this.editor;
    let editorView = getEditorView(editor);

    // Fallback: in rare cases Obsidian may re-initialize the editor between callback and modal open.
    if (!editorView) {
      editor = this.view.editor;
      editorView = getEditorView(editor);
    }

    if (!editorView) {
      new Notice('Inline edit unavailable: could not access the active editor. Try reopening the note.');
      return { decision: 'reject' };
    }

    return new Promise((resolve) => {
      this.controller = new InlineEditController(
        this.app,
        this.plugin,
        editorView,
        editor,
        this.editContext,
        this.notePath,
        this.getExternalContexts,
        resolve
      );
      activeController = this.controller;
      this.controller.show();
    });
  }
}

interface InputDOMOwner {
  root: HTMLElement;
  input: HTMLInputElement;
  spinner: HTMLElement;
  reply: HTMLElement;
  slashDropdown: SlashCommandDropdown | null;
  mentionDropdown: MentionDropdownController | null;
  unsubscribe: (() => void) | null;
  onKeydown: ((event: KeyboardEvent) => void) | null;
  onInput: (() => void) | null;
  focusTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

class InlineEditController {
  // One shared owner plugin per view, not one per open: show() rebinds the
  // registry entry instead of appending a fresh closure, so repeated opens on
  // a live view accumulate no terminal controllers, and destroy terminates
  // only the currently bound controller.
  private static readonly ownerPlugin = ViewPlugin.define((view: EditorView) => ({
    destroy: () => {
      const controller = viewOwners.get(view);
      if (!controller) return;
      viewOwners.delete(view);
      controller.terminate();
      controller.settle({ decision: 'reject' });
    },
  }));

  private currentInputOwner: InputDOMOwner | null = null;
  private inputOwners = new WeakMap<HTMLElement, InputDOMOwner>();
  private terminal = false;
  private inputEl: HTMLInputElement | null = null;
  private spinnerEl: HTMLElement | null = null;
  private agentReplyEl: HTMLElement | null = null;
  private containerEl: HTMLElement | null = null;
  private editedText: string | null = null;
  private insertedText: string | null = null;
  private selFrom = 0;
  private selTo = 0;
  private selectedText: string;
  private startLine: number = 0; // 1-indexed
  private mode: InlineEditMode;
  private cursorContext: CursorContext | null = null;
  private inlineEditService: InlineEditService;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private selectionListener: ((e: Event) => void) | null = null;
  private isConversing = false;
  private settled = false;
  private resolvedProviderId: ProviderId;
  private slashCommandDropdown: SlashCommandDropdown | null = null;
  private mentionDropdown: MentionDropdownController | null = null;
  private mentionDataProvider: VaultMentionDataProvider;

  constructor(
    private app: App,
    private plugin: ClaudianPlugin,
    private editorView: EditorView,
    private editor: Editor,
    editContext: InlineEditContext,
    private notePath: string,
    private getExternalContexts: () => string[],
    private resolve: (result: { decision: InlineEditDecision; editedText?: string }) => void
  ) {
    const activeView = typeof plugin.getView === 'function'
      ? plugin.getView()
      : null;
    const activeTab = activeView?.getActiveTab();
    const conversation = activeTab?.conversationId
      ? plugin.getConversationSync(activeTab.conversationId)
      : null;
    const providerId: ProviderId = conversation?.providerId as ProviderId
      ?? activeTab?.service?.providerId
      ?? activeTab?.providerId
      ?? DEFAULT_CHAT_PROVIDER_ID;
    this.inlineEditService = ProviderRegistry.createInlineEditService(plugin, providerId);
    const auxiliaryModel = activeTab?.service?.providerId === providerId
      ? activeTab.service.getAuxiliaryModel?.()
      : activeTab?.providerId === providerId
      ? activeTab?.draftModel
      : null;
    this.inlineEditService.setModelOverride?.(auxiliaryModel ?? undefined);
    this.resolvedProviderId = providerId;
    this.mentionDataProvider = new VaultMentionDataProvider(this.app, {
      onFileLoadError: () => {
        new Notice('Failed to load vault files. Vault @-mentions may be unavailable.');
      },
    });
    this.mentionDataProvider.initializeInBackground();
    this.mode = editContext.mode;
    if (editContext.mode === 'cursor') {
      this.cursorContext = editContext.cursorContext;
      this.selectedText = '';
    } else {
      this.selectedText = editContext.selectedText;
    }

    this.updatePositionsFromEditor();
  }

  private updatePositionsFromEditor() {
    const doc = this.editorView.state.doc;

    if (this.mode === 'cursor') {
      const ctx = this.cursorContext as CursorContext;
      const line = doc.line(ctx.line + 1);
      this.selFrom = line.from + ctx.column;
      this.selTo = this.selFrom;
    } else {
      const from = this.editor.getCursor('from');
      const to = this.editor.getCursor('to');
      const fromLine = doc.line(from.line + 1);
      const toLine = doc.line(to.line + 1);
      this.selFrom = fromLine.from + from.ch;
      this.selTo = toLine.from + to.ch;
      this.selectedText = this.editor.getSelection() || this.selectedText;
      this.startLine = from.line + 1; // 1-indexed
    }
  }

  show() {
    // The controller's lifetime is bound to the real CM owner, not to widget
    // destruction: the shared per-view owner plugin is destroyed by
    // editorView.destroy(), setState, and extension retirement alike, and its
    // destruction terminates exactly the controller currently bound to the
    // view. Installation follows the live state, never a historical mark: a
    // setState drops every appended extension, so stale install knowledge
    // would leave the next open without the field and without a widget.
    // Harness views without the real CM state API report nothing installed.
    const extensions: Extension[] = [];
    if (typeof this.editorView.state.field !== 'function'
      || this.editorView.state.field(inlineEditField, false) === undefined) {
      extensions.push(inlineEditField);
    }
    if (typeof this.editorView.plugin !== 'function'
      || this.editorView.plugin(InlineEditController.ownerPlugin) == null) {
      extensions.push(InlineEditController.ownerPlugin);
    }
    if (extensions.length > 0) {
      this.editorView.dispatch({
        effects: StateEffect.appendConfig.of(extensions),
      });
    }
    viewOwners.set(this.editorView, this);

    this.updateHighlight();

    if (this.mode === 'selection') {
      this.attachSelectionListeners();
    }

    // !e.isComposing: skip during IME composition (Chinese, Japanese, Korean, etc.)
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        this.reject();
      }
    };
    document.addEventListener('keydown', this.escHandler);
  }

  private updateHighlight() {
    const doc = this.editorView.state.doc;
    const line = doc.lineAt(this.selFrom);
    const isInbetween = this.mode === 'cursor' && this.cursorContext?.isInbetween;

    this.editorView.dispatch({
      effects: showInlineEdit.of({
        inputPos: isInbetween ? this.selFrom : line.from,
        selFrom: this.selFrom,
        selTo: this.selTo,
        widget: this,
        isInbetween,
      }),
    });
    this.updateSelectionHighlight();
  }

  private updateSelectionHighlight(): void {
    if (this.mode === 'selection' && this.selFrom !== this.selTo) {
      showSelectionHighlight(this.editorView, this.selFrom, this.selTo);
    } else {
      hideSelectionHighlight(this.editorView);
    }
  }

  private attachSelectionListeners() {
    this.removeSelectionListeners();
    this.selectionListener = (e: Event) => {
      const target = e.target as Node | null;
      if (target && this.inputEl && (target === this.inputEl || this.inputEl.contains(target))) {
        return;
      }
      const prevFrom = this.selFrom;
      const prevTo = this.selTo;
      const newSelection = this.editor.getSelection();
      if (newSelection && newSelection.length > 0) {
        this.updatePositionsFromEditor();
        if (prevFrom !== this.selFrom || prevTo !== this.selTo) {
          this.updateHighlight();
        }
      }
    };
    this.editorView.dom.addEventListener('mouseup', this.selectionListener);
    this.editorView.dom.addEventListener('keyup', this.selectionListener);
  }

  createInputDOM(): HTMLElement {
    if (this.currentInputOwner) this.disposeInputOwner(this.currentInputOwner);

    const container = document.createElement('div');
    container.className = 'claudian-inline-input-container';

    const reply = document.createElement('div');
    reply.className = 'claudian-inline-agent-reply';
    reply.style.display = 'none';
    container.appendChild(reply);

    const inputWrap = document.createElement('div');
    inputWrap.className = 'claudian-inline-input-wrap';
    container.appendChild(inputWrap);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'claudian-inline-input';
    input.placeholder = this.mode === 'cursor' ? 'Insert instructions...' : 'Edit instructions...';
    input.spellcheck = false;
    inputWrap.appendChild(input);

    const spinner = document.createElement('div');
    spinner.className = 'claudian-inline-spinner';
    spinner.style.display = 'none';
    inputWrap.appendChild(spinner);

    const owner: InputDOMOwner = {
      root: container,
      input,
      spinner,
      reply,
      slashDropdown: null,
      mentionDropdown: null,
      unsubscribe: null,
      onKeydown: null,
      onInput: null,
      focusTimer: null,
      disposed: false,
    };
    this.inputOwners.set(container, owner);
    this.currentInputOwner = owner;
    this.containerEl = container;
    this.inputEl = input;
    this.spinnerEl = spinner;
    this.agentReplyEl = reply;

    try {
      const slashDropdown = new SlashCommandDropdown(
        document.body,
        input,
        {
          onSelect: () => {},
          onHide: () => {},
        },
        {
          fixed: true,
          hiddenCommands: getHiddenProviderCommandSet(this.plugin.settings, this.resolvedProviderId),
        }
      );
      owner.slashDropdown = slashDropdown;
      this.slashCommandDropdown = slashDropdown;

      const mentionDropdown = new MentionDropdownController(
        document.body,
        input,
        {
          // Inline-edit resolves @mentions at send time from input text.
          onAttachFile: () => {},
          onMcpMentionChange: () => {},
          getMentionedMcpServers: () => new Set(),
          setMentionedMcpServers: () => false,
          addMentionedMcpServer: () => {},
          getExternalContexts: this.getExternalContexts,
          getCachedVaultFolders: () => this.mentionDataProvider.getCachedVaultFolders(),
          getCachedVaultFiles: () => this.mentionDataProvider.getCachedVaultFiles(),
          normalizePathForVault: (rawPath) => this.normalizePathForVault(rawPath),
        },
        { fixed: true }
      );
      owner.mentionDropdown = mentionDropdown;
      this.mentionDropdown = mentionDropdown;

      owner.onKeydown = (event) => {
        if (this.isCurrentInputOwner(owner)) this.handleKeydown(event, owner);
      };
      owner.onInput = () => {
        if (this.isCurrentInputOwner(owner)) mentionDropdown.handleInputChange();
      };
      input.addEventListener('keydown', owner.onKeydown);
      input.addEventListener('input', owner.onInput);

      owner.focusTimer = setTimeout(() => {
        owner.focusTimer = null;
        if (this.isCurrentInputOwner(owner)) input.focus();
      }, 50);
      return container;
    } catch (error) {
      try {
        this.disposeInputOwner(owner, { rethrow: true });
      } catch {
        // Construction failure remains the primary error after attempted teardown.
      }
      throw error;
    }
  }

  disposeInputDOM(root: HTMLElement): void {
    const owner = this.inputOwners.get(root);
    if (!owner) return;
    this.inputOwners.delete(root);
    this.disposeInputOwner(owner);
  }

  private isCurrentInputOwner(owner: InputDOMOwner): boolean {
    return !this.terminal && !owner.disposed && this.currentInputOwner === owner;
  }

  private disposeInputOwner(owner: InputDOMOwner, options?: { rethrow?: boolean }): void {
    if (owner.disposed) return;
    owner.disposed = true;
    if (this.currentInputOwner === owner) {
      this.currentInputOwner = null;
      this.containerEl = null;
      this.inputEl = null;
      this.spinnerEl = null;
      this.agentReplyEl = null;
      this.slashCommandDropdown = null;
      this.mentionDropdown = null;
    }

    let failure: unknown;
    let failed = false;
    const attempt = (dispose: () => void) => {
      try {
        dispose();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    };
    if (owner.focusTimer !== null) {
      const timer = owner.focusTimer;
      owner.focusTimer = null;
      attempt(() => clearTimeout(timer));
    }
    if (owner.unsubscribe) {
      const unsubscribe = owner.unsubscribe;
      owner.unsubscribe = null;
      attempt(unsubscribe);
    }
    if (owner.onKeydown) {
      const onKeydown = owner.onKeydown;
      owner.onKeydown = null;
      attempt(() => owner.input.removeEventListener('keydown', onKeydown));
    }
    if (owner.onInput) {
      const onInput = owner.onInput;
      owner.onInput = null;
      attempt(() => owner.input.removeEventListener('input', onInput));
    }
    if (owner.slashDropdown) {
      const dropdown = owner.slashDropdown;
      owner.slashDropdown = null;
      attempt(() => dropdown.destroy());
    }
    if (owner.mentionDropdown) {
      const dropdown = owner.mentionDropdown;
      owner.mentionDropdown = null;
      attempt(() => dropdown.destroy());
    }
    if (failed) {
      // Teardown faults stay observable via Notice even when the caller keeps
      // the original error (construction failure rethrows it afterwards).
      new Notice(`Inline edit cleanup failed: ${describeError(failure)}`);
      if (options?.rethrow) throw failure;
    }
  }

  private async generate() {
    const owner = this.currentInputOwner;
    if (!owner || !this.isCurrentInputOwner(owner)) return;
    const { input, spinner } = owner;
    const userMessage = input.value.trim();
    if (!userMessage) return;

    // Slash commands are passed directly to SDK for handling

    this.removeSelectionListeners();

    input.disabled = true;
    spinner.style.display = 'block';

    const contextFiles = this.resolveContextFilesFromMessage(userMessage);

    let result;
    if (this.isConversing) {
      result = await this.inlineEditService.continueConversation(userMessage, contextFiles);
    } else {
      if (this.mode === 'cursor') {
        result = await this.inlineEditService.editText({
          mode: 'cursor',
          instruction: userMessage,
          notePath: this.notePath,
          cursorContext: this.cursorContext as CursorContext,
          contextFiles,
        });
      } else {
        const lineCount = this.selectedText.split(/\r?\n/).length;
        result = await this.inlineEditService.editText({
          mode: 'selection',
          instruction: userMessage,
          notePath: this.notePath,
          selectedText: this.selectedText,
          startLine: this.startLine,
          lineCount,
          contextFiles,
        });
      }
    }

    if (!this.isCurrentInputOwner(owner)) return;
    spinner.style.display = 'none';

    if (result.success) {
      if (result.editedText !== undefined) {
        this.editedText = result.editedText;
        this.showDiffInPlace();
      } else if (result.insertedText !== undefined) {
        this.insertedText = result.insertedText;
        this.showInsertionInPlace();
      } else if (result.clarification) {
        this.showAgentReply(result.clarification);
        this.isConversing = true;
        input.disabled = false;
        input.value = '';
        input.placeholder = 'Reply to continue...';
        input.focus();
      } else {
        this.handleError('No response from agent');
      }
    } else {
      this.handleError(result.error || 'Error - try again');
    }
  }

  private showAgentReply(message: string) {
    if (!this.agentReplyEl || !this.containerEl) return;
    this.agentReplyEl.style.display = 'block';
    this.agentReplyEl.textContent = message;
    this.containerEl.classList.add('has-agent-reply');
  }

  private handleError(errorMessage: string) {
    if (!this.inputEl) return;
    this.inputEl.disabled = false;
    this.inputEl.placeholder = errorMessage;
    this.updatePositionsFromEditor();
    this.updateHighlight();
    this.attachSelectionListeners();
    this.inputEl?.focus();
  }

  private showDiffInPlace() {
    if (this.editedText === null) return;

    hideSelectionHighlight(this.editorView);

    const diffOps = computeDiff(this.selectedText, this.editedText);
    const diffHtml = diffToHtml(diffOps);

    this.editorView.dispatch({
      effects: showDiff.of({
        from: this.selFrom,
        to: this.selTo,
        diffHtml,
        widget: this,
      }),
    });

    this.installAcceptRejectHandler();
  }

  private showInsertionInPlace() {
    if (this.insertedText === null) return;

    hideSelectionHighlight(this.editorView);

    const trimmedText = normalizeInsertionText(this.insertedText);
    this.insertedText = trimmedText;

    const escaped = escapeHtml(trimmedText);
    const diffHtml = `<span class="claudian-diff-ins">${escaped}</span>`;

    this.editorView.dispatch({
      effects: showInsertion.of({
        pos: this.selFrom,
        diffHtml,
        widget: this,
      }),
    });

    this.installAcceptRejectHandler();
  }

  private installAcceptRejectHandler() {
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
    }
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        this.reject();
      } else if (e.key === 'Enter' && !e.isComposing) {
        this.accept();
      }
    };
    document.addEventListener('keydown', this.escHandler);
  }

  accept() {
    if (this.terminal) return;
    const textToInsert = this.editedText ?? this.insertedText;
    if (textToInsert !== null) {
      // Convert CM6 positions back to Obsidian Editor positions
      const doc = this.editorView.state.doc;
      const fromLine = doc.lineAt(this.selFrom);
      const toLine = doc.lineAt(this.selTo);
      const from = { line: fromLine.number - 1, ch: this.selFrom - fromLine.from };
      const to = { line: toLine.number - 1, ch: this.selTo - toLine.from };

      this.cleanup();
      try {
        this.editor.replaceRange(textToInsert, from, to);
      } catch (error) {
        // A failed editor write must not be reported as an accepted edit.
        new Notice(`Inline edit failed to apply the change: ${describeError(error)}`);
        this.settle({ decision: 'reject' });
        return;
      }
      this.settle({ decision: 'accept', editedText: textToInsert });
    } else {
      this.cleanup();
      this.settle({ decision: 'reject' });
    }
  }

  reject() {
    if (this.terminal) return;
    this.cleanup({ keepSelectionHighlight: true });
    this.attemptTeardownStep('restore selection highlight', () => this.restoreSelectionHighlight());
    this.settle({ decision: 'reject' });
  }

  private removeSelectionListeners() {
    if (this.selectionListener) {
      this.editorView.dom.removeEventListener('mouseup', this.selectionListener);
      this.editorView.dom.removeEventListener('keyup', this.selectionListener);
      this.selectionListener = null;
    }
  }


  private cleanup(options?: { keepSelectionHighlight?: boolean }) {
    if (this.terminal) return;
    this.terminate();
    this.attemptTeardownStep('hide inline edit decoration', () => {
      this.editorView.dispatch({
        effects: hideInlineEdit.of(null),
      });
    });
    if (!options?.keepSelectionHighlight) {
      this.attemptTeardownStep('hide selection highlight', () => {
        hideSelectionHighlight(this.editorView);
      });
    }
  }

  /**
   * Revokes eligibility, then runs every teardown responsibility as an
   * independent step: a throwing unsubscribe, dropdown destroy, cancel, or
   * reset must not abort the remaining ones. The promise still settles via
   * settle() and errors surface through Notice.
   */
  private terminate(): void {
    if (this.terminal) return;
    this.terminal = true;
    if (viewOwners.get(this.editorView) === this) {
      viewOwners.delete(this.editorView);
    }
    if (activeController === this) {
      activeController = null;
    }
    this.attemptTeardownStep('remove selection listeners', () => this.removeSelectionListeners());
    if (this.escHandler) {
      const escHandler = this.escHandler;
      this.escHandler = null;
      this.attemptTeardownStep('remove escape handler', () => {
        document.removeEventListener('keydown', escHandler);
      });
    }
    if (this.currentInputOwner) {
      const owner = this.currentInputOwner;
      this.attemptTeardownStep('dispose input owner', () => this.disposeInputOwner(owner));
    }
    this.attemptTeardownStep('cancel inline edit service', () => this.inlineEditService.cancel());
    this.attemptTeardownStep('reset inline edit service', () => this.inlineEditService.resetConversation());
    this.isConversing = false;
  }

  private attemptTeardownStep(description: string, step: () => void): void {
    try {
      step();
    } catch (error) {
      new Notice(`Inline edit cleanup failed (${description}): ${describeError(error)}`);
    }
  }

  private settle(result: { decision: InlineEditDecision; editedText?: string }): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(result);
  }

  private restoreSelectionHighlight(): void {
    if (this.mode !== 'selection' || this.selFrom === this.selTo) {
      return;
    }
    showSelectionHighlight(this.editorView, this.selFrom, this.selTo);
  }

  private handleKeydown(e: KeyboardEvent, owner: InputDOMOwner) {
    if (!this.isCurrentInputOwner(owner) || owner.mentionDropdown?.handleKeydown(e)) {
      return;
    }

    if (!this.isCurrentInputOwner(owner) || owner.slashDropdown?.handleKeydown(e)) {
      return;
    }

    if (!this.isCurrentInputOwner(owner)) return;
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      this.generate();
    }
  }

  private normalizePathForVault(rawPath: string | undefined | null): string | null {
    try {
      const vaultPath = getVaultPath(this.app);
      return normalizePathForVaultUtil(rawPath, vaultPath);
    } catch {
      new Notice('Failed to attach file: invalid path');
      return null;
    }
  }

  private resolveContextFilesFromMessage(message: string): string[] {
    if (!message.includes('@')) return [];

    const vaultFiles = this.mentionDataProvider.getCachedVaultFiles();

    const pathLookup = new Map<string, string>();
    for (const file of vaultFiles) {
      const normalized = this.normalizePathForVault(file.path);
      if (!normalized) continue;
      const lookupKey = normalizeForPlatformLookup(normalizeMentionPath(normalized));
      if (!pathLookup.has(lookupKey)) {
        pathLookup.set(lookupKey, normalized);
      }
    }

    const resolved = new Set<string>();
    const externalEntries = buildExternalContextDisplayEntries(this.getExternalContexts())
      .sort((a, b) => b.displayNameLower.length - a.displayNameLower.length);
    const getExternalLookup = createExternalContextLookupGetter(
      contextRoot => externalContextScanner.scanPaths([contextRoot])
    );

    for (let index = 0; index < message.length; index++) {
      if (!isMentionStart(message, index)) continue;

      const externalMatch = resolveExternalMentionAtIndex(
        message, index, externalEntries, getExternalLookup
      );
      if (externalMatch) {
        resolved.add(externalMatch.resolvedPath);
        index = externalMatch.endIndex - 1;
        continue;
      }

      const vaultMatch = findBestMentionLookupMatch(
        message, index + 1, pathLookup, normalizeMentionPath, normalizeForPlatformLookup
      );
      if (vaultMatch) {
        resolved.add(vaultMatch.resolvedPath);
        index = vaultMatch.endIndex - 1;
      }
    }

    return [...resolved];
  }

}
