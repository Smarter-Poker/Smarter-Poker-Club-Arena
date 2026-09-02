import { expect, test } from '@playwright/test';

const DEFAULT_E2E_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

test.describe('Production Cashier Certification', () => {
  test.describe.configure({ timeout: 90_000 });

  test.skip(
    !process.env.SP_EMAIL || !process.env.SP_PASS,
    'Dedicated production credentials are required for the authenticated cashier canary.'
  );

  test('serves the redesigned Trade surface and opens its first visible tab', async ({ page }) => {
    test.setTimeout(90_000);
    const clubId = process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID;
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`clubs/${clubId}/cashier`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    await expect(page.locator('[data-cashier-surface="trade"]')).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole('heading', { name: 'Every Chip. Accounted For.', exact: true })
    ).toBeVisible();

    const tablist = page.getByRole('tablist', { name: 'Cashier Actions' });
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole('tab');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    if ((await tabs.count()) > 1) {
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');
    }

    const reconciliation = page.locator('[data-cashier-recovery="true"]');
    await expect(reconciliation).toBeVisible();
    await expect(
      reconciliation.getByRole('heading', { name: 'Reconciliation Console', exact: true })
    ).toBeVisible();
    await expect(reconciliation.getByText('Online', { exact: true })).toBeVisible();
    await expect(reconciliation.getByRole('button', { name: 'Reconcile Now' })).toBeEnabled();

    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    const cashierCritical = consoleErrors.filter(
      (message) =>
        !message.includes('[cashier-telemetry]') &&
        !message.includes('favicon') &&
        !message.includes('Failed to load resource')
    );
    expect(cashierCritical, cashierCritical.join('\n')).toEqual([]);
  });
});
