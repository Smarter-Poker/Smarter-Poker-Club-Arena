import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('Player Stats production experience', () => {
  // The overview rollup is intentionally exhaustive and can take several
  // seconds for the production canary account. Running all three viewport/a11y
  // probes at once creates an artificial three-query cold-start stampede and
  // can push otherwise healthy reads past the authenticated statement limit.
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test.beforeEach(async ({ page }, testInfo) => {
    const configuredBase = String(testInfo.project.use.baseURL || 'http://localhost:5173/');
    const base = new URL(configuredBase);
    test.skip(
      ['localhost', '127.0.0.1'].includes(base.hostname) &&
        (!process.env.SP_EMAIL || !process.env.SP_PASS),
      'local Hub authentication is not configured'
    );
    const statsUrl = base.pathname.includes('/hub/club-arena')
      ? new URL('stats', configuredBase).toString()
      : new URL('/hub/club-arena/stats', configuredBase).toString();
    await page.goto(statsUrl);
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(
        async () =>
          page.url().includes('/auth') ||
          (await page.getByRole('tab', { name: 'Overview' }).count()) > 0 ||
          (await page.getByText("Couldn't Load Your Stats", { exact: true }).count()) > 0,
        { timeout: 60_000 }
      )
      .toBe(true);
    test.skip(page.url().includes('/auth'), 'authenticated Stats session is not configured');
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Player Intelligence' })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('loads the real Stats route and completes dossier shortcuts', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const shortcut = page.getByRole('button', { name: 'Open Deep Analysis' });
    if (await shortcut.isVisible()) {
      await shortcut.click();
      const analysis = page.getByRole('tab', { name: 'Analysis' });
      await expect(analysis).toHaveAttribute('aria-selected', 'true');
      await expect(analysis).toBeFocused();
      await expect(page.locator('#stats-panel-analysis')).toBeVisible();
    }
  });

  test('fits a 390px phone and keeps all interactive targets usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Player Intelligence' })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const shortTargets = await page.locator('.stats-page button:visible').evaluateAll((buttons) =>
      buttons
        .map((button) => ({
          label: (button.textContent || '').trim(),
          height: button.getBoundingClientRect().height,
        }))
        .filter((button) => button.height < 44)
    );
    expect(shortTargets).toEqual([]);
  });

  test('has no serious or critical automated accessibility violations', async ({ page }) => {
    const results = await new AxeBuilder({ page }).include('.stats-page').analyze();
    expect(
      results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact || '')
      )
    ).toEqual([]);
  });
});
