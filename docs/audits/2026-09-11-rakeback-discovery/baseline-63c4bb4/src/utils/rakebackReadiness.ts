/** Readiness is a display hint; the claim RPC remains the payout authority. */
interface ReadinessPeriod {
  id: string;
  club_id: string;
  period_end: string;
  rakeback_earned: number;
  status: string;
}

// The database DATE is inclusive. A period ending today closes at the next UTC midnight.
function closesAtUtc(periodEnd: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) return null;
  const start = Date.parse(`${periodEnd}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== periodEnd) {
    return null;
  }
  return start + 24 * 60 * 60 * 1000;
}

export function getRakebackReadiness(periods: readonly ReadinessPeriod[], nowMs: number) {
  let readyAmount = 0;
  let pendingAmount = 0;
  let targetClubId: string | null = null;
  let nextChangeAt: number | null = null;
  const readyPeriodIds = new Set<string>();

  for (const period of periods) {
    if (period.status !== 'pending') continue;
    const earned = Number(period.rakeback_earned);
    if (!Number.isFinite(earned)) continue;
    const closesAt = closesAtUtc(period.period_end);
    if (earned > 0 && period.club_id && closesAt !== null && closesAt <= nowMs) {
      readyAmount += earned;
      readyPeriodIds.add(period.id);
      targetClubId ??= period.club_id;
    } else {
      pendingAmount += earned;
      if (earned > 0 && period.club_id && closesAt !== null && closesAt > nowMs) {
        nextChangeAt = nextChangeAt === null ? closesAt : Math.min(nextChangeAt, closesAt);
      }
    }
  }

  return { readyAmount, pendingAmount, targetClubId, nextChangeAt, readyPeriodIds };
}
