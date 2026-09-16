import { createMockEl } from '@test/helpers/mockElement';
import { Menu } from 'obsidian';

import { TabBar, type TabBarCallbacks } from '@/features/chat/tabs/TabBar';
import type { TabBarItem } from '@/features/chat/tabs/types';
import { t } from '@/i18n/i18n';

// Helper to create mock callbacks
function createMockCallbacks(): TabBarCallbacks {
  return {
    onTabClick: jest.fn(),
    onTabClose: jest.fn(),
    onNewTab: jest.fn(),
    onTabReorder: jest.fn(),
  };
}

// Helper to create tab bar items
function createTabBarItem(overrides: Partial<TabBarItem> = {}): TabBarItem {
  return {
    id: 'tab-1',
    index: 1,
    title: 'Test Tab',
    providerId: 'claude',
    isActive: false,
    isStreaming: false,
    needsAttention: false,
    needsReview: false,
    canClose: true,
    ...overrides,
  };
}

describe('TabBar', () => {
  describe('constructor', () => {
    it('should add tab badges class to container', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();

      new TabBar(containerEl, callbacks);

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(true);
    });
  });

  describe('update', () => {
    it('should clear existing badges before rendering', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      // First update
      tabBar.update([createTabBarItem()]);
      expect(containerEl._children.length).toBe(1);

      // Second update should clear first
      tabBar.update([createTabBarItem(), createTabBarItem({ id: 'tab-2', index: 2 })]);
      expect(containerEl._children.length).toBe(2);
    });

    it('should render badge for each tab item', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([
        createTabBarItem({ id: 'tab-1', index: 1 }),
        createTabBarItem({ id: 'tab-2', index: 2 }),
        createTabBarItem({ id: 'tab-3', index: 3 }),
      ]);

      expect(containerEl._children.length).toBe(3);
    });

    it('should render empty when no items', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([]);

      expect(containerEl._children.length).toBe(0);
    });
  });

  describe('badge rendering', () => {
    it('should display index number as text', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ index: 5 })]);

      expect(containerEl._children[0].textContent).toBe('5');
    });

    it('should set aria-label tooltip from item title', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ title: 'My Conversation' })]);

      expect(containerEl._children[0].getAttribute('aria-label')).toBe('My Conversation');
      // title attribute is intentionally omitted to prevent double tooltip
      expect(containerEl._children[0].getAttribute('title')).toBeNull();
    });

    it('should set a provider attribute for per-tab streaming colors', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ providerId: 'opencode' })]);

      expect(containerEl._children[0].getAttribute('data-provider')).toBe('opencode');
    });
  });

  describe('badge state classes', () => {
    it('should apply idle class for inactive tab', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: false, isStreaming: false, needsAttention: false })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-idle')).toBe(true);
    });

    it('should apply active class for active tab', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
    });

    it('should apply streaming class for streaming tab', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isStreaming: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(true);
    });

    it('should apply attention class for tab needing attention', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ needsAttention: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-attention')).toBe(true);
    });

    it('should prioritize active over attention', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true, needsAttention: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-attention')).toBe(false);
    });

    it('should prioritize attention over streaming', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isStreaming: true, needsAttention: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-attention')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(false);
    });

    it('should prioritize active over streaming', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ isActive: true, isStreaming: true })]);

      expect(containerEl._children[0]._classList.has('claudian-tab-badge-active')).toBe(true);
      expect(containerEl._children[0]._classList.has('claudian-tab-badge-streaming')).toBe(false);
    });
  });

  describe('badge interactions', () => {
    it('should call onTabClick when badge is clicked', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'clicked-tab' })]);

      // Simulate click
      containerEl._children[0].dispatchEvent('click');

      expect(callbacks.onTabClick).toHaveBeenCalledWith('clicked-tab');
    });
  });

  describe('drag and drop reorder', () => {
    function setupThreeTabs() {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);
      const items = [
        createTabBarItem({ id: 't1', index: 1 }),
        createTabBarItem({ id: 't2', index: 2 }),
        createTabBarItem({ id: 't3', index: 3 }),
      ];
      tabBar.update(items);
      return { containerEl, callbacks, tabBar, items };
    }

    function startDrag(badge: any, id: string) {
      badge.dispatchEvent('dragstart', {
        preventDefault: jest.fn(),
        dataTransfer: { setData: jest.fn(), effectAllowed: '' },
      });
      return id;
    }

    it('marks badges as draggable', () => {
      const { containerEl } = setupThreeTabs();

      for (const badge of containerEl._children) {
        expect(badge.draggable).toBe(true);
      }
    });

    it('computes a drop-after index in remove-then-insert space', () => {
      const { containerEl, callbacks } = setupThreeTabs();

      startDrag(containerEl._children[0], 't1');
      const overBadge = containerEl._children[1];
      overBadge.dispatchEvent('dragover', {
        preventDefault: jest.fn(),
        clientX: 100,
        dataTransfer: { dropEffect: '' },
      });
      overBadge.dispatchEvent('drop', {
        preventDefault: jest.fn(),
        clientX: 100,
        dataTransfer: { dropEffect: '' },
      });

      // Dragging t1 after t2: removing t1 first leaves [t2, t3]; inserting
      // after t2 is index 1.
      expect(callbacks.onTabReorder).toHaveBeenCalledWith('t1', 1);
    });

    it('computes a drop-before index in remove-then-insert space', () => {
      const { containerEl, callbacks } = setupThreeTabs();

      startDrag(containerEl._children[2], 't3');
      const overBadge = containerEl._children[0];
      overBadge.getBoundingClientRect = () => ({ left: 50, width: 20 } as DOMRect);
      overBadge.dispatchEvent('dragover', {
        preventDefault: jest.fn(),
        clientX: 55,
        dataTransfer: { dropEffect: '' },
      });
      overBadge.dispatchEvent('drop', {
        preventDefault: jest.fn(),
        clientX: 55,
        dataTransfer: { dropEffect: '' },
      });

      // Dragging t3 before t1: target index 0 in the [t1, t2] remainder.
      expect(callbacks.onTabReorder).toHaveBeenCalledWith('t3', 0);
    });

    it('shows exactly one insertion indicator during dragover and clears it on drop', () => {
      const { containerEl } = setupThreeTabs();

      startDrag(containerEl._children[0], 't1');
      const target = containerEl._children[1];
      target.getBoundingClientRect = () => ({ left: 50, width: 20 } as DOMRect);
      target.dispatchEvent('dragover', {
        preventDefault: jest.fn(),
        clientX: 70,
        dataTransfer: { dropEffect: '' },
      });

      expect(target.hasClass('claudian-tab-drop-after')).toBe(true);
      expect(target.hasClass('claudian-tab-drop-before')).toBe(false);
      expect(containerEl._children[2].hasClass('claudian-tab-drop-after')).toBe(false);
      expect(containerEl._children[2].hasClass('claudian-tab-drop-before')).toBe(false);

      target.dispatchEvent('drop', {
        preventDefault: jest.fn(),
        clientX: 70,
        dataTransfer: { dropEffect: '' },
      });

      expect(target.hasClass('claudian-tab-drop-after')).toBe(false);
      expect(target.hasClass('claudian-tab-drop-before')).toBe(false);
    });

    it('swaps the indicator edge when dragging across the midpoint', () => {
      const { containerEl } = setupThreeTabs();

      startDrag(containerEl._children[0], 't1');
      const target = containerEl._children[1];
      target.getBoundingClientRect = () => ({ left: 50, width: 20 } as DOMRect);

      target.dispatchEvent('dragover', {
        preventDefault: jest.fn(),
        clientX: 51,
        dataTransfer: { dropEffect: '' },
      });
      expect(target.hasClass('claudian-tab-drop-before')).toBe(true);

      target.dispatchEvent('dragover', {
        preventDefault: jest.fn(),
        clientX: 69,
        dataTransfer: { dropEffect: '' },
      });
      expect(target.hasClass('claudian-tab-drop-after')).toBe(true);
      expect(target.hasClass('claudian-tab-drop-before')).toBe(false);
    });

    it('ignores dragover from an unknown source tab', () => {
      const { containerEl, callbacks } = setupThreeTabs();

      // A drag started in another TabBar never registered a source here.
      containerEl._children[1].dispatchEvent('dragover', {
        preventDefault: jest.fn(),
        clientX: 70,
        dataTransfer: { dropEffect: '' },
      });
      containerEl._children[1].dispatchEvent('drop', {
        preventDefault: jest.fn(),
        clientX: 70,
        dataTransfer: { dropEffect: '' },
      });

      expect(callbacks.onTabReorder).not.toHaveBeenCalled();
      expect(containerEl._children[1].hasClass('claudian-tab-drop-after')).toBe(false);
    });

    it('does not switch tabs on the click following a drag', () => {
      const { containerEl, callbacks } = setupThreeTabs();

      startDrag(containerEl._children[0], 't1');
      containerEl._children[1].dispatchEvent('dragover', {
        preventDefault: jest.fn(),
        clientX: 70,
        dataTransfer: { dropEffect: '' },
      });
      containerEl._children[1].dispatchEvent('drop', {
        preventDefault: jest.fn(),
        clientX: 70,
        dataTransfer: { dropEffect: '' },
      });

      // Chromium can still deliver a click after dragend; it must not switch.
      containerEl._children[0].dispatchEvent('click');

      expect(callbacks.onTabClick).not.toHaveBeenCalled();
    });

    it('clears drag state unconditionally on dragend', () => {
      const { containerEl } = setupThreeTabs();

      const source = containerEl._children[0];
      startDrag(source, 't1');
      const target = containerEl._children[1];
      target.dispatchEvent('dragover', {
        preventDefault: jest.fn(),
        clientX: 70,
        dataTransfer: { dropEffect: '' },
      });

      source.dispatchEvent('dragend', { preventDefault: jest.fn() });

      expect(source.hasClass('claudian-tab-badge-dragging')).toBe(false);
      expect(target.hasClass('claudian-tab-drop-after')).toBe(false);

      // A later plain click switches normally again.
      target.dispatchEvent('click');
      expect(target._eventListeners.has('click')).toBe(true);
    });

    it('clears stale drag state when update() replaces the badges', () => {
      const { containerEl, tabBar, callbacks } = setupThreeTabs();

      const source = containerEl._children[0];
      startDrag(source, 't1');
      source.dispatchEvent('dragend', { preventDefault: jest.fn() });

      // The post-drag click arrives after update() already rebuilt the DOM:
      // the rebuilt badge must switch tabs normally.
      tabBar.update([
        createTabBarItem({ id: 't2', index: 1 }),
        createTabBarItem({ id: 't1', index: 2 }),
        createTabBarItem({ id: 't3', index: 3 }),
      ]);
      containerEl._children[1].dispatchEvent('click');

      // The rebuilt badge behaves like a fresh gesture: the click switches.
      expect(callbacks.onTabClick).toHaveBeenCalledWith('t1');
    });
  });

  describe('context menu', () => {
    it('shows a menu with translated move/close items instead of closing directly', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);
      tabBar.update([
        createTabBarItem({ id: 't1', index: 1 }),
        createTabBarItem({ id: 't2', index: 2 }),
        createTabBarItem({ id: 't3', index: 3 }),
      ]);

      const mockEvent = { preventDefault: jest.fn(), clientX: 10, clientY: 10 };
      containerEl._children[1].dispatchEvent('contextmenu', mockEvent);

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(callbacks.onTabClose).not.toHaveBeenCalled();

      const menu = (Menu as any).instances.at(-1);
      expect(menu).toBeDefined();
      expect(menu.showAtMouseEvent).toHaveBeenCalledWith(mockEvent);
      expect(menu.items.map((item: any) => item.title)).toEqual([
        t('chat.tabs.moveLeft'),
        t('chat.tabs.moveRight'),
        t('chat.tabs.close'),
      ]);
    });

    it('reorders through the shared callback from the menu items', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);
      tabBar.update([
        createTabBarItem({ id: 't1', index: 1 }),
        createTabBarItem({ id: 't2', index: 2 }),
        createTabBarItem({ id: 't3', index: 3 }),
      ]);

      containerEl._children[1].dispatchEvent('contextmenu', { preventDefault: jest.fn() });
      const menu = (Menu as any).instances.at(-1);

      // Middle tab moves left → insertion index 0 in remove-then-insert space.
      menu.items[0].clickHandler?.();
      expect(callbacks.onTabReorder).toHaveBeenCalledWith('t2', 0);

      // Middle tab moves right → insertion index 2.
      menu.items[1].clickHandler?.();
      expect(callbacks.onTabReorder).toHaveBeenCalledWith('t2', 2);

      menu.items[2].clickHandler?.();
      expect(callbacks.onTabClose).toHaveBeenCalledWith('t2');
    });

    it('disables boundary move items but keeps positions stable', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);
      tabBar.update([
        createTabBarItem({ id: 't1', index: 1 }),
        createTabBarItem({ id: 't2', index: 2 }),
        createTabBarItem({ id: 't3', index: 3 }),
      ]);

      containerEl._children[0].dispatchEvent('contextmenu', { preventDefault: jest.fn() });
      let menu = (Menu as any).instances.at(-1);
      expect(menu.items[0].disabled).toBe(true);
      expect(menu.items[1].disabled).toBe(false);
      expect(menu.items[2].disabled).toBe(false);

      containerEl._children[2].dispatchEvent('contextmenu', { preventDefault: jest.fn() });
      menu = (Menu as any).instances.at(-1);
      expect(menu.items[0].disabled).toBe(false);
      expect(menu.items[1].disabled).toBe(true);
    });

    it('does not open a menu when the tab cannot close (single streaming tab)', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem({ id: 'uncloseable-tab', canClose: false })]);

      expect(containerEl._children[0]._eventListeners.has('contextmenu')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should empty container', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      tabBar.update([createTabBarItem(), createTabBarItem({ id: 'tab-2', index: 2 })]);
      expect(containerEl._children.length).toBe(2);

      tabBar.destroy();

      expect(containerEl._children.length).toBe(0);
    });

    it('should remove tab badges class from container', () => {
      const containerEl = createMockEl();
      const callbacks = createMockCallbacks();
      const tabBar = new TabBar(containerEl, callbacks);

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(true);

      tabBar.destroy();

      expect(containerEl._classList.has('claudian-tab-badges')).toBe(false);
    });
  });
});
