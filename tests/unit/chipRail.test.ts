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
  feltEdgeClearanceWidthPct,
  feltRadialFraction,
  isInsideFelt,
  markerGapWidthPct,
  BUTTON_FELT_DAYLIGHT_WIDTH_PCT,
  BUTTON_FELT_MARGIN_WIDTH_PCT,
  CHIP_COLLECT_FRACTION,
  FELT_MARKER_MARGIN_WIDTH_PCT,
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
/** Distance between two scaler percentages, in pixels on a given table. */
const px = (a: Pos, b: Pos, t: Size) =>
  Math.hypot(((a.x - b.x) * t.w) / 100, ((a.y - b.y) * t.h) / 100);

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

  it('leaves the button clear felt on all sides, on a ring nobody tuned it against', () => {
    /* Dan 2026-08-25, round two item 8: "The button is too close to the rail and
       should be pushed a little farther into the table, so it's 'in front of the
       player' without touching the rail."

       The test above only asks whether the marker is inside the felt, and a puck
       resting flat against the rail passes that - which is exactly what Dan was
       looking at. This asks for the daylight, on seats at x=6 and x=94 that sit
       further outside the painted felt than any production chair, so the answer
       comes from the projection rather than from where the seat happened to be.

       Half the daylight is the puck's own radius (it may not overhang) and half
       is clear felt (it may not touch), which is why the second assertion takes
       FELT_MARKER_MARGIN_WIDTH_PCT off before comparing. */
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const clearance = feltEdgeClearanceWidthPct(dealerButtonPosition(seat, table), table);
        expect(
          clearance,
          `${table.w}x${table.h} seat ${seat.x},${seat.y}: ` +
            `${((clearance * table.w) / 100).toFixed(1)}px from the rail`
        ).toBeGreaterThanOrEqual(BUTTON_FELT_MARGIN_WIDTH_PCT - 1e-6);
        expect(clearance - FELT_MARKER_MARGIN_WIDTH_PCT).toBeGreaterThanOrEqual(
          BUTTON_FELT_DAYLIGHT_WIDTH_PCT - 1e-6
        );
      }
    }
  });

  it('does not push the button so far in that it stops belonging to its seat', () => {
    /* The daylight is bought by walking the button further from its player, so
       the walk is bounded. 0.40 of the seat's own distance to the middle of the
       felt is a stated ceiling with headroom: this ring, which is deliberately
       wider than ours, peaks at 0.34 (seat 94,55 on the phone - 53.3px of
       156.8px) and the eight production rings peak at 0.32. The second half is
       the invariant that matters more than the number - whatever the geometry
       does, no other chair on the ring ends up nearer to this button than the
       chair it was computed for. */
    const c = feltCenter();
    for (const table of TABLES) {
      for (const seat of SEATS) {
        const btn = dealerButtonPosition(seat, table);
        const walked = px(seat, btn, table);
        const run = px(seat, c, table);
        expect(walked / run, `${table.w}x${table.h} seat ${seat.x},${seat.y}`).toBeLessThanOrEqual(
          0.4
        );
        for (const other of SEATS) {
          if (other === seat) continue;
          expect(
            px(other, btn, table),
            `${table.w}x${table.h} seat ${seat.x},${seat.y}'s button is nearer ${other.x},${other.y}`
          ).toBeGreaterThanOrEqual(walked - 1e-9);
        }
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

  it('holding the button cannot even be expressed to the chip functions', () => {
    // CHIP_RAIL_DEALER_EXTRA_PX used to push the button holder's chips 20px
    // further out so they could clear their own puck. One seat at a different
    // distance from its player than everyone else is the thing item 13 forbids;
    // the puck moves instead.
    //
    // This used to be `betChipOffsetPx(seat, table, true)` vs `(..., false)`,
    // which proved the argument was ignored - and kept the argument alive to be
    // ignored. Audit 2026-08-25 deleted the parameter, so the property is now
    // structural: there is no third argument for a caller to get wrong.
    expect(betChipOffsetPx).toHaveLength(2);
    expect(chipCollectOffsetPx).toHaveLength(2);
    expect(chipRailInset).toHaveLength(1);
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
