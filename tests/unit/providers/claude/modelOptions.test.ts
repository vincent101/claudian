import {
  getClaudeModelOptions,
  resolveClaudeModelSelection,
} from '@/providers/claude/modelOptions';
import { DEFAULT_CLAUDE_MODEL_PRESETS } from '@/providers/claude/settings';

describe('getClaudeModelOptions', () => {
  it('returns the default four presets on fresh settings', () => {
    const options = getClaudeModelOptions({});
    expect(options.map(o => o.value)).toEqual(
      DEFAULT_CLAUDE_MODEL_PRESETS.map(p => p.model),
    );
    expect(options.map(o => o.label)).toEqual(
      DEFAULT_CLAUDE_MODEL_PRESETS.map(p => p.label),
    );
  });

  it('serves configured presets as the primary list', () => {
    const options = getClaudeModelOptions({
      providerConfigs: {
        claude: {
          modelPresets: [
            { label: 'Fast', model: 'haiku' },
            { label: 'Deep', model: 'claude-opus-4-6[1m]' },
          ],
        },
      },
    });
    expect(options.map(o => o.value)).toEqual(['haiku', 'claude-opus-4-6[1m]']);
    expect(options[0].label).toBe('Fast');
  });

  it('appends environment models after presets instead of replacing them', () => {
    const options = getClaudeModelOptions({
      providerConfigs: {
        claude: { environmentVariables: 'ANTHROPIC_MODEL=my-opus\nANTHROPIC_DEFAULT_HAIKU_MODEL=my-haiku' },
      },
    });
    // Env options keep their own ordering (model > haiku > sonnet > opus).
    expect(options.map(o => o.value)).toEqual([
      'haiku', 'sonnet', 'opus', 'fable', 'my-opus', 'my-haiku',
    ]);
  });

  it('deduplicates environment models that duplicate a preset', () => {
    const options = getClaudeModelOptions({
      providerConfigs: {
        claude: { environmentVariables: 'ANTHROPIC_MODEL=fable' },
      },
    });
    expect(options.filter(o => o.value === 'fable')).toHaveLength(1);
    expect(options.map(o => o.value)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
  });

  it('recognizes the fable default-model env key', () => {
    const options = getClaudeModelOptions({
      providerConfigs: {
        claude: { environmentVariables: 'ANTHROPIC_DEFAULT_FABLE_MODEL=my-fable' },
      },
    });
    expect(options.map(o => o.value)).toContain('my-fable');
  });

  it('deduplicates env models shared across env keys', () => {
    const options = getClaudeModelOptions({
      providerConfigs: {
        claude: {
          environmentVariables: 'ANTHROPIC_MODEL=shared\nANTHROPIC_DEFAULT_SONNET_MODEL=shared',
        },
      },
    });
    expect(options.filter(o => o.value === 'shared')).toHaveLength(1);
  });
});

describe('resolveClaudeModelSelection', () => {
  it('keeps a current model that matches a preset', () => {
    expect(resolveClaudeModelSelection({}, 'fable')).toBe('fable');
  });

  it('keeps a current model that matches an appended env model', () => {
    const settings = {
      providerConfigs: {
        claude: { environmentVariables: 'ANTHROPIC_MODEL=my-opus' },
      },
    };
    expect(resolveClaudeModelSelection(settings, 'my-opus')).toBe('my-opus');
  });

  it('falls back to lastModel when the current model is no longer offered', () => {
    const settings = {
      providerConfigs: {
        claude: {
          modelPresets: [
            { label: 'Haiku', model: 'haiku' },
            { label: 'Opus', model: 'opus' },
          ],
          lastModel: 'opus',
        },
      },
    };
    expect(resolveClaudeModelSelection(settings, 'removed-model')).toBe('opus');
  });

  it('falls back to the first option when nothing matches', () => {
    const settings = {
      providerConfigs: {
        claude: {
          modelPresets: [
            { label: 'Haiku', model: 'haiku' },
            { label: 'Opus', model: 'opus' },
          ],
          lastModel: 'sonnet',
        },
      },
    };
    expect(resolveClaudeModelSelection(settings, 'removed-model')).toBe('haiku');
  });
});
