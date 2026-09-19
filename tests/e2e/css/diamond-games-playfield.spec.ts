import { test, expect } from '@playwright/test';
import { diamondGamesFixture } from '../helpers/diamond-games-fixture.mjs';
// Each case switches through all three real playfields. The hosted software
// WebGL trace in run35285753046 spent 19.5s opening Plinko and 30.7s changing
// its denomination before compiling Crossing. Keep the full transition and
// every assertion; budget the complete cold-render sequence, not one scene.
test.describe.configure({ mode: 'default', timeout: 180_000 });
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
    const payoutLabels = page.getByRole('list', { name: 'Plinko Payout Slots' }).locator('strong');
    await expect(payoutLabels).toHaveCount(17);
    expect(
      await payoutLabels.evaluateAll((elements) =>
        elements.every((element) => {
          const box = element.getBoundingClientRect();
          return (
            parseFloat(getComputedStyle(element).fontSize) >= 20 &&
            box.left >= 0 &&
            box.right <= innerWidth
          );
        })
      )
    ).toBe(true);
    await page.getByRole('button', { name: 'crossing', exact: true }).click();
    await page.getByRole('button', { name: 'Preview Safe Crossing', exact: true }).click();
    await expect(page.getByText('Street 1 · Next Street Clear')).toBeVisible();
    await page.getByRole('button', { name: 'Preview Collision', exact: true }).click();
    await expect(page.getByText('Collision · Round Over')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });

// The public test entry mounts the shipping scenes with fictional local rounds.
// It must remain independent of authentication, RPCs and real wallet balances.
for (const game of ['plinko', 'crash', 'crossing', 'mines'])
  for (const superGame of [false, true]) {
    test(`Wallet-free ${superGame ? 'Super ' : ''}${game} is playable and holds navigation`, async ({
      page,
    }) => {
      const { diamondTestFixture } = await import('../helpers/diamond-test-fixture.mjs');
      const bundle = await diamondTestFixture();
      await page.setViewportSize({ width: 390, height: 844 });
      const network: string[] = [];
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'diamond-test.local') network.push(url.href);
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      });
      // Fix a safe local outcome so every test reaches a meaningful interaction.
      await page.addInitScript(() => {
        Object.defineProperty(window.crypto, 'getRandomValues', {
          value: (a: Uint32Array | Uint16Array) => {
            a.fill(1);
            return a;
          },
        });
      });
      await page.goto(
        `http://diamond-test.local/diamond-test.html?game=${game}${superGame ? '&super=1' : ''}`
      );
      await page.addStyleTag({ content: bundle.css });
      await page.addScriptTag({ content: bundle.javascript });
      await expect(
        page.getByText(
          'Test Mode. Simulated Diamonds And Chips Only. No Account Or Wallet Connection.'
        )
      ).toBeVisible();
      await page.getByRole('button', { name: 'Start Test', exact: true }).click();
      await page.getByRole('link', { name: 'Super Diamond Mines', exact: true }).click();
      await expect(page.getByText('Finish This Test Round Before Leaving.')).toBeVisible();
      expect(page.url()).toContain(`game=${game}`);
      if (game === 'plinko') await expect(page.getByRole('dialog')).toBeVisible({ timeout: 60000 });
      else {
        if (game === 'mines')
          await page.getByRole('button', { name: 'Tile 2', exact: true }).click();
        if (game === 'crossing')
          await page.getByRole('button', { name: 'Cross Next Road', exact: true }).click();
        await page
          .getByRole('button', {
            name: game === 'crash' ? 'Cash Out' : 'Book The Win',
            exact: true,
          })
          .click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 });
      }
      await expect(page.getByText('Simulated Prize Only. No Wallet Was Changed.')).toBeVisible();
      expect(network).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
    });
  }
