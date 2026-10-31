import { AVATAR_CROWN_TOP } from '../../src/components/table/avatarCrownBounds';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERYTHING ON THE FELT IS THE SAME FRACTION OF IT, ON EVERY DEVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "WHY DOESN'T THE LIVE TABLE SCALE DIFFERENTLY PER DEVICE? MY
 * BUTTONS AND CARDS LOOK THE SAME NO MATTER IF I'M ON A PHONE, OR A TABLET."
 *
 * They did. Cards, avatars and seats were sized by a px ladder — 60 / 57 / 51 /
 * 45 at base / 640 / 480 / 380 — and THE LADDER STOPPED AT 640px, so a 768px
 * tablet, a 1024px iPad and a 1920px desktop all drew the identical 60px card.
 * Measured, the card ranged from 9.0% of the felt on an iPad Pro to 62.5% on a
 * phone in landscape.
 *
 * ─── WHY THIS FILE EXISTS AND A UNIT TEST DOES NOT REPLACE IT ──────────────
 *
 * The unit tests assert the SHAPE of the CSS: one declaration, derived height,
 * a var() that names --table-w. All true, all necessary, and none of them can
 * tell you what a tablet renders. The felt's width resolves through six custom
 * properties, four breakpoints, an aspect-ratio, a max-height clamp and a
 * container's percentage width. Only a browser knows the answer.
 *
 * So this measures, at thirteen real devices, and asserts the property that was
 * actually broken: THE FRACTION IS FLAT. Not "the card is 68px on an iPad" —
 * that is a number that will change the next time the height budget moves, and
 * pinning it would make this file a chore rather than a guard. The invariant is
 * that every device agrees on the RATIO.
 *
 * ─── WHAT MAKES IT FAIL ────────────────────────────────────────────────────
 *
 * Reintroducing a breakpoint. Any `@media` rule that sets a card, avatar or
 * seat size makes two devices disagree about the ratio, and the failure message
 * names both devices and both percentages. That is the whole point: the bug
 * this replaces was invisible for as long as nobody happened to open a tablet.
 *
 * It needs no dev server and no login — it renders the real stylesheets with
 * page.setContent — and runs in about a second. See the note in ci.yml about
 * hero-card-row.spec.ts, which sat in NO job for 39 commits: if you add a spec
 * here, add it to the `css-beats-e2e` command too or it cannot fail anything.
 */

import {
  certifyMobileLiveTableLayout,
  readMobileTableLayout,
} from './support/mobileLiveTableLayout';
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import {
  buildCss,
  buildHtml,
  DEVICES,
  PROBE,
  CALIBRATION,
  measureAll,
  applyInsets,
} from './support/feltHarness.mjs';

// Approved table artwork used by the occupied-ring renders, bundled so these
// layout checks never depend on production being reachable or unchanged.
// Sources: smarter.poker/avatars/table/vip_wolf@2x.webp and the Supabase
// assets/buttons/black/icon-*.webp objects, copied byte for byte 2026-10-21.
const tableArtFixture = (name: string) =>
  resolve(process.cwd(), 'tests/e2e/fixtures/table-art', name);

/* process.cwd(), not __dirname: importing the .mjs harness puts this file in ES
   module scope, where __dirname does not exist. hero-card-row.spec.ts resolves
   the same way, and Playwright runs from the project root. */
const ROOT = resolve(process.cwd());
const css = buildCss(ROOT);

/** Declared once on `.seat` in SeatSlot.css. Restated here so a change to either
 *  fails against this file's arithmetic rather than silently re-baselining it. */
const CARD_FRACTION = 0.139;
const AVATAR_FRACTION = 0.158;
/** Legibility floors, the one place a proportion is deliberately overruled.
 *
 *  2026-08-28: CARD_FLOOR 44 -> 50. Dan, from a phone that evening: "the size of
 *  the cards in NLH have regressed back to the smaller sized hero cards." 44px
 *  was not a neutral safety net — it is the exact pre-#1571 hold'em card he had
 *  rejected that morning, so wherever it bound (iPhone SE, both landscapes, a
 *  1280x800 laptop, and the first frame of every table, where --table-w is still
 *  the 320px initial guess) the fix he had just signed off was silently undone.
 *
 *  50 rather than 51 on purpose: 51 is the rung he approved, and the canonical
 *  iPhone 12/13/14 felt yields 366 x 0.139 = 50.87 from the fraction. A floor at
 *  51 would bind there by 0.13px, and `floorBinds` below would then excuse the
 *  most-reviewed device in the estate from every flatness assertion in this
 *  file. The crossover belongs just UNDER the canonical answer, not on top of
 *  it. See the note on --sp-card2-w. */
const CARD_FLOOR = 50;
const AVATAR_FLOOR = 50;

/** A device whose felt is small enough that a floor binds cannot be compared on
 *  ratio — the floor is doing its job, which is to STOP the proportion. */
const floorBinds = (feltW: number) => feltW * CARD_FRACTION < CARD_FLOOR;

test.describe('the felt harness measures the real cascade', () => {
  /* Everything below is only worth reading if the harness is faithful. This is
     the one production figure this repo has written down, and reproducing it is
     what separates a real measurement from a plausible-looking one. */
  test('reproduces the recorded production measurement exactly', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: CALIBRATION.viewport });
    // The recorded case predates the constant reserve and is NOT embedded.
    await page.setContent(buildHtml(css).replace(' table-page--embedded', ''));
    await page.addStyleTag({ content: CALIBRATION.forceBottom });
    const { feltW, feltH } = await page.evaluate(PROBE);
    await browser.close();

    expect(feltW, 'harness felt width drifted from the recorded 606.2').toBeCloseTo(
      CALIBRATION.expect.w,
      0
    );
    expect(feltH, 'harness felt height drifted from the recorded 1002').toBeCloseTo(
      CALIBRATION.expect.h,
      0
    );
  });
});

test.describe('every device gets the same proportions', () => {
  test('the card is one fraction of the felt, everywhere', async ({ page }) => {
    const rows = await measureAll(page, css);
    expect(rows.length, 'the device list emptied').toBe(DEVICES.length);

    const offenders: string[] = [];
    for (const r of rows) {
      const pct = r.card2W / r.feltW;
      if (floorBinds(r.feltW)) {
        // Below the floor's crossover the card must BE the floor, not less.
        if (Math.abs(r.card2W - CARD_FLOOR) > 1) {
          offenders.push(
            `${r.device} (${r.vp}): felt ${r.feltW}px is below the floor crossover, ` +
              `so the card must be the ${CARD_FLOOR}px floor, but it is ${r.card2W}px`
          );
        }
        continue;
      }
      if (Math.abs(pct - CARD_FRACTION) > 0.005) {
        offenders.push(
          `${r.device} (${r.vp}): card is ${r.card2W}px on a ${r.feltW}px felt = ` +
            `${(pct * 100).toFixed(1)}%, expected ${(CARD_FRACTION * 100).toFixed(1)}%`
        );
      }
    }

    expect(
      offenders,
      'a device disagrees about how big a card is relative to its table. That is a ' +
        'breakpoint someone reintroduced: a ladder has steps, so every device inside ' +
        'a step is the same size by construction, which is the bug this replaced.'
    ).toEqual([]);
  });

  test('the avatar slot is one fraction of the felt, everywhere', async ({ page }) => {
    const rows = await measureAll(page, css);
    const offenders: string[] = [];
    for (const r of rows) {
      if (r.feltW * AVATAR_FRACTION < AVATAR_FLOOR) continue; // floor is binding
      const pct = r.avatar / r.feltW;
      if (Math.abs(pct - AVATAR_FRACTION) > 0.005) {
        offenders.push(
          `${r.device} (${r.vp}): avatar is ${r.avatar}px on a ${r.feltW}px felt = ` +
            `${(pct * 100).toFixed(1)}%, expected ${(AVATAR_FRACTION * 100).toFixed(1)}%`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the HERO slot scales too, and stays 1.3333x the villain', async ({ page }) => {
    /* ADDED 2026-08-28 after this file missed a live regression it existed to
       catch. It rendered only `.seat`, the villain slot, so three
       `@media ... .seat.seat--hero { --seat-avatar-size: calc(66|58|52px * …)
       !important }` rungs survived the conversion untouched: below 641px the
       hero — the one seat the player is looking at — was still on the px ladder
       while every villain beside it was proportional.

       It was not a cosmetic miss either. --seat-avatar-size feeds --vh-card-h
       and thence --vh-card-w, so a rung on the hero puts every VILLAIN HOLE
       CARD back on a ladder indirectly, after --sp-card2-w had been converted.

       Two assertions, because either alone can be satisfied while the bug is
       present: the hero must hold the 1.3333 ratio to the villain (a rung that
       pinned both equally would pass a ratio check), and it must itself be a
       fraction of the felt (a rung that scaled both together would pass that). */
    const rows = await measureAll(page, css);
    const HERO_RATIO = 1.3333;

    const offenders: string[] = [];
    for (const r of rows) {
      const ratio = r.heroAvatar / r.avatar;
      if (Math.abs(ratio - HERO_RATIO) > 0.02) {
        offenders.push(
          `${r.device} (${r.vp}): hero avatar ${r.heroAvatar}px vs villain ${r.avatar}px = ` +
            `x${ratio.toFixed(3)}, expected x${HERO_RATIO}`
        );
      }
      // ...and the hero must ride the felt, not a rung.
      if (r.feltW * AVATAR_FRACTION * HERO_RATIO < AVATAR_FLOOR * HERO_RATIO) continue;
      const pct = r.heroAvatar / r.feltW;
      const want = AVATAR_FRACTION * HERO_RATIO;
      if (Math.abs(pct - want) > 0.006) {
        offenders.push(
          `${r.device} (${r.vp}): hero avatar is ${r.heroAvatar}px on a ${r.feltW}px felt = ` +
            `${(pct * 100).toFixed(1)}%, expected ${(want * 100).toFixed(1)}%`
        );
      }
    }
    expect(
      offenders,
      'the hero slot is on a different sizing rule from the villains. Check for an ' +
        '@media rule on .seat--hero — that is where three !important rungs hid through ' +
        'an entire conversion.'
    ).toEqual([]);
  });

  test("the hero's stack plate is never covered by the action bar", async ({ page }) => {
    /* THE ONE DEPENDENCY SeatSlot.css NAMES BY ITSELF. The hero's wrapper lift
       was retired to 0 ("Zero, not some smaller lift"), which puts the avatar's
       CENTRE on the scaler's bottom edge and hangs half the hero block below the
       felt. That file's own note ends:

         "THE ONE THING IT DEPENDS ON: half the hero block now hangs below the
          scaler, so --sp-hero-clear ... has to be at least that half ... Below
          that the plate carrying the stack goes back under the bar, which is
          the bug the lift was added for in the first place."

       Every term in that sentence became a different proportional expression on
       2026-08-28 — the avatar is a fraction of the felt, the bar is a clamp on
       the viewport, the reserve is a constant — so the relationship that used to
       be checkable by hand is now only knowable from layout. Hence a measurement
       rather than arithmetic.

       Measured at the time of writing: clear on all thirteen devices, but on
       five of them the block hangs FURTHER below the felt than the reserve
       states (86.8px against 60px on an iPad Pro 12.9). It clears on spare
       vertical space rather than on the reserve, which is exactly the kind of
       margin that disappears silently. This is what notices. */
    const rows = await measureAll(page, css);

    const covered = rows
      .filter((r) => r.heroPlateBottom > r.barTop)
      .map(
        (r) =>
          `${r.device} (${r.vp}): plate bottom ${r.heroPlateBottom}px is below the bar top ` +
          `${r.barTop}px — the player cannot see their own stack`
      );

    expect(
      covered,
      'the hero plate is under the action bar. Either --sp-hero-clear no longer ' +
        'covers the overhang, or the hero block grew: both are proportional now and ' +
        'the reserve is a constant, so they can drift apart without anyone typing a ' +
        'new number.'
    ).toEqual([]);
  });

  test('the bottom reserve holds the hero block on every phone, with nothing spare', async ({
    page,
  }) => {
    /* Dan 2026-08-29: "table sizing is off because you are leaving too much
       room at the bottom for the action bar."

       The strip between the felt's bottom edge and the action bar's top edge
       IS --sp-hero-clear, exactly, on every device: --sp-table-bottom is
       (action-reserve + hero-clear) and the bar occupies the action-reserve.
       What that strip has to hold is the part of the hero seat that hangs
       below the felt, because the hero's avatar CENTRE sits on the scaler's
       bottom edge (SeatSlot.css, "Zero, not some smaller lift").

       This pins the reserve from BOTH sides on the devices Dan reviews from,
       which is what makes it a guard rather than a floor:

         too small  the hero's plate goes under the bar - the 2026-08-23 bug,
                    and the reason the reserve exists at all;
         too large  the felt is shorter than the screen allows for no reason,
                    which is the report that produced this beat.

       Phones only. The tablets in DEVICES legitimately overhang PAST this
       reserve (an iPad Pro 12.9 hero block is 86.8px against a 62px strip) -
       they have vertical space to spare and clear it on the bar's own height,
       so holding them to the phone's rule would forbid a layout that is fine.
       The hero-plate-vs-bar beat above is what covers them. */
    const PHONES = [
      'iPhone SE',
      'iPhone 12/13/14',
      'iPhone 14 Pro Max',
      'iPhone 12/13/14 (real)',
      'iPhone 14 Pro Max (real)',
    ];
    const SLACK_BUDGET = 8; // px of reserve a phone may carry above its need

    const rows = (await measureAll(page, css)).filter((r) => PHONES.includes(r.device));
    expect(rows.length, 'the phone rows vanished from DEVICES').toBe(PHONES.length);

    const tooTight: string[] = [];
    const tooLoose: string[] = [];
    for (const r of rows) {
      const spare = r.heroClear - r.heroOverhang;
      if (spare < 0) {
        tooTight.push(
          `${r.device} (${r.vp}): the hero block hangs ${r.heroOverhang}px below the felt but ` +
            `the reserve is only ${r.heroClear}px - the plate goes under the action bar`
        );
      } else if (spare > SLACK_BUDGET) {
        tooLoose.push(
          `${r.device} (${r.vp}): reserve ${r.heroClear}px against a ${r.heroOverhang}px block = ` +
            `${spare.toFixed(1)}px of felt given away for nothing`
        );
      }
    }

    expect(
      tooTight,
      'the bottom reserve no longer holds the hero block. Do not shrink --sp-hero-clear to ' +
        'satisfy the other half of this beat - shrink what hangs below the felt, or take the ' +
        'pixels from the action bar.'
    ).toEqual([]);
    expect(
      tooLoose,
      `--sp-hero-clear is carrying more than ${SLACK_BUDGET}px of nothing on a phone, which is ` +
        'felt length the player can see missing. If the block genuinely shrank, lower the ' +
        'reserve in the same commit and say so.'
    ).toEqual([]);
  });

  test('the widest hole-card row keeps a constant share of the felt', async ({ page }) => {
    /* The fit guarantee, expressed the way it is now true. Every worked example
       in SeatSlot.css used to be a hand-checked sum at four fixed widths — the
       two-card row inside the PLO4 row inside the felt — re-derived whenever
       anything moved. Both sides are fractions of the same felt now, so a ratio
       that holds at one size holds at all of them, and THAT is what to pin.
       If this drifts, a hand size has stopped fitting on some device. */
    const rows = (await measureAll(page, css)).filter((r) => !floorBinds(r.feltW));
    const shares = rows.map((r) => r.plo4Row / r.feltW);
    const min = Math.min(...shares);
    const max = Math.max(...shares);

    expect(
      max - min,
      `PLO4 row share ranges ${(min * 100).toFixed(1)}%..${(max * 100).toFixed(1)}% across ` +
        rows.map((r) => r.device).join(', ')
    ).toBeLessThan(0.005);

    // And it must actually fit, with room for the seat plate beside it.
    expect(max, 'the widest hole-card row takes more than half the felt').toBeLessThan(0.5);
  });

  test('no device is left on a rung: a bigger felt draws a bigger card', async ({ page }) => {
    /* The regression stated as an ordering rather than a ratio, because this is
       the form the original bug took: a 768px tablet and a 1920px desktop drew
       the IDENTICAL 60px card while their felts differed by 40%. Two devices
       with materially different felts must never land on the same card size. */
    const rows = (await measureAll(page, css)).filter((r) => !floorBinds(r.feltW));
    const offenders: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        const feltGap = Math.abs(a.feltW - b.feltW);
        if (feltGap < 40) continue; // same-sized felts SHOULD draw the same card
        if (Math.abs(a.card2W - b.card2W) < 1) {
          offenders.push(
            `${a.device} (felt ${a.feltW}) and ${b.device} (felt ${b.feltW}) both draw a ` +
              `${a.card2W}px card despite ${feltGap.toFixed(0)}px of felt between them`
          );
        }
      }
    }
    expect(offenders, 'two different-sized tables drew the same card — that is a rung').toEqual([]);
  });

  test('portrait phones reserve 18 percent for outboard players (owner correction October 21)', async ({
    page,
  }) => {
    /* SHIPPED BUG, twice. #950 removed the 4px side gutters "per Dan --
       edge-to-edge felt" and wrote 375x619.8 into the comment -- but deleting
       an override resurrects the base rule, and the base `.table-container`
       shorthand pays 12px gutters. So the "widening" narrowed every
       width-bound phone (390x844 rendered a 364px felt on production,
       measured 2026-08-29) and nothing noticed for three days, because no
       spec asserted what the comment claimed. Dan, 2026-08-29: "the table
       width and length has shrunk and need to be put back to how it was."

       The two devices named here are the width-bound portrait phones in
       DEVICES: their height budget allows a wider oval than the screen, so
       the screen is the limit and the felt must reach both edges of it. If
       this fails with a felt a few px short, a side gutter came back --
       check the `.table-container` padding longhands at <=768px in
       TablePage.css before anything else. If it fails because the felt is
       far narrower, the height budget shrank and the device stopped being
       width-bound; that is a real felt-size change and belongs in front of
       Dan, not silently under this beat. */
    /* The (real) rows carry the actual notch and home-indicator insets and
       are the ones that map to Dan's hand. 2026-08-29, second lesson of the
       day: the first edge-to-edge fix went green on the emulated rows while
       changing nothing on real hardware, because the real felt was
       HEIGHT-bound under insets no emulation models. If a device is ever
       width-starved again, it must be starved HERE, loudly. */
    const WIDTH_BOUND_PHONES = [
      'iPhone SE',
      'iPhone 12/13/14',
      'iPhone 14 Pro Max',
      'iPhone 12/13/14 (real)',
      'iPhone 14 Pro Max (real)',
    ];
    const rows = await measureAll(page, css);
    const offenders: string[] = [];
    for (const r of rows) {
      if (!WIDTH_BOUND_PHONES.includes(r.device)) continue;
      const vpW = Number(r.vp.split('x')[0]);
      if (Math.abs(r.feltW - vpW * 0.82) > 0.5) {
        offenders.push(
          `${r.device} (${r.vp}): felt is ${r.feltW}px on a ${vpW}px screen -- ` +
            `${(vpW - r.feltW).toFixed(1)}px of gutter came back`
        );
      }
    }
    expect(
      offenders,
      'a phone no longer has its approved 82 percent rail width. Check the padding ' +
        'longhand on .table-container reappearing (or being deleted -- deletion ' +
        'resurrects the base 12px, which is how this shipped the first time).'
    ).toEqual([]);
  });

  test('nothing on the felt changes size without saying so (the geometry baseline)', async ({
    page,
  }) => {
    /* Dan 2026-08-29: "YOU NEED TO ADD PREVENTIVE REGRESSION TO ALL ASPECTS
       ... WE DON'T EVER WANT THINGS RANDOMLY REGRESSING."

       Every other beat in this file pins a RATIO, and ratios cannot see the
       whole table shrinking -- when the felt loses 26px and everything on it
       scales down in step, every fraction stays flat and every beat stays
       green. That is exactly how #950 shipped a narrower felt for three days
       with all checks passing.

       This beat pins the ABSOLUTE numbers: nine CSS-derived box sizes on all
       thirteen devices, against a committed baseline. An intended size change
       ships by regenerating the baseline IN THE SAME COMMIT --

           node scripts/dev/update-geometry-baseline.mjs

       -- reading the diff, and stating the change in the PR. An unexplained
       geometry-baseline.json hunk is to be treated exactly like a weakened
       law-test pin: it IS the regression, wearing a green check.

       Tolerance is 1px: the numbers are pure CSS arithmetic (no text metrics),
       so macOS and CI Linux agree to well under that; a real size change moves
       a number by several px on at least one device. */
    const baseline = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tests/e2e/support/geometry-baseline.json'), 'utf8')
    ) as Record<string, Record<string, number | string>>;
    const FIELDS = [
      'feltW',
      'feltH',
      'btnH',
      'card2W',
      'card2H',
      'avatar',
      'heroAvatar',
      'seatW',
      'plo4Row',
    ] as const;

    const rows = await measureAll(page, css);
    const offenders: string[] = [];
    for (const r of rows) {
      const want = baseline[r.device];
      if (!want) {
        offenders.push(
          `${r.device}: not in geometry-baseline.json -- a new device needs a regenerated baseline`
        );
        continue;
      }
      for (const f of FIELDS) {
        const got = r[f] as number;
        const exp = want[f] as number;
        if (typeof exp !== 'number') {
          offenders.push(`${r.device}.${f}: baseline entry missing -- regenerate the baseline`);
          continue;
        }
        if (Math.abs(got - exp) > 1) {
          offenders.push(
            `${r.device} (${r.vp}): ${f} is ${got}px, baseline says ${exp}px ` +
              `(${(got - exp > 0 ? '+' : '') + (got - exp).toFixed(1)}px)`
          );
        }
      }
    }

    expect(
      offenders,
      'a size changed and the baseline was not regenerated. If the change is intended: ' +
        'run `node scripts/dev/update-geometry-baseline.mjs`, READ the diff, commit it ' +
        'in this same PR and state the size change in the description. If it is not ' +
        'intended, congratulations -- this beat just did its job.'
    ).toEqual([]);
  });

  test('every card stays legible and every touch target stays tappable', async ({ page }) => {
    /* The floors are px and not proportions for a reason a ratio cannot express:
       a thumb is the same size on every device. Pure proportional scaling is the
       opposite trap to the ladder, and this is what stops it. */
    const rows = await measureAll(page, css);
    for (const r of rows) {
      expect(r.card2W, `${r.device}: card below the legibility floor`).toBeGreaterThanOrEqual(
        CARD_FLOOR - 0.5
      );
      expect(r.avatar, `${r.device}: avatar below its floor`).toBeGreaterThanOrEqual(
        AVATAR_FLOOR - 0.5
      );
      expect(
        r.btnH,
        `${r.device}: action button under the 44px touch minimum`
      ).toBeGreaterThanOrEqual(44);
      // 2.5:3.5, exact, so the card art is never resampled.
      expect(r.card2H / r.card2W, `${r.device}: card is not the 2.5:3.5 rectangle`).toBeCloseTo(
        1.4,
        1
      );
    }
  });
});

test.describe('a short ring sits lower and gives up no width (Dan 2026-09-23, item 7)', () => {
  /* "6 MAX GAMES THE TABLE SHOULD BE LOWER BY ABOUT 15-20. THERE IS TOO MUCH
     SPACE ON THE BOTTOM AND NOT ENOUGH ON THE TOP."

     SHIPPED BUG (cafc6dca, one night). The first cut lowered the 2..6 seat
     oval by re-deriving its WIDTH from a reduced height on the seat rule, at
     0,3,0. That outranked the <=768px fill rule (0,1,0) - the one that exists
     because "THE ASPECT LOCK IS THE THING STARVING THE WIDTH" on a notched
     phone - and the landscape rule's `width: auto`. Measured with the real
     insets: a 6-max felt on an iPhone 12/13/14 came out 350.7px wide against
     the 390px a 9-max gets on the same phone, and in landscape it overflowed
     its container by 21px. The drop is now paid out of the height budget in
     the rule that derives each size, and on phones out of the 4% the 960
     canvas already gives back, so it costs the oval nothing.

     Asserted as a comparison between the two rings on the same device, because
     that is the form the bug took: the short ring must start lower, must end
     inside its container, and must be as wide as the full ring, within the 4%
     the shorter canvas takes off a cap that scales with height. */
  const SHORT_DROP_PX = 18;
  const seatHtml = (html: string, seats: number) =>
    html.replace(
      'class="table-page table-page--embedded"',
      `class="table-page table-page--embedded" data-seats="${seats}"`
    );
  const probeBox = () => {
    const s = document.querySelector('.table-scaler') as HTMLElement;
    const c = document.querySelector('.table-container') as HTMLElement;
    const r = s.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    return { w: r.width, h: r.height, top: r.top - cr.top, bottomGap: cr.bottom - r.bottom };
  };

  test('6-max stays shorter and centered with permanent short-phone card lanes, retains desktop drop, and is as wide', async ({
    page,
  }) => {
    const offenders: string[] = [];
    for (const [device, width, height, insetTop = 0, insetBottom = 0] of [
      ...DEVICES,
      ['iPhone 393', 393, 852, 0, 0] as const,
    ]) {
      await page.setViewportSize({ width, height });
      const html = buildHtml(
        insetTop || insetBottom ? applyInsets(css, insetTop, insetBottom) : css
      );
      await page.setContent(seatHtml(html, 9));
      const full = await page.evaluate(probeBox);
      await page.setContent(seatHtml(html, 6));
      const short = await page.evaluate(probeBox);
      const label = `${device} (${width}x${height})`;
      const phonePortrait = width <= 480 && height > width;
      const shortPhone = phonePortrait && width <= 375 && height <= 700;
      const heightShare = shortPhone ? 0.96 : 0.88;
      const heightBudget = full.h - (shortPhone ? 4 : 0);
      const expectedDrop = phonePortrait ? heightBudget * ((1 - heightShare) / 2) : SHORT_DROP_PX;
      if (phonePortrait && Math.abs(short.h - heightBudget * heightShare) > 0.5)
        offenders.push(
          `${label}: six-max height ${short.h} must be ${heightShare * 100}% of nine-max ${full.h}`
        );
      if (Math.abs(short.top - full.top - expectedDrop) > 0.5) {
        offenders.push(
          `${label}: 6-max starts ${(short.top - full.top).toFixed(1)}px below 9-max, not ${expectedDrop}px`
        );
      }
      if (short.bottomGap < -0.5) {
        offenders.push(
          `${label}: 6-max overflows its container by ${(-short.bottomGap).toFixed(1)}px`
        );
      }
      if (short.w < full.w * 0.95) {
        offenders.push(
          `${label}: 6-max is ${short.w.toFixed(1)}px wide against ${full.w.toFixed(1)}px for 9-max - ` +
            'the seat rule is deriving its own width again'
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

test('the enlarged player plates stay inside the phone viewport on every ring', async ({
  page,
}) => {
  const { seatPodPx, fitSeatToViewport } = await import('../../src/components/table/tableGeometry');
  const { SEAT_LAYOUTS } = await import('../../src/lib/tableSeatGeometry');
  for (const width of [320, 375, 393, 430, 784]) {
    await page.setViewportSize({ width, height: 1087 });
    await page.setContent(buildHtml(css));
    const canvas = await page.locator('.table-scaler').boundingBox();
    expect(canvas).not.toBeNull();
    const size = { w: canvas!.width, h: canvas!.height };
    for (const [count, ring] of Object.entries(SEAT_LAYOUTS)) {
      const seats = ring.map((pos) =>
        fitSeatToViewport(
          pos,
          size,
          width,
          seatPodPx(width, pos.y >= 100 && pos.x === 50, size.w),
          canvas!.x
        )
      );
      await page.evaluate(
        ({ seats, count }) => {
          const root = document.querySelector('.table-page')!;
          root.setAttribute('data-seats', count);
          const scaler = document.querySelector('.table-scaler') as HTMLElement;
          scaler.style.setProperty('--table-w', scaler.getBoundingClientRect().width + 'px');
          scaler.innerHTML = seats
            .map(
              (pos) =>
                `<div class="seat-wrapper ${pos.y < 20 ? 'seat-wrapper--top' : ''}" style="left:${pos.x}%;top:${pos.y}%"><div class="seat ${pos.y >= 100 && pos.x === 50 ? 'seat--hero' : ''}"><div class="seat__avatar-wrap"><div class="seat__avatar"></div></div><div class="seat__info"><span class="seat__name">squeeze777</span><span class="seat__stack">123,456</span></div></div></div>`
            )
            .join('');
        },
        { seats, width, count }
      );
      const plates = await page.locator('.seat__info').evaluateAll((elements) =>
        elements.map((e) => ({
          left: e.getBoundingClientRect().left,
          right: e.getBoundingClientRect().right,
        }))
      );
      for (const plate of plates) {
        expect(plate.left, `${width}px ${count}-max left plate edge`).toBeGreaterThanOrEqual(1.5);
        expect(plate.right, `${width}px ${count}-max right plate edge`).toBeLessThanOrEqual(
          width - 1.5
        );
      }
    }
  }
});

test('mobile seat plates, straight private cards and waiting-list text fit their frames', async ({
  page,
}) => {
  const waitingCss = readFileSync(
    resolve(ROOT, 'src/components/table/WaitlistCallToAction.css'),
    'utf8'
  );
  let priorPlate = 0;
  for (const width of [375, 393, 430]) {
    await page.setViewportSize({ width, height: 852 });
    await page.setContent(buildHtml(css + waitingCss));
    await page.evaluate(() => {
      const scaler = document.querySelector<HTMLElement>('.table-scaler')!;
      scaler.style.setProperty('--table-w', `${scaler.getBoundingClientRect().width}px`);
      const row = document.querySelector('.seat--hero .seat__cards--hero')!;
      row.innerHTML = Array.from(
        { length: 5 },
        () => '<span class="seat__card-pick"><div class="seat__card seat__card--face"></div></span>'
      ).join('');
      const cta = document.createElement('button');
      cta.className = 'waitlist-cta';
      cta.innerHTML =
        '<span class="waitlist-cta__face"><span class="waitlist-cta__line"><span class="waitlist-cta__eyebrow">Table Full · 0 Waiting</span></span><span class="waitlist-cta__line"><span class="waitlist-cta__title">Join The Waiting List</span></span></span>';
      document.querySelector('.table-page')!.append(cta);
    });
    const measured = await page.evaluate(() => {
      const face = document.querySelector('.waitlist-cta__face')!.getBoundingClientRect();
      const lines = Array.from(document.querySelectorAll('.waitlist-cta__line')).map((el) =>
        el.getBoundingClientRect()
      );
      const cards = Array.from(document.querySelectorAll('.seat--hero .seat__card-pick')).map(
        (el) => ({ transform: getComputedStyle(el).transform, top: el.getBoundingClientRect().top })
      );
      return {
        plate: document.querySelector('.seat:not(.seat--hero)')!.getBoundingClientRect().width,
        face: { top: face.top, bottom: face.bottom },
        lines: lines.map((r) => ({ top: r.top, bottom: r.bottom })),
        cards,
      };
    });
    expect(measured.plate, `${width}px: plate must scale below the old fixed minimum`).toBeLessThan(
      width * 0.24
    );
    expect(measured.plate).toBeGreaterThan(priorPlate);
    priorPlate = measured.plate;
    for (const line of measured.lines) {
      expect(line.top).toBeGreaterThanOrEqual(measured.face.top - 1);
      expect(line.bottom).toBeLessThanOrEqual(measured.face.bottom + 1);
    }
    expect(
      Math.abs(
        (measured.lines[0].top + measured.lines[1].bottom) / 2 -
          (measured.face.top + measured.face.bottom) / 2
      )
    ).toBeLessThan(1);
    expect(measured.cards.every((card) => card.transform === 'none')).toBe(true);
    expect(
      Math.max(...measured.cards.map((card) => card.top)) -
        Math.min(...measured.cards.map((card) => card.top))
    ).toBeLessThan(1);
  }
});

test('the compact profit tracker shares the hand-pill centre beside the rightmost Lobby', async ({
  page,
}) => {
  const styles = ['src/pages/MultiTablePage.css', 'src/components/table/TableTabBar.css']
    .map((path) => readFileSync(resolve(ROOT, path), 'utf8'))
    .join('\n');
  for (const width of [375, 393, 430, 1024])
    for (const inset of [0, 28]) {
      await page.setViewportSize({ width, height: 852 });
      await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}${styles}</style>
      <div class="multi-table-page" style="--sp-tabbar-inset:${inset}px;--mtt-ticker-h:24px">
        <div class="multi-table-page__tab-bar-wrapper multi-table-page__tab-bar-wrapper--with-lobby">
          <div class="table-tab-bar"><div class="table-tab-bar__menu-container" style="width:44px;flex-shrink:0"></div><div class="table-tab-bar__tabs"><button class="table-tab-bar__tab">PLO5</button><button class="table-tab-bar__tab">PLO4</button></div></div>
          <button class="multi-table-page__pnl-chip multi-table-page__pnl-chip--down">-170.37</button>
          <button class="mtp-lobby-btn">Lobby</button>
        </div>
      </div>`);
      const measured = await page.evaluate(() => {
        const profit = document.querySelector<HTMLElement>('.multi-table-page__pnl-chip')!;
        const tab = document.querySelector('.table-tab-bar__tab')!.getBoundingClientRect();
        const pnl = profit.getBoundingClientRect();
        const lobby = document.querySelector('.mtp-lobby-btn')!.getBoundingClientRect();
        return {
          width: pnl.width,
          height: pnl.height,
          pnlCenter: pnl.top + pnl.height / 2,
          tabCenter: tab.top + tab.height / 2,
          lobbyCenter: lobby.top + lobby.height / 2,
          pnlRight: pnl.right,
          lobbyLeft: lobby.left,
          lobbyRight: lobby.right,
          fullText: profit.scrollWidth <= profit.clientWidth,
        };
      });
      expect(measured.width).toBe(width <= 480 ? 52 : 100);
      expect(measured.height).toBe(52);
      expect(Math.abs(measured.pnlCenter - measured.tabCenter)).toBeLessThanOrEqual(1);
      expect(Math.abs(measured.lobbyCenter - measured.tabCenter)).toBeLessThanOrEqual(1);
      expect(measured.pnlRight).toBeLessThanOrEqual(measured.lobbyLeft);
      expect(measured.lobbyRight).toBeLessThanOrEqual(width);
      expect(measured.fullText, `${width}px inset=${inset}: ${JSON.stringify(measured)}`).toBe(
        true
      );
    }
});

// Both rings must keep the rail wide even when the phone's height binds.
// Seating/action state must never change either dimension of that canvas.
test('portrait phone rings reserve outboard lanes and keep their height through gameplay states', async ({
  page,
}) => {
  for (const [width, height] of [
    [320, 568],
    [375, 667],
    [393, 852],
    [430, 932],
    [480, 975],
  ]) {
    await page.setViewportSize({ width, height });
    for (const seats of [6, 9]) {
      await page.setContent(buildHtml(css));
      await page
        .locator('.table-page')
        .evaluate((el, count) => el.setAttribute('data-seats', String(count)), seats);
      const initial = await page.locator('.table-scaler').boundingBox();
      expect(initial!.width, `${seats}-max at ${width}x${height}`).toBeCloseTo(width * 0.82, 0);
      expect(
        await page
          .locator('.table-page')
          .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-text-size-adjust'))
      ).toBe('100%');
      for (const [hero, action] of [
        ['true', 'none'],
        ['true', 'waiting'],
        ['true', 'active'],
      ]) {
        await page.locator('.table-page').evaluate(
          (el, state) => {
            el.setAttribute('data-hero', state[0]);
            el.setAttribute('data-hero-action', state[1]);
          },
          [hero, action]
        );
        const box = await page.locator('.table-scaler').boundingBox();
        expect(box!.height).toBeCloseTo(initial!.height, 1);
        expect(box!.width).toBeCloseTo(initial!.width, 1);
      }
    }
  }
});

test('Safari toolbar space is reclaimed by portrait gameplay without narrowing the rail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const count of [6, 9]) {
    const boxes = [];
    // A mobile browser may expose a smaller svh than its currently visible
    // dvh. Resolve that input explicitly: desktop emulation gives them equal
    // values and otherwise cannot exercise this Safari toolbar condition.
    for (const styles of [css, css.replaceAll('100svh', '650px')]) {
      await page.setContent(buildHtml(styles));
      await page
        .locator('.table-page')
        .evaluate((el, seats) => el.setAttribute('data-seats', String(seats)), count);
      boxes.push(await page.locator('.table-scaler').boundingBox());
    }
    expect(boxes[1]!.width).toBeCloseTo(390 * 0.82, 0);
    expect(boxes[1]!.height).toBeCloseTo(boxes[0]!.height, 1);
  }
});

// Real occupied components, not placeholder rectangles: this guards the
// overlap missed by the old containment-only regression.
// 600 and 768: portrait viewports above the 480px phone breakpoint (large
// phones, foldables, an upright iPad mini or 768px tablet) share the phone's
// tabled-hand and marker placement (PORTRAIT_CARD_LANE_MAX_VIEWPORT_PX). On
// 2026-10-24 they parked shown PLO5/PLO6 hands under the hero or in front of
// another player. They are certified on the PLO5/PLO6 scenes this regime is
// for; dense rings retain their compact pods through this same boundary.
const occupiedViewports: Array<[number, number?]> = [
  ...[320, 375, 393, 430, 480, 600, 768, 1024].map((width): [number] => [width]),
  [600, 852],
];
for (const [width, heightOverride] of occupiedViewports)
  for (const count of heightOverride || width === 1024 ? [6] : [6, 9])
    test(`occupied portrait rings keep the board clear, bets on the rail and controls at their approved sizes at ${width}px with ${count} seats${heightOverride ? ' (short portrait)' : ''}`, async ({
      page,
    }, testInfo) => {
      // Keep each ring independently bounded on hosted runners while retaining
      // every PLO5/PLO6 all-in and fully shown scene at every width.
      test.setTimeout(150_000);
      const { buildSync } = await import('esbuild');
      const bundled = buildSync({
        entryPoints: ['tests/e2e/support/portraitRailFixture.tsx'],
        jsx: 'automatic',
        outfile: 'rail-fixture.js',
        bundle: true,
        write: false,
        metafile: true,
        format: 'iife',
        platform: 'browser',
        loader: {
          '.css': 'empty',
          '.png': 'dataurl',
          '.webp': 'dataurl',
          '.svg': 'dataurl',
          '.jpg': 'dataurl',
        },
        define: {
          'import.meta.env': JSON.stringify({
            VITE_SUPABASE_URL: 'https://kuklfnapbkmacvwxktbh.supabase.co',
            VITE_SUPABASE_ANON_KEY: 'local-fixture',
            VITE_MEDIA_BASE: 'https://smarter.poker/hub/club-arena/',
            DEV: true,
          }),
          'process.env.NODE_ENV': '"test"',
        },
      });
      const bundle = bundled.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
      await page.route('**/cards/**', async (route) => {
        const path = new URL(route.request().url()).pathname.split('/cards/')[1];
        const source = resolve(process.cwd(), 'public/cards', path.replace(/\.webp$/, '.png'));
        const original = resolve(process.cwd(), 'public/cards', path);
        const file = existsSync(original) ? original : source;
        expect(file.startsWith(resolve(process.cwd(), 'public/cards') + '/')).toBe(true);
        expect(existsSync(file), `Local Card Artwork: ${path}`).toBe(true);
        await route.fulfill({
          body: readFileSync(file),
          contentType: file.endsWith('.png') ? 'image/png' : 'image/webp',
        });
      });
      await page.route('**/rest/v1/rpc/fn_cash_vpip_status', (route) =>
        route.fulfill({
          json: { ok: true, seated: true, required: 50, vpip: 38, hands: 12, window: 10 },
        })
      );

      const avatarBytes = readFileSync(tableArtFixture('vip_wolf@2x.webp'));
      const wideAvatarBytes = readFileSync(tableArtFixture('vip_aztec_warrior@2x.webp'));
      await page.route('**/avatars/table/**', (route) =>
        route.fulfill({
          body: route.request().url().includes('vip_aztec_warrior') ? wideAvatarBytes : avatarBytes,
          contentType: 'image/webp',
        })
      );
      const sheets = [
        ...new Set([
          'src/styles/club-engine.css',
          'src/styles/animations.css',
          'src/styles/metallic-popups.css',
          'src/styles/reducedMotion.css',
          'src/pages/MultiTablePage.css',
          'src/components/table/TableTabBar.css',
          'src/pages/TablePage.css',
          'src/components/table/ActionPanel.css',
          ...Object.keys(bundled.metafile!.inputs).filter((f) => f.endsWith('.css')),
          'src/components/table/TableChat.css',
          'src/components/table/TableVisualHotfix.css',
        ]),
      ];
      const toolAlpha: Record<
        string,
        { left: number; top: number; right: number; bottom: number }
      > = {};
      for (const icon of ['chat', 'timebank', 'rabbit']) {
        const bytes = readFileSync(tableArtFixture(`icon-${icon}.webp`));
        toolAlpha[icon] = await page.evaluate(async (base64) => {
          const image = new Image();
          image.src = `data:image/webp;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
          let left = image.width,
            top = image.height,
            right = 0,
            bottom = 0;
          for (let y = 0; y < image.height; y++)
            for (let x = 0; x < image.width; x++)
              if (pixels[(y * image.width + x) * 4 + 3] > 128) {
                left = Math.min(left, x);
                top = Math.min(top, y);
                right = Math.max(right, x + 1);
                bottom = Math.max(bottom, y + 1);
              }
          return {
            left: left / image.width,
            top: top / image.height,
            right: right / image.width,
            bottom: bottom / image.height,
          };
        }, bytes.toString('base64'));
        await page.route(`**/buttons/black/icon-${icon}.webp`, (route) =>
          route.fulfill({ body: bytes, contentType: 'image/webp' })
        );
      }
      const fontSheet = await page.request.get('https://ca-static.smarter.poker/fonts/fonts.css');
      expect(fontSheet.ok()).toBe(true);
      const inter = [...(await fontSheet.text()).matchAll(/@font-face\s*\{[^}]+\}/g)]
        .map((m) => m[0])
        .find((face) => face.includes("font-family: 'Inter'") && face.includes('U+0000-00FF'))!;
      expect(inter).toBeTruthy();
      const fontPath = /url\(([^)]+)\)/.exec(inter)![1];
      const fontResponse = await page.request.get(
        new URL(fontPath.replace('/hub/club-arena/', '/'), 'https://ca-static.smarter.poker').href
      );
      expect(fontResponse.ok()).toBe(true);
      const fontFace = inter
        .replace(/font-weight:\s*\d+;/, 'font-weight: 100 900;')
        .replace(
          fontPath,
          `data:font/woff2;base64,${(await fontResponse.body()).toString('base64')}`
        );
      const readStyle = (file: string): string =>
        readFileSync(resolve(process.cwd(), file), 'utf8').replace(
          /^\s*@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/gm,
          (_, imported: string) => readStyle(resolve(dirname(file), imported))
        );
      const realCss =
        fontFace +
        '\n' +
        sheets.map(readStyle).join('\n') +
        '\n' +
        (bundled.outputFiles.find((file) => file.path.endsWith('.css'))?.text || '');
      for (const [revealed, jackpot, villainCards = 2, state = 'normal'] of [
        [false, 'mini'],
        [true, 'mini'],
        [false, 'main'],
        [true, 'main'],
        [false, 'none'],
        [true, 'none'],
        [true, 'mini', 6],
        [true, 'mini', 5, 'all-in'],
        [true, 'mini', 6, 'all-in'],
        [true, 'mini', 6, 'all-shown'],
        [false, 'none', 2, 'scaled-phone'],
      ] as const) {
        // Both rings exercise every occupied state at every phone width.
        const scaledPhone = state === 'scaled-phone';
        if (scaledPhone && (width !== 600 || count !== 9)) continue;
        if (width > 480 && villainCards < 5 && !scaledPhone) continue;
        await page.setViewportSize({
          width: scaledPhone ? 599 : width,
          height: scaledPhone
            ? 1065
            : width === 320
              ? 568
              : width === 375
                ? 667
                : width === 600
                  ? 960
                  : width === 768
                    ? 1024
                    : width === 1024
                      ? 2048
                      : 852,
        });
        if (heightOverride) await page.setViewportSize({ width, height: heightOverride });
        await page.route('https://smarter.poker/hub/club-arena/__isolated_rail_fixture', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `<html data-avatar="${scaledPhone ? 'vip_aztec_warrior@2x.webp' : 'vip_wolf@2x.webp'}" data-seats="${count}" data-cards="${villainCards >= 5 ? villainCards : 4}" data-all-in="${state === 'all-in'}" data-show-all="${state === 'all-shown'}" data-revealed="${revealed}" data-jackpot="${jackpot}" data-villain-cards="${villainCards}"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${realCss}</style></head><body><div id="root"></div></body></html>`,
          })
        );
        await page.goto('https://smarter.poker/hub/club-arena/__isolated_rail_fixture', {
          waitUntil: 'domcontentloaded',
        });
        // Same-origin pixels must not grant a synthetic renderer an inherited
        // authenticated session from the browser job's isolated login fixture.
        // This clears only this test context; it never signs out any session.
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        expect(await page.evaluate(() => localStorage.getItem('smarter-poker-auth'))).toBeNull();
        const runtimeErrors: string[] = [];
        page.on('pageerror', (error) => runtimeErrors.push(error.message));
        await page.addScriptTag({ content: bundle });
        expect(runtimeErrors).toEqual([]);
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.seat__info').length ===
            Number(document.documentElement.dataset.seats)
        );
        await page.waitForFunction(() => {
          const canvas = document.querySelector<HTMLElement>('.table-scaler')!;
          return (
            Math.abs(
              parseFloat(canvas.style.getPropertyValue('--table-w')) -
                canvas.getBoundingClientRect().width
            ) < 0.5
          );
        });
        await expect(page.locator('.seat__avatar-img')).toHaveCount(count);
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLImageElement>('.seat__avatar-img')].every(
            (i) => i.complete && i.naturalWidth > 0
          )
        );
        await page.evaluate(async () => {
          const faces = await document.fonts.load('600 14px Inter');
          if (!faces.length) throw new Error('Inter Face Missing');
          await document.fonts.ready;
        });
        await expect(page.locator('.card-image__fallback')).toHaveCount(0);
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLImageElement>('.card-image__img')].every(
            (i) => i.complete && i.naturalWidth > 0
          )
        );
        await page.waitForFunction(
          () =>
            !document.querySelector(
              '.community-area [data-rs-animating="true"],.community-cards__card--flop-deal'
            )
        );
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
              .map((a) => a.finished.catch(() => {}))
          );
          // Animation completion schedules protected-card placement on the next
          // frame. Consume that frame and its layout before measuring geometry.
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
        });
        if (scaledPhone) {
          const proof = await page.evaluate(readMobileTableLayout, AVATAR_CROWN_TOP);
          expect(proof.occupied).toBe(count);
          expect(
            proof.violations,
            'Decoded crowns and plates clear the scaled phone board'
          ).toEqual([]);
        }
        // Dan 2026-10-23: shown cards never move once tabled, in every game.
        // Hold'em-sized shown hands get the same no-movement proof as PLO5/6.
        if (revealed) {
          const measure = () =>
            page.locator('.seat__cards--revealed .seat__card').evaluateAll((cards) =>
              cards.map((card) => {
                const b = card.getBoundingClientRect();
                return { x: b.x, y: b.y, w: b.width, h: b.height };
              })
            );
          const before = await measure();
          expect(before.length).toBeGreaterThanOrEqual(villainCards);
          // Same dimensions at every chair, including the all-in hero.
          if (villainCards >= 5)
            for (const card of before) {
              expect(card.w).toBeCloseTo(before[0].w, 1);
              expect(card.h).toBeCloseTo(before[0].h, 1);
            }
          await page.evaluate(() => {
            document.dispatchEvent(new Event('fixture-runout'));
            const pot = document.querySelector('.pot-display')!;
            pot.classList.toggle('pot-display--updated');
            document
              .querySelectorAll('.seat')
              .forEach((seat) => seat.classList.add('seat--allin-shake', 'seat--winner-pop'));
            document.querySelector('.table-scaler')!.classList.add('table-page--shake');
            // Board animation and highlight changes previously retriggered
            // adaptive spacing, shrinking and placement after every street.
            document
              .querySelector('.table-scaler')!
              .dispatchEvent(new Event('animationend', { bubbles: true }));
          });
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              )
          );
          expect(await measure()).toEqual(before);
          const steps = await page
            .locator('.seat__cards--opponent.seat__cards--revealed')
            .evaluateAll((rows) =>
              rows.map((row) => parseFloat(getComputedStyle(row).getPropertyValue('--vh-step-f')))
            );
          if (villainCards >= 5) expect(steps.every((step) => step >= 0.5)).toBe(true);
          await page.evaluate(() => {
            document
              .querySelectorAll('.seat')
              .forEach((seat) => seat.classList.remove('seat--allin-shake', 'seat--winner-pop'));
            document.querySelector('.table-scaler')!.classList.remove('table-page--shake');
            return new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            );
          });
        }
        if (state !== 'normal') {
          await page.screenshot({
            path: testInfo.outputPath(`${width}px-${count}-seats-PLO${villainCards}-${state}.png`),
          });
        }
        if (count === 6 && width > 480) {
          const crown = await page.evaluate((crowns) => {
            const table = document.querySelector('.table-page')!;
            const scaler = document.querySelector<HTMLElement>('.table-scaler')!;
            const head = table.querySelector<HTMLImageElement>(
              '.seat-wrapper--top .seat__avatar-img'
            )!;
            const source = head.currentSrc || head.src;
            const file = /\/avatars\/table\/((?:free|vip)_[\w-]+(?:@2x)?\.webp)(?:[?#]|$)/.exec(
              source
            )?.[1];
            return {
              gap:
                head.getBoundingClientRect().top +
                head.getBoundingClientRect().height * ((file && crowns[file]) || 0) -
                table.getBoundingClientRect().top,
              scale: scaler.getBoundingClientRect().width / scaler.offsetWidth,
            };
          }, AVATAR_CROWN_TOP);
          // Preserve breathing, tense and celebration poses around the
          // two-pixel resting crop; only the crown may cross the bar.
          expect(crown.gap).toBeGreaterThan(-12 * crown.scale);
          // A mobile revealed hand now owns a full card-height lane above
          // its plate. Only face-down and desktop crowns retain the crop.
          if (!revealed || width > 768) expect(crown.gap).toBeLessThan(2 * crown.scale);
          if (state === 'normal' && revealed && villainCards === 6 && jackpot === 'mini') {
            // A reload/new hand used to cache the image box mid-gesture. When
            // the avatar later folded it left a permanent gap under the bar.
            // Use the real choreography and real SeatSlot, never hide motion.
            const anchoring = await page.evaluate(async (crowns) => {
              const pod = document.querySelector<HTMLElement>('.seat-wrapper--top')!;
              const seat = pod.querySelector<HTMLElement>('.seat')!;
              const wrap = pod.querySelector<HTMLElement>('.seat__avatar-wrap')!;
              const head = pod.querySelector<HTMLImageElement>('.seat__avatar-img')!;
              const frame = () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
                );
              const originalSeat = seat.className;
              const originalWrap = wrap.className;
              wrap.classList.add('seat__avatar-wrap--celebrate');
              await frame();
              const gesture = wrap
                .getAnimations()
                .find(
                  (animation) =>
                    animation instanceof CSSAnimation &&
                    animation.animationName === 'spAvatarCelebrate'
                );
              if (!gesture) throw new Error('Real Celebration Animation Missing');
              gesture.pause();
              gesture.currentTime = Number(gesture.effect!.getTiming().duration) * 0.4;
              document.dispatchEvent(new Event('fixture-next-hand'));
              await frame();
              const raisedShift = parseFloat(pod.style.getPropertyValue('--sp-top-seat-shift'));
              // Complete the actual gesture, then let the ordinary folded
              // resting pose settle. No production animation is cancelled.
              gesture.finish();
              wrap.className = originalWrap;
              document.dispatchEvent(new Event('fixture-next-hand'));
              await frame();
              const restingShift = parseFloat(pod.style.getPropertyValue('--sp-top-seat-shift'));
              seat.classList.remove('seat--active', 'seat--winner');
              seat.classList.add('seat--folded');
              await frame();
              await Promise.all(wrap.getAnimations().map((animation) => animation.finished));
              await frame();
              const foldedShift = parseFloat(pod.style.getPropertyValue('--sp-top-seat-shift'));
              const box = head.getBoundingClientRect();
              const file = /\/avatars\/table\/([^/?#]+)/.exec(head.currentSrc || head.src)?.[1];
              const gap =
                box.top +
                box.height * ((file && crowns[file]) || 0) -
                document.querySelector('.table-page')!.getBoundingClientRect().top;
              // Live hand admission can clear folded seat state before the
              // final fold gesture class is retired. Its retained CSS final
              // frame must use the same semantic resting anchor.
              seat.classList.remove('seat--folded');
              wrap.classList.add('seat__avatar-wrap--fold');
              await frame();
              const foldGesture = wrap
                .getAnimations()
                .find(
                  (animation) =>
                    animation instanceof CSSAnimation && animation.animationName === 'spAvatarFold'
                );
              if (!foldGesture) throw new Error('Real Fold Animation Missing');
              await foldGesture.finished;
              await frame();
              const retainedBox = head.getBoundingClientRect();
              const retainedFoldGap =
                retainedBox.top +
                retainedBox.height * ((file && crowns[file]) || 0) -
                document.querySelector('.table-page')!.getBoundingClientRect().top;
              seat.className = originalSeat;
              wrap.className = originalWrap;
              document.dispatchEvent(new Event('fixture-next-hand'));
              await frame();
              return { raisedShift, restingShift, foldedShift, gap, retainedFoldGap };
            }, AVATAR_CROWN_TOP);
            expect(anchoring.restingShift).toBeCloseTo(anchoring.raisedShift, 1);
            if (width > 768) {
              expect(anchoring.foldedShift).toBeLessThan(anchoring.restingShift);
              expect(anchoring.gap).toBeLessThan(0);
              expect(anchoring.retainedFoldGap).toBeLessThan(0);
            } else {
              // Folding may reclaim crown space, but cannot consume the
              // newly reserved revealed-hand lane.
              expect(anchoring.foldedShift).toBeLessThanOrEqual(anchoring.restingShift + 0.05);
              const shownTop = await page
                .locator('.seat-wrapper--top .seat__cards--revealed')
                .evaluate(
                  (el) =>
                    el.getBoundingClientRect().top -
                    document.querySelector('.table-page')!.getBoundingClientRect().top
                );
              expect(shownTop).toBeGreaterThanOrEqual(7.5);
            }
            expect(anchoring.gap).toBeGreaterThan(-12 * crown.scale);
          }
        }
        // The added desktop-width case owns the crown target. The
        // pre-existing marker certification below owns portrait <=768px.
        if (width === 1024) {
          await page.screenshot({ path: testInfo.outputPath(`desktop-sixmax-${state}.png`) });
          continue;
        }
        const result = await page.evaluate(() => {
          const box = (e: Element) => e.getBoundingClientRect();
          const overlaps = (a: DOMRect, b: DOMRect) =>
            a.left < b.right - 0.5 &&
            a.right > b.left + 0.5 &&
            a.top < b.bottom - 0.5 &&
            a.bottom > b.top + 0.5;
          const board = box(document.querySelector('.community-area')!);
          const violations: string[] = [];
          // Top all-in hands must stay below the visible mobile clipping edge.
          const pageTop = box(document.querySelector('.table-page')!).top;
          for (const row of document.querySelectorAll(
            '.seat-wrapper--cap .seat__cards--revealed'
          )) {
            if (box(row).top < pageTop + 7.5)
              violations.push('Top Revealed Hand Clips Mobile Header');
          }
          // Above 480px the ring keeps its tablet positions. Dense 7-9 max
          // pods retain their compact sizes through the phone's desktop
          // reference viewport; the scaled-phone scene below also reads
          // decoded painted art rather than transparent image rectangles.
          // Ownership and fixed-placement checks remain unchanged.
          const largePortrait = innerWidth > 480;
          const compactPlo6 =
            innerWidth <= 340 &&
            document.querySelector('.table-page')?.getAttribute('data-seats') === '9' &&
            Number(document.documentElement.dataset.villainCards) > 2;
          // On the 320px PLO6 showdown only, the existing narrow-felt
          // printing fallback may use the watermark lane. Player facts,
          // shown cards, the board and the pot remain protected.
          for (const e of document.querySelectorAll(
            largePortrait
              ? '.seat__bet-chips,.seat__cards--opponent .seat__card,.dealer-button'
              : '.seat__info,.seat__avatar-img,.seat__action,.seat__bet-chips,.seat__cards--opponent .seat__card,.dealer-button'
          )) {
            if (overlaps(box(e), board)) violations.push(`${e.className} Covers Board`);
          }
          /* Dan 2026-10-25: a bet is always in front of the player who made
             it. A portrait phone now lays the table out at the desktop's
             width (useTableEnvironment), so the rings below 481px certify
             the fallback ring a browser ignoring the viewport tag shows. On
             the first-generation SE's fallback ring the players, board and
             pot leave no lane that is both the owner's own and clear of the
             felt's printing and the pot's chip pile; the bet keeps its
             owner's lane and may touch those two, as the PLO6 lane below
             already may. Players, cards, tags, the button and the board stay
             protected. */
          const ownersLaneFirst = innerWidth <= 340;
          for (const bet of document.querySelectorAll('.seat__bet-chips'))
            for (const pod of document.querySelectorAll(
              '.seat__info,.seat__avatar-img,.seat__action,.seat__cards--revealed .seat__card,.table-brand,.pot-display,.pot-display__pile,.dealer-button'
            ))
              if (
                !(compactPlo6 && pod.classList.contains('table-brand')) &&
                !(
                  ownersLaneFirst &&
                  (pod.classList.contains('table-brand') ||
                    pod.classList.contains('pot-display__pile'))
                ) &&
                overlaps(box(bet), box(pod))
              )
                violations.push(
                  `Bet ${bet.closest('.seat')?.querySelector('.seat__name')?.textContent} Covers Player ${pod.closest('.seat')?.querySelector('.seat__name')?.textContent} ${pod.className} bet=${JSON.stringify(box(bet))} player=${JSON.stringify(box(pod))}`
                );
          const wagers = [...document.querySelectorAll('.seat__bet-chips')];
          for (const wager of wagers) {
            const moved = getComputedStyle(wager);
            const source = getComputedStyle(wager.parentElement!);
            const number = (style: CSSStyleDeclaration, name: string) =>
              parseFloat(style.getPropertyValue(name)) || 0;
            for (const axis of ['x', 'y']) {
              const restDelta =
                number(moved, `--bet-offset-${axis}`) - number(source, `--bet-offset-${axis}`);
              const collectDelta =
                number(moved, `--collect-d${axis}`) - number(source, `--collect-d${axis}`);
              if (Math.abs(restDelta + collectDelta) > 0.01)
                violations.push(`Collection Origin Changed On ${axis}`);
            }
          }

          for (let i = 0; i < wagers.length; i++)
            for (let j = i + 1; j < wagers.length; j++)
              if (overlaps(box(wagers[i]), box(wagers[j])))
                violations.push(
                  `Bets Overlap: ${wagers[i].closest('.seat')?.querySelector('.seat__name')?.textContent} / ${wagers[j].closest('.seat')?.querySelector('.seat__name')?.textContent}`
                );
          // Dan 2026-10-22: "that 50 cents to my left is actually my bet, it's
          // sitting in front of the other player" and "I'm one behind the button
          // and the button is right in front of me". A wager and the dealer
          // button each stand nearer their own player than any other. The first
          // generation SE now carries the same ownership guarantee in PLO6.
          if (
            innerWidth >= 375 ||
            compactPlo6 ||
            Number(document.documentElement.dataset.villainCards) >= 5
          ) {
            const centreOf = (e: Element) => {
              const r = box(e);
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            };
            const players = [...document.querySelectorAll<HTMLElement>('.seat-wrapper')]
              .map((wrapper) => ({
                wrapper,
                art: wrapper.querySelector('.seat:not(.seat--empty) .seat__avatar-img'),
              }))
              .filter((p): p is { wrapper: HTMLElement; art: Element } => p.art !== null);
            const nearestTo = (point: { x: number; y: number }) =>
              players.reduce((best, p) => {
                const c = centreOf(p.art);
                const b = centreOf(best.art);
                return Math.hypot(point.x - c.x, point.y - c.y) <
                  Math.hypot(point.x - b.x, point.y - b.y)
                  ? p
                  : best;
              }).wrapper;
            for (const wager of wagers)
              if (nearestTo(centreOf(wager)) !== wager.closest('.seat-wrapper'))
                violations.push(
                  `Bet Reads As Another Player's: ${wager.closest('.seat')?.querySelector('.seat__name')?.textContent}`
                );
            const puck = document.querySelector<HTMLElement>('.dealer-button');
            const owner = players.find(
              (p) =>
                puck &&
                Math.abs(parseFloat(p.wrapper.style.left) - parseFloat(puck.dataset.ownerX ?? '')) <
                  0.01 &&
                Math.abs(parseFloat(p.wrapper.style.top) - parseFloat(puck.dataset.ownerY ?? '')) <
                  0.01
            );
            if (puck && owner && nearestTo(centreOf(puck)) !== owner.wrapper)
              violations.push("Dealer Button Reads As Another Player's");
            // Dan 2026-10-22: "make sure that when a player is all in and or
            // the cards are shown down, that they are clearly displayed - a
            // player could not see the cards he lost to in PLO6." Every tabled
            // card is a readable size, keeps its corner in view, and the hand
            // stands at its own player.
            const rows = [
              ...document.querySelectorAll('.seat__cards--opponent.seat__cards--revealed'),
            ];
            for (const row of rows) {
              const shown = [...row.querySelectorAll('.seat__card')].map(box);
              const name = row.closest('.seat')?.querySelector('.seat__name')?.textContent;
              for (const card of shown)
                if (card.width < (innerWidth <= 340 ? 20 : 22))
                  violations.push(`Tabled Card Too Small: ${name} ${card.width}`);
              const ordered = [...shown].sort((a, b) => a.left - b.left);
              for (let i = 1; i < ordered.length; i++)
                if (ordered[i].left - ordered[i - 1].left < ordered[i - 1].width * 0.25 - 0.5)
                  violations.push(`Tabled Card Corner Hidden: ${name}`);
              const left = Math.min(...shown.map((c) => c.left));
              const right = Math.max(...shown.map((c) => c.right));
              const top = Math.min(...shown.map((c) => c.top));
              const bottom = Math.max(...shown.map((c) => c.bottom));
              if (
                nearestTo({ x: (left + right) / 2, y: (top + bottom) / 2 }) !==
                row.closest('.seat-wrapper')
              )
                violations.push(`Tabled Hand Reads As Another Player's: ${name}`);
            }
            for (let i = 0; i < rows.length; i++)
              for (let j = i + 1; j < rows.length; j++)
                for (const a of rows[i].querySelectorAll('.seat__card'))
                  for (const b of rows[j].querySelectorAll('.seat__card'))
                    if (overlaps(box(a), box(b))) violations.push('Tabled Hands Overlap');
          }
          if (compactPlo6) {
            const wrappers = [...document.querySelectorAll('.seat-wrapper')];
            for (const wrapper of wrappers) {
              for (const other of wrappers) {
                if (other === wrapper) continue;
                for (const a of wrapper.querySelectorAll(
                  '.seat__info,.seat__avatar-img,.seat__action'
                ))
                  for (const b of other.querySelectorAll(
                    '.seat__info,.seat__avatar-img,.seat__action'
                  ))
                    if (overlaps(box(a), box(b)))
                      violations.push('Neighbouring Player Lanes Overlap');
              }
            }
            for (const action of document.querySelectorAll('.seat__action'))
              for (const pot of document.querySelectorAll('.pot-display,.pot-display__pile'))
                if (overlaps(box(action), box(pot))) violations.push('Action Covers Pot');
          }
          for (const action of document.querySelectorAll('.seat__action'))
            for (const plaque of document.querySelectorAll('.bbj-widget,.bbj-mini-plate'))
              if (overlaps(box(action), box(plaque)))
                violations.push('Action Badge Covers Jackpot');
          // Dan 2026-10-24: the compact top pod belongs to 7-9 max only. A 2-6
          // ring's single top seat is full size ("CAN BE FULL SCREEN NOW THAT
          // THE BBJ IS REMOVED FROM ABOVE THEM"), so there it must match the
          // other villains instead.
          const villainAvatars = [
            ...document.querySelectorAll(
              '.seat-wrapper:not(.seat-wrapper--top):not(.seat-wrapper--hero) .seat__avatar'
            ),
          ].map((e) => box(e).width);
          for (const e of document.querySelectorAll('.seat-wrapper--top .seat__avatar'))
            if (
              !largePortrait &&
              villainAvatars.length &&
              Math.abs(box(e).width - Math.max(...villainAvatars)) > 1.5
            )
              violations.push('Top Avatar Is Not Full Size');
          if (innerWidth <= 480) {
            const plates = [
              ...document.querySelectorAll(
                '.seat-wrapper:not(.seat-wrapper--hero):not(.seat-wrapper--top) .seat__info'
              ),
            ].map(box);
            for (const plate of document.querySelectorAll('.seat-wrapper--top .seat__info')) {
              const measured = box(plate);
              if (
                plates.length &&
                (Math.abs(measured.width - plates[0].width) > 1.5 ||
                  Math.abs(measured.height - plates[0].height) > 1.5)
              )
                violations.push('Top Name And Stack Plate Is Smaller Than Other Villains');
            }
          }
          if (!largePortrait) {
            const scales = [
              ...document.querySelectorAll(
                '.seat-wrapper:not(.seat-wrapper--hero) .seat__avatar-img'
              ),
            ].map(
              (e) => parseFloat(getComputedStyle(e).getPropertyValue('--sp-bust-scale')) || 1.45
            );
            if (Math.max(...scales) - Math.min(...scales) > 0.01)
              violations.push('Top Artwork Is Smaller Than Other Villains');
          }
          const canvas = box(document.querySelector('.table-scaler')!);
          const felt = box(document.querySelector('.table-surface')!);
          // The browser's inverse homography maps a DOM rectangle to a
          // quadrilateral on the original painted stadium. Distance to its spine
          // tests the actual felt, including curved caps, rather than its bounding box.
          const inverse = new DOMMatrixReadOnly(
            getComputedStyle(document.querySelector('.table-art')!).transform
          ).inverse();
          const unpaint = (x: number, y: number) => {
            const p = new DOMPoint(x - canvas.left, y - canvas.top).matrixTransform(inverse);
            return { x: p.x / p.w, y: p.y / p.w };
          };
          type Point = { x: number; y: number };
          const radius = felt.width / 2;
          const spineA = { x: felt.left - canvas.left + radius, y: felt.top - canvas.top + radius };
          const spineB = { x: spineA.x, y: felt.bottom - canvas.top - radius };
          const distance = (p: Point, a: Point, b: Point) => {
            const dx = b.x - a.x,
              dy = b.y - a.y;
            const t = Math.max(
              0,
              Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))
            );
            return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
          };
          const allInMarkers = [...document.querySelectorAll('.seat__allin-puck')];
          if (document.querySelector('.seat__action--all_in'))
            violations.push('ALL IN Is Above A Player Head');
          if (
            document.documentElement.dataset.allIn === 'true' &&
            allInMarkers.length !== Math.ceil(Number(document.documentElement.dataset.seats) / 3)
          )
            violations.push('Expected Every All-In Player To Have A Persistent Felt Marker');
          for (const marker of allInMarkers) {
            const r = box(marker);
            for (const [x, y] of [
              [r.left, r.top],
              [r.right, r.top],
              [r.right, r.bottom],
              [r.left, r.bottom],
            ])
              if (distance(unpaint(x, y), spineA, spineB) > radius - 0.5)
                violations.push('ALL IN Marker Is Outside Painted Felt');
          }
          const cross = (a: Point, b: Point, c: Point) =>
            (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          for (const e of document.querySelectorAll(
            '.seat-wrapper:not(.seat-wrapper--hero):not(.seat-wrapper--top) .seat__info,.seat-wrapper:not(.seat-wrapper--hero):not(.seat-wrapper--top) .seat__avatar-img'
          )) {
            const r = box(e);
            const corners = [
              unpaint(r.left, r.top),
              unpaint(r.right, r.top),
              unpaint(r.right, r.bottom),
              unpaint(r.left, r.bottom),
            ];
            const touches = corners.some((a, i) => {
              const b = corners[(i + 1) % 4];
              const crosses =
                cross(a, b, spineA) * cross(a, b, spineB) <= 0 &&
                cross(spineA, spineB, a) * cross(spineA, spineB, b) <= 0;
              return (
                crosses ||
                Math.min(
                  distance(a, spineA, spineB),
                  distance(spineA, a, b),
                  distance(spineB, a, b)
                ) <
                  radius - 0.5
              );
            });
            if (touches && !largePortrait)
              violations.push(`Player On Painted Felt: ${e.className}`);
          }
          const contextualTools = ['.tbc-widget', '.rabbit-hunt__button'].filter((selector) =>
            document.querySelector(selector)
          );
          if (contextualTools.length !== 1) violations.push('Expected One Contextual Bottom Tool');
          const tools = [
            '.mtp-lobby-btn',
            '.chat-collapsed',
            '.prev-hand-card',
            ...contextualTools,
          ].map((s) => ({
            selector: s,
            width: box(document.querySelector(s)!).width,
            height: box(document.querySelector(s)!).height,
          }));
          return { violations, tools, canvas: { width: canvas.width, height: canvas.height } };
        });
        if (width === 320 && count === 9 && state === 'all-in')
          await certifyMobileLiveTableLayout(page, testInfo, {
            widths: [320],
            seatChangeToggle: false,
          });
        if (result.violations.length) {
          const proof = testInfo.outputPath('layout-failure.png');
          await page.screenshot({ path: proof });
          await testInfo.attach('layout-failure', { path: proof, contentType: 'image/png' });
        }
        expect(
          result.violations,
          `${width}px ${count}-max ${jackpot} ${revealed ? 'revealed' : 'playing'} ${villainCards} cards ${state} canvas=${JSON.stringify(result.canvas)}}`
        ).toEqual([]);
        for (const tool of result.tools) {
          // Every phone gameplay tool must have a visible 48px painted target.
          const expected =
            tool.selector === '.mtp-lobby-btn' ? (width === 320 ? 44 : 52) : width <= 480 ? 48 : 40;
          expect(tool.width, tool.selector).toBeCloseTo(expected, 1);
          expect(tool.height, tool.selector).toBeCloseTo(expected, 1);
        }
        for (const [selector, icon] of [
          ['.chat-collapsed', 'chat'],
          ['.tbc-widget', 'timebank'],
          ['.rabbit-hunt__button', 'rabbit'],
        ]) {
          if (!(await page.locator(selector).count())) continue;
          const painted = await page.locator(`${selector} img`).evaluate((image, alpha) => {
            const r = image.getBoundingClientRect();
            return {
              width: r.width * (alpha.right - alpha.left),
              height: r.height * (alpha.bottom - alpha.top),
            };
          }, toolAlpha[icon]);
          expect(Math.max(painted.width, painted.height), `${icon} painted frame`).toBeCloseTo(
            width <= 480 ? 48 : 40,
            0
          );
        }
        if (width === 393) {
          const name = `occupied-${count}-max-${jackpot}-${revealed ? 'revealed' : 'playing'}-${villainCards}`;
          const path = testInfo.outputPath(`${name}.png`);
          await page.screenshot({ path });
          await testInfo.attach(name, { path, contentType: 'image/png' });
          await testInfo.attach(`${name}-geometry`, {
            body: JSON.stringify(result),
            contentType: 'application/json',
          });
        }
        await page.unroute('https://smarter.poker/hub/club-arena/__isolated_rail_fixture');
      }
    });

// The full page has a ticker/tab strip above the embedded gameplay slot.
// Include them and the real action components so a viewport-only fixture
// cannot certify a row that covers the hero in production.
for (const [width, height] of [
  [375, 667],
  [393, 852],
  [430, 932],
])
  for (const bottomInset of [0, 34])
    for (const ticker of [0, 32])
      test(`mobile preselection and decision rows remain below the hero in the embedded shell at ${width}px inset ${bottomInset}px ticker ${ticker}px`, async ({
        page,
      }, testInfo) => {
        test.setTimeout(60_000);

        const { buildSync } = await import('esbuild');
        const bundled = buildSync({
          entryPoints: ['tests/e2e/support/actionRowsFixture.tsx'],
          bundle: true,
          write: false,
          jsx: 'automatic',
          metafile: true,
          format: 'iife',
          platform: 'browser',
          outfile: 'actions-fixture.js',
          loader: {
            '.css': 'empty',
            '.png': 'dataurl',
            '.webp': 'dataurl',
            '.svg': 'dataurl',
            '.jpg': 'dataurl',
          },
          define: {
            'import.meta.env': JSON.stringify({
              VITE_SUPABASE_URL: 'https://dummy.supabase.co',
              VITE_SUPABASE_ANON_KEY: 'fixture',
              DEV: true,
            }),
            'process.env.NODE_ENV': '"test"',
          },
        });
        await page.route('**/cards/**', async (route) => {
          const path = new URL(route.request().url()).pathname.split('/cards/')[1];
          const source = resolve(process.cwd(), 'public/cards', path.replace(/\.webp$/, '.png'));
          const original = resolve(process.cwd(), 'public/cards', path);
          const file = existsSync(original) ? original : source;
          expect(file.startsWith(resolve(process.cwd(), 'public/cards') + '/')).toBe(true);
          expect(existsSync(file), `Local Card Artwork: ${path}`).toBe(true);
          await route.fulfill({
            body: readFileSync(file),
            contentType: file.endsWith('.png') ? 'image/png' : 'image/webp',
          });
        });
        await page.route('**/rest/v1/rpc/fn_cash_vpip_status', (route) =>
          route.fulfill({
            json: { ok: true, seated: true, required: 50, vpip: 38, hands: 12, window: 10 },
          })
        );
        const avatarBytes = readFileSync(tableArtFixture('vip_wolf@2x.webp'));
        await page.route('**/avatars/table/**', (route) =>
          route.fulfill({ body: avatarBytes, contentType: 'image/webp' })
        );
        for (const icon of ['chat', 'timebank', 'rabbit', 'prevhand']) {
          const bytes = readFileSync(tableArtFixture(`icon-${icon}.webp`));
          await page.route(`**/buttons/black/icon-${icon}.webp`, (route) =>
            route.fulfill({ body: bytes, contentType: 'image/webp' })
          );
        }
        const sheets = [
          ...new Set([
            'src/styles/club-engine.css',
            'src/styles/animations.css',
            'src/styles/metallic-popups.css',
            'src/styles/reducedMotion.css',
            'src/pages/MultiTablePage.css',
            'src/components/table/TableTabBar.css',
            'src/pages/TablePage.css',
            'src/components/table/TableChat.css',
            ...Object.keys(bundled.metafile!.inputs).filter((file) => file.endsWith('.css')),
            'src/components/table/TableVisualHotfix.css',
          ]),
        ];
        const readStyle = (file: string): string =>
          readFileSync(resolve(process.cwd(), file), 'utf8').replace(
            /^\s*@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/gm,
            (_, imported: string) => readStyle(resolve(dirname(file), imported))
          );
        const css =
          sheets.map(readStyle).join('\n') +
          '\n' +
          (bundled.outputFiles.find((file) => file.path.endsWith('.css'))?.text || '');
        for (const swipe of [false, true]) {
          await page.setViewportSize({ width, height });
          const withInsets = css.replace(
            /env\(safe-area-inset-bottom(?:,\s*[^)]+)?\)/g,
            `${bottomInset}px`
          );
          let stableHeight: number | undefined;
          for (const state of ['preflop', 'flop', 'facing-bet', 'active']) {
            await page.route('http://actions.fixture/', (route) =>
              route.fulfill({
                contentType: 'text/html',
                body: `<html data-seats="6" data-revealed="false" data-action="${state}" data-cards="4" data-swipe="${swipe}"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${withInsets}\n:root{--mtt-ticker-h:${ticker}px;--sp-tabbar-inset:0px}</style></head><body><div id="root"></div></body></html>`,
              })
            );
            await page.goto('http://actions.fixture/', { waitUntil: 'domcontentloaded' });
            await page.addScriptTag({
              content: bundled.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
            });
            await page.locator('.hero-vpip').waitFor({ timeout: 5000 });
            await page.waitForFunction(() =>
              [
                ...document.querySelectorAll<HTMLImageElement>(
                  '.card-image__img,.seat__avatar-img'
                ),
              ].every((image) => image.complete && image.naturalWidth > 0)
            );
            await expect(page.locator('.card-image__fallback')).toHaveCount(0);
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              );
            });
            await page.locator('.pre-action-bar, .action-panel').evaluate(async (row) => {
              await Promise.all(
                row
                  .getAnimations()
                  .filter(
                    (animation) => animation.effect?.getComputedTiming().iterations !== Infinity
                  )
                  .map((animation) => animation.finished)
              );
            });
            if (state === 'flop')
              await page.getByRole('button', { name: 'Check', exact: true }).click();
            const measured = await page.evaluate(() => {
              const rect = (selector: string) =>
                document.querySelector(selector)!.getBoundingClientRect();
              const row = rect('.pre-action-bar, .action-panel');
              const hero = rect('.seat-wrapper--hero .seat__info');
              const heroCardBoxes = Array.from(
                document.querySelectorAll('.seat__cards--hero .seat__card')
              ).map((card) => card.getBoundingClientRect());
              const cards = DOMRect.fromRect({
                x: Math.min(...heroCardBoxes.map((card) => card.left)),
                y: Math.min(...heroCardBoxes.map((card) => card.top)),
                width:
                  Math.max(...heroCardBoxes.map((card) => card.right)) -
                  Math.min(...heroCardBoxes.map((card) => card.left)),
                height:
                  Math.max(...heroCardBoxes.map((card) => card.bottom)) -
                  Math.min(...heroCardBoxes.map((card) => card.top)),
              });
              const scaler = rect('.table-scaler');
              const vpip = rect('.hero-vpip');
              const previous = rect('.prev-hand-card');
              const identity = rect('.table-brand__line--identity');
              const club = rect('.table-brand__club-name');
              const union = rect('.table-brand__union');
              const overlaps = (a: DOMRect, b: DOMRect) =>
                a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
              return {
                buttonHeights: [...document.querySelectorAll('.action-btn, .pre-action-btn')].map(
                  (e) => e.getBoundingClientRect().height
                ),
                buttonBottom: Math.max(
                  ...[...document.querySelectorAll('.action-btn, .pre-action-btn')].map(
                    (e) => e.getBoundingClientRect().bottom
                  )
                ),
                rowTop: row.top,
                rowHeight: row.height,
                rowBottom: row.bottom,
                heroBottom: hero.bottom,
                cardsBottom: cards.bottom,
                scalerHeight: scaler.height,
                vpipOverlaps:
                  overlaps(vpip, previous) || overlaps(vpip, hero) || overlaps(vpip, cards),
                identityFont: parseFloat(
                  getComputedStyle(document.querySelector('.table-brand__line--identity')!).fontSize
                ),
                identityOneLine: Math.abs(club.top - union.top) <= 1,
              };
            });
            expect(measured.vpipOverlaps, 'VPIP clears the previous hand and hero').toBe(false);
            expect(measured.identityFont).toBeLessThanOrEqual(7);
            expect(measured.identityOneLine).toBe(true);
            stableHeight ??= measured.scalerHeight;
            expect(
              measured.scalerHeight,
              'Felt Must Not Resize When The Action Row Changes'
            ).toBeCloseTo(stableHeight, 1);
            expect(
              measured.rowTop,
              `${width}px inset${bottomInset} ticker${ticker} ${state}: hero plate`
            ).toBeGreaterThanOrEqual(measured.heroBottom + 1);
            expect(
              measured.rowTop,
              `${width}px inset${bottomInset} ticker${ticker} ${state}: hero cards`
            ).toBeGreaterThanOrEqual(measured.cardsBottom + 1);
            for (const buttonHeight of measured.buttonHeights)
              expect(buttonHeight, `${state}: readable button`).toBeCloseTo(52, 0);
            expect(
              height - measured.buttonBottom,
              'Buttons Clear The Home Indicator'
            ).toBeGreaterThanOrEqual(Math.max(12, bottomInset) - 1);
            expect(measured.rowBottom).toBeCloseTo(height, 0);
            if (
              width === 393 &&
              bottomInset === 34 &&
              ticker === 32 &&
              state === 'flop' &&
              !swipe
            ) {
              const path = testInfo.outputPath('mobile-actions-below-hero.png');
              await page.screenshot({ path });
              await testInfo.attach('Mobile Actions Below Hero', {
                path,
                contentType: 'image/png',
              });
            }
            await page.unroute('http://actions.fixture/');
          }
        }
      });

// Owner screenshot October 22: the spectator phone must use the broad, tall
// desktop preview instead of inheriting the seated player's compact canvas.
// Each seat count owns its seven viewport cases (plus two tournament cases
// for dense rings). One 60-case test consumed 136 of its 150 seconds on the
// successful baseline and timed out on the same assertions under CI load.
// Partition the work; preserve every geometry and dock-state assertion.
for (const spectatorSeats of [2, 3, 4, 5, 6, 7, 8, 9])
  test(`mobile spectators fill the desktop-reference canvas through hand and dock states at ${spectatorSeats} seats`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const { buildSync } = await import('esbuild');
    const built = buildSync({
      entryPoints: ['tests/e2e/support/portraitRailFixture.tsx'],
      jsx: 'automatic',
      outfile: 'spectator.js',
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      platform: 'browser',
      loader: {
        '.css': 'empty',
        '.png': 'dataurl',
        '.webp': 'dataurl',
        '.svg': 'dataurl',
        '.jpg': 'dataurl',
      },
      define: {
        'import.meta.env': JSON.stringify({
          VITE_SUPABASE_URL: 'https://dummy.supabase.co',
          VITE_SUPABASE_ANON_KEY: 'local-fixture',
          DEV: true,
        }),
        'process.env.NODE_ENV': '"test"',
      },
    });
    const readStyle = (file: string): string =>
      readFileSync(resolve(ROOT, file), 'utf8').replace(
        /^\s*@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/gm,
        (_, imported: string) => readStyle(resolve(dirname(file), imported))
      );
    const sheets = [
      ...new Set([
        'src/styles/club-engine.css',
        'src/styles/animations.css',
        'src/styles/metallic-popups.css',
        'src/styles/reducedMotion.css',
        'src/pages/MultiTablePage.css',
        'src/components/table/TableTabBar.css',
        'src/pages/TablePage.css',
        'src/components/table/ActionPanel.css',
        'src/components/tournament/TournamentHUD.css',
        ...Object.keys(built.metafile!.inputs).filter((f) => f.endsWith('.css')),
        'src/components/table/TableVisualHotfix.css',
      ]),
    ];
    const fontSheet = await page.request.get('https://ca-static.smarter.poker/fonts/fonts.css');
    expect(fontSheet.ok()).toBe(true);
    const inter = [...(await fontSheet.text()).matchAll(/@font-face\s*\{[^}]+\}/g)]
      .map((m) => m[0])
      .find((face) => face.includes("font-family: 'Inter'") && face.includes('U+0000-00FF'))!;
    const fontPath = /url\(([^)]+)\)/.exec(inter)![1];
    const fontResponse = await page.request.get(
      new URL(fontPath.replace('/hub/club-arena/', '/'), 'https://ca-static.smarter.poker').href
    );
    expect(fontResponse.ok()).toBe(true);
    const fontFace = inter
      .replace(/font-weight:\s*\d+;/, 'font-weight: 100 900;')
      .replace(
        fontPath,
        `data:font/woff2;base64,${(await fontResponse.body()).toString('base64')}`
      );
    const realCss = fontFace + '\n' + sheets.map(readStyle).join('\n');
    const avatar = readFileSync(tableArtFixture('vip_wolf@2x.webp'));
    await page.route('**/avatars/table/**', (route) =>
      route.fulfill({ body: avatar, contentType: 'image/webp' })
    );
    await page.route('**/rest/v1/**', (route) => route.fulfill({ json: [] }));
    await page.route('**/cards/**', (route) => {
      const card = new URL(route.request().url()).pathname.split('/cards/')[1];
      const original = resolve(ROOT, 'public/cards', card);
      const fallback = original.replace(/\.webp$/, '.png');
      return route.fulfill({
        body: readFileSync(existsSync(original) ? original : fallback),
        contentType:
          existsSync(original) && original.endsWith('.webp') ? 'image/webp' : 'image/png',
      });
    });
    const viewports = [
      [320, 568],
      [375, 667],
      [393, 852],
      [430, 932],
      [480, 975],
      [393, 852, 47, 34],
      [430, 932, 59, 34],
    ];
    const cases = viewports.map((viewport) => [spectatorSeats, ...viewport]);
    if (spectatorSeats === 6 || spectatorSeats >= 8)
      cases.push([spectatorSeats, 393, 852, 47, 34, 1], [spectatorSeats, 430, 932, 59, 34, 1]);
    for (const [seats, width, height, insetTop = 0, insetBottom = 0, tournament = 0] of cases) {
      await page.setViewportSize({ width, height });
      await page.route('http://spectator.fixture/', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html data-seats="${seats}" data-tournament="${tournament === 1}" data-spectator="true" data-revealed="false" data-jackpot="none"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${applyInsets(realCss, insetTop, insetBottom)}</style></head><body><div id="root"></div></body></html>`,
        })
      );
      await page.goto('http://spectator.fixture/');
      await page.addScriptTag({
        content: built.outputFiles.find((f) => f.path.endsWith('.js'))!.text,
      });
      await expect(page.locator('.seat__info')).toHaveCount(seats);
      await page.waitForFunction(() => {
        const e = document.querySelector<HTMLElement>('.table-scaler')!;
        return (
          Math.abs(
            parseFloat(e.style.getPropertyValue('--table-w')) - e.getBoundingClientRect().width
          ) < 0.5
        );
      });
      await page.evaluate(async () => {
        await document.fonts.load('600 14px Inter');
        await document.fonts.ready;
      });
      const boardCollisions = await page.evaluate(() => {
        const board = document.querySelector('.community-area')!.getBoundingClientRect();
        return [...document.querySelectorAll('.seat__info,.seat__action')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.left < board.right &&
              r.right > board.left &&
              r.top < board.bottom &&
              r.bottom > board.top
            );
          })
          .map((el) => el.className);
      });
      expect(boardCollisions, `${width}px spectator board stays clear of players`).toEqual([]);
      const footer = await page.locator('.spectator-footer-bar').boundingBox();
      const plates = await page
        .locator('.seat__info')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
      expect(
        Math.max(...plates),
        `${width}px bottom observer seat clears the footer`
      ).toBeLessThanOrEqual(footer!.y);
      const canvas = await page.locator('.table-scaler').boundingBox();
      expect(canvas!.width, `${width}px spectator reaches both screen edges`).toBeCloseTo(width, 0);
      const perspective = await page.locator('.table-art').evaluate((el) => {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        return { x: m.m11, y: m.m22, w: m.m44, perspective: m.m24 };
      });
      expect(perspective).toEqual({ x: 1, y: 1, w: 1, perspective: 0 });
      expect(
        canvas!.y + canvas!.height,
        `${seats}-seat spectator reaches the lower screen`
      ).toBeGreaterThan(height * 0.7);
      for (const state of ['none', 'waiting', 'active']) {
        await page.locator('.table-page').evaluate((el, value) => {
          el.setAttribute('data-hero-action', value);
          el.setAttribute('data-tdock', value === 'active' ? 'open' : 'collapsed');
        }, state);
        const next = await page.locator('.table-scaler').boundingBox();
        expect(next!.width).toBeCloseTo(canvas!.width, 1);
        expect(next!.height).toBeCloseTo(canvas!.height, 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      );
      if (width === 393) {
        const screenshot = await page.screenshot({
          path: testInfo.outputPath(
            `mobile-spectator-${seats}-${insetTop ? 'real-insets' : 'after'}.png`
          ),
        });
        await testInfo.attach('mobile-spectator-after', {
          body: screenshot,
          contentType: 'image/png',
        });
      }
      await page.unroute('http://spectator.fixture/');
    }
  });

// Shared notice containment is part of the existing felt browser gate.
import { registerAddOnNoticeContainmentCases } from './support/addOnNoticeContainmentCases';
registerAddOnNoticeContainmentCases();

// Full table captions: owner October 26, 2026. Included in the existing CSS Beat gate.
const fullCaptionCss =
  readFileSync('src/styles/club-engine.css', 'utf8').replace(/@import\s+[^;]+;/g, '') +
  buildCss(process.cwd()) +
  '\n' +
  readFileSync('src/components/table/PotDisplay.css', 'utf8');
const event = 'Morning Free Buy (NLH) · Free Buy';
const longEvent = 'Sunday Morning No Limit Holdem Championship Celebration · 1,000 Buy-In';
const name = 'Alexandria Championship';
const brand = (title: string) => `<div class="table-brand"><div class="table-brand__meta">
  <span class="table-brand__line table-brand__line--identity"><span class="table-brand__club"><span class="table-brand__club-name">Kings Club</span> <span class="table-brand__union">· Midway Union</span></span></span>
  <span class="table-brand__line table-brand__line--level"><span class="table-brand__game">${title}</span><span class="table-brand__hand">Hand #48909509</span></span>
</div></div>`;

for (const [width, height] of [
  [320, 667],
  [375, 667],
  [393, 852],
  [430, 932],
  [844, 390],
  [1440, 900],
]) {
  for (const title of [event, longEvent]) {
    test(`full captions at ${width}x${height}: ${title}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      let html = buildHtml(fullCaptionCss).replace(
        'table-page--embedded"',
        'table-page--embedded table-page--tournament"'
      );
      html = html.replace(
        '<div class="table-scaler">',
        `<div class="table-scaler"><div class="table-surface">${brand(title)}</div>`
      );
      html = html.replace('>HERO<', `>${name}<`);
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.table-brand__game')).toHaveText(title);
      await expect(page.locator('.seat__name')).toHaveText(name);
      const results = await page
        .locator(
          '.table-brand__game, .table-brand__hand, .table-brand__line--identity, .seat__name'
        )
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const el = node as HTMLElement;
            const style = getComputedStyle(el);
            const range = document.createRange();
            range.selectNodeContents(el);
            const box = el.getBoundingClientRect();
            return {
              text: el.textContent,
              overflow: style.overflow,
              ellipsis: style.textOverflow,
              inside: [...range.getClientRects()].every(
                (r) => r.left >= box.left - 1 && r.right <= box.right + 1
              ),
              widthFits: el.scrollWidth <= el.clientWidth + 1,
            };
          })
        );
      for (const result of results) {
        expect(result, result.text || '').toMatchObject({ inside: true, widthFits: true });
        expect(result.ellipsis).not.toBe('ellipsis');
        expect(result.overflow).not.toBe('hidden');
      }
      const game = await page.locator('.table-brand__game').boundingBox();
      const hand = await page.locator('.table-brand__hand').boundingBox();
      expect(hand!.y).toBeGreaterThanOrEqual(game!.y + game!.height - 1);
    });
  }
}

for (const [paneWidth, paneHeight] of [
  [320, 300],
  [164, 320],
  [500, 150],
]) {
  test(`full bubble text stays in a ${paneWidth}x${paneHeight} pane`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { build } = await import('esbuild');
    const message = 'Every Word Must Remain Visible On The Table. '.repeat(5).slice(0, 200);
    const playerName = 'Alexandria Championship Player With A Long Display Name';
    const built = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {ChatBubble} from './src/components/table/ChatBubble';
          createRoot(document.getElementById('fixture')).render(<div className="table-page" style={{position:'relative',width:${paneWidth},height:${paneHeight},minHeight:0}}>
          <div style={{position:'absolute',left:0,top:'50%',width:58,height:48}}>
          <ChatBubble text={${JSON.stringify(message)}} playerName={${JSON.stringify(playerName)}} />
          </div><div style={{position:'absolute',right:0,top:10,width:58,height:48}}>
          <ChatBubble text={${JSON.stringify(message)}} playerName={${JSON.stringify(playerName)}} placement="below" variant="notice" />
          </div></div>);`,
        resolveDir: ROOT,
        loader: 'tsx',
      },
      jsx: 'automatic',
      bundle: true,
      write: false,
      outfile: 'bubble.js',
      format: 'iife',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"test"' },
    });
    await page.setViewportSize({
      width: Math.max(375, paneWidth),
      height: Math.max(500, paneHeight),
    });
    const bubbleCss = readFileSync('src/components/table/ChatBubble.css', 'utf8');
    await page.setContent(
      `<style>body{margin:0;font-family:Inter,sans-serif}${bubbleCss}</style><div id="fixture"></div>`
    );
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await expect(page.locator('.chat-bubble__text')).toHaveCount(2);
    await expect(page.locator('.chat-bubble').first()).toBeVisible();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const boxes = await page.locator('.chat-bubble').evaluateAll((nodes) =>
      nodes.map((node) => {
        const el = node as HTMLElement;
        const box = el.getBoundingClientRect();
        const pane = el.closest('.table-page')!.getBoundingClientRect();
        return {
          text: el.querySelector('.chat-bubble__text')!.textContent,
          name: el.querySelector('.chat-bubble__name')!.textContent,
          fits:
            box.left >= pane.left &&
            box.right <= pane.right &&
            box.top >= pane.top &&
            box.bottom <= pane.bottom,
          complete: [...el.querySelectorAll('span:not(.chat-bubble__tail)')].every(
            (span) => span.scrollHeight <= span.clientHeight + 1
          ),
        };
      })
    );
    for (const box of boxes)
      expect(box).toEqual({ text: message, name: playerName, fits: true, complete: true });
    expect(errors).toEqual([]);
  });
}

test('full run-it-twice and jackpot names wrap on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const css = ['RunItTwice', 'BBJCelebration']
    .map((file) =>
      readFileSync(`src/components/table/${file}.css`, 'utf8').replace(/@import\s+[^;]+;/g, '')
    )
    .join('\n');
  await page.setContent(`<style>body{font-family:Inter,sans-serif}${css}</style>
    <div style="width:110px;display:flex"><span style="width:20px;flex-shrink:0">A</span><span class="rit-panel__player-name">Alexandria Championship</span><span style="width:20px;flex-shrink:0">50%</span></div>
    <div style="width:70px"><div class="bbj-breakdown-name">Alexandria Championship</div></div>`);
  for (const selector of ['.rit-panel__player-name', '.bbj-breakdown-name']) {
    await expect(page.locator(selector)).toBeVisible();
    const result = await page.locator(selector).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const box = el.getBoundingClientRect();
      return {
        ellipsis: getComputedStyle(el).textOverflow,
        fits: [...range.getClientRects()].every(
          (r) => r.left >= box.left - 1 && r.right <= box.right + 1
        ),
      };
    });
    expect(result.fits).toBe(true);
    expect(result.ellipsis).not.toBe('ellipsis');
  }
});

test('painted coverage rejects opaque avatar pixels through rotation and clipping, while transparent canvas stays clear', async ({
  page,
}) => {
  await page.setContent(
    `<div class="table-page" style="position:relative;width:200px;height:200px"><div class="community-area" style="position:absolute;left:70px;top:20px;width:20px;height:20px"></div><img class="seat__avatar-img" style="position:absolute;left:0;top:0;width:100px;height:100px;object-fit:contain;object-position:50% 50%"></div>`
  );
  const covered = async () =>
    (await page.evaluate(readMobileTableLayout, {})).violations.some((value) =>
      value.startsWith('Player Or Bet Covers Board')
    );
  const paint = async (x: number, y: number, width: number, height: number) =>
    page.evaluate(
      async ({ x, y, width, height }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 100;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#ff0000';
        context.fillRect(x, y, width, height);
        const image = document.querySelector<HTMLImageElement>('.seat__avatar-img')!;
        image.src = `${canvas.toDataURL()}#/avatars/table/vip_wolf.webp`;
        await image.decode();
      },
      { x, y, width, height }
    );
  await paint(0, 0, 20, 100);
  expect(await covered(), 'Transparent canvas is not a player').toBe(false);
  await paint(70, 25, 5, 5);
  expect(await covered(), 'Real opaque coverage is still refused').toBe(true);
  expect(await page.locator('.seat__avatar-img').getAttribute('src')).toMatch(
    /\/avatars\/table\/vip_wolf\.webp$/
  );
  const staleMetadata = await page.evaluate(readMobileTableLayout, { 'vip_wolf.webp': 0.95 });
  expect(
    staleMetadata.violations.some((value) => value.startsWith('Player Or Bet Covers Board')),
    'Old crown metadata cannot hide newly painted pixels'
  ).toBe(true);
  await paint(0, 0, 20, 100);
  await page.locator('.seat__avatar-img').evaluate((element) => {
    element.style.transformOrigin = '0 0';
    element.style.transform = 'translate(100px,0) rotate(90deg)';
  });
  await page.locator('.community-area').evaluate((element) => {
    element.style.left = '40px';
    element.style.top = '60px';
  });
  expect(await covered(), 'Rotation must not fill transparent canvas').toBe(false);
  await page.locator('.community-area').evaluate((element) => {
    element.style.top = '5px';
  });
  expect(await covered(), 'Rotated opaque pixels remain protected').toBe(true);
  await page.locator('.seat__avatar-img').evaluate((element) => {
    element.style.transform = 'none';
    element.style.clipPath = 'inset(0 0 60% 0)';
  });
  await paint(0, 0, 100, 100);
  await page.locator('.community-area').evaluate((element) => {
    element.style.top = '60px';
  });
  expect(await covered(), 'The clipped nameplate is not a visible player').toBe(false);
  await page.locator('.community-area').evaluate((element) => {
    element.style.top = '10px';
  });
  expect(await covered(), 'Visible pixels above the clip remain protected').toBe(true);
  await page.locator('.community-area').evaluate((element) => {
    element.style.top = '60px';
  });
  await page.locator('.seat__avatar-img').evaluate((element) => {
    element.style.transform = 'perspective(300px) rotateY(20deg)';
  });
  expect(await covered(), 'Unsupported 3D geometry retains the conservative refusal').toBe(true);
  await page.locator('.seat__avatar-img').evaluate((element) => {
    element.style.transform = 'none';
  });
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  });
  expect(await covered(), 'Unreadable pixels fail closed under the original bounds').toBe(true);
});

test('painted action coverage protects the pill face without inventing paint in its rounded corners', async ({
  page,
}) => {
  await page.setContent(
    `<div class="table-page" style="position:relative;width:200px;height:100px"><div class="community-area" style="position:absolute;left:99px;top:0;width:20px;height:2px"></div><div class="seat__action" style="position:absolute;left:0;top:0;width:100px;height:20px;border-radius:999px;background:#fff"></div></div>`
  );
  const covered = async () =>
    (await page.evaluate(readMobileTableLayout, {})).violations.some((value) =>
      value.startsWith('Player Or Bet Covers Board')
    );
  expect(await covered(), 'An empty rounded corner does not cover a board').toBe(false);
  await page.locator('.community-area').evaluate((element) => {
    element.style.left = '80px';
    element.style.top = '8px';
    element.style.width = '10px';
    element.style.height = '4px';
  });
  expect(await covered(), 'The opaque pill face still refuses coverage').toBe(true);
});

test('the phone action clock uses stationary ink and compositor clips at its real deadline', async ({
  page,
}) => {
  const { buildSync } = await import('esbuild');
  const built = buildSync({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ActionTimerRing} from './src/components/table/ActionTimerRing';const root=createRoot(document.getElementById('root'));window.clockRender=(seconds,delay)=>root.render(<div className="seat seat--active"><div className="seat__info" data-motion="keep" style={{width:120,height:60,position:'relative','--sp-timer-duration':seconds+'s','--sp-timer-delay':delay+'s'}}><ActionTimerRing timing={{'--sp-timer-duration':seconds+'s','--sp-timer-delay':delay+'s'}}/></div></div>);window.clockRender(15,0);`,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    // The fixture installs the real stylesheet below.
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({
    content: readFileSync(resolve(ROOT, 'src/components/table/SeatSlot.css'), 'utf8'),
  });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await expect(page.locator('.seat__timer-wipe')).toHaveCount(5);
  await page.waitForFunction(
    () => (document.querySelector('.seat__timer-wipe')?.getBoundingClientRect().width ?? 0) > 0
  );
  const sample = async (ms: number) =>
    page.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = ms;
      }
      return [...document.querySelectorAll<HTMLElement>('.seat__timer-wipe')].map((w) => {
        const ink = w.querySelector<HTMLElement>('.seat__timer-ink')!;
        const wt = new DOMMatrixReadOnly(getComputedStyle(w).transform),
          it = new DOMMatrixReadOnly(getComputedStyle(ink).transform);
        const sector = w.parentElement!;
        const endX = parseFloat(getComputedStyle(sector).getPropertyValue('--sp-wipe-x'));
        const endY = parseFloat(getComputedStyle(sector).getPropertyValue('--sp-wipe-y'));
        return {
          spent: endX ? wt.m41 / endX : wt.m42 / endY,
          xDrift: wt.m41 + it.m41,
          yDrift: wt.m42 + it.m42,
          duration: parseFloat(getComputedStyle(sector).getPropertyValue('--sp-segment-duration')),
        };
      });
    }, ms);
  for (const ms of [0, 1875, 3750, 7500, 10000, 14999, 15000]) {
    const runs = await sample(ms);
    expect(runs.reduce((n, r) => n + r.duration, 0)).toBeCloseTo(15, 5);
    const spent = runs.reduce((n, r) => n + r.spent * r.duration, 0);
    expect(spent, `clock at ${ms}ms`).toBeCloseTo(ms / 1000, 3);
    for (const run of runs) {
      expect(run.xDrift).toBeCloseTo(0, 4);
      expect(run.yDrift).toBeCloseTo(0, 4);
    }
  }
  const first = await page.locator('.seat__timer-wipe').first().elementHandle();
  await page.evaluate(() => (window as any).clockRender(35, 0));
  await expect(page.locator('.seat__info')).toHaveCSS('--sp-timer-duration', '35s');
  expect(await first!.evaluate((el) => el === document.querySelector('.seat__timer-wipe'))).toBe(
    true
  );
  expect((await sample(7500)).reduce((n, r) => n + r.spent * r.duration, 0)).toBeCloseTo(7.5, 3);
  await page.evaluate(() =>
    ['width', 'min-width', 'max-width'].forEach((p) =>
      document.querySelector<HTMLElement>('.seat__info')!.style.setProperty(p, '180px', 'important')
    )
  );
  await expect(page.locator('.seat__timer-ring')).toHaveCSS('width', '184px');
  expect((await sample(10000)).reduce((n, r) => n + r.spent * r.duration, 0)).toBeCloseTo(10, 3);
});

test('the phone pot shine and on-turn avatar scan retain their paths without repainting backgrounds', async ({
  page,
}, testInfo) => {
  const { buildSync } = await import('esbuild');
  const built = buildSync({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import SeatSlot from './src/components/table/SeatSlot';import PotDisplay from './src/components/table/PotDisplay';const now=Date.now();createRoot(document.getElementById('root')).render(<><SeatSlot seatNumber={1} position="BTN" player={{id:'energy',name:'Player',stack:100,status:'active',showCards:false,isHero:true,avatar:'https://smarter.poker/avatars/table/vip_wolf@2x.webp'}} isActive lastAction={null} turnStartTimeMs={now} turnDeadlineMs={now+15000}/><PotDisplay mainPot={82} bigBlind={2}/></>);`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    outfile: 'energy.js',
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl' },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': JSON.stringify({
        DEV: false,
        PROD: true,
        VITE_SUPABASE_URL: 'https://dummy.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'fixture',
      }),
    },
  });
  await page.route('**/avatars/table/**', (route) =>
    route.fulfill({ path: tableArtFixture('vip_wolf@2x.webp') })
  );
  await page.route('**/rest/v1/**', (route) => route.fulfill({ json: [] }));
  await page.setViewportSize({ width: 393, height: 852 });
  await page.setContent('<div id="root"></div>');
  for (const file of ['SeatSlot.css', 'avatarChoreography.css', 'PotDisplay.css'])
    await page.addStyleTag({
      content: readFileSync(resolve(ROOT, 'src/components/table', file), 'utf8'),
    });
  await page.addStyleTag({
    content:
      'body{background:black;color:white}.seat{position:relative!important;left:0!important;top:0!important;margin:80px 100px;--table-w:366px}.pot-display{position:relative!important;left:0!important;top:0!important}',
  });
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await expect(page.locator('.seat__holo')).toHaveCount(1);
  await expect(page.locator('.seat__avatar-img')).toBeVisible();
  const result = await page.evaluate(() => {
    const holo = document.querySelector<HTMLElement>('.seat__holo')!;
    const pot = document.querySelector<HTMLElement>('.pot-display__main')!;
    const animations = document.getAnimations();
    const scan = animations.find((a) => (a as CSSAnimation).animationName === 'spAvatarHolo')!;
    const shine = animations.find((a) => (a as CSSAnimation).animationName === 'pdGlassSweep')!;
    const scanFrames = (scan.effect as KeyframeEffect).getKeyframes();
    const shineFrames = (shine.effect as KeyframeEffect).getKeyframes();
    for (const a of animations) {
      a.pause();
      a.currentTime = 3700;
    }
    const style = getComputedStyle(holo, '::after');
    return {
      mask: getComputedStyle(holo).maskImage,
      scanDuration: scan.effect!.getTiming().duration,
      scanDelay: scan.effect!.getTiming().delay,
      shineDuration: shine.effect!.getTiming().duration,
      scanTransforms: scanFrames.map((f) => f.transform).filter(Boolean),
      shineTransforms: shineFrames.map((f) => f.transform).filter(Boolean),
      scanPaintsBackground: scanFrames.some((f) => 'backgroundPosition' in f),
      shineMovesLayout: shineFrames.some((f) => 'left' in f),
      opacity: Number(style.opacity),
      scanY: new DOMMatrixReadOnly(style.transform).m42,
      stripHeight: parseFloat(style.height),
      potWidth: pot.getBoundingClientRect().width,
    };
  });
  expect(result.mask).toContain('vip_wolf');
  expect(result.scanDuration).toBe(7000);
  expect(result.scanDelay).toBeCloseTo(3000, -1);
  expect(result.shineDuration).toBe(8000);
  expect(result.scanTransforms).toContain('translateY(480%)');
  expect(result.shineTransforms).toEqual([
    'translateX(-200%)',
    'translateX(400%)',
    'translateX(-200%)',
    'translateX(-200%)',
  ]);
  expect(result.scanPaintsBackground).toBe(false);
  expect(result.shineMovesLayout).toBe(false);
  expect(result.opacity).toBe(1);
  expect(result.scanY / result.stripHeight).toBeCloseTo(2.4, 1);
  expect(result.potWidth).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('phone-energy-cues.png') });
});
