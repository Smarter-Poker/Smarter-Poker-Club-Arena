import { describe, expect, it } from 'vitest';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';
import { saveFastRandom, seedFastRandom } from '../engine/HorseEval.js';
import {
  PLO4_LEAGUE_PROFILES,
  PLO4_LEAGUE_SEEDS,
  runPlo4PolicyLeague,
  runPlo4StrengthShard,
  plo4DivergenceStreet,
  plo4IndependentHandChecks,
  plo4LeagueSeating,
  plo4StrengthLeagueProfile,
  type Plo4HandReceipt,
} from './Plo4PolicyLeague.js';
import { PLO4_STRENGTH_CONTRACT, plo4StrengthShardReasons } from './Plo4StrengthContract.js';
import { plo4Cards } from './Plo4PolicyEvidence.js';
import type { HandConfig } from '../types.js';

describe('Phase 10 paired whole-hand PLO4 league', () => {
  it('pairs identical baseline policies without changing the caller RNG', async () => {
    seedFastRandom(111009);
    const before = saveFastRandom();
    const result = await runPlo4PolicyLeague({
      profileId: 'heads-up-25bb',
      pairs: 2,
      seed: PLO4_LEAGUE_SEEDS[0],
      mode: 'off',
    });
    expect(result.complete).toBe(true);
    expect(result.meanAfterRakeDifferenceBbPerHand).toBe(0);
    expect(
      result.pairs.every((p) => JSON.stringify(p.candidate.net) === JSON.stringify(p.baseline.net))
    ).toBe(true);
    expect(
      result.illegalActions + result.conservationErrors + result.cardErrors + result.truncatedHands
    ).toBe(0);
    expect(saveFastRandom()).toBe(before);
  });
  it.each(PLO4_LEAGUE_PROFILES.map((p) => p.id))(
    '%s completes legal, conserved and repeatable paired hands',
    async (profileId) => {
      const options = { profileId, pairs: 1, seed: PLO4_LEAGUE_SEEDS[1] };
      const first = await runPlo4PolicyLeague(options),
        second = await runPlo4PolicyLeague(options);
      expect(first.complete).toBe(true);
      expect(second).toEqual(first);
      expect(
        first.illegalActions + first.conservationErrors + first.cardErrors + first.truncatedHands
      ).toBe(0);
      expect(first.promotionEligible).toBe(false);
      expect(first.confidence99[0]).toBeLessThan(0);
      expect(first.confidence99[1]).toBeGreaterThan(0);
      for (const pair of first.pairs)
        for (const hand of [pair.candidate, pair.baseline])
          expect(hand.net.reduce((sum, n) => sum + n, 0) + hand.rake + hand.bbj).toBeCloseTo(0, 8);
      if (profileId.startsWith('tournament')) {
        expect(first.pairs.some((p) => p.candidate.eligible > 0)).toBe(true);
        expect(first.metricScope).toContain('not_tournament_prize_ev');
      }
    },
    30000
  );
  it('returns incomplete evidence when interrupted and rejects unbounded input', async () => {
    const options = { profileId: 'heads-up-25bb', pairs: 1, seed: 10 };
    const result = await runPlo4PolicyLeague(options, () => false);
    expect(result.complete).toBe(false);
    expect(result.completedPairs).toBe(0);
    expect(result.meanAfterRakeDifferenceBbPerHand).toBeNull();
    await expect(runPlo4PolicyLeague({ ...options, pairs: 33 })).rejects.toThrow('Invalid bounded');
    await expect(runPlo4PolicyLeague({ ...options, profileId: 'unknown' })).rejects.toThrow(
      'Invalid bounded'
    );
  });
});

describe('Phase 10 audit regressions', () => {
  it('refuses an inert sample override instead of presenting it as benchmark work', async () => {
    const unsupported = { profileId: 'heads-up-25bb', pairs: 1, seed: 10101101, samples: 16 };
    await expect(runPlo4PolicyLeague(unsupported)).rejects.toThrow('sample overrides');
  });
  it('covers every dealer-relative position, pairing identical seats and cards', () => {
    for (let seats = 2; seats <= 8; seats++) {
      const rotation = Array.from({ length: seats }, (_, i) => plo4LeagueSeating(i, seats));
      expect(new Set(rotation.map((r) => r.relativePosition)).size).toBe(seats);
      expect(
        new Set(
          Array.from({ length: seats * seats }, (_, i) => {
            const r = plo4LeagueSeating(i, seats);
            return r.heroSeat + '/' + r.button;
          })
        ).size
      ).toBe(seats * seats);
    }
  });
  it('refuses load-scaled evidence instead of silently changing the benchmark budget', async () => {
    try {
      equityGovernor.__setScaleForTest(0.1);
      await expect(
        runPlo4PolicyLeague({ profileId: 'heads-up-25bb', pairs: 1, seed: 10101101 })
      ).rejects.toThrow('EQUITY_GOVERNOR=off');
    } finally {
      equityGovernor.__setScaleForTest(null);
    }
    const fixed = await runPlo4PolicyLeague({
      profileId: 'heads-up-25bb',
      pairs: 2,
      seed: 10101101,
    });
    expect(fixed.fixedWork.scale).toBe(1);
    expect(fixed.fixedWork.governor).toBe('off');
    expect(fixed.relativePositions).toEqual([0, 1]);
  });
});

describe('P10.2 contract shard machinery', () => {
  const holdout = PLO4_STRENGTH_CONTRACT.holdout.seeds[0];
  it('keeps held-out seeds out of every development league and runner', async () => {
    await expect(
      runPlo4PolicyLeague({ profileId: 'heads-up-25bb', pairs: 1, seed: holdout })
    ).rejects.toThrow('Held-out PLO4 strength seeds');
    await expect(
      runPlo4StrengthShard({
        profileId: 'p10c-6max-2dealt-100bb',
        seed: holdout,
        shard: 0,
        mode: 'development',
        pairs: 4,
      })
    ).rejects.toThrow('never runs a held-out seed');
    await expect(
      runPlo4StrengthShard({
        profileId: 'p10c-6max-2dealt-100bb',
        seed: PLO4_LEAGUE_SEEDS[0],
        shard: 0,
        mode: 'contract',
      })
    ).rejects.toThrow('only a held-out seed');
    await expect(
      runPlo4StrengthShard({
        profileId: 'p10c-6max-2dealt-100bb',
        seed: holdout,
        shard: 0,
        mode: 'contract',
        pairs: 4,
      })
    ).rejects.toThrow('exactly the contract pairs');
    await expect(
      runPlo4StrengthShard({
        profileId: 'p10c-6max-2dealt-100bb',
        seed: PLO4_LEAGUE_SEEDS[0],
        shard: 2,
        mode: 'development',
        pairs: 4,
      })
    ).rejects.toThrow('outside the matrix');
  });

  it('plays published-price paired hands with independent settlement checks, repeatably', async () => {
    const request = {
      profileId: 'p10c-6max-100bb',
      seed: PLO4_LEAGUE_SEEDS[0],
      shard: 1,
      mode: 'development' as const,
      pairs: 36,
    };
    const first = await runPlo4StrengthShard(request);
    const second = await runPlo4StrengthShard(request);
    expect({ ...second, durationMs: 0 }).toEqual({ ...first, durationMs: 0 });
    expect(first.complete).toBe(true);
    expect(first.positionCoverageComplete).toBe(true);
    expect(first.offsetCounts).toEqual([6, 6, 6, 6, 6, 6]);
    expect(first.firstPair).toBe(PLO4_STRENGTH_CONTRACT.matrix.pairsPerShard);
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
    expect(Object.values(first.strata).reduce((s, v) => s + v.n, 0)).toBe(36);
    // A development shard can never enter the verdict.
    expect(plo4StrengthShardReasons(first)).toEqual(
      expect.arrayContaining([
        'p10c-6max-100bb-10101101-s1:not_contract_mode',
        'p10c-6max-100bb-10101101-s1:not_holdout_seed',
        'p10c-6max-100bb-10101101-s1:pairs_below_contract',
      ])
    );
    expect(first.promotionEligible).toBe(false);
  }, 60000);

  it('names the street where two arms first part', () => {
    const a = ['1:raise:4:preflop', '2:call:4:preflop', '2:check:0:flop', '1:bet:6:flop'];
    expect(plo4DivergenceStreet(a, a)).toBe('none');
    expect(plo4DivergenceStreet(a, [...a.slice(0, 3), '1:check:0:flop'])).toBe('flop');
    expect(plo4DivergenceStreet(a, ['1:fold:0:preflop'])).toBe('preflop');
    expect(plo4DivergenceStreet(a, [...a, '2:call:6:turn'])).toBe('turn');
  });

  it('catches a settlement paid to the wrong seat and a wrong rake', () => {
    const profile = plo4StrengthLeagueProfile('p10c-6max-100bb');
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
    // Seat 1 makes trip aces, seat 2 one pair of aces; seat 3 folded after investing.
    const board = plo4Cards('Ah Ad 7c 7s 2h');
    const end = (stacks: number[]) =>
      ({
        players: [
          seat(1, 'As Ks 9c 8c', stacks[0]),
          seat(2, 'Kd Qd Jc Tc', stacks[1]),
          seat(3, '4s 4c 3d 3h', stacks[2], true),
          seat(4, '6s 6c 5d 5h', 200, true),
          seat(5, '9h 9d 8s 8h', 200, true),
          seat(6, 'Qs Qh Js Jh', 200, true),
        ],
        communityCards: board,
        dealerSeat: 6,
        actionHistory: [],
      }) as unknown as Parameters<typeof plo4IndependentHandChecks>[1];
    // Pot 36, six dealt at six-max: rake 3.60 (10%, under the 5.00 cap), BBJ drop 0.50.
    const receipt = { rake: 3.6, bbj: 0.5 } as Plo4HandReceipt;
    const right = plo4IndependentHandChecks(
      profile,
      end([200 - 12 + 31.9, 188, 188]),
      receipt,
      config
    );
    expect(right).toMatchObject({
      settlementMismatches: 0,
      deductionMismatches: 0,
      showdownChecked: true,
    });
    const wrongSeat = plo4IndependentHandChecks(
      profile,
      end([188, 200 - 12 + 31.9, 188]),
      receipt,
      config
    );
    expect(wrongSeat.settlementMismatches).toBeGreaterThan(0);
    const wrongRake = plo4IndependentHandChecks(
      profile,
      end([200 - 12 + 31.4, 188, 188]),
      { rake: 4.1, bbj: 0.5 } as Plo4HandReceipt,
      config
    );
    expect(wrongRake.deductionMismatches).toBe(1);
  });
});
