/**
 * GameServer — server-side game orchestration.
 *
 * Extracted from `server/src/index.ts` in Phase U3.4b (2026-04-23) — the
 * final step of the index-monolith split per platform plan 2.3. On 2026-07-28
 * TournamentManager moved out to `./tournament/` (engine audit D21); it is
 * re-exported here so existing importers keep working.
 */

import { ServerTableEngine } from './engine/ServerTableEngine.js';
import {
  supabase,
  startHandHistoryRetry,
  stopHandHistoryRetry,
  onHandHistoryRecovered,
  drainHandHistoryQueue,
  handHistoryQueueDepth,
} from './services/supabase.js';
import { HorseFleetManager } from './services/HorseFleetManager.js';
import {
  TournamentRecurringService,
  mttPrestartHorseTarget,
  MTT_PRESTART_RAMP_MS,
  seatFirstStartStalled,
  SEAT_FIRST_START_STALL_MS,
} from './services/TournamentRecurringService.js';
import { ScheduledTournamentService } from './services/ScheduledTournamentService.js';
import { HorseLifecycleManager } from './services/HorseLifecycleManager.js';
import { DealRateVerifier } from './services/DealRateVerifier.js';
import {
  renewLeadership,
  startLeadershipRenewal,
  stopLeadershipRenewal,
  releaseLeadership,
  isLeader,
  leadershipDiagnostics,
  markBootedAsStandby,
} from './services/leadership.js';
import {
  claimTournament,
  heartbeatTournaments,
  releaseTournaments,
  tournamentLeaseDiagnostics,
} from './services/tournamentLease.js';
// BUG 008 FIX: Periodic rakeback settler - flushes per-hand rake_records into rakeback_periods.
import { RakebackSettlerService } from './services/RakebackSettlerService.js';
import {
  reconcilePendingFees,
  auditBBJDrift,
  repairUnbankedBBJFees,
} from './services/FeeReconciler.js';
import { reportError, initSentry, flushSentry } from './services/errorReporter.js';
import { fetchAllRows } from './services/supabase/pagination.js';
// Phase 1.1 PR-2: native WebSocket transport for authoritative state
import { tableStateHub } from './transport/TableStateHub.js';

// Dan 2026-08-19: refundAndCloseCancelledTournament is no longer imported here.
// GameServer had four tournament-cancel paths; all four are gone. Nothing in
// this file cancels a tournament any more — it fills, resumes or settles.
import { recoverStuckCompletingTournaments } from './tournament/tournamentRecovery.js';
import { TournamentManager } from './tournament/TournamentManager.js';
import { ENGINE_START_BUDGET_MAX, nextEngineStartBudget } from './engineStartBudget.js';
// 2026-08-16: single-owner table leases + per-process identity. See
// services/tableLease.ts for the dual-container incident that motivated them.
import {
  INSTANCE_ID,
  claimTable,
  heartbeatTables,
  retryRefusedClaims,
  releaseTables,
  leaseDiagnostics,
} from './services/tableLease.js';

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
  /**
   * Table ids whose engine is owned and rebuilt by a TournamentManager rather
   * than by discoverCashTables. Discovery's RPC is cash-only, so without this
   * set the reaper treated every tournament table as "not supposed to be
   * dealing" and silently skipped its freeze recovery.
   */
  private tournamentOwnedTables: Set<string> = new Set();
  /**
   * Last time the cash-table discovery RPC completed successfully. Discovery is
   * the only thing that starts engines AND the only thing that reaps zombies —
   * if it stalls, the whole platform is frozen with nothing to notice.
   */
  /**
   * How long a boot is given before discovery staleness may declare the
   * process dead. Generous on purpose: it only delays a verdict that Docker's
   * own 90s start-period already suppresses, and the cost of being early is
   * killing a container that is starting correctly.
   */
  private static readonly STARTUP_GRACE_MS = 180_000;

  private lastDiscoveryOkAt: number = Date.now();
  /**
   * When the discovery loop last RAN, as opposed to last succeeded.
   *
   * These are different questions and conflating them restarted healthy
   * engines. `lastDiscoveryOkAt` only advances when the RPC comes back clean,
   * so a minute of database trouble made it look like the loop had stopped —
   * when the loop was in fact running perfectly and being told "no" each time.
   */
  private lastDiscoveryAttemptAt: number = Date.now();

  /**
   * C20 FIX (2026-08-23): bound how many engines may be adopted per sweep, and
   * back off when the database says it is struggling.
   *
   * C19 staggered engine starts by 40ms, which spread the initiation of each
   * start but capped nothing: on a restart every table in the discovery result
   * still had its start() issued inside one sweep, and because those starts are
   * fired and not awaited, ~180 engines were loading seats and table config
   * concurrently against a database already absorbing the reconnect storm.
   *
   * Measured nine minutes after a restart: 686 statement timeouts in three
   * minutes, 35 hand-history insert failures, 21 lost table leases, discovery
   * stalled 108 seconds, and health reporting liveness dead while the process
   * was in fact fine. Hand throughput fell from ~250/min to 24/min. Zero lock
   * waits throughout - this was never contention, it was concurrency.
   *
   * The amplifier is that failure was free to repeat. A start that times out
   * deletes itself from tableEngines (see the .catch below), so the very next
   * sweep retried the same volume into the same overloaded database. Load
   * caused failure, failure recreated the load.
   *
   * The control law lives in engineStartBudget.ts, pure and tested there.
   */
  private engineStartBudget: number = ENGINE_START_BUDGET_MAX;
  /**
   * Set by the async .catch on engine.start(), read and cleared once per sweep.
   * A start failure is the earliest honest signal that adoption is outrunning
   * what the database can serve - earlier than the discovery RPC failing,
   * because that RPC is one cheap indexed read and a start is many.
   */
  private engineStartFailures: number = 0;

  /** Applies the C20 control law to this instance. Returns the new budget. */
  private adjustEngineStartBudget(distressed: boolean): number {
    this.engineStartBudget = nextEngineStartBudget(this.engineStartBudget, distressed);
    return this.engineStartBudget;
  }
  /**
   * When this process started. Used to keep boot from looking like death --
   * see the startup grace in getStatus().
   */
  private readonly processStartedAt: number = Date.now();
  private tournamentEngines: Map<string, TournamentManager> = new Map();
  /**
   * Dan 2026-08-23: last time the MTT pre-start horse ramp ran per tournament.
   *
   * discoverTournaments runs every 5 seconds. The ramp costs several queries
   * per tournament, and with ~30 events on the board that is a needless six
   * queries a second forever to conclude that a quadratic curve has barely
   * moved. Once every 45s is far finer-grained than the curve, and the lobby
   * is polling on its own clock anyway.
   */
  private lastMttRampAt: Map<string, number> = new Map();
  /**
   * When each seat-first game was FIRST seen holding every seat it sells.
   *
   * The clock for the fully-paid-but-never-started watchdog (2026-08-24 audit
   * P2-7). Held in memory on purpose: a restart re-arms it, so a fresh process
   * spends one stall window observing the board before it force-starts
   * anything on it.
   */
  private seatFirstFullSince: Map<string, number> = new Map();
  /** Last fn_sweep_unsettled_tournament_rake pass (2026-08-26 settlement integrity). */
  private lastRakeSweepAt = 0;
  /** Last fn_tournament_money_conservation pass (2026-08-27 phase 3). */
  private lastConservationAt = 0;
  /** Last fn_backpay_hu_winner_shortfalls pass (2026-08-27 phase 3d). */
  private lastHuBackpayAt = 0;
  private running: boolean = false;
  private startTime: number = Date.now();

  // Server-side services (replaces browser-based DealerPage services)
  private horseFleet = new HorseFleetManager();
  private tournamentRecurring = new TournamentRecurringService();
  // Data-driven recurring schedules (tournament_schedules) — runs alongside the
  // hardcoded recurring blocks, acting only on rows written into the database.
  private scheduledTournaments = new ScheduledTournamentService();
  private lifecycle = new HorseLifecycleManager();

  /**
   * Liveness the engine cannot fake — see services/DealRateVerifier.ts.
   *
   * Every other freeze detector in this process is this process judging
   * itself. This one asks the DATABASE whether the tables it claims should be
   * dealing are actually producing hands.
   */
  private dealRateVerifier = new DealRateVerifier(() =>
    this.tableLivenessSnapshot()
      .filter((t) => t.dealable >= 2 && !t.paused)
      .map((t) => t.tableId)
  );
  // BUG 008 FIX: settler reads rake_records (durable per-hand log) every 30 min and
  // upserts per-player rakeback_periods rows. Without this the in-memory accumulator
  // inside RakebackEngine never flushes (zero callers of settleRakeback before fix).
  private rakebackSettler = new RakebackSettlerService();

  // Synchronized break timer — last hand announced at :55, break runs 5 min after it lands
  private breakTimer: NodeJS.Timeout | null = null;
  /**
   * A5: drains `pending_fee_distributions` — rake / BBJ fees that left a pot but
   * whose banking RPC failed — and runs the independent BBJ ledger-drift alarm.
   */
  private feeReconcileTimer: NodeJS.Timeout | null = null;
  private breakResumeTimer: NodeJS.Timeout | null = null;
  /**
   * When the platform-wide break is expected to end, as epoch ms; 0 when no
   * break is running.
   *
   * A TOURNAMENT THAT STARTS DURING A BREAK USED TO DEAL STRAIGHT THROUGH IT
   * (2026-08-23). triggerSynchronizedBreak snapshots the running MTTs at :55
   * and pauses that list. A tournament that reached its start time at :56 was
   * not in the snapshot, so nothing paused it and nothing resumed it: it ran
   * its opening levels alone while every other event on the platform sat on
   * the break screen. MTTs start on a schedule, so this is not a rare corner —
   * any event scheduled in the last five minutes of an hour hit it every time.
   *
   * Kept as a deadline rather than a boolean so a late joiner is paused for
   * exactly the remainder rather than for a fresh five minutes.
   */
  private breakEndsAt = 0;
  private static readonly BREAK_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  /**
   * Dan 2026-08-19: breaks start at the :55 mark of every hour and last five
   * minutes, so play resumes exactly on the hour.
   */
  private static readonly BREAK_START_MINUTE = 55;
  /**
   * Longest a table may sit paused ON PURPOSE before the reapers stop believing
   * it. Comfortably above the worst legitimate case (5 min break + 2 min
   * last-hand grace), so a real break is never disturbed, while a table wedged
   * in a pause still gets rebuilt instead of freezing forever.
   */
  static readonly MAX_HEALTHY_PAUSE_MS = 10 * 60 * 1000;

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

    /**
     * LEADER OR STANDBY — RESOLVED FIRST, BEFORE ANYTHING ELSE.
     *
     * This was originally placed after cleanupStaleData(), and running it for
     * real showed why that is wrong. A standby booted, spent nine seconds
     * hydrating 20,000 HorseMind pairs, and -- far worse -- ran the cleanup:
     *
     *     [GameServer] Closed 10 orphaned tournament tables and released their seats
     *
     * A standby had mutated shared state while another instance was live. It
     * then discovered it was a standby and returned, having already done the
     * one thing it must never do. It also took so long to get there that it
     * failed its healthcheck and autoheal restarted it, which started the whole
     * sequence again.
     *
     * cleanupStaleData closes tables, releases seats and resets horses. It is
     * recovery work that belongs to exactly one process: the one that owns the
     * fleet. So leadership is now the FIRST thing start() decides, before any
     * read, any write and any hydration.
     *
     * Fail-open on error, and a standby retains standby -- see
     * services/leadership.ts for why that asymmetry matters.
     */
    const role = await renewLeadership();
    startLeadershipRenewal();
    if (role === 'standby') {
      /**
       * Tell leadership.ts that this process never started the fleet, so that
       * if it is later promoted it restarts into the full leader boot instead
       * of becoming a leader that does nothing. See markBootedAsStandby().
       */
      markBootedAsStandby();
      const d = leadershipDiagnostics();
      console.log(
        `[GameServer] STANDBY — ${d.holder} holds leadership. Claiming nothing, ` +
          'cleaning nothing, hydrating nothing. Will take the fleet if that lease goes stale.'
      );
      // Nothing below runs. The renewal interval is the only thing alive, and
      // /health answers 503 so Caddy keeps traffic on the leader.
      return;
    }

    // Step 1: Clean up stale data from previous runs.
    // Test mode passes the protected id so cleanup spares it.
    await this.cleanupStaleData(testTableId);

    if (!maintenanceMode && !testTableId) {
      /**
       * DISCOVERY GOES FIRST (2026-08-24). It used to be Step 6, behind
       * `await this.horseFleet.start()`.
       *
       * The discovery loops are the only thing that attaches an engine to a
       * table, which is to say they are the only reason the platform deals a
       * hand. Everything they used to sit behind is housekeeping: seeding the
       * horse fleet, scheduling recurring tournaments, lifecycle sweeps, rebuy
       * funding, rakeback settlement.
       *
       * ensureAllTablesExist() inside the fleet bootstrap reads the whole table
       * list, and under load that read times out and retries. While it did,
       * `await` held the boot at Step 2 and Step 6 was simply never reached, so
       * the process ran as a leader with no discovery loop at all:
       *
       *   [HorseFleet.table_lookup_failed] Error: supabase_timeout
       *     at HorseFleetManager.ensureAllTablesExist
       *     at HorseFleetManager.start
       *     at GameServer.start
       *
       * The observable signature is discoveryLoopStalledMs climbing in exact
       * lockstep with uptime, activeTables pinned at 0, and liveness flipping to
       * 'dead' once past the startup grace - at which point the healthcheck kills
       * a container that was, by its own lights, booting normally. That is the
       * restart loop that kept the fleet at zero tables on 2026-08-24, and it is
       * why neither the adoption budget nor the leadership fixes cured it: they
       * govern a loop that was never running.
       *
       * cleanupStaleData() above stays awaited and stays first. That one IS a
       * prerequisite - it deletes stale seats and resets table state, and
       * adopting a table before it runs would hand an engine a half-torn-down
       * table. Nothing from here on is a prerequisite for dealing.
       *
       * These are infinite while-loops: fire-and-forget with error handling.
       */
      this.discoverCashTables().catch((err) =>
        reportError(err, 'GameServer.Cash_table_discovery_fatal_err')
      );
      this.discoverTournaments().catch((err) =>
        reportError(err, 'GameServer.Tournament_discovery_fatal_err')
      );

      /**
       * The fleet bootstrap is no longer awaited, for the same reason it no
       * longer runs first: a housekeeping step that can retry a timing-out
       * query must not be able to hold up the rest of the boot. Everything
       * below is a `.start()` that returns immediately, so awaiting this was
       * the single point at which a slow database could stop the whole boot
       * sequence.
       *
       * Nothing below needs the fleet to be seeded already. The recurring
       * tournament service and the lifecycle sweeps are pollers; they pick the
       * fleet up on their next tick. Discovery likewise re-runs every
       * TABLE_DISCOVERY_INTERVAL, so tables the fleet creates late are adopted
       * on the next sweep rather than missed.
       */
      void this.horseFleet
        .start()
        .catch((err) => reportError(err, 'GameServer.horse_fleet_start_failed'));

      // Step 3: Start tournament recurring service (creates MTTs, SNGs, Spins)
      this.tournamentRecurring.start();

      // Step 3b: Start the data-driven scheduler (tournament_schedules rows)
      this.scheduledTournaments.start();

      // Step 4: Start lifecycle manager (stuck horse detection, cleanup)
      this.lifecycle.start();

      // Step 5: Start server-side auto-rebuy wallet funder

      // Step 5a: the only liveness check that does not ask this process
      // whether it is alive. See services/DealRateVerifier.ts.
      this.dealRateVerifier.start();

      // Step 5b (BUG 008 FIX): Start periodic rakeback settler (30-min interval).
      // Reads rake_records → upserts rakeback_periods so players see accumulated
      // rakeback in the UI and weekly settlement has rows to pay out.
      this.rakebackSettler.start();

      // Step 7: Start synchronized break timer (last hand at :55, then 5 min break)
      this.scheduleSynchronizedBreaks();

      // Step 8 (A5): Start the fee reconciler. Rake and the BBJ contribution are
      // taken out of the pot inside the hand; if the banking RPC fails the chips
      // exist nowhere. The engine now queues those failures durably — this drains
      // that queue, and independently compares what rake_records booked as BBJ
      // contribution against what the jackpot pool actually received, because a
      // failure the engine never noticed would otherwise stay invisible (it did,
      // for a week).
      this.startFeeReconciler();

      // Step 8b (2026-08-20): drain the hand_history retry queue. hand_history
      // writes go to zero platform-wide for 30-120s at a time under load (see
      // the note above insertHandHistoryRow); a hand's payload only exists in
      // memory at settlement, so a failed write is held and re-attempted here
      // rather than losing the hand and leaving its rake unattributable.
      startHandHistoryRetry();
      // Tell the table when a hand the queue was holding finally lands, so the
      // client can open the right replay. Without this the client falls back to
      // "my most recent hand", which for a recovered hand is always wrong.
      onHandHistoryRecovered(({ tableId, handNumber, handId }) => {
        tableStateHub.emitEvent(tableId, {
          type: 'hand_history_saved',
          table_id: tableId,
          hand_number: handNumber,
          hand_id: handId,
          recovered: true,
          timestamp: Date.now(),
        });
      });

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
    this.scheduledTournaments.stop();
    this.lifecycle.stop();
    this.dealRateVerifier.stop();
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

    // Hand the leases back BEFORE the engines are torn down. A rolling deploy
    // otherwise makes the incoming container wait out the full 30s stale window
    // on every table, which is 30s of a live platform not dealing. Best-effort:
    // releaseTables never throws and never blocks shutdown.
    stopLeadershipRenewal();
    // Hand leadership back first: the standby can then promote at once instead
    // of waiting out the staleness window on a planned restart.
    await releaseLeadership();
    await releaseTables();
    await releaseTournaments();

    /**
     * C19 FIX (2026-08-20): drain in-flight hands, then stop everything at once.
     *
     * This used to stop engines one at a time, each awaiting its own teardown
     * (which now includes a snapshot flush). With 40 tables that is 40 serial
     * round trips inside a 20s shutdown budget, so the tail of the list was
     * routinely SIGKILLed rather than stopped — and every table still mid-hand
     * had that hand abandoned outright: cards dealt, chips committed, no
     * settlement.
     *
     * Now: ask every table to park AFTER its current hand (pauseAfterHand is
     * exactly that primitive — the deal loop only reaches the gate between
     * hands), wait a bounded window for them to arrive, then tear down in
     * parallel. A table that does not drain in time is stopped anyway, so
     * shutdown is still strictly bounded; the drain converts the common case
     * from "abandon ~40 hands" into "abandon none".
     */
    const DRAIN_BUDGET_MS = 12_000;
    const DRAIN_POLL_MS = 250;
    const engines = [...this.tableEngines.values()];
    if (engines.length > 0) {
      for (const engine of engines) {
        try {
          engine.pauseAfterHand(DRAIN_BUDGET_MS);
        } catch {
          /* a table that cannot be asked to pause is stopped below regardless */
        }
      }
      const drainDeadline = Date.now() + DRAIN_BUDGET_MS;
      let pending = engines.filter((e) => !e.isDrained()).length;
      while (pending > 0 && Date.now() < drainDeadline) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
        pending = engines.filter((e) => !e.isDrained()).length;
      }
      console.log(
        pending === 0
          ? `[GameServer] Drained all ${engines.length} table(s) between hands`
          : `[GameServer] Drain window elapsed with ${pending}/${engines.length} table(s) still mid-hand — stopping anyway`
      );
    }

    // Stop all table engines IN PARALLEL. allSettled so one engine that throws
    // on teardown cannot strand the rest half-stopped.
    await Promise.allSettled(engines.map((engine) => engine.stop()));
    this.tableEngines.clear();

    // ── Flush the hand_history retry queue ──────────────────────────────────
    //
    // REVIEW FIX 2026-08-20: this block used to run near the TOP of stop(),
    // before releaseTables() and before the pauseAfterHand drain below. That
    // was exactly backwards. `pauseAfterHand` parks each table AFTER its
    // current hand, so every table settles one more hand during that window —
    // and a rolling deploy, with its connection churn, is precisely when those
    // writes fail. Each of those hands was enqueued into a queue whose timer
    // had already been cleared and which nothing would ever drain again. They
    // were discarded at process exit with no log and no alert, because the
    // alert had already run minutes earlier against an empty queue.
    //
    // It belongs here: after every engine has stopped and no new hand can
    // settle. The deadline is now passed INTO the drain, which checks it per
    // entry, so it is a real bound rather than a between-passes hope.
    if (handHistoryQueueDepth() > 0) {
      const deadline = Date.now() + 6_000;
      console.log(`[GameServer] flushing ${handHistoryQueueDepth()} queued hand_history row(s)...`);
      while (handHistoryQueueDepth() > 0 && Date.now() < deadline) {
        const before = handHistoryQueueDepth();
        const summary = await drainHandHistoryQueue(deadline);
        // `joined` means we awaited a drain someone else started; that one may
        // have finished its own batch without touching ours, so a single
        // no-progress pass is not proof there is nothing left to do.
        if (!summary.joined && handHistoryQueueDepth() >= before) break;
      }
      if (handHistoryQueueDepth() > 0) {
        reportError(
          new Error(
            `[GameServer] shutting down with ${handHistoryQueueDepth()} hand_history row(s) ` +
              `still unwritten — those hands will have no history row.`
          ),
          'GameServer.hand_history_queue_lost_on_shutdown'
        );
      }
    }
    onHandHistoryRecovered(null);
    stopHandHistoryRetry();

    // Stop all tournament engines
    for (const [, tm] of this.tournamentEngines) {
      try {
        tm.stop();
      } catch {
        /* keep tearing the rest down */
      }
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
    // Per-table liveness first — everything below is aggregate telemetry that
    // cannot distinguish a dealing table from a frozen one.
    const tableLiveness = this.tableLivenessSnapshot();
    const stalledTables = tableLiveness
      .filter((t) => t.dealable >= 2 && !t.paused && t.msSinceProgress > 120_000)
      .map((t) => ({
        tableId: t.tableId,
        dealable: t.dealable,
        secsIdle: Math.round(t.msSinceProgress / 1000),
      }));
    // LIVENESS RACE FIX (2026-08-22): the per-table recovery chain (watchdog
    // Tier 1-3 -> killForRestart -> 180s zombie reaper -> discovery rebuild)
    // needs up to ~3 minutes end to end. Flipping the whole process 'dead' at
    // 120s meant Docker restarted the container — voiding every in-flight
    // hand on every healthy table — BEFORE the single wedged table's own
    // recovery had a chance to finish. Report stalls at 120s (visibility),
    // but only declare the process dead once a table has out-stalled the
    // entire in-process recovery chain.
    const deadStalledCount = tableLiveness.filter(
      (t) => t.dealable >= 2 && !t.paused && t.msSinceProgress > 300_000
    ).length;
    const discoveryStaleMs = Date.now() - this.lastDiscoveryOkAt;
    /**
     * ── A SLOW DATABASE IS NOT A DEAD PROCESS (2026-08-23) ──────────────────
     *
     * liveness used `discoveryStaleMs > 60_000`, and `lastDiscoveryOkAt` only
     * advances on a SUCCESSFUL rpc. So one minute of database trouble flipped
     * the whole process to 'dead' -> Docker healthcheck fails -> sp-autoheal
     * kills the container -> every in-flight hand on every table it owned is
     * voided. The engine was fine. The database was slow.
     *
     * Verified: `club-arena-engine-2` was marked unhealthy four times between
     * 05:35 and 05:43 UTC while running a healthcheck that connects perfectly,
     * so the probe was reaching the engine and being TOLD 'dead'.
     *
     * This is the same mistake as the dealing-loop watchdog in #281, one level
     * up, and it takes the same shape of fix: ask whether the loop is RUNNING
     * (`lastDiscoveryAttemptAt`), not whether its last answer was good.
     * Sustained RPC failure is still reported — see discoveryStaleMs below and
     * the fleet alarms — it simply no longer restarts a healthy container.
     */
    const discoveryLoopStalledMs = Date.now() - this.lastDiscoveryAttemptAt;
    /**
     * ── BOOTING IS NOT DEAD (2026-08-23) ────────────────────────────────────
     *
     * discoveryLoopStalledMs is measured from lastDiscoveryAttemptAt, which is
     * seeded at construction and then stamped by the discovery loop. But the
     * loop does not START until start() has finished cleanupStaleData, the
     * horse fleet and HorseMind hydration -- and on a busy database that can
     * take longer than 60s. During that window the engine reports 'dead' while
     * doing exactly what it is supposed to.
     *
     * OBSERVED LIVE, not theorised: on the 2026-08-23 leader/standby rollout
     * /health returned liveness 'dead' at ~60s uptime on a container that was
     * booting perfectly and reported 'ok' thirty seconds later.
     *
     * Docker's --health-start-period=90s covers the usual case, which is why
     * this has not bitten -- but a boot slower than 90s is exactly a boot
     * against a struggling database, and that is the worst possible moment to
     * have autoheal kill the container. Same reasoning, and the same fix, as
     * the fleet-floor startup grace in DealRateVerifier.
     *
     * A boot that never finishes is still caught: the process either fails to
     * answer /health at all, or finishes and starts being judged normally.
     */
    const stillBooting = Date.now() - this.processStartedAt < GameServer.STARTUP_GRACE_MS;
    // The one liveness signal not derived from this process's own beliefs.
    // deadStalledCount above is computed from msSinceProgress(), which
    // markProgress() sets about our own work; on 2026-08-22 that belief was
    // wrong for six hours and every layer above /health inherited it. This
    // asks the database instead. See services/DealRateVerifier.ts.
    const dealRate = this.dealRateVerifier.snapshot();

    /**
     * ── TABLE PROGRESS VETOES A DISCOVERY-STALL DEATH (2026-08-24) ─────────
     *
     * OBSERVED LIVE tonight: discoveryLoopStalledMs read 87s (one discovery
     * CYCLE blocked inside a slow database call, so no new attempt was
     * stamped) while 123 tables were active, 0 were stalled, and hand_history
     * showed a hand completing every second. liveness said 'dead' anyway —
     * inviting sp-autoheal to restart a demonstrably dealing engine and void
     * every one of those tables. A blocked discovery cycle pauses NEW table
     * adoption; it does not stop play. If any table made progress inside the
     * last 2 minutes the process cannot be dead, so a discovery stall alone
     * must not kill it.
     *
     * BOUNDED, because the opposite failure is real too: a discovery loop
     * wedged forever on a hung await would otherwise never be restarted while
     * horses keep tables "progressing" indefinitely. Past 15 minutes of no
     * discovery attempts the restart is the correct answer regardless.
     */
    const anyTableProgressedRecently = tableLiveness.some((t) => t.msSinceProgress < 120_000);
    const discoveryLoopDead =
      !stillBooting &&
      (discoveryLoopStalledMs > 900_000 ||
        (discoveryLoopStalledMs > 60_000 && !anyTableProgressedRecently));

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
      // ── LIVENESS (2026-08-15) ────────────────────────────────────────────
      // `status` reflects only whether the process booted. A table freeze is
      // invisible to it, which is why the 2026-08-15 incident was reported by a
      // player rather than by monitoring. `liveness` is the hard signal: it goes
      // 'dead' when any table with 2+ dealable seats has made no observable
      // progress for 2 minutes, or when the discovery loop itself has stalled.
      // The Docker HEALTHCHECK reads this field, so a wedged process restarts
      // itself with no human involved.
      /**
       * 'standby' is deliberately its own value, read by two different
       * consumers that need different answers:
       *
       *   Caddy  active health check expects 2xx; the handler returns 503 for a
       *          standby, so it is marked down and traffic goes to the leader.
       *   Docker healthcheck exits non-zero only on 'dead', so a standby is
       *          NOT restarted -- it must stay alive to be able to take over.
       */
      liveness: !isLeader()
        ? 'standby'
        : deadStalledCount > 0 || discoveryLoopDead || dealRate.dbConfirmedDead
          ? 'dead'
          : 'ok',
      /**
       * Independent evidence, reported whether or not it has reached a
       * verdict, so a fleet going quiet is visible BEFORE anything restarts.
       * `handsInWindow: null` means the database could not be asked — which is
       * explicitly NOT counted as silence.
       */
      /**
       * Independent evidence, reported whether or not it has reached a verdict.
       * `belowFloorChecks` is the canary: the deal-rate check stands down on a
       * tiny fleet, so a failure that also empties the fleet would silence it —
       * losing the floor is its own alarm.
       */
      dealRate,
      /**
       * Time since discovery last SUCCEEDED. High means the database is
       * struggling; it is reported for visibility but no longer flips
       * liveness, because it cannot distinguish a slow database from a dead
       * engine. `discoveryLoopStalledMs` can.
       */
      discoveryLoopStalledMs,
      /**
       * C20 adoption budget. At ENGINE_START_BUDGET_MAX the database is coping;
       * lower means engine starts have been failing and the loop has throttled
       * itself. Pinned at the floor across several polls is the signal that the
       * database tier, not the engine, is the constraint.
       */
      engineStartBudget: this.engineStartBudget,
      tournamentLease: tournamentLeaseDiagnostics(),
      leadership: leadershipDiagnostics(),
      stalledTableCount: stalledTables.length,
      // Deploy drain gate reads this. A restart voids in-flight hands, so a
      // routine server/ push waits (or is explicitly forced) while real people
      // are seated. Horses are excluded — they do not care.
      humansSeatedTotal: tableLiveness.reduce((n, t) => n + t.humans, 0),
      stalledTables: stalledTables.slice(0, 20),
      discoveryStaleMs,
      tableLiveness,
      status: this.running ? 'ok' : 'degraded',
      version: process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local',
      // ── PROCESS IDENTITY (2026-08-16) ───────────────────────────────
      // On 2026-08-16 two engine containers served this hostname at once and
      // every field below `version` was ambiguous between them: /health said 15
      // tables, / said 0, /metrics said 0, and the database said 91. There was
      // no way to tell whether that was one flapping process or several, which
      // is why the incident took an hour to characterise. `instanceId` is
      // regenerated on every boot, so two answers carrying different ids prove
      // two processes, immediately and without host access.
      instanceId: INSTANCE_ID,
      pid: process.pid,
      // Split-brain evidence: tables this instance was refused, and who holds
      // them. Empty is the healthy state.
      lease: leaseDiagnostics(),
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
    // ── FREEZE OBSERVABILITY (2026-08-15) ────────────────────────────────
    // Before this, /metrics carried throughput (hands dealt, hands/hour) but
    // NOTHING that distinguishes a dealing table from a frozen one — and the
    // only alert that claimed to cover it, EngineDown, queried a job label
    // (`engine_pm2`) that does not exist in any scrape config, so it could
    // never fire. A table could sit dead for 18 minutes with every dashboard
    // green. These four gauges are what make a freeze alertable from outside
    // the process, independent of whether the engine can still report itself.
    const liveness = this.tableLivenessSnapshot();
    const stalled = liveness.filter(
      (t) => t.dealable >= 2 && !t.paused && t.msSinceProgress > 120_000
    );
    const pausedCount = liveness.filter((t) => t.paused).length;
    const freeze: string[] = [
      '# HELP poker_stalled_tables Tables with 2+ dealable seats, not paused by design, and no progress for 2 minutes',
      '# TYPE poker_stalled_tables gauge',
      `poker_stalled_tables ${stalled.length}`,
      '# HELP poker_paused_tables Tables paused on purpose (hand-for-hand/break) — excluded from stall detection',
      '# TYPE poker_paused_tables gauge',
      `poker_paused_tables ${pausedCount}`,
      '# HELP poker_discovery_stale_ms Milliseconds since the cash-table discovery loop last completed',
      '# TYPE poker_discovery_stale_ms gauge',
      `poker_discovery_stale_ms ${Date.now() - this.lastDiscoveryOkAt}`,
      '# HELP poker_discovery_loop_stalled_ms Milliseconds since the discovery loop last RAN (not since it last succeeded)',
      '# TYPE poker_discovery_loop_stalled_ms gauge',
      `poker_discovery_loop_stalled_ms ${Date.now() - this.lastDiscoveryAttemptAt}`,
      '# HELP poker_engine_liveness 1 when no table is stalled and the discovery loop is running, else 0',
      '# TYPE poker_engine_liveness gauge',
      // Must match getStatus(): a slow database is not a dead process, so this
      // keys on whether the loop RAN, not on whether its last answer was good.
      // Alerting on poker_discovery_stale_ms is still correct and still wired;
      // it just must not be what declares the engine dead.
      `poker_engine_liveness ${stalled.length === 0 && Date.now() - this.lastDiscoveryAttemptAt <= 60_000 ? 1 : 0}`,
      '# HELP poker_table_ms_since_progress Milliseconds since this table last made observable progress',
      '# TYPE poker_table_ms_since_progress gauge',
      ...liveness.map(
        (t) => `poker_table_ms_since_progress{table_id="${t.tableId}"} ${t.msSinceProgress}`
      ),
      '# HELP poker_table_dealable_seats Seats able to be dealt into on this table',
      '# TYPE poker_table_dealable_seats gauge',
      ...liveness.map((t) => `poker_table_dealable_seats{table_id="${t.tableId}"} ${t.dealable}`),
      // ── SPLIT-BRAIN (2026-08-16) ─────────────────────────────────
      // Every gauge above is per-process, so with two containers behind one
      // hostname Prometheus scrapes whichever the proxy picks and silently
      // averages two different realities. The instance label makes the series
      // distinct: two live `instance_id` values on this job IS the alert.
      '# HELP poker_engine_info Always 1. Labels identify the process answering this scrape.',
      '# TYPE poker_engine_info gauge',
      `poker_engine_info{instance_id="${INSTANCE_ID}",pid="${process.pid}",version="${
        process.env.GIT_COMMIT_SHA?.substring(0, 8) || process.env.ENGINE_VERSION || 'local'
      }"} 1`,
      '# HELP poker_lease_conflicts Tables this instance was refused because another engine holds them',
      '# TYPE poker_lease_conflicts gauge',
      `poker_lease_conflicts ${leaseDiagnostics().conflictCount}`,
    ];

    if (allLines.length === 0) {
      // Still emit freeze metrics: "no engines at all" is itself the loudest
      // possible signal, and returning a bare comment hid it.
      return freeze.join('\n') + '\n';
    }
    return allLines.join('\n') + '\n' + freeze.join('\n') + '\n';
  }

  /** Per-table liveness, shared by /health and /metrics. */
  private tableLivenessSnapshot() {
    return [...this.tableEngines].map(([id, engine]) => ({
      tableId: id,
      seated: engine.seatedCount(),
      dealable: engine.dealableCount(),
      humans: engine.humansSeated(),
      handCount: engine.getHandCount(),
      msSinceProgress: engine.msSinceProgress(),
      // 2026-08-22: where the dealing loop actually is, e.g. `load_seats+96s`.
      // /health could say a table had made no progress for 96 seconds but not
      // what it was doing for those 96 seconds, so a fleet-wide stall showed up
      // as ninety identical unexplained numbers. This is the missing half.
      loopPhase: engine.describeLoopPhase(),
      paused: engine.isPausedByDesign(),
      isTournament: engine.isTournament(),
    }));
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // SYNCHRONIZED BREAKS — All MTTs/XMTTs pause at the top of every hour
  // ═════════════════════════════════════════════════════════════════════════════

  private scheduleSynchronizedBreaks(): void {
    /**
     * Dan 2026-08-19: "BREAKS START AT THE 55 MINUTE MARK OF EVERY HOUR AND
     * LAST FOR 5 MINUTES." So the break window is :55 → :00, and play resumes
     * exactly on the hour. This previously fired at the TOP of the hour
     * (:00 → :05), which put the break at the wrong end of the hour.
     *
     * Verified broken on production before this change: with two MTTs running
     * and a stable engine, MTT hands ran straight through 04:00 (03:59=17,
     * 04:00=12, 04:01=1, 04:02=10) — and through 01:00, 02:00 and 03:00 too.
     */
    const now = new Date();
    const nextBreak = new Date(now);
    nextBreak.setMinutes(GameServer.BREAK_START_MINUTE, 0, 0);
    // Already past :55 this hour — go to :55 of the next hour.
    if (nextBreak.getTime() <= now.getTime()) {
      nextBreak.setHours(nextBreak.getHours() + 1);
    }
    const msUntilNextBreak = nextBreak.getTime() - now.getTime();

    console.log(
      `[GameServer] Synchronized break scheduled in ${Math.round(msUntilNextBreak / 60000)} minutes (:${GameServer.BREAK_START_MINUTE} of the hour, ${GameServer.BREAK_DURATION_MS / 60000} min long)`
    );

    /**
     * BREAKS STAY ON :55, THEY DO NOT DRIFT OFF IT (2026-08-23).
     *
     * This used to fire once at :55 and then hand the cadence to
     * `setInterval(..., 60 * 60 * 1000)`. A setInterval is not a clock: it
     * measures an hour from the moment the previous tick was DISPATCHED, and a
     * tick the event loop could not run on time is simply late — the lateness
     * is never given back. Every long GC pause, every synchronous Supabase
     * burst, every second the loop spent settling a hand pushed the next break
     * further past :55 than the last one, permanently, and the error
     * accumulated for as long as the process stayed up. On a box that had been
     * up for days the "synchronized" break was landing well off the mark for
     * every tournament at once — which is the whole complaint, because :55 is
     * the entire point of the rule.
     *
     * The break is a WALL-CLOCK event, so it is re-armed against the wall
     * clock after every firing: the next :55 is recomputed from Date.now()
     * each time. Drift cannot accumulate because nothing is measured relative
     * to the previous tick, and it self-corrects across a system clock change,
     * which an interval cannot do.
     *
     * triggerSynchronizedBreak is deliberately not awaited — it runs for the
     * length of the break (last-hand wait, then five minutes) and the next
     * arming must not wait on it.
     */
    this.breakTimer = setTimeout(() => {
      if (!this.running) return;
      void this.triggerSynchronizedBreak();
      // Re-arm from the wall clock, never from this moment.
      this.scheduleSynchronizedBreaks();
    }, msUntilNextBreak);
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
          // SELF-HEAL 2026-08-18: repair BEFORE auditing, so the audit reports
          // what is still broken rather than what was already fixable. The
          // repair backdates recovered rows to the original hand time, so a
          // successful repair drives the drift measurement to zero in the same
          // cycle instead of alarming on money that is now banked.
          const healed = await repairUnbankedBBJFees(48);
          if (healed.repaired > 0) {
            console.log(
              `[BBJ self-heal] recovered ${healed.repaired} unbanked contribution(s), ` +
                `${healed.chips.toFixed(2)} chips`
            );
          }
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
      // synchronized_breaks=false (2026-08-22 parity): the tournament opted out
      // of the platform-wide :55 break and keeps playing straight through it.
      // See TournamentManagerBase.synchronizedBreaksEnabled for the per-
      // structure-break note.
      if (tm.isRunning() && tm.isMttOrXmtt() && tm.synchronizedBreaksEnabled()) {
        mttEngines.push(tm);
      }
    }

    if (mttEngines.length === 0) {
      console.log('[GameServer] Synchronized break: no running MTTs/XMTTs to pause');
      return;
    }

    /**
     * Dan 2026-08-19: "AT THE 55 OF THE HOUR, THE LAST HAND IS DEALT FOR ALL
     * TOURNAMENT TABLES, ONCE THE LAST HAND ON EVERY TABLE IS COMPLETED, THE 5
     * MINUTE BREAK STARTS... SO IT CAN BE UP TO LIKE A 6 MINUTE BREAK."
     *
     * So this is two phases, not one:
     *   :55             announce the LAST HAND on every table
     *   last hand ends  START the five minutes
     *
     * The previous version started the five-minute timer at :55, which quietly
     * shortened every break by however long the final hand ran — a slow all-in
     * with runouts could eat most of it. The countdown now begins only once
     * every table across every tournament is parked between hands.
     */
    console.log(
      `[GameServer] ═══ LAST HAND ═══ Announcing final hand on ${mttEngines.length} MTT/XMTT tournament(s) — break starts when every table finishes`
    );

    /**
     * The break window opens NOW, at :55, not when the countdown starts. A
     * tournament that begins during the last-hand wait must be held too, so
     * claim the window immediately using the worst case (grace + break) and
     * tighten it below once the real countdown begins.
     */
    this.breakEndsAt =
      Date.now() + TournamentManager.LAST_HAND_GRACE_MS + GameServer.BREAK_DURATION_MS;

    for (const tm of mttEngines) {
      try {
        await tm.pauseForBreak(GameServer.BREAK_DURATION_MS);
      } catch (err: any) {
        reportError(err, 'GameServer.Failed_to_pause_tournament');
      }
    }

    const waitStartedAt = Date.now();
    const allParked = await this.waitForAllTablesParked(mttEngines);
    const lastHandMs = Date.now() - waitStartedAt;

    if (allParked) {
      console.log(
        `[GameServer] Last hand complete on every table after ${Math.round(lastHandMs / 1000)}s — starting the ${GameServer.BREAK_DURATION_MS / 60000} minute break`
      );
    } else {
      console.warn(
        `[GameServer] Last hand did not land on every table within ${Math.round(lastHandMs / 1000)}s — starting the break anyway so play resumes near the hour`
      );
    }

    // The countdown players see begins NOW, not at :55. Tighten the window
    // claimed above to the real end time, so a tournament starting during the
    // break is held for exactly as long as everyone else.
    this.breakEndsAt = Date.now() + GameServer.BREAK_DURATION_MS;

    for (const tm of mttEngines) {
      try {
        await tm.beginBreakCountdown(GameServer.BREAK_DURATION_MS);
      } catch (err: any) {
        reportError(err, 'GameServer.Failed_to_begin_break_countdown');
      }
    }

    // Never leave two resume timers pending. If a previous break's last-hand
    // wait overran far enough to overlap this one, the older timer would still
    // fire and resume tournaments a second time — harmless for the engines
    // (resumeFromBreak no-ops when !onBreak) but it would clear on_break in
    // the database out from under a live break, showing players a break that
    // the lobby says has already ended.
    if (this.breakResumeTimer) {
      clearTimeout(this.breakResumeTimer);
      this.breakResumeTimer = null;
    }
    this.breakResumeTimer = setTimeout(async () => {
      // Close the window FIRST. Anything starting from here on is not in a
      // break and must not be held.
      this.breakEndsAt = 0;
      console.log(
        `[GameServer] ═══ BREAK ENDED ═══ Resuming ${mttEngines.length} MTT/XMTT tournaments`
      );
      // Resume everything on break, not just the :55 snapshot — a tournament
      // that started during the break was held by holdIfBreakIsRunning and is
      // not in mttEngines. resumeFromBreak no-ops on anything not on break.
      const toResume = new Set<TournamentManager>(mttEngines);
      for (const tm of this.tournamentEngines.values()) toResume.add(tm);
      for (const tm of toResume) {
        try {
          await tm.resumeFromBreak();
        } catch (err: any) {
          reportError(err, 'GameServer.Failed_to_resume_tournament');
        }
      }
    }, GameServer.BREAK_DURATION_MS);
  }

  /**
   * How much of the platform-wide break is left, or 0 when none is running.
   * See the `breakEndsAt` field for why a tournament starting mid-break needs
   * to know this.
   */
  remainingBreakMs(): number {
    return this.breakEndsAt > 0 ? Math.max(0, this.breakEndsAt - Date.now()) : 0;
  }

  /**
   * Hold a tournament that has just started inside a live break, for whatever
   * is left of it. Without this it deals its opening levels alone while every
   * other event on the platform sits on the break screen.
   *
   * The resume is driven by the shared breakResumeTimer above, which now walks
   * every registered engine rather than the :55 snapshot, so nothing needs to
   * be scheduled here.
   */
  private async holdIfBreakIsRunning(tm: TournamentManager): Promise<void> {
    const remaining = this.remainingBreakMs();
    if (remaining <= 1000) return;
    if (!tm.isRunning() || !tm.isMttOrXmtt() || !tm.synchronizedBreaksEnabled()) return;
    try {
      console.log(
        `[GameServer] Tournament started during the break — holding it for the remaining ${Math.round(remaining / 1000)}s`
      );
      await tm.pauseForBreak(remaining);
      await tm.beginBreakCountdown(remaining);
    } catch (err: any) {
      reportError(err, 'GameServer.hold_new_tournament_for_break');
    }
  }

  /**
   * Poll until every table of every supplied tournament has finished the hand
   * that was in flight, or until the grace window expires.
   *
   * Returns true if everyone parked, false if the grace window won. A wedged
   * table must never hold the whole platform's break open — play resuming near
   * the hour matters more than one stuck table.
   */
  private async waitForAllTablesParked(managers: TournamentManager[]): Promise<boolean> {
    const deadline = Date.now() + TournamentManager.LAST_HAND_GRACE_MS;
    while (Date.now() < deadline) {
      if (!this.running) return false;
      if (managers.every((tm) => tm.areAllTablesParked())) return true;
      await this.sleep(500);
    }
    return managers.every((tm) => tm.areAllTablesParked());
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
      // Dan 2026-08-18 [P0]: this swept EVERY cash seat on EVERY boot, so an
      // ordinary deploy cashed out and deleted seats belonging to players who
      // were mid-session — Dan was removed from a live table twice today by
      // exactly this. Real people are not stale data. Only seats belonging to
      // HORSES are reaped here; a human's seat survives a restart (the engine
      // rebuilds its table from table_seats on boot, which is the whole point
      // of persisting them). Genuinely orphaned human seats are still handled
      // by HorseLifecycleManager's 4-hour sweep, which has activity guards.
      // 2026-08-20: paged. PostgREST caps every response at db-max-rows (1,000)
      // WITHOUT erroring — the truncation that made HorseFleetManager treat 428
      // occupied seats as empty and fire ~150,000 duplicate-key buy-ins a day.
      // Here the consequence would be worse than waste: a horse past the cap
      // reads as "not a horse", and this sweep's whole job is to reap ONLY
      // horse seats. Under-reading is safe (fail-closed), but it would leave
      // orphaned seats forever with no signal.
      const horsePage = await fetchAllRows<{ id: string }>(
        (cursor, want) => {
          let q = supabase
            .from('profiles')
            .select('id')
            .eq('is_horse', true)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'GameServer.staleSweep.horses', maxRows: 50_000 }
      );
      const horseIdList = horsePage.rows.map((h) => h.id);

      // FAIL CLOSED (2026-08-19 audit). The first version of this guard applied
      // the horse filter only `if (horseIdList.length > 0)`, so a failed or
      // empty profiles query silently dropped the filter and the sweep went
      // straight back to cashing out and DELETING every human seat — the exact
      // P0 this guard exists to prevent, reintroduced as a failure mode. If we
      // cannot prove which seats belong to horses, we sweep nothing.
      // FAIL CLOSED. If we cannot prove which seats belong to horses, we sweep
      // nothing — this sweep cashes out and DELETES seat rows, and a human's
      // seat must never be reaped by it.
      //
      // REVIEW FIX 2026-08-20: the previous version wrapped fetchAllRows in a
      // .catch() and tested `horseErr`. fetchAllRows never rejects — every
      // error path reports and returns — so that branch was unreachable and the
      // guard had silently weakened to "sweep whatever partial list we got".
      // Completeness is now part of the return type, so this cannot rot again.
      //
      // Note this only skips the SEAT SWEEP. It used to `return` out of the
      // whole of cleanupStaleData, which also skipped resetting cash tables to
      // 'waiting' and cancelling past-due tournaments WITH REFUNDS — and an
      // empty horse list is a normal state (DISABLE_HORSE_FLEET, a fresh DB).
      const canSweepSeats = horsePage.complete && horseIdList.length > 0;
      if (!canSweepSeats) {
        console.warn(
          '[GameServer] Stale-seat sweep SKIPPED — could not resolve the horse list ' +
            `(complete=${horsePage.complete}, horses=${horseIdList.length}). ` +
            'The rest of the cleanup still runs.'
        );
      }
      if (canSweepSeats) {
        // REVIEW FIX 2026-08-20: this said `.range(0, 4999)`, which does NOT
        // raise the cap — PostgREST applies db-max-rows AFTER the Range header,
        // so it still returned at most 1,000 rows with no error. That left the
        // single most dangerous statement on this path (it credits wallets and
        // DELETEs seat rows) silently truncated, while the read-only horse lookup
        // above it had been paged. Page it properly.
        const seatPage = await fetchAllRows<{
          id: string;
          user_id: string;
          table_id: string;
          seat_number: number;
          stack: number;
        }>(
          (cursor, want) => {
            let q = supabase
              .from('table_seats')
              .select('id, user_id, table_id, seat_number, stack, tables!inner(tournament_id)')
              .is('left_at', null)
              .is('tables.tournament_id', null)
              .order('id', { ascending: true })
              .limit(want);
            if (protectedTableId) q = q.neq('table_id', protectedTableId);
            if (cursor) q = q.gt('id', cursor);
            return q;
          },
          { label: 'GameServer.staleSweep.seats', maxRows: 50_000 }
        );
        // Same fail-closed rule as the horse list: this path DELETES seat rows.
        const horseIdSet = new Set(horseIdList);
        const activeSeats = seatPage.complete
          ? seatPage.rows.filter((s) => horseIdSet.has(s.user_id))
          : [];
        if (!seatPage.complete) {
          console.warn(
            '[GameServer] Stale-seat sweep SKIPPED — the seat read was incomplete. ' +
              'The rest of the cleanup still runs.'
          );
        }

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
                  // 2026-08-22: was `credit_player_wallet`, which moved the
                  // chips and wrote NOTHING to any ledger — a boot-time
                  // cash-out appeared in a player's balance out of thin air,
                  // with no wallet_transactions row and no chip_transactions
                  // row to account for it. Every other cash-out path on the
                  // platform goes through this RPC; this one now does too, so
                  // the row exists and the club resolution matches. Same
                  // idempotency key, so nothing about the dedupe changes.
                  const { error: walletErr } = await supabase.rpc('atomic_credit_wallet_and_log', {
                    p_user_id: userId,
                    p_amount: totalStack,
                    p_category: 'cashout',
                    p_description: 'Cash-out from table (server startup cleanup)',
                    p_table_id: null,
                    p_hand_id: null,
                    p_related_entity_id: null,
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
            console.log(
              `[GameServer] Safely cashed out ${cashedOut} seated players before cleanup`
            );
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
      } // end if (canSweepSeats)

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
        // Normal mode: reset to waiting so HorseFleetManager can re-populate.
        //
        // 2026-08-19: this used to include 'closed' in the status filter, so
        // every boot resurrected every closed cash table. Two things were
        // wrong with that:
        //
        //   1. A club admin closing a table (fn_admin_close_table) found it
        //      open again after the next deploy, with no record of why.
        //   2. Nothing could ever retire a cash table. 487 duplicate rows had
        //      accumulated from the ensureAllTablesExist bug (f73df9b2a), and
        //      closing them would have lasted exactly until the next restart.
        //
        // CLOSED IS A DECISION, NOT A STATE TO CLEAN UP. The fleet still
        // reopens the tables it owns: ensureAllTablesExist reactivates the
        // canonical row for each config when it finds it closed. What it will
        // not do any more is reopen 487 rows nobody asked for.
        await supabase
          .from('tables')
          .update({ current_players: 0, status: 'waiting' })
          .is('tournament_id', null)
          .in('status', ['waiting', 'running']);
        console.log(
          '[GameServer] Reset cash table player counts and statuses to waiting (closed tables left closed)'
        );
      }

      /**
       * 3b. Prune dead lease rows.
       *
       * `claim_table_lease` upserts on a unique id, so the tables never hold
       * more than one row per table/tournament — but nothing ever DELETES a row
       * whose table is long gone. `release_*` only runs on a graceful shutdown,
       * and a container that dies hard leaves its rows behind for good. Live
       * count when this was written: 2,054 rows, 1,348 of them untouched for
       * over a day, and growing.
       *
       * It is not a correctness problem — a lease stale by more than 30 SECONDS
       * is already ignored by every claim — but it is unbounded growth on a
       * table read on every discovery sweep, and this release adds a second one
       * exactly like it. Leaving a known leak while adding another would be
       * sloppy.
       *
       * Seven days is deliberately absurd next to a 30-second staleness window:
       * nothing this old can possibly be a live lease, so the delete cannot
       * race a running engine. Best-effort — housekeeping must never be the
       * reason a boot fails.
       */
      const leaseCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      for (const leaseTable of ['engine_table_leases', 'engine_tournament_leases']) {
        try {
          const { error: pruneErr } = await supabase
            .from(leaseTable)
            .delete()
            .lt('heartbeat_at', leaseCutoff);
          if (pruneErr) {
            console.warn(`[GameServer] ${leaseTable} prune skipped: ${pruneErr.message}`);
          }
        } catch (pruneThrew) {
          console.warn(`[GameServer] ${leaseTable} prune threw:`, (pruneThrew as Error)?.message);
        }
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
      /**
       * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
       *
       * This sweep used to refund and CANCEL every REGISTERING/ANNOUNCED
       * tournament whose start time was more than an hour past — the boot-time
       * twin of the 30-minute auto-cancel in discoverTournaments(). Both
       * existed to tidy up games that never filled. Neither is acceptable in a
       * poker room: a player who registered and paid a buy-in is owed a game,
       * not a refund and an apology.
       *
       * Past-due tournaments are now left exactly where they are. The discovery
       * loop tops them up with horses and starts them, which is the same
       * outcome a real room reaches by having a dealer sit the game.
       */
      if ((stalePreStart?.length || 0) > 0) {
        console.log(
          `[GameServer] ${stalePreStart!.length} past-due REGISTERING/ANNOUNCED tournament(s) found — leaving them for the fill-and-start path (never cancelled)`
        );
      }

      // 5. Running SNG/Spin tournaments — NEVER cancelled on restart.
      //
      // Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
      //
      // This sweep used to cancel EVERY running SNG/Spin on boot, on the
      // premise that they "can't survive a server restart". That premise was
      // false: discoverTournaments() finds RUNNING tournaments with no engine
      // and calls TournamentManager.resume(), which rebuilds an engine per
      // surviving table, restores the blind level and resumes the level clock
      // mid-level. resume() now also REBUILDS the tables when none survived,
      // so there is no longer any state a restart cannot recover from.
      //
      // Because the engine redeploys on every push touching server/**, this
      // sweep fired constantly and destroyed live games. Dan registered for a
      // 9-max SNG that filled 9/9, started 03:14:13 and was cancelled at
      // 03:14:28 — alive for FIFTEEN SECONDS with its table open and all nine
      // seats occupied. The sweep is gone; the resume path owns this case.
      {
        const { count: runningSngSpins } = await supabase
          .from('tournaments')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'RUNNING');
        if ((runningSngSpins || 0) > 0) {
          console.log(
            `[GameServer] ${runningSngSpins} running tournament(s) preserved across restart — the resume path will rebuild them`
          );
        }
      }

      // Run slow background sweeps asynchronously so they don't block the server boot sequence!
      Promise.resolve().then(async () => {
        try {
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
            const { data: recentHands, error } = await supabase
              .from('hand_history')
              .select('id')
              .eq('tournament_id', t.id)
              .gte('created_at', recentActivityCutoff)
              .limit(1);

            if (error) {
              console.log(
                `[GameServer] Skipping cancel of tournament ${t.id.slice(0, 8)} — error checking activity, assuming active.`
              );
              continue;
            }

            if (recentHands && recentHands.length > 0) {
              console.log(
                `[GameServer] Skipping cancel of tournament ${t.id.slice(0, 8)} — found recent hands in last hour (still active)`
              );
              continue;
            }
            /**
             * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
             *
             * This was the last cancel write on the server. A tournament wedged for
             * over 12 hours with no hands is genuinely stuck, but voiding it is
             * still the wrong ending: the players earned their chip positions. A
             * real room settles the game and pays the places out.
             *
             * So instead of CANCELLED, this now walks it through the normal
             * finish: flip to COMPLETING (CAS-guarded so a live engine that is
             * mid-finish always wins the race) and hand it to
             * recoverStuckCompletingTournaments, which ranks the remaining players
             * by chip count, assigns the top positions, pays the payout structure
             * and flips to COMPLETED. Money reaches the players who earned it and
             * the game shows a real result instead of vanishing.
             */
            const { data: completingClaim } = await supabase
              .from('tournaments')
              .update({ status: 'COMPLETING' })
              .eq('id', t.id)
              .eq('status', 'RUNNING')
              .select('id');

            if (!completingClaim || completingClaim.length === 0) {
              // Someone else moved it on — leave it alone.
              continue;
            }

            await recoverStuckCompletingTournaments('startup-stale-12h-settle', t.id);
            console.log(
              `[GameServer] Settled genuinely stalled tournament ${t.id.slice(0, 8)} "${t.name}" (>12h, no hands) — paid out and COMPLETED, not cancelled`
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
                const batch = orphanIds.slice(i, i + 100);

                /**
                 * RELEASE THE SEATS, not just the table (audit 2026-08-21).
                 *
                 * TournamentManagerEliminations releases seats on the NORMAL
                 * finish, but a tournament can reach COMPLETED/CANCELLED without
                 * ever passing through it - a crashed engine, the stuck-COMPLETING
                 * recovery, or the 12-hour idle sweep. Those paths landed here,
                 * where the table was closed and `table_seats` was left untouched,
                 * so seats kept leaking at a slower rate after the main fix. Two
                 * had already reappeared within hours of it shipping.
                 *
                 * This is the catch-all: whatever route a tournament took to
                 * finished, its players end up released. `left_at IS NULL` is what
                 * the multi-table rebuild reads as "I am still playing here", so a
                 * seat left open at a closed table follows the player around as a
                 * dead tab until something clears it.
                 */
                const { error: seatErr } = await supabase
                  .from('table_seats')
                  .update({ left_at: new Date().toISOString() })
                  .in('table_id', batch)
                  .is('left_at', null);
                if (seatErr) {
                  reportError(
                    new Error(`[GameServer] orphan seat release failed: ${seatErr.message}`),
                    'GameServer.orphan_seat_release_failed'
                  );
                }

                await supabase
                  .from('tables')
                  .update({ status: 'closed', current_players: 0 })
                  .in('id', batch);
              }
              if (orphanIds.length > 0) {
                console.log(
                  `[GameServer] Closed ${orphanIds.length} orphaned tournament tables and released their seats`
                );
              }
            }
          } catch (orphanErr) {
            reportError(orphanErr, 'GameServer.orphan_table_sweep');
          }

          console.log('[GameServer] Stale data cleanup complete');
        } catch (bgErr) {
          reportError(bgErr, 'GameServer.background_stale_cleanup_error');
        }
      });
    } catch (err) {
      reportError(err, 'GameServer.Stale_data_cleanup_error');
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // CASH TABLE DISCOVERY — Every 5 seconds, find tables needing engines
  // ═════════════════════════════════════════════════════════════════════════════

  private async discoverCashTables(): Promise<void> {
    while (this.running) {
      /**
       * C20 FIX-UP (2026-08-24): the sweep verdict must be reached on EVERY
       * exit path, so it is captured here and applied in a finally.
       *
       * Shipped first with the verdict as an ordinary statement near the end
       * of the try. That is only reached when the sweep runs to completion,
       * and the sweep contains heartbeatTables(), claimTable() and the whole
       * adoption loop before it - any of which can throw when the database is
       * struggling, which is exactly when this control loop matters. Meanwhile
       * the discovery-RPC error path still halved the budget. So distress
       * lowered the budget and a throw denied it the clean sweep needed to
       * climb back: the budget ratcheted to the floor and stayed there.
       *
       * Observed in production at 6f994dce with budget pinned at 6 and only
       * 16 tables adopted after 472s, while Engine_start_failed was 0 - the
       * budget was starving adoption on its own, with nothing failing.
       *
       * A finally cannot be skipped by a throw, a continue or a return.
       */
      const failuresSinceLastSweep = this.engineStartFailures;
      this.engineStartFailures = 0;
      let sweepDistressed = failuresSinceLastSweep > 0;
      try {
        // Proof the loop is EXECUTING, independent of what the database says.
        this.lastDiscoveryAttemptAt = Date.now();
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
        //
        // 2026-08-22: `cash_tables_needing_engine` is `cash_tables_with_players`
        // plus "...OR at least one seated human". Below two occupants no engine
        // existed, so the FIRST person to sit at an empty table got WS close
        // 4404 from the engine transport and sat on "connecting" until somebody
        // else arrived — there was nothing to connect TO. The engine is what
        // publishes the idle snapshot (stage 'waiting', seats, stacks), so its
        // mere existence is the difference between a real table and an eternal
        // spinner. A table of horses alone still does not get one.
        //
        // It returns `human_count` so the two ideas below can stay separate:
        // "needs an engine" is NOT "should be dealing". See seatedCounts.
        const { data: ready, error } = await supabase.rpc('cash_tables_needing_engine', {
          p_min: 2,
        });

        // Discovery liveness stamp. If this stops advancing, no engine can be
        // started and no zombie can be reaped — a platform-wide freeze that
        // nothing else would notice. Surfaced as `discoveryStaleMs` on /health.
        if (!error) this.lastDiscoveryOkAt = Date.now();

        if (error) {
          const errMsg =
            error?.message || (typeof error === 'object' ? JSON.stringify(error) : String(error));
          reportError(new Error(errMsg), 'GameServer.Cash_table_discovery_error');
          /**
           * C20: the one cheap indexed read that drives discovery is failing,
           * so adopting a full budget the moment it recovers is the worst
           * possible next move. The finally below applies the retreat - this
           * only records that the sweep was distressed.
           */
          sweepDistressed = true;
          await this.sleep(TABLE_DISCOVERY_INTERVAL);
          continue;
        }

        // ── Reclaim tables refused during a cutover (2026-08-17) ───────
        // A claim refused while the outgoing container still held the
        // lease used to latch for the life of the process: the table
        // starts anyway (enforcement is off) and the loop below skips
        // anything already in `tableEngines`. Retrying here converges
        // ownership within one discovery tick and unlatches conflictCount.
        await retryRefusedClaims();

        // ── Lease renewal (2026-08-16) ──────────────────────────────────
        // Runs before the start loop so a table we have just lost is torn down
        // in the same tick that another instance takes it, rather than dealing
        // one more hand against a table someone else now owns.
        //
        // heartbeatTables() returns [] on any error and [] whenever
        // ENGINE_LEASE_ENFORCE is off, so this loop is inert until the
        // conflict logs say the claim path behaves.
        const lostTables = await heartbeatTables([...this.tableEngines.keys()]);

        for (const id of lostTables) {
          const engine = this.tableEngines.get(id);
          if (!engine) continue;
          reportError(
            new Error(`Lost the deal-lease on table ${id} to another engine instance`),
            'GameServer.table_lease_lost'
          );
          void engine.stop().catch(() => {});
          this.tableEngines.delete(id);
          if (!this.tournamentOwnedTables.has(id)) tableStateHub.dropTable(id);
        }

        /**
         * Tournaments renew on the same cadence, but AFTER the table loop
         * above: leaseEnforcementGuard pins the adjacency of
         * heartbeatTables -> engine.stop() -> tableEngines.delete(), and
         * splitting it would make that invariant unreadable. Handling tables
         * completely and then tournaments is also simply the clearer order.
         *
         * Anything reported lost has been taken over by another instance and
         * must stop here, or two managers run one tournament — the exact thing
         * the lease exists to prevent.
         */
        const lostTournaments = await heartbeatTournaments([...this.tournamentEngines.keys()]);
        for (const id of lostTournaments) {
          const tm = this.tournamentEngines.get(id);
          if (!tm) continue;
          reportError(
            new Error(`Lost the tournament lease on ${id} to another engine instance`),
            'GameServer.tournament_lease_lost'
          );
          try {
            tm.stop();
          } catch {
            /* already stopping */
          }
          this.tournamentEngines.delete(id);
        }

        /**
         * C19 FIX (2026-08-20): stagger the starts.
         *
         * After a restart NO table has an engine, so this loop used to construct
         * and start every one of them inside a single tick: hundreds of engines
         * each immediately loading seats, reading table config and arming timers,
         * against a database simultaneously absorbing the reconnect storm. It
         * also synchronised every table's hand cadence, so from then on they all
         * dealt, settled and wrote snapshots in lockstep — which is what turns
         * one table's all-in equity computation into a stall visible on all of
         * them.
         *
         * A few tens of milliseconds between starts costs nothing (this sweep
         * runs every 5s regardless) and spreads both the connection burst and
         * the steady-state cadence.
         */
        const ENGINE_START_STAGGER_MS = 40;
        let startedThisSweep = 0;
        /**
         * Read and clear BEFORE the loop, not after. The .catch that increments
         * it is asynchronous, so failures from starts issued in this sweep may
         * land after the loop has finished - they belong to the next sweep's
         * verdict, and clearing here is what makes that happen instead of them
         * being double-counted or lost.
         */
        const failuresSinceLastSweep = this.engineStartFailures;
        this.engineStartFailures = 0;
        const budgetThisSweep = this.engineStartBudget;
        for (const row of (ready || []) as Array<{
          table_id: string;
          player_count: number;
          human_count?: number;
        }>) {
          // C20: adoption budget spent. The remaining tables are picked up by
          // the next sweep in TABLE_DISCOVERY_INTERVAL - nothing is dropped, and
          // a table with no engine is by definition one nobody is dealing at.
          if (startedThisSweep >= budgetThisSweep) break;

          // Skip if already running
          if (this.tableEngines.has(row.table_id)) continue;

          // Single-owner check. Returns true on any RPC failure and whenever
          // enforcement is off — a lease problem must never be the reason a
          // table fails to start.
          if (!(await claimTable(row.table_id))) continue;

          if (startedThisSweep > 0) await this.sleep(ENGINE_START_STAGGER_MS);
          startedThisSweep++;

          console.log(
            `[GameServer] Starting engine for cash table ${row.table_id} ` +
              `(${row.player_count} seated, ${row.human_count ?? 0} human)` +
              (row.player_count < 2
                ? ' — lone seat, engine exists so the table is not a spinner'
                : '')
          );
          const engine = new ServerTableEngine(row.table_id);
          engine.setHub(tableStateHub); // Phase 1.1 PR-2: authoritative WS publisher
          this.tableEngines.set(row.table_id, engine);
          engine.start().catch((err) => {
            /**
             * C20: counted for the adoption budget. This delete is what makes
             * the table eligible again on the very next sweep, so without the
             * budget backing off, a database too busy to serve starts got the
             * same volume retried into it every 5 seconds indefinitely.
             */
            this.engineStartFailures++;
            reportError(err, 'GameServer.Engine_start_failed_for_tablei');
            this.tableEngines.delete(row.table_id);
            tableStateHub.dropTable(row.table_id);
          });
        }

        // C20: the verdict is applied in the finally below, so that a throw
        // anywhere above cannot deny the loop its recovery.

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
        /**
         * DELIBERATELY NARROWER THAN THE SPAWN LIST (2026-08-22).
         *
         * This set feeds `shouldBeDealing` below, which is the ZOMBIE test: a
         * table that should be dealing and has made no progress for 180s gets
         * its engine killed. A table with one seated human makes no progress
         * BY DESIGN — you cannot deal to one player — so including it here
         * would kill and rebuild that engine every three minutes, which is the
         * fleet-wide kill loop of PR #281 re-created in a new place.
         *
         * So: two or more occupants is what "should be dealing" means, exactly
         * as before. A lone seat gets an engine and is left alone in it.
         *
         * 2026-08-27: "two or more" was still not the whole truth. The
         * ENGINE'S definition of enough is max(2, auto_start_players) —
         * minPlayersToDeal, which ServerTableEngineDealing's header warns
         * "the watchdog reads too so the two cannot disagree". This reaper
         * was the one reader that disagreed: a table with AutoStart 5 and
         * 2-4 seats makes no progress by design, and a hard-coded >= 2 here
         * called that a zombie and rebuilt its engine every 180s forever.
         * The COUNTS are kept so each engine can be measured against its own
         * threshold below.
         */
        const seatedCounts = new Map<string, number>(
          ((ready || []) as Array<{ table_id: string; player_count: number }>).map((r) => [
            r.table_id,
            Number(r.player_count) || 0,
          ])
        );
        for (const [id, engine] of this.tableEngines) {
          if (!engine.isRunning()) {
            this.tableEngines.delete(id);
            /**
             * 2026-08-22: this branch used to delete the engine and trust that
             * whatever cleared `running` had already torn it down. That is true
             * of every path today — killForRestart and stop() both do full
             * teardown at source — but it is trust, not enforcement, and the
             * cost of it being wrong once is a leaked heartbeat entry and armed
             * deadlines belonging to a table nothing owns any more.
             *
             * `stop()` cannot be that enforcement: its first line is
             * `if (!this.running) return`, so calling it here would be a no-op
             * dressed up as a safety net — worse than nothing, because the next
             * reader would believe it.
             *
             * reconcileTeardown() is the real check. It asks whether this
             * engine still OWNS the table (no successor has taken it) while
             * holding scheduler entries it should have released, cancels them
             * if so, and names them. Silent when the invariant holds, which is
             * every path we know of today.
             */
            const leaked = engine.reconcileTeardown();
            if (leaked) {
              reportError(
                new Error(
                  'Engine for ' + id + ' stopped without tearing down: ' + leaked + ' still armed'
                ),
                'GameServer.engine_teardown_leak'
              );
            }
            // Leave the hub room alone for tournament tables: their
            // TournamentManager rebuilds the engine and the same players stay
            // connected throughout. dropTable() now preserves subscribers
            // anyway, but skipping it avoids a spurious sequence reset.
            if (!this.tournamentOwnedTables.has(id)) tableStateHub.dropTable(id);
            continue;
          }
          // 2026-08-15: the seat counts come from a cash-only RPC (its WHERE
          // clause includes `t.tournament_id IS NULL`). Gating the rebuild
          // on it meant TOURNAMENT tables had no freeze recovery at all: when
          // one died, the `!isRunning()` branch above deleted it and nothing
          // anywhere recreated it, so every seated player was frozen
          // permanently. Tournament tables are rebuilt by their own
          // TournamentManager sweep, so here we only need to stop treating a
          // cash-only list as the definition of "should be dealing".
          //
          // 2026-08-27: a cash table "should be dealing" when it has reached
          // ITS OWN deal threshold — dealThreshold() is minPlayersToDeal, the
          // same number the dealing loop and the turn watchdog use.
          const shouldBeDealing =
            (seatedCounts.get(id) ?? 0) >= engine.dealThreshold() ||
            this.tournamentOwnedTables.has(id);
          /**
           * Dan 2026-08-19: PAUSED IS NOT DEAD — the other half of the break fix.
           *
           * TournamentManagerBase.reviveDeadTableEngines was guarded against
           * breaks, but THIS reaper never was, and it uses the same 180s
           * threshold. A synchronized break parks every tournament table for
           * five minutes, so three minutes in, this loop called a perfectly
           * healthy paused table a zombie, stopped its engine and dropped it —
           * mid-break, while the manager's own sweep was correctly standing
           * down. The table only returned after the break when the manager
           * rebuilt it, discarding engine state for no reason.
           *
           * isPausedByDesign() is the same signal the turn watchdog already
           * trusts (ServerTableEngineTurns) and /health already reports; it was
           * simply never consulted here.
           */
          // ...but paused is not a licence to sit there forever. A pause that
          // outlives any legitimate one (break + last-hand grace, with room to
          // spare) is a wedged table, and MUST still be reaped — otherwise this
          // guard would trade "breaks get dismantled" for "a stuck table never
          // recovers", which is the worse bug.
          const pausedTooLong = engine.msPaused() > GameServer.MAX_HEALTHY_PAUSE_MS;
          const parkedOnPurpose = engine.isPausedByDesign() && !pausedTooLong;
          if (shouldBeDealing && !parkedOnPurpose && engine.msSinceProgress() > 180_000) {
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
        /**
         * A throw mid-sweep is a distress signal in its own right - it is what
         * a timeout inside heartbeatTables() or claimTable() looks like from
         * out here - and it must not be mistaken for a clean sweep.
         */
        sweepDistressed = true;
      } finally {
        /**
         * Exactly one verdict per sweep, on every path: clean, RPC error, or
         * throw. This is the whole reason the flag exists rather than the
         * adjust being called at each site.
         */
        this.adjustEngineStartBudget(sweepDistressed);
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
        const { data: registering, error: registeringErr } = await supabase
          .from('tournaments')
          .select(
            'id, name, start_time, current_players, min_players, max_players, variant, tournament_type, buy_in_amount, buy_in_fee, guaranteed_prize, prize_pool'
          )
          .eq('status', 'REGISTERING');
        if (registeringErr) {
          /* An unreadable board is not an EMPTY board. Discarding this error
             let a failed read fall through as "nothing is registering", so
             every start, every ramp and every top-up on the platform stopped
             for as long as the failure lasted, and the logs said nothing at
             all. Skip the pass loudly and try again in five seconds. */
          reportError(
            new Error(`[GameServer] REGISTERING board read failed: ${registeringErr.message}`),
            'GameServer.registering_board_read_failed'
          );
          await this.sleep(TOURNAMENT_DISCOVERY_INTERVAL);
          continue;
        }

        /**
         * PAID SEATS FOR EVERY SEAT-FIRST GAME, IN TWO QUERIES (2026-08-23).
         *
         * A Spin starts when its seats are BOUGHT, so the start gate below has
         * to know the live seat count. Asking per tournament meant two round
         * trips each, and with ~33 Spins on the board and this loop running
         * every 5 seconds that is ~13 extra queries a second, forever, just to
         * decide that nothing has changed. Batched here instead: one read for
         * the live tables, one for their seats.
         */
        // SEAT-FIRST DEFINITION (2026-08-24 audit): spin, or a 2-seat SNG
        // (heads-up). This must match fn_take_seat_and_buy_in and
        // isSeatFirstFormat exactly. The old \`any sng\` reading made every
        // 3+ seat SNG a structural deadlock: the RPC refused its seat sales
        // (not_a_seat_first_game) while this gate waited for seats forever.
        const seatFirstRows = (registering || []).filter(
          (t) => t.variant === 'spin' || (t.variant === 'sng' && Number(t.max_players) <= 2)
        );
        const paidSeatsByTournament = new Map<string, number>();
        if (seatFirstRows.length > 0) {
          const { data: liveTables, error: liveTablesErr } = await supabase
            .from('tables')
            .select('id, tournament_id, created_at')
            .in(
              'tournament_id',
              seatFirstRows.map((t) => t.id)
            )
            .neq('status', 'closed');
          if (liveTablesErr) {
            // A silent failure here read as paidSeats=0 fleet-wide and no
            // seat-first game could start, with zero telemetry (2026-08-24).
            reportError(
              new Error(`[GameServer] seat-first live-table read failed: ${liveTablesErr.message}`),
              'GameServer.seat_first_table_read_failed'
            );
          }

          /**
           * THE TABLE THE GAME IS ON, WHICH IS NOT ALWAYS THE NEWEST ONE.
           *
           * This used to take the freshest non-closed table, on the reasoning
           * that the recycler leaves the newest open and an older sibling not
           * yet stamped closed is a corpse. That is true of a RECYCLED table
           * and false of a DUPLICATE one, and these games are created with two
           * `waiting` tables about 0.6s apart: the players sit on the FIRST,
           * and the empty one is NEWER.
           *
           * Measured 2026-08-24: of 31 seat-first games past their start time,
           * 28 were blocked this way and in 12 an empty table had outranked a
           * sibling holding every player in the game. Grouped by hour the
           * count of games with a duplicate live table equalled the count of
           * stuck games exactly - 2/2, 2/2, 9/9, 1/1, 1/1. One game had been
           * waiting 486 minutes to deal.
           *
           * Occupancy first, oldest to break the tie. Identical to
           * fn_tournament_primary_table in the database and to the ordering
           * fn_seat_late_registrant already used, so the engine, the counter
           * and the seating path cannot disagree about which table is the
           * game. Seats are read for every live table rather than for one
           * guessed table, which is what makes the choice possible at all.
           */
          const liveTableIds = (liveTables || [])
            .map((row) => String((row as { id?: string }).id ?? ''))
            .filter((id) => id.length > 0);
          if (liveTableIds.length > 0) {
            const { data: seatRows, error: seatRowsErr } = await supabase
              .from('table_seats')
              .select('table_id')
              .in('table_id', liveTableIds)
              .is('left_at', null);
            if (seatRowsErr) {
              reportError(
                new Error(`[GameServer] seat-first seat-count read failed: ${seatRowsErr.message}`),
                'GameServer.seat_first_seat_read_failed'
              );
            }

            const seatsByTable = new Map<string, number>();
            for (const s of seatRows || []) {
              const tbl = String((s as { table_id: string }).table_id);
              seatsByTable.set(tbl, (seatsByTable.get(tbl) ?? 0) + 1);
            }
            /* Most live seats wins; the oldest table breaks a tie so the
               ORIGINAL survives a duplicate and the answer is stable between
               passes. */
            const primaryTable = new Map<
              string,
              { id: string; seats: number; createdAt: number }
            >();
            for (const row of liveTables || []) {
              const tid = String((row as { tournament_id?: string }).tournament_id ?? '');
              if (!tid) continue;
              const id = String((row as { id?: string }).id ?? '');
              if (!id) continue;
              const createdAt = new Date(
                String((row as { created_at?: string }).created_at ?? 0)
              ).getTime();
              const seats = seatsByTable.get(id) ?? 0;
              const seen = primaryTable.get(tid);
              if (
                !seen ||
                seats > seen.seats ||
                (seats === seen.seats && createdAt < seen.createdAt)
              ) {
                primaryTable.set(tid, { id, seats, createdAt });
              }
            }
            for (const [tid, tbl] of primaryTable) {
              paidSeatsByTournament.set(tid, tbl.seats);
            }
          }
        }

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

          /**
           * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
           *
           * This used to cancel any tournament still short of min_players 30
           * minutes after its start time. That single branch was responsible
           * for essentially every cancellation on the platform: over two days,
           * 557 of 562 cancelled tournaments were short by exactly ONE player
           * (363 at 2/3, 138 at 5/6, 56 at 8/9). Horses are seeded at creation
           * leaving a seat for a human, and when no human took it the game was
           * deleted instead of dealt.
           *
           * A real poker room fills the seat. Past its start time and still
           * short, we top the field up with horses and let the normal start
           * logic fire on the next pass — the buy-in stays in play, the prize
           * pool stands, and the player who registered gets the game they paid
           * for. If the horse pool cannot deliver right now we simply try
           * again next pass; waiting is always better than destroying a game.
           */
          /**
           * ── MTT PRE-START HORSE RAMP (Dan 2026-08-23, standard practice) ──
           *
           * "HORSES NEED TO BE REGISTERING FOR MTT TOURNAMENTS UP TO AN HOUR
           *  BEFORE THE TOURNAMENT STARTS. PLAYERS DON'T JUMP IN AND PLAY
           *  TOURNAMENTS THAT HAVE NO PLAYERS IN THEM."
           *
           * This is the ONLY place the rule lives, deliberately. Seeding used
           * to be spread across creation time (recurring service), spawn time
           * (scheduled service) and past-start rescue (below), and an event
           * that missed all three - which a day-ahead scheduled MTT always did
           * - simply sat at 0 until its clock ran out. Putting the ramp in the
           * discovery loop means every REGISTERING tournament gets it, however
           * it was created, without each creator having to remember.
           *
           * The target curve and its safety properties are documented on
           * mttPrestartHorseTarget. The two that matter here: it never exceeds
           * max_players - 1, so it cannot trip the `maxReached` gate below and
           * start an event early; and it returns 0 for seat-first games, whose
           * rule is bought seats, not registrations.
           */
          const msUntilStart = startTime - now;
          if (msUntilStart > 0 && msUntilStart <= MTT_PRESTART_RAMP_MS) {
            const lastRamp = this.lastMttRampAt.get(tournament.id) ?? 0;
            if (now - lastRamp >= 45_000) {
              // The whole decision - window, curve, seat-first exclusion, pool
              // cap and per-tick step - is inside this pure function, so the
              // rule is tested without a database and this call site cannot
              // drift from it.
              const rampTarget = mttPrestartHorseTarget({
                msUntilStart,
                maxPlayers: tournament.max_players ?? 0,
                variant: String(tournament.variant ?? ''),
                currentPlayers: tournament.current_players ?? 0,
                /* A GUARANTEED event ramps to whatever covers it, not to the
                   default 24. These three columns were already being selected
                   here and simply not used. buy_in_amount is the PRIZE side:
                   the fee is rake and never reaches the pool. */
                guaranteedPrize: Number(tournament.guaranteed_prize) || 0,
                prizePool: Number((tournament as { prize_pool?: unknown }).prize_pool) || 0,
                buyInPrizeShare: Number(tournament.buy_in_amount) || 0,
              });
              if (rampTarget > 0) {
                this.lastMttRampAt.set(tournament.id, now);
                const rampAdded = await this.tournamentRecurring.topUpWithHorses(
                  tournament.id,
                  rampTarget
                );
                if (rampAdded > 0) {
                  console.log(
                    `[GameServer] Pre-start ramp: +${rampAdded} into "${tournament.name}" ` +
                      `(${tournament.current_players} -> target ${rampTarget}, ` +
                      `${Math.round(msUntilStart / 60000)}m to start)`
                  );
                }
              }
            }
          }

          const isPastStart = startTime <= now;
          if (isPastStart && tournament.current_players < minPlayers) {
            /**
             * Dan 2026-08-19: fill to a FULL FIELD, every format.
             *
             * "ALLOW HORSES TO FILL ALL SEATS FOR SIT N GO'S AND MTT AND SPINS"
             *
             * SNG/Spin only ever start when full, so max_players was always the
             * right target for them. MTTs used to be topped up to min_players
             * only — enough to start, but a 50-seat event running 6-handed.
             * They now aim for a full field too. topUpWithHorses can only seat
             * horses that are genuinely free (not in another tournament, not
             * sitting at an open table), so asking for max_players fills the
             * event as far as the pool allows and never starves cash games.
             */
            const target = tournament.max_players > 0 ? tournament.max_players : minPlayers;

            const added = await this.tournamentRecurring.topUpWithHorses(tournament.id, target);
            if (added > 0) {
              console.log(
                `[GameServer] Filled "${tournament.name}" with ${added} player(s) toward ${target} seats — running it instead of cancelling`
              );
            }
            // Re-evaluate on the next discovery pass with the refreshed count.
            continue;
          }

          // SNG / Spin: start ONLY when every seat is bought (not time-based)
          // MTT / Bounty / PKO / Mystery: start at scheduled time if min_players met
          // Seat-first = spin or heads-up (2-seat SNG). Must agree with
          // fn_take_seat_and_buy_in / isSeatFirstFormat — see 2026-08-24 audit.
          const isSngOrSpin =
            tournament.variant === 'spin' ||
            (tournament.variant === 'sng' && Number(tournament.max_players) <= 2);

          /**
           * PAID SEATS, NOT REGISTRATIONS (Dan 2026-08-23, verbatim: "spins can
           * never ever start until 3 players have sat down, and paid for there
           * seat, only then does the spin feature start.")
           *
           * `current_players` is the registration counter. It is incremented by
           * fn_register_for_tournament and never decremented when somebody
           * leaves or busts, so it drifts badly: the live lobby was carrying
           * spins reading 3/3 with two seats actually sold, and others reading
           * 0/3 with three sold. Starting a spin off that number deals a game
           * to seats nobody bought.
           *
           * A seat-first game's truth is the seat rows on its live table.
           * Count those. Registrations do not open the door — money in a seat
           * does.
           */
          const paidSeats = paidSeatsByTournament.get(tournament.id) ?? 0;
          const seatFirstReady =
            isSngOrSpin && tournament.max_players > 0 && paidSeats >= tournament.max_players;

          const maxReached =
            tournament.max_players > 0 && tournament.current_players >= tournament.max_players;
          const timeReached = startTime <= now && tournament.current_players >= minPlayers;

          // SNG/Spin: only start when every seat has been bought and paid for.
          // MTT variants: start at scheduled time with minimum players.
          const shouldStart = isSngOrSpin ? seatFirstReady : maxReached || timeReached;

          if (shouldStart) {
            /* Report the number the decision was actually made on. A Spin is
               gated on SEATS, and current_players can disagree with those —
               logging it here is how a drifted counter reads as a healthy
               start in the logs. */
            const reason = isSngOrSpin
              ? `seats sold (${paidSeats}/${tournament.max_players})`
              : maxReached
                ? `full (${tournament.current_players}/${tournament.max_players})`
                : `${tournament.current_players} players`;
            console.log(`[GameServer] Starting tournament: ${tournament.name} (${reason})`);
            const tm = new TournamentManager(tournament.id, this);
            this.tournamentEngines.set(tournament.id, tm);
            tm.start()
              // A tournament reaching its start time between :55 and the hour
              // is not in the break snapshot, so nothing else will pause it.
              .then(() => this.holdIfBreakIsRunning(tm))
              .catch((err) => {
                reportError(err, 'GameServer.Tournament_start_failed_for_to');
                this.tournamentEngines.delete(tournament.id);
              });
          }
        }

        /**
         * ── FULLY PAID BUT NEVER STARTED (2026-08-24 audit, P2-7) ──
         *
         * Every other watchdog on the platform proves a game is broken by
         * finding evidence it PLAYED: the played-but-REGISTERING sweep below
         * needs an eliminated/winner/finished row, the decided-but-RUNNING
         * sweep needs an elimination. A game that never dealt a card cannot
         * produce either, so a heads-up that sold both its seats and then sat
         * there was invisible to all of them — measured at 85 minutes on
         * 2026-08-24, with the money already taken.
         *
         * The evidence THIS one runs on is the only evidence such a game has:
         * every seat it sells is sold, and it is still REGISTERING. The
         * failure it catches is specifically a tournamentEngines slot held by
         * a manager that is no longer running — the top of this loop skips
         * every id in that map, so such a game is never looked at again by
         * anything.
         */
        {
          const stallNow = Date.now();
          const stillSeatFirst = new Set(seatFirstRows.map((t) => String(t.id)));
          for (const id of this.seatFirstFullSince.keys()) {
            if (!stillSeatFirst.has(id)) this.seatFirstFullSince.delete(id);
          }

          for (const t of seatFirstRows) {
            const id = String(t.id);
            const seats = Number(t.max_players) || 0;
            const paid = paidSeatsByTournament.get(id) ?? 0;

            if (seats <= 0 || paid < seats) {
              // Still filling, or a seat opened up again. Not a stall.
              this.seatFirstFullSince.delete(id);
              continue;
            }
            const fullSince = this.seatFirstFullSince.get(id) ?? null;
            if (fullSince === null) {
              // First pass that saw it full — start the clock, judge nothing.
              this.seatFirstFullSince.set(id, stallNow);
              continue;
            }
            if (
              !seatFirstStartStalled({
                paidSeats: paid,
                maxPlayers: seats,
                fullSinceMs: fullSince,
                now: stallNow,
                stallMs: SEAT_FIRST_START_STALL_MS,
              })
            ) {
              continue;
            }

            const held = this.tournamentEngines.get(id);
            if (held && !held.isRunning()) {
              // A finished or dead manager still owning the map slot IS the
              // bug: the start gate at the top of this loop skips it forever.
              this.tournamentEngines.delete(id);
            }
            if (this.tournamentEngines.has(id)) continue;

            reportError(
              new Error(
                `[GameServer] ${t.name} (${id.slice(0, 8)}) fully paid ${paid}/${seats} and ` +
                  `still REGISTERING after ${Math.round((stallNow - fullSince) / 60000)}m — force-starting`
              ),
              'GameServer.seat_first_fully_paid_never_started'
            );

            const stalledTm = new TournamentManager(id, this);
            this.tournamentEngines.set(id, stalledTm);
            stalledTm
              .start()
              .then(() => this.holdIfBreakIsRunning(stalledTm))
              .catch((err) => {
                reportError(err, 'GameServer.seat_first_stall_start_failed');
                this.tournamentEngines.delete(id);
              });
            // Re-arm the clock rather than clearing it: if this start does not
            // take either, the next attempt is one stall window away and not
            // one five-second pass away.
            this.seatFirstFullSince.set(id, stallNow);
          }
        }

        // Find RUNNING tournaments that need resuming
        const { data: running, error: runningErr } = await supabase
          .from('tournaments')
          .select('id, name')
          .eq('status', 'RUNNING');
        if (runningErr) {
          // Same rule as the REGISTERING read: unreadable is UNKNOWN. Reading
          // it as "nothing is running" silently stops every re-adoption.
          reportError(
            new Error(`[GameServer] RUNNING board read failed: ${runningErr.message}`),
            'GameServer.running_board_read_failed'
          );
        }

        for (const tournament of running || []) {
          if (this.tournamentEngines.has(tournament.id)) continue;

          /**
           * ONE TOURNAMENT, ONE MANAGER (2026-08-23).
           *
           * The `has()` check above is per-process, so it means nothing across
           * containers. Without this claim a second engine instance would
           * resume the SAME tournament: two managers advancing blind levels,
           * calling breaks, running hand-for-hand and processing eliminations
           * for one event. Cash tables have been leased for exactly this reason
           * and tournaments were the gap that kept the engine a single point of
           * failure.
           *
           * Fail-open like claimTable: true on any error, and true whenever
           * enforcement is off. A lease problem must never stop a tournament.
           */
          if (!(await claimTournament(tournament.id))) continue;

          console.log(`[GameServer] Resuming tournament: ${tournament.name}`);
          const tm = new TournamentManager(tournament.id, this);
          this.tournamentEngines.set(tournament.id, tm);
          tm.resume().catch((err) => {
            reportError(err, 'GameServer.Tournament_resume_failed_for_t');
            this.tournamentEngines.delete(tournament.id);
          });
        }

        // The ramp map only ever holds tournaments still in REGISTERING.
        // Without this it grows by every event the engine has ever seen and
        // is never freed for the life of the process.
        if (this.lastMttRampAt.size > 0) {
          const stillRegistering = new Set((registering || []).map((r) => String(r.id)));
          for (const id of this.lastMttRampAt.keys()) {
            if (!stillRegistering.has(id)) this.lastMttRampAt.delete(id);
          }
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

        // ── TOURNAMENT RAKE SWEEP (2026-08-26) ──
        // The last line of the settlement-integrity fix: any terminal
        // tournament whose fee ledger has no tournament_rake_settlements row
        // (engine died before settling, wallet credit failed three times,
        // event completed by a path that predates the settler) is settled by
        // fn_sweep_unsettled_tournament_rake. Idempotent by PK claim, so it
        // can never double-pay a tournament something else settled. Every 10
        // minutes — this is a safety net, not the primary path.
        if (Date.now() - this.lastRakeSweepAt > 10 * 60 * 1000) {
          this.lastRakeSweepAt = Date.now();
          try {
            const { data: sweep, error: sweepErr } = await supabase.rpc(
              'fn_sweep_unsettled_tournament_rake',
              { p_since_days: 60, p_limit: 200 }
            );
            if (sweepErr) {
              reportError(
                new Error(`[GameServer] tournament rake sweep failed: ${sweepErr.message}`),
                'GameServer.rake_sweep_failed'
              );
            } else if (Number(sweep?.settled) > 0 || Number(sweep?.failed) > 0) {
              console.log(
                `[GameServer] Tournament rake sweep: settled ${sweep.settled} event(s), ${sweep.chips} chips (scanned ${sweep.scanned}, failed ${sweep.failed})`
              );
            }
          } catch (sweepEx) {
            reportError(sweepEx, 'GameServer.rake_sweep_threw');
          }
        }

        // ── HEADS-UP SHORTFALL BACK-PAY + CONSERVATION SENTINEL (2026-08-27) ──
        // Back-pay: every completed Heads-Up whose winner was paid one prize
        // share instead of two (the createSNG pool overwrite, ~230,561 chips
        // over 30 days) is repaid, evidence-based and idempotent
        // (fn_credit_and_log key per tournament+winner). Self-draining: paid
        // events fall out of the scan, and the cutoff date means the backlog
        // can only shrink.
        //
        // ITS OWN TIMER (2026-08-27, phase 3d). This used to run inside a
        // 60-second window that opened only when the RAKE sweep had just
        // fired -- a piggyback on another job's clock. In production that
        // meant it ran once on engine boot and then effectively never again:
        // 100 winners repaid at 15:32 after a deploy, then nothing, with
        // 8,600 events and ~211,000 chips still owed. Money owed to players
        // must not depend on when a different sweep happens to tick, so this
        // now keeps its own interval like every other periodic job here.
        // 250 per pass drains the remaining backlog in about three hours
        // instead of fourteen; the RPC is ~270ms and fully idempotent.
        if (Date.now() - this.lastHuBackpayAt > 5 * 60 * 1000) {
          this.lastHuBackpayAt = Date.now();
          try {
            const { data: bp, error: bpErr } = await supabase.rpc(
              'fn_backpay_hu_winner_shortfalls',
              { p_limit: 250 }
            );
            if (bpErr) {
              reportError(
                new Error(`[GameServer] HU shortfall back-pay failed: ${bpErr.message}`),
                'GameServer.hu_backpay_failed'
              );
            } else if (Number(bp?.paid) > 0) {
              console.log(
                `[GameServer] HU shortfall back-pay: ${bp.paid} winner(s), ${bp.chips} chips (scanned ${bp.scanned})`
              );
            }
          } catch (bpEx) {
            reportError(bpEx, 'GameServer.hu_backpay_threw');
          }
        }

        // Conservation: per-event money in vs money out (prizes + bounties +
        // refunds + booked rake + funded overlay). Every 6 hours; anything
        // beyond tolerance files a deduped financial_alert. This is the
        // invariant that would have caught both the minted overlays and the
        // HU shortfalls on day one.
        if (Date.now() - this.lastConservationAt > 6 * 60 * 60 * 1000) {
          this.lastConservationAt = Date.now();
          try {
            const { data: cons, error: consErr } = await supabase.rpc(
              'fn_tournament_money_conservation',
              { p_since_days: 7, p_tolerance: 1.0, p_limit: 500 }
            );
            if (consErr) {
              reportError(
                new Error(`[GameServer] conservation sweep failed: ${consErr.message}`),
                'GameServer.conservation_sweep_failed'
              );
            } else if (Number(cons?.flagged) > 0) {
              console.log(
                `[GameServer] Conservation sweep: ${cons.flagged} event(s) flagged (retained ${cons.retained_chips}, unfunded ${cons.unfunded_chips})`
              );
            }
          } catch (consEx) {
            reportError(consEx, 'GameServer.conservation_sweep_threw');
          }
        }

        // ── PLAYED-BUT-STILL-REGISTERING RECOVERY (2026-08-23) ──
        //
        // The mirror of the stalled-RUNNING sweep below, for the failure at
        // the OTHER end of the lifecycle: start() dealt the game but its
        // REGISTERING -> RUNNING flip never landed (see the retry there). The
        // row still says REGISTERING while its players hold positions and
        // elimination stamps, so every other watchdog looks straight past it
        // — COMPLETING sweeps read COMPLETING, the decided sweep reads
        // RUNNING. Found live: 11 tournaments, 22-33 hours old, 570 chips
        // debited against 48 paid out.
        //
        // The evidence a game actually dealt is an eliminated/winner/finished
        // player row; registration alone never produces one. Given that, the
        // row is relabelled to what it truly is: still contested -> RUNNING
        // (the resume path above adopts it on the next pass); already decided
        // -> COMPLETING, then through the SAME recovery that pays stuck
        // finishers.
        const { data: playedButRegistering } = await supabase
          .from('tournaments')
          .select('id, name, status')
          .in('status', ['REGISTERING', 'ANNOUNCED'])
          .lt('start_time', new Date(Date.now() - 10 * 60 * 1000).toISOString());
        for (const t of playedButRegistering || []) {
          const { count: playedCount, error: playedErr } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .in('status', ['eliminated', 'winner', 'finished']);
          // Unreadable is UNKNOWN, never "it never dealt" — fail closed.
          if (playedErr || !playedCount) continue;

          const { count: stillPlaying, error: stillErr } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .eq('status', 'playing');
          if (stillErr || stillPlaying === null || stillPlaying === undefined) continue;

          console.warn(
            `[GameServer] ${t.name} (${t.id.slice(0, 8)}) dealt but never left ${t.status} — ${playedCount} finished, ${stillPlaying} playing; relabelling`
          );

          if (stillPlaying > 1) {
            // A live contest wearing the wrong label. Hand it to the resume
            // path rather than settling a game that is still being played.
            await supabase
              .from('tournaments')
              .update({ status: 'RUNNING', started_at: new Date().toISOString() })
              .eq('id', t.id)
              .in('status', ['REGISTERING', 'ANNOUNCED']);
            continue;
          }

          const staleTm = this.tournamentEngines.get(t.id);
          if (staleTm) {
            try {
              staleTm.stop();
            } catch (err) {
              reportError(err, 'GameServer.played_registering_stop_engine');
            }
            this.tournamentEngines.delete(t.id);
          }
          // CAS so a concurrent legitimate transition is never clobbered.
          await supabase
            .from('tournaments')
            .update({ status: 'COMPLETING' })
            .eq('id', t.id)
            .in('status', ['REGISTERING', 'ANNOUNCED']);
          await recoverStuckCompletingTournaments('played-but-registering', t.id);
        }

        // ── STALLED DECIDED-BUT-RUNNING RECOVERY (2026-08-21) ──
        // A tournament whose LAST elimination was processed but whose finish
        // check never ran (engine restart in the gap) stays RUNNING forever:
        // the survivor sits in status='playing' with no position, no prize,
        // and an open table where no hand can ever be dealt again. Observed
        // live twice in the 23:00-00:25Z deploy-churn window (two Turbo SNGs,
        // ~2h stalled). Re-adoption does NOT self-heal: the finish check only
        // runs inside elimination processing, and with one player there are
        // no hands, no eliminations, no check. Detect the decided state here,
        // stop any idle engine, and route through the SAME recovery path that
        // rescues stuck-COMPLETING tournaments (ranks survivors, pays via
        // computePlacePrize, closes every player row).
        const decidedCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const { data: maybeDecided } = await supabase
          .from('tournaments')
          .select('id, name')
          .eq('status', 'RUNNING')
          .lt('started_at', decidedCutoff);
        for (const t of maybeDecided || []) {
          const { count: playingCount, error: playingErr } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .eq('status', 'playing');
          // PAYOUT-INTEGRITY: a count we could not read is UNKNOWN, not zero.
          if (playingErr || playingCount === null || playingCount === undefined) continue;
          if (playingCount > 1) continue; // still a live contest
          console.warn(
            `[GameServer] RUNNING tournament ${t.name} (${t.id.slice(0, 8)}) is decided (${playingCount} playing) — recovering the winner`
          );
          const idleTm = this.tournamentEngines.get(t.id);
          if (idleTm) {
            try {
              idleTm.stop();
            } catch (err) {
              reportError(err, 'GameServer.stalled_decided_stop_engine');
            }
            this.tournamentEngines.delete(t.id);
          }
          // Conditional flip so a concurrent legitimate finish is never clobbered;
          // recovery itself only acts on COMPLETING rows and dedupes payouts.
          await supabase
            .from('tournaments')
            .update({ status: 'COMPLETING' })
            .eq('id', t.id)
            .eq('status', 'RUNNING');
          await recoverStuckCompletingTournaments('stalled-running-decided', t.id);
        }

        // ── STARTED-BUT-NEVER-DEALT RECOVERY (2026-08-24) ──
        //
        // Measured live during the 03:31-05:1x UTC deploy-churn window: 92
        // RUNNING seat-first games, every seat funded, 2+ players seated,
        // tables at 'waiting' - and not one hand ever dealt. 91 of 92 held no
        // engine lease, and the population did not drain while the engine was
        // healthy and dealing everything else: whatever incarnation started
        // them died before the first deal, and no later incarnation picked
        // them up (or a resumed manager wedged before dealing, which the
        // cleanup above cannot see because isRunning() is still true).
        //
        // No existing sweep covers this state. The played-but-registering
        // sweep demands finished player rows - a never-dealt game has none.
        // The decided-but-running sweep demands playingCount <= 1 - a
        // never-dealt game has a full field. So the paid players sit at a
        // dead felt forever, buy-ins committed.
        //
        // Recovery: hand the game back to the start gate. Stop any idle
        // manager holding the map entry, flip RUNNING -> REGISTERING (CAS),
        // and the discovery pass above re-adopts it - registrations and seats
        // are intact, a drawn spin multiplier is kept, settlement is
        // idempotent, createTablesAndSeatPlayers adopts the existing table.
        //
        // Budgeted to 15 candidates a pass so a pathological backlog cannot
        // turn this sweep into its own outage; in steady state it is empty.
        /**
         * EVERY VARIANT, NOT THE TWO THE FIRST INCIDENT HAPPENED TO CONTAIN
         * (2026-08-25).
         *
         * This sweep shipped filtered to `['sng', 'spin']` because the outage
         * that prompted it was 92 seat-first games. "Started and never dealt"
         * is a property of a tournament, not of its variant, and MTTs were
         * left covered by no sweep at all - the comment above says so in its
         * own words and the filter then contradicted it.
         *
         * Found live: `Monday Grind PLO6 Turbo` (18 paid players, 2 tables,
         * 183 minutes, zero hands) and `Six-Card Late Night` (499 players,
         * 56 tables, 548 live seats, zero hands). Both sat at a dead felt
         * with buy-ins committed and nothing in the engine looking for them.
         *
         * The 15-minute cutoff holds for MTTs, measured rather than assumed:
         * of 187 non-seat-first tournaments started in 48h, 127 dealt their
         * first hand in under 5 minutes - INCLUDING a full 500-player field -
         * and 153 of 187 within 15. The slow tail is not big fields waiting
         * to seat (its average field is 31 against 42 for the sub-5m group);
         * it is this same stall, recovering by luck on a later re-adoption.
         */
        const neverDealtCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const { data: maybeNeverDealt } = await supabase
          .from('tournaments')
          .select('id, name, started_at')
          .eq('status', 'RUNNING')
          .lt('started_at', neverDealtCutoff);
        for (const t of (maybeNeverDealt || []).slice(0, 15)) {
          const { data: tRows, error: tErr } = await supabase
            .from('tables')
            .select('id, status')
            .eq('tournament_id', t.id);
          if (tErr) continue; // unreadable is UNKNOWN, never "it never dealt"
          const tableIds = (tRows || []).map((r) => String((r as { id: string }).id));
          if (tableIds.length === 0) continue; // no table at all - creation path owns it

          const { count: dealt, error: dealtErr } = await supabase
            .from('hand_history')
            .select('id', { count: 'exact', head: true })
            .in('table_id', tableIds);
          if (dealtErr || dealt === null || dealt === undefined) continue;
          if (dealt > 0) continue; // it played; the sweeps above own it

          // Only a game that can actually deal goes back in the queue: 2+
          // live seats on a non-closed table.
          const openTableIds = (tRows || [])
            .filter((r) => String((r as { status?: string }).status) !== 'closed')
            .map((r) => String((r as { id: string }).id));
          if (openTableIds.length === 0) continue;
          const { count: liveSeats, error: seatErr } = await supabase
            .from('table_seats')
            .select('id', { count: 'exact', head: true })
            .in('table_id', openTableIds)
            .is('left_at', null);
          if (seatErr || !liveSeats || liveSeats < 2) continue;

          /**
           * SEATING HAS TO BE FINISHED BEFORE "NEVER DEALT" MEANS "DEAD".
           *
           * A seat-first game seats everyone in one call, so it is settled the
           * moment it has two seats. A large MTT does not: it adopts tables and
           * fills them over several passes, and a game still mid-seating has
           * dealt nothing for a legitimate reason. Requeueing that one is
           * harmless but pointless churn, and at 56 tables it is not cheap.
           *
           * Every player still `playing` must hold a live seat. Only then is
           * there nothing left to wait for and no hand is an answer rather
           * than a delay. An unreadable count is UNKNOWN, never "settled" -
           * same rule the sweeps above hold themselves to.
           */
          const { count: stillPlaying, error: playingCountErr } = await supabase
            .from('tournament_players')
            .select('id', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .eq('status', 'playing');
          if (playingCountErr || stillPlaying === null || stillPlaying === undefined) continue;
          if (liveSeats < stillPlaying) continue;

          console.warn(
            `[GameServer] RUNNING ${t.name} (${t.id.slice(0, 8)}) has dealt nothing since ${t.started_at} - requeueing for a fresh start`
          );
          const idleNeverDealtTm = this.tournamentEngines.get(t.id);
          if (idleNeverDealtTm) {
            try {
              idleNeverDealtTm.stop();
            } catch (err) {
              reportError(err, 'GameServer.never_dealt_stop_engine');
            }
            this.tournamentEngines.delete(t.id);
          }
          // CAS so a game that just dealt or finished is never clobbered.
          await supabase
            .from('tournaments')
            .update({ status: 'REGISTERING' })
            .eq('id', t.id)
            .eq('status', 'RUNNING');
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
    // 2026-08-15: overwriting the map slot without stopping the previous engine
    // left TWO live engines dealing the same table against the same DB rows —
    // reachable when a TournamentManager is re-resumed after being dropped from
    // tournamentEngines while its table engines were never stopped.
    const prev = this.tableEngines.get(tableId);
    if (prev && prev !== engine) {
      void prev.stop().catch(() => {});
    }
    this.tournamentOwnedTables.add(tableId);
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
