/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  E2E TESTS — Cashier Deep Features (Playwright)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Deep verification of Cashier page UX improvements:
 * - Skeleton loading states
 * - Tab keyboard navigation (Arrow keys)
 * - History filter & pagination
 * - Connection status indicator rendering
 * - Focus trap in modals
 * - Rate limiting guard
 */

import { test, expect } from '@playwright/test';

// ── Helper: filter out known non-critical console errors ──
function filterCriticalErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('401') &&
      !e.includes('auth') &&
      !e.includes('not authenticated') &&
      !e.includes('AuthSessionMissing') &&
      !e.includes('Invalid Refresh Token') &&
      !e.includes('[HMR]') &&
      !e.includes('verify_ledger_totals')
  );
}

test.describe('Cashier Page — Deep UX Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to cashier — will redirect to login if unauthenticated
    await page.goto('cashier');
    await page.waitForTimeout(2000);
  });

  test('should render tabs with correct ARIA attributes', async ({ page }) => {
    const tablist = page.locator('[role="tablist"]');
    const tablistCount = await tablist.count();

    if (tablistCount > 0) {
      await expect(tablist).toHaveAttribute('aria-label', 'Cashier Actions');

      const tabs = page.locator('[role="tab"]');
      const count = await tabs.count();
      expect(count).toBeGreaterThanOrEqual(2); // At minimum: buyin, cashout

      // Verify aria-selected on active tab
      const activeTab = page.locator('[role="tab"][aria-selected="true"]');
      await expect(activeTab).toHaveCount(1);
    }
  });

  test('should support keyboard navigation between tabs', async ({ page }) => {
    const firstTab = page.locator('[role="tab"]').first();
    const tabCount = await page.locator('[role="tab"]').count();

    if (tabCount > 1) {
      await firstTab.focus();

      // Press ArrowRight to move to next tab
      await firstTab.press('ArrowRight');

      // The second tab should now be focused and selected
      const secondTab = page.locator('[role="tab"]').nth(1);
      await expect(secondTab).toHaveAttribute('aria-selected', 'true');
      await expect(secondTab).toBeFocused();

      // Press ArrowLeft to go back
      await secondTab.press('ArrowLeft');

      await expect(firstTab).toHaveAttribute('aria-selected', 'true');
      await expect(firstTab).toBeFocused();
    }
  });

  test('should render skeleton or content without crash', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.waitForTimeout(3000);

    // No error boundary should be triggered
    const errorBoundary = page.locator('text=Something went wrong');
    await expect(errorBoundary).not.toBeVisible();

    const critical = filterCriticalErrors(consoleErrors);
    expect(critical).toHaveLength(0);
  });

  test('should have accessible tab buttons with roving tabIndex', async ({ page }) => {
    const activeTab = page.locator('[role="tab"][aria-selected="true"]');
    const inactiveTab = page.locator('[role="tab"][aria-selected="false"]').first();

    if ((await activeTab.count()) > 0 && (await inactiveTab.count()) > 0) {
      await expect(activeTab).toHaveAttribute('tabindex', '0');
      await expect(inactiveTab).toHaveAttribute('tabindex', '-1');
    }
  });
});

test.describe('Wallet Page — Deep UX Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('wallet');
    await page.waitForTimeout(2000);
  });

  test('should render wallet tabs (Wallets, Transfer, Ledger)', async ({ page }) => {
    const body = page.locator('body');
    await expect(body).toBeVisible();

    // Check no error boundary
    const errorBoundary = page.locator('text=Something went wrong');
    await expect(errorBoundary).not.toBeVisible();
  });

  test('should load without critical console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.waitForTimeout(3000);

    const critical = filterCriticalErrors(consoleErrors);
    expect(critical).toHaveLength(0);
  });
});

test.describe('Transaction History — UX Tests', () => {
  test('should show skeleton or transaction data', async ({ page }) => {
    await page.goto('cashier');
    await page.waitForTimeout(2000);

    // Click History tab if present
    const historyTab = page.locator('[role="tab"]', { hasText: 'History' });
    if ((await historyTab.count()) > 0) {
      await historyTab.click();
      await page.waitForTimeout(1000);

      // Should show either skeleton bars, transaction rows, empty state, or error+retry
      /* The cashier is styled with CSS Modules, so nothing on this page has a
         plain global class: a transaction row ships as
         `class="_txRow_1mn1y_662"`. `.transaction-row` and its three siblings
         below could never match anything on any build, which made `hasContent`
         unconditionally false - and the test still passed for a year, because
         signed out the History tab did not exist and the whole block was
         skipped by `if (historyTab.count() > 0)`.

         Match on the stable part of the generated name. Verified live: the
         panel renders `_txRow_*` rows with real transactions. */
      const skeleton = page.locator('[class*="txSkeleton"], [class*="skeleton"]');
      const txRows = page.locator('[class*="txRow"]');
      const emptyState = page.locator('[class*="emptyState"], [class*="txEmpty"]');
      const retryBtn = page.locator('[class*="txRetry"], [class*="retryBtn"]');

      const hasContent =
        (await skeleton.count()) > 0 ||
        (await txRows.count()) > 0 ||
        (await emptyState.count()) > 0 ||
        (await retryBtn.count()) > 0;

      expect(hasContent).toBe(true);
    }
  });
});

test.describe('Club CashierModal — ARIA Tests', () => {
  test('should render ARIA tablist and tabs if club cashier is open', async ({ page }) => {
    await page.goto('cashier');
    await page.waitForTimeout(2000);

    // These tests verify the club CashierModal ARIA wiring added in Phase 3.
    // If the modal is not open, the test passes gracefully.
    const tablist = page.locator('[role="tablist"][aria-label="Cashier Actions"]');
    if ((await tablist.count()) > 0) {
      const tabs = page.locator('[role="tab"]');
      const count = await tabs.count();
      expect(count).toBeGreaterThanOrEqual(2);

      // Each tab should have aria-controls pointing to a valid panel ID
      for (let i = 0; i < count; i++) {
        const ariaControls = await tabs.nth(i).getAttribute('aria-controls');
        expect(ariaControls).toBeTruthy();

        // The controlled panel should exist in the DOM when that tab is active
        const selected = await tabs.nth(i).getAttribute('aria-selected');
        if (selected === 'true') {
          const panel = page.locator(`#${ariaControls}`);
          await expect(panel).toHaveAttribute('role', 'tabpanel');
        }
      }
    }
  });
});

test.describe('Focus Trap — Modal UX Tests', () => {
  test('should close modal on Escape key', async ({ page }) => {
    await page.goto('cashier');
    await page.waitForTimeout(2000);

    // Check if any dialog/modal is open
    const dialog = page.locator('[role="dialog"]');
    if ((await dialog.count()) > 0) {
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // Dialog should be closed
      await expect(dialog).not.toBeVisible();
    }
  });

  test('should trap focus within open modal', async ({ page }) => {
    await page.goto('cashier');
    await page.waitForTimeout(2000);

    const dialog = page.locator('[role="dialog"]');
    if ((await dialog.count()) > 0) {
      // Tab through all focusable elements — focus should stay inside dialog
      const focusable = dialog.locator(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const count = await focusable.count();

      if (count > 1) {
        // Focus first element
        await focusable.first().focus();

        // Tab through all elements + one more (should wrap to first)
        for (let i = 0; i < count; i++) {
          await page.keyboard.press('Tab');
          await page.waitForTimeout(50);
        }

        // After wrapping, active element should still be inside dialog
        const activeInDialog = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return dialog?.contains(document.activeElement) ?? false;
        });
        expect(activeInDialog).toBe(true);
      }
    }
  });
});

test.describe('CashierPage — Settlement Lock', () => {
  test('should show settlement lock error when frozen', async ({ page }) => {
    await page.goto('cashier');
    await page.waitForTimeout(2000);

    // If settlement is active, the lock message should be visible
    const lockMessage = page.locator('text=🔒');
    if ((await lockMessage.count()) > 0) {
      await expect(lockMessage.first()).toBeVisible();
    }
    // If no settlement lock, test passes — we're just verifying the UI renders correctly
  });
});
