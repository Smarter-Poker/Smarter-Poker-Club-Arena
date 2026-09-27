import { defineConfig, devices } from '@playwright/test';
import { portFor } from './scripts/ci/e2e-port.mjs';

/**
 * Push opt-in browser gate (2026-09-27). A local harness, not a deployed URL:
 * tests/push-browser/harnessServer.mjs serves the real prompt, push client and
 * nudge policy with a recorded stand-in for the hub API. No login, no
 * production data. See tests/push-browser/push-enrollment-optin.spec.ts.
 */
const PORT = portFor(5197);

export default defineConfig({
  testDir: './tests/push-browser',
  testMatch: /push-enrollment-optin\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/hub/club-arena/`,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Full Chromium in new-headless mode. The headless shell reports
        // Notification.permission as 'denied' whatever the context grants,
        // which would test the blocked path instead of the opt-in.
        channel: 'chromium',
        // The prompt never asks an automation-controlled browser (it cannot
        // consent). This flag makes the harness browser present as a person's.
        launchOptions: { args: ['--disable-blink-features=AutomationControlled'] },
      },
    },
  ],
  webServer: {
    command: `node tests/push-browser/harnessServer.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/__harness/key`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
