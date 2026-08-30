import type { LeaderboardPrize, LeaderboardPrizePlanKey } from '../services/LeaderboardService';

const MAX_PRIZE_RANKS = 5;

const SPLITS: Record<Exclude<LeaderboardPrizePlanKey, 'custom'>, number[]> = {
  balanced: [0.5, 0.3, 0.2],
  top_heavy: [0.65, 0.25, 0.1],
  even: [1 / 3, 1 / 3, 1 / 3],
};

export function prizePlanLabel(plan: LeaderboardPrizePlanKey): string {
  if (plan === 'top_heavy') return 'Top Heavy';
  if (plan === 'even') return 'Even Podium';
  if (plan === 'custom') return 'Custom';
  return 'Balanced Podium';
}

export function suggestedPrizeBudgets(availableBalance: number | null): {
  weekly: number;
  monthly: number;
} {
  if (availableBalance == null || !Number.isFinite(availableBalance) || availableBalance <= 0) {
    return { weekly: 0, monthly: 0 };
  }

  const wholeBalance = Math.floor(availableBalance);
  const weekly = Math.min(wholeBalance, Math.max(25, Math.floor(wholeBalance * 0.01)));
  const remainingAfterWeekly = Math.max(0, wholeBalance - weekly);
  const monthly = Math.min(remainingAfterWeekly, Math.max(100, Math.floor(wholeBalance * 0.04)));
  return { weekly, monthly };
}

export function distributePrizeBudget(
  budget: number,
  plan: Exclude<LeaderboardPrizePlanKey, 'custom'>
): LeaderboardPrize[] {
  const cents = Math.max(0, Math.round((Number.isFinite(budget) ? budget : 0) * 100));
  if (cents === 0) return [];

  const split = SPLITS[plan];
  let allocated = 0;
  return split.map((share, index) => {
    const prizeCents = index === split.length - 1 ? cents - allocated : Math.round(cents * share);
    allocated += prizeCents;
    return { rank: index + 1, amount: prizeCents / 100 };
  });
}

export function normalizeCustomPrizes(prizes: LeaderboardPrize[]): LeaderboardPrize[] {
  const byRank = new Map<number, number>();
  for (const prize of prizes) {
    const rank = Math.trunc(Number(prize.rank));
    const amount = Math.round(Number(prize.amount) * 100) / 100;
    if (
      !Number.isFinite(rank) ||
      !Number.isFinite(amount) ||
      rank < 1 ||
      rank > MAX_PRIZE_RANKS ||
      amount <= 0
    ) {
      continue;
    }
    byRank.set(rank, amount);
  }
  return [...byRank.entries()]
    .sort(([rankA], [rankB]) => rankA - rankB)
    .map(([rank, amount]) => ({ rank, amount }));
}

export function totalPrizePlan(prizes: LeaderboardPrize[]): number {
  return (
    Math.round(prizes.reduce((total, prize) => total + Number(prize.amount || 0), 0) * 100) / 100
  );
}
