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

// ─── Helper: Navigate and verify page loads ───
async function assertPageLoads(page: any, path: string, selector: string, timeout = 10000) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle' });
  await expect(page.locator(selector)).toBeVisible({ timeout });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMOKE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Club Arena — Smoke Tests', () => {
  test('Homepage loads successfully', async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    // Should either show the home page or redirect to login
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
    expect(bodyText!.length).toBeGreaterThan(0);
  });

  test('Profile page loads', async ({ page }) => {
    await page.goto(`${BASE_URL}/profile`, { waitUntil: 'networkidle' });
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
  });

  test('Notification center loads', async ({ page }) => {
    await page.goto(`${BASE_URL}/notifications`, { waitUntil: 'networkidle' });
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
  });

  test('Cashier page loads', async ({ page }) => {
    await page.goto(`${BASE_URL}/cashier`, { waitUntil: 'networkidle' });
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
      await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
    }

    // Filter out known non-critical errors (not app bugs):
    // - AuthSessionMissing: Supabase auth when not logged in (expected)
    // - Failed to fetch / net::ERR_ / CORS: unreachable backends from CI runner
    // - upgrade-insecure-requests ignored in report-only: Chrome notice about
    //   our CSP report-only header, not an app error. WH ships CSP report-only
    //   intentionally; the notice would only go away by switching to enforce
    //   mode (tracked in task #72). Chrome logs this as console.error.
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('AuthSessionMissing') &&
        !e.includes('Failed to fetch') &&
        !e.includes('net::ERR_') &&
        !e.includes('CORS') &&
        !e.includes("directive 'upgrade-insecure-requests' is ignored")
    );

    if (realErrors.length > 0) {
      // Surface them in CI logs so any future regression is easy to triage.
      console.error('Unexpected console errors:', JSON.stringify(realErrors, null, 2));
    }
    expect(realErrors).toHaveLength(0);
  });

  test('Pages respond within 3 seconds', async ({ page }) => {
    const criticalPages = ['/', '/profile', '/notifications', '/cashier'];

    for (const path of criticalPages) {
      const start = Date.now();
      await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
      const loadTime = Date.now() - start;

      expect(loadTime).toBeLessThan(3000);
      console.log(`  ✓ ${path} loaded in ${loadTime}ms`);
    }
  });
});
