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
  rotateSeatsForHero,
  seatPixelMap,
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SEAT ROTATION (2026-08-19, second pass).
 *
 * The rotation decides which chair on screen belongs to which player. Getting
 * it wrong does not throw — it silently seats the wrong avatar in the wrong
 * place, or puts the dealer button one seat off, and the only way anyone finds
 * out is a player saying the table looks scrambled.
 *
 * The failure that WOULD throw is the one these tests care about most: a hero
 * seat larger than the ring makes the modular arithmetic go negative, every
 * position comes back undefined, and the table white-screens.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const RING6 = SEAT_POSITIONS_6MAX;

describe('rotateSeatsForHero', () => {
  it('returns one entry per chair', () => {
    for (const n of SIZES) {
      expect(rotateSeatsForHero(seatLayoutFor(n), 1)).toHaveLength(n);
    }
  });

  it.each([1, 2, 3, 4, 5, 6])('puts the hero in seat %i at the bottom-centre slot', (seat) => {
    const rotated = rotateSeatsForHero(RING6, seat);
    const hero = rotated[seat - 1];
    expect(hero.visualIndex).toBe(0);
    expect(hero.pos).toBe(RING6[0]);
  });

  it('leaves the ring alone when the hero is not seated', () => {
    const rotated = rotateSeatsForHero(RING6, 0);
    expect(rotated.map((r) => r.visualIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rotated.map((r) => r.pos)).toEqual(RING6);
  });

  it('hands out every visual slot exactly once', () => {
    for (const n of SIZES) {
      const ring = seatLayoutFor(n);
      for (let seat = 1; seat <= n; seat++) {
        const slots = rotateSeatsForHero(ring, seat).map((r) => r.visualIndex);
        expect([...slots].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
      }
    }
  });

  it('preserves who sits next to whom — it rotates, it does not reshuffle', () => {
    // Walking the physical seats in order must walk the visual slots in order
    // too, wrapping exactly once.
    for (let seat = 1; seat <= 6; seat++) {
      const slots = rotateSeatsForHero(RING6, seat).map((r) => r.visualIndex);
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i]).toBe((slots[i - 1] + 1) % 6);
      }
    }
  });

  it('never returns a seat with no position, for any seat on any ring', () => {
    for (const n of SIZES) {
      const ring = seatLayoutFor(n);
      for (let seat = 0; seat <= n; seat++) {
        for (const r of rotateSeatsForHero(ring, seat)) {
          expect(r.pos, `size ${n} seat ${seat}`).toBeDefined();
          expect(Number.isFinite(r.pos.x)).toBe(true);
          expect(Number.isFinite(r.pos.y)).toBe(true);
        }
      }
    }
  });

  it.each([7, 9, 12, 99])(
    'survives hero seat %i on a 6-chair ring — the white-screen regression',
    (seat) => {
      // maxPlayers starts at 6 and the table row can arrive after the seat
      // does. Before the guard, (physIdx - heroIdx + 6) % 6 went NEGATIVE and
      // every pos came back undefined; the seat renderer then read pos.y off
      // nothing and took the whole table down.
      const rotated = rotateSeatsForHero(RING6, seat);
      expect(rotated).toHaveLength(6);
      for (const r of rotated) {
        expect(r.pos).toBeDefined();
        expect(r.visualIndex).toBeGreaterThanOrEqual(0);
        expect(r.visualIndex).toBeLessThan(6);
      }
    }
  );

  it.each([-1, -99, NaN, Infinity, 1.5])('does not crash on the nonsense seat %p', (seat) => {
    const rotated = rotateSeatsForHero(RING6, seat as number);
    expect(rotated).toHaveLength(6);
    expect(rotated.every((r) => !!r.pos)).toBe(true);
  });

  it('does not mutate the ring it was handed', () => {
    const ring = RING6.map((p) => ({ ...p }));
    const copy = JSON.parse(JSON.stringify(ring));
    rotateSeatsForHero(ring, 4);
    expect(ring).toEqual(copy);
  });

  it('returns nothing for an empty ring rather than throwing', () => {
    expect(rotateSeatsForHero([], 3)).toEqual([]);
  });
});

describe('seatPixelMap', () => {
  const scaler = { w: 300, h: 600 };

  it('keys by 1-indexed seat number, not array index', () => {
    const map = seatPixelMap([{ x: 50, y: 50 }], scaler);
    expect(map.has(1)).toBe(true);
    expect(map.has(0)).toBe(false);
  });

  it('turns percentages into scaler pixels', () => {
    const map = seatPixelMap([{ x: 50, y: 50 }, { x: 10, y: 90 }], scaler);
    expect(map.get(1)).toEqual({ x: 150, y: 300 });
    expect(map.get(2)).toEqual({ x: 30, y: 540 });
  });

  it('skips seats with no position instead of mapping them to 0,0', () => {
    const map = seatPixelMap([{ x: 50, y: 50 }, null, undefined, { x: 0, y: 0 }], scaler);
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([1, 4]);
  });

  it('is empty for an empty ring', () => {
    expect(seatPixelMap([], scaler).size).toBe(0);
  });

  it('produces real numbers even before the scaler has been measured', () => {
    const map = seatPixelMap([{ x: 50, y: 93.5 }], { w: 0, h: 0 });
    expect(map.get(1)).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(map.get(1)!.x)).toBe(false);
  });

  it('covers every chair of a real rotated ring', () => {
    const positions = rotateSeatsForHero(seatLayoutFor(9), 5).map((r) => r.pos);
    const map = seatPixelMap(positions, scaler);
    expect(map.size).toBe(9);
    for (let seat = 1; seat <= 9; seat++) {
      const px = map.get(seat)!;
      expect(px.x).toBeGreaterThanOrEqual(0);
      expect(px.x).toBeLessThanOrEqual(scaler.w);
      expect(px.y).toBeGreaterThanOrEqual(0);
      expect(px.y).toBeLessThanOrEqual(scaler.h);
    }
  });
});
