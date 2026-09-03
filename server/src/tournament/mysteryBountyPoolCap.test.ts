/**
 * THE MYSTERY BOUNTY THAT NEVER OPENED (2026-08-28)
 *
 * MEASURED IN PRODUCTION before this fix:
 *   - fn_mystery_bounty_seed refused 23 times in 24 hours, reason
 *     `inventory_mismatch`;
 *   - 104 chests worth $1,833 created across 27 COMPLETED mystery events,
 *     every one of them voided;
 *   - tournament_bounty_awards: ZERO ROWS. Not one mystery bounty has ever
 *     been awarded on this platform.
 *   - every knockout paid the flat pre-activation bounty instead
 *     ("BOUNTY (mystery_pre): ... collected 10 from ...").
 *
 * The seed function reduces the mystery half by whatever the regular half has
 * already paid (bounty_pool_paid). The engine built its chest inventory from
 * the UNREDUCED number, so one pre-activation knockout was enough to make the
 * two disagree forever: a refused seed meant more flat knockouts, which grew
 * bounty_pool_paid, which guaranteed the next seed also failed.
 */

import { describe, it, expect } from 'vitest';
import { mysteryPoolCents } from './mysteryBountyActivation.js';

describe('mysteryPoolCents - the cap the database applies', () => {
  it('with nothing paid it is the plain half (the old behaviour)', () => {
    expect(mysteryPoolCents(10_000, 50, 50)).toBe(5_000);
    expect(mysteryPoolCents(10_000, 50, 50, 0)).toBe(5_000);
  });

  it('a paid regular bounty does NOT shrink a half that still fits', () => {
    // 10,000 total, mystery half 5,000, regular has paid 1,000: the mystery
    // half is still fully backed (10,000 - 1,000 = 9,000 >= 5,000).
    expect(mysteryPoolCents(10_000, 50, 50, 1_000)).toBe(5_000);
  });

  it('once payouts eat into it, the half shrinks to what is LEFT', () => {
    // 10,000 total, 6,000 already paid: only 4,000 remains to back chests.
    expect(mysteryPoolCents(10_000, 50, 50, 6_000)).toBe(4_000);
  });

  it('an exhausted pool seeds nothing rather than a negative inventory', () => {
    expect(mysteryPoolCents(10_000, 50, 50, 12_000)).toBe(0);
  });

  it('matches the SQL for a lopsided split', () => {
    // 70/30 split of 9,999: floor(9999*70/100) = 6,999.
    expect(mysteryPoolCents(9_999, 70, 30)).toBe(6_999);
    // ...capped once 4,000 has been paid: 9,999 - 4,000 = 5,999.
    expect(mysteryPoolCents(9_999, 70, 30, 4_000)).toBe(5_999);
  });

  it('percentages that do not sum to 100 still normalise, then cap', () => {
    // 60/60 is a 50/50 split of 10,000 = 5,000; 8,000 paid leaves 2,000.
    expect(mysteryPoolCents(10_000, 60, 60)).toBe(5_000);
    expect(mysteryPoolCents(10_000, 60, 60, 8_000)).toBe(2_000);
  });

  it('rejects a pool that is not whole cents, paid amount or not', () => {
    expect(mysteryPoolCents(1.5, 50, 50, 100)).toBe(0);
    expect(mysteryPoolCents(0, 50, 50)).toBe(0);
  });

  it('a fractional paid amount is rounded, never left to drift', () => {
    // 10,000 total, 6,000.4 paid -> 6,000; 3,999.6 -> 4,000.
    expect(mysteryPoolCents(10_000, 50, 50, 6_000.4)).toBe(4_000);
    expect(mysteryPoolCents(10_000, 50, 50, 6_000.6)).toBe(3_999);
  });
});
