import { Menu } from 'obsidian';

import { t } from '../../../i18n/i18n';
import type { TabBarItem, TabId } from './types';

/** Callbacks for TabBar interactions. */
export interface TabBarCallbacks {
  /** Called when a tab badge is clicked. */
  onTabClick: (tabId: TabId) => void;

  /** Called when the close button is clicked on a tab. */
  onTabClose: (tabId: TabId) => void;

  /** Called when the new tab button is clicked. */
  onNewTab: () => void;

  /**
   * Called when a reorder gesture (drop, menu move) commits a new position.
   * `targetIndex` is the insertion index in the order that remains after the
   * source tab is removed first; the owner translates it into a moveTab call.
   */
  onTabReorder: (sourceTabId: TabId, targetIndex: number) => void;
}

/**
 * TabBar renders minimal numbered badge navigation.
 *
 * The bar owns gestures only (click, HTML5 DnD, context menu) and never tab
 * order itself: every reorder is reported through `onTabReorder` with a
 * remove-then-insert index, so all mutations funnel through TabManager.moveTab.
 */
export class TabBar {
  private containerEl: HTMLElement;
  private callbacks: TabBarCallbacks;

  /** Latest item snapshot; menus and drop math read positions from here. */
  private items: TabBarItem[] = [];

  /** Tab id of the badge currently being dragged, null when idle. */
  private dragSourceId: TabId | null = null;

  /**
   * Set once a real drag started. Chromium may still deliver the trailing
   * click after dragend; that click must not switch tabs.
   */
  private dragOccurred = false;

  constructor(containerEl: HTMLElement, callbacks: TabBarCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;
    this.build();
  }

  /** Builds the tab bar UI. */
  private build(): void {
    this.containerEl.addClass('claudian-tab-badges');
  }

  /**
   * Updates the tab bar with new tab data.
   * @param items Tab items to render.
   */
  update(items: TabBarItem[]): void {
    this.items = items;
    // Streaming/attention refreshes replace all badges mid-drag; the captured
    // drag state points at detached nodes, so drop it instead of letting a
    // stale drop or suppressed click leak into the new DOM.
    this.clearDragState();
    this.dragOccurred = false;

    // Clear existing badges
    this.containerEl.empty();

    // Render badges
    for (const item of items) {
      this.renderBadge(item);
    }
  }

  /** Renders a single tab badge. */
  private renderBadge(item: TabBarItem): void {
    // Determine state class (priority: active > attention > streaming > idle)
    let stateClass = 'claudian-tab-badge-idle';
    if (item.isActive) {
      stateClass = 'claudian-tab-badge-active';
    } else if (item.needsAttention) {
      stateClass = 'claudian-tab-badge-attention';
    } else if (item.isStreaming) {
      stateClass = 'claudian-tab-badge-streaming';
    } else if (item.needsReview) {
      stateClass = 'claudian-tab-badge-review';
    }

    const badgeEl = this.containerEl.createDiv({
      cls: `claudian-tab-badge ${stateClass}`,
      text: String(item.index),
    });

    // Tooltip with full title (aria-label only; adding title too causes double tooltip)
    badgeEl.setAttribute('aria-label', item.title);
    badgeEl.setAttribute('data-provider', item.providerId);
    badgeEl.draggable = true;

    this.wireBadgeEvents(badgeEl, item);
  }

  private wireBadgeEvents(badgeEl: HTMLElement, item: TabBarItem): void {
    // Click handler to switch tab; a click right after a drag is swallowed.
    badgeEl.addEventListener('click', () => {
      if (this.dragOccurred) {
        this.dragOccurred = false;
        return;
      }
      this.callbacks.onTabClick(item.id);
    });

    // Right-click opens the standard menu (move left/right, close) instead of
    // closing directly — misclicks must not destroy a streaming session.
    if (item.canClose) {
      badgeEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showContextMenu(item, e);
      });
    }

    badgeEl.addEventListener('dragstart', (e) => {
      this.dragSourceId = item.id;
      this.dragOccurred = true;
      badgeEl.addClass('claudian-tab-badge-dragging');
      // Some engines refuse drags without payload; the id is never read back
      // (source tracking stays in this instance for same-bar validation).
      e.dataTransfer?.setData('text/plain', item.id);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
      }
    });

    badgeEl.addEventListener('dragover', (e) => {
      if (!this.isDraggingKnownTab()) {
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      const before = this.isPointerBeforeMidpoint(badgeEl, e);
      this.showDropIndicator(badgeEl, before);
    });

    badgeEl.addEventListener('drop', (e) => {
      if (!this.isDraggingKnownTab()) {
        return;
      }
      e.preventDefault();
      const sourceId = this.dragSourceId!;
      const before = this.isPointerBeforeMidpoint(badgeEl, e);
      // Compute before clearing: the index math reads the tracked source id.
      const targetIndex = this.computeDropIndex(item.id, before);
      this.clearDragState();
      this.callbacks.onTabReorder(sourceId, targetIndex);
    });

    badgeEl.addEventListener('dragend', () => {
      this.clearDragState();
    });
  }

  private isDraggingKnownTab(): boolean {
    return this.dragSourceId !== null && this.items.some((item) => item.id === this.dragSourceId);
  }

  private isPointerBeforeMidpoint(badgeEl: HTMLElement, e: DragEvent): boolean {
    const rect = badgeEl.getBoundingClientRect();
    const clientX = typeof e.clientX === 'number' ? e.clientX : rect.left;
    return clientX < rect.left + rect.width / 2;
  }

  /** Shows exactly one insertion line across the whole bar. */
  private showDropIndicator(targetBadge: HTMLElement, before: boolean): void {
    for (const badge of Array.from(this.containerEl.children)) {
      badge.removeClass('claudian-tab-drop-before');
      badge.removeClass('claudian-tab-drop-after');
    }
    targetBadge.addClass(before ? 'claudian-tab-drop-before' : 'claudian-tab-drop-after');
  }

  /**
   * Converts a before/after drop over `targetTabId` into the insertion index
   * of the order that remains after the source tab is removed first.
   */
  private computeDropIndex(targetTabId: TabId, before: boolean): number {
    const ids = this.items.map((item) => item.id);
    const sourceIndex = this.dragSourceId !== null ? ids.indexOf(this.dragSourceId) : -1;
    const targetIndex = ids.indexOf(targetTabId);
    let raw = targetIndex + (before ? 0 : 1);
    if (sourceIndex !== -1 && raw > sourceIndex) {
      raw -= 1;
    }
    return raw;
  }

  private clearDragState(): void {
    if (this.dragSourceId !== null) {
      for (const badge of Array.from(this.containerEl.children)) {
        badge.removeClass('claudian-tab-badge-dragging');
      }
    }
    this.dragSourceId = null;
    for (const badge of Array.from(this.containerEl.children)) {
      badge.removeClass('claudian-tab-drop-before');
      badge.removeClass('claudian-tab-drop-after');
    }
  }

  private showContextMenu(item: TabBarItem, event: MouseEvent): void {
    const ids = this.items.map((entry) => entry.id);
    const index = ids.indexOf(item.id);

    const menu = new Menu();
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(t('chat.tabs.moveLeft'))
        .setIcon('arrow-left')
        .setDisabled(index <= 0)
        .onClick((evt) => {
          evt?.stopPropagation();
          this.callbacks.onTabReorder(item.id, index - 1);
        });
    });
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(t('chat.tabs.moveRight'))
        .setIcon('arrow-right')
        .setDisabled(index === -1 || index >= ids.length - 1)
        .onClick((evt) => {
          evt?.stopPropagation();
          this.callbacks.onTabReorder(item.id, index + 1);
        });
    });
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(t('chat.tabs.close'))
        .setIcon('x')
        .onClick((evt) => {
          evt?.stopPropagation();
          this.callbacks.onTabClose(item.id);
        });
    });
    menu.showAtMouseEvent(event);
  }

  /** Destroys the tab bar. */
  destroy(): void {
    this.clearDragState();
    this.containerEl.empty();
    this.containerEl.removeClass('claudian-tab-badges');
  }
}
