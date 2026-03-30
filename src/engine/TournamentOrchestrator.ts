import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { masterBus } from '../core/MasterBus';
import { TournamentEngine } from './TournamentEngine';
import { tableBalancer, type BalancerTable } from './TableBalancer';
import { reportError } from '../utils/errorReporter';

/**
 * TOURNAMENT ORCHESTRATOR
 * Master service that watches for active tournaments, spins up TournamentEngine instances,
 * and manages their lifecycle.
 * Designed to be run from an active Admin / Node context.
 */
export class TournamentOrchestrator {
  private activeEngines: Map<string, TournamentEngine> = new Map();
  private isRunning: boolean = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  // Enhancement #3: Dedup notification emissions (with periodic cleanup)
  private notifiedTournaments: Set<string> = new Set();
  private notificationCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  // Guard against concurrent spinUp calls for same tournament
  private spinningUpTournaments: Set<string> = new Set();

  // Singleton instance
  private static instance: TournamentOrchestrator;

  private constructor() {}

  static getInstance(): TournamentOrchestrator {
    if (!TournamentOrchestrator.instance) {
      TournamentOrchestrator.instance = new TournamentOrchestrator();
    }
    return TournamentOrchestrator.instance;
  }

  /**
   * Start the global orchestrator
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    // 1. Initial spin up of all running/starting tournaments
    await this.syncActiveTournaments();

    // 2. Set up Supabase Realtime subscription on tournaments
    try {
      this.realtimeChannel = supabase
        .channel('tournament-orchestrator-tournaments')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tournaments',
          },

          (payload: any) => {
            const { eventType, new: newRow } = payload;
            if (eventType === 'INSERT' || eventType === 'UPDATE') {
              const tournamentId = newRow?.id;
              const status = newRow?.status;
              if (!tournamentId) return;

              // Spin up if status is active and not already tracked (idempotent check)
              if (
                ['REGISTERING', 'ANNOUNCED', 'RUNNING'].includes(status) &&
                !this.activeEngines.has(tournamentId) &&
                !this.spinningUpTournaments.has(tournamentId)
              ) {
                if (status === 'RUNNING') {
                  this.spinUpTournament(tournamentId).catch((err) => {
                    reportError(err, 'TournamentOrchestrator.Realtime_spinUp_failed_for_tournamentId');
                  });
                } else if (newRow?.started_at) {
                  const startTime = new Date(newRow.started_at).getTime();
                  if (Date.now() >= startTime - 60_000) {
                    this.spinUpTournament(tournamentId).catch((err) => {
                      reportError(err, 'TournamentOrchestrator.Realtime_spinUp_failed_for_tournamentId');
                    });
                  }
                }
              }

              // Tear down if finished/cancelled
              if (
                ['FINISHED', 'CANCELLED'].includes(status) &&
                this.activeEngines.has(tournamentId)
              ) {
                const engine = this.activeEngines.get(tournamentId)!;
                engine.stop();
                this.activeEngines.delete(tournamentId);
                this.spinningUpTournaments.delete(tournamentId);
              }
            }
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            reportError(err?.message || err, 'TournamentOrchestrator._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[TournamentOrchestrator] ⏱️ Realtime channel timed out');
          }
        });
    } catch (err: unknown) {
      reportError(err, 'TournamentOrchestrator.Realtime_subscription_failed_relying_on_');
    }

    // 3. Keep 60s polling as fallback
    this.pollInterval = setInterval(() => {
      this.syncActiveTournaments();
    }, 60_000);

    // 4. Periodic cleanup of notification dedup set (every 6 hours)
    this.notificationCleanupInterval = setInterval(
      () => {
        this.notifiedTournaments.clear();
      },
      6 * 60 * 60 * 1000
    );
  }

  /**
   * Stop the orchestrator and all engines gracefully
   */
  async stop() {
    this.isRunning = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.notificationCleanupInterval) clearInterval(this.notificationCleanupInterval);

    // Unsubscribe from Realtime channel
    if (this.realtimeChannel) {
      supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }

    // Stop all engines (await for clean shutdown)
    const stopPromises: Promise<void>[] = [];
    for (const [tournamentId, engine] of this.activeEngines.entries()) {
      stopPromises.push(
        Promise.resolve(engine.stop()).then(() => {
          this.activeEngines.delete(tournamentId);
          this.spinningUpTournaments.delete(tournamentId);
        })
      );
    }
    await Promise.all(stopPromises);
  }

  /**
   * Check stats (thread-safe snapshot)
   */
  getStats() {
    const engines = Array.from(this.activeEngines.values());
    return {
      running: this.isRunning,
      activeTournaments: engines.length,
      totalPlayers: engines.reduce((acc, e) => acc + e.getPlayerCount(), 0),
      totalTables: engines.reduce((acc, e) => acc + e.getTableCount(), 0),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  private async syncActiveTournaments() {
    if (!this.isRunning) return;

    try {
      // Find all tournaments that are registering, announced, or running
      const { data, error } = await supabase
        .from('tournaments')
        .select('id, status, started_at')
        .in('status', ['REGISTERING', 'ANNOUNCED', 'RUNNING']);

      if (error) throw error;

      const currentTournaments = new Map((data || []).map((t) => [t.id, t]));

      // 1. Start engines for new tournaments (avoid race conditions)
      for (const [tournamentId, tInfo] of currentTournaments.entries()) {
        if (
          !this.activeEngines.has(tournamentId) &&
          !this.spinningUpTournaments.has(tournamentId)
        ) {
          // For REGISTERING/ANNOUNCED, determine if it's time to start
          if (tInfo.status === 'REGISTERING' || tInfo.status === 'ANNOUNCED') {
            if (tInfo.started_at) {
              const startTime = new Date(tInfo.started_at).getTime();
              const now = Date.now();
              // If it's within 1 minute of starting, or already past, boot it up
              if (now >= startTime - 60_000) {
                this.spinUpTournament(tournamentId).catch((err) => {
                  reportError(err, 'TournamentOrchestrator.Sync_spinUp_failed_for_tournamentId');
                });
              }
            }
          } else if (tInfo.status === 'RUNNING') {
            // Always re-hydrate running tournaments (crash recovery)
            this.spinUpTournament(tournamentId).catch((err) => {
              reportError(err, 'TournamentOrchestrator.Sync_spinUp_failed_for_tournamentId');
            });
          }
        }
      }

      // 2. Stop and remove engines for closed tournaments
      for (const [tournamentId, engine] of Array.from(this.activeEngines.entries())) {
        if (!currentTournaments.has(tournamentId) || !engine.isRunning()) {
          engine.stop();
          this.activeEngines.delete(tournamentId);
          this.spinningUpTournaments.delete(tournamentId);
        }
      }

      // 3. Check for upcoming tournament notification windows (24h / 1h)
      await this.checkNotificationHooks();
    } catch (err: unknown) {
      reportError(err, 'TournamentOrchestrator.Error_syncing_active_tournaments');
    }
  }

  private async spinUpTournament(tournamentId: string): Promise<void> {
    // Prevent race condition: only one spinUp per tournament at a time
    if (this.spinningUpTournaments.has(tournamentId)) {
      return; // Already spinning up, skip
    }

    this.spinningUpTournaments.add(tournamentId);

    try {
      const engine = new TournamentEngine(tournamentId, supabase);
      this.activeEngines.set(tournamentId, engine);

      // Await the start to ensure engine is actually ready before marking complete
      await engine.start();
    } catch (err) {
      reportError(err, 'TournamentOrchestrator.Engine_failed_to_start_for_tournamentId');
      this.activeEngines.delete(tournamentId);
      throw err; // Re-throw for caller to handle
    } finally {
      this.spinningUpTournaments.delete(tournamentId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // MULTI-DAY FLIGHT SUPPORT (Day 1 bag-and-tag → Day 2 resume)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Bag-and-tag: Save all remaining players' chip counts at end of Day 1.
   * Creates entries in `tournament_flights` with status 'bagged'.
   */
  async handleMultiDayFlight(tournamentId: string): Promise<void> {
    const engine = this.activeEngines.get(tournamentId);
    if (!engine) {
      reportError(new Error(`[TournamentOrchestrator] No active engine for ${tournamentId}`), 'TournamentOrchestrator.No_active_engine_for_tournamentId');
      return;
    }

    try {
      // 1. Get all remaining players and their chip stacks
      const { data: players, error } = await supabase
        .from('tournament_players')
        .select('user_id, chips')
        .eq('tournament_id', tournamentId)
        .eq('status', 'playing');

      if (error) throw error;

      if (!players || players.length === 0) {
        reportError(new Error(`[TournamentOrchestrator] No active players to bag for ${tournamentId}`), 'TournamentOrchestrator.No_active_players_to_bag_for_tournamentI');
        return;
      }

      // 2. Insert bagged chip counts into tournament_flights
      const flightRecords = players.map((p) => ({
        tournament_id: tournamentId,
        user_id: p.user_id,
        bagged_chips: p.chips,
        flight_day: 1,
        status: 'bagged',
        bagged_at: new Date().toISOString(),
      }));

      const { error: insertError } = await supabase
        .from('tournament_flights')
        .upsert(flightRecords, { onConflict: 'tournament_id,user_id' });

      if (insertError) {
        reportError(insertError, 'TournamentOrchestrator.Failed_to_bag_flights');
        return;
      }

      // 3. Pause the tournament
      await supabase
        .from('tournaments')
        .update({ status: 'DAY_BREAK', day1_ended_at: new Date().toISOString() })
        .eq('id', tournamentId);

      // 4. Stop the engine for this tournament (await cleanup)
      await Promise.resolve(engine.stop());
      this.activeEngines.delete(tournamentId);
      this.spinningUpTournaments.delete(tournamentId);
      // 5. Emit bus event
      try {
        const { masterBus } = await import('../core/MasterBus');
        masterBus.emit('FLIGHT_BAGGED', {
          tournamentId,
          playersCount: players.length,
          avgStack: Math.round(
            players.reduce((sum, p) => sum + (p.chips || 0), 0) / players.length
          ),
        });
      } catch {
        /* best effort */
      }
    } catch (err: unknown) {
      reportError(err, 'TournamentOrchestrator.Error_bagging_flight_tournamentId');
    }
  }

  /**
   * Resume Day 2: Restore players with their bagged chip stacks.
   */
  async scheduleDayTwoStart(tournamentId: string): Promise<void> {
    try {
      // 1. Load bagged flights
      const { data: flights, error } = await supabase
        .from('tournament_flights')
        .select('user_id, bagged_chips')
        .eq('tournament_id', tournamentId)
        .eq('status', 'bagged');

      if (error) throw error;
      if (!flights || flights.length === 0) {
        reportError(new Error(`[TournamentOrchestrator] No bagged players for ${tournamentId}`), 'TournamentOrchestrator.No_bagged_players_for_tournamentId');
        return;
      }

      // 2. Restore chip stacks in tournament_players (parallel — each is independent)
      const restoreResults = await Promise.allSettled(
        flights.map((flight) =>
          supabase
            .from('tournament_players')
            .update({ chips: flight.bagged_chips, status: 'playing' })
            .eq('tournament_id', tournamentId)
            .eq('user_id', flight.user_id)
        )
      );
      // Supabase PostgREST returns {error} inside fulfilled promises — check both paths
      const restoreFailures = restoreResults.filter(
        (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value?.error)
      );
      if (restoreFailures.length > 0) {
        reportError(new Error(`[TournamentOrchestrator] CRITICAL: ${restoreFailures.length}/${flights.length} chip restores failed — aborting Day 2 start to prevent players playing with stale chips`), 'TournamentOrchestrator.CRITICAL');
        return; // Bail out — flights stay "bagged" so a retry is safe
      }

      // 3. Mark flights as resumed
      await supabase
        .from('tournament_flights')
        .update({ status: 'resumed', resumed_at: new Date().toISOString() })
        .eq('tournament_id', tournamentId)
        .eq('status', 'bagged');

      // 4. Update tournament status
      await supabase
        .from('tournaments')
        .update({ status: 'RUNNING', day2_started_at: new Date().toISOString() })
        .eq('id', tournamentId);

      // 5. Spin up the engine (await to ensure it starts)
      await this.spinUpTournament(tournamentId);
      // 6. Emit bus event
      try {
        const { masterBus } = await import('../core/MasterBus');
        masterBus.emit('FLIGHT_RESUMED', {
          tournamentId,
          playersResumed: flights.length,
        });
      } catch {
        /* best effort */
      }
    } catch (err: unknown) {
      reportError(err, 'TournamentOrchestrator.Error_starting_Day_2_for_tournamentId');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NOTIFICATION HOOKS — 24h and 1h pre-tournament alerts
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Check all ANNOUNCED tournaments and emit notification events
   * if within 24h or 1h of start time.
   * Call this from the regular sync poll.
   * NOTE: Notification keys are cleared every 6 hours to prevent unbounded memory growth.
   */
  async checkNotificationHooks(): Promise<void> {
    try {
      const now = Date.now();
      const { data: upcoming } = await supabase
        .from('tournaments')
        .select('id, name, started_at, status')
        .eq('status', 'ANNOUNCED')
        .not('started_at', 'is', null);

      if (!upcoming) return;

      const { masterBus } = await import('../core/MasterBus');

      for (const t of upcoming) {
        const startTime = new Date(t.started_at).getTime();
        const diff = startTime - now;

        // 24h notification window: fire once when diff enters [23h, 24h]
        // (i.e., diff is exactly 24h or just under, but not past 23h)
        const key24 = `${t.id}_24h`;
        if (
          diff >= 23 * 60 * 60 * 1000 &&
          diff < 24 * 60 * 60 * 1000 &&
          !this.notifiedTournaments.has(key24)
        ) {
          this.notifiedTournaments.add(key24);
          masterBus.emit('TOURNAMENT_STARTING_24H', {
            tournamentId: t.id,
            name: t.name,
            startsAt: t.started_at,
          });
        }

        // 1h notification window: fire once when diff enters [55m, 1h]
        const key1h = `${t.id}_1h`;
        if (
          diff >= 55 * 60 * 1000 &&
          diff < 60 * 60 * 1000 &&
          !this.notifiedTournaments.has(key1h)
        ) {
          this.notifiedTournaments.add(key1h);
          masterBus.emit('TOURNAMENT_STARTING_1H', {
            tournamentId: t.id,
            name: t.name,
            startsAt: t.started_at,
          });
        }
      }
    } catch (err: unknown) {
      reportError(err, 'TournamentOrchestrator.Error_checking_notification_hooks');
    }
  }
  // ═══════════════════════════════════════════════════════════════════════════════
  // TABLE BALANCING — Post-elimination rebalance check
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Check if tournament tables need rebalancing after an elimination.
   * Called by TournamentEngine elimination handler.
   */
  async checkRebalance(tournamentId: string): Promise<void> {
    try {
      const { data: tables, error } = await supabase
        .from('tables')
        .select('id, name, max_players')
        .eq('tournament_id', tournamentId)
        .neq('status', 'closed');

      if (error || !tables || tables.length < 2) return;

      // Fetch seated player counts per table
      const balancerTables: BalancerTable[] = [];
      for (const table of tables) {
        const { data: seats } = await supabase
          .from('table_seats')
          .select('user_id, stack, seat_number')
          .eq('table_id', table.id)
          .is('left_at', null);

        if (seats) {
          balancerTables.push({
            tableId: table.id,
            playerCount: seats.length,
            maxSeats: table.max_players || 9,
            players: seats.map((s) => ({
              userId: s.user_id,
              stack: s.stack || 0,
              seat: s.seat_number || 1,
            })),
          });
        }
      }

      if (!tableBalancer.shouldRebalance(balancerTables)) return;

      const moves = tableBalancer.calculateMoves(balancerTables);
      if (moves.length === 0) return;
      // Execute each move in Supabase: vacate old seat, insert at new seat
      for (const move of moves) {
        try {
          // Mark old seat as vacated
          await supabase
            .from('table_seats')
            .update({ left_at: new Date().toISOString() })
            .eq('table_id', move.fromTableId)
            .eq('user_id', move.playerId)
            .is('left_at', null);

          // Get current stack for the player
          const playerData = balancerTables
            .find((t) => t.tableId === move.fromTableId)
            ?.players.find((p) => p.userId === move.playerId);

          // Insert at new seat
          const { error: insertErr } = await supabase.from('table_seats').insert({
            table_id: move.toTableId,
            user_id: move.playerId,
            seat_number: move.toSeat,
            stack: playerData?.stack || 0,
            joined_at: new Date().toISOString(),
          });

          if (insertErr) {
            reportError(insertErr, 'TournamentOrchestrator.Seat_insert_failed_for_moveplayerId_at_m');
            // Rollback: re-seat player at their original table
            await supabase.from('table_seats').insert({
              table_id: move.fromTableId,
              user_id: move.playerId,
              seat_number: playerData?.seat || 1,
              stack: playerData?.stack || 0,
              joined_at: new Date().toISOString(),
            });
          } else {
            // Broadcast TABLE_MOVE event so UI can update seat display
            masterBus.emit('TABLE_MOVE', {
              playerId: move.playerId,
              fromTableId: move.fromTableId,
              fromSeat: move.fromSeat,
              toTableId: move.toTableId,
              toSeat: move.toSeat,
              reason: move.reason,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (moveErr: unknown) {
          reportError(moveErr, 'TournamentOrchestrator.Failed_to_move_moveplayerId');
        }
      }
    } catch (err: unknown) {
      reportError(err, 'TournamentOrchestrator.Rebalance_error_for_tournamentId');
    }
  }
}

export const tournamentOrchestrator = TournamentOrchestrator.getInstance();
