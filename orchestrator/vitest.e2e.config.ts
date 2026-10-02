import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests: real runs of the scenarios, including installing dependencies and running the
 * generated service's test suite. They need network access for `npm ci` and take about two minutes.
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
