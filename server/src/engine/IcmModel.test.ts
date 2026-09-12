/**
 * V16 ICM — Malmuth-Harville ground truth.
 */
import { describe, it, expect } from 'vitest';
import {
  bubbleFactor,
  createIcmEquityEstimator,
  icmEquity,
  premiumFromBubbleFactor,
} from './IcmModel.js';

describe('icmEquity', () => {
  it('bounds optional future-hand work with truthful uncertainty and unchanged default work', () => {
    const stacks = Array.from({ length: 18 }, () => 1000),
      payouts = [50, 30, 20];
    const baseline = createIcmEquityEstimator(stacks, payouts, 0);
    const future = createIcmEquityEstimator(stacks, payouts, 0, undefined, 128);
    expect(baseline.trials).toBe(1200);
    expect(future.trials).toBe(128);
    const a = baseline.estimate(stacks),
      b = future.estimate(stacks);
    expect(b.errorBound).toBeGreaterThan(a.errorBound);
    expect(Math.abs(b.equity - 100 / 18)).toBeLessThanOrEqual(b.errorBound);
    expect(future.estimate(stacks)).toEqual(b);
    expect(createIcmEquityEstimator(stacks, payouts, 0, undefined, 1).trials).toBe(96);
    expect(createIcmEquityEstimator(stacks, payouts, 0, undefined, 100000).trials).toBe(1200);
    expect(
      createIcmEquityEstimator([100, 200], [100], 0, undefined, 128).estimate([100, 200])
    ).toEqual(createIcmEquityEstimator([100, 200], [100], 0).estimate([100, 200]));
  });
  it('two players: closed form p*(P1-P2)+P2', () => {
    // 60/40 chips, payouts 100/60: hero(60%) = 0.6*100 + 0.4*60 = 84
    expect(icmEquity([600, 400], [100, 60], 0)).toBeCloseTo(84, 6);
    expect(icmEquity([600, 400], [100, 60], 1)).toBeCloseTo(76, 6);
    // equities sum to the prize pool
  });

  it('equal stacks share equally and sum to the pool', () => {
    const stacks = [1000, 1000, 1000];
    const pays = [50, 30, 20];
    const e0 = icmEquity(stacks, pays, 0);
    const e1 = icmEquity(stacks, pays, 1);
    const e2 = icmEquity(stacks, pays, 2);
    expect(e0).toBeCloseTo(e1, 6);
    expect(e1).toBeCloseTo(e2, 6);
    expect(e0 + e1 + e2).toBeCloseTo(100, 6);
  });

  it('prices every finishing place symmetrically at the ten-player exact boundary', () => {
    const stacks = Array.from({ length: 10 }, () => 1000);
    // A unit prize at one rank isolates that rank's probability. Exchangeable
    // stacks must give every hero exactly 1/10, including the deepest rank.
    for (let rank = 0; rank < 10; rank++) {
      const prizes = Array.from({ length: 10 }, (_, i) => Number(i === rank));
      const equities = stacks.map((_, hero) => icmEquity(stacks, prizes, hero));
      for (const equity of equities) expect(equity).toBeCloseTo(0.1, 12);
      expect(equities.reduce((sum, equity) => sum + equity, 0)).toBeCloseTo(1, 12);
    }
  });

  it('a chip lead is worth LESS than proportional (the ICM curve)', () => {
    // 3 players, hero has half the chips: chip-proportional share of the
    // 100 pool would be 50; ICM must be less (flat payout curvature).
    const eq = icmEquity([3000, 2000, 1000], [50, 30, 20], 0);
    expect(eq).toBeGreaterThan(34); // better than an equal share
    expect(eq).toBeLessThan(50); // but less than chip-proportional
  });

  it('handles big fields directly without changing player cardinality', () => {
    const stacks = Array.from({ length: 60 }, (_, i) => 1000 + i * 100);
    const pays = [40, 25, 15, 10, 6, 4];
    const t0 = Date.now();
    const eq = icmEquity(stacks, pays, 59); // biggest stack
    expect(Date.now() - t0).toBeLessThan(200);
    expect(eq).toBeGreaterThan(100 / 60); // clearly above average share
    expect(eq).toBeLessThan(40);
  });

  it('reuses one deterministic action workspace and rejects remote-stack drift', () => {
    const stacks = Array.from({ length: 1_000 }, (_, index) => 500 + index * 3);
    const payouts = Array.from({ length: 200 }, () => 0.5);
    const workspace = createIcmEquityEstimator(stacks, payouts, 998, [998, 999]);
    const candidate = [...stacks];
    candidate[998] -= 250;
    candidate[999] += 250;

    const first = workspace.estimate(candidate);
    const second = workspace.estimate(candidate);
    expect(first).toEqual(second);
    expect(first.modeledPlayers).toBe(1_000);
    expect(workspace.randomClockDraws).toBeLessThanOrEqual(240_000);

    const drifted = [...candidate];
    drifted[0] += 1;
    expect(() => workspace.estimate(drifted)).toThrow('ICM remote stack changed');

    const withBustedRemote = [...stacks, 0];
    const zeroWorkspace = createIcmEquityEstimator(withBustedRemote, payouts, 998, [998, 999]);
    const resurrectedRemote = [...withBustedRemote];
    resurrectedRemote[1_000] = 1;
    expect(() => zeroWorkspace.estimate(resurrectedRemote)).toThrow('ICM remote stack changed');
  });
});

describe('bubbleFactor', () => {
  const pays = [50, 30, 20];

  it('is EXACTLY ~1 in a winner-take-all (pure chip EV) - the conservation regression', () => {
    // The first cut created/destroyed the risked chips instead of moving
    // them, and WTA read BF 2. With conservation it must be 1.
    const bf = bubbleFactor([2000, 2000, 2000], [100], 0, 2000);
    expect(bf).toBeGreaterThan(0.99);
    expect(bf).toBeLessThan(1.01);
  });

  it('a medium stack on a flat payout has BF well above 1', () => {
    // 4 players, 3 paid, flat-ish payouts: the classic bubble squeeze.
    const bf = bubbleFactor([2000, 2000, 2000, 500], [40, 32, 28], 0, 1500);
    expect(bf).toBeGreaterThan(1.3);
  });

  it('risking into a COVERING stack costs more than the same risk covered', () => {
    // Hero 1500. vs a covering 4000 stack hero risks his whole 1500;
    // vs a covered 700 stack hero risks only 700.
    const stacks = [1500, 4000, 700, 1800];
    const vsCovering = bubbleFactor(stacks, pays, 0, 1500);
    const vsCovered = bubbleFactor(stacks, pays, 0, 700);
    expect(vsCovering).toBeGreaterThan(vsCovered);
  });

  it('premium mapping is monotone and capped', () => {
    expect(premiumFromBubbleFactor(1)).toBe(0);
    expect(premiumFromBubbleFactor(1.5)).toBeCloseTo(0.02, 6);
    expect(premiumFromBubbleFactor(2)).toBeCloseTo(0.04, 6);
    expect(premiumFromBubbleFactor(9)).toBe(0.14);
  });
});
