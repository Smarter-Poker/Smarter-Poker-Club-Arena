/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SMARTER POKER GAME SERVER — 24/7 Server-Side Game Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is the PRODUCTION game server that replaces DealerPage.
 * It runs 24/7 on the server with ZERO browser dependency.
 *
 * Features:
 * - Creates and manages ALL cash game tables with horse fleet
 * - Creates and manages tournaments on 24/7 schedule (MTTs, SNGs, Spins)
 * - Runs horse AI with millisecond-level response times
 * - Broadcasts hand state via Supabase Realtime
 * - Horse lifecycle management (stuck detection, cleanup)
 * - Auto-recovers from crashes
 * - Health check endpoint for monitoring
 *
 * Deploy to: Fly.io ($3-5/month), Railway, or any Node.js host
 */

import { createServer } from 'http';
import { ServerTableEngine } from './engine/ServerTableEngine.js';
import { supabase, cleanupAllChannels } from './services/supabase.js';
import { HorseFleetManager } from './services/HorseFleetManager.js';
import { TournamentRecurringService } from './services/TournamentRecurringService.js';
import { HorseLifecycleManager } from './services/HorseLifecycleManager.js';
import { AutoRebuyService } from './services/AutoRebuyService.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '8080', 10);
const TABLE_DISCOVERY_INTERVAL = 5000; // Check for new tables every 5 seconds
const TOURNAMENT_DISCOVERY_INTERVAL = 5000; // Check for tournaments every 5 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// GAME SERVER — Main Orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

class GameServer {
  private tableEngines: Map<string, ServerTableEngine> = new Map();
  private tournamentEngines: Map<string, TournamentManager> = new Map();
  private running: boolean = false;
  private startTime: number = Date.now();

  // Server-side services (replaces browser-based DealerPage services)
  private horseFleet = new HorseFleetManager();
  private tournamentRecurring = new TournamentRecurringService();
  private lifecycle = new HorseLifecycleManager();
  private autoRebuy = new AutoRebuyService();

  // Synchronized break timer — all MTT/XMTT tournaments break at the top of every hour
  private breakTimer: NodeJS.Timeout | null = null;
  private breakResumeTimer: NodeJS.Timeout | null = null;
  private static readonly BREAK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

  async start(): Promise<void> {
    this.running = true;
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(' SMARTER POKER GAME SERVER — Starting...');
    console.log(' All game logic runs HERE — no browser needed');
    console.log('═══════════════════════════════════════════════════════════════');

    // Step 1: Clean up stale data from previous runs
    await this.cleanupStaleData();

    // Step 2: Start horse fleet manager (creates tables, seats horses)
    await this.horseFleet.start();

    // Step 3: Start tournament recurring service (creates MTTs, SNGs, Spins)
    this.tournamentRecurring.start();

    // Step 4: Start lifecycle manager (stuck horse detection, cleanup)
    this.lifecycle.start();

    // Step 5: Start server-side auto-rebuy wallet funder
    this.autoRebuy.start();

    // Step 6: Start discovery loops (finds tables with players, starts engines)
    // These are infinite while-loops — fire-and-forget with error handling
    this.discoverCashTables().catch((err) =>
      console.error('[GameServer] Cash table discovery fatal error:', err)
    );
    this.discoverTournaments().catch((err) =>
      console.error('[GameServer] Tournament discovery fatal error:', err)
    );

    // Step 7: Start synchronized break timer (top of every hour, 5 min duration)
    this.scheduleSynchronizedBreaks();

    console.log('[GameServer] Running. All services started.');
  }

  async stop(): Promise<void> {
    this.running = false;
    console.log('[GameServer] Shutting down...');

    // Stop services
    this.horseFleet.stop();
    this.tournamentRecurring.stop();
    this.lifecycle.stop();
    this.autoRebuy.stop();
    if (this.breakTimer) {
      clearTimeout(this.breakTimer);
      this.breakTimer = null;
    }
    if (this.breakResumeTimer) {
      clearTimeout(this.breakResumeTimer);
      this.breakResumeTimer = null;
    }

    // Stop all table engines
    for (const [id, engine] of this.tableEngines) {
      await engine.stop();
    }
    this.tableEngines.clear();

    // Stop all tournament engines
    for (const [id, tm] of this.tournamentEngines) {
      tm.stop();
    }
    this.tournamentEngines.clear();

    // Clean up Realtime channels
    cleanupAllChannels();
    console.log('[GameServer] Shutdown complete.');
  }

  getStatus() {
    let totalHands = 0;
    for (const engine of this.tableEngines.values()) {
      totalHands += engine.getHandCount();
    }
    return {
      running: this.running,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      activeTables: this.tableEngines.size,
      activeTournaments: this.tournamentEngines.size,
      totalHandsDealt: totalHands,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // SYNCHRONIZED BREAKS — All MTTs/XMTTs pause at the top of every hour
  // ═════════════════════════════════════════════════════════════════════════════

  private scheduleSynchronizedBreaks(): void {
    // Calculate ms until next top of the hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    const msUntilNextHour = nextHour.getTime() - now.getTime();

    console.log(
      `[GameServer] Synchronized break scheduled in ${Math.round(msUntilNextHour / 60000)} minutes (top of next hour)`
    );

    this.breakTimer = setTimeout(() => {
      this.triggerSynchronizedBreak();
      // Schedule recurring hourly breaks
      this.breakTimer = setInterval(
        () => {
          this.triggerSynchronizedBreak();
        },
        60 * 60 * 1000
      ); // Every hour
    }, msUntilNextHour);
  }

  private async triggerSynchronizedBreak(): Promise<void> {
    if (!this.running) return;

    const mttEngines: TournamentManager[] = [];
    for (const tm of this.tournamentEngines.values()) {
      if (tm.isRunning() && tm.isMttOrXmtt()) {
        mttEngines.push(tm);
      }
    }

    if (mttEngines.length === 0) {
      console.log('[GameServer] Synchronized break: no running MTTs/XMTTs to pause');
      return;
    }

    console.log(
      `[GameServer] ═══ SYNCHRONIZED BREAK ═══ Pausing ${mttEngines.length} MTT/XMTT tournaments for 5 minutes`
    );

    // Pause all MTT/XMTT tournaments
    for (const tm of mttEngines) {
      try {
        await tm.pauseForBreak(GameServer.BREAK_DURATION_MS);
      } catch (err: any) {
        console.error(`[GameServer] Failed to pause tournament:`, err.message);
      }
    }

    // Schedule resume after 5 minutes
    this.breakResumeTimer = setTimeout(async () => {
      console.log(
        `[GameServer] ═══ BREAK ENDED ═══ Resuming ${mttEngines.length} MTT/XMTT tournaments`
      );
      for (const tm of mttEngines) {
        try {
          await tm.resumeFromBreak();
        } catch (err: any) {
          console.error(`[GameServer] Failed to resume tournament:`, err.message);
        }
      }
    }, GameServer.BREAK_DURATION_MS);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // STALE DATA CLEANUP — Run on startup
  // ═════════════════════════════════════════════════════════════════════════════

  private async cleanupStaleData(): Promise<void> {
    console.log('[GameServer] Cleaning up stale data from previous runs...');
    try {
      // 1. Batch-reset ALL stuck horses to available (fast single query)
      //    Any horse not at an active table will get re-seated by HorseFleetManager
      await supabase
        .from('profiles')
        .update({ horse_status: 'available', updated_at: new Date().toISOString() })
        .eq('is_horse', true)
        .neq('horse_status', 'available');
      console.log('[GameServer] Reset stuck horses to available');

      // 2. SAFE CLEANUP: Cash out ALL active seats before deleting
      //    This prevents chip loss when the server restarts while players are seated
      const { data: activeSeats } = await supabase
        .from('table_seats')
        .select('user_id, table_id, seat_number, stack')
        .is('left_at', null);

      if (activeSeats && activeSeats.length > 0) {
        let cashedOut = 0;
        for (const seat of activeSeats) {
          if (seat.stack > 0) {
            const { error: cashoutErr } = await supabase.rpc('atomic_table_cashout', {
              p_user_id: seat.user_id,
              p_table_id: seat.table_id,
              p_seat_number: seat.seat_number,
            });
            if (cashoutErr) {
              // Fallback: directly credit wallet if atomic cashout fails
              await supabase.rpc('credit_player_wallet', {
                p_user_id: seat.user_id,
                p_amount: seat.stack,
              });
              // Force-close the seat
              await supabase
                .from('table_seats')
                .update({ left_at: new Date().toISOString() })
                .eq('table_id', seat.table_id)
                .eq('user_id', seat.user_id)
                .eq('seat_number', seat.seat_number)
                .is('left_at', null);
            }
            cashedOut++;
          } else {
            // stack is 0, just mark as left
            await supabase
              .from('table_seats')
              .update({ left_at: new Date().toISOString() })
              .eq('table_id', seat.table_id)
              .eq('user_id', seat.user_id)
              .eq('seat_number', seat.seat_number)
              .is('left_at', null);
          }
        }
        if (cashedOut > 0) {
          console.log(`[GameServer] Safely cashed out ${cashedOut} seated players before cleanup`);
        }
      }

      // Now delete all table_seats (they should all have left_at set now)
      await supabase.from('table_seats').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      console.log('[GameServer] Deleted all table seats (after safe cashout)');

      // 3. Reset all cash table player counts to 0
      await supabase
        .from('tables')
        .update({ current_players: 0, status: 'waiting' })
        .is('tournament_id', null)
        .in('status', ['waiting', 'running']);
      console.log('[GameServer] Reset all cash table player counts');

      // 4. Cancel stale REGISTERING/ANNOUNCED tournaments older than 4 hours
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('tournaments')
        .update({ status: 'CANCELLED' })
        .in('status', ['ANNOUNCED', 'REGISTERING'])
        .lt('created_at', fourHoursAgo);

      // 5. Cancel stale RUNNING tournaments older than 12 hours (likely stuck from crashed server)
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('tournaments')
        .update({ status: 'CANCELLED' })
        .eq('status', 'RUNNING')
        .lt('created_at', twelveHoursAgo);
      console.log('[GameServer] Cancelled stale RUNNING tournaments');

      console.log('[GameServer] Stale data cleanup complete');
    } catch (err) {
      console.error('[GameServer] Stale data cleanup error:', err);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // CASH TABLE DISCOVERY — Every 5 seconds, find tables needing engines
  // ═════════════════════════════════════════════════════════════════════════════

  private async discoverCashTables(): Promise<void> {
    while (this.running) {
      try {
        // Find all cash tables (no tournament_id) that have 2+ seated players
        const { data: tables, error } = await supabase
          .from('tables')
          .select('id, status')
          .is('tournament_id', null)
          .in('status', ['waiting', 'running']);

        if (error) {
          console.error('[GameServer] Cash table discovery error:', error);
          await this.sleep(TABLE_DISCOVERY_INTERVAL);
          continue;
        }

        for (const table of tables || []) {
          // Skip if already running
          if (this.tableEngines.has(table.id)) continue;

          // Check if table has 2+ players
          const { count } = await supabase
            .from('table_seats')
            .select('*', { count: 'exact', head: true })
            .eq('table_id', table.id)
            .is('left_at', null);

          if ((count || 0) >= 2) {
            console.log(
              `[GameServer] Starting engine for cash table ${table.id} (${count} players)`
            );
            const engine = new ServerTableEngine(table.id);
            this.tableEngines.set(table.id, engine);
            engine.start().catch((err) => {
              console.error(`[GameServer] Engine start failed for ${table.id}:`, err);
              this.tableEngines.delete(table.id);
            });
          }
        }

        // Clean up engines for tables that stopped
        for (const [id, engine] of this.tableEngines) {
          if (!engine.isRunning()) {
            this.tableEngines.delete(id);
          }
        }
      } catch (err) {
        console.error('[GameServer] Cash table discovery error:', err);
      }

      await this.sleep(TABLE_DISCOVERY_INTERVAL);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // TOURNAMENT DISCOVERY — Find and manage tournaments
  // ═════════════════════════════════════════════════════════════════════════════

  private async discoverTournaments(): Promise<void> {
    while (this.running) {
      try {
        // Find REGISTERING tournaments ready to start
        const { data: registering } = await supabase
          .from('tournaments')
          .select(
            'id, name, start_time, current_players, min_players, max_players, variant, tournament_type, buy_in_amount, buy_in_fee, guaranteed_prize'
          )
          .eq('status', 'REGISTERING');

        for (const tournament of registering || []) {
          if (this.tournamentEngines.has(tournament.id)) continue;

          // Guard: skip tournaments with no start_time set
          if (!tournament.start_time) {
            console.warn(`[GameServer] Tournament ${tournament.name} has no start_time — skipping`);
            continue;
          }
          const startTime = new Date(tournament.start_time).getTime();
          if (isNaN(startTime)) {
            console.warn(
              `[GameServer] Tournament ${tournament.name} has invalid start_time — skipping`
            );
            continue;
          }
          const now = Date.now();
          const minPlayers = tournament.min_players || 3;

          // Auto-cancel: if 30+ mins past start time and not enough players
          if (startTime <= now - 30 * 60 * 1000 && tournament.current_players < minPlayers) {
            console.log(
              `[GameServer] Cancelling tournament: ${tournament.name} — only ${tournament.current_players}/${minPlayers} players after 30min`
            );
            // Refund all registered players
            const { data: players } = await supabase
              .from('tournament_players')
              .select('user_id')
              .eq('tournament_id', tournament.id)
              .eq('status', 'registered');

            const refundAmount = (tournament.buy_in_amount || 0) + (tournament.buy_in_fee || 0);
            for (const p of players || []) {
              try {
                const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
                  p_user_id: p.user_id,
                  p_amount: refundAmount,
                });
                if (creditErr) {
                  console.error(
                    `[GameServer] Refund FAILED for ${p.user_id.slice(0, 8)} in ${tournament.name}: ${creditErr.message}`
                  );
                  continue; // Skip log for this player but keep refunding others
                }
                const { error: logErr } = await supabase.rpc('log_wallet_transaction', {
                  p_user_id: p.user_id,
                  p_wallet_type: 'PLAYER',
                  p_amount: refundAmount,
                  p_type: 'credit',
                  p_category: 'refund',
                  p_description: `Tournament cancelled (insufficient players): ${tournament.name}`,
                  p_table_id: null,
                  p_hand_id: null,
                  p_related_entity_id: tournament.id,
                });
                if (logErr)
                  console.error(
                    `[GameServer] Refund log FAILED for ${p.user_id.slice(0, 8)}: ${logErr.message}`
                  );
              } catch (refundErr) {
                console.error(
                  `[GameServer] Refund exception for ${p.user_id.slice(0, 8)}:`,
                  refundErr
                );
              }
            }
            await supabase.from('tournament_players').delete().eq('tournament_id', tournament.id);
            await supabase
              .from('tournaments')
              .update({ status: 'CANCELLED' })
              .eq('id', tournament.id);
            continue;
          }

          // SNG / Spin: start ONLY when max_players reached (not time-based)
          // MTT / Bounty / PKO / Mystery: start at scheduled time if min_players met
          const isSngOrSpin = tournament.variant === 'sng' || tournament.variant === 'spin';
          const maxReached =
            tournament.max_players > 0 && tournament.current_players >= tournament.max_players;
          const timeReached = startTime <= now && tournament.current_players >= minPlayers;

          // SNG/Spin: only start when full (maxReached)
          // MTT variants: start at scheduled time with minimum players
          const shouldStart = isSngOrSpin ? maxReached : maxReached || timeReached;

          if (shouldStart) {
            const reason = maxReached
              ? `full (${tournament.current_players}/${tournament.max_players})`
              : `${tournament.current_players} players`;
            console.log(`[GameServer] Starting tournament: ${tournament.name} (${reason})`);
            const tm = new TournamentManager(tournament.id, this);
            this.tournamentEngines.set(tournament.id, tm);
            tm.start().catch((err) => {
              console.error(`[GameServer] Tournament start failed for ${tournament.name}:`, err);
              this.tournamentEngines.delete(tournament.id);
            });
          }
        }

        // Find RUNNING tournaments that need resuming
        const { data: running } = await supabase
          .from('tournaments')
          .select('id, name')
          .eq('status', 'RUNNING');

        for (const tournament of running || []) {
          if (this.tournamentEngines.has(tournament.id)) continue;

          console.log(`[GameServer] Resuming tournament: ${tournament.name}`);
          const tm = new TournamentManager(tournament.id, this);
          this.tournamentEngines.set(tournament.id, tm);
          tm.resume().catch((err) => {
            console.error(`[GameServer] Tournament resume failed for ${tournament.name}:`, err);
            this.tournamentEngines.delete(tournament.id);
          });
        }

        // Clean up completed tournaments
        for (const [id, tm] of this.tournamentEngines) {
          if (!tm.isRunning()) {
            this.tournamentEngines.delete(id);
          }
        }

        // ── STUCK COMPLETING RECOVERY ──
        // If a tournament has been in COMPLETING status for > 5 minutes, force it to COMPLETED.
        // This handles crashes/failures during the finishTournament flow.
        const { data: stuckTournaments } = await supabase
          .from('tournaments')
          .select('id, name, status')
          .eq('status', 'COMPLETING');

        for (const stuck of stuckTournaments || []) {
          if (!this.tournamentEngines.has(stuck.id)) {
            // No active engine managing this tournament — it's truly stuck
            console.warn(
              `[GameServer] Recovering stuck COMPLETING tournament: ${stuck.name} (${stuck.id.slice(0, 8)})`
            );
            await supabase
              .from('tournaments')
              .update({ status: 'COMPLETED', ended_at: new Date().toISOString() })
              .eq('id', stuck.id)
              .eq('status', 'COMPLETING');
          }
        }
      } catch (err) {
        console.error('[GameServer] Tournament discovery error:', err);
      }

      await this.sleep(TOURNAMENT_DISCOVERY_INTERVAL);
    }
  }

  /**
   * Register a table engine (used by TournamentManager for tournament tables)
   */
  registerTableEngine(tableId: string, engine: ServerTableEngine): void {
    this.tableEngines.set(tableId, engine);
  }

  /**
   * Get a table engine by ID (used by HTTP action endpoint)
   */
  getTableEngine(tableId: string): ServerTableEngine | undefined {
    return this.tableEngines.get(tableId);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT MANAGER — Server-Side Tournament Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

class TournamentManager {
  private tournamentId: string;
  private gameServer: GameServer;
  private running: boolean = false;
  private blindTimer: NodeJS.Timeout | null = null;
  private eliminationTimer: NodeJS.Timeout | null = null;
  private tableEngines: Map<string, ServerTableEngine> = new Map();
  private currentLevel: number = 0;
  // Add-on period
  private addOnPeriodTriggered: boolean = false;
  private pendingAddOnPeriod: boolean = false;
  // Hand-for-hand bubble
  private handForHandActive: boolean = false;
  private handForHandAnnounced: boolean = false;
  // Final table detection
  private isFinalTable: boolean = false;
  // Synchronized break state
  private onBreak: boolean = false;
  private savedBlindTimerRemaining: number = 0;
  private blindTimerStartedAt: number = 0;
  // Hand-for-hand sync
  private handForHandSyncInterval: NodeJS.Timeout | null = null;
  private handForHandRePauseTimer: NodeJS.Timeout | null = null;
  // Late reg finalization
  private prizePoolFinalized: boolean = false;
  // Tournament metadata cache
  private tournamentCache: any = null;
  // Reusable broadcast channel (prevents memory leak from creating per-event)
  private broadcastChannel: any = null;
  private broadcastReady: boolean = false;

  constructor(tournamentId: string, gameServer: GameServer) {
    this.tournamentId = tournamentId;
    this.gameServer = gameServer;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Reusable broadcast — single channel per tournament lifecycle */
  private async broadcast(eventType: string, payload: any): Promise<void> {
    try {
      if (!this.broadcastChannel) {
        this.broadcastChannel = supabase.channel(`t-break-${this.tournamentId}`);
        await this.broadcastChannel.subscribe();
        this.broadcastReady = true;
      }
      await this.broadcastChannel.send({
        type: 'broadcast',
        event: 'tournament_event',
        payload: { type: eventType, payload },
      });
    } catch (e) {
      console.error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Broadcast ${eventType} failed:`,
        e
      );
      // Reset channel on error so next call re-creates
      this.broadcastChannel = null;
      this.broadcastReady = false;
    }
  }

  /** Clean up broadcast channel when tournament ends */
  private async cleanupBroadcastChannel(): Promise<void> {
    if (this.broadcastChannel) {
      try {
        await this.broadcastChannel.unsubscribe();
      } catch {}
      this.broadcastChannel = null;
      this.broadcastReady = false;
    }
  }

  /** Synchronized break: pause blind timer and broadcast break event */
  async pauseForBreak(breakDurationMs: number): Promise<void> {
    if (!this.running || this.onBreak) return;
    this.onBreak = true;

    // Save remaining blind timer time
    if (this.blindTimer) {
      const elapsed = Date.now() - this.blindTimerStartedAt;
      const blindStructure = this.tournamentCache?.blind_structure || [];
      if (!blindStructure || blindStructure.length === 0) return;
      const currentLevelData =
        blindStructure[Math.min(this.currentLevel, blindStructure.length - 1)];
      const totalMs = (currentLevelData?.durationMinutes || 10) * 60 * 1000;
      this.savedBlindTimerRemaining = Math.max(totalMs - elapsed, 1000);
      clearTimeout(this.blindTimer);
      this.blindTimer = null;
    }

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] SYNCHRONIZED BREAK — ${Math.round(breakDurationMs / 60000)} minutes`
    );

    const blindStructure = this.tournamentCache?.blind_structure || [];
    const nextLevel = blindStructure[Math.min(this.currentLevel, blindStructure.length - 1)];
    await this.broadcast('tournament_break', {
      level: this.currentLevel,
      breakDurationMinutes: Math.round(breakDurationMs / 60000),
      breakEndsAt: new Date(Date.now() + breakDurationMs).toISOString(),
      synchronized: true,
      nextLevel: nextLevel
        ? {
            smallBlind: nextLevel.smallBlind,
            bigBlind: nextLevel.bigBlind,
            ante: nextLevel.ante || 0,
          }
        : null,
    });
  }

  /** Resume from synchronized break: restart blind timer with remaining time */
  async resumeFromBreak(): Promise<void> {
    if (!this.running || !this.onBreak) return;
    this.onBreak = false;

    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] BREAK ENDED — resuming play`);
    await this.broadcast('break_ended', { level: this.currentLevel });

    // Restart blind timer with saved remaining time
    if (this.savedBlindTimerRemaining > 0) {
      const blindStructure = this.tournamentCache?.blind_structure || [];
      this.blindTimerStartedAt = Date.now();
      this.blindTimer = setTimeout(() => {
        if (!this.running) return;
        this.currentLevel++;
        if (this.currentLevel >= blindStructure.length) {
          this.currentLevel = blindStructure.length - 1;
          return;
        }
        this.startBlindTimer(blindStructure);
      }, this.savedBlindTimerRemaining);
    }

    // If add-on period was deferred due to break, trigger it now
    if (this.pendingAddOnPeriod && !this.addOnPeriodTriggered) {
      this.pendingAddOnPeriod = false;
      await this.triggerAddOnPeriod();
    }
  }

  /** Check if this is an MTT or XMTT (eligible for synchronized breaks) */
  isMttOrXmtt(): boolean {
    const type = this.tournamentCache?.tournament_type;
    const variant = this.tournamentCache?.variant;
    if (type === 'SNG' || type === 'SPIN' || variant === 'sng' || variant === 'spin') return false;
    return true;
  }

  /** Start hand-for-hand sync: check every 500ms if all tables finished their hand */
  private startHandForHandSync(): void {
    if (this.handForHandSyncInterval) return;

    this.handForHandSyncInterval = setInterval(() => {
      if (!this.handForHandActive || !this.running) {
        this.stopHandForHandSync();
        return;
      }

      // Check if ALL table engines are waiting for hand-for-hand resume
      const engines = Array.from(this.tableEngines.values());
      if (engines.length === 0) return;

      const allWaiting = engines.every((e) => e.isWaitingForHandForHand());
      if (allWaiting) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Hand-for-hand: all ${engines.length} tables done — resuming for next hand`
        );
        // Resume all engines together for the next hand, then immediately re-pause
        for (const engine of engines) {
          engine.resumeDealing();
        }
        // Re-pause for next hand-for-hand cycle (if still active)
        if (this.handForHandActive) {
          if (this.handForHandRePauseTimer) clearTimeout(this.handForHandRePauseTimer);
          this.handForHandRePauseTimer = setTimeout(() => {
            if (!this.running) return; // Tournament may have ended
            this.handForHandRePauseTimer = null;
            for (const engine of this.tableEngines.values()) {
              engine.pauseAfterHand();
            }
          }, 500); // Small delay to let dealing start
        }
      }
    }, 500);
  }

  /** Stop hand-for-hand sync check */
  private stopHandForHandSync(): void {
    if (this.handForHandSyncInterval) {
      clearInterval(this.handForHandSyncInterval);
      this.handForHandSyncInterval = null;
    }
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] Starting...`);

    try {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', this.tournamentId)
        .single();

      if (!tournament) throw new Error('Tournament not found');
      this.tournamentCache = tournament;
      this.prizePoolFinalized = tournament.prize_pool_finalized || false;

      // Enforce minimum 3 players
      const { count: regCount } = await supabase
        .from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'registered');

      if ((regCount || 0) < 3) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Only ${regCount} player(s) — cancelling (minimum 3)`
        );
        // Refund all registered players
        const { data: regPlayers } = await supabase
          .from('tournament_players')
          .select('user_id')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'registered');
        const refundAmt = (tournament.buy_in_amount || 0) + (tournament.buy_in_fee || 0);
        for (const p of regPlayers || []) {
          try {
            const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
              p_user_id: p.user_id,
              p_amount: refundAmt,
            });
            if (creditErr) {
              console.error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Refund FAILED for ${p.user_id.slice(0, 8)}: ${creditErr.message}`
              );
              continue;
            }
            const { error: logErr } = await supabase.rpc('log_wallet_transaction', {
              p_user_id: p.user_id,
              p_wallet_type: 'PLAYER',
              p_amount: refundAmt,
              p_type: 'credit',
              p_category: 'refund',
              p_description: `Tournament cancelled (insufficient players): ${tournament.name}`,
              p_table_id: null,
              p_hand_id: null,
              p_related_entity_id: this.tournamentId,
            });
            if (logErr)
              console.error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Refund log FAILED for ${p.user_id.slice(0, 8)}: ${logErr.message}`
              );
          } catch (refundErr) {
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Refund exception for ${p.user_id.slice(0, 8)}:`,
              refundErr
            );
          }
        }
        await supabase.from('tournament_players').delete().eq('tournament_id', this.tournamentId);
        await supabase
          .from('tournaments')
          .update({ status: 'CANCELLED' })
          .eq('id', this.tournamentId);
        this.running = false;
        return;
      }

      // Spin & Go: use multiplier from creation (already rolled by TournamentRecurringService)
      // Only re-roll if somehow missing (safety fallback)
      if (tournament.variant === 'spin' || tournament.tournament_type === 'SPIN') {
        let spinMultiplier = tournament.spin_multiplier || 0;

        if (!spinMultiplier || spinMultiplier <= 0) {
          // Safety fallback — roll now if creation didn't set one
          const SPIN_STANDARD = [
            { multiplier: 2, weight: 925000 }, // 92.50% → EV 1.8500
            { multiplier: 3, weight: 50000 }, //  5.00% → EV 0.1500
            { multiplier: 5, weight: 18000 }, //  1.80% → EV 0.0900
            { multiplier: 10, weight: 5000 }, //  0.50% → EV 0.0500
            { multiplier: 25, weight: 1500 }, //  0.15% → EV 0.0375
            { multiplier: 100, weight: 400 }, //  0.04% → EV 0.0400
            { multiplier: 240, weight: 100 }, //  0.01% → EV 0.0240
          ];

          const SPIN_HYPER = [
            { multiplier: 2, weight: 910000 }, // 91.00% → EV 1.8200
            { multiplier: 3, weight: 55000 }, //  5.50% → EV 0.1650
            { multiplier: 5, weight: 22000 }, //  2.20% → EV 0.1100
            { multiplier: 10, weight: 8000 }, //  0.80% → EV 0.0800
            { multiplier: 25, weight: 3500 }, //  0.35% → EV 0.0875
            { multiplier: 100, weight: 400 }, //  0.04% → EV 0.0400
            { multiplier: 240, weight: 100 }, //  0.01% → EV 0.0240
          ];

          const SPIN_MULTIPLIERS = tournament.spin_type === 'hyper' ? SPIN_HYPER : SPIN_STANDARD;
          const totalWeight = SPIN_MULTIPLIERS.reduce((s, m) => s + m.weight, 0);
          let roll = Math.random() * totalWeight;
          spinMultiplier = 2;
          for (const tier of SPIN_MULTIPLIERS) {
            roll -= tier.weight;
            if (roll <= 0) {
              spinMultiplier = tier.multiplier;
              break;
            }
          }
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Spin multiplier was missing — rolled ${spinMultiplier}x as fallback`
          );
        }

        // Prize pool = buy_in * multiplier (NOT net_buy_in * players * multiplier)
        const buyIn = tournament.buy_in_amount || 0;
        const prizePool = Math.trunc(buyIn * spinMultiplier * 100) / 100;

        await supabase
          .from('tournaments')
          .update({
            prize_pool: prizePool,
            spin_multiplier: spinMultiplier,
            is_premium_spin: spinMultiplier >= 100,
          })
          .eq('id', this.tournamentId);

        tournament.prize_pool = prizePool;
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] SPIN MULTIPLIER: ${spinMultiplier}x — Prize Pool: ${prizePool}`
        );
      }

      // Migrate registrations (registered -> playing)
      await supabase
        .from('tournament_players')
        .update({ status: 'playing', chips: tournament.starting_chips })
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'registered');

      // Create tables and seat players
      await this.createTablesAndSeatPlayers(tournament);

      // Set tournament to RUNNING
      // Guard: only transition REGISTERING → RUNNING (prevents re-starting)
      await supabase
        .from('tournaments')
        .update({ status: 'RUNNING', started_at: new Date().toISOString() })
        .eq('id', this.tournamentId)
        .eq('status', 'REGISTERING');

      // Validate payout structure sums to 100% (or close enough to prevent chip leak)
      if (this.tournamentCache?.payout_structure) {
        let payouts = this.tournamentCache.payout_structure;
        if (typeof payouts === 'string') {
          try {
            payouts = JSON.parse(payouts);
          } catch {
            payouts = [];
          }
        }
        if (Array.isArray(payouts) && payouts.length > 0) {
          const totalPct = payouts.reduce((sum: number, p: any) => sum + (p.percentage || 0), 0);
          if (totalPct > 0 && Math.abs(totalPct - 100) > 0.01) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] WARNING: Payout percentages sum to ${totalPct}% (expected 100%). Normalizing.`
            );
            // Normalize percentages proportionally using exact truncation
            // Distribute remainder to 1st place to ensure sum = exactly 100
            let sumNormalized = 0;
            payouts = payouts.map((p: any, idx: number) => {
              const normalized = Math.trunc((p.percentage / totalPct) * 100 * 100) / 100;
              sumNormalized += normalized;
              return { ...p, percentage: normalized };
            });
            // Fix rounding remainder — assign to 1st place
            let remainder = 100 - sumNormalized;
            if (Math.abs(remainder) > 0.01 && payouts.length > 0) {
              payouts[0].percentage = Math.trunc((payouts[0].percentage + remainder) * 100) / 100;
            }
            await supabase
              .from('tournaments')
              .update({ payout_structure: payouts })
              .eq('id', this.tournamentId);
          }
        }
      }

      // Start table engines
      for (const [tableId, engine] of this.tableEngines) {
        this.gameServer.registerTableEngine(tableId, engine);
        engine
          .start()
          .catch((err) =>
            console.error(`[Tournament:${this.tournamentId.slice(0, 8)}] Table engine error:`, err)
          );
      }

      // Start blind timer
      this.startBlindTimer(tournament.blind_structure || []);

      // Start elimination checker
      this.startEliminationChecker();

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] RUNNING — ${this.tableEngines.size} tables`
      );
    } catch (err) {
      console.error(`[Tournament:${this.tournamentId.slice(0, 8)}] Start failed:`, err);
      this.running = false;
    }
  }

  async resume(): Promise<void> {
    this.running = true;
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] Resuming...`);

    try {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', this.tournamentId)
        .single();

      if (!tournament) throw new Error('Tournament not found');
      this.tournamentCache = tournament;
      this.prizePoolFinalized = tournament.prize_pool_finalized || false;

      // Find existing tables
      const { data: tables } = await supabase
        .from('tables')
        .select('id')
        .eq('tournament_id', this.tournamentId)
        .in('status', ['running', 'waiting']);

      for (const table of tables || []) {
        const engine = new ServerTableEngine(table.id);
        this.tableEngines.set(table.id, engine);
        this.gameServer.registerTableEngine(table.id, engine);
        engine
          .start()
          .catch((err) =>
            console.error(`[Tournament:${this.tournamentId.slice(0, 8)}] Resume table error:`, err)
          );
      }

      // Restore blind level
      this.currentLevel = tournament.current_level || 0;
      // Reset hand-for-hand state on resume so it can be triggered again
      this.handForHandActive = false;
      this.handForHandAnnounced = false;
      // Initialize broadcast channel on resume
      this.broadcastChannel = null;
      this.broadcastReady = false;
      this.startBlindTimer(tournament.blind_structure || []);
      this.startEliminationChecker();

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Resumed — ${this.tableEngines.size} tables, level ${this.currentLevel}`
      );
    } catch (err) {
      console.error(`[Tournament:${this.tournamentId.slice(0, 8)}] Resume failed:`, err);
      this.running = false;
    }
  }

  stop(): void {
    // Clear intervals FIRST to prevent them firing during teardown
    if (this.blindTimer) {
      clearTimeout(this.blindTimer);
      this.blindTimer = null;
    }
    if (this.eliminationTimer) {
      clearInterval(this.eliminationTimer);
      this.eliminationTimer = null;
    }
    this.running = false;
    for (const engine of this.tableEngines.values()) {
      engine.stop();
    }
    this.tableEngines.clear();
    // Cleanup hand-for-hand sync
    this.stopHandForHandSync();
    if (this.handForHandRePauseTimer) {
      clearTimeout(this.handForHandRePauseTimer);
      this.handForHandRePauseTimer = null;
    }
    // Best-effort cleanup of broadcast channel (non-async in sync stop)
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.unsubscribe();
      } catch {}
      this.broadcastChannel = null;
      this.broadcastReady = false;
    }
  }

  private async createTablesAndSeatPlayers(tournament: any): Promise<void> {
    const { data: players } = await supabase
      .from('tournament_players')
      .select('user_id, chips')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing');

    if (!players || players.length === 0) throw new Error('No players');

    // Determine table size based on tournament type
    let maxPerTable = tournament.max_players || 9;
    const tType = (tournament.tournament_type || '').toUpperCase();
    const variant = (tournament.variant || '').toLowerCase();
    if (variant === 'spin' || tType === 'SPIN') {
      maxPerTable = 3;
    } else if (variant === 'sng' || tType === 'SNG') {
      maxPerTable = Math.min(tournament.max_players || 6, 9);
    } else {
      maxPerTable = 9; // Standard MTT tables
    }
    const numTables = Math.ceil(players.length / maxPerTable);

    for (let i = 0; i < numTables; i++) {
      const blindStructure = tournament.blind_structure || [];
      const firstLevel = blindStructure[0] || { smallBlind: 10, bigBlind: 20 };

      const { data: table, error } = await supabase
        .from('tables')
        .insert({
          club_id: tournament.club_id,
          tournament_id: this.tournamentId,
          name: `${tournament.name} - Table ${i + 1}`,
          game_type: 'tournament',
          game_variant: tournament.game_type?.toLowerCase() || 'nlh',
          stakes: `${firstLevel.smallBlind}/${firstLevel.bigBlind}`,
          small_blind: firstLevel.smallBlind,
          big_blind: firstLevel.bigBlind,
          min_buy_in: 0,
          max_buy_in: 0,
          max_players: maxPerTable,
          current_players: 0,
          status: 'running',
        })
        .select()
        .single();

      if (error || !table) {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Failed to create table:`,
          error
        );
        continue;
      }

      const engine = new ServerTableEngine(table.id);
      this.tableEngines.set(table.id, engine);
    }

    // Round-robin seat players
    const tableIds = [...this.tableEngines.keys()];
    for (let i = 0; i < players.length; i++) {
      const tableId = tableIds[i % tableIds.length];
      const seatNumber = Math.floor(i / tableIds.length) + 1;

      const { error: seatErr } = await supabase.from('table_seats').insert({
        table_id: tableId,
        user_id: players[i].user_id,
        seat_number: seatNumber,
        stack: players[i].chips || tournament.starting_chips,
        joined_at: new Date().toISOString(),
      });
      if (seatErr) {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Failed to seat ${players[i].user_id.slice(0, 8)}: ${seatErr.message}`
        );
      }
    }

    // Update player counts
    for (const tableId of tableIds) {
      const { count } = await supabase
        .from('table_seats')
        .select('*', { count: 'exact', head: true })
        .eq('table_id', tableId)
        .is('left_at', null);
      await supabase
        .from('tables')
        .update({ current_players: count || 0 })
        .eq('id', tableId);
    }
  }

  private startBlindTimer(blindStructure: any[]): void {
    if (blindStructure.length === 0) return;

    // Use a recursive timeout pattern to handle per-level durations
    const scheduleNextLevel = () => {
      if (!this.running) return;
      const currentLevelData = blindStructure[this.currentLevel] || blindStructure[0];
      const durationMs = (currentLevelData?.durationMinutes || 10) * 60 * 1000;

      this.blindTimerStartedAt = Date.now();
      this.blindTimer = setTimeout(async () => {
        if (!this.running) return;
        const prevLevel = this.currentLevel;
        this.currentLevel++;

        if (this.currentLevel >= blindStructure.length) {
          // Auto-escalate: double the last level's blinds
          const lastLevel = blindStructure[blindStructure.length - 1];
          const escalationFactor = Math.pow(2, this.currentLevel - blindStructure.length + 1);
          const autoLevel = {
            level: this.currentLevel + 1,
            smallBlind: lastLevel.smallBlind * escalationFactor,
            bigBlind: lastLevel.bigBlind * escalationFactor,
            ante: (lastLevel.ante || 0) * escalationFactor,
            durationMinutes: Math.max(lastLevel.durationMinutes || 3, 2), // Keep same duration, min 2 min
          };
          blindStructure.push(autoLevel);
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Auto-escalated blinds: ${autoLevel.smallBlind}/${autoLevel.bigBlind} ante ${autoLevel.ante}`
          );
        }

        const level = blindStructure[Math.min(this.currentLevel, blindStructure.length - 1)];

        // Skip any break entries that might still be in old blind structures
        if (level.isBreak) {
          scheduleNextLevel();
          return;
        }

        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Level ${this.currentLevel}: ${level.smallBlind}/${level.bigBlind} ante ${level.ante || 0}`
        );

        for (const tableId of this.tableEngines.keys()) {
          const { error: blindErr } = await supabase
            .from('tables')
            .update({
              small_blind: level.smallBlind,
              big_blind: level.bigBlind,
              ante: level.ante || 0,
            })
            .eq('id', tableId);
          if (blindErr)
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Blind update failed for table ${tableId.slice(0, 8)}: ${blindErr.message}`
            );
        }

        const { error: levelErr } = await supabase
          .from('tournaments')
          .update({ current_level: this.currentLevel })
          .eq('id', this.tournamentId);
        if (levelErr)
          console.error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Level persist failed: ${levelErr.message}`
          );

        // Broadcast level_up event to all table pages
        await this.broadcast('level_up', {
          level: this.currentLevel,
          blinds: `${level.smallBlind}/${level.bigBlind}`,
          smallBlind: level.smallBlind,
          bigBlind: level.bigBlind,
          ante: level.ante || 0,
        });

        // ── LATE REG / REBUY PERIOD FINALIZATION (level-based) ──
        // Late reg and rebuy share the same cutoff level
        const lateRegLevelCap =
          this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 0;
        if (
          !this.prizePoolFinalized &&
          lateRegLevelCap > 0 &&
          this.currentLevel >= lateRegLevelCap
        ) {
          // Check if add-on is available — if so, defer finalization until add-on period ends
          if (!this.tournamentCache?.add_on_available) {
            this.prizePoolFinalized = true;
            const { data: freshT } = await supabase
              .from('tournaments')
              .select('prize_pool')
              .eq('id', this.tournamentId)
              .single();
            if (freshT) {
              await supabase
                .from('tournaments')
                .update({
                  prize_pool: freshT.prize_pool,
                  prize_pool_finalized: true,
                } as any)
                .eq('id', this.tournamentId);
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Late reg/rebuy closed at level ${this.currentLevel} — prize pool finalized: ${freshT.prize_pool}`
              );
            }
            await this.broadcast('late_reg_closed', { prizePool: freshT?.prize_pool || 0 });
            if (freshT) {
              await this.recalculateEliminatedPrizes(freshT.prize_pool);
            }
          }
        }

        // ── ADD-ON PERIOD TRIGGER (level-based) ──
        // When blind level passes the late reg/rebuy cutoff and add-on is available
        if (this.tournamentCache?.add_on_available && !this.addOnPeriodTriggered) {
          const rebuyLevelCap =
            this.tournamentCache.late_reg_levels ?? this.tournamentCache.rebuy_levels ?? 8;
          if (prevLevel < rebuyLevelCap && this.currentLevel >= rebuyLevelCap) {
            // Broadcast late_reg_closed first
            await this.broadcast('late_reg_closed', {});
            // If currently on break, defer the add-on trigger until break resumes
            if (this.onBreak) {
              this.pendingAddOnPeriod = true;
            } else {
              await this.triggerAddOnPeriod();
            }
          }
        }

        // ── ADD-ON PERIOD END (level-based) ──
        // Add-on window closes after addon_levels levels past the rebuy cutoff
        if (this.addOnPeriodTriggered && !this.prizePoolFinalized) {
          const rebuyLevelCap2 =
            this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 8;
          const addonWindow = this.tournamentCache?.addon_levels ?? 1;
          if (this.currentLevel >= rebuyLevelCap2 + addonWindow) {
            await this.finalizeAfterAddOn();
          }
        }

        // Schedule the next level
        scheduleNextLevel();
      }, durationMs);
    };

    scheduleNextLevel();
  }

  private async triggerAddOnPeriod(): Promise<void> {
    if (this.addOnPeriodTriggered) return;
    this.addOnPeriodTriggered = true;

    const addonCost = this.tournamentCache?.addon_cost || this.tournamentCache?.buy_in_amount || 0;
    const addonChips =
      this.tournamentCache?.addon_chips || this.tournamentCache?.starting_chips || 0;
    const addonLevels = this.tournamentCache?.addon_levels ?? 1;
    const rebuyLevelCap =
      this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 8;

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ON PERIOD START — ${addonLevels} level(s) (Level ${rebuyLevelCap} to ${rebuyLevelCap + addonLevels}), cost: ${addonCost}, chips: ${addonChips}`
    );

    // Broadcast ADDON_PERIOD_START via Supabase Realtime (no fixed duration — level-based)
    await this.broadcast('ADDON_PERIOD_START', {
      addOnCost: addonCost,
      addOnChips: addonChips,
      addonLevels,
      startLevel: rebuyLevelCap,
      endLevel: rebuyLevelCap + addonLevels,
    });

    // NOTE: Add-on period end is now handled by the level-up handler (finalizeAfterAddOn)
    // No more hardcoded 60-second timer!
  }

  private async finalizeAfterAddOn(): Promise<void> {
    if (this.prizePoolFinalized) return;

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ON PERIOD ENDED at level ${this.currentLevel} — finalizing prize pool`
    );

    this.prizePoolFinalized = true;
    const { data: freshT } = await supabase
      .from('tournaments')
      .select('prize_pool')
      .eq('id', this.tournamentId)
      .single();
    if (freshT) {
      await supabase
        .from('tournaments')
        .update({
          prize_pool: freshT.prize_pool,
          prize_pool_finalized: true,
        } as any)
        .eq('id', this.tournamentId);

      await this.recalculateEliminatedPrizes(freshT.prize_pool);
    }

    await this.broadcast('ADDON_PERIOD_END', {});
  }

  private isProcessingEliminations = false;

  private startEliminationChecker(): void {
    this.eliminationTimer = setInterval(async () => {
      if (!this.running || this.isProcessingEliminations) return;
      this.isProcessingEliminations = true;

      try {
        // ── SYNC STACKS: table_seats → tournament_players ──
        // The poker engine updates table_seats.stack after each hand.
        // We must sync these back to tournament_players.chips for elimination detection.
        for (const [tableId] of this.tableEngines) {
          const { data: seats } = await supabase
            .from('table_seats')
            .select('user_id, stack')
            .eq('table_id', tableId)
            .is('left_at', null);

          if (seats) {
            for (const seat of seats) {
              // Guard against corrupted stack values (NaN, negative, undefined)
              const stackValue =
                typeof seat.stack === 'number' && !isNaN(seat.stack) && seat.stack >= 0
                  ? seat.stack
                  : 0;
              await supabase
                .from('tournament_players')
                .update({ chips: stackValue })
                .eq('tournament_id', this.tournamentId)
                .eq('user_id', seat.user_id)
                .eq('status', 'playing');
            }
          }
        }

        // Find ALL busted players (0 chips) in a single query
        const { data: busted } = await supabase
          .from('tournament_players')
          .select('user_id, chips')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing')
          .lte('chips', 0);

        if (busted && busted.length > 0) {
          // Get current remaining count BEFORE processing any eliminations
          const { count: playingCount } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', this.tournamentId)
            .eq('status', 'playing');

          // Position calculation for simultaneous busts:
          // All players busting at the same time get TIED (same position)
          // If 10 playing and 3 bust simultaneously, all 3 get position 10 (tied)
          // Single bust: position = playingCount (e.g., 10 remaining → 10th place)
          const basePosition = playingCount || busted.length;

          for (let i = 0; i < busted.length; i++) {
            // All simultaneous busts get the same position (tied)
            await this.eliminatePlayer(busted[i].user_id, basePosition);
          }
        }

        // Check remaining players AFTER all eliminations processed
        const { count: remainingCount } = await supabase
          .from('tournament_players')
          .select('*', { count: 'exact', head: true })
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'playing');

        if ((remainingCount || 0) <= 1) {
          try {
            // Use maybeSingle to handle edge case where 0 players remain
            const { data: winner } = await supabase
              .from('tournament_players')
              .select('user_id')
              .eq('tournament_id', this.tournamentId)
              .eq('status', 'playing')
              .maybeSingle();

            if (winner) {
              await this.finishTournament(winner.user_id);
            } else if ((remainingCount || 0) === 0) {
              // All players busted simultaneously — pick the last eliminated as winner
              const { data: lastEliminated } = await supabase
                .from('tournament_players')
                .select('user_id')
                .eq('tournament_id', this.tournamentId)
                .eq('status', 'eliminated')
                .order('eliminated_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              if (lastEliminated) {
                console.log(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] All busted simultaneously — last eliminated wins`
                );
                await this.finishTournament(lastEliminated.user_id);
              }
            }
          } catch (finishErr) {
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] finishTournament error — will retry next cycle:`,
              finishErr
            );
          }
        }

        await this.checkTableBalance();

        // ── HAND-FOR-HAND BUBBLE MODE ──
        // Multi-table tournaments only (not Spin/SNG single-table)
        if (this.tableEngines.size > 1 && this.tournamentCache) {
          const isSpin =
            this.tournamentCache.variant === 'spin' ||
            this.tournamentCache.tournament_type === 'SPIN';
          if (!isSpin) {
            const { count: playingNow } = await supabase
              .from('tournament_players')
              .select('*', { count: 'exact', head: true })
              .eq('tournament_id', this.tournamentId)
              .eq('status', 'playing');

            let payoutCount = 0;
            if (this.tournamentCache.payout_structure) {
              let payouts = this.tournamentCache.payout_structure;
              if (typeof payouts === 'string') {
                try {
                  payouts = JSON.parse(payouts);
                } catch {
                  payouts = [];
                }
              }
              if (Array.isArray(payouts)) payoutCount = payouts.length;
            }

            if (
              payoutCount > 0 &&
              (playingNow || 0) === payoutCount + 1 &&
              !this.handForHandActive
            ) {
              this.handForHandActive = true;
              if (!this.handForHandAnnounced) {
                this.handForHandAnnounced = true;
                console.log(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] HAND-FOR-HAND — ${playingNow} players, ${payoutCount} paid`
                );
                await this.broadcast('hand_for_hand', {
                  active: true,
                  playersRemaining: playingNow,
                  paidPositions: payoutCount,
                });
                // Pause all table engines for hand-for-hand sync
                for (const engine of this.tableEngines.values()) {
                  engine.pauseAfterHand();
                }
                // Start hand-for-hand sync check
                this.startHandForHandSync();
              }
            } else if (this.handForHandActive && (playingNow || 0) <= payoutCount) {
              // Bubble burst — resume normal play
              this.handForHandActive = false;
              this.stopHandForHandSync();
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] BUBBLE BURST — ${playingNow} players ITM`
              );
              await this.broadcast('bubble_burst', { playersRemaining: playingNow });
              // Resume all engines permanently
              for (const engine of this.tableEngines.values()) {
                engine.resumeDealing();
              }
            }
          }
        }
      } catch (err) {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Elimination check error:`,
          err
        );
      } finally {
        this.isProcessingEliminations = false;
      }
    }, 5000);
  }

  private async eliminatePlayer(userId: string, position: number): Promise<void> {
    // Guard: check if already eliminated (prevents double-processing)
    const { data: playerCheck, error: checkErr } = await supabase
      .from('tournament_players')
      .select('status')
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (
      checkErr ||
      !playerCheck ||
      playerCheck.status === 'eliminated' ||
      playerCheck.status === 'winner'
    ) {
      return; // Already processed
    }

    const { data: tournament } = await supabase
      .from('tournaments')
      .select(
        'payout_structure, prize_pool, is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max'
      )
      .eq('id', this.tournamentId)
      .single();

    let prize = 0;
    if (tournament?.payout_structure) {
      let payouts = tournament.payout_structure;
      if (typeof payouts === 'string') {
        try {
          payouts = JSON.parse(payouts);
        } catch {
          payouts = [];
        }
      }
      if (Array.isArray(payouts)) {
        const payoutEntry = payouts.find((p: any) => p.place === position);
        if (payoutEntry) {
          // Exact cent-precision: truncate sub-cent fractions
          const prizeRaw = ((tournament.prize_pool || 0) * payoutEntry.percentage) / 100;
          prize = Math.trunc(prizeRaw * 100) / 100;
        }
      }
    }

    const { error: updateErr, count: updateCount } = await supabase
      .from('tournament_players')
      .update({
        status: 'eliminated',
        position,
        prize,
        eliminated_at: new Date().toISOString(),
      })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', userId)
      .eq('status', 'playing'); // Only update if still playing (prevents double-processing)

    if (updateErr || (updateCount !== null && updateCount === 0)) {
      return; // Player was already eliminated by another process
    }

    if (prize > 0) {
      // Retry prize credit up to 3 times with exponential backoff
      let creditSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
          p_user_id: userId,
          p_amount: prize,
        });
        if (!creditErr) {
          creditSuccess = true;
          break;
        }
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Prize credit attempt ${attempt}/3 failed for ${userId.slice(0, 8)}: ${creditErr.message}`
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }
      if (creditSuccess) {
        const { error: prizeLogErr } = await supabase.rpc('log_wallet_transaction', {
          p_user_id: userId,
          p_wallet_type: 'PLAYER',
          p_amount: prize,
          p_type: 'credit',
          p_category: 'prize',
          p_description: `Tournament prize: position ${position}`,
          p_table_id: null,
          p_hand_id: null,
          p_related_entity_id: this.tournamentId,
        });
        if (prizeLogErr)
          console.error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Prize log FAILED for ${userId.slice(0, 8)}: ${prizeLogErr.message}`
          );
      } else {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Prize credit FAILED after 3 retries for ${userId.slice(0, 8)} — ${prize} chips lost`
        );
      }
    }

    // ── BOUNTY / PKO / MYSTERY BOUNTY COLLECTION ──
    // Determine who knocked this player out by finding the last hand winner at their table
    const hasBounty = tournament?.is_bounty || tournament?.is_pko || tournament?.is_mystery_bounty;
    if (hasBounty && tournament) {
      try {
        // Find the table this player is seated at (left_at still null — not yet marked as left)
        const { data: seat } = await supabase
          .from('table_seats')
          .select('table_id')
          .eq('user_id', userId)
          .is('left_at', null)
          .limit(1)
          .maybeSingle();

        // Find the most recent hand at that table to determine the knocker
        let knockerId: string | null = null;
        if (seat?.table_id) {
          const { data: lastHand } = await supabase
            .from('hand_history')
            .select('winners')
            .eq('table_id', seat.table_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (lastHand?.winners && Array.isArray(lastHand.winners)) {
            // The knocker is the hand winner (first winner — the one who took the pot)
            const winnerEntry = lastHand.winners.find(
              (w: any) => (w.userId || w.user_id) !== userId
            );
            knockerId = winnerEntry ? winnerEntry.userId || winnerEntry.user_id : null;
          }
        }

        if (knockerId) {
          await this.processBountyCollection(tournament, userId, knockerId);
        } else {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Could not determine knocker for ${userId.slice(0, 8)} — bounty skipped`
          );
        }
      } catch (bountyErr) {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty processing error:`,
          bountyErr
        );
      }
    }

    await supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('left_at', null);

    // Broadcast player_eliminated event to all table pages
    await this.broadcast('player_eliminated', { userId, position, prize });

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] Eliminated: ${userId.slice(0, 8)} at position ${position} (prize: ${prize})`
    );
  }

  /**
   * Process bounty collection: fixed, progressive (PKO), or mystery bounty
   */
  private async processBountyCollection(
    tournament: any,
    eliminatedUserId: string,
    knockerUserId: string
  ): Promise<void> {
    // Guard against duplicate bounty collection (race condition)
    const { data: existingBounty } = await supabase
      .from('tournament_bounties')
      .select('id')
      .eq('tournament_id', this.tournamentId)
      .eq('eliminated_player_id', eliminatedUserId)
      .maybeSingle();
    if (existingBounty) {
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty already collected for ${eliminatedUserId.slice(0, 8)} — skipping duplicate`
      );
      return;
    }

    const baseBounty = tournament.bounty_amount || 0;

    // Get eliminated player's current bounty (may be higher than base for PKO)
    const { data: eliminatedPlayer } = await supabase
      .from('tournament_players')
      .select('current_bounty')
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', eliminatedUserId)
      .single();

    const bountyValue = eliminatedPlayer?.current_bounty || baseBounty;

    if (tournament.is_pko) {
      // ── PROGRESSIVE KO ──
      // 50% to knocker immediately, 50% added to knocker's bounty head
      const totalBountyCents = Math.trunc(bountyValue * 100);
      const knockerCents = Math.trunc(totalBountyCents / 2);
      const knockerPortion = knockerCents / 100;
      const addedToHead = (totalBountyCents - knockerCents) / 100;

      // Get knocker's current bounty
      const { data: knocker } = await supabase
        .from('tournament_players')
        .select('current_bounty, bounties_collected, bounty_winnings')
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', knockerUserId)
        .single();

      const newKnockerBounty = (knocker?.current_bounty || baseBounty) + addedToHead;

      // Update knocker's bounty head + stats
      await supabase
        .from('tournament_players')
        .update({
          current_bounty: newKnockerBounty,
          bounties_collected: (knocker?.bounties_collected || 0) + 1,
          bounty_winnings:
            Math.trunc(((knocker?.bounty_winnings || 0) + knockerPortion) * 100) / 100,
        })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', knockerUserId);

      // Credit knocker portion to wallet
      await this.creditBountyToWallet(knockerUserId, knockerPortion, eliminatedUserId);

      // Record bounty in tournament_bounties
      await supabase.from('tournament_bounties').insert({
        tournament_id: this.tournamentId,
        eliminated_player_id: eliminatedUserId,
        collector_player_id: knockerUserId,
        bounty_amount: knockerPortion,
        added_to_collector_bounty: addedToHead,
      });

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] PKO: ${knockerUserId.slice(0, 8)} collected ${knockerPortion} bounty from ${eliminatedUserId.slice(0, 8)} (+${addedToHead} to head, now ${newKnockerBounty})`
      );
    } else if (tournament.is_mystery_bounty) {
      // ── MYSTERY BOUNTY ──
      // Roll a random mystery value from configured tiers
      const mysteryTiers = [
        { min: 1, max: 1, probability: 60 },
        { min: 2, max: 2, probability: 25 },
        { min: 5, max: 5, probability: 10 },
        { min: 10, max: 10, probability: 4 },
        {
          min: tournament.mystery_bounty_max || 50,
          max: tournament.mystery_bounty_max || 50,
          probability: 1,
        },
      ];

      let mysteryMultiplier = 1;
      const roll = Math.random() * 100;
      let cumulative = 0;
      for (const tier of mysteryTiers) {
        cumulative += tier.probability;
        if (roll <= cumulative) {
          mysteryMultiplier =
            tier.min === tier.max
              ? tier.min
              : Math.floor(Math.random() * (tier.max - tier.min + 1)) + tier.min;
          break;
        }
      }

      const mysteryValue = Math.trunc(baseBounty * mysteryMultiplier * 100) / 100;

      // Update knocker stats
      const { data: knocker } = await supabase
        .from('tournament_players')
        .select('bounties_collected, bounty_winnings')
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', knockerUserId)
        .single();

      await supabase
        .from('tournament_players')
        .update({
          bounties_collected: (knocker?.bounties_collected || 0) + 1,
          bounty_winnings: Math.trunc(((knocker?.bounty_winnings || 0) + mysteryValue) * 100) / 100,
        })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', knockerUserId);

      // Credit mystery bounty to wallet
      await this.creditBountyToWallet(knockerUserId, mysteryValue, eliminatedUserId);

      // Record bounty
      await supabase.from('tournament_bounties').insert({
        tournament_id: this.tournamentId,
        eliminated_player_id: eliminatedUserId,
        collector_player_id: knockerUserId,
        bounty_amount: mysteryValue,
        is_mystery_revealed: true,
      });

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] MYSTERY BOUNTY: ${knockerUserId.slice(0, 8)} revealed ${mysteryValue} (${mysteryMultiplier}x) from ${eliminatedUserId.slice(0, 8)}`
      );
    } else {
      // ── FIXED BOUNTY (KO) ──
      const { data: knocker } = await supabase
        .from('tournament_players')
        .select('bounties_collected, bounty_winnings')
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', knockerUserId)
        .single();

      await supabase
        .from('tournament_players')
        .update({
          bounties_collected: (knocker?.bounties_collected || 0) + 1,
          bounty_winnings: Math.trunc(((knocker?.bounty_winnings || 0) + bountyValue) * 100) / 100,
        })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', knockerUserId);

      // Credit fixed bounty to wallet
      await this.creditBountyToWallet(knockerUserId, bountyValue, eliminatedUserId);

      // Record bounty
      await supabase.from('tournament_bounties').insert({
        tournament_id: this.tournamentId,
        eliminated_player_id: eliminatedUserId,
        collector_player_id: knockerUserId,
        bounty_amount: bountyValue,
      });

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] BOUNTY: ${knockerUserId.slice(0, 8)} collected ${bountyValue} from ${eliminatedUserId.slice(0, 8)}`
      );
    }
  }

  /**
   * Credit bounty amount to knocker's wallet with transaction logging
   */
  private async creditBountyToWallet(
    knockerUserId: string,
    amount: number,
    eliminatedUserId: string
  ): Promise<void> {
    // Retry bounty credit up to 3 times with exponential backoff
    let creditSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
        p_user_id: knockerUserId,
        p_amount: amount,
      });
      if (!creditErr) {
        creditSuccess = true;
        break;
      }
      console.error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty credit attempt ${attempt}/3 failed for ${knockerUserId.slice(0, 8)}: ${creditErr.message}`
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }

    if (!creditSuccess) {
      console.error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Bounty credit FAILED after 3 retries for ${knockerUserId.slice(0, 8)} — ${amount} chips lost`
      );
      return;
    }

    const { error: bountyLogErr } = await supabase.rpc('log_wallet_transaction', {
      p_user_id: knockerUserId,
      p_wallet_type: 'PLAYER',
      p_amount: amount,
      p_type: 'credit',
      p_category: 'bounty',
      p_description: `Bounty collected from eliminated player`,
      p_table_id: null,
      p_hand_id: null,
      p_related_entity_id: this.tournamentId,
    });
    if (bountyLogErr)
      console.error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty log FAILED for ${knockerUserId.slice(0, 8)}: ${bountyLogErr.message}`
      );
  }

  /**
   * Recalculate prizes for players eliminated during late reg.
   * When the prize pool grows during late reg, early eliminations got smaller prizes.
   * This credits the difference now that the final pool is known.
   */
  private async recalculateEliminatedPrizes(finalPrizePool: number): Promise<void> {
    const { data: eliminated } = await supabase
      .from('tournament_players')
      .select('user_id, position, prize')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'eliminated')
      .gt('prize', 0); // Only ITM players

    if (!eliminated || eliminated.length === 0) return;

    let payouts = this.tournamentCache?.payout_structure;
    if (typeof payouts === 'string') {
      try {
        payouts = JSON.parse(payouts);
      } catch {
        payouts = [];
      }
    }
    if (!Array.isArray(payouts)) return;

    for (const player of eliminated) {
      const payoutEntry = payouts.find((p: any) => p.place === player.position);
      if (!payoutEntry) continue;

      const correctPrize =
        Math.trunc(((finalPrizePool * payoutEntry.percentage) / 100) * 100) / 100;
      const difference = Math.trunc((correctPrize - (player.prize || 0)) * 100) / 100;

      if (difference > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Prize recalc: ${player.user_id.slice(0, 8)} pos ${player.position} — old: ${player.prize}, new: ${correctPrize}, diff: +${difference}`
        );

        // Credit the difference
        const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
          p_user_id: player.user_id,
          p_amount: difference,
        });

        if (!creditErr) {
          // Update the recorded prize
          await supabase
            .from('tournament_players')
            .update({ prize: correctPrize })
            .eq('tournament_id', this.tournamentId)
            .eq('user_id', player.user_id);

          // Log the adjustment
          await supabase.rpc('log_wallet_transaction', {
            p_user_id: player.user_id,
            p_wallet_type: 'PLAYER',
            p_amount: difference,
            p_type: 'credit',
            p_category: 'prize',
            p_description: `Tournament prize adjustment (late reg pool finalized): position ${player.position}`,
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: this.tournamentId,
          });
        } else {
          console.error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Prize recalc credit FAILED for ${player.user_id.slice(0, 8)}: ${creditErr.message}`
          );
        }
      }
    }
  }

  private tournamentFinished = false;

  private async finishTournament(winnerId: string): Promise<void> {
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] COMPLETE! Winner: ${winnerId.slice(0, 8)}`
    );

    // Atomic DB guard: only proceed if we can claim the RUNNING → COMPLETING transition
    const { data: claimResult } = await supabase
      .from('tournaments')
      .update({ status: 'COMPLETING' } as any)
      .eq('id', this.tournamentId)
      .eq('status', 'RUNNING')
      .select('id')
      .maybeSingle();

    if (!claimResult) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Could not claim finish — already finishing/completed`
      );
      return;
    }

    // Guard: prevent double-finishing (set AFTER DB guard succeeds)
    if (this.tournamentFinished) return;
    this.tournamentFinished = true;

    const { data: tournament, error: tourneyLoadErr } = await supabase
      .from('tournaments')
      .select('payout_structure, prize_pool, buy_in_fee, current_players, club_id, name, status')
      .eq('id', this.tournamentId)
      .single();

    if (!tournament || tourneyLoadErr) {
      console.error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Could not load tournament for finish: ${tourneyLoadErr?.message} — marking COMPLETED without payouts`
      );
      await supabase
        .from('tournaments')
        .update({ status: 'COMPLETED', ended_at: new Date().toISOString() })
        .eq('id', this.tournamentId);
      this.stop();
      return;
    }

    // Calculate winner prize — with fallback if payout_structure missing or no place 1
    let winnerPrize = 0;
    if (tournament?.payout_structure) {
      let payouts = tournament.payout_structure;
      if (typeof payouts === 'string') {
        try {
          payouts = JSON.parse(payouts);
        } catch {
          payouts = [];
        }
      }
      const firstPlace = Array.isArray(payouts) ? payouts.find((p: any) => p.place === 1) : null;
      if (firstPlace) {
        const prizeRaw = ((tournament.prize_pool || 0) * firstPlace.percentage) / 100;
        winnerPrize = Math.trunc(prizeRaw * 100) / 100;
      } else {
        // FALLBACK: no place 1 in structure — award 100% of prize pool to winner
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] payout_structure missing place 1 — awarding full prize pool to winner`
        );
        winnerPrize = Math.trunc((tournament.prize_pool || 0) * 100) / 100;
      }
    } else {
      // No payout_structure at all — award full prize pool
      console.warn(
        `[Tournament:${this.tournamentId.slice(0, 8)}] No payout_structure — awarding full prize pool to winner`
      );
      winnerPrize = Math.trunc((tournament?.prize_pool || 0) * 100) / 100;
    }

    if (winnerPrize > 0) {
      // Retry winner prize credit up to 3 times
      let creditSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error: creditErr } = await supabase.rpc('credit_player_wallet', {
          p_user_id: winnerId,
          p_amount: winnerPrize,
        });
        if (!creditErr) {
          creditSuccess = true;
          break;
        }
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Winner prize credit attempt ${attempt}/3 failed: ${creditErr.message}`
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }

      if (creditSuccess) {
        const { error: prizeLogErr } = await supabase.rpc('log_wallet_transaction', {
          p_user_id: winnerId,
          p_wallet_type: 'PLAYER',
          p_amount: winnerPrize,
          p_type: 'credit',
          p_category: 'prize',
          p_description: `Tournament winner prize: 1st place`,
          p_table_id: null,
          p_hand_id: null,
          p_related_entity_id: this.tournamentId,
        });
        if (prizeLogErr)
          console.error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Prize log FAILED for ${winnerId.slice(0, 8)}: ${prizeLogErr.message}`
          );
      } else {
        console.error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Winner prize credit FAILED after 3 retries for ${winnerId.slice(0, 8)} — ${winnerPrize} chips lost`
        );
      }
    }

    await supabase
      .from('tournament_players')
      .update({ status: 'winner', position: 1, prize: winnerPrize })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', winnerId);

    // ── TOURNAMENT RAKE SETTLEMENT ──
    // Rake is held by union (if club is in a union) or by standalone club owner.
    // Union distributes 90% rake back to clubs weekly. Union holds all BBJ & promo.
    const rakePerEntry = tournament?.buy_in_fee || 0;
    const totalEntries = tournament?.current_players || 0;
    const totalRake = Math.trunc(rakePerEntry * totalEntries * 100) / 100;

    if (totalRake > 0 && tournament?.club_id) {
      // Get club + union info
      const { data: club } = await supabase
        .from('clubs')
        .select('owner_id, name, union_id')
        .eq('id', tournament.club_id)
        .single();

      if (club) {
        let rakeRecipientId: string | null = null;
        let rakeDescription = '';

        if (club.union_id) {
          // Club is in a union — rake goes to union owner (held until weekly settlement)
          const { data: union } = await supabase
            .from('unions')
            .select('owner_id, name')
            .eq('id', club.union_id)
            .single();

          if (union?.owner_id) {
            rakeRecipientId = union.owner_id;
            rakeDescription = `Tournament rake held by ${union.name || 'Union'}: ${tournament.name || 'tournament'} (${totalEntries} entries x ${rakePerEntry}) — ${club.name || 'club'}`;
          } else {
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Union ${club.union_id} has no owner_id — ${totalRake} rake LOST`
            );
          }
        } else {
          // Standalone club — rake goes directly to club owner
          if (club.owner_id) {
            rakeRecipientId = club.owner_id;
            rakeDescription = `Tournament rake: ${tournament.name || 'tournament'} (${totalEntries} entries x ${rakePerEntry})`;
          } else {
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Club ${tournament.club_id} has no owner_id — ${totalRake} rake LOST`
            );
          }
        }

        if (rakeRecipientId) {
          // Retry rake credit up to 3 times
          let rakeSuccess = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const { error: rakeErr } = await supabase.rpc('credit_player_wallet', {
              p_user_id: rakeRecipientId,
              p_amount: totalRake,
            });
            if (!rakeErr) {
              rakeSuccess = true;
              break;
            }
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake credit attempt ${attempt}/3 failed: ${rakeErr.message}`
            );
            if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
          }

          if (rakeSuccess) {
            const { error: txErr } = await supabase.rpc('log_wallet_transaction', {
              p_user_id: rakeRecipientId,
              p_wallet_type: 'PLAYER',
              p_amount: totalRake,
              p_type: 'credit',
              p_category: 'rake',
              p_description: rakeDescription,
              p_table_id: null,
              p_hand_id: null,
              p_related_entity_id: this.tournamentId,
            });
            if (txErr)
              console.error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Rake transaction log failed: ${txErr.message}`
              );
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settled: ${totalRake} to ${club.union_id ? 'union' : 'club'} owner ${rakeRecipientId.slice(0, 8)}`
            );
          } else {
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Rake credit FAILED after 3 retries — ${totalRake} chips LOST for recipient ${rakeRecipientId.slice(0, 8)}`
            );
          }
        }
      }
    }

    // Update tournament with total_rake and mark completed
    await supabase
      .from('tournaments')
      .update({
        status: 'COMPLETED',
        ended_at: new Date().toISOString(),
        total_rake: totalRake,
      })
      .eq('id', this.tournamentId)
      .eq('status', 'COMPLETING'); // Guard: only COMPLETING → COMPLETED

    for (const [tableId, engine] of this.tableEngines) {
      await engine.stop();
      await supabase.from('tables').update({ status: 'closed' }).eq('id', tableId);
    }

    // Clean up the reusable broadcast channel
    await this.cleanupBroadcastChannel();

    this.stop();
  }

  private async checkTableBalance(): Promise<void> {
    // Check for final table (9 or fewer players remaining) — only announce once
    if (!this.isFinalTable) {
      const { count: remainingPlayers } = await supabase
        .from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');

      if ((remainingPlayers || 0) <= 9) {
        this.isFinalTable = true;
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] FINAL TABLE reached with ${remainingPlayers} players`
        );
        await this.broadcast('final_table', { playerCount: remainingPlayers || 0 });
      }
    }

    if (this.tableEngines.size <= 1) return;

    const tableCounts: { tableId: string; count: number }[] = [];
    for (const tableId of this.tableEngines.keys()) {
      const { count } = await supabase
        .from('table_seats')
        .select('*', { count: 'exact', head: true })
        .eq('table_id', tableId)
        .is('left_at', null);
      tableCounts.push({ tableId, count: count || 0 });
    }

    for (const tc of tableCounts) {
      if (tc.count < 3 && tc.count > 0 && tableCounts.length > 1) {
        const target = tableCounts.find((t) => t.tableId !== tc.tableId && t.count > 0);
        if (target && target.count + tc.count <= 9) {
          console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] Merging tables`);

          const { data: seats } = await supabase
            .from('table_seats')
            .select('user_id, stack, seat_number')
            .eq('table_id', tc.tableId)
            .is('left_at', null);

          let nextSeat = target.count + 1;
          for (const seat of seats || []) {
            // Mark old seat as left FIRST to prevent duplicate active seats
            await supabase
              .from('table_seats')
              .update({ left_at: new Date().toISOString() })
              .eq('table_id', tc.tableId)
              .eq('user_id', seat.user_id)
              .is('left_at', null);

            // Then insert new seat at target table
            await supabase.from('table_seats').insert({
              table_id: target.tableId,
              user_id: seat.user_id,
              seat_number: nextSeat++,
              stack: seat.stack,
              joined_at: new Date().toISOString(),
            });

            // Update tournament_players table_id
            await supabase
              .from('tournament_players')
              .update({ table_id: target.tableId })
              .eq('tournament_id', this.tournamentId)
              .eq('user_id', seat.user_id);
          }

          const engine = this.tableEngines.get(tc.tableId);
          if (engine) {
            // Wait for any active hand to complete before stopping
            // Check if a hand is in progress by looking for an active hand
            const { data: activeHand } = await supabase
              .from('hand_history')
              .select('id')
              .eq('table_id', tc.tableId)
              .is('ended_at', null)
              .maybeSingle();

            if (activeHand) {
              // Hand in progress — wait up to 30 seconds for it to finish
              let waited = 0;
              while (waited < 30000 && this.running) {
                await new Promise((r) => setTimeout(r, 2000));
                waited += 2000;
                const { data: still } = await supabase
                  .from('hand_history')
                  .select('id')
                  .eq('id', activeHand.id)
                  .is('ended_at', null)
                  .maybeSingle();
                if (!still) break; // Hand completed
              }
            }
            await engine.stop();
          }
          this.tableEngines.delete(tc.tableId);
          await supabase.from('tables').update({ status: 'closed' }).eq('id', tc.tableId);

          // Broadcast table_rebalance so clients refresh seats
          await this.broadcast('table_rebalance', {
            closedTableId: tc.tableId,
            targetTableId: target.tableId,
            movedPlayers: (seats || []).length,
          });

          break; // One merge per cycle
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP HEALTH CHECK SERVER — Required for Fly.io / monitoring
// ═══════════════════════════════════════════════════════════════════════════════

const gameServer = new GameServer();

// ═══════════════════════════════════════════════════════════════════════════════
// CORS HEADERS — Allow frontend to call action endpoints
// ═══════════════════════════════════════════════════════════════════════════════

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function sendJSON(res: import('http').ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const httpServer = createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = req.url || '/';

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /health — Health check for monitoring / Fly.io
  // ─────────────────────────────────────────────────────────────────────────
  if (url === '/health' || url === '/') {
    return sendJSON(res, 200, gameServer.getStatus());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /action — Submit a player action (fold/call/raise/check/all-in)
  // Body: { tableId, userId, action, amount? }
  // ─────────────────────────────────────────────────────────────────────────
  if (method === 'POST' && url === '/action') {
    try {
      const body = JSON.parse(await readBody(req));
      const { tableId, userId, action, amount } = body;

      if (!tableId || !userId || !action) {
        return sendJSON(res, 400, { success: false, error: 'Missing tableId, userId, or action' });
      }

      const engine = gameServer.getTableEngine(tableId);
      if (!engine) {
        return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
      }

      const result = engine.handlePlayerAction(userId, action, amount);
      return sendJSON(res, result.success ? 200 : 400, result);
    } catch (err: any) {
      console.error('[HTTP] /action error:', err.message);
      return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /timebank — Activate Time Bank extension
  // Body: { tableId, userId }
  // ─────────────────────────────────────────────────────────────────────────
  if (method === 'POST' && url === '/timebank') {
    try {
      const body = JSON.parse(await readBody(req));
      const { tableId, userId } = body;

      if (!tableId || !userId) {
        return sendJSON(res, 400, { success: false, error: 'Missing tableId or userId' });
      }

      const engine = gameServer.getTableEngine(tableId);
      if (!engine) {
        return sendJSON(res, 404, { success: false, error: 'Table engine not found' });
      }

      const result = engine.activateTimeBank(userId);
      return sendJSON(res, result.success ? 200 : 400, result);
    } catch (err: any) {
      console.error('[HTTP] /timebank error:', err.message);
      return sendJSON(res, 500, { success: false, error: 'Invalid request body' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /actions/:tableId/:userId — Get available actions for a player
  // ─────────────────────────────────────────────────────────────────────────
  const actionsMatch = url.match(/^\/actions\/([^/]+)\/([^/]+)$/);
  if (method === 'GET' && actionsMatch) {
    const tableId = actionsMatch[1];
    const userId = actionsMatch[2];

    const engine = gameServer.getTableEngine(tableId);
    if (!engine) {
      return sendJSON(res, 404, { canAct: false, error: 'Table engine not found' });
    }

    const actions = engine.getPlayerActions(userId);
    return sendJSON(res, 200, actions);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 404 — Not Found
  // ─────────────────────────────────────────────────────────────────────────
  sendJSON(res, 404, { error: 'Not Found' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

httpServer.listen(PORT, () => {
  console.log(`[HTTP] Health check server listening on port ${PORT}`);
  gameServer.start().catch((err) => {
    console.error('[GameServer] Fatal error:', err);
    process.exit(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

const shutdown = async () => {
  console.log('\n[GameServer] Received shutdown signal...');
  await gameServer.stop();
  httpServer.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[GameServer] Uncaught exception:', err);
  // Don't crash — keep running
});
process.on('unhandledRejection', (err) => {
  console.error('[GameServer] Unhandled rejection:', err);
  // Don't crash — keep running
});
