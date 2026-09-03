import { describe, expect, it } from 'vitest';
import {
  MAX_PRIZE_PLAN_BUDGET,
  distributePrizeBudget,
  normalizeCustomPrizes,
  scaleCustomPrizesToBudget,
  suggestedPrizeBudgets,
  totalPrizePlan,
} from '../../src/utils/leaderboardPrizePlans';

describe('leaderboard prize plans', () => {
  it('keeps suggested budgets inside the available promo balance', () => {
    expect(suggestedPrizeBudgets(null)).toEqual({ weekly: 0, monthly: 0 });
    expect(suggestedPrizeBudgets(50)).toEqual({ weekly: 25, monthly: 25 });
    const plan = suggestedPrizeBudgets(10_000);
    expect(plan.weekly + plan.monthly).toBeLessThanOrEqual(10_000);
  });

  it('distributes every cent without minting rounding residue', () => {
    for (const key of ['balanced', 'top_heavy', 'even'] as const) {
      const plan = distributePrizeBudget(513.37, key);
      expect(totalPrizePlan(plan)).toBe(513.37);
      expect(plan.map((row) => row.rank)).toEqual([1, 2, 3]);
    }
  });

  it('normalizes hostile custom rows into unique, ordered, positive ranks', () => {
    expect(
      normalizeCustomPrizes([
        { rank: 2, amount: 10.126 },
        { rank: 1, amount: 25 },
        { rank: 2, amount: 12 },
        { rank: 6, amount: 999 },
        { rank: 3, amount: -1 },
      ])
    ).toEqual([
      { rank: 1, amount: 25 },
      { rank: 2, amount: 12 },
    ]);
  });

  it('rescales a custom board to the visible budget without changing its shape', () => {
    expect(
      scaleCustomPrizesToBudget(
        [
          { rank: 1, amount: 60 },
          { rank: 2, amount: 30 },
          { rank: 3, amount: 10 },
        ],
        250
      )
    ).toEqual([
      { rank: 1, amount: 150 },
      { rank: 2, amount: 75 },
      { rank: 3, amount: 25 },
    ]);
  });

  it('never creates a negative row when a tiny custom budget is apportioned', () => {
    const prizes = scaleCustomPrizesToBudget(
      [1, 2, 3, 4, 5].map((rank) => ({ rank, amount: 1 })),
      0.03
    );

    expect(prizes.every((prize) => prize.amount > 0)).toBe(true);
    expect(totalPrizePlan(prizes)).toBe(0.03);
  });

  it('keeps non-finite and oversized budgets inside the server contract', () => {
    expect(scaleCustomPrizesToBudget([], Number.POSITIVE_INFINITY)).toEqual([]);
    expect(totalPrizePlan(distributePrizeBudget(Number.POSITIVE_INFINITY, 'balanced'))).toBe(0);
    expect(suggestedPrizeBudgets(Number.MAX_VALUE).monthly).toBeLessThanOrEqual(
      MAX_PRIZE_PLAN_BUDGET
    );
    expect(normalizeCustomPrizes([{ rank: 1, amount: MAX_PRIZE_PLAN_BUDGET + 0.01 }])).toEqual([]);
  });
});
