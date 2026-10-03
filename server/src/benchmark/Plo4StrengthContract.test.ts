import { describe, expect, it } from 'vitest';
import {
  PLO4_STRENGTH_CONTRACT,
  Plo4PowerAccumulator,
  isPlo4HoldoutSeed,
  plo4CellStatistic,
  plo4StrengthContractDigest,
  plo4StrengthRequiredShards,
  plo4StrengthSeatStyle,
  plo4StrengthShardReasons,
  summarizePlo4Strength,
  PRODUCTION_HORSE_STYLES,
  type Plo4StrengthShardResult,
} from './Plo4StrengthContract.js';
import { PLO4_LEAGUE_SEEDS } from './Plo4PolicyLeague.js';
import { TOURNAMENT_PROMOTION_SEEDS } from './HorseTournamentLeague.js';
import { PLO4_POLICY_PACK } from '../engine/plo4/Plo4PolicyPack.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { CASH_MAX_BB, CASH_MIN_BB } from '../config/cashBuyIn.js';

const C = PLO4_STRENGTH_CONTRACT;
const profileOf = (id: string) => C.matrix.profiles.find((p) => p.id === id)!;

/** A contract-mode shard whose every offset has the same value mix:
 * half the pairs identical (none), a quarter +win and a quarter -loss on `street`. */
function shard(
  profileId: string,
  seed: number,
  index: number,
  values: { win: number; loss: number; street?: string; offsetShift?: (o: number) => number } = {
    win: 1200,
    loss: 1000,
  }
): Plo4StrengthShardResult {
  const p = profileOf(profileId);
  const perOffset = C.matrix.pairsPerShard / p.seats;
  const strata: Plo4StrengthShardResult['strata'] = {};
  for (let o = 0; o < p.seats; o++) {
    const none = new Plo4PowerAccumulator();
    const moved = new Plo4PowerAccumulator();
    const shift = values.offsetShift?.(o) ?? 0;
    for (let i = 0; i < perOffset / 2; i++) none.add(0);
    for (let i = 0; i < perOffset / 4; i++) moved.add(values.win + shift);
    for (let i = 0; i < perOffset / 4; i++) moved.add(-values.loss + shift);
    strata[`${o}|none`] = none.toJSON();
    strata[`${o}|${values.street ?? 'flop'}`] = moved.toJSON();
  }
  return {
    schema: 'horse-phase10-strength-shard-v1',
    contractVersion: C.version,
    contractDigest: plo4StrengthContractDigest(),
    packVersion: PLO4_POLICY_PACK.version,
    evidenceMode: 'contract',
    profileId,
    seed,
    shard: index,
    firstPair: index * C.matrix.pairsPerShard,
    requestedPairs: C.matrix.pairsPerShard,
    pairs: C.matrix.pairsPerShard,
    complete: true,
    positionCoverageComplete: true,
    offsetCounts: Array(p.seats).fill(perOffset),
    strata,
    pairDigest: 'd'.repeat(64),
    candidateNetCents: 0,
    referenceNetCents: 0,
    changedPairs: C.matrix.pairsPerShard / 2,
    decisions: 1,
    eligible: 1,
    changed: 1,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncatedHands: 0,
    settlementMismatches: 0,
    deductionMismatches: 0,
    pairedReplayMismatches: 0,
    showdownsChecked: 1,
    foldWinsChecked: 1,
    totalRake: 0,
    totalBbj: 0,
    nodeCounts: {},
    reasons: {},
    equityWork: {},
    fixedWork: { governor: 'off', scale: 1, policyClock: 'fixed_work_no_wall_clock_branch' },
    durationMs: 1,
    promotionEligible: false,
  };
}
const fullMatrix = (make = shard) =>
  plo4StrengthRequiredShards().map((s) => make(s.profileId, s.seed, s.shard));

describe('P10.2 PLO4 strength contract object', () => {
  it('is versioned, deeply immutable and bound by a stable digest', () => {
    expect(C.version).toBe('plo4-strength-contract-v1');
    expect(plo4StrengthContractDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(plo4StrengthContractDigest()).toBe(plo4StrengthContractDigest());
    expect(Object.isFrozen(C)).toBe(true);
    expect(Object.isFrozen(C.thresholds.nonregression)).toBe(true);
    expect(Object.isFrozen(C.matrix.profiles[0])).toBe(true);
    expect(() => {
      (C.thresholds.primary as { lowerBoundAboveBbPer100: number }).lowerBoundAboveBbPer100 = -1;
    }).toThrow();
    expect(C.promotionEligible).toBe(false);
    expect(C.candidate.packVersion).toBe(PLO4_POLICY_PACK.version);
    expect(C.candidate.calibratedConfidence).toBeNull();
  });

  it('separates the cash objective from the tournament objective, which refuses by name', () => {
    expect(C.objectives.cash.status).toBe('measured');
    expect(C.objectives.tournament.status).toBe('unavailable dependency');
    expect(C.objectives.tournament.refusals).toEqual([
      'tournament:plo4_whole_tournament_outcome_model_unavailable',
      'tournament:qualified_plo4_tournament_reference_population_unavailable',
      'tournament:plo4_tournament_thresholds_not_specified',
    ]);
    const verdict = summarizePlo4Strength(fullMatrix());
    expect(verdict.tournament).toEqual({
      status: 'unavailable dependency',
      qualified: false,
      reasons: C.objectives.tournament.refusals,
    });
    expect(C.notStrengthGates).toEqual(
      expect.arrayContaining(['atlas coordinate count', 'changed proposal count'])
    );
  });

  it('takes its population from the engine pricing, buy-in band, seat cap and style roster', () => {
    const full = getFullRakeConfig(1, 2, 'plo4');
    expect(C.population.rake.percent).toBe(full.rakePercent);
    expect(C.population.rake.cap).toBe(full.rakeCap);
    expect(C.population.rake.playerCountCaps[6]).toEqual(getPlayerCountCaps(full.rakeCap, 6));
    expect(C.population.bbj.feeBB).toBe(full.bbjFeeBB);
    expect(C.population.buyInBandBB).toEqual([CASH_MIN_BB, CASH_MAX_BB]);
    expect(C.population.maxSeats).toBe(8);
    expect(C.matrix.profiles.map((p) => p.stackBB).sort((a, b) => a - b)).toEqual([
      CASH_MIN_BB,
      100,
      100,
      100,
      CASH_MAX_BB,
    ]);
    expect([...PRODUCTION_HORSE_STYLES].sort()).toEqual(
      ['balanced', 'grinder', 'lag', 'tag', 'tricky'].sort()
    );
    const seen = new Set<string>();
    for (let seed = 1; seed < 200; seed++) seen.add(plo4StrengthSeatStyle(seed, (seed % 8) + 1));
    expect(seen.size).toBe(5);
    expect(plo4StrengthSeatStyle(777, 3)).toBe(plo4StrengthSeatStyle(777, 3));
  });

  it('holds out seeds no development league or other contract uses', () => {
    expect([...C.holdout.developmentSeeds]).toEqual([...PLO4_LEAGUE_SEEDS]);
    for (const seed of C.holdout.seeds) {
      expect(isPlo4HoldoutSeed(seed)).toBe(true);
      expect(PLO4_LEAGUE_SEEDS).not.toContain(seed);
      expect(TOURNAMENT_PROMOTION_SEEDS as readonly number[]).not.toContain(seed);
    }
    for (const seed of PLO4_LEAGUE_SEEDS) expect(isPlo4HoldoutSeed(seed)).toBe(false);
    // No held-out deal seed repeats a development deal seed in the first 32 pairs.
    const deal = (seed: number, i: number) => (seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
    const dev = new Set(
      PLO4_LEAGUE_SEEDS.flatMap((s) => Array.from({ length: 32 }, (_, i) => deal(s, i)))
    );
    for (const seed of C.holdout.seeds)
      for (let i = 0; i < 4096; i++) expect(dev.has(deal(seed, i))).toBe(false);
  });

  it('locks a matrix whose shards cover every position equally', () => {
    const required = plo4StrengthRequiredShards();
    expect(required).toHaveLength(C.matrix.requiredShards);
    expect(C.matrix.requiredShards).toBe(111);
    expect(new Set(required.map((r) => r.key)).size).toBe(required.length);
    for (const p of C.matrix.profiles) {
      expect(C.matrix.pairsPerShard % (p.seats * p.seats)).toBe(0);
      expect(C.matrix.pairsPerProfile[p.id]).toBe(p.shards * C.matrix.pairsPerShard * 3);
      expect(p.seats).toBeLessThanOrEqual(p.tableSeats);
    }
  });
});

describe('P10.2 interval and verdict', () => {
  it('computes the stratified mean, standard error and 99% interval exactly as stated', () => {
    const a = new Plo4PowerAccumulator();
    const b = new Plo4PowerAccumulator();
    const xs = [100, -40, 0, 0, 260, -80];
    const ys = [10, 30, -20, 0];
    xs.forEach((x) => a.add(x));
    ys.forEach((y) => b.add(y));
    const group = (id: string, acc: Plo4PowerAccumulator) => {
      const j = acc.toJSON();
      return {
        profileId: id,
        weight: 0.5,
        n: j.n,
        s1: BigInt(j.s1),
        s2: BigInt(j.s2),
        s3: BigInt(j.s3),
      };
    };
    const stat = plo4CellStatistic('t', [group('x', a), group('y', b)]);
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    const variance = (v: number[]) =>
      v.reduce((s, x) => s + (x - mean(v)) ** 2, 0) / (v.length - 1);
    const t = 0.5 * mean(xs) + 0.5 * mean(ys);
    const se = Math.sqrt(0.25 * (variance(xs) / xs.length) + 0.25 * (variance(ys) / ys.length));
    expect(stat.meanBbPer100).toBeCloseTo(t / 2, 10);
    expect(stat.standardErrorBbPer100).toBeCloseTo(se / 2, 10);
    expect(stat.confidence99BbPer100[0]).toBeCloseTo((t - 2.5758293035489004 * se) / 2, 10);
    // Tiny samples are never trusted.
    expect(stat.intervalTrusted).toBe(false);
  });

  it('qualifies cash only when every gate passes, and names every failure', () => {
    const pass = summarizePlo4Strength(fullMatrix());
    expect(pass.reasons).toEqual([]);
    expect(pass.qualified).toBe(true);
    expect(pass.cash.primary!.confidence99BbPer100[0]).toBeGreaterThan(0);
    expect(pass.cash.positions.map((p) => p.cell)).toEqual([
      'position:button',
      'position:small_blind',
      'position:big_blind',
      'position:cutoff',
      'position:middle',
      'position:early',
    ]);
    expect(pass.cash.noDivergenceContributionBbPer100).toBe(0);
    // The street contributions and the no-divergence pairs sum to the primary.
    const sum = pass.cash.streetFamilies.reduce((s, c) => s + c.meanBbPer100, 0);
    expect(sum).toBeCloseTo(pass.cash.primary!.meanBbPer100, 8);
    expect(pass.promotionEligible).toBe(false);
  });

  it('refuses a missing, duplicate or invalid shard and a non-contract run', () => {
    const shards = fullMatrix();
    const dropped = summarizePlo4Strength(shards.slice(1));
    expect(dropped.qualified).toBe(false);
    expect(dropped.reasons).toContain(`${plo4StrengthRequiredShards()[0].key}:missing_shard`);
    const duplicated = summarizePlo4Strength([...shards, shards[0]]);
    expect(duplicated.reasons).toContain(`${plo4StrengthRequiredShards()[0].key}:duplicate_shard`);
    const broken = fullMatrix();
    broken[3] = { ...broken[3], illegalActions: 1, settlementMismatches: 2 };
    broken[4] = { ...broken[4], evidenceMode: 'development' };
    broken[5] = { ...broken[5], contractDigest: '0'.repeat(64) };
    const verdict = summarizePlo4Strength(broken);
    expect(verdict.qualified).toBe(false);
    const k = (i: number) => plo4StrengthRequiredShards()[i].key;
    expect(verdict.reasons).toEqual(
      expect.arrayContaining([
        `${k(3)}:illegalActions`,
        `${k(3)}:settlementMismatches`,
        `${k(4)}:not_contract_mode`,
        `${k(5)}:contract_digest_mismatch`,
      ])
    );
  });

  it('refuses an identical trace with a nonzero difference and an unbalanced shard', () => {
    const s = shard('p10c-6max-2dealt-100bb', C.holdout.seeds[0], 0);
    const bad = {
      ...s,
      strata: { ...s.strata, '0|none': { ...s.strata['0|none'], s1: '5', s2: '25' } },
    };
    expect(plo4StrengthShardReasons(bad)).toContain(
      'p10c-6max-2dealt-100bb-10201109-s0:paired_replay_mismatch'
    );
    const unbalanced = { ...s, offsetCounts: [s.offsetCounts[0] + 1, s.offsetCounts[1] - 1] };
    expect(plo4StrengthShardReasons(unbalanced)).toContain(
      'p10c-6max-2dealt-100bb-10201109-s0:position_coverage_unbalanced'
    );
  });

  it('fails nonregression for a losing position even when the pool wins', () => {
    // Big blind (offset 2 at six/eight-max, offset 1 heads-up) loses 40 bb/100;
    // every other offset wins.
    const verdict = summarizePlo4Strength(
      fullMatrix((profileId, seed, index) => {
        const seats = profileOf(profileId).seats;
        const bb = seats === 2 ? 1 : 2;
        return shard(profileId, seed, index, {
          win: 1200,
          loss: 1000,
          offsetShift: (o) => (o === bb ? -300 : 0),
        });
      })
    );
    expect(verdict.qualified).toBe(false);
    expect(verdict.reasons).toContain('cash:position:big_blind:regression_margin_exceeded');
    expect(verdict.cash.primary!.confidence99BbPer100[0]).toBeGreaterThan(0);
  });

  it('fails the primary gate and seed replication when the candidate does not win', () => {
    const verdict = summarizePlo4Strength(
      fullMatrix((profileId, seed, index) =>
        shard(profileId, seed, index, {
          win: 1000,
          loss: seed === C.holdout.seeds[1] ? 1100 : 1000,
        })
      )
    );
    expect(verdict.qualified).toBe(false);
    expect(verdict.reasons).toContain('cash:primary:lower_bound_not_above_zero');
    expect(verdict.reasons).toContain(
      `cash:seed:${C.holdout.seeds[1]}:point_estimate_not_above_zero`
    );
  });

  it('does not trust an interval whose estimator is too skewed for the normal approximation', () => {
    // One rare enormous win per offset: heavy right skew.
    const skewed = (profileId: string, seed: number, index: number) => {
      const s = shard(profileId, seed, index, { win: 0, loss: 0 });
      const p = profileOf(profileId);
      for (let o = 0; o < p.seats; o++) {
        const acc = new Plo4PowerAccumulator();
        const n = s.strata[`${o}|flop`].n;
        for (let i = 0; i < n - 1; i++) acc.add(0);
        acc.add(index === 0 && seed === C.holdout.seeds[0] && o === 0 ? 30_000_000 : 0);
        s.strata[`${o}|flop`] = acc.toJSON();
      }
      return s;
    };
    const verdict = summarizePlo4Strength(fullMatrix(skewed));
    expect(verdict.reasons).toContain('cash:primary:interval_not_trusted');
  });
});
