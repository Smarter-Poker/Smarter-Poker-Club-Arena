import { defineConfig, devices } from '@playwright/test';
import { portFor } from './scripts/ci/e2e-port.mjs';

// Per-runner port - see the note in playwright.customization.config.ts and
// scripts/ci/e2e-port.mjs. Offsets are multiples of 10, so this can never be
// mapped onto the Table Studio port however the runner names hash.
const PORT = portFor(5189);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /financial-decision-human-path\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/hub/club-arena/`,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: { ...devices['iPhone 13'], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: {
    command: `VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_ANON_KEY=test-anon-key VITE_FINANCIAL_DECISION_TEST_HARNESS=true npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/hub/club-arena/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
