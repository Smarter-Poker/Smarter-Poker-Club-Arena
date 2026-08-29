/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PAYOUTS ARE EXACT TO THE CENT — LAW (Dan, 2026-08-29, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "THIS NEEDS TO BE EXACT AND 100% ACCURATE AT ALL TIMES, THERE
 * CAN NEVER BE 'ROUNDING' IT MUST ALWAYS BE DOWN TO THE CENT. THERE CAN NEVER
 * EVER EVER BE MISTAKES WHEN PAYING OUT, AND THIS SHOULD NOT BE DIFFICULT,
 * ITS PRETTY CUT AND DRY ON THE PAYOUTS."
 *
 * He is right that it is cut and dry, and the reason it kept going wrong is
 * that the arithmetic was done in DOLLARS. A dollar amount with two decimals
 * is not a number a binary float can hold:
 *
 *     513 * 3.5 / 100          -> 17.955                  (looks exact)
 *     17.955 * 100             -> 1795.4999999999998
 *     Math.round(...) / 100    -> 17.95                   (rounded DOWN)
 *
 * Postgres numeric is exact decimal and made the same place 17.96, so
 * fn_tournament_payout_reconcile declared it underpaid and topped it up --
 * and since the last place already absorbs the residual, that pushed a 513.00
 * pool to 513.01 on every single run of Union Morning Classic, twice a day.
 * The checker created the overpayment it was reporting.
 *
 * THE LAW, and there are only two clauses:
 *
 *   1. The paid places sum to the prize pool EXACTLY. Not within a cent.
 *   2. Every place is the amount exact decimal arithmetic gives, so the
 *      engine and the database can never disagree about a cent.
 *
 * The reference implementation below is deliberately written a second time,
 * in BigInt, so it shares no ARITHMETIC with the code under test -- only the
 * rule. If both agree across every structure in production and thousands of
 * pools, the agreement is not a coincidence of a shared floating-point bug.
 *
 * If a change here turns red, the payout arithmetic has drifted. Do not
 * loosen a tolerance -- there is no tolerance to loosen. Exact is the point.
 */
import { describe, it, expect } from 'vitest';

import { computePlacePrize } from './payoutMath.js';

/**
 * Every payout structure in production, by percentage, taken from the
 * tournaments table on 2026-08-29 with its event count.
 */
const PRODUCTION_STRUCTURES: Array<{ name: string; pcts: number[] }> = [
  { name: 'winner takes all (37,328 events)', pcts: [100] },
  { name: '5-place (964 events)', pcts: [40, 25, 18, 10, 7] },
  { name: 'heads-up 65/35 (539 events)', pcts: [65, 35] },
  { name: '9-place (341 events)', pcts: [30, 20, 15, 10, 8, 6, 5, 3.5, 2.5] },
  { name: 'spin 80/20 (269 events)', pcts: [80, 20] },
  { name: '3-place (181 events)', pcts: [50, 30, 20] },
  { name: 'spin 80/12/8 (18 events)', pcts: [80, 12, 8] },
];

const toEntries = (pcts: number[]) => pcts.map((percentage, i) => ({ place: i + 1, percentage }));

/**
 * The rule, in integer arithmetic that cannot lose a cent, written
 * independently of the implementation under test.
 *
 * Every place except the last is its share of the pool rounded half-up; the
 * last paid place takes what remains. Half-up rather than half-even because
 * that is what Postgres `round(numeric, 2)` does, and the database is the
 * other half of this agreement.
 */
function referenceCents(poolCents: bigint, pcts: number[]): bigint[] {
  const bps = pcts.map((p) => BigInt(Math.round(p * 100)));
  const totalBp = bps.reduce((a, b) => a + b, 0n);
  if (totalBp === 0n) return pcts.map(() => 0n);

  const out: bigint[] = [];
  let remaining = poolCents;
  for (let i = 0; i < bps.length; i++) {
    if (i === bps.length - 1) {
      // The last paid place takes what is left.
      out.push(remaining > 0n ? remaining : 0n);
      remaining = 0n;
      continue;
    }
    // Its share of the pool, rounded half up, in integers -- and never more
    // than is actually left, so the pool can never be overspent.
    const share = (poolCents * bps[i] * 2n + totalBp) / (totalBp * 2n);
    const take = share > remaining ? remaining : share;
    out.push(take > 0n ? take : 0n);
    remaining -= take > 0n ? take : 0n;
  }
  return out;
}

/** Pools to test: every cent up to $20, then a wide sweep, plus real ones. */
function poolsUnderTest(): number[] {
  const cents = new Set<number>();
  for (let c = 1; c <= 2000; c++) cents.add(c); // $0.01 .. $20.00, every cent
  for (let c = 2000; c <= 250000; c += 37) cents.add(c); // sparse to $2,500
  // Pools that have actually paid out and are known to be awkward.
  for (const d of [
    50, 80, 150, 180, 200, 273.6, 275.4, 306, 316.8, 483, 500, 513, 600, 800, 2500,
  ]) {
    cents.add(Math.round(d * 100));
  }
  return [...cents].map((c) => c / 100);
}

const POOLS = poolsUnderTest();

describe('the paid places sum to the prize pool, exactly', () => {
  for (const { name, pcts } of PRODUCTION_STRUCTURES) {
    it(`${name}`, () => {
      const entries = toEntries(pcts);
      const offenders: string[] = [];

      for (const pool of POOLS) {
        let sumCents = 0;
        for (let place = 1; place <= pcts.length; place++) {
          sumCents += Math.round(computePlacePrize(pool, entries, place) * 100);
        }
        if (sumCents !== Math.round(pool * 100)) {
          offenders.push(`pool ${pool.toFixed(2)} paid ${(sumCents / 100).toFixed(2)}`);
          if (offenders.length > 5) break;
        }
      }

      expect(offenders, `places do not sum to the pool: ${offenders.join('; ')}`).toEqual([]);
    });
  }
});

describe('every place matches exact decimal arithmetic', () => {
  for (const { name, pcts } of PRODUCTION_STRUCTURES) {
    it(`${name}`, () => {
      const entries = toEntries(pcts);
      const offenders: string[] = [];

      for (const pool of POOLS) {
        const ref = referenceCents(BigInt(Math.round(pool * 100)), pcts);
        for (let i = 0; i < pcts.length; i++) {
          const got = Math.round(computePlacePrize(pool, entries, i + 1) * 100);
          if (BigInt(got) !== ref[i]) {
            offenders.push(
              `pool ${pool.toFixed(2)} place ${i + 1}: got ${got} cents, exact is ${ref[i]}`
            );
            if (offenders.length > 5) break;
          }
        }
        if (offenders.length > 5) break;
      }

      expect(offenders, offenders.join('; ')).toEqual([]);
    });
  }
});

describe('the cases that actually went wrong in production', () => {
  const NINE = toEntries([30, 20, 15, 10, 8, 6, 5, 3.5, 2.5]);

  it('Union Morning Classic: 513.00 pays 513.00, and place 8 is 17.96', () => {
    // This is the exact event that overpaid by a cent twice a day. Place 8 is
    // 17.955 to the fraction; exact decimal rounds it UP, and the float
    // arithmetic that used to run here rounded it DOWN.
    expect(computePlacePrize(513, NINE, 8)).toBe(17.96);
    const total = [1, 2, 3, 4, 5, 6, 7, 8, 9].reduce(
      (s, p) => s + Math.round(computePlacePrize(513, NINE, p) * 100),
      0
    );
    expect(total).toBe(51300);
  });

  it('483.00, the pool named in the 2026-08-20 fix, still pays 483.00', () => {
    const total = [1, 2, 3, 4, 5, 6, 7, 8, 9].reduce(
      (s, p) => s + Math.round(computePlacePrize(483, NINE, p) * 100),
      0
    );
    expect(total).toBe(48300);
  });

  it('a structure that does not sum to 100 is still paid out in full', () => {
    // Normalised proportionally rather than over-paying the top places.
    const odd = toEntries([50, 30, 15]); // 95%
    const total = [1, 2, 3].reduce(
      (s, p) => s + Math.round(computePlacePrize(200, odd, p) * 100),
      0
    );
    expect(total).toBe(20000);
  });

  it('a pool too small to fill every place still pays out exactly the pool', () => {
    // 10 cents cannot be split nine ways by these percentages. The earlier
    // places spend the pool down and the rest are paid nothing -- which is
    // the only honest answer, and crucially the total is still exactly 10
    // cents. Pricing one place in isolation used to clamp the LAST place at
    // zero and quietly pay out MORE than the pool.
    const paid = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) =>
      Math.round(computePlacePrize(0.1, NINE, p) * 100)
    );
    expect(paid.reduce((a, b) => a + b, 0)).toBe(10);
    expect(paid.every((c) => c >= 0)).toBe(true);
  });

  it('never pays a negative place, even on a structure summing past 100', () => {
    const broken = toEntries([90, 80, 70]);
    for (const place of [1, 2, 3]) {
      expect(computePlacePrize(100, broken, place)).toBeGreaterThanOrEqual(0);
    }
  });
});
