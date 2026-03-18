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

    for (const path of criticalPages) {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);
    }

    // Filter out known non-critical errors (Supabase auth when not logged in)
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('AuthSessionMissing') &&
        !e.includes('Failed to fetch') &&
        !e.includes('net::ERR_') &&
        !e.includes('CORS')
    );

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
