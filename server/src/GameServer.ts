/**
 * GameServer — server-side game orchestration.
 *
 * Extracted from `server/src/index.ts` in Phase U3.4b (2026-04-23) — the
 * final step of the index-monolith split per platform plan 2.3. On 2026-07-28
 * TournamentManager moved out to `./tournament/` (engine audit D21); it is
 * re-exported here so existing importers keep working.
 */

import { ServerTableEngine } from './engine/ServerTableEngine.js';
import { supabase } from './services/supabase.js';
import { HorseFleetManager } from './services/HorseFleetManager.js';
import { TournamentRecurringService } from './services/TournamentRecurringService.js';
import { HorseLifecycleManager } from './services/HorseLifecycleManager.js';
import { AutoRebuyService } from './services/AutoRebuyService.js';
// BUG 008 FIX: Periodic rakeback settler - flushes per-hand rake_records into rakeback_periods.
import { RakebackSettlerService } from './services/RakebackSettlerService.js';
import { reconcilePendingFees, auditBBJDrift } from './services/FeeReconciler.js';
import { reportError, initSentry, flushSentry } from './services/errorReporter.js';
// Phase 1.1 PR-2: native WebSocket transport for authoritative state
import { tableStateHub } from './transport/TableStateHub.js';
import { reportError } from './services/errorReporter.js';
import {
  refundAndCloseCancelledTournament,
  recoverStuckCompletingTournaments,
} from './tournament/tournamentRecovery.js';
import { TournamentManager } from './tournament/TournamentManager.js';

export { TournamentManager };

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
  /**
   * A5: drains `pending_fee_distributions` — rake / BBJ fees that left a pot but
   * whose banking RPC failed — and runs the independent BBJ ledger-drift alarm.
   */
  private feeReconcileTimer: NodeJS.Timeout | null = null;
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

      // Step 8 (A5): Start the fee reconciler. Rake and the BBJ contribution are
      // taken out of the pot inside the hand; if the banking RPC fails the chips
      // exist nowhere. The engine now queues those failures durably — this drains
      // that queue, and independently compares what rake_records booked as BBJ
      // contribution against what the jackpot pool actually received, because a
      // failure the engine never noticed would otherwise stay invisible (it did,
      // for a week).
      this.startFeeReconciler();

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
    if (this.feeReconcileTimer) {
      clearInterval(this.feeReconcileTimer);
      this.feeReconcileTimer = null;
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

  /**
   * A5: every 5 minutes, re-drive any fee the engine could not bank, then check
   * the two BBJ ledgers against each other.
   *
   * Both underlying operations are idempotent — `atomic_distribute_rake` is
   * hand-gated and `bbj_record_contribution` is keyed per (table, hand) — so a
   * cycle that overlaps a queue entry which has since succeeded resolves it as a
   * no-op rather than double-banking. `running` is re-checked inside the tick so
   * a shutdown mid-cycle cannot start new work.
   */
  private startFeeReconciler(): void {
    const FEE_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
    // Only alarm on drift once an hour; the reconciler runs 12x more often than
    // that and a standing drift would otherwise page twelve times per hour.
    const DRIFT_EVERY_N_CYCLES = 12;
    let cycle = 0;

    const tick = async () => {
      if (!this.running) return;
      try {
        const summary = await reconcilePendingFees();
        if (summary.scanned > 0) {
          console.log(
            `[FeeReconciler] scanned ${summary.scanned}, resolved ${summary.resolved}, ` +
              `still failing ${summary.stillFailing}, exhausted ${summary.exhausted}`
          );
        }
      } catch (err) {
        reportError(err, 'GameServer.fee_reconcile_failed');
      }
      if (cycle % DRIFT_EVERY_N_CYCLES === 0) {
        try {
          await auditBBJDrift(1);
        } catch (err) {
          reportError(err, 'GameServer.bbj_drift_audit_failed');
        }
      }
      cycle++;
    };

    void tick();
    this.feeReconcileTimer = setInterval(() => {
      void tick();
    }, FEE_RECONCILE_INTERVAL_MS);
    console.log('[GameServer] Fee reconciler started (5-min cycle, hourly BBJ drift audit)');
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

      // 2. SAFE CLEANUP: Cash out active CASH-GAME seats before deleting.
      //    Test table (protectedTableId) is excluded — its seated players /
      //    bots stay put so the tester can join an already-warmed table.
      //    This prevents chip loss when the server restarts while players are seated
      //    FIX 208b: Batch approach — aggregate per user, single wallet update per user
      //
      //    TOURNEY-AUDIT 2026-07-24 [CRITICAL]: this query had NO tournament
      //    filter — on EVERY restart it credited each seated tournament
      //    player's TOURNAMENT CHIP STACK (e.g. 10,000 tournament chips) to
      //    their REAL-MONEY wallet via credit_player_wallet, then deleted the
      //    seats — minting money on every boot AND destroying the seats a
      //    resumed tournament needs. Now only seats at CASH tables
      //    (tables.tournament_id IS NULL) are cashed out, and the delete below
      //    targets exactly the processed seat rows instead of wiping the table.
      let seatsQuery = supabase
        .from('table_seats')
        .select('id, user_id, table_id, seat_number, stack, tables!inner(tournament_id)')
        .is('left_at', null)
        .is('tables.tournament_id', null);
      if (protectedTableId) {
        seatsQuery = seatsQuery.neq('table_id', protectedTableId);
      }
      const { data: activeSeats } = await seatsQuery;

      if (activeSeats && activeSeats.length > 0) {
        // Aggregate total stack per user
        const userTotals = new Map<string, number>();
        // A3 FIX (2026-07-28): carry the seat ids alongside the totals so the
        // credit below can be made idempotent. The aggregate is per-user, so the
        // only stable identity for "this exact cash-out" is the set of seat rows
        // that produced it.
        const userSeatIds = new Map<string, string[]>();
        for (const seat of activeSeats) {
          const prev = userTotals.get(seat.user_id) ?? 0;
          userTotals.set(seat.user_id, prev + (seat.stack ?? 0));
          const ids = userSeatIds.get(seat.user_id) ?? [];
          ids.push(seat.id);
          userSeatIds.set(seat.user_id, ids);
        }

        // Credit each user's wallet in parallel (batch of 10)
        // FIX-232: Use atomic RPC increment — eliminates read-then-write race condition
        // SWEEP #4 P1-1 FIX (2026-07-23): failed credits were only logged and
        // cashedOut++ ran anyway, then EVERY seat was deleted below — so on a
        // restart during a Supabase blip (exactly when restarts happen) the
        // uncredited players' stacks were permanently destroyed. Track the users
        // whose credit failed and spare their seats from the delete so their
        // stacks survive for the next startup pass.
        let cashedOut = 0;
        const failedUserIds = new Set<string>();
        const entries = Array.from(userTotals.entries()).filter(([_, total]) => total > 0);
        for (let i = 0; i < entries.length; i += 10) {
          const batch = entries.slice(i, i + 10);
          await Promise.all(
            batch.map(async ([userId, totalStack]) => {
              try {
                const { error: walletErr } = await supabase.rpc('credit_player_wallet', {
                  p_user_id: userId,
                  p_amount: totalStack,
                  // A3 FIX (2026-07-28): `cleanupStaleData` runs on EVERY boot and
                  // deliberately spares the seats of users whose credit failed
                  // (see failedUserIds below) so their stacks survive - which means
                  // the next boot re-credits the identical aggregate. A credit that
                  // committed but timed out therefore minted the whole stack again.
                  // Keyed on the sorted seat-id set that produced this aggregate.
                  p_idempotency_key: `startup-cashout:${userId}:${(userSeatIds.get(userId) ?? []).slice().sort().join('|')}`,
                });
                if (walletErr) {
                  console.warn(
                    `[GameServer] Cashout wallet credit failed for ${userId}: ${walletErr.message}`
                  );
                  failedUserIds.add(userId);
                  return;
                }

                cashedOut++;
              } catch (err: any) {
                console.warn(`[GameServer] Cashout failed for ${userId}: ${err.message}`);
                failedUserIds.add(userId);
              }
            })
          );
        }

        if (cashedOut > 0) {
          console.log(`[GameServer] Safely cashed out ${cashedOut} seated players before cleanup`);
        }
        if (failedUserIds.size > 0) {
          console.warn(
            `[GameServer] ${failedUserIds.size} player(s) had failed cashout credits — sparing their seats from deletion to preserve stacks`
          );
        }

        // TOURNEY-AUDIT 2026-07-24: delete EXACTLY the cash seats we just
        // processed (minus failed credits, whose stacks are still owed) —
        // never a blanket wipe. Tournament seats are untouched so a resumed
        // tournament finds its players; historical (left_at set) rows are
        // preserved as the seat audit trail.
        const seatIdsToDelete = activeSeats
          .filter((s) => !failedUserIds.has(s.user_id))
          .map((s) => s.id);
        for (let i = 0; i < seatIdsToDelete.length; i += 100) {
          const chunk = seatIdsToDelete.slice(i, i + 100);
          await supabase.from('table_seats').delete().in('id', chunk);
        }
        console.log(
          `[GameServer] Deleted ${seatIdsToDelete.length} cash-table seats (after safe cashout; tournament seats preserved)`
        );
      } else {
        // TOURNEY-AUDIT 2026-07-24: nothing to cash out — do NOT blanket-delete.
        // The old path here deleted EVERY table_seats row (including tournament
        // seats and historical left_at rows) on every restart.
        console.log('[GameServer] No active cash-table seats needed cashout');
      }

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

      // 4. Cancel stale REGISTERING/ANNOUNCED tournaments whose start time is
      //    well past — with REFUNDS.
      // SWEEP #4 P1-2 FIX (2026-07-23): this previously (a) keyed on created_at,
      //    so a tournament created in the afternoon for an evening start was
      //    cancelled on any restart hours before it should even begin, and
      //    (b) issued NO refunds — every registered player's buy-in was
      //    swallowed. Now key on start_time (genuinely past-due) and refund each
      //    registered player buy_in_amount + buy_in_fee before cancelling.
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const { data: stalePreStart } = await supabase
        .from('tournaments')
        .select('id, name, buy_in_amount, buy_in_fee')
        .in('status', ['ANNOUNCED', 'REGISTERING'])
        .lt('start_time', oneHourAgo);
      for (const t of stalePreStart || []) {
        try {
          const refundEach = (t.buy_in_amount || 0) + (t.buy_in_fee || 0);
          if (refundEach > 0) {
            const { data: regs } = await supabase
              .from('tournament_players')
              .select('id, user_id')
              .eq('tournament_id', t.id);
            for (const p of regs || []) {
              const { error: refErr } = await supabase.rpc('credit_player_wallet', {
                p_user_id: p.user_id,
                p_amount: refundEach,
                // A3 FIX (2026-07-28): this startup sweep marks nothing per-row and
                // only flips the tournament to CANCELLED after the loop, so any
                // crash (or a failed flip) re-refunded everyone on the next boot.
                // Same key format as tournamentRecovery + HorseLifecycleManager so
                // all three cancel-refund paths dedupe against each other.
                p_idempotency_key: `tourney:${t.id}:cancelrefund:${p.id}`,
              });
              if (refErr) {
                console.warn(
                  `[GameServer] Startup pre-start refund FAILED for ${p.user_id.slice(0, 8)} on "${t.name}": ${refErr.message}`
                );
              }
            }
          }
          await supabase
            .from('tournaments')
            .update({ status: 'CANCELLED' })
            .eq('id', t.id)
            .in('status', ['ANNOUNCED', 'REGISTERING']);
        } catch (err: any) {
          console.warn(`[GameServer] Startup pre-start cancel error for ${t.id}: ${err?.message}`);
        }
      }
      if ((stalePreStart?.length || 0) > 0) {
        console.log(
          `[GameServer] Cancelled ${stalePreStart!.length} past-due REGISTERING/ANNOUNCED tournaments (with refunds)`
        );
      }

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
          const { count: cancelUpdated } = await supabase
            .from('tournaments')
            .update({ status: 'CANCELLED', ended_at: new Date().toISOString() }, { count: 'exact' })
            .eq('id', t.id)
            .eq('status', 'RUNNING');
          if (!cancelUpdated) continue;
          cancelledCount++;

          // TOURNEY-AUDIT 2026-07-24 (sweep 4): full cancel cleanup — refunds
          // real players (buy-in + fee, with fee reversal), closes stranded
          // tournament_players rows, and closes the tournament's tables.
          await refundAndCloseCancelledTournament(
            t.id,
            t.name ?? null,
            'SNG/Spin cancelled on server restart'
          );
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
        // TOURNEY-AUDIT 2026-07-24 (sweep 4): the "separate scheduled cleanup
        // should refund affected players" promised in the comment above NEVER
        // EXISTED — real players in a crashed >12h MTT simply lost their money,
        // and their tournament_players rows + tables stayed open forever.
        await refundAndCloseCancelledTournament(
          t.id,
          t.name ?? null,
          'Tournament cancelled (stalled >12h)'
        );
        console.log(
          `[GameServer] Cancelled genuinely stale RUNNING tournament ${t.id.slice(0, 8)} "${t.name}" (>12h, no recent hands)`
        );
      }
      console.log(
        `[GameServer] Stale-tournament sweep complete (${staleTourneys?.length || 0} reviewed)`
      );

      // 7. Recover stuck COMPLETING tournaments (crashed during finishTournament flow)
      // TOURNEY-AUDIT 2026-07-24 [CRITICAL]: the old path blind-flipped
      // COMPLETING → COMPLETED. A crash between the COMPLETING claim and the
      // winner credit meant the winner (and any unpaid ITM places) were NEVER
      // paid — the tournament just "completed" with stranded 'playing' rows
      // (verified live: a COMPLETED bounty MTT with 8 players still 'playing'
      // and $60 of a $100 guaranteed pool never paid). Recovery now PAYS what
      // is owed (positions by chip count, prizes per normalized payout
      // structure) before completing.
      await recoverStuckCompletingTournaments('startup-cleanup');

      // 8. TOURNEY-AUDIT 2026-07-24 (sweep 4): close ORPHANED tournament tables.
      // A crashed/abandoned tournament left its tables status='running' forever
      // (finishTournament only closes tables in the in-memory engine map). Any
      // open table whose tournament is COMPLETED/CANCELLED gets closed here.
      try {
        const { data: openTourneyTables } = await supabase
          .from('tables')
          .select('id, tournament_id')
          .not('tournament_id', 'is', null)
          .in('status', ['waiting', 'running', 'RUNNING'])
          .limit(500);
        if (openTourneyTables && openTourneyTables.length > 0) {
          const tourneyIds = [...new Set(openTourneyTables.map((t) => t.tournament_id))];
          const { data: finished } = await supabase
            .from('tournaments')
            .select('id')
            .in('id', tourneyIds)
            .in('status', ['COMPLETED', 'CANCELLED']);
          const finishedSet = new Set((finished ?? []).map((t) => t.id));
          const orphanIds = openTourneyTables
            .filter((t) => finishedSet.has(t.tournament_id))
            .map((t) => t.id);
          for (let i = 0; i < orphanIds.length; i += 100) {
            await supabase
              .from('tables')
              .update({ status: 'closed', current_players: 0 })
              .in('id', orphanIds.slice(i, i + 100));
          }
          if (orphanIds.length > 0) {
            console.log(`[GameServer] Closed ${orphanIds.length} orphaned tournament tables`);
          }
        }
      } catch (orphanErr) {
        reportError(orphanErr, 'GameServer.orphan_table_sweep');
      }

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
        // C17 FIX (2026-08-08): ONE grouped query, not an N+1.
        //
        // This used to read every waiting/running cash table and then issue a
        // separate count(*) on table_seats FOR EACH ONE. With 500-1,000 tables
        // that is 500-1,000 serial round trips every 5 seconds — and the worst
        // case is immediately after a restart, when no table has an engine yet
        // so every single one gets counted, at exactly the moment the database
        // is already absorbing the reconnect storm.
        //
        // cash_tables_with_players() does the GROUP BY ... HAVING server-side
        // (PostgREST cannot express it) and returns only tables that already
        // meet the threshold, which is the only thing the loop below cared about.
        const { data: ready, error } = await supabase.rpc('cash_tables_with_players', {
          p_min: 2,
        });

        if (error) {
          const errMsg =
            error?.message || (typeof error === 'object' ? JSON.stringify(error) : String(error));
          reportError(new Error(errMsg), 'GameServer.Cash_table_discovery_error');
          await this.sleep(TABLE_DISCOVERY_INTERVAL);
          continue;
        }

        for (const row of (ready || []) as Array<{ table_id: string; player_count: number }>) {
          // Skip if already running
          if (this.tableEngines.has(row.table_id)) continue;

          console.log(
            `[GameServer] Starting engine for cash table ${row.table_id} (${row.player_count} players)`
          );
          const engine = new ServerTableEngine(row.table_id);
          engine.setHub(tableStateHub); // Phase 1.1 PR-2: authoritative WS publisher
          this.tableEngines.set(row.table_id, engine);
          engine.start().catch((err) => {
            reportError(err, 'GameServer.Engine_start_failed_for_tablei');
            this.tableEngines.delete(row.table_id);
            tableStateHub.dropTable(row.table_id);
          });
        }

        // Clean up engines for tables that stopped — AND engines that are
        // lying about being alive.
        //
        // 2026-08-15: isRunning() only reflects a boolean the dealing loop
        // never clears when it dies, so a crashed engine stays in this map
        // forever and the `if (this.tableEngines.has(...)) continue;` guard
        // above then prevents discovery from ever rebuilding the table. Ten
        // production tables sat dead for 18+ minutes this way. Cross-check
        // against observable progress: if the discovery RPC still lists the
        // table as ready to deal but its engine has done nothing for three
        // minutes, its loop is gone — drop it so the next cycle rebuilds it.
        const readyIds = new Set(
          ((ready || []) as Array<{ table_id: string }>).map((r) => r.table_id)
        );
        for (const [id, engine] of this.tableEngines) {
          if (!engine.isRunning()) {
            this.tableEngines.delete(id);
            tableStateHub.dropTable(id); // Phase 1.1 PR-2: release hub room
            continue;
          }
          if (readyIds.has(id) && engine.msSinceProgress() > 180_000) {
            reportError(
              new Error(
                'Engine for ' +
                  id +
                  ' shows no progress for ' +
                  Math.round(engine.msSinceProgress() / 1000) +
                  's — rebuilding'
              ),
              'GameServer.zombie_engine_rebuilt'
            );
            void engine.stop().catch(() => {});
            this.tableEngines.delete(id);
            tableStateHub.dropTable(id);
          }
        }
      } catch (err) {
        const errMsg =
          err instanceof Error
            ? err.message
            : (err as any)?.message ||
              (typeof err === 'object' ? JSON.stringify(err) : String(err));
        reportError(new Error(errMsg), 'GameServer.Cash_table_discovery_error');
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
            // TOURNEY-AUDIT 2026-07-24 (sweep 5) [CRITICAL — money mint]: the
            // old inline refund loop credited buy-in + fee to EVERY registered
            // row INCLUDING HORSES, who register free — every under-filled
            // auto-cancel (the platform runs hundreds per week) minted
            // horses' entry money out of thin air. The shared cleanup refunds
            // ONLY real players (with fee reversal in the rake ledger) and
            // closes the player rows instead of deleting the audit trail.
            const { data: cancelClaim } = await supabase
              .from('tournaments')
              .update({ status: 'CANCELLED', ended_at: new Date().toISOString() })
              .eq('id', tournament.id)
              .in('status', ['ANNOUNCED', 'REGISTERING'])
              .select('id');
            if (cancelClaim && cancelClaim.length > 0) {
              await refundAndCloseCancelledTournament(
                tournament.id,
                tournament.name ?? null,
                'Tournament cancelled (insufficient players)'
              );
            }
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
            // No active engine managing this tournament — it's truly stuck.
            // TOURNEY-AUDIT 2026-07-24: recovery now PAYS remaining players
            // (winner + unpaid ITM places) before completing — the old path
            // flipped straight to COMPLETED and the winner's prize vanished.
            console.warn(
              `[GameServer] Recovering stuck COMPLETING tournament: ${stuck.name} (${stuck.id.slice(0, 8)})`
            );
            await recoverStuckCompletingTournaments('discovery-watchdog', stuck.id);
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
