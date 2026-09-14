/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - ONE PRIZE LADDER, IN TWO LANGUAGES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rule for turning a prize pool into per-place amounts was written FOUR
 * times: three in SQL and one in TypeScript. Two languages, four spellings,
 * one rule. Migration 20260912090000 collapsed the three SQL copies into
 * `fn_ca_prize_ladder`. That leaves TWO implementations, which is the fewest
 * possible - the engine prices places in TypeScript and the database prices
 * them in SQL, and neither can call the other.
 *
 * Two is not one, so something has to hold them together. For the TypeScript
 * pair that is tests/payout-one-rule-everywhere.law.test.ts, which compares
 * the client and server copies byte for byte. This is the equivalent bond
 * across the language boundary, and it cannot be a byte comparison because
 * the two are not the same text. It is a behavioural pin instead.
 *
 * HOW THE VECTORS WERE MADE, and why that direction. Every expected value in
 * oneLadderTwoLanguages.vectors.json was produced BY `fn_ca_prize_ladder`,
 * executing in Postgres, over the payout structures this platform actually
 * ships crossed with the pools that land on the interesting rounding
 * boundaries - including 513.00 and 483.00, the two pools named in
 * payoutMath.ts as having produced real one-cent errors in production. The
 * SQL is the source of truth for the file and `computePlacePrize` is the
 * thing under test, so this fails when the TYPESCRIPT drifts.
 *
 * When the SQL ladder changes on purpose, the vectors are regenerated in the
 * same commit and the diff shows exactly which answers moved. A regenerated
 * file with no diff means nothing moved. That is the point.
 *
 * Both denominations are pinned: unitCents 1 is every chip tournament that
 * has ever run, unitCents 100 is a Diamond, which does not divide.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computePlacePrize } from './payoutMath.js';

type Payout = { place: number; percentage: number };
type Vectors = {
  structures: Payout[][];
  /** [structureIndex, poolCents, unitCents, centsByPlace[], places[]] */
  cases: [number, number, number, number[], number[]][];
};

const vectors = JSON.parse(
  readFileSync(new URL('./oneLadderTwoLanguages.vectors.json', import.meta.url), 'utf8')
) as Vectors;

describe('LAW: the SQL prize ladder and computePlacePrize are one rule', () => {
  it('ships a non-trivial body of vectors in both denominations', () => {
    expect(vectors.structures.length).toBeGreaterThanOrEqual(8);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(300);
    expect(vectors.cases.some(([, , unit]) => unit === 1)).toBe(true);
    expect(vectors.cases.some(([, , unit]) => unit === 100)).toBe(true);
    // A structure carrying a trailing zero-percentage place must be present:
    // it is the shape that decides WHERE THE RESIDUAL LANDS, and the SQL
    // normaliser keeps such a place precisely because this file does.
    expect(vectors.structures.some((s) => s.some((p) => Number(p.percentage) === 0))).toBe(true);
  });

  it('agrees with the database on every place of every vector', () => {
    let asserted = 0;
    for (const [idx, poolCents, unit, cents, places] of vectors.cases) {
      const payouts = vectors.structures[idx];
      expect(payouts, `structure ${idx} missing`).toBeTruthy();
      const pool = poolCents / 100;
      for (let i = 0; i < places.length; i++) {
        const actual = computePlacePrize(pool, payouts, places[i], unit);
        expect(actual, `structure ${idx} pool ${poolCents}c unit ${unit} place ${places[i]}`).toBe(
          cents[i] / 100
        );
        asserted++;
      }
    }
    expect(asserted).toBeGreaterThanOrEqual(1000);
  });

  it('agrees that a place outside the ladder is worth nothing', () => {
    for (const [idx, poolCents, unit, , places] of vectors.cases) {
      const payouts = vectors.structures[idx];
      const beyond = (places.length ? Math.max(...places) : 0) + 1;
      expect(computePlacePrize(poolCents / 100, payouts, beyond, unit)).toBe(0);
    }
  });

  /**
   * WHAT "EXACTLY" MEANS, stated as the ladder actually behaves rather than as
   * it would be pleasant to describe it.
   *
   * A chip ladder spends the pool to the cent, always. A Diamond ladder spends
   * it to the cent too, EXCEPT in the short field - a pool holding fewer whole
   * Diamonds than there are places to pay. There the pool's sub-Diamond
   * remainder is not paid to anybody, because there is nobody it can be paid
   * to: an indivisible unit cannot be split, and handing the fraction to one
   * player would pay somebody more than the player who beat them.
   *
   * That remainder is strictly smaller than one unit, and it is zero whenever
   * the pool is a whole number of Diamonds, which every Diamond pool in this
   * estate is by construction. The bound is asserted rather than the
   * convenient equality, because the bound is the part that is true for every
   * input.
   */
  it('never overpays, and strands at most a sub-unit remainder', () => {
    for (const [idx, poolCents, unit, cents, places] of vectors.cases) {
      const payouts = vectors.structures[idx];
      const paid = places.reduce(
        (sum, place) =>
          sum + Math.round(computePlacePrize(poolCents / 100, payouts, place, unit) * 100),
        0
      );
      const label = `structure ${idx} pool ${poolCents}c unit ${unit}`;

      if (cents.length === 0) {
        expect(paid, label).toBe(0);
        continue;
      }
      expect(paid, `${label} overpaid`).toBeLessThanOrEqual(poolCents);
      expect(poolCents - paid, `${label} stranded a whole unit or more`).toBeLessThan(unit);

      const shortField = unit > 1 && Math.floor(poolCents / unit) < places.length;
      if (!shortField) {
        expect(paid, `${label} did not spend the pool`).toBe(poolCents);
      }
      if (unit === 1 || poolCents % unit === 0) {
        expect(paid, `${label} left cents unpaid on a whole-unit pool`).toBe(
          shortField ? Math.floor(poolCents / unit) * unit : poolCents
        );
      }
    }
  });

  it('pays a Diamond tournament in whole Diamonds whenever the pool is whole Diamonds', () => {
    let checked = 0;
    for (const [idx, poolCents, unit, , places] of vectors.cases) {
      if (unit !== 100 || poolCents % 100 !== 0) continue;
      const payouts = vectors.structures[idx];
      for (const place of places) {
        const paidCents = Math.round(
          computePlacePrize(poolCents / 100, payouts, place, unit) * 100
        );
        expect(
          paidCents % 100,
          `structure ${idx} pool ${poolCents}c place ${place} is not a whole Diamond`
        ).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
