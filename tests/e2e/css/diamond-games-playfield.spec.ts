import { test, expect } from '@playwright/test';
import { diamondGamesFixture } from '../helpers/diamond-games-fixture.mjs';
// Each case opens real Three.js scenes. Hosted software WebGL took 24s for
// Plinko's first paint alone in run35263085862; avoid competing shader compiles
// and allow all three scenes to complete without relaxing any assertion.
test.describe.configure({ mode: 'default', timeout: 90_000 });
for (const width of [320, 390, 1280])
  test(`Diamond playfields and reveals remain reachable at ${width}px`, async ({ page }) => {
    const bundle = await diamondGamesFixture();
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#060d18;font-family:Arial}nav{padding:8px}nav button{min-height:40px}</style><div id="root"></div>'
    );
    await page.addStyleTag({ content: bundle.css });
    await page.addScriptTag({ content: bundle.javascript });
    const tiles = page.getByRole('button', { name: /^Tile / });
    await expect(tiles).toHaveCount(25);
    await page.getByRole('button', { name: 'Tile 7', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Tile 7, Gem' })).toBeDisabled();
    await page.getByRole('button', { name: 'Tile 8', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Tile 8, Gem' })).toBeDisabled();
    expect(
      await tiles.evaluateAll((elements) =>
        elements.every((e) => {
          const r = e.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.width >= 44;
        })
      )
    ).toBe(true);
    await page.getByRole('button', { name: 'plinko', exact: true }).click();
    await page.getByRole('button', { name: '4 Diamonds Per Drop, 25 Drops' }).click();
    await expect(page.getByText('25 Drops × 4 Diamonds = 100 Diamonds')).toBeVisible();
    await page.getByRole('button', { name: 'crossing', exact: true }).click();
    await page.getByRole('button', { name: 'Preview Safe Crossing', exact: true }).click();
    await expect(page.getByText('Street 1 · Next Street Clear')).toBeVisible();
    await page.getByRole('button', { name: 'Preview Collision', exact: true }).click();
    await expect(page.getByText('Collision · No Prize')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });
