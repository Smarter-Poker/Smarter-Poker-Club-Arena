/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT TIMER SERVICE — Blind Level Advancement Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages automatic blind level advancement for running tournaments.
 * Features:
 * - Tick-based level checking
 * - Database sync when levels change
 * - Real-time broadcast to all connected clients
 * - Break handling
 */

import { supabase } from '../lib/supabase';
import { tournamentService } from './TournamentService';
import { masterBus } from '../core/MasterBus';
import type { Tournament } from '../types/database.types';
import { reportError } from '../utils/errorReporter';

/** Sentinel for "this timer has not observed a level yet". It cannot be 0:
 *  0 is a real, 0-based level index - the opening level. */
const NO_LEVEL_OBSERVED = -1;

interface TournamentTimerState {
  tournamentId: string;
  /** 0-based level index, matching `tournaments.current_level`. -1 until the
   *  first tick resolves one. */
  currentLevel: number;
  intervalId: ReturnType<typeof setInterval>;
  isPaused: boolean;
  lastTick: number;
  isTickInProgress: boolean; // Guard against async overlap
  breakTimeoutId?: ReturnType<typeof setTimeout>;
}

class TournamentTimerServiceClass {
  private activeTimers: Map<string, TournamentTimerState> = new Map();
  private readonly TICK_INTERVAL_MS = 1000; // Check every second
  private breakIntervals: Map<string, number> = new Map(); // configurable break every N levels
  private headsUpTriggered: Set<string> = new Set(); // Guard against duplicate HEADS_UP_SWITCH emissions
  private playerEliminatedUnsub: (() => void) | null = null;

  constructor() {
    // Listen for player eliminations to trigger final table / heads-up detection
    this.playerEliminatedUnsub = masterBus.subscribe('PLAYER_ELIMINATED', (event) => {
      const tournamentId = event.payload?.tournamentId;
      if (tournamentId && this.activeTimers.has(tournamentId)) {
        // Debounce: small delay to let DB state settle after elimination
        setTimeout(() => {
          this.checkTableSize(tournamentId);
        }, 500);
      }
    });
  }

  /**
   * Start monitoring a tournament for level changes
   */
  startTimer(tournamentId: string): void {
    if (this.activeTimers.has(tournamentId)) {
      reportError(
        new Error(`[TournamentTimer] Timer already running for ${tournamentId}`),
        'TournamentTimerService.Timer_already_running_for_tournamentId'
      );
      return;
    }

    const intervalId = setInterval(() => {
      this.tick(tournamentId);
    }, this.TICK_INTERVAL_MS);

    this.activeTimers.set(tournamentId, {
      tournamentId,
      currentLevel: NO_LEVEL_OBSERVED,
      intervalId,
      isPaused: false,
      isTickInProgress: false,
      lastTick: Date.now(),
    });

    // Initial tick to set up state
    this.tick(tournamentId);
  }

  /**
   * Stop monitoring a tournament
   */
  stopTimer(tournamentId: string): void {
    const timer = this.activeTimers.get(tournamentId);
    if (timer) {
      clearInterval(timer.intervalId);
      if (timer.breakTimeoutId) {
        clearTimeout(timer.breakTimeoutId);
      }
      this.activeTimers.delete(tournamentId);
      // Clean up broadcast channel to prevent memory leaks
      masterBus.removeRegisteredChannel(`tournament:${tournamentId}`);
      // Clean up per-tournament tracking state
      this.headsUpTriggered.delete(tournamentId);
      this.breakIntervals.delete(tournamentId);
    }
  }

  /**
   * Pause a tournament timer (for breaks)
   */
  pauseTimer(tournamentId: string): void {
    const timer = this.activeTimers.get(tournamentId);
    if (timer) {
      timer.isPaused = true;
    }
  }

  /**
   * Resume a tournament timer
   */
  resumeTimer(tournamentId: string): void {
    const timer = this.activeTimers.get(tournamentId);
    if (timer) {
      timer.isPaused = false;
    }
  }

  /**
   * Get current timer state for a tournament
   */
  getTimerState(tournamentId: string): TournamentTimerState | null {
    return this.activeTimers.get(tournamentId) || null;
  }

  /**
   * Core tick function — called every second for each active tournament
   */
  private async tick(tournamentId: string): Promise<void> {
    const timer = this.activeTimers.get(tournamentId);
    if (!timer || timer.isPaused) return;

    // Guard: skip if previous tick is still in-flight (prevents async overlap)
    if (timer.isTickInProgress) return;
    timer.isTickInProgress = true;

    try {
      // Fetch current tournament state
      const tournament = await tournamentService.getTournament(tournamentId);
      if (!tournament || tournament.status !== 'RUNNING') {
        this.stopTimer(tournamentId);
        return;
      }

      // Calculate current level based on elapsed time
      const levelState = tournamentService.getCurrentLevelState(tournament);
      /**
       * =======================================================================
       *  THIS IS THE 0-BASED INDEX, NOT A DISPLAY NUMBER (fixed 2026-08-25)
       * =======================================================================
       *
       * This read:
       *
       *     const newLevel = levelState.levelIndex + 1; // 1-indexed for display
       *
       * and handleLevelChange writes `newLevel` straight into
       * `tournaments.current_level`, which is a 0-BASED ARRAY INDEX (see the
       * evidence block on TournamentService.getCurrentLevelState). So the +1
       * pushed the column one level ahead of the truth on every write, and
       * because the reader feeds this method its own previous output, the
       * error compounded: read N, write N+1, read N+1, write N+2 - once per
       * tick, i.e. once per second, for as long as the tab stayed open.
       *
       * The engine on Hetzner is the authoritative writer and it persists the
       * plain index (TournamentManagerBase: `.update({ current_level: this.currentLevel })`).
       *
       * RESOLVED 2026-08-26 (handoff ITEM B): the design question is answered —
       * THE CLIENT DOES NOT WRITE `current_level`, ever. The write is gone from
       * handleLevelChange, `initializeAllTimers` (the only thing that ever
       * started this loop) has been deleted outright, and nothing in src/
       * calls startTimer(). A grep of src/ confirms every remaining
       * `current_level` reference is a read. This service survives only as the
       * read-side state TournamentClock queries via getTimerState.
       *
       * The DISPLAY number is still level + 1, and it is applied at the point
       * of display (getFullClockState, TournamentHUD, TournamentClock) - never
       * to the value that reaches the database.
       */
      const newLevel = levelState.levelIndex;
      if (!levelState.currentLevel) return;

      // Check if level changed. `timer.currentLevel` starts at -1 precisely so
      // that a genuine level 0 registers as a change on the first tick.
      if (newLevel !== timer.currentLevel) {
        await this.handleLevelChange(tournament, timer.currentLevel, newLevel, levelState);
        timer.currentLevel = newLevel;
      }

      timer.lastTick = Date.now();
    } catch (error: unknown) {
      reportError(error, 'TournamentTimerService.Error_in_tick_for_tournamentId');
    } finally {
      // Always release the lock, even on error
      const t = this.activeTimers.get(tournamentId);
      if (t) t.isTickInProgress = false;
    }
  }

  /**
   * Handle blind level advancement.
   *
   * `newLevel` is a 0-BASED index - the same value `tournaments.current_level`
   * stores and the same value the engine writes. It goes to the database
   * unchanged. Everything a human reads adds one (`displayLevel` below), and
   * so does the break cadence, which counts levels played rather than indices.
   */
  private async handleLevelChange(
    tournament: Tournament,
    oldLevel: number,
    newLevel: number,
    levelState: ReturnType<typeof tournamentService.getCurrentLevelState>
  ): Promise<void> {
    const { currentLevel } = levelState;
    if (!currentLevel) return; // No confirmed amounts to broadcast.
    const displayLevel = newLevel + 1;

    // Client no longer writes to the database (engine is authoritative).

    // 3. Broadcast level change to all clients
    await this.broadcastLevelChange(tournament.id, {
      level: displayLevel,
      smallBlind: currentLevel.smallBlind,
      bigBlind: currentLevel.bigBlind,
      ante: currentLevel.ante,
      nextLevel: levelState.nextLevel,
      timeRemainingSeconds: levelState.timeRemainingSeconds,
    });

    // 3.5. Emit specific bus event for TournamentClock and other listeners
    masterBus.emit('BLIND_LEVEL_CHANGE', {
      tournamentId: tournament.id,
      level: displayLevel,
      smallBlind: currentLevel.smallBlind,
      bigBlind: currentLevel.bigBlind,
      ante: currentLevel.ante,
    });

    // 3.6. Also emit general tournament update for page-level refresh
    masterBus.emit('TOURNAMENT_UPDATED', {
      tournamentId: tournament.id,
      status: `blind_level_${displayLevel}`,
    });

    // 4. Check for break times (configurable interval, default every 6 levels).
    //    Counted on the display level: a break falls after 6 levels PLAYED, so
    //    the modulo must not see index 0 as a multiple and open with a break.
    const breakInterval = this.breakIntervals.get(tournament.id) || 6;
    if (displayLevel % breakInterval === 0 && levelState.nextLevel) {
      await this.handleBreak(tournament.id, 5); // 5-minute break
    }
  }

  /**
   * Check remaining players and auto-switch to heads-up blinds / emit final table.
   * Should be called after each elimination or periodically.
   */
  async checkTableSize(tournamentId: string): Promise<void> {
    try {
      const { data: entries } = await supabase
        .from('tournament_players')
        .select('user_id, username, chips')
        .eq('tournament_id', tournamentId)
        .eq('status', 'playing');

      if (!entries || entries.length === 0) return;

      const playersRemaining = entries.length;

      // ── Final Table Detection (9 or fewer from larger field) ──
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('id, name, prize_pool, max_players, final_table_triggered')
        .eq('id', tournamentId)
        .maybeSingle();

      if (!tournament) return;

      const maxPlayers = tournament.max_players || 0;
      const alreadyTriggered = (tournament as any).final_table_triggered;

      if (playersRemaining <= 9 && maxPlayers > 9 && !alreadyTriggered) {
        // Mark as triggered so we only fire once
        await supabase
          .from('tournaments')
          .update({ final_table_triggered: true } as any)
          .eq('id', tournamentId);

        masterBus.emit('FINAL_TABLE_REACHED', {
          tournamentId,
          tournamentName: tournament.name || 'Tournament',
          prizePool: tournament.prize_pool || 0,
          players: entries.map((e: any) => ({
            userId: e.user_id,
            username: e.username || e.user_id?.substring(0, 8) || 'Player',
            chips: e.chips || 0,
          })),
        });
      }

      // ── Heads-Up Detection (exactly 2 players) ──
      if (playersRemaining === 2 && !this.headsUpTriggered.has(tournamentId)) {
        this.headsUpTriggered.add(tournamentId);
        const [p1, p2] = entries as any[];
        masterBus.emit('HEADS_UP_SWITCH', {
          tournamentId,
          player1: {
            userId: p1.user_id,
            username: p1.username || 'Player 1',
            chips: p1.chips || 0,
          },
          player2: {
            userId: p2.user_id,
            username: p2.username || 'Player 2',
            chips: p2.chips || 0,
          },
        });

        // Auto-switch to heads-up blind structure:
        // SB = BB (button posts small blind and acts first preflop)
        // This is standard tournament heads-up rules
        const timer = this.activeTimers.get(tournamentId);
        if (timer) {
          // Heads-up already uses same level — no structural change needed,
          // just ensure the dealer button logic switches to 2-player mode
          // The PokerEngine/HandController handles this based on player count
          console.info(`[TournamentTimer] Heads-up mode active for ${tournamentId}`);
        }
      }
    } catch (err: unknown) {
      reportError(err, 'TournamentTimerService.checkTableSize_error');
    }
  }

  /**
   * Handle tournament break
   */
  private async handleBreak(tournamentId: string, durationMinutes: number): Promise<void> {
    // Pause the timer locally (tournament stays RUNNING in DB — 'paused' is not a valid DB status)
    this.pauseTimer(tournamentId);

    // Broadcast break notification
    await this.broadcastEvent(tournamentId, 'BREAK_START', {
      durationMinutes,
      resumeAt: new Date(Date.now() + durationMinutes * 60 * 1000).toISOString(),
    });

    // Schedule resume and store the timeout ID for cleanup
    const breakTimeoutId = setTimeout(
      async () => {
        this.resumeTimer(tournamentId);

        // Clear the stored timeout ID
        const t = this.activeTimers.get(tournamentId);
        if (t) t.breakTimeoutId = undefined;

        await this.broadcastEvent(tournamentId, 'BREAK_END', {});
      },
      durationMinutes * 60 * 1000
    );

    // Store timeout ID so stopTimer can clear it
    const timer = this.activeTimers.get(tournamentId);
    if (timer) timer.breakTimeoutId = breakTimeoutId;
  }

  /**
   * Broadcast blind level change to all connected clients
   */
  private async broadcastLevelChange(
    tournamentId: string,
    data: {
      level: number;
      smallBlind: number;
      bigBlind: number;
      ante: number;
      nextLevel: { smallBlind: number; bigBlind: number; ante: number } | null;
      timeRemainingSeconds: number;
    }
  ): Promise<void> {
    await this.broadcastEvent(tournamentId, 'LEVEL_CHANGE', data);
  }

  /**
   * Generic event broadcast via Supabase Realtime
   */
  private async broadcastEvent(
    tournamentId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      // Use MasterBus channel registry to avoid orphaned channel leaks
      const channelKey = `tournament:${tournamentId}`;
      const channel = masterBus.getOrCreateChannel(channelKey);
      await channel.send({
        type: 'broadcast',
        event: eventType,
        payload: {
          tournamentId,
          timestamp: new Date().toISOString(),
          ...payload,
        },
      });
    } catch (error: unknown) {
      reportError(error, 'TournamentTimerService.Broadcast_error');
    }
  }

  /**
   * Stop all active timers (called on app shutdown)
   */
  stopAllTimers(): void {
    // Copy keys first to avoid Map-delete-during-iteration skip bug
    const ids = [...this.activeTimers.keys()];
    for (const id of ids) {
      this.stopTimer(id); // This now cleans up channels, headsUpTriggered, and breakIntervals
    }
    // Clean up global bus subscription to prevent memory leak
    if (this.playerEliminatedUnsub) {
      this.playerEliminatedUnsub();
      this.playerEliminatedUnsub = null;
    }
    // Defensive: clear any remaining state
    this.headsUpTriggered.clear();
    this.breakIntervals.clear();
  }

  /**
   * Get formatted time remaining string (MM:SS)
   */
  formatTimeRemaining(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Set configurable break interval for a tournament
   */
  setBreakInterval(tournamentId: string, everyNLevels: number): void {
    this.breakIntervals.set(tournamentId, Math.max(1, everyNLevels));
  }

  /**
   * Get full clock state for UI binding (TournamentClock component)
   */
  async getFullClockState(tournamentId: string): Promise<{
    tournamentId: string;
    currentLevel: number;
    smallBlind: number;
    bigBlind: number;
    ante: number;
    nextSmallBlind: number;
    nextBigBlind: number;
    nextAnte: number;
    timeRemainingSeconds: number;
    isPaused: boolean;
    isBreak: boolean;
    breakInterval: number;
  } | null> {
    const timer = this.activeTimers.get(tournamentId);
    if (!timer) return null;

    const tournament = await tournamentService.getTournament(tournamentId);
    if (!tournament) return null;

    const levelState = tournamentService.getCurrentLevelState(tournament);
    if (!levelState.currentLevel) return null;
    // Handle blind_structure being a JSON string (Supabase REST returns JSONB as string)
    let blindStructure: any[];
    const rawBlinds: unknown = tournament.blind_structure;
    if (Array.isArray(rawBlinds)) {
      blindStructure = rawBlinds;
    } else if (typeof rawBlinds === 'string' && rawBlinds.length > 0) {
      try {
        blindStructure = JSON.parse(rawBlinds);
      } catch {
        blindStructure = [];
      }
      if (!Array.isArray(blindStructure)) blindStructure = [];
    } else {
      blindStructure = [];
    }

    // Check if current level is a break level
    const currentLevelDef = blindStructure[levelState.levelIndex];
    const isCurrentBreak = currentLevelDef?.isBreak || false;

    return {
      tournamentId,
      currentLevel: levelState.levelIndex + 1,
      smallBlind: levelState.currentLevel.smallBlind,
      bigBlind: levelState.currentLevel.bigBlind,
      ante: levelState.currentLevel.ante,
      nextSmallBlind: levelState.nextLevel?.smallBlind || 0,
      nextBigBlind: levelState.nextLevel?.bigBlind || 0,
      nextAnte: levelState.nextLevel?.ante || 0,
      timeRemainingSeconds: levelState.timeRemainingSeconds,
      isPaused: timer.isPaused,
      isBreak: isCurrentBreak,
      breakInterval: this.breakIntervals.get(tournamentId) || 6,
    };
  }
}

export const tournamentTimerService = new TournamentTimerServiceClass();
export default tournamentTimerService;
