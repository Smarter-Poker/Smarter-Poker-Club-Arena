/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ENGINE INSTRUMENTS — shared singleton metrics registry + tracer (WIRE #5)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ADDITIVE wiring glue between the self-contained observability/ foundation and
 * the live engine. Provides ONE process-wide MetricsRegistry (so the engine hot
 * paths and the /metrics HTTP route see the same counters) plus the extra
 * instruments the engine needs beyond createDefaultRegistry().
 *
 * FLAG GATING
 *   - In-proc counter/histogram updates are cheap and always callable.
 *   - The /metrics exposition endpoint (handlers/health.ts) only appends this
 *     registry's text when ENGINE_METRICS === 'on'.
 *   - Tracing spans are only STARTED by the engine when ENGINE_METRICS === 'on',
 *     and this tracer only attaches a span exporter under the same flag, so
 *     nothing is exported unless flagged.
 *
 * Default: ENGINE_METRICS unset => OFF (endpoint hidden, no span export).
 */

import { createDefaultRegistry, type Counter, type Histogram } from './Metrics.js';
import { Tracer, InMemorySpanExporter } from './Tracing.js';
import { MetricsRegistry as AlwaysOnRegistryCtor } from './Metrics.js';
import { sampleProcessMemory } from './processMemory.js';

/**
 * ALWAYS-ON registry: exposed by /metrics unconditionally, and therefore the
 * only place a counter an alert rule reads may live. Bounded cardinality is
 * its contract - never a table_id, never a user id. Declared here, at the top,
 * because instruments above and below it both register on it.
 */
export const alwaysOnRegistry = new AlwaysOnRegistryCtor();

/** True only when the operator explicitly opts in. Default OFF. */
export const ENGINE_METRICS_ENABLED = process.env.ENGINE_METRICS === 'on';

const defaults = createDefaultRegistry();

/** Process-wide registry shared by the engine hot paths and the /metrics route. */
export const metricsRegistry = defaults.registry;

// Named instruments from the foundation's default set.
export const handsTotal: Counter = defaults.handsTotal;
export const actToBroadcastLatency: Histogram = defaults.actToBroadcastLatency;
export const handDuration: Histogram = defaults.handDuration;
export const rpcTotal: Counter = defaults.rpcTotal;
/* `poker_rpc_errors_total` IS READ BY AN ALERT (`DatabaseRpcErrorsElevated`,
   and the `sp:db_error:rate10m` SLO), so it cannot live on the flag-gated
   registry - see the note above the always-on BBJ counters. `method` is a
   handful of values, so the cardinality contract holds. The default
   registry's own instrument of the same name stays unreferenced and is
   never exposed alongside this one: `handleMetrics` renders the always-on
   text first and drops any duplicate family from the gated text. */
export const rpcErrorsTotal: Counter = alwaysOnRegistry.counter(
  'poker_rpc_errors_total',
  'Engine RPC calls that failed (label: method)'
);
const rpcErrorsTotalAlwaysOn = rpcErrorsTotal;
export const wsReconnectsTotal: Counter = defaults.wsReconnectsTotal;
export const eventLoopLag: Histogram = defaults.eventLoopLag;

// Extra instruments the engine needs beyond the default set.
export const actionsTotal: Counter = metricsRegistry.counter(
  'poker_actions_total',
  'Total player actions processed (label: table_id)'
);
export const allInEquityDuration: Histogram = metricsRegistry.histogram(
  'poker_all_in_equity_duration_ms',
  'All-in equity computation duration (ms)'
);
/**
 * SHOWDOWN POLISH 2026-08-25: showdown/muck observability. A future change
 * that silently kills mucking (the exact regression class the 2026-08-25
 * audit caught twice) shows up here as mucked_hands_total flatlining while
 * showdown_hands_total keeps climbing — no DB sampling required.
 */
/**
 * ═══ THE BAD BEAT JACKPOT, COUNTED (BBJ phase 2.4, 2026-09-06) ═════════════
 *
 * A jackpot is the rarest event on the platform - one every few weeks - so
 * "did it work" has never been answerable from a graph, only by reading the
 * ledger after somebody noticed. These four make the whole path observable:
 * DETECTED is what the engine ruled at showdown, PAID is what actually
 * landed, QUEUED is what could not be paid this instant (the :55 freeze is
 * the ordinary cause) and PARKED is a single recipient's share held because
 * no club wallet would take it.
 *
 * The useful reading is the DIFFERENCE. detected == paid is health. A
 * detected that never becomes paid or queued is the failure mode the whole
 * of phase 2 exists to make impossible, and it would now be visible as two
 * counters that stopped agreeing.
 */
/* ═══ THESE ARE ALWAYS ON (2026-09-09) ═══════════════════════════════════
 *
 * They were registered on `metricsRegistry`, which `/metrics` appends only
 * when `ENGINE_METRICS === 'on'` - and that variable is set NOWHERE in this
 * estate: not in a workflow, not in a deploy script, not in an env file. It
 * appears exactly once in the whole repo, in a COMMENT. So every counter
 * below has been incremented on every hand since it shipped and rendered to
 * nobody, and the alert rules that read them (SLOHandsAreNotBeingDealt,
 * severity critical, page: sms) evaluate `rate()` over a series with no
 * samples - an empty vector, which can never cross a threshold. The BBJ
 * observability shipped 2026-09-06 to answer "did the jackpot pay", and it
 * could not answer anything.
 *
 * They move to `alwaysOnRegistry`, and they lose `table_id` on the way:
 * that registry's whole contract is bounded cardinality (see its header),
 * and the fleet question these answer - detected vs paid, showdown vs muck -
 * is a fleet number. Which table is in the ledger and in `hand_history`.
 * `alwaysOnRegistry` is declared below; these sit after it. */

export const showdownHandsTotal: Counter = alwaysOnRegistry.counter(
  'poker_showdown_hands_total',
  'Hands that reached a contested showdown (fleet total)'
);
export const muckedHandsTotal: Counter = alwaysOnRegistry.counter(
  'poker_mucked_hands_total',
  'Showdown holdings the engine ruled muckable (fleet total)'
);

/**
 * ═══ THE BAD BEAT JACKPOT, COUNTED (BBJ phase 2.4, 2026-09-06) ═════════════
 *
 * A jackpot is the rarest event on the platform - one every few weeks - so
 * "did it work" has never been answerable from a graph, only by reading the
 * ledger after somebody noticed. These make the whole path observable:
 * DETECTED is what the engine ruled at showdown, PAID is what actually
 * landed, QUEUED is what could not be paid this instant (the :55 freeze is
 * the ordinary cause) and PARKED is a single recipient's share held because
 * no club wallet would take it.
 *
 * The useful reading is the DIFFERENCE. detected == paid is health. A
 * detected that never becomes paid or queued is the failure mode the whole
 * of phase 2 exists to make impossible, and it is now visible as two
 * counters that stopped agreeing.
 */
export const bbjHitsDetectedTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_hits_detected_total',
  'Bad Beat Jackpot hits the engine ruled qualifying at showdown (fleet total)'
);
export const bbjPayoutsPaidTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_payouts_paid_total',
  'Bad Beat Jackpot payouts that landed on the first live attempt (fleet total)'
);
export const bbjPayoutsQueuedTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_payouts_queued_total',
  'Bad Beat Jackpot payouts queued for the reconciler (fleet total)'
);
export const bbjSharesParkedTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_shares_parked_total',
  'Bad Beat Jackpot recipient shares parked because no club wallet would take them (fleet total)'
);

/**
 * DRILLS, COUNTED SEPARATELY FROM JACKPOTS (BBJ phase 4.1).
 *
 * A drill produces a REAL payout at a drill club - real chips, real
 * recipients - so it also increments detected and paid. Counting it here as
 * well is what lets anybody reading the graphs subtract: `detected - drills`
 * is how many genuine bad beats the platform has ruled. Without this, the
 * first drill would look exactly like the jackpot finally hitting.
 */
export const bbjDrillsFiredTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_drills_fired_total',
  'Bad Beat Jackpot DRILLS fired by an armed table - real payouts, synthetic verdict (fleet total)'
);

/**
 * THE MINI IS COUNTED SEPARATELY, AND UNTIL 2026-09-11 IT WAS COUNTED WRONGLY.
 *
 * The three counters above are documented as a set whose USEFUL READING IS THE
 * DIFFERENCE: detected == paid is health, and a detected that never becomes
 * paid or queued is the failure the whole of phase 2 exists to make
 * impossible. The mini broke that arithmetic in both directions at once. It
 * incremented `poker_bbj_payouts_queued_total` when a mini was queued, and
 * incremented NOTHING when a mini was detected or when a mini was paid. So
 * every queued mini widened `detected - queued - paid` and read exactly like
 * the main jackpot failing to deliver, while a mini that stopped paying
 * altogether moved no series at all.
 *
 * They are their own counters rather than a `kind` label on the existing ones
 * because the two jackpots are separate products with separate economics - the
 * mini is a flat amount out of a per-pool reserve, the main a share of a pool -
 * and because an existing dashboard or alert reading the main's series must
 * keep meaning what it meant before this commit.
 *
 * The same difference is the useful reading here: mini detected == mini paid
 * is health, and mini detected climbing while mini paid does not is a reserve
 * sitting on its floor.
 */
export const bbjMiniHitsDetectedTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_mini_hits_detected_total',
  'MINI Bad Beat Jackpot hits the engine ruled qualifying at showdown (fleet total)'
);
export const bbjMiniPayoutsPaidTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_mini_payouts_paid_total',
  'MINI Bad Beat Jackpot payouts that landed on the first live attempt (fleet total)'
);
export const bbjMiniPayoutsQueuedTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_mini_payouts_queued_total',
  'MINI Bad Beat Jackpot payouts queued for the reconciler (fleet total)'
);
export const bbjMiniPayoutsRefusedTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_mini_payouts_refused_total',
  'MINI Bad Beat Jackpot hits that qualified and were refused, reserve at floor included (fleet total)'
);

/**
 * THE MINI'S DRILLS, COUNTED SEPARATELY FROM THE MAIN'S (2026-09-11).
 *
 * `bbjDrillsFiredTotal` above is documented as the subtrahend in
 * `detected - drills = genuine bad beats`, and the runbook says the same. The
 * moment the drill learned to fire a MINI, that arithmetic became false: a
 * mini drill incremented `drills_fired` and `mini_hits_detected`, so
 * `bbj_hits_detected - bbj_drills_fired` under-counted genuine MAIN bad beats
 * by one per mini drill and could go negative in any window where minis were
 * drilled and no main jackpot hit.
 *
 * That is the same error the block above was written the same day to fix, made
 * again one counter along. Each family now has its own drill counter, so
 * `detected - drills` holds for both and neither borrows from the other.
 */
export const bbjMiniDrillsFiredTotal: Counter = alwaysOnRegistry.counter(
  'poker_bbj_mini_drills_fired_total',
  'MINI Bad Beat Jackpot DRILLS fired by an armed table - real payouts, synthetic verdict (fleet total)'
);

/**
 * Span exporter is attached ONLY when the flag is on, so span export is a no-op
 * by default. Span duration always feeds handDuration when a span is created,
 * but the engine only creates spans under the same flag, so with the flag unset
 * nothing runs.
 */
export const engineSpanExporter: InMemorySpanExporter | undefined = ENGINE_METRICS_ENABLED
  ? new InMemorySpanExporter(2000)
  : undefined;

export const engineTracer = new Tracer({
  exporter: engineSpanExporter,
  durationHistogram: handDuration,
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ALWAYS-ON FLEET INSTRUMENTS (Realtime programme, Phase 1 - 2026-09-04)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE GAP. `actToBroadcastLatency` above is the one number that defines how a
// table FEELS - the time from a player's action being accepted to every seat
// seeing it - and it has never been scraped in production. It lives in the
// ENGINE_METRICS-gated registry, which is off (checked on engine-01 on
// 2026-09-04: `/metrics` carried zero lines of it). The gate exists for a
// good reason: the per-table label puts ~270 tables x 12 buckets on every
// scrape. So nobody could say whether a Call takes 40 ms or 400 ms to reach
// the felt, or whether a deploy made it slower.
//
// THIS REGISTRY is rendered by GameServer.getPrometheusMetrics() on EVERY
// scrape and carries two series, not two hundred: `audience="human"` for
// tables with at least one human seated and `audience="horse"` for the rest.
// The split matters because the fleet is horse-heavy - a fleet-wide p95 would
// be a horse number, and horses do not complain about lag. The human series
// is the one the alert reads.
//
// FORMAT (Dan, 2026-09-05): "you need to fix the real time connection to the
// spins, heads up and mtt's as well. not just the cash game tables." Every
// format already shares this engine and this socket, so they were always
// measured - but they were one indistinguishable number, so "are Spins slow?"
// had no answer. `format` is cash | spin | hu_sng | sng | mtt, five values,
// so at most ten series with audience. Still never a table_id.
//
// Horses lose nothing here (CLAUDE.md 10.5): the same latency is observed for
// every table; the label says who was watching, it does not change what any
// seat gets.
import { MetricsRegistry, type Gauge } from './Metrics.js';

/** Settlement timing uses bounded counters, not per-hand samples or IDs.
 * Compare duration/count deltas for mean step wall time; slow/count for the
 * fraction taking at least one second. Includes awaited error reporting.
 * outcome describes thrown errors, not a guarantee of financial success.
 */
export const settlementStepCount = alwaysOnRegistry.counter(
  'poker_settlement_step_total',
  'Completed settlement step attempts; labels step, audience, format, outcome=returned|threw'
);
export const settlementStepDuration = alwaysOnRegistry.counter(
  'poker_settlement_step_duration_ms_total',
  'Cumulative settlement step wall time including awaited error handling (ms)'
);
export const settlementStepSlow = alwaysOnRegistry.counter(
  'poker_settlement_step_slow_total',
  'Settlement step attempts taking at least 1000ms'
);

/** act -> broadcast, ms, bounded by audience x tournament format. */
export const actToBroadcastFleet: Histogram = alwaysOnRegistry.histogram(
  'poker_act_to_broadcast_ms',
  'Latency from a player action being accepted to the new state reaching every seat (ms). audience=human when a human is seated at the table, else horse; format=cash|spin|hu_sng|sng|mtt'
);

/**
 * THE TWO CORES, AS NUMBERS (2026-09-08).
 *
 * The delay gauges below measure the main realtime thread that owns sockets,
 * clocks and authoritative table mutation. Horse Monte Carlo now executes on
 * a dedicated worker; `poker_equity_governor_scale` therefore comes from that
 * worker and describes its precision/load tradeoff. They are deliberately not
 * treated as one self-checking signal anymore.
 *
 * These are gauges rather than histograms because each governor already keeps
 * the relevant percentiles in perf_hooks.
 */
export const eventLoopDelayP50: Gauge = alwaysOnRegistry.gauge(
  'poker_event_loop_delay_p50_ms',
  'Event-loop delay p50 over the last second (ms). The engine is one core; this is what saturation looks like from inside it.'
);
export const eventLoopDelayP99: Gauge = alwaysOnRegistry.gauge(
  'poker_event_loop_delay_p99_ms',
  'Event-loop delay p99 over the last second (ms).'
);
export const equityGovernorScale: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_governor_scale',
  'Horse Monte Carlo iteration scale the live decision worker governor is applying (1 = full precision). Below 1 means the worker core is shedding load.'
);
/** Worker sampler lateness survives when its event-loop histogram is starved. */
export const equityGovernorSamplerLateMs: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_governor_sampler_late_ms',
  "How late the live horse-compute worker governor's one-second sampler last ran (ms). This is sampled on the core where Monte Carlo executes."
);

/**
 * LIVE HORSE COMPUTE IS A DIFFERENT CORE (2026-09-08).
 *
 * HorseLogic and its Monte Carlo governor now live in one process-wide worker.
 * Keep its pressure visible independently from the main realtime event loop:
 * conflating these two cores recreates the false diagnosis this isolation was
 * built to eliminate.
 */
export const horseDecisionWorkerReady: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_ready',
  '1 only while the sole live HorseLogic worker is READY; 0 while starting, stopping, stopped, or failed.'
);
export const horseDecisionWorkerQueueDepth: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_queue_depth',
  'Accepted live horse-decision operations either queued or actively computing in the process-wide FIFO.'
);
export const horseDecisionWorkerExpiredJobs: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_expired_jobs',
  'Accepted horse-decision operations whose queue-plus-compute caller deadline elapsed since this worker started. Decision expirations take the legal fail-safe action without misclassifying a healthy worker as wedged.'
);
export const horseDecisionWorkerRecoverableRequestErrors: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_recoverable_request_errors',
  'Horse-decision requests rejected at worker validation since startup. Each caller takes its legal fail-safe action; transport, lifecycle-fence, durable-effect execution, and runtime-integrity failures remain terminal.'
);
export const horseDecisionWorkerActiveJobAgeMs: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_active_job_age_ms',
  'Age of the currently executing horse-decision worker operation in milliseconds; 0 when idle.'
);
export const horseDecisionWorkerOldestQueuedAgeMs: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_oldest_queued_age_ms',
  'Age of the oldest queued, not-yet-executing horse-decision worker operation in milliseconds; 0 when empty.'
);
export const horseDecisionWorkerLastCompletionAgeMs: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_last_completion_age_ms',
  'Milliseconds since the sole live HorseLogic worker last completed an operation; -1 before its first completion.'
);
export const horseDecisionWorkerLastComputeMs: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_last_compute_ms',
  'Compute duration reported by the last completed HorseLogic decision or discard operation in milliseconds; 0 before the first decision.'
);
export const horseDecisionWorkerEventLoopDelayP50: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_event_loop_delay_p50_ms',
  'Event-loop delay p50 inside the sole live HorseLogic worker over its latest status sample (ms).'
);
export const horseDecisionWorkerEventLoopDelayP99: Gauge = alwaysOnRegistry.gauge(
  'poker_horse_decision_worker_event_loop_delay_p99_ms',
  'Event-loop delay p99 inside the sole live HorseLogic worker over its latest status sample (ms).'
);

/** Worker-only all-in/insurance compute capacity and queue pressure. */
export const equityWorkerPoolReady: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_worker_pool_ready',
  '1 only when every configured equity worker has completed its READY handshake; 0 while idle, starting, degraded, failed, or stopping.'
);
export const equityWorkerPoolConfiguredWorkers: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_worker_pool_configured_workers',
  'Configured equity worker count after reserving CPU contexts for the authoritative event loop and live HorseLogic worker.'
);
export const equityWorkerPoolReadyWorkers: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_worker_pool_ready_workers',
  'Equity workers that completed READY and have not exited.'
);
export const equityWorkerPoolBusyWorkers: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_worker_pool_busy_workers',
  'Equity workers currently evaluating an accepted operation.'
);
export const equityWorkerPoolQueueDepth: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_worker_pool_queue_depth',
  'Worker-only all-in equity and insurance operations waiting to execute.'
);
export const equityWorkerPoolOldestQueuedAgeMs: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_worker_pool_oldest_queued_age_ms',
  'Age of the oldest queued equity worker operation in milliseconds; 0 when empty.'
);
export const equityWorkerPoolLastCompletionAgeMs: Gauge = alwaysOnRegistry.gauge(
  'poker_equity_worker_pool_last_completion_age_ms',
  'Milliseconds since the equity pool last completed an operation; -1 before its first completion.'
);

/** Main-thread governor diagnostics remain a realtime-loop signal only. */
export const mainEventLoopGovernorScale: Gauge = alwaysOnRegistry.gauge(
  'poker_main_event_loop_governor_scale',
  'Governor scale implied by the main realtime event loop. It no longer controls horse Monte Carlo work.'
);
export const mainEventLoopGovernorSamplerLateMs: Gauge = alwaysOnRegistry.gauge(
  'poker_main_event_loop_governor_sampler_late_ms',
  "How late the main realtime event loop governor's one-second sampler last ran (ms)."
);

/**
 * WHAT IS ACTUALLY ON THE CORE (2026-09-07).
 *
 * The gauges above say the thread is saturated. They do not say by what, and
 * on 2026-09-07 that cost hours. The answer was the elimination sweep, and the
 * only way to see it was to SSH to the box and run
 * `docker logs | grep -c "elimination sweep still running"` - 780 in fifteen
 * minutes, from a warning that fires once per stuck episode. A number you can
 * only get by grepping a container is a number nobody watches.
 *
 * The incident implementation opened a five-second `setInterval` PER
 * TOURNAMENT. At the 120-199 RUNNING tournaments measured that night that was
 * 24-40 sweeps a second on ONE JavaScript thread. It is now one process-wide,
 * bounded scheduler; these original measurements remain so a release can
 * prove the inflight fan-out fell rather than merely moved.
 *
 * Three series make that loop visible before it closes:
 *
 *   _ms          how long ONE sweep takes, as a distribution
 *   _inflight    how many run at once - the concurrency the single thread is
 *                actually carrying
 *   _overruns    the 780, as a series instead of a grep
 *
 * They measure; they change nothing. The cause is P0/P1 in
 * `docs/HANDOFF_CURRENT_STATE.md` section 16, and the fix needs this data
 * first: whether ONE sweep is slow or THIRTY cheap ones are simply too many is
 * the question that decides between optimising the sweep and re-scheduling it,
 * and nothing on this platform could answer it.
 */
export const eliminationSweepMs: Histogram = alwaysOnRegistry.histogram(
  'poker_tournament_elimination_sweep_ms',
  'Wall time of one admitted tournament elimination sweep (ms). Admission is process-wide and concurrency-bounded.'
);
export const eliminationSweepsInflight: Gauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_sweeps_inflight',
  'Tournament generations currently holding their logical elimination lock. Use elimination_scheduler_slots_inflight for underlying promises physically admitted by the process-wide cap.'
);
export const eliminationSweepOverrunsTotal: Counter = alwaysOnRegistry.counter(
  'poker_tournament_elimination_sweep_overruns_total',
  'Admitted sweep promises still unresolved past the warning budget (outcome=warned). The old forced outcome is retired: a live promise keeps its physical scheduler slot until it settles.'
);

/**
 * One event-driven bounty-outbox drain also serves COMPLETING tournaments
 * that have no live manager after a crash. It is deliberately separate from
 * the elimination scheduler: paying an already-durable obligation must not
 * fan out once per registered manager or poll from tournament discovery.
 */
export const bountyRecoverySweepMs: Histogram = alwaysOnRegistry.histogram(
  'poker_tournament_bounty_recovery_sweep_ms',
  'Wall time of one event-driven pending tournament-bounty outbox drain (ms).'
);
export const bountyRecoverySweepInflight: Gauge = alwaysOnRegistry.gauge(
  'poker_tournament_bounty_recovery_sweep_inflight',
  'Whether the event-driven bounty-outbox recovery drain is running (0 or 1).'
);
export const bountyRecoveryPending: Gauge = alwaysOnRegistry.gauge(
  'poker_tournament_bounty_recovery_pending',
  'Pending durable bounty obligations after the latest successful global recovery sweep.'
);
export const bountyRecoveryRealtimeConnected: Gauge = alwaysOnRegistry.gauge(
  'poker_tournament_bounty_realtime_connected',
  'Whether the process-wide tournament bounty obligation Realtime channel is subscribed (0 or 1).'
);
export const tournamentManagerWakeRealtimeConnected: Gauge = alwaysOnRegistry.gauge(
  'poker_tournament_manager_wake_realtime_connected',
  'Whether the process-wide durable tournament-manager wake Realtime channel is subscribed (0 or 1).'
);
export const bountyRecoverySweepRunsTotal: Counter = alwaysOnRegistry.counter(
  'poker_tournament_bounty_recovery_sweep_runs_total',
  'Event-driven bounty recovery pages (outcome=completed|partial|frozen|error|coalesced).'
);
bountyRecoverySweepInflight.set(0);
bountyRecoveryPending.set(0);
bountyRecoveryRealtimeConnected.set(0);
tournamentManagerWakeRealtimeConnected.set(0);
for (const outcome of ['completed', 'partial', 'frozen', 'error', 'coalesced']) {
  bountyRecoverySweepRunsTotal.inc(0, { outcome });
}

/**
 * ═══ WHY A LEASE WAS NOT RENEWED (2026-09-12) ════════════════════════════════
 *
 * Every cash table on the live engine was re-claiming its lease roughly every
 * twenty seconds - 63 tables, 923 `cash_lease_proof_expired` restarts in five
 * minutes, the lease_generation changing on every cycle - while the main loop
 * sat idle (event-loop p99 21.9 ms), the database answered
 * heartbeat_table_leases_v4 in 5.2 ms, and nothing anywhere said why.
 *
 * It could not say why, because every branch that declines to renew is silent:
 *
 *   - the database heartbeat takes `FOR NO KEY UPDATE ... SKIP LOCKED`, so a
 *     locked row is skipped rather than waited for, and comes back `busy`;
 *   - `busy` is then `continue`d in tableLease.ts with no counter, on purpose
 *     (it must extend nothing), and four consecutive ones are an expiry;
 *   - a table whose local proof had already lapsed when the pass reached it is
 *     put in lostEngines, and the report is skipped entirely when the table is
 *     tournament-owned.
 *
 * Each of those is correct behaviour and none of them leaves a number. So the
 * engine could restart every cash table three times a minute, for hours, and
 * the only trace was a reason string in a log line.
 *
 * state: what the database said about the claim -
 *   kept     renewed, the only outcome that extends a proof;
 *   busy     the row was locked and skipped; extends nothing, and REPEATED
 *            busies are the signature to look for;
 *   taken    another instance holds it;
 *   stale    the row exists but is past the audited stale window;
 *   missing  no row at all;
 *   malformed the response could not be read as an answer.
 * scope: table | tournament.
 */
export const leaseHeartbeatOutcomesTotal: Counter = alwaysOnRegistry.counter(
  'poker_lease_heartbeat_outcomes_total',
  'Lease heartbeat claims by what the database said (labels: scope=table|tournament, state=kept|busy|taken|stale|missing|malformed)'
);
/* Zero-seeded across the domain: an alert on a name with no series evaluates
   to an empty vector, which reads exactly like health. See
   anAlertCannotWaitForAFailureToExist.law.test.ts. */
for (const scope of ['table', 'tournament']) {
  for (const state of ['kept', 'busy', 'taken', 'stale', 'missing', 'malformed']) {
    leaseHeartbeatOutcomesTotal.inc(0, { scope, state });
  }
}

/**
 * THE ONE LOOP THAT RENEWS EVERY LEASE, AND WHETHER IT IS STILL RUNNING
 * (2026-09-12).
 *
 * `runOwnershipLeaseRenewalLoop` renews every cash lease and every tournament
 * lease in the process. It is launched once and nothing relaunches it, and it
 * had two silent exits: a clean return when its admission generation moves on,
 * and a wedge on a serialized pass that never settles.
 *
 * On 2026-09-12 it stopped. `heartbeat_table_leases_v4` and
 * `heartbeat_tournament_leases_v4` held at exactly 27,886 and 27,765 calls
 * across a 73-second window while `claim_table_lease_v2` took 283 in the same
 * window. Nothing renewed a lease for at least two hours. Every one of the 78
 * cash tables was killed by its own 20-second proof watchdog and re-claimed,
 * 26,129 times, and three quarters of those engine lives dealt no hands, at
 * tables the log shows holding 9 of 9 seats. There was no log line, no
 * `reportError` and no metric, because nothing failed - it simply was not
 * running, and an engine that is not doing a thing looks exactly like an engine
 * with nothing to do.
 *
 * `outcome=completed` going flat is the signal, and it is a rate rather than an
 * absence, so it cannot read as health. `leaseRenewalLoopRunning` answers the
 * cruder question directly.
 */
export const leaseRenewalPassesTotal: Counter = alwaysOnRegistry.counter(
  'poker_lease_renewal_passes_total',
  'Ownership lease renewal passes (labels: outcome=completed|threw|abandoned)'
);
/* Zero-seeded: an alert on a name with no series is an empty vector, which
   reads exactly like health. See anAlertCannotWaitForAFailureToExist. */
for (const outcome of ['completed', 'threw', 'abandoned']) {
  leaseRenewalPassesTotal.inc(0, { outcome });
}

/** 1 while the ownership lease renewal lifecycle is running, 0 once it leaves. */
export const leaseRenewalLoopRunning: Gauge = alwaysOnRegistry.gauge(
  'poker_lease_renewal_loop_running',
  'Whether the ownership lease renewal lifecycle is running (1) or has left (0)'
);
leaseRenewalLoopRunning.set(0);

/**
 * A RELAUNCH IS AN EVENT, NOT A LOG DETAIL (2026-09-12).
 *
 * `leaseRenewalLoopRunning` going 0 and back to 1 is invisible to anything
 * sampling at 15s, and `poker_lease_renewal_passes_total` keeps climbing
 * across a relaunch because the successor completes passes exactly like its
 * predecessor did. So the supervisor that keeps the loop alive would, on its
 * own, hide the fault it is curing: the platform stays up and nobody learns
 * that the one loop renewing every lease in the process died and was restarted.
 *
 * This counter is that fault. Zero is the normal reading for the life of a
 * process; ANY movement means the loop left while its admission generation was
 * still current, and `GameServer.ownership_lease_renewal_loop_left_early` in
 * error reporting carries the reason.
 *
 * No alert rule reads it yet, deliberately: section 10.84 says derive a
 * threshold and write the measurement beside it, and there is no measured
 * relaunch rate to derive one from - this counter is how that measurement gets
 * taken. `LeaseRenewalLoopStopped` already pages on the outcome that matters
 * (the completed-pass rate going flat); this says why.
 */
export const leaseRenewalLoopRelaunchesTotal: Counter = alwaysOnRegistry.counter(
  'poker_lease_renewal_loop_relaunches_total',
  'Times the ownership lease renewal loop left while its generation was current and was relaunched'
);
/* Zero-seeded: a counter with no series is an empty vector, which reads
   exactly like health. See anAlertCannotWaitForAFailureToExist.law.test.ts. */
leaseRenewalLoopRelaunchesTotal.inc(0);

/**
 * WHICH HALF OF AN ABANDONED PASS NEVER CAME BACK (2026-09-12).
 *
 * `performOwnedEngineLeaseProofRenewal` awaits two halves, and each half awaits
 * exactly one RPC - the cash heartbeat and the tournament heartbeat. So this
 * label names the call that hung, not merely the branch it was in, and a wedge
 * that recurs answers its own question in one query:
 *
 *   sum by (half) (increase(poker_lease_renewal_outstanding_total[1h]))
 *
 * On 2026-09-12 that question cost hours. The loop stopped for four and a half
 * hours and telling a hung pass from a departed loop took a hand-diff of
 * pg_stat_statements against the container log, because the process itself said
 * nothing either way.
 *
 * Both halves go through a client bounded at 15s with at most three attempts,
 * so ANY increment here is already surprising and points at the bounded fetch
 * rather than at the lease protocol.
 */
export const leaseRenewalOutstandingTotal: Counter = alwaysOnRegistry.counter(
  'poker_lease_renewal_outstanding_total',
  'Halves of an abandoned ownership lease renewal pass that had not settled (labels: half=cash|tournament)'
);
/* Zero-seeded: a rule on a name with no series is an empty vector, which reads
   exactly like health. See anAlertCannotWaitForAFailureToExist. */
for (const half of ['cash', 'tournament']) {
  leaseRenewalOutstandingTotal.inc(0, { half });
}

/** Actions processed, bounded by audience x tournament format. */
export const actionsFleetTotal: Counter = alwaysOnRegistry.counter(
  'poker_actions_fleet_total',
  'Player actions processed (labels: audience=human|horse, format=cash|spin|hu_sng|sng|mtt)'
);
/**
 * Zero-seeded across the whole label domain, and the reason is the alert that
 * reads it.
 *
 * `HorseCashActionsStopped` (critical, page: sms) is
 *
 *   sum(rate(poker_actions_fleet_total{audience="horse",format="cash"}[10m])) * 60 < 150
 *
 * A counter has no series until something increments it. On an engine that
 * started and never got a single horse cash action onto the felt - the TOTAL
 * failure this alert is named for - that series does not exist, rate() is an
 * empty vector, sum() of empty is empty, and `empty < 150` is empty. The alert
 * cannot fire. It works only once horses have already acted, which is to say
 * it catches a decline and misses an outage.
 *
 * Seeded, a cold engine publishes 0, rate() is 0, and the page goes out.
 *
 * Ten series, deliberately enumerated rather than filled in on first use: the
 * whole point is that they exist BEFORE the first use, and 2 x 5 is a domain
 * this file already writes out by hand for horseForcedSitOutsTotal.
 */
for (const audience of ['human', 'horse']) {
  for (const format of ['cash', 'spin', 'hu_sng', 'sng', 'mtt']) {
    actionsFleetTotal.inc(0, { audience, format });
  }
}

/**
 * ═══ THE HORSE'S INPUT DEVICE, COUNTED (2026-09-11) ══════════════════════════
 *
 * Dan, 2026-09-11: "I SHOULD GET PUSH NOTIFICATIONS OR TEXT IF ANYTHING INSIDE
 * THE HORSES IS FAILING OR THEY CAN'T PLAY." Until today the only horse series
 * on `/metrics` described the decision WORKER (queue depth, expiries); nothing
 * said whether a seated horse actually got its action onto the felt. These
 * four count the ways the input device (CLAUDE.md 10.5) fails a seated horse,
 * fleet-wide, no table or user label, so a rule can read them:
 *
 *   turn_timeouts    the clock resolved a horse's seat instead of the horse:
 *                    kind=timer (17 s primary expiry) or kind=timebank (a bank
 *                    deadline, including an orphaned one from a previous turn,
 *                    which was 67/hour on 2026-09-11 before the settle fix);
 *   decision_fallbacks  the worker failed or expired and the seat took the
 *                    legal check/fold instead of a computed decision;
 *   seat_unactable   every one of the three commit attempts was rejected and
 *                    the seat was left to the watchdog;
 *   forced_sit_outs  the three-strike ladder sat a horse out - a horse has no
 *                    "I'm back" button, so this is a seat lost until eviction.
 *
 * Measured baseline for the thresholds lives beside the rules in
 * `infra/monitoring/alert-rules.yml` (group `horse-fleet`).
 */
export const horseTurnTimeoutsTotal: Counter = alwaysOnRegistry.counter(
  'poker_horse_turn_timeouts_total',
  'Seated horse turns resolved by the clock instead of by the horse (label: kind=timer|timebank)'
);
export const horseDecisionFallbacksTotal: Counter = alwaysOnRegistry.counter(
  'poker_horse_decision_fallbacks_total',
  'Horse turns that took the legal check/fold because the decision worker failed or expired'
);
export const horseSeatUnactableTotal: Counter = alwaysOnRegistry.counter(
  'poker_horse_seat_unactable_total',
  'Horse turns where every commit attempt (intended, check, fold) was rejected'
);
export const horseForcedSitOutsTotal: Counter = alwaysOnRegistry.counter(
  'poker_horse_forced_sit_outs_total',
  'Horses sat out by the consecutive-timeout ladder (label: format=cash|spin|hu_sng|sng|mtt)'
);
/**
 * A horse turn that scheduleHorseAction ABANDONED because the authority it
 * started under is no longer current, labelled with which authority and at
 * which stage.
 *
 * Added 2026-09-11, because this was the one horse failure with no number at
 * all. `scheduleHorseAction` guards every stage with the same fence - abort
 * signal, turn token, hand controller, hand number, lifecycle, current seat,
 * engine lease generation - and three of its four call sites simply
 * `return`ed. A horse whose table lost its lease mid-turn was therefore never
 * scheduled, never asked the worker for anything, and counted nowhere: the
 * seventeen-second clock resolved the seat as a forced check/fold, and every
 * decision-path gauge stayed perfect while it happened.
 *
 * Measured that evening: `poker_horse_decision_fallbacks_total` 0 and the
 * worker idle (queue depth 0, 4.9 ms compute) while `turn_timeouts{kind=timer}`
 * ran at 19-40 a minute against 164 hands a minute, alongside 1,652 engine
 * lease losses a minute across 1,570 tables. The same counts were zero in the
 * quiet window half an hour earlier. Nothing in the horse subsystem could say
 * that, which is why nothing did.
 *
 * reason: why the fence refused -
 *   aborted           this turn's controller was aborted;
 *   superseded        a newer turn replaced this one;
 *   hand_replaced     the hand controller or hand number moved on;
 *   lifecycle_locked  the table may not mutate right now;
 *   seat_moved        the table is no longer on this seat;
 *   lease_lost        the engine lease generation changed or stopped verifying;
 *   clock_expired     the retained reconnect deadline already elapsed.
 * stage: how far the turn got - schedule | fallback | fast_result |
 *   deep_start | deep_result | commit.
 * A `commit` abandonment is the expensive one: the decision was computed and
 * then dropped.
 */
export const horseTurnsAbandonedTotal: Counter = alwaysOnRegistry.counter(
  'poker_horse_turns_abandoned_total',
  'Horse turns abandoned because the authority they began under was no longer current (labels: reason, stage)'
);
horseTurnTimeoutsTotal.inc(0, { kind: 'timer' });
horseTurnTimeoutsTotal.inc(0, { kind: 'timebank' });
horseDecisionFallbacksTotal.inc(0);
horseSeatUnactableTotal.inc(0);
for (const format of ['cash', 'spin', 'hu_sng', 'sng', 'mtt']) {
  horseForcedSitOutsTotal.inc(0, { format });
}
/* Zero-seeded so a rule reading this never faces an absent metric: an alert on
   a name with no series cannot fire, which is the failure this whole evening
   was spent removing. */
for (const reason of [
  'aborted',
  'superseded',
  'hand_replaced',
  'lifecycle_locked',
  'seat_moved',
  'lease_lost',
  'clock_expired',
]) {
  for (const stage of [
    'schedule',
    'fallback',
    'fast_result',
    'deep_start',
    'deep_result',
    'commit',
  ]) {
    horseTurnsAbandonedTotal.inc(0, { reason, stage });
  }
}

/**
 * A tournament finish the database DEFINITIVELY REFUSED, by why (2026-09-17,
 * phase 3 of the horse programme).
 *
 * `TerminalSettlementRefusedError` is the atomic finish saying no before
 * commit: nothing moved, the manager may retry with corrected inputs. It was
 * reported to the error reporter and the financial alerts table and nowhere
 * a rule could read. Measured 2026-09-17 19:04-19:53 UTC: 864 refusals for 529
 * distinct tournaments, every one `tournament_fee_sources_require_
 * reconciliation`, every one of the 529 still RUNNING at 20:20 with its horse
 * seated and unpaid. `poker_tournaments_decided_unfinished` says how many are
 * stuck; this says why the last attempt failed.
 *
 * reason is a BOUNDED CLASSIFICATION of the message, never the message: the
 * database phrases a refusal with ids and amounts, and a label with an id in
 * it is a cardinality leak.
 *   fee_reconciliation   tournament_fee_sources_require_reconciliation and its
 *                        siblings: the accounting batch behind the entry fee is
 *                        missing or does not match;
 *   rake_attribution     rake attribution incomplete for another reason;
 *   prize_set            the prize set could not be certified;
 *   deadlock             the database chose this transaction as the victim;
 *   timeout              statement or lock timeout;
 *   other                anything else, which is the label to read first when
 *                        it moves.
 */
export type FinishRefusalReason =
  | 'fee_reconciliation'
  | 'rake_attribution'
  | 'prize_set'
  | 'deadlock'
  | 'timeout'
  | 'other';

export const FINISH_REFUSAL_REASONS: readonly FinishRefusalReason[] = [
  'fee_reconciliation',
  'rake_attribution',
  'prize_set',
  'deadlock',
  'timeout',
  'other',
];

export function classifyFinishRefusal(message: string | null | undefined): FinishRefusalReason {
  const m = (message ?? '').toLowerCase();
  if (
    m.includes('tournament_fee_sources_require_reconciliation') ||
    m.includes('tournament_fee_not_captured') ||
    m.includes('tournament_fee_source') ||
    m.includes('accounting_terms_not')
  )
    return 'fee_reconciliation';
  if (m.includes('rake attribution') || m.includes('attribution incomplete'))
    return 'rake_attribution';
  if (m.includes('prize')) return 'prize_set';
  if (m.includes('deadlock')) return 'deadlock';
  if (m.includes('timeout') || m.includes('canceling statement')) return 'timeout';
  return 'other';
}

export const tournamentFinishRefusalsTotal: Counter = alwaysOnRegistry.counter(
  'poker_tournament_finish_refusals_total',
  'Tournament finishes the database definitively refused before commit (label: reason=fee_reconciliation|rake_attribution|prize_set|deadlock|timeout|other)'
);
for (const reason of FINISH_REFUSAL_REASONS) {
  tournamentFinishRefusalsTotal.inc(0, { reason });
}

/**
 * Which of those reasons a retry can clear on its own.
 *
 * A deadlock victim and a statement timeout are the database saying "not
 * now": the same call can succeed on the next pass, so it should be tried on
 * the next pass. Every other reason is the database saying "not like this". A
 * missing accounting batch, an uncertifiable prize set and an incomplete
 * attribution do not become true because the engine asked again five seconds
 * later. They stay eligible for a corrected retry; the correction simply does
 * not arrive on a five-second clock.
 */
export const TRANSIENT_FINISH_REFUSALS: readonly FinishRefusalReason[] = ['deadlock', 'timeout'];

export function finishRefusalIsTransient(reason: FinishRefusalReason): boolean {
  return TRANSIENT_FINISH_REFUSALS.includes(reason);
}

/**
 * Fifteen minutes. A rule refusal that has stood for fifteen minutes will not
 * fall over in five seconds, and a corrected one waits at most this long to be
 * noticed - which is well inside the hour between maintenance breaks.
 */
export const FINISH_REFUSAL_BACKOFF_CAP_MS = 900_000;

/**
 * The delay a refused finish waits before it asks again: the unchanged base
 * for a transient reason, and a doubling from that base to the cap for a rule.
 * `streak` is how many times in a row THIS tournament has been refused for
 * THIS reason, so the first refusal of any kind still retries immediately at
 * the base delay.
 */
export function finishRefusalRetryDelayMs(
  reason: FinishRefusalReason,
  streak: number,
  baseMs: number
): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  if (finishRefusalIsTransient(reason)) return baseMs;
  const steps = Math.max(0, Math.min(20, Math.floor(streak) - 1));
  return Math.min(FINISH_REFUSAL_BACKOFF_CAP_MS, baseMs * 2 ** steps);
}

/**
 * Repeat critical alerts that were counted instead of raised, because the
 * same tournament had already reported the same refusal reason. The refusal
 * RATE belongs to poker_tournament_finish_refusals_total; this series exists
 * so the suppression is auditable and never silent.
 */
export const tournamentFinishRefusalAlertsSuppressedTotal: Counter = alwaysOnRegistry.counter(
  'poker_tournament_finish_refusal_alerts_suppressed_total',
  'Repeat critical finish-refusal alerts counted instead of raised because this tournament had already reported this reason (label: reason=fee_reconciliation|rake_attribution|prize_set|deadlock|timeout|other)'
);
for (const reason of FINISH_REFUSAL_REASONS) {
  tournamentFinishRefusalAlertsSuppressedTotal.inc(0, { reason });
}

/**
 * Duplicate suppression on `POST /action` (Phase 3 - 2026-09-05). Three
 * series, no table and no user: `stored` is one intent reaching the engine,
 * `replay` is a retry answered from memory instead of moving chips twice, and
 * `conflict` is one key arriving with two different actions - which should be
 * flat zero forever, and is the series to look at first if it is not.
 */
export const actionIdempotencyTotal: Counter = alwaysOnRegistry.counter(
  'poker_action_idempotency_total',
  'Actions seen by the /action duplicate guard (label: outcome=stored|replay|conflict)'
);

/**
 * A metric that is absent and a metric that is zero look identical on a
 * dashboard and mean opposite things - "nothing has been duplicated" versus
 * "the guard is not deployed". Registering the three series at zero on import
 * makes the difference readable from the first scrape. Counter.inc(0) is a
 * legal no-op increment that creates the series.
 */
actionIdempotencyTotal.inc(0, { outcome: 'stored' });
actionIdempotencyTotal.inc(0, { outcome: 'replay' });
actionIdempotencyTotal.inc(0, { outcome: 'conflict' });

/* SAME REASONING FOR THE COUNTERS THAT MOVED ALWAYS-ON (2026-09-09). A
   jackpot is weeks apart, so without a zero sample `poker_bbj_hits_detected_
   total` does not exist between hits, and "no hits" and "no instrument" are
   the same observation on a graph - which is precisely how these went
   unnoticed while gated. Registering at zero makes the difference readable
   from the first scrape, and makes `rate()` over them a real number rather
   than an empty vector an alert can never cross. */
bbjHitsDetectedTotal.inc(0);
bbjPayoutsPaidTotal.inc(0);
bbjPayoutsQueuedTotal.inc(0);
/* At zero from boot, like every counter above: a series that only appears the
   first time a mini fires cannot be told apart from a scrape that missed it,
   and "no minis" and "no instrument" would read identically. */
bbjMiniHitsDetectedTotal.inc(0);
bbjMiniPayoutsPaidTotal.inc(0);
bbjMiniPayoutsQueuedTotal.inc(0);
bbjMiniPayoutsRefusedTotal.inc(0);
bbjMiniDrillsFiredTotal.inc(0);
bbjSharesParkedTotal.inc(0);
bbjDrillsFiredTotal.inc(0);
showdownHandsTotal.inc(0);
muckedHandsTotal.inc(0);
rpcErrorsTotalAlwaysOn.inc(0, { method: 'action' });

/**
 * ── A TOURNAMENT NOBODY IS DEALING (2026-09-21) ───────────────────────────
 *
 * On 2026-09-21 six RUNNING tournaments holding 49 live seats and 4,908,000
 * tournament chips had no row in engine_tournament_leases; the oldest had been
 * that way since 2026-09-14. The engine had been up 58 hours and answered
 * activeTournaments: 472 against 465 lease rows, tournamentResumesFailing: 0
 * and a full resume budget. Every number an operator could read said the board
 * was clean, because no number compared the tournaments this process is
 * SUPPOSED to be dealing with the ones it actually owns.
 *
 * These three are that comparison. `without_owner` is the one that matters and
 * the one that was missing: a RUNNING tournament this process read from the
 * board that no live manager owns, whether the slot is empty or held by a
 * manager that cannot stop. Its alert is TournamentRunningWithNoOwner.
 */
export const tournamentsRunningWithoutOwner: Gauge = alwaysOnRegistry.gauge(
  'poker_tournaments_running_without_owner',
  'RUNNING tournaments on the last complete board read that no lease-owning manager is dealing (empty slot or quarantined manager). 0 is the healthy state'
);
export const tournamentManagersQuarantined: Gauge = alwaysOnRegistry.gauge(
  'poker_tournament_managers_quarantined',
  'Tournament managers still holding their slot after a stop that did not complete (TournamentManagerOwnership keeps a failed teardown as the owner)'
);
export const tournamentManagerQuarantineOldestSeconds: Gauge = alwaysOnRegistry.gauge(
  'poker_tournament_manager_quarantine_oldest_seconds',
  'Age of the longest-held quarantined tournament manager, in seconds; 0 when none is held'
);
/* Zero-seeded from the first scrape: an alert on a name with no series
   evaluates to an empty vector, which reads exactly like health. See
   anAlertCannotWaitForAFailureToExist.law.test.ts. */
tournamentsRunningWithoutOwner.set(0);
tournamentManagersQuarantined.set(0);
tournamentManagerQuarantineOldestSeconds.set(0);

/**
 * Why a drained-custody read did not prove custody. `refused` is the database
 * answering with its own named F06_... verdict; `unreadable` is not reaching
 * an answer at all; `malformed` is a reply that is not a verdict. Before
 * 2026-09-21 all three were one bare string in a log line and none was a
 * number, so 1,551 refusals in ninety minutes moved no series at all.
 */
export const f06DrainedCustodyOutcomesTotal: Counter = alwaysOnRegistry.counter(
  'poker_f06_drained_custody_outcomes_total',
  'Drained-custody reads that did not prove custody, by outcome (labels: outcome=refused|unreadable|malformed)'
);
for (const outcome of ['refused', 'unreadable', 'malformed']) {
  f06DrainedCustodyOutcomesTotal.inc(0, { outcome });
}

/** Prometheus lines for the always-on fleet registry. */
/* ── THE PROCESS'S OWN MEMORY (2026-09-14) ────────────────────────────────
   See observability/processMemory.ts for why these exist. Always-on, bounded
   cardinality (no labels), refreshed at scrape time from one cached sample.
   `poker_engine_native_main_arena_bytes` retains its public name but measures
   only the current [heap] virtual extent, not RSS or allocation ownership.
   -1 where /proc is unreadable, never absent. */
export const processRssBytes = alwaysOnRegistry.gauge(
  'poker_engine_process_rss_bytes',
  'Resident set size of the engine process (every isolate, every arena)'
);
export const processHeapUsedBytes = alwaysOnRegistry.gauge(
  'poker_engine_heap_used_bytes',
  'V8 main-isolate heap in use'
);
export const processHeapTotalBytes = alwaysOnRegistry.gauge(
  'poker_engine_heap_total_bytes',
  'V8 main-isolate heap committed'
);
export const processExternalBytes = alwaysOnRegistry.gauge(
  'poker_engine_external_bytes',
  'Memory V8 accounts for outside its heap (Buffers, bound C++ objects)'
);
export const processArrayBuffersBytes = alwaysOnRegistry.gauge(
  'poker_engine_array_buffers_bytes',
  'ArrayBuffer backing stores alive in the main isolate'
);
export const processNativeMainArenaBytes = alwaysOnRegistry.gauge(
  'poker_engine_native_main_arena_bytes',
  'Current [heap] virtual mapping extent, not RSS or allocation ownership; -1 when /proc is unreadable'
);
export const processRssAnonBytes = alwaysOnRegistry.gauge(
  'poker_engine_rss_anon_bytes',
  'Anonymous (non file-backed) resident memory of the process; -1 when /proc is unreadable'
);
export const processThreads = alwaysOnRegistry.gauge(
  'poker_engine_threads',
  'OS threads in the engine process (worker isolates, libuv, V8 helpers); -1 when /proc is unreadable'
);

export function refreshProcessMemoryGauges(): void {
  const s = sampleProcessMemory();
  processRssBytes.set(s.rssBytes);
  processHeapUsedBytes.set(s.heapUsedBytes);
  processHeapTotalBytes.set(s.heapTotalBytes);
  processExternalBytes.set(s.externalBytes);
  processArrayBuffersBytes.set(s.arrayBuffersBytes);
  processNativeMainArenaBytes.set(s.nativeMainArenaBytes);
  processRssAnonBytes.set(s.rssAnonBytes);
  processThreads.set(s.threads);
}
// Published from the first scrape, like every always-on series (see the law
// anAlertCannotWaitForAFailureToExist): a memory gauge that first appears
// once something reads it is a gauge with no baseline.
refreshProcessMemoryGauges();

/** Prometheus lines for the always-on fleet registry. */
export function alwaysOnPrometheusLines(): string[] {
  refreshProcessMemoryGauges();
  return alwaysOnRegistry.renderPrometheus().split('\n').filter(Boolean);
}
