/**
 * TABLE SEAT GEOMETRY (2026-08-19).
 *
 * These rings are measured positions on the painted rail of the 896x1200 skin,
 * expressed as percentages. They were inline in TablePage.tsx — an ~8,700-line
 * file rewritten many times a day — where the measurements survived only as
 * comments nobody re-derives.
 *
 * The failures these tests exist to catch are the ones that look fine in code
 * review and wrong on screen:
 *
 *   - a table size with no ring at all, so seats index past the end of the
 *     array and simply do not render (this really happened: 6MAX/9MAX were the
 *     only rings, chosen by `maxPlayers === 9`, so an 8-max table lost seats 7
 *     and 8);
 *   - hero not at slot 0, which puts the hero somewhere around the rail instead
 *     of bottom-centre;
 *   - a seat pushed off the frame, or onto the felt instead of the rail.
 */
import { describe, it, expect } from 'vitest';
import {
  SEAT_LAYOUTS,
  SEAT_POSITIONS_6MAX,
  SEAT_POSITIONS_9MAX,
  seatLayoutFor,
  createEmptySeats,
} from '../../src/lib/tableSeatGeometry';

const SIZES = [2, 3, 4, 5, 6, 7, 8, 9] as const;

describe('every table size has a complete ring', () => {
  it.each(SIZES)('%i-max has exactly that many seats', (n) => {
    expect(SEAT_LAYOUTS[n]).toBeDefined();
    expect(SEAT_LAYOUTS[n]).toHaveLength(n);
  });

  it('covers 2 through 9 and nothing else', () => {
    expect(Object.keys(SEAT_LAYOUTS).map(Number).sort((a, b) => a - b)).toEqual([...SIZES]);
  });
});

describe('seatLayoutFor never returns a ring too short for the table', () => {
  it.each(SIZES)('%i-max gets a ring of the right length', (n) => {
    expect(seatLayoutFor(n)).toHaveLength(n);
  });

  it.each([0, 1, -5, 10, 99, NaN])('clamps the nonsense size %p instead of crashing', (n) => {
    const ring = seatLayoutFor(n as number);
    expect(Array.isArray(ring)).toBe(true);
    expect(ring.length).toBeGreaterThanOrEqual(2);
    expect(ring.length).toBeLessThanOrEqual(9);
  });

  it('a table size can never index past the end of its own ring', () => {
    // The original bug in one line: seat index n-1 must exist for an n-max table.
    for (const n of SIZES) {
      const ring = seatLayoutFor(n);
      expect(ring[n - 1]).toBeDefined();
    }
  });
});

describe('hero is always slot 0, bottom-centre', () => {
  it.each(SIZES)('%i-max puts hero at the bottom middle', (n) => {
    const hero = seatLayoutFor(n)[0];
    expect(hero.x).toBe(50);
    expect(hero.y).toBeGreaterThan(85); // below the rail, per the 1.33x hero avatar
  });
});

describe('no seat escapes the frame', () => {
  it.each(SIZES)('%i-max keeps every seat on screen', (n) => {
    for (const seat of seatLayoutFor(n)) {
      expect(seat.x).toBeGreaterThanOrEqual(0);
      expect(seat.x).toBeLessThanOrEqual(100);
      expect(seat.y).toBeGreaterThanOrEqual(0);
      expect(seat.y).toBeLessThanOrEqual(100);
    }
  });

  it.each(SIZES)('%i-max has no two seats stacked on the same spot', (n) => {
    const ring = seatLayoutFor(n);
    const keys = new Set(ring.map((s) => `${s.x},${s.y}`));
    expect(keys.size).toBe(ring.length);
  });
});

describe('the named rings stay the ones the layouts use', () => {
  it('6-max and 9-max are the shared constants, not copies that can drift', () => {
    expect(SEAT_LAYOUTS[6]).toBe(SEAT_POSITIONS_6MAX);
    expect(SEAT_LAYOUTS[9]).toBe(SEAT_POSITIONS_9MAX);
  });
});

describe('createEmptySeats', () => {
  it.each([6, 9] as const)('makes %i empty slots', (n) => {
    const seats = createEmptySeats(n);
    expect(seats).toHaveLength(n);
    expect(seats.every((s) => s === null)).toBe(true);
  });

  it('returns a fresh array each time, not a shared one', () => {
    const a = createEmptySeats(9);
    const b = createEmptySeats(9);
    expect(a).not.toBe(b);
  });
});
