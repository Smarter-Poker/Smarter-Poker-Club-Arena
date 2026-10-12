import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic } from '../engine/HorseLogic.js';
import type { RemainingPolicyVariant } from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import type { Card } from '../types.js';
import {
  remainingVariantStrengthLeagueProfile,
  runRemainingVariantStrengthShard,
} from './RemainingVariantStrengthLeague.js';
import {
  REMAINING_VARIANT_STRENGTH_CONTRACT,
  remainingVariantMoodClockMs,
  remainingVariantStrengthPack,
  remainingVariantStrengthShardReasons,
} from './RemainingVariantStrengthContract.js';
import {
  remainingVariantDivergenceStreet,
  remainingVariantIndependentHandChecks,
  type RemainingVariantEndState,
} from './RemainingVariantStrengthChecks.js';
import {
  playPlo4PolicyHand,
  plo4IndependentHandChecks,
  plo4StrengthLeagueProfile,
  runPlo4PolicyLeague,
  runPlo4StrengthShard,
  type Plo4HandReceipt,
} from './Plo4PolicyLeague.js';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import { omahaVariantStrengthPack } from './OmahaVariantStrengthContract.js';
import { runOmahaVariantStrengthShard } from './OmahaVariantStrengthLeague.js';
import { runOmahaVariantLeague } from './OmahaVariantPolicyLeague.js';
import {
  REMAINING_VARIANT_LEAGUE_SEEDS,
  runRemainingVariantLeague,
} from './RemainingVariantPolicyLeague.js';
import { runJointPolicyLeague } from './JointPolicyLeague.js';
import { plo4Cards } from './Plo4PolicyEvidence.js';

const VARIANTS: RemainingPolicyVariant[] = ['short_deck', 'pineapple', 'flh', 'flo8'];
const DEV = REMAINING_VARIANT_LEAGUE_SEEDS[0];
const holdout = (v: RemainingPolicyVariant, i = 0) =>
  remainingVariantStrengthPack(v).holdout.seeds[i];
const VALIDITY = [
  'illegalActions',
  'conservationErrors',
  'cardErrors',
  'truncatedHands',
  'settlementMismatches',
  'deductionMismatches',
  'pairedReplayMismatches',
] as const;

afterEach(() => vi.restoreAllMocks());

describe('P12.2 development shards: legal, conserved and independently settled', () => {
  it.each(VARIANTS)(
    '%s six-max 100 BB: complete, balanced, every validity counter zero, repeatable',
    async (variant) => {
      const request = {
        profileId: `p12c-${variant}-6max-100bb`,
        seed: DEV,
        shard: 1,
        mode: 'development' as const,
        pairs: 36,
      };
      const first = await runRemainingVariantStrengthShard(variant, request);
      const second = await runRemainingVariantStrengthShard(variant, request);
      expect({ ...second, durationMs: 0 }).toEqual({ ...first, durationMs: 0 });
      expect(first.schema).toBe('horse-phase12-strength-shard-v1');
      expect(first.variant).toBe(variant);
      expect(first.complete).toBe(true);
      expect(first.positionCoverageComplete).toBe(true);
      expect(first.offsetCounts).toEqual([6, 6, 6, 6, 6, 6]);
      expect(first.firstPair).toBe(remainingVariantStrengthPack(variant).matrix.pairsPerShard);
      expect(first.showdownsChecked + first.foldWinsChecked).toBe(72);
      expect(first.showdownsChecked).toBeGreaterThan(0);
      expect(first.totalRake).toBeGreaterThan(0);
      for (const field of VALIDITY) expect(first[field]).toBe(0);
      // The jackpot row: Short Deck drops nothing, the others drop on flops with 3+ dealt.
      if (variant === 'short_deck') expect(first.totalBbj).toBe(0);
      else expect(first.totalBbj).toBeGreaterThan(0);
      // Only FLO8 settles a low half; only Pineapple discards.
      if (variant === 'flo8') expect(first.lowHalvesChecked).toBeGreaterThan(0);
      else expect(first.lowHalvesChecked).toBe(0);
      if (variant === 'pineapple') expect(first.discards).toBeGreaterThan(0);
      else expect(first.discards).toBe(0);
      // A discard is never a betting decision or a candidate node.
      expect(Object.keys(first.nodeCounts).some((k) => k.includes('discard'))).toBe(false);
      expect(Number.isInteger(first.illegalCandidates)).toBe(true);
      expect(first.eligible).toBeGreaterThan(0);
      expect(first.fixedWork.moodClock).toBe('deal_seed_time_of_day');
      expect(Object.values(first.strata).reduce((s, v) => s + v.n, 0)).toBe(36);
      // A development shard can never enter the verdict.
      const key = `p12c-${variant}-6max-100bb-${DEV}-s1`;
      expect(remainingVariantStrengthShardReasons(variant, first)).toEqual(
        expect.arrayContaining([
          `${key}:not_contract_mode`,
          `${key}:not_holdout_seed`,
          `${key}:pairs_below_contract`,
        ])
      );
      expect(first.promotionEligible).toBe(false);
    },
    180_000
  );

  it('the seat-ceiling, heads-up and legacy-depth profiles complete balanced with zero mismatches', async () => {
    for (const [variant, profileId, pairs] of [
      ['pineapple', 'p12c-pineapple-9max-100bb', 81],
      ['flo8', 'p12c-flo8-8max-100bb', 64],
      ['short_deck', 'p12c-short_deck-6max-2dealt-100bb', 16],
      ['flh', 'p12c-flh-6max-1000bb', 36],
    ] as const) {
      const r = await runRemainingVariantStrengthShard(variant, {
        profileId,
        seed: DEV,
        shard: 0,
        mode: 'development',
        pairs,
      });
      expect(r.complete, profileId).toBe(true);
      expect(r.positionCoverageComplete, profileId).toBe(true);
      for (const field of VALIDITY) expect(r[field], `${profileId} ${field}`).toBe(0);
    }
  }, 240_000);
});

describe('P12.2 held-out seeds', () => {
  it('refuses held-out seeds in development mode and development seeds in contract mode', async () => {
    const profileId = 'p12c-flh-6max-2dealt-100bb';
    const run = (seed: number, mode: 'contract' | 'development', extra = {}) =>
      runRemainingVariantStrengthShard('flh', {
        profileId,
        seed,
        shard: 0,
        mode,
        pairs: 4,
        ...extra,
      });
    await expect(run(holdout('flh'), 'development')).rejects.toThrow('never runs a held-out seed');
    await expect(run(holdout('flo8'), 'development')).rejects.toThrow('never runs a held-out seed');
    await expect(
      run(omahaVariantStrengthPack('plo5').holdout.seeds[0], 'development')
    ).rejects.toThrow('never runs a held-out seed');
    await expect(run(PLO4_STRENGTH_CONTRACT.holdout.seeds[0], 'development')).rejects.toThrow(
      'never runs a held-out seed'
    );
    await expect(run(DEV, 'contract', { pairs: undefined })).rejects.toThrow(
      "its own pack's held-out seeds"
    );
    // Another pack's held-out seed is not this pack's.
    await expect(run(holdout('short_deck'), 'contract', { pairs: undefined })).rejects.toThrow(
      "its own pack's held-out seeds"
    );
    await expect(run(holdout('flh'), 'contract')).rejects.toThrow('exactly the contract pairs');
    await expect(run(DEV, 'development', { shard: 99 })).rejects.toThrow('outside the matrix');
    await expect(
      runRemainingVariantStrengthShard('flh', {
        profileId: 'p12c-flo8-6max-2dealt-100bb',
        seed: DEV,
        shard: 0,
        mode: 'development',
        pairs: 4,
      })
    ).rejects.toThrow('outside the matrix');
  });

  it.each(VARIANTS)('every development entry point refuses %s held-out seeds', async (v) => {
    for (let i = 0; i < 3; i++) {
      const seed = holdout(v, i);
      for (const run of [
        () => runPlo4PolicyLeague({ profileId: 'heads-up-25bb', pairs: 1, seed }),
        () => runOmahaVariantLeague({ profileId: 'plo5-hu-25bb', pairs: 1, seed }),
        () => runRemainingVariantLeague({ profileId: `${v}-hu-25bb`, pairs: 1, seed }),
        () => runJointPolicyLeague({ profileId: 'unused', pairs: 1, seed }),
      ])
        await expect(run()).rejects.toThrow('Held-out Phase 12 strength seeds');
      for (const mode of ['development', 'contract'] as const)
        await expect(
          runPlo4StrengthShard({
            profileId: 'p10c-6max-2dealt-100bb',
            seed,
            shard: 0,
            mode,
            ...(mode === 'development' ? { pairs: 4 } : {}),
          })
        ).rejects.toThrow('held-out Phase 12 seed');
      await expect(
        runOmahaVariantStrengthShard('plo5', {
          profileId: 'p11c-plo5-6max-2dealt-100bb',
          seed,
          shard: 0,
          mode: 'development',
          pairs: 4,
        })
      ).rejects.toThrow('never runs a held-out seed');
    }
  });
});

describe('P12.2 live conditions in the harness', () => {
  type DecideOpts = { decisionTimeMs?: number; v9Mood?: boolean; phase12Remaining?: string };
  const spyDecide = () => {
    const calls: { user: string; opts: DecideOpts }[] = [];
    const original = HorseLogic.decide.bind(HorseLogic);
    vi.spyOn(HorseLogic, 'decide').mockImplementation(((
      ...args: Parameters<typeof HorseLogic.decide>
    ) => {
      calls.push({ user: args[0].user_id, opts: (args[4] ?? {}) as DecideOpts });
      return original(...args);
    }) as typeof HorseLogic.decide);
    return calls;
  };

  it('plays mood on, on the deal-seed clock, identically in both arms of a pair', async () => {
    const profile = remainingVariantStrengthLeagueProfile('pineapple', 'p12c-pineapple-6max-100bb');
    expect(profile.moodClock).toBe('deal_seed_time_of_day');
    expect(profile.publishedRake).toBe(true);
    expect(profile.productionStyles).toBe(true);
    for (const dealSeed of [123457, 98765431, 4000000001]) {
      const calls = spyDecide();
      await playPlo4PolicyHand(profile, dealSeed, 1, 3, 'candidate', () => true, true);
      const candidate = calls.splice(0);
      await playPlo4PolicyHand(profile, dealSeed, 1, 3, 'off', () => true, true);
      const reference = calls.splice(0);
      vi.restoreAllMocks();
      expect(candidate.length).toBeGreaterThan(0);
      expect(reference.length).toBeGreaterThan(0);
      for (const c of [...candidate, ...reference]) {
        expect(c.opts.v9Mood).toBe(true);
        expect(c.opts.decisionTimeMs).toBe(remainingVariantMoodClockMs(dealSeed));
      }
      // Only the hero seat differs between the arms, and only in its pack mode.
      const hero = candidate.filter((c) => c.opts.phase12Remaining === 'candidate');
      expect(hero.length).toBeGreaterThan(0);
      expect(hero.every((c) => c.user === 'plo4-league-3')).toBe(true);
      expect(reference.every((c) => c.opts.phase12Remaining === 'off')).toBe(true);
    }
  });

  it('leaves the PLO4 contract profile exactly as before: mood off at decision time 0', async () => {
    const profile = plo4StrengthLeagueProfile('p10c-6max-100bb');
    const calls = spyDecide();
    const r = await playPlo4PolicyHand(profile, 123457, 1, 3, 'candidate', () => true, true);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.opts.v9Mood).toBe(false);
      expect(c.opts.decisionTimeMs).toBe(0);
    }
    // The Phase 12 counters never appear on a PLO4 hand.
    expect('illegalCandidates' in r).toBe(false);
    expect(r.checks && 'discards' in r.checks).toBe(false);
  });
});

describe('P12.2 independent checks follow the pack variant', () => {
  const config = { smallBlind: 1, bigBlind: 2 };
  const seat = (n: number, cards: string, stack: number, folded = false, invested = 12) => ({
    seat: n,
    user_id: `p${n}`,
    username: `p${n}`,
    cards: plo4Cards(cards),
    stack,
    bet: 0,
    totalInvested: n <= 3 ? invested : 0,
    is_folded: folded,
    is_all_in: false,
    is_sitting_out: false,
  });
  const endState = (
    players: ReturnType<typeof seat>[],
    board: string
  ): RemainingVariantEndState => ({
    players,
    communityCards: plo4Cards(board),
    dealerSeat: 6,
    actionHistory: [],
  });
  const check = (
    variant: RemainingPolicyVariant,
    end: RemainingVariantEndState,
    rake: number,
    bbj: number,
    knownDeadCards: Card[] = []
  ) =>
    remainingVariantIndependentHandChecks(variant, {
      end,
      startStack: 200,
      rake,
      bbj,
      config,
      publishedRake: true,
      tableSeats: 6,
      knownDeadCards,
    });

  it('Short Deck: a flush beats a full house, and no jackpot drop is taken', () => {
    // Seat 1: flush in spades. Seat 2: full house (nines full of sixes). Seat 3 folded.
    // Pot 36, six dealt: rake 3.60; Short Deck takes no BBJ drop.
    const players = (s1: number, s2: number) => [
      seat(1, 'As Ks', s1),
      seat(2, '9h 9d', s2),
      seat(3, 'Th Jd', 188, true),
      seat(4, 'Qh Qd', 200, true),
      seat(5, '7h 8d', 200, true),
      seat(6, 'Tc Jc', 200, true),
    ];
    const board = '9s 6s 6d Ts 7s';
    const right = check('short_deck', endState(players(188 + 32.4, 188), board), 3.6, 0);
    expect(right).toMatchObject({
      settlementMismatches: 0,
      deductionMismatches: 0,
      showdownChecked: true,
    });
    // The standard order (full house over flush) would pay seat 2: caught.
    const standard = check('short_deck', endState(players(188, 188 + 32.4), board), 3.6, 0);
    expect(standard.settlementMismatches).toBeGreaterThan(0);
    // A jackpot drop on a Short Deck hand is a deduction mismatch.
    const dropped = check('short_deck', endState(players(188 + 31.9, 188), board), 3.6, 0.5);
    expect(dropped.deductionMismatches).toBe(1);
  });

  it('FLO8 settles the high and low halves; a scoop to the high hand alone is caught', () => {
    const players = (s1: number, s2: number) => [
      seat(1, 'As Ad Ks Qd', s1),
      seat(2, '3c 4d Jc Tc', s2),
      seat(3, '9h 9d 8s 8h', 188, true),
      seat(4, '6s 6c 5d 5h', 200, true),
      seat(5, 'Qs Qh Js Jh', 200, true),
      seat(6, 'Kd Kc Th Td', 200, true),
    ];
    const board = 'Ah 2d 7c 9s Kh';
    const split = check('flo8', endState(players(188 + 15.95, 188 + 15.95), board), 3.6, 0.5);
    expect(split).toMatchObject({
      settlementMismatches: 0,
      deductionMismatches: 0,
      showdownChecked: true,
      lowHalfChecked: true,
    });
    const scoop = check('flo8', endState(players(188 + 31.9, 188), board), 3.6, 0.5);
    expect(scoop.settlementMismatches).toBeGreaterThan(0);
  });

  it('Pineapple: retained pairs are scored, discards and an unfolded third card are dead cards', () => {
    // Seat 1 retained Ah Kh after discarding 2c; seat 2 retained Qd Qc; seat 3
    // folded preflop still holding three cards.
    const players = (s1: number, s2: number) => [
      seat(1, 'Ah Kh', s1),
      seat(2, 'Qd Qc', s2),
      seat(3, '5s 5d 4c', 188, true),
      seat(4, '8h 8d 8c', 200, true),
      seat(5, '6s 6c 6d', 200, true),
      seat(6, '3h 3d 3s', 200, true),
    ];
    const board = 'Qh Jh Th 2s 7d';
    const dead = plo4Cards('2c 9c');
    const right = check('pineapple', endState(players(188 + 31.9, 188), board), 3.6, 0.5, dead);
    expect(right).toMatchObject({ settlementMismatches: 0, deductionMismatches: 0 });
    // A discard that collides with a live card is a physical card error.
    const collided = check(
      'pineapple',
      endState(players(188 + 31.9, 188), board),
      3.6,
      0.5,
      plo4Cards('Ah')
    );
    expect(collided.settlementMismatches).toBeGreaterThan(0);
    // The Omaha reading has no Pineapple rules: it cannot certify this hand.
    const asOmaha = plo4IndependentHandChecks(
      { ...remainingVariantStrengthLeagueProfile('pineapple', 'p12c-pineapple-6max-100bb') },
      endState(players(188 + 31.9, 188), board) as unknown as Parameters<
        typeof plo4IndependentHandChecks
      >[1],
      { rake: 3.6, bbj: 0.5 } as Plo4HandReceipt,
      { smallBlind: 1, bigBlind: 2 } as Parameters<typeof plo4IndependentHandChecks>[3]
    );
    expect(asOmaha.settlementMismatches).toBeGreaterThan(0);
  });

  it('a Pineapple discard divergence belongs to the flop; an unknown stage refuses', () => {
    const a = ['1:raise:4:preflop', '2:discard:0:pineapple_discard', '1:bet:2:flop'];
    expect(remainingVariantDivergenceStreet(a, a)).toBe('none');
    expect(remainingVariantDivergenceStreet(a, [a[0], '2:discard:1:pineapple_discard', a[2]])).toBe(
      'flop'
    );
    expect(remainingVariantDivergenceStreet(a, ['1:call:2:preflop'])).toBe('preflop');
    expect(() => remainingVariantDivergenceStreet([a[0]], [a[0], '2:x:0:showdown'])).toThrow(
      'Unknown divergence stage'
    );
  });

  it('the contract names the per-variant settlement and deduction references', () => {
    expect(REMAINING_VARIANT_STRENGTH_CONTRACT.softwareValidity.settlementReference).toContain(
      'FLO8, which settles high and low halves'
    );
    expect(REMAINING_VARIANT_STRENGTH_CONTRACT.softwareValidity.deductionReference).toContain(
      'Short Deck drops no jackpot fee'
    );
  });
});
