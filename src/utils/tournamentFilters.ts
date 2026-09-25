import {
  tournamentEntryWindow,
  tournamentEntryWindowOpen,
  type TournamentEntryWindowRow,
} from './tournamentEntryWindow';
import { getTournamentFormatKind, readTournamentFormat } from './tournamentPresentation';
import {
  describeStoredMttStructure,
  type MttClockSpeed,
  type MttStructureDescription,
} from '../../server/src/tournament/mttStructureDescription';
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
  format_contract?: unknown;
  name: string;
  /** Subtype for display; it does not establish the persisted format. */
  variant?: string | null;
  status?: string | null;
  start_time: string;
  max_players: number | null;
  tournament_type?: string | null;
  satellite_target_id?: string | null;
  type?: string | null;
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

/** Persisted formats are authoritative; unresolved rows remain in All only. */
export function tournamentVariant(t: FilterableTournament): 'MTT' | 'SN' | 'Spin-It' | 'Unknown' {
  switch (getTournamentFormatKind(t)) {
    case 'mtt':
      return 'MTT';
    case 'sng':
      return 'SN';
    case 'spin':
      return 'Spin-It';
    default:
      return 'Unknown';
  }
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

/** The ALL tab's status chips, in the lobby's own vocabulary. */
export type AllTabStatusFilter =
  | 'ALL'
  | 'RUNNING'
  | 'OPEN_REGISTRATION'
  | 'LATE_REG'
  | 'STARTING_SOON';

const ALL_TAB_SUB_FILTER: Record<AllTabStatusFilter, TournamentSubFilter> = {
  ALL: 'all',
  RUNNING: 'running',
  OPEN_REGISTRATION: 'registering',
  LATE_REG: 'late_reg',
  STARTING_SOON: 'starting_soon',
};

/**
 * Does a tournament belong under the ALL tab's status chip?
 *
 * 2026-09-22: the ALL tab compared the row's status to 'LATE_REG' and
 * 'STARTING_SOON', two strings nothing on this platform writes (see the note
 * at the top of this file), so both chips listed no tournament at all while
 * matchesTournamentSubFilter, which answers them from the late-registration
 * window and the start time, sat here with only tests calling it. Every ALL-tab
 * chip now goes through it.
 */
export function matchesAllTabTournamentStatus(
  t: FilterableTournament,
  filter: AllTabStatusFilter,
  now: number = Date.now()
): boolean {
  return matchesTournamentSubFilter(t, ALL_TAB_SUB_FILTER[filter] ?? 'all', now);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT TRAITS: one answer per trait, for the filter chip AND the medallion
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The lobby states a tournament's traits in two places: the medallions on its
 * card (lobbyEntries.tournamentMedallions) and the Required / Exclude feature
 * chips in the Advanced Filters sheet (advancedFilterSpec). Two copies of a
 * rule drift, and a chip that disagrees with the medallion beside it reads as a
 * broken lobby, so every trait is decided here once and both call it
 * (2026-09-22).
 *
 * THREE ANSWERS, NOT TWO. Each predicate answers true or false as the row
 * states it, and null when the row does not carry the columns that decide it.
 * The lobby paints from two sources that select different columns (the
 * get_club_home fast path first, the authoritative chain a moment later), so
 * "this row cannot tell" is an ordinary state and must never read as "no": the
 * filter keeps an unknown row under Required and under Exclude alike.
 *
 * THE COLUMNS THE ENGINE ACTS ON DECIDE. The chip-purchase RPC
 * (fn_ca_process_tournament_chip_purchase_money_v1) sells a rebuy, re-entry or
 * add-on only on is_rebuy, is_reentry or add_on_available; knockouts pay on
 * is_bounty, is_pko and is_mystery_bounty. A price is not evidence of a trait:
 * a re-entry is priced from rebuy_cost, a zero cost falls back to the buy-in,
 * and a bounty_amount without a flag pays nothing.
 *
 * THE NAME IS A FALLBACK THAT ONLY SAYS YES. The house naming convention is read
 * only when the row carries none of the deciding columns, and only for traits it
 * has always described on the card. A title that names the trait is evidence; a
 * title that does not is not evidence of absence, so it answers null.
 */

/** A raw tournament row, as either lobby source delivers it. */
export type TournamentTraitRow = Readonly<Record<string, unknown>>;

/** true or false as the row states it; null when the row cannot tell. */
export type TraitAnswer = boolean | null;

/** Did this row's source select the column? `null` is a value; `undefined` is not. */
const carries = (row: TournamentTraitRow, key: string): boolean => row[key] !== undefined;

/** A numeric column arrives as a number, or as a string for `numeric`. */
function positive(value: unknown): boolean {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return Number.isFinite(n) && n > 0;
}

export type TournamentNameConvention =
  | 'satellite'
  | 'freeroll'
  | 'mystery'
  | 'pko'
  | 'ko'
  | 'freezeout';

/**
 * The house naming convention. Moved here unchanged from lobbyEntries, where it
 * was `detectTourneyType`, so the medallions and the chips read one convention.
 *
 * SATELLITE IS DECIDED FIRST (2026-09-03). First match wins here, and
 * 'satellite' used to be tested LAST - which was harmless while every satellite
 * was named "Satellite to X", and wrong the moment a feeder carried its
 * TARGET's name. The satellite heads-ups are named "<target> Satellite
 * Heads-Up", so a feeder into "Saturday Mystery" resolved to 'mystery' and into
 * "Friday Fight Night PKO" to 'pko': the SATELLITE badge - the one fact that
 * makes the prize a SEAT rather than chips - was dropped, and a bounty medallion
 * the row's own is_bounty and is_pko columns say is false was pushed in its
 * place. The columns outrank this; see the predicates below.
 */
export function tournamentNameConvention(
  name: string | null | undefined
): TournamentNameConvention {
  const l = (name || '').toLowerCase();
  if (l.includes('satellite')) return 'satellite';
  if (l.includes('freeroll') || l.includes('free roll')) return 'freeroll';
  if (l.includes('mystery')) return 'mystery';
  if (l.includes('pko') || l.includes('progressive')) return 'pko';
  if (l.includes('bounty') || l.includes('ko ')) return 'ko';
  return 'freezeout';
}

/** The title as one-sided evidence: true when it names one of these, else null. */
function namedAs(row: TournamentTraitRow, ...conventions: TournamentNameConvention[]): TraitAnswer {
  if (typeof row.name !== 'string') return null;
  return conventions.includes(tournamentNameConvention(row.name)) ? true : null;
}

/** A word in the title, as the same one-sided evidence. */
function titleSays(row: TournamentTraitRow, ...words: string[]): TraitAnswer {
  if (typeof row.name !== 'string') return null;
  const l = row.name.toLowerCase();
  return words.some((w) => l.includes(w)) ? true : null;
}

/** The four columns TournamentInfoPanel decides a satellite by. */
const SATELLITE_COLUMNS = ['variant', 'tournament_type', 'satellite_target_id', 'satellite_target'];

/** "Sat" or "Satellite" as a WORD: keeps "Sat To Main", rejects "Saturday". */
const SATELLITE_WORD = /\bsat(ellite)?\b/i;

/**
 * A satellite: TournamentInfoPanel's rule (variant 'satellite', tournament_type
 * 'SATELLITE', or a target), plus the persisted format, which both lobby
 * sources carry. The database assigns a format from those same columns on
 * insert and then freezes them (fn_ca_guard_tournament_format): it grants
 * 'seat-first-satellite-v1' only to a 'SATELLITE' row with a target, and
 * 'sng-v1' and 'spin-v1' only to a row with none, so those three decide on
 * either source. A row carrying all four columns with none of them set is not a
 * satellite, whatever its title says. Any other row missing one of them
 * consults the name (`fallbackName` when the raw row has none).
 */
export function isSatelliteTournament(
  row: TournamentTraitRow,
  fallbackName?: string | null
): TraitAnswer {
  if (String(row.variant ?? '').toLowerCase() === 'satellite') return true;
  if (String(row.tournament_type ?? '').toUpperCase() === 'SATELLITE') return true;
  if (row.satellite_target_id || row.satellite_target) return true;
  const format = readTournamentFormat(row);
  if (format === 'seat-first-satellite-v1') return true;
  if (format === 'sng-v1' || format === 'spin-v1') return false;
  if (SATELLITE_COLUMNS.every((k) => carries(row, k))) return false;
  const name = typeof row.name === 'string' ? row.name : (fallbackName ?? '');
  return SATELLITE_WORD.test(name) || tournamentNameConvention(name) === 'satellite' ? true : null;
}

const BOUNTY_FLAGS = ['is_bounty', 'is_pko', 'is_mystery_bounty'];

/** Progressive knockout. */
export function isPkoTournament(row: TournamentTraitRow): TraitAnswer {
  return carries(row, 'is_pko') ? row.is_pko === true : namedAs(row, 'pko');
}

/** Mystery bounty. */
export function isMysteryBountyTournament(row: TournamentTraitRow): TraitAnswer {
  return carries(row, 'is_mystery_bounty')
    ? row.is_mystery_bounty === true
    : namedAs(row, 'mystery');
}

/**
 * Any bounty format, which is what the card's single bounty-family medallion
 * reports. Knockouts pay on the three flags alone (TournamentManagerEliminations),
 * so a bounty_amount with no flag is not a bounty event.
 */
export function paysBounties(row: TournamentTraitRow): TraitAnswer {
  if (BOUNTY_FLAGS.some((k) => row[k] === true)) return true;
  if (BOUNTY_FLAGS.every((k) => carries(row, k))) return false;
  if (BOUNTY_FLAGS.some((k) => carries(row, k))) return null;
  return namedAs(row, 'ko', 'pko', 'mystery');
}

/**
 * An ORDINARY bounty: a bounty event that is neither a PKO nor a mystery bounty
 * (fn_create_tournament sets is_bounty for all three). A title read without any
 * flag names exactly one member of the family, so a "KO" title alone is this one.
 */
export function isOrdinaryBountyTournament(row: TournamentTraitRow): TraitAnswer {
  const pko = isPkoTournament(row);
  const mystery = isMysteryBountyTournament(row);
  if (pko === true || mystery === true) return false;
  const bounty = paysBounties(row);
  if (bounty !== true) return bounty;
  if (pko === false && mystery === false) return true;
  return BOUNTY_FLAGS.some((k) => carries(row, k)) ? null : namedAs(row, 'ko');
}

/** Rebuys: is_rebuy is what the chip-purchase RPC checks. */
export function sellsRebuys(row: TournamentTraitRow): TraitAnswer {
  return carries(row, 'is_rebuy') ? row.is_rebuy === true : titleSays(row, 'rebuy');
}

/** Re-entry: is_reentry is what the chip-purchase RPC checks. */
export function sellsReentry(row: TournamentTraitRow): TraitAnswer {
  return carries(row, 'is_reentry')
    ? row.is_reentry === true
    : titleSays(row, 're-entry', 'reentry');
}

/** Add-on: add_on_available is what the chip-purchase RPC checks. No title names one. */
export function sellsAddOn(row: TournamentTraitRow): TraitAnswer {
  return carries(row, 'add_on_available') ? row.add_on_available === true : null;
}

/** A guaranteed prize pool. */
export function isGuaranteedTournament(row: TournamentTraitRow): TraitAnswer {
  return carries(row, 'guaranteed_prize') ? positive(row.guaranteed_prize) : null;
}

/**
 * Offers late registration: the window the engine closes (tournamentEntryWindow)
 * read as a term of the event, not as a moment. An explicit late_reg_levels of 0
 * suppresses the rebuy_levels fallback, as SQL COALESCE does, and a finalised
 * prize pool has closed the window (the database refuses to finalise while one
 * is open). Whether it is open RIGHT NOW is the status row's Late Reg chip.
 *
 * Unknown when a column that could change the answer was not read: a window
 * open by its terms whose finalisation flag is missing, or a closed one whose
 * level cap, rebuy fallback or minutes were not carried.
 */
export function offersLateRegistration(row: TournamentTraitRow): TraitAnswer {
  if (row.prize_pool_finalized === true) return false;
  const window = tournamentEntryWindow(row as TournamentEntryWindowRow);
  if (window.mode !== 'closed') return carries(row, 'prize_pool_finalized') ? true : null;
  const termsRead =
    carries(row, 'late_reg_levels') &&
    carries(row, 'late_reg_mins') &&
    (row.late_reg_levels !== null || carries(row, 'rebuy_levels'));
  return termsRead ? false : null;
}

const CLOCK_SPEEDS: ReadonlySet<string> = new Set(['standard', 'slow', 'turbo', 'hyper_turbo']);

/**
 * An MTT's clock speed. blind_speed is the database's own classification of the
 * stored ladder (trigger tournaments_new_mtt_blind_contract, the same thresholds
 * as mttSpeedForMinutes), but for an MTT ONLY: the column defaults to
 * 'standard' on every other row, so a Sit And Go or a Spin answers null rather
 * than a speed nothing measured. An MTT row without a recorded speed falls back
 * to the same rule over its stored ladder. Never from a title.
 */
export function tournamentClockSpeed(
  row: TournamentTraitRow,
  structureFacts?: MttStructureDescription
): MttClockSpeed | null {
  if (getTournamentFormatKind(row) !== 'mtt') return null;
  const recorded = row.blind_speed;
  if (typeof recorded === 'string' && CLOCK_SPEEDS.has(recorded)) return recorded as MttClockSpeed;
  if (structureFacts) return structureFacts.speed;
  if (!carries(row, 'blind_structure')) return null;
  return describeStoredMttStructure(row.blind_structure, row.starting_chips).speed;
}

function clockIs(row: TournamentTraitRow, speed: MttClockSpeed): TraitAnswer {
  const clock = tournamentClockSpeed(row);
  return clock === null ? null : clock === speed;
}

export const isTurboTournament = (row: TournamentTraitRow): TraitAnswer => clockIs(row, 'turbo');
export const isHyperTournament = (row: TournamentTraitRow): TraitAnswer =>
  clockIs(row, 'hyper_turbo');

/** A club's own private event (a union lobby lists these beside the union's games). */
export function isPrivateTournament(row: TournamentTraitRow): TraitAnswer {
  return carries(row, 'is_private') ? row.is_private === true : null;
}

/**
 * A union event: one in the union's scope rather than a single club's. Either
 * mark says so. is_xmtt is set by the create form in a union's context, a union
 * schedule and the XMTT launcher; union_id is stamped on every union-owned game,
 * including the board games the recurring service spawns without is_xmtt. A
 * club's private game carries union_id null, so only is_xmtt false with
 * union_id null is a definite no; anything short of that cannot tell.
 */
export function isUnionEvent(row: TournamentTraitRow): TraitAnswer {
  if (row.is_xmtt === true) return true;
  if (row.union_id != null) return true;
  if (row.is_xmtt === false && row.union_id === null) return false;
  return null;
}
