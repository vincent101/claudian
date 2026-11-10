import type { Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import { SESSIONS_PATH, SessionStorage } from '../../core/bootstrap/SessionStorage';
import type { SharedAppStorage } from '../../core/bootstrap/storage';
import { CLAUDIAN_STORAGE_PATH } from '../../core/bootstrap/StoragePaths';
import type { AppTabManagerState } from '../../core/providers/types';
import { PersistenceCoordinator, TAB_LAYOUT_RESOURCE } from '../../core/storage/PersistenceCoordinator';
import { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import { ClaudianSettingsStorage, type StoredClaudianSettings } from '../settings/ClaudianSettingsStorage';

export class SharedStorageService implements SharedAppStorage {
  readonly claudianSettings: ClaudianSettingsStorage;
  readonly sessions: SessionStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;
  private readonly persistence: PersistenceCoordinator;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.adapter = new VaultFileAdapter(plugin.app);
    // Same-host write ordering (S slice): the coordinator is shared with the
    // provider StorageService over the same app, so layout RMWs and metadata
    // writes serialize across both services.
    this.persistence = PersistenceCoordinator.forHost(plugin.app);
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter, this.persistence);
  }

  async initialize(): Promise<{ claudian: Record<string, unknown> }> {
    await this.ensureDirectories();
    const claudian = await this.claudianSettings.load();
    return { claudian };
  }

  async saveClaudianSettings(settings: Record<string, unknown>): Promise<void> {
    await this.claudianSettings.save(settings as StoredClaudianSettings);
  }

  async setTabManagerState(state: AppTabManagerState): Promise<void> {
    try {
      // The whole loadData→merge→saveData RMW is one lane job: concurrent
      // layout saves (or one racing a provider-service save on the same app)
      // can no longer interleave their reads before each other's writes.
      await this.persistence.enqueue(TAB_LAYOUT_RESOURCE, async () => {
        const data = (await this.plugin.loadData()) || {};
        data.tabManagerState = state;
        await this.plugin.saveData(data);
      });
    } catch {
      new Notice('Failed to save tab layout');
    }
  }

  async getTabManagerState(): Promise<AppTabManagerState | null> {
    try {
      // Read barrier: a reopen read must observe layout saves already admitted
      // on this host, including unload-style writes the host never awaited.
      await this.persistence.drain(TAB_LAYOUT_RESOURCE);
      const data = await this.plugin.loadData();
      if (!data?.tabManagerState) {
        return null;
      }

      return this.validateTabManagerState(data.tabManagerState);
    } catch {
      return null;
    }
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  private async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CLAUDIAN_STORAGE_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
  }

  private validateTabManagerState(data: unknown): AppTabManagerState | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const state = data as Record<string, unknown>;
    if (!Array.isArray(state.openTabs)) {
      return null;
    }

    const validatedTabs: AppTabManagerState['openTabs'] = [];
    for (const tab of state.openTabs) {
      if (!tab || typeof tab !== 'object') {
        continue;
      }

      const tabObj = tab as Record<string, unknown>;
      if (typeof tabObj.tabId !== 'string') {
        continue;
      }

      validatedTabs.push({
        tabId: tabObj.tabId,
        conversationId: typeof tabObj.conversationId === 'string' ? tabObj.conversationId : null,
        ...(typeof tabObj.draftModel === 'string'
          ? { draftModel: tabObj.draftModel }
          : {}),
        ...(typeof tabObj.draftProviderId === 'string' && tabObj.draftProviderId.trim()
          ? { draftProviderId: tabObj.draftProviderId }
          : {}),
      });
    }

    return {
      openTabs: validatedTabs,
      activeTabId: typeof state.activeTabId === 'string' ? state.activeTabId : null,
    };
  }
}
