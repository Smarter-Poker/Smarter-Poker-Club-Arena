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

import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import {
  buildCss,
  buildHtml,
  DEVICES,
  PROBE,
  CALIBRATION,
  measureAll,
} from './support/feltHarness.mjs';

/* process.cwd(), not __dirname: importing the .mjs harness puts this file in ES
   module scope, where __dirname does not exist. hero-card-row.spec.ts resolves
   the same way, and Playwright runs from the project root. */
const ROOT = resolve(process.cwd());
const css = buildCss(ROOT);

/** Declared once on `.seat` in SeatSlot.css. Restated here so a change to either
 *  fails against this file's arithmetic rather than silently re-baselining it. */
const CARD_FRACTION = 0.139;
const AVATAR_FRACTION = 0.158;
/** Legibility floors, the one place a proportion is deliberately overruled. */
const CARD_FLOOR = 44;
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
