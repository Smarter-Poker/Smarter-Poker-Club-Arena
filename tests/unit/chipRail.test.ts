/**
 * EVERY SEAT'S CHIPS SIT THE SAME DISTANCE FROM THE PLAYER.
 * ============================================================================
 * Dan 2026-08-21: "ALL CHIPS FOR ALL PLAYERS NEED TO BE PLACED THE SAME
 * DISTANCE FROM THEM REGARDLESS OF SEAT POSITION. IMAGINE AN IMAGINARY RAIL
 * THAT GOES ALL AROUND THE TABLE EQUALLY."
 *
 * The old code scaled each axis by how far the seat was from centre ON THAT
 * AXIS, so a top-centre seat's chips dropped a long way straight down, a side
 * seat's slid a long way straight in, and a corner seat's did some of both -
 * three different distances, which is what the screenshot showed.
 *
 * A single number is what makes this testable: the distance from a seat to its
 * chips must be the same for all nine of them.
 */

import { describe, it, expect } from 'vitest';
import {
  betChipOffsetPx,
  chipCollectOffsetPx,
  chipRailInset,
  isBottomSeat,
  isBoardLevelSeat,
  CHIP_RAIL_BOTTOM_EXTRA_PX,
  CHIP_RAIL_SCALE,
  CHIP_COLLECT_FRACTION,
  type Pos,
  type Size,
} from '../../src/components/table/tableGeometry';

/** A nine-handed ring on a table far taller than it is wide - the hard case. */
const SEATS: Pos[] = [
  { x: 50, y: 92 }, // hero, bottom centre
  { x: 18, y: 80 },
  { x: 6, y: 55 },
  { x: 12, y: 30 },
  { x: 32, y: 10 },
  { x: 68, y: 10 },
  { x: 88, y: 30 },
  { x: 94, y: 55 },
  { x: 82, y: 80 },
];

const TABLE: Size = { w: 300, h: 462 };
const dist = (p: Pos) => Math.hypot(p.x, p.y);

describe('the chip rail', () => {
  it('puts every seat the same distance from its chips', () => {
    /* AMENDED 2026-08-23. This used to demand ONE distance for every seat
         without exception. That is the right rule for the seats it was written
         about and the wrong rule for the bottom rail, so it now excludes it.

         Dan: "chips for the hero need to be pushed out farther in front of
         them, they are literally on top of the avatar."

         The rail is measured from a seat's CENTRE, and what the chips actually
         have to clear is that seat's AVATAR. Those are the same number for
         eight seats and not for the ninth: the hero's box is 1.3333x everyone
         else's (--seat-avatar-hero-ratio) and its bust art rises well past the
         box on top of that. A side seat also gets to travel diagonally, while
         the hero sits at x=50 and can only go straight up into its own face.

         So "equal distance" was never the property worth having - it was a
         proxy for "equally clear of the player", which is what a person
         actually sees. Where the two disagree, the proxy loses. The suite
         already accepts exactly this shape of exception for the button holder
         (CHIP_RAIL_DEALER_EXTRA_PX), and like that one this is a CONSTANT, not
         a per-seat fraction - asserted directly below. */

    /* AMENDED AGAIN 2026-08-24. Two things moved, both of them INTO this module
   from a stylesheet, and both of them change the numbers these tests assert.

   1. CHIP_RAIL_SCALE. TableVisualHotfix.css multiplied every offset computed
      here by 1.82 before painting it, so the "rail" this file was measuring
      was never the rail on the screen. Folded in, so a test can finally see
      the real distance. Every constant asserted below is therefore scaled.

   2. The board-level exception. That same stylesheet ALSO clamped the x term
      to +/-52px, which cut the left and right seats to under half the run
      everyone else got - Dan 2026-08-24: "chips from players on the left and
      right sides need to be put on the table farther, they are too close to
      the rail." The clamp is gone, but the reason it existed is not: a side
      seat at the community board's own height really does have about 5% of the
      table's width before it reaches the cards. That seat, and only that seat,
      walks a shorter rail (isBoardLevelSeat), so it is excluded from the
      equal-distance rule for the same reason the hero already is. */
    const distances = SEATS.filter((s) => !isBottomSeat(s) && !isBoardLevelSeat(s)).map((s) =>
      dist(betChipOffsetPx(s, TABLE, false))
    );
    const min = Math.min(...distances);
    const max = Math.max(...distances);
    // Within a pixel: the only slack is Math.round on each axis.
    expect(max - min, `spread across seats was ${(max - min).toFixed(2)}px`).toBeLessThanOrEqual(
      1.5
    );
  });

  it('holds at every table size, including a wide one', () => {
    for (const size of [
      { w: 300, h: 462 },
      { w: 1200, h: 700 },
      { w: 380, h: 380 },
      { w: 240, h: 520 },
    ] as Size[]) {
      const d = SEATS.filter((s) => !isBottomSeat(s) && !isBoardLevelSeat(s)).map((s) =>
        dist(betChipOffsetPx(s, size, false))
      );
      expect(Math.max(...d) - Math.min(...d), `${size.w}x${size.h}`).toBeLessThanOrEqual(1.5);
    }
  });

  it('gives the bottom rail a constant extra step, for its taller avatar', () => {
    const bottom = { x: 50, y: 100 };
    // 2026-08-24: was { x: 94, y: 55 }, which is level with the community
    // board and now walks a deliberately shorter rail - it cannot stand for
    // "an ordinary seat" any more. { x: 88, y: 30 } is the same ring, clear of
    // the board, on the same side of the table.
    const side = { x: 88, y: 30 };
    // The extra is a constant in this module's own units, and this module now
    // owns the 1.82 that the stylesheet used to apply on top of it.
    const expected = CHIP_RAIL_BOTTOM_EXTRA_PX * CHIP_RAIL_SCALE;
    const extraBottom =
      dist(betChipOffsetPx(bottom, TABLE, false)) - dist(betChipOffsetPx(side, TABLE, false));
    expect(extraBottom).toBeGreaterThan(0);
    expect(Math.abs(extraBottom - expected)).toBeLessThanOrEqual(1.5);

    // Constant, not a fraction: the same extra on a much bigger table.
    const big: Size = { w: 1200, h: 700 };
    const extraBig =
      dist(betChipOffsetPx(bottom, big, false)) - dist(betChipOffsetPx(side, big, false));
    expect(Math.abs(extraBig - expected)).toBeLessThanOrEqual(1.5);
  });

  it('steps the dealer further out, by the same amount whoever they are', () => {
    for (const seat of SEATS) {
      const plain = dist(betChipOffsetPx(seat, TABLE, false));
      const dealer = dist(betChipOffsetPx(seat, TABLE, true));
      expect(dealer).toBeGreaterThan(plain);
      // The extra clearance is a constant, not a per-seat fraction. The offset
      // is rounded on each axis independently, so the magnitude of the vector
      // can land up to ~0.71px either side - hence a stated 1.5px window
      // rather than pretending the arithmetic is exact.
      // Scaled, because CHIP_RAIL_SCALE is applied to the whole inset - see
      // the banner above. A board-level seat is excluded from the exact figure:
      // it walks a different scale AND is floored at its own button's distance
      // (CHIP_RAIL_MIN_CLEARANCE_PX), so its dealer step is bounded but not
      // constant. It still has to step further out, which is asserted above.
      if (isBoardLevelSeat(seat)) continue;

      // The other exception is the ceiling. betChipOffsetPx never carries a
      // chip more than 80% of the way to the middle - they belong to a player,
      // not to the pot - and on a tall narrow table the HERO reaches it: it
      // already has the bottom-rail extra, and 1.82 on top of that puts the
      // button-holder's rail past the limit, so its dealer step is trimmed.
      //
      // That trim is the fix working, not a bug to assert around. Before the
      // scale moved into this module the ceiling was applied to the UNSCALED
      // inset and could never bind, so the hero-with-the-button's chips really
      // did sit 93% of the way to the centre - which is to say, in the pot.
      const run = Math.hypot(((50 - seat.x) * TABLE.w) / 100, ((50 - seat.y) * TABLE.h) / 100);
      if (dealer >= run * 0.8 - 1.5) continue;

      const extra = (chipRailInset(TABLE, true) - chipRailInset(TABLE, false)) * CHIP_RAIL_SCALE;
      expect(Math.abs(dealer - plain - extra)).toBeLessThanOrEqual(1.5);
    }
  });

  it('always moves chips toward the middle, never away from it', () => {
    for (const seat of SEATS) {
      const off = betChipOffsetPx(seat, TABLE, false);
      const inwardX = 50 - seat.x;
      const inwardY = 50 - seat.y;
      // same sign on each axis as the direction to the centre
      if (Math.abs(inwardX) > 0.5) expect(Math.sign(off.x)).toBe(Math.sign(inwardX));
      if (Math.abs(inwardY) > 0.5) expect(Math.sign(off.y)).toBe(Math.sign(inwardY));
    }
  });

  it('never throws chips past the centre of the table', () => {
    for (const seat of SEATS) {
      for (const isDealer of [false, true]) {
        const off = betChipOffsetPx(seat, TABLE, isDealer);
        const runX = ((50 - seat.x) * TABLE.w) / 100;
        const runY = ((50 - seat.y) * TABLE.h) / 100;
        expect(dist(off)).toBeLessThan(Math.hypot(runX, runY));
      }
    }
  });

  it('collects every seat to the same point, wherever its chips started', () => {
    const endpoints = SEATS.map((seat) => {
      const rest = betChipOffsetPx(seat, TABLE, false);
      const travel = chipCollectOffsetPx(seat, TABLE, false);
      // where the chip lands, relative to the table centre
      const runX = ((50 - seat.x) * TABLE.w) / 100;
      const runY = ((50 - seat.y) * TABLE.h) / 100;
      return {
        x: rest.x + travel.x - runX,
        y: rest.y + travel.y - runY,
      };
    });
    // each lands the same fraction short of centre, so the spread of their
    // distance-from-centre is what matters
    const d = endpoints.map((p) => dist(p));
    const expected = SEATS.map(
      (s) =>
        Math.hypot(((50 - s.x) * TABLE.w) / 100, ((50 - s.y) * TABLE.h) / 100) *
        (1 - CHIP_COLLECT_FRACTION)
    );
    // Same per-axis rounding slack as above.
    d.forEach((actual, i) => expect(Math.abs(actual - expected[i])).toBeLessThanOrEqual(1.5));
  });

  it('does not divide by zero for a seat sitting on the centre', () => {
    expect(betChipOffsetPx({ x: 50, y: 50 }, TABLE, false)).toEqual({ x: 0, y: 0 });
  });

  it('keeps the inset sane on absurd table sizes', () => {
    expect(chipRailInset({ w: 20, h: 20 }, false)).toBeGreaterThanOrEqual(30);
    expect(chipRailInset({ w: 4000, h: 4000 }, false)).toBeLessThanOrEqual(64);
  });
});
