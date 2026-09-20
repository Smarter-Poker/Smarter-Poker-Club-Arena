import { describe, expect, it } from 'vitest';
import {
  choose,
  minePrize,
  MINE_COUNTS,
  RANDOM_SPACE,
  ROAD_LADDERS,
  roadSurvives,
  roundedMinePrize,
} from '../../src/utils/diamondChoiceMath';

describe('Diamond choice games keep the edge once per round', () => {
  it('every Mines stopping point returns exactly four fifths before cent rounding', () => {
    for (const mines of MINE_COUNTS) {
      for (let k = 1; k <= 25 - mines; k++) {
        for (const bet of [0.25, 0.26, 1, 1.01, 2, 5, 10, 50]) {
          const p = minePrize(bet, mines, k);
          expect(p.numerator * choose(25 - mines, k) * 5n).toBe(
            4n * BigInt(Math.round(bet * 100)) * choose(25, k) * p.denominator
          );
        }
      }
    }
  });
  it('every road ladder boundary has the same expected return within the RNG grain', () => {
    for (const ladder of Object.values(ROAD_LADDERS)) {
      for (const target of ladder) {
        const wins = (80n * RANDOM_SPACE) / BigInt(target);
        expect(roadSurvives(wins - 1n, target)).toBe(true);
        expect(roadSurvives(wins, target)).toBe(false);
        expect(80n * RANDOM_SPACE - wins * BigInt(target)).toBeLessThan(BigInt(target));
      }
    }
  });
  it('cent rounding cannot add a second edge', () => {
    const p = minePrize(1, 5, 2);
    const floor = p.numerator / p.denominator;
    const cutoff = ((p.numerator % p.denominator) * RANDOM_SPACE) / p.denominator;
    expect(roundedMinePrize(p.numerator, p.denominator, 0n)).toBe(floor + 1n);
    expect(roundedMinePrize(p.numerator, p.denominator, cutoff)).toBe(floor);
    expect(roundedMinePrize(200n, 1n, RANDOM_SPACE - 1n)).toBe(200n);
  });
  it('rejects unsupported mine counts, impossible reveals, and invalid RNG values', () => {
    expect(() => minePrize(1, 0, 1)).toThrow();
    expect(() => minePrize(1, 15, 11)).toThrow();
    expect(() => roadSurvives(-1n, 110)).toThrow();
    expect(() => roadSurvives(RANDOM_SPACE, 110)).toThrow();
  });
});
