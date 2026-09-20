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
 * two "error loops" the error reporting budget named (Club Arena #2970) turned out to
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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SAMPLE IS ON A CLOCK, NOT ON A HORSE'S TURN (2026-09-06)
 *
 * The paragraph above said "it samples the event-loop delay once a second"
 * and the code did not: `current()` was the only sampler, and `current()` is
 * called from `simulateEquity`. So the delay was measured when a horse
 * happened to be thinking, and at no other time - a quiet minute left the
 * reading a minute stale, and a loop saturated by something OTHER than horse
 * arithmetic (settlement, broadcasts, logging, a boot adopting 195 tables)
 * was never measured at all, which is precisely when the governor should be
 * shedding load.
 *
 * It now owns an unref'd one-second timer. `current()` still samples on
 * demand if the timer is not running, so nothing changes for a test or a
 * process that never starts it. The scale table is untouched.
 *
 * AND THE NUMBER LEAVES THE PROCESS. The engine is one core (see above), and
 * that ceiling had no time series: the p50 lived in `equityGovernor.snapshot()`
 * inside the `/health` JSON and nowhere else, so nobody could chart it, alert
 * on it, or correlate it with a slow controller pass. `HorseDataLedger` says
 * so in as many words - "the ONLY visibility the governor has outside the
 * GameServer status payload". It is on `/metrics` now, on the always-on
 * registry, beside the scale it produces.
 */
/*
 * ─────────────────────────────────────────────────────────────────────────
 * THE HISTOGRAM GOES BLIND EXACTLY WHEN THE LOOP IS PEGGED (2026-09-07)
 *
 * On 2026-09-07 at 04:05 the fleet fell from ~480 hands a minute to 6. The
 * container sat at 100.8% CPU - one core, pegged - while two of the box's
 * three cores idled and Postgres answered the query the engine was "timing
 * out" on in 133 ms. Through all of it `/health` said:
 *
 *     "equityGovernor": { "scale": 1, "p50Ms": 0.000511, "p99Ms": 0.000511 }
 *
 * p50 EQUAL to p99, to six decimal places, and IDENTICAL across two separate
 * engine processes twenty minutes apart. That is not a measurement. Proved on
 * Node directly:
 *
 *     h.reset();
 *     h.percentile(50)/1e6 -> 0.000511   h.percentile(99)/1e6 -> 0.000511
 *     h.count -> 0
 *
 * **0.000511 is what an EMPTY histogram returns.** And `sample()` fed it
 * straight to `scaleForLoopDelay`, which reads 0.0005 ms as enormous headroom
 * and returns scale 1.
 *
 * Now the part that makes it a trap rather than a rounding error:
 * `monitorEventLoopDelay` only records when the loop TURNS. A loop pegged by
 * one long synchronous run does not turn, so it collects FEWER samples the
 * more saturated it is - and at the limit, none. So the emptier the histogram,
 * the more load there is, and the governor was reading empty as idle. **It
 * stood down precisely when it was needed**, which is why nothing shed load
 * through a twenty-minute outage.
 *
 * TWO CHANGES, both about refusing to guess:
 *
 * 1. An empty histogram is UNKNOWN, never fast. `count === 0` no longer
 *    produces a reading at all; the previous scale is held rather than snapped
 *    back to 1, and the snapshot says `stale: true` so /health and /metrics
 *    cannot show a confident number nobody measured. (CLAUDE.md 10.86 rule 1.)
 *
 * 2. The sampler measures its own lateness, which cannot go blind. A
 *    one-second interval that fires 800 ms late has measured 800 ms of loop
 *    saturation directly, with no dependence on the loop turning often enough
 *    to be sampled. The scale is decided on the WORSE of the two readings, so
 *    the histogram still wins when it is working and lateness carries it when
 *    the histogram has nothing.
 *
 * Neither touches the scale table or the floor: this changes what the governor
 * can SEE, not what it decides once it can see it.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const GOVERNOR_FLOOR_ITERATIONS = 60;

/**
 * ── A SAFETY VALVE WITH NO TRAVEL LEFT IS NOT A SAFETY VALVE (2026-09-07) ──
 *
 * The scale table above ended at 0.2 with a hard floor of 60 iterations, and
 * that was enough for the fleet it was measured against: "~90 tables dealing
 * 1.5 hands a second". Re-profiled on production 2026-09-07 with 272 engines
 * adopted, 20 seconds of CPU samples said:
 *
 *     34.15%  scoreHoldem          HorseEval
 *     12.38%  scoreOmahaHi         HorseEval
 *      5.41%  (garbage collector)
 *      4.15%  simulateEquity       HorseEval
 *      4.07%  (idle)
 *      3.59%  placeOmahaBandCombo
 *
 * The governor was pinned at 0.2 and had been for 335 seconds; p50 loop delay
 * was 1,660 ms. The valve was wide open and the loop was still 1.6 seconds
 * late, with 62% of the core in horse hand evaluation and 4% idle. Against the
 * 2026-09-04 profile that built this file (54.4% / 18.1% / 0.3% idle) the
 * governor is plainly working — it has run out of range, because the load it
 * governs has grown roughly fivefold and its bottom tier has not moved.
 *
 * A p50 above one second is a different regime from a p50 of 400 ms. At 400 ms
 * the table is sluggish. At 1,600 ms the fifteen-second WebSocket handshake
 * budget starts failing (`table-socket-probe` logged `handshake_timeout` on 8
 * of 11 runs in the 04:00 UTC hour), turn timers fire late enough to force FSM
 * transitions (1,160 `FORCED state: timer_running -> waiting` in one log
 * window against 299 hands), and hands that should take about 7 seconds took
 * 25 to 58. Every one of those costs a PLAYER — including the horse, which is
 * the same player under CLAUDE.md 10.5 — far more than a noisier equity read.
 *
 * So there is one more step down, and it carries a lower iteration floor,
 * because the FLOOR is what actually binds: `governedIterations(220, 0.2)` is
 * already 60, and returning 60 again at 0.08 would be no change at all.
 *
 * Nothing above the deep tier moves. Scales 1, 0.6 and 0.35 are byte for byte
 * what they were and still use the 60-iteration floor, so an engine that is
 * merely busy behaves exactly as it did yesterday.
 */
export const GOVERNOR_DEEP_FLOOR_ITERATIONS = 30;
/** Scales at or below this use the deep floor. */
export const GOVERNOR_DEEP_SCALE = 0.1;

/**
 * What `IntervalHistogram.percentile()` returns when nothing has been
 * recorded. Node reports 0.000511 ms (511 ns) rather than 0 or NaN, which is
 * why an empty histogram read as "the loop is idle" instead of "I have no
 * reading". Verified on the engine's own Node build.
 */
export const EMPTY_HISTOGRAM_MS = 0.000511;

/**
 * Is this pair of percentile readings a measurement, or an empty histogram?
 *
 * `count` is the authority and is checked first. The p50/p99 equality test is
 * the belt for a runtime whose sentinel differs: two percentiles identical to
 * the nanosecond, at a value far below the histogram's own resolution, is not
 * something a real loop produces.
 */
export function isEmptyReading(count: number, p50Ms: number, p99Ms: number): boolean {
  if (Number.isFinite(count) && count > 0) return false;
  if (!Number.isFinite(p50Ms) || !Number.isFinite(p99Ms)) return true;
  return p50Ms === p99Ms && p50Ms < 1;
}

/**
 * The delay the scale is decided on: the worse of what the histogram saw and
 * how late our own sampler was.
 *
 * Lateness is the reading that cannot disappear under load - a timer scheduled
 * for 1,000 ms that runs at 1,800 ms has measured 800 ms of saturation whether
 * or not the loop turned often enough to be sampled.
 */
export function effectiveDelayMs(
  histogramP50Ms: number | null,
  timerLateMs: number | null
): number | null {
  const a = Number.isFinite(histogramP50Ms as number) ? (histogramP50Ms as number) : null;
  const b =
    Number.isFinite(timerLateMs as number) && (timerLateMs as number) >= 0
      ? (timerLateMs as number)
      : null;
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Pure mapping from p50 event-loop delay (ms) to an iteration scale. */
export function scaleForLoopDelay(p50Ms: number): number {
  if (!Number.isFinite(p50Ms) || p50Ms < 40) return 1;
  if (p50Ms < 120) return 0.6;
  if (p50Ms < 300) return 0.35;
  if (p50Ms < 1000) return 0.2;
  return 0.08;
}

/** The iteration floor that applies at a given scale. */
export function floorForScale(scale: number): number {
  return scale <= GOVERNOR_DEEP_SCALE ? GOVERNOR_DEEP_FLOOR_ITERATIONS : GOVERNOR_FLOOR_ITERATIONS;
}

/** Apply a scale to a requested iteration count, never below the floor. */
export function governedIterations(requested: number, scale: number): number {
  const r = Math.max(1, Math.floor(requested));
  if (scale >= 1) return r;
  return Math.max(Math.min(floorForScale(scale), r), Math.floor(r * scale));
}

export interface GovernorSnapshot {
  enabled: boolean;
  scale: number;
  p50Ms: number;
  p99Ms: number;
  sampledAt: number;
  /** Seconds the scale has been below 1 in the current episode. */
  throttledForS: number;
  /**
   * The last reading told us nothing - an empty histogram with no timer
   * lateness to fall back on - so `p50Ms`/`p99Ms` are the previous values and
   * `scale` is being HELD, not re-derived. Never omit this: a held number that
   * looks live is the whole reason this field exists.
   */
  stale: boolean;
  /** How late the one-second sampler last ran, in ms. Loop saturation, directly. */
  timerLateMs: number;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  /** How late the last sampler tick ran. Loop saturation that cannot go blind. */
  private timerLateMs: number | null = null;
  private expectedTickAt = 0;
  private stale = false;

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

  /**
   * Take a reading, if there is one to take.
   *
   * ONE AUTHORITY DECIDES WHEN A READING EXISTS, AND IT IS THIS METHOD.
   *
   * Until 2026-09-07 the elapsed-time check lived in `current()` and this
   * method reset the histogram for anybody who asked. There are two callers on
   * the same one-second cadence - the timer started at boot, and the horse
   * equity path, thousands of times a second through `current()` - so they
   * drift into phase and land inside the same 20ms window. Whichever ran
   * second read a histogram the first had just emptied.
   *
   * AND AN EMPTY NODE HISTOGRAM DOES NOT SAY IT IS EMPTY. `percentile(50)` and
   * `percentile(99)` both answer 511 (nanoseconds) with `count` at zero, which
   * divides to 0.000511 ms - a number that looks like a perfectly idle loop and
   * is in fact the absence of a measurement. Production published exactly that,
   * frozen, on every read: `poker_event_loop_delay_p50_ms 0.000511`.
   *
   * It is not a cosmetic fault. `scaleForLoopDelay(0.000511)` is 1, so the
   * governor could never shed load on the one core horse Monte Carlo saturates,
   * and `EngineCoreOutOfHeadroom` (>40ms) and `EngineCoreSaturated` (>300ms)
   * could never fire. The metric reaching zero meant the opposite of success.
   *
   * Cheap: two percentile reads and a reset on a histogram perf_hooks is
   * already maintaining.
   */
  sample(now: number = Date.now()): number {
    if (this.override !== null) return this.override;
    if (!this.enabled || !this.histogram) return 1;
    // Not yet a window's worth of loop. Reading here would reset the histogram
    // and publish the emptiness as a measurement.
    if (this.sampledAt !== 0 && now - this.sampledAt < SAMPLE_EVERY_MS) return this.scale;
    // ── THIS EARLY RETURN MADE THE LATENESS PATH UNREACHABLE (2026-09-07) ───
    // It read `count === 0` and bailed — which is EXACTLY the case the
    // machinery below was written for. `isEmptyReading` returns false whenever
    // `count > 0`, so with this guard in place `empty` could never be true,
    // the `timerLateMs` fallback never ran, and `snapshot().stale` was a
    // constant `false`. The one condition the fix exists to cover was the one
    // condition it returned before reaching.
    //
    // An empty histogram now falls through to `effectiveDelayMs`, which reads
    // the sampler's own lateness instead. If BOTH are absent it still holds
    // the previous scale and sets `stale` — the assertion that a published
    // number is a measurement is kept, it just lives where it can be reached.
    this.sampledAt = now;
    // percentile() is in nanoseconds.
    const p50 = this.histogram.percentile(50) / 1e6;
    const p99 = this.histogram.percentile(99) / 1e6;
    const count = Number(this.histogram.count ?? 0);
    this.histogram.reset();

    // An empty histogram is not a fast loop. It is most often a PEGGED one:
    // the loop has to turn to be sampled, so the fewer turns, the fewer
    // samples. Reading 0.000511 ms as headroom is how the governor stood down
    // through the 2026-09-07 04:05 outage.
    const empty = isEmptyReading(count, p50, p99);
    const histogramReading = empty ? null : p50;
    const delay = effectiveDelayMs(histogramReading, this.timerLateMs);

    if (delay === null) {
      // Nothing measurable this tick. HOLD the previous scale and say so;
      // never snap back to full precision on an absence of evidence.
      this.stale = true;
      return this.scale;
    }
    this.stale = false;
    // ── PUBLISH THE NUMBER THE SCALE WAS DECIDED ON (2026-09-07) ───────────
    //
    // This assigned the raw histogram p50 whenever the histogram had ANY
    // samples, while the scale was decided on `max(p50, timerLateMs)`. Under
    // real saturation those diverge hard: measured on main with the sampler
    // 1,999 ms late, the histogram's own p50 was 21 ms — so the governor
    // dropped to its deepest tier (0.08) while `poker_event_loop_delay_p50_ms`
    // served 21.
    //
    // `EngineCoreOutOfHeadroom` (>40), `EngineCoreSaturated` (>300) and
    // `EngineSheddingPrecisionForHours` all read that metric. All three would
    // have stayed silent through a core pegged badly enough to shed 92% of its
    // horse arithmetic — and those are the alarms that DID catch the 04:05
    // outage. Publishing anything other than the decision input re-opens it.
    //
    // p99 keeps the histogram's own value where there is one, floored at the
    // delay so it can never report less than the p50 beside it.
    this.p50Ms = delay;
    this.p99Ms = empty ? Math.max(this.p99Ms, delay) : Math.max(p99, delay);
    const next = scaleForLoopDelay(delay);
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

  /** Current scale; `sample` re-reads the loop delay at most once a second. */
  current(now: number = Date.now()): number {
    return this.sample(now);
  }

  /**
   * Start the one-second sampler. Idempotent, and `unref`'d so it can never
   * hold the process open - a governor timer must not be the reason a test
   * runner or a drained engine refuses to exit.
   */
  startSampling(): void {
    if (this.timer || !this.enabled || !this.histogram) return;
    this.expectedTickAt = Date.now() + SAMPLE_EVERY_MS;
    this.timer = setInterval(() => {
      try {
        const now = Date.now();
        // How late did OUR OWN tick run? A one-second interval that fires at
        // 1,800 ms has measured 800 ms of event-loop saturation directly, and
        // unlike the histogram it cannot be starved into silence by the very
        // load it is meant to report. Clamped at 0: an early tick is not
        // negative headroom, it is no news.
        this.timerLateMs = Math.max(0, now - this.expectedTickAt);
        this.expectedTickAt = now + SAMPLE_EVERY_MS;
        this.sample(now);
      } catch {
        /* a reading we could not take is not a reason to stop taking them */
      }
    }, SAMPLE_EVERY_MS);
    this.timer.unref?.();
  }

  stopSampling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Lateness belongs to a running timer. Leaving the last value behind would
    // let a stopped sampler keep voting on the scale for ever.
    this.timerLateMs = null;
    this.expectedTickAt = 0;
  }

  /** Test hook: feed a sampler lateness without waiting on a real timer. */
  __setTimerLateForTest(ms: number | null): void {
    this.timerLateMs = ms;
  }

  snapshot(now: number = Date.now()): GovernorSnapshot {
    return {
      enabled: this.enabled && !!this.histogram,
      scale: this.override ?? this.scale,
      p50Ms: this.p50Ms,
      p99Ms: this.p99Ms,
      sampledAt: this.sampledAt,
      throttledForS: this.throttledSince ? Math.round((now - this.throttledSince) / 1000) : 0,
      stale: this.stale,
      timerLateMs: this.timerLateMs ?? 0,
    };
  }

  /** Test hook: pin the scale (null = live). */
  __setScaleForTest(scale: number | null): void {
    this.override = scale;
  }
}

export const equityGovernor = new EquityLoadGovernor();
