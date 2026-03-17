/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🐴 HYDRA SERVICE — Horse Liquidity Fleet Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the Hydra horse fleet (300 Horses #101-#400) to ensure 24/7 table liquidity.
 *
 * LAWS:
 * - "3 Horses to Start": Tables seed with 3 horse players
 * - "Organic Recede": When real player joins, 1 horse leaves after orbit
 * - "Fleet Size": 300 unique sovereign horse IDs (#101-#400)
 * - "Entry Variance": Random 10-90s delays for natural appearance
 * - "Invisible Fleet": Horses are indistinguishable from human players
 *
 * HORSE STYLES (ALL winning players — losses come from variance, not mistakes):
 * - TAG: Tight-Aggressive, solid ABC poker (30% of fleet)
 * - BALANCED: GTO-oriented, mixed strategies (25% of fleet)
 * - LAG: Loose-Aggressive, wide ranges, creative (20% of fleet)
 * - TRICKY: Deceptive, slowplays, check-raises (15% of fleet)
 * - GRINDER: Disciplined small ball, pot control (10% of fleet)
 *
 * NOTE: Decision logic now handled by HorseLogic.ts (upgraded brain)
 * HydraService retains fleet management, seating, and lifecycle only.
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type HorseProfile = 'fish' | 'reg' | 'nit' | 'lag' | 'maniac';
export type HorseStatus = 'available' | 'seated' | 'leaving' | 'disabled';

export interface HorsePlayer {
  id: string;
  name: string;
  playerNumber: number;
  avatar: string;
  profile: HorseProfile;
  stack: number;
  seatNumber: number;
  status: HorseStatus;
  tableId: string;
  joinedAt: string;
  leavingAfterOrbit: boolean;
  handsPlayed: number;
  orbitsPlayed: number;
}

export interface HydraConfig {
  maxHorsesPerTable: number;
  minHorsesPerTable: number;
  fleetSize: number;
  entryDelayRange: [number, number]; // [min, max] in seconds
  organicRecedeEnabled: boolean;
  seatWarmupDelay: number; // ms before horse starts playing
  thinkTimeRange: [number, number]; // [min, max] in ms for action delay
}

export interface TableLiquidityStatus {
  tableId: string;
  realPlayers: number;
  horsePlayers: number;
  availableSeats: number;
  needsMoreHorses: boolean;
  needsFewerHorses: boolean;
}

// HorseDecision is defined in HorseLogic.ts — use that canonical version
import type { HorseDecision } from '../engine/HorseLogic';
import { retryAsync } from '../utils/retryAsync';
export type { HorseDecision } from '../engine/HorseLogic';

export interface HandContext {
  pot: number;
  toCall: number;
  minRaise: number;
  maxRaise: number;
  position: 'early' | 'middle' | 'late' | 'blind';
  street: 'preflop' | 'flop' | 'turn' | 'river';
  playersInHand: number;
  stackToPotRatio: number;
  isHeadsUp: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: HydraConfig = {
  maxHorsesPerTable: 3,
  minHorsesPerTable: 0,
  fleetSize: 308,
  entryDelayRange: [10, 90],
  organicRecedeEnabled: true,
  seatWarmupDelay: 2000,
  thinkTimeRange: [800, 4000],
};

// Profile action weights (probabilities)
// TUNED for 3-player shorthanded: lower fold rates, more action
const PROFILE_WEIGHTS: Record<
  HorseProfile,
  {
    fold: number;
    check: number;
    call: number;
    bet: number;
    raise: number;
    all_in: number;
  }
> = {
  fish: { fold: 8, check: 15, call: 40, bet: 20, raise: 15, all_in: 2 },
  reg: { fold: 18, check: 20, call: 25, bet: 20, raise: 15, all_in: 2 },
  nit: { fold: 30, check: 25, call: 25, bet: 10, raise: 8, all_in: 2 },
  lag: { fold: 10, check: 10, call: 15, bet: 30, raise: 30, all_in: 5 },
  maniac: { fold: 5, check: 5, call: 10, bet: 35, raise: 35, all_in: 10 },
};

// Stack size ranges per profile (in BB)
const PROFILE_STACK_RANGES: Record<HorseProfile, [number, number]> = {
  fish: [50, 100],
  reg: [80, 150],
  nit: [100, 100],
  lag: [100, 200],
  maniac: [150, 300],
};

// Preflop hand ranges (simplified)
const PREFLOP_RANGES: Record<
  HorseProfile,
  {
    vpip: number; // Voluntarily Put $ In Pot percentage
    pfr: number; // Pre-Flop Raise percentage
    threeBet: number; // 3-bet percentage
  }
> = {
  fish: { vpip: 45, pfr: 10, threeBet: 3 },
  reg: { vpip: 22, pfr: 18, threeBet: 8 },
  nit: { vpip: 12, pfr: 10, threeBet: 5 },
  lag: { vpip: 32, pfr: 28, threeBet: 12 },
  maniac: { vpip: 55, pfr: 40, threeBet: 18 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getStackForProfile(profile: HorseProfile, bigBlind: number): number {
  const [minBB, maxBB] = PROFILE_STACK_RANGES[profile] || PROFILE_STACK_RANGES['reg'];
  const bbCount = randomInRange(minBB, maxBB);
  return bbCount * bigBlind;
}

function weightedRandom<T extends string>(weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let random = Math.random() * total;

  for (const [key, weight] of entries) {
    random -= weight;
    if (random <= 0) return key;
  }

  return entries[0][0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const HydraService = {
  config: { ...DEFAULT_CONFIG },

  /**
   * Initialize Hydra with custom config
   */
  initialize(customConfig: Partial<HydraConfig> = {}): void {
    this.config = { ...DEFAULT_CONFIG, ...customConfig };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // HORSE FLEET MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get available horses from the fleet (not currently seated)
   */
  async getAvailableHorses(count: number = 3, profile?: HorseProfile): Promise<HorsePlayer[]> {
    // Direct query instead of RPC (get_available_horses RPC doesn't exist in Supabase)
    let query = supabase
      .from('profiles')
      .select('id, display_name, username, player_number, avatar_url, horse_profile, horse_status')
      .eq('is_horse', true)
      .eq('horse_status', 'available')
      .limit(count);

    if (profile) {
      query = query.eq('horse_profile', profile);
    }

    const { data, error } = await query;

    if (error) {
      console.error('HydraService.getAvailableHorses error:', error);
      return [];
    }

    return (data || []).map((h: any) => ({
      id: h.id,
      name: h.display_name || h.username || `Player ${h.player_number || ''}`,
      playerNumber: h.player_number,
      avatar: h.avatar_url,
      profile: h.horse_profile as HorseProfile,
      stack: 0,
      seatNumber: 0,
      status: 'available' as HorseStatus,
      tableId: '',
      joinedAt: '',
      leavingAfterOrbit: false,
      handsPlayed: 0,
      orbitsPlayed: 0,
    }));
  },

  /**
   * Get active horses at a table
   */
  async getActiveHorses(tableId: string): Promise<HorsePlayer[]> {
    // Step 1: Get all active seats at this table (exclude departed players)
    const { data: seatData, error: seatError } = await supabase
      .from('table_seats')
      .select('user_id, seat_number, stack, joined_at')
      .eq('table_id', tableId)
      .is('left_at', null);

    if (seatError || !seatData?.length) {
      if (seatError) console.error('HydraService.getActiveHorses seat query error:', seatError);
      return [];
    }

    const userIds = seatData.map((s) => s.user_id).filter(Boolean);
    if (!userIds.length) return [];

    // Step 2: Check which of these users are horses
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select(
        'id, display_name, username, player_number, avatar_url, is_horse, horse_profile, horse_status'
      )
      .in('id', userIds)
      .eq('is_horse', true);

    if (profileError) {
      // If horse columns don't exist yet, silently return empty
      console.error('HydraService.getActiveHorses profile query error:', profileError);
      return [];
    }

    if (!profileData?.length) return [];

    const profileMap = new Map(profileData.map((p) => [p.id, p]));

    return seatData
      .filter((seat) => profileMap.has(seat.user_id))
      .map((seat) => {
        const profile = profileMap.get(seat.user_id)!;
        return {
          id: profile.id,
          name: profile.display_name || profile.username || `Player ${seat.seat_number}`,
          playerNumber: profile.player_number,
          avatar: profile.avatar_url || '',
          profile: (profile.horse_profile || 'reg') as HorseProfile,
          stack: seat.stack,
          seatNumber: seat.seat_number,
          status: (profile.horse_status || 'seated') as HorseStatus,
          tableId,
          joinedAt: seat.joined_at,
          leavingAfterOrbit: profile.horse_status === 'leaving',
          handsPlayed: 0,
          orbitsPlayed: 0,
        };
      });
  },

  /**
   * Assess table liquidity status
   */
  async getTableLiquidityStatus(tableId: string): Promise<TableLiquidityStatus> {
    const horses = await this.getActiveHorses(tableId);

    // Get table max_players for accurate seat count
    const { data: tableInfo, error: tableInfoErr } = await supabase
      .from('tables')
      .select('max_players')
      .eq('id', tableId)
      .maybeSingle();
    if (tableInfoErr)
      console.warn('[Hydra] getTableLiquidityStatus tableInfo error:', tableInfoErr.message);
    const maxPlayers = tableInfo?.max_players || 9;

    // Simple seat count query — only active seats
    const { data: seats, error } = await supabase
      .from('table_seats')
      .select('user_id')
      .eq('table_id', tableId)
      .is('left_at', null);

    if (error) {
      console.error('HydraService.getTableLiquidityStatus error:', error);
      return {
        tableId,
        realPlayers: 0,
        horsePlayers: horses.length,
        availableSeats: maxPlayers,
        needsMoreHorses: true,
        needsFewerHorses: false,
      };
    }

    const totalPlayers = seats?.length || 0;
    const horsePlayers = horses.length;
    const realPlayers = totalPlayers - horsePlayers;
    const availableSeats = maxPlayers - totalPlayers;

    return {
      tableId,
      realPlayers,
      horsePlayers,
      availableSeats,
      needsMoreHorses: horsePlayers < this.config.maxHorsesPerTable && realPlayers < 3,
      needsFewerHorses: realPlayers >= 3 && horsePlayers > 0,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TABLE SEEDING & RECEDING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Seed a table with horse players (3 Horses to Start law)
   */
  async seedTable(tableId: string, bigBlind: number = 2): Promise<HorsePlayer[]> {
    const status = await this.getTableLiquidityStatus(tableId);
    const horsesToAdd = this.config.maxHorsesPerTable - status.horsePlayers;

    if (horsesToAdd <= 0) {
      return [];
    }

    const availableHorses = await this.getAvailableHorses(horsesToAdd);
    const seatedHorses: HorsePlayer[] = [];

    // Use Promise-based delays instead of setTimeout so we can await all results
    const seatPromises = [];
    for (let i = 0; i < Math.min(horsesToAdd, availableHorses.length); i++) {
      const horse = availableHorses[i];
      const delay =
        randomInRange(this.config.entryDelayRange[0], this.config.entryDelayRange[1]) * 1000; // Convert seconds to ms

      // Stagger entries for natural appearance
      const promise = new Promise<void>((resolve) => {
        setTimeout(
          async () => {
            try {
              const seatedHorse = await this.seatHorse(horse.id, tableId, bigBlind);
              if (seatedHorse) {
                seatedHorses.push(seatedHorse);
              }
            } catch (err: unknown) {
              console.error(`Failed to seat horse ${horse.id}:`, err);
            }
            resolve();
          },
          delay * (i + 1)
        );
      });
      seatPromises.push(promise);
    }

    // Wait for all staggered seats to complete
    await Promise.all(seatPromises);
    return seatedHorses;
  },

  /**
   * Seat a specific horse at a table
   */
  async seatHorse(horseId: string, tableId: string, bigBlind: number): Promise<HorsePlayer | null> {
    // Get horse info
    const { data: horseData, error: horseErr } = await supabase
      .from('profiles')
      .select('id, display_name, player_number, avatar_url, horse_profile')
      .eq('id', horseId)
      .eq('is_horse', true)
      .maybeSingle();
    if (horseErr) console.warn('[Hydra] seatHorse profile error:', horseErr.message);

    if (!horseData) return null;

    const stack = getStackForProfile(horseData.horse_profile as HorseProfile, bigBlind);

    // Find an available seat at the table (only count active seats, not left players)
    const { data: existingSeats, error: seatsErr } = await supabase
      .from('table_seats')
      .select('seat_number')
      .eq('table_id', tableId)
      .is('left_at', null);
    if (seatsErr) console.warn('[Hydra] seatHorse seats error:', seatsErr.message);

    const takenSeats = new Set((existingSeats || []).map((s) => s.seat_number));

    // Get table max_players to know seat range
    const { data: tableData, error: tableErr } = await supabase
      .from('tables')
      .select('max_players')
      .eq('id', tableId)
      .maybeSingle();
    if (tableErr) console.warn('[Hydra] seatHorse table error:', tableErr.message);

    const maxSeats = tableData?.max_players || 9;
    let availableSeat = 0;
    for (let s = 1; s <= maxSeats; s++) {
      if (!takenSeats.has(s)) {
        availableSeat = s;
        break;
      }
    }

    if (availableSeat === 0) {
      console.error('HydraService.seatHorse: No available seats at table', tableId);
      return null;
    }

    // Execute FULLY ATOMIC buy-in and seat insertion for Horse
    const { error: rpcErr } = await retryAsync(
      () =>
        supabase.rpc('atomic_table_buyin', {
          p_user_id: horseId,
          p_table_id: tableId,
          p_seat_number: availableSeat,
          p_amount: stack,
          p_auto_rebuy: true, // Horses auto-rebuy by default
        }),
      3
    );

    if (rpcErr) {
      console.error(
        `[HydraService] atomic_table_buyin FAILED for horse ${horseId}:`,
        rpcErr.message
      );
      return null;
    }

    console.debug(
      `[HydraService] atomic_table_buyin SUCCESS for horse ${horseId} at seat ${availableSeat}`
    );

    // Log buy-in transaction via centralized WalletService RPC
    await WalletService.logTransaction(
      horseId,
      'PLAYER',
      stack,
      'debit',
      'buyin',
      `Horse buy-in ${stack} chips at ${bigBlind}BB table`,
      tableId
    );
    masterBus.emit('BALANCE_UPDATED', { source: 'hydra_seat_horse', userId: horseId });

    // Try to log in chip_transactions for club accounting (non-blocking)
    const { data: tableClubData, error: clubErr1 } = await supabase
      .from('tables')
      .select('club_id')
      .eq('id', tableId)
      .maybeSingle();
    if (clubErr1) console.warn('[Hydra] seatHorse club lookup error:', clubErr1.message);

    if (tableClubData?.club_id) {
      // Fire and forget: logging
      supabase
        .from('chip_transactions')
        .insert({
          club_id: tableClubData.club_id,
          to_user_id: horseId,
          amount: stack,
          transaction_type: 'buy_in',
          notes: `Horse buy-in at table ${tableId}`,
        })
        .then(({ error }) => {
          if (error)
            console.error('[Hydra] chip_transactions insert (buy_in) failed:', error.message);
        });
    }

    // Update horse status to seated
    const { error: statusErr1 } = await supabase
      .from('profiles')
      .update({ horse_status: 'seated' })
      .eq('id', horseId);
    if (statusErr1) console.warn('[Hydra] seatHorse status update error:', statusErr1.message);

    return {
      id: horseData.id,
      name: horseData.display_name,
      playerNumber: horseData.player_number,
      avatar: horseData.avatar_url,
      profile: horseData.horse_profile as HorseProfile,
      stack,
      seatNumber: availableSeat,
      status: 'seated',
      tableId,
      joinedAt: new Date().toISOString(),
      leavingAfterOrbit: false,
      handsPlayed: 0,
      orbitsPlayed: 0,
    };
  },

  /**
   * Schedule horse for removal (Organic Recede law)
   */
  async scheduleHorseRemoval(
    tableId: string,
    horseId: string,
    _triggeredBy?: string
  ): Promise<void> {
    const horses = await this.getActiveHorses(tableId);
    const horse = horses.find((h) => h.id === horseId);

    if (!horse) {
      console.error('Horse not found for removal:', horseId);
      return;
    }

    // Mark horse as leaving
    const { error: leaveErr } = await supabase
      .from('profiles')
      .update({ horse_status: 'leaving' })
      .eq('id', horseId);
    if (leaveErr)
      console.warn('[Hydra] scheduleHorseRemoval status update error:', leaveErr.message);
  },

  /**
   * Remove a horse from table — cash out remaining stack back to wallet
   */
  async removeHorse(tableId: string, horseId: string): Promise<boolean> {
    // 1. Get the horse's current stack BEFORE removing the seat
    const { data: seatData, error: seatFetchErr } = await supabase
      .from('table_seats')
      .select('stack, seat_number')
      .eq('table_id', tableId)
      .eq('user_id', horseId)
      .is('left_at', null)
      .maybeSingle();

    if (seatFetchErr || !seatData) {
      console.error(
        `HydraService.removeHorse: Seat not found for horse ${horseId} at table ${tableId}`
      );
      return false;
    }

    const remainingStack = seatData.stack || 0;

    // 2. ATOMIC CASH-OUT: Return chips to Player Wallet and clear seat
    const { data: rpcAmount, error: cashoutError } = await retryAsync(
      () =>
        supabase.rpc('atomic_table_cashout', {
          p_table_id: tableId,
          p_user_id: horseId,
        }),
      3
    );

    if (cashoutError) {
      console.error('HydraService.removeHorse atomic_table_cashout error:', cashoutError.message);
      return false;
    }

    const returnedChips = rpcAmount || 0;

    // Log cash-out transaction via centralized WalletService RPC if there were chips returned
    if (returnedChips > 0) {
      console.debug(
        `[HydraService] Credited ${returnedChips} chips to horse ${horseId} Player Wallet`
      );

      await WalletService.logTransaction(
        horseId,
        'PLAYER',
        returnedChips,
        'credit',
        'cashout',
        `Horse cash-out ${returnedChips} chips from table`,
        tableId
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'hydra_remove_horse', userId: horseId });

      // Try to log in chip_transactions for club accounting
      const { data: tableClubData, error: clubErr2 } = await supabase
        .from('tables')
        .select('club_id')
        .eq('id', tableId)
        .maybeSingle();
      if (clubErr2) console.warn('[Hydra] removeHorse club lookup error:', clubErr2.message);

      if (tableClubData?.club_id) {
        // Fire and forget: logging
        supabase
          .from('chip_transactions')
          .insert({
            club_id: tableClubData.club_id,
            from_user_id: horseId,
            amount: returnedChips,
            transaction_type: 'cashout',
            notes: `Horse cash-out from table ${tableId}`,
          })
          .then(({ error }) => {
            if (error)
              console.error('[Hydra] chip_transactions insert (cashout) failed:', error.message);
          });
      }
    }

    // 4. Set horse back to available
    const { error: statusErr2 } = await supabase
      .from('profiles')
      .update({ horse_status: 'available' })
      .eq('id', horseId);
    if (statusErr2) console.warn('[Hydra] removeHorse status update error:', statusErr2.message);

    return true;
  },

  /**
   * Handle real player joining (trigger organic recede)
   */
  async onRealPlayerJoined(tableId: string, playerId: string): Promise<void> {
    if (!this.config.organicRecedeEnabled) return;

    const status = await this.getTableLiquidityStatus(tableId);

    // If we have horses and enough real players, schedule one to leave
    if (status.needsFewerHorses && status.horsePlayers > 0) {
      const horses = await this.getActiveHorses(tableId);

      // Sort by joinedAt descending (most recent first) and remove the most recently joined horse
      const sortedHorses = [...horses].sort(
        (a, b) => new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime()
      );
      const horseToRemove = sortedHorses.find((h) => !h.leavingAfterOrbit);

      if (horseToRemove) {
        await this.scheduleHorseRemoval(tableId, horseToRemove.id, playerId);
      }
    }
  },

  /**
   * Handle real player leaving (potentially reseed)
   */
  async onRealPlayerLeft(tableId: string, bigBlind: number): Promise<void> {
    const status = await this.getTableLiquidityStatus(tableId);

    if (status.needsMoreHorses) {
      const delay =
        randomInRange(this.config.entryDelayRange[0], this.config.entryDelayRange[1]) * 1000; // Convert seconds to milliseconds

      setTimeout(() => {
        this.seedTable(tableId, bigBlind).catch((err) => {
          console.error(`[HydraService] Failed to reseed table ${tableId} after player left:`, err);
        });
      }, delay);
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // HORSE DECISION MAKING (Poker AI)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get action decision for a horse
   */
  getDecision(horse: HorsePlayer, context: HandContext): HorseDecision {
    const weights = this.getAdjustedWeights(horse.profile, context);
    const baseAction = weightedRandom(weights);

    // Calculate think time (varies by profile and situation)
    const [minThink, maxThink] = this.config.thinkTimeRange;
    let thinkTime = randomInRange(minThink, maxThink);

    // Adjust think time based on situation
    if (context.isHeadsUp) thinkTime *= 0.7; // Faster heads up
    if (context.street === 'river') thinkTime *= 1.3; // Slower on river
    if (horse.profile === 'maniac') thinkTime *= 0.6; // Maniacs act fast
    if (horse.profile === 'nit') thinkTime *= 1.2; // Nits take time

    // Determine final action and amount
    let action = baseAction as HorseDecision['action'];
    let amount: number | undefined;

    // Convert bet/raise to specific amounts
    if (action === 'bet' || action === 'raise') {
      amount = this.getBetSize(horse.profile, context);

      // Check if we should just go all-in
      if (amount >= horse.stack * 0.9) {
        action = 'all_in';
        amount = horse.stack;
      }
    }

    // Handle invalid actions
    if (action === 'check' && context.toCall > 0) {
      action = weightedRandom({ fold: 50, call: 50 }) as 'fold' | 'call';
    }
    if (action === 'bet' && context.toCall > 0) {
      action = 'raise';
    }
    if (action === 'call') {
      amount = context.toCall;
    }

    return { action, amount, thinkTime: Math.round(thinkTime) };
  },

  /**
   * Adjust action weights based on context
   */
  getAdjustedWeights(profile: HorseProfile, context: HandContext): Record<string, number> {
    const weights = PROFILE_WEIGHTS[profile] || PROFILE_WEIGHTS['reg'];
    const base: Record<string, number> = { ...weights };

    // Positional adjustments
    if (context.position === 'late') {
      base.raise *= 1.3;
      base.bet *= 1.2;
      base.fold *= 0.8;
    } else if (context.position === 'early') {
      base.fold *= 1.2;
      base.raise *= 0.8;
    }

    // Street adjustments
    if (context.street === 'preflop') {
      base.call *= 1.2;
    } else if (context.street === 'river') {
      base.bet *= 1.1;
      base.raise *= 1.2;
    }

    // Pot odds adjustments
    if (context.stackToPotRatio < 3) {
      base.all_in = (base.all_in || 0) + 15;
      base.raise *= 1.3;
    }

    // Heads up adjustments
    if (context.isHeadsUp) {
      base.fold *= 0.7;
      base.raise *= 1.2;
      base.bet *= 1.2;
    }

    return base;
  },

  /**
   * Calculate bet sizing for a horse
   */
  getBetSize(profile: HorseProfile, context: HandContext): number {
    const pot = context.pot || 0;
    const minRaise = context.minRaise || 1;
    const maxRaise = context.maxRaise || pot * 2 || 100;

    const sizingFactors: Record<HorseProfile, [number, number]> = {
      fish: [0.3, 1.0], // Small to pot
      reg: [0.5, 0.75], // Standard sizing
      nit: [0.5, 0.65], // Conservative
      lag: [0.75, 1.5], // Overbet capable
      maniac: [1.0, 2.0], // Big overbets
    };

    const [minFactor, maxFactor] = sizingFactors[profile] || sizingFactors['reg'];
    const targetSize = pot * (minFactor + Math.random() * (maxFactor - minFactor));

    // Exact penny precision — no rounding on monetary values
    const precise = Math.trunc(targetSize * 100) / 100;
    return Math.max(minRaise, Math.min(maxRaise, precise));
  },

  /**
   * Determine if horse should enter pot preflop
   */
  shouldEnterPot(profile: HorseProfile, position: string): boolean {
    const ranges = PREFLOP_RANGES[profile] || PREFLOP_RANGES['reg'];
    const roll = Math.random() * 100;

    // Positional adjustment
    let vpipAdjustment = 0;
    if (position === 'late') vpipAdjustment = 10;
    if (position === 'blind') vpipAdjustment = 5;
    if (position === 'early') vpipAdjustment = -5;

    return roll < ranges.vpip + vpipAdjustment;
  },

  /**
   * Get action weights (for external use)
   */
  getActionWeights(profile: HorseProfile): typeof PROFILE_WEIGHTS.fish {
    return PROFILE_WEIGHTS[profile] || PROFILE_WEIGHTS['reg'];
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // STATISTICS & MONITORING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get fleet statistics
   */
  async getFleetStats(): Promise<{
    totalHorses: number;
    available: number;
    seated: number;
    leaving: number;
    byProfile: Record<HorseProfile, number>;
  }> {
    const { data, error } = await supabase
      .from('profiles')
      .select('horse_status, horse_profile')
      .eq('is_horse', true);

    if (error) {
      console.error('HydraService.getFleetStats error:', error);
      return {
        totalHorses: 0,
        available: 0,
        seated: 0,
        leaving: 0,
        byProfile: { fish: 0, reg: 0, nit: 0, lag: 0, maniac: 0 },
      };
    }

    const stats = {
      totalHorses: data.length,
      available: data.filter((h) => h.horse_status === 'available').length,
      seated: data.filter((h) => h.horse_status === 'seated').length,
      leaving: data.filter((h) => h.horse_status === 'leaving').length,
      byProfile: {
        fish: data.filter((h) => h.horse_profile === 'fish').length,
        reg: data.filter((h) => h.horse_profile === 'reg').length,
        nit: data.filter((h) => h.horse_profile === 'nit').length,
        lag: data.filter((h) => h.horse_profile === 'lag').length,
        maniac: data.filter((h) => h.horse_profile === 'maniac').length,
      },
    };

    return stats;
  },
};

export default HydraService;
