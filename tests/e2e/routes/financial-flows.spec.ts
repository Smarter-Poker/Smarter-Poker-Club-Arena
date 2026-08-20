/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  E2E TESTS — Financial Flows (Playwright)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests critical financial pages load correctly and core UI elements
 * are present. These are enhanced smoke tests that go beyond "body visible"
 * to validate page structure and error-free rendering.
 */

import { test, expect } from '@playwright/test';
import { assertRendered } from './utils';

test.describe('Cashier Page — Financial UI', () => {
  test('should load without console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('[HMR]')) {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('cashier');
    await page.waitForTimeout(2000);

    // Page should render (may redirect to login if not authenticated)
    await assertRendered(page, 'cashier');

    // Filter out known non-critical errors (auth redirects, etc.)
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes('401') &&
        !e.includes('auth') &&
        !e.includes('not authenticated') &&
        !e.includes('AuthSessionMissing') &&
        !e.includes('Invalid Refresh Token') &&
        // A report-only CSP that carries upgrade-insecure-requests makes the
        // browser log that it ignored the directive. It is a notice about our
        // header, not a page error, and it fired on every route.
        !e.includes('Content Security Policy')
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('should render without crash (error boundary not triggered)', async ({ page }) => {
    await page.goto('cashier');
    await page.waitForTimeout(2000);

    // ErrorBoundary renders a specific reload button — if present, page crashed
    const errorBoundary = page.locator('text=Something went wrong');
    await expect(errorBoundary).not.toBeVisible();
  });
});

test.describe('Wallet Page — Financial UI', () => {
  test('should load without console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('[HMR]')) {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('wallet');
    await page.waitForTimeout(2000);
    await assertRendered(page, 'wallet');

    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes('401') &&
        !e.includes('auth') &&
        !e.includes('not authenticated') &&
        !e.includes('AuthSessionMissing') &&
        !e.includes('Invalid Refresh Token') &&
        // A report-only CSP that carries upgrade-insecure-requests makes the
        // browser log that it ignored the directive. It is a notice about our
        // header, not a page error, and it fired on every route.
        !e.includes('Content Security Policy')
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('should not trigger error boundary', async ({ page }) => {
    await page.goto('wallet');
    await page.waitForTimeout(2000);
    const errorBoundary = page.locator('text=Something went wrong');
    await expect(errorBoundary).not.toBeVisible();
  });
});

test.describe('Admin Dashboard — Financial UI', () => {
  test('should load without crash', async ({ page }) => {
    await page.goto('admin');
    await page.waitForTimeout(2000);
    await assertRendered(page, 'admin');

    const errorBoundary = page.locator('text=Something went wrong');
    await expect(errorBoundary).not.toBeVisible();
  });
});

test.describe('Agent Dashboard — Financial UI', () => {
  test('should load without crash', async ({ page }) => {
    await page.goto('agent-portal');
    await page.waitForTimeout(2000);
    await assertRendered(page, 'agent-portal');

    const errorBoundary = page.locator('text=Something went wrong');
    await expect(errorBoundary).not.toBeVisible();
  });
});

test.describe('Union Dashboard — Financial UI', () => {
  test('should load without crash', async ({ page }) => {
    await page.goto('union-dashboard');
    await page.waitForTimeout(2000);
    await assertRendered(page, 'union-dashboard');

    const errorBoundary = page.locator('text=Something went wrong');
    await expect(errorBoundary).not.toBeVisible();
  });
});

test.describe('Settlement Page — Financial UI', () => {
  test('should load without crash', async ({ page }) => {
    await page.goto('settlement-history');
    await page.waitForTimeout(2000);
    await assertRendered(page, 'settlement-history');

    const errorBoundary = page.locator('text=Something went wrong');
    await expect(errorBoundary).not.toBeVisible();
  });
});
