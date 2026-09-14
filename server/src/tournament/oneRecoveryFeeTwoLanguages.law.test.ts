/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - ONE RECOVERY FEE, IN TWO LANGUAGES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fee on a rebuy or a re-entry is not configured anywhere. It is DERIVED,
 * from the ratio the buy-in and its fee happen to stand in, and then truncated
 * down. Until migration 20260912103907 that derivation was written four times
 * in SQL and once here, and nothing held any of them to each other.
 *
 * The SQL three are one function now, fn_ca_recovery_fee_cents. That leaves
 * two implementations in total, which is the fewest possible: the quote is
 * computed in TypeScript before the player is charged and the charge is
 * computed in SQL, and neither can call the other.
 *
 * HOW THE VECTORS WERE MADE. Every expected value was produced BY
 * fn_ca_recovery_fee_cents, over the 54 distinct buy-in and fee pairs and the
 * 16 distinct charge amounts this database actually holds, in both
 * denominations. The SQL is the source of truth for the file and this module
 * is the thing under test, so the law fails when the TYPESCRIPT drifts.
 *
 * EACH SIDE DERIVES THE RATIO ITSELF, from the same two configured numbers,
 * rather than being handed a ratio the file already rounded. That is the point
 * of the shape: SQL divides in exact decimal and JavaScript divides in binary
 * floating point, and a fee that truncates at a boundary is exactly where the
 * two could disagree. Handing both sides a pre-rounded ratio would hide the
 * one failure this law exists to catch.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recoveryFeeCents, tournamentFeeRatio, unitFloorCents } from './recoveryFee.js';

type Vectors = {
  note: string;
  /** [buyIn, buyInFee, grossCents, unitCents, expectedFeeCents] */
  cases: [number, number, number, number, number][];
};

const vectors = JSON.parse(
  readFileSync(new URL('./oneRecoveryFeeTwoLanguages.vectors.json', import.meta.url), 'utf8')
) as Vectors;

describe('LAW: the SQL recovery fee and this module are one rule', () => {
  it('ships the whole reachable input space, in both denominations', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(1500);
    expect(vectors.cases.some(([, , , unit]) => unit === 1)).toBe(true);
    expect(vectors.cases.some(([, , , unit]) => unit === 100)).toBe(true);
    // A tournament with no fee at all falls back to ten percent, and a
    // tournament whose whole charge is fee produces a ratio of 1 that the cap
    // must bring back down. Both shapes are real and both must be present.
    expect(vectors.cases.some(([, fee]) => fee === 0)).toBe(true);
    expect(vectors.cases.some(([buyIn, fee]) => buyIn === 0 && fee > 0)).toBe(true);
  });

  it('agrees with the database on every vector', () => {
    for (const [buyIn, fee, grossCents, unit, expected] of vectors.cases) {
      const actual = recoveryFeeCents(grossCents, tournamentFeeRatio(buyIn, fee), unit);
      expect(actual, `buyIn ${buyIn} fee ${fee} gross ${grossCents}c unit ${unit}`).toBe(expected);
    }
  });

  it('never charges above the cap, and never more than the charge', () => {
    for (const [buyIn, fee, grossCents, unit] of vectors.cases) {
      const actual = recoveryFeeCents(grossCents, tournamentFeeRatio(buyIn, fee), unit);
      expect(actual, 'above the ten percent cap').toBeLessThanOrEqual(
        unitFloorCents(Math.trunc(grossCents * 0.1 + 0.000001), unit)
      );
      expect(actual, 'more than the charge').toBeLessThanOrEqual(grossCents);
      expect(actual, 'negative').toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves a whole number of Diamonds for the pool', () => {
    let checked = 0;
    for (const [buyIn, fee, grossCents, unit] of vectors.cases) {
      if (unit !== 100 || grossCents % 100 !== 0) continue;
      const actual = recoveryFeeCents(grossCents, tournamentFeeRatio(buyIn, fee), unit);
      expect(actual % 100, `fee is not a whole Diamond`).toBe(0);
      expect((grossCents - actual) % 100, `what reaches the pool is not whole`).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('is the identity on the chip path, which is what keeps the estate still', () => {
    for (const [buyIn, fee, grossCents] of vectors.cases) {
      const ratio = tournamentFeeRatio(buyIn, fee);
      // The pre-change rule, written out, with a cent as the only unit.
      const before = Math.min(
        Math.trunc(grossCents * ratio + 0.000001),
        Math.trunc(grossCents * 0.1 + 0.000001)
      );
      expect(recoveryFeeCents(grossCents, ratio, 1), `chip fee moved`).toBe(Math.max(0, before));
    }
  });
});
