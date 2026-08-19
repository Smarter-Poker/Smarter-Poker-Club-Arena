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
  dealerButtonPosition,
  BET_CHIP_FACTOR,
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
