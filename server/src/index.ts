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
import { handHistoryQueueDepth, supabase } from './services/supabase.js';
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
import { startHorseLaneLoader } from './services/HorseLaneLoader.js';
import { startGtoChartLoader } from './services/GtoChartLoader.js';
import { startGtoPostflopLoader } from './services/GtoPostflopLoader.js';
import { startGtoPostflopV31Loader } from './services/GtoPostflopV31Loader.js';
import { startGtoAggregationDriver } from './services/GtoAggregationDriver.js';
import { startGtoAggregationDriverV31 } from './services/GtoAggregationDriverV31.js';
import { startHorseOverlayGuard } from './services/HorseOverlayGuard.js';
import { HorseSessionRotator } from './services/HorseSessionRotator.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '8080', 10);

// ═══════════════════════════════════════════════════════════════════════════════
// MEMBER FEE ROLLUP — background refresh loop (2026-08-23)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * WHY THIS EXISTS
 *
 * The club roster's "Fees" column, the Member Management stats panel and the
 * Player Statistics page all read `public.member_fee_rollup`. Aggregating those
 * numbers live out of `hand_history` scans millions of rows and blows past the
 * Postgres statement timeout, so the pre-aggregated table is the only way those
 * surfaces can load at all.
 *
 * `fn_refresh_member_fee_rollup(p_batch_hands)` folds one batch of hands into
 * the rollup and advances a forward-only watermark in `member_fee_rollup_state`.
 * It is additive and idempotent — repeated calls cannot double count — and it
 * takes a transaction-scoped advisory lock, so a concurrent caller is a no-op
 * rather than a conflict. Nothing else keeps the rollup current, and this engine
 * is the one process that already runs 24/7, so the loop lives here.
 *
 * TWO SPEEDS. At the time of writing ~1.5M hands are not yet rolled up, so while
 * the function reports `caught_up: false` we run batches every 2s (backfill).
 * Once it reports caught up we drop to a 30s tick (steady state).
 *
 * BATCH SIZE IS BOUNDED BY THE CLIENT. services/supabase imposes a 15s hard
 * fetch timeout via AbortController, so that - not the database - is the real
 * ceiling. Measured against production on 2026-08-23, a batch costs about 23ms
 * per hand: 250 hands takes 5.7s, and the 2000 originally shipped here needs
 * about 46 SECONDS. 2000 could therefore never complete, and did not once: the
 * loop ran from the moment it deployed and rolled up nothing at all, because
 * every call was aborted and rolled back. 250 is the size that fits with room
 * to spare when the database is busy.
 *
 * There was a second ceiling underneath that one, now removed. PostgREST
 * connects as `authenticator` (statement_timeout=8s) and `service_role`
 * inherits it, so even a batch inside the client's 15s was killed server-side
 * with 57014. Migration 20260823_06 attaches statement_timeout=30s to the
 * function itself. Testing the RPC over a direct SQL connection hid both
 * faults - that path runs as `postgres` with a 2min timeout and succeeds every
 * time. Verify this loop through PostgREST or not at all.
 *
 * A timed-out call is safe to retry: the watermark only advances inside the
 * function's own transaction, so a cancelled batch costs time and nothing
 * else. That is exactly why the failure was silent.
 *
 * It is a self-scheduling setTimeout, NOT a setInterval: a slow batch must never
 * be able to overlap the next run. Errors are reported and retried after 60s,
 * never rethrown — a reporting rollup must not be able to take the game engine
 * down. Kill switch that needs no deploy: MEMBER_FEE_ROLLUP_ENABLED=false.
 * Anything else (including unset) leaves it ON, so shipping this turns it on.
 */
const MEMBER_FEE_ROLLUP_ENABLED = process.env.MEMBER_FEE_ROLLUP_ENABLED !== 'false';
/**
 * BATCH SIZE RAISED 250 -> 1000 (2026-08-25), because the reason it had to be
 * 250 was a query defect, not a real cost.
 *
 * Every single-reference CTE inside fn_refresh_member_fee_rollup was being
 * INLINED and then re-executed per outer row inside nested loops. Migration
 * 20260825_perf_fee_rollup_materialize_ctes puts AS MATERIALIZED fences back:
 * a 250-hand batch measured 35,842 ms inlined and 768 ms materialized, for
 * byte-identical output. End to end the function went ~70 ms/hand -> ~5.7
 * ms/hand.
 *
 * At 5.7 ms/hand a 1000-hand batch is about 5.7s - inside the 15s client
 * AbortController and the function's own 30s statement_timeout with room to
 * spare, and it triples drain throughput at the SAME <=50% duty cycle
 * (1000 per ~11.4s vs 250 per ~7.8s). Do not raise it further without
 * re-measuring: the 15s client abort, not the database, is still the ceiling.
 */
const ROLLUP_BATCH_HANDS = 1000;
const ROLLUP_BACKFILL_MS = 2_000;
/**
 * DUTY CYCLE CAP (2026-08-25). The backfill must never saturate a core.
 *
 * Measured on production this day: a 250-hand batch had drifted from the 5.7s
 * recorded on 2026-08-23 to 15.3s, while the loop still slept only
 * ROLLUP_BACKFILL_MS (2s) between calls. That is a ~88% duty cycle - on a
 * 2 vCPU instance this ONE reporting rollup was consuming roughly half the
 * platform's total query capacity, and pg_stat_statements confirmed it at
 * 13.7% of all database time with 565,894 hands still to go (about 11 more
 * hours at that rate).
 *
 * A fixed longer delay would be wrong in the other direction: it would waste
 * genuine idle capacity when the database is quiet. Instead we sleep for at
 * least as long as the batch just took, so the loop self-tunes to a <=50% duty
 * cycle - fast when the database is fast, politely backing off exactly when it
 * is slow, which is precisely when live play needs the core. Backfill wall
 * time roughly doubles; nobody is watching a reporting rollup, and players are
 * watching the table.
 */
const ROLLUP_MAX_DUTY_CYCLE = 0.5;
const ROLLUP_STEADY_MS = 30_000;
const ROLLUP_RETRY_MS = 60_000;

let rollupTimer: NodeJS.Timeout | null = null;
let rollupStopped = false;

/** Run one batch. Returns the delay before the next run. Throws on RPC failure. */
async function refreshMemberFeeRollupOnce(): Promise<number> {
  const startedAt = Date.now();
  const { data, error } = await supabase.rpc('fn_refresh_member_fee_rollup', {
    p_batch_hands: ROLLUP_BATCH_HANDS,
  });
  const elapsedMs = Date.now() - startedAt;
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as { processed?: number; rollup_rows?: number; caught_up?: boolean };
  if ((r.processed ?? 0) > 0) {
    console.log(
      `[FeeRollup] processed ${r.processed} hand(s) into ${r.rollup_rows ?? 0} rollup row(s)` +
        (r.caught_up ? ' - caught up' : '')
    );
  }
  if (r.caught_up !== false) return ROLLUP_STEADY_MS;

  // Backfilling. Yield for at least as long as the batch itself ran, so the
  // loop can never exceed ROLLUP_MAX_DUTY_CYCLE of one core. Still floored at
  // ROLLUP_BACKFILL_MS so a very fast batch does not become a busy loop.
  const yieldMs = Math.round(elapsedMs * ((1 - ROLLUP_MAX_DUTY_CYCLE) / ROLLUP_MAX_DUTY_CYCLE));
  return Math.max(ROLLUP_BACKFILL_MS, yieldMs);
}

function scheduleMemberFeeRollup(delayMs: number): void {
  if (rollupStopped) return;
  rollupTimer = setTimeout(() => {
    void (async () => {
      let next = ROLLUP_STEADY_MS;
      try {
        next = await refreshMemberFeeRollupOnce();
      } catch (err) {
        reportError(err, 'MemberFeeRollup.refresh');
        next = ROLLUP_RETRY_MS;
      }
      scheduleMemberFeeRollup(next);
    })();
  }, delayMs);
  // Never hold the process open just to refresh a reporting rollup.
  rollupTimer.unref?.();
}

/** Start the loop. Idempotent; call only once the server is listening. */
function startMemberFeeRollup(): void {
  if (!MEMBER_FEE_ROLLUP_ENABLED) {
    console.log('[FeeRollup] disabled (MEMBER_FEE_ROLLUP_ENABLED=false)');
    return;
  }
  if (rollupTimer) return;
  console.log('[FeeRollup] refresh loop started');
  scheduleMemberFeeRollup(0);
}

/** Stop the loop for good (shutdown). Any in-flight batch is safe to abandon:
 *  the watermark only advances inside the function's own transaction. */
function stopMemberFeeRollup(): void {
  rollupStopped = true;
  if (rollupTimer) {
    clearTimeout(rollupTimer);
    rollupTimer = null;
  }
}

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
    void gameServer.getTableEngine(tableId)?.rePushHoleCards(userId);
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
  // 2026-08-23: keep public.member_fee_rollup current (club roster "Fees",
  // Member Management stats, Player Statistics). See the block above for why.
  startMemberFeeRollup();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

let shuttingDown = false;
/**
 * The shutdown budget, in one place, because the three numbers involved only
 * make sense relative to each other:
 *
 *   docker stop -t 45   Docker's grace before SIGKILL   (server/scripts/engine-up.sh)
 *   SHUTDOWN_CAP_MS 40s everything below must finish inside this
 *   DRAIN_BUDGET_MS 28s of that, spent parking tables at a hand boundary
 *                       leaving 12s for the state flush and 5s of margin
 *
 * Raising the drain past the cap, or the cap past the grace, converts a clean
 * shutdown into a SIGKILL mid-flush. Change them together or not at all.
 */
const DRAIN_BUDGET_MS = 28_000;
const SHUTDOWN_CAP_MS = 40_000;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[GameServer] Received shutdown signal...');
  // Refuse new actions immediately, then drain. GameServer.stop() stops engines
  // sequentially and each awaits a snapshot flush, so with 25-40 tables it
  // cannot finish inside Docker's default 10s grace — bound it so we exit
  // cleanly on our own terms instead of being SIGKILLed mid-flush.
  httpServer.close();
  // Cheap and synchronous - stop the rollup loop before the drain race so it
  // cannot schedule another batch while we are shutting down.
  stopMemberFeeRollup();
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
      // stopped them, which is the voided hand it exists to prevent.
      //
      // 2026-09-01: BUDGET RAISED 18s -> 28s, and the outer cap 30s -> 40s.
      //
      // 18 seconds was still short, and this time the estimate above is the
      // reason. "~20s" was a guess; measured over 41,269 real hands in a
      // three-hour window the distribution is:
      //
      //     p50 17.2s   p90 48.2s   p99 98.2s
      //     47.2% of hands run longer than 18s
      //     23.8% longer than 30s
      //     11.6% longer than 45s
      //
      // So the drain was expiring on roughly HALF the tables it was meant to
      // park, on every restart. That is not a subtle failure and it shows up
      // in the data: chip drift on games in flight across a deploy restart
      // runs at 8.05% against a 1.50% baseline (issue #2406).
      //
      // The ceiling is not the 45s of `docker stop -t 45` (server/scripts/
      // engine-up.sh) — it is the 40s outer race below, which must finish
      // before Docker's SIGKILL. 28s of drain leaves 12s for the state flush
      // (the same 12s the 18s budget left) and still stops 5s clear of the
      // grace. That lifts the share of hands the drain can actually save from
      // 52.8% to about 74%.
      //
      // Getting past ~74% means raising `docker stop -t 45` itself, which is a
      // deploy-script change with its own 180s lock margin to think about, so
      // it is deliberately not bundled in here. The numbers above are what
      // that decision needs.
      //
      // The drain returns EARLY the moment every table has parked, so a quiet
      // fleet pays nothing for the larger budget.
      try {
        await gameServer.drainHands(DRAIN_BUDGET_MS);
      } catch (err) {
        console.error('[GameServer] drain failed, stopping anyway:', err);
      }
      // V12: final horse-memory flush rides the same drain window — learned
      // reads from the last few minutes survive the restart.
      await Promise.allSettled([gameServer.stop(), channelWs.close(), stopHorseMindPersistence()]);
    })(),
    new Promise((r) => setTimeout(r, SHUTDOWN_CAP_MS)),
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
