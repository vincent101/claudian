import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type { TabData } from './types';

/**
 * Runs an actual runtime sync under the tab binding's adoption registry (R2
 * wiring, stage 1). Every production sync entry point routes through here so a
 * save can only capture from the runtime its committed binding adopted — never
 * from a runtime a later rebind owns.
 *
 * A tab without a ConversationController (isolated unit fixtures, early
 * assembly) falls back to the plain sync: the adoption bookkeeping is the only
 * thing skipped, never the sync itself.
 */
export function syncRuntimeUnderAdoption(
  tab: TabData,
  runtime: ChatRuntime | null,
  sync: () => void,
  target?: { conversationId: string | null },
): void {
  const controller = tab.controllers?.conversationController;
  if (controller && typeof controller.adoptRuntimeSync === 'function') {
    controller.adoptRuntimeSync(runtime, sync, target);
  } else {
    sync();
  }
}
