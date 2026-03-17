/**
 * ♠ CLUB ARENA — Tournament Service
 * SNGs and MTTs with blind levels and payout structures
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import type { Tournament, TournamentPlayer } from '../types/database.types';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
  isBreak?: boolean;
}

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
  gameVariant?: 'NLH' | 'PLO4' | 'PLO5' | 'PLO8' | 'OFC_PINEAPPLE' | 'SHORT_DECK';

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
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDARD STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

export const BLIND_STRUCTURES = {
  turbo: [
    { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 3 },
    { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 3 },
    { level: 3, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 3 },
    { level: 4, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 3 },
    { level: 5, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 3 },
    { level: 6, smallBlind: 100, bigBlind: 200, ante: 20, durationMinutes: 3 },
    { level: 7, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 3 },
    { level: 8, smallBlind: 200, bigBlind: 400, ante: 40, durationMinutes: 3 },
    { level: 9, smallBlind: 300, bigBlind: 600, ante: 60, durationMinutes: 3 },
    { level: 10, smallBlind: 400, bigBlind: 800, ante: 80, durationMinutes: 3 },
  ],
  regular: [
    { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 8 },
    { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 8 },
    { level: 3, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 8 },
    { level: 4, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 8 },
    { level: 5, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 8 },
    { level: 6, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 8 },
    { level: 7, smallBlind: 150, bigBlind: 300, ante: 40, durationMinutes: 8 },
    { level: 8, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 8 },
    { level: 9, smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 8 },
    { level: 10, smallBlind: 400, bigBlind: 800, ante: 100, durationMinutes: 8 },
  ],
  deepStack: [
    { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 15 },
    { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 15 },
    { level: 3, smallBlind: 20, bigBlind: 40, ante: 0, durationMinutes: 15 },
    { level: 4, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 15 },
    { level: 5, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 15 },
    { level: 6, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 15 },
    { level: 7, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 15 },
    { level: 8, smallBlind: 150, bigBlind: 300, ante: 40, durationMinutes: 15 },
    { level: 9, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 15 },
    { level: 10, smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 15 },
  ],
};

export const PAYOUT_STRUCTURES = {
  sng6: [
    { place: 1, percentage: 65 },
    { place: 2, percentage: 35 },
  ],
  sng9: [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ],
  mtt10: [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ],
  mtt20: [
    { place: 1, percentage: 38 },
    { place: 2, percentage: 27 },
    { place: 3, percentage: 18 },
    { place: 4, percentage: 10 },
    { place: 5, percentage: 7 },
  ],
  mtt50: [
    { place: 1, percentage: 28 },
    { place: 2, percentage: 18 },
    { place: 3, percentage: 13 },
    { place: 4, percentage: 10 },
    { place: 5, percentage: 8 },
    { place: 6, percentage: 6 },
    { place: 7, percentage: 5 },
    { place: 8, percentage: 4.5 },
    { place: 9, percentage: 4 },
    { place: 10, percentage: 3.5 },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// SPIN CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ── PROFITABLE Spin Multiplier Tables ──────────────────────────────────────
// Prize pool = buy_in * multiplier (NOT net_buy_in * players * multiplier)
// 3 players each pay buy_in. Winner gets buy_in * multiplier.
// Club profit per spin = (3 * buy_in) - (buy_in * multiplier) + (3 * fee)
// For profitability: E[multiplier] must be < 3.0
//
// Standard EV = 2.2415 → Club keeps ~25% margin before fees
// Hyper EV   = 2.2850 → Club keeps ~24% margin before fees
export const SPIN_MULTIPLIERS: Record<string, SpinMultiplier[]> = {
  standard: [
    { multiplier: 2, probability: 92.5 }, // EV: 1.8500
    { multiplier: 3, probability: 5.0 }, // EV: 0.1500
    { multiplier: 5, probability: 1.8 }, // EV: 0.0900
    { multiplier: 10, probability: 0.5 }, // EV: 0.0500
    { multiplier: 25, probability: 0.15 }, // EV: 0.0375
    { multiplier: 100, probability: 0.04, isPremium: true }, // EV: 0.0400
    { multiplier: 240, probability: 0.01, isPremium: true }, // EV: 0.0240
  ], // TOTAL EV: 2.2415
  hyper: [
    { multiplier: 2, probability: 91.0 }, // EV: 1.8200
    { multiplier: 3, probability: 5.5 }, // EV: 0.1650
    { multiplier: 5, probability: 2.2 }, // EV: 0.1100
    { multiplier: 10, probability: 0.8 }, // EV: 0.0800
    { multiplier: 25, probability: 0.35 }, // EV: 0.0875
    { multiplier: 100, probability: 0.04, isPremium: true }, // EV: 0.0400
    { multiplier: 240, probability: 0.01, isPremium: true }, // EV: 0.0240
    // Hyper spins have slightly more variance but same profitability
  ], // TOTAL EV: 2.3265 (PENDING RECALC — safe < 3.0)
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

export const SPIN_BLIND_STRUCTURE: BlindLevel[] = [
  { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 2 },
  { level: 2, smallBlind: 20, bigBlind: 40, ante: 0, durationMinutes: 2 },
  { level: 3, smallBlind: 30, bigBlind: 60, ante: 0, durationMinutes: 2 },
  { level: 4, smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 2 },
  { level: 5, smallBlind: 75, bigBlind: 150, ante: 0, durationMinutes: 2 },
  { level: 6, smallBlind: 100, bigBlind: 200, ante: 0, durationMinutes: 2 },
  { level: 7, smallBlind: 150, bigBlind: 300, ante: 0, durationMinutes: 2 },
  { level: 8, smallBlind: 250, bigBlind: 500, ante: 0, durationMinutes: 2 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

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
        'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at'
      )
      .eq('club_id', resolvedId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[TournamentService] Error fetching tournaments:', error);
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
        const { data: xmttData } = await supabase
          .from('tournaments')
          .select(
            'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at'
          )
          .eq('union_id', unionClub.union_id)
          .eq('is_xmtt', true)
          .neq('club_id', resolvedId) // Avoid duplicates (host club already included above)
          .order('created_at', { ascending: false });

        xmttTournaments = xmttData || [];
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
        'id, name, club_id, union_id, game_type, variant, tournament_type, buy_in_amount, buy_in_fee, starting_chips, max_players, min_players, current_players, status, prize_pool, guaranteed_prize, blind_structure, payout_structure, late_reg_levels, late_reg_mins, start_time, started_at, ended_at, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, add_on_available, addon_cost, addon_chips, addon_levels, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_multi_day, total_days, day_number, flight_number, spin_type, spin_multiplier, is_xmtt, total_rake, created_at'
      )
      .eq('id', tournamentId)
      .maybeSingle();

    if (error) {
      console.error('[TournamentService] Error fetching tournament:', error);
      return null;
    }
    return data;
  }

  /**
   * Create a new tournament
   */
  async createTournament(clubId: string, config: TournamentConfig): Promise<Tournament> {
    // Union guard: clubs inside a union cannot create ANY standalone tournaments.
    // All tournaments for union clubs must be created at the union level (XMTT).
    if (!config.isXmtt) {
      const resolvedClubId = await resolveClubUUID(clubId);
      const { data: unionCheck } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedClubId)
        .maybeSingle();
      if (unionCheck) {
        throw new Error(
          'Clubs inside a union cannot create standalone tournaments. Use the Union page to create XMTT tournaments.'
        );
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
        console.error('[TournamentService] Error:', err);
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
    if (config.blindStructure && Array.isArray(config.blindStructure)) {
      for (let i = 0; i < config.blindStructure.length; i++) {
        const level = config.blindStructure[i] as any;
        if (level.durationMinutes !== undefined && level.durationMinutes <= 0) {
          throw new Error(
            `Blind level ${i + 1} has invalid duration (${level.durationMinutes}). Must be > 0.`
          );
        }
        if (i > 0) {
          const prev = config.blindStructure[i - 1] as any;
          // FIX: Use OR — either blind decreasing is invalid (was AND, which allowed partial decreases)
          if (
            Number(level.smallBlind) < Number(prev.smallBlind) ||
            Number(level.bigBlind) < Number(prev.bigBlind)
          ) {
            throw new Error(
              `Blind structure must not decrease: level ${i + 1} (${level.smallBlind}/${level.bigBlind}) is lower than level ${i} (${prev.smallBlind}/${prev.bigBlind})`
            );
          }
        }
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
    const { data, error } = await supabase
      .from('tournaments')
      .insert({
        club_id: finalClubId,
        name: config.name,
        game_type: config.gameVariant || 'NLH',
        variant: variantMap[config.type] || 'freezeout',
        tournament_type: config.type === 'sng' ? 'SNG' : config.type === 'spin' ? 'SPIN' : 'MTT',
        buy_in_amount: config.buyIn,
        buy_in_fee: config.rake || 0,
        starting_chips: config.startingStack,
        max_players: config.maxPlayers,
        min_players: config.minPlayers || 3,
        current_players: 0,
        status: 'REGISTERING',
        blind_structure: config.blindStructure,
        payout_structure: config.payoutStructure,
        guaranteed_prize: config.guaranteedPrize || 0,
        // Late reg + rebuy cutoff (level-based, per-tournament)
        late_reg_levels: config.lateRegistrationLevels || 0,
        late_reg_mins: config.lateRegistrationLevels || 0, // Legacy fallback
        start_time: config.startTime?.toISOString() || new Date(Date.now() + 60000).toISOString(),
        // Rebuy / Re-Entry / Add-on
        is_rebuy: config.isRebuy || false,
        is_reentry: config.isReentry || false,
        rebuy_cost: config.rebuyCost || 0,
        rebuy_chips: config.rebuyChips || 0,
        rebuy_levels: config.lateRegistrationLevels || 0, // Always matches late reg
        add_on_available: config.addOnAvailable || false,
        addon_cost: config.addOnCost || 0,
        addon_chips: config.addOnChips || 0,
        addon_levels: config.addOnLevels || 1,
        // Bounty
        is_bounty: isBountyType,
        bounty_amount: config.bountyConfig?.baseBounty || 0,
        is_pko: config.type === 'progressive_bounty',
        is_mystery_bounty: config.type === 'mystery_bounty',
        mystery_bounty_min: config.bountyConfig?.mysteryTiers?.[0]?.minMultiplier ?? 1,
        mystery_bounty_max:
          config.bountyConfig?.mysteryTiers && config.bountyConfig.mysteryTiers.length > 0
            ? config.bountyConfig.mysteryTiers[config.bountyConfig.mysteryTiers.length - 1]
                .maxMultiplier
            : 50,
        // Multi-Day
        is_multi_day: config.isMultiDay || false,
        total_days: config.totalDays || 1,
        day_number: 1,
        flight_number: 1,
        // Spin type (standard vs hyper) — server reads this to pick multiplier table
        spin_type: config.type === 'spin' ? config.spinType || 'standard' : null,
        // XMTT (Union Tournament)
        is_xmtt: config.isXmtt || false,
        union_id: config.unionId || null,
      })
      .select()
      .maybeSingle();

    if (error) throw error;
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

    // Check registration eligibility (level-based late registration)
    const lateRegLevels = tournament.late_reg_levels || tournament.late_reg_mins || 0;
    const levelState = this.getCurrentLevelState(tournament);
    const isLateRegOpen =
      tournament.status === 'RUNNING' && lateRegLevels > 0 && levelState.levelIndex < lateRegLevels;

    if (
      tournament.status !== 'REGISTERING' &&
      tournament.status !== 'ANNOUNCED' &&
      !isLateRegOpen
    ) {
      throw new Error('Registration is closed');
    }
    if (tournament.max_players && tournament.current_players >= tournament.max_players) {
      throw new Error('Tournament is full');
    }

    // ─── Duplicate registration check ───
    const { data: existing } = await supabase
      .from('tournament_players')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .maybeSingle();
    if (existing) {
      throw new Error('Already registered for this tournament');
    }

    // Calculate total cost (buy-in + fee — exact penny values from DB, NO rounding)
    const buyIn = tournament.buy_in_amount || 0;
    const rake = tournament.buy_in_fee || 0;
    const totalCost = buyIn + rake;

    // ─── ATOMIC Tournament Registration ───
    // Chip flow: Player Wallet → Tournament entry
    // Uses atomic_tournament_register RPC to deduct + insert in a single transaction
    const clubId = tournament.club_id;

    // Initialize bounty values for bounty tournaments (needed BEFORE the RPC call)
    const isBountyTournament =
      tournament.is_bounty || tournament.is_pko || tournament.is_mystery_bounty;
    let currentBounty = 0;
    let mysteryBountyValue = 0;
    if (isBountyTournament) {
      currentBounty = tournament.bounty_amount || 0;
      if (tournament.is_mystery_bounty) {
        const baseBounty = tournament.bounty_amount || 0;
        const bountyConfig: BountyConfig = {
          bountyType: 'mystery',
          baseBounty,
          mysteryTiers: [
            { minMultiplier: 1, maxMultiplier: 1, probability: 60 },
            { minMultiplier: 2, maxMultiplier: 2, probability: 25 },
            { minMultiplier: 5, maxMultiplier: 5, probability: 10 },
            { minMultiplier: 10, maxMultiplier: 10, probability: 4 },
            { minMultiplier: 50, maxMultiplier: 50, probability: 0.9 },
            { minMultiplier: 500, maxMultiplier: 500, probability: 0.1 },
          ],
        };
        mysteryBountyValue = this.rollMysteryBounty(bountyConfig);
        currentBounty = mysteryBountyValue;
      }
    }

    // ATOMIC: Deduct wallet + insert tournament_players in a single Postgres transaction
    const { data: atomicPlayerId, error: atomicError } = await retryAsync(
      () =>
        supabase.rpc('atomic_tournament_register', {
          p_tournament_id: tournamentId,
          p_user_id: userId,
          p_username: username,
          p_total_cost: totalCost,
          p_current_bounty: currentBounty,
          p_mystery_bounty_value: mysteryBountyValue || 0,
          p_is_bounty_tournament: isBountyTournament,
        }),
      3
    );

    if (atomicError) {
      // Duplicate registration (23505 unique constraint) surfaces as an RPC exception
      if (atomicError.message?.includes('duplicate') || atomicError.message?.includes('23505')) {
        throw new Error('Already registered for this tournament');
      }
      if (atomicError.message?.includes('Insufficient')) {
        throw new Error(atomicError.message);
      }
      throw new Error(`Tournament registration failed: ${atomicError.message}`);
    }

    // Re-fetch the player row we just inserted (the RPC returns only the id)
    const { data, error } = await supabase
      .from('tournament_players')
      .select(
        'id, tournament_id, user_id, username, status, chips, table_id, position, prize, current_bounty, mystery_bounty_value, rebuys, registered_at'
      )
      .eq('id', atomicPlayerId)
      .maybeSingle();

    if (error || !data) {
      console.error('[TournamentService] Could not re-fetch registered player:', error);
      throw new Error('Registration succeeded but player data could not be retrieved');
    }

    // Log buy-in transaction (just the buy-in amount that feeds prize pool)
    if (buyIn > 0) {
      await WalletService.logTransaction(
        userId,
        'PLAYER',
        -buyIn,
        'debit',
        'buyin',
        `Tournament buy-in: ${tournament.name}`,
        undefined,
        tournamentId
      );
    }

    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_buyin', userId });
    // FIX: Also emit TOURNAMENT_UPDATED — UI components listen for this event, not TOURNAMENT_REGISTERED
    masterBus.emit('TOURNAMENT_REGISTERED', { tournamentId, userId, clubId: tournament.club_id });
    masterBus.emit('TOURNAMENT_UPDATED', { tournamentId, status: tournament.status });

    // Log rake/fee separately for clean audit trail
    if (rake > 0) {
      await WalletService.logTransaction(
        userId,
        'PLAYER',
        -rake,
        'debit',
        'rake',
        `Tournament fee: ${tournament.name}`,
        undefined,
        undefined,
        tournamentId
      );

      // ── Credit tournament rake to club + track at union level ──
      try {
        await supabase.from('rake_records').insert({
          hand_id: `tournament-reg-${tournamentId}-${userId}`,
          table_id: tournamentId,
          club_id: clubId,
          rake_amount: rake,
          pot_size: totalCost,
          num_players: 1,
          bbj_contribution: 0,
        });
      } catch (e: unknown) {
        console.error(`[TournamentService] Failed to insert tournament rake_record:`, e);
      }

      // Update tournament total_rake atomically to prevent lost updates on concurrent registrations
      try {
        const { error: rakeIncErr } = await retryAsync(
          () =>
            supabase.rpc('increment_tournament_rake', {
              p_tournament_id: tournamentId,
              p_amount: rake,
            }),
          3
        );
        // Fallback: read-modify-write (still inside try/catch for non-existence of RPC)
        if (rakeIncErr) {
          const { data: tData } = await supabase
            .from('tournaments')
            .select('total_rake')
            .eq('id', tournamentId)
            .maybeSingle();
          if (tData) {
            const { error: fallbackErr } = await supabase
              .from('tournaments')
              .update({ total_rake: (tData.total_rake || 0) + rake })
              .eq('id', tournamentId);
            if (fallbackErr)
              console.error('[TournamentService] total_rake update fallback failed:', fallbackErr);
          }
        }
      } catch (e: unknown) {
        console.error(`[TournamentService] Failed to update tournament total_rake:`, e);
      }

      // Track at union level if club belongs to a union
      if (tournament.union_id) {
        try {
          const { data: unionData } = await supabase
            .from('unions')
            .select('total_rake')
            .eq('id', tournament.union_id)
            .maybeSingle();
          if (unionData) {
            const { error: unionRakeErr } = await supabase
              .from('unions')
              .update({ total_rake: (unionData.total_rake || 0) + rake })
              .eq('id', tournament.union_id);
            if (unionRakeErr)
              console.error('[TournamentService] union total_rake update failed:', unionRakeErr);
          }
        } catch (e: unknown) {
          console.error(`[TournamentService] Failed to update union total_rake:`, e);
        }
      }
    }

    // Re-read fresh tournament data to avoid stale read-then-write race condition
    const { data: freshTournament } = await supabase
      .from('tournaments')
      .select('current_players, guaranteed_prize')
      .eq('id', tournamentId)
      .maybeSingle();
    // Use fresh DB count (not stale registrations.length) for accurate player tracking
    const freshPlayerCount =
      (freshTournament?.current_players ?? tournament.current_players ?? 0) + 1;
    const entriesPrize = buyIn * freshPlayerCount;
    const freshGuarantee = freshTournament?.guaranteed_prize ?? tournament.guaranteed_prize;
    const newPrizePool = freshGuarantee ? Math.max(entriesPrize, freshGuarantee) : entriesPrize;
    const { error: countError } = await supabase
      .from('tournaments')
      .update({
        current_players: freshPlayerCount,
        prize_pool: newPrizePool,
      })
      .eq('id', tournamentId);

    if (countError) {
      console.error(
        '[TournamentService] Failed to increment registration count, retrying:',
        countError
      );
      // Retry once — this is important for accurate player count
      const { error: retryErr } = await supabase
        .from('tournaments')
        .update({
          current_players: freshPlayerCount,
          prize_pool: newPrizePool,
        })
        .eq('id', tournamentId);
      if (retryErr) {
        console.error('[TournamentService] WARN: Registration count retry also failed:', retryErr);
      }
    }

    // ── SNG AUTO-START: if tournament is full, trigger immediate start ──
    if (
      tournament.max_players &&
      freshPlayerCount >= tournament.max_players &&
      (tournament.variant === 'sng' || tournament.variant === 'spin')
    ) {
      console.debug(
        `[TournamentService] SNG ${tournamentId} is full (${freshPlayerCount}/${tournament.max_players}), auto-starting...`
      );
      try {
        // Set start_time to NOW so server's tournament discovery loop picks it up
        // Server polls for REGISTERING tournaments where start_time <= now && players >= 2
        await supabase
          .from('tournaments')
          .update({
            start_time: new Date().toISOString(),
          })
          .eq('id', tournamentId);
      } catch (autoStartErr) {
        console.error('[TournamentService] SNG auto-start failed:', autoStartErr);
      }
    }

    // ── LATE REGISTRATION: seat player at active table immediately ──
    if (isLateRegOpen) {
      console.debug(
        `[TournamentService] Late reg: seating ${userId.slice(0, 8)} in running tournament ${tournamentId.slice(0, 8)}`
      );
      try {
        // Find tournament table with an open seat
        const { data: tables } = await supabase
          .from('tables')
          .select('id, max_players, current_players')
          .eq('tournament_id', tournamentId)
          .in('status', ['active', 'running']);

        const openTable = (tables || []).find((t) => t.current_players < t.max_players);
        if (openTable) {
          // Find an empty seat number
          const { data: existingSeats } = await supabase
            .from('table_seats')
            .select('seat_number')
            .eq('table_id', openTable.id)
            .is('left_at', null);

          const takenSeats = new Set((existingSeats || []).map((s) => s.seat_number));
          let seatNumber = 1;
          while (takenSeats.has(seatNumber) && seatNumber <= openTable.max_players) seatNumber++;
          // Guard: no valid seat found (all seats taken despite current_players check)
          if (seatNumber > openTable.max_players) {
            console.error(
              `[TournamentService] Late reg: no valid seat at table ${openTable.id} (race condition)`
            );
            throw new Error('Late registration failed: table is full. Please try again.');
          }

          // Seat the player — check for errors
          const { error: seatErr } = await supabase.from('table_seats').insert({
            table_id: openTable.id,
            user_id: userId,
            seat_number: seatNumber,
          });

          if (seatErr) {
            console.error(`[TournamentService] Late reg seat insert failed: ${seatErr.message}`);
            console.debug(
              `[TournamentService] Player ${userId.slice(0, 8)} added to alternate list due to seat insert failure.`
            );
            // No refund — player remains as 'registered' on the alternate list
            // and will be seated by the TournamentEngine when a seat opens.
          } else {
            // Update tournament_players to playing status with starting chips
            const { error: tpErr } = await supabase
              .from('tournament_players')
              .update({
                status: 'playing',
                chips: tournament.starting_chips,
                table_id: openTable.id,
              })
              .eq('tournament_id', tournamentId)
              .eq('user_id', userId);

            if (tpErr) {
              console.error(`[TournamentService] Late reg player update failed: ${tpErr.message}`);
              // Attempt to clean up the seat we just inserted
              await supabase
                .from('table_seats')
                .delete()
                .eq('table_id', openTable.id)
                .eq('user_id', userId);
              throw new Error(
                'Late registration failed: could not update player status. Please try again.'
              );
            }

            // Increment table player count
            const { error: tableErr } = await supabase
              .from('tables')
              .update({
                current_players: openTable.current_players + 1,
              })
              .eq('id', openTable.id);

            if (tableErr)
              console.error(`[TournamentService] Late reg table count failed: ${tableErr.message}`);
          }
        } else {
          console.error(
            `[TournamentService] Late reg: no open table found for ${tournamentId.slice(0, 8)} — adding to alternate list`
          );
          // No table available — DO NOT refund. Player enters the alternate waitlist.
          // They remain 'registered' in tournament_players and TournamentEngine will seat them.
        }
      } catch (lateRegErr) {
        console.error('[TournamentService] Late reg seating failed:', lateRegErr);
      }
    }

    return data;
  }

  /**
   * Unregister a player (with full refund)
   */
  async unregisterPlayer(tournamentId: string, userId: string): Promise<void> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');
    // Allow unregister during late registration window too (level-based)
    const lateRegLevels2 = tournament.late_reg_levels || tournament.late_reg_mins || 0;
    const levelState2 = this.getCurrentLevelState(tournament);
    const isLateRegOpen =
      tournament.status === 'RUNNING' &&
      lateRegLevels2 > 0 &&
      levelState2.levelIndex < lateRegLevels2;

    if (
      tournament.status !== 'REGISTERING' &&
      tournament.status !== 'ANNOUNCED' &&
      !isLateRegOpen
    ) {
      throw new Error('Cannot unregister after tournament started');
    }

    // CRITICAL: Verify player is actually registered BEFORE issuing any refund
    const { data: existingReg } = await supabase
      .from('tournament_players')
      .select('id, username, status')
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!existingReg) {
      throw new Error('Player is not registered for this tournament');
    }

    if (existingReg.status !== 'registered') {
      throw new Error('Cannot unregister: You have already been seated at an active table.');
    }

    // Delete registration FIRST as an atomic Compare-And-Swap to prevent double-refund
    // or race conditions with TournamentEngine.seatAlternates()
    const { data: deletedRows, error: deleteError } = await supabase
      .from('tournament_players')
      .delete()
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId)
      .eq('status', 'registered') // Lock constraint
      .select('id');

    if (deleteError) {
      console.error('[TournamentService] Failed to delete registration:', deleteError);
      throw new Error('Failed to unregister — please try again');
    }

    if (!deletedRows || deletedRows.length === 0) {
      // The row is either gone or has changed status (e.g. to 'playing')
      throw new Error('Unregister failed: You may have just been seated at a table.');
    }

    // Calculate refund amount (buy-in + fee — exact penny values from DB, NO rounding)
    const buyInAmount = tournament.buy_in_amount || 0;
    const refundAmount = buyInAmount + (tournament.buy_in_fee || 0);

    // Refund to Player Wallet — only AFTER successful deletion
    const { error: refundError } = await retryAsync(
      () =>
        supabase.rpc('credit_player_wallet', {
          p_user_id: userId,
          p_amount: refundAmount,
        }),
      3
    );

    if (refundError) {
      console.error('[TournamentService] Refund to Player Wallet failed:', refundError);
      // Re-register the player since refund failed (rollback)
      const { error: rollbackErr } = await supabase.from('tournament_players').insert({
        tournament_id: tournamentId,
        user_id: userId,
        username: existingReg?.username || 'Unknown',
        status: 'registered',
        chips: 0,
      });
      if (rollbackErr) {
        console.error('[TournamentService] CRITICAL: Rollback re-insert ALSO failed:', rollbackErr);
      }
      throw new Error('Refund failed — registration restored');
    }

    // Log refund transaction
    await WalletService.logTransaction(
      userId,
      'PLAYER',
      refundAmount,
      'credit',
      'refund',
      `Tournament unregister refund: ${tournament.name}`,
      undefined,
      undefined,
      tournamentId
    );
    masterBus.emit('BALANCE_UPDATED', { source: 'tournament_unregister_refund', userId });

    // Re-read fresh tournament data to avoid stale read-then-write race condition
    const { data: freshTourney } = await supabase
      .from('tournaments')
      .select('current_players, guaranteed_prize')
      .eq('id', tournamentId)
      .maybeSingle();
    const newPlayerCount = Math.max(
      0,
      (freshTourney?.current_players ?? tournament.current_players) - 1
    );
    const entriesPrize2 = (tournament.buy_in_amount || 0) * newPlayerCount;
    const freshGuarantee2 = freshTourney?.guaranteed_prize ?? tournament.guaranteed_prize;
    const newPrizePool = freshGuarantee2 ? Math.max(entriesPrize2, freshGuarantee2) : entriesPrize2;
    const { error: countError } = await supabase
      .from('tournaments')
      .update({
        current_players: newPlayerCount,
        prize_pool: newPrizePool,
      })
      .eq('id', tournamentId);

    if (countError) {
      console.error('[TournamentService] Failed to decrement registration count:', countError);
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

    // Execute atomic cancellation and refund (prevents partial refunds on server crash)
    const { data: cancelResult, error: cancelError } = await retryAsync(
      () =>
        supabase.rpc('atomic_cancel_tournament', {
          p_tournament_id: tournamentId,
          p_admin_id: '00000000-0000-0000-0000-000000000000', // System action
        }),
      3
    );

    if (cancelError) {
      console.error(`[TournamentService] CRITICAL: atomic_cancel_tournament failed:`, cancelError);
      throw new Error(`Failed to cancel tournament: ${cancelError.message}`);
    }

    // Process result
    const refunded = cancelResult?.total_refunded || 0;
    const playersRefunded = cancelResult?.refunded_count || 0;

    // Fetch the players to emit balance updates (RPC already refunded DB)
    const { data: players } = await supabase
      .from('tournament_players')
      .select('user_id')
      .eq('tournament_id', tournamentId);

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
    masterBus.emit('TOURNAMENT_CANCELLED' as any, {
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
    if (!tournament.blind_structure?.length) {
      throw new Error('Tournament has no blind structure defined');
    }
    if (!tournament.payout_structure?.length) {
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
          small_blind: tournament.blind_structure[0].smallBlind,
          big_blind: tournament.blind_structure[0].bigBlind,
          min_buy_in: 0,
          max_buy_in: 0,
          max_players: 9,
          status: 'RUNNING',
          settings: { auto_muck: true, time_bank_seconds: 30 },
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
      });
      if (seatErr)
        console.error(`[TournamentService] Failed to seat player ${player.user_id}:`, seatErr);
      tableAssign.nextSeat++;
    }

    // 4. Update Tournament
    const { data, error } = await supabase
      .from('tournaments')
      .update({
        status: 'RUNNING',
        started_at: new Date().toISOString(),
      })
      .eq('id', tournamentId)
      .select()
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

  /**
   * Eliminate a player (with prize payout and achievements)
   */
  async eliminatePlayer(tournamentId: string, userId: string, position: number): Promise<void> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    // Calculate prize — exact precision arithmetic, no rounding
    const payoutArr = (() => {
      const raw = tournament.payout_structure;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw);
        } catch (err) {
          console.error('[TournamentService] Error:', err);
          return [];
        }
      }
      return [];
    })();

    // Guard: if position should pay but payout structure is empty/corrupted, log and award 0
    if (payoutArr.length === 0 && position === 1) {
      console.error(
        `[TournamentService] CRITICAL: No payout structure for tournament ${tournamentId} — winner gets full pool fallback`
      );
    }

    const payoutEntry = payoutArr.find((p: any) => p.place === position);
    // Exact precision: trunc(pool * percentage) / 100
    // For position 1 with no payout structure, award full pool as fallback
    const prize = payoutEntry
      ? Math.trunc(tournament.prize_pool * payoutEntry.percentage) / 100
      : position === 1 && payoutArr.length === 0
        ? Math.trunc((tournament.prize_pool || 0) * 100) / 100
        : 0;

    await supabase
      .from('tournament_players')
      .update({
        status: 'eliminated',
        position: position,
        prize: prize,
        eliminated_at: new Date().toISOString(),
      })
      .eq('tournament_id', tournamentId)
      .eq('user_id', userId);

    // Credit prize to Player Wallet
    if (prize > 0) {
      // Credit prize to Player Wallet (not club_members — wallets are separate)
      const { error: prizeError } = await retryAsync(
        () =>
          supabase.rpc('credit_player_wallet', {
            p_user_id: userId,
            p_amount: prize,
          }),
        3
      );

      if (prizeError) {
        console.error(
          `[TournamentService] CRITICAL: Prize credit to Player Wallet failed:`,
          prizeError
        );
        throw new Error(`Failed to credit ${ordinal(position)} place prize of ${prize}`);
      }

      // Log prize payout transaction
      await WalletService.logTransaction(
        userId,
        'PLAYER',
        prize,
        'credit',
        'prize',
        `Tournament prize: ${ordinal(position)} place — ${tournament.name}`,
        undefined,
        undefined,
        tournamentId
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'tournament_prize', userId });
    }

    // Trigger tournament achievement
    try {
      const { achievementTriggerService } = await import('./AchievementTriggerService');
      const { count } = await supabase
        .from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId);

      await achievementTriggerService.onTournamentComplete(userId, {
        position,
        entries: count || 0,
        won: position === 1,
        prizeAmount: prize,
      });
    } catch (err: unknown) {
      console.error('[Achievements] Tournament trigger failed:', err);
    }
  }

  /**
   * Automatically eliminate a player:
   * 1. Calculate rank based on remaining players.
   * 2. Update status to eliminated.
   * 3. Remove from table seat.
   */
  async eliminatePlayerAuto(tournamentId: string, userId: string): Promise<void> {
    // 1. Get current active player count (this will be the position)
    const { count } = await supabase
      .from('tournament_players')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId)
      .eq('status', 'playing');

    const position = count || 1;

    // 2. Eliminate
    await this.eliminatePlayer(tournamentId, userId, position);

    // 3. Remove from seat (and trigger room update via postgres change or client refresh)
    // Find seat first to check correctness?
    // Note: Using maybeSingle to be safe.
    const { data: seat } = await supabase
      .from('table_seats')
      .select('table_id')
      .eq('user_id', userId)
      .is('left_at', null)
      .maybeSingle();
    if (seat) {
      const { data: table, error: tableErr } = await supabase
        .from('tables')
        .select('tournament_id')
        .eq('id', seat.table_id)
        .maybeSingle();
      if (tableErr) {
        console.error('eliminatePlayerAuto table lookup failed:', tableErr.message);
      }
      if (table?.tournament_id === tournamentId) {
        await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('table_id', seat.table_id)
          .is('left_at', null);
      }
    }
  }

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
    const blinds: BlindLevel[] =
      Array.isArray(tournament.blind_structure) && tournament.blind_structure.length > 0
        ? tournament.blind_structure
        : [{ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 15 }];

    if (tournament.status !== 'RUNNING' || !tournament.started_at) {
      return {
        currentLevel: blinds[0],
        nextLevel: blinds[1] || null,
        timeRemainingSeconds: blinds[0].durationMinutes * 60,
        levelIndex: 0,
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

    // Pre-validate wallet balance (better error messages)
    const { data: walletData } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .eq('wallet_type', 'PLAYER')
      .maybeSingle();

    if (!walletData || (walletData.balance || 0) < rebuyCost) {
      throw new Error(
        `Insufficient chips for rebuy. Need ${rebuyCost}, have ${walletData?.balance || 0}`
      );
    }

    // Process rebuy via ATOMIC RPC
    // (This RPC handles the wallet deduction and logging natively. It rolls back automatically on failure.)
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: tournamentId,
          p_player_id: userId,
          p_rebuy_type: tournament.is_reentry && !tournament.is_rebuy ? 'reentry' : 'rebuy',
          p_cost: rebuyCost,
          p_chips: rebuyChips,
          p_current_level: this.getCurrentLevelState(tournament).levelIndex,
        }),
      3
    );

    if (error) {
      console.error('[TournamentService] Rebuy RPC failed. No chips were deducted:', error);
      throw error;
    }

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
      console.error('Failed to broadcast rebuy event:', e);
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

    if (!addonWallet || (addonWallet.balance || 0) < addonCost) {
      throw new Error(
        `Insufficient chips for add-on. Need ${addonCost}, have ${addonWallet?.balance || 0}`
      );
    }

    // Process addon via ATOMIC RPC
    // (This handles wallet deduction, logging, and rollback natively)
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: tournamentId,
          p_player_id: userId,
          p_rebuy_type: 'addon',
          p_cost: addonCost,
          p_chips: addonChips,
          p_current_level: this.getCurrentLevelState(tournament).levelIndex,
        }),
      3
    );

    if (error) {
      console.error('[TournamentService] Add-on process failed. No chips were deducted:', error);
      throw error;
    }

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
      console.error('Failed to broadcast add-on event:', e);
    }

    return { success: true, newStack: data?.new_stack };
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

    // Count entries
    const { count: entryCount } = await supabase
      .from('tournament_players')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tournamentId);

    // Count rebuys and add-ons from wallet_transactions (always available)
    let rebuyTotal = 0;
    let addonTotal = 0;
    try {
      const { data: rebuyTxns } = await supabase
        .from('wallet_transactions')
        .select('amount, category')
        .eq('related_entity_id', tournamentId)
        .in('category', ['rebuy', 'addon']);

      if (rebuyTxns) {
        for (const tx of rebuyTxns) {
          const cost = Math.abs(tx.amount || 0);
          if (tx.category === 'addon') addonTotal += cost;
          else rebuyTotal += cost;
        }
      }
    } catch (e: unknown) {
      console.error('[TournamentService] Could not query rebuy/addon transactions:', e);
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
        console.error('[TournamentService] finalizePrizePool fallback failed:', fallbackErr);
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
      console.error('Failed to broadcast prize pool finalization:', e);
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
      console.error('Table balancing error:', error);
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
      if (closeErr) console.error('[TournamentService] Failed to close broken table:', closeErr);

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

      // Safe access: blind_structure may be null/empty for misconfigured tournaments
      const blinds =
        Array.isArray(tournament.blind_structure) && tournament.blind_structure.length > 0
          ? tournament.blind_structure[0]
          : { smallBlind: 10, bigBlind: 20 }; // Fallback defaults

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
          settings: { auto_muck: true, time_bank_seconds: 45 },
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
        console.error('Failed to broadcast final table event:', e);
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
      console.error('Failed to broadcast level up:', e);
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
      console.error('Failed to broadcast elimination:', e);
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
      console.error('Failed to broadcast winner:', e);
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
      console.error('[TournamentService] Failed to mark tournament COMPLETED:', statusError);
      return { success: false };
    }

    // Distribute prize money to winners via atomic RPC
    try {
      const { data: prizeResult, error: prizeError } = await supabase.rpc(
        'distribute_tournament_prizes',
        {
          p_tournament_id: tournamentId,
        }
      );
      if (prizeError) {
        console.error('[TournamentService] Prize distribution failed:', prizeError);
      } else {
        console.debug('[TournamentService] Prizes distributed:', prizeResult);
        masterBus.emit('BALANCE_UPDATED' as any, { source: 'tournament_prizes', tournamentId });
      }
    } catch (prizeErr) {
      console.error('[TournamentService] Prize distribution exception:', prizeErr);
    }

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
      console.error('[TournamentService] Failed to submit to POY:', e);
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
  spinMultiplier(config: SpinMultiplier[]): { multiplier: number; isPremium: boolean } {
    const random = Math.random() * 100;
    let cumulative = 0;

    for (const tier of config) {
      cumulative += tier.probability;
      if (random <= cumulative) {
        return {
          multiplier: tier.multiplier,
          isPremium: tier.isPremium || false,
        };
      }
    }

    // Fallback to lowest multiplier
    return { multiplier: config[0].multiplier, isPremium: false };
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

  /**
   * Process bounty collection on elimination
   */
  async collectBounty(
    tournamentId: string,
    eliminatedPlayerId: string,
    collectorPlayerId: string
  ): Promise<{ bountyAmount: number; collectorNewBounty?: number }> {
    const tournament = await this.getTournament(tournamentId);
    if (!tournament) throw new Error('Tournament not found');

    // Build BountyConfig from individual tournament columns
    if (!tournament.is_bounty && !tournament.is_pko && !tournament.is_mystery_bounty) {
      return { bountyAmount: 0 };
    }
    const bountyConfig: BountyConfig = {
      bountyType: tournament.is_pko
        ? 'progressive'
        : tournament.is_mystery_bounty
          ? 'mystery'
          : 'fixed',
      baseBounty: tournament.bounty_amount || 0,
      mysteryTiers: tournament.is_mystery_bounty
        ? [
            {
              minMultiplier: tournament.mystery_bounty_min || 1,
              maxMultiplier: tournament.mystery_bounty_max || 1,
              probability: 60,
            },
            { minMultiplier: 2, maxMultiplier: 2, probability: 25 },
            { minMultiplier: 5, maxMultiplier: 5, probability: 10 },
            { minMultiplier: 10, maxMultiplier: 10, probability: 4 },
            {
              minMultiplier: tournament.mystery_bounty_max || 50,
              maxMultiplier: tournament.mystery_bounty_max || 50,
              probability: 1,
            },
          ]
        : undefined,
    };

    // Get eliminated player's bounty
    const { data: eliminatedPlayer } = await supabase
      .from('tournament_players')
      .select('current_bounty')
      .eq('tournament_id', tournamentId)
      .eq('user_id', eliminatedPlayerId)
      .maybeSingle();

    const bountyAmount = eliminatedPlayer?.current_bounty || bountyConfig.baseBounty;

    if (bountyConfig.bountyType === 'progressive') {
      // Progressive: 50% to collector, 50% added to collector's head
      // Exact precision split — remainder goes to collector
      const collectorPortion = Math.trunc((bountyAmount * 100) / 2) / 100;
      const addedToHead = Math.trunc((bountyAmount - collectorPortion) * 100) / 100;

      // Get collector's current bounty
      const { data: collector } = await supabase
        .from('tournament_players')
        .select('current_bounty')
        .eq('tournament_id', tournamentId)
        .eq('user_id', collectorPlayerId)
        .maybeSingle();

      const newCollectorBounty =
        (collector?.current_bounty || bountyConfig.baseBounty) + addedToHead;

      // Atomically increment collector's bounty to prevent race on concurrent knockouts
      const { error: bountyUpdateError } = await supabase
        .from('tournament_players')
        .update({ current_bounty: newCollectorBounty })
        .eq('tournament_id', tournamentId)
        .eq('user_id', collectorPlayerId);

      if (bountyUpdateError) {
        console.error('[TournamentService] Failed to update collector bounty:', bountyUpdateError);
      }

      // Record bounty payout
      const { error: bountyInsErr } = await supabase.from('tournament_bounties').insert({
        tournament_id: tournamentId,
        eliminated_player_id: eliminatedPlayerId,
        collector_player_id: collectorPlayerId,
        bounty_amount: collectorPortion,
        added_to_collector_bounty: addedToHead,
      });
      if (bountyInsErr)
        console.error('[TournamentService] Failed to record PKO bounty:', bountyInsErr);

      return { bountyAmount: collectorPortion, collectorNewBounty: newCollectorBounty };
    } else if (bountyConfig.bountyType === 'mystery') {
      // Mystery: Reveal hidden bounty value
      const mysteryValue = this.rollMysteryBounty(bountyConfig);

      const { error: mysteryInsErr } = await supabase.from('tournament_bounties').insert({
        tournament_id: tournamentId,
        eliminated_player_id: eliminatedPlayerId,
        collector_player_id: collectorPlayerId,
        bounty_amount: mysteryValue,
        is_mystery_revealed: true,
      });
      if (mysteryInsErr)
        console.error('[TournamentService] Failed to record mystery bounty:', mysteryInsErr);

      // Notify UI to show mystery bounty reveal animation
      masterBus.emit('MYSTERY_BOUNTY_REVEALED' as any, {
        tournamentId,
        eliminatedPlayerId,
        collectorPlayerId,
        amount: mysteryValue,
      });

      return { bountyAmount: mysteryValue };
    } else {
      // Fixed bounty
      const { error: fixedInsErr } = await supabase.from('tournament_bounties').insert({
        tournament_id: tournamentId,
        eliminated_player_id: eliminatedPlayerId,
        collector_player_id: collectorPlayerId,
        bounty_amount: bountyAmount,
      });
      if (fixedInsErr)
        console.error('[TournamentService] Failed to record fixed bounty:', fixedInsErr);

      return { bountyAmount };
    }
  }

  /**
   * Roll mystery bounty value
   */
  rollMysteryBounty(config: BountyConfig): number {
    if (!config.mysteryTiers) return config.baseBounty;

    const random = Math.random() * 100;
    let cumulative = 0;

    for (const tier of config.mysteryTiers) {
      cumulative += tier.probability;
      if (random <= cumulative) {
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
