import { defineConfig, devices } from '@playwright/test';
import { portFor } from './scripts/ci/e2e-port.mjs';

/**
 * THE LIVE-TURN SUITE - a real browser, the built app, and the real engine's
 * wire replayed to it (tests/live-turn/replay-engine.ts). A signed-in fixture
 * player sits at a table and plays a hand with the page's own buttons; nothing
 * reaches production, Supabase or an engine, because every call is answered in
 * the browser (tests/stale-client/mock-backend.ts).
 *
 * It needs a build of the commit under test (about two minutes). The Supabase
 * URL is the placeholder the mock backend answers:
 *
 *   VITE_SUPABASE_URL=https://example.supabase.co \
 *   VITE_SUPABASE_ANON_KEY=live-turn-build npx vite build --outDir <dir>
 *   LIVE_TURN_DIST=<dir> npx playwright test -c playwright.live-turn.config.ts
 *
 * LIVE_TURN_EXPECT_DEFECT=1 asserts the 2026-10-04 defect instead, for a build
 * that predates the fix: the witness that the suite can fail.
 * LIVE_TURN_CHROMIUM names a Chromium binary when Playwright's own is absent.
 * The wire is tests/live-turn/wire/, recorded from the real engine by
 * server/src/engine/aSeatThatClosesAStreetIsHandedTheNext.test.ts.
 */
// Per-runner port (scripts/ci/e2e-port.mjs; tests/no-two-runners-share-a-port):
// base 4622 ends in 2, which no other suite's base does, so no two collide.
const PORT = portFor(4622);
const DIST = process.env.LIVE_TURN_DIST || 'dist';

export default defineConfig({
  testDir: './tests/live-turn',
  testMatch: /.*\.pw\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/hub/club-arena/`,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    launchOptions: process.env.LIVE_TURN_CHROMIUM
      ? { executablePath: process.env.LIVE_TURN_CHROMIUM }
      : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite preview --outDir "${DIST}" --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/hub/club-arena/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
