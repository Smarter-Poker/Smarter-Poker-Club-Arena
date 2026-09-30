import { defineConfig, devices } from '@playwright/test';

/**
 * THE STALE-CLIENT SUITE (Diamond Phase 11, line 7) - a real browser, a real
 * service worker and two real builds of this app, deployed one over the other
 * on a local origin that behaves like production (tests/stale-client/
 * deploy-server.mjs says exactly how). Nothing here reaches production or
 * Supabase: every Supabase call the specs need is answered in the browser.
 *
 * It needs the two builds first (about three minutes each):
 *
 *   sh tests/stale-client/build-two-deploys.sh <out-dir>
 *   STALE_CLIENT_DIST_A=<out-dir>/distA STALE_CLIENT_DIST_B=<out-dir>/distB \
 *     npx playwright test -c playwright.stale-client.config.ts
 *
 * One worker: the origin has ONE current release, and a deploy is global.
 */
const PORT = Number(process.env.STALE_CLIENT_PORT || 4610);
const A = process.env.STALE_CLIENT_DIST_A || '';
const B = process.env.STALE_CLIENT_DIST_B || '';

export default defineConfig({
  testDir: './tests/stale-client',
  testMatch: /.*\.pw\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/hub/club-arena/`,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node tests/stale-client/deploy-server.mjs "${A}" "${B}" ${PORT}`,
    url: `http://127.0.0.1:${PORT}/__state`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
