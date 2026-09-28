import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as errorReporter from '../services/errorReporter.js';
import {
  TournamentEliminationScheduler,
  DEFAULT_MAX_CONCURRENT_SWEEPS,
  DEFAULT_MAX_ADAPTIVE_SWEEPS,
  ADAPTIVE_WINDOW_SWEEPS,
} from './TournamentEliminationScheduler.js';

/*
 * THE CAP GROWS ONLY WHILE THE DATABASE KEEPS UP (2026-09-28).
 *
 * Production 2026-09-28 03:14Z: 309 registered managers, 264 queued, 4/4
 * slots, mean sweep ~1.9 s, oldest waiter 441 s - busts recorded 8-30 min
 * after their hand. The database is two cores and IO/WAL-bound, so the fix is
 * not a bigger fixed number: slots above the floor are earned from the
 * sweeps' own latency and given back the moment it rises.
 *
 * Each sweep here sleeps on fake timers for a duration chosen from how many
 * sweeps are in flight when it starts, which is how a saturated database
 * behaves: more concurrency, slower every call.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Latency = (activeAtStart: number) => number;

function harness(latency: Latency, tournaments = 400, opts: { sweepWarnMs?: number } = {}) {
  vi.useFakeTimers();
  const scheduler = new TournamentEliminationScheduler({
    maxConcurrent: DEFAULT_MAX_CONCURRENT_SWEEPS,
    maxAdaptiveConcurrent: DEFAULT_MAX_ADAPTIVE_SWEEPS,
    sweepWarnMs: opts.sweepWarnMs ?? 0,
    startTimers: false,
  });
  const state = { active: 0, maxActive: 0, completed: 0, limits: new Set<number>() };
  for (let i = 0; i < tournaments; i++) {
    scheduler.register({
      tournamentId: `t-${i}`,
      run: async () => {
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        const ms = latency(state.active);
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        state.active--;
        state.completed++;
        state.limits.add(scheduler.snapshot().adaptiveLimit);
      },
    });
  }
  return { scheduler, state };
}

async function drain(state: { completed: number }, target: number, stepMs = 50) {
  for (let guard = 0; guard < 200_000 && state.completed < target; guard++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

describe('the elimination cap grows only while the database keeps up', () => {
  it('the process scheduler keeps the floor of four and may earn up to six', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/tournament/TournamentEliminationScheduler.ts'),
      'utf8'
    );
    expect(DEFAULT_MAX_CONCURRENT_SWEEPS).toBe(4);
    expect(DEFAULT_MAX_ADAPTIVE_SWEEPS).toBe(6);
    const singleton = src.slice(src.indexOf('export const tournamentEliminationScheduler'));
    expect(singleton).toContain('maxConcurrent: DEFAULT_MAX_CONCURRENT_SWEEPS');
    expect(singleton).toContain('maxAdaptiveConcurrent: DEFAULT_MAX_ADAPTIVE_SWEEPS');
  });

  it('with a backlog and flat latency it earns slots one at a time, never past six', async () => {
    const { scheduler, state } = harness(() => 300);
    await drain(state, 400);
    expect(state.completed).toBe(400);
    expect(state.maxActive).toBe(DEFAULT_MAX_ADAPTIVE_SWEEPS);
    expect([...state.limits].sort()).toEqual([4, 5, 6]);
    scheduler.stop();
  });

  it('gives an earned slot back when latency rises under it, and never reaches six', async () => {
    // Above four in flight the database is saturated: every call is 3x slower.
    const { scheduler, state } = harness((active) => (active > 4 ? 900 : 300), 600);
    await drain(state, 600);
    expect(state.completed).toBe(600);
    expect(state.maxActive).toBe(5);
    expect(state.limits.has(6)).toBe(false);
    expect(scheduler.snapshot().adaptiveLimit).toBeLessThanOrEqual(5);
    // It fell back to the floor at least once after probing five.
    expect(state.limits.has(4)).toBe(true);
    scheduler.stop();
  });

  it('never grows while the median sweep is already slow in absolute terms', async () => {
    const { scheduler, state } = harness(() => 3_000, 120);
    await drain(state, 120, 500);
    expect(state.maxActive).toBe(DEFAULT_MAX_CONCURRENT_SWEEPS);
    expect([...state.limits]).toEqual([4]);
    scheduler.stop();
  });

  it('never grows without a backlog', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: DEFAULT_MAX_CONCURRENT_SWEEPS,
      maxAdaptiveConcurrent: DEFAULT_MAX_ADAPTIVE_SWEEPS,
      sweepWarnMs: 0,
      startTimers: false,
    });
    let runs = 0;
    // Three hot tournaments re-wake themselves forever: plenty of samples,
    // never more work than the floor can already serve.
    for (const id of ['a', 'b', 'c']) {
      scheduler.register({
        tournamentId: id,
        run: async () => {
          runs++;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          scheduler.wakeAfter(id, 10);
        },
      });
    }
    await vi.advanceTimersByTimeAsync(ADAPTIVE_WINDOW_SWEEPS * 20 * 110);
    expect(runs).toBeGreaterThan(ADAPTIVE_WINDOW_SWEEPS * 5);
    expect(scheduler.snapshot().adaptiveLimit).toBe(DEFAULT_MAX_CONCURRENT_SWEEPS);
    scheduler.stop();
  });

  it('a failed sweep returns every earned slot at once', async () => {
    vi.spyOn(errorReporter, 'reportError').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: DEFAULT_MAX_CONCURRENT_SWEEPS,
      maxAdaptiveConcurrent: DEFAULT_MAX_ADAPTIVE_SWEEPS,
      sweepWarnMs: 0,
      startTimers: false,
    });
    let completed = 0;
    let failNext = false;
    for (let i = 0; i < 400; i++) {
      scheduler.register({
        tournamentId: `f-${i}`,
        run: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 300));
          completed++;
          if (failNext) {
            failNext = false;
            throw new Error('database refused');
          }
        },
      });
    }
    await drain(
      {
        get completed() {
          return completed;
        },
      },
      150
    );
    expect(scheduler.snapshot().adaptiveLimit).toBe(DEFAULT_MAX_ADAPTIVE_SWEEPS);
    failNext = true;
    const target = completed + 2;
    await drain(
      {
        get completed() {
          return completed;
        },
      },
      target
    );
    expect(failNext).toBe(false);
    expect(scheduler.snapshot().adaptiveLimit).toBe(DEFAULT_MAX_CONCURRENT_SWEEPS);
    scheduler.stop();
  });

  it('a stalled slot returns every earned slot at once and still never overlaps a tournament', async () => {
    vi.spyOn(errorReporter, 'reportError').mockImplementation(() => undefined);
    let hang = false;
    const { scheduler, state } = harness(() => (hang ? 3_600_000 : 300), 400, {
      sweepWarnMs: 5_000,
    });
    await drain(state, 150);
    expect(scheduler.snapshot().adaptiveLimit).toBe(DEFAULT_MAX_ADAPTIVE_SWEEPS);
    hang = true;
    await vi.advanceTimersByTimeAsync(6_000);
    const snap = scheduler.snapshot();
    expect(snap.stalled).toBeGreaterThan(0);
    expect(snap.adaptiveLimit).toBe(DEFAULT_MAX_CONCURRENT_SWEEPS);
    // Real concurrency stays bounded by the earned ceiling plus the stall
    // compensation, which is itself capped at the floor.
    expect(state.maxActive).toBeLessThanOrEqual(
      DEFAULT_MAX_ADAPTIVE_SWEEPS + DEFAULT_MAX_CONCURRENT_SWEEPS
    );
    scheduler.stop();
  });

  it('a fixed-cap scheduler (the constructor default) never adapts', async () => {
    vi.useFakeTimers();
    const scheduler = new TournamentEliminationScheduler({
      maxConcurrent: DEFAULT_MAX_CONCURRENT_SWEEPS,
      sweepWarnMs: 0,
      startTimers: false,
    });
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    for (let i = 0; i < 200; i++) {
      scheduler.register({
        tournamentId: `x-${i}`,
        run: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 300));
          active--;
          completed++;
        },
      });
    }
    await drain(
      {
        get completed() {
          return completed;
        },
      },
      200
    );
    expect(maxActive).toBe(DEFAULT_MAX_CONCURRENT_SWEEPS);
    expect(scheduler.snapshot().adaptiveLimit).toBe(DEFAULT_MAX_CONCURRENT_SWEEPS);
    scheduler.stop();
  });
});
