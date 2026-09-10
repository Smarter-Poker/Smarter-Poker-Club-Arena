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
const baseHostname = new URL(baseURL).hostname.toLowerCase();
const targetsLocalDevServer =
  baseHostname === 'localhost' || baseHostname === '127.0.0.1' || baseHostname === '[::1]';

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
      /* This certification deliberately belongs to the real mobile Safari
         transport. Running the same file in Chromium would double the live
         outage and make a green Chromium retry capable of obscuring a WebKit
         regression. */
      testIgnore: /production-live-table-realtime\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit-footer',
      /* The mobile lobby chrome spec runs here too: the three defects it pins
         were photographed on an iPad, and WebKit is the engine that iPad runs. */
      testMatch: /(?:footer-(?:visual-regression|route)|mobile-lobby-chrome)\.spec\.ts$/,
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'webkit-live-table-realtime',
      testMatch: /production-live-table-realtime\.spec\.ts$/,
      /* One failed continuity pass is the verdict. A retry can land on a
         different hand or table and turn a real production freeze green. */
      retries: 0,
      use: {
        ...devices['iPhone 13'],
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
      },
    },
  ],
  /* A manual production certification is not necessarily running under CI.
     Starting Vite merely because CI is unset used to put an unrelated local
     process beside a BASE_URL=https://smarter.poker run. Start it only when
     the selected target is actually the local app; retain CI's existing
     externally-managed-server behavior. */
  ...(isCI || !targetsLocalDevServer
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
