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
