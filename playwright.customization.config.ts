import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /customization-studios\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['iPhone 13'] } }],
  webServer: {
    command:
      'VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_ANON_KEY=test-anon-key VITE_CUSTOMIZATION_TEST_HARNESS=true npx vite --host 127.0.0.1',
    url: 'http://127.0.0.1:5173/hub/club-arena/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
