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

type EntryWindow =
  | { mode: 'levels'; cap: number; current: number }
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
  if (cap > 0) return { mode: 'levels', cap, current: row.current_level ?? 0 };
  const minutes = row.late_reg_mins ?? 0;
  return minutes > 0 ? { mode: 'minutes', minutes } : { mode: 'closed' };
}

export function tournamentEntryWindowOpen(row: TournamentEntryWindowRow, now: number): boolean {
  const status = String(row.status ?? '').toUpperCase();
  if (!['RUNNING', 'IN_PROGRESS', 'LATE_REG', 'LATE_REGISTRATION'].includes(status)) return false;
  const window = tournamentEntryWindow(row);
  if (window.mode === 'levels') return window.current < window.cap;
  if (window.mode === 'minutes') {
    const started = Date.parse(row.started_at ?? '');
    return (
      Number.isFinite(started) && Number.isFinite(now) && now < started + window.minutes * 60000
    );
  }
  return false;
}
