import { describe, expect, it } from 'vitest';
import { diamondBonusMinimum, validBonusMinimum } from '../../src/utils/diamondBonusPayout';
import {
  choose,
  minePrize,
  MINE_COUNTS,
  RANDOM_SPACE,
  ROAD_LADDERS,
  roadSurvives,
  verifyChoiceRound,
} from '../../src/utils/diamondChoiceMath';
import { crashPointCentsFromRoll, verifyCrashRound } from '../../src/utils/diamondGamesFairness';
import { parseChoiceRound } from '../../src/services/DiamondChoiceService';
import { validateCrashSettlement } from '../../src/utils/crashReceipt';
import receipts from '../fixtures/diamond-bonus-minimum-receipts.json';

describe('full-entry bonus minimum and calibrated sealed outcomes', () => {
  it('covers every entry, Double Down and Super budget without promising fractional chip cents', () => {
    for (let entry = 25; entry <= 2500; entry++) {
      for (const multiplier of [1, 2, 3]) {
        const cents = entry * multiplier;
        const floor = diamondBonusMinimum(cents / 100);
        expect(Math.round(floor * 100)).toBe(Math.ceil(cents / 10));
        expect(floor + 1e-10).toBeGreaterThanOrEqual(cents / 1000);
        // A Super award keeps HALF its doubled stake, which is the spin entry, so
        // the game returns at least 1:1 of what the spin cost. Half of a doubled
        // stake at multiplier 2 is exactly one entry, and never a part of a cent.
        const superFloor = diamondBonusMinimum(cents / 100, 2);
        expect(Math.round(superFloor * 100)).toBe(Math.ceil(cents / 2));
        if (multiplier === 2) expect(superFloor).toBe(entry / 100);
      }
    }
    expect(diamondBonusMinimum(50)).toBe(5);
    expect(diamondBonusMinimum(0.25)).toBe(0.03);
    // The three values the migration itself reads back after installing the rule.
    expect(diamondBonusMinimum(3, 2)).toBe(1.5);
    expect(diamondBonusMinimum(3)).toBe(0.3);
    expect(diamondBonusMinimum(0.25, 2)).toBe(0.13);
  });

  it('preserves the exact Mines expectation at every stop, including the guaranteed loss prize', () => {
    for (const bet of [0.25, 0.26, 0.99, 1, 1.01, 25, 50, 75]) {
      const cents = BigInt(Math.round(bet * 100));
      const floor = diamondBonusMinimum(bet);
      const floorCents = BigInt(Math.round(floor * 100));
      for (const mines of MINE_COUNTS) {
        for (let picks = 1; picks <= 25 - mines; picks++) {
          const all = choose(25, picks),
            safe = choose(25 - mines, picks);
          const prize = minePrize(bet, mines, picks, floor);
          const expectedNumerator =
            safe * prize.numerator + (all - safe) * floorCents * prize.denominator;
          expect(expectedNumerator * 5n).toBe(4n * cents * all * prize.denominator);
        }
      }
    }
  });

  it('pins both sides of every road and Crash target boundary without changing clicked multipliers', () => {
    const targets = [...Object.values(ROAD_LADDERS).flat(), 101, 257, 100000];
    for (const bet of [0.25, 0.26, 1, 25, 50, 75]) {
      const floor = diamondBonusMinimum(bet);
      const b = BigInt(Math.round(bet * 100)),
        l = BigInt(Math.round(floor * 100));
      for (const target of targets) {
        const denominator = 5n * (b * BigInt(target) - 100n * l);
        const numerator = 100n * (4n * b - 5n * l) * RANDOM_SPACE;
        const survivors = numerator / denominator;
        expect(roadSurvives(survivors - 1n, target, bet, floor)).toBe(true);
        expect(roadSurvives(survivors, target, bet, floor)).toBe(false);
        expect(crashPointCentsFromRoll(survivors - 1n, bet, floor)).toBeGreaterThanOrEqual(target);
        expect(crashPointCentsFromRoll(survivors, bet, floor)).toBeLessThan(target);
        expect(numerator - survivors * denominator).toBeLessThan(denominator);
      }
    }
  });

  it('accepts old receipts and refuses missing, reduced or inflated minimum snapshots', () => {
    expect(validBonusMinimum({ bet_chips: 50 })).toBe(true);
    expect(validBonusMinimum({ bet_chips: 50, payout_version: 1, minimum_payout_chips: 0 })).toBe(
      true
    );
    expect(validBonusMinimum({ bet_chips: 50, payout_version: 2, minimum_payout_chips: 5 })).toBe(
      true
    );
    // Version 3 is a round sealed with the Super floor: half the stake, not a tenth.
    expect(validBonusMinimum({ bet_chips: 50, payout_version: 3, minimum_payout_chips: 25 })).toBe(
      true
    );
    for (const minimum of [undefined, 0, 4.99, 5.01]) {
      expect(
        validBonusMinimum({ bet_chips: 50, payout_version: 2, minimum_payout_chips: minimum })
      ).toBe(false);
      expect(
        validBonusMinimum({ bet_chips: 50, payout_version: 3, minimum_payout_chips: minimum })
      ).toBe(false);
    }
    for (const version of [2, 3]) {
      expect(
        validBonusMinimum({ bet_chips: 50, payout_version: version, minimum_payout_chips: 24.99 })
      ).toBe(false);
    }
  });

  it('verifies actual authenticated PostgreSQL loss receipts for all games, Double Down and Super', async () => {
    for (const sample of receipts) {
      const value = sample.value as unknown as Record<string, unknown>;
      if (sample.game === 'crash') {
        expect(() => validateCrashSettlement(value, String(value.round_id))).not.toThrow();
        const proof = value.fairness as Record<string, unknown>;
        const verdict = await verifyCrashRound({
          serverSeed: String(proof.server_seed),
          serverSeedHash: String(proof.server_seed_hash),
          clientSeed: String(proof.client_seed),
          nonce: Number(proof.nonce),
          roll: Number(proof.roll),
          crashCents: Number(proof.crash_cents),
          betChips: Number(value.bet_chips),
          minimumPayoutChips: Number(value.minimum_payout_chips),
        });
        expect(verdict.fair).toBe(true);
        expect(() =>
          validateCrashSettlement(
            { ...value, outcome: { ...(value.outcome as object), payout_chips: 0 } },
            String(value.round_id)
          )
        ).toThrow();
      } else {
        const round = parseChoiceRound(value);
        expect(await verifyChoiceRound(round)).toBe(true);
        expect(() => parseChoiceRound({ ...value, payout_chips: 0 })).toThrow();
      }
    }
  });
});
