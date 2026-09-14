const REQUIRED_WORKER_SYMBOLS = [
  'extractUserText',
  'unwrapExternalEnvelope',
  'extractExternalDisplayContent',
  'isDisplayableExternalUser',
  'isRealUserMessage',
  'extractVisibleUserSearchText',
  'extractSearchText',
  'toRawEntry',
  'filterActiveBranchEntries',
  'finalizeIndex',
  'scanSnapshot',
  'buildDirect',
];

function assertWorkerSourceSymbols(bundle) {
  for (const symbol of REQUIRED_WORKER_SYMBOLS) {
    const interpolation = new RegExp(`\\$\\{serializeWorkerFunction\\(${symbol}\\)\\}`);
    if (!interpolation.test(bundle)) {
      throw new Error(`Worker source dependency was renamed or removed: ${symbol}`);
    }
  }
}

module.exports = { assertWorkerSourceSymbols };
