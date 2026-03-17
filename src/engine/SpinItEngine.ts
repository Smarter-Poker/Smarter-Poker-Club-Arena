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
// PRIZE WHEEL CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PRIZE_TIERS: SpinPrizeConfig[] = [
  { multiplier: 2, weight: 500, label: '2x', color: '#6B7280' },
  { multiplier: 3, weight: 250, label: '3x', color: '#3B82F6' },
  { multiplier: 5, weight: 120, label: '5x', color: '#10B981' },
  { multiplier: 10, weight: 60, label: '10x', color: '#F59E0B' },
  { multiplier: 25, weight: 40, label: '25x', color: '#EF4444' },
  { multiplier: 50, weight: 20, label: '50x', color: '#8B5CF6' },
  { multiplier: 100, weight: 10, label: '100x', color: '#FFD700' },
];

const DEFAULT_BLIND_LEVELS: BlindLevel[] = [
  { small: 10, big: 20, durationSeconds: 180 },
  { small: 15, big: 30, durationSeconds: 180 },
  { small: 20, big: 40, durationSeconds: 180 },
  { small: 30, big: 60, durationSeconds: 120 },
  { small: 50, big: 100, durationSeconds: 120 },
  { small: 75, big: 150, durationSeconds: 120 },
  { small: 100, big: 200, durationSeconds: 90 },
  { small: 150, big: 300, durationSeconds: 90 },
  { small: 200, big: 400, durationSeconds: 60 },
  { small: 300, big: 600, durationSeconds: 60 },
  { small: 500, big: 1000, durationSeconds: 60 },
];

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
   * Spin the prize wheel — weighted random selection
   */
  private startSpin(lobbyId: string): void {
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
    state.prizePool = config.buyIn * 3 * (1 - config.rake) * selected.multiplier;

    masterBus.emit('SPIN_RESULT', {
      lobbyId,
      multiplier: selected.multiplier,
      prizePool: state.prizePool,
      label: selected.label,
      color: selected.color,
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
   * Finish the game — calculate payouts
   */
  private finishGame(lobbyId: string, winnerId: string): void {
    const state = this.games.get(lobbyId);
    if (!state) return;

    state.status = 'finished';
    state.winnerId = winnerId;

    // For large multipliers (25x+), 2nd place gets a cut
    const multiplier = state.multiplier ?? 2;
    if (multiplier >= 25) {
      const winnerPayout = state.prizePool * 0.75;
      const runnerUpPayout = state.prizePool * 0.25;
      state.payouts.set(winnerId, winnerPayout);
      // In a real implementation, we'd track elimination order
      state.players.forEach((p) => {
        if (p !== winnerId && !state.payouts.has(p)) {
          state.payouts.set(p, runnerUpPayout);
        }
      });
    } else {
      // Winner takes all
      state.payouts.set(winnerId, state.prizePool);
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
