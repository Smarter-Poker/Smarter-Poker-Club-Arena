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
import {
  splitBuyIn,
  totalBuyIn,
  DEFAULT_RAKE_RATE,
  clampRakeToCap,
  isRakeWithinCap,
} from '../../src/utils/buyIn';

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
    // Dan 2026-08-21 (second batch): 15 is 14 + 1, NOT 13 + 2. The old
    // expectation here was 13 + 2 = 13.33%, which is the exact tournament he
    // screenshotted when he said "rake is exceeding 10%".
    expect(splitBuyIn(15)).toEqual({ total: 15, prize: 14, fee: 1 });
    // totalBuyIn is the inverse: prize + fee gets back to the advertised price.
    const s = splitBuyIn(20);
    expect(totalBuyIn(s.prize, s.fee)).toBe(20);
  });

  /**
   * Dan 2026-08-21 (second batch) SUPERSEDES "every positive buy-in pays a fee".
   *
   * That rule was added earlier the same day so micro games could not enter
   * rake-free, and it was implemented as `max(1, ...)`. With whole-number fees
   * it cannot coexist with a 10% ceiling: one chip on a 5 game IS 20%, and the
   * live Pre-Dawn Mystery Bounties ran at exactly that all night. A breached
   * ceiling is the more serious failure, so the ceiling wins and games under 10
   * take nothing. The old test is rewritten rather than deleted so the reason
   * the rule reversed stays in the suite.
   */
  it('THE CEILING: the house never takes more than 10%, at any price point', () => {
    for (let total = 1; total <= 2000; total++) {
      const s = splitBuyIn(total);
      const pct = (s.fee / s.total) * 100;
      expect(pct).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  it('a buy-in under 10 takes no rake — the cost of a whole-number cap', () => {
    for (const total of [1, 2, 3, 4, 5, 9]) {
      expect(splitBuyIn(total).fee).toBe(0);
    }
    // From 10 up, every rung pays a real fee again.
    expect(splitBuyIn(10).fee).toBe(1);
    expect(splitBuyIn(15).fee).toBe(1);
    expect(splitBuyIn(25).fee).toBe(2);
  });

  it('clampRakeToCap fixes a bad pair without changing what the player pays', () => {
    // The Evening Mystery Bounty as it shipped: 13 + 2.
    expect(clampRakeToCap(13, 2)).toEqual({ prize: 14, fee: 1 });
    // A pair already within cap is left exactly as it is.
    expect(clampRakeToCap(18, 2)).toEqual({ prize: 18, fee: 2 });
    expect(isRakeWithinCap(13, 2)).toBe(false);
    expect(isRakeWithinCap(14, 1)).toBe(true);
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
