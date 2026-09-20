import { defineConfig, devices } from '@playwright/test';
import { portFor } from './scripts/ci/e2e-port.mjs';

/**
 * PER-RUNNER PORT (2026-09-04). This was a hardcoded port and it collided the
 * moment CI moved onto the estate: three boxes, TWELVE runners each, one
 * network namespace, so two pull requests reaching this step together both
 * tried to bind it and the second died with "is already used".
 *
 * Note what is NOT the fix: that error suggests `reuseExistingServer: true`,
 * which here would silently run this pull request's specs against ANOTHER
 * pull request's build - exactly the failure the baseURL comment below warns
 * about. Unique port, not a shared one. See scripts/ci/e2e-port.mjs.
 */
const PORT = portFor(5188);

/**
 * ── ONE BUILD, THREE SUITES (2026-09-05) ─────────────────────────────────────
 *
 * `webServer` below starts a Vite DEV server and compiles this app on demand.
 * That cost 141-200s of every merge, measured across CI runs 8843 and 8844 -
 * roughly HALF of the `CSS Beat E2E` job, which is the critical path of the
 * whole pipeline (p50 334s of a 6.8m ci.yml, and PR-to-merge p50 was also
 * 6.8m, so CI *is* the merge latency).
 *
 * And the job had already built the app and had a `vite preview` running for
 * the beats. The only reason this suite could not use it is
 * VITE_CUSTOMIZATION_TEST_HARNESS, a BUILD-TIME flag that gates the dev
 * showcase route this spec drives.
 *
 * So CI now builds once with the harness flags on and points every suite at
 * that one preview. When ARENA_SHARED_PREVIEW_URL is set there is no server to
 * start and no second compile.
 *
 * The flag stays build-time, which is the whole safety argument: the harness
 * routes exist only in a throwaway CI bundle. `Production Build` and
 * `publish-club-arena.yml` build WITHOUT the flags, so nothing a player
 * downloads contains them, and tests/one-build-three-suites.law.test.ts
 * asserts that the flags appear in the CSS Beat job and nowhere else.
 *
 * Locally, with the variable unset, this file behaves exactly as before.
 */
const SHARED_PREVIEW = process.env.ARENA_SHARED_PREVIEW_URL?.replace(/\/$/, '');

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
    baseURL: SHARED_PREVIEW ?? `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['iPhone 13'] } }],
  // No server to start when CI has already built one with the harness on.
  ...(SHARED_PREVIEW
    ? {}
    : {
        webServer: {
          command: `VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_ANON_KEY=test-anon-key VITE_CUSTOMIZATION_TEST_HARNESS=true npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
          url: `http://127.0.0.1:${PORT}/hub/club-arena/`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
});
