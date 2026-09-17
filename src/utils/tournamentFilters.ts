import { tournamentEntryWindowOpen, type TournamentEntryWindowRow } from './tournamentEntryWindow';
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

export interface FilterableTournament extends TournamentEntryWindowRow {
  name: string;
  /**
   * The row's real variant. Optional because some callers still hand over
   * projections that predate it; when it is absent the name heuristic below
   * takes over.
   */
  variant?: string | null;
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

/**
 * Classify a tournament into the lobby's variant tabs.
 *
 * THE COLUMN FIRST, THE NAME ONLY AS A FALLBACK.
 *
 * This used to read the NAME alone, because the queries feeding it did not
 * select `variant`. That is a guess dressed as a rule: a "Spinnaker Special"
 * would have filed under Spins, and a Spin renamed by an operator would have
 * vanished from the tab that exists for it. Both queries now select the
 * column, so the row can be asked what it is.
 *
 * The heuristic stays for callers still passing older projections — removing
 * it would turn a wrong tab into an empty one, which is worse.
 */
export function tournamentVariant(t: FilterableTournament): 'MTT' | 'SN' | 'Spin-It' {
  const v = (t.variant || '').toLowerCase();
  if (v === 'spin') return 'Spin-It';
  if (v === 'sng') return 'SN';

  // THE COLUMN IS THE ANSWER WHEN IT IS THERE, INCLUDING WHEN IT SAYS "NOT A
  // SPIN". Checking only the two positive cases and then falling through left
  // the name heuristic free to overrule it -- a "Spinnaker Special" with
  // variant 'freezeout' still filed under Spins. Seat count still separates a
  // small field from a big one, which the column does not describe.
  if (v) return t.max_players <= 10 ? 'SN' : 'MTT';

  const name = (t.name || '').toLowerCase();
  if (name.includes('spin')) return 'Spin-It';
  if (name.includes('sng') || t.max_players <= 10) return 'SN';
  return 'MTT';
}

export function matchesVariant(t: FilterableTournament, variant: TournVariant): boolean {
  if (variant === 'ALL') return true;
  return tournamentVariant(t) === variant;
}

/** Display the same selected window the engine closes; entry still uses its RPC. */
export function isInLateRegistration(t: FilterableTournament, now: number): boolean {
  return tournamentEntryWindowOpen(t, now);
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
