import { describe, expect, it } from 'vitest';
import { captureHorseTournamentPayoutTerms } from './HorseTournamentPayoutTerms.js';
import * as payoutMath from '../tournament/payoutMath.js';

const row = {
  id: 'event',
  prize_pool: 10001,
  prize_pool_finalized: true,
  bubble_protection: false,
  payout_club: { asset: 'chips', is_platform: false, union_id: null },
  buy_in_amount: 10,
  is_bounty: false,
  is_pko: false,
  is_mystery_bounty: false,
};

/** Independent integer rounding oracle for already-normalized basis points.
 * It preserves the two separate rounding stages (cent, then asset unit),
 * shortest Diamond field rule and original last-place residual. */
function reference(pool: number, bps: number[], unit: number): number[] {
  const cents = BigInt(Math.round(pool * 100)),
    grid = BigInt(unit);
  if (unit > 1 && cents / grid < BigInt(bps.length))
    return bps.map((_, i) => (BigInt(i) < cents / grid ? unit / 100 : 0));
  const total = BigInt(bps.reduce((a, b) => a + b, 0));
  let remaining = cents;
  return bps.map((bp, i) => {
    if (i === bps.length - 1) {
      const last = remaining;
      remaining = 0n;
      return Number(last) / 100;
    }
    const centShare = (2n * cents * BigInt(bp) + total) / (2n * total);
    const unitShare = ((2n * centShare + grid) / (2n * grid)) * grid;
    const take = unitShare < remaining ? unitShare : remaining;
    remaining -= take;
    return Number(take) / 100;
  });
}

describe('bulk prize ladder preserves the original financial rule', () => {
  it('captures all places with bounded source reads rather than rebuilding N ladders', () => {
    const count = 1000;
    let reads = 0;
    const places = Array.from({ length: count }, (_, i) => ({
      get place() {
        reads++;
        return i + 1;
      },
      get percentage() {
        reads++;
        return 100 / count;
      },
    }));
    const captured = captureHorseTournamentPayoutTerms(row, places, count, false);
    expect(captured.finalizedPrizeLadder?.prizesCents).toHaveLength(count);
    // Sorting, capture checks and one ladder pass may inspect each source a
    // few times; N whole-ladder rebuilds exceed this linear bound by orders.
    expect(reads).toBeLessThan(count * 20);
  });

  it.each([1, 100])('matches independent integer awards for unit %s', (unit) => {
    for (const pool of [0.01, 0.04, 1, 100.01, 513, 10001]) {
      for (const percentages of [
        [100],
        [50, 50],
        [25, 25, 25, 25],
        [49.99, 50.01],
        [50, 30, 20],
        [100, 0, 0],
      ]) {
        const places = percentages.map((percentage, i) => ({ place: i + 1, percentage }));
        const expected = reference(
          pool,
          percentages.map((p) => Math.round(p * 100)),
          unit
        );
        const ladder = payoutMath.computePrizeLadder(pool, places, unit);
        expect([...ladder.values()]).toEqual(expected);
        places.forEach(({ place }, i) =>
          expect(payoutMath.computePlacePrize(pool, places, place, unit)).toBe(expected[i])
        );
      }
    }
  });
  it('keeps duplicate-first, malformed-place and negative-percentage normalization', () => {
    const malformed = [
      { place: 2, percentage: 30 },
      { place: 1, percentage: 50 },
      { place: 2, percentage: 99 },
      { place: 3, percentage: 20 },
      { place: 4, percentage: -10 },
      { place: NaN, percentage: 99 },
      { place: 0, percentage: 99 },
      { place: 1.5, percentage: 99 },
    ];
    const awards = payoutMath.computePrizeLadder(100.01, malformed, 1);
    expect([...awards.entries()]).toEqual([
      [1, 50.01],
      [2, 30],
      [3, 20],
      [4, 0],
    ]);
    for (const place of [NaN, Infinity, -1, 0, 1.5, 999])
      expect(payoutMath.computePlacePrize(100.01, malformed, place, 1)).toBe(0);
  });
  it('keeps empty, invalid-pool and normalized-unit behavior', () => {
    for (const pool of [0, -1, NaN, Infinity])
      expect(payoutMath.computePrizeLadder(pool, [{ place: 1, percentage: 100 }], 1).size).toBe(0);
    expect(payoutMath.computePrizeLadder(100, [], 1).size).toBe(0);
    expect(payoutMath.computePrizeLadder(100, [{ place: 1, percentage: 0 }], 1).size).toBe(0);
    expect(payoutMath.computePrizeLadder(100, [{ place: 1, percentage: 100 }], NaN).get(1)).toBe(
      100
    );
  });
});
