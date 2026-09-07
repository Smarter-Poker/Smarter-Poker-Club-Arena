/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SMARTER POKER GAME SERVER — 24/7 Server-Side Game Engine (bootstrap only)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is the production game server entry point. It does five things:
 *   1. Instantiate `GameServer` (orchestrates all tables + tournaments)
 *   2. Attach the native WebSocket server at `/ws/table/:tableId`
 *   3. Attach the channel WebSocket server at `/ws/channel`
 *   4. Mount the HTTP router and `listen()` on PORT
 *   5. Register SIGINT/SIGTERM shutdown + uncaught-error handlers
 *
 * Phase U3 (2026-04-23): all routing logic lives in `./router.ts` + `./handlers/*`;
 * shared HTTP helpers in `./http/*`; game orchestration in `./GameServer.ts`.
 * This file is pure wiring — no business logic, no route handling.
 *
 * Phase U4 (2026-05-18): ChannelWebSocketServer added at /ws/channel to replace
 * Supabase Realtime for club presence, tournament events, lobby updates, and
 * hand replay streaming (Realtime migration).
 *
 * Deploy to: Hetzner VPS (primary), or any Node.js host.
 */

import { createServer } from 'http';
import { reportError } from './services/errorReporter.js';
import { handHistoryQueueDepth } from './services/supabase.js';
import { tableStateHub } from './transport/TableStateHub.js';
import { EngineWebSocketServer } from './transport/EngineWebSocketServer.js';
import { ChannelWebSocketServer } from './transport/ChannelWebSocketServer.js';
import { channelHub } from './hub/ChannelHub.js';
import { GameServer } from './GameServer.js';
import { createRouter } from './router.js';
import { hydrateHorseMind } from './services/HorseMindHydrator.js';
import {
  hydrateHorseMindFromDb,
  startHorseMindPersistence,
  stopHorseMindPersistence,
} from './services/HorseMindPersistence.js';
import { startHorseSelfTuner, stopHorseSelfTuner } from './services/HorseSelfTuner.js';
import { sweepIncompleteHorses } from './services/HorseOnboarding.js';
import { startHorseLeague, stopHorseLeague } from './benchmark/HorseLeague.js';
import { startHorseDailyAudit, stopHorseDailyAudit } from './services/HorseDailyAudit.js';
import {
  startBrainTelemetryFlush,
  stopBrainTelemetryFlush,
} from './services/BrainTelemetryFlush.js';
import {
  startHorseDataLedgerSync,
  stopHorseDataLedgerSync,
} from './services/HorseDataLedgerSync.js';
import { startHorseLaneLoader, stopHorseLaneLoader } from './services/HorseLaneLoader.js';
import { startGtoChartLoader, stopGtoChartLoader } from './services/GtoChartLoader.js';
import {
  startSolverPolicyArtifactLoader,
  stopSolverPolicyArtifactLoader,
} from './gto/SolverPolicyArtifactLoader.js';
import { startGtoPostflopLoader, stopGtoPostflopLoader } from './services/GtoPostflopLoader.js';
import {
  startGtoPostflopV31Loader,
  stopGtoPostflopV31Loader,
} from './services/GtoPostflopV31Loader.js';
import {
  startGtoAggregationDriver,
  stopGtoAggregationDriver,
} from './services/GtoAggregationDriver.js';
import {
  startGtoAggregationDriverV31,
  stopGtoAggregationDriverV31,
} from './services/GtoAggregationDriverV31.js';
import {
  startHorseOverlayGuard,
  type HorseOverlayGuardHandle,
} from './services/HorseOverlayGuard.js';
import { HorseSessionRotator } from './services/HorseSessionRotator.js';
import { StableHandExecutor } from './services/StableHandExecutor.js';
import { registerLeadershipShutdownHandler } from './services/leadership.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '8080', 10);

// ═══════════════════════════════════════════════════════════════════════════════
// MEMBER FEE ROLLUP - RETIRED (2026-09-04)
// ═══════════════════════════════════════════════════════════════════════════════
// From 2026-08-23 this process folded every hand into public.member_fee_rollup
// on a 30 s tick (2 s while backfilling) for the club roster's Fees column,
// Member Management and Player Statistics. Those three surfaces were rebuilt
// on 2026-08-30 / 2026-09-01 to read ca_hand_facts directly, and by 2026-09-04
// the only functions on the database that mentioned the rollup were its own
// refresh and backfill (checked against pg_proc). The loop was therefore
// spending ~5.7 ms of database time per hand - ~21 minutes a day at 220k
// hands - to keep 80,705 rows current that nothing opened. The table and its
// three functions come down in the phase 6 DDL batch, after this engine
// build has deployed, so the old build never calls a function that is gone.
// MEMBER_FEE_ROLLUP_ENABLED no longer does anything.

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

const gameServer = new GameServer();

// Phase 1.1 PR-2: Attach native WebSocket server at /ws/table/:tableId.
// Constructed BEFORE the HTTP server so the router closure can capture it.
const engineWs = new EngineWebSocketServer({
  hub: tableStateHub,
  tableExists: (tableId) => gameServer.getTableEngine(tableId) !== undefined,
  ensureTable: (tableId) => gameServer.ensureCashTableEngine(tableId),
  // FIX 2 (2026-07-24): on (re)connect / RESYNC, re-push the player's hole
  // cards for the current hand (public state alone leaves reconnecting players
  // blind and auto-folded).
  onResync: (tableId, userId) => {
    const engine = gameServer.getTableEngine(tableId);
    void engine?.rePushHoleCards(userId);
    // 2026-09-04 (disconnect audit item 11): and the engine's copy of this
    // player's pre-action, so a reconnected bar shows what is actually armed.
    engine?.rePushPreAction(userId);
  },
  // CONNECTIVITY UPGRADE (2026-08-22): wire transport presence straight into
  // the engine's DisconnectEngine. The transport knows a player dropped within
  // milliseconds; before this the engine waited up to 30s for the HTTP
  // heartbeat to go stale, burning a full action clock on a player who was
  // already gone (and giving reconnects a laggy, frozen-feeling re-entry).
  onConnect: (tableId, userId) => {
    gameServer.getTableEngine(tableId)?.heartbeat(userId);
  },
  onDisconnect: (tableId, userId) => {
    gameServer.getTableEngine(tableId)?.notifyTransportDisconnect(userId);
  },
});

// Phase U4: Channel WebSocket server at /ws/channel (Realtime migration).
const channelWs = new ChannelWebSocketServer();

const httpServer = createServer(createRouter({ gameServer, tableStateHub, engineWs, channelHub }));
engineWs.attach(httpServer);
channelWs.attach(httpServer);

let shuttingDown = false;
let leaderServicesActive = false;
let leaderLifecycleGeneration = 0;
let leaderStartOperation: Promise<void> | null = null;
let leaderStopOperation: Promise<void> | null = null;
const leaderBootMutations = new Set<Promise<void>>();
let horseOverlayGuard: HorseOverlayGuardHandle | null = null;
let horseSessionRotator: HorseSessionRotator | null = null;
let stableHandExecutor: StableHandExecutor | null = null;

const leaderLifecycleIsCurrent = (generation: number): boolean =>
  leaderServicesActive && leaderLifecycleGeneration === generation && gameServer.isLeaderBooted();

function trackLeaderBootMutation(operation: Promise<unknown>, context: string): void {
  let tracked!: Promise<void>;
  tracked = operation
    .then(() => undefined)
    .catch((err) => reportError(err, context))
    .finally(() => leaderBootMutations.delete(tracked));
  leaderBootMutations.add(tracked);
}

async function drainLeaderBootMutations(): Promise<void> {
  while (leaderBootMutations.size > 0) {
    await Promise.allSettled([...leaderBootMutations]);
  }
}

/**
 * These services change shared horse, tournament, or table state and therefore
 * belong to the process that completed the distributed leader boot. A standby
 * never starts them merely because its HTTP socket happened to listen first.
 */
async function startLeaderOwnedServices(): Promise<void> {
  await gameServer.start();
  if (shuttingDown || !gameServer.isLeaderBooted()) {
    console.log('[GameServer] Index-owned mutators remain stopped on this standby process.');
    return;
  }

  leaderServicesActive = true;
  leaderLifecycleGeneration += 1;
  leaderStopOperation = null;
  const generation = leaderLifecycleGeneration;

  // AUDIT V6 (2026-07-24) + V12 (2026-08-22): restore the horses' learned
  // opponent memory. V12 hydrates the persisted stats table first (unlimited
  // horizon), then replays only the un-flushed hand_history tail; if the
  // table is empty or unreadable it falls back to the full-window replay.
  // Fire-and-forget — never blocks boot, never throws (fail-safe inside).
  // V12.3: start the flush loop FIRST. It used to sit behind both hydration
  // awaits, so if either Supabase call hung (both are unbounded reads, and both
  // swallow their errors) the loop never started and the process accumulated
  // learning it never persisted — silently, because nothing reports it. The
  // loop is idempotent and its first tick is five minutes out, so starting it
  // early costs nothing and removes the dependency entirely.
  startHorseMindPersistence();
  void (async () => {
    const lastFlush = await hydrateHorseMindFromDb();
    if (!leaderLifecycleIsCurrent(generation)) return;
    await hydrateHorseMind(lastFlush);
  })().catch((err) => reportError(err, 'HorseMindPersistence.boot_hydration'));
  // V12 (2026-08-22): nightly per-horse self-study — every horse reviews its
  // own week of play, diagnoses leaks vs winning benchmarks, and nudges its
  // own profile dials. See HorseSelfTuner.ts + horse_self_tune_log.
  // V14 (Dan 2026-08-23): every horse must be a complete person — real name,
  // poker alias, player number, lifetime VIP, wired brain, and the ability to
  // post. Six different seed paths each created a different subset, so 484 of
  // 584 had no alias, 276 no lifetime VIP, and 177 could not post at all.
  // Enforcing completeness at boot means a horse created by ANY path, now or
  // later, converges on being whole instead of depending on which script made
  // it. The operation is generation-fenced and retained so leadership cannot
  // be released while one last profile repair is still committing.
  trackLeaderBootMutation(
    sweepIncompleteHorses(1000, () => leaderLifecycleIsCurrent(generation)),
    'HorseOnboarding.boot_sweep'
  );
  startHorseSelfTuner();
  // V12 (2026-08-22): nightly duplicate-deal self-play league — measures
  // every strategy layer in bb/100 so tuning is evidence, not vibes. See
  // benchmark/HorseLeague.ts + horse_league_results.
  startHorseLeague();
  // Daily audit (Dan 2026-08-26): findings over yesterday's 20bb reviews +
  // league results, written to horse_daily_audit for the /horses admin panel.
  startHorseDailyAudit();
  // Proof of receipt (Dan 2026-08-26): live layer-fire counters, flushed to
  // horse_brain_telemetry every minute for the daily audit + admin panel.
  startBrainTelemetryFlush();
  // Phase 1 of the real-time build plan (Dan 2026-09-04): the Horse Data
  // Ledger - every input the brain consumes, with its source, cadence,
  // consumer and receipt - carried into horse_data_ledger so the daily
  // audit can judge yesterday's fires against the contract that shipped.
  startHorseDataLedgerSync();
  // Game lanes (Dan 2026-08-27): the exact 33/33/34 split lives in the
  // database; this hydrates it and re-balances when the fleet grows.
  startHorseLaneLoader();
  // Phase 2 canonical solver contract: load any deployment artifact before
  // chart hydration. Both paths publish immutable in-memory maps, so horse
  // decisions never wait on a remote solver or database query.
  startSolverPolicyArtifactLoader();
  // V27 solver charts (Dan 2026-08-29): the PioSolver push/fold charts,
  // hydrated so the synchronous decision reads them at zero I/O. Without
  // this call the layer is inert and heuristics decide — which is the
  // fallback, not the plan.
  startGtoChartLoader();
  // V29 solver flop cells (Dan 2026-08-29): the offline aggregation of the
  // 8.8M-solution warehouse, preloaded so heads-up hold'em flops play the
  // solver's mixes at zero I/O. Without this the layer is inert (heuristics
  // decide) — which is the fallback, not the plan.
  startGtoPostflopLoader();
  // V31 (2026-08-30): the suit-aware cells from the SECOND solver export,
  // which is disjoint from the one V29/V30 read. Consulted before V30 and
  // carries the solver's real bet size, so it can play the 246%-pot turn
  // overbet v1 cannot express. Empty table = inert, V30 answers as before.
  startGtoPostflopV31Loader();
  // V30 (Dan 2026-08-29): the one-time turn/river aggregation, paced in
  // small batches off the deal path. Restart-safe (cursor in
  // gto_agg_progress); permanently silent once both streets are done.
  startGtoAggregationDriver();
  // V31 (2026-08-30): the SECOND solver export, strategy_matrix_v2, which is
  // DISJOINT from the one V30 reads - zero of 9,584 sampled turn rows carry
  // both - so this is the other 59% of the turn rather than a re-run. It
  // gates itself on V30 reporting every street done, because both walk the
  // same 79 GB table and V30 is the one with a consult already reading it.
  startGtoAggregationDriverV31();
  // Overlay guard (Dan 2026-08-27): Midway Union guaranteed events get topped
  // up with horses that are not already in them, so no overlay occurs.
  horseOverlayGuard = startHorseOverlayGuard();
  // V7 (2026-07-24): humanlike session rhythms — horses stand up after real
  // sessions via the SAME hand-boundary-safe leaveTable() path humans use;
  // the fleet manager reseeds fresh horses within its 30s cycle.
  horseSessionRotator = new HorseSessionRotator((tableId) => gameServer.getTableEngine(tableId));
  horseSessionRotator.start();
  /* OPERATION STABLE HAND (Dan 2026-09-04): the floor planner's FIRST live
     order, and for now its only one. It stands a horse up when a human is on
     that table's waitlist, through the same hand-boundary-safe leaveTable()
     path above. Everything else planFloor decides - seat, open, close - is
     still reported by GET /stable-hand and executed by nobody. Set
     STABLE_HAND_CONTROLLER=false to go back to planning only. */
  stableHandExecutor = new StableHandExecutor((tableId) => gameServer.getTableEngine(tableId));
  stableHandExecutor.start();
}

/** Fence every leader-owned writer synchronously, then join its last mutation. */
function stopLeaderOwnedServices(): Promise<void> {
  if (leaderStopOperation) return leaderStopOperation;
  if (!leaderServicesActive) return Promise.resolve();

  leaderServicesActive = false;
  leaderLifecycleGeneration += 1;

  type LeaderStopResult =
    | { service: string; status: 'fulfilled' }
    | { service: string; status: 'rejected'; reason: unknown };
  const stopCalls: Array<[service: string, stop: () => Promise<unknown> | unknown]> = [
    ['HorseOverlayGuard', () => horseOverlayGuard?.stop()],
    ['HorseSessionRotator', () => horseSessionRotator?.stop()],
    ['StableHandExecutor', () => stableHandExecutor?.stop()],
    ['HorseMindPersistence', stopHorseMindPersistence],
    ['HorseSelfTuner', stopHorseSelfTuner],
    ['HorseLeague', stopHorseLeague],
    ['HorseDailyAudit', stopHorseDailyAudit],
    ['BrainTelemetryFlush', stopBrainTelemetryFlush],
    ['HorseDataLedgerSync', stopHorseDataLedgerSync],
    ['HorseLaneLoader', stopHorseLaneLoader],
    ['GtoAggregationDriver', stopGtoAggregationDriver],
    ['GtoAggregationDriverV31', stopGtoAggregationDriverV31],
    // These loaders only replace immutable process-local lookup maps, but
    // their clocks still belong to this process lifecycle.
    ['GtoChartLoader', stopGtoChartLoader],
    ['SolverPolicyArtifactLoader', stopSolverPolicyArtifactLoader],
    ['GtoPostflopLoader', stopGtoPostflopLoader],
    ['GtoPostflopV31Loader', stopGtoPostflopV31Loader],
    ['HorseOnboardingBootSweep', drainLeaderBootMutations],
  ];

  // Invoke every fence even if an earlier stop throws synchronously, and
  // attach both outcomes immediately so no rejection can escape while its
  // siblings are still draining.
  const stops = stopCalls.map(([service, stop]): Promise<LeaderStopResult> => {
    try {
      return Promise.resolve(stop()).then<LeaderStopResult, LeaderStopResult>(
        () => ({ service, status: 'fulfilled' }),
        (reason) => ({ service, status: 'rejected', reason })
      );
    } catch (reason) {
      return Promise.resolve({ service, status: 'rejected', reason });
    }
  });

  leaderStopOperation = (async () => {
    const results = await Promise.all(stops);
    horseOverlayGuard = null;
    horseSessionRotator = null;
    stableHandExecutor = null;
    const failures = results.filter(
      (result): result is Extract<LeaderStopResult, { status: 'rejected' }> =>
        result.status === 'rejected'
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(
          ({ service, reason }) =>
            new AggregateError([reason], `${service} did not certify shutdown ownership`)
        ),
        `${failures.length} index-owned service(s) did not certify shutdown ownership`
      );
    }
  })();
  return leaderStopOperation;
}

// The GameServer owns the only distributed-release path. Index-started
// writers participate in that same certificate rather than being stopped by
// a parallel signal path that could finish early.
gameServer.registerExternalShutdownOwnershipBarrier(stopLeaderOwnedServices);

httpServer.listen(PORT, () => {
  console.log(`[HTTP] Health check server listening on port ${PORT}`);
  console.log(`[WS]   Engine WebSocket server attached at /ws/table/:tableId`);
  console.log(`[WS]   Channel WebSocket server attached at /ws/channel`);
  leaderStartOperation = startLeaderOwnedServices();
  void leaderStartOperation.catch((err) => fatal(err, 'GameServer.Fatal_error'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

const SHUTDOWN_DEADLINE_MS = 40_000;
let shutdownOperation: Promise<void> | null = null;
let shutdownMustFail = false;
let shutdownFailureExitScheduled = false;

type ShutdownStepResult =
  | { step: string; status: 'fulfilled' }
  | { step: string; status: 'rejected'; reason: unknown };

function beginShutdownStep(
  step: string,
  operation: () => Promise<unknown> | unknown
): Promise<ShutdownStepResult> {
  try {
    return Promise.resolve(operation()).then<ShutdownStepResult, ShutdownStepResult>(
      () => ({ step, status: 'fulfilled' }),
      (reason) => ({ step, status: 'rejected', reason })
    );
  } catch (reason) {
    return Promise.resolve({ step, status: 'rejected', reason });
  }
}

function scheduleFailedShutdownExit(error: unknown, kind: string): void {
  shutdownMustFail = true;
  reportError(error, kind);
  console.error(`[GameServer] ${kind} - ownership release was not certified`, error);
  if (shutdownFailureExitScheduled) return;
  shutdownFailureExitScheduled = true;
  // Keep this referenced. Once transports are closed, an unref'd failure
  // timer can let Node fall off the event loop with a misleading status 0.
  setTimeout(() => process.exit(1), 2_000);
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

async function performShutdown(): Promise<void> {
  console.log('\n[GameServer] Received shutdown signal...');

  // One deadline owns the entire shutdown. The old 18-second pre-drain raced
  // a second 30-second timer that unconditionally exited 0 even when
  // GameServer.stop() was still holding table/tournament ownership. This timer
  // is deliberately fatal: a missed deadline exits 1 and lets the supervisor
  // recover; only the completed ownership-release path may exit 0.
  const hardDeadline = setTimeout(() => {
    const error = new Error(
      `[GameServer] graceful shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms before ownership release`
    );
    reportError(error, 'GameServer.shutdown_deadline');
    console.error(error.message);
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);

  // Attach both outcomes to every parallel operation at admission time. This
  // prevents a fast transport/startup rejection from surfacing as an
  // unhandledRejection while the authoritative ownership drain is still in
  // progress.
  const startupCompletion = leaderStartOperation
    ? beginShutdownStep('leader startup', () => leaderStartOperation)
    : Promise.resolve<ShutdownStepResult>({ step: 'leader startup', status: 'fulfilled' });
  const localStops = [
    beginShutdownStep('HTTP server', closeHttpServer),
    beginShutdownStep('table WebSocket server', () => engineWs.close()),
    beginShutdownStep('channel WebSocket server', () => channelWs.close()),
  ];

  try {
    // stop() applies both the GameServer and registered index-service fences
    // synchronously, then joins a boot that may still be suspended. Calling it
    // before awaiting startup is what guarantees a rejected boot cannot skip
    // teardown and leave its distributed ownership behind.
    await gameServer.stop();
    const localResults = await Promise.all([startupCompletion, ...localStops]);
    const localFailures = localResults.filter(
      (result): result is Extract<ShutdownStepResult, { status: 'rejected' }> =>
        result.status === 'rejected'
    );
    if (localFailures.length > 0) {
      throw new AggregateError(
        localFailures.map(
          ({ step, reason }) => new AggregateError([reason], `${step} failed during shutdown`)
        ),
        `${localFailures.length} local shutdown step(s) failed after ownership release`
      );
    }
    clearTimeout(hardDeadline);
    process.exit(shutdownMustFail ? 1 : 0);
  } catch (error) {
    clearTimeout(hardDeadline);
    scheduleFailedShutdownExit(error, 'GameServer.shutdown_failed');
    throw error;
  }
}

const shutdown = (): Promise<void> => {
  if (shutdownOperation) return shutdownOperation;
  shuttingDown = true;
  shutdownOperation = performShutdown();
  return shutdownOperation;
};

// Leadership loss is the same ownership transition as SIGTERM.  The
// leadership module deliberately does not release its lease or terminate the
// process on its own: this callback first fences every index-owned writer,
// then lets GameServer stop and release all of its distributed ownership.
registerLeadershipShutdownHandler((reason) => {
  console.error(`[GameServer] Leadership requested shutdown: ${reason}`);
  return shutdown();
});

process.on('SIGINT', () => {
  void shutdown().catch(() => undefined);
});
process.on('SIGTERM', () => {
  void shutdown().catch(() => undefined);
});
/**
 * 2026-08-15: these handlers used to swallow and keep running.
 *
 * After an uncaughtException V8 has unwound a stack mid-operation. In this
 * codebase that concretely means a hand where chips left stacks but the pot was
 * never awarded, a postHandTasksPromise that will never resolve (the dealing
 * loop awaits it forever), or an actionLock stuck true. The process then kept
 * serving /action and kept answering "running":true while every table under it
 * was dead — strictly worse than crashing, because the supervisor was already
 * there and unused.
 *
 * Exiting costs ONE hand: `docker run --restart always` is back in ~2s,
 * cleanupStaleData cashes seats out idempotently, and discovery rebuilds every
 * table within a 5s cycle. Staying up costs every table, indefinitely.
 */
let exiting = false;
const fatal = (err: unknown, kind: string) => {
  reportError(err, kind);
  shutdownMustFail = true;
  if (exiting) return;
  exiting = true;
  console.error(`[GameServer] FATAL (${kind}) - draining for supervisor restart`);
  // Snapshot the queue immediately for incident evidence. The authoritative
  // shutdown below now drains it after every dealer stops; if that ownership
  // proof fails, the nonzero hard deadline remains the final backstop.
  try {
    const held = handHistoryQueueDepth();
    if (held > 0) {
      reportError(
        new Error(
          `[GameServer] exiting fatally with ${held} unwritten hand_history row(s) still ` +
            `queued - those hands will have no history row.`
        ),
        'GameServer.hand_history_queue_lost_on_fatal'
      );
    }
  } catch {
    /* never let the diagnostic stop the exit */
  }
  void shutdown().catch(() => undefined);
};
process.on('uncaughtException', (err) => fatal(err, 'GameServer.Uncaught_exception'));
process.on('unhandledRejection', (err) => fatal(err, 'GameServer.Unhandled_rejection'));
