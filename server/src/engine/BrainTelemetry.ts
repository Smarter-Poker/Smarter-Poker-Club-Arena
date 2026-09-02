/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BRAIN TELEMETRY — proof of receipt (Dan 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════
 * "Verify that all changes we make to the brain ACTUALLY MAKE IT to the
 *  horses — that they receive, utilize and improve on the new logic."
 *
 * A deploy proves the code is in the container. It does not prove a layer
 * ever FIRES at a live table — the house failure mode is precisely the
 * feature that looks deployed and never executes (the league that never ran,
 * the c-bet upgrade gated off by a stale flag, the conditioning branch dead
 * for 17% of flops). This module is the instrument: every live decision
 * stamps the layers that actually executed, a flush service aggregates them
 * per day into horse_brain_telemetry, the daily audit raises a CRITICAL
 * layer_silent finding when a deployed layer stops firing, and the admin
 * panel shows the fire counts next to the hand reviews.
 *
 * DESIGN CONSTRAINTS
 * - Live decisions only: the gate is opts.telemetry === true, set solely by
 *   scheduleHorseAction. League/benchmark/test decisions never count — a
 *   nightly self-play burst would otherwise fake "the fleet uses layer X".
 * - Zero overhead when off, O(1) map increment when on. No IO here; the
 *   flush lives in services/BrainTelemetryFlush.ts.
 * - Decisions are synchronous and single-threaded; a plain Map is safe.
 */

const fires = new Map<string, number>();
let enabled = false;

/** Armed once by the flush service at engine boot. */
export function enableBrainTelemetry(): void {
  enabled = true;
}

/** Count one execution of a brain feature for today. No-op until enabled. */
export function noteFire(feature: string): void {
  if (!enabled) return;
  fires.set(feature, (fires.get(feature) ?? 0) + 1);
}

/** True when the caller opted this decision into telemetry. */
export function telemetryOn(opts: { telemetry?: boolean } | undefined): boolean {
  return enabled && opts?.telemetry === true;
}

/** Drain the accumulated counters (flush service + tests). */
export function drainFires(): Array<{ feature: string; fires: number }> {
  const out: Array<{ feature: string; fires: number }> = [];
  for (const [feature, n] of fires) out.push({ feature, fires: n });
  fires.clear();
  return out;
}

/** Merge rows back after a failed flush so nothing is lost. */
export function restoreFires(rows: Array<{ feature: string; fires: number }>): void {
  for (const r of rows) fires.set(r.feature, (fires.get(r.feature) ?? 0) + r.fires);
}

// ═══════════════════════════════════════════════════════════════════════════
// DECISION LATENCY (Dan 2026-08-29)
// ═══════════════════════════════════════════════════════════════════════════
// "I WANT TO KNOW HOW LONG IT TAKES THEM TO IDENTIFY THEIR HAND, KNOW THE
//  BOARD, KNOW WHO THEY'RE PLAYING AGAINST ... HOW LONG IT TAKES FOR THEM TO
//  ACTUALLY COLLECT AND ANALYZE THAT INFORMATION IN REAL TIME."
//
// It could not be answered. The decision path carried a documented budget
// ("<15ms even for 6-card PLO", HorseLogic.ts) and NOTHING MEASURED IT. There
// was no timer, no deadline, no telemetry of duration anywhere in the engine —
// `performance.now()` appeared in exactly four places, all of them in an
// offline unit test. The only cost control was a fixed Monte Carlo iteration
// count per variant, which is an iteration budget, not a time budget: it never
// reads a clock, so a slow box simply takes longer and nobody learns.
//
// A budget nobody measures is a comment. This is the instrument.
//
// WHY A HISTOGRAM AND NOT A MEAN. The mean is the least interesting number
// here: every decision is fast until the one that is not, and a tail is what a
// player would actually feel. Fixed buckets keep it O(1) per decision with no
// allocation and no sorting — the measurement must not become the cost.

/** Upper edges in milliseconds. The last bucket is everything above 200ms. */
const LATENCY_BUCKET_MS = [1, 2, 5, 10, 15, 25, 50, 100, 200] as const;

interface LatencyAccumulator {
  samples: number;
  totalMs: number;
  maxMs: number;
  /** One counter per bucket, plus a final overflow slot. */
  buckets: number[];
}

const latency = new Map<string, LatencyAccumulator>();

function accumulatorFor(scope: string): LatencyAccumulator {
  let acc = latency.get(scope);
  if (!acc) {
    acc = {
      samples: 0,
      totalMs: 0,
      maxMs: 0,
      buckets: new Array(LATENCY_BUCKET_MS.length + 1).fill(0),
    };
    latency.set(scope, acc);
  }
  return acc;
}

/**
 * Record how long one live decision took, end to end.
 *
 * `scope` is the variant family, so a 6-card PLO decision (which runs the most
 * expensive Monte Carlo) is never averaged into a heads-up NLH one.
 */
export function noteDecisionMs(scope: string, ms: number): void {
  if (!enabled) return;
  if (!Number.isFinite(ms) || ms < 0) return;
  const acc = accumulatorFor(scope);
  acc.samples++;
  acc.totalMs += ms;
  if (ms > acc.maxMs) acc.maxMs = ms;
  let i = 0;
  while (i < LATENCY_BUCKET_MS.length && ms > LATENCY_BUCKET_MS[i]) i++;
  acc.buckets[i]++;
}

export interface LatencyRow {
  scope: string;
  samples: number;
  totalMs: number;
  maxMs: number;
  buckets: number[];
}

/**
 * A percentile read off the histogram.
 *
 * It returns the UPPER EDGE of the bucket the percentile falls in, so it is an
 * over-estimate by construction and never flatters the engine. `null` when
 * there is nothing to report, because a fabricated zero would read as "very
 * fast" — which is exactly the kind of confident wrong number this whole
 * module exists to stop.
 */
export function percentileMs(row: LatencyRow, p: number): number | null {
  if (!row || row.samples <= 0) return null;
  const target = row.samples * p;
  let seen = 0;
  for (let i = 0; i < row.buckets.length; i++) {
    seen += row.buckets[i];
    if (seen >= target) {
      return i < LATENCY_BUCKET_MS.length ? LATENCY_BUCKET_MS[i] : row.maxMs;
    }
  }
  return row.maxMs;
}

/** The bucket edges, so a reader can interpret the histogram. */
export function latencyBucketEdges(): readonly number[] {
  return LATENCY_BUCKET_MS;
}

/** Drain the accumulated latency (flush service + tests). */
export function drainDecisionLatency(): LatencyRow[] {
  const out: LatencyRow[] = [];
  for (const [scope, acc] of latency) {
    out.push({
      scope,
      samples: acc.samples,
      totalMs: acc.totalMs,
      maxMs: acc.maxMs,
      buckets: [...acc.buckets],
    });
  }
  latency.clear();
  return out;
}

/** Merge rows back after a failed flush so nothing is lost. */
export function restoreDecisionLatency(rows: LatencyRow[]): void {
  for (const r of rows) {
    const acc = accumulatorFor(r.scope);
    acc.samples += r.samples;
    acc.totalMs += r.totalMs;
    if (r.maxMs > acc.maxMs) acc.maxMs = r.maxMs;
    for (let i = 0; i < acc.buckets.length && i < r.buckets.length; i++) {
      acc.buckets[i] += r.buckets[i];
    }
  }
}

/** Read the live accumulator without draining it — for /health. */
export function peekDecisionLatency(): LatencyRow[] {
  const out: LatencyRow[] = [];
  for (const [scope, acc] of latency) {
    out.push({
      scope,
      samples: acc.samples,
      totalMs: acc.totalMs,
      maxMs: acc.maxMs,
      buckets: [...acc.buckets],
    });
  }
  return out;
}
