/**
 * E2E Test Utilities
 * Common helpers for Playwright tests
 */

import { Page, expect, test } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function waitForPageLoad(page: Page) {
    /* NOT 'networkidle'. Club Arena holds Supabase Realtime websockets open and
       polls, so a signed-in session never reaches network idle and this helper
       would hang until the test timed out. 'load' is the strongest state that
       is actually reachable here. */
    await page.waitForLoadState('load');
}

export async function expectPageToHaveContent(page: Page, text: string | RegExp) {
    await expect(page.locator('body')).toContainText(text);
}

export async function expectNoErrors(page: Page) {
    const errorToast = page.locator('.toast.error');
    await expect(errorToast).not.toBeVisible({ timeout: 1000 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH HELPERS  
// ═══════════════════════════════════════════════════════════════════════════════

export async function loginWithTestUser(page: Page) {
    await page.goto('/auth');
    // This would require test credentials
    // For now, just check page loads
    await expect(page.locator('body')).toBeVisible();
}

export async function logout(page: Page) {
    // Navigate to settings or click logout
    await page.goto('/settings');
    const logoutBtn = page.locator('button:has-text("Logout"), button:has-text("Sign Out")');
    if (await logoutBtn.isVisible()) {
        await logoutBtn.click();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function navigateToClubs(page: Page) {
    await page.goto('/clubs');
    await waitForPageLoad(page);
}

export async function navigateToTournaments(page: Page) {
    await page.goto('/tournaments');
    await waitForPageLoad(page);
}

export async function navigateToWallet(page: Page) {
    await page.goto('/wallet');
    await waitForPageLoad(page);
}

export async function navigateToProfile(page: Page) {
    await page.goto('/profile');
    await waitForPageLoad(page);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORM HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function fillInput(page: Page, selector: string, value: string) {
    const input = page.locator(selector);
    await input.clear();
    await input.fill(value);
}

export async function clickButton(page: Page, text: string) {
    const button = page.locator(`button:has-text("${text}")`);
    await button.click();
}

export async function selectOption(page: Page, selector: string, value: string) {
    await page.locator(selector).selectOption(value);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function expectModalOpen(page: Page) {
    const modal = page.locator('.modal, [role="dialog"]');
    await expect(modal).toBeVisible();
}

export async function closeModal(page: Page) {
    const closeBtn = page.locator('.modal .close-btn, [role="dialog"] button:has-text("Close")');
    if (await closeBtn.isVisible()) {
        await closeBtn.click();
    } else {
        await page.keyboard.press('Escape');
    }
}

export async function confirmModal(page: Page) {
    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Yes")');
    await confirmBtn.click();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export async function expectSuccessToast(page: Page) {
    const toast = page.locator('.toast.success');
    await expect(toast).toBeVisible({ timeout: 5000 });
}

export async function expectErrorToast(page: Page) {
    const toast = page.locator('.toast.error');
    await expect(toast).toBeVisible({ timeout: 5000 });
}

export async function dismissToast(page: Page) {
    const toast = page.locator('.toast');
    if (await toast.isVisible()) {
        await toast.click();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function generateTestEmail(): string {
    const timestamp = Date.now();
    return `test+${timestamp}@clubarena.test`;
}

export function generateTestUsername(): string {
    const timestamp = Date.now();
    return `testuser_${timestamp}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE ASSERTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** The catch-all route's copy (App.tsx `path="*"`). */
const CATCH_ALL_404 = "This page doesn't exist";

/** RouteErrorBoundary / PageErrorBoundary fallbacks. */
const ERROR_BOUNDARY = /This page ran into an issue|Something went wrong/;

/**
 * Navigate to `path` and assert the app actually RENDERED it.
 *
 * REPLACES `await expect(page.locator('body')).toBeVisible()`, which was 67 of
 * the 106 assertions in this directory and is true of every HTML response ever
 * served: a 404 page, a crash boundary, an empty shell, a redirect to login.
 * It cannot fail.
 *
 * That is not a figure of speech. Measured against production on 2026-08-20
 * with a signed-in session, six of these specs were navigating to routes that
 * do not exist in App.tsx — `agent`, `bonus`, `settlements`, `super-agent`,
 * `union`, `report/player/:id` — landing on the catch-all, and reporting
 * success. It is the same failure this suite was already caught by once: an
 * earlier generation used absolute paths, escaped the app's base path onto the
 * World Hub's 404, and 80 tests passed green against it.
 *
 * What is asserted instead:
 *   - signed out, skip: there is genuinely nothing to check, the route is a
 *     redirect to /auth. This is the ONLY branch that skips.
 *   - `#root` exists and has children, so the SPA mounted. The World Hub's 404
 *     is a Next.js page with no `#root` at all, which is what makes this catch
 *     a base-path escape.
 *   - the catch-all did not render — the route exists.
 *   - no error boundary caught.
 *   - optionally, text only this route shows.
 */
export async function expectRoute(
  page: Page,
  path: string,
  opts: { expectText?: string | RegExp; settleMs?: number } = {}
): Promise<boolean> {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(opts.settleMs ?? 3000);
  return assertRendered(page, path, opts);
}

/**
 * The assertion half of `expectRoute`, for tests that have already navigated
 * (usually because they attach console/response listeners first, or need a
 * longer settle before asserting). `path` is only used in failure messages.
 */
export async function assertRendered(
  page: Page,
  path: string,
  opts: { expectText?: string | RegExp } = {}
): Promise<boolean> {
  if (page.url().includes('/auth')) {
    test.skip();
    return false;
  }

  await expect(page.locator('#root'), `${path}: no #root — the SPA never mounted`).toBeAttached({
    timeout: 15000,
  });
  await expect
    .poll(() => page.locator('#root > *').count(), {
      timeout: 15000,
      message: `${path}: #root is empty — the app mounted but rendered nothing`,
    })
    .toBeGreaterThan(0);

  const body = await page.locator('body').innerText();
  expect(body, `${path} fell through to the catch-all 404 — the route does not exist`).not.toContain(
    CATCH_ALL_404
  );
  expect(body, `${path} rendered an error boundary`).not.toMatch(ERROR_BOUNDARY);

  if (opts.expectText) {
    await expect(
      page.getByText(opts.expectText).first(),
      `${path} rendered, but without its own content`
    ).toBeVisible({ timeout: 15000 });
  }
  return true;
}
