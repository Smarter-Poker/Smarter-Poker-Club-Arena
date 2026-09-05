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
import { startHorseSelfTuner } from './services/HorseSelfTuner.js';
import { sweepIncompleteHorses } from './services/HorseOnboarding.js';
import { startHorseLeague } from './benchmark/HorseLeague.js';
import { startHorseDailyAudit } from './services/HorseDailyAudit.js';
import { startBrainTelemetryFlush } from './services/BrainTelemetryFlush.js';
import { startHorseDataLedgerSync } from './services/HorseDataLedgerSync.js';
import { startHorseLaneLoader } from './services/HorseLaneLoader.js';
import { startGtoChartLoader } from './services/GtoChartLoader.js';
import { startGtoPostflopLoader } from './services/GtoPostflopLoader.js';
import { startGtoPostflopV31Loader } from './services/GtoPostflopV31Loader.js';
import { startGtoAggregationDriver } from './services/GtoAggregationDriver.js';
import { startGtoAggregationDriverV31 } from './services/GtoAggregationDriverV31.js';
import { startHorseOverlayGuard } from './services/HorseOverlayGuard.js';
import { HorseSessionRotator } from './services/HorseSessionRotator.js';
import { StableHandExecutor } from './services/StableHandExecutor.js';

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

httpServer.listen(PORT, () => {
  console.log(`[HTTP] Health check server listening on port ${PORT}`);
  console.log(`[WS]   Engine WebSocket server attached at /ws/table/:tableId`);
  console.log(`[WS]   Channel WebSocket server attached at /ws/channel`);
  gameServer.start().catch((err) => {
    reportError(err, 'GameServer.Fatal_error');
    process.exit(1);
  });
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
    await hydrateHorseMind(lastFlush);
  })();
  // V12 (2026-08-22): nightly per-horse self-study — every horse reviews its
  // own week of play, diagnoses leaks vs winning benchmarks, and nudges its
  // own profile dials. See HorseSelfTuner.ts + horse_self_tune_log.
  // V14 (Dan 2026-08-23): every horse must be a complete person — real name,
  // poker alias, player number, lifetime VIP, wired brain, and the ability to
  // post. Six different seed paths each created a different subset, so 484 of
  // 584 had no alias, 276 no lifetime VIP, and 177 could not post at all.
  // Enforcing completeness at boot means a horse created by ANY path, now or
  // later, converges on being whole instead of depending on which script made
  // it. Fire-and-forget and fail-safe: it never blocks startup.
  void sweepIncompleteHorses();
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
  startHorseOverlayGuard();
  // V7 (2026-07-24): humanlike session rhythms — horses stand up after real
  // sessions via the SAME hand-boundary-safe leaveTable() path humans use;
  // the fleet manager reseeds fresh horses within its 30s cycle.
  new HorseSessionRotator((tableId) => gameServer.getTableEngine(tableId)).start();
  /* OPERATION STABLE HAND (Dan 2026-09-04): the floor planner's FIRST live
     order, and for now its only one. It stands a horse up when a human is on
     that table's waitlist, through the same hand-boundary-safe leaveTable()
     path above. Everything else planFloor decides - seat, open, close - is
     still reported by GET /stable-hand and executed by nobody. Set
     STABLE_HAND_CONTROLLER=false to go back to planning only. */
  new StableHandExecutor((tableId) => gameServer.getTableEngine(tableId)).start();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[GameServer] Received shutdown signal...');
  // Refuse new actions immediately, then drain. GameServer.stop() stops engines
  // sequentially and each awaits a snapshot flush, so with 25-40 tables it
  // cannot finish inside Docker's default 10s grace — bound it so we exit
  // cleanly on our own terms instead of being SIGKILLed mid-flush.
  httpServer.close();
  await Promise.race([
    (async () => {
      // FINISH THE HANDS FIRST (2026-08-27). Stopping an engine mid-hand voids
      // that hand. Until now the only thing standing between a restart and a
      // voided hand was the deploy workflow's drain gate, which counted
      // HUMANS — so a horse's hand was voided without a second thought, and
      // the gate only ran for deploys anyway (a healthcheck kill or a
      // supervisor bounce went straight through).
      //
      // Draining here fixes both: it protects the HAND rather than the
      // species of whoever is holding it, and it runs on every restart path.
      // Bounded at 8s and still inside the 20s cap below, so a table stuck
      // mid-hand cannot hold the process open and get us SIGKILLed mid-flush.
      // 2026-08-28: BUDGET RAISED 8s -> 18s, and the outer cap with it.
      //
      // 8 seconds could not do the job it was written for. `pauseAfterHand`
      // parks a table at the END of its current hand, and a hand on this
      // platform runs ~20s, so an 8s budget expired with most tables still
      // mid-hand — the drain logged "budget expired, stopping anyway" and
      // stopped them, which is the voided hand it exists to prevent. The
      // container gets `docker stop -t 45` of grace (server/scripts/
      // engine-up.sh), so 18s of drain inside a 30s race leaves 12s for the
      // state flush and still finishes 15s before Docker would SIGKILL.
      // The drain returns EARLY the moment every table has parked, so a quiet
      // fleet pays nothing for the larger budget.
      try {
        await gameServer.drainHands(18000);
      } catch (err) {
        console.error('[GameServer] drain failed, stopping anyway:', err);
      }
      // V12: final horse-memory flush rides the same drain window — learned
      // reads from the last few minutes survive the restart.
      await Promise.allSettled([gameServer.stop(), channelWs.close(), stopHorseMindPersistence()]);
    })(),
    new Promise((r) => setTimeout(r, 30_000)),
  ]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
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
  if (exiting) return;
  exiting = true;
  console.error(`[GameServer] FATAL (${kind}) - exiting for supervisor restart`);
  // REVIEW FIX 2026-08-20: this path never calls gameServer.stop(), so anything
  // still held in the hand_history retry queue dies with the process. That loss
  // is accepted by design (the queue is in-process), but it must not be
  // INVISIBLE — those hands will have no history row and nothing will ever say
  // so otherwise.
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
  // Give Sentry a moment, but never hang on it.
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('uncaughtException', (err) => fatal(err, 'GameServer.Uncaught_exception'));
process.on('unhandledRejection', (err) => fatal(err, 'GameServer.Unhandled_rejection'));
