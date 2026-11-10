import type { App, Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import { ClaudianSettingsStorage, type StoredClaudianSettings } from '../../../app/settings/ClaudianSettingsStorage';
import { SESSIONS_PATH, SessionStorage } from '../../../core/bootstrap/SessionStorage';
import { CLAUDIAN_STORAGE_PATH } from '../../../core/bootstrap/StoragePaths';
import type { AppTabManagerState } from '../../../core/providers/types';
import { PersistenceCoordinator, TAB_LAYOUT_RESOURCE } from '../../../core/storage/PersistenceCoordinator';
import { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type {
  SlashCommand,
} from '../../../core/types';
import {
  type CCPermissions,
  type CCSettings,
  createPermissionRule,
} from '../types/settings';
import { AGENTS_PATH, AgentVaultStorage } from './AgentVaultStorage';
import { CCSettingsStorage } from './CCSettingsStorage';
import { SKILLS_PATH, SkillStorage } from './SkillStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';

export const CLAUDE_PATH = '.claude';

export interface CombinedSettings {
  cc: CCSettings;
  claudian: StoredClaudianSettings;
}

export class StorageService {
  readonly ccSettings: CCSettingsStorage;
  readonly claudianSettings: ClaudianSettingsStorage;
  readonly commands: SlashCommandStorage;
  readonly skills: SkillStorage;
  readonly sessions: SessionStorage;
  readonly agents: AgentVaultStorage;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;
  private app: App;
  private readonly persistence: PersistenceCoordinator;

  constructor(plugin: Plugin, adapter?: VaultFileAdapter) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.adapter = adapter ?? new VaultFileAdapter(this.app);
    // Same-host write ordering (S slice): shares one coordinator with
    // SharedStorageService over the same app so metadata writes and layout
    // RMWs serialize across both services.
    this.persistence = PersistenceCoordinator.forHost(this.app);
    this.ccSettings = new CCSettingsStorage(this.adapter);
    this.claudianSettings = new ClaudianSettingsStorage(this.adapter);
    this.commands = new SlashCommandStorage(this.adapter);
    this.skills = new SkillStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter, this.persistence);
    this.agents = new AgentVaultStorage(this.adapter);
  }

  async initialize(): Promise<CombinedSettings> {
    await this.ensureDirectories();

    const cc = await this.ccSettings.load();
    const claudian = await this.claudianSettings.load();

    return { cc, claudian };
  }

  async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CLAUDE_PATH);
    await this.adapter.ensureFolder(CLAUDIAN_STORAGE_PATH);
    await this.adapter.ensureFolder(COMMANDS_PATH);
    await this.adapter.ensureFolder(SKILLS_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
    await this.adapter.ensureFolder(AGENTS_PATH);
  }

  async loadAllSlashCommands(): Promise<SlashCommand[]> {
    const commands = await this.commands.loadAll();
    const skills = await this.skills.loadAll();
    return [...commands, ...skills];
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  async getPermissions(): Promise<CCPermissions> {
    return this.ccSettings.getPermissions();
  }

  async updatePermissions(permissions: CCPermissions): Promise<void> {
    return this.ccSettings.updatePermissions(permissions);
  }

  async addAllowRule(rule: string): Promise<void> {
    return this.ccSettings.addAllowRule(createPermissionRule(rule));
  }

  async addDenyRule(rule: string): Promise<void> {
    return this.ccSettings.addDenyRule(createPermissionRule(rule));
  }

  async removePermissionRule(rule: string): Promise<void> {
    return this.ccSettings.removeRule(createPermissionRule(rule));
  }

  async updateClaudianSettings(updates: Partial<StoredClaudianSettings>): Promise<void> {
    return this.claudianSettings.update(updates);
  }

  async saveClaudianSettings(settings: StoredClaudianSettings): Promise<void> {
    return this.claudianSettings.save(settings);
  }

  async loadClaudianSettings(): Promise<StoredClaudianSettings> {
    return this.claudianSettings.load();
  }

  async getTabManagerState(): Promise<TabManagerPersistedState | null> {
    try {
      // Read barrier: mirror the shared-app layout lane before reading.
      await this.persistence.drain(TAB_LAYOUT_RESOURCE);
      const data = await this.plugin.loadData();
      if (data?.tabManagerState) {
        return this.validateTabManagerState(data.tabManagerState);
      }
      return null;
    } catch {
      return null;
    }
  }

  private validateTabManagerState(data: unknown): TabManagerPersistedState | null {
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
        continue; // Skip invalid entries
      }
      const tabObj = tab as Record<string, unknown>;
      if (typeof tabObj.tabId !== 'string') {
        continue; // Skip entries without valid tabId
      }
      validatedTabs.push({
        tabId: tabObj.tabId,
        conversationId:
          typeof tabObj.conversationId === 'string' ? tabObj.conversationId : null,
        ...(typeof tabObj.draftModel === 'string'
          ? { draftModel: tabObj.draftModel }
          : {}),
        ...(typeof tabObj.draftProviderId === 'string' && tabObj.draftProviderId.trim()
          ? { draftProviderId: tabObj.draftProviderId }
          : {}),
      });
    }

    const activeTabId =
      typeof state.activeTabId === 'string' ? state.activeTabId : null;

    return {
      openTabs: validatedTabs,
      activeTabId,
    };
  }

  async setTabManagerState(state: TabManagerPersistedState): Promise<void> {
    try {
      // One lane job per RMW — serialized with SharedStorageService's layout
      // writes on the same host app (see TAB_LAYOUT_RESOURCE).
      await this.persistence.enqueue(TAB_LAYOUT_RESOURCE, async () => {
        const data = (await this.plugin.loadData()) || {};
        data.tabManagerState = state;
        await this.plugin.saveData(data);
      });
    } catch {
      new Notice('Failed to save tab layout');
    }
  }
}

export type TabManagerPersistedState = AppTabManagerState;
