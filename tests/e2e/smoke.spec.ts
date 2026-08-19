/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  E2E SMOKE TESTS — Critical Page Navigation (#7)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Playwright smoke tests that verify all critical pages load without crashing.
 * These tests navigate to each route and assert that key UI elements are present.
 *
 * Run: npx playwright test tests/smoke.spec.ts
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

/**
 * The app is served under a basename — vite.config.ts sets base
 * '/hub/club-arena/' and main.tsx mounts <BrowserRouter basename="/hub/club-arena">.
 *
 * 2026-08-19: this spec navigated to bare '/', '/profile', '/notifications'.
 * Those are not routes in dev OR in production (smarter.poker/lobby returns
 * 404; smarter.poker/hub/club-arena/lobby returns 200), so the page booted
 * outside its own router, three sub-resources 404'd, and "No console errors on
 * critical pages" failed on every run — asserting on 404s the test itself
 * caused. It has been red on main, which is worse than useless: a permanently
 * failing smoke test trains people to ignore the smoke tests.
 */
const APP_BASE = '/hub/club-arena';
const url = (path: string) => `${BASE_URL}${APP_BASE}${path === '/' ? '/' : path}`;

// ─── Helper: Navigate and verify page loads ───
async function assertPageLoads(page: any, path: string, selector: string, timeout = 10000) {
  await page.goto(url(path), { waitUntil: 'networkidle' });
  await expect(page.locator(selector)).toBeVisible({ timeout });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMOKE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Club Arena — Smoke Tests', () => {
  test('Homepage loads successfully', async ({ page }) => {
    await page.goto(url('/'), { waitUntil: 'networkidle' });
    // Should either show the home page or redirect to login
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
    expect(bodyText!.length).toBeGreaterThan(0);
  });

  test('Profile page loads', async ({ page }) => {
    await page.goto(url('/profile'), { waitUntil: 'networkidle' });
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
  });

  test('Notification center loads', async ({ page }) => {
    await page.goto(url('/notifications'), { waitUntil: 'networkidle' });
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
  });

  test('Cashier page loads', async ({ page }) => {
    await page.goto(url('/cashier'), { waitUntil: 'networkidle' });
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
  });

  test('No console errors on critical pages', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: any) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Chrome's console text for a failed subresource is just "Failed to load
    // resource: ... 404" with no URL, so the URL has to come from the response
    // event. This flag records that the ONLY 404s seen were the hub auth
    // redirect described below.
    let authRedirect404Seen = false;
    let other404Seen = false;
    page.on('response', (r) => {
      if (r.status() !== 404) return;
      if (r.url().includes('/auth/login')) authRedirect404Seen = true;
      else other404Seen = true;
    });

    const criticalPages = ['/', '/profile', '/notifications'];

    // NOT `networkidle`: Club Arena holds Supabase Realtime websockets open and
    // polls, so the network never reliably goes idle and this wait is at the
    // mercy of background traffic. It made this the only flaky test in the
    // suite -- it does three sequential navigations inside one 30s test, so it
    // carried 3x the exposure and timed out here on CI run 32082571389, then
    // came back "1 flaky" on run 32084070511.
    // This test asserts nothing about rendered content; it only needs the app
    // to boot and run long enough to emit console errors. domcontentloaded plus
    // a fixed settle does that deterministically.
    for (const path of criticalPages) {
      await page.goto(url(path), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
    }

    // Filter out known non-critical errors (not app bugs):
    // - AuthSessionMissing: Supabase auth when not logged in (expected)
    // - Failed to fetch / net::ERR_ / CORS: unreachable backends from CI runner
    // - upgrade-insecure-requests ignored in report-only: Chrome notice about
    //   our CSP report-only header, not an app error. WH ships CSP report-only
    //   intentionally; the notice would only go away by switching to enforce
    //   mode (tracked in task #72). Chrome logs this as console.error.
    // - 404 on /auth/login: an unauthenticated smoke run is redirected to the
    //   WORLD HUB's login route. That route is served by the hub, not by Club
    //   Arena, so it exists in production (smarter.poker/auth/login -> 200) but
    //   not on the standalone dev server this spec runs against. Chrome logs
    //   the failed navigation as a console error. Ignoring the request that the
    //   redirect itself makes, NOT 404s generally — a 404 on any other resource
    //   still fails this test.
    const isExpectedAuthRedirect404 = (e: string) =>
      e.includes('404') && (e.includes('/auth/login') || authRedirect404Seen);

    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('AuthSessionMissing') &&
        !e.includes('Failed to fetch') &&
        !e.includes('net::ERR_') &&
        !e.includes('CORS') &&
        !e.includes("directive 'upgrade-insecure-requests' is ignored") &&
        !isExpectedAuthRedirect404(e)
    );

    if (realErrors.length > 0) {
      // Surface them in CI logs so any future regression is easy to triage.
      console.error('Unexpected console errors:', JSON.stringify(realErrors, null, 2));
    }
    // A 404 on anything that is NOT the hub auth redirect is a real failure.
    expect(other404Seen, 'a resource other than the hub auth redirect returned 404').toBe(false);
    expect(realErrors).toHaveLength(0);
  });

  test('Pages respond within 3 seconds', async ({ page }) => {
    const criticalPages = ['/', '/profile', '/notifications', '/cashier'];

    for (const path of criticalPages) {
      const start = Date.now();
      await page.goto(url(path), { waitUntil: 'domcontentloaded' });
      const loadTime = Date.now() - start;

      expect(loadTime).toBeLessThan(3000);
      console.log(`  ✓ ${path} loaded in ${loadTime}ms`);
    }
  });
});
