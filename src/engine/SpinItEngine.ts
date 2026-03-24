/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN-IT ENGINE — 3-Player Lottery SNG
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages Spin & Go style sit-n-go tournaments:
 * - 3-player hyper-turbo format
 * - Random prize pool multiplier spin (2x → 100x)
 * - Automated blind structure (hyper levels)
 * - Bus emissions for all lifecycle events
 *
 * Flow:
 *   1. Three players join → lobby locks
 *   2. Prize wheel spins → multiplier determined
 *   3. Cards dealt → hyper-turbo blind structure
 *   4. Winner takes all (or split for large multipliers)
 */

import { masterBus } from '../core/MasterBus';
import { HeadlessTableEngine } from './HeadlessTableEngine';
import { supabase } from '../lib/supabase';
import { secureRandom } from './CryptoRandom';
import {
  SPIN_BLIND_STRUCTURE,
  SPIN_BONUS_TIERS,
  SPIN_RAKE_PERCENT,
  SPIN_POOL_CONTRIBUTION_MULTIPLIER,
  SPIN_POOL_MAX_NEGATIVE,
} from '../services/TournamentService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SpinMultiplier = 2 | 3 | 5 | 10 | 25 | 50 | 100;

export interface SpinPrizeConfig {
  multiplier: SpinMultiplier;
  weight: number; // Probability weight (higher = more common)
  label: string;
  color: string;
}

export interface SpinItConfig {
  buyIn: number;
  rake: number; // % taken as rake (e.g., 0.05 = 5%)
  startingStack: number;
  maxPlayers: 3;
  blindLevels: BlindLevel[];
}

export interface BlindLevel {
  small: number;
  big: number;
  durationSeconds: number;
}

export type SpinItStatus =
  | 'waiting' // Less than 3 players
  | 'spinning' // Wheel is spinning
  | 'playing' // Game in progress
  | 'headsup' // Down to 2 players
  | 'finished'; // Winner determined

export interface SpinItState {
  id: string;
  status: SpinItStatus;
  players: string[];
  multiplier: SpinMultiplier | null;
  prizePool: number;
  currentLevel: number;
  levelTimer: number; // Seconds remaining in current level
  winnerId: string | null;
  payouts: Map<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRIZE WHEEL CONFIGURATION (Pool-Based Economics)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Economics:
//   3 players pay buy_in + 10% fee each.
//   Club keeps: 3 × fee (10% rake) — always profitable.
//   Default payout: winner gets 2 × buy_in, 1 × buy_in goes to pool.
//   Bonus payout: winner gets 2 × buy_in + bonus from pool (capped at balance).
//

// Visual prize tiers for the wheel UI — maps to SPIN_BONUS_TIERS probabilities
const PRIZE_TIERS: SpinPrizeConfig[] = SPIN_BONUS_TIERS.standard.map((tier) => ({
  multiplier: tier.displayMultiplier as SpinMultiplier,
  weight: Math.round(tier.probability * 10), // Convert % to weight
  label: `${tier.displayMultiplier}x`,
  color:
    tier.displayMultiplier === 2 ? '#6B7280' :
    tier.displayMultiplier === 3 ? '#3B82F6' :
    tier.displayMultiplier === 5 ? '#10B981' :
    tier.displayMultiplier === 10 ? '#F59E0B' :
    tier.displayMultiplier === 25 ? '#EF4444' :
    tier.displayMultiplier === 50 ? '#8B5CF6' :
    '#FFD700',
}));

// Convert SPIN_BLIND_STRUCTURE from TournamentService to this engine's format
const DEFAULT_BLIND_LEVELS: BlindLevel[] = SPIN_BLIND_STRUCTURE.map((level) => ({
  small: level.smallBlind,
  big: level.bigBlind,
  durationSeconds: level.durationMinutes * 60,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// SPIN-IT ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class SpinItEngineClass {
  private games: Map<string, SpinItState> = new Map();
  private configs: Map<string, SpinItConfig> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private dealingEngines: Map<string, HeadlessTableEngine> = new Map();

  /**
   * Create a new Spin-It lobby
   */
  createLobby(lobbyId: string, config?: Partial<SpinItConfig>): SpinItState {
    const fullConfig: SpinItConfig = {
      buyIn: config?.buyIn ?? 500,
      rake: config?.rake ?? 0.05,
      startingStack: config?.startingStack ?? 500,
      maxPlayers: 3,
      blindLevels: config?.blindLevels ?? DEFAULT_BLIND_LEVELS,
    };

    const state: SpinItState = {
      id: lobbyId,
      status: 'waiting',
      players: [],
      multiplier: null,
      prizePool: 0,
      currentLevel: 0,
      levelTimer: fullConfig.blindLevels[0].durationSeconds,
      winnerId: null,
      payouts: new Map(),
    };

    this.configs.set(lobbyId, fullConfig);
    this.games.set(lobbyId, state);

    masterBus.emit('GAME_CREATED', { type: 'spin-it', lobbyId });
    return state;
  }

  /**
   * Player joins the lobby (max 3)
   */
  joinLobby(lobbyId: string, playerId: string): boolean {
    const state = this.games.get(lobbyId);
    if (!state || state.status !== 'waiting') return false;
    if (state.players.length >= 3) return false;
    if (state.players.includes(playerId)) return false;

    state.players.push(playerId);

    masterBus.emit('PLAYER_JOINED', { lobbyId, playerId, count: state.players.length });

    // Auto-start when 3 players are seated
    if (state.players.length === 3) {
      this.startSpin(lobbyId);
    }

    return true;
  }

  /**
   * Spin the prize wheel — weighted random selection with pool-based economics.
   *
   * Default (75% of spins): winner gets 2× buy_in. 1× buy_in saved to pool.
   * Bonus (25% of spins): winner gets 2× buy_in + bonus from pool (capped).
   */
  private async startSpin(lobbyId: string): Promise<void> {
    const state = this.games.get(lobbyId);
    const config = this.configs.get(lobbyId);
    if (!state || !config) return;

    state.status = 'spinning';

    // Weighted random selection using crypto-safe RNG
    const totalWeight = PRIZE_TIERS.reduce((sum, t) => sum + t.weight, 0);
    let roll = secureRandom() * totalWeight;
    let selected = PRIZE_TIERS[0];

    for (const tier of PRIZE_TIERS) {
      roll -= tier.weight;
      if (roll <= 0) {
        selected = tier;
        break;
      }
    }

    state.multiplier = selected.multiplier;

    // ── Pool-Based Prize Calculation ──────────────────────────────────────
    const buyIn = config.buyIn;
    const basePayout = 2 * buyIn; // Default winner payout (2 of 3 buy-ins)
    const poolContribution = SPIN_POOL_CONTRIBUTION_MULTIPLIER * buyIn; // 1× buy_in to pool

    // Look up bonus tier from SPIN_BONUS_TIERS
    const bonusTier = SPIN_BONUS_TIERS.standard.find(
      (t) => t.displayMultiplier === selected.multiplier
    );
    const requestedBonus = (bonusTier?.bonusBuyIns ?? 0) * buyIn;

    // ── Pool Economics (10% net return model) ───────────────────────────────
    // EVERY spin deposits 1× buy_in to pool, then bonus draws happen.
    // This ensures pool is self-sustaining and club net = exactly 10%.
    // Pool can go negative up to SPIN_POOL_MAX_NEGATIVE (-500 chips).
    // Future 2× spin deposits pay back the negative balance.
    await this.depositToPool(lobbyId, poolContribution);

    let actualBonus = 0;
    if (requestedBonus > 0) {
      // Draw from pool — allowed to go negative up to -500 chips
      actualBonus = await this.drawFromPool(lobbyId, requestedBonus);
    }

    state.prizePool = basePayout + actualBonus;

    masterBus.emit('SPIN_RESULT', {
      lobbyId,
      multiplier: selected.multiplier,
      prizePool: state.prizePool,
      label: selected.label,
      color: selected.color,
      bonusFromPool: actualBonus,
      poolContribution: poolContribution,
    });
  }

  /**
   * Called after the wheel animation completes — start the actual game
   */
  startGame(lobbyId: string): void {
    const state = this.games.get(lobbyId);
    const config = this.configs.get(lobbyId);
    if (!state || !config || state.status !== 'spinning') return;

    state.status = 'playing';
    state.currentLevel = 0;
    state.levelTimer = config.blindLevels[0].durationSeconds;

    // Start blind level timer
    this.startLevelTimer(lobbyId);

    masterBus.emit('SPIN_GAME_STARTED', {
      lobbyId,
      players: state.players,
      multiplier: state.multiplier,
      prizePool: state.prizePool,
      blinds: config.blindLevels[0],
    });

    // Create a HeadlessTableEngine for the dealing pipeline
    // The lobby ID maps to a Supabase table row that the engine reads from
    const engine = new HeadlessTableEngine(lobbyId, supabase);
    this.dealingEngines.set(lobbyId, engine);
    engine.start().catch((err) => {
      console.error(`[SpinItEngine] HeadlessTableEngine failed to start for ${lobbyId}:`, err);
    });
  }

  /**
   * Blind level timer
   */
  private startLevelTimer(lobbyId: string): void {
    // Clear any existing timer
    const existingTimer = this.timers.get(lobbyId);
    if (existingTimer) clearInterval(existingTimer);

    const timer = setInterval(() => {
      const state = this.games.get(lobbyId);
      const config = this.configs.get(lobbyId);
      if (!state || !config || state.status === 'finished') {
        clearInterval(timer);
        return;
      }

      state.levelTimer--;

      if (state.levelTimer <= 0) {
        // Advance to next blind level
        state.currentLevel = Math.min(state.currentLevel + 1, config.blindLevels.length - 1);
        state.levelTimer = config.blindLevels[state.currentLevel].durationSeconds;

        masterBus.emit('BLIND_LEVEL_UP', {
          lobbyId,
          level: state.currentLevel,
          blinds: config.blindLevels[state.currentLevel],
        });

        // Sync blind level to HeadlessTableEngine if active
        const engine = this.dealingEngines.get(lobbyId);
        if (engine) {
          const newLevel = config.blindLevels[state.currentLevel];
          engine.updateBlinds(newLevel.small, newLevel.big);
        }
      }
    }, 1000);

    this.timers.set(lobbyId, timer);
  }

  /**
   * Player eliminated — check for winner
   */
  eliminatePlayer(lobbyId: string, playerId: string): void {
    const state = this.games.get(lobbyId);
    if (!state) return;

    const remaining = state.players.filter((p) => p !== playerId);

    if (remaining.length === 2) {
      state.status = 'headsup';
      masterBus.emit('SPIN_HEADSUP', { lobbyId, players: remaining });
    }

    if (remaining.length === 1) {
      this.finishGame(lobbyId, remaining[0]);
    }
  }

  /**
   * Finish the game — pool-based payouts.
   * Winner takes all (the entire prize pool = basePayout + bonus).
   * For premium spins (50×+), 2nd place gets 10% of the prize pool.
   */
  private finishGame(lobbyId: string, winnerId: string): void {
    const state = this.games.get(lobbyId);
    if (!state) return;

    state.status = 'finished';
    state.winnerId = winnerId;

    const prizePool = state.prizePool;

    if (prizePool <= 0) {
      console.error(
        `[SpinItEngine] Invalid prize pool for ${lobbyId}. Awarding 0.`
      );
      state.payouts.set(winnerId, 0);
    } else {
      const multiplier = state.multiplier ?? 2;
      // Premium spins (50×+): give runner-up 10% as consolation
      if (multiplier >= 50) {
        const runnerUpCut = Math.trunc(prizePool * 0.10 * 100) / 100;
        const winnerCut = prizePool - runnerUpCut;
        state.payouts.set(winnerId, winnerCut);
        state.players.forEach((p) => {
          if (p !== winnerId && !state.payouts.has(p)) {
            state.payouts.set(p, runnerUpCut);
          }
        });
      } else {
        // Winner takes all
        state.payouts.set(winnerId, prizePool);
      }
    }

    // Stop blind timer
    const timer = this.timers.get(lobbyId);
    if (timer) clearInterval(timer);
    this.timers.delete(lobbyId);

    masterBus.emit('SPIN_FINISHED', {
      lobbyId,
      winnerId,
      prizePool: state.prizePool,
      multiplier: state.multiplier,
      payouts: Object.fromEntries(state.payouts),
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // POOL OPERATIONS (Supabase spin_bonus_pools table)
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Resolve the club_id for a lobby/tournament.
   * Tries to look it up from the tournaments table.
   */
  private async getClubIdForLobby(lobbyId: string): Promise<string | null> {
    try {
      const { data } = await supabase
        .from('tournaments')
        .select('club_id')
        .eq('id', lobbyId)
        .single();
      return data?.club_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Deposit buy-ins into the pool for a club.
   * Called on default (no-bonus) spins.
   */
  private async depositToPool(lobbyId: string, amount: number): Promise<void> {
    const clubId = await this.getClubIdForLobby(lobbyId);
    if (!clubId || amount <= 0) return;

    try {
      // Upsert: create row if missing, increment balance if exists
      const { error } = await supabase.rpc('spin_pool_deposit', {
        p_club_id: clubId,
        p_amount: amount,
      });
      if (error) {
        // Fallback: try direct upsert if RPC doesn't exist yet
        console.warn('[SpinItEngine] spin_pool_deposit RPC failed, using direct upsert:', error.message);
        await this.directPoolDeposit(clubId, amount);
      }
    } catch (e) {
      console.error('[SpinItEngine] Pool deposit failed:', e);
    }
  }

  /**
   * Draw bonus from the pool — allows negative balance down to SPIN_POOL_MAX_NEGATIVE (-500).
   * Club/union can "carry" up to 500 chips of debt; future 2× spin deposits pay it back.
   * Returns the actual amount drawn (may be less than requested if it would exceed -500 floor).
   */
  private async drawFromPool(lobbyId: string, requestedAmount: number): Promise<number> {
    const clubId = await this.getClubIdForLobby(lobbyId);
    if (!clubId || requestedAmount <= 0) return 0;

    try {
      // Use direct draw with negative balance support (RPC may not support negative yet)
      return await this.directPoolDraw(clubId, requestedAmount);
    } catch (e) {
      console.error('[SpinItEngine] Pool draw failed:', e);
      return 0;
    }
  }

  /**
   * Fallback direct deposit (no RPC).
   */
  private async directPoolDeposit(clubId: string, amount: number): Promise<void> {
    // Check if row exists
    const { data: existing } = await supabase
      .from('spin_bonus_pools')
      .select('balance')
      .eq('club_id', clubId)
      .single();

    if (existing) {
      await supabase
        .from('spin_bonus_pools')
        .update({ balance: existing.balance + amount, updated_at: new Date().toISOString() })
        .eq('club_id', clubId);
    } else {
      await supabase
        .from('spin_bonus_pools')
        .insert({ club_id: clubId, balance: amount });
    }
  }

  /**
   * Direct draw — allows pool to go negative down to SPIN_POOL_MAX_NEGATIVE (-500 chips).
   * If draw would push below -500, caps at what keeps pool at exactly -500.
   */
  private async directPoolDraw(clubId: string, requestedAmount: number): Promise<number> {
    const { data: existing } = await supabase
      .from('spin_bonus_pools')
      .select('balance')
      .eq('club_id', clubId)
      .maybeSingle();

    const currentBalance = existing?.balance ?? 0;

    // How much can we draw before hitting the -500 floor?
    const maxDraw = currentBalance - SPIN_POOL_MAX_NEGATIVE; // e.g. balance=100, floor=-500 → maxDraw=600
    if (maxDraw <= 0) return 0; // Already at or below -500, can't draw

    const actualDraw = Math.min(requestedAmount, maxDraw);
    const newBalance = currentBalance - actualDraw;

    if (existing) {
      await supabase
        .from('spin_bonus_pools')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('club_id', clubId);
    } else {
      // No row yet — create one with negative balance
      await supabase
        .from('spin_bonus_pools')
        .insert({ club_id: clubId, balance: newBalance });
    }

    return actualDraw;
  }

  /**
   * Get current game state
   */
  getState(lobbyId: string): SpinItState | null {
    return this.games.get(lobbyId) ?? null;
  }

  /**
   * Get current blind level for a game
   */
  getCurrentBlinds(lobbyId: string): BlindLevel | null {
    const state = this.games.get(lobbyId);
    const config = this.configs.get(lobbyId);
    if (!state || !config) return null;
    return config.blindLevels[state.currentLevel] ?? null;
  }

  /**
   * Get the prize tiers for UI display
   */
  getPrizeTiers(): SpinPrizeConfig[] {
    return [...PRIZE_TIERS];
  }

  /**
   * Cleanup
   */
  dispose(lobbyId: string): void {
    const timer = this.timers.get(lobbyId);
    if (timer) clearInterval(timer);
    this.timers.delete(lobbyId);
    this.games.delete(lobbyId);
    this.configs.delete(lobbyId);

    // Stop dealing engine
    const engine = this.dealingEngines.get(lobbyId);
    if (engine) {
      engine
        .stop()
        .catch((e) =>
          console.warn(`[SpinItEngine] Failed to stop dealing engine for lobby ${lobbyId}:`, e)
        );
      this.dealingEngines.delete(lobbyId);
    }
  }

  /**
   * Get the HeadlessTableEngine for external hand state queries
   */
  getEngine(lobbyId: string): HeadlessTableEngine | null {
    return this.dealingEngines.get(lobbyId) ?? null;
  }
}

export const spinItEngine = new SpinItEngineClass();
export default spinItEngine;
