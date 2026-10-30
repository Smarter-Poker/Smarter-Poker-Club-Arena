import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

export function registerLobbyGameSectionsCases(lobbyGameSectionsFixture: () => Promise<string>) {
  for (const width of [375, 393, 1280]) {
    test(`Find Your Game separates two large doors at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 850 });
      // ClubHomePage imports LobbyGameSections before its own stylesheets.
      // The component's CSS must precede the page, command top and mobile pass,
      // as it does in the production bundle; loading it last hides overrides.
      const css = [
        'src/components/lobby/LobbyGameSections.css',
        'src/pages/ClubHomePage.css',
        'src/components/lobby/ClubLobbyCommandTop.css',
        'src/pages/ClubHomeMobilePremium.css',
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
      await page.route('**/assets/club-buttons/club-nav-shell-d45f56465bad.png', (route) =>
        route.fulfill({
          contentType: 'image/png',
          body: readFileSync('public/assets/club-buttons/club-nav-shell-d45f56465bad.png'),
        })
      );
      // Production self-hosts this face; the isolated document has no app origin
      // and must not depend on Google Fonts or cross-origin font response headers.
      const fontCSSURL = 'https://smarter.poker/hub/club-arena/fonts/fonts.css';
      const fontCSSResponse = await page.request.get(fontCSSURL);
      expect(fontCSSResponse.ok()).toBe(true);
      const fontCSS = await fontCSSResponse.text();
      const face = fontCSS
        .match(/@font-face\s*\{[^}]*\}/g)
        ?.find(
          (rule) =>
            rule.includes("font-family: 'Roboto Condensed'") &&
            /font-weight:\s*800\s*;/.test(rule) &&
            /unicode-range:\s*U\+0000-00FF/.test(rule)
        );
      expect(face, 'Published Roboto Condensed 800 Latin face').toBeTruthy();
      const source = face!.match(/url\(([^)]+)\)/);
      expect(source, 'Published font URL').toBeTruthy();
      const fontResponse = await page.request.get(new URL(source![1], fontCSSURL).href);
      expect(fontResponse.ok()).toBe(true);
      const fontBytes = await fontResponse.body();
      const fixtureFace = face!.replace(
        source![0],
        `url(data:font/woff2;base64,${fontBytes.toString('base64')})`
      );
      await page.setContent(
        `<base href="https://fixture.invalid/"><style>body{margin:0;background:#000;color:#e4e7ec}.club-home{width:100%;padding:0}.club-lobby-command-top{display:block!important;min-height:0!important;padding:0!important}${fixtureFace}${css}</style><div id="root"></div>`
      );
      await page.addScriptTag({ content: await lobbyGameSectionsFixture() });
      const cash = page.getByRole('button', { name: 'Cash Games', exact: true });
      const tournaments = page.getByRole('button', { name: 'Tournaments', exact: true });
      await expect(cash).toHaveAttribute('aria-expanded', 'false');
      await expect(tournaments).toHaveAttribute('aria-expanded', 'false');
      // Mount first: fonts.ready alone can resolve before concurrent React
      // rendering introduces the labels and therefore before this face is used.
      const loadedFonts = await page.evaluate(async () => {
        const loaded = await document.fonts.load('800 16px "Roboto Condensed"', 'Tournaments');
        await document.fonts.ready;
        return loaded.length;
      });
      expect(loadedFonts, 'The published label face must load before geometry').toBeGreaterThan(0);
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
      await expect(page.getByRole('tab')).toHaveText(['MTT', 'SPINS', "SIT N GO'S", 'SATELLITES']);
      await expect(cash).toHaveAttribute('aria-expanded', 'false');
      if (width === 393) await page.screenshot({ path: testInfo.outputPath('tournaments.png') });
      await tournaments.click();
      await expect(page.getByRole('tablist')).toHaveCount(0);
    });
  }
}
