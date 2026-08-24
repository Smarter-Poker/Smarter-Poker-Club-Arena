/**
 * CHIPS: EQUALLY SPACED, AND ALWAYS IN FRONT OF THE PLAYER.
 *
 * Two rules, both of them Dan's, and they pull in different directions - which
 * is why they are tested together over every production ring.
 *
 * 2026-08-19, item 8: "chips must always be in front of the user (in front of
 * the button if they're the button)." The dealer button travels 0.28 of the
 * way toward centre horizontally; the chips used to travel a flat 0.22, so on
 * every side seat the BUTTON sat further onto the felt than the chips it was
 * meant to stand behind.
 *
 * 2026-08-21: "ALL CHIPS FOR ALL PLAYERS NEED TO BE PLACED THE SAME DISTANCE
 * FROM THEM REGARDLESS OF SEAT POSITION." The factor-based maths could not do
 * that - see THE CHIP RAIL in tableGeometry.ts - so the chips moved to a fixed
 * pixel inset along the line to the middle.
 *
 * These tests walk every seat of every table size (2-max through 9-max, the
 * real production rings) and assert both rules hold at once.
 */
import { describe, it, expect } from 'vitest';
import {
  betChipOffsetPx,
  chipCollectOffsetPx,
  chipRailInset,
  isBottomSeat,
  isBoardLevelSeat,
  isSideSeat,
  dealerButtonPosition,
  CHIP_COLLECT_FRACTION,
  CHIP_RAIL_SCALE,
  CHIP_RAIL_SCALE_BOARD_LEVEL,
  type Pos,
  type Size,
} from '../src/components/table/tableGeometry';

/** A phone-shaped table: the tall oval where the old maths was worst. */
const TABLE: Size = { w: 300, h: 462 };

const toPx = (seat: Pos, p: Pos): Pos => ({
  x: ((p.x - seat.x) * TABLE.w) / 100,
  y: ((p.y - seat.y) * TABLE.h) / 100,
});
const mag = (p: Pos) => Math.hypot(p.x, p.y);

/** The production seat rings, copied from TablePage.tsx. */
const RINGS: Record<number, Pos[]> = {
  2: [
    { x: 50, y: 93.5 },
    { x: 50, y: 6 },
  ],
  3: [
    { x: 50, y: 93.5 },
    { x: 20.5, y: 14 },
    { x: 79.5, y: 14 },
  ],
  4: [
    { x: 50, y: 93.5 },
    { x: 10.5, y: 45 },
    { x: 50, y: 6 },
    { x: 89.5, y: 45 },
  ],
  5: [
    { x: 50, y: 93.5 },
    { x: 10.5, y: 55 },
    { x: 20.5, y: 14 },
    { x: 79.5, y: 14 },
    { x: 89.5, y: 55 },
  ],
  6: [
    { x: 50, y: 93.5 },
    { x: 10.5, y: 66 },
    { x: 10.5, y: 33 },
    { x: 50, y: 6 },
    { x: 89.5, y: 33 },
    { x: 89.5, y: 66 },
  ],
  7: [
    { x: 50, y: 93.5 },
    { x: 10.5, y: 62 },
    { x: 10.5, y: 33 },
    { x: 27, y: 13 },
    { x: 73, y: 13 },
    { x: 89.5, y: 33 },
    { x: 89.5, y: 62 },
  ],
  8: [
    { x: 50, y: 93.5 },
    { x: 19, y: 82.5 },
    { x: 10.5, y: 52 },
    { x: 10.5, y: 28 },
    { x: 50, y: 6 },
    { x: 89.5, y: 28 },
    { x: 89.5, y: 52 },
    { x: 81, y: 82.5 },
  ],
  9: [
    { x: 50, y: 93.5 },
    { x: 19, y: 82.5 },
    { x: 10.5, y: 58 },
    { x: 10.5, y: 36 },
    { x: 27, y: 13 },
    { x: 73, y: 13 },
    { x: 89.5, y: 36 },
    { x: 89.5, y: 58 },
    { x: 81, y: 82.5 },
  ],
};

describe('every ring: chips sit in front of the player, at one distance', () => {
  for (const [size, ring] of Object.entries(RINGS)) {
    describe(`${size}-max`, () => {
      it('every seat is the same distance from its chips', () => {
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
        /* AMENDED AGAIN 2026-08-24, and for the same reason as the hero.

             Dan: "chips from players on the left and right sides need to be put
             on the table farther. they are too close to the rail."

             They were - but not because of anything in this module. The rail
             computed here was multiplied by 1.82 in TableVisualHotfix.css and
             then CLAMPED to +/-52px on the x axis, which cut the side seats to
             less than half of what every other seat got. This suite could not
             see any of it: the clamp was in a stylesheet, and the maths it
             tests was equal all along. That scale now lives in this module
             (CHIP_RAIL_SCALE) so a test CAN see it, and the clamp is gone.

             The clamp was not groundless, though. A side seat sitting at the
             board's own height - 4-max y=45, 5-max y=55, 8-max y=52, 9-max
             y=58 - genuinely cannot take the full rail: the board holds the
             middle 68% of the felt, so there is about 5% of table width between
             that seat and the cards, and at 1.82 its bet lands on them. That
             seat, and only that seat, walks a shorter rail
             (CHIP_RAIL_SCALE_BOARD_LEVEL), so it is excluded here and asserted
             on its own terms in the block below.

             This is the third exception, and all three have the same shape: the
             property worth having is "equally clear of the things around the
             player", and "equal distance" is a proxy for it that holds for most
             seats and not for the ones with something in the way. */
        const d = ring
          .filter((seat) => !isBottomSeat(seat) && !isBoardLevelSeat(seat))
          .map((seat) => mag(betChipOffsetPx(seat, TABLE, false)));
        expect(Math.max(...d) - Math.min(...d)).toBeLessThanOrEqual(1.5);
      });

      ring.forEach((seat, i) => {
        it(`seat ${i + 1} holding the button: player -> button -> chips`, () => {
          const btn = mag(toPx(seat, dealerButtonPosition(seat)));
          const chips = mag(betChipOffsetPx(seat, TABLE, true));
          expect(chips).toBeGreaterThan(btn);
        });

        it(`seat ${i + 1} without the button: chips in front, never past centre`, () => {
          const chips = betChipOffsetPx(seat, TABLE, false);
          const toCentre = toPx(seat, { x: 50, y: 50 });
          expect(mag(chips)).toBeGreaterThan(0);
          expect(mag(chips)).toBeLessThan(mag(toCentre));
          // and pointing at the middle, not away from it
          if (Math.abs(toCentre.x) > 1) expect(Math.sign(chips.x)).toBe(Math.sign(toCentre.x));
          if (Math.abs(toCentre.y) > 1) expect(Math.sign(chips.y)).toBe(Math.sign(toCentre.y));
        });
      });
    });
  }
});

describe('CONTROL: the old maths really did vary by seat', () => {
  it('a flat 0.22 factor put a top-centre seat and a side seat at different distances', () => {
    // The 9-max ring: bottom-centre hero vs a left-side seat.
    const top = { x: 50, y: 6 };
    // 2026-08-24: was { x: 10.5, y: 58 }, the 9-max left-low seat - which is
    // level with the community board and now deliberately walks a shorter
    // rail, so it can no longer stand for "an ordinary side seat". The 9-max
    // left-HIGH seat is the same ring, the same rail, and clear of the board.
    const side = { x: 10.5, y: 36 };
    const oldOffset = (seat: Pos) => ({
      x: ((50 - seat.x) * TABLE.w * 0.22) / 100,
      y: ((50 - seat.y) * TABLE.h * 0.22) / 100,
    });
    const spreadOld = Math.abs(mag(oldOffset(top)) - mag(oldOffset(side)));
    expect(spreadOld).toBeGreaterThan(10); // the bug: tens of px apart

    const spreadNew = Math.abs(
      mag(betChipOffsetPx(top, TABLE, false)) - mag(betChipOffsetPx(side, TABLE, false))
    );
    expect(spreadNew).toBeLessThanOrEqual(1.5); // the fix
  });

  it('a side seat put the button further onto the felt than its chips', () => {
    const seat = { x: 10.5, y: 66 };
    const btn = mag(toPx(seat, dealerButtonPosition(seat)));
    const oldChips = Math.abs(((50 - seat.x) * TABLE.w * 0.22) / 100);
    expect(oldChips).toBeLessThan(btn);
    // and no longer
    expect(mag(betChipOffsetPx(seat, TABLE, true))).toBeGreaterThan(btn);
  });
});

describe('chip collect — must never overshoot the pot', () => {
  const ring = RINGS[9];

  it('lands every seat the same fraction short of centre, dealer or not', () => {
    for (const isDealer of [false, true]) {
      for (const seat of ring) {
        const rest = betChipOffsetPx(seat, TABLE, isDealer);
        const travel = chipCollectOffsetPx(seat, TABLE, isDealer);
        const toCentre = toPx(seat, { x: 50, y: 50 });
        const landed = { x: rest.x + travel.x, y: rest.y + travel.y };
        expect(mag(landed)).toBeCloseTo(mag(toCentre) * CHIP_COLLECT_FRACTION, 0);
      }
    }
  });

  it('never carries a chip past the centre of the table', () => {
    for (const isDealer of [false, true]) {
      for (const seat of ring) {
        const rest = betChipOffsetPx(seat, TABLE, isDealer);
        const travel = chipCollectOffsetPx(seat, TABLE, isDealer);
        const landed = { x: rest.x + travel.x, y: rest.y + travel.y };
        expect(mag(landed)).toBeLessThan(mag(toPx(seat, { x: 50, y: 50 })));
      }
    }
  });

  it('shortens the remaining travel for the seat that starts further out', () => {
    for (const seat of ring) {
      expect(mag(chipCollectOffsetPx(seat, TABLE, true))).toBeLessThan(
        mag(chipCollectOffsetPx(seat, TABLE, false))
      );
    }
  });
});

describe('the rail inset itself', () => {
  it('grows with the table but stays inside sane bounds', () => {
    expect(chipRailInset({ w: 200, h: 200 }, false)).toBeGreaterThanOrEqual(30);
    expect(chipRailInset({ w: 2000, h: 2000 }, false)).toBeLessThanOrEqual(64);
    expect(chipRailInset({ w: 900, h: 900 }, false)).toBeGreaterThan(
      chipRailInset({ w: 300, h: 300 }, false)
    );
  });

  it('adds a constant clearance for the dealer, not a fraction', () => {
    const a = chipRailInset({ w: 300, h: 462 }, true) - chipRailInset({ w: 300, h: 462 }, false);
    const b = chipRailInset({ w: 900, h: 700 }, true) - chipRailInset({ w: 900, h: 700 }, false);
    expect(a).toBe(b);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE SIDE SEATS, AND THE ONE THAT CANNOT HAVE THE FULL RAIL
   ═══════════════════════════════════════════════════════════════════════════
   Dan 2026-08-24: "chips from players on the left and right sides need to be
   put on the table farther. they are too close to the rail."

   The regression these pin is not a wrong formula, it is a SECOND formula: the
   stylesheet used to re-scale and then clamp what this module returned, so the
   module and the screen disagreed and only the screen was right. Everything
   below is asserted against the module because the module is now the only
   place the answer is computed. */
describe('the side seats get the rail everyone else gets', () => {
  const wide: Size = { w: 900, h: 700 };

  it('a side seat clear of the board walks exactly as far as a top seat', () => {
    const top = { x: 50, y: 6 };
    const side = { x: 10.5, y: 33 };
    expect(isSideSeat(side)).toBe(true);
    expect(isBoardLevelSeat(side)).toBe(false);
    expect(mag(betChipOffsetPx(side, wide, false))).toBeCloseTo(
      mag(betChipOffsetPx(top, wide, false)),
      0
    );
  });

  it('and it is a long way further out than the old 52px clamp allowed', () => {
    // The clamp deleted from TableVisualHotfix.css. A side seat's rail is
    // almost all x, so the clamp was very nearly the whole offset.
    const side = { x: 10.5, y: 33 };
    expect(Math.abs(betChipOffsetPx(side, wide, false).x)).toBeGreaterThan(52);
  });

  it('the seat level with the board stops short, but still moves toward the felt', () => {
    const level = { x: 10.5, y: 52 }; // 8-max left-low
    expect(isBoardLevelSeat(level)).toBe(true);

    const short = betChipOffsetPx(level, wide, false);
    const full = betChipOffsetPx({ x: 10.5, y: 28 }, wide, false); // 8-max left-high
    expect(mag(short)).toBeLessThan(mag(full));
    // Toward the middle, not backwards into the rail, and never nothing.
    expect(short.x).toBeGreaterThan(0);
    expect(CHIP_RAIL_SCALE_BOARD_LEVEL).toBeLessThan(CHIP_RAIL_SCALE);
  });

  it('every board-level seat still puts its chips in front of its own button', () => {
    for (const seat of [
      { x: 10.5, y: 45 },
      { x: 89.5, y: 45 },
      { x: 10.5, y: 55 },
      { x: 89.5, y: 52 },
      { x: 10.5, y: 58 },
    ]) {
      for (const table of [TABLE, wide]) {
        const btn = mag({
          x: ((dealerButtonPosition(seat).x - seat.x) * table.w) / 100,
          y: ((dealerButtonPosition(seat).y - seat.y) * table.h) / 100,
        });
        expect(mag(betChipOffsetPx(seat, table, true))).toBeGreaterThan(btn);
      }
    }
  });
});
