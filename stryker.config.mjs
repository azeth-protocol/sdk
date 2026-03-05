/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  mutate: [
    'src/payments/x402.ts',
    'src/payments/budget.ts',
    'src/auth/erc8128.ts',
    'src/reputation/opinion.ts',
    'src/utils/validation.ts',
  ],
  reporters: ['html', 'clear-text', 'progress'],
  thresholds: { high: 80, low: 60, break: 50 },
  timeoutMS: 60000,
  concurrency: 4,
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
};
