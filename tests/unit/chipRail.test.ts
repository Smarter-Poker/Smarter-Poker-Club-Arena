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
    const distances = SEATS.map((s) => dist(betChipOffsetPx(s, TABLE, false)));
    const min = Math.min(...distances);
    const max = Math.max(...distances);
    // Within a pixel: the only slack is Math.round on each axis.
    expect(max - min, `spread across seats was ${(max - min).toFixed(2)}px`).toBeLessThanOrEqual(1.5);
  });

  it('holds at every table size, including a wide one', () => {
    for (const size of [
      { w: 300, h: 462 },
      { w: 1200, h: 700 },
      { w: 380, h: 380 },
      { w: 240, h: 520 },
    ] as Size[]) {
      const d = SEATS.map((s) => dist(betChipOffsetPx(s, size, false)));
      expect(Math.max(...d) - Math.min(...d), `${size.w}x${size.h}`).toBeLessThanOrEqual(1.5);
    }
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
      const extra = chipRailInset(TABLE, true) - chipRailInset(TABLE, false);
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
    const expected = SEATS.map((s) =>
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
