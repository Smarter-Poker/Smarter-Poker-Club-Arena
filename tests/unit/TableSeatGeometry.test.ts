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
  TOP_CAP_Y_MAX,
  seatLayoutFor,
  createEmptySeats,
  rotateSeatsForHero,
  seatPixelMap,
  isTopCapSeat,
  outboardCardSide,
  seatCardSide,
} from '../../src/lib/tableSeatGeometry';

const SIZES = [2, 3, 4, 5, 6, 7, 8, 9] as const;

describe('every table size has a complete ring', () => {
  it.each(SIZES)('%i-max has exactly that many seats', (n) => {
    expect(SEAT_LAYOUTS[n]).toBeDefined();
    expect(SEAT_LAYOUTS[n]).toHaveLength(n);
  });

  it('covers 2 through 9 and nothing else', () => {
    expect(
      Object.keys(SEAT_LAYOUTS)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual([...SIZES]);
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH SIDE A SEAT HANGS ITS CARD FAN OFF (Dan 2026-08-26 villain-fan rebuild,
 * spec section 3b).
 *
 * ONE rule, every seat, every ring: the fan is MIRRORED OUTWARD, away from the
 * middle of the table. Left-half seats fan left, right-half seats fan right,
 * and dead centre (or unmeasurable) defaults right. This keeps the betting
 * lane between pod and pot clear — chips render inboard, cards outboard.
 *
 * This deliberately replaced the 2026-08-25 two-band rule (outboard at the
 * top cap, inboard elsewhere). Reintroducing a per-band or per-seat-index
 * branch is the regression these tests exist to catch.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('which side a seat hangs its card fan off', () => {
  it('every left-half seat fans left, every right-half seat fans right', () => {
    expect(seatCardSide(27, 6), '9-max top-left').toBe('left');
    expect(seatCardSide(73, 6), '9-max top-right').toBe('right');
    expect(seatCardSide(10.5, 58), 'left rail').toBe('left');
    expect(seatCardSide(89.5, 58), 'right rail').toBe('right');
    expect(seatCardSide(10.5, 82.5), 'bottom-left cap').toBe('left');
    expect(seatCardSide(89.5, 82.5), 'bottom-right cap').toBe('right');
  });

  it('a seat with no side (x exactly 50) keeps the long-standing right', () => {
    expect(seatCardSide(50, 5), 'top centre').toBe('right');
    expect(seatCardSide(50, 100), 'the hero slot').toBe('right');
  });

  it('degrades to right, not to a coin flip, when the seat cannot be measured', () => {
    // seatWrapperPercent in SeatSlot.tsx returns NaN when neither the inline
    // percentage nor the offset fallback can answer.
    expect(seatCardSide(NaN, NaN)).toBe('right');
    expect(seatCardSide(NaN, 6)).toBe('right');
  });

  it('the side is a function of x alone — y can never flip it', () => {
    for (const x of [0, 10.5, 20.5, 27, 49.9, 50.1, 73, 79.5, 89.5, 100]) {
      for (const y of [5, 6, 30, 58, 82.5, 100, NaN]) {
        expect(seatCardSide(x, y), `x ${x} y ${y}`).toBe(outboardCardSide(x));
      }
    }
  });

  it('applies the outward rule to every seat of every ring', () => {
    for (const n of SIZES) {
      for (const seat of seatLayoutFor(n)) {
        const expected = seat.x < 50 ? 'left' : 'right';
        expect(seatCardSide(seat.x, seat.y), `${n}-max seat ${seat.x},${seat.y}`).toBe(expected);
      }
    }
  });

  it('no seat sits near the top-cap threshold, so the band is never ambiguous', () => {
    // The threshold has to agree with TablePage's `pos.y < 20` test, which is
    // what tags `.seat-wrapper--top` and so what makes the outboard rule apply
    // at all. Clearance on both sides means a 1-point nudge to a ring can never
    // silently flip a seat between the two rules.
    for (const n of SIZES) {
      for (const seat of seatLayoutFor(n)) {
        expect(
          Math.abs(seat.y - TOP_CAP_Y_MAX),
          `${n}-max seat at y ${seat.y} sits on the top-cap threshold`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * RING EVENNESS UNDER THE TOP CAP (Dan 2026-08-25 round 2, item 10).
 *
 * "Villan 'Violet Wei' and villan Jaxaaron should both be raised up higher in
 * their positions on the table." Those are the left-high / right-high seats,
 * and the complaint is measurable: they sat with the ring's NARROWEST gap below
 * them and its WIDEST gap above them.
 *
 * Gaps are measured on the painted frame, where the locked 605/1000 aspect
 * makes one point of x 6.05px and one point of y 10px. Comparing raw
 * percentages instead would understate every corner, which is precisely where
 * the crowding was.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const railGapPx = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot((a.x - b.x) * 6.05, (a.y - b.y) * 10);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AND THEN THE BOARD TOOK THE MIDDLE OF THE RAIL (Dan 2026-08-27, item 2).
 *
 * "The board cards need to be increased in size ... LIKE FELT WINDOW 95%."
 *
 * A 95% board occupies y 37.2..48.9% of the scaler and, on a 375px phone, x
 * 15.1..84.7%. A side seat's 96px nameplate box reaches x 24.3%, so at that
 * width NO side seat can clear the cards horizontally — every one of them has
 * to be entirely above them or entirely below them. The rail's middle is gone,
 * and with it the even-thirds solves that put seats at 30, 23 and 33.
 *
 * The band and the two ceilings that bound it are derived in
 * src/lib/tableSeatGeometry.ts (THE BOARD'S BAND) and re-measured on every run
 * by tests/unit/mobileBoardAndActionBar.test.ts. What is asserted HERE is what
 * the ring looks like afterwards: the seats are where the band leaves room, and
 * the legs between them are as even as that leaves possible.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('the seats under the top cap are not crowded', () => {
  /* Dan 2026-08-26 mobile pass, item 3: the side rails moved from x 10.5/89.5
     to x 8/92 — off the felt, toward the screen edges. That is a separate
     change from the board's band, which moves the same seats on y, and the two
     landed together: every side seat below is pinned at the item-3 x AND the
     item-2 y. The BOTTOM CAPS stay at 10.5/89.5 — item 3 left them there so
     their dealer-button projection would not drift inboard onto a neighbour. */
  it('9-max went 36 -> 30 for item 10, then 30 -> 25 for the 95% board', () => {
    const ring = seatLayoutFor(9);
    expect(ring[3]).toEqual({ x: 8, y: 25 });
    expect(ring[6]).toEqual({ x: 92, y: 25 });
  });

  it('8-max had the same crowding and the same two moves, 28 -> 23 -> 25', () => {
    // 23 was legal under the board's band and moved anyway: with the low seat
    // forced down to 58, 25 is what keeps the two legs above the bottom cap
    // from splaying to 350/299.
    const ring = seatLayoutFor(8);
    expect(ring[3]).toEqual({ x: 8, y: 25 });
    expect(ring[5]).toEqual({ x: 92, y: 25 });
  });

  it('7-max was even under the cap and was moved only because 33 is in the band', () => {
    // It sat at 33, which is dead centre of a 95% board. It was the one ring
    // whose seats item 10 deliberately left alone; item 2 could not.
    const ring = seatLayoutFor(7);
    expect(ring[2]).toEqual({ x: 8, y: 25 });
    expect(ring[5]).toEqual({ x: 92, y: 25 });
  });

  it('every side seat is clear of the board band - above y 25 or below y 58', () => {
    /* The one-line statement of the whole seat move. Side-rail seats only:
       the top-cap diagonals and the two midline seats are nowhere near it.

       Both x values are checked because the rail has two of them after
       2026-08-26 item 3 — the moved side seats sit at 8/92 and the bottom caps
       were deliberately left at 10.5/89.5. Listing them rather than testing
       `x < 20 || x > 80` keeps the check honest: a new rail x has to be added
       here on purpose, it cannot arrive by falling inside a range. */
    const SIDE_RAIL_X = [8, 92, 10.5, 89.5];
    for (const n of SIZES) {
      for (const seat of seatLayoutFor(n)) {
        if (!SIDE_RAIL_X.includes(seat.x)) continue;
        expect(
          seat.y <= 25 || seat.y >= 58,
          `${n}-max: seat ${JSON.stringify(seat)} sits in the community board's band`
        ).toBe(true);
      }
    }
  });

  it.each([8, 9] as const)(
    '%i-max: the three legs from the bottom cap to the top cap are as even as the band allows',
    (n) => {
      /* Left rail, walking up: bottom cap -> low -> high -> top cap.
         245/220/316 (9-max) and 305/240/331 (8-max) before item 10 — a
         widest-to-narrowest ratio of 1.44 and 1.38, with the widest gap
         directly above the narrowest, which is what "too low" looked like.
         Item 10 got both to within 1.25.

         1.25 IS NO LONGER REACHABLE and the reason is arithmetic, not taste.
         The middle of the rail belongs to the cards, so the low seat is pinned
         into [57.5, 58] and the high seat may not sit below the board-band
         ceiling; the leg BETWEEN them therefore cannot be short, while the leg
         from the high seat up to 9-max's top diagonal cannot be long (both of
         its ends are fixed within a point or two). 9-max is the binding ring
         either way.

         WHICH CEILING, AND WHY THE NUMBER MOVED TWICE. The band was solved at
         the old side rail, x 10.5/89.5, where the ceiling is y 26.7. Item 3
         (Dan 2026-08-26) then took the side rail out to x 8/92 and the same
         commit rewrote the dealer button's swing, and the two together move the
         puck INBOARD as its seat moves out: re-measured against the shipped
         projection the ceiling at x 8 is 25.77, not 26.7. So these seats sit at
         25 — 3.1px of clearance on a 375px phone, the same margin 26 was given
         when the ceiling was 26.7 — and 26 is simply unavailable, because at
         x 8 it paints the puck 0.16 points onto the cards.

         The legs that leaves are 245/330/317 (8-max) and 245/330/222 (9-max),
         so the widest-to-narrowest ratio is 1.34 and 1.49. 1.49 is the number
         the bound below is set just above: it is what the two ceilings permit,
         not slack. What matters is that nothing is CROWDED — the tightest leg
         is still over twice a seat box — and that the widest leg is the one
         that STEPS OVER the board rather than one sitting on top of a narrow
         one. Both are asserted, and both historical failures (9-max 245/220/316
         and 8-max 305/240/331) break the second outright: each put its
         NARROWEST leg in the middle, which is exactly what "those two seats are
         too low" looked like. */
      const ring = seatLayoutFor(n);
      const rail = [ring[1], ring[2], ring[3], ring[4]];
      const legs = [
        railGapPx(rail[0], rail[1]),
        railGapPx(rail[1], rail[2]),
        railGapPx(rail[2], rail[3]),
      ];
      expect(Math.max(...legs) / Math.min(...legs), `${n}-max legs ${legs}`).toBeLessThanOrEqual(
        1.5
      );
      // No leg is anywhere near a collision: `.seat { width: 96px }`.
      expect(Math.min(...legs), `${n}-max legs ${legs}`).toBeGreaterThanOrEqual(2 * 96);
      // The widest leg is the one crossing the board, not one of the top pair.
      expect(legs.indexOf(Math.max(...legs)), `${n}-max legs ${legs}`).toBe(1);
    }
  );

  it.each([7, 8, 9] as const)('%i-max keeps its rails mirrored left and right', (n) => {
    const ring = seatLayoutFor(n);
    const left = ring.filter((s) => s.x < 50).map((s) => s.y);
    const right = ring.filter((s) => s.x > 50).map((s) => s.y);
    expect([...left].sort((a, b) => a - b)).toEqual([...right].sort((a, b) => a - b));
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
    const map = seatPixelMap(
      [
        { x: 50, y: 50 },
        { x: 10, y: 90 },
      ],
      scaler
    );
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
