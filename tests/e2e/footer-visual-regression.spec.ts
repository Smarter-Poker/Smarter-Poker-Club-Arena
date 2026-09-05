import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const footerCss = readFileSync(join(ROOT, 'src/components/club/ClubBottomNav.module.css'), 'utf8');
const footerArt = readFileSync(
  join(ROOT, 'public/images/club-footer/club-arena-footer-v2.webp')
).toString('base64');

/* READ THE SHIPPED CONSTANT, DO NOT RESTATE IT (2026-09-05).
   This test used to paste `clamp(44px, 13.72vw, 132px)` into its own :root, so
   it went on asserting a value the app had stopped using and could never have
   noticed the difference. It now takes the declaration from the stylesheet the
   app actually loads. */
const globalsCss = readFileSync(join(ROOT, 'src/styles/globals.css'), 'utf8');
const HEIGHT_DECL = /--bottom-nav-height:\s*([^;]+);/.exec(globalsCss)?.[1]?.trim();
if (!HEIGHT_DECL) throw new Error('globals.css no longer declares --bottom-nav-height');

/* The frame inside the approved asset: the rect x=25 y=14 1866x230 of a
   1916x256 canvas. Everything below is derived from this one number. */
const FRAME_ASPECT = 1866 / 230;
const HEIGHT_CEILING = 132;
const HEIGHT_FLOOR = 44;
/* Above this width the ceiling binds, and the bar centres instead of growing.
   Stopping the height without stopping the width IS the distortion. */
const FULL_BLEED_MAX_WIDTH = HEIGHT_CEILING * FRAME_ASPECT;

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1100, height: 720 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

const controls = ['profile', 'players', 'cashier', 'marketplace', 'data', 'stats'];

test.describe('Club Arena footer visual contract', () => {
  test('keeps the complete approved artwork and every control on screen', async ({
    page,
  }, testInfo) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.setContent(`
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <style>
          :root { --bottom-nav-height: ${HEIGHT_DECL}; }
          html, body { margin: 0; min-height: 200vh; background: #07101d; }
          ${footerCss}
        </style>
        </head>
        <body>
        <nav class="bottomNav" aria-label="Club Arena">
          <div class="viewport">
            <div class="artwork">
              <img class="artworkImage" alt="" width="1916" height="256"
                src="data:image/webp;base64,${footerArt}" />
              <ul class="navItems">
                ${controls
                  .map(
                    (key) => `
                  <li class="navCell">
                    <a class="navItem" href="#${key}" data-footer-control="${key}">
                      <span class="visuallyHidden">${key}</span>
                    </a>
                  </li>`
                  )
                  .join('')}
              </ul>
            </div>
          </div>
        </nav>
        </body>
      `);

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

      const nav = page.getByRole('navigation', { name: 'Club Arena' });
      await expect(nav).toBeVisible();
      await expect(nav).toHaveCSS('position', 'fixed');
      await expect(nav).toHaveCSS('transform', 'none');
      await expect(nav).toHaveCSS('transition-duration', '0s');

      const navBox = await nav.boundingBox();
      expect(navBox).not.toBeNull();
      expect(Math.abs(navBox!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(navBox!.y + navBox!.height - viewport.height)).toBeLessThanOrEqual(1);
      expect(navBox!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(navBox!.height).toBeGreaterThanOrEqual(HEIGHT_FLOOR);
      expect(navBox!.height).toBeLessThanOrEqual(HEIGHT_CEILING);
      /* The bar is as tall as the frame's own shape asks for, floored at a
         touch target and capped at the approved desktop height. */
      const expectedHeight = Math.min(
        HEIGHT_CEILING,
        Math.max(HEIGHT_FLOOR, viewport.width / FRAME_ASPECT)
      );
      expect(Math.abs(navBox!.height - expectedHeight)).toBeLessThanOrEqual(1);

      /* THE FRAME KEEPS ITS OWN SHAPE AT EVERY WIDTH (Dan 2026-09-05: the
         footer "IS DISTORTED").
         This block used to assert one thing - that the image overhangs both
         edges - which is only the right assertion while the frame is
         full-bleed. It was true at every viewport because the old constant let
         the box take any aspect the viewport produced and stretched the image
         to fill it: 10.2% too tall on phones, and squashed 12% at 1204px, 28%
         at 1366 and 79% at 1920, where the frame's own shape asks for 237px.
         The contract is now the SHAPE, which is what a visual regression test
         should have been guarding, plus the overhang in the range where
         overhang is what full-bleed means. */
      const artwork = await page.locator('.artwork').boundingBox();
      expect(artwork).not.toBeNull();
      const drawnAspect = artwork!.width / artwork!.height;
      expect(
        Math.abs(drawnAspect / FRAME_ASPECT - 1),
        `frame distorted at ${viewport.width}px: drawn ${drawnAspect.toFixed(3)}:1 ` +
          `against the asset's ${FRAME_ASPECT.toFixed(3)}:1`
      ).toBeLessThan(0.01);

      const artworkBox = await page.locator('.artworkImage').boundingBox();
      expect(artworkBox).not.toBeNull();
      if (viewport.width <= FULL_BLEED_MAX_WIDTH) {
        // Full-bleed: the canvas gutter is pushed off both edges so the frame's
        // chrome reaches x=0 and the far edge.
        expect(artworkBox!.x).toBeLessThan(0);
        expect(artworkBox!.x + artworkBox!.width).toBeGreaterThan(viewport.width);
      } else {
        // Past the ceiling the bar is a centred dock of the approved height.
        // Its rounded end caps become visible for the first time - full-bleed
        // had always cropped them off.
        expect(artwork!.width).toBeLessThanOrEqual(FULL_BLEED_MAX_WIDTH + 1);
        const leftGap = artwork!.x;
        const rightGap = viewport.width - (artwork!.x + artwork!.width);
        expect(Math.abs(leftGap - rightGap), 'the bar is not centred').toBeLessThanOrEqual(1);
        expect(leftGap).toBeGreaterThan(0);
      }

      const links = page.locator('[data-footer-control]');
      await expect(links).toHaveCount(6);
      for (let index = 0; index < 6; index += 1) {
        const box = await links.nth(index).boundingBox();
        expect(
          box,
          `${controls[index]} has no visible hit area at ${viewport.width}px`
        ).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(-1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }

      await testInfo.attach(`club-footer-${viewport.width}x${viewport.height}`, {
        body: await nav.screenshot(),
        contentType: 'image/png',
      });
    }
  });
});
