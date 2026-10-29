import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser-harness',
  testMatch: 'stats-clock.spec.ts',
  retries: 0,
  workers: 1,
  reporter: 'line',
  use: { browserName: 'chromium', channel: 'chrome', trace: 'retain-on-failure' },
});
