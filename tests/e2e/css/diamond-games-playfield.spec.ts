import { test, expect, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
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
/** Super (4), the board every half-the-stake floor is carried by: an ordinary
 *  entry and a Super award that did not take the add-on are both dealt here. */
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
/** Super Double (6), the only board whose lowest slot carries the two thirds a
 *  Super award with the Double Diamonds add-on paid. */
const SUPER_DOUBLE_SLOTS = [
  '20x',
  '20x',
  '10x',
  '1.7x',
  '0.8x',
  '0.75x',
  '0.75x',
  '0.73x',
  '0.72x',
  '0.73x',
  '0.75x',
  '0.75x',
  '0.8x',
  '1.7x',
  '10x',
  '20x',
  '20x',
];

/**
 * THE ONE ROAD, BY STREET (contract 4, 2026-09-21). Donkey Cross deals the
 * twelve-street `road` ladder, 0.80x to 20.00x, so every street sits inside
 * every award's cover and the first street is certain. The old risk ladders,
 * and the 1.10x first street this list used to begin with, stay readable for
 * sealed rounds and can no longer be dealt, and there is no difficulty to
 * choose. Read from fn_choice_ladder_v4 and printed by streetMultiplier, which
 * always gives two decimals so the strip's digits hold still.
 */
const ROAD_STREETS = [
  '0.80x',
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
    // The player chooses the drop value (Dan 2026-09-21, R6): the selector
    // offers every listed value that splits 100 diamonds into 1 to 100 drops,
    // the preview's own choice of 10 is the one pressed, and the total line
    // reads drops x value = entry.
    await expect(page.getByRole('button', { name: /Diamonds? Per Drop/ })).toHaveCount(9);
    await expect(
      page.getByRole('button', { name: '10 Diamonds Per Drop, 10 Drops', pressed: true })
    ).toBeVisible();
    await expect(page.getByText('10 Drops × 10 Diamonds = 100 Diamonds')).toBeVisible();
    const payoutLabels = page.getByRole('list', { name: 'Plinko Payout Slots' }).locator('strong');
    await expect(payoutLabels).toHaveCount(17);
    await expect(payoutLabels).toHaveText(SUPER_SLOTS);
    await bucketLegendReads(page.getByRole('list', { name: 'Plinko Payout Slots' }), SUPER_SLOTS);
    await page.getByRole('button', { name: 'crossing', exact: true }).click();
    await streetStripReads(page.getByRole('list', { name: 'Streets And Their Multipliers' }));
    await page.getByRole('button', { name: 'Preview Safe Crossing', exact: true }).click();
    await expect(page.getByText('Safe On Street 1 · Your Move')).toBeVisible();
    await page.getByRole('button', { name: 'Preview Collision', exact: true }).click();
    // One name for this outcome, on the scene as on the receipt and the row.
    await expect(page.getByText(/^Hit At Street \d+ · Guarantee Paid$/)).toBeVisible();
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
  test(`Every Diamond surface fits a 375px phone on the ${superGame ? 'Super Double' : 'Super'} table`, async ({
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
    // CONTRACT 4. 100 simulated diamonds is one chip. An ordinary game pays for
    // its whole stake and keeps HALF of it. A Super award with the Double
    // Diamonds add-on is a 300 diamond stake the player paid 200 for, and keeps
    // those 200 - two thirds - which is why it is dealt the only board whose
    // lowest slot carries them.
    const guaranteed = superGame ? '2.00 Chips' : '0.50 Chips';
    for (const game of GAMES) {
      await page.goto(
        `http://diamond-test.local/diamond-test.html?game=${game}${superGame ? '&super=1&double=1' : ''}`
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
            ? `${SUPER_TITLES[game]} Pays At Least ${guaranteed}, What You Paid For It, Whatever Happens.`
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
        // THE BOARD FOLLOWS THE FLOOR, NOT THE BOOST (contract 4). Every
        // half-the-stake floor is carried by Super (4); only the two thirds a
        // Super award with the add-on paid needs Super Double (6). The Diamond
        // board (5) closed on 2026-09-21 and no stake reaches it any more.
        await expect(
          page.getByText(superGame ? 'On The Super Double Table' : 'On The Super Table')
        ).toBeVisible();
        const legend = page.getByRole('list', { name: 'Plinko Payout Slots' });
        await sits(legend, 'the Plinko bucket legend');
        await bucketLegendReads(legend, superGame ? SUPER_DOUBLE_SLOTS : SUPER_SLOTS);
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
        // THE FIRST RUNG IS NEVER A GAIN UNDER CONTRACT 4, AND THAT IS THE
        // POINT OF IT. The first tile is dealt around the player's own pick, so
        // it is always a gem - and a certain rung is worth exactly the edge:
        // prize(1) = 0.80 of the stake, whatever the floor. The edge is charged
        // once, so every later rung of the nineteen-pick ladder returns four
        // fifths in expectation with the guarantee funded inside it:
        // prize(p) = floor + (4·bet - 5·floor)/5 · C(24,p-1)/C(18,p-1).
        // An ordinary 1.00 stake therefore opens at 0.80 - twenty cents SHORT -
        // and a Super award with the add-on, a 3.00 stake it paid 2.00 for,
        // opens at 2.40, sixty cents short. A readout that printed a plus there
        // would be lying to the player about a tile that loses ground, which is
        // exactly why signedChips carries a minus and the stylesheet inks
        // data-sign="loss". Both figures are transcribed from the rule above
        // rather than recomputed with minePrizeV4, so the two disagreeing is
        // something this spec can still see.
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
          superGame ? '-0.60 Chips' : '-0.20 Chips'
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
        // Nobody chooses a board, so there is no payout range to select: the
        // stake's FLOOR chooses it, and without the Double Diamonds add-on both
        // an ordinary stake and a Super one keep half, so both are dealt Super
        // (4). The board is named on the glass, and its seventeen slots are
        // that board's, printed before the first drop.
        await expect(page.getByLabel('Payout Range')).toHaveCount(0);
        await expect(page.getByText('On The Super Table')).toBeVisible();
        await expect(
          page.getByRole('list', { name: 'Plinko Payout Slots' }).locator('strong')
        ).toHaveText(SUPER_SLOTS);
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

/**
 * THE PLATE IS STILL THERE ON THE NEXT STREET (2026-09-22).
 *
 * Both plates took the NATIVE disabled attribute while a move was in flight,
 * and the HTML focus-fixup rule moves focus off an element that becomes
 * disabled: it lands on <body>. A keyboard or switch-control player pressed
 * Cross, lost the plate, and had to Tab back past the back link, the tab strip
 * and the header - on every one of twelve streets. This plays a crossing with
 * the Tab key used ONCE, to arrive; everything after it is Enter on whatever
 * the browser says has focus, so the spec fails the moment the plate stops
 * being that thing.
 */
test('Donkey Cross crosses street after street on the keyboard alone', async ({ page }) => {
  const { diamondTestFixture } = await import('../helpers/diamond-test-fixture.mjs');
  const bundle = await diamondTestFixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
  );
  // A sealed road of zero survives every street, so the round reaches street
  // three however the scene is compiled on this host.
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'getRandomValues', {
      value: (a: Uint32Array | Uint16Array) => {
        a.fill(0);
        return a;
      },
    });
  });
  await page.goto('http://diamond-test.local/diamond-test.html?game=crossing');
  await page.addStyleTag({ content: bundle.css });
  await page.addScriptTag({ content: bundle.javascript });
  await expect(page.getByRole('button', { name: 'Start Test', exact: true })).toBeVisible();
  /** What the browser says the player is on, and whether it is taking presses. */
  const under = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLButtonElement | null;
      return {
        label: element?.textContent?.trim() ?? '',
        pending: element?.getAttribute('aria-disabled'),
        dimmed: element?.disabled ?? null,
      };
    });
  let tabs = 0;
  while ((await under()).label !== 'Start Test' && tabs < 30) {
    await page.keyboard.press('Tab');
    tabs += 1;
  }
  expect((await under()).label, 'the primary plate is reachable by Tab').toBe('Start Test');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Cross Next Road', exact: true })).toBeVisible();
  const arrived = tabs;
  for (const street of [1, 2, 3]) {
    await page.keyboard.press('Enter');
    // While the donkey is in the road the plate is aria-disabled, never
    // disabled, so it is still what the browser calls the active element.
    await expect
      .poll(async () => (await under()).pending, {
        message: `street ${street} finishes and gives the plate back`,
        timeout: 40_000,
      })
      .toBe(null);
    const plate = await under();
    expect(plate.label, `the plate is still under the player on street ${street}`).toBe(
      'Cross Next Road'
    );
    expect(plate.dimmed).toBe(false);
    await expect(page.getByText(`Safe On Street ${street} · Your Move`)).toBeVisible();
  }
  // Street three, and the Tab key was pressed only to arrive at the plate.
  expect(tabs).toBe(arrived);
  // The controls, which is what aria-disabled changed. (The scene's street
  // strip beside them scrolls horizontally without a tab stop, which axe calls
  // scrollable-region-focusable; that is the strip's own, older, business and
  // adding a tab stop there would sit between the player and this plate.)
  const scan = await new AxeBuilder({ page }).include('[data-game-console] aside').analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
});

/**
 * THE MONEY DECISION IS ON THE GLASS OF THE SMALLEST PHONE (2026-09-22).
 *
 * Donkey Cross and Diamond Mines are one page, and on a 375 x 667 phone that
 * page stacked the back link, the console header, the daily line, a scene
 * sized from the viewport, a sentence the plates already say, and only then
 * the two plates - so in EVERY round the player had to scroll to find Book and
 * Cross. The scene's street strip made it worse: it kept the current street in
 * view with scrollIntoView, which moves the WINDOW when the strip is off
 * screen, so arriving at an open round scrolled the page by itself.
 *
 * Both are measured here on the shipping page inside its real shell, with an
 * open round two moves in, because that is the state a player is in when the
 * decision matters. scrollY is read as well as the plate boxes: a page that
 * only fits because something scrolled it is not a page that fits.
 */
const CHOICE_PHONE_WIDTHS = [320, 375, 390, 414];
for (const game of ['crossing', 'mines'] as const)
  test(`${game === 'mines' ? 'Diamond Mines' : 'Donkey Cross'} keeps both plates on a 375 x 667 phone`, async ({
    page,
  }) => {
    const { diamondChoicePageFixture } = await import('../helpers/diamond-choice-page-fixture.mjs');
    const bundle = await diamondChoicePageFixture();
    const network: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'diamond-choice.local') network.push(url.href);
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`http://diamond-choice.local/choice.html?game=${game}`);
    await page.addStyleTag({ content: bundle.css });
    await page.addScriptTag({ content: bundle.javascript });

    // The round the fixture serves is open and two moves in, so both plates
    // carry an amount and the scene is showing a street or a board.
    const frame = page.locator('[data-game-console]');
    await expect(frame).toBeVisible();
    const plates = frame.locator('> aside button');
    await expect(plates, 'the console offers exactly the two plates').toHaveCount(2);
    // Donkey Cross paints a road and Diamond Mines a board; both are the thing
    // the player must still be able to see while they decide.
    const sceneSelector = game === 'mines' ? '[aria-label="Diamond Mines Board"]' : '[data-phase]';
    await expect(frame.locator(sceneSelector).first()).toBeVisible();

    // THE PAGE DID NOT MOVE ITSELF. The street strip centres its own current
    // chip now; nothing in the scene may scroll the window.
    await expect
      .poll(() => page.evaluate(() => Math.round(scrollY)), {
        message: 'nothing on the page scrolled the window on arrival',
        timeout: 20_000,
      })
      .toBe(0);

    // BOTH PLATES, WHOLE, ON THE 667px GLASS, WITH THE SCENE STILL ON IT.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const shell = document.querySelector('[data-game-console]');
            if (!shell) return ['no console'];
            const scene = shell.querySelector(
              shell.querySelector('[aria-label="Diamond Mines Board"]')
                ? '[aria-label="Diamond Mines Board"]'
                : '[data-phase]'
            );
            const buttons = [...shell.querySelectorAll(':scope > aside button')];
            const wrong: string[] = [];
            if (scrollY !== 0) wrong.push(`the page is scrolled to ${Math.round(scrollY)}`);
            buttons.forEach((button, index) => {
              const box = button.getBoundingClientRect();
              const name = button.textContent?.trim() || `plate ${index + 1}`;
              if (box.width <= 0 || box.height <= 0) wrong.push(`${name} has no size`);
              else if (box.top < -0.5 || box.bottom > innerHeight + 0.5)
                wrong.push(
                  `${name} sits ${Math.round(box.top)}..${Math.round(box.bottom)} of a ${innerHeight}px phone`
                );
            });
            const box = scene?.getBoundingClientRect();
            if (!box) wrong.push('the scene is not on the page');
            else {
              const shown = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
              if (shown < 240) wrong.push(`only ${Math.round(shown)}px of the scene is on screen`);
            }
            return wrong;
          }),
        {
          message: 'both plates and the scene share the 375 x 667 phone without scrolling',
          timeout: 20_000,
        }
      )
      .toEqual([]);

    // Sideways, on every phone this page is played on.
    for (const width of CHOICE_PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 667 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth), {
          message: `${game} adds no horizontal page scroll at ${width}px`,
          timeout: 20_000,
        })
        .toBeLessThanOrEqual(0);
    }
    expect(network).toEqual([]);
  });

/**
 * EVERY INK ON THE SHARED PANEL, AGAINST THE SURFACE IT IS PRINTED ON.
 *
 * The console was repainted in #SmarterCasinoRealism (black glass, a machined
 * chrome edge, blue as energy, gold on Book), and a black-first panel is
 * exactly where contrast quietly goes. It is also where the old plate hid a
 * different failure: a plate whose move was in flight dropped to opacity 0.45,
 * which took its LABEL down with it - a player has to be able to read the thing
 * they cannot press. So every label on the panel is measured here against its
 * own composited background, in every state a plate can be in, on all four
 * games that share it.
 */
/** WCAG relative luminance of one opaque sRGB colour. */
const PANEL_INK_FLOOR = 4.5;
for (const game of GAMES)
  test(`Every ink on the ${TITLES[game]} control panel clears 4.5:1`, async ({ page }) => {
    const { diamondTestFixture } = await import('../helpers/diamond-test-fixture.mjs');
    const bundle = await diamondTestFixture();
    await page.setViewportSize({ width: 393, height: 852 });
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    );
    await page.goto(`http://diamond-test.local/diamond-test.html?game=${game}`);
    await page.addStyleTag({ content: bundle.css });
    await page.addScriptTag({ content: bundle.javascript });
    await expect(page.locator('[data-game-console]')).toBeVisible();

    /**
     * Measured in the page: the ink as painted, over the first opaque surface
     * under it, with every translucent layer in between composited in order.
     * A colour read off one element alone would pass on a plate whose own
     * background is see-through.
     */
    const readContrast = () =>
      page.evaluate(() => {
        type Paint = { r: number; g: number; b: number; a: number };
        const parse = (value: string): Paint | null => {
          const n = value.match(/[\d.]+/g)?.map(Number) ?? [];
          return n.length >= 3 ? { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 } : null;
        };
        const over = (top: Paint, under: number[]) => [
          top.r * top.a + under[0] * (1 - top.a),
          top.g * top.a + under[1] * (1 - top.a),
          top.b * top.a + under[2] * (1 - top.a),
        ];
        /** The opaque colour behind this element, every translucent layer composited. */
        const backdrop = (from: Element | null) => {
          const stack: Paint[] = [];
          for (let node = from; node; node = node.parentElement) {
            const paint = parse(getComputedStyle(node).backgroundColor);
            if (!paint || paint.a === 0) continue;
            stack.push(paint);
            if (paint.a === 1) break;
          }
          let under = [0, 0, 0];
          for (let i = stack.length - 1; i >= 0; i -= 1) under = over(stack[i], under);
          return under;
        };
        /**
         * Every opaque colour a label can find itself sitting on. A flat plate
         * gives one. A plate painted with a gradient gives its colour stops
         * instead, since the gradient covers the padding box: a blend of two
         * colours has a luminance between theirs, so a label that clears the
         * floor on every stop clears it everywhere on that plate. That is how
         * the OLD electric-blue plate is measured honestly, rather than through
         * a background-color it never had.
         */
        const surfaces = (element: Element) => {
          const flat = backdrop(element);
          const image = getComputedStyle(element).backgroundImage;
          if (!image || image === 'none') return [flat];
          const stops = (image.match(/rgba?\([^)]*\)/g) ?? [])
            .map(parse)
            .filter((paint): paint is Paint => !!paint && paint.a > 0)
            .map((paint) => over(paint, flat));
          return stops.length ? stops : [flat];
        };
        const luminance = (rgb: number[]) =>
          rgb
            .map((v) => {
              const c = v / 255;
              return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            })
            .reduce((total, c, i) => total + [0.2126, 0.7152, 0.0722][i] * c, 0);
        const ratio = (ink: number[], plate: number[]) => {
          const [a, b] = [luminance(ink), luminance(plate)].sort((x, y) => y - x);
          return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
        };
        const shell = document.querySelector('[data-game-console]')!;
        const of = (element: Element, what: string) => {
          const style = getComputedStyle(element);
          const ink = parse(style.color)!;
          // A label the browser is fading is measured faded: opacity is what
          // the player's eye gets, whatever the colour says. The plate fades
          // with it, so the ink is composited onto each surface at that alpha.
          const faded = Number(style.opacity);
          const worst = surfaces(element)
            .map((plate) => ratio(over({ ...ink, a: ink.a * faded }, plate), plate))
            .sort((a, b) => a - b)[0];
          return { what, ratio: worst };
        };
        const readings: { what: string; ratio: number }[] = [];
        const title = shell.querySelector('header h1');
        if (title) readings.push(of(title, 'the game name'));
        const status = shell.querySelector('header span');
        if (status?.textContent) readings.push(of(status, 'the status pill'));
        shell.querySelectorAll(':scope > aside > dl dt').forEach((label, i) => {
          readings.push(of(label, `bay ${i + 1} label "${label.textContent}"`));
        });
        shell.querySelectorAll(':scope > aside > dl dd').forEach((value, i) => {
          readings.push(of(value, `bay ${i + 1} value "${value.textContent?.trim()}"`));
        });
        // The console's own two plates, in every state it can put them in. The
        // attributes toggled below are the ones the component itself sets.
        const plates = [...shell.querySelectorAll('[data-plate]')];
        for (const plate of plates) {
          const name = plate.textContent?.trim() || 'a plate';
          const button = plate as HTMLButtonElement;
          const wasDisabled = button.disabled;
          button.disabled = false;
          button.removeAttribute('aria-disabled');
          readings.push(of(plate, `the "${name}" plate, ready`));
          button.setAttribute('aria-disabled', 'true');
          readings.push(of(plate, `the "${name}" plate, its move in flight`));
          button.removeAttribute('aria-disabled');
          button.disabled = true;
          readings.push(of(plate, `the "${name}" plate, nothing to press`));
          button.disabled = wasDisabled;
        }
        return { readings, plates: plates.length };
      });

    const { readings, plates } = await readContrast();
    // Without this the spec could pass by measuring nothing.
    expect(plates, 'both of the console plates were found and measured').toBe(2);
    expect(readings.length, 'the panel has its bays and its header to measure too').toBeGreaterThan(
      8
    );
    expect(
      readings.filter((reading) => reading.ratio < PANEL_INK_FLOOR),
      'every ink on the panel is legible on the surface it is printed on'
    ).toEqual([]);
  });

/**
 * AN iPHONE BROWSER FEELS EVERY PLATE TAP, AND THE PLATES STILL PLAY
 * (2026-09-26). iOS 26.5 left one web haptic: a finger landing on a real
 * <input type="checkbox" switch>. So on an iPhone user agent every live tap
 * target carries an invisible switch over its whole face (TapHaptic). This
 * plays Mines with iPhone taps: the switch covers each live plate and tile
 * exactly, is drawn on no disabled one, and a tap on it still starts the round,
 * picks the tile and books the win.
 */
test('An iPhone browser gets a tap switch on every live Diamond control, and every tap still plays', async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1',
    viewport: { width: 393, height: 852 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    const { diamondTestFixture } = await import('../helpers/diamond-test-fixture.mjs');
    const bundle = await diamondTestFixture();
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    );
    await page.goto('http://diamond-test.local/diamond-test.html?game=mines');
    await page.addStyleTag({ content: bundle.css });
    await page.addScriptTag({ content: bundle.javascript });
    await expect(page.locator('[data-game-console]')).toBeVisible();

    /** Every console plate and tile, with whether it carries a switch that covers it exactly. */
    const survey = () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            // The console's two plates, its pressable bays and the board's tiles.
            '[data-game-console] button[data-plate], [data-game-console] dd > button, [data-game-console] button[aria-label^="Tile "]'
          ),
        ].map((button) => {
          const input = button.querySelector<HTMLInputElement>(':scope > input[data-tap-haptic]');
          const b = button.getBoundingClientRect();
          const i = input?.getBoundingClientRect();
          return {
            name: button.getAttribute('aria-label') || button.textContent?.trim() || '',
            live:
              !button.disabled &&
              button.getAttribute('aria-disabled') !== 'true' &&
              getComputedStyle(button).pointerEvents !== 'none',
            switched: Boolean(input),
            isSwitch: input?.hasAttribute('switch') ?? false,
            invisible: input ? getComputedStyle(input).opacity === '0' : true,
            covers: i
              ? Math.abs(i.left - b.left) < 1.5 &&
                Math.abs(i.top - b.top) < 1.5 &&
                Math.abs(i.width - b.width) < 1.5 &&
                Math.abs(i.height - b.height) < 1.5
              : false,
          };
        })
      );
    const check = async () => {
      const controls = await survey();
      expect(controls.length).toBeGreaterThan(3);
      for (const c of controls) {
        if (c.live) {
          expect(c.switched, `${c.name} is live and has no tap switch`).toBe(true);
          expect(c.isSwitch, `${c.name}'s switch is not a native switch`).toBe(true);
          expect(c.covers, `${c.name}'s switch does not cover it`).toBe(true);
          expect(c.invisible, `${c.name}'s switch is visible`).toBe(true);
        } else expect(c.switched, `${c.name} is not live but carries a tap switch`).toBe(false);
      }
    };
    await check();
    // A tap lands on the switch (the topmost thing under the finger) and still plays.
    await page.getByRole('button', { name: 'Start Test', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Tile 2', exact: true })).toBeEnabled();
    const hit = await page.evaluate(() => {
      const tile = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === 'Tile 2'
      )!;
      const r = tile.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top?.matches('input[data-tap-haptic]') && top.parentElement === tile;
    });
    expect(hit, 'the finger does not land on the tile switch').toBe(true);
    await check();
    await page.getByRole('button', { name: 'Tile 2', exact: true }).tap();
    await expect(page.getByRole('button', { name: /^Tile 2, (Gem|Mine)$/ })).toBeVisible();
    await check();
  } finally {
    await context.close();
  }
});
