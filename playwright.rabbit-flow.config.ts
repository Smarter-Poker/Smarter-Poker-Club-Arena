import { defineConfig, devices } from '@playwright/test';
import { portFor } from './scripts/ci/e2e-port.mjs';
const PORT = portFor(5197);
const SHARED_PREVIEW = process.env.ARENA_SHARED_PREVIEW_URL?.replace(/\/$/, '');
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'rabbit-hunt-flow.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 45000,
  reporter: 'line',
  use: {
    baseURL: `${SHARED_PREVIEW ?? `http://127.0.0.1:${PORT}`}/hub/club-arena/`,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } },
    { name: 'desktop-cpu4', use: { ...devices['Desktop Chrome'], browserName: 'chromium' } },
    { name: 'android-profile', use: { ...devices['Pixel 5'], browserName: 'chromium' } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    {
      name: 'reduced-motion',
      use: { ...devices['Pixel 5'], browserName: 'chromium', reducedMotion: 'reduce' },
    },
  ],
  ...(SHARED_PREVIEW
    ? {}
    : {
        webServer: {
          command: `VITE_SUPABASE_URL=https://dummy.supabase.co VITE_SUPABASE_ANON_KEY=dummy npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
          url: `http://127.0.0.1:${PORT}/hub/club-arena/`,
          reuseExistingServer: false,
          timeout: 120000,
        },
      }),
});
