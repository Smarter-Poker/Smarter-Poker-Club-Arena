import type { LeaderboardPrize, LeaderboardPrizePlanKey } from '../services/LeaderboardService';

const MAX_PRIZE_RANKS = 5;
export const MAX_PRIZE_PLAN_BUDGET = 1_000_000_000;

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
  const weekly = Math.min(
    wholeBalance,
    MAX_PRIZE_PLAN_BUDGET,
    Math.max(25, Math.floor(wholeBalance * 0.01))
  );
  const remainingAfterWeekly = Math.max(0, wholeBalance - weekly);
  const monthly = Math.min(
    remainingAfterWeekly,
    MAX_PRIZE_PLAN_BUDGET,
    Math.max(100, Math.floor(wholeBalance * 0.04))
  );
  return { weekly, monthly };
}

export function clampPrizeBudget(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_PRIZE_PLAN_BUDGET, Math.max(0, Math.round(value * 100) / 100));
}

export function distributePrizeBudget(
  budget: number,
  plan: Exclude<LeaderboardPrizePlanKey, 'custom'>
): LeaderboardPrize[] {
  const cents = Math.round(clampPrizeBudget(budget) * 100);
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
      amount <= 0 ||
      amount > MAX_PRIZE_PLAN_BUDGET
    ) {
      continue;
    }
    byRank.set(rank, amount);
  }
  return [...byRank.entries()]
    .sort(([rankA], [rankB]) => rankA - rankB)
    .map(([rank, amount]) => ({ rank, amount }));
}

export function scaleCustomPrizesToBudget(
  prizes: LeaderboardPrize[],
  requestedBudget: number
): LeaderboardPrize[] {
  const budget = clampPrizeBudget(requestedBudget);
  if (budget === 0) return [];
  const normalized = normalizeCustomPrizes(prizes);
  if (normalized.length === 0) return distributePrizeBudget(budget, 'balanced');

  const sourceTotal = totalPrizePlan(normalized);
  if (sourceTotal <= 0) return distributePrizeBudget(budget, 'balanced');
  const targetCents = Math.round(budget * 100);
  const allocations = normalized.map((prize) => {
    const exactCents = targetCents * (prize.amount / sourceTotal);
    return { prize, cents: Math.floor(exactCents), remainder: exactCents % 1 };
  });
  const remainingCents = targetCents - allocations.reduce((sum, row) => sum + row.cents, 0);
  const byLargestRemainder = allocations
    .map((row, index) => ({ index, remainder: row.remainder }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remainingCents; index += 1) {
    allocations[byLargestRemainder[index].index].cents += 1;
  }
  return allocations
    .filter((row) => row.cents > 0)
    .map(({ prize, cents }) => ({ rank: prize.rank, amount: cents / 100 }));
}

export function totalPrizePlan(prizes: LeaderboardPrize[]): number {
  const total = prizes.reduce((sum, prize) => {
    const amount = Number(prize.amount);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
  return Math.round(total * 100) / 100;
}

export interface RankedPrizeCandidate {
  userId: string;
  rank: number;
  qualified?: boolean;
}

/**
 * Preview the same tie rule the settlement RPC enforces. A tie group shares
 * the combined prizes for every place it occupies (1, 1 takes first + second;
 * the next rank is 3). Residual cents follow stable user-id order so the
 * preview and immutable payout receipts conserve the advertised pool exactly.
 */
export function allocateTiedPrizePlan(
  candidates: RankedPrizeCandidate[],
  prizes: LeaderboardPrize[]
): Map<string, number> {
  const prizeCentsByRank = new Map(
    normalizeCustomPrizes(prizes).map((prize) => [prize.rank, Math.round(prize.amount * 100)])
  );
  const candidatesByRank = new Map<number, RankedPrizeCandidate[]>();

  for (const candidate of candidates) {
    if (
      candidate.qualified === false ||
      !candidate.userId ||
      !Number.isInteger(candidate.rank) ||
      candidate.rank < 1
    ) {
      continue;
    }
    const group = candidatesByRank.get(candidate.rank) || [];
    group.push(candidate);
    candidatesByRank.set(candidate.rank, group);
  }

  const awards = new Map<string, number>();
  for (const [rank, unsortedGroup] of candidatesByRank) {
    const group = [...unsortedGroup].sort((a, b) => a.userId.localeCompare(b.userId));
    const poolCents = Array.from({ length: group.length }, (_, offset) => rank + offset).reduce(
      (sum, occupiedRank) => sum + (prizeCentsByRank.get(occupiedRank) || 0),
      0
    );
    if (poolCents <= 0) continue;

    const baseCents = Math.floor(poolCents / group.length);
    const residualCents = poolCents % group.length;
    group.forEach((candidate, index) => {
      awards.set(candidate.userId, (baseCents + (index < residualCents ? 1 : 0)) / 100);
    });
  }
  return awards;
}
