import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
    // The equity load governor reads the live event loop; a busy test runner
    // must not shrink the samples the precision tests depend on.
    env: { EQUITY_GOVERNOR: 'off' },
  },
});
