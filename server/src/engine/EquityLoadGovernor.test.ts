/**
 * The horses must never starve the table (2026-09-04). Pins the governor's
 * scale table, the iteration floor, and that simulateEquity actually obeys it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  scaleForLoopDelay,
  governedIterations,
  GOVERNOR_FLOOR_ITERATIONS,
  equityGovernor,
} from './EquityLoadGovernor.js';
import {
  simulateEquity,
  variantInfo,
  seedFastRandom,
  equitySampleSizeOfLastCall,
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
    expect(scaleForLoopDelay(72_774)).toBe(0.2); // the measured discovery-loop stall
    expect(scaleForLoopDelay(NaN)).toBe(1);
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

  it('reports itself for /health', () => {
    const snap = equityGovernor.snapshot();
    expect(snap).toMatchObject({ scale: expect.any(Number), p50Ms: expect.any(Number) });
    expect(typeof snap.enabled).toBe('boolean');
  });
});
