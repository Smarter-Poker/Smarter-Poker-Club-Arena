/**
 * E2E Test Utilities — route assertions.
 *
 * WHAT WAS HERE BEFORE (removed 2026-08-20): eighteen exported helpers —
 * loginWithTestUser, logout, navigateToClubs/Tournaments/Wallet/Profile,
 * waitForPageLoad, expectPageToHaveContent, expectNoErrors, fillInput,
 * clickButton, selectOption, expectModalOpen, closeModal, confirmModal,
 * expectSuccessToast, expectErrorToast, dismissToast. Every single one had
 * ZERO importers anywhere in tests/ or e2e-live/.
 *
 * They were not merely unused, they were loaded:
 *
 *   - `loginWithTestUser` did not log in. It navigated to /auth and asserted
 *     the body was visible, under its own comment "This would require test
 *     credentials / For now, just check page loads". Anything calling it would
 *     have believed it had a session. Real sign-in now lives in
 *     tests/e2e/global-setup.ts, once per run, via storageState.
 *   - all four navigateToX helpers, and `logout`, used ABSOLUTE paths
 *     (`/clubs`, `/settings`, …). This app is served under /hub/club-arena/,
 *     so an absolute path replaces the whole path and escapes onto the World
 *     Hub's 404 — which is exactly how 80 specs in this suite once ran green
 *     against a 404 page. These were four primed copies of that bug.
 *   - `waitForPageLoad` waited for 'networkidle', which a signed-in session
 *     holding Realtime websockets never reaches.
 *
 * What is left is what is actually imported.
 */

import { Page, expect, test } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE ASSERTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** The catch-all route's copy (App.tsx `path="*"`). */
const CATCH_ALL_404 = 'This Arena Door Is Closed';

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
  expect(
    body,
    `${path} fell through to the catch-all 404 — the route does not exist`
  ).not.toContain(CATCH_ALL_404);
  expect(body, `${path} rendered an error boundary`).not.toMatch(ERROR_BOUNDARY);

  if (opts.expectText) {
    await expect(
      page.getByText(opts.expectText).first(),
      `${path} rendered, but without its own content`
    ).toBeVisible({ timeout: 15000 });
  }
  return true;
}

/**
 * Messages deliberately leaves the Club Arena SPA for the shared World Hub
 * messenger. Treating that successful native handoff as a missing `#root`
 * made both message-route checks fail on the page they were meant to reach.
 */
export async function expectMessengerHandoff(page: Page): Promise<void> {
  await page.goto('messages');
  await page.waitForLoadState('domcontentloaded');
  if (page.url().includes('/auth')) {
    test.skip();
    return;
  }
  await expect(page).toHaveURL(/\/hub\/(?:social-media\/)?messenger(?:[/?#]|$)/, {
    timeout: 15000,
  });
}
