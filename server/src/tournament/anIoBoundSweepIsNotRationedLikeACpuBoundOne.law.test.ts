/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SWEEP THAT WAITS ON THE WIRE IS NOT RATIONED LIKE ONE THAT BURNS THE CORE
 *  (2026-10-03)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, overnight 2026-10-02/03: TournamentEliminationSchedulerSaturated
 * fired most hours (oldest queued wait 279 s at 23:15, 311 s at 03:30) and
 * Sit & Go / Spin winners were paid a p95 of 107-110 s after their last hand.
 * The scheduler dispatched 1.0-2.2 sweeps a second in every half hour of the
 * night - exactly slots / mean sweep (3.1-3.6 s) - while each sweep's time
 * was a chain of PostgREST round trips (~100-300 ms each at the engine, 5-40 ms
 * of it inside Postgres) and the 8-core engine's main loop sat at p99 ~25 ms.
 * The four general slots, sized on 2026-09-08 for a one-core engine whose
 * sweeps saturated the CPU, were the bottleneck.
 *
 * The law: the production defaults give general work twelve slots and decided
 * games four of their own, the cap stays a hard ceiling, and a backlog of
 * latency-bound sweeps drains at cap / latency rather than four at a time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('../services/errorReporter.js', () => ({ reportError: fixture.reportError }));

const {
  TournamentEliminationScheduler,
  DEFAULT_MAX_CONCURRENT_SWEEPS,
  DEFAULT_DECIDED_SLOTS,
  DEFAULT_CONSOLIDATION_SLOTS,
} = await import('./TournamentEliminationScheduler.js');

const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const flush = async (): Promise<void> => {
  await microtasks();
  await new Promise((resolve) => setTimeout(resolve, 1));
  await microtasks();
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the production scheduler is sized for I/O-bound sweeps', () => {
  it('gives general work twelve slots and decided games four of their own', () => {
    expect(DEFAULT_MAX_CONCURRENT_SWEEPS).toBe(12);
    expect(DEFAULT_DECIDED_SLOTS).toBe(4);
    expect(DEFAULT_CONSOLIDATION_SLOTS).toBe(1);
    const scheduler = new TournamentEliminationScheduler({ startTimers: false });
    try {
      expect(scheduler.snapshot()).toMatchObject({
        capacity: 12,
        consolidationCapacity: 1,
        decidedCapacity: 4,
      });
    } finally {
      scheduler.stop();
    }
  });

  it('runs twelve live sweeps and four decided games at once, and never more', async () => {
    const scheduler = new TournamentEliminationScheduler({ sweepWarnMs: 0, startTimers: false });
    const releases: Array<() => void> = [];
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const run = (id: string) => () =>
      new Promise<void>((resolve) => {
        started.push(id);
        active++;
        maxActive = Math.max(maxActive, active);
        releases.push(() => {
          active--;
          resolve();
        });
      });
    try {
      for (let i = 0; i < 100; i++) {
        scheduler.register({ tournamentId: `live-${i}`, run: run(`live-${i}`) });
      }
      await flush();
      expect(started).toHaveLength(12);

      for (let i = 0; i < 10; i++) {
        scheduler.register({ tournamentId: `decided-${i}`, run: run(`decided-${i}`) });
        expect(scheduler.setDecided(`decided-${i}`)).toBe(true);
      }
      await flush();
      // Every general slot is busy; the decided games need none of them.
      expect(started.slice(12)).toEqual(['decided-0', 'decided-1', 'decided-2', 'decided-3']);
      expect(maxActive).toBe(16);
      expect(scheduler.snapshot()).toMatchObject({ running: 16, decidedLaneRunning: 4 });
    } finally {
      for (const release of releases.splice(0)) release();
      scheduler.stop();
    }
  });

  it('drains a backlog of latency-bound sweeps at cap / latency, not four at a time', async () => {
    vi.useFakeTimers();
    // One sweep = a chain of ten 250 ms round trips, the production shape.
    const ROUND_TRIP_MS = 250;
    const ROUND_TRIPS = 10;
    const SWEEP_MS = ROUND_TRIP_MS * ROUND_TRIPS;
    const scheduler = new TournamentEliminationScheduler({ sweepWarnMs: 0, startTimers: false });
    let completed = 0;
    try {
      for (let i = 0; i < 120; i++) {
        scheduler.register({
          tournamentId: `spin-${i}`,
          run: async () => {
            for (let trip = 0; trip < ROUND_TRIPS; trip++) {
              await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS));
            }
            completed++;
          },
        });
      }
      // 120 sweeps / 12 slots = 10 rounds of 2.5 s. At four slots this was 30
      // rounds (75 s): the 120 s queue SLO was spent by any backlog of 200.
      await vi.advanceTimersByTimeAsync(10 * SWEEP_MS + 100);
      expect(completed).toBe(120);
      expect(scheduler.snapshot()).toMatchObject({ queued: 0, running: 0 });
    } finally {
      scheduler.stop();
    }
  });
});
