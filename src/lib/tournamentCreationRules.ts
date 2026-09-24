/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT CREATION RULES: ONE LIST, EVERY SURFACE, SAME AS THE SERVER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three surfaces author a tournament configuration: the Create Game modal, the
 * table-config page (tournamentFromTableConfig) and the recurring schedule
 * editors (TournamentScheduleService.upsert). Each used to carry its own copy
 * of the rules, and the copies disagreed with each other and with the server:
 * the modal accepted payouts within 0.5 of 100 while the service and database
 * allowed 1; the service skipped the check entirely at a zero total, which the
 * database refuses; the modal refused a past start while the table-config page
 * silently replaced it with "now"; a satellite with no target and a rebuy with
 * no late window were accepted on some surfaces and refused on others.
 *
 * This module is the one list. Every surface funnels its p_config through
 * `tournamentRpcConfigRefusal` (TournamentService.buildRpcConfig calls it for
 * the create and schedule surfaces, and TournamentScheduleService.upsert calls
 * it for any raw schedule config), and the database applies the identical list
 * in public.fn_tournament_config_refusal(jsonb, text), migration
 * 20260924033701, from fn_create_tournament and fn_upsert_tournament_schedule.
 * The same codes come back from either side, and `tournamentCreateErrorMessage`
 * turns each into the sentence the owner reads.
 *
 * WHERE THE TWO SIDES HAD DIFFERED, THE SERVER'S RULE WON:
 *   payout total      within 1 of 100, and a zero total is refused
 *   seat ceiling      what one deck can deal (VariantRules.maxSeatsFor)
 *
 * REBUY AND RE-ENTRY TOGETHER ARE SUPPORTED. The engine opens both from one
 * purchase window (TournamentBrainContext: rebuyOpen and reentryOpen are both
 * `entryPurchaseWindowOpen`), a Free Buy event carries both, and the
 * table-config page has always enabled both. So nothing here makes them
 * exclusive; what is refused is either one without an open late window,
 * because that window never opens (rebuy_levels, then late_reg_levels, then
 * late_reg_mins: all zero means no purchase can ever be made).
 *
 * Pure: no Supabase, no React. Safe to import from tests and the server tree.
 */
import { maxSeatsTheDeckAllows } from '../config/tableSeating';
import { isFreeBuyEvent } from '../utils/freeBuy';

export type TournamentConfigSurface = 'create' | 'schedule';

/** fn_create_tournament_governed_legacy: abs(total - 100) > 1 is refused. */
export const PAYOUT_TOTAL_TOLERANCE = 1;

/**
 * A start this far behind the browser's clock is refused. The form is filled in
 * while the clock moves, so the last minute is not "the past" yet. The server
 * allows five minutes, to absorb a device clock running slow, so a start the
 * browser accepts is never refused by the database for being late.
 */
export const START_TIME_GRACE_MS = 60_000;
export const SERVER_START_TIME_SKEW_MINUTES = 5;

/** The late registration a schedule gets when its config names none (spawner default). */
export const SCHEDULE_DEFAULT_LATE_REGISTRATION_LEVELS = 8;

/**
 * Every refusal fn_create_tournament, fn_create_tournament_governed_legacy,
 * fn_tournament_config_refusal and this module can return, in the words the
 * owner reads. Title Case, no em dashes (CLAUDE.md 5.7 and 10.7).
 */
export const TOURNAMENT_CREATE_ERRORS: Readonly<Record<string, string>> = {
  not_authenticated: 'Sign In To Create A Tournament.',
  not_authorised:
    'Only The Owner Or An Admin Can Create Tournaments Here. A Club Inside A Union Does Not Create Its Own, The Union Creates Them.',
  invalid_configuration:
    'The Tournament Settings Could Not Be Read. Check Every Number And Try Again.',
  unsupported_tournament_variant: 'This Game Cannot Run As A Tournament. Pick Another Game.',
  unsupported_spin_variant: 'Spins Run Only On NLH, PLO4, PLO5 And PLO6. Pick One Of Those Games.',
  satellite_requires_scheduled_mtt_config:
    'A Satellite Must Be A Tournament, Not A Sit And Go Or Spin. Change The Format To Satellite.',
  buy_in_must_not_be_negative: 'The Buy-In Cannot Be Negative.',
  buy_in_must_be_whole: 'The Buy-In Must Be A Whole Number Of Chips, With No Decimals.',
  bounty_must_be_whole: 'The Bounty Must Be A Whole Number Of Chips, With No Decimals.',
  max_players_must_be_positive: 'Choose How Many Seats This Sit And Go Or Spin Has.',
  blind_structure_required: 'Choose A Blind Structure.',
  custom_level_breaks_not_supported:
    'Custom Level Breaks Are Not Supported. Remove Break Rows And Use The Synchronized Break Setting.',
  payout_structure_required: 'Choose A Payout Structure.',
  payouts_must_total_100: 'Payout Percentages Must Add Up To 100 Percent.',
  more_paid_places_than_players:
    'This Tournament Pays More Places Than It Has Seats. Reduce The Paid Places Or Add Seats.',
  bounty_amount_required: 'A Bounty Tournament Needs A Bounty Amount.',
  bounty_exceeds_buy_in:
    'The Bounty Plus The Fee Is More Than The Buy-In, So Nothing Would Be Left For The Prize Pool. Lower The Bounty Or Raise The Buy-In.',
  early_bird_chips_must_not_be_negative: 'Early Bird Chips Cannot Be Negative.',
  restart_every_minutes_out_of_range:
    'The Restart Interval Must Be Between 5 Minutes And One Week (10,080 Minutes).',
  total_days_out_of_range: 'A Multi-Day Tournament Runs 2 To 7 Days.',
  mystery_range_requires_mystery_bounty:
    'Mystery Bounty Multipliers Only Apply To Mystery Bounty Tournaments.',
  mystery_bounty_range_invalid:
    'Mystery Bounty Multipliers Must Be Positive, With The Maximum At Least The Minimum.',
  satellite_seats_invalid: 'A Satellite Must Award At Least 1 Seat.',
  satellite_seats_requires_target: 'Satellite Seats Need A Target Tournament.',
  // 20260924033701: the refusals the forms made and the database did not.
  satellite_target_required: 'Pick The Target Tournament This Satellite Awards Seats Into.',
  rebuy_requires_late_registration:
    'Rebuys And Re-Entries Close When Late Registration Closes. Set Late Registration To At Least 1 Level.',
  start_time_in_past: 'Pick A Start Time In The Future.',
  table_size_exceeds_deck:
    'Too Many Seats For This Game. One Deck Seats At Most 9 In PLO5 And 7 In PLO6. Lower The Table Size.',
  blind_structure_must_not_decrease:
    'Blinds Can Never Go Down From One Level To The Next. Fix The Blind Structure.',
  blind_level_duration_invalid: 'Every Blind Level Needs A Duration Longer Than 0 Minutes.',
  starting_stack_must_be_positive: 'Starting Chips Must Be A Whole Number Greater Than 0.',
};

export const TOURNAMENT_CREATE_FALLBACK_ERROR =
  'Could Not Create The Tournament. Refresh The Lobby And Try Again.';

/** The owner-facing sentence for a refusal code, never the raw code. */
export function tournamentCreateErrorMessage(code: string | null | undefined): string {
  return TOURNAMENT_CREATE_ERRORS[code ?? ''] ?? TOURNAMENT_CREATE_FALLBACK_ERROR;
}

/** A refusal with its machine code kept, so a caller can branch on it. */
export class TournamentConfigRefusedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(tournamentCreateErrorMessage(code));
    this.name = 'TournamentConfigRefusedError';
    this.code = code;
  }
}

interface PostgresLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

/**
 * A database error from a creation call, as a sentence. Every SQLSTATE the
 * creation path can raise has its own reason; none of them says "Please try
 * again" about a condition that retrying cannot change.
 *
 *   23514  tournaments_creation_guard raises it for seats and paid places, and
 *          a CHECK constraint raises it for a price. It used to be reported as
 *          "the buy-in or fee failed a safety check" whatever the cause.
 *   22023  the MTT blind contract trigger, the mystery bounty document and the
 *          Free Buy option guard.
 *   23503  a satellite target (or club) that no longer exists.
 *   55000  trg_tournaments_guarantee_affordable: its text names the shortfall
 *          and the remedy, so it is passed through.
 */
export function tournamentCreateDbErrorMessage(
  error: PostgresLikeError | null | undefined
): string {
  const code = String(error?.code ?? '');
  const raised = String(error?.message ?? '').trim();
  const text = `${raised} ${String(error?.details ?? '')}`.toLowerCase();
  switch (code) {
    case '23514':
      if (text.includes('paid places'))
        return TOURNAMENT_CREATE_ERRORS.more_paid_places_than_players;
      if (text.includes('max_players'))
        return TOURNAMENT_CREATE_ERRORS.max_players_must_be_positive;
      return 'Could Not Create The Tournament. Its Seats, Payouts Or Prices Failed A Safety Check.';
    case '22023':
      if (text.includes('blind structure')) {
        return 'The Blind Structure Was Refused. Every Level Needs A Positive Duration, And Blinds Can Never Go Down.';
      }
      if (text.includes('mystery bounty')) {
        return 'The Mystery Bounty Options Are Not Valid. Check The Profile, Activation And Pool Percent.';
      }
      if (text.includes('free buy')) {
        return 'Free Buy Options Need A Free Entry Tournament With No Buy-In.';
      }
      return 'Could Not Create The Tournament. One Of Its Settings Is Not Valid.';
    case '23503':
      if (text.includes('satellite')) {
        return 'The Target Tournament For This Satellite No Longer Exists. Pick Another Target.';
      }
      return 'Could Not Create The Tournament. The Club Or Event It Refers To No Longer Exists.';
    case '55000':
      if (raised && /guarantee/i.test(raised)) return raised;
      return 'Could Not Create The Tournament Because Something It Depends On Changed. Refresh And Try Again.';
    case '0A000':
      return 'Could Not Create The Tournament. That Option Is Not Available Yet.';
    case '42501':
      return 'You Do Not Have Permission To Create Games For This Club.';
    case '22P02':
      return TOURNAMENT_CREATE_ERRORS.invalid_configuration;
    case '22003':
      return 'A Number In The Form Is Too Large. Lower It And Try Again.';
    case '23505':
      return 'A Matching Tournament Already Exists. Refresh The Lobby Before Creating It Again.';
    case '57014':
      return 'The Server Took Too Long. Refresh The Lobby Before Trying Again, In Case It Was Created.';
    case '40001':
    case '40P01':
      return 'The Server Was Busy With Another Change. Try Again.';
    default:
      return TOURNAMENT_CREATE_FALLBACK_ERROR;
  }
}

// ── Single rules, exported for the live form checks ─────────────────────────

/** Payouts total within the database tolerance. A zero total is not a pass. */
export function payoutTotalIsValid(totalPercent: number): boolean {
  return Number.isFinite(totalPercent) && Math.abs(totalPercent - 100) <= PAYOUT_TOTAL_TOLERANCE;
}

export function payoutTotal(payouts: unknown): number {
  if (!Array.isArray(payouts)) return 0;
  return payouts.reduce(
    (sum: number, p) => sum + (Number((p as { percentage?: unknown })?.percentage) || 0),
    0
  );
}

/** True when `start` is a real time more than the grace behind `nowMs`. */
export function startTimeIsPast(
  start: Date | string | number | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (start === null || start === undefined || start === '') return false;
  const at = start instanceof Date ? start.getTime() : new Date(start).getTime();
  return Number.isFinite(at) && at < nowMs - START_TIME_GRACE_MS;
}

/** The most seats one deck can deal for this game (the engine's maxSeatsFor). */
export function deckSeatLimit(gameVariant: string | null | undefined): number {
  return maxSeatsTheDeckAllows(String(gameVariant ?? 'nlh').toLowerCase());
}

export interface RebuyWindowSubject {
  isRebuy?: boolean;
  isReentry?: boolean;
  lateRegistrationLevels?: number | null;
  lateRegistrationMinutes?: number | null;
  buyIn?: number | null;
  type?: string | null;
}

/**
 * Rebuys and re-entries are sold only while the purchase window is open, and
 * that window is late registration. With neither levels nor minutes it never
 * opens. A Free Buy event is exempt: zz_freerolls_are_free_buy gives it its own
 * rebuy levels whatever late registration says.
 */
export function rebuyWindowIsOpen(subject: RebuyWindowSubject): boolean {
  if (!subject.isRebuy && !subject.isReentry) return true;
  if (isFreeBuyEvent({ buyIn: Number(subject.buyIn ?? 0), type: subject.type ?? 'mtt' })) {
    return true;
  }
  return (
    (Number(subject.lateRegistrationLevels) || 0) > 0 ||
    (Number(subject.lateRegistrationMinutes) || 0) > 0
  );
}

// ── The whole list, over the p_config the server reads ──────────────────────

type Json = Record<string, unknown>;

/** A value the database would fail to cast: the whole config is unreadable. */
class Unreadable extends Error {}

/** SQL `NULLIF(x, '')` over `->>`: absent, JSON null and '' are all "not set". */
const unset = (v: unknown) => v === undefined || v === null || v === '';

/** `NULLIF(p->>k, '')::numeric`: null when unset, the number, or unreadable. */
function num(v: unknown): number | null {
  if (unset(v)) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new Unreadable();
}

/** `(p->>k)::boolean`, which accepts PostgreSQL's spellings and refuses the rest. */
function bool(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  const t = String(v).trim().toLowerCase();
  if (['t', 'true', 'y', 'yes', 'on', '1'].includes(t)) return true;
  if (['f', 'false', 'n', 'no', 'off', '0'].includes(t)) return false;
  throw new Unreadable();
}

/** `p->>k = 'true'`: the spawner's strict reading of a schedule flag. */
const flag = (v: unknown) => v === true || v === 'true';

/** `btrim(p->>k) <> ''`. */
const filled = (v: unknown) =>
  v !== undefined && v !== null && (typeof v === 'object' || String(v).trim() !== '');

function hasScheduleSatelliteTarget(p: Json): boolean {
  // COALESCE(p->'satelliteTarget', p->'satellite_target'): a present JSON null
  // is a value to SQL, so only an ABSENT satelliteTarget falls through.
  const obj = p.satelliteTarget !== undefined ? p.satelliteTarget : p.satellite_target;
  if (typeof obj === 'string' && obj.trim() !== '') return true;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Json;
    if (!unset(o.tournamentId) || !unset(o.tournament_id)) return true;
  }
  return (
    filled(p.satelliteTargetId) || filled(p.satellite_target_id) || filled(p.satelliteTargetName)
  );
}

/**
 * The first rule this p_config breaks, as a refusal code, or null when the
 * engine can run it. Mirrors public.fn_tournament_config_refusal step for step,
 * including where it reads each key (a key it never reaches cannot make the
 * config unreadable); scripts/ci/fixtures/tournament-creation-rules/cases.json
 * is run against both, by tests/unit/tournamentCreationRules.test.ts and by
 * scripts/ci/test-tournament-creation-rules.py.
 *
 * The one deliberate difference: a start time is "past" here one minute
 * behind the browser's clock, and five minutes behind the database's there.
 *
 * `surface` is 'create' for fn_create_tournament and 'schedule' for a
 * tournament_schedules.config, which differs only where the spawner does: no
 * start time (the spawner owns it), a missing late registration means 8
 * levels, legacy rebuy and satellite spellings count, a Spin sits three to a
 * table, and a single-table format's default table is its own field.
 */
export function tournamentRpcConfigRefusal(
  p: Json | null | undefined,
  opts: { surface?: TournamentConfigSurface; nowMs?: number } = {}
): string | null {
  const schedule = (opts.surface ?? 'create') === 'schedule';
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'invalid_configuration';
  try {
    let type = unset(p.type) ? 'mtt' : String(p.type).trim().toLowerCase() || 'mtt';
    if (schedule && (type === 'hu_sng' || type === 'heads_up')) type = 'sng';
    const short = type === 'sng' || type === 'spin';

    // 1. Starting stack: a whole number above zero, for every format.
    const stack = num(p.startingStack);
    if (stack !== null && (stack <= 0 || !Number.isInteger(stack))) {
      return 'starting_stack_must_be_positive';
    }

    // 2. A start in the past is refused, never silently moved.
    if (!schedule && !unset(p.startTime)) {
      const at = new Date(String(p.startTime)).getTime();
      if (!Number.isFinite(at)) throw new Unreadable();
      if (startTimeIsPast(at, opts.nowMs ?? Date.now())) return 'start_time_in_past';
    }

    // 3. A satellite names the event its seats go into.
    if (type === 'satellite') {
      const ok = schedule ? hasScheduleSatelliteTarget(p) : filled(p.satelliteTargetId);
      if (!ok) return 'satellite_target_required';
    }

    // 4. Payouts add up to 100, within the database tolerance.
    if (Array.isArray(p.payoutStructure) && p.payoutStructure.length > 0) {
      let total = 0;
      for (const row of p.payoutStructure) {
        const pct =
          row && typeof row === 'object' && !Array.isArray(row)
            ? num((row as Json).percentage)
            : null;
        total += pct ?? 0;
      }
      if (!payoutTotalIsValid(total)) return 'payouts_must_total_100';
    }

    // 5. A Sit And Go or Spin ladder: positive durations, blinds never fall.
    //    Break rows (a flag, or 0/0 blinds) do not take part. A new MTT ladder
    //    is held to the fuller contract by validateMttBlindStructure and the
    //    tournaments_new_mtt_blind_contract trigger.
    if (short && Array.isArray(p.blindStructure)) {
      let seen = false;
      let prevSb: number | null = null;
      let prevBb: number | null = null;
      const below = (a: number | null, b: number | null) => a !== null && b !== null && a < b;
      for (const raw of p.blindStructure) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid_configuration';
        const level = raw as Json;
        const minutes = num(level.durationMinutes);
        if (minutes !== null && minutes <= 0) return 'blind_level_duration_invalid';
        const sb = num(level.smallBlind);
        const bb = num(level.bigBlind);
        if (flag(level.isBreak) || (sb === 0 && bb === 0)) continue;
        if (seen && (below(sb, prevSb) || below(bb, prevBb))) {
          return 'blind_structure_must_not_decrease';
        }
        prevSb = sb;
        prevBb = bb;
        seen = true;
      }
    }

    // 6. No more seats at a table than one deck can deal.
    let seats: number;
    if (schedule && type === 'spin') {
      seats = 3;
    } else {
      const size = num(p.tableSize);
      seats =
        size !== null
          ? Math.round(size)
          : schedule && short
            ? Math.round(num(p.maxPlayers) ?? 2)
            : 9;
      seats = Math.min(10, Math.max(2, seats));
    }
    if (seats > deckSeatLimit(unset(p.gameVariant) ? 'NLH' : String(p.gameVariant).trim())) {
      return 'table_size_exceeds_deck';
    }

    // 7. A rebuy or re-entry needs a late registration window to be sold in.
    let rebuy: boolean;
    let lateLevels: number;
    let lateMinutes = 0;
    if (schedule) {
      rebuy =
        flag(p.isRebuy) ||
        flag(p.rebuy) ||
        flag(p.isReentry) ||
        ['rebuy', 'reentry', 'mtt_rebuy', 'mtt_reentry'].includes(type);
      lateLevels = short
        ? 0
        : !('lateRegistrationLevels' in p)
          ? SCHEDULE_DEFAULT_LATE_REGISTRATION_LEVELS
          : (num(p.lateRegistrationLevels) ?? 0);
    } else {
      rebuy = bool(p.isRebuy) || bool(p.isReentry);
      lateLevels = short ? 0 : (num(p.lateRegistrationLevels) ?? 0);
      lateMinutes = num(p.lateRegistrationMinutes) ?? 0;
    }
    const buyIn = num(p.buyIn) ?? 0;
    const open = rebuyWindowIsOpen({
      isRebuy: rebuy,
      lateRegistrationLevels: lateLevels,
      lateRegistrationMinutes: lateMinutes,
      buyIn,
      type: short ? type : 'mtt',
    });
    if (!open) return 'rebuy_requires_late_registration';
  } catch (err) {
    if (err instanceof Unreadable) return 'invalid_configuration';
    throw err;
  }
  return null;
}

/** Throws the owner-facing refusal, or returns quietly. */
export function assertTournamentRpcConfig(
  p: Json,
  opts: { surface?: TournamentConfigSurface; nowMs?: number } = {}
): void {
  const code = tournamentRpcConfigRefusal(p, opts);
  if (code) throw new TournamentConfigRefusedError(code);
}
