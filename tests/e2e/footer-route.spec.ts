import { expect, test } from '@playwright/test';

test.describe('Club Arena footer route contract', () => {
  test('the production-safe probe route renders one fixed complete footer', async ({ page }) => {
    await page.goto('dev/footer');
    await expect(page).toHaveURL(/\/hub\/club-arena\/dev\/footer\/?$/);

    const nav = page.getByRole('navigation', { name: 'Club Arena' });
    await expect(nav).toHaveCount(1);
    await expect(nav).toBeVisible();
    await expect(nav).toHaveCSS('position', 'fixed');
    await expect(nav.locator('[data-footer-control]')).toHaveCount(6);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const viewport = page.viewportSize();
    const navBox = await nav.boundingBox();
    expect(viewport).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(Math.abs(navBox!.y + navBox!.height - viewport!.height)).toBeLessThan(4);

    for (const control of await nav.locator('[data-footer-control]').all()) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
