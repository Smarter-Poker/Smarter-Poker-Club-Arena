import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

import { TEST_TIMEOUT_MS } from '../src/testing/waitBudget';

/**
 * LOCAL NATIVE QUALIFICATION RUNNER - NO WORKFLOW REFERENCES THIS FILE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `server/vitest.config.ts` globs `src/**\/*.test.ts`, which is what
 * `npm test` (and therefore the required `Full server test suite` shards)
 * collects. Everything under `qualification/` is deliberately outside that
 * glob AND outside `server/tsconfig.json`'s `include: ["src/**\/*"]`, because
 * it executes an ARCHIVED engine build that exists only on the qualification
 * machine. A GitHub runner has neither the build nor its (never-emitted)
 * declarations, so those files can only run here.
 *
 * Vitest will not collect a file that falls outside `include` even when the
 * path is named on the command line - it filters the glob, it does not
 * override it - so the qualifier needs this config to run at all:
 *
 *   cd server && npx vitest run --config qualification/vitest.config.ts
 *
 * `root` stays at `server/` so the two setup files below resolve exactly as
 * they do for the maintained suite, and so `theSuiteRunsFromTheServerDirectory`
 * sees the working directory it demands.
 */
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    globals: false,
    environment: 'node',
    include: ['qualification/**/*.test.ts'],
    testTimeout: TEST_TIMEOUT_MS,
    setupFiles: [
      './src/testing/theSuiteRunsFromTheServerDirectory.ts',
      './src/testing/theSchedulerStopsBetweenTests.ts',
    ],
    env: {
      EQUITY_GOVERNOR: 'off',
      SUPABASE_URL: 'https://supabase.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'unit-test-placeholder-key',
    },
  },
});
