/**
 * THE CHIP RAIL, ON A RING THAT IS NOT ONE OF OURS.
 * ============================================================================
 * tests/table-geometry-chips.test.ts walks the eight production rings out of
 * src/lib/tableSeatGeometry.ts, which is the right suite for "does the table we
 * ship work". This one exists for the other question: does the geometry hold up
 * on a ring nobody has tuned it against.
 *
 * The seats below are deliberately NOT a production ring. They are a nine-
 * handed ellipse with seats at x=6 and x=94 - further out than any real seat -
 * and an off-centre hero, which is exactly the sort of layout a new skin or a
 * new table size would introduce. Every rule the module claims is a rule rather
 * than a tuning has to survive that:
 *
 *   - one rail, the same distance from every seat that has the room for it;
 *   - both markers on the felt, whatever the seat is doing;
 *   - the two markers never on top of each other.
 *
 * Dan 2026-08-25, item 13: "all chips must appear equally on that line for all
 * players at all tables" - at all tables is the part this file is for.
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
  MARKER_MIN_GAP_WIDTH_PCT,
  type Pos,
  type Size,
} from '../../src/components/table/tableGeometry';

/** A nine-handed ring that is not ours: wider than the painted rail, hero off centre. */
const SEATS: Pos[] = [
  { x: 47, y: 96 },
  { x: 18, y: 80 },
  { x: 6, y: 55 },
  { x: 12, y: 30 },
  { x: 32, y: 10 },
  { x: 68, y: 10 },
  { x: 88, y: 30 },
  { x: 94, y: 55 },
  { x: 82, y: 80 },
];

/** Phone, tablet and desktop, all at the scaler's locked 605/1000. */
const TABLES: Size[] = [
  { w: 347, h: 574 },
  { w: 600, h: 992 },
  { w: 720, h: 1190 },
];

const dist = (p: Pos) => Math.hypot(p.x, p.y);

describe('the chip rail', () => {
  it('walks every seat that has the room the same distance, at every table size', () => {
    for (const table of TABLES) {
      const rail = chipRailInset(table);
      for (const seat of SEATS) {
        const rest = chipRestPosition(seat, table);
        const walked = dist(betChipOffsetPx(seat, table));
        if (feltRadialFraction(rest, table) < 0.999) {
          // Not touched by the on-felt guarantee, so it is on the common rail.
          // Each axis is rounded on its own, hence a stated 1px window rather
          // than pretending the arithmetic is exact.
          expect(
            Math.abs(walked - rail),
            `${table.w}x${table.h} seat ${seat.x},${seat.y}`
          ).toBeLessThanOrEqual(1);
        } else {
          // The only thing that ever lengthens a walk: a seat standing off the
          // felt has to cross the rail before its rail starts.
          expect(walked).toBeGreaterThan(rail);
        }
      }
    }
  });

  it('never leaves a marker on the painted rail', () => {
    for (const table of TABLES) {
      for (const seat of SEATS) {
        expect(
          isInsideFelt(chipRestPosition(seat, table), table),
          `chips ${seat.x},${seat.y}`
        ).toBe(true);
        expect(
          isInsideFelt(dealerButtonPosition(seat, table), table),
          `button ${seat.x},${seat.y}`
        ).toBe(true);
      }
    }
  });

  it('keeps the chips and the button visibly apart', () => {
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const gap = markerGapWidthPct(
          dealerButtonPosition(seat, table),
          chipRestPosition(seat, table),
          table
        );
        expect(gap, `seat ${seat.x},${seat.y}`).toBeGreaterThanOrEqual(
          MARKER_MIN_GAP_WIDTH_PCT - 1e-6
        );
      }
    }
  });

  it('holding the button changes nothing about where the chips rest', () => {
    // CHIP_RAIL_DEALER_EXTRA_PX used to push the button holder's chips 20px
    // further out so they could clear their own puck. One seat at a different
    // distance from its player than everyone else is the thing item 13 forbids;
    // the puck moves instead.
    for (const table of TABLES) {
      for (const seat of SEATS) {
        expect(betChipOffsetPx(seat, table, true)).toEqual(betChipOffsetPx(seat, table, false));
      }
    }
  });

  it('always moves chips toward the middle of the felt, never away from it', () => {
    const c = feltCenter();
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const off = betChipOffsetPx(seat, table);
        if (Math.abs(c.x - seat.x) > 0.5) expect(Math.sign(off.x)).toBe(Math.sign(c.x - seat.x));
        if (Math.abs(c.y - seat.y) > 0.5) expect(Math.sign(off.y)).toBe(Math.sign(c.y - seat.y));
      }
    }
  });

  it('never throws chips past the middle of the felt', () => {
    const c = feltCenter();
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const off = betChipOffsetPx(seat, table);
        const run = Math.hypot(((c.x - seat.x) * table.w) / 100, ((c.y - seat.y) * table.h) / 100);
        expect(dist(off)).toBeLessThan(run);
      }
    }
  });

  it('collects every seat to the same point, wherever its chips started', () => {
    const c = feltCenter();
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const rest = betChipOffsetPx(seat, table);
        const travel = chipCollectOffsetPx(seat, table);
        const landed = { x: rest.x + travel.x, y: rest.y + travel.y };
        const run = Math.hypot(((c.x - seat.x) * table.w) / 100, ((c.y - seat.y) * table.h) / 100);
        // Both halves are rounded per axis, so the sum can land ~1.4px either
        // side of the mark it is aimed at.
        expect(Math.abs(dist(landed) - run * CHIP_COLLECT_FRACTION)).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('does not divide by zero for a seat sitting on the middle of the felt', () => {
    const c = feltCenter();
    expect(betChipOffsetPx(c, TABLES[0])).toEqual({ x: 0, y: 0 });
    expect(dealerButtonPosition(c, TABLES[0])).toEqual(c);
  });

  it('is one number and it follows the table', () => {
    expect(chipRailInset(TABLES[0])).toBeLessThan(chipRailInset(TABLES[2]));
    // A table so small it has no felt left still returns something finite
    // rather than a NaN that would put a chip at translate(NaN, NaN).
    const tiny = betChipOffsetPx({ x: 10, y: 90 }, { w: 20, h: 33 });
    expect(Number.isFinite(tiny.x) && Number.isFinite(tiny.y)).toBe(true);
  });
});
