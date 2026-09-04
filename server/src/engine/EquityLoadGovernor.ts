/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EQUITY LOAD GOVERNOR - the horses must never starve the table (2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED on production, 2026-09-04, with a 12-second CPU profile of the
 * engine container (docker stats: 100% of one core, Node is single-threaded):
 *
 *     54.4%  scoreHoldem        HorseEval
 *     18.1%  scoreOmahaHi       HorseEval
 *      6.1%  simulateEquity     HorseEval
 *      4.6%  placeOmahaBandCombo
 *      3.2%  scoreOmahaLow
 *      0.3%  (idle)
 *
 * Nine-tenths of the main thread was horse Monte Carlo. Every per-decision
 * budget is fine in isolation (11-13 ms) - it is the SUM over ~90 tables
 * dealing 1.5 hands a second that pegs the core. When the event loop is that
 * saturated, every timer and every await in the process runs late, and the
 * two "error loops" the Sentry budget named (Club Arena #2970) turned out to
 * be symptoms of exactly this:
 *
 *   - TournamentBrainContext.refresh "timed out": a 5 s deadline on three
 *     queries that Postgres answers in 0.5 ms (pg_stat_statements, max 2 s).
 *   - Tournament.elimination_sweep_overrunning: a 60 s lock warning on a
 *     sweep whose statements take milliseconds.
 *   - poker_discovery_loop_stalled_ms peaked at 72,774 ms in the same hour.
 *
 * And the part that matters most: a HUMAN's action, timer and broadcast run
 * on that same starved loop. A pegged core is a laggy table for everyone.
 *
 * The governor is the one knob that trades the thing we can afford (Monte
 * Carlo sample count, i.e. decision precision) for the thing we cannot
 * (loop latency). It samples the event-loop delay once a second and scales
 * the iteration count every simulateEquity() call uses:
 *
 *     p50 loop delay   scale
 *     < 40 ms          1.00   (headroom; full precision)
 *     < 120 ms         0.60
 *     < 300 ms         0.35
 *     otherwise        0.20   (floor: 60 iterations, so the adaptive early
 *                              exit's checkpoints still exist)
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5) is not touched: the same timers, the
 * same pauses, the same rules. Under load a horse reads its equity from a
 * smaller sample, which is a noisier read of the same hand - it is not a
 * different deal, and the alternative (the whole table waiting on the
 * horse's arithmetic) is worse for every seat including the horse's own.
 *
 * Pure decision logic lives in `scaleForLoopDelay` so it is unit-testable;
 * the module-level singleton wires it to perf_hooks. `EQUITY_GOVERNOR=off`
 * disables it (tests run with it off; their loops are idle anyway).
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const GOVERNOR_FLOOR_ITERATIONS = 60;

/** Pure mapping from p50 event-loop delay (ms) to an iteration scale. */
export function scaleForLoopDelay(p50Ms: number): number {
  if (!Number.isFinite(p50Ms) || p50Ms < 40) return 1;
  if (p50Ms < 120) return 0.6;
  if (p50Ms < 300) return 0.35;
  return 0.2;
}

/** Apply a scale to a requested iteration count, never below the floor. */
export function governedIterations(requested: number, scale: number): number {
  const r = Math.max(1, Math.floor(requested));
  if (scale >= 1) return r;
  return Math.max(Math.min(GOVERNOR_FLOOR_ITERATIONS, r), Math.floor(r * scale));
}

export interface GovernorSnapshot {
  enabled: boolean;
  scale: number;
  p50Ms: number;
  p99Ms: number;
  sampledAt: number;
  /** Seconds the scale has been below 1 in the current episode. */
  throttledForS: number;
}

const SAMPLE_EVERY_MS = 1000;
const LOG_EVERY_MS = 60_000;

class EquityLoadGovernor {
  private readonly enabled: boolean;
  private histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private scale = 1;
  private p50Ms = 0;
  private p99Ms = 0;
  private sampledAt = 0;
  private throttledSince = 0;
  private lastLogAt = 0;
  private override: number | null = null;

  constructor() {
    this.enabled = (process.env.EQUITY_GOVERNOR || 'on').toLowerCase() !== 'off';
    if (this.enabled) {
      try {
        this.histogram = monitorEventLoopDelay({ resolution: 20 });
        this.histogram.enable();
      } catch {
        this.histogram = null;
      }
    }
  }

  /** Current scale; re-samples the loop delay at most once a second. */
  current(now: number = Date.now()): number {
    if (this.override !== null) return this.override;
    if (!this.enabled || !this.histogram) return 1;
    if (now - this.sampledAt < SAMPLE_EVERY_MS) return this.scale;
    this.sampledAt = now;
    // percentile() is in nanoseconds.
    this.p50Ms = this.histogram.percentile(50) / 1e6;
    this.p99Ms = this.histogram.percentile(99) / 1e6;
    this.histogram.reset();
    const next = scaleForLoopDelay(this.p50Ms);
    if (next < 1 && this.scale >= 1) this.throttledSince = now;
    if (next >= 1 && this.scale < 1) {
      console.log(
        `[EquityGovernor] loop recovered (p50 ${this.p50Ms.toFixed(0)}ms) after ${Math.round((now - this.throttledSince) / 1000)}s throttled`
      );
      this.throttledSince = 0;
    }
    this.scale = next;
    if (next < 1 && now - this.lastLogAt >= LOG_EVERY_MS) {
      this.lastLogAt = now;
      console.warn(
        `[EquityGovernor] event loop p50 ${this.p50Ms.toFixed(0)}ms p99 ${this.p99Ms.toFixed(0)}ms - horse Monte Carlo scaled to ${Math.round(next * 100)}% (throttled ${Math.round((now - this.throttledSince) / 1000)}s)`
      );
    }
    return this.scale;
  }

  snapshot(now: number = Date.now()): GovernorSnapshot {
    return {
      enabled: this.enabled && !!this.histogram,
      scale: this.override ?? this.scale,
      p50Ms: this.p50Ms,
      p99Ms: this.p99Ms,
      sampledAt: this.sampledAt,
      throttledForS: this.throttledSince ? Math.round((now - this.throttledSince) / 1000) : 0,
    };
  }

  /** Test hook: pin the scale (null = live). */
  __setScaleForTest(scale: number | null): void {
    this.override = scale;
  }
}

export const equityGovernor = new EquityLoadGovernor();
