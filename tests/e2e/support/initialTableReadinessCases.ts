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

  test('initial readiness browser refuses early grace and readiness after its original deadline', async ({
    page,
  }) => {
    await page.setContent(`<style>.table-page,.table-surface{width:200px;height:200px}</style>
      <main class="table-page"><section class="table-surface"></section></main>`);
    const startedAt = Date.now();
    const budgetMs = 300;
    await page.evaluate(
      ({ startedAt, deadline }) => {
        setTimeout(
          () => {
            document.querySelector('.table-surface')?.remove();
            const banner = document.createElement('div');
            banner.dataset.testid = 'table-connection-banner';
            banner.textContent = 'Connecting';
            document.querySelector('.table-page')!.append(banner);
          },
          Math.max(0, startedAt + 50 - Date.now())
        );
        setTimeout(
          () => {
            document.querySelector('[data-testid="table-connection-banner"]')?.remove();
            const felt = document.createElement('section');
            felt.className = 'table-surface';
            document.querySelector('.table-page')!.append(felt);
          },
          Math.max(0, deadline + 100 - Date.now())
        );
      },
      { startedAt, deadline: startedAt + budgetMs }
    );
    // Model delayed inspector delivery of wire frames timestamped inside the
    // budget. Its initial grace interval must not count as post-wire readiness.
    const protocolReady = new Promise<{ at: number }[]>((resolve) => {
      setTimeout(
        () => resolve([{ at: startedAt + 150 }]),
        Math.max(0, startedAt + budgetMs + 50 - Date.now())
      );
    });
    await expect(
      waitForInitialTableReadiness(page, startedAt, budgetMs, protocolReady)
    ).rejects.toThrow('navigation deadline');
    await expect(page.locator('.table-surface')).toBeVisible();
    await expect(page.getByTestId('table-connection-banner')).toHaveCount(0);
    expect(await page.evaluate(() => '__spInitialTableReadiness' in window)).toBe(false);
  });
}
