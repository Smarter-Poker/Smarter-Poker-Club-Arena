import { expect, test } from '@playwright/test';
import { waitForInitialTableReadiness } from './initialTableReadiness';

export function registerInitialTableReadinessCases() {
  test('initial readiness browser records the mounted felt and cleared banner together', async ({
    page,
  }) => {
    await page.setContent(`<style>.table-page,.table-surface{width:200px;height:200px}</style>
      <main class="table-page"><section class="table-surface"></section>
      <div data-testid="table-connection-banner">Connecting</div></main>`);
    await page.evaluate(() => {
      setTimeout(
        () => document.querySelector('[data-testid="table-connection-banner"]')?.remove(),
        50
      );
    });
    const startedAt = Date.now();
    const proof = await waitForInitialTableReadiness(page, startedAt, 12_000);
    expect(proof.kind).toBe('ready');
    expect(proof.observedAt).toBeGreaterThanOrEqual(startedAt);
    expect(proof.observedAt).toBeLessThan(startedAt + 12_000);
    await expect(page.locator('.table-surface')).toBeVisible();
    await expect(page.getByTestId('table-connection-banner')).toHaveCount(0);
  });

  test('initial readiness browser refuses felt and banner readiness after its original deadline', async ({
    page,
  }) => {
    await page.setContent(`<style>.table-page,.table-surface{width:200px;height:200px}</style>
      <main class="table-page"><div data-testid="table-connection-banner">Connecting</div></main>`);
    const startedAt = Date.now();
    const budgetMs = 300;
    await page.evaluate((deadline) => {
      setTimeout(
        () => {
          document.querySelector('[data-testid="table-connection-banner"]')?.remove();
          const felt = document.createElement('section');
          felt.className = 'table-surface';
          document.querySelector('.table-page')!.append(felt);
        },
        Math.max(0, deadline + 100 - Date.now())
      );
    }, startedAt + budgetMs);
    await expect(waitForInitialTableReadiness(page, startedAt, budgetMs)).rejects.toThrow(
      'navigation deadline'
    );
    // The UI really becomes ready, but the readback allowance cannot turn its
    // late transition into a pass or grant it another navigation budget.
    await expect(page.locator('.table-surface')).toBeVisible();
    await expect(page.getByTestId('table-connection-banner')).toHaveCount(0);
  });
}
