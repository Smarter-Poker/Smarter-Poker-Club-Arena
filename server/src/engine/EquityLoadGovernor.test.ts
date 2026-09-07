/**
 * The horses must never starve the table (2026-09-04). Pins the governor's
 * scale table, the iteration floor, and that simulateEquity actually obeys it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  scaleForLoopDelay,
  effectiveDelayMs,
  governedIterations,
  floorForScale,
  GOVERNOR_FLOOR_ITERATIONS,
  GOVERNOR_DEEP_FLOOR_ITERATIONS,
  equityGovernor,
} from './EquityLoadGovernor.js';
import {
  simulateEquity,
  variantInfo,
  seedFastRandom,
  equitySampleSizeOfLastCall,
  BANDED_OMAHA_FLOOR_ITERATIONS,
} from './HorseEval.js';
import type { Card } from '../types.js';

const c = (rank: string, suit: string): Card => ({ rank, suit }) as Card;

afterEach(() => equityGovernor.__setScaleForTest(null));

describe('scaleForLoopDelay', () => {
  it('leaves precision alone while the loop has headroom and steps down as it saturates', () => {
    expect(scaleForLoopDelay(0)).toBe(1);
    expect(scaleForLoopDelay(39)).toBe(1);
    expect(scaleForLoopDelay(40)).toBe(0.6);
    expect(scaleForLoopDelay(119)).toBe(0.6);
    expect(scaleForLoopDelay(120)).toBe(0.35);
    expect(scaleForLoopDelay(299)).toBe(0.35);
    expect(scaleForLoopDelay(300)).toBe(0.2);
    expect(scaleForLoopDelay(999)).toBe(0.2);
    expect(scaleForLoopDelay(NaN)).toBe(1);
  });

  /**
   * 2026-09-07: the table used to end at 0.2, and production sat there for
   * 335 seconds with a p50 of 1,660 ms and 4% idle. A valve with no travel
   * left is not a valve. See the long note in EquityLoadGovernor.ts.
   */
  it('has one more step for the regime where the loop is seconds late', () => {
    expect(scaleForLoopDelay(1000)).toBe(0.08);
    expect(scaleForLoopDelay(1660)).toBe(0.08); // the measured production p50
    expect(scaleForLoopDelay(72_774)).toBe(0.08); // the measured discovery-loop stall
  });
});

describe('governedIterations', () => {
  it('scales but never below the floor, and never raises a small request', () => {
    expect(governedIterations(450, 1)).toBe(450);
    expect(governedIterations(450, 0.6)).toBe(270);
    expect(governedIterations(450, 0.2)).toBe(90);
    expect(governedIterations(220, 0.2)).toBe(GOVERNOR_FLOOR_ITERATIONS);
    expect(governedIterations(40, 0.2)).toBe(40);
  });

  it('drops to the deep floor only in the deep tier, and leaves every other tier alone', () => {
    expect(floorForScale(1)).toBe(GOVERNOR_FLOOR_ITERATIONS);
    expect(floorForScale(0.6)).toBe(GOVERNOR_FLOOR_ITERATIONS);
    expect(floorForScale(0.35)).toBe(GOVERNOR_FLOOR_ITERATIONS);
    expect(floorForScale(0.2)).toBe(GOVERNOR_FLOOR_ITERATIONS);
    expect(floorForScale(0.08)).toBe(GOVERNOR_DEEP_FLOOR_ITERATIONS);

    // The floor is the thing that binds: at 0.2 a 220-sample request already
    // clamps to 60, so without a lower floor the deep tier would be a no-op.
    expect(governedIterations(220, 0.2)).toBe(60);
    expect(governedIterations(220, 0.08)).toBe(GOVERNOR_DEEP_FLOOR_ITERATIONS);
    // Above the floor the scale is simply obeyed.
    expect(governedIterations(1000, 0.08)).toBe(80);
    // And a request already smaller than the floor is never raised.
    expect(governedIterations(12, 0.08)).toBe(12);
  });
});

describe('simulateEquity under the governor', () => {
  it('still returns a sane equity with the sample scaled to the floor', () => {
    const vi = variantInfo('nlh');
    const hero = [c('A', 's'), c('A', 'h')];
    seedFastRandom(7);
    equityGovernor.__setScaleForTest(1);
    const full = simulateEquity(hero, [], 1, vi, 2000);
    seedFastRandom(7);
    equityGovernor.__setScaleForTest(0.2);
    const throttled = simulateEquity(hero, [], 1, vi, 2000);
    // Aces heads-up are ~85%; a 400-sample read is noisier, not different.
    expect(full).toBeGreaterThan(0.8);
    expect(throttled).toBeGreaterThan(0.75);
    expect(Math.abs(full - throttled)).toBeLessThan(0.08);
  });

  /**
   * THIS USED TO BE A STOPWATCH, AND THE STOPWATCH WAS THE BUG.
   *
   * It timed 20 full-precision samples against 20 throttled ones and required
   * the second under 60% of the first. On 2026-09-07 the measured ratio on a
   * 16-core runner shared by twelve jobs was 0.69, and it failed the entire
   * `Server Engine` suite on a branch that had not touched the governor.
   *
   * Best-of-three and a warm-up pass had ALREADY been added and did not save
   * it - 10.86 rule 4, the fix that leaves the same trap one level up. Per-call
   * fixed cost (deck construction, allocation, the return path) dominates a
   * 90-iteration sample, so the achievable ratio sits just under the threshold
   * and moves with whoever else is on the box.
   *
   * The quantity this test is about was never milliseconds. It is whether the
   * one function that spends the core still asks the governor how much it may
   * spend, and `equitySampleSizeOfLastCall()` answers that exactly, in
   * integers, at any load. A governor that stops being consulted makes both
   * numbers 450 and fails this instantly; the old test needed a quiet runner
   * to notice.
   */
  it('spends the sample the governor allows, not the one it was asked for', () => {
    const vi = variantInfo('plo');
    const hero = [c('A', 's'), c('K', 's'), c('Q', 'h'), c('J', 'h')];
    const sampleAt = (scale: number) => {
      equityGovernor.__setScaleForTest(scale);
      simulateEquity(hero, [], 3, vi, 450);
      return equitySampleSizeOfLastCall();
    };

    expect(sampleAt(1)).toBe(450);
    expect(sampleAt(0.6)).toBe(270);
    // 450 * 0.2 = 90, above the 60-iteration floor, so the floor does not bind
    // here - which is the point: this is the scale being obeyed, not clamped.
    expect(sampleAt(0.2)).toBe(90);
    expect(sampleAt(0.2)).toBeLessThan(sampleAt(1) * 0.25);
  });

  it('never spends below the floor, however hard the loop is being hit', () => {
    const vi = variantInfo('nlh');
    const hero = [c('A', 's'), c('A', 'h')];
    equityGovernor.__setScaleForTest(0.2);
    simulateEquity(hero, [], 1, vi, 220);
    // 220 * 0.2 = 44. A horse that samples 44 hands is not playing poker.
    expect(equitySampleSizeOfLastCall()).toBe(GOVERNOR_FLOOR_ITERATIONS);
  });

  /**
   * 2026-09-07. `simulateEquity`'s banded-Omaha branch ran AFTER the governor
   * and did `Math.max(120, ...)`, so on a saturated loop it raised the sample
   * back to DOUBLE the governor's floor — on the single most expensive path in
   * the CPU profile (scoreOmahaHi 12.4%, placeOmahaBandCombo 3.6%), for the
   * variant that was 52% of the fleet's hands. The V13 floor buys precision
   * out of headroom; when the governor says there is none, there is none.
   */
  it('the banded-Omaha floor may not outrank the governor', () => {
    // 'plo4', not 'plo': OMAHA_VARIANTS is {plo4, plo5, plo6, plo8, flo8}, so
    // `variantInfo('plo').isOmaha` is FALSE and a test written with it never
    // enters the branch it means to be testing.
    const vi = variantInfo('plo4');
    expect(vi.isOmaha).toBe(true);
    const hero = [c('A', 's'), c('K', 's'), c('Q', 'h'), c('J', 'h')];
    const bands: Array<[number, number] | null> = [
      [0.5, 1],
      [0.5, 1],
      [0.5, 1],
    ];
    const sampleAt = (scale: number) => {
      equityGovernor.__setScaleForTest(scale);
      simulateEquity(hero, [], 3, vi, 100, bands);
      return equitySampleSizeOfLastCall();
    };

    // Full precision: 100 trimmed to 85, raised back to the V13 floor.
    // Unchanged from before this fix — headroom still buys precision.
    expect(sampleAt(1)).toBe(BANDED_OMAHA_FLOOR_ITERATIONS);
    // Throttled: 200 * 0.2 = 40, clamped up to the governor's own floor of 60,
    // and the band trim may shave it but never raise it back to 120.
    expect(sampleAt(0.2)).toBeLessThanOrEqual(GOVERNOR_FLOOR_ITERATIONS);
    // Deep tier: below the ordinary floor, which is the whole point.
    expect(sampleAt(0.08)).toBeLessThanOrEqual(GOVERNOR_DEEP_FLOOR_ITERATIONS);
  });

  /**
   * THE PUBLISHED p50 IS THE NUMBER THE SCALE WAS DECIDED ON (2026-09-07).
   *
   * `sample()` decided the scale on `max(histogram p50, sampler lateness)` but
   * published the raw histogram p50. Measured on main with the sampler 1,999 ms
   * late, the histogram's own p50 was 21 ms: the governor went to its deepest
   * tier while `poker_event_loop_delay_p50_ms` served 21.
   *
   * `EngineCoreOutOfHeadroom` (>40), `EngineCoreSaturated` (>300) and
   * `EngineSheddingPrecisionForHours` all read that metric, so all three stayed
   * silent through a core pegged hard enough to shed 92% of its arithmetic -
   * and those are the alarms that caught the 04:05 outage.
   */
  it('publishes the delay it throttled on, not a histogram that disagrees', () => {
    expect(effectiveDelayMs(21, 1999)).toBe(1999);
    expect(scaleForLoopDelay(effectiveDelayMs(21, 1999) as number)).toBe(0.08);
    // The worse of the two, in both directions.
    expect(effectiveDelayMs(2500, 10)).toBe(2500);
    // And a missing half never wins.
    expect(effectiveDelayMs(null, 1999)).toBe(1999);
    expect(effectiveDelayMs(21, null)).toBe(21);
    // Nothing measurable at all is "no reading", not "fast".
    expect(effectiveDelayMs(null, null)).toBeNull();

    // The source must not assign the raw histogram p50 to the published field.
    const src = readFileSync(new URL('./EquityLoadGovernor.ts', import.meta.url).pathname, 'utf8');
    expect(
      /this\.p50Ms\s*=\s*p50\s*;/.test(src),
      'the published p50 is the raw histogram again, so it can disagree with ' +
        'the delay the scale was decided on'
    ).toBe(false);
    expect(src).toContain('this.p50Ms = delay;');
  });

  it('reports itself for /health', () => {
    const snap = equityGovernor.snapshot();
    expect(snap).toMatchObject({ scale: expect.any(Number), p50Ms: expect.any(Number) });
    expect(typeof snap.enabled).toBe('boolean');
  });
});
