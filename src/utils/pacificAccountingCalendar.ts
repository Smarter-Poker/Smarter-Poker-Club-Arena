/**
 * The Pacific accounting calendar - ONE implementation, every client reader.
 *
 * The weekly accounting book is a Pacific calendar, not a UTC one.
 * `fn_prepare_accounting_week` writes `(p_to AT TIME ZONE 'America/Los_Angeles')
 * ::date - 1` and `server/src/services/pacificAccountingWeek.ts` writes the same
 * Monday..Sunday DATEs, so a `period_end` is an INCLUSIVE Pacific Sunday whose
 * week closes at Pacific midnight starting the following Monday. Reading that
 * DATE as UTC closes the book 7 hours early (8 in PST) and presents money as
 * settled before the week it belongs to has ended.
 *
 * These three primitives were private to `AccountingObservationService`, which
 * derives the accounting week and its Monday 04:00 `America/Chicago` run from
 * them. They live here so a second reader reuses that arithmetic instead of
 * writing a second timezone implementation, and so the 167 and 169-hour DST
 * weeks keep their real length everywhere. This module imports nothing.
 */

const invalid = () => new RangeError('Invalid Accounting Calendar Date');

/**
 * A validated calendar DATE. UTC carries the calendar arithmetic only; the
 * value itself is a wall-clock date in whichever zone wrote it.
 */
export function accountingDateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw invalid();
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) {
    throw invalid();
  }
  return result;
}

/** The calendar DATE an instant falls on in `zone`. */
export function zonedAccountingDate(value: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
}

/**
 * The instant at which `hour` o'clock on `day` occurs in `zone`. Converging on
 * the offset rather than assuming one is what keeps a DST week honest.
 */
export function zonedAccountingInstant(day: string, hour: number, zone: string): string {
  const desired = accountingDateOnly(day).getTime() + hour * 3_600_000;
  let instant = desired;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    const local = Date.parse(
      `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`
    );
    if (!Number.isFinite(local)) throw invalid();
    instant += desired - local;
  }
  return new Date(instant).toISOString();
}

/**
 * The instant the inclusive Pacific accounting DATE `day` closes: Pacific
 * midnight starting the next day. For a Sunday `period_end` this is the exact
 * `periodEnd` that `accountingWeekEndingOn` derives for the following Monday.
 */
export function pacificAccountingDayClose(day: string): number {
  const next = accountingDateOnly(day);
  next.setUTCDate(next.getUTCDate() + 1);
  const closesAt = Date.parse(
    zonedAccountingInstant(next.toISOString().slice(0, 10), 0, 'America/Los_Angeles')
  );
  if (!Number.isFinite(closesAt)) throw invalid();
  return closesAt;
}

/** The Pacific accounting DATE an instant falls on. */
export function pacificAccountingDay(nowMs: number): string {
  return zonedAccountingDate(new Date(nowMs), 'America/Los_Angeles');
}
