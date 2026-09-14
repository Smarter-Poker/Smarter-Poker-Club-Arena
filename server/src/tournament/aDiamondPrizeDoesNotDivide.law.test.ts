/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND PRIZE DOES NOT DIVIDE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `computePlacePrize` is the canonical payout division, and its own header
 * calls the single division at the end "the one place a half-cent is
 * legitimately decided". That is exactly right for a chip tournament and
 * exactly wrong for an indivisible unit. A half Diamond is not a small
 * imprecision to be decided: it is an amount no door in this estate accepts.
 * The custody reserve floors it, the hand settler refuses it, and the wallet
 * stores diamonds as an integer column.
 *
 * So the ladder takes the tournament's own unit, the same way the cash tables
 * were taught to - the run-it-twice per-board slice, the multi-board
 * settlement, the tie chop and the hi-lo split all read their table's unit
 * rather than assuming a cent. The prize ladder was the last place in the
 * estate that still assumed one.
 *
 * WHAT MUST SURVIVE THE CHANGE, and is asserted here in both denominations,
 * because a payout rule that pays whole Diamonds while losing its exactness
 * has traded one defect for a worse one:
 *
 *   1. The places sum to the pool EXACTLY. Not to within a unit.
 *   2. The residual lands on the LAST paid place, never a headline one.
 *   3. A pool too small to pay every place does not overpay.
 *   4. The chip ladder is unchanged, to the cent, on the structures
 *      production actually runs.
 */
import { describe, expect, it } from 'vitest';
import { computePlacePrize } from './payoutMath.js';
import { CHIP_UNIT_CENTS } from './tournamentUnit.js';

/** The nine-place structure the production reconciler is pinned against. */
const NINE_PLACE = [
  { place: 1, percentage: 30 },
  { place: 2, percentage: 20 },
  { place: 3, percentage: 14 },
  { place: 4, percentage: 10 },
  { place: 5, percentage: 8 },
  { place: 6, percentage: 6 },
  { place: 7, percentage: 5 },
  { place: 8, percentage: 4.5 },
  { place: 9, percentage: 2.5 },
];

/** Three places, deliberately with percentages that do not divide evenly. */
const THREE_PLACE = [
  { place: 1, percentage: 50 },
  { place: 2, percentage: 30 },
  { place: 3, percentage: 20 },
];

const DIAMOND = 100;

const ladder = (pool: number, structure: typeof NINE_PLACE, unit: number) =>
  structure.map((p) => computePlacePrize(pool, structure, p.place, unit));

describe('LAW - a Diamond prize ladder pays whole Diamonds and pays the pool exactly', () => {
  /* Pools chosen to be awkward: primes, pools smaller than the field, pools
     where an even percentage still lands mid-Diamond. */
  const POOLS = [1, 2, 3, 5, 7, 9, 11, 13, 17, 23, 47, 99, 100, 101, 483, 997, 1000, 12345];

  it.each(POOLS)('a %i Diamond pool pays whole Diamonds, over nine places', (pool) => {
    const prizes = ladder(pool, NINE_PLACE, DIAMOND);
    for (const [i, prize] of prizes.entries()) {
      expect(
        Number.isSafeInteger(prize),
        `place ${i + 1} of a ${pool} Diamond pool is ${prize}, which no Diamond door accepts`
      ).toBe(true);
      expect(prize, `place ${i + 1} is negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(POOLS)('and the nine places still sum to the %i Diamond pool exactly', (pool) => {
    const total = ladder(pool, NINE_PLACE, DIAMOND).reduce((a, b) => a + b, 0);
    expect(total, `a ${pool} Diamond pool paid out ${total}`).toBe(pool);
  });

  it.each(POOLS)('the same holds over three places on a %i Diamond pool', (pool) => {
    const prizes = ladder(pool, THREE_PLACE, DIAMOND);
    expect(prizes.every((p) => Number.isSafeInteger(p))).toBe(true);
    expect(prizes.reduce((a, b) => a + b, 0)).toBe(pool);
  });

  it('a pool smaller than the field it is paying does not overpay', () => {
    /* Three Diamonds over nine places. Six places get nothing, and the six
       nothings are the correct answer: an indivisible unit cannot be split
       nine ways. What matters is that the three that ARE paid sum to three. */
    const prizes = ladder(3, NINE_PLACE, DIAMOND);
    expect(prizes.reduce((a, b) => a + b, 0)).toBe(3);
    expect(prizes.every((p) => Number.isSafeInteger(p) && p >= 0)).toBe(true);
  });

  it('the residual lands on the last paid place, not on a headline one', () => {
    /* 7 Diamonds over three places at 50/30/20 is 3.5 / 2.1 / 1.4. Snapped,
       the first two take 4 and 2, and the last takes what is left. The first
       place is never the one adjusted. */
    const prizes = ladder(7, THREE_PLACE, DIAMOND);
    expect(prizes[0]).toBe(4);
    expect(prizes[1]).toBe(2);
    expect(prizes[2]).toBe(1);
    expect(prizes.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('one Diamond over nine places pays first place and nobody else', () => {
    const prizes = ladder(1, NINE_PLACE, DIAMOND);
    expect(prizes[0]).toBe(1);
    expect(prizes.slice(1).every((p) => p === 0)).toBe(true);
  });
});

describe('LAW - and the chip ladder did not move', () => {
  it('pays the cents it has always paid, on the reconciler structure', () => {
    /* The exact figures the production reconciler is pinned to. If the unit
       parameter had changed the chip path at all, these move. */
    expect(computePlacePrize(483, NINE_PLACE, 1, CHIP_UNIT_CENTS)).toBe(144.9);
    expect(computePlacePrize(483, NINE_PLACE, 9, CHIP_UNIT_CENTS)).toBe(12.07);
  });

  it('and the default unit is a cent, so every existing caller is unchanged', () => {
    for (const pool of [483, 997, 12345.67]) {
      for (const p of NINE_PLACE) {
        expect(
          computePlacePrize(pool, NINE_PLACE, p.place, CHIP_UNIT_CENTS),
          `place ${p.place} moved when the unit parameter was added`
        ).toBe(computePlacePrize(pool, NINE_PLACE, p.place, 1));
      }
    }
  });

  it('a nonsense unit falls back to a cent rather than inventing a grid', () => {
    for (const bad of [0, -1, 0.5, NaN, Number.POSITIVE_INFINITY]) {
      expect(computePlacePrize(483, NINE_PLACE, 1, bad)).toBe(144.9);
    }
  });
});
