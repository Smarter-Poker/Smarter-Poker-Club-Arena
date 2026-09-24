/**
 * THE ONE OCCURRENCE RULE FOR A ZONED SCHEDULE (2026-09-24).
 *
 * A tournament_schedules row with a time_zone stores the wall-clock weekday and
 * 'HH:MM' its creator chose ("Repeats Weekly, 8:00 PM" in America/Chicago).
 * Each occurrence is converted to UTC for ITS OWN local date, so the event
 * stays at 8:00 PM local across daylight-saving changes instead of moving one
 * local hour twice a year the way a stored UTC time does.
 *
 * THE RULE, including daylight-saving ambiguity, in one sentence:
 *
 *   the start is the EARLIEST instant at which the zone's wall clock reads at
 *   or after the scheduled local time on that date.
 *
 * That single definition gives every case its answer:
 *   - a normal day: exactly the scheduled local time;
 *   - a time inside the spring-forward gap (02:30 on the night Chicago jumps
 *     02:00 -> 03:00): the first valid instant after it, 03:00 CDT;
 *   - a time inside the fall-back overlap (01:30 on the night Chicago repeats
 *     01:00-02:00): its FIRST occurrence, 01:30 CDT, and only that one.
 *
 * The engine is the only place that computes an occurrence; no SQL does. The
 * case table in scripts/ci/fixtures/schedule-time-zone/cases.json is shared by
 * this module's tests and by scripts/ci/test-schedule-time-zone.py, which
 * checks the same expected instants against PostgreSQL's tz database with the
 * same definition, so the rule and the zone data are pinned from both sides.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws RangeError for a zone the runtime does not know (fail closed). */
function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/**
 * The zone's wall clock at `instantMs`, expressed as the epoch ms of that same
 * calendar reading in UTC (so two wall clocks compare as plain numbers).
 */
export function wallClockMs(instantMs: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(zone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour === 24 ? 0 : parts.hour,
    parts.minute,
    parts.second
  );
}

/** 'YYYY-MM-DD' of the zone's calendar at `instant`. */
export function localDateIn(instant: Date, zone: string): string {
  return new Date(wallClockMs(instant.getTime(), zone)).toISOString().slice(0, 10);
}

/** True when this runtime can convert times in `zone`. */
export function isSupportedTimeZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The UTC instant a zoned schedule starts for local date `localDate`
 * ('YYYY-MM-DD') and local time `hhmm` ('HH:MM'), by the rule above.
 * Throws RangeError for an unknown zone or a malformed date/time: an
 * occurrence that cannot be computed must not be guessed.
 */
export function zonedStartUtc(localDate: string, hhmm: string, zone: string): Date {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const t = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(hhmm);
  if (!d || !t) throw new RangeError(`bad local date/time ${localDate} ${hhmm}`);
  const target = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));

  // Offsets (wall - instant) in force around the target bound every
  // candidate: the answer lies in [target - maxOffset, target - minOffset].
  const offsets = [target - DAY_MS, target, target + DAY_MS].map(
    (probe) => wallClockMs(probe, zone) - probe
  );
  let lo = target - Math.max(...offsets);
  let hi = target - Math.min(...offsets);

  // Nothing earlier than `lo` can read at or after the target, so when `lo`
  // does it is the answer: the exact time on a normal day, or the FIRST of
  // the two readings on a fall-back day.
  if (wallClockMs(lo, zone) >= target) return new Date(lo);

  // Otherwise the target is in (or just past) a transition and the wall clock
  // is monotone across [lo, hi]: find the first minute that reaches it. In a
  // spring-forward gap that is the transition instant itself.
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (wallClockMs(mid, zone) >= target) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}
