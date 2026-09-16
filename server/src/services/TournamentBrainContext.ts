/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOURNAMENT BRAIN CONTEXT — Real ICM Inputs for the Horses (V12 — 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 * V11 gave the horse brain an explicit cash/tournament switch; the ICM layer
 * was still a flat premium because the brain could not see the tournament.
 * This service feeds it the real thing: players left, spots paid, bubble
 * distance, average stack, format (MTT / spin / HU SNG), and the PKO bounty
 * share — everything icmRiskV2 needs to price survival correctly.
 *
 * Access from the decision path is synchronous and bounded: it only reads the
 * lifecycle-owned cache. Startup and heartbeat code refresh that cache away
 * from the action clock. Phase 6 wraps every miss or stale read in a status carrying
 * TOURNAMENT_CONTEXT_INCOMPLETE; it never disguises missing tournament state
 * as a cash-like empty object.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { resolvePayoutStructure, type PayoutSubject } from '../tournament/payoutStructure.js';
import {
  capLevelToChipsInPlay,
  escalatedBlindLevel,
  lastPlayableIndex,
} from '../tournament/blindEscalation.js';
import { observedStepRatio } from '../tournament/blindLadder.js';
import { continueBookedSpinBlinds } from '../tournament/SpinDrawReceipt.js';
import { spinBlindsForLevel } from '../config/spinSpec.js';
import { acceleratedLevelMs } from '../tournament/acceleratedLevels.js';
import {
  TOURNAMENT_CONTEXT_INCOMPLETE,
  type TournamentAnteType,
  type TournamentContextStatus,
} from '../engine/HorseTournamentPreflop.js';
import { selectInChunks } from './supabase/chunkedIn.js';
import { recoveryFeeCents, tournamentFeeRatio, unitFloorCents } from '../tournament/recoveryFee.js';
import { horseRebuyAllowance } from './FreeBuy.js';

export type TournamentFormat = 'mtt' | 'sng' | 'spin' | 'hu_sng';

export interface TournamentBrainContext {
  schemaVersion: 1;
  contextStatus: Extract<TournamentContextStatus, 'complete' | 'incomplete'>;
  contextIssues: string[];
  format: TournamentFormat;
  tournamentType: string;
  tournamentStatus: string;
  gameVariant: string;
  entrants: number;
  playersLeft: number;
  spotsPaid: number;
  inMoney: boolean;
  /** stone bubble / approaching-bubble flag (playersLeft within 15% of paid) */
  nearBubble: boolean;
  /** average live stack in CHIPS (0 = unknown) */
  avgStackChips: number;
  /** median live stack in chips (0 = unknown). */
  medianStackChips: number;
  /** Configured seats at each table and current live field size. */
  seatsPerTable: number;
  /** Current level and exact schedule terms from the tournament row. */
  currentLevel: number;
  currentSmallBlind: number;
  currentBigBlind: number;
  currentAnte: number;
  anteType: TournamentAnteType;
  nextSmallBlind: number | null;
  nextBigBlind: number | null;
  nextAnte: number | null;
  levelDurationMin: number | null;
  levelElapsedMin: number | null;
  /** Registration and re-entry state, never inferred as cash defaults. */
  registrationOpen: boolean;
  lateRegistrationOpen: boolean;
  registrationRequiresAuthorization: boolean;
  isPko: boolean;
  isBounty: boolean;
  isMysteryBounty: boolean;
  mysteryBountyStage: 'none' | 'pending' | 'active' | 'complete';
  reentryAllowed: boolean;
  reentryOpen: boolean;
  maxReentries: number | null;
  rebuyAllowed: boolean;
  rebuyOpen: boolean;
  maxRebuys: number | null;
  addOnAvailable: boolean;
  addOnPeriodOpen: boolean;
  addOnCost: number | null;
  addOnChips: number | null;
  addOnLevels: number | null;
  onBreak: boolean;
  /** The manager's rule is playersLeft === spotsPaid + 1. */
  handForHandExpected: boolean;
  /** PKO: share of the prize pool sitting in bounties (0 = not a bounty) */
  bountyFactor: number;
  /** Funded regular and bounty pools, normalized to cents for Phase 7 utility. */
  prizePoolCents: number;
  bountyPoolCents: number;
  /** Entry/recovery terms. These are observations only; the brain moves no money. */
  buyInCents: number | null;
  startingStackChips: number | null;
  rebuyCostCents: number | null;
  rebuyChips: number | null;
  /** Exact amount one recovery purchase adds to each funded pool. */
  rebuyPrizeContributionCents: number | null;
  rebuyBountyContributionCents: number | null;
  /** Personal recovery usage; global windows/caps alone are not eligibility. */
  reloadsByUser: Record<string, number>;
  /** Free Buy events apply the deterministic per-horse 0-5 recovery cap. */
  horseRebuyCapByUser: Record<string, number>;
  addOnTakenByUser: Record<string, boolean>;
  /** Affordability is computed off the action clock from the exact funding wallet. */
  rebuyAffordableByUser: Record<string, boolean>;
  addOnAffordableByUser: Record<string, boolean>;
  /** Phase 7 ICM: every observed live stack in chips, descending. */
  stacks: number[];
  /** Identity retained in-cache so a table can replace stale local stacks exactly. */
  stackByUser: Record<string, number>;
  /** Phase 7 ICM: every actual payout percentage by place (1st first). */
  payoutPct: number[];
  // ═══ V26 THE PRIZE LANDSCAPE (Dan 2026-08-28) ═══════════════════════════
  // "Horses should be able to see and have access to the prizes, and which
  //  bounties are left still, if top prizes are gone, or still there - that
  //  changes play."
  //
  // It does, and it is the sharpest read in a mystery bounty. Busting someone
  // draws a CHEST from a shrinking inventory: while the big ones are still in
  // there every elimination is a lottery ticket worth far more than its
  // average, and once they are claimed the same bust pays scraps and the
  // event collapses back toward a freezeout. A horse that cannot see the
  // inventory is playing the wrong tournament for half the night.
  /** mystery bounty: chests still unclaimed ('available') */
  mysteryChestsLeft: number;
  /** mystery bounty: MEAN value of an unclaimed chest, in cents — the honest
   *  EV of one elimination right now */
  mysteryMeanCents: number;
  /** mystery bounty: the largest chest still unclaimed, in cents */
  mysteryTopCents: number;
  /** mystery bounty: is the tournament's single biggest chest STILL LIVE?
   *  The difference between a lottery and a grind. */
  mysteryTopLive: boolean;
  /** PKO/mystery: mean live bounty per remaining player, in cents (0 = none) */
  meanBountyCents: number;
  /** V23: at the final table (MTT, ten or fewer left, in or at the money) */
  finalTable: boolean;
  /** V23 BLIND CLOCK: minutes until the next level (null = unknown/last level) */
  nextBlindInMin: number | null;
  /** V23 BLIND CLOCK: next level's bb as a multiple of the current bb (1 = flat) */
  nextBlindMult: number;
  // ═══ V37 SATELLITES (Dan 2026-09-02) ══════════════════════════════════════
  // "THE PLAY DIFFERENCE BETWEEN A SATELLITE WHERE ALL WINNERS GET THE SAME
  //  PRIZE AND A MTT WITH PRIZES PROGRESSIVELY PAYING MORE."
  //
  // A satellite's stored payout_structure is the ordinary MTT curve (40/25/
  // 18/10/7) — settlement ignores it and hands out `seats` identical tickets
  // in equal immutable ticket lines. So the brain was reading every satellite as an MTT
  // with a top-heavy ladder, and an MTT ladder says "chips up top are worth
  // more": the exact opposite of a satellite, where the K-th seat is worth
  // the first and every chip past a locked seat is worth NOTHING. payoutPct
  // below is REBUILT flat for a satellite; these fields say so.
  /** V37 BOUNTIES: live bounty per player, in cents, keyed by user id.
   *  "THIS PLAYS DIFFERENT WHEN A PLAYER HAS A LARGE BOUNTY ON THEIR HEAD."
   *  The mean alone cannot say whose head is worth the pot. */
  bountyByUser: Record<string, number>;
  /** this event awards identical tickets to the top `satelliteSeats` */
  satellite: boolean;
  /** seats (tickets) awarded — the real number of equal prizes */
  satelliteSeats: number;
}

export interface TournamentRowLite {
  /** V37: satellite columns (either target column may carry the link). */
  satellite_seats?: number | null;
  satellite_target_id?: string | null;
  satellite_target?: string | null;
  tournament_type: string | null;
  free_buy?: boolean | null;
  status?: string | null;
  game_type?: string | null;
  variant: string | null;
  spin_multiplier?: number | null;
  max_players: number | null;
  table_size: number | null;
  payout_structure: unknown;
  prize_pool: number | null;
  bounty_pool: number | null;
  buy_in_amount?: number | null;
  buy_in_fee?: number | null;
  bounty_amount?: number | null;
  starting_chips?: number | null;
  rebuy_cost?: number | null;
  rebuy_chips?: number | null;
  is_pko: boolean | null;
  is_bounty: boolean | null;
  is_mystery_bounty?: boolean | null;
  mystery_bounty_stage?: string | null;
  /** V23 blind clock inputs (all optional — absent means clock unknown). */
  blind_structure?: unknown;
  current_level?: number | null;
  level_started_at?: string | null;
  started_at?: string | null;
  late_reg_mins?: number | null;
  late_reg_levels?: number | null;
  is_reentry?: boolean | null;
  max_reentries?: number | null;
  is_rebuy?: boolean | null;
  rebuy_levels?: number | null;
  max_rebuys?: number | null;
  add_on_available?: boolean | null;
  addon_cost?: number | null;
  addon_chips?: number | null;
  addon_levels?: number | null;
  addon_period_started_at?: string | null;
  addon_period_ends_at?: string | null;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  THE SMALLEST AMOUNT THIS TOURNAMENT CAN PAY, IN CENTS (2026-09-12)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * One cent for a chip tournament, which is every tournament that has ever
   * run, and which is why every reader of this field defaults to 1 when it is
   * absent. One hundred for a Diamond tournament, because a Diamond does not
   * divide.
   *
   * NO SELECT POPULATES THIS YET, and that is deliberate rather than
   * forgotten. It is `fn_ca_tournament_unit_cents` on the SQL side, and
   * reading it here means joining clubs into the tournament read, which
   * belongs with the work that opens the Diamond tournament door rather than
   * with the arithmetic. The arithmetic is correct for both denominations
   * now; the field is the one wire left to connect, and the quote is already
   * waiting for it.
   */
  unit_cents?: number | null;
  addon_period_triggered?: boolean | null;
  prize_pool_finalized?: boolean | null;
  on_break?: boolean | null;
  break_started_at?: string | null;
  break_ends_at?: string | null;
  accelerated_mtt?: boolean | null;
  big_blind_ante?: boolean | null;
  authorized_to_register?: boolean | null;
}

/** One level as stored: canonical snake case, legacy camel case, or Spin seconds. */
interface BlindLevelRow {
  level?: number;
  small_blind?: number;
  smallBlind?: number;
  sb?: number;
  big_blind?: number;
  bigBlind?: number;
  bb?: number;
  ante?: number;
  duration?: number; // seconds
  duration_minutes?: number; // canonical minutes
  durationMinutes?: number; // legacy minutes
  duration_mins?: number; // original schema alias
  isBreak?: boolean;
  spinContinuation?: unknown;
}

export interface TournamentBlindState {
  currentLevel: number;
  currentSmallBlind: number;
  currentBigBlind: number;
  currentAnte: number;
  nextSmallBlind: number | null;
  nextBigBlind: number | null;
  nextAnte: number | null;
  levelDurationMin: number | null;
  levelElapsedMin: number | null;
  nextBlindInMin: number | null;
  nextBlindMult: number;
  levelIndexValid: boolean;
  timingStatus: 'complete' | 'missing' | 'stale' | 'future' | 'paused';
}

/** V23 pure: minutes until the next level and its bb multiple. Exported for
 *  tests. Returns nulls/1 whenever any input is missing or malformed —
 *  the blind clock degrades to "unknown", never to a guess. */
export function parseBlindStructure(structure: unknown): BlindLevelRow[] {
  try {
    const decoded = typeof structure === 'string' ? JSON.parse(structure) : structure;
    if (!Array.isArray(decoded)) return [];
    return decoded.filter((level): level is BlindLevelRow => !!level && typeof level === 'object');
  } catch {
    return [];
  }
}

function levelDurationMinutes(level: BlindLevelRow | undefined): number | null {
  if (!level) return null;
  const authoredMinutes = level.duration_minutes ?? level.durationMinutes ?? level.duration_mins;
  const duration =
    authoredMinutes != null ? Number(authoredMinutes) : Number(level.duration ?? 0) / 60;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

interface BlindStateOptions {
  isSpin?: boolean;
  totalChipsInPlay?: number;
  accelerated?: boolean;
  onBreak?: boolean;
}

function canonicalBlindLevel(level: BlindLevelRow | undefined): BlindLevelRow | null {
  if (!level || level.isBreak === true) return null;
  const smallBlind = Number(level.small_blind ?? level.smallBlind ?? level.sb);
  const bigBlind = Number(level.big_blind ?? level.bigBlind ?? level.bb);
  const ante = Math.max(0, Number(level.ante) || 0);
  if (!(smallBlind > 0) || !(bigBlind > 0)) return null;
  return { ...level, smallBlind, bigBlind, ante };
}

function resolveBlindLevel(
  levels: BlindLevelRow[],
  index: number,
  options: BlindStateOptions
): BlindLevelRow | null {
  if (!Number.isSafeInteger(index) || index < 0 || levels.length === 0) return null;
  if (index < levels.length) return canonicalBlindLevel(levels[index]);

  const canonicalLevels = levels.map((level) => canonicalBlindLevel(level) ?? level);
  const last = canonicalLevels[lastPlayableIndex(canonicalLevels)];
  if (options.isSpin) {
    // Mirror TournamentManagerBase exactly. New schedules carry a frozen
    // continuation receipt; old schedules predate that field and must follow
    // the canonical Spin ladder rather than the generic MTT escalator.
    const continuation =
      continueBookedSpinBlinds(last as never, index + 1) ?? spinBlindsForLevel(index + 1);
    return canonicalBlindLevel({
      ...last,
      level: index + 1,
      smallBlind: continuation.small,
      bigBlind: continuation.big,
      ante: 0,
    });
  }
  const baseDuration = levelDurationMinutes(last) ?? 10;
  const duration = options.accelerated
    ? acceleratedLevelMs(baseDuration * 60_000) / 60_000
    : baseDuration;
  const escalated = escalatedBlindLevel(
    last,
    index,
    canonicalLevels.length,
    duration,
    observedStepRatio(canonicalLevels.map((level) => Number(level.bigBlind ?? level.bb)))
  );
  const capped = capLevelToChipsInPlay(escalated, options.totalChipsInPlay);
  return canonicalBlindLevel({ ...escalated, ...capped });
}

/** Complete current/next blind state. Text JSON is the production shape. */
export function deriveBlindState(
  structure: unknown,
  currentLevel: number | null | undefined,
  levelStartedAt: string | null | undefined,
  nowMs: number,
  options: BlindStateOptions = {}
): TournamentBlindState {
  const none: TournamentBlindState = {
    currentLevel: 0,
    currentSmallBlind: 0,
    currentBigBlind: 0,
    currentAnte: 0,
    nextSmallBlind: null,
    nextBigBlind: null,
    nextAnte: null,
    levelDurationMin: null,
    levelElapsedMin: null,
    nextBlindInMin: null,
    nextBlindMult: 1,
    levelIndexValid: false,
    timingStatus: 'missing',
  };
  try {
    const levels = parseBlindStructure(structure);
    if (levels.length === 0) return none;
    const lvl =
      typeof currentLevel === 'number' && Number.isSafeInteger(currentLevel) && currentLevel >= 0
        ? currentLevel
        : null;
    if (lvl == null) return none;
    const cur = resolveBlindLevel(levels, lvl, options);
    if (!cur) return { ...none, currentLevel: lvl };
    let nextIndex = lvl + 1;
    while (nextIndex < levels.length && levels[nextIndex]?.isBreak === true) nextIndex++;
    const next = resolveBlindLevel(levels, nextIndex, options);
    const currentSmallBlind = Number(cur.smallBlind) || 0;
    const curBB = Number(cur.bigBlind) || 0;
    const currentAnte = Math.max(0, Number(cur.ante) || 0);
    const nextSmallRaw = next?.smallBlind;
    const nextBigRaw = next?.bigBlind;
    const nextSmallBlind = next && Number(nextSmallRaw) > 0 ? Number(nextSmallRaw) : null;
    const nextBB = next && Number(nextBigRaw) > 0 ? Number(nextBigRaw) : null;
    const nextAnte = next ? Math.max(0, Number(next.ante) || 0) : null;
    const authoredDuration = levelDurationMinutes(cur);
    const durMin =
      authoredDuration != null && options.accelerated
        ? acceleratedLevelMs(authoredDuration * 60_000) / 60_000
        : authoredDuration;
    const base = {
      ...none,
      currentLevel: lvl,
      currentSmallBlind,
      currentBigBlind: curBB,
      currentAnte,
      nextSmallBlind,
      nextBigBlind: nextBB,
      nextAnte,
      levelDurationMin: durMin,
      nextBlindMult: curBB > 0 && nextBB != null ? nextBB / curBB : 1,
      levelIndexValid: true,
    };
    if (options.onBreak) return { ...base, timingStatus: 'paused' };
    const startedMs = levelStartedAt ? Date.parse(levelStartedAt) : NaN;
    if (durMin == null || !Number.isFinite(startedMs)) return base;
    if (startedMs > nowMs + 5_000) return { ...base, timingStatus: 'future' };
    const elapsedMin = Math.max(0, (nowMs - startedMs) / 60_000);
    // STALE-CLOCK GUARD (2026-08-28 polish sweep): if the level has been
    // "about to end" for three whole level-lengths, the writer stopped
    // advancing current_level (a paused event, or a stalled manager). A
    // clock that reads zero forever would keep the M-zones on a permanently
    // shrunken M — unknown is the honest answer.
    if (elapsedMin > durMin * 3) {
      return { ...base, levelElapsedMin: elapsedMin, timingStatus: 'stale' };
    }
    const left = Math.max(0, durMin - elapsedMin);
    return {
      currentLevel: lvl,
      currentSmallBlind,
      currentBigBlind: curBB,
      currentAnte,
      nextSmallBlind,
      nextBigBlind: nextBB,
      nextAnte,
      levelDurationMin: durMin,
      levelElapsedMin: Math.max(0, elapsedMin),
      nextBlindInMin: next ? Math.round(left * 10) / 10 : null,
      nextBlindMult: base.nextBlindMult,
      levelIndexValid: true,
      timingStatus: 'complete',
    };
  } catch {
    return none;
  }
}

export function deriveBlindClock(
  structure: unknown,
  currentLevel: number | null | undefined,
  levelStartedAt: string | null | undefined,
  nowMs: number
): { nextBlindInMin: number | null; nextBlindMult: number } {
  const state = deriveBlindState(structure, currentLevel, levelStartedAt, nowMs);
  return { nextBlindInMin: state.nextBlindInMin, nextBlindMult: state.nextBlindMult };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HOW MANY PLAYERS ARE ACTUALLY AT THE TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This used to read `row.table_size ?? row.max_players ?? 9`, and that one
 * expression made every Heads-Up duel on the platform play MTT strategy.
 *
 * `tournaments.table_size` is `NOT NULL DEFAULT 9`, and no creation path wrote
 * it (fixed for the two that matter on 2026-08-27). `??` falls through on NULL
 * only — never on a DEFAULTED 9 — so the second operand was UNREACHABLE and
 * `max_players = 2` could not be seen. 10,315 heads-up rows sit at
 * `table_size = 9`, every one of them resolving to 'mtt', so HorseLogic applied
 * ICM pressure and bubble ranges to a two-handed game where one spot pays and
 * there is no bubble to be on.
 *
 * The fix is not to swap the operand order — that would have the same shape of
 * failure the other way round the moment a real MTT arrives with a bad
 * max_players. It is to stop treating either column as authoritative and take
 * the SMALLEST seat count the row actually asserts:
 *
 *   - a duel is a duel if EITHER column says two, so a legacy row whose
 *     table_size was defaulted to 9 is still read correctly from max_players.
 *     That is what makes this robust rather than merely correct going forward —
 *     the 10,315 existing rows are read right without a data migration;
 *   - a 100-player MTT with table_size 9 still yields 9, and 9 is not <= 2;
 *   - non-positive, NaN and NULL values are DISCARDED rather than winning, so a
 *     zero or a junk value cannot pull a full field down to a duel.
 *
 * Only when the row asserts nothing usable does it fall back to 9.
 */
export function seatsAtOneTable(row: {
  table_size?: number | null;
  max_players?: number | null;
}): number {
  const asserted = [row?.table_size, row?.max_players]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  return asserted.length > 0 ? Math.min(...asserted) : 9;
}

/** V26: one chest row as the inventory query returns it. */
export interface ChestRow {
  status?: string | null;
  amount_cents?: number | null;
}

export interface SatelliteEntitlementRow {
  position?: number | null;
  award_kind?: string | null;
  ticket_value?: number | null;
  remainder_value?: number | null;
}

export interface TournamentContextFidelity {
  mysteryInventory: 'known' | 'read_failed';
  satelliteEntitlements: 'known' | 'read_failed';
  entitlementRows: SatelliteEntitlementRow[];
}

/**
 * V26 pure: what the mystery-bounty inventory looks like RIGHT NOW.
 * Exported for tests. Everything degrades to zeros when there is no chest
 * system, which reads as "not a mystery bounty" downstream rather than as a
 * jackpot that happens to be empty.
 */
export function deriveBountyLandscape(chests: ChestRow[] | null | undefined): {
  mysteryChestsLeft: number;
  mysteryMeanCents: number;
  mysteryTopCents: number;
  mysteryTopLive: boolean;
} {
  const none = {
    mysteryChestsLeft: 0,
    mysteryMeanCents: 0,
    mysteryTopCents: 0,
    mysteryTopLive: false,
  };
  if (!Array.isArray(chests) || chests.length === 0) return none;
  let left = 0;
  let sum = 0;
  let top = 0;
  let topEver = 0;
  for (const c of chests) {
    const amt = Number(c?.amount_cents) || 0;
    if (amt <= 0) continue;
    // 'void' chests were never in play (the event ended early, or the
    // inventory was trimmed) - they are not part of any landscape.
    if (c?.status === 'void') continue;
    if (amt > topEver) topEver = amt;
    if (c?.status === 'available') {
      left++;
      sum += amt;
      if (amt > top) top = amt;
    }
  }
  if (left === 0) return { ...none, mysteryTopLive: false };
  return {
    mysteryChestsLeft: left,
    mysteryMeanCents: Math.round(sum / left),
    mysteryTopCents: top,
    // The single biggest chest the tournament ever held is still unclaimed.
    mysteryTopLive: topEver > 0 && top >= topEver,
  };
}

/** Pure derivation — unit-tested. */
export function deriveContext(
  row: TournamentRowLite,
  playersLeft: number,
  entrants: number,
  chipSum: number,
  /** V16 ICM: complete live stack list (any order; stored sorted descending). */
  liveStacks: number[] = [],
  /** V26: the mystery-bounty chest inventory, if this event has one. */
  chests: ChestRow[] = [],
  /** V26: live per-player bounties in cents (PKO), any order. */
  liveBounties: number[] = [],
  /** V37: what one target seat costs (buy-in + fee), 0 when unknown/none. */
  _satelliteTicketCost: number = 0,
  /** V37: live bounty per user id, cents. */
  bountyByUser: Record<string, number> = {},
  nowMs: number = Date.now(),
  fidelity: TournamentContextFidelity = {
    mysteryInventory: 'known',
    satelliteEntitlements: 'known',
    entitlementRows: [],
  },
  playerOptions: {
    stackByUser?: Record<string, number>;
    reloadsByUser?: Record<string, number>;
    horseRebuyCapByUser?: Record<string, number>;
    addOnTakenByUser?: Record<string, boolean>;
    rebuyAffordableByUser?: Record<string, boolean>;
    addOnAffordableByUser?: Record<string, boolean>;
    pendingRecoveryPlayers?: number;
  } = {}
): TournamentBrainContext {
  const type = (row.tournament_type || '').toUpperCase();
  // `variant` is the tournament format (freezeout, satellite, bounty, ...).
  // `game_type` is the actual poker ruleset (nlh, plo4, plo5, ...), and must
  // be the value bound to the live decision's gameVariant. Preferring
  // `variant` made every otherwise-complete production snapshot fail the
  // worker's canonical ruleset check (for example freezeout !== nlh).
  const gameVariant = (row.game_type || '').toLowerCase();
  const tournamentVariant = (row.variant || '').toLowerCase();
  const format: TournamentFormat =
    type === 'SPIN' || tournamentVariant === 'spin'
      ? 'spin'
      : seatsAtOneTable(row) <= 2
        ? 'hu_sng'
        : type === 'SNG'
          ? 'sng'
          : 'mtt';
  const rawMysteryStage = String(row.mystery_bounty_stage ?? '').toLowerCase();
  const mysteryBountyStage: TournamentBrainContext['mysteryBountyStage'] =
    row.is_mystery_bounty !== true
      ? 'none'
      : rawMysteryStage === 'pending' ||
          rawMysteryStage === 'active' ||
          rawMysteryStage === 'complete'
        ? rawMysteryStage
        : 'none';

  // V13: use the CANONICAL parser instead of a local JSON.parse. The old code
  // only understood the array shape [{place, percentage}] and silently scored
  // 0 paid spots for the object shape {"1": 100} that other services in this
  // repo write and read — which made inMoney and nearBubble permanently false
  // and left the whole bubble model inert for that tournament, degrading
  // quietly so nobody would ever notice. It also counted [null, null] as two
  // paid places. parsePayoutStructure rejects a structure with no place 1, a
  // negative percentage, or percentages summing to zero, and for a Spin with a
  // missing structure resolvePayoutStructure rebuilds it from the multiplier
  // rather than assuming winner-take-all.
  let places = resolvePayoutStructure(row as PayoutSubject);

  // ═══ V37 SATELLITE: the prize curve is FLAT, whatever the row says ═══
  // Once the guarantee-funding rail finalizes the pool, the atomic database
  // settlement awards floor(pool / ticket) equal tickets. Before finalization,
  // the advertised guarantee remains the minimum expected count. A cash
  // remainder goes to the single next finisher and is carried as one small
  // extra place so the model does not pretend the bubble pays nothing at all.
  const configuredSeats = Math.max(0, Math.floor(Number(row.satellite_seats) || 0));
  const hasTarget = !!(row.satellite_target_id || row.satellite_target);
  const isSatellite =
    format !== 'spin' &&
    (configuredSeats > 0 || hasTarget || tournamentVariant === 'satellite' || type === 'SATELLITE');
  let satelliteSeats = 0;
  let satelliteAwardDepth = 0;
  let satellitePlanValid = false;
  if (isSatellite) {
    const entitlements = fidelity.entitlementRows
      .map((entitlement) => ({
        position: Number(entitlement.position),
        awardKind: String(entitlement.award_kind ?? ''),
        ticketValue: Math.max(0, Number(entitlement.ticket_value) || 0),
        remainderValue: Math.max(0, Number(entitlement.remainder_value) || 0),
      }))
      .sort((left, right) => left.position - right.position);
    satellitePlanValid =
      row.prize_pool_finalized === true &&
      fidelity.satelliteEntitlements === 'known' &&
      entitlements.length > 0 &&
      entitlements.every(
        (entitlement, index) =>
          Number.isSafeInteger(entitlement.position) &&
          entitlement.position === index + 1 &&
          ['seat_or_cash', 'cash'].includes(entitlement.awardKind) &&
          entitlement.ticketValue + entitlement.remainderValue > 0
      );
    if (satellitePlanValid) {
      satelliteAwardDepth = entitlements.length;
      satelliteSeats = entitlements.filter(
        (entitlement) => entitlement.awardKind === 'seat_or_cash'
      ).length;
      const totalValue = entitlements.reduce(
        (sum, entitlement) => sum + entitlement.ticketValue + entitlement.remainderValue,
        0
      );
      places = entitlements.map((entitlement) => ({
        place: entitlement.position,
        percentage:
          totalValue > 0
            ? (100 * (entitlement.ticketValue + entitlement.remainderValue)) / totalValue
            : 0,
      }));
    } else {
      // The configured seat promise is useful as a provisional display fact,
      // but it is not the immutable entry-close award depth and therefore can
      // never make this context complete.
      satelliteSeats = configuredSeats;
      satelliteAwardDepth = configuredSeats;
      places =
        configuredSeats > 0
          ? Array.from({ length: configuredSeats }, (_, index) => ({
              place: index + 1,
              percentage: 100 / configuredSeats,
            }))
          : [];
    }
  }

  const spotsPaid =
    isSatellite && satelliteAwardDepth > 0
      ? satelliteAwardDepth
      : places && places.length > 0
        ? places.length
        : 0;

  const inMoney = spotsPaid > 0 && playersLeft > 0 && playersLeft <= spotsPaid;
  const nearBubble =
    spotsPaid > 0 &&
    !inMoney &&
    playersLeft <= Math.max(spotsPaid + 1, Math.ceil(spotsPaid * 1.15));

  const prizePool = Number(row.prize_pool) || 0;
  const bountyPool = Number(row.bounty_pool) || 0;
  const bountyFactor =
    (row.is_pko || row.is_bounty) && prizePool + bountyPool > 0
      ? bountyPool / (prizePool + bountyPool)
      : 0;

  // Phase 7 ICM inputs preserve every place and every observed player. The
  // former nine-place tail lump and 200-stack quantile sample preserved mass
  // but destroyed cardinality: a 1,000-left satellite paying 200 seats could
  // look like 200 players for 200 seats and therefore report certain survival.
  // The bounded ICM implementation now controls work with sampling trials,
  // never by changing the tournament being priced.
  const sortedPlaces = (places ?? [])
    .slice()
    .sort((a, b) => a.place - b.place)
    .map((p) => p.percentage)
    .filter((p) => p > 0);
  const payoutPct = sortedPlaces;
  const allLive = liveStacks.filter((s) => isFinite(s) && s > 0).sort((a, b) => b - a);
  const stacks = allLive;

  const seatsPerTable = seatsAtOneTable(row);
  const allLiveAscending = [...allLive].sort((a, b) => a - b);
  const medianStackChips =
    allLiveAscending.length === 0
      ? 0
      : allLiveAscending.length % 2 === 1
        ? allLiveAscending[Math.floor(allLiveAscending.length / 2)]
        : (allLiveAscending[allLiveAscending.length / 2 - 1] +
            allLiveAscending[allLiveAscending.length / 2]) /
          2;
  const status = (row.status || '').toUpperCase();
  const currentLevelValid =
    row.current_level != null && Number.isSafeInteger(row.current_level) && row.current_level >= 0;
  const currentLevel = currentLevelValid ? (row.current_level as number) : 0;
  const nonNegativeIntegerOrNull = (value: number | null | undefined): boolean =>
    value == null || (Number.isSafeInteger(value) && value >= 0);
  const nonNegativeNumberOrNull = (value: number | null | undefined): boolean =>
    value == null || (Number.isFinite(value) && value >= 0);
  const entryTermsValid =
    nonNegativeIntegerOrNull(row.late_reg_levels) &&
    nonNegativeIntegerOrNull(row.rebuy_levels) &&
    nonNegativeNumberOrNull(row.late_reg_mins) &&
    nonNegativeIntegerOrNull(row.max_players);
  // Match fn_tournament_late_registration_open literally: a non-null
  // late_reg_levels value wins (including zero), then rebuy_levels.
  const lateRegLevelCap = Number(row.late_reg_levels ?? row.rebuy_levels ?? 0);
  const lateRegMinutes = Number(row.late_reg_mins ?? 0);
  const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
  const elapsedTournamentMin = Number.isFinite(startedMs)
    ? Math.max(0, (nowMs - startedMs) / 60_000)
    : Infinity;
  // Mirror the database entry-window authority: a positive level cap wins;
  // the minute deadline is only the legacy fallback when no level cap exists.
  // Both windows close at their exact boundary and once the pool is final.
  const prizePoolFinalized = row.prize_pool_finalized === true;
  const entryCapacity = Number(row.max_players ?? 0);
  const hasEntryCapacity = entryCapacity <= 0 || entrants < entryCapacity;
  const lateRegistrationOpen =
    entryTermsValid &&
    status === 'RUNNING' &&
    !prizePoolFinalized &&
    hasEntryCapacity &&
    (lateRegLevelCap > 0
      ? currentLevel < lateRegLevelCap
      : lateRegMinutes > 0 && Number.isFinite(startedMs) && elapsedTournamentMin < lateRegMinutes);
  const registrationOpen =
    hasEntryCapacity &&
    (status === 'ANNOUNCED' || status === 'REGISTERING' || lateRegistrationOpen);
  const addOnStartedMs = row.addon_period_started_at
    ? Date.parse(row.addon_period_started_at)
    : NaN;
  const addOnEndsMs = row.addon_period_ends_at ? Date.parse(row.addon_period_ends_at) : NaN;
  const addOnPeriodOpen =
    row.add_on_available === true &&
    row.addon_period_triggered === true &&
    !prizePoolFinalized &&
    status === 'RUNNING' &&
    Number.isFinite(addOnStartedMs) &&
    Number.isFinite(addOnEndsMs) &&
    nowMs >= addOnStartedMs &&
    nowMs < addOnEndsMs;
  // Match fn_ca_tournament_rebuy_window: positive rebuy_levels, then positive
  // late_reg_levels, and only then the timed fallback.
  const rebuyLevels = Number(row.rebuy_levels ?? 0);
  const lateRegLevels = Number(row.late_reg_levels ?? 0);
  const rebuyLevelCap = rebuyLevels > 0 ? rebuyLevels : lateRegLevels > 0 ? lateRegLevels : 0;
  const levelPurchaseWindowOpen =
    entryTermsValid && rebuyLevelCap > 0 && currentLevelValid && currentLevel < rebuyLevelCap;
  const timedPurchaseWindowOpen =
    rebuyLevelCap <= 0 &&
    lateRegMinutes > 0 &&
    Number.isFinite(startedMs) &&
    elapsedTournamentMin < lateRegMinutes;
  const entryPurchaseWindowOpen =
    entryTermsValid &&
    status === 'RUNNING' &&
    !prizePoolFinalized &&
    (levelPurchaseWindowOpen || timedPurchaseWindowOpen || addOnPeriodOpen);
  const reentryOpen = row.is_reentry === true && entryPurchaseWindowOpen;
  const rebuyOpen = row.is_rebuy === true && entryPurchaseWindowOpen;
  const blindState = deriveBlindState(
    row.blind_structure,
    row.current_level,
    row.level_started_at,
    nowMs,
    {
      isSpin: format === 'spin',
      totalChipsInPlay: chipSum,
      accelerated: row.accelerated_mtt === true && !lateRegistrationOpen,
      onBreak: row.on_break === true,
    }
  );
  const anteType: TournamentAnteType =
    row.big_blind_ante === true
      ? 'big_blind'
      : blindState.currentAnte > 0 || (blindState.nextAnte ?? 0) > 0
        ? 'per_player'
        : 'none';

  const contextIssues: string[] = [];
  if (!type) contextIssues.push('tournament_type_missing');
  if (!status) contextIssues.push('tournament_status_missing');
  if (!gameVariant) contextIssues.push('game_variant_missing');
  if (!(playersLeft > 0) || entrants < playersLeft) contextIssues.push('player_population_invalid');
  if (Math.max(0, Math.floor(Number(playerOptions.pendingRecoveryPlayers) || 0)) > 0) {
    // A player with a durable, unexpired recovery prompt is not eliminated,
    // but has no positive stack that an ICM calculation can price yet. Keep
    // the lifecycle count honest and fail closed until accept/decline/expiry
    // turns that pending option into a positive stack or a completed bust.
    contextIssues.push('live_field_recovery_pending');
  }
  if (spotsPaid <= 0) contextIssues.push('payout_or_ticket_structure_missing');
  if (allLive.length === 0) contextIssues.push('live_stack_distribution_missing');
  if (allLive.length !== playersLeft) {
    contextIssues.push('live_field_stack_cardinality_mismatch');
  }
  if (
    !blindState.levelIndexValid ||
    blindState.currentSmallBlind <= 0 ||
    blindState.currentBigBlind <= 0
  ) {
    contextIssues.push('blind_structure_or_level_invalid');
  }
  if (blindState.timingStatus !== 'complete') {
    contextIssues.push(`level_timing_${blindState.timingStatus}`);
  }
  if (!entryTermsValid) contextIssues.push('entry_window_terms_invalid');
  if (!(seatsPerTable >= 2 && seatsPerTable <= 10)) {
    contextIssues.push('seats_per_table_invalid');
  }
  if (
    (blindState.nextSmallBlind == null) !== (blindState.nextBigBlind == null) ||
    !Number.isFinite(blindState.nextBlindMult) ||
    blindState.nextBlindMult < 1
  ) {
    contextIssues.push('next_blind_level_invalid');
  }
  if (
    typeof row.is_reentry !== 'boolean' ||
    typeof row.is_rebuy !== 'boolean' ||
    typeof row.add_on_available !== 'boolean' ||
    typeof row.addon_period_triggered !== 'boolean' ||
    typeof row.prize_pool_finalized !== 'boolean' ||
    typeof row.on_break !== 'boolean' ||
    typeof row.big_blind_ante !== 'boolean' ||
    typeof row.accelerated_mtt !== 'boolean'
  ) {
    contextIssues.push('reentry_rebuy_or_addon_state_missing');
  }
  if (typeof row.authorized_to_register !== 'boolean') {
    contextIssues.push('registration_state_missing');
  }
  if (
    typeof row.is_pko !== 'boolean' ||
    typeof row.is_bounty !== 'boolean' ||
    typeof row.is_mystery_bounty !== 'boolean'
  ) {
    contextIssues.push('bounty_type_state_missing');
  }
  if (row.is_mystery_bounty === true && mysteryBountyStage === 'none') {
    contextIssues.push('mystery_bounty_stage_missing');
  }
  const purchaseQuote = tournamentPurchaseQuote(row);
  if (
    row.add_on_available === true &&
    (purchaseQuote.addOnCostCents === null || purchaseQuote.addOnChips === null)
  ) {
    contextIssues.push('addon_terms_missing');
  }
  const recoveryCost = (purchaseQuote.recoveryCostCents ?? 0) / 100;
  const recoveryChips = purchaseQuote.recoveryChips ?? 0;
  if (
    (row.is_reentry === true || row.is_rebuy === true) &&
    (!(recoveryCost > 0) || !(recoveryChips > 0))
  ) {
    contextIssues.push('reentry_or_rebuy_terms_missing');
  }
  if (
    (row.is_reentry === true && !nonNegativeIntegerOrNull(row.max_reentries)) ||
    (row.is_rebuy === true && !nonNegativeIntegerOrNull(row.max_rebuys))
  ) {
    contextIssues.push('reentry_or_rebuy_limits_invalid');
  }
  if (isSatellite && fidelity.satelliteEntitlements === 'read_failed') {
    contextIssues.push('satellite_entitlement_read_failed');
  }
  if (isSatellite && !satellitePlanValid) {
    contextIssues.push('satellite_award_depth_unavailable');
  }
  if (row.is_mystery_bounty === true && fidelity.mysteryInventory === 'read_failed') {
    contextIssues.push('mystery_bounty_inventory_unavailable');
  }
  if (contextIssues.length > 0) contextIssues.unshift(TOURNAMENT_CONTEXT_INCOMPLETE);

  return {
    schemaVersion: 1,
    contextStatus: contextIssues.length === 0 ? 'complete' : 'incomplete',
    contextIssues,
    format,
    tournamentType: type,
    tournamentStatus: status,
    gameVariant,
    entrants: Math.max(entrants, playersLeft),
    playersLeft,
    spotsPaid,
    inMoney,
    nearBubble,
    avgStackChips: playersLeft > 0 ? chipSum / playersLeft : 0,
    medianStackChips,
    seatsPerTable,
    currentLevel: blindState.currentLevel,
    currentSmallBlind: blindState.currentSmallBlind,
    currentBigBlind: blindState.currentBigBlind,
    currentAnte: blindState.currentAnte,
    anteType,
    nextSmallBlind: blindState.nextSmallBlind,
    nextBigBlind: blindState.nextBigBlind,
    nextAnte: blindState.nextAnte,
    levelDurationMin: blindState.levelDurationMin,
    levelElapsedMin: blindState.levelElapsedMin,
    registrationOpen,
    lateRegistrationOpen,
    registrationRequiresAuthorization: row.authorized_to_register === true,
    isPko: row.is_pko === true,
    isBounty: row.is_bounty === true,
    isMysteryBounty: row.is_mystery_bounty === true,
    mysteryBountyStage,
    reentryAllowed: row.is_reentry === true,
    reentryOpen,
    maxReentries:
      row.max_reentries != null &&
      Number.isFinite(Number(row.max_reentries)) &&
      Number(row.max_reentries) >= 0
        ? Math.floor(Number(row.max_reentries))
        : null,
    rebuyAllowed: row.is_rebuy === true,
    rebuyOpen,
    maxRebuys:
      row.max_rebuys != null &&
      Number.isFinite(Number(row.max_rebuys)) &&
      Number(row.max_rebuys) >= 0
        ? Math.floor(Number(row.max_rebuys))
        : null,
    addOnAvailable: row.add_on_available === true,
    addOnPeriodOpen,
    addOnCost: purchaseQuote.addOnCostCents === null ? null : purchaseQuote.addOnCostCents / 100,
    addOnChips: purchaseQuote.addOnChips,
    addOnLevels:
      row.addon_levels != null &&
      Number.isFinite(Number(row.addon_levels)) &&
      Number(row.addon_levels) >= 0
        ? Math.floor(Number(row.addon_levels))
        : null,
    onBreak: row.on_break === true,
    handForHandExpected:
      format === 'mtt' &&
      playersLeft === spotsPaid + 1 &&
      playersLeft > seatsPerTable &&
      (!isSatellite || satellitePlanValid),
    bountyFactor: Math.max(0, Math.min(1, bountyFactor)),
    prizePoolCents: Math.round(Math.max(0, prizePool) * 100),
    bountyPoolCents: Math.round(Math.max(0, bountyPool) * 100),
    buyInCents:
      row.buy_in_amount != null && Number.isFinite(Number(row.buy_in_amount))
        ? Math.round(
            Math.max(0, Number(row.buy_in_amount) + Math.max(0, Number(row.buy_in_fee) || 0)) * 100
          )
        : null,
    startingStackChips:
      row.starting_chips != null && Number.isFinite(Number(row.starting_chips))
        ? Math.max(0, Number(row.starting_chips))
        : null,
    rebuyCostCents: purchaseQuote.recoveryCostCents,
    rebuyChips: purchaseQuote.recoveryChips,
    rebuyPrizeContributionCents: purchaseQuote.recoveryPrizeContributionCents,
    rebuyBountyContributionCents: purchaseQuote.recoveryBountyContributionCents,
    reloadsByUser: { ...(playerOptions.reloadsByUser ?? {}) },
    horseRebuyCapByUser: { ...(playerOptions.horseRebuyCapByUser ?? {}) },
    addOnTakenByUser: { ...(playerOptions.addOnTakenByUser ?? {}) },
    rebuyAffordableByUser: { ...(playerOptions.rebuyAffordableByUser ?? {}) },
    addOnAffordableByUser: { ...(playerOptions.addOnAffordableByUser ?? {}) },
    stacks,
    stackByUser: { ...(playerOptions.stackByUser ?? {}) },
    payoutPct,
    ...deriveBountyLandscape(chests),
    meanBountyCents:
      liveBounties.length > 0
        ? Math.round(liveBounties.reduce((a, b) => a + (Number(b) || 0), 0) / liveBounties.length)
        : 0,
    finalTable: format === 'mtt' && playersLeft >= 2 && playersLeft <= seatsPerTable,
    nextBlindInMin: blindState.nextBlindInMin,
    nextBlindMult: blindState.nextBlindMult,
    satellite: isSatellite,
    satelliteSeats,
    bountyByUser,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_TIMEOUT_MS = 5000;
const STUCK_MS = 60_000;
const TTL_MS = 20_000;
const STALE_MS = 60_000;
const MAX_CACHED = 500;

interface CacheEntry {
  ctx: TournamentBrainContext | null;
  lastSuccessAt: number;
  lastAttemptAt: number;
  lastFailureIssue: string | null;
  inFlight: boolean;
  generation: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Lifecycle-owned refresh entrypoint. It returns the last known context (or
 * null before the first fetch resolves) and starts a background refresh when
 * stale. The action clock calls only `peekTournamentBrainContext`.
 */
export function refreshTournamentBrainContext(tournamentId: string): TournamentBrainContext | null {
  const now = Date.now();
  let e = cache.get(tournamentId);
  if (!e) {
    // V29 AUDIT FIX (was LOW in the wire audit): .clear() dropped EVERY live
    // tournament's context at once. Evict the stalest quarter instead so a
    // fleet-wide cache reset cannot erase all known context simultaneously.
    if (cache.size >= MAX_CACHED) {
      const entries = [...cache.entries()].sort(
        (a, b) =>
          Math.max(a[1].lastSuccessAt, a[1].lastAttemptAt) -
          Math.max(b[1].lastSuccessAt, b[1].lastAttemptAt)
      );
      for (let i = 0; i < Math.ceil(entries.length / 4); i++) cache.delete(entries[i][0]);
    }
    e = {
      ctx: null,
      lastSuccessAt: 0,
      lastAttemptAt: 0,
      lastFailureIssue: null,
      inFlight: false,
      generation: 0,
    };
    cache.set(tournamentId, e);
  }
  // V13: `inFlight` is only cleared in refresh()'s finally, which never runs
  // if the promise never settles. One hung Supabase fetch used to pin the flag
  // for the process lifetime and freeze that tournament's ICM context — or
  // leave it null forever after the first attempt. The stuck guard lets a later
  // call retry while Phase 6 exposes the incomplete state in the snapshot.
  const stuck = e.inFlight && now - e.lastAttemptAt > STUCK_MS;
  if ((!e.inFlight || stuck) && now - e.lastAttemptAt > TTL_MS) {
    e.inFlight = true;
    e.lastAttemptAt = now;
    e.generation += 1;
    void refresh(tournamentId, e, e.generation);
  }
  return e.ctx;
}

/**
 * Backward-compatible lifecycle refresh entry point. New engine lifecycle
 * code should use refreshTournamentBrainContext so a call site cannot mistake
 * this for a network-free read.
 */
export function getTournamentBrainContext(tournamentId: string): TournamentBrainContext | null {
  return refreshTournamentBrainContext(tournamentId);
}

/** Pure cache read. This function never starts IO and is safe on an action clock. */
export function peekTournamentBrainContext(tournamentId: string): TournamentBrainContext | null {
  return cache.get(tournamentId)?.ctx ?? null;
}

export interface TournamentBrainContextSnapshot {
  context: TournamentBrainContext | null;
  status: TournamentContextStatus;
  issues: string[];
  ageMs: number | null;
}

/**
 * Status-bearing synchronous read for the horse decision path. A cache miss
 * is a tournament in `warming`, never an empty object that looks like cash.
 */
export function getTournamentBrainContextSnapshot(
  tournamentId: string,
  nowMs: number = Date.now()
): TournamentBrainContextSnapshot {
  // Deliberately do not call refreshTournamentBrainContext here. Decision
  // snapshots are constructed on the action clock; lifecycle heartbeat/start
  // owns every Supabase refresh and this path only observes the cache.
  const context = peekTournamentBrainContext(tournamentId);
  const entry = cache.get(tournamentId);
  if (!entry) {
    return {
      context: null,
      status: 'incomplete',
      issues: [TOURNAMENT_CONTEXT_INCOMPLETE, 'tournament_context_refresh_not_started'],
      ageMs: null,
    };
  }
  if (!context || entry.lastSuccessAt <= 0) {
    const warming = entry.inFlight && entry.lastAttemptAt > 0;
    return {
      context: null,
      status: warming ? 'warming' : 'incomplete',
      issues: [
        TOURNAMENT_CONTEXT_INCOMPLETE,
        warming
          ? 'tournament_context_warming'
          : (entry.lastFailureIssue ?? 'tournament_context_refresh_not_started'),
      ],
      ageMs: null,
    };
  }
  const ageMs = Math.max(0, nowMs - entry.lastSuccessAt);
  if (ageMs > STALE_MS) {
    return {
      context,
      status: 'stale',
      issues: [
        TOURNAMENT_CONTEXT_INCOMPLETE,
        'tournament_context_stale',
        ...context.contextIssues.filter((issue) => issue !== TOURNAMENT_CONTEXT_INCOMPLETE),
      ],
      ageMs,
    };
  }
  return {
    context,
    status: context.contextStatus,
    issues: [...context.contextIssues],
    ageMs,
  };
}

/** Test hook. */
export function __clearTournamentBrainCache(): void {
  cache.clear();
}

async function withRefreshTimeout<T>(operation: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('tournament context refresh timed out')),
      REFRESH_TIMEOUT_MS
    );
    timer.unref?.();
    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

interface TournamentPlayerContextRow {
  user_id?: string | null;
  club_id?: string | null;
  chips: number | null;
  status: string | null;
  current_bounty: number | null;
  rebuys?: number | null;
  add_on?: boolean | null;
  rebuy_prompt_until?: string | null;
}

interface TournamentFundingRow {
  user_id?: string | null;
  club_id?: string | null;
  chip_balance?: number | string | null;
}

interface TournamentPurchaseQuote {
  recoveryCostCents: number | null;
  recoveryChips: number | null;
  recoveryPrizeContributionCents: number | null;
  recoveryBountyContributionCents: number | null;
  addOnCostCents: number | null;
  addOnChips: number | null;
}

/** Mirror the canonical RPC's whole-unit price, fee and bounty split. */
function tournamentPurchaseQuote(row: TournamentRowLite): TournamentPurchaseQuote {
  const finite = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const buyIn = finite(row.buy_in_amount) ?? 0;
  const buyInFee = finite(row.buy_in_fee) ?? 0;
  const startingChips = finite(row.starting_chips);
  const configuredRecovery = finite(row.rebuy_cost);
  const recoveryUnits = Math.round(
    configuredRecovery !== null && configuredRecovery > 0 ? configuredRecovery : buyIn
  );
  const recoveryCostCents = recoveryUnits > 0 ? recoveryUnits * 100 : null;
  let recoveryPrizeContributionCents: number | null = null;
  let recoveryBountyContributionCents: number | null = null;
  if (recoveryCostCents !== null) {
    const feeRatio = tournamentFeeRatio(buyIn, buyInFee);
    /**
     * The recovery fee is the ratio, capped at ten percent, truncated DOWN to
     * the smallest amount this tournament can pay. It used to truncate to a
     * cent, because a cent was hard-coded as that smallest amount; a 10
     * Diamond rebuy at a 10/110 ratio then produced a 0.90 fee and dropped
     * 9.10 Diamonds into the prize pool, which is not an amount this estate
     * can pay, store or reserve.
     *
     * This is not a new rake rate. It is the same ratio, the same cap and the
     * same downward truncation, told what a unit is instead of assuming one.
     * `Math.floor(x / 1) * 1` is `x`, so the chip quote is unchanged by
     * construction rather than by inspection.
     *
     * The cap is floored too: a cap that is not on the grid is not a cap the
     * fee can honour. Mirrors fn_ca_recovery_fee_cents.
     */
    const unitCents =
      Number.isSafeInteger(Number(row.unit_cents)) && Number(row.unit_cents) >= 1
        ? Number(row.unit_cents)
        : 1;
    const floorToUnit = (cents: number) => unitFloorCents(cents, unitCents);
    const feeCents = recoveryFeeCents(recoveryCostCents, feeRatio, unitCents);
    const netCents = Math.max(0, recoveryCostCents - feeCents);
    // The head is floored to the same unit, so what is left for the prize is
    // whole by construction rather than by luck.
    const bountyHeadCents =
      row.is_bounty === true || row.is_pko === true || row.is_mystery_bounty === true
        ? floorToUnit(Math.min(netCents, Math.round((finite(row.bounty_amount) ?? 0) * 100)))
        : 0;
    recoveryBountyContributionCents = bountyHeadCents;
    recoveryPrizeContributionCents = netCents - bountyHeadCents;
  }

  const configuredAddOn = finite(row.addon_cost);
  const addOnUnits = Math.round(
    configuredAddOn !== null && configuredAddOn > 0 ? configuredAddOn : buyIn
  );
  const configuredRecoveryChips = finite(row.rebuy_chips);
  const configuredAddOnChips = finite(row.addon_chips);
  const recoveryChips = Math.round(
    configuredRecoveryChips !== null && configuredRecoveryChips > 0
      ? configuredRecoveryChips
      : (startingChips ?? 0)
  );
  const addOnChips = Math.round(
    configuredAddOnChips !== null && configuredAddOnChips > 0
      ? configuredAddOnChips
      : (startingChips ?? 0)
  );
  return {
    recoveryCostCents,
    recoveryChips: recoveryChips > 0 ? recoveryChips : null,
    recoveryPrizeContributionCents,
    recoveryBountyContributionCents,
    addOnCostCents: addOnUnits > 0 ? addOnUnits * 100 : null,
    addOnChips: addOnChips > 0 ? addOnChips : null,
  };
}

async function readTournamentFunding(
  players: TournamentPlayerContextRow[],
  row: TournamentRowLite
): Promise<{
  complete: boolean;
  rebuyAffordableByUser: Record<string, boolean>;
  addOnAffordableByUser: Record<string, boolean>;
}> {
  const clubByUser = new Map<string, string>();
  for (const player of players) {
    const status = String(player.status ?? '').toLowerCase();
    if (status === 'eliminated' || status === 'busted' || status === 'unregistered') continue;
    if (typeof player.user_id !== 'string' || !player.user_id) continue;
    if (typeof player.club_id !== 'string' || !player.club_id) continue;
    clubByUser.set(player.user_id, player.club_id);
  }
  const quote = tournamentPurchaseQuote(row);
  const rebuyAffordableByUser: Record<string, boolean> = {};
  const addOnAffordableByUser: Record<string, boolean> = {};
  for (const userId of clubByUser.keys()) {
    rebuyAffordableByUser[userId] = false;
    addOnAffordableByUser[userId] = false;
  }
  const funding = await selectInChunks<TournamentFundingRow>(
    [...clubByUser.keys()],
    (batch) => {
      const clubs = [
        ...new Set(batch.map((userId) => clubByUser.get(userId)).filter(Boolean)),
      ] as string[];
      return supabase
        .from('club_members')
        .select('user_id, club_id, chip_balance')
        .in('user_id', batch)
        .in('club_id', clubs);
    },
    'TournamentBrainContext.recoveryFunding'
  );
  if (!funding.complete) {
    return { complete: false, rebuyAffordableByUser: {}, addOnAffordableByUser: {} };
  }
  for (const member of funding.rows) {
    const userId = typeof member.user_id === 'string' ? member.user_id : '';
    const clubId = typeof member.club_id === 'string' ? member.club_id : '';
    if (!userId || clubByUser.get(userId) !== clubId) continue;
    const balance = Number(member.chip_balance);
    if (!Number.isFinite(balance) || balance < 0) {
      return { complete: false, rebuyAffordableByUser: {}, addOnAffordableByUser: {} };
    }
    const balanceCents = Math.round(balance * 100);
    rebuyAffordableByUser[userId] =
      quote.recoveryCostCents !== null && balanceCents >= quote.recoveryCostCents;
    addOnAffordableByUser[userId] =
      quote.addOnCostCents !== null && balanceCents >= quote.addOnCostCents;
  }
  return { complete: true, rebuyAffordableByUser, addOnAffordableByUser };
}

/**
 * Read the complete roster rather than relabeling PostgREST's first page as
 * the field. Scheduled events permit 10,000 entrants; ordinary fields still
 * cost one request, while larger fields fetch stable id-ordered pages.
 */
async function readTournamentPlayerContext(tournamentId: string): Promise<{
  data: TournamentPlayerContextRow[] | null;
  error: { message: string } | null;
}> {
  const PAGE = 1_000;
  const columns =
    'user_id, club_id, chips, status, current_bounty, rebuys, add_on, rebuy_prompt_until';
  const first = await supabase
    .from('tournament_players')
    .select(columns, { count: 'exact' })
    .eq('tournament_id', tournamentId)
    .order('id', { ascending: true })
    .range(0, PAGE - 1);
  if (first.error) return { data: null, error: first.error };
  if (first.count == null || first.count < 0 || first.count > 10_000) {
    return {
      data: null,
      error: { message: `invalid tournament roster count: ${String(first.count)}` },
    };
  }
  const rows = [...((first.data ?? []) as TournamentPlayerContextRow[])];
  const pageCount = Math.ceil(first.count / PAGE);
  if (pageCount > 1) {
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, offset) => {
        const page = offset + 1;
        return supabase
          .from('tournament_players')
          .select(columns)
          .eq('tournament_id', tournamentId)
          .order('id', { ascending: true })
          .range(page * PAGE, (page + 1) * PAGE - 1);
      })
    );
    const failed = rest.find((result) => result.error);
    if (failed?.error) return { data: null, error: failed.error };
    for (const page of rest) rows.push(...((page.data ?? []) as TournamentPlayerContextRow[]));
  }
  if (rows.length !== first.count) {
    return {
      data: null,
      error: {
        message: `tournament roster truncated: expected ${first.count}, read ${rows.length}`,
      },
    };
  }
  return { data: rows, error: null };
}

async function refresh(tournamentId: string, e: CacheEntry, generation: number): Promise<void> {
  const publishFailure = (issue: string): void => {
    if (e.generation === generation) e.lastFailureIssue = issue;
  };

  try {
    // Core tournament truth and per-player wallet truth have separate failure
    // domains. A wallet timeout must invalidate affordability immediately,
    // but it must not discard a fresh field/payout/blind snapshot and thereby
    // disable every unrelated tournament layer. Generation fencing prevents
    // either timed-out request from publishing over a newer refresh.
    const [tRes, pRes, cRes, entitlementRes] = await withRefreshTimeout(
      Promise.all([
        supabase
          .from('tournaments')
          .select(
            'tournament_type, status, game_type, variant, free_buy, max_players, table_size, payout_structure, spin_multiplier, prize_pool, prize_pool_finalized, bounty_pool, buy_in_amount, buy_in_fee, starting_chips, rebuy_cost, rebuy_chips, bounty_amount, is_pko, is_bounty, is_mystery_bounty, mystery_bounty_stage, blind_structure, current_level, level_started_at, started_at, late_reg_mins, late_reg_levels, is_reentry, max_reentries, is_rebuy, rebuy_levels, max_rebuys, add_on_available, addon_cost, addon_chips, addon_levels, addon_period_triggered, addon_period_started_at, addon_period_ends_at, on_break, break_started_at, break_ends_at, accelerated_mtt, big_blind_ante, authorized_to_register, satellite_seats, satellite_target_id, satellite_target'
          )
          .eq('id', tournamentId)
          .maybeSingle(),
        readTournamentPlayerContext(tournamentId),
        supabase
          .from('tournament_bounty_chests')
          .select('status, amount_cents')
          .eq('tournament_id', tournamentId)
          .limit(2000),
        supabase
          .from('tournament_satellite_entitlements')
          .select('position, award_kind, ticket_value, remainder_value')
          .eq('tournament_id', tournamentId)
          .order('position', { ascending: true })
          .limit(5000),
      ])
    );

    if (tRes.error) throw new Error(`tournament read failed: ${tRes.error.message}`);
    if (pRes.error) throw new Error(`tournament players read failed: ${pRes.error.message}`);
    if (!tRes.data) {
      reportError(
        new Error(`tournament ${tournamentId} read returned no row`),
        'TournamentBrainContext.missing'
      );
      publishFailure('tournament_context_missing');
      return;
    }

    const rows = (pRes.data ?? []) as TournamentPlayerContextRow[];
    const tournament = tRes.data as TournamentRowLite;
    const needsFunding =
      tournament.is_rebuy === true ||
      tournament.is_reentry === true ||
      tournament.add_on_available === true;
    let fundingRes: Awaited<ReturnType<typeof readTournamentFunding>> = {
      complete: true,
      rebuyAffordableByUser: {},
      addOnAffordableByUser: {},
    };
    if (needsFunding) {
      try {
        fundingRes = await withRefreshTimeout(readTournamentFunding(rows, tournament));
      } catch (error) {
        reportError(error, 'TournamentBrainContext.recovery_funding_unavailable');
        fundingRes = {
          complete: false,
          rebuyAffordableByUser: {},
          addOnAffordableByUser: {},
        };
      }
      if (!fundingRes.complete) {
        reportError(
          new Error('tournament recovery funding read was incomplete'),
          'TournamentBrainContext.recovery_funding_unavailable'
        );
      }
    }

    const fidelity: TournamentContextFidelity = {
      mysteryInventory: cRes?.error ? 'read_failed' : 'known',
      satelliteEntitlements: entitlementRes?.error ? 'read_failed' : 'known',
      entitlementRows: entitlementRes?.error
        ? []
        : ((entitlementRes?.data ?? []) as SatelliteEntitlementRow[]),
    };
    const chestRows = cRes?.error ? [] : ((cRes?.data ?? []) as ChestRow[]);
    if (cRes?.error) {
      reportError(
        new Error(`chest inventory read failed: ${cRes.error.message}`),
        'TournamentBrainContext.chests_unavailable'
      );
    }
    if (entitlementRes?.error) {
      reportError(
        new Error(`satellite entitlement read failed: ${entitlementRes.error.message}`),
        'TournamentBrainContext.satellite_entitlements_unavailable'
      );
    }

    const liveBounties: number[] = [];
    const bountyByUser: Record<string, number> = {};
    const stackByUser: Record<string, number> = {};
    const reloadsByUser: Record<string, number> = {};
    const horseRebuyCapByUser: Record<string, number> = {};
    const addOnTakenByUser: Record<string, boolean> = {};
    const entrants = rows.length;
    const observedAtMs = Date.now();
    let playersLeft = 0;
    let pendingRecoveryPlayers = 0;
    let chipSum = 0;
    const liveStacks: number[] = [];
    for (const row of rows) {
      if (typeof row.user_id === 'string' && row.user_id) {
        reloadsByUser[row.user_id] = Math.max(0, Math.floor(Number(row.rebuys) || 0));
        if (tournament.free_buy === true) {
          const policyCap = horseRebuyAllowance(row.user_id, tournamentId);
          const configuredCap = tournament.is_rebuy
            ? tournament.max_rebuys
            : tournament.max_reentries;
          const databaseCap =
            configuredCap == null
              ? policyCap
              : Math.min(policyCap, Math.max(0, Math.floor(Number(configuredCap) || 0)));
          horseRebuyCapByUser[row.user_id] = databaseCap;
        }
        addOnTakenByUser[row.user_id] = row.add_on === true;
      }
      const playerStatus = (row.status || '').toLowerCase();
      if (
        playerStatus === 'eliminated' ||
        playerStatus === 'busted' ||
        playerStatus === 'unregistered'
      ) {
        continue;
      }
      const chips = Number(row.chips) || 0;
      // The atomic hand settlement writes the busted stack before the
      // elimination sweep advances tournament_players.status. Under load that
      // status hand-off can lag for many sweeps, so `status = playing` alone is
      // not proof that a player still belongs in the active ICM stack vector.
      // An unexpired database-owned recovery prompt is different: that player
      // is not eliminated yet, so preserve the lifecycle count and mark the
      // context incomplete below. Once the prompt expires, the zero stack is a
      // completed bust for decision purposes even if the status sweep lags.
      if (chips <= 0) {
        const promptUntilMs = row.rebuy_prompt_until
          ? Date.parse(row.rebuy_prompt_until)
          : Number.NaN;
        if (Number.isFinite(promptUntilMs) && promptUntilMs > observedAtMs) {
          playersLeft += 1;
          pendingRecoveryPlayers += 1;
        }
        continue;
      }
      playersLeft += 1;
      chipSum += chips;
      liveStacks.push(chips);
      if (typeof row.user_id === 'string' && row.user_id) {
        stackByUser[row.user_id] = chips;
      }

      // tournament_players.current_bounty is stored in whole currency units;
      // the Horse Brain contract is cents throughout.
      const bountyCents = Math.round(Math.max(0, Number(row.current_bounty) || 0) * 100);
      if (bountyCents > 0) {
        liveBounties.push(bountyCents);
        if (typeof row.user_id === 'string' && row.user_id) {
          bountyByUser[row.user_id] = bountyCents;
        }
      }
    }

    const nextContext = deriveContext(
      tRes.data as TournamentRowLite,
      playersLeft,
      entrants,
      chipSum,
      liveStacks,
      chestRows,
      liveBounties,
      0,
      bountyByUser,
      observedAtMs,
      fidelity,
      {
        stackByUser,
        reloadsByUser,
        horseRebuyCapByUser,
        addOnTakenByUser,
        rebuyAffordableByUser: fundingRes.rebuyAffordableByUser,
        addOnAffordableByUser: fundingRes.addOnAffordableByUser,
        pendingRecoveryPlayers,
      }
    );
    if (e.generation !== generation) return;
    e.ctx = nextContext;
    e.lastSuccessAt = Date.now();
    e.lastFailureIssue = null;
  } catch (error) {
    reportError(error, 'TournamentBrainContext.refresh');
    publishFailure(
      error instanceof Error && error.message.includes('timed out')
        ? 'tournament_context_refresh_timed_out'
        : 'tournament_context_refresh_failed'
    );
    // Keep the last known context. The snapshot labels it stale once its
    // freshness boundary is crossed; a failed first read remains incomplete.
  } finally {
    if (e.generation === generation) {
      e.inFlight = false;
    }
  }
}
