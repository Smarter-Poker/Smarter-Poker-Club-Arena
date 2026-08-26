/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RING INTEGRITY — the invariants that were only ever checked by eye
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * tests/unit/TableSeatGeometry.test.ts already pins the ring's SHAPE (every
 * size has a complete ring, hero at slot 0, nothing off the frame, the rails
 * mirrored, the card-side rule) and tests/table-geometry-chips.test.ts pins
 * the two markers on the felt. Two things they both leave to eye-balling, and
 * both of them moved in the last two days:
 *
 *   1. SEATS THAT DO NOT COLLIDE. The existing check is `new Set(...).size`,
 *      which only catches two seats at the EXACT same coordinates. That is not
 *      the failure mode: 9-max's side rail moved from y 36 to y 30 and 8-max's
 *      from 28 to 23 on 2026-08-25, both of which SHORTEN the gap to the seat
 *      below. Nothing measured whether the seats still fit beside each other,
 *      and a seat is a fixed pixel box on a table whose size is continuous -
 *      so the ring is at its tightest on the smallest phone, which is the one
 *      screen the percentages say nothing about.
 *
 *   2. THE BUTTON AND THE COMMUNITY BOARD. `no seat is given a shorter rail to
 *      keep it off the community board` measures the CHIPS against the board
 *      rectangle, and nothing measures the puck. The puck is placed by a
 *      different construction (a rotation, then a projection onto a boundary
 *      set further in, then a swing around the felt if the two markers are too
 *      close) and that swing is free to walk it anywhere on the felt's arc -
 *      including across the cards. It does not today; that is worth knowing
 *      rather than assuming.
 *
 * Both are measured in PIXELS on real table sizes, because a percentage of a
 * 605x1000 box is not a distance: one point of x is 6.05px and one point of y
 * is 10px, so a gap that looks even in percentages is 1.65x tighter on one
 * axis than on the other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SEAT_LAYOUTS, seatLayoutFor } from '../src/lib/tableSeatGeometry';
import {
  FELT_WINDOW,
  FELT_MARKER_MARGIN_WIDTH_PCT,
  feltCenter,
  dealerButtonPosition,
} from '../src/components/table/tableGeometry';

/**
 * The three table sizes the app actually renders, as measured pixel boxes.
 *
 * `.table-scaler` is `min(100% - 8px, 360px)` on a phone (347px inside a
 * 375px viewport once the container's padding is taken), 600px in tablet
 * portrait and 720px from 1024px up, and its aspect is locked at 605/1000 at
 * every breakpoint - see TablePage.css.
 */
const TABLES = {
  'phone 375px': { w: 347, h: 574 },
  'tablet portrait': { w: 600, h: 992 },
  desktop: { w: 720, h: 1190 },
} as const;

const SIZES = [2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * The width of one villain's seat box, in CSS pixels.
 *
 * `.seat { width: 96px }` in SeatSlot.css, and it is a FIXED pixel width at
 * every breakpoint - the responsive blocks retune `--seat-avatar-base` (84 ->
 * 66 -> 58 -> 52) and nothing else, so the box the ring has to fit does not
 * shrink with the phone. The hero's box is wider still (8/7 of its avatar) but
 * the hero is alone at the bottom of every ring, so the constraint is between
 * two villains.
 *
 * Used as the floor for centre-to-centre separation. It is conservative for a
 * pair stacked vertically (their boxes are taller than they are wide) and
 * exact for a pair side by side, which is the direction the top cap is tight
 * in.
 */
const SEAT_BOX_W_PX = 96;

const SEAT_CSS = readFileSync(resolve(__dirname, '../src/components/table/SeatSlot.css'), 'utf8');

describe('the seat box this file measures against is the one the stylesheet draws', () => {
  it('SeatSlot.css still gives a villain seat a fixed 96px box', () => {
    // If this fails, `.seat`'s width changed and SEAT_BOX_W_PX above is stale -
    // which would make every separation assertion below quietly wrong rather
    // than red. Fix the constant, then re-read the failures.
    expect(SEAT_CSS).toMatch(/\n\.seat\s*\{[\s\S]{0,4000}?\n\s*width:\s*96px;/);
  });
});

describe('no two seats collide, at any table size', () => {
  /**
   * The tightest table is the smallest one, so that is where this is measured.
   * Observed minimums when this was written (2026-08-25): 141px on 9-max
   * (the side rail's bottom-cap-to-low pair, and the 8-max equivalent at
   * 166px), against a 96px box. The 45px of headroom is the margin a future
   * ring nudge is spending.
   */
  const phone = TABLES['phone 375px'];
  const pxGap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(((a.x - b.x) * phone.w) / 100, ((a.y - b.y) * phone.h) / 100);

  it.each(SIZES)('%i-max keeps every pair of seats at least a seat-box apart', (n) => {
    const ring = seatLayoutFor(n);
    for (let i = 0; i < ring.length; i++) {
      for (let j = i + 1; j < ring.length; j++) {
        expect(
          pxGap(ring[i], ring[j]),
          `${n}-max: seats ${JSON.stringify(ring[i])} and ${JSON.stringify(ring[j])} are ` +
            `${pxGap(ring[i], ring[j]).toFixed(0)}px apart on a ${phone.w}px table`
        ).toBeGreaterThanOrEqual(SEAT_BOX_W_PX);
      }
    }
  });

  it('the two top-cap seats clear each other horizontally, not just diagonally', () => {
    // The one pair whose whole separation is horizontal, so the seat box's
    // WIDTH is the entire budget. 9-max/7-max put them at x 27 and 73 (160px
    // apart on a phone); 3-max/5-max at 20.5 and 79.5 (205px).
    for (const n of SIZES) {
      const cap = seatLayoutFor(n).filter((s) => s.y < 20);
      if (cap.length < 2) continue;
      const xs = cap.map((s) => s.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        expect(
          ((xs[i] - xs[i - 1]) * phone.w) / 100,
          `${n}-max top cap: x ${xs[i - 1]} and ${xs[i]}`
        ).toBeGreaterThanOrEqual(SEAT_BOX_W_PX);
      }
    }
  });
});

describe('the dealer button is never on the community board', () => {
  /**
   * The same board rectangle tests/table-geometry-chips.test.ts measures the
   * CHIPS against: the middle 68% of the felt's width, five cards at 64:92,
   * centred on the felt. Restated here rather than shared because the two
   * files assert about different markers and neither should be able to loosen
   * the other's definition of where the cards are.
   */
  const c = feltCenter();
  const boardHalfW = 0.34 * FELT_WINDOW.width;
  const cardW = (0.68 * FELT_WINDOW.width) / 5;
  const boardHalfH = ((cardW * 92) / 64 / 2) * (1000 / 605);
  // The puck's own radius, in percent of the table's width. Its centre being
  // off the board is not enough - the disc must be.
  const puckHalf = FELT_MARKER_MARGIN_WIDTH_PCT;

  for (const [label, table] of Object.entries(TABLES)) {
    it(`${label}: no seat on any ring puts its puck on the cards`, () => {
      for (const n of SIZES) {
        for (const seat of SEAT_LAYOUTS[n]) {
          const b = dealerButtonPosition(seat, table);
          const onBoardX = Math.abs(b.x - c.x) < boardHalfW + puckHalf;
          const onBoardY = Math.abs(b.y - c.y) < boardHalfH + puckHalf * (1000 / 605);
          expect(
            onBoardX && onBoardY,
            `${n}-max ${label}: seat ${JSON.stringify(seat)} put its button at ` +
              `${b.x.toFixed(1)},${b.y.toFixed(1)} - on the board`
          ).toBe(false);
        }
      }
    });
  }
});
