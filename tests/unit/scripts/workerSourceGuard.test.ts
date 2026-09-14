import { readFile } from 'fs/promises';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertWorkerSourceSymbols } = require('../../../scripts/workerSourceGuard.js') as {
  assertWorkerSourceSymbols: (source: string) => void;
};

describe('workerSourceGuard', () => {
  it('accepts the current worker source and rejects a renamed dependency', async () => {
    const source = await readFile(join(process.cwd(), 'src/providers/claude/history/ClaudeTranscriptHistoryIndex.ts'), 'utf8');
    expect(() => assertWorkerSourceSymbols(source)).not.toThrow();
    expect(() => assertWorkerSourceSymbols(source.replace('${serializeWorkerFunction(extractUserText)}', '${serializeWorkerFunction(a)}')))
      .toThrow(/extractUserText/);
    expect(() => assertWorkerSourceSymbols(source.replace('${serializeWorkerFunction(extractSearchText)}', '${serializeWorkerFunction(a)}')))
      .toThrow(/extractSearchText/);
    expect(() => assertWorkerSourceSymbols(source.replace('${serializeWorkerFunction(extractVisibleUserSearchText)}', '${serializeWorkerFunction(a)}')))
      .toThrow(/extractVisibleUserSearchText/);
  });
});
