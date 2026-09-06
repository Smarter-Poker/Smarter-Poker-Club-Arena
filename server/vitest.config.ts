import { defineConfig } from 'vitest/config';

import { TEST_TIMEOUT_MS } from './src/testing/waitBudget';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // ONE definition, imported. It used to be a literal 10_000 here, and two
    // tests independently chose 10_000 as their own wall-clock wait budget -
    // the same number as the ceiling, so the wait could never finish before
    // vitest killed it and the failure printed "Test timed out in 10000ms"
    // with no cause attached. src/testing/waitBudget.ts holds the pair apart
    // and theWaitBudgetFitsUnderTheCeiling.law.test.ts keeps them apart.
    testTimeout: TEST_TIMEOUT_MS,
    // The equity load governor reads the live event loop; a busy test runner
    // must not shrink the samples the precision tests depend on.
    env: { EQUITY_GOVERNOR: 'off' },
  },
});
