import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getFullRakeConfig } from '../config/RakeConfig.js';
import {
  assertAblationArms,
  ablationPilotMoments,
  runFeatureAblationDevelopment,
  runFeatureAblationContract,
  type FeatureAblationSpec,
} from './FeatureAblationLeague.js';
import { playPlo4PolicyHand, type Plo4AblationBrain } from './Plo4PolicyLeague.js';
const full = getFullRakeConfig(1, 2, 'plo6');
const profile = {
  id: 'test-plo6',
  variant: 'plo6' as const,
  seats: 2,
  tableSeats: 6,
  stackBB: 40,
  rakePercent: full.rakePercent,
  rakeCapBB: full.rakeCap / 2,
  anteBB: 0,
  straddle: false,
  tournament: false,
  opponentStyle: 'balanced' as const,
  publishedRake: true,
  productionStyles: true,
  moodClock: 'deal_seed_time_of_day' as const,
};
const brain: Plo4AblationBrain = {
  id: 'test-only-passive',
  decide(p, gs) {
    return {
      action: gs.legalActions?.includes('check') ? 'check' : 'call',
      amount: Math.min(p.stack, Math.max(0, gs.currentBet - p.bet)),
      thinkTime: 0,
    };
  },
};
const spec: FeatureAblationSpec = {
  id: 'test-only',
  profile,
  brain,
  candidate: { v24PloDefense: true },
  reference: { v24PloDefense: false },
};
describe('explicit physical flag ablation', () => {
  it('rejects implicit/inert/multiple flags before dealing', () => {
    expect(() => assertAblationArms({ ...spec, reference: {} })).toThrow();
    expect(() => assertAblationArms({ ...spec, reference: spec.candidate })).toThrow();
    expect(() =>
      assertAblationArms({ ...spec, candidate: { v24PloDefense: true, v53Pressure: true } })
    ).toThrow();
    expect(() =>
      assertAblationArms({ ...spec, profile: { ...profile, publishedRake: false } })
    ).toThrow();
  });
  it('derives exact-cent pilot dispersion/fourth moment independently', () => {
    expect(ablationPilotMoments({ n: 2, s1: '0', s2: '80000', s3: '0', s4: '3200000000' })).toEqual(
      { pairs: 2, standardDeviationBb: Math.sqrt(2), kurtosis: 1 }
    );
  });
  it('replays real controller paired fees and independent settlement', async () => {
    const a = await runFeatureAblationDevelopment(spec, { seed: 263011, pairs: 2 });
    const b = await runFeatureAblationDevelopment(spec, { seed: 263011, pairs: 2 });
    expect(a.complete).toBe(true);
    expect(a.pairDigest).toBe(b.pairDigest);
    expect(a.sums).toEqual({ n: 2, s1: '0', s2: '0', s3: '0', s4: '0' });
    expect(a.rakeCents).toBeGreaterThan(0);
    expect(a.bbjCents).toBe(0);
    expect(a.showdownsChecked).toBe(4);
    for (const k of [
      'illegalActions',
      'conservationErrors',
      'cardErrors',
      'truncatedHands',
      'settlementMismatches',
      'deductionMismatches',
      'pairedReplayMismatches',
    ] as const)
      expect(a[k], k).toBe(0);
    expect(a.promotionEligible).toBe(false);
  }, 30000);
  it('uses public cards, hero-only flags and no historical phase overrides', async () => {
    const seen: { hero: boolean; flag: unknown; phase: unknown; humanIds: unknown }[] = [];
    const capture: Plo4AblationBrain = {
      id: 'test-only-capture',
      decide(p, gs, style, opts, sandbox, coordinate) {
        expect(gs.players.every((x) => x.cards.length === 0)).toBe(true);
        seen.push({
          hero: p.seat === 1,
          flag: opts.v24PloDefense,
          phase: opts.phase11Omaha,
          humanIds: gs.humanUserIds,
        });
        return brain.decide(p, gs, style, opts, sandbox, coordinate);
      },
    };
    await playPlo4PolicyHand(
      { ...profile, ablation: { brain: capture, heroOpts: { v24PloDefense: false } } },
      393923,
      2,
      1,
      'candidate',
      () => true,
      true
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((x) => x.hero).every((x) => x.flag === false)).toBe(true);
    expect(seen.filter((x) => !x.hero).every((x) => x.flag === undefined)).toBe(true);
    expect(seen.every((x) => x.phase === undefined)).toBe(true);
    let initialized = 0;
    seen.length = 0;
    const population = {
      id: 'test-only-public',
      decide: (p: Parameters<typeof brain.decide>[0], gs: Parameters<typeof brain.decide>[1]) =>
        ({
          action: gs.legalActions?.includes('check') ? 'check' : 'call',
          amount: Math.min(p.stack, Math.max(0, gs.currentBet - p.bet)),
          thinkTime: 0,
        }) as const,
      initializeSandbox() {
        initialized++;
      },
    };
    await playPlo4PolicyHand(
      { ...profile, ablation: { brain: capture, population, heroOpts: { v24PloDefense: false } } },
      393923,
      2,
      1,
      'candidate',
      () => true,
      true
    );
    expect(initialized).toBe(1);
    expect(
      seen.every((x) => JSON.stringify(x.humanIds) === '["00000000-0000-4000-8000-000000000002"]')
    ).toBe(true);
  }, 30000);
  it('forwards the declared CLI continuation and preserves the exact raw range', async () => {
    const cli = readFileSync(
      new URL('../scripts/featureAblationDevelop.ts', import.meta.url),
      'utf8'
    );
    expect(cli).toMatch(
      /runFeatureAblationDevelopment\(\s*spec,\s*\{\s*seed,\s*pairs,\s*startPair,/
    );
    const indices: number[] = [];
    const r = await runFeatureAblationDevelopment(
      spec,
      { seed: 263011, pairs: 2, startPair: 540 },
      () => true,
      (row) => {
        indices.push(row.index);
      }
    );
    expect(r.startPair).toBe(540);
    expect(indices).toEqual([540, 541]);
    expect(r.complete).toBe(true);
  });
  it('refuses a foreign contract before authorization or any physical pair', async () => {
    let authorized = 0,
      dealt = 0;
    await expect(
      runFeatureAblationContract(
        spec,
        {
          seed: 1,
          pairs: 576,
          startPair: 0,
          planDigest: '0'.repeat(64),
          cellKey: 'unregistered-test-cell',
        },
        () => {
          authorized++;
        },
        () => {
          dealt++;
        }
      )
    ).rejects.toThrow();
    expect(authorized).toBe(0);
    expect(dealt).toBe(0);
  });
  it('separates profile draw streams with independently fixed SHA256 vectors', async () => {
    const seeds: number[] = [];
    for (const id of ['fixed-a', 'fixed-b']) {
      const result = await runFeatureAblationDevelopment(
        { ...spec, profile: { ...profile, id } },
        { seed: 12345, pairs: 1 },
        () => true,
        (row) => {
          seeds.push(row.dealSeed);
        }
      );
      expect(result.complete).toBe(true);
      expect(result.pairedReplayMismatches).toBe(0);
    }
    // Independently computed with Python hashlib, UTF-8 domain + one NUL +
    // compact JSON tuple, first four digest bytes interpreted unsigned BE.
    expect(seeds).toEqual([1622662316, 2422094062]);
    expect(new Set(seeds).size).toBe(2);
  });
  it('retains incomplete cancellation without a passing verdict', async () => {
    const r = await runFeatureAblationDevelopment(spec, { seed: 263011, pairs: 2 }, () => false);
    expect(r.complete).toBe(false);
    expect(r.pairs).toBe(0);
    expect(r.promotionEligible).toBe(false);
  });
});
