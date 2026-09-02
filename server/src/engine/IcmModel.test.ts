/**
 * V16 ICM — Malmuth-Harville ground truth.
 */
import { describe, it, expect } from 'vitest';
import { icmEquity, bubbleFactor, premiumFromBubbleFactor } from './IcmModel.js';

describe('icmEquity', () => {
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

  it('a chip lead is worth LESS than proportional (the ICM curve)', () => {
    // 3 players, hero has half the chips: chip-proportional share of the
    // 100 pool would be 50; ICM must be less (flat payout curvature).
    const eq = icmEquity([3000, 2000, 1000], [50, 30, 20], 0);
    expect(eq).toBeGreaterThan(34); // better than an equal share
    expect(eq).toBeLessThan(50); // but less than chip-proportional
  });

  it('handles big fields via bucketing without blowing up', () => {
    const stacks = Array.from({ length: 60 }, (_, i) => 1000 + i * 100);
    const pays = [40, 25, 15, 10, 6, 4];
    const t0 = Date.now();
    const eq = icmEquity(stacks, pays, 59); // biggest stack
    expect(Date.now() - t0).toBeLessThan(200);
    expect(eq).toBeGreaterThan(100 / 60); // clearly above average share
    expect(eq).toBeLessThan(40);
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
