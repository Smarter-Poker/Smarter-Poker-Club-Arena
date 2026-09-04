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
import { simulateEquity, variantInfo, seedFastRandom } from './HorseEval.js';
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

  it('is measurably cheaper when throttled (the whole point)', () => {
    const vi = variantInfo('plo');
    const hero = [c('A', 's'), c('K', 's'), c('Q', 'h'), c('J', 'h')];
    const time = (scale: number) => {
      equityGovernor.__setScaleForTest(scale);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) simulateEquity(hero, [], 3, vi, 450);
      return performance.now() - t0;
    };
    const full = time(1);
    const throttled = time(0.2);
    expect(throttled).toBeLessThan(full * 0.6);
  });

  it('reports itself for /health', () => {
    const snap = equityGovernor.snapshot();
    expect(snap).toMatchObject({ scale: expect.any(Number), p50Ms: expect.any(Number) });
    expect(typeof snap.enabled).toBe('boolean');
  });
});
