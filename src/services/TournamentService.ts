/**
 * ♠ CLUB ARENA — Tournament Service
 * SNGs and MTTs with blind levels and payout structures
 */

export type { BlindLevel } from '../config/blindStructures';
export { BLIND_STRUCTURES, SPIN_BLIND_STRUCTURE, PAYOUT_STRUCTURES } from '../config/blindStructures';
import { BLIND_STRUCTURES, SPIN_BLIND_STRUCTURE, type BlindLevel } from '../config/blindStructures';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { fetchGameCreationAccess } from './GameAccessService';
import { parseBlindStructure, parsePayoutStructure } from '../utils/parseBlindStructure';
import type { Tournament, TournamentPlayer } from '../types/database.types';
import { reportError } from '../utils/errorReporter';

// AUDIT M19: fn_unregister_from_tournament returns a `reason` for ordinary
// refusals rather than raising, so a player is told why - "you are already
// seated" and "the database is down" must not read as the same event.
const UNREGISTER_REASON_TEXT: Record<string, string> = {
  tournament_not_found: 'That tournament no longer exists',
  registration_closed: 'Registration has closed for this tournament',
  too_close_to_start: 'You cannot unregister within a minute of the start time',
  not_registered_or_seated: 'You are not registered, or you have already been seated at a table',
};

const REGISTER_REASON_TEXT: Record<string, string> = {
  tournament_not_found: 'Tournament not found',
  registration_closed: 'Registration is closed',
  tournament_full: 'Tournament is full',
  already_registered: 'Already registered for this tournament',
  insufficient_balance: 'Insufficient chips in Player Wallet.',
};

function registerReasonText(reason: string | undefined): string {
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
 * - sng: Sit & Go (starts when full)
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
  mysteryTiers?: MysteryBountyTier[]; // For mystery bounties
  progressiveStartLevel?: number; // When progressive bounties start
}

export interface MysteryBountyTier {
  minMultiplier: number;
  maxMultiplier: number;
  probability: number; // Percentage chance
}

export interface SpinConfig {
  possibleMultipliers: SpinMultiplier[];
}

export interface SpinMultiplier {
  multiplier: number; // e.g., 2, 3, 5, 10, 25, 120, 10000
  probability: number; // Percentage chance
  isPremium?: boolean; // Special handling for huge multipliers
}

/**
 * fn_create_tournament returns a machine-readable reason; turn it into
 * something a club owner can act on. Anything unmapped falls back to a generic
 * message rather than leaking the raw code.
 */
const TOURNAMENT_CREATE_ERRORS: Record<string, string> = {
  not_authenticated: 'You need to be signed in to create a tournament.',
  not_authorised:
    'Only the owner or an admin can create tournaments here. A club inside a union does not create its own — the union creates them.',
  buy_in_must_not_be_negative: 'Buy-in cannot be negative.',
  max_players_must_be_positive:
    'Set a maximum number of players. Zero means nobody can register.',
  blind_structure_required: 'Choose a blind structure.',
  payout_structure_required: 'Choose a payout structure.',
  payouts_must_total_100: 'Payout percentages have to add up to 100%.',
  more_paid_places_than_players:
    'There are more paid places than players allowed to enter. Raise the field size or pay fewer places.',
  bounty_amount_required: 'A bounty tournament needs a bounty amount.',
  bounty_exceeds_buy_in:
    'The bounty plus the 10% fee is more than the buy-in, so there would be nothing left for the prize pool.',
};

export interface TournamentConfig {
  name: string;
  type: TournamentType;
  buyIn: number;
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

  // Game Variant (poker game type)
  gameVariant?: 'NLH' | 'PLO4' | 'PLO5' | 'PLO8' | 'SHORT_DECK';

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
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDARD STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════





// ═══════════════════════════════════════════════════════════════════════════════
// SPIN CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ── PROFITABLE Spin Economics (Pool-Based) ──────────────────────────────────
//
// MODEL:
//   3 players each pay (buy_in + 10% fee).
//   Total collected   = 3 × buy_in  +  3 × fee   (fee = 10% of buy_in)
//   Club guaranteed   = 3 × fee                   (always kept — 10% rake)
//   Prize pool fund   = 3 × buy_in
//
//   DEFAULT PAYOUT (most spins — 67% of the pot goes to winner):
//     Winner receives  = 2 × buy_in
//     Pool deposit     = 1 × buy_in   (saved into spin_bonus_pool)
//
//   BONUS PAYOUT (random trigger — drawn from the pool):
//     Winner receives  = 2 × buy_in + bonus_amount
//     bonus_amount     ≤ current pool balance  (NEVER goes negative)
//
//   This guarantees clubs/unions ALWAYS profit from the 10% fee, while
//   the 1× buy_in saved per default spin funds exciting jackpot-style
//   bonus payouts when the pool has enough balance.
//
// MULTIPLIER DISPLAY:
//   The "multiplier" shown to players is purely cosmetic (the wheel spin).
//   The actual payout is determined by the pool-backed algorithm below.
//
// ─────────────────────────────────────────────────────────────────────────────

export const SPIN_RAKE_PERCENT = 0.1; // 10% fee on buy-in

// Pool contribution per spin: 1 buy-in saved from the 3 collected.
// EVERY spin deposits 1× buy_in to pool, then bonus draws happen.
// This ensures the pool is self-sustaining and club net = exactly 10%.
export const SPIN_POOL_CONTRIBUTION_MULTIPLIER = 1; // × buy_in per spin (always)

// Maximum negative pool balance a club/union can carry (in chips).
// When pool is negative, future 2× spin deposits pay it back.
export const SPIN_POOL_MAX_NEGATIVE = -500;

// Bonus trigger tiers — probability-weighted random check at game start.
// Probabilities are balanced so expected pool draw = expected pool deposit (1× buy_in).
// This guarantees the club/union net return = exactly 10% over time.
//
// Economics per spin (e.g. $1 buy-in):
//   3 players pay $1.10 each ($1 buy-in + $0.10 fee)
//   House keeps $0.30 (10% rake) — this is the ONLY house revenue
//   Prize pool = $3.00 (all 3 buy-ins)
//   Base payout = $2.00 (2× buy_in to winner)
//   Pool deposit = $1.00 per spin (always)
//   Pool draw = bonusBuyIns × buy_in (for bonus tiers)
//   Expected payout = $3.00 (pool nets to zero over time)
//   "Free rake spin" (3×) = 3 in, 3 out — players see no rake
export const SPIN_BONUS_TIERS = {
  standard: [
    // ~76.19% of spins: default (2× payout, 1× deposited to pool, 0 drawn)
    { displayMultiplier: 2, probability: 76.1904, bonusBuyIns: 0 },
    // ~14.29% of spins: free-rake spin (3× payout, 1× deposited, 1× drawn — net 0)
    { displayMultiplier: 3, probability: 14.2857, bonusBuyIns: 1 },
    // ~5.71% of spins: medium bonus (5× payout, 1× deposited, 3× drawn)
    { displayMultiplier: 5, probability: 5.7143, bonusBuyIns: 3 },
    // ~2.38% of spins: large bonus (10× payout, 1× deposited, 8× drawn)
    { displayMultiplier: 10, probability: 2.381, bonusBuyIns: 8 },
    // ~0.95% of spins: big bonus (25× payout, 1× deposited, 23× drawn)
    { displayMultiplier: 25, probability: 0.9524, bonusBuyIns: 23 },
    // ~0.38% of spins: jackpot (50× payout, 1× deposited, 48× drawn)
    { displayMultiplier: 50, probability: 0.381, bonusBuyIns: 48, isPremium: true },
    // ~0.10% of spins: mega jackpot (100× payout, 1× deposited, 98× drawn)
    { displayMultiplier: 100, probability: 0.0952, bonusBuyIns: 98, isPremium: true },
  ],
  // AUDIT F6 (2026-08-15): this table computed to EV 3.000034 — fractionally
  // HOUSE-NEGATIVE (the failing "hyper EV should be < 3.0" test was right).
  // Moved 0.001 percentage points from the 50x tier to the 2x tier:
  // probabilities still sum to exactly 100.000, EV is now 2.999554 (house
  // edge ~0.015%, same direction as standard's 2.999994), and the pool
  // draw expectation drops below the 1.00-per-spin deposit, so the bonus
  // pool can no longer drift negative over volume.
  hyper: [
    { displayMultiplier: 2, probability: 79.563, bonusBuyIns: 0 },
    { displayMultiplier: 3, probability: 11.6788, bonusBuyIns: 1 },
    { displayMultiplier: 5, probability: 5.1095, bonusBuyIns: 3 },
    { displayMultiplier: 10, probability: 2.1898, bonusBuyIns: 8 },
    { displayMultiplier: 25, probability: 0.8759, bonusBuyIns: 23 },
    { displayMultiplier: 50, probability: 0.437, bonusBuyIns: 48, isPremium: true },
    { displayMultiplier: 100, probability: 0.146, bonusBuyIns: 98, isPremium: true },
  ],
};

// Legacy export — kept for backwards compat but now routes through pool system
export const SPIN_MULTIPLIERS: Record<string, SpinMultiplier[]> = {
  standard: SPIN_BONUS_TIERS.standard.map((t) => ({
    multiplier: t.displayMultiplier,
    probability: t.probability,
    isPremium: t.isPremium || false,
  })),
  hyper: SPIN_BONUS_TIERS.hyper.map((t) => ({
    multiplier: t.displayMultiplier,
    probability: t.probability,
    isPremium: t.isPremium || false,
  })),
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
    baseBounty: 2.5, // 25% of buy-in as starting bounty
    progressiveStartLevel: 1,
  },
  mystery: {
    bountyType: 'mystery',
    baseBounty: 10,
    mysteryTiers: [
      { minMultiplier: 1, maxMultiplier: 1, probability: 60 },
      { minMultiplier: 2, maxMultiplier: 2, probability: 25 },
      { minMultiplier: 5, maxMultiplier: 5, probability: 10 },
      { minMultiplier: 10, maxMultiplier: 10, probability: 4 },
      { minMultiplier: 50, maxMultiplier: 50, probability: 0.9 },
      { minMultiplier: 500, maxMultiplier: 500, probability: 0.1 },
    ],
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
        'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at'
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
      const { data: unionClub } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedId)
        .limit(1)
        .maybeSingle();

      if (unionClub?.union_id) {
        // IMPORTANT: Only fetch XMTT if union allows cross-club tournaments
        const { data: unionData } = await supabase
          .from('unions')
          .select('settings')
          .eq('id', unionClub.union_id)
          .maybeSingle();

        let allowCrossClub = true;
        if (unionData?.settings) {
          try {
            const settings =
              typeof unionData.settings === 'string'
                ? JSON.parse(unionData.settings)
                : unionData.settings;
            allowCrossClub = settings.crossClubTournaments !== false;
          } catch (e) {
            allowCrossClub = true; // Default allow if parsing fails
          }
        }

        if (allowCrossClub) {
          const { data: xmttData } = await supabase
            .from('tournaments')
            .select(
              'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at'
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

          xmttTournaments = xmttData || [];
        }
      }
    } catch (e: unknown) {
      console.warn(
        '[TournamentService] Union XMTT lookup failed — returning club tournaments only:',
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
        'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at, current_level, level_started_at'
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
   * Create a new tournament
   */
  async createTournament(clubId: string, config: TournamentConfig): Promise<Tournament> {
    // Union governance (2026-08-19): clubs inside a union cannot create
    // union-visible tournaments — those are created at the union level.
    // A union club's own staff MAY still create a PRIVATE club tournament
    // (is_private = true, visible only inside the club, never in the union
    // lobby). Union owners/admins keep building union-visible games. The
    // fn_create_tournament RPC + trg_tournaments_union_ownership trigger
    // enforce the same rule server-side.
    if (!config.isXmtt && !config.isPrivate) {
      const resolvedClubId = await resolveClubUUID(clubId);
      const access = await fetchGameCreationAccess(resolvedClubId);
      if (!access.allowed && access.reason === 'union_only') {
        config.isPrivate = true;
      }
    }

    // XMTT validation: require unionId and verify the union has crossClubTournaments enabled
    if (config.isXmtt) {
      if (!config.unionId) {
        throw new Error('XMTT tournaments require a union ID');
      }
      // Verify union exists and has crossClubTournaments enabled
      const { data: unionData } = await supabase
        .from('unions')
        .select('id, settings')
        .eq('id', config.unionId)
        .maybeSingle();
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
      p_config: {
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
        bountyAmount: config.bountyConfig?.baseBounty || 0,
        spinType: config.type === 'spin' ? config.spinType || 'standard' : null,
        satelliteTargetId: config.satelliteTarget?.tournamentId || null,
        isXmtt: config.isXmtt || false,
        isPrivate: config.isPrivate || false,
      },
    });

    if (rpcError) throw rpcError;
    const result = rpcResult as { success?: boolean; error?: string; tournament_id?: string } | null;
    if (!result?.success) {
      throw new Error(TOURNAMENT_CREATE_ERRORS[result?.error ?? ''] ?? 'Could not create tournament');
    }

    const { data } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', result.tournament_id!)
      .maybeSingle();
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
    const { data: freshTournament } = await supabase
      .from('tournaments')
      .select('current_players, max_players, variant')
      .eq('id', tournamentId)
      .maybeSingle();
    if (
      freshTournament?.max_players &&
      (freshTournament.current_players ?? 0) >= freshTournament.max_players &&
      (freshTournament.variant === 'sng' || freshTournament.variant === 'spin')
    ) {
      try {
        await supabase
          .from('tournaments')
          .update({ start_time: new Date().toISOString() })
          .eq('id', tournamentId);
      } catch (autoStartErr) {
        reportError(autoStartErr, 'TournamentService.SNG_autostart_failed');
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
   * Cancel a tournament and refund ALL registered players' buy-ins.
   * Tournaments are ONLY cancelled when fewer than 3 players have joined.
   * This is the sole cancellation condition — tournaments never cancel for other reasons.
   */
  async cancelTournament(
    tournamentId: string,
    reason: string = 'Insufficient players (minimum 3 required)'
  ): Promise<{ refunded: number; playersRefunded: number }> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    if (tournament.status !== 'ANNOUNCED' && tournament.status !== 'REGISTERING') {
      throw new Error('Can only cancel tournaments that have not started yet');
    }

    // Verify cancellation reason: only cancel if < 3 players
    if ((tournament.current_players || 0) >= 3) {
      throw new Error('Cannot cancel — tournament has 3 or more players registered');
    }

    // RAKE-AUDIT 2026-07-24: fetch the players BEFORE the atomic cancel — the
    // RPC deletes tournament_players rows, so the old post-RPC query always
    // returned empty and no BALANCE_UPDATED events ever fired for refunds.
    const { data: players } = await supabase
      .from('tournament_players')
      .select('user_id')
      .eq('tournament_id', tournamentId);

    // Execute atomic cancellation and refund (prevents partial refunds on server crash)
    // RAKE-AUDIT 2026-07-24: the RPC now refunds ONLY real (non-horse) players
    // and reverses the collected entry fees in the rake ledger.
    const { data: cancelResult, error: cancelError } = await retryAsync(
      () =>
        supabase.rpc('atomic_cancel_tournament', {
          p_tournament_id: tournamentId,
          p_admin_id: '00000000-0000-0000-0000-000000000000', // System action
        }),
      3
    );

    if (cancelError) {
      reportError(cancelError, 'TournamentService.CRITICAL');
      throw new Error(`Failed to cancel tournament: ${cancelError.message}`);
    }

    // Process result
    const refunded = cancelResult?.total_refunded || 0;
    const playersRefunded = cancelResult?.refunded_count || 0;

    if (players && players.length > 0) {
      players.forEach((p) => {
        masterBus.emit('BALANCE_UPDATED', {
          source: 'tournament_cancel_refund',
          userId: p.user_id,
        });
      });
    }
    await supabase
      .from('tournaments')
      .update({
        status: 'CANCELLED',
        ended_at: new Date().toISOString(),
        prize_pool: 0,
      })
      .eq('id', tournamentId);

    console.debug(
      `[TournamentService] Cancelled tournament ${tournament.name}: refunded ${playersRefunded} players, ${refunded} chips`
    );

    // Emit completion event (cancelled = complete from a lifecycle perspective)
    masterBus.emit('TOURNAMENT_CANCELLED', {
      tournamentId,
      clubId: tournament.club_id,
      reason,
    });
    masterBus.emit('TOURNAMENT_COMPLETE', { tournamentId, clubId: tournament.club_id });

    return { refunded: refunded, playersRefunded };
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
    const { data: players } = await supabase
      .from('tournament_players')
      .select(
        'id, tournament_id, user_id, username, status, chips, table_id, position, prize, current_bounty, mystery_bounty_value, rebuys, registered_at'
      )
      .eq('tournament_id', tournamentId)
      .eq('status', 'registered');

    if (!players || players.length === 0) throw new Error('No players registered');

    // Auto-cancel if fewer than 3 players — minimum for a valid tournament
    if (players.length < 3) {
      console.debug(
        `[TournamentService] Auto-cancelling tournament ${tournament.name}: only ${players.length} players (minimum 3 required)`
      );
      await this.cancelTournament(
        tournamentId,
        `Only ${players.length} player(s) registered — minimum 3 required`
      );
      throw new Error(
        `Tournament cancelled: only ${players.length} player(s) registered (minimum 3 required)`
      );
    }

    // TOURNEY-AUDIT 2026-07-24 [race guard]: CLAIM the start atomically BEFORE
    // creating any tables. The server's tournament discovery loop starts
    // tournaments too — without this compare-and-swap, an owner clicking
    // "Start" while the server loop fired created DOUBLE tables and DOUBLE
    // seating for the same tournament. Whoever loses the CAS backs off.
    {
      const { data: claimed } = await supabase
        .from('tournaments')
        .update({ status: 'RUNNING', started_at: new Date().toISOString() })
        .eq('id', tournamentId)
        .in('status', ['ANNOUNCED', 'REGISTERING'])
        .select('id');
      if (!claimed || claimed.length === 0) {
        throw new Error('Tournament is already starting (server or another admin claimed it)');
      }
    }

    // 2. Create Tables
    const playersPerTable = 9;
    const numTables = Math.ceil(players.length / playersPerTable);
    const createdTables: any[] = [];

    for (let i = 0; i < numTables; i++) {
      const { data: table } = await supabase
        .from('tables')
        .insert({
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
        })
        .select()
        .maybeSingle();

      if (table) createdTables.push(table);
    }

    // 3. Seat Players — Fisher-Yates shuffle for unbiased randomization
    const shuffled = [...players];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const tableSeats = createdTables.map((t) => ({ tableId: t.id, nextSeat: 1 }));

    for (let i = 0; i < shuffled.length; i++) {
      const player = shuffled[i];
      const tableAssign = tableSeats[i % numTables];

      const { error: seatErr } = await supabase.from('table_seats').insert({
        table_id: tableAssign.tableId,
        seat_number: tableAssign.nextSeat,
        user_id: player.user_id,
        // TOURNEY-AUDIT 2026-07-24: seats were inserted with NO stack — the
        // engine reads table_seats.stack, so client-started tournaments seated
        // everyone with a null stack.
        stack: tournament.starting_chips,
      });
      if (seatErr) reportError(seatErr, 'TournamentService.Failed_to_seat_player_playeruser_id');
      tableAssign.nextSeat++;
    }

    // TOURNEY-AUDIT 2026-07-24: record each table's seated count — the seat
    // loop never bumped tables.current_players, so every tournament table
    // reported 0 players (breaking balance/merge checks and the Tables tab).
    for (const ts of tableSeats) {
      await supabase
        .from('tables')
        .update({ current_players: ts.nextSeat - 1 })
        .eq('id', ts.tableId);
    }

    // 4. Refresh tournament row (status/started_at were already CAS-claimed above)
    const { data, error } = await supabase
      .from('tournaments')
      .select()
      .eq('id', tournamentId)
      .maybeSingle();

    if (error) throw error;

    // 5. Update Player Stacks
    await supabase
      .from('tournament_players')
      .update({
        chips: tournament.starting_chips,
        status: 'playing',
      })
      .eq('tournament_id', tournamentId)
      .eq('status', 'registered');

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
    const entry = structure.find((p) => p.place === position);
    if (!entry) return 0;
    // Exact precision: multiply ×100, truncate, back to chips
    // Formula: trunc(pool * percentage / 100 * 100) / 100
    // Simplified: trunc(pool * percentage) / 100
    return Math.trunc(prizePool * entry.percentage) / 100;
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

    if (tournament.status !== 'RUNNING' || !tournament.started_at) {
      return {
        currentLevel: blinds[0],
        nextLevel: blinds[1] || null,
        timeRemainingSeconds: blinds[0].durationMinutes * 60,
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
    const serverLevel = serverT.current_level;
    if (typeof serverLevel === 'number' && serverLevel >= 0 && serverLevel < blinds.length) {
      const level = blinds[serverLevel];
      const durationSec = (level?.durationMinutes || 10) * 60;
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
      const durationMs = level.durationMinutes * 60 * 1000;

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

    // Rebuy cutoff = late reg cutoff (always the same)
    const levelState = this.getCurrentLevelState(tournament);
    const rebuyLevelCap = tournament.late_reg_levels ?? tournament.rebuy_levels ?? 8;
    if (rebuyLevelCap <= 0 || levelState.levelIndex >= rebuyLevelCap) {
      return { allowed: false, reason: 'Rebuy/re-entry period has ended' };
    }

    // Check current stack (must be at or below starting stack)
    const { data: player } = await supabase
      .from('tournament_players')
      .select('chips')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

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
    const buyIn = Number(tournament.buy_in_amount || 0);
    const fee = Number(tournament.buy_in_fee || 0);
    if (buyIn > 0 && fee > 0) return fee / buyIn;
    return 0.1;
  }

  /** Fee for a given base cost, rounded to the cent. */
  private calcTournamentFee(
    tournament: { buy_in_amount?: number | null; buy_in_fee?: number | null },
    baseCost: number
  ): number {
    return Math.round(baseCost * this.getTournamentFeeRatio(tournament) * 100) / 100;
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
        const { data: tData } = await supabase
          .from('tournaments')
          .select('total_rake')
          .eq('id', tournamentId)
          .maybeSingle();
        if (tData) {
          await supabase
            .from('tournaments')
            .update({ total_rake: (tData.total_rake || 0) + fee })
            .eq('id', tournamentId);
        }
      }
    } catch (e: unknown) {
      reportError(e, 'TournamentService.recordTournamentFee_total_rake');
    }
    // Union-level counter
    const unionId = tournament.union_id || undefined;
    if (unionId) {
      try {
        const { data: unionData } = await supabase
          .from('unions')
          .select('total_rake')
          .eq('id', unionId)
          .maybeSingle();
        if (unionData) {
          await supabase
            .from('unions')
            .update({ total_rake: (unionData.total_rake || 0) + fee })
            .eq('id', unionId);
        }
      } catch (e: unknown) {
        reportError(e, 'TournamentService.recordTournamentFee_union_total_rake');
      }
    }
  }

  /**
   * Process a rebuy for a player
   */
  async processRebuy(
    tournamentId: string,
    userId: string
  ): Promise<{ success: boolean; newStack?: number }> {
    const canRebuyResult = await this.canRebuy(tournamentId, userId);
    if (!canRebuyResult.allowed) {
      throw new Error(canRebuyResult.reason || 'Rebuy not allowed');
    }

    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    const rebuyChips = tournament.rebuy_chips || tournament.starting_chips;
    const rebuyCost = tournament.rebuy_cost || tournament.buy_in_amount;
    // RAKE-AUDIT 2026-07-24: rebuys were fee-free — 100% of rebuy money went to
    // the prize pool and 0% to the house, breaking Dan's "10% on any and all
    // tournament/SNG buy-ins" rule. Fee is now charged on top of the rebuy cost
    // (base cost still feeds the prize pool; recalculatePrizePool strips the fee).
    const rebuyFee = this.calcTournamentFee(tournament, rebuyCost);
    const rebuyTotalCost = Math.round((rebuyCost + rebuyFee) * 100) / 100;

    // Pre-validate wallet balance (better error messages)
    const { data: walletData } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .eq('wallet_type', 'PLAYER')
      .maybeSingle();

    if (!walletData || (walletData.balance || 0) < rebuyTotalCost) {
      throw new Error(
        `Insufficient chips for rebuy. Need ${rebuyTotalCost} (incl. ${rebuyFee} fee), have ${walletData?.balance || 0}`
      );
    }

    // Process rebuy via ATOMIC RPC
    // (This RPC handles the wallet deduction and logging natively. It rolls back automatically on failure.)
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: tournamentId,
          p_user_id: userId, // Round 19: prod sig uses p_user_id not p_player_id
          p_rebuy_type: tournament.is_reentry && !tournament.is_rebuy ? 'reentry' : 'rebuy',
          p_cost: rebuyTotalCost,
          p_chips: rebuyChips,
          p_current_level: this.getCurrentLevelState(tournament).levelIndex,
        }),
      3
    );

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

    // Add-on period is level-based: opens when rebuy/late reg period ends,
    // stays open for addon_levels levels (default 1)
    const levelState = this.getCurrentLevelState(tournament);
    const rebuyLevelCap = tournament.late_reg_levels ?? tournament.rebuy_levels ?? 8;
    const addonLevelWindow = tournament.addon_levels ?? 1;

    if (levelState.levelIndex < rebuyLevelCap) {
      return {
        allowed: false,
        reason: 'Rebuy/re-entry period still active — add-on opens after it ends',
      };
    }

    if (levelState.levelIndex >= rebuyLevelCap + addonLevelWindow) {
      return { allowed: false, reason: 'Add-on period has ended' };
    }

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
    const addonCost = tournament.addon_cost || tournament.buy_in_amount;
    // Dan 2026-08-20 (binding): "ADD ON'S AREN'T RAKED. ONLY REBUYS."
    // This reverses the 2026-07-24 change that put a 10% house fee on add-ons.
    // process_tournament_rebuy now charges an add-on at face value and books
    // no rake for it; the whole add-on goes to the prize pool.
    const addonTotalCost = Math.round(addonCost * 100) / 100;

    // Check if player already used their add-on (each player gets max 1 add-on)
    const { data: existingAddon } = await supabase
      .from('wallet_transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('category', 'addon')
      .eq('related_entity_id', tournamentId)
      .limit(1);
    if (existingAddon && existingAddon.length > 0) {
      throw new Error('You have already used your add-on for this tournament');
    }

    // Pre-validate wallet balance (better error messages)
    const { data: addonWallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .eq('wallet_type', 'PLAYER')
      .maybeSingle();

    if (!addonWallet || (addonWallet.balance || 0) < addonTotalCost) {
      throw new Error(
        `Insufficient chips for add-on. Need ${addonTotalCost}, have ${addonWallet?.balance || 0}`
      );
    }

    // Process addon via ATOMIC RPC
    // (This handles wallet deduction, logging, and rollback natively)
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: tournamentId,
          p_user_id: userId, // Round 19: prod sig uses p_user_id not p_player_id
          p_rebuy_type: 'addon',
          p_cost: addonTotalCost,
          p_chips: addonChips,
          p_current_level: this.getCurrentLevelState(tournament).levelIndex,
        }),
      3
    );

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

  /**
   * Process a re-entry for an eliminated player
   * Re-entry creates a NEW tournament_players entry (old one stays as eliminated)
   * Only allowed if tournament.is_reentry is true and within late registration period
   */
  async processReentry(
    tournamentId: string,
    userId: string
  ): Promise<{ success: boolean; newEntryId?: string }> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    // Check if re-entry is enabled
    if (!tournament.is_reentry) {
      throw new Error('Re-entry not available for this tournament');
    }

    // Check if currently within late registration period
    const levelState = this.getCurrentLevelState(tournament);
    const lateRegLevelCap = tournament.late_reg_levels ?? tournament.rebuy_levels ?? 8;
    if (levelState.levelIndex >= lateRegLevelCap) {
      throw new Error('Re-entry period has ended');
    }

    // Verify player does NOT already have an active entry
    const { data: activeEntry } = await supabase
      .from('tournament_players')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .in('status', ['registered', 'playing']);

    if (activeEntry && activeEntry.length > 0) {
      throw new Error('You already have an active entry in this tournament');
    }

    // Verify player was previously eliminated
    const { data: eliminatedEntry } = await supabase
      .from('tournament_players')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .eq('status', 'eliminated')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!eliminatedEntry) {
      throw new Error('You have not been eliminated in this tournament');
    }

    // Check wallet balance for buy-in
    const reentryChips = tournament.starting_chips;
    const reentryCost = tournament.buy_in_amount;
    // RAKE-AUDIT 2026-07-24: 10% house fee on re-entries (previously fee-free —
    // a re-entry is a full fresh buy-in and must carry the same fee as entry #1)
    const reentryFee = this.calcTournamentFee(tournament, reentryCost);
    const reentryTotalCost = Math.round((reentryCost + reentryFee) * 100) / 100;

    const { data: walletData } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .eq('wallet_type', 'PLAYER')
      .maybeSingle();

    if (!walletData || (walletData.balance || 0) < reentryTotalCost) {
      throw new Error(
        `Insufficient chips for re-entry. Need ${reentryTotalCost} (incl. ${reentryFee} fee), have ${walletData?.balance || 0}`
      );
    }

    // Process re-entry via ATOMIC RPC (same as rebuy/addon, type='reentry')
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: tournamentId,
          p_user_id: userId, // Round 19: prod sig uses p_user_id not p_player_id
          p_rebuy_type: 'reentry',
          p_cost: reentryTotalCost,
          p_chips: reentryChips,
          p_current_level: levelState.levelIndex,
        }),
      3
    );

    if (error) {
      reportError(error, 'TournamentService.Reentry_RPC_failed_No_chips_were_deducte');
      throw error;
    }

    // 2026-08-20: the fee is booked by process_tournament_rebuy inside the
    // same transaction as the chip deduction. This used to ALSO insert a
    // rake_records row and increment total_rake here, so every fee was
    // counted twice in union rake revenue and in rakeback.

    // Emit AFTER confirmed success
    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_reentry', userId });

    // Recalculate prize pool: re-entry cost goes to pool
    await this.recalculatePrizePool(tournamentId);

    // Broadcast re-entry event
    try {
      const { realtimeChannelService } = await import('./RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
        type: 'player_registered',
        payload: { type: 'reentry', userId, chips: reentryChips },
      });
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Failed_to_broadcast_reentry_event');
    }

    return { success: true, newEntryId: data?.new_entry_id };
  }

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

    // Count only REAL (non-horse) entries. Horses register free (buy_in 0) and
    // must not inflate the prize pool — buy_in_amount is not populated on the
    // tournament_players row for real players (atomic_tournament_register omits
    // it), so exclusion is by the profiles.is_horse flag rather than by amount.
    let entryCount = 0;
    const { data: entryRows } = await supabase
      .from('tournament_players')
      .select('user_id')
      .eq('tournament_id', tournamentId);
    if (entryRows && entryRows.length > 0) {
      const entryUserIds = entryRows.map((r) => r.user_id);
      const { data: horseRows } = await supabase
        .from('profiles')
        .select('id')
        .in('id', entryUserIds)
        .eq('is_horse', true);
      const horseIds = new Set((horseRows || []).map((h) => h.id));
      // Each row is one paid entry (re-entries create additional rows); count
      // rows whose user is not a horse.
      entryCount = entryRows.filter((r) => !horseIds.has(r.user_id)).length;
    }

    // Count rebuys and add-ons from wallet_transactions (always available)
    // RAKE-AUDIT 2026-07-24: rebuy/add-on debits now INCLUDE the 10% house fee
    // (charged as of this fix). Only the base cost feeds the prize pool, so the
    // fee portion is stripped here — previously 100% of rebuy/add-on money
    // (fee-free) inflated the pool and the house collected nothing.
    let rebuyTotal = 0;
    let addonTotal = 0;
    const feeRatio = this.getTournamentFeeRatio(tournament);
    try {
      const { data: rebuyTxns } = await supabase
        .from('wallet_transactions')
        .select('amount, category')
        .eq('related_entity_id', tournamentId)
        .in('category', ['rebuy', 'addon']);

      if (rebuyTxns) {
        for (const tx of rebuyTxns) {
          const gross = Math.abs(tx.amount || 0);
          const cost = Math.round((gross / (1 + feeRatio)) * 100) / 100;
          if (tx.category === 'addon') addonTotal += cost;
          else rebuyTotal += cost;
        }
      }
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Could_not_query_rebuyaddon_transactions');
    }

    // Calculate total prize pool
    const calculatedPool =
      Math.trunc(((entryCount || 0) * buyIn + rebuyTotal + addonTotal) * 100) / 100;
    const finalPool = guarantee > 0 ? Math.max(calculatedPool, guarantee) : calculatedPool;

    // Update tournament
    await supabase
      .from('tournaments')
      .update({
        prize_pool: finalPool,
      })
      .eq('id', tournamentId);

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
    const { data: tables } = await supabase
      .from('tables')
      .select('id, current_players')
      .eq('tournament_id', tournamentId)
      .neq('status', 'closed');

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
    const { data: tables } = await supabase
      .from('tables')
      .select('id, current_players')
      .eq('tournament_id', tournamentId)
      .neq('status', 'closed')
      .order('current_players', { ascending: true });

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
    const { count } = await supabase
      .from('tournament_players')
      .select('*', { count: 'exact' })
      .eq('tournament_id', tournamentId)
      .eq('status', 'playing');

    if (!count || count > 9) return { finalTableId: null };

    // Get or create final table (look for a table named "Final Table")
    let { data: finalTable } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', tournamentId)
      .ilike('name', '%Final Table%')
      .neq('status', 'closed')
      .limit(1)
      .maybeSingle();

    if (!finalTable) {
      const tournament = await this.getTournament(tournamentId);
      if (!tournament) return { finalTableId: null };

      // Safe access: blind_structure may be null/empty/string for misconfigured tournaments
      const resolvedBlinds = parseBlindStructure(tournament.blind_structure);
      const blinds = resolvedBlinds[0];

      const { data: newTable } = await supabase
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

  /**
   * Broadcast player elimination
   */
  async broadcastElimination(
    tournamentId: string,
    eliminatedPlayer: { id: string; name: string; position: number; prize: number }
  ): Promise<void> {
    try {
      const { realtimeChannelService } = await import('./RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
        type: 'player_eliminated',
        payload: eliminatedPlayer,
      });
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Failed_to_broadcast_elimination');
    }
  }

  /**
   * Broadcast tournament winner
   */
  async broadcastWinner(
    tournamentId: string,
    winner: { id: string; name: string; prize: number }
  ): Promise<void> {
    try {
      const { realtimeChannelService } = await import('./RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
        type: 'winner',
        payload: winner,
      });
    } catch (e: unknown) {
      reportError(e, 'TournamentService.Failed_to_broadcast_winner');
    }
  }

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
      const { data: players } = await supabase
        .from('tournament_players')
        .select('user_id, position, prize')
        .eq('tournament_id', tournamentId)
        .not('position', 'is', null)
        .order('position', { ascending: true });

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

  /**
   * Spin the multiplier wheel for a Spin & Go
   */
  /**
   * Spin the multiplier wheel — now pool-aware.
   * Returns the display multiplier, bonus buy-ins requested, and premium flag.
   * The caller (TournamentEngine) is responsible for checking pool balance
   * and capping the actual bonus payout.
   */
  spinMultiplier(config: SpinMultiplier[]): {
    multiplier: number;
    isPremium: boolean;
    bonusBuyIns: number;
  } {
    const random = Math.random() * 100;
    let cumulative = 0;

    // Find matching tier from the legacy config array
    for (let i = 0; i < config.length; i++) {
      const tier = config[i];
      cumulative += tier.probability;
      if (random <= cumulative) {
        // Look up bonusBuyIns from SPIN_BONUS_TIERS (match by multiplier)
        const bonusTier = SPIN_BONUS_TIERS.standard.find(
          (bt) => bt.displayMultiplier === tier.multiplier
        );
        return {
          multiplier: tier.multiplier,
          isPremium: tier.isPremium || false,
          bonusBuyIns: bonusTier?.bonusBuyIns ?? 0,
        };
      }
    }

    // Fallback to lowest multiplier (no bonus)
    return { multiplier: config[0].multiplier, isPremium: false, bonusBuyIns: 0 };
  }

  /**
   * Create and start a Spin & Go
   */
  async createSpin(clubId: string, buyIn: number, rake: number): Promise<Tournament> {
    // Multiplier is NOT selected here — it's rolled at game start in TournamentEngine
    // This preserves the "surprise" element of Spin & Go
    const config: TournamentConfig = {
      name: `Spin & Go ${buyIn}`,
      type: 'spin',
      buyIn,
      rake,
      startingStack: 500,
      maxPlayers: 3,
      minPlayers: 3,
      blindStructure: SPIN_BLIND_STRUCTURE,
      payoutStructure: [{ place: 1, percentage: 100 }], // Winner takes all
      lateRegistrationLevels: 0,
      isRebuy: false,
      addOnAvailable: false,
      spinConfig: {
        possibleMultipliers: SPIN_MULTIPLIERS.standard,
      },
    };

    return await this.createTournament(clubId, config);
  }

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

  /**
   * Roll mystery bounty value
   */
  rollMysteryBounty(config: BountyConfig): number {
    if (!config.mysteryTiers) return config.baseBounty;

    const random = Math.random() * 100;
    let cumulative = 0;

    for (const tier of config.mysteryTiers) {
      cumulative += tier.probability;
      if (random < cumulative) {
        // Random value within the tier range
        const multiplier =
          tier.minMultiplier === tier.maxMultiplier
            ? tier.minMultiplier
            : Math.floor(Math.random() * (tier.maxMultiplier - tier.minMultiplier + 1)) +
              tier.minMultiplier;
        return config.baseBounty * multiplier;
      }
    }

    return config.baseBounty;
  }

  /**
   * Get total bounties won by a player in a tournament
   */
  async getPlayerBounties(tournamentId: string, playerId: string): Promise<number> {
    const { data, error } = await supabase
      .from('tournament_bounties')
      .select('bounty_amount')
      .eq('tournament_id', tournamentId)
      .eq('collector_player_id', playerId);

    if (error) return 0;
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
    const { data: existing } = await supabase
      .from('tournament_waitlists')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      throw new Error('You are already on the waitlist');
    }

    const { count } = await supabase
      .from('tournament_waitlists')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);

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
    const { data: entry } = await supabase
      .from('tournament_waitlists')
      .select('id, position')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!entry) return null;

    const { count } = await supabase
      .from('tournament_waitlists')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);

    return { position: entry.position, total: count || 0 };
  }
}

export const tournamentService = new TournamentService();
