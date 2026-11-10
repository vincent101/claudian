import type { SlashCommand } from '../../types';
import type { ProviderId } from '../types';
import type { CommandDropdownSession, CommandTargetCapture } from './ProviderCommandDiscovery';
import type { ProviderCommandEntry } from './ProviderCommandEntry';

export interface ProviderCommandDropdownConfig {
  providerId: ProviderId;
  triggerChars: string[];
  builtInPrefix: string;
  skillPrefix: string;
  commandPrefix: string;
  createDiscoverySession?: () => CommandDropdownSession;
}

export interface ProviderCommandCatalog {
  listDropdownEntries(context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]>;
  openDropdownSession?(targetCapture?: CommandTargetCapture): CommandDropdownSession;
  listVaultEntries(): Promise<ProviderCommandEntry[]>;
  saveVaultEntry(entry: ProviderCommandEntry): Promise<void>;
  deleteVaultEntry(entry: ProviderCommandEntry): Promise<void>;
  setRuntimeCommands(commands: SlashCommand[]): void;
  getDropdownConfig(): ProviderCommandDropdownConfig;
  refresh(): Promise<void>;
}
