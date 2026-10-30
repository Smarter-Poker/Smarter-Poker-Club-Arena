import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

export function registerLobbyGameSectionsCases(lobbyGameSectionsFixture: () => Promise<string>) {
  for (const width of [375, 393, 1280]) {
    test(`Find Your Game separates two large doors at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
      const css = [
        'src/pages/ClubHomePage.css',
        'src/components/lobby/ClubLobbyCommandTop.css',
        'src/pages/ClubHomeMobilePremium.css',
        'src/components/lobby/LobbyGameSections.css',
      ]
        .map((p) => readFileSync(p, 'utf8'))
        .join('\n');
      await page.route(
        '**/assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/buttons/*.png',
        async (route) => {
          const name = new URL(route.request().url()).pathname.split('/').pop();
          await route.fulfill({
            contentType: 'image/png',
            body: readFileSync(
              `public/assets/club-buttons/game-cards/nlh/spade-nlh-premium-v1/buttons/${name}`
            ),
          });
        }
      );
      await page.setContent(
        `<base href="https://fixture.invalid/"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;700;800&display=swap"><style>body{margin:0;background:#000;color:#e4e7ec}.club-home{width:100%;padding:0}.club-lobby-command-top{display:block!important;min-height:0!important;padding:0!important}${css}</style><div id="root"></div>`
      );
      await page.addScriptTag({ content: await lobbyGameSectionsFixture() });
      await page.evaluate(() => document.fonts.ready);
      const cash = page.getByRole('button', { name: 'Cash Games', exact: true });
      const tournaments = page.getByRole('button', { name: 'Tournaments', exact: true });
      await expect(cash).toHaveAttribute('aria-expanded', 'false');
      await expect(tournaments).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('tablist')).toHaveCount(0);
      for (const button of [cash, tournaments]) {
        const rect = await button.boundingBox();
        expect(rect!.height).toBeGreaterThanOrEqual(60);
        expect(rect!.width).toBeGreaterThanOrEqual(140);
        const text = await button
          .locator('span')
          .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
        expect(text.scroll).toBeLessThanOrEqual(text.width + 1);
      }
      const title = await page.locator('.lobby-controls__title').boundingBox();
      const heading = await page.locator('.lobby-controls__heading').boundingBox();
      expect(Math.abs(title!.x + title!.width / 2 - heading!.x - heading!.width / 2)).toBeLessThan(
        1
      );
      if (width === 393) await page.screenshot({ path: testInfo.outputPath('closed.png') });
      await cash.click();
      await expect(page.getByRole('tab')).toHaveText(['ALL', 'NLH', 'PLO', 'LIMIT']);
      if (width === 393) await page.screenshot({ path: testInfo.outputPath('cash.png') });
      await tournaments.click();
      await expect(page.getByRole('tab')).toHaveText(['MTT', 'SPINS', 'HEADS UP']);
      await expect(cash).toHaveAttribute('aria-expanded', 'false');
      if (width === 393) await page.screenshot({ path: testInfo.outputPath('tournaments.png') });
      await tournaments.click();
      await expect(page.getByRole('tablist')).toHaveCount(0);
    });
  }
}
