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
  .table-scaler { position: relative; width: min(320px, 100vw); height: 560px; margin: 0 auto; }
  .seat { position: absolute; left: 50%; bottom: 40px; transform: translateX(-50%); }
  .seat__avatar { width: var(--seat-avatar-size, 84px); height: var(--seat-avatar-size, 84px); border-radius: 50%; }
  .seat__info { width: 100%; height: 34px; }
`;

const BREAKPOINTS = [
  { label: 'desktop', width: 1280 },
  { label: 'tablet', width: 640 },
  { label: 'phone', width: 480 },
  { label: 'small phone', width: 375 },
];

async function measure(
  page: import('@playwright/test').Page,
  n: number,
  markup: Markup = 'wrapped'
) {
  await page.setContent(`<style>${css}\n${harnessCss}</style>${seatHtml(n, markup)}`);
  return page.evaluate(() => {
    const q = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const scaler = q('.table-scaler');
    const seat = q('.seat');
    const row = q('.seat__cards--hero');
    const card = q('.seat__card');
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
      rowBottom: row.bottom,
      cardW: card.width,
      cardH: card.height,
      step: parseFloat(
        getComputedStyle(document.querySelector('.seat__cards--hero')!).getPropertyValue(
          '--sp-hero-card-step'
        )
      ),
    };
  });
}

for (const bp of BREAKPOINTS) {
  test.describe(`hero hole-card row @ ${bp.label} (${bp.width}px)`, () => {
    test.use({ viewport: { width: bp.width, height: 900 } });

    for (const n of [2, 4, 5, 6]) {
      for (const markup of ['wrapped', 'bare'] as const) {
        const placement = n < 4 ? 'beside the plate' : 'centred above the plate';
        test(`${n} cards (${markup}): ${placement}, inside the felt`, async ({ page }) => {
          const m = await measure(page, n, markup);

          if (n < 4) {
            /* Dan 2026-08-21, bug list item 11, verbatim: "hole cards MUST ALWAYS
             appear to the RIGHT of the hero, not on top of the profile."

             This supersedes item 1 for hold-em. The centred-above row put two
             cards across the hero's own avatar and name on a 375px phone, which
             is the thing item 11 is about. PLO keeps the centred layout below,
             because a six-card row hung off the right of a bottom-centre seat
             runs clean off the felt — that exception is why the CSS is written
             as :not(:has(4th child)) rather than an unconditional rule.

             This spec asserted centring for every hand size, so the moment the
             CSS started honouring item 11 the suite went red on correct code —
             eight failures that described the fix as the bug. */
            expect(
              m.rowLeft,
              'the row must start at or past the seat, never over it'
            ).toBeGreaterThanOrEqual(m.seatRight - 1);

            // Beside means level with the plate, not floating above it: the row's
            // own vertical span has to overlap the seat's.
            expect(m.rowTop).toBeLessThan(m.seatBottom);
            expect(m.rowBottom).toBeGreaterThan(m.seatTop);
          } else {
            // Item 1 still governs PLO: centred on the seat, not offset to one side.
            expect(Math.abs(m.rowCentreX - m.seatCentreX)).toBeLessThanOrEqual(1);

            // Directly ABOVE the box, not overlapping it.
            expect(m.rowBottom).toBeLessThanOrEqual(m.seatTop);
          }

          // Never escapes the felt on either side.
          expect(m.rowLeft).toBeGreaterThanOrEqual(m.feltLeft);
          expect(m.rowRight).toBeLessThanOrEqual(m.feltRight);

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

    test('PLO cards are 50% larger than a hold-em card row was sized for', async ({ page }) => {
      // The pre-2026-08-19 PLO token sets, per breakpoint, as [w, h].
      const BEFORE: Record<string, Record<number, [number, number]>> = {
        desktop: { 4: [40, 56], 5: [38, 53], 6: [36, 50] },
        tablet: { 4: [38, 53], 5: [36, 50], 6: [34, 47] },
        phone: { 4: [34, 47], 5: [32, 45], 6: [30, 42] },
        'small phone': { 4: [30, 42], 5: [28, 39], 6: [26, 36] },
      };
      for (const n of [4, 5, 6]) {
        const m = await measure(page, n);
        const [beforeW, beforeH] = BEFORE[bp.label][n];
        // "~50% larger" - the token values are whole pixels, so the ratio
        // lands within a pixel of 1.5 rather than exactly on it (e.g. PLO5 at
        // desktop is 53 -> 80, a ratio of 1.509).
        expect(m.cardW / beforeW).toBeCloseTo(1.5, 1);
        expect(m.cardH / beforeH).toBeCloseTo(1.5, 1);
      }
    });

    test('hold-em hole cards are NOT resized', async ({ page }) => {
      const HOLDEM: Record<string, [number, number]> = {
        desktop: [44, 62],
        tablet: [42, 58],
        phone: [36, 50],
        'small phone': [32, 44],
      };
      const m = await measure(page, 2);
      expect([m.cardW, m.cardH]).toEqual(HOLDEM[bp.label]);
    });
  });
}
