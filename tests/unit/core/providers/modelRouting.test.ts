import '@/providers';

import { getDefaultProviderModelSelection, getProviderModelOptions, isValidProviderModelSelection, restoreDraftModelSelection } from '@/core/providers/modelRouting';

const settings = {
  settingsProvider: 'claude', model: 'shared',
  providerConfigs: {
    claude: { modelPresets: [{ label: 'Claude Shared', model: 'shared' }, { label: 'Only Claude', model: 'unique' }] },
    codex: { enabled: true, modelPresets: [{ label: 'Codex Shared', model: 'shared' }] },
  },
};

describe('explicit provider/model routing', () => {
  it('stamps option identity without encoding the native model ID', () => {
    expect(getProviderModelOptions('claude', settings)[0]).toMatchObject({ providerId: 'claude', value: 'shared' });
    expect(getProviderModelOptions('codex', settings)[0]).toMatchObject({ providerId: 'codex', value: 'shared' });
  });

  it('validates each full pair without another provider claiming the model', () => {
    expect(isValidProviderModelSelection({ providerId: 'claude', modelId: 'shared' }, settings)).toBe(true);
    expect(isValidProviderModelSelection({ providerId: 'codex', modelId: 'shared' }, settings)).toBe(true);
    expect(isValidProviderModelSelection({ providerId: 'codex', modelId: 'unique' }, settings)).toBe(false);
    expect(isValidProviderModelSelection({ providerId: 'missing', modelId: 'shared' }, settings)).toBe(false);
  });

  it('retains a valid new-format draft', () => {
    expect(restoreDraftModelSelection(settings, 'shared', 'codex'))
      .toEqual({ selection: { providerId: 'codex', modelId: 'shared' }, reset: false });
  });

  it('fills a unique legacy draft and resets an ambiguous draft explicitly', () => {
    expect(restoreDraftModelSelection(settings, 'unique'))
      .toEqual({ selection: { providerId: 'claude', modelId: 'unique' }, reset: false });
    expect(restoreDraftModelSelection(settings, 'shared'))
      .toEqual({ selection: { providerId: 'claude', modelId: 'shared' }, reset: true });
  });

  it('does not reinterpret an invalid provider pair as a legacy model', () => {
    expect(restoreDraftModelSelection(settings, 'shared', 'deleted').reset).toBe(true);
    expect(restoreDraftModelSelection(settings, 'gone', 'claude').reset).toBe(true);
  });

  it('inherits the preferred enabled provider only for a fresh tab', () => {
    expect(restoreDraftModelSelection(settings, undefined, undefined, 'codex').selection.providerId).toBe('codex');
    expect(getDefaultProviderModelSelection(settings).providerId).toBe('claude');
  });
});
