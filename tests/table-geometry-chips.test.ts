/**
 * Dan 2026-08-19, bug list item 8: "chips must always be in front of the user
 * (in front of the button if they're the button)."
 *
 * The dealer button travelled 0.28 of the way from a seat toward the centre
 * horizontally; the bet chips travelled a flat 0.22 on both axes. So on every
 * side seat the BUTTON sat further out on the felt than the chips it was meant
 * to stand behind, and the two collided.
 *
 * These tests walk every seat of every table size (2-max through 9-max, the
 * real production rings) and assert the reading order out from the player is
 * always: player, then button, then chips.
 */
import { describe, it, expect } from 'vitest';
import {
  betChipFactor,
  betChipPosition,
  chipCollectFactor,
  dealerButtonPosition,
  BET_CHIP_FACTOR,
  CHIP_COLLECT_END_FACTOR,
  DEALER_BUTTON_FACTOR,
  type Pos,
} from '../src/components/table/tableGeometry';

/** The production seat rings, copied from TablePage.tsx. */
const RINGS: Record<number, Pos[]> = {
  2: [{ x: 50, y: 93.5 }, { x: 50, y: 6 }],
  3: [{ x: 50, y: 93.5 }, { x: 20.5, y: 14 }, { x: 79.5, y: 14 }],
  4: [{ x: 50, y: 93.5 }, { x: 10.5, y: 45 }, { x: 50, y: 6 }, { x: 89.5, y: 45 }],
  5: [
    { x: 50, y: 93.5 }, { x: 10.5, y: 55 }, { x: 20.5, y: 14 },
    { x: 79.5, y: 14 }, { x: 89.5, y: 55 },
  ],
  6: [
    { x: 50, y: 93.5 }, { x: 10.5, y: 66 }, { x: 10.5, y: 33 },
    { x: 50, y: 6 }, { x: 89.5, y: 33 }, { x: 89.5, y: 66 },
  ],
  7: [
    { x: 50, y: 93.5 }, { x: 10.5, y: 62 }, { x: 10.5, y: 33 }, { x: 27, y: 13 },
    { x: 73, y: 13 }, { x: 89.5, y: 33 }, { x: 89.5, y: 62 },
  ],
  8: [
    { x: 50, y: 93.5 }, { x: 19, y: 82.5 }, { x: 10.5, y: 52 }, { x: 10.5, y: 28 },
    { x: 50, y: 6 }, { x: 89.5, y: 28 }, { x: 89.5, y: 52 }, { x: 81, y: 82.5 },
  ],
  9: [
    { x: 50, y: 93.5 }, { x: 19, y: 82.5 }, { x: 10.5, y: 58 }, { x: 10.5, y: 36 },
    { x: 27, y: 13 }, { x: 73, y: 13 }, { x: 89.5, y: 36 }, { x: 89.5, y: 58 },
    { x: 81, y: 82.5 },
  ],
};

/** Distance from the seat toward the centre, along one axis. */
const travel = (seatV: number, markerV: number) => Math.abs(markerV - seatV);

describe('bet chips vs the dealer button', () => {
  for (const [size, ring] of Object.entries(RINGS)) {
    describe(`${size}-max`, () => {
      ring.forEach((seat, i) => {
        it(`seat ${i + 1} holding the button: player -> button -> chips`, () => {
          const btn = dealerButtonPosition(seat);
          const chips = betChipPosition(seat, true);

          // On each axis that actually has room to move, the chips must be
          // further from the seat than the button is.
          if (Math.abs(50 - seat.x) > 0.01) {
            expect(travel(seat.x, chips.x)).toBeGreaterThan(travel(seat.x, btn.x));
          }
          if (Math.abs(50 - seat.y) > 0.01) {
            expect(travel(seat.y, chips.y)).toBeGreaterThan(travel(seat.y, btn.y));
          }
        });

        it(`seat ${i + 1} without the button: chips still in front of the player`, () => {
          const chips = betChipPosition(seat, false);
          // Strictly between the seat and the centre, never behind the player.
          if (Math.abs(50 - seat.x) > 0.01) {
            expect(travel(seat.x, chips.x)).toBeGreaterThan(0);
            expect(travel(seat.x, chips.x)).toBeLessThan(travel(seat.x, 50));
          }
          if (Math.abs(50 - seat.y) > 0.01) {
            expect(travel(seat.y, chips.y)).toBeGreaterThan(0);
            expect(travel(seat.y, chips.y)).toBeLessThan(travel(seat.y, 50));
          }
        });
      });
    });
  }
});

describe('betChipFactor', () => {
  it('leaves ordinary seats exactly where they were', () => {
    expect(betChipFactor(false)).toEqual({ x: BET_CHIP_FACTOR.x, y: BET_CHIP_FACTOR.y });
  });

  it('clears the button on both axes for the dealer seat', () => {
    const f = betChipFactor(true);
    expect(f.x).toBeGreaterThan(DEALER_BUTTON_FACTOR.x);
    expect(f.y).toBeGreaterThan(DEALER_BUTTON_FACTOR.y);
  });

  it('never pulls the dealer seat chips back toward the player', () => {
    const f = betChipFactor(true);
    expect(f.x).toBeGreaterThanOrEqual(BET_CHIP_FACTOR.x);
    expect(f.y).toBeGreaterThanOrEqual(BET_CHIP_FACTOR.y);
  });

  it('keeps the chips well short of the middle of the table', () => {
    const f = betChipFactor(true);
    expect(f.x).toBeLessThan(0.5);
    expect(f.y).toBeLessThan(0.5);
  });
});

describe('CONTROL: the old flat 0.22 really was behind the button', () => {
  it('a side seat put the button further onto the felt than its chips', () => {
    const seat = { x: 10.5, y: 66 };
    const btn = dealerButtonPosition(seat);
    const oldChipsX = seat.x + (50 - seat.x) * 0.22;
    expect(travel(seat.x, oldChipsX)).toBeLessThan(travel(seat.x, btn.x));
  });
});

describe('chip collect vector — must never overshoot the pot', () => {
  it('lands every seat on the SAME endpoint, dealer or not', () => {
    for (const isDealer of [false, true]) {
      const bet = betChipFactor(isDealer);
      const collect = chipCollectFactor(isDealer);
      expect(bet.x + collect.x).toBeCloseTo(CHIP_COLLECT_END_FACTOR, 6);
      expect(bet.y + collect.y).toBeCloseTo(CHIP_COLLECT_END_FACTOR, 6);
    }
  });

  it('never carries a chip past the centre of the table', () => {
    for (const isDealer of [false, true]) {
      const bet = betChipFactor(isDealer);
      const collect = chipCollectFactor(isDealer);
      // A factor of 1 IS the centre. Anything above it flies out the far side.
      expect(bet.x + collect.x).toBeLessThan(1);
      expect(bet.y + collect.y).toBeLessThan(1);
    }
  });

  it('reproduces the old 0.44 offset exactly for an ordinary seat', () => {
    // Regression guard: the ordinary seat must not move at all. The old code
    // was betOffset * 2 with a 0.22 factor, i.e. 0.44.
    const collect = chipCollectFactor(false);
    expect(collect.x).toBeCloseTo(0.44, 6);
    expect(collect.y).toBeCloseTo(0.44, 6);
  });

  it('CONTROL: the old betOffset*2 rule WOULD have overshot on the dealer seat', () => {
    const bet = betChipFactor(true);
    const oldEndpoint = bet.x * 3; // resting offset + 2x offset
    expect(oldEndpoint).toBeGreaterThan(1); // past the centre — the bug
  });

  it('shortens the remaining travel for the seat that starts further out', () => {
    expect(chipCollectFactor(true).x).toBeLessThan(chipCollectFactor(false).x);
  });
});
