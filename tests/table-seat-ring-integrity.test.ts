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
  buttonRadiusWidthPct,
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
/**
 * ─── 2026-08-28: THIS IS A FUNCTION NOW, BECAUSE THE BOX IS NOT FIXED ────────
 *
 * It was `const SEAT_BOX_W_PX = 96`, and the paragraph above said the box "is a
 * FIXED pixel width at every breakpoint". That stopped being true when the seat
 * stopped being drawn from a px ladder: `.seat` is
 * `max(<text floor>, var(--seat-avatar-full) * 1.143)` and --seat-avatar-full is
 * 15.8% of the felt's measured width, so a bigger table now draws a bigger box.
 *
 * THE COLLISION MATHS SURVIVES THAT, and it is worth writing down why rather
 * than trusting it. Seat separations are percentages of the felt, so they scale
 * linearly with it. The box's proportional term is 0.158 x 1.143 = 18.06% of the
 * felt, which is also linear. Two quantities that scale linearly with the same
 * number keep their ratio, so a table that clears at one size clears at every
 * size. The only regime where the ratio moves is where the FLOOR binds — small
 * felts — and there the floor is a constant against a shrinking separation,
 * which is the tight case this file already measures at the phone size.
 *
 * 96 is kept as the floor here even though a real phone renders 72-88px (the
 * 380 / 480 / 640 rungs), because over-stating the box only ever makes these
 * assertions stricter.
 */
const seatBoxWPx = (feltW: number) => Math.max(96, feltW * 0.158 * 1.143);

const SEAT_CSS = readFileSync(resolve(__dirname, '../src/components/table/SeatSlot.css'), 'utf8');

describe('the seat box this file measures against is the one the stylesheet draws', () => {
  it('SeatSlot.css still draws the villain box seatBoxWPx() models', () => {
    // If this fails, `.seat`'s width changed and seatBoxWPx above is stale -
    // which would make every separation assertion below quietly wrong rather
    // than red. Fix the constant, then re-read the failures.
    //
    // READ THE RULE, DO NOT COUNT CHARACTERS. This was
    // `/\n\.seat\s*\{[\s\S]{0,4000}?\n\s*width:\s*96px;/` — the declaration had
    // to fall within 4000 characters of the opening brace. `.seat` is where
    // every seat-wide design token is declared, and every one of them arrives
    // with the paragraph explaining why, so on 2026-08-27 documenting one token
    // pushed `width` past the budget and failed this beat. Nothing about the
    // seat box had changed; the comment above it had got longer, which is the
    // opposite of a regression.
    //
    // Stripping comments first and then matching the rule's own body pins
    // exactly what the constant depends on and cannot be moved by prose.
    const cssNoComments = SEAT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const seatRule = cssNoComments.match(/\n\.seat\s*\{([^{}]*)\}/);
    expect(seatRule, 'the base `.seat` rule went missing entirely').toBeTruthy();

    /* 2026-08-28: was `/\n\s*width:\s*96px;/`. The box is
       `max(96px, var(--seat-avatar-full) * 1.143)` now — 96 is still the floor,
       and the floor is what the separation assertions below are conservative
       against, so what has to be pinned is BOTH halves: the literal floor this
       file's arithmetic assumes, and the 1.143 coefficient seatBoxWPx() models.
       Pinning only the floor would let the coefficient drift and leave every
       assertion below quietly wrong on a large table rather than red. */
    const width = seatRule![1].match(/\n\s*width:\s*([^;]+);/);
    expect(width, 'the base `.seat` rule no longer declares a width').toBeTruthy();
    expect(
      width![1].replace(/\s+/g, ' '),
      'seatBoxWPx() above models max(96px, --seat-avatar-full * 1.143); if this ' +
        'changed, update that function and re-read the failures'
    ).toBe('max(96px, calc(var(--seat-avatar-full) * 1.143))');
  });
});

describe('no two seats collide, at any table size', () => {
  /**
   * The tightest table is the smallest one, so that is where this is measured.
   *
   * Observed minimums when this was written (2026-08-25): 141px on 9-max — the
   * side rail's bottom-cap-to-low pair — against a 96px box, so 45px of
   * headroom was the margin a future ring nudge had to spend.
   *
   * It spent 13 of them on 2026-08-27. The 95% board pushed every side seat out
   * of the felt's middle, which drove the high seats up to y 26 and so closer
   * to the top-cap diagonals: the tightest pair on the whole estate is now
   * 7-max and 9-max's (10.5, 26) beside (27, 6) at 128px, with 8-max's
   * bottom-cap-to-low pair next at 141px. 32px of headroom left.
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
        ).toBeGreaterThanOrEqual(seatBoxWPx(phone.w));
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
        ).toBeGreaterThanOrEqual(seatBoxWPx(phone.w));
      }
    }
  });
});

describe('the dealer button is never on the community board', () => {
  /**
   * The same board rectangle tests/table-geometry-chips.test.ts measures the
   * CHIPS against: the middle 95% of the felt's width, five cards at 64:92,
   * centred on the felt's midline and hung from `.community-area`'s own
   * anchor. Restated here rather than shared because the two files assert
   * about different markers and neither should be able to loosen the other's
   * definition of where the cards are.
   *
   * ── THE AXIS CONVERSION WAS UPSIDE DOWN (fixed 2026-08-27) ────────────────
   * A card's height is computed in percent of the table's WIDTH, so turning it
   * into percent of the table's HEIGHT means multiplying by w/h (0.605). This
   * used `(1000 / 605)` — h/w — which overstated the board's height by 2.73x,
   * and it hung the rectangle on `feltCenter().y` (49.05%) when the board
   * actually sits at 43.03%. The same two errors were in the chips file and
   * are fixed there in the same commit. An over-tall model does not fail safe:
   * it reports a collision that is not on the screen, against a marker
   * position that is real, and the next reader believes it.
   */
  const BOARD_FELT_FRACTION = 0.95;
  const BOARD_GAP_PX = 2;
  const BOARD_TOP_FELT_PCT = 42.5;
  const boardCentreX = FELT_WINDOW.left + FELT_WINDOW.width / 2;
  const boardCentreY = FELT_WINDOW.top + (BOARD_TOP_FELT_PCT / 100) * FELT_WINDOW.height;
  const boardHalfW = (BOARD_FELT_FRACTION * FELT_WINDOW.width) / 2;
  for (const [label, table] of Object.entries(TABLES)) {
    // The puck's own radius, in percent of the table's width. Its centre being
    // off the board is not enough - the disc must be. Read from the module
    // (twice the chip since 2026-09-04) rather than from the chips' margin
    // constant, which stopped covering the puck when the puck doubled.
    const puckHalf = buttonRadiusWidthPct(table);
    const gapPct = (BOARD_GAP_PX / table.w) * 100;
    const cardW = (BOARD_FELT_FRACTION * FELT_WINDOW.width - 4 * gapPct) / 5;
    const boardHalfH = (cardW * (92 / 64) * (table.w / table.h)) / 2;

    it(`${label}: no seat on any ring puts its puck on the cards`, () => {
      for (const n of SIZES) {
        for (const seat of SEAT_LAYOUTS[n]) {
          const b = dealerButtonPosition(seat, table);
          const onBoardX = Math.abs(b.x - boardCentreX) < boardHalfW + puckHalf;
          const onBoardY =
            Math.abs(b.y - boardCentreY) < boardHalfH + puckHalf * (table.w / table.h);
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

describe('the seat BOXES stand clear of the cards, not just the markers', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * Dan 2026-08-27, item 2: the board spans the felt "LIKE FELT WINDOW 95%",
   * and the seats sit above and below it rather than beside it.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The two suites above measure a seat's CHIPS and its PUCK. Neither measures
   * the seat, and the seat is the biggest thing on the rail: a fixed 96px box
   * of avatar and nameplate that does not shrink with the phone. On a 375px
   * screen a side seat at x 10.5% reaches x 24.3% of the scaler while a 95%
   * board's left edge lands at x 15.1% — 32px of overlap that no chip rail and
   * no vertical anchor can do anything about.
   *
   * That is why the board could never have reached 95% from the stylesheet, and
   * it is the invariant the seat move has to keep: EVERY seat, on every ring,
   * stands entirely above the cards or entirely below them.
   *
   * Measured on the phone because the box is a fixed pixel size on a table
   * whose width is continuous, so the smallest table is the tightest fit. The
   * box is treated as 96px SQUARE: the real villain seat is about 90px tall
   * (a 52px avatar overlapping a ~43px plate), so this is conservative by a few
   * pixels in the axis that matters, deliberately.
   */
  const BOARD_FELT_FRACTION = 0.95;
  const BOARD_GAP_PX = 2;
  const BOARD_TOP_FELT_PCT = 42.5;

  for (const [label, table] of Object.entries(TABLES)) {
    it(`${label}: no seat box on any ring overlaps the board`, () => {
      const gapPct = (BOARD_GAP_PX / table.w) * 100;
      const rowW = BOARD_FELT_FRACTION * FELT_WINDOW.width;
      const cardW = (rowW - 4 * gapPct) / 5;
      const halfH = (cardW * (92 / 64) * (table.w / table.h)) / 2;
      const centreX = FELT_WINDOW.left + FELT_WINDOW.width / 2;
      const centreY = FELT_WINDOW.top + (BOARD_TOP_FELT_PCT / 100) * FELT_WINDOW.height;
      const seatHalfX = (seatBoxWPx(table.w) / 2 / table.w) * 100;
      const seatHalfY = (seatBoxWPx(table.w) / 2 / table.h) * 100;

      for (const n of SIZES) {
        for (const seat of SEAT_LAYOUTS[n]) {
          const overlapsX = Math.abs(seat.x - centreX) < rowW / 2 + seatHalfX;
          const overlapsY = Math.abs(seat.y - centreY) < halfH + seatHalfY;
          expect(
            overlapsX && overlapsY,
            `${n}-max ${label}: seat ${JSON.stringify(seat)} has its 96px box over the cards ` +
              `(the board is x ${(centreX - rowW / 2).toFixed(1)}..${(centreX + rowW / 2).toFixed(1)}, ` +
              `y ${(centreY - halfH).toFixed(1)}..${(centreY + halfH).toFixed(1)})`
          ).toBe(false);
        }
      }
    });
  }
});
