import { getBuiltInCommandsForDropdown } from '../../core/commands/builtInCommands';
import type { ProviderCommandDropdownConfig } from '../../core/providers/commands/ProviderCommandCatalog';
import type {
  CommandDropdownReceipt,
  CommandDropdownSession,
  CommandDropdownSnapshot,
} from '../../core/providers/commands/ProviderCommandDiscovery';
import type { ProviderCommandEntry } from '../../core/providers/commands/ProviderCommandEntry';
import type { ProviderId } from '../../core/providers/types';
import type { SlashCommand } from '../../core/types';
import { normalizeArgumentHint } from '../../utils/slashCommand';

interface DropdownItem {
  name: string;
  description?: string;
  argumentHint?: string;
  content: string;
  displayPrefix: string;
  insertPrefix: string;
  isBuiltIn: boolean;
  slashCommand?: SlashCommand;
  providerEntry?: ProviderCommandEntry;
}

export interface SlashCommandDropdownCallbacks {
  onSelect: (command: SlashCommand) => void;
  onHide: () => void;
}

export interface SlashCommandDropdownOptions {
  fixed?: boolean;
  hiddenCommands?: Set<string>;
  providerConfig?: ProviderCommandDropdownConfig;
  getProviderEntries?: () => Promise<ProviderCommandEntry[]>;
  builtInProviderId?: ProviderId;
}

export class SlashCommandDropdown {
  private containerEl: HTMLElement;
  private dropdownEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | HTMLInputElement;
  private callbacks: SlashCommandDropdownCallbacks;
  private enabled = true;
  private onInput: () => void;
  private triggerStartIndex = -1;
  private activeTriggerChar = '/';
  private selectedIndex = 0;
  private filteredItems: DropdownItem[] = [];
  private isFixed: boolean;
  private hiddenCommands: Set<string>;

  private providerConfig: ProviderCommandDropdownConfig | null;
  private builtInProviderId: ProviderId | undefined;
  private getProviderEntries: (() => Promise<ProviderCommandEntry[]>) | null;
  private cachedProviderEntries: ProviderCommandEntry[] = [];
  private providerEntriesFetched = false;

  private session: CommandDropdownSession | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private lastConsumed: { session: CommandDropdownSession; receipt: CommandDropdownReceipt } | null = null;
  private activeCaller: AbortController | null = null;
  // Menu interest tracks user intent to see the menu; a session invalidation
  // clears rendered DOM without clearing this flag, so a still-valid trigger
  // can be re-evaluated once sources settle. isVisible() alone cannot express
  // this: a first read is pending before any DOM exists.
  private menuInterest = false;
  private refreshQueued = false;
  private typedRuntimeStatus: string | null = null;
  private typedFallbackReason: string | null = null;
  private typedSourceKinds: string | null = null;

  private requestId = 0;
  private disposed = false;

  constructor(
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement | HTMLInputElement,
    callbacks: SlashCommandDropdownCallbacks,
    options: SlashCommandDropdownOptions = {}
  ) {
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.callbacks = callbacks;
    this.isFixed = options.fixed ?? false;
    this.hiddenCommands = options.hiddenCommands ?? new Set();
    this.providerConfig = options.providerConfig ?? null;
    this.builtInProviderId = this.providerConfig?.providerId ?? options.builtInProviderId;
    this.getProviderEntries = options.getProviderEntries ?? null;

    this.onInput = () => this.handleInputChange();
    this.inputEl.addEventListener('input', this.onInput);

    this.installSession(this.providerConfig);
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    if (!enabled) {
      this.hide();
    }
  }

  setHiddenCommands(commands: Set<string>): void {
    if (this.disposed) return;
    this.hiddenCommands = commands;
  }

  setProviderCatalog(
    config: ProviderCommandDropdownConfig | null,
    getEntries: (() => Promise<ProviderCommandEntry[]>) | null,
    providerId?: ProviderId,
  ): void {
    if (this.disposed) return;
    // Replacement order per design §5.1: withdraw the old request, clear the
    // visible optional DOM, unsubscribe/release the old session, then install.
    this.requestId++;
    this.activeCaller?.abort();
    this.activeCaller = null;
    this.lastConsumed = null;
    this.cachedProviderEntries = [];
    this.providerEntriesFetched = false;
    this.filteredItems = [];
    this.selectedIndex = 0;
    this.removeDropdownElement();
    this.teardownSession();
    this.providerConfig = config;
    this.builtInProviderId = config?.providerId ?? providerId ?? this.builtInProviderId;
    this.getProviderEntries = config ? getEntries : null;
    this.installSession(config);
  }

  handleInputChange(): void {
    if (this.disposed || !this.enabled) return;

    const context = this.computeMenuContext();
    if (!context) {
      this.hide();
      return;
    }

    this.triggerStartIndex = context.triggerIndex;
    this.activeTriggerChar = context.triggerChar;
    this.menuInterest = true;
    this.showDropdown(context.searchText, context.isAtPosition0);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (this.disposed || !this.enabled || !this.isVisible()) return false;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.navigate(1);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this.navigate(-1);
        return true;
      case 'Enter':
      case 'Tab':
        if (this.filteredItems.length > 0) {
          e.preventDefault();
          this.selectItem();
          return true;
        }
        return false;
      case 'Escape':
        e.preventDefault();
        this.hide();
        return true;
    }
    return false;
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('visible') ?? false;
  }

  hide(): void {
    if (this.disposed) return;
    this.menuInterest = false;
    this.activeCaller?.abort();
    this.activeCaller = null;
    this.requestId++;
    if (this.dropdownEl) {
      this.dropdownEl.removeClass('visible');
    }
    this.triggerStartIndex = -1;
    this.callbacks.onHide();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.menuInterest = false;
    this.activeCaller?.abort();
    this.activeCaller = null;
    this.requestId++;
    this.cachedProviderEntries = [];
    this.providerEntriesFetched = false;
    this.teardownSession();
    this.inputEl.removeEventListener('input', this.onInput);
    this.removeDropdownElement();
  }

  resetSdkSkillsCache(): void {
    if (this.disposed) return;
    this.cachedProviderEntries = [];
    this.providerEntriesFetched = false;
    this.requestId++;
    if (this.session) {
      // Typed reads invalidate through the session (advancing its epoch);
      // legacy callers keep the historical cache-reset semantics.
      this.session.invalidate();
      this.lastConsumed = null;
      this.filteredItems = [];
      this.selectedIndex = 0;
      this.removeDropdownElement();
    }
  }

  private getInputValue(): string {
    return this.inputEl.value;
  }

  private getCursorPosition(): number {
    return this.inputEl.selectionStart || 0;
  }

  private setInputValue(value: string): void {
    this.inputEl.value = value;
  }

  private setCursorPosition(pos: number): void {
    this.inputEl.selectionStart = pos;
    this.inputEl.selectionEnd = pos;
  }

  private async showDropdown(searchText: string, isAtPosition0 = true): Promise<void> {
    if (this.disposed) return;
    const currentRequest = ++this.requestId;
    const searchLower = searchText.toLowerCase();
    const session = this.session;

    if (session) {
      // Typed reads: cancel the previous UI waiter, then read through the
      // session. Ready-empty is accepted as a projection; the session owns
      // eligibility and cache reuse on subsequent reads.
      this.activeCaller?.abort();
      const caller = new AbortController();
      this.activeCaller = caller;
      let snapshot: CommandDropdownSnapshot;
      try {
        snapshot = await session.read(caller.signal);
      } catch {
        return;
      }
      if (this.disposed || currentRequest !== this.requestId || this.session !== session) return;
      if (snapshot.status !== 'ready') return;
      if (!session.isCurrent(snapshot.receipt)) return;
      this.lastConsumed = { session, receipt: snapshot.receipt };
      this.cachedProviderEntries = [...snapshot.entries];
      this.projectTypedSnapshot(snapshot);
    } else {
      await this.fetchProviderEntries(currentRequest);
    }

    if (this.disposed || currentRequest !== this.requestId) return;

    const includeBuiltIns = isAtPosition0 && this.activeTriggerChar === '/';
    const allItems = this.buildItemList(includeBuiltIns);

    this.filteredItems = allItems
      .filter(item =>
        item.name.toLowerCase().includes(searchLower) ||
        item.description?.toLowerCase().includes(searchLower)
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    if (this.disposed || currentRequest !== this.requestId) return;

    if (searchText.length > 0 && this.filteredItems.length === 0) {
      this.hide();
      return;
    }

    this.selectedIndex = 0;
    this.render();
  }

  private computeMenuContext(): {
    triggerIndex: number;
    triggerChar: string;
    searchText: string;
    isAtPosition0: boolean;
  } | null {
    const text = this.getInputValue();
    const cursorPos = this.getCursorPosition();
    const textBeforeCursor = text.substring(0, cursorPos);
    const triggerChars = this.providerConfig?.triggerChars ?? ['/'];

    // Scan backward from cursor for the nearest valid trigger char.
    // Valid trigger: at position 0, or preceded by whitespace.
    let triggerIndex = -1;
    let triggerChar = '';

    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = textBeforeCursor.charAt(i);
      if (/\s/.test(ch)) break;
      if (triggerChars.includes(ch)) {
        if (i === 0 || /\s/.test(textBeforeCursor.charAt(i - 1))) {
          triggerIndex = i;
          triggerChar = ch;
        }
        break;
      }
    }

    if (triggerIndex === -1) return null;

    const searchText = textBeforeCursor.substring(triggerIndex + 1);
    if (/\s/.test(searchText)) return null;

    return {
      triggerIndex,
      triggerChar,
      searchText,
      isAtPosition0: triggerIndex === 0,
    };
  }

  private installSession(config: ProviderCommandDropdownConfig | null): void {
    const factory = config?.createDiscoverySession;
    if (typeof factory !== 'function') return;
    const session = factory();
    this.session = session;
    this.sessionUnsubscribe = session.subscribe(() => this.handleSessionChange());
  }

  private teardownSession(): void {
    this.typedRuntimeStatus = null;
    this.typedFallbackReason = null;
    this.typedSourceKinds = null;
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    if (this.session) {
      this.session.release();
      this.session = null;
    }
  }

  private handleSessionChange(): void {
    if (this.disposed) return;
    // A source change withdraws the previous projection synchronously: any
    // in-flight read, rendered options, and their click closures lose
    // eligibility before the coalesced refresh runs.
    this.requestId++;
    this.activeCaller?.abort();
    this.activeCaller = null;
    this.lastConsumed = null;
    this.cachedProviderEntries = [];
    this.filteredItems = [];
    this.selectedIndex = 0;
    this.removeDropdownElement();
    this.scheduleMenuRefresh();
  }

  private scheduleMenuRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.disposed || !this.enabled || !this.menuInterest) return;
      // Only re-open for a still-valid trigger when the user still wants the
      // menu; this must not resurrect a menu the user hid.
      if (!this.computeMenuContext()) return;
      this.handleInputChange();
    });
  }

  private projectTypedSnapshot(snapshot: Extract<CommandDropdownSnapshot, { status: 'ready' }>): void {
    this.typedRuntimeStatus = snapshot.runtime.status;
    this.typedFallbackReason = snapshot.fallbackReason;
    const kinds = new Set<string>();
    for (const ref of snapshot.sourceRefs) {
      kinds.add(ref.receipt.sourceKind);
    }
    this.typedSourceKinds = kinds.size > 0 ? Array.from(kinds).sort().join(',') : null;
  }

  private removeDropdownElement(): void {
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }

  private async fetchProviderEntries(currentRequest: number): Promise<void> {
    if (this.providerEntriesFetched || !this.getProviderEntries) return;

    try {
      const entries = await this.getProviderEntries();
      if (this.disposed || currentRequest !== this.requestId) return;
      if (entries.length > 0) {
        this.cachedProviderEntries = entries;
        this.providerEntriesFetched = true;
      }
    } catch {
      if (this.disposed || currentRequest !== this.requestId) return;
    }
  }

  private buildItemList(includeBuiltIns: boolean): DropdownItem[] {
    const seenNames = new Set<string>();
    const items: DropdownItem[] = [];

    if (includeBuiltIns) {
      const builtIns = getBuiltInCommandsForDropdown(this.builtInProviderId);
      for (const cmd of builtIns) {
        const nameLower = cmd.name.toLowerCase();
        if (!seenNames.has(nameLower)) {
          seenNames.add(nameLower);
          items.push({
            name: cmd.name,
            description: cmd.description,
            argumentHint: cmd.argumentHint,
            content: cmd.content,
            displayPrefix: '/',
            insertPrefix: '/',
            isBuiltIn: true,
            slashCommand: cmd as SlashCommand,
          });
        }
      }
    }

    for (const entry of this.cachedProviderEntries) {
      const nameLower = entry.name.toLowerCase();
      if (seenNames.has(nameLower) || this.hiddenCommands.has(nameLower)) {
        continue;
      }
      seenNames.add(nameLower);
      items.push({
        name: entry.name,
        description: entry.description,
        argumentHint: entry.argumentHint,
        content: entry.content,
        displayPrefix: entry.displayPrefix,
        insertPrefix: entry.insertPrefix,
        isBuiltIn: false,
        providerEntry: entry,
        slashCommand: {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          content: entry.content,
          argumentHint: entry.argumentHint,
          allowedTools: entry.allowedTools,
          model: entry.model,
          source: entry.source,
          kind: entry.kind,
          disableModelInvocation: entry.disableModelInvocation,
          userInvocable: entry.userInvocable,
          context: entry.context,
          agent: entry.agent,
          hooks: entry.hooks,
        },
      });
    }

    return items;
  }

  private render(): void {
    if (!this.dropdownEl) {
      this.dropdownEl = this.createDropdownElement();
    }

    this.dropdownEl.empty();

    if (this.filteredItems.length === 0) {
      const emptyEl = this.dropdownEl.createDiv({ cls: 'claudian-slash-empty' });
      emptyEl.setText('No matching commands');
    } else {
      // Click closures are only eligible for the request epoch they were
      // rendered in; a stale detached element must not insert into a newer list.
      const renderToken = this.requestId;
      for (let i = 0; i < this.filteredItems.length; i++) {
        const item = this.filteredItems[i];
        const itemEl = this.dropdownEl.createDiv({ cls: 'claudian-slash-item' });

        if (i === this.selectedIndex) {
          itemEl.addClass('selected');
        }

        const nameEl = itemEl.createSpan({ cls: 'claudian-slash-name' });
        nameEl.setText(`${item.displayPrefix}${item.name}`);

        if (item.argumentHint) {
          const hintEl = itemEl.createSpan({ cls: 'claudian-slash-hint' });
          hintEl.setText(normalizeArgumentHint(item.argumentHint));
        }

        if (item.description) {
          const descEl = itemEl.createDiv({ cls: 'claudian-slash-desc' });
          descEl.setText(item.description);
        }

        itemEl.addEventListener('click', () => {
          if (renderToken !== this.requestId) return;
          this.selectedIndex = i;
          this.selectItem();
        });

        itemEl.addEventListener('mouseenter', () => {
          this.selectedIndex = i;
          this.updateSelection();
        });
      }
    }

    this.dropdownEl.addClass('visible');

    if (this.session) {
      // Typed DOM projection: status/enums only, never cwd, environment, or tokens.
      if (this.typedRuntimeStatus !== null) {
        this.dropdownEl.setAttribute('data-command-runtime-status', this.typedRuntimeStatus);
      }
      if (this.typedFallbackReason !== null) {
        this.dropdownEl.setAttribute('data-command-fallback-reason', this.typedFallbackReason);
      }
      if (this.typedSourceKinds !== null) {
        this.dropdownEl.setAttribute('data-command-source-kinds', this.typedSourceKinds);
      }
    }

    if (this.isFixed) {
      this.positionFixed();
    }
  }

  private createDropdownElement(): HTMLElement {
    if (this.isFixed) {
      return this.containerEl.createDiv({
        cls: 'claudian-slash-dropdown claudian-slash-dropdown-fixed',
      });
    } else {
      return this.containerEl.createDiv({ cls: 'claudian-slash-dropdown' });
    }
  }

  private positionFixed(): void {
    if (!this.dropdownEl || !this.isFixed) return;

    const inputRect = this.inputEl.getBoundingClientRect();
    this.dropdownEl.style.position = 'fixed';
    this.dropdownEl.style.bottom = `${window.innerHeight - inputRect.top + 4}px`;
    this.dropdownEl.style.left = `${inputRect.left}px`;
    this.dropdownEl.style.right = 'auto';
    this.dropdownEl.style.width = `${Math.max(inputRect.width, 280)}px`;
    this.dropdownEl.style.zIndex = '10001';
  }

  private navigate(direction: number): void {
    const maxIndex = this.filteredItems.length - 1;
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + direction));
    this.updateSelection();
  }

  private updateSelection(): void {
    const items = this.dropdownEl?.querySelectorAll('.claudian-slash-item');
    items?.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('selected');
        (item as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        item.removeClass('selected');
      }
    });
  }

  private selectItem(): void {
    if (this.filteredItems.length === 0) return;

    if (this.session) {
      // Typed selection requires the session identity and receipt that
      // populated the visible list; invalidated UI inserts nothing.
      const consumed = this.lastConsumed;
      if (!consumed || consumed.session !== this.session || !this.session.isCurrent(consumed.receipt)) return;
    }

    const selected = this.filteredItems[this.selectedIndex];
    if (!selected) return;

    const text = this.getInputValue();
    const beforeTrigger = text.substring(0, this.triggerStartIndex);
    const afterCursor = text.substring(this.getCursorPosition());
    const replacement = `${selected.insertPrefix}${selected.name} `;

    this.setInputValue(beforeTrigger + replacement + afterCursor);
    this.setCursorPosition(beforeTrigger.length + replacement.length);

    this.hide();
    if (selected.slashCommand) {
      this.callbacks.onSelect(selected.slashCommand);
    }
    this.inputEl.focus();
  }
}
