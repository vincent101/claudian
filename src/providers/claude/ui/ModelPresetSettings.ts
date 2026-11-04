import type { ModelPresetEditorBinding } from '../../../core/providers/modelPresets';
import {
  DEFAULT_CLAUDE_MODEL_PRESETS,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '../settings';

export type { ModelPresetEditorOptions } from '../../../shared/ModelPresetSettings';
export { ModelPresetSettings } from '../../../shared/ModelPresetSettings';

/**
 * Claude adapter for the shared preset editor: presets live in the Claude
 * provider config, renames follow the active model, title model, and last
 * model. The last-model rename goes through updateClaudeProviderSettings so
 * the provider config stays the single write path.
 */
export const claudeModelPresetBinding: ModelPresetEditorBinding = {
  i18nPrefix: 'settings.modelPresets',

  getPresets(settings) {
    return getClaudeProviderSettings(settings).modelPresets;
  },

  commitPresets(settings, presets) {
    updateClaudeProviderSettings(settings, { modelPresets: presets });
  },

  resetPresets() {
    return DEFAULT_CLAUDE_MODEL_PRESETS.map(preset => ({ ...preset }));
  },

  applyRenames(settings, renames) {
    const currentModel = typeof settings.model === 'string' ? settings.model : '';
    if (currentModel && renames.has(currentModel)) {
      settings.model = renames.get(currentModel);
    }
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    if (titleModel && renames.has(titleModel)) {
      settings.titleGenerationModel = renames.get(titleModel);
    }

    const lastModel = getClaudeProviderSettings(settings).lastModel;
    if (lastModel && renames.has(lastModel)) {
      updateClaudeProviderSettings(settings, { lastModel: renames.get(lastModel) as string });
    }
  },
};
