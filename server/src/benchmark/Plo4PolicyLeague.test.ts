import { describe, expect, it } from 'vitest';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';
import { saveFastRandom, seedFastRandom } from '../engine/HorseEval.js';
import {
  PLO4_LEAGUE_PROFILES,
  PLO4_LEAGUE_SEEDS,
  runPlo4PolicyLeague,
  plo4LeagueSeating,
} from './Plo4PolicyLeague.js';

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
