/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tournament lobby filters
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from ClubHomePage on 2026-08-19 so the filter rules are testable.
 * Two sub-filters had live defects that no test could catch while the logic sat
 * inline in a useMemo:
 *
 *   LATE REG      — matched only status === 'LATE_REG', a value this platform
 *                   never writes. The only statuses that exist are REGISTERING,
 *                   RUNNING, COMPLETED and CANCELLED, so the tab was always
 *                   empty. Late registration is a WINDOW, so it is derived.
 *
 *   STARTING SOON — required minutesUntilStart > 0, but tournaments here start
 *                   on fill rather than on the clock, so every live one sits in
 *                   REGISTERING with a start_time already in the past. The
 *                   condition could never hold and the tab was always empty.
 */

export type TournamentSubFilter = 'all' | 'running' | 'registering' | 'late_reg' | 'starting_soon';
export type TournVariant = 'ALL' | 'MTT' | 'Spin-It' | 'SN';

export interface FilterableTournament {
  name: string;
  status?: string | null;
  start_time: string;
  max_players: number;
  late_reg_mins?: number | null;
  late_reg_levels?: number | null;
  started_at?: string | null;
  current_level?: number | null;
}

/** How far ahead a start time still counts as "soon". */
export const STARTING_SOON_WINDOW_MINUTES = 60;

export function isOpenForRegistration(status?: string | null): boolean {
  const s = (status || '').toUpperCase();
  return s === 'REGISTERING' || s === 'OPEN' || s === 'PENDING';
}

export function isRunning(status?: string | null): boolean {
  const s = (status || '').toUpperCase();
  return s === 'RUNNING' || s === 'IN_PROGRESS';
}

/** Classify a tournament into the lobby's variant tabs. */
export function tournamentVariant(t: FilterableTournament): 'MTT' | 'SN' | 'Spin-It' {
  const name = (t.name || '').toLowerCase();
  if (name.includes('spin')) return 'Spin-It';
  if (name.includes('sng') || t.max_players <= 10) return 'SN';
  return 'MTT';
}

export function matchesVariant(t: FilterableTournament, variant: TournVariant): boolean {
  if (variant === 'ALL') return true;
  return tournamentVariant(t) === variant;
}

/**
 * Is this tournament still inside its late-registration window?
 * Derived from late_reg_mins / late_reg_levels because no status carries it.
 */
export function isInLateRegistration(t: FilterableTournament, now: number): boolean {
  const s = (t.status || '').toUpperCase();
  if (s === 'LATE_REG' || s === 'LATE_REGISTRATION') return true;
  if (!isRunning(s)) return false;

  const lateMins = Number(t.late_reg_mins) || 0;
  if (lateMins > 0) {
    const begun = new Date(t.started_at || t.start_time).getTime();
    if (Number.isFinite(begun) && now - begun <= lateMins * 60000) return true;
  }

  const lateLevels = Number(t.late_reg_levels) || 0;
  if (lateLevels > 0 && Number(t.current_level || 0) <= lateLevels) return true;

  return false;
}

/** Does a tournament belong under the given status sub-filter? */
export function matchesTournamentSubFilter(
  t: FilterableTournament,
  subFilter: TournamentSubFilter,
  now: number = Date.now()
): boolean {
  if (subFilter === 'all') return true;
  if (subFilter === 'running') return isRunning(t.status);
  if (subFilter === 'registering') return isOpenForRegistration(t.status);
  if (subFilter === 'late_reg') return isInLateRegistration(t, now);
  if (subFilter === 'starting_soon') {
    if (!isOpenForRegistration(t.status)) return false;
    const minutesUntilStart = (new Date(t.start_time).getTime() - now) / 60000;
    // Deliberately NOT `> 0`: a tournament that is overdue but still taking
    // registrations is the most "starting soon" thing in the lobby.
    return minutesUntilStart <= STARTING_SOON_WINDOW_MINUTES;
  }
  return true;
}
