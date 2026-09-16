import { validateMttBlindStructure } from '../../server/src/domain/tournamentBlindContract';
import {
  isUnlimitedMtt,
  normalizeTournamentMaxPlayers,
} from '../../server/src/tournament/tournamentEntryCapacity';
/**
 * ♠ CLUB ARENA — Tournament Service
 * SNGs and MTTs with blind levels and payout structures
 */

export type { BlindLevel } from '../config/blindStructures';
export {
  BLIND_STRUCTURES,
  SPIN_BLIND_STRUCTURE,
  PAYOUT_STRUCTURES,
} from '../config/blindStructures';
import { BLIND_STRUCTURES, SPIN_BLIND_STRUCTURE, type BlindLevel } from '../config/blindStructures';
import { SPIN_TIERS, SPIN_FREQ_DENOMINATOR } from '../config/spinSpec';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { freeBuyConfig, isFreeBuyEvent } from '../utils/freeBuy';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { fetchGameCreationAccess } from './GameAccessService';
import { gameCreationDeniedMessage } from '../lib/gameCreationAccess';
import { parseBlindStructure, parsePayoutStructure } from '../utils/parseBlindStructure';
/* The canonical level-length reader. It is the ONLY one that gets the
   three-spelling precedence right - see getCurrentLevelState. Pure, no React,
   despite living under components/lobby. */
import { blindLevelMinutes } from '../components/lobby/tournamentFigures';
import type { Tournament, TournamentPlayer } from '../types/database.types';
import type { TournamentGameVariant } from '../config/tournamentVariants';
import { reportError } from '../utils/errorReporter';
import { computePlacePrize } from '../lib/payoutMath';
import { UNIT_CENTS_ASSET_NOT_READ } from '../../server/src/tournament/tournamentUnit';
import {
  mysteryBountyCreationOptions,
  mysteryBountyCreationColumns,
} from '../../server/src/domain/mysteryBountyCreation';
import { gameManagementService } from './GameManagementService';
import { PLATFORM_FROZEN_MESSAGE } from '../utils/platformFrozen';
import { uuid } from '../utils/uuid';
import { DEFAULT_RAKE_RATE, splitBuyIn } from '../utils/buyIn';
import { withTournamentPurchaseIntent } from './TournamentPurchaseIntent';
import {
  withTournamentUnregistrationIntent,
  ObsoleteTournamentUnregistrationIntentError,
} from './TournamentUnregistrationIntent';

/** A transport success alone does not confirm a tournament chip purchase. */
function confirmedTournamentPurchaseStack(
  value: unknown,
  kind: 'rebuy' | 'reentry' | 'addon'
): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Tournament Purchase Could Not Be Confirmed.');
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.success !== true ||
    receipt.rebuy_type !== kind ||
    typeof receipt.new_stack !== 'number' ||
    !Number.isFinite(receipt.new_stack) ||
    receipt.new_stack < 0
  ) {
    throw new Error('The Tournament Purchase Could Not Be Confirmed.');
  }
  return receipt.new_stack;
}

// AUDIT M19: fn_unregister_from_tournament returns a `reason` for ordinary
// refusals rather than raising, so a player is told why - "you are already
// seated" and "the database is down" must not read as the same event.
const UNREGISTER_REASON_TEXT: Record<string, string> = {
  tournament_not_found: 'That tournament no longer exists',
  registration_closed:
    'Registration has closed for this tournament. You can only unregister before it starts.',
  registration_schedule_unset:
    'This tournament has no scheduled start time, so it cannot be unregistered from.',
  tournament_started: 'This tournament has started. You can only unregister before it starts.',
  already_started: 'This game has started. You can only unregister before it starts.',
  not_registered: 'You are not registered for this tournament.',
  not_seated: 'Your tournament seat could not be found. No chips were changed.',
  spin_entry_already_booked: 'This Spin entry has already started and cannot be unregistered.',
  // Legacy servers briefly returned this code for a pre-start lockout that no
  // longer exists. Keep the code human-readable without repeating that false
  // one-minute rule.
  too_close_to_start: 'The tournament could not be unregistered. No chips were changed.',
  not_registered_or_seated:
    'You are not registered, or you have already been seated at a table. Tournaments that have started cannot be refunded.',
};

const REGISTER_REASON_TEXT: Record<string, string> = {
  tournament_not_found: 'Tournament not found',
  registration_closed: 'Registration is closed',
  tournament_full: 'Tournament is full',
  already_registered: 'Already registered for this tournament',
  insufficient_balance: 'Insufficient chips in Player Wallet.',
  // 2026-08-28: reasons fn_register_for_tournament actually returns but that
  // rendered as their raw codes ("Could not register (seat_first_variant)").
  // seat_first_variant is the guard that keeps lobby registration out of
  // Spin/Heads-Up events - those are entered by taking a seat at the table.
  seat_first_variant: 'This game is entered by taking a seat at its table',
  not_authorized_to_register: 'This event needs registration approval from the club',
  vip_only: 'This event is for VIP players only',
  misconfigured_bounty: 'This event is misconfigured, please tell the club owner',
  // The four-table cap, surfaced as a rule rather than a raw trigger message.
  table_limit_reached: 'You are already in four games. Leave one to join another.',
  platform_frozen: PLATFORM_FROZEN_MESSAGE,
  ticket_not_found: 'That Tournament Ticket no longer exists.',
  ticket_not_owned: 'That Tournament Ticket does not belong to you.',
  ticket_is_wallet_only: 'That ticket can only be redeemed for wallet chips.',
  ticket_already_used: 'That Tournament Ticket has already been used.',
  ticket_not_available: 'That Tournament Ticket is no longer available.',
  target_pool_finalized: 'Registration is closed because this tournament prize pool is final.',
  ticket_club_membership_inactive: 'Your membership in the Tournament Ticket club is not active.',
  ticket_club_mismatch: 'That Tournament Ticket belongs to a different club.',
  ticket_union_mismatch: 'That Tournament Ticket does not belong to this union.',
  ticket_source_club_unavailable:
    'The club wallet behind that Tournament Ticket is not available for this event.',
  ticket_entry_contract_mismatch:
    'That Tournament Ticket does not match this tournament entry fee.',
  matching_tournament_ticket_unavailable:
    'Your Matching Tournament Ticket Could Not Be Verified. No Chips Were Charged.',
  // Diamond Phase 8: the Diamond Arena's doors answer with these reasons
  // (migration a_diamond_tournament_door_answers_the_client). No Diamonds move
  // on any of them.
  insufficient_diamonds: 'Not Enough Settled Diamonds In Your Diamond Wallet.',
  diamond_tournaments_not_open: 'Diamond Tournaments Are Not Open Yet.',
  diamond_debt_requires_settlement:
    'Your Diamond Wallet Has An Unsettled Balance. Settle It Before Entering A Tournament.',
};

/**
 * Exported so every registration surface reads the SAME refusal text.
 * `fn_register_for_tournament` answers an ordinary refusal with
 * `{ ok: false, reason }` rather than raising, so any caller that only checks
 * the PostgREST `error` renders "Insufficient chips" as a successful buy-in.
 */
export function registerReasonText(reason: string | undefined): string {
  return REGISTER_REASON_TEXT[reason ?? ''] ?? `Could not register (${reason ?? 'unknown'})`;
}

function unregisterReasonText(reason: string | undefined): string {
  return UNREGISTER_REASON_TEXT[reason ?? ''] ?? `Could not unregister (${reason ?? 'unknown'})`;
}

/**
 * The seat-first purchase (`fn_take_seat_and_buy_in`, heads-up and spins)
 * answers the same refusals as the lobby register door plus its own seat
 * reasons. Diamond Phase 8: a Diamond seat purchase answers with the Diamond
 * reasons above, and `insufficient_diamonds` must be read before the bare
 * chip `insufficient` so a Diamond player is not told they lack chips.
 */
export function seatFirstBuyInReasonIsKnown(reason: string | undefined): boolean {
  return /seat_taken|insufficient|already_started|game_already_started|tournament_full|not_a_seat_first_game|table_limit_reached|FOUR TABLE LIMIT|diamond_tournaments_not_open|diamond_debt_requires_settlement/.test(
    reason ?? ''
  );
}

export function seatFirstBuyInRefusalText(reason: string | undefined): string {
  const r = reason ?? '';
  if (/seat_taken/.test(r)) return 'That Seat Was Just Taken';
  if (/insufficient_diamonds/.test(r)) return REGISTER_REASON_TEXT.insufficient_diamonds;
  if (/diamond_tournaments_not_open/.test(r))
    return REGISTER_REASON_TEXT.diamond_tournaments_not_open;
  if (/diamond_debt_requires_settlement/.test(r)) {
    return REGISTER_REASON_TEXT.diamond_debt_requires_settlement;
  }
  if (/insufficient/.test(r)) return 'Not Enough Chips For This Buy In';
  if (/already_started|game_already_started/.test(r)) return 'This Game Has Already Started';
  if (/tournament_full/.test(r)) return 'This Game Is Full';
  if (/not_a_seat_first_game/.test(r)) return 'Seats Are Not For Sale At This Table';
  if (/table_limit_reached|FOUR TABLE LIMIT/.test(r)) {
    return 'You Are Already In Four Games, Leave One To Join Another';
  }
  return 'Could Not Take That Seat, Please Try Again';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PayoutStructure {
  place: number;
  percentage: number;
}

/** An exact, noncash tournament-entry instrument selected by the server. */
export interface TournamentEntryTicket {
  id: string;
  value: number;
}

export interface TournamentUnregisterResult {
  refundedChips: number;
  returnedTicketValue: number;
  /**
   * Diamond Phase 8: a Diamond entry is refunded whole out of custody to the
   * player's Diamond wallet. Absent for every chip event (a chip receipt is
   * exactly the two fields above); when present, `refundedChips` and
   * `returnedTicketValue` are zero, because a Diamond event has no chip rail
   * and no ticket.
   */
  refundedDiamonds?: number;
  /** The Diamond wallet after the refund, when the receipt carried it. */
  diamondsAfter?: number;
}

/** A committed refusal is different from an unknown transport outcome. */
export class TournamentUnregisterRefusalError extends Error {
  readonly reason: string;

  constructor(reason: string | undefined) {
    super(unregisterReasonText(reason));
    this.name = 'TournamentUnregisterRefusalError';
    this.reason = reason ?? 'unknown';
  }
}

/** The pre-start exit controls need one truthful response to a started game. */
export function tournamentUnregisterWasAlreadyStarted(error: unknown): boolean {
  if (!(error instanceof TournamentUnregisterRefusalError)) return false;
  return [
    'already_started',
    'tournament_started',
    'registration_closed',
    'spin_entry_already_booked',
  ].includes(error.reason);
}

type TournamentUnregisterRpcResponse = {
  ok?: unknown;
  reason?: unknown;
  request_id?: unknown;
  registration_id?: unknown;
  refunded_chips?: unknown;
  returned_ticket_value?: unknown;
  wallet_chips_from_satellite_entitlements?: unknown;
  /** Diamond Phase 8: the Diamond unregistration receipt. */
  asset?: unknown;
  refunded_diamonds?: unknown;
  diamonds_after?: unknown;
};

function unregisterNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parse only the immutable receipt returned by the atomic database owner.
 * Missing amounts are not zero, `refunded` is not an alias, and a response for
 * another request can never be mistaken for this button press.
 */
export function parseTournamentUnregisterResult(
  payload: unknown,
  expectedRequestId: string
): TournamentUnregisterResult {
  const response = payload as TournamentUnregisterRpcResponse | null;
  /* DIAMOND PHASE 8: a Diamond event's receipt is the Diamond shape - the
     refund named in Diamonds, the asset stated, no chip rail and no ticket.
     It is held to the same identity checks as the chip receipt; only the
     amount keys differ, and an amount that is not a whole Diamond is refused
     because no Diamond door pays one. */
  if (response?.asset === 'diamonds') {
    const refundedDiamonds = unregisterNumber(response.refunded_diamonds);
    const diamondsAfter = unregisterNumber(response.diamonds_after);
    if (
      response.ok !== true ||
      response.request_id !== expectedRequestId ||
      typeof response.registration_id !== 'string' ||
      response.registration_id.length === 0 ||
      refundedDiamonds === null ||
      !Number.isSafeInteger(refundedDiamonds)
    ) {
      throw new Error('Tournament unregistration returned an invalid settlement receipt');
    }
    return {
      refundedChips: 0,
      returnedTicketValue: 0,
      refundedDiamonds,
      ...(diamondsAfter !== null && Number.isSafeInteger(diamondsAfter) ? { diamondsAfter } : {}),
    };
  }
  const refundedChips = unregisterNumber(response?.refunded_chips);
  const returnedTicketValue = unregisterNumber(response?.returned_ticket_value);
  const satelliteWalletChips = unregisterNumber(response?.wallet_chips_from_satellite_entitlements);
  if (
    response?.ok !== true ||
    response.request_id !== expectedRequestId ||
    typeof response.registration_id !== 'string' ||
    response.registration_id.length === 0 ||
    refundedChips === null ||
    returnedTicketValue === null ||
    satelliteWalletChips === null ||
    satelliteWalletChips > refundedChips
  ) {
    throw new Error('Tournament unregistration returned an invalid settlement receipt');
  }
  return { refundedChips, returnedTicketValue };
}

type TournamentUnregisterRpcCall = () => Promise<{ data: unknown; error: unknown }>;

async function invokeTournamentUnregisterRpc(
  invoke: TournamentUnregisterRpcCall
): Promise<{ data: unknown; error: unknown }> {
  try {
    return await invoke();
  } catch (error) {
    // Supabase normally resolves transport failures as `{ error }`, but a
    // rejected fetch is the same unknown-outcome class. Normalize both forms
    // so the caller performs the one permitted exact-request replay and never
    // escapes into a second, legacy refund path.
    return { data: null, error };
  }
}

function rejectObsoleteTournamentUnregistration(error: unknown): void {
  const failure = error as { code?: unknown; message?: unknown } | null;
  if (
    failure?.code === 'P0404' &&
    failure.message === 'unregistration request id belongs to a prior registration lifecycle'
  ) {
    throw new ObsoleteTournamentUnregistrationIntentError();
  }
}

async function executeTournamentUnregisterRpc(
  invoke: TournamentUnregisterRpcCall,
  requestId: string,
  errorContext: string,
  metadata: Record<string, string>
): Promise<TournamentUnregisterResult> {
  // The database stores an immutable receipt by request_id. Repeating this
  // exact request once is therefore the only safe answer to a response that
  // may have been lost after commit. Never mint a second id for the retry.
  let rpcCall = await invokeTournamentUnregisterRpc(invoke);
  rejectObsoleteTournamentUnregistration(rpcCall.error);
  if (rpcCall.error) rpcCall = await invokeTournamentUnregisterRpc(invoke);
  rejectObsoleteTournamentUnregistration(rpcCall.error);
  const { data, error } = rpcCall;

  if (error) {
    reportError(error, errorContext, { ...metadata, requestId });
    throw new Error(
      'Could Not Confirm Tournament Unregistration. Please Refresh Before Trying Again.'
    );
  }

  const response = data as TournamentUnregisterRpcResponse | null;
  if (response?.ok === false) {
    throw new TournamentUnregisterRefusalError(
      typeof response.reason === 'string' ? response.reason : undefined
    );
  }

  try {
    return parseTournamentUnregisterResult(response, requestId);
  } catch (error) {
    reportError(error as Error, `${errorContext}_receipt_invalid`, {
      ...metadata,
      requestId,
      responseRequestId: typeof response?.request_id === 'string' ? response.request_id : 'missing',
    });
    throw new Error(
      'Could Not Confirm Tournament Unregistration. Please Refresh Before Trying Again.'
    );
  }
}

const unregisterAmount = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

/**
 * Diamond Phase 8: a Diamond refund reaches the wallet through the database
 * alone - no engine pushes a FINANCIAL_UPDATE for it - so the client moves
 * the balance it shows from the receipt. DIAMOND_BALANCE_CHANGED forces the
 * store to reload; the figure carried is the wallet the receipt reported.
 */
function announceDiamondRefund(result: TournamentUnregisterResult): void {
  if ((result.refundedDiamonds ?? 0) > 0 && typeof result.diamondsAfter === 'number') {
    masterBus.emit('DIAMOND_BALANCE_CHANGED', {
      newBalance: result.diamondsAfter,
      delta: result.refundedDiamonds ?? 0,
      source: 'tournament_unregister_refund',
    });
  }
}

/** Player-facing confirmation derived only from the committed refund rails. */
export function tournamentUnregisterSuccessText(result: TournamentUnregisterResult): string {
  if ((result.refundedDiamonds ?? 0) > 0) {
    return `${unregisterAmount.format(result.refundedDiamonds ?? 0)} Diamonds Were Returned To Your Diamond Wallet.`;
  }
  const chips = unregisterAmount.format(result.refundedChips);
  const ticket = unregisterAmount.format(result.returnedTicketValue);
  if (result.refundedChips > 0 && result.returnedTicketValue > 0) {
    return `${chips} Chips Were Refunded To Your Wallet. A Tournament Ticket For A ${ticket} Chip Entry Was Issued.`;
  }
  if (result.returnedTicketValue > 0) {
    return `A Tournament Ticket For A ${ticket} Chip Entry Was Issued. No Chips Were Added To Your Wallet.`;
  }
  if (result.refundedChips > 0) {
    return `${chips} Chips Were Refunded To Your Wallet.`;
  }
  return 'You Are No Longer Registered.';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tournament Types:
 * - sng: Heads Up (starts when full). 'sng' stays the stored value;
 *        Heads Up is what a player reads.
 * - mtt: Multi-Table Tournament (scheduled start)
 * - satellite: Wins seats to bigger tournaments
 * - spin: Spin & Go (random multiplier prize pools)
 * - bounty: Fixed bounty per knockout
 * - mystery_bounty: Hidden bounty revealed on knockout
 * - progressive_bounty: Half bounty to knocker, half added to their head
 */
export type TournamentType =
  | 'sng'
  | 'mtt'
  | 'satellite'
  | 'spin'
  | 'bounty'
  | 'mystery_bounty'
  | 'progressive_bounty';

export interface BountyConfig {
  bountyType: 'fixed' | 'mystery' | 'progressive';
  baseBounty: number; // Starting bounty per player
  progressiveStartLevel?: number; // When progressive bounties start
}

/* DELETED 2026-08-25: `MysteryBountyTier` and `BountyConfig.mysteryTiers`.
 *
 * A client-supplied multiplier ladder. It was built by CreateTournamentModal
 * from a min/max pair, handed to `BountyConfig` — and then dropped: nothing in
 * `buildRpcConfig` ever sent it, so no tournament ever ran on it. The only
 * function that read it, `rollMysteryBounty`, had no callers either.
 *
 * The ladder is server-side now and there is exactly one of it:
 * `server/src/config/mysteryBountySpec.ts`. A club chooses BETWEEN ladders
 * (balanced / classic / jackpot) via `mysteryBountyProfile` below; it does not
 * hand one in, because a browser must not decide what a chest is worth. */

export interface SpinConfig {
  possibleMultipliers: SpinMultiplier[];
}

export interface SpinMultiplier {
  multiplier: number; // e.g., 2, 3, 5, 10, 25, 120, 10000
  probability: number; // Percentage chance
  isPremium?: boolean; // Special handling for huge multipliers
}

/**
 * Repeats Weekly (Dan 2026-09-03): "ALL MTT'S SHOULD BE ON A RECURRING WEEKLY
 * CYCLE ... ADDED TO THE 'CREATE EVENT' FUNCTIONALITY ... AS A CHECK BOX."
 * The checkbox writes restartEveryMinutes = one week; the server clones the
 * event on completion, anchored to the same weekday and time. The interval
 * cap moves from a day to a week here, in fn_create_tournament_governed_legacy
 * (migration 20260903172703) and in ScheduledTournamentService together.
 */
export const RESTART_WEEKLY_MINUTES = 7 * 24 * 60;
export const RESTART_MAX_MINUTES = RESTART_WEEKLY_MINUTES;

/**
 * fn_create_tournament returns a machine-readable reason; turn it into
 * something a club owner can act on. Anything unmapped falls back to a generic
 * message rather than leaking the raw code.
 */
const TOURNAMENT_CREATE_ERRORS: Record<string, string> = {
  not_authenticated: 'You need to be signed in to create a tournament.',
  not_authorised:
    'Only the owner or an admin can create tournaments here. A club inside a union does not create its own - the union creates them.',
  buy_in_must_not_be_negative: 'Buy-in cannot be negative.',
  buy_in_must_be_whole: 'Buy-in must be a whole number of chips, with no decimals.',
  bounty_must_be_whole: 'Bounty amount must be a whole number of chips, with no decimals.',
  max_players_must_be_positive: 'Choose the number of seats for this Sit And Go or Spin.',
  blind_structure_required: 'Choose a blind structure.',
  payout_structure_required: 'Choose a payout structure.',
  payouts_must_total_100: 'Payout percentages have to add up to 100%.',
  more_paid_places_than_players:
    'This Sit And Go or Spin has more paid places than seats.',
  bounty_amount_required: 'A bounty tournament needs a bounty amount.',
  bounty_exceeds_buy_in:
    'The bounty plus the 10% fee is more than the buy-in, so there would be nothing left for the prize pool.',
  // Parity keys (2026-08-22)
  early_bird_chips_must_not_be_negative: 'Early bird chips cannot be negative.',
  restart_every_minutes_out_of_range:
    'Restart interval must be between 5 minutes and one week (10080 minutes).',
  total_days_out_of_range: 'A multi-day tournament runs 2 to 7 days.',
  mystery_range_requires_mystery_bounty:
    'Mystery bounty multipliers only apply to mystery bounty tournaments.',
  mystery_bounty_range_invalid: 'Mystery bounty multipliers must be positive, with max >= min.',
  satellite_seats_invalid: 'A satellite must award at least 1 seat.',
  satellite_seats_requires_target: 'Satellite seats need a target tournament.',
};

export interface TournamentConfig {
  name: string;
  type: TournamentType;
  /**
   * The TOTAL a player pays to enter, as a whole number of chips.
   *
   * Dan 2026-08-20: "Sit and Go and any tournament buy-ins must never be
   * decimal buy-ins, whole numbers only." The 10% house fee is a cut OUT of
   * this number, never a surcharge on top of it, so `buyIn` is exactly what the
   * lobby advertises and exactly what leaves the wallet. Non-integers are
   * refused by createTournament and by fn_create_tournament.
   */
  buyIn: number;
  /** Display only. The fee half of the split; recomputed server-side. */
  rake: number;
  startingStack: number;
  /** Fixed SNG/Spin field size. MTTs and satellites use null for no entry limit. */
  maxPlayers: number | null;
  minPlayers: number;
  blindStructure: BlindLevel[];
  payoutStructure: PayoutStructure[];
  /** Share of actual entrants paid at entry close; the database owns the ladder. */
  payoutPercent?: 10 | 15 | 20;
  lateRegistrationLevels: number;
  startTime?: Date;

  // Rebuy/Re-Entry/Add-on
  isRebuy: boolean;
  isReentry?: boolean;
  rebuyLevels?: number; // Always matches lateRegistrationLevels
  rebuyChips?: number;
  rebuyCost?: number;
  addOnAvailable: boolean;
  addOnChips?: number;
  addOnCost?: number;
  addOnLevels?: number; // Number of levels add-on window is open after rebuy period
  /** Scheduled Free Buy event (the 5-a-day board). Distinct from
   *  isFreeBuyEvent, which is TRUE for any 0-buy-in MTT (Dan 2026-09-02). */
  freeBuy?: boolean;
  /** Open the add-on window at sit-down rather than only after late reg. */
  addOnFromStart?: boolean;

  // Guaranteed Prize
  guaranteedPrize?: number;

  // Bounty Configuration
  bountyConfig?: BountyConfig;

  // Spin Configuration
  spinConfig?: SpinConfig;
  spinType?: 'standard' | 'hyper';

  /**
   * Game Variant (poker game type).
   *
   * ONE LIST, SHARED WITH THE MAP THAT PRODUCES IT (2026-08-31). This union was
   * hand-written and had drifted: it omitted PLO6 while 6,028 PLO6 tournaments
   * were live in production and `tournamentFromTableConfig` was already
   * emitting 'PLO6' — it compiled only because that file ends in
   * `as TournamentConfig`, which is exactly the cast that hides this class of
   * mistake. It now names the same type the variant map is keyed to, so a
   * variant cannot be creatable and untypeable at the same time.
   */
  gameVariant?: TournamentGameVariant;

  // Satellite Target
  satelliteTarget?: {
    tournamentId: string;
    seatsAwarded: number;
  };

  // Multi-Day
  isMultiDay?: boolean;
  totalDays?: number;

  // XMTT (Union Tournament)
  isXmtt?: boolean;
  unionId?: string;
  // Private club tournament — visible only inside the club, never union-wide.
  // Forced true for non-XMTT tournaments created by clubs that are in a union.
  isPrivate?: boolean;

  // ── PokerBros feature parity (2026-08-22) ──────────────────────────────
  // Each key mirrors an fn_create_tournament p_config key of the same name.
  // Only keys the creator actually set are sent; the server owns defaults.
  shortDescription?: string;
  isVipOnly?: boolean;
  banChat?: boolean;
  allInOrFold?: boolean;
  labelAsNew?: boolean;
  hideClubName?: boolean;
  /** Per-action clock, clamped server-side to 5-60 seconds. */
  actionTimeSeconds?: number;
  /** Seats per tournament table, clamped server-side to 2-10. */
  tableSize?: number;
  acceleratedMtt?: boolean;
  /** Add-on break length in minutes, clamped server-side to 1-10. */
  addonBreakMinutes?: number;
  bigBlindAnte?: boolean;
  authorizedToRegister?: boolean;
  earlyBirdEnabled?: boolean;
  earlyBirdChips?: number;
  bubbleProtection?: boolean;
  finalTableDealEnabled?: boolean;
  /** null/undefined = no auto-restart; otherwise 5-1440 minutes. */
  restartEveryMinutes?: number | null;
  synchronizedBreaks?: boolean;
  maxRebuys?: number;
  maxReentries?: number;
  /** Mystery bounty advertised range, as MULTIPLIERS of the bounty head. */
  mysteryBountyMin?: number;
  mysteryBountyMax?: number;
  /** Mystery options commit with the original creation transaction. */
  /** Which tier ladder. 'jackpot' is top-heavy, 'balanced' is flat. */
  mysteryBountyProfile?: 'balanced' | 'classic' | 'jackpot';
  /** When the chests open. */
  mysteryBountyActivation?: 'at_the_money' | 'percent_field' | 'player_count';
  /** Percent of field for 'percent_field'; an absolute count for 'player_count'. */
  mysteryBountyActivationValue?: number;
  /** Percent of the bounty pool held back for chests. The rest funds ordinary
   *  knockouts before the phase opens. */
  mysteryBountyPoolPercent?: number;
  /** Advertised share of the mystery pool sitting on the single top chest. */
  mysteryBountyTopPercent?: number;
  /** Writes tournaments.is_pinned — pinned/featured in every lobby sort. */
  isFeatured?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDARD STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SPIN CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ── SPIN ECONOMICS — DERIVED, NOT DECLARED ─────────────────────────────────
//
// This section used to hold SPIN_BONUS_TIERS: a full "pool-based" economic
// model (10% fee, 2x base payout, bonusBuyIns, an EV-3.0 probability table
// in two flavours) that contradicted the shipped format on every axis — a
// Spin charges NO fee, the pool model is the Reserve Pool in Supabase, and
// the draw happens server-side at start through fn_spin_draw_multiplier.
// It was one of the FOUR disagreeing multiplier tables the 2026-08-20 audit
// found, and the only one still declaring its own probabilities by hand.
//
// What remains is a DISPLAY view derived from the canonical spec, so this
// file cannot drift from the format again. Nothing here decides anything:
// the engine draws, the reserve gates, this just labels.
//
// `standard` and `hyper` are intentionally the SAME ladder. The old split
// pretended two economies existed; in the shipped format the tier changes
// level length via spinSpec, not the multiplier distribution. Both keys are
// kept because CreateTournamentModal indexes by spinType.

export interface SpinDisplayTier {
  multiplier: number;
  /** Percentage, from the spec frequencies. Display only. */
  probability: number;
  isPremium: boolean;
}

// Normalised by the ACTUAL total, not the nominal denominator, so the
// display percentages sum to exactly 100 even if the spec's frequencies are
// ever retuned without re-totalling to SPIN_FREQ_DENOMINATOR.
const SPEC_TOTAL_FREQ = SPIN_TIERS.reduce((s, t) => s + t.freq, 0) || SPIN_FREQ_DENOMINATOR;

const SPEC_DISPLAY_TIERS: SpinDisplayTier[] = SPIN_TIERS.map((t) => ({
  multiplier: t.multiplier,
  probability: Math.round((t.freq / SPEC_TOTAL_FREQ) * 100 * 10000) / 10000,
  // "Premium" = reserve-gated. The old table hardcoded >= 50; deriving it
  // from reserveThresholdX means a spec change cannot orphan this flag.
  isPremium: t.reserveThresholdX > 0,
}));

export const SPIN_MULTIPLIERS: Record<string, SpinDisplayTier[]> = {
  standard: SPEC_DISPLAY_TIERS,
  hyper: SPEC_DISPLAY_TIERS,
};

// ═══════════════════════════════════════════════════════════════════════════════
// BOUNTY CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const BOUNTY_PRESETS: Record<string, BountyConfig> = {
  fixed: {
    bountyType: 'fixed',
    baseBounty: 5, // 50% of buy-in typically goes to bounty
  },
  progressive: {
    bountyType: 'progressive',
    // Whole chips only (Dan 2026-08-20). Was 2.5 - roughly a quarter of a 10
    // buy-in, but a decimal bounty, which the rule forbids.
    baseBounty: 2,
    progressiveStartLevel: 1,
  },
  mystery: {
    bountyType: 'mystery',
    baseBounty: 10,
    // No tier ladder here on purpose — see the note on BountyConfig. The
    // chests are sized server-side from the funded pool when the phase opens.
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// HYPER-TURBO STRUCTURE (for Spins)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// AUDIT M19: `ordinal` is removed with its only caller, the deleted
// eliminatePlayer. It formatted a finish position for a prize-credit error
// message, and prize credits are engine-owned now.

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class TournamentService {
  // ─────────────────────────────────────────────────────────────────────────────
  // Tournament CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all tournaments for a club
   */
  async getTournaments(clubId: string): Promise<Tournament[]> {
    // Resolve integer club_id to UUID for FK queries
    const resolvedId = await resolveClubUUID(clubId);

    // Fetch club-specific tournaments
    const { data: clubTournaments, error } = await supabase
      .from('tournaments')
      .select(
        'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, addon_period_started_at, addon_period_ends_at, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, mystery_bounty_profile, mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent, mystery_bounty_top_percent, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at, short_description, is_vip_only, ban_chat, all_in_or_fold, label_as_new, hide_club_name, action_time_seconds, table_size, accelerated_mtt, addon_break_minutes, big_blind_ante, authorized_to_register, early_bird_enabled, early_bird_chips, bubble_protection, final_table_deal_enabled, restart_every_minutes, synchronized_breaks, on_break, break_started_at, break_ends_at, max_rebuys, max_reentries, is_pinned, satellite_seats, satellite_target_id, satellite_target'
      )
      .eq('club_id', resolvedId)
      // Lobby fix 2026-08-15: this query had NO status filter, so every
      // tournament the club has EVER created came back -- measured in
      // production: 6,669 CANCELLED and 1,402 COMPLETED rows against 6
      // REGISTERING and 2 RUNNING. The lobby rendered them all as joinable
      // cards (the card template has no dead-state), so a player tapping one
      // landed on a CANCELLED detail page whose only control is disabled --
      // the reported "join silently failed". History views query completed
      // tournaments themselves; the LOBBY is for joining.
      .in('status', ['REGISTERING', 'RUNNING'])
      .order('created_at', { ascending: false });

    if (error) {
      reportError(error, 'TournamentService.Error_fetching_tournaments');
      return [];
    }

    // Also fetch XMTT tournaments for the club's union (if any)
    let xmttTournaments: Tournament[] = [];
    try {
      /**
       * SAME CASCADE, SAME RULE AS ClubHomePage (2026-08-23): a union club
       * that cannot resolve its union lists only what it owns, which is
       * almost nothing - the lobby empties while the union's games run one
       * join away. `.maybeSingle()` returns { data: null } for BOTH "no such
       * row" and "the query failed", and this call discarded the error, so a
       * timeout was indistinguishable from a standalone club.
       *
       * Resolution order: the union_clubs row, then clubs.union_id, then the
       * scope cached from the last successful load. Standalone is concluded
       * only when a read SUCCEEDS and finds nothing everywhere.
       */
      const unionCacheKey = `ca_union_of_${resolvedId}`;
      const { data: unionClubRow, error: unionClubErr } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedId)
        .limit(1)
        .maybeSingle();

      let resolvedUnionId: string | null = unionClubRow?.union_id ?? null;

      // ROUND 8 (2026-08-29): the clubs.union_id fallback discarded ITS error
      // too, so when union_clubs succeeded-empty and the clubs read failed,
      // `unionClubErr` was null, the cache below was never consulted, and the
      // cache was CLEARED - a transient failure on the second read demoted a
      // union club to standalone and destroyed the one thing that could have
      // rescued the next load. Either read failing now counts as "cannot
      // conclude standalone".
      let clubRowErr: unknown = null;
      if (!resolvedUnionId) {
        const { data: clubRow, error: clubErr } = await supabase
          .from('clubs')
          .select('union_id')
          .eq('id', resolvedId)
          .maybeSingle();
        clubRowErr = clubErr;
        resolvedUnionId = (clubRow as { union_id?: string | null } | null)?.union_id ?? null;
      }
      const anyResolveErr = unionClubErr || clubRowErr;
      if (!resolvedUnionId && anyResolveErr) {
        try {
          resolvedUnionId = sessionStorage.getItem(unionCacheKey);
        } catch {
          /* storage unavailable */
        }
      }
      try {
        if (resolvedUnionId) sessionStorage.setItem(unionCacheKey, resolvedUnionId);
        else if (!anyResolveErr) sessionStorage.removeItem(unionCacheKey);
      } catch {
        /* storage unavailable */
      }

      const unionClub = resolvedUnionId ? { union_id: resolvedUnionId } : null;

      if (unionClub?.union_id) {
        // IMPORTANT: Only fetch XMTT if union allows cross-club tournaments
        const { data: unionData, error: unionSettingsErr } = await supabase
          .from('unions')
          .select('settings')
          .eq('id', unionClub.union_id)
          .maybeSingle();

        // FAIL CLOSED (2026-08-28). This used to set `allowCrossClub = true` in
        // the catch, with the comment "Default allow if parsing fails" - so a
        // union that had explicitly turned cross-club tournaments OFF got them
        // turned back ON by a malformed settings blob. A permission check that
        // grants the permission when it cannot read the rule is not a check.
        // The bound error was also never reported, so it failed open silently.
        //
        // ROUND 8 (2026-08-29): that fix closed the PARSE failure but left the
        // READ failure open - `.maybeSingle()` returns { data: null } for a
        // failed query too, so a timeout skipped the settings block entirely
        // and allowCrossClub kept its default of true. Same rule, same hole:
        // a read error now fails closed and is reported.
        let allowCrossClub = true;
        if (unionSettingsErr) {
          allowCrossClub = false;
          reportError(
            unionSettingsErr,
            'TournamentService.union_settings_read_failed_failing_closed',
            {
              unionId: unionClub.union_id,
            }
          );
        } else if (unionData?.settings) {
          try {
            const settings =
              typeof unionData.settings === 'string'
                ? JSON.parse(unionData.settings)
                : unionData.settings;
            allowCrossClub = settings.crossClubTournaments !== false;
          } catch (e: unknown) {
            allowCrossClub = false;
            reportError(e, 'TournamentService.union_settings_unreadable_failing_closed', {
              unionId: unionClub.union_id,
            });
          }
        }

        if (allowCrossClub) {
          const { data: xmttData, error: xmttErr } = await supabase
            .from('tournaments')
            .select(
              'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, addon_period_started_at, addon_period_ends_at, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, mystery_bounty_profile, mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent, mystery_bounty_top_percent, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at, short_description, is_vip_only, ban_chat, all_in_or_fold, label_as_new, hide_club_name, action_time_seconds, table_size, accelerated_mtt, addon_break_minutes, big_blind_ante, authorized_to_register, early_bird_enabled, early_bird_chips, bubble_protection, final_table_deal_enabled, restart_every_minutes, synchronized_breaks, on_break, break_started_at, break_ends_at, max_rebuys, max_reentries, is_pinned, satellite_seats, satellite_target_id, satellite_target'
            )
            .eq('union_id', unionClub.union_id)
            // 2026-08-19: dropped `.eq('is_xmtt', true)`. Under the union
            // governance rule EVERY non-private game a union club runs is
            // union-owned, not just XMTTs, so requiring is_xmtt hid the
            // majority of the tournaments a union club's players can join.
            // ClubHomePage was fixed the same day; this service was missed,
            // which left the two lobbies disagreeing.
            .neq('club_id', resolvedId) // Avoid duplicates (host club already included above)
            // Same lobby fix as the club query above -- joinable states only.
            .in('status', ['REGISTERING', 'RUNNING'])
            .order('created_at', { ascending: false });

          // ROUND 8 (2026-08-29): a failed read here silently emptied the
          // union half of the lobby - the exact "games vanish" symptom this
          // sweep chased. The fallback is unchanged (club games still list);
          // the failure is now visible instead of dressed as an empty union.
          if (xmttErr) {
            reportError(xmttErr, 'TournamentService.union_tournaments_read_failed', {
              unionId: unionClub.union_id,
            });
          }
          xmttTournaments = xmttData || [];
        }
      }
    } catch (e: unknown) {
      console.warn(
        '[TournamentService] Union XMTT lookup failed - returning club tournaments only:',
        e
      );
    }

    // Merge and deduplicate by id
    const all = [...(clubTournaments || []), ...xmttTournaments];
    const seen = new Set<string>();
    const unique: Tournament[] = [];
    for (const t of all) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        unique.push(t);
      }
    }
    return unique;
  }

  /**
   * Get a single tournament
   */
  async getTournament(
    tournamentId: string,
    options?: { throwOnError?: boolean }
  ): Promise<Tournament | null> {
    const { data, error } = await supabase
      .from('tournaments')
      .select(
        'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, prize_pool_finalized, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, addon_period_started_at, addon_period_ends_at, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, mystery_bounty_profile, mystery_bounty_activation, mystery_bounty_activation_value, mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent, mystery_bounty_top_percent, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at, short_description, is_vip_only, ban_chat, all_in_or_fold, label_as_new, hide_club_name, action_time_seconds, table_size, accelerated_mtt, addon_break_minutes, big_blind_ante, authorized_to_register, early_bird_enabled, early_bird_chips, bubble_protection, final_table_deal_enabled, restart_every_minutes, synchronized_breaks, on_break, break_started_at, break_ends_at, max_rebuys, max_reentries, is_pinned, satellite_seats, satellite_target_id, satellite_target'
      )
      .eq('id', tournamentId)
      .maybeSingle();

    if (error) {
      if (options?.throwOnError) throw error;
      reportError(error, 'TournamentService.Error_fetching_tournament');
      return null;
    }
    return data;
  }

  /**
   * TournamentConfig -> the exact p_config object fn_create_tournament reads.
   *
   * PUBLIC (2026-08-22) because tournament_schedules.config stores the same
   * shape — the schedule editors build their recurring config through this so
   * a scheduled spawn and a hand-created tournament can never drift apart.
   * Parity keys are included only when the creator actually set them; the
   * server owns every default. Clamped keys clamp here exactly as the server
   * clamps them (sliders clamp silently; money/structure keys were already
   * refused in createTournament's validation).
   */
  buildRpcConfig(config: TournamentConfig): Record<string, unknown> {
    if (config.satelliteTarget?.tournamentId && (
      ['bounty', 'progressive_bounty', 'mystery_bounty'].includes(config.type) ||
      config.bountyConfig || config.spinConfig
    )) {
      throw new Error('Satellites cannot combine ticket prizes with bounty or Spin payouts.');
    }
    if (config.satelliteTarget?.tournamentId && (config.type === 'sng' || config.type === 'spin')) {
      config = { ...config, type: 'satellite' };
    }
    if (isUnlimitedMtt(config)) {
      validateMttBlindStructure(config.blindStructure, config.startingStack);
    }
    const clampInt = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

    const p: Record<string, unknown> = {
      name: config.name,
      type: config.type,
      gameVariant: config.gameVariant || 'NLH',
      buyIn: config.buyIn,
      startingStack: config.startingStack,
      maxPlayers: normalizeTournamentMaxPlayers(config),
      minPlayers: config.minPlayers,
      blindStructure: config.blindStructure,
      payoutStructure: config.payoutStructure,
      guaranteedPrize: config.guaranteedPrize || 0,
      lateRegistrationLevels: config.lateRegistrationLevels || 0,
      startTime: config.startTime?.toISOString() ?? null,
      isRebuy: config.isRebuy || false,
      isReentry: config.isReentry || false,
      rebuyCost: config.rebuyCost || 0,
      rebuyChips: config.rebuyChips || 0,
      addOnAvailable: config.addOnAvailable || false,
      addOnCost: config.addOnCost || 0,
      addOnChips: config.addOnChips || 0,
      addOnLevels: config.addOnLevels || 1,
      freeBuy: config.freeBuy === true,
      addOnFromStart: config.addOnFromStart === true,
      /**
       * FREEROLLS ARE FREE BUY (Dan 2026-09-02): 0 to enter, rebuys and
       * add-ons on at 1 chip each. Every creation surface funnels through this
       * builder - the create form, the table-config page and the schedule
       * editors - so the rule is applied here, LAST, where it wins over
       * whatever the form held. Empty for a paid event, a Spin or an SNG.
       * fn_create_tournament writes these keys through verbatim; the
       * zz_freerolls_are_free_buy trigger is the backstop, not the mechanism.
       */
      ...freeBuyConfig({
        buyIn: config.buyIn,
        type: config.type,
        startingStack: config.startingStack,
        rebuyChips: config.rebuyChips,
        addOnChips: config.addOnChips,
        rebuyLevels: config.rebuyLevels,
        addOnLevels: config.addOnLevels,
        maxRebuys: config.maxRebuys,
      }),
      bountyAmount: config.bountyConfig?.baseBounty || 0,
      spinType: config.type === 'spin' ? config.spinType || 'standard' : null,
      satelliteTargetId: config.satelliteTarget?.tournamentId || null,
      isXmtt: config.isXmtt || false,
      isPrivate: config.isPrivate || false,
    };

    if (config.payoutPercent !== undefined) p.payoutPercent = config.payoutPercent;

    // ── Parity keys: only what the creator set ──
    const short = config.shortDescription?.trim();
    if (short) p.shortDescription = short;
    if (config.isVipOnly !== undefined) p.isVipOnly = config.isVipOnly;
    if (config.banChat !== undefined) p.banChat = config.banChat;
    if (config.allInOrFold !== undefined) p.allInOrFold = config.allInOrFold;
    if (config.labelAsNew !== undefined) p.labelAsNew = config.labelAsNew;
    if (config.hideClubName !== undefined) p.hideClubName = config.hideClubName;
    if (config.actionTimeSeconds !== undefined) {
      p.actionTimeSeconds = clampInt(config.actionTimeSeconds, 5, 60);
    }
    if (config.tableSize !== undefined) p.tableSize = clampInt(config.tableSize, 2, 10);
    if (config.acceleratedMtt !== undefined) p.acceleratedMtt = config.acceleratedMtt;
    if (config.addonBreakMinutes !== undefined) {
      p.addonBreakMinutes = clampInt(config.addonBreakMinutes, 1, 10);
    }
    if (config.bigBlindAnte !== undefined) p.bigBlindAnte = config.bigBlindAnte;
    if (config.authorizedToRegister !== undefined) {
      p.authorizedToRegister = config.authorizedToRegister;
    }
    if (config.earlyBirdEnabled !== undefined) p.earlyBirdEnabled = config.earlyBirdEnabled;
    if (config.earlyBirdChips !== undefined) {
      p.earlyBirdChips = Math.max(0, Math.round(config.earlyBirdChips));
    }
    if (config.bubbleProtection !== undefined) p.bubbleProtection = config.bubbleProtection;
    if (config.finalTableDealEnabled !== undefined) {
      p.finalTableDealEnabled = config.finalTableDealEnabled;
    }
    if (config.restartEveryMinutes !== undefined && config.restartEveryMinutes !== null) {
      p.restartEveryMinutes = clampInt(config.restartEveryMinutes, 5, RESTART_MAX_MINUTES);
    }
    if (config.synchronizedBreaks !== undefined) p.synchronizedBreaks = config.synchronizedBreaks;
    // A freeroll never sends a 0 cap: process_tournament_rebuy reads a NOT
    // NULL max_rebuys of 0 as "Rebuy limit reached (0 of 0)", which would deny
    // the 1-chip rebuys the Free Buy rule just switched on.
    const freeBuy = isFreeBuyEvent({ buyIn: config.buyIn, type: config.type });
    if (config.maxRebuys !== undefined && !(freeBuy && !(config.maxRebuys > 0))) {
      p.maxRebuys = config.maxRebuys;
    }
    if (config.maxReentries !== undefined && !(freeBuy && !(config.maxReentries > 0))) {
      p.maxReentries = config.maxReentries;
    }
    if (config.isMultiDay !== undefined) p.isMultiDay = config.isMultiDay;
    if (config.isMultiDay && config.totalDays !== undefined) p.totalDays = config.totalDays;
    if (config.type === 'mystery_bounty') {
      Object.assign(p, mysteryBountyCreationOptions(config));
      if (config.mysteryBountyMin !== undefined) p.mysteryBountyMin = config.mysteryBountyMin;
      if (config.mysteryBountyMax !== undefined) p.mysteryBountyMax = config.mysteryBountyMax;
    }
    if (config.isFeatured !== undefined) p.isFeatured = config.isFeatured;
    if (config.satelliteTarget?.seatsAwarded !== undefined) {
      // Previously the seats HALF of the satellite config was never sent —
      // the target id went up alone and every satellite awarded 1 seat.
      p.satelliteSeats = config.satelliteTarget.seatsAwarded;
    }

    return p;
  }

  /**
   * Create a new tournament
   */
  async createTournament(clubId: string, config: TournamentConfig): Promise<Tournament> {
    // Union governance: member-club staff lose every tournament-creation path,
    // including private tournaments. Union owners/admins remain authorized by
    // fn_game_creation_access and create against a selected host club.
    const resolvedClubId = await resolveClubUUID(clubId);
    const access = await fetchGameCreationAccess(resolvedClubId);
    if (!access.allowed) throw new Error(gameCreationDeniedMessage(access));

    // XMTT validation: require unionId and verify the union has crossClubTournaments enabled
    if (config.isXmtt) {
      if (!config.unionId) {
        throw new Error('XMTT tournaments require a union ID');
      }
      // Verify union exists and has crossClubTournaments enabled
      const { data: unionData, error: unionReadErr } = await supabase
        .from('unions')
        .select('id, settings')
        .eq('id', config.unionId)
        .maybeSingle();
      // ROUND 8 (2026-08-29): a failed read used to fall into 'Union not
      // found' - a permanent-sounding verdict for a transient failure. The
      // creator would reasonably conclude their union is misconfigured rather
      // than retry.
      if (unionReadErr) {
        reportError(unionReadErr, 'TournamentService.createTournament_union_read_failed', {
          unionId: config.unionId,
        });
        throw new Error('Could not verify union settings. Please try again.');
      }
      if (!unionData) {
        throw new Error('Union not found');
      }
      let settings: any = {};
      try {
        settings =
          typeof unionData.settings === 'string'
            ? JSON.parse(unionData.settings)
            : unionData.settings || {};
      } catch (err) {
        reportError(err, 'TournamentService.Error');
        settings = {};
      }
      if (settings && settings.crossClubTournaments === false) {
        throw new Error('This union does not allow cross-club tournaments');
      }
    }

    // VALIDATION: Payout structure percentages must sum to ~100%
    if (config.payoutStructure && Array.isArray(config.payoutStructure)) {
      const totalPercent = config.payoutStructure.reduce(
        (sum: number, p: any) => sum + (Number(p.percentage) || 0),
        0
      );
      if (totalPercent > 0 && Math.abs(totalPercent - 100) > 1) {
        throw new Error(`Payout percentages must sum to 100% (got ${totalPercent.toFixed(1)}%)`);
      }
    }

    // VALIDATION: Blind structure must have increasing blinds and positive durations
    // TOURNEY-AUDIT 2026-07-24: BREAK levels (isBreak / 0-0 blinds) are now
    // SKIPPED in the monotonicity check. The standard turbo/regular/deepStack
    // presets all contain break entries encoded as smallBlind:0/bigBlind:0, so
    // the old check threw "must not decrease" on EVERY tournament created with
    // a break-containing structure — a hard creation blocker.
    if (isUnlimitedMtt(config)) {
      validateMttBlindStructure(config.blindStructure, config.startingStack);
    } else if (config.blindStructure && Array.isArray(config.blindStructure)) {
      const isBreakLevel = (l: any): boolean =>
        !!l?.isBreak || (Number(l?.smallBlind) === 0 && Number(l?.bigBlind) === 0);
      let prevPlaying: any = null;
      for (let i = 0; i < config.blindStructure.length; i++) {
        const level = config.blindStructure[i] as any;
        if (level.durationMinutes !== undefined && level.durationMinutes <= 0) {
          throw new Error(
            `Blind level ${i + 1} has invalid duration (${level.durationMinutes}). Must be > 0.`
          );
        }
        if (isBreakLevel(level)) continue; // breaks don't participate in blind monotonicity
        if (prevPlaying) {
          // FIX: Use OR — either blind decreasing is invalid (was AND, which allowed partial decreases)
          if (
            Number(level.smallBlind) < Number(prevPlaying.smallBlind) ||
            Number(level.bigBlind) < Number(prevPlaying.bigBlind)
          ) {
            throw new Error(
              `Blind structure must not decrease: level ${i + 1} (${level.smallBlind}/${level.bigBlind}) is lower than the previous playing level (${prevPlaying.smallBlind}/${prevPlaying.bigBlind})`
            );
          }
        }
        prevPlaying = level;
      }
    }

    // ── WHOLE-NUMBER BUY-INS (Dan 2026-08-20, binding) ──
    // "Sit and Go and any tournament buy-ins must never be decimal buy-ins,
    // whole numbers only." The creation forms block decimal entry; this is the
    // service-of-record backstop for any other caller. It REFUSES rather than
    // rounding, so a caller can never quietly ship a game at a price it did not
    // ask for. fn_create_tournament applies the identical rule server-side.
    const wholeMoney: Array<[string, number | undefined]> = [
      ['Buy-in', config.buyIn],
      ['Rebuy cost', config.rebuyCost],
      ['Add-on cost', config.addOnCost],
      ['Guaranteed prize', config.guaranteedPrize],
      ['Bounty amount', config.bountyConfig?.baseBounty],
    ];
    for (const [label, value] of wholeMoney) {
      if (value === undefined || value === null) continue;
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a whole number of chips, with no decimals.`);
      }
    }

    // ── PARITY VALIDATION (2026-08-22) — mirrors fn_create_tournament ──
    // Slider-backed keys (action time, table size, add-on break) clamp
    // silently in buildRpcConfig, exactly as the server clamps them. Range
    // keys that carry money or structure REFUSE here with the same message
    // the server would send, so the owner is told before the round trip.
    if (config.earlyBirdChips !== undefined && config.earlyBirdChips < 0) {
      throw new Error(TOURNAMENT_CREATE_ERRORS.early_bird_chips_must_not_be_negative);
    }
    if (
      config.restartEveryMinutes !== undefined &&
      config.restartEveryMinutes !== null &&
      (config.restartEveryMinutes < 5 || config.restartEveryMinutes > RESTART_MAX_MINUTES)
    ) {
      throw new Error(TOURNAMENT_CREATE_ERRORS.restart_every_minutes_out_of_range);
    }
    if (config.isMultiDay) {
      const days = Number(config.totalDays);
      if (!Number.isInteger(days) || days < 2 || days > 7) {
        throw new Error(TOURNAMENT_CREATE_ERRORS.total_days_out_of_range);
      }
    }
    if (
      (config.mysteryBountyMin !== undefined || config.mysteryBountyMax !== undefined) &&
      config.type !== 'mystery_bounty'
    ) {
      throw new Error(TOURNAMENT_CREATE_ERRORS.mystery_range_requires_mystery_bounty);
    }
    if (config.type === 'mystery_bounty') {
      const mbMin = config.mysteryBountyMin;
      const mbMax = config.mysteryBountyMax;
      if (mbMin !== undefined && mbMax !== undefined && (mbMin <= 0 || mbMax < mbMin)) {
        throw new Error(TOURNAMENT_CREATE_ERRORS.mystery_bounty_range_invalid);
      }
    }
    if (config.satelliteTarget) {
      const seats = Number(config.satelliteTarget.seatsAwarded);
      if (!Number.isInteger(seats) || seats < 1) {
        throw new Error(TOURNAMENT_CREATE_ERRORS.satellite_seats_invalid);
      }
    }

    // Map format to variant for DB
    const variantMap: Record<string, string> = {
      mtt: 'freezeout',
      sng: 'sng',
      bounty: 'bounty',
      progressive_bounty: 'progressive_bounty',
      mystery_bounty: 'mystery_bounty',
      spin: 'spin',
      satellite: 'satellite',
    };

    // Map tournament type for the tournament_type column
    const isBountyType =
      config.type === 'bounty' ||
      config.type === 'progressive_bounty' ||
      config.type === 'mystery_bounty';

    // FIX: Use resolvedClubId from union guard above — raw clubId may not be a UUID
    const finalClubId = config.isXmtt ? clubId : await resolveClubUUID(clubId);
    // 2026-08-19 — this used to be a direct INSERT into `tournaments`, which
    // could never have worked from a browser: the table has RLS on with only a
    // public SELECT policy and a service_role ALL policy, and no INSERT policy
    // for authenticated. Every attempt failed with 42501, which is why all
    // 9,481 existing tournaments were created server-side by the recurring
    // service and why this modal appeared to do nothing.
    //
    // It now goes through fn_create_tournament, a SECURITY DEFINER function
    // that owns the three things a client must not be trusted with:
    //
    //   WHO   — fn_can_create_games enforces the owner ruling: a standalone
    //           club's owner/admin, or the union's owner/admin for a club that
    //           belongs to a union (that club does not build its own games).
    //   FEE   — the 10% house fee. The override below is still applied so the
    //           UI shows the right number, but the server recomputes it and
    //           ignores whatever arrives.
    //   STATE — status, current_players and the prize/bounty pools.
    //
    // The checks above are kept because they produce better messages than the
    // single deliberately-vague 'not_authorised' the function returns (it must
    // not let a caller probe which clubs exist or who administers them).
    const { data: rpcResult, error: rpcError } = await supabase.rpc('fn_create_tournament', {
      p_club_id: await resolveClubUUID(clubId),
      p_config: this.buildRpcConfig(config),
    });

    /**
     * NEVER SHOW A PLAYER A POSTGRES ERROR (2026-08-27).
     *
     * This used to rethrow the raw PostgrestError, and both creation surfaces
     * toast `error.message` — so a CHECK violation surfaced verbatim as
     * `new row for relation "tournaments" violates check constraint ...`.
     * The named codes below are the ones a creation insert can actually hit:
     * 23514 (a money/whole-number CHECK), 0A000 (a feature the database
     * refuses because it is not built, e.g. multi-day), 42501 (RLS). The raw
     * error still goes to the reporter so nothing is lost for debugging.
     */
    if (rpcError) {
      reportError(rpcError, 'TournamentService.createTournament_rpc');
      const code = (rpcError as { code?: string }).code ?? '';
      const friendly: Record<string, string> = {
        '23514': 'Could not create the tournament. The buy-in or fee failed a safety check.',
        '0A000': 'Could not create the tournament. That option is not available yet.',
        '42501': 'You do not have permission to create games for this club.',
      };
      /**
       * 55000 IS THE GUARANTEE REFUSAL, AND ITS MESSAGE IS ALREADY WRITTEN
       * FOR THE OWNER (2026-08-31 audit).
       *
       * trg_tournaments_guarantee_affordable raises, verbatim: "Club X cannot
       * guarantee N chips: <bank> holds A, floor B, already promised C on live
       * events — short by D. Add chips to the bank to cover the guarantee."
       * That sentence names the shortfall and the remedy.
       *
       * It was not in this map, so it fell to the default — "Please try again"
       * — which describes a transient blip. The condition is neither
       * transient nor mysterious: the owner is short by a stated number of
       * chips and nothing they retry will change that. The migration that
       * added the trigger even records the assumption this broke: "The UI
       * already shows the raise verbatim as a toast."
       *
       * Passed through as written. The Toast layer applies the house style
       * (Title Case, no em dashes) at render, so the raise text needs no
       * massaging here.
       */
      const raised = String((rpcError as { message?: string }).message ?? '').trim();
      if (code === '55000' && raised) throw new Error(raised);
      throw new Error(friendly[code] ?? 'Could not create the tournament. Please try again.');
    }
    const result = rpcResult as {
      success?: boolean;
      error?: string;
      tournament_id?: string;
      mystery_config?: Record<string, unknown>;
    } | null;
    if (!result?.success) {
      throw new Error(
        TOURNAMENT_CREATE_ERRORS[result?.error ?? ''] ?? 'Could not create tournament'
      );
    }

    if (config.type === 'mystery_bounty') {
      const expected = mysteryBountyCreationColumns(config);
      if (
        !result.mystery_config ||
        Object.entries(expected).some(([key, value]) => result.mystery_config?.[key] !== value)
      ) {
        reportError(
          new Error('Mystery creation receipt did not match selected options'),
          'TournamentService.mystery_creation_receipt_invalid',
          { tournamentId: result.tournament_id }
        );
        throw new Error(
          'The tournament was created, but its mystery options could not be confirmed. Refresh the lobby before creating another tournament.'
        );
      }
    }

    // The original RPC now commits the selected mystery terms atomically.
    // A failed config write rolls back that creation; there is no second request
    // that can silently substitute defaults or race the first registration.

    // ROUND 8 (2026-08-29): this refetch discarded its error and returned
    // `data` bare, so a transient failure returned null from a method typed
    // Promise<Tournament> - the creation surfaces then treated a SUCCESSFUL
    // creation as a failure, and a creator who believed the error made the
    // same tournament twice. The message now says what actually happened.
    const { data, error: refetchErr } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', result.tournament_id!)
      .maybeSingle();
    if (refetchErr || !data) {
      reportError(refetchErr, 'TournamentService.created_tournament_refetch_failed', {
        tournamentId: result.tournament_id,
      });
      throw new Error(
        'The tournament was created. It could not be loaded for display, so refresh the lobby to see it.'
      );
    }
    return data;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ask the server whether this player owns an exact entry-only ticket for the
   * tournament. A failed or malformed selector is an error, never "no ticket":
   * callers must not silently fall through to a wallet charge when ticket
   * ownership could not be checked.
   */
  async findTournamentEntryTicket(tournamentId: string): Promise<TournamentEntryTicket | null> {
    const { data, error } = await supabase.rpc('fn_find_tournament_entry_ticket', {
      p_tournament_id: tournamentId,
    });
    if (error) {
      reportError(error, 'TournamentService.findTournamentEntryTicket', { tournamentId });
      throw new Error('Could Not Check For A Tournament Ticket. No Chips Were Charged.');
    }

    const res = data as {
      ok?: boolean;
      reason?: string;
      ticket_id?: string | null;
      ticket_value?: number | string | null;
    } | null;
    if (
      !res ||
      typeof res.ok !== 'boolean' ||
      !Object.prototype.hasOwnProperty.call(res, 'ticket_id')
    ) {
      reportError(
        new Error('Malformed tournament-entry ticket selector response'),
        'TournamentService.findTournamentEntryTicket',
        { tournamentId }
      );
      throw new Error('Could Not Check For A Tournament Ticket. No Chips Were Charged.');
    }
    if (!res.ok) throw new Error(registerReasonText(res.reason));
    if (res.ticket_id === null) return null;

    const ticketId = typeof res.ticket_id === 'string' ? res.ticket_id.trim() : '';
    const ticketValue = res.ticket_value == null ? Number.NaN : Number(res.ticket_value);
    if (!ticketId || !Number.isFinite(ticketValue) || ticketValue <= 0) {
      reportError(
        new Error('Malformed tournament-entry ticket selector payload'),
        'TournamentService.findTournamentEntryTicket',
        { tournamentId }
      );
      throw new Error('Could Not Check For A Tournament Ticket. No Chips Were Charged.');
    }
    return { id: ticketId, value: ticketValue };
  }

  /**
   * Register a player for a tournament
   */
  async registerPlayer(
    tournamentId: string,
    userId: string,
    username: string,
    tournamentTicketId?: string | null
  ): Promise<TournamentPlayer> {
    const { data: auth, error: authError } = await getAuthUser();
    if (authError || !auth.user || auth.user.id !== userId) {
      throw new Error('Sign In To The Correct Account Before Registering For A Tournament.');
    }
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    // Presence, not truthiness, selects the noncash rail. If a caller says it
    // found a ticket but hands us a malformed id, fail closed instead of
    // silently charging the wallet.
    const usesTournamentTicket = tournamentTicketId !== undefined && tournamentTicketId !== null;
    if (usesTournamentTicket && !tournamentTicketId?.trim()) {
      throw new Error('Could Not Use The Tournament Ticket. No Chips Were Charged.');
    }

    // ═══ AUDIT 2026-08-15: registration is SERVER-AUTHORITATIVE ═══
    // The old path called atomic_tournament_register directly — a
    // service_role-only RPC — so EVERY human registration from the browser
    // failed with 42501 (every completed tournament was horse-filled), and
    // then attempted ~10 privileged client writes (rake_records, tournaments
    // counters, unions.total_rake) that RLS rejects, plus a CLIENT-side
    // mystery-bounty roll (manipulable). fn_register_for_tournament now does
    // the whole thing in one transaction on the server: derives the cost from
    // the tournaments row (never trusts the client), enforces status /
    // late-reg (current_level vs late_reg_levels, minutes fallback) / full /
    // duplicate under a row lock, rolls mystery bounties server-side, debits
    // via the guarded wallet RPC with a wallet_transactions ledger row, writes
    // the entry FEE to the rake_records fee ledger (what the finalize
    // settlement actually credits to the club/union), and bumps
    // current_players + prize_pool.
    const invokeAdmission = async (requestId?: string) => {
      try {
        return usesTournamentTicket
          ? await supabase.rpc('fn_register_for_tournament_with_ticket', {
              p_tournament_id: tournamentId,
              p_ticket_id: tournamentTicketId,
            })
          : await supabase.rpc('fn_register_for_tournament_request', {
              p_tournament_id: tournamentId,
              p_request_id: requestId,
            });
      } catch (error) {
        return { data: null, error };
      }
    };
    const performRegistration = async (requestId?: string): Promise<TournamentPlayer> => {
      let rpcCall = await invokeAdmission(requestId);
      if (rpcCall.error) rpcCall = await invokeAdmission(requestId);
      const { data: rpcResult, error: rpcError } = rpcCall;
      const res = rpcResult as {
        ok: boolean;
        reason?: string;
        registration_id?: string;
        request_id?: string;
        tournament_id?: string;
        user_id?: string;
        ticket_id?: string;
        cost?: number;
        mystery_bounty?: number | null;
        /** Diamond Phase 8: the receipt names its asset and the Diamond wallet after. */
        asset?: string;
        diamonds_after?: number | null;
      } | null;
      const registrationId = res?.registration_id;
      if (rpcError) {
        reportError(rpcError, 'TournamentService.registration_result_unconfirmed', {
          tournamentId,
          userId,
          tournamentTicketId,
          requestId,
        });
        throw new Error(
          usesTournamentTicket
            ? 'Could Not Confirm Tournament Ticket Registration. Please Refresh Before Trying Again.'
            : 'Could Not Confirm Tournament Registration. Please Refresh Before Trying Again.'
        );
      }
      if (res?.ok === false) throw new Error(registerReasonText(res.reason));
      if (
        res?.ok !== true ||
        typeof registrationId !== 'string' ||
        !registrationId ||
        (!usesTournamentTicket &&
          (res.request_id !== requestId ||
            res.tournament_id !== tournamentId ||
            res.user_id !== userId))
      ) {
        throw new Error(
          usesTournamentTicket
            ? 'Could Not Confirm Tournament Ticket Registration. Please Refresh Before Trying Again.'
            : 'Could Not Confirm Tournament Registration. Please Refresh Before Trying Again.'
        );
      }
      if (usesTournamentTicket && res?.ticket_id !== tournamentTicketId) {
        reportError(
          new Error('Tournament ticket admission returned a mismatched receipt'),
          'TournamentService.ticket_registration_receipt_mismatch',
          { tournamentId, userId, tournamentTicketId, receiptTicketId: res?.ticket_id }
        );
        throw new Error(
          'Could Not Confirm Tournament Ticket Registration. Please Refresh Before Trying Again.'
        );
      }

      // Re-fetch the player row the server created (the RPC returns only ids)
      const { data, error } = await supabase
        .from('tournament_players')
        .select(
          'id, tournament_id, user_id, username, status, chips, table_id, position, prize, current_bounty, mystery_bounty_value, rebuys, registered_at, bounties_collected, bounty_winnings'
        )
        .eq('id', registrationId)
        .maybeSingle();
      if (error || !data) {
        reportError(error, 'TournamentService.Could_not_refetch_registered_player');
        throw new Error('Registration succeeded but player data could not be retrieved');
      }

      // Entry-only tickets move escrow into tournament liability; they do not
      // debit or credit the player's Club Arena wallet.
      if (!usesTournamentTicket) {
        masterBus.emit('BALANCE_UPDATED', { source: 'tournament_buyin', userId });
      }
      // Diamond Phase 8: a Diamond entry left the Diamond wallet, not a club
      // chip wallet, and no engine pushes that balance; the receipt carries it.
      if (res?.asset === 'diamonds' && typeof res.diamonds_after === 'number') {
        masterBus.emit('DIAMOND_BALANCE_CHANGED', {
          newBalance: res.diamonds_after,
          delta: -Number(res.cost ?? 0),
          source: 'tournament_buyin',
        });
      }
      masterBus.emit('TOURNAMENT_REGISTERED', { tournamentId, userId, clubId: tournament.club_id });
      masterBus.emit('TOURNAMENT_UPDATED', { tournamentId, status: tournament.status });

      // ── SNG/SPIN AUTO-START nudge (unchanged behavior): when full, pull
      // start_time to now so the server discovery loop starts it immediately.
      const { data: freshTournament, error: freshErr } = await supabase
        .from('tournaments')
        .select('current_players, max_players, tournament_type, variant, satellite_target_id, satellite_target')
        .eq('id', tournamentId)
        .maybeSingle();
      // ROUND 8 (2026-08-29): reported, not thrown - the player IS registered,
      // and the server discovery loop still starts a full game on its own
      // schedule. But a silently skipped nudge is a slower start with no trace.
      if (freshErr) {
        reportError(freshErr, 'TournamentService.SNG_autostart_freshness_read_failed', {
          tournamentId,
        });
      }
      if (
        freshTournament?.max_players &&
        !isUnlimitedMtt(freshTournament) &&
        (freshTournament.current_players ?? 0) >= freshTournament.max_players &&
        (freshTournament.variant === 'sng' || freshTournament.variant === 'spin')
      ) {
        // DEFECT D7: this was an unchecked `.update()` wrapped in a try/catch.
        // A PostgREST call RESOLVES with `{ error }` instead of throwing, so the
        // catch could only ever have caught a transport failure - an RLS denial
        // on this client-side write (the likely outcome, since `tournaments` is
        // not player-writable) resolved normally and was discarded. The nudge
        // silently did nothing and the SNG/Spin sat waiting for a start that the
        // discovery loop had not been told to bring forward.
        const { error: autoStartError } = await supabase
          .from('tournaments')
          .update({ start_time: new Date().toISOString() })
          .eq('id', tournamentId);
        if (autoStartError) {
          // Reported, not thrown: the player IS registered and paid, and the
          // server discovery loop still starts the game on its own schedule.
          // Failing the registration here would be a worse lie than the old one.
          reportError(autoStartError, 'TournamentService.SNG_autostart_failed', { tournamentId });
        }
      }

      return data;
    };
    // Keep the original operation pending until its receipt and roster are both
    // confirmed. A failed read after commit must not permit a new paid request.
    if (usesTournamentTicket) return performRegistration();
    return withTournamentUnregistrationIntent(
      userId,
      'registration:' + tournamentId,
      performRegistration
    );
  }

  /**
   * Unregister a player and refund their buy-in.
   *
   * AUDIT M19: this used to be six client round trips - read the tournament,
   * check the start-time window, verify the registration, delete it, credit
   * `buy_in_amount + buy_in_fee` computed HERE through `credit_player_wallet`,
   * and re-INSERT the player if the credit failed.
   *
   * The credit was permission-denied on every call (`credit_player_wallet` is
   * granted to postgres and service_role only), so no player has ever actually
   * been refunded by this path - and because the delete DID matter, the failure
   * mode was the worst kind: the compensating re-INSERT was the only thing
   * putting the player back.
   *
   * It also passed no idempotency key, so each `retryAsync` attempt would have
   * been a fresh credit if the grant had ever been widened.
   *
   * `fn_unregister_from_tournament` does the whole thing in one transaction. It
   * takes no user id (a player may only unregister themselves, and the way to
   * guarantee that is to never accept a target) and no amount (the refund is
   * derived from immutable entry entitlements). It permits unregistration at
   * any time before the scheduled start and refuses it at or after the start;
   * the server row lock keeps that boundary atomic with seating.
   *
   * The compensating re-INSERT is gone because it is no longer needed: a failed
   * refund rolls the delete back with it, so the player is simply still
   * registered.
   */
  async unregisterPlayer(
    tournamentId: string,
    userId: string
  ): Promise<TournamentUnregisterResult> {
    const { data: auth, error: authError } = await getAuthUser();
    if (authError || !auth.user || auth.user.id !== userId)
      throw new Error('Sign In To The Correct Account Before Requesting A Refund.');
    return withTournamentUnregistrationIntent(userId, tournamentId, async (requestId) => {
      const result = await executeTournamentUnregisterRpc(
        async () =>
          supabase.rpc('fn_unregister_from_tournament', {
            p_tournament_id: tournamentId,
            p_request_id: requestId,
          }),
        requestId,
        'TournamentService.unregisterPlayer_result_unconfirmed',
        { tournamentId, userId }
      );

      if (result.refundedChips > 0) {
        masterBus.emit('BALANCE_UPDATED', { source: 'tournament_unregister_refund', userId });
      }
      announceDiamondRefund(result);
      return result;
    });
  }

  /**
   * Release a reserved pre-start table seat through the same exact refund
   * owner. The stable request id makes the one retry an exact receipt replay,
   * including when the first response disappeared after commit.
   */
  async leaveTournamentSeatAndRefund(
    tableId: string,
    userId: string
  ): Promise<TournamentUnregisterResult> {
    const { data: auth, error: authError } = await getAuthUser();
    if (authError || !auth.user || auth.user.id !== userId) {
      throw new Error(
        'Please Sign In To The Correct Account Before Requesting A Tournament Refund.'
      );
    }
    return withTournamentUnregistrationIntent(userId, 'seat:' + tableId, async (requestId) => {
      const result = await executeTournamentUnregisterRpc(
        async () =>
          supabase.rpc('fn_leave_seat_and_refund', {
            p_table_id: tableId,
            p_request_id: requestId,
          }),
        requestId,
        'TournamentService.leaveTournamentSeatAndRefund_result_unconfirmed',
        { tableId, userId }
      );
      if (result.refundedChips > 0) {
        masterBus.emit('BALANCE_UPDATED', { source: 'tournament_unregister_refund', userId });
      }
      announceDiamondRefund(result);
      return result;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tournament Cancellation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compatibility entry point for an operator cancelling an empty tournament.
   * The database refuses this command after the first registration. Recovery
   * refunds remain service-role-only and are not exposed to the browser.
   */
  async cancelTournament(
    tournamentId: string,
    _reason: string = 'Cancelled By Operator'
  ): Promise<{ refunded: number; playersRefunded: number }> {
    await gameManagementService.close('tournament', tournamentId);
    return { refunded: 0, playersRefunded: 0 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tournament Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ask the authoritative tournament engine to start this event now.
   *
   * The browser used to claim RUNNING, create tables, seat players, and rewrite
   * the roster itself. That was neither transactional nor compatible with the
   * server discovery loop, and browser roster writes are now deliberately
   * forbidden. This RPC only advances `start_time`; the engine remains the one
   * owner of validation, table creation, seating, stacks, and the RUNNING claim.
   */
  async startTournament(tournamentId: string): Promise<Tournament> {
    const { data, error } = await supabase.rpc('fn_owner_start_tournament_now', {
      p_tournament_id: tournamentId,
    });

    if (error) {
      reportError(error, 'TournamentService.start_request_failed', { tournamentId });
      throw new Error(`Could not request tournament start: ${error.message}`);
    }

    const result = data as {
      ok?: boolean;
      reason?: string;
      status?: string;
      already_due?: boolean;
    } | null;
    if (!result?.ok) {
      const reason = result?.reason ?? 'unknown';
      const message: Record<string, string> = {
        tournament_not_found: 'Tournament not found',
        not_authenticated: 'Sign in to start this tournament',
        not_authorised: 'You are not authorised to start this tournament',
        not_startable: `Tournament cannot be started from ${result?.status ?? 'its current status'}`,
      };
      throw new Error(message[reason] ?? `Could not request tournament start (${reason})`);
    }

    const tournament = await this.getTournament(tournamentId);
    if (!tournament) {
      throw new Error(
        'The tournament start was requested, but its updated lobby could not be loaded'
      );
    }
    return tournament;
  }

  // AUDIT M19: `eliminatePlayer` is deleted, not converted.
  //
  // Same story as collectBounty below. The engine owns finish-position payouts:
  // it prepares the exact full-field obligations, then one database transaction
  // debits escrow, credits every wallet, records every payout and completes the
  // tournament. This client copy computed one prize itself and passed no
  // idempotency key, so it was a latent double-payout beside the authoritative
  // settlement rather than an independent feature - and it had no callers
  // outside this file.
  //
  // `calculatePayout` below is kept: it is a pure function used for DISPLAYING
  // projected payouts in the lobby, which is a legitimate client concern. It
  // must never be wired back into a credit.

  // AUDIT M19: `eliminatePlayerAuto` is deleted with `eliminatePlayer`.
  //
  // It was that method's only caller, and nothing anywhere called IT - not the
  // client, not the engine. The whole chain was a dead client duplicate of
  // `TournamentManagerEliminations`, which runs on the server, derives the
  // finish position from authoritative state, and pays the prize idempotently.
  // Eliminating a player is a consequence of losing a hand; it is not something
  // a browser should be able to assert.

  /**
   * Get payout amount for a position
   */
  calculatePayout(prizePool: number, position: number, structure: PayoutStructure[]): number {
    // 2026-08-29: was `Math.trunc(prizePool * entry.percentage) / 100`, which
    // truncated where the engine rounds and had no residual rule, so its
    // places did not sum to the pool. One rule now, shared with the engine
    // byte for byte -- see src/lib/payoutMath.ts.
    //
    // 2026-09-13: the unit is stated rather than defaulted. This method is
    // documented above as display-only ("it must never be wired back into a
    // credit") and takes no tournament, so it has no club to read an asset
    // from. UNIT_CENTS_ASSET_NOT_READ says that, and is what the Diamond
    // tournament work greps for. See server/src/tournament/tournamentUnit.ts.
    return computePlacePrize(prizePool, structure, position, UNIT_CENTS_ASSET_NOT_READ);
  }

  /**
   * Get current blind level based on time elapsed
   */
  /**
   * Get current blind level state with high precision
   */
  getCurrentLevelState(tournament: Tournament): {
    currentLevel: BlindLevel;
    nextLevel: BlindLevel | null;
    timeRemainingSeconds: number;
    levelIndex: number;
  } {
    // Handle blind_structure being a JSON string (Supabase REST returns JSONB as string)
    let blinds: BlindLevel[];
    const raw: unknown = tournament.blind_structure;
    if (Array.isArray(raw) && raw.length > 0) {
      blinds = raw as BlindLevel[];
    } else if (typeof raw === 'string' && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw);
        blinds =
          Array.isArray(parsed) && parsed.length > 0
            ? parsed
            : [{ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 15 }];
      } catch {
        blinds = [{ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 15 }];
      }
    } else {
      blinds = [{ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 15 }];
    }

    /**
     * A LEVEL'S LENGTH IS SPELLED THREE WAYS, AND ONE OF THEM IS SECONDS.
     *
     * `durationMinutes` / `duration_minutes` hold minutes; `duration` holds
     * SECONDS, and every Spin is written that way — `createSpin` stores
     * `duration: 180` for a three-minute level and no minutes key at all.
     * Reading `.durationMinutes` directly, as all four sites in this method
     * used to, gives a Spin:
     *
     *   line 1520   `undefined * 60`            -> NaN  (the pre-start clock)
     *   here        `(undefined || 10) * 60`    -> 600s for a 180s level
     *   wall-clock  `undefined * 60 * 1000`     -> NaN, and the loop that
     *                                              walks the structure never
     *                                              matches, so it falls off
     *                                              the end
     *
     * The 600 is the one that shows. DetailOverviewTab's hero meter computes
     * `(1 - remaining/duration) * 100` against a `duration` the PAGE
     * normalised correctly to 180 — so `(1 - 600/180) * 100` is -233%, clamps
     * to 0, and the meter sits visibly empty for the first seven minutes of a
     * three-minute level before snapping. The clock beside it counts down from
     * 10:00 on a level that ends at 3:00.
     *
     * `blindLevelMinutes` is the canonical reader and gets the precedence
     * right (canonical keys first, seconds last, 0 for "unknown" rather than a
     * guess). Everything below goes through `levelMinutes`, which adds only
     * the service's own 10-minute fallback for a structure that genuinely does
     * not say — and never mistakes 180 seconds for 180 minutes.
     */
    /** What this method fell back to before, kept so behaviour is unchanged
     *  for a structure that genuinely carries no length at all. */
    const DEFAULT_LEVEL_MINUTES = 10;
    const levelMinutes = (level: BlindLevel | undefined): number => {
      if (!level) return DEFAULT_LEVEL_MINUTES;
      /* `blindLevelMinutes` matches on the row's own `level` field first and
         falls back to position, so a single-element array asked for level 1
         resolves to that element either way. */
      const mins = blindLevelMinutes([level] as Parameters<typeof blindLevelMinutes>[0], 1);
      return mins > 0 ? mins : DEFAULT_LEVEL_MINUTES;
    };

    if (tournament.status !== 'RUNNING' || !tournament.started_at) {
      return {
        currentLevel: blinds[0],
        nextLevel: blinds[1] || null,
        timeRemainingSeconds: Math.round(levelMinutes(blinds[0]) * 60),
        levelIndex: 0,
      };
    }

    // TOURNEY-AUDIT 2026-07-24 (sweep 4): the SERVER-persisted current_level is
    // authoritative when present. The wall-clock derivation below ignores
    // synchronized breaks, hand-for-hand pauses, and restarts, so it drifts
    // AHEAD of the real level and mis-gated late-reg/rebuy/add-on windows
    // (which are additionally enforced server-side in process_tournament_rebuy
    // now). Wall-clock remains the fallback for level TIMING display only.
    const serverT = tournament as unknown as {
      current_level?: number | null;
      level_started_at?: string | null;
    };
    /**
     * =========================================================================
     *  `tournaments.current_level` IS A 0-BASED ARRAY INDEX (verified 2026-08-25)
     * =========================================================================
     *
     * Three independent confirmations, so nobody has to re-derive it:
     *
     *  1. The authoritative writer is the engine. TournamentManagerBase holds
     *     `this.currentLevel` as an array index (`blindStructure[this.currentLevel]`)
     *     and persists exactly that: `.update({ current_level: this.currentLevel })`.
     *     Its auto-escalated row is labelled `level: this.currentLevel + 1`.
     *  2. Production agrees. For every RUNNING event with a uniform structure,
     *     `current_level == floor(elapsed_seconds / level_duration_seconds)`,
     *     and `blind_structure[current_level].level == current_level + 1`.
     *  3. The SQL gate agrees. `process_tournament_rebuy` reads the column into
     *     `v_level` and closes on `v_level >= v_cap`, the same comparison this
     *     file makes against `levelIndex`.
     *
     * So `levelIndex` below is an honest 0-based index, the array lookup is
     * direct, and every caller that renders `levelIndex + 1` is correct.
     *
     * TWO EDGE CASES ARE HANDLED EXPLICITLY:
     *
     *  - NOT YET PERSISTED. A null/absent column (a select that omitted it)
     *    falls through to the wall-clock derivation. A value of 0 does NOT -
     *    0 is a real level, the opening one, and is read from the array.
     *  - AUTO-ESCALATED. Past the end of the structure the engine keeps
     *    incrementing and doubles the last playable level's blinds in memory,
     *    so `current_level` legitimately exceeds `blind_structure.length`
     *    (3079 rows in production as this was written). The array cannot
     *    describe those levels, so the LOOKUP clamps to the last row while
     *    `levelIndex` keeps the TRUE level - because that is the number the
     *    rebuy / re-entry / add-on gates and the SQL RPC both compare against.
     *    This used to fall through to wall-clock, which capped the reported
     *    level at `length - 1` and could hold a money window open that the
     *    database had already closed.
     */
    const serverLevel = serverT.current_level;
    if (typeof serverLevel === 'number' && Number.isFinite(serverLevel) && serverLevel >= 0) {
      const lookupIndex = Math.min(serverLevel, blinds.length - 1);
      const level = blinds[lookupIndex];
      const durationSec = Math.round(levelMinutes(level) * 60);
      // TOURNEY-AUDIT 2026-07-24 (sweep 5): precise remaining time from the
      // server-persisted level clock (tournaments.level_started_at) — the
      // countdown now matches the engine's actual timer instead of showing
      // the full level duration as an upper bound.
      let remaining = durationSec;
      if (serverT.level_started_at) {
        const elapsedSec = (Date.now() - new Date(serverT.level_started_at).getTime()) / 1000;
        // An old canonical anchor is overdue, not permission to reset the display.
        if (Number.isFinite(elapsedSec) && elapsedSec >= 0) {
          remaining = Math.max(0, Math.floor(durationSec - elapsedSec));
        }
      }
      return {
        currentLevel: level,
        nextLevel: blinds[serverLevel + 1] || null,
        timeRemainingSeconds: remaining,
        levelIndex: serverLevel,
      };
    }

    const elapsedMs = new Date().getTime() - new Date(tournament.started_at).getTime();
    let accumulatedMs = 0;

    for (let i = 0; i < blinds.length; i++) {
      const level = blinds[i];
      const durationMs = levelMinutes(level) * 60 * 1000;

      if (elapsedMs < accumulatedMs + durationMs) {
        return {
          currentLevel: level,
          nextLevel: blinds[i + 1] || null,
          timeRemainingSeconds: Math.floor((accumulatedMs + durationMs - elapsedMs) / 1000),
          levelIndex: i,
        };
      }
      accumulatedMs += durationMs;
    }

    // Capped at last level
    return {
      currentLevel: blinds[blinds.length - 1],
      nextLevel: null,
      timeRemainingSeconds: 0,
      levelIndex: blinds.length - 1,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rebuy / Add-on
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if rebuy is available for a player
   */
  async canRebuy(
    tournamentId: string,
    userId: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) return { allowed: false, reason: 'Tournament not found' };

    if (!tournament.is_rebuy && !tournament.is_reentry)
      return { allowed: false, reason: 'Rebuys/re-entries not available' };
    if (tournament.status !== 'RUNNING')
      return { allowed: false, reason: 'Tournament is not accepting rebuys/re-entries' };
    if (tournament.prize_pool_finalized)
      return { allowed: false, reason: 'The prize pool is finalized' };

    // Validate rebuy chips are configured
    const rebuyChips = tournament.rebuy_chips || tournament.starting_chips;
    if (!rebuyChips || rebuyChips <= 0)
      return { allowed: false, reason: 'Rebuy chips not configured' };

    /**
     * REBUYS STAY OPEN THROUGH THE ADD-ON WINDOW (Dan 2026-08-23, binding).
     *
     * "rebuys are open until level 8... but there is an add on period... rebuys
     * and add on's stay open for that last minute. If there is no add ons and
     * rebuys stop after level 8, the second level 9 starts, registration is
     * closed and prizepool is finalized."
     *
     * This closed rebuys at the cutoff while canAddOn opened the add-on window
     * at that same instant, so the add-on period — the one moment a short stack
     * most wants to reload — was exactly when rebuys became unavailable. It
     * also disagreed with the engine, which defers prize-pool finalization
     * until after the add-on window precisely because money is still arriving.
     *
     * `levelIndex` is 0-based, so "through level N" is indices 0..N-1 and N is
     * the cutoff — the same instant TournamentManagerBase.isLateRegClosed uses.
     * With no add-on configured the window is unchanged.
     */
    const now = Date.now();
    const addonStartsAt = Date.parse(String(tournament.addon_period_started_at || ''));
    const addonEndsAt = Date.parse(String(tournament.addon_period_ends_at || ''));
    const addonWindowOpen =
      tournament.add_on_available === true &&
      Number.isFinite(addonStartsAt) &&
      Number.isFinite(addonEndsAt) &&
      now >= addonStartsAt &&
      now < addonEndsAt;
    const rebuyLevelCap = Number(tournament.rebuy_levels ?? tournament.late_reg_levels ?? 0);
    if (rebuyLevelCap > 0) {
      const persistedLevel = Number(tournament.current_level);
      if (!Number.isInteger(persistedLevel) || persistedLevel < 0) {
        return { allowed: false, reason: 'Could not verify the current tournament level' };
      }
      if (persistedLevel >= rebuyLevelCap && !addonWindowOpen) {
        return { allowed: false, reason: 'Rebuy/re-entry period has ended' };
      }
    } else {
      const timedMinutes = Number(tournament.late_reg_mins ?? 0);
      const startedAt = Date.parse(String(tournament.started_at || ''));
      const timedWindowOpen =
        timedMinutes > 0 && Number.isFinite(startedAt) && now < startedAt + timedMinutes * 60_000;
      if (!timedWindowOpen && !addonWindowOpen) {
        return { allowed: false, reason: 'Rebuy/re-entry period has ended' };
      }
    }

    // Mirror the player-visible half of the atomic purchase authority. A
    // normal short stack is not a rebuy candidate: only an unpaid zero-stack
    // knockout generation can buy back in. The database still binds that row
    // to the immutable accepted-hand candidate under lock when money moves.
    const { data: player, error: stackErr } = await supabase
      .from('tournament_players')
      .select('chips, status, prize, rebuys, rebuy_prompt_until')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

    // ROUND 8 (2026-08-29): a failed read used to answer 'Player not found' -
    // a permanent-sounding refusal for a transient failure, to a player who is
    // demonstrably IN the tournament asking to rebuy.
    if (stackErr) {
      reportError(stackErr, 'TournamentService.canRebuy_stack_read_failed', { tournamentId });
      return { allowed: false, reason: 'Could not check your stack. Please try again.' };
    }
    if (!player) return { allowed: false, reason: 'Player not found' };
    const purchaseType = tournament.is_reentry && !tournament.is_rebuy ? 'reentry' : 'rebuy';
    const playerStatus = String(player.status ?? '').toLowerCase();
    if (
      Number(player.chips ?? 0) !== 0 ||
      Number(player.prize ?? 0) > 0 ||
      (purchaseType === 'rebuy'
        ? playerStatus !== 'playing'
        : !['playing', 'eliminated'].includes(playerStatus))
    ) {
      return { allowed: false, reason: 'Only An Unpaid Zero-Stack Entry Can Rebuy' };
    }
    if (purchaseType === 'rebuy') {
      const promptUntil = Date.parse(String(player.rebuy_prompt_until ?? ''));
      if (!Number.isFinite(promptUntil) || promptUntil <= Date.now()) {
        return { allowed: false, reason: 'The Rebuy Decision Window Has Closed' };
      }
    }
    const used = Math.max(0, Number(player.rebuys ?? 0));
    const limit = purchaseType === 'reentry' ? tournament.max_reentries : tournament.max_rebuys;
    if (limit !== null && limit !== undefined && used >= Number(limit)) {
      return {
        allowed: false,
        reason: purchaseType === 'reentry' ? 'Re-Entry Limit Reached' : 'Rebuy Limit Reached',
      };
    }

    return { allowed: true };
  }

  /**
   * RAKE-AUDIT 2026-07-24: House fee ratio for tournament/SNG chip purchases.
   * Dan's rule: 10% on ANY AND ALL tournament and SNG buy-ins — including
   * rebuys, add-ons, and re-entries (all previously fee-free). Uses the
   * tournament's configured entry-fee ratio when present (buy_in_fee /
   * buy_in_amount), falling back to the platform-standard 10%.
   */
  private getTournamentFeeRatio(tournament: {
    buy_in_amount?: number | null;
    buy_in_fee?: number | null;
  }): number {
    const prize = Number(tournament.buy_in_amount || 0);
    const fee = Number(tournament.buy_in_fee || 0);
    // 2026-08-20: this divided the fee by buy_in_amount, but buy_in_amount is
    // the PRIZE half of the split, not the price. A 20 game stored as 18 + 2
    // therefore reported an 11.1% ratio instead of 10%. The advertised buy-in
    // is prize + fee, so that is what the fee is a fraction OF.
    if (prize + fee > 0 && fee > 0) return fee / (prize + fee);
    return 0.1;
  }

  /**
   * Fee cut out of the whole advertised price, floored to cents.
   *
   * The 2026-08-25 fractional-fee rule supersedes the earlier whole-fee rule:
   * a 1-chip purchase pays 0.10 and a 5-chip purchase pays 0.50. Reuse the
   * canonical buy-in splitter so this quote cannot round above the 10% cap or
   * drift from tournament creation and the database purchase authority.
   */
  private calcTournamentFee(
    tournament: { buy_in_amount?: number | null; buy_in_fee?: number | null },
    baseCost: number
  ): number {
    const rate = Math.min(DEFAULT_RAKE_RATE, Math.max(0, this.getTournamentFeeRatio(tournament)));
    return splitBuyIn(baseCost, rate).fee;
  }

  /**
   * PRICE QUOTE — what the player will actually be charged.
   *
   * 2026-08-20: RebuyModal and AddOnModal printed the BASE cost only, while
   * processRebuy/processAddOn charge base + the 10% house fee. A player with a
   * balance between the two saw an enabled Confirm button, pressed it, and got
   * "Insufficient chips" from the server. Both modals now quote through here so
   * the number on the button is the number that leaves the wallet.
   */
  async getChipPurchaseQuote(
    tournamentId: string,
    kind: 'rebuy' | 'addon'
  ): Promise<{ baseCost: number; fee: number; totalCost: number; chips: number } | null> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) return null;
    return this.quoteFromTournament(tournament, kind);
  }

  /** Same quote, when the caller already holds the tournament row. */
  quoteFromTournament(
    tournament: {
      buy_in_amount?: number | null;
      buy_in_fee?: number | null;
      starting_chips?: number | null;
      rebuy_cost?: number | null;
      rebuy_chips?: number | null;
      addon_cost?: number | null;
      addon_chips?: number | null;
    },
    kind: 'rebuy' | 'addon'
  ): { baseCost: number; fee: number; totalCost: number; chips: number } {
    // Mirrors processRebuy / processAddOn exactly. If these ever diverge the
    // player is quoted one price and charged another, so keep them together.
    // Whole chips only (Dan 2026-08-20). Legacy rows carry decimal costs, so
    // the round here is what keeps a 2026-era rebuy off a decimal price tag.
    const baseCost = Math.max(
      0,
      Math.round(
        Number(
          (kind === 'rebuy' ? tournament.rebuy_cost : tournament.addon_cost) ||
            tournament.buy_in_amount ||
            0
        )
      )
    );
    const chips = Number(
      (kind === 'rebuy' ? tournament.rebuy_chips : tournament.addon_chips) ||
        tournament.starting_chips ||
        0
    );
    // Dan 2026-08-21 (binding): the 10% is taken OUT of the advertised price,
    // for entries and rebuys alike. The player pays the number on the button;
    // the fee is a cut of it, never a surcharge on top of it. Add-ons stay
    // unraked per the 2026-08-20 ruling.
    const fee = kind === 'rebuy' ? this.calcTournamentFee(tournament, baseCost) : 0;
    return {
      baseCost: baseCost - fee,
      fee,
      totalCost: baseCost,
      chips,
    };
  }

  /**
   * Process a rebuy for a player.
   *
   * `clientToken` is the REQUIRED idempotency token for one rebuy prompt. It
   * must be generated when that prompt opens and reused by every retry from the
   * same prompt; a new bust must generate a new token.
   */
  async processRebuy(
    tournamentId: string,
    userId: string,
    clientToken: string
  ): Promise<{ success: true; newStack: number }> {
    if (typeof clientToken !== 'string' || !clientToken.trim()) {
      throw new Error('A rebuy prompt token is required');
    }
    const normalizedClientToken = clientToken.trim();
    if (normalizedClientToken.length > 128) {
      throw new Error('The rebuy prompt token is invalid');
    }

    const newStack = await withTournamentPurchaseIntent(
      { tournamentId, userId, kind: 'rebuy', token: normalizedClientToken },
      async () => {
        // Never put a mutable eligibility read in front of an idempotent money
        // retry. If the first RPC committed and its response was lost, canRebuy
        // now correctly says the player is funded; blocking here would prevent
        // the immutable receipt from returning that already-committed result.
        // The RPC owns replay and current eligibility under one transaction lock.
        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');

        const rebuyChips = tournament.rebuy_chips || tournament.starting_chips;
        // Whole chips only (Dan 2026-08-20) - no decimal rebuy prices.
        const rebuyCost = Math.max(
          0,
          Math.round(Number(tournament.rebuy_cost || tournament.buy_in_amount || 0))
        );
        // RAKE-AUDIT 2026-07-24: rebuys were fee-free — 100% of rebuy money went to
        // the prize pool and 0% to the house, breaking Dan's "10% on any and all
        // tournament/SNG buy-ins" rule. The atomic RPC now splits the advertised
        // price into fee, bounty head (when applicable), and prize contribution.
        // Dan 2026-08-21 (binding): the 10% comes OUT of the rebuy price, exactly
        // as it does out of an entry. The advertised price IS the total charged and
        // the remainder feeds the prize pool. Until this, a 20 rebuy charged 22
        // while a 20 entry charged 20 - two prices for one rule.
        const rebuyTotalCost = rebuyCost;

        // 2026-08-27: the frozen-pool pre-check that lived here is GONE. It read
        // public.wallets - frozen since 2026-08-21, nothing maintains it - so a
        // player with plenty of live chips could be refused before the atomic RPC
        // (the real authority, which checks the LIVE pool and produces its own
        // insufficient-funds error) ever ran. A "better error message" computed
        // from a dead table was a false refusal gate on a money action.
        // Process rebuy via ATOMIC RPC
        // (This RPC handles the wallet deduction and logging natively. It rolls back automatically on failure.)
        return {
          p_tournament_id: tournamentId,
          p_user_id: userId, // Round 19: prod sig uses p_user_id not p_player_id
          p_rebuy_type: tournament.is_reentry && !tournament.is_rebuy ? 'reentry' : 'rebuy',
          p_cost: rebuyTotalCost,
          p_chips: rebuyChips,
          p_current_level: this.getCurrentLevelState(tournament).levelIndex,
          // The helper persists this exact payload before I/O and the SQL
          // receipt keys the purchase on this prompt-owned token.
          p_client_token: normalizedClientToken,
        };
      },
      async (request) => {
        const { data, error } = await supabase.rpc('process_tournament_rebuy', request);
        if (error) {
          reportError(error, 'TournamentService.Rebuy_RPC_outcome_unconfirmed');
          throw error;
        }
        return confirmedTournamentPurchaseStack(data, request.p_rebuy_type);
      }
    );
    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_rebuy', userId });

    /* The browser-side "broadcast rebuy event" that used to sit here was
       removed in the final sweep of 2026-09-08: /channels/tournament/:id/event
       accepts only INTERNAL_API_KEY, the browser sent a player JWT, and every
       rebuy ended with a guaranteed 401 reported to Sentry. Nothing consumed
       the event. The engine's own tournament manager announces what a table
       needs to know. */

    return { success: true, newStack };
  }

  /**
   * Check if add-on is available
   */
  async canAddOn(tournamentId: string): Promise<{ allowed: boolean; reason?: string }> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) return { allowed: false, reason: 'Tournament not found' };

    if (!tournament.add_on_available) return { allowed: false, reason: 'Add-ons not available' };
    // Free Buy events open their durable add-on window as soon as the field is
    // pre-seated, up to one minute before the advertised first hand. The
    // server money door accepts that REGISTERING-with-live-seat phase; a
    // stricter browser pre-check made the visible offer impossible to buy.
    if (!['REGISTERING', 'RUNNING'].includes(String(tournament.status)))
      return { allowed: false, reason: 'Tournament is not accepting add-ons' };
    if (tournament.prize_pool_finalized)
      return { allowed: false, reason: 'The prize pool is finalized' };

    const startsAt = Date.parse(String(tournament.addon_period_started_at || ''));
    const endsAt = Date.parse(String(tournament.addon_period_ends_at || ''));
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || Date.now() < startsAt) {
      return { allowed: false, reason: 'Add-On Period Has Not Begun' };
    }
    if (Date.now() >= endsAt) return { allowed: false, reason: 'Add-On Period Has Ended' };

    return { allowed: true };
  }

  /**
   * Process an add-on for a player
   */
  async processAddOn(
    tournamentId: string,
    userId: string
  ): Promise<{ success: true; newStack: number }> {
    const newStack = await withTournamentPurchaseIntent(
      { tournamentId, userId, kind: 'addon' },
      async () => {
        // Do not put mutable availability or duplicate reads in front of this
        // idempotent money call. A retry after a committed/lost response must
        // reach the immutable receipt even though the window is now closed or
        // the add-on is now used. The RPC owns all eligibility under one lock;
        // canAddOn remains display guidance only.
        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');

        const addonChips = tournament.addon_chips || tournament.starting_chips;
        // Whole chips only (Dan 2026-08-20) - no decimal add-on prices.
        const addonCost = Math.max(
          0,
          Math.round(Number(tournament.addon_cost || tournament.buy_in_amount || 0))
        );
        // Dan 2026-08-20 (binding): "ADD ON'S AREN'T RAKED. ONLY REBUYS."
        // This reverses the 2026-07-24 change that put a 10% house fee on add-ons.
        // process_tournament_rebuy now charges an add-on at face value and books
        // no rake for it; the whole add-on goes to the prize pool.
        const addonTotalCost = addonCost;

        // 2026-08-27: the frozen-pool pre-check that lived here is GONE. It read
        // public.wallets - frozen since 2026-08-21, nothing maintains it - so a
        // player with plenty of live chips could be refused before the atomic RPC
        // (the real authority, which checks the LIVE pool and produces its own
        // insufficient-funds error) ever ran. A "better error message" computed
        // from a dead table was a false refusal gate on a money action.
        // Process addon via ATOMIC RPC
        // (This handles wallet deduction, logging, and rollback natively)
        return {
          p_tournament_id: tournamentId,
          p_user_id: userId, // Round 19: prod sig uses p_user_id not p_player_id
          p_rebuy_type: 'addon',
          p_cost: addonTotalCost,
          p_chips: addonChips,
          p_current_level: this.getCurrentLevelState(tournament).levelIndex,
          p_client_token: null,
        };
      },
      async (request) => {
        const { data, error } = await supabase.rpc('process_tournament_rebuy', request);
        if (error) {
          reportError(error, 'TournamentService.Addon_RPC_outcome_unconfirmed');
          throw error;
        }
        return confirmedTournamentPurchaseStack(data, 'addon');
      }
    );
    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_addon', userId });

    /* The browser-side add-on broadcast was removed with the rebuy one
       (final sweep 2026-09-08): an INTERNAL_API_KEY route called with a player
       JWT, a 401 on every add-on, no consumer. */

    return { success: true, newStack };
  }

  /* ── `processReentry` DELETED 2026-09-02 — a broken duplicate money path ──
     It had ZERO production callers. Re-entry flows through `processRebuy`,
     which sets `p_rebuy_type: 'reentry'` when a tournament is reentry-only,
     and that is the path 314 re-entry tournaments have actually been using.

     It could not have worked if anything had called it. Its eligibility check
     ordered `tournament_players` by `created_at`, a column that table does not
     have — its timestamps are `registered_at` and `eliminated_at` (verified
     against production). PostgREST answers 42703, the error was bound and
     surfaced, and every call would have ended at "Could not verify your
     entries. Please try again." 100% of the time.

     So: a second implementation of a money path, wrong in a way that made it
     unusable, with a unit test asserting its shape as though it worked. The
     test went with it. Deleted rather than repaired, because repairing it
     would restore a duplicate of a working path — and two ways to take a
     player's re-entry fee is how a player pays twice. */

  // ─────────────────────────────────────────────────────────────────────────────
  // Table Balancing
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Balance tables in a multi-table tournament
   */
  async balanceTables(tournamentId: string): Promise<{ movesMade: number }> {
    const { data, error } = await retryAsync(async () => {
      const result = await supabase.rpc('balance_tournament_tables', {
        p_tournament_id: tournamentId,
      });
      return result;
    }, 2);

    if (error) {
      reportError(error, 'TournamentService.Table_balancing_error');
      return { movesMade: 0 };
    }

    return { movesMade: data || 0 };
  }

  /**
   * Check if tables need balancing
   */
  async checkBalanceNeeded(tournamentId: string): Promise<boolean> {
    // Get all active tournament tables from the main tables table
    const { data: tables, error: tablesReadErr } = await supabase
      .from('tables')
      .select('id, current_players')
      .eq('tournament_id', tournamentId)
      .neq('status', 'closed');

    // ROUND 8 (2026-08-29): report a failed read instead of letting it wear
    // the same "balanced" answer as a healthy check. The false is unchanged -
    // skipping one balance tick is safe, doing it invisibly forever is not.
    if (tablesReadErr) {
      reportError(tablesReadErr, 'TournamentService.balance_check_read_failed', { tournamentId });
    }
    if (!tables || tables.length < 2) return false;

    const counts = tables.map((t) => t.current_players);
    const max = Math.max(...counts);
    const min = Math.min(...counts);

    // Balance needed if difference is more than 1
    return max - min > 1;
  }

  /**
   * Merge tables when player count drops
   */
  async checkTableMerge(tournamentId: string): Promise<{ tableMerged: boolean }> {
    const { data: tables, error: mergeReadErr } = await supabase
      .from('tables')
      .select('id, current_players')
      .eq('tournament_id', tournamentId)
      .neq('status', 'closed')
      .order('current_players', { ascending: true });

    // ROUND 8 (2026-08-29): same shape as checkBalanceNeeded above.
    if (mergeReadErr) {
      reportError(mergeReadErr, 'TournamentService.merge_check_read_failed', { tournamentId });
    }
    if (!tables || tables.length < 2) return { tableMerged: false };

    // Get total remaining players
    const totalPlayers = tables.reduce((sum, t) => sum + t.current_players, 0);
    const playersPerTable = 9;
    const neededTables = Math.ceil(totalPlayers / playersPerTable);

    if (tables.length > neededTables) {
      // Break the smallest table — close it
      const tableToBreak = tables[0];

      // Balance will move players to other tables
      await this.balanceTables(tournamentId);

      // Close the broken table
      const { error: closeErr } = await supabase
        .from('tables')
        .update({ status: 'closed' })
        .eq('id', tableToBreak.id);
      if (closeErr) reportError(closeErr, 'TournamentService.Failed_to_close_broken_table');

      return { tableMerged: true };
    }

    return { tableMerged: false };
  }

  /**
   * Create final table (consolidate to 1 table when 9 or fewer players remain)
   */
  async createFinalTable(tournamentId: string): Promise<{ finalTableId: string | null }> {
    const { count, error: playingCountErr } = await supabase
      .from('tournament_players')
      .select('*', { count: 'exact' })
      .eq('tournament_id', tournamentId)
      .eq('status', 'playing');

    // ROUND 10 (2026-08-29): a failed count wore the same "more than nine
    // still in" answer as a healthy big field. The null return is the safe
    // no-op either way (the next consolidation tick retries); the failure
    // now reports.
    if (playingCountErr) {
      reportError(playingCountErr, 'TournamentService.final_table_count_read_failed', {
        tournamentId,
      });
    }
    if (!count || count > 9) return { finalTableId: null };

    // Get or create final table (look for a table named "Final Table")
    // ROUND 8 (2026-08-29): the lookup error was discarded, so a FAILED read
    // was indistinguishable from "no final table yet" and fell straight into
    // the CREATE branch below - a transient timeout minted a duplicate Final
    // Table beside the real one. A failed lookup now stands down; the next
    // consolidation tick retries.
    const { data: lookedUp, error: finalLookupErr } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', tournamentId)
      .ilike('name', '%Final Table%')
      .neq('status', 'closed')
      .limit(1)
      .maybeSingle();
    if (finalLookupErr) {
      reportError(finalLookupErr, 'TournamentService.final_table_lookup_failed', { tournamentId });
      return { finalTableId: null };
    }
    let finalTable = lookedUp;

    if (!finalTable) {
      const tournament = await this.getTournament(tournamentId);
      if (!tournament) return { finalTableId: null };

      // Safe access: blind_structure may be null/empty/string for misconfigured tournaments
      const resolvedBlinds = parseBlindStructure(tournament.blind_structure);
      const blinds = resolvedBlinds[0];

      const { data: newTable, error: finalCreateErr } = await supabase
        .from('tables')
        .insert({
          club_id: tournament.club_id,
          tournament_id: tournamentId,
          name: `${tournament.name} - Final Table`,
          game_type: 'tournament',
          game_variant: 'nlh',
          stakes: 'Final Table',
          small_blind: blinds.smallBlind,
          big_blind: blinds.bigBlind,
          min_buy_in: 0,
          max_buy_in: 0,
          max_players: 9,
          status: 'RUNNING',
          settings: { auto_muck: true },
        })
        .select()
        .maybeSingle();

      // ROUND 8 (2026-08-29): a failed insert was silent; the caller saw
      // { finalTableId: null } with no trace of why.
      if (finalCreateErr) {
        reportError(finalCreateErr, 'TournamentService.final_table_create_failed', {
          tournamentId,
        });
      }
      if (newTable) {
        finalTable = { id: newTable.id };
      }
    }

    /* The browser-side final-table broadcast was removed (final sweep
       2026-09-08): an INTERNAL_API_KEY route called with a player JWT. */
    return { finalTableId: finalTable?.id || null };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tournament Lifecycle Events
  // ─────────────────────────────────────────────────────────────────────────────

  /* AUDIT 2026-08-22: `broadcastElimination` and `broadcastWinner` were
     removed from here. Neither had a caller, and neither ever could have been
     right: elimination and completion are decided by the ENGINE, which owns
     the tournament's state and broadcasts `player_eliminated` and
     `tournament_winner` itself (TournamentManagerEliminations). A client
     announcing either would be a client asserting a fact it does not own, and
     two publishers on one channel is how a table ends up acting on a result
     the database disagrees with.

     They are worth a note rather than a silent delete because their existence
     is what made the real gap so easy to miss: `broadcastWinner` sitting in
     the service read, to anyone grepping, as "the winner is announced
     somewhere". Nothing called it, and for months nothing announced the
     winner at all. */

  /**
   * Legacy client finalizer retained only as a fail-closed compatibility
   * surface. Tournament results and money are server-authoritative: the game
   * engine freezes the full place plan and completes it through
   * fn_settle_tournament_places_atomic. A browser may never write COMPLETED.
   */
  async finalizeTournament(tournamentId: string): Promise<{ success: boolean }> {
    reportError(
      new Error(
        `Refused legacy client finalization for ${tournamentId}: only the game server atomic place-settlement door may complete a tournament`
      ),
      'TournamentService.client_finalize_refused'
    );
    return { success: false };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SPIN & GO
  // ─────────────────────────────────────────────────────────────────────────────

  // `spinMultiplier()` — a Math.random() weighted roll against the legacy
  // table — is DELETED, not kept for compatibility. It had no callers (the
  // client TournamentEngine it served was removed in the server-authoritative
  // migration), and a client-side draw is wrong twice over: Math.random is
  // predictable, and no client may ever decide a real prize. The one draw
  // lives server-side, at start, behind the reserve gate.

  /* `createSpin` was DELETED 2026-08-27. Zero callers anywhere in src — the
     live paths that make Spins are the two creation forms (both send
     type: 'spin' through createTournament) and the server-side recycler.
     A convenience wrapper nobody calls on a money path is a hazard, not a
     convenience — the same reasoning as `collectBounty` and
     `rollMysteryBounty` below. */

  // ─────────────────────────────────────────────────────────────────────────────
  // BOUNTY TOURNAMENTS
  // ─────────────────────────────────────────────────────────────────────────────

  // AUDIT M19: `collectBounty` is deleted, not converted.
  //
  // It was a client-side reimplementation of bounty payouts that the ENGINE
  // already owns and owns correctly:
  // `server/src/tournament/TournamentManagerEliminations.ts` handles fixed, PKO
  // and mystery bounties, computing each from the tournament row and crediting
  // through `credit_player_wallet` with an idempotency key derived from the
  // payout itself.
  //
  // This version passed NO idempotency key - `credit_player_wallet`'s third
  // parameter defaults to NULL and the client only ever passed two arguments -
  // so it was not merely an unbacked credit. Had it ever been unblocked it would
  // have paid a SECOND bounty on top of the engine's, and the engine's key could
  // not have stopped it, because a call with no key never touches the dedupe
  // table. It would also have double-paid against its own retryAsync retries.
  //
  // It had no callers anywhere outside this file. Deleting it removes a
  // duplicate money path; it removes no function.

  /* DELETED 2026-08-25: `rollMysteryBounty`.
   *
   * It rolled a mystery bounty from `Math.random()` against a client-supplied
   * tier ladder, and it had ZERO callers anywhere in src/ — verified before
   * deletion. It is removed rather than left "just in case" for the same
   * reason `collectBounty` above was: a second, unused money path is a live
   * hazard, and this one decided an amount from the browser.
   *
   * What replaces it is not a client function at all. Mystery bounties are now
   * an INVENTORY: the whole mystery pool is divided into one chest per
   * surviving player when the phase opens, the order is shuffled with the
   * server's CSPRNG, and a knockout takes the next chest through
   * `fn_mystery_bounty_reserve`. The ladder that decides the tier sizes lives
   * in exactly one place, `server/src/config/mysteryBountySpec.ts`.
   *
   * To show a player what is still in the inventory, call
   * `fn_mystery_bounty_inventory(tournamentId)`; it returns the tiers, their
   * amounts, and how many of each are left, and it never reveals which chest
   * is next. */

  /**
   * Get total bounties won by a player in a tournament
   */
  async getPlayerBounties(tournamentId: string, playerId: string): Promise<number> {
    const { data, error } = await supabase
      .from('tournament_bounties')
      .select('bounty_amount')
      .eq('tournament_id', tournamentId)
      .eq('collector_player_id', playerId);

    // ROUND 8 (2026-08-29): the 0 stays (it is a display fallback), but a
    // failed read no longer wears it silently - the same confident-zero shape
    // as round 7's finding #9.
    if (error) {
      reportError(error, 'TournamentService.player_bounties_read_failed', { tournamentId });
      return 0;
    }
    return (data || []).reduce((sum, b) => sum + b.bounty_amount, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIXED-FIELD WAITLIST — MTTs and satellites register directly
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Join a fixed-field game's waitlist. MTTs have no entry-cap waitlist.
   */
  async joinTournamentWaitlist(
    tournamentId: string,
    userId: string
  ): Promise<{ position: number }> {
    const tournament = await this.getTournament(tournamentId, { throwOnError: true });
    if (!tournament) throw new Error('Tournament Not Found');
    if (isUnlimitedMtt(tournament)) {
      throw new Error('Register Directly For This Tournament');
    }
    // Check if already on waitlist
    const { data: existing, error: existingErr } = await supabase
      .from('tournament_waitlists')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

    // ROUND 8 (2026-08-29): a failed read waved the duplicate check through,
    // and a failed count below minted position 1 for whoever joined during
    // the outage - both silent. Both now stand down and ask for a retry.
    if (existingErr) {
      reportError(existingErr, 'TournamentService.waitlist_duplicate_check_read_failed', {
        tournamentId,
      });
      throw new Error('Could not check the waitlist. Please try again.');
    }
    if (existing) {
      throw new Error('You are already on the waitlist');
    }

    const { count, error: countErr } = await supabase
      .from('tournament_waitlists')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);
    if (countErr) {
      reportError(countErr, 'TournamentService.waitlist_count_read_failed', { tournamentId });
      throw new Error('Could not check the waitlist. Please try again.');
    }

    const position = (count || 0) + 1;

    const { error } = await supabase.from('tournament_waitlists').insert({
      tournament_id: tournamentId,
      user_id: userId,
      position,
    });

    if (error) throw error;

    masterBus.emit('WAITLIST_POSITION_CHANGED', {
      tableId: tournamentId,
      position,
      tableName: 'tournament',
    });

    return { position };
  }

  /**
   * Leave the waitlist for a tournament.
   */
  async leaveTournamentWaitlist(tournamentId: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('tournament_waitlists')
      .delete()
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId);

    if (error) throw error;

    masterBus.emit('WAITLIST_POSITION_CHANGED', {
      tableId: tournamentId,
      position: 0,
      tableName: 'tournament',
    });
  }

  /**
   * Get a player's position on the tournament waitlist, or null if not on it.
   */
  async getTournamentWaitlistPosition(
    tournamentId: string,
    userId: string
  ): Promise<{ position: number; total: number } | null> {
    const { data: entry, error: posErr } = await supabase
      .from('tournament_waitlists')
      .select('id, position')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

    // ROUND 8 (2026-08-29): display path - null (meaning "not on the
    // waitlist") stays the fallback, but a failed read is now recorded
    // instead of impersonating that answer.
    if (posErr) {
      reportError(posErr, 'TournamentService.waitlist_position_read_failed', { tournamentId });
    }
    if (!entry) return null;

    const { count, error: totalErr } = await supabase
      .from('tournament_waitlists')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);
    // ROUND 10 (2026-08-29): display path; the 0 total stays as the
    // fallback, the failure now reports instead of wearing it.
    if (totalErr) {
      reportError(totalErr, 'TournamentService.waitlist_total_read_failed', { tournamentId });
    }

    return { position: entry.position, total: count || 0 };
  }
}

export const tournamentService = new TournamentService();
