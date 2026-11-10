import { ProviderRegistry } from './ProviderRegistry';
import { ProviderSettingsCoordinator } from './ProviderSettingsCoordinator';
import type { ProviderId, ProviderModelOption, ProviderModelSelection } from './types';

export function getProviderModelOptions(
  providerId: ProviderId,
  settings: Record<string, unknown>,
): ProviderModelOption[] {
  return ProviderRegistry.getChatUIConfig(providerId).getModelOptions(settings)
    .map(option => ({ ...option, providerId }));
}

export function isValidProviderModelSelection(
  selection: ProviderModelSelection,
  settings: Record<string, unknown>,
): boolean {
  return ProviderRegistry.getRegisteredProviderIds().includes(selection.providerId)
    && ProviderRegistry.isEnabled(selection.providerId, settings)
    && getProviderModelOptions(selection.providerId, settings)
      .some(option => option.value === selection.modelId);
}

export function getDefaultProviderModelSelection(
  settings: Record<string, unknown>,
  preferredProviderId?: ProviderId,
): ProviderModelSelection {
  const enabled = ProviderRegistry.getEnabledProviderIds(settings);
  const providerId = preferredProviderId && enabled.includes(preferredProviderId)
    ? preferredProviderId
    : ProviderRegistry.resolveSettingsProviderId(settings);
  const snapshot = ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, providerId);
  const options = getProviderModelOptions(providerId, settings);
  const modelId = options.find(option => option.value === snapshot.model)?.value ?? options[0]?.value;
  if (!modelId) throw new Error(`Provider "${providerId}" has no available models.`);
  return { providerId, modelId };
}

/** Only legacy drafts lack an explicit provider; ambiguity is never guessed. */
export function restoreDraftModelSelection(
  settings: Record<string, unknown>,
  draftModel?: string | null,
  draftProviderId?: ProviderId | null,
  defaultProviderId?: ProviderId,
): { selection: ProviderModelSelection; reset: boolean } {
  const modelId = typeof draftModel === 'string' ? draftModel.trim() : '';
  if (modelId && typeof draftProviderId === 'string' && draftProviderId.trim()) {
    const selection = { providerId: draftProviderId, modelId };
    if (isValidProviderModelSelection(selection, settings)) return { selection, reset: false };
  } else if (modelId) {
    const candidates = ProviderRegistry.getEnabledProviderIds(settings)
      .filter(providerId => getProviderModelOptions(providerId, settings).some(option => option.value === modelId));
    if (candidates.length === 1) {
      return { selection: { providerId: candidates[0], modelId }, reset: false };
    }
  } else if (!draftProviderId) {
    return { selection: getDefaultProviderModelSelection(settings, defaultProviderId), reset: false };
  }
  return { selection: getDefaultProviderModelSelection(settings), reset: true };
}
