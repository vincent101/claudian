import type ClaudianPlugin from '../../main';
import { HomeFileAdapter } from '../storage/HomeFileAdapter';
import type { ProviderCommandCatalog } from './commands/ProviderCommandCatalog';
import type {
  AgentMentionProvider,
  ProviderCliResolver,
  ProviderId,
  ProviderRuntimeCommandLoader,
  ProviderSettingsTabRenderer,
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from './types';

/**
 * Per-provider command catalog slot state, maintained independently of the
 * services objects. The published reference is compared against in-place
 * mutated services objects, so the "old catalog" can never be read back from
 * an object the caller may have already mutated. Revisions are monotonic and
 * survive `clear()` — an old (catalog, revision) pair must never become
 * current again, even after A→B→A restoration.
 */
interface CommandCatalogSlot {
  published: ProviderCommandCatalog | null;
  revision: number;
  listeners: Set<() => void>;
}

/**
 * Registry for provider-owned workspace/bootstrap services.
 *
 * Unlike `ProviderRegistry`, this boundary owns app-level provider services such
 * as command catalogs, mention providers, plugin/agent managers, and
 * provider-specific storage adaptors.
 */
export class ProviderWorkspaceRegistry {
  private static registrations: Partial<Record<ProviderId, ProviderWorkspaceRegistration>> = {};
  private static services: Partial<Record<ProviderId, ProviderWorkspaceServices>> = {};
  private static commandCatalogSlots: Partial<Record<ProviderId, CommandCatalogSlot>> = {};

  static register(
    providerId: ProviderId,
    registration: ProviderWorkspaceRegistration,
  ): void {
    this.registrations[providerId] = registration;
  }

  private static getWorkspaceRegistration(providerId: ProviderId): ProviderWorkspaceRegistration {
    const registration = this.registrations[providerId];
    if (!registration) {
      throw new Error(`Provider workspace "${providerId}" is not registered.`);
    }
    return registration;
  }

  static async initializeAll(plugin: ClaudianPlugin): Promise<void> {
    const providerIds = Object.keys(this.registrations) as ProviderId[];
    const storage = plugin.storage;
    const vaultAdapter = storage.getAdapter();
    const homeAdapter = new HomeFileAdapter();

    for (const providerId of providerIds) {
      // Publishing goes through setServices so command-slot consumers observe
      // the same commit path as explicit replacement.
      this.setServices(providerId, await this.getWorkspaceRegistration(providerId).initialize({
        plugin,
        storage,
        vaultAdapter,
        homeAdapter,
      }));
    }
  }

  static setServices(
    providerId: ProviderId,
    services: ProviderWorkspaceServices | undefined,
  ): void {
    const previousCatalog = this.commandCatalogSlots[providerId]?.published ?? null;
    if (services) {
      this.services[providerId] = services;
    } else {
      delete this.services[providerId];
    }
    const nextCatalog = services?.commandCatalog ?? null;
    // Only the command slot drives revision/notifications. An unchanged
    // catalog object — including non-command changes on the same services
    // object — must not advance the command revision.
    if (previousCatalog === nextCatalog) return;
    const slot = this.ensureCommandCatalogSlot(providerId);
    slot.published = nextCatalog;
    slot.revision++;
    this.notifyCommandCatalogSlot(providerId);
  }

  static clear(): void {
    this.services = {};
    // Detach every published catalog and advance every affected revision
    // first; only then notify, so each listener observes all slots detached
    // and the new revisions, regardless of which provider it subscribed to.
    const affected: ProviderId[] = [];
    for (const providerId of Object.keys(this.commandCatalogSlots) as ProviderId[]) {
      const slot = this.commandCatalogSlots[providerId];
      if (slot && slot.published !== null) {
        slot.published = null;
        slot.revision++;
        affected.push(providerId);
      }
    }
    for (const providerId of affected) {
      this.notifyCommandCatalogSlot(providerId);
    }
  }

  static getCommandCatalogRevision(providerId: ProviderId): number {
    return this.commandCatalogSlots[providerId]?.revision ?? 0;
  }

  static subscribeCommandCatalog(
    providerId: ProviderId,
    listener: () => void,
  ): () => void {
    const slot = this.ensureCommandCatalogSlot(providerId);
    slot.listeners.add(listener);
    return () => {
      slot.listeners.delete(listener);
    };
  }

  private static ensureCommandCatalogSlot(providerId: ProviderId): CommandCatalogSlot {
    let slot = this.commandCatalogSlots[providerId];
    if (!slot) {
      slot = { published: null, revision: 0, listeners: new Set() };
      this.commandCatalogSlots[providerId] = slot;
    }
    return slot;
  }

  private static notifyCommandCatalogSlot(providerId: ProviderId): void {
    const slot = this.commandCatalogSlots[providerId];
    if (!slot) return;
    for (const listener of [...slot.listeners]) {
      try {
        listener();
      } catch {
        // One broken consumer must never block the publish or other listeners.
      }
    }
  }

  static getServices(
    providerId: ProviderId,
  ): ProviderWorkspaceServices | null {
    return this.services[providerId] ?? null;
  }

  static requireServices(
    providerId: ProviderId,
  ): ProviderWorkspaceServices {
    const services = this.getServices(providerId);
    if (!services) {
      throw new Error(`Provider workspace "${providerId}" is not initialized.`);
    }
    return services;
  }

  static getCommandCatalog(providerId: ProviderId): ProviderCommandCatalog | null {
    return this.getServices(providerId)?.commandCatalog ?? null;
  }

  static getAgentMentionProvider(providerId: ProviderId): AgentMentionProvider | null {
    return this.getServices(providerId)?.agentMentionProvider ?? null;
  }

  static async refreshAgentMentions(providerId: ProviderId): Promise<void> {
    await this.getServices(providerId)?.refreshAgentMentions?.();
  }

  static getCliResolver(providerId: ProviderId): ProviderCliResolver | null {
    return this.getServices(providerId)?.cliResolver ?? null;
  }

  static getRuntimeCommandLoader(providerId: ProviderId): ProviderRuntimeCommandLoader | null {
    return this.getServices(providerId)?.runtimeCommandLoader ?? null;
  }

  static getTabWarmupPolicy(providerId: ProviderId): ProviderTabWarmupPolicy | null {
    return this.getServices(providerId)?.tabWarmupPolicy ?? null;
  }

  static getSettingsTabRenderer(providerId: ProviderId): ProviderSettingsTabRenderer | null {
    return this.getServices(providerId)?.settingsTabRenderer ?? null;
  }
}
