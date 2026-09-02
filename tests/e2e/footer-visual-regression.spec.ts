import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const footerCss = readFileSync(join(ROOT, 'src/components/club/ClubBottomNav.module.css'), 'utf8');
const footerArt = readFileSync(
  join(ROOT, 'public/images/club-footer/club-arena-footer.webp')
).toString('base64');

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
          :root { --bottom-nav-height: clamp(44px, 13.72vw, 132px); }
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
      expect(navBox!.height).toBeGreaterThanOrEqual(44);
      expect(navBox!.height).toBeLessThanOrEqual(132);
      const expectedHeight = Math.min(132, Math.max(44, viewport.width * 0.1372));
      expect(Math.abs(navBox!.height - expectedHeight)).toBeLessThanOrEqual(1);

      const artworkBox = await page.locator('.artworkImage').boundingBox();
      expect(artworkBox).not.toBeNull();
      expect(artworkBox!.x).toBeLessThan(0);
      expect(artworkBox!.x + artworkBox!.width).toBeGreaterThan(viewport.width);

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
