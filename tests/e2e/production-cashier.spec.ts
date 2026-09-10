import { expect, test } from '@playwright/test';

import { isSentryEnvelopeRateLimitConsoleError } from './support/productionConsoleErrorPolicy';

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
    const consoleErrors: Array<{ text: string; url: string }> = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push({ text: message.text(), url: message.location().url });
      }
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
    await expect(reconciliation.getByText('Online', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // WAIT FOR HYDRATION, DO NOT ASSERT AGAINST IT.
    //
    // The button is disabled while `loading || isHydrating || !clubUuid`, so
    // this assertion is really "the console finished loading". Every other
    // wait in this spec is given 30-60s because it is talking to real
    // production; this one inherited Playwright's 5s default, and 5s is not a
    // hydration budget - it is a race against a live network.
    //
    // It lost that race at 02:05, 02:18 and 03:03 UTC and won it at 14:48,
    // with no code change in between. That pattern is not a product bug, it is
    // a cold overnight path being slower than a warm afternoon one, and a spec
    // that reports it as a failure teaches everyone to ignore the cashier
    // canary. The assertion is unchanged - the console must end up usable -
    // only the patience is.
    await expect(reconciliation.getByRole('button', { name: 'Reconcile Now' })).toBeEnabled({
      timeout: 30_000,
    });
    // The synchronization message belongs to the hero's live status region;
    // the reconciliation console exposes the same successful state as its
    // verified timestamp. Scoping this assertion to the console looked for a
    // node that cannot exist and made a healthy production cashier fail its
    // canary after hydration completed.
    const cashierStatus = page
      .getByRole('region', { name: 'Every Chip. Accounted For.' })
      .getByRole('status');
    await expect(cashierStatus).toHaveText(
      /^(Balances synchronized|Cashier ready; loading the rest of the roster after [\d,]+ members)$/,
      { timeout: 30_000 }
    );
    await expect(reconciliation.getByText('Not Yet Verified', { exact: true })).toHaveCount(0);

    await expect(page.locator('text=Something went wrong')).toHaveCount(0);
    const cashierCritical = consoleErrors.filter(
      (message) =>
        !message.text.includes('[cashier-telemetry]') &&
        !message.text.includes('favicon') &&
        !message.url.includes('favicon') &&
        !isSentryEnvelopeRateLimitConsoleError(message)
    );
    expect(
      cashierCritical,
      cashierCritical.map((entry) => `${entry.url}: ${entry.text}`).join('\n')
    ).toEqual([]);
  });

  test('opens the wallet directory by right-click and mobile hold without viewport overflow', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('.', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page).not.toHaveURL(/\/auth(?:\/|\?|$)/, { timeout: 30_000 });
    const quickActions = page.getByRole('navigation', { name: 'Quick Actions' });
    await expect(quickActions).toBeVisible({ timeout: 60_000 });
    const cashierTile = quickActions.getByRole('button', { name: /^Cashier\b/ });
    await expect(cashierTile).toBeVisible();
    // The shell can paint before the wallet directory exposes its menu.
    await expect(cashierTile).toHaveAttribute('aria-haspopup', 'menu', { timeout: 30_000 });

    await cashierTile.click({ button: 'right' });
    const desktopMenu = page.getByRole('menu', { name: 'Open Cashier For' });
    await expect(desktopMenu).toBeVisible();
    await expect(desktopMenu.getByRole('menuitem').first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(desktopMenu).toBeHidden();
    await page.setViewportSize({ width: 320, height: 700 });
    await cashierTile.scrollIntoViewIfNeeded();
    await cashierTile.dispatchEvent('pointerdown', { pointerType: 'touch', button: 0 });
    await page.waitForTimeout(550);
    const mobileMenu = page.getByRole('menu', { name: 'Open Cashier For' });
    await expect(mobileMenu).toBeVisible();
    await cashierTile.dispatchEvent('pointerup', { pointerType: 'touch', button: 0 });

    const bounds = await mobileMenu.evaluate((menu) => {
      const box = menu.parentElement?.getBoundingClientRect() ?? menu.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth);
  });
});
