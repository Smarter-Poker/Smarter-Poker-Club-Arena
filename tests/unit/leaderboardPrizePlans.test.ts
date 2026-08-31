import { describe, expect, it } from 'vitest';
import {
  distributePrizeBudget,
  normalizeCustomPrizes,
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
});
