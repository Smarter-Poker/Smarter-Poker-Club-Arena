/**
 * CASHIER DEEP E2E — assertions that cannot pass without a Cashier.
 *
 * The previous suite navigated to `cashier`, then returned successfully from
 * every test when the route redirected or a control was absent. It also looked
 * for a tab named "History" even though the shipped tab is "Trade Record".
 * Those green runs proved only that Playwright could render a page. This suite
 * requires the authenticated, club-scoped Trade surface up front and either
 * makes product assertions or reports a real skip when credentials are absent.
 */

import { expect, test, type Page } from '@playwright/test';

import { isSentryEnvelopeRateLimitConsoleError } from '../support/productionConsoleErrorPolicy';

const CLUB_ID = process.env.E2E_CLUB_ID || 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const HAS_AUTH = Boolean(process.env.SP_EMAIL && process.env.SP_PASS);

async function openTradeCashier(page: Page) {
  await page.goto(`clubs/${CLUB_ID}/cashier`, { waitUntil: 'domcontentloaded' });
  await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
  await expect(page.locator('[data-cashier-surface="trade"]')).toBeVisible({ timeout: 60_000 });
  const tablist = page.getByRole('tablist', { name: 'Cashier Actions' });
  await expect(tablist).toBeVisible();
  await expect(tablist).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  return tablist;
}

test.describe('Cashier Trade — deep authenticated UX', () => {
  test.describe.configure({ timeout: 90_000 });
  test.skip(!HAS_AUTH, 'SP_EMAIL/SP_PASS are required; a signed-out page is not Cashier proof.');

  test('defaults to the first visible tab and keeps keyboard/tabpanel wiring exact', async ({
    page,
  }) => {
    const tablist = await openTradeCashier(page);
    const tabs = tablist.getByRole('tab');
    expect(await tabs.count()).toBeGreaterThanOrEqual(3);
    await expect(tabs.first()).toHaveText('Trade');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.first()).toHaveAttribute('tabindex', '0');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');

    const firstPanelId = await tabs.first().getAttribute('aria-controls');
    expect(firstPanelId).toBeTruthy();
    await expect(page.locator(`#${firstPanelId}`)).toHaveAttribute('role', 'tabpanel');

    await tabs.first().focus();
    await tabs.first().press('ArrowRight');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(1)).toBeFocused();
    await tabs.nth(1).press('ArrowLeft');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.first()).toBeFocused();
  });

  test('Trade Record resolves to rows, a truthful empty state, or a retryable error', async ({
    page,
  }) => {
    const tablist = await openTradeCashier(page);
    await tablist.getByRole('tab', { name: 'Trade Record', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: 'Trade Record' });
    await expect(panel).toBeVisible();

    const rows = panel.getByRole('button', { name: /^Open Receipt For/ });
    const empty = panel.getByText('No Trades Recorded Yet.', { exact: true });
    const retry = panel.getByRole('button', { name: 'Retry', exact: true });
    await expect
      .poll(async () => (await rows.count()) + (await empty.count()) + (await retry.count()), {
        timeout: 30_000,
        message: 'Trade Record never reached a terminal UI state',
      })
      .toBeGreaterThan(0);

    if ((await rows.count()) > 0) {
      await rows.first().click();
      const receipt = page.getByRole('dialog', { name: 'Transaction Receipt' });
      await expect(receipt).toBeVisible();
      await expect(receipt.getByText('Recorded In Ledger', { exact: true })).toBeVisible();
      await expect(receipt.getByText(/^[0-9a-f-]{36}$/i)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(receipt).toBeHidden();
    } else if ((await retry.count()) > 0) {
      await expect(panel.getByRole('alert')).toContainText('Could not load your trade record.');
    } else {
      await expect(empty).toBeVisible();
    }
  });

  test('reconciliation reaches a verified state with no hidden resource errors', async ({
    page,
  }) => {
    const errors: Array<{ text: string; url: string }> = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push({ text: message.text(), url: message.location().url });
      }
    });
    await openTradeCashier(page);
    const reconciliation = page.locator('[data-cashier-recovery="true"]');
    const cashierStatus = page
      .getByRole('region', { name: 'Every Chip. Accounted For.' })
      .getByRole('status');
    await expect(cashierStatus).toHaveText(
      /^(Balances synchronized|Cashier ready; loading the rest of the roster after [\d,]+ members)$/,
      { timeout: 30_000 }
    );
    await expect(reconciliation.getByText('Not Yet Verified', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Something went wrong', { exact: false })).toHaveCount(0);

    const critical = errors.filter(
      (entry) =>
        !entry.text.includes('[cashier-telemetry]') &&
        !entry.text.includes('favicon') &&
        !entry.url.includes('favicon') &&
        !isSentryEnvelopeRateLimitConsoleError(entry)
    );
    expect(critical, critical.map((entry) => `${entry.url}: ${entry.text}`).join('\n')).toEqual([]);
  });
});
