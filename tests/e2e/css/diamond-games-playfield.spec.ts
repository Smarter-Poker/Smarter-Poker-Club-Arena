import { test, expect, type Locator } from '@playwright/test';
import { diamondGamesFixture } from '../helpers/diamond-games-fixture.mjs';
// Each case switches through the real playfields. The hosted software WebGL
// trace in run35285753046 spent 19.5s opening Plinko and a further 30.7s on it
// before compiling Crossing. Keep the full transition and every assertion;
// budget the complete cold-render sequence, not one scene.
test.describe.configure({ mode: 'default', timeout: 180_000 });

/**
 * THE TWO LIVE PLINKO BOARDS, BY NAME (2026-09-19).
 *
 * Nobody chooses a board: the stake kind owns it. An ordinary award plays table
 * version 5, named "Diamond"; a Super award plays table version 4, named
 * "Super". Tables 1 ("Steady"), 2 ("Bold") and 3 ("Moonshot") are deactivated
 * server-side, so no new round can be dealt on them and there is no payout
 * range to select. These are the slot multipliers the migration that opened
 * the two boards installed, printed by multiplierLabel. Every Diamond slot
 * pays something (the lowest is 0.08x) and every Super slot pays at least
 * 0.52x, which is above the half-stake that is a Super award's original spin.
 *
 * Transcribed from the migration rather than derived from the client's own
 * mirror on purpose: a spec that recomputes the labels with the same function
 * the page prints them with cannot notice the two disagreeing.
 */
const DIAMOND_SLOTS = [
  '20x',
  '20x',
  '20x',
  '12x',
  '5x',
  '0.6x',
  '0.35x',
  '0.15x',
  '0.08x',
  '0.15x',
  '0.35x',
  '0.6x',
  '5x',
  '12x',
  '20x',
  '20x',
  '20x',
];
const SUPER_SLOTS = [
  '20x',
  '20x',
  '15x',
  '7.5x',
  '1.75x',
  '0.64x',
  '0.56x',
  '0.53x',
  '0.52x',
  '0.53x',
  '0.56x',
  '0.64x',
  '1.75x',
  '7.5x',
  '15x',
  '20x',
  '20x',
];

/**
 * THE ONE ROAD, BY STREET (2026-09-19). Donkey Cross deals the twelve-street
 * `road` ladder, 1.10x to 20.00x, so every street sits inside every award's
 * cover. The old risk ladders stay readable for sealed rounds and can no
 * longer be dealt, and there is no difficulty to choose. Read from
 * fn_choice_ladder and printed by streetMultiplier, which always gives two
 * decimals so the strip's digits hold still.
 */
const ROAD_STREETS = [
  '1.10x',
  '1.45x',
  '1.85x',
  '2.45x',
  '3.15x',
  '4.10x',
  '5.35x',
  '7.00x',
  '9.10x',
  '11.80x',
  '15.40x',
  '20.00x',
];

/**
 * An upgraded game is "Super " plus the title, and nowhere "Upgraded". Spelled
 * out here rather than imported from src/utils/diamondGameTitles.ts so that
 * renaming the source cannot quietly rename what a player reads.
 */
const TITLES = {
  plinko: 'Diamond Plinko',
  crash: 'Diamond Crash',
  crossing: 'Donkey Cross',
  mines: 'Diamond Mines',
} as const;
const SUPER_TITLES = {
  plinko: 'Super Plinko',
  crash: 'Super Crash',
  crossing: 'Super Donkey Cross',
  mines: 'Super Diamond Mines',
} as const;
const GAMES = ['plinko', 'crash', 'crossing', 'mines'] as const;

/** A bucket paying five times the drop or better prints larger (BIG_WIN_CENTS). */
const isBigSlot = (label: string) => Number.parseFloat(label) >= 5;

/**
 * A surface passes when its box is wholly inside the viewport and nothing in
 * it is cut off. Polled, because every scene is sized from a MEASURED
 * container: the first paint uses useMeasuredWidth's fallback and the real
 * width only arrives on the frame after it, so a single read can catch a
 * width that was never on screen.
 */
async function sits(surface: Locator, what: string) {
  await expect(surface, `${what} is on the page`).toBeVisible();
  await expect
    .poll(
      () =>
        surface.evaluate((element) => {
          const box = element.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) return 'has no size';
          if (box.left < -0.5) return `starts ${Math.round(-box.left)}px left of the viewport`;
          if (box.right > innerWidth + 0.5)
            return `runs ${Math.round(box.right - innerWidth)}px past the ${innerWidth}px viewport`;
          if (element.scrollHeight > element.clientHeight + 1)
            return `is cut off: ${element.scrollHeight}px of content in ${element.clientHeight}px`;
          return 'fits';
        }),
      { message: `${what} fits the viewport`, timeout: 20_000 }
    )
    .toBe('fits');
}

/** The legend, bucket by bucket: inside the phone, legible, and colour-scaled. */
async function bucketLegendReads(legend: Locator, slots: readonly string[]) {
  await expect(legend.locator('strong')).toHaveText([...slots]);
  expect(
    await legend.locator('li').evaluateAll((items) =>
      items.map((item) => {
        const label = item.querySelector('strong');
        const box = label ? label.getBoundingClientRect() : new DOMRect(-1, -1, 0, 0);
        const style = getComputedStyle(item);
        const big = item.dataset.big === 'true';
        const heat = Number.parseFloat(style.getPropertyValue('--slot-heat'));
        return {
          inside: box.left >= -0.5 && box.right <= innerWidth + 0.5 && box.width > 0,
          // The 5x-or-better buckets are the loudest thing in the legend; the
          // rest floor at 18px. Both floors are the clamp()s in the stylesheet.
          legible: label
            ? Number.parseFloat(getComputedStyle(label).fontSize) >= (big ? 20 : 18)
            : false,
          tinted: /^#[0-9a-f]{6}$/i.test(style.getPropertyValue('--slot-tint').trim()),
          scaled: heat >= 0 && heat <= 1,
          big,
        };
      })
    )
  ).toEqual(
    slots.map((label) => ({
      inside: true,
      legible: true,
      tinted: true,
      scaled: true,
      big: isBigSlot(label),
    }))
  );
}

/** Every street's multiplier, in a strip pinned inside a scene that hides overflow. */
async function streetStripReads(streets: Locator) {
  await expect(streets.locator('strong')).toHaveText(ROAD_STREETS);
  await sits(streets, 'the Donkey Cross street strip');
  expect(
    await streets.evaluate((element) => {
      const scene = element.parentElement?.getBoundingClientRect();
      const strip = element.getBoundingClientRect();
      return !!scene && strip.top >= scene.top - 0.5 && strip.bottom <= scene.bottom + 0.5;
    }),
    'the street strip is not clipped by the scene around it'
  ).toBe(true);
  expect(
    await streets.locator('li').evaluateAll((items) =>
      items.every((item) => {
        const label = item.querySelector('strong');
        return (
          item.getBoundingClientRect().width >= 48 &&
          !!label &&
          Number.parseFloat(getComputedStyle(label).fontSize) >= 14
        );
      })
    ),
    'every street is wide enough to read'
  ).toBe(true);
}

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
    // Every tile sits inside the glass and stays a thumb wide. POLLED, for the
    // same reason sits() is: a tile the player has just turned over is mid
    // tile-flip, and a rotateY in progress squashes its AXIS-ALIGNED box while
    // the layout square underneath it never moves - tiles 7 and 8 read 34px and
    // 28px of a settled 54px diamond at 320px, for the 0.48s the flip lasts.
    // Reading that frame measures the animation, not the board; at 1280px the
    // same squash happens to stay above 44 and the same read passes, which is
    // the tell. The rule is about the tile a thumb lands on, so it is read with
    // the board at rest. The 44px floor and the viewport bounds are unchanged,
    // and the message names the tile that breaks them.
    await expect
      .poll(
        () =>
          tiles.evaluateAll((elements) =>
            elements
              .map((element, index) => ({ tile: index + 1, box: element.getBoundingClientRect() }))
              .filter(({ box }) => box.left < 0 || box.right > innerWidth || box.width < 44)
              .map(
                ({ tile, box }) =>
                  `Tile ${tile} is ${Math.round(box.width)}px wide from ${Math.round(box.left)} to ${Math.round(box.right)}`
              )
          ),
        {
          message: `every tile sits inside the ${width}px viewport at 44px or wider`,
          timeout: 20_000,
        }
      )
      .toEqual([]);
    await page.getByRole('button', { name: 'plinko', exact: true }).click();
    // Ten drops of a tenth of the entry is the one setting, so there is no drop
    // chooser to press: the total line is stated, never selected.
    await expect(page.getByRole('button', { name: /Diamonds Per Drop/ })).toHaveCount(0);
    await expect(page.getByText('10 Drops × 10 Diamonds = 100 Diamonds')).toBeVisible();
    const payoutLabels = page.getByRole('list', { name: 'Plinko Payout Slots' }).locator('strong');
    await expect(payoutLabels).toHaveCount(17);
    await expect(payoutLabels).toHaveText(DIAMOND_SLOTS);
    await bucketLegendReads(page.getByRole('list', { name: 'Plinko Payout Slots' }), DIAMOND_SLOTS);
    await page.getByRole('button', { name: 'crossing', exact: true }).click();
    await streetStripReads(page.getByRole('list', { name: 'Streets And Their Multipliers' }));
    await page.getByRole('button', { name: 'Preview Safe Crossing', exact: true }).click();
    await expect(page.getByText('Safe On Street 1 · Your Move')).toBeVisible();
    await page.getByRole('button', { name: 'Preview Collision', exact: true }).click();
    await expect(page.getByText('Collision · Round Over')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  });

/**
 * THE PHONE PASS (375px). Mobile-first is the house rule, and every surface
 * the recalibration added lands on the same 375px glass: the Guaranteed bay,
 * the colour-scaled bucket legend, the street strip, the Mines profit readouts
 * and the crash hero. A new surface that overflows a phone is exactly what
 * this file exists to catch, so each one is measured on the page that reaches
 * it - and the two live boards are reached the way a player reaches them, by
 * the kind of award the game is played on, never by a control.
 *
 * Nothing here starts a round: every one of those surfaces is owed BEFORE the
 * first drop, tile or street, which is also what keeps this pass independent
 * of whether the host can compile a WebGL scene at all.
 */
for (const superGame of [false, true])
  test(`Every Diamond surface fits a 375px phone on the ${superGame ? 'Super' : 'Diamond'} table`, async ({
    page,
  }) => {
    const { diamondTestFixture } = await import('../helpers/diamond-test-fixture.mjs');
    const bundle = await diamondTestFixture();
    await page.setViewportSize({ width: 375, height: 812 });
    const network: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'diamond-test.local') network.push(url.href);
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    });
    // 100 simulated diamonds is one chip. An ordinary game keeps a tenth of its
    // stake; a Super award is that spin DOUBLED and keeps half, which is the
    // player's whole original spin back whatever the game does.
    const guaranteed = superGame ? '1.00 Chips' : '0.10 Chips';
    for (const game of GAMES) {
      await page.goto(
        `http://diamond-test.local/diamond-test.html?game=${game}${superGame ? '&super=1' : ''}`
      );
      await page.addStyleTag({ content: bundle.css });
      await page.addScriptTag({ content: bundle.javascript });
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: superGame ? SUPER_TITLES[game] : TITLES[game],
        })
      ).toBeVisible();
      // "Super", never "Upgraded", on any surface of any game.
      await expect(page.getByText('Upgraded')).toHaveCount(0);

      // THE GUARANTEED BAY. Every game states what it pays whatever happens,
      // before it starts, and a Super game's figure is inked as the headline
      // it is.
      const guaranteedBay = page
        .locator('[data-game-console] > aside > dl > div')
        .filter({ hasText: /^Guaranteed/ });
      await expect(guaranteedBay.locator('dd')).toHaveText(guaranteed);
      if (superGame) await expect(guaranteedBay.locator('dd')).toHaveAttribute('data-ink', 'gold');
      else await expect(guaranteedBay.locator('dd')).not.toHaveAttribute('data-ink');
      await sits(guaranteedBay, 'the Guaranteed bay');
      await expect(
        page.getByText(
          superGame
            ? `${SUPER_TITLES[game]} Pays At Least ${guaranteed}, Your Original Spin, Whatever Happens.`
            : `Pays At Least ${guaranteed} On Any Loss.`,
          { exact: true }
        )
      ).toBeVisible();

      if (game === 'plinko') {
        // One board per stake kind and nobody chooses it, so there is neither a
        // payout range to select nor a drop value to press: the board the award
        // owns is named on the glass, and its seventeen buckets are printed in
        // their own colours before the first diamond falls.
        await expect(page.getByLabel('Payout Range')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Diamonds Per Drop/ })).toHaveCount(0);
        await expect(
          page.getByText(superGame ? 'On The Super Table' : 'On The Diamond Table')
        ).toBeVisible();
        const legend = page.getByRole('list', { name: 'Plinko Payout Slots' });
        await sits(legend, 'the Plinko bucket legend');
        await bucketLegendReads(legend, superGame ? SUPER_SLOTS : DIAMOND_SLOTS);
      }

      if (game === 'crossing') {
        const streets = page.getByRole('list', { name: 'Streets And Their Multipliers' });
        await streetStripReads(streets);
        // Each street also prints the chips reaching it pays, so the strip
        // carries twelve multipliers and twelve prizes at 375px.
        await expect(streets.locator('small')).toHaveCount(ROAD_STREETS.length);
      }

      if (game === 'mines') {
        // Before the first tile the board is worth exactly the stake, so the
        // profit starts at nothing and the next tile's figure is what it adds.
        //
        // THE FIRST RUNG IS NOT ALWAYS A GAIN, AND ON A SUPER AWARD IT CANNOT
        // BE. The edge is charged once, so every rung of the nineteen-pick
        // ladder returns four fifths of the stake in expectation, and the
        // guarantee is funded inside that: prize(p) = minimum + (4·bet -
        // 5·minimum)/5 · C(25,p)/C(19,p). An ordinary award guarantees a tenth
        // of its 1.00 stake, and 19 of 25 tiles are safe, so the first tile
        // pays 1.021053 - two cents up. A Super award guarantees HALF of its
        // doubled 2.00 stake, which is the whole original spin back on any
        // loss, and paying for that cover leaves the first rung at 1.789474 -
        // twenty one cents SHORT of the stake, and not level with it again
        // until the second tile (2.052632). A readout that printed a plus
        // there would be lying to the player about a tile that loses ground,
        // which is exactly why signedChips carries a minus and the stylesheet
        // inks data-sign="loss". Both figures are transcribed from the rule
        // above rather than recomputed with minePrize, so the two disagreeing
        // is something this spec can still see.
        const readouts = page
          .locator('[data-game-console] dl')
          .filter({ has: page.locator('dt', { hasText: 'Profit On Next Tile' }) });
        await expect(readouts.locator('dt')).toHaveText([
          'Total Profit (1.00x)',
          'Profit On Next Tile',
        ]);
        await expect(readouts.locator('dd').first()).toHaveText('0.00 Chips');
        await expect(readouts.locator('dd').first()).toHaveAttribute('data-sign', 'gain');
        await expect(readouts.locator('dd').last()).toHaveText(
          superGame ? '-0.21 Chips' : '+0.02 Chips'
        );
        await sits(readouts, 'the Mines profit readouts');
        await expect(page.getByRole('button', { name: /^Tile / })).toHaveCount(25);
        await expect(page.getByText('25 Tiles. Your Next Discovery Awaits.')).toBeVisible();
      }

      if (game === 'crash') {
        // The hero is the figure a tap books: two decimals so the digits hold
        // still, calm at evens, and large enough to read across the room.
        const ticker = page.locator('[data-game-console] [data-heat]');
        await expect(ticker).toHaveText('1.00x');
        await expect(ticker).toHaveAttribute('data-heat', 'calm');
        await expect(ticker).toHaveAttribute('data-phase', 'idle');
        await sits(ticker, 'the Crash ticker');
        await expect
          .poll(() => ticker.evaluate((e) => Number.parseFloat(getComputedStyle(e).fontSize)), {
            message: 'the crash hero is at least its 40px floor',
            timeout: 20_000,
          })
          .toBeGreaterThanOrEqual(40);
      }

      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth), {
          message: `${game} adds no horizontal page scroll at 375px`,
          timeout: 20_000,
        })
        .toBeLessThanOrEqual(0);
    }
    expect(network).toEqual([]);
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
      if (game === 'plinko') {
        // One board per stake kind and nobody chooses it, so there is no payout
        // range to select. The board the award owns is named on the glass, and
        // its seventeen slots are that board's, printed before the first drop.
        await expect(page.getByLabel('Payout Range')).toHaveCount(0);
        await expect(
          page.getByText(superGame ? 'On The Super Table' : 'On The Diamond Table')
        ).toBeVisible();
        await expect(
          page.getByRole('list', { name: 'Plinko Payout Slots' }).locator('strong')
        ).toHaveText(superGame ? SUPER_SLOTS : DIAMOND_SLOTS);
        // TEN DROPS ARE OVER IN ABOUT FIVE SECONDS, AND THE HOLD BELOW IS OWED
        // ONLY WHILE THEY ARE IN THE AIR. Plinko is the one game that ends
        // itself: the batch runs on the scene clock with nothing left to press,
        // and once the last diamond lands the round is settled and the player is
        // free to leave - so a navigation attempt that arrives after it is
        // refused by nothing, correctly. Opening the console alone costs several
        // seconds of WebGL on this board, which is most of that window, so the
        // round is played at the SLOWEST Animation Speed a player may choose
        // (ANIMATION_SPEED_MAX, the one sanctioned control over duration under
        // §10.6) and the refusal is asserted on a round that is genuinely live.
        // Nothing else about the hold is relaxed: the notice, the unchanged URL
        // and the reveal are all still owed.
        await page.addStyleTag({ content: ':root{--animation-speed:3}' });
      }
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
