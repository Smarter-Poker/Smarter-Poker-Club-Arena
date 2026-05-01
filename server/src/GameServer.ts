/**
 * GameServer + TournamentManager — server-side game orchestration.
 *
 * Extracted from `server/src/index.ts` in Phase U3.4b (2026-04-23) — the
 * final step of the index-monolith split per platform plan §2.3. These two
 * classes are mutually referential (GameServer instantiates TournamentManager,
 * TournamentManager takes a GameServer in its ctor) so they ship together
 * in one module.
 *
 * Behavior preserved byte-identically. No logic changed, only file location.
 */

import { ServerTableEngine } from './engine/ServerTableEngine.js';
import { supabase, atomicCashout } from './services/supabase.js';
import { HorseFleetManager } from './services/HorseFleetManager.js';
import { TournamentRecurringService } from './services/TournamentRecurringService.js';
import { HorseLifecycleManager } from './services/HorseLifecycleManager.js';
import { AutoRebuyService } from './services/AutoRebuyService.js';
// BUG 008 FIX: Periodic rakeback settler — flushes per-hand rake_records into rakeback_periods.
import { RakebackSettlerService } from './services/RakebackSettlerService.js';
// FIX 151: Import ChipRaceEngine for tournament blind level denomination changes
import { ChipRaceEngine } from './engine/ChipRaceEngine.js';
// FIX 154: Import TableBalancer for proper tournament table rebalancing
import { TableBalancer, type BalancerTable, type MoveInstruction } from './engine/TableBalancer.js';
import {
  reportError,
  initSentry,
  flushSentry,
  setServerContext,
} from './services/errorReporter.js';
// Phase 1.1 PR-2: native WebSocket transport for authoritative state
import { tableStateHub } from './transport/TableStateHub.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const TABLE_DISCOVERY_INTERVAL = 5000; // Check for new tables every 5 seconds
const TOURNAMENT_DISCOVERY_INTERVAL = 5000; // Check for tournaments every 5 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// GAME SERVER — Main Orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

export class GameServer {
  private tableEngines: Map<string, ServerTableEngine> = new Map();
  private tournamentEngines: Map<string, TournamentManager> = new Map();
  private running: boolean = false;
  private startTime: number = Date.now();

  // Server-side services (replaces browser-based DealerPage services)
  private horseFleet = new HorseFleetManager();
  private tournamentRecurring = new TournamentRecurringService();
  private lifecycle = new HorseLifecycleManager();
  private autoRebuy = new AutoRebuyService();
  // BUG 008 FIX: settler reads rake_records (durable per-hand log) every 30 min and
  // upserts per-player rakeback_periods rows. Without this the in-memory accumulator
  // inside RakebackEngine never flushes (zero callers of settleRakeback before fix).
  private rakebackSettler = new RakebackSettlerService();

  // Synchronized break timer — all MTT/XMTT tournaments break at the top of every hour
  private breakTimer: NodeJS.Timeout | null = null;
  private breakResumeTimer: NodeJS.Timeout | null = null;
  private static readonly BREAK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

  async start(): Promise<void> {
    this.running = true;
    const maintenanceMode = process.env.MAINTENANCE_MODE === 'true';
    // E2E test mode — when set, MAINTENANCE_MODE still applies (no auto-spawn,
    // no recurring tournaments, no horse fleet) but a single table engine is
    // booted for this exact tableId so a tester can sit down and play hands
    // without the rest of the platform churning. Discovery loops stay off so
    // no other tables get picked up. Lifecycle / auto-rebuy stay off.
    const testTableId = process.env.TEST_TABLE_ID || '';

    // Initialize Sentry FIRST so all subsequent errors are captured
    initSentry();

    console.log('═══════════════════════════════════════════════════════════════');
    console.log(' SMARTER POKER GAME SERVER — Starting...');
    if (testTableId) {
      console.log(` 🧪 E2E TEST MODE — single test table ${testTableId.slice(0, 8)} only`);
    } else if (maintenanceMode) {
      console.log(' ⚠️  MAINTENANCE MODE — No tables, tournaments, or horses will be created');
    } else {
      console.log(' All game logic runs HERE — no browser needed');
    }
    console.log('═══════════════════════════════════════════════════════════════');

    // Step 1: Clean up stale data from previous runs.
    // Test mode passes the protected id so cleanup spares it.
    await this.cleanupStaleData(testTableId);

    if (!maintenanceMode && !testTableId) {
      // Step 2: Start horse fleet manager (creates tables, seats horses)
      await this.horseFleet.start();

      // Step 3: Start tournament recurring service (creates MTTs, SNGs, Spins)
      this.tournamentRecurring.start();

      // Step 4: Start lifecycle manager (stuck horse detection, cleanup)
      this.lifecycle.start();

      // Step 5: Start server-side auto-rebuy wallet funder
      this.autoRebuy.start();

      // Step 5b (BUG 008 FIX): Start periodic rakeback settler (30-min interval).
      // Reads rake_records → upserts rakeback_periods so players see accumulated
      // rakeback in the UI and weekly settlement has rows to pay out.
      this.rakebackSettler.start();

      // Step 6: Start discovery loops (finds tables with players, starts engines)
      // These are infinite while-loops — fire-and-forget with error handling
      this.discoverCashTables().catch((err) =>
        reportError(err, 'GameServer.Cash_table_discovery_fatal_err')
      );
      this.discoverTournaments().catch((err) =>
        reportError(err, 'GameServer.Tournament_discovery_fatal_err')
      );

      // Step 7: Start synchronized break timer (top of every hour, 5 min duration)
      this.scheduleSynchronizedBreaks();

      console.log('[GameServer] Running. All services started.');
    } else if (testTableId) {
      // E2E test mode: boot a single table engine for the designated test id.
      // No other services run — no horse seeding, no tournament expansion,
      // no discovery sweeps, no break timer. Just one table for hand testing.
      try {
        await this.startTableEngineForTesting(testTableId);
        console.log(`[GameServer] E2E test table ${testTableId.slice(0, 8)} engine started.`);
      } catch (err) {
        reportError(err, 'GameServer.E2E_test_table_start_failed');
      }
    } else {
      console.log(
        '[GameServer] Running in MAINTENANCE MODE — only /health and /action endpoints active.'
      );
    }
  }

  /**
   * E2E test mode boot path: starts an engine for one specific table id.
   * Mirrors the relevant portion of discoverCashTables but skips the loop +
   * filter logic. Caller (start()) ensures we only get here when TEST_TABLE_ID
   * is set so this stays out of the normal-operation hot path.
   */
  private async startTableEngineForTesting(tableId: string): Promise<void> {
    if (this.tableEngines.has(tableId)) return;
    const engine = new ServerTableEngine(tableId);
    engine.setHub(tableStateHub); // Phase 1.1 PR-2: authoritative WS publisher
    this.tableEngines.set(tableId, engine);
    // Mirror the discovery-loop start invocation so any errors get reported
    // consistently and the engine cleanup path runs on failure.
    engine.start().catch((err) => {
      reportError(err, 'GameServer.E2E_test_table_engine_start_error');
      this.tableEngines.delete(tableId);
      tableStateHub.dropTable(tableId);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    console.log('[GameServer] Shutting down...');

    // Stop services
    this.horseFleet.stop();
    this.tournamentRecurring.stop();
    this.lifecycle.stop();
    this.autoRebuy.stop();
    this.rakebackSettler.stop();
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

    // Phase 1.1 PR-5: no Supabase Realtime channels to clean up — engine
    // WebSocket server (EngineWebSocketServer.close()) handles its own
    // shutdown; TableStateHub has no channels to close.

    // Flush pending Sentry events before exit
    await flushSentry();

    console.log('[GameServer] Shutdown complete.');
  }

  getStatus() {
    let totalHands = 0;
    // FIX 153: Aggregate telemetry from all table engines for health endpoint
    const tableMetrics: any[] = [];
    for (const [tableId, engine] of this.tableEngines) {
      totalHands += engine.getHandCount();
      const snapshot = engine.getTelemetrySnapshot();
      if (snapshot.tables.length > 0) {
        tableMetrics.push(...snapshot.tables);
      }
    }
    const avgHandDurationMs =
      tableMetrics.length > 0
        ? Math.round(
            tableMetrics.reduce((s, t) => s + t.avgHandDurationMs, 0) / tableMetrics.length
          )
        : 0;
    const avgHandsPerHour =
      tableMetrics.length > 0
        ? Math.round(tableMetrics.reduce((s, t) => s + t.handsPerHour, 0) / tableMetrics.length)
        : 0;
    // Bible V8 §9.1: Aggregate action performance metrics
    let totalActionProcessingMs = 0;
    let actionCount = 0;
    let processingViolations = 0;
    let broadcastViolations = 0;
    for (const [, engine] of this.tableEngines) {
      const snap = engine.getTelemetrySnapshot();
      // Performance summary is on the telemetry instance via engine
      const perf = engine.getPerformanceSummary();
      if (perf) {
        totalActionProcessingMs += perf.avgProcessingMs * perf.actionCount;
        actionCount += perf.actionCount;
        processingViolations += perf.processingViolations;
        broadcastViolations += perf.broadcastViolations;
      }
    }

    return {
      // ── Phase 5.1.4: spec-compliant top-level fields (master plan §8.1.4)
      //   status: 'ok' while the dealer loop is running, 'degraded' otherwise
      //   version: git SHA baked in at build time (GIT_COMMIT_SHA env var)
      //   uptime: seconds since process start
      //   activeTables: live count (also duplicated below for back-compat)
      status: this.running ? 'ok' : 'degraded',
      version: process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local',
      // Existing fields preserved — clients reading `running` / aggregate
      // metrics keep working without change.
      running: this.running,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      activeTables: this.tableEngines.size,
      activeTournaments: this.tournamentEngines.size,
      totalHandsDealt: totalHands,
      telemetry: {
        avgHandDurationMs,
        avgHandsPerHour,
        tablesWithMetrics: tableMetrics.length,
      },
      // Bible V8 §9.1 Performance Instrumentation
      performance: {
        avgActionProcessingMs:
          actionCount > 0 ? Math.round(totalActionProcessingMs / actionCount) : 0,
        totalActionsRecorded: actionCount,
        processingThresholdViolations: processingViolations,
        broadcastThresholdViolations: broadcastViolations,
      },
    };
  }

  /**
   * Bible V8 §10.4: Aggregate Prometheus metrics from all table engines.
   * Returns Prometheus text exposition format for /metrics endpoint.
   */
  getPrometheusMetrics(): string {
    // Aggregate from all engines — each produces per-table lines
    const allLines: string[] = [];
    let isFirst = true;
    for (const [, engine] of this.tableEngines) {
      const metrics = engine.getPrometheusMetrics();
      if (isFirst) {
        // Include headers from first engine
        allLines.push(metrics);
        isFirst = false;
      } else {
        // Skip comment lines (# HELP, # TYPE) for subsequent engines — only data lines
        for (const line of metrics.split('\n')) {
          if (line && !line.startsWith('#')) {
            allLines.push(line);
          }
        }
      }
    }
    if (allLines.length === 0) {
      return '# No active table engines\n';
    }
    return allLines.join('\n') + '\n';
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
        reportError(err, 'GameServer.Failed_to_pause_tournament');
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
          reportError(err, 'GameServer.Failed_to_resume_tournament');
        }
      }
    }, GameServer.BREAK_DURATION_MS);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // STALE DATA CLEANUP — Run on startup
  // ═════════════════════════════════════════════════════════════════════════════

  private async cleanupStaleData(protectedTableId: string = ''): Promise<void> {
    console.log('[GameServer] Cleaning up stale data from previous runs...');
    if (protectedTableId) {
      console.log(
        `[GameServer] E2E test mode — table ${protectedTableId.slice(0, 8)} is PROTECTED from cleanup.`
      );
    }
    try {
      // 1. Batch-reset ALL stuck horses to available (fast single query)
      //    Any horse not at an active table will get re-seated by HorseFleetManager
      await supabase
        .from('profiles')
        .update({ horse_status: 'available', updated_at: new Date().toISOString() })
        .eq('is_horse', true)
        .neq('horse_status', 'available');
      console.log('[GameServer] Reset stuck horses to available');

      // 2. SAFE CLEANUP: Cash out ALL active seats before deleting.
      //    Test table (protectedTableId) is excluded — its seated players /
      //    bots stay put so the tester can join an already-warmed table.
      //    This prevents chip loss when the server restarts while players are seated
      //    FIX 208b: Batch approach — aggregate per user, single wallet update per user
      let seatsQuery = supabase
        .from('table_seats')
        .select('user_id, table_id, seat_number, stack')
        .is('left_at', null);
      if (protectedTableId) {
        seatsQuery = seatsQuery.neq('table_id', protectedTableId);
      }
      const { data: activeSeats } = await seatsQuery;

      if (activeSeats && activeSeats.length > 0) {
        // Aggregate total stack per user
        const userTotals = new Map<string, number>();
        for (const seat of activeSeats) {
          const prev = userTotals.get(seat.user_id) ?? 0;
          userTotals.set(seat.user_id, prev + (seat.stack ?? 0));
        }

        // Credit each user's wallet in parallel (batch of 10)
        // FIX-232: Use atomic RPC increment — eliminates read-then-write race condition
        let cashedOut = 0;
        const entries = Array.from(userTotals.entries()).filter(([_, total]) => total > 0);
        for (let i = 0; i < entries.length; i += 10) {
          const batch = entries.slice(i, i + 10);
          await Promise.all(
            batch.map(async ([userId, totalStack]) => {
              try {
                const { error: walletErr } = await supabase.rpc('credit_player_wallet', {
                  p_user_id: userId,
                  p_amount: totalStack,
                });
                if (walletErr) {
                  console.warn(
                    `[GameServer] Cashout wallet credit failed for ${userId}: ${walletErr.message}`
                  );
                }

                cashedOut++;
              } catch (err: any) {
                console.warn(`[GameServer] Cashout failed for ${userId}: ${err.message}`);
              }
            })
          );
        }

        if (cashedOut > 0) {
          console.log(`[GameServer] Safely cashed out ${cashedOut} seated players before cleanup`);
        }
      }

      // Now delete all table_seats (they should all have left_at set now).
      // Test table seats are spared so bots stay seated for E2E hands.
      let deleteQuery = supabase
        .from('table_seats')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      if (protectedTableId) {
        deleteQuery = deleteQuery.neq('table_id', protectedTableId);
      }
      await deleteQuery;
      console.log('[GameServer] Deleted all table seats (after safe cashout)');

      // 3. FIX 202: Reset cash tables based on horse fleet mode.
      // E2E test mode (protectedTableId) ALWAYS closes everything-but-test
      // and skips the bots-resume path entirely so nothing else lights up.
      const disableHorsesOnCleanup = process.env.DISABLE_HORSE_FLEET === 'true';
      if (protectedTableId) {
        // Close every cash table EXCEPT the protected test table. The test
        // table's status is left untouched so its current state survives the
        // restart and the engine picks it up again immediately.
        await supabase
          .from('tables')
          .update({ current_players: 0, status: 'closed' })
          .is('tournament_id', null)
          .neq('id', protectedTableId)
          .in('status', ['waiting', 'running']);
        console.log(
          `[GameServer] E2E mode: closed all cash tables except ${protectedTableId.slice(0, 8)}`
        );
      } else if (disableHorsesOnCleanup) {
        // When horse fleet is disabled, CLOSE all old running/waiting tables
        // (they were horse-populated and shouldn't be resurrected).
        // Only manually-created tables with the right status will be picked up by discovery.
        await supabase
          .from('tables')
          .update({ current_players: 0, status: 'closed' })
          .is('tournament_id', null)
          .in('status', ['running']);
        console.log('[GameServer] Closed all running cash tables (horse fleet disabled)');
      } else {
        // Normal mode: reset to waiting so HorseFleetManager can re-populate
        await supabase
          .from('tables')
          .update({ current_players: 0, status: 'waiting' })
          .is('tournament_id', null)
          .in('status', ['waiting', 'running', 'closed']);
        console.log('[GameServer] Reset all cash table player counts and statuses to waiting');
      }

      // 4. Cancel stale REGISTERING/ANNOUNCED tournaments older than 1 hour
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('tournaments')
        .update({ status: 'CANCELLED' })
        .in('status', ['ANNOUNCED', 'REGISTERING'])
        .lt('created_at', oneHourAgo);
      console.log('[GameServer] Cancelled stale REGISTERING/ANNOUNCED tournaments');

      // 5. Cancel ALL RUNNING SNG/Spin tournaments (they can't survive a server restart —
      //    lobby IDs change, table engines are lost, players are already cleaned out)
      const { data: runningSngSpins } = await supabase
        .from('tournaments')
        .select('id, name, variant, tournament_type')
        .eq('status', 'RUNNING');

      let cancelledCount = 0;
      for (const t of runningSngSpins || []) {
        const isSngOrSpin =
          t.variant === 'sng' ||
          t.variant === 'spin' ||
          t.tournament_type === 'SNG' ||
          t.tournament_type === 'SPIN';
        if (isSngOrSpin) {
          await supabase
            .from('tournaments')
            .update({ status: 'CANCELLED' })
            .eq('id', t.id)
            .eq('status', 'RUNNING');
          cancelledCount++;
        }
      }
      if (cancelledCount > 0) {
        console.log(
          `[GameServer] Cancelled ${cancelledCount} orphaned SNG/Spin RUNNING tournaments`
        );
      }

      // 6. Cancel stale RUNNING MTT tournaments (BUG 019 FIX 2026-04-15):
      //    Prior threshold was 2 hours which killed every legitimate MTT — deep-stack
      //    tournaments routinely run 6+ hours. 133 MTTs were nuked before this fix.
      //    New policy:
      //      - bump threshold to 12 hours (truly crashed servers would mean tournaments
      //        stalled much longer than that)
      //      - set ended_at = NOW() so audit trail is preserved (was NULL before)
      //      - only target tournaments where last_activity is also stale
      //      - DO NOT touch MTTs that have recent hand_history activity (they're live)
      //    A separate scheduled cleanup should refund affected players; that's handled
      //    by TournamentManager.cancelTournament via normal refund path. This startup
      //    sweep is strictly a safety-net for server crashes and should rarely fire.
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const recentActivityCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      // Find stale RUNNING tournaments with no recent hand activity
      const { data: staleTourneys } = await supabase
        .from('tournaments')
        .select('id, name')
        .eq('status', 'RUNNING')
        .lt('created_at', twelveHoursAgo);
      for (const t of staleTourneys || []) {
        const { count: recentHands } = await supabase
          .from('hand_history')
          .select('id', { count: 'exact', head: true })
          .eq('tournament_id', t.id)
          .gte('created_at', recentActivityCutoff);
        if ((recentHands || 0) > 0) {
          console.log(
            `[GameServer] Skipping cancel of tournament ${t.id.slice(0, 8)} — ${recentHands} hands in last hour (still active)`
          );
          continue;
        }
        await supabase
          .from('tournaments')
          .update({ status: 'CANCELLED', ended_at: new Date().toISOString() })
          .eq('id', t.id);
        console.log(
          `[GameServer] Cancelled genuinely stale RUNNING tournament ${t.id.slice(0, 8)} "${t.name}" (>12h, no recent hands)`
        );
      }
      console.log(
        `[GameServer] Stale-tournament sweep complete (${staleTourneys?.length || 0} reviewed)`
      );

      // 7. Cancel stuck COMPLETING tournaments (crashed during finishTournament flow)
      await supabase
        .from('tournaments')
        .update({ status: 'COMPLETED', ended_at: new Date().toISOString() })
        .eq('status', 'COMPLETING');
      console.log('[GameServer] Finalized stuck COMPLETING tournaments');

      console.log('[GameServer] Stale data cleanup complete');
    } catch (err) {
      reportError(err, 'GameServer.Stale_data_cleanup_error');
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
          reportError(error, 'GameServer.Cash_table_discovery_error');
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
            engine.setHub(tableStateHub); // Phase 1.1 PR-2: authoritative WS publisher
            this.tableEngines.set(table.id, engine);
            engine.start().catch((err) => {
              reportError(err, 'GameServer.Engine_start_failed_for_tablei');
              this.tableEngines.delete(table.id);
              tableStateHub.dropTable(table.id);
            });
          }
        }

        // Clean up engines for tables that stopped
        for (const [id, engine] of this.tableEngines) {
          if (!engine.isRunning()) {
            this.tableEngines.delete(id);
            tableStateHub.dropTable(id); // Phase 1.1 PR-2: release hub room
          }
        }
      } catch (err) {
        reportError(err, 'GameServer.Cash_table_discovery_error');
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
                  reportError(
                    new Error(
                      `[GameServer] Refund FAILED for ${p.user_id.slice(0, 8)} in ${tournament.name}: ${creditErr.message}`
                    ),
                    'GameServer.Refund_FAILED_for_puser_idslic'
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
                  reportError(
                    new Error(
                      `[GameServer] Refund log FAILED for ${p.user_id.slice(0, 8)}: ${logErr.message}`
                    ),
                    'GameServer.Refund_log_FAILED_for_puser_id'
                  );
              } catch (refundErr) {
                reportError(refundErr, 'GameServer.Refund_exception_for_puser_ids');
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
              reportError(err, 'GameServer.Tournament_start_failed_for_to');
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
            reportError(err, 'GameServer.Tournament_resume_failed_for_t');
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
        reportError(err, 'GameServer.Tournament_discovery_error');
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

export class TournamentManager {
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
  // FIX 151: ChipRaceEngine for denomination removal on level-up
  private chipRaceEngine: ChipRaceEngine = new ChipRaceEngine((event) => {
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] ChipRace: ${event.type}`);
  });
  // FIX 154: TableBalancer for proper gap-1 rebalancing across tournament tables
  private tableBalancer: TableBalancer = new TableBalancer((event) => {
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] TableBalance: ${event.type} — ${(event as any).moveCount || 0} moves`
    );
  });
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
      reportError(e, 'TournamentthistournamentIdslic.Broadcast_eventType_failed');
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
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

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
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Refund FAILED for ${p.user_id.slice(0, 8)}: ${creditErr.message}`
                ),
                'TournamentthistournamentIdslic.Refund_FAILED_for_puser_idslic'
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
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Refund log FAILED for ${p.user_id.slice(0, 8)}: ${logErr.message}`
                ),
                'TournamentthistournamentIdslic.Refund_log_FAILED_for_puser_id'
              );
          } catch (refundErr) {
            reportError(refundErr, 'TournamentthistournamentIdslic.Refund_exception_for_puser_ids');
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
        // Round 40 RE-RUN: Math.round (not Math.trunc) for IEEE 754 drift safety —
        // same family as the chop-pot fix (commit 9900b874) and calculateRake fix.
        const buyIn = tournament.buy_in_amount || 0;
        const prizePool = Math.round(buyIn * spinMultiplier * 100) / 100;

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
          .catch((err) => reportError(err, 'TournamentthistournamentIdslic.Table_engine_error'));
      }

      // Start blind timer
      this.startBlindTimer(tournament.blind_structure || []);

      // Start elimination checker
      this.startEliminationChecker();

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] RUNNING — ${this.tableEngines.size} tables`
      );
    } catch (err) {
      reportError(err, 'TournamentthistournamentIdslic.Start_failed');
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
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

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
        engine.setHub(tableStateHub); // Phase 1.1 PR-2
        this.tableEngines.set(table.id, engine);
        this.gameServer.registerTableEngine(table.id, engine);
        engine
          .start()
          .catch((err) => reportError(err, 'TournamentthistournamentIdslic.Resume_table_error'));
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
      reportError(err, 'TournamentthistournamentIdslic.Resume_failed');
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
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

      if (error || !table) {
        reportError(error, 'TournamentthistournamentIdslic.Failed_to_create_table');
        continue;
      }

      const engine = new ServerTableEngine(table.id);
      engine.setHub(tableStateHub); // Phase 1.1 PR-2
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
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Failed to seat ${players[i].user_id.slice(0, 8)}: ${seatErr.message}`
          ),
          'TournamentthistournamentIdslic.Failed_to_seat_playersiuser_id'
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
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Blind update failed for table ${tableId.slice(0, 8)}: ${blindErr.message}`
              ),
              'TournamentthistournamentIdslic.Blind_update_failed_for_table_'
            );

          // Phase X5 (2026-04-28): emit level_up discrete event so clients
          // can trigger the level-up popup + sound + haptic per Bible V8 §5
          // (UI/Popup/Animation/Sound/Haptic Doctrine). Without this, clients
          // must infer level escalation from a state-snapshot diff, which
          // violates Law 1.16 Real-Time Delivery.
          try {
            tableStateHub.emitEvent(tableId, {
              type: 'level_up',
              table_id: tableId,
              tournament_id: this.tournamentId,
              new_level: this.currentLevel,
              previous_level: prevLevel,
              small_blind: level.smallBlind,
              big_blind: level.bigBlind,
              ante: level.ante || 0,
              duration_minutes: level.durationMinutes,
              timestamp: Date.now(),
            });
          } catch {
            /* hub broadcast failure is non-fatal */
          }
        }

        const { error: levelErr } = await supabase
          .from('tournaments')
          .update({ current_level: this.currentLevel })
          .eq('id', this.tournamentId);
        if (levelErr)
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Level persist failed: ${levelErr.message}`
            ),
            'TournamentthistournamentIdslic.Level_persist_failed'
          );

        // FIX 151: Chip race when denomination changes on level-up
        // If the new small blind is a larger denomination than the previous level's,
        // remove the old denomination via fair chip-race lottery.
        const prevLevelData = blindStructure[prevLevel] || blindStructure[0];
        const prevSmallBlind = prevLevelData?.smallBlind || level.smallBlind;
        if (level.smallBlind > prevSmallBlind) {
          try {
            // Gather all tournament player stacks across all tables
            const playerStacks = new Map<string, number>();
            for (const tableId of this.tableEngines.keys()) {
              const { data: seats } = await supabase
                .from('table_seats')
                .select('user_id, stack')
                .eq('table_id', tableId)
                .is('left_at', null);
              for (const seat of seats || []) {
                if (seat.stack > 0) playerStacks.set(seat.user_id, seat.stack);
              }
            }
            if (playerStacks.size >= 2) {
              const result = this.chipRaceEngine.executeChipRace(
                this.tournamentId,
                playerStacks,
                prevSmallBlind,
                level.smallBlind
              );
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Chip race: removed ${prevSmallBlind} denomination, ${result.totalNewChipsDistributed} chips redistributed to ${result.players.filter((p) => p.chipsAwarded > 0).length} players`
              );
              // Update table_seats with new stacks after chip race
              for (const [userId, newStack] of playerStacks) {
                await supabase
                  .from('table_seats')
                  .update({ stack: newStack })
                  .eq('user_id', userId)
                  .is('left_at', null);
              }
              await this.broadcast('chip_race', {
                removedDenomination: prevSmallBlind,
                newSmallestDenomination: level.smallBlind,
                playersAffected: result.players.filter((p) => p.chipsAwarded > 0).length,
              });
            }
          } catch (crErr) {
            reportError(crErr, 'TournamentthistournamentIdslic.Chip_race_error');
          }
        }

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
              .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
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
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
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
              // Math.floor — tournament_players.chips is INTEGER. table_seats.stack
              // is numeric(15,2) so a fractional stack from cash-style math would
              // otherwise reach PostgREST as a decimal and fail the integer cast,
              // contributing to the postgres log flood. Floor at the boundary.
              await supabase
                .from('tournament_players')
                .update({ chips: Math.floor(stackValue) })
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
            reportError(finishErr, 'TournamentthistournamentIdslic.finishTournament_error__will_r');
          }
        }

        await this.checkTableBalance();

        // FIX 155: Check if new tables need to be created during rebuy/late-reg period
        await this.checkDynamicTableExpansion();

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
        reportError(err, 'TournamentthistournamentIdslic.Elimination_check_error');
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
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

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
          // Round 40 RE-RUN: Math.round (not Math.trunc) so IEEE 754 drift on
          // prizeRaw doesn't shave 1¢ off the player's payout. The cap-bound
          // case is unaffected; only the precision matters.
          const prizeRaw = ((tournament.prize_pool || 0) * payoutEntry.percentage) / 100;
          prize = Math.round(prizeRaw * 100) / 100;
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
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Prize credit attempt ${attempt}/3 failed for ${userId.slice(0, 8)}: ${creditErr.message}`
          ),
          'TournamentthistournamentIdslic.Prize_credit_attempt_attempt3_'
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
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Prize log FAILED for ${userId.slice(0, 8)}: ${prizeLogErr.message}`
            ),
            'TournamentthistournamentIdslic.Prize_log_FAILED_for_userIdsli'
          );
      } else {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Prize credit FAILED after 3 retries for ${userId.slice(0, 8)} — ${prize} chips lost`
          ),
          'TournamentthistournamentIdslic.CRITICAL'
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
        reportError(bountyErr, 'TournamentthistournamentIdslic.Bounty_processing_error');
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
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

    const bountyValue = eliminatedPlayer?.current_bounty || baseBounty;

    if (tournament.is_pko) {
      // ── PROGRESSIVE KO ──
      // 50% to knocker immediately, 50% added to knocker's bounty head
      // Round 40 RE-RUN: Math.round on bountyValue → cents (was Math.trunc;
      // could under-pay PKO bounty by 1¢ when bountyValue has IEEE 754 drift).
      // The 50/50 split below uses (totalBountyCents - knockerCents) so the
      // sum always equals totalBountyCents — that compensation logic is fine.
      const totalBountyCents = Math.round(bountyValue * 100);
      const knockerCents = Math.trunc(totalBountyCents / 2);
      const knockerPortion = knockerCents / 100;
      const addedToHead = (totalBountyCents - knockerCents) / 100;

      // Get knocker's current bounty
      const { data: knocker } = await supabase
        .from('tournament_players')
        .select('current_bounty, bounties_collected, bounty_winnings')
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', knockerUserId)
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

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

      // Round 40 RE-RUN: Math.round (not Math.trunc) for IEEE 754 drift safety
      // on mystery bounty payout — same family as the rest of this round's fixes.
      const mysteryValue = Math.round(baseBounty * mysteryMultiplier * 100) / 100;

      // Update knocker stats
      const { data: knocker } = await supabase
        .from('tournament_players')
        .select('bounties_collected, bounty_winnings')
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', knockerUserId)
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

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
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

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
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty credit attempt ${attempt}/3 failed for ${knockerUserId.slice(0, 8)}: ${creditErr.message}`
        ),
        'TournamentthistournamentIdslic.Bounty_credit_attempt_attempt3'
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }

    if (!creditSuccess) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Bounty credit FAILED after 3 retries for ${knockerUserId.slice(0, 8)} — ${amount} chips lost`
        ),
        'TournamentthistournamentIdslic.CRITICAL'
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
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Bounty log FAILED for ${knockerUserId.slice(0, 8)}: ${bountyLogErr.message}`
        ),
        'TournamentthistournamentIdslic.Bounty_log_FAILED_for_knockerU'
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

      // Round 40 RE-RUN: Math.round on prize calc + diff to avoid IEEE 754 drift
      // shaving 1¢ off a player's payout adjustment.
      const correctPrize =
        Math.round(((finalPrizePool * payoutEntry.percentage) / 100) * 100) / 100;
      const difference = Math.round((correctPrize - (player.prize || 0)) * 100) / 100;

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
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Prize recalc credit FAILED for ${player.user_id.slice(0, 8)}: ${creditErr.message}`
            ),
            'TournamentthistournamentIdslic.Prize_recalc_credit_FAILED_for'
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
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

    if (!tournament || tourneyLoadErr) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Could not load tournament for finish: ${tourneyLoadErr?.message} — marking COMPLETED without payouts`
        ),
        'TournamentthistournamentIdslic.CRITICAL'
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
        // Round 40 RE-RUN: Math.round for IEEE 754 drift safety (winnerPrize
        // was previously Math.trunc which could under-pay by 1¢).
        const prizeRaw = ((tournament.prize_pool || 0) * firstPlace.percentage) / 100;
        winnerPrize = Math.round(prizeRaw * 100) / 100;
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
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Winner prize credit attempt ${attempt}/3 failed: ${creditErr.message}`
          ),
          'TournamentthistournamentIdslic.Winner_prize_credit_attempt_at'
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
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Prize log FAILED for ${winnerId.slice(0, 8)}: ${prizeLogErr.message}`
            ),
            'TournamentthistournamentIdslic.Prize_log_FAILED_for_winnerIds'
          );
      } else {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: Winner prize credit FAILED after 3 retries for ${winnerId.slice(0, 8)} — ${winnerPrize} chips lost`
          ),
          'TournamentthistournamentIdslic.CRITICAL'
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
    // Round 40 RE-RUN: Math.round for IEEE 754 drift safety (totalRake was
    // Math.trunc which could under-collect 1¢ on tournaments where
    // rakePerEntry has float drift).
    const totalRake = Math.round(rakePerEntry * totalEntries * 100) / 100;

    if (totalRake > 0 && tournament?.club_id) {
      // Get club + union info
      const { data: club } = await supabase
        .from('clubs')
        .select('owner_id, name, union_id')
        .eq('id', tournament.club_id)
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

      if (club) {
        const rakeDescription = `Tournament rake: ${tournament.name || 'tournament'} (${totalEntries} entries x ${rakePerEntry})`;

        if (club.union_id) {
          // Club is in a union — ALL rake held by union wallet
          const { data: uw } = await supabase
            .from('union_wallets')
            .select('chip_balance')
            .eq('union_id', club.union_id)
            .maybeSingle();

          if (uw) {
            const { error: uwErr } = await supabase
              .from('union_wallets')
              .update({
                chip_balance: (uw.chip_balance || 0) + totalRake,
                updated_at: new Date().toISOString(),
              })
              .eq('union_id', club.union_id);
            if (uwErr) {
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Union wallet rake credit failed: ${uwErr.message}`
                ),
                'Tournament.Union_wallet_rake_credit_failed'
              );
            } else {
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settled: ${totalRake} to union wallet ${club.union_id.slice(0, 8)}`
              );
            }
          } else {
            // Create union wallet if it doesn't exist
            const { error: insertErr } = await supabase
              .from('union_wallets')
              .insert({ union_id: club.union_id, chip_balance: totalRake });
            if (insertErr) {
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Union wallet creation failed: ${insertErr.message}`
                ),
                'Tournament.Union_wallet_creation_failed'
              );
            }
          }

          // Log union transaction for audit (BUG 013 FIX — was union_transactions which
          // doesn't exist; correct table is union_wallet_transactions)
          {
            const { data: uw2 } = await supabase
              .from('union_wallets')
              .select('chip_balance')
              .eq('union_id', club.union_id)
              .maybeSingle();
            await supabase.from('union_wallet_transactions').insert({
              union_id: club.union_id,
              club_id: tournament.club_id,
              amount: totalRake,
              tx_type: 'rake',
              wallet: 'main',
              direction: 'credit',
              balance_after: uw2?.chip_balance ?? null,
              notes: `${rakeDescription} — ${club.name || 'club'}`,
            });
          }
        } else {
          // Standalone club — rake goes to CLUB wallet (not owner's personal wallet)
          // BUG 016 FIX (2026-04-15): club_wallets doesn't exist; remove dead probe
          // and go straight to clubs.chip_pool atomic RPC. Also swap read-then-write
          // for atomic increment to eliminate the race condition the old code had.
          const { error: cpErr } = await supabase.rpc('increment_club_chip_pool', {
            p_club_id: tournament.club_id,
            p_amount: totalRake,
          });
          if (cpErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Club chip_pool credit failed: ${cpErr.message}`
              ),
              'Tournament.Club_chip_pool_credit_failed'
            );
          } else {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Rake settled: ${totalRake} to club chip_pool ${tournament.club_id.slice(0, 8)}`
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

    // ── FIX 154: Build BalancerTable[] from live DB state ──
    const balancerTables: BalancerTable[] = [];
    for (const tableId of this.tableEngines.keys()) {
      const { data: seats } = await supabase
        .from('table_seats')
        .select('user_id, stack, seat_number')
        .eq('table_id', tableId)
        .is('left_at', null);

      const { data: tableRow } = await supabase
        .from('tables')
        .select('max_players')
        .eq('id', tableId)
        .maybeSingle();

      balancerTables.push({
        tableId,
        playerCount: (seats || []).length,
        maxSeats: tableRow?.max_players || 9,
        players: (seats || []).map((s: any) => ({
          userId: s.user_id,
          stack: s.stack || 0,
          seat: s.seat_number || 0,
        })),
      });
    }

    // ── STEP 1: Check if any table should be broken (merged into others) ──
    for (const bt of balancerTables) {
      if (this.tableBalancer.shouldBreakTable(bt, balancerTables)) {
        const otherTables = balancerTables.filter((t) => t.tableId !== bt.tableId);
        const breakMoves = this.tableBalancer.breakTable(bt, otherTables);

        if (breakMoves.length > 0 && breakMoves.length === bt.playerCount) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Breaking table ${bt.tableId.slice(0, 8)} — moving ${breakMoves.length} players`
          );
          await this.executePlayerMoves(breakMoves);

          // Close the broken table's engine
          const engine = this.tableEngines.get(bt.tableId);
          if (engine) {
            await this.waitForHandComplete(bt.tableId);
            await engine.stop();
          }
          this.tableEngines.delete(bt.tableId);
          tableStateHub.dropTable(bt.tableId); // Phase 1.1 PR-2: release hub room
          await supabase.from('tables').update({ status: 'closed' }).eq('id', bt.tableId);

          await this.broadcast('table_rebalance', {
            closedTableId: bt.tableId,
            movedPlayers: breakMoves.length,
            reason: 'table_break',
          });

          break; // One break per cycle to avoid stale data
        }
      }
    }

    // ── STEP 2: Standard gap-1 rebalancing across remaining tables ──
    // Re-fetch after potential break (tables may have changed)
    if (this.tableEngines.size > 1) {
      const freshTables: BalancerTable[] = [];
      for (const tableId of this.tableEngines.keys()) {
        const { data: seats } = await supabase
          .from('table_seats')
          .select('user_id, stack, seat_number')
          .eq('table_id', tableId)
          .is('left_at', null);

        const { data: tableRow } = await supabase
          .from('tables')
          .select('max_players')
          .eq('id', tableId)
          .maybeSingle();

        freshTables.push({
          tableId,
          playerCount: (seats || []).length,
          maxSeats: tableRow?.max_players || 9,
          players: (seats || []).map((s: any) => ({
            userId: s.user_id,
            stack: s.stack || 0,
            seat: s.seat_number || 0,
          })),
        });
      }

      if (this.tableBalancer.shouldRebalance(freshTables)) {
        const moves = this.tableBalancer.calculateMoves(freshTables);
        if (moves.length > 0) {
          const score = this.tableBalancer.evaluateBalance(freshTables);
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Rebalancing: ${moves.length} moves (gap was ${score.gap}, target ≤1)`
          );
          await this.executePlayerMoves(moves);

          await this.broadcast('table_rebalance', {
            moveCount: moves.length,
            reason: 'gap_balance',
          });
        }
      }
    }
  }

  /**
   * FIX 154: Execute a set of player move instructions (used by both table break + rebalance).
   * Moves player seats in DB: marks old seat as left, inserts new seat, updates tournament_players.
   */
  private async executePlayerMoves(moves: MoveInstruction[]): Promise<void> {
    for (const move of moves) {
      try {
        // Mark old seat as left FIRST to prevent duplicate active seats
        await supabase
          .from('table_seats')
          .update({ left_at: new Date().toISOString() })
          .eq('table_id', move.fromTableId)
          .eq('user_id', move.playerId)
          .is('left_at', null);

        // Get the player's current stack from the old seat
        // (the move instruction has stack info from the snapshot, but DB is truth)
        const { data: oldSeat } = await supabase
          .from('table_seats')
          .select('stack')
          .eq('table_id', move.fromTableId)
          .eq('user_id', move.playerId)
          .order('left_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        // Insert new seat at target table
        await supabase.from('table_seats').insert({
          table_id: move.toTableId,
          user_id: move.playerId,
          seat_number: move.toSeat,
          stack: oldSeat?.stack || 0,
          joined_at: new Date().toISOString(),
        });

        // Update tournament_players table_id
        await supabase
          .from('tournament_players')
          .update({ table_id: move.toTableId })
          .eq('tournament_id', this.tournamentId)
          .eq('user_id', move.playerId);

        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Moved ${move.playerId.slice(0, 8)}: table ${move.fromTableId.slice(0, 8)} seat ${move.fromSeat} → table ${move.toTableId.slice(0, 8)} seat ${move.toSeat}`
        );
      } catch (moveErr) {
        reportError(moveErr, 'TournamentthistournamentIdslic.Move_failed_for_moveplayerIdsl');
      }
    }
  }

  /**
   * Wait for any active hand on a table to complete before stopping engine.
   * Polls every 2s, up to 30s timeout.
   */
  private async waitForHandComplete(tableId: string): Promise<void> {
    const { data: activeHand } = await supabase
      .from('hand_history')
      .select('id')
      .eq('table_id', tableId)
      .is('ended_at', null)
      .maybeSingle();

    if (activeHand) {
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
        if (!still) break;
      }
    }
  }

  /**
   * FIX 155: Dynamic table creation during rebuy/re-entry/late-reg period.
   * When player count exceeds (tableCount × maxPerTable), create new tables
   * and rebalance players across all tables using TableBalancer.
   *
   * Called from the elimination checker cycle so it runs every 5s.
   */
  private async checkDynamicTableExpansion(): Promise<void> {
    // Only expand during rebuy/late-reg period (before prize pool is finalized)
    if (this.prizePoolFinalized) return;

    const lateRegLevelCap =
      this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 0;
    if (lateRegLevelCap <= 0) return; // No late reg/rebuy configured
    if (this.currentLevel >= lateRegLevelCap) return; // Past the cutoff

    // Count active playing players across all tables
    const { count: totalPlaying } = await supabase
      .from('tournament_players')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing');

    if (!totalPlaying || totalPlaying <= 0) return;

    // Determine max per table from tournament config
    const tType = (this.tournamentCache?.tournament_type || '').toUpperCase();
    const variant = (this.tournamentCache?.variant || '').toLowerCase();
    let maxPerTable = this.tournamentCache?.max_players || 9;
    if (variant === 'spin' || tType === 'SPIN') {
      maxPerTable = 3;
    } else if (variant === 'sng' || tType === 'SNG') {
      maxPerTable = Math.min(this.tournamentCache?.max_players || 6, 9);
    } else {
      maxPerTable = 9;
    }

    const currentTableCount = this.tableEngines.size;
    const totalCapacity = currentTableCount * maxPerTable;

    // Only create new tables when we're actually over capacity
    if (totalPlaying <= totalCapacity) return;

    const neededTables = Math.ceil(totalPlaying / maxPerTable);
    const tablesToCreate = neededTables - currentTableCount;
    if (tablesToCreate <= 0) return;

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] DYNAMIC TABLE EXPANSION: ${totalPlaying} players across ${currentTableCount} tables (capacity ${totalCapacity}) — creating ${tablesToCreate} new table(s)`
    );

    const blindStructure = this.tournamentCache?.blind_structure || [];
    const currentLevelData = blindStructure[
      Math.min(this.currentLevel, blindStructure.length - 1)
    ] || { smallBlind: 10, bigBlind: 20, ante: 0 };

    const newTableIds: string[] = [];
    for (let i = 0; i < tablesToCreate; i++) {
      const tableNumber = currentTableCount + i + 1;

      const { data: newTable, error: createErr } = await supabase
        .from('tables')
        .insert({
          club_id: this.tournamentCache?.club_id,
          tournament_id: this.tournamentId,
          name: `${this.tournamentCache?.name || 'Tournament'} - Table ${tableNumber}`,
          game_type: 'tournament',
          game_variant: this.tournamentCache?.game_type?.toLowerCase() || 'nlh',
          stakes: `${currentLevelData.smallBlind}/${currentLevelData.bigBlind}`,
          small_blind: currentLevelData.smallBlind,
          big_blind: currentLevelData.bigBlind,
          ante: currentLevelData.ante || 0,
          min_buy_in: 0,
          max_buy_in: 0,
          max_players: maxPerTable,
          current_players: 0,
          status: 'running',
        })
        .select()
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

      if (createErr || !newTable) {
        reportError(createErr, 'TournamentthistournamentIdslic.Failed_to_create_expansion_tab');
        continue;
      }

      // Create engine + register with game server
      const engine = new ServerTableEngine(newTable.id);
      engine.setHub(tableStateHub); // Phase 1.1 PR-2
      this.tableEngines.set(newTable.id, engine);
      this.gameServer.registerTableEngine(newTable.id, engine);
      engine
        .start()
        .catch((err) =>
          reportError(err, 'TournamentthistournamentIdslic.Expansion_table_engine_error')
        );
      newTableIds.push(newTable.id);

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Created expansion table ${newTable.id.slice(0, 8)} (Table ${tableNumber})`
      );
    }

    if (newTableIds.length === 0) return;

    // Now rebalance players across ALL tables (existing + new) using TableBalancer
    // Build fresh BalancerTable snapshot
    const allTables: BalancerTable[] = [];
    for (const tableId of this.tableEngines.keys()) {
      const { data: seats } = await supabase
        .from('table_seats')
        .select('user_id, stack, seat_number')
        .eq('table_id', tableId)
        .is('left_at', null);

      allTables.push({
        tableId,
        playerCount: (seats || []).length,
        maxSeats: maxPerTable,
        players: (seats || []).map((s: any) => ({
          userId: s.user_id,
          stack: s.stack || 0,
          seat: s.seat_number || 0,
        })),
      });
    }

    // Calculate optimal moves to balance all tables
    if (this.tableBalancer.shouldRebalance(allTables)) {
      const moves = this.tableBalancer.calculateMoves(allTables);
      if (moves.length > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Post-expansion rebalance: ${moves.length} player moves`
        );
        await this.executePlayerMoves(moves);
      }
    }

    // Broadcast expansion event
    await this.broadcast('table_expansion', {
      newTableIds,
      totalTables: this.tableEngines.size,
      totalPlayers: totalPlaying,
      reason: 'rebuy_reentry_overflow',
    });
  }
}
