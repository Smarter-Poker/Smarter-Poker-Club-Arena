import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const baseURL = process.env.BASE_URL || 'http://localhost:5173';

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
  workers: isCI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
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
