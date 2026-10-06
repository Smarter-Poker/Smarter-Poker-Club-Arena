import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic } from '../engine/HorseLogic.js';
import type { Card } from '../types.js';
import { jointStrengthLeagueProfile, runJointStrengthShard } from './JointStrengthLeague.js';
import {
  JOINT_STRENGTH_VARIANTS,
  jointMoodClockMs,
  jointStrengthPack,
  jointStrengthShardReasons,
  type JointStrengthVariant,
} from './JointStrengthContract.js';
import {
  jointDivergenceStreet,
  jointIndependentHandChecks,
  type JointEndState,
} from './JointStrengthChecks.js';
import { runPlo4PolicyLeague, runPlo4StrengthShard } from './Plo4PolicyLeague.js';
import { PLO4_STRENGTH_CONTRACT } from './Plo4StrengthContract.js';
import {
  omahaVariantMoodClockMs,
  omahaVariantStrengthPack,
} from './OmahaVariantStrengthContract.js';
import { runOmahaVariantStrengthShard } from './OmahaVariantStrengthLeague.js';
import { remainingVariantStrengthPack } from './RemainingVariantStrengthContract.js';
import { runRemainingVariantStrengthShard } from './RemainingVariantStrengthLeague.js';
import { runOmahaVariantLeague } from './OmahaVariantPolicyLeague.js';
import { runRemainingVariantLeague } from './RemainingVariantPolicyLeague.js';
import { JOINT_LEAGUE_SEEDS, runJointPolicyLeague } from './JointPolicyLeague.js';
import { plo4Cards } from './Plo4PolicyEvidence.js';

const DEV = JOINT_LEAGUE_SEEDS[0];
const holdout = (v: JointStrengthVariant, i = 0) => jointStrengthPack(v).holdout.seeds[i];
const VALIDITY = [
  'illegalActions',
  'conservationErrors',
  'cardErrors',
  'truncatedHands',
  'settlementMismatches',
  'deductionMismatches',
  'pairedReplayMismatches',
  'illegalCandidates',
  'earlierPhaseRefusals',
] as const;

afterEach(() => vi.restoreAllMocks());

describe('P13.2 development shards: legal, conserved and independently settled', () => {
  it('a two-board NLH bomb shard and a three-dealt PLO8 shard complete balanced with zero mismatches, and replay', async () => {
    for (const [variant, profileId, pairs] of [
      ['nlh', 'p13c-nlh-bomb2-6max-100bb', 6],
      ['plo8', 'p13c-plo8-3dealt-100bb', 6],
    ] as const) {
      const run = () =>
        runJointStrengthShard(variant, {
          profileId,
          seed: DEV,
          shard: 0,
          mode: 'development',
          pairs,
        });
      const r = await run();
      expect(r.complete, JSON.stringify(r)).toBe(true);
      expect(r.positionCoverageComplete).toBe(true);
      for (const field of VALIDITY) expect(r[field], field).toBe(0);
      expect(r.eligible).toBeGreaterThan(0);
      expect(r.fired).toBeGreaterThan(0);
      expect(r.showdownsChecked + r.foldWinsChecked).toBe(2 * pairs);
      expect(r.discards).toBe(0);
      expect(r.fixedWork).toEqual({
        governor: 'off',
        scale: 1,
        policyClock: 'phase13_evidence_mode_fixed_clock',
        moodClock: 'deal_seed_time_of_day',
      });
      if (variant === 'nlh') {
        expect(r.multiBoardShowdownsChecked).toBeGreaterThan(0);
        expect(Object.keys(r.eligibleByBoards)).toEqual(['2']);
      }
      // A development shard is refused by the contract by name.
      expect(jointStrengthShardReasons(variant, r)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/:not_contract_mode$/),
          expect.stringMatching(/:not_holdout_seed$/),
        ])
      );
      const again = await run();
      expect({ ...again, durationMs: 0 }).toEqual({ ...r, durationMs: 0 });
    }
  }, 120_000);
});

describe('P13.2 held-out seeds', () => {
  it('refuses held-out seeds in development mode and development seeds in contract mode', async () => {
    const profileId = 'p13c-flh-3dealt-100bb';
    const run = (seed: number, mode: 'contract' | 'development', extra = {}) =>
      runJointStrengthShard('flh', { profileId, seed, shard: 0, mode, pairs: 3, ...extra });
    for (const seed of [
      holdout('flh'),
      holdout('nlh'),
      remainingVariantStrengthPack('flh').holdout.seeds[0],
      omahaVariantStrengthPack('plo5').holdout.seeds[0],
      PLO4_STRENGTH_CONTRACT.holdout.seeds[0],
    ])
      await expect(run(seed, 'development')).rejects.toThrow('never runs a held-out seed');
    await expect(run(DEV, 'contract', { pairs: undefined })).rejects.toThrow(
      "its own variant's held-out seeds"
    );
    // Another variant's held-out seed is not this variant's.
    await expect(run(holdout('nlh'), 'contract', { pairs: undefined })).rejects.toThrow(
      "its own variant's held-out seeds"
    );
    await expect(run(holdout('flh'), 'contract')).rejects.toThrow('exactly the contract pairs');
    await expect(run(DEV, 'development', { shard: 999 })).rejects.toThrow('outside the matrix');
    await expect(
      runJointStrengthShard('flh', {
        profileId: 'p13c-flo8-3dealt-100bb',
        seed: DEV,
        shard: 0,
        mode: 'development',
        pairs: 3,
      })
    ).rejects.toThrow('outside the matrix');
  });

  it('every development entry point refuses every Phase 13 held-out seed', async () => {
    for (const v of JOINT_STRENGTH_VARIANTS)
      for (let i = 0; i < 3; i++) {
        const seed = holdout(v, i);
        for (const run of [
          () => runPlo4PolicyLeague({ profileId: 'heads-up-25bb', pairs: 1, seed }),
          () => runOmahaVariantLeague({ profileId: 'plo5-hu-25bb', pairs: 1, seed }),
          () => runRemainingVariantLeague({ profileId: 'flh-hu-25bb', pairs: 1, seed }),
          () => runJointPolicyLeague({ profileId: 'unused', pairs: 1, seed }),
        ])
          await expect(run()).rejects.toThrow('Held-out Phase 13 strength seeds');
        for (const mode of ['development', 'contract'] as const)
          await expect(
            runPlo4StrengthShard({
              profileId: 'p10c-6max-2dealt-100bb',
              seed,
              shard: 0,
              mode,
              ...(mode === 'development' ? { pairs: 4 } : {}),
            })
          ).rejects.toThrow('held-out Phase 13 seed');
        await expect(
          runOmahaVariantStrengthShard('plo5', {
            profileId: 'p11c-plo5-6max-2dealt-100bb',
            seed,
            shard: 0,
            mode: 'development',
            pairs: 4,
          })
        ).rejects.toThrow('never runs a held-out seed');
        await expect(
          runRemainingVariantStrengthShard('flh', {
            profileId: 'p12c-flh-6max-2dealt-100bb',
            seed,
            shard: 0,
            mode: 'development',
            pairs: 4,
          })
        ).rejects.toThrow('never runs a held-out seed');
      }
  });
});

describe('P13.2 harness conditions', () => {
  type DecideOpts = {
    decisionTimeMs?: number;
    v9Mood?: boolean;
    phase13Joint?: string;
    phase13EvidenceMode?: boolean;
    phase10Plo4?: string;
    phase11Omaha?: string;
    phase12Remaining?: string;
  };
  it('plays the candidate at the hero seat only, on the fixed clock, with mood on the deal-seed clock and every earlier phase off', async () => {
    const calls: { user: string; opts: DecideOpts }[] = [];
    const original = HorseLogic.decide.bind(HorseLogic);
    vi.spyOn(HorseLogic, 'decide').mockImplementation(((
      ...args: Parameters<typeof HorseLogic.decide>
    ) => {
      calls.push({ user: args[0].user_id, opts: (args[4] ?? {}) as DecideOpts });
      return original(...args);
    }) as typeof HorseLogic.decide);
    await runJointStrengthShard('nlh', {
      profileId: 'p13c-nlh-3dealt-100bb',
      seed: DEV,
      shard: 0,
      mode: 'development',
      pairs: 1,
    });
    const dealSeed = (DEV ^ Math.imul(1, 2654435761)) >>> 0 || 1;
    expect(jointMoodClockMs(dealSeed)).toBe(omahaVariantMoodClockMs(dealSeed));
    const hero = 'plo4-league-1';
    expect(calls.length).toBeGreaterThan(0);
    for (const { user, opts } of calls) {
      expect(opts.decisionTimeMs).toBe(jointMoodClockMs(dealSeed));
      expect(opts.v9Mood).toBe(true);
      expect(opts.phase13EvidenceMode).toBe(true);
      expect([opts.phase10Plo4, opts.phase11Omaha, opts.phase12Remaining]).toEqual([
        'off',
        'off',
        'off',
      ]);
      if (user !== hero) expect(opts.phase13Joint).toBe('off');
    }
    const heroModes = calls.filter((c) => c.user === hero).map((c) => c.opts.phase13Joint);
    expect(heroModes).toContain('candidate');
    expect(heroModes).toContain('off');
  });

  it('builds a published-pricing joint league profile with the bomb configuration', () => {
    const bomb = jointStrengthLeagueProfile('plo4', 'p13c-plo4-bomb3-6max-100bb');
    expect(bomb).toMatchObject({
      variant: 'plo4',
      jointPolicy: true,
      seats: 6,
      tableSeats: 6,
      stackBB: 100,
      publishedRake: true,
      productionStyles: true,
      moodClock: 'deal_seed_time_of_day',
      asset: 'chips',
      bombBoards: 3,
      tournament: false,
    });
    expect(jointStrengthLeagueProfile('plo4', 'p13c-plo4-6max-100bb').bombBoards).toBeUndefined();
    expect(jointStrengthLeagueProfile('nlh', 'p13c-nlh-9max-100bb').tableSeats).toBe(9);
    expect(() => jointStrengthLeagueProfile('nlh', 'p13c-plo4-6max-100bb')).toThrow(
      'Unknown P13.2 strength profile'
    );
  });
});

describe('P13.2 independent checks read every board', () => {
  const config = { smallBlind: 1, bigBlind: 2 };
  const seat = (n: number, cards: string, stack: number, folded = false) => ({
    seat: n,
    user_id: `p${n}`,
    cards: plo4Cards(cards),
    stack,
    totalInvested: n <= 3 ? 12 : 0,
    is_folded: folded,
    is_sitting_out: false,
  });
  const end = (
    players: ReturnType<typeof seat>[],
    boards: string[],
    actionHistory: JointEndState['actionHistory'] = []
  ): JointEndState => ({
    players,
    communityCards: plo4Cards(boards[0]),
    communityCards2: boards[1] ? plo4Cards(boards[1]) : [],
    communityCards3: boards[2] ? plo4Cards(boards[2]) : [],
    dealerSeat: 6,
    actionHistory,
  });
  const check = (
    variant: JointStrengthVariant,
    state: JointEndState,
    boardCount: number,
    rake = 3.6,
    bbj = 0.5,
    knownDeadCards: Card[] = []
  ) =>
    jointIndependentHandChecks(variant, {
      end: state,
      startStack: 200,
      rake,
      bbj,
      config,
      publishedRake: true,
      tableSeats: 6,
      boardCount,
      knownDeadCards,
    });
  // Seat 1 wins board one (trip aces), seat 2 board two (trip kings); seat 3
  // folded. Pot 36, six dealt: rake 3.60, BBJ drop 0.50, 31.90 split by board.
  const players = (s1: number, s2: number) => [
    seat(1, 'As Ah', s1),
    seat(2, 'Kd Kc', s2),
    seat(3, 'Th Td', 188, true),
    seat(4, 'Qh Qd', 200, true),
    seat(5, '6h 6d', 200, true),
    seat(6, 'Jh Jd', 200, true),
  ];
  const boards = ['Ac 7d 2h 9s 4c', 'Ks 8d 3h Jc 5s'];

  it('settles a two-board hand board by board; a scoop of both boards is caught', () => {
    const right = check('nlh', end(players(188 + 15.95, 188 + 15.95), boards), 2);
    expect(right).toMatchObject({
      settlementMismatches: 0,
      deductionMismatches: 0,
      showdownChecked: true,
      multiBoardChecked: true,
    });
    expect(
      check('nlh', end(players(188 + 31.9, 188), boards), 2).settlementMismatches
    ).toBeGreaterThan(0);
    // Read as one board, the same hand pays seat 1 alone; the controller's split is then wrong.
    expect(
      check('nlh', end(players(188 + 15.95, 188 + 15.95), boards), 1).settlementMismatches
    ).toBeGreaterThan(0);
  });

  it('refuses a dealt board beyond the activated count and a wrong deduction', () => {
    const extra = end(players(188 + 15.95, 188 + 15.95), [...boards, 'Qs Qc 8h 8c 9d']);
    expect(check('nlh', extra, 2).settlementMismatches).toBe(1);
    // NLH drops the jackpot fee on a six-dealt hand that saw a flop.
    expect(
      check('nlh', end(players(188 + 16.2, 188 + 16.2), boards), 2, 3.6, 0).deductionMismatches
    ).toBe(1);
    // PLO6 is not covered by the jackpot: no drop is the right deduction.
    const plo6 = check(
      'plo6',
      end(
        [
          seat(1, 'As Ah 2c 3c 4h 5h', 188 + 16.2),
          seat(2, 'Kd Kc 2d 3d 4d 5d', 188 + 16.2),
          seat(3, 'Th Td 6c 7c 8c 9c', 188, true),
          seat(4, 'Qh Qd 6s 7s 8s 9h', 200, true),
          seat(5, 'Jh Jd Tc Ts 9d 8d', 200, true),
          seat(6, '6h 6d 7h Qs 2s 3s', 200, true),
        ],
        ['Ac 7d 2h 9s 4c', 'Ks 8h 3h Jc 5s']
      ),
      2,
      3.6,
      0
    );
    expect(plo6.deductionMismatches).toBe(0);
  });

  it('a Pineapple discard divergence belongs to the flop; an unknown stage refuses', () => {
    expect(jointDivergenceStreet(['1:discard:0:pineapple_discard'], ['1:check:0:flop'])).toBe(
      'flop'
    );
    expect(jointDivergenceStreet(['1:bet:4:turn'], ['1:check:0:turn'])).toBe('turn');
    expect(jointDivergenceStreet(['1:fold:0:preflop'], ['1:fold:0:preflop'])).toBe('none');
    expect(() => jointDivergenceStreet(['1:bet:4:showdown'], ['1:check:0:showdown'])).toThrow(
      'Unknown divergence stage'
    );
  });
});
