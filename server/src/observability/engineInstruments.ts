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

/** Actions processed, bounded by audience x tournament format. */
export const actionsFleetTotal: Counter = alwaysOnRegistry.counter(
  'poker_actions_fleet_total',
  'Player actions processed (labels: audience=human|horse, format=cash|spin|hu_sng|sng|mtt)'
);

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
horseTurnTimeoutsTotal.inc(0, { kind: 'timer' });
horseTurnTimeoutsTotal.inc(0, { kind: 'timebank' });
horseDecisionFallbacksTotal.inc(0);
horseSeatUnactableTotal.inc(0);
for (const format of ['cash', 'spin', 'hu_sng', 'sng', 'mtt']) {
  horseForcedSitOutsTotal.inc(0, { format });
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
bbjSharesParkedTotal.inc(0);
bbjDrillsFiredTotal.inc(0);
showdownHandsTotal.inc(0);
muckedHandsTotal.inc(0);
rpcErrorsTotalAlwaysOn.inc(0, { method: 'action' });

/** Prometheus lines for the always-on fleet registry. */
export function alwaysOnPrometheusLines(): string[] {
  return alwaysOnRegistry.renderPrometheus().split('\n').filter(Boolean);
}
