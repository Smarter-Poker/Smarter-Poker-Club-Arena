/**
 * A FEATURED RECURRING TOURNAMENT IS PINNED ONLY ON ITS OWN DAY (Dan, 2026-10-19).
 *
 * Dan, verbatim: "do not pin the nightly 10k guarantees for future days, only
 * for the current day, if they are a few days out, do not pin those to the top
 * of mtt inside the tournament displays. (sunday 200 stays, and 'todays 10K
 * only' if its running, show it but never show the next days until its that
 * day."
 *
 * Why it happened: a schedule's `isFeatured` is copied onto EVERY instance the
 * spawner creates (ScheduledTournamentService writes `is_pinned` at spawn), and
 * the spawner publishes a daily event 72 hours ahead. So the Nightly 10K for
 * Tuesday, Wednesday and Thursday all floated above tonight's board on Monday.
 *
 * The rule, per series (same club, same name):
 *   - an event that has STARTED (running, late reg, bagged) keeps its pin;
 *   - a series with ONE upcoming instance on the board keeps its pin - that is
 *     the weekly flagship (the Sunday 200 Deep Stack), published once, six days
 *     ahead, and pinned the whole week;
 *   - a series with SEVERAL upcoming instances on the board is a nightly or
 *     several-times-a-week event, and only the instance that starts TODAY
 *     (the viewer's calendar day, the same clock the Starting Time column
 *     prints) keeps its pin. Tomorrow's is an ordinary row until tomorrow.
 *
 * The spawner's horizons are what make "several instances" mean "recurring
 * more often than weekly": a daily event is published 72 hours ahead, so it
 * always has two or more instances on the board, and a weekly one is published
 * six days ahead, so it never has two.
 *
 * Nothing is written to the database. `is_pinned` stays the host's choice; this
 * decides only which pinned rows float today, so it re-evaluates by itself when
 * the day turns over and no job has to flip a flag at midnight.
 */

export interface PinFacts {
  /** True when the host pinned/featured it (`is_pinned`). */
  pinned: boolean;
  /** True once it has started: running, late registration, bagged overnight. */
  started: boolean;
  /** ISO start time, or null when it has none. */
  startTime: string | null;
  /** The owning club, so two clubs' events of the same name stay separate. */
  clubId: string | null | undefined;
  name: string;
}

/** Same series = same club and same name, ignoring case, spacing and punctuation. */
export function seriesKey(f: Pick<PinFacts, 'clubId' | 'name'>): string {
  const name = (f.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${f.clubId ?? ''}|${name}`;
}

/** True when `iso` falls on the same local calendar day as `now`. */
export function startsOnDay(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * The rows that should float as FEATURED right now. Rows the host never pinned
 * are never in the set.
 */
export function featuredNow<T>(
  rows: readonly T[],
  read: (row: T) => PinFacts,
  now: Date = new Date()
): Set<T> {
  const keep = new Set<T>();
  const upcomingBySeries = new Map<string, Array<{ row: T; facts: PinFacts }>>();

  for (const row of rows) {
    const facts = read(row);
    if (!facts.pinned) continue;
    if (facts.started) {
      keep.add(row);
      continue;
    }
    const key = seriesKey(facts);
    const list = upcomingBySeries.get(key);
    if (list) list.push({ row, facts });
    else upcomingBySeries.set(key, [{ row, facts }]);
  }

  for (const list of upcomingBySeries.values()) {
    if (list.length === 1) {
      keep.add(list[0].row);
      continue;
    }
    for (const { row, facts } of list) {
      if (startsOnDay(facts.startTime, now)) keep.add(row);
    }
  }
  return keep;
}

/** Tournament statuses (any case) that mean the event is already under way. */
export function hasStarted(status: string | null | undefined): boolean {
  const s = String(status || '').toLowerCase();
  return (
    s === 'running' || s === 'late_reg' || s === 'bagged' || s === 'paused' || s === 'final_table'
  );
}
