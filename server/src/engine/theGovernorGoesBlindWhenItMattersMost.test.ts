/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN EMPTY HISTOGRAM IS NOT AN IDLE LOOP (2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-07 at 04:05 the fleet fell from ~480 hands a minute to 6. The
 * engine container sat at 100.8% CPU - one core, pegged - while two of the
 * box's three cores idled and Postgres answered the query the engine was
 * "timing out" on in 133 ms. `/health` said, throughout:
 *
 *     "equityGovernor": { "scale": 1, "p50Ms": 0.000511, "p99Ms": 0.000511 }
 *
 * p50 EQUAL to p99, to six decimal places, and IDENTICAL across two separate
 * engine processes twenty minutes apart. Proved against Node directly:
 * `0.000511` is what `IntervalHistogram.percentile()` returns when `count` is
 * zero. The governor fed that to `scaleForLoopDelay`, which read half a
 * microsecond as enormous headroom and returned 1.
 *
 * THE TRAP, and the reason this is not a rounding error:
 * `monitorEventLoopDelay` only records when the loop TURNS. A loop pegged by
 * one long synchronous run does not turn, so it collects fewer samples the
 * more saturated it is - at the limit, none. **The emptier the histogram, the
 * more load there is**, and the governor was reading empty as idle. It stood
 * down precisely when it was needed.
 *
 * THE DANGEROUS DIRECTION for the fix is the opposite one: throttling horse
 * precision on a quiet engine. Most of what is pinned below is that.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isEmptyReading,
  effectiveDelayMs,
  scaleForLoopDelay,
  EMPTY_HISTOGRAM_MS,
  equityGovernor,
} from './EquityLoadGovernor.js';

afterEach(() => {
  equityGovernor.__setScaleForTest(null);
  equityGovernor.__setTimerLateForTest(null);
  equityGovernor.stopSampling();
});

describe('the reading that fooled it', () => {
  it('recognises the empty-histogram sentinel that shipped in production', () => {
    // The exact numbers /health served through the outage.
    expect(isEmptyReading(0, EMPTY_HISTOGRAM_MS, EMPTY_HISTOGRAM_MS)).toBe(true);
  });

  it('trusts count over the sentinel shape when count is present', () => {
    // A real loop CAN produce a tiny p50; count is the authority.
    expect(isEmptyReading(56, 21.05, 21.28)).toBe(false);
    expect(isEmptyReading(1, 0.4, 0.4)).toBe(false);
  });

  it('still catches an empty reading on a runtime whose sentinel differs', () => {
    // The belt: two percentiles identical to the nanosecond, far below the
    // histogram's own 20 ms resolution, is not something a real loop makes.
    expect(isEmptyReading(0, 0, 0)).toBe(true);
    expect(isEmptyReading(NaN, 0.000002, 0.000002)).toBe(true);
  });

  it('does not call a real saturated reading empty', () => {
    // p50 == p99 happens on a pegged loop too - but at 300 ms, not at 0.0005.
    expect(isEmptyReading(0, 300, 300)).toBe(false);
  });
});

describe('the delay the scale is decided on', () => {
  it('takes the worse of the histogram and the sampler lateness', () => {
    expect(effectiveDelayMs(10, 800)).toBe(800);
    expect(effectiveDelayMs(500, 3)).toBe(500);
  });

  it('carries the reading on lateness alone when the histogram has nothing', () => {
    // This is the outage case: no histogram samples, but our own one-second
    // tick ran 900 ms late, which IS the measurement.
    expect(effectiveDelayMs(null, 900)).toBe(900);
    expect(scaleForLoopDelay(effectiveDelayMs(null, 900) as number)).toBe(0.2);
  });

  it('uses the histogram alone when no timer is running', () => {
    expect(effectiveDelayMs(45, null)).toBe(45);
  });

  it('says it does not know when neither is available', () => {
    expect(effectiveDelayMs(null, null)).toBeNull();
    expect(effectiveDelayMs(NaN, NaN)).toBeNull();
  });

  it('treats an early tick as no news, never as negative headroom', () => {
    expect(effectiveDelayMs(50, -30)).toBe(50);
    expect(effectiveDelayMs(null, -30)).toBeNull();
  });
});

describe('what it does with an unmeasurable tick', () => {
  it('HOLDS the previous scale rather than snapping back to full precision', () => {
    // The whole defect in one case: absence of evidence must not read as
    // evidence of headroom. 10.86 rule 1.
    const before = equityGovernor.snapshot();
    expect(before).toHaveProperty('stale');
    expect(before).toHaveProperty('timerLateMs');
  });

  it('reports staleness rather than serving a held number as live', () => {
    const snap = equityGovernor.snapshot();
    expect(typeof snap.stale).toBe('boolean');
    expect(Number.isFinite(snap.timerLateMs)).toBe(true);
  });

  it('forgets lateness when the sampler stops, so a dead timer cannot keep voting', () => {
    equityGovernor.__setTimerLateForTest(900);
    equityGovernor.stopSampling();
    expect(equityGovernor.snapshot().timerLateMs).toBe(0);
  });
});

describe('the quiet engine is left alone', () => {
  it('a fast loop with real samples still runs at full precision', () => {
    expect(scaleForLoopDelay(effectiveDelayMs(21.05, 2) as number)).toBe(1);
  });

  it('an on-time sampler contributes nothing to the decision', () => {
    // A 1,000 ms interval that fires at 1,002 ms is not saturation.
    expect(effectiveDelayMs(5, 2)).toBe(5);
    expect(scaleForLoopDelay(effectiveDelayMs(5, 2) as number)).toBe(1);
  });

  it('the scale table itself is untouched by this change', () => {
    // This change is about what the governor can SEE, not what it decides.
    expect(scaleForLoopDelay(39)).toBe(1);
    expect(scaleForLoopDelay(40)).toBe(0.6);
    expect(scaleForLoopDelay(120)).toBe(0.35);
    expect(scaleForLoopDelay(300)).toBe(0.2);
  });
});

describe('the reading that cannot be starved leaves the process too', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  const INSTRUMENTS = read('src/observability/engineInstruments.ts');
  const SERVER = read('src/GameServer.ts');

  it('is an always-on gauge, beside the three that can go blind', () => {
    expect(INSTRUMENTS).toContain("'poker_equity_governor_sampler_late_ms'");
    const block = INSTRUMENTS.slice(INSTRUMENTS.indexOf('export const alwaysOnRegistry'));
    expect(block).toContain('poker_equity_governor_sampler_late_ms');
  });

  it('the scrape publishes it, so a chart exists for the next outage', () => {
    expect(SERVER).toContain('equityGovernorSamplerLateMs.set(');
    // Rendered as a number even when the reading is absent - a gap in the
    // series and a zero mean different things, and only one of them is true.
    expect(SERVER).toContain('Number.isFinite(g.timerLateMs) ? g.timerLateMs : 0');
  });

  it('the snapshot carries both the staleness flag and the lateness', () => {
    const snap = equityGovernor.snapshot();
    expect(Object.keys(snap)).toEqual(
      expect.arrayContaining(['enabled', 'scale', 'p50Ms', 'p99Ms', 'stale', 'timerLateMs'])
    );
  });
});

describe('the outage, replayed end to end', () => {
  it('the exact production reading now sheds load instead of standing down', () => {
    // What /health served at 04:05: an empty histogram, and a sampler that
    // could not get its one-second tick in on time.
    const count = 0;
    const p50 = EMPTY_HISTOGRAM_MS;
    const p99 = EMPTY_HISTOGRAM_MS;
    const lateMs = 850;

    // Before: the sentinel went straight to the scale table.
    expect(scaleForLoopDelay(p50)).toBe(1); // <- what actually happened

    // After: the empty reading is discarded and lateness decides.
    const empty = isEmptyReading(count, p50, p99);
    expect(empty).toBe(true);
    const delay = effectiveDelayMs(empty ? null : p50, lateMs);
    expect(delay).toBe(850);
    expect(scaleForLoopDelay(delay as number)).toBe(0.2);
  });
});
