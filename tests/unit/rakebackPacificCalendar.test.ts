/**
 * ONE Pacific calendar, two readers.
 *
 * `rakeback_periods.period_end` is an inclusive Pacific Sunday. The rakeback
 * surface shows a player when that week closed; AccountingObservationService
 * shows an operator when the same week closed and when its Monday 04:00
 * America/Chicago run is due. A second timezone implementation would put the
 * player and the operator on different Sundays, so this pins them together.
 *
 * Until 2026-09-20 the readiness helper added a flat 24 UTC hours to the DATE,
 * which closed a Pacific week from 17:00 PDT Sunday: seven hours early, eight
 * in PST, and nine hours before the automatic run that actually pays it.
 */
import { describe, expect, it, vi } from 'vitest';

// AccountingObservationService reaches supabase and the bus through its reader.
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({ loaded: false, authenticated: false, userId: null }),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: () => () => {} },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import {
  accountingWeekEndingOn,
  accountingRunExpectedAt,
} from '../../src/services/AccountingObservationService';
import { pacificAccountingDayClose } from '../../src/utils/pacificAccountingCalendar';
import {
  getRakebackReadiness,
  nextRakebackBoundary,
  rakebackAccountingDay,
} from '../../src/utils/rakebackReadiness';

const rows = (periodEnd: string) => [
  { id: 'week', club_id: 'club-1', period_end: periodEnd, rakeback_earned: 3, status: 'pending' },
];

describe('the rakeback surface closes a week on the accounting calendar', () => {
  // 2026-03-08 and 2026-11-01 end the 167 and 169-hour DST weeks, where the
  // Pacific offset on either side of the boundary is not the same.
  it.each([
    ['ordinary week', '2026-09-20', '2026-09-21', '2026-09-21T07:00:00.000Z'],
    ['167-hour DST week', '2026-03-08', '2026-03-09', '2026-03-09T07:00:00.000Z'],
    ['169-hour DST week', '2026-11-01', '2026-11-02', '2026-11-02T08:00:00.000Z'],
  ])('%s: the inclusive Sunday closes with its accounting week', (_name, sunday, monday, close) => {
    expect(accountingWeekEndingOn(monday).periodEnd).toBe(close);
    expect(pacificAccountingDayClose(sunday)).toBe(Date.parse(close));

    expect(getRakebackReadiness(rows(sunday), Date.parse(close) - 1).readyAmount).toBe(0);
    expect(getRakebackReadiness(rows(sunday), Date.parse(close)).readyAmount).toBe(3);

    // The retired rule closed the book at the next UTC midnight, which is
    // strictly earlier, so it presented the week as ready before it closed.
    const utcMidnight = Date.parse(`${monday}T00:00:00.000Z`);
    expect(utcMidnight).toBeLessThan(Date.parse(close));
    expect(getRakebackReadiness(rows(sunday), utcMidnight).readyAmount).toBe(0);
  });

  it.each(['2026-09-21', '2026-03-09', '2026-11-02'])(
    'still settles the week ending %s after its Pacific close, never before',
    (monday) => {
      const week = accountingWeekEndingOn(monday);
      expect(Date.parse(accountingRunExpectedAt(week))).toBeGreaterThan(Date.parse(week.periodEnd));
    }
  );

  it('reads the Pacific accounting day and boundary, not the UTC ones', () => {
    // 19:00 PDT Sunday. The UTC calendar has already turned over.
    const sundayEvening = Date.parse('2026-09-21T02:00:00.000Z');
    expect(rakebackAccountingDay(sundayEvening)).toBe('2026-09-20');
    expect(nextRakebackBoundary(sundayEvening)).toBe(Date.parse('2026-09-21T07:00:00.000Z'));
    expect(rakebackAccountingDay(Date.parse('2026-09-21T07:00:00.000Z'))).toBe('2026-09-21');
    // Across the 169-hour week the boundary is an hour further out in PST.
    expect(nextRakebackBoundary(Date.parse('2026-11-01T20:00:00.000Z'))).toBe(
      Date.parse('2026-11-02T08:00:00.000Z')
    );
  });

  it('never guesses a close for a DATE the accounting book did not write', () => {
    for (const bad of ['2026-02-30', 'unknown', '2026-09-10T00:00:00Z', '0000-01-02']) {
      const readiness = getRakebackReadiness(rows(bad), Date.parse('2030-01-01T00:00:00.000Z'));
      expect(readiness.readyAmount).toBe(0);
      expect(readiness.pendingAmount).toBe(3);
      expect(readiness.targetClubId).toBeNull();
      expect(readiness.nextChangeAt).toBeNull();
    }
  });
});
