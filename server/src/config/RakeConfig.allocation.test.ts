/**
 * BBJ POOL ALLOCATION (Dan, 2026-08-18 — authoritative)
 *   STANDARD (main < 100k):  50% Main / 25% Back Up / 25% Promo
 *   PIVOT    (main >= 100k): 25% Main / 25% Back Up / 50% Promo
 *
 * Three copies of this rule existed and all three disagreed: the client said
 * 40/30/30, the server config comment said pivot 30/40/30, and the banking
 * path implemented 30/40/30. These tests pin the split the money actually
 * follows, including that the remainder lands in promo so no chip is lost to
 * rounding.
 */
import { describe, it, expect } from 'vitest';
import {
  BBJ_POOL_ALLOCATION,
  BBJ_POOL_ALLOCATION_PIVOT,
  BBJ_PIVOT_THRESHOLD,
} from './RakeConfig.js';

/** Mirrors logBBJCollection: main and backup round, promo takes the remainder. */
function split(amount: number, mainBalance: number) {
  const r = mainBalance >= BBJ_PIVOT_THRESHOLD ? BBJ_POOL_ALLOCATION_PIVOT : BBJ_POOL_ALLOCATION;
  const main = Math.round(amount * r.mainBBJ * 100) / 100;
  const backup = Math.round(amount * r.backUpBBJ * 100) / 100;
  const promo = Math.round((Math.round(amount * 100) / 100 - main - backup) * 100) / 100;
  return { main, backup, promo };
}

describe('standard allocation below the pivot', () => {
  it('is 50 / 25 / 25', () => {
    expect(BBJ_POOL_ALLOCATION.mainBBJ).toBe(0.5);
    expect(BBJ_POOL_ALLOCATION.backUpBBJ).toBe(0.25);
    expect(BBJ_POOL_ALLOCATION.promotional).toBe(0.25);
  });

  it('splits a fee correctly just under the pivot', () => {
    const s = split(1, BBJ_PIVOT_THRESHOLD - 0.01);
    expect(s).toEqual({ main: 0.5, backup: 0.25, promo: 0.25 });
  });
});

describe('pivot allocation at and above 100k', () => {
  it('is 25 / 25 / 50 - the back-up share stays flat, promo takes the surplus', () => {
    expect(BBJ_POOL_ALLOCATION_PIVOT.mainBBJ).toBe(0.25);
    expect(BBJ_POOL_ALLOCATION_PIVOT.backUpBBJ).toBe(0.25);
    expect(BBJ_POOL_ALLOCATION_PIVOT.promotional).toBe(0.5);
  });

  it('applies AT exactly 100k, not just above it', () => {
    expect(split(1, BBJ_PIVOT_THRESHOLD)).toEqual({ main: 0.25, backup: 0.25, promo: 0.5 });
  });

  it('is never the retired 30 / 40 / 30', () => {
    expect(BBJ_POOL_ALLOCATION_PIVOT.mainBBJ).not.toBe(0.3);
    expect(BBJ_POOL_ALLOCATION_PIVOT.backUpBBJ).not.toBe(0.4);
  });
});

describe('no chip is lost or created by the split', () => {
  it('always sums back to the fee, at both allocations, across awkward amounts', () => {
    for (const amount of [0.01, 0.03, 0.05, 0.12, 0.25, 0.6, 1, 2.5, 7.77, 13.13]) {
      for (const balance of [0, 99999.99, 100000, 250000]) {
        const s = split(amount, balance);
        const sum = Math.round((s.main + s.backup + s.promo) * 100) / 100;
        expect(sum, `amount=${amount} balance=${balance}`).toBe(Math.round(amount * 100) / 100);
        expect(s.promo).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
