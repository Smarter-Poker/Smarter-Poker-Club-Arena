/**
 * Dan 2026-08-19, bug list items 1 and 3:
 *   (1) "hero must be centered directly above their player box, not offset"
 *   (3) "PLO4/PLO5/PLO6 cards ~50% larger"
 *
 * These two are the same layout problem. The hero hole-card row used to hang
 * off the RIGHT of the seat (`left: calc(100% + gap)`), which is what made the
 * hero read as off-centre AND what kept PLO cards small: everything to the
 * right of the seat had to fit in the ~100px of felt left over on a phone, so
 * a six-card hand was squeezed to 30x42. Centring the row over the seat
 * replaces that ~100px budget with the full width of the scaler, which is what
 * makes a 50% size increase fit at all.
 *
 * This spec renders the real SeatSlot.css against the seat markup SeatSlot.tsx
 * emits, at all four breakpoints, and measures the result. It needs no dev
 * server and no login - it is pure geometry, so it can never go stale against
 * a running game.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(process.cwd(), 'src/components/table/SeatSlot.css'), 'utf8');

/* Two markups, because the row geometry has to hold for both.
 *
 * WRAPPED is what SeatSlot.tsx emits today: each card sits inside its own
 * `.seat__card-pick` span (added 2026-08-18 for click-to-show).
 * BARE is a card that IS the flex child, which is what this harness used to
 * render exclusively and what the row looked like before the wrapper landed.
 *
 * The CSS comment claims the geometry is "independent of how the card is
 * wrapped". It was not: `.seat__cards--hero .seat__card { margin-left: 0 }`
 * is 0-2-0 and out-specified the `> *` overlap rule at 0-1-0, so a BARE card
 * lost its overlap entirely and PLO6 measured 6 x 54 = 324px inside a 320px
 * felt. Testing only one markup is how that shipped. Test both.
 */
type Markup = 'wrapped' | 'bare';

const cardHtml = (markup: Markup) =>
  markup === 'wrapped'
    ? '<span class="seat__card-pick"><div class="seat__card seat__card--face"></div></span>'
    : '<div class="seat__card seat__card--face"></div>';

const seatHtml = (n: number, markup: Markup) => `
<div class="table-scaler">
  <div class="seat seat--hero seat--in-hand">
    <div class="seat__avatar-wrap"><div class="seat__avatar"></div></div>
    <div class="seat__info"><span class="seat__name">HERO</span><span class="seat__stack">1,000</span></div>
    <div class="seat__cards seat__cards--hero">
      ${Array.from({ length: n }, () => cardHtml(markup)).join('')}
    </div>
  </div>
</div>`;

// Stand-ins for the pieces SeatSlot does not own: the felt the row must stay
// inside, and the avatar/name-plate boxes. Animations are disabled because the
// deal-in keyframe starts at rotateY(90deg), which would measure as zero width.
const harnessCss = `
  * { box-sizing: border-box; animation: none !important; }
  body { margin: 0; }
  /* ── 2026-08-28: THE FELT IS A PARAMETER, AND IT PUBLISHES --table-w ───────
     This was a flat "width: min(320px, 100vw); height: 560px" at every
     breakpoint, which was fine while cards were sized by a px ladder keyed on
     the VIEWPORT: the fixture's own felt was irrelevant to the answer.
     (Quoted with " and not with a backtick on purpose - this comment lives
     inside a JS template literal, and a backtick here ends the string.)

     It is not fine now. Cards are a fraction of --table-w, the felt's measured
     width, which TablePage.tsx publishes from a ResizeObserver on the real
     scaler. A fixture that fakes a felt and does NOT publish --table-w makes
     the cards size themselves from something with no relationship to the box
     they have to fit inside — so every "inside the felt" beat below would be
     measuring a coincidence. That is exactly how this file failed on the first
     run of the proportional change, and it was right to.

     So the harness does what the app does: it sets a felt width per breakpoint
     and publishes that same number as --table-w. The widths are not invented —
     they are what scripts/dev/measure-felt.mjs reports the real cascade
     produces at each of these viewports at this file's 900px height. Note that
     tablet and phone come out WIDER than desktop: the felt is derived from
     leftover height, and the mobile blocks reserve far less of it at the top. */
  .table-scaler { position: relative; width: var(--harness-felt-w); height: 560px; margin: 0 auto; --table-w: var(--harness-felt-w); }
  .seat { position: absolute; left: 50%; bottom: 40px; transform: translateX(-50%); }
  .seat__avatar { width: var(--seat-avatar-size, 84px); height: var(--seat-avatar-size, 84px); border-radius: 50%; }
  .seat__info { width: 100%; height: 34px; }
`;

/** `feltW` is measured, not chosen: `node scripts/dev/measure-felt.mjs` at each
 *  of these viewports with this file's 900px height. Re-run it if the height
 *  budget in TablePage.css changes, rather than nudging these by hand. */
const BREAKPOINTS = [
  { label: 'desktop', width: 1280, feltW: 383 },
  { label: 'tablet', width: 640, feltW: 419 },
  { label: 'phone', width: 480, feltW: 426 },
  { label: 'small phone', width: 375, feltW: 351 },
];

/** The card's share of the felt, and the floor below which legibility wins over
 *  proportion. Both are declared once on `.seat` in SeatSlot.css; restated here
 *  so a change to either fails against this file's own arithmetic rather than
 *  silently re-baselining it. */
const CARD_FRACTION_OF_FELT = 0.139;
/* 2026-08-28: 44 -> 50. 44px was the pre-#1571 hold'em card Dan had rejected
   that morning, so wherever the floor bound it silently reinstated the exact
   size he had just had fixed — on an iPhone SE, both landscapes, a 1280x800
   laptop, and on the first frame of EVERY table (scalerSize starts at 320px).
   50 rather than 51 so the crossover sits just UNDER what the canonical iPhone
   12/13/14 felt yields from the fraction (366 x 0.139 = 50.87), which keeps that
   device governed by the proportion instead of by the floor. See the note on
   --sp-card2-w, and CARD_FLOOR in table-proportions.spec.ts. */
const CARD_FLOOR_PX = 50;
const expectedCardW = (feltW: number) => Math.max(CARD_FLOOR_PX, feltW * CARD_FRACTION_OF_FELT);

async function measure(
  page: import('@playwright/test').Page,
  n: number,
  markup: Markup = 'wrapped',
  feltW = 351
) {
  await page.setContent(
    `<style>${css}\n${harnessCss}\n:root{--harness-felt-w:${feltW}px}</style>${seatHtml(n, markup)}`
  );
  return page.evaluate(() => {
    const q = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const scaler = q('.table-scaler');
    const seat = q('.seat');
    const row = q('.seat__cards--hero');
    /* The card is measured by its LAYOUT box (offsetWidth/Height), not its
       bounding rect. Since 2026-08-26 a 4+ card hero hand carries the
       PokerBros held-hand arc — each card is rotated a few degrees — and a
       rotated element's getBoundingClientRect is its axis-aligned visual
       bbox, inflated by the rotation. What these beats pin is the TOKEN
       geometry (w, h, step), which lives in layout; the arc is deliberate
       art on top of it and must not read as a size change here. */
    const cardEl = document.querySelector('.seat__card') as HTMLElement;
    return {
      feltLeft: scaler.left,
      feltRight: scaler.right,
      seatCentreX: seat.left + seat.width / 2,
      seatRight: seat.right,
      seatTop: seat.top,
      seatBottom: seat.bottom,
      rowTop: row.top,
      rowLeft: row.left,
      rowRight: row.right,
      rowCentreX: row.left + row.width / 2,
      rowCentreY: row.top + row.height / 2,
      rowBottom: row.bottom,
      cardW: cardEl.offsetWidth,
      cardH: cardEl.offsetHeight,
      feltW: scaler.width,
      /* RESOLVED THROUGH A REAL PROPERTY, NEVER READ AS TEXT (2026-08-28).
         This was
           parseFloat(getComputedStyle(row).getPropertyValue('--sp-hero-card-step'))
         which worked only while the token was a px literal. An unregistered
         custom property computes to its token stream with var()s substituted,
         NOT to a length, so the moment step became `calc(var(--sp-card2-w) *
         0.72)` that parseFloat returned NaN — and `toBeCloseTo(NaN)` fails
         against every real number, which is why 38 beats in this file went red
         at once while the row itself measured perfectly.
         Assigning the token to `width` on a throwaway element and reading the
         used value is the only honest way to get a number out of it. */
      step: (() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;visibility:hidden';
        probe.style.width = 'var(--sp-hero-card-step)';

        /* THE PROBE GOES INSIDE THE FIRST CARD, NOT INSIDE THE ROW, and this
           is not fussiness — putting it in the row silently changes the answer.

           The PLO guards are `.seat__cards--hero:has(> *:nth-child(4|5|6))`,
           which count the row's DIRECT children. A probe appended to the row is
           one more direct child, so a 4-card row starts matching the 5-card
           guard and a 5-card row the 6-card guard: measuring the step is what
           gives it the wrong step. The first version of this fix did exactly
           that, and it failed the 4- and 5-card beats at every breakpoint while
           2 and 6 passed (2 is below the first guard, 6 is above the last, so
           neither has a rule an extra child can reach).

           A GRANDCHILD is invisible to `> *:nth-child()` and still inherits
           every custom property, so it reads the same tokens the cards read
           without being counted as one. This is the same `:nth-child` trap the
           header of this file is about — the `.seat__card-pick` wrapper — and
           it bit the test rather than the stylesheet this time. */
        const host = document.querySelector('.seat__cards--hero')!.firstElementChild!;
        host.appendChild(probe);
        const px = parseFloat(getComputedStyle(probe).width);
        probe.remove();
        return px;
      })(),
    };
  });
}

for (const bp of BREAKPOINTS) {
  test.describe(`hero hole-card row @ ${bp.label} (${bp.width}px)`, () => {
    test.use({ viewport: { width: bp.width, height: 900 } });

    for (const n of [2, 4, 5, 6]) {
      for (const markup of ['wrapped', 'bare'] as const) {
        test(`${n} cards (${markup}): beside the plate, inside the viewport`, async ({ page }) => {
          const m = await measure(page, n, markup, bp.feltW);

          /* Dan 2026-08-22, mobile audit item 2, verbatim: "THE HERO CARDS
             NEED TO BE NEXT TO THE HERO, NOT ON TOP OF THE TABLE."

             This retires the 2026-08-19/-21 split (hold-em beside, PLO centred
             above). EVERY hand size now hangs off the right of the seat,
             vertically centred on the avatar. It fits because the hero avatar
             itself moved to y:100 of the scaler - the space to the seat's
             right is backdrop, not felt - and the row tucks 10px behind the
             avatar's right edge (`left: calc(100% - 10px)`), which is what
             keeps a PLO6 row inside a 375px viewport.

             The horizontal bound that matters is therefore the VIEWPORT, not
             the felt: the row deliberately overhangs the scaler's right edge
             on a desktop-width felt, and that is fine as long as every card
             stays on screen at phone width. */
          expect(
            m.rowLeft,
            'the row must start beside the seat (10px tuck allowed), never across it'
          ).toBeGreaterThanOrEqual(m.seatRight - 11);

          /* BESIDE the plate, not adrift on the felt. Without an upper bound,
             a row that floated away from its owner entirely would still pass
             the assertion above. 24px leaves room for the gap/tuck tokens to
             be tuned at any breakpoint and is far below the distance that
             would read as detached. */
          expect(
            m.rowLeft - m.seatRight,
            'the row drifted away from the plate'
          ).toBeLessThanOrEqual(24);

          /* Beside means LEVEL with the plate, not floating above it. The row
             is centred on the avatar half of the seat, so its centre must land
             inside the seat's vertical span at every breakpoint. */
          expect(m.rowCentreY, 'the row sits above the plate').toBeGreaterThanOrEqual(m.seatTop);
          expect(m.rowCentreY, 'the row sits below the plate').toBeLessThanOrEqual(m.seatBottom);

          // Never escapes the viewport - every card stays visible on screen.
          expect(m.rowLeft).toBeGreaterThanOrEqual(m.feltLeft);
          expect(m.rowRight).toBeLessThanOrEqual(bp.width);

          // Cards are actually rendered.
          expect(m.cardW).toBeGreaterThan(0);
          expect(m.cardH).toBeGreaterThan(0);

          /* The row is exactly w + (n - 1) * step. Asserting the total width, not
           just "inside the felt", is what catches a lost overlap on a hand size
           small enough to still fit: a 4-card row with no overlap is 240px,
           inside the 320px felt, and wrong. */
          expect(m.rowRight - m.rowLeft).toBeCloseTo(m.cardW + (n - 1) * m.step, 0);
        });
      }
    }

    test('PLO cards stay big, and are a fixed fraction of the felt', async ({ page }) => {
      /* RETARGETED 2026-08-28. This used to divide the rendered card by the
         pre-2026-08-19 PLO literals and require the ratio to be ~1.5 at each
         breakpoint. That comparison is no longer expressible: those literals
         were viewport-keyed and the card is felt-keyed now, so the two sides
         are not measuring the same axis and the ratio drifts with the height
         budget rather than with anything anyone decided.

         What the beat was FOR survives in two halves, and both are stronger
         than the ratio was:

           1. PLO must not quietly shrink back to the pre-enlargement set.
           2. The card must be the SAME fraction of the felt at every hand size
              and every breakpoint — which is the rule Dan actually asked for
              ("my buttons and cards look the same no matter if I'm on a phone,
              or a tablet") and which the old per-breakpoint ratio could not
              state at all. */
      const BEFORE: Record<string, Record<number, number>> = {
        desktop: { 4: 40, 5: 38, 6: 36 },
        tablet: { 4: 38, 5: 36, 6: 34 },
        phone: { 4: 34, 5: 32, 6: 30 },
        'small phone': { 4: 30, 5: 28, 6: 26 },
      };
      /* PLO5 and PLO6 step DOWN from PLO4 to hold the row width roughly
         constant — 0.95 and 0.90 of the shared card, declared in SeatSlot.css. */
      const HAND_FACTOR: Record<number, number> = { 4: 1, 5: 0.95, 6: 0.9 };

      for (const n of [4, 5, 6]) {
        const m = await measure(page, n, 'wrapped', bp.feltW);

        expect(
          m.cardW,
          `PLO${n} at ${bp.label} shrank back towards the pre-2026-08-19 size`
        ).toBeGreaterThan(BEFORE[bp.label][n]);

        const want = expectedCardW(m.feltW) * HAND_FACTOR[n];
        /* ONE PIXEL, because `m.cardW` is `offsetWidth` and offsetWidth is
           ROUNDED TO AN INTEGER by definition, while `want` is a product of two
           fractions and lands anywhere.

           This was `toBeCloseTo(want, 0)` — a difference strictly under 0.5 —
           which is a tolerance the measurement cannot honour: whenever `want`
           falls on an exact half, the integer offsetWidth is 0.5 away from it
           and the assertion fails on arithmetic rather than on layout. Raising
           the card floor to 50 made PLO5 at the small-phone felt land on exactly
           47.5 (offsetWidth 48) and turned that latent flaw into a red test.

           The row is measured by its layout box on purpose — see the note in
           `measure()`, the arc rotates the visual bbox — so the integer is not
           negotiable and the tolerance has to be. 1px still catches every real
           regression here: the sizes this pins are 26-100px apart, and the thing
           that breaks them is a reintroduced breakpoint, which moves a card by
           six pixels or more, never by one. */
        expect(
          Math.abs(m.cardW - want),
          `PLO${n} at ${bp.label}: card is ${m.cardW}px on a ${m.feltW}px felt ` +
            `(${((m.cardW / m.feltW) * 100).toFixed(1)}%), expected ~${want.toFixed(1)}px`
        ).toBeLessThanOrEqual(1);

        // The 2.5:3.5 playing-card ratio, exact so the art is never resampled.
        expect(m.cardH / m.cardW, `PLO${n} at ${bp.label} is not the 2.5:3.5 card`).toBeCloseTo(
          1.4,
          1
        );
      }
    });

    test('hold-em hole cards are the SAME SIZE as PLO', async ({ page }) => {
      /* REPLACES "hold-em hole cards are NOT resized" (Dan 2026-08-27):
         "THE CARDS INSIDE OF THE CLUB ARENA FOR HOLDEM GAMES WERE NEVER
          CHANGED. THEY NEED TO BE THE SAME SIZE CARDS WE USE FOR PLO INSIDE OF
          HOLDEM ... THE SAME AS PLO GLOBALLY."

         The old test guarded the opposite invariant. When PLO went up 50% on
         2026-08-19 the two-card set was left behind on the reasoning that the
         enlargement must not "leak" into hold-em — and this test then held that
         gap in place for eight days. It was the wrong reading of the constraint:
         the PLO sizes are capped by ROW WIDTH, and a two-card row is the
         narrowest on the felt, so hold-em always had the most room of anyone.

         PLO4 is the reference: it is the largest of the three PLO sets, and
         PLO5/6 step down from it only to hold the row width constant.

         The 2px tolerance is inherited and still right — it lets the art be
         nudged a pixel without four phantom failures a run, and is nowhere near
         wide enough to hide a real divergence, which would be 15px or more. */
      /* THE MAP OF LITERALS THAT WAS HERE IS GONE (2026-08-28), and its absence
         is the improvement. It was `{ desktop: [60, 84], tablet: [57, 80], ... }`
         — the four rungs of the px ladder, restated in a test file, which meant
         the beat could only ever speak about four widths. A tablet at 768px is
         not one of them, and a tablet is where Dan noticed the bug this whole
         pass is about.

         The card is a fraction of the felt now, so the expectation is computed
         from the felt this fixture is actually rendering rather than looked up,
         and it holds at any width including the ones nobody enumerated. */
      const m = await measure(page, 2, 'wrapped', bp.feltW);

      const want = expectedCardW(m.feltW);
      expect(
        m.cardW,
        `hold-em card at ${bp.label}: ${m.cardW}px on a ${m.feltW}px felt ` +
          `(${((m.cardW / m.feltW) * 100).toFixed(1)}%), expected ~${want.toFixed(1)}px`
      ).toBeCloseTo(want, 0);
      // 2.5:3.5, exact, so the card art is never resampled.
      expect(m.cardH / m.cardW, `hold-em card at ${bp.label} is not the 2.5:3.5 card`).toBeCloseTo(
        1.4,
        1
      );

      /* The invariant itself, measured rather than asserted from a map: a
         hold-em card and a PLO4 card are the same rectangle on the same felt. */
      const plo4 = await measure(page, 4, 'wrapped', bp.feltW);
      expect(
        Math.abs(m.cardW - plo4.cardW),
        `hold-em vs PLO4 width at ${bp.label}`
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(m.cardH - plo4.cardH),
        `hold-em vs PLO4 height at ${bp.label}`
      ).toBeLessThanOrEqual(2);
    });
  });
}
