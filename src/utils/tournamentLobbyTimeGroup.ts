/** The lobby's "when does it start" group for one tournament card. */
export interface TournamentLobbyTimeGroup {
  label: string;
  order: number;
}

const MS_PER_MINUTE = 60 * 1000;

/** Whole local calendar days from `now` to `start` (0 = same day). */
function calendarDaysBetween(nowMs: number, startMs: number): number {
  const now = new Date(nowMs);
  const start = new Date(startMs);
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  return Math.round((startDay - nowDay) / (24 * 60 * MS_PER_MINUTE));
}

/**
 * THE DAY GROUPS FOLLOW THE CALENDAR (2026-09-26). The near-term groups are
 * measured in minutes; "Later Today" and "Tomorrow" name calendar days in the
 * viewer's own time zone. They used to be "within 6 hours" and "within 24
 * hours", so an event at 20:00 seen at 09:00 was listed under Tomorrow.
 */
export function tournamentLobbyTimeGroup(
  startTime: string,
  nowMs: number = Date.now()
): TournamentLobbyTimeGroup {
  const start = new Date(startTime).getTime();
  const diffMins = (start - nowMs) / MS_PER_MINUTE;

  if (diffMins < 0) return { label: 'Now', order: 0 }; // already started or completed
  if (diffMins < 30) return { label: 'Starting Soon (< 30 Min)', order: 1 };
  if (diffMins < 120) return { label: 'Next Hour (30 Min - 2 Hours)', order: 2 };
  const days = calendarDaysBetween(nowMs, start);
  if (days <= 0) return { label: 'Later Today', order: 3 };
  if (days === 1) return { label: 'Tomorrow', order: 4 };
  return { label: 'Coming Soon', order: 5 };
}
