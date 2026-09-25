/**
 * esbuild-based transformer for ESM .mjs files under jest's CJS runtime.
 *
 * Used for the real `@anthropic-ai/claude-agent-sdk/sdk.mjs` in the CLI-death
 * end-to-end tests: the repo's ts-jest transform only matches `.ts`, so
 * without this entry the untransformed ESM source would throw "Cannot use
 * import statement outside a module".
 *
 * `import.meta.url` occurrences in the SDK are fallback CLI-resolution paths
 * (only hit when `pathToClaudeCodeExecutable` is absent — never in Claudian,
 * which always resolves the CLI itself); they are shimmed to the file URL of
 * this module so the transform stays semantics-preserving.
 */
const { transformSync } = require('esbuild');

module.exports = {
  process(sourceText, sourcePath) {
    const result = transformSync(sourceText, {
      loader: 'js',
      format: 'cjs',
      target: 'node18',
      sourcefile: sourcePath,
      banner: 'const __claudianImportMetaUrl = require("url").pathToFileURL(__filename).href;',
      define: { 'import.meta.url': '__claudianImportMetaUrl' },
    });
    return { code: result.code };
  },
};
