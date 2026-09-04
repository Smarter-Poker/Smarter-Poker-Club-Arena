import { defineConfig, devices } from '@playwright/test';
import { cpus } from 'node:os';

const isCI = !!process.env.CI;
/**
 * Club Arena is served under a BASE PATH (/hub/club-arena/), so specs navigate
 * with RELATIVE paths — goto('cashier'), not goto('/cashier'). An absolute path
 * replaces the whole path and escapes the app entirely: goto('/cashier')
 * against https://smarter.poker/hub/club-arena landed on the World Hub's 404
 * page, and every assertion of the form `expect(body).toBeVisible()` passed
 * there, because a 404 page has a body. That is how 92 specs sat green while
 * testing nothing.
 *
 * Relative resolution needs the trailing slash: without it the last path
 * segment is dropped, so BASE_URL=".../hub/club-arena" would send
 * goto('cashier') to /hub/cashier. Normalise it here rather than relying on
 * every caller to remember.
 */
const rawBaseURL = process.env.BASE_URL || 'http://localhost:5173/hub/club-arena/';
const baseURL = rawBaseURL.endsWith('/') ? rawBaseURL : `${rawBaseURL}/`;

export default defineConfig({
  testDir: './tests/e2e',
  // Only pick up Playwright `.spec.ts` files. Vitest test files use `.test.ts`
  // and must never be loaded by Playwright — both runners register a global
  // `Symbol($$jest-matchers-object)` and the second loader throws
  // `TypeError: Cannot redefine property` and halts with "No tests found".
  // See task #169 for the incident that prompted this guard.
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  /**
   * These specs are read-only smoke checks against a deployed URL — nothing
   * they do can race anything else. Single-worker CI was fine for 34 tests;
   * with the routes/ suite revived it is 149, which at one worker is roughly
   * twenty minutes of everybody's pipeline. Four workers brings it under
   * three, and the run stays well inside what production shrugs off.
   */
  workers: process.env.PLAYWRIGHT_WORKERS
    ? Number(process.env.PLAYWRIGHT_WORKERS)
    : isCI
      ? Math.max(4, Math.floor(cpus().length / 2))
      : undefined,
  reporter: 'html',
  /**
   * Optional authenticated session. tests/e2e/global-setup.ts logs in when
   * SP_EMAIL/SP_PASS are present and writes a storageState; without them it
   * writes an EMPTY state and the suite runs signed out exactly as before.
   * 47 route specs skip themselves on /auth today — this is what lets them
   * actually run, without requiring a credential to exist for the rest to work.
   */
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL,
    /* Written by globalSetup on every run, so it is never stale and never
       missing. Gitignored — a committed one is a leaked session token. */
    storageState: 'tests/e2e/.auth/state.json',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit-footer',
      testMatch: /footer-(?:visual-regression|route)\.spec\.ts$/,
      use: { ...devices['iPhone 13'] },
    },
  ],
  // Skip local dev server in CI — tests run against production (BASE_URL)
  ...(isCI
    ? {}
    : {
        webServer: {
          command: 'npm run dev',
          url: 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 120 * 1000,
        },
      }),
});
