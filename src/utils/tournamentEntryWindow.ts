/** Display projection of fn_tournament_late_registration_open / entry-window close.
 * The database remains authoritative for entry, capacity, funding and its clock.
 */
export interface TournamentEntryWindowRow {
  status?: string | null;
  current_level?: number | null;
  late_reg_levels?: number | null;
  rebuy_levels?: number | null;
  late_reg_mins?: number | null;
  started_at?: string | null;
  prize_pool_finalized?: boolean | null;
}

/**
 * `levels` is the level window; when the event also configures late_reg_mins
 * that clock bounds it too (`minutes`), and whichever deadline passes first
 * closes entry - exactly fn_tournament_late_registration_open since
 * 20260926035534. A level clock that stalls can no longer hold entry open for
 * days past the advertised minutes.
 */
type EntryWindow =
  | { mode: 'levels'; cap: number; current: number; minutes?: number }
  | { mode: 'minutes'; minutes: number }
  | { mode: 'closed' };

export function tournamentEntryWindow(row: TournamentEntryWindowRow): EntryWindow {
  if (row.prize_pool_finalized === true) return { mode: 'closed' };
  // These are nonnegative integer columns in the database. Do not turn a
  // malformed/stale projection into a permissive registration advertisement.
  for (const value of [
    row.current_level,
    row.late_reg_levels,
    row.rebuy_levels,
    row.late_reg_mins,
  ]) {
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) return { mode: 'closed' };
  }
  // Explicit zero suppresses the rebuy fallback, just like SQL COALESCE.
  const cap = row.late_reg_levels ?? row.rebuy_levels ?? 0;
  const minutes = row.late_reg_mins ?? 0;
  if (cap > 0) {
    return minutes > 0
      ? { mode: 'levels', cap, current: row.current_level ?? 0, minutes }
      : { mode: 'levels', cap, current: row.current_level ?? 0 };
  }
  return minutes > 0 ? { mode: 'minutes', minutes } : { mode: 'closed' };
}

/** The configured clock deadline (started_at + late_reg_mins), when there is one. */
export function tournamentEntryClockDeadlineMs(row: TournamentEntryWindowRow): number | null {
  const window = tournamentEntryWindow(row);
  const minutes = window.mode === 'closed' ? undefined : window.minutes;
  if (minutes === undefined || minutes <= 0) return null;
  const started = Date.parse(row.started_at ?? '');
  return Number.isFinite(started) ? started + minutes * 60000 : null;
}

export function tournamentEntryWindowOpen(row: TournamentEntryWindowRow, now: number): boolean {
  const status = String(row.status ?? '').toUpperCase();
  if (!['RUNNING', 'IN_PROGRESS', 'LATE_REG', 'LATE_REGISTRATION'].includes(status)) return false;
  const window = tournamentEntryWindow(row);
  if (window.mode === 'closed') return false;
  if (window.mode === 'levels' && window.current >= window.cap) return false;
  // A configured clock must be open too: whichever deadline passes first wins.
  if (window.minutes === undefined) return true;
  const deadline = tournamentEntryClockDeadlineMs(row);
  return deadline !== null && Number.isFinite(now) && now < deadline;
}
