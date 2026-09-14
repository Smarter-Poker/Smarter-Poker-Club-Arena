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
import { CHIP_UNIT_CENTS } from './tournamentUnit.js';

describe('mysteryPoolCents - the cap the database applies', () => {
  it('with nothing paid it is the plain half (the old behaviour)', () => {
    expect(mysteryPoolCents(10_000, 50, 50, 0, CHIP_UNIT_CENTS)).toBe(5_000);
    expect(mysteryPoolCents(10_000, 50, 50, 0, CHIP_UNIT_CENTS)).toBe(5_000);
  });

  it('a paid regular bounty does NOT shrink a half that still fits', () => {
    // 10,000 total, mystery half 5,000, regular has paid 1,000: the mystery
    // half is still fully backed (10,000 - 1,000 = 9,000 >= 5,000).
    expect(mysteryPoolCents(10_000, 50, 50, 1_000, CHIP_UNIT_CENTS)).toBe(5_000);
  });

  it('once payouts eat into it, the half shrinks to what is LEFT', () => {
    // 10,000 total, 6,000 already paid: only 4,000 remains to back chests.
    expect(mysteryPoolCents(10_000, 50, 50, 6_000, CHIP_UNIT_CENTS)).toBe(4_000);
  });

  it('an exhausted pool seeds nothing rather than a negative inventory', () => {
    expect(mysteryPoolCents(10_000, 50, 50, 12_000, CHIP_UNIT_CENTS)).toBe(0);
  });

  it('matches the SQL for a lopsided split', () => {
    // 70/30 split of 9,999: floor(9999*70/100) = 6,999.
    expect(mysteryPoolCents(9_999, 70, 30, 0, CHIP_UNIT_CENTS)).toBe(6_999);
    // ...capped once 4,000 has been paid: 9,999 - 4,000 = 5,999.
    expect(mysteryPoolCents(9_999, 70, 30, 4_000, CHIP_UNIT_CENTS)).toBe(5_999);
  });

  it('percentages that do not sum to 100 still normalise, then cap', () => {
    // 60/60 is a 50/50 split of 10,000 = 5,000; 8,000 paid leaves 2,000.
    expect(mysteryPoolCents(10_000, 60, 60, 0, CHIP_UNIT_CENTS)).toBe(5_000);
    expect(mysteryPoolCents(10_000, 60, 60, 8_000, CHIP_UNIT_CENTS)).toBe(2_000);
  });

  it('rejects a pool that is not whole cents, paid amount or not', () => {
    expect(mysteryPoolCents(1.5, 50, 50, 100, CHIP_UNIT_CENTS)).toBe(0);
    expect(mysteryPoolCents(0, 50, 50, 0, CHIP_UNIT_CENTS)).toBe(0);
  });

  it('a fractional paid amount is rounded, never left to drift', () => {
    // 10,000 total, 6,000.4 paid -> 6,000; 3,999.6 -> 4,000.
    expect(mysteryPoolCents(10_000, 50, 50, 6_000.4, CHIP_UNIT_CENTS)).toBe(4_000);
    expect(mysteryPoolCents(10_000, 50, 50, 6_000.6, CHIP_UNIT_CENTS)).toBe(3_999);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MYSTERY HALF OF A DIAMOND POOL IS A WHOLE NUMBER OF DIAMONDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The regular half keeps the odd cent because it is spent knockout by
 * knockout against a pool checked for exhaustion on every payment, whereas the
 * mystery half is committed to a fixed inventory up front and an extra cent
 * there leaves the event unable to reconcile.
 *
 * At a Diamond unit the same reasoning gives the regular half the odd DIAMOND,
 * and for a harder reason: a fraction of a Diamond is not an amount any door
 * in this estate accepts. The chest inventory is built from this number, so a
 * half Diamond here is an event that cannot be seeded at all.
 *
 * The chip answers below are the ones this function has always given. They are
 * asserted alongside rather than separately, because "the Diamond answer is
 * whole" is only worth anything if the chip answer did not move to get there.
 */
describe('the mystery half of a Diamond pool', () => {
  const DIAMOND = 100;

  it('leaves the chip answer exactly where it was', () => {
    expect(mysteryPoolCents(501, 50, 50, 0, CHIP_UNIT_CENTS)).toBe(250);
    expect(mysteryPoolCents(501, 50, 50, 0, 1)).toBe(250);
    expect(mysteryPoolCents(1000, 60, 40, 0, CHIP_UNIT_CENTS)).toBe(600);
    expect(mysteryPoolCents(1000, 60, 40, 0, 1)).toBe(600);
  });

  it('pays the mystery half in whole Diamonds', () => {
    // 5 Diamonds, split down the middle: 2 to the mystery half, 3 to the
    // regular one, because the regular half keeps the odd unit.
    expect(mysteryPoolCents(500, 50, 50, 0, DIAMOND)).toBe(200);
    // 10 Diamonds at 60/40 is 6 exactly.
    expect(mysteryPoolCents(1000, 60, 40, 0, DIAMOND)).toBe(600);
    // A pool of one Diamond cannot be halved, so the mystery half is nothing
    // and the regular half keeps all of it. Nothing is stranded.
    expect(mysteryPoolCents(100, 50, 50, 0, DIAMOND)).toBe(0);
  });

  it('floors the already-paid cap to the unit too', () => {
    // 10 Diamonds with 150 cents already paid leaves 850, which is not a whole
    // number of Diamonds. The cap must land on the grid, not beside it.
    const capped = mysteryPoolCents(1000, 100, 0, 150, DIAMOND);
    expect(capped % DIAMOND).toBe(0);
    expect(capped).toBeLessThanOrEqual(850);
  });

  it('never returns a fraction of a Diamond, for any split', () => {
    for (let pool = 100; pool <= 5000; pool += 100) {
      for (const m of [0, 10, 25, 33, 50, 60, 75, 100]) {
        const half = mysteryPoolCents(pool, m, 100 - m, 0, DIAMOND);
        expect(half % DIAMOND, `pool ${pool} mystery ${m}%`).toBe(0);
        expect(half).toBeLessThanOrEqual(pool);
        expect(half).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
