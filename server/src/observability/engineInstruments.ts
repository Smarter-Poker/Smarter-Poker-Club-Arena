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
export const rpcErrorsTotal: Counter = defaults.rpcErrorsTotal;
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
export const bbjHitsDetectedTotal: Counter = metricsRegistry.counter(
  'poker_bbj_hits_detected_total',
  'Bad Beat Jackpot hits the engine ruled qualifying at showdown (label: table_id)'
);
export const bbjPayoutsPaidTotal: Counter = metricsRegistry.counter(
  'poker_bbj_payouts_paid_total',
  'Bad Beat Jackpot payouts that landed on the first live attempt (label: table_id)'
);
export const bbjPayoutsQueuedTotal: Counter = metricsRegistry.counter(
  'poker_bbj_payouts_queued_total',
  'Bad Beat Jackpot payouts that could not be paid live and were queued for the reconciler (label: table_id)'
);
export const bbjSharesParkedTotal: Counter = metricsRegistry.counter(
  'poker_bbj_shares_parked_total',
  'Bad Beat Jackpot recipient shares parked because no club wallet would take them (label: table_id)'
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
export const bbjDrillsFiredTotal: Counter = metricsRegistry.counter(
  'poker_bbj_drills_fired_total',
  'Bad Beat Jackpot DRILLS fired by an armed table - real payouts, synthetic verdict (label: table_id)'
);

export const showdownHandsTotal: Counter = metricsRegistry.counter(
  'poker_showdown_hands_total',
  'Hands that reached a contested showdown (label: table_id)'
);
export const muckedHandsTotal: Counter = metricsRegistry.counter(
  'poker_mucked_hands_total',
  'Showdown holdings the engine ruled muckable (label: table_id)'
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
// had no answer. `format` is cash | spin | hu_sng | mtt, four values, so at
// most eight series with audience. Still never a table_id.
//
// Horses lose nothing here (CLAUDE.md 10.5): the same latency is observed for
// every table; the label says who was watching, it does not change what any
// seat gets.
import { MetricsRegistry, type Gauge } from './Metrics.js';

export const alwaysOnRegistry = new MetricsRegistry();

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

/** act -> broadcast, ms, 2 series (audience=human|horse). */
export const actToBroadcastFleet: Histogram = alwaysOnRegistry.histogram(
  'poker_act_to_broadcast_ms',
  'Latency from a player action being accepted to the new state reaching every seat (ms). audience=human when a human is seated at the table, else horse; format=cash|spin|hu_sng|mtt'
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

/** Actions processed, 2 series. */
export const actionsFleetTotal: Counter = alwaysOnRegistry.counter(
  'poker_actions_fleet_total',
  'Player actions processed (labels: audience=human|horse, format=cash|spin|hu_sng|mtt)'
);

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

/** Prometheus lines for the always-on fleet registry. */
export function alwaysOnPrometheusLines(): string[] {
  return alwaysOnRegistry.renderPrometheus().split('\n').filter(Boolean);
}
