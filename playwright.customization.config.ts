import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /customization-studios\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'line',
  // The preview is image-backed and font-stable across our Chromium runners.
  // Keep one reviewed baseline instead of blessing a separate picture for
  // every host OS (which would let Linux CI drift away from the Mac review).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    // Keep this suite isolated from the repo's many other local Vite servers.
    // Reusing port 5173 can silently test a different worktree and bless the
    // wrong UI/persistence behavior.
    baseURL: 'http://127.0.0.1:5188',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['iPhone 13'] } }],
  webServer: {
    command:
      'VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_ANON_KEY=test-anon-key VITE_CUSTOMIZATION_TEST_HARNESS=true npx vite --host 127.0.0.1 --port 5188 --strictPort',
    url: 'http://127.0.0.1:5188/hub/club-arena/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
