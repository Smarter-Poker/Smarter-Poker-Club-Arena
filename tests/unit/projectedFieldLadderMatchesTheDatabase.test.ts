/**
 * The Rewards tab projects a registering MTT's ladder with the same arithmetic
 * the database uses at entry close (fn_ca_payout_structure). These figures were
 * read from production on 2026-10-22: fn_ca_payout_structure(100, 12.5), and
 * real entry closes of 150 and 197 entrants paying 19 and 25 places.
 */
import { describe, expect, it } from 'vitest';
import { effectivePayoutDepth, projectedFieldLadder } from '../../src/lib/payoutStructure';

describe('the projected field ladder matches the database generator', () => {
  it('pays the top 12.5% of 100 entrants exactly as production does', () => {
    expect(projectedFieldLadder(100, 12.5).map((p) => p.percentage)).toEqual([
      25.14, 14.44, 10.44, 8.29, 6.94, 6, 5.3, 4.76, 4.34, 3.99, 3.69, 3.44, 3.23,
    ]);
  });

  it('rounds paid places up and sums to exactly 100', () => {
    for (const [field, places] of [
      [8, 1],
      [9, 2],
      [17, 3],
      [150, 19],
      [197, 25],
    ] as const) {
      const ladder = projectedFieldLadder(field, 12.5);
      expect(ladder).toHaveLength(places);
      expect(Math.round(ladder.reduce((s, p) => s + p.percentage, 0) * 100)).toBe(10000);
    }
  });

  it('pays 50/30/20 for a small mystery bounty, as entry close does', () => {
    expect(projectedFieldLadder(6, 12.5, true).map((p) => p.percentage)).toEqual([50, 30, 20]);
  });

  it('reads the depth column first and defaults to 12.5', () => {
    expect(effectivePayoutDepth({ payout_depth_percent: '12.50', payout_percent: 10 })).toBe(12.5);
    expect(effectivePayoutDepth({ payout_depth_percent: 15 })).toBe(15);
    expect(effectivePayoutDepth({})).toBe(12.5);
    expect(projectedFieldLadder(0, 12.5)).toEqual([]);
  });
});
