import { setLocale, t } from '@/i18n/i18n';
import * as en from '@/i18n/locales/en.json';
import type { TranslationKey } from '@/i18n/types';

/**
 * Interpolation contract for the Codex/OpenCode settings i18n migration.
 * Mirrors the "complete interpolation variable registry" of the design doc:
 * every key below must interpolate exactly the listed variables, and no other
 * key may carry placeholders.
 */
const INTERPOLATION_REGISTRY: Array<{
  key: TranslationKey;
  params: Record<string, string | number>;
}> = [
  { key: 'settings.environmentReview', params: { keys: 'OPENAI_API_KEY, CODEX_SANDBOX' } },
  { key: 'settings.codex.cliPath.name', params: { hostname: 'host-a' } },
  { key: 'settings.codex.skills.validation.nameTooLong', params: { max: 64 } },
  { key: 'settings.codex.skills.deleted', params: { name: 'analyze' } },
  { key: 'settings.codex.skills.updated', params: { name: 'analyze' } },
  { key: 'settings.codex.skills.created', params: { name: 'analyze' } },
  { key: 'settings.codex.subagents.validation.nameTooLong', params: { max: 64 } },
  { key: 'settings.codex.subagents.validation.duplicateName', params: { name: 'reviewer' } },
  { key: 'settings.codex.subagents.saveFailed', params: { message: 'EACCES' } },
  { key: 'settings.codex.subagents.deleteConfirm', params: { name: 'reviewer' } },
  { key: 'settings.codex.subagents.deleted', params: { name: 'reviewer' } },
  { key: 'settings.codex.subagents.updated', params: { name: 'reviewer' } },
  { key: 'settings.codex.subagents.created', params: { name: 'reviewer' } },
  { key: 'settings.opencode.cliPath.name', params: { hostname: 'host-a' } },
  {
    key: 'settings.opencode.models.summaryOneProvider',
    params: { visible: 2, discovered: 5, providerCount: 1 },
  },
  {
    key: 'settings.opencode.models.summaryManyProviders',
    params: { visible: 2, discovered: 5, providerCount: 3 },
  },
  { key: 'settings.opencode.models.available', params: { count: 5 } },
  { key: 'settings.opencode.models.selected', params: { count: 2 } },
  { key: 'settings.opencode.models.aliasAria', params: { label: 'anthropic/claude' } },
  { key: 'settings.opencode.models.removeAria', params: { label: 'anthropic/claude' } },
  { key: 'settings.opencode.models.allProviders', params: { count: 3 } },
  { key: 'settings.opencode.subagents.validation.duplicateName', params: { name: 'review' } },
  { key: 'settings.opencode.subagents.validation.validNumber', params: { field: 'Temperature' } },
  { key: 'settings.opencode.subagents.validation.positiveInteger', params: { field: 'Steps' } },
  { key: 'settings.opencode.subagents.validation.validJson', params: { field: 'Permission' } },
  { key: 'settings.opencode.subagents.validation.jsonObject', params: { field: 'Options' } },
  { key: 'settings.opencode.subagents.validation.booleanMap', params: { field: 'Enabled tools' } },
  { key: 'settings.opencode.subagents.saveFailed', params: { message: 'EACCES' } },
  { key: 'settings.opencode.subagents.deleteConfirm', params: { name: 'review' } },
  { key: 'settings.opencode.subagents.deleted', params: { name: 'review' } },
  { key: 'settings.opencode.subagents.updated', params: { name: 'review' } },
  { key: 'settings.opencode.subagents.created', params: { name: 'review' } },
];

const REGISTERED_KEYS = new Set(INTERPOLATION_REGISTRY.map((entry) => entry.key));

const PLACEHOLDER_PATTERN = /\{\w+\}/;

const TRANSLATED_LOCALES = ['en', 'zh-CN', 'zh-TW'] as const;

function flattenTranslations(
  translations: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(translations)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      flattenTranslations(value as Record<string, unknown>, nextKey, out);
      continue;
    }
    out[nextKey] = String(value);
  }
  return out;
}

describe('interpolation contract', () => {
  beforeEach(() => {
    setLocale('en');
  });

  describe.each(TRANSLATED_LOCALES)('locale %s', (locale) => {
    beforeEach(() => {
      setLocale(locale);
    });

    it('replaces every registered variable without leftovers', () => {
      for (const { key, params } of INTERPOLATION_REGISTRY) {
        const result = t(key, params);
        expect(result).not.toMatch(PLACEHOLDER_PATTERN);
        for (const value of Object.values(params)) {
          expect(result).toContain(String(value));
        }
      }
    });

    it('keeps the placeholder when a registered param is missing', () => {
      const probe = INTERPOLATION_REGISTRY[0];
      const result = t(probe.key, {});
      expect(result).toMatch(PLACEHOLDER_PATTERN);
    });
  });

  it('restricts placeholders to the registered keys within the new namespaces', () => {
    const english = flattenTranslations(en as unknown as Record<string, unknown>);
    // Only keys added by the Codex/OpenCode migration are governed by this contract;
    // pre-existing keys (chat.*, settings.subagents.*, hotkeys, ...) keep their own params.
    const newNamespace = (key: string) =>
      key === 'settings.environmentReview'
      || key.startsWith('settings.codex.')
      || key.startsWith('settings.opencode.');
    const keysWithPlaceholders = Object.keys(english)
      .filter(newNamespace)
      .filter((key) => PLACEHOLDER_PATTERN.test(english[key]));
    expect(keysWithPlaceholders.sort()).toEqual([...REGISTERED_KEYS].sort());
  });

  it('renders the Codex skill CRUD notices as "$name", not "name" or "$$name"', () => {
    setLocale('en');
    for (const key of [
      'settings.codex.skills.deleted',
      'settings.codex.skills.updated',
      'settings.codex.skills.created',
    ] as TranslationKey[]) {
      const result = t(key, { name: 'analyze' });
      expect(result).toContain('"$analyze"');
      expect(result).not.toContain('$$analyze');
      expect(result).not.toContain('{name}');
    }

    setLocale('zh-CN');
    for (const key of [
      'settings.codex.skills.deleted',
      'settings.codex.skills.updated',
      'settings.codex.skills.created',
    ] as TranslationKey[]) {
      const result = t(key, { name: 'analyze' });
      expect(result).toContain('$analyze');
      expect(result).not.toContain('$$analyze');
      expect(result).not.toContain('{name}');
    }
  });

  it('uses the one/many provider summary variants by count only', () => {
    setLocale('en');
    const one = t('settings.opencode.models.summaryOneProvider', {
      visible: 1, discovered: 2, providerCount: 1,
    });
    const many = t('settings.opencode.models.summaryManyProviders', {
      visible: 1, discovered: 2, providerCount: 2,
    });
    expect(one).toContain('1 provider');
    expect(many).toContain('2 providers');
    expect(one).not.toContain('{');
    expect(many).not.toContain('{');
  });
});
