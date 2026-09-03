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
      /* The TOTAL is still a whole number — that is the price on the card and
         nothing about it changed. The SPLIT is in cents now (Dan 2026-08-25),
         so neither side is an integer any more on the micro rungs: a 1-chip
         game is 0.90 + 0.10. Compared to two decimals because 0.9 + 0.1 is
         0.9999999999999999 in binary floating point. */
      expect(Number((s.prize + s.fee).toFixed(2))).toBe(total);
      expect(s.fee).toBe(Number(s.fee.toFixed(2)));
      expect(s.prize).toBe(Number(s.prize.toFixed(2)));
    }
  });

  it('the fee is 10% of the price, never a surcharge on top of it', () => {
    expect(splitBuyIn(100)).toEqual({ total: 100, prize: 90, fee: 10 });
    expect(splitBuyIn(20)).toEqual({ total: 20, prize: 18, fee: 2 });
    // Dan 2026-08-21 (second batch): 15 is 14 + 1, NOT 13 + 2. The old
    // expectation here was 13 + 2 = 13.33%, which is the exact tournament he
    // screenshotted when he said "rake is exceeding 10%".
    /* Dan 2026-08-25: cents, not whole chips. 15 is 13.50 + 1.50, which is
       exactly 10% — the ceiling is hit precisely rather than undershot to 1. */
    expect(splitBuyIn(15)).toEqual({ total: 15, prize: 13.5, fee: 1.5 });
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

  /**
   * SUPERSEDED IN TURN, 2026-08-25. Dan: "FRACTIONAL FEE'S NEED TO BE ALLOWED,
   * WE HAVE 1 BUY IN, 5 BUY IN'S ETC THOSE SHOULD BE .10 RAKE AND .50 RAKE PER
   * BUY IN."
   *
   * The rule above reversed itself twice because both attempts assumed fees had
   * to be whole CHIPS. They do not — buy_in_fee is numeric(15,2). Flooring to
   * CENTS satisfies the ceiling exactly at every rung, so the micro ladder pays
   * its fee AND the house never exceeds a tenth. Both halves of the trade the
   * old comment called impossible.
   */
  it('every buy-in pays its fee, to the cent, with no rung left rake-free', () => {
    expect(splitBuyIn(1)).toEqual({ total: 1, prize: 0.9, fee: 0.1 });
    expect(splitBuyIn(5)).toEqual({ total: 5, prize: 4.5, fee: 0.5 });
    expect(splitBuyIn(2).fee).toBe(0.2);
    expect(splitBuyIn(3).fee).toBe(0.3);
    expect(splitBuyIn(10).fee).toBe(1);
    expect(splitBuyIn(25).fee).toBe(2.5);
    for (let total = 1; total <= 200; total++) {
      expect(splitBuyIn(total).fee, `total ${total}`).toBeGreaterThan(0);
    }
  });

  it('a heads-up seat pays 5%, so a 1-chip duel pays 1.90 to the winner', () => {
    // Dan 2026-08-25: "1 CHIP BUY IN X 2 PLAYERS = 5% OF 2 CHIPS, SO WINNER
    // TAKES ALL = 1.90 PAYOUT."
    const seat = splitBuyIn(1, 0.05);
    expect(seat).toEqual({ total: 1, prize: 0.95, fee: 0.05 });
    expect(Number((seat.prize * 2).toFixed(2))).toBe(1.9);
  });

  it('still FLOORS, so a fee can never round up through the ceiling', () => {
    // 0.1 of 1 is exactly 0.10; nothing here may produce 0.11.
    for (let total = 1; total <= 2000; total++) {
      const s = splitBuyIn(total);
      expect(s.fee, `total ${total}`).toBeLessThanOrEqual(total * 0.1 + 1e-9);
    }
  });

  it('clampRakeToCap fixes a bad pair without changing what the player pays', () => {
    // The Evening Mystery Bounty as it shipped: 13 + 2 = 13.33%. It clamps to
    // the exact ceiling now (1.50) rather than down to the next whole chip.
    expect(clampRakeToCap(13, 2)).toEqual({ prize: 13.5, fee: 1.5 });
    // A pair already within cap is left exactly as it is.
    expect(clampRakeToCap(18, 2)).toEqual({ prize: 18, fee: 2 });
    expect(isRakeWithinCap(13, 2)).toBe(false);
    expect(isRakeWithinCap(14, 1)).toBe(true);
    // ...and a fractional fee it is handed survives instead of rounding to 0.
    expect(clampRakeToCap(0.9, 0.1)).toEqual({ prize: 0.9, fee: 0.1 });
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
