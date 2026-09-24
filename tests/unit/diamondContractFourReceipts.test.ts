/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CONTRACT-4 RECEIPT IS ONE THE CLIENT CAN READ
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Production has sealed every bonus round at `payout_version` 4 since
 * 2026-09-23 03:23Z: the floor is `fn_diamond_bonus_floor` (half the stake, or
 * for a Super award with the Double Diamonds add-on what the player PAID), the
 * Plinko table is the one that floor chose (`fn_plinko_table_for_floor`, 4 and
 * 6 open, 5 closed), the road starts at 0.80x and Crash is floored at 1.10x
 * with cash out opening at 1.11x.
 *
 * The three receipt readers stopped at 3, 3 and 2, so every bonus game broke
 * the moment the wheel paid out. This pins the whole receipt half against the
 * settlements production's own functions produced
 * (tests/fixtures/diamond-spins/first-step-postgres-receipts.json) and against
 * a thousand real crash rolls read back out of production
 * (tests/fixtures/diamond-spins/crash-point-postgres-rolls.json).
 *
 * A receipt sealed under an OLDER contract still verifies under the rule it was
 * sealed with: history is never re-priced. Every case below is asserted in both
 * directions for that reason.
 */
import { describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-spins/first-step-postgres-receipts.json';
import rollVectors from '../fixtures/diamond-spins/crash-point-postgres-rolls.json';
import {
  parsePlinkoBonus,
  validateBonusReceipt,
  type BonusStart,
} from '../../src/services/DiamondBonusService';
import { parseChoiceRound } from '../../src/services/DiamondChoiceService';
import { normaliseCrash } from '../../src/services/DiamondGamesService';
import DiamondGamesService from '../../src/services/DiamondGamesService';
import { parseBonusGuarantee } from '../../src/services/WheelBonusEntryService';
import {
  diamondBonusFloor,
  plinkoTableForFloor,
  PLINKO_LIVE_TABLES,
} from '../../src/utils/diamondBonusPayout';
import {
  awardInstantCrashChances,
  crashInstantChance,
  crashMissChance,
  crashPointCentsFromRoll,
  oneInRangeLabel,
  verifyCrashRound,
} from '../../src/utils/diamondGamesFairness';
import { validateCrashSettlement } from '../../src/utils/crashReceipt';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));

type Receipt = Record<string, unknown>;
const of = (game: string, pick: (v: Receipt) => boolean = () => true) =>
  (receipts as { game: string; value: Receipt }[]).filter((s) => s.game === game && pick(s.value));

const plinkoSuper = of('plinko', (v) => v.table_version === 6)[0].value;
const plinkoOrdinary = of('plinko', (v) => v.table_version === 4)[0].value;
const crashReceipt = of('crash')[0].value;
const crossing = of('crossing')[0].value;
const mines = of('mines')[0].value;

const bonusOf = (v: Receipt) => v.bonus as Record<string, number>;
const startFor = (v: Receipt, game: BonusStart['game'], extra: Partial<BonusStart> = {}) => {
  const b = bonusOf(v);
  const fairness = v.fairness as Record<string, unknown> | undefined;
  return {
    clubId: String(v.club_id),
    game,
    budget: {
      base: b.base_diamonds,
      doubled: b.added_diamonds > 0,
      denomination: (v.diamonds_per_drop as number) ?? null,
      award: {
        id: String(v.award_id),
        entryDiamonds: b.entry_diamonds,
        boostMultiplier: b.boost_multiplier as 1 | 2,
      },
    },
    commitId: String(v.commit_id ?? fairness?.commit_id),
    serverSeedHash: String(v.server_seed_hash ?? fairness?.server_seed_hash),
    seed: String(v.client_seed ?? fairness?.client_seed),
    tableVersion: v.table_version as number | undefined,
    autoCashoutCents: (v.auto_cashout_cents as number | null) ?? null,
    ...extra,
  } as BonusStart;
};

describe('contract 4: the receipt readers speak the contract production seals', () => {
  it('reads a Super plinko batch dealt on the Super Double board, and its ordinary sibling on the Super board', () => {
    for (const value of [plinkoSuper, plinkoOrdinary]) {
      const parsed = parsePlinkoBonus(value);
      expect(parsed.payout_version).toBe(4);
      // The board is the one the FLOOR chose, never the one the boost used to choose.
      expect(PLINKO_LIVE_TABLES).toContain(parsed.table_version);
      expect(parsed.table_version).toBe(
        plinkoTableForFloor(
          parsed.bet_diamonds / parsed.diamonds_per_chip,
          parsed.minimum_payout_chips as number
        )
      );
      // The floor is recomputed from what was paid, never trusted.
      expect(parsed.minimum_payout_chips).toBe(
        diamondBonusFloor(
          parsed.bet_diamonds / parsed.diamonds_per_chip,
          bonusOf(value).boost_multiplier as 1 | 2,
          value.paid_diamonds as number,
          parsed.diamonds_per_chip
        )
      );
      // A shaved floor is refused where the player can see it.
      expect(() =>
        parsePlinkoBonus({
          ...value,
          minimum_payout_chips: (value.minimum_payout_chips as number) - 0.01,
        })
      ).toThrow();
      // The drop count is the player's own split of the stake, not a pinned ten.
      expect(parsed.drops.length).toBe(parsed.bet_diamonds / parsed.diamonds_per_drop);
      expect(value.drop_count).toBe(parsed.drops.length);
    }
    // The two batches were dealt on DIFFERENT boards: the add-on moved the floor.
    expect(plinkoSuper.table_version).toBe(6);
    expect(plinkoOrdinary.table_version).toBe(4);
  });

  it('accepts a contract-4 plinko start whose table is the one its floor chose', () => {
    for (const value of [plinkoSuper, plinkoOrdinary]) {
      const input = startFor(value, 'plinko');
      expect(() => validateBonusReceipt(input, value)).not.toThrow();
      // A receipt naming any other open board is refused.
      const other = PLINKO_LIVE_TABLES.find((t) => t !== value.table_version) as number;
      expect(() =>
        validateBonusReceipt({ ...input, tableVersion: other }, { ...value, table_version: other })
      ).toThrow();
      // So is one that claims the retired version its boost used to name.
      expect(() =>
        validateBonusReceipt({ ...input, tableVersion: 5 }, { ...value, table_version: 5 })
      ).toThrow();
    }
  });

  it('keeps a crash round its own contract, and states the floors that contract plays', () => {
    const round = normaliseCrash(crashReceipt);
    expect(round.payout_version).toBe(4);
    expect(round.crash_floor_cents).toBe(110);
    expect(round.cashout_floor_cents).toBe(111);
    // A round sealed before contract 4 keeps the floors it was sealed with.
    const old = normaliseCrash({ ...crashReceipt, payout_version: 2, minimum_payout_chips: 7.5 });
    expect(old.payout_version).toBe(2);
    expect(old.crash_floor_cents).toBe(100);
    expect(old.cashout_floor_cents).toBe(101);
    // And a receipt with no version at all is the oldest contract of all.
    const ancient = normaliseCrash({ ...crashReceipt, payout_version: undefined });
    expect(ancient.payout_version).toBeUndefined();
    expect(ancient.cashout_floor_cents).toBe(101);
  });

  it('opens the cash out at 1.11x on a contract-4 round and at 1.01x on an older one', async () => {
    const round = normaliseCrash(crashReceipt);
    await expect(DiamondGamesService.crashSettle(round.round_id, true, round, 110)).rejects.toThrow(
      'Cash Out Starts At 1.11x'
    );
    const old = normaliseCrash({ ...crashReceipt, payout_version: 2, minimum_payout_chips: 7.5 });
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'That Round Could Not Be Found' } });
    await expect(
      DiamondGamesService.crashSettle(old.round_id, true, old, 110)
    ).resolves.toBeTruthy();
    expect(rpc).toHaveBeenCalled();
    rpc.mockReset();
  });

  it('recomputes a thousand production crash rolls at the 1.10x floor, where the old floor called half of them unfair', async () => {
    const pairs = rollVectors.pairs as [number, number][];
    const rolls = (rollVectors.rolls as string[]).map((r) => BigInt(r));
    let floored = 0;
    let wouldHaveFailed = 0;
    for (let p = 0; p < pairs.length; p++) {
      const [bet, floorChips] = pairs[p];
      const sealed = rollVectors.cents[p] as number[];
      for (let i = 0; i < rolls.length; i++) {
        expect(crashPointCentsFromRoll(rolls[i], bet, floorChips, 110)).toBe(sealed[i]);
        if (sealed[i] === 110) floored++;
        if (crashPointCentsFromRoll(rolls[i], bet, floorChips, 100) !== sealed[i])
          wouldHaveFailed++;
      }
    }
    // The floor binds on about half of all real rolls, which is exactly how many
    // rounds a verifier stuck on the 1.00x floor would have called unfair.
    const total = pairs.length * rolls.length;
    expect(total).toBe(4000);
    expect(floored / total).toBeGreaterThan(0.4);
    // Every disagreement is one of those floored rolls, and there are enough of
    // them that a verifier stuck at 1.00x would have libelled half the game.
    expect(wouldHaveFailed).toBeLessThanOrEqual(floored);
    expect(wouldHaveFailed / total).toBeGreaterThan(0.4);
    // And the receipt production actually sealed at the floor verifies in the browser.
    const proof = crashReceipt.fairness as Record<string, unknown>;
    const round = normaliseCrash(crashReceipt);
    const verdict = await verifyCrashRound({
      serverSeed: String(proof.server_seed),
      serverSeedHash: String(proof.server_seed_hash),
      clientSeed: String(proof.client_seed),
      nonce: Number(proof.nonce),
      roll: Number(proof.roll),
      crashCents: Number(proof.crash_cents),
      betChips: round.bet_chips,
      minimumPayoutChips: round.minimum_payout_chips ?? 0,
      payoutVersion: round.payout_version,
    });
    expect(verdict.fair).toBe(true);
    expect(verdict.computedCrashCents).toBe(110);
    expect(() =>
      validateCrashSettlement(crashReceipt, String(crashReceipt.round_id))
    ).not.toThrow();
  });

  it('prices the instant crash from the contract-4 floor and the 1.11x open', () => {
    // Nothing can crash below 1.10x, so no target at or under it can be missed.
    expect(crashMissChance(110, 1, 0.5, 110)).toBe(0);
    expect(crashMissChance(100, 1, 0.5, 110)).toBe(0);
    // 1.11x is the first hundredth a cash-out binds: 1 - (0.8 - L)/(1.11 - L).
    expect(crashMissChance(111, 1, 0.5, 110)).toBeCloseTo(1 - 0.3 / 0.61, 12);
    expect(crashInstantChance(1, 0.5, 4)).toBeCloseTo(1 - 0.3 / 0.61, 12);
    // An older round keeps its own: it could die at 1.00x and cash out at 1.01x.
    expect(crashInstantChance(1, 0.1, 2)).toBeCloseTo(1 - 0.7 / 0.91, 12);
    expect(crashInstantChance(1, 0.1)).toBeCloseTo(1 - 0.7 / 0.91, 12);
    // The lobby's two figures: an ordinary award keeps half, a Super award with
    // the add-on keeps the two thirds it paid, and both are priced at 1.11x.
    expect(oneInRangeLabel(awardInstantCrashChances(1, 100))).toBe('1 In 1.9 To 2');
    expect(oneInRangeLabel(awardInstantCrashChances(2, 100))).toBe('1 In 1.4 To 2');
  });

  it('reads a contract-4 road and a contract-4 mines board, and refuses a board not dealt around its first pick', () => {
    for (const value of [crossing, mines]) {
      const round = parseChoiceRound(value);
      expect(round.payout_version).toBe(4);
      expect(round.minimum_payout_chips).toBe(
        diamondBonusFloor(
          round.bet_chips,
          bonusOf(value).boost_multiplier as 1 | 2,
          bonusOf(value).entry_diamonds + bonusOf(value).added_diamonds,
          round.diamonds_per_chip
        )
      );
    }
    // The first step of either game is certain and pays 0.80x of the stake: the
    // road's first street, and the first gem on the mines board. It was 1.10x
    // on the road and a gamble on the board before contract 4.
    expect((crossing.prizes as number[])[0]).toBe(Number(crossing.bet_chips) * 0.8);
    expect((mines.prizes as number[])[0]).toBe(Number(mines.bet_chips) * 0.8);
    // Mines: the board is dealt at the first pick and the proof names it.
    const proof = mines.proof as Record<string, unknown>;
    expect(proof.first_pick).toBe((mines.picked as number[])[0]);
    expect(() =>
      parseChoiceRound({ ...mines, proof: { ...proof, first_pick: undefined } })
    ).toThrow();
    expect(() =>
      parseChoiceRound({
        ...mines,
        proof: { ...proof, first_pick: ((proof.first_pick as number) + 1) % 25 },
      })
    ).toThrow();
    // A contract-4 crossing round may only name the one road the v4 ladder deals.
    expect(() => parseChoiceRound({ ...crossing, mode: 'bold' })).toThrow();
  });

  it('quotes the award guarantee production would seal, with the board that floor chose', () => {
    const award = {
      id: String(plinkoSuper.award_id),
      club_id: String(plinkoSuper.club_id),
      game: 'plinko',
      status: 'pending',
      cap_cents: 2000,
      bet_diamonds: 7500,
      added_diamonds: 2500,
      base_diamonds: 5000,
      entry_diamonds: 2500,
      boost_multiplier: 2,
      result: null,
      commit_id: null,
    } as never;
    const quoted = {
      diamonds_per_chip: 100,
      guarantee: 'super',
      minimum_payout_chips: 50,
      mode: null,
      plinko_table: 6,
      payout_version: 4,
      paid_diamonds: 5000,
    };
    const guarantee = parseBonusGuarantee(quoted, award, 'plinko');
    expect(guarantee.minimumPayoutChips).toBe(50);
    expect(guarantee.plinkoTable).toBe(6);
    // The old rule's answers are refused: half of 75 is 37.50, and board 4 is
    // the board a Super award WITHOUT the add-on plays.
    expect(() =>
      parseBonusGuarantee({ ...quoted, minimum_payout_chips: 37.5 }, award, 'plinko')
    ).toThrow('The Award Guarantee Could Not Be Quoted');
    expect(() => parseBonusGuarantee({ ...quoted, plinko_table: 4 }, award, 'plinko')).toThrow();
  });
});
