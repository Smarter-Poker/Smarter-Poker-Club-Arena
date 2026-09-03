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
import { supabase } from '../lib/supabase';
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
import { gameManagementService } from './GameManagementService';

// AUDIT M19: fn_unregister_from_tournament returns a `reason` for ordinary
// refusals rather than raising, so a player is told why - "you are already
// seated" and "the database is down" must not read as the same event.
const UNREGISTER_REASON_TEXT: Record<string, string> = {
  tournament_not_found: 'That tournament no longer exists',
  registration_closed:
    'Registration has closed for this tournament. Tournaments that have started cannot be refunded.',
  too_close_to_start: 'You cannot unregister within a minute of the start time',
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

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PayoutStructure {
  place: number;
  percentage: number;
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
  max_players_must_be_positive: 'Set a maximum number of players. Zero means nobody can register.',
  blind_structure_required: 'Choose a blind structure.',
  payout_structure_required: 'Choose a payout structure.',
  payouts_must_total_100: 'Payout percentages have to add up to 100%.',
  more_paid_places_than_players:
    'There are more paid places than players allowed to enter. Raise the field size or pay fewer places.',
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
  maxPlayers: number;
  minPlayers: number;
  blindStructure: BlindLevel[];
  payoutStructure: PayoutStructure[];
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
  /**
   * MYSTERY BOUNTY OPTIONS (Dan section 72). Applied by
   * `fn_apply_mystery_bounty_config` immediately after creation, not by
   * `fn_create_tournament` — see the note at the call site.
   */
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
        'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, addon_period_started_at, addon_period_ends_at, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at, short_description, is_vip_only, ban_chat, all_in_or_fold, label_as_new, hide_club_name, action_time_seconds, table_size, accelerated_mtt, addon_break_minutes, big_blind_ante, authorized_to_register, early_bird_enabled, early_bird_chips, bubble_protection, final_table_deal_enabled, restart_every_minutes, synchronized_breaks, on_break, break_started_at, break_ends_at, max_rebuys, max_reentries, is_pinned, satellite_seats'
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
              'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, addon_period_started_at, addon_period_ends_at, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at, short_description, is_vip_only, ban_chat, all_in_or_fold, label_as_new, hide_club_name, action_time_seconds, table_size, accelerated_mtt, addon_break_minutes, big_blind_ante, authorized_to_register, early_bird_enabled, early_bird_chips, bubble_protection, final_table_deal_enabled, restart_every_minutes, synchronized_breaks, on_break, break_started_at, break_ends_at, max_rebuys, max_reentries, is_pinned, satellite_seats'
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
  async getTournament(tournamentId: string): Promise<Tournament | null> {
    const { data, error } = await supabase
      .from('tournaments')
      .select(
        'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at, short_description, is_vip_only, ban_chat, all_in_or_fold, label_as_new, hide_club_name, action_time_seconds, table_size, accelerated_mtt, addon_break_minutes, big_blind_ante, authorized_to_register, early_bird_enabled, early_bird_chips, bubble_protection, final_table_deal_enabled, restart_every_minutes, synchronized_breaks, on_break, break_started_at, break_ends_at, max_rebuys, max_reentries, is_pinned, satellite_seats'
      )
      .eq('id', tournamentId)
      .maybeSingle();

    if (error) {
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
    const clampInt = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

    const p: Record<string, unknown> = {
      name: config.name,
      type: config.type,
      gameVariant: config.gameVariant || 'NLH',
      buyIn: config.buyIn,
      startingStack: config.startingStack,
      maxPlayers: config.maxPlayers,
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
    if (config.blindStructure && Array.isArray(config.blindStructure)) {
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
    } | null;
    if (!result?.success) {
      throw new Error(
        TOURNAMENT_CREATE_ERRORS[result?.error ?? ''] ?? 'Could not create tournament'
      );
    }

    // MYSTERY BOUNTY OPTIONS (Dan section 72). A second call rather than more
    // keys on `fn_create_tournament`, which is a 15KB SECURITY DEFINER
    // function this change has no other reason to touch — and rewriting one
    // from a dashboard dump to add six columns is how a creation path acquires
    // a silent regression.
    //
    // A failure here is deliberately NOT fatal. The tournament exists and is
    // valid; it simply runs on the defaults (classic ladder, chests open at
    // the money, pool split 50/50), which is what most clubs pick anyway. The
    // alternative — throwing — would leave a paid-for, correctly created event
    // behind an error message saying it failed.
    if (config.type === 'mystery_bounty' && result.tournament_id) {
      const mysteryConfig: Record<string, unknown> = {
        profile: config.mysteryBountyProfile ?? 'classic',
        activation: config.mysteryBountyActivation ?? 'at_the_money',
        activationValue: config.mysteryBountyActivationValue ?? null,
        topPercent: config.mysteryBountyTopPercent ?? 20,
        poolPercent: config.mysteryBountyPoolPercent ?? 50,
        regularPoolPercent: 100 - (config.mysteryBountyPoolPercent ?? 50),
      };
      const { data: cfgResult, error: cfgError } = await supabase.rpc(
        'fn_apply_mystery_bounty_config',
        { p_tournament_id: result.tournament_id, p_config: mysteryConfig }
      );
      const cfg = cfgResult as { ok?: boolean; reason?: string } | null;
      if (cfgError || !cfg?.ok) {
        console.warn(
          `[TournamentService] mystery bounty options not applied (${cfgError?.message ?? cfg?.reason ?? 'unknown'}); the event runs on the defaults`
        );
      }
    }

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
   * Register a player for a tournament
   */
  async registerPlayer(
    tournamentId: string,
    userId: string,
    username: string
  ): Promise<TournamentPlayer> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

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
    const { data: rpcResult, error: rpcError } = await retryAsync(
      () => supabase.rpc('fn_register_for_tournament', { p_tournament_id: tournamentId }),
      3
    );
    if (rpcError) {
      throw new Error(`Tournament registration failed: ${rpcError.message}`);
    }
    const res = rpcResult as {
      ok: boolean;
      reason?: string;
      registration_id?: string;
      cost?: number;
      mystery_bounty?: number | null;
    } | null;
    if (!res?.ok || !res.registration_id) {
      throw new Error(registerReasonText(res?.reason));
    }

    // Re-fetch the player row the server created (the RPC returns only ids)
    const { data, error } = await supabase
      .from('tournament_players')
      .select(
        'id, tournament_id, user_id, username, status, chips, table_id, position, prize, current_bounty, mystery_bounty_value, rebuys, registered_at, bounties_collected, bounty_winnings'
      )
      .eq('id', res.registration_id)
      .maybeSingle();
    if (error || !data) {
      reportError(error, 'TournamentService.Could_not_refetch_registered_player');
      throw new Error('Registration succeeded but player data could not be retrieved');
    }

    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_buyin', userId });
    masterBus.emit('TOURNAMENT_REGISTERED', { tournamentId, userId, clubId: tournament.club_id });
    masterBus.emit('TOURNAMENT_UPDATED', { tournamentId, status: tournament.status });

    // ── SNG/SPIN AUTO-START nudge (unchanged behavior): when full, pull
    // start_time to now so the server discovery loop starts it immediately.
    const { data: freshTournament, error: freshErr } = await supabase
      .from('tournaments')
      .select('current_players, max_players, variant')
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
   * read from the tournaments row). It also enforces the one-minute pre-start
   * lockout that the old code documented but could not implement - the comment
   * there admitted that nothing enforced it and players could yank their entry
   * at the exact start instant and race the seating flow - because the server
   * takes a row lock the seating flow cannot interleave with.
   *
   * The compensating re-INSERT is gone because it is no longer needed: a failed
   * refund rolls the delete back with it, so the player is simply still
   * registered.
   */
  async unregisterPlayer(tournamentId: string, userId: string): Promise<void> {
    const { data, error } = await supabase.rpc('fn_unregister_from_tournament', {
      p_tournament_id: tournamentId,
    });

    if (error) {
      reportError(error, 'TournamentService.unregisterPlayer', { tournamentId, userId });
      throw new Error('Could not unregister - please try again');
    }

    const res = data as { ok: boolean; reason?: string; refunded?: number } | null;

    if (!res?.ok) {
      throw new Error(unregisterReasonText(res?.reason));
    }

    if ((res.refunded ?? 0) > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'tournament_unregister_refund', userId });
    }
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
   * Start a tournament
   */
  async startTournament(tournamentId: string): Promise<Tournament> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    // Validate tournament has required configuration
    // NOTE: blind_structure and payout_structure may arrive as JSON strings from Supabase REST
    const parsedBlinds = parseBlindStructure(tournament.blind_structure);
    const parsedPayouts = parsePayoutStructure(tournament.payout_structure);
    if (!parsedBlinds.length) {
      throw new Error('Tournament has no blind structure defined');
    }
    if (!parsedPayouts.length) {
      throw new Error('Tournament has no payout structure defined');
    }
    if ((tournament.starting_chips || 0) <= 0) {
      throw new Error('Tournament starting chips must be > 0');
    }

    // 1. Get Players
    const { data: players, error: rosterErr } = await supabase
      .from('tournament_players')
      .select(
        'id, tournament_id, user_id, username, status, chips, table_id, position, prize, current_bounty, mystery_bounty_value, rebuys, registered_at'
      )
      .eq('tournament_id', tournamentId)
      .eq('status', 'registered');

    // ROUND 8 (2026-08-29): a FAILED roster read used to fall into 'No players
    // registered' - and worse, a failure that resolved to an empty array would
    // have sailed past this into the < 3 branch below, which CANCELS the
    // tournament and refunds everyone, on the strength of a timeout. A read
    // failure must never be allowed to impersonate an empty roster on a path
    // that destroys the tournament.
    if (rosterErr) {
      reportError(rosterErr, 'TournamentService.start_roster_read_failed', { tournamentId });
      throw new Error('Could not load the player list. Please try again.');
    }
    if (!players || players.length === 0) throw new Error('No players registered');

    // A short field waits for the server's sanctioned top-up/start path. The
    // browser never destroys a registered tournament to satisfy a start click.
    if (players.length < 3) {
      throw new Error(
        `Tournament Needs At Least 3 Players To Start. ${players.length} Currently Registered.`
      );
    }

    // TOURNEY-AUDIT 2026-07-24 [race guard]: CLAIM the start atomically BEFORE
    // creating any tables. The server's tournament discovery loop starts
    // tournaments too — without this compare-and-swap, an owner clicking
    // "Start" while the server loop fired created DOUBLE tables and DOUBLE
    // seating for the same tournament. Whoever loses the CAS backs off.
    {
      // Same defect shape as D7: `error` was dropped here, so a denied or
      // failed claim produced `claimed === null` and was reported to the owner
      // as "already starting" - a race that never happened. A real failure has
      // to read as a real failure, not as the benign branch next to it.
      const { data: claimed, error: claimError } = await supabase
        .from('tournaments')
        .update({ status: 'RUNNING', started_at: new Date().toISOString() })
        .eq('id', tournamentId)
        .in('status', ['ANNOUNCED', 'REGISTERING'])
        .select('id');
      if (claimError) {
        reportError(claimError, 'TournamentService.start_claim', { tournamentId });
        throw new Error(`Could not start tournament: ${claimError.message}`);
      }
      if (!claimed || claimed.length === 0) {
        throw new Error('Tournament is already starting (server or another admin claimed it)');
      }
    }

    // 2. Create Tables
    const playersPerTable = 9;
    const numTables = Math.ceil(players.length / playersPerTable);
    const createdTables: any[] = [];

    // PERF 2026-08-24: this was one INSERT per table, awaited in sequence. A
    // 300-entry MTT is 34 tables, so 34 serial round-trips - and that was only
    // the first of three such loops in this function (seats and the
    // current_players update below were the same shape), roughly 368
    // round-trips in total while every registered player stared at a spinner.
    // One bulk insert instead.
    const tablePayload = Array.from({ length: numTables }, (_, i) => ({
      club_id: tournament.club_id,
      tournament_id: tournament.id,
      name: `${tournament.name} - Table ${i + 1}`,
      game_type: 'tournament',
      game_variant: 'nlh',
      stakes: 'Tournament',
      small_blind: parsedBlinds[0].smallBlind,
      big_blind: parsedBlinds[0].bigBlind,
      min_buy_in: 0,
      max_buy_in: 0,
      max_players: 9,
      status: 'RUNNING',
      settings: { auto_muck: true },
    }));

    const { data: insertedTables, error: tablesErr } = await supabase
      .from('tables')
      .insert(tablePayload)
      .select();
    if (tablesErr) throw tablesErr;

    // Re-order the returned rows to match the payload EXACTLY. Seat assignment
    // below is `i % numTables`, so table order decides who sits where; relying
    // on the driver returning rows in insertion order would make seating depend
    // on an unguaranteed detail. Matching on the name we just generated is
    // deterministic. (A plain string sort would not be - "Table 10" sorts
    // before "Table 2".)
    const byName = new Map((insertedTables || []).map((t: any) => [t.name, t]));
    for (const payload of tablePayload) {
      const row = byName.get(payload.name);
      if (row) createdTables.push(row);
    }

    // 3. Seat Players — Fisher-Yates shuffle for unbiased randomization
    const shuffled = [...players];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const tableSeats = createdTables.map((t) => ({ tableId: t.id, nextSeat: 1 }));

    // PERF 2026-08-24: was one INSERT per player, awaited in sequence - 300
    // serial round-trips for a 300-entry MTT. The seat assignment arithmetic is
    // unchanged; only the write is batched.
    //
    // This is now atomic rather than best-effort. Previously a failed seat was
    // logged and the loop carried on, which produces a tournament that has
    // started with a player missing from the felt - a worse outcome than not
    // starting. Double-start is already prevented by the CAS claim at the top
    // of this function, so a conflict here means something is genuinely wrong
    // and should surface.
    const seatPayload = shuffled.map((player, i) => {
      const tableAssign = tableSeats[i % numTables];
      const seat = {
        table_id: tableAssign.tableId,
        seat_number: tableAssign.nextSeat,
        user_id: player.user_id,
        // TOURNEY-AUDIT 2026-07-24: seats were inserted with NO stack — the
        // engine reads table_seats.stack, so client-started tournaments seated
        // everyone with a null stack.
        stack: tournament.starting_chips,
      };
      tableAssign.nextSeat++;
      return seat;
    });

    if (seatPayload.length > 0) {
      const { error: seatErr } = await supabase.from('table_seats').insert(seatPayload);
      if (seatErr) {
        reportError(seatErr, 'TournamentService.Failed_to_seat_players');
        throw seatErr;
      }
    }

    // TOURNEY-AUDIT 2026-07-24: record each table's seated count — the seat
    // loop never bumped tables.current_players, so every tournament table
    // reported 0 players (breaking balance/merge checks and the Tables tab).
    // PERF 2026-08-24: was awaited one table at a time. Each update targets a
    // different row and carries a different value, so they are independent -
    // running them together costs the slowest one instead of the sum.
    // Same defect shape as D7: these updates resolve with `{ error }`, they do
    // not throw, so a denied seat-count write used to vanish and leave the
    // lobby showing an empty table that is actually full.
    const seatCountResults = await Promise.all(
      tableSeats.map((ts) =>
        supabase
          .from('tables')
          .update({ current_players: ts.nextSeat - 1 })
          .eq('id', ts.tableId)
      )
    );
    seatCountResults.forEach((r, i) => {
      if (r.error) {
        reportError(r.error, 'TournamentService.start_table_seat_count', {
          tournamentId,
          tableId: tableSeats[i].tableId,
        });
      }
    });

    // 4. Refresh tournament row (status/started_at were already CAS-claimed above)
    const { data, error } = await supabase
      .from('tournaments')
      .select()
      .eq('id', tournamentId)
      .maybeSingle();

    if (error) throw error;

    // 5. Update Player Stacks
    // Same defect shape as D7. This one is not survivable silently: if it is
    // denied, every player sits at 0 chips with status 'registered' and the
    // elimination sweep busts the whole field on its next pass. The caller
    // must not be told the tournament started.
    const { error: stackError } = await supabase
      .from('tournament_players')
      .update({
        chips: tournament.starting_chips,
        status: 'playing',
      })
      .eq('tournament_id', tournamentId)
      .eq('status', 'registered');
    if (stackError) {
      reportError(stackError, 'TournamentService.start_player_stacks', { tournamentId });
      throw stackError;
    }

    masterBus.emit('TOURNAMENT_STARTED', { tournamentId, clubId: tournament.club_id });

    return data;
  }

  // AUDIT M19: `eliminatePlayer` is deleted, not converted.
  //
  // Same story as collectBounty below. The engine owns finish-position payouts:
  // it computes each prize server-side from `tournaments.payout_structure` and
  // `prize_pool`, credits it via `credit_player_wallet` keyed
  // `tourney:{id}:prize:{user}:{position}`, retries three times, and logs the
  // transaction. This client copy computed the prize itself and passed no
  // idempotency key, so it was a latent double-payout on top of the engine
  // rather than an independent feature - and it had no callers outside this
  // file.
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
    return computePlacePrize(prizePool, structure, position);
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
        if (elapsedSec >= 0 && elapsedSec < durationSec * 4) {
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
    const levelState = this.getCurrentLevelState(tournament);
    const rebuyLevelCap = tournament.late_reg_levels ?? tournament.rebuy_levels ?? 8;
    const rebuyCloseLevel = tournament.add_on_available
      ? rebuyLevelCap + (tournament.addon_levels ?? 1)
      : rebuyLevelCap;
    if (rebuyLevelCap <= 0 || levelState.levelIndex >= rebuyCloseLevel) {
      return { allowed: false, reason: 'Rebuy/re-entry period has ended' };
    }

    // Check current stack (must be at or below starting stack)
    const { data: player, error: stackErr } = await supabase
      .from('tournament_players')
      .select('chips')
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
    if (player.chips > tournament.starting_chips) {
      return { allowed: false, reason: 'Stack too high for rebuy' };
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
   * Fee for a given base cost, as a WHOLE number of chips.
   *
   * Dan 2026-08-20: "Sit and Go and any tournament buy-ins must never be
   * decimal buy-ins, whole numbers only." That covers rebuys and re-entries,
   * so the fee they carry is rounded to a whole chip rather than to the cent.
   */
  private calcTournamentFee(
    tournament: { buy_in_amount?: number | null; buy_in_fee?: number | null },
    baseCost: number
  ): number {
    const base = Math.max(0, Math.round(Number(baseCost) || 0));
    if (base <= 0) return 0;
    // Floor of one chip so a small rebuy cannot slip through rake-free,
    // mirroring fn_create_tournament and process_tournament_rebuy exactly.
    return Math.min(base, Math.max(1, Math.round(base * this.getTournamentFeeRatio(tournament))));
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
   * RAKE-AUDIT 2026-07-24: Record a collected tournament/SNG fee in the rake
   * ledger (rake_records, attributed to the paying player) and the
   * tournament/union total_rake counters. Pass a NEGATIVE fee to record a
   * reversal (e.g. unregister refund) — the ledger stays append-only.
   */
  private async recordTournamentFee(
    tournament: { club_id?: string | null; union_id?: string | null },
    tournamentId: string,
    userId: string,
    fee: number,
    kind: string
  ): Promise<void> {
    if (!fee || fee === 0) return;
    const clubId = tournament.club_id || null;
    try {
      const { error: rrError } = await supabase.from('rake_records').insert({
        hand_id: null,
        table_id: tournamentId,
        club_id: clubId,
        rake_amount: fee,
        pot_size: Math.abs(fee),
        num_players: 1,
        bbj_contribution: 0,
        is_tournament: true,
        tournament_id: tournamentId,
        source: `TournamentService.${kind}`,
        player_contributions: { [userId]: fee },
        metadata: { kind, user_id: userId },
      });
      if (rrError) reportError(rrError, 'TournamentService.recordTournamentFee_rake_records');
    } catch (e: unknown) {
      reportError(e, 'TournamentService.recordTournamentFee_rake_records');
    }
    // Tournament total_rake counter (atomic RPC, read-modify-write fallback)
    try {
      const { error: incErr } = await supabase.rpc('increment_tournament_rake', {
        p_tournament_id: tournamentId,
        p_amount: fee,
      });
      if (incErr) {
        const { data: tData, error: tReadErr } = await supabase
          .from('tournaments')
          .select('total_rake')
          .eq('id', tournamentId)
          .maybeSingle();
        // ROUND 8 (2026-08-29): both the RPC and the fallback read failing
        // used to leave no trace at all - the club's rake total silently
        // under-reported with nothing anywhere saying so.
        if (tReadErr) {
          reportError(tReadErr, 'TournamentService.recordTournamentFee_fallback_read_failed', {
            tournamentId,
          });
        }
        if (tData) {
          // Same defect shape as D7: the catch below cannot see a PostgREST
          // `{ error }`, so a failed rake counter fallback was invisible and
          // the club's rake total silently under-reported.
          const { error: rakeUpdErr } = await supabase
            .from('tournaments')
            .update({ total_rake: (tData.total_rake || 0) + fee })
            .eq('id', tournamentId);
          if (rakeUpdErr) {
            reportError(rakeUpdErr, 'TournamentService.recordTournamentFee_total_rake', {
              tournamentId,
            });
          }
        }
      }
    } catch (e: unknown) {
      reportError(e, 'TournamentService.recordTournamentFee_total_rake');
    }
    // Union-level counter
    const unionId = tournament.union_id || undefined;
    if (unionId) {
      try {
        const { data: unionData, error: unionReadErr } = await supabase
          .from('unions')
          .select('total_rake')
          .eq('id', unionId)
          .maybeSingle();
        // ROUND 8 (2026-08-29): same silent under-report shape as the
        // tournament counter above, on the union ledger.
        if (unionReadErr) {
          reportError(unionReadErr, 'TournamentService.recordTournamentFee_union_read_failed', {
            tournamentId,
            unionId,
          });
        }
        if (unionData) {
          // Same defect shape as D7, on the union ledger this time.
          const { error: unionUpdErr } = await supabase
            .from('unions')
            .update({ total_rake: (unionData.total_rake || 0) + fee })
            .eq('id', unionId);
          if (unionUpdErr) {
            reportError(unionUpdErr, 'TournamentService.recordTournamentFee_union_total_rake', {
              tournamentId,
              unionId,
            });
          }
        }
      } catch (e: unknown) {
        reportError(e, 'TournamentService.recordTournamentFee_union_total_rake');
      }
    }
  }

  /**
   * Process a rebuy for a player.
   *
   * `clientToken` is the IDEMPOTENCY TOKEN for one rebuy PROMPT (2026-08-27).
   * It must be generated when the prompt OPENS and reused by every click of
   * that same prompt; a new bust must generate a new one. See the note beside
   * `p_client_token` in the RPC call below for what the server does without it.
   */
  async processRebuy(
    tournamentId: string,
    userId: string,
    clientToken?: string
  ): Promise<{ success: boolean; newStack?: number }> {
    const canRebuyResult = await this.canRebuy(tournamentId, userId);
    if (!canRebuyResult.allowed) {
      throw new Error(canRebuyResult.reason || 'Rebuy not allowed');
    }

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
    // tournament/SNG buy-ins" rule. Fee is now charged on top of the rebuy cost
    // (base cost still feeds the prize pool; recalculatePrizePool strips the fee).
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
    const { data, error } = await supabase.rpc('process_tournament_rebuy', {
      p_tournament_id: tournamentId,
      p_user_id: userId, // Round 19: prod sig uses p_user_id not p_player_id
      p_rebuy_type: tournament.is_reentry && !tournament.is_rebuy ? 'reentry' : 'rebuy',
      p_cost: rebuyTotalCost,
      p_chips: rebuyChips,
      p_current_level: this.getCurrentLevelState(tournament).levelIndex,
      /**
       * IDEMPOTENCY, EXACTLY (2026-08-27).
       *
       * With a token the server keys the purchase on it, so every click of ONE
       * prompt collapses to one charge and a SECOND, genuine bust in the same
       * tournament is a different purchase.
       *
       * Without one it falls back to a rebuy-ordinal key plus a 1.5s
       * double-submit collapse — and before that fallback existed, ANY second
       * rebuy inside 30 seconds was swallowed and reported as success. In a
       * turbo that meant a player who really did bust twice was charged
       * nothing, granted nothing, shown "Rebuy Successful", and left sitting at
       * 0 chips.
       *
       * The token is minted per PROMPT, never per click — see the callers in
       * TablePage (`beginRebuyPrompt` / `endRebuyPrompt`).
       */
      p_client_token: clientToken ?? null,
    });

    if (error) {
      reportError(error, 'TournamentService.Rebuy_RPC_failed_No_chips_were_deducted');
      throw error;
    }

    // 2026-08-20: the fee is booked by process_tournament_rebuy inside the
    // same transaction as the chip deduction. This used to ALSO insert a
    // rake_records row and increment total_rake here, so every fee was
    // counted twice in union rake revenue and in rakeback.

    // Emit AFTER confirmed success — never optimistically before RPC
    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_rebuy', userId });

    // Recalculate prize pool: rebuy cost goes to pool
    await this.recalculatePrizePool(tournamentId);

    // Broadcast rebuy event
    try {
      const { realtimeChannelService } = await import('./RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
        type: 'player_registered', // Using existing event type
        payload: { type: 'rebuy', userId, chips: rebuyChips },
      });
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Failed_to_broadcast_rebuy_event');
    }

    return { success: true, newStack: data?.new_stack || rebuyChips };
  }

  /**
   * Check if add-on is available
   */
  async canAddOn(tournamentId: string): Promise<{ allowed: boolean; reason?: string }> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) return { allowed: false, reason: 'Tournament not found' };

    if (!tournament.add_on_available) return { allowed: false, reason: 'Add-ons not available' };

    const startsAt = Date.parse(String((tournament as any).addon_period_started_at || ''));
    const endsAt = Date.parse(String((tournament as any).addon_period_ends_at || ''));
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
  ): Promise<{ success: boolean; newStack?: number }> {
    const canAddOnResult = await this.canAddOn(tournamentId);
    if (!canAddOnResult.allowed) {
      throw new Error(canAddOnResult.reason || 'Add-on not allowed');
    }

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

    // Check if player already used their add-on (each player gets max 1 add-on)
    const { data: existingAddon, error: addonCheckErr } = await supabase
      .from('wallet_transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('category', 'addon')
      .eq('related_entity_id', tournamentId)
      .limit(1);
    // ROUND 8 (2026-08-29): a failed read used to pass the duplicate gate on a
    // MONEY action - the one-add-on-per-player rule waved through anyone whose
    // check query timed out. Fails closed and retryable instead.
    if (addonCheckErr) {
      reportError(addonCheckErr, 'TournamentService.addon_duplicate_check_read_failed', {
        tournamentId,
      });
      throw new Error('Could not verify your add-on status. Please try again.');
    }
    if (existingAddon && existingAddon.length > 0) {
      throw new Error('You have already used your add-on for this tournament');
    }

    // 2026-08-27: the frozen-pool pre-check that lived here is GONE. It read
    // public.wallets - frozen since 2026-08-21, nothing maintains it - so a
    // player with plenty of live chips could be refused before the atomic RPC
    // (the real authority, which checks the LIVE pool and produces its own
    // insufficient-funds error) ever ran. A "better error message" computed
    // from a dead table was a false refusal gate on a money action.
    // Process addon via ATOMIC RPC
    // (This handles wallet deduction, logging, and rollback natively)
    const { data, error } = await supabase.rpc('process_tournament_rebuy', {
      p_tournament_id: tournamentId,
      p_user_id: userId, // Round 19: prod sig uses p_user_id not p_player_id
      p_rebuy_type: 'addon',
      p_cost: addonTotalCost,
      p_chips: addonChips,
      p_current_level: this.getCurrentLevelState(tournament).levelIndex,
    });

    if (error) {
      reportError(error, 'TournamentService.Addon_process_failed_No_chips_were_deduc');
      throw error;
    }

    // 2026-08-20: the fee is booked by process_tournament_rebuy inside the
    // same transaction as the chip deduction. This used to ALSO insert a
    // rake_records row and increment total_rake here, so every fee was
    // counted twice in union rake revenue and in rakeback.

    // Emit AFTER confirmed success — never optimistically before RPC
    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_addon', userId });

    // Recalculate prize pool: add-on cost goes to pool
    await this.recalculatePrizePool(tournamentId);

    // Broadcast add-on event
    try {
      const { realtimeChannelService } = await import('./RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
        type: 'player_registered',
        payload: { type: 'addon', userId, chips: addonChips },
      });
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Failed_to_broadcast_addon_event');
    }

    return { success: true, newStack: data?.new_stack };
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
  // Prize Pool Recalculation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Recalculate prize pool based on current entries + rebuys + add-ons.
   * Prize pool = (entries * buy_in) + (rebuys * rebuy_cost) + (addons * addon_cost)
   * If guaranteed prize > calculated pool, use guaranteed amount.
   * Called on: every registration, every rebuy, every add-on.
   */
  async recalculatePrizePool(tournamentId: string): Promise<number> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) return 0;

    const buyIn = tournament.buy_in_amount || 0;
    const guarantee = tournament.guaranteed_prize || 0;

    // HORSES ARE PLAYERS (Dan, binding). This block used to subtract every
    // horse from the entry count, on the stated premise that "horses register
    // free (buy_in 0) and must not inflate the prize pool". That premise is
    // false, and it is false by a factor of five thousand: over the seven days
    // to 2026-08-28 humans paid 18 tournament buy-ins worth 702 chips and
    // horses paid 104,317 worth 2,313,221. Horses fund 99.97% of tournament
    // prize money on this platform.
    //
    // fn_register_horse_for_tournament charges the horse through
    // atomic_deduct_wallet_and_log and adds v_split.prize to prize_pool, on
    // exactly the same terms as fn_register_for_tournament — its own comment
    // says "a horse and a human must enter the same event on the same terms".
    // So the pool the database builds is right, and this function recomputed
    // it from scratch with every horse deleted and OVERWROTE it. It runs after
    // every rebuy, add-on and re-entry, so one human re-entering a fifty-horse
    // event rewrote that event's pool to a single entry's worth.
    //
    // Deleting the filter is the fix. An entry is an entry.
    //
    // THE READS ARE CHECKED NOW. `{ data }` was destructured without
    // `{ error }`, and supabase-js does not throw on a PostgREST error — it
    // returns `data: null`, so the try/catch below could never see one. A
    // failed read therefore meant entryCount 0, and this function wrote that
    // straight over a real prize pool. An unreadable count is UNKNOWN, never
    // zero: on any read failure it now refuses to write at all and reports,
    // leaving the pool the database already computed.
    let entryCount = 0;
    const { data: entryRows, error: entryErr } = await supabase
      .from('tournament_players')
      .select('user_id')
      .eq('tournament_id', tournamentId);
    if (entryErr) {
      reportError(entryErr, 'TournamentService.recalculatePrizePool.entry_read_failed', {
        tournamentId,
      });
      return tournament.prize_pool || 0;
    }
    entryCount = entryRows?.length ?? 0;

    // Count rebuys and add-ons from wallet_transactions (always available).
    // Only the BASE cost feeds the prize pool.
    //
    // A rebuy/re-entry debit is base + fee, so the fee is divided back out.
    // An ADD-ON debit is the base cost already: Dan's rule (2026-08-20) is
    // "ADD ON'S AREN'T RAKED. ONLY REBUYS.", so process_tournament_rebuy
    // charges add-ons at face value. Dividing an add-on by (1 + feeRatio)
    // here would silently shave ~9% off the prize pool for every add-on
    // taken. (No historical add-on rows exist to be re-interpreted: the
    // 'addon' category has never been written.)
    let rebuyTotal = 0;
    let addonTotal = 0;
    // How many rebuys/re-entries were bought, so a bounty event can take its
    // head value out of each one the way registration does.
    let rebuyEntryCount = 0;
    try {
      const { data: rebuyTxns, error: rebuyErr } = await supabase
        .from('wallet_transactions')
        .select('amount, category')
        .eq('related_entity_id', tournamentId)
        .in('category', ['rebuy', 'addon']);
      // Same rule as the entry read: a rebuy ledger we could not read is not
      // "no rebuys". Writing a pool that excludes chips players were already
      // charged is the failure this guard exists to prevent.
      if (rebuyErr) {
        reportError(rebuyErr, 'TournamentService.recalculatePrizePool.rebuy_read_failed', {
          tournamentId,
        });
        return tournament.prize_pool || 0;
      }

      if (rebuyTxns) {
        for (const tx of rebuyTxns) {
          const gross = Math.abs(tx.amount || 0);
          if (tx.category === 'addon') {
            addonTotal += Math.round(gross);
          } else {
            rebuyTotal += Math.round(gross);
            rebuyEntryCount += 1;
          }
        }
      }

      // THE FEE IS SUBTRACTED FROM THE LEDGER, NOT INFERRED FROM A RATIO.
      //
      // This used to divide each rebuy debit by (1 + feeRatio) to strip the fee
      // back out. That only ever fitted the fee-ON-TOP era, and it was not exact
      // even then, because the fee is a WHOLE chip: a 100 rebuy was debited 110
      // and 110 / 1.1 gives 100, but the fee actually booked was 11, so the
      // prize share was 99. Since Dan's 2026-08-21 rule the fee is cut OUT of
      // the price, so a ratio-based guess is wrong in a second, different way -
      // and both eras sit side by side in one tournament's history.
      //
      // rake_records holds the fee that was ACTUALLY booked, per purchase, in
      // the same transaction that charged it. Subtracting it is exact for both
      // eras and needs no knowledge of which rule was in force.
      const { data: feeRows, error: feeErr } = await supabase
        .from('rake_records')
        .select('rake_amount, metadata')
        .eq('tournament_id', tournamentId)
        .eq('source', 'process_tournament_rebuy');
      if (feeErr) {
        reportError(feeErr, 'TournamentService.recalculatePrizePool.fee_read_failed', {
          tournamentId,
        });
        return tournament.prize_pool || 0;
      }
      if (feeRows) {
        for (const row of feeRows) {
          const kind = String((row as { metadata?: { kind?: string } })?.metadata?.kind || '');
          // Add-ons are unraked so they never appear here; guard anyway so a
          // future ruling change cannot double-subtract.
          if (kind.includes('addon')) continue;
          rebuyTotal -= Math.round(Number(row.rake_amount) || 0);
        }
      }
      rebuyTotal = Math.max(0, rebuyTotal);
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Could_not_query_rebuyaddon_transactions');
    }

    // Calculate total prize pool.
    // Math.round, not Math.trunc: 482.99999999999 truncates to 482 and quietly
    // loses a chip that players actually paid in. Same reasoning as the Round
    // 40 trunc->round fixes on the payout side. Whole chips (Dan 2026-08-20):
    // every contributing term is whole, and legacy decimal buy_in_amount rows
    // are rounded rather than carried into a decimal pool.
    // BOUNTY MONEY IS NOT PRIZE MONEY (Dan 2026-08-21).
    //
    // "20 buy-in, 10 bounty: 10 to the bounty pool, 8 to the prize pool, 2 for
    // rake." buy_in_amount holds the post-rake half of that price (18 of the
    // 20), so counting it whole credited the prize pool with the 10 already
    // sitting on players' heads - the same chips promised twice, once as prize
    // money and once as a bounty. fn_tournament_entry_split has always charged
    // and split it correctly at registration; only this recalculation
    // double-counted it.
    const isBountyEvent = !!(
      tournament.is_bounty ||
      tournament.is_pko ||
      tournament.is_mystery_bounty
    );
    const bountyPerEntry = isBountyEvent
      ? Math.max(0, Math.round(Number(tournament.bounty_amount) || 0))
      : 0;
    const prizePerEntry = Math.max(0, buyIn - bountyPerEntry);
    // A rebuy buys a head too, so its bounty share leaves the prize pool as
    // well. rebuyTotal is already net of rake by this point.
    const rebuyPrize = Math.max(0, rebuyTotal - bountyPerEntry * rebuyEntryCount);
    const calculatedPool = Math.round((entryCount || 0) * prizePerEntry + rebuyPrize + addonTotal);
    const finalPool = guarantee > 0 ? Math.max(calculatedPool, guarantee) : calculatedPool;

    // Update tournament
    // Same defect shape as D7, and money-facing: an unchecked write here let
    // the function RETURN a prize pool that was never persisted, so the caller
    // reported a number the lobby would never show.
    //
    // Reported, deliberately NOT thrown. Every caller reaches this line AFTER
    // the buy-in, rebuy or add-on has already been charged server-side, so
    // throwing would turn a transaction that really happened into a reported
    // failure - the same class of lie in the opposite direction. The error is
    // now visible instead of discarded, which is the fix that was missing.
    const { error: poolError } = await supabase
      .from('tournaments')
      .update({
        prize_pool: finalPool,
      })
      .eq('id', tournamentId);
    if (poolError) {
      reportError(poolError, 'TournamentService.recalculatePrizePool', { tournamentId });
    }

    console.debug(
      `[TournamentService] Prize pool recalculated for ${tournamentId.slice(0, 8)}: ${finalPool} (${entryCount} entries, ${rebuyTotal} rebuys, ${addonTotal} addons, ${guarantee} GTD)`
    );

    return finalPool;
  }

  /**
   * Finalize the prize pool — called when late registration and/or add-on period closes.
   * After finalization, the prize pool is locked and no longer changes.
   */
  async finalizePrizePool(tournamentId: string): Promise<number> {
    const finalPool = await this.recalculatePrizePool(tournamentId);

    // Mark pool as finalized (prize_pool_finalized column may not exist yet — graceful fallback)
    const { error: finalizeErr } = await supabase
      .from('tournaments')
      .update({
        prize_pool: finalPool,
        prize_pool_finalized: true,
      } as any)
      .eq('id', tournamentId);

    if (finalizeErr) {
      // Fallback: just update prize_pool without the finalized flag
      const { error: fallbackErr } = await supabase
        .from('tournaments')
        .update({ prize_pool: finalPool })
        .eq('id', tournamentId);
      if (fallbackErr)
        reportError(fallbackErr, 'TournamentService.finalizePrizePool_fallback_failed');
    }

    console.debug(
      `[TournamentService] Prize pool FINALIZED for ${tournamentId.slice(0, 8)}: ${finalPool}`
    );

    // Broadcast finalization event
    try {
      const { realtimeChannelService } = await import('./RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
        type: 'prize_pool_finalized',
        payload: { prizePool: finalPool },
      });
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Failed_to_broadcast_prize_pool_finalizat');
    }

    return finalPool;
  }

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

    if (finalTable) {
      // Broadcast final table event
      try {
        const { realtimeChannelService } = await import('./RealtimeChannelService');
        await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
          type: 'final_table',
          payload: { tableId: finalTable.id, playerCount: count },
        });
      } catch (e: unknown) {
        reportError(e, 'TournamentService.Failed_to_broadcast_final_table_event');
      }
    }

    return { finalTableId: finalTable?.id || null };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tournament Lifecycle Events
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Broadcast level up event
   */
  async broadcastLevelUp(tournamentId: string, newLevel: BlindLevel): Promise<void> {
    try {
      const { realtimeChannelService } = await import('./RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
        type: 'level_up',
        payload: {
          level: newLevel.level,
          smallBlind: newLevel.smallBlind,
          bigBlind: newLevel.bigBlind,
          ante: newLevel.ante,
        },
      });
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Failed_to_broadcast_level_up');
    }
  }

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
   * Finalize tournament (process payouts)
   */
  async finalizeTournament(tournamentId: string): Promise<{ success: boolean }> {
    // Get tournament details
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) {
      return { success: false };
    }

    // Update tournament status
    const { error: statusError } = await supabase
      .from('tournaments')
      .update({
        status: 'COMPLETED',
        ended_at: new Date().toISOString(),
      })
      .eq('id', tournamentId);

    if (statusError) {
      reportError(statusError, 'TournamentService.Failed_to_mark_tournament_COMPLETED');
      return { success: false };
    }

    // RAKE-AUDIT 2026-07-24: distribute_tournament_prizes call REMOVED.
    // (a) The RPC does not exist in the live database — this call errored on
    //     every finalize and the error was swallowed.
    // (b) Prizes are SERVER-AUTHORITATIVE: the game server credits each
    //     player's prize at elimination and the winner's prize when the
    //     tournament completes (GameServer.eliminatePlayer / finish path).
    //     If the RPC were ever created, this call would DOUBLE-PAY every
    //     placement — so it must stay removed, not fixed.
    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_prizes', tournamentId });

    // Submit all placements to POY leaderboard system
    try {
      const { data: players, error: poyReadErr } = await supabase
        .from('tournament_players')
        .select('user_id, position, prize')
        .eq('tournament_id', tournamentId)
        .not('position', 'is', null)
        .order('position', { ascending: true });

      // ROUND 8 (2026-08-29): a failed read silently submitted nothing to the
      // POY leaderboard - every placement in the event vanished from the race
      // with no trace. Reported; the catch below only sees thrown errors.
      if (poyReadErr) {
        reportError(poyReadErr, 'TournamentService.poy_placements_read_failed', { tournamentId });
      }
      if (players && players.length > 0) {
        // Dynamically import to avoid circular deps
        const { POYService } = await import('./POYService');

        // Map tournament variant to game_type for POY
        const gameType =
          tournament.variant === 'spin'
            ? 'spin-n-go'
            : tournament.variant === 'sng'
              ? 'sit-n-go'
              : tournament.variant === 'satellite'
                ? 'satellite'
                : 'tournament';

        // Submit each player's result
        for (const player of players) {
          await POYService.submitTournamentResult({
            player_id: player.user_id,
            club_id: tournament.club_id,
            game_type: gameType,
            game_id: tournamentId,
            placement: player.position,
            total_players: tournament.current_players || players.length,
            buy_in: tournament.buy_in_amount || 0,
            winnings: player.prize || 0,
          });
        }
      }
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Failed_to_submit_to_POY');
    }

    masterBus.emit('TOURNAMENT_COMPLETE', { tournamentId, clubId: tournament.club_id });

    return { success: true };
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
  // TOURNAMENT WAITLIST — For full-capacity tournaments with late registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Join the waitlist for a tournament that is at capacity.
   */
  async joinTournamentWaitlist(
    tournamentId: string,
    userId: string
  ): Promise<{ position: number }> {
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
