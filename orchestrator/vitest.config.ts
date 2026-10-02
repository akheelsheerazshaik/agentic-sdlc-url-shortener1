import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fast tests only. The end-to-end tests run real builds and have their own config: npm run test:e2e
    include: ['test/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
