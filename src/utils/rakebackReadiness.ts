import { pacificAccountingDay, pacificAccountingDayClose } from './pacificAccountingCalendar';

/**
 * Readiness is a DISPLAY hint only. Rakeback is settled automatically every
 * Monday at 4:00 AM Central Time by `fn_process_weekly_accounting`; nothing
 * here moves money, and a ready period is one whose Pacific week has closed
 * and which the next automatic run will settle.
 */
interface ReadinessPeriod {
  id: string;
  club_id: string;
  period_end: string;
  rakeback_earned: number;
  status: string;
}

/**
 * `rakeback_periods.period_end` is the INCLUSIVE Pacific Sunday that ends an
 * accounting week, so the week closes at Pacific midnight starting the next
 * day - the same instant `accountingWeekEndingOn` derives for that Monday,
 * 167 and 169-hour DST weeks included. Closing it at UTC midnight instead
 * presented the week as closed from 17:00 PDT Sunday, 7 hours early (8 in
 * PST) and 9 hours before the Monday 04:00 America/Chicago run.
 */
function closesAtPacific(periodEnd: string): number | null {
  try {
    return pacificAccountingDayClose(periodEnd);
  } catch {
    return null;
  }
}

/** The Pacific accounting date an instant falls on: this surface's "today". */
export function rakebackAccountingDay(nowMs: number): string {
  return pacificAccountingDay(nowMs);
}

/**
 * The next instant any period's readiness can change: Pacific midnight, which
 * is never later than the close of a period that is still open.
 */
export function nextRakebackBoundary(nowMs: number): number | null {
  return closesAtPacific(pacificAccountingDay(nowMs));
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
    const closesAt = closesAtPacific(period.period_end);
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
