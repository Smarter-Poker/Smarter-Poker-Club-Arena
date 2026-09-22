import { describe, expect, it } from 'vitest';
import {
  BONUS_PAYOUT_VERSION,
  PLINKO_LIVE_TABLES,
  PLINKO_TABLES,
  diamondBonusFloor,
  diamondBonusMinimum,
  plinkoDropChoices,
  plinkoTableForFloor,
  receiptPaidDiamonds,
  validBonusMinimum,
  validPlinkoDenomination,
} from '../../src/utils/diamondBonusPayout';
import {
  CHOICE_PAYOUT_VERSION,
  choose,
  mineBoardV4,
  minePrize,
  minePrizeV4,
  MINE_COUNTS,
  RANDOM_SPACE,
  ROAD_LADDERS,
  ROAD_LADDERS_V4,
  roadLadder,
  roadSurvives,
  verifyChoiceProof,
  verifyChoiceRound,
} from '../../src/utils/diamondChoiceMath';
import {
  crashCashoutFloorCents,
  crashPointCentsFromRoll,
  crashPointFloorCents,
  verifyCrashRound,
} from '../../src/utils/diamondGamesFairness';
import { parseChoiceRound } from '../../src/services/DiamondChoiceService';
import { validateCrashSettlement } from '../../src/utils/crashReceipt';
import receipts from '../fixtures/diamond-bonus-minimum-receipts.json';
import firstStepReceipts from '../fixtures/diamond-spins/first-step-postgres-receipts.json';

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
        // A shaved payout is refused: at the parse for a loss, at the proof for a cash-out.
        if (value.status === 'lost')
          expect(() => parseChoiceRound({ ...value, payout_chips: 0 })).toThrow();
        else expect(await verifyChoiceRound({ ...round, payout_chips: 0 } as never)).toBe(false);
      }
    }
  });
});

/**
 * CONTRACT 4 (Dan, 2026-09-21, rulings R3, R6, R10, R11), installed by
 * supabase/migrations/20260921203512 and mirrored here. Every vector below was
 * computed by the migration's own functions on the isolated PostgreSQL fixture
 * (tests/sql/diamond-first-step-and-paid-floor.sql), and the receipts in
 * tests/fixtures/diamond-spins/first-step-postgres-receipts.json are the actual
 * settlements that probe produced, captured verbatim.
 */
describe('contract 4: the first step never ruins a game, and the floor is what the player paid', () => {
  it('the floor is half the stake, or for a Super award what was paid, on every stake', () => {
    for (let entry = 25; entry <= 2500; entry++) {
      // ordinary E; ordinary with the add-on 2E; Super 2E (the entry paid); Super with the add-on 3E (2E paid).
      expect(Math.round(diamondBonusFloor(entry / 100, 1, entry, 100) * 100)).toBe(
        Math.ceil(entry / 2)
      );
      expect(Math.round(diamondBonusFloor((2 * entry) / 100, 1, 2 * entry, 100) * 100)).toBe(entry);
      expect(Math.round(diamondBonusFloor((2 * entry) / 100, 2, entry, 100) * 100)).toBe(entry);
      expect(Math.round(diamondBonusFloor((3 * entry) / 100, 2, 2 * entry, 100) * 100)).toBe(
        2 * entry
      );
    }
    // The owner's example: 2,500 + 2,500 on a Super game is never less than 50 chips.
    expect(diamondBonusFloor(75, 2, 5000, 100)).toBe(50);
    // Without the add-on the Super floor is the entry, unchanged.
    expect(diamondBonusFloor(50, 2, 2500, 100)).toBe(25);
    // Ordinary: the half, rounded up to the cent.
    expect(diamondBonusFloor(0.25, 1, 25, 100)).toBe(0.13);
    expect(diamondBonusFloor(1, 1, 100, 100)).toBe(0.5);
    // Exactly the numbers the migration reads back.
    expect(diamondBonusFloor(0.75, 2, 50, 100)).toBe(0.5);
    expect(BONUS_PAYOUT_VERSION).toBe(4);
  });

  it("the table follows the floor, and the drop value is the player's within one to a hundred drops", () => {
    expect([...PLINKO_LIVE_TABLES]).toEqual([4, 6]);
    expect(plinkoTableForFloor(1, 0.5)).toBe(4);
    expect(plinkoTableForFloor(0.25, 0.13)).toBe(4);
    expect(plinkoTableForFloor(75, 50)).toBe(6);
    expect(plinkoTableForFloor(0.75, 0.5)).toBe(6);
    expect(plinkoTableForFloor(1, 0.8)).toBeNull();
    expect(Math.min(...PLINKO_TABLES[6].multipliersCents)).toBe(72);
    expect(plinkoDropChoices(7500).map((c) => c.denomination)).toEqual([100, 250, 500, 7500]);
    expect(plinkoDropChoices(100).map((c) => c.denomination)).toEqual([
      1, 2, 4, 5, 10, 20, 25, 50, 100,
    ]);
    // 2,489 diamonds is 19 x 131: only the whole stake as one drop fits.
    expect(plinkoDropChoices(7467)).toEqual([{ denomination: 7467, drops: 1 }]);
    expect(validPlinkoDenomination(7500, 50)).toBe(false);
    expect(validPlinkoDenomination(7500, 75)).toBe(false);
    expect(validPlinkoDenomination(2500, 25)).toBe(true);
    expect(validPlinkoDenomination(2500, 1)).toBe(false);
  });

  it('the mines ladder around a safe first pick returns exactly four fifths at every stop', () => {
    for (const bet of [0.25, 0.26, 0.99, 1, 25, 50, 75]) {
      const cents = BigInt(Math.round(bet * 100));
      for (const floor of [
        Math.ceil(Number(cents) / 2) / 100,
        Math.ceil((Number(cents) * 2) / 3) / 100,
      ]) {
        const floorCents = BigInt(Math.round(floor * 100));
        for (let picks = 1; picks <= 19; picks++) {
          const all = choose(24, picks - 1),
            safe = choose(18, picks - 1);
          const prize = minePrizeV4(bet, 6, picks, floor);
          expect(
            (safe * prize.numerator + (all - safe) * floorCents * prize.denominator) * 5n
          ).toBe(4n * cents * all * prize.denominator);
          if (picks === 1) expect(prize.numerator * 5n).toBe(4n * cents * prize.denominator);
        }
      }
    }
    // The Postgres ladder on the owner's stake: 60, 63.33.., 68.039.., 74.80..
    const p = (k: number) => minePrizeV4(75, 6, k, 50);
    expect(Number(p(1).numerator) / Number(p(1).denominator) / 100).toBe(60);
    expect(Number(p(2).numerator) / Number(p(2).denominator) / 100).toBeCloseTo(63.3333333333, 9);
    expect(Number(p(3).numerator) / Number(p(3).denominator) / 100).toBeCloseTo(68.0392156863, 9);
    expect(Number(p(4).numerator) / Number(p(4).denominator) / 100).toBeCloseTo(74.8039215686, 9);
  });

  it('deals the board around the first pick exactly as Postgres does', async () => {
    const seed = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
    expect(await mineBoardV4(seed, 'client-seed', 7, 6, 12)).toEqual([4, 6, 14, 18, 19, 20]);
    expect(await mineBoardV4(seed, 'client-seed', 7, 6, 0)).toEqual([4, 5, 8, 13, 15, 18]);
    expect(await mineBoardV4(seed, 'client-seed', 7, 6, 24)).toEqual([0, 8, 14, 17, 19, 22]);
    for (const first of [0, 7, 12, 24]) {
      const board = await mineBoardV4(seed, 'client-seed', 7, 6, first);
      expect(board).not.toContain(first);
      expect(new Set(board).size).toBe(6);
    }
    await expect(mineBoardV4(seed, 'client-seed', 7, 6, 25)).rejects.toThrow();
  });

  it('street one is certain at 0.80x and every other street keeps its boundary', () => {
    expect(ROAD_LADDERS_V4.road[0]).toBe(80);
    expect(roadLadder('road', 4)).toBe(ROAD_LADDERS_V4.road);
    expect(roadLadder('road', 3)).toBe(ROAD_LADDERS.road);
    expect(roadLadder('road')).toBe(ROAD_LADDERS.road);
    for (const [bet, floor] of [
      [1, 0.5],
      [75, 50],
      [0.25, 0.13],
      [0.75, 0.5],
    ]) {
      expect(roadSurvives(0n, 80, bet, floor)).toBe(true);
      expect(roadSurvives(RANDOM_SPACE - 1n, 80, bet, floor)).toBe(true);
      const b = BigInt(Math.round(bet * 100)),
        l = BigInt(Math.round(floor * 100));
      for (const target of ROAD_LADDERS_V4.road.slice(1)) {
        const denominator = 5n * (b * BigInt(target) - 100n * l);
        const numerator = 100n * (4n * b - 5n * l) * RANDOM_SPACE;
        const survivors = numerator / denominator;
        expect(roadSurvives(survivors - 1n, target, bet, floor)).toBe(true);
        expect(roadSurvives(survivors, target, bet, floor)).toBe(false);
        // And the same boundary is the crash point boundary under the 1.10x floor.
        expect(crashPointCentsFromRoll(survivors - 1n, bet, floor, 110)).toBeGreaterThanOrEqual(
          target
        );
        expect(crashPointCentsFromRoll(survivors, bet, floor, 110)).toBeLessThan(target);
      }
    }
  });

  it('the crash point is floored at 1.10x and cash-out at 1.11x, by version, on the pinned rolls', () => {
    expect(crashPointFloorCents(4)).toBe(110);
    expect(crashCashoutFloorCents(4)).toBe(111);
    expect(crashPointFloorCents(3)).toBe(100);
    expect(crashCashoutFloorCents(2)).toBe(101);
    expect(crashPointCentsFromRoll(123456789012, 75, 50, 110)).toBe(30465);
    expect(crashPointCentsFromRoll(281474976710655n, 75, 50, 110)).toBe(110);
    expect(crashPointCentsFromRoll(200000000000000, 1, 0.5, 110)).toBe(110);
    expect(crashPointCentsFromRoll(200000000000000, 1, 0.5, 100)).toBeLessThan(110);
    expect(() => crashPointCentsFromRoll(1, 1, 0.5, 99)).toThrow();
  });

  it('a contract-4 receipt is recomputed from what was paid, and old versions keep their own', () => {
    const superAddOn = {
      bet_chips: 75,
      bet_diamonds: 7500,
      diamonds_per_chip: 100,
      payout_version: 4,
      minimum_payout_chips: 50,
      bonus: { entry_diamonds: 2500, added_diamonds: 2500, boost_multiplier: 2 },
    };
    expect(receiptPaidDiamonds(superAddOn)).toBe(5000);
    expect(validBonusMinimum(superAddOn)).toBe(true);
    expect(validBonusMinimum({ ...superAddOn, minimum_payout_chips: 37.5 })).toBe(false);
    expect(validBonusMinimum({ ...superAddOn, minimum_payout_chips: 25 })).toBe(false);
    expect(validBonusMinimum({ ...superAddOn, diamonds_per_chip: undefined })).toBe(false);
    expect(
      validBonusMinimum({
        bet_chips: 1,
        bet_diamonds: 100,
        diamonds_per_chip: 100,
        payout_version: 4,
        minimum_payout_chips: 0.5,
      })
    ).toBe(true);
    expect(
      validBonusMinimum({
        bet_chips: 1,
        bet_diamonds: 100,
        diamonds_per_chip: 100,
        payout_version: 4,
        minimum_payout_chips: 0.1,
      })
    ).toBe(false);
    expect(validBonusMinimum({ bet_chips: 50, payout_version: 3, minimum_payout_chips: 25 })).toBe(
      true
    );
    expect(validBonusMinimum({ bet_chips: 50, payout_version: 2, minimum_payout_chips: 5 })).toBe(
      true
    );
  });

  it('verifies the actual contract-4 PostgreSQL receipts for all four games, Super with the add-on and ordinary', async () => {
    expect(firstStepReceipts.length).toBe(9);
    for (const sample of firstStepReceipts) {
      const value = sample.value as unknown as Record<string, unknown>;
      expect(value.payout_version).toBe(4);
      expect(validBonusMinimum(value)).toBe(true);
      const paid = receiptPaidDiamonds(value) as number;
      const boost = (value.bonus as { boost_multiplier: 1 | 2 }).boost_multiplier;
      const betChips = Number(value.bet_diamonds) / Number(value.diamonds_per_chip);
      expect(value.minimum_payout_chips).toBe(
        diamondBonusFloor(betChips, boost, paid, Number(value.diamonds_per_chip))
      );
      if (sample.game === 'crash') {
        expect(() => validateCrashSettlement(value, String(value.round_id))).not.toThrow();
        const proof = value.fairness as Record<string, unknown>;
        const outcome = value.outcome as Record<string, unknown>;
        // The ship never exploded before 1.10x: the sealed point is exactly the floor.
        expect(outcome.crash_cents).toBe(110);
        expect(value.cashout_floor_cents).toBe(111);
        expect(value.crash_floor_cents).toBe(110);
        const verdict = await verifyCrashRound({
          serverSeed: String(proof.server_seed),
          serverSeedHash: String(proof.server_seed_hash),
          clientSeed: String(proof.client_seed),
          nonce: Number(proof.nonce),
          roll: Number(proof.roll),
          crashCents: Number(proof.crash_cents),
          betChips: Number(value.bet_chips),
          minimumPayoutChips: Number(value.minimum_payout_chips),
          payoutVersion: 4,
        });
        expect(verdict.fair).toBe(true);
        // Under the old floor the same roll would have sealed a point below 1.10x: the receipt is version-bound.
        expect(
          (
            await verifyCrashRound({
              ...verdict,
              serverSeed: String(proof.server_seed),
              serverSeedHash: String(proof.server_seed_hash),
              clientSeed: String(proof.client_seed),
              nonce: Number(proof.nonce),
              roll: Number(proof.roll),
              crashCents: Number(proof.crash_cents),
              betChips: Number(value.bet_chips),
              minimumPayoutChips: Number(value.minimum_payout_chips),
              payoutVersion: 3,
            })
          ).fair
        ).toBe(false);
        // A cash-out at 1.05x or a point at 1.05x cannot exist on this contract.
        expect(() =>
          validateCrashSettlement(
            {
              ...value,
              outcome: { ...outcome, crash_cents: 105 },
              fairness: { ...proof, crash_cents: 105 },
            },
            String(value.round_id)
          )
        ).toThrow();
        expect(() =>
          validateCrashSettlement(
            { ...value, outcome: { ...outcome, payout_chips: 0 } },
            String(value.round_id)
          )
        ).toThrow();
      } else if (sample.game === 'plinko') {
        const table = PLINKO_TABLES[Number(value.table_version)];
        const drops = value.drops as {
          multiplier_cents: number;
          payout_chips: number;
          slot: number;
        }[];
        expect(PLINKO_LIVE_TABLES).toContain(Number(value.table_version));
        expect(Number(value.table_version)).toBe(
          plinkoTableForFloor(betChips, Number(value.minimum_payout_chips))
        );
        expect(value.multipliers_cents).toEqual(table.multipliersCents);
        expect(
          validPlinkoDenomination(Number(value.bet_diamonds), Number(value.diamonds_per_drop))
        ).toBe(true);
        expect(drops.length).toBe(Number(value.bet_diamonds) / Number(value.diamonds_per_drop));
        expect(value.drop_count).toBe(drops.length);
        expect(value.paid_diamonds).toBe(paid);
        const total = drops.reduce((sum, d) => sum + Math.round(d.payout_chips * 100), 0);
        expect(Math.round(Number(value.payout_chips) * 100)).toBe(
          Math.max(total, Math.round(Number(value.minimum_payout_chips) * 100))
        );
        for (const d of drops) expect(d.multiplier_cents).toBe(table.multipliersCents[d.slot]);
      } else {
        const round = parseChoiceRound(value);
        expect(await verifyChoiceRound(round as typeof round & { payout_version?: number })).toBe(
          true
        );
        const proof = value.proof as Record<string, unknown>;
        expect(proof.payout_version).toBe(CHOICE_PAYOUT_VERSION);
        if (sample.game === 'mines') {
          expect(proof.first_pick).toBe((value.picked as number[])[0]);
          expect(proof.mine_cells).not.toContain(proof.first_pick);
          // The board is bound to the first pick: dealt around another tile it does not verify.
          expect(
            await verifyChoiceProof({
              ...(proof as object),
              first_pick: ((proof.first_pick as number) + 1) % 25,
            } as never)
          ).toBe(false);
        } else {
          // Street one paid 0.80x when banked, or was crossed for certain before the loss.
          expect((value.prizes as number[])[0]).toBe(betChips * 0.8);
        }
        // A shaved payout is refused: at the parse for a loss, at the proof for a cash-out.
        if (value.status === 'lost')
          expect(() => parseChoiceRound({ ...value, payout_chips: 0 })).toThrow();
        else expect(await verifyChoiceRound({ ...round, payout_chips: 0 } as never)).toBe(false);
      }
    }
  });
});
