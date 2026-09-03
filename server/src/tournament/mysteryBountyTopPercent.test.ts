/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE ADVERTISED TOP BOUNTY IS THE TOP BOUNTY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan's spec, section 10:
 *
 *   "TOP BOUNTY = 20% OF THE ENTIRE MYSTERY BOUNTY POOL ... The lobby may
 *    therefore advertise TOP MYSTERY BOUNTY $5,000. The advertised Jackpot
 *    must actually exist."
 *
 * `tournaments.mystery_bounty_top_percent` was stored, validated, and then
 * never read by the generator. The ladder's jackpot share came from the
 * profile alone, so an event configured at anything other than 20 advertised
 * one number and paid another - the single failure this section exists to
 * prevent.
 *
 * These tests pin both halves: the default really is 20%, and the stored
 * figure really does move it.
 */

import { describe, it, expect } from 'vitest';
import {
  applyTopBountyPercent,
  mysteryBountyTiers,
  DEFAULT_TOP_BOUNTY_PERCENT,
} from '../config/mysteryBountySpec.js';
import { buildInventory } from './mysteryBountyPool.js';

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe('the default really is a fifth of the pool', () => {
  it('CLASSIC carries a 20% jackpot, as the spec states', () => {
    expect(DEFAULT_TOP_BOUNTY_PERCENT).toBe(20);
    expect(mysteryBountyTiers('classic')[0].tier).toBe('jackpot');
    expect(mysteryBountyTiers('classic')[0].poolShare).toBe(20);
  });

  it("the spec's own worked example: a $25,000 pool tops out at $5,000", () => {
    // 1,000 entries at $25 of mystery contribution, 150 remaining -> 149 draws.
    const chests = buildInventory(25_000_00, 149, 'classic', 20);
    const top = Math.max(...chests.map((c) => c.amountCents));
    expect(top).toBe(5_000_00);
    expect(chests.filter((c) => c.amountCents === top)).toHaveLength(1);
    expect(sum(chests.map((c) => c.amountCents))).toBe(25_000_00);
  });
});

describe('the stored percentage moves the headline prize', () => {
  it('re-cuts the jackpot to whatever was configured', () => {
    const at30 = applyTopBountyPercent(mysteryBountyTiers('classic'), 30);
    expect(at30[0].poolShare).toBeCloseTo(30, 9);
    expect(sum(at30.map((t) => t.poolShare))).toBeCloseTo(100, 9);
  });

  it('shrinks every lower tier by the SAME factor, so the ladder never reorders', () => {
    const before = mysteryBountyTiers('classic');
    const after = applyTopBountyPercent(before, 30);
    // 80 points of pool became 70, so every lower tier keeps its relative size.
    const factor = 70 / 80;
    for (let i = 1; i < before.length; i++) {
      expect(after[i].poolShare).toBeCloseTo(before[i].poolShare * factor, 9);
    }
    /* NOT asserted: that the SHARES descend. They do not, by design - CLASSIC
       gives medium 14% against large's 12% because medium carries twice as
       many chests. The ladder that has to descend is VALUE PER CHEST, which
       is what a player actually experiences, and rescaling every lower tier by
       one factor cannot reorder it. */
    const chests = buildInventory(25_000_00, 149, 'classic', 30);
    const bestPerTier = new Map<string, number>();
    for (const c of chests) {
      bestPerTier.set(c.tier, Math.max(bestPerTier.get(c.tier) ?? 0, c.amountCents));
    }
    const order = ['jackpot', 'mega', 'major', 'large', 'medium', 'small', 'base_plus', 'base'];
    const present = order.filter((t) => bestPerTier.has(t)).map((t) => bestPerTier.get(t)!);
    for (let i = 1; i < present.length; i++) {
      expect(present[i], 'a lower tier paid more per chest than the tier above it').toBeLessThan(
        present[i - 1]
      );
    }
  });

  it('a 30% event actually pays a 30% top chest, to the cent', () => {
    const chests = buildInventory(25_000_00, 149, 'classic', 30);
    expect(Math.max(...chests.map((c) => c.amountCents))).toBe(7_500_00);
    expect(sum(chests.map((c) => c.amountCents))).toBe(25_000_00);
  });

  it('leaves the profile alone when the figure is absent or nonsense', () => {
    const base = mysteryBountyTiers('classic');
    for (const bad of [null, undefined, 0, 100, -5, 150, Number.NaN]) {
      expect(applyTopBountyPercent(base, bad as number)).toBe(base);
    }
  });

  it('is a no-op at the value the profile already carries', () => {
    const base = mysteryBountyTiers('classic');
    expect(applyTopBountyPercent(base, 20)).toBe(base);
  });
});

describe('moving the top prize never breaks the money', () => {
  it('still reconciles exactly, at every percentage', () => {
    for (const top of [5, 10, 15, 20, 25, 30, 40, 55, 70, 90]) {
      const chests = buildInventory(37_419_37, 88, 'classic', top);
      expect(sum(chests.map((c) => c.amountCents)), `top=${top}% did not reconcile`).toBe(
        37_419_37
      );
      expect(chests).toHaveLength(88);
      for (const c of chests) expect(c.amountCents).toBeGreaterThan(0);
    }
  });
});
