import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * AST-level regression gate for the Codex/OpenCode settings i18n migration.
 *
 * Walks the six migrated files and fails when a user-visible UI sink
 * (settings component name/desc/title/placeholder, DOM text, aria-label/title
 * attributes, Notice, confirm dialogs) receives a hardcoded string or template
 * fragment instead of t(). Technical literals (paths, model IDs, protocol
 * values, JSON examples) are recognized structurally; the narrow allowlist
 * below covers the remaining legitimate literals and every entry must actually
 * occur in the scanned sources.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const TARGET_FILES = [
  'src/providers/codex/ui/CodexSettingsTab.ts',
  'src/providers/codex/ui/CodexSkillSettings.ts',
  'src/providers/codex/ui/CodexSubagentSettings.ts',
  'src/providers/opencode/ui/OpencodeSettingsTab.ts',
  'src/providers/opencode/ui/OpencodeAgentSettings.ts',
  'src/features/settings/ui/EnvironmentSettingsSection.ts',
];

interface AllowlistEntry {
  file: string;
  sink: string;
  literal: string;
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'src/providers/codex/ui/CodexSettingsTab.ts',
    sink: 'setPlaceholder',
    literal: 'Ubuntu',
    reason: 'example WSL distro name shown as placeholder',
  },
  {
    file: 'src/providers/codex/ui/CodexSettingsTab.ts',
    sink: 'createEl.text',
    literal: 'codex mcp',
    reason: 'CLI command rendered inside a <code> element',
  },
];

// Sinks whose first call argument is user-visible text.
const FIRST_ARG_TEXT_METHODS = new Set(['setText', 'setName', 'setDesc', 'setTitle', 'setPlaceholder', 'appendText']);

// Settings-object factories whose name/desc options are user-visible.
const SETTINGS_FACTORY_FUNCTIONS = new Set(['renderHiddenProviderCommandSetting', 'renderEnvironmentSettingsSection']);

// DOM creation helpers whose options object carries visible text.
const DOM_CREATE_METHODS = new Set(['createEl', 'createDiv', 'createSpan']);

// Property assignments whose right-hand side is user-visible text.
const TEXT_PROPERTIES = new Set(['textContent', 'innerText', 'title', 'placeholder']);

// Attribute names inside attr objects / setAttr calls that are user-visible.
const VISIBLE_ATTR_NAMES = new Set(['aria-label', 'title', 'placeholder']);

const CJK_PATTERN = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

function flattenStringAndTemplateFragments(expr: ts.Expression): string[] {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return [expr.text];
  }
  if (ts.isTemplateExpression(expr)) {
    const fragments = [expr.head.text];
    for (const span of expr.templateSpans) {
      fragments.push(span.literal.text);
    }
    return fragments;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [
      ...flattenStringAndTemplateFragments(expr.left),
      ...flattenStringAndTemplateFragments(expr.right),
    ];
  }
  return [];
}

function looksUserVisible(literal: string): boolean {
  const value = literal.trim();
  if (!value) {
    return false;
  }
  // Any CJK content hardcoded in the sources is user-visible copy.
  if (CJK_PATTERN.test(value)) {
    return true;
  }
  // Must contain latin letters to be considered copy.
  if (!/[A-Za-z]/.test(value)) {
    return false;
  }
  // URLs and Windows/Unix paths.
  if (/^https?:\/\//.test(value) || value.includes('\\') || value.startsWith('/')) {
    return false;
  }
  // Hex colors.
  if (/^#[0-9A-Fa-f]{3,8}$/.test(value)) {
    return false;
  }
  // JSON examples.
  if (value.startsWith('{')) {
    return false;
  }
  // Single-token technical values: identifiers, protocol values, model IDs,
  // env var assignments, multi-line lists of them. No real-word spacing.
  // Lowercase-only tokens (workspace-write, codex, analyze-code) and ALL_CAPS
  // tokens (env vars) are technical; mixed-case words like "Ubuntu" stay
  // visible and must go through the allowlist.
  const withoutNewlines = value.replace(/\n/g, '');
  if (!/\s/.test(withoutNewlines)) {
    if (/^[a-z0-9\-_.\\/:=+,#&[\]]+$/.test(withoutNewlines)) {
      return false;
    }
    if (/^[A-Z0-9_]+$/.test(withoutNewlines)) {
      return false;
    }
  }
  return true;
}

interface Finding {
  file: string;
  line: number;
  sink: string;
  literal: string;
}

function collectSinkFindings(relFile: string, source: ts.SourceFile): Finding[] {
  const findings: Finding[] = [];
  const check = (expr: ts.Expression | undefined, sink: string): void => {
    if (!expr) {
      return;
    }
    for (const literal of flattenStringAndTemplateFragments(expr)) {
      if (looksUserVisible(literal)) {
        findings.push({ file: relFile, line: expr.getSourceFile().getLineAndCharacterOfPosition(expr.getStart()).line + 1, sink, literal });
      }
    }
  };

  const checkOptionsObject = (options: ts.Expression | undefined, prefix: string): void => {
    if (!options || !ts.isObjectLiteralExpression(options)) {
      return;
    }
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const name = property.name.getText(source);
      if (name === 'text') {
        check(property.initializer, `${prefix}.text`);
      } else if (name === 'attr' && ts.isObjectLiteralExpression(property.initializer)) {
        for (const attrProperty of property.initializer.properties) {
          if (!ts.isPropertyAssignment(attrProperty)) {
            continue;
          }
          const attrName = attrProperty.name.getText(source).replace(/^['"]|['"]$/g, '');
          if (VISIBLE_ATTR_NAMES.has(attrName)) {
            check(attrProperty.initializer, `${prefix}.attr.${attrName}`);
          }
        }
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isPropertyAccessExpression(expression)) {
        const methodName = expression.name.text;
        if (FIRST_ARG_TEXT_METHODS.has(methodName)) {
          check(node.arguments[0], methodName);
        } else if (methodName === 'addOption') {
          // addOption(value, label): only the label is user-visible.
          check(node.arguments[1], methodName);
        } else if (methodName === 'setAttr' || methodName === 'setAttribute') {
          const attrName = node.arguments[0]?.getText(source).replace(/^['"]|['"]$/g, '');
          if (attrName && VISIBLE_ATTR_NAMES.has(attrName)) {
            check(node.arguments[1], `${methodName}(${attrName})`);
          }
        } else if (DOM_CREATE_METHODS.has(methodName)) {
          checkOptionsObject(node.arguments[1], methodName);
        }
      } else if (ts.isIdentifier(expression)) {
        const functionName = expression.text;
        if (SETTINGS_FACTORY_FUNCTIONS.has(functionName)) {
          checkOptionsObject(node.arguments[1], functionName);
        } else if (functionName === 'confirmDelete') {
          check(node.arguments[1], functionName);
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Notice') {
      check(node.arguments?.[0], 'Notice');
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      if (TEXT_PROPERTIES.has(node.left.name.text)) {
        check(node.right, `=.${node.left.name.text}`);
      }
    }
    node.forEachChild(visit);
  };

  visit(source);
  return findings;
}

describe('UI literal gate for Codex/OpenCode settings', () => {
  const findings: Finding[] = [];
  const allowlistHits = new Set<number>();

  beforeAll(() => {
    for (const relFile of TARGET_FILES) {
      const absolute = path.join(REPO_ROOT, relFile);
      const source = ts.createSourceFile(absolute, fs.readFileSync(absolute, 'utf-8'), ts.ScriptTarget.Latest, true);
      for (const finding of collectSinkFindings(relFile, source)) {
        const index = ALLOWLIST.findIndex(
          (entry) => entry.file === finding.file && entry.sink === finding.sink && entry.literal === finding.literal,
        );
        if (index >= 0) {
          allowlistHits.add(index);
        } else {
          findings.push(finding);
        }
      }
    }
  });

  it('has no unexplained user-visible literals in the six migrated files', () => {
    expect(findings).toEqual([]);
  });

  it('keeps every allowlist entry anchored to a real occurrence', () => {
    const unused = ALLOWLIST.map((entry, index) => (allowlistHits.has(index) ? null : entry))
      .filter((entry): entry is AllowlistEntry => entry !== null);
    expect(unused).toEqual([]);
  });

  it('documents every allowlist entry with a reason', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
