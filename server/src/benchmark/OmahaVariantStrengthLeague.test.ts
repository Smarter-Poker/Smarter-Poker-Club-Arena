import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic } from '../engine/HorseLogic.js';
import type { OmahaPolicyVariant } from '../engine/omaha/OmahaVariantPolicyPack.js';
import type { HandConfig } from '../types.js';
import {
  omahaVariantStrengthLeagueProfile,
  runOmahaVariantStrengthShard,
} from './OmahaVariantStrengthLeague.js';
import {
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  omahaVariantMoodClockMs,
  omahaVariantStrengthPack,
  omahaVariantStrengthShardReasons,
} from './OmahaVariantStrengthContract.js';
import {
  PLO4_LEAGUE_SEEDS,
  playPlo4PolicyHand,
  plo4IndependentHandChecks,
  plo4StrengthLeagueProfile,
  runPlo4PolicyLeague,
  runPlo4StrengthShard,
  type Plo4HandReceipt,
} from './Plo4PolicyLeague.js';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import { OMAHA_VARIANT_LEAGUE_SEEDS, runOmahaVariantLeague } from './OmahaVariantPolicyLeague.js';
import { runRemainingVariantLeague } from './RemainingVariantPolicyLeague.js';
import { runJointPolicyLeague } from './JointPolicyLeague.js';
import { plo4Cards } from './Plo4PolicyEvidence.js';

const VARIANTS: OmahaPolicyVariant[] = ['plo5', 'plo6', 'plo8'];
const DEV = OMAHA_VARIANT_LEAGUE_SEEDS[0];
const holdout = (v: OmahaPolicyVariant, i = 0) => omahaVariantStrengthPack(v).holdout.seeds[i];

afterEach(() => vi.restoreAllMocks());

describe('P11.2 development shards: legal, conserved and independently settled', () => {
  it.each(VARIANTS)(
    '%s six-max 100 BB: complete, balanced, every validity counter zero, repeatable',
    async (variant) => {
      const request = {
        profileId: `p11c-${variant}-6max-100bb`,
        seed: DEV,
        shard: 1,
        mode: 'development' as const,
        pairs: 36,
      };
      const first = await runOmahaVariantStrengthShard(variant, request);
      const second = await runOmahaVariantStrengthShard(variant, request);
      expect({ ...second, durationMs: 0 }).toEqual({ ...first, durationMs: 0 });
      expect(first.schema).toBe('horse-phase11-strength-shard-v1');
      expect(first.variant).toBe(variant);
      expect(first.complete).toBe(true);
      expect(first.positionCoverageComplete).toBe(true);
      expect(first.offsetCounts).toEqual([6, 6, 6, 6, 6, 6]);
      expect(first.firstPair).toBe(omahaVariantStrengthPack(variant).matrix.pairsPerShard);
      expect(first.showdownsChecked + first.foldWinsChecked).toBe(72);
      expect(first.showdownsChecked).toBeGreaterThan(0);
      expect(first.totalRake).toBeGreaterThan(0);
      for (const field of [
        'illegalActions',
        'conservationErrors',
        'cardErrors',
        'truncatedHands',
        'settlementMismatches',
        'deductionMismatches',
        'pairedReplayMismatches',
      ] as const)
        expect(first[field]).toBe(0);
      // The jackpot row: PLO6 drops nothing, PLO5 and PLO8 drop on flops with 3+ dealt.
      if (variant === 'plo6') expect(first.totalBbj).toBe(0);
      else expect(first.totalBbj).toBeGreaterThan(0);
      // Only PLO8 settles a low half.
      if (variant === 'plo8') expect(first.lowHalvesChecked).toBeGreaterThan(0);
      else expect(first.lowHalvesChecked).toBe(0);
      expect(first.eligible).toBeGreaterThan(0);
      expect(first.fixedWork.moodClock).toBe('deal_seed_time_of_day');
      expect(Object.values(first.strata).reduce((s, v) => s + v.n, 0)).toBe(36);
      // A development shard can never enter the verdict.
      const key = `p11c-${variant}-6max-100bb-${DEV}-s1`;
      expect(omahaVariantStrengthShardReasons(variant, first)).toEqual(
        expect.arrayContaining([
          `${key}:not_contract_mode`,
          `${key}:not_holdout_seed`,
          `${key}:pairs_below_contract`,
        ])
      );
      expect(first.promotionEligible).toBe(false);
    },
    120_000
  );

  it('PLO8 heads-up and four-dealt profiles complete balanced with zero mismatches', async () => {
    for (const profileId of ['p11c-plo8-6max-2dealt-100bb', 'p11c-plo8-6max-4dealt-100bb']) {
      const r = await runOmahaVariantStrengthShard('plo8', {
        profileId,
        seed: DEV,
        shard: 0,
        mode: 'development',
        pairs: 16,
      });
      expect(r.complete).toBe(true);
      expect(r.positionCoverageComplete).toBe(true);
      expect(r.settlementMismatches + r.deductionMismatches + r.illegalActions).toBe(0);
    }
  }, 120_000);
});

describe('P11.2 held-out seeds', () => {
  it('refuses held-out seeds in development mode and development seeds in contract mode', async () => {
    const profileId = 'p11c-plo5-6max-2dealt-100bb';
    const run = (seed: number, mode: 'contract' | 'development', extra = {}) =>
      runOmahaVariantStrengthShard('plo5', { profileId, seed, shard: 0, mode, pairs: 4, ...extra });
    await expect(run(holdout('plo5'), 'development')).rejects.toThrow('never runs a held-out seed');
    await expect(run(holdout('plo6'), 'development')).rejects.toThrow('never runs a held-out seed');
    await expect(run(PLO4_STRENGTH_CONTRACT.holdout.seeds[0], 'development')).rejects.toThrow(
      'never runs a held-out seed'
    );
    await expect(run(DEV, 'contract', { pairs: undefined })).rejects.toThrow(
      "its own pack's held-out seeds"
    );
    // Another pack's held-out seed is not this pack's.
    await expect(run(holdout('plo8'), 'contract', { pairs: undefined })).rejects.toThrow(
      "its own pack's held-out seeds"
    );
    await expect(run(holdout('plo5'), 'contract')).rejects.toThrow('exactly the contract pairs');
    await expect(run(DEV, 'development', { shard: 2 })).rejects.toThrow('outside the matrix');
    await expect(
      runOmahaVariantStrengthShard('plo5', {
        profileId: 'p11c-plo6-6max-2dealt-100bb',
        seed: DEV,
        shard: 0,
        mode: 'development',
        pairs: 4,
      })
    ).rejects.toThrow('outside the matrix');
  });

  it.each(VARIANTS)('every development league entry point refuses %s held-out seeds', async (v) => {
    for (let i = 0; i < 3; i++) {
      const seed = holdout(v, i);
      await expect(
        runPlo4PolicyLeague({ profileId: 'heads-up-25bb', pairs: 1, seed })
      ).rejects.toThrow('Held-out Phase 11 strength seeds');
      await expect(
        runOmahaVariantLeague({ profileId: `${v}-hu-25bb`, pairs: 1, seed })
      ).rejects.toThrow('Held-out Phase 11 strength seeds');
      await expect(
        runRemainingVariantLeague({ profileId: 'unused', pairs: 1, seed })
      ).rejects.toThrow('Held-out Phase 11 strength seeds');
      await expect(runJointPolicyLeague({ profileId: 'unused', pairs: 1, seed })).rejects.toThrow(
        'Held-out Phase 11 strength seeds'
      );
      await expect(
        runPlo4StrengthShard({
          profileId: 'p10c-6max-2dealt-100bb',
          seed,
          shard: 0,
          mode: 'development',
          pairs: 4,
        })
      ).rejects.toThrow('held-out Phase 11 seed');
      await expect(
        runPlo4StrengthShard({
          profileId: 'p10c-6max-2dealt-100bb',
          seed,
          shard: 0,
          mode: 'contract',
        })
      ).rejects.toThrow('held-out Phase 11 seed');
    }
  });
});

describe('P11.2 live conditions in the harness', () => {
  type DecideOpts = { decisionTimeMs?: number; v9Mood?: boolean; phase11Omaha?: string };
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
    const profile = omahaVariantStrengthLeagueProfile('plo5', 'p11c-plo5-6max-100bb');
    expect(profile.moodClock).toBe('deal_seed_time_of_day');
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
        expect(c.opts.decisionTimeMs).toBe(omahaVariantMoodClockMs(dealSeed));
      }
      // Only the hero seat differs between the arms, and only in its pack mode.
      expect(candidate.filter((c) => c.opts.phase11Omaha === 'candidate').length).toBeGreaterThan(
        0
      );
      expect(
        candidate
          .filter((c) => c.opts.phase11Omaha === 'candidate')
          .every((c) => c.user === 'plo4-league-3')
      ).toBe(true);
      expect(reference.every((c) => c.opts.phase11Omaha === 'off')).toBe(true);
    }
  });

  it('leaves the PLO4 contract profile exactly as before: mood off at decision time 0', async () => {
    const profile = plo4StrengthLeagueProfile('p10c-6max-100bb');
    expect(profile.moodClock).toBeUndefined();
    expect(profile.variant).toBeUndefined();
    const calls = spyDecide();
    await playPlo4PolicyHand(profile, 123457, 1, 3, 'candidate', () => true, true);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.opts.v9Mood).toBe(false);
      expect(c.opts.decisionTimeMs).toBe(0);
    }
  });
});

describe('P11.2 independent checks follow the pack variant', () => {
  const config = { smallBlind: 1, bigBlind: 2 } as HandConfig;
  const seat = (n: number, cards: string, stack: number, folded = false) => ({
    seat: n,
    user_id: `p${n}`,
    username: `p${n}`,
    cards: plo4Cards(cards),
    stack,
    bet: 0,
    totalInvested: n <= 3 ? 12 : 0,
    is_folded: folded,
    is_all_in: false,
    is_sitting_out: false,
  });
  const endState = (players: ReturnType<typeof seat>[], board: string) =>
    ({
      players,
      communityCards: plo4Cards(board),
      dealerSeat: 6,
      actionHistory: [],
    }) as unknown as Parameters<typeof plo4IndependentHandChecks>[1];

  it('PLO8 settles the high and low halves; a scoop to the high hand alone is caught', () => {
    const profile = omahaVariantStrengthLeagueProfile('plo8', 'p11c-plo8-6max-100bb');
    // Seat 1: trip aces, no low. Seat 2: 7-4-3-2-A low, no pair. Seat 3 folded.
    // Pot 36, six dealt: rake 3.60, BBJ drop 0.50 (PLO8 is jackpot-eligible).
    const players = (s1: number, s2: number) => [
      seat(1, 'As Ad Ks Qd', s1),
      seat(2, '3c 4d Jc Tc', s2),
      seat(3, '9h 9d 8s 8h', 188, true),
      seat(4, '6s 6c 5d 5h', 200, true),
      seat(5, 'Qs Qh Js Jh', 200, true),
      seat(6, 'Kd Kc Th Td', 200, true),
    ];
    const board = 'Ah 2d 7c 9s Kh';
    const receipt = { rake: 3.6, bbj: 0.5 } as Plo4HandReceipt;
    const split = plo4IndependentHandChecks(
      profile,
      endState(players(188 + 15.95, 188 + 15.95), board),
      receipt,
      config
    );
    expect(split).toMatchObject({
      settlementMismatches: 0,
      deductionMismatches: 0,
      showdownChecked: true,
      lowHalfChecked: true,
    });
    const scoop = plo4IndependentHandChecks(
      profile,
      endState(players(188 + 31.9, 188), board),
      receipt,
      config
    );
    expect(scoop.settlementMismatches).toBeGreaterThan(0);
    // The PLO4 reading of the same hand (no low half) would have passed the
    // scoop: the variant, not PLO4, decides the reference.
    const asPlo4 = plo4IndependentHandChecks(
      plo4StrengthLeagueProfile('p10c-6max-100bb'),
      endState(players(188 + 31.9, 188), board),
      receipt,
      config
    );
    expect(asPlo4.settlementMismatches).toBe(0);
  });

  it('PLO6 takes no jackpot drop: a drop on a PLO6 hand is a deduction mismatch', () => {
    const profile = omahaVariantStrengthLeagueProfile('plo6', 'p11c-plo6-6max-100bb');
    const players = (s1: number) => [
      seat(1, 'As Ks 9c 8c 4h 3h', s1),
      seat(2, 'Kd Qd Jc Tc 5s 6s', 188),
      seat(3, '4s 4c 3d 3c 2c 2s', 188, true),
      seat(4, '6c 6d 5d 5h 7s 7d', 200, true),
      seat(5, '9h 9d 8s 8h Td Ts', 200, true),
      seat(6, 'Qs Qh Js Jh Qc Jd', 200, true),
    ];
    const board = 'Ah Ad 7c 7h 2h';
    const right = plo4IndependentHandChecks(
      profile,
      endState(players(188 + 32.4), board),
      { rake: 3.6, bbj: 0 } as Plo4HandReceipt,
      config
    );
    expect(right).toMatchObject({ settlementMismatches: 0, deductionMismatches: 0 });
    const dropped = plo4IndependentHandChecks(
      profile,
      endState(players(188 + 31.9), board),
      { rake: 3.6, bbj: 0.5 } as Plo4HandReceipt,
      config
    );
    expect(dropped.deductionMismatches).toBe(1);
  });

  it('the contract names the per-variant settlement and deduction references', () => {
    expect(OMAHA_VARIANT_STRENGTH_CONTRACT.softwareValidity.settlementReference).toContain(
      'plo8 settles high and low halves'
    );
    expect(PLO4_LEAGUE_SEEDS).not.toContain(DEV);
  });
});
