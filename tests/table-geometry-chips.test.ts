/**
 * ONE RAIL, BOTH MARKERS ON THE FELT, AND NEVER ON TOP OF EACH OTHER.
 *
 * Dan 2026-08-25, mobile pass:
 *
 *   item 11 "The button must always be on the table, and never on the rail."
 *   item 13 "All chips ... should all appear to be in the same position and
 *            distance in front of them. Imagine an imaginary oval, and all
 *            chips must appear equally on that line for all players at all
 *            tables. Those chips must never be in the same position on the
 *            table where the button lands."
 *
 * The rings come from src/lib/tableSeatGeometry.ts rather than being copied
 * here. They were copied here, and they went stale: this file was still testing
 * a hero at y=93.5 and top caps at y=13/14 months after production moved them to
 * y=100 and y=6, so every seat it checked was a seat that does not exist. A
 * geometry suite that invents its own seats cannot catch a seat problem.
 *
 * The tables are real ones. `.table-scaler` is locked to `aspect-ratio: 605/1000`
 * at every breakpoint in TablePage.css - the seat ring percentages are derived
 * from that box - so a 900x700 "wide table", which this file used to test, is
 * not a shape the app can render and proves nothing about the shape it does.
 */
import { describe, it, expect } from 'vitest';
import {
  betChipOffsetPx,
  chipCollectOffsetPx,
  chipRailInset,
  chipRestPosition,
  dealerButtonPosition,
  feltCenter,
  feltRadialFraction,
  isInsideFelt,
  markerGapWidthPct,
  CHIP_COLLECT_FRACTION,
  CHIP_RAIL_WIDTH_PCT,
  FELT_WINDOW,
  MARKER_MIN_GAP_WIDTH_PCT,
  type Pos,
  type Size,
} from '../src/components/table/tableGeometry';
import { SEAT_LAYOUTS } from '../src/lib/tableSeatGeometry';

/** The three table sizes the app actually renders, all at 605/1000. */
const TABLES: Record<string, Size> = {
  'phone 375px': { w: 347, h: 574 },
  'tablet portrait': { w: 600, h: 992 },
  desktop: { w: 720, h: 1190 },
};

const RINGS = SEAT_LAYOUTS;
const mag = (p: Pos) => Math.hypot(p.x, p.y);
const toPx = (from: Pos, to: Pos, t: Size): Pos => ({
  x: ((to.x - from.x) * t.w) / 100,
  y: ((to.y - from.y) * t.h) / 100,
});

describe('item 11 - the button is always on the felt, never on the rail', () => {
  for (const [label, table] of Object.entries(TABLES)) {
    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: every seat's button lands on the felt`, () => {
        for (const seat of ring) {
          const btn = dealerButtonPosition(seat, table);
          expect(
            isInsideFelt(btn, table),
            `seat ${JSON.stringify(seat)} -> button ${btn.x.toFixed(2)},${btn.y.toFixed(2)} ` +
              `is ${feltRadialFraction(btn, table).toFixed(3)} of the way out`
          ).toBe(true);
        }
      });
    }
  }

  it('the seats it was broken for are on the felt now, and were not before', () => {
    /* Every TOP CAP DIAGONAL on every ring, and only those, with the
       construction this replaced (0.28 of the horizontal run, 0.16 of the
       vertical, rotated 22.5 degrees):

         3-max, 5-max  (20.5, 6) -> (23.4, 14.3)   7.6% past the felt's edge
         3-max, 5-max  (79.5, 6) -> (67.2, 10.7)   6.1% past
         7-max, 9-max  (27,   6) -> (28.2, 13.9)   2.7% past
         7-max, 9-max  (73,   6) -> (62.3, 11.1)   1.8% past

       They were on the felt at y=8.5 and went off it when the cap was raised to
       y=6 in src/lib/tableSeatGeometry.ts - a seat move in a different file,
       breaking the button, silently. That is the case for the guarantee rather
       than a constant, and it is why the suite above walks the rings from that
       file instead of a copy. */
    const old = (seat: Pos): Pos => {
      const dx = 50 - seat.x;
      const dy = 50 - seat.y;
      const a = 22.5 * (Math.PI / 180);
      return {
        x: seat.x + (dx * Math.cos(a) - dy * Math.sin(a)) * 0.28,
        y: seat.y + (dx * Math.sin(a) + dy * Math.cos(a)) * 0.16,
      };
    };
    for (const seat of [
      { x: 20.5, y: 6 },
      { x: 79.5, y: 6 },
      { x: 27, y: 6 },
      { x: 73, y: 6 },
    ]) {
      expect(isInsideFelt(old(seat)), `old ${seat.x},${seat.y}`).toBe(false);
      expect(isInsideFelt(dealerButtonPosition(seat)), `new ${seat.x},${seat.y}`).toBe(true);
    }
  });
});

describe('item 13 - one rail, equal for every seat', () => {
  for (const [label, table] of Object.entries(TABLES)) {
    const rail = chipRailInset(table);

    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: every seat walks the same rail`, () => {
        for (const seat of ring) {
          const chips = betChipOffsetPx(seat, table);
          const rest = chipRestPosition(seat, table);
          const walked = mag(chips);

          if (feltRadialFraction(rest, table) < 0.999) {
            // The common rail, to the pixel. Each axis is rounded on its own, so
            // the magnitude of the vector can land up to ~0.71px either side.
            expect(
              Math.abs(walked - rail),
              `seat ${JSON.stringify(seat)} walked ${walked.toFixed(2)} of ${rail.toFixed(2)}`
            ).toBeLessThanOrEqual(1);
          } else {
            /* The ONLY thing that lengthens a walk: this seat's own ring
               position is outside the painted felt, so the first part of its
               walk is spent crossing the rail it is standing on. The hero at
               y=100 is 10.8% of the table's height below the felt; the bottom
               and top caps are outside it too. Nothing here is a per-seat
               preference - the same rule moves all of them and no other seat. */
            expect(walked).toBeGreaterThan(rail);
            expect(isInsideFelt(rest, table)).toBe(true);
          }
        }
      });

      it(`${size}-max on a ${label} table: chips are on the felt and in front of the player`, () => {
        for (const seat of ring) {
          const rest = chipRestPosition(seat, table);
          expect(isInsideFelt(rest, table)).toBe(true);

          const chips = betChipOffsetPx(seat, table);
          const toMiddle = toPx(seat, feltCenter(), table);
          expect(mag(chips)).toBeGreaterThan(0);
          expect(mag(chips)).toBeLessThan(mag(toMiddle));
          // Toward the middle of the felt, never away from it into the rail.
          if (Math.abs(toMiddle.x) > 1) expect(Math.sign(chips.x)).toBe(Math.sign(toMiddle.x));
          if (Math.abs(toMiddle.y) > 1) expect(Math.sign(chips.y)).toBe(Math.sign(toMiddle.y));
        }
      });
    }
  }

  it('holding the button no longer buys a seat a longer rail', () => {
    // It used to: CHIP_RAIL_DEALER_EXTRA_PX pushed the button holder's chips out
    // by 20px so they could clear their own puck. That is one seat at a
    // different distance from its player than everyone else, which is the thing
    // item 13 forbids - the puck moves now instead. See dealerButtonPosition.
    for (const table of Object.values(TABLES)) {
      for (const ring of Object.values(RINGS)) {
        for (const seat of ring) {
          expect(betChipOffsetPx(seat, table, true)).toEqual(betChipOffsetPx(seat, table, false));
        }
      }
    }
  });

  it('no seat is given a shorter rail to keep it off the community board', () => {
    /* The old CHIP_RAIL_SCALE_BOARD_LEVEL cut the rail to 1.15/1.82 for a side
       seat sitting at the board's own height, and only for that seat. Dan:
       "solve it by moving the whole rail for the whole table rather than by
       giving one seat a shorter walk." So the rail is short enough for every
       seat, and this asserts what that buys: no seat's chips land on the cards.

       The board is the middle 68% of the felt's width (TablePage.css,
       `.table-surface .community-cards`), five cards at 64:92, centred. */
    const c = feltCenter();
    const boardHalfW = 0.34 * FELT_WINDOW.width;
    const cardW = (0.68 * FELT_WINDOW.width) / 5;
    const boardHalfH = ((cardW * 92) / 64 / 2) * (1000 / 605);
    const chipHalf = 2; // a chip is ~4% of the table's width - see item 8

    for (const [label, table] of Object.entries(TABLES)) {
      for (const [size, ring] of Object.entries(RINGS)) {
        for (const seat of ring) {
          const p = chipRestPosition(seat, table);
          const onBoardX = Math.abs(p.x - c.x) < boardHalfW + chipHalf;
          const onBoardY = Math.abs(p.y - c.y) < boardHalfH + chipHalf * (1000 / 605);
          expect(
            onBoardX && onBoardY,
            `${size}-max ${label}: seat ${JSON.stringify(seat)} put chips at ` +
              `${p.x.toFixed(1)},${p.y.toFixed(1)} - on the board`
          ).toBe(false);
        }
      }
    }
  });
});

describe('item 13 - the chips and the button are never in the same place', () => {
  for (const [label, table] of Object.entries(TABLES)) {
    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: every seat keeps its two markers apart`, () => {
        for (const seat of ring) {
          const chips = chipRestPosition(seat, table);
          const btn = dealerButtonPosition(seat, table);
          const gap = markerGapWidthPct(btn, chips, table);
          expect(
            gap,
            `seat ${JSON.stringify(seat)}: gap ${((gap * table.w) / 100).toFixed(1)}px`
          ).toBeGreaterThanOrEqual(MARKER_MIN_GAP_WIDTH_PCT - 1e-6);
        }
      });

      it(`${size}-max on a ${label} table: the button is never deeper in than the chips`, () => {
        // Player, then button, then chips - Dan 2026-08-19, "chips must always
        // be in front of the user (in front of the button if they're the
        // button)". Measured from the middle of the felt rather than from the
        // seat: the button is deliberately off the chip line, so on a seat whose
        // markers were both projected onto the felt's edge it can be further
        // from the seat while still standing nearer the rail, which is what a
        // player actually reads as "in front".
        for (const seat of ring) {
          const chips = feltRadialFraction(chipRestPosition(seat, table), table);
          const btn = feltRadialFraction(dealerButtonPosition(seat, table), table);
          expect(btn, `seat ${JSON.stringify(seat)}`).toBeGreaterThanOrEqual(chips - 0.02);
        }
      });
    }
  }
});

describe('chip collect - every seat converges on the pot', () => {
  for (const [label, table] of Object.entries(TABLES)) {
    for (const [size, ring] of Object.entries(RINGS)) {
      it(`${size}-max on a ${label} table: lands the same fraction short of centre`, () => {
        for (const seat of ring) {
          const rest = betChipOffsetPx(seat, table);
          const travel = chipCollectOffsetPx(seat, table);
          const toMiddle = toPx(seat, feltCenter(), table);
          const landed = { x: rest.x + travel.x, y: rest.y + travel.y };
          // Both halves of the sweep are rounded per axis, so the magnitude of
          // the sum can land up to ~1.4px either side. A stated window rather
          // than toBeCloseTo, which would be pretending the arithmetic is exact.
          expect(Math.abs(mag(landed) - mag(toMiddle) * CHIP_COLLECT_FRACTION)).toBeLessThanOrEqual(
            1.5
          );
          expect(mag(landed)).toBeLessThan(mag(toMiddle));
        }
      });
    }
  }
});

describe('the rail itself', () => {
  it('is one number, and it scales with the table', () => {
    expect(chipRailInset(TABLES['phone 375px'])).toBeCloseTo((CHIP_RAIL_WIDTH_PCT * 347) / 100, 6);
    expect(chipRailInset(TABLES.desktop)).toBeGreaterThan(chipRailInset(TABLES['phone 375px']));
  });

  it('does not divide by zero for a seat sitting on the middle of the felt', () => {
    const c = feltCenter();
    expect(betChipOffsetPx(c, TABLES['phone 375px'])).toEqual({ x: 0, y: 0 });
    expect(dealerButtonPosition(c)).toEqual(c);
  });
});

describe('CONTROL - the maths this replaced really was uneven', () => {
  const table = TABLES['phone 375px'];

  it('a flat 0.22 factor put a top seat and a side seat at different distances', () => {
    const top = { x: 50, y: 5 };
    const side = { x: 10.5, y: 36 };
    const oldOffset = (seat: Pos) => ({
      x: ((50 - seat.x) * table.w * 0.22) / 100,
      y: ((50 - seat.y) * table.h * 0.22) / 100,
    });
    expect(Math.abs(mag(oldOffset(top)) - mag(oldOffset(side)))).toBeGreaterThan(10);
    expect(
      Math.abs(mag(betChipOffsetPx(top, table)) - mag(betChipOffsetPx(side, table)))
    ).toBeLessThanOrEqual(1);
  });
});
