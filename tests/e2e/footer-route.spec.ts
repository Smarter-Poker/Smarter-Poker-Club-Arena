import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * THE FRAME, NOT THE BOX (2026-09-09). This spec used to prove the footer by
 * asserting that the nav's bounding box reaches the bottom of the viewport. It
 * did, on every run, while the painted frame floated above the edge with the
 * lobby showing through: the transparent safe-area padding inside the box
 * reached the edge and the artwork did not. The box is the wrong thing to
 * measure. A player sees the artwork, so that is what is asserted now, on the
 * default phone and on the narrowest one, where the 44px touch floor is taller
 * than the artwork's own height and used to leave its slack under the frame.
 */
async function expectFrameOnTheBottomEdge(page: Page, nav: Locator) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  /* Where a fixed element at bottom: 0 lands is the bottom edge. The viewport
     height is not: WebKit's mobile emulation reports it 12px taller than the
     layout viewport fixed elements attach to, while Chromium reports them
     equal, so a comparison against the number fails on the one engine an iPad
     actually runs. */
  const edgeBottom = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;pointer-events:none';
    document.body.appendChild(probe);
    const edge = probe.getBoundingClientRect().bottom;
    probe.remove();
    return edge;
  });
  // The diamond overlay is a second image; measure the approved base frame.
  const artwork = nav.locator('img[src$="/club-arena-footer-v2.webp"]').locator('..');
  await expect(artwork).toHaveCount(1);
  const frame = await artwork.boundingBox();
  expect(frame).not.toBeNull();
  expect(
    Math.abs(frame!.y + frame!.height - edgeBottom),
    'strip between the painted frame and the bottom edge'
  ).toBeLessThan(1);

  // The box is still fixed to the edge as well; it just is not the evidence.
  const navBox = await nav.boundingBox();
  expect(navBox).not.toBeNull();
  expect(Math.abs(navBox!.y + navBox!.height - edgeBottom)).toBeLessThan(4);
}

test.describe('Club Arena footer route contract', () => {
  test('the production-safe probe route renders one fixed complete footer', async ({ page }) => {
    await page.goto('dev/footer');
    await expect(page).toHaveURL(/\/hub\/club-arena\/dev\/footer\/?$/);

    const nav = page.getByRole('navigation', { name: 'Poker Arena' });
    await expect(nav).toHaveCount(1);
    await expect(nav).toBeVisible();
    await expect(nav).toHaveCSS('position', 'fixed');
    await expect(nav.locator('[data-footer-control]')).toHaveCount(6);

    await expectFrameOnTheBottomEdge(page, nav);

    const viewport = page.viewportSize();
    for (const control of await nav.locator('[data-footer-control]').all()) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test.describe('on the narrowest phone', () => {
    test.use({ viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true });

    test('the touch floor leaves its slack above the frame, never under it', async ({ page }) => {
      await page.goto('dev/footer');
      const nav = page.getByRole('navigation', { name: 'Poker Arena' });
      await expect(nav).toBeVisible();
      await expectFrameOnTheBottomEdge(page, nav);
    });
  });
});
