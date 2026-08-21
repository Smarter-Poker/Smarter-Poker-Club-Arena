/**
 * ONE RAKE MODEL (Dan, 2026-08-21).
 *
 * "Ensure all buy-ins pay the registration fee and 10% rake is taken OUT for
 * all buy-ins and rebuys."
 *
 * Entries always worked that way. Rebuys and re-entries did not: they added the
 * fee ON TOP, so a 20 rebuy charged 22 while a 20 entry charged 20 - two prices
 * for one rule. These pin the rule on the client side; the same arithmetic is
 * enforced in fn_create_tournament and process_tournament_rebuy.
 */
import { describe, it, expect } from 'vitest';
import { splitBuyIn, totalBuyIn, DEFAULT_RAKE_RATE } from '../../src/utils/buyIn';

describe('the fee is cut OUT of the advertised price', () => {
  it('prize + fee is exactly the price the player pays', () => {
    for (const total of [1, 2, 4, 5, 10, 15, 20, 33, 50, 99, 100, 250, 1000]) {
      const s = splitBuyIn(total);
      expect(s.total).toBe(total);
      expect(s.prize + s.fee).toBe(total);
      expect(Number.isInteger(s.prize)).toBe(true);
      expect(Number.isInteger(s.fee)).toBe(true);
    }
  });

  it('the fee is 10% of the price, never a surcharge on top of it', () => {
    expect(splitBuyIn(100)).toEqual({ total: 100, prize: 90, fee: 10 });
    expect(splitBuyIn(20)).toEqual({ total: 20, prize: 18, fee: 2 });
    expect(splitBuyIn(15)).toEqual({ total: 15, prize: 13, fee: 2 });
    // totalBuyIn is the inverse: prize + fee gets back to the advertised price.
    const s = splitBuyIn(20);
    expect(totalBuyIn(s.prize, s.fee)).toBe(20);
  });

  it('EVERY positive buy-in pays a fee, however small', () => {
    // round(4 * 0.1) is 0, so buy-ins under 5 used to enter rake-free.
    for (const total of [1, 2, 3, 4]) {
      expect(splitBuyIn(total).fee).toBeGreaterThanOrEqual(1);
    }
  });

  it('a freeroll stays free - the one case where deriving a fee is wrong', () => {
    expect(splitBuyIn(0)).toEqual({ total: 0, prize: 0, fee: 0 });
  });

  it('the fee never exceeds the price', () => {
    for (const total of [1, 2, 3]) {
      const s = splitBuyIn(total);
      expect(s.fee).toBeLessThanOrEqual(s.total);
      expect(s.prize).toBeGreaterThanOrEqual(0);
    }
  });

  it('the house rate is 10%', () => {
    expect(DEFAULT_RAKE_RATE).toBe(0.1);
  });
});
