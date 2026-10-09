/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LIGHTNING TELEMETRY INTAKE (Lightning Phase 11, 2026-10-08)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What only the engine sees, per Cluster, per window - never per action:
 *
 *   - ACTION LATENCY (spec "ACTION LATENCY TELEMETRY"): every leg the
 *     Prometheus histogram already measures (LightningMetrics), attributed to
 *     its Cluster and kept as a bounded sample so the shadow record can carry
 *     the window's p50/p95 per leg. Hand creation -> first client render is
 *     NOT measured: the client sends no render acknowledgement today, and the
 *     engine will not guess one.
 *   - DECISION LATENCY per player (spec "INTEGRITY / BOT / COLLUSION"): the
 *     time from a turn being offered to the action that answered it. A
 *     distribution that is abnormally fast or abnormally constant is what an
 *     automated client tends to look like.
 *   - CORRELATED TIMING between pairs dealt into the same instance: how often
 *     one acts straight after the other, and how their per-hand decision
 *     times move together.
 *
 * NO CARDS. Nothing here is told a card, a board, an amount or an action
 * type: only who, which hand, and how many milliseconds.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). Nothing here knows or asks whether a
 * player is a horse; every decision is recorded the same way.
 *
 * ZERO WORK WHEN OFF. A Cluster is recorded only while its shadow runner has
 * registered a sink here (the config flags on). Every intake call is one Map
 * lookup and a return otherwise, and never throws into its caller.
 *
 * NOT A MATCHER INPUT. The matcher model (LightningMatcherModel) never reads
 * this module, and the pool snapshot has no field it could fill: risk never
 * moves a seat.
 */
import type { LightningLatencySegment } from './LightningMetrics.js';

/** What a Cluster's runner receives. Every method must be cheap and must not throw. */
export interface LightningClusterTelemetrySink {
  latency?(segment: LightningLatencySegment, ms: number): void;
  idle?(playerId: string, atMs: number): void;
  handDealt?(handId: string, players: readonly string[], atMs: number): void;
  decision?(handId: string, playerId: string, latencyMs: number, atMs: number): void;
  timeout?(handId: string, playerId: string, atMs: number): void;
  handEnded?(handId: string, atMs: number): void;
}

export class LightningTelemetry {
  private readonly sinks = new Map<string, LightningClusterTelemetrySink>();

  register(clusterId: string, sink: LightningClusterTelemetrySink): void {
    this.sinks.set(clusterId, sink);
  }

  /** Only the sink that registered removes itself (a replaced runner cannot unhook its successor). */
  unregister(clusterId: string, sink: LightningClusterTelemetrySink): void {
    if (this.sinks.get(clusterId) === sink) this.sinks.delete(clusterId);
  }

  isRecording(clusterId: string | null | undefined): boolean {
    return !!clusterId && this.sinks.has(clusterId);
  }

  latency(
    clusterId: string | null | undefined,
    segment: LightningLatencySegment,
    ms: number
  ): void {
    if (!clusterId) return;
    const s = this.sinks.get(clusterId);
    if (s?.latency) guard(() => s.latency!(segment, ms));
  }

  idle(clusterId: string | null | undefined, playerId: string, atMs: number): void {
    if (!clusterId) return;
    const s = this.sinks.get(clusterId);
    if (s?.idle) guard(() => s.idle!(playerId, atMs));
  }

  handDealt(clusterId: string, handId: string, players: readonly string[], atMs: number): void {
    const s = this.sinks.get(clusterId);
    if (s?.handDealt) guard(() => s.handDealt!(handId, players, atMs));
  }

  decision(
    clusterId: string,
    handId: string,
    playerId: string,
    latencyMs: number,
    atMs: number
  ): void {
    const s = this.sinks.get(clusterId);
    if (s?.decision) guard(() => s.decision!(handId, playerId, latencyMs, atMs));
  }

  timeout(clusterId: string, handId: string, playerId: string, atMs: number): void {
    const s = this.sinks.get(clusterId);
    if (s?.timeout) guard(() => s.timeout!(handId, playerId, atMs));
  }

  handEnded(clusterId: string, handId: string, atMs: number): void {
    const s = this.sinks.get(clusterId);
    if (s?.handEnded) guard(() => s.handEnded!(handId, atMs));
  }
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    // Telemetry never reaches back into a hand.
  }
}

/** The process-wide intake the hosts and the metrics tap report to. */
export const lightningTelemetry = new LightningTelemetry();

// ─── BOUNDED SAMPLES AND QUANTILES ────────────────────────────────────────

/** Nearest-rank quantile of an already sorted array; null when empty. */
export function quantileSorted(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/**
 * A bounded sample: the first `cap` values are kept, then each later value
 * replaces a slot with probability cap/seen (reservoir sampling) from a
 * deterministic generator, so a test reproduces it exactly.
 */
export class BoundedSample {
  private readonly values: number[] = [];
  private seen = 0;
  private sum = 0;
  private rng: number;

  constructor(
    private readonly cap: number,
    seed = 0x9e3779b9
  ) {
    this.rng = seed >>> 0 || 1;
  }

  add(v: number): void {
    if (!Number.isFinite(v)) return;
    this.seen++;
    this.sum += v;
    if (this.values.length < this.cap) {
      this.values.push(v);
      return;
    }
    // xorshift32
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    const slot = this.rng % this.seen;
    if (slot < this.cap) this.values[slot] = v;
  }

  get count(): number {
    return this.seen;
  }

  summary(): { n: number; p50: number | null; p95: number | null; avg: number | null } {
    const sorted = [...this.values].sort((a, b) => a - b);
    return {
      n: this.seen,
      p50: round1(quantileSorted(sorted, 0.5)),
      p95: round1(quantileSorted(sorted, 0.95)),
      avg: this.seen === 0 ? null : round1(this.sum / this.seen),
    };
  }

  sortedValues(): number[] {
    return [...this.values].sort((a, b) => a - b);
  }
}

export function round1(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}

export function round4(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 10_000) / 10_000;
}
