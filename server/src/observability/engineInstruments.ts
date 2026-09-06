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

/** act -> broadcast, ms, 2 series (audience=human|horse). */
export const actToBroadcastFleet: Histogram = alwaysOnRegistry.histogram(
  'poker_act_to_broadcast_ms',
  'Latency from a player action being accepted to the new state reaching every seat (ms). audience=human when a human is seated at the table, else horse; format=cash|spin|hu_sng|mtt'
);

/**
 * THE CORE THAT LIMITS EVERYTHING, AS A NUMBER (2026-09-06).
 *
 * The engine is ONE Node core and CLAUDE.md calls that the ceiling. Until
 * today the only measurement of it was `equityGovernor.snapshot()` inside the
 * `/health` JSON - no time series, no chart, no alert, nothing to correlate a
 * slow controller pass or a laggy table against. `HorseDataLedger` said so
 * itself: "the ONLY visibility the governor has outside the GameServer status
 * payload".
 *
 * These are gauges, not a histogram: the governor already keeps the
 * percentiles (perf_hooks maintains the underlying histogram), so re-bucketing
 * them here would cost work to say the same thing less precisely.
 *
 * The scale is published beside the delay on purpose. A p50 over 40 ms and a
 * scale of 1 means the governor is not reacting; a scale below 1 with a low
 * p50 means it is throttling on a reading nobody can see. Together they are
 * self-checking; apart, each can lie.
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
  'Horse Monte Carlo iteration scale the governor is applying (1 = full precision, 0.2 = floor). Below 1 means the core is shedding load.'
);

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
